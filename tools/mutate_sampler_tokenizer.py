"""Mutation checks for the sampler's tokenizer guard.

    PYTHONUTF8=1 python tools/mutate_sampler_tokenizer.py

The defect this guards produced fluent-looking nonsense from a working model:
every sampled answer began `brary`, because a 16k-vocab model was fed 1k-token
ids. A guard that warned rather than refused would leave that exact output on
screen with a caveat above it, so the mutations aim at the refusal and at the
resolution rather than at the prose.
"""

from __future__ import annotations

import sys
from pathlib import Path

import mutation_env

ROOT = Path(__file__).resolve().parents[1]
SAMPLER = ROOT / "inference" / "sample_answers.py"
SUITE = "tests.py.test_sample_answers_tokenizer."

MUTATIONS = [
    (
        "S1 the mismatch check stops refusing",
        "    if recorded and recorded != meta.get(\"tokenizer_version\"):",
        "    if False:",
        SUITE + "AMismatchIsRefusedNotWarnedAbout."
        "test_sampling_a_16k_model_with_the_1k_tokenizer_stops",
        "SystemExit not raised",
    ),
    (
        "S2 the resolution falls back to the largest artifact instead of the match",
        "        return found[wanted.pop()] if len(wanted) == 1 else found[sorted(wanted)[0]]",
        "        return candidates[-1] if candidates else None",
        SUITE + "TheTokenizerComesFromTheCheckpoint."
        "test_it_reads_the_generation_out_of_the_run_manifest",
        "Error",
    ),
    (
        "S3 a generation with no artifact on disk is silently accepted",
        "        if missing:",
        "        if False:",
        SUITE + "TheTokenizerComesFromTheCheckpoint."
        "test_a_generation_with_no_artifact_on_disk_is_refused",
        # Not "SystemExit not raised": with the guard removed the resolver
        # reaches `found[wanted.pop()]` and dies with a bare KeyError naming the
        # generation. Still a caught regression, just an ungraceful one - and
        # saying so is the point of keying on a real phrase rather than a
        # hopeful one.
        "KeyError",
    ),
    (
        "S4 the sampler hardcodes the dev fixture again",
        "    tokenizer_dir = args.tokenizer or resolve_tokenizer(args.checkpoint)",
        "    tokenizer_dir = args.tokenizer or (ROOT / \"ai\" / \"tokenizer\" / \"artifacts\" / \"seed-1k\")",
        SUITE + "AMismatchIsRefusedNotWarnedAbout."
        "test_the_sampler_no_longer_hardcodes_the_dev_fixture",
        # Read from the assertion's own message, which is why this string has to
        # be re-read whenever that message changes - it did once already, and
        # the mutation was reported NOT CAUGHT while exiting 1.
        "resolves its tokenizer from the checkpoint",
    ),
    (
        "S5 the check stops comparing the two generations",
        "    recorded = json.loads(manifest.read_text(encoding=\"utf-8\")).get(\n        \"tokenizer_version\")\n    if recorded and recorded != meta.get(\"tokenizer_version\"):",
        "    recorded = None\n    if recorded and recorded != meta.get(\"tokenizer_version\"):",
        SUITE + "AMismatchIsRefusedNotWarnedAbout."
        "test_sampling_a_16k_model_with_the_1k_tokenizer_stops",
        "SystemExit not raised",
    ),
]


def main() -> int:
    original = SAMPLER.read_text(encoding="utf-8")
    mutation_env.clear_bytecode_caches()
    caught = uncaught = 0
    print(f"{len(MUTATIONS)} mutations against the sampler's tokenizer guard")
    print("=" * 70)
    try:
        for label, find, replace, test, phrase in MUTATIONS:
            if find not in original:
                print(f"\nSKIP  {label}\n      anchor moved; update the mutation")
                uncaught += 1
                continue
            SAMPLER.write_text(original.replace(find, replace, 1),
                               encoding="utf-8", newline="")
            code, combined = mutation_env.run_test(test)
            SAMPLER.write_text(original, encoding="utf-8", newline="")
            name = test.rsplit(".", 1)[-1]
            if code != 0 and name in combined and phrase in combined:
                print(f"\nCAUGHT    {label}\n      target: {name}")
                caught += 1
            else:
                print(f"\nNOT CAUGHT  {label}\n      target: {name} (exit {code}, "
                      f"phrase {phrase!r} "
                      f"{'present' if phrase in combined else 'absent'})")
                uncaught += 1
    finally:
        SAMPLER.write_text(original, encoding="utf-8", newline="")

    print("\n" + "=" * 70)
    print(f"  {caught}/{len(MUTATIONS)} mutations caught for the right reason, "
          f"{uncaught} not")
    print("=" * 70)
    return 0 if uncaught == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())