import { describe, expect, it } from 'vitest';
import {
  GPUS, batchFor, classify, deploy, e2m1Round, e4m3Round, effectiveBits, fp8Grid, layernorm, normTraffic, pipeline, quantize,
  replicaCap, ridge, rmsnorm, synthTrace, traceSummary,
} from './g3';

const TOY = [0.02, -0.7, 1.4, 12];

describe('Q11 quantization', () => {
  it('E4M3 rounds to the representable grid and saturates at 448', () => {
    expect(e4m3Round(448)).toBe(448);
    expect(e4m3Round(1000)).toBe(448);
    expect(e4m3Round(1.1)).toBe(1.125);
    expect(e4m3Round(2 ** -9)).toBe(2 ** -9);
    expect(fp8Grid().every((v) => e4m3Round(v) === v)).toBe(true);
    expect(Math.max(...fp8Grid())).toBe(448);
  });
  it('E2M1 snaps to {0, .5, 1, 1.5, 2, 3, 4, 6}', () => {
    expect(e2m1Round(2.6)).toBe(3);
    expect(e2m1Round(5.5)).toBe(6);
    expect(e2m1Round(-0.3)).toBe(-0.5);
    expect(e2m1Round(9)).toBe(6);
  });
  it('per-tensor INT8 loses the small value next to the outlier', () => {
    const r = quantize(TOY, 'int8');
    expect(r.deq[0]).toBe(0);
    expect(r.relErr[0]).toBe(1);
    expect(r.deq[3]).toBeCloseTo(12, 10);
  });
  it('INT4 per-group isolates the outlier', () => {
    const t = quantize(TOY, 'int4');
    const g = quantize(TOY, 'int4g', 1, 2);
    expect(t.deq[1]).toBe(0); // -0.7 vanishes per-tensor
    expect(g.deq[1]).toBeCloseTo(-0.7, 10);
    expect(g.mse).toBeLessThan(t.mse);
  });
  it('FP8 keeps relative precision across magnitudes', () => {
    const r = quantize(TOY, 'fp8');
    expect(Math.max(...r.relErr)).toBeLessThan(0.07);
  });
  it('NVFP4 toy block: FP32 tensor scale + E4M3 block scale 2 → [0, -1, 1, 12]', () => {
    const r = quantize(TOY, 'nvfp4');
    expect(r.scales[0]).toBeCloseTo(2, 10);
    expect(r.deq.map((v) => +v.toFixed(6))).toEqual([0, -1, 1, 12]);
  });
  it('effective bits include scale metadata', () => {
    expect(effectiveBits('nvfp4', 1e9)).toBeCloseTo(4.5, 6);
    expect(effectiveBits('int4g', 1e9, 128, 16)).toBe(4.125);
    expect(effectiveBits('int8', 4)).toBe(16); // tiny tensors: the scale dominates
  });
});

describe('Q12 GPU choice', () => {
  it('ridge points follow peak / bandwidth', () => {
    const h100 = GPUS.find((g) => g.id === 'h100')!;
    expect(ridge(h100.bf16, h100.bwTBs)).toBeCloseTo(295.4, 1);
  });
  it('70B BF16 batch 1 decode is memory bound and tp is a power of two', () => {
    const d = deploy(GPUS[0], { paramsB: 70, wBytes: 2, kvKiBPerToken: 320, batch: 1, ctxTokens: 4096, usableFrac: 0.9, mbu: 1, mfu: 1, price: 2 });
    expect(d.bound).toBe('memory');
    expect(d.tp).toBe(2);
    expect(Math.log2(d.tp) % 1).toBe(0);
    // weights + KV read once per step at 2 × 3.35 TB/s
    expect(d.memMs).toBeCloseTo((d.needBytes / (2 * 3.35e12)) * 1e3, 6);
  });
});

describe('Q13 profiling', () => {
  it('classifies decode-like work as memory bound', () => {
    const c = classify({ gflop: 140, gbytes: 140, kernels: 200, launchUs: 5, measuredMs: 50, peakTflops: 989.5, bwTBs: 3.35 });
    expect(c.bound).toBe('memory-bandwidth-bound');
    expect(c.ai).toBe(1);
    expect(c.memMs).toBeCloseTo(41.79, 2);
  });
  it('classifies tiny kernels as launch bound', () => {
    expect(classify({ gflop: 0.01, gbytes: 0.01, kernels: 500, launchUs: 6, measuredMs: 3.2, peakTflops: 989.5, bwTBs: 3.35 }).bound).toBe('launch-overhead-bound');
  });
  it('trace: launches slower than kernels leave GPU gaps', () => {
    const s = traceSummary(synthTrace(20, 5, 10, 0, 0, 0.8));
    expect(s.busyFrac).toBeCloseTo(100 / 205, 3);
  });
});

describe('Q14 pipeline', () => {
  it('healthy cluster: GPU is the tightest stage and serves the demand', () => {
    const r = pipeline({ lambda: 30, outTokens: 256, replicas: 4, faults: [] });
    expect(r.bottleneck).toBe('GPU decode');
    expect(r.delivered).toBeCloseTo(30, 6);
    expect(r.stages.every((s) => s.queueGrowth === 0)).toBe(true);
  });
  it('tokenizer saturation starves the GPUs: low useful work despite heavy traffic', () => {
    const r = pipeline({ lambda: 60, outTokens: 256, replicas: 4, faults: ['tokenizer'] });
    expect(r.bottleneck).toBe('Tokenizer');
    expect(r.delivered).toBe(15);
    expect(r.usefulWork).toBeLessThan(0.4);
    expect(r.stages[1].queueGrowth).toBe(45);
  });
  it('batchFor inverts the step model', () => {
    const b = batchFor(7.5, 256, 0, 256);
    expect((b / (25 + 0.25 * b)) * 1000 / 256).toBeCloseTo(7.5, 6);
    expect(replicaCap(256, 0, 256)).toBeCloseTo(11.236, 3);
  });
});

describe('Q15 RMSNorm', () => {
  it('x = [1,2,3,4] reference', () => {
    const y = rmsnorm([1, 2, 3, 4], [1, 1, 1, 1], 1e-6);
    const r = 1 / Math.sqrt(7.5 + 1e-6);
    expect(y[0]).toBeCloseTo(r, 12);
    expect(y[3]).toBeCloseTo(4 * r, 12);
    expect(y[0]).toBeCloseTo(0.365148, 6);
  });
  it('LayerNorm subtracts the mean; RMSNorm does not', () => {
    const ln = layernorm([1, 2, 3, 4], [1, 1, 1, 1], [0, 0, 0, 0]);
    expect(ln.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 9);
    expect(rmsnorm([1, 2, 3, 4], [1, 1, 1, 1]).reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
  });
  it('large tensors: fused vs eager traffic bound approaches 7/2', () => {
    const t = normTraffic({ rows: 65536, hidden: 8192, bytes: 2, bwTBs: 3.35, eff: 0.8, launchUs: 5, baseline: 'eager' });
    expect(t.speedup).toBeGreaterThan(3.4);
    expect(t.speedup).toBeLessThan(3.6); // slightly above 7/2: 5 extra launches + per-row reductions
    const c = normTraffic({ rows: 65536, hidden: 8192, bytes: 2, bwTBs: 3.35, eff: 0.8, launchUs: 5, baseline: 'compiled' });
    expect(c.speedup).toBeCloseTo(1, 9);
  });
});

describe('Q11-Q15 content and simulators', () => {
  it('every lesson has 5 scenes totalling 60-120 s and full template fields', async () => {
    const { lessons } = await import('../content/g3');
    expect(lessons.map((l) => l.id)).toEqual([11, 12, 13, 14, 15]);
    for (const l of lessons) {
      const total = l.scenes.reduce((a, s) => a + s.duration, 0);
      expect(l.scenes).toHaveLength(5);
      expect(total).toBeGreaterThanOrEqual(60);
      expect(total).toBeLessThanOrEqual(120);
      expect(l.pitfalls.length).toBeGreaterThanOrEqual(3);
      expect(l.optimizations.length).toBeGreaterThanOrEqual(3);
      expect(l.interview.followups.length).toBeGreaterThanOrEqual(3);
      const words = l.interview.short.split(/\s+/).length;
      expect(words).toBeGreaterThanOrEqual(140);
      expect(words).toBeLessThanOrEqual(230);
    }
  });
  it('all five simulators render on the server without throwing', async () => {
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { sims } = await import('../sims/g3');
    for (const id of [11, 12, 13, 14, 15]) expect(renderToString(createElement(sims[id])).length).toBeGreaterThan(500);
  });
});
