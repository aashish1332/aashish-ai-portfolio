"""The answer has to follow the question, not the context.

Measured 2026-10-03 on kernel `training-stage-b`. v1 and v2 both passed their
gate — v1 drove held-out loss from 1.96 to 0.008 — and both answered hand-written
questions with a paragraph unrelated to what was asked. v2 had **2,315 distinct
questions**, so "there were not enough different questions" was already ruled out
by the previous day's work.

The cause was two lines in `make_example`:

    q = _pick(rng, t.questions[lang])   # any question about the topic
    a = t.answer(f, lang, persona)      # the topic's one canned answer

`a` never referenced `q`. Every question about the skills topic got the same list
of all three skills, so **the context alone determined the answer and the
question was redundant**. Nine topics with one fixed frame each is a lookup
table; a model reaches the right answer by pattern-matching which topic's facts
are present, and never reads what it was asked.

So the guard is not "the data is varied". It is the property that makes reading
the question unavoidable: **over one identical context, different questions must
have different correct answers.** MEASURED by
`tools/measure_answer_conditioning.py`, same seed and count:

    before:   9 distinct contexts, 9 of them (100.0%) admitted exactly one
              distinct answer — the question was entirely decorative
    after:   84 distinct contexts, 0 of them, every one admitting 3-5 answers

The second direction matters just as much. Making answers vary is only half the
fix; if a question could ask about a fact the context does not carry, the model
would be taught to answer from something it was never shown, which is the
failure §8.4 exists to prevent. Both directions are tested here.
"""

from __future__ import annotations

import collections
import importlib.util
import re
import sys
import unittest
from pathlib import Path

from ai.data import instruction as inst

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

#: Loaded by path, like `test_mutation_env` does: `tools/` is not a package.
_spec = importlib.util.spec_from_file_location(
    "measure_answer_conditioning", TOOLS / "measure_answer_conditioning.py")
measure_tool = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = measure_tool
_spec.loader.exec_module(measure_tool)

CONTEXT_FACT = re.compile(r"^\[([^\]]+)\]", re.M)
ANSWER_FACT = re.compile(r"<\|fact:([^|]+)\|>")

#: The threshold the reported figure is judged against, taken from the tool so
#: the test and the number cannot drift apart.
FLOOR = measure_tool.AMBIGUITY_FLOOR


def _kb():
    return inst.load_kb(None)


def _context_facts(example):
    return tuple(sorted(CONTEXT_FACT.findall(example["context"])))


def _answer_facts(example):
    return tuple(sorted(set(ANSWER_FACT.findall(example["turns"][0][1]))))


def _factual(kb, count=8000, seed=1337):
    return [e for e in inst.generate(kb, count, seed=seed, vary_questions=False)
            if e["category"] == "factual" and not e["counterfactual"]]


class TheAnswerDependsOnTheQuestion(unittest.TestCase):
    """The property the whole change exists to establish."""

    @classmethod
    def setUpClass(cls):
        cls.kb = _kb()
        cls.contexts, cls.distribution = measure_tool.measure(cls.kb, 8000, 1337)
        cls.by_context = collections.defaultdict(set)
        for example in _factual(cls.kb):
            cls.by_context[_context_facts(example)].add(_answer_facts(example))

    def test_almost_no_context_has_a_single_possible_answer(self):
        sizes = collections.Counter(self.distribution.values())
        single = self.distribution.get(1, 0)
        self.assertLess(
            single / self.contexts, FLOOR,
            "almost every context has exactly one distinct answer again, so "
            "the question is redundant and the model can ignore it")

    def test_most_contexts_admit_more_than_one_answer(self):
        multi = sum(n for k, n in self.distribution.items() if k > 1)
        self.assertGreater(
            multi / self.contexts, 0.80,
            "too few contexts admit a second answer for the question to be "
            "load-bearing")

    def test_a_multi_answer_context_really_carries_several_facts(self):
        # Without this, "more answers per context" could be satisfied by making
        # every context unique rather than by making the question matter.
        shared = {k: v for k, v in self.by_context.items() if len(v) > 1}
        self.assertTrue(shared, "no context carries two different answers")
        for context in shared:
            self.assertGreaterEqual(
                len(context), 2,
                "a one-fact context cannot be ambiguous about which fact is "
                "being asked about")

    def test_there_are_many_more_contexts_than_topics(self):
        # Nine topics gave nine contexts before. The multi-topic context is
        # what removes "which topic is this?" as a shortcut, so the context
        # count has to exceed the topic count by a wide margin.
        self.assertGreater(
            self.contexts, len(inst.TOPICS) * 3,
            "the context is not varying across topics, so a topic fingerprint "
            "still identifies the answer")


class EveryTargetedAnswerIsSupportedByItsContext(unittest.TestCase):
    """Varying answers is only safe if the facts asked about are shown."""

    def test_no_answer_asks_about_a_fact_the_context_omits(self):
        for example in _factual(_kb(), count=4000):
            present = set(_context_facts(example))
            asked = set(_answer_facts(example))
            self.assertTrue(
                asked <= present,
                f"answer uses {sorted(asked - present)} but the context only "
                f"carries {sorted(present)}; the model would be taught to "
                f"answer from something it was never shown")

    def test_the_targeted_fact_is_the_only_one_asked_about(self):
        # An answer that dumps several facts is the old canned answer wearing a
        # new question, and it would reintroduce the ambiguity this removes.
        for example in _factual(_kb(), count=4000):
            asked = set(_answer_facts(example))
            self.assertLessEqual(
                len(asked), 1,
                f"one answer carries {sorted(asked)}; a targeted question "
                f"should name exactly one fact")


class TheMeasurementItselfIsHonest(unittest.TestCase):
    """The tool produces the number everything above is judged against."""

    def test_the_floor_cannot_be_set_to_something_vacuous(self):
        # The test above imports `AMBIGUITY_FLOOR` so the two cannot drift.
        # The cost of importing it is that raising the floor makes the check
        # unfailable rather than wrong-looking, so the value itself is pinned.
        self.assertGreater(FLOOR, 0.0, "a zero floor accepts any data at all")
        self.assertLess(
            FLOOR, 0.5,
            "a floor this high cannot be cleared by real data, so the check "
            "always passes and proves nothing")

    def test_it_measures_grounded_examples_only(self):
        # Including counterfactual examples is not a wrong answer - measured, it
        # moves the figure from 0.0% to 1.4% and leaves the verdict alone - but
        # the reported number is the one quoted in docs, so it stays grounded.
        examples = measure_tool.grounded_factual(_kb(), 4000, 1337)
        self.assertTrue(examples, "the measurement found nothing to measure")
        self.assertFalse(
            [e for e in examples if e["counterfactual"]],
            "counterfactual examples carry a fabricated literal instead of a "
            "placeholder, so they cannot be counted by answer placeholder")

    def test_an_empty_measurement_is_not_a_pass(self):
        # `main` used to compute `single / contexts if contexts else 0.0`, so a
        # generator that produced nothing scored 0% ambiguous and printed the
        # success verdict. Measured while writing the mutations.
        self.assertEqual(
            measure_tool.measure(_kb(), 0, 1337)[0], 0,
            "a zero-count run is expected to find nothing; this is what makes "
            "the guard above necessary")
        rc = measure_tool.main(["--count", "0"])
        self.assertNotEqual(
            rc, 0,
            "a run that measured nothing returned success, so a broken filter "
            "would be reported as evidence that the question is load-bearing")

    def test_it_exits_non_zero_when_the_question_is_ignored(self):
        # The same verdict logic has to be able to fail, or a green exit code
        # says nothing.
        rc = measure_tool.main(["--count", "2000"])
        self.assertEqual(rc, 0)


class TargetedTableCoversEveryTopic(unittest.TestCase):
    """A topic with no entry would silently fall back to nothing."""

    def test_every_topic_has_targets_in_all_three_languages(self):
        for topic in inst.TOPICS:
            for lang in ("en", "hi", "hinglish"):
                self.assertIn(
                    lang, inst.TARGETS[topic.name],
                    f"{topic.name} has no {lang} targets, so a {lang} example "
                    f"would silently fall back to English")

    def test_every_target_names_a_fact_the_topic_carries(self):
        for topic in inst.TOPICS:
            for lang, pairs in inst.TARGETS[topic.name].items():
                for _question, fact_id in pairs:
                    self.assertIn(
                        fact_id, topic.context,
                        f"{topic.name}/{lang} targets {fact_id}, which the "
                        f"topic's context does not carry, so the answer is "
                        f"unsupported by construction")

    def test_every_frame_exists_in_every_language(self):
        # `_answer_about` falls back to English rather than failing, so a
        # missing frame produces an English sentence inside a Hindi answer and
        # nothing anywhere reports it.
        for topic in inst.TOPICS:
            for pairs in inst.TARGETS[topic.name].values():
                for _question, fact_id in pairs:
                    for lang in ("en", "hi", "hinglish"):
                        self.assertIn(
                            lang, inst._FRAMES[fact_id],
                            f"{fact_id} has no {lang} frame, so a {lang} "
                            f"answer would come back in English")

    def test_no_two_questions_in_a_multi_fact_topic_target_the_same_fact(self):
        # Two questions with the same target are paraphrases: surface variety
        # without making the question load-bearing.
        #
        # Only enforceable where the context holds more than one fact. Six of
        # the nine topics are single-fact and have nothing else to ask about —
        # the first version of this test failed on them. Rather than drop the
        # rule the scope is stated, and dropping a fact from one of those
        # contexts (which would silently make it single-fact) is caught here.
        for topic in inst.TOPICS:
            if len(topic.context) < 2:
                continue
            for lang, pairs in inst.TARGETS[topic.name].items():
                facts = [fact_id for _q, fact_id in pairs]
                self.assertEqual(
                    len(facts), len(set(facts)),
                    f"{topic.name}/{lang} asks twice about {facts}; a "
                    f"multi-fact topic is where the question has to "
                    f"discriminate between facts")

    def test_the_single_fact_topics_are_a_deliberate_limitation(self):
        # Stated so the claim above cannot be read as stronger than the data
        # supports. Six topics can only be asked about one way, and MEASURED
        # they still leave 0/84 contexts with a single correct answer.
        single = [t.name for t in inst.TOPICS if len(t.context) < 2]
        self.assertTrue(
            single,
            "every topic gained a second fact; revisit the framing in this "
            "file and in tools/measure_answer_conditioning.py")

    def test_targets_and_topics_have_not_drifted_apart(self):
        self.assertEqual(
            set(inst.TARGETS), {t.name for t in inst.TOPICS},
            "TARGETS and TOPICS disagree; `make_example` reads TARGETS "
            "unconditionally, so a new topic with no entry raises at "
            "generation time")


class TheRecruiterSummaryIsNotOneMemorisableShape(unittest.TestCase):
    """**A multi-fact answer is right when the question asks for one; a fixed
    multi-fact answer is right nowhere.**

    The `recruiter` branch used to emit one hard-coded four-fact frame. Over 400
    examples that produced only **2 distinct fact-shapes** — the full frame, and
    `workflow.how-he-builds` alone. A model trained on that does not learn "when
    asked to summarise, use what the context gives you"; it learns the shape, and
    then recites it on single-fact questions it was never given the facts for.

    Measured on the v3 checkpoint against the 60-case §14 suite: of 41 model
    answers, 30 named a fact the retrieved context never supplied, and the ones
    reached for were exactly this frame's — `workflow.how-he-builds` 26 times,
    `edu.lpu` 21, `project.volunteer` 19. The §8.4 guard then passed 12 of 15
    single-fact answers and **0 of 26** that carried a tail, which is why
    factual accuracy was 11.8% while held-out fact-slot accuracy was 90.8%.

    So the frame is now a sampled subset behind a varying lead-in. What has to
    stay true is that the shape is *not* recoverable: a model that can still
    memorise one answer shape will fail the same way.
    """

    #: `recruiter` is ~10% of the corpus, so 4,000 generated examples buy ~400
    #: summaries. Generating only 400 yields 40, and at that size "more than 10
    #: distinct shapes" passes by luck — the first version of this class did
    #: exactly that, and its own guard test caught it.
    GENERATE = 4000
    N = 400

    @classmethod
    def setUpClass(cls):
        kb = inst.load_kb(None)
        cls.examples = [e for e in inst.generate(kb, cls.GENERATE, seed=1234)
                        if e["category"] == "recruiter"]

    def test_there_are_examples_to_look_at(self):
        self.assertGreaterEqual(
            len(self.examples), self.N,
            f"only {len(self.examples)} recruiter examples were generated, so "
            f"the rest of this class would pass vacuously")

    def test_the_answer_shape_is_not_a_single_frame(self):
        shapes = collections.Counter(
            tuple(re.findall(r"<\|fact:([^|]+)\|>", e["turns"][0][1]))
            for e in self.examples)
        self.assertGreater(
            len(shapes), 10,
            f"only {len(shapes)} distinct answer shapes across "
            f"{len(self.examples)} recruiter examples: {shapes.most_common(4)}. "
            "A summary the model can recite is being taught again")

    def test_no_single_fact_dominates_the_summaries(self):
        counts = collections.Counter(
            fid for e in self.examples
            for fid in re.findall(r"<\|fact:([^|]+)\|>", e["turns"][0][1]))
        if not counts:
            self.skipTest("every summary is counterfactual, so ref() emits no token")
        top, n = counts.most_common(1)[0]
        self.assertLess(
            n / sum(counts.values()), 0.5,
            f"{top} appears in {n} of {sum(counts.values())} summaries; one fact "
            "ending every summary is the frame returning by another name")

    def test_every_summary_stays_inside_its_own_context(self):
        """The reason the pool is filtered before sampling.

        `build_context` drops a fact whose value is empty, so a summary that
        sampled such a fact would name something the context never carried —
        manufacturing precisely the ungrounded answer this change removes.
        """
        for e in self.examples:
            context = set(re.findall(r"\[([a-z0-9_.\-]+)\]", e["context"]))
            for fid in re.findall(r"<\|fact:([^|]+)\|>", e["turns"][0][1]):
                self.assertIn(
                    fid, context,
                    f"{e['turns'][0][1][:80]!r} cites {fid} but the context "
                    f"carries only {sorted(context)}")


if __name__ == "__main__":
    unittest.main()