"""Python test suite (tokenizer, model schema, data pipeline, checkpoints).

Run everything:   python -m unittest discover -s tests/py -t .
Run one file:     python -m unittest tests.py.test_checkpoint -v

Tests that need torch (the materialised parameter comparison, the real
training loop) *skip* with a printed reason instead of passing silently, so a
green run on a machine without torch is not mistaken for a verified training
loop.

This docstring used to say "on this development machine torch is not installed",
which stopped being true at some point and was found on 2026-10-02 by checking
rather than trusting it: `torch 2.14.0+cpu`, and `tests.py.test_train_scripts`
runs its 14 tests with 0 skips. The skip machinery is still right — the repo
travels to hosts and into `git archive` extracts where torch may be absent — but
a comment asserting something about the machine must be re-checked before it is
believed. `torch.cuda.is_available()` is False here, which is why the GPU paths
remain measurable only on Kaggle.
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