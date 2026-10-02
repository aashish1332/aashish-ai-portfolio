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


class StepUnits(unittest.TestCase):
    """`--steps` counts micro-steps; the optimizer moves every `grad_accum`.

    Reporting only one of the two is how a step count gets set 8x wrong, so
    both are in the estimate and the one `--steps` takes is named as such.
    """

    def test_micro_step_and_learning_update_are_distinct_at_grad_accum_8(self):
        est = eb.budget(CONFIG_A, 45_000.0, 9.0, block=1024, batch=8, grad_accum=8,
                        overhead=0.0)
        self.assertEqual(est["tokens_per_micro_step"], 8 * 1024)
        self.assertEqual(est["tokens_per_update"], 8 * 1024 * 8)
        self.assertAlmostEqual(est["micro_steps_reachable"],
                               est["tokens_reachable"] / (8 * 1024))
        self.assertAlmostEqual(est["learning_updates_reachable"],
                               est["tokens_reachable"] / (8 * 1024 * 8))
        self.assertAlmostEqual(est["micro_steps_reachable"]
                               / est["learning_updates_reachable"], 8.0)

    def test_the_two_units_coincide_when_there_is_no_accumulation(self):
        est = eb.budget(CONFIG_A, 45_000.0, 9.0, block=1024, batch=8, grad_accum=1,
                        overhead=0.0)
        self.assertEqual(est["micro_steps_reachable"], est["learning_updates_reachable"])

    def test_report_names_which_unit_steps_takes(self):
        import io

        buffer = io.StringIO()
        eb.report(eb.budget(CONFIG_A, 45_000.0, 9.0, block=1024, batch=8, grad_accum=8),
                  stream=buffer)
        text = buffer.getvalue()
        self.assertIn("micro-steps", text)
        self.assertIn("learning update", text)
        self.assertIn("--steps", text)


class MeasurementProvenance(unittest.TestCase):
    """A throughput number must belong to the config it is filed under.

    Measured on Kaggle 2026-10-02: `estimate_budget --config A --from-run
    smoke.json` printed `config A — 37,890,560 params` beside
    `measured 6,270 tokens/s`, where that rate came from a 4,769,472-parameter
    smoke model. Nothing failed, so the whole token budget was arithmetic on a
    speed config A has never run at. These tests use those exact numbers.
    """

    SMOKE = {"config": "smoke", "params": 4_769_472, "tokens_per_second": 6270.278,
             "block": 128, "batch": 4, "grad_accum": 1}

    def test_a_smoke_measurement_cannot_budget_config_a(self):
        with self.assertRaises(SystemExit) as ctx:
            eb.check_measurement(self.SMOKE, CONFIG_A)
        message = str(ctx.exception)
        self.assertIn("37,890,560", message)
        self.assertIn("4,769,472", message)
        self.assertIn("gpu_probe", message,
                      "the error should say how to get a measurement that is usable")

    def test_a_measurement_of_the_config_itself_is_accepted(self):
        eb.check_measurement({"config": "A",
                              "params": plan.counts(CONFIG_A)["total"],
                              "tokens_per_second": 45_000.0}, CONFIG_A)

    def test_a_file_with_no_params_is_refused_not_assumed(self):
        # Silence here is the original bug one indirection away: an older
        # metrics file simply has no provenance to check, so it must not pass.
        with self.assertRaises(SystemExit) as ctx:
            eb.check_measurement({"tokens_per_second": 6270.278}, CONFIG_A)
        self.assertIn("params", str(ctx.exception))

    def test_every_other_config_is_also_caught(self):
        from ai.model.config import CONFIGS

        for name, cfg in CONFIGS.items():
            with self.subTest(config=name):
                with self.assertRaises(SystemExit, msg=f"{name} should reject the smoke run"):
                    eb.check_measurement(self.SMOKE, cfg)

    def test_cli_refuses_the_kaggle_smoke_file_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "smoke.json"
            path.write_text(json.dumps(self.SMOKE), encoding="utf-8")
            with self.assertRaises(SystemExit):
                eb.main(["--config", "A", "--from-run", str(path), "--hours", "9"])

    def test_cli_inherits_grad_accum_so_the_step_is_the_real_one(self):
        run = dict(self.SMOKE)
        run.update(config="A", params=plan.counts(CONFIG_A)["total"], block=1024,
                   batch=8, grad_accum=8)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "probe.json"
            path.write_text(json.dumps(run), encoding="utf-8")
            out = Path(tmp) / "est.json"
            code = eb.main(["--config", "A", "--from-run", str(path), "--hours", "9",
                            "--json", str(out)])
            self.assertEqual(code, 0)
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["grad_accum"], 8)
            self.assertEqual(data["tokens_per_update"], 8 * 1024 * 8)
            self.assertIn("config A", data["measured_on"])

    def test_report_states_where_the_rate_came_from(self):
        import io

        buffer = io.StringIO()
        eb.report(eb.budget(CONFIG_A, 45_000.0, 9.0, measured_on="config A, 37,890,560 params"),
                  stream=buffer)
        self.assertIn("37,890,560", buffer.getvalue())

    def test_an_unverified_command_line_rate_says_so(self):
        import io

        buffer = io.StringIO()
        eb.report(eb.budget(CONFIG_A, 45_000.0, 9.0), stream=buffer)
        self.assertIn("unverified", buffer.getvalue())


class Inputs(unittest.TestCase):
    def test_dataset_tokens_reads_a_shard_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(json.dumps({"shards": {"train": {"tokens": 749_590}}}),
                            encoding="utf-8")
            self.assertEqual(eb.dataset_tokens_from(path), 749_590)
            self.assertEqual(eb.dataset_tokens_from(Path(tmp)), 749_590)

    def test_a_bare_token_count_is_accepted(self):
        """The flag is named --dataset-tokens, so a number is the obvious input.

        It is also the common one: the count is printed by `shard_summary` and
        appears in the run log, so there is no manifest to point at. Reading the
        number as a path made `170589770` fail with a bare FileNotFoundError,
        which reads like a missing file rather than a mistake about the type.
        """
        self.assertEqual(eb.dataset_tokens_from("170589770"), 170_589_770)
        self.assertEqual(eb.dataset_tokens_from("170_589_770"), 170_589_770)
        self.assertEqual(eb.dataset_tokens_from("170,589,770"), 170_589_770)
        self.assertEqual(eb.dataset_tokens_from(170_589_770), 170_589_770)

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
