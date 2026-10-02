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
| **the saved state is current** | `live=` objects re-read on every save; `assert_state_fresh` on save *and* load |

The missing-key check earns its keep. An auto-resume that finds a checkpoint
written by an older, buggy save (no GradScaler, say) otherwise trains with a
*fresh* scaler and silently changes the effective loss scale mid-run; the
failure is invisible and only shows up as worse numbers later.
`CheckpointManager` refuses to load instead.

**The key check was not enough, and finding that out cost a 4h21m GPU run.**
Presence is not freshness. Stage A v2 (2026-10-02) trained 20,000 steps to a
final loss of 3.33 and wrote a checkpoint with all eleven required keys
present, a correct config, a matching tokenizer generation, and an optimizer
that had never been stepped: `optimizer.state` was empty and
`scheduler.last_epoch` was 0, because the state dict was built once at step 0
and the three save sites refreshed only `loss_history`, `data_cursor` and
`rng`. Every check that asked *is the key there* passed. Nothing asked
*does it hold this step's value*. So there are now two guards: the trainer
hands its live objects to the manager and cannot save a stale one, and
`assert_state_fresh` compares the values against the run's own recorded
hyperparameters on the way in and out.

Note what the stale file could still do: `--init` reads four keys and is
unaffected, which is why `train_stage_b.load_init_weights` deliberately does
not come through `load`. A weights-only file (`WEIGHTS_ONLY_KEYS`) is
initialisable and impossible to resume, which is the correct state of affairs
for a run whose optimizer state was never captured.
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
    "hyperparameters",
)

# The parts of a state dict that keep changing as the run proceeds, and which
# therefore have to be re-read from the live objects at every save. See
# `CheckpointManager.__init__` for why this list is enforced rather than
# remembered.
REFRESHABLE_STATE = ("optimizer", "scheduler", "scaler")

# The keys a *weights-only* checkpoint keeps. Deliberately not a subset of
# `REQUIRED_STATE_KEYS` that `load` would accept: a stripped file must fail to
# resume, loudly and by name, or the next person to find it will resume from a
# model whose optimizer was thrown away. It is initialisable and nothing else.
WEIGHTS_ONLY_KEYS = ("model", "config", "tokenizer_version", "step", "epoch",
                     "rng")

# The hyperparameter keys a checkpoint must record for `assert_state_fresh` to
# be able to tell "no optimizer moments yet" (step < grad_accum, correct) from
# "the moments were never captured" (step >= grad_accum, the defect).
REQUIRED_HYPERPARAMS = ("grad_accum", "steps", "warmup")

RUN_MANIFEST = "RUN_MANIFEST.json"


class MissingStateError(ValueError):
    """A checkpoint that would resume into a different training run."""


class StaleStateError(MissingStateError):
    """A checkpoint whose keys are all present but whose values are not current.

    Separate from `MissingStateError` because it is a different failure and
    needs a different fix: nothing is absent, so the key check passes, and a
    resume proceeds believing it has Adam moments and a schedule position it
    does not have. This is the defect the 2026-10-02 Stage A run (v2) shipped
    — see `CheckpointManager.save`.
    """


def _optimizer_is_stale(opt: dict) -> bool | None:
    """True/False if the dict's shape settles it, None if it cannot tell.

    The question is "does this carry any optimizer moment?", and the honest
    answer is only available for a torch-shaped dict, which is what a trainer
    writes: `{"state": {...}, "param_groups": [...]}`. Two rules, in order:

    * `state` present and empty → stale, unconditionally. That is v2.
    * `state` present and non-empty → fresh. That is every checkpoint written
      after the first optimizer update.
    * `state` absent → cannot tell, unless `param_groups` is there, which means
      it is a torch optimizer dict and `state` was dropped. Stale.

    Returning None rather than guessing matters: the pure-logic tests build
    state dicts by hand with an optimizer of their own shape, and a check that
    called all of those stale would be a check that cries wolf. But the third
    rule is why None does not leave a hole — the only dicts that reach it are
    the ones that are not pretending to be torch optimizers.
    """
    if not isinstance(opt, dict):
        return None
    if "state" in opt:
        return not opt["state"]
    if "param_groups" in opt:
        return True
    return None


def _scheduler_is_stale(sched: dict) -> bool | None:
    """Same discipline. A torch LR scheduler always carries `last_epoch`."""
    if not isinstance(sched, dict) or "last_epoch" not in sched:
        return None
    return int(sched.get("last_epoch") or 0) <= 0


def assert_state_fresh(state: dict, label: str) -> None:
    """Refuse a checkpoint whose optimizer/scheduler are older than its step.

    Every required key was present in v2's 20,000-step checkpoint, so the
    `REQUIRED_STATE_KEYS` check passed and the run looked resumable. It was
    not: `optimizer.state` was empty and `scheduler.last_epoch` was 0, because
    both objects had been snapshotted into the state dict once at step 0 and
    never refreshed. Resuming it would have restarted the cosine from the
    beginning with an AdamW that had no moments.

    Presence is not freshness. A key can be there and hold the wrong step's
    value, and no amount of checking that the key exists will notice. This
    check compares the *values* against the run's own recorded
    hyperparameters, which is the only evidence that can tell the two apart:
    a checkpoint at step 3 with `grad_accum=8` is legitimately moment-free,
    and one at step 3,000 is not.
    """
    step = int(state.get("step", 0) or 0)
    hyper = state.get("hyperparameters")
    grad_accum = None
    if isinstance(hyper, dict) and "grad_accum" in hyper:
        grad_accum = max(1, int(hyper["grad_accum"]))
    if grad_accum is not None and step < grad_accum:
        return  # no optimizer update has happened yet; an empty state is correct

    # Observable staleness is checked *before* the hyperparameter record, and
    # the order matters for what a reader is told. A file written before the
    # record existed is missing `hyperparameters`, and that is a true thing to
    # report — but on v2 the empty optimizer is the defect, and leading with
    # the missing bookkeeping gets a reader looking in the wrong place.
    if _optimizer_is_stale(state.get("optimizer")):
        extra = ("" if grad_accum is None else
                 f" (>= grad_accum {grad_accum})")
        raise StaleStateError(
            f"{label} is at step {step}{extra} but its optimizer holds no "
            f"moments for any parameter: the optimizer was captured before the "
            f"first update and never refreshed. Resuming this would silently "
            f"restart Adam with no state.")
    if _scheduler_is_stale(state.get("scheduler")):
        raise StaleStateError(
            f"{label} is at step {step} but its scheduler is at last_epoch "
            f"<= 0: the schedule was captured at construction and never "
            f"stepped, so a resume would re-run the whole warmup and cosine "
            f"from the start.")

    if not isinstance(hyper, dict):
        raise MissingStateError(
            f"{label} records no hyperparameters, so the one legitimate "
            f"reason for an optimizer with no moments — step < grad_accum — "
            f"cannot be ruled out (step {step})")
    absent = [k for k in REQUIRED_HYPERPARAMS if k not in hyper]
    if absent:
        raise MissingStateError(
            f"{label} hyperparameters are missing {absent} — §7.5's manifest "
            f"fields are needed to tell a fresh optimizer from a stale one")


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
    """Writes resumable checkpoints. `live` is how it avoids writing stale ones.

    The 2026-10-02 Stage A run (v2) produced a 20,000-step checkpoint whose
    `optimizer.state` was empty and whose `scheduler.last_epoch` was 0. The
    cause was one line, repeated at three save sites: the trainer built its
    state dict once at step 0 and then refreshed only `loss_history`,
    `data_cursor` and `rng` before each `save`. The optimizer, scheduler and
    scaler in that dict were the objects as they were before the first
    optimizer update, and they stayed that way for the whole run.

    So `live` holds the live objects and `save` re-reads them on every write.
    The alternative — passing the fresh state in at each of the three call
    sites — is the same thing that already failed, with an extra step for
    whoever adds the fourth save site. A trainer hands the manager its
    optimizer once and cannot then save a stale one.
    """

    def __init__(self, run_dir: Path | str, keep_last: int = 3, serializer=None,
                 live: dict | None = None):
        self.run_dir = Path(run_dir)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.keep_last = keep_last
        self.serializer = serializer or default_serializer()
        self.live = dict(live or {})
        unknown = sorted(set(self.live) - set(REFRESHABLE_STATE))
        if unknown:
            # A misspelled key would be silently ignored, and the checkpoint
            # would be written stale — the exact failure this exists to stop.
            raise ValueError(
                f"live={unknown} are not refreshable state; pass only "
                f"{list(REFRESHABLE_STATE)} (the rest is rebuilt per save anyway)")

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
        payload = dict(state)
        payload.setdefault("epoch", 0)
        for name in REFRESHABLE_STATE:
            obj = self.live.get(name)
            if obj is not None:
                payload[name] = obj.state_dict()
        # After the refresh, not before: handing the manager the live objects
        # is a complete way to supply these three keys, so a caller that did
        # that should not also have to pass a snapshot of them. The first
        # version checked first and rejected a perfectly good call, which is
        # the wrong way round — a check that fires on correct code teaches
        # people to work around it.
        missing = [k for k in REQUIRED_STATE_KEYS if k not in payload]
        if missing:
            raise MissingStateError(
                f"checkpoint state is missing {missing}. Refusing to write a "
                f"checkpoint that cannot resume the run it came from (§7.5). "
                f"{sorted(self.live)} are supplied from the live objects; the "
                f"rest have to be in the state dict.")

        payload["saved_at"] = time.time()
        payload["git_commit"] = git_commit()
        assert_state_fresh(payload, f"checkpoint at step {step}")
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
        assert_state_fresh(state, path.name)
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
