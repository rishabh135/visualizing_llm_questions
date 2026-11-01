// Systems design engines (Q21-Q25). Pure, seeded, no React.
import { GB, GiB, clamp, percentile, rng, sum } from './core';
import { kvBytesPerToken, LLAMA70B } from './g1';

// ---------- Q21: multi-tenant fair scheduling ----------

export interface Tenant {
  name: string;
  /** DRR weight (share of tokens under backlog). */
  weight: number;
  /** Mean tokens of work per request (uniform 0.5x-1.5x). */
  meanTokens: number;
  /** Mean arrivals per tick. */
  rate: number;
  /** Admission rate limit: max admitted requests per tick (token bucket refill). */
  rateLimit: number;
  /** Max requests in system (in service + queued). Arrivals beyond it are rejected. */
  queueCap: number;
}

export type FairPolicy = 'fcfs' | 'rr' | 'drr';

export interface FairInput {
  tenants: Tenant[];
  /** Token budget per tick (scheduler capacity). */
  capacity: number;
  ticks: number;
  seed: number;
  /** DRR quantum in tokens per unit weight per round. */
  quantum: number;
}

interface Req { tenant: number; arrive: number; work: number; rem: number; firstServe: number }

export interface TenantResult {
  name: string;
  arrived: number;
  admitted: number;
  rejected: number;
  completed: number;
  servedTokens: number;
  share: number;
  p95Wait: number;
  meanWait: number;
}

export interface FairResult {
  policy: FairPolicy;
  tenants: TenantResult[];
  servedTotal: number;
  /** Ticks where budget was left unused while work was queued (must be 0: work conservation). */
  idleWithBacklog: number;
  /** Total work admitted; servedTotal + backlogEnd must equal it. */
  admittedWork: number;
  backlogEnd: number;
}

/** Seeded arrival trace, identical for every policy. Each entry: [tick, tenant, work]. */
export function fairTrace(inp: FairInput): [number, number, number][] {
  const u = rng(inp.seed);
  const out: [number, number, number][] = [];
  for (let t = 0; t < inp.ticks; t++) {
    inp.tenants.forEach((tn, k) => {
      const whole = Math.floor(tn.rate);
      const n = whole + (u() < tn.rate - whole ? 1 : 0);
      for (let j = 0; j < n; j++) out.push([t, k, Math.max(1, Math.round(tn.meanTokens * (0.5 + u())))]);
    });
  }
  return out;
}

/** Discrete-tick token scheduler. Requests can be served partially across ticks (preemptible at token granularity). */
export function runFair(inp: FairInput, policy: FairPolicy): FairResult {
  const trace = fairTrace(inp);
  const T = inp.tenants.length;
  const queues: Req[][] = Array.from({ length: T }, () => []);
  const bucket = inp.tenants.map((tn) => tn.rateLimit);
  const stats = inp.tenants.map(() => ({ arrived: 0, admitted: 0, rejected: 0, completed: 0, served: 0, waits: [] as number[] }));
  const deficit = new Array(T).fill(0);
  let ptr = 0;
  let fresh = true; // DRR: add quantum only on first arrival at a tenant per round
  let ti = 0;
  let idleWithBacklog = 0;
  let admittedWork = 0;
  const allAdmitted: Req[] = [];

  for (let t = 0; t < inp.ticks; t++) {
    inp.tenants.forEach((tn, k) => { bucket[k] = Math.min(tn.rateLimit, bucket[k] + tn.rateLimit); });
    while (ti < trace.length && trace[ti][0] === t) {
      const [, k, work] = trace[ti++];
      stats[k].arrived++;
      if (bucket[k] < 1 || queues[k].length >= inp.tenants[k].queueCap) { stats[k].rejected++; continue; }
      bucket[k] -= 1;
      const r: Req = { tenant: k, arrive: t, work, rem: work, firstServe: -1 };
      queues[k].push(r); allAdmitted.push(r); stats[k].admitted++; admittedWork += work;
    }

    let budget = inp.capacity;
    const backlog = () => queues.some((q) => q.length > 0);
    const serve = (k: number, amount: number) => {
      const r = queues[k][0];
      if (r.firstServe < 0) r.firstServe = t;
      r.rem -= amount; budget -= amount; stats[k].served += amount;
      if (r.rem <= 0) { queues[k].shift(); stats[k].completed++; stats[k].waits.push(r.firstServe - r.arrive); }
    };

    let guard = 0;
    while (budget > 0 && backlog() && guard++ < 100_000) {
      if (policy === 'fcfs') {
        let best = -1;
        for (let k = 0; k < T; k++) if (queues[k].length && (best < 0 || queues[k][0].arrive < queues[best][0].arrive)) best = k;
        serve(best, Math.min(queues[best][0].rem, budget));
      } else if (policy === 'rr') {
        // One request per turn regardless of its size: request-count fairness.
        while (!queues[ptr].length) ptr = (ptr + 1) % T;
        const done = queues[ptr][0].rem <= budget;
        serve(ptr, Math.min(queues[ptr][0].rem, budget));
        if (done) ptr = (ptr + 1) % T;
      } else {
        if (!queues[ptr].length) { deficit[ptr] = 0; ptr = (ptr + 1) % T; fresh = true; continue; }
        if (fresh) { deficit[ptr] += inp.quantum * inp.tenants[ptr].weight; fresh = false; }
        if (deficit[ptr] <= 0) { ptr = (ptr + 1) % T; fresh = true; continue; }
        const amt = Math.min(queues[ptr][0].rem, deficit[ptr], budget);
        deficit[ptr] -= amt;
        serve(ptr, amt);
        if (!queues[ptr].length) deficit[ptr] = 0;
      }
    }
    if (budget > 0 && backlog()) idleWithBacklog++;
  }

  // Unfinished requests count with their censored wait so starvation shows up in p95.
  for (const r of allAdmitted) if (r.rem > 0) stats[r.tenant].waits.push((r.firstServe >= 0 ? r.firstServe : inp.ticks) - r.arrive);
  const servedTotal = sum(stats.map((s) => s.served));
  return {
    policy,
    tenants: stats.map((s, k) => ({
      name: inp.tenants[k].name, arrived: s.arrived, admitted: s.admitted, rejected: s.rejected, completed: s.completed,
      servedTokens: s.served, share: servedTotal ? s.served / servedTotal : 0,
      p95Wait: percentile(s.waits, 95), meanWait: s.waits.length ? sum(s.waits) / s.waits.length : NaN,
    })),
    servedTotal, idleWithBacklog, admittedWork,
    backlogEnd: sum(queues.flat().map((r) => r.rem)),
  };
}

// ---------- Q22: disaggregated prefill / decode ----------

export interface DisaggInput {
  promptTokens: number;
  outputTokens: number;
  /** KV bytes per element (2 BF16, 1 FP8). */
  kvBytes: number;
  /** Effective link bandwidth, decimal GB/s. */
  linkGBps: number;
  /** Concurrent transfers sharing the link. */
  concurrentTransfers: number;
  setupMs: number;
  /** Fraction of transfer that can stream per layer during prefill (0..1). */
  overlap: number;
  /** Prefill throughput of one pool instance, tokens/s (assumed: measure it). */
  prefillTps: number;
  /** Decode inter-token latency without prefill interference, ms. */
  itlMs: number;
  /** Fractional ITL slowdown when prefill runs on the same GPUs (monolithic). */
  interference: number;
}

export interface DisaggResult {
  kvBytes: number;
  prefillMs: number;
  rawTransferMs: number;
  exposedTransferMs: number;
  ttftMono: number;
  ttftDisagg: number;
  e2eMono: number;
  e2eDisagg: number;
  /** e2eDisagg - e2eMono; negative = disaggregation wins. */
  deltaMs: number;
}

/** Assumes the prefill pool emits token 1; KV transfer delays token 2. */
export function disagg(i: DisaggInput): DisaggResult {
  const kvB = kvBytesPerToken({ ...LLAMA70B, bytesPerElem: i.kvBytes }) * i.promptTokens;
  const prefillMs = (i.promptTokens / i.prefillTps) * 1000;
  const bw = (i.linkGBps * GB) / Math.max(1, i.concurrentTransfers);
  const rawTransferMs = (kvB / bw) * 1000;
  const hidden = Math.min(clamp(i.overlap, 0, 1) * rawTransferMs, prefillMs);
  const exposedTransferMs = i.setupMs + rawTransferMs - hidden;
  const gaps = Math.max(0, i.outputTokens - 1);
  const itlMono = i.itlMs * (1 + i.interference);
  const e2eMono = prefillMs + gaps * itlMono;
  const e2eDisagg = prefillMs + exposedTransferMs + gaps * i.itlMs;
  return {
    kvBytes: kvB, prefillMs, rawTransferMs, exposedTransferMs,
    ttftMono: prefillMs, ttftDisagg: prefillMs, e2eMono, e2eDisagg, deltaMs: e2eDisagg - e2eMono,
  };
}

/** Smallest prompt length (tokens, step 256) where disaggregation stops paying off; Infinity if it always wins up to maxTokens. */
export function disaggBreakEven(i: DisaggInput, maxTokens = 262_144): number {
  if (disagg({ ...i, promptTokens: 256 }).deltaMs >= 0) return 0;
  for (let p = 256; p <= maxTokens; p += 256) if (disagg({ ...i, promptTokens: p }).deltaMs >= 0) return p;
  return Infinity;
}

// ---------- Q23: MoE routing and parallelism ----------

export interface MoeToyInput {
  tokens: number;
  experts: number;
  topK: number;
  devices: number;
  /** Extra logit added to expert 0 (hot expert). */
  skew: number;
  capacityFactor: number;
  seed: number;
  /** Hidden size and bytes per activation element, for all-to-all bytes. */
  dModel: number;
  actBytes: number;
}

export interface MoeAssign { token: number; expert: number; dropped: boolean; remote: boolean }

export interface MoeToyResult {
  assigns: MoeAssign[];
  load: number[];
  capacity: number;
  dropped: number;
  /** Token-expert pairs crossing devices. */
  remote: number;
  /** Dispatch + combine bytes for the toy step. */
  a2aBytes: number;
  /** Max device load / mean device load (1 = balanced). */
  imbalance: number;
  deviceLoad: number[];
}

const deviceOfExpert = (e: number, E: number, D: number) => Math.floor((e * D) / E);
const deviceOfToken = (t: number, T: number, D: number) => Math.floor((t * D) / T);

/** Top-k routing with fixed per-expert capacity; overflow is dropped in token order. */
export function moeToy(i: MoeToyInput): MoeToyResult {
  const u = rng(i.seed);
  const capacity = Math.ceil((i.capacityFactor * i.tokens * i.topK) / i.experts);
  const load = new Array(i.experts).fill(0);
  const assigns: MoeAssign[] = [];
  for (let t = 0; t < i.tokens; t++) {
    const logits = Array.from({ length: i.experts }, (_, e) => u() * 2 + (e === 0 ? i.skew : 0));
    const ranked = logits.map((l, e) => [l, e] as const).sort((a, b) => b[0] - a[0]).slice(0, i.topK);
    for (const [, e] of ranked) {
      const dropped = load[e] >= capacity;
      if (!dropped) load[e]++;
      const remote = !dropped && deviceOfExpert(e, i.experts, i.devices) !== deviceOfToken(t, i.tokens, i.devices);
      assigns.push({ token: t, expert: e, dropped, remote });
    }
  }
  const remote = assigns.filter((a) => a.remote).length;
  const deviceLoad = new Array(i.devices).fill(0);
  load.forEach((l, e) => { deviceLoad[deviceOfExpert(e, i.experts, i.devices)] += l; });
  const meanDev = sum(deviceLoad) / i.devices;
  return {
    assigns, load, capacity, dropped: assigns.filter((a) => a.dropped).length, remote,
    a2aBytes: remote * i.dModel * i.actBytes * 2,
    imbalance: meanDev ? Math.max(...deviceLoad) / meanDev : 1, deviceLoad,
  };
}

export interface MoeModel {
  /** Attention + embeddings + router, billions of params. */
  sharedB: number;
  /** Total expert params across all experts, billions. */
  expertsB: number;
  experts: number;
  topK: number;
  devices: number;
  /** Tokens per step per layer (whole batch). */
  tokensPerStep: number;
  dModel: number;
  actBytes: number;
  weightBytes: number;
  microbatches: number;
  /** Transformer layers (for amortising pipeline hand-offs per layer). */
  layers: number;
  /** Max/mean device load for EP from routing skew. */
  imbalance: number;
}

export interface ParallelRow { name: string; memGiB: number; commMiB: number; bubble: number; computeScale: number }

/**
 * First-order per-layer comparison. Comm = bytes each device sends per MoE layer per step.
 * TP: two all-reduces (ring: 2(D-1)/D of the activation each). EP: dispatch + combine all-to-all.
 * PP: one activation hand-off per stage, amortised over layers/D layers; bubble = (D-1)/(m+D-1).
 * Hybrid: assumes attention all-reduce is half the dense TP volume. Activation layouts (TP replicates, EP shards) are simplified.
 */
export function moeParallel(m: MoeModel): ParallelRow[] {
  const D = m.devices;
  const act = m.tokensPerStep * m.dModel * m.actBytes;
  const ring = (2 * (D - 1)) / D;
  const a2a = ((m.tokensPerStep * m.topK) / D) * m.dModel * m.actBytes * ((D - 1) / D) * 2;
  const totalB = m.sharedB + m.expertsB;
  const gib = (b: number) => (b * 1e9 * m.weightBytes) / GiB;
  const mib = (b: number) => b / 1024 ** 2;
  return [
    { name: 'Tensor (TP)', memGiB: gib(totalB / D), commMiB: mib(2 * act * ring), bubble: 0, computeScale: 1 },
    { name: 'Pipeline (PP)', memGiB: gib(totalB / D), commMiB: mib((act * D) / m.layers), bubble: (D - 1) / (m.microbatches + D - 1), computeScale: 1 },
    { name: 'Expert (EP)', memGiB: gib(m.sharedB + m.expertsB / D), commMiB: mib(a2a), bubble: 0, computeScale: m.imbalance },
    { name: 'Hybrid TP+EP', memGiB: gib(m.sharedB / D + m.expertsB / D), commMiB: mib(2 * act * ring * 0.5 + a2a), bubble: 0, computeScale: m.imbalance },
  ];
}

export const moeActiveB = (m: Pick<MoeModel, 'sharedB' | 'expertsB' | 'experts' | 'topK'>) => m.sharedB + (m.expertsB * m.topK) / m.experts;

// ---------- Q24: cost per million tokens ----------

export interface Intervention {
  name: string;
  /** Fraction of unit cost removed on the traffic it applies to. */
  saving: number;
  /** Fraction of traffic it applies to. */
  share: number;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
}

export interface CostInput {
  gpuHourUsd: number;
  gpus: number;
  /** Delivered output tokens/s for the whole fleet at current utilization. */
  outputTps: number;
  /** Non-GPU overhead as fraction of GPU cost (network, storage, control plane). */
  overhead: number;
  /** Busy fraction of paid GPU time. */
  utilization: number;
  interventions: Intervention[];
}

export interface WaterStep { name: string; base: number; drop: number; after: number }

export interface CostResult {
  baselinePerM: number;
  breakdown: { name: string; perM: number }[];
  finalPerM: number;
  reduction: number;
  /** Naive additive sum of savings (double counts overlaps). */
  additiveReduction: number;
  target: number;
  meetsTarget: boolean;
  steps: WaterStep[];
}

/** Interventions combine multiplicatively, applied largest first. */
export function costPlan(c: CostInput): CostResult {
  const hourly = c.gpuHourUsd * c.gpus * (1 + c.overhead);
  const baselinePerM = (hourly / (c.outputTps * 3600)) * 1e6;
  const gpuPerM = baselinePerM / (1 + c.overhead);
  const breakdown = [
    { name: 'GPU busy', perM: gpuPerM * c.utilization },
    { name: 'GPU idle / headroom', perM: gpuPerM * (1 - c.utilization) },
    { name: 'Network, storage, control', perM: baselinePerM - gpuPerM },
  ];
  const on = c.interventions.filter((x) => x.enabled).map((x) => ({ ...x, eff: clamp(x.saving, 0, 1) * clamp(x.share, 0, 1) }));
  on.sort((a, b) => b.eff - a.eff);
  let cur = baselinePerM;
  const steps: WaterStep[] = [];
  for (const x of on) {
    const after = cur * (1 - x.eff);
    steps.push({ name: x.name, base: after, drop: cur - after, after });
    cur = after;
  }
  const reduction = 1 - cur / baselinePerM;
  return {
    baselinePerM, breakdown, finalPerM: cur, reduction,
    additiveReduction: sum(on.map((x) => x.eff)), target: 0.3 * baselinePerM, meetsTarget: cur <= 0.3 * baselinePerM + 1e-12, steps,
  };
}

// ---------- Q25: capacity planner ----------

export interface CapInput {
  dau: number;
  reqPerUserDay: number;
  /** Peak RPS / average RPS. */
  peakFactor: number;
  promptTokens: number;
  outputTokens: number;
  ttftS: number;
  itlMs: number;
  /** Measured aggregate decode tokens/s per GPU at the SLO (assumed until measured). */
  outTpsPerGpu: number;
  /** Measured prefill tokens/s per GPU (assumed until measured). */
  prefillTpsPerGpu: number;
  tp: number;
  gpuGB: number;
  reserveGiB: number;
  paramsB: number;
  weightBytes: number;
  kvBytes: number;
  /** Extra capacity fraction above computed peak. */
  headroom: number;
  regions: number;
  /** Spare TP groups per region (N+1 = 1). */
  spares: number;
  gpuHourUsd: number;
}

export interface CapResult {
  avgRps: number;
  peakRps: number;
  inTps: number;
  outTps: number;
  e2eS: number;
  concurrency: number;
  kvGiB: number;
  weightsGiB: number;
  kvRoomPerGroupGiB: number;
  groupsMem: number;
  groupsThroughput: number;
  groupsBase: number;
  gpus: number;
  bound: 'memory' | 'throughput';
  monthlyUsd: number;
  usdPerMOut: number;
}

const HOURS_PER_MONTH = 730;

export function capacity(c: CapInput): CapResult {
  const avgRps = (c.dau * c.reqPerUserDay) / 86_400;
  const peakRps = avgRps * c.peakFactor;
  const inTps = peakRps * c.promptTokens;
  const outTps = peakRps * c.outputTokens;
  const e2eS = c.ttftS + (Math.max(1, c.outputTokens) - 1) * (c.itlMs / 1000);
  const concurrency = peakRps * e2eS; // Little's law, steady-state mean
  // Average cached tokens over a request's life: full prompt plus half the output.
  const kvGiB = (concurrency * (c.promptTokens + c.outputTokens / 2) * kvBytesPerToken({ ...LLAMA70B, bytesPerElem: c.kvBytes })) / GiB;
  const weightsGiB = (c.paramsB * 1e9 * c.weightBytes) / GiB;
  const usablePerGpu = (c.gpuGB * GB) / GiB - c.reserveGiB;
  const kvRoomPerGroupGiB = c.tp * usablePerGpu - weightsGiB;
  const groupsMem = kvRoomPerGroupGiB <= 0 ? Infinity : Math.ceil(kvGiB / kvRoomPerGroupGiB);
  const gpusThroughput = outTps / c.outTpsPerGpu + inTps / c.prefillTpsPerGpu;
  const groupsThroughput = Math.ceil(gpusThroughput / c.tp);
  const need = Math.max(groupsMem, groupsThroughput);
  const groupsBase = Math.ceil(need * (1 + c.headroom));
  const perRegion = Math.ceil(groupsBase / c.regions) + c.spares;
  const gpus = Number.isFinite(perRegion) ? perRegion * c.regions * c.tp : Infinity;
  const monthlyUsd = gpus * c.gpuHourUsd * HOURS_PER_MONTH;
  const monthlyOut = avgRps * c.outputTokens * HOURS_PER_MONTH * 3600;
  return {
    avgRps, peakRps, inTps, outTps, e2eS, concurrency, kvGiB, weightsGiB, kvRoomPerGroupGiB,
    groupsMem, groupsThroughput, groupsBase, gpus, bound: groupsMem > groupsThroughput ? 'memory' : 'throughput',
    monthlyUsd, usdPerMOut: (monthlyUsd / monthlyOut) * 1e6,
  };
}

export const CAP_SENSITIVITY: { key: keyof CapInput; label: string; lo: number; hi: number }[] = [
  { key: 'reqPerUserDay', label: 'Requests / user / day', lo: 0.5, hi: 1.5 },
  { key: 'peakFactor', label: 'Peak factor', lo: 0.67, hi: 1.33 },
  { key: 'outputTokens', label: 'Output tokens', lo: 0.5, hi: 1.5 },
  { key: 'promptTokens', label: 'Prompt tokens', lo: 0.5, hi: 1.5 },
  { key: 'outTpsPerGpu', label: 'Decode tok/s per GPU', lo: 1.5, hi: 0.6 },
  { key: 'prefillTpsPerGpu', label: 'Prefill tok/s per GPU', lo: 1.5, hi: 0.6 },
];

/** GPUs at low/high multiplier for each input, one at a time. Sorted widest first. */
export function capSensitivity(c: CapInput) {
  return CAP_SENSITIVITY.map(({ key, label, lo, hi }) => {
    const a = capacity({ ...c, [key]: (c[key] as number) * lo }).gpus;
    const b = capacity({ ...c, [key]: (c[key] as number) * hi }).gpus;
    return { label, low: Math.min(a, b), high: Math.max(a, b), width: Math.abs(b - a) };
  }).sort((x, y) => y.width - x.width);
}

/** Low / base / high scenarios: demand and efficiency move together. */
export function capScenarios(c: CapInput) {
  const mk = (name: string, demand: number, eff: number) => {
    const r = capacity({ ...c, reqPerUserDay: c.reqPerUserDay * demand, outputTokens: Math.round(c.outputTokens * demand), outTpsPerGpu: c.outTpsPerGpu * eff, prefillTpsPerGpu: c.prefillTpsPerGpu * eff });
    return { name, gpus: r.gpus, monthlyUsd: r.monthlyUsd, usdPerMOut: r.usdPerMOut };
  };
  return [mk('Low', 0.7, 1.25), mk('Base', 1, 1), mk('High', 1.4, 0.75)];
}
