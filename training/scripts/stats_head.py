"""training/scripts/stats_head.py — the pipeline stats, at head size.

    python -m training.scripts.stats_head data/processed/stage_a/stats.json

`stats.json` gains a `by_source` entry per fetched source. Two Wikipedias make
that a few hundred lines of pretty-printed JSON; ten sources would make it a
few thousand — and v1's page died on a file far smaller than that. This prints
the headline block (`dropped` by reason, language totals, the masking count)
plus a bounded `head` of the per-source section — filename, kept/dropped,
language mix — and a `... (+N more lines)` marker instead of the rest,
whatever the file's size. For the full entry, read the file outside the
browser.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

HEAD_LINES = 20


def per_source_lines(by_source: dict, limit: int) -> list[str]:
    """One bounded line per source, then a marker instead of the remainder."""
    lines = []
    for name, s in by_source.items():
        langs = s.get("by_lang", {})
        lang = " · ".join(f"{k} {v:,}" for k, v in sorted(langs.items()))
        lines.append(f"  {name}: kept {s.get('kept', 0):,}, dropped "
                     f"{s.get('dropped_total', 0):,} ({lang})")
    if len(lines) > limit:
        more = len(lines) - limit
        lines = lines[:limit] + [f"  ... (+{more} more sources — read "
                                 f"stats.json directly for the rest)"]
    return lines


def summarise(stats_path: Path, limit: int = HEAD_LINES) -> str:
    try:
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(
            f"no stats file at {stats_path} — run prepare_data first") from exc

    lines = [f"stats — {stats_path}",
             f"  kept {stats.get('kept', 0):,} / {stats.get('seen', 0):,} "
             f"({stats.get('dropped_total', 0):,} dropped)"]
    dropped = stats.get("dropped", {})
    if dropped:
        lines.append("  dropped by reason:")
        lines += [f"    {reason:<16} {count:>7,}"
                  for reason, count in dropped.items()]
    lines.append(f"  languages: {stats.get('by_lang', {})}")
    masked = stats.get("masked_facts", [])
    withheld = stats.get("withheld_facts", [])
    lines.append(f"  masked {len(masked)} public facts (withheld {len(withheld)})")

    by_source = stats.get("by_source", {})
    if by_source:
        lines.append(f"  by source ({len(by_source)}):")
        lines += per_source_lines(by_source, limit)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Print stats.json's headline plus a bounded per-source head")
    ap.add_argument("stats_path", nargs="?", default="data/processed/stage_a/stats.json",
                    help="the stats.json to read (default: %(default)s)")
    ap.add_argument("--head", type=int, default=HEAD_LINES,
                    help="max per-source lines before the `... (+N more)` marker")
    args = ap.parse_args(argv)

    print(summarise(Path(args.stats_path), args.head))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
