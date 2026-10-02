"""training/scripts/estimate_budget.py — the §7.3 token-budget decision.

    # after the first ~100 steps on the real GPU
    python -m training.scripts.estimate_budget --config A \
        --tokens-per-second 4200 --hours 9 \
        --dataset-tokens data/processed/stage_a/shards/manifest.json

    # or straight from a run's metrics file
    python -m training.scripts.estimate_budget --config A --from-run run.json --hours 9

§7.3 is explicit that the budget is **decided after measuring tokens/sec in
the first ~100 steps**, and that the "~20 tokens per parameter" rule
(≈0.8B for config A) is a reference rather than a requirement. This script
exists so that decision is arithmetic on a measurement instead of a number
copied from a blog post:

* what throughput and how much wall clock the session actually gives you,
* how many tokens that is, and how many passes over the corpus,
* the tokens-per-parameter ratio it implies, next to the reference,
* and, for the reference target, **whether it fits in the hours available** —
  which is the question a Kaggle session actually asks.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.model import plan  # noqa: E402
from ai.model.config import CONFIGS, ModelConfig  # noqa: E402

# §7.3's reference rule. Not a requirement, and the docs say so.
REFERENCE_TOKENS_PER_PARAM = 20
# Roughly what an eval/checkpoint pause costs per step; applied as a haircut.
DEFAULT_OVERHEAD = 0.05
SECONDS_PER_GPU_HOUR = 3600


def args_help() -> str:
    return "--from-run needs a file written by train_smoke.py --json or gpu_probe.py --json:"


def check_measurement(run: dict, cfg: ModelConfig) -> None:
    """Refuse a throughput number that was not measured on `cfg`.

    §7.3 decides the budget *after* measuring tokens/sec. Measured where, on
    which model, is the whole content of that number — a 4.8M-parameter smoke
    model and a 37.9M-parameter Stage A differ by more than eight times the
    arithmetic, and the smaller one is bound by kernel-launch overhead rather
    than by arithmetic at all.

    Measured on Kaggle, 2026-10-02: `estimate_budget --config A --from-run
    smoke.json` printed

        config A — 37,890,560 params (37.89M)
          measured           6,270 tokens/s

    where 6,270 tokens/s came from a **4,769,472**-parameter, 4-layer, ctx-256
    smoke model. Every downstream number — steps reachable, tokens per
    parameter, hours needed — inherited the error, and the run then set its
    step count from it. Nothing complained, because the two numbers were only
    ever printed on adjacent lines. So the check is here: a mismatch is an
    error, not a warning.
    """
    target = plan.counts(cfg)["total"]
    measured = run.get("params")
    if measured is None:
        # An older metrics file that never recorded which model produced the
        # number. Accepting it silently is the original bug with one more step
        # of indirection, so there is nothing to compare and nothing to trust.
        raise SystemExit(
            f"{args_help()} this file records no 'params', so there is no way to tell "
            f"which model was measured.\n"
            f"  Regenerate it with the current writer:\n"
            f"    python -m training.scripts.gpu_probe --config {cfg.name} "
            f"--tokenizer <dir> --shards <dir> --amp --json probe.json")
    if int(measured) != int(target):
        raise SystemExit(
            f"{cfg.name} has {target:,} parameters but this measurement was taken on "
            f"{int(measured):,}.\n"
            f"  Throughput does not transfer between them — the smaller model is "
            f"launch-bound, not arithmetic-bound — so budgeting {cfg.name} from it "
            f"would report a rate it has never run at.\n"
            f"  Measure {cfg.name} itself first:\n"
            f"    python -m training.scripts.gpu_probe --config {cfg.name} "
            f"--batch <b> --block <n> --grad-accum <g> --amp \\\n"
            f"      --tokenizer <dir> --shards <dir> --json probe.json\n"
            f"  then re-run this command with --from-run probe.json.")


def budget(cfg: ModelConfig, tokens_per_second: float, hours: float,
           dataset_tokens: int | None = None, block: int = 1024,
           batch: int = 16, grad_accum: int = 1, overhead: float = DEFAULT_OVERHEAD,
           target_ratio: float = REFERENCE_TOKENS_PER_PARAM,
           measured_on: str | None = None) -> dict:
    """Everything the token-budget decision needs, from one measurement."""
    if tokens_per_second <= 0:
        raise ValueError("tokens_per_second must be positive — measure it first")

    params = plan.counts(cfg)["total"]
    usable_seconds = hours * SECONDS_PER_GPU_HOUR * (1 - overhead)
    tokens_reachable = tokens_per_second * usable_seconds
    # Two units, and conflating them is how a step count gets set 8x wrong:
    # `train_smoke.py --steps` counts *micro*-steps (one batch each), while the
    # optimizer only moves every `grad_accum` of them. Both are reported, and
    # the one `--steps` takes is named.
    tokens_per_micro_step = block * batch
    tokens_per_update = tokens_per_micro_step * grad_accum
    micro_steps = tokens_reachable / tokens_per_micro_step
    updates = tokens_reachable / tokens_per_update
    seconds_per_micro_step = tokens_per_micro_step / tokens_per_second

    target_tokens = params * target_ratio
    target_seconds = target_tokens / tokens_per_second
    target_hours = target_seconds / SECONDS_PER_GPU_HOUR

    out = {
        "config": cfg.name,
        "params": params,
        "tokens_per_second": tokens_per_second,
        "measured_on": measured_on,
        "hours": hours,
        "usable_seconds": usable_seconds,
        "overhead": overhead,
        "grad_accum": grad_accum,
        "tokens_per_micro_step": tokens_per_micro_step,
        "tokens_per_update": tokens_per_update,
        "seconds_per_micro_step": seconds_per_micro_step,
        "micro_steps_reachable": micro_steps,
        "learning_updates_reachable": updates,
        # Kept under the old names: with grad_accum == 1 the two agree, and the
        # existing tests pin that case.
        "tokens_per_step": tokens_per_update,
        "seconds_per_step": tokens_per_update / tokens_per_second,
        "steps_reachable": updates,
        "tokens_reachable": tokens_reachable,
        "epochs_reachable": (tokens_reachable / dataset_tokens) if dataset_tokens else None,
        "tokens_per_param": tokens_reachable / params,
        "reference_tokens_per_param": target_ratio,
        "reference_tokens": target_tokens,
        "reference_hours_needed": target_hours,
        "reference_fits": target_hours <= hours,
    }
    if dataset_tokens:
        out["dataset_tokens"] = dataset_tokens
        out["hours_per_epoch"] = dataset_tokens / tokens_per_second / SECONDS_PER_GPU_HOUR
    return out


def dataset_tokens_from(path: Path | str) -> int:
    """Total train tokens from a shards manifest, a prepared corpus dir, or a count.

    A bare integer is accepted because that is what the flag is named for, and
    the number is frequently already known -- it is in the run log, or on the
    shard summary. Reading it as a path made `170276818` die with a bare
    FileNotFoundError, which reads like a missing file rather than a mistake
    about the argument's type.
    """
    text = str(path).strip().replace("_", "").replace(",", "")
    if text.isdigit():
        return int(text)
    path = Path(path)
    if path.is_dir():
        path = path / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if "shards" in manifest:
        return int(manifest["shards"]["train"]["tokens"])
    raise ValueError(f"{path}: no shards.train.tokens — not a shard manifest")


def from_run(path: Path | str) -> dict:
    """Throughput out of a `train_smoke.py --json` metrics file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    throughput = data.get("tokens_per_second") or (data.get("throughput") or {}).get(
        "tokens_per_second")
    if not throughput:
        raise ValueError(
            f"{path}: no tokens_per_second. The smoke run writes it when it has a "
            f"torch backend; a --pipeline-only run cannot measure throughput.")
    return data


def report(est: dict, stream=None) -> None:
    # `stream=None` resolved here, not `stream=sys.stdout` as a default: a
    # default is evaluated at *import* time, which pins the original stdout
    # forever. Then `contextlib.redirect_stdout` does not capture the report, and
    # so neither does the UTF-8 reconfiguration in `main` — on a cp1252 console
    # the `→` in this function raises `UnicodeEncodeError` partway through. A
    # frozen default stream is a crash waiting for whichever caller happens to
    # swap stdout first.
    stream = sys.stdout if stream is None else stream
    m = est["tokens_per_param"]
    ref = est["reference_tokens_per_param"]
    print(f"\nconfig {est['config']} — {est['params']:,} params "
          f"({est['params'] / 1e6:.2f}M)", file=stream)
    # Provenance on the same line as the rate: this report is read as one block,
    # and a rate with no stated origin is how a 4.8M model's speed ended up
    # presented as a 37.9M model's.
    print(f"  measured           {est['tokens_per_second']:,.0f} tokens/s"
          f"  ({est.get('measured_on') or 'unverified: passed on the command line'})",
          file=stream)
    print(f"  session            {est['hours']} h → {est['usable_seconds'] / 3600:.2f} h usable "
          f"({est['overhead']:.0%} reserved for eval/checkpointing)", file=stream)
    print(f"  step               {est['tokens_per_micro_step']:,} tokens/micro-step "
          f"x {est['grad_accum']} = {est['tokens_per_update']:,} per learning update "
          f"({est['seconds_per_micro_step']:.2f} s/micro-step)", file=stream)
    print(f"  reachable          {est['tokens_reachable'] / 1e9:.3f}B tokens · "
          f"{est['micro_steps_reachable']:,.0f} micro-steps (this is what --steps "
          f"counts) · {est['learning_updates_reachable']:,.0f} updates · "
          f"{m:.1f} tokens/param", file=stream)
    if est.get("epochs_reachable") is not None:
        print(f"  corpus             {est['dataset_tokens'] / 1e9:.3f}B tokens → "
              f"{est['epochs_reachable']:.2f} passes "
              f"({est['hours_per_epoch']:.2f} h/epoch)", file=stream)
    print(f"  §7.3 reference     {ref:.0f} tokens/param = "
          f"{est['reference_tokens'] / 1e9:.3f}B tokens", file=stream)
    verdict = ("fits" if est["reference_fits"] else "does NOT fit")
    print(f"  at this rate       needs {est['reference_hours_needed']:.1f} h → {verdict}", file=stream)
    if est["reference_fits"] and est["tokens_reachable"] >= est["reference_tokens"]:
        print("  decision           run the reference budget; more tokens only if the "
              "val curve is still falling", file=stream)
    elif est["reference_fits"]:
        print("  decision           the session is long enough for the reference budget — "
              "raise the step count, not the learning rate", file=stream)
    else:
        needed = est["reference_hours_needed"]
        print(f"  decision           either accept {m:.1f} tokens/param, or plan "
              f"{needed:.1f} h total ({(needed / est['hours']):.1f} sessions) — §7.3 makes "
              f"the reference a reference, not a requirement", file=stream)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    # The guard in `check_measurement` exits via SystemExit, whose message the
    # interpreter writes to *stderr*. On a cp1252 console (Windows) that turns
    # the em-dashes into replacement characters — the one message that has to be
    # readable is the one that was being mangled.
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Token-budget estimate (§7.3)")
    ap.add_argument("--config", default="A", choices=sorted(CONFIGS))
    ap.add_argument("--tokens-per-second", type=float, help="measured on the real device")
    ap.add_argument("--from-run", help="a train_smoke.py --json metrics file")
    ap.add_argument("--hours", type=float, default=9.0, help="session length available")
    ap.add_argument("--dataset-tokens",
                    help="a token count, or a shard manifest / prepared corpus "
                         "directory to read one from")
    ap.add_argument("--block", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--overhead", type=float, default=DEFAULT_OVERHEAD)
    ap.add_argument("--json", help="write the estimate here")
    args = ap.parse_args(argv)

    throughput = args.tokens_per_second
    measured_on = None
    if args.from_run:
        run = from_run(args.from_run)
        check_measurement(run, CONFIGS[args.config])
        throughput = throughput or run["tokens_per_second"]
        args.block = run.get("block", args.block)
        args.batch = run.get("batch", args.batch)
        # grad-accum is part of what a "step" costs. Inheriting block and batch
        # but not this one made the reported step size a fraction of the real one.
        if run.get("grad_accum"):
            args.grad_accum = run["grad_accum"]
        name = run.get("config") or f"{run.get('params', 0):,}-parameter model"
        measured_on = f"config {name}, {run.get('params', 0):,} params"
    if not throughput:
        print("measure throughput first: run gpu_probe.py on the config you are "
              "budgeting, and pass --from-run", file=sys.stderr)
        return 2

    tokens = dataset_tokens_from(args.dataset_tokens) if args.dataset_tokens else None
    est = budget(CONFIGS[args.config], throughput, args.hours, tokens,
                 block=args.block, batch=args.batch, grad_accum=args.grad_accum,
                 overhead=args.overhead, measured_on=measured_on)
    report(est)
    if args.json:
        Path(args.json).write_text(json.dumps(est, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
