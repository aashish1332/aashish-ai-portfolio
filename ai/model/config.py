"""ai/model/config.py — model configs, in HF Llama vocabulary (§7.1).

Field names are the Hugging Face names (`hidden_size`, `num_hidden_layers`,
`num_key_value_heads`, …) *on purpose*: §7.1 requires tensor naming and
config to be compatible with the HF Llama layout so the trained model
exports to GGUF (llama.cpp / wllama) and ONNX without a custom runtime.
Renaming them later would be the most expensive kind of churn — P6's
export path consumes exactly these keys.

The configs:

* **A**     — the §7.1 starting config (~37.9M params by arithmetic).
* **lite**  — the §7.1 contingency (~17M), only if T1 budgets fail.
* **smoke** — the §7.5 local smoke config (1–3M), CPU, ~50 steps. It is
  a *pipeline test*, never a quality result.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

# Llama's own FFN ratio, snapped up to a multiple of `multiple_of`. Used
# only to derive `intermediate_size` when a config does not state it.
FFN_RATIO = 8 / 3
FFN_MULTIPLE = 256


@dataclass(frozen=True)
class ModelConfig:
    """A decoder-only Llama-shaped transformer."""

    vocab_size: int
    hidden_size: int
    num_hidden_layers: int
    num_attention_heads: int
    num_key_value_heads: int
    intermediate_size: int
    max_position_embeddings: int = 1024
    rms_norm_eps: float = 1e-5
    rope_theta: float = 10000.0
    tie_word_embeddings: bool = True
    attention_bias: bool = False
    mlp_bias: bool = False
    initializer_range: float = 0.02
    name: str = "config"
    notes: str = field(default="", compare=False)

    # ── derived values ───────────────────────────────────────────────
    @property
    def head_dim(self) -> int:
        return self.hidden_size // self.num_attention_heads

    @property
    def n_rep(self) -> int:
        """How many query heads share each KV head (GQA's grouping)."""
        return self.num_attention_heads // self.num_key_value_heads

    @property
    def q_dim(self) -> int:
        return self.num_attention_heads * self.head_dim

    @property
    def kv_dim(self) -> int:
        return self.num_key_value_heads * self.head_dim

    def __post_init__(self) -> None:
        if self.hidden_size % self.num_attention_heads:
            raise ValueError(
                f"hidden_size {self.hidden_size} is not divisible by "
                f"num_attention_heads {self.num_attention_heads} — head_dim "
                f"must be an integer for RoPE and SDPA")
        if self.num_attention_heads % self.num_key_value_heads:
            raise ValueError(
                f"num_attention_heads {self.num_attention_heads} is not a "
                f"multiple of num_key_value_heads {self.num_key_value_heads} — "
                f"GQA needs whole groups")
        if self.head_dim % 2:
            raise ValueError(f"head_dim {self.head_dim} must be even for RoPE")
        if self.vocab_size < 256:
            raise ValueError("vocab_size below the 256 byte-alphabet floor is impossible")

    # ── export / persistence ─────────────────────────────────────────
    def to_hf_config(self) -> dict:
        """HF `LlamaConfig`-shaped dict (what P6's exporters read)."""
        return {
            "model_type": "llama",
            "architectures": ["LlamaForCausalLM"],
            "vocab_size": self.vocab_size,
            "hidden_size": self.hidden_size,
            "intermediate_size": self.intermediate_size,
            "num_hidden_layers": self.num_hidden_layers,
            "num_attention_heads": self.num_attention_heads,
            "num_key_value_heads": self.num_key_value_heads,
            "head_dim": self.head_dim,
            "hidden_act": "silu",
            "max_position_embeddings": self.max_position_embeddings,
            "rms_norm_eps": self.rms_norm_eps,
            "rope_theta": self.rope_theta,
            "rope_scaling": None,
            "attention_bias": self.attention_bias,
            "mlp_bias": self.mlp_bias,
            "tie_word_embeddings": self.tie_word_embeddings,
            "initializer_range": self.initializer_range,
            "attention_dropout": 0.0,
            "use_cache": True,
        }

    def to_json(self, path: Path | str) -> None:
        Path(path).write_text(
            json.dumps({"config": asdict(self), "hf": self.to_hf_config()},
                       ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def from_json(cls, path: Path | str) -> "ModelConfig":
        return cls(**json.loads(Path(path).read_text(encoding="utf-8"))["config"])

    @classmethod
    def from_hf(cls, hf: dict) -> "ModelConfig":
        """Rebuild from an HF-shaped dict (round-trip / export check)."""
        head_dim = hf.get("head_dim")
        hidden = hf["hidden_size"]
        heads = hf["num_attention_heads"]
        if head_dim and head_dim * heads != hidden:
            raise ValueError("head_dim does not reconstruct hidden_size")
        return cls(
            vocab_size=hf["vocab_size"], hidden_size=hidden,
            num_hidden_layers=hf["num_hidden_layers"],
            num_attention_heads=heads,
            num_key_value_heads=hf["num_key_value_heads"],
            intermediate_size=hf["intermediate_size"],
            max_position_embeddings=hf.get("max_position_embeddings", 1024),
            rms_norm_eps=hf.get("rms_norm_eps", 1e-5),
            rope_theta=hf.get("rope_theta", 10000.0),
            tie_word_embeddings=hf.get("tie_word_embeddings", True),
            attention_bias=hf.get("attention_bias", False),
            mlp_bias=hf.get("mlp_bias", False),
            initializer_range=hf.get("initializer_range", 0.02),
        )

    def summary(self) -> str:
        return (f"{self.name}: vocab={self.vocab_size:,} d={self.hidden_size} "
                f"L={self.num_hidden_layers} heads={self.num_attention_heads}"
                f"/{self.num_key_value_heads} head_dim={self.head_dim} "
                f"ffn={self.intermediate_size:,} ctx={self.max_position_embeddings} "
                f"tied={self.tie_word_embeddings}")


def ffn_size(hidden_size: int, multiple_of: int = FFN_MULTIPLE) -> int:
    """Llama's SwiGLU hidden size: 8d/3 rounded up to a nice multiple."""
    raw = int(FFN_RATIO * hidden_size)
    return int(multiple_of * ((raw + multiple_of - 1) // multiple_of))


# ── The configs ──────────────────────────────────────────────────────
CONFIG_A = ModelConfig(
    name="A",
    vocab_size=16384, hidden_size=512, num_hidden_layers=10,
    num_attention_heads=8, num_key_value_heads=4,
    intermediate_size=1408, max_position_embeddings=1024,
    tie_word_embeddings=True,
    notes="§7.1 starting config. Arithmetic estimate ~37.9M; confirmed by "
          "inference/count_parameters.py.",
)

CONFIG_LITE = ModelConfig(
    name="lite",
    vocab_size=12288, hidden_size=384, num_hidden_layers=8,
    num_attention_heads=6, num_key_value_heads=3,
    intermediate_size=1024, max_position_embeddings=768,
    tie_word_embeddings=True,
    notes="§7.1 contingency (~17M), only if the T1 latency/memory budgets fail. "
          "Still scratch-trained — the teacher, if one is used, is our own A.",
)

CONFIG_SMOKE = ModelConfig(
    name="smoke",
    vocab_size=1024, hidden_size=192, num_hidden_layers=4,
    num_attention_heads=6, num_key_value_heads=3,
    intermediate_size=512, max_position_embeddings=256,
    tie_word_embeddings=True,
    notes="§7.5 local smoke config (1–3M params, CPU, ~50 steps). Verifies the "
          "pipeline, resume, export and browser load. Never a quality result.",
)

CONFIG_LOCAL = ModelConfig(
    name="local",
    vocab_size=1024, hidden_size=256, num_hidden_layers=6,
    num_attention_heads=8, num_key_value_heads=4,
    intermediate_size=768, max_position_embeddings=512,
    tie_word_embeddings=True,
    notes="The largest §7.1-shaped model this laptop (R1: i5-6300U, no GPU) trains "
          "for real: 4,984,064 params at the measured ~850 tok/s of the CPU loop, so a "
          "run finishes in tens of minutes instead of days. Same architecture and "
          "same tokenizer as config A, so it exercises the whole export/engine "
          "path; it is NOT the shipping quality target — that is Stage A + B at "
          "config A on a GPU (§16 P4-P5).",
)

CONFIGS = {"A": CONFIG_A, "lite": CONFIG_LITE, "smoke": CONFIG_SMOKE,
           "local": CONFIG_LOCAL}


def smoke_config(vocab_size: int | None = None) -> ModelConfig:
    """Smoke config, sized to the tokenizer actually trained."""
    if vocab_size is None:
        return CONFIG_SMOKE
    return ModelConfig(**{**asdict(CONFIG_SMOKE), "vocab_size": vocab_size})
