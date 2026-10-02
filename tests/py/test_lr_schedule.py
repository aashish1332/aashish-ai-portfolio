"""tests/py/test_lr_schedule.py — the learning rate must actually anneal.

Measured 2026-10-02, by replaying the trainer's own stepping rule against the
shipped numbers:

| run | `--grad-accum` | LR multiplier at the end |
|---|---|---|
| smoke, 50 steps | 1 | **0.002** — as intended |
| Stage A, 20000 steps | 8 | **0.967** — barely moved |

`cosine_with_warmup` builds a cosine over `total`, and the trainer calls
`scheduler.step()` inside the `if (step + 1) % args.grad_accum == 0:` branch —
once per *optimizer update*. But `--steps` counts micro-steps, so the schedule
was constructed `grad_accum` times too long and never reached its decay. Stage A
spent a whole run finishing at 96.7 % of peak learning rate, which is the regime
that produces the worst final loss, and its warmup was eight times too long.

The smoke test could not see any of it. At `grad_accum=1` the two units coincide
and the bug requires them to differ — the third defect in that one Kaggle run
that the smoke test was structurally unable to detect, after the batch that did
not fit and the budget taken from a 4.8M-parameter model.

So these tests assert the property that was silently absent: **a run that
completes its step budget ends near zero learning rate**, at every `grad_accum`
the project actually uses.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from training.scripts.train_smoke import schedule_span  # noqa: E402


def factor(step: int, warmup: int, total: int) -> float:
    """`cosine_with_warmup`'s own curve, copied so this test does not depend on
    torch being installed to check arithmetic about it."""
    if step < warmup:
        return (step + 1) / max(1, warmup)
    progress = (step - warmup) / max(1, total - warmup)
    return 0.5 * (1 + math.cos(math.pi * min(1.0, progress)))


def final_multiplier(steps: int, grad_accum: int, warmup: int) -> float:
    """The LR the last optimizer update actually runs at."""
    warmup_updates, total_updates = schedule_span(steps, warmup, grad_accum)
    updates = max(1, steps // max(1, grad_accum))
    return factor(updates - 1, warmup_updates, total_updates)


class AnnealsToZero(unittest.TestCase):
    def test_the_shipped_stage_a_settings_end_near_zero(self):
        # Stage A: --steps 20000 --grad-accum 8 --warmup 200
        value = final_multiplier(20000, 8, 200)
        self.assertLess(value, 0.01,
                        f"Stage A ends at {value:.3f} of peak learning rate. The "
                        f"scheduler advances once per optimizer update while "
                        f"--steps counts micro-steps; at grad-accum 8 that makes "
                        f"the cosine 8x too long.")

    def test_the_shipped_stage_b_settings_end_near_zero(self):
        # Stage B: --steps 3000 --grad-accum 2 --warmup 100
        value = final_multiplier(3000, 2, 100)
        self.assertLess(value, 0.01, f"Stage B ends at {value:.3f}")

    def test_every_accumulation_the_project_uses_anneals(self):
        for accum in (1, 2, 4, 8):
            with self.subTest(grad_accum=accum):
                value = final_multiplier(20000, accum, 200)
                self.assertLess(value, 0.01,
                                f"grad-accum {accum} ends at {value:.3f}")

    def test_the_smoke_case_is_unchanged(self):
        """grad_accum=1 already worked, and the fix must not move it."""
        self.assertAlmostEqual(final_multiplier(50, 1, 10), 0.0015, places=3)


class SpanIsInUpdates(unittest.TestCase):
    def test_the_span_is_the_optimizer_update_count(self):
        warmup, total = schedule_span(20000, 200, 8)
        self.assertEqual(total, 2500, "20000 micro-steps at accum 8 is 2500 updates")
        self.assertEqual(warmup, 25, "a 200-micro-step warmup is 25 updates")

    def test_accum_one_is_a_passthrough(self):
        self.assertEqual(schedule_span(50, 10, 1), (10, 50))

    def test_a_warmup_longer_than_the_run_cannot_pin_the_lr(self):
        """If warmup >= total the cosine branch is never reached and the LR holds
        at peak for the whole run — the same defect wearing a different hat."""
        warmup, total = schedule_span(100, 500, 1)
        self.assertLess(warmup, total,
                        "a warmup that swallows the run leaves the schedule with "
                        "no decay section at all")

    def test_a_run_shorter_than_one_update_still_has_a_span(self):
        warmup, total = schedule_span(4, 200, 8)
        self.assertGreaterEqual(total, 1)
        self.assertGreaterEqual(warmup, 0)
        self.assertLess(warmup, total)

    def test_zero_or_negative_accumulation_cannot_divide_by_zero(self):
        for accum in (0, -1):
            with self.subTest(grad_accum=accum):
                warmup, total = schedule_span(100, 10, accum)
                self.assertGreaterEqual(total, 1)
                self.assertGreaterEqual(warmup, 0)


class BothTrainersUseIt(unittest.TestCase):
    """A fix in one trainer that the other does not get is not a fix.

    Stage B was the more affected of the two: it runs `--grad-accum 2` and
    finished at 0.999 of peak.
    """

    def test_neither_trainer_passes_micro_steps_to_the_schedule(self):
        offenders = []
        for name in ("train_smoke.py", "train_stage_b.py"):
            path = ROOT / "training" / "scripts" / name
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                # Call sites only: the `def` line names the same function and
                # is not a violation.
                if stripped.startswith("def "):
                    continue
                if ("cosine_with_warmup(optimizer" in stripped
                        and "schedule_span" not in stripped):
                    offenders.append(f"{name}: {stripped}")
        self.assertEqual(offenders, [],
                         "these build the schedule straight from micro-step counts, "
                         "so the LR never anneals:\n  " + "\n  ".join(offenders))


if __name__ == "__main__":
    unittest.main()
