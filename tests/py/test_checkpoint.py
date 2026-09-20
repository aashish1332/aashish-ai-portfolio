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
    return {
        "model": {"w": np.arange(8, dtype=np.float32)},
        "optimizer": {"step": np.int64(step)},
        "scheduler": {"last_lr": 1e-3},
        "scaler": {"scale": 512.0},
        "step": step, "epoch": 0,
        "config": {"vocab_size": 1024},
        "tokenizer_version": "test-v1",
        "rng": ckpt.capture_rng(),
        "data_cursor": {"tokens_consumed": tokens, "seed": 1, "split": "train",
                        "block": 8, "batch": 2, "rng": {"state": "x"},
                        "batches_drawn": 0},
        "loss_history": extra_losses or [1.0, 0.9, 0.8],
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
