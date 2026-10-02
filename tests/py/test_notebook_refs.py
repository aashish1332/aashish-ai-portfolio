"""tests/py/test_notebook_refs.py — the notebook, checked against the modules it calls.

The notebooks in `training/notebooks/` are the artifacts a GPU session actually
runs, so a defect in one is paid for in GPU-hours. Reading v1 of the Stage A
notebook (`train_stage_a.ipynb`, since replaced by `train_stage_a_v2.ipynb`)
found three that no test could have caught, because nothing had ever looked at
the notebook: shards built with `seed-1k` while training with the 16k tokenizer,
a missing extraction step between `fetch_corpus` and `prepare_data`, and — found
on the real corpus, not by reading — a cell that printed the shard manifest
whole: 3,492 file entries / 32,464 lines of JSON, which made the notebook's own
page unresponsive even after a reload (Jupyter keeps every cell's output in the
page and re-sends it on open). v1 is deleted; `BoundedOutputs` below keeps the
output-size defect from returning in any notebook.

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
NOTEBOOK = ROOT / "training" / "notebooks" / "train_stage_a_v2.ipynb"

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


class BoundedOutputs(unittest.TestCase):
    """No notebook may print a whole-corpus artifact into the page.

    v1's §6 cell ended with `!cat …/shards/manifest.json`. On the real corpus
    that file holds one entry per shard — 3,492 files — and the cell's output
    was 32,464 lines of JSON. The kernel was healthy throughout; what broke was
    the *page*: Jupyter retains every cell's output in the browser and re-sends
    all of it when the notebook is re-opened, so the tab stayed unresponsive
    across reloads and the session's state was reachable only through new cells.

    The rule is about **scale, not names**: the artifacts that grow with the
    corpus are the shard manifest (one entry per shard file) and stats.json
    (one entry per extracted source file) — those must be summarised
    (`training.scripts.shard_summary`, `training.scripts.stats_head`). A cell
    may still `cat` a small fixed-shape file — leakage.json, meta.json, and
    Stage B's `data/instruction/manifest.json`, which is a counts-and-mix
    summary whose size is set by the §7.4 format, not by `--count`. The first
    draft of this guard matched the bare name `manifest.json` and failed on
    exactly that file; a guard that fires for the wrong reason teaches people
    to ignore it, so it now asks what scales.
    """

    @staticmethod
    def _scales_with_corpus(target: str) -> bool:
        t = target.replace("\\", "/").lstrip("./")
        if t.endswith("shards/manifest.json"):
            return True  # one entry per shard file: 3,492 on the real corpus
        return t.endswith("stats.json")  # one entry per extracted source file

    def test_no_notebook_cats_a_whole_corpus_artifact(self):
        for name, path in each_notebook():
            for index, source in code_cells(path):
                for raw in source.splitlines():
                    command = raw.strip()
                    if command.startswith("!"):
                        command = command[1:].strip()
                    if not command.startswith("cat "):
                        continue
                    target = command.split(None, 1)[1].split()[0]
                    with self.subTest(notebook=name, cell=index, target=target):
                        self.assertFalse(
                            self._scales_with_corpus(target),
                            f"{name} cell {index} cats {target} whole, and that "
                            f"file scales with the corpus — its output froze v1's "
                            f"page (32,464 lines, unresponsive across reloads). "
                            f"Summarise it: shard_summary / stats_head")

    def test_the_stage_a_notebook_summarises_the_big_two(self):
        """The replacements must exist, not merely the absence of the `cat`s —
        a cell that prints nothing at all would pass the guard above."""
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        self.assertIn("training.scripts.shard_summary", joined,
                      "the shard manifest must be summarised, not dumped")
        self.assertIn("training.scripts.stats_head", joined,
                      "stats.json must be summarised, not dumped")


class MeasuredBeforeBudgeted(unittest.TestCase):
    """The token budget must come from a measurement of the config it budgets.

    Measured on Kaggle 2026-10-02: §9 ran
    `estimate_budget --config A --from-run smoke.json`, and the tool printed

        config A — 37,890,560 params (37.89M)
          measured           6,270 tokens/s

    where 6,270 tokens/s came from a **4,769,472**-parameter, 4-layer, ctx-256
    smoke model. Nothing failed: the two numbers were on adjacent lines of the
    same report and neither tool compared them. Steps-reachable,
    tokens-per-parameter and hours-needed all inherited the error, and §10 then
    set its step count from them.

    The tool now refuses a mismatched measurement. These tests keep the
    *notebook* on the right side of that refusal — a notebook that pointed §9
    back at `smoke.json` would produce a clean tool error, which is better than
    a wrong budget but still a wasted 48-minute session.
    """

    def _joined(self) -> str:
        return "\n".join(source for _index, source in code_cells(NOTEBOOK))

    def test_the_budget_is_not_filed_under_a_smoke_measurement(self):
        """Read the whole command, not one line of it.

        First draft scanned line by line for a line containing both
        `estimate_budget` and `--from-run`. In this notebook those two sit on
        *different* lines of a backslash continuation, so the guard never
        inspected anything: a mutation that repointed §9 at `smoke.json` — the
        exact defect this class exists to prevent — passed. A guard that has
        never fired on the thing it describes is not a guard.
        """
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        budgets = self._commands_with(joined, "estimate_budget")
        self.assertTrue(budgets, "§9 no longer runs estimate_budget at all")

        for command in budgets:
            parts = command.split()
            with self.subTest(file=parts[parts.index("--from-run") + 1]):
                source_file = parts[parts.index("--from-run") + 1]
                self.assertNotIn(
                    "smoke", source_file,
                    f"config A is budgeted from {source_file}. The smoke model is "
                    f"4,769,472 parameters and config A is 37,890,560; budgeting one "
                    f"from the other reports a rate it has never run at. Measure "
                    f"config A with gpu_probe.py and point --from-run at that.")

    def test_config_a_is_probed_at_the_settings_stage_a_trains_at(self):
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        probes = self._commands_with(joined, "gpu_probe")
        self.assertTrue(probes,
                        "no cell measures config A. The smoke run cannot stand in "
                        "for it: a 4-layer ctx-256 model is launch-bound, a "
                        "10-layer ctx-1024 one is arithmetic-bound, so neither its "
                        "speed nor its memory says anything about config A's.")
        probe = probes[0]
        parts = probe.split()
        self.assertIn("--amp", parts, "a probe without --amp does not measure the "
                                      "run that will happen (Stage A uses fp16)")
        self.assertIn("--json", parts,
                      "the probe has to write its result: §9 reads it via --from-run")
        self.assertEqual(parts[parts.index("--config") + 1], "A",
                         "the probe must measure the config that is about to train")

    @staticmethod
    def _commands_with(source: str, module_fragment: str) -> list[str]:
        """The notebook's `!python ...` invocations of one module, uncommented.

        Comments are dropped and `\\` continuations joined, because both are
        places where a flag can be *mentioned* without being *passed* — and a
        test that reads a mention instead of the argument matches the prose
        instead of the command, which is how a guard stops being able to fail.
        """
        commands, current = [], ""
        for raw in source.splitlines():
            stripped = raw.strip()
            if stripped.startswith("#") or not stripped:
                continue
            current += stripped
            if current.endswith("\\"):
                current = current[:-1]
                continue
            if module_fragment in current and current.startswith("!python"):
                commands.append(current)
            current = ""
        if current and module_fragment in current:
            commands.append(current)
        return commands

    def test_the_probed_batch_matches_the_training_batch(self):
        """A probe at different settings answers a different question."""
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        probes = self._commands_with(joined, "gpu_probe")
        trains = self._commands_with(joined, "train_stage_a ")
        self.assertTrue(probes)
        self.assertTrue(trains)

        def setting(command: str, flag: str) -> str | None:
            parts = command.split()
            return parts[parts.index(flag) + 1] if flag in parts else None

        for flag in ("--batch", "--block", "--grad-accum"):
            with self.subTest(flag=flag):
                self.assertIsNotNone(setting(probes[0], flag),
                                     f"the probe does not pass {flag}")
                self.assertEqual(setting(probes[0], flag), setting(trains[0], flag),
                                 f"the probe and the training run disagree on "
                                 f"{flag}, so the probe measured something else")

    def test_the_learning_update_is_the_size_that_was_documented(self):
        """Halving the micro-batch must not silently halve the batch the model
        learns from. `8 x 1024 x 8` is `16 x 1024 x 4`; that equivalence is the
        whole justification for the change and it is easy to break later."""
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        command = self._commands_with(joined, "train_stage_a ")[0]
        parts = command.split()

        def number(flag: str) -> int:
            return int(parts[parts.index(flag) + 1])

        self.assertEqual(number("--batch") * number("--block") * number("--grad-accum"),
                         8 * 1024 * 8,
                         "the learning update is no longer 65,536 tokens — the "
                         "batch the model learns from has changed, not just the "
                         "memory")

    def test_the_memory_that_ran_out_is_not_requested_again(self):
        """16 x 1024 allocated 12.84 GiB of the T4's 14.56 GiB and died at
        step 1 (measured, 2026-10-02). Asking for it again re-runs that."""
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        command = self._commands_with(joined, "train_stage_a ")[0]
        parts = command.split()
        batch = parts[parts.index("--batch") + 1]
        accum = parts[parts.index("--grad-accum") + 1]
        self.assertEqual(batch, "8",
                         f"Stage A trains at --batch {batch}, which OOMed on a T4 "
                         f"(12.84 of 14.56 GiB)")
        self.assertEqual(accum, "8",
                         "--grad-accum 8 is what keeps the learning update at "
                         "65,536 tokens while the micro-batch halves")


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
