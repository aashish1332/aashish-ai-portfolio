"""Read a Stage A session's transcript and report what it actually establishes.

    PYTHONUTF8=1 python tools/audit_run_log.py kaggle-push/out/kaggle-...v3.txt

Why this exists: the previous run's log was read by eye, filed, and a defect in
its checkpoint went unnoticed — because the reading was of the *prose* the run
printed, and prose does not have to add up. This reads the same transcript
against an explicit list of claims, so "I saw the numbers" becomes "these seven
claims are present, these two are not, and here is the text that says so".

The distinction the whole tool rests on:

* **FOUND** — the claim's evidence is in the log, quoted.
* **ABSENT** — the log explicitly records the *other* legitimate outcome (e.g.
  no corpus cache was attached and the session rebuilt it). Not a failure, but
  it changes what the timings mean, so it is reported as a warning.
* **MISSING** — neither. This is deliberately treated as a failure even though
  it might mean "nothing went wrong", because the only two ways to produce it
  are a claim that did not happen or a search that is looking in the wrong
  place. A run whose log cannot be *checked* is not a run that passed; a silent
  MISSING is how a guard becomes decorative.

Exit code is 1 if anything is MISSING, so this can gate a publish step rather
than be a report someone has to remember to read.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Claim:
    """One thing a finished Stage A session is supposed to have established."""

    name: str
    pattern: str
    why: str
    group: str = "value"
    #: Other legitimate outcomes, each (pattern, description). Matching one of
    #: these is reported as ABSENT-with-reason rather than MISSING, because the
    #: log *does* say what happened.
    alternatives: tuple[tuple[str, str], ...] = ()


CLAIMS: list[Claim] = [
    Claim("device", r"torch\s+(\S+)\s+\|\s+cuda\s+(\w+)",
          "records the torch build and whether a GPU was actually present — a "
          "CPU session would train the same steps at a fraction of the rate"),
    Claim("cache located", r"corpus cache found at (/\S+)",
          "the cache was searched for and found on the mount",
          alternatives=(
              (r"no corpus cache attached[^\n]*",
               "NO CACHE was attached, so the session rebuilt the corpus from "
               "scratch. Legitimate, but the data phase is inside the wall "
               "clock instead of skipped, so the training window is shorter."),
              (r"found a CACHE\.json but did not use it: (\S+)",
               "a cache was on the mount but was rejected — the session rebuilt "
               "the corpus anyway. This is a real problem, not a shorter run."),
          )),
    Claim("cache installed", r"corpus cache installed[^\n]*",
          "the fetched sources were replaced by the cached shards, which is "
          "what makes the 47-minute data pass skippable",
          alternatives=(
              (r"no corpus cache attached[^\n]*",
               "no cache, so nothing was installed (consistent with the above)"),
          )),
    Claim("tokenizer", r"frozen tokenizer_version:\s*(\S+)\s*\|\s*vocab\s*(\d+)",
          "pins the tokenizer the shards were built with; a mismatch here "
          "invalidates every token count below"),
    Claim("smoke", r"smoke run: config (\w+).*?params\s+([\d,]+)",
          "config A materialised and ran before any long work was committed"),
    # Two components print the word "throughput", and a regex over the whole
    # transcript cannot tell them apart by the word alone. What separates them
    # is the *colon*: the probe pads with spaces and no colon
    # (`throughput        12,471 tokens/s`), while the trainer's summary uses
    # `throughput: 12,471 tokens/s`.
    #
    # The comment here used to claim that `\s+` matched the trainer's line too,
    # which was the stated reason for tightening to `\s{2,}`. Mutation testing
    # falsified it: `throughput\s+` does not match `throughput: ...`, because a
    # colon is not whitespace, so the tightening was never load-bearing and the
    # story justifying it was wrong. What is load-bearing is refusing to accept
    # the colon. A pattern like `throughput[:\s]+` would let the trainer's own
    # summary satisfy the probe's claim — and that is the mutation pinned in
    # `tools/mutate_audit.py`, not a change in the number of spaces.
    Claim("probe throughput", r"throughput\s{2,}([\d,]+) tokens/s",
          "this config's own measured rate - the only input the budget may use"),
    Claim("probe memory", r"peak memory\s+allocated\s+([\d.]+ (?:GiB|MiB))",
          "whether the config fits at this micro-batch, and with how much room"),
    Claim("probe fits", r"fits\s+yes[^\n]*",
          "the probe's explicit verdict; absence means it did not fit or did "
          "not run",
          alternatives=(
              (r"DOES NOT FIT\s+([^\n]*)",
               "the probe says the config does NOT fit — expecting an OOM"),
              (r"no steps completed[^\n]*",
               "the probe completed no steps, so nothing was measured"),
          )),
    Claim("budget", r"config (\w+)\s*—\s*([\d,]+) params",
          "the budget was computed for the config being trained"),
    Claim("STEPS", r"STEPS = ([\d,]+) micro-steps = ([\d.]+)B tokens",
          "the step count came from the measurement above, not from a "
          "hard-coded number that ignores this card's speed"),
    Claim("run reached its step bound", r"loss: [\d.]+ → [\d.]+ over ([\d,]+) steps",
          "the training loop finished and reported a full loss series"),
    Claim("params", r"parameters:\s*([\d,]+) \(([\d.]+)M\)",
          "the trained model's size, to check it is config A"),
    Claim("state keys", r"materialised:\s*([\d,]+) params,\s*(\d+) state-dict keys",
          "the state dict really holds the parameter count reported"),
    Claim("throughput at the end", r"throughput:\s*([\d,]+) tokens/s",
          "the rate actually achieved over the whole run, by the trainer's own "
          "summary line (colon form, unlike the probe's) "),
    Claim("gate", r"gate 'loss decreases': (\w+)",
          "the run's own verdict on whether loss decreased",
          alternatives=(
              (r"gate (\w+) \(([\d.]+) -> ([\d.]+), delta ([\d.-]+)\)",
               "the notebook re-printed the gate from the manifest"),
          )),
    Claim("manifest written", r"manifest:\s*(\S+)",
          "the run manifest exists, which is what the notebook's summary cell "
          "reads for its step/loss/token counts"),
    Claim("checkpoints saved", r"checkpoints:\s*([^\n]*)",
          "the checkpoint summary, including which files exist"),
    Claim("cache verified", r"corpus cache verified[^\n]*|content sha ([\w]+)",
          "the shards were re-hashed against the manifest; without it the "
          "cached corpus is assumed-good",
          alternatives=(
              (r"no corpus cache attached[^\n]*",
               "no cache was used, so there was nothing to verify"),
          )),
    Claim("sample generation", r"<\|user\|>[^\n]*<\|asst\|>",
          "the trained model produced output rather than only numbers"),
]

#: Lines worth surfacing to a human regardless of the claim list above.
ALARMS = [
    (r"Traceback \(most recent call last\)", "a Python traceback is in the log"),
    (r"OutOfMemoryError", "the run hit an OOM"),
    (r"CUDA out of memory", "the run hit an OOM"),
    (r"stopping at step \d+: --max-minutes [\d.]+ reached",
     "the run stopped on the WALL CLOCK, not the step bound — the cosine did "
     "not complete, so the learning rate did not anneal"),
    (r"no steps completed", "the probe measured nothing"),
    (r"\bNaN\b", "a NaN appears — check whether the loss diverged"),
    (r"gave up|giving up", "a component gave up"),
    (r"WARNING|UserWarning", "a warning was emitted"),
]


def load_text(path: Path) -> str:
    """Accept a decoded transcript or a raw JSON stream, and say which it was."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix == ".log" or raw.lstrip().startswith(("[", "{")):
        try:
            records = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        if isinstance(records, list):
            return "\n".join(r.get("data") or "" for r in records
                             if isinstance(r, dict))
    return raw


def _line_of(text: str, offset: int) -> int:
    """1-based line number of a character offset, so FOUND can be checked by eye."""
    return text.count("\n", 0, offset) + 1


def audit(text: str) -> tuple[list[tuple[Claim, str, str]], list[str]]:
    """Return (per-claim findings, alarm lines). Findings are (claim, kind, detail)."""
    findings = []
    for claim in CLAIMS:
        match = re.search(claim.pattern, text, re.IGNORECASE)
        if match:
            detail = " | ".join(g for g in match.groups() if g) or match.group(0)
            detail = f"{detail.strip()[:150]}  (line {_line_of(text, match.start())})"
            findings.append((claim, "FOUND", detail))
            continue
        for alt_pattern, explanation in claim.alternatives:
            alt = re.search(alt_pattern, text, re.IGNORECASE)
            if alt:
                findings.append(
                    (claim, "ABSENT",
                     f"{explanation}  (line {_line_of(text, alt.start())}, "
                     f"matched /{alt_pattern}/)"))
                break
        else:
            findings.append((claim, "MISSING",
                             f"no line matching /{claim.pattern}/ and no "
                             f"recorded alternative outcome"))
    alarms = [note for pattern, note in ALARMS
              if re.search(pattern, text, re.IGNORECASE)]
    return findings, alarms


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("transcript", type=Path,
                    help="decoded .txt transcript, or the raw .log")
    ap.add_argument("--quiet", action="store_true",
                    help="print only the counts and anything not FOUND")
    args = ap.parse_args(argv)

    if not args.transcript.is_file():
        print(f"no such file: {args.transcript}", file=sys.stderr)
        return 2

    text = load_text(args.transcript)
    findings, alarms = audit(text)

    found = sum(1 for _, kind, _ in findings if kind == "FOUND")
    absent = sum(1 for _, kind, _ in findings if kind == "ABSENT")
    missing = [f for f in findings if f[1] == "MISSING"]

    print(f"=== {args.transcript} ({len(text):,} chars, "
          f"{text.count(chr(10)) + 1:,} lines) ===")
    for claim, kind, detail in findings:
        if args.quiet and kind == "FOUND":
            continue
        mark = {"FOUND": "OK     ", "ABSENT": "ABSENT ", "MISSING": "MISSING"}[kind]
        print(f"\n{mark} {claim.name}")
        print(f"        {claim.why}")
        print(f"        -> {detail}")

    print(f"\n{found}/{len(CLAIMS)} claims found, {absent} legitimately absent, "
          f"{len(missing)} missing")

    if alarms:
        print("\nalarms:")
        for note in alarms:
            print(f"  ! {note}")

    if missing:
        print("\nMISSING is a failure, not a silence: the run either did not do "
              "this or the search cannot see it. Fix one or the other before "
              "treating this session as read.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
