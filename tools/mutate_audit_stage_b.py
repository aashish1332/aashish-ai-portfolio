"""Mutation checks for the Stage B half of `tools/audit_run_log.py`.

    PYTHONUTF8=1 python tools/mutate_audit_stage_b.py

Same contract as `tools/mutate_audit.py`: a mutation counts only when the
*named* test fails, so a guard cannot take credit for a break it did not cause.
A SKIP is reported as uncaught, never as a pass — `mutate_audit.py` learned that
the hard way when an edit moved an anchor's text and the runner silently stopped
testing anything.

The mutations here are aimed at the two failure modes this file's own history
produced: a claim that cannot match because its anchor is unreachable, and a
derived check that passes when it has nothing to check.
"""

from __future__ import annotations

import sys
from pathlib import Path

import mutation_env

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "tools" / "audit_run_log.py"

# (label, find, replace, test that MUST fail, a phrase the failure must contain)
MUTATIONS: list[tuple[str, str, str, str, str]] = [
    (
        "B1 the anchored `config` claim goes back to single-line matching",
        "        match = re.search(claim.pattern, text, _FLAGS)",
        "        match = re.search(claim.pattern, text, re.IGNORECASE)",
        "tests.py.test_audit_stage_b.EveryStageBClaimMatchesRealOutput."
        "test_an_anchored_claim_matches_a_line_that_is_not_the_first",
        # The evidence has to be what THIS assertion prints. The test uses
        # `assertEqual(kind, "FOUND", detail)`, so unittest reports `detail` —
        # "no line matching /.../" — and not the subTest-shaped "config came
        # back MISSING" that the neighbouring claim tests produce. Getting this
        # wrong reports a working mutation as NOT CAUGHT, which is the same
        # class of mistake as inventing an evidence string.
        "no line matching",
    ),
    (
        "B2 the init check stops comparing the first loss against the ceiling",
        "    if first >= ceiling:",
        "    if False:",
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_a_from_scratch_run_is_caught_as_not_having_initialised",
        "FAILED",
    ),
    (
        "B3 the init check reports CHECKED when it had nothing to check",
        '        return ("MISSING", "needs both a `vocab=` line and at least one "',
        '        return ("CHECKED", "needs both a `vocab=` line and at least one "',
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_a_run_that_never_printed_the_vocab_is_missing_not_a_pass",
        "MISSING",
    ),
    (
        "B4 supervising nothing stops being a failure",
        "    if supervised <= 0:",
        "    if False:",
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_supervising_nothing_is_a_failure_not_a_silence",
        "FAILED",
    ),
    (
        "B5 supervising (almost) everything stops being a failure",
        "    if share >= 90.0:",
        "    if False:",
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_supervising_almost_everything_is_a_failure",
        "FAILED",
    ),
    (
        "B6 the supervised count goes missing without being reported",
        '        return ("MISSING", "no `tokens: N seen this session, M supervised` line; "',
        '        return ("CHECKED", "no `tokens: N seen this session, M supervised` line; "',
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_no_supervised_count_at_all_is_missing_not_a_pass",
        "MISSING",
    ),
    (
        "B7 the supervised-share threshold is loosened past the measured mask",
        "    if share >= 90.0:",
        "    if share >= 99.99:",
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_supervising_almost_everything_is_a_failure",
        "FAILED",
    ),
    (
        # A `+1.00` margin does NOT work as a mutation: 9.7853 is so far above
        # the ceiling that both 0.25 and 1.00 still catch it, so the mutation
        # would change nothing and its "not caught" verdict would say nothing
        # about the guard. The margin has to go *negative* to let a
        # from-scratch run through, which is also the only way to break the
        # measured-bracketing test.
        "B8 the init margin is widened past the measured from-scratch loss",
        "INIT_APPLIED_MARGIN = 0.25",
        "INIT_APPLIED_MARGIN = -0.50",
        "tests.py.test_audit_stage_b.TheDerivedChecksFailForTheirOwnReasons."
        "test_the_threshold_is_between_the_two_measured_values",
        "would be accepted",
    ),
    (
        "B9 --stage b falls back to the Stage A claim list",
        '        findings, alarms = audit(text, STAGE_B_CLAIMS, STAGE_B_DERIVED)',
        '        findings, alarms = audit(text)',
        "tests.py.test_audit_stage_b.TheStageChoiceIsReal."
        "test_the_cli_reads_a_stage_b_transcript",
        "claims found or checked",
    ),
]


def main() -> int:
    original = AUDIT.read_text(encoding="utf-8")
    mutation_env.clear_bytecode_caches()
    caught = uncaught = 0
    print(f"{len(MUTATIONS)} mutations against audit_run_log.py")
    print("=" * 70)
    try:
        for label, find, replace, test, phrase in MUTATIONS:
            if find not in original:
                print(f"\nSKIP  {label}")
                print("      anchor not found in audit_run_log.py - the code "
                      "moved; update the mutation")
                uncaught += 1
                continue
            AUDIT.write_text(original.replace(find, replace, 1), encoding="utf-8",
                             newline="")
            code, combined = mutation_env.run_test(test)
            AUDIT.write_text(original, encoding="utf-8", newline="")
            name = test.rsplit(".", 1)[-1]
            if code != 0 and name in combined and phrase in combined:
                print(f"\nCAUGHT    {label}")
                print(f"      target: {name}")
                caught += 1
            else:
                print(f"\nNOT CAUGHT  {label}")
                print(f"      target: {name} (exit {code}, "
                      f"phrase {phrase!r} {'present' if phrase in combined else 'absent'})")
                uncaught += 1
    finally:
        AUDIT.write_text(original, encoding="utf-8", newline="")

    print("\n" + "=" * 70)
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print("=" * 70)
    return 0 if uncaught == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
