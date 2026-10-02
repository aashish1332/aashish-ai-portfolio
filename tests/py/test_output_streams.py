"""tests/py/test_output_streams.py — no function may pin `sys.stdout` at import.

Found on Windows, 2026-10-02, while testing `gpu_probe.py`:

    UnicodeEncodeError: 'charmap' codec can't encode character '\\u2192'

`estimate_budget.report` is declared `def report(est, stream=sys.stdout)`. A
default argument is evaluated **once, when the module is imported**, so `stream`
is bound to the original `sys.stdout` object for the life of the process. Two
things then break, and both are invisible until a caller happens to swap stdout:

1. `contextlib.redirect_stdout` does not capture the report. The test harness
   wrote to the real console while believing it had redirected it.
2. `main`'s `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` does not
   apply either — it reconfigures whatever `sys.stdout` is *now*, which during a
   redirect is a `StringIO`. So the pinned original kept its cp1252 encoding and
   the first `→` raised `UnicodeEncodeError` partway through printing.

The fix is `stream=None` resolved on entry. The guard below is what stops it
coming back: it fails on the *pattern*, so it also catches the fifth function
that does this before anyone hits it on a console.

The second test is the other half — a tool that prints non-ASCII must reconfigure
stdout, or the same crash happens with no test harness involved at all.
"""

from __future__ import annotations

import ast
import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Directories whose CLIs print to a console a person or a notebook is reading.
SCANNED = ["training/scripts", "ai/data", "ai/tokenizer", "ai/model", "inference"]


def python_files() -> list[Path]:
    found: list[Path] = []
    for part in SCANNED:
        base = ROOT / part
        if base.is_dir():
            found.extend(sorted(base.rglob("*.py")))
        elif base.with_suffix(".py").is_file():
            found.append(base.with_suffix(".py"))
    return found


class NoFrozenStreams(unittest.TestCase):
    def test_no_function_defaults_a_stream_to_sys_stdout(self):
        offenders: list[str] = []
        for path in python_files():
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:  # pragma: no cover - parse errors fail elsewhere
                continue
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for default in node.args.defaults + [
                        d for d in node.args.kw_defaults if d is not None]:
                    if isinstance(default, ast.Attribute) and default.attr == "stdout":
                        name = getattr(default.value, "id", "")
                        if name == "sys":
                            offenders.append(
                                f"{path.relative_to(ROOT)}:{node.lineno} "
                                f"{node.name}() defaults a stream to sys.stdout")
        self.assertEqual(offenders, [],
                         "a `stream=sys.stdout` default is bound at import and "
                         "escapes both redirect_stdout and the UTF-8 "
                         "reconfiguration:\n  " + "\n  ".join(offenders))

    def test_mutating_the_default_back_does_break_it(self):
        """The guard above is only worth something if the pattern really does
        misbehave. Reproduce it: a function with a frozen default writes to the
        stream that existed at import, not the one in effect now."""
        source = (
            "import sys\n"
            "import io\n"
            "def report(stream=sys.stdout):\n"
            "    print('x', file=stream)\n"
            "captured = io.StringIO()\n"
        )
        namespace: dict = {"__name__": "frozen_demo"}
        exec(compile(source, "<frozen_demo>", "exec"), namespace)
        real = sys.stdout
        sys.stdout = io.StringIO()
        try:
            namespace["report"]()          # should have gone to the StringIO
            written_to_redirect = sys.stdout.getvalue()
        finally:
            sys.stdout = real
        self.assertEqual(written_to_redirect, "",
                         "redirect captured the write, so this demo no longer "
                         "shows the defect it exists to demonstrate")


class NonAsciiOutput(unittest.TestCase):
    """A tool that prints `→` must make its console able to encode `→`."""

    @staticmethod
    def _prints_non_ascii(path: Path) -> bool:
        return any(ord(ch) > 127 for ch in path.read_text(encoding="utf-8"))

    def test_every_printing_cli_reconfigures_its_console(self):
        offenders: list[str] = []
        for path in python_files():
            text = path.read_text(encoding="utf-8")
            if not self._prints_non_ascii(path):
                continue
            if "reconfigure" in text:
                continue
            # Not a CLI (no __main__ guard) means it is a library module whose
            # callers own the console; only entry points must fix their own.
            if "__main__" not in text:
                continue
            offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual(offenders, [],
                         "these entry points print non-ASCII and never call "
                         "sys.stdout.reconfigure(encoding='utf-8'), so they raise "
                         "UnicodeEncodeError on a cp1252 console:\n  "
                         + "\n  ".join(offenders))


if __name__ == "__main__":
    unittest.main()
