"""tests/py/test_answer_frames.py — the closed-answer table is the training table.

`ai/engine/grammar.mjs` decodes a fact question against
`ai/answers/answer_frames.json`: the sentences the model was TRAINED to say
about a fact, exported from `ai/data/instruction.py`.

That is only honest while the two agree. An edit to a frame in `instruction.py`
(and the next training run that teaches it) must not leave a committed JSON
that still allows the OLD sentence — the grammar would then permit an answer the
checkpoint was never taught, which is the same class of silent drift
`prompt_contract.json` is pinned against.

So this file re-runs the exporter and compares (AF-1…AF-3).
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import tools.export_answer_frames as export  # noqa: E402

TABLE_PATH = ROOT / "ai" / "answers" / "answer_frames.json"


def _committed() -> dict:
    return json.loads(TABLE_PATH.read_text(encoding="utf-8"))


class AnswerFramesTest(unittest.TestCase):
    def test_AF1_committed_table_matches_the_training_tables(self):
        expected = json.loads(
            json.dumps(export.build(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        )
        self.assertEqual(
            _committed(), expected,
            "ai/answers/answer_frames.json is stale — run "
            "`PYTHONUTF8=1 python tools/export_answer_frames.py`",
        )

    def test_AF2_every_frame_has_a_slot_and_every_language(self):
        table = _committed()
        langs = set(table["languages"])
        self.assertEqual(langs, {"en", "hi", "hinglish"})
        for fact_id, by_lang in table["frames"].items():
            self.assertEqual(set(by_lang), langs, fact_id)
            for lang, personas in by_lang.items():
                self.assertEqual(set(personas), {"first", "third"}, (fact_id, lang))
                for persona, text in personas.items():
                    # The slot IS the mechanism: a frame without `{v}` would let
                    # the grammar emit a sentence with no fact in it and still
                    # count as an answer.
                    self.assertIn("{v}", text, (fact_id, lang, persona, text))
        for kind, by_lang in table["kindFrames"].items():
            self.assertEqual(set(by_lang), langs, kind)
            for lang, personas in by_lang.items():
                self.assertIn("{v}", personas["third"], (kind, lang))
        for kind, by_lang in table["listFrames"].items():
            self.assertEqual(set(by_lang), langs, kind)

    def test_AF3_a_list_is_joined_in_its_own_language(self):
        seps = _committed()["separators"]
        self.assertEqual(seps["en"], [", ", " and "])
        self.assertEqual(seps["hi"], [", ", " और "])
        self.assertEqual(seps["hinglish"], [", ", " aur "])

    def test_AF4_the_kinds_the_engine_keys_by_id_prefix_are_present(self):
        """`kindOf()` in the engine is the id prefix, so the table must be keyed
        that way — `_COVERAGE_FRAMES` calls the certification kind
        "certification" while every id says `cert.…`."""
        table = _committed()
        self.assertIn("cert", table["kindFrames"])
        self.assertNotIn("certification", table["kindFrames"])
        for kind in ("skill", "cert", "ach", "exp", "project"):
            self.assertIn(kind, table["listFrames"])


if __name__ == "__main__":
    unittest.main()
