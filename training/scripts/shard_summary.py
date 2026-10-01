"""training/scripts/shard_summary.py — the shard manifest, at human size.

    python -m training.scripts.shard_summary data/processed/stage_a/shards

`shards/manifest.json` records every shard file — name, docs, tokens, sha256,
language mix. On the real corpus that is 3,492 entries / ~1.2 MB of JSON, and
printing it into a notebook cell froze v1's browser tab: the kernel was fine,
but Jupyter keeps every cell's output in the page and re-sends all of it when
the notebook is re-opened, and 32,464 lines of JSON is past what a tab
forgives. This reads the same file and prints what a human actually decides
from — the two split totals and the tokenizer identity the training guards
compare against — and nothing else, whatever the manifest's size.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def summarise(manifest_path: Path) -> str:
    """The six lines a human needs, bounded however large the manifest is."""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(
            f"no shard manifest at {manifest_path} — run prepare_data with "
            f"--tokenizer first, or point this at the right directory") from exc

    shards = manifest.get("shards")
    if not isinstance(shards, dict) or not shards:
        raise SystemExit(f"{manifest_path} has no shards section to summarise")

    lines = [f"shard summary — {manifest_path}",
             f"  dtype {manifest.get('dtype', '?')} · vocab "
             f"{manifest.get('vocab_size', '?'):,} · tokenizer "
             f"{manifest.get('tokenizer_version', '?')}",
             f"  end_token_id {manifest.get('end_token_id', '?')}"]
    for split in ("train", "val"):
        entry = shards.get(split)
        if entry is None:
            continue
        files = entry.get("files", [])
        lines.append(f"  {split:<5} {entry.get('docs', 0):>9,} docs · "
                     f"{entry.get('tokens', 0):>13,} tokens · {len(files):>5,} files")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Print a shard manifest's totals — never its per-file entries")
    ap.add_argument("shards_dir", nargs="?", default="data/processed/stage_a/shards",
                    help="directory holding manifest.json (default: %(default)s)")
    args = ap.parse_args(argv)

    print(summarise(Path(args.shards_dir) / "manifest.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
