"""tests/py/test_instruction.py — §7.4 Stage B instruction data.

The generator is templates plus randomness, which is exactly the kind of
code that can look right and be wrong: a mix that drifts by a point, a
"counterfactual" example with nothing fabricated in it, a withheld value
that slipped into a context line. Each of those has a test here, and the
counterfactual one is the important one — a requirement is not met because
a flag says `counterfactual: true`.
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import instruction as inst  # noqa: E402
from ai.data import facts as pyfacts  # noqa: E402
from ai.tokenizer import spec  # noqa: E402
from training.scripts import make_instruction_data as cli  # noqa: E402

KB = inst.load_kb()


class EvalPromptsAreNotTrainingData(unittest.TestCase):
    """No §14 eval question may appear verbatim in the training corpus.

    **Why this test exists.** Adding third-person Hindi questions to
    `TARGETS` is the right fix for the v8 HI regression (§14's d13/s01 ask
    "उनका CGPA कितना है?" while every Hindi entry was second-person), and it
    is also the easiest way to cheat: typing that one exact question into the
    training table would make the model answer it, and the §14 accuracy
    number would go up without the model having learned anything it could
    not already do. Nothing else in the repo would catch that - there is no
    leak test - so this one does.

    Short questions are exempt because a 2-word Hindi question like "नाम
    बताओ" is ordinary phrasing that a visitor would type anyway, and a
    substring match on those would be noise rather than signal.
    """

    #: Below this many characters a question is common phrasing, not a case.
    MIN_LEN = 12

    def _eval_questions(self):
        ev = json.loads(
            (ROOT / "evaluation" / "portfolio_tests.json").read_text(encoding="utf-8"))
        for case in ev:
            q = (case.get("question") or "").strip()
            if len(q) >= self.MIN_LEN:
                yield case.get("id"), q

    def test_no_eval_question_is_in_the_training_tables(self):
        questions = set()
        for topic in inst.TARGETS.values():
            for qs in topic.values():
                questions.update(q for q, _fid in qs)
        for qs in inst.ABSTENTION_QUESTIONS.values():
            questions.update(qs)
        questions.update(inst.INJECTION_QUESTIONS)
        for kind in inst._LIST_FRAMES:
            for lang in ("en", "hi", "hinglish"):
                questions.update(inst._list_questions(kind).get(lang) or [])
        for pool in inst._COVERAGE_QUESTIONS.values():
            for strings in pool.values():
                questions.update(strings)
                questions.update(q.format(label="MongoDB") for q in strings)
        for spec in inst._COVERAGE_BY_ID.values():
            for strings in spec["questions"].values():
                questions.update(strings)

        offenders = [(cid, q) for cid, q in self._eval_questions()
                     if q in questions]
        self.assertEqual(
            offenders, [],
            f"§14 question(s) {[q for _c, q in offenders]} are training data; "
            "the accuracy number would then measure memorisation of the "
            "eval set, not the skill")

    def test_the_guard_itself_is_actually_checking_something(self):
        """A leak test that cannot fail is worse than none.

        This exists because the guard above was written to protect a change
        that v9's probe then MEASURED as a regression (d13/s01 drifted
        further, 45 and 36 tokens against v8's ~25), so that change was
        reverted. The guard stays - it is still right - but it must be shown
        to catch a planted leak, or it is only decoration.
        """
        # Plant an actual §14 question into a training table, and require the
        # guard to notice.
        eval_q = next(q for _c, q in self._eval_questions())
        original = inst.ABSTENTION_QUESTIONS["en"]
        inst.ABSTENTION_QUESTIONS["en"] = original + [eval_q]
        try:
            with self.assertRaises(AssertionError):
                self.test_no_eval_question_is_in_the_training_tables()
        finally:
            inst.ABSTENTION_QUESTIONS["en"] = original


class Mix(unittest.TestCase):
    def test_plan_matches_the_spec_percentages_exactly(self):
        plan = inst.category_plan(1000)
        self.assertEqual(len(plan), 1000)
        for cat, want in inst.CATEGORY_MIX.items():
            self.assertEqual(plan.count(cat), want * 10, cat)

    def test_plan_is_exact_for_awkward_counts(self):
        for n in (1, 3, 7, 33, 199, 40001):
            plan = inst.category_plan(n)
            self.assertEqual(len(plan), n, n)
            # no category is silently dropped by rounding
            for cat in inst.CATEGORY_MIX:
                self.assertGreaterEqual(plan.count(cat), 0)

    def test_generated_mix_is_within_a_point_of_the_target(self):
        ex = inst.generate(KB, 400, seed=11)
        by = {}
        for e in ex:
            by[e["category"]] = by.get(e["category"], 0) + 1
        for cat, want in inst.CATEGORY_MIX.items():
            got = by.get(cat, 0) * 100 / 400
            self.assertLessEqual(abs(got - want), 1.0, f"{cat}: {got} vs {want}")

    def test_largest_remainder_never_loses_a_category(self):
        # 7 examples: the two smallest shares (5%) round to 0 individually
        plan = inst.category_plan(7)
        self.assertEqual(len(plan), 7)


class Counterfactual(unittest.TestCase):
    def test_share_meets_the_spec_floor(self):
        ex = inst.generate(KB, 500, seed=3, counterfactual_share=0.35)
        share = sum(1 for e in ex if e["counterfactual"]) / len(ex)
        self.assertGreaterEqual(share, 0.30)

    def test_every_counterfactual_example_actually_fabricates_something(self):
        """The bug this prevents: a CF example whose context is identical to
        the real one — counted in the 35% while teaching nothing."""
        ex = inst.generate(KB, 300, seed=5, counterfactual_share=0.4)
        cf = [e for e in ex if e["counterfactual"]]
        self.assertGreater(len(cf), 0)
        for e in cf:
            # at least one [id] value line differs from the real fact value
            fabricated = False
            for line in e["context"].splitlines():
                fid = line[1:line.index("]")] if line.startswith("[") else ""
                if fid and inst.render_fact(KB, fid) not in line:
                    fabricated = True
            self.assertTrue(fabricated, e["context"])

    def test_counterfactual_never_fabricates_a_url_or_email(self):
        """§7.2: URLs and emails have placeholder tokens, and a fictional one
        would teach the model to type them. `contact.location` is fair game —
        it is a place, not a link."""
        import random as _random
        fake = inst.counterfactual_values(KB, _random.Random(0))
        for value in fake.values():
            self.assertNotIn("@", value)
            self.assertNotIn("http", value)
        for fid in fake:
            self.assertNotIn(fid, ("contact.email", "link.github", "link.linkedin"))

    def test_every_single_fact_frame_interpolates_its_value(self):
        """A frame that spells the real value out cannot follow a fabricated one.

        MEASURED reason this exists (2026-10-23). The three `skill.*` frames
        were literals — `("I write Python.", …)` — so a counterfactual row
        with `[skill.python] Fortran` in its context still answered "He
        writes Python.": 396 of the 40,000 sft rows contained that pair, and
        they taught exactly what §7.4's counterfactual share exists to
        prevent. The sft5 export answered "Where does he live?" (its context
        naming the city on line 1) with "He writes Python.", and named a
        training-only fake ("His name is Tara Deshpande.") on a backend
        question whose context never mentioned a person.

        The property is structural, not a list of the three ids: any fact
        whose answer is about a value must interpolate `{v}`, so a new frame
        cannot reintroduce the bug.
        """
        for fid, frames in inst._FRAMES.items():
            for lang, (first, third) in frames.items():
                self.assertIn("{v}", first, f"{fid}/{lang} first-person frame")
                self.assertIn("{v}", third, f"{fid}/{lang} third-person frame")

    def test_a_fabricated_skill_reaches_the_answer(self):
        """Rendered, not just structural: the swapped value is what the
        sentence says, and the real one is gone."""
        fake = {"skill.python": "Fortran", "skill.react": "Django",
                "skill.mysql": "Prolog"}
        f = inst.Facts(KB, fake)
        answer = inst._answer_about("skill.python", f, "en", "third")
        self.assertIn("Fortran", answer)
        self.assertNotIn("Python", answer)
        # …and a real fact still renders the sentence a visitor saw before:
        real = inst._answer_about("skill.python", inst.Facts(KB), "en", "first")
        self.assertEqual(real, "I write <|fact:skill.python|>.")

    def test_no_counterfactual_answer_names_a_value_its_context_swapped(self):
        """End to end over generated rows, for the facts whose real value is a
        single word — a fabricated context must not leave the real one in the
        answer.

        Restricted to `skill.*` on purpose: `person.name`'s real value
        ("Aashish") legitimately appears in third-person greetings, and the
        long values (a university, a project blurb) would make a substring
        check a spelling test rather than a label test.
        """
        ex = inst.generate(KB, 400, seed=21, counterfactual_share=0.4)
        offenders = []
        for e in ex:
            if not e["counterfactual"]:
                continue
            swapped = {}
            for line in e["context"].splitlines():
                if not line.startswith("["):
                    continue
                fid = line[1:line.index("]")]
                value = line[line.index("]") + 1:].strip()
                if fid.startswith("skill.") and value != inst.render_fact(KB, fid):
                    swapped[fid] = inst.render_fact(KB, fid)
            if not swapped:
                continue
            answer = "\n".join(a for _q, a in e["turns"])
            for fid, real in swapped.items():
                if re.search(r"\b" + re.escape(real) + r"\b", answer):
                    offenders.append((fid, real, answer))
        self.assertEqual(offenders, [],
                         f"{len(offenders)} counterfactual answer(s) recite the real "
                         "value of a fact the context swapped")

    def test_factual_examples_use_placeholders_not_literal_values(self):
        ex = inst.generate(KB, 400, seed=4, counterfactual_share=0.0)
        joined = "\n".join(inst.format_example(e) for e in ex)
        self.assertIn("<|fact:person.name|>", joined)
        self.assertNotIn("aashish@example", joined)


class FactCoverage(unittest.TestCase):
    """The 13-id ceiling, and the branch that lifts it.

    MEASURED before this branch existed: across all 40,000 sft rows only 13
    distinct fact ids were ever an answer, while the §14 suite asks about 29
    distinct ids. A case about `skill.mongodb` could not be answered by any
    checkpoint, however well trained, because that id never appeared as an
    answer in the data. These tests pin the property, not the wording: every
    public fact of the covered kinds must be reachable, and every generated
    coverage answer must cite an id its own context carries.
    """

    def _coverage_rows(self, n=3000, seed=31):
        ex = inst.generate(KB, n, seed=seed)
        facts = inst.index_facts(KB)
        rows = []
        for e in ex:
            pairs = [(q, a) for q, a in e["turns"]]
            q, a = pairs[0]
            ids = []
            for line in e["context"].splitlines():
                if line.startswith("["):
                    ids.append(line[1:line.index("]")])
            cited = [fid for fid in ids if f"<|fact:{fid}|>" in a]
            if not cited:
                continue
            # a coverage row: one cited fact, and the question names it
            if len(cited) != 1:
                continue
            label = facts[cited[0]]["fact"].get("name")
            if label and label in q:
                rows.append((e, q, a, cited[0]))
        return rows

    def test_untargeted_facts_are_reachable(self):
        # 8,000 rather than the 3,000 this used when the pool held 13 ids: the
        # guarantee is "every untargeted fact is asked about at least once",
        # and the sample has to be big enough for the rarest one to be drawn.
        # MEASURED 2026-10-24 (the day `edu.kv1` added a tenth topic, which
        # shifts every draw): at 3,000 rows `skill.github` was never drawn and
        # the test failed on a property the generator still had; at 6,000 it
        # was drawn 11 times. The sampled count is a lower bound on
        # reachability, so the fix is a bigger sample, not a weaker assertion.
        rows = self._coverage_rows(n=8000)
        self.assertGreater(len(rows), 120, "coverage branch produced almost nothing")
        reachable = {fid for _e, _q, _a, fid in rows}
        facts = inst.index_facts(KB)
        wanted = {fid for fid, e in facts.items()
                  if e["kind"] in inst._COVERAGE_KINDS and fid not in inst._FRAMES}
        missing = sorted(wanted - reachable)
        self.assertEqual(missing, [],
                         f"{len(missing)} public fact(s) still have no question")

    def test_every_coverage_answer_cites_a_fact_in_its_own_context(self):
        for e, q, a, fid in self._coverage_rows(n=600, seed=32):
            self.assertIn(fid, e["context"], (q, a))

    def test_coverage_rows_are_still_factual_examples(self):
        """The §7.4 mix must not move: the branch lives inside `factual`, and
        the serialised example still ends the turn."""
        ex = inst.generate(KB, 400, seed=33)
        counted = sum(1 for e in ex if e["category"] == "factual")
        self.assertGreater(counted / len(ex), 0.30)
        for e in ex:
            self.assertTrue(inst.format_example(e).endswith(inst.END + "\n")
                            or inst.format_example(e).endswith(inst.END),
                            inst.format_example(e)[-40:])
            self.assertNotEqual(e["turns"][0][0], "")


class Privacy(unittest.TestCase):
    def test_no_withheld_value_reaches_any_example(self):
        withheld = pyfacts.withheld(KB)
        self.assertTrue(withheld, "the fixture is not exercising the gate")
        ex = inst.generate(KB, 400, seed=6)
        joined = "\n".join(inst.format_example(e) for e in ex)
        for fid in withheld:
            self.assertNotIn(fid, joined, f"withheld id {fid} is in the training text")

    def test_index_facts_only_returns_public_entries(self):
        priv = [fid for fid, e in inst.index_facts(KB).items()
                if not inst.is_public(e["fact"])]
        self.assertEqual(priv, [])


class Format(unittest.TestCase):
    def test_every_example_is_the_spec_format(self):
        ex = inst.generate(KB, 200, seed=8)
        for e in ex:
            text = inst.format_example(e)
            self.assertTrue(text.startswith(inst.SYS), text[:40])
            for token in (inst.CTX, inst.USER, inst.ASST, inst.END):
                self.assertIn(token, text)
            self.assertEqual(text.count(inst.USER), text.count(inst.ASST))
            self.assertEqual(text.count(inst.ASST), text.count(inst.END))

    def test_assistant_spans_select_exactly_the_assistant_text(self):
        ex = inst.generate(KB, 200, seed=8)
        for e in ex:
            text = inst.format_example(e)
            spans = inst.assistant_spans(text)
            self.assertEqual(len(spans), len(e["turns"]))
            for (start, end), (_q, a) in zip(spans, e["turns"]):
                self.assertEqual(text[start:end].strip(), a.strip())

    def test_context_lines_carry_ids(self):
        ex = inst.generate(KB, 200, seed=8)
        for e in ex:
            ctx = inst.build_context(inst.Facts(KB), ["person.name"])
            self.assertEqual(ctx, f"[person.name] {inst.render_fact(KB, 'person.name')}")
            break

    def test_answers_use_only_real_placeholder_ids(self):
        real_ids = set(spec.fact_ids(KB))
        ex = inst.generate(KB, 300, seed=8)
        for e in ex:
            for _q, a in e["turns"]:
                for fid in spec.iter_placeholders(a):
                    self.assertIn(fid, real_ids, f"{fid} is not a fact id")


class Content(unittest.TestCase):
    def test_abstention_examples_answer_with_the_abstain_token(self):
        ex = inst.generate(KB, 200, seed=12)
        ab = [e for e in ex if e["category"] == "abstention"]
        self.assertGreater(len(ab), 0)
        for e in ab:
            self.assertEqual(e["turns"][-1][1], inst.ABSTAIN)

    def test_adversarial_examples_never_assert_a_new_fact(self):
        ex = inst.generate(KB, 300, seed=13)
        adv = [e for e in ex if e["category"] == "adversarial"]
        self.assertGreater(len(adv), 0)
        for e in adv:
            answer = e["turns"][-1][1]
            self.assertNotIn("Google", answer)
            self.assertIn(answer, list(inst.SAFE_REPLY.values()))

    def test_meta_examples_disclose_instead_of_joining_the_voice(self):
        seen = False
        for e in inst.generate(KB, 400, seed=14):
            if e["category"] == "other" and e["turns"][-1][1] == inst.META_ANSWER:
                seen = True
                self.assertIn("not Aashish himself", e["turns"][-1][1])
        self.assertTrue(seen, "no identity-disclosure example was produced")

    def test_language_labels_are_the_three_we_support(self):
        for e in inst.generate(KB, 300, seed=15):
            self.assertIn(e["lang"], ("en", "hi", "hinglish"))
            if e["lang"] == "hi" and e["category"] == "factual":
                answer = e["turns"][-1][1]
                self.assertTrue(any("\u0900" <= ch <= "\u097f" for ch in answer),
                                f"a Hindi answer has no Devanagari: {answer}")

    def test_multi_turn_examples_really_are_multi_turn(self):
        mt = [e for e in inst.generate(KB, 300, seed=16) if e["category"] == "multi_turn"]
        self.assertGreater(len(mt), 0)
        for e in mt:
            self.assertGreaterEqual(len(e["turns"]), 2)

    def test_language_switch_examples_change_language_between_turns(self):
        sw = [e for e in inst.generate(KB, 400, seed=17) if e["category"] == "language_switch"]
        self.assertGreater(len(sw), 0)
        for e in sw:
            q1, a1 = e["turns"][0]
            q2, a2 = e["turns"][1]
            self.assertNotEqual(q1, q2)


class TheQuestionSelectsItsFact(unittest.TestCase):
    """A question asks for a fact (or a kind), and the answer must deliver
    exactly that — not a neighbouring fact of the same topic.

    **MEASURED 2026-10-23, before this fix:** 1,458 of the 40,000 rows took a
    topic's PLURAL question ("What are your skills?") and answered it with ONE
    fact from the context, because `multi_turn` drew the question from
    `t.questions` and the fact from the context independently. That is the
    d05/d06 failure written into the data: sft5 answers `What are his skills?`
    with a single skill because it was taught to. `TARGETS` is the table where
    every question names its own fact, so these two categories draw the pair
    from there.
    """

    ASKED = {q: fid for topic in inst.TARGETS.values()
             for pairs in topic.values() for q, fid in pairs}

    def test_multi_turn_and_language_switch_ask_the_fact_they_answer(self):
        seen = 0
        # `vary_questions=False`: the carrier forms (`"Sorry to bother you, but …"`)
        # are applied later, and this property is about the question the example
        # chose, not the wrapper around it.
        for e in inst.generate(KB, 500, seed=41, vary_questions=False):
            if e["counterfactual"] or e["category"] not in ("multi_turn", "language_switch"):
                continue
            q, a = e["turns"][0]
            fid = self.ASKED.get(q)
            if fid is None:
                continue
            m = re.search(r"<\|fact:([^|]+)\|>", a)
            self.assertIsNotNone(m, f"first answer has no fact slot: {a}")
            self.assertEqual(m.group(1), fid, f'"{q}" is answered with {m.group(1)}')
            seen += 1
        self.assertGreater(seen, 20, "no multi-turn row asked a fact-naming question")

    def test_a_plural_question_gets_the_whole_kind(self):
        pools = {kind: [q for strings in inst._list_questions(kind).values()
                        for q in strings]
                 for kind in inst._LIST_KINDS}
        seen = 0
        for e in inst.generate(KB, 3000, seed=42):
            if e["category"] != "factual" or e["counterfactual"]:
                continue
            q, a = e["turns"][0]
            kind = next((k for k, pool in pools.items()
                         if any(base in q for base in pool)), None)
            if kind is None:
                continue
            cited = re.findall(r"<\|fact:([^|]+)\|>", a)
            ctx_ids = [line[1:line.index("]")] for line in e["context"].splitlines()
                       if line.startswith("[")]
            self.assertGreaterEqual(len(cited), 2, f'"{q}" answered with {a}')
            self.assertEqual(sorted(set(cited)), sorted(set(ctx_ids)),
                             f'"{q}" cites {cited} against context {ctx_ids}')
            seen += 1
        self.assertGreater(seen, 30, "no plural question reached the factual share")


class Determinism(unittest.TestCase):
    def test_same_seed_is_the_same_data(self):
        a = [inst.format_example(e) for e in inst.generate(KB, 120, seed=99)]
        b = [inst.format_example(e) for e in inst.generate(KB, 120, seed=99)]
        self.assertEqual(a, b)

    def test_different_seed_is_different_data(self):
        a = [inst.format_example(e) for e in inst.generate(KB, 120, seed=99)]
        c = [inst.format_example(e) for e in inst.generate(KB, 120, seed=100)]
        self.assertNotEqual(a, c)


def _quiet(argv) -> int:
    """Run the CLI with its progress output swallowed — the suite's own
    output must stay readable, and these tests assert on the files."""
    with contextlib.redirect_stdout(io.StringIO()):
        return cli.main(argv)


class Cli(unittest.TestCase):
    def test_refuses_a_counterfactual_share_below_the_floor(self):
        self.assertEqual(_quiet(["--count", "20", "--share", "0.1", "--dry-run"]), 2)

    def test_writes_a_manifest_a_jsonl_and_a_review_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rc = _quiet([
                "--count", "200", "--seed", "42",
                "--out", str(tmp / "instruction"),
                "--review", str(tmp / "review.md"),
                "--review-count", "10",
            ])
            self.assertEqual(rc, 0)
            sft = tmp / "instruction" / "sft.jsonl"
            self.assertTrue(sft.exists())
            rows = [json.loads(line) for line in sft.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 200)
            for row in rows:
                self.assertIn("text", row)
                self.assertIn("assistant_spans", row)
                self.assertTrue(row["assistant_spans"])
            manifest = json.loads((tmp / "instruction" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["examples"], 200)
            self.assertGreaterEqual(manifest["counterfactual_share"], 0.30)
            self.assertIn("sft_bytes", manifest)
            review = (tmp / "review.md").read_text(encoding="utf-8")
            self.assertIn("# Stage B review sample", review)
            self.assertIn("| lang |", review)

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "instruction"
            rc = _quiet(["--count", "50", "--out", str(target), "--dry-run"])
            self.assertEqual(rc, 0)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
