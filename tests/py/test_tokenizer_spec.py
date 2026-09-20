"""tests/py/test_tokenizer_spec.py — the §7.2 contract, Python side.

Reads the same `tests/fixtures/placeholder_cases.json` as
`tests/placeholders.test.mjs`: the browser resolves placeholders, the
tokenizer reserves them as atomic tokens, and a disagreement between the
two would mean the model emits a string the UI cannot fill in.

Also checks the trained artifact when one is present — as a *skip* when it
is not, never as a silent pass.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.tokenizer import spec  # noqa: E402

FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "placeholder_cases.json").read_text(encoding="utf-8"))
ARTIFACT = ROOT / "ai" / "tokenizer" / "artifacts" / "seed-1k"


class PlaceholderGrammar(unittest.TestCase):
    def test_every_fixture_case_matches(self):
        failures = []
        for case in FIXTURE["cases"]:
            got_ids = list(spec.iter_placeholders(case["text"]))
            got_whole = spec.is_placeholder(case["text"])
            if got_ids != case["ids"] or got_whole != case["whole"]:
                failures.append(f"{case['text']!r}: python={got_ids}/{got_whole} "
                                f"fixture={case['ids']}/{case['whole']}")
        self.assertEqual(failures, [], "placeholder grammar drift:\n" + "\n".join(failures))

    def test_placeholder_token_round_trips_and_rejects_junk(self):
        for fid in ("contact.email", "project.volunteer.live", "edu.lpu"):
            token = spec.placeholder_token(fid)
            self.assertTrue(spec.is_placeholder(token))
            self.assertEqual(list(spec.iter_placeholders(token)), [fid])
        for bad in ("", "   ", "a|b", "<x", "x>"):
            with self.assertRaises(ValueError, msg=f"should reject {bad!r}"):
                spec.placeholder_token(bad)

    def test_grammar_is_shared_with_the_js_module_at_source_level(self):
        """The two runtimes keep the pattern in their own language, so compare
        the *decoded* pattern, not the source text.

        The behavioural guarantee is the fixture above; this one catches the
        narrower failure it cannot see — the JS pattern gaining a construct
        (`[^|]+?` → a specific id shape, say) that happens to agree on all 16
        fixture rows while meaning something different.
        """
        import re as _re

        js = (ROOT / "ai" / "knowledge" / "placeholders.mjs").read_text(encoding="utf-8")
        match = _re.search(r"PLACEHOLDER_PATTERN\s*=\s*'([^']*)'", js)
        self.assertIsNotNone(match, "PLACEHOLDER_PATTERN literal not found in the JS module")
        # a JS single-quoted literal with backslash escapes: \\ -> \
        js_pattern = match.group(1).replace("\\\\", "\\")
        self.assertEqual(js_pattern, spec.PLACEHOLDER_RE.pattern,
                         "the JS and Python placeholder patterns have diverged")


class SpecialTokens(unittest.TestCase):
    def test_exactly_the_six_tokens_the_spec_names(self):
        self.assertEqual(spec.SPECIAL_TOKENS,
                         ("<|sys|>", "<|ctx|>", "<|user|>", "<|asst|>", "<|end|>", "<|abstain|>"))
        self.assertEqual(spec.ABSTAIN_TOKEN, "<|abstain|>")
        self.assertEqual(spec.END_TOKEN, "<|end|>")

    def test_fact_ids_come_from_the_knowledge_base_not_a_second_list(self):
        kb = spec.load_kb()
        ids = spec.fact_ids(kb)
        self.assertGreater(len(ids), 50)
        self.assertEqual(len(ids), len(set(ids)), "duplicate fact ids")
        self.assertIn("contact.email", ids)
        self.assertIn("project.volunteer.live", ids,
                      "composed project-link placeholders must be reserved")
        for fid in ids:
            self.assertNotIn("|", fid)

    def test_withheld_facts_still_get_a_placeholder(self):
        """A placeholder for a private fact must exist but never resolve.

        §8.4 layer 3 is what makes this consistent: the token is legal, the
        answer engine refuses to fill it (tests/placeholders.test.mjs proves
        the runtime side).
        """
        kb = spec.load_kb()
        self.assertIn("contact.phone", spec.fact_ids(kb))
        self.assertFalse(kb["contact"]["phone"]["public"])

    def test_version_changes_when_the_contract_changes(self):
        kb = spec.load_kb()
        base = spec.tokenizer_version("test", 4096, kb)
        self.assertTrue(base.startswith("test-4k-"))
        mutated = json.loads(json.dumps(kb))
        mutated["projects"][0]["links"].append({"label": "Repo", "url": "https://example.com/r"})
        self.assertNotEqual(base, spec.tokenizer_version("test", 4096, mutated),
                            "a new placeholder id must change the version hash")
        self.assertNotEqual(base, spec.tokenizer_version("test", 8192, kb))


class TrainedArtifact(unittest.TestCase):
    """Checks against the artifact on disk, skipped (loudly) when absent."""

    def setUp(self):
        if not (ARTIFACT / "tokenizer.json").is_file():
            self.skipTest(f"no artifact at {ARTIFACT} — run "
                          f"`python -m ai.tokenizer.train --corpus 'data/raw/seed/*.txt' "
                          f"--vocab-size 1024 --out ai/tokenizer/artifacts/seed-1k`")
        from ai.tokenizer.train import load

        self.tokenizer, self.meta = load(ARTIFACT)

    def test_contract_holds_on_the_trained_artifact(self):
        checks = spec.assert_tokenizer_contract(self.tokenizer, spec.load_kb())
        self.assertEqual(len(checks), 3)

    def test_artifact_metadata_is_complete(self):
        for key in ("tokenizer_version", "vocab_size", "special_tokens", "spec_hash",
                    "corpus", "artifact", "built_at"):
            self.assertIn(key, self.meta)
        self.assertEqual(self.meta["spec_hash"], spec.spec_hash())
        self.assertEqual(self.tokenizer.get_vocab_size(), self.meta["vocab_size"])
        self.assertEqual(self.meta["unknown_token"], None)
        self.assertTrue(self.meta["byte_fallback"])

    def test_version_string_matches_the_contract_hash(self):
        self.assertEqual(
            self.meta["tokenizer_version"],
            spec.tokenizer_version(self.meta["name"], self.meta["vocab_size"]))


if __name__ == "__main__":
    unittest.main()
