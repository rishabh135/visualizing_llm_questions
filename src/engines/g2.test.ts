import { describe, expect, it } from 'vitest';
import { sum } from './core';
import {
  bestK, expectedEmitted, frontier, gapBreakdown, makeTrace, maxBatchUnderSlo, route, sampleRound, simulate, specRound, stepMs, warmVsCold,
  type DecodeHw, type Policy, type RouterOpts, type SchedConfig, type TraceOpts,
} from './g2';

const T: TraceOpts = { seed: 7, n: 60, gapMs: 40, promptMean: 400, outputMean: 120, cancelFrac: 0 };
const CFG: SchedConfig = {
  policy: 'decode-first', tokenBudget: 2048, maxSeqs: 32, kvBlocks: 2000, blockSize: 16, chunk: 512,
  agingMs: 500, decodeDeadlineMs: 80, maxQueue: 200, baseMs: 15, decodeMsPerSeq: 0.3, prefillMsPerToken: 0.05,
};
const POLICIES: Policy[] = ['fcfs', 'decode-first', 'prefill-first', 'aged'];

describe('Q6 scheduler', () => {
  it('same seed → identical trace', () => {
    expect(makeTrace(T)).toEqual(makeTrace(T));
  });
  it('finite load completes and conserves work for every policy', () => {
    const trace = makeTrace(T);
    const work = sum(trace.map((r) => r.prompt + r.output - 1)); // first token comes from prefill
    for (const policy of POLICIES) {
      const r = simulate(trace, { ...CFG, policy });
      expect(r.completed).toBe(trace.length);
      expect(r.processed).toBe(work);
      expect(r.minFree).toBeGreaterThanOrEqual(0);
      expect(r.freeEnd).toBe(CFG.kvBlocks);
      expect(r.doubleReleases).toBe(0);
    }
  });
  it('cancelled requests stop, release blocks once, and are never served after cancel', () => {
    const trace = makeTrace({ ...T, cancelFrac: 0.4 });
    const r = simulate(trace, CFG);
    expect(r.cancelled).toBeGreaterThan(0);
    expect(r.completed + r.cancelled + r.rejected).toBe(trace.length);
    expect(r.servedAfterCancel).toBe(0);
    expect(r.doubleReleases).toBe(0);
    expect(r.freeEnd).toBe(CFG.kvBlocks);
  });
  it('bounded queue and KV capacity reject instead of growing forever', () => {
    const trace = makeTrace({ ...T, gapMs: 2 });
    const r = simulate(trace, { ...CFG, maxQueue: 5, kvBlocks: 200 });
    expect(r.rejected).toBeGreaterThan(0);
    expect(r.minFree).toBeGreaterThanOrEqual(0);
  });
});

describe('Q7 chunked prefill', () => {
  it('chunking cuts short-request TTFT p95 behind a 100K prompt', () => {
    const trace = makeTrace({ ...T, n: 50, gapMs: 60, promptMean: 300, outputMean: 100, longPrompts: 1, longTokens: 100_000 });
    const none = simulate(trace, { ...CFG, maxSeqs: 64, kvBlocks: 24_000, chunk: Infinity });
    const chunk = simulate(trace, { ...CFG, maxSeqs: 64, kvBlocks: 24_000, chunk: 512 });
    expect(none.rejected + chunk.rejected).toBe(0);
    expect(none.shortTtftP95).toBeGreaterThan(4 * chunk.shortTtftP95);
    expect(chunk.shortTtftP95).toBeLessThan(none.shortTtftP95);
    expect(chunk.longTtft).toBeGreaterThanOrEqual(none.longTtft * 0.9);
    expect(chunk.processed).toBe(none.processed);
  });
});

describe('Q8 router', () => {
  const O: RouterOpts = { seed: 3, n: 120, gapMs: 60, replicas: 3, prefixA: 4000, prefixB: 6000, prefixedFrac: 0.8, hotShare: 0.5, suffixMean: 300, prefillMsPerTok: 0.02, decodeMs: 60, cacheSlots: 1 };
  it('hit rate is a fraction; affinity and load-aware beat random on hits', () => {
    const rnd = route(O, 'random');
    const aff = route(O, 'affinity');
    const la = route(O, 'load-aware');
    for (const r of [rnd, aff, la]) {
      expect(r.tokenHitRate).toBeGreaterThanOrEqual(0);
      expect(r.tokenHitRate).toBeLessThanOrEqual(1);
      expect(sum(r.perReplica.map((x) => x.reqs))).toBe(O.n);
    }
    expect(aff.tokenHitRate).toBeGreaterThan(rnd.tokenHitRate);
    expect(la.tokenHitRate).toBeGreaterThan(rnd.tokenHitRate);
  });
  it('hot skew overloads pure affinity', () => {
    const hot = { ...O, hotShare: 0.95, gapMs: 45 };
    expect(route(hot, 'affinity').imbalance).toBeGreaterThan(route(hot, 'load-aware').imbalance);
  });
  it('warm vs cold break-even', () => {
    const w = warmVsCold(100, 0, 4000, 200, 0.05);
    expect(w.breakEvenWarmWait).toBe(200);
    expect(w.pickWarm).toBe(true);
    expect(warmVsCold(300, 0, 4000, 200, 0.05).pickWarm).toBe(false);
  });
});

describe('Q9 ITL model', () => {
  const H: DecodeHw = { fixedMs: 4, perSeqMs: 0.02, weightGB: 17.5, kvKiB: 40, ctx: 4096, bwTBs: 3.35, tflops: 989, eff: 0.5, paramsB: 8.75 };
  it('step time grows with batch while aggregate throughput rises', () => {
    const f = frontier(H);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].itl).toBeGreaterThan(f[i - 1].itl);
      expect(f[i].aggregate).toBeGreaterThan(f[i - 1].aggregate);
    }
  });
  it('B=1 is memory-bound: weights / bandwidth dominates', () => {
    const s = stepMs(H, 1);
    expect(s.bound).toBe('memory');
    expect(s.memMs).toBeCloseTo((17.5e9 + 4096 * 40 * 1024) / 3.35e12 * 1000, 6);
  });
  it('SLO cap and breakdown add up', () => {
    expect(maxBatchUnderSlo(H, 1)).toBe(0);
    expect(maxBatchUnderSlo(H, 1e6)).toBe(256);
    const g = gapBreakdown(H, 32, { prefillShare: 0.2, prefillChunkMs: 30, flushMs: 50, proxyBufferMs: 0, renderMs: 2 });
    expect(g.mean).toBeCloseTo(sum(g.parts.map((p) => p.ms)), 9);
    expect(g.worst).toBeGreaterThan(g.mean);
  });
});

describe('Q10 speculative decoding', () => {
  it('boundary cases of expected emitted tokens', () => {
    expect(expectedEmitted(0, 4)).toBe(1);
    expect(expectedEmitted(1, 4)).toBe(5);
    expect(expectedEmitted(0.999999, 4)).toBeCloseTo(5, 4);
    expect(expectedEmitted(0.7, 4)).toBeCloseTo((1 - 0.7 ** 5) / 0.3, 12);
  });
  it('worked example: a=0.7, k=4, draft 3 ms, target 30 ms → ≈1.51×', () => {
    const r = specRound({ a: 0.7, k: 4, draftMs: 3, targetMs: 30, overheadMs: 1, sat: 0.1 });
    expect(r.roundMs).toBeCloseTo(55, 9);
    expect(r.speedup).toBeCloseTo(1.5126, 3);
  });
  it('low acceptance + saturated verifier is slower than baseline', () => {
    expect(specRound({ a: 0.3, k: 6, draftMs: 5, targetMs: 30, overheadMs: 1, sat: 1 }).speedup).toBeLessThan(1);
    expect(bestK({ a: 0.9, k: 1, draftMs: 2, targetMs: 30, overheadMs: 1, sat: 0.05 }).k).toBeGreaterThan(3);
  });
  it('sampled round is deterministic and well-formed', () => {
    const a = sampleRound(42, 0.7, 5);
    expect(sampleRound(42, 0.7, 5)).toEqual(a);
    expect(a.toks.at(-1)).toMatch(/bonus|correct/);
    expect(sampleRound(1, 1, 5).toks).toEqual(['accept', 'accept', 'accept', 'accept', 'accept', 'bonus']);
    expect(sampleRound(1, 0, 5).toks).toEqual(['reject', 'correct']);
  });
});
