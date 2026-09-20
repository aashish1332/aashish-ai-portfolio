"""inference/count_parameters.py — print the parameter count (§7.1).

    python inference/count_parameters.py            # config A, the §7.1 target
    python inference/count_parameters.py --config smoke --gate
    python inference/count_parameters.py --config lite
    python inference/count_parameters.py --all

Two derivations, one number:

1. **Analytic** — `ai/model/plan.py` computes every parameter from the
   config, grouped by component. This runs anywhere, including on a
   machine with no torch (which is the machine this was developed on).
2. **Materialised** — when torch is importable, the real `LlamaForCausalLM`
   is built and its `state_dict` is checked name-by-name and shape-by-shape
   against the analytic schema, then `sum(p.numel())` is compared to the
   analytic total. A mismatch exits non-zero.

That second step is the part worth insisting on: a parameter count that is
only ever computed by hand is a claim, not a measurement.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai.model import plan  # noqa: E402
from ai.model.config import CONFIGS, CONFIG_A, ModelConfig  # noqa: E402

# §7.1: "target 30–50M, ~40M preferred".
TARGET_MIN, TARGET_MAX, TARGET_PREFERRED = 30_000_000, 50_000_000, 40_000_000
LITE_MIN, LITE_MAX = 12_000_000, 22_000_000


def fmt(n: int) -> str:
    return f"{n:,}"


def report(cfg: ModelConfig, stream=sys.stdout) -> dict:
    c = plan.counts(cfg)
    table = plan.param_table(cfg)
    table_total = plan.table_total(cfg)
    kv_token = plan.kv_cache_per_token(cfg)
    kv_ctx = plan.kv_cache_bytes(cfg, cfg.max_position_embeddings)
    flops = plan.flops_estimate(cfg, cfg.max_position_embeddings)

    print(f"\n{'─' * 68}", file=stream)
    print(f"{cfg.summary()}", file=stream)
    print(f"{'─' * 68}", file=stream)
    if cfg.notes:
        print(f"  {cfg.notes}", file=stream)

    print(f"\n  parameters by component", file=stream)
    for key in ("embeddings", "attention", "mlp", "norms"):
        share = 100 * c[key] / c["total"]
        print(f"    {key:<12} {fmt(c[key]):>14}  {share:5.1f}%", file=stream)
    if c["output_head"]:
        print(f"    {'output_head':<12} {fmt(c['output_head']):>14}", file=stream)
    else:
        print(f"    {'output_head':<12} {'tied to embeddings':>14}", file=stream)
    print(f"    {'per layer':<12} {fmt(c['per_layer']):>14}", file=stream)
    print(f"    {'TOTAL':<12} {fmt(c['total']):>14}  "
          f"({c['total'] / 1e6:.2f}M, {cfg.num_hidden_layers} layers)", file=stream)

    print(f"\n  state-dict keys: {len(table)} "
          f"(lm_head {'tied' if cfg.tie_word_embeddings else 'not tied'})", file=stream)

    print(f"\n  KV cache  {kv_token / 1024:.2f} KB/token @fp16 → "
          f"{kv_ctx / 1024 / 1024:.1f} MB at ctx {cfg.max_position_embeddings}", file=stream)
    print(f"  compute   prefill {flops['prefill_flops'] / 1e9:.1f} GFLOP @ "
          f"{flops['tokens']} tokens · decode {flops['decode_one_token_flops'] / 1e9:.1f} "
          f"GFLOP/token @ctx {cfg.max_position_embeddings} (estimate)", file=stream)

    parity = verify(cfg, stream)
    target = target_verdict(cfg, c["total"])
    return {"config": cfg.name, "params": c["total"], "counts": c,
            "table_total": table_total, "kv_per_token": kv_token,
            "kv_at_ctx": kv_ctx, "flops": flops, "torch": parity,
            "target": target}


def verify(cfg: ModelConfig, stream=sys.stdout) -> dict:
    """Build the real module and compare. Skips honestly without torch."""
    try:
        import torch  # noqa: F401
    except ImportError as exc:  # pragma: no cover - environment dependent
        print("\n  torch: NOT INSTALLED → the materialised check did not run "
              f"({exc.__class__.__name__}).", file=stream)
        print("  The analytic count above is derived from the config, not "
              "measured from a module.", file=stream)
        return {"available": False, "reason": "torch not installed"}

    from ai.model.model import build

    model = build(cfg)
    schema = model.assert_matches_schema()
    actual = model.param_count()
    analytic = plan.counts(cfg)["total"]
    status = "MATCH" if actual == analytic else "MISMATCH"
    print(f"\n  torch {torch.__version__}: {fmt(actual)} params, "
          f"{schema['keys']} state-dict keys — {status} the analytic schema",
          file=stream)
    if actual != analytic:
        print(f"    analytic {fmt(analytic)} vs materialised {fmt(actual)}",
              file=stream)
        raise SystemExit(2)
    return {"available": True, "params": actual, "keys": schema["keys"],
            "torch": torch.__version__, "match": True}


def target_verdict(cfg: ModelConfig, total: int) -> dict:
    """Is this config inside the band §7.1 asks for?"""
    if cfg.name == "A":
        ok = TARGET_MIN <= total <= TARGET_MAX
        note = (f"§7.1 target {TARGET_MIN / 1e6:.0f}–{TARGET_MAX / 1e6:.0f}M "
                f"(~{TARGET_PREFERRED / 1e6:.0f}M preferred)")
    elif cfg.name == "lite":
        ok = LITE_MIN <= total <= LITE_MAX
        note = f"§7.1 lite contingency ~{LITE_MIN / 1e6:.0f}–{LITE_MAX / 1e6:.0f}M"
    else:
        ok = 1_000_000 <= total <= 3_000_000
        note = "§7.5 smoke band 1–3M"
    print(f"\n  {note}: {'PASS' if ok else 'FAIL'} at {total / 1e6:.2f}M", )
    return {"band": note, "pass": ok}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Count model parameters (§7.1)")
    ap.add_argument("--config", default="A", choices=sorted(CONFIGS) + ["all"])
    ap.add_argument("--json", help="write the full report to this path")
    ap.add_argument("--gate", action="store_true",
                    help="exit non-zero if the config misses its §7.1 band")
    args = ap.parse_args(argv)

    names = sorted(CONFIGS) if args.config == "all" else [args.config]
    reports = []
    for name in names:
        cfg = CONFIGS[name] if name != "A" else CONFIG_A
        print(f"\n{'═' * 68}")
        print(f"  config {name.upper()}")
        print(f"{'═' * 68}")
        reports.append(report(cfg))

    if args.json:
        Path(args.json).write_text(
            json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {args.json}")

    failed = [r for r in reports if not r["target"]["pass"]]
    if args.gate and failed:
        print(f"\nGATE FAILED for {[r['config'] for r in failed]}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
