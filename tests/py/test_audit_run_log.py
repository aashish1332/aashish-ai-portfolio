"""Tests for `tools/audit_run_log.py`.

The auditor exists because the previous run's log was read by eye, filed, and a
defect in its checkpoint went unnoticed. So the thing to test is not that it can
find lines — it is that it *fails to find* the right things:

* a claim whose evidence is absent must be MISSING, not quietly satisfied by a
  similar-looking line printed by a different component;
* an outcome the log explicitly records (no cache attached) must be ABSENT, not
  MISSING, because those mean different things to whoever reads the report;
* and MISSING must change the exit code, or the report is decorative.

One test runs the real trainer and audits its real stdout. The rest use
hand-written transcripts, which is a weaker kind of evidence and is labelled as
such where it matters.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from tests.py import HAVE_SEED_SHARDS, SEED_SHARDS_MISSING

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "tools" / "audit_run_log.py"


def _load():
    """Import `tools/audit_run_log.py` by path, registering it before executing.

    The registration is not optional. `@dataclass` resolves type annotations by
    looking up `sys.modules[cls.__module__]`, so executing a module under a name
    that is not in `sys.modules` fails with
    `AttributeError: 'NoneType' object has no attribute '__dict__'` from inside
    `dataclasses.py` — an error that names neither the tool nor the reason.
    """
    name = "audit_run_log_under_test"
    spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run_auditor(argv) -> tuple[int, str]:
    """Run the auditor in-process, capturing stderr as well as stdout.

    stderr too, because the usage error is written there and a test suite that
    prints "no such file: ..." between two dots has taught the reader to ignore
    the very message that should stop them.
    """
    out = io.StringIO()
    with redirect_stdout(out), redirect_stderr(out):
        code = module_main(argv)
    return code, out.getvalue()


module = _load()
module_main = module.main


class ClaimListIsWellFormed(unittest.TestCase):
    def test_every_claim_compiles_and_says_why_it_matters(self):
        for claim in module.CLAIMS:
            with self.subTest(claim=claim.name):
                re.compile(claim.pattern)          # a broken pattern would fail
                self.assertTrue(claim.why.strip(), "a claim with no stated reason")
                for alt, explanation in claim.alternatives:
                    re.compile(alt)
                    self.assertTrue(explanation.strip())

    def test_claim_names_are_unique(self):
        names = [c.name for c in module.CLAIMS]
        self.assertEqual(len(names), len(set(names)))


class TheProbeAndTheTrainerAreNotConfused(unittest.TestCase):
    """Both print `throughput ... tokens/s`. The claims must stay separate."""

    TRAINER_LINE = "throughput: 12,471 tokens/s (1024x8 per step)\n"
    PROBE_LINE = "  throughput        12,471 tokens/s\n"

    def test_the_trainer_line_satisfies_only_the_trainer_claim(self):
        findings, _ = module.audit(self.TRAINER_LINE)
        by_name = {claim.name: kind for claim, kind, _ in findings}
        self.assertEqual(by_name["throughput at the end"], "FOUND")
        self.assertEqual(
            by_name["probe throughput"], "MISSING",
            "the trainer's own summary line was counted as the probe's measurement")

    def test_the_probe_line_satisfies_the_probe_claim(self):
        findings, _ = module.audit(self.PROBE_LINE)
        by_name = {claim.name: kind for claim, kind, _ in findings}
        self.assertEqual(by_name["probe throughput"], "FOUND")

    def test_found_claims_point_at_a_line_the_reader_can_open(self):
        text = "first\nsecond\n" + self.TRAINER_LINE
        findings, _ = module.audit(text)
        found = {c.name: d for c, k, d in findings
                 if c.name == "throughput at the end"}
        self.assertIn("(line 3)", found["throughput at the end"])


class AnOutcomeTheLogRecordsIsNotAnAbsence(unittest.TestCase):
    """ABSENT and MISSING are different facts and must not be merged."""

    NO_CACHE = (
        "  no corpus cache attached - this session runs the full 47-minute pass\n"
    )
    BAD_CACHE = (
        "  (found a CACHE.json but did not use it: /kaggle/input/datasets/x/y)\n"
    )

    def test_a_recorded_absence_is_absent_rather_than_missing(self):
        findings, _ = module.audit(self.NO_CACHE)
        by_name = {c.name: (k, d) for c, k, d in findings}
        # The *reason* is asserted first, on purpose. Reporting ABSENT without
        # saying which absence would be an improvement on MISSING that is still
        # unreadable, so the text is the property, not the label.
        self.assertIn("NO CACHE was attached", by_name["cache located"][1],
                      "a recorded absence was not explained")
        self.assertIn("(line 1, matched", by_name["cache located"][1])
        self.assertEqual(by_name["cache located"][0], "ABSENT",
                         "a recorded absence was reported as missing")
        self.assertEqual(by_name["cache installed"][0], "ABSENT")

    def test_a_rejected_cache_is_absent_but_flagged_as_a_problem(self):
        findings, _ = module.audit(self.BAD_CACHE)
        by_name = {c.name: (k, d) for c, k, d in findings}
        self.assertEqual(by_name["cache located"][0], "ABSENT")
        self.assertIn("real problem, not a shorter run",
                      by_name["cache located"][1])

    def test_no_evidence_at_all_is_missing_and_fails_the_run(self):
        findings, _ = module.audit("nothing relevant here\n")
        by_name = {c.name: k for c, k, _ in findings}
        self.assertEqual(by_name["cache located"], "MISSING")

        path = Path(tempfile.mkdtemp()) / "empty.txt"
        path.write_text("nothing relevant here\n", encoding="utf-8")
        code, out = run_auditor([str(path), "--quiet"])
        self.assertEqual(code, 1, "MISSING did not change the exit code")
        self.assertIn("MISSING", out)


class TheScheduleIsMeasuredNotGlancedAt(unittest.TestCase):
    """The anneal check, which is the one v3 exists to satisfy.

    v2 ran 20,000 steps with a loss curve that looked fine and a learning rate
    that ended at 96.7% of its peak, because the cosine was spanned over the
    wrong number of steps. Nothing in the log said so. These tests are what make
    the log say it.
    """

    V2_DEFECT = ("step    1/20000  loss 9.87  lr 1.50e-03\n"
                 "step 20000/20000  loss 2.14  lr 1.45e-03\n")

    def test_the_v2_defect_is_caught_from_the_log_alone(self):
        kind, detail = module.check_annealed(self.V2_DEFECT)
        self.assertEqual(kind, "FAILED")
        self.assertIn("96.6667% of peak", detail)
        self.assertIn("20,000/20,000", detail)

    def test_an_annealed_run_is_accepted(self):
        text = ("step 1/6  loss 6.9471  lr 1.50e-03\n"
                "step 6/6  loss 5.6484  lr 0.00e+00\n")
        self.assertEqual(module.check_annealed(text)[0], "CHECKED")

    def test_a_correct_rate_early_in_the_run_is_not_called_broken(self):
        # The reason this compares against the cosine instead of a fixed
        # threshold: at 88.8% of the run a *correct* schedule still sits at
        # 3.08% of peak, and a "must be near zero" rule would fail a good run.
        text = ("step 1/45065  loss 9.0  lr 1.50e-03\n"
                "step 40000/45065  loss 3.3  lr 4.65e-05\n")
        kind, detail = module.check_annealed(text)
        self.assertEqual(kind, "CHECKED")
        self.assertIn("a cosine leaves 3.0846% there", detail)

    def test_a_rate_stuck_at_peak_midway_is_still_caught(self):
        # 44.4% in, the cosine should be at 58.8%; 96.7% means the schedule is
        # not moving, whatever the loss curve does.
        text = ("step 1/45065  loss 9.0  lr 1.50e-03\n"
                "step 20000/45065  loss 4.0  lr 1.45e-03\n")
        self.assertEqual(module.check_annealed(text)[0], "FAILED")

    def test_no_rates_at_all_is_missing_rather_than_a_pass(self):
        kind, _ = module.check_annealed("loss: 9.0 -> 3.3 over 20000 steps\n")
        self.assertEqual(kind, "MISSING")

    def test_a_failed_anneal_changes_the_exit_code(self):
        path = Path(tempfile.mkdtemp()) / "v2like.txt"
        path.write_text(self.V2_DEFECT, encoding="utf-8")
        code, out = run_auditor([str(path), "--quiet"])
        self.assertEqual(code, 1, "a run whose schedule never annealed passed")
        self.assertIn("schedule annealed", out)
        self.assertIn("FAILED", out)


class AlarmsAreSurfaced(unittest.TestCase):
    def test_a_wall_clock_stop_is_called_out(self):
        # The run stopping on --max-minutes means the cosine never finished, so
        # the learning rate never annealed - the exact defect v2 shipped with.
        text = ("stopping at step 12000: --max-minutes 570 reached\n"
                "loss: 9.8 -> 3.3 over 12000 steps\n")
        _, alarms = module.audit(text)
        self.assertTrue(any("WALL CLOCK" in note for note in alarms), alarms)

    def test_a_traceback_is_called_out(self):
        _, alarms = module.audit("Traceback (most recent call last):\n")
        self.assertTrue(any("traceback" in note for note in alarms), alarms)

    def test_a_clean_transcript_raises_no_alarms(self):
        _, alarms = module.audit("loss: 6.9 -> 5.6 over 6 steps\n")
        self.assertEqual(alarms, [])


class InputShapes(unittest.TestCase):
    def test_a_raw_json_stream_is_decoded_without_a_separate_step(self):
        stream = json.dumps([
            {"stream_name": "stdout", "time": 1.0, "data": "gate 'loss decreases': PASS\n"},
            {"stream_name": "stderr", "time": 2.0, "data": "unrelated\n"},
        ])
        path = Path(tempfile.mkdtemp()) / "run.log"
        path.write_text(stream, encoding="utf-8")
        text = module.load_text(path)
        self.assertIn("gate 'loss decreases': PASS", text)
        self.assertNotIn("stream_name", text)

    def test_a_missing_file_is_a_usage_error_not_a_pass(self):
        code, out = run_auditor([str(Path(tempfile.mkdtemp()) / "nope.txt")])
        self.assertEqual(code, 2, "a missing log must not audit as passing")
        self.assertIn("no such file", out)

    def test_quiet_keeps_only_what_is_wrong(self):
        text = "manifest: /x/RUN_MANIFEST.json\n"
        path = Path(tempfile.mkdtemp()) / "t.txt"
        path.write_text(text, encoding="utf-8")
        _, loud = run_auditor([str(path)])
        _, quiet = run_auditor([str(path), "--quiet"])
        self.assertIn("manifest written", loud)
        self.assertNotIn("manifest written", quiet)
        self.assertIn("MISSING", quiet)


@unittest.skipUnless(HAVE_SEED_SHARDS, SEED_SHARDS_MISSING)
class AgainstRealTrainerOutput(unittest.TestCase):
    """The fixture that is not a fixture: actual stdout from the actual trainer.

    Everything else in this file is grammar I wrote, so it can only prove the
    auditor reads *my idea of* a log. This runs `train_smoke` for a few steps
    and audits what it really prints, which is the only way to find out that a
    pattern is wrong rather than that the log is.
    """

    @classmethod
    def setUpClass(cls):
        # Only a few steps: this test is about the shape of the output, not the
        # quality of the training.
        cls.tmp = Path(tempfile.mkdtemp())
        cls.transcript = cls.tmp / "smoke.txt"
        proc = subprocess.run(
            [sys.executable, "-m", "training.scripts.train_smoke",
             "--config", "local",
             "--tokenizer", "ai/tokenizer/artifacts/seed-1k",
             "--shards", "data/processed/seed/shards",
             "--run-dir", str(cls.tmp / "run"),
             "--steps", "6", "--batch", "8", "--block", "256",
             "--lr", "1.5e-3", "--warmup", "2",
             "--eval-every", "3", "--save-every", "3", "--log-every", "1"],
            cwd=ROOT, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        )
        cls.transcript.write_text(proc.stdout + proc.stderr, encoding="utf-8")
        cls.stdout = proc.returncode

    def findings(self):
        text = module.load_text(self.transcript)
        found, _ = module.audit(text)
        return {c.name: k for c, k, _ in found}

    def test_the_trainer_ran(self):
        self.assertEqual(self.stdout, 0, self.transcript.read_text(encoding="utf-8"))

    def test_the_claims_a_local_run_can_establish_are_found(self):
        by_name = self.findings()
        for name in ("run reached its step bound", "params", "state keys",
                     "throughput at the end", "manifest written",
                     "checkpoints saved"):
            with self.subTest(claim=name):
                self.assertEqual(by_name[name], "FOUND")

    def test_the_claims_only_a_kaggle_session_can_establish_are_missing(self):
        # Not a defect: a local run has no cache, no probe and no STEPS cell.
        # Asserting MISSING here is what proves the auditor does not
        # congratulate a transcript for merely looking like a training log.
        by_name = self.findings()
        for name in ("cache located", "probe throughput", "STEPS",
                     "budget", "sample generation"):
            with self.subTest(claim=name):
                self.assertEqual(by_name[name], "MISSING")

    def test_the_real_run_s_rate_is_read_and_checked(self):
        # The 6-step run anneals to exactly 0.00e+00, so this exercises the
        # numeric path against real trainer output rather than a written line.
        by_name = self.findings()
        self.assertEqual(by_name["schedule annealed"], "CHECKED")

    def test_and_it_exits_non_zero_because_of_them(self):
        code, out = run_auditor([str(self.transcript), "--quiet"])
        self.assertEqual(code, 1)
        self.assertIn("claims found", out)


if __name__ == "__main__":
    unittest.main()
