import { describe, expect, it } from 'vitest';
import { capacity, capSensitivity, costPlan, disagg, disaggBreakEven, moeActiveB, moeParallel, moeToy, runFair, type CapInput, type FairInput } from './g5';

const fairBase: FairInput = {
  capacity: 1000, ticks: 300, seed: 7, quantum: 100,
  tenants: [
    { name: 'A', weight: 1, meanTokens: 200, rate: 3, rateLimit: 99, queueCap: 10_000 },
    { name: 'B', weight: 1, meanTokens: 2000, rate: 1, rateLimit: 99, queueCap: 10_000 },
    { name: 'C', weight: 2, meanTokens: 400, rate: 3, rateLimit: 99, queueCap: 10_000 },
  ],
};

describe('Q21 fair scheduling', () => {
  for (const policy of ['fcfs', 'rr', 'drr'] as const) {
    it(`${policy}: work conserving and work balances`, () => {
      const r = runFair(fairBase, policy);
      expect(r.idleWithBacklog).toBe(0);
      expect(r.servedTotal + r.backlogEnd).toBe(r.admittedWork);
      expect(r.servedTotal).toBeLessThanOrEqual(fairBase.capacity * fairBase.ticks);
    });
  }
  it('DRR shares follow weights 1:1:2 when every tenant is backlogged', () => {
    const r = runFair(fairBase, 'drr');
    const [a, b, c] = r.tenants.map((t) => t.share);
    expect(a).toBeCloseTo(0.25, 1);
    expect(b).toBeCloseTo(0.25, 1);
    expect(c).toBeCloseTo(0.5, 1);
  });
  it('request round robin favours the tenant with long requests', () => {
    const r = runFair(fairBase, 'rr');
    expect(r.tenants[1].share).toBeGreaterThan(0.4);
  });
  it('bounded queues reject instead of growing', () => {
    const r = runFair({ ...fairBase, tenants: fairBase.tenants.map((t) => ({ ...t, queueCap: 5 })) }, 'drr');
    expect(r.tenants.some((t) => t.rejected > 0)).toBe(true);
  });
  it('same seed gives same result', () => {
    expect(runFair(fairBase, 'drr')).toEqual(runFair(fairBase, 'drr'));
  });
});

describe('Q22 disaggregation', () => {
  const base = { promptTokens: 8192, outputTokens: 512, kvBytes: 2, linkGBps: 50, concurrentTransfers: 1, setupMs: 2, overlap: 0.8, prefillTps: 20_000, itlMs: 30, interference: 0.3 };
  it('KV bytes come from cached tokens x 320 KiB', () => {
    expect(disagg(base).kvBytes).toBe(8192 * 327_680);
  });
  it('transfer time = bytes / bandwidth, overlap capped by prefill time', () => {
    const r = disagg({ ...base, overlap: 0 });
    expect(r.rawTransferMs).toBeCloseTo((8192 * 327_680) / 50e9 * 1000, 6);
    expect(r.exposedTransferMs).toBeCloseTo(2 + r.rawTransferMs, 6);
    const full = disagg({ ...base, overlap: 1, linkGBps: 1 });
    expect(full.exposedTransferMs).toBeCloseTo(2 + full.rawTransferMs - full.prefillMs, 6);
  });
  it('wins with long outputs and interference, loses on slow link + short output', () => {
    expect(disagg(base).deltaMs).toBeLessThan(0);
    expect(disagg({ ...base, promptTokens: 32768, outputTokens: 16, linkGBps: 5, interference: 0.05 }).deltaMs).toBeGreaterThan(0);
  });
  it('break-even shrinks as the link gets contended', () => {
    const a = disaggBreakEven({ ...base, outputTokens: 64, interference: 0.1 });
    const b = disaggBreakEven({ ...base, outputTokens: 64, interference: 0.1, concurrentTransfers: 8 });
    expect(b).toBeLessThan(a);
  });
});

describe('Q23 MoE', () => {
  const toy = { tokens: 8, experts: 4, topK: 2, devices: 2, skew: 0, capacityFactor: 2, seed: 3, dModel: 4096, actBytes: 2 };
  it('every token gets exactly topK assignments and no expert exceeds capacity', () => {
    const r = moeToy(toy);
    expect(r.assigns.length).toBe(16);
    expect(Math.max(...r.load)).toBeLessThanOrEqual(r.capacity);
    expect(r.load.reduce((a, b) => a + b, 0) + r.dropped).toBe(16);
  });
  it('skew + tight capacity drops tokens', () => {
    const r = moeToy({ ...toy, skew: 5, capacityFactor: 1 });
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.load[0]).toBe(r.capacity);
  });
  it('active params are shared + k/E of experts', () => {
    expect(moeActiveB({ sharedB: 2, expertsB: 40, experts: 8, topK: 2 })).toBe(12);
  });
  it('EP holds shared params on every device; hybrid splits them', () => {
    const rows = moeParallel({ sharedB: 2, expertsB: 40, experts: 8, topK: 2, devices: 8, tokensPerStep: 4096, dModel: 4096, actBytes: 2, weightBytes: 2, microbatches: 8, layers: 32, imbalance: 1 });
    expect(rows[2].memGiB).toBeGreaterThan(rows[3].memGiB);
    expect(rows[1].bubble).toBeCloseTo(7 / 15, 6);
  });
});

describe('Q24 cost', () => {
  const ivs = [
    { name: 'a', saving: 0.5, share: 1, enabled: true, risk: 'low' as const },
    { name: 'b', saving: 0.5, share: 1, enabled: true, risk: 'low' as const },
  ];
  it('savings combine multiplicatively, additive double counts', () => {
    const r = costPlan({ gpuHourUsd: 4, gpus: 8, outputTps: 2000, overhead: 0, utilization: 0.6, interventions: ivs });
    expect(r.reduction).toBeCloseTo(0.75, 9);
    expect(r.additiveReduction).toBeCloseTo(1, 9);
    expect(r.baselinePerM).toBeCloseTo((32 / 7_200_000) * 1e6, 9);
    expect(r.meetsTarget).toBe(true);
  });
  it('waterfall steps reconcile to final cost', () => {
    const r = costPlan({ gpuHourUsd: 4, gpus: 8, outputTps: 2000, overhead: 0.1, utilization: 0.6, interventions: ivs });
    const drops = r.steps.reduce((a, s) => a + s.drop, 0);
    expect(r.baselinePerM - drops).toBeCloseTo(r.finalPerM, 9);
    expect(r.breakdown.reduce((a, b) => a + b.perM, 0)).toBeCloseTo(r.baselinePerM, 9);
  });
});

describe('Q25 capacity', () => {
  const c: CapInput = {
    dau: 1_000_000, reqPerUserDay: 10, peakFactor: 3, promptTokens: 1500, outputTokens: 400, ttftS: 0.8, itlMs: 40,
    outTpsPerGpu: 1500, prefillTpsPerGpu: 10_000, tp: 8, gpuGB: 80, reserveGiB: 6, paramsB: 70, weightBytes: 2, kvBytes: 2,
    headroom: 0.2, regions: 2, spares: 1, gpuHourUsd: 2.5,
  };
  it('RPS, token rates and Little\'s law', () => {
    const r = capacity(c);
    expect(r.avgRps).toBeCloseTo(10e6 / 86_400, 9);
    expect(r.peakRps).toBeCloseTo(3 * 10e6 / 86_400, 9);
    expect(r.outTps).toBeCloseTo(r.peakRps * 400, 9);
    expect(r.e2eS).toBeCloseTo(0.8 + 399 * 0.04, 9);
    expect(r.concurrency).toBeCloseTo(r.peakRps * r.e2eS, 9);
  });
  it('GPU count is a multiple of TP and covers both bounds', () => {
    const r = capacity(c);
    expect(r.gpus % 8).toBe(0);
    expect(r.gpus / 8).toBeGreaterThanOrEqual(Math.max(r.groupsMem, r.groupsThroughput));
  });
  it('sensitivity sorted widest first', () => {
    const s = capSensitivity(c);
    for (let i = 1; i < s.length; i++) expect(s[i - 1].width).toBeGreaterThanOrEqual(s[i].width);
  });
});
