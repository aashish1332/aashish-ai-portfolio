"""tests/py/test_notebook_refs.py — the notebook, checked against the modules it calls.

`training/notebooks/train_stage_a.ipynb` is the one artifact a GPU session
actually runs, so a defect in it is paid for in GPU-hours. Reading it found two
that no test could have caught, because nothing had ever looked at the notebook:
shards built with `seed-1k` while training with the 12k tokenizer, and a
missing extraction step between `fetch_corpus` and `prepare_data`. The first
would have produced an unusable checkpoint, silently.

This file is what looks at it now. All of it is offline:

* the notebook parses as nbformat 4 and every cell has a source;
* every `python -m <module>` / `python <path>.py` names something that exists;
* every CLI it invokes answers `--help` — which also keeps the CLIs uniform,
  and is how a bare `sys.argv` read in `ai.tokenizer.fertility` was found
  treating `--help` as a directory name;
* every `--flag` passed exists in that CLI's parser;
* every `$VAR` / `{VAR}` was assigned in an *earlier* cell, because a cell that
  uses `$TOKENIZER` three cells before it is defined is the classic way a
  notebook fails halfway through a paid session.

Command lines are also read out of comments: those are the ones a human
copy-pastes, so a stale one is worse than an absent one.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

NOTEBOOK = ROOT / "training" / "notebooks" / "train_stage_a.ipynb"

MODULE_RE = re.compile(r"^python3?\s+-m\s+([A-Za-z0-9_.]+)")
SCRIPT_RE = re.compile(r"^python3?\s+([\w./-]+\.py)")
FLAG_RE = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]*)")
ASSIGN_RE = re.compile(r"^([A-Z][A-Z0-9_]*)\s*=", re.M)
VAR_RE = re.compile(r"[$]([A-Z][A-Z0-9_]*)|[{]([A-Z][A-Z0-9_]*)[}]")

# --help is a subprocess per CLI; the answers cannot change mid-run.
_HELP_CACHE: dict[str, set[str] | None] = {}


def load_notebook() -> dict:
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))


def code_cells() -> list[tuple[int, str]]:
    return [(index, cell["source"]) for index, cell in enumerate(load_notebook()["cells"])
            if cell["cell_type"] == "code"]


def commands(source: str) -> list[str]:
    """Every `python ...` invocation in a cell, including commented-out ones."""
    found = []
    for raw in source.splitlines():
        line = raw.strip()
        if line.startswith("#"):
            line = line.lstrip("#").strip()
        if line.startswith("!"):
            line = line[1:].strip()
        if MODULE_RE.match(line) or SCRIPT_RE.match(line):
            found.append(line)
    return found


def invoked_by(command: str) -> str:
    match = MODULE_RE.match(command)
    if match:
        return match.group(1)
    match = SCRIPT_RE.match(command)
    assert match, command
    return match.group(1)


def help_flags(target: str) -> set[str] | None:
    """The `--flags` a CLI advertises, or None when it cannot be asked."""
    if target in _HELP_CACHE:
        return _HELP_CACHE[target]
    argv = ([sys.executable, "-m", target] if not target.endswith(".py")
            else [sys.executable, target])
    try:
        result = subprocess.run([*argv, "--help"], cwd=ROOT, capture_output=True,
                                text=True, timeout=60)
    except Exception:
        _HELP_CACHE[target] = None
        return None
    if result.returncode != 0:
        _HELP_CACHE[target] = None
        return None
    flags = set(FLAG_RE.findall(result.stdout))
    _HELP_CACHE[target] = flags
    return flags


def assigned_in(line: str) -> set[str]:
    return set(ASSIGN_RE.findall(line))


class Structure(unittest.TestCase):
    def test_the_notebook_parses_and_has_cells(self):
        notebook = load_notebook()
        self.assertEqual(notebook["nbformat"], 4)
        self.assertTrue(notebook["cells"])
        for index, cell in enumerate(notebook["cells"]):
            self.assertIn(cell["cell_type"], ("markdown", "code"), index)
            self.assertTrue(str(cell.get("source", "")).strip(), f"cell {index} is empty")

    def test_it_finds_commands_to_check(self):
        """A validator that silently stops finding commands proves nothing."""
        found = [c for _, source in code_cells() for c in commands(source)]
        self.assertGreaterEqual(len(found), 10, "the notebook should invoke the CLIs")


class Targets(unittest.TestCase):
    def test_every_invoked_module_or_script_exists(self):
        seen: set[str] = set()
        for _index, source in code_cells():
            for command in commands(source):
                seen.add(invoked_by(command))
        self.assertTrue(seen)
        for target in sorted(seen):
            with self.subTest(target=target):
                path = ROOT / target
                if target.endswith(".py"):
                    self.assertTrue(path.is_file(), f"{target} does not exist")
                else:
                    self.assertTrue((ROOT / (target.replace(".", "/") + ".py")).is_file(),
                                    f"{target} has no module file")

    def test_every_invoked_cli_answers_help(self):
        """Includes the uniform-interface requirement: a CLI that treats
        `--help` as data cannot be validated, and cannot be used safely either."""
        for _index, source in code_cells():
            for command in commands(source):
                target = invoked_by(command)
                with self.subTest(target=target):
                    self.assertIsNotNone(help_flags(target),
                                         f"{target} --help failed; is it a module?")

    def test_every_flag_passed_exists_in_that_cli(self):
        for index, source in code_cells():
            for command in commands(source):
                target = invoked_by(command)
                known = help_flags(target)
                if known is None:
                    continue  # reported by test_every_invoked_cli_answers_help
                for flag in FLAG_RE.findall(command):
                    with self.subTest(cell=index, target=target, flag=flag):
                        self.assertIn(flag, known,
                                      f"{flag} is not accepted by {target}")


class Ordering(unittest.TestCase):
    def test_no_cell_uses_a_variable_before_it_is_defined(self):
        """Line-ordered, not cell-ordered: a cell may assign `$TOKENIZER` on its
        first line and use it on its second, because the kernel runs the cell top
        to bottom. What must never happen is a *later* cell using it, or a line
        using it above its own assignment."""
        defined: set[str] = set()
        for index, source in code_cells():
            for raw in source.splitlines():
                defined |= assigned_in(raw + "\n")
                for command in commands(raw):
                    for double, single in VAR_RE.findall(command):
                        name = double or single
                        with self.subTest(cell=index, variable=name):
                            self.assertIn(name, defined,
                                          f"cell {index} uses ${name} before it is assigned")

    def test_the_two_fixed_defects_stay_fixed(self):
        """Neither defect had a test, because neither was the kind of thing a
        unit test is usually asked about: one was data flowing between two
        correct components, the other was the *order* of two correct calls."""
        first: dict[str, int] = {}
        needles = {
            "extract": "ai.data.extract",
            "prepare": "training.scripts.prepare_data",
            "tokenizer_train": "ai.tokenizer.train",
            # the pass that writes shards, as opposed to the stats-only pass
            "shard": "--out data/processed/stage_a --tokenizer",
        }
        for index, source in code_cells():
            for key, needle in needles.items():
                if needle in source and key not in first:
                    first[key] = index
        for key in needles:
            self.assertIn(key, first, f"the notebook no longer does {key}")

        self.assertLess(first["extract"], first["prepare"],
                        "a fetched source must be extracted before the pipeline "
                        "is asked to read text")
        self.assertLess(first["tokenizer_train"], first["shard"],
                        "shards must be written with the frozen tokenizer — this is "
                        "the mismatch training now refuses rather than trains through")


if __name__ == "__main__":
    unittest.main()
