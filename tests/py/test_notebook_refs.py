"""tests/py/test_notebook_refs.py — the notebook, checked against the modules it calls.

The notebooks in `training/notebooks/` are the artifacts a GPU session actually
runs, so a defect in one is paid for in GPU-hours. Reading `train_stage_a.ipynb`
found two that no test could have caught, because nothing had ever looked at the
notebook: shards built with `seed-1k` while training with the 12k tokenizer, and
a missing extraction step between `fetch_corpus` and `prepare_data`. The first
would have produced an unusable checkpoint, silently.

`train_stage_b.ipynb` was added later, for the same reason: Stage B had a
trainer and no way to run it on a GPU. Both are checked here.

This file is what looks at them. All of it is offline:

* the notebook parses as nbformat 4 and every cell has a source;
* every `python -m <module>` / `python <path>.py` names something that exists;
* every CLI it invokes answers `--help` — which also keeps the CLIs uniform,
  and is how a bare `sys.argv` read in `ai.tokenizer.fertility` was found
  treating `--help` as a directory name;
* every `--flag` passed exists in that CLI's parser;
* every `$VAR` / `{VAR}` was assigned in an *earlier* cell, because a cell that
  uses `$TOKENIZER` three cells before it is defined is the classic way a
  notebook fails halfway through a paid session;
* the repository the notebook chooses is a *writable* one: a `/kaggle/working`
  path is offered ahead of the read-only `/kaggle/input` mount, and the chosen
  directory is probed rather than assumed.

Command lines are also read out of comments: those are the ones a human
copy-pastes, so a stale one is worse than an absent one.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

NOTEBOOKS = sorted((ROOT / "training" / "notebooks").glob("*.ipynb"))
NOTEBOOK = ROOT / "training" / "notebooks" / "train_stage_a.ipynb"

MODULE_RE = re.compile(r"^python3?\s+-m\s+([A-Za-z0-9_.]+)")
SCRIPT_RE = re.compile(r"^python3?\s+([\w./-]+\.py)")
FLAG_RE = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]*)")
ASSIGN_RE = re.compile(r"^([A-Z][A-Z0-9_]*)\s*=", re.M)
VAR_RE = re.compile(r"[$]([A-Z][A-Z0-9_]*)|[{]([A-Z][A-Z0-9_]*)[}]")
MOUNT_RE = re.compile(r"'(/kaggle/[^']+)'")

# --help is a subprocess per CLI; the answers cannot change mid-run.
_HELP_CACHE: dict[str, set[str] | None] = {}


def load_notebook(path: Path = NOTEBOOK) -> dict:
    """The notebook, with every `source` normalised to one string.

    nbformat allows a cell's source as either a string or a list of lines, and
    which one a file has depends on the tool that wrote it. Normalising here
    means the checks below never depend on that.
    """
    notebook = json.loads(path.read_text(encoding="utf-8"))
    for cell in notebook.get("cells", []):
        source = cell.get("source", "")
        cell["source"] = "".join(source) if isinstance(source, list) else source
    return notebook


def code_cells(path: Path = NOTEBOOK) -> list[tuple[int, str]]:
    return [(index, cell["source"]) for index, cell in enumerate(load_notebook(path)["cells"])
            if cell["cell_type"] == "code"]


def each_notebook():
    """`(name, path)` for every notebook — a subTest label per file."""
    for path in NOTEBOOKS:
        yield path.name, path


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


def repository_cell(path: Path) -> str | None:
    """The cell that decides where the repository is and makes it writable.

    Found by the function it defines rather than by a variable name: the cell's
    body has been rewritten twice now (the guesses, then the discovery), and a
    marker like `CANDIDATES` disappears the moment the approach changes — which
    would turn these tests into silent no-ops rather than failures.
    """
    return next((source for _index, source in code_cells(path)
                 if "def ensure_repo(" in source), None)


class Structure(unittest.TestCase):
    def test_every_notebook_parses_and_has_cells(self):
        self.assertTrue(NOTEBOOKS, "no notebooks to check")
        for name, path in each_notebook():
            with self.subTest(notebook=name):
                notebook = load_notebook(path)
                self.assertEqual(notebook["nbformat"], 4)
                self.assertTrue(notebook["cells"])
                for index, cell in enumerate(notebook["cells"]):
                    self.assertIn(cell["cell_type"], ("markdown", "code"), index)
                    self.assertTrue(str(cell.get("source", "")).strip(),
                                    f"{name} cell {index} is empty")

    def test_it_finds_commands_to_check(self):
        """A validator that silently stops finding commands proves nothing."""
        for name, path in each_notebook():
            with self.subTest(notebook=name):
                found = [c for _, source in code_cells(path) for c in commands(source)]
                self.assertGreaterEqual(len(found), 3,
                                        f"{name} should invoke the CLIs")


class Targets(unittest.TestCase):
    def test_every_invoked_module_or_script_exists(self):
        for name, path in each_notebook():
            seen: set[str] = set()
            for _index, source in code_cells(path):
                for command in commands(source):
                    seen.add(invoked_by(command))
            self.assertTrue(seen, name)
            for target in sorted(seen):
                with self.subTest(notebook=name, target=target):
                    file = ROOT / target
                    if target.endswith(".py"):
                        self.assertTrue(file.is_file(), f"{target} does not exist")
                    else:
                        self.assertTrue((ROOT / (target.replace(".", "/") + ".py")).is_file(),
                                        f"{target} has no module file")

    def test_every_invoked_cli_answers_help(self):
        """Includes the uniform-interface requirement: a CLI that treats
        `--help` as data cannot be validated, and cannot be used safely either."""
        for name, path in each_notebook():
            for _index, source in code_cells(path):
                for command in commands(source):
                    target = invoked_by(command)
                    with self.subTest(notebook=name, target=target):
                        self.assertIsNotNone(help_flags(target),
                                             f"{target} --help failed; is it a module?")

    def test_every_flag_passed_exists_in_that_cli(self):
        for name, path in each_notebook():
            for index, source in code_cells(path):
                for command in commands(source):
                    target = invoked_by(command)
                    known = help_flags(target)
                    if known is None:
                        continue  # reported by test_every_invoked_cli_answers_help
                    for flag in FLAG_RE.findall(command):
                        with self.subTest(notebook=name, cell=index, target=target, flag=flag):
                            self.assertIn(flag, known,
                                          f"{flag} is not accepted by {target}")


class Ordering(unittest.TestCase):
    def test_no_cell_uses_a_variable_before_it_is_defined(self):
        """Line-ordered, not cell-ordered: a cell may assign `$TOKENIZER` on its
        first line and use it on its second, because the kernel runs the cell top
        to bottom. What must never happen is a *later* cell using it, or a line
        using it above its own assignment."""
        for name, path in each_notebook():
            defined: set[str] = set()
            for index, source in code_cells(path):
                for raw in source.splitlines():
                    defined |= assigned_in(raw + "\n")
                    for command in commands(raw):
                        for double, single in VAR_RE.findall(command):
                            var = double or single
                            with self.subTest(notebook=name, cell=index, variable=var):
                                self.assertIn(var, defined,
                                              f"{name} cell {index} uses ${var} before "
                                              f"it is assigned")

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


class Workspace(unittest.TestCase):
    def test_the_chosen_repository_is_writable(self):
        """`/kaggle/input` is a read-only mount, so a Dataset is not a workspace.

        Both notebooks write before they train. Stage A writes `data/sources.json`
        (the licence verification itself), `data/raw/`, `data/extracted/`,
        `data/processed/` and the tokenizer artifact; Stage B writes the
        instruction data and its checkpoints. The repository-location cell listed
        the Dataset mount *first*, so a run that had correctly copied the tree
        into `/kaggle/working` still `chdir`-ed into the read-only mount and died
        on its first write with `OSError: [Errno 30] Read-only file system` —
        with the GPU already allocated and the corpus half-downloaded.

        Two properties of that one cell are what prevent it, and this is the only
        check that can see either of them without a Kaggle account: a
        `/kaggle/working` path has to be offered before any `/kaggle/input` path,
        and the cell has to prove the directory it picked is writable instead of
        assuming it. Copying the tree out is necessary but not sufficient, which
        is exactly the half of §7.0's advice that was missing.
        """
        for name, path in each_notebook():
            chosen = repository_cell(path)
            with self.subTest(notebook=name):
                self.assertIsNotNone(chosen, f"{name} no longer chooses a repository")
                mounts = MOUNT_RE.findall(chosen)
                self.assertTrue(mounts, f"{name} names no /kaggle path")

                writable = [index for index, mount in enumerate(mounts)
                            if mount.startswith("/kaggle/working")]
                read_only = [index for index, mount in enumerate(mounts)
                             if mount.startswith("/kaggle/input")]
                self.assertTrue(writable, f"{name} offers no /kaggle/working repository")
                if read_only:
                    self.assertLess(min(writable), min(read_only),
                                    f"{name} prefers the read-only /kaggle/input "
                                    f"mount over a writable copy")

                self.assertIn("write_text", chosen,
                              f"{name} assumes the repository is writable instead of "
                              f"checking — the failure it is guarding is OSError 30 "
                              f"on the first write, mid-session")

    def test_the_cell_finds_the_repository_however_it_arrived(self):
        """Run the cell's own code, in every start state, in a temp tree.

        **Four** states, because each one is a way the first real Kaggle session
taught us the previous cell was wrong:

        * a clone or a manual copy, which lands in `/kaggle/working`;
        * a Dataset at `/kaggle/input/<name>` — the original assumption;
        * a Dataset under `/kaggle/input/datasets/<username>/<slug>/`, which is
          where "Your Datasets" actually mount, and where the cell died with
          `SystemExit: No repository found`;
        * a Dataset holding **only the `.tgz`**, because Kaggle does not unpack an
          uploaded archive — that one died with `StopIteration`, and no amount of
          path-guessing could have found a `package.json` that was never there.

        It executes the author's real cell rather than a copy of its logic: the
        two absolute prefixes are rewritten to a temp directory and nothing else
        changes. The first version of this found a genuine bug immediately —
        `str(pathlib.Path.cwd()).startswith('/kaggle/input')` is false on Windows,
        because `str()` of a `WindowsPath` uses backslashes, so the copy silently
        did not happen and the cell walked on into the read-only mount.

        The fake tree carries `package.json` and `training/notebooks/` because the
        cell's fallback discovers the repository by exactly those, so a tree
        without them is not a repository and would be testing nothing.
        """

        def plant_repo(base: Path) -> None:
            (base / "training" / "notebooks").mkdir(parents=True)
            (base / "package.json").write_text("{}", encoding="utf-8")

        def plant_archive(base: Path) -> None:
            """Only the archive, as Kaggle actually mounted it.

            The staging tree is built in a **separate temp directory**, not beside
            the archive. Building it inside the mount made this state pass for the
            wrong reason: the fake mount then contained a `package.json` with a
            `training/notebooks/` beside it, so the *previous* branch found it and
            the archive branch was never exercised. Disabling that branch left the
            test green, which is how the mistake surfaced — a state that cannot
            fail for the reason it names is worse than no state at all.
            """
            base.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory() as staging_tmp:
                staging = Path(staging_tmp) / "repo"
                plant_repo(staging)
                with tarfile.open(base / "aashish-ai-portfolio.tgz", "w:gz") as tar:
                    tar.add(staging / "package.json", arcname="package.json")
                    tar.add(staging / "training", arcname="training")

        started = 0
        for name, path in each_notebook():
            cell = repository_cell(path)
            self.assertIsNotNone(cell, f"{name} has no repository-location cell")
            nested = ("datasets", "someone", "aashish-ai-portfolio")
            for label, where, planter in (
                    ("already in working", ("working", "aashish-ai-portfolio"),
                     plant_repo),
                    ("Dataset at /kaggle/input/<name>",
                     ("input", "aashish-ai-portfolio"), plant_repo),
                    ("Dataset under /kaggle/input/datasets/<user>/<slug>",
                     ("input", *nested), plant_repo),
                    ("Dataset holding only the archive", ("input", *nested),
                     plant_archive)):
                original = Path.cwd()
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    mount = root / "kaggle" / "input"
                    work = root / "kaggle" / "working"
                    work.mkdir(parents=True)
                    target = (work if where[0] == "working" else mount).joinpath(
                        *where[1:])
                    planter(target)

                    # as_posix: a Windows temp path inside a single-quoted literal
                    # is a unicode-escape error, and the branch under test is the
                    # same either way.
                    source = (cell.replace("'/kaggle/input", f"'{mount.as_posix()}")
                                  .replace("'/kaggle/working", f"'{work.as_posix()}"))
                    body = "\n".join(line for line in source.splitlines()
                                     if not line.lstrip().startswith("!"))
                    try:
                        exec(compile(body, f"<{name}:{label}>", "exec"), {})
                        landed = Path.cwd()
                    finally:
                        os.chdir(original)  # or Windows refuses to delete the tree

                    with self.subTest(notebook=name, start=label):
                        self.assertEqual(
                            landed, work / "aashish-ai-portfolio",
                            f"{name} ({label}) landed at {landed}. A Dataset mount "
                            f"is read-only and the run writes before it trains, so "
                            f"the cell has to end on a writable copy of its own")
                        self.assertFalse((landed / ".tmp-writable").exists(),
                                         f"{name} ({label}) left its probe behind")
                    started += 1
        self.assertEqual(started, 8, "two notebooks, four start states")


if __name__ == "__main__":
    unittest.main()
