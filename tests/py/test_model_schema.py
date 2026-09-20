"""tests/py/test_model_schema.py — §7.1 arithmetic, naming and math.

Three things are being pinned here:

1. **The numbers in the spec.** §7.1 says config A is ~37.9M parameters and
   a ~10 KB/token KV cache. Those are asserted exactly, so a config edit
   cannot quietly walk the model out of the 30–50M band.
2. **The names.** The parameter list is asserted key-for-key against the HF
   `LlamaForCausalLM` state-dict layout, because that is what makes P6's
   GGUF/ONNX export work without a custom runtime. A rename here fails now
   rather than at export time.
3. **The math.** RoPE is a rotation (norms preserved), GQA groups KV heads
   contiguously, RMSNorm matches its formula.

Nothing here needs torch. When torch *is* installed,
`inference/count_parameters.py` additionally builds the module and compares
it to this schema; `tests/py/test_model_torch.py` covers the module itself.
"""

from __future__ import annotations

import sys
import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.model import plan  # noqa: E402
from ai.model.config import (  # noqa: E402
    CONFIG_A, CONFIG_LITE, CONFIG_SMOKE, ModelConfig, ffn_size,
)

try:
    import torch  # noqa: F401

    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False


class SchemaNames(unittest.TestCase):
    """The exact HF Llama key set for a 2-layer, 2-head/1-kv-head config."""

    CFG = ModelConfig(vocab_size=256, hidden_size=16, num_hidden_layers=2,
                      num_attention_heads=2, num_key_value_heads=1,
                      intermediate_size=32, max_position_embeddings=64, name="schema")

    def test_key_set_matches_hf_llama(self):
        expected = {
            "model.embed_tokens.weight",
            "model.layers.0.input_layernorm.weight",
            "model.layers.0.self_attn.q_proj.weight",
            "model.layers.0.self_attn.k_proj.weight",
            "model.layers.0.self_attn.v_proj.weight",
            "model.layers.0.self_attn.o_proj.weight",
            "model.layers.0.post_attention_layernorm.weight",
            "model.layers.0.mlp.gate_proj.weight",
            "model.layers.0.mlp.up_proj.weight",
            "model.layers.0.mlp.down_proj.weight",
            "model.layers.1.input_layernorm.weight",
            "model.layers.1.self_attn.q_proj.weight",
            "model.layers.1.self_attn.k_proj.weight",
            "model.layers.1.self_attn.v_proj.weight",
            "model.layers.1.self_attn.o_proj.weight",
            "model.layers.1.post_attention_layernorm.weight",
            "model.layers.1.mlp.gate_proj.weight",
            "model.layers.1.mlp.up_proj.weight",
            "model.layers.1.mlp.down_proj.weight",
            "model.norm.weight",
            "lm_head.weight",
        }
        self.assertEqual(set(plan.param_table(self.CFG)), expected)

    def test_no_bias_parameters_by_default(self):
        table = plan.param_table(self.CFG)
        self.assertFalse([k for k in table if k.endswith(".bias")])
        biased = replace(self.CFG, attention_bias=True, mlp_bias=True)
        biased_table = plan.param_table(biased)
        self.assertIn("model.layers.0.self_attn.q_proj.bias", biased_table)
        self.assertIn("model.layers.0.mlp.down_proj.bias", biased_table)
        self.assertGreater(plan.table_total(biased), plan.table_total(self.CFG))

    def test_shapes_are_the_expected_ones(self):
        table = plan.param_table(self.CFG)
        self.assertEqual(table["model.embed_tokens.weight"], (256, 16))
        self.assertEqual(table["lm_head.weight"], (256, 16))
        self.assertEqual(table["model.layers.0.self_attn.q_proj.weight"], (16, 16))
        # GQA: K and V are sized by the KV heads, not the query heads
        self.assertEqual(table["model.layers.0.self_attn.k_proj.weight"], (8, 16))
        self.assertEqual(table["model.layers.0.self_attn.o_proj.weight"], (16, 16))
        self.assertEqual(table["model.layers.0.mlp.gate_proj.weight"], (32, 16))
        self.assertEqual(table["model.layers.0.mlp.down_proj.weight"], (16, 32))
        self.assertEqual(table["model.norm.weight"], (16,))


class ConfigArithmetic(unittest.TestCase):
    def test_config_a_matches_the_spec_estimate(self):
        """§7.1 says "~37.9M"; this says exactly which 37.9M.

        The structural count is 8,388,608 embeddings + 10 × 2,949,120
        (attention + MLP) + 10 × 2 × 512 (the two RMSNorms per layer, which
        the spec's hand arithmetic does not itemise) + 512 (final norm)
        = 37,890,560, i.e. 37.9M to the precision the spec quotes. Pinning
        the exact integer means a config edit that changes any component
        fails here instead of quietly moving the model in the band.
        """
        counts = plan.counts(CONFIG_A)
        expected = (8_388_608                       # tied embeddings
                    + 10 * (786_432 + 2_162_688)    # attention + MLP per layer
                    + 10 * 2 * 512                  # two RMSNorms per layer
                    + 512)                          # final RMSNorm
        self.assertEqual(counts["total"], expected)
        self.assertEqual(counts["total"], 37_890_560)
        self.assertEqual(plan.table_total(CONFIG_A), counts["total"])
        self.assertLess(abs(counts["total"] / 1e6 - 37.9), 0.05,
                        "must agree with the spec's ~37.9M estimate")

    def test_configs_sit_inside_their_bands(self):
        self.assertTrue(30_000_000 <= plan.counts(CONFIG_A)["total"] <= 50_000_000)
        self.assertTrue(12_000_000 <= plan.counts(CONFIG_LITE)["total"] <= 22_000_000)
        self.assertTrue(1_000_000 <= plan.counts(CONFIG_SMOKE)["total"] <= 3_000_000)

    def test_kv_cache_matches_the_spec_claim(self):
        self.assertEqual(plan.kv_cache_per_token(CONFIG_A), 10 * 1024,
                         "§7.1: ~10 KB/token in fp16 for config A")
        self.assertEqual(plan.kv_cache_bytes(CONFIG_A, 1024), 10 * 1024 * 1024)
        self.assertEqual(plan.kv_cache_per_token(CONFIG_A, bytes_per_element=4),
                         20 * 1024, "fp32 doubles it")

    def test_tied_embeddings_are_counted_once(self):
        table = plan.param_table(CONFIG_A)
        self.assertIn("lm_head.weight", table)
        self.assertIn("model.embed_tokens.weight", table)
        counts = plan.counts(CONFIG_A)
        self.assertEqual(counts["output_head"], 0)
        untied = replace(CONFIG_A, tie_word_embeddings=False)
        self.assertEqual(plan.counts(untied)["total"],
                         counts["total"] + CONFIG_A.vocab_size * CONFIG_A.hidden_size)

    def test_ffn_ratio(self):
        self.assertEqual(ffn_size(512), 1536)   # 8/3 × 512 = 1365 → rounded to 1536
        self.assertEqual(ffn_size(384), 1024)
        self.assertEqual(ffn_size(192), 512)
        self.assertEqual(CONFIG_A.intermediate_size, 1408,
                         "config A's FFN width is stated in §7.1, not derived")

    def test_flops_estimate_is_sane(self):
        est = plan.flops_estimate(CONFIG_A, 1024)
        self.assertGreater(est["prefill_flops"], 2 * est["linear_params_used"] * 1024)
        self.assertGreater(est["decode_one_token_flops"], 0)
        longer = plan.flops_estimate(CONFIG_A, 2048)
        self.assertGreater(longer["prefill_flops"], 2 * est["prefill_flops"])


class ConfigValidation(unittest.TestCase):
    def base(self, **over):
        return {"vocab_size": 1024, "hidden_size": 64, "num_hidden_layers": 1,
                "num_attention_heads": 4, "num_key_value_heads": 2,
                "intermediate_size": 128, **over}

    def test_hidden_size_must_divide_into_heads(self):
        with self.assertRaises(ValueError) as ctx:
            ModelConfig(**self.base(hidden_size=65))
        self.assertIn("divisible", str(ctx.exception))

    def test_kv_heads_must_divide_query_heads(self):
        with self.assertRaises(ValueError) as ctx:
            ModelConfig(**self.base(num_attention_heads=4, num_key_value_heads=3))
        self.assertIn("GQA", str(ctx.exception))

    def test_head_dim_must_be_even_for_rope(self):
        with self.assertRaises(ValueError) as ctx:
            ModelConfig(**self.base(hidden_size=12, num_attention_heads=4,
                                    num_key_value_heads=2))
        self.assertIn("even", str(ctx.exception))

    def test_derived_properties(self):
        cfg = CONFIG_A
        self.assertEqual(cfg.head_dim, 64)
        self.assertEqual(cfg.n_rep, 2)
        self.assertEqual(cfg.q_dim, 512)
        self.assertEqual(cfg.kv_dim, 256)

    def test_hf_config_round_trip(self):
        hf = CONFIG_A.to_hf_config()
        self.assertEqual(hf["model_type"], "llama")
        self.assertEqual(hf["architectures"], ["LlamaForCausalLM"])
        self.assertEqual(hf["head_dim"], 64)
        self.assertTrue(hf["tie_word_embeddings"])
        restored = ModelConfig.from_hf(hf)
        self.assertEqual(restored.vocab_size, CONFIG_A.vocab_size)
        self.assertEqual(restored.hidden_size, CONFIG_A.hidden_size)
        self.assertEqual(restored.num_key_value_heads, CONFIG_A.num_key_value_heads)
        self.assertEqual(plan.counts(restored)["total"], plan.counts(CONFIG_A)["total"])

    def test_hf_config_rejects_inconsistent_head_dim(self):
        hf = CONFIG_A.to_hf_config()
        hf["head_dim"] = 128
        with self.assertRaises(ValueError):
            ModelConfig.from_hf(hf)


class GqaHeadMap(unittest.TestCase):
    def test_contiguous_groups(self):
        self.assertEqual(plan.gqa_head_map(6, 3), [0, 0, 1, 1, 2, 2])
        self.assertEqual(plan.gqa_head_map(8, 4), [0, 0, 1, 1, 2, 2, 3, 3])
        self.assertEqual(plan.gqa_head_map(6, 6), [0, 1, 2, 3, 4, 5])
        self.assertEqual(plan.gqa_head_map(6, 1), [0] * 6)

    def test_every_kv_head_is_used(self):
        for heads, kv in ((8, 4), (6, 3), (12, 4), (10, 5)):
            mapping = plan.gqa_head_map(heads, kv)
            self.assertEqual(len(mapping), heads)
            self.assertEqual(sorted(set(mapping)), list(range(kv)))
            counts = [mapping.count(i) for i in range(kv)]
            self.assertEqual(len(set(counts)), 1, "groups must be even")

    def test_mismatched_heads_raise(self):
        with self.assertRaises(ValueError):
            plan.gqa_head_map(5, 2)


class RopeMath(unittest.TestCase):
    def test_inverse_frequencies_decrease_and_start_at_one(self):
        inv = plan.rope_inv_freq(64, 10000.0)
        self.assertEqual(len(inv), 32)
        self.assertAlmostEqual(float(inv[0]), 1.0)
        self.assertTrue(np.all(np.diff(inv) < 0), "frequencies must decrease")

    def test_cache_shape_and_duplication(self):
        cos, sin = plan.rope_cache(64, 10000.0, 16)
        self.assertEqual(cos.shape, (16, 64))
        self.assertEqual(sin.shape, (16, 64))
        np.testing.assert_allclose(cos[:, :32], cos[:, 32:], atol=1e-6)
        np.testing.assert_allclose(sin[0, :], 0.0, atol=1e-6)
        np.testing.assert_allclose(cos[0, :], 1.0, atol=1e-6)

    def test_rope_is_a_rotation(self):
        """‖apply_rope(x)‖ == ‖x‖ for every pair, at every position.

        This is the property that makes RoPE positional rather than
        destructive: if a sign or the `rotate_half` split order were wrong,
        the norm would drift and the model would still train — just worse.
        """
        rng = np.random.default_rng(0)
        x = rng.normal(size=(2, 3, 5, 64))
        for position in (0, 1, 17, 63):
            cos, sin = plan.rope_cache(64, 10000.0, 64)
            out = plan.apply_rope(x, cos[position], sin[position])
            np.testing.assert_allclose(np.linalg.norm(out, axis=-1),
                                       np.linalg.norm(x, axis=-1), rtol=1e-9)

    def test_rotate_half_is_a_swap_with_a_sign_change(self):
        x = np.array([[1.0, 2.0, 3.0, 4.0]])
        np.testing.assert_array_equal(plan.rotate_half(x), [[-3.0, -4.0, 1.0, 2.0]])

    def test_position_zero_is_the_identity(self):
        rng = np.random.default_rng(1)
        x = rng.normal(size=(1, 2, 3, 8))
        cos, sin = plan.rope_cache(8, 10000.0, 4)
        np.testing.assert_allclose(plan.apply_rope(x, cos[0], sin[0]), x, atol=1e-12)


class ReferenceMath(unittest.TestCase):
    def test_rms_norm_matches_its_formula(self):
        x = np.array([[3.0, 4.0]], dtype=np.float32)
        w = np.ones(2, dtype=np.float32)
        out = plan.rms_norm(x, w, eps=0.0)
        expected = x / np.sqrt(np.mean(x ** 2))
        np.testing.assert_allclose(out, expected, rtol=1e-6)
        self.assertAlmostEqual(float(np.mean(out ** 2)), 1.0, places=6)

    def test_rms_norm_scales_with_the_weight(self):
        x = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
        w = np.array([2.0, 2.0, 2.0], dtype=np.float32)
        np.testing.assert_allclose(plan.rms_norm(x, w, 1e-5),
                                   2 * plan.rms_norm(x, np.ones(3, dtype=np.float32), 1e-5),
                                   rtol=1e-6)

    def test_silu(self):
        self.assertAlmostEqual(float(plan.silu(np.array([0.0]))[0]), 0.0)
        self.assertAlmostEqual(float(plan.silu(np.array([100.0]))[0]), 100.0, places=3)
        self.assertAlmostEqual(float(plan.silu(np.array([-100.0]))[0]), 0.0, places=3)


@unittest.skipUnless(HAS_TORCH, "torch is not installed — the module itself is "
                                "verified by inference/count_parameters.py and "
                                "train_smoke.py where torch exists")
class TorchModule(unittest.TestCase):
    def test_module_matches_the_schema_and_the_analytic_count(self):
        from ai.model.model import build

        model = build(CONFIG_SMOKE)
        info = model.assert_matches_schema()
        self.assertEqual(info["params"], plan.counts(CONFIG_SMOKE)["total"])
        self.assertEqual(model.param_count(), plan.counts(CONFIG_SMOKE)["total"])

    def test_forward_shapes_and_loss(self):
        import torch

        from ai.model.model import build

        model = build(CONFIG_SMOKE)
        ids = torch.randint(0, CONFIG_SMOKE.vocab_size, (2, 16))
        out = model(ids, labels=ids)
        self.assertEqual(out["logits"].shape, (2, 16, CONFIG_SMOKE.vocab_size))
        self.assertTrue(torch.isfinite(out["loss"]))
        self.assertGreater(float(out["loss"]), 6.0, "an untrained model should be near log(vocab)")

    def test_rope_matches_the_numpy_reference(self):
        import torch

        from ai.model.model import apply_rotary_pos_emb, repeat_kv

        rng = np.random.default_rng(3)
        x_np = rng.normal(size=(1, 2, 4, 8)).astype(np.float32)
        cos, sin = plan.rope_cache(8, 10000.0, 8)
        torch_out = apply_rotary_pos_emb(torch.from_numpy(x_np),
                                         torch.from_numpy(cos[3]).view(1, 1, 1, 8),
                                         torch.from_numpy(sin[3]).view(1, 1, 1, 8))
        np_out = plan.apply_rope(x_np, cos[3], sin[3])
        np.testing.assert_allclose(torch_out.numpy(), np_out, rtol=1e-5, atol=1e-6)

        kv = torch.from_numpy(rng.normal(size=(1, 2, 4, 8)).astype(np.float32))
        expanded = repeat_kv(kv, 2)
        self.assertEqual(expanded.shape, (1, 4, 4, 8))
        np.testing.assert_allclose(expanded[:, 0].numpy(), kv[:, 0].numpy())
        np.testing.assert_allclose(expanded[:, 1].numpy(), kv[:, 0].numpy())
        np.testing.assert_allclose(expanded[:, 2].numpy(), kv[:, 1].numpy())

    def test_generation_is_cached_and_stops(self):
        import torch

        from ai.model.model import build

        model = build(CONFIG_SMOKE)
        ids = torch.randint(0, CONFIG_SMOKE.vocab_size, (1, 4))
        eos = 2
        out = model.generate(ids, max_new_tokens=5, eos_token_id=eos)
        self.assertLessEqual(out.shape[1], 4 + 5)
        self.assertTrue(torch.equal(out[:, :4], ids))

    def test_position_overflow_raises_rather_than_clamping(self):
        import torch

        from ai.model.model import build

        model = build(CONFIG_SMOKE)
        too_long = torch.zeros((1, CONFIG_SMOKE.max_position_embeddings + 1), dtype=torch.long)
        with self.assertRaises(ValueError):
            model(too_long)


if __name__ == "__main__":
    unittest.main()
