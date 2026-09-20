"""ai/data/pipeline.py — §7.3 data pipeline, the parts that are testable.

    clean → normalize → dedupe → language-ID → filter (PII, toxicity,
    length) → tokenize → shard (binary memmap) → train/val split with
    leakage checks

Every step is a pure function over records so it can be tested without a
1 GB corpus, and every step reports what it dropped. "We cleaned the
data" is not a verifiable statement; "2,431 of 2,780 lines survived,
347 dropped (312 near-duplicate, 22 URL-only, 13 too short)" is.

Shards are raw `uint16` token ids in a flat memmap plus a JSON manifest.
That is what llama.cpp / numpy / torch all want, and it means the smoke
train reads real data from disk with a real resumable cursor rather than
a list in memory — the cursor is the thing the resume test has to prove.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import langid  # noqa: E402

# ── Cleaning rules ───────────────────────────────────────────────────
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
WS_RE = re.compile(r"[ \t\u00a0\u2000-\u200b]+")

# Rejected outright: a line that is only a URL/email/handle teaches the
# tokenizer nothing and is the shape PII hides in.
URL_RE = re.compile(r"https?://[^\s<>\"')]+", re.I)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?\d[\d\-\s().]{7,}\d)")
LONG_DIGITS_RE = re.compile(r"\d{7,}")

# Hosts neutral enough to keep: public, already-published, or example
# domains. Anything else keeps scheme+host but loses query/fragment,
# which is where tracking ids and tokens live.
KEEP_HOSTS = ("github.com", "vercel.app", "linkedin.com", "wikipedia.org",
              "example.com", "example.org", "localhost")

MIN_CHARS, MAX_CHARS = 24, 2000
SHINGLE = 4          # words per shingle for near-duplicate detection

# Measured, not guessed, with 4-word shingles:
#   · exact copy                              → 1.00  dropped
#   · same sentence + a short appended clause  → 0.88  dropped
#   · one slot changed ("last year"/"this year") → 0.68  KEPT
#   · parallel construction ("What are his skills?" /
#     "What are his projects?")                 → 0.17  kept
# 0.8 sits between the two groups: it removes echoes without wiping out
# template families, which is what the tokenizer needs to see (§7.3).
NEAR_DUP_THRESHOLD = 0.8

# A tiny, explicit gate. It is NOT a toxicity classifier and is not
# claimed to be one; it drops the handful of slurs that must never reach
# a training run. P4 replaces this with a real filter and records it in
# data/DATA_LICENSES.md, including what it missed.
TOXIC_WORDS: tuple[str, ...] = (
    "chutiya", "madarchod", "bhenchod", "harami", "kamina", "randi",
)


@dataclass
class Record:
    text: str
    lang: str = ""
    source: str = ""
    split: str = ""
    id: str = ""
    drops: list[str] = field(default_factory=list)

    @property
    def sha1(self) -> str:
        return hashlib.sha1(self.text.encode("utf-8")).hexdigest()


@dataclass
class Stats:
    seen: int = 0
    kept: int = 0
    dropped: dict[str, int] = field(default_factory=dict)
    by_lang: dict[str, int] = field(default_factory=dict)
    near_dup_pairs: int = 0

    def drop(self, reason: str) -> None:
        self.dropped[reason] = self.dropped.get(reason, 0) + 1

    def as_dict(self) -> dict:
        return {
            "seen": self.seen,
            "kept": self.kept,
            "dropped_total": sum(self.dropped.values()),
            "dropped": dict(sorted(self.dropped.items(), key=lambda kv: -kv[1])),
            "by_lang": dict(sorted(self.by_lang.items())),
            "near_dup_pairs": self.near_dup_pairs,
        }


# ── Step 1–2: clean + normalize ──────────────────────────────────────
def normalize_text(text: str) -> str:
    """NFC, control-stripped, whitespace-collapsed, one line."""
    out = unicodedata.normalize("NFC", str(text or ""))
    out = CONTROL_RE.sub("", out)
    out = out.replace("\r\n", "\n").replace("\r", "\n")
    out = WS_RE.sub(" ", out)
    lines = [part.strip() for part in out.split("\n")]
    return "\n".join(line for line in lines if line)


def strip_tracking(url: str) -> str:
    """Drop `?query` / `#fragment`; keep scheme, host and path."""
    return re.split(r"[?#]", url, maxsplit=1)[0]


# ── Step 4 (part): PII masking ───────────────────────────────────────
def mask_pii(text: str, kb_values: dict[str, str] | None = None) -> tuple[str, list[str]]:
    """Replace known-public values with their placeholder, strip the rest.

    §7.2/§8.4: verbatim values (URLs, emails) must come from the app, not
    from the model. So a value the knowledge base already declares public
    becomes `<|fact:id|>` in the corpus — the model literally cannot learn
    to type it out. Anything else that looks like PII is removed, because
    memorising a stranger's address is not a capability we want.
    """
    from ai.tokenizer import spec

    notes: list[str] = []
    out = str(text or "")

    for fact_id, value in (kb_values or {}).items():
        value = str(value or "").strip()
        if len(value) < 4 or value not in out:
            continue
        out = out.replace(value, spec.placeholder_token(fact_id))
        notes.append(f"placeholder:{fact_id}")

    for match in sorted(set(URL_RE.findall(out)), key=len, reverse=True):
        if is_kept_host(match):
            out = out.replace(match, strip_tracking(match))
        else:
            out = out.replace(match, " ")
            notes.append("dropped:url")

    for match in sorted(set(EMAIL_RE.findall(out)), key=len, reverse=True):
        out = out.replace(match, " ")
        notes.append("dropped:email")

    for match in sorted(set(PHONE_RE.findall(out)), key=len, reverse=True):
        digits = re.sub(r"\D", "", match)
        if len(digits) >= 10:  # avoid eating "8.28" or "2026-09-20"
            out = out.replace(match, " ")
            notes.append("dropped:phone")

    out = LONG_DIGITS_RE.sub(" ", out)
    return normalize_text(out), notes


# ── Step 3: dedupe ───────────────────────────────────────────────────
def shingles(text: str, size: int = SHINGLE) -> frozenset[str]:
    words = text.lower().split()
    if len(words) < size:
        return frozenset([" ".join(words)]) if words else frozenset()
    return frozenset(" ".join(words[i:i + size]) for i in range(len(words) - size + 1))


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class Deduper:
    """Exact-hash first, then shingle-bucket Jaccard for near-duplicates.

    Shingles are bucketed by the minimum shingle hash, so a candidate only
    has to be compared against the (small) bucket it lands in — the
    difference between O(n²) and O(n·bucket) when a corpus has thousands
    of template-generated lines, which this one deliberately does.
    """

    def __init__(self, threshold: float = NEAR_DUP_THRESHOLD):
        self.threshold = threshold
        self.exact: set[str] = set()
        self.buckets: dict[str, list[frozenset]] = {}
        self.pairs = 0

    def is_duplicate(self, text: str) -> bool:
        key = hashlib.sha1(text.encode("utf-8")).hexdigest()
        if key in self.exact:
            return True
        sh = shingles(text)
        if not sh:
            return False
        bucket = min(hashlib.sha1(s.encode("utf-8")).hexdigest() for s in sh)[:8]
        for other in self.buckets.get(bucket, []):
            self.pairs += 1
            if jaccard(sh, other) >= self.threshold:
                return True
        self.exact.add(key)
        self.buckets.setdefault(bucket, []).append(sh)
        return False


# ── Steps 4–5: language-ID + filters ─────────────────────────────────
def is_kept_host(url: str) -> bool:
    return any(host in url.lower() for host in KEEP_HOSTS)


def filter_reasons(text: str) -> list[str]:
    """Why this line must not be trained on. Empty list = keep it.

    `pii_shaped` is deliberately narrower than "contains a URL": a
    github.com link teaches the tokenizer URL syntax and is already
    published, while an arbitrary host with a query string is exactly
    where a tracking id or an address travels. After `mask_pii` the
    surviving URLs are the kept-host ones, and this is the backstop for
    the case where masking was not run first.
    """
    reasons: list[str] = []
    if len(text) < MIN_CHARS:
        reasons.append("too_short")
    if len(text) > MAX_CHARS:
        reasons.append("too_long")
    words = text.split()
    if not words:
        reasons.append("empty")
    elif sum(len(w) for w in words) / len(words) < 2.0:
        reasons.append("no_letters")  # e.g. "1 2 3 4 5" or punctuation soup
    if EMAIL_RE.search(text):
        reasons.append("pii_shaped")
    if any(len(re.sub(r"\D", "", p)) >= 10 for p in PHONE_RE.findall(text)):
        reasons.append("pii_shaped")
    if any(not is_kept_host(url) for url in URL_RE.findall(text)):
        reasons.append("pii_shaped")
    low = text.lower()
    if any(bad in low for bad in TOXIC_WORDS):
        reasons.append("blocklist")
    return reasons


def build_corpus(lines, source: str = "", kb_values: dict[str, str] | None = None,
                 dedupe_threshold: float = NEAR_DUP_THRESHOLD) -> tuple[list[Record], Stats]:
    """Run steps 1–5 over raw lines. Pure; returns records + honest stats."""
    stats = Stats()
    deduper = Deduper(dedupe_threshold)
    records: list[Record] = []

    for raw in lines:
        stats.seen += 1
        text = normalize_text(raw)
        if not text:
            stats.drop("empty")
            continue
        text, notes = mask_pii(text, kb_values)
        if "dropped:email" in notes or "dropped:phone" in notes:
            stats.drop("pii_removed")
            continue
        if not text:
            stats.drop("pii_only")
            continue

        reasons = filter_reasons(text)
        if reasons:
            stats.drop(reasons[0])
            continue
        if deduper.is_duplicate(text):
            stats.drop("near_duplicate")
            continue

        rec = Record(text=text, lang=langid.label(text), source=source, id=text[:48])
        stats.kept += 1
        stats.by_lang[rec.lang] = stats.by_lang.get(rec.lang, 0) + 1
        records.append(rec)

    stats.near_dup_pairs = deduper.pairs
    return records, stats


# ── Step 6 (part): train/val split with leakage checks ───────────────
def assign_split(record: Record, val_percent: int = 2) -> Record:
    """Deterministic split by content hash — no shuffling, no drift."""
    bucket = int(record.sha1[:8], 16) % 100
    record.split = "val" if bucket < val_percent else "train"
    return record


def assign_splits(records: list[Record], val_percent: int = 2) -> list[Record]:
    return [assign_split(r, val_percent) for r in records]


def leakage_report(train: list[Record], val: list[Record]) -> dict:
    """Exact-hash and shingle overlap between the splits.

    Also checks the *shape* the §7.3 spec actually cares about: a val
    document generated from the same template as a train document is
    leakage even when no sentence matches exactly.
    """
    train_hashes = {r.sha1 for r in train}
    overlap = [r.sha1 for r in val if r.sha1 in train_hashes]

    train_buckets: dict[str, list[frozenset]] = {}
    for r in train:
        sh = shingles(r.text)
        if sh:
            key = min(hashlib.sha1(s.encode("utf-8")).hexdigest() for s in sh)[:8]
            train_buckets.setdefault(key, []).append(sh)

    near = 0
    for r in val:
        sh = shingles(r.text)
        if not sh:
            continue
        key = min(hashlib.sha1(s.encode("utf-8")).hexdigest() for s in sh)[:8]
        if any(jaccard(sh, other) >= NEAR_DUP_THRESHOLD
               for other in train_buckets.get(key, [])):
            near += 1

    return {
        "train_docs": len(train),
        "val_docs": len(val),
        "exact_overlap": len(overlap),
        "near_overlap": near,
        "clean": not overlap and near == 0,
    }


# ── Steps 7–8: tokenize + shard ──────────────────────────────────────
def write_shards(records: list[Record], tokenizer, out_dir: Path | str,
                 dtype: str = "uint16", tokenizer_version: str | None = None) -> dict:
    """Write `train.bin` / `val.bin` (+ manifest) as raw token-id memmaps.

    `<|end|>` is appended to every document: it is the only separator the
    model ever sees, so it is the only one it can learn to emit (§7.4's
    stop condition).

    The manifest records the vocabulary this shard was tokenized with — both
    `vocab_size` and the originating `tokenizer_version` — because token ids
    are only meaningful relative to a tokenizer. `ShardSet.assert_matches_tokenizer`
    reads both back; without them, shards built with one tokenizer are
    indistinguishable from shards built with another.
    """
    from ai.tokenizer import spec

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    vocab_size = tokenizer.get_vocab_size()
    end_id = tokenizer.token_to_id(spec.END_TOKEN)
    if end_id is None:  # pragma: no cover - guarded by the tokenizer contract
        raise SystemExit("tokenizer has no <|end|> token")

    manifest: dict = {"dtype": dtype, "vocab_size": vocab_size,
                      "tokenizer_version": tokenizer_version,
                      "end_token_id": end_id, "shards": {}}

    for split in ("train", "val"):
        docs = [r for r in records if r.split == split]
        if not docs:
            manifest["shards"][split] = {"docs": 0, "tokens": 0, "file": None}
            continue

        files: list[dict] = []
        # Shard size keeps any single file inside a comfortable memmap
        # window and makes the data cursor a (shard, offset) pair.
        per_shard = 250
        for index in range(0, len(docs), per_shard):
            chunk = docs[index:index + per_shard]
            token_lists = [tokenizer.encode(r.text, add_special_tokens=False).ids + [end_id]
                           for r in chunk]
            flat = np.concatenate([np.asarray(t, dtype=np.int64) for t in token_lists])
            if flat.max() >= 65536 and dtype == "uint16":
                raise SystemExit("vocab exceeds uint16 — switch shard dtype")
            name = f"{split}-{index // per_shard:05d}.bin"
            (out_dir / name).write_bytes(flat.astype(dtype).tobytes())
            files.append({
                "file": name, "docs": len(chunk), "tokens": int(flat.size),
                "sha256": hashlib.sha256((out_dir / name).read_bytes()).hexdigest()[:16],
                "langs": _count_langs(chunk),
            })
        manifest["shards"][split] = {
            "docs": len(docs),
            "tokens": sum(f["tokens"] for f in files),
            "files": files,
        }

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def _count_langs(chunk: list[Record]) -> dict:
    out: dict[str, int] = {}
    for r in chunk:
        out[r.lang] = out.get(r.lang, 0) + 1
    return dict(sorted(out.items()))


def load_shard(path: Path | str, dtype: str = "uint16") -> np.ndarray:
    """Memory-mapped token ids for training.

    A memmap holds the file open for as long as it is alive — on Windows
    that means the file cannot be deleted or replaced, so anything that
    writes to a shard directory must close it first (`np.memmap._mmap`
    or by letting the last reference go).
    """
    return np.memmap(Path(path), dtype=np.dtype(dtype), mode="r")


def read_shard(path: Path | str, dtype: str = "uint16") -> np.ndarray:
    """Read a shard into memory and release the file handle immediately."""
    return np.fromfile(Path(path), dtype=np.dtype(dtype))
