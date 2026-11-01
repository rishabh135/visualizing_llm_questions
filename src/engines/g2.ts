// Scheduling & latency engines (Q6-Q10). Pure, seeded, bounded. No React.
import { clamp, expSample, mean, percentile, rng, sum } from './core';

// ---------- Q6 / Q7: iteration-level continuous batching scheduler ----------

export type Policy = 'fcfs' | 'decode-first' | 'prefill-first' | 'aged';

export interface Req {
  id: number;
  /** Arrival time, ms. */
  arrive: number;
  prompt: number;
  output: number;
  /** Absolute cancel time, ms (client disconnect). */
  cancelAt?: number;
  long?: boolean;
}

export interface TraceOpts {
  seed: number;
  n: number;
  gapMs: number;
  promptMean: number;
  outputMean: number;
  cancelFrac: number;
  /** Extra very long prompts injected early (Q7). */
  longPrompts?: number;
  longTokens?: number;
}

/** Seeded Poisson-ish trace. Same opts → identical trace, so policies compare fairly. */
export function makeTrace(o: TraceOpts): Req[] {
  const u = rng(o.seed);
  const n = clamp(Math.round(o.n), 1, 300);
  const out: Req[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += expSample(u, Math.max(1, o.gapMs));
    const prompt = Math.max(16, Math.round(expSample(u, o.promptMean)));
    const output = Math.max(2, Math.round(expSample(u, o.outputMean)));
    // Always draw both numbers so cancelFrac never shifts the rest of the trace.
    const c = u();
    const after = expSample(u, 600);
    out.push({ id: i, arrive: t, prompt, output, cancelAt: c < o.cancelFrac ? t + after : undefined });
  }
  const longs = clamp(Math.round(o.longPrompts ?? 0), 0, 5);
  for (let k = 0; k < longs; k++) {
    out.push({ id: n + k, arrive: 5 + k * 400, prompt: Math.round(o.longTokens ?? 100_000), output: 64, long: true });
  }
  return out.sort((a, b) => a.arrive - b.arrive);
}

export interface SchedConfig {
  policy: Policy;
  /** Max tokens processed per iteration (prefill tokens + 1 per decode). */
  tokenBudget: number;
  maxSeqs: number;
  kvBlocks: number;
  blockSize: number;
  /** Max prefill tokens per request per iteration. Infinity = no chunking (whole prompt in one iteration). */
  chunk: number;
  /** 'aged' policy: waiting requests older than this jump ahead of normal decodes. */
  agingMs: number;
  /** 'aged' policy: a decode whose last token is older than this gets top priority. */
  decodeDeadlineMs: number;
  maxQueue: number;
  baseMs: number;
  decodeMsPerSeq: number;
  prefillMsPerToken: number;
}

type State = 'future' | 'waiting' | 'prefill' | 'decode' | 'done' | 'cancelled' | 'rejected';

interface St {
  r: Req;
  state: State;
  promptLeft: number;
  outLeft: number;
  blocks: number;
  firstTok?: number;
  lastTok?: number;
  gaps: number[];
  doneAt?: number;
  released: number;
}

export interface ReqResult {
  id: number;
  arrive: number;
  prompt: number;
  output: number;
  long: boolean;
  state: State;
  ttft?: number;
  doneAt?: number;
}

export interface SchedResult {
  reqs: ReqResult[];
  ttftP50: number;
  ttftP95: number;
  /** TTFT p95 for short (non-long) requests only. */
  shortTtftP95: number;
  longTtft: number;
  itlP50: number;
  itlP95: number;
  /** Output tokens per second over the makespan. */
  throughput: number;
  completed: number;
  rejected: number;
  cancelled: number;
  iterations: number;
  overheadMs: number;
  makespan: number;
  minFree: number;
  freeEnd: number;
  /** Total prefill + decode tokens processed. */
  processed: number;
  /** Jain fairness index over per-request output rate, 1 = perfectly even. */
  fairness: number;
  /** Times any request had its blocks released more than once (must stay 0). */
  doubleReleases: number;
  /** Cancelled requests that kept receiving work after their cancel time (must stay 0). */
  servedAfterCancel: number;
  gantt: { rows: { id: number; long: boolean; cells: string }[]; iters: number; iterMs: number[] };
}

const TERMINAL: State[] = ['done', 'cancelled', 'rejected'];
const MAX_ITERS = 20_000;
const GANTT_ROWS = 10;
const GANTT_ITERS = 48;

function prio(c: St, cfg: SchedConfig, now: number): number {
  const dec = c.state === 'decode';
  switch (cfg.policy) {
    case 'fcfs': return 0;
    case 'decode-first': return dec ? 0 : 1;
    case 'prefill-first': return dec ? 1 : 0;
    case 'aged':
      if (dec && now - (c.lastTok ?? now) >= cfg.decodeDeadlineMs) return 0;
      if (!dec && now - c.r.arrive >= cfg.agingMs) return 1;
      return dec ? 2 : 3;
  }
}

/** Deterministic discrete simulation. Equal inputs → equal outputs. */
export function simulate(trace: Req[], cfg: SchedConfig): SchedResult {
  const sts: St[] = trace.map((r) => ({ r, state: 'future', promptLeft: r.prompt, outLeft: r.output, blocks: 0, gaps: [], released: 0 }));
  const need = (s: St) => Math.ceil((s.r.prompt + s.r.output) / cfg.blockSize); // private full-growth reservation
  const chunked = Number.isFinite(cfg.chunk);
  const penalty = chunked ? 1 + 128 / Math.max(1, cfg.chunk) : 1; // assumed small-matmul efficiency loss
  const tracked = sts.slice(0, GANTT_ROWS);
  const ganttCells: string[] = tracked.map(() => '');
  const iterLog: number[] = [];
  let free = cfg.kvBlocks;
  let minFree = free;
  let now = 0;
  let it = 0;
  let processed = 0;
  let servedAfterCancel = 0;

  const release = (s: St) => {
    if (s.blocks > 0) { free += s.blocks; s.blocks = 0; s.released++; }
  };

  while (it < MAX_ITERS) {
    for (const s of sts) {
      if (s.state === 'future' && s.r.arrive <= now) {
        const waiting = sts.filter((x) => x.state === 'waiting').length;
        s.state = waiting >= cfg.maxQueue || need(s) > cfg.kvBlocks ? 'rejected' : 'waiting';
      }
      if (s.r.cancelAt != null && s.r.cancelAt <= now && !TERMINAL.includes(s.state) && s.state !== 'future') {
        release(s);
        s.state = 'cancelled';
      }
    }
    if (sts.every((s) => TERMINAL.includes(s.state))) break;
    const live = sts.filter((s) => s.state === 'waiting' || s.state === 'prefill' || s.state === 'decode');
    if (live.length === 0) {
      const next = Math.min(...sts.filter((s) => s.state === 'future').map((s) => s.r.arrive));
      if (!Number.isFinite(next)) break;
      now = next;
      continue;
    }
    const cands = [...live].sort((a, b) => prio(a, cfg, now) - prio(b, cfg, now) || a.r.arrive - b.r.arrive);
    let budget = cfg.tokenBudget;
    let seqs = live.filter((s) => s.state !== 'waiting').length;
    let decN = 0;
    let preTok = 0;
    let headBlocked = false;
    const served = new Map<St, 'P' | 'D'>();
    const finishedPrefill: St[] = [];

    for (const c of cands) {
      if (c.state === 'waiting') {
        if (headBlocked || seqs >= cfg.maxSeqs || need(c) > free) {
          if (cfg.policy === 'fcfs') headBlocked = true; // strict FCFS: no overtaking
          continue;
        }
        free -= need(c);
        c.blocks = need(c);
        c.state = 'prefill';
        seqs++;
      }
      if (c.state === 'decode') {
        if (budget < 1) continue;
        budget -= 1;
        decN++;
        c.outLeft--;
        served.set(c, 'D');
      } else if (c.state === 'prefill') {
        let take: number;
        if (!chunked) {
          // Unchunked: a prompt is never split. The first prefill of an iteration may exceed the budget
          // (as engines without chunking do); later ones must fit what is left.
          if (c.promptLeft > budget && preTok > 0) continue;
          take = c.promptLeft;
        } else {
          take = Math.min(cfg.chunk, c.promptLeft, budget);
          if (take <= 0) continue;
        }
        budget -= Math.min(budget, take);
        c.promptLeft -= take;
        preTok += take;
        served.set(c, 'P');
        if (c.promptLeft === 0) finishedPrefill.push(c);
      }
    }
    minFree = Math.min(minFree, free);
    const iterMs = cfg.baseMs + cfg.decodeMsPerSeq * decN + cfg.prefillMsPerToken * preTok * penalty;
    now += iterMs;
    processed += preTok + decN;

    for (const [c, kind] of served) {
      if (c.r.cancelAt != null && c.r.cancelAt < now - iterMs) servedAfterCancel++;
      if (kind === 'D') {
        c.gaps.push(now - (c.lastTok ?? now));
        c.lastTok = now;
      }
    }
    for (const c of finishedPrefill) {
      // Prefill produces the first next-token logits: no extra decode pass for token 1.
      c.firstTok = now;
      c.lastTok = now;
      c.outLeft--;
      c.state = 'decode';
    }
    for (const c of served.keys()) {
      if (c.state === 'decode' && c.outLeft <= 0) {
        c.state = 'done';
        c.doneAt = now;
        release(c);
      }
    }
    if (it < GANTT_ITERS) {
      iterLog.push(iterMs);
      tracked.forEach((s, i) => {
        const k = served.get(s);
        const ch = k ?? (s.state === 'waiting' ? 'W' : s.state === 'prefill' || s.state === 'decode' ? 'S' : s.state === 'rejected' ? 'R' : s.state === 'cancelled' ? 'X' : '.');
        ganttCells[i] += ch;
      });
    }
    it++;
  }

  const done = sts.filter((s) => s.state === 'done');
  const withTtft = sts.filter((s) => s.firstTok != null);
  const ttfts = withTtft.map((s) => s.firstTok! - s.r.arrive);
  const shortTtfts = withTtft.filter((s) => !s.r.long).map((s) => s.firstTok! - s.r.arrive);
  const longOne = withTtft.find((s) => s.r.long);
  const gaps = sts.flatMap((s) => s.gaps);
  const emitted = sum(sts.map((s) => s.r.output - Math.max(0, s.outLeft)).map((x, i) => (sts[i].firstTok != null ? x : 0)));
  const rates = done.map((s) => s.r.output / Math.max(1e-9, s.doneAt! - s.r.arrive));
  const fairness = rates.length ? sum(rates) ** 2 / (rates.length * sum(rates.map((x) => x * x))) : NaN;

  return {
    reqs: sts.map((s) => ({ id: s.r.id, arrive: s.r.arrive, prompt: s.r.prompt, output: s.r.output, long: !!s.r.long, state: s.state, ttft: s.firstTok != null ? s.firstTok - s.r.arrive : undefined, doneAt: s.doneAt })),
    ttftP50: percentile(ttfts, 50),
    ttftP95: percentile(ttfts, 95),
    shortTtftP95: percentile(shortTtfts, 95),
    longTtft: longOne ? longOne.firstTok! - longOne.r.arrive : NaN,
    itlP50: percentile(gaps, 50),
    itlP95: percentile(gaps, 95),
    throughput: now > 0 ? (emitted / now) * 1000 : 0,
    completed: done.length,
    rejected: sts.filter((s) => s.state === 'rejected').length,
    cancelled: sts.filter((s) => s.state === 'cancelled').length,
    iterations: it,
    overheadMs: it * cfg.baseMs,
    makespan: now,
    minFree,
    freeEnd: free,
    processed,
    fairness,
    doubleReleases: sts.filter((s) => s.released > 1).length,
    servedAfterCancel,
    gantt: { rows: tracked.map((s, i) => ({ id: s.r.id, long: !!s.r.long, cells: ganttCells[i] })), iters: Math.min(it, GANTT_ITERS), iterMs: iterLog },
  };
}

// ---------- Q8: prefix-aware routing across replicas ----------

export type Route = 'random' | 'affinity' | 'load-aware';

export interface RouterOpts {
  seed: number;
  n: number;
  gapMs: number;
  replicas: number;
  /** Tokens in shared prefix A and B. */
  prefixA: number;
  prefixB: number;
  /** Fraction of requests that carry a shared prefix. */
  prefixedFrac: number;
  /** Of prefixed requests, fraction using prefix A (skew). */
  hotShare: number;
  suffixMean: number;
  prefillMsPerTok: number;
  decodeMs: number;
  /** Prefixes a replica can keep cached (LRU). */
  cacheSlots: number;
}

export interface RouterResult {
  policy: Route;
  tokenHitRate: number;
  p50: number;
  p95: number;
  imbalance: number;
  perReplica: { reqs: number; busyMs: number; cached: number[] }[];
}

interface RReq { arrive: number; prefix: number; suffix: number }

export function routerTrace(o: RouterOpts): RReq[] {
  const u = rng(o.seed);
  const out: RReq[] = [];
  let t = 0;
  for (let i = 0; i < clamp(o.n, 1, 500); i++) {
    t += expSample(u, Math.max(1, o.gapMs));
    const pre = u() < o.prefixedFrac;
    const hot = u() < o.hotShare;
    out.push({ arrive: t, prefix: pre ? (hot ? 0 : 1) : -1, suffix: Math.max(8, Math.round(expSample(u, o.suffixMean))) });
  }
  return out;
}

/** Single-server FIFO per replica; cache state is exact at routing time (no stale directory). */
export function route(o: RouterOpts, policy: Route): RouterResult {
  const trace = routerTrace(o);
  const pick = rng(o.seed ^ 0x9e3779b9); // separate stream so the trace is identical across policies
  const R = clamp(Math.round(o.replicas), 1, 8);
  const reps = Array.from({ length: R }, () => ({ busyUntil: 0, cache: [] as number[], reqs: 0, busyMs: 0 }));
  const pTok = (p: number) => (p === 0 ? o.prefixA : p === 1 ? o.prefixB : 0);
  const service = (r: RReq, hit: boolean) => (r.suffix + (hit ? 0 : pTok(r.prefix))) * o.prefillMsPerTok + o.decodeMs;
  let total = 0;
  let cached = 0;
  const lat: number[] = [];
  for (const r of trace) {
    const hitOn = (k: number) => r.prefix >= 0 && reps[k].cache.includes(r.prefix);
    const leastLoaded = () => reps.reduce((b, x, k) => (x.busyUntil < reps[b].busyUntil ? k : b), 0);
    let k: number;
    if (policy === 'random') k = Math.floor(pick() * R);
    else if (policy === 'affinity') k = r.prefix >= 0 ? r.prefix % R : leastLoaded();
    else {
      k = 0;
      let best = Infinity;
      reps.forEach((x, j) => {
        const est = Math.max(0, x.busyUntil - r.arrive) + service(r, hitOn(j));
        if (est < best) { best = est; k = j; }
      });
    }
    const hit = hitOn(k);
    const rep = reps[k];
    const svc = service(r, hit);
    const start = Math.max(r.arrive, rep.busyUntil);
    rep.busyUntil = start + svc;
    rep.busyMs += svc;
    rep.reqs++;
    lat.push(rep.busyUntil - r.arrive);
    total += r.suffix + pTok(r.prefix);
    if (hit) cached += pTok(r.prefix);
    if (r.prefix >= 0) {
      rep.cache = [r.prefix, ...rep.cache.filter((p) => p !== r.prefix)].slice(0, Math.max(0, o.cacheSlots));
    }
  }
  const busy = reps.map((x) => x.busyMs);
  return {
    policy,
    tokenHitRate: total ? cached / total : 0,
    p50: percentile(lat, 50),
    p95: percentile(lat, 95),
    imbalance: mean(busy) > 0 ? Math.max(...busy) / mean(busy) : 1,
    perReplica: reps.map((x) => ({ reqs: x.reqs, busyMs: x.busyMs, cached: x.cache })),
  };
}

/** Wait for a warm replica vs recompute the prefix on a cold one. */
export function warmVsCold(waitWarmMs: number, waitColdMs: number, prefixTok: number, suffixTok: number, msPerTok: number) {
  const warm = waitWarmMs + suffixTok * msPerTok;
  const cold = waitColdMs + (prefixTok + suffixTok) * msPerTok;
  return { warm, cold, breakEvenWarmWait: waitColdMs + prefixTok * msPerTok, pickWarm: warm <= cold };
}

// ---------- Q9: inter-token latency vs throughput ----------

export interface DecodeHw {
  fixedMs: number;
  perSeqMs: number;
  /** Weight bytes per GPU, decimal GB. */
  weightGB: number;
  /** KV bytes per token per GPU, KiB. */
  kvKiB: number;
  ctx: number;
  /** Effective HBM bandwidth, decimal TB/s. */
  bwTBs: number;
  /** Dense peak, TFLOPS, and achieved fraction. */
  tflops: number;
  eff: number;
  /** Parameters per GPU, billions (2 FLOPs per parameter per token). */
  paramsB: number;
}

/** One decode step for batch B: fixed + per-seq + roofline max(memory, compute). */
export function stepMs(h: DecodeHw, B: number) {
  const memMs = ((h.weightGB * 1e9 + B * h.ctx * h.kvKiB * 1024) / (h.bwTBs * 1e12)) * 1000;
  const compMs = ((2 * h.paramsB * 1e9 * B) / (h.tflops * 1e12 * h.eff)) * 1000;
  return { total: h.fixedMs + h.perSeqMs * B + Math.max(memMs, compMs), memMs, compMs, bound: memMs >= compMs ? 'memory' : 'compute' };
}

export const BATCHES = [1, 2, 4, 8, 16, 32, 48, 64, 96, 128, 192, 256];

export function frontier(h: DecodeHw) {
  return BATCHES.map((B) => {
    const s = stepMs(h, B);
    return { B, itl: s.total, perUser: 1000 / s.total, aggregate: (B * 1000) / s.total, bound: s.bound };
  });
}

/** Largest batch whose mean model ITL meets the SLO, or 0. */
export function maxBatchUnderSlo(h: DecodeHw, sloMs: number, extraMs = 0) {
  let best = 0;
  for (const B of BATCHES) if (stepMs(h, B).total + extraMs <= sloMs) best = B;
  return best;
}

export interface Transport {
  /** Fraction of decode steps that also carry a prefill chunk. */
  prefillShare: number;
  prefillChunkMs: number;
  flushMs: number;
  proxyBufferMs: number;
  renderMs: number;
}

/** Client-visible token gap: mean and an approximate worst-case gap. */
export function gapBreakdown(h: DecodeHw, B: number, t: Transport) {
  const model = stepMs(h, B).total;
  const parts = [
    { name: 'Model decode step', ms: model },
    { name: 'Prefill interference (mean)', ms: t.prefillShare * t.prefillChunkMs },
    { name: 'Server flush (mean wait)', ms: t.flushMs / 2 },
    { name: 'Proxy buffering', ms: t.proxyBufferMs },
    { name: 'Client render', ms: t.renderMs },
  ];
  return { parts, mean: sum(parts.map((p) => p.ms)), worst: model + t.prefillChunkMs + t.flushMs + t.proxyBufferMs + t.renderMs };
}

// ---------- Q10: speculative decoding ----------

/** Expected emitted target tokens per round: sum_{i=0..k} a^i (sequential accept, constant a, one bonus/correction). */
export const expectedEmitted = (a: number, k: number) => (a >= 1 ? k + 1 : (1 - a ** (k + 1)) / (1 - a));

export interface SpecIn {
  a: number;
  k: number;
  draftMs: number;
  targetMs: number;
  overheadMs: number;
  /** Extra verify cost per draft token as a fraction of one target step: ~0 idle (memory-bound), ~1 saturated. */
  sat: number;
}

export function specRound(i: SpecIn) {
  const E = expectedEmitted(i.a, i.k);
  const verifyMs = i.targetMs * (1 + i.sat * i.k);
  const roundMs = i.k * i.draftMs + verifyMs + i.overheadMs;
  const tps = (E / roundMs) * 1000;
  const base = 1000 / i.targetMs;
  return { E, verifyMs, roundMs, tps, base, speedup: tps / base };
}

export function bestK(i: SpecIn, kMax = 12) {
  let k = 1;
  let s = -Infinity;
  for (let j = 1; j <= kMax; j++) {
    const v = specRound({ ...i, k: j }).speedup;
    if (v > s) { s = v; k = j; }
  }
  return { k, speedup: s };
}

/** One seeded round: accept each draft token with probability a until the first rejection. */
export function sampleRound(seed: number, a: number, k: number) {
  const u = rng(seed);
  const toks: ('accept' | 'reject' | 'correct' | 'bonus')[] = [];
  let accepted = 0;
  for (let i = 0; i < k; i++) {
    if (u() < a) { toks.push('accept'); accepted++; } else { toks.push('reject'); break; }
  }
  toks.push(accepted === k ? 'bonus' : 'correct');
  return { toks, accepted, emitted: accepted + 1 };
}
