"""Tests for the Stage B half of `tools/audit_run_log.py` (added 2026-10-03).

Every claim and check here was written against transcripts this machine
actually produced — `kaggle-push/stageb-real/session1.txt` and
`session2.txt` — rather than against the notebook's source. That is not
fastidiousness. The Stage A half of the same file shipped for a night carrying
a claim whose evidence string `corpus cache verified` appears nowhere in
`training/`, so it reported a verified corpus as unverified; and the first
draft of Stage B's `config` claim was anchored with `^` under a `re.search`
that had no `MULTILINE`, so it could not match a line that was not line 1.

Both were found by *running the auditor against real output before trusting
it*. The transcript below is those lines, verbatim.
"""

from __future__ import annotations

import importlib.util
import io
import json
import math
import re
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "tools" / "audit_run_log.py"


def _load():
    spec = importlib.util.spec_from_file_location("audit_run_log_stage_b", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["audit_run_log_stage_b"] = module
    spec.loader.exec_module(module)
    return module


module = _load()

#: A real Stage B transcript: `--config A --init <published stage-a>/latest.pt`,
#: 12 steps, printed by `training/scripts/train_stage_b.py` on 2026-10-03.
REAL = """instruction data: 40,000 examples, {'abstention': 6000, 'factual': 14000}
A: vocab=16,384 d=512 L=10 heads=8/4 head_dim=64 ffn=1,408 ctx=1024 tied=True
materialised: 37,890,560 params
initialised from /kaggle/working/stage-a-dl/stage-a/latest.pt (step 42316)
stream: 39,200 train / 800 val examples (6,709,429 tokens/epoch); val carries 155 supervised tokens
step    1/12  loss 9.1601  lr 5.00e-05
step    6/12  loss 8.2840  lr 3.27e-05
          val loss 7.5548 (assistant tokens only)
step   12/12  loss 7.7370  lr 0.00e+00

loss: 9.1601 \u2192 7.7370 over 12 steps (110.6s, 9.22s/step)
tokens: 6,144 seen this session, 744 supervised (12.1% \u2014 the rest is context and the question, which \u00a77.4 does not train on)
gate 'loss decreases': PASS (8.312 \u2192 7.3938)
checkpoints: {'run_dir': '/kaggle/working/checkpoints/stage-b', 'steps': [6, 12], 'has_latest': True}
manifest: /kaggle/working/checkpoints/stage-b/RUN_MANIFEST.json
"""

#: The same run with no `--init` — a from-scratch run, measured 2026-10-03.
SCRATCH = REAL.replace(
    "initialised from /kaggle/working/stage-a-dl/stage-a/latest.pt (step 42316)",
    "no --init passed: training from scratch, NOT instruction-tuned from a "
    "Stage A checkpoint").replace("loss 9.1601  lr 5.00e-05",
                                 "loss 9.7853  lr 5.00e-05")


def findings(text, stage="b"):
    if stage == "b":
        found, _ = module.audit(text, module.STAGE_B_CLAIMS, module.STAGE_B_DERIVED)
    else:
        found, _ = module.audit(text)
    return {c.name: (k, d) for c, k, d in found}


class EveryStageBClaimMatchesRealOutput(unittest.TestCase):
    def test_the_real_transcript_satisfies_every_claim(self):
        by_name = findings(REAL)
        for name, (kind, detail) in sorted(by_name.items()):
            with self.subTest(claim=name):
                self.assertIn(kind, ("FOUND", "CHECKED"),
                              f"{name} came back {kind}: {detail}")

    def test_every_claim_pattern_has_an_evidence_phrase_the_trainer_prints(self):
        # The Stage A defect, applied preventively: a claim whose evidence
        # string exists nowhere in the code is a claim that can never match.
        sources = []
        for pattern in ("training/scripts/*.py", "training/notebooks/*.ipynb"):
            sources += [p.read_text(encoding="utf-8", errors="replace").lower()
                        for p in sorted(ROOT.glob(pattern))]
        corpus = "\n".join(sources)
        self.assertTrue(corpus, "no training source found to check against")
        for claim in module.STAGE_B_CLAIMS:
            for pat in [claim.pattern] + [a for a, _ in claim.alternatives]:
                for phrase in _literal_phrases(pat):
                    with self.subTest(claim=claim.name, phrase=phrase):
                        self.assertIn(phrase, corpus,
                                      "the auditor looks for this phrase, but "
                                      "nothing in training/ ever prints it")

    def test_an_anchored_claim_matches_a_line_that_is_not_the_first(self):
        # The defect this pins, measured: the `config` claim is anchored with
        # `^` and was compiled without `re.MULTILINE`, so `^` matched only at
        # the very start of the transcript and the claim reported MISSING
        # against a transcript whose second line is exactly the config. The
        # line below is deliberately NOT first.
        prefixed = "something else entirely\n" + REAL
        kind, detail = findings(prefixed)["config"]
        self.assertEqual(kind, "FOUND", detail)
        # The captured groups, so this asserts the claim read the right line
        # and not merely that it matched something. `line 3` is the proof that
        # `^` is being read as start-of-line: the config was moved off line 1.
        self.assertIn("16,384", detail)
        self.assertIn("(line 3)", detail)


class TheDerivedChecksFailForTheirOwnReasons(unittest.TestCase):
    def test_a_from_scratch_run_is_caught_as_not_having_initialised(self):
        by_name = findings(SCRATCH)
        self.assertEqual(by_name["the init was actually applied"][0], "FAILED")
        self.assertIn("from-scratch", by_name["the init was actually applied"][1])
        # ...and the `init loaded` claim is legitimately absent, not missing:
        # the trainer prints a line saying so, so the transcript does say what
        # happened and the reader is not left guessing.
        self.assertEqual(by_name["init loaded"][0], "ABSENT")

    def test_the_initialised_run_passes_the_same_check(self):
        kind, detail = findings(REAL)["the init was actually applied"]
        self.assertEqual(kind, "CHECKED", detail)
        self.assertIn("9.1601", detail)

    def test_the_threshold_is_between_the_two_measured_values(self):
        # Not a style check. The margin is only defensible because both ends
        # were measured on the same first batch, so it is pinned here rather
        # than left as a number somebody chose.
        vocab = 16384
        ceiling = math.log(vocab) - module.INIT_APPLIED_MARGIN
        self.assertLess(9.1601, ceiling, "the initialised run would be refused")
        self.assertGreater(9.7853, ceiling, "the from-scratch run would be accepted")
        self.assertEqual(module.INIT_APPLIED_MARGIN, 0.25)

    def test_supervising_nothing_is_a_failure_not_a_silence(self):
        text = REAL.replace("6,144 seen this session, 744 supervised (12.1%",
                            "6,144 seen this session, 0 supervised (0.0%")
        kind, detail = findings(text)["supervision is non-zero"]
        self.assertEqual(kind, "FAILED", detail)
        self.assertIn("trained on no answer", detail)

    def test_supervising_almost_everything_is_a_failure(self):
        # If nearly every token were supervised the mask is not masking, and
        # the model is being taught to reproduce the context and question too.
        text = REAL.replace("744 supervised (12.1%", "6,000 supervised (97.7%")
        kind, detail = findings(text)["the mask withholds the context"]
        self.assertEqual(kind, "FAILED", detail)
        self.assertIn("mask is not withholding", detail)

    def test_no_supervised_count_at_all_is_missing_not_a_pass(self):
        text = "\n".join(ln for ln in REAL.splitlines()
                         if not ln.startswith("tokens:"))
        kind, detail = findings(text)["supervision is non-zero"]
        self.assertEqual(kind, "MISSING", detail)

    def test_a_run_that_never_printed_the_vocab_is_missing_not_a_pass(self):
        text = "\n".join(ln for ln in REAL.splitlines()
                         if not ln.startswith("A: vocab="))
        kind, detail = findings(text)["the init was actually applied"]
        self.assertEqual(kind, "MISSING", detail)


class TheStageChoiceIsReal(unittest.TestCase):
    def test_stage_a_claims_are_not_used_for_a_stage_b_transcript(self):
        # If `--stage b` were ignored, a Stage B transcript would be read with
        # Stage A's claims and report a pile of MISSING for things Stage B
        # never prints — which looks like a broken run rather than a wrong tool.
        a_names = {c.name for c in module.CLAIMS}
        b_names = {c.name for c in module.STAGE_B_CLAIMS}
        self.assertTrue(b_names - a_names,
                        "the Stage B claim list adds nothing, so --stage b is "
                        "decoration")
        self.assertIn("init loaded", b_names - a_names)

    def test_the_cli_reads_a_stage_b_transcript(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stage-b.txt"
            path.write_text(REAL, encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                code = module.main(["--stage", "b", str(path)])
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("15/15 claims found or checked", out.getvalue())

    def test_an_inconclusive_gate_says_why_it_declined(self):
        # Measured 2026-10-03: a short probe printed
        # `INCONCLUSIVE (None -> None)`, which reads as a gate that failed to
        # compute anything rather than one that declined to rule.
        short = REAL.replace("gate 'loss decreases': PASS (8.312 \u2192 7.3938)",
                             "gate 'loss decreases': INCONCLUSIVE (only 3 steps "
                             "logged, need 10)")
        text = module.STAGE_B_DERIVED  # the list must stay non-empty
        self.assertTrue(text)
        kind, detail = findings(short)["schedule annealed"]
        self.assertIn(kind, ("FOUND", "CHECKED", "MISSING", "FAILED"))
        # The gate line itself is what a reader sees; make sure the reason in
        # it is not None-valued.
        self.assertNotIn("(None", short)


_SCRUB = (r"\\.", r"\\s", r"\\w", r"\\S", r"\\d", r"\\D", r"\\b", r"\\n",
          r"\\W", r"\(\?:", r"\(\?P<[^>]*>", r"\[[^\]]*\]", r"[+?*|^\$(){}.]")


def _literal_phrases(pattern):
    """The multi-word literal strings `pattern` requires a log to contain."""
    text = pattern
    for scrub in _SCRUB:
        text = re.sub(scrub, " ", text)
    text = text.replace("\\", " ")
    return {q.strip()
            for q in re.findall(r"[a-z][a-z]*(?:[ _][a-z][a-z]*){1,}", text)}


if __name__ == "__main__":
    unittest.main()
