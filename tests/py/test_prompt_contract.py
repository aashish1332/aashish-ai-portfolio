"""tests/py/test_prompt_contract.py — PC-1…PC-7.

`ai/engine/prompt.mjs` rebuilds the §7.4 training frame in the browser. The
strings it uses come from `ai/engine/prompt_contract.json`, generated from
`ai/data/instruction.py` — because two copies of a prompt format is how a
trained model ends up looking broken after a deploy that changed nothing.

This file is the drift gate: if `instruction.py` changes without the JSON
being regenerated, `npm run test:py` fails here instead of at runtime, with
the model quietly mis-framed.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ai.data import instruction  # noqa: E402
from ai.tokenizer import spec  # noqa: E402
from inference import export_prompt_contract as contract  # noqa: E402

CONTRACT_PATH = ROOT / "ai/engine/prompt_contract.json"
JS_PATH = ROOT / "ai/engine/prompt.mjs"


class PromptContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.on_disk = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
        cls.fresh = contract.render()

    def test_PC_1_the_file_on_disk_is_current(self):
        self.assertEqual(contract.main(["--check"]), 0,
                         "ai/engine/prompt_contract.json is stale — rerun "
                         "`python inference/export_prompt_contract.py`")
        self.assertEqual(self.on_disk, self.fresh)

    def test_PC_2_the_frames_are_the_six_specials_in_order(self):
        frames = self.on_disk["frames"]
        self.assertEqual(list(frames), ["sys", "ctx", "user", "asst", "end", "abstain"])
        self.assertEqual(tuple(frames[k] for k in frames), spec.SPECIAL_TOKENS)

    def test_PC_3_the_rules_are_the_training_ones_verbatim(self):
        self.assertEqual(self.on_disk["rules"]["first"], instruction.RULES["first"])
        self.assertEqual(self.on_disk["rules"]["third"], instruction.RULES["third"])
        # The rule that makes abstention possible at all: a model that is not
        # told to say <|abstain|> cannot be trained to.
        for persona, text in self.on_disk["rules"].items():
            self.assertIn(spec.ABSTAIN_TOKEN, text, persona)
            self.assertIn("ONLY", text, persona)

    def test_PC_4_the_declared_layout_is_what_format_example_emits(self):
        # Reconstruct the frame from the contract and compare it with the
        # function the training data actually went through. If the layout
        # changes on one side only, this fails.
        ex = {
            "persona": "first",
            "context": "[person.name] Aashish\n[skill.python] Python",
            "turns": [["who are you?", "I am Aashish's assistant."]],
        }
        frames = self.on_disk["frames"]
        expected = " ".join([
            frames["sys"], self.on_disk["rules"]["first"], frames["ctx"], ex["context"],
            frames["user"], ex["turns"][0][0], frames["asst"], ex["turns"][0][1], frames["end"],
        ])
        self.assertEqual(instruction.format_example(ex), expected)
        self.assertEqual(self.on_disk["joining"], " ")
        self.assertEqual(self.on_disk["layout"],
                         ["sys", "rules", "ctx", "context", "turns"])
        self.assertEqual(self.on_disk["turn"], ["user", "text", "asst", "answer", "end"])

    def test_PC_5_a_multi_turn_example_shares_one_context(self):
        ex = {
            "persona": "third",
            "context": "[person.name] Aashish",
            "turns": [["a?", "A."], ["b?", "B."]],
        }
        text = instruction.format_example(ex)
        self.assertEqual(text.count(instruction.CTX), 1)
        self.assertEqual(text.count(instruction.USER), 2)
        self.assertEqual(text.count(instruction.END), 2)
        self.assertTrue(text.startswith(instruction.SYS + " "))

    def test_PC_6_the_placeholder_spans_align_with_the_frame(self):
        # `assistant_spans` tells the trainer which characters to compute the
        # loss on; a frame written differently would silently train on the
        # system rules as well.
        ex = {"persona": "first", "context": "[a] b", "turns": [["q", "A1"], ["q2", "A2"]]}
        text = instruction.format_example(ex)
        spans = instruction.assistant_spans(text)
        self.assertEqual(len(spans), 2)
        self.assertEqual([text[a:b].strip() for a, b in spans], ["A1", "A2"])

    def test_PC_7_the_engine_reads_this_file_and_nothing_else(self):
        js = JS_PATH.read_text(encoding="utf-8")
        self.assertIn("from './prompt_contract.json'", js)
        # A second copy of the rules in the JS would be exactly the drift this
        # file exists to prevent.
        self.assertNotIn("You are Aashish's AI portfolio assistant", js)
        self.assertIn("contract.rules[rules]", js)
        self.assertIn("SPECIALS.sys", js)


if __name__ == "__main__":
    unittest.main()
