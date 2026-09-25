"""evaluation/voice/score.py — §11.2, the WER scorer for the voice decision.

Why this file exists
--------------------
§11.2 lets us put a real speech recognizer in front of Hindi and Hinglish, but
only if we **measure** it first. Small Whisper-class models are weak in many
non-English languages, and the honest outcome of that measurement may be
"Hindi voice input goes through the browser's own on-device engine, or the UI
says voice works best in English". That decision needs a number, not an
opinion, so this script turns the recordings made with `record.html` into one.

The bands are not chosen here — they are read from `phrases.json`'s
`what_the_numbers_decide`, so the file the owner records against and the file
that judges the recording cannot drift apart.

Two things this script deliberately does NOT do:

* It does not normalise away word errors. Filler words, dropped words and
  invented words all count, because a transcript the visitor has to fix is a
  cost they actually pay.
* It does not average per-phrase percentages. The language number is the
  corpus WER (total edit operations / total reference tokens), so one very
  bad clip cannot be hidden behind nine perfect ones — which is exactly the
  shape a weak-Hindi result takes.

Run
---
    python evaluation/voice/score.py
    python evaluation/voice/score.py --transcripts evaluation/voice/transcripts.json
    python evaluation/voice/score.py --json evaluation/voice/WER.json
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

# The three bands from phrases.json, in words. Used if the file omits them, so
# a broken band block can never silently turn into a pass.
DEFAULT_BANDS = {
    "ship": 0.20,
    "disclose": 0.35,
}

SKIP = object()


# ── text normalisation ────────────────────────────────────────────────────
def normalize_text(text: str) -> str:
    """NFC, lowercase, punctuation out — but Devanagari and its marks kept.

    The one rule that matters: a combining mark (``\\u093e`` etc.) is part of
    the letter before it, never punctuation. `unicodedata.category` is what
    makes that distinction, so an apostrophe in "don't" and a matra in "पढ़ाई"
    are treated differently instead of both vanishing (R7 in PROGRESS.md was
    exactly this mistake in `ai/retrieval`).
    """
    text = unicodedata.normalize("NFC", str(text or ""))
    out = []
    for i, ch in enumerate(text):
        cat = unicodedata.category(ch)
        if cat[0] in ("L", "N") or cat[0] == "M":
            # Devanagari digits have no ASCII case; lower() is a no-op there.
            out.append(ch.lower())
        elif ch in ".٫" and i and i + 1 < len(text) \
                and text[i - 1].isdigit() and text[i + 1].isdigit():
            # A decimal point between digits is part of the NUMBER, not
            # punctuation: "9.14" is one spoken token, and splitting it into
            # "9" and "14" would also make it indistinguishable from "9 14".
            out.append(ch)
        elif ch.isspace():
            out.append(" ")
        else:
            # punctuation and symbols become a space, so "cgpa?" and "cgpa"
            # tokenise identically without gluing two words together
            out.append(" ")
    return " ".join("".join(out).split())


def tokenize(text: str) -> list[str]:
    """Whitespace tokens of the normalised text.

    Devanagari word boundaries are spaces, so whitespace is the right
    tokenizer for all three languages here. ASCII digits are folded to their
    Devanagari equivalents? No — the opposite: Devanagari digits (U+0966…)
    are folded to ASCII, because the recognizer may emit either and a
    difference in digit script is not a word error.
    """
    norm = normalize_text(text)
    if not norm:
        return []
    return [d_fold(t) for t in norm.split(" ") if t]


DIGITS = str.maketrans({chr(0x0966 + i): str(i) for i in range(10)})


def d_fold(token: str) -> str:
    return token.translate(DIGITS)


# ── word error rate ───────────────────────────────────────────────────────
def edit_ops(ref: list[str], hyp: list[str]) -> tuple[int, int, int]:
    """Levenshtein on token lists → (substitutions, deletions, insertions).

    The counts matter as much as the total: a high deletion count means the
    recognizer dropped words the visitor said, a high insertion count means it
    invented words on silence (§11.2's phantom problem), and those want
    different fixes.
    """
    n, m = len(ref), len(hyp)
    # dp[i][j] = (cost, subs, dels, ins) — cost first so tuples compare on it
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur.append(prev[j - 1])
                continue
            sub = prev[j - 1]
            dele = prev[j]
            ins = cur[j - 1]
            best = min((sub[0] + 1, sub[1] + 1, sub[2], sub[3]),
                       (dele[0] + 1, dele[1], dele[2] + 1, dele[3]),
                       (ins[0] + 1, ins[1], ins[2], ins[3] + 1))
            cur.append(best)
        prev = cur
    cost, subs, dels, ins = prev[m]
    return subs, dels, ins


def wer(reference: str, hypothesis: str) -> dict:
    """WER of one clip. `wer` is None when the reference has no tokens."""
    ref, hyp = tokenize(reference), tokenize(hypothesis)
    if not ref:
        return {"wer": None, "ref_tokens": 0, "substitutions": 0,
                "deletions": 0, "insertions": 0, "ops": 0}
    subs, dels, ins = edit_ops(ref, hyp)
    ops = subs + dels + ins
    return {
        "wer": ops / len(ref),
        "ref_tokens": len(ref),
        "substitutions": subs,
        "deletions": dels,
        "insertions": ins,
        "ops": ops,
    }


# ── the §11.2 bands ───────────────────────────────────────────────────────
def bands_from(spec: dict) -> dict:
    """Pull the two thresholds out of `what_the_numbers_decide` by its keys.

    Keys are the contract (`under_20_percent_wer` etc.), so the cut points are
    read from the key names rather than duplicated as magic numbers here. A
    file that renames them falls back to the defaults instead of guessing.
    """
    decision = (spec or {}).get("what_the_numbers_decide") or {}
    bands = dict(DEFAULT_BANDS)
    parts = {}                       # the numeric fields of each key name
    for key in decision:
        if "wer" not in key:
            continue
        bits = [p for p in key.split("_") if p.isdigit()]
        if len(bits) == 1:           # under_20_percent_wer  / over_35_...
            parts[key.split("_")[0]] = float(bits[0]) / 100.0
        elif len(bits) == 2:         # 20_to_35_percent_wer
            parts["from"], parts["to"] = (float(bits[0]) / 100.0,
                                           float(bits[1]) / 100.0)
    if "under" in parts:
        bands["ship"] = parts["under"]
    if "to" in parts:
        bands["disclose"] = parts["to"]
    elif "over" in parts:
        bands["disclose"] = parts["over"]
    if bands["disclose"] < bands["ship"]:
        bands["disclose"] = bands["ship"]
    return bands


def verdict(rate: float | None, bands: dict) -> str:
    """Three outcomes, named so the docs can quote the word not the number."""
    if rate is None:
        return "no-reference"
    if rate < bands["ship"]:
        return "ship"
    if rate <= bands["disclose"]:
        return "ship-with-disclosure"
    return "english-only-honesty-rule"


# ── inputs ────────────────────────────────────────────────────────────────
def load_json(path: Path) -> object:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_transcripts(path: Path) -> dict[str, str]:
    """Accept both shapes the owner can produce.

    * `record.html`'s export: `{"clips": [{"id", "hypothesis", ...}]}`
    * a hand-written map:      `{"en-01": "what is your cgpa", ...}`

    Blank hypotheses are dropped rather than counted as a 100 % error: an
    unrecorded clip is *missing data*, and silently scoring it as total
    failure would make the number lie in the pessimistic direction.
    """
    if not path.exists():
        raise FileNotFoundError(path)
    data = load_json(path)
    out: dict[str, str] = {}
    if isinstance(data, dict) and isinstance(data.get("clips"), list):
        for clip in data["clips"]:
            if not isinstance(clip, dict):
                continue
            cid = clip.get("id")
            hyp = (clip.get("hypothesis") or clip.get("transcript") or "").strip()
            if cid and hyp:
                out[str(cid)] = hyp
        return out
    if isinstance(data, dict):
        for cid, hyp in data.items():
            if isinstance(hyp, str) and hyp.strip():
                out[str(cid)] = hyp.strip()
        return out
    raise ValueError(f"{path}: expected an object, got {type(data).__name__}")


def load_phrases(path: Path) -> list[dict]:
    data = load_json(path)
    phrases = data.get("phrases") if isinstance(data, dict) else data
    if not isinstance(phrases, list) or not phrases:
        raise ValueError(f"{path}: no phrases")
    return phrases


# ── scoring ───────────────────────────────────────────────────────────────
def score(phrases: list[dict], transcripts: dict[str, str], bands: dict) -> dict:
    """Per-clip and per-language results. Pure — the CLI only prints this."""
    clips, by_lang = [], {}
    for phrase in phrases:
        cid = phrase["id"]
        lang = phrase.get("lang", "en")
        ref = phrase.get("text", "")
        hyp = transcripts.get(cid)
        if hyp is None:
            clips.append({"id": cid, "lang": lang, "reference": ref,
                          "hypothesis": None, "wer": None,
                          "verdict": "not-recorded"})
            continue
        m = wer(ref, hyp)
        clips.append({"id": cid, "lang": lang, "reference": ref,
                      "hypothesis": hyp, **m,
                      "verdict": verdict(m["wer"], bands)})
        agg = by_lang.setdefault(lang, {"ref_tokens": 0, "ops": 0, "clips": 0})
        agg["ref_tokens"] += m["ref_tokens"]
        agg["ops"] += m["ops"]
        agg["clips"] += 1

    languages = {}
    for lang, agg in by_lang.items():
        rate = (agg["ops"] / agg["ref_tokens"]) if agg["ref_tokens"] else None
        languages[lang] = {**agg,
                           "wer": rate,
                           "verdict": verdict(rate, bands)}

    scored = [c for c in clips if c["wer"] is not None]
    total_ref = sum(c["ref_tokens"] for c in scored)
    total_ops = sum(c["ops"] for c in scored)
    overall = (total_ops / total_ref) if total_ref else None

    return {
        "bands": bands,
        "overall": {"wer": overall, "ref_tokens": total_ref, "ops": total_ops,
                    "verdict": verdict(overall, bands)},
        "languages": languages,
        "clips": clips,
        "counts": {
            "phrases": len(phrases),
            "recorded": len(scored),
            "missing": len(phrases) - len(scored),
        },
    }


def pct(rate: float | None) -> str:
    return "  n/a " if rate is None else f"{rate * 100:5.1f}%"


def report(result: dict) -> str:
    """The human table. Printed, never parsed — `--json` is the machine one."""
    lines = ["", "§11.2 — measured word error rate", ""]
    counts = result["counts"]
    lines.append(f"  {counts['recorded']} of {counts['phrases']} phrases recorded"
                 + (f" ({counts['missing']} missing)" if counts["missing"] else ""))
    lines.append("")
    lines.append("  per language (corpus WER — total edits / total reference tokens)")
    lines.append("  " + "-" * 62)
    for lang in sorted(result["languages"]):
        d = result["languages"][lang]
        lines.append(f"  {lang:<10} {pct(d['wer'])}  "
                     f"({d['clips']:>2} clips, {d['ops']:>3} edits "
                     f"/ {d['ref_tokens']:>3} tokens)   {d['verdict']}")
    o = result["overall"]
    lines.append("  " + "-" * 62)
    lines.append(f"  {'overall':<10} {pct(o['wer'])}  ({o['ops']} edits "
                 f"/ {o['ref_tokens']} tokens)   {o['verdict']}")
    lines.append("")

    worst = sorted((c for c in result["clips"] if c["wer"] is not None),
                   key=lambda c: c["wer"], reverse=True)[:5]
    if worst:
        lines.append("  worst clips (where the recognizer actually fails)")
        for c in worst:
            lines.append(f"    {c['id']:<6} {pct(c['wer'])}  said: {c['reference']}")
            lines.append(f"    {'':<6}        heard: {c['hypothesis']}")
        lines.append("")

    missing = [c["id"] for c in result["clips"] if c["wer"] is None]
    if missing:
        lines.append(f"  not recorded: {', '.join(missing)}")
        lines.append("")

    bands = result["bands"]
    lines.append(f"  bands: <{bands['ship'] * 100:.0f}% ship · "
                 f"{bands['ship'] * 100:.0f}–{bands['disclose'] * 100:.0f}% "
                 f"ship with the number disclosed · "
                 f">{bands['disclose'] * 100:.0f}% English-only honesty rule (§11.2)")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="§11.2 voice word-error-rate scorer")
    ap.add_argument("--phrases", default=str(HERE / "phrases.json"))
    ap.add_argument("--transcripts", default=str(HERE / "transcripts.json"))
    ap.add_argument("--json", default=None, help="write the machine-readable result here")
    args = ap.parse_args(argv)

    phrases_path, transcripts_path = Path(args.phrases), Path(args.transcripts)
    if not transcripts_path.exists():
        print(
            "\n  no transcripts yet — nothing to score.\n\n"
            "  1. run:  npm run dev\n"
            "  2. open: http://localhost:5577/evaluation/voice/record.html\n"
            "  3. record each phrase, play the clip into the portfolio's voice\n"
            "     mode, paste what the panel shows, then press 'Download\n"
            "     transcripts.json' and save it next to phrases.json\n"
            "  4. run this again\n",
            file=sys.stderr,
        )
        return 2

    try:
        phrases = load_phrases(phrases_path)
        spec = load_json(phrases_path)
        transcripts = read_transcripts(transcripts_path)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    bands = bands_from(spec if isinstance(spec, dict) else {})
    result = score(phrases, transcripts, bands)
    print(report(result))

    if args.json:
        out = Path(args.json)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                       encoding="utf-8")
        print(f"  wrote {rel(out)}")

    return 0


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


if __name__ == "__main__":
    raise SystemExit(main())
