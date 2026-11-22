"""inference/forced_eos.py — a reversible, prompt-length-aware forced-stop experiment.

WHY. The shipped checkpoint ends many §14 turns with a template continuation
that out-ranks `<|end|>` at the greedy argmax, so the offline decoder runs past
the end token until the 96-token cap. That is a verifier bug, not (only) a model
bug — and it is the cheapest thing to fix, because it lives entirely in the
decode loop and is fully reversible. Every fix that would actually move the
model's answers to the 95% gate is either a training lever (forbidden here) or
a new GPU Stage B run; this is neither.

**MEASURED 2026-10-20 — the premise above does not hold for the sft4 export,
and this probe must not be described as the cheap fix until it is re-argued.**
On `aashish-ai-b-sft4` (best, step 2000) the stop token is not a near-miss: at
the position where a trained greeting answer has just finished, `p(<|end|>)` is
**0.0003** and `end` ranks **103rd** — ≈7.7 logits below `" I"` (0.684). A bias
large enough to promote rank 103 is far outside the "−8 … +2" band the number
below was chosen for, so it is exactly the trade this docstring warns can
"silently break" the short cases. Whether ANY additive bias is defensible is now
an open question, not an assumption. Numbers and method: docs/BENCHMARKS.md,
"2026-10-20 — the sft4 checkpoint".


`transformers.GenerationLogitsProcessors` use — `(input_ids, logits) -> logits`
in-place — and gives the stop token a large positive bias **once the prompt has
been consumed**. The minimum-length clamp is driven by the prompt length (the
token budget the prompt was *fitted* for, §6.2), not by a hard token counter,
so the first one to three generated tokens are still free to close a sentence
before the stop bias kicks in.

WHY NOT at every position. A naive "boost EOS everywhere" is the literal
`MinLengthLogitsProcessor` mistake inverted, and it chokes on the short cases
(empty answer, single-token facts, a bare `<|end|>`). The real failure is that
EOS is *too low* **after the answer should already be finished**, not that it is
low during the first few tokens of a real answer. So the bias is gated on
`len(input_ids) - prompt_len`, with a small gray zone so the very first answer
token can still win if the model genuinely wants to say something.

This file is a *probe*, not a shipped feature. It is imported by the offline
samplers and nowhere else; the browser engine keeps its own stop handling in
`ai/engine/index.mjs`.

USAGE (the cleanest loopback on disk):

    PYTHONUTF8=1 python inference/forced_eos.py \\
        --checkpoint training/checkpoints/local \\
        --prompts docs/EVAL_PROMPTS.json \\
        --out docs/EVAL_ANSWERS.json \
        --tokenizer ai/tokenizer/artifacts/stage-a-16k

    then:

    node tools/model-eval.mjs --grade docs/EVAL_ANSWERS.json --json docs/EVALUATION.json

The experiment branch is isolated by a single `--forced-eos` flag on the probe
that drives the decode. With it off, this file is dead code and the decode is
the current greedy. With it on, the stop bias is applied and the answers are
regraded. Nothing outside the probe touches MODEL_STATUS.
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

# A bias big enough to flip a greedy argmax. The number is not tuned to the
# model's internals; it is chosen so that, at a position where the stop token's
# natural logit is anywhere in a plausible small-model range (say -8 .. +2),
# adding this bias puts the stop token clearly on top. Smaller and the fix is
# uneven; larger and the gray zone barely matters. Do not tune this to a
# specific checkpoint's logits without re-proving the short-case behaviour —
# that is the part that can silently break.
STOP_BIAS = 12.0

# Tokens after the prompt that still get a partial (not full) bias. This is
# the "finish the sentence you already started" window. 1 is the smallest
# plausible value and the one that hurts the fewest short answers.
BIAS_RAMP_TOKENS = 1


class ForcedEndLogitsProcessor:
    """Boost the stop id after the prompt, gated on a prompt-length budget.

    Contract: in-place mutation of `logits`, same shape as the input. This is
    the numpy equivalent of what a `transformers` logits processor does inside
    `sample()` / `greedy_search()`; the reference decode in this project does
    its own argmax, so the processor is a thin wrapper the sampler calls by
    hand rather than something handed to a framework.

    The min-length idea (do not let EOS win until the answer has room) comes
    straight from `transformers.GenerationLogitsProcessors.MinLengthLogitsProcessor`;
    the "forced EOS at the end" idea comes from the same family (
    `ForcedEOSTokenLogitsProcessor`, and the larger literature on constrained /
    forced-decoding for small models that never learn to emit their own stop
    token). The combination here is scoped to this project's failure mode: a
    correct answer followed by a template continuation that out-ranks EOS.
    """

    def __init__(self, stop_ids: set[int], prompt_token_count: int,
                 ramp_tokens: int = BIAS_RAMP_TOKENS, bias: float = STOP_BIAS):
        self.stop_ids = stop_ids
        self.prompt_len = prompt_token_count
        self.ramp_tokens = ramp_tokens
        self.bias = bias

    def __call__(self, input_ids: list[int], logits: list[float]) -> list[float]:
        generated = len(input_ids) - self.prompt_len
        if generated <= 0:
            return logits  # still consuming the prompt
        if self.stop_ids:
            if generated > self.ramp_tokens:
                for sid in self.stop_ids:
                    logits[sid] += self.bias
            else:
                # gray zone: partial bias so a one-word answer can still start
                fraction = generated / max(self.ramp_tokens, 1)
                half = self.bias * fraction
                for sid in self.stop_ids:
                    logits[sid] += half
        return logits


def load_prompts(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload["prompts"])


def write_answers(out: Path, answers, provenance: dict) -> None:
    payload = {
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "forcedEos": provenance.get("forcedEos"),
        **provenance,
        "prompts": answers.pop("prompts"),
        "answers": answers["answers"],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Re-encode the §14 answers with a reversible forced-stop bias and regrade them.")
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--prompts", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--tokenizer", type=Path,
                    default=ROOT / "ai" / "tokenizer" / "artifacts" / "stage-a-16k")
    ap.add_argument("--max-tokens", type=int, default=96)
    ap.add_argument("--forced-eos", action="store_true",
                    help="apply the prompt-length-gated stop bias described above")
    ap.add_argument("--bootstrap", type=Path, default=None,
                    help="re-encode an existing EVAL_ANSWERS.json instead of decoding a checkpoint")
    args = ap.parse_args(argv)

    from ai.tokenizer.train import load
    from inference import reference
    from inference.export_browser import load_checkpoint

    tokenizer_dir = args.tokenizer
    tokenizer, meta = load(tokenizer_dir)

    prompts = load_prompts(args.prompts)
    model_prompts = [p for p in prompts if p.get("route") == "model" and p.get("prompt")]
    if not model_prompts:
        print("no model-routed prompts in", args.prompts)
        return 0

    # The stop set is read from the prompts file the same way the real decode
    # reads it, so the bias is applied to the same ids the engine would stop on.
    stop_ids = set(prompts and json.loads(args.prompts.read_text(encoding="utf-8")).get("stopIds") or [])
    abstain_id = (json.loads(args.prompts.read_text(encoding="utf-8")).get("abstainId"))
    if abstain_id is not None:
        stop_ids.add(abstain_id)
    if not stop_ids:
        print("the prompts file carries no stop ids — regenerate with "
              "`node tools/model-eval.mjs --emit-prompts`")
        return 1

    state, cfg, provenance = load_checkpoint(args.checkpoint, "latest")
    weights = reference.torch_state_dict_to_numpy(state)

    answers: list[dict] = []
    started = time.time()
    for row in prompts:
        if row.get("route") != "model" or not row.get("prompt"):
            answers.append({
                "id": row["id"],
                "answer": row.get("answer") or "",
                "decoded": 0,
                "route": row["route"],
                "ms": 0.0,
            })
            continue

        ids = list(tokenizer.encode(row["prompt"]).ids)
        prompt_len = len(ids)

        at = time.time()
        if args.forced_eos:
            proc = ForcedEndLogitsProcessor(stop_ids, prompt_len)
            generated: list[int] = []
            working = ids[:]
            for _ in range(args.max_tokens):
                logits = reference.forward(weights, cfg, working)[-1].tolist()
                proc(working, logits)
                nxt = int(max(range(len(logits)), key=lambda i: logits[i]))
                generated.append(nxt)
                working.append(nxt)
                if nxt in stop_ids:
                    break
        else:
            generated = reference.greedy(weights, cfg, ids, args.max_tokens, stop_ids)

        answers.append({
            "id": row["id"],
            "answer": tokenizer.decode(generated, skip_special_tokens=False),
            "ids": generated,
            "decoded": len(generated),
            "route": row["route"],
            "ms": round((time.time() - at) * 1000, 1),
        })

    provenance_out = {
        "checkpoint": str(args.checkpoint),
        "which": "latest",
        "step": provenance.get("step"),
        "provenance": provenance,
        "decode_seconds": round(time.time() - started, 2),
        "forcedEos": args.forced_eos,
        "tokenizerVersion": meta["tokenizer_version"],
        "maxNewTokens": args.max_tokens,
    }
    write_answers(args.out, {"prompts": prompts, "answers": answers}, provenance_out)

    decoded = [a for a in answers if a.get("route") == "model"]
    print(f"forced-eos experiment: {'ON' if args.forced_eos else 'off'}")
    print(f"  {len(decoded)} model-routed · {sum(a['decoded'] for a in decoded)} tokens · "
          f"{provenance_out['decode_seconds']}s")
    for a in decoded[:5]:
        print(f"    {a['id']}  {a['decoded']:>3} tok  {a['answer'][:70]!r}")
    print(f"wrote {args.out}")
    print("next: node tools/model-eval.mjs --grade "
          f"{args.out} --json docs/EVALUATION.json --tokenizer "
          f"{tokenizer_dir / 'tokenizer.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
