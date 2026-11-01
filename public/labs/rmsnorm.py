#!/usr/bin/env python3
"""Fused RMSNorm in Triton (Q15):  y_i = x_i * rsqrt(mean_j(x_j^2) + eps) * w_i

  python3 rmsnorm.py --cpu-check     pure-Python reference on x = [1, 2, 3, 4] (no GPU needed)
  python3 rmsnorm.py --check         Triton vs PyTorch on irregular shapes and fp32/fp16/bf16
  python3 rmsnorm.py --bench         CUDA-event timing vs PyTorch expression and F.rms_norm

Requires for --check/--bench: CUDA GPU, torch, triton. Without them it prints 'not measured' and exits 0.
RMSNorm does NOT subtract the mean (LayerNorm does) and has no bias.
"""
from __future__ import annotations

import argparse
import math
import sys


def reference(x: list[float], w: list[float] | None = None, eps: float = 1e-6) -> list[float]:
    """Plain-Python RMSNorm for one row."""
    w = w or [1.0] * len(x)
    inv = 1.0 / math.sqrt(sum(v * v for v in x) / len(x) + eps)
    return [v * inv * wi for v, wi in zip(x, w)]


def cpu_check() -> None:
    x = [1.0, 2.0, 3.0, 4.0]
    # mean(x^2) = (1 + 4 + 9 + 16) / 4 = 7.5 ; rms = sqrt(7.5) = 2.7386
    y = reference(x, eps=0.0)
    expected = [v / math.sqrt(7.5) for v in x]
    assert all(abs(a - b) < 1e-12 for a, b in zip(y, expected)), y
    assert abs(sum(v * v for v in y) / len(y) - 1.0) < 1e-12  # output has unit mean square
    print("x       =", x)
    print("mean x² = 7.5, rms = %.4f" % math.sqrt(7.5))
    print("y       =", [round(v, 4) for v in y])
    print("cpu-check OK")


def gpu_stack():
    try:
        import torch
        import triton
        import triton.language as tl
    except ImportError as e:
        return None, f"missing package: {e.name}"
    if not torch.cuda.is_available():
        return None, "no CUDA device"
    return (torch, triton, tl), None


def build_kernel(triton, tl):
    @triton.jit
    def rmsnorm_kernel(X, W, Y, stride_x, stride_y, N, eps, BLOCK: tl.constexpr):
        row = tl.program_id(0)  # one program per row
        cols = tl.arange(0, BLOCK)
        mask = cols < N  # arbitrary hidden size: mask the tail
        x = tl.load(X + row * stride_x + cols, mask=mask, other=0.0).to(tl.float32)  # FP32 accumulation
        ms = tl.sum(x * x, axis=0) / N
        inv = 1.0 / tl.sqrt(ms + eps)
        w = tl.load(W + cols, mask=mask, other=0.0).to(tl.float32)
        tl.store(Y + row * stride_y + cols, (x * inv * w).to(Y.dtype.element_ty), mask=mask)

    return rmsnorm_kernel


def make_rmsnorm(torch, triton, tl):
    kernel = build_kernel(triton, tl)

    def rmsnorm(x, w, eps=1e-6):
        assert x.is_cuda and x.shape[-1] == w.shape[0]
        x2 = x.reshape(-1, x.shape[-1])
        if x2.stride(-1) != 1:
            x2 = x2.contiguous()
        M, N = x2.shape
        y = torch.empty_like(x2)
        BLOCK = triton.next_power_of_2(N)
        # ponytail: whole row in one block; rows above ~64K elements need a looped two-pass kernel.
        if BLOCK > 65536:
            raise ValueError("hidden size too large for single-block kernel")
        warps = 4 if BLOCK <= 2048 else 8 if BLOCK <= 8192 else 16
        kernel[(M,)](x2, w, y, x2.stride(0), y.stride(0), N, eps, BLOCK=BLOCK, num_warps=warps)
        return y.reshape(x.shape)

    return rmsnorm


def torch_expr(torch, x, w, eps=1e-6):
    xf = x.float()
    return (xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps) * w.float()).to(x.dtype)


def check(stack) -> None:
    torch, triton, tl = stack
    rms = make_rmsnorm(torch, triton, tl)
    tol = {torch.float32: (1e-5, 1e-5), torch.float16: (2e-3, 2e-3), torch.bfloat16: (1.6e-2, 1.6e-2)}
    shapes = [(1, 1), (3, 1000), (127, 4097), (4096, 8192)]
    for dtype, (atol, rtol) in tol.items():
        for M, N in shapes:
            torch.manual_seed(0)
            x = torch.randn(M, N, device="cuda", dtype=dtype) * 3
            w = torch.randn(N, device="cuda", dtype=dtype)
            got, ref = rms(x, w), torch_expr(torch, x, w)
            torch.testing.assert_close(got, ref, atol=atol, rtol=rtol)
            print(f"ok  {str(dtype):15s} {M:5d} x {N:5d}  max|err| = {(got.float() - ref.float()).abs().max().item():.2e}")
    print("check OK")


def bench(stack, reps=100, warmup=25) -> None:
    torch, triton, tl = stack
    rms = make_rmsnorm(torch, triton, tl)
    fused = getattr(torch.nn.functional, "rms_norm", None)
    print(f"GPU: {torch.cuda.get_device_name()}  torch {torch.__version__}  triton {triton.__version__}")
    print(f"{'shape':>14} {'dtype':>9} {'impl':>12} {'median µs':>10} {'GB/s':>8}")

    def time_us(fn):
        for _ in range(warmup):  # warm-up also triggers and excludes JIT compilation
            fn()
        torch.cuda.synchronize()
        times = []
        for _ in range(reps):
            s, e = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
            s.record(); fn(); e.record()
            torch.cuda.synchronize()
            times.append(s.elapsed_time(e) * 1000)
        times.sort()
        return times[len(times) // 2]

    for M, N in [(1, 4096), (128, 4096), (4096, 4096), (4096, 8192), (16384, 8192)]:
        for dtype in (torch.float16, torch.bfloat16):
            x = torch.randn(M, N, device="cuda", dtype=dtype)
            w = torch.randn(N, device="cuda", dtype=dtype)
            # Effective bytes: read x, read w, write y (ideal single pass).
            nbytes = (2 * M * N + N) * x.element_size()
            impls = {"triton": lambda: rms(x, w), "torch expr": lambda: torch_expr(torch, x, w)}
            if fused:
                impls["F.rms_norm"] = lambda: fused(x, (N,), w, 1e-6)
            for name, fn in impls.items():
                us = time_us(fn)
                print(f"{M:>6} x {N:<6} {str(dtype)[6:]:>9} {name:>12} {us:10.1f} {nbytes / us / 1e3:8.1f}")
    print("Evidence label: measured on the GPU above. Record GPU, driver, versions with any result.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cpu-check", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--bench", action="store_true")
    a = ap.parse_args()
    if a.cpu_check or not (a.check or a.bench):
        cpu_check()
    if a.check or a.bench:
        stack, why = gpu_stack()
        if stack is None:
            print(f"GPU check/bench: not measured ({why}).")
            sys.exit(0)
        if a.check:
            check(stack)
        if a.bench:
            bench(stack)


if __name__ == "__main__":
    main()
