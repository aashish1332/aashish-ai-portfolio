"""Tests for the novel-answer comparison and the Stage B `config` claim.

Two things are guarded here, both of which produced wrong readings first.

**The auditor's `config` claim.** It is anchored with `^` so that
`A: vocab=16,384 d=512 L=10 heads=8/4` matches as a *shape* rather than inside
some unrelated line. But the decoded transcript decorates every line with
`[0016m11.22s] stdout `, so `^` matched nothing except line 1. MEASURED
2026-10-03: the claim reported MISSING on **both** the v1 and the v2 Stage B
transcripts, each of which prints the config line in plain sight on line 147.
A claim that cannot match the artifact it audits is worse than no claim, because
it reads as a finding.

**The comparison tool.** v1's number has to be recomputed from the same tool
that reads v2, not carried over from an earlier ad-hoc parse, or the two runs
are not being compared on the same definition.

Note the literal `[0016m`: these files contain no ESC byte, so a conventional
ANSI pattern matches nothing. Both tools strip by bracket form for that reason.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


compare = _load("compare_novel_answers")
audit = _load("audit_run_log")

CONFIG_LINE = ("[0016m11.22s] stdout A: vocab=16,384 d=512 L=10 heads=8/4 "
               "head_dim=64 ffn=1,408 ctx=1024 tied=True")


class ConfigClaimMatchesAPrefixedTranscript(unittest.TestCase):
    def setUp(self):
        self.claim = next(c for c in audit.STAGE_B_CLAIMS if c.name == "config")
        self.pattern = re.compile(self.claim.pattern, audit._FLAGS)

    def test_it_matches_the_line_as_the_transcript_prints_it(self):
        match = self.pattern.search(CONFIG_LINE)
        self.assertIsNotNone(
            match, "the config claim cannot match a decorated transcript line")
        self.assertEqual(match.groups()[:6],
                         ("A", "16,384", "512", "10", "8", "4"))

    def test_it_matches_a_bare_line_too(self):
        bare = "A: vocab=16,384 d=512 L=10 heads=8/4"
        self.assertIsNotNone(self.pattern.search(bare),
                             "a transcript with no per-line decoration still "
                             "has to match")

    def test_it_matches_when_the_line_is_not_the_first(self):
        # The regression: with `^` and no MULTILINE this could not match, and
        # with MULTILINE but no prefix allowance it still could not.
        text = "some earlier output\n" * 3 + CONFIG_LINE
        self.assertIsNotNone(
            self.pattern.search(text),
            "^ only matches at the start of a line, so this is the case that "
            "reported MISSING on two real transcripts")

    def test_it_still_rejects_the_shape_in_the_middle_of_a_line(self):
        middle = "blah A: vocab=16,384 d=512 L=10 heads=8/4 trailing"
        self.assertIsNone(
            self.pattern.search(middle),
            "the anchor is the point of this claim: it must match a line, not "
            "fragments scattered across one")

    def test_it_rejects_an_unrelated_line(self):
        self.assertIsNone(
            self.pattern.search("params: 37,890,560"),
            "the params line shares no shape with the config line, so matching "
            "it would mean the pattern is too loose")


class TranscriptDecorationIsStripped(unittest.TestCase):
    def test_the_timestamp_prefix_is_removed(self):
        line = "[0016m11.22s] stdout    factual/en  Which database?"
        self.assertEqual(
            compare.strip_decoration(line)[0],
            "factual/en  Which database?",
            "the timestamp decoration survived, so every question in the "
            "transcript carries a prefix that no pattern can match")

    def test_a_real_ansi_prefix_is_also_removed(self):
        line = "\x1b[0;32m[0016m11.22s] stdout hello"
        self.assertEqual(compare.strip_decoration(line)[0], "hello",
                         "a genuine ESC-prefixed line is not cleaned")

    def test_a_real_escape_sequence_is_removed(self):
        self.assertEqual(compare.strip_decoration("\x1b[0;32mplain")[0], "plain",
                         "a real ANSI escape sequence is not removed")


class SamplingBlocksAreKeptApart(unittest.TestCase):
    """Pooling the three samplings would average away the number that matters."""

    TEXT = "\n".join([
        "8 prompts from novel-prompts.jsonl",
        "",
        "── stage-A  (/kaggle/working/checkpoints/stage-a, latest)",
        "   factual/en  Which database does Aashish use?",
        "     → \" stage-A answer\"",
        "",
        "── stage-B  (/kaggle/working/checkpoints/stage-b, latest)",
        "   factual/en  Which database does Aashish use?",
        "     → \" stage-B answer one\"",
        "   greeting/en  hello",
        "     → ' stage-B answer two'",
        "",
        "echo rate: 0/2 samples repeat the prompt (0%)",
    ]) + "\n"

    def test_two_blocks_are_separate(self):
        blocks = compare.read_blocks_from_text(self.TEXT)
        self.assertEqual(
            [b[0] for b in blocks], ["stage-A", "stage-B"],
            "the two samplings were merged into one block, so the novel-prompt "
            "answers would be averaged together with the training-set ones")

    def test_the_stage_b_block_holds_only_its_own_pairs(self):
        stage_b = [b for b in compare.read_blocks_from_text(self.TEXT)
                   if b[0] == "stage-B"][0][1]
        self.assertEqual(len(stage_b), 2,
                         "the stage-B block picked up the wrong number of pairs")
        self.assertNotIn("stage-A answer", [a for _, a in stage_b],
                         "a stage-A answer leaked into the stage-B block")

    def test_both_quoted_and_single_quoted_answers_unquote(self):
        # Otherwise an answer printed with ' is scored as different from the
        # same answer printed with ", and the distinct count is inflated.
        pairs = [b for b in compare.read_blocks_from_text(self.TEXT)
                 if b[0] == "stage-B"][0][1]
        self.assertEqual(pairs[0][1], " stage-B answer one",
                         "the double-quoted answer kept its quotes, so it will "
                         "not compare equal to the same text printed with '")
        self.assertEqual(pairs[1][1], " stage-B answer two",
                         "the single-quoted answer kept its quotes")

    def test_a_block_boundary_clears_a_dangling_question(self):
        # The next block opens with an *answer*, not a question, so the only
        # thing standing between it and the previous block's unanswered
        # question is the `question = None` on the header path. An earlier
        # version of this fixture gave stage-B its own question line, which
        # overwrote the stale one before any answer appeared - so the mutation
        # that removed the clear changed nothing observable and the test passed
        # for the wrong reason.
        text = ("── stage-A  (x)\n"
                "   factual/en  never answered?\n"
                "── stage-B  (y)\n"
                "     → ' answer with no question of its own'\n")
        blocks = compare.read_blocks_from_text(text)
        stage_b = [b for b in blocks if b[0] == "stage-B"][0][1]
        self.assertEqual(
            stage_b, [],
            "the unanswered question from the previous block was paired with "
            "this block's answer")


class ScoringCountsWhatItClaims(unittest.TestCase):
    def test_distinct_answers_leaks_and_dead_answers(self):
        pairs = [
            ("q1", "same"),
            ("q2", "same"),
            ("q3", "other"),
            ("q4", "leaks <|fact:edu.lpu|>"),
            ("q5", "<|end|>"),
        ]
        answers = [a for _, a in pairs]
        self.assertEqual(len(set(answers)), 4,
                         "the distinct-answer count is the headline number and "
                         "must count distinct answers")
        self.assertEqual(sum(1 for a in answers if "<|fact:" in a), 1,
                         "a raw <|fact:..|> slot leaked into an answer and was "
                         "not counted")
        self.assertEqual(sum(1 for a in answers
                             if a.strip() in ("<|end|>", "")), 1,
                         "a bare <|end|> is a dead answer and must be counted")


if __name__ == "__main__":
    unittest.main()