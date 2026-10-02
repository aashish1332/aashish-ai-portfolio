"""ai/data/extract.py — turn a fetched source into the text the pipeline reads.

    python -m ai.data.extract --source hindi_wikipedia --kind wikipedia-dump
    python -m ai.data.extract --source tinystories --kind parquet
    python -m ai.data.extract --in data/raw/x/thing.parquet --list-columns
    python -m ai.data.extract --check

**The gap this closes.** `fetch_corpus.py` downloads; `prepare_data.py` reads
`data/raw/<id>/*.txt`; nothing connected the two. A fetched Wikipedia dump is
`hiwiki-latest-pages-articles.xml.bz2` — a compressed XML archive, not text —
and a Hugging Face corpus is a folder of `.parquet`. Running the notebook as
written therefore reached `prepare_data`, which globbed for `*.txt`, found
nothing, and exited. The step between "downloaded" and "readable" was missing
from the project, not merely from a document.

**What it does.** File-format work only: decompress, read records, and reduce
each one to plain text, one document per line. Every §7.3 filter — PII,
language, length, dedupe — belongs to `pipeline.py` and is applied afterwards,
so a document that survives here is still a candidate, not a survivor.

**What it is not.** `strip_wikitext` is a *minimal* markup stripper, not a
wikitext parser. It removes the constructs that are pure noise (comments,
refs, templates, tables, media links) and keeps article prose, and it will
mangle exotic markup. That is a deliberate trade: `mwparserfromhell` is the
correct tool and is not a dependency of this project, so the limitation is
recorded here rather than hidden behind a library that is not installed. The
constant `MARKUP_LIMITATIONS` names what is known to be missed, and
`--keep-markup` skips the stripper entirely when the honest answer is
"do not trust this".

Documents: one article is split into paragraph-sized documents rather than
emitted whole. A 100 KB article is a single unusable training example for a
1024-token model, and appending it as one line would also make `read_lines`
read 100 KB into memory per item.
"""

from __future__ import annotations

import argparse
import bz2
import json
import re
import sys
import time
from pathlib import Path
from typing import Iterable, Iterator

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "data" / "raw"
# Text goes to its own directory rather than next to the download, because
# `prepare_data --raw` reads one directory: combining several sources into a
# Stage A corpus means putting their `.txt` files together, and doing that
# inside data/raw would mix each source's download in with them.
EXTRACTED_DIR = REPO_ROOT / "data" / "extracted"

# What the stripper knowingly does not handle. Recorded so the limitation is a
# fact in the code rather than a surprise in the samples.
MARKUP_LIMITATIONS = (
    "magic words and parser functions that survive template removal",
    "{{!}} and similar template-provided punctuation",
    "nested tables inside templates",
    "<math> content survives as its own source rather than being converted",
    "language-variant markup (-{...}-)",
)

# Extensions that mean "this file is a compressed wiki dump".
DUMP_SUFFIXES = (".xml.bz2", ".xml", ".bz2")
# Namespaces worth keeping: 0 is the article namespace.
ARTICLE_NAMESPACES = {"0"}
# Link targets that are not prose and should vanish with their label.
MEDIA_PREFIXES = {
    "file", "image", "media", "category", "wikipedia", "template", "help",
    "portal", "draft", "module", "special", "talk", "user", "श्रेणी", "चित्र",
    "साँचा", "विकिपीडिया",
}
# Columns a text-bearing corpus is likely to use, in the order we prefer them.
PREFERRED_TEXT_COLUMNS = ("text", "content", "raw", "document", "story",
                          "sentence", "body", "passage")

_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_REF_RE = re.compile(r"<ref\b[^>]*/>|<ref\b[^>]*>.*?</ref>", re.S | re.I)
_TABLE_RE = re.compile(r"\{\|.*?\|\}", re.S)
_TAG_RE = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>")
_QUOTES_RE = re.compile(r"'{2,5}")
_HEADING_RE = re.compile(r"^=+\s*(.+?)\s*=+\s*$", re.M)
_EXT_LINK_RE = re.compile(r"\[\s*(?:https?|ftp|mailto):[^\s\]]+\s*([^\]]*)\]")
_BARE_URL_RE = re.compile(r"(?:https?|ftp)://\S+")
_WS_RE = re.compile(r"[ \t\u00a0]+")
_MULTI_NL_RE = re.compile(r"\n{2,}")
_LIST_MARKER_RE = re.compile(r"^[*#:;]+\s*", re.M)


# ── wikitext → prose ─────────────────────────────────────────────────
def _strip_templates(text: str) -> str:
    """Remove `{{...}}` including nesting.

    A balanced scan rather than a regex: `{{a|{{b}}|c}}` needs a depth counter,
    and a non-greedy regex silently leaves the tail of nested markup behind.
    Unbalanced input loses everything after the last unmatched `{{`, which is
    the safe direction for a corpus.
    """
    out: list[str] = []
    depth = 0
    index = 0
    length = len(text)
    while index < length:
        if text.startswith("{{", index):
            depth += 1
            index += 2
        elif text.startswith("}}", index):
            if depth:
                depth -= 1
            index += 2
        else:
            if depth == 0:
                out.append(text[index])
            index += 1
    return "".join(out)


def _resolve_links(text: str) -> str:
    """`[[Target|Label]]` → `Label`; `[[Target]]` → `Target`; media links vanish.

    Scanned rather than matched: a regex for `[[...]]` either refuses to cross
    a pipe or swallows everything to the last `]]` on the line.
    """
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        if text.startswith("[[", index):
            end = text.find("]]", index + 2)
            if end == -1:
                out.append(text[index:])
                break
            inner = text[index + 2:end]
            index = end + 2
            target = inner.split("|", 1)[0]
            prefix = target.split(":", 1)[0].strip().lower() if ":" in target else ""
            if prefix in MEDIA_PREFIXES:
                continue
            out.append(inner.split("|")[-1] if "|" in inner else target)
        else:
            out.append(text[index])
            index += 1
    return "".join(out)


def strip_wikitext(text: str) -> str:
    """Reduce wikitext to prose. Minimal on purpose — see the module docstring."""
    text = _COMMENT_RE.sub(" ", text)
    text = _REF_RE.sub(" ", text)
    text = _TABLE_RE.sub(" ", text)
    text = _strip_templates(text)
    text = _resolve_links(text)
    text = _EXT_LINK_RE.sub(r"\1", text)
    text = _BARE_URL_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = _QUOTES_RE.sub("", text)
    text = _HEADING_RE.sub(r"\1", text)
    text = _LIST_MARKER_RE.sub("", text)
    return text


def normalise_document(text: str) -> str:
    """Collapse whitespace and drop empty/table-only lines.

    `pipeline.normalize_text` runs later and is stricter; this only has to make
    the text line-shaped so `read_lines` reads one document per line.
    """
    lines = []
    for line in _MULTI_NL_RE.sub("\n", text).split("\n"):
        line = _WS_RE.sub(" ", line).strip()
        # A line of nothing but punctuation is usually table residue.
        if line and re.search(r"[^\W\d_]", line, re.UNICODE):
            lines.append(line)
    return "\n".join(lines)


# ── Wikipedia XML dumps ──────────────────────────────────────────────
def _localname(tag: object) -> str:
    """`{http://www.mediawiki.org/xml/export-0.11/}text` → `text`."""
    name = str(tag)
    return name.rsplit("}", 1)[-1] if "}" in name else name


def _child_text(element, name: str) -> str | None:
    for child in element:
        if _localname(child.tag) == name:
            return child.text
    return None


def _child(element, name: str):
    for child in element:
        if _localname(child.tag) == name:
            return child
    return None


def _find_descendant(element, name: str):
    for descendant in element.iter():
        if _localname(descendant.tag) == name:
            return descendant
    return None


def iter_wikipedia_pages(stream, namespaces: set[str] | None = None,
                         counts: dict | None = None) -> Iterator[tuple[str, str]]:
    """Yield `(title, wikitext)` for article pages, streaming.

    `iterparse` plus `elem.clear()` after each page, so a 2 GB dump is not a
    20 GB process. Namespace filtering and redirect skipping happen here, where
    the elements are, rather than being re-derived by the caller.
    """
    import xml.etree.ElementTree as ET

    namespaces = ARTICLE_NAMESPACES if namespaces is None else namespaces
    counts = counts if counts is not None else {}
    for _event, element in ET.iterparse(stream, events=("end",)):
        if _localname(element.tag) != "page":
            continue
        namespace = (_child_text(element, "ns") or "0").strip()
        if _child(element, "redirect") is not None:
            counts["redirects"] = counts.get("redirects", 0) + 1
            element.clear()
            continue
        if namespaces and namespace not in namespaces:
            counts["other_namespace"] = counts.get("other_namespace", 0) + 1
            element.clear()
            continue
        title = (_child_text(element, "title") or "").strip()
        text_element = _find_descendant(element, "text")
        text = text_element.text if text_element is not None else None
        counts["pages"] = counts.get("pages", 0) + 1
        element.clear()
        if text:
            yield title, text


def extract_wikipedia_dump(path: Path, min_chars: int = 200, strip: bool = True,
                           limit: int | None = None, log=print) -> dict:
    """Read a (possibly bz2) MediaWiki dump into paragraph-sized documents."""
    counts: dict = {}
    documents: list[str] = []
    dropped_short = 0
    opener = bz2.open if str(path).endswith(".bz2") else (lambda p, mode: open(p, mode))
    with opener(path, "rb") as stream:
        for _title, wikitext in iter_wikipedia_pages(stream, counts=counts):
            prose = normalise_document(strip_wikitext(wikitext) if strip else wikitext)
            for paragraph in prose.split("\n"):
                if len(paragraph) < min_chars:
                    dropped_short += 1
                    continue
                documents.append(paragraph)
            if limit and len(documents) >= limit:
                log(f"    limit of {limit:,} documents reached")
                break
    counts["kept"] = len(documents)
    counts["dropped_short"] = dropped_short
    return {"documents": documents, "counts": counts}


# ── Hugging Face parquet ─────────────────────────────────────────────
def parquet_columns(path: Path) -> list[str]:
    import pyarrow.parquet as pq

    return list(pq.ParquetFile(path).schema_arrow.names)


def pick_text_column(columns: Iterable[str]) -> str | None:
    """The column most likely to hold prose, or None rather than a guess."""
    lowered = {str(c).lower(): str(c) for c in columns}
    for candidate in PREFERRED_TEXT_COLUMNS:
        if candidate in lowered:
            return lowered[candidate]
    return None


def iter_parquet_documents(path: Path, column: str,
                           limit: int | None = None) -> Iterator[str]:
    """Stream one text column, batch by batch.

    `iter_batches` rather than `read_table`: TinyStories and Sangraha are
    multi-gigabyte folders, and a loader that materialises a file to yield its
    first row cannot be pointed at one.
    """
    import pyarrow.parquet as pq

    yielded = 0
    for batch in pq.ParquetFile(path).iter_batches(columns=[column], batch_size=4096):
        for value in batch.column(0).to_pylist():
            if isinstance(value, str) and value.strip():
                yield value
                yielded += 1
                if limit and yielded >= limit:
                    return


# ── dispatch ─────────────────────────────────────────────────────────
def find_inputs(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    if root.is_file():
        return [root]
    found = [p for p in sorted(root.rglob("*")) if p.is_file() and str(p).endswith(suffixes)]
    return found


KINDS = {
    "wikipedia-dump": (DUMP_SUFFIXES, "compressed MediaWiki XML export"),
    "parquet": ((".parquet",), "Hugging Face datasets parquet"),
}


def extract_file(path: Path, kind: str, text_column: str | None, min_chars: int,
                 strip: bool, limit: int | None, log=print) -> dict:
    if kind == "wikipedia-dump":
        result = extract_wikipedia_dump(path, min_chars=min_chars, strip=strip,
                                        limit=limit, log=log)
        return {"documents": result["documents"], "counts": result["counts"],
                "text_column": None}
    if kind == "parquet":
        columns = parquet_columns(path)
        column = text_column or pick_text_column(columns)
        if column is None:
            raise SystemExit(
                f"{path.name}: no obvious text column. Found {columns}. "
                f"Pass one with --text-column (or --list-columns to inspect).")
        if column not in columns:
            raise SystemExit(f"{path.name}: no column {column!r}. Found {columns}.")
        documents = [d.strip() for d in iter_parquet_documents(path, column, limit=limit)]
        counts = {"rows": len(documents), "kept": len(documents),
                  "dropped_short": sum(1 for d in documents if len(d) < min_chars)}
        documents = [d for d in documents if len(d) >= min_chars]
        counts["kept"] = len(documents)
        return {"documents": documents, "counts": counts, "text_column": column}
    raise SystemExit(f"unknown kind {kind!r}; known: {', '.join(sorted(KINDS))}")


def write_documents(documents: list[str], out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        for document in documents:
            handle.write(document.replace("\n", " ").strip() + "\n")
    return out_path.stat().st_size


MANIFEST_NAME = "extract_manifest.json"


def record_manifest(source_id: str, out_path: Path, kind: str, result: dict,
                    inputs: list[Path], strip: bool, extra: dict | None = None) -> Path:
    """Write what was extracted, from what, and with which known limitations."""
    path = out_path.parent / MANIFEST_NAME
    previous: dict = {}
    if path.exists():
        previous = json.loads(path.read_text(encoding="utf-8"))
    entry = {
        "source": source_id,
        "kind": kind,
        "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "output": out_path.name,
        "documents": len(result["documents"]),
        "bytes": out_path.stat().st_size,
        "inputs": [{"file": p.name, "bytes": p.stat().st_size} for p in inputs],
        "text_column": result.get("text_column"),
        "markup_stripped": strip,
        "counts": result["counts"],
        # §7.3's filters are NOT applied here. Saying so in the artifact stops a
        # reader assuming this text is clean enough to train on.
        "filters_applied": [],
        "filters_pending": ["pii", "toxicity", "dedupe", "langid", "length"],
        "limitations": list(MARKUP_LIMITATIONS) if strip and kind == "wikipedia-dump" else [],
    }
    if extra:
        entry.update(extra)
    previous[source_id] = entry
    path.write_text(json.dumps(previous, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path


def load_fetch_manifest(source_dir: Path) -> dict | None:
    path = source_dir / "fetch_manifest.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def print_check(stream=None) -> int:
    # See `training/scripts/fetch_corpus.py::print_check`: a `stream=sys.stdout`
    # default is bound at import, so it pins the original stdout and escapes both
    # `redirect_stdout` and the UTF-8 reconfiguration in `main` — and the `→`
    # below raises UnicodeEncodeError on a cp1252 console.
    stream = sys.stdout if stream is None else stream
    print("Extractable sources (the fetch → .txt step the pipeline needs)", file=stream)
    print(f"  input:  {RAW_DIR}", file=stream)
    print(f"  output: {EXTRACTED_DIR}/<source id>.txt, one document per line\n", file=stream)
    if not RAW_DIR.exists():
        print("  data/raw does not exist — nothing has been fetched yet.", file=stream)
        return 0
    ready = 0
    for source_dir in sorted(p for p in RAW_DIR.iterdir() if p.is_dir()):
        manifest = load_fetch_manifest(source_dir)
        fetch_state = "fetched" if manifest else "no fetch_manifest.json"
        found: list[tuple[str, list[Path]]] = []
        for kind, (suffixes, _why) in KINDS.items():
            matches = find_inputs(source_dir, suffixes)
            if matches:
                found.append((kind, matches))
        extracted = (EXTRACTED_DIR / f"{source_dir.name}.txt").exists()
        status = "EXTRACTED" if extracted else ("ready" if found else "nothing to extract")
        ready += bool(found) and not extracted
        print(f"  {source_dir.name:<26} {status:<20} ({fetch_state})", file=stream)
        for kind, matches in found:
            print(f"      {kind}: {len(matches)} file(s), e.g. {matches[0].name}", file=stream)
        if not found:
            print(f"      no {' or '.join(KINDS)} files present", file=stream)
    print(f"\n  {ready} source(s) waiting to be extracted", file=stream)
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Turn a fetched source into the text §7.3's pipeline reads")
    parser.add_argument("--source", help="source id under data/raw/")
    parser.add_argument("--in", dest="in_path", help="an explicit file or directory")
    parser.add_argument("--kind", choices=sorted(KINDS), help="input format")
    parser.add_argument("--out", default=str(EXTRACTED_DIR),
                        help="output directory; several sources sharing it are how a "
                             "multi-source Stage A corpus is assembled")
    parser.add_argument("--text-column", help="parquet column holding the prose")
    parser.add_argument("--list-columns", action="store_true",
                        help="print a parquet file's columns and exit")
    parser.add_argument("--min-chars", type=int, default=200,
                        help="drop documents shorter than this (default 200)")
    parser.add_argument("--limit", type=int, default=None,
                        help="stop after this many documents (smoke runs)")
    parser.add_argument("--keep-markup", action="store_true",
                        help="do not strip wikitext (honest, but noisy)")
    parser.add_argument("--check", action="store_true",
                        help="report what could be extracted; touches nothing")
    args = parser.parse_args(argv)

    if args.check:
        return print_check()

    if args.source and not args.in_path:
        source_dir = RAW_DIR / args.source
        if not source_dir.is_dir():
            raise SystemExit(f"no such source directory: {source_dir}")
    elif args.in_path:
        source_dir = Path(args.in_path)
    else:
        raise SystemExit("pass --source <id> or --in <path> (or --check / --list-columns)")

    if args.list_columns:
        for path in find_inputs(source_dir, (".parquet",)):
            print(f"{path.name}: {parquet_columns(path)}")
        if source_dir.is_file() and str(source_dir).endswith(".parquet"):
            print(f"{source_dir.name}: {parquet_columns(source_dir)}")
        return 0

    kind = args.kind
    if not kind:
        for candidate, (suffixes, _why) in KINDS.items():
            if find_inputs(source_dir, suffixes):
                kind = candidate
                break
    if not kind:
        raise SystemExit(
            f"{source_dir}: no {' or '.join(KINDS)} input found. Has this source been "
            f"fetched? (`python -m training.scripts.fetch_corpus --source <id>`)")
    if kind not in KINDS:
        raise SystemExit(f"unknown kind {kind!r}; known: {', '.join(sorted(KINDS))}")

    suffixes = KINDS[kind][0]
    inputs = find_inputs(source_dir, suffixes)
    if not inputs:
        raise SystemExit(f"{source_dir}: no {kind} input (looked for {suffixes})")

    source_id = source_dir.name if source_dir.is_dir() else source_dir.stem
    out_dir = Path(args.out) if args.out else EXTRACTED_DIR
    out_path = out_dir / f"{source_id}.txt"

    print(f"extracting {source_id} ({kind}) from {len(inputs)} file(s)")
    documents: list[str] = []
    counts: dict = {}
    text_column = None
    for path in inputs:
        print(f"  {path.name} ({path.stat().st_size:,} B)")
        remaining = None if args.limit is None else max(0, args.limit - len(documents))
        if remaining == 0:
            break
        result = extract_file(path, kind, args.text_column, args.min_chars,
                              not args.keep_markup, remaining)
        documents.extend(result["documents"])
        text_column = text_column or result.get("text_column")
        for key, value in result["counts"].items():
            if isinstance(value, int):
                counts[key] = counts.get(key, 0) + value

    if not documents:
        raise SystemExit(
            f"{source_id}: extracted 0 documents from {len(inputs)} file(s). The most "
            f"likely cause is --min-chars being too high for this corpus (a short-story "
            f"or dialogue corpus will not have {args.min_chars}-character documents). "
            f"Nothing was written.")

    size = write_documents(documents, out_path)
    result = {"documents": documents, "counts": counts, "text_column": text_column}
    manifest = record_manifest(source_id, out_path, kind, result, inputs,
                               strip=not args.keep_markup)
    print(f"  {len(documents):,} documents → {out_path.name} ({size:,} B)")
    print(f"  manifest: {manifest.name}")
    print(f"\nNext: the §7.3 filters, which have NOT run yet —\n"
          f"  python -m training.scripts.prepare_data --raw {out_dir} "
          f"--out data/processed/{source_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
