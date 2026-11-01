// Pure, deterministic helpers shared by every engine. No React, no DOM.

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const TiB = 1024 ** 4;
/** Vendor specs use decimal units. */
export const GB = 1e9;

/** Clamp to [lo, hi]; NaN becomes lo so bad input never propagates. */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** mulberry32: tiny seeded PRNG so every simulation is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential sample with given mean, from a uniform source. */
export function expSample(u: () => number, mean: number): number {
  return -Math.log(1 - u()) * mean;
}

/** Nearest-rank percentile of an unsorted array; NaN for empty input. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

// ---------- Presentation-only formatting (never feed these back into maths) ----------

export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) return x.toExponential(2);
  return x.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Binary units for memory arithmetic. */
export function fmtBytes(b: number, digits = 1): string {
  if (!Number.isFinite(b)) return '—';
  const units: [number, string][] = [[TiB, 'TiB'], [GiB, 'GiB'], [MiB, 'MiB'], [KiB, 'KiB']];
  for (const [u, n] of units) if (Math.abs(b) >= u) return `${fmt(b / u, digits)} ${n}`;
  return `${fmt(b, 0)} B`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 10_000) return `${fmt(ms / 1000, 1)} s`;
  return `${fmt(ms, ms < 10 ? 2 : 0)} ms`;
}

export const fmtPct = (x: number, digits = 1) => (Number.isFinite(x) ? `${fmt(x * 100, digits)}%` : '—');

export function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return `$${x.toLocaleString('en-US', { maximumFractionDigits: x < 10 ? 2 : 0 })}`;
}
