"""The scratch model (§7.1).

config  Llama-compatible configurations: A, lite (contingency), smoke (local)
plan    framework-free arithmetic: parameter schema, KV cache, FLOPs, RoPE, GQA
model   the PyTorch implementation (requires torch)

`plan` is deliberately import-safe without torch: the parameter count, the
HF-compatible key set and the RoPE frequencies must be checkable on a
machine that cannot run the model at all.
"""
