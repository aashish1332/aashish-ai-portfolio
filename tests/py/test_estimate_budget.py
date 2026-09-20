"""tests/py/test_estimate_budget.py — §7.3's token-budget decision.

The point of this module is that the budget is arithmetic on a *measurement*,
so the tests check the arithmetic on inputs a person can verify by hand, and
that a missing measurement is an error rather than a default.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.model import plan  # noqa: E402
from ai.model.config import CONFIG_A  # noqa: E402
from training.scripts import estimate_budget as eb  # noqa: E402


class BudgetArithmetic(unittest.TestCase):
    def test_hand_checkable_case(self):
        # 1000 tok/s for 1 hour with no overhead → 3.6M tokens, 10 tokens/step
        est = eb.budget(CONFIG_A, 1000.0, 1.0, block=10, batch=1, overhead=0.0)
        self.assertEqual(est["usable_seconds"], 3600)
        self.assertEqual(est["tokens_reachable"], 3_600_000)
        self.assertEqual(est["tokens_per_step"], 10)
        self.assertAlmostEqual(est["seconds_per_step"], 0.01)
        self.assertAlmostEqual(est["steps_reachable"], 360_000)
        self.assertEqual(est["tokens_per_param"], 3_600_000 / plan.counts(CONFIG_A)["total"])

    def test_overhead_is_reserved_not_ignored(self):
        full = eb.budget(CONFIG_A, 1000.0, 1.0, overhead=0.0)
        haircut = eb.budget(CONFIG_A, 1000.0, 1.0, overhead=0.10)
        self.assertAlmostEqual(haircut["tokens_reachable"], full["tokens_reachable"] * 0.9)

    def test_reference_ratio_is_20_tokens_per_param(self):
        est = eb.budget(CONFIG_A, 1000.0, 1.0)
        self.assertEqual(est["reference_tokens"],
                         20 * plan.counts(CONFIG_A)["total"])
        self.assertAlmostEqual(est["reference_tokens_per_param"], 20)

    def test_reference_fits_verdict_flips_on_the_available_hours(self):
        # config A is ~37.9M params, so 20 tokens/param ≈ 758M tokens.
        # At 23,000 tok/s that is ~9.1 GPU hours.
        slow = eb.budget(CONFIG_A, 23_000.0, 9.0)
        self.assertFalse(slow["reference_fits"])
        self.assertGreater(slow["reference_hours_needed"], 9.0)
        fast = eb.budget(CONFIG_A, 26_000.0, 12.0)
        self.assertTrue(fast["reference_fits"])

    def test_corpus_passes_and_hours_per_epoch(self):
        est = eb.budget(CONFIG_A, 10_000.0, 4.0, dataset_tokens=1_000_000, overhead=0.0)
        self.assertAlmostEqual(est["epochs_reachable"], 144_000_000 / 1_000_000)
        # 1M tokens at 10k tok/s is 100 s, i.e. 100/3600 h — a fifth of a minute,
        # not a hundred hours, which is the kind of slip this test exists for.
        self.assertAlmostEqual(est["hours_per_epoch"], 100 / 3600)

    def test_no_dataset_means_no_epoch_claims(self):
        est = eb.budget(CONFIG_A, 10_000.0, 4.0)
        self.assertIsNone(est["epochs_reachable"])
        self.assertNotIn("hours_per_epoch", est)

    def test_zero_throughput_is_refused(self):
        for value in (0.0, -5.0):
            with self.assertRaises(ValueError, msg=f"{value} should be refused"):
                eb.budget(CONFIG_A, value, 9.0)

    def test_report_prints_a_decision(self):
        import io

        buffer = io.StringIO()
        eb.report(eb.budget(CONFIG_A, 4200.0, 9.0), stream=buffer)
        text = buffer.getvalue()
        self.assertIn("tokens/s", text)
        self.assertIn("tokens/param", text)
        self.assertIn("decision", text)

    def test_report_says_so_when_the_reference_does_not_fit(self):
        import io

        buffer = io.StringIO()
        eb.report(eb.budget(CONFIG_A, 4200.0, 9.0), stream=buffer)
        self.assertIn("does NOT fit", buffer.getvalue())


class Inputs(unittest.TestCase):
    def test_dataset_tokens_reads_a_shard_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(json.dumps({"shards": {"train": {"tokens": 749_590}}}),
                            encoding="utf-8")
            self.assertEqual(eb.dataset_tokens_from(path), 749_590)
            self.assertEqual(eb.dataset_tokens_from(Path(tmp)), 749_590)

    def test_a_non_manifest_gives_a_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text('{"nope": 1}', encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                eb.dataset_tokens_from(path)
            self.assertIn("not a shard manifest", str(ctx.exception))

    def test_from_run_needs_real_throughput(self):
        with tempfile.TemporaryDirectory() as tmp:
            absent = Path(tmp) / "no-throughput.json"
            absent.write_text(json.dumps({"loss": [1.0]}), encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                eb.from_run(absent)
            self.assertIn("pipeline-only", str(ctx.exception),
                          "the error should explain why a pipeline-only run cannot help")

            measured = Path(tmp) / "run.json"
            measured.write_text(json.dumps(
                {"tokens_per_second": 1234.5, "block": 512, "batch": 8}), encoding="utf-8")
            self.assertEqual(eb.from_run(measured)["tokens_per_second"], 1234.5)

    def test_cli_requires_a_measurement(self):
        import io
        from contextlib import redirect_stderr

        buffer = io.StringIO()
        with redirect_stderr(buffer):
            code = eb.main(["--config", "A", "--hours", "9"])
        self.assertEqual(code, 2)
        self.assertIn("measure throughput first", buffer.getvalue())

    def test_cli_writes_the_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "est.json"
            code = eb.main(["--config", "A", "--tokens-per-second", "5000",
                            "--hours", "9", "--json", str(out)])
            self.assertEqual(code, 0)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["config"], "A")
            self.assertGreater(data["tokens_reachable"], 0)


if __name__ == "__main__":
    unittest.main()
