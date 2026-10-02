"""training/scripts/train_stage_b.py — Stage B: instruction tuning (§7.4).

    # what this machine can verify with no torch at all
    python -m training.scripts.train_stage_b --pipeline-only

    # the real thing: continue the Stage A checkpoint on the instruction data
    python -m training.scripts.train_stage_b \
        --tokenizer ai/tokenizer/artifacts/stage-a-16k \
        --config A --init training/checkpoints/stage-a/latest.pt \
        --data data/instruction/sft.jsonl \
        --run-dir training/checkpoints/stage-b \
        --steps 3000 --batch 8 --block 1024 --lr 5e-5 --warmup 100 --amp --gate

WHY THIS FILE EXISTS. Until this trainer, Stage B had *data* and no training
path: `npm run sft` wrote 40,000 examples to `data/instruction/sft.jsonl`,
and every trainer in this repo was a Stage A trainer. The practical effect
was worse than a missing feature — the shipped export had been trained on a
corpus in which the runtime prompt frame (`<|ctx|>`, `<|asst|>`) appears in 4
documents out of 17,265, so the model had never been shown the format it is
asked to continue at inference time. That is a §7 gap, not a tuning problem,
and it is why the shipped answers read as language-shaped noise.

This is `train_smoke.py`'s loop with a different *data path*, not a second
implementation: the optimizer/scaler/scheduler/clip/checkpoint/manifest code
is imported from there, so "verified resume" keeps meaning one thing. What
differs is exactly what Stage B requires:

| | Stage A | Stage B |
|---|---|---|
| data | memmapped token shards | `data/instruction/sft.jsonl` |
| batch half | raw blocks (`TokenBatcher`) | masked windows (`ai.data.sft.SftStream`) |
| loss | every token | assistant tokens only (`-100` elsewhere, §7.4) |
| starts from | random init | the Stage A checkpoint (`--init`) |
| learning rate | 3e-4 | 5e-5 — an SFT run that starts at the pretrain LR undoes the pretraining |

`--init` loads model weights only. Optimizer, scaler and scheduler start
fresh, because Stage B is a different objective on different data: carrying
Stage A's Adam moments across is not "resuming", and a `data_cursor` from the
shard stream would index the wrong thing. `--resume` is the flag that
continues *this* Stage B run, and it is a separate checkpoint directory.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import sft  # noqa: E402
from ai.model import plan  # noqa: E402
from training.scripts import checkpoint as ckpt  # noqa: E402
from training.scripts.train_smoke import (  # noqa: E402
    cosine_with_warmup, have_torch, hyperparameters, loss_verdict, make_scaler,
    resolve_config, schedule_span,
)

DEFAULT_SCOPE = ("Stage B — instruction tuning on the §7.4 data: answer from the "
                 "context, abstain when it cannot. Quality is bounded by Stage A "
                 "and by the corpus; this run only makes the runtime format the "
                 "one the model has seen.")


# ── torch-free path ──────────────────────────────────────────────────
def pipeline_checks(args) -> int:
    """Everything about the Stage B data path that needs no framework.

    This is not a substitute for the run. It is what a machine without torch
    can honestly execute: the mask (shown, not claimed), the manifest the
    data was generated from, and the cursor half of resumability.
    """
    from ai.tokenizer.train import load

    print("\n  PIPELINE-ONLY MODE (Stage B data path, no torch needed)")
    print("  " + "─" * 66)

    tokenizer, meta = load(args.tokenizer)
    print(f"  ✓ tokenizer {meta['tokenizer_version']} · {meta['vocab_size']:,} vocab")

    examples = sft.read_examples(args.data, limit=args.limit)
    summary = sft.summarise(examples)
    print(f"  ✓ examples: {summary['examples']:,} read, "
          f"{summary['characters']:,} characters, {summary['assistant_turns']:,} assistant turns")
    print(f"    categories {summary['categories']}")
    print(f"    languages {summary['languages']} · counterfactual {summary['counterfactual']:,} "
          f"({summary['counterfactual'] / summary['examples']:.1%})")
    provided_manifest = Path(args.data).with_name("manifest.json")
    if provided_manifest.is_file():
        stated = json.loads(provided_manifest.read_text(encoding="utf-8"))
        if args.limit:
            print(f"    (--limit {args.limit}: the file's own manifest is not "
                  f"cross-checked against a partial read)")
        elif stated.get("examples") and int(stated["examples"]) != summary["examples"]:
            raise SystemExit(
                f"the data file has {summary['examples']:,} examples but its manifest "
                f"claims {int(stated['examples']):,} — regenerate with `npm run sft`")
        else:
            print(f"  ✓ manifest agrees with the file on {summary['examples']:,} examples")
        estimated = stated.get("tokens_estimated")
        if estimated:
            print(f"    the manifest's {int(estimated):,} tokens is "
                  f"{stated.get('token_estimate_method', 'ESTIMATED')}")

    counts = sft.measured_token_counts(tokenizer, examples)
    print(f"  ✓ measured tokens (shipping tokenizer): {counts['tokens']:,} total, "
          f"{counts['supervised_tokens']:,} supervised "
          f"({counts['supervised_share']:.1%} of the stream is loss-bearing), "
          f"longest example {counts['longest_example']:,}")
    if counts["longest_example"] > args.block:
        print(f"    note: {counts['longest_example']:,} > --block {args.block}, so the longest "
              f"examples are cut mid-turn — their tail is trained on, their head is not")

    # The mask is the whole point of Stage B, so it is printed rather than
    # asserted: reading "the loss is on this text" is what catches a mask that
    # is technically non-empty and materially wrong.
    for example in examples[:max(1, args.show)]:
        ids, labels = sft.encode_example(tokenizer, example)
        supervised = sum(1 for value in labels if value != sft.IGNORE_INDEX)
        print(f"\n    {example.category}/{example.lang} — {supervised}/{len(ids)} tokens supervised")
        print(f"    loss is on: {sft.masked_text(tokenizer, ids, labels)[:160]!r}")

    stream = sft.SftStream(examples, tokenizer, block=args.block, batch=args.batch,
                           seed=args.seed)
    print(f"\n  ✓ stream: {len(stream.train_indices):,} train / "
          f"{len(stream.val_indices):,} val examples ({stream.epoch_tokens:,} tokens/epoch, "
          f"block {args.block}, batch {args.batch})")
    first = stream.next_batch()
    assert first[0].shape == (args.batch, args.block), f"batch shape {first[0].shape}"
    assert (first[1] == sft.IGNORE_INDEX).any(), "the mask is not masking anything"
    # Supervision is clustered: a window taken entirely from a long context+
    # question stretch carries none. Over a few windows it must appear, or the
    # run is computing a loss on nothing.
    window_supervised = [int((first[1] != sft.IGNORE_INDEX).sum())]
    empty_windows = sum(1 for row in first[1] if not (row != sft.IGNORE_INDEX).any())
    for _ in range(3):
        more = stream.next_batch()
        window_supervised.append(int((more[1] != sft.IGNORE_INDEX).sum()))
        empty_windows += sum(1 for row in more[1] if not (row != sft.IGNORE_INDEX).any())
    assert sum(window_supervised) > 0, "four batches carried no supervision at all"
    print(f"  ✓ mask: {sum(window_supervised):,} supervised tokens over 4 batches of "
          f"{args.batch}×{args.block}; {empty_windows}/{4 * args.batch} rows are all-context "
          f"windows "
          f"(they contribute no loss — the {counts['supervised_share']:.1%} of the stream "
          f"that is loss-bearing is not spread evenly)")

    state = stream.state()
    uninterrupted = stream.next_batch()
    resumed = sft.SftStream(examples, tokenizer, block=args.block, batch=args.batch,
                            seed=args.seed)
    resumed.load_state(state)
    again = resumed.next_batch()
    assert (uninterrupted[0] == again[0]).all() and (uninterrupted[1] == again[1]).all(), \
        "resuming from a saved cursor changed the data stream"
    print("  ✓ cursor: resuming yields the *identical* next batch (no repeat, no skip)")

    val = stream.validation_batches(args.eval_batches)
    assert len(val) == args.eval_batches
    assert all((y == sft.IGNORE_INDEX).any() for _, y in val), \
        "a validation window has no ignored positions, so it is not a masked window"
    val_supervised = sum(int((y != sft.IGNORE_INDEX).sum()) for _, y in val)
    assert val_supervised > 0, "the validation set carries no supervision at all"
    print(f"  ✓ validation: {args.eval_batches} fixed windows, "
          f"{val_supervised:,} supervised tokens")

    print("  " + "─" * 66)
    print("  NOT VERIFIED BY THIS PASS: 'the masked loss decreases' and 'the loop resumes'.")
    if have_torch():
        print("  torch is installed here — drop --pipeline-only to run them.")
    else:
        print("  torch is not installed on this machine; they run on Kaggle (P5/P4).")
    return 0


# ── torch path ───────────────────────────────────────────────────────
def masked_evaluate(model, batches, device, use_amp) -> float:
    """Mean loss over batches whose labels are already -100-masked."""
    import torch

    model.eval()
    total = 0.0
    with torch.no_grad():
        for xs, ys in batches:
            x = torch.tensor(xs, device=device, dtype=torch.long)
            y = torch.tensor(ys, device=device, dtype=torch.long)
            with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=use_amp):
                total += float(model(x, labels=y)["loss"])
    model.train()
    return total / max(1, len(batches))


def load_init_weights(model, path: Path, cfg) -> dict:
    """Load Stage A's model weights into this run's module.

    Validated rather than hopeful: a checkpoint from a different vocab, width
    or depth would load *some* keys and leave the rest at their initial
    values, and the run would then train a half-random model with no error to
    notice.

    **This does not go through `CheckpointManager.load`,** which is the
    deliberate difference. That loader answers "can this run be continued?",
    and continuing needs twelve things — the optimizer's moments, the
    scheduler's position, the data cursor. Initialising needs four: the
    weights, the config, the tokenizer generation and the step. Routing
    `--init` through the resume loader made the two claims the same claim, so
    a checkpoint that could perfectly well be initialised from was refused for
    lacking state that this run would have thrown away anyway.

    That is not hypothetical. Stage A v2's checkpoint (2026-10-02) is
    unusable for a resume — its optimizer was captured before the first update
    and never refreshed — so `publish_checkpoint.py --weights-only` strips
    exactly those parts to make the truth visible. With this change the
    stripped file is exactly as initialisable as the original, and still just
    as impossible to resume.
    """
    path = Path(path)
    state = read_weights(path)
    saved = state.get("config") or {}
    live = cfg.to_hf_config()
    for key in ("vocab_size", "hidden_size", "num_hidden_layers"):
        if key in saved and saved[key] != live[key]:
            raise SystemExit(
                f"--init {path} is {key}={saved[key]} but this run is {live[key]}. "
                f"Stage B must continue the model it will be exported from.")
    if "model" not in state:
        raise SystemExit(f"--init {path} has no 'model' key; it is not a "
                         f"checkpoint this trainer can initialise from.")
    model.load_state_dict(state["model"])
    return {"checkpoint": str(path), "step": state.get("step"),
            "tokenizer_version": state.get("tokenizer_version"),
            "weights_only": bool(state.get("weights_only"))}


def read_weights(path: Path) -> dict:
    """The keys an initialisation needs, from a torch- or pickle-serialised file.

    Both are tried, in that order, and the order does not matter: which
    serializer a checkpoint uses is a property of the machine that *wrote* it,
    not of the machine reading it. `checkpoint.py` picks torch when it can and
    pickle when it cannot, so a file produced on a box without torch is a real
    possibility — and torch.load's "Invalid magic number" on a pickle file is a
    perfectly good file being called corrupt by a reader that assumed too much.
    """
    import pickle

    path = Path(path)
    if not path.is_file():
        raise SystemExit(f"--init {path}: no such file.")

    state = None
    problems = []
    try:
        import torch

        state = torch.load(path, map_location="cpu", weights_only=False)
    except ImportError:
        pass  # no torch here; the pickle reader below is the only option
    except Exception as exc:  # noqa: BLE001
        problems.append(f"torch: {exc.__class__.__name__}")

    if state is None:
        try:
            with path.open("rb") as handle:
                state = pickle.load(handle)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"pickle: {exc.__class__.__name__}")

    if state is None:
        # A truncated download, or a file that is not a checkpoint at all. The
        # alternative is a traceback several frames deep that names neither.
        raise SystemExit(f"--init {path} could not be read as a checkpoint "
                         f"({'; '.join(problems) or 'unknown'}).")
    if not isinstance(state, dict):
        raise SystemExit(f"--init {path} did not load as a state dict "
                         f"(got {type(state).__name__}).")
    return state


def train(args) -> int:
    import numpy as np
    import torch

    from ai.model.model import build
    from ai.tokenizer.train import load

    tokenizer, meta = load(args.tokenizer)
    examples = sft.read_examples(args.data, limit=args.limit)
    summary = sft.summarise(examples)
    print(f"instruction data: {summary['examples']:,} examples, "
          f"{summary['categories']}")

    cfg = resolve_config(args.config, meta["vocab_size"])
    print(cfg.summary())
    counts = plan.counts(cfg)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    model = build(cfg, device)
    actual = model.param_count()
    if actual != counts["total"]:
        raise SystemExit(f"param mismatch: analytic {counts['total']} vs module {actual}")
    print(f"materialised: {actual:,} params")

    init = None
    if args.init:
        init = load_init_weights(model, Path(args.init), cfg)
        print(f"initialised from {init['checkpoint']} (step {init['step']})")

    stream = sft.SftStream(examples, tokenizer, block=args.block, batch=args.batch,
                           seed=args.seed)
    val_batches = stream.validation_batches(args.eval_batches, seed=0)
    supervised = sum(int((y != sft.IGNORE_INDEX).sum()) for _, y in val_batches)
    print(f"stream: {len(stream.train_indices):,} train / {len(stream.val_indices):,} val "
          f"examples ({stream.epoch_tokens:,} tokens/epoch); "
          f"val carries {supervised:,} supervised tokens")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95),
                                  weight_decay=args.weight_decay)
    # `--steps` and `--warmup` are micro-steps; the scheduler advances once per
    # optimizer update. Stage B runs `--grad-accum 2`, so passing them straight
    # through left the LR at 0.999 of peak at the end of a full run — it never
    # annealed. See `schedule_span` for the measurement.
    scheduler = cosine_with_warmup(optimizer, *schedule_span(args.steps, args.warmup,
                                                            args.grad_accum))
    use_amp = bool(args.amp) and device.type == "cuda"
    scaler = make_scaler(device.type, use_amp)
    manager = ckpt.CheckpointManager(args.run_dir, keep_last=args.keep_last,
                                     live={"optimizer": optimizer,
                                           "scheduler": scheduler,
                                           "scaler": scaler})

    state = {
        "model": model.state_dict(), "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
        "step": 0, "epoch": 0, "config": cfg.to_hf_config(),
        "tokenizer_version": meta["tokenizer_version"], "rng": ckpt.capture_rng(),
        "data_cursor": stream.state(), "loss_history": [],
        "hyperparameters": hyperparameters(args),
    }

    resume = ckpt.resolve_resume(manager, args.resume)
    if resume:
        loaded = manager.load(resume["which"])
        model.load_state_dict(loaded["model"])
        optimizer.load_state_dict(loaded["optimizer"])
        scheduler.load_state_dict(loaded["scheduler"])
        scaler.load_state_dict(loaded["scaler"])
        ckpt.restore_rng(loaded["rng"])
        stream.load_state(loaded["data_cursor"])
        state["step"] = loaded["step"]
        state["loss_history"] = list(loaded["loss_history"])
        print(f"resumed {Path(resume['path']).name} at step {state['step']} "
              f"({loaded['data_cursor']['tokens_consumed']:,} tokens, "
              f"{loaded['data_cursor'].get('supervised_consumed', 0):,} supervised)")

    model.train()
    losses: list[float] = list(state["loss_history"])
    best_val = float("inf")
    started = time.time()
    step = state["step"]
    tokens_seen = 0
    supervised_seen = 0

    while step < args.steps:
        if args.max_minutes and (time.time() - started) / 60 > args.max_minutes:
            print(f"stopping at step {step}: --max-minutes {args.max_minutes} reached")
            break

        xs, ys = stream.next_batch()
        x = torch.tensor(xs, device=device, dtype=torch.long)
        y = torch.tensor(ys, device=device, dtype=torch.long)
        tokens_seen += int(x.numel())
        supervised_seen += int((y != sft.IGNORE_INDEX).sum())
        # The cursor's own counters have to advance with the run: they are what
        # a resume prints and what the checkpoint records, and leaving them at
        # zero makes "resumed at step 10 (0 tokens)" a lie that looks like a
        # lost cursor.
        stream.tokens_consumed += int(x.numel())
        stream.supervised_consumed += int((y != sft.IGNORE_INDEX).sum())

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
            val = masked_evaluate(model, val_batches, device, use_amp)
            print(f"          val loss {val:.4f} (assistant tokens only)")
            if val < best_val:
                best_val = val
                _snapshot(state, losses, stream, manager, step, is_best=True)

        if step % args.save_every == 0:
            _snapshot(state, losses, stream, manager, step)

    _snapshot(state, losses, stream, manager, step,
              is_best=not manager.exists("best"))
    verdict = loss_verdict(losses)
    measured = sft.measured_token_counts(tokenizer, examples)
    return _finish(args, cfg, meta, summary, measured, init, manager, losses, verdict,
                   started, tokens_seen, supervised_seen, counts,
                   (stream.tokens_consumed, stream.supervised_consumed))


def _snapshot(state, losses, stream, manager, step, is_best: bool = False) -> None:
    state["loss_history"] = losses
    state["data_cursor"] = stream.state()
    state["rng"] = ckpt.capture_rng()
    manager.save(state, step=step, is_best=is_best)


def _finish(args, cfg, meta, summary, measured, init, manager, losses, verdict,
            started, tokens_seen, supervised_seen, counts, stream_totals) -> int:
    seconds = time.time() - started
    print(f"\nloss: {losses[0]:.4f} → {losses[-1]:.4f} over {len(losses)} steps "
          f"({seconds:.1f}s, {seconds / max(1, len(losses)):.2f}s/step)")
    print(f"tokens: {tokens_seen:,} seen this session, {supervised_seen:,} supervised "
          f"({supervised_seen / max(1, tokens_seen):.1%} — the rest is context and "
          f"the question, which §7.4 does not train on)")
    print(f"gate 'loss decreases': {verdict['verdict']} "
          f"({verdict.get('first')} → {verdict.get('last')})")

    import torch

    manifest = ckpt.write_run_manifest(manager.run_dir, {
        "run": Path(args.run_dir).name,
        "stage": "B — instruction tuning (§7.4)",
        "config": cfg.to_hf_config(),
        "params": counts["total"],
        "tokenizer_version": meta["tokenizer_version"],
        "initialised_from": init,
        "data": {
            "file": str(args.data),
            "examples_read": summary["examples"],
            "characters": summary["characters"],
            "assistant_turns": summary["assistant_turns"],
            "categories": summary["categories"],
            "languages": summary["languages"],
            "counterfactual": summary["counterfactual"],
            "supervised_tokens": supervised_seen,
            "tokens_seen": tokens_seen,
            "tokens_seen_cumulative": stream_totals[0],
            "supervised_tokens_cumulative": stream_totals[1],
            "measured": measured,
        },
        "hyperparameters": hyperparameters(args),
        "seed": args.seed,
        "loss": {"history": [round(v, 6) for v in losses], "verdict": verdict},
        "throughput": {"tokens_per_second": round(tokens_seen / seconds, 3) if seconds else 0.0,
                       "seconds_per_step": round(seconds / max(1, len(losses)), 4),
                       "block": args.block, "batch": args.batch},
        "run_scope": getattr(args, "scope", DEFAULT_SCOPE),
        "scope": getattr(args, "scope", DEFAULT_SCOPE),
    })
    print(f"checkpoints: {manager.summary()}")
    print(f"manifest: {manifest}")
    print("\nnext: export and verify the engine against it\n"
          f"  npm run export:model -- --run-dir {args.run_dir}\n  npm run verify:engine")
    if args.json:
        Path(args.json).write_text(json.dumps(
            {"loss": losses, "verdict": verdict, "params": counts["total"],
             "supervised_tokens": supervised_seen, "tokens_seen": tokens_seen,
             "block": args.block, "batch": args.batch,
             "checkpoints": manager.summary()}, indent=2) + "\n", encoding="utf-8")
    if args.gate and verdict["verdict"] != "PASS":
        return 1
    return 0


# ── entry point ──────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Stage B — §7.4 instruction tuning")
    ap.add_argument("--data", default=str(sft.DEFAULT_SFT_PATH),
                    help="the sft.jsonl written by `npm run sft`")
    ap.add_argument("--tokenizer", default="ai/tokenizer/artifacts/seed-1k")
    ap.add_argument("--config", default="local", choices=["smoke", "A", "lite", "local"])
    ap.add_argument("--init", default=None,
                    help="Stage A checkpoint to continue (model weights only)")
    ap.add_argument("--run-dir", default="training/checkpoints/stage-b")
    ap.add_argument("--scope", default=None, help="free-text label recorded in the manifest")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--block", type=int, default=512)
    ap.add_argument("--grad-accum", type=int, default=2)
    ap.add_argument("--lr", type=float, default=5e-5,
                    help="lower than Stage A's 3e-4 on purpose: see the module docstring")
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--weight-decay", type=float, default=0.1)
    ap.add_argument("--clip", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--device", default="cuda" if _cuda() else "cpu")
    ap.add_argument("--amp", action="store_true", help="fp16 AMP (CUDA only; T4 has no bf16)")
    ap.add_argument("--eval-every", type=int, default=25)
    ap.add_argument("--eval-batches", type=int, default=4)
    ap.add_argument("--save-every", type=int, default=25)
    ap.add_argument("--log-every", type=int, default=5)
    ap.add_argument("--keep-last", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="read only the first N examples")
    ap.add_argument("--resume", default="none", help="none | auto | a checkpoint path")
    ap.add_argument("--max-minutes", type=float, default=0.0)
    ap.add_argument("--pipeline-only", action="store_true")
    ap.add_argument("--show", type=int, default=3,
                    help="how many masked examples --pipeline-only prints")
    ap.add_argument("--json", default=None)
    ap.add_argument("--gate", action="store_true",
                    help="exit non-zero if the loss did not decrease")
    return ap


def _cuda() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)
    if args.pipeline_only or not have_torch():
        code = pipeline_checks(args)
        if not have_torch():
            print("\n  install torch to run the real Stage B train, or run it on Kaggle (P4)")
        return code
    return train(args)


if __name__ == "__main__":
    raise SystemExit(main())
