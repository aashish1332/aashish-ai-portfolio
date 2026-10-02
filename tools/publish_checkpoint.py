"""Publish the Stage A checkpoint so a Stage B session can find it.

    python tools/publish_checkpoint.py --run kaggle-push/out/ckpt/checkpoints/stage-a --weights-only

Why this exists: `train_stage_b.ipynb` used to point `--init` at
`/kaggle/working/checkpoints/stage-a`, which is the *session's own* ephemeral
directory. Stage A runs in a different kernel version and `/kaggle/working` is
wiped when that session ends, so that path can never hold a checkpoint — the
notebook printed `stage A checkpoint: False` and carried on, and the failure
surfaced two cells later as a missing `--init`, reading like a Stage B fault.

Why one archive: a directory of files does not survive `kaggle datasets create`.
Measured 2026-10-02 on the 3,521-file corpus cache — it uploaded **one** file,
`CACHE.json`, and reported success. A single `.tgz` is the shape that is known
to arrive intact (it is how the repository dataset already ships), and the
notebook searches for it rather than naming a mount path, because a Kaggle
Dataset does not land at `/kaggle/input/<name>`.

What is published: `latest.pt`, `best.pt` and `RUN_MANIFEST.json`, plus a
`CHECKPOINT.json` recording the sha256 of each, the parameter count, the
tokenizer generation and the step count read back out of the manifest. The
notebook verifies the manifest's tokenizer generation against the tokenizer it
is about to train with, which is the check that matters: `--init` from a
different vocabulary produces a model that loads *some* keys and trains a
half-random rest without any error to notice.

A weights-only publish drops `best.pt` and nothing else — `RUN_MANIFEST.json`
still ships, because `train_stage_b.ipynb` opens it two cells in. See
`tests/py/test_publish_checkpoint.py`, which checks this publisher's output
against the files the notebook actually reads, because the two had drifted
apart with nothing to notice.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

DATASET_ID = "aashishkumarrajput/aashish-ai-stage-a-checkpoint"
ARCHIVE_NAME = "stage-a-checkpoint.tgz"
RECORD_NAME = "CHECKPOINT.json"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
#: The pulled checkpoints and the staging area are still scratch, so they stay in
#: the gitignored kaggle-push/ directory; only this publisher is versioned.
SCRATCH = ROOT / "kaggle-push"

WEIGHTS_NOTE = (
    "Weights only. The optimizer, scheduler and GradScaler were captured "
    "before this run's first update and never refreshed, so this file cannot "
    "resume anything: training.scripts.checkpoint.CheckpointManager.load "
    "refuses it by name, listing the missing keys. Use it with train_stage_b "
    "--init, which reads the model weights and nothing else. See "
    "docs/PROGRESS.md, 2026-10-02, defect 11."
)


def verify(run_dir: Path) -> tuple[bool, str]:
    """Is this checkpoint one a resume could honestly continue?

    Answered by the trainer's own guard rather than by a look at the files.
    The 2026-10-02 Stage A v2 run shipped a 20,000-step checkpoint whose
    `optimizer.state` was empty and whose `scheduler.last_epoch` was 0, and it
    passed every check that only asked whether the *keys* were there. Nothing
    about the archive would have revealed it either: the bytes are a complete,
    loadable, correctly-shaped checkpoint. Only the values are wrong.
    """
    sys.path.insert(0, str(ROOT))
    import torch

    from training.scripts.checkpoint import MissingStateError, assert_state_fresh

    path = run_dir / "latest.pt"
    state = torch.load(path, map_location="cpu", weights_only=False)
    try:
        assert_state_fresh(state, path.name)
    except MissingStateError as exc:
        return False, f"{exc.__class__.__name__}: {exc}"
    moments = len((state.get("optimizer") or {}).get("state") or {})
    return True, (f"step {state.get('step'):,} carries moments for {moments} "
                  f"tensors at scheduler last_epoch "
                  f"{state.get('scheduler', {}).get('last_epoch')}")


def strip_to_weights(source: Path, target: Path) -> dict:
    """A weights-only copy, so the published file cannot be mistaken for one.

    Stripping rather than publishing the original is the point: a file called
    `latest.pt` that loads and looks complete is exactly what got filed as a
    good checkpoint on 2026-10-02. This one is missing keys on purpose, and
    `load` says so by name.
    """
    import torch

    from training.scripts.checkpoint import WEIGHTS_ONLY_KEYS

    state = torch.load(source, map_location="cpu", weights_only=False)
    reduced = {k: state[k] for k in WEIGHTS_ONLY_KEYS if k in state}
    reduced["weights_only"] = True
    reduced["note"] = WEIGHTS_NOTE
    torch.save(reduced, target)
    return reduced


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def staged_names(resumable: bool) -> tuple[str, ...]:
    """The filenames a publish of this kind will contain.

    Split out, and used to *drive* both the validation and the copy, so that
    `tests/py/test_publish_checkpoint.py` can check one list against the files
    `train_stage_b.ipynb` actually opens. Those two had drifted apart with
    nothing to notice: a weights-only publish shipped `latest.pt` and
    `CHECKPOINT.json`, and the notebook's cell 5 opens `RUN_MANIFEST.json` — so
    the first Stage B session that could ever use such a checkpoint died on
    FileNotFoundError, two cells in, in a run that had taken eight GPU-hours to
    produce.

    `best.pt` is the only name a weights-only publish drops, and the reason is
    not size alone: a weights-only copy has no optimizer state, so it cannot be
    resumed, and nothing resumes from `best.pt`. `latest.pt` is the only
    checkpoint Stage B initialises from.
    """
    if resumable:
        return ("latest.pt", "best.pt", "RUN_MANIFEST.json")
    return ("latest.pt", "RUN_MANIFEST.json")


def collect(run_dir: Path) -> list[Path]:
    found = []
    for name in staged_names(True):
        path = run_dir / name
        if not path.is_file():
            raise SystemExit(
                f"{path}: missing. A Stage B session cannot initialise from a "
                f"partial checkpoint. Pull it first:\n"
                f"  python kaggle-push/pull_checkpoint.py")
        found.append(path)
    return found


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--run", type=Path,
                    default=SCRATCH / "out" / "ckpt" / "checkpoints" / "stage-a",
                    help="the stage-a run directory pull_checkpoint.py wrote")
    ap.add_argument("--stage", type=Path, default=SCRATCH / "checkpoint-stage",
                    help="the directory that gets uploaded")
    ap.add_argument("--new", action="store_true",
                    help="create the dataset instead of adding a version")
    ap.add_argument("--weights-only", action="store_true",
                    help="publish the model weights alone, for a checkpoint "
                         "whose optimizer/scheduler state is stale. The result "
                         "cannot be resumed; it can only be --init'd.")
    ap.add_argument("--dry-run", action="store_true", help="build, upload nothing")
    args = ap.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ok, detail = verify(args.run)
    print(f"\ncheckpoint: {'RESUMABLE' if ok else 'NOT RESUMABLE'} — {detail}")
    if not ok and not args.weights_only:
        print(
            "\nrefusing to publish.\n"
            "  This checkpoint's weights are fine; its optimizer and scheduler\n"
            "  are not in the file. A Stage B session that --resume'd it would\n"
            "  silently restart Adam with no moments and replay the warmup.\n"
            "\n"
            "  If all you need is the weights — which is what\n"
            "  train_stage_b --init reads, and nothing else — republish with\n"
            "      --weights-only\n"
            "  which strips the unusable state and says so in CHECKPOINT.json.\n"
            "\n"
            "  To fix the checkpoint itself, re-run Stage A with the current\n"
            "  trainer; the defect is in the save path, not in the weights.")
        return 1

    files = collect(args.run)
    manifest = json.loads((args.run / "RUN_MANIFEST.json").read_text(encoding="utf-8"))

    # The stage directory is emptied *before* anything is written into it. The
    # first version stripped the weights into `stage/stripped` and reset the
    # stage afterwards, which deleted the files it had just made and then failed
    # with a FileNotFoundError pointing at a path that no longer existed.
    if args.stage.exists():
        import shutil

        shutil.rmtree(args.stage)
    args.stage.mkdir(parents=True)

    publish_dir = args.run
    if not ok:
        publish_dir = args.stage / "stripped"
        publish_dir.mkdir(parents=True, exist_ok=True)
        # `latest.pt` only, of the two weight files. A weights-only copy cannot
        # be resumed, so `best.pt` has no reader: Stage B initialises from
        # `latest.pt` and nothing else, and shipping it would add 150 MB of
        # near-identical weights to every download. A resumable publish still
        # carries both.
        #
        # RUN_MANIFEST.json travels either way, and dropping it was a real defect
        # found on 2026-10-02: a weights-only publish staged only `latest.pt` and
        # `CHECKPOINT.json`, while Stage B's cell 5 does
        # `json.load(open(f'{STAGE_A}/RUN_MANIFEST.json'))` to print the Stage A
        # step, tokenizer and parameter count. So the first run a Stage B
        # session could ever do from a weights-only checkpoint died on
        # FileNotFoundError - and lost the one record that joins Stage A to
        # Stage B on paper rather than in memory. It is 465 KB against 150 MB,
        # so there was never a size argument for leaving it behind.
        strip_to_weights(args.run / "latest.pt", publish_dir / "latest.pt")
        files = [publish_dir / "latest.pt"]
        for name in staged_names(False):
            if name == "latest.pt":
                continue
            shutil.copy2(args.run / name, publish_dir / name)
            files.append(publish_dir / name)
        print(f"  stripped to weights: {publish_dir}")

    record = {
        "source_run_dir": str(args.run),
        "step": manifest.get("hyperparameters", {}).get("steps"),
        "params": manifest.get("params"),
        "tokenizer_version": manifest.get("tokenizer_version"),
        "loss_verdict": manifest.get("loss", {}).get("verdict"),
        "resumable": ok,
        "verification": detail,
        "files": {path.name: {"bytes": path.stat().st_size,
                              "sha256": sha256_file(path)} for path in files},
    }
    if not ok:
        record["weights_only_note"] = WEIGHTS_NOTE

    archive_path = args.stage / ARCHIVE_NAME
    # Members are rooted at the run directory's *name*, so extraction lands
    # `stage-a/...` whichever directory the notebook unpacks into. The stripped
    # copy keeps the original name, because the notebook's `$STAGE_A/latest.pt`
    # is what Stage B initialises from.
    with tarfile.open(archive_path, "w:gz") as tar:
        for path in files:
            tar.add(path, arcname=f"{args.run.name}/{path.name}")
        # CHECKPOINT.json is written last and included, so the archive carries
        # its own record of what it holds.
        payload = json.dumps(record, indent=2) + "\n"
        info = tarfile.TarInfo(f"{args.run.name}/{RECORD_NAME}")
        data = payload.encode("utf-8")
        info.size = len(data)
        import io

        tar.addfile(info, io.BytesIO(data))

    if not ok:
        # The stripped copies are working files, not payload: `datasets create
        # -p .` uploads the whole directory, and leaving them there would ship
        # two extra 150 MB copies of weights the archive already contains.
        import shutil

        shutil.rmtree(publish_dir)

    (args.stage / "dataset-metadata.json").write_text(json.dumps({
        "title": "aashish-ai-stage-a-checkpoint",
        "id": DATASET_ID,
        "licenses": [{"name": "CC0-1.0"}],
        "description": (
            "stage-a-checkpoint.tgz: the Stage A base-model checkpoint "
            f"({record['params']:,} parameters, step {record['step']}, tokenizer "
            f"{record['tokenizer_version']}), so the Stage B session can "
            "--init from it instead of pointing at an ephemeral path. "
            "CHECKPOINT.json inside records the sha256 of every file, the "
            "parameter count, the tokenizer generation and whether the "
            "checkpoint is resumable; the notebook checks that generation "
            "against the tokenizer it trains with, because an --init from a "
            "different vocabulary loads some keys and trains the rest at "
            "random with no error to notice."
            + ("" if ok else " THIS COPY IS WEIGHTS ONLY: its optimizer and "
                              "scheduler state was never captured, so it "
                              "cannot be resumed. Use it with --init.")
        ),
    }, indent=2) + "\n", encoding="utf-8")

    total = sum(p.stat().st_size for p in args.stage.rglob("*") if p.is_file())
    print(f"\nstaged {total / 1e6:,.1f} MB in {args.stage}")
    print(f"  step              {record['step']}")
    print(f"  params            {record['params']:,}")
    print(f"  tokenizer         {record['tokenizer_version']}")
    print(f"  resumable         {record['resumable']}")
    for name, meta in record["files"].items():
        print(f"  {name:<18} {meta['bytes']:>12,} B  sha {meta['sha256'][:16]}")

    if args.dry_run:
        print("\n--dry-run: nothing uploaded.")
        return 0

    if args.new:
        command = [sys.executable, "-m", "kaggle", "datasets", "create", "-p", "."]
    else:
        command = [sys.executable, "-m", "kaggle", "datasets", "version", "-p", ".",
                   "-m", "Stage A checkpoint"]
    print(f"\n$ {' '.join(command[2:])}")
    result = subprocess.run(command, cwd=str(args.stage))
    if result.returncode != 0:
        print(f"\nupload failed. If this is the first publish, pass --new.")
        return result.returncode
    print("\nnext: add this dataset to the Stage B kernel's dataset_sources.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())