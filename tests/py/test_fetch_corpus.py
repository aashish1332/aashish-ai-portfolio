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
import re
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
         "enabled": True, "provenance": {"origin": "web"},
         "files": [{"url": "https://example.com/a.txt", "sha256": None}],
         "license": {"spdx": "UNKNOWN", "verified": False}},
        {"id": "verified_disabled", "name": "Checked, off", "kind": "local",
         "enabled": False, "provenance": {"origin": "web"},
         "files": [{"path": "/nowhere.txt"}],
         "license": {"spdx": "CC-BY-SA-4.0", "url": "https://x", "verified": True,
                     "verified_by": "Tester", "verified_at": "2026-09-20"}},
        {"id": "ready", "name": "Ready", "kind": "local", "enabled": True,
         "files": [], "provenance": {"origin": "own-work"},
         "license": {"spdx": "own-work", "url": "https://x", "verified": True,
                     "verified_by": "Tester", "verified_at": "2026-09-20"}},
        {"id": "bad_spdx", "name": "Flag with no answer", "kind": "local",
         "enabled": True, "files": [], "provenance": {"origin": "web"},
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

    def test_the_registry_does_not_loosen_the_safety_defaults(self):
        """NC/ND are refused by default; a data file must not quietly change that.

        `allow_noncommercial: true` is a statement about what this project is,
        so it belongs in a diff someone reviews — not in a convenient edit made
        at 2am to unblock a download.
        """
        policy = fc.load_registry()["policy"]
        for key, default in fc.DEFAULT_POLICY.items():
            self.assertEqual(policy.get(key, default), default,
                             f"sources.json must not override the {key} default")

    def test_observed_licences_are_research_and_stay_separate_from_verification(self):
        """Research and an attestation are different states and must not merge."""
        seen = 0
        for source in fc.sources(fc.load_registry()):
            observed = source.license.get("observed")
            if not observed:
                continue
            seen += 1
            self.assertIn("evidence", observed, f"{source.id}: observed with no source page")
            self.assertIn("observed_at", observed, f"{source.id}: observed with no date")
            spdx = observed.get("spdx")
            self.assertIsNotNone(spdx, f"{source.id}: observed block with no spdx key")
            if str(spdx).strip().upper() in fc.NON_ANSWERS:
                # "I looked and could not determine it" is a legitimate finding —
                # it saves the next person the same hour. What it must never be
                # is dressed up as a licence, so require it to be labelled.
                self.assertEqual(str(observed.get("confidence", "")).lower(), "low",
                                 f"{source.id}: an unnamed observed licence is only honest "
                                 f"at low confidence")
                self.assertTrue(str(observed.get("notes", "")).strip(),
                                f"{source.id}: inconclusive research must say why")
            if source.verified:
                self.assertEqual(str(observed["spdx"]).upper(),
                                 str(source.license.get("spdx", "")).upper(),
                                 f"{source.id}: verified as one licence, observed as another")
        self.assertGreaterEqual(seen, 3, "the P4 licence research should be recorded here")

    def test_check_shows_the_licence_research_and_where_it_came_from(self):
        """The finding has to reach the person about to read terms for a source
        that has already been ruled out."""
        import io

        buffer = io.StringIO()
        fc.print_check(fc.load_registry(), stream=buffer)
        text = buffer.getvalue()
        self.assertIn("observed: CC-BY-NC-SA-4.0", text)
        self.assertIn("github.com/l3cube-pune/code-mixed-nlp", text)
        self.assertIn("[research, not a verification]", text)

    def test_the_english_slot_was_split_into_named_corpora(self):
        """A slot is not a source. 'Curated simple English' could not be licence
        checked because there was nothing to check — researching the terms of an
        unnamed corpus is not research."""
        ids = {s.id for s in fc.sources(fc.load_registry())}
        self.assertNotIn("simple_english_dialogue", ids)
        for named in ("tinystories", "simple_english_wikipedia", "topical_chat",
                      "dailydialog", "personachat"):
            self.assertIn(named, ids, f"{named} should be registered by name")

    def test_every_source_declares_where_its_text_came_from(self):
        """Rule 1 needs an answer to 'was this written by a person?', and the
        licence file cannot supply it."""
        for source in fc.sources(fc.load_registry()):
            self.assertIn(source.origin, fc.KNOWN_ORIGINS,
                          f"{source.id} does not declare provenance.origin")

    def test_the_one_synthetic_source_records_where_it_is_disclosed(self):
        source = fc.find_source(fc.load_registry(), "tinystories")
        self.assertEqual(source.origin, "synthetic")
        self.assertIn("GPT", source.provenance.get("generated_by", ""))
        self.assertFalse(source.needs_disclosure,
                         "the disclosure must be recorded, not implied by a permissive licence")

    def test_the_noncommercial_finding_is_still_the_recorded_state(self):
        """A regression guard on the one licence check that changed the answer.

        If someone flips L3Cube to `verified` without the owner actually reading
        the terms, this fails: the class block is the whole reason it was looked
        up, and `CC-BY-NC-*` can never be fetched while the defaults hold.
        """
        source = fc.find_source(fc.load_registry(), "l3cube_hingcorpus")
        observed = source.license["observed"]["spdx"]
        self.assertEqual(fc.blocked_licence_classes(observed), ["noncommercial"],
                         "the recorded licence must still be recognised as NonCommercial")
        self.assertFalse(source.enabled)


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
        for spdx in ("UNKNOWN", "unknown", "NONE", "TODO", "", None,
                     "NOASSERTION", "noassertion"):
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


class LicenceClassTokens(unittest.TestCase):
    """§7.3 in practice: a licence can be real and still be one we may not use.

    Detection is token-wise on purpose, and both failure modes are pinned here:
    a substring test for 'NC' would refuse NCSA (a permissive OSI licence), and
    a test for '-NC-' would miss `CC-BY-NC-SA-4.0` exactly when it matters.
    """

    def test_noncommercial_variants_are_detected(self):
        for spdx in ("CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-SA-3.0",
                     "cc-by-nc-sa-4.0"):
            self.assertIn("noncommercial", fc.blocked_licence_classes(spdx), spdx)

    def test_no_derivatives_is_detected_and_reported_separately(self):
        self.assertEqual(fc.blocked_licence_classes("CC-BY-ND-4.0"), ["no_derivatives"])
        self.assertEqual(fc.blocked_licence_classes("CC-BY-NC-ND-4.0"),
                         ["noncommercial", "no_derivatives"])

    def test_a_permissive_licence_containing_the_letters_nc_is_allowed(self):
        self.assertEqual(fc.spdx_tokens("NCSA"), {"NCSA"})
        for spdx in ("NCSA", "CC-BY-4.0", "CC-BY-SA-4.0", "Apache-2.0", "MIT",
                     "BSD-3-Clause", "own-work"):
            self.assertEqual(fc.blocked_licence_classes(spdx), [], spdx)

    def test_a_version_is_not_mistaken_for_a_class(self):
        self.assertEqual(fc.spdx_tokens("CC-BY-4.0"), {"CC", "BY", "4.0"})
        self.assertEqual(fc.spdx_tokens("GPL-3.0-only"), {"GPL", "3.0", "ONLY"})

    def test_the_exception_is_a_named_field_rather_than_a_deleted_entry(self):
        policy = {"allow_noncommercial": True}
        self.assertEqual(fc.blocked_licence_classes("CC-BY-NC-SA-4.0", policy), [])
        # ...and permitting one class must not silently permit the other.
        self.assertEqual(fc.blocked_licence_classes("CC-BY-NC-ND-4.0", policy),
                         ["no_derivatives"])

    def test_a_bare_source_fails_closed(self):
        """A Source built without the registry still refuses NC — the default
        must not depend on the file being loaded correctly."""
        source = fc.Source("bare", {
            "id": "bare", "name": "x", "kind": "local", "enabled": True, "files": [],
            "license": {"spdx": "CC-BY-NC-4.0", "verified": True, "verified_by": "T",
                        "verified_at": "2026-09-20"},
        })
        self.assertEqual(source.block_kind(), "licence_class")


class LicenceClassGate(unittest.TestCase):
    """The block must hold on every path: status, fetch, and the CLI."""

    REGISTRY = {
        "policy": {"rule": "test policy", "required_filters": ["pii"]},
        "sources": [
            {"id": "nc", "name": "NonCommercial corpus", "kind": "http_file",
             "enabled": True, "why": "test", "provenance": {"origin": "human"},
             "files": [{"url": "https://example.com/nc.txt", "sha256": None}],
             "license": {"spdx": "CC-BY-NC-SA-4.0", "url": "https://example.com/terms",
                         "verified": True, "verified_by": "Tester",
                         "verified_at": "2026-09-20"}},
        ],
    }

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = registry_file(Path(self.tmp.name), self.REGISTRY)
        self.registry = fc.load_registry(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_verified_noncommercial_source_still_cannot_be_fetched(self):
        source = fc.find_source(self.registry, "nc")
        self.assertIn("noncommercial", source.status())
        self.assertEqual(source.block_kind(), "licence_class")
        with self.assertRaises(fc.LicenceError):
            fc.fetch(source, Path(self.tmp.name) / "out", log=lambda *a: None)
        self.assertFalse((Path(self.tmp.name) / "out").exists())

    def test_cli_refuses_an_nc_source_with_exit_code_2(self):
        code = fc.main(["--sources", str(self.path), "--source", "nc",
                        "--out", str(Path(self.tmp.name) / "out")])
        self.assertEqual(code, 2)

    def test_check_mode_says_reading_the_terms_cannot_fix_this(self):
        import io

        buffer = io.StringIO()
        fc.print_check(self.registry, stream=buffer)
        text = buffer.getvalue()
        self.assertIn("noncommercial", text)
        self.assertIn("nothing here", text,
                      "a licence class cannot be fixed by reading the terms again")
        self.assertIn("allow_noncommercial", text,
                      "the only way out must be named, so it is a decision and not a guess")
        self.assertNotIn("--spdx <SPDX-ID>", text,
                         "a source blocked by class must not be told to re-verify")

    def test_verifying_an_nc_licence_records_it_without_granting_permission(self):
        entry = fc.verify_source("nc", "CC-BY-NC-4.0", "https://example.com/terms",
                                 "Tester", path=self.path)
        self.assertEqual(entry["license"]["spdx"], "CC-BY-NC-4.0")
        self.assertTrue(entry["license"]["verified"], "the fact must still be recorded")
        self.assertFalse(entry["enabled"],
                         "recording a fact is not the same as granting permission")
        reloaded = fc.find_source(fc.load_registry(self.path), "nc")
        self.assertIn("noncommercial", reloaded.status())


class ProvenanceGate(unittest.TestCase):
    """docs/DATA_LICENSES.md rule 1: a generated corpus must say so.

    The licence can be perfectly permissive and the source still unusable —
    'is this licensed?' and 'was this written by a person?' are different
    questions, and only the first has a page to check.
    """

    def registry(self, disclosure="__absent__"):
        provenance = {"origin": "synthetic", "generated_by": "GPT-4"}
        if disclosure != "__absent__":
            provenance["disclosure"] = disclosure
        return {
            "policy": {"rule": "test policy", "required_filters": ["pii"]},
            "sources": [
                {"id": "synth", "name": "Generated corpus", "kind": "http_file",
                 "enabled": True, "why": "test", "provenance": provenance,
                 "files": [{"url": "https://example.com/s.txt", "sha256": None}],
                 "license": {"spdx": "MIT", "url": "https://example.com/legal",
                             "verified": True, "verified_by": "Tester",
                             "verified_at": "2026-09-20"}},
            ],
        }

    def test_a_synthetic_source_without_a_disclosure_is_refused(self):
        source = fc.find_source(self.registry(), "synth")
        self.assertEqual(source.block_kind(), "provenance")
        self.assertIn("synthetic provenance", source.status())
        with self.assertRaises(fc.LicenceError):
            fc.fetch(source, "ignored", log=lambda *a: None)

    def test_the_same_source_with_a_disclosure_is_usable(self):
        source = fc.find_source(self.registry("Named in the model card."), "synth")
        self.assertEqual(source.status(), "ready")
        self.assertIsNone(source.block_kind())

    def test_a_blank_disclosure_does_not_count(self):
        for blank in ("", "   ", "\n", None):
            source = fc.find_source(self.registry(blank), "synth")
            self.assertEqual(source.block_kind(), "provenance", repr(blank))

    def test_human_web_and_own_work_sources_are_not_asked_to_disclose(self):
        for origin in ("human", "web", "own-work"):
            source = fc.Source("x", {
                "id": "x", "kind": "local", "enabled": True,
                "provenance": {"origin": origin},
                "license": {"spdx": "MIT", "verified": True, "verified_by": "T",
                            "verified_at": "2026-09-20"}})
            self.assertFalse(source.needs_disclosure, origin)

    def test_check_mode_says_the_licence_is_not_the_problem(self):
        import io

        buffer = io.StringIO()
        fc.print_check(self.registry(), stream=buffer)
        text = buffer.getvalue()
        self.assertIn("generated by GPT-4", text)
        self.assertIn("does not settle it", text)

    def test_verifying_a_source_that_never_says_where_it_came_from_is_refused(self):
        registry = {
            "policy": {"rule": "t", "required_filters": []},
            "sources": [{"id": "nop", "name": "x", "kind": "local", "enabled": False,
                         "files": [], "license": {"spdx": "UNKNOWN", "verified": False}}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = registry_file(Path(tmp), registry)
            with self.assertRaises(fc.LicenceError) as ctx:
                fc.verify_source("nop", "MIT", "https://x", "Tester", path=path)
            self.assertIn("provenance.origin", str(ctx.exception))


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

    def test_a_source_with_no_acquisition_channel_says_so_instead_of_guessing(self):
        source = fc.Source("chan", {
            "id": "chan", "name": "x", "kind": "unspecified", "enabled": True,
            "provenance": {"origin": "human"},
            "license": {"spdx": "MIT", "verified": True, "verified_by": "A",
                        "verified_at": "2026-09-20"},
        })
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError) as ctx:
                fc.fetch(source, Path(tmp) / "out", log=lambda *a: None)
            self.assertIn("no acquisition channel chosen", str(ctx.exception))

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


class TheDocsAgreeWithTheRegistry(unittest.TestCase):
    """The headline count written in the docs is checked; the rest is prose.

    `docs/DATA_LICENSES.md` says the table and the machine record "cannot drift
    apart silently". For the number that changes with every verification, that is
    now true: this reads every `<N> of <M> sources blocked` written anywhere in
    the docs and fails when it stops matching `data/sources.json`. It exists
    because the sentence was already false once — `docs/TRAINING.md` carried
    "5 of 5 sources are blocked" while the registry held nine, and every test in
    this file passed, because they all look at the registry and none looked at
    the prose.

    The whole text is searched rather than line by line: a headline that reflows
    across a line break would otherwise stop matching, which is the same silent
    failure this is here to prevent.

    `docs/PROGRESS.md` is **excluded on purpose**. It is a dated log, so a count
    it records was true on the day it was written and stays true as history; this
    check first fired on that file — on a new entry that quoted the old "5 of 5"
    as evidence — and forcing a log to rewrite its own past to keep a guard green
    is the wrong repair. The living documents are the ones that must not be able
    to claim a count the registry disagrees with.
    """

    HEADLINE = re.compile(r"(\d+) of (\d+) sources (?:are )?blocked")

    #: A dated log, where a past headline is a record rather than a claim.
    EXEMPT = {"PROGRESS.md"}

    def registry_counts(self) -> tuple[int, int]:
        registry = fc.load_registry()
        entries = fc.sources(registry)
        blocked = sum(1 for source in entries if source.status() != "ready")
        return blocked, len(entries)

    def docs(self) -> list[Path]:
        return [ROOT / "README.md",
                *(p for p in sorted((ROOT / "docs").glob("*.md"))
                  if p.name not in self.EXEMPT)]

    def test_every_headline_matches_the_registry(self):
        blocked, total = self.registry_counts()
        for path in self.docs():
            text = path.read_text(encoding="utf-8")
            for match in self.HEADLINE.finditer(text):
                said, of = (int(group) for group in match.groups())
                line = text[:match.start()].count("\n") + 1
                self.assertEqual(
                    (said, of), (blocked, total),
                    f"{path.relative_to(ROOT)}:{line} says \"{match.group(0)}\" but the "
                    f"registry has {blocked} of {total} blocked")

    def test_the_headline_is_still_written_somewhere(self):
        """A validator that silently stops finding anything proves nothing."""
        found = sum(len(self.HEADLINE.findall(p.read_text(encoding="utf-8")))
                    for p in self.docs())
        self.assertGreaterEqual(
            found, 2,
            "the licence headline has vanished from the docs — write it in words or "
            "delete this test on purpose, but do not let it go quiet")


if __name__ == "__main__":
    unittest.main()
