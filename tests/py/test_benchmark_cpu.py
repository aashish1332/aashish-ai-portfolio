"""tests/py/test_benchmark_cpu.py — the §14 CPU benchmark harness.

A benchmark is code that produces evidence, so the tests here are about the
harness rather than the model: that it reports what it actually measured,
that a number it could not measure is `None` instead of a fake, and that the
numbers it does report are internally consistent (tokens / seconds really is
the rate it printed).

Everything here skips with a reason when torch is absent — the same rule the
rest of the suite follows, so a green run never implies a loop that ran.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.model.config import CONFIG_SMOKE  # noqa: E402

try:
    import torch  # noqa: F401
    HAVE_TORCH = True
except ImportError:  # pragma: no cover - environment dependent
    HAVE_TORCH = False

if HAVE_TORCH:
    from inference.benchmark import benchmark_cpu as bench  # noqa: E402


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class Rss(unittest.TestCase):
    def test_rss_is_a_real_number_or_none_never_a_guess(self):
        value = bench.rss_bytes()
        self.assertTrue(value is None or value > 1_000_000,
                        f"{value} is neither a plausible RSS nor None")


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class Measurement(unittest.TestCase):
    def _run(self):
        return bench.benchmark(CONFIG_SMOKE, tokens=4, prompt_tokens=8,
                               warmup=0, threads=2, baseline_rss=None)

    def test_reports_every_number_the_spec_asks_for(self):
        r = self._run()
        for key in ("load_seconds", "prefill_tokens_per_second",
                    "decode_tokens_per_second", "generation_seconds",
                    "state_dict_fp32_bytes", "state_dict_fp16_bytes",
                    "kv_cache_bytes_per_token"):
            self.assertIn(key, r)

    @staticmethod
    def _rate_bounds(tokens: int, seconds: float) -> tuple[float, float]:
        """Where `tokens / seconds` may legitimately land, from the roundings.

        The report computes the rate from the *unrounded* wall time and then
        stores the time rounded to 4 dp and the rate to 1 dp, so the two
        numbers cannot agree more closely than the rounding of `seconds`
        allows: at ~1200 tok/s, 5e-5 s is worth ±9 tok/s. A fixed ±2 delta
        therefore failed on a fast machine for no reason and passed on a slow
        one for every reason — this derives the interval instead, so the
        assertion stays strict about what it is actually testing (a wrong
        token count or divisor is out by orders, not by 1).
        """
        half = 5e-5  # round(seconds, 4)
        low = tokens / (seconds + half)
        high = tokens / (seconds - half) if seconds > half else float("inf")
        return low - 0.05, high + 0.05  # plus round(rate, 1)

    def test_the_rates_are_consistent_with_the_times(self):
        r = self._run()
        for tokens, seconds, rate in (
                (4, r["decode_seconds"], r["decode_tokens_per_second"]),
                (8, r["prefill_seconds"], r["prefill_tokens_per_second"])):
            low, high = self._rate_bounds(tokens, seconds)
            self.assertTrue(low <= rate <= high,
                            f"{rate} tok/s sits outside [{low:.1f}, {high:.1f}], "
                            f"which is everything the 4-dp rounding of {seconds} s "
                            f"permits — the token count or the divisor is wrong")

    def test_the_weights_are_labelled_as_random(self):
        """No checkpoint exists. A speed number without that label reads as a
        trained-model number, which is the one thing this must not imply."""
        self.assertIn("RANDOM", self._run()["weights"])

    def test_sizes_are_written_not_computed(self):
        r = self._run()
        self.assertGreater(r["state_dict_fp32_bytes"], r["state_dict_fp16_bytes"])
        # fp16 is about half fp32, plus container overhead
        ratio = r["state_dict_fp16_bytes"] / r["state_dict_fp32_bytes"]
        self.assertGreater(ratio, 0.5)
        self.assertLess(ratio, 0.62)

    def test_a_missing_baseline_is_none_not_a_negative_delta(self):
        r = self._run()
        self.assertIsNone(r["load_rss_delta_bytes"])
        self.assertIn("RSS after build()", r["load_rss_method"])

    def test_the_parameter_count_matches_the_plan(self):
        from ai.model import plan
        self.assertEqual(self._run()["params"],
                         plan.counts(CONFIG_SMOKE)["total"])


@unittest.skipUnless(HAVE_TORCH, "torch is not installed")
class Cli(unittest.TestCase):
    def test_json_output_is_written_and_self_describing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "cpu.json"
            rc = bench.main(["--config", "smoke", "--tokens", "2",
                             "--prompt-tokens", "8", "--warmup", "0",
                             "--threads", "2", "--json", str(out)])
            self.assertEqual(rc, 0)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertIn("RANDOM", payload["results"][0]["weights"])
            self.assertIn("method", payload)


if __name__ == "__main__":
    unittest.main()
