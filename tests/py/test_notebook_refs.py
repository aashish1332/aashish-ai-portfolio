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

import ast
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


MAGIC = "__magic__"


def cell_python(source: str) -> str:
    """A notebook cell as compilable Python, with `!` magics kept as calls.

    IPython's `!cmd` is not Python, so a cell containing one cannot be parsed
    directly — and a cell that only *runs on Kaggle* is a cell nobody finds the
    syntax error in until an hour into a GPU session.

    The magic becomes `__magic__("cmd")` rather than `pass`, so the command text
    survives into the AST. That is what makes it possible to ask whether a
    command is *inside* a conditional instead of merely somewhere in the cell —
    the difference between a guard and a mention. Backslash continuations are
    folded onto the first line.
    """
    out: list[str] = []
    buffer: str | None = None
    buffer_indent = ""
    for raw in source.splitlines():
        stripped = raw.lstrip()
        indent = raw[:len(raw) - len(stripped)]
        if buffer is not None:
            buffer += " " + stripped.rstrip("\\").strip()
            if not stripped.endswith("\\"):
                out.append(f"{buffer_indent}{MAGIC}({buffer!r})")
                buffer = None
            continue
        if stripped.startswith("!"):
            body = stripped[1:].strip()
            if body.endswith("\\"):
                buffer, buffer_indent = body[:-1].strip(), indent
                continue
            out.append(f"{indent}{MAGIC}({body!r})")
            continue
        out.append(raw)
    if buffer is not None:
        out.append(f"{buffer_indent}{MAGIC}({buffer!r})")
    return "\n".join(out)


def parse_cell(source: str) -> tuple[ast.AST, dict[ast.AST, ast.AST]]:
    """The cell's AST plus a child -> parent map, for ancestry questions."""
    tree = ast.parse(cell_python(source))
    parents: dict[ast.AST, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return tree, parents


def magic_calls(source: str) -> list[tuple[str, ast.AST, dict[ast.AST, ast.AST]]]:
    """Every `!` command in the cell, with its node and the parent map."""
    tree, parents = parse_cell(source)
    calls = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == MAGIC):
            calls.append((node.args[0].value, node, parents))
    return calls


def enclosed_by(node: ast.AST, parents: dict[ast.AST, ast.AST],
                name: str) -> bool:
    """Is this node inside an `if` whose test mentions `name`?"""
    current = parents.get(node)
    while current is not None:
        if isinstance(current, ast.If):
            mentioned = {n.id for n in ast.walk(current.test)
                         if isinstance(n, ast.Name)}
            if name in mentioned:
                return True
        current = parents.get(current)
    return False


class CellsAreValidPython(unittest.TestCase):
    def test_every_code_cell_compiles_with_its_magics_stubbed(self):
        for index, source in code_cells(NOTEBOOK):
            with self.subTest(cell=index):
                try:
                    compile(cell_python(source), f"<cell {index}>", "exec")
                except SyntaxError as exc:
                    self.fail(f"cell {index} does not parse: {exc.msg} "
                              f"(line {exc.lineno}). Every later cell in the "
                              f"notebook is skipped when one raises, so this "
                              f"would surface as a missing step, not as a crash.")


class CacheIsActuallyUsed(unittest.TestCase):
    """Installing a cache is not the same as *using* it.

    A cache that is installed and then followed by the same unconditional
    fetch / extract / pipeline / shard cells saves nothing at all — it costs 348
    MB of dataset transfer and 47 minutes still. The guards are the feature; the
    install cell alone is decoration. So this asserts every expensive step sits
    behind the flag.
    """

    EXPENSIVE = {
        # Match the flag that fetches, not the module name: `--check` is the
        # licence gate — it prints a table and downloads nothing — so keying on
        # `training.scripts.fetch_corpus` alone made the guard fire on a cheap
        # cell. A guard that fires for the wrong reason teaches people to ignore
        # it (the same mistake `_scales_with_corpus` was written to avoid).
        "training.scripts.fetch_corpus --source": "the Wikipedia downloads",
        "ai.data.extract --source": "extraction",
        "training.scripts.prepare_data": "the pipeline and shard passes",
        "ai.tokenizer.train": "tokenizer training",
    }

    @staticmethod
    def _joined() -> str:
        return "\n".join(source for _index, source in code_cells(NOTEBOOK))

    def test_the_notebook_installs_a_cache_when_one_is_attached(self):
        joined = self._joined()
        self.assertIn("corpus_cache", joined,
                      "the notebook never reads a cache, so a cached session "
                      "pays the full 47 minutes anyway")
        self.assertIn("install", joined)
        # The corpus dataset's *slug* must NOT appear. It used to, in the path
        # `/kaggle/input/aashish-ai-stage-a-corpus`, which is the mount that does
        # not exist — Kaggle puts "Your Datasets" under
        # `/kaggle/input/datasets/<username>/<slug>/`, as the notebook's own
        # repository cell learned in the first real session. Requiring that
        # literal made this guard defend the defect it should have caught.
        #
        # Requiring the slug to appear is no better: the cell finds the cache by
        # its `CACHE.json`, so the name is genuinely irrelevant, and a guard that
        # demands it would push the bug back in. Where it mounts is
        # `CacheIsFoundWhereKagglePutsIt`, which executes the lookup.
        self.assertNotIn("aashish-ai-stage-a-corpus", joined,
                         "the notebook must find the corpus cache by its "
                         "CACHE.json, not by a dataset name — that name-based "
                         "lookup is the mount path that never exists")

    def test_a_failed_verification_stops_the_notebook(self):
        """`install` exits non-zero on a stale cache. If the cell ignores the
        return code, the session proceeds to shard from whatever is on disk —
        the silent-mismatch outcome the whole tool exists to prevent.

        Structural again: asserting the words `returncode` and `raise
        SystemExit` appear somewhere passes for `if False: ... raise`, which is
        the mutation that matters. The requirement is a conditional that tests
        `returncode` and stops inside it.
        """
        found = False
        for index, source in code_cells(NOTEBOOK):
            if "corpus_cache" not in source:
                continue
            tree, _parents = parse_cell(source)
            for node in ast.walk(tree):
                if not isinstance(node, ast.If):
                    continue
                tests_returncode = any(
                    isinstance(n, ast.Attribute) and n.attr == "returncode"
                    for n in ast.walk(node.test))
                stops = any(isinstance(n, ast.Raise) for n in ast.walk(node))
                if tests_returncode and stops:
                    found = True
        self.assertTrue(found,
                        "the cache cell must branch on install's exit status and "
                        "stop the notebook in that branch")

    def test_every_expensive_step_is_behind_the_cache_flag(self):
        """Structural, not textual.

        The first draft asserted that a cell containing an expensive command
        also contained the word `CACHED` somewhere. Flipping the actual guard to
        `if False:` left the word present in a second conditional further down
        the same cell, so the mutation survived: the check could not fail for
        the reason it claimed. What matters is membership in the *body* of a
        `CACHED` test, so that is what is asked.
        """
        for index, source in code_cells(NOTEBOOK):
            for command, node, parents in magic_calls(source):
                for needle, label in self.EXPENSIVE.items():
                    if needle not in command:
                        continue
                    with self.subTest(cell=index, step=label, command=command[:60]):
                        self.assertTrue(
                            enclosed_by(node, parents, "CACHED"),
                            f"cell {index} runs {label} outside any `CACHED` "
                            f"conditional, so an attached cache saves nothing — "
                            f"it costs 348 MB of transfer and 47 minutes still. "
                            f"A stash that is installed and never used is "
                            f"decoration.")

    def test_the_expensive_steps_still_exist(self):
        """Guarding a step is not the same as deleting it: a session with no
        cache attached has to run all of them."""
        joined = self._joined()
        for needle in self.EXPENSIVE:
            self.assertIn(needle, joined,
                          f"{needle} is gone from the notebook, so a session "
                          f"without a cache cannot build the corpus at all")

    def test_both_branches_are_reachable(self):
        """`CACHED` must be assigned before anything tests it."""
        joined = self._joined()
        self.assertIn("CACHED = bool(CACHE)", joined)


class StepsComeFromTheMeasurement(unittest.TestCase):
    """`--steps 20000` was a constant no measurement produced.

    At a pessimistic 10,000 tokens/s it is 4.6 h of a 9 h session and leaves the
    rest of the quota unused; at 30,000 it is under two hours. And because the
    cosine is built over `--steps`, a step count that does not match what fits
    also decides where the learning rate ends up.
    """

    @staticmethod
    def _train_command() -> str:
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        commands, current = [], ""
        for raw in joined.splitlines():
            stripped = raw.strip()
            if stripped.startswith("#") or not stripped:
                continue
            current += stripped
            if current.endswith("\\"):
                current = current[:-1]
                continue
            commands.append(current)
            current = ""
        return next(c for c in commands if "train_stage_a " in c)

    def test_the_step_count_is_a_variable_not_a_constant(self):
        command = self._train_command()
        parts = command.split()
        steps = parts[parts.index("--steps") + 1]
        self.assertEqual(steps, "$STEPS",
                         f"--steps is {steps!r}. A literal here is a number no "
                         f"measurement produced, which is how the session came "
                         f"to stop on the step bound and leave quota unused.")

    def test_the_variable_is_read_from_the_budget_the_probe_produced(self):
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        self.assertIn("micro_steps_reachable", joined,
                      "STEPS must come from estimate_budget's own field, not from "
                      "a formula re-implemented in the notebook, which is the "
                      "thing that would then drift from the tool")
        self.assertIn("budget.json", joined)
        self.assertIn("--json", joined)

    def test_a_missing_budget_stops_rather_than_defaulting(self):
        joined = "\n".join(source for _index, source in code_cells(NOTEBOOK))
        self.assertIn("did not fit", joined,
                      "the probe exits non-zero when the config does not fit, so "
                      "there is no budget file; the notebook must say so instead "
                      "of picking a number")

    def test_the_budgeted_session_fits_inside_the_cap_kaggle_enforces(self):
        """The budgeted hours must fit the session, and the time box must be a
        backstop rather than the binding bound.

        Two claims are being checked, and they are different. If `--max-minutes`
        cuts in first, the cosine stops part-way and the LR never reaches zero
        — the run wastes its quota. If the *session* cuts in first, Kaggle kills
        the kernel, `/kaggle/working` is wiped and nothing is published at all,
        so the checkpoint is lost rather than shortened.

        The cap is not a single published number: 9 h on Kaggle's own forum,
        12 h in 2026 third-party guides. Budgeting against the larger one is
        budgeting for a session that may not exist, so the guard bounds the
        budget by the smaller. Measured 2026-10-02: a run sized for 8.55 h of
        training plus the 47-minute corpus phase overran a 9 h session.
        """
        CAP_HOURS = 9.0

        command = self._train_command()
        parts = command.split()
        minutes = float(parts[parts.index("--max-minutes") + 1])

        # Parse the budget's own call rather than grepping for a literal, so a
        # comment quoting "--hours 9" cannot satisfy this. Continuations are
        # joined first: the notebook writes these commands across several lines
        # with trailing backslashes, and a line-by-line scan finds the command
        # name on one line and its flags on the next -- which is how an earlier
        # version of this guard matched the name and then inspected nothing.
        joined = "\\n".join(
            source.replace("\\\n", " ")
            for _index, source in code_cells(NOTEBOOK)
        )
        joined = "\n".join(
            line for line in joined.splitlines() if not line.strip().startswith("#")
        )
        match = re.search(r"estimate_budget\b.*", joined)
        self.assertIsNotNone(match, "the probe's budget call is missing")
        hours_match = re.search(r"--hours\s+([0-9.]+)", match.group(0))
        self.assertIsNotNone(
            hours_match,
            "the budget call states no --hours, so the step count is sized "
            "against no session length at all")
        hours = float(hours_match.group(1))

        self.assertLessEqual(
            hours, CAP_HOURS,
            f"the run is budgeted for {hours:g} h of training. Kaggle's own forum "
            f"says a GPU session is capped at {CAP_HOURS:g} h; budgeting past that "
            f"means the kernel is killed and, because /kaggle/working is wiped, "
            f"nothing is published")
        self.assertGreater(
            minutes, hours * 60,
            f"--max-minutes {minutes:g} is not above the {hours:g} h the budget was "
            f"computed for, so the time box would bind before the step count and "
            f"the cosine would stop part-way down")


class SessionWorkSurvives(unittest.TestCase):
    """A session must leave behind something one request can fetch.

    Measured 2026-10-02, on the Kaggle kernel-output API: it downloads **one file
    per HTTP request** and pages the listing 20 at a time by default. A working
    directory holding the repository plus **3,505 shard files** made
    `kaggle kernels output` exceed a 300-second timeout enumerating; the same
    call with `--page-size 200` finished in 7 seconds. Even then the shards
    would arrive as 3,505 separate requests — and there is an open Kaggle report
    of notebook outputs being capped at 500 items, which cannot be checked from
    here.

    So the session writes **one** verified archive. Without this cell the corpus
    pass happens, is not retrievable in any practical way, and the next session
    redoes it: 47 minutes per session, forever.
    """

    @staticmethod
    def _joined() -> str:
        return "\n".join(source for _index, source in code_cells(NOTEBOOK))

    def test_the_session_writes_a_single_cache_archive(self):
        joined = self._joined()
        self.assertIn("corpus_cache archive", joined,
                      "nothing in the notebook produces the one-file archive the "
                      "pull depends on")
        self.assertIn("corpus-cache.tgz", joined)

    def test_the_archive_is_written_after_the_shards_exist(self):
        shard_cell = None
        archive_cell = None
        for index, source in code_cells(NOTEBOOK):
            if "training.scripts.shard_summary" in source:
                shard_cell = index
            if "corpus_cache archive" in source:
                archive_cell = index
        self.assertIsNotNone(shard_cell, "the shard pass is gone")
        self.assertIsNotNone(archive_cell, "the archive cell is gone")
        self.assertLess(shard_cell, archive_cell,
                        "an archive written before the shards exist would contain "
                        "no corpus — the 47-minute pass would be discarded at the "
                        "exact moment it finished")

    def test_the_archive_is_verified_before_it_is_written(self):
        """`archive` calls `verify` first, so a cache whose shards and tokenizer
        disagree cannot leave the session as a single file that a later session
        installs without complaint.

        Comment lines are excluded before the two are ordered. Without that,
        explaining in the cache cell that `corpus_cache archive` wraps its
        payload in a directory put that phrase earlier in the notebook than the
        save that precedes it, and the guard failed on a sentence.
        """
        commands = "\n".join(
            line for _index, source in code_cells(NOTEBOOK)
            for line in source.splitlines() if not line.strip().startswith("#")
        )
        self.assertIn("corpus_cache save", commands)
        self.assertIn("corpus_cache archive", commands)
        save_at = commands.index("corpus_cache save")
        archive_at = commands.index("corpus_cache archive")
        self.assertLess(save_at, archive_at,
                        "archiving before saving has nothing to read")

    def test_the_consumed_text_is_dropped(self):
        """1.3 GB of data/raw and data/extracted outlives its usefulness the
        moment §6 has run, and only makes the output tree slower to commit."""
        joined = self._joined()
        self.assertIn("data/raw", joined)
        self.assertIn("data/extracted", joined)
        self.assertIn("rmtree", joined)

    def test_the_pull_order_is_written_down(self):
        """The output API has no version field — `ApiListKernelSessionOutputRequest`
        exposes no `kernel_version_number` and `kernels_output` parses `owner/slug/1`
        then never sets it — so a call returns the **latest** version's output.
        Pushing a new kernel before pulling silently discards this one."""
        joined = self._joined()
        self.assertIn("BEFORE pushing a new kernel version", joined,
                      "the pull must happen before the next push, and the notebook "
                      "is where that order is read")


class ManifestKeysExist(unittest.TestCase):
    """The notebook reads `RUN_MANIFEST.json`, so it must read keys it has.

    Measured on Kaggle 2026-10-02: the Stage A notebook's manifest cell printed
    `loss history entries: 0` on a run that had just recorded **20,000** losses
    and passed its gate (first 9.881879, last 3.331249). It read
    `manifest.get('loss_history', [])`; `ckpt.write_run_manifest` nests the same
    data as `loss: {history: [...], verdict: {...}}`. The `.get` default turned a
    wrong key into a tidy `0` — a number, and the wrong one. A `KeyError` would
    have been obvious; this read like a run that recorded nothing.
    """

    @staticmethod
    def _manifest_shape() -> dict:
        """A manifest in the shape `ckpt.write_run_manifest` actually writes."""
        return {
            "run": "stage-a",
            "config": {"vocab_size": 16384, "hidden_size": 512,
                       "num_hidden_layers": 10},
            "tokenizer_version": "portfolio-bpe-16k-45395d2ebc83",
            "params": 37890560,
            "hyperparameters": {"steps": 20000, "batch": 8, "block": 1024,
                                "grad_accum": 8, "lr": 3e-4, "warmup": 200,
                                "clip": 1.0, "weight_decay": 0.1, "amp": True,
                                "device": "cuda"},
            "seed": 1337,
            "data": {"shards": "data/processed/stage_a/shards", "sha256": {}},
            "loss": {"history": [9.881879, 3.331249], "verdict": {
                "verdict": "PASS", "first": 9.8859, "last": 2.8211,
                "delta": -7.0648, "window": 5, "steps": 20000}},
            "throughput": {"tokens_per_second": 13493.314, "seconds_per_step": 0.6071,
                           "block": 1024, "batch": 8},
            "run_scope": "...", "scope": "...",
        }

    @staticmethod
    def _key_paths(node, prefix: str = "") -> set[str]:
        """Every dotted path a key lookup on this manifest can resolve."""
        paths: set[str] = set()
        if isinstance(node, dict):
            for key, value in node.items():
                path = f"{prefix}.{key}" if prefix else key
                paths.add(path)
                paths |= ManifestKeysExist._key_paths(value, path)
        return paths

    def test_every_manifest_key_the_notebook_reads_exists(self):
        import ast as _ast

        available = self._key_paths(self._manifest_shape())
        checked = 0
        for index, source in code_cells(NOTEBOOK):
            if "RUN_MANIFEST" not in source:
                continue
            for node in _ast.walk(_ast.parse(cell_python(source))):
                # manifest['a']['b'] — a chain of constant subscripts
                if not isinstance(node, _ast.Subscript):
                    continue
                target = node.value
                if not (isinstance(target, _ast.Subscript)
                        and isinstance(target.value, _ast.Name)
                        and target.value.id == "manifest"):
                    continue
                first = node.slice
                outer = target.slice
                if not (isinstance(first, _ast.Constant) and isinstance(first.value, str)
                        and isinstance(outer, _ast.Constant) and isinstance(outer.value, str)):
                    continue
                path = f"{outer.value}.{first.value}"
                checked += 1
                with self.subTest(cell=index, key=path):
                    self.assertIn(path, available,
                                  f"cell {index} reads manifest[{path!r}], which "
                                  f"the manifest does not have")
        self.assertGreater(checked, 0,
                           "no manifest key lookup was found to check — the guard "
                           "is inspecting nothing")

    def test_the_cell_does_not_default_a_manifest_key_to_empty(self):
        """.get(key, default) on a manifest is how a missing key becomes a
        plausible number instead of a traceback.

        Comment lines are excluded, and not as a nicety: the first version fired
        on the cell's own explanatory comment, which quotes `` `.get(..., [])` ``
        while describing the defect it fixed. A guard that trips over the note
        explaining why it exists is a guard nobody will leave on.
        """
        for index, source in code_cells(NOTEBOOK):
            for raw in source.splitlines():
                stripped = raw.strip()
                if stripped.startswith("#"):
                    continue
                if "manifest" not in raw or ".get(" not in raw:
                    continue
                with self.subTest(cell=index, line=stripped[:70]):
                    self.fail(
                        f"cell {index} reads a manifest key with `.get(...)`: "
                        f"{stripped!r}\n"
                        f"  A manifest is written once by write_run_manifest and "
                        f"read by every later session; a key that is missing is a "
                        f"shape change, and defaulting it reports a number "
                        f"instead of failing.")


class CacheIsFoundWhereKagglePutsIt(unittest.TestCase):
    """A dataset mount that is never found is a silent no-op.

    The cache cell used to check one hard-coded path, `/kaggle/input/<slug>`.
    The notebook's own repository cell records, from the first real session,
    that a Kaggle Dataset does **not** mount there — "Your Datasets" land under
    `/kaggle/input/datasets/<username>/<slug>/`. So the check was always false,
    the cell printed "no corpus cache attached", and the session spent 47
    minutes rebuilding a corpus that was sitting on the mount. Nothing failed;
    the feature simply never ran.
    """

    def _cache_cell(self) -> str:
        for _index, source in code_cells(NOTEBOOK):
            if "CACHE" in source and "corpus_cache" in source:
                return source
        raise AssertionError("no cell looks for the corpus cache")

    def test_it_searches_for_the_cache_record(self):
        self.assertIn("CACHE.json", self._cache_cell(),
                      "the cell must find the cache by its own record, not by a "
                      "guessed path")

    def test_it_walks_the_mount_rather_than_naming_one_directory(self):
        cell = self._cache_cell()
        self.assertRegex(cell, r"rglob\(\s*'CACHE\.json'\s*\)",
                         "the mount must be walked; a single named path is what "
                         "was wrong")

    def test_the_cell_actually_finds_a_cache_under_the_real_layout(self):
        """The strongest form: run the lookup against a simulated mount.

        Four shapes, because three of them are real. The published corpus
        dataset holds one `corpus-cache.tgz` — a directory of 3,521 files was
        uploaded with `kaggle datasets create -p .` and only `CACHE.json`
        arrived, silently and with no error. And `corpus_cache archive` writes
        its members rooted at `corpus-cache/`, so extracting into a directory of
        that name nests it twice; the first version of the cell looked one level
        down and found nothing, which would have looked exactly like no cache.
        """
        import io as _io
        import tarfile as _tarfile
        import tempfile as _tempfile
        from pathlib import Path as _Path

        source = self._cache_cell().split("if CACHE:")[0]

        def lookup(mount_root, work_root):
            body = source.replace("MOUNT = '/kaggle/input'",
                                  f"MOUNT = {str(mount_root)!r}")
            body = body.replace("WORK = '/kaggle/working'",
                                f"WORK = {str(work_root)!r}")
            namespace: dict = {}
            real, sys.stdout = sys.stdout, _io.StringIO()
            try:
                exec(compile(body, "cache-cell", "exec"), namespace)  # noqa: S102
            finally:
                sys.stdout = real
            return namespace.get("CACHE")

        def archive(destination, wrapped: bool, scratch):
            payload_dir = _Path(scratch) / "payload"
            payload_dir.mkdir(parents=True, exist_ok=True)
            prefix = "corpus-cache/" if wrapped else ""
            with _tarfile.open(destination, "w:gz") as tar:
                for member, payload in (("CACHE.json", "{}"),
                                        ("shards/manifest.json", "{}")):
                    holder = payload_dir / _Path(member).name
                    holder.write_text(payload, encoding="utf-8")
                    tar.add(holder, arcname=prefix + member)

        with _tempfile.TemporaryDirectory() as tmp:
            root = _Path(tmp)
            # 1. the published shape: one archive whose payload is wrapped
            mount = root / "input" / "datasets" / "aashishkumarrajput" / \
                "aashish-ai-stage-a-corpus"
            mount.mkdir(parents=True)
            archive(mount / "corpus-cache.tgz", wrapped=True, scratch=root)
            found = lookup(root / "input", root / "working")
            self.assertIsNotNone(found, "the published archive was not found")
            self.assertTrue((found / "CACHE.json").is_file(),
                            f"extraction landed somewhere unexpected: {found}")

        with _tempfile.TemporaryDirectory() as tmp:
            root = _Path(tmp)
            # 2. a flat archive, no wrapping directory
            mount = root / "input" / "datasets" / "u" / "s"
            mount.mkdir(parents=True)
            archive(mount / "corpus-cache.tgz", wrapped=False, scratch=root)
            found = lookup(root / "input", root / "working")
            self.assertIsNotNone(found, "a flat archive was not found")

        with _tempfile.TemporaryDirectory() as tmp:
            root = _Path(tmp)
            # 3. a directory holding CACHE.json — a cache attached any other way
            direct = root / "input" / "datasets" / "u" / "s"
            (direct / "shards").mkdir(parents=True)
            (direct / "CACHE.json").write_text("{}", encoding="utf-8")
            self.assertEqual(lookup(root / "input", root / "working"), direct)

        with _tempfile.TemporaryDirectory() as tmp:
            root = _Path(tmp)
            # 4. nothing attached must report absent, not invent one
            (root / "input").mkdir()
            self.assertIsNone(lookup(root / "input", root / "working"))

    def test_an_absent_cache_is_reported_with_where_it_looked(self):
        """`"searched" in cell` is a tautology: declaring the list satisfies it.

        The first version asserted only that, and deleting the reporting loop
        left the variable behind -- so the guard passed on a cell that had
        stopped saying where it looked. Assert the loop that does the reporting.
        """
        self.assertRegex(
            self._cache_cell(), r"for\s+\w+\s+in\s+searched\b",
            "when the cache is missing the cell must actually iterate what it "
            "found and say where it looked; a `searched = []` that is never read "
            "reports nothing")


class ScratchStaysOutOfGit(unittest.TestCase):
    """The dataset tarball and the Kaggle working files are build outputs.

    `git add -A` committed all 2,778 of them once and took `.git` from a few MB
    to 167 MB. Nothing about the content was wrong -- which is why no test
    complained. This asks git itself, so the rule is enforced rather than
    remembered.
    """

    def test_no_kaggle_scratch_is_tracked(self):
        out = subprocess.run(
            ["git", "ls-files", "kaggle-push", "aashish-ai-portfolio.tgz",
             "output.txt"],
            capture_output=True, text=True, cwd=ROOT, encoding="utf-8",
            errors="replace")
        if out.returncode != 0:
            self.skipTest(f"git ls-files failed: {out.stderr.strip()[:120]}")
        tracked = [line for line in out.stdout.splitlines() if line.strip()]
        self.assertEqual(
            tracked, [],
            f"{len(tracked)} build output(s) are tracked: {tracked[:5]}. "
            f"The tarball is a `git archive` of HEAD and kaggle-push/ holds "
            f"pulled logs, checkpoints and the shard tree -- none of it source.")

    def test_the_ignore_rule_is_there_too(self):
        """The guard above reads the index; this reads the rule that keeps it clean."""
        text = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for pattern in ("/kaggle-push/", "/aashish-ai-portfolio.tgz"):
            self.assertIn(pattern, text,
                          f".gitignore does not list {pattern}")


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
