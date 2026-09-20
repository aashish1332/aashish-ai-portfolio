"""tests/py/test_langid_parity.py — the Python half of §8.3 parity.

Reads `tests/fixtures/langid_cases.json`, the same file
`tests/langid-fixture.test.mjs` asserts against. The Python port exists
because the Stage A corpus is *tagged* by language during data prep; if it
disagreed with the runtime detector, Hindi text would be filed as English
(and trained that way) while the browser still answered in Hindi.

The labels in the fixture are the JS oracle, not Python's output — so this
test can genuinely fail.

    python -m unittest discover -s tests/py -t .
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import langid  # noqa: E402

FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "langid_cases.json").read_text(encoding="utf-8"))


class LanguageParity(unittest.TestCase):
    maxDiff = None

    def test_every_fixture_case_matches(self):
        self.assertGreaterEqual(len(FIXTURE["cases"]), 40)
        failures = []
        for case in FIXTURE["cases"]:
            result = langid.detect_language(case["text"])
            if result["lang"] != case["lang"] or result["strength"] != case["strength"]:
                failures.append(
                    f"{case['text']!r}: python={result['lang']}/{result['strength']} "
                    f"fixture={case['lang']}/{case['strength']}")
        self.assertEqual(failures, [], "language-ID drift between runtimes:\n" +
                         "\n".join(failures))

    def test_diagnostics_match_the_same_shape_as_js(self):
        for case in FIXTURE["cases"][:10]:
            result = langid.detect_language(case["text"])
            for key in ("lang", "strength", "devRatio", "hinglishHits",
                        "englishHits", "tokens"):
                self.assertIn(key, result, f"missing {key} in the detection result")

    def test_tracker_smoothing_matches_the_js_semantics(self):
        tracker = langid.create_language_tracker("en")
        first = tracker["push"]("उसका नाम क्या है")
        self.assertEqual(first["lang"], "hi")
        self.assertTrue(first["switched"])
        weak = tracker["push"]("mongodb")
        self.assertEqual(weak["strength"], "weak")
        self.assertEqual(weak["lang"], "hi", "a weak signal must not switch language")
        strong = tracker["push"]("Tell me about his projects please.")
        self.assertEqual(strong["lang"], "en")
        self.assertTrue(strong["switched"])

    def test_devanagari_matras_and_nukta_survive_tokenisation(self):
        """`उसका` is उ+स+का — the ा is category Mn, not a letter.

        A tokenizer that keeps only letters silently turns every Hindi word
        into a consonant skeleton, which is exactly the kind of bug that
        reports as "retrieval works badly for Hindi" rather than as a
        failure.
        """
        tokens = langid.tokenize("उसका पढ़ाई ग़लत")
        self.assertEqual(tokens, ["उसका", "पढ़ाई", "ग़लत"])
        # उसकी = उ + स + क + ी ; the ी (U+0940, Mn) must survive tokenisation.
        self.assertIn("\u0940", langid.tokenize("उसकी")[0])
        self.assertIn("\u0901", langid.tokenize("गाँव")[0])  # chandrabindu
        self.assertIn("\u093c", langid.tokenize("फ़ोन")[0])  # nukta
        self.assertEqual(langid.label("फ़ोन"), "hi")


if __name__ == "__main__":
    unittest.main()
