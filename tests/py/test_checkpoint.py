"""tests/py/test_checkpoint.py — §7.5 "resume verified", the parts provable here.

`checkpoint.py` and `dataset.py` are deliberately framework-free (the
serializer and the torch import are injected/lazy), so the logic that
decides *what a resume restores* can be tested on a machine with no torch —
which is the machine this was developed on.

What that buys: atomicity, key validation, pruning, latest/best selection,
RNG round-trip and exact data-stream continuation are all verified here.
What it does not buy: that a torch optimizer's state survives the trip.
`train_smoke.py` covers that, and prints UNVERIFIED without torch.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import dataset  # noqa: E402
from training.scripts import checkpoint as ckpt  # noqa: E402


def _have_torch() -> bool:
    """Asked at decoration time, so it must not raise on a box without torch."""
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


def state(step: int, tokens: int = 0, extra_losses=None) -> dict:
    """A state dict shaped like the one a real trainer writes.

    The optimizer and scheduler here carry the *values* a run at `step` would
    have, not just the keys. That is deliberate: `assert_state_fresh` compares
    values against the step, so a fixture whose optimizer is empty at step 500
    would be describing the defect rather than a healthy run, and every test
    built on it would be asserting against a fiction.
    """
    return {
        "model": {"w": np.arange(8, dtype=np.float32)},
        "optimizer": {"state": {0: {"step": np.int64(step)}},
                      "param_groups": [{"lr": 1e-3, "initial_lr": 3e-3}]},
        "scheduler": {"last_epoch": step, "_last_lr": [1e-3]},
        "scaler": {"scale": 512.0},
        "step": step, "epoch": 0,
        "config": {"vocab_size": 1024},
        "tokenizer_version": "test-v1",
        "rng": ckpt.capture_rng(),
        "data_cursor": {"tokens_consumed": tokens, "seed": 1, "split": "train",
                        "block": 8, "batch": 2, "rng": {"state": "x"},
                        "batches_drawn": 0},
        "loss_history": extra_losses or [1.0, 0.9, 0.8],
        "hyperparameters": {"grad_accum": 1, "steps": 100, "warmup": 10,
                            "batch": 2, "block": 8, "lr": 3e-3},
    }


class CheckpointManager(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.manager = ckpt.CheckpointManager(self.dir, keep_last=2)

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_and_required_files(self):
        self.manager.save(state(5), step=5, is_best=True)
        self.assertTrue(self.manager.exists("latest"))
        self.assertTrue(self.manager.exists("best"))
        self.assertTrue(self.manager.path("step_5").is_file())
        loaded = self.manager.load("latest")
        self.assertEqual(loaded["step"], 5)
        self.assertEqual(loaded["tokenizer_version"], "test-v1")
        np.testing.assert_array_equal(loaded["model"]["w"], np.arange(8, dtype=np.float32))
        self.assertIn("git_commit", loaded)
        self.assertIn("saved_at", loaded)

    def test_missing_keys_are_refused_on_save_and_on_load(self):
        broken = state(1)
        del broken["scaler"]
        with self.assertRaises(ckpt.MissingStateError) as ctx:
            self.manager.save(broken, step=1)
        self.assertIn("scaler", str(ctx.exception))

        # ...and a file written by some other process is refused too, rather
        # than resumed with a fresh optimizer.
        self.manager.serializer.save({"model": {}, "step": 3},
                                     self.manager.path("latest"))
        with self.assertRaises(ckpt.MissingStateError) as ctx:
            self.manager.load("latest")
        self.assertIn("optimizer", str(ctx.exception))

    def test_latest_and_best_are_independent(self):
        self.manager.save(state(3), step=3, is_best=True)
        self.manager.save(state(9), step=9)
        self.assertEqual(self.manager.load("best")["step"], 3)
        self.assertEqual(self.manager.load("latest")["step"], 9)

    def test_pruning_keeps_the_newest_n(self):
        for step in (1, 2, 3, 4, 5):
            self.manager.save(state(step), step=step)
        self.assertEqual(self.manager.steps(), [4, 5],
                         "keep_last=2 must retain the two newest step files")
        self.assertTrue(self.manager.exists("latest"))

    def test_no_temp_files_survive_a_save(self):
        for step in range(4):
            self.manager.save(state(step), step=step)
        leftovers = list(self.dir.glob("*.tmp*"))
        self.assertEqual(leftovers, [], f"temporary files left behind: {leftovers}")

    def test_a_missing_checkpoint_is_reported_not_guessed(self):
        with self.assertRaises(FileNotFoundError):
            self.manager.load("latest")
        self.assertIsNone(self.manager.info())

    def test_resolve_resume_modes(self):
        self.assertIsNone(ckpt.resolve_resume(self.manager, "none"))
        self.assertIsNone(ckpt.resolve_resume(self.manager, "auto"))
        self.manager.save(state(7), step=7)
        info = ckpt.resolve_resume(self.manager, "auto")
        self.assertEqual(info["which"], "latest")
        self.assertTrue(Path(info["path"]).is_file())
        explicit = ckpt.resolve_resume(self.manager, str(self.manager.path("step_7")))
        self.assertEqual(explicit["which"], "step_7")
        with self.assertRaises(FileNotFoundError):
            ckpt.resolve_resume(self.manager, str(self.dir / "nope.pt"))

    def test_summary_reports_the_run_shape(self):
        self.manager.save(state(2), step=2, is_best=True)
        summary = self.manager.summary()
        self.assertEqual(summary["steps"], [2])
        self.assertTrue(summary["has_latest"])
        self.assertIn(summary["serializer"], ("pickle", "torch"))


class _Live:
    """Stands in for an optimizer/scheduler/scaler: a `state_dict` and a tick."""

    def __init__(self, value):
        self.value = value

    def state_dict(self):
        return {"value": self.value}

    def tick(self):
        self.value += 1


class LiveObjectsAreRereadOnEverySave(unittest.TestCase):
    """The defect this class exists for, found 2026-10-02 on Stage A v2.

    The trainer built its state dict once at step 0 and refreshed only
    `loss_history`, `data_cursor` and `rng` before each save, so all 20,000
    steps of `latest.pt` carried an optimizer with no moments and a scheduler
    at `last_epoch` 0. Every required key was present, so the key check passed
    and the checkpoint looked resumable. The weights were fine; the run's
    optimizer and schedule were not in the file at all.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.opt, self.sched, self.scaler = _Live(0), _Live(0), _Live(0)
        self.manager = ckpt.CheckpointManager(
            self.dir, keep_last=5,
            live={"optimizer": self.opt, "scheduler": self.sched,
                  "scaler": self.scaler})

    def tearDown(self):
        self.tmp.cleanup()

    def _load(self, which="latest"):
        return self.manager.serializer.load(self.manager.path(which))

    def test_a_second_save_carries_the_newer_optimizer(self):
        # The state dict is built once and never touched, exactly as the
        # trainers build it. Only the live objects move. If `save` re-reads
        # them, the second checkpoint differs from the first.
        payload = state(0)
        self.manager.save(payload, step=8)
        first = self._load()["optimizer"]["value"]
        for _ in range(3):
            self.opt.tick()
            self.sched.tick()
        payload["step"] = 16
        self.manager.save(payload, step=16)
        second = self._load()
        self.assertEqual(first, 0)
        self.assertEqual(second["optimizer"]["value"], 3,
                         "the second save wrote a stale optimizer")
        self.assertEqual(second["scheduler"]["value"], 3,
                         "the second save wrote a stale scheduler")
        self.assertEqual(second["step"], 16)

    def test_the_scaler_is_refreshed_too(self):
        self.manager.save(state(8), step=8)
        self.scaler.tick()
        self.manager.save(state(16), step=16)
        self.assertEqual(self._load()["scaler"]["value"], 1)

    def test_a_name_the_manager_cannot_refresh_is_refused(self):
        # A typo here would be silently ignored and the checkpoint written
        # stale — the failure this mechanism exists to prevent.
        with self.assertRaises(ValueError) as ctx:
            ckpt.CheckpointManager(self.dir, live={"optimiser": _Live(0)})
        self.assertIn("optimiser", str(ctx.exception))

    def test_a_manager_without_live_objects_still_works(self):
        # The pure-logic tests build states by hand and must keep working;
        # `live` is an improvement, not a new requirement.
        plain = ckpt.CheckpointManager(self.dir / "plain", keep_last=2)
        plain.save(state(4), step=4)
        self.assertTrue(plain.exists("latest"))


class StaleStateIsRefused(unittest.TestCase):
    """Presence is not freshness: a key can be present and hold step 0's value."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.manager = ckpt.CheckpointManager(self.dir, keep_last=2)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_checkpoint_at_step_500_with_no_optimizer_moments_is_refused(self):
        stale = state(500)
        stale["optimizer"] = {"state": {}, "param_groups": [{"lr": 1e-6}]}
        with self.assertRaises(ckpt.StaleStateError) as ctx:
            self.manager.save(stale, step=500)
        self.assertIn("no moments", str(ctx.exception))
        self.assertFalse(self.manager.exists("latest"),
                         "a refused checkpoint was written anyway")

    def test_a_scheduler_stuck_at_last_epoch_zero_is_refused(self):
        stale = state(500)
        stale["scheduler"] = {"last_epoch": 0, "_last_lr": [1.5e-6]}
        with self.assertRaises(ckpt.StaleStateError) as ctx:
            self.manager.save(stale, step=500)
        self.assertIn("last_epoch", str(ctx.exception))

    def test_no_moments_before_the_first_optimizer_update_is_correct(self):
        # The false-positive guard, and the reason the check consults
        # `grad_accum` instead of asking whether the moments are non-empty. At
        # step 2 with grad_accum 8 nothing has been stepped yet, so an empty
        # optimizer is the truth and must be allowed through.
        early = state(2)
        early["optimizer"] = {"state": {}, "param_groups": [{"lr": 1e-6}]}
        early["scheduler"] = {"last_epoch": 0, "_last_lr": [1e-6]}
        early["hyperparameters"]["grad_accum"] = 8
        self.manager.save(early, step=2)
        self.assertTrue(self.manager.exists("latest"))

    def test_a_stale_checkpoint_written_by_an_older_trainer_is_refused_on_load(self):
        # `save` refuses to write one, so this is the other direction: a file
        # that already exists (v2's, on disk) must not be resumable either.
        stale = state(20_000)
        stale["optimizer"] = {"state": {}, "param_groups": [{"lr": 1.5e-6}]}
        stale["scheduler"] = {"last_epoch": 0, "_last_lr": [1.5e-6]}
        path = self.manager.path("latest")
        self.manager.serializer.save(stale, path)
        with self.assertRaises(ckpt.StaleStateError):
            self.manager.load("latest")

    def test_a_checkpoint_with_no_hyperparameters_is_refused_with_a_reason(self):
        bare = state(20_000)
        del bare["hyperparameters"]
        with self.assertRaises(ckpt.MissingStateError) as ctx:
            self.manager.save(bare, step=20_000)
        self.assertIn("hyperparameters", str(ctx.exception))

    def test_a_hyperparameter_record_missing_a_required_field_is_refused(self):
        # `estimate_budget.py --from-run` reads these out of the manifest, and
        # the staleness check reads grad_accum out of the checkpoint. A record
        # that has lost one is not a record.
        partial = state(20_000)
        del partial["hyperparameters"]["grad_accum"]
        with self.assertRaises(ckpt.MissingStateError) as ctx:
            self.manager.save(partial, step=20_000)
        self.assertIn("grad_accum", str(ctx.exception))

    def test_a_torch_optimizer_dict_with_its_state_key_dropped_is_stale(self):
        # The rule that stops `_optimizer_is_stale` returning None from being a
        # hole. `param_groups` is present, so this is a torch optimizer dict,
        # and a torch optimizer dict always has `state` — its absence means it
        # was stripped or never written.
        dropped = state(20_000)
        dropped["optimizer"] = {"param_groups": [{"lr": 1.5e-6}]}
        with self.assertRaises(ckpt.StaleStateError) as ctx:
            self.manager.save(dropped, step=20_000)
        self.assertIn("no moments", str(ctx.exception))

    def test_an_optimizer_dict_whose_shape_says_nothing_is_not_judged(self):
        # The other half: a dict that is not pretending to be a torch
        # optimizer cannot be called stale, and a check that called everything
        # stale would be a check nobody could satisfy.
        odd = state(20_000)
        odd["optimizer"] = {"value": 3}
        odd["scheduler"] = {"value": 3}
        self.manager.save(odd, step=20_000)
        self.assertTrue(self.manager.exists("latest"))

    def test_a_populated_optimizer_is_fresh(self):
        # The check must not be a ratchet that only ever fails.
        self.manager.save(state(20_000), step=20_000)
        loaded = self.manager.load("latest")
        self.assertEqual(loaded["step"], 20_000)
        self.assertTrue(loaded["optimizer"]["state"])

    def test_stale_is_reported_as_its_own_error(self):
        # One `except MissingStateError` in a caller would otherwise swallow
        # this, and the message about restoring Adam is worth surfacing.
        self.assertTrue(issubclass(ckpt.StaleStateError, ckpt.MissingStateError))
        self.assertIsNot(ckpt.StaleStateError, ckpt.MissingStateError)


class HyperparameterRecord(unittest.TestCase):
    def test_the_helper_carries_every_field_the_checks_read(self):
        from training.scripts.train_smoke import hyperparameters

        args = argparse.Namespace(steps=20000, batch=8, block=1024, lr=3e-4,
                                  warmup=200, grad_accum=8, clip=1.0,
                                  weight_decay=0.1, amp=True, device="cpu")
        record = hyperparameters(args)
        for field in ckpt.REQUIRED_HYPERPARAMS:
            self.assertIn(field, record)
        self.assertEqual(record["grad_accum"], 8)
        self.assertEqual(record["device"], "cpu")

    def test_a_device_the_machine_lacks_does_not_crash_the_record(self):
        from training.scripts.train_smoke import hyperparameters

        args = argparse.Namespace(steps=2, batch=1, block=8, lr=1e-3, warmup=1,
                                  grad_accum=1, clip=1.0, weight_decay=0.1,
                                  amp=False, device="cuda")
        record = hyperparameters(args)
        self.assertIn(record["device"], ("cpu", "cuda"))


class ARealOptimizerResumesIdentically(unittest.TestCase):
    """§7.5's "resume verified" for the thing v2 actually got wrong.

    The pipeline-only path proves the *bookkeeping* — atomicity, pruning,
    latest/best, the data cursor. None of it touches a torch optimizer, and
    that gap is how a 20,000-step run shipped a checkpoint whose optimizer had
    never been stepped. This runs the real objects.

    The claim is bit-identity, not "close enough": save at step N, restore into
    a fresh model/optimizer/scheduler/scaler, step N more, and require every
    weight to equal the uninterrupted run's. Anything less and a resume is a
    slightly different run, which is the defect in slow motion — `assertAlmostEqual`
    would pass a halved learning rate at low loss.
    """

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_the_continuation_is_bit_identical_to_an_uninterrupted_run(self):
        import torch

        from training.scripts.checkpoint import (CheckpointManager,
                                                 capture_rng, restore_rng)
        from training.scripts.train_smoke import (cosine_with_warmup,
                                                 schedule_span)

        def build():
            torch.manual_seed(1337)
            model = torch.nn.Sequential(torch.nn.Linear(8, 8), torch.nn.Tanh(),
                                        torch.nn.Linear(8, 4))
            optimizer = torch.optim.AdamW(model.parameters(), lr=3e-3,
                                          betas=(0.9, 0.95), weight_decay=0.1)
            scheduler = cosine_with_warmup(optimizer, *schedule_span(24, 4, 2))
            return model, optimizer, scheduler

        def advance(model, optimizer, scheduler, start, count):
            # The step index is passed in rather than seeded per call: a second
            # `advance` that re-seeded would replay the *first* twelve steps'
            # inputs, and the test would be measuring a model that saw the same
            # batch twice rather than a resume.
            for step in range(start, start + count):
                inputs = torch.arange(step, step + 8, dtype=torch.float32).reshape(1, 8)
                loss = model(inputs).pow(2).mean()
                loss.backward()
                if (step + 1) % 2 == 0:
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                    optimizer.step()
                    optimizer.zero_grad(set_to_none=True)
                    scheduler.step()

        # The uninterrupted reference: 24 optimizer steps, one schedule.
        model, optimizer, scheduler = build()
        advance(model, optimizer, scheduler, 0, 24)
        reference = [p.detach().clone() for p in model.parameters()]

        # The same run, cut in half at a save boundary.
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            model, optimizer, scheduler = build()
            manager = CheckpointManager(run_dir, keep_last=2,
                                        live={"optimizer": optimizer,
                                              "scheduler": scheduler})
            advance(model, optimizer, scheduler, 0, 12)
            state = {"model": model.state_dict(), "step": 12, "epoch": 0,
                     "config": {"vocab_size": 8},
                     "tokenizer_version": "test",
                     "data_cursor": {"tokens_consumed": 0},
                     "loss_history": [0.0] * 12,
                     "scaler": {"scale": 1.0},
                     "hyperparameters": {"grad_accum": 2, "steps": 24, "warmup": 4}}
            state["rng"] = capture_rng()
            # No optimizer/scheduler/scaler in the state dict: `live` supplies
            # them, and requiring a snapshot as well is the check firing on
            # correct code.
            manager.save(state, step=12, is_best=True)
            lr_at_save = optimizer.param_groups[0]["lr"]
            epoch_at_save = scheduler.state_dict()["last_epoch"]

            # A fresh process would build these from scratch and load — in the
            # order `train_smoke` uses, which matters (see the comment there).
            model2, optimizer2, scheduler2 = build()
            manager2 = CheckpointManager(run_dir, keep_last=2)
            loaded = manager2.load("latest")
            model2.load_state_dict(loaded["model"])
            optimizer2.load_state_dict(loaded["optimizer"])
            scheduler2.load_state_dict(loaded["scheduler"])
            restore_rng(loaded["rng"])
            self.assertEqual(loaded["step"], 12)
            self.assertEqual(scheduler2.state_dict()["last_epoch"], epoch_at_save)
            self.assertAlmostEqual(optimizer2.param_groups[0]["lr"], lr_at_save,
                                   places=15,
                                   msg="the restored optimizer disagrees with the "
                                       "restored schedule about the learning rate")

            advance(model2, optimizer2, scheduler2, 12, 12)

        for index, (want, got) in enumerate(zip(reference, model2.parameters())):
            self.assertTrue(
                torch.equal(want, got.detach()),
                f"parameter {index} diverged after resume: max |diff| = "
                f"{float((want - got.detach()).abs().max()):.3e}. A resume that "
                f"is merely close is a different run.")

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_the_resume_order_is_load_bearing_and_the_guard_says_so(self):
        # Reproduce the reversed order on purpose: build a fresh optimizer, let
        # a scheduler overwrite its rate, restore the scheduler's bookkeeping,
        # and require the guard to name the disagreement. Without this, the
        # two-line order in `train_smoke.train` is a convention; with it, a
        # refactor that swaps them fails loudly instead of training the first
        # window at the wrong rate.
        import torch

        from training.scripts.train_smoke import (_assert_schedule_agrees,
                                                 cosine_with_warmup,
                                                 schedule_span)

        model = torch.nn.Linear(4, 4)
        optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
        scheduler = cosine_with_warmup(optimizer, *schedule_span(200, 20, 8))
        for _ in range(30):
            optimizer.step()
            scheduler.step()
        saved = scheduler.state_dict()
        rate = float(saved["_last_lr"][0])

        # The reversed order: a fresh optimizer, then a fresh scheduler built
        # on it (which overwrites the rate), then the saved scheduler state.
        fresh = torch.optim.AdamW(model.parameters(), lr=3e-4)
        rebuilt = cosine_with_warmup(fresh, *schedule_span(200, 20, 8))
        rebuilt.load_state_dict(saved)
        self.assertNotAlmostEqual(fresh.param_groups[0]["lr"], rate, places=6,
                                  msg="this test no longer reproduces the "
                                      "disagreement it exists to catch")
        with self.assertRaises(SystemExit) as ctx:
            _assert_schedule_agrees(fresh, rebuilt)
        self.assertIn("wrong order", str(ctx.exception))

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_the_guard_is_silent_when_the_two_agree(self):
        # A guard that always raises is not a guard.
        import torch

        from training.scripts.train_smoke import (_assert_schedule_agrees,
                                                 cosine_with_warmup,
                                                 schedule_span)

        model = torch.nn.Linear(4, 4)
        optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4)
        scheduler = cosine_with_warmup(optimizer, *schedule_span(50, 5, 2))
        for _ in range(6):
            optimizer.step()
            scheduler.step()
        _assert_schedule_agrees(optimizer, scheduler)  # must not raise

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_loading_a_scheduler_restores_its_position_but_not_the_optimizer_lr(self):
        # torch's `LambdaLR.load_state_dict` restores `_last_lr` and
        # `last_epoch` and leaves `optimizer.param_groups['lr']` alone. That is
        # a trap for a resume, and the only thing standing between this
        # project and it is the *order* of two lines in the resume path:
        # `optimizer.load_state_dict` first (which restores `lr` from the file),
        # then `scheduler.load_state_dict` (which does not touch it).
        #
        # Recorded here as a measured property of the dependency rather than a
        # bug in this repository, because on v2 the file's `lr` was step 0's
        # 1.5e-6 — so the ordering was carrying the whole resume. Reversing the
        # two lines would train the first `grad_accum` window at the wrong rate
        # with no error, and this test is what would notice.
        import torch

        from training.scripts.train_smoke import (cosine_with_warmup,
                                                 schedule_span)

        model = torch.nn.Linear(4, 4)
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
        scheduler = cosine_with_warmup(optimizer, *schedule_span(100, 10, 2))
        for _ in range(20):
            optimizer.step()
            scheduler.step()
        saved = scheduler.state_dict()
        # LambdaLR steps once in its constructor, so 20 explicit steps land on
        # last_epoch 20.
        self.assertEqual(saved["last_epoch"], 20)
        rate_at_20 = float(saved["_last_lr"][0])

        fresh = cosine_with_warmup(optimizer, *schedule_span(100, 10, 2))
        self.assertEqual(fresh.state_dict()["last_epoch"], 0)
        # Constructing it over the *same* optimizer reset the lr, which is the
        # whole point: the schedule object owns the rate, and building a new
        # one silently overwrites it.
        self.assertNotAlmostEqual(optimizer.param_groups[0]["lr"], rate_at_20,
                                  places=6)
        fresh.load_state_dict(saved)
        self.assertEqual(fresh.state_dict()["last_epoch"], 20,
                         "the restored schedule restarted from the beginning")
        self.assertAlmostEqual(fresh.state_dict()["_last_lr"][0], rate_at_20,
                               places=15)
        # ...and the optimizer is still at the construction value, untouched.
        # Only an `optimizer.load_state_dict` puts it back.
        self.assertNotAlmostEqual(optimizer.param_groups[0]["lr"], rate_at_20,
                                  places=6)
        optimizer.load_state_dict({"state": optimizer.state_dict()["state"],
                                   "param_groups": [
                                       dict(optimizer.param_groups[0],
                                            lr=rate_at_20, initial_lr=1e-3)]})
        self.assertAlmostEqual(optimizer.param_groups[0]["lr"], rate_at_20,
                               places=15)


class TheLearningRateCurveHasOneDefinition(unittest.TestCase):
    """`tools/verify_checkpoint.py` must not restate the schedule it verifies.

    Its first version carried a copy of `cosine_with_warmup`'s arithmetic marked
    "verbatim", which is a copy of the thing being checked: change the curve and
    the tool goes on predicting the old one, reporting correctly-saved
    checkpoints as mismatched. The fix moved the curve to `train_smoke.lr_factor`
    and had the tool import it; these two tests are what stops the copy coming
    back.
    """

    VERIFIER = ROOT / "tools" / "verify_checkpoint.py"

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_the_scheduler_uses_the_shared_factor(self):
        """What this establishes, precisely — it is less than it looks.

        The scheduler is built *from* `lr_factor`, so comparing the two cannot
        tell whether the curve is *right*; it is close to tautological. What it
        does establish is the **wiring**: that `cosine_with_warmup` routes every
        step through the shared function rather than through a private closure.
        That is exactly the mutation it is here to catch — someone re-inlining
        the arithmetic, which would leave two curves again without deleting
        anything the AST test below could see.

        The curve's own properties are checked separately and only where they
        are actually falsifiable: the final assertion (it anneals to exactly
        zero) and `test_lr_schedule.py`, which replays the defect-3 case against
        the measured 0.967.
        """
        import torch

        from training.scripts.train_smoke import (cosine_with_warmup,
                                                 lr_factor)

        base, warmup, total = 3e-4, 5, 50
        model = torch.nn.Linear(2, 2)
        optimizer = torch.optim.AdamW(model.parameters(), lr=base)
        scheduler = cosine_with_warmup(optimizer, warmup, total)
        for step_index in range(0, total + 1):
            emitted = scheduler.get_last_lr()[0]
            expected = base * lr_factor(step_index, warmup, total)
            self.assertAlmostEqual(
                emitted, expected, places=18,
                msg=f"at scheduler step {step_index} the LambdaLR emitted "
                    f"{emitted:.6e} but lr_factor predicts {expected:.6e}")
            optimizer.step()
            scheduler.step()
        # ...and the curve really does reach zero, which is the property the
        # defect-3 fix exists to guarantee.
        self.assertEqual(lr_factor(total, warmup, total), 0.0)

    def test_the_verifier_does_not_define_its_own_curve(self):
        import ast

        tree = ast.parse(self.VERIFIER.read_text(encoding="utf-8"))
        names = {node.name for node in ast.walk(tree)
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        for banned in ("factor", "schedule_span", "lr_factor"):
            self.assertNotIn(
                banned, names,
                f"{self.VERIFIER.name} defines its own {banned}() again. A copy "
                f"of the curve is a copy of the thing being verified; import "
                f"`training.scripts.train_smoke.lr_factor` instead.")

    def test_the_verifier_imports_the_trainers_curve(self):
        source = self.VERIFIER.read_text(encoding="utf-8")
        self.assertIn("from training.scripts.train_smoke import lr_factor, schedule_span",
                      source,
                      "the verifier no longer imports the trainer's schedule, so "
                      "it is predicting some other curve")

    def test_reconstruct_recovers_a_known_schedule_from_a_known_rate(self):
        """The inference behind the v2 finding, tested on its own.

        `reconstruct` is the function that took v2's `peak/200` and named the
        `(grad_accum, warmup)` pair that could produce it. It runs on the one
        code path the rest of this file cannot reach — a checkpoint with no
        recorded hyperparameters — and that path is where a refactor of the
        imports left it raising `NameError` while every test stayed green. So
        it gets a test of its own, as pure logic with no torch and no file.
        """
        from tools.verify_checkpoint import reconstruct
        from training.scripts.train_smoke import lr_factor, schedule_span

        # A run that really used grad_accum 8 over 20,000 steps with a
        # 200-micro-step warmup, caught at scheduler step 137.
        peak = 3e-4
        warmup_u, updates = schedule_span(20_000, 200, 8)
        rate = peak * lr_factor(137, warmup_u, updates)
        assert rate != 0.0
        # The first argument is the run's `--steps` (20,000), not the step the
        # checkpoint was taken at. The first version of this test passed 137 for
        # both, which made the reported grad-accum depend on a schedule the run
        # never had — and it failed, which is how the same confusion in `main`
        # was found.
        found = reconstruct(20_000, 137, rate, peak, warmup=10,
                            factor=lr_factor, schedule_span=schedule_span)
        self.assertIsNotNone(found)
        self.assertLess(found["rel_error"], 1e-9)
        self.assertEqual(found["grad_accum"], 8)
        self.assertEqual(found["updates"], updates)

    def test_reconstruct_reports_a_large_residual_when_nothing_fits(self):
        # The other half: it must be able to say "none of these explain this
        # rate", because a search that always finds a close match is a search
        # that proves nothing about the file it is applied to.
        from tools.verify_checkpoint import reconstruct
        from training.scripts.train_smoke import lr_factor, schedule_span

        peak = 3e-4
        # At `last_epoch` 0 the warmup branch is the only reachable one, so the
        # explainable rates are `1/warmup_u` for integer `warmup_u`, plus 1.0.
        # That is a sparse set with its widest gap between 1/2 and 1/1, so 0.75
        # is the least explainable value available: the nearest candidates are
        # 0.5 and 1.0, giving a residual near a third.
        #
        # The first version of this test used 0.37, which looks arbitrary and is
        # within 9.9% of 1/3 — it failed, correctly, because the search *can*
        # explain it. Picking a value that nothing fits is the test's job.
        found = reconstruct(20_000, 0, peak * 0.75, peak, warmup=10,
                            factor=lr_factor, schedule_span=schedule_span)
        self.assertIsNotNone(found)
        self.assertGreater(found["rel_error"], 0.2,
                           "a rate nothing can explain was reported as explained")

    def test_reconstruct_declines_a_peak_of_zero(self):
        from tools.verify_checkpoint import reconstruct
        from training.scripts.train_smoke import lr_factor, schedule_span

        self.assertIsNone(reconstruct(20_000, 5, 0.0, 0.0, warmup=10,
                                      factor=lr_factor,
                                      schedule_span=schedule_span))

    def test_a_cut_run_is_not_read_as_a_completed_one(self):
        """The assumption that step == --steps, and why it has to be visible.

        A cosine built over 20,000 micro-steps and cut at 6,000 does not end at
        0, and its LR at the cut is not reachable by a cosine built over 6,000.
        So the *same recorded rate* yields two different grad-accum answers
        depending on which total is used — which is exactly the silent wrong
        answer the tool would have given the first time a session was cut short.
        """
        from tools.verify_checkpoint import reconstruct
        from training.scripts.train_smoke import lr_factor, schedule_span

        peak = 3e-4
        cut_at = 6_000
        warmup_u, updates = schedule_span(20_000, 200, 8)
        rate = peak * lr_factor(cut_at // 8, warmup_u, updates)
        self.assertNotEqual(rate, 0.0, "a cut run does not end at zero")

        right = reconstruct(20_000, cut_at // 8, rate, peak, warmup=10,
                            factor=lr_factor, schedule_span=schedule_span)
        wrong = reconstruct(cut_at, cut_at // 8, rate, peak, warmup=10,
                            factor=lr_factor, schedule_span=schedule_span)
        self.assertLess(right["rel_error"], 1e-9)
        self.assertEqual(right["grad_accum"], 8)
        self.assertGreater(wrong["rel_error"], 1e-6,
                           "the wrong total produced a fit as good as the right "
                           "one, so this test cannot tell them apart")

    @unittest.skipUnless(_have_torch(), "no torch on this machine")
    def test_main_uses_the_runs_own_total_not_the_checkpoint_step(self):
        """The wiring, not the arithmetic — and the case v3 may actually hit.

        A run cut short by the session cap has a checkpoint whose step is well
        below the `--steps` its cosine was built over. `reconstruct` needs the
        latter; the first version of `main` passed the former and was right only
        for runs that reached their end. So this fabricates a cut run and runs
        the tool twice, with and without `--total-steps`, and requires the
        answers to differ — a mutation that always passes the checkpoint's step
        makes them the same and fails here.
        """
        import torch

        from ai.model.config import smoke_config
        from tools.verify_checkpoint import main as verify_main
        from training.scripts.train_smoke import lr_factor, schedule_span

        peak = 3e-3
        cut_at, total = 6_000, 20_000
        warmup_u, updates = schedule_span(total, 200, 8)
        rate = peak * lr_factor(cut_at // 8, warmup_u, updates)
        self.assertNotEqual(rate, 0.0)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "latest.pt"
            torch.save({
                "model": {}, "step": cut_at, "epoch": 0,
                "config": smoke_config(1024).to_hf_config(),
                "tokenizer_version": "test", "rng": ckpt.capture_rng(),
                "data_cursor": {"tokens_consumed": 0},
                "loss_history": [0.0] * cut_at,
                "optimizer": {"state": {0: {"step": 1}},
                              "param_groups": [{"lr": rate, "initial_lr": peak}]},
                "scheduler": {"last_epoch": cut_at // 8, "_last_lr": [rate]},
                "scaler": {"scale": 1.0},
                # no hyperparameters: this is the inference path
            }, path)

            base = ["--ckpt", str(path), "--config", "smoke",
                    "--expect-params", "1820352", "--expect-vocab", "1024",
                    "--grad-accum-hint", "8"]

            def schedule_row(extra):
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer):
                    verify_main(base + extra)
                for line in buffer.getvalue().splitlines():
                    if "schedule" in line and ("inferred" in line or "reproduced" in line):
                        return line
                raise AssertionError(
                    f"no schedule row in the output:\n{buffer.getvalue()}")

            assumed = schedule_row([])
            stated = schedule_row(["--total-steps", str(total)])

        self.assertIn("PASS", stated, f"the correct total was rejected: {stated}")
        self.assertIn("grad_accum=8", stated)
        self.assertIn("FAIL", assumed,
                      f"assuming the checkpoint's step was enough to reach the "
                      f"right answer, so this test cannot tell them apart: "
                      f"{assumed}")

    def test_the_scheduler_is_not_built_from_a_private_copy(self):
        # The other half of the same risk, checked over the AST: the curve is
        # reached only through `lr_factor`, so a re-inlined closure cannot sit
        # beside the shared one looking like the same thing.
        import ast

        tree = ast.parse((ROOT / "training" / "scripts" / "train_smoke.py")
                         .read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name != "cosine_with_warmup":
                continue
            # `ast.walk` yields the node itself, so exclude it: the question is
            # whether cosine_with_warmup defines a *nested* function, and the
            # first version of this guard flagged the outer one and failed.
            inner = [n.name for n in ast.walk(node)
                     if isinstance(n, ast.FunctionDef) and n is not node]
            self.assertEqual(
                inner, [],
                f"cosine_with_warmup defines {inner} again — the schedule has two "
                f"definitions, and the verifier only follows one of them")
            return
        self.fail("cosine_with_warmup is gone; update this guard")


class ThereIsExactlyOneWayToWriteACheckpoint(unittest.TestCase):
    """Every `manager.save` lives in a `_snapshot`, in both trainers.

    The 2026-10-02 defect needed three save sites to all forget the same three
    fields, and the final save forgot a fourth. `CheckpointManager(live=…)`
    closes the optimizer/scheduler/scaler half of that by making them
    impossible to pass wrongly; this closes the rest, by making "refresh the
    moving fields, then save" a single function nobody can partially copy.

    Checked over the AST rather than the text. `assertIn("_snapshot(", source)`
    would pass on a file that also contained a fourth, inline save — the
    substring would still be there, which is the failure mode this project has
    now hit three times. Here an added save site fails the check.
    """

    TRAINERS = ("training/scripts/train_smoke.py", "training/scripts/train_stage_b.py")

    # Only the training loop is constrained. `pipeline_checks` and
    # `verify_resume_semantics` also call `manager.save`, on purpose: they are
    # the torch-free demonstration that atomicity, pruning and latest/best
    # selection work, and they save synthetic `_fake_state` dicts with no live
    # optimizer behind them. Requiring them to go through `_snapshot` would be
    # requiring a real training checkpoint's refresh list to describe a
    # fixture. Scoping the rule to `train` is what makes it enforceable at all.
    LOOP = "train"

    def _saves_outside_snapshot(self, path: Path) -> list[str]:
        import ast

        tree = ast.parse(path.read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name != self.LOOP:
                continue
            for inner in ast.walk(node):
                if (isinstance(inner, ast.Call)
                        and isinstance(inner.func, ast.Attribute)
                        and inner.func.attr == "save"
                        and isinstance(inner.func.value, ast.Name)
                        and "manager" in inner.func.value.id.lower()):
                    offenders.append(f"line {inner.lineno}")
        return offenders

    def test_the_training_loop_saves_only_through_snapshot(self):
        for rel in self.TRAINERS:
            with self.subTest(trainer=rel):
                offenders = self._saves_outside_snapshot(ROOT / rel)
                self.assertEqual(
                    offenders, [],
                    f"{rel} writes a checkpoint inline in {self.LOOP}(): "
                    f"{offenders}. Every field that moves between saves has to "
                    f"be refreshed in the same place, or one call site will "
                    f"forget — which is how the final save lost its RNG state.")

    def test_snapshot_refreshes_all_three_moving_fields(self):
        # The fields `CheckpointManager` cannot refresh for us. Listed here so
        # that adding a fourth one without adding it to `_snapshot` is a visible
        # omission in review rather than a silent divergence between trainers.
        import ast

        for rel in self.TRAINERS:
            with self.subTest(trainer=rel):
                tree = ast.parse((ROOT / rel).read_text(encoding="utf-8"))
                found = {None}
                for node in ast.walk(tree):
                    if not isinstance(node, ast.FunctionDef) or node.name != "_snapshot":
                        continue
                    for inner in ast.walk(node):
                        if isinstance(inner, ast.Assign) and len(inner.targets) == 1:
                            target = inner.targets[0]
                            if (isinstance(target, ast.Subscript)
                                    and isinstance(target.value, ast.Name)
                                    and target.value.id == "state"):
                                key = target.slice
                                if isinstance(key, ast.Constant):
                                    found.add(key.value)
                for key in ("loss_history", "data_cursor", "rng"):
                    self.assertIn(key, found,
                                  f"{rel} _snapshot does not refresh {key!r}")


class Rng(unittest.TestCase):
    def test_capture_and_restore_reproduce_the_same_numbers(self):
        ckpt.restore_rng(ckpt.capture_rng())
        random.seed(1234)
        np.random.seed(1234)
        before = [random.random(), float(np.random.rand())]
        saved = ckpt.capture_rng()
        first = [random.random(), float(np.random.rand())]
        [random.random(), float(np.random.rand())]  # drift the stream
        ckpt.restore_rng(saved)
        second = [random.random(), float(np.random.rand())]
        self.assertNotEqual(before, first)
        self.assertEqual(first, second, "RNG state did not round-trip")

    def test_torch_key_is_present_and_absent_cleanly(self):
        captured = ckpt.capture_rng()
        self.assertIn("torch", captured)
        try:
            import torch  # noqa: F401

            self.assertIsNotNone(captured["torch"])
        except ImportError:
            self.assertIsNone(captured["torch"],
                              "without torch the key must be None, not missing")


class RunManifest(unittest.TestCase):
    def test_manifest_records_reproducibility_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = ckpt.write_run_manifest(tmp, {"seed": 1337, "config": {"vocab_size": 1024}})
            data = json.loads(path.read_text(encoding="utf-8"))
            for key in ("seed", "config", "git_commit", "written_at", "python"):
                self.assertIn(key, data)
            self.assertEqual(data["seed"], 1337)
            self.assertEqual(path.name, "RUN_MANIFEST.json")


def make_shards(root: Path, docs: int = 40, length: int = 64) -> Path:
    """Synthetic uint16 shards + manifest, shaped exactly like the real ones."""
    root.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    files = []
    for index in range(3):
        name = f"train-{index:05d}.bin"
        data = rng.integers(0, 1024, size=length, dtype=np.uint16)
        (root / name).write_bytes(data.tobytes())
        files.append({"file": name, "docs": docs // 3, "tokens": length,
                      "sha256": "test", "langs": {"en": docs // 3}})
    val = rng.integers(0, 1024, size=length, dtype=np.uint16)
    (root / "val-00000.bin").write_bytes(val.tobytes())
    manifest = {
        "dtype": "uint16", "vocab_size": 1024, "end_token_id": 4,
        "shards": {
            "train": {"docs": docs, "tokens": length * 3, "files": files},
            "val": {"docs": 1, "tokens": length,
                    "files": [{"file": "val-00000.bin", "docs": 1, "tokens": length,
                               "sha256": "test", "langs": {"en": 1}}]},
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


class DataCursor(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = make_shards(Path(self.tmp.name) / "shards")

    def tearDown(self):
        self.tmp.cleanup()

    def test_batch_shapes_and_supervision_shift(self):
        shards = dataset.ShardSet.load(self.root)
        batcher = dataset.TokenBatcher(shards, block=8, batch=3, seed=5)
        xs, ys = batcher.next_batch()
        self.assertEqual(xs.shape, (3, 8))
        self.assertEqual(ys.shape, (3, 8))
        np.testing.assert_array_equal(xs[0][1:], ys[0][:-1],
                                      "targets must be the inputs shifted by one")

    def test_resume_continues_the_exact_stream(self):
        shards = dataset.ShardSet.load(self.root)
        original = dataset.TokenBatcher(shards, block=8, batch=2, seed=11)
        original.next_batches(4)
        snapshot = original.state()
        uninterrupted = [x.copy() for x, _ in original.next_batches(6)]

        resumed = dataset.TokenBatcher.resume(shards, snapshot)
        continued = [x.copy() for x, _ in resumed.next_batches(6)]

        self.assertEqual(len(continued), 6)
        for index, (a, b) in enumerate(zip(uninterrupted, continued)):
            np.testing.assert_array_equal(a, b, f"batch {index} diverged after resume")

    def test_resume_refuses_a_mismatched_geometry(self):
        shards = dataset.ShardSet.load(self.root)
        batcher = dataset.TokenBatcher(shards, block=8, batch=2, seed=3)
        snapshot = batcher.state()
        other = dataset.TokenBatcher(shards, block=16, batch=2, seed=3)
        with self.assertRaises(ValueError):
            other.load_state(snapshot)
        self.assertAlmostEqual(snapshot["tokens_consumed"], 0.0)

    def test_tokens_consumed_tracks_the_cursor(self):
        shards = dataset.ShardSet.load(self.root)
        batcher = dataset.TokenBatcher(shards, block=8, batch=5, seed=2)
        batcher.next_batches(3)
        self.assertEqual(batcher.state()["tokens_consumed"], 3 * 5 * 8)
        self.assertEqual(batcher.state()["batches_drawn"], 3)

    def test_validation_batches_do_not_advance_the_cursor(self):
        shards = dataset.ShardSet.load(self.root)
        batcher = dataset.TokenBatcher(shards, block=8, batch=2, seed=9)
        batcher.next_batch()
        before = batcher.state()
        val = batcher.validation_batches(3)
        self.assertEqual(len(val), 3)
        after = batcher.state()
        np.testing.assert_array_equal(val[0][0], batcher.validation_batches(3)[0][0],
                                      "validation sampling must be repeatable")
        self.assertEqual(json.dumps(after["rng"], sort_keys=True, default=str),
                         json.dumps(before["rng"], sort_keys=True, default=str),
                         "the validation sample must not move the training cursor")

    def test_too_little_data_is_an_error_not_a_silent_zero(self):
        root = make_shards(Path(self.tmp.name) / "tiny", docs=1, length=4)
        shards = dataset.ShardSet.load(root)
        with self.assertRaises(ValueError):
            dataset.TokenBatcher(shards, block=128, batch=1)


if __name__ == "__main__":
    unittest.main()
