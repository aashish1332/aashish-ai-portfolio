"""Run a test target against mutated source without the bytecode cache lying.

Every mutation runner in `tools/` works the same way: write a wrong version of a
file, run the named test, restore the file, and count the mutation as caught only
when that test fails with the expected evidence. Five of them did this
independently, each with its own `subprocess.run` — and on 2026-10-03 four of the
five started reporting mutations as NOT CAUGHT that were caught immediately when
the same edit was applied by hand.

The cause is the bytecode cache, and it is worth stating precisely because it
made a whole category of evidence untrustworthy rather than merely flaky:

* The test modules load their subject with `spec_from_file_location`, so
  CPython's `SourceFileLoader` consults `tools/__pycache__/<name>.cpython-*.pyc`.
* A `.pyc` is validated against the source's **mtime and size**, and the mtime is
  stored to one-second resolution.
* A runner writes the mutation and restores the original within the same second,
  two or three times per iteration. A `.pyc` left from an earlier write can
  therefore satisfy the check for a file that no longer matches it, and the
  subprocess then tests the *unmutated* code and reports the mutation as
  survived.

So a green mutation score was, before this file, partly a measurement of how
fast the disk was. `PYTHONDONTWRITEBYTECODE` stops new `.pyc` files being
written, and clearing the cache before the run stops a stale one being read;
both are needed, because the second is what an earlier run already left behind.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Directories whose `.pyc` files could shadow a mutation. `tools/` holds the
#: mutators and `tests/` the test modules that import them.
_CACHE_DIRS = (ROOT / "tools" / "__pycache__", ROOT / "tests" / "py" / "__pycache__")


def clear_bytecode_caches() -> None:
    """Delete cached bytecode once, before a run starts.

    Called at the top of `main()` rather than per mutation: deleting mid-run
    would race with the subprocess that is reading the directory.
    """
    for directory in _CACHE_DIRS:
        shutil.rmtree(directory, ignore_errors=True)


def check_parses(source: str, path: Path) -> str | None:
    """Return the syntax error in `source`, or None if it compiles.

    Added after Q5 in `mutate_question_variety` was reported NOT CAUGHT and
    four different wrong causes were guessed at — stale bytecode, CRLF, a wrong
    evidence phrase — before the real one was measured: the replacement text
    repeated the statement's continuation line, so the mutated module raised
    IndentationError on import and the guard under test never ran at all.

    A mutation that does not parse still exits non-zero, so a runner keying on
    the exit code alone scores it as caught. Compiling first is what tells a
    malformed mutation apart from a guard that genuinely failed to notice one.
    """
    try:
        compile(source, str(path), "exec")
    except SyntaxError as exc:
        return f"{type(exc).__name__}: {exc}"
    return None


def run_test(target: str, *extra: str, timeout: int | None = None
             ) -> tuple[int, str]:
    """Run `python -m unittest <target>` and return (exit code, combined output).

    `extra` is passed through to unittest (`-v` in one runner). The result is
    only meaningful for a mutation runner if `clear_bytecode_caches()` has been
    called for this run.
    """
    kwargs = {
        "cwd": ROOT, "capture_output": True, "text": True,
        "encoding": "utf-8", "errors": "replace",
        "env": {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    }
    if timeout:
        kwargs["timeout"] = timeout
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "unittest", target, *extra], **kwargs)
    except subprocess.TimeoutExpired:
        # A timeout is a real result and must not look like a pass. Report it
        # with a non-zero code and the reason, so a mutation that hangs the
        # suite is counted as uncaught rather than silently skipped.
        return 124, f"TIMEOUT: {target} did not finish within {timeout}s"
    return completed.returncode, completed.stdout + completed.stderr
