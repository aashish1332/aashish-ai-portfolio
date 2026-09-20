"""ai/model/model.py — the model, written from scratch (§7.1).

Decoder-only, pre-norm RMSNorm, RoPE, SwiGLU, GQA, tied embeddings,
causal attention. Every tensor name is the HF Llama name, because the
same checkpoint has to convert to GGUF and ONNX in P6 without a custom
runtime — see `plan.param_table`, which this module asserts against.

Notes that matter for this size of model:

* **SDPA, not FlashAttention.** §7.5: a T4 has no FlashAttention-2, and
  PyTorch's scaled_dot_product_attention is available everywhere and picks
  the best kernel it can. We never import `flash_attn`.
* **GQA by `repeat_interleave`.** Identical grouping to `plan.gqa_head_map`,
  verified in tests; `enable_gqa` is used when the installed torch has it.
* **RoPE in fp32.** The frequency table is computed in float64/32 and cast
  to the activation dtype — computing it in fp16 is the classic way to
  lose long-range positions.
* The KV cache is tiny at this scale (§7.1: ~10 KB/token fp16), so the
  implementation is deliberately simple: a list of per-layer (k, v).

Importing this module requires torch. Everything that must work without
it (config, parameter count, the schema) lives in `config.py` / `plan.py`.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import inspect

import torch
import torch.nn as nn
import torch.nn.functional as F

# `enable_gqa` landed in torch 2.5. Detected from the real signature rather
# than a version string, and falling back to `repeat_kv` — which is the
# same grouping, just with the memory the expansion costs.
_SDPA_KWARGS = set(inspect.signature(F.scaled_dot_product_attention).parameters)
HAS_NATIVE_GQA = "enable_gqa" in _SDPA_KWARGS

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.model import plan  # noqa: E402
from ai.model.config import ModelConfig  # noqa: E402


class RMSNorm(nn.Module):
    """Pre-norm RMSNorm — no mean subtraction, no bias (Llama)."""

    def __init__(self, hidden_size: int, eps: float = 1e-5):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        input_dtype = x.dtype
        x = x.float()
        variance = x.pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(variance + self.eps)
        return (self.weight * x.to(input_dtype))


class RotaryEmbedding(nn.Module):
    """RoPE, using `plan.rope_cache` so torch and numpy share one formula."""

    def __init__(self, head_dim: int, theta: float, max_position: int = 8192):
        super().__init__()
        cos, sin = plan.rope_cache(head_dim, theta, max_position)
        self.register_buffer("cos", torch.from_numpy(cos).float(), persistent=False)
        self.register_buffer("sin", torch.from_numpy(sin).float(), persistent=False)
        self.head_dim = head_dim

    def forward(self, x: torch.Tensor, position_ids: torch.Tensor):
        # position_ids: [B, T] → cos/sin [B, T, head_dim]
        cos = self.cos[position_ids].to(x.dtype)
        sin = self.sin[position_ids].to(x.dtype)
        return cos.unsqueeze(1), sin.unsqueeze(1)  # broadcast over heads


def apply_rotary_pos_emb(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """The torch twin of `plan.apply_rope`."""
    half = x.shape[-1] // 2
    rotated = torch.cat((-x[..., half:], x[..., :half]), dim=-1)
    return (x * cos) + (rotated * sin)


def repeat_kv(x: torch.Tensor, n_rep: int) -> torch.Tensor:
    """[B, kv_heads, T, hd] → [B, kv_heads*n_rep, T, hd], contiguous groups."""
    if n_rep == 1:
        return x
    b, kv, t, hd = x.shape
    return x[:, :, None, :, :].expand(b, kv, n_rep, t, hd).reshape(b, kv * n_rep, t, hd)


@dataclass
class KVCache:
    """Per-layer (k, v) for cached decoding. Offsets are explicit."""

    layers: list

    @classmethod
    def empty(cls, num_layers: int) -> "KVCache":
        return cls(layers=[None] * num_layers)

    @property
    def length(self) -> int:
        for entry in self.layers:
            if entry is not None:
                return entry[0].shape[-2]
        return 0

    def update(self, layer: int, k: torch.Tensor, v: torch.Tensor):
        if self.layers[layer] is not None:
            past_k, past_v = self.layers[layer]
            k = torch.cat([past_k, k], dim=-2)
            v = torch.cat([past_v, v], dim=-2)
        self.layers[layer] = (k, v)
        return k, v


class Attention(nn.Module):
    """Causal self-attention with GQA and an optional KV cache."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.num_heads = cfg.num_attention_heads
        self.num_kv_heads = cfg.num_key_value_heads
        self.n_rep = cfg.n_rep
        self.head_dim = cfg.head_dim
        self.scaling = self.head_dim ** -0.5

        self.q_proj = nn.Linear(cfg.hidden_size, cfg.q_dim, bias=cfg.attention_bias)
        self.k_proj = nn.Linear(cfg.hidden_size, cfg.kv_dim, bias=cfg.attention_bias)
        self.v_proj = nn.Linear(cfg.hidden_size, cfg.kv_dim, bias=cfg.attention_bias)
        self.o_proj = nn.Linear(cfg.q_dim, cfg.hidden_size, bias=cfg.attention_bias)

    def forward(self, x, cos, sin, cache: KVCache | None = None, layer_idx: int = 0,
                attention_mask: torch.Tensor | None = None):
        b, t, _ = x.shape
        q = self.q_proj(x).view(b, t, self.num_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(b, t, self.num_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(b, t, self.num_kv_heads, self.head_dim).transpose(1, 2)

        q = apply_rotary_pos_emb(q, cos, sin)
        k = apply_rotary_pos_emb(k, cos, sin)

        if cache is not None:
            k, v = cache.update(layer_idx, k, v)

        kv_len = k.shape[-2]
        use_gqa = self.n_rep > 1 and HAS_NATIVE_GQA
        if not use_gqa:
            k = repeat_kv(k, self.n_rep)
            v = repeat_kv(v, self.n_rep)

        if attention_mask is not None:
            out = F.scaled_dot_product_attention(
                q, k, v, attn_mask=attention_mask, scale=self.scaling,
                enable_gqa=use_gqa)
        else:
            # A single query token against a cache is always fully visible;
            # anything longer is strictly causal.
            out = F.scaled_dot_product_attention(
                q, k, v, is_causal=(t > 1 and t == kv_len), scale=self.scaling,
                enable_gqa=use_gqa)
        out = out.transpose(1, 2).reshape(b, t, self.num_heads * self.head_dim)
        return self.o_proj(out)


class MLP(nn.Module):
    """SwiGLU: down(silu(gate(x)) * up(x))."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.gate_proj = nn.Linear(cfg.hidden_size, cfg.intermediate_size, bias=cfg.mlp_bias)
        self.up_proj = nn.Linear(cfg.hidden_size, cfg.intermediate_size, bias=cfg.mlp_bias)
        self.down_proj = nn.Linear(cfg.intermediate_size, cfg.hidden_size, bias=cfg.mlp_bias)

    def forward(self, x):
        return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))


class DecoderLayer(nn.Module):
    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.self_attn = Attention(cfg)
        self.mlp = MLP(cfg)
        self.input_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.post_attention_layernorm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)

    def forward(self, x, cos, sin, cache=None, layer_idx=0, attention_mask=None):
        h = x + self.self_attn(self.input_layernorm(x), cos, sin, cache, layer_idx, attention_mask)
        return h + self.mlp(self.post_attention_layernorm(h))


class LlamaModel(nn.Module):
    """Embeddings + decoder stack + final norm (no LM head)."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.cfg = cfg
        self.embed_tokens = nn.Embedding(cfg.vocab_size, cfg.hidden_size)
        self.layers = nn.ModuleList([DecoderLayer(cfg) for _ in range(cfg.num_hidden_layers)])
        self.norm = RMSNorm(cfg.hidden_size, cfg.rms_norm_eps)
        self.rotary = RotaryEmbedding(cfg.head_dim, cfg.rope_theta,
                                      cfg.max_position_embeddings)

    def forward(self, input_ids, cache=None, position_offset: int = 0,
                attention_mask=None):
        b, t = input_ids.shape
        x = self.embed_tokens(input_ids)
        positions = torch.arange(position_offset, position_offset + t,
                                 device=input_ids.device).unsqueeze(0).expand(b, t)
        if int(positions.max()) >= self.cfg.max_position_embeddings:
            raise ValueError(
                f"sequence reaches position {int(positions.max())} but RoPE is built for "
                f"max_position_embeddings={self.cfg.max_position_embeddings}; silently "
                f"reusing the last position would degrade attention without failing")
        cos, sin = self.rotary(x, positions)
        for i, layer in enumerate(self.layers):
            x = layer(x, cos, sin, cache, i, attention_mask)
        return self.norm(x)


class LlamaForCausalLM(nn.Module):
    """The training/inference module. `state_dict()` keys match HF Llama."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.cfg = cfg
        self.model = LlamaModel(cfg)
        self.lm_head = nn.Linear(cfg.hidden_size, cfg.vocab_size, bias=False)
        if cfg.tie_word_embeddings:
            self.lm_head.weight = self.model.embed_tokens.weight
        self.apply(self._init_weights)

    def _init_weights(self, module: nn.Module) -> None:
        """`initializer_range` normal, biases zero — Llama's own scheme."""
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=self.cfg.initializer_range)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=self.cfg.initializer_range)

    def get_input_embeddings(self):
        return self.model.embed_tokens

    def set_input_embeddings(self, value):
        self.model.embed_tokens = value

    def forward(self, input_ids, labels=None, cache=None, position_offset: int = 0,
                attention_mask=None):
        hidden = self.model(input_ids, cache=cache, position_offset=position_offset,
                            attention_mask=attention_mask)
        logits = self.lm_head(hidden)
        loss = None
        if labels is not None:
            # Shift inside the model so every caller gets the same objective.
            # ignore_index=-100 is what §7.4's assistant-only loss masking uses.
            # float32 cross-entropy only here: upcasting *all* logits would
            # double the LM head's memory (16384 vocab × T × B) for nothing.
            loss = F.cross_entropy(
                logits[:, :-1].float().reshape(-1, logits.shape[-1]),
                labels[:, 1:].reshape(-1),
                ignore_index=-100,
            )
        return {"logits": logits, "loss": loss, "hidden": hidden}

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def assert_matches_schema(self) -> dict:
        """state_dict names+shapes vs `plan.param_table` — the export contract.

        Tied weights are expected at both names (`model.embed_tokens.weight`
        and `lm_head.weight`) because that is what HF emits; the *count* is
        taken once.
        """
        table = plan.param_table(self.cfg)
        actual = {k: tuple(v.shape) for k, v in self.state_dict().items()}
        missing = sorted(set(table) - set(actual))
        extra = sorted(set(actual) - set(table))
        mismatched = {k: (table[k], actual[k]) for k in set(table) & set(actual)
                      if table[k] != actual[k]}
        if missing or extra or mismatched:
            raise AssertionError(
                f"state_dict does not match the HF Llama schema:\n"
                f"  missing:    {missing[:5]}\n  unexpected: {extra[:5]}\n"
                f"  mismatched: {list(mismatched.items())[:5]}")
        return {"keys": len(actual), "params": plan.table_total(self.cfg)}

    @torch.no_grad()
    def generate(self, input_ids: torch.Tensor, max_new_tokens: int = 64,
                 eos_token_id: int | None = None, temperature: float = 0.0,
                 top_p: float = 0.9, generator: torch.Generator | None = None):
        """Greedy by default (§7.4: greedy or T ≤ 0.3). Cached, so it is linear."""
        self.eval()
        cache = KVCache.empty(self.cfg.num_hidden_layers)
        out = input_ids
        for step in range(max_new_tokens):
            step_ids = out if step == 0 else out[:, -1:]
            result = self(step_ids, cache=cache, position_offset=cache.length)
            logits = result["logits"][:, -1, :].float()
            if temperature <= 0:
                next_id = logits.argmax(dim=-1, keepdim=True)
            else:
                probs = F.softmax(logits / temperature, dim=-1)
                sorted_probs, sorted_idx = torch.sort(probs, descending=True, dim=-1)
                cumulative = torch.cumsum(sorted_probs, dim=-1)
                cutoff = cumulative - sorted_probs > top_p
                sorted_probs[cutoff] = 0.0
                sorted_probs = sorted_probs / sorted_probs.sum(-1, keepdim=True)
                pick = torch.multinomial(sorted_probs, 1, generator=generator)
                next_id = sorted_idx.gather(-1, pick)
            out = torch.cat([out, next_id], dim=-1)
            if eos_token_id is not None and int(next_id[0, 0]) == eos_token_id:
                break
        return out


def build(cfg: ModelConfig, device: str | torch.device = "cpu") -> LlamaForCausalLM:
    model = LlamaForCausalLM(cfg)
    model.to(device)
    return model
