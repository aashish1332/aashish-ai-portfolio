"""Mutation-test the run-log auditor. Run it, do not read it.

    PYTHONUTF8=1 python tools/mutate_audit.py

The auditor's value is entirely in what it *refuses* to say: that an absence the
log records is not a missing claim, that a claim with no evidence fails the run,
and that one component's line cannot satisfy another's claim. So the mutations
here break those refusals, one at a time, and each names a test that must notice.

Same two rules as the other runners in this directory: key on the exit code, and
check the *evidence* — a mutation caught by an unrelated crash has not shown the
guard works.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "tools" / "audit_run_log.py"

# (label, file, find, replace, unittest target that MUST fail, evidence)
MUTATIONS: list[tuple[str, Path, str, str, str, str]] = [
    (
        "A1 a recorded absence is no longer distinguished from no evidence",
        AUDIT,
        "        for alt_pattern, explanation in claim.alternatives:\n"
        "            alt = re.search(alt_pattern, text, re.IGNORECASE)\n"
        "            if alt:\n",
        "        for alt_pattern, explanation in claim.alternatives:\n"
        "            alt = None\n"
        "            if alt:\n",
        "tests.py.test_audit_run_log.AnOutcomeTheLogRecordsIsNotAnAbsence."
        "test_a_recorded_absence_is_absent_rather_than_missing",
        "NO CACHE was attached",
    ),
    (
        "A2 MISSING stops failing the run",
        AUDIT,
        "    if missing:\n",
        "    if False:\n",
        "tests.py.test_audit_run_log.AnOutcomeTheLogRecordsIsNotAnAbsence."
        "test_no_evidence_at_all_is_missing_and_fails_the_run",
        "MISSING did not change the exit code",
    ),
    (
        # The colon is what separates the two lines. `throughput[:\s]+` accepts
        # either, so the trainer's own summary satisfies the probe's claim.
        #
        # The first version of this mutation widened `\s{2,}` to `\s+` instead,
        # and was NOT caught - because `throughput\s+` does not match
        # `throughput: ...` either, a colon not being whitespace. The mutation
        # was wrong, and so was the source comment it was written to justify.
        # Both are corrected here; this form collides, and is caught.
        "A3 the probe claim accepts the trainer's colon form",
        AUDIT,
        'r"throughput\\s{2,}([\\d,]+) tokens/s"',
        'r"throughput[:\\s]+([\\d,]+) tokens/s"',
        "tests.py.test_audit_run_log.TheProbeAndTheTrainerAreNotConfused."
        "test_the_trainer_line_satisfies_only_the_trainer_claim",
        "counted as the probe's measurement",
    ),
    (
        "A4 a wall-clock stop stops being reported as an alarm",
        AUDIT,
        '    (r"stopping at step \\d+: --max-minutes [\\d.]+ reached",\n'
        '     "the run stopped on the WALL CLOCK, not the step bound — the cosine did "\n'
        '     "not complete, so the learning rate did not anneal"),\n',
        "",
        "tests.py.test_audit_run_log.AlarmsAreSurfaced."
        "test_a_wall_clock_stop_is_called_out",
        "WALL CLOCK",
    ),
    (
        "A5 the line number is dropped from FOUND claims",
        AUDIT,
        '            detail = f"{detail.strip()[:150]}  (line {_line_of(text, match.start())})"\n',
        '            detail = detail.strip()[:150]\n',
        "tests.py.test_audit_run_log.TheProbeAndTheTrainerAreNotConfused."
        "test_found_claims_point_at_a_line_the_reader_can_open",
        "(line 3)",
    ),
    (
        "A6 --quiet stops suppressing what is already found",
        AUDIT,
        "        if args.quiet and kind == \"FOUND\":\n",
        "        if False:\n",
        "tests.py.test_audit_run_log.InputShapes.test_quiet_keeps_only_what_is_wrong",
        "manifest written",
    ),
]


def run(target: str) -> tuple[int, str]:
    completed = subprocess.run(
        [sys.executable, "-m", "unittest", target],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return completed.returncode, completed.stdout + completed.stderr


def main() -> int:
    caught = uncaught = 0
    print(f"{len(MUTATIONS)} mutations against {AUDIT.name}\n" + "=" * 68)

    for label, path, find, replace, target, evidence in MUTATIONS:
        original = path.read_text(encoding="utf-8", newline="")
        if find not in original:
            print(f"\nSKIP  {label}\n      pattern not found in {path.name} "
                  f"- the code moved; update the mutation")
            uncaught += 1
            continue
        try:
            path.write_text(original.replace(find, replace, 1), encoding="utf-8",
                            newline="")
            code, out = run(target)
        finally:
            path.write_text(original, encoding="utf-8", newline="")

        if code == 0:
            print(f"\nUNCAUGHT  {label}\n      {target} still passed with the "
                  f"defect reintroduced.\n      This check cannot fail for the "
                  f"reason it claims.")
            uncaught += 1
            continue
        tail = [ln for ln in out.splitlines() if ln.startswith(("FAIL:", "ERROR:"))]
        if evidence in out:
            print(f"\nCAUGHT    {label}\n      target: {target.split('.')[-1]}")
            for line in tail[:2]:
                print(f"      {line}")
            caught += 1
        else:
            print(f"\nWRONG REASON  {label}\n      {target} failed, but the output "
                  f"never says {evidence!r}.\n      It tripped something else; this "
                  f"proves nothing about the guard.")
            for line in tail[:2]:
                print(f"      {line}")
            uncaught += 1

    print(f"\n{'=' * 68}")
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print(f"{'=' * 68}")

    code, _ = run("tests.py.test_audit_run_log")
    if code != 0:
        print("\nRESTORE FAILED - test_audit_run_log no longer passes. Check git diff.")
        return 1
    return 1 if uncaught else 0


if __name__ == "__main__":
    raise SystemExit(main())
