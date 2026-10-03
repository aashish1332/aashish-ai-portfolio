"""Mutation check for the watcher's `--ref` (2026-10-03).

The flag was added because the watcher named the Stage A kernel in a constant
used at four call sites. The failure this guards is a *half*-applied fix: a
`--ref` that reaches `kernels_status` but not `kernels_logs` polls one kernel
and saves another, which looks like a working watch right up until the log it
writes is the wrong run's. Each mutation below moves exactly one call site back
to the constant, so each test has to catch exactly its own.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = "tools/watch_kernel.py"
SUITE = "tests.py.test_watch_kernel."

# (label, the exact text that must be present for the mutation to have landed,
#  replacement, test expected to fail)
MUTATIONS = [
    ("M1 --ref dropped from kernels_status",
     "state = status(api, args.ref)", "state = status(api)",
     "test_both_api_calls_receive_the_requested_ref"),
    ("M2 --ref dropped from kernels_logs",
     "raw = api.kernels_logs(args.ref)", "raw = api.kernels_logs(REF)",
     "test_both_api_calls_receive_the_requested_ref"),
    ("M3 the default changed, so an unadorned watch follows the wrong kernel",
     'ap.add_argument("--ref", default=REF,', 'ap.add_argument("--ref", default="aashishkumarrajput/training-stage-b",',
     "test_the_default_is_still_the_stage_a_kernel"),
    ("M4 the header no longer names the kernel being watched",
     'print(f"watch {args.ref}", flush=True)', 'print("watching", flush=True)',
     "test_the_ref_is_named_in_the_header"),
]


def main() -> int:
    original = (ROOT / TARGET).read_text(encoding="utf-8")
    caught = uncaught = 0
    try:
        for label, needle, replacement, test in MUTATIONS:
            print("=" * 70)
            print(label)
            if needle not in original:
                print(f"  SETUP FAILED: anchor absent -> {needle!r}")
                uncaught += 1
                continue
            mutated = original.replace(needle, replacement, 1)
            (ROOT / TARGET).write_text(mutated, encoding="utf-8")
            r = subprocess.run(
                [sys.executable, "-m", "unittest", SUITE + test],
                cwd=ROOT, capture_output=True, text=True,
                encoding="utf-8", errors="replace")
            (ROOT / TARGET).write_text(original, encoding="utf-8")
            name = test.rsplit(".", 1)[-1]
            if r.returncode != 0 and name in r.stderr:
                print(f"  caught: {test}")
                caught += 1
            else:
                print(f"  NOT CAUGHT by {test} (exit {r.returncode})")
                uncaught += 1
    finally:
        (ROOT / TARGET).write_text(original, encoding="utf-8")

    print("=" * 70)
    print(f"{caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    return 0 if uncaught == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())