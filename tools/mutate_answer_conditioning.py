"""Mutation checks for the §7.4 answer-conditioning change.

    PYTHONUTF8=1 python tools/mutate_answer_conditioning.py

Stage B v1 and v2 both fitted their data and both ignored the question. The
change that follows makes the answer follow the question, and these mutations
attack both directions it can fail in:

* **the question becomes decorative again** — one topic per context, one canned
  answer per topic, a context wide enough to identify the answer by pattern.
  This is the v1/v2 defect, reintroduced.
* **the answer starts asking about something the context does not carry** — the
  model would be taught to answer from facts it was never shown, which is the
  failure §8.4 exists to prevent and which no loss number would reveal.
"""

from __future__ import annotations

import sys
from pathlib import Path

import mutation_env

ROOT = Path(__file__).resolve().parents[1]
INSTRUCTION = ROOT / "ai" / "data" / "instruction.py"
TOOL = ROOT / "tools" / "measure_answer_conditioning.py"
SUITE = "tests.py.test_instruction_answer_conditioning."

#: (label, target file, find, replace, test target, evidence phrase)
MUTATIONS = [
    (
        "A1 back to one topic per context, so the context identifies the answer",
        INSTRUCTION,
        "        chosen = rng.sample(TOPICS, min(_FACTUAL_TOPICS, len(TOPICS)))",
        "        chosen = [_pick(rng, TOPICS)]",
        SUITE + "TheAnswerDependsOnTheQuestion."
        "test_almost_no_context_has_a_single_possible_answer",
        "the question is redundant",
    ),
    (
        # `chosen[0].context[0]` was the first attempt and is too weak: `chosen`
        # is a sample, so the same context can arise from different orderings and
        # the contexts still admit several answers. Sorting the *whole* context
        # makes the answer a function of the context alone, which is exactly the
        # v1/v2 defect.
        "A2 the answer follows the context rather than the question",
        INSTRUCTION,
        "        q, fact_id = _pick(rng, pairs)",
        "        q, fact_id = _pick(rng, pairs)\n"
        "        fact_id = sorted(ids)[0]",
        SUITE + "TheAnswerDependsOnTheQuestion."
        "test_most_contexts_admit_more_than_one_answer",
        "too few contexts admit a second answer",
    ),
    (
        # `f.ref` is what puts `<|fact:…|>` in the answer so the *browser*
        # resolves the slot against the live knowledge base. Swapping it for
        # `f.value` bakes the shipped value into the training data instead -
        # a real leak of the kind `test_factual_examples_use_placeholders_not_
        # literal_values` exists for, and nothing in this test module sees it.
        "A3 the answer bakes in the literal value instead of a placeholder",
        INSTRUCTION,
        "    return (first if persona == \"first\" else third).format(v=f.ref(fact_id))",
        "    return (first if persona == \"first\" else third).format(v=f.value(fact_id))",
        "tests.py.test_instruction.Privacy."
        "test_factual_examples_use_placeholders_not_literal_values",
        "literal",
    ),
    (
        "A4 the context drops the fact the question is about",
        INSTRUCTION,
        "        ids = list(dict.fromkeys(fid for t in chosen for fid in t.context))",
        "        ids = list(dict.fromkeys(fid for t in chosen for fid in t.context))[1:]",
        SUITE + "EveryTargetedAnswerIsSupportedByItsContext."
        "test_no_answer_asks_about_a_fact_the_context_omits",
        "answer from something it was never shown",
    ),
    (
        "A5 a targeted answer starts carrying every fact the topic holds",
        INSTRUCTION,
        "        a = _answer_about(fact_id, f, lang, persona)",
        "        a = \" \".join([_answer_about(fact_id, f, lang, persona)] "
        "+ [_answer_about(i, f, lang, persona) for i in target.context])",
        SUITE + "EveryTargetedAnswerIsSupportedByItsContext."
        "test_the_targeted_fact_is_the_only_one_asked_about",
        # From the assertion's own `msg`, not the docstring above it: an earlier
        # version used a phrase from the prose and this mutation exited 1 with
        # the phrase absent, printing as NOT CAUGHT.
        "a targeted question should name exactly one fact",
    ),
    (
        # Two mutations were tried here and only one is observable.
        #
        # Including counterfactuals moves the figure from 0.0% to 1.4% and
        # leaves the verdict alone, so `test_almost_no_context_has_a_single_
        # possible_answer` cannot see it. Filtering everything out *is* seen by
        # `test_an_empty_measurement_is_not_a_pass`, which is the guard that
        # exists precisely because `main` used to score an empty measurement as
        # a clean pass - so that version proved the guard already worked rather
        # than testing the filter.
        #
        # The observable one is the counterfactual filter itself, which the
        # quoted figure in docs/PROGRESS.md depends on.
        "A6 the measurement starts counting counterfactual examples",
        TOOL,
        'if e["category"] == "factual" and not e["counterfactual"]]',
        'if e["category"] == "factual"]',
        SUITE + "TheMeasurementItselfIsHonest."
        "test_it_measures_grounded_examples_only",
        "they cannot be counted by answer placeholder",
    ),
    (
        # The floor is the threshold the whole verdict rests on. The test
        # imports it so the two cannot drift, which also means raising it makes
        # the check unfailable rather than visibly wrong - hence its own guard.
        "A7 the ambiguity floor is raised above anything the data can reach",
        TOOL,
        "AMBIGUITY_FLOOR = 0.10",
        "AMBIGUITY_FLOOR = 1.01",
        SUITE + "TheMeasurementItselfIsHonest."
        "test_the_floor_cannot_be_set_to_something_vacuous",
        "the check always passes and proves nothing",
    ),
]


def main() -> int:
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
    print(f"{len(MUTATIONS)} mutations against the §7.4 answer-conditioning change")
    print("=" * 70)
    try:
        for label, path, find, replace, test, phrase in MUTATIONS:
            original = source_of(path)
            if find not in original:
                print(f"\nSKIP  {label}\n      anchor moved in {path.name}; "
                      f"update the mutation")
                uncaught += 1
                continue
            mutated = original.replace(find, replace, 1)
            syntax_error = mutation_env.check_parses(mutated, path)
            if syntax_error:
                print(f"\nMALFORMED  {label}\n      does not compile: "
                      f"{syntax_error}")
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