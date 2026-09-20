"""ai/model/plan.py — the model's arithmetic, with no framework attached.

Everything here answers a question that must be answerable *before* torch
exists on a machine (this machine, for one) or *while* training on Kaggle:

* What exactly are the parameters, by name and shape?  → `param_table`
* How many, and how do they divide across the model?    → `counts`
* How big is the KV cache at a given context?           → `kv_cache_bytes`
* How much compute is a prefill or a decode step?       → `flops_estimate`
* What are the RoPE frequencies and the GQA head map?   → `rope_*`, `gqa_head_map`

`model.py` imports the same functions rather than re-deriving them, so
"the parameter count printed by count_parameters.py" and "the parameter
count of the module that actually trains" cannot disagree by accident.
When torch *is* present, `inference/count_parameters.py` builds the real
module and asserts the two match exactly — one number, two derivations.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.model.config import ModelConfig  # noqa: E402


def param_table(cfg: ModelConfig) -> dict[str, tuple[int, ...]]:
    """`{HF Llama parameter name: shape}` in state-dict order.

    The names are the contract with llama.cpp's GGUF converter and with
    ORT/Transformers.js. A typo here is a silent export failure later, so
    `tests/py/test_model_schema.py` asserts this exact key set.
    """
    d, hd = cfg.hidden_size, cfg.head_dim
    q, kv, ffn = cfg.q_dim, cfg.kv_dim, cfg.intermediate_size

    table: dict[str, tuple[int, ...]] = {
        "model.embed_tokens.weight": (cfg.vocab_size, d),
    }
    for i in range(cfg.num_hidden_layers):
        p = f"model.layers.{i}"
        table[f"{p}.input_layernorm.weight"] = (d,)
        table[f"{p}.self_attn.q_proj.weight"] = (q, d)
        table[f"{p}.self_attn.k_proj.weight"] = (kv, d)
        table[f"{p}.self_attn.v_proj.weight"] = (kv, d)
        table[f"{p}.self_attn.o_proj.weight"] = (d, q)
        if cfg.attention_bias:
            table[f"{p}.self_attn.q_proj.bias"] = (q,)
            table[f"{p}.self_attn.k_proj.bias"] = (kv,)
            table[f"{p}.self_attn.v_proj.bias"] = (kv,)
            table[f"{p}.self_attn.o_proj.bias"] = (d,)
        table[f"{p}.post_attention_layernorm.weight"] = (d,)
        table[f"{p}.mlp.gate_proj.weight"] = (ffn, d)
        table[f"{p}.mlp.up_proj.weight"] = (ffn, d)
        table[f"{p}.mlp.down_proj.weight"] = (d, ffn)
        if cfg.mlp_bias:
            table[f"{p}.mlp.gate_proj.bias"] = (ffn,)
            table[f"{p}.mlp.up_proj.bias"] = (ffn,)
            table[f"{p}.mlp.down_proj.bias"] = (d,)
    table["model.norm.weight"] = (d,)
    # Tied to embed_tokens (§7.1). Present in the state dict — HF's
    # LlamaForCausalLM ships it too — but its parameters are the embedding's.
    table["lm_head.weight"] = (cfg.vocab_size, d)
    return table


def size(shape: tuple[int, ...]) -> int:
    return int(math.prod(shape)) if shape else 1


def counts(cfg: ModelConfig) -> dict[str, int]:
    """Parameter count by component, with tied weights counted once."""
    per_layer_attn = size((cfg.q_dim, cfg.hidden_size))
    per_layer_attn += 2 * size((cfg.kv_dim, cfg.hidden_size))
    per_layer_attn += size((cfg.hidden_size, cfg.q_dim))
    if cfg.attention_bias:
        per_layer_attn += cfg.q_dim + 2 * cfg.kv_dim + cfg.hidden_size

    per_layer_mlp = 3 * size((cfg.intermediate_size, cfg.hidden_size))
    if cfg.mlp_bias:
        per_layer_mlp += 2 * cfg.intermediate_size + cfg.hidden_size

    norms = cfg.num_hidden_layers * 2 * cfg.hidden_size + cfg.hidden_size
    embeddings = size((cfg.vocab_size, cfg.hidden_size))
    head = 0 if cfg.tie_word_embeddings else size((cfg.vocab_size, cfg.hidden_size))

    return {
        "embeddings": embeddings,
        "attention": per_layer_attn * cfg.num_hidden_layers,
        "mlp": per_layer_mlp * cfg.num_hidden_layers,
        "norms": norms,
        "output_head": head,
        "per_layer": per_layer_attn + per_layer_mlp + 2 * cfg.hidden_size,
        "total": (embeddings + head
                  + cfg.num_hidden_layers * (per_layer_attn + per_layer_mlp + 2 * cfg.hidden_size)
                  + cfg.hidden_size),
    }


def table_total(cfg: ModelConfig) -> int:
    """Total from `param_table`, counting tied weights once.

    Kept separate from `counts` so the two are cross-checked against each
    other (a mismatch means one of the formulas drifted).
    """
    total = 0
    for name, shape in param_table(cfg).items():
        if name == "lm_head.weight" and cfg.tie_word_embeddings:
            continue
        total += size(shape)
    return total


def kv_cache_bytes(cfg: ModelConfig, tokens: int, bytes_per_element: int = 2) -> int:
    """KV cache geometry: layers × kv heads × head_dim × (K and V) × bytes.

    §7.1 quotes ~10 KB/token for config A in fp16 — this is where that
    number is asserted rather than believed.
    """
    per_token = (cfg.num_hidden_layers * cfg.num_key_value_heads * cfg.head_dim
                 * 2 * bytes_per_element)
    return per_token * tokens


def kv_cache_per_token(cfg: ModelConfig, bytes_per_element: int = 2) -> int:
    return kv_cache_bytes(cfg, 1, bytes_per_element)


def flops_estimate(cfg: ModelConfig, tokens: int, context: int | None = None) -> dict:
    """Rough forward-pass FLOPs (2 × MACs), no kernel overhead.

    Prefill: linear work over every token plus the quadratic attention
    term. Decode: one token, attention over `context` cached keys.
    Labelled an estimate everywhere it is printed — it is the right
    quantity for a *budget* argument, not a benchmark.
    """
    linear_params = max(table_total(cfg) - size((cfg.vocab_size, cfg.hidden_size)), 1)
    linear = 2 * linear_params * tokens
    attn = 4 * cfg.num_hidden_layers * cfg.num_attention_heads * cfg.head_dim * tokens * tokens
    ctx = cfg.max_position_embeddings if context is None else context
    return {
        "tokens": tokens,
        "prefill_flops": linear + attn,
        "decode_one_token_flops": (2 * linear_params
                                   + 4 * cfg.num_hidden_layers * cfg.num_attention_heads
                                   * cfg.head_dim * ctx),
        "linear_params_used": linear_params,
    }


# ── RoPE ─────────────────────────────────────────────────────────────
def rope_inv_freq(head_dim: int, theta: float = 10000.0) -> np.ndarray:
    """1 / theta^(2i/dim) for i in [0, dim/2) — the Llama frequency ladder."""
    return 1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float64) / head_dim))


def rope_cache(head_dim: int, theta: float = 10000.0,
               max_position: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    """(cos, sin) each of shape (max_position, head_dim), Llama-style.

    The frequencies are duplicated (`cat(freqs, freqs)`) so the rotation
    can be applied to the *whole* head vector with `rotate_half` instead of
    splitting it — the layout llama.cpp and HF both assume.
    """
    inv = rope_inv_freq(head_dim, theta)
    freqs = np.outer(np.arange(max_position, dtype=np.float64), inv)
    emb = np.concatenate([freqs, freqs], axis=-1)
    return np.cos(emb), np.sin(emb)


def rotate_half(x: np.ndarray) -> np.ndarray:
    """`[-x2, x1]` split down the middle — the numpy view of the torch op."""
    half = x.shape[-1] // 2
    return np.concatenate([-x[..., half:], x[..., :half]], axis=-1)


def apply_rope(x: np.ndarray, cos: np.ndarray, sin: np.ndarray) -> np.ndarray:
    """Rotary embedding for verification (the model uses the torch twin)."""
    return x * cos + rotate_half(x) * sin


# ── GQA ──────────────────────────────────────────────────────────────
def gqa_head_map(num_heads: int, num_kv_heads: int) -> list[int]:
    """KV head index per query head: [0,0,1,1,2,2] for 6 heads / 3 KV.

    Contiguous grouping, which is what `repeat_interleave` gives and what
    the GGUF/ONNX conversion of a GQA model expects. Getting this wrong is
    the classic silent-quality bug: shapes still line up.
    """
    if num_heads % num_kv_heads:
        raise ValueError("num_heads must be a multiple of num_kv_heads")
    rep = num_heads // num_kv_heads
    return [i // rep for i in range(num_heads)]


def rms_norm(x: np.ndarray, weight: np.ndarray, eps: float = 1e-5) -> np.ndarray:
    """RMSNorm in float32 — the reference the torch module is checked against."""
    x = x.astype(np.float32)
    variance = np.mean(x * x, axis=-1, keepdims=True)
    return (x / np.sqrt(variance + eps)) * weight.astype(np.float32)


def silu(x: np.ndarray) -> np.ndarray:
    return x / (1.0 + np.exp(-x))
