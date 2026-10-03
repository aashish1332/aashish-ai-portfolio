"""The Stage B mutation runner must not destroy the tree it audits.

`tools/mutate_stageb_tokenizer.py` mutates `training/notebooks/train_stage_b.ipynb`
and `.gitignore`, and some of its mutations are *index* mutations that only git
can undo. It used to undo the file half of that with `git checkout -- <path>`,
which restores to **HEAD** rather than to what was on disk when the run started.

MEASURED 2026-10-03: a `--steps 500` edit to notebook cell 13, made minutes
earlier and never committed, was gone after one run of this file. `git status`
afterwards reported a clean tree. That is the worst shape this defect can take:
the runner prints 5/5 and takes an hour of work with it, and nothing in its
output says a byte was lost.

So these tests check the property directly rather than trusting the runner. The
real end-to-end proof is running the runner with an uncommitted edit in place
and finding the edit afterwards; the cheap structural tests here keep the guard
close to the code so a regression is caught without a 30-second subprocess.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "tools" / "mutate_stageb_tokenizer.py"


def _load_runner():
    spec = importlib.util.spec_from_file_location(
        "mutate_stageb_tokenizer_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """ids() of the Constant nodes that are docstrings.

    The runner's own docstrings *have* to name `git checkout` - they are the
    record of why it is banned - so a naive source scan fails on the
    explanation of the defect. Only executable strings are in scope.
    """
    out: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef,
                                  ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if (isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            out.add(id(first.value))
    return out


class RunnerDoesNotUseGitCheckoutForRestore(unittest.TestCase):
    """The defect itself: no executable string in the runner may name it."""

    def test_no_executable_string_names_checkout(self):
        source = RUNNER.read_text(encoding="utf-8")
        tree = ast.parse(source)
        docstrings = _docstring_nodes(tree)
        offenders = [
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstrings
            and "checkout" in node.value
        ]
        self.assertEqual(
            offenders, [],
            "mutate_stageb_tokenizer restores with `git checkout`, which "
            "returns the file to HEAD and silently discards uncommitted work")

    def test_no_git_subcommand_argument_is_checkout(self):
        # Belt and braces on the same property, phrased as the argv a caller
        # would actually execute.
        tree = ast.parse(RUNNER.read_text(encoding="utf-8"))
        docstrings = _docstring_nodes(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in docstrings:
                    continue
                self.assertNotEqual(
                    node.value.strip(), "checkout",
                    "a git argv element names checkout, which restores to HEAD")


class RunnerRestoresFromASnapshot(unittest.TestCase):
    """And it restores *something* that is not HEAD."""

    def test_it_writes_a_snapshot_before_the_first_mutation(self):
        source = RUNNER.read_text(encoding="utf-8")
        self.assertIn("MUTATE_STAGEB_SNAPSHOT", source,
                      "the restore subprocess must be able to find the "
                      "snapshot, so the snapshot has to be handed to it")

    def test_the_snapshot_is_taken_before_the_mutation_loop(self):
        source = RUNNER.read_text(encoding="utf-8")
        snap = source.index("MUTATE_STAGEB_SNAPSHOT")
        loop = source.index("for name, break_cmd, test, restore_cmd in MUTATIONS")
        self.assertLess(
            snap, loop,
            "the snapshot is taken inside the loop, so mutation 5 restores to "
            "the state mutation 4 left behind")

    def test_both_mutated_files_are_snapshotted(self):
        source = RUNNER.read_text(encoding="utf-8")
        for name in ("notebook", "gitignore"):
            self.assertIn(f'"{name}"', source,
                          f"{name} is mutated by this runner and must be "
                          f"snapshotted, or its uncommitted state is lost")


class RestoreModesRefuseToRunWithoutASnapshot(unittest.TestCase):
    """Called standalone, a restore has nothing to restore to.

    It must say so rather than falling back to `git checkout`.
    """

    @classmethod
    def setUpClass(cls):
        cls.runner = _load_runner()

    def test_restore_guard_without_a_snapshot_fails_loudly(self):
        import os

        saved = os.environ.pop("MUTATE_STAGEB_SNAPSHOT", None)
        try:
            code = self.runner.edit("--restore-guard")
        finally:
            if saved is not None:
                os.environ["MUTATE_STAGEB_SNAPSHOT"] = saved
        self.assertNotEqual(
            code, 0,
            "a restore with no snapshot returned success, so it must have "
            "fallen back to something that is not the pre-run state")

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(SystemExit):
            self.runner.edit("--not-a-real-mode")


class MutationAnchorsStillExist(unittest.TestCase):
    """The notebook edits these modes make by string match.

    A moved anchor used to write an unmutated file and exit 0, which the runner
    scored as a setup that succeeded. Each mode now returns non-zero instead, so
    this only guards the rarer case where the notebook drifts and nobody runs it.
    """

    def test_the_guard_the_runner_mutates_is_still_in_the_notebook(self):
        notebook = (ROOT / "training/notebooks/train_stage_b.ipynb").read_text(
            encoding="utf-8")
        self.assertIn(
            "if not pathlib.Path(TOKENIZER, 'tokenizer.json').is_file():",
            notebook,
            "the Stage B tokenizer guard has moved; M3/M4/M5 no longer break "
            "anything")

    def test_the_gitignore_negation_the_runner_removes_is_still_there(self):
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(
            "!ai/tokenizer/artifacts/stage-a-16k/\n", gitignore,
            "the .gitignore negation has moved; M1 no longer breaks anything")


if __name__ == "__main__":
    unittest.main()