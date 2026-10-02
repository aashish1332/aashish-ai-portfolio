"""Read a pulled Stage A checkpoint and decide whether it is the §14 one.

    PYTHONUTF8=1 python tools/verify_checkpoint.py --ckpt <path/to/latest.pt>

Written on 2026-10-02, hours before a finished run existed to point it at, for
one reason: the previous run (v2) was *read* by eye and filed, and the reading
missed the defect that made it unusable. Its log said nothing was wrong, and
the thing that was wrong — the learning rate never annealed, finishing at
96.7% of peak — is invisible in a loss curve and completely visible in the
scheduler state. A checkpoint needs the same treatment as any other claim:
checks that run, and can fail.

The checks, and what each one is for:

| check | what it rules out |
|---|---|
| `keys`        | a checkpoint that cannot resume its own run (missing optimizer/scaler/rng) |
| `step`        | a run that saved at step 0 and called it a training run |
| `config`      | tensors that do not belong to config A — the §8 gate exists for this |
| `strict load` | "All keys matched" claimed but not enforced: shapes or names could differ |
| `params`      | 37,890,560 asserted, compared against the analytic plan, not a constant |
| `fresh`       | **the v2 defect** — an optimizer with no moments and a scheduler at `last_epoch` 0 |
| `anneal`      | a schedule that never decayed |
| `schedule`    | an LR the run's own settings cannot explain (a schedule built in micro-steps) |

The anneal check is the reason this file exists. `optimizer.param_groups[0]`
carries the *current* `lr`; `scheduler._last_lr` carries the last one the
schedule emitted, and `param_groups[0]['initial_lr']` is the peak LambdaLR
pinned at construction. Their ratio is the whole story, with no log and no
curve involved.

It also *reconstructs* the schedule instead of trusting the ratio alone: for
each candidate `--grad-accum`, replay the trainer's own `schedule_span` +
`cosine_with_warmup` arithmetic at the checkpointed step and see which
candidate reproduces the recorded `_last_lr`. That names the gradient
accumulation the run actually used, and it is the check that would catch a
schedule that anneals to the right number for the wrong reason.

Verified against the v2 checkpoint on 2026-10-02, where it fails three checks:
`fresh` (the file holds step 0's optimizer and scheduler), and the LR readings
disagree — 0.5% of peak in the file against 96.7% in the log. The lesson that
shaped this file: a checkpoint is not a log, and reading one by eye misses
exactly the things a value check catches.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# The number §7.1 and §8 agree on, restated here so this file does not import
# the thing it is checking. `plan.counts` below computes it independently.
EXPECTED_PARAMS = 37_890_560

# A cosine that anneals lands on 0. The v2 defect left it at 0.967. Anything
# above this is "the schedule did not finish", not "the schedule is a little
# conservative" — the two are not a matter of degree.
ANNEAL_MAX = 0.01

# §7.1 vocabulary. The tokenizer sizes the embedding, so a mismatch here is
# the difference between a model that can use its artifact and one that cannot.
EXPECTED_VOCAB = 16_384
CONFIG_NAME = "A"
DEFAULT_WARMUP = 10  # training/scripts/train_smoke.py --warmup default


class Report:
    """Collects checks so the script can print all of them, not just the first.

    Three states, not two. A check whose input is unusable must be able to say
    "NOT TESTED" instead of guessing, because that is exactly how v2 got filed
    as a good run: its `anneal` check read the LR out of a file whose LR was
    step 0's, got 0.5% of peak, and printed PASS. A green tick from evidence
    that cannot support one is worse than a red one.
    """

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def add(self, name: str, ok: bool, detail: str) -> bool:
        self.rows.append((name, "PASS" if ok else "FAIL", detail))
        return ok

    def skip(self, name: str, detail: str) -> None:
        self.rows.append((name, "SKIP", detail))

    @property
    def failed(self) -> list[str]:
        return [n for n, s, _ in self.rows if s == "FAIL"]

    def print(self) -> None:
        width = max(len(n) for n, _, _ in self.rows)
        for name, status, detail in self.rows:
            print(f"  {status:<4}  {name:<{width}}  {detail}")
        print()
        if self.failed:
            print(f"FAILED: {', '.join(self.failed)}  "
                  f"({len(self.failed)} of {len(self.rows)})")
        else:
            skipped = [n for n, s, _ in self.rows if s == "SKIP"]
            note = f" — {len(skipped)} not tested: {', '.join(skipped)}" if skipped else ""
            print(f"all {len(self.rows)} checks passed{note}")


def _load_schedule_definition():
    """The trainer's own learning-rate curve, imported rather than restated.

    The first version of this file carried a copy of `cosine_with_warmup`'s
    arithmetic marked "verbatim". That is a copy of the thing being verified,
    which is worse than useless: the day the curve changes, this tool keeps
    predicting the old one and reports correctly-saved checkpoints as
    mismatched. Importing means the tool follows the curve.

    Imported lazily so that `--help` and a bad-path error do not need numpy,
    and so that a box without the package still prints a reason instead of an
    ImportError traceback.
    """
    from training.scripts.train_smoke import lr_factor, schedule_span

    return lr_factor, schedule_span


def reconstruct(total_micro_steps: int, last_epoch: int, recorded: float,
                peak: float, warmup: int, factor, schedule_span,
                max_accum: int = 64) -> dict | None:
    """Which `(grad_accum, warmup)` reproduces the recorded LR at this step?

    Returns the best match, or None. A guess that cannot be beaten by the
    evidence is a claim; picking the closest candidate is a measurement with
    a residual attached, and the residual is reported so it can be judged.

    Both parameters are searched because a checkpoint written before the
    hyperparameters were recorded has to be read without them, and on v2
    searching `grad_accum` alone could not land on the answer: the file's LR
    is `peak / 200`, which needs `warmup=200` (Stage A's setting) as well as
    the `grad_accum=1` that the search found. Reporting only the second half
    of that pair would have named half the defect.

    `factor` and `schedule_span` are passed in rather than read from module
    scope. The first version of this refactor left the imported names as locals
    inside `main`, so this function raised `NameError: schedule_span` on exactly
    one path — the one with no recorded hyperparameters, which is v2's, and
    which no test covered at the time. Parameters make the dependency visible
    and make the function callable from a test without an import dance.

    `total_micro_steps` is the run's `--steps`, **not** the checkpoint's step,
    and the distinction is not cosmetic: the schedule was built over the former.
    The first version took the checkpoint's step and was right only by accident,
    because it was written against a completed run (step 20000 of a 20,000-step
    run). Aimed at a session that the time box cut short — the case this whole
    exercise is about — it would have divided the schedule by the wrong total
    and reported a confidently wrong grad-accum. `main` now passes the run's own
    `--steps` where it is known and says plainly what it assumed where it is not.
    """
    if peak <= 0:
        return None
    warmups = sorted({warmup, 10, 20, 50, 100, 200, 250, 500, 1000, 2000})
    best = None
    for g in range(1, max_accum + 1):
        for w in warmups:
            warmup_u, updates = schedule_span(total_micro_steps, w, g)
            predicted = peak * factor(last_epoch, warmup_u, updates)
            err = abs(predicted - recorded) / max(abs(recorded), 1e-12)
            if best is None or err < best["rel_error"]:
                best = {"grad_accum": g, "warmup": w, "updates": updates,
                        "warmup_updates": warmup_u, "predicted_lr": predicted,
                        "rel_error": err}
    return best


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ckpt", required=True, help="path to latest.pt or best.pt")
    ap.add_argument("--config", default=CONFIG_NAME, help="config name the run claims")
    ap.add_argument("--expect-vocab", type=int, default=EXPECTED_VOCAB)
    ap.add_argument("--expect-params", type=int, default=EXPECTED_PARAMS)
    ap.add_argument("--warmup", type=int, default=DEFAULT_WARMUP,
                    help="--warmup the run used, in micro-steps")
    ap.add_argument("--grad-accum-hint", default="8",
                    help="the --grad-accum the notebook passed, quoted in the "
                         "inference note so the two can be compared")
    ap.add_argument("--total-steps", type=int, default=None,
                    help="the run's --steps (micro-steps). The cosine was built "
                         "over this, not over the checkpoint's step. Defaults "
                         "to the checkpoint's step, which is only correct for a "
                         "run that reached its end — said out loud when assumed.")
    ap.add_argument("--allow-defective-lr", action="store_true",
                    help="report the anneal ratio without failing on it")
    ap.add_argument("--json", help="write the results to this path")
    args = ap.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    import torch

    from ai.model import plan
    from ai.model.config import CONFIGS
    from ai.model.model import build
    from training.scripts.checkpoint import (REQUIRED_STATE_KEYS,
                                             MissingStateError,
                                             assert_state_fresh)

    factor, schedule_span = _load_schedule_definition()

    path = Path(args.ckpt)
    if not path.is_file():
        print(f"no checkpoint at {path}", file=sys.stderr)
        return 2
    size = path.stat().st_size

    print(f"\n{'═' * 68}")
    print(f"  {path.name}  {size / 1e6:,.1f} MB  ({size:,} bytes)")
    print(f"{'═' * 68}\n")

    state = torch.load(path, map_location="cpu", weights_only=False)
    r = Report()

    # ── keys ────────────────────────────────────────────────────────
    if not isinstance(state, dict):
        r.add("type", False, f"loaded as {type(state).__name__}, not a state dict")
        r.print()
        return 1
    r.add("type", True, "state dict")
    missing = [k for k in REQUIRED_STATE_KEYS if k not in state]
    r.add("keys", not missing,
          f"all {len(REQUIRED_STATE_KEYS)} required keys present" if not missing
          else f"missing {missing}")
    extra = sorted(set(state) - set(REQUIRED_STATE_KEYS))
    if extra:
        print(f"  note: non-required keys also present: {extra}")

    # ── step / provenance ───────────────────────────────────────────
    step = int(state.get("step", 0))
    r.add("step", step > 0, f"step {step:,}")
    print(f"  info  tokenizer {state.get('tokenizer_version')!r} · "
          f"git {state.get('git_commit')!r} · saved_at {state.get('saved_at')!r}")
    cursor = state.get("data_cursor") or {}
    if "tokens_consumed" in cursor:
        print(f"  info  {cursor['tokens_consumed']:,} tokens consumed by the batcher")

    # ── config parity ───────────────────────────────────────────────
    stored = state.get("config") or {}
    live_cfg = CONFIGS[args.config]
    drift = []
    for field_name in ("vocab_size", "hidden_size", "num_hidden_layers",
                       "num_attention_heads", "num_key_value_heads",
                       "intermediate_size", "max_position_embeddings"):
        want = getattr(live_cfg, field_name)
        got = stored.get(field_name)
        if got is not None and got != want:
            drift.append(f"{field_name}: checkpoint {got}, config {args.config} {want}")
    r.add("config", not drift,
          f"matches config {args.config}"
          + (f" (vocab {stored.get('vocab_size'):,})" if stored.get("vocab_size") else "")
          if not drift else "; ".join(drift))
    vocab = int(stored.get("vocab_size") or 0)
    r.add("vocab", vocab == args.expect_vocab,
          f"vocab_size {vocab:,}" + ("" if vocab == args.expect_vocab
                                     else f" (expected {args.expect_vocab:,})"))

    # ── materialised strict load + parameter count ──────────────────
    from dataclasses import replace

    cfg = replace(live_cfg, vocab_size=vocab or live_cfg.vocab_size)
    model = build(cfg, torch.device("cpu"))
    sd = state.get("model") or {}
    try:
        model.load_state_dict(sd, strict=True)
        r.add("strict load", True,
              f"{len(sd)} tensors loaded with no missing or unexpected keys")
    except Exception as exc:  # noqa: BLE001
        # torch's strict-load error is one enormous multi-line string listing
        # every mismatched tensor. First line, then a count: the reader needs
        # to know it failed and roughly how badly, and the full text is worth
        # several screens of a terminal.
        first = str(exc).strip().splitlines()[0]
        lines = len(str(exc).strip().splitlines())
        r.add("strict load", False,
              f"{exc.__class__.__name__}: {first} ({lines} lines of detail)")
    actual = sum(p.numel() for p in model.parameters())
    analytic = plan.counts(cfg)["total"]
    r.add("params", actual == analytic == args.expect_params,
          f"{actual:,} materialised · {analytic:,} analytic · "
          f"{args.expect_params:,} expected")

    # ── the anneal check ────────────────────────────────────────────
    # Three readings, because they failed in different ways on different runs.
    #
    # * What the *file* says: where the schedule was when it was written.
    # * What it *should* say: predicted from the run's own recorded
    #   hyperparameters, which is exact rather than a guess.
    # * What it *implies*: reconstructed by scanning candidate grad-accum
    #   values, which is what identifies a schedule built in the wrong unit
    #   when the hyperparameters were never recorded at all.
    #
    # v2 disagreed with itself. The file held step 0's scheduler, at 0.5% of
    # peak, while the log showed the live schedule finishing at 96.7%. A
    # verifier that only read the file would have called that annealed.
    sched = state.get("scheduler") or {}
    groups = ((state.get("optimizer") or {}).get("param_groups") or [{}])
    peak = float(groups[0].get("initial_lr") or 0.0)
    current = float(groups[0].get("lr") or 0.0)
    last_lr = float((sched.get("_last_lr") or [current])[0])
    last_epoch = int(sched.get("last_epoch", 0) or 0)
    ratio = (last_lr / peak) if peak > 0 else float("nan")
    # Computed here rather than down with the `fresh` row, because the inference
    # below needs it to qualify its own assumption. It was read before it was
    # assigned for one full run of this tool — an UnboundLocalError on exactly
    # the path with no recorded hyperparameters, which is v2's.
    moments = (state.get("optimizer") or {}).get("state")
    is_fresh = bool(isinstance(moments, dict) and moments) and last_epoch > 0
    hyper = state.get("hyperparameters")
    # Only meaningful for the inferred path, where the run's total step count
    # had to be supplied or assumed. Reset to None when the file records its own
    # settings, so the JSON never carries a number that nothing used.
    total_steps: int | None = None

    print(f"\n  learning rate")
    print(f"    peak (initial_lr)  {peak:.4e}")
    print(f"    current (lr)      {current:.4e}")
    print(f"    last (_last_lr)   {last_lr:.4e}  at scheduler step {last_epoch:,}")
    print(f"    ratio             {ratio:.4f}  ({ratio * 100:.1f}% of peak)")

    match = None
    if isinstance(hyper, dict) and {"grad_accum", "steps", "warmup"} <= set(hyper):
        warmup_u, updates = schedule_span(int(hyper["steps"]),
                                          int(hyper["warmup"]),
                                          int(hyper["grad_accum"]))
        expected = peak * factor(last_epoch, warmup_u, updates)
        residual = abs(expected - last_lr) / max(abs(last_lr), 1e-12)
        print(f"    expected          {expected:.4e}  from the run's own record "
              f"({int(hyper['grad_accum'])} updates, {warmup_u} warmup, "
              f"steps {int(hyper['steps']):,}) — residual {residual:.2e}")
        match = {"grad_accum": int(hyper["grad_accum"]), "updates": updates,
                 "warmup_updates": warmup_u, "predicted_lr": expected,
                 "rel_error": residual, "source": "recorded"}
    else:
        # The cosine spans the run's `--steps`, so that is what the prediction
        # has to be built over. Falling back to the checkpoint's step assumes the
        # run reached its end, which is true of a completed run and false of one
        # the session cap cut short — so when it is assumed rather than known,
        # say so, and say whether the evidence is consistent with it.
        total_steps = args.total_steps if args.total_steps else step
        if args.total_steps:
            print(f"    total steps       {total_steps:,} (given)")
        else:
            ended = is_fresh and abs(last_lr) <= peak * ANNEAL_MAX
            print(f"    total steps       {total_steps:,} (assumed = the "
                  f"checkpoint's step; a completed cosine ends at 0, which is "
                  f"{'what this looks like' if ended else 'NOT what this looks like'}"
                  f" — pass --total-steps to say instead of assume)")
        match = reconstruct(total_steps, last_epoch, last_lr, peak, args.warmup,
                            factor, schedule_span)
        if match:
            match["source"] = "inferred"
            verdict = "exact" if match["rel_error"] < 1e-6 else "closest"
            print(f"    inferred          grad_accum={match['grad_accum']}, "
                  f"warmup={match['warmup']} ({match['updates']:,} updates, "
                  f"{match['warmup_updates']} warmup) -> "
                  f"{match['predicted_lr']:.4e}, {verdict} "
                  f"(residual {match['rel_error']:.2e})")
            print(f"      no hyperparameters in the file, so the schedule was "
                  f"reconstructed by scanning.\n      grad_accum="
                  f"{match['grad_accum']} against a run that passed "
                  f"{args.grad_accum_hint} is the *defect*: the cosine was built\n"
                  f"      over micro-steps, so it never annealed.")

    # Observed staleness, reported before the trainer's own verdict. The guard
    # stops at the first thing it can prove, which for a pre-fix file is the
    # missing hyperparameters — true, and not the thing a reader needs to know.
    obs = []
    if isinstance(moments, dict):
        obs.append(f"optimizer holds moments for {len(moments)} tensors")
    if "last_epoch" in sched:
        obs.append(f"scheduler at last_epoch {last_epoch}")
    r.add("fresh", is_fresh, "; ".join(obs) or "no optimizer/scheduler fields to read")

    # The staleness guard is the trainer's own, so the verifier and the loader
    # cannot disagree about what counts as resumable.
    try:
        assert_state_fresh(state, path.name)
        r.add("loadable", True, "the trainer's guard would accept this resume")
    except MissingStateError as exc:
        r.add("loadable", False, f"{exc.__class__.__name__}: {exc}")

    if not is_fresh:
        # The LR in the file is the LR from before the first optimizer update.
        # Comparing it to peak says nothing about whether the run annealed, so
        # say nothing rather than print a tick.
        r.skip("anneal", "the file's LR is step 0's, not the run's final LR — "
                        "this cannot be measured from this file")
    else:
        ok_anneal = math.isfinite(ratio) and ratio <= ANNEAL_MAX
        r.add("anneal", ok_anneal or args.allow_defective_lr,
              f"final LR is {ratio * 100:.1f}% of peak"
              + ("" if ok_anneal else f" — the schedule did not anneal "
                                      f"(§ schedule_span)"))
    if match is None:
        r.skip("schedule", "no learning rate to reconstruct")
    elif match["source"] == "recorded":
        # The run recorded its own settings, so this is a real comparison and
        # a clean residual means the file and the settings agree.
        r.add("schedule", match["rel_error"] < 1e-6,
              f"checkpointed LR reproduced from the recorded settings "
              f"(grad_accum={match['grad_accum']}, "
              f"residual {match['rel_error']:.2e})")
    else:
        # No settings in the file. Reproducing the LR exactly still fails the
        # check if it needed *different* settings to do it: on v2 the file's
        # LR is only reachable with grad_accum=1 and 20,000 updates, which is
        # the schedule built in micro-steps — the defect, found in the file.
        agrees = str(match["grad_accum"]) == str(args.grad_accum_hint)
        r.add("schedule", agrees and match["rel_error"] < 1e-3,
              f"inferred grad_accum={match['grad_accum']} (run passed "
              f"{args.grad_accum_hint}), {match['updates']:,} updates — "
              + ("matches the run's settings"
                 if agrees else "the cosine was built over micro-steps"))

    print()
    r.print()

    results = {
        "checkpoint": str(path), "bytes": size, "step": step,
        "tokenizer_version": state.get("tokenizer_version"),
        "git_commit": state.get("git_commit"),
        "config": stored, "params": actual, "analytic_params": analytic,
        "peak_lr": peak, "final_lr": float(last_lr), "anneal_ratio": ratio,
        "scheduler": {"last_epoch": last_epoch},
        "fresh": is_fresh,
        "total_steps": total_steps,
        "reconstructed": match,
        "checks": [{"name": n, "status": s, "detail": d} for n, s, d in r.rows],
        "failed": r.failed,
    }
    if args.json:
        Path(args.json).write_text(
            json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.json}")

    return 1 if r.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
