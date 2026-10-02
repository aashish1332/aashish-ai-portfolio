"""Does the checkpoint publisher ship what the Stage B notebook reads?

    PYTHONUTF8=1 python -m unittest tests.py.test_publish_checkpoint

The defect this exists for, found 2026-10-02 by reading the published archive
against the notebook rather than trusting either: a **weights-only** publish
staged `latest.pt` and `CHECKPOINT.json` and nothing else, while
`train_stage_b.ipynb`'s cell 5 does

    manifest = json.load(open(f'{STAGE_A}/RUN_MANIFEST.json'))

So the very first Stage B session that could use a weights-only Stage A
checkpoint — which is exactly what v3 will produce, because v3 runs the trainer
as it stood before the staleness fix — would have stopped at the setup cell and
refused to run. `RUN_MANIFEST.json` is 465 KB next to a 150 MB checkpoint, so
nothing about size argued for leaving it out.

**What the failure actually looked like**, measured rather than assumed, because
the first version of this file's docstring said it was a bare
`FileNotFoundError` two cells in and that was wrong: `find_stage_a()` requires
*both* `latest.pt` and `RUN_MANIFEST.json` before it will return a directory, so
it returned `None` and the cell raised

    SystemExit: No Stage A checkpoint found. Looked for a RUN_MANIFEST.json
    beside a latest.pt, and for stage-a-checkpoint.tgz, under /kaggle/input.

which names the missing file and the fix. The block was real and total — Stage B
cannot run without a Stage A checkpoint — but the diagnosis was much better than
the one I first wrote down. `test_the_notebooks_own_finder_accepts_both_publish_shapes`
now runs the notebook's function against each declared shape, so the consequence
is measured by the suite rather than argued in a comment.

Nothing else in the suite could have caught the original defect. The publisher is
a script, the notebook is JSON, and the link between them is a filename — the one
kind of coupling that no test notices until the far end moves.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLISHER = ROOT / "tools" / "publish_checkpoint.py"
NOTEBOOK = ROOT / "training" / "notebooks" / "train_stage_b.ipynb"

#: How the notebook names a file under its `$STAGE_A` directory. Both spellings
#: occur: `$STAGE_A/latest.pt` in a shell line and `f'{STAGE_A}/...'` in Python.
REFERENCES = (
    re.compile(r"\$STAGE_A/([A-Za-z0-9_.-]+)"),
    re.compile(r"\{STAGE_A\}/([A-Za-z0-9_.-]+)"),
)


def _load_publisher():
    name = "publish_checkpoint_under_test"
    spec = importlib.util.spec_from_file_location(name, PUBLISHER)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec for the same reason as everywhere else: a decorator
    # that resolves annotations through sys.modules[cls.__module__] fails on a
    # module that is not in there.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def notebook_stage_a_files() -> set[str]:
    """Every filename the Stage B notebook reads out of `$STAGE_A`."""
    cells = json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]
    source = "\n".join("".join(cell.get("source", [])) for cell in cells)
    names: set[str] = set()
    for pattern in REFERENCES:
        names.update(pattern.findall(source))
    return names


class ThePublisherShipsWhatTheNotebookReads(unittest.TestCase):
    def setUp(self):
        self.pub = _load_publisher()
        self.notebook_files = notebook_stage_a_files()

    def test_the_notebook_was_parsed_into_something(self):
        # If the reference patterns ever stop matching — a notebook edit that
        # renames the variable, say — every assertion below would pass
        # vacuously against an empty set. So the extraction is itself checked.
        self.assertIn("latest.pt", self.notebook_files,
                      "the notebook no longer names latest.pt under $STAGE_A")
        self.assertIn("RUN_MANIFEST.json", self.notebook_files,
                      "the notebook no longer opens RUN_MANIFEST.json")

    def test_a_resumable_publish_covers_the_notebook(self):
        staged = set(self.pub.staged_names(True))
        self.assertLessEqual(
            self.notebook_files, staged,
            f"the notebook reads {sorted(self.notebook_files)} but a resumable "
            f"publish ships {sorted(staged)}")

    def test_a_weights_only_publish_covers_the_notebook(self):
        # The regression. A weights-only publish is the shape v3 will produce.
        staged = set(self.pub.staged_names(False))
        self.assertLessEqual(
            self.notebook_files, staged,
            f"the notebook reads {sorted(self.notebook_files)} but a "
            f"weights-only publish ships {sorted(staged)}")

    def test_a_weights_only_publish_drops_only_best_pt(self):
        # `best.pt` is dropped deliberately, and the reason is recorded: a
        # weights-only copy has no optimizer state, so nothing resumes from it.
        resumable = set(self.pub.staged_names(True))
        weights_only = set(self.pub.staged_names(False))
        self.assertEqual(resumable - weights_only, {"best.pt"},
                         "a weights-only publish should drop best.pt and "
                         "nothing else")

    def test_the_manifest_travels_in_both_shapes(self):
        for resumable in (True, False):
            with self.subTest(resumable=resumable):
                self.assertIn("RUN_MANIFEST.json", self.pub.staged_names(resumable),
                              "the run manifest is the record that joins Stage A "
                              "to Stage B; it is not optional")


class TheNotebooksOwnFinderRunsAgainstEachPublishShape(unittest.TestCase):
    """The end of the chain, executed rather than argued.

    The tests above compare two *lists of names*. This one takes the names the
    publisher declares, writes an archive with exactly those members, and runs
    `train_stage_b.ipynb`'s own `find_stage_a()` over it — the notebook's code,
    not a paraphrase of it.

    It is also what corrected the docstring above. The consequence of the missing
    manifest was assumed to be a bare `FileNotFoundError` in cell 5; running the
    function showed it is a deliberate `SystemExit` in cell 3 that names the
    missing file, because the finder will not return a directory unless *both*
    files are there. A guess about a failure mode is worth exactly as much as the
    execution that replaces it.
    """

    def setUp(self):
        self.pub = _load_publisher()
        self.source = "".join(
            "".join(cell.get("source", []))
            for cell in json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"])
        start = self.source.find("def find_stage_a")
        end = self.source.find("STAGE_A = find_stage_a()")
        self.assertGreater(start, 0, "find_stage_a is no longer in the notebook")
        self.assertGreater(end, start, "the notebook no longer calls find_stage_a")
        self.func_source = self.source[start:end]

    def _find(self, members):
        import io
        import tarfile

        mount = Path(self.enterContext(_tempdir()))
        work = Path(self.enterContext(_tempdir()))
        with tarfile.open(mount / "stage-a-checkpoint.tgz", "w:gz") as tar:
            for name in members:
                data = b"{}" if name.endswith(".json") else b"PT"
                info = tarfile.TarInfo(f"stage-a/{name}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        namespace = {"MOUNT": mount, "WORK": work,
                     "pathlib": pathlib, "tarfile": tarfile}
        exec(compile(self.func_source, "train_stage_b cell 3", "exec"), namespace)
        return namespace["find_stage_a"]()

    def test_both_publish_shapes_are_accepted_by_the_notebook(self):
        for resumable in (True, False):
            with self.subTest(resumable=resumable):
                names = self.pub.staged_names(resumable)
                found = self._find(names)
                self.assertIsNotNone(
                    found,
                    f"a {'resumable' if resumable else 'weights-only'} publish of "
                    f"{sorted(names)} is refused by find_stage_a(), so the Stage B "
                    f"notebook would exit before training anything")

    def test_a_publish_without_the_manifest_is_refused(self):
        # The regression, run rather than described: this is the shape that was
        # being produced, and the assertion is that it does not pass.
        found = self._find(["latest.pt", "CHECKPOINT.json"])
        self.assertIsNone(found,
                          "find_stage_a() accepted a checkpoint with no run "
                          "manifest, so the contract test above is looking for "
                          "the wrong thing")


def _tempdir():
    import tempfile
    return tempfile.TemporaryDirectory()


if __name__ == "__main__":
    unittest.main()
