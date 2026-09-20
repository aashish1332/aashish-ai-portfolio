"""ai/tokenizer/fertility.py — tokens-per-word, per script (§7.2).

The vocab-size argument in §7.2 is a *trade*: embeddings are ~22 % of
parameters at 16k×512 but ~40 % at 32k. The trade is only decidable with
numbers, so this prints them: how many tokens the tokenizer spends per
word in English, Devanagari Hindi, Roman Hinglish, tech/code and raw
URLs/emails. Hindi fertility is the one that decides whether 16k is
enough, and it is the one a mostly-English seed corpus reports
pessimistically — which is exactly why P4 must re-run this on the real
Stage A corpus before the vocab is frozen.

    python -m ai.tokenizer.fertility ai/tokenizer/artifacts/seed-4k
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.tokenizer import spec  # noqa: E402

SAMPLES_PATH = Path(__file__).resolve().parent / "samples.json"

# Above this, a script is expensive enough that the vocab decision needs
# revisiting (bytes-per-token collapse ⇒ long, slow sequences in Hindi).
WARN_TOKENS_PER_WORD = 2.5


def load_samples(path: Path | str = SAMPLES_PATH) -> dict[str, list[str]]:
    return json.loads(Path(path).read_text(encoding="utf-8"))["categories"]


def measure(tokenizer, samples: dict[str, list[str]]) -> dict[str, dict]:
    """Per-category tokens/word and chars/token, plus overall totals."""
    out: dict[str, dict] = {}
    for category, lines in samples.items():
        tokens = chars = words = 0
        for line in lines:
            tokens += len(tokenizer.encode(line, add_special_tokens=False).ids)
            chars += len(line)
            words += len(line.split())
        out[category] = {
            "tokens": tokens,
            "words": words,
            "chars": chars,
            "tokens_per_word": round(tokens / words, 2) if words else 0.0,
            "chars_per_token": round(chars / tokens, 2) if tokens else 0.0,
            "warn": bool(words and tokens / words > WARN_TOKENS_PER_WORD),
        }
    return out


def report(tokenizer, vocab_size: int | None = None, stream=sys.stdout) -> dict[str, dict]:
    samples = load_samples()
    stats = measure(tokenizer, samples)
    vocab = vocab_size or tokenizer.get_vocab_size()

    print(f"  fertility (vocab {vocab:,})", file=stream)
    print(f"  {'category':<12} {'tok/word':>9} {'chars/tok':>10} {'tokens':>8}", file=stream)
    for category, s in stats.items():
        flag = "  ← over budget" if s["warn"] else ""
        print(f"  {category:<12} {s['tokens_per_word']:>9.2f} "
              f"{s['chars_per_token']:>10.2f} {s['tokens']:>8}{flag}", file=stream)
    worst = max(stats.items(), key=lambda kv: kv[1]["tokens_per_word"])
    print(f"  worst: {worst[0]} at {worst[1]['tokens_per_word']} tokens/word", file=stream)
    return stats


def main(argv: list[str] | None = None) -> int:
    from ai.tokenizer.train import load

    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        raise SystemExit("usage: python -m ai.tokenizer.fertility <artifact-dir>")
    tokenizer, meta = load(argv[0])
    print(f"{meta['tokenizer_version']}")
    report(tokenizer, meta["vocab_size"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
