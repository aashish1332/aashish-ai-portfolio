"""How often does one identical context admit more than one correct answer?

    PYTHONUTF8=1 python tools/measure_answer_conditioning.py [count]

This is the measurement behind the §7.4 change of 2026-10-03, kept as a tool
because it is the number that decides whether the model *has* to read the
question. Stage B v1 and v2 both fitted their data to a passing gate and both
answered hand-written questions with unrelated text; v2 already had 2,315
distinct questions, so variety was not the missing ingredient. What was missing
is that every question about a topic got the topic's one canned answer:

    q = _pick(rng, t.questions[lang])   # any question about the topic
    a = t.answer(f, lang, persona)      # the topic's single canned answer

`a` never referenced `q`, so the **context alone determined the answer** and the
question was redundant. Nine topics with one fixed frame each is a lookup table.

The statistic is: group the generated examples by their context, and count how
many *different* answers each context admits. At 100% one-answer-per-context
the question is decorative and a model can ignore it completely. The lower that
number goes, the more the question has to be read.

**Counterfactual examples are excluded, and that matters.** In those,
`Facts.ref` returns a fabricated literal instead of `<|fact:…|>`, so they carry
no placeholder at all and would collapse into a single empty "answer" per
context. Including them inflated the earlier reading — the first version of this
measurement reported 1.4% ambiguous contexts with them in and the real figure is
below. Only examples whose answer is grounded in the shipped fact set are
counted, because those are the ones where the context genuinely determines what
is *available* to say.
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

from ai.data import instruction as inst  # noqa: E402

CONTEXT_FACT = re.compile(r"^\[([^\]]+)\]", re.M)
ANSWER_FACT = re.compile(r"<\|fact:([^|]+)\|>")

#: Below this fraction the generator is not forcing the model to read the
#: question. The test suite asserts the same threshold; it is stated here so a
#: reader of the number knows what it means rather than having to look it up.
AMBIGUITY_FLOOR = 0.10


def grounded_factual(kb: dict, count: int, seed: int) -> list[dict]:
    return [e for e in inst.generate(kb, count, seed=seed, vary_questions=False)
            if e["category"] == "factual" and not e["counterfactual"]]


def measure(kb: dict, count: int, seed: int) -> tuple[int, dict[int, int]]:
    by_context: dict[tuple[str, ...], set[tuple[str, ...]]] = \
        collections.defaultdict(set)
    for example in grounded_factual(kb, count, seed):
        context = tuple(sorted(CONTEXT_FACT.findall(example["context"])))
        answer = tuple(sorted(set(ANSWER_FACT.findall(example["turns"][0][1]))))
        by_context[context].add(answer)
    distribution = collections.Counter(len(v) for v in by_context.values())
    return len(by_context), dict(sorted(distribution.items()))


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--count", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=1337)
    args = ap.parse_args(argv)

    kb = inst.load_kb(None)
    contexts, distribution = measure(kb, args.count, args.seed)
    single = distribution.get(1, 0)

    # An empty measurement used to report a pass: `single / contexts` was
    # guarded with `if contexts else 0.0`, so a generator that produced nothing
    # scored 0% ambiguous and the verdict said the question selects the answer.
    # Measured while writing the mutation checks - it is the shape a broken
    # filter takes, and the number it prints is the most reassuring one
    # possible. Refuse instead.
    if not contexts:
        print(f"§7.4 answer conditioning — {args.count:,} examples, "
              f"seed {args.seed}")
        print("  distinct contexts            0")
        print("  VERDICT: no grounded factual examples were measured, so there "
              "is no evidence either way. This is not a pass.")
        return 1

    share = single / contexts

    print(f"§7.4 answer conditioning — {args.count:,} examples, seed {args.seed}")
    print(f"  topics                       {len(inst.TOPICS)}")
    print(f"  distinct contexts            {contexts}")
    print(f"  answers per identical context {distribution}")
    print(f"  question-ignoring contexts   {single}/{contexts} = {share:.1%}")
    print(f"  floor                        {AMBIGUITY_FLOOR:.0%}")
    if share > AMBIGUITY_FLOOR:
        print("  VERDICT: too many contexts have exactly one correct answer — the "
              "question is decorative and a model can ignore it.")
        return 1
    print("  VERDICT: the question selects the answer. Measured, not assumed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())