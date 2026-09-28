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

| | Value | Source |
|---|---|---|
| Params | **4,984,064** | `ai/model/config.py` (`CONFIG_LOCAL`), printed by `inference/count_parameters.py --gate` |
| Shipping export | 1 shard, **5,059,584 B** raw q8-row | `ai/model-export/aashish-ai-1/manifest.json` |
| …gzipped | **4,732,964 B** | same manifest (`sizes.gzipBytes`) |
| …brotli | 4,713,956 B | same manifest (`brotliMeasured: true`) |
| fp32 equivalent | 19,936,256 B | same manifest |
| Tokenizer | 66,667 B | same manifest |
| First visit, everything | **4,815,416 B gz** = 11.5 % of §4's 40 MB | `docs/AI_ARCHITECTURE.md` (recomputed 2026-09-28) |
| Quality | **untrained for quality** — see `docs/FINAL_REPORT.md` | R1 CPU pipeline run, 800 steps |

## What ternary would and would not buy (ESTIMATED, arithmetic only)

**Size.** 4,984,064 params at ~1.58 bits is ~984 KB of packed weights; with
per-group absmean scales the real figure lands near **1.2–1.4 MB raw** against
5,060 KB today, i.e. **3.6–3.9 MB saved**. Gzip's leverage on already-near-random
ternary codes is small (it only buys ~6 % on q8 today), so thecompressed saving is roughly the same order — call it **~3 MB gz off a 4.82 MB first visit, ≈ 6 %
of the §4 first-use budget of 40 MB**.

That saving is real and it is at the *bottom* of the specification's own
priority order: §2 ranks download/RAM size **below** latency, language handling
and useful answers. Nothing in the budgets is currently under pressure —
4.82 MB of a 40 MB allowance is not a reason to open a research direction.

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
   must be trained with the estimator in the loop. On R1 that is a CPU run of
   tens of hours for the local config, and for the shipping config A (~37.9M
   params) it is a GPU job — the same owner-side GPU that Stage A and Stage B
   are already waiting on. It would compete with the two runs that actually
   decide whether the assistant is any good.
2. **A quality risk that is worst exactly where we are.** §13's own expectation
   is that the size win is what matters at ~40M params, and the literature's
   ternary results are at billions of params and trillions of tokens. At 5M
   params the model has no redundancy to spend on a 1.58-bit weight grid; the
   plausible outcome is a measurable quality loss for ~3 MB.
3. **Our export path is quantizer-specific and audited.** `verify:engine` is a
   parity gate against a reference `argmax` and `|Δlogit|`; a new numeric format
   means a new reference, a new parity test and a new engine path — real work
   spent on a direction that is *last* in the priority order.

## Conditions that would re-open this (and the order to do them in)

1. **The baseline must pass its own gates first** — §13's own precondition. That
   means a trained-for-quality checkpoint at config A with the §14 evaluation
   results behind it, and Stage A + Stage B done. Neither exists yet.
2. **Download size becomes a constraint** — if the first-use total ever
   approaches §4's budget (measured today at 11.5 % of it), ternary moves from
   "interesting" to "the obvious lever".
3. **A browser ternary kernel becomes available off the shelf** — a maintained
   WGSL implementation that we can run through our own parity gate rather than
   write. Until then, speed is not a claim ternary can make here.
4. **Then, and only then**: ternary QAT on the same data and the same evaluation
   as the baseline, exported as a second artifact, compared on answers and
   tokens/second, with `verify:engine` extended to the new format. Go/no-go on
   those numbers, not on the idea.

## What would change the verdict today

Nothing available on this machine. The blocker is not belief about ternary — it
is that the decision belongs *after* the baseline proves itself, and the two
input measurements it depends on (a trained checkpoint, and size pressure) are
both still absent.
