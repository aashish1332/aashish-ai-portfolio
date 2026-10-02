"""ai/tokenizer/train.py — train our own BPE (§7.2).

    python -m ai.tokenizer.train --corpus data/raw/seed/*.txt \
        --vocab-size 4096 --out ai/tokenizer/artifacts/seed-4k

Rules from the spec, enforced here rather than remembered:

* **Our own vocab, never a pretrained one.** This trains from scratch on
  our corpus files only. Nothing is downloaded, nothing is loaded.
* **Byte-level BPE → byte fallback for free.** The pre-tokenizer runs on
  annotated bytes, so every byte of every script (Devanagari, emoji, the
  contents of a `.docx`) is representable; there is no unknown token.
* **NFC normalization** first, so `क` + `़` and the precomposed `क़` are one
  sequence — otherwise the same Hindi word trains into two different
  token sequences and fertility doubles for no reason.
* **Vocab 12–16k** for the real run, hard-capped at 32k (§7.2: above 16k
  embeddings eat capacity faster than they buy fertility). The local seed
  run defaults lower because the seed corpus is a dev fixture; the
  requested size is recorded either way, and a shortfall is a *failure*,
  not a surprise, because `count_parameters` sizes the embedding from it.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

if __package__ in (None, ""):  # run as a plain file
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.tokenizer import spec  # noqa: E402

MIN_VOCAB, MAX_VOCAB = 1024, 32768
VOCAB_STEP = 1024  # embeddings are qdim-friendly at 1k multiples


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _rel(path: Path) -> str:
    """Repo-relative path when possible, absolute otherwise.

    Glob patterns return repo-relative paths and explicit arguments return
    whatever the shell gave, so both shapes have to work — the corpus
    list is part of the artifact's provenance and must not be silently
    dropped or crash the run.
    """
    try:
        return str(path.resolve().relative_to(spec.REPO_ROOT)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=spec.REPO_ROOT, capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def train_tokenizer(
    corpus_files: list[Path],
    vocab_size: int,
    out_dir: Path,
    name: str = spec.DEFAULT_NAME,
    min_frequency: int = 2,
) -> dict:
    """Train the BPE, write `tokenizer.json` + `meta.json`, verify §7.2."""
    from tokenizers import Tokenizer, decoders, models, normalizers, pre_tokenizers, trainers

    if not corpus_files:
        raise SystemExit("no corpus files — run `python -m training.scripts.prepare_data` first")
    if vocab_size % VOCAB_STEP or not (MIN_VOCAB <= vocab_size <= MAX_VOCAB):
        raise SystemExit(
            f"--vocab-size must be a multiple of {VOCAB_STEP} in "
            f"[{MIN_VOCAB}, {MAX_VOCAB}] (§7.2 caps at 32k); got {vocab_size}"
        )

    kb = spec.load_kb()
    placeholders = spec.placeholder_tokens(kb)
    added = list(spec.SPECIAL_TOKENS) + placeholders

    tokenizer = Tokenizer(models.BPE(unk_token=None))
    tokenizer.normalizer = normalizers.NFC()
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tokenizer.decoder = decoders.ByteLevel()

    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=added,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tokenizer.train([str(p) for p in corpus_files], trainer)

    actual = tokenizer.get_vocab_size()
    if actual != vocab_size:
        raise SystemExit(
            f"trained vocab is {actual}, requested {vocab_size}. The corpus is too "
            f"small to justify this vocabulary — either lower --vocab-size or add "
            f"corpus (a mismatched vocab silently resizes the embedding layer)."
        )

    checks = spec.assert_tokenizer_contract(tokenizer, kb)

    out_dir.mkdir(parents=True, exist_ok=True)
    tokenizer_file = out_dir / "tokenizer.json"
    tokenizer.save(str(tokenizer_file))

    version = spec.tokenizer_version(name, vocab_size, kb)
    meta = {
        "tokenizer_version": version,
        "name": name,
        "vocab_size": vocab_size,
        "model_type": "byte-level BPE (our own, trained from scratch)",
        "normalizer": "NFC",
        "byte_fallback": True,
        "unknown_token": None,
        "special_tokens": list(spec.SPECIAL_TOKENS),
        "placeholder_count": len(placeholders),
        "spec_hash": spec.spec_hash(kb),
        "min_frequency": min_frequency,
        "corpus": {
            "files": [_rel(p) for p in corpus_files],
            "bytes": sum(p.stat().st_size for p in corpus_files),
            "sha256": {p.name: _sha256(p) for p in corpus_files},
        },
        "artifact": {"file": tokenizer_file.name, "sha256": _sha256(tokenizer_file)},
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git_commit": _git_commit(),
        "python": platform.python_version(),
    }
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {"tokenizer": tokenizer, "meta": meta, "checks": checks, "out_dir": out_dir}


def load(out_dir: Path | str):
    """Load a trained artifact plus its meta (used by inference + tests)."""
    from tokenizers import Tokenizer

    out_dir = Path(out_dir)
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    return Tokenizer.from_file(str(out_dir / "tokenizer.json")), meta


def main(argv: list[str] | None = None) -> int:
    # The §7.2 in this line is not decoration: on a cp1252 console argparse
    # raises UnicodeEncodeError printing it.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Train the scratch BPE tokenizer (§7.2)")
    ap.add_argument("--corpus", nargs="+", required=True,
                    help="corpus files or globs (data/raw/seed/*.txt)")
    ap.add_argument("--vocab-size", type=int, default=4096)
    ap.add_argument("--out", required=True, help="artifact directory")
    ap.add_argument("--name", default=spec.DEFAULT_NAME)
    ap.add_argument("--min-frequency", type=int, default=2)
    args = ap.parse_args(argv)

    files: list[Path] = []
    for pattern in args.corpus:
        hits = [Path(p) for p in glob.glob(pattern)]
        files.extend(sorted(hits) if hits else [Path(pattern)])
    missing = [p for p in files if not p.is_file()]
    if missing:
        raise SystemExit(f"corpus file not found: {missing[0]}")
    files = [p.resolve() for p in files]

    result = train_tokenizer(files, args.vocab_size, Path(args.out),
                             name=args.name, min_frequency=args.min_frequency)
    meta = result["meta"]

    print(f"tokenizer_version : {meta['tokenizer_version']}")
    print(f"vocab_size        : {meta['vocab_size']} ({meta['placeholder_count']} placeholders)")
    print(f"corpus            : {len(files)} files, {meta['corpus']['bytes']:,} bytes")
    print(f"artifact          : {result['out_dir'] / 'tokenizer.json'}")
    for check in result["checks"]:
        print(f"  ✓ {check}")

    # §7.2: "Report tokens-per-word for EN / HI / Hinglish / tech terms."
    from ai.tokenizer.fertility import report

    print()
    report(result["tokenizer"], meta["vocab_size"])
    print("\nOK — artifact is spec-conformant.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
