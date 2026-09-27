"""inference/sample_answers.py — see what a checkpoint actually answers.

    # the shipped stage-A model on four real prompts
    python inference/sample_answers.py --checkpoint training/checkpoints/local --n 4

    # stage A vs stage B, same prompts, side by side
    python inference/sample_answers.py \
        --checkpoint stage-A=training/checkpoints/local \
        --checkpoint stage-B=training/checkpoints/sft-local --n 4

WHY. Every quality claim in this repo is downstream of "what does the model
emit", and until now the only way to see that was to export the checkpoint,
serve the site and drive a browser (`dev-ai-probe.js`). That is the right
end-to-end check and the wrong inner loop: a Stage B run that has learned the
runtime frame but not yet the answer, or one that has collapsed into echoing
the prompt, is visible in a sentence and invisible in a loss curve.

So this is a *sampler*, not a metric. It takes the prompt the runtime would
build — the first `--n` examples of `data/instruction/sft.jsonl` cut at
`<|asst|>`, which is the frame the model is trained to continue — greedy
decodes `--tokens` from it, and prints what came back. It reports the prompt
echo rate because that is the failure a small model falls into first: the
answer that is a verbatim copy of the input scores a low loss and is useless.

The decode goes through `inference/reference.py` — the same numpy forward the
JS engine is verified against — so the output here and the output in the
browser come from the same arithmetic.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[1]

from ai.tokenizer import spec  # noqa: E402

ASST = spec.SPECIAL_TOKENS[3]
END = spec.SPECIAL_TOKENS[4]


def prompt_from_example(text: str) -> str:
    """The runtime frame for one example: everything up to and including `<|asst|>`.

    This is exactly what the browser feeds the model, so a sample taken from
    here is comparable to a probe capture. An example with no `<|asst|>` is not
    a prompt at all, and raising is better than sampling from a question.
    """
    at = text.find(ASST)
    if at == -1:
        raise ValueError("this example has no <|asst|> turn, so it cannot be a prompt")
    return text[:at + len(ASST)]


def read_prompts(data: Path, count: int, category: str | None = None) -> list[dict]:
    rows: list[dict] = []
    with Path(data).open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if category and row.get("category") != category:
                continue
            rows.append({
                "prompt": prompt_from_example(row["text"]),
                "question": row["text"][row["text"].find(spec.SPECIAL_TOKENS[2]) + len(spec.SPECIAL_TOKENS[2]):
                                         row["text"].find(ASST)].strip(),
                "category": row.get("category", ""),
                "lang": row.get("lang", ""),
            })
            if len(rows) >= count:
                break
    if not rows:
        raise SystemExit(f"no examples matched in {data}")
    return rows


def sample(checkpoint: Path | str, which: str, prompts: list[dict], tokenizer,
           max_tokens: int, stop_on_abstain: bool = False) -> list[dict]:
    import numpy as np

    from inference import reference
    from inference.export_browser import load_checkpoint

    run_dir = Path(checkpoint)
    state, cfg, provenance = load_checkpoint(run_dir, which)
    weights = reference.torch_state_dict_to_numpy(state)
    stop = {tokenizer.token_to_id(END)}
    if stop_on_abstain:
        stop.add(tokenizer.token_to_id("<|abstain|>"))

    out = []
    for row in prompts:
        ids = list(tokenizer.encode(row["prompt"]).ids)
        generated = reference.greedy(weights, cfg, ids, max_tokens, stop)
        answer = tokenizer.decode(generated, skip_special_tokens=False)
        out.append({**row, "tokens": len(generated), "answer": answer,
                    "stopped": bool(generated and generated[-1] in stop),
                    "echoes_prompt": _echoes(answer, row),
                    "checkpoint": str(run_dir), "which": which,
                    "step": provenance.get("step")})
    return out


def _echoes(answer: str, row: dict) -> bool:
    """Does the answer reproduce the context or the question instead of answering?

    Measured, not judged: the comparison is on words, so it catches "the model
    learned to copy the passage", which is the failure mode the counterfactual
    half of §7.4 exists to prevent.
    """
    words = [w for w in answer.split() if len(w) > 3]
    if not words:
        return False
    source = (row["prompt"] + " " + row.get("question", "")).split()
    overlap = sum(1 for w in words if w in source)
    return overlap / len(words) > 0.8


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", action="append", required=True,
                    help="run dir, optionally as name=dir (repeatable)")
    ap.add_argument("--which", default="latest", help="latest | best | step_N")
    ap.add_argument("--data", default=str(ROOT / "data" / "instruction" / "sft.jsonl"))
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--tokens", type=int, default=32)
    ap.add_argument("--category", default=None)
    ap.add_argument("--stop-on-abstain", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    from ai.tokenizer.train import load

    tokenizer, meta = load(ROOT / "ai" / "tokenizer" / "artifacts" / "seed-1k")
    prompts = read_prompts(Path(args.data), args.n, args.category)
    print(f"{len(prompts)} prompts from {Path(args.data).name} "
          f"({meta['tokenizer_version']}), greedy, ≤{args.tokens} tokens\n")

    results = {}
    for entry in args.checkpoint:
        name, _, path = entry.partition("=")
        if not path:
            name, path = Path(entry).name, entry
        rows = sample(path, args.which, prompts, tokenizer, args.tokens,
                      args.stop_on_abstain)
        results[name] = rows
        print(f"── {name}  ({path}, {args.which})")
        for row in rows:
            print(f"   {row['category']}/{row['lang']}  {row['question'][:60]}")
            print(f"     → {row['answer']!r}"
                  f"{'  [echoes the prompt]' if row['echoes_prompt'] else ''}")
        print()

    flat = [row for rows in results.values() for row in rows]
    echoed = sum(1 for row in flat if row["echoes_prompt"])
    print(f"echo rate: {echoed}/{len(flat)} samples repeat the prompt "
          f"({echoed / len(flat):.0%}) — a sampler reading, not a §14 metric")
    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
