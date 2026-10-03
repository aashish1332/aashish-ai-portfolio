"""Compare a Stage B transcript's novel-prompt answers against another run.

    PYTHONUTF8=1 python tools/compare_novel_answers.py \\
        kaggle-push/out/kaggle-training-stage-b-v1.txt \\
        kaggle-push/out/kaggle-training-stage-b-stageb-v2b.txt

Stage B v1 was audited as a clean PASS while answering three unrelated
hand-written questions with one byte-identical reply. Loss and the gate both
looked healthy, because §7.4's held-out examples share templates with training
ones: the gate measures fitting, not generalisation. So "did the questions get
diverse enough for the model to condition on them" is not answerable from the
gate, and has to be read off the answers themselves.

Two numbers per run, both counted here rather than eyeballed:

* **distinct answers** - how many different replies 8 prompts produced. A model
  reciting templates answers regardless of what was asked, so this stays low.
* **fact-slot leaks** - answers containing a raw `<|fact:...|>` slot, which is
  the retrieval placeholder the browser is supposed to resolve. A leaked slot
  means the model reproduced the training template's plumbing.

Written as a script rather than a one-off because the two transcripts have to be
read the same way to be compared at all, and an ad-hoc parse of one of them is
exactly how a difference between runs gets invented.
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

#: The decoded transcript decorates every line with `[0016m11.22s] stdout `.
#:
#: MEASURED 2026-10-03: the obvious `ANSI = re.compile(r"\x1b\[[0-9;]*m")` does
#: **not** strip it, because in these files `[0016m` is literal text - there is
#: no ESC byte - so the pattern never matches and the prefix survives. The
#: bracket below is matched by form rather than by digit class for that reason.
ANSI = re.compile(r"\x1b\[[0-9;]*m")
PREFIX = re.compile(r"^\[[^\]\n]*\]\s*(?:stdout|stderr)?\s*")

QUESTION = re.compile(r"^(\w+)/(\w+)\s+(\S.*)$")
ANSWER = re.compile(r"^→\s+(.+?)\s*$")


def strip_decoration(text: str) -> list[str]:
    """Drop the transcript's own decoration, leaving what the notebook printed.

    Leading whitespace is stripped as well: `stdout` is followed by several
    spaces, and answer lines are indented further than the question lines they
    belong to.
    """
    return [PREFIX.sub("", line).strip()
            for line in ANSI.sub("", text).splitlines()]


def unquote(raw: str) -> str:
    """Undo the sampler's `repr()` so `'a'` and `"a"` compare equal."""
    try:
        value = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return raw.strip()
    return value if isinstance(value, str) else str(value)


def read_blocks_from_text(text: str) -> list[tuple[str, list[tuple[str, str]]]]:
    """One list of `question`/`answer` pairs per `── name` section.

    A transcript holds three separate samplings - Stage A, the four prompts drawn
    from the training set, and the eight novel ones - and pooling them would
    average the number that matters with two it does not. Blocks are kept apart
    so the novel-prompt block is compared on its own.

    A new `── ` header clears any question still awaiting an answer, so a
    question printed in one block cannot pick up the next block's answer.
    """
    lines = strip_decoration(text)
    blocks: list[tuple[str, list[tuple[str, str]]]] = []
    question: str | None = None
    for line in lines:
        header = line.startswith("── ")
        if header:
            name = line[2:].split()[0]
            blocks.append((name, []))
            question = None
            continue
        q = QUESTION.match(line)
        if q:
            question = q.group(3).strip()
            continue
        a = ANSWER.match(line)
        if a and question is not None and blocks:
            blocks[-1][1].append((question, unquote(a.group(1))))
            question = None
    return blocks


def read_blocks(path: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    """`read_blocks_from_text` over a file."""
    return read_blocks_from_text(
        path.read_text(encoding="utf-8", errors="replace"))


def report(label: str, pairs: list[tuple[str, str]], expect: int) -> tuple[int, int]:
    answers = [a for _, a in pairs]
    distinct = len(set(answers))
    leaks = sum(1 for a in answers if "<|fact:" in a)
    dead = sum(1 for a in answers if a.strip() in ("<|end|>", ""))
    print(f"── {label}: {len(pairs)} sampled")
    for q, a in pairs:
        print(f"     {q[:50]:52s} → {a[:64]}")
    print(f"   distinct answers      {distinct} of {len(answers)}"
          f"   (v1 baseline: {expect})")
    print(f"   <|fact:..|> leaks     {leaks} of {len(answers)}")
    print(f"   empty / bare <|end|>  {dead} of {len(answers)}")
    print()
    return distinct, leaks


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("transcript", type=Path, nargs="+")
    ap.add_argument("--block", default="stage-B",
                    help="which `── name` section to score; the last one is "
                         "the novel-prompt sampling")
    ap.add_argument("--baseline", type=int, default=5,
                    help="v1's distinct-answer count on the same 8 prompts")
    args = ap.parse_args(argv)

    scores = []
    for path in args.transcript:
        blocks = [b for b in read_blocks(path) if b[1]]
        if not blocks:
            print(f"{path.name}: no sampled answers found", file=sys.stderr)
            scores.append(None)
            continue
        named = [b for b in blocks if b[0] == args.block]
        # The novel-prompt run is the last Stage B block in the transcript.
        chosen = named[-1] if named else blocks[-1]
        scores.append(report(f"{path.name} [{chosen[0]}]", chosen[1],
                             args.baseline))

    if len(scores) >= 2 and all(s is not None for s in scores):
        first, last = scores[0], scores[-1]
        print(f"distinct answers {first[0]} → {last[0]}"
              f"  ({'better' if last[0] > first[0] else 'no improvement'}); "
              f"fact-slot leaks {first[1]} → {last[1]}")
        if last[0] <= first[0] and last[1] >= first[1]:
            print("VERDICT: no measured improvement. The question set is more "
                  "diverse, and that did not make the model condition on it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())