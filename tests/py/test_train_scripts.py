"""tests/py/test_train_scripts.py — the training entry points, without torch.

Everything here is the part of `train_smoke.py` / `train_stage_a.py` that is
reachable on a machine with no PyTorch: flag defaulting, config resolution,
and the torch-free `--pipeline-only` path. The loop itself is UNVERIFIED
without torch (see docs/TRAINING.md) — but a script that cannot even assemble
its own arguments would fail before it got that far.
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.model import plan  # noqa: E402
from training.scripts import train_smoke, train_stage_a  # noqa: E402


class ResolveConfig(unittest.TestCase):
    def test_smoke_config_is_sized_to_the_tokenizer(self):
        cfg = train_smoke.resolve_config("smoke", 1024)
        self.assertEqual(cfg.vocab_size, 1024)
        self.assertEqual(cfg.name, "smoke")
        self.assertTrue(1_000_000 <= plan.counts(cfg)["total"] <= 3_000_000)
        # +3000 extra embedding rows x d=192, and nothing else changes
        self.assertEqual(plan.counts(train_smoke.resolve_config("smoke", 4096))["total"],
                         plan.counts(cfg)["total"] + 3072 * 192,
                         "the embedding must follow the tokenizer's vocab")

    def test_config_a_adopts_the_frozen_tokenizer_vocabulary(self):
        cfg = train_smoke.resolve_config("A", 12288)
        self.assertEqual(cfg.vocab_size, 12288)
        self.assertEqual(cfg.hidden_size, 512)
        self.assertEqual(cfg.num_hidden_layers, 10)
        total = plan.counts(cfg)["total"]
        self.assertTrue(30_000_000 <= total <= 50_000_000,
                        "config A with the 12k tokenizer must stay in the §7.1 band")
        self.assertLess(total, plan.counts(train_smoke.resolve_config("A", 16384))["total"])

    def test_an_unknown_config_is_refused_loudly(self):
        with self.assertRaises(SystemExit) as ctx:
            train_smoke.resolve_config("enormous", 1024)
        self.assertIn("unknown --config", str(ctx.exception))

    def test_configs_are_not_mutated_by_resolution(self):
        from ai.model.config import CONFIG_A

        before = CONFIG_A.vocab_size
        train_smoke.resolve_config("A", 4096)
        self.assertEqual(CONFIG_A.vocab_size, before,
                         "resolving a config must not edit the shared default")


class StageADefaults(unittest.TestCase):
    def test_defaults_are_filled_in_and_explicit_flags_win(self):
        filled = train_stage_a.apply_defaults(["--steps", "100"])
        self.assertIn("--config", filled)
        self.assertEqual(filled[filled.index("--config") + 1], "A")
        self.assertIn("--amp", filled, "Stage A runs with fp16 AMP by default")
        self.assertEqual(filled.count("--steps"), 1, "an explicit flag must not be duplicated")
        self.assertEqual(filled[filled.index("--steps") + 1], "100")

    def test_equals_spelling_counts_as_supplied(self):
        filled = train_stage_a.apply_defaults(["--lr=1e-3"])
        self.assertNotIn("--lr", filled, "the default must yield to --lr=1e-3")
        self.assertIn("--lr=1e-3", filled)

    def test_every_default_is_a_real_flag(self):
        """A typo in the defaults table would only show up as an argparse error
        on Kaggle, 20 minutes into a session."""
        parser = train_smoke.build_parser()
        known = {action.option_strings[0] for action in parser._actions
                 if action.option_strings}
        for flag in train_stage_a.STAGE_A_DEFAULTS:
            self.assertIn(flag, known, f"{flag} is not an option of train_smoke")

    def test_help_path_does_not_train(self):
        """Argparse exits for --help; the wrapper must not swallow that into a
        return code of its own."""
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            with self.assertRaises(SystemExit) as ctx:
                train_stage_a.main(["--help"])
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn("smoke train", buffer.getvalue())
        for flag in ("--config", "--grad-accum", "--max-minutes", "--resume"):
            self.assertIn(flag, buffer.getvalue(), f"{flag} vanished from the CLI")


class PipelineOnly(unittest.TestCase):
    """The torch-free path must stay runnable: it is what CI executes, and what
    the docs claim. `--pipeline-only` is a *request*, not a statement about the
    machine — a box with torch asks for it too, so the banner has to say what
    this pass skipped without inventing a missing dependency."""

    def test_runs_end_to_end_on_the_committed_fixture(self):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = train_smoke.main(["--pipeline-only"])
        text = buffer.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("PIPELINE-ONLY MODE", text)
        self.assertIn("NOT VERIFIED BY THIS PASS", text,
                      "the honest banner is part of the contract, not decoration")
        # ...and the *reason* has to match the machine. Asserting "needs torch"
        # here is how this suite passed for a revision while the box had torch
        # installed and the tool said it did not.
        if train_smoke.have_torch():
            self.assertIn("torch is installed here", text)
            self.assertNotIn("torch is not installed", text)
        else:
            self.assertIn("torch is not installed on this machine", text)
        self.assertIn("data cursor", text)

    def test_a_missing_tokenizer_says_what_to_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as ctx:
                with contextlib.redirect_stdout(io.StringIO()):
                    train_smoke.main(["--pipeline-only",
                                      "--tokenizer", str(Path(tmp) / "nope")])
            self.assertIn("tokenizer", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
