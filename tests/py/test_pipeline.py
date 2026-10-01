"""tests/py/test_pipeline.py — §7.3 pipeline behaviour.

The pipeline's job is to lose data *deliberately* and to prove it did. So
these tests mostly assert on the reasons things were dropped, and they
assert the negative case for the leakage check — a detector that never
fires is indistinguishable from a clean dataset.

Uses a tiny tokenizer trained inside the test, so nothing here depends on
a committed artifact or on network access.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.data import dataset, facts, pipeline  # noqa: E402
from ai.tokenizer import spec  # noqa: E402

KB = {
    "person": {"id": "person.name", "name": "Test Person", "public": True},
    "contact": {
        "email": {"id": "contact.email", "value": "public@example.com", "public": True},
        # A stand-in, deliberately not the real withheld number: nothing in
        # this repository should repeat a value the assistant is told not to
        # state, including its own test fixtures.
        "phone": {"id": "contact.phone", "value": "+91 00000 00000", "public": False},
    },
    "links": [{"id": "link.github", "label": "GitHub",
               "url": "https://github.com/somebody", "public": True}],
    "projects": [{"id": "project.demo", "name": "Demo", "public": True,
                  "links": [{"label": "Live", "url": "https://demo.vercel.app/"}]}],
}


def tiny_tokenizer():
    """A real BPE over a few lines — hermetic, no artifact needed."""
    from tokenizers import Tokenizer, decoders, models, normalizers, pre_tokenizers, trainers

    lines = [
        "the quick brown fox jumps over the lazy dog",
        "आशीष ने किताब पढ़ी और घर लौट गया",
        "uska naam kya hai batao",
        "https://github.com/somebody builds projects",
        "aashish kumar is a full stack developer from india",
    ]
    tok = Tokenizer(models.BPE(unk_token=None))
    tok.normalizer = normalizers.NFC()
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    tok.train_from_iterator(lines, trainers.BpeTrainer(
        vocab_size=512, min_frequency=1,
        special_tokens=list(spec.SPECIAL_TOKENS),
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet()))
    return tok


class Normalize(unittest.TestCase):
    def test_nfc_and_whitespace(self):
        # e + combining acute → precomposed é, tabs/newlines collapsed
        self.assertEqual(pipeline.normalize_text("cafe\u0301\t  test\n\nx"), "café test\nx")
        self.assertEqual(pipeline.normalize_text("  hello   world  "), "hello world")
        self.assertEqual(pipeline.normalize_text("a\x00b"), "ab")
        self.assertEqual(pipeline.normalize_text(""), "")

    def test_devanagari_is_not_mangled(self):
        text = "ग़लत फ़ोन पढ़ाई"
        self.assertEqual(pipeline.normalize_text(text), text)
        self.assertIn("\u093c", pipeline.normalize_text(text))  # nukta survives


class PiiMasking(unittest.TestCase):
    def test_public_url_becomes_a_placeholder(self):
        text, notes = pipeline.mask_pii(
            "The demo runs at https://demo.vercel.app/ today.", facts.all_values(KB))
        self.assertIn("<|fact:project.demo.live|>", text)
        self.assertIn("placeholder:project.demo.live", notes)
        self.assertNotIn("demo.vercel.app", text)

    def test_public_email_becomes_a_placeholder_and_private_values_never_do(self):
        values = facts.all_values(KB)
        self.assertEqual(values.get("contact.email"), "public@example.com")
        self.assertNotIn("contact.phone", values)

        text, _ = pipeline.mask_pii("Mail public@example.com please.", values)
        self.assertEqual(text, "Mail <|fact:contact.email|> please.")

        # The withheld number is not masked — it is *removed*, with the line
        # rejected by build_corpus, so it can never be learned.
        text, notes = pipeline.mask_pii("Call +91 00000 00000 now.", values)
        self.assertIn("dropped:phone", notes)
        self.assertNotIn("00000", text)

    def test_unknown_hosts_lose_the_url_and_kept_hosts_keep_it(self):
        text, notes = pipeline.mask_pii("See https://evil.example.net/a?id=42 now.", {})
        self.assertIn("dropped:url", notes)
        self.assertNotIn("evil.example.net", text)

        text, notes = pipeline.mask_pii("See https://github.com/x?tab=repos now.", {})
        self.assertEqual(notes, [])
        self.assertIn("https://github.com/x", text)
        self.assertNotIn("tab=repos", text, "query strings carry tracking ids")

    def test_facts_gate_mirrors_the_js_public_rule(self):
        self.assertTrue(facts.is_public({}))
        self.assertTrue(facts.is_public({"public": True}))
        self.assertFalse(facts.is_public({"public": False}))
        ids = {f["id"] for f in facts.iter_facts(KB)}
        self.assertIn("project.demo.live", ids)
        self.assertIn("contact.phone", facts.withheld(KB))
        self.assertNotIn("contact.phone", facts.all_values(KB))


class FiltersAndDedupe(unittest.TestCase):
    def test_each_filter_reason_fires(self):
        cases = {
            "too_short": "short one",
            "too_long": "word " * 600,
            "no_letters": "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20",
            "pii_shaped": "Reach the team at someone@corp.example today please.",
            "blocklist": "you are a chutiya person and I mean it truly",
        }
        for reason, text in cases.items():
            with self.subTest(reason=reason):
                self.assertIn(reason, pipeline.filter_reasons(text),
                              f"{reason} did not fire for {text[:40]!r}")

    def test_a_kept_host_url_is_not_pii_shaped(self):
        self.assertEqual(pipeline.filter_reasons(
            "Open https://github.com/somebody/repo to read the source code."), [])

    def test_dedupe_threshold_behaviour_is_pinned(self):
        """The three measured cases from `NEAR_DUP_THRESHOLD`'s comment.

        Asserted on purpose in both directions: the threshold must remove
        echoes *and* must keep a sentence whose slot changed, because those
        are the examples that teach the tokenizer anything.
        """
        base = ("Aashish built a volunteer management system with ninety API endpoints "
                "across sixteen route groups and forty database tables last year.")
        echo = base + " It ships every week."
        slot = base.replace("last year", "this year")
        parallel = "What are his projects and how did he build them?"

        records, stats = pipeline.build_corpus([base, base, echo, slot, parallel])
        kept = [r.text for r in records]
        self.assertEqual(len(kept), 3, f"kept {len(kept)}: {[t[:45] for t in kept]}")
        self.assertIn(slot, kept, "a one-slot change must survive")
        self.assertIn(parallel, kept)
        self.assertNotIn(echo, kept, "an echoed sentence must be dropped")
        self.assertEqual(stats.dropped.get("near_duplicate"), 2)

    def test_distinct_sentences_sharing_a_frame_survive(self):
        lines = ["What are his skills and how did he learn them?",
                 "What are his projects and how did he build them?"]
        records, _ = pipeline.build_corpus(lines)
        self.assertEqual(len(records), 2, "near-duplicate threshold is too aggressive")

    def test_language_tagging_uses_the_shared_detector(self):
        lines = ["उसका नाम क्या है और उसने क्या किया?",
                 "uska naam kya hai aur usne kya kiya?",
                 "What is his name and what did he do?"]
        records, stats = pipeline.build_corpus(lines)
        self.assertEqual({r.lang for r in records}, {"hi", "hinglish", "en"})
        self.assertEqual(sum(stats.by_lang.values()), 3)


class SplitsAndLeakage(unittest.TestCase):
    def test_split_is_deterministic_and_reproducible(self):
        lines = [f"Aashish writes sentence number {i} about a different topic entirely."
                 for i in range(40)]
        records, _ = pipeline.build_corpus(lines)
        first = [r.split for r in pipeline.assign_splits(records)]
        second = [r.split for r in pipeline.assign_splits(records)]
        self.assertEqual(first, second)
        self.assertIn("train", first)
        self.assertIn("val", first)

    def test_leakage_detector_fires_when_a_document_is_in_both_splits(self):
        lines = [f"Aashish writes sentence number {i} about a rather different topic." for i in range(20)]
        records, _ = pipeline.build_corpus(lines)
        train = pipeline.assign_splits(records)
        for r in train:
            r.split = "train"
        val = [pipeline.Record(text=train[0].text, lang="en", split="val")]
        report = pipeline.leakage_report(train, val)
        self.assertFalse(report["clean"], "exact overlap was not detected")
        self.assertEqual(report["exact_overlap"], 1)

    def test_leakage_detector_reports_clean_on_disjoint_data(self):
        train = [pipeline.Record(text=f"Train sentence {i} about a distinct subject here.") for i in range(5)]
        val = [pipeline.Record(text=f"Validation sentence {i} covering other material.") for i in range(5)]
        report = pipeline.leakage_report(train, val)
        self.assertTrue(report["clean"], report)


class Shards(unittest.TestCase):
    def test_shards_round_trip_and_are_uint16(self):
        tokenizer = tiny_tokenizer()
        lines = [f"Aashish wrote document number {i} with a few words in it." for i in range(12)]
        records, _ = pipeline.build_corpus(lines)
        records = pipeline.assign_splits(records, val_percent=25)

        with tempfile.TemporaryDirectory() as tmp:
            manifest = pipeline.write_shards(records, tokenizer, tmp)
            self.assertEqual(manifest["dtype"], "uint16")
            self.assertEqual(manifest["end_token_id"], tokenizer.token_to_id("<|end|>"))
            total = manifest["shards"]["train"]["tokens"] + manifest["shards"]["val"]["tokens"]
            self.assertGreater(total, 0)

            path = Path(tmp) / manifest["shards"]["train"]["files"][0]["file"]
            mapped = pipeline.load_shard(path)
            self.assertIsInstance(mapped, np.memmap)
            self.assertEqual(mapped.dtype, np.dtype("uint16"))
            values = pipeline.read_shard(path)
            mapped._mmap.close()  # Windows will not delete a mapped file
            decoded = tokenizer.decode([int(i) for i in values[:40]], skip_special_tokens=False)
            self.assertIn("Aashish", decoded, f"unexpected decode: {decoded[:60]!r}")

            again = json.loads((Path(tmp) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(again["shards"]["train"]["tokens"], manifest["shards"]["train"]["tokens"])

    def test_every_document_ends_with_the_end_token(self):
        tokenizer = tiny_tokenizer()
        end_id = tokenizer.token_to_id("<|end|>")
        lines = [f"Document {i} ends with a full stop here." for i in range(6)]
        records, _ = pipeline.build_corpus(lines)
        for r in records:
            r.split = "train"
        with tempfile.TemporaryDirectory() as tmp:
            manifest = pipeline.write_shards(records, tokenizer, tmp)
            data = pipeline.read_shard(
                Path(tmp) / manifest["shards"]["train"]["files"][0]["file"])
            self.assertEqual(int((data == end_id).sum()), len(records),
                             "each document must be separated by exactly one <|end|>")


class ShardTokenizerMatch(unittest.TestCase):
    """Guards the silent tokenizer mismatch, found by reading the P4 notebook.

    The notebook sharded the corpus with `seed-1k`, then trained the 16k
    tokenizer from it and passed *that* to training while pointing `--shards`
    at the seed-1k shards. Every existing check passed: token ids are opaque,
    and ids from a 1k vocabulary are all valid indices into a 16k embedding.
    The embedding is sized from the config, so the run would have produced a
    model that encodes text one way and was trained another — hours of GPU
    spent on a checkpoint that cannot be used for inference.
    """

    def build(self, tmp: str, version: str = "seed-1k"):
        tokenizer = tiny_tokenizer()
        lines = [f"Aashish wrote document number {i} with a few short words." for i in range(12)]
        records, _ = pipeline.build_corpus(lines)
        records = pipeline.assign_splits(records, val_percent=25)
        manifest = pipeline.write_shards(records, tokenizer, tmp, tokenizer_version=version)
        return dataset.ShardSet.load(tmp), manifest

    def test_the_manifest_records_which_tokenizer_built_the_shards(self):
        with tempfile.TemporaryDirectory() as tmp:
            shards, manifest = self.build(tmp, "seed-1k")
            self.assertEqual(manifest["tokenizer_version"], "seed-1k")
            self.assertEqual(shards.tokenizer_version, "seed-1k")
            self.assertEqual(shards.vocab_size, manifest["vocab_size"])

    def test_a_matching_tokenizer_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            shards, manifest = self.build(tmp)
            shards.assert_matches_tokenizer({"vocab_size": manifest["vocab_size"],
                                             "tokenizer_version": "seed-1k"})

    def test_a_larger_tokenizer_is_refused_and_names_both_sides(self):
        with tempfile.TemporaryDirectory() as tmp:
            shards, manifest = self.build(tmp, "seed-1k")
            with self.assertRaises(ValueError) as ctx:
                shards.assert_matches_tokenizer({"vocab_size": manifest["vocab_size"] * 4,
                                                 "tokenizer_version": "stage-a-16k"})
            message = str(ctx.exception)
            self.assertIn("tokenizer mismatch", message)
            self.assertIn("seed-1k", message)
            self.assertIn("stage-a-16k", message)
            self.assertIn("prepare_data", message, "the fix must be named, not implied")

    def test_a_smaller_tokenizer_is_refused_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            shards, manifest = self.build(tmp)
            with self.assertRaises(ValueError):
                shards.assert_matches_tokenizer({"vocab_size": manifest["vocab_size"] // 2})

    def test_a_manifest_with_no_vocab_size_is_refused_rather_than_assumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            shards, _ = self.build(tmp)
            del shards.manifest["vocab_size"]
            with self.assertRaises(ValueError) as ctx:
                shards.assert_matches_tokenizer({"vocab_size": 512})
            self.assertIn("no vocab_size", str(ctx.exception))

    def test_a_bounds_check_alone_could_not_have_caught_this(self):
        """Why the guard has to exist: every id from the smaller vocabulary is
        a legal index into the larger embedding, so the old
        `max() < vocab_size` assertion is satisfied by exactly the broken case."""
        with tempfile.TemporaryDirectory() as tmp:
            shards, manifest = self.build(tmp, "seed-1k")
            # read_shard copies out, so the memmap is closed before the temp
            # directory is removed (Windows will not delete a mapped file)
            data = pipeline.read_shard(shards.root / shards.train_files[0])
            self.assertLess(int(data.max()), manifest["vocab_size"] * 4,
                            "the mismatch must be invisible to a bounds check")


if __name__ == "__main__":
    unittest.main()
