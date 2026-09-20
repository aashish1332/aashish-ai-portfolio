"""training/scripts/prepare_data.py — run the §7.3 pipeline end to end.

    python -m training.scripts.prepare_data \
        --raw data/raw/seed --out data/processed/seed \
        --tokenizer ai/tokenizer/artifacts/seed-4k

Writes:
    data/processed/<name>/corpus.jsonl   the surviving records + labels
    data/processed/<name>/stats.json     what was kept and what was dropped, per reason
    data/processed/<name>/leakage.json   train/val overlap check
    data/processed/<name>/shards/*.bin   uint16 token ids (memmap-ready) + manifest

The `--tokenizer` step is optional on purpose: cleaning, dedupe, language
tagging and the leakage check are worth running before a tokenizer exists,
and they are the steps whose output you actually want to read.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import facts, pipeline  # noqa: E402
from ai.tokenizer import spec  # noqa: E402


def read_lines(raw_dir: Path) -> list[tuple[str, str]]:
    """Every non-empty line as (source-file, text)."""
    out: list[tuple[str, str]] = []
    for path in sorted(raw_dir.glob("*.txt")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append((path.name, line))
    return out


def prepare(raw_dir: Path, out_dir: Path, tokenizer_dir: Path | None = None,
            val_percent: int = 2) -> dict:
    kb = spec.load_kb()
    masked = facts.kb_values_for_masking(kb)

    source_pairs = read_lines(raw_dir)
    if not source_pairs:
        raise SystemExit(f"no .txt files under {raw_dir} — run "
                         f"`python -m training.scripts.make_seed_corpus`")

    by_source: dict[str, list[str]] = {}
    for name, text in source_pairs:
        by_source.setdefault(name, []).append(text)

    records = []
    stats = pipeline.Stats()
    per_source: dict[str, dict] = {}
    for name, lines in by_source.items():
        recs, src_stats = pipeline.build_corpus(lines, source=name, kb_values=masked)
        records.extend(recs)
        per_source[name] = src_stats.as_dict()
        stats.seen += src_stats.seen
        stats.kept += src_stats.kept
        for reason, count in src_stats.dropped.items():
            stats.dropped[reason] = stats.dropped.get(reason, 0) + count
        for lang, count in src_stats.by_lang.items():
            stats.by_lang[lang] = stats.by_lang.get(lang, 0) + count
        stats.near_dup_pairs += src_stats.near_dup_pairs

    records = pipeline.assign_splits(records, val_percent)
    train = [r for r in records if r.split == "train"]
    val = [r for r in records if r.split == "val"]
    leakage = pipeline.leakage_report(train, val)

    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "corpus.jsonl").open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps({"text": r.text, "lang": r.lang,
                                 "source": r.source, "split": r.split},
                                ensure_ascii=False) + "\n")

    stats_dict = stats.as_dict()
    stats_dict["by_source"] = per_source
    stats_dict["masked_facts"] = sorted(masked)
    stats_dict["withheld_facts"] = sorted(facts.withheld(kb))
    stats_dict["val_percent"] = val_percent
    (out_dir / "stats.json").write_text(
        json.dumps(stats_dict, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "leakage.json").write_text(
        json.dumps(leakage, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {"stats": stats_dict, "leakage": leakage, "shards": None}

    if tokenizer_dir:
        from ai.tokenizer.train import load

        tokenizer, meta = load(tokenizer_dir)
        shards = pipeline.write_shards(records, tokenizer, out_dir / "shards")
        summary["shards"] = shards
        summary["tokenizer_version"] = meta["tokenizer_version"]

    return summary


def _print(stats: dict, leakage: dict, shards: dict | None) -> None:
    print(f"kept {stats['kept']:,} / {stats['seen']:,} lines "
          f"({stats['dropped_total']:,} dropped)")
    if stats["dropped"]:
        print("  dropped by reason:")
        for reason, count in stats["dropped"].items():
            print(f"    {reason:<16} {count:>6}")
    print(f"  languages: {stats['by_lang']}")
    print(f"  masked to placeholders: {len(stats['masked_facts'])} public facts "
          f"(withheld: {len(stats['withheld_facts'])})")
    print(f"leakage: {'clean' if leakage['clean'] else 'CONTAMINATED'} "
          f"(train {leakage['train_docs']:,} / val {leakage['val_docs']:,}, "
          f"exact {leakage['exact_overlap']}, near {leakage['near_overlap']})")
    if shards:
        for split in ("train", "val"):
            s = shards["shards"][split]
            print(f"  shard {split:<5} {s['tokens']:>9,} tokens "
                  f"in {len(s.get('files', []))} file(s)")
    if not leakage["clean"]:
        raise SystemExit("train/val leakage detected — refusing to continue")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Run the §7.3 data pipeline")
    ap.add_argument("--raw", default=str(spec.REPO_ROOT / "data" / "raw" / "seed"))
    ap.add_argument("--out", default=str(spec.REPO_ROOT / "data" / "processed" / "seed"))
    ap.add_argument("--tokenizer", default=None, help="tokenizer artifact directory")
    ap.add_argument("--val-percent", type=int, default=2)
    args = ap.parse_args(argv)

    summary = prepare(Path(args.raw), Path(args.out),
                      Path(args.tokenizer) if args.tokenizer else None,
                      args.val_percent)
    _print(summary["stats"], summary["leakage"], summary["shards"])
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
