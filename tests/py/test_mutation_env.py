"""Tests for the shared mutation-test helper.

`tools/mutation_env.py` is what nine mutation runners trust to tell them a
mutation was genuinely caught. A flaw in it does not show up as a failing
guard; it shows up as every runner quietly mislabelling evidence, which is the
failure mode this project has already been bitten by twice (stale `.pyc`
validation, and CRLF re-writes by a runner using `Path.write_text` without
`newline=""`).

`check_parses` exists because Q5 in `tools/mutate_question_variety.py` was
reported NOT CAUGHT, and the obvious explanations were all wrong. Measured
cause: the replacement text re-emitted a statement's continuation line, so the
mutated module raised `IndentationError` on import. The guard under test never
ran, yet the mutation still exited non-zero — a runner keying on the exit code
alone would score it as caught.
"""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _load(name: str):
    """Import a `tools/` module by name.

    `importlib` needs the module registered in `sys.modules` *before*
    `exec_module`, otherwise dataclasses and friends fail to resolve their own
    globals.
    """
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


mutation_env = _load("mutation_env")


class CheckParsesAcceptsRealSource(unittest.TestCase):
    def test_the_real_helpers_are_syntactically_valid(self):
        for name in ("mutation_env", "mutate_question_variety"):
            source = (TOOLS / f"{name}.py").read_text(encoding="utf-8")
            self.assertIsNone(
                mutation_env.check_parses(source, TOOLS / f"{name}.py"),
                f"{name}.py does not parse, so it cannot be a mutation target")

    def test_valid_python_returns_none(self):
        self.assertIsNone(mutation_env.check_parses("x = 1\n", Path("x.py")))


class CheckParsesRejectsTheQ5Shape(unittest.TestCase):
    """The exact bug: a replacement that re-emits the continuation line."""

    def test_a_repeated_continuation_line_is_reported(self):
        original = ('for ex in examples:\n'
                    '    ex["turns"] = [(v, a)\n'
                    '                   for v, a in ex["turns"]]\n')
        # What Q5 used to do, faithfully: anchor on the statement's *first*
        # line, and supply a continuation of its own. The original
        # continuation is left in place underneath, so the second `for` dangles
        # at the depth of the comprehension clause.
        first_line = '    ex["turns"] = [(v, a)\n'
        continuation = '                   for v, a in ex["turns"]]\n'
        mutated = original.replace(
            first_line, first_line + continuation, 1)
        error = mutation_env.check_parses(mutated, Path("x.py"))
        self.assertIsNotNone(error, "a doubled continuation line was accepted "
                                    "as a mutation")
        self.assertIn("IndentationError", error)

    def test_it_points_at_the_line_the_mutation_broke(self):
        original = ('for ex in examples:\n'
                    '    ex["turns"] = [(v, a)\n'
                    '                   for v, a in ex["turns"]]\n')
        first_line = '    ex["turns"] = [(v, a)\n'
        mutated = original.replace(
            first_line,
            first_line + '                   for v, a in ex["turns"]]\n', 1)
        error = mutation_env.check_parses(mutated, Path("x.py"))
        # Line 4 of the mutated file is the stray continuation. Without the
        # line number, a malformed mutation and a moved anchor are the same
        # mystery, which is how Q5 stayed unexplained for so long.
        self.assertIn("line 4", error)

    def test_the_error_names_the_line(self):
        error = mutation_env.check_parses("def f(:\n", Path("x.py"))
        self.assertIsNotNone(error)
        self.assertIn("line", error)


class CheckParsesCatchesOtherSyntaxErrors(unittest.TestCase):
    def test_unterminated_string(self):
        self.assertIsNotNone(
            mutation_env.check_parses('x = "oops\n', Path("x.py")))

    def test_a_named_file_is_reported_back(self):
        error = mutation_env.check_parses("def f(:\n", Path("/tmp/where.py"))
        self.assertIn("where.py", error)


class RunTestReturnsBothHalves(unittest.TestCase):
    """`run_test` feeds the runner's exit-code *and* evidence checks.

    Neither test names a target in this module. The first version of the
    passing case pointed at itself, so each subprocess ran the test that
    spawned it and the suite never terminated — a 180 s timeout that looked
    like a slow suite rather than unbounded recursion.
    """

    def test_a_passing_target_exits_zero(self):
        code, output = mutation_env.run_test("tests.py.test_instruction")
        self.assertEqual(code, 0, output[-2000:])
        self.assertIsInstance(output, str)

    def test_a_failing_target_exits_non_zero(self):
        # A name that does not exist becomes `unittest.loader._FailedTest`,
        # which is how the real runners see a broken target id.
        code, output = mutation_env.run_test("tests.py.no_such_module")
        self.assertNotEqual(code, 0)
        self.assertIn("_FailedTest", output)

    def test_a_real_failure_is_reported_with_its_message(self):
        code, output = mutation_env.run_test(
            "tests.py.test_mutation_env.DeliberateFailure.test_it_fails")
        self.assertNotEqual(code, 0)
        self.assertIn("deliberate failure message", output)

    def test_output_carries_both_streams(self):
        # Mutation runners read the assertion's own `msg` out of this, so it
        # has to survive decoding rather than raise on a stray byte.
        _, output = mutation_env.run_test(
            "tests.py.test_mutation_env.DeliberateFailure.test_it_fails")
        self.assertIn("DeliberateFailure", output)


class TimeoutIsNotAPass(unittest.TestCase):
    """A hung mutation must be uncaught, never silently skipped."""

    def test_a_timeout_reports_its_own_code_and_reason(self):
        code, output = mutation_env.run_test(
            "tests.py.test_mutation_env.SlowTestCase.test_sleeps", timeout=1)
        self.assertEqual(code, 124)
        self.assertIn("TIMEOUT", output)
        self.assertIn("test_sleeps", output)


class SlowTestCase(unittest.TestCase):
    """Named only so `TimeoutIsNotAPass` has something to hang on."""

    def test_sleeps(self):
        import time

        time.sleep(10)


class DeliberateFailure(unittest.TestCase):
    """Named only so `run_test` has a real failure to report.

    Both fixtures must be importable at module level — `run_test` takes a
    dotted *name* and re-runs it in a fresh subprocess — yet neither may be
    collected by this module's own discovery. Defining them here failed the
    suite on first run, because `test_it_fails` failed on purpose. `load_tests`
    below lists what discovery is allowed to see.
    """

    def test_it_fails(self):
        self.fail("deliberate failure message")


def load_tests(loader, tests, pattern):
    """Restrict discovery to the real tests.

    Consulted only for a module-level load, so naming a class inside this
    module from another test still resolves it normally.
    """
    real = (
        "CheckParsesAcceptsRealSource",
        "CheckParsesRejectsTheQ5Shape",
        "CheckParsesCatchesOtherSyntaxErrors",
        "RunTestReturnsBothHalves",
        "TimeoutIsNotAPass",
    )
    suite = unittest.TestSuite()
    for name in real:
        suite.addTests(loader.loadTestsFromName(f"{__name__}.{name}"))
    return suite


if __name__ == "__main__":
    unittest.main()