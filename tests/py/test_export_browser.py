"""tests/py/test_export_browser.py — EX-1…EX-16.

`inference/export_browser.py` and `inference/reference.py` are the two
pieces every browser number depends on: the exporter decides what a visitor
downloads, and the reference decides whether the JavaScript engine is
correct. Both are pure functions of a numpy array, so both are testable
without a GPU, a checkpoint or a browser — and `tests/engine.test.mjs` is
only as trustworthy as the fixture this file's subject generates.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ai.model.config import ModelConfig  # noqa: E402
from inference import export_browser as ex  # noqa: E402
from inference import reference  # noqa: E402

TINY = ex.TINY


def tiny_config(**over) -> ModelConfig:
    return ModelConfig(**{**TINY, **over})


class Quantization(unittest.TestCase):
    def test_EX_1_rows_quantize_inside_int8_and_report_their_error(self):
        rng = np.random.default_rng(0)
        w = (rng.standard_normal((7, 33)) * 0.4).astype(np.float32)
        codes, scales, err = ex.quantize_rows(w)
        self.assertEqual(codes.dtype, np.int8)
        self.assertEqual(codes.shape, w.shape)
        self.assertEqual(scales.shape, (7,))
        self.assertGreaterEqual(int(codes.min()), -127)
        self.assertLessEqual(int(codes.max()), 127)
        back = reference.q8_dequantise(codes, scales)
        self.assertLessEqual(float(np.abs(back - w).max()), err + 1e-9)
        # the reported error is the real one, not a bound on it
        self.assertAlmostEqual(err, float(np.abs(back - w).max()), places=6)

    def test_EX_2_an_all_zero_row_produces_zeros_not_nan(self):
        w = np.zeros((3, 4), dtype=np.float32)
        codes, scales, err = ex.quantize_rows(w)
        self.assertTrue(np.all(codes == 0))
        self.assertTrue(np.all(np.isfinite(scales)))
        self.assertTrue(np.all(np.isfinite(reference.q8_dequantise(codes, scales))))
        self.assertEqual(err, 0.0)

    def test_EX_3_a_row_scale_is_per_row(self):
        # Two rows of very different magnitude: a single global scale would
        # flatten the quiet row to zeros, which is the bug the per-row scheme
        # exists to avoid.
        w = np.array([[10.0, -10.0], [0.01, -0.01]], dtype=np.float32)
        codes, scales, _ = ex.quantize_rows(w)
        back = reference.q8_dequantise(codes, scales)
        self.assertGreater(scales[0], scales[1] * 100)
        self.assertNotEqual(int(codes[1, 0]), 0, "the quiet row must survive")

    def test_EX_4_one_dimensional_tensors_stay_float32(self):
        w = np.arange(5, dtype=np.float32)
        block, meta, err = ex.quantize_tensor("model.norm.weight", w)
        self.assertEqual(meta["dtype"], "f32")
        self.assertEqual(len(block), 20)
        self.assertEqual(err, 0.0)
        self.assertEqual(np.frombuffer(block, dtype=np.float32).tolist(), w.tolist())
        with self.assertRaises(ValueError):
            ex.quantize_tensor("bad", np.zeros((2, 2, 2), dtype=np.float32))

    def test_EX_5_padding_is_what_makes_the_scale_half_aligned(self):
        for n in range(0, 6):
            self.assertEqual(len(ex.pad(b"x" * n)) % 4, 0)
        # Odd row lengths are the interesting case: 3 rows x 5 columns is 15
        # code bytes, so the float32 scale half would start at byte 15 — a
        # `Float32Array` view there throws in JavaScript, which is why the
        # padding is in the *writer* (write_export) rather than in
        # quantize_tensor. Pinned here so moving it back fails loudly.
        block, meta, _ = ex.quantize_tensor("w", np.ones((3, 5), dtype=np.float32))
        # 15 code bytes + 3 float32 scales, unpadded, and `bytes` is added by
        # the writer because only the writer knows about the padding.
        self.assertEqual(len(block), 15 + 12)
        self.assertNotIn("bytes", meta, "padding belongs to the writer")
        self.assertEqual(len(ex.pad(block)) % 4, 0)


class Export(unittest.TestCase):
    def setUp(self):
        self.cfg = tiny_config()
        self.state = ex.random_state(self.cfg, 11)
        self.tmp = Path(self.enterContext(__import__("tempfile").TemporaryDirectory()))

    def run_export(self, **kw):
        return ex.write_export(self.state, self.cfg, self.tmp,
                              ROOT / "ai/tokenizer/artifacts/seed-1k",
                              {"kind": "random-init", "seed": 11, **kw})

    def test_EX_6_the_manifest_describes_every_tensor_and_shard(self):
        manifest = self.run_export()
        self.assertEqual(manifest["format"], ex.FORMAT)
        self.assertEqual(manifest["config"]["vocab_size"], self.cfg.vocab_size)
        self.assertTrue(manifest["tiedWordEmbeddings"])
        names = [t["name"] for t in manifest["tensors"]]
        self.assertEqual(names[0], "model.embed_tokens.weight")
        self.assertEqual(names[-1], "model.norm.weight")
        self.assertNotIn("lm_head.weight", names, "a tied model ships one matrix")
        self.assertEqual(len(names), 2 + self.cfg.num_hidden_layers * 9)
        for tensor in manifest["tensors"]:
            self.assertEqual(tensor["offset"] % 4, 0)
            self.assertEqual(tensor["bytes"] % 4, 0)
            self.assertLess(tensor["shard"], len(manifest["shards"]))

    def test_EX_7_hashes_match_the_files_that_were_written(self):
        manifest = self.run_export()
        for shard in manifest["shards"]:
            raw = (self.tmp / shard["name"]).read_bytes()
            self.assertEqual(len(raw), shard["bytes"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), shard["sha256"])
        tok = (self.tmp / "tokenizer.json").read_bytes()
        self.assertEqual(hashlib.sha256(tok).hexdigest(), manifest["tokenizer"]["sha256"])

    def test_EX_8_sizes_are_measured_and_both_baselines_are_reported(self):
        manifest = self.run_export()
        sizes = manifest["sizes"]
        self.assertEqual(sizes["weightsBytes"], sum(t["bytes"] for t in manifest["tensors"]))
        self.assertGreater(sizes["fp32EquivalentBytes"], sizes["weightsBytes"])
        self.assertAlmostEqual(sizes["fp32EquivalentBytes"], sizes["fp16EquivalentBytes"] * 2, delta=8)
        if sizes["brotliMeasured"]:
            self.assertIsInstance(sizes["brotliBytes"], int)
        else:
            self.assertIsNone(sizes["brotliBytes"])
        self.assertLessEqual(manifest["quantization"]["worstRowError"], 0.01)

    def test_EX_9_shards_respect_the_eight_megabyte_cap(self):
        # ~18 MB of q8 weights, so the split has to happen at least twice.
        big = tiny_config(hidden_size=384, num_hidden_layers=12, intermediate_size=1024,
                          num_attention_heads=8, num_key_value_heads=4)
        state = ex.random_state(big, 3)
        manifest = ex.write_export(state, big, self.tmp,
                                   ROOT / "ai/tokenizer/artifacts/seed-1k",
                                   {"kind": "random-init"})
        self.assertGreater(len(manifest["shards"]), 2, "this model must span several shards")
        for shard in manifest["shards"]:
            self.assertLessEqual(shard["bytes"], ex.MAX_SHARD_BYTES)
        # Every tensor belongs to exactly one shard, and each shard holds the
        # tensors that point at it.
        for index, shard in enumerate(manifest["shards"]):
            owned = [t for t in manifest["tensors"] if t["shard"] == index]
            self.assertTrue(owned)
            self.assertLessEqual(sum(t["bytes"] for t in owned), shard["bytes"])

    def test_EX_10_a_checkpoint_without_its_layers_are_named_in_the_error(self):
        broken = dict(self.state)
        broken.pop("model.layers.1.mlp.up_proj.weight")
        with self.assertRaises(KeyError) as ctx:
            ex.write_export(broken, self.cfg, self.tmp,
                            ROOT / "ai/tokenizer/artifacts/seed-1k", {"kind": "random-init"})
        self.assertIn("model.layers.1.mlp.up_proj.weight", str(ctx.exception))

    def test_EX_20_the_reference_reads_back_the_int8_shards_it_shipped(self):
        """The parity fixture must be built from the *exported* weights.

        Building it from the float checkpoint instead makes the JavaScript
        gate compare two different models, and the only thing it can then
        measure is how much quantization moved the logits. That failure mode
        is invisible on the tiny fixture and obvious on a trained 6-layer
        model, so the invariant is pinned here rather than in a comment.
        """
        manifest = self.run_export()
        weights = ex.load_exported_weights(self.tmp, manifest)
        self.assertEqual(sorted(weights), sorted(t["name"] for t in manifest["tensors"]))
        for tensor in manifest["tensors"]:
            source = np.asarray(self.state[tensor["name"]], dtype=np.float32)
            if tensor["dtype"] == "q8":
                codes, scales, _ = ex.quantize_rows(source)
                expected = reference.q8_dequantise(codes, scales)
            else:
                expected = source
            np.testing.assert_allclose(weights[tensor["name"]], expected, atol=0)
        # A shard that no longer hashes to its manifest entry is refused, not
        # silently dequantised into a wrong-but-plausible reference.
        shard = self.tmp / manifest["shards"][0]["name"]
        raw = bytearray(shard.read_bytes())
        raw[16] ^= 0xFF
        shard.write_bytes(bytes(raw))
        with self.assertRaises(ValueError) as ctx:
            ex.load_exported_weights(self.tmp, manifest)
        self.assertIn("hashes to", str(ctx.exception))

    def test_EX_11_a_random_export_is_reproducible_from_its_seed(self):
        a = ex.random_state(self.cfg, 5)
        b = ex.random_state(self.cfg, 5)
        c = ex.random_state(self.cfg, 6)
        for key in a:
            self.assertTrue(np.array_equal(a[key], b[key]), key)
        # The norms are all-ones by construction, so the seed has to be
        # judged on a tensor that carries random values.
        self.assertFalse(np.array_equal(a["model.embed_tokens.weight"],
                                        c["model.embed_tokens.weight"]))
        self.assertTrue(np.array_equal(a["model.norm.weight"], c["model.norm.weight"]))


class ReferenceForward(unittest.TestCase):
    """The numpy pass that the JavaScript engine is checked against."""

    def setUp(self):
        self.cfg = tiny_config(max_position_embeddings=64)
        self.weights = ex.random_state(self.cfg, 17)
        self.ids = [3, 11, 12, 200, 3, 45, 7]

    def test_EX_12_logits_have_the_right_shape_and_are_finite(self):
        logits = reference.forward(self.weights, self.cfg, self.ids)
        self.assertEqual(logits.shape, (len(self.ids), self.cfg.vocab_size))
        self.assertTrue(np.all(np.isfinite(logits)))
        with self.assertRaises(ValueError):
            reference.forward(self.weights, self.cfg, [])
        with self.assertRaises(ValueError):
            reference.forward(self.weights, self.cfg, [self.cfg.vocab_size + 1])
        with self.assertRaises(ValueError):
            reference.forward(self.weights, self.cfg, [1] * (self.cfg.max_position_embeddings + 1))

    def test_EX_13_the_pass_is_causal(self):
        # Changing a LATER token must not change an EARLIER position's logits.
        # This is the property a mask bug destroys while every shape stays
        # correct, which is why it is asserted rather than assumed.
        base = reference.forward(self.weights, self.cfg, self.ids)
        changed = list(self.ids)
        changed[4] = (changed[4] + 5) % self.cfg.vocab_size
        other = reference.forward(self.weights, self.cfg, changed)
        for pos in range(4):
            np.testing.assert_allclose(base[pos], other[pos], atol=1e-6)
        self.assertFalse(np.allclose(base[4], other[4]),
                         "the edited position itself must change")

    def test_EX_14_the_tied_head_is_the_embedding(self):
        tied = dict(self.weights)
        tied["lm_head.weight"] = (tied["lm_head.weight"] + 1.0).astype(np.float32)
        # `tie_head` prefers the embedding when the config ties, so an lm_head
        # left lying around must not be used at all.
        a = reference.forward(self.weights, self.cfg, self.ids)
        b = reference.forward(tied, self.cfg, self.ids)
        np.testing.assert_allclose(a, b, atol=1e-6)

    def test_EX_15_gqa_grouping_is_contiguous(self):
        # heads 0..3 with n_rep = 2: query heads 0,1 read KV head 0 and 2,3
        # read KV head 1. Getting this wrong still produces finite logits.
        self.assertEqual(self.cfg.n_rep, 2)
        from ai.model import plan
        self.assertEqual(plan.gqa_head_map(4, 2), [0, 0, 1, 1])

    def test_EX_16_greedy_is_deterministic_and_stops(self):
        from tokenizers import Tokenizer
        tok = Tokenizer.from_file(str(ROOT / "ai/tokenizer/artifacts/seed-1k/tokenizer.json"))
        stop = {tok.token_to_id("<|end|>")}
        ids = tok.encode("<|sys|> hi<|ctx|> [person.name] Aashish<|user|> name?<|asst|>").ids
        first = reference.greedy(self.weights, self.cfg, ids, 5, stop)
        second = reference.greedy(self.weights, self.cfg, ids, 5, stop)
        self.assertEqual(first, second)
        self.assertLessEqual(len(first), 5)
        self.assertEqual(reference.greedy(self.weights, self.cfg, ids, 0, stop), [])


class ReferenceCrossCheck(unittest.TestCase):
    def test_EX_17_numpy_matches_the_trained_torch_graph(self):
        """The triangle's first edge. Skips (loudly) without torch."""
        try:
            import torch  # noqa: F401
        except ImportError:  # pragma: no cover
            self.skipTest("torch is not installed")
        cfg = tiny_config(max_position_embeddings=64)
        state = ex.random_state(cfg, 23)
        ids = [3, 11, 12, 200, 3, 45]
        check = ex.torch_cross_check(state, cfg, ids)
        self.assertEqual(check["status"], "PASS", check)
        self.assertLess(check["maxAbsDiff"], 1e-3)
        self.assertTrue(check["argmaxAgree"])

    def test_EX_18_an_exported_fixture_round_trips_through_torch_if_present(self):
        try:
            import torch  # noqa: F401
        except ImportError:  # pragma: no cover
            self.skipTest("torch is not installed")
        # A one-layer model: the cheapest thing that still exercises GQA,
        # RoPE and SwiGLU through the torch implementation.
        cfg = tiny_config(num_hidden_layers=1, max_position_embeddings=32)
        state = ex.random_state(cfg, 29)
        check = ex.torch_cross_check(state, cfg, [1, 2, 3, 4, 5])
        self.assertEqual(check["status"], "PASS", check)


class ReferenceFixtureOnDisk(unittest.TestCase):
    """The committed fixture is what `tests/engine.test.mjs` trusts."""

    def test_EX_19_the_committed_fixture_matches_its_manifest(self):
        fixture_dir = ROOT / "tests/fixtures/tiny-model"
        ref = json.loads((ROOT / "tests/fixtures/engine_reference.json").read_text("utf-8"))
        manifest = json.loads((fixture_dir / "manifest.json").read_text("utf-8"))
        self.assertEqual(ref["format"], ex.FORMAT)
        self.assertEqual(ref["modelDir"], "tests/fixtures/tiny-model")
        self.assertEqual(manifest["format"], ex.FORMAT)
        for shard in manifest["shards"]:
            raw = (fixture_dir / shard["name"]).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), shard["sha256"])
        for case in ref["cases"]:
            self.assertEqual(len(case["logits"]["positions"]), len(case["promptIds"]))
            self.assertEqual(len(case["logits"]["positions"][0]["top"]), 16)
        self.assertEqual(ref["torchCheck"]["status"], "PASS")


class ShippedProvenance(unittest.TestCase):
    """What the manifest is allowed to say about where the weights came from."""

    def test_EX_21_provenance_names_no_directory(self):
        path = Path(self.enterContext(__import__("tempfile").TemporaryDirectory())) / "latest.pt"
        path.write_bytes(b"not really a checkpoint")
        run_dir = Path("training") / "checkpoints" / "stage-b"
        provenance = ex.checkpoint_provenance(
            run_dir, "latest",
            {"step": 1200, "saved_at": 0.0, "git_commit": "abc1234"}, path)

        self.assertEqual(provenance["run"], "stage-b")
        self.assertEqual(provenance["which"], "latest")
        self.assertEqual(provenance["step"], 1200)
        self.assertEqual(provenance["gitCommit"], "abc1234")
        self.assertEqual(provenance["checkpointSha256"],
                         hashlib.sha256(b"not really a checkpoint").hexdigest())
        # `saved_at` 0.0 is falsy, so the key is omitted rather than shipped as
        # an epoch-0 timestamp that would read as real data.
        self.assertNotIn("savedAt", provenance)
        # The whole point: a shipped manifest that names a dev tree fails the
        # build (`tools/build.mjs` DEV_ONLY_PATTERNS). No value may contain a
        # separator, so no value can name one.
        for key, value in provenance.items():
            self.assertNotIn("/", str(value), key)
            self.assertNotIn("\\", str(value), key)
        self.assertEqual(set(provenance), {"run", "which", "step", "checkpointSha256",
                                           "gitCommit"})


if __name__ == "__main__":
    unittest.main()
