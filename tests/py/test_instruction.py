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

    def test_factual_examples_use_placeholders_not_literal_values(self):
        ex = inst.generate(KB, 400, seed=4, counterfactual_share=0.0)
        joined = "\n".join(inst.format_example(e) for e in ex)
        self.assertIn("<|fact:person.name|>", joined)
        self.assertNotIn("aashish@example", joined)


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
