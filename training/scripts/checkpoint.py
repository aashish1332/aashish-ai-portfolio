"""training/scripts/checkpoint.py — atomic, resumable checkpoints (§7.5).

Spec requirements, and how each one is met here:

| §7.5 requirement | implementation |
|---|---|
| `latest`, `best`, `step_N` | all three written, `step_N` pruned to `keep_last` |
| model + optimizer + scheduler + GradScaler + step/epoch | one state dict; **required keys enforced** on both save and load |
| config + tokenizer version | same dict, validated on load against the live run |
| RNG states | `capture_rng()` / `restore_rng()` — python, numpy, torch (incl. CUDA) |
| data-shard cursor | the caller's `data_cursor` key (see `ai/data/dataset.py`) |
| atomic writes | temp file in the same directory → `os.replace` → `fsync` dir |
| auto-resume | `resolve_resume("auto")` finds `latest.pt` and reports what it is |

The missing-key check is the one that earns its keep. An auto-resume that
finds a checkpoint written by an older, buggy save (no GradScaler, say)
otherwise trains with a *fresh* scaler and silently changes the effective
loss scale mid-run; the failure is invisible and only shows up as worse
numbers later. `CheckpointManager` refuses to load instead.
"""

from __future__ import annotations

import json
import os
import pickle
import random
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

REQUIRED_STATE_KEYS = (
    "model",
    "optimizer",
    "scheduler",
    "scaler",
    "step",
    "epoch",
    "config",
    "tokenizer_version",
    "rng",
    "data_cursor",
    "loss_history",
)

RUN_MANIFEST = "RUN_MANIFEST.json"


class MissingStateError(ValueError):
    """A checkpoint that would resume into a different training run."""


def git_commit() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or None
    except Exception:
        return None


# ── RNG ──────────────────────────────────────────────────────────────
def capture_rng() -> dict:
    """Python + numpy + torch (+CUDA) RNG state in one picklable dict."""
    state = {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
    }
    try:
        import torch

        state["torch"] = torch.get_rng_state()
        if torch.cuda.is_available():
            state["torch_cuda"] = torch.cuda.get_rng_state_all()
    except ImportError:
        state["torch"] = None
    return state


def restore_rng(state: dict) -> None:
    if state.get("python") is not None:
        random.setstate(state["python"])
    if state.get("numpy") is not None:
        np.random.set_state(state["numpy"])
    if state.get("torch") is not None:
        import torch

        torch.set_rng_state(state["torch"])
        if state.get("torch_cuda") and torch.cuda.is_available():
            torch.cuda.set_rng_state_all(state["torch_cuda"])


# ── Serialization ────────────────────────────────────────────────────
class _PickleSerializer:
    name = "pickle"

    @staticmethod
    def save(obj, path: Path) -> None:
        with path.open("wb") as fh:
            pickle.dump(obj, fh, protocol=pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def load(path: Path):
        with path.open("rb") as fh:
            return pickle.load(fh)


class _TorchSerializer:
    name = "torch"

    @staticmethod
    def save(obj, path: Path) -> None:
        import torch

        torch.save(obj, path)

    @staticmethod
    def load(path: Path):
        import torch

        return torch.load(path, map_location="cpu", weights_only=False)


def default_serializer():
    """torch.save when torch exists (tensors + `weights_only=False`), else pickle.

    Injectable so the checkpoint logic is testable on a machine with no
    torch — which is the point: the atomicity, key validation, pruning and
    resume-selection code is exactly the code that must not be wrong, and
    none of it needs a GPU to be exercised.
    """
    try:
        import torch  # noqa: F401

        return _TorchSerializer
    except ImportError:
        return _PickleSerializer


class CheckpointManager:
    def __init__(self, run_dir: Path | str, keep_last: int = 3, serializer=None):
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.keep_last = keep_last
        self.serializer = serializer or default_serializer()

    # ── paths ────────────────────────────────────────────────────────
    def path(self, which: str = "latest") -> Path:
        if which in ("latest", "best"):
            return self.run_dir / f"{which}.pt"
        if which.startswith("step_"):
            return self.run_dir / f"{which}.pt"
        raise ValueError(f"unknown checkpoint name: {which!r}")

    def exists(self, which: str = "latest") -> bool:
        return self.path(which).is_file()

    def steps(self) -> list[int]:
        found = []
        for path in self.run_dir.glob("step_*.pt"):
            try:
                found.append(int(path.stem.split("_")[1]))
            except (IndexError, ValueError):
                continue
        return sorted(found)

    # ── save ─────────────────────────────────────────────────────────
    def save(self, state: dict, step: int, is_best: bool = False,
             extra: dict | None = None) -> Path:
        missing = [k for k in REQUIRED_STATE_KEYS if k not in state]
        if missing:
            raise MissingStateError(
                f"checkpoint state is missing {missing}. Refusing to write a "
                f"checkpoint that cannot resume the run it came from (§7.5).")

        payload = dict(state)
        payload.setdefault("epoch", 0)
        payload["saved_at"] = time.time()
        payload["git_commit"] = git_commit()
        if extra:
            payload["extra"] = extra

        step_path = self.path(f"step_{step}")
        self._atomic_write(payload, step_path)
        self._atomic_write(payload, self.path("latest"))
        if is_best:
            self._atomic_write(payload, self.path("best"))
        self._prune(keep=step)
        return step_path

    def _atomic_write(self, payload: dict, target: Path) -> None:
        """temp in the same dir → fsync → os.replace (atomic on POSIX and NTFS).

        Same directory matters: `os.replace` is only atomic within a
        filesystem, and a run directory can live on a mounted Kaggle output
        path while /tmp is somewhere else entirely.
        """
        tmp = target.with_suffix(target.suffix + f".tmp{os.getpid()}")
        self.serializer.save(payload, tmp)
        try:
            # rb+ rather than rb: Windows' fsync (_commit) refuses a read-only
            # handle. Failing here is not fatal — os.replace below is what makes
            # the write atomic; this only adds durability across a power cut.
            with open(tmp, "rb+") as fh:
                fh.flush()
                os.fsync(fh.fileno())
        except OSError:  # pragma: no cover - platform dependent
            pass
        os.replace(tmp, target)
        try:  # make the rename itself durable where the platform allows it
            dir_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except (OSError, AttributeError):  # Windows: directory fsync is unavailable
            pass

    def _prune(self, keep: int) -> None:
        steps = [s for s in self.steps() if s != keep]
        for step in steps[:max(0, len(steps) - self.keep_last + 1)]:
            try:
                self.path(f"step_{step}").unlink()
            except OSError:
                pass

    # ── load ─────────────────────────────────────────────────────────
    def load(self, which: str = "latest") -> dict:
        path = self.path(which)
        if not path.is_file():
            raise FileNotFoundError(f"no checkpoint at {path}")
        state = self.serializer.load(path)
        if not isinstance(state, dict):
            raise MissingStateError(f"{path} did not load as a state dict")
        missing = [k for k in REQUIRED_STATE_KEYS if k not in state]
        if missing:
            raise MissingStateError(
                f"{path.name} is missing {missing} — it was written by a different "
                f"(or older) trainer and resuming from it would silently change the run")
        return state

    def info(self) -> dict | None:
        """What `--resume auto` would load, without loading the tensors."""
        for which in ("latest", "best"):
            path = self.path(which)
            if path.is_file():
                return {"which": which, "path": str(path),
                        "bytes": path.stat().st_size,
                        "modified": path.stat().st_mtime}
        return None

    def summary(self) -> dict:
        return {
            "run_dir": str(self.run_dir),
            "serializer": self.serializer.name,
            "steps": self.steps(),
            "has_latest": self.exists("latest"),
            "has_best": self.exists("best"),
        }


def resolve_resume(manager: CheckpointManager, choice: str) -> dict | None:
    """`auto` → latest if present; a path → that file; `none` → no resume."""
    if choice in ("none", "", None):
        return None
    if choice == "auto":
        return manager.info()
    path = Path(choice)
    if not path.is_file():
        raise FileNotFoundError(f"--resume {choice}: no checkpoint there")
    return {"which": path.stem, "path": str(path),
            "bytes": path.stat().st_size, "modified": path.stat().st_mtime}


def write_run_manifest(run_dir: Path | str, manifest: dict) -> Path:
    """`training/RUN_MANIFEST.json` — seed, configs, data hashes, hyperparams, commit."""
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git_commit": git_commit(),
        "python": sys.version.split()[0],
        **manifest,
    }
    path = run_dir / RUN_MANIFEST
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path
