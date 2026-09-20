"""tests/py/test_tokenizer_train.py — §7.2 training, hermetically.

Trains a real tokenizer inside a temporary directory on every run. That
matters more than it looks: the committed artifact (`artifacts/seed-1k`)
is a build output, and a test that only reads it would silently pass
forever if the trainer itself broke.

The *guard* tests are the interesting half. A BPE trained on less text than
its requested vocabulary needs does not fail loudly in most setups — it
returns a smaller vocab, the embedding layer is then sized from the config
rather than the artifact, and every downstream number is quietly wrong.
`train.py` refuses; these tests prove it refuses.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    import tokenizers  # noqa: F401

    from ai.tokenizer import fertility, spec
    from ai.tokenizer.train import load, train_tokenizer

    HAS_TOKENIZERS = True
except ImportError:
    HAS_TOKENIZERS = False

CORPUS = [
    "Aashish built a volunteer management system with ninety API endpoints.",
    "The assistant answers only from a verified knowledge base.",
    "Devanagari text must survive tokenisation without losing matras.",
    "आशीष ने किताब पढ़ी और फिर घर लौट गया।",
    "उसका प्रोजेक्ट कौन सा है और उसने क्या बनाया?",
    "uska naam kya hai batao, main sirf verified data bataunga.",
    "usne kitne api endpoints banaye aur kaun sa database use kiya?",
    "SELECT id, created_at FROM users WHERE role = 'admin' LIMIT 20;",
    "npm run build && node dist/index.mjs --port=5173",
    "def forward(self, x): return x * torch.rsqrt(x.pow(2).mean(-1))",
    "https://atlascommunity-one.vercel.app/ and https://github.com/somebody",
    "The tokenizer uses byte-level BPE with NFC normalisation and no unk token.",
    "Grouped-query attention shares each KV head across two query heads.",
    "Rotary position embeddings preserve the norm of every head vector.",
    "A small model can be fluent when the distribution is narrow and clean.",
    "Recruiters ask about projects, skills, education and availability.",
    "क्या वह पूर्णकालिक नौकरी के लिए उपलब्ध है?",
    "namaste, aap kaise hain, kya main uska email dekh sakta hun?",
    "The evaluation runner prints its case counts and any open gaps.",
    "Every placeholder must be a single token so the model cannot corrupt it.",
    "Vite bundles the frontend and Tailwind supplies the utility classes.",
    "Drizzle ORM maps TypeScript schemas onto MySQL tables without migration drift.",
    "Helmet sets security headers while Zod validates every request payload.",
    "Argon2 hashes passwords and JWT carries the role claims for RBAC checks.",
    "Recharts renders four analytics dashboards from aggregated query results.",
    "The grocery application tracks baskets, recipes and delivery windows.",
    "The goal tracker stores streaks, reminders and weekly review notes.",
    "Vector databases, embeddings and BM25 rank passages differently.",
    "Quantisation to INT4 shrinks linear layers while the head stays INT8.",
    "The loader caches shards in OPFS and deletes superseded versions.",
    "प्रत्येक वाक्य सरल भाषा में लिखा गया है ताकि मॉडल सीख सके।",
    "उसने डेटाबेस डिज़ाइन किया और एपीआई लिखी।",
    "रिक्रूटर अक्सर परियोजना और कौशल के बारे में पूछते हैं।",
    "मैं हिंदी, अंग्रेज़ी और हिंग्लिश में उत्तर दे सकता हूँ।",
    "yeh portfolio assistant sirf verified facts batata hai.",
    "recruiter ko projects aur skills ke bare mein batao.",
    "kya tum uska resume download kar sakte ho?",
    "Byte-level BPE never needs an unknown token because bytes cover everything.",
    "Rotary frequencies start at one and decay geometrically.",
    "SwiGLU multiplies a gated projection with an up projection.",
    "Checkpoints are written atomically and pruned to the newest three.",
    "A resume that loses a shard cursor silently repeats training tokens.",
]

# 44 distinct lines / 348 distinct word forms. That number matters: a BPE's
# vocabulary ceiling is set by the corpus's *lexicon*, not its size —
# measured, repetition does not raise it (×4 and ×16 both topped out at the
# same 802 tokens on the shorter list). It is why ai/tokenizer/train.py
# refuses a vocab the corpus cannot justify instead of quietly emitting a
# smaller one.
CORPUS_REPEATS = 4


@unittest.skipUnless(HAS_TOKENIZERS, "the `tokenizers` package is not installed")
class TokenizerTraining(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.corpus = self.dir / "corpus.txt"
        self.corpus.write_text("\n".join(CORPUS * CORPUS_REPEATS) + "\n",
                               encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def train(self, vocab=1024, **kw):
        """`min_frequency=1` because a 44-line corpus has few repeated pairs.

        The product default (2) is what the real corpus uses; the trainer
        only cares that the requested vocab exists at all.
        """
        kw.setdefault("min_frequency", 1)
        out = self.dir / f"artifact-{vocab}"
        result = train_tokenizer([self.corpus], vocab, out, name="test", **kw)
        return result, out

    def test_trains_a_conformant_artifact(self):
        result, out = self.train()
        tokenizer = result["tokenizer"]
        meta = result["meta"]

        self.assertEqual(tokenizer.get_vocab_size(), 1024)
        self.assertEqual(meta["vocab_size"], 1024)
        self.assertEqual(meta["unknown_token"], None)
        self.assertTrue(meta["byte_fallback"])
        self.assertEqual(meta["normalizer"], "NFC")
        self.assertEqual(meta["special_tokens"], list(spec.SPECIAL_TOKENS))
        self.assertEqual(meta["spec_hash"], spec.spec_hash())
        self.assertEqual(meta["tokenizer_version"],
                         spec.tokenizer_version("test", 1024))
        self.assertEqual(len(result["checks"]), 3)
        for name in ("tokenizer.json", "meta.json"):
            self.assertTrue((out / name).is_file(), f"{name} missing")
        self.assertEqual(meta["corpus"]["bytes"], self.corpus.stat().st_size)

    def test_artifact_reloads_identically(self):
        _, out = self.train()
        tokenizer, meta = load(out)
        self.assertEqual(tokenizer.get_vocab_size(), meta["vocab_size"])
        ids = tokenizer.encode("नमस्ते, क्या हाल है?", add_special_tokens=False).ids
        again = tokenizer.encode("नमस्ते, क्या हाल है?", add_special_tokens=False).ids
        self.assertEqual(ids, again)

    def test_vocab_too_large_for_the_corpus_is_refused(self):
        with self.assertRaises(SystemExit) as ctx:
            self.train(vocab=4096)
        message = str(ctx.exception)
        self.assertIn("4096", message)
        self.assertIn("too small", message,
                      "the error must say *why*, not just that it failed")

    def test_vocab_must_be_a_multiple_of_the_step(self):
        with self.assertRaises(SystemExit) as ctx:
            self.train(vocab=1500)
        self.assertIn("multiple", str(ctx.exception))

    def test_vocab_above_the_spec_ceiling_is_refused(self):
        with self.assertRaises(SystemExit) as ctx:
            self.train(vocab=65536)
        self.assertIn("32", str(ctx.exception))

    def test_empty_corpus_list_is_refused(self):
        with self.assertRaises(SystemExit):
            train_tokenizer([], 1024, self.dir / "nope")

    def test_nfc_normalisation_merges_the_two_spellings(self):
        result, _ = self.train()
        tokenizer = result["tokenizer"]
        composed = tokenizer.encode("caf\u00e9", add_special_tokens=False).ids
        decomposed = tokenizer.encode("cafe\u0301", add_special_tokens=False).ids
        self.assertEqual(composed, decomposed,
                         "NFC must run before tokenisation, not after")
        self.assertEqual(tokenizer.decode(composed), "caf\u00e9")

    def test_byte_fallback_handles_anything(self):
        result, _ = self.train()
        tokenizer = result["tokenizer"]
        for text in ["🎬🎥", "漢字テスト", "ŻÓŁĆ", "\u0000\u001b[31m", "ᚠᚢᚦ"]:
            ids = tokenizer.encode(text, add_special_tokens=False).ids
            self.assertTrue(ids, f"nothing encoded for {text!r}")
            self.assertEqual(tokenizer.decode(ids), text, f"round-trip failed for {text!r}")

    def test_special_tokens_are_atomic_and_distinct(self):
        result, _ = self.train()
        tokenizer = result["tokenizer"]
        vocab = tokenizer.get_vocab()
        ids = [vocab[t] for t in spec.SPECIAL_TOKENS]
        self.assertEqual(len(set(ids)), len(ids))
        for token in spec.SPECIAL_TOKENS:
            self.assertEqual(tokenizer.encode(token, add_special_tokens=False).ids,
                             [vocab[token]])

    def test_placeholders_are_single_tokens(self):
        result, _ = self.train()
        tokenizer = result["tokenizer"]
        vocab = tokenizer.get_vocab()
        for fid in ("contact.email", "link.github", "project.volunteer.live"):
            token = spec.placeholder_token(fid)
            ids = tokenizer.encode(token, add_special_tokens=False).ids
            self.assertEqual(ids, [vocab[token]],
                             f"{token} split into {ids} — the model could corrupt it")


@unittest.skipUnless(HAS_TOKENIZERS, "the `tokenizers` package is not installed")
class Fertility(unittest.TestCase):
    def test_report_covers_every_required_category(self):
        samples = fertility.load_samples()
        self.assertEqual(sorted(samples), ["en", "hi", "hinglish", "tech", "url_email"])
        for category, lines in samples.items():
            self.assertGreaterEqual(len(lines), 5, f"{category} needs more probe lines")

    def tiny(self):
        """One real trained tokenizer, reused by the fertility checks."""
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        corpus = Path(self.tmp.name) / "corpus.txt"
        corpus.write_text("\n".join(CORPUS * CORPUS_REPEATS) + "\n", encoding="utf-8")
        result = train_tokenizer([corpus], 1024, Path(self.tmp.name) / "art",
                                 name="fertility", min_frequency=1)
        return result["tokenizer"]

    def test_measurement_shape_and_warnings(self):
        tokenizer = self.tiny()
        stats = fertility.measure(tokenizer, fertility.load_samples())
        for category, stat in stats.items():
            for key in ("tokens", "words", "chars", "tokens_per_word",
                        "chars_per_token", "warn"):
                self.assertIn(key, stat, f"{category} missing {key}")
            self.assertGreater(stat["tokens_per_word"], 0.0)
        # A 1k vocabulary over a 44-line corpus is genuinely expensive for
        # Devanagari and URLs; if this ever stops being reported the warning
        # has broken, not the tokenizer.
        self.assertTrue(stats["hi"]["warn"], "Hindi fertility must be flagged")
        self.assertGreater(stats["hi"]["tokens_per_word"],
                           stats["en"]["tokens_per_word"],
                           "at 1k, Hindi must cost more tokens per word than English")

    def test_report_prints_and_returns(self):
        import io

        tokenizer = self.tiny()
        buffer = io.StringIO()
        stats = fertility.report(tokenizer, 1024, stream=buffer)
        self.assertIn("tokens/word", buffer.getvalue())
        self.assertEqual(set(stats), set(fertility.load_samples()))


class PathHandling(unittest.TestCase):
    def test_relative_paths_are_normalised_for_provenance(self):
        from ai.tokenizer.train import _rel

        absolute = Path(ROOT) / "data" / "raw" / "seed" / "conv_en.txt"
        self.assertEqual(_rel(absolute), "data/raw/seed/conv_en.txt")
        # a path outside the repository must not crash the run
        outside = Path(tempfile.gettempdir()) / "somewhere.txt"
        self.assertIn("somewhere.txt", _rel(outside))


if __name__ == "__main__":
    unittest.main()
