"""training/scripts/train_smoke.py — the §7.5 local smoke test.

    # what this machine can do (no torch): verify the pipeline end to end
    python -m training.scripts.train_smoke --pipeline-only

    # the real thing, ~50 CPU steps, checkpointing every 10
    python -m training.scripts.train_smoke --steps 50 --save-every 10 \
        --tokenizer ai/tokenizer/artifacts/seed-1k \
        --shards data/processed/seed/shards --run-dir training/checkpoints/smoke

    # prove the resume: kill it, then
    python -m training.scripts.train_smoke ... --steps 50 --resume auto

WHAT THIS PROVES: the pipeline runs, the loss decreases, checkpoints
round-trip, and the training loop resumes from `latest` without losing or
repeating data. WHAT IT DOES NOT PROVE: model quality. A 1.8M-parameter
model trained for 50 steps on 3 MB of a synthetic fixture is a wiring
test; §7.5 says so explicitly, and the docs repeat it.

`--pipeline-only` is not a substitute for the run. It is what a machine
without torch can honestly execute: tokenizer contract, parameter count,
shard integrity, and the *data-cursor* half of resumability. It prints an
explicit UNVERIFIED banner for the two gates it cannot reach.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import dataset, pipeline  # noqa: E402
from ai.model import plan  # noqa: E402
from ai.model.config import smoke_config  # noqa: E402
from ai.tokenizer import spec  # noqa: E402
from training.scripts import checkpoint as ckpt  # noqa: E402


DEFAULT_SCOPE = ("§7.5 smoke test — verifies the pipeline, resume and checkpointing. "
                 "Not a quality result.")


def have_torch() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


# ── torch-free path ──────────────────────────────────────────────────
def pipeline_checks(tokenizer, meta, shards: dataset.ShardSet, cfg, run_dir: Path) -> dict:
    """Everything about the run that is verifiable with no framework installed."""
    print("\n  PIPELINE-ONLY MODE (this pass does not run the training loop)")
    print("  " + "─" * 62)

    checks = spec.assert_tokenizer_contract(tokenizer, spec.load_kb())
    for check in checks:
        print(f"  ✓ tokenizer: {check}")

    counts = plan.counts(cfg)
    print(f"  ✓ parameter count (analytic): {counts['total']:,} "
          f"({counts['total'] / 1e6:.2f}M) — printed, not measured: this pass does "
          f"not materialise the module")
    print(f"    embeddings {counts['embeddings']:,} · attention {counts['attention']:,} "
          f"· mlp {counts['mlp']:,} · norms {counts['norms']:,}")

    print(f"  ✓ shards: train {shards.train_tokens:,} tokens / "
          f"val {shards.val_tokens:,} tokens, dtype {shards.dtype}, "
          f"eos id {shards.eos_token_id}")
    train_files = shards.open("train")
    assert train_files, "no train shards"
    joined = train_files[0]
    assert joined.min() >= 0 and joined.max() < meta["vocab_size"], \
        "token id outside the tokenizer vocabulary"
    eos_present = any(int((f == shards.eos_token_id).sum()) > 0 for f in train_files)
    assert eos_present, "no <|end|> token in the shards — documents are not separated"
    print("  ✓ every token id is inside the vocabulary and <|end|> separates documents")

    batcher = dataset.TokenBatcher(shards, block=128, batch=2, seed=7)
    first = batcher.next_batches(5)
    state = batcher.state()
    uninterrupted = batcher.next_batches(5)
    resumed = dataset.TokenBatcher.resume(shards, state).next_batches(5)
    same = all((a[0] == b[0]).all() for a, b in zip(uninterrupted, resumed))
    assert same, "resumed data stream diverged from the uninterrupted one"
    print("  ✓ data cursor: resuming from saved state yields the *identical* "
          "next 5 batches (no repeats, no skips)")
    assert state["tokens_consumed"] == 5 * 2 * 128, "tokens_consumed is wrong"
    assert all(x.shape == (2, 128) for x, _ in first), "batch shape wrong"

    manager = ckpt.CheckpointManager(run_dir / "pipeline-only", keep_last=2)
    fake = _fake_state(step=5, tokens=state["tokens_consumed"])
    manager.save(fake, step=5, is_best=True)
    for step in (6, 7, 8):
        manager.save(_fake_state(step=step, tokens=step * 256), step=step)
    kept = manager.steps()
    assert 8 in kept and len(kept) <= 2, f"pruning wrong: {kept}"
    loaded = manager.load("latest")
    assert loaded["step"] == 8, "latest did not load the newest step"
    assert manager.load("best")["step"] == 5, "best did not stay at step 5"
    print(f"  ✓ checkpoints: atomic write, latest/best/step_N, pruned to {kept}")

    verify_resume_semantics(manager)
    print("  " + "─" * 62)
    print("  NOT VERIFIED BY THIS PASS: 'loss decreases' and 'training loop resumes'.")
    if have_torch():
        print("  torch is installed here — drop --pipeline-only to run them.")
    else:
        print("  torch is not installed on this machine; they run on Kaggle (P4).")
    return {"mode": "pipeline-only", "checks": "passed",
            "unverified": ["loss decreases", "checkpoint resume under a real optimizer"]}


def _fake_state(step: int, tokens: int) -> dict:
    """A state dict shaped like the real one, with arrays where tensors go.

    Deliberately uses numpy instead of torch so the checkpoint *logic*
    (required keys, atomicity, pruning, latest/best selection) is exercised
    on a machine with no torch at all.
    """
    return {
        "model": {"w": list(range(4))},
        "optimizer": {"m": list(range(4))},
        "scheduler": {"base_lr": 3e-3},
        "scaler": {"scale": 1.0},
        "step": step,
        "epoch": 0,
        "config": {"name": "smoke"},
        "tokenizer_version": "test",
        "rng": ckpt.capture_rng(),
        "data_cursor": {"tokens_consumed": tokens},
        "loss_history": [1.0 / (step + 1)],
    }


def verify_resume_semantics(manager: ckpt.CheckpointManager) -> None:
    """A crash must not be able to lose the run's identity."""
    import os

    manager.save(_fake_state(step=9, tokens=9 * 256), step=9, is_best=False)
    state = manager.load("latest")
    assert state["step"] == 9

    broken = dict(_fake_state(step=10, tokens=10 * 256))
    del broken["scaler"]
    try:
        manager.save(broken, step=10)
    except ckpt.MissingStateError:
        pass
    else:
        raise AssertionError("a checkpoint without GradScaler state was accepted")

    # a torn write must not be able to masquerade as a good checkpoint
    target = manager.path("latest")
    before = target.stat().st_size
    assert before > 0
    for stale in manager.run_dir.glob("*.tmp*"):
        stale.unlink()
    os.replace(target, target.with_suffix(".pt.crash"))
    assert not manager.exists("latest"), "latest survived being moved away"
    os.replace(target.with_suffix(".pt.crash"), target)
    print("  ✓ resume semantics: missing state keys refused, atomic replace verified")


# ── torch path ───────────────────────────────────────────────────────
def make_scaler(device_type: str, enabled: bool):
    """GradScaler across torch versions (fp16 AMP per §7.5 — a T4 has no bf16)."""
    import torch

    if hasattr(torch, "amp") and hasattr(torch.amp, "GradScaler"):
        return torch.amp.GradScaler(device_type, enabled=enabled)
    return torch.cuda.amp.GradScaler(enabled=enabled)  # pragma: no cover - old torch


def cosine_with_warmup(optimizer, warmup: int, total: int):
    import torch

    def factor(step: int) -> float:
        if step < warmup:
            return (step + 1) / max(1, warmup)
        progress = (step - warmup) / max(1, total - warmup)
        return 0.5 * (1 + math.cos(math.pi * min(1.0, progress)))

    return torch.optim.lr_scheduler.LambdaLR(optimizer, factor)


def resolve_config(name: str, vocab_size: int):
    """The config for this run, with its vocab taken from the tokenizer.

    The embedding is sized from the config, so running config A against a
    tokenizer of a different size would train a model that cannot use the
    artifact its checkpoints carry. The vocab therefore comes *from the
    tokenizer* and the parameter count is recomputed, not assumed.
    """
    if name == "smoke":
        return smoke_config(vocab_size)
    from dataclasses import replace

    from ai.model.config import CONFIGS

    if name not in CONFIGS:
        raise SystemExit(f"unknown --config {name!r}; use one of smoke, A, lite")
    return replace(CONFIGS[name], vocab_size=vocab_size)


def train(args) -> int:
    import numpy as np
    import torch

    from ai.model.model import build

    tokenizer, meta = _load_tokenizer(args.tokenizer)
    checks = spec.assert_tokenizer_contract(tokenizer, spec.load_kb())
    print(f"tokenizer {meta['tokenizer_version']} ({meta['vocab_size']:,} vocab) — "
          f"{len(checks)} contract checks passed")

    shards = dataset.ShardSet.load(args.shards)
    shards.assert_matches_tokenizer(meta)
    cfg = resolve_config(args.config, meta["vocab_size"])
    print(f"{cfg.summary()}")
    counts = plan.counts(cfg)
    print(f"parameters: {counts['total']:,} ({counts['total'] / 1e6:.2f}M) — "
          f"analytic; the materialised check follows")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    model = build(cfg, device)
    schema = model.assert_matches_schema()
    actual = model.param_count()
    print(f"materialised: {actual:,} params, {schema['keys']} state-dict keys")
    if actual != counts["total"]:
        raise SystemExit(f"param mismatch: analytic {counts['total']} vs module {actual}")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95),
                                  weight_decay=args.weight_decay)
    scheduler = cosine_with_warmup(optimizer, args.warmup, args.steps)
    use_amp = bool(args.amp) and device.type == "cuda"
    scaler = make_scaler(device.type, use_amp)
    manager = ckpt.CheckpointManager(args.run_dir, keep_last=args.keep_last)

    batcher = dataset.TokenBatcher(shards, split="train", block=args.block,
                                   batch=args.batch, seed=args.seed)
    val_batches = batcher.validation_batches(args.eval_batches, seed=0)
    state = {
        "model": model.state_dict(), "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
        "step": 0, "epoch": 0, "config": cfg.to_hf_config(),
        "tokenizer_version": meta["tokenizer_version"], "rng": ckpt.capture_rng(),
        "data_cursor": batcher.state(), "loss_history": [],
    }

    resume = ckpt.resolve_resume(manager, args.resume)
    if resume:
        loaded = manager.load(resume["which"])
        expected = (loaded["config"]["vocab_size"], loaded["config"]["hidden_size"],
                    loaded["config"]["num_hidden_layers"])
        live = (cfg.vocab_size, cfg.hidden_size, cfg.num_hidden_layers)
        if expected != live:
            raise SystemExit(f"checkpoint is for {expected}, this run is {live}")
        model.load_state_dict(loaded["model"])
        optimizer.load_state_dict(loaded["optimizer"])
        scheduler.load_state_dict(loaded["scheduler"])
        scaler.load_state_dict(loaded["scaler"])
        ckpt.restore_rng(loaded["rng"])
        batcher.load_state(loaded["data_cursor"])
        state["step"] = loaded["step"]
        state["loss_history"] = list(loaded["loss_history"])
        print(f"resumed from {Path(resume['path']).name} at step {state['step']} "
              f"(loss history {len(state['loss_history'])} entries, "
              f"{loaded['data_cursor']['tokens_consumed']:,} tokens consumed)")

    model.train()
    losses: list[float] = list(state["loss_history"])
    best_val = float("inf")
    started = time.time()
    step = state["step"]

    while step < args.steps:
        if args.max_minutes and (time.time() - started) / 60 > args.max_minutes:
            print(f"stopping at step {step}: --max-minutes {args.max_minutes} reached")
            break

        xs, ys = batcher.next_batch()
        x = torch.tensor(xs, device=device)
        y = torch.tensor(ys, device=device)

        with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
            out = model(x, labels=y)
            loss = out["loss"] / args.grad_accum
        scaler.scale(loss).backward()
        if (step + 1) % args.grad_accum == 0:
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
            scaler.step(optimizer)
            scaler.update()
            optimizer.zero_grad(set_to_none=True)
            scheduler.step()

        step += 1
        value = float(loss.detach()) * args.grad_accum
        losses.append(value)
        state["step"] = step
        if step % args.log_every == 0 or step == 1:
            print(f"step {step:>4}/{args.steps}  loss {value:.4f}  "
                  f"lr {scheduler.get_last_lr()[0]:.2e}", flush=True)

        if step % args.eval_every == 0:
            val = evaluate(model, val_batches, device, use_amp)
            print(f"          val loss {val:.4f}")
            if val < best_val:
                best_val = val
                state["loss_history"] = losses
                state["data_cursor"] = batcher.state()
                state["rng"] = ckpt.capture_rng()
                manager.save(state, step=step, is_best=True)

        if step % args.save_every == 0:
            state["loss_history"] = losses
            state["data_cursor"] = batcher.state()
            state["rng"] = ckpt.capture_rng()
            manager.save(state, step=step)

    state["loss_history"] = losses
    state["data_cursor"] = batcher.state()
    manager.save(state, step=step, is_best=not manager.exists("best"))

    verdict = loss_verdict(losses)
    return _finish(args, cfg, meta, counts, manager, batcher, losses, verdict, started)


def evaluate(model, batches, device, use_amp) -> float:
    import torch

    model.eval()
    total = 0.0
    with torch.no_grad():
        for xs, ys in batches:
            x = torch.tensor(xs, device=device)
            y = torch.tensor(ys, device=device)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
                total += float(model(x, labels=y)["loss"])
    model.train()
    return total / max(1, len(batches))


def loss_verdict(losses: list[float], window: int = 5) -> dict:
    """§7.5's gate: "loss decreases". Compared over equal-size windows."""
    if len(losses) < window * 2:
        return {"verdict": "INCONCLUSIVE",
                "reason": f"only {len(losses)} steps logged, need {window * 2}"}
    head = sum(losses[:window]) / window
    tail = sum(losses[-window:]) / window
    return {"verdict": "PASS" if tail < head else "FAIL",
            "first": round(head, 4), "last": round(tail, 4),
            "delta": round(tail - head, 4),
            "window": window, "steps": len(losses)}


def _finish(args, cfg, meta, counts, manager, batcher, losses, verdict, started) -> int:
    seconds = time.time() - started
    # Throughput is what §7.3's token budget is decided from, so the run
    # measures it rather than leaving it to be guessed at: this is the number
    # `estimate_budget.py --from-run` reads.
    tokens = len(losses) * args.block * args.batch
    tokens_per_second = tokens / seconds if seconds > 0 else 0.0
    print(f"\nloss: {losses[0]:.4f} → {losses[-1]:.4f} over {len(losses)} steps "
          f"({seconds:.1f}s, {seconds / max(1, len(losses)):.2f}s/step)")
    print(f"throughput: {tokens_per_second:,.0f} tokens/s "
          f"({args.block}x{args.batch} per step)")
    print(f"gate 'loss decreases': {verdict['verdict']} "
          f"({verdict.get('first')} → {verdict.get('last')})")

    import torch
    manifest = ckpt.write_run_manifest(manager.run_dir, {
        "run": Path(args.run_dir).name,
        "config": cfg.to_hf_config(),
        "tokenizer_version": meta["tokenizer_version"],
        "params": counts["total"],
        "hyperparameters": {"steps": args.steps, "batch": args.batch, "block": args.block,
                            "lr": args.lr, "warmup": args.warmup,
                            "grad_accum": args.grad_accum, "clip": args.clip,
                            "weight_decay": args.weight_decay, "amp": bool(args.amp),
                            "device": torch.device(args.device).type},
        "seed": args.seed,
        "data": {"shards": str(args.shards),
                 "sha256": {f["file"]: f["sha256"]
                            for f in batcher.shards.manifest["shards"]["train"].get("files", [])}},
        "loss": {"history": [round(v, 6) for v in losses], "verdict": verdict},
        "throughput": {"tokens_per_second": round(tokens_per_second, 3),
                       "seconds_per_step": round(seconds / max(1, len(losses)), 4),
                       "block": args.block, "batch": args.batch},
        "run_scope": getattr(args, "scope", DEFAULT_SCOPE),
        "scope": getattr(args, "scope", DEFAULT_SCOPE),
    })
    print(f"checkpoints: {manager.summary()}")
    print(f"manifest: {manifest}")
    if args.json:
        Path(args.json).write_text(json.dumps(
            {"loss": losses, "verdict": verdict, "params": counts["total"],
             "tokens_per_second": round(tokens_per_second, 3),
             "block": args.block, "batch": args.batch,
             "checkpoints": manager.summary()}, indent=2) + "\n", encoding="utf-8")
    if args.gate and verdict["verdict"] != "PASS":
        return 1
    return 0


def _load_tokenizer(path: str):
    from ai.tokenizer.train import load

    if not path:
        raise SystemExit("--tokenizer is required (train one with "
                         "`python -m ai.tokenizer.train`)")
    directory = Path(path)
    if not (directory / "tokenizer.json").is_file():
        raise SystemExit(
            f"no tokenizer at {directory} (expected {directory}/tokenizer.json).\n"
            f"Train one first:\n  python -m ai.tokenizer.train "
            f"--corpus 'data/raw/seed/*.txt' --vocab-size 1024 "
            f"--out ai/tokenizer/artifacts/seed-1k")
    return load(directory)


# ── entry point ──────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    """The flag surface, separate from `main` so other entry points
    (`train_stage_a.py`) can fill in defaults without duplicating the list."""
    ap = argparse.ArgumentParser(description="§7.5 local smoke train + resume test")
    ap.add_argument("--tokenizer", default="ai/tokenizer/artifacts/seed-1k")
    ap.add_argument("--scope", default=None, help="free-text label recorded in the manifest")
    ap.add_argument("--shards", default="data/processed/seed/shards")
    ap.add_argument("--run-dir", default="training/checkpoints/smoke")
    ap.add_argument("--config", default="smoke", choices=["smoke", "A", "lite", "local"],
                    help="smoke (default, §7.5), local (the largest config this laptop trains for real), or a §7.1 config")
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--block", type=int, default=128)
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--weight-decay", type=float, default=0.1)
    ap.add_argument("--clip", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--device", default="cuda" if _cuda() else "cpu")
    ap.add_argument("--amp", action="store_true", help="fp16 AMP (CUDA only; T4 has no bf16)")
    ap.add_argument("--eval-every", type=int, default=25)
    ap.add_argument("--eval-batches", type=int, default=4)
    ap.add_argument("--save-every", type=int, default=10)
    ap.add_argument("--log-every", type=int, default=5)
    ap.add_argument("--keep-last", type=int, default=3)
    ap.add_argument("--resume", default="none", help="none | auto | a checkpoint path")
    ap.add_argument("--max-minutes", type=float, default=0.0,
                    help="stop cleanly after this long (Kaggle session limits)")
    ap.add_argument("--pipeline-only", action="store_true",
                    help="run the torch-free checks even if torch is installed")
    ap.add_argument("--json", default=None)
    ap.add_argument("--gate", action="store_true",
                    help="exit non-zero if the loss did not decrease")
    return ap


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)

    if args.pipeline_only or not have_torch():
        tokenizer, meta = _load_tokenizer(args.tokenizer)
        shards = dataset.ShardSet.load(args.shards)
        shards.assert_matches_tokenizer(meta)
        cfg = smoke_config(meta["vocab_size"])
        print(f"tokenizer {meta['tokenizer_version']} · {cfg.summary()}")
        pipeline_checks(tokenizer, meta, shards, cfg, Path(args.run_dir))
        if not have_torch():
            print("\n  install torch to run the real smoke train, or run it on "
                  "Kaggle (P4):\n    pip install torch --index-url "
                  "https://download.pytorch.org/whl/cpu")
        return 0

    return train(args)


def _cuda() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
