# P10 · Ternary (1.58-bit) — the go/no-go (§13)

**Verdict: NO-GO for this iteration.** No ternary code is written, and none is
planned until the conditions at the bottom are met. This file is the P10
deliverable §16 asks for ("written go/no-go"), and it lives under
`experiments/` so that nothing here can reach the shipping path — which §13
requires ("never touching the shipping path").

The baseline is therefore **cleanly separated from ternary by having no ternary**:
there is no experimental branch in the model code, no QAT flag in the trainer,
no second quantizer in the export, and no ternary kernel in the engine. The
separation §18 asks for is trivially satisfied, and it is worth saying plainly
rather than implying an experiment exists.

---

## What §13 asks for

- **Real ternary training**, not post-training rounding: QAT with absmean weight
  scaling to {−1, 0, +1}, a straight-through estimator, 8-bit activations, its
  own LR/warmup schedule; the same data and the same evaluation as the baseline.
- An honest feasibility read, because §13 itself warns that the expected benefit
  at this size is **download size**, and that any *speed* benefit depends on
  dedicated ternary kernels that stock browser runtimes do not provide.

## What the baseline actually is (MEASURED)

Numbers re-taken **2026-10-30** against the artifact that actually ships. This
section used to describe the 4.98M CPU export, which has been retired.

| | Value | Source |
|---|---|---|
| Params | **49,595,328** | `kout-sft7/checkpoints/stage-b/RUN_MANIFEST.json`, printed by `inference/count_parameters.py --gate` |
| Shipping export | **7 shards**, **49,937,152 B** raw q8-row | `ai/model-export/aashish-ai-b/manifest.json` |
| …gzipped | **46,152,126 B** (weights only) | same manifest (`sizes.gzipBytes`) |
| …brotli | 45,951,490 B | same manifest (`brotliMeasured: true`) |
| fp32 equivalent | 198,381,312 B | same manifest |
| Tokenizer | 1,175,852 B (vocab 16,384) | same manifest |
| First visit, everything | **46,410,084 B gz** = **88.5 %** of the 50 MB ceiling (110.7 % of §4's original 40 MB) | `npm run bundle`, 2026-10-30 |
| Quality | **fails §14** — 58.8 % factual against a 95 % gate | `docs/EVALUATION.json` |

## What ternary would and would not buy (ESTIMATED, arithmetic only)

**Size.** 49,595,328 params at ~1.58 bits is ~9.8 MB of packed weights; with
per-group absmean scales the real figure lands near **11–13 MB raw** against
51,146 KB today, i.e. **~38–40 MB saved**. Gzip's leverage on already-near-random
ternary codes is small (it buys ~7 % on q8 today), so the compressed saving is
roughly the same order — call it **~35 MB gz off a 46.3 MB first visit, ≈ 70 %
of the 50 MB first-use ceiling**. That is a different sentence from the one this
file carried when the baseline was 5 MB, and it is the honest one now.

The saving is real, and it is now the largest lever the size budget has. It is
still at the *bottom* of the specification's own priority order: §2 ranks
download/RAM size **below** latency, language handling and useful answers — and
the model that would benefit from it is the one that currently fails §14.
Spending a second full training run on a smaller copy of a model that does not
answer well enough is the wrong order of work.

**Speed.** §13's speed benefit lives in dedicated kernels, and there is no
browser-reachable one to adopt: `bitnet.cpp` is the CPU-native reference
implementation (its win is native code we cannot call), and the browser ports
that do exist — a WebGPU/WGSL runtime for BitNet — are external, early, and
aimed at models two to three orders of magnitude larger than this one.
Re-verified 2026-09-27 (see the links in the spec's §19); the conclusion is
unchanged from the spec's own note. Adopting that path means writing our own
1.58-bit kernels in `ai/engine/llama.mjs`, and their payoff **cannot be measured
on R1**: this box measures scalar JavaScript at **97 M MAC/s** against the
~1–2 G MAC/s an i5-6300U should reach (MEASURED, `docs/BENCHMARKS.md` "Why the
kernel is where it is"). A machine that is 10× slow for reasons of its own
cannot adjudicate a kernel speedup.

## The costs, stated honestly

1. **A second full training run.** QAT is not a post-processing step; the model
   must be trained with the estimator in the loop, on a GPU, competing with the
   data/recipe work that is the actual quality blocker (§14: 58.8 %).
2. **A quality risk that is worst exactly where we are.** §13's own expectation
   is that the size win is what matters at ~40M params, and the literature's
   ternary results are at billions of params and trillions of tokens. At 49.6M
   params the model has little redundancy to spend on a 1.58-bit weight grid; the
   plausible outcome is a measurable quality loss on a checkpoint that is
   already below the bar.
3. **Our export path is quantizer-specific and audited.** `verify:engine` is a
   parity gate against a reference `argmax` and `|Δlogit|`; a new numeric format
   means a new reference, a new parity test and a new engine path — real work
   spent on a direction that is *last* in the priority order.

## Conditions that would re-open this (and the order to do them in)

1. **The baseline must pass its own gates first** — §13's own precondition. The
   GPU Stage A + Stage B pair now exists (49.6M, step 2000), but it **fails**
   §14 (58.8 % factual, 61.5 % abstention recall). So the precondition is still
   unmet, for a different reason than when this file was written.
2. **Download size becomes a constraint** — **met as of 2026-10-30**: the first
   visit is 88.5 % of the 50 MB ceiling, up from 11.5 % of 40 MB when this file
   was written. Condition 2 now argues *for* the experiment; condition 1 still
   argues against it, and §13 orders them.
3. **A browser ternary kernel becomes available off the shelf** — a maintained
   WGSL implementation that we can run through our own parity gate rather than
   write. Until then, speed is not a claim ternary can make here.
4. **Then, and only then**: ternary QAT on the same data and the same evaluation
   as the baseline, exported as a second artifact, compared on answers and
   tokens/second, with `verify:engine` extended to the new format. Go/no-go on
   those numbers, not on the idea.

## What would change the verdict today

One of the two inputs is now present, and it does not flip the verdict. Size
pressure is real (88.5 % of the ceiling) and ternary is the largest lever on it;
the baseline still does not answer well enough to justify spending a training
run shrinking it. The order §13 prescribes is evaluation first, compression
second, and that is the order this file keeps.
