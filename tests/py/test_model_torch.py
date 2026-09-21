"""tests/py/test_model_torch.py — the torch module itself (§7.1).

`test_model_schema.py`'s docstring has pointed at this file since P3, but the
file did not exist until now — which is exactly why the bug below reached the
§7.5 smoke test instead of being caught here.

Everything here needs torch, because `ai/model/model.py` imports it at module
level. Without torch the whole module skips and the schema tests still cover
the arithmetic.

Two regressions are pinned:

1. **The import died before step 1.** `_SDPA_KWARGS =
   set(inspect.signature(F.scaled_dot_product_attention).parameters)` raised
   ``ValueError: no signature found for builtin
   <built-in function scaled_dot_product_attention>`` on torch 2.14, where SDPA
   is a builtin. Feature detection now *uses* the kwarg on tiny tensors.
2. **The fallback was unreachable.** The attention forward passed
   ``enable_gqa=use_gqa`` unconditionally, so on a torch old enough to lack the
   kwarg the call raised ``TypeError`` — meaning the `repeat_kv` fallback the
   module documents could never actually run.

A third defect is pinned here because this is the first place it could be:
**a multi-token chunk appended to a KV cache attended to its own future.**
`generate()` decodes one token at a time, so P3 never fired it, and every
bounds check passed — the ids were legal and the shapes were right. See
`KvCacheDecoding.test_chunked_prefill_matches_a_full_forward`.
"""

from __future__ import annotations

import ast
import inspect
import sys
import unittest
import unittest.mock
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

try:
    import torch

    HAS_TORCH = True
except ImportError:  # pragma: no cover - exercised on machines without torch
    HAS_TORCH = False

from ai.model.config import CONFIG_SMOKE  # noqa: E402


@unittest.skipUnless(HAS_TORCH, "needs torch")
class ModelModuleImports(unittest.TestCase):
    """Regression 1: importing the module must not need an introspectable SDPA."""

    def test_module_imports(self):
        from ai.model import model  # noqa: F401

    def test_gqa_flag_is_a_bool(self):
        from ai.model import model

        self.assertIsInstance(model.HAS_NATIVE_GQA, bool)

    def test_detection_does_not_depend_on_signature_introspection(self):
        """The heart of regression 1.

        `inspect.signature` on a builtin raises ValueError, so the module must
        not use it as its detection mechanism. Asserted on the source rather
        than on behaviour, because behaviour cannot distinguish "worked" from
        "raised" on a torch where the signature *is* readable.

        The check walks the AST rather than grepping the text: the module's own
        docstring *explains* why `inspect.signature` is the wrong tool, and a
        substring search cannot tell that explanation apart from a call.
        """
        from ai.model import model

        tree = ast.parse(inspect.getsource(model))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names]
                self.assertNotIn("inspect", names,
                                 "the module imports inspect again — regression 1")
            if (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "signature"):
                self.fail("a call to .signature(...) is back in the module — regression 1")
        self.assertTrue(hasattr(model, "_probe_native_gqa"))

    def test_probe_is_honest_about_this_torch(self):
        """If the probe says True, the kernel must actually group the heads."""
        from ai.model import model

        if not model.HAS_NATIVE_GQA:
            self.skipTest("this torch has no native enable_gqa")

        q = torch.zeros(1, 4, 1, 8)
        kv = torch.zeros(1, 2, 1, 8)
        out = torch.nn.functional.scaled_dot_product_attention(q, kv, kv, enable_gqa=True)
        self.assertEqual(tuple(out.shape), (1, 4, 1, 8),
                         "probe reported native GQA but the kernel did not group heads")


@unittest.skipUnless(HAS_TORCH, "needs torch")
class GqaFallbackIsReachable(unittest.TestCase):
    """Regression 2: the `repeat_kv` fallback must run, not be dead code.

    The old attention forward passed ``enable_gqa=use_gqa`` unconditionally.
    When the probe was False that meant ``enable_gqa=False`` — still a kwarg
    the older torch does not define — so the call raised TypeError and the
    fallback the module documents could never execute.

    Behaviour on *this* torch cannot show that, because this torch has the
    kwarg. So SDPA is replaced with a stub that rejects it, which is what an
    old torch looks like from the caller's side.
    """

    def setUp(self):
        from ai.model import model

        self.model = model
        self.cfg = CONFIG_SMOKE
        self.attention = model.Attention(self.cfg)
        self.calls = 0

    def _forward_with_strict_sdpa(self):
        """Run one Attention forward with a torch that lacks `enable_gqa`."""
        model = self.model
        real = model.F.scaled_dot_product_attention

        def strict(*args, **kwargs):
            if "enable_gqa" in kwargs:
                raise TypeError(
                    "scaled_dot_product_attention() got an unexpected keyword "
                    "argument 'enable_gqa'")
            self.calls += 1
            return real(*args, **kwargs)

        cos = torch.zeros(1, 1, 4, self.cfg.head_dim)
        sin = torch.ones(1, 1, 4, self.cfg.head_dim)
        x = torch.randn(1, 4, self.cfg.hidden_size)

        with unittest.mock.patch.object(model, "HAS_NATIVE_GQA", False), \
                unittest.mock.patch.object(
                    model.F, "scaled_dot_product_attention", strict):
            return self.attention(x, cos, sin)

    def test_fallback_runs_when_the_kwarg_is_absent(self):
        out = self._forward_with_strict_sdpa()
        self.assertEqual(tuple(out.shape), (1, 4, self.cfg.hidden_size))
        self.assertEqual(self.calls, 1, "SDPA was never called — the test proved nothing")

    def test_fallback_grouping_matches_native_gqa(self):
        """`repeat_kv` and `enable_gqa` must be the same grouping, not just similar."""
        from ai.model import model

        if not model.HAS_NATIVE_GQA:
            self.skipTest("this torch has no native enable_gqa to compare against")

        torch.manual_seed(0)
        cos = torch.zeros(1, 1, 4, self.cfg.head_dim)
        sin = torch.ones(1, 1, 4, self.cfg.head_dim)
        x = torch.randn(1, 4, self.cfg.hidden_size)

        with unittest.mock.patch.object(model, "HAS_NATIVE_GQA", False):
            fallback = self.attention(x, cos, sin)
        native = self.attention(x, cos, sin)
        self.assertTrue(torch.allclose(fallback, native, atol=1e-5),
                        "repeat_kv and enable_gqa disagree — one of them groups wrongly")


@unittest.skipUnless(HAS_TORCH, "needs torch")
class ForwardContract(unittest.TestCase):
    """What every caller downstream (training, export, browser) relies on."""

    @classmethod
    def setUpClass(cls):
        from ai.model.model import build

        torch.manual_seed(0)
        cls.cfg = CONFIG_SMOKE
        cls.net = build(cls.cfg)
        cls.net.eval()
        cls.ids = torch.randint(1, cls.cfg.vocab_size, (2, 8))

    def test_forward_returns_logits_loss_and_hidden(self):
        with torch.no_grad():
            out = self.net(self.ids)
        self.assertEqual(set(out), {"logits", "loss", "hidden"})
        self.assertEqual(tuple(out["logits"].shape),
                         (2, 8, self.cfg.vocab_size))
        self.assertEqual(tuple(out["hidden"].shape), (2, 8, self.cfg.hidden_size))
        self.assertIsNone(out["loss"], "loss must be None without labels")

    def test_loss_is_finite_with_labels(self):
        with torch.no_grad():
            loss = self.net(self.ids, labels=self.ids)["loss"]
        self.assertEqual(loss.ndim, 0)
        self.assertTrue(torch.isfinite(loss))

    def test_masked_positions_do_not_affect_the_loss(self):
        """§7.4's assistant-only masking depends on ignore_index=-100.

        Comparing two masked runs for equality is **not** the property. `loss`
        is a cross-entropy *mean*, so dropping a term changes the denominator
        even when the mask is honoured perfectly — that mistake is what this
        test used to assert, and it failed against a correct implementation.

        The property that actually holds: the masked slot's *value* is never
        read, so the loss must equal the same restriction computed by hand, and
        that restriction must genuinely differ from the unmasked mean (else the
        assertion would pass with the mask doing nothing at all).
        """
        labels = self.ids.clone()

        def masked_at(*cols):
            lbl = labels.clone()
            for col in cols:
                lbl[:, col] = -100
            return lbl

        with torch.no_grad():
            shifted = self.net(self.ids)["logits"]
            unmasked = self.net(self.ids, labels=labels)["loss"]

        def restricted(lbl):
            """Re-derive the model's own shift, without reading the model's loss."""
            return torch.nn.functional.cross_entropy(
                shifted[:, :-1].float().reshape(-1, shifted.shape[-1]),
                lbl[:, 1:].reshape(-1),
                ignore_index=-100,
            )

        # Two different masked slots. Writing a *real* token into a masked slot
        # would un-mask it, so "the value is ignored" cannot be shown by varying
        # the value; it is shown by the model tracking *which* positions were
        # sentinelled. Cross-entropy is a mean over the remaining terms, so the
        # two restricted means differ — which is what makes this discriminating.
        single = restricted(masked_at(3))
        other = restricted(masked_at(5))
        self.assertFalse(torch.allclose(single, other),
                         "masking different slots gave the same loss — the test cannot "
                         "tell the slots apart, so it proves nothing")

        for cols, expected in (((3,), single), ((5,), other)):
            labels_masked = masked_at(*cols)
            with torch.no_grad():
                got = self.net(self.ids, labels=labels_masked)["loss"]
            self.assertTrue(torch.allclose(got, expected),
                            f"masking {cols}: model loss != the mean over the *unmasked* "
                            f"positions (ignore_index is not being honoured)")
            self.assertFalse(torch.allclose(got, unmasked),
                             f"masking {cols}: the loss did not move — the mask is inert")

    def test_position_past_the_context_raises_instead_of_degrading(self):
        """RoPE indices beyond `max_position_embeddings` were once reused silently."""
        small = replace(CONFIG_SMOKE, max_position_embeddings=4)
        from ai.model.model import build

        net = build(small)
        too_long = torch.randint(1, small.vocab_size, (1, 5))
        with self.assertRaises(ValueError) as ctx:
            with torch.no_grad():
                net(too_long)
        self.assertIn("max_position_embeddings", str(ctx.exception))


@unittest.skipUnless(HAS_TORCH, "needs torch")
class KvCacheDecoding(unittest.TestCase):
    """The cache is what makes generation linear; it must not change the answer."""

    @classmethod
    def setUpClass(cls):
        from ai.model.model import build

        torch.manual_seed(1)
        cls.cfg = CONFIG_SMOKE
        cls.net = build(cls.cfg)
        cls.net.eval()
        cls.ids = torch.randint(1, cls.cfg.vocab_size, (1, 6))

    def test_cached_decode_matches_a_full_forward(self):
        from ai.model.model import KVCache

        with torch.no_grad():
            full = self.net(self.ids)["logits"][:, -1, :]
            cache = KVCache.empty(self.cfg.num_hidden_layers)
            self.assertEqual(cache.length, 0)
            self.net(self.ids[:, :4], cache=cache, position_offset=0)
            self.assertEqual(cache.length, 4)
            step = self.net(self.ids[:, 4:], cache=cache, position_offset=4)
            self.assertEqual(cache.length, 6)
        self.assertEqual(tuple(step["logits"].shape), (1, 2, self.cfg.vocab_size))
        self.assertTrue(torch.allclose(full, step["logits"][:, -1, :], atol=1e-5),
                        "cached decoding diverged from the full forward pass")

    def test_chunked_prefill_matches_a_full_forward(self):
        """A *multi-token* chunk appended to a non-empty cache.

        `generate()` decodes one token at a time, so nothing in P3 exercised
        this and the bug stayed latent — but the answer it produces is wrong in
        a way no shape or bounds check can see. `is_causal` is aligned top-left
        by PyTorch, so for t new tokens over a longer cache it masks the wrong
        pairs: query row 0 of the chunk can attend to the chunk's own future,
        and every later layer then inherits the pollution. Correct masking here
        is bottom-right aligned, which has to be built explicitly.

        Asserted at *every* position, not just the last: the corruption starts
        at the first row of the chunk and spreads, so a final-position check
        alone can pass on a partially-wrong implementation.
        """
        from ai.model.model import KVCache

        splits = ((4, 4), (2, 3, 3), (1, 1, 1, 1, 1, 1))
        with torch.no_grad():
            full = self.net(self.ids)["logits"]
            for split in splits:
                cache = KVCache.empty(self.cfg.num_hidden_layers)
                chunks = []
                start = 0
                for size in split:
                    step = self.net(self.ids[:, start:start + size], cache=cache,
                                    position_offset=start)
                    chunks.append(step["logits"])
                    start += size
                got = torch.cat(chunks, dim=1)
                self.assertEqual(tuple(got.shape), tuple(full.shape))
                self.assertTrue(
                    torch.allclose(got, full, atol=1e-5),
                    f"prefill split {split} diverged from the full forward pass "
                    f"(max abs diff "
                    f"{(got - full).abs().max().item():.3e}) — a chunk is "
                    f"attending to its own future")

    def test_tied_embeddings_are_one_tensor_not_two(self):
        self.assertIs(self.net.lm_head.weight, self.net.model.embed_tokens.weight)
        unique = sum(p.numel() for p in self.net.parameters())
        self.assertEqual(unique, self.net.param_count())


@unittest.skipUnless(HAS_TORCH, "needs torch")
class MaterialisedSchema(unittest.TestCase):
    """`assert_matches_schema` is the §7.1 gate, and P6 reads this layout."""

    def test_smoke_module_matches_the_hf_llama_schema(self):
        from ai.model.model import build

        torch.manual_seed(0)
        net = build(CONFIG_SMOKE)
        result = net.assert_matches_schema()
        self.assertEqual(result["params"], net.param_count())
        self.assertEqual(result["params"], 1_820_352,
                         "the materialised count moved off the figure the smoke "
                         "run reports")
        self.assertEqual(result["keys"], len(net.state_dict()))

    def test_greedy_generation_is_deterministic_and_bounded(self):
        from ai.model.model import build

        torch.manual_seed(0)
        net = build(CONFIG_SMOKE)
        prompt = torch.randint(1, CONFIG_SMOKE.vocab_size, (1, 3))
        first = net.generate(prompt, max_new_tokens=8, eos_token_id=None)
        second = net.generate(prompt, max_new_tokens=8, eos_token_id=None)
        self.assertEqual(first.shape, (1, 11))
        self.assertTrue(torch.equal(first, second), "greedy decode is not deterministic")
        self.assertTrue(torch.equal(first[:, :3], prompt), "the prompt was rewritten")


if __name__ == "__main__":
    unittest.main()