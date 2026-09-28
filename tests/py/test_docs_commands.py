"""tests/py/test_docs_commands.py — the docs' commands, checked against what they name.

`tests/py/test_notebook_refs.py` does this for the notebooks, because a stale
flag in a notebook is paid for in GPU-hours. A README or a runbook is paid for
in something arguably worse: a human follows it, it fails, and the next thing
they do is stop trusting the file. That is not hypothetical here —
`docs/TRAINING.md` told a reader to run

    make_instruction_data --examples 40000

for a CLI whose flag is `--count`. Nobody found it with a test; it was found by
hand, by writing the command next to the parser that would have rejected it.
This file is the test that was missing.

All of it is offline, and it checks only things that have a single source of
truth to be wrong about:

* every `python -m <module>` / `python <path>.py` in a fenced block exists;
* it answers `--help` — the same uniform-interface rule the notebook test
  enforces, since a CLI that treats `--help` as data cannot be validated;
* every `--flag` it is given exists in that CLI's own parser;
* every `npm run <script>` names a script in `package.json`, and a script's
  `--` passthrough flags are checked against the CLI that script runs;
* every `node <file>` names a file that exists;
* every `dev-*.js` named anywhere in the file exists — renaming a probe while
  a document still points at the old name is exactly the kind of rot that reads
  as a working instruction.

Deliberately NOT checked: any number written in prose (test counts, byte sizes,
latencies). A test cannot know those, and a test that guessed would be worse
than a reader who can see the date next to the figure.
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

# Every markdown file a reader is expected to follow. The three spec-section
# rollups and the final report quote commands too, and a runbook is only as
# good as its worst line.
DOCS = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]

MODULE_RE = re.compile(r"python3?\s+-m\s+([A-Za-z0-9_.]+)")
SCRIPT_RE = re.compile(r"python3?\s+([\w./-]+\.py)")
NPM_RE = re.compile(r"npm\s+run\s+([\w:@.-]+)")
NODE_RE = re.compile(r"(?<![\w./-])node\s+([\w./-]+\.(?:js|mjs))")
DEV_RE = re.compile(r"\b(dev-[a-z0-9-]+\.js)\b")
FLAG_RE = re.compile(r"(?<![\w-])(--[a-z][a-z0-9-]*)")

# `--help` is one subprocess per CLI and the answer cannot change mid-run.
_HELP_CACHE: dict[str, set[str] | None] = {}


def scripts() -> dict[str, str]:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]


def each_doc():
    for path in DOCS:
        yield path.relative_to(ROOT).as_posix(), path


def fenced_blocks(text: str) -> list[str]:
    """The ```…``` blocks as whole strings — runnable commands live there."""
    blocks: list[str] = []
    current: list[str] = []
    inside = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            if inside:
                blocks.append("\n".join(current))
                current = []
            inside = not inside
            continue
        if inside:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def strip_comment(command: str) -> str:
    """`--in data/raw/x   # parquet` → the command alone.

    The space before `#` is required so a `#` inside a value is never treated
    as a comment.
    """
    return re.sub(r"\s+#.*$", "", command).strip()


def joined_commands(block: str) -> list[str]:
    """A block's logical commands, with `\\` continuations joined."""
    out: list[str] = []
    buffer = ""
    for raw in block.splitlines():
        line = raw.rstrip()
        if not buffer:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
        if line.endswith("\\"):
            buffer += line[:-1] + " "
            continue
        buffer += line
        out.append(strip_comment(buffer))
        buffer = ""
    if buffer.strip():
        out.append(strip_comment(buffer))
    return [command for command in out if command.strip()]


def documented_commands():
    """`(doc, command)` for every command in every fenced block."""
    for name, path in each_doc():
        for block in fenced_blocks(path.read_text(encoding="utf-8")):
            for command in joined_commands(block):
                yield name, command


def invoked_by(command: str) -> str | None:
    """The python target a command runs, or None if it runs something else."""
    match = MODULE_RE.search(command) or SCRIPT_RE.search(command)
    return match.group(1) if match else None


def script_target(name: str) -> str | None:
    """The python target an npm script runs, for its `--` passthrough flags."""
    body = scripts().get(name)
    if not body:
        return None
    match = MODULE_RE.search(body) or SCRIPT_RE.search(body)
    return match.group(1) if match else None


def help_flags(target: str) -> set[str] | None:
    """The `--flags` a CLI advertises, or None when it cannot be asked."""
    if target in _HELP_CACHE:
        return _HELP_CACHE[target]
    argv = ([sys.executable, "-m", target] if not target.endswith(".py")
            else [sys.executable, str(ROOT / target)])
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


def target_file(target: str) -> Path:
    return ROOT / target if target.endswith(".py") else ROOT / (target.replace(".", "/") + ".py")


# The docs that are chiefly a runbook. A doc with no commands is not a defect
# (PRIVACY.md and PROGRESS.md are prose), but one of these losing its commands
# would silence the checks below without failing anything — the failure mode a
# validator has to guard against in itself.
RICH_DOCS = {"README.md", "docs/TRAINING.md"}


class ItChecksSomething(unittest.TestCase):
    """A validator that silently stops finding commands proves nothing."""

    def test_the_runbooks_still_yield_commands(self):
        for name, path in each_doc():
            if name not in RICH_DOCS:
                continue
            with self.subTest(doc=name):
                blocks = fenced_blocks(path.read_text(encoding="utf-8"))
                self.assertTrue(blocks, f"{name} has no fenced blocks")
                found = list(joined_commands("\n".join(blocks)))
                self.assertGreaterEqual(len(found), 5, f"{name} yielded {len(found)} commands")

    def test_all_docs_together_yield_plenty(self):
        found = list(documented_commands())
        self.assertGreaterEqual(len(found), 20, f"only {len(found)} commands found across the docs")

    def test_flags_are_actually_found(self):
        """If FLAG_RE ever stops matching, the flag check below goes quiet."""
        commands = [c for _name, c in documented_commands()]
        self.assertTrue(any(FLAG_RE.findall(c) for c in commands),
                        "no --flag found in any documented command")


class Targets(unittest.TestCase):
    def test_every_documented_module_or_script_exists(self):
        seen: set[str] = set()
        for _name, command in documented_commands():
            target = invoked_by(command)
            if target:
                seen.add(target)
        self.assertTrue(seen, "no python target found in the docs")
        for target in sorted(seen):
            with self.subTest(target=target):
                self.assertTrue(target_file(target).is_file(),
                                f"{target} is documented but does not exist")

    def test_every_documented_cli_answers_help(self):
        for name, command in documented_commands():
            target = invoked_by(command)
            if not target:
                continue
            with self.subTest(doc=name, target=target):
                self.assertIsNotNone(help_flags(target),
                                     f"{target} --help failed; is it a module?")

    def test_every_documented_flag_exists_in_that_cli(self):
        for name, command in documented_commands():
            target = invoked_by(command)
            if not target:
                continue
            known = help_flags(target)
            if known is None:
                continue  # reported by test_every_documented_cli_answers_help
            for flag in FLAG_RE.findall(command):
                with self.subTest(doc=name, target=target, flag=flag):
                    self.assertIn(flag, known, f"{flag} is not a {target} flag")

    def test_a_scripts_passthrough_flags_exist_too(self):
        """`npm run sft -- --count 40000` is a flag on the CLI behind the script."""
        for name, command in documented_commands():
            match = NPM_RE.search(command)
            if not match or "-- " not in command:
                continue
            passthrough = command.split("-- ", 1)[1]
            if not passthrough.strip():
                continue
            target = script_target(match.group(1))
            if not target:
                continue
            known = help_flags(target)
            if known is None:
                continue
            for flag in FLAG_RE.findall(passthrough):
                with self.subTest(doc=name, script=match.group(1), flag=flag):
                    self.assertIn(flag, known, f"{flag} is not a {target} flag")


class Names(unittest.TestCase):
    def test_every_documented_npm_script_exists(self):
        known = scripts()
        for name, path in each_doc():
            text = path.read_text(encoding="utf-8")
            for script in sorted(set(NPM_RE.findall(text))):
                with self.subTest(doc=name, script=script):
                    self.assertIn(script, known, f"npm run {script} is not a script")

    def test_every_documented_node_file_exists(self):
        for name, path in each_doc():
            text = path.read_text(encoding="utf-8")
            for file in sorted(set(NODE_RE.findall(text))):
                with self.subTest(doc=name, file=file):
                    self.assertTrue((ROOT / file).is_file(),
                                    f"node {file} is documented but does not exist")

    def test_every_dev_probe_named_anywhere_exists(self):
        """In prose as well as in blocks: renaming a probe must not leave a
        document pointing at the old name."""
        for name, path in each_doc():
            text = path.read_text(encoding="utf-8")
            for probe in sorted(set(DEV_RE.findall(text))):
                with self.subTest(doc=name, probe=probe):
                    self.assertTrue((ROOT / probe).is_file(),
                                    f"{probe} is named in {name} but does not exist")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
