"""training/scripts/fetch_corpus.py — licence-gated Stage A corpus fetching.

    python -m training.scripts.fetch_corpus --check
    python -m training.scripts.fetch_corpus --verify hindi_wikipedia \\
        --spdx CC-BY-SA-4.0 --url https://dumps.wikimedia.org/legal.html \\
        --reviewer "Aashish Kumar"
    python -m training.scripts.fetch_corpus --source hindi_wikipedia

§7.3 says "verify each license/ToS and record in `DATA_LICENSES.md`". This
script is what makes that a step rather than a sentence: a source is
downloaded **only** when `data/sources.json` says its licence was verified by
a named person on a date, with the URL that was read. There is no `--force`.

Why insist on that: an unverified source is a decision nobody has made yet,
and a fetch that stops for a decision costs minutes, while a model trained on
text we had no right to use costs the whole project. The gate is also the
reason `--verify` demands a concrete SPDX id — verifying a licence by writing
"UNKNOWN" into a flag is exactly the failure this file exists to prevent.

Downloads are resumable and hashed: partial files are kept as `.part`, a
`Range` request continues them, and a mismatch with an expected sha256 deletes
the result rather than leaving a corrupt shard that later looks real.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCES_PATH = REPO_ROOT / "data" / "sources.json"
RAW_DIR = REPO_ROOT / "data" / "raw"
CHUNK = 1 << 20
USER_AGENT = "aashish-ai-corpus-fetcher/1.0 (portfolio assistant training; contact via repository)"

# SPDX ids that mean "nobody checked". Refusing these is the whole point.
NON_ANSWERS = {None, "", "UNKNOWN", "NONE", "TODO", "TBD", "?"}


class LicenceError(RuntimeError):
    """The source's licence has not been verified, or is not usable."""


@dataclass
class Source:
    id: str
    raw: dict

    @property
    def name(self) -> str:
        return self.raw.get("name", self.id)

    @property
    def kind(self) -> str:
        return self.raw.get("kind", "unspecified")

    @property
    def enabled(self) -> bool:
        return bool(self.raw.get("enabled"))

    @property
    def license(self) -> dict:
        return self.raw.get("license") or {}

    @property
    def verified(self) -> bool:
        return bool(self.license.get("verified"))

    @property
    def spdx(self) -> str | None:
        return self.license.get("spdx")

    def block_kind(self) -> str | None:
        """One of 'unverified' | 'non_answer' | 'disabled', or None when usable.

        The three blocks need different fixes, and a report that tells someone
        to flip `enabled` when their actual problem is an unread licence sends
        them the wrong way.
        """
        if not self.verified:
            return 'unverified'
        if str(self.spdx).strip().upper() in NON_ANSWERS:
            return 'non_answer'
        if not self.enabled:
            return 'disabled'
        return None

    def status(self) -> str:
        kind = self.block_kind()
        if kind == 'unverified':
            return "BLOCKED: licence not verified"
        if kind == 'non_answer':
            return f"BLOCKED: licence recorded as {self.spdx!r}, which is not an answer"
        if kind == 'disabled':
            return 'BLOCKED: verified but not enabled'
        return 'ready'

    def verify_command(self, spdx: str = "<SPDX-ID>", url: str = "<the-page-you-read>") -> str:
        return (f"python -m training.scripts.fetch_corpus --verify {self.id} "
                f"--spdx {spdx} --url {url} --reviewer \"<your name>\"")


def load_registry(path: Path | str = SOURCES_PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sources(registry: dict) -> list[Source]:
    return [Source(id=s["id"], raw=s) for s in registry.get("sources", [])]


def find_source(registry: dict, source_id: str) -> Source:
    for source in sources(registry):
        if source.id == source_id:
            return source
    known = ", ".join(s.id for s in sources(registry))
    raise KeyError(f"unknown source {source_id!r}; known: {known}")


def require_usable(source: Source) -> None:
    """Raise unless the registry says this source may actually be fetched."""
    status = source.status()
    if status == "ready":
        return
    hint = ""
    if not source.verified:
        hint = ("\n  Read the terms, then record what you read:\n    "
                + source.verify_command())
    raise LicenceError(f"{source.id} ({source.name}) is {status}.{hint}")


# ── downloading ──────────────────────────────────────────────────────
def sha256_file(path: Path | str, chunk: int = CHUNK) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, dest: Path | str, opener=None, expected_sha256: str | None = None,
             log=print, retries: int = 3) -> dict:
    """Fetch `url` → `dest`, resuming a `.part` file when the server allows it.

    The opener is injectable so the resume logic — the part that decides
    whether to re-download a 2 GB dump or continue it — is testable without a
    network, and so is the sha256 refusal.
    """
    opener = opener or (lambda request: urllib.request.urlopen(request))
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")

    for attempt in range(1, retries + 1):
        offset = part.stat().st_size if part.exists() else 0
        headers = {"User-Agent": USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)

        try:
            with opener(request) as response:
                status = getattr(response, "status", 200)
                if offset and status != 206:
                    log(f"    server ignored Range (HTTP {status}) — restarting the file")
                    offset = 0
                mode = "ab" if offset else "wb"
                with part.open(mode) as fh:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        fh.write(block)
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == retries:
                raise
            wait = 2 ** attempt
            log(f"    {error} — retrying in {wait}s ({attempt}/{retries})")
            time.sleep(wait)

    size = part.stat().st_size
    digest = sha256_file(part)
    if expected_sha256 and digest != expected_sha256:
        part.unlink(missing_ok=True)
        raise ValueError(
            f"sha256 mismatch for {url}\n  expected {expected_sha256}\n  got      {digest}\n"
            f"  the partial file was deleted so a corrupt shard cannot look real later")
    os.replace(part, dest)
    log(f"    {dest.name}: {size:,} B, sha256 {digest[:16]}…")
    return {"url": url, "file": dest.name, "bytes": size, "sha256": digest,
            "resumed_from": offset}


def fetch_local(source: Source, out_dir: Path, log=print) -> list[dict]:
    """Copy a path the owner already has (their own dumps, a Kaggle input)."""
    entries = source.raw.get("files") or []
    if not entries:
        raise ValueError(f"{source.id}: kind 'local' needs a non-empty 'files' list of paths")
    results = []
    for entry in entries:
        src = Path(entry["path"]).expanduser()
        if not src.is_file():
            raise FileNotFoundError(f"{source.id}: {src} does not exist")
        dest = out_dir / src.name
        shutil.copy2(src, dest)
        digest = sha256_file(dest)
        log(f"    {dest.name}: {dest.stat().st_size:,} B, sha256 {digest[:16]}…")
        results.append({"path": str(src), "file": dest.name,
                        "bytes": dest.stat().st_size, "sha256": digest})
    return results


def fetch_hf_dataset(source: Source, out_dir: Path, log=print) -> list[dict]:
    """Hugging Face datasets, pinned to a revision, via huggingface_hub."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:  # pragma: no cover - environment dependent
        raise LicenceError(
            f"{source.id}: huggingface_hub is not installed. Either `pip install "
            f"huggingface_hub` or attach the dataset as a Kaggle input and register it "
            f"as a 'local' source instead. ({error})")

    revision = source.raw.get("revision")
    if not revision:
        raise LicenceError(
            f"{source.id}: no revision pinned. A dataset fetched from 'main' is not "
            f"reproducible — set \"revision\" to the commit hash you reviewed.")

    log(f"    huggingface_hub snapshot_download({source.raw['repo']}@{revision[:12]}…)")
    path = snapshot_download(repo_id=source.raw["repo"], revision=revision,
                             repo_type="dataset", local_dir=str(out_dir))
    files = []
    for file in sorted(Path(path).rglob("*")):
        if file.is_file():
            files.append({"file": str(file.relative_to(out_dir)).replace("\\", "/"),
                          "bytes": file.stat().st_size, "sha256": sha256_file(file)})
    return files


def fetch(source: Source, out_dir: Path | str | None = None, opener=None, log=print) -> dict:
    require_usable(source)
    out_dir = Path(out_dir) if out_dir else RAW_DIR / source.id
    out_dir.mkdir(parents=True, exist_ok=True)

    if source.kind == "http_file":
        entries = source.raw.get("files") or []
        if not entries:
            raise ValueError(f"{source.id}: kind 'http_file' needs a 'files' list")
        results = [download(entry["url"], out_dir / (entry.get("name")
                                                    or entry["url"].rstrip("/").split("/")[-1]),
                            opener=opener, expected_sha256=entry.get("sha256"), log=log)
                   for entry in entries]
    elif source.kind == "local":
        results = fetch_local(source, out_dir, log=log)
    elif source.kind == "hf_dataset":
        results = fetch_hf_dataset(source, out_dir, log=log)
    elif source.kind == "generated":
        raise LicenceError(
            f"{source.id}: this source is produced by {source.raw.get('generator')}, which "
            f"does not exist yet (P5). Nothing to fetch.")
    else:
        raise ValueError(f"{source.id}: unsupported kind {source.kind!r}")

    manifest = {
        "source": source.id,
        "name": source.name,
        "kind": source.kind,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "license": source.license,
        "required_filters": (load_registry().get("policy", {}).get("required_filters") or []),
        "files": results,
        "total_bytes": sum(int(r.get("bytes", 0)) for r in results),
    }
    (out_dir / "fetch_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


# ── the verification act itself ──────────────────────────────────────
def verify_source(source_id: str, spdx: str, url: str, reviewer: str, notes: str = "",
                  path: Path | str = SOURCES_PATH) -> dict:
    """Record a *human* licence decision. The only way to unblock a source."""
    registry = load_registry(path)
    if str(spdx).strip().upper() in NON_ANSWERS:
        raise LicenceError(
            f"{spdx!r} is not a licence. Verifying means writing down the licence you "
            f"actually read — e.g. CC-BY-SA-4.0, MIT, or own-work for text we wrote.")
    if not (url or "").strip():
        raise LicenceError("record the URL you read the terms at; a licence claim "
                           "without a source is not verifiable later")
    if not (reviewer or "").strip():
        raise LicenceError("record who verified it")

    for entry in registry["sources"]:
        if entry["id"] != source_id:
            continue
        entry.setdefault("license", {}).update({
            "spdx": spdx, "url": url, "verified": True,
            "verified_by": reviewer,
            "verified_at": time.strftime("%Y-%m-%d", time.gmtime()),
        })
        if notes:
            entry["license"]["notes"] = notes
        entry["enabled"] = True
        Path(path).write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
        return entry
    raise KeyError(f"unknown source {source_id!r}")


# ── CLI ──────────────────────────────────────────────────────────────
def print_check(registry: dict, stream=sys.stdout) -> int:
    policy = registry.get("policy", {})
    print("Stage A corpus sources (§7.3 licence gate)", file=stream)
    print(f"  {policy.get('rule', '')}\n", file=stream)
    blocked = 0
    for source in sources(registry):
        status = source.status()
        blocked += status != "ready"
        print(f"  {source.id:<24} {status}", file=stream)
        print(f"    {source.name} — {source.raw.get('why', '')}", file=stream)
        if status != "ready":
            kind = source.block_kind()
            if kind == 'unverified':
                print(f"    to unblock: {source.verify_command()}", file=stream)
            elif kind == 'non_answer':
                print(f"    to unblock: re-run the verification with the licence you "
                      f"actually read — {source.spdx!r} names none:", file=stream)
                print(f"      {source.verify_command()}", file=stream)
            else:
                print("    to unblock: set enabled to true once the data is actually needed",
                      file=stream)
        else:
            entries = source.raw.get("files") or []
            for entry in entries:
                print(f"    would fetch: {entry.get('url') or entry.get('path')}", file=stream)
        print(file=stream)
    print(f"  {len(sources(registry))} sources, {blocked} blocked", file=stream)
    return 0


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Licence-gated corpus fetching (§7.3)")
    ap.add_argument("--sources", default=str(SOURCES_PATH))
    ap.add_argument("--source", help="fetch this source id")
    ap.add_argument("--out", help="output directory (default data/raw/<id>)")
    ap.add_argument("--check", action="store_true", help="report the gate; never touches the network")
    ap.add_argument("--list", action="store_true", help="source ids and status")
    ap.add_argument("--verify", metavar="SOURCE_ID", help="record a licence verification")
    ap.add_argument("--spdx", help="SPDX id you actually read the terms under")
    ap.add_argument("--url", help="URL of the terms you read")
    ap.add_argument("--reviewer")
    ap.add_argument("--notes", default="")
    args = ap.parse_args(argv)

    registry = load_registry(args.sources)

    if args.verify:
        entry = verify_source(args.verify, args.spdx, args.url, args.reviewer,
                              args.notes, path=args.sources)
        print(f"verified {entry['id']} as {entry['license']['spdx']} — now enabled")
        print("Remember to update docs/DATA_LICENSES.md (a test reconciles the two).")
        return 0

    if args.list or (not args.source and not args.check):
        for source in sources(registry):
            print(f"{source.id:<24} {source.status()}")
        return 0

    if args.check:
        return print_check(registry)

    try:
        source = find_source(registry, args.source)
        require_usable(source)
    except (LicenceError, KeyError) as error:
        print(f"\nREFUSED: {error}\n", file=sys.stderr)
        return 2

    print(f"fetching {source.id} → {args.out or RAW_DIR / source.id}")
    manifest = fetch(source, args.out)
    print(f"  {len(manifest['files'])} file(s), {manifest['total_bytes']:,} B")
    print(f"  manifest: {(Path(args.out) if args.out else RAW_DIR / source.id) / 'fetch_manifest.json'}")
    print("\nNext: run the §7.3 pipeline over it — "
          "`python -m training.scripts.prepare_data --raw <dir> --out data/processed/<name>`")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
