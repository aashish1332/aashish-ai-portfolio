"""inference/rerank_answers.py — pick the answer the model is most confident in.

    PYTHONUTF8=1 python inference/rerank_answers.py \
        --checkpoint kaggle-push/out/pull-bb1/checkpoints/stage-b --which latest \
        --prompts kaggle-push/out/eval-v3-prompts-fixed.json \
        --out kaggle-push/out/rerank-v1 --topk 8 --limit 2

WHY THIS EXISTS. Free-running greedy decode answers 14.7% of the §14
factual suite correctly with the config-B checkpoint (docs/EVALUATION.json).
The model usually *knows* the answer — 18/24 gold first tokens under teacher
forcing — but at the stop position a high-frequency template continuation
out-competes it by 7–10 nats, so free-running derails into boilerplate
(" Flagship project:") before reaching the answer. Three training-side
levers were measured and falsified against exactly this signal (corpus
variety, loss weight, capacity — REPORT-configB-final.md) and the
pre-registered rule forbids a fourth.

So this file changes the *inference rule*, not the training: the answer
space is closed (the KB's fact frames plus <|abstain|>), so instead of
generating we **enumerate every well-formed candidate answer and score it
under the same checkpoint with teacher forcing**, then take the argmax.
This is the small-model recipe the literature settled on: PET/cloze
scoring (Schick & Schütze, EACL 2021), length-aware multiple-choice
normalization (EleutherAI), and — the exact measured failure — surface-form
competition, compensated by conditional PMI (Holtzman et al., EMNLP 2021).

Determinism: scoring + argmax are pure functions of checkpoint and prompt —
greedy, temperature 0 — so §5.1 still holds. The training rule is untouched:
no fourth lever, same checkpoint as the falsification report.

Cost: one forward per fully-scored candidate. A single prompt forward ranks
*all* candidates by their first token; only the top-K get full teacher-forced
scores, so the suite costs minutes instead of the 76-minute free decode.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[1]

from ai.data import instruction as inst  # noqa: E402
from ai.tokenizer import spec  # noqa: E402

FACT = spec.PLACEHOLDER_RE


# ── small helpers ────────────────────────────────────────────────────

def logprob_of(row: np.ndarray, token_id: int) -> float:
    """log softmax of one logits row, in float64 (float32 logits lose nats)."""
    x = row.astype(np.float64)
    x = x - x.max()
    return float(x[token_id] - np.log(np.exp(x).sum()))


def _last_index(ids: list[int], token: int) -> int:
    for i in range(len(ids) - 1, -1, -1):
        if ids[i] == token:
            return i
    raise ValueError("no <|asst|> token in the encoded sequence")


def continuation_ids(tokenizer, prompt: str, answer: str) -> tuple[list[int], int]:
    """`(answer + <|end|>) ids as `format_example` writes them, and the
    <|asst|> position in the full sequence."""
    full = tokenizer.encode(prompt + " " + answer + " " + spec.END_TOKEN).ids
    asst = tokenizer.token_to_id(spec.SPECIAL_TOKENS[3])
    pos = _last_index(full, asst)
    return full[pos + 1:], pos


def build_candidates(kb: dict, lang: str, persona: str) -> list[dict]:
    """Every well-formed answer the runtime may emit, for this lang/persona.

    Single-fact frames via `_answer_about` (exactly what §7.4 trained on),
    one list-frame per listable kind, plus the abstention token. Facts with
    no public value are skipped — the §1 gate keeps them out of the answer
    space (contact.phone can never become a candidate).
    """
    f = inst.Facts(kb, {})
    out: dict[str, dict] = {}
    for fid in sorted(inst._FRAMES):
        try:
            if not f.value(fid):
                continue
            text = inst._answer_about(fid, f, lang, persona)
        except Exception:
            continue
        out[text] = {"text": text, "ids": [fid]}
    by_kind: dict[str, list[str]] = {}
    for fid, entry in inst.index_facts(kb).items():
        if entry["kind"] in inst._LIST_KINDS and f.value(fid):
            by_kind.setdefault(entry["kind"], []).append(fid)
    for kind, fids in sorted(by_kind.items()):
        if len(fids) < 2:
            continue
        frames = inst._LIST_FRAMES.get(kind) or {}
        pair = frames.get(lang) or frames.get("en")
        if not pair:
            continue
        frame = pair[0] if persona == "first" else pair[1]
        text = frame.format(v=inst._conj([f.ref(fid) for fid in sorted(fids)], lang))
        out.setdefault(text, {"text": text, "ids": sorted(fids)})
    out[inst.ABSTAIN] = {"text": inst.ABSTAIN, "ids": []}
    return [out[k] for k in sorted(out)]


# ── scoring ──────────────────────────────────────────────────────────

def prepare_candidates(tokenizer, prompt: str, cands: list[dict],
                       max_pos: int) -> list[dict]:
    """Tokenize every candidate once; drop any that cannot fit."""
    out = []
    for cand in cands:
        try:
            cont, asst_pos = continuation_ids(tokenizer, prompt, cand["text"])
        except Exception:
            continue
        if not cont or asst_pos + 1 + len(cont) > max_pos:
            continue
        out.append({**cand, "cont": cont, "asst_pos": asst_pos})
    return out


def score_full(weights, cfg, prompt_ids: list[int], cand: dict) -> dict:
    """Teacher-forced log-probs of one candidate's continuation."""
    from inference import reference

    logits = reference.forward(weights, cfg, prompt_ids + cand["cont"])
    p = cand["asst_pos"]
    total = 0.0
    for k, tok in enumerate(cand["cont"]):
        total += logprob_of(logits[p + k], tok)
    return {"total": total, "mean": total / len(cand["cont"]),
            "first": logprob_of(logits[p], cand["cont"][0])}


def first_token_scores(weights, cfg, prompt_ids: list[int],
                       cands: list[dict]) -> None:
    """One forward on the bare prompt ranks *every* candidate cheaply."""
    from inference import reference

    row = reference.forward(weights, cfg, prompt_ids)[-1]
    for cand in cands:
        cand["first"] = logprob_of(row, cand["cont"][0])


def score_pmi(weights, cfg, tokenizer, case: dict, cands: list[dict]) -> None:
    """Conditional PMI (Holtzman et al. 2021): subtract the candidate's
    likelihood under the same frame with the context removed — this is what
    stops a frequent boilerplate surface form from winning on raw nats."""
    neutral = " ".join([spec.SPECIAL_TOKENS[0], inst.RULES[case["rules"]],
                        spec.SPECIAL_TOKENS[1], spec.SPECIAL_TOKENS[2],
                        case["question"], spec.SPECIAL_TOKENS[3]])
    neutral_ids = tokenizer.encode(neutral).ids
    for cand in cands:
        cont, pos = continuation_ids(tokenizer, neutral, cand["text"])
        if not cont or pos + 1 + len(cont) > cfg.max_position_embeddings:
            cand["pmi"] = cand.get("total", -1e9)
            continue
        logits = reference_forward(weights, cfg, neutral_ids + cont)
        uncond = sum(logprob_of(logits[pos + k], tok)
                     for k, tok in enumerate(cont))
        cand["pmi"] = cand["total"] - uncond


def reference_forward(weights, cfg, ids):
    from inference import reference

    return reference.forward(weights, cfg, ids)


# ── selection + grading ──────────────────────────────────────────────

def select(scored: list[dict], key: str, context_ids: set[str],
           guarded: bool) -> dict:
    """Argmax over the candidate pool; `guarded` restricts to candidates
    whose fact ids are all in the retrieved context (plus <|abstain|>, whose
    empty id set is a subset of everything)."""
    if guarded:
        pool = [c for c in scored if set(c["ids"]) <= context_ids] or scored
    else:
        pool = scored
    return max(pool, key=lambda c: c.get(key, -1e18))


def grade_rows(rows: list[dict]) -> dict:
    """The §14 definitions, recomputed over the model-route cases only."""
    answer_rows = [r for r in rows if r["scorable"] and r["expected"]]
    abstain_rows = [r for r in rows if not r["expected"]]
    hits = [r for r in answer_rows if r["covered"]]
    unsup = [r for r in answer_rows if r["unsupported"]]
    false_abs = [r for r in answer_rows if r["chosen_abstain"]]
    recall = ([r for r in abstain_rows if r["chosen_abstain"]]
              if abstain_rows else [])
    n = len(answer_rows)
    return {
        "answer_cases": n,
        "abstain_cases": len(abstain_rows),
        "factualAccuracy": (len(hits) / n) if n else None,
        "meanCoverage": (sum(r["coverage"] for r in answer_rows) / n) if n else None,
        "unsupportedPreGuard": (len(unsup) / n) if n else None,
        "falseAbstention": (len(false_abs) / n) if n else None,
        "abstentionRecall": (len(recall) / len(abstain_rows)) if abstain_rows else None,
        "missed": sorted(r["id"] for r in answer_rows if not r["covered"]),
        "unsupportedIds": sorted(r["id"] for r in unsup),
    }


# ── main ─────────────────────────────────────────────────────────────

def load_tokenizer(tokenizer_dir: Path, checkpoint: Path):
    from ai.tokenizer.train import load

    tokenizer, meta = load(tokenizer_dir)
    manifest = checkpoint / "RUN_MANIFEST.json"
    if manifest.is_file():
        recorded = json.loads(manifest.read_text(encoding="utf-8")).get(
            "tokenizer_version")
        if recorded and recorded != meta.get("tokenizer_version"):
            raise SystemExit(
                f"refusing: {checkpoint} was trained on {recorded} but "
                f"{tokenizer_dir.name} is {meta.get('tokenizer_version')} — "
                "a checkpoint fed another vocabulary's ids scores nonsense.")
    return tokenizer, meta


def evaluate_case(case: dict, weights, cfg, tokenizer, kb: dict,
                  topk: int, use_pmi: bool) -> dict:
    t0 = time.time()
    prompt_ids = tokenizer.encode(case["prompt"]).ids
    cands = prepare_candidates(
        tokenizer, case["prompt"],
        build_candidates(kb, case["lang"], case["rules"]),
        cfg.max_position_embeddings)
    ctx = set(case["contextIds"])

    # One forward on the bare prompt ranks every candidate by first token AND
    # gives the discriminative fact-token distribution for free (PET-style:
    # score only the <|fact:ID|> token, so template popularity cannot vote).
    row = reference_forward(weights, cfg, prompt_ids)[-1]
    fact_scores = {}
    for cand in cands:
        cand["first"] = logprob_of(row, cand["cont"][0])
    for fid in sorted(spec.fact_ids(kb)):
        tid = tokenizer.token_to_id(spec.placeholder_token(fid))
        if tid is not None:
            fact_scores[fid] = logprob_of(row, tid)

    kept = sorted(cands, key=lambda c: c["first"], reverse=True)[:topk]
    texts = {c["text"] for c in kept}
    for cand in cands:  # never drop <|abstain|> or a context-supported answer
        if cand["text"] not in texts and (cand["ids"] == []
                                          or set(cand["ids"]) <= ctx):
            kept.append(cand)
            texts.add(cand["text"])
    for cand in kept:
        cand.update(score_full(weights, cfg, prompt_ids, cand))
    if use_pmi:
        score_pmi(weights, cfg, tokenizer, case, kept)
    rules = {}
    for name, key, guarded in [("first", "first", False),
                               ("total", "total", False),
                               ("mean", "mean", False),
                               ("total_guarded", "total", True),
                               ("mean_guarded", "mean", True),
                               ("pmi", "pmi", False),
                               ("pmi_guarded", "pmi", True)]:
        if key == "pmi" and not use_pmi:
            continue
        pick = select(kept, key, ctx, guarded)
        rules[name] = {"text": pick["text"], "ids": pick["ids"],
                       "total": round(pick["total"], 4),
                       "mean": round(pick["mean"], 4),
                       "pmi": round(pick.get("pmi", 0.0), 4)}
    # discriminative fact-token pick, support-guarded (no threshold yet)
    # NOTE(fact-token scoring): only scores the <|fact:ID|> token's logprob.
    # The TrAC paper (arXiv:2608.00422, Aug 2026) reports that *mean* logprob
    # over a short answer span is a stronger consistency signal than a single
    # token — we keep the token-level score for the argmax selection but use
    # score_full() below for thresholded rules, where the mean logprob of the
    # complete answer is a better abstention signal.
    supported = {fid: lp for fid, lp in fact_scores.items() if fid in ctx}
    cand_by_fid = {c["ids"][0]: c for c in cands if len(c["ids"]) == 1}
    if supported:
        best_fid = max(supported, key=lambda f: supported[f])
        pick = cand_by_fid.get(best_fid)
        if pick:
            rules["fact_guarded"] = {"text": pick["text"], "ids": [best_fid],
                                     "total": round(supported[best_fid], 4),
                                     "mean": 0.0, "pmi": 0.0}
    pool_all = sorted(kept, key=lambda c: c["total"], reverse=True)
    return {"id": case["id"], "lang": case["lang"], "question": case["question"],
            "rules": rules, "seconds": round(time.time() - t0, 1),
            "factScores": {k: round(v, 4) for k, v in fact_scores.items()},
            "pool": [{"text": c["text"], "ids": c["ids"],
                      "total": round(c["total"], 3), "mean": round(c["mean"], 3),
                      "first": round(c["first"], 3),
                      "pmi": round(c.get("pmi", 0.0), 3),
                      "supported": bool(set(c["ids"]) <= set(case["contextIds"]))}
                     for c in pool_all]}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--which", default="latest")
    ap.add_argument("--prompts", type=Path,
                    default=ROOT / "kaggle-push/out/eval-v3-prompts-fixed.json")
    ap.add_argument("--grading", type=Path,
                    default=ROOT / "docs/EVALUATION.json")
    ap.add_argument("--tokenizer", type=Path,
                    default=ROOT / "ai/tokenizer/artifacts/stage-a-16k")
    ap.add_argument("--out", type=Path, default=ROOT / "kaggle-push/out/rerank-v1")
    ap.add_argument("--topk", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--pmi", action="store_true")
    args = ap.parse_args(argv)

    tokenizer, meta = load_tokenizer(args.tokenizer, args.checkpoint)
    from inference import reference
    from inference.export_browser import load_checkpoint

    state, cfg, provenance = load_checkpoint(args.checkpoint, args.which)
    weights = reference.torch_state_dict_to_numpy(state)
    kb = inst.load_kb(None)

    suite = json.loads(args.prompts.read_text(encoding="utf-8"))["prompts"]
    cases = [c for c in suite if c.get("route") == "model"]
    grading = {r["id"]: r for r in
               json.loads(args.grading.read_text(encoding="utf-8"))["rows"]}
    if args.limit:
        cases = cases[:args.limit]

    args.out.mkdir(parents=True, exist_ok=True)
    answers_path = args.out / "rerank-answers.json"
    taus = (2, 4, 6, 8, 10, 12, 14)
    # rules to tabulate: full-answer scorers + fact-token scorers + PMI scorers
    rules_names = (["first", "total", "mean", "total_guarded", "mean_guarded",
                    "fact_guarded", "mean_t12", "mean_t14", "mean_t16", "mean_t18",
                    "mean_t20"] + [f"fact_t{t}" for t in taus])
    if args.pmi:
        rules_names += ["pmi", "pmi_guarded"]
    per_rule_rows: dict[str, list[dict]] = {name: [] for name in rules_names}
    baseline_rows: list[dict] = []
    per_case: list[dict] = []
    t_start = time.time()

    for i, case in enumerate(cases, 1):
        result = evaluate_case(case, weights, cfg, tokenizer, kb,
                               args.topk, args.pmi)
        # thresholded fact-token rules: answer only if the best supported
        # fact token clears -tau nats, else abstain (calibrated on this suite)
        ctx = set(case.get("contextIds") or [])
        supported = {fid: lp for fid, lp in result["factScores"].items()
                     if fid in ctx}
        cand_by_fid = {c["ids"][0]: c for c in
                       json.loads(json.dumps(result["pool"]))
                       if len(c["ids"]) == 1}
        best_fid, best_lp = (max(supported.items(), key=lambda kv: kv[1])
                             if supported else (None, -1e18))
        for t in taus:
            if best_fid is not None and best_lp >= -t and best_fid in cand_by_fid:
                pick = cand_by_fid[best_fid]
                result["rules"][f"fact_t{t}"] = {
                    "text": pick["text"], "ids": [best_fid],
                    "total": round(best_lp, 4), "mean": 0.0, "pmi": 0.0}
            else:
                result["rules"][f"fact_t{t}"] = {
                    "text": inst.ABSTAIN, "ids": [],
                    "total": round(best_lp, 4), "mean": 0.0, "pmi": 0.0}
        if "fact_guarded" not in result["rules"]:
            if best_fid is not None and best_fid in cand_by_fid:
                pick = cand_by_fid[best_fid]
                result["rules"]["fact_guarded"] = {
                    "text": pick["text"], "ids": [best_fid],
                    "total": round(best_lp, 4), "mean": 0.0, "pmi": 0.0}
            else:
                result["rules"]["fact_guarded"] = {
                    "text": inst.ABSTAIN, "ids": [],
                    "total": round(best_lp, 4), "mean": 0.0, "pmi": 0.0}
        # ALSO emit thresholded rules using full-answer mean logprob (TrAC-style)
        # re-score each kept candidate fully, then threshold on mean logprob
        all_kept_full = []
        for cand in kept:
            cand_full = {**cand, **score_full(weights, cfg, prompt_ids, cand)}
            all_kept_full.append(cand_full)
        for t in [12, 14, 16, 18, 20]:
            if t not in [12, 14, 16, 18, 20]:
                continue
            name = f"mean_t{t}"
            mn = max((c["mean"] for c in all_kept_full), default=-1e9)
            if mn >= -t:
                best = max(all_kept_full, key=lambda c: c["mean"])
                result["rules"][name] = {"text": best["text"], "ids": best["ids"],
                                         "total": round(best["total"], 4),
                                         "mean": round(best["mean"], 4), "pmi": 0.0}
            else:
                result["rules"][name] = {"text": inst.ABSTAIN, "ids": [],
                                         "total": round(mn, 4), "mean": round(mn, 4), "pmi": 0.0}
        g = grading.get(case["id"], {})
        expected = set(g.get("expected") or [])
        ctx = set(case.get("contextIds") or [])
        # baseline row: what the free-running decode actually did (recorded)
        cited_b = list(g.get("cited") or [])
        baseline_rows.append({
            "id": case["id"], "expected": sorted(expected), "cited": cited_b,
            "covered": sorted(expected & set(cited_b)),
            "coverage": (len(expected & set(cited_b)) / len(expected)) if expected else 0.0,
            "unsupported": any(c not in ctx for c in cited_b),
            "chosen_abstain": bool(g.get("abstained")),
            "scorable": bool(g.get("scorable")),
        })
        for name in rules_names:
            pick = result["rules"][name]
            cited = list(pick["ids"])
            covered = sorted(expected & set(cited))
            per_rule_rows[name].append({
                "id": case["id"], "expected": sorted(expected), "cited": cited,
                "covered": covered,
                "coverage": (len(covered) / len(expected)) if expected else 0.0,
                "unsupported": any(c not in ctx for c in cited),
                "chosen_abstain": pick["text"] == inst.ABSTAIN,
                "scorable": bool(g.get("scorable")) and bool(expected),
            })
        per_case.append(result)
        elapsed = time.time() - t_start
        print(f"[{i}/{len(cases)}] {case['id']} {case['lang']} "
              f"{result['seconds']:.0f}s  total={result['rules']['total']['text'][:48]!r}",
              flush=True)
        answers_path.write_text(json.dumps(
            {"checkpoint": str(args.checkpoint), "which": args.which,
             "step": provenance.get("step"), "topk": args.topk,
             "pmi": args.pmi, "tokenizer": meta["tokenizer_version"],
             "perCase": per_case, "rowsByRule": per_rule_rows,
             "baselineRows": baseline_rows},
            ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    report: list[str] = [
        f"candidate rerank — {args.checkpoint} ({args.which}, step "
        f"{provenance.get('step')}), topk={args.topk}, pmi={args.pmi}",
        f"suite: {len(cases)} model-route cases, "
        f"{time.time() - t_start:.0f}s total",
        "",
        f"{'rule':<14}{'factualAcc':>11}{'meanCov':>9}{'unsupported':>13}"
        f"{'falseAbs':>9}{'recall':>8}",
    ]
    for name, rows in [("baseline(v9)", baseline_rows)] + [
            (n, per_rule_rows[n]) for n in rules_names]:
        m = grade_rows(rows)
        all_n = len(rows)
        unsup_all = sum(1 for r in rows if r["unsupported"]) / all_n
        false_all = (sum(1 for r in rows if r["chosen_abstain"]
                         and r["expected"]) / all_n) if all_n else 0.0
        report.append(
            f"{name:<14}{(m['factualAccuracy'] or 0):>11.3f}"
            f"{(m['meanCoverage'] or 0):>9.3f}{unsup_all:>13.3f}"
            f"{false_all:>9.3f}{(m['abstentionRecall'] or 0):>8.3f}")
    report.append("")
    for name, rows in [("baseline(v9)", baseline_rows)] + [
            (n, per_rule_rows[n]) for n in rules_names]:
        m = grade_rows(rows)
        report.append(f"{name}: missed={m['missed']}")
        report.append(f"{name}: unsupported={m['unsupportedIds']}")
    (args.out / "rerank-report.txt").write_text(
        "\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report), flush=True)
    print(f"wrote {answers_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
