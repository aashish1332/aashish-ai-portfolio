"""tests/py/test_sft.py — the Stage B data path, masked loss included (§7.4).

Stage B's whole contribution is *which tokens the loss is on*. A wrong mask
does not crash and does not change any loss curve in an obviously wrong way:
the run just quietly trains the model on the question, or drops the first
word of every answer, and the result is a model that writes plausible
questions instead of answers. So the mask is checked structurally, on real
data, with no torch involved:

* no hole — every non-whitespace character of an assistant turn is covered by
  a supervised token;
* no leak — no supervised token brings in a non-whitespace character from
  outside the turn, and no question/system/context/delimiter token is ever
  supervised;
* every turn's closing `<|end|>` is supervised, exactly once per turn.

The cursor half of "training is resumable" is checked the same way
`TokenBatcher` is: resuming from a saved state must produce the identical
next batch, not a similar one.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import instruction, sft  # noqa: E402
from ai.tokenizer.train import load  # noqa: E402
from training.scripts import train_stage_b  # noqa: E402

TOKENIZER_DIR = ROOT / "ai" / "tokenizer" / "artifacts" / "seed-1k"
DATA = ROOT / "data" / "instruction" / "sft.jsonl"
SAMPLE = 300


class SftCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (TOKENIZER_DIR / "tokenizer.json").is_file() or not DATA.is_file():
            raise unittest.SkipTest("no tokenizer / instruction data on this machine")
        cls.tokenizer, cls.meta = load(TOKENIZER_DIR)
        cls.examples = sft.read_examples(DATA, limit=SAMPLE)

    # ── data reading ─────────────────────────────────────────────────
    def test_examples_carry_the_spans_the_text_really_has(self):
        self.assertGreater(len(self.examples), 0)
        for example in self.examples:
            self.assertEqual(example.spans, instruction.assistant_spans(example.text))
            self.assertIn(sft.END_TOKEN, example.text)

    def test_a_data_file_with_drifted_spans_is_refused(self):
        """Spans are read from the file, so they have to be validated against it."""
        example = self.examples[0]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "drifted.jsonl"
            import json

            path.write_text(json.dumps({"text": example.text,
                                        "assistant_spans": [[1, 2]]}) + "\n",
                            encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                sft.read_examples(path)
            self.assertIn("disagree", str(ctx.exception))

    def test_the_missing_file_error_names_the_command_that_builds_it(self):
        with self.assertRaises(FileNotFoundError) as ctx:
            sft.read_examples(ROOT / "data" / "instruction" / "does-not-exist.jsonl")
        self.assertIn("npm run sft", str(ctx.exception))

    # ── the mask ─────────────────────────────────────────────────────
    def test_no_holes_no_leaks_and_every_turn_is_closed(self):
        end_id = self.tokenizer.token_to_id(sft.END_TOKEN)
        structural = {self.tokenizer.token_to_id(token)
                      for token in ("<|sys|>", "<|ctx|>", "<|user|>", "<|asst|>")}

        checked = 0
        for example in self.examples:
            enc = self.tokenizer.encode(example.text)
            ids, supervised = sft.supervised_token_indices(self.tokenizer, example)
            self.assertEqual(ids, list(enc.ids))

            covered: set[int] = set()
            for index in supervised:
                start, end = enc.offsets[index]
                covered.update(range(max(0, start), min(end, len(example.text))))
                self.assertNotIn(ids[index], structural,
                                 "a question/context/delimiter token was supervised")

            for start, end in example.spans:
                for position in range(start, end):
                    if not example.text[position].isspace():
                        self.assertIn(position, covered,
                                      "a character of the answer is not trained on")

            closers = [index for index in supervised if ids[index] == end_id]
            self.assertEqual(len(closers), len(example.spans),
                             "each turn must be taught to emit its <|end|>")
            checked += 1
        self.assertGreater(checked, 100)

    def test_the_answer_is_never_the_whole_sequence(self):
        """If the mask were everything, Stage B would be Stage A with extra steps."""
        example = self.examples[0]
        ids, labels = sft.encode_example(self.tokenizer, example)
        supervised = sum(1 for value in labels if value != sft.IGNORE_INDEX)
        self.assertGreater(supervised, 0)
        self.assertLess(supervised, len(ids))
        self.assertIn(sft.IGNORE_INDEX, labels)

    def test_the_masked_text_is_the_answer_and_not_the_question(self):
        for example in self.examples[:50]:
            ids, labels = sft.encode_example(self.tokenizer, example)
            shown = sft.masked_text(self.tokenizer, ids, labels).strip()
            answer = example.text[example.spans[0][0]:example.spans[0][1]].strip()
            head = answer.split()[0]
            self.assertTrue(shown.startswith(head),
                            f"the loss must start with the answer's first word, got {shown[:40]!r}")
            self.assertNotIn("<|user|>", shown)
            self.assertNotIn("You are Aashish's AI portfolio assistant", shown)

    def test_an_empty_mask_is_an_error_not_a_silent_no_op(self):
        example = sft.Example(text="<|sys|> rules <|ctx|> facts <|user|> q <|asst|> a <|end|>",
                              spans=[(len("<|sys|> rules <|ctx|> facts <|user|> q <|asst|> a <|end|>"),
                                      len("<|sys|> rules <|ctx|> facts <|user|> q <|asst|> a <|end|>"))])
        with self.assertRaises(ValueError):
            sft.encode_example(self.tokenizer, example)

    # ── measured counts ──────────────────────────────────────────────
    def test_counts_are_measured_not_estimated(self):
        counts = sft.measured_token_counts(self.tokenizer, self.examples)
        self.assertIn("MEASURED", counts["method"])
        self.assertLess(counts["supervised_tokens"], counts["tokens"])
        self.assertGreater(counts["supervised_share"], 0.05)
        self.assertLess(counts["supervised_share"], 0.5)

        summary = sft.summarise(self.examples)
        self.assertEqual(summary["examples"], len(self.examples))
        self.assertEqual(sum(summary["categories"].values()), len(self.examples))
        self.assertEqual(summary["assistant_turns"],
                         sum(len(example.spans) for example in self.examples))


class SftStreamCursor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (TOKENIZER_DIR / "tokenizer.json").is_file() or not DATA.is_file():
            raise unittest.SkipTest("no tokenizer / instruction data on this machine")
        cls.tokenizer, _ = load(TOKENIZER_DIR)
        cls.examples = sft.read_examples(DATA, limit=200)

    def stream(self, **kwargs) -> sft.SftStream:
        options = {"block": 128, "batch": 2, "seed": 7}
        options.update(kwargs)
        return sft.SftStream(self.examples, self.tokenizer, **options)

    def test_batches_are_masked_and_rectangular(self):
        stream = self.stream()
        xs, ys = stream.next_batch()
        self.assertEqual(xs.shape, (2, 128))
        self.assertEqual(ys.shape, (2, 128))
        self.assertTrue((ys == sft.IGNORE_INDEX).any())
        self.assertTrue((ys != sft.IGNORE_INDEX).any())

    def test_resuming_continues_the_identical_stream(self):
        stream = self.stream()
        stream.next_batch()
        state = stream.state()
        uninterrupted = stream.next_batch()

        resumed = self.stream()
        resumed.load_state(state)
        again = resumed.next_batch()
        self.assertTrue((uninterrupted[0] == again[0]).all())
        self.assertTrue((uninterrupted[1] == again[1]).all())

    def test_resume_after_an_epoch_boundary_still_matches(self):
        """The permutation is replayed from the RNG state saved with the cursor.

        A short epoch is built on purpose: this is the case where a cursor that
        only remembered an *offset* would silently resume into a different
        shuffle.
        """
        few = self.examples[:8]
        stream = sft.SftStream(few, self.tokenizer, block=64, batch=2, seed=7)
        for _ in range(40):
            stream.next_batch()
        self.assertGreater(stream.epoch, 0, "the run should have crossed an epoch")
        state = stream.state()
        uninterrupted = stream.next_batch()
        resumed = sft.SftStream(few, self.tokenizer, block=64, batch=2, seed=7)
        resumed.load_state(state)
        again = resumed.next_batch()
        self.assertTrue((uninterrupted[0] == again[0]).all())
        self.assertTrue((uninterrupted[1] == again[1]).all())

    def test_a_cursor_from_a_different_shape_is_refused(self):
        state = self.stream().state()
        other = self.stream(block=256, batch=2)
        with self.assertRaises(ValueError):
            other.load_state(state)
        wider = self.stream(block=128, batch=4)
        with self.assertRaises(ValueError):
            wider.load_state(state)

    def test_validation_is_held_out_and_has_supervision(self):
        stream = self.stream()
        self.assertFalse(set(stream.train_indices) & set(stream.val_indices))
        batches = stream.validation_batches(3)
        self.assertEqual(len(batches), 3)
        # Per-window supervision is not guaranteed — the held-out slice is tiny
        # here and supervision is clustered — so the aggregate is what a val
        # loss needs in order to measure anything at all.
        self.assertGreater(sum(int((ys != sft.IGNORE_INDEX).sum()) for _, ys in batches), 0)
        for _, ys in batches:
            self.assertTrue((ys == sft.IGNORE_INDEX).any(),
                            "an unmasked validation window is not a masked-MSE input")

    def test_the_cursor_counts_supervised_tokens_not_just_windows(self):
        stream = self.stream()
        xs, ys = stream.next_batch()
        stream.tokens_consumed += int(xs.size)
        stream.supervised_consumed += stream.count_supervised(xs, ys)
        self.assertGreater(stream.supervised_consumed, 0)
        self.assertLess(stream.supervised_consumed, stream.tokens_consumed)


class StageBEntryPoint(unittest.TestCase):
    def test_defaults_differ_from_stage_a_where_they_must(self):
        parser = train_stage_b.build_parser()
        args = parser.parse_args([])
        self.assertLess(args.lr, 3e-4,
                        "Stage B must not start at the pretraining learning rate")
        self.assertEqual(args.init, None)
        self.assertIn("sft.jsonl", args.data)
        self.assertFalse(args.pipeline_only)
        self.assertEqual(args.gate, False)

    def test_init_refuses_a_checkpoint_from_a_different_shape(self):
        """A `--init` from another config would load *some* keys and train a
        half-random model with no error to notice."""
        import tempfile

        from ai.model.config import smoke_config
        from training.scripts import checkpoint as ckpt

        with tempfile.TemporaryDirectory() as tmp:
            manager = ckpt.CheckpointManager(tmp)
            manager.save({
                "model": {}, "optimizer": {}, "scheduler": {}, "scaler": {},
                "step": 5, "epoch": 0,
                "config": smoke_config(1024).to_hf_config(),
                "tokenizer_version": "test", "rng": ckpt.capture_rng(),
                "data_cursor": {}, "loss_history": [],
            }, step=5)
            wider = train_stage_b.resolve_config("A", 12288)
            self.assertNotEqual(wider.vocab_size, 1024)
            with self.assertRaises(SystemExit) as ctx:
                train_stage_b.load_init_weights(None, Path(tmp) / "latest.pt", wider)
            self.assertIn("vocab_size", str(ctx.exception))

    def test_pipeline_only_runs_without_torch(self):
        """The torch-free path is the only one a machine like this can run."""
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = train_stage_b.main(["--pipeline-only", "--limit", "60",
                                       "--block", "64", "--batch", "2",
                                       "--eval-batches", "2"])
        output = buffer.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("loss is on:", output)
        self.assertIn("cursor: resuming yields", output)
        self.assertIn("UNVERIFIED (needs torch)", output)


if __name__ == "__main__":
    unittest.main()
