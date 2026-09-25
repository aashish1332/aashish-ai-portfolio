"""inference/reference.py — a numpy forward pass, for the JS engine's parity test.

Three implementations of the same §7.1 architecture now exist:

1. `ai/model/model.py`   — torch, the graph that was trained (ground truth);
2. this file             — numpy, written from §7.1 independently;
3. `ai/engine/llama.mjs` — JavaScript, what a visitor actually runs.

P6 (§9.2) requires a *parity test* before anything is exported. One
implementation checked against itself proves nothing, so the test is a
triangle: numpy is checked against torch here (same ids → same logits), and
`tests/engine.test.mjs` checks JavaScript against numpy. A misreading of the
architecture has to be made twice, in two languages, to survive that.

Deliberately not reused from `ai/model/plan.py` beyond the four primitives it
already shares with the tokenizer's tests (rope_cache, apply_rope,
gqa_head_map, rms_norm, silu): a reference that imports the thing it is
supposed to check is not a reference.

No cache, no batching, no masks: one sequence, causal, float32, whole
sequence at once. Slow and obvious on purpose.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai.model import plan  # noqa: E402
from ai.model.config import ModelConfig  # noqa: E402

SECTION = "model.layers"


# ── weight plumbing ──────────────────────────────────────────────────
def torch_state_dict_to_numpy(state: dict) -> dict[str, np.ndarray]:
    """`{name: tensor}` → `{name: float32 ndarray}`, without importing torch
    when the caller already handed us numpy."""
    out = {}
    for name, tensor in state.items():
        if hasattr(tensor, "detach"):
            tensor = tensor.detach().cpu().float().numpy()
        out[name] = np.asarray(tensor, dtype=np.float32)
    return out


def q8_dequantise(q: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """Inverse of the exporter's per-row int8 quantization, bit for bit.

    The JS engine must reproduce *this* function (in `ai/engine/quant.mjs`),
    so it lives in one place per language and the two are compared on the
    same shard bytes rather than on a paraphrase of the format.
    """
    return q.astype(np.float32) * scales.astype(np.float32)[:, None]


def tie_head(weights: dict[str, np.ndarray], cfg: ModelConfig) -> np.ndarray:
    """The LM head. Tied models ship one matrix; the head is the embedding."""
    head = weights.get("lm_head.weight")
    embed = weights.get("model.embed_tokens.weight")
    if cfg.tie_word_embeddings:
        if embed is None:
            raise KeyError("tied embeddings without model.embed_tokens.weight")
        return embed
    if head is None:
        raise KeyError("untied model without lm_head.weight")
    return head


# ── the forward pass ─────────────────────────────────────────────────
def forward(weights: dict[str, np.ndarray], cfg: ModelConfig,
            ids: list[int] | np.ndarray) -> np.ndarray:
    """logits for every position: shape (T, vocab)."""
    ids = np.asarray(ids, dtype=np.int64)
    if ids.ndim != 1 or ids.size == 0:
        raise ValueError("forward() takes one non-empty sequence of ids")
    if int(ids.max()) >= cfg.vocab_size:
        raise ValueError(f"id {int(ids.max())} is outside the {cfg.vocab_size}-token vocab")
    t = int(ids.size)
    if t > cfg.max_position_embeddings:
        raise ValueError(f"{t} tokens exceeds max_position_embeddings "
                         f"{cfg.max_position_embeddings}")

    head_dim, n_heads, n_kv, n_rep = cfg.head_dim, cfg.num_attention_heads, \
        cfg.num_key_value_heads, cfg.n_rep
    scaling = head_dim ** -0.5
    cos, sin = plan.rope_cache(head_dim, cfg.rope_theta, max_position=t)

    x = weights["model.embed_tokens.weight"][ids].astype(np.float32)  # (T, d)

    # Causal mask, built once: True where a query may NOT look.
    blocked = ~np.tril(np.ones((t, t), dtype=bool))

    for layer in range(cfg.num_hidden_layers):
        p = f"{SECTION}.{layer}"
        h = plan.rms_norm(x, weights[f"{p}.input_layernorm.weight"], cfg.rms_norm_eps)

        q = h @ weights[f"{p}.self_attn.q_proj.weight"].T            # (T, n_heads*hd)
        k = h @ weights[f"{p}.self_attn.k_proj.weight"].T            # (T, n_kv*hd)
        v = h @ weights[f"{p}.self_attn.v_proj.weight"].T

        q = q.reshape(t, n_heads, head_dim)
        k = k.reshape(t, n_kv, head_dim)
        v = v.reshape(t, n_kv, head_dim)
        q = plan.apply_rope(q, cos[:, None, :], sin[:, None, :])
        k = plan.apply_rope(k, cos[:, None, :], sin[:, None, :])

        # GQA: query head h reads KV head h // n_rep (contiguous groups —
        # plan.gqa_head_map is the same map, asserted in the tests).
        k_rep = np.repeat(k, n_rep, axis=1)                          # (T, n_heads, hd)
        v_rep = np.repeat(v, n_rep, axis=1)

        scores = np.einsum("thd,shd->hts", q, k_rep) * scaling       # (heads, T, T)
        scores = np.where(blocked[None, :, :], -np.inf, scores)
        scores = scores - scores.max(axis=-1, keepdims=True)
        probs = np.exp(scores)
        probs = probs / probs.sum(axis=-1, keepdims=True)
        attn = np.einsum("hts,shd->thd", probs, v_rep).reshape(t, n_heads * head_dim)

        x = x + attn @ weights[f"{p}.self_attn.o_proj.weight"].T

        h2 = plan.rms_norm(x, weights[f"{p}.post_attention_layernorm.weight"], cfg.rms_norm_eps)
        gate = plan.silu(h2 @ weights[f"{p}.mlp.gate_proj.weight"].T)
        up = h2 @ weights[f"{p}.mlp.up_proj.weight"].T
        x = x + (gate * up) @ weights[f"{p}.mlp.down_proj.weight"].T

    x = plan.rms_norm(x, weights["model.norm.weight"], cfg.rms_norm_eps)
    return x @ tie_head(weights, cfg).T                              # (T, vocab)


def greedy(weights: dict[str, np.ndarray], cfg: ModelConfig, prompt_ids: list[int],
           max_new_tokens: int, stop_ids: set[int] | None = None) -> list[int]:
    """Greedy decode over the *full* sequence each step — no cache, so this
    is also the check that a cached decode (the JS engine uses one) is not
    quietly attending to the wrong positions."""
    stop_ids = stop_ids or set()
    ids = list(prompt_ids)
    out: list[int] = []
    for _ in range(max_new_tokens):
        logits = forward(weights, cfg, ids)[-1]
        nxt = int(np.argmax(logits))
        out.append(nxt)
        ids.append(nxt)
        if nxt in stop_ids:
            break
    return out


def logits_at(weights: dict[str, np.ndarray], cfg: ModelConfig, ids: list[int],
              positions: list[int] | None = None) -> dict:
    """A compact, comparable summary of a forward pass.

    Storing every logit for a fixture would be megabytes of float noise; the
    engine test needs the *shape* of the distribution (argmax and the top-k
    ordering) plus a few exact magnitudes to catch a scale error.
    """
    logits = forward(weights, cfg, ids)
    positions = positions if positions is not None else [len(ids) - 1]
    rows = []
    for pos in positions:
        row = logits[pos]
        order = np.argsort(-row)[:16]
        rows.append({
            "position": int(pos),
            "argmax": int(order[0]),
            "top": [{"id": int(i), "logit": float(row[i])} for i in order],
        })
    return {"positions": rows}
