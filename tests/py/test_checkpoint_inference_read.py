"""Does `load_for_inference` fix the crash that killed Stage B v1's cell 17?

Measured 2026-10-03 on kernel `training-stage-b` v1. The run completed all
3,000 steps, wrote `latest.pt`, and then:

    training.scripts.checkpoint.MissingStateError: latest.pt is missing
    ['optimizer', 'scheduler', 'scaler', 'data_cursor', 'loss_history',
    'hyperparameters'] — it was written by a different (or older) trainer and
    resuming from it would silently change the run

raised out of `inference/sample_answers.py`. So the strictness that caught the
v2 staleness defect also made a finished checkpoint unreadable for the one thing
it was produced for.

Both halves are tested, because the fix is wrong in a different way if it only
does the easy half: a weights-only reader that stopped refusing *everything*
would let a genuinely broken file be sampled from and reported as a model.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ckpt = _load(ROOT / "training" / "scripts" / "checkpoint.py", "ckpt_inference_read")


def _payload(**overrides):
    """A checkpoint with every resumable key, as a real trainer writes."""
    state = {
        "model": {"weight": [1.0, 2.0]},
        "config": {"vocab_size": 16},
        "optimizer": {"state": {1: {"step": 3}}},
        "scheduler": {"last_epoch": 3},
        "scaler": {"scale": 1.0},
        "step": 3,
        "epoch": 1,
        "tokenizer_version": "portfolio-bpe-16k-test",
        "rng": {"python": 7},
        "data_cursor": {"tokens_consumed": 96},
        "loss_history": [3.0, 2.0, 1.0],
        "hyperparameters": {"steps": 3},
    }
    state.update(overrides)
    return state


class InferenceReadsWhatResumingRefuses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = Path(self.tmp.name)
        self.manager = ckpt.CheckpointManager(self.run_dir)

    def _write(self, state, which="latest"):
        # Through the manager's own serializer, not `pickle.dump`. This bit me
        # writing the first draft of this file: torch *is* installed here, so the
        # manager reads with torch, and a hand-written pickle file comes back as
        # `RuntimeError: Invalid magic number; corrupt file?` - the exact failure
        # `train_stage_b.read_weights`'s docstring describes, where a perfectly
        # good file is called corrupt by a reader that assumed too much. The
        # serializer is chosen from the machine, so the test must use whichever
        # one this machine has and must not care which it is.
        self.manager.serializer.save(state, self.manager.path(which))

    def test_a_weights_only_file_is_readable_for_inference(self):
        # The v1 shape: `publish_checkpoint --weights-only` strips the optimizer
        # and scheduler, so exactly these six keys are absent.
        stripped = {k: v for k, v in _payload().items()
                    if k not in ckpt.REQUIRED_STATE_KEYS
                    or k in ("model", "config", "step", "tokenizer_version")}
        self._write(stripped)
        with self.assertRaises(ckpt.MissingStateError):
            self.manager.load("latest")   # the resume path still refuses
        state = self.manager.load_for_inference("latest")  # inference does not
        self.assertIn("weight", state["model"])

    def test_a_file_missing_the_weights_is_still_refused(self):
        # The other half: reading fewer keys must not mean accepting anything.
        state = _payload()
        del state["model"]
        self._write(state)
        with self.assertRaises(ckpt.MissingStateError) as caught:
            self.manager.load_for_inference("latest")
        self.assertIn("model", str(caught.exception))
        self.assertIn("cannot be sampled from", str(caught.exception))

    def test_the_error_says_a_whole_run_is_not_sampleable(self):
        # The mutation runner keys on the assertion's own `msg`, so this exists
        # to carry the phrase the evidence string is written against. It is not
        # decoration: it is what a reader sees, and "it was written by a
        # different (or older) trainer" is actively misleading for a file this
        # trainer wrote ten minutes earlier and which is perfectly good for
        # sampling.
        state = _payload()
        del state["model"]
        self._write(state)
        with self.assertRaises(ckpt.MissingStateError) as caught:
            self.manager.load_for_inference("latest")
        self.assertIn("cannot be sampled from", str(caught.exception),
                      "a weights-only reader must not reuse the resume "
                      "path's wording, which blames the file's age")

    def test_a_file_missing_the_config_is_still_refused(self):
        state = _payload()
        del state["config"]
        self._write(state)
        with self.assertRaises(ckpt.MissingStateError):
            self.manager.load_for_inference("latest")

    def test_a_stale_but_complete_file_is_readable_without_pretending_it_is_resumable(self):
        # The v3 shape: zero optimizer tensors. Inference does not care, and the
        # guard must not fire here — but the file must still be describable as
        # non-resumable by whatever inspects it.
        stale = _payload(optimizer={"state": {}})
        self._write(stale)
        state = self.manager.load_for_inference("latest")
        self.assertEqual(state["optimizer"]["state"], {})
        with self.assertRaises(ckpt.StaleStateError):
            self.manager.load("latest")

    def test_a_payload_that_is_not_a_dict_is_named_as_such(self):
        self.manager.serializer.save([1, 2, 3], self.manager.path("latest"))
        with self.assertRaises(ckpt.MissingStateError) as caught:
            self.manager.load_for_inference("latest")
        self.assertIn("did not load as a state dict", str(caught.exception))

    def test_a_missing_file_is_a_plain_file_error(self):
        with self.assertRaises(FileNotFoundError):
            self.manager.load_for_inference("latest")

class TheCallerThatActuallyCrashedUsesTheWeightsReader(unittest.TestCase):
    """`export_browser.load_checkpoint` is the function that raised.

    The rest of this file tests `CheckpointManager.load_for_inference` directly,
    which would have passed with `export_browser` still calling `load` — and
    that is the code which produced the v1 traceback:

        File ".../inference/sample_answers.py", line 93, in sample
          state, cfg, provenance = load_checkpoint(run_dir, which)
        File ".../inference/export_browser.py", line 416, in load_checkpoint
          payload = manager.load(which)

    So this drives the real caller against a real weights-only directory. The
    difference matters: fixing the method and leaving the one caller that
    needed it untouched is the exact shape of a fix that measures 7/7 and
    changes nothing.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = Path(self.tmp.name)
        # A real config, not a hand-written dict: `ModelConfig.from_hf` reads
        # more fields than the eight I first put here, and the first draft of
        # this test failed on the config rather than on the thing it was
        # written to prove.
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from ai.model.config import CONFIGS

        manager = ckpt.CheckpointManager(self.run_dir)
        stripped = {
            "model": {"weight": [1.0, 2.0]},
            "config": CONFIGS["smoke"].to_hf_config(),
            "step": 3000,
            "tokenizer_version": "portfolio-bpe-16k-test",
            "saved_at": 1790994163.0,
            "git_commit": "abc1234",
        }
        manager.serializer.save(stripped, manager.path("latest"))

    def test_load_checkpoint_reads_a_weights_only_run_directory(self):
        export = _load(ROOT / "inference" / "export_browser.py",
                       "export_browser_infer")
        from ai.model.config import CONFIGS

        state, cfg, provenance = export.load_checkpoint(self.run_dir, "latest")
        self.assertIn("weight", state)
        self.assertEqual(cfg.vocab_size, CONFIGS["smoke"].vocab_size)
        self.assertEqual(provenance["gitCommit"], "abc1234")

    def test_the_source_still_names_the_weights_reader(self):
        # Belt to the test above's braces: that test loads the module from disk
        # on every run, so it cannot pass while `export_browser` still calls
        # `load`. This states the same fact in the file a reader opens first.
        source = (ROOT / "inference" / "export_browser.py").read_text(
            encoding="utf-8")
        self.assertIn("manager.load_for_inference(which)", source,
                      "export_browser reads through the resume path again, so a "
                      "weights-only checkpoint raises MissingStateError - the "
                      "Stage B v1 failure")


class TheTwoReadersStillMeanDifferentThings(unittest.TestCase):
    def test_the_inference_keys_are_a_strict_subset_of_the_resume_keys(self):
        # If this ever stops being true, one of the two readers is demanding
        # something the other does not, and the split has silently collapsed.
        self.assertLess(len(ckpt.INFERENCE_STATE_KEYS),
                        len(ckpt.REQUIRED_STATE_KEYS),
                        "the inference and resume key sets must stop being "
                        "identical: `load_for_inference` has become `load`, and "
                        "the Stage B v1 crash is back")
        self.assertTrue(set(ckpt.INFERENCE_STATE_KEYS)
                        < set(ckpt.REQUIRED_STATE_KEYS),
                        "the inference key set must be a strict subset of the "
                        "resume key set, or the two readers have stopped "
                        "meaning different things")


if __name__ == "__main__":
    unittest.main()