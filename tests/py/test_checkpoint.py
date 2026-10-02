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
