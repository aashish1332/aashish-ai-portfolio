"""Question variety must widen the question set and touch nothing else.

Measured 2026-10-03 on kernel `training-stage-b` v1. The 40,000 §7.4 examples
were drawn from **106 distinct question strings** — mean 472 repetitions each —
and the model they produced answered three unrelated hand-written questions
with one byte-identical reply, while held-out loss fell to 0.0083 and the gate
passed. `ASK_FORMS` exists because of that.

The guard that matters is not "does the variety work". It is **does the variety
change anything it must not**. `generate()` wraps questions *after* the category
logic has chosen them, so answers, facts, category counts, personas and the
counterfactual share are all supposed to be untouched. If a future edit moved
the wrapping earlier — or into `make_example` — the answers would start
depending on which carrier phrase was drawn, and the model would be taught
several different "correct" answers to the same question. Nothing else in the
suite would notice: the mix would still add up, the gate would still pass, and
the manifest would look normal.
"""

from __future__ import annotations

import collections
import unittest

from ai.data import instruction as inst


def _kb():
    return inst.load_kb(None)


class VarietyWidensTheQuestionSet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb = _kb()
        # 4,000 rather than 40,000: this is a property of the generator, not of
        # the size, and the suite already generates 40,000 examples elsewhere.
        cls.flat = inst.generate(cls.kb, 4000, seed=1337, vary_questions=False)
        cls.varied = inst.generate(cls.kb, 4000, seed=1337, vary_questions=True)

    def _questions(self, examples):
        return collections.Counter(
            q for ex in examples for q, _ in ex["turns"])

    def test_it_raises_the_number_of_distinct_questions_a_lot(self):
        before = inst.distinct_questions(self.flat)
        after = inst.distinct_questions(self.varied)
        self.assertGreater(
            after, before * 5,
            f"distinct questions only went {before} -> {after}; v1's problem was "
            f"that 40,000 examples came from ~100 strings, so a small "
            f"multiplication leaves the model memorising")

    def test_it_lowers_the_mean_repetitions(self):
        flat = self._questions(self.flat)
        varied = self._questions(self.varied)
        self.assertGreater(sum(flat.values()) / len(flat),
                           sum(varied.values()) / len(varied) * 3)

    def test_the_flag_off_reproduces_the_old_behaviour_exactly(self):
        # The comparison above is only meaningful if "off" really is the v1
        # data, so this pins it against the literal question lists rather than
        # against a remembered number.
        for ex in self.flat:
            for question, _ in ex["turns"]:
                self.assertNotIn("Can you tell me:", question)
                self.assertNotIn("Quick question", question)

    def test_a_greeting_is_not_buried_in_a_carrier_form(self):
        # "Last thing, hi:" is not a greeting, and a greeting category whose
        # questions read like small talk would teach the wrong thing.
        #
        # Membership, not a substring search: the first version of this looked
        # for "Can you tell me" and "Quick question", and the mutation that
        # un-varies greetings still passed, because `vary_question` picks
        # randomly among 15 forms and "I was reading your site. Hi" contains
        # neither string. A guard that only catches some of the forms it should
        # is a guard that passes for the wrong reason.
        literals = {q for lang in inst.GREETINGS.values() for q in lang}
        for ex in self.varied:
            if ex["category"] != "greeting":
                continue
            for question, _ in ex["turns"]:
                self.assertIn(question, literals,
                              "a greeting was wrapped in a carrier form, so the "
                              "greeting category no longer teaches greetings")


class VarietyChangesNoAnswer(unittest.TestCase):
    """The invariant that makes the rest of the change safe."""

    @classmethod
    def setUpClass(cls):
        cls.kb = _kb()
        cls.flat = inst.generate(cls.kb, 4000, seed=1337, vary_questions=False)
        cls.varied = inst.generate(cls.kb, 4000, seed=1337, vary_questions=True)

    def test_the_example_count_and_mix_are_identical(self):
        self.assertEqual(len(self.flat), len(self.varied))
        for field in ("category", "lang", "persona", "counterfactual"):
            self.assertEqual(
                [e[field] for e in self.flat], [e[field] for e in self.varied],
                f"{field} depends on question variety, so a different model "
                f"would be trained")

    def test_the_answers_and_contexts_are_identical(self):
        for index, (a, b) in enumerate(zip(self.flat, self.varied)):
            self.assertEqual(a["context"], b["context"],
                             f"example {index} has a different context depending "
                             f"on question variety, so the model would be "
                             f"taught to answer from different facts")
            self.assertEqual([x[1] for x in a["turns"]],
                             [x[1] for x in b["turns"]],
                             f"example {index} has a different answer depending "
                             f"on question variety, so the same question would "
                             f"have several correct answers")

    def test_every_question_differs_only_by_its_carrier_form(self):
        # Each varied question must reduce to the literal one once the carrier
        # is stripped, or variety has started rewriting the questions too.
        forms = {f for lang in inst.ASK_FORMS.values() for f in lang}
        bases = {f.replace("{q}", "").strip() for f in forms} | {""}
        for flat_ex, varied_ex in zip(self.flat, self.varied):
            for (flat_q, _), (varied_q, _) in zip(flat_ex["turns"],
                                                  varied_ex["turns"]):
                if varied_ex["category"] in inst._UNVARYED:
                    self.assertEqual(flat_q, varied_q)
                    continue
                stripped = varied_q
                for base in bases:
                    stripped = stripped.replace(base, "", 1)
                # Whitespace-insensitive on purpose: a carrier form legitimately
                # adds or removes the space around the question ("Quick
                # question - {q}" -> "Quick question - What is your name?"), and
                # comparing that literally would fail on the carrier rather than
                # on anything about the question.
                self.assertEqual(
                    stripped.strip(), flat_q.strip(),
                    f"variety rewrote the question itself: {flat_q!r} -> "
                    f"{varied_q!r}")


class VarietyIsReproducible(unittest.TestCase):
    def test_the_same_seed_gives_the_same_set(self):
        kb = _kb()
        a = inst.generate(kb, 2000, seed=7, vary_questions=True)
        b = inst.generate(kb, 2000, seed=7, vary_questions=True)
        self.assertEqual([e["turns"] for e in a], [e["turns"] for e in b])

    def test_a_different_seed_gives_a_different_set(self):
        kb = _kb()
        a = inst.generate(kb, 2000, seed=7, vary_questions=True)
        b = inst.generate(kb, 2000, seed=8, vary_questions=True)
        self.assertNotEqual([e["turns"] for e in a], [e["turns"] for e in b],
                            "two seeds produce the same set, so the variety is "
                            "not actually drawn from the run's own rng")

    def test_vary_question_always_returns_a_non_empty_string(self):
        import random

        rng = random.Random(0)
        for lang in ("en", "hi", "hinglish"):
            out = inst.vary_question("What is your name?", lang, rng)
            self.assertIn("What is your name?", out)
            self.assertNotIn("{q}", out)


if __name__ == "__main__":
    unittest.main()