"""Mutation-test the kernel watcher. Run it, do not read it.

    PYTHONUTF8=1 python tools/mutate_watch.py

Every mutation reintroduces one bug that `tools/watch_kernel.py` was just fixed
for, and names the test that must notice. Written the same day as the fix, for
the reason the fix existed: this tool is the only barrier between a finished
Kaggle kernel and a log that can never be fetched again, so "the tests pass" is
not enough — each guard has to be shown load-bearing.

Same two rules as `tools/mutate_checkpoints.py`, learned the hard way here:

* **Key on the exit code, not the last line of stdout.** Some tests print, and a
  test that prints after the summary makes the last line a liar.
* **Check the evidence, not just the failure.** A mutation caught by an unrelated
  crash still exits non-zero. Each entry names something only the intended check
  could produce, so a WRONG REASON result is counted as a hole.
"""

from __future__ import annotations

import mutation_env

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WATCH = ROOT / "tools" / "watch_kernel.py"

# (label, file, find, replace, unittest target that MUST fail, evidence)
MUTATIONS: list[tuple[str, Path, str, str, str, str]] = [
    (
        "M1 the log name goes back to being hardcoded",
        WATCH,
        '    base = out / f"kaggle-{slug}-{tag}"\n',
        '    base = out / "kaggle-v2"  # the original bug\n',
        "tests.py.test_watch_kernel.LogNamesCannotCollide."
        "test_two_versions_of_one_kernel_get_different_files",
        "two runs of one kernel share a log filename",
    ),
    (
        "M2 _free_path stops refusing to overwrite",
        WATCH,
        "    if not path.exists():\n        return path\n",
        "    if True:\n        return path\n",
        "tests.py.test_watch_kernel.LogNamesCannotCollide."
        "test_free_path_leaves_an_existing_log_alone",
        "v2's log was overwritten",
    ),
    (
        "M3 the terminal write stops using _free_path",
        WATCH,
        "            raw_path = _free_path(raw_target)\n",
        "            raw_path = raw_target\n",
        "tests.py.test_watch_kernel.ATerminalRunSavesItsLog."
        "test_a_second_watch_of_the_same_run_lands_beside_the_first",
        "a re-watch overwrote the log",
    ),
    (
        "M4 the header stops naming the destination",
        WATCH,
        '    print(f"  will write {raw_target}", flush=True)\n',
        "",
        "tests.py.test_watch_kernel.TheWatchSaysWhatItIsDoingFirst."
        "test_the_header_names_the_run_the_window_and_the_destination",
        # Not the phrase "will write": removing that line also removes the only
        # place the destination filename was printed, so the filename assertion
        # (a stronger check of the same property) fires first.
        "training-stage-a-v2-v3.log",
    ),
    (
        "M5 the header goes back to being written before utf-8 is set",
        WATCH,
        "    args = ap.parse_args(argv)\n    use_utf8_stdout()\n",
        "    args = ap.parse_args(argv)\n",
        "tests.py.test_watch_kernel.TheWatchSaysWhatItIsDoingFirst."
        "test_the_output_encoding_is_fixed_before_anything_is_written",
        "stdout was never switched to utf-8",
    ),
    (
        "M6 an empty log gets written to disk anyway",
        WATCH,
        "            if not raw.strip():\n",
        "            if False:\n",
        # The disk check now runs before the wording check, deliberately, so
        # the message is also asserted to still be correct if the file *is*
        # written. Both matter: the rule and the report of it.
        "tests.py.test_watch_kernel.AFailedFetchIsNotAnEmptyLog."
        "test_a_genuinely_empty_log_is_named_as_empty_and_not_written",
        "an empty log was written to disk",
    ),
    (
        "M7 a failed fetch is reported as an empty log",
        WATCH,
        "            if fetch_failed and not raw:\n",
        "            if False:\n",
        "tests.py.test_watch_kernel.AFailedFetchIsNotAnEmptyLog."
        "test_an_unreachable_log_is_reported_as_ours_not_kaggle_s",
        "could not fetch the log at all",
    ),
    (
        "M8 the raw log is no longer written before decoding",
        WATCH,
        '            raw_path.write_text(raw, encoding="utf-8")\n',
        "",
        "tests.py.test_watch_kernel.ATerminalRunSavesItsLog."
        "test_the_raw_log_is_written_before_the_transcript_is_attempted",
        "a decode failure cost the raw log",
    ),
    (
        "M9 no zero-poll default, so the report names an unbound variable",
        WATCH,
        '    state = "<no poll yet>"\n',
        "",
        "tests.py.test_watch_kernel.TheWatchSaysWhatItIsDoingFirst."
        "test_a_window_with_no_polls_still_reports_rather_than_crashing",
        # UnboundLocalError, not NameError: `state` is assigned in the loop, so
        # removing its default makes it an unbound *local* rather than an
        # undefined global. Verified by reading the traceback, not assumed.
        "UnboundLocalError",
    ),
    (
        "M10 the tag is sanitised with os.sep only",
        WATCH,
        '    tag = tag.strip().replace("/", "-").replace("\\\\", "-")\n',
        '    tag = tag.strip().replace(os.sep, "-")\n',
        "tests.py.test_watch_kernel.LogNamesCannotCollide."
        "test_a_tag_cannot_escape_the_output_directory",
        "escaped the output directory",
    ),
]


def run(target: str) -> tuple[int, str]:
    """Routed through `mutation_env` so the bytecode cache cannot lie.

    See that module for the measurement: four of these five runners started
    reporting caught mutations as survived because a stale `__pycache__` entry
    satisfied the (mtime, size) check for a file that had already been
    restored. A mutation score taken before this change was partly a
    measurement of disk speed.
    """
    return mutation_env.run_test(target)




def main() -> int:
    caught = uncaught = 0
    # Once per run, before the first subprocess: a stale .pyc from an earlier
    # write is what made these runners report caught mutations as survived.
    mutation_env.clear_bytecode_caches()
    print(f"{len(MUTATIONS)} mutations against {WATCH.name}\n" + "=" * 68)

    for label, path, find, replace, target, evidence in MUTATIONS:
        original = path.read_text(encoding="utf-8")
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

    code, _ = run("tests.py.test_watch_kernel")
    if code != 0:
        print("\nRESTORE FAILED - test_watch_kernel no longer passes. Check git diff.")
        return 1
    return 1 if uncaught else 0


if __name__ == "__main__":
    raise SystemExit(main())
