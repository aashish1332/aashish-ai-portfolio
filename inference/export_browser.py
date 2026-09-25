"""inference/export_browser.py — checkpoint → what a visitor's browser loads (§9.2).

    # the shipping artifact, from a trained checkpoint
    python inference/export_browser.py --run-dir training/checkpoints/stage-b \
        --out ai/model/export/aashish-ai-v1

    # a reproducible fixture the JS engine's parity test commits
    python inference/export_browser.py --random-init \
        --out tests/fixtures/tiny-model \
        --reference-out tests/fixtures/engine_reference.json

What "export" means here, precisely:

* **Quantization is per-row int8 (Q8-0-style).** For a weight row `w`,
  `scale = max|w| / 127` and `q = round(w / scale)`. Rows are the output
  dimension, which is what keeps a badly-scaled channel from flattening a
  neighbour. Embeddings and the LM head get the same treatment; norms stay
  float32 (127 levels for a 512-wide RMSNorm scale is not a trade, it is a
  bug). §9.2 accepts INT4-groupwise only if accuracy drops ≤ 2 points — that
  measurement is printed, not assumed, and only INT8 ships until it exists.
* **A tensor is one contiguous block**: int8 data, then one float32 scale per
  row. Both halves are addressable through plain byte offsets, so the browser
  never parses a format, it slices two typed arrays.
* **Shards ≤ 8 MB** (§6.5), SHA-256 per shard, immutable filenames.
* Sizes are **measured** (written files, gzip, and brotli when the module is
  present) — §9.2 forbids quoting a size you did not measure.

The `--reference-out` fixture is what makes the JavaScript engine trustworthy:
`inference/reference.py`'s numpy forward pass runs on the *exported, quantized*
weights and stores argmax plus the top-16 logits. `tests/engine.test.mjs`
requires the JS engine to reproduce them. torch and numpy are cross-checked
here too, so a misreading of §7.1 has to happen twice to survive.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai.model.config import ModelConfig  # noqa: E402
from ai.tokenizer import spec  # noqa: E402
from inference import reference  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "aashish-llm/v1"
DEFAULT_TOKENIZER = ROOT / "ai/tokenizer/artifacts/seed-1k"
MAX_SHARD_BYTES = 8 * 1024 * 1024

# The prompts the parity fixture is pinned on. Short, one per language, and
# one that is deliberately a raw fragment: a fixture made only of clean
# sentences can hide an offset bug that shows up on an odd sequence length.
REFERENCE_PROMPTS = [
    "<|sys|> You are Aashish's AI portfolio assistant.<|ctx|> [person.name] Aashish"
    "<|user|> What is your name?<|asst|>",
    "<|sys|> rules<|ctx|> [skill.python] Python\n[skill.react] React"
    "<|user|> आपके स्किल्स क्या हैं?<|asst|>",
    "<|sys|> niyam<|ctx|> [project.grocery] Smart Grocery List Generator"
    "<|user|> uske projects batao<|asst|>",
    "Aashish",
    "<|abstain|>",
]

# A tiny config for the committed fixture: big enough to exercise GQA
# (4 heads / 2 KV), RoPE, SwiGLU and the tied head; small enough to commit.
TINY = dict(vocab_size=1024, hidden_size=64, num_hidden_layers=2,
            num_attention_heads=4, num_key_value_heads=2,
            intermediate_size=128, max_position_embeddings=256, name="tiny-fixture")


# ── quantization ─────────────────────────────────────────────────────
def quantize_rows(w: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """(int8 codes, per-row float32 scales, worst-case absolute error).

    A row of exact zeros is legal and must not divide by zero — its scale is
    stored as 0 and the codes stay 0, so dequantisation returns zeros rather
    than NaN.
    """
    w = np.asarray(w, dtype=np.float32)
    if w.ndim != 2:
        raise ValueError("quantize_rows takes a 2-D matrix")
    peak = np.abs(w).max(axis=1)
    scales = np.where(peak > 0, peak / 127.0, 1.0).astype(np.float32)
    codes = np.clip(np.rint(w / scales[:, None]), -127, 127).astype(np.int8)
    err = float(np.abs(reference.q8_dequantise(codes, scales) - w).max())
    return codes, scales, err


def quantize_tensor(name: str, w: np.ndarray) -> tuple[bytes, dict, float]:
    w = np.asarray(w, dtype=np.float32)
    if w.ndim == 2:
        codes, scales, err = quantize_rows(w)
        block = codes.tobytes() + scales.tobytes()
        meta = {"name": name, "dtype": "q8", "shape": [int(w.shape[0]), int(w.shape[1])],
                "rows": int(w.shape[0]), "cols": int(w.shape[1]), "error": err}
        return block, meta, err
    if w.ndim == 1:
        block = w.tobytes()
        meta = {"name": name, "dtype": "f32", "shape": [int(w.shape[0])],
                "rows": 1, "cols": int(w.shape[0]), "error": 0.0}
        return block, meta, 0.0
    raise ValueError(f"{name}: unsupported rank {w.ndim}")


def pad(block: bytes) -> bytes:
    """Every block starts 4-byte aligned, because the scale half of a q8
    tensor is read as a Float32Array and JS requires that alignment — a
    misaligned view throws at construction, so padding is cheaper than a
    copy at load time."""
    return block + b"\x00" * (-len(block) % 4)


# ── shards and manifest ──────────────────────────────────────────────
def write_export(state: dict, cfg: ModelConfig, out_dir: Path,
                 tokenizer_dir: Path, source: dict) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = reference.torch_state_dict_to_numpy(state)

    if cfg.tie_word_embeddings and "lm_head.weight" in weights:
        embed, head = weights["model.embed_tokens.weight"], weights["lm_head.weight"]
        # The trained graph ties them; a mismatch here means the checkpoint
        # was written by something other than the training loop.
        tie_gap = float(np.abs(embed - head).max())
        weights.pop("lm_head.weight")
    else:
        tie_gap = None

    # Shipping order: embedding first (the loader can start dequantising the
    # biggest tensor while the rest is still arriving), then layers, then norm.
    names = ["model.embed_tokens.weight"]
    for i in range(cfg.num_hidden_layers):
        p = f"model.layers.{i}"
        names += [f"{p}.input_layernorm.weight",
                  f"{p}.self_attn.q_proj.weight", f"{p}.self_attn.k_proj.weight",
                  f"{p}.self_attn.v_proj.weight", f"{p}.self_attn.o_proj.weight",
                  f"{p}.post_attention_layernorm.weight",
                  f"{p}.mlp.gate_proj.weight", f"{p}.mlp.up_proj.weight",
                  f"{p}.mlp.down_proj.weight"]
    names += ["model.norm.weight"]
    if not cfg.tie_word_embeddings:
        names.append("lm_head.weight")

    missing = [n for n in names if n not in weights]
    if missing:
        raise KeyError(f"checkpoint is missing {missing[:4]}"
                       f"{' …' if len(missing) > 4 else ''}")

    tensors, shards = [], []
    buffers: list[bytes] = []
    current = bytearray()
    worst_error = 0.0
    for name in names:
        block, meta, err = quantize_tensor(name, weights[name])
        worst_error = max(worst_error, err)
        block = pad(block)
        if current and len(current) + len(block) > MAX_SHARD_BYTES:
            buffers.append(bytes(current))
            current = bytearray()
        meta.update({"shard": len(buffers), "offset": len(current), "bytes": len(block)})
        current += block
        tensors.append(meta)
    if current:
        buffers.append(bytes(current))

    for index, raw in enumerate(buffers):
        name = f"model-{index:05d}.bin"
        (out_dir / name).write_bytes(raw)
        shards.append({"name": name, "bytes": len(raw),
                       "sha256": hashlib.sha256(raw).hexdigest()})

    total = sum(t["bytes"] for t in tensors)
    packed = b"".join(buffers)
    quant_bytes = sum(t["bytes"] for t in tensors if t["dtype"] == "q8")
    f32_equivalent = 4 * sum(int(np.prod(weights[n].shape)) for n in names)
    f16_equivalent = 2 * sum(int(np.prod(weights[n].shape)) for n in names)

    tokenizer_file = tokenizer_dir / "tokenizer.json"
    tok_raw = tokenizer_file.read_bytes()
    (out_dir / "tokenizer.json").write_bytes(tok_raw)
    tok_meta_path = tokenizer_dir / "meta.json"
    tok_meta = (json.loads(tok_meta_path.read_text(encoding="utf-8"))
                if tok_meta_path.exists() else {})

    manifest = {
        "format": FORMAT,
        "modelVersion": source.get("modelVersion") or "aashish-ai-1",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "config": cfg.to_hf_config(),
        "tiedWordEmbeddings": bool(cfg.tie_word_embeddings),
        "quantization": {
            "weights": "q8-row", "embeddings": "q8-row", "norms": "f32",
            "rowScaleBytes": 4,
            "worstRowError": round(worst_error, 6),
        },
        "tensors": tensors,
        "shards": shards,
        "tokenizer": {
            "file": "tokenizer.json", "bytes": len(tok_raw),
            "sha256": hashlib.sha256(tok_raw).hexdigest(),
            "version": tok_meta.get("tokenizer_version"),
            "vocabSize": tok_meta.get("vocab_size"),
            "specialTokens": list(spec.SPECIAL_TOKENS),
        },
        "sizes": {
            "weightsBytes": total,
            "shardBytes": len(packed),
            "q8Bytes": quant_bytes,
            "fp32EquivalentBytes": f32_equivalent,
            "fp16EquivalentBytes": f16_equivalent,
            "gzipBytes": len(gzip.compress(packed, 6)),
            "tokenizerBytes": len(tok_raw),
        },
        "source": {**source, "tieGap": tie_gap},
    }
    try:  # brotli is optional on this machine; a missing module is not a lie,
        import brotli  # noqa: F401  # it is an absent measurement
        manifest["sizes"]["brotliBytes"] = len(brotli.compress(packed, quality=9))
        manifest["sizes"]["brotliMeasured"] = True
    except ImportError:
        manifest["sizes"]["brotliBytes"] = None
        manifest["sizes"]["brotliMeasured"] = False

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


# ── torch cross-check ────────────────────────────────────────────────
def torch_cross_check(state: dict, cfg: ModelConfig, ids: list[int]) -> dict:
    """numpy vs torch on the same ids. NOT TESTED if torch is absent."""
    try:
        import torch
        from ai.model.model import LlamaForCausalLM
    except ImportError as exc:
        return {"status": "NOT TESTED", "reason": f"{type(exc).__name__}: {exc}"}

    model = LlamaForCausalLM(cfg)
    # `state` may be numpy (the fixture path) or torch tensors (a checkpoint);
    # `load_state_dict` only accepts the latter.
    model.load_state_dict(
        {k: torch.as_tensor(np.asarray(v)) for k, v in state.items()}, strict=True)
    model.eval()
    with torch.no_grad():
        out = model(torch.tensor([ids], dtype=torch.long))
        torch_logits = out["logits"][0].float().numpy()
    np_logits = reference.forward(reference.torch_state_dict_to_numpy(state), cfg, ids)
    diff = float(np.abs(torch_logits - np_logits).max())
    agree = bool(int(torch_logits[-1].argmax()) == int(np_logits[-1].argmax()))
    return {"status": "PASS" if diff < 1e-3 and agree else "FAIL",
            "maxAbsDiff": diff, "argmaxAgree": agree,
            "ids": ids}


def load_exported_weights(export_dir: Path, manifest: dict) -> dict[str, np.ndarray]:
    """Dequantise the shards we just wrote, byte for byte.

    The engine runs on int8 codes; if the reference ran on the *float*
    checkpoint instead, the gate would be comparing two different models and
    the only thing it could measure is how much quantization moved the
    logits. Every shard is hash-checked on the way in, so the numbers below
    are provably the numbers the browser will load.
    """
    raw_by_name: dict[str, bytes] = {}
    for shard in manifest["shards"]:
        raw = (export_dir / shard["name"]).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != shard["sha256"]:
            raise ValueError(f"{shard['name']} hashes to {digest[:12]}, "
                             f"manifest says {shard['sha256'][:12]}")
        raw_by_name[shard["name"]] = raw

    weights: dict[str, np.ndarray] = {}
    for tensor in manifest["tensors"]:
        raw = raw_by_name[manifest["shards"][tensor["shard"]]["name"]]
        start = int(tensor["offset"])
        rows, cols = int(tensor["rows"]), int(tensor["cols"])
        if tensor["dtype"] == "q8":
            codes = np.frombuffer(raw, dtype=np.int8, count=rows * cols,
                                  offset=start).reshape(rows, cols)
            scales = np.frombuffer(raw, dtype="<f4", count=rows,
                                   offset=start + rows * cols)
            weights[tensor["name"]] = reference.q8_dequantise(codes, scales)
        elif tensor["dtype"] == "f32":
            weights[tensor["name"]] = np.frombuffer(
                raw, dtype="<f4", count=cols, offset=start).copy()
        else:
            raise ValueError(f"{tensor['name']}: unreadable dtype {tensor['dtype']}")
    return weights


def reference_fixture(state: dict, cfg: ModelConfig, tokenizer_dir: Path,
                      export_dir: Path, manifest: dict) -> dict:
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(tokenizer_dir / "tokenizer.json"))
    stop_ids = {tok.token_to_id("<|end|>"), tok.token_to_id("<|asst|>")}
    stop_ids.discard(None)

    # The reference runs on the *exported, quantized* weights (§9.2) — not on
    # the float checkpoint they came from. Any other choice measures the
    # quantizer rather than the engine.
    weights = load_exported_weights(export_dir, manifest)

    cases = []
    for text in REFERENCE_PROMPTS:
        ids = tok.encode(text).ids
        # Every position, not just the last one. Prefill is where an offset or
        # mask bug hides: the last position attends to everything, so it is
        # the one position that looks correct when the rest is wrong.
        cases.append({
            "promptText": text,
            "promptIds": ids,
            "logits": reference.logits_at(weights, cfg, ids, list(range(len(ids)))),
            "stopIds": sorted(stop_ids),
        })

    return {
        "modelDir": str(export_dir.relative_to(ROOT)).replace("\\", "/"),
        "format": FORMAT,
        "quantized": True,
        "referenceWeights": "exported q8 shards (dequantised)",
        # `logit` is the tolerance the JS gate applies to the top-16
        # magnitudes. The gate that matters is the *ordering* (argmax and the
        # top-16 sequence), which `verify-engine.mjs` asserts exactly; this
        # only has to absorb float32 accumulation order, since both sides now
        # read the same int8 codes.
        "tolerance": {"logit": 0.02,
                      "note": ("top-16 logits, absolute; ordering is compared "
                               "exactly. Both sides read the same int8 codes, so "
                               "this only has to cover float32 accumulation "
                               "order — a real architecture bug lands far outside "
                               "it.")},
        "torchCheck": torch_cross_check(state, cfg, cases[0]["promptIds"]),
        "cases": cases,
    }


# ── CLI ──────────────────────────────────────────────────────────────
def random_state(cfg: ModelConfig, seed: int) -> dict:
    """A seeded random model. Used only for the committed parity fixture: a
    forward pass can be verified without training anything, and a random
    model is reproducible in a way a checkpoint is not."""
    rng = np.random.default_rng(seed)
    scale = cfg.initializer_range
    state: dict[str, np.ndarray] = {}

    def n(*shape):
        return (rng.standard_normal(shape) * scale).astype(np.float32)

    d, ffn = cfg.hidden_size, cfg.intermediate_size
    state["model.embed_tokens.weight"] = n(cfg.vocab_size, d)
    for i in range(cfg.num_hidden_layers):
        p = f"model.layers.{i}"
        state[f"{p}.input_layernorm.weight"] = np.ones(d, dtype=np.float32)
        state[f"{p}.post_attention_layernorm.weight"] = np.ones(d, dtype=np.float32)
        state[f"{p}.self_attn.q_proj.weight"] = n(cfg.q_dim, d)
        state[f"{p}.self_attn.k_proj.weight"] = n(cfg.kv_dim, d)
        state[f"{p}.self_attn.v_proj.weight"] = n(cfg.kv_dim, d)
        state[f"{p}.self_attn.o_proj.weight"] = n(d, cfg.q_dim)
        state[f"{p}.mlp.gate_proj.weight"] = n(ffn, d)
        state[f"{p}.mlp.up_proj.weight"] = n(ffn, d)
        state[f"{p}.mlp.down_proj.weight"] = n(d, ffn)
    state["model.norm.weight"] = np.ones(d, dtype=np.float32)
    if cfg.tie_word_embeddings:
        state["lm_head.weight"] = state["model.embed_tokens.weight"]
    return state


def checkpoint_provenance(run_dir: Path, which: str, payload: dict,
                          file: Path) -> dict:
    """What a *published* manifest may say about where its weights came from.

    Deliberately content, not a path. `training/checkpoints` is a dev-only
    tree that `tools/build.mjs` refuses to ship, and it is right to: a path in
    a public manifest tells a visitor where the repo keeps its data and still
    says nothing verifiable about the bytes. A step number, a commit and the
    checkpoint's SHA-256 do — and a hash cannot be re-pointed at different
    weights the way a directory name can.

    The keys are flat strings on purpose: `tools/build.mjs` scans every
    shipped file for dev-tree paths, so provenance that names a directory is a
    build failure, not a style question.
    """
    provenance = {
        "run": run_dir.name,
        "which": which,
        "step": int(payload.get("step", 0)),
        "checkpointSha256": hashlib.sha256(file.read_bytes()).hexdigest(),
    }
    saved_at = payload.get("saved_at")
    if saved_at:  # same ISO-8601 convention as manifest.createdAt
        provenance["savedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                              time.gmtime(float(saved_at)))
    if payload.get("git_commit"):
        provenance["gitCommit"] = payload["git_commit"]
    return provenance


def load_checkpoint(run_dir: Path, which: str) -> tuple[dict, ModelConfig, dict]:
    """(weights, config, provenance) for `which` inside `run_dir`."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from training.scripts import checkpoint as ckpt

    manager = ckpt.CheckpointManager(run_dir)
    payload = manager.load(which)
    state = payload["model"]
    if hasattr(state, "state_dict"):
        state = state.state_dict()
    cfg = ModelConfig.from_hf(payload["config"])
    return state, cfg, checkpoint_provenance(run_dir, which, payload,
                                             manager.path(which))


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252; our progress lines use → and Δ.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run-dir", help="checkpoint run directory")
    ap.add_argument("--which", default="latest")
    ap.add_argument("--random-init", action="store_true",
                    help="export a seeded random model instead of a checkpoint")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokenizer", default=str(DEFAULT_TOKENIZER))
    ap.add_argument("--reference-out", help="write the JS parity fixture here")
    ap.add_argument("--model-version", default=None)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args(argv)

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    tokenizer_dir = Path(args.tokenizer)
    if not tokenizer_dir.is_absolute():
        tokenizer_dir = ROOT / tokenizer_dir

    if args.random_init:
        cfg = ModelConfig(**TINY)
        state = random_state(cfg, args.seed)
        source = {"kind": "random-init", "seed": args.seed,
                  "modelVersion": args.model_version or "aashish-ai-fixture",
                  "note": ("seeded random weights — this export exists to verify the "
                           "forward pass, not to answer questions")}
        print(f"random init: {cfg.name} vocab={cfg.vocab_size} d={cfg.hidden_size} "
              f"L={cfg.num_hidden_layers} heads={cfg.num_attention_heads}/"
              f"{cfg.num_key_value_heads} ffn={cfg.intermediate_size} seed={args.seed}")
    elif args.run_dir:
        run_dir = Path(args.run_dir)
        if not run_dir.is_absolute():
            run_dir = ROOT / run_dir
        state, cfg, provenance = load_checkpoint(run_dir, args.which)
        source = {"kind": "checkpoint", **provenance}
        if args.model_version:
            source["modelVersion"] = args.model_version
        print(f"checkpoint: {args.run_dir} ({args.which}) — vocab={cfg.vocab_size} "
              f"d={cfg.hidden_size} L={cfg.num_hidden_layers} step={provenance['step']}")
    else:
        ap.error("pass --run-dir or --random-init")

    manifest = write_export(state, cfg, out_dir, tokenizer_dir, source)
    sizes = manifest["sizes"]
    print(f"exported {len(manifest["tensors"])} tensors → {len(manifest["shards"])} shard(s)")
    print(f"  weights  {sizes["weightsBytes"]:>10,} B  (q8; fp32 would be "
          f"{sizes["fp32EquivalentBytes"]:,} B, fp16 {sizes["fp16EquivalentBytes"]:,} B)")
    print(f"  gzip     {sizes["gzipBytes"]:>10,} B  "
          f"brotli {'%d B' % sizes["brotliBytes"] if sizes["brotliMeasured"] else 'NOT TESTED'}")
    print(f"  tokenizer {sizes["tokenizerBytes"]:>9,} B  vocab "
          f"{manifest["tokenizer"]["vocabSize"]}")
    print(f"  worst per-row q8 error {manifest["quantization"]["worstRowError"]:.6f}")
    if manifest["source"].get("tieGap") is not None:
        print(f"  tied-embedding/head gap {manifest["source"]["tieGap"]:.3g}")

    if args.reference_out:
        fixture = reference_fixture(state, cfg, tokenizer_dir, out_dir, manifest)
        ref_path = Path(args.reference_out)
        if not ref_path.is_absolute():
            ref_path = ROOT / ref_path
        ref_path.parent.mkdir(parents=True, exist_ok=True)
        ref_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
        check = fixture["torchCheck"]
        print(f"  torch↔numpy cross-check: {check['status']}"
              + (f" (max |Δ| {check['maxAbsDiff']:.2e})" if check["status"] != "NOT TESTED" else ""))
        print(f"  parity fixture: {ref_path.relative_to(ROOT)} "
              f"({len(fixture['cases'])} prompts)")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(manifest, indent=2) + "\n",
                                       encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
