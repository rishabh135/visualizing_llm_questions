// Production engineering engines (Q16-Q20). Pure, seeded, no React.
import { clamp, expSample, mean, percentile, rng, sum } from './core';

/** Standard normal sample (Box-Muller) from a seeded uniform source. */
function gauss(u: () => number): number {
  const a = Math.max(1e-12, u());
  const b = u();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

// ---------- Q16: synthetic serving telemetry ----------

export interface TelemetryInput {
  seed: number;
  minutes: number;
  baseRps: number;
  spikeAt: number;
  spikeLen: number;
  spikeMult: number;
  /** Requests per second the fleet can finish. */
  capacityRps: number;
  prefillMs: number;
  itlMs: number;
  outTokens: number;
  /** Concurrent requests the KV pool can hold. */
  kvCapacityReqs: number;
  /** Fraction of prompt tokens that are a reusable prefix (0..1). */
  prefixReuse: number;
  gpus: number;
  gpuHourUsd: number;
  ttftSloMs: number;
  /** Bounded queue, in requests. */
  maxQueue: number;
}

export interface TelemetryPoint {
  t: number;
  offered: number;
  admitted: number;
  completed: number;
  rejected: number;
  queue: number;
  ttftMean: number;
  ttftP50: number;
  ttftP99: number;
  gapP99: number;
  kvOcc: number;
  prefixHit: number;
  goodput: number;
  sloAttain: number;
  usdPerM: number;
}

/** One point per minute. Every Q16 chart reads this array. */
export function telemetry(i: TelemetryInput): TelemetryPoint[] {
  const u = rng(i.seed);
  const out: TelemetryPoint[] = [];
  let backlog = 0;
  let kvOcc = 0;
  for (let m = 0; m < i.minutes; m++) {
    const spike = m >= i.spikeAt && m < i.spikeAt + i.spikeLen ? i.spikeMult : 1;
    const offered = Math.max(0, i.baseRps * spike * (1 + 0.05 * gauss(u)));
    const arrivals = offered * 60;
    const capMin = i.capacityRps * 60;
    const start = backlog;
    const served = Math.min(capMin, backlog + arrivals);
    let next = backlog + arrivals - served;
    const rejected = Math.max(0, next - i.maxQueue);
    next -= rejected;
    backlog = next;
    const rho = Math.min(0.97, offered / i.capacityRps);
    const backlogWaitMs = ((start + next) / 2 / i.capacityRps) * 1000;
    // Eviction pressure erodes prefix hits once KV is nearly full (uses last minute's occupancy).
    const prefixHit = i.prefixReuse * (kvOcc > 0.85 ? 1 - ((kvOcc - 0.85) / 0.15) * 0.7 : 1);
    const prefill = i.prefillMs * (1 - 0.7 * prefixHit);
    const ttfts: number[] = [];
    const gaps: number[] = [];
    for (let k = 0; k < 300; k++) {
      const queued = u() < rho ? expSample(u, (prefill * rho) / (1 - rho)) : 0;
      ttfts.push(prefill * (0.6 + 0.8 * u()) + backlogWaitMs + queued);
    }
    const ttftMean = mean(ttfts);
    const active = (served / 60) * (ttftMean + i.outTokens * i.itlMs) / 1000;
    kvOcc = clamp(active / i.kvCapacityReqs, 0, 1);
    const itl = i.itlMs * (1 + 0.6 * kvOcc * rho);
    for (let k = 0; k < 300; k++) {
      // Rare long gaps: a prefill chunk scheduled between two decode steps.
      gaps.push(Math.max(0.1, itl * (1 + 0.15 * gauss(u))) + (u() < 0.02 + 0.1 * rho ? prefill * 0.3 : 0));
    }
    const sloAttain = ttfts.filter((x) => x <= i.ttftSloMs).length / ttfts.length;
    const tokens = served * i.outTokens;
    out.push({
      t: m, offered, admitted: (arrivals - rejected) / 60, completed: served / 60, rejected: rejected / 60, queue: next,
      ttftMean, ttftP50: percentile(ttfts, 50), ttftP99: percentile(ttfts, 99), gapP99: percentile(gaps, 99),
      kvOcc, prefixHit, goodput: (served / 60) * sloAttain, sloAttain,
      usdPerM: tokens > 0 ? ((i.gpus * i.gpuHourUsd) / 60 / tokens) * 1e6 : Infinity,
    });
  }
  return out;
}

export interface MetricDef {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  unit: string;
  labels: string;
  agg: string;
  alert: string;
}

/** Bounded labels only: never request_id, user_id or raw prompt. */
export const METRICS: MetricDef[] = [
  { name: 'ttft_seconds', type: 'histogram', unit: 's', labels: 'model, route, region', agg: 'p50/p95/p99 over 5 min', alert: 'p99 > SLO for 10 min' },
  { name: 'inter_token_seconds', type: 'histogram', unit: 's', labels: 'model, region', agg: 'p99 per request, then fleet p99', alert: 'p99 token gap > SLO' },
  { name: 'request_duration_seconds', type: 'histogram', unit: 's', labels: 'model, status', agg: 'p50/p99', alert: 'tail drift vs 7-day baseline' },
  { name: 'queue_wait_seconds', type: 'histogram', unit: 's', labels: 'model, priority', agg: 'p99', alert: 'early overload signal' },
  { name: 'requests_total', type: 'counter', unit: 'req', labels: 'model, status=offered|admitted|completed|rejected|cancelled', agg: 'rate()', alert: 'rejected / offered > 1 %' },
  { name: 'output_tokens_total', type: 'counter', unit: 'tokens', labels: 'model, slo_met', agg: 'rate() = goodput', alert: 'goodput drop at flat offered load' },
  { name: 'kv_cache_usage_ratio', type: 'gauge', unit: '0-1', labels: 'replica', agg: 'max and p90 across replicas', alert: '> 0.9 for 5 min (evictions next)' },
  { name: 'kv_evictions_total', type: 'counter', unit: 'blocks', labels: 'replica', agg: 'rate()', alert: 'sustained preemption' },
  { name: 'prefix_hit_tokens_total', type: 'counter', unit: 'tokens', labels: 'model', agg: 'hit tokens / prompt tokens', alert: 'hit rate drops after deploy' },
  { name: 'gpu_mem_bandwidth_util', type: 'gauge', unit: '0-1', labels: 'gpu', agg: 'mean, min across GPUs', alert: 'diagnosis only' },
  { name: 'errors_total', type: 'counter', unit: 'req', labels: 'model, code (bounded enum)', agg: 'rate()', alert: 'error-budget burn rate > 2' },
  { name: 'cost_usd_per_m_output_tokens', type: 'gauge', unit: '$', labels: 'model, pool', agg: 'GPU $ / delivered tokens, same window', alert: 'weekly review, not paging' },
];

// ---------- Q17: tail latency queue simulation ----------

export interface TailInput {
  seed: number;
  /** Base (non-retry) requests. */
  n: number;
  rps: number;
  replicas: number;
  svcMs: number;
  /** 1 = Poisson; > 1 concentrates arrivals into 20 % of 1-second windows. */
  burst: number;
  longFrac: number;
  longMult: number;
  slowFrac: number;
  slowMult: number;
  timeoutMs: number;
  retries: boolean;
  /** Full-fleet pause (GC, network blip) at 40 % of the run. */
  stallMs: number;
  /** Closed-loop benchmark users (coordinated-omission demo). */
  users: number;
}

export interface TailReq {
  latency: number;
  wait: number;
  service: number;
  gateway: number;
  network: number;
  long: boolean;
  slow: boolean;
  retried: boolean;
}

export interface TailResult {
  reqs: TailReq[];
  p50: number;
  p99: number;
  p999: number;
  mean: number;
  byCause: { cause: string; count: number; p50: number; p99: number }[];
  comps: { name: string; p99: number }[];
  compSumP99: number;
  e2eP99: number;
  closedP99: number;
  closedCount: number;
  retries: number;
  wastedMs: number;
  hist: { bin: string; lo: number; count: number }[];
  cdf: { q: number; ms: number }[];
}

interface Server { freeAt: number[]; slowCount: number; stallStart: number; stallEnd: number }

/** Serve one request on a random replica, FCFS per replica. Returns start and service. */
function serve(s: Server, u: () => number, i: TailInput, arrival: number, long: boolean) {
  const r = Math.floor(u() * i.replicas);
  const slow = r < s.slowCount;
  let start = Math.max(arrival, s.freeAt[r]);
  if (start >= s.stallStart && start < s.stallEnd) start = s.stallEnd;
  const service = i.svcMs * (long ? i.longMult : 1) * (slow ? i.slowMult : 1) * (0.7 + 0.6 * u());
  s.freeAt[r] = start + service;
  return { start, service, slow };
}

function newServer(i: TailInput, horizon: number): Server {
  const stallStart = 0.4 * horizon;
  return { freeAt: Array(i.replicas).fill(0), slowCount: Math.round(i.slowFrac * i.replicas), stallStart, stallEnd: stallStart + i.stallMs };
}

/** Open-loop arrivals (what users do) plus a closed-loop measurement of the same system. */
export function tailSim(i: TailInput): TailResult {
  const u = rng(i.seed);
  const horizon = (i.n / i.rps) * 1000;
  // Arrival generation with burst windows of 1 s; mean rate stays i.rps.
  const burstRate = i.rps * i.burst;
  const calmRate = Math.max(0.05 * i.rps, (i.rps - 0.2 * burstRate) / 0.8);
  const windowBurst: boolean[] = [];
  const isBurst = (t: number) => {
    const w = Math.floor(t / 1000);
    while (windowBurst.length <= w) windowBurst.push(i.burst > 1 && u() < 0.2);
    return windowBurst[w];
  };
  type Pending = { arrival: number; orig: number; long: boolean; retry: boolean };
  const pending: Pending[] = [];
  let t = 0;
  for (let k = 0; k < i.n; k++) {
    t += expSample(u, 1000 / (isBurst(t) ? burstRate : calmRate));
    pending.push({ arrival: t, orig: t, long: u() < i.longFrac, retry: false });
  }
  const s = newServer(i, horizon);
  const reqs: TailReq[] = [];
  let retries = 0;
  let wastedMs = 0;
  // pending is sorted by arrival; retries are inserted in order (ponytail: O(n) splice, fine for <= 10k requests).
  for (let idx = 0; idx < pending.length; idx++) {
    const p = pending[idx];
    const { start, service, slow } = serve(s, u, i, p.arrival, p.long);
    const latency = start + service - p.arrival;
    if (i.retries && !p.retry && latency > i.timeoutMs) {
      retries++;
      wastedMs += service;
      const at = p.arrival + i.timeoutMs;
      let j = idx + 1;
      while (j < pending.length && pending[j].arrival < at) j++;
      pending.splice(j, 0, { arrival: at, orig: p.orig, long: p.long, retry: true });
      continue;
    }
    const gateway = 2 + expSample(u, 3);
    const network = 5 + expSample(u, 10);
    reqs.push({
      latency: start + service - p.orig + gateway + network, wait: start - p.arrival, service, gateway, network,
      long: p.long, slow, retried: p.retry,
    });
  }

  const lat = reqs.map((r) => r.latency);
  const group = (cause: string, f: (r: TailReq) => boolean) => {
    const xs = reqs.filter(f).map((r) => r.latency);
    return { cause, count: xs.length, p50: percentile(xs, 50), p99: percentile(xs, 99) };
  };
  const comps = [
    { name: 'gateway', p99: percentile(reqs.map((r) => r.gateway), 99) },
    { name: 'queue wait', p99: percentile(reqs.map((r) => r.wait), 99) },
    { name: 'service', p99: percentile(reqs.map((r) => r.service), 99) },
    { name: 'network', p99: percentile(reqs.map((r) => r.network), 99) },
  ];

  // Closed loop: each user waits for its response before sending again, so a stall delays few samples.
  const cs = newServer(i, horizon);
  const cu = rng(i.seed + 7);
  const nextAt = Array(Math.max(1, i.users)).fill(0);
  const closed: number[] = [];
  for (;;) {
    let k = 0;
    for (let j = 1; j < nextAt.length; j++) if (nextAt[j] < nextAt[k]) k = j;
    if (nextAt[k] >= horizon) break;
    const { start, service } = serve(cs, cu, i, nextAt[k], cu() < i.longFrac);
    closed.push(start + service - nextAt[k]);
    nextAt[k] = start + service;
  }

  // Log-spaced histogram (20 bins) and 50-point CDF.
  const sorted = [...lat].sort((a, b) => a - b);
  const lo = Math.max(1, sorted[0] ?? 1);
  const hi = Math.max(lo * 1.01, sorted[sorted.length - 1] ?? 2);
  const edges = Array.from({ length: 21 }, (_, k) => lo * (hi / lo) ** (k / 20));
  const hist = edges.slice(0, 20).map((e, k) => ({
    bin: e >= 1000 ? `${(e / 1000).toFixed(1)}s` : `${Math.round(e)}`,
    lo: e,
    count: sorted.filter((x) => x >= e && (k === 19 ? x <= edges[k + 1] : x < edges[k + 1])).length,
  }));
  const cdf = Array.from({ length: 50 }, (_, k) => {
    const q = (k + 1) / 50;
    return { q: q * 100, ms: sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] };
  });

  return {
    reqs, p50: percentile(lat, 50), p99: percentile(lat, 99), p999: percentile(lat, 99.9), mean: mean(lat),
    byCause: [
      group('all', () => true),
      group('normal', (r) => !r.long && !r.slow && !r.retried),
      group('long prompt', (r) => r.long),
      group('slow replica', (r) => r.slow),
      group('retried', (r) => r.retried),
    ],
    comps, compSumP99: sum(comps.map((c) => c.p99)), e2eP99: percentile(lat, 99),
    closedP99: percentile(closed, 99), closedCount: closed.length, retries, wastedMs, hist, cdf,
  };
}

// ---------- Q18: throughput at SLO (illustrative M/M/1-style model, not engine data) ----------

export interface EngineModel {
  /** Saturation output throughput, tokens/s. */
  capacityTokS: number;
  /** TTFT with an empty queue, ms. */
  baseTtftMs: number;
}

export interface SloPoint {
  rate: number;
  offeredTokS: number;
  throughputTokS: number;
  ttftP99: number;
  attain: number;
  goodTokS: number;
  overload: boolean;
}

/**
 * Wait W has P(W > x) = rho * exp(-x / mw), mw = base / (1 - rho).
 * p99 TTFT = base + mw * ln(100 rho) when 100 rho > 1. rho >= 1 is overload: an open-loop queue grows without bound.
 */
export function sloPoint(m: EngineModel, outTokens: number, sloMs: number, rate: number): SloPoint {
  const offeredTokS = rate * outTokens;
  const rho = offeredTokS / m.capacityTokS;
  if (rho >= 1) return { rate, offeredTokS, throughputTokS: m.capacityTokS, ttftP99: Infinity, attain: 0, goodTokS: 0, overload: true };
  const mw = m.baseTtftMs / (1 - rho);
  const ttftP99 = m.baseTtftMs + (100 * rho > 1 ? mw * Math.log(100 * rho) : 0);
  const attain = sloMs < m.baseTtftMs ? 0 : 1 - rho * Math.exp(-(sloMs - m.baseTtftMs) / mw);
  return { rate, offeredTokS, throughputTokS: offeredTokS, ttftP99, attain, goodTokS: offeredTokS * attain, overload: false };
}

/** Highest arrival rate (req/s) whose p99 TTFT meets the SLO. Binary search over rho. */
export function rateAtSlo(m: EngineModel, outTokens: number, sloMs: number): number {
  if (sloMs < m.baseTtftMs) return 0;
  let lo = 0;
  let hi = (m.capacityTokS / outTokens) * 0.999999;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (sloPoint(m, outTokens, sloMs, mid).ttftP99 <= sloMs) lo = mid; else hi = mid;
  }
  return lo;
}

/** Benchmark size: every engine x config x rate x repetition is one run. */
export const matrixRuns = (engines: number, configs: number, rates: number, reps: number) => engines * configs * rates * reps;

// ---------- Q19: rollout gates ----------

/** One-sided alpha and power lookup (normal quantiles). */
export const Z_ALPHA: Record<string, number> = { '0.05': 1.6449, '0.01': 2.3263 };
export const Z_POWER: Record<string, number> = { '0.8': 0.8416, '0.9': 1.2816 };

/** Samples per arm to detect pass rate p1 -> p2 with a one-sided two-proportion z-test. */
export function sampleSizeTwoProp(p1: number, p2: number, zA: number, zB: number): number {
  const d = Math.abs(p1 - p2);
  if (d === 0) return Infinity;
  const pb = (p1 + p2) / 2;
  const n = (zA * Math.sqrt(2 * pb * (1 - pb)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / d ** 2;
  return Math.ceil(n);
}

export const STAGES = [
  { name: 'Offline eval', frac: 0, shadow: false },
  { name: 'Shadow', frac: 0, shadow: true },
  { name: 'Canary 1 %', frac: 0.01, shadow: false },
  { name: 'Canary 10 %', frac: 0.1, shadow: false },
  { name: '50 %', frac: 0.5, shadow: false },
  { name: '100 %', frac: 1, shadow: false },
];

export interface CanaryInput {
  seed: number;
  /** Baseline task pass rate. */
  baseQuality: number;
  /** True quality drop of the new version (absolute). */
  drop: number;
  baseErr: number;
  errIncrease: number;
  reqPerHour: number;
  holdHours: number;
  offlineN: number;
  shadowFrac: number;
  zA: number;
  minSamples: number;
  /** Absolute error-rate ceiling for the canary. */
  errThreshold: number;
  /** Availability SLO, e.g. 0.999. */
  sloAvail: number;
}

export type Verdict = 'pass' | 'underpowered' | 'rollback' | 'not reached';

export interface StageResult {
  name: string;
  frac: number;
  n: number;
  baseObs: number;
  canObs: number;
  z: number;
  errObs: number;
  burn: number;
  exposed: number;
  verdict: Verdict;
}

/** Simulate each stage with an injected regression; the first failing gate rolls back. */
export function canary(i: CanaryInput): { stages: StageResult[]; rollbackAt: number | null; exposedTotal: number } {
  const u = rng(i.seed);
  const pc = clamp(i.baseQuality - i.drop, 0, 1);
  const ec = clamp(i.baseErr + i.errIncrease, 0, 1);
  const obs = (p: number, n: number) => clamp(p + Math.sqrt((p * (1 - p)) / Math.max(1, n)) * gauss(u), 0, 1);
  const stages: StageResult[] = [];
  let rollbackAt: number | null = null;
  let exposedTotal = 0;
  STAGES.forEach((st, k) => {
    const n = Math.round(st.name === 'Offline eval' ? i.offlineN : st.shadow ? i.reqPerHour * i.shadowFrac * i.holdHours : i.reqPerHour * st.frac * i.holdHours);
    if (rollbackAt != null) {
      stages.push({ name: st.name, frac: st.frac, n, baseObs: NaN, canObs: NaN, z: NaN, errObs: NaN, burn: NaN, exposed: 0, verdict: 'not reached' });
      return;
    }
    // Baseline arm: the same offline set, or the rest of live traffic (capped at 50k samples).
    const nb = st.frac === 0 ? n : Math.min(50_000, Math.round(i.reqPerHour * (1 - st.frac) * i.holdHours)) || n;
    const baseObs = obs(i.baseQuality, nb);
    const canObs = obs(pc, n);
    const pool = (baseObs * nb + canObs * n) / (nb + n);
    const se = Math.sqrt(pool * (1 - pool) * (1 / nb + 1 / Math.max(1, n)));
    const z = se > 0 ? (baseObs - canObs) / se : 0;
    const errObs = obs(ec, n);
    const burn = errObs / (1 - i.sloAvail);
    const exposed = st.frac > 0 ? n : 0;
    exposedTotal += exposed;
    let verdict: Verdict = 'pass';
    if (z > i.zA || (st.frac > 0 && errObs > i.errThreshold)) verdict = 'rollback';
    else if (n < i.minSamples) verdict = 'underpowered';
    if (verdict === 'rollback') rollbackAt = k;
    stages.push({ name: st.name, frac: st.frac, n, baseObs, canObs, z, errObs, burn, exposed, verdict });
  });
  return { stages, rollbackAt, exposedTotal };
}

// ---------- Q20: autoscaling with startup lag ----------

export type ScalePolicy = 'reactive' | 'warmpool' | 'forecast';

export interface ScaleInput {
  seed: number;
  minutes: number;
  baseTokS: number;
  spikeMult: number;
  spikeAtMin: number;
  spikeLenMin: number;
  rampSec: number;
  perReplicaTokS: number;
  minReplicas: number;
  targetUtil: number;
  /** Metric scrape + alert window. */
  detectSec: number;
  /** Provision + image pull + model load + compile + warm-up. */
  startupSec: number;
  warmPool: number;
  /** Time for a pre-warmed replica to become ready. */
  warmSec: number;
  forecastLeadMin: number;
  /** Forecast peak / true peak. */
  forecastAccuracy: number;
  /** Bounded queue, in seconds of current capacity. */
  maxQueueSec: number;
  sloWaitSec: number;
  scaleDownUtil: number;
  cooldownSec: number;
  policy: ScalePolicy;
}

export interface ScalePoint {
  t: number;
  demand: number;
  capacity: number;
  queue: number;
  waitSec: number;
  replicas: number;
  pending: number;
  shed: number;
  violating: boolean;
}

export interface ScaleResult {
  points: ScalePoint[];
  violationMin: number;
  shedTokens: number;
  /** Ready + provisioning + idle warm-pool replicas, all billed. */
  replicaMinutes: number;
  peakWaitSec: number;
}

const STEP = 5;

export function demandAt(i: ScaleInput, tSec: number, noise = 0): number {
  const s0 = i.spikeAtMin * 60;
  const s1 = s0 + i.spikeLenMin * 60;
  let mult = 1;
  if (tSec >= s0 && tSec < s1) mult = 1 + (i.spikeMult - 1) * Math.min(1, (tSec - s0) / Math.max(STEP, i.rampSec));
  return Math.max(0, i.baseTokS * mult * (1 + noise));
}

export function autoscale(i: ScaleInput): ScaleResult {
  const u = rng(i.seed);
  const steps = Math.round((i.minutes * 60) / STEP);
  const per = i.perReplicaTokS;
  let ready = Math.max(i.minReplicas, Math.ceil(i.baseTokS / (per * i.targetUtil)));
  const pending: number[] = [];
  let poolAvail = i.policy === 'warmpool' ? i.warmPool : 0;
  const poolRefill: number[] = [];
  let queue = 0;
  let lowFor = 0;
  let forecastDone = false;
  const history: number[] = [];
  const points: ScalePoint[] = [];
  let violationSec = 0;
  let shedTokens = 0;
  let replicaSec = 0;
  let peakWait = 0;
  for (let k = 0; k < steps; k++) {
    const t = k * STEP;
    // Promote replicas whose startup finished.
    for (let j = pending.length - 1; j >= 0; j--) if (pending[j] <= t) { pending.splice(j, 1); ready++; }
    for (let j = poolRefill.length - 1; j >= 0; j--) if (poolRefill[j] <= t) { poolRefill.splice(j, 1); poolAvail++; }
    const demand = demandAt(i, t, 0.03 * gauss(u));
    history.push(demand);
    const cap = ready * per;
    queue = Math.max(0, queue + (demand - cap) * STEP);
    const maxQ = i.maxQueueSec * cap;
    const shed = Math.max(0, queue - maxQ);
    queue -= shed;
    shedTokens += shed;
    const waitSec = cap > 0 ? queue / cap : Infinity;
    peakWait = Math.max(peakWait, waitSec);
    const violating = waitSec > i.sloWaitSec || shed > 0;
    if (violating) violationSec += STEP;

    // Scheduled pre-scale for a forecast peak (cold start, launched lead minutes early).
    if (i.policy === 'forecast' && !forecastDone && t >= (i.spikeAtMin - i.forecastLeadMin) * 60) {
      forecastDone = true;
      const want = Math.ceil((i.baseTokS * i.spikeMult * i.forecastAccuracy) / (per * i.targetUtil));
      for (let j = ready + pending.length; j < want; j++) pending.push(t + i.startupSec);
    }
    // Reactive signal sees demand detectSec late, plus queue to drain within 60 s.
    const seen = history[Math.max(0, history.length - 1 - Math.round(i.detectSec / STEP))];
    const desired = Math.ceil((seen + queue / 60) / (per * i.targetUtil));
    let need = desired - (ready + pending.length);
    while (need > 0) {
      if (poolAvail > 0) { poolAvail--; pending.push(t + i.warmSec); poolRefill.push(t + i.startupSec); }
      else pending.push(t + i.startupSec);
      need--;
    }
    // Scale down slowly: low utilisation must persist for the cooldown (hysteresis).
    if (demand / Math.max(1, cap) < i.scaleDownUtil && pending.length === 0 && queue === 0) lowFor += STEP; else lowFor = 0;
    if (lowFor >= i.cooldownSec && ready > i.minReplicas) { ready--; lowFor = 0; }

    replicaSec += (ready + pending.length + poolAvail + poolRefill.length) * STEP;
    points.push({ t: t / 60, demand, capacity: cap, queue, waitSec, replicas: ready, pending: pending.length, shed, violating });
  }
  return { points, violationMin: violationSec / 60, shedTokens, replicaMinutes: replicaSec / 60, peakWaitSec: peakWait };
}
