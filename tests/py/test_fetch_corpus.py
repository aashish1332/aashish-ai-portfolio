"""tests/py/test_fetch_corpus.py — the §7.3 licence gate and the downloader.

The gate is the part that must not be wrong: a source whose terms were never
read must not be fetchable by any path through this module or its CLI. The
second half covers the resumability and hashing, because a resumed 2 GB dump
that silently restarted from zero, or a corrupt shard that landed under its
final name, would both look like success.

No network is used: the opener is injected, which is also why this is testable
at all.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from training.scripts import fetch_corpus as fc  # noqa: E402

REGISTRY = {
    "policy": {"rule": "test policy", "required_filters": ["pii", "toxicity"]},
    "sources": [
        {"id": "unverified", "name": "Never checked", "kind": "http_file",
         "enabled": True, "files": [{"url": "https://example.com/a.txt", "sha256": None}],
         "license": {"spdx": "UNKNOWN", "verified": False}},
        {"id": "verified_disabled", "name": "Checked, off", "kind": "local",
         "enabled": False, "files": [{"path": "/nowhere.txt"}],
         "license": {"spdx": "CC-BY-SA-4.0", "url": "https://x", "verified": True,
                     "verified_by": "Tester", "verified_at": "2026-09-20"}},
        {"id": "ready", "name": "Ready", "kind": "local", "enabled": True,
         "files": [],
         "license": {"spdx": "own-work", "url": "https://x", "verified": True,
                     "verified_by": "Tester", "verified_at": "2026-09-20"}},
        {"id": "bad_spdx", "name": "Flag with no answer", "kind": "local",
         "enabled": True, "files": [],
         "license": {"spdx": "UNKNOWN", "url": "https://x", "verified": True,
                     "verified_by": "Tester", "verified_at": "2026-09-20"}},
    ],
}


def registry_file(tmp: Path, registry: dict = REGISTRY) -> Path:
    path = tmp / "sources.json"
    path.write_text(json.dumps(registry), encoding="utf-8")
    return path


class Registry(unittest.TestCase):
    def test_the_real_registry_is_well_formed_and_honest(self):
        registry = fc.load_registry()
        self.assertIn("policy", registry)
        self.assertGreaterEqual(len(fc.sources(registry)), 4)
        ids = [s.id for s in fc.sources(registry)]
        self.assertEqual(len(ids), len(set(ids)), "duplicate source ids")
        for source in fc.sources(registry):
            for key in ("name", "kind", "why", "license"):
                self.assertIn(key, source.raw, f"{source.id} is missing {key}")
            self.assertIn("verified", source.license)
            if source.license["verified"]:
                self.assertNotIn(str(source.license.get("spdx", "")).upper(), fc.NON_ANSWERS,
                                 f"{source.id} claims a verification with no licence named")
                self.assertTrue(source.license.get("verified_by"))
                self.assertTrue(source.license.get("verified_at"))

    def test_not_one_third_party_source_is_enabled_today(self):
        """P4 has not run: the gate must still be closed for outside data."""
        for source in fc.sources(fc.load_registry()):
            if source.raw.get("kind") in ("hf_dataset", "http_file", "unspecified"):
                self.assertFalse(source.enabled,
                                 f"{source.id} is enabled without a verified licence")


class Gate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.registry = fc.load_registry(registry_file(Path(self.tmp.name)))

    def tearDown(self):
        self.tmp.cleanup()

    def test_unverified_source_cannot_be_fetched(self):
        source = fc.find_source(self.registry, "unverified")
        self.assertIn("licence not verified", source.status())
        with self.assertRaises(fc.LicenceError) as ctx:
            fc.fetch(source, Path(self.tmp.name) / "out")
        message = str(ctx.exception)
        self.assertIn("--verify unverified", message,
                      "the refusal must include the exact command that fixes it")

    def test_verified_but_disabled_is_also_refused(self):
        source = fc.find_source(self.registry, "verified_disabled")
        self.assertIn("not enabled", source.status())
        with self.assertRaises(fc.LicenceError):
            fc.fetch(source, Path(self.tmp.name) / "out")

    def test_a_verification_flag_with_no_licence_named_is_refused(self):
        source = fc.find_source(self.registry, "bad_spdx")
        self.assertIn("not an answer", source.status())
        with self.assertRaises(fc.LicenceError):
            fc.fetch(source, Path(self.tmp.name) / "out")

    def test_cli_refuses_with_exit_code_2_and_writes_nothing(self):
        path = registry_file(Path(self.tmp.name))
        out = Path(self.tmp.name) / "out"
        code = fc.main(["--sources", str(path), "--source", "unverified", "--out", str(out)])
        self.assertEqual(code, 2)
        self.assertFalse(out.exists(), "a refused fetch must not create the output directory")

    def test_check_mode_reports_every_block_reason(self):
        import io

        buffer = io.StringIO()
        fc.print_check(self.registry, stream=buffer)
        text = buffer.getvalue()
        self.assertIn("BLOCKED: licence not verified", text)
        self.assertIn("not enabled", text)
        self.assertIn("which is not an answer", text)
        self.assertIn("to unblock:", text)
        # one of the four is genuinely ready, so three, not four
        self.assertIn("4 sources, 3 blocked", text)  # noqa: E501

    def test_check_mode_advises_the_right_fix_for_each_block(self):
        """Telling someone to flip `enabled` when their licence is unread
        sends them the wrong way; each block kind gets its own instruction."""
        import io

        buffer = io.StringIO()
        fc.print_check(self.registry, stream=buffer)
        text = buffer.getvalue()
        self.assertIn("--verify unverified", text, "an unread licence must be pointed at --verify")
        self.assertIn("re-run the verification with the licence", text,
                      "a flag with no licence named must not be fixed by flipping enabled")
        self.assertIn("set enabled to true", text)

    def test_unknown_source_is_a_clear_error(self):
        with self.assertRaises(KeyError) as ctx:
            fc.find_source(self.registry, "nope")
        self.assertIn("unverified", str(ctx.exception))


class Verification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = registry_file(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_verification_records_who_read_what_and_when(self):
        entry = fc.verify_source("unverified", "CC-BY-SA-4.0", "https://example.com/legal",
                                 "Aashish Kumar", notes="read the dataset card", path=self.path)
        self.assertTrue(entry["license"]["verified"])
        self.assertTrue(entry["enabled"], "verifying a source should enable it")
        self.assertEqual(entry["license"]["spdx"], "CC-BY-SA-4.0")
        self.assertEqual(entry["license"]["verified_by"], "Aashish Kumar")
        self.assertTrue(entry["license"]["verified_at"])

        reloaded = fc.find_source(fc.load_registry(self.path), "unverified")
        self.assertEqual(reloaded.status(), "ready")

    def test_verifying_with_a_non_licence_is_refused(self):
        for spdx in ("UNKNOWN", "unknown", "NONE", "TODO", "", None):
            with self.assertRaises(fc.LicenceError):
                fc.verify_source("unverified", spdx, "https://x", "Tester", path=self.path)

    def test_verifying_without_a_source_url_or_reviewer_is_refused(self):
        with self.assertRaises(fc.LicenceError):
            fc.verify_source("unverified", "MIT", "", "Tester", path=self.path)
        with self.assertRaises(fc.LicenceError):
            fc.verify_source("unverified", "MIT", "https://x", "  ", path=self.path)

    def test_unknown_source_id_is_refused(self):
        with self.assertRaises(KeyError):
            fc.verify_source("nope", "MIT", "https://x", "Tester", path=self.path)


class FakeResponse:
    """A minimal urlopen stand-in: enough to exercise resumption and hashing."""

    def __init__(self, body: bytes, status: int = 200):
        self.body = body
        self.status = status
        self._offset = 0
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            chunk, self._offset = self.body[self._offset:], len(self.body)
            return chunk
        chunk = self.body[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False


class Download(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.body = b"hello corpus " * 500
        self.digest = hashlib.sha256(self.body).hexdigest()

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_download_is_hashed_and_renamed(self):
        calls = []

        def opener(request):
            calls.append(request)
            return FakeResponse(self.body)

        result = fc.download("https://example.com/a.txt", self.dir / "a.txt",
                             opener=opener, expected_sha256=self.digest, log=lambda *a: None)
        self.assertEqual(result["bytes"], len(self.body))
        self.assertEqual(result["sha256"], self.digest)
        self.assertTrue((self.dir / "a.txt").is_file())
        self.assertFalse((self.dir / "a.txt.part").exists())
        self.assertNotIn("Range", calls[0].headers)

    def test_a_sha256_mismatch_deletes_the_file(self):
        with self.assertRaises(ValueError) as ctx:
            fc.download("https://example.com/a.txt", self.dir / "a.txt",
                        opener=lambda r: FakeResponse(self.body),
                        expected_sha256="0" * 64, log=lambda *a: None)
        self.assertIn("sha256 mismatch", str(ctx.exception))
        self.assertFalse((self.dir / "a.txt").exists())
        self.assertFalse((self.dir / "a.txt.part").exists(),
                         "a corrupt partial must not be left to resume from")

    def test_resume_sends_a_range_request_and_appends(self):
        part = self.dir / "b.txt.part"
        half = len(self.body) // 2
        part.write_bytes(self.body[:half])
        seen = {}

        def opener(request):
            seen["range"] = request.headers.get("Range")
            return FakeResponse(self.body[half:], status=206)

        result = fc.download("https://example.com/b.txt", self.dir / "b.txt",
                             opener=opener, expected_sha256=self.digest, log=lambda *a: None)
        self.assertEqual(seen["range"], f"bytes={half}-")
        self.assertEqual(result["resumed_from"], half)
        self.assertEqual((self.dir / "b.txt").read_bytes(), self.body)

    def test_a_server_that_ignores_range_restarts_cleanly(self):
        part = self.dir / "c.txt.part"
        part.write_bytes(b"stale half")
        result = fc.download("https://example.com/c.txt", self.dir / "c.txt",
                             opener=lambda r: FakeResponse(self.body, status=200),
                             expected_sha256=self.digest, log=lambda *a: None)
        self.assertEqual(result["resumed_from"], 0)
        self.assertEqual((self.dir / "c.txt").read_bytes(), self.body)


class FetchLocal(unittest.TestCase):
    def test_local_source_is_copied_and_hashed_with_a_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            payload = tmp / "mine.txt"
            payload.write_text("our own text\n", encoding="utf-8")
            source = fc.Source("mine", {
                "id": "mine", "name": "Owner text", "kind": "local", "enabled": True,
                "files": [{"path": str(payload)}],
                "license": {"spdx": "own-work", "verified": True, "verified_by": "Aashish",
                            "verified_at": "2026-09-20"},
                "why": "test",
            })
            out = tmp / "out"
            manifest = fc.fetch(source, out, log=lambda *a: None)
            self.assertEqual(manifest["total_bytes"], payload.stat().st_size,
                             "CRLF translation on Windows must not break the manifest")
            self.assertEqual(manifest["files"][0]["sha256"], fc.sha256_file(out / "mine.txt"))
            self.assertEqual(manifest["required_filters"], ["pii", "toxicity", "dedupe",
                                                            "langid", "length"])
            written = json.loads((out / "fetch_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(written["source"], "mine")
            self.assertEqual(written["license"]["spdx"], "own-work")

    def test_generated_source_says_it_does_not_exist_yet(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = fc.Source("gen", {
                "id": "gen", "name": "Generated", "kind": "generated", "enabled": True,
                "generator": "training/scripts/make_instruction_data.py",
                "license": {"spdx": "own-work", "verified": True, "verified_by": "A",
                            "verified_at": "2026-09-20"},
            })
            with self.assertRaises(fc.LicenceError) as ctx:
                fc.fetch(source, Path(tmp) / "out", log=lambda *a: None)
            self.assertIn("does not exist yet", str(ctx.exception))

    def test_missing_local_path_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = fc.Source("mine", {
                "id": "mine", "name": "x", "kind": "local", "enabled": True,
                "files": [{"path": str(Path(tmp) / "absent.txt")}],
                "license": {"spdx": "own-work", "verified": True, "verified_by": "A",
                            "verified_at": "2026-09-20"},
            })
            with self.assertRaises(FileNotFoundError):
                fc.fetch(source, Path(tmp) / "out", log=lambda *a: None)

    def test_hf_dataset_without_a_pinned_revision_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = fc.Source("hf", {
                "id": "hf", "name": "x", "kind": "hf_dataset", "enabled": True,
                "repo": "some/dataset", "revision": None,
                "license": {"spdx": "MIT", "verified": True, "verified_by": "A",
                            "verified_at": "2026-09-20"},
            })
            with self.assertRaises(fc.LicenceError) as ctx:
                fc.fetch(source, Path(tmp) / "out", log=lambda *a: None)
            self.assertIn("revision", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
