"""Mutation checks for the §7.4 question-variety change.

    PYTHONUTF8=1 python tools/mutate_question_variety.py

`ASK_FORMS` exists because kernel `training-stage-b` v1 drew 40,000 examples
from 106 distinct question strings and produced a model that answered three
unrelated questions with one byte-identical reply. The mutations below aim at
the two failure directions: the variety stops working, and the variety starts
changing something it must not.

The second is the dangerous one. If wrapping moved inside `make_example`, or
landed before the answer was computed, the model would be taught several
different "correct" answers to the same question — and the category mix, the
gate and the manifest would all still look entirely normal.

Two things this runner learned the hard way, both kept as comments on the
mutations that exposed them:

* Q5 replaced only the *first* line of a two-line statement while supplying a
  continuation of its own, leaving the original continuation beneath it. The
  mutated module raised `IndentationError` on import, so the guard under test
  never ran — yet the mutation still exited non-zero. Every runner keying on
  the exit code alone would have scored it caught.
* Q8 therefore mutates `tools/mutation_env.py`, not `ai/data/instruction.py`.
  That needs a per-mutation target file, which is why `MUTATIONS` carries one.
"""

from __future__ import annotations

import sys
from pathlib import Path

import mutation_env

ROOT = Path(__file__).resolve().parents[1]
INSTRUCTION = ROOT / "ai" / "data" / "instruction.py"
MUTATION_ENV = ROOT / "tools" / "mutation_env.py"
SUITE = "tests.py.test_instruction_question_variety."

#: (label, target file, find, replace, test target, evidence phrase)
MUTATIONS = [
    (
        "Q1 variety stops being applied at all",
        INSTRUCTION,
        "    if vary_questions:",
        "    if False:",
        SUITE + "VarietyWidensTheQuestionSet."
        "test_it_raises_the_number_of_distinct_questions_a_lot",
        "distinct questions only went",
    ),
    (
        "Q2 every question gets the same carrier form",
        INSTRUCTION,
        "    form = _pick(rng, forms)",
        "    form = forms[0]",
        SUITE + "VarietyWidensTheQuestionSet."
        "test_it_lowers_the_mean_repetitions",
        "mean_repetitions",
    ),
    (
        "Q3 greetings get wrapped too",
        INSTRUCTION,
        "_UNVARYED = frozenset({\"greeting\"})",
        "_UNVARYED = frozenset()",
        SUITE + "VarietyWidensTheQuestionSet."
        "test_a_greeting_is_not_buried_in_a_carrier_form",
        "the greeting category no longer teaches greetings",
    ),
    (
        "Q4 the answer starts depending on the carrier form",
        INSTRUCTION,
        "            ex[\"turns\"] = [(vary_question(q, ex.get(\"lang\", \"en\"), rng), a)",
        "            ex[\"turns\"] = [(vary_question(q, ex.get(\"lang\", \"en\"), rng), a.upper())",
        SUITE + "VarietyChangesNoAnswer."
        "test_the_answers_and_contexts_are_identical",
        "several correct answers",
    ),
    (
        # The anchor is the whole two-line statement, not just its first line.
        # The first version anchored on the opening line and supplied its own
        # continuation, which left the original continuation in place below it:
        # `IndentationError` on import, no behavioural change, and a guard that
        # was never run. `check_parses` would now say so instead of guessing.
        "Q5 the context starts depending on the carrier form",
        INSTRUCTION,
        "            ex[\"turns\"] = [(vary_question(q, ex.get(\"lang\", \"en\"), rng), a)\n"
        "                           for q, a in ex[\"turns\"]]",
        "            ex[\"context\"] = ex[\"context\"].upper()\n"
        "            ex[\"turns\"] = [(vary_question(q, ex.get(\"lang\", \"en\"), rng), a)\n"
        "                           for q, a in ex[\"turns\"]]",
        SUITE + "VarietyChangesNoAnswer."
        "test_the_answers_and_contexts_are_identical",
        "different context depending",
    ),
    (
        # The first attempt at this seeded the module-level `random`, which
        # `generate` never uses - it threads a local `random.Random(seed)`
        # through everything - so the mutation changed nothing at all and the
        # runner had nothing to catch. Fixed at the seed it actually reads.
        "Q6 the run's own seed stops driving the variety",
        INSTRUCTION,
        "    rng = random.Random(seed)\n    plan = category_plan(count)",
        "    rng = random.Random(1337)\n    plan = category_plan(count)",
        SUITE + "VarietyIsReproducible."
        "test_a_different_seed_gives_a_different_set",
        "the variety is",
    ),
    (
        "Q7 distinct_questions stops counting what it claims to",
        INSTRUCTION,
        "    return len({q for ex in examples for q, _ in ex.get(\"turns\", [])})",
        "    return len(examples)",
        SUITE + "VarietyWidensTheQuestionSet."
        "test_it_raises_the_number_of_distinct_questions_a_lot",
        "distinct questions only went",
    ),
    (
        # `check_parses` is what would have caught Q5, so it needs its own
        # mutation: without this one the runner could call `check_parses` on a
        # malformed mutation, ignore the answer, and still report 7/7 — the
        # guard and the check for the guard failing in the same way.
        #
        # The replacement makes `compile` unreachable inside the `try`, so the
        # mutant returns None for every input.
        "Q8 check_parses stops noticing a mutation that won't parse",
        MUTATION_ENV,
        "    try:\n        compile(source, str(path), \"exec\")",
        "    if True:\n        return None\n    try:\n        compile(source, str(path), \"exec\")",
        "tests.py.test_mutation_env.CheckParsesRejectsTheQ5Shape."
        "test_a_repeated_continuation_line_is_reported",
        "doubled continuation line was accepted",
    ),
]


def main() -> int:
    # One original per touched file, so a crash mid-run still restores exactly
    # what was there. Only the files a mutation actually writes are cached.
    originals: dict[Path, str] = {}

    def source_of(path: Path) -> str:
        if path not in originals:
            originals[path] = path.read_text(encoding="utf-8")
        return originals[path]

    def restore(path: Path) -> None:
        if path in originals:
            path.write_text(originals[path], encoding="utf-8", newline="")

    mutation_env.clear_bytecode_caches()
    caught = uncaught = 0
    print(f"{len(MUTATIONS)} mutations against the §7.4 question-variety change")
    print("=" * 70)
    try:
        for label, path, find, replace, test, phrase in MUTATIONS:
            original = source_of(path)
            if find not in original:
                print(f"\nSKIP  {label}\n      anchor moved in "
                      f"{path.relative_to(ROOT)}; update the mutation")
                uncaught += 1
                continue
            mutated = original.replace(find, replace, 1)
            syntax_error = mutation_env.check_parses(mutated, path)
            if syntax_error:
                print(f"\nMALFORMED  {label}\n      the mutation does not "
                      f"compile: {syntax_error}\n      nothing was tested")
                uncaught += 1
                continue
            path.write_text(mutated, encoding="utf-8", newline="")
            try:
                code, combined = mutation_env.run_test(test)
            finally:
                restore(path)
            name = test.rsplit(".", 1)[-1]
            if code != 0 and name in combined and phrase in combined:
                print(f"\nCAUGHT    {label}\n      target: {name}")
                caught += 1
            else:
                print(f"\nNOT CAUGHT  {label}\n      target: {name} (exit {code}, "
                      f"phrase {phrase!r} "
                      f"{'present' if phrase in combined else 'absent'})")
                uncaught += 1
    finally:
        for path in list(originals):
            restore(path)

    print("\n" + "=" * 70)
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print("=" * 70)
    return 0 if uncaught == 0 else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())