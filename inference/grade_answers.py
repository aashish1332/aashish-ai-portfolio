"""inference/grade_answers.py — decode a checkpoint's answers for the §14 prompts.

    # 1. the prompts the browser would send (Node, needs no model)
    node tools/model-eval.mjs --emit-prompts docs/EVAL_PROMPTS.json

    # 2. this: greedy-decode them from a checkpoint
    python inference/grade_answers.py --checkpoint training/checkpoints/sft-local \\
        --prompts docs/EVAL_PROMPTS.json --out docs/EVAL_ANSWERS.json

    # 3. score them with the shipped guard and the §14 gates (Node)
    node tools/model-eval.mjs --grade docs/EVAL_ANSWERS.json --json docs/EVALUATION.json

WHY PYTHON DECODES AND NODE SCORES. The model exists in Python (training,
`inference/reference.py`) and the *rules* — the guard, the placeholder
resolver, the language check — exist in JavaScript (`ai/guard/`,
`ai/knowledge/placeholders.mjs`), because that is where they run for a
visitor. Re-implementing either one to make a single-language grader possible
is how a grader and the thing it grades drift apart, so each half does what
it already owns. The answers file carries the prompts it was run against, so
the scoring step is reproducible from the file alone.

Decoding goes through `inference/reference.py` — the numpy forward the browser
engine is verified against — so a number measured here is about the same
arithmetic that ships. Greedy, not sampled: a metric that moves when the
sample moves is not a measurement (`--sample` exists for a spot check and
records the seed in the report).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[1]


def decode_all(checkpoint: Path, which: str, prompts: list[dict], tokenizer,
               max_new_tokens: int, stop: set[int], sample: bool = False,
               seed: int = 0) -> tuple[list[dict], dict]:
    """One greedy continuation per prompt, plus provenance for the report."""
    import numpy as np

    from inference import reference
    from inference.export_browser import load_checkpoint

    state, cfg, provenance = load_checkpoint(checkpoint, which)
    weights = reference.torch_state_dict_to_numpy(state)
    rng = np.random.default_rng(seed)

    answers = []
    started = time.time()
    for row in prompts:
        if row.get("route") != "model" or not row.get("prompt"):
            # The app decides this one before the generator is asked — §9's
            # injection reply, the identity disclosure, the §8.4 bait refusal.
            # Grading it as a model answer would measure the wrong component.
            answers.append({"id": row["id"], "answer": row.get("answer") or "",
                            "decoded": 0, "route": row["route"], "ms": 0.0})
            continue
        ids = list(tokenizer.encode(row["prompt"]).ids)
        at = time.time()
        if sample:
            generated = reference.sample(weights, cfg, ids, max_new_tokens, stop,
                                         rng) if hasattr(reference, "sample") else None
            if generated is None:
                raise SystemExit("--sample needs inference/reference.sample(), which "
                                 "this revision does not have; use greedy")
        else:
            generated = reference.greedy(weights, cfg, ids, max_new_tokens, stop)
        answers.append({
            "id": row["id"],
            "answer": tokenizer.decode(generated, skip_special_tokens=False),
            "ids": generated,
            "decoded": len(generated),
            "route": row["route"],
            "ms": round((time.time() - at) * 1000, 1),
        })
    return answers, {
        "checkpoint": str(checkpoint),
        "which": which,
        "step": provenance.get("step"),
        "provenance": provenance,
        "decode_seconds": round(time.time() - started, 2),
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="Decode a checkpoint on the §14 evaluation prompts")
    ap.add_argument("--prompts", required=True, help="docs/EVAL_PROMPTS.json from tools/model-eval.mjs")
    ap.add_argument("--checkpoint", required=True, help="a run directory")
    ap.add_argument("--which", default="latest", help="latest | best | step_N")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tokenizer", default=str(ROOT / "ai" / "tokenizer" / "artifacts" / "seed-1k"))
    ap.add_argument("--max-tokens", type=int, default=96)
    ap.add_argument("--ids", default=None,
                    help="comma-separated case ids to run (a quick pass, not a full report)")
    ap.add_argument("--sample", action="store_true", help="sample instead of greedy")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)

    from ai.tokenizer.train import load

    payload = json.loads(Path(args.prompts).read_text(encoding="utf-8"))
    rows = payload["prompts"]
    if args.ids:
        wanted = {i.strip() for i in args.ids.split(",") if i.strip()}
        rows = [r for r in rows if r["id"] in wanted]
    if not rows:
        raise SystemExit("no prompts selected")

    tokenizer, meta = load(args.tokenizer)
    stop = set(payload.get("stopIds") or [])
    if payload.get("abstainId") is not None:
        # §9: `<|abstain|>` is checked before the guard, and generation stops
        # on it in the app; stopping here keeps the tail from being scored as
        # an answer to the question the model already refused.
        stop.add(payload["abstainId"])
    if not stop:
        raise SystemExit("the prompts file carries no stop ids — regenerate it with "
                         "`node tools/model-eval.mjs --emit-prompts`")

    print(f"decoding {len(rows)} prompts from {args.checkpoint} ({args.which}), "
          f"≤{args.max_tokens} tokens, tokenizer {meta['tokenizer_version']}")
    answers, provenance = decode_all(Path(args.checkpoint), args.which, rows, tokenizer,
                                     args.max_tokens, stop, args.sample, args.seed)

    out = {
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "promptsFile": str(args.prompts),
        "tokenizerVersion": meta["tokenizer_version"],
        "maxNewTokens": args.max_tokens,
        "sampled": bool(args.sample),
        "seed": args.seed if args.sample else None,
        **provenance,
        "prompts": rows,
        "answers": answers,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
    decoded = [a for a in answers if a.get("route") == "model"]
    print(f"  {len(decoded)} decoded · {sum(a['decoded'] for a in decoded)} tokens · "
          f"{provenance['decode_seconds']}s")
    for a in decoded[:5]:
        print(f"    {a['id']}  {a['decoded']:>3} tok  {a['answer'][:70]!r}")
    print(f"wrote {args.out}")
    print(f"next: node tools/model-eval.mjs --grade {args.out} --json docs/EVALUATION.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
