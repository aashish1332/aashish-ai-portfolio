"""Does the checkpoint answer with the fact the question asked about?

    PYTHONUTF8=1 python tools/eval_answer_accuracy.py \\
        --checkpoint kaggle-push/out/pull-v3/checkpoints/stage-b --n 120 --seed 999

**Why this exists.** The eight novel prompts are deliberately out of
distribution — a hand-written context, a hand-written question, neither of which
the generator ever produced. They are the right test for "does this work at
inference" and the wrong test for "did the model learn to condition on the
question", because a model could fail them for reasons that have nothing to do
with conditioning. Stage B v3 improved on them (6 distinct answers of 8, from
v2's 4) and that is worth knowing, but it is one context with eight questions
and it cannot separate "learned to read the question" from "got lucky on eight".

This measures the thing directly, on held-out data from the training
distribution: generate examples with a **seed the run never trained on**, ask
each question, and check whether the model's answer names **the same fact** the
gold answer does.

The metric is a fact-slot match, not string equality, because §7.4 trains the
model to emit `<|fact:…|>` tokens that the browser resolves against the live
knowledge base. So the correct behaviour is "emit the right slot", and string
comparison would mark a right answer wrong over a phrasing difference and a
wrong answer right over a repeated one — the exact mistake that let v1's
byte-identical answers look fine.

A model that ignores the question scores at chance here, because the question
picks the fact and the context alone does not: that is the property
`tools/measure_answer_conditioning.py` measures in the *data*, checked here in
the *model*.
"""

from __future__ import annotations

import argparse
import collections
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

FACT = re.compile(r"<\|fact:([^|]+)\|>")

#: What a model that ignored the question would score. Each `factual` context
#: carries three topics and the question picks one, so a question-ignoring model
#: is right about one context in three by luck.
CHANCE = 1.0 / 3.0


def gold_facts(example: dict) -> set[str]:
    return set(FACT.findall(example["turns"][0][1]))


def build_prompt(example: dict) -> str:
    """The runtime frame the browser builds, cut at `<|asst|>`."""
    from ai.data import instruction as inst

    parts = [inst.SYS, inst.RULES[example["persona"]], inst.CTX,
             example["context"], inst.USER, example["turns"][0][0], inst.ASST]
    return " ".join(p for p in parts if p)


def evaluate(checkpoint: Path, n: int, seed: int, category: str,
             max_tokens: int) -> dict:
    from ai.data import instruction as inst
    from inference.sample_answers import sample
    from ai.tokenizer.train import load

    kb = inst.load_kb(None)
    examples = [e for e in inst.generate(kb, max(n * 6, n), seed=seed,
                                         vary_questions=True)
                if e["category"] == category and not e["counterfactual"]]
    examples = examples[:n]
    tokenizer, meta = load(ROOT / "ai" / "tokenizer" / "artifacts" / "stage-a-16k")
    rows = [{"prompt": build_prompt(e), "category": e["category"],
             "lang": e["lang"], "persona": e["persona"],
             "question": e["turns"][0][0]} for e in examples]
    gold = [gold_facts(e) for e in examples]

    generated = sample(checkpoint, "latest", rows, tokenizer, max_tokens)
    hit = empty = leaked_other = 0
    for row, want in zip(generated, gold):
        got = set(FACT.findall(row["answer"]))
        if want & got:
            hit += 1
        elif not got:
            empty += 1
        else:
            leaked_other += 1
    total = len(generated) or 1
    return {"n": total, "hit": hit, "empty": empty, "wrong_slot": leaked_other,
            "accuracy": hit / total}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--n", type=int, default=120)
    ap.add_argument("--seed", type=int, default=999,
                    help="a seed the run never trained on")
    ap.add_argument("--category", default="factual")
    ap.add_argument("--tokens", type=int, default=40)
    args = ap.parse_args(argv)

    r = evaluate(args.checkpoint, args.n, args.seed, args.category, args.tokens)
    print(f"held-out answer accuracy — {args.checkpoint}")
    print(f"  seed {args.seed} (unseen), category {args.category}")
    print(f"  n                    {r['n']}")
    print(f"  correct fact slot    {r['hit']}/{r['n']} = {r['accuracy']:.1%}")
    print(f"  no slot at all       {r['empty']}/{r['n']}")
    print(f"  a different slot     {r['wrong_slot']}/{r['n']}")
    print(f"  chance if the question is ignored  {CHANCE:.1%}")
    if r["accuracy"] <= CHANCE:
        print("  VERDICT: no better than ignoring the question.")
        return 1
    print("  VERDICT: the model answers with the fact the question named.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())