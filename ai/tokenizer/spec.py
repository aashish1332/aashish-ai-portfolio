"""ai/tokenizer/spec.py — the tokenizer contract (§7.2).

One place defines what the tokenizer must contain, what the placeholder
grammar is, and how the artifact is versioned. `train.py` builds it,
`ai/answers` (browser) resolves it, and the tests pin it.

Why this file exists at all: the model is *allowed* to emit `<|fact:id|>`
and is *never* allowed to emit a URL, email, date or number character by
character (§7.2 / §8.4 layer 3). Keeping the grammar in one module — and
pinning it against the browser's resolver in `tests/fixtures/` — is what
keeps "the model emits a placeholder" true at the seam where it matters.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KB_PATH = REPO_ROOT / "knowledge" / "knowledge.json"

# ── Special tokens (§7.2, exactly these six) ─────────────────────────
# Turn structure tokens plus the abstention token. No <|pad|>, no <|unk|>:
# byte-level BPE can represent every input, so an unk token would be dead
# weight, and adding tokens the spec did not ask for is a compatibility
# hazard for the GGUF/ONNX export in P6.
SPECIAL_TOKENS: tuple[str, ...] = (
    "<|sys|>",
    "<|ctx|>",
    "<|user|>",
    "<|asst|>",
    "<|end|>",
    "<|abstain|>",
)

STRUCTURE_TOKENS = SPECIAL_TOKENS[:-1]
END_TOKEN = "<|end|>"
ABSTAIN_TOKEN = "<|abstain|>"

# ── Placeholder grammar (§7.2) ───────────────────────────────────────
# Must stay identical to the browser resolver. The JS equivalent is
# exported from ai/knowledge/placeholders.mjs and both are tested against
# tests/fixtures/placeholder_cases.json.
PLACEHOLDER_RE = re.compile(r"<\|\s*fact:([^|]+?)\s*\|>")


def placeholder_token(fact_id: str) -> str:
    """Canonical placeholder string for a fact id."""
    fid = str(fact_id).strip()
    if not fid or "|" in fid or "<" in fid or ">" in fid:
        raise ValueError(f"invalid fact id: {fact_id!r}")
    return f"<|fact:{fid}|>"


def is_placeholder(token: str) -> bool:
    """True only for a complete, well-formed placeholder."""
    return bool(PLACEHOLDER_RE.fullmatch(str(token).strip()))


def iter_placeholders(text: str):
    """Yield every fact id referenced in `text`, in order, deduplicated."""
    seen: set[str] = set()
    for m in PLACEHOLDER_RE.finditer(str(text or "")):
        fid = m.group(1).strip()
        if fid and fid not in seen:
            seen.add(fid)
            yield fid


# ── Fact ids that get their own token ────────────────────────────────
def load_kb(path: Path | str = KB_PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fact_ids(kb: dict | None = None) -> list[str]:
    """Every fact id in knowledge.json, plus the composed project links.

    `<|fact:project.volunteer.live|>` is a *composed* id: §7.2 names
    `<|fact:project.<id>.repo|>` explicitly, and a project's link is the
    fact a model most needs to hand back verbatim rather than type out.
    """
    kb = kb if kb is not None else load_kb()
    ids: list[str] = []

    def walk(node) -> None:
        if isinstance(node, dict):
            if isinstance(node.get("id"), str):
                ids.append(node["id"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(kb)

    for project in kb.get("projects", []):
        pid = project.get("id")
        if not pid:
            continue
        for link in project.get("links", []) or []:
            label = str(link.get("label", "")).strip().lower()
            if not label:
                continue
            slug = re.sub(r"[^a-z0-9]+", "_", label).strip("_")
            if slug:
                ids.append(f"{pid}.{slug}")

    # Stable, deduplicated, KB order preserved (it is the human review order).
    out: list[str] = []
    seen: set[str] = set()
    for fid in ids:
        if fid not in seen:
            seen.add(fid)
            out.append(fid)
    return out


def placeholder_tokens(kb: dict | None = None) -> list[str]:
    return [placeholder_token(fid) for fid in fact_ids(kb)]


# ── Versioning (§7.2 "Version it") ───────────────────────────────────
DEFAULT_NAME = "portfolio-bpe"


def spec_hash(kb: dict | None = None) -> str:
    """Hash of everything that changes the tokenizer's *interface*.

    Vocab size and corpus are not part of it: those change the artifact,
    not the contract. Special tokens and the placeholder set are.
    """
    payload = json.dumps(
        {
            "special_tokens": list(SPECIAL_TOKENS),
            "placeholders": placeholder_tokens(kb),
            "grammar": PLACEHOLDER_RE.pattern,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def tokenizer_version(name: str = DEFAULT_NAME, vocab_size: int | None = None,
                      kb: dict | None = None) -> str:
    """e.g. `portfolio-bpe-16k-3f9a21c0b7de`."""
    size = f"{vocab_size // 1024}k" if vocab_size else "unset"
    return f"{name}-{size}-{spec_hash(kb)}"


# ── Post-training contract checks ────────────────────────────────────
def assert_tokenizer_contract(tokenizer, kb: dict | None = None) -> list[str]:
    """Fail loudly if the trained artifact breaks §7.2.

    Returns the checks that passed, so `train.py` can print them rather
    than assert silently. Any violation raises AssertionError.
    """
    checks: list[str] = []

    vocab = tokenizer.get_vocab()
    for token in SPECIAL_TOKENS:
        assert token in vocab, f"special token missing from vocab: {token}"
    checks.append(f"{len(SPECIAL_TOKENS)} special tokens present")

    # Placeholders must be *single* tokens, or the model can mangle them.
    for fid in fact_ids(kb):
        token = placeholder_token(fid)
        ids = tokenizer.encode(token, add_special_tokens=False).ids
        assert ids == [vocab[token]], (
            f"placeholder {token!r} is not atomic: {ids} "
            f"(a multi-token placeholder can be corrupted token by token)"
        )
    checks.append(f"{len(fact_ids(kb))} placeholders atomic")

    # Byte-level BPE: every byte of every script round-trips.
    probes = [
        "Aashish Kumar — B.Tech CSE, CGPA 8.28.",
        "नमस्ते, आपका नाम क्या है? मुझे उसका प्रोजेक्ट दिखाओ।",
        "bhai uska project kaun sa hai, batao na yaar",
        "SELECT id FROM users WHERE created_at > '2026-01-01';",
        "https://atlascommunity-one.vercel.app/ · aashish@example.com · +91 00000 00000",
        "emoji 🎬 and ŻÓŁĆ and 漢字 survive",
        "<|user|> does <|asst|> id <|end|>",
    ]
    for text in probes:
        ids = tokenizer.encode(text, add_special_tokens=False).ids
        assert ids, f"empty encoding for {text!r}"
        assert max(ids) < len(vocab), f"id out of range for {text!r}"
        back = tokenizer.decode(ids, skip_special_tokens=False)
        assert back == text, f"round-trip failed:\n  in : {text!r}\n  out: {back!r}"
    checks.append(f"{len(probes)} round-trips exact (EN/HI/Hinglish/SQL/URL/emoji)")

    return checks
