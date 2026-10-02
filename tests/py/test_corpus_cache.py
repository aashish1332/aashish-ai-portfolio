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
    """A minimal but honest shards + tokenizer pair."""
    shards = root / "shards"
    shards.mkdir(parents=True)
    manifest = {
        "dtype": "uint16",
        "vocab_size": vocab,
        "end_token_id": 4,
        "tokenizer_version": version,
        "shards": {
            "train": {"docs": 16893, "tokens": 749590, "files": 2},
            "val": {"docs": 844, "tokens": 37479, "files": 1},
        },
    }
    (shards / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    for name in ("train-00000.bin", "train-00001.bin", "val-00000.bin"):
        (shards / name).write_bytes(b"\x00\x01" * 32)

    tokenizer = root / "tokenizer"
    tokenizer.mkdir()
    (tokenizer / "meta.json").write_text(json.dumps({
        "tokenizer_version": version, "vocab_size": vocab, "name": "portfolio-bpe",
    }), encoding="utf-8")
    (tokenizer / "tokenizer.json").write_text("{}", encoding="utf-8")
    return root


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
