"""Mutation check for the Stage B tokenizer guards (2026-10-03).

Five new tests guard two things: the 16k tokenizer is committed, and cell 3
stops without it. Each mutation breaks one of those in the way the original
defect actually presented, and the runner requires the *named* test to fail -
not merely that something failed - so a guard cannot be credited with catching
a break it did not cause.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

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

TESTS = ("tests.py.test_publish_checkpoint.")


def revert_guard():
    nb = ROOT / "training/notebooks/train_stage_b.ipynb"
    src = nb.read_text(encoding="utf-8")
    return ("print('tokenizer:', pathlib.Path(TOKENIZER, 'tokenizer.json').is_file())",
            src)


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


def main() -> int:
    if len(sys.argv) > 1:
        return edit_notebook(sys.argv[1])

    caught = uncaught = 0
    for name, break_cmd, test, restore_cmd in MUTATIONS:
        print("=" * 70)
        print(name)
        b = run(break_cmd.split() if not break_cmd.startswith("python ") else
                [sys.executable] + break_cmd.split()[1:])
        if b.returncode != 0:
            print(f"  SETUP FAILED: {b.stdout[-300:]}{b.stderr[-300:]}")
            uncaught += 1
            continue

        r = run([sys.executable, "-m", "unittest", TESTS + test])
        failed = r.returncode != 0 and test.rsplit(".", 1)[-1] in r.stderr

        rb = run(restore_cmd.split() if not restore_cmd.startswith("python ") else
                 [sys.executable] + restore_cmd.split()[1:])
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

    print("=" * 70)
    print(f"{caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    return 0 if uncaught == 0 else 1


def edit_notebook(which: str) -> int:
    """Apply or undo one notebook mutation, via git so the file is restored."""
    if which == "--restore-guard":
        run(["git", "checkout", "--", "training/notebooks/train_stage_b.ipynb"])
        return 0
    if which == "--restore-gitignore":
        run(["git", "checkout", "--", ".gitignore"])
        run(["git", "add", "-f",
             "ai/tokenizer/artifacts/stage-a-16k/tokenizer.json",
             "ai/tokenizer/artifacts/stage-a-16k/meta.json"])
        return 0
    if which == "--rebreak-gitignore":
        # Put back the rule that caused the whole defect: the 16k artifact is a
        # build output and stays out. Force-removing it from the index as well is
        # what makes that rule bite - on its own it is only a latent hazard,
        # since an already-tracked file survives an ignore rule.
        gi = ROOT / ".gitignore"
        text = gi.read_text(encoding="utf-8")
        gi.write_text(
            text.replace("!ai/tokenizer/artifacts/stage-a-16k/\n", ""),
            encoding="utf-8")
        run(["git", "update-index", "--force-remove",
             "ai/tokenizer/artifacts/stage-a-16k/tokenizer.json",
             "ai/tokenizer/artifacts/stage-a-16k/meta.json"])
        return 0
    if which == "--revert-guard":
        import json
        p = ROOT / "training/notebooks/train_stage_b.ipynb"
        nb = json.loads(p.read_text(encoding="utf-8"))
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
        p.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n",
                     encoding="utf-8")
        return 0
    if which in ("--thin-message", "--always-raise"):
        import json
        p = ROOT / "training/notebooks/train_stage_b.ipynb"
        nb = json.loads(p.read_text(encoding="utf-8"))
        for cell in nb["cells"]:
            src = "".join(cell.get("source", []))
            if "No tokenizer at" not in src:
                continue
            if which == "--thin-message":
                src = src.replace(
                    "'no error to notice. The artifact is committed at '",
                    "'typo. The artifact is committed at '")
            else:
                src = src.replace(
                    "if not pathlib.Path(TOKENIZER, 'tokenizer.json').is_file():",
                    "if True:")
            cell["source"] = src.splitlines(keepends=True)
        p.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n",
                     encoding="utf-8")
        return 0
    raise SystemExit(f"unknown mutation {which}")


if __name__ == "__main__":
    raise SystemExit(main())
