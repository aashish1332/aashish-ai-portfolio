"""Mutation check for the Stage B tokenizer guards (2026-10-03).

Five tests guard two things: the 16k tokenizer is committed, and cell 3 stops
without it. Each mutation breaks one of those in the way the original defect
actually presented, and the runner requires the *named* test to fail - not
merely that something failed - so a guard cannot be credited with catching a
break it did not cause.

**The restore must not use `git checkout`.** It used to, for both the notebook
and `.gitignore`, because these mutations are partly *index* mutations
(`git update-index --force-remove`) that a plain file restore cannot undo. But
`git checkout -- <path>` restores the file to **HEAD**, not to what was there
when the run started, so it silently threw away uncommitted work.

MEASURED 2026-10-03: a `--steps 500` edit to cell 13, made minutes earlier and
never committed, was gone after one run of this file. `git status` afterwards
showed a clean tree, which is the worst possible failure mode - the runner
reported 5/5 and took the change with it.

So the originals are snapshotted in memory at the top of `main()` and written
back byte for byte. The git *index* mutations are still undone with git,
because that is the only thing that can undo them; that is the narrow, correct
use of git here. `--restore-guard` and `--restore-gitignore` survive as CLI modes
because `MUTATIONS` invokes them as subprocesses, and they now restore from a
snapshot file rather than from HEAD.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "training/notebooks/train_stage_b.ipynb"
GITIGNORE = ROOT / ".gitignore"
ARTIFACT_FILES = [
    "ai/tokenizer/artifacts/stage-a-16k/tokenizer.json",
    "ai/tokenizer/artifacts/stage-a-16k/meta.json",
]

MUTATIONS = [
    ("M1 the .gitignore negation reverted and the artifact untracked again",
     "python tools/mutate_stageb_tokenizer.py --rebreak-gitignore",
     "test_the_artifact_is_in_the_tracked_tree_not_just_on_this_disk",
     # Two things learned the hard way here, both on 2026-10-03:
     # * The restore must put the artifact back in the INDEX, not just on disk.
     #   With only `git checkout -- .gitignore` the mutation left `git ls-files`
     #   missing tokenizer.json, so the next full-suite run failed on the very
     #   test this runner had just "passed" - a runner that damages the tree it
     #   audits makes its own score untrustworthy.
     # * It must not contain `&&` or `||`. This runner splits the command on
     #   whitespace rather than handing it to a shell, so `git add -f ... &&
     #   git checkout ...` became one malformed git invocation. (M1's original
     #   setup command had a `||` and failed the same way.)
     # Hence one Python mode that does both steps.
     "python tools/mutate_stageb_tokenizer.py --restore-gitignore"),

    ("M2 meta.json untracked (half the artifact shipped)",
     "git update-index --force-remove ai/tokenizer/artifacts/stage-a-16k/meta.json",
     "test_the_artifact_is_in_the_tracked_tree_not_just_on_this_disk",
     "git add -f ai/tokenizer/artifacts/stage-a-16k/meta.json"),

    ("M3 notebook prints a boolean again instead of enforcing",
     "python tools/mutate_stageb_tokenizer.py --revert-guard",
     "test_the_notebook_stops_when_the_tokenizer_is_missing",
     "python tools/mutate_stageb_tokenizer.py --restore-guard"),

    ("M4 the guard raises but the message loses the silent-corruption reason",
     "python tools/mutate_stageb_tokenizer.py --thin-message",
     "test_the_notebook_stops_when_the_tokenizer_is_missing",
     "python tools/mutate_stageb_tokenizer.py --restore-guard"),

    ("M5 the guard raises unconditionally (rejects a good tokenizer too)",
     "python tools/mutate_stageb_tokenizer.py --always-raise",
     "test_the_notebook_continues_when_the_tokenizer_is_present",
     "python tools/mutate_stageb_tokenizer.py --restore-guard"),
]

TESTS = "tests.py.test_publish_checkpoint."


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def _cmd(spec: str) -> list[str]:
    """Turn a `MUTATIONS` command string into an argv.

    Split on whitespace only: this runner has no shell, which is deliberate
    (see M1) and is why no command here may contain `&&` or `||`.
    """
    parts = spec.split()
    if parts and parts[0] == "python":
        return [sys.executable] + parts[1:]
    return parts


def _write_nb(nb: dict) -> None:
    NOTEBOOK.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8", newline="")


def _load_nb() -> dict:
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))


def main() -> int:
    if len(sys.argv) > 1:
        return edit(sys.argv[1])

    # Snapshot before the first mutation. `--restore-guard` runs as a
    # subprocess, so the snapshot has to live somewhere it can read; a temp
    # file is handed down through the environment rather than guessed at.
    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp)
        (snap / "notebook").write_text(NOTEBOOK.read_text(encoding="utf-8"),
                                       encoding="utf-8")
        (snap / "gitignore").write_text(GITIGNORE.read_text(encoding="utf-8"),
                                        encoding="utf-8")
        import os
        os.environ["MUTATE_STAGEB_SNAPSHOT"] = str(snap)

        caught = uncaught = 0
        for name, break_cmd, test, restore_cmd in MUTATIONS:
            print("=" * 70)
            print(name)
            b = run(_cmd(break_cmd))
            if b.returncode != 0:
                print(f"  SETUP FAILED: {b.stdout[-300:]}{b.stderr[-300:]}")
                uncaught += 1
                continue

            r = run([sys.executable, "-m", "unittest", TESTS + test])
            failed = r.returncode != 0 and test.rsplit(".", 1)[-1] in r.stderr

            rb = run(_cmd(restore_cmd))
            if rb.returncode != 0:
                print(f"  RESTORE FAILED: {rb.stdout[-300:]}{rb.stderr[-300:]}")
                uncaught += 1
                continue

            if failed:
                print(f"  caught: {test}")
                caught += 1
            else:
                print(f"  NOT CAUGHT by {test} (exit {r.returncode})")
                uncaught += 1

        # Belt and braces: put both files back from the snapshot no matter what,
        # so a failed restore above cannot leave a mutation in the tree.
        for target, name in ((NOTEBOOK, "notebook"), (GITIGNORE, "gitignore")):
            target.write_text((snap / name).read_text(encoding="utf-8"),
                              encoding="utf-8", newline="")

    print("=" * 70)
    print(f"{caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    return 0 if uncaught == 0 else 1


def edit(which: str) -> int:
    """Apply or undo one mutation.

    Undo restores from the snapshot `main()` took, *not* from HEAD. `git` is
    used only for the index, which a file write genuinely cannot fix.
    """
    import os

    snap_dir = os.environ.get("MUTATE_STAGEB_SNAPSHOT")

    if which in ("--restore-guard", "--restore-gitignore"):
        if not snap_dir:
            print("no snapshot to restore from; run the runner, not this mode",
                  file=sys.stderr)
            return 2
        snap = Path(snap_dir)
        which_file = ("notebook" if which == "--restore-guard" else "gitignore")
        target = NOTEBOOK if which == "--restore-guard" else GITIGNORE
        target.write_text((snap / which_file).read_text(encoding="utf-8"),
                          encoding="utf-8", newline="")
        if which == "--restore-gitignore":
            # The index part still needs git: the mutation force-removed these
            # from it, and no amount of rewriting `.gitignore` puts them back.
            run(["git", "add", "-f"] + ARTIFACT_FILES)
        return 0

    if which == "--rebreak-gitignore":
        # Put back the rule that caused the whole defect: the 16k artifact is a
        # build output and stays out. Force-removing it from the index as well is
        # what makes that rule bite - on its own it is only a latent hazard,
        # since an already-tracked file survives an ignore rule.
        text = GITIGNORE.read_text(encoding="utf-8")
        GITIGNORE.write_text(
            text.replace("!ai/tokenizer/artifacts/stage-a-16k/\n", ""),
            encoding="utf-8", newline="")
        run(["git", "update-index", "--force-remove"] + ARTIFACT_FILES)
        return 0

    if which == "--revert-guard":
        nb = _load_nb()
        hit = False
        for cell in nb["cells"]:
            src = "".join(cell.get("source", []))
            start = src.find("if not pathlib.Path(TOKENIZER")
            if start < 0:
                continue
            end = src.find("print('instruction data:'")
            cell["source"] = (
                src[:start]
                + "print('tokenizer:', pathlib.Path(TOKENIZER, "
                  "'tokenizer.json').is_file())\n"
                + src[end:]).splitlines(keepends=True)
            hit = True
        if not hit:
            print("guard cell not found; the notebook moved", file=sys.stderr)
            return 2
        _write_nb(nb)
        return 0

    if which in ("--thin-message", "--always-raise"):
        nb = _load_nb()
        hit = False
        for cell in nb["cells"]:
            src = "".join(cell.get("source", []))
            if "No tokenizer at" not in src:
                continue
            if which == "--thin-message":
                new = src.replace(
                    "'no error to notice. The artifact is committed at '",
                    "'typo. The artifact is committed at '")
            else:
                new = src.replace(
                    "if not pathlib.Path(TOKENIZER, 'tokenizer.json').is_file():",
                    "if True:")
            if new == src:
                print(f"anchor for {which} moved; update the mutation",
                      file=sys.stderr)
                return 2
            cell["source"] = new.splitlines(keepends=True)
            hit = True
        if not hit:
            print(f"guard cell not found for {which}", file=sys.stderr)
            return 2
        _write_nb(nb)
        return 0

    raise SystemExit(f"unknown mutation {which}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())