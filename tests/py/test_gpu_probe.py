"""tests/py/test_gpu_probe.py — will this config fit, and how fast is it?

`gpu_probe.py` exists because the §7.5 smoke run passed and Stage A still died
at step 1 with `OutOfMemoryError` (measured, Kaggle T4, 2026-10-02). The smoke
run trains a 4,769,472-parameter, 4-layer, ctx-256 model at 4 x 128; Stage A
trains a 37,890,560-parameter, 10-layer, ctx-1024 model. Nothing in the smoke
run scales with what ran out of memory, so nothing in it could have predicted
the crash. These tests are about the probe's own contract, on CPU, because a
guard that has only ever been exercised on a GPU nobody has is a guard that
has never run.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ai.model import plan  # noqa: E402
from ai.model.config import CONFIG_A  # noqa: E402
from tests.py import HAVE_SEED_SHARDS, SEED_SHARDS_MISSING  # noqa: E402
from training.scripts import estimate_budget as eb  # noqa: E402
from training.scripts import gpu_probe as gp  # noqa: E402
from training.scripts.train_smoke import resolve_config  # noqa: E402

SEED_TOKENIZER = "ai/tokenizer/artifacts/seed-1k"
SEED_SHARDS = "data/processed/seed/shards"


def seed_vocab_size() -> int:
    from ai.tokenizer.train import load

    _tokenizer, meta = load(str(ROOT / SEED_TOKENIZER))
    return int(meta["vocab_size"])


def _have_torch() -> bool:
    try:
        import torch  # noqa: F401, PLC0415

        return True
    except ImportError:
        return False


class CpuRun(unittest.TestCase):
    """A real probe on CPU: a tiny config, a few steps, the whole JSON."""

    def _probe(self, *extra: str) -> tuple[dict, str]:
        argv = ["--config", "smoke", "--tokenizer", SEED_TOKENIZER,
                "--shards", SEED_SHARDS, "--batch", "2", "--block", "128",
                "--grad-accum", "1", "--steps", "2", "--device", "cpu", *extra]
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = gp.main(argv)
        self.assertEqual(code, 0, buffer.getvalue())
        return code, buffer.getvalue()

    @unittest.skipUnless(_have_torch(), "torch is not installed")
    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    def test_it_measures_and_reports_a_config_it_ran(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "probe.json"
            _code, text = self._probe("--json", str(out))
            result = json.loads(out.read_text(encoding="utf-8"))

        self.assertEqual(result["config"], "smoke")
        expected = plan.counts(resolve_config("smoke", seed_vocab_size()))["total"]
        self.assertEqual(result["params"], expected,
                         "the probe must report the parameter count it actually "
                         "built, since that is the field the budget tool checks")
        self.assertEqual(result["steps_completed"], 2)
        self.assertGreater(result["tokens_per_second"], 0)
        self.assertEqual(result["tokens_per_step"], 2 * 128)
        self.assertIsNone(result["oom"])
        # The point of the exercise: the number is this model's, and it says so.
        self.assertIn("this model's", text)
        self.assertIn("throughput", text)

    @unittest.skipUnless(_have_torch(), "torch is not installed")
    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    def test_a_probe_json_is_accepted_by_the_budget_tool(self):
        """The two tools are a contract. If the probe stopped recording
        `params`, `estimate_budget` would refuse every real measurement — and
        that refusal would only be discovered on a Kaggle session, an hour into
        a run."""
        with tempfile.TemporaryDirectory() as tmp:
            probe_path = Path(tmp) / "probe.json"
            self._probe("--json", str(probe_path))
            est_path = Path(tmp) / "est.json"
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = eb.main(["--config", "smoke", "--from-run", str(probe_path),
                                "--hours", "1", "--json", str(est_path)])
            self.assertEqual(code, 0)
            measured_on = json.loads(est_path.read_text(encoding="utf-8"))["measured_on"]
        self.assertIn("smoke", measured_on)

    @unittest.skipUnless(_have_torch(), "torch is not installed")
    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    def test_step_reporting_is_bounded(self):
        """A probe is not a run, and its output lives in a notebook cell. Twenty
        steps must not become twenty lines."""
        self.assertEqual(gp.MAX_REPORTED_STEPS, 10)
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            gp.main(["--config", "smoke", "--tokenizer", SEED_TOKENIZER,
                     "--shards", SEED_SHARDS, "--batch", "1", "--block", "64",
                     "--grad-accum", "1", "--steps", "14", "--device", "cpu"])
        text = buffer.getvalue()
        self.assertIn("more steps)", text)
        self.assertEqual(text.count("  step "), gp.MAX_REPORTED_STEPS)


class OutOfMemory(unittest.TestCase):
    """The probe's whole reason for existing is the answer 'no'.

    A probe that only knows how to succeed is not a probe. The OOM path is
    driven here by raising the same exception torch raises, because a CPU-only
    machine cannot make a real 15 GiB card run out of memory on demand.
    """

    @unittest.skipUnless(_have_torch(), "torch is not installed")
    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    def test_an_oom_is_a_result_not_a_traceback(self):
        import torch

        from ai.data import dataset as dataset_module

        original = dataset_module.TokenBatcher.next_batch

        def explode(self):  # noqa: ANN001, ANN202
            raise torch.cuda.OutOfMemoryError(
                "CUDA out of memory. Tried to allocate 1024.00 MiB.")

        dataset_module.TokenBatcher.next_batch = explode
        try:
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = gp.main(["--config", "smoke", "--tokenizer", SEED_TOKENIZER,
                                "--shards", SEED_SHARDS, "--batch", "2",
                                "--block", "128", "--steps", "2", "--device", "cpu"])
            text = buffer.getvalue()
        finally:
            dataset_module.TokenBatcher.next_batch = original

        self.assertEqual(code, 1, "a config that does not fit must not exit 0")
        self.assertIn("DOES NOT FIT", text)
        self.assertIn("halve --batch", text)
        self.assertNotIn("Traceback", text)

    @unittest.skipUnless(_have_torch(), "torch is not installed")
    @unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
    def test_the_json_records_the_failure(self):
        import torch

        from ai.data import dataset as dataset_module

        original = dataset_module.TokenBatcher.next_batch
        dataset_module.TokenBatcher.next_batch = lambda self: (_ for _ in ()).throw(
            torch.cuda.OutOfMemoryError("CUDA out of memory."))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "probe.json"
                with redirect_stdout(io.StringIO()):
                    gp.main(["--config", "smoke", "--tokenizer", SEED_TOKENIZER,
                             "--shards", SEED_SHARDS, "--batch", "2",
                             "--block", "128", "--steps", "1", "--device", "cpu",
                             "--json", str(out)])
                result = json.loads(out.read_text(encoding="utf-8"))
        finally:
            dataset_module.TokenBatcher.next_batch = original

        self.assertEqual(result["steps_completed"], 0)
        self.assertIsNotNone(result["oom"])


class Defaults(unittest.TestCase):
    def test_the_defaults_are_the_settings_stage_a_will_train_at(self):
        """`gpu_probe` with no flags must ask the question Stage A needs
        answered. Defaults that disagree with the training command produce a
        green probe of a run that is not happening."""
        defaults = {a.dest: a.default for a in gp.build_parser()._actions}
        self.assertEqual(defaults["batch"], 8)
        self.assertEqual(defaults["block"], 1024)
        self.assertEqual(defaults["grad_accum"], 8)
        self.assertEqual(defaults["config"], "A")
        self.assertEqual(defaults["steps"], 5,
                         "five steps is enough to fill the allocator; this is not "
                         "a training run")

    def test_config_a_defaults_agree_with_the_training_script(self):
        from training.scripts import train_stage_a as tsa

        self.assertEqual(tsa.STAGE_A_DEFAULTS["--batch"], "8")
        self.assertEqual(tsa.STAGE_A_DEFAULTS["--block"], "1024")
        self.assertEqual(tsa.STAGE_A_DEFAULTS["--grad-accum"], "8")
        product = (int(tsa.STAGE_A_DEFAULTS["--batch"])
                   * int(tsa.STAGE_A_DEFAULTS["--block"])
                   * int(tsa.STAGE_A_DEFAULTS["--grad-accum"]))
        self.assertEqual(product, 65_536,
                         "the learning update must stay at 65,536 tokens: the "
                         "micro-batch was halved to fit in memory, and grad-accum "
                         "is what stops that changing what the model learns from")


if __name__ == "__main__":
    unittest.main()
