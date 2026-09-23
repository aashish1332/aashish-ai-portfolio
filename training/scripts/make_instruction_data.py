"""training/scripts/make_instruction_data.py — build Stage B data (§7.4).

    python -m training.scripts.make_instruction_data --count 40000

Writes three things:

  data/instruction/sft.jsonl        one example per line: the serialised
                                    `<|sys|>…<|end|>` text, its assistant
                                    spans (the §7.4 "loss only on assistant
                                    tokens" rule), and the labels a human
                                    reviews by (category, language, persona,
                                    counterfactual).
  data/instruction/manifest.json    exact counts, the mix it was asked for,
                                    the counterfactual share, and a
                                    character-based token ESTIMATE.
  evaluation/review_sample.md       ~100 random Hindi/Hinglish examples for
                                    the owner to judge naturalness (§7.4).

The review sample is the point of the last one: a generator that produces
25,000 fluent-looking examples can still be producing unnatural Hindi, and
no test can tell you that — a Hinglish speaker can.

Nothing here is downloaded and nothing here trains. It reads
`knowledge/knowledge.json` and writes text.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import instruction as inst  # noqa: E402
from ai.data import langid  # noqa: E402

OUT_DIR = inst.REPO_ROOT / "data" / "instruction"
REVIEW_PATH = inst.REPO_ROOT / "evaluation" / "review_sample.md"


def _rel(path: Path) -> str:
    """Repo-relative when it is inside the repo — an absolute path when a
    caller (a test, a scratch run) writes somewhere else entirely."""
    try:
        return str(path.relative_to(inst.REPO_ROOT))
    except ValueError:
        return str(path)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m training.scripts.make_instruction_data",
        description="Generate §7.4 Stage B instruction-tuning data from knowledge.json.",
    )
    p.add_argument("--count", type=int, default=40000, help="number of examples (30k–150k per §7.4)")
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--share", type=float, default=0.35,
                   help="counterfactual share (§7.4 requires ≥ 0.30)")
    p.add_argument("--out", type=Path, default=OUT_DIR)
    p.add_argument("--review", type=Path, default=REVIEW_PATH)
    p.add_argument("--kb", type=Path, default=None)
    p.add_argument("--review-count", type=int, default=100)
    p.add_argument("--dry-run", action="store_true", help="report counts without writing")
    return p


def summarise(examples: list[dict], requested: dict) -> dict:
    by_cat: dict[str, int] = {}
    by_lang: dict[str, int] = {}
    by_persona: dict[str, int] = {}
    cf = 0
    chars = 0
    for ex in examples:
        by_cat[ex["category"]] = by_cat.get(ex["category"], 0) + 1
        by_lang[ex["lang"]] = by_lang.get(ex["lang"], 0) + 1
        by_persona[ex["persona"]] = by_persona.get(ex["persona"], 0) + 1
        cf += 1 if ex["counterfactual"] else 0
        chars += len(inst.format_example(ex))
    total = len(examples) or 1
    return {
        "examples": len(examples),
        "category_counts": dict(sorted(by_cat.items())),
        "requested_mix_percent": requested,
        "language_counts": dict(sorted(by_lang.items())),
        "persona_counts": dict(sorted(by_persona.items())),
        "counterfactual": cf,
        "counterfactual_share": round(cf / total, 4),
        "characters": chars,
        # ESTIMATED: ~3.4 characters per token for EN/Hinglish, worse for
        # Hindi. A real count needs the trained tokenizer (P4), and this
        # number is labelled so it cannot be mistaken for one.
        "tokens_estimated": int(chars / 3.4),
        "token_estimate_method": "ESTIMATED — characters / 3.4; real count needs the P4 tokenizer",
    }


def write_jsonl(examples: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for ex in examples:
            text = inst.format_example(ex)
            row = {
                "text": text,
                "assistant_spans": inst.assistant_spans(text),
                "category": ex["category"],
                "lang": ex["lang"],
                "persona": ex["persona"],
                "counterfactual": ex["counterfactual"],
                "turns": len(ex["turns"]),
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def _readable(text: str) -> str:
    """Show a placeholder as a label a human reads at a glance.

    `<|fact:edu.lpu|>` inside a markdown table has to be escaped or it
    breaks the table, and an escaped `<\|fact:edu.lpu\|>` stops looking
    like the token it is. The label form keeps the review about the prose.
    """
    return re.sub(r"<\|\s*fact:([^|]+?)\s*\|>", r"⟨fact:\1⟩", str(text))


def write_review(examples: list[dict], path: Path, rng: random.Random, count: int) -> int:
    """~100 Hindi/Hinglish examples for a human to judge (§7.4).

    The language label is *detected on the shown answer*, not copied from
    the example's first turn — a two-turn example that starts in Hindi and
    ends in English is labelled by what is actually on the row.
    """
    pool = [e for e in examples if any(langid.label(a) != "en" for _q, a in e["turns"])]
    picked = rng.sample(pool, min(count, len(pool)))
    lines = [
        "# Stage B review sample (§7.4)",
        "",
        f"{len(picked)} randomly drawn examples whose answers are Hindi or "
        f"Hinglish, from `data/instruction/sft.jsonl`.",
        "",
        "**What to check:** does the Hindi read like a person wrote it? Is the "
        "Hinglish the way you would actually ask, or a translation of English? "
        "Anything unnatural here is a template to fix, not a model to blame — "
        "the model only learns what these templates show it.",
        "",
        "`⟨fact:…⟩` is where the app substitutes a verified value at runtime.",
        "",
        "| # | lang | category | dialogue |",
        "|---|---|---|---|",
    ]

    def cell(s: str) -> str:
        return _readable(s).replace("|", "\\|").replace("\n", "<br>")

    for i, ex in enumerate(picked, 1):
        dialogue = "<br>".join(f"**U:** {cell(q)}<br>**A:** {cell(a)}" for q, a in ex["turns"])
        last_lang = langid.label(ex["turns"][-1][1])
        lines.append(f"| {i} | {last_lang} | {ex['category']} | {dialogue} |")
    lines += [
        "",
        f"Generated by `python -m training.scripts.make_instruction_data` · "
        f"{len(picked)} of {len(pool)} examples with a non-English answer.",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return len(picked)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not 0.30 <= args.share <= 1.0:
        print(f"refusing: counterfactual share {args.share} is below §7.4's 0.30 minimum")
        return 2
    kb = inst.load_kb(args.kb)
    examples = inst.generate(kb, args.count, seed=args.seed, counterfactual_share=args.share)
    summary = summarise(examples, inst.CATEGORY_MIX)

    print(f"Stage B instruction data — {summary['examples']} examples, seed {args.seed}")
    for cat, want in inst.CATEGORY_MIX.items():
        got = summary["category_counts"].get(cat, 0)
        pct = round(got * 100 / max(1, summary["examples"]), 1)
        print(f"  {cat:<18} {got:>6}  ({pct:>5}% of {want}% asked)")
    print(f"  counterfactual     {summary['counterfactual']:>6}  "
          f"({summary['counterfactual_share'] * 100:.1f}%, §7.4 floor 30%)")
    print(f"  characters         {summary['characters']:>7,}")
    print(f"  tokens             {summary['tokens_estimated']:>7,}  ({summary['token_estimate_method']})")

    if args.dry_run:
        print("dry run — nothing written")
        return 0

    sft = args.out / "sft.jsonl"
    write_jsonl(examples, sft)
    manifest = {**summary, "seed": args.seed, "share": args.share,
                "knowledge": kb.get("meta", {}).get("version"),
                "sft_bytes": sft.stat().st_size,
                "format": "§7.4 <|sys|> <|ctx|> <|user|> <|asst|> <|end|>"}
    (args.out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    n = write_review(examples, args.review, random.Random(args.seed + 1), args.review_count)
    print(f"\n  wrote {_rel(sft)} ({manifest['sft_bytes']:,} B)")
    print(f"  wrote {_rel(args.out / 'manifest.json')}")
    print(f"  wrote {_rel(args.review)} ({n} hi/hinglish examples)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
