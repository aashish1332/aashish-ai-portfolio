"""Mutation-test the publisher/notebook contract. Run it, do not read it.

    PYTHONUTF8=1 python tools/mutate_publish.py

The contract is a filename, which is the one kind of coupling that stays quiet
until the far end moves: `tools/publish_checkpoint.py` decides what is uploaded,
`train_stage_b.ipynb` decides what is read, and for one commit they disagreed
about `RUN_MANIFEST.json`. These three mutations put the disagreement back.

The second one is the interesting one. It breaks the *extraction* of the
notebook's file references rather than the publisher, and the coverage tests
still pass — because a test that checks "the notebook's files ⊆ staged files"
is trivially true when the notebook's file list is empty. The anti-vacuity test
is the only thing standing between this mutation and a green suite, so it is
pinned here like everything else.
"""

from __future__ import annotations

import mutation_env

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLISHER = ROOT / "tools" / "publish_checkpoint.py"
TEST = ROOT / "tests" / "py" / "test_publish_checkpoint.py"

MUTATIONS: list[tuple[str, Path, str, str, str, str]] = [
    (
        "P1 a weights-only publish drops the run manifest again",
        PUBLISHER,
        '    return ("latest.pt", "RUN_MANIFEST.json")\n',
        '    return ("latest.pt",)\n',
        "tests.py.test_publish_checkpoint.ThePublisherShipsWhatTheNotebookReads."
        "test_a_weights_only_publish_covers_the_notebook",
        # The weights-only test's own wording. The first version of this entry
        # used the *resumable* test's phrase, so the mutation was caught and
        # then reported as WRONG REASON - caught, for the wrong reason, by a
        # runner that had quoted the wrong sentence.
        "a weights-only publish ships",
    ),
    (
        "P2 the notebook's file references stop being found",
        TEST,
        '    re.compile(r"\\{STAGE_A\\}/([A-Za-z0-9_.-]+)"),\n',
        "",
        "tests.py.test_publish_checkpoint.ThePublisherShipsWhatTheNotebookReads."
        "test_the_notebook_was_parsed_into_something",
        "the notebook no longer opens RUN_MANIFEST.json",
    ),
    (
        "P3 best.pt stops being the only name a weights-only publish drops",
        PUBLISHER,
        '    if resumable:\n        return ("latest.pt", "best.pt", "RUN_MANIFEST.json")\n',
        '    if resumable:\n        return ("latest.pt", "RUN_MANIFEST.json")\n',
        "tests.py.test_publish_checkpoint.ThePublisherShipsWhatTheNotebookReads."
        "test_a_weights_only_publish_drops_only_best_pt",
        # The assertion's own message, not a guess at how unittest renders a
        # set comparison. Guessing cost this runner a WRONG REASON twice
        # elsewhere; the rule is simply that evidence is read, not invented.
        "a weights-only publish should drop best.pt and nothing else",
    ),
    (
        # The same defect, aimed at the test that EXECUTES the notebook's finder
        # rather than comparing name lists. If this one were uncaught, the
        # execution test would be decoration: it would look like the strongest
        # check in the file while adding nothing.
        "P4 the notebook's own finder stops accepting a weights-only publish",
        PUBLISHER,
        '    return ("latest.pt", "RUN_MANIFEST.json")\n',
        '    return ("latest.pt",)\n',
        "tests.py.test_publish_checkpoint."
        "TheNotebooksOwnFinderRunsAgainstEachPublishShape."
        "test_both_publish_shapes_are_accepted_by_the_notebook",
        "refused by find_stage_a()",
    ),
]


def run(target: str) -> tuple[int, str]:
    """Routed through `mutation_env` so the bytecode cache cannot lie.

    See that module for the measurement: four of these five runners started
    reporting caught mutations as survived because a stale `__pycache__` entry
    satisfied the (mtime, size) check for a file that had already been
    restored. A mutation score taken before this change was partly a
    measurement of disk speed.
    """
    return mutation_env.run_test(target)




def main() -> int:
    caught = uncaught = 0
    # Once per run, before the first subprocess: a stale .pyc from an earlier
    # write is what made these runners report caught mutations as survived.
    mutation_env.clear_bytecode_caches()
    print(f"{len(MUTATIONS)} mutations against the publisher contract\n" + "=" * 68)

    for label, path, find, replace, target, evidence in MUTATIONS:
        original = path.read_text(encoding="utf-8")
        if find not in original:
            print(f"\nSKIP  {label}\n      pattern not found in {path.name} "
                  f"- the code moved; update the mutation")
            uncaught += 1
            continue
        try:
            path.write_text(original.replace(find, replace, 1), encoding="utf-8",
                            newline="")
            code, out = run(target)
        finally:
            path.write_text(original, encoding="utf-8", newline="")

        if code == 0:
            print(f"\nUNCAUGHT  {label}\n      {target} still passed with the "
                  f"defect reintroduced.\n      This check cannot fail for the "
                  f"reason it claims.")
            uncaught += 1
            continue
        tail = [ln for ln in out.splitlines() if ln.startswith(("FAIL:", "ERROR:"))]
        if evidence in out:
            print(f"\nCAUGHT    {label}\n      target: {target.split('.')[-1]}")
            for line in tail[:2]:
                print(f"      {line}")
            caught += 1
        else:
            print(f"\nWRONG REASON  {label}\n      {target} failed, but the output "
                  f"never says {evidence!r}.\n      It tripped something else; this "
                  f"proves nothing about the guard.")
            for line in tail[:2]:
                print(f"      {line}")
            uncaught += 1

    print(f"\n{'=' * 68}")
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print(f"{'=' * 68}")

    code, _ = run("tests.py.test_publish_checkpoint")
    if code != 0:
        print("\nRESTORE FAILED - the contract tests no longer pass. Check git diff.")
        return 1
    return 1 if uncaught else 0


if __name__ == "__main__":
    raise SystemExit(main())
