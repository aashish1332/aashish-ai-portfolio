"""inference/benchmark/benchmark_cpu.py — §14 "Python CPU inference first".

    python inference/benchmark/benchmark_cpu.py --config smoke --tokens 32
    python inference/benchmark/benchmark_cpu.py --config A --tokens 16 \
        --json docs/CPU_BENCHMARK.json

§14 asks for the CPU numbers *before* the browser runtime exists:

    "measure model load time, RAM, prefill and decode tok/s, generation
     time, file size."

Doing it here is not a formality. The browser port (P7) is a rewrite of the
same arithmetic into wasm, and the only way to tell a slow model from a slow
runtime is to have the model's own number written down first — with the
device, the dtype and the method next to it (§15 rule 5).

Three things this harness refuses to pretend:

1. **The weights are random.** No checkpoint exists yet, so every speed
   number here is the *architecture's*, not a trained model's. Quality is
   not measured and is not implied. The JSON says so in a field, not only in
   prose.
2. **RAM is the process, not the model.** `rss_bytes()` is read before and
   after `build()`, so the delta includes torch's own allocator; the method
   is recorded. `performance.memory`-style precision is not available here
   and §15.4's honesty rule applies to Python exactly as it applies to the
   browser.
3. **CPU-only.** `torch.set_num_threads` is set from a flag and reported, so
   a number measured on 4 threads cannot be compared against one measured on
   one without noticing.

File size is measured by writing the state_dict, not computed from the
parameter count: §9.2's whole point is that a size you computed is a size you
guessed.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import platform
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.model import plan  # noqa: E402
from ai.model.config import CONFIGS, ModelConfig  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── memory, on the three platforms this project runs on ─────────────

def rss_bytes() -> int | None:
    """Resident set size, or None when the platform will not say.

    `None` is returned rather than a guess: a fabricated memory number is
    worse than a missing one, because it is the number that gets quoted.
    """
    try:  # best case — psutil, if the developer happens to have it
        import psutil  # type: ignore
        return psutil.Process().memory_info().rss
    except Exception:
        pass

    if sys.platform.startswith("win"):  # the dev machine
        try:
            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                            ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]

            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(counters)
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
            # the handle is a pointer: without an explicit restype ctypes
            # truncates it to a 32-bit int and the call fails with 0
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            psapi.GetProcessMemoryInfo.argtypes = [
                ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), ctypes.c_ulong]
            psapi.GetProcessMemoryInfo.restype = ctypes.c_int
            ok = psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(),
                                            ctypes.byref(counters), counters.cb)
            if ok:
                return int(counters.WorkingSetSize)
        except Exception:
            pass

    try:  # macOS reports bytes, Linux reports kilobytes
        import resource
        raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(raw if sys.platform == "darwin" else raw * 1024)
    except Exception:
        return None


def _time(fn):
    start = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - start


def benchmark(cfg: ModelConfig, tokens: int, prompt_tokens: int, warmup: int,
              threads: int, baseline_rss: int | None = None,
              stream=sys.stdout) -> dict:
    import torch
    from ai.model.model import build

    torch.set_num_threads(threads)
    torch.manual_seed(0)

    model, load_s = _time(lambda: build(cfg, "cpu"))
    after = rss_bytes()
    params = model.param_count()

    with torch.no_grad():
        # warmup: the first forward pays lazy allocation and kernel setup,
        # and reporting that as decode speed is how a benchmark lies
        ids1 = torch.randint(0, cfg.vocab_size, (1, 1))
        for _ in range(warmup):
            model(ids1)

        prompt = torch.randint(0, cfg.vocab_size, (1, prompt_tokens))
        _, prefill_s = _time(lambda: model(prompt))

        _, decode_s = _time(lambda: model.generate(ids1, max_new_tokens=tokens))
        _, gen_s = _time(lambda: model.generate(prompt, max_new_tokens=tokens))

    # file size, measured by writing
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "model.pt"
        torch.save(model.state_dict(), path)
        fp32_bytes = path.stat().st_size
        half = {k: v.half() for k, v in model.state_dict().items()}
        torch.save(half, path)
        fp16_bytes = path.stat().st_size

    kv_per_token = plan.kv_cache_per_token(cfg)
    result = {
        "config": cfg.name,
        "params": params,
        "tokens": tokens,
        "prompt_tokens": prompt_tokens,
        "threads": threads,
        "torch": torch.__version__,
        "platform": platform.platform(),
        "processor": platform.processor() or platform.machine(),
        "weights": "RANDOM INITIALISATION — no checkpoint exists, so speed only",
        "load_seconds": round(load_s, 4),
        "rss_after_build_bytes": after,
        # A delta is only meaningful when nothing else has been built in this
        # process yet. Across `--config all` the second config's "delta" is a
        # negative number, which is worse than no number: it is reported as
        # null with the reason attached.
        "load_rss_delta_bytes": (None if (after is None or baseline_rss is None or baseline_rss < 0)
                                 else after - baseline_rss),
        "load_rss_method": "process RSS after build() minus a baseline taken once, before any build; includes torch's allocator",
        "prefill_seconds": round(prefill_s, 4),
        "prefill_tokens_per_second": round(prompt_tokens / prefill_s, 1) if prefill_s else None,
        "decode_seconds": round(decode_s, 4),
        "decode_tokens_per_second": round(tokens / decode_s, 1) if decode_s else None,
        "generation_seconds": round(gen_s, 4),
        "generation_tokens_per_second": round(tokens / gen_s, 1) if gen_s else None,
        "state_dict_fp32_bytes": fp32_bytes,
        "state_dict_fp16_bytes": fp16_bytes,
        "kv_cache_bytes_per_token": kv_per_token,
        "kv_cache_bytes_at_ctx": plan.kv_cache_bytes(cfg, cfg.max_position_embeddings),
    }
    return result


def report(r: dict, stream=sys.stdout) -> None:
    def mb(v):
        return "not measured this run" if v is None else f"{v / 1024 / 1024:.1f} MB"

    def abs_mb(v):
        return "not readable on this platform" if v is None else f"{v / 1024 / 1024:.1f} MB"

    print(f"\n{'─' * 68}", file=stream)
    print(f"  config {r['config']} · {r['params'] / 1e6:.2f}M params · "
          f"torch {r['torch']} · {r['threads']} threads", file=stream)
    print(f"  {r['platform']}", file=stream)
    print(f"{'─' * 68}", file=stream)
    print(f"  weights                 {r['weights']}", file=stream)
    print(f"  load                    {r['load_seconds'] * 1000:.0f} ms", file=stream)
    print(f"  load RSS delta          {mb(r['load_rss_delta_bytes'])} "
          f"(process after build: {abs_mb(r['rss_after_build_bytes'])})", file=stream)
    print(f"  prefill ({r['prompt_tokens']:>4} tok)    "
          f"{r['prefill_seconds'] * 1000:>8.0f} ms  {r['prefill_tokens_per_second']:>7} tok/s", file=stream)
    print(f"  decode  ({r['tokens']:>4} tok)    "
          f"{r['decode_seconds'] * 1000:>8.0f} ms  {r['decode_tokens_per_second']:>7} tok/s", file=stream)
    print(f"  generate                {r['generation_seconds'] * 1000:>8.0f} ms  "
          f"{r['generation_tokens_per_second']:>7} tok/s (prefill + decode)", file=stream)
    print(f"  state_dict              fp32 {r['state_dict_fp32_bytes'] / 1024 / 1024:.1f} MB · "
          f"fp16 {r['state_dict_fp16_bytes'] / 1024 / 1024:.1f} MB (written, not computed)", file=stream)
    print(f"  KV cache                {r['kv_cache_bytes_per_token'] / 1024:.2f} KB/token → "
          f"{r['kv_cache_bytes_at_ctx'] / 1024 / 1024:.1f} MB at ctx "
          f"{r['kv_cache_bytes_at_ctx'] // max(1, r['kv_cache_bytes_per_token'])}", file=stream)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="§14 CPU inference benchmark")
    ap.add_argument("--config", default="smoke", choices=sorted(CONFIGS) + ["all"])
    ap.add_argument("--tokens", type=int, default=32, help="decode tokens to time")
    ap.add_argument("--prompt-tokens", type=int, default=128)
    ap.add_argument("--warmup", type=int, default=2)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--json", type=Path, help="write the report here")
    args = ap.parse_args(argv)

    try:
        import torch  # noqa: F401
    except ImportError as exc:
        print("torch: NOT INSTALLED → the CPU benchmark did not run "
              f"({exc.__class__.__name__}).")
        print("Install it with the CPU wheel (see docs/TRAINING.md) and re-run; "
              "nothing is estimated in its place.")
        return 3

    names = sorted(CONFIGS) if args.config == "all" else [args.config]
    baseline = rss_bytes()
    if baseline is None:
        print("RSS: not readable on this platform — memory is reported as null, not guessed")
    results = []
    for index, name in enumerate(names):
        cfg = CONFIGS[name]
        print(f"\n{'═' * 68}\n  CPU inference benchmark — config {name.upper()}\n{'═' * 68}")
        # the baseline only applies to the first config in this process
        base = baseline if index == 0 else -1
        r = benchmark(cfg, args.tokens, args.prompt_tokens, args.warmup, args.threads, base)
        report(r)
        results.append(r)

    if args.json:
        payload = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "method": "python inference/benchmark/benchmark_cpu.py — random weights, CPU",
            "results": results,
        }
        Path(args.json).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
