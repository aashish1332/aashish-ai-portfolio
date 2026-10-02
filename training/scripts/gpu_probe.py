"""training/scripts/gpu_probe.py — will *this* config fit, and how fast is it?

    python -m training.scripts.gpu_probe --config A \
        --tokenizer ai/tokenizer/artifacts/stage-a-16k \
        --shards data/processed/stage_a/shards \
        --batch 8 --block 1024 --grad-accum 8 --steps 5

Why this exists (measured, 2026-10-02, Kaggle T4):

The first Stage A run died at step 1 with `torch.OutOfMemoryError` after
allocating 12.84 GiB of the T4's 14.56 GiB. The §7.5 smoke run before it had
passed — but the smoke run trains a **4,769,472-parameter, 4-layer, ctx-256**
model at batch 4 x block 128. It proves the training loop works. It says
nothing about whether a **37,890,560-parameter, 10-layer, ctx-1024** model fits
in the same card, because nothing in the smoke run scales with the thing that
ran out of memory.

That is the shape of the bug this script removes: the check that ran could not
fail for the reason the run needed checking. So the real config is now measured
directly, at the real batch settings, for a handful of steps. It costs about a
minute and answers both questions that matter:

* **peak memory** — and therefore whether `--batch 16` OOMs, before 48 minutes
  of downloading and sharding is spent finding out;
* **tokens/sec for *this* model** — which §7.3 requires before the token
  budget is decided, and which a smaller model's throughput cannot stand in for.

`estimate_budget.py --from-run` reads this JSON. It refuses a measurement taken
on a different parameter count, so a probe of the wrong config cannot silently
become a budget for this one.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import dataset  # noqa: E402
from ai.model import plan  # noqa: E402
from ai.tokenizer import spec  # noqa: E402
from training.scripts.train_smoke import _load_tokenizer, make_scaler, resolve_config  # noqa: E402

# Report at most this many steps, however many were asked for: this is a probe,
# not a run, and the log travels back to a notebook cell.
MAX_REPORTED_STEPS = 10


def probe(args) -> dict:
    import numpy as np
    import torch

    from ai.model.model import build

    tokenizer, meta = _load_tokenizer(args.tokenizer)
    checks = spec.assert_tokenizer_contract(tokenizer, spec.load_kb())
    shards = dataset.ShardSet.load(args.shards)
    shards.assert_matches_tokenizer(meta)
    cfg = resolve_config(args.config, meta["vocab_size"])
    counts = plan.counts(cfg)

    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SystemExit("--device cuda but torch.cuda.is_available() is False")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    model = build(cfg, device)
    actual = model.param_count()
    if actual != counts["total"]:
        raise SystemExit(f"param mismatch: analytic {counts['total']} vs module {actual}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95),
                                  weight_decay=0.1)
    scaler = make_scaler(device.type, bool(args.amp) and device.type == "cuda")
    batcher = dataset.TokenBatcher(shards, split="train", block=args.block,
                                   batch=args.batch, seed=args.seed)

    total_bytes = None
    if device.type == "cuda":
        total_bytes = torch.cuda.get_device_properties(device).total_memory
        # Reset the high-water marks so the numbers below are this probe's, not
        # whatever a previous cell left allocated on the same card.
        torch.cuda.reset_peak_memory_stats(device)
        torch.cuda.empty_cache()

    model.train()
    steps = []
    oom = None
    started = time.time()
    try:
        for step in range(args.steps):
            xs, ys = batcher.next_batch()
            x = torch.tensor(xs, device=device)
            y = torch.tensor(ys, device=device)
            tick = time.time()
            with torch.autocast(device_type=device.type, dtype=torch.float16,
                                enabled=bool(args.amp) and device.type == "cuda"):
                loss = model(x, labels=y)["loss"] / args.grad_accum
            scaler.scale(loss).backward()
            if (step + 1) % args.grad_accum == 0:
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
            value = float(loss.detach()) * args.grad_accum
            steps.append({"step": step + 1, "loss": round(value, 4),
                          "seconds": round(time.time() - tick, 4)})
            if device.type == "cuda":
                torch.cuda.synchronize(device)
    except torch.cuda.OutOfMemoryError as exc:
        oom = str(exc).splitlines()[0]

    seconds = time.time() - started
    tokens = len(steps) * args.block * args.batch

    peak_alloc = peak_reserved = None
    if device.type == "cuda" and steps:
        peak_alloc = torch.cuda.max_memory_allocated(device)
        peak_reserved = torch.cuda.max_memory_reserved(device)

    result = {
        "config": args.config,
        "params": counts["total"],
        "tokenizer_version": meta["tokenizer_version"],
        "block": args.block,
        "batch": args.batch,
        "grad_accum": args.grad_accum,
        "steps_requested": args.steps,
        "steps_completed": len(steps),
        "tokens_per_step": args.block * args.batch * args.grad_accum,
        "amp": bool(args.amp) and device.type == "cuda",
        "seconds": round(seconds, 3),
        "tokens_per_second": round(tokens / seconds, 3) if seconds > 0 else 0.0,
        "peak_allocated_bytes": peak_alloc,
        "peak_reserved_bytes": peak_reserved,
        "device_total_bytes": total_bytes,
        "oom": oom,
    }
    report(result, steps, cfg)
    return result


def _gb(value) -> str:
    return "—" if value is None else f"{value / 1024 ** 3:.2f} GiB"


def report(result: dict, steps: list[dict], cfg) -> None:
    print(f"\n{cfg.summary()}")
    print(f"  parameters        {result['params']:,} ({result['params'] / 1e6:.2f}M)")
    print(f"  micro-batch       {result['batch']} x {result['block']}"
          f" = {result['batch'] * result['block']:,} tokens")
    print(f"  grad-accum        {result['grad_accum']}"
          f"  -> {result['tokens_per_step']:,} tokens per learning update")

    if result["oom"]:
        print(f"\n  DOES NOT FIT      {result['oom']}")
        print(f"  peak              allocated {_gb(result['peak_allocated_bytes'])}"
              f" of {_gb(result['device_total_bytes'])}")
        print("  next              halve --batch and double --grad-accum to hold the "
              "learning update constant, then re-probe")
        return

    if not steps:
        print("\n  no steps completed — nothing to report")
        return

    for row in steps[:MAX_REPORTED_STEPS]:
        print(f"  step {row['step']:>3}  loss {row['loss']:>8.4f}  {row['seconds']:>6.3f}s")
    if len(steps) > MAX_REPORTED_STEPS:
        print(f"  ... (+{len(steps) - MAX_REPORTED_STEPS} more steps)")

    print(f"\n  steps completed   {result['steps_completed']}/{result['steps_requested']}"
          f" in {result['seconds']:.1f}s")
    print(f"  throughput        {result['tokens_per_second']:,.0f} tokens/s"
          f"  <- this model's, measured on this device")
    print(f"  peak memory       allocated {_gb(result['peak_allocated_bytes'])}"
          f" · reserved {_gb(result['peak_reserved_bytes'])}"
          f" of {_gb(result['device_total_bytes'])}")
    if result["peak_reserved_bytes"] and result["device_total_bytes"]:
        margin = 1 - result["peak_reserved_bytes"] / result["device_total_bytes"]
        print(f"  headroom          {margin:.0%}")
    print("  fits              yes — this is the config that was measured, at these "
          "settings")


def build_parser() -> argparse.ArgumentParser:
    """The flag surface, separate from `main`.

    Same split as `train_smoke.py`: the defaults here are the settings Stage A
    trains at, and they have to be readable by something other than a person —
    a default that silently drifts from the training command produces a green
    probe of a run that is not happening.
    """
    ap = argparse.ArgumentParser(description="Does this config fit, and how fast is it?")
    ap.add_argument("--config", default="A", choices=["smoke", "A", "lite", "local"])
    ap.add_argument("--tokenizer", default="ai/tokenizer/artifacts/stage-a-16k")
    ap.add_argument("--shards", default="data/processed/stage_a/shards")
    # 8 x 1024 x 8 — the micro-batch halved to fit the T4, grad-accum raised to
    # hold the learning update at 65,536 tokens.
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--block", type=int, default=1024)
    ap.add_argument("--grad-accum", type=int, default=8)
    ap.add_argument("--steps", type=int, default=5)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--amp", action="store_true", help="fp16 AMP (CUDA only; T4 has no bf16)")
    ap.add_argument("--device", default=None)
    ap.add_argument("--json", default=None, help="write the probe result here")
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)

    if args.device is None:
        try:
            import torch

            args.device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            args.device = "cpu"

    result = probe(args)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 1 if result["oom"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
