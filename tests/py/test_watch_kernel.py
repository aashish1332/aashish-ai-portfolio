"""Tests for `tools/watch_kernel.py`, the kernel watcher.

This tool is small and does one job: it is the only thing standing between a
finished Kaggle kernel and a training log that can never be fetched again. Every
test here is about a way it was found *not* doing that job.

Found 2026-10-02, all three from the same stretch of watching a live run:

* The log filename was hardcoded `kaggle-v2.log`. Since a watcher's `REF` names
  the *kernel* and each run is a *version* of it, watching version 3 would have
  written its log straight over version 2's — silently, because `write_text` on
  an existing path is not an error.
* The watcher was killed mid-watch (88 healthy polls, then nothing) and left no
  trace of why, because it said nothing about itself at startup. A tool that can
  be killed silently has to describe itself first.
* A failed log fetch and an empty log produced the same message, so a network
  blip would have been recorded permanently as "Kaggle returned an empty log" —
  a claim about the run, made from evidence about the network.

The last two are checked by *running* `main` against a fake Kaggle API rather
than by reading its source, for the reason recorded three times in this suite
already: text-shaped guards happily pass wrong behaviour.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "tools" / "watch_kernel.py"
HAVE_MODULE = MODULE_PATH.is_file()


def _load():
    spec = importlib.util.spec_from_file_location("watch_kernel_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(HAVE_MODULE, f"{MODULE_PATH} is not present")
class WatchKernelCase(unittest.TestCase):
    def setUp(self):
        self.wk = _load()
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(self._restore_kaggle)
        self._saved = sys.modules.get("kaggle.api.kaggle_api_extended", "<absent>")

    def _restore_kaggle(self):
        if self._saved == "<absent>":
            sys.modules.pop("kaggle.api.kaggle_api_extended", None)
        else:
            sys.modules["kaggle.api.kaggle_api_extended"] = self._saved

    def install_fake_api(self, status="RUNNING", logs=None, exc=None):
        """Make `main`'s internal `from kaggle.api... import KaggleApi` resolve to a fake."""
        outer = self

        class FakeApi:
            def authenticate(self):
                return None

            def kernels_status(self, ref):
                return status

            def kernels_logs(self, ref):
                if exc is not None:
                    raise outer.exc_to_raise
                return logs if logs is not None else ""

        self.exc_to_raise = exc
        fake = types.ModuleType("kaggle.api.kaggle_api_extended")
        fake.KaggleApi = FakeApi
        sys.modules["kaggle.api.kaggle_api_extended"] = fake

    def run_main(self, *argv, no_sleep=True, stream=None):
        """Run `main` for real, with its own stdout captured.

        `no_sleep` patches `time.sleep`, which matters because the log-fetch
        retry backs off `10 * attempt` and would make a five-attempt failure
        cost 100 s of a test run. Turn it off for the one case that needs real
        time to pass for its window to close.
        """
        out = stream if stream is not None else io.StringIO()
        patch = mock.patch("time.sleep", return_value=None) if no_sleep \
            else contextlib.nullcontext()
        with patch, redirect_stdout(out):
            code = self.wk.main([*argv, "--out", str(self.tmp)])
        return code, out.getvalue()

    def one_poll_window(self):
        """A window long enough for exactly one poll, then exhausted.

        Used instead of `--max-minutes 0`, which never enters the loop at all:
        the earlier version of these tests assumed a zero window meant "poll
        once", so they asserted against an `out` string that no poll had ever
        touched and could not have contained what they looked for.
        """
        return ("--max-minutes", "0.01", "--every", "1")


class RecordingStream(io.StringIO):
    """A stdout that remembers `reconfigure` calls, and in what order.

    A plain `StringIO` has no `reconfigure`, so code guarded by
    `hasattr(sys.stdout, "reconfigure")` silently does nothing under it — which
    is how a test of the utf-8 fix passed while the fix was not present.
    """

    def __init__(self):
        super().__init__()
        self.events: list[tuple[str, str]] = []
        self.encodings: list[str] = []

    def reconfigure(self, **kwargs):
        encoding = kwargs.get("encoding", "")
        self.encodings.append(encoding)
        self.events.append(("reconfigure", encoding))

    def write(self, text):
        if text:
            self.events.append(("write", text))
        return super().write(text)


class LogNamesCannotCollide(WatchKernelCase):
    """Two runs of the same kernel must not share a filename. This was the bug."""

    REF = "aashishkumarrajput/training-stage-a-v2"

    def test_two_versions_of_one_kernel_get_different_files(self):
        v2, _ = self.wk.log_paths(self.REF, "v2", self.tmp)
        v3, _ = self.wk.log_paths(self.REF, "v3", self.tmp)
        self.assertNotEqual(v2, v3, "two runs of one kernel share a log filename")
        self.assertEqual(v2.name, "kaggle-training-stage-a-v2-v2.log")
        self.assertEqual(v3.name, "kaggle-training-stage-a-v2-v3.log")

    def test_a_missing_tag_is_timestamped_rather_than_guessed(self):
        # The kernel has no API-exposed version number to infer one from:
        # `current_version_number` reads back as 0 from `kernels_list`, and
        # `ApiKernelSessionStatusResponse` has only `status`. So an untagged
        # watch must not pretend to know which run it is.
        path, _ = self.wk.log_paths(self.REF, None, self.tmp)
        self.assertRegex(path.name, r"-\d{8}-\d{6}\.log$")

    def test_a_tag_cannot_escape_the_output_directory(self):
        for hostile in ("../escaped", "..\\escaped", "..", "."):
            path, _ = self.wk.log_paths(self.REF, hostile, self.tmp)
            self.assertEqual(path.parent, self.tmp,
                             f"the tag {hostile!r} escaped the output directory")

    def test_free_path_leaves_an_existing_log_alone(self):
        # The destructive case, reproduced: v2's log is on disk, v3 finishes.
        original, _ = self.wk.log_paths(self.REF, "v2", self.tmp)
        original.write_text("V2 RAW LOG " * 1000, encoding="utf-8")
        before = original.stat().st_size

        chosen = self.wk._free_path(original)
        chosen.write_text("v3", encoding="utf-8")

        self.assertEqual(original.stat().st_size, before, "v2's log was overwritten")
        self.assertEqual(original.read_text(encoding="utf-8")[:10], "V2 RAW LOG")
        self.assertEqual(chosen.name, "kaggle-training-stage-a-v2-v2.2.log")

    def test_free_path_keeps_going_rather_than_stopping_at_one(self):
        first = self.tmp / "x.log"
        first.write_text("one", encoding="utf-8")
        second = self.wk._free_path(first)
        second.write_text("two", encoding="utf-8")
        third = self.wk._free_path(first)
        self.assertEqual([first.name, second.name, third.name],
                         ["x.log", "x.2.log", "x.3.log"])
        self.assertEqual([p.read_text(encoding="utf-8") for p in (first, second)],
                         ["one", "two"])


class TheWatchSaysWhatItIsDoingFirst(WatchKernelCase):
    """A watch can be killed without reaching any of its own messages."""

    def test_the_header_names_the_run_the_window_and_the_destination(self):
        self.install_fake_api(status="RUNNING")
        code, out = self.run_main("--tag", "v3", *self.one_poll_window())
        self.assertEqual(code, 1, "an exhausted window is not success")
        self.assertIn("training-stage-a-v2-v3.log", out,
                      "the header does not name the file it will write")
        self.assertIn("tag       v3", out)
        self.assertIn("1s | window 0.01 min", out)
        self.assertRegex(out, r"pid\s+\d+")
        self.assertIn("will write", out)

    def test_an_exhausted_window_says_the_run_is_not_terminal(self):
        # The dangerous misreading is "the watch stopped, so the run did".
        self.install_fake_api(status="RUNNING")
        code, out = self.run_main("--tag", "v3", *self.one_poll_window(),
                                  no_sleep=False)
        self.assertEqual(code, 1)
        self.assertIn("1 polls", out)
        self.assertIn("still RUNNING", out)
        self.assertIn("NOT terminal", out)
        self.assertIn("the run is unaffected", out)

    def test_a_window_with_no_polls_still_reports_rather_than_crashing(self):
        # `--max-minutes 0` never assigns `state`; it used to raise NameError
        # while trying to report that it had done nothing. It must not claim a
        # status it never learned, either.
        self.install_fake_api(status="RUNNING")
        code, out = self.run_main("--tag", "v3", "--max-minutes", "0")
        self.assertEqual(code, 1)
        self.assertIn("0 polls", out)
        self.assertIn("<no poll yet>", out)
        self.assertNotIn("still RUNNING", out)

    def test_the_output_encoding_is_fixed_before_anything_is_written(self):
        # Redirected stdout here defaults to cp1252, and the first version of
        # the header proved it: its `·` was written as byte 0xB7 and read back
        # as U+FFFD. The fix is `use_utf8_stdout()` at the top of `main` — and
        # the *timing* is the whole fix, since it was already being called, but
        # only from `decode`, which runs after every header line is on disk.
        #
        # So this asserts ordering against a stream that records it. An
        # earlier version of this test used a plain StringIO, which has no
        # `reconfigure` at all — so `use_utf8_stdout` no-opped and the test
        # passed no matter where the call sat. It could not fail for the reason
        # it claimed.
        self.install_fake_api(status="RUNNING")
        stream = RecordingStream()
        _, out = self.run_main("--tag", "v3", "--max-minutes", "0", stream=stream)

        self.assertEqual(stream.encodings, ["utf-8"],
                         "stdout was never switched to utf-8")
        first_write = next(i for i, e in enumerate(stream.events)
                           if e[0] == "write" and e[1].strip())
        reconfigure_at = stream.events.index(("reconfigure", "utf-8"))
        self.assertLess(reconfigure_at, first_write,
                        "the header was written before the encoding was fixed")
        self.assertNotIn("\ufffd", out)
        self.assertIn("watch ", out)


class ATerminalRunSavesItsLog(WatchKernelCase):
    """The whole point: a terminal run's log lands on disk, tagged, once."""

    PAYLOAD = json.dumps([
        {"stream_name": "stdout", "time": 3.0, "data": "corpus cache found at /x\n"},
        {"stream_name": "stderr", "time": 4.5, "data": "peak 6.85 GiB\n"},
    ])

    def test_raw_is_written_to_the_tagged_name_and_decoded_beside_it(self):
        self.install_fake_api(status="COMPLETE", logs=self.PAYLOAD)
        code, out = self.run_main("--tag", "v3", "--max-minutes", "5")
        self.assertEqual(code, 0)

        raw = self.tmp / "kaggle-training-stage-a-v2-v3.log"
        text = self.tmp / "kaggle-training-stage-a-v2-v3.txt"
        self.assertTrue(raw.is_file(), "the raw log was not saved")
        self.assertTrue(text.is_file(), "the transcript was not saved")
        # Byte-for-byte: the transcript is reproducible, the raw log is not.
        self.assertEqual(raw.read_text(encoding="utf-8"), self.PAYLOAD)
        self.assertIn("corpus cache found at /x", text.read_text(encoding="utf-8"))
        self.assertIn("terminal state: COMPLETE", out)

    def test_the_raw_log_is_written_before_the_transcript_is_attempted(self):
        # If decoding dies, the raw log must already be safe on disk.
        self.install_fake_api(status="COMPLETE", logs="this is not JSON")
        code, out = self.run_main("--tag", "v3", "--max-minutes", "5")
        raw = self.tmp / "kaggle-training-stage-a-v2-v3.log"
        self.assertTrue(raw.is_file(), "a decode failure cost the raw log")
        self.assertEqual(raw.read_text(encoding="utf-8"), "this is not JSON")
        self.assertIn("decode failed", out)
        self.assertEqual(code, 1, "a run whose transcript failed is not a success")

    def test_a_second_watch_of_the_same_run_lands_beside_the_first(self):
        first = self.tmp / "kaggle-training-stage-a-v2-v3.log"
        self.install_fake_api(status="COMPLETE", logs=self.PAYLOAD)
        self.run_main("--tag", "v3", "--max-minutes", "5")

        # The two watches must carry *different* payloads, or "was the first one
        # overwritten?" is unanswerable: identical bytes compare equal whether
        # or not the second write landed on top of the first. The first version
        # of this test used one payload for both runs, so its byte comparison
        # could never have failed and only the side-file assertion had teeth.
        second_payload = json.dumps(
            [{"stream_name": "stdout", "time": 9.0, "data": "second watch\n"}])
        self.install_fake_api(status="COMPLETE", logs=second_payload)
        self.run_main("--tag", "v3", "--max-minutes", "5")

        self.assertEqual(first.read_text(encoding="utf-8"), self.PAYLOAD,
                         "a re-watch overwrote the log")
        beside = self.tmp / "kaggle-training-stage-a-v2-v3.2.log"
        self.assertTrue(beside.is_file(), "the second watch was not saved at all")
        self.assertEqual(beside.read_text(encoding="utf-8"), second_payload)


class AFailedFetchIsNotAnEmptyLog(WatchKernelCase):
    """These look identical on disk and are different claims about the world."""

    def test_an_unreachable_log_is_reported_as_ours_not_kaggle_s(self):
        self.install_fake_api(status="COMPLETE", exc=ConnectionError("boom"))
        code, out = self.run_main("--tag", "v3", "--max-minutes", "5")
        self.assertEqual(code, 1)
        self.assertIn("could not fetch the log at all", out)
        self.assertIn("ConnectionError", out)
        self.assertNotIn("EMPTY log", out, "a network failure was blamed on Kaggle")
        # Nothing at all: not the named file, and not a differently-named one
        # either, because a failed fetch that quietly leaves a file behind is
        # just the original bug with a longer path.
        self.assertEqual(list(self.tmp.iterdir()), [],
                         "a failed fetch consumed the log's filename")

    def test_a_genuinely_empty_log_is_named_as_empty_and_not_written(self):
        self.install_fake_api(status="COMPLETE", logs="   \n")
        code, out = self.run_main("--tag", "v3", "--max-minutes", "5")
        self.assertEqual(code, 1)
        # The disk check comes first on purpose: it is the one that says what
        # the rule *is*. Asserting the message first would let a mutation that
        # keeps the right wording while writing the file still pass.
        # A 0-byte file would be indistinguishable from a lost one, so the
        # name is deliberately left free.
        self.assertFalse((self.tmp / "kaggle-training-stage-a-v2-v3.log").exists(),
                         "an empty log was written to disk")
        self.assertIn("EMPTY log", out)


if __name__ == "__main__":
    unittest.main()
