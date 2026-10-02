"""tests/py/test_corpus_cache.py — a cache that is stale must be refused.

The corpus pass costs **47 minutes** on Kaggle (measured 2026-10-02) and
`/kaggle/working` is wiped between sessions, so caching it is worth real money.
The risk is a cache that is *silently* stale: token ids are indices into the
embedding, so shards built with a 12,288-token tokenizer are still structurally
valid against a 16,384-token one — they just train a model that reads text one
way and was trained another, and no downstream check can see it.

`train_smoke`'s `assert_matches_tokenizer` cannot catch that on its own: it
compares the shards to the tokenizer *present*, so a cache carrying a mismatched
pair would be checking the pair against itself. These tests are about the
relationship, which is why each one breaks a different half of it.

The fixtures are synthetic on purpose. The project's own `data/processed/seed`
shards predate the `tokenizer_version` field, so `save` refuses them — which is
correct, and is also asserted below, because that is what the guard is for.
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from training.scripts import corpus_cache as cc  # noqa: E402

TOKENIZER_VERSION = "portfolio-bpe-1k-45395d2ebc83"


def build_corpus(root: Path, version: str = TOKENIZER_VERSION, vocab: int = 1024) -> Path:
    """A minimal but honest shards + tokenizer pair.

    `files` is a list of per-shard entries carrying a sha256 prefix, because
    that is what `write_shards` actually writes. The first version of this
    fixture used a plain count (`"files": 2`), which is a shape the real
    manifest never has -- so it exercised none of the content checking and made
    a guard look covered that was not.
    """
    shards = root / "shards"
    shards.mkdir(parents=True)
    payloads = {
        "train-00000.bin": b"\x00\x01" * 32,
        "train-00001.bin": b"\x02\x03" * 32,
        "val-00000.bin": b"\x04\x05" * 32,
    }
    manifest = {
        "dtype": "uint16",
        "vocab_size": vocab,
        "end_token_id": 4,
        "tokenizer_version": version,
        "shards": {
            "train": {"docs": 16893, "tokens": 749590, "files": [
                {"file": name, "docs": 2, "tokens": 64,
                 "sha256": hashlib.sha256(payload).hexdigest()[:16],
                 "langs": {"en": 2}}
                for name, payload in payloads.items() if name.startswith("train")
            ]},
            "val": {"docs": 844, "tokens": 37479, "files": [
                {"file": name, "docs": 2, "tokens": 64,
                 "sha256": hashlib.sha256(payload).hexdigest()[:16],
                 "langs": {"en": 2}}
                for name, payload in payloads.items() if name.startswith("val")
            ]},
        },
    }
    (shards / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for name, payload in payloads.items():
        (shards / name).write_bytes(payload)

    tokenizer = root / "tokenizer"
    tokenizer.mkdir()
    (tokenizer / "meta.json").write_text(json.dumps({
        "tokenizer_version": version, "vocab_size": vocab, "name": "portfolio-bpe",
    }), encoding="utf-8")
    (tokenizer / "tokenizer.json").write_text("{}", encoding="utf-8")
    return root


def same_size_payload(size: int, want_prefix: str) -> bytes:
    """A `size`-byte payload whose sha256 starts with `want_prefix`.

    Needed because an inverted comparison is invisible from one sample. A
    mutation that raises when the digest starts with `"0"` passes every test
    written against a single corrupt payload whose digest happens to start with
    `0` — which is exactly what the first version of this class did, and the
    mutation survived it. Two payloads, one matching the inverted predicate and
    one not, make the difference observable.
    """
    for i in range(200_000):
        payload = i.to_bytes(8, "little") * (size // 8)
        if hashlib.sha256(payload).hexdigest().startswith(want_prefix):
            return payload
    raise AssertionError(f"no {size}-byte payload hashes to a {want_prefix}… prefix")


class ContentIsChecked(unittest.TestCase):
    """A shard whose name and size are right but whose bytes are wrong.

    The inventory digest is `relpath:size`, so it catches a truncated, missing,
    renamed or resized file — and silently passes this case. Only re-hashing
    against the manifest's own per-shard digest finds it, and a silently
    corrupted shard still trains.

    One mutation here is *equivalent* and no test can kill it: removing the
    aggregate comparison in `content_check`, because `content_inventory` already
    raises per shard, naming the file, before the aggregate is ever computed.
    Keeping both is deliberate — the aggregate is what a future manifest shape
    with no per-shard entries would fall back on.
    """

    def test_every_same_size_rewrite_is_caught(self):
        """Two payloads: one whose digest starts with 0, one that does not."""
        for want in ("0", "f"):
            with self.subTest(digest_starts_with=want):
                with tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    source = build_corpus(root / "src")
                    cache = root / "cache"
                    with redirect_stdout(io.StringIO()):
                        cc.main(["save", "--shards", str(source / "shards"),
                                 "--tokenizer", str(source / "tokenizer"),
                                 "--out", str(cache)])
                    victim = cache / "shards" / "train-00000.bin"
                    size = victim.stat().st_size
                    victim.write_bytes(same_size_payload(size, want))
                    with redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit) as ctx:
                            cc.main(["verify", "--cache", str(cache)])
                    self.assertIn("content does not match", str(ctx.exception))
                    self.assertIn("train-00000.bin", str(ctx.exception))

    def test_a_count_shaped_manifest_is_reported_as_unchecked(self):
        """An older manifest lists a count, not digests. Say so, do not fake it."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = build_corpus(root / "src")
            cache = root / "cache"
            manifest_path = source / "shards" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for split in manifest["shards"].values():
                split["files"] = len(split["files"])
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with redirect_stdout(io.StringIO()):
                cc.main(["save", "--shards", str(source / "shards"),
                         "--tokenizer", str(source / "tokenizer"), "--out", str(cache)])
            record = json.loads((cache / cc.CACHE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(record["content_sha256"], "")

            buf = io.StringIO()
            with redirect_stdout(buf):
                cc.main(["verify", "--cache", str(cache)])
            self.assertIn("content not checked", buf.getvalue())

    def test_a_same_size_rewrite_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = build_corpus(root / "src")
            cache = root / "cache"
            with redirect_stdout(io.StringIO()):
                cc.main(["save", "--shards", str(source / "shards"),
                         "--tokenizer", str(source / "tokenizer"), "--out", str(cache)])

            # 64 bytes in, 64 bytes out: the inventory digest is unchanged.
            victim = cache / "shards" / "train-00000.bin"
            before = victim.stat().st_size
            victim.write_bytes(b"\xff\xfe" * 32)
            self.assertEqual(victim.stat().st_size, before)

            with redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    cc.main(["verify", "--cache", str(cache)])
            self.assertIn("content does not match", str(ctx.exception))

    def test_the_size_inventory_alone_would_have_passed(self):
        """The claim above is only worth making if the sizes really do match."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = build_corpus(root / "src")
            cache = root / "cache"
            with redirect_stdout(io.StringIO()):
                cc.main(["save", "--shards", str(source / "shards"),
                         "--tokenizer", str(source / "tokenizer"), "--out", str(cache)])
            files = [p for p in (cache / "shards").rglob("*") if p.is_file()]
            record = json.loads((cache / cc.CACHE_FILE).read_text(encoding="utf-8"))
            (cache / "shards" / "train-00000.bin").write_bytes(b"\xff\xfe" * 32)
            after = [p for p in (cache / "shards").rglob("*") if p.is_file()]
            self.assertEqual(cc.inventory(files, cache / "shards"),
                             record["inventory_sha256"])
            self.assertEqual(cc.inventory(after, cache / "shards"),
                             record["inventory_sha256"])

    def test_the_fixture_carries_real_per_shard_digests(self):
        """Otherwise the two tests above would be testing an empty branch."""
        with tempfile.TemporaryDirectory() as tmp:
            source = build_corpus(Path(tmp) / "src")
            manifest = json.loads(
                (source / "shards" / "manifest.json").read_text(encoding="utf-8"))
            listed = manifest["shards"]["train"]["files"]
            self.assertIsInstance(listed, list)
            self.assertEqual(len(listed), 2)
            for entry in listed:
                digest = hashlib.sha256(
                    (source / "shards" / entry["file"]).read_bytes()).hexdigest()
                self.assertTrue(digest.startswith(entry["sha256"]))


class ArchiveIsOneFile(unittest.TestCase):
    """The archive is not a convenience: it is the only practical pull.

    Measured 2026-10-02, Kaggle's kernel-output API downloads **one file per HTTP
    request** and pages the listing 20 at a time by default, so a working
    directory holding the repository plus **3,505 shard files** exceeded a
    300-second timeout enumerating (7 seconds with `--page-size 200`). There is
    also an open Kaggle report of notebook outputs being capped at 500 items.
    One archive is one request and does not depend on the item count.
    """

    def _saved(self, tmp: str) -> tuple[Path, Path]:
        source = build_corpus(Path(tmp) / "corpus")
        cache = Path(tmp) / "cache"
        with redirect_stdout(io.StringIO()):
            cc.main(["save", "--shards", str(source / "shards"),
                     "--tokenizer", str(source / "tokenizer"), "--out", str(cache)])
        return source, cache

    def test_archive_writes_one_gzipped_file_holding_the_whole_cache(self):
        import tarfile

        with tempfile.TemporaryDirectory() as tmp:
            _source, cache = self._saved(tmp)
            out = Path(tmp) / "corpus-cache.tgz"
            with redirect_stdout(io.StringIO()):
                code = cc.main(["archive", "--cache", str(cache),
                                "--archive", str(out)])
            self.assertEqual(code, 0)
            self.assertTrue(out.is_file())
            with tarfile.open(out) as tar:
                names = set(tar.getnames())
        for expected in ("CACHE.json", "shards/manifest.json",
                         "tokenizer/meta.json", "shards/train-00000.bin"):
            self.assertTrue(
                any(n.endswith(expected) for n in names),
                f"{expected} missing from the archive: {sorted(names)}")

    def test_archive_refuses_a_stale_cache_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            _source, cache = self._saved(tmp)
            meta = json.loads(
                (cache / "tokenizer" / "meta.json").read_text(encoding="utf-8"))
            meta["tokenizer_version"] = "portfolio-bpe-16k-45395d2ebc83"
            (cache / "tokenizer" / "meta.json").write_text(
                json.dumps(meta), encoding="utf-8")
            out = Path(tmp) / "corpus-cache.tgz"
            with self.assertRaises(SystemExit):
                with redirect_stdout(io.StringIO()):
                    cc.main(["archive", "--cache", str(cache), "--archive", str(out)])
            self.assertFalse(out.exists(),
                             "a stale cache must not leave the session as one "
                             "file that a later session installs without "
                             "complaint")

    def test_archive_needs_a_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            _source, cache = self._saved(tmp)
            with self.assertRaises(SystemExit) as ctx:
                with redirect_stdout(io.StringIO()):
                    cc.main(["archive", "--cache", str(cache)])
            self.assertIn("--archive", str(ctx.exception))

    def test_the_archive_round_trips_back_through_install(self):
        import tarfile

        with tempfile.TemporaryDirectory() as tmp:
            _source, cache = self._saved(tmp)
            archive = Path(tmp) / "corpus-cache.tgz"
            with redirect_stdout(io.StringIO()):
                cc.main(["archive", "--cache", str(cache), "--archive", str(archive)])

            unpacked = Path(tmp) / "unpacked"
            unpacked.mkdir()
            with tarfile.open(archive) as tar:
                tar.extractall(unpacked, filter="data")
            restored = next(p for p in unpacked.iterdir() if p.is_dir())

            shards_to = Path(tmp) / "work" / "shards"
            tokenizer_to = Path(tmp) / "work" / "tokenizer"
            with redirect_stdout(io.StringIO()) as out:
                code = cc.main(["install", "--cache", str(restored),
                                "--shards-to", str(shards_to),
                                "--tokenizer-to", str(tokenizer_to)])
            self.assertEqual(code, 0)
            self.assertTrue((shards_to / "manifest.json").is_file())
            self.assertTrue((tokenizer_to / "meta.json").is_file())
            self.assertIn("installed", out.getvalue())


class RoundTrip(unittest.TestCase):
    def test_save_then_verify_then_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = build_corpus(Path(tmp) / "corpus")
            cache = Path(tmp) / "cache"
            with redirect_stdout(__import__("io").StringIO()) as out:
                cc.main(["save", "--shards", str(source / "shards"),
                         "--tokenizer", str(source / "tokenizer"),
                         "--out", str(cache)])
            record = json.loads((cache / cc.CACHE_FILE).read_text(encoding="utf-8"))
            self.assertEqual(record["format"], cc.CACHE_FORMAT)
            self.assertEqual(record["tokenizer_version"], TOKENIZER_VERSION)
            self.assertEqual(record["train"], 749_590)
            self.assertEqual(record["val"], 37_479)
            self.assertEqual(record["shard_files"], 4)  # 3 shards + manifest.json
            self.assertIn("cache written", out.getvalue())

            with redirect_stdout(__import__("io").StringIO()) as out:
                code = cc.main(["verify", "--cache", str(cache)])
            self.assertEqual(code, 0)
            self.assertIn("cache OK", out.getvalue())
            self.assertIn("same generation", out.getvalue())

            into_shards = Path(tmp) / "work" / "shards"
            into_tokenizer = Path(tmp) / "work" / "tokenizer"
            with redirect_stdout(__import__("io").StringIO()) as out:
                code = cc.main(["install", "--cache", str(cache),
                                "--shards-to", str(into_shards),
                                "--tokenizer-to", str(into_tokenizer)])
            self.assertEqual(code, 0)
            self.assertTrue((into_shards / "manifest.json").is_file())
            self.assertTrue((into_tokenizer / "meta.json").is_file())
            self.assertIn("installed", out.getvalue())


class Staleness(unittest.TestCase):
    """Each test breaks one half of the shards↔tokenizer relationship."""

    def _saved(self, tmp: str) -> Path:
        source = build_corpus(Path(tmp) / "corpus")
        cache = Path(tmp) / "cache"
        with redirect_stdout(__import__("io").StringIO()):
            cc.main(["save", "--shards", str(source / "shards"),
                     "--tokenizer", str(source / "tokenizer"), "--out", str(cache)])
        return cache

    def _verify_fails_with(self, cache: Path, needle: str) -> str:
        with self.assertRaises(SystemExit) as ctx:
            with redirect_stdout(__import__("io").StringIO()):
                cc.main(["verify", "--cache", str(cache)])
        message = str(ctx.exception)
        self.assertIn(needle, message,
                      f"the refusal should explain {needle!r}, said: {message}")
        return message

    def test_a_swapped_manifest_is_caught_by_its_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            manifest = json.loads(
                (cache / "shards" / "manifest.json").read_text(encoding="utf-8"))
            manifest["shards"]["train"]["tokens"] = 999_999_999
            (cache / "shards" / "manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8")
            self._verify_fails_with(cache, "sha256 does not match")

    def test_a_tokenizer_from_another_generation_is_caught(self):
        """The defect this file exists for: shards and tokenizer that are each
        internally fine, and do not belong together."""
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            meta = json.loads(
                (cache / "tokenizer" / "meta.json").read_text(encoding="utf-8"))
            meta["tokenizer_version"] = "portfolio-bpe-16k-45395d2ebc83"
            (cache / "tokenizer" / "meta.json").write_text(
                json.dumps(meta), encoding="utf-8")
            message = self._verify_fails_with(cache, "were built with")
            self.assertIn("no downstream check can see it", message,
                          "the refusal should say why this one is dangerous")

    def test_a_vocab_mismatch_in_the_tokenizer_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            meta = json.loads(
                (cache / "tokenizer" / "meta.json").read_text(encoding="utf-8"))
            meta["vocab_size"] = 16384
            (cache / "tokenizer" / "meta.json").write_text(
                json.dumps(meta), encoding="utf-8")
            self._verify_fails_with(cache, "vocab_size")

    def test_a_missing_shard_file_is_caught(self):
        """An incomplete upload would train on part of the corpus in silence."""
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            (cache / "shards" / "train-00001.bin").unlink()
            self._verify_fails_with(cache, "file(s) present")

    def test_a_resized_shard_file_is_caught_by_the_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            (cache / "shards" / "train-00000.bin").write_bytes(b"\x00" * 4096)
            self._verify_fails_with(cache, "do not match the recorded inventory")

    def test_a_newer_cache_format_is_not_checked_with_old_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            record = json.loads((cache / cc.CACHE_FILE).read_text(encoding="utf-8"))
            record["format"] = cc.CACHE_FORMAT + 1
            (cache / cc.CACHE_FILE).write_text(json.dumps(record), encoding="utf-8")
            self._verify_fails_with(cache, "cache format")

    def test_a_directory_that_is_not_a_cache_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "random"
            empty.mkdir()
            self._verify_fails_with(empty, "was not written by")

    def test_install_copies_nothing_when_verification_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = self._saved(tmp)
            (cache / "shards" / "val-00000.bin").unlink()
            target = Path(tmp) / "work" / "shards"
            with self.assertRaises(SystemExit):
                with redirect_stdout(__import__("io").StringIO()):
                    cc.main(["install", "--cache", str(cache), "--shards-to", str(target),
                             "--tokenizer-to", str(Path(tmp) / "work" / "tokenizer")])
            self.assertFalse(target.exists(),
                             "install must verify before it copies anything")


class RefusesToBuildABadCache(unittest.TestCase):
    def test_saving_a_mismatched_pair_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = build_corpus(Path(tmp) / "corpus", version="portfolio-bpe-12k-abc")
            meta = source / "tokenizer" / "meta.json"
            meta.write_text(json.dumps({"tokenizer_version": "portfolio-bpe-16k-xyz",
                                        "vocab_size": 1024}), encoding="utf-8")
            with self.assertRaises(SystemExit) as ctx:
                with redirect_stdout(__import__("io").StringIO()):
                    cc.main(["save", "--shards", str(source / "shards"),
                             "--tokenizer", str(source / "tokenizer"),
                             "--out", str(Path(tmp) / "cache")])
            self.assertIn("mismatched pair", str(ctx.exception))

    def test_the_projects_own_seed_shards_are_refused(self):
        """They predate `tokenizer_version`, so there is nothing to check the
        cache against — and an unverifiable cache is exactly what this tool is
        not allowed to produce."""
        shards = ROOT / "data" / "processed" / "seed" / "shards"
        tokenizer = ROOT / "ai" / "tokenizer" / "artifacts" / "seed-1k"
        if not (shards / "manifest.json").is_file():
            self.skipTest("no seed shards in this checkout")
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as ctx:
                with redirect_stdout(__import__("io").StringIO()):
                    cc.main(["save", "--shards", str(shards),
                             "--tokenizer", str(tokenizer),
                             "--out", str(Path(tmp) / "cache")])
            self.assertIn("mismatched pair", str(ctx.exception))

    def test_saving_without_shards_names_the_command_that_makes_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as ctx:
                with redirect_stdout(__import__("io").StringIO()):
                    cc.main(["save", "--shards", str(Path(tmp) / "nope"),
                             "--tokenizer", str(ROOT / "ai" / "tokenizer"
                                                 / "artifacts" / "seed-1k"),
                             "--out", str(Path(tmp) / "cache")])
            self.assertIn("prepare_data", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
