"""Mutation-test the checkpoint staleness fix. Run it, do not read it.

    PYTHONUTF8=1 python tools/mutate_checkpoints.py

Every mutation here breaks one load-bearing piece of the 2026-10-02 fix and
names the test that must notice. A mutation that no test catches is not a
failed experiment, it is a hole in the suite wearing a lab coat — so the
runner fails on `CAUGHT == False` as loudly as on an unexpected failure.

Two rules this follows, both learned the hard way on this project:

* **Key on the exit code, not the last line of stdout.** `unittest` prints the
  summary last, but a test that prints after it, or a test whose output
  interleaves under `-b`, makes the last line a liar. `returncode != 0` is the
  only trustworthy signal.
* **Restore in a `finally`.** These mutations edit files that the rest of the
  suite depends on; a runner that dies mid-way leaves the working tree broken
  and the next run's failures unexplainable.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CKPT = ROOT / "training" / "scripts" / "checkpoint.py"
SMOKE = ROOT / "training" / "scripts" / "train_smoke.py"
STAGE_B = ROOT / "training" / "scripts" / "train_stage_b.py"

# (label, file, find, replace, unittest target that MUST fail, evidence)
#
# The evidence column matters as much as the target. A mutation that trips an
# unrelated crash still exits non-zero, so "the test failed" is not yet "the
# test noticed". Each evidence string is something only the intended check
# could produce — `not raised` for the `assertRaises` tests, the defect's own
# wording for the end-to-end one, the field name for the hyperparameter test.
# An earlier run of this script caught all nine mutations and still warned on
# one of them, because a generic keyword bag cannot tell "failed for the stated
# reason" from "failed near it".
MUTATIONS: list[tuple[str, Path, str, str, str, str]] = [
    (
        "M1 save() no longer re-reads the live optimizer",
        CKPT,
        """        for name in REFRESHABLE_STATE:
            obj = self.live.get(name)
            if obj is not None:
                payload[name] = obj.state_dict()
""",
        "",
        "tests.py.test_train_scripts.ARealRunWritesAResumableCheckpoint."
        "test_the_saved_checkpoint_carries_this_run_s_optimizer_and_schedule",
        "no moments",
    ),
    (
        "M2 save() no longer refuses a stale optimizer",
        CKPT,
        '        assert_state_fresh(payload, f"checkpoint at step {step}")\n',
        "",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_a_checkpoint_at_step_500_with_no_optimizer_moments_is_refused",
        "not raised",
    ),
    (
        "M2b save() no longer refuses a scheduler stuck at last_epoch 0",
        CKPT,
        '        assert_state_fresh(payload, f"checkpoint at step {step}")\n',
        "",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_a_scheduler_stuck_at_last_epoch_zero_is_refused",
        "not raised",
    ),
    (
        "M2c save() no longer refuses a torch optimizer with state dropped",
        CKPT,
        '        assert_state_fresh(payload, f"checkpoint at step {step}")\n',
        "",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_a_torch_optimizer_dict_with_its_state_key_dropped_is_stale",
        "not raised",
    ),
    (
        "M3 load() no longer refuses a stale checkpoint",
        CKPT,
        '        assert_state_fresh(state, path.name)\n',
        "",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_a_stale_checkpoint_written_by_an_older_trainer_is_refused_on_load",
        "not raised",
    ),
    (
        "M4 the grad_accum exemption is removed (over-tightened)",
        CKPT,
        "    if grad_accum is not None and step < grad_accum:\n",
        "    if grad_accum is not None and step < 0:\n",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_no_moments_before_the_first_optimizer_update_is_correct",
        "StaleStateError",
    ),
    (
        "M5 a torch optimizer dict missing `state` is no longer called stale",
        CKPT,
        """    if "param_groups" in opt:
        return True
    return None
""",
        "    return None\n",
        "tests.py.test_checkpoint.StaleStateIsRefused."
        "test_a_torch_optimizer_dict_with_its_state_key_dropped_is_stale",
        "not raised",
    ),
    (
        "M6 the trainer stops handing the manager its live objects",
        SMOKE,
        """    manager = ckpt.CheckpointManager(args.run_dir, keep_last=args.keep_last,
                                     live={"optimizer": optimizer,
                                           "scheduler": scheduler,
                                           "scaler": scaler})
""",
        "    manager = ckpt.CheckpointManager(args.run_dir, keep_last=args.keep_last)\n",
        "tests.py.test_train_scripts.ARealRunWritesAResumableCheckpoint."
        "test_the_saved_checkpoint_carries_this_run_s_optimizer_and_schedule",
        "no moments",
    ),
    (
        "M7 the hyperparameter record stops carrying grad_accum",
        SMOKE,
        '"lr": args.lr, "warmup": args.warmup, "grad_accum": args.grad_accum,\n',
        '"lr": args.lr, "warmup": args.warmup,\n',
        "tests.py.test_checkpoint.HyperparameterRecord."
        "test_the_helper_carries_every_field_the_checks_read",
        "grad_accum",
    ),
    (
        "M8 --init goes back through the resume loader",
        STAGE_B,
        "    state = read_weights(path)\n",
        "    state = ckpt.CheckpointManager(path.parent, "
        "serializer=ckpt._PickleSerializer).load(path.stem)\n",
        "tests.py.test_sft.InitIsNotAResume."
        "test_a_weights_only_file_can_be_initialised_from",
        "is missing ['optimizer'",
    ),
    (
        "M9 read_weights stops falling back to the pickle reader",
        STAGE_B,
        """    if state is None:
        try:
            with path.open("rb") as handle:
                state = pickle.load(handle)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"pickle: {exc.__class__.__name__}")
""",
        "    if state is None:\n        state = None\n",
        "tests.py.test_sft.InitIsNotAResume."
        "test_a_weights_only_file_can_be_initialised_from",
        "could not be read",
    ),
    (
        "M10 read_weights stops insisting the payload is a dict",
        STAGE_B,
        """    if not isinstance(state, dict):
        raise SystemExit(f"--init {path} did not load as a state dict "
                         f"(got {type(state).__name__}).")
    return state
""",
        "    return state\n",
        "tests.py.test_sft.InitIsNotAResume."
        "test_a_payload_that_is_not_a_dict_is_refused",
        "AttributeError",
    ),
]


def run(target: str) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", target, "-v"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=900,
    )
    return proc.returncode, (proc.stdout + proc.stderr)


def main() -> int:
    baseline_code, baseline_out = run("tests.py.test_checkpoint")
    if baseline_code != 0:
        print("baseline test_checkpoint FAILS before any mutation — fix that first")
        print(baseline_out[-2000:])
        return 1
    print(f"baseline test_checkpoint: ok ({baseline_out.count('... ok')} assertions)")

    caught = uncaught = 0
    for label, path, find, replace, target, evidence in MUTATIONS:
        original = path.read_text(encoding="utf-8")
        if find not in original:
            print(f"\nSKIP  {label}\n      pattern not found in {path.name} "
                  f"— the code moved; update the mutation")
            uncaught += 1
            continue
        try:
            path.write_text(original.replace(find, replace, 1), encoding="utf-8",
                            newline="")
            code, out = run(target)
        finally:
            path.write_text(original, encoding="utf-8", newline="")

        if code == 0:
            print(f"\nUNCAUGHT  {label}\n      {target} still passed with the "
                  f"defect reintroduced.\n      This check cannot fail for the "
                  f"reason it claims.")
            uncaught += 1
            continue
        tail = [ln for ln in out.splitlines() if ln.startswith(("FAIL:", "ERROR:"))]
        if evidence in out:
            print(f"\nCAUGHT    {label}\n      target: {target.split('.')[-1]}")
            for line in tail[:2]:
                print(f"      {line}")
            caught += 1
        else:
            # Caught, but by something other than the intended check. Recorded
            # as uncaught: a mutation that trips an unrelated crash has not
            # demonstrated that the guard works.
            print(f"\nWRONG REASON  {label}\n      {target} failed, but the "
                  f"output never says {evidence!r}.\n      It tripped something "
                  f"else; this proves nothing about the guard.")
            for line in tail[:2]:
                print(f"      {line}")
            uncaught += 1

    print(f"\n{'=' * 68}")
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print(f"{'=' * 68}")

    # The tree must be exactly as we found it.
    code, _ = run("tests.py.test_checkpoint")
    if code != 0:
        print("\nRESTORE FAILED — test_checkpoint no longer passes. Check git diff.")
        return 1
    return 1 if uncaught else 0


if __name__ == "__main__":
    raise SystemExit(main())
