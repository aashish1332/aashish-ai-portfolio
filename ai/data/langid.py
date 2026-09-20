"""ai/data/langid.py — the §8.3 detector, in Python.

Why a port instead of a re-think: the Stage A corpus is *tagged* by
language at data-prep time, and the runtime picks the reply language with
`ai/language/detect.mjs`. If the two disagreed, a Hindi line could be
filed as English, trained as English, and then produced in response to a
Hindi question — the model would look bad for a labelling bug.

So this is a faithful port of the same rules, and
`tests/py/test_langid_parity.py` + `tests/language.test.mjs` both assert
against `tests/fixtures/langid_cases.json`: one fixture, two runtimes,
divergence fails a test in whichever runtime drifted.

The lexicons come from `ai/language/lexicons.json`, which the JS
detector's own test verifies is identical to its in-code sets.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

LEXICON_PATH = Path(__file__).resolve().parents[1] / "language" / "lexicons.json"

# Devanagari block U+0900–U+097F plus the extended block U+A8E0–U+A8FF.
DEV_RE = re.compile(r"[\u0900-\u097F\uA8E0-\uA8FF]")
LATIN_RE = re.compile(r"[A-Za-z]")
TOKEN_RE = re.compile(r"[A-Za-z\u0900-\u097F\uA8E0-\uA8FF]+")

# Thresholds — identical to detect.mjs. Kept as named constants because a
# number that decides "is this Hindi" should not be a literal in an `if`.
DEV_STRONG = 0.55       # Devanagari-dominant → Hindi
DEV_CODEMIX = 0.10      # Devanagari present but Latin-heavy → Hinglish
DEV_ROUND = 3           # devRatio is reported to 3dp in both runtimes


def load_lexicons(path: Path | str = LEXICON_PATH) -> tuple[frozenset[str], frozenset[str]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return frozenset(raw["hinglish"]), frozenset(raw["english"])


HINGLISH_WORDS, ENGLISH_WORDS = load_lexicons()

LANG_LABEL = {"en": "English", "hi": "हिन्दी", "hinglish": "Hinglish"}


def tokenize(text: str) -> list[str]:
    """Lower-cased Latin + Devanagari runs (same regex as detect.mjs)."""
    return TOKEN_RE.findall(str(text or "").lower())


def detect_language(text: str) -> dict:
    """Detect one message. Mirrors `detectLanguage()` in detect.mjs."""
    raw = str(text or "")
    tokens = tokenize(raw)

    dev = sum(1 for ch in raw if DEV_RE.match(ch))
    latin = sum(1 for ch in raw if LATIN_RE.match(ch))
    letters = dev + latin
    dev_ratio = dev / letters if letters else 0.0

    hinglish_hits = english_hits = 0
    for t in tokens:
        if t in HINGLISH_WORDS:
            hinglish_hits += 1
        elif t in ENGLISH_WORDS:
            english_hits += 1

    base = {
        "devRatio": round(dev_ratio, DEV_ROUND),
        "hinglishHits": hinglish_hits,
        "englishHits": english_hits,
        "tokens": len(tokens),
    }

    def result(lang: str, strength: str) -> dict:
        return {"lang": lang, "strength": strength, **base}

    if not tokens:
        return result("en", "weak")
    if dev_ratio >= DEV_STRONG:
        return result("hi", "strong")
    if dev_ratio > DEV_CODEMIX:
        return result("hinglish", "strong")
    if hinglish_hits >= 2 and hinglish_hits >= english_hits:
        return result("hinglish", "strong")
    if hinglish_hits == 1 and english_hits == 0:
        return result("hinglish", "strong")
    if hinglish_hits >= 1 and hinglish_hits == english_hits:
        return result("hinglish", "weak")
    if english_hits >= 2:
        return result("en", "strong")
    if english_hits == 1 and hinglish_hits == 0:
        return result("en", "strong")
    return result("en", "weak")


def label(text: str) -> str:
    """Just the language code — what the corpus pipeline stores."""
    return detect_language(text)["lang"]


def create_language_tracker(initial: str = "en"):
    """Turn-aware smoothing (§8.3), mirroring `createLanguageTracker()`."""
    state = {"last": initial}

    def push(text: str) -> dict:
        d = detect_language(text)
        lang = d["lang"] if d["strength"] == "strong" else state["last"]
        switched = lang != state["last"]
        state["last"] = lang
        return {"lang": lang, "strength": d["strength"],
                "switched": switched, "detection": d}

    def current() -> str:
        return state["last"]

    def reset(to: str = initial) -> None:
        state["last"] = to

    return {"push": push, "current": current, "reset": reset}
