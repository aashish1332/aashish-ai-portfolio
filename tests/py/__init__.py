"""Python test suite (tokenizer, model schema, data pipeline, checkpoints).

Run everything:   python -m unittest discover -s tests/py -t .
Run one file:     python -m unittest tests.py.test_checkpoint -v

Tests that need torch (the materialised parameter comparison, the real
training loop) *skip* with a printed reason instead of passing silently —
on this development machine torch is not installed, so a green run must not
be mistaken for a verified training loop.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: Where `train_smoke.py` and `train_stage_a.py` look for shards by default.
SEED_SHARDS = "data/processed/seed/shards"

#: Why a test may need skipping, phrased for someone reading the output.
SEED_SHARDS_MISSING = (
    f"{SEED_SHARDS} is not present. It is generated from "
    f"ai/tokenizer/artifacts/seed-1k and data/processed/ is gitignored (§17 data "
    f"hygiene), so it is absent from an extracted `git archive` and from the "
    f"Kaggle dataset. These tests still run wherever the fixture exists."
)

HAVE_SEED_SHARDS = (ROOT / SEED_SHARDS / "manifest.json").is_file()