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
from tests.py import HAVE_SEED_SHARDS, SEED_SHARDS_MISSING  # noqa: E402


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
        """The Stage A tokenizer is trained at 16,384 (§7.1), so resolution is
        the identity there — and that is the point: at 16,384 the number
        `count_parameters.py` prints for config A is the number the run trains.
        """
        from ai.model.config import CONFIG_A

        cfg = train_smoke.resolve_config("A", 16384)
        self.assertEqual(cfg.vocab_size, 16384)
        self.assertEqual(cfg.hidden_size, 512)
        self.assertEqual(cfg.num_hidden_layers, 10)
        total = plan.counts(cfg)["total"]
        self.assertEqual(total, plan.counts(CONFIG_A)["total"],
                         "at the frozen tokenizer's vocab, config A must be "
                         "unchanged — else the §7.1 count describes a model that "
                         "is never trained")
        # ...and the embedding must still follow the tokenizer when it differs,
        # landing in the same band at the smaller size rather than silently
        # keeping 16k rows.
        smaller = plan.counts(train_smoke.resolve_config("A", 12288))["total"]
        self.assertLess(smaller, total)
        self.assertTrue(30_000_000 <= smaller,
                        "a smaller tokenizer must still stay in the §7.1 band")

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

    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
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


class ARealRunWritesAResumableCheckpoint(unittest.TestCase):
    """The test that was missing while Stage A v2 shipped a broken checkpoint.

    Every other test in this file stops before the loop. The defect this class
    covers lives *inside* the loop's save path, so nothing short of running it
    can see it — and on 2026-10-02 a 20,000-step Kaggle run finished with an
    optimizer holding no moments and a scheduler at `last_epoch` 0, both
    snapshotted at step 0. The keys were all present, so every key-based check
    passed.

    Six steps of a ~1M-parameter model on CPU is a few seconds and is the only
    way to know the trainer hands the manager its live objects rather than
    describing the fact in a docstring.
    """

    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    @unittest.skipUnless(train_smoke.have_torch(), "no torch on this machine")
    def test_the_saved_checkpoint_carries_this_run_s_optimizer_and_schedule(self):
        import torch

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            with contextlib.redirect_stdout(io.StringIO()):
                code = train_smoke.main([
                    "--config", "smoke", "--steps", "6", "--batch", "2",
                    "--block", "32", "--grad-accum", "2", "--warmup", "2",
                    "--save-every", "6", "--eval-every", "6", "--log-every", "6",
                    "--device", "cpu", "--run-dir", str(run_dir),
                ])
            self.assertEqual(code, 0)

            saved = torch.load(run_dir / "latest.pt", map_location="cpu",
                               weights_only=False)
            self.assertEqual(saved["step"], 6)
            # The three assertions that would each have caught v2 on their own.
            self.assertTrue(saved["optimizer"]["state"],
                            "the saved optimizer holds no moments — it was "
                            "captured before the first update")
            self.assertGreater(saved["scheduler"]["last_epoch"], 0,
                               "the saved scheduler never stepped")
            self.assertEqual(saved["hyperparameters"]["grad_accum"], 2)
            # ...and the moments are this run's, not a zero tensor left over.
            first = next(iter(saved["optimizer"]["state"].values()))
            self.assertGreater(int(first["step"]), 0)
            self.assertTrue(torch.isfinite(first["exp_avg"]).all())

    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    @unittest.skipUnless(train_smoke.have_torch(), "no torch on this machine")
    def test_the_checkpoint_loads_back_through_the_manager(self):
        # The freshness check runs on load as well as save, so a resume is
        # refused rather than silently restarting Adam — which is the failure
        # the whole class is about.
        from training.scripts import checkpoint as ckpt

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            with contextlib.redirect_stdout(io.StringIO()):
                train_smoke.main([
                    "--config", "smoke", "--steps", "6", "--batch", "2",
                    "--block", "32", "--grad-accum", "2", "--warmup", "2",
                    "--save-every", "6", "--eval-every", "6", "--log-every", "6",
                    "--device", "cpu", "--run-dir", str(run_dir),
                ])
            manager = ckpt.CheckpointManager(run_dir)
            loaded = manager.load("latest")
            self.assertEqual(loaded["step"], 6)
            self.assertTrue(manager.info()["which"], "auto-resume found nothing")


if __name__ == "__main__":
    unittest.main()
