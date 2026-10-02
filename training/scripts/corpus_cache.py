"""training/scripts/corpus_cache.py — skip the 47-minute corpus pass on resume.

    # once, at the end of a session that did the work
    python -m training.scripts.corpus_cache save \\
        --shards data/processed/stage_a/shards \\
        --tokenizer ai/tokenizer/artifacts/stage-a-16k --out /kaggle/working/corpus-cache

    # then, in every later session
    python -m training.scripts.corpus_cache verify --cache <dir>
    python -m training.scripts.corpus_cache install --cache <dir>

**Why this exists.** Measured on Kaggle, 2026-10-02: from session start to the
first training step took **47 minutes** — two Wikipedia downloads, two extractions
(433,262 and 453,744 documents), the whole §7.3 filter pass, and a 170M-token
shard write over 3,433 files. `/kaggle/working` is wiped between sessions, and
`§1`'s repository cell re-extracts the archive, so *every* session pays all 47
minutes again. §7.3's reference budget implies about 3.7 sessions for config A,
which is roughly **three hours of identical repeated work** — and it has already
cost one session its corpus entirely.

The cache holds the two artifacts that are expensive to rebuild and cheap to
carry: the shards (~350 MB of uint16) and the tokenizer artifact (a few MB).
Not `data/raw/` or `data/extracted/` — those are 1.3 GB and are exactly what the
shards were derived from.

**The dangerous part is a stale cache**, and it is dangerous in the silent way
this project keeps finding. Shards and tokenizer must be the *same generation*:
token ids are indices into the embedding, so shards built with a 12,288-token
tokenizer remain structurally valid against a 16,384-token one and train a model
that reads text one way and was trained another. `train_smoke` already refuses a
vocab mismatch via `assert_matches_tokenizer`, but it can only compare shards to
the tokenizer *present* — if a cache carried mismatched ones it would be checking
a pair against itself.

So `verify` checks the relationship, not just the presence:

* `CACHE.json` parses and its `format` is one this tool understands;
* `shards/manifest.json` still hashes to the digest recorded at `save` time, so
  the manifest cannot have been swapped under an unchanged `CACHE.json`;
* the manifest's own `tokenizer_version` and `vocab_size` agree with `CACHE.json`
  — the two halves of the cache tell the same story;
* the tokenizer artifact's `meta.json` carries that same `tokenizer_version`, which
  is what makes "these shards go with this tokenizer" a checked claim rather than
  a directory that happens to sit next to it;
* every file the inventory recorded is present at the recorded size, so a
  truncated upload is refused rather than trained on.

Any failure is a non-zero exit and a named reason. `install` verifies first and
copies nothing if verification fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tarfile
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

CACHE_FORMAT = 1
CACHE_FILE = "CACHE.json"
DEFAULT_SHARDS = Path("data/processed/stage_a/shards")
DEFAULT_TOKENIZER = Path("ai/tokenizer/artifacts/stage-a-16k")
# A cache is a few thousand files; report a bounded head, not the list.
MAX_REPORTED_MISSING = 10


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def inventory(files: list[Path], root: Path) -> str:
    """One digest over the sorted `relpath:size` lines.

    Sizes plus the manifest digest catch a truncated, missing or substituted
    upload, which is the failure that actually happens in transit. They do not
    catch same-size corruption, so `content_inventory` below checks that too —
    the first version of this docstring claimed hashing every shard would cost
    more than the copy, and measured on 2026-10-02 it costs about six times
    *less*: 351.8 MB hashed in 4.96 s at 71 MB/s, against 30 s to move the same
    bytes over Kaggle's measured 4.6 MB/s. The claim was never measured and was
    wrong in the direction that mattered.
    """
    lines = sorted(f"{p.relative_to(root)}:{p.stat().st_size}" for p in files)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def content_inventory(files: list[Path], root: Path, manifest: dict) -> str:
    """One digest over the manifest's own per-shard digests, re-measured.

    `write_shards` already records a sha256 prefix for every shard, so verifying
    content needs no extra state — only the read. A shard whose name and size
    are right but whose bytes are wrong still trains; it just trains on
    something nobody can account for.
    """
    expected = {}
    for split in manifest.get("shards", {}).values():
        listed = split.get("files")
        # A count rather than a list is a manifest written before per-shard
        # digests existed. There is nothing to check against, and pretending
        # otherwise would report a content check that never ran. (Named `listed`,
        # not `files`: reusing the parameter's name shadowed it and turned the
        # loop below into an iteration over dicts.)
        if not isinstance(listed, list):
            continue
        for entry in listed:
            if isinstance(entry, dict) and entry.get("sha256"):
                expected[entry["file"]] = entry["sha256"]
    if not expected:
        return ""
    lines = []
    for path in sorted(files):
        name = path.name
        if name not in expected:
            continue
        digest = sha256_file(path)
        if not digest.startswith(expected[name]):
            raise SystemExit(
                f"{path}: content does not match the manifest "
                f"({digest[:16]}… vs {expected[name]}…). Refusing to install a "
                f"cache whose shards are not the shards it claims to hold.")
        lines.append(f"{name}:{expected[name]}")
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _tokenizer_meta(tokenizer_dir: Path) -> dict:
    meta = tokenizer_dir / "meta.json"
    if not meta.is_file():
        raise SystemExit(f"{tokenizer_dir}: no meta.json — not a tokenizer artifact")
    return _read_json(meta)


def save(shards: Path, tokenizer: Path, out: Path) -> int:
    manifest_path = shards / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(
            f"{shards}: no manifest.json. Shard the corpus first:\n"
            f"  python -m training.scripts.prepare_data --raw data/extracted "
            f"--out data/processed/stage_a --tokenizer {tokenizer}")
    manifest = _read_json(manifest_path)
    meta = _tokenizer_meta(tokenizer)

    if manifest.get("tokenizer_version") != meta.get("tokenizer_version"):
        raise SystemExit(
            f"refusing to cache a mismatched pair:\n"
            f"  {manifest_path} was sharded with "
            f"{manifest.get('tokenizer_version')!r}\n"
            f"  {tokenizer / 'meta.json'} is "
            f"{meta.get('tokenizer_version')!r}\n"
            f"  Caching these together would make every later session's "
            f"consistency check compare the pair to itself. Re-shard with this "
            f"tokenizer.")
    if manifest.get("vocab_size") != meta.get("vocab_size"):
        raise SystemExit(
            f"refusing to cache a mismatched pair: manifest vocab_size "
            f"{manifest.get('vocab_size')} vs tokenizer {meta.get('vocab_size')}")

    out.mkdir(parents=True, exist_ok=True)
    for name, src in (("shards", shards), ("tokenizer", tokenizer)):
        target = out / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(src, target)

    files = [p for p in (out / "shards").rglob("*") if p.is_file()]
    shard = manifest.get("shards", {})
    record = {
        "format": CACHE_FORMAT,
        "tokenizer_version": meta["tokenizer_version"],
        "vocab_size": meta["vocab_size"],
        "dtype": manifest.get("dtype"),
        "train": shard.get("train", {}).get("tokens"),
        "val": shard.get("val", {}).get("tokens"),
        "shard_files": len(files),
        "manifest_sha256": sha256_file(out / "shards" / "manifest.json"),
        "inventory_sha256": inventory(files, out / "shards"),
        "content_sha256": content_inventory(files, out / "shards", manifest),
    }
    (out / CACHE_FILE).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")

    print(f"corpus cache written to {out}")
    print(f"  tokenizer      {record['tokenizer_version']} (vocab {record['vocab_size']:,})")
    print(f"  tokens         train {record['train']:,} · val {record['val']:,}")
    print(f"  files          {record['shard_files']:,} shard file(s) + tokenizer artifact")
    print(f"  manifest sha   {record['manifest_sha256'][:16]}…")
    print(f"  inventory sha  {record['inventory_sha256'][:16]}…")
    if record["content_sha256"]:
        print(f"  content sha    {record['content_sha256'][:16]}… "
              f"(every shard re-hashed against the manifest)")
    return 0


def check(cache: Path) -> dict:
    """Every way a cache can be stale, in one place. Raises SystemExit."""
    record_path = cache / CACHE_FILE
    if not record_path.is_file():
        raise SystemExit(
            f"{cache}: no {CACHE_FILE} — this directory was not written by "
            f"`corpus_cache save`, so there is nothing to say what it holds.")
    record = _read_json(record_path)

    if record.get("format") != CACHE_FORMAT:
        raise SystemExit(
            f"{record_path}: cache format {record.get('format')!r}, this tool "
            f"understands {CACHE_FORMAT}. A newer cache read by an older tool "
            f"would be checked with the wrong rules.")

    shards = cache / "shards"
    manifest_path = shards / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"{cache}: no shards/manifest.json in the cache")
    if sha256_file(manifest_path) != record.get("manifest_sha256"):
        raise SystemExit(
            f"{manifest_path}: sha256 does not match {CACHE_FILE}. The manifest "
            f"changed after the cache was written, so {CACHE_FILE}'s token counts "
            f"and tokenizer describe something else.")

    manifest = _read_json(manifest_path)
    for field in ("tokenizer_version", "vocab_size"):
        if manifest.get(field) != record.get(field):
            raise SystemExit(
                f"{manifest_path}: {field} is {manifest.get(field)!r} but "
                f"{CACHE_FILE} says {record.get(field)!r}. The two halves of this "
                f"cache disagree about which generation they are.")

    meta = _tokenizer_meta(cache / "tokenizer")
    if meta.get("tokenizer_version") != record["tokenizer_version"]:
        raise SystemExit(
            f"{cache / 'tokenizer' / 'meta.json'}: tokenizer_version is "
            f"{meta.get('tokenizer_version')!r}, but the shards in this cache were "
            f"built with {record['tokenizer_version']!r}. Token ids are indices "
            f"into the embedding, so training these two together produces a model "
            f"that reads text one way and was trained another — and no downstream "
            f"check can see it.")
    if meta.get("vocab_size") != record["vocab_size"]:
        raise SystemExit(
            f"{cache / 'tokenizer' / 'meta.json'}: vocab_size "
            f"{meta.get('vocab_size')} vs the cached shards' "
            f"{record['vocab_size']}")

    files = [p for p in shards.rglob("*") if p.is_file()]
    if record.get("shard_files") != len(files):
        raise SystemExit(
            f"{shards}: {len(files)} file(s) present, {CACHE_FILE} recorded "
            f"{record.get('shard_files')}. An incomplete upload would train on "
            f"part of the corpus without saying so.")
    return {"cache": str(cache), "record": record, "files": len(files),
            "files_paths": files,
            "manifest": manifest,
            "inventory_sha256": inventory(files, shards)}


def content_check(cache: Path, shards: Path, files: list[Path],
                  manifest: dict) -> str:
    """Re-hash every shard and compare, unless the cache predates the check.

    A cache written before `content_sha256` existed is still checked for its
    file set, tokenizer generation and sizes; it says so rather than claiming a
    content check it never did.
    """
    recorded = (cache / CACHE_FILE)
    expected = _read_json(recorded).get("content_sha256")
    if not expected:
        return ""
    actual = content_inventory(files, shards, manifest)
    if actual != expected:
        raise SystemExit(
            f"{shards}: shard contents do not match the recorded content digest "
            f"({actual[:16]}… vs {expected[:16]}…). Names and sizes match, so only "
            f"reading the bytes finds this.")
    return actual


def verify(cache: Path) -> int:
    result = check(cache)
    record = result["record"]
    shards = cache / "shards"
    if result["inventory_sha256"] != record["inventory_sha256"]:
        raise SystemExit(
            f"{shards}: the file sizes do not match the recorded "
            f"inventory, so the contents are not the ones that were cached.")
    content = content_check(cache, shards, result["files_paths"], result["manifest"])
    print(f"cache OK — {cache}")
    print(f"  tokenizer      {record['tokenizer_version']} (vocab {record['vocab_size']:,})")
    print(f"  tokens         train {record['train']:,} · val {record['val']:,}")
    print(f"  files          {result['files']:,}")
    if content:
        print(f"  content sha    {content[:16]}… "
              f"(every shard re-hashed against the manifest)")
        print("  shards and tokenizer are the same generation, the file set is "
              "complete, and every shard's bytes match the manifest")
    else:
        print("  shards and tokenizer are the same generation, and the file set "
              "is complete")
        print("  content not checked — this cache predates the per-shard digest "
              "check, so only names and sizes were verified")
    return 0


def install(cache: Path, shards_to: Path, tokenizer_to: Path) -> int:
    verify(cache)  # nothing is copied unless the whole cache checks out
    for name, target in (("shards", shards_to), ("tokenizer", tokenizer_to)):
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(cache / name, target)
    print("\ninstalled")
    print(f"  shards    -> {shards_to}")
    print(f"  tokenizer -> {tokenizer_to}")
    print("\nskip the fetch / extract / prepare / shard cells: this is their output.")
    return 0


def archive(cache: Path, out: Path) -> int:
    """Write a verified cache as ONE .tgz.

    The reason this exists is measured, 2026-10-02. Kaggle's kernel-output API
    downloads **one file per HTTP request** and pages the listing 20 at a time by
    default, so a `/kaggle/working` holding the repo tree plus 3,505 shard files
    is ~188 round trips of enumeration before anything is fetched — `kernels
    output` blew a 300-second timeout, and with `--page-size 200` the same call
    finished in 7 seconds. Even at that speed the shards would arrive as 3,505
    separate requests.

    A single archive is one request. It also sidesteps whatever cap there may be
    on the *number* of output items, which is the risk that cannot be tested from
    here: there is a "[Bug] Kaggle notebook outputs are limited to 500 items"
    report on Kaggle, and this tree is 3,757 files.

    Verified first, and the archive is not written if verification fails.
    """
    verify(cache)
    out.parent.mkdir(parents=True, exist_ok=True)
    root = cache.parent
    with tarfile.open(out, "w:gz") as tar:
        tar.add(cache, arcname=cache.name)
    size = out.stat().st_size
    print(f"\nwrote {out} ({size / 1e6:,.1f} MB) — one file, one request")
    print(f"pull it with:  kaggle kernels output <ref> "
          f"--file-pattern '{out.name}$' --page-size 200")
    del root
    return 0


def build_parser() -> argparse.ArgumentParser:
    """One parser, one `command` positional, every flag visible in `--help`.

    Subparsers would be the tidier CLI, but `argparse` shows only
    `{save,verify,install}` at the top level and hides every real flag behind
    `<command> --help`. `tests/py/test_docs_commands.py` checks each flag the
    docs mention against this `--help` output, and it is right to: a flag that is
    documented but not discoverable is how a runbook drifts from its tool.
    So the flags are all declared here and the combination is validated below.
    """
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="commands:\n"
               "  save     write a cache from this session's shards + tokenizer\n"
               "  verify   check a cache is usable (refuses a stale one)\n"
               "  install  verify, then copy the cache into the workspace\n"
               "  archive  verify, then write the cache as one .tgz (one request "
               "to pull)\n")
    ap.add_argument("command", choices=["save", "verify", "install", "archive"])
    ap.add_argument("--shards", type=Path, default=DEFAULT_SHARDS,
                    help="shard directory (save), or where to install them")
    ap.add_argument("--tokenizer", type=Path, default=DEFAULT_TOKENIZER,
                    help="tokenizer artifact directory (save)")
    ap.add_argument("--out", type=Path, help="where to write the cache (save)")
    ap.add_argument("--cache", type=Path, help="the cache directory (verify, install)")
    ap.add_argument("--shards-to", type=Path, default=DEFAULT_SHARDS,
                    help="install destination for the shards")
    ap.add_argument("--tokenizer-to", type=Path, default=DEFAULT_TOKENIZER,
                    help="install destination for the tokenizer artifact")
    ap.add_argument("--archive", type=Path,
                    help="with `archive`: write the verified cache to this .tgz")
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args(argv)

    if args.command == "save":
        if args.out is None:
            raise SystemExit("save needs --out <directory>")
        return save(args.shards, args.tokenizer, args.out)
    if args.cache is None:
        raise SystemExit(f"{args.command} needs --cache <directory>")
    if args.command == "verify":
        return verify(args.cache)
    if args.command == "archive":
        if args.archive is None:
            raise SystemExit("archive needs --archive <path.tgz>")
        return archive(args.cache, args.archive)
    return install(args.cache, args.shards_to, args.tokenizer_to)


if __name__ == "__main__":
    raise SystemExit(main())
