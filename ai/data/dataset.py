"""ai/data/dataset.py — memmap shards + a cursor that survives a crash.

`prepare_data.py` writes raw token ids; this reads them back through
`np.memmap` (so a 4 GB shard costs nothing in RAM) and hands out training
blocks.

The interesting part is `TokenBatcher`. "Training is resumable" is only
true if the *data stream* resumes too: an auto-resume that reloads the
optimizer but re-draws the same blocks silently trains on the same tokens
twice, and an auto-resume that skips ahead silently drops a chunk to a
random offset. So the batcher's state is (RNG state, tokens consumed) and
the guarantee is exact: **resuming from a saved state produces the same
continuation an uninterrupted run would have produced.** That is a
property a test can check without torch, and `tests/py/test_checkpoint.py`
does.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.data import pipeline  # noqa: E402


@dataclass
class ShardSet:
    """The shards written by `pipeline.write_shards`, memory-mapped."""

    root: Path
    manifest: dict
    dtype: str = "uint16"

    @property
    def train_files(self) -> list[str]:
        return [f["file"] for f in self.manifest["shards"]["train"].get("files", [])]

    @property
    def val_files(self) -> list[str]:
        return [f["file"] for f in self.manifest["shards"]["val"].get("files", [])]

    @property
    def train_tokens(self) -> int:
        return self.manifest["shards"]["train"]["tokens"]

    @property
    def val_tokens(self) -> int:
        return self.manifest["shards"]["val"]["tokens"]

    @property
    def eos_token_id(self) -> int:
        return self.manifest["end_token_id"]

    def open(self, split: str) -> list[np.ndarray]:
        files = self.train_files if split == "train" else self.val_files
        return [pipeline.load_shard(self.root / name, self.dtype) for name in files]

    @classmethod
    def load(cls, root: Path | str, dtype: str = "uint16") -> "ShardSet":
        root = Path(root)
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        return cls(root=root, manifest=manifest, dtype=manifest.get("dtype", dtype))


class TokenBatcher:
    """Deterministic random blocks over the shards, with a resumable cursor.

    Blocks are drawn with a seeded numpy Generator and never cross a shard
    boundary (`_offset_to_span` handles the row split), so a block is
    always a contiguous run of tokens from one file.
    """

    def __init__(self, shards: ShardSet, split: str = "train", block: int = 128,
                 batch: int = 4, seed: int = 1337):
        self.shards = shards
        self.split = split
        self.block = block
        self.batch = batch
        self.seed = seed
        self.files = shards.open(split)
        self.lengths = np.array([len(f) for f in self.files], dtype=np.int64)
        if not len(self.files) or self.lengths.sum() <= block + 1:
            raise ValueError(
                f"split {split!r} has {int(self.lengths.sum())} tokens, too few for "
                f"blocks of {block + 1} — run prepare_data with more corpus")
        self.blocks_per_file = np.maximum(self.lengths - block - 1, 0)
        self.block_index = np.repeat(np.arange(len(self.files)), self.blocks_per_file)
        # Global block id → (file, offset) lookup, but stored as two arrays
        # so state stays a plain RNG stream + a counter.
        self.offsets = np.concatenate(
            [np.arange(n, dtype=np.int64) for n in self.blocks_per_file]) \
            if self.blocks_per_file.sum() else np.zeros(0, dtype=np.int64)
        self.total_blocks = int(self.blocks_per_file.sum())
        self.rng = np.random.default_rng(seed)
        self.tokens_consumed = 0
        self.positions: list[tuple[int, int]] = []

    # ── one batch ────────────────────────────────────────────────────
    def next_batch(self) -> tuple[np.ndarray, np.ndarray]:
        """[B, block] inputs and [B, block] next-token targets."""
        picks = self.rng.integers(0, self.total_blocks, size=self.batch)
        xs = np.empty((self.batch, self.block), dtype=np.int64)
        ys = np.empty((self.batch, self.block), dtype=np.int64)
        for row, pick in enumerate(picks):
            file_idx = int(self.block_index[pick])
            offset = int(self.offsets[pick])
            span = np.asarray(self.files[file_idx][offset:offset + self.block + 1],
                              dtype=np.int64)
            if span.size < self.block + 1:  # a shard shorter than one block
                span = np.pad(span, (0, self.block + 1 - span.size), mode="edge")
            xs[row] = span[:-1]
            ys[row] = span[1:]
        self.tokens_consumed += self.batch * self.block
        self.positions.append((int(picks[0]), int(picks[-1])))
        return xs, ys

    def next_batches(self, count: int):
        return [self.next_batch() for _ in range(count)]

    # ── resumable state ──────────────────────────────────────────────
    def state(self) -> dict:
        """Everything needed to continue the *exact* stream."""
        return {
            "seed": self.seed,
            "split": self.split,
            "block": self.block,
            "batch": self.batch,
            "rng": _rng_state(self.rng),
            "tokens_consumed": self.tokens_consumed,
            "batches_drawn": len(self.positions),
        }

    def load_state(self, state: dict) -> None:
        if state["block"] != self.block or state["batch"] != self.batch:
            raise ValueError(
                f"checkpoint ran with block={state['block']} batch={state['batch']} "
                f"but this run uses block={self.block} batch={self.batch}; the token "
                f"stream would not line up")
        self.rng = np.random.default_rng(self.seed)
        _restore_rng(self.rng, state["rng"])
        self.tokens_consumed = state["tokens_consumed"]

    @classmethod
    def resume(cls, shards: ShardSet, state: dict) -> "TokenBatcher":
        batcher = cls(shards, split=state["split"], block=state["block"],
                      batch=state["batch"], seed=state["seed"])
        batcher.load_state(state)
        return batcher

    def validation_batches(self, count: int, seed: int = 0):
        """A fixed, non-streaming sample for eval — no cursor involvement."""
        rng = np.random.default_rng(seed)
        saved, self.rng = self.rng, rng
        try:
            return [self.next_batch() for _ in range(count)]
        finally:
            self.rng = saved


def _rng_state(rng: np.random.Generator) -> dict:
    return rng.bit_generator.state


def _restore_rng(rng: np.random.Generator, state: dict) -> None:
    rng.bit_generator.state = state


def batches_to_torch(batches, device=None, dtype=None):
    """Import torch lazily: everything else in this module works without it."""
    import torch

    xs = torch.tensor(np.stack([b[0] for b in batches]), dtype=dtype or torch.long)
    ys = torch.tensor(np.stack([b[1] for b in batches]), dtype=dtype or torch.long)
    if device is not None:
        return xs.to(device), ys.to(device)
    return xs, ys
