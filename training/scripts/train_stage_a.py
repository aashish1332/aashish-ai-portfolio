"""training/scripts/train_stage_a.py — Stage A training (§7.3, P4).

    python -m training.scripts.train_stage_a \
        --config A --tokenizer ai/tokenizer/artifacts/stage-a-12k \
        --shards data/processed/stage_a/shards \
        --run-dir /kaggle/working/checkpoints/stage-a \
        --steps 20000 --batch 16 --block 1024 --grad-accum 4 --amp \
        --max-minutes 540 --resume auto --gate

This is `train_smoke.py`'s loop with Stage A's defaults, not a second
implementation: the only reason the two files exist is that a §7.5 smoke run
and a real Stage A run have different hyperparameters and different *scopes*
in their manifests, and inventing a second training loop is how a "verified
resume" stops being true of the thing you actually trained.

Differences from the smoke defaults, and why:

| | smoke (§7.5) | Stage A |
|---|---|---|
| config | 1–3M params, 4 layers | config A, 10 layers (~37.9M) |
| learning rate | 3e-3 (50 steps) | 3e-4 with a 200-step warmup |
| batch × block × accum | 4 × 128 × 1 (2K tokens/step) | 16 × 1024 × 4 (65K tokens/step) |
| eval/save | every 25/10 steps | every 250/250 steps |
| `--max-minutes` | — | set it: Kaggle sessions are time-boxed, and a clean stop writes a checkpoint |

`--amp` is fp16 (a T4 has no bf16, §7.5). Run the smoke test first: it is
cheap, and it fails fast on a corpus or tokenizer problem that would otherwise
surface 40 minutes into a real run.
"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from training.scripts.train_smoke import main as smoke_main  # noqa: E402

STAGE_A_DEFAULTS = {
    "--config": "A",
    "--tokenizer": "ai/tokenizer/artifacts/stage-a-12k",
    "--shards": "data/processed/stage_a/shards",
    "--run-dir": "training/checkpoints/stage-a",
    "--steps": "20000",
    "--batch": "16",
    "--block": "1024",
    "--grad-accum": "4",
    "--lr": "3e-4",
    "--warmup": "200",
    "--eval-every": "250",
    "--save-every": "250",
    "--eval-batches": "8",
    "--log-every": "25",
    "--amp": None,
    "--resume": "auto",
    "--scope": ("Stage A — general language from random init (§7.3): narrow, clean, "
                "conversational EN + Hindi + Hinglish + copy-from-context."),
}

def apply_defaults(argv: list[str]) -> list[str]:
    """Fill in Stage A's defaults, letting an explicit flag win.

    Order matters: `--amp` is a boolean, so it is inserted as a bare token, and
    a `--flag=value` spelling is treated as supplying that flag too.
    """
    supplied = {arg.split("=", 1)[0] for arg in argv if arg.startswith("--")}
    out: list[str] = []
    for flag, value in STAGE_A_DEFAULTS.items():
        if flag in supplied:
            continue
        if value is None:
            out.append(flag)
        else:
            out.extend([flag, value])
    return out + argv


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--help" in argv or "-h" in argv:
        return smoke_main(["--help"])
    return smoke_main(apply_defaults(argv))


if __name__ == "__main__":
    raise SystemExit(main())
