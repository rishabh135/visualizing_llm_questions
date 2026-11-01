// Models & GPU performance engines (Q11-Q15). Pure functions only.
import { GB, GiB, sum } from './core';

// ---------- Q11: quantization ----------

/** Round to the nearest FP8 E4M3 (OCP, finite-only) value; saturates at ±448. */
export function e4m3Round(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const a = Math.min(Math.abs(x), 448);
  const exp = Math.max(-6, Math.floor(Math.log2(a))); // -6 = min normal exponent; below it the step stays 2^-9 (subnormals)
  const step = 2 ** (exp - 3); // 3 mantissa bits
  const r = Math.min(448, Math.round(a / step) * step);
  return Math.sign(x) * r;
}

/** FP4 E2M1 magnitudes (NVIDIA NVFP4 blog, 2025-06-24). */
export const E2M1 = [0, 0.5, 1, 1.5, 2, 3, 4, 6];

export function e2m1Round(x: number): number {
  const a = Math.min(Math.abs(x), 6);
  let best = 0;
  for (const v of E2M1) if (Math.abs(v - a) < Math.abs(best - a)) best = v;
  return Math.sign(x) * best || 0;
}

export type QFormat = 'int8' | 'int4' | 'int4g' | 'fp8' | 'nvfp4';

export const Q_LABEL: Record<QFormat, string> = {
  int8: 'INT8 per-tensor',
  int4: 'INT4 per-tensor',
  int4g: 'INT4 per-group',
  fp8: 'FP8 E4M3 per-tensor',
  nvfp4: 'NVFP4 (E2M1 + E4M3/16)',
};

export interface QResult {
  format: QFormat;
  deq: number[];
  absErr: number[];
  /** |err| / |x|, capped at 1 (= value lost). */
  relErr: number[];
  mse: number;
  /** Scale factors used (one per tensor, group or block). */
  scales: number[];
  /** Representable reconstructed values within ±amax for the first scale group. */
  levels: number[];
}

const intLevels = (qmax: number, s: number) => Array.from({ length: 2 * qmax + 1 }, (_, i) => (i - qmax) * s);

function intQuant(xs: number[], qmax: number, clip: number): { deq: number[]; s: number } {
  const amax = Math.max(...xs.map(Math.abs)) * clip || 1;
  const s = amax / qmax;
  return { deq: xs.map((x) => Math.max(-qmax, Math.min(qmax, Math.round(x / s))) * s || 0), s }; // || 0 drops -0
}

/**
 * Fake-quantize a vector and reconstruct it. `clip` scales the range (1 = use amax, <1 clips outliers).
 * `group` applies to INT4 per-group; NVFP4 always uses 16-value blocks plus one FP32 per-tensor scale.
 */
export function quantize(xs: number[], format: QFormat, clip = 1, group = 2): QResult {
  let deq: number[] = [];
  let scales: number[] = [];
  let levels: number[] = [];
  if (format === 'int8' || format === 'int4') {
    const qmax = format === 'int8' ? 127 : 7;
    const r = intQuant(xs, qmax, clip);
    deq = r.deq; scales = [r.s]; levels = intLevels(qmax, r.s);
  } else if (format === 'int4g') {
    for (let i = 0; i < xs.length; i += group) {
      const r = intQuant(xs.slice(i, i + group), 7, clip);
      deq.push(...r.deq); scales.push(r.s);
    }
    levels = intLevels(7, scales[0]);
  } else if (format === 'fp8') {
    const s = (Math.max(...xs.map(Math.abs)) * clip || 1) / 448;
    deq = xs.map((x) => e4m3Round(Math.max(-448, Math.min(448, x / s))) * s);
    scales = [s];
    levels = fp8Grid().map((v) => v * s);
  } else {
    // Two-level: FP32 per-tensor scale maps the tensor amax onto 6 × 448, then an E4M3 scale per 16-value block.
    const amax = Math.max(...xs.map(Math.abs)) * clip || 1;
    const sTensor = amax / (6 * 448);
    for (let i = 0; i < xs.length; i += 16) {
      const blk = xs.slice(i, i + 16);
      const bmax = Math.min(Math.max(...blk.map(Math.abs)), amax);
      const sBlock = e4m3Round(bmax / 6 / sTensor) || 2 ** -9;
      const s = sBlock * sTensor;
      deq.push(...blk.map((x) => e2m1Round(x / s) * s));
      scales.push(s);
    }
    levels = [...E2M1.slice(1).map((v) => -v).reverse(), ...E2M1].map((v) => v * scales[0]);
  }
  const absErr = xs.map((x, i) => Math.abs(x - deq[i]));
  const relErr = xs.map((x, i) => (x === 0 ? 0 : Math.min(1, absErr[i] / Math.abs(x))));
  return { format, deq, absErr, relErr, mse: sum(absErr.map((e) => e * e)) / xs.length, scales, levels };
}

/** All non-negative finite E4M3 values, mirrored. 0..448. */
export function fp8Grid(): number[] {
  const pos: number[] = [];
  for (let m = 0; m < 8; m++) pos.push(m * 2 ** -9); // subnormals
  for (let e = 1; e <= 15; e++) for (let m = 0; m < 8; m++) {
    if (e === 15 && m === 7) continue; // NaN encoding
    pos.push((1 + m / 8) * 2 ** (e - 7));
  }
  return [...pos.slice(1).map((v) => -v).reverse(), ...pos];
}

/** Storage bits per value including scale metadata for a tensor of n values. */
export function effectiveBits(format: QFormat, n: number, group = 128, scaleBits = 16): number {
  switch (format) {
    case 'int8': return 8 + 32 / n;
    case 'int4': return 4 + 32 / n;
    case 'int4g': return 4 + scaleBits / group;
    case 'fp8': return 8 + 32 / n;
    case 'nvfp4': return 4 + 8 / 16 + 32 / n;
  }
}

// ---------- Q12: GPU choice ----------

export interface GpuSpec {
  id: string;
  name: string;
  /** Vendor memory, decimal GB. */
  memGB: number;
  /** Vendor memory bandwidth, decimal TB/s. */
  bwTBs: number;
  /** Dense (no sparsity) tensor TFLOPS. */
  bf16: number;
  fp8: number;
  fp4?: number;
  link: string;
  tdpW?: number;
  /** Assumed rental $/GPU-hour, never a quote. */
  price: number;
  source: string;
  note: string;
}

/**
 * Vendor specs checked 2026-10-31. NVIDIA pages print sparse TFLOPS; dense = sparse / 2.
 * B200 per-GPU values are DGX B200 system totals / 8.
 */
export const GPUS: GpuSpec[] = [
  { id: 'h100', name: 'H100 SXM', memGB: 80, bwTBs: 3.35, bf16: 989.5, fp8: 1979, link: 'NVLink 900 GB/s', tdpW: 700, price: 2.5,
    source: 'nvidia.com/en-us/data-center/h100', note: 'Sparse 1,979 BF16 / 3,958 FP8 halved' },
  { id: 'h200', name: 'H200 SXM', memGB: 141, bwTBs: 4.8, bf16: 989.5, fp8: 1979, link: 'NVLink 900 GB/s', tdpW: 700, price: 3.5,
    source: 'nvidia.com/en-us/data-center/h200', note: 'Same compute as H100; more and faster HBM3e' },
  { id: 'b200', name: 'B200 (in DGX B200)', memGB: 180, bwTBs: 8, bf16: 2250, fp8: 4500, fp4: 9000, link: 'NVLink 1.8 TB/s', price: 5.5,
    source: 'nvidia.com/en-us/data-center/dgx-b200', note: 'System 1,440 GB / 64 TB/s / 72 PF FP8 sparse ÷ 8; BF16 & FP4 derived as FP8 ÷ 2 and × 2 (unverified)' },
  { id: 'l40s', name: 'L40S (PCIe)', memGB: 48, bwTBs: 0.864, bf16: 362.05, fp8: 733, link: 'PCIe Gen4 x16, 64 GB/s bidir, no NVLink', tdpW: 350, price: 1.0,
    source: 'nvidia.com/en-us/data-center/l40s', note: 'GDDR6; dense values printed on page' },
];

/** Attainable TFLOPS at a given arithmetic intensity (FLOP per byte). */
export const roofline = (peakTflops: number, bwTBs: number, ai: number) => Math.min(peakTflops, bwTBs * ai);
/** Ridge point: the intensity above which compute, not bandwidth, is the ceiling. */
export const ridge = (peakTflops: number, bwTBs: number) => peakTflops / bwTBs;

export interface DeployInput {
  paramsB: number;
  /** Weight bytes per parameter (2 BF16, 1 FP8). */
  wBytes: number;
  /** KV bytes per token (KiB) at chosen KV precision. */
  kvKiBPerToken: number;
  batch: number;
  ctxTokens: number;
  /** Fraction of vendor memory usable for weights + KV. */
  usableFrac: number;
  /** Achieved fraction of peak bandwidth (assumed). */
  mbu: number;
  /** Achieved fraction of peak compute (assumed). */
  mfu: number;
  price: number;
}

export interface DeployResult {
  weightBytes: number;
  kvBytes: number;
  needBytes: number;
  usablePerGpu: number;
  gpusMin: number;
  /** Next power of two for feasible tensor parallelism. */
  tp: number;
  multiNode: boolean;
  bytesPerStep: number;
  memMs: number;
  computeMs: number;
  stepMs: number;
  bound: 'memory' | 'compute';
  tokPerSec: number;
  perUserTokS: number;
  usdPerMTok: number;
  decodeAI: number;
}

/** Decode-only, weights + all KV read once per step. Upper bound on throughput, lower bound on cost. */
export function deploy(g: GpuSpec, d: DeployInput): DeployResult {
  const weightBytes = d.paramsB * 1e9 * d.wBytes;
  const kvBytes = d.kvKiBPerToken * 1024 * d.ctxTokens * d.batch;
  const needBytes = weightBytes + kvBytes;
  const usablePerGpu = g.memGB * GB * d.usableFrac;
  const gpusMin = Math.max(1, Math.ceil(needBytes / usablePerGpu));
  const tp = 2 ** Math.ceil(Math.log2(gpusMin));
  const bytesPerStep = needBytes;
  const memMs = (bytesPerStep / (tp * g.bwTBs * 1e12 * d.mbu)) * 1e3;
  const peak = d.wBytes <= 1 ? g.fp8 : g.bf16;
  const flops = 2 * d.paramsB * 1e9 * d.batch;
  const computeMs = (flops / (tp * peak * 1e12 * d.mfu)) * 1e3;
  const stepMs = Math.max(memMs, computeMs);
  const tokPerSec = d.batch / (stepMs / 1e3);
  return {
    weightBytes, kvBytes, needBytes, usablePerGpu, gpusMin, tp, multiNode: tp > 8, bytesPerStep, memMs, computeMs, stepMs,
    bound: memMs >= computeMs ? 'memory' : 'compute', tokPerSec, perUserTokS: 1000 / stepMs,
    usdPerMTok: ((tp * d.price) / (tokPerSec * 3600)) * 1e6,
    decodeAI: flops / bytesPerStep,
  };
}

// ---------- Q13: profiling classifier ----------

export interface ProfileInput {
  /** Work in GFLOP. */
  gflop: number;
  /** HBM traffic in GB (decimal). */
  gbytes: number;
  kernels: number;
  launchUs: number;
  measuredMs: number;
  peakTflops: number;
  bwTBs: number;
}

export type Bound = 'compute-bound' | 'memory-bandwidth-bound' | 'launch-overhead-bound' | 'gaps: CPU / sync / comms';

export function classify(p: ProfileInput) {
  const ai = p.gflop / p.gbytes;
  // 1 TFLOP/s = 1 GFLOP/ms and 1 TB/s = 1 GB/ms, so these divisions are already in ms.
  const cMs = p.gflop / p.peakTflops;
  const memMs = p.gbytes / p.bwTBs;
  const launchMs = (p.kernels * p.launchUs) / 1e3;
  const floorMs = Math.max(cMs, memMs);
  const predictedMs = floorMs + launchMs;
  let bound: Bound;
  if (launchMs > floorMs) bound = 'launch-overhead-bound';
  else if (p.measuredMs > 1.5 * predictedMs) bound = 'gaps: CPU / sync / comms';
  else bound = memMs >= cMs ? 'memory-bandwidth-bound' : 'compute-bound';
  const achievedTflops = p.gflop / p.measuredMs; // GFLOP/ms = TFLOP/s
  const achievedTBs = p.gbytes / p.measuredMs; // GB/ms = TB/s
  return {
    ai, ridge: ridge(p.peakTflops, p.bwTBs), computeMs: cMs, memMs, launchMs, floorMs, predictedMs, bound,
    achievedTflops, achievedTBs, pctCompute: achievedTflops / p.peakTflops, pctBw: achievedTBs / p.bwTBs,
    unexplainedMs: Math.max(0, p.measuredMs - predictedMs),
  };
}

export interface TraceEvent { lane: 'CPU launch' | 'GPU compute' | 'HBM traffic' | 'NCCL' | 'Idle gap'; start: number; dur: number; label: string }

/**
 * Synthetic trace: the CPU launches `kernels` kernels; each takes kernelUs on the GPU and needs launchUs of CPU time.
 * If launch is slower than the kernel, the GPU waits (gap). Every `syncEvery` kernels a host sync + all-reduce of ncclUs.
 */
export function synthTrace(kernels: number, kernelUs: number, launchUs: number, syncEvery: number, ncclUs: number, memShare: number): TraceEvent[] {
  const ev: TraceEvent[] = [];
  let cpu = 0;
  let gpu = 0;
  for (let k = 0; k < kernels; k++) {
    ev.push({ lane: 'CPU launch', start: cpu, dur: launchUs, label: `launch ${k + 1}` });
    cpu += launchUs;
    const start = Math.max(gpu, cpu);
    if (start > gpu + 0.01) ev.push({ lane: 'Idle gap', start: gpu, dur: start - gpu, label: 'GPU waits for CPU' });
    ev.push({ lane: 'GPU compute', start, dur: kernelUs, label: `kernel ${k + 1}` });
    ev.push({ lane: 'HBM traffic', start, dur: kernelUs * memShare, label: 'HBM read/write' });
    gpu = start + kernelUs;
    if (syncEvery > 0 && (k + 1) % syncEvery === 0) {
      ev.push({ lane: 'NCCL', start: gpu, dur: ncclUs, label: 'all-reduce' });
      gpu += ncclUs;
      cpu = Math.max(cpu, gpu); // host sync: CPU blocks until GPU drains, so the next launch leaves a gap
    }
  }
  return ev.filter((e) => e.dur > 0);
}

export function traceSummary(ev: TraceEvent[]) {
  const end = Math.max(...ev.map((e) => e.start + e.dur));
  const busy = sum(ev.filter((e) => e.lane === 'GPU compute').map((e) => e.dur));
  const comm = sum(ev.filter((e) => e.lane === 'NCCL').map((e) => e.dur));
  return { endUs: end, busyFrac: busy / end, commFrac: comm / end, idleFrac: Math.max(0, 1 - (busy + comm) / end) };
}

// ---------- Q14: serving pipeline ----------

export type Fault = 'tokenizer' | 'eventloop' | 'admission' | 'kv' | 'imbalance' | 'oversync';

export interface PipeInput {
  /** Offered requests per second. */
  lambda: number;
  outTokens: number;
  replicas: number;
  faults: Fault[];
}

export interface StageRow { stage: string; capacity: number; offered: number; passed: number; queueGrowth: number }

export interface PipeResult {
  stages: StageRow[];
  bottleneck: string;
  delivered: number;
  gpuDemand: number;
  maxBatch: number;
  replicaBatch: number[];
  /** What nvidia-smi "utilization" roughly shows: fraction of time a kernel is running. */
  duty: number;
  /** Delivered tokens / tokens the healthy cluster could deliver at max batch. */
  usefulWork: number;
  stepMs: number[];
}

/** Per-replica decode step model, ms: weights read + per-sequence cost + sync overhead. */
export const STEP = { baseMs: 25, perSeqMs: 0.25, healthyMaxBatch: 256 };

/** Batch that serves `reqPerSec` on one replica, clamped to maxBatch. Solves b / step(b) = demand tokens/s. */
export function batchFor(reqPerSec: number, outTokens: number, syncMs: number, maxBatch: number) {
  const tps = (reqPerSec * outTokens) / 1000; // tokens per ms
  const denom = 1 - tps * STEP.perSeqMs;
  const b = denom <= 0 ? Infinity : (tps * (STEP.baseMs + syncMs)) / denom;
  return Math.min(maxBatch, b);
}

export const replicaCap = (outTokens: number, syncMs: number, maxBatch: number) =>
  (maxBatch / (STEP.baseMs + STEP.perSeqMs * maxBatch + syncMs)) * 1000 / outTokens;

export function pipeline(p: PipeInput): PipeResult {
  const f = new Set(p.faults);
  const syncMs = f.has('oversync') ? 15 : 0;
  const stallFrac = f.has('eventloop') ? 0.35 : 0;
  let maxBatch = STEP.healthyMaxBatch;
  if (f.has('admission')) maxBatch = Math.min(maxBatch, 16);
  if (f.has('kv')) maxBatch = Math.min(maxBatch, 24);
  const gpuCap = p.replicas * replicaCap(p.outTokens, syncMs, maxBatch) * (1 - stallFrac);
  const caps: [string, number][] = [
    ['Gateway', 500],
    ['Tokenizer', f.has('tokenizer') ? 15 : 120],
    ['Scheduler', f.has('eventloop') ? 160 : 400],
    ['GPU decode', gpuCap],
    ['Detokenize', 300],
    ['Flush (SSE)', 300],
  ];
  let flow = p.lambda;
  const stages: StageRow[] = caps.map(([stage, capacity]) => {
    const passed = Math.min(flow, capacity);
    const row = { stage, capacity, offered: flow, passed, queueGrowth: Math.max(0, flow - capacity) };
    flow = passed;
    return row;
  });
  const gpuRow = stages[3];
  const gpuDemand = gpuRow.offered;
  // Load imbalance: one hot replica gets 2x its share.
  const shares = Array.from({ length: p.replicas }, (_, i) =>
    f.has('imbalance') ? (i === 0 ? 2 / (p.replicas + 1) : 1 / (p.replicas + 1)) : 1 / p.replicas);
  const perCap = replicaCap(p.outTokens, syncMs, maxBatch) * (1 - stallFrac);
  const delivReplica = shares.map((s) => Math.min(gpuDemand * s, perCap));
  const delivered = Math.min(sum(delivReplica), stages[4].capacity, stages[5].capacity);
  const replicaBatch = delivReplica.map((d) => batchFor(d / (1 - stallFrac || 1), p.outTokens, syncMs, maxBatch));
  const stepMs = replicaBatch.map((b) => STEP.baseMs + STEP.perSeqMs * b + syncMs);
  const duty = sum(replicaBatch.map((b, i) => {
    const kernel = STEP.baseMs + STEP.perSeqMs * b;
    const present = Math.min(1, b); // b < 1 means the replica is empty part of the time
    return present * (kernel / stepMs[i]) * (1 - stallFrac);
  })) / p.replicas;
  const healthy = p.replicas * replicaCap(p.outTokens, 0, STEP.healthyMaxBatch);
  const bottleneck = stages.reduce((a, b) => (b.capacity < a.capacity ? b : a)).stage;
  // Rewrite GPU row to reflect imbalance-limited delivery.
  stages[3] = { ...gpuRow, passed: sum(delivReplica), queueGrowth: Math.max(0, gpuDemand - sum(delivReplica)) };
  return { stages, bottleneck, delivered, gpuDemand, maxBatch, replicaBatch, duty, usefulWork: delivered / healthy, stepMs };
}

// ---------- Q15: RMSNorm ----------

export function rmsnorm(x: number[], w: number[], eps = 1e-6): number[] {
  const ms = sum(x.map((v) => v * v)) / x.length;
  const r = 1 / Math.sqrt(ms + eps);
  return x.map((v, i) => v * r * w[i]);
}

export function layernorm(x: number[], w: number[], b: number[], eps = 1e-6): number[] {
  const m = sum(x) / x.length;
  const v = sum(x.map((t) => (t - m) ** 2)) / x.length;
  return x.map((t, i) => ((t - m) / Math.sqrt(v + eps)) * w[i] + b[i]);
}

export interface NormTrafficInput {
  rows: number;
  hidden: number;
  /** Bytes per element of x / y. */
  bytes: number;
  bwTBs: number;
  /** Achieved fraction of peak bandwidth. */
  eff: number;
  launchUs: number;
  /** 'eager' = 6 separate PyTorch ops; 'compiled' = baseline already fused. */
  baseline: 'eager' | 'compiled';
}

/**
 * Eager `x * rsqrt(x.pow(2).mean(-1, keepdim) + eps) * w`:
 * pow (R x, W x²), mean (R x², W r), add (r), rsqrt (r), mul (R x + r, W y1), mul (R y1 + w, W y).
 * Full-size passes: 7 · R·H·b. Fused: read x, write y once (w once): 2 · R·H·b + H·b.
 */
export function normTraffic(i: NormTrafficInput) {
  const full = i.rows * i.hidden * i.bytes;
  const small = i.rows * 4;
  const w = i.hidden * i.bytes;
  const eagerBytes = 7 * full + 6 * small + w;
  const fusedBytes = 2 * full + w;
  const baseBytes = i.baseline === 'eager' ? eagerBytes : fusedBytes;
  const baseLaunches = i.baseline === 'eager' ? 6 : 1;
  const t = (bytes: number, launches: number) => (bytes / (i.bwTBs * 1e12 * i.eff)) * 1e6 + launches * i.launchUs;
  const baseUs = t(baseBytes, baseLaunches);
  const fusedUs = t(fusedBytes, 1);
  return { full, eagerBytes, fusedBytes, baseBytes, baseLaunches, baseUs, fusedUs, speedup: baseUs / fusedUs, fusedGBs: fusedBytes / fusedUs / 1e3 };
}

export const bytesToGiB = (b: number) => b / GiB;
