import { describe, expect, it } from 'vitest';
import { Z_ALPHA, Z_POWER, autoscale, canary, matrixRuns, rateAtSlo, sampleSizeTwoProp, sloPoint, tailSim, telemetry, type ScaleInput, type TailInput, type TelemetryInput } from './g4';

const TEL: TelemetryInput = {
  seed: 16, minutes: 60, baseRps: 20, spikeAt: 30, spikeLen: 8, spikeMult: 1.6, capacityRps: 30, prefillMs: 250, itlMs: 30,
  outTokens: 300, kvCapacityReqs: 400, prefixReuse: 0.4, gpus: 16, gpuHourUsd: 3, ttftSloMs: 1500, maxQueue: 2000,
};

describe('Q16 telemetry', () => {
  it('is deterministic and internally consistent', () => {
    const a = telemetry(TEL);
    expect(telemetry(TEL)).toEqual(a);
    for (const p of a) {
      expect(p.ttftP99).toBeGreaterThanOrEqual(p.ttftP50);
      expect(p.kvOcc).toBeGreaterThanOrEqual(0);
      expect(p.kvOcc).toBeLessThanOrEqual(1);
      expect(p.queue).toBeLessThanOrEqual(TEL.maxQueue + 1e-9);
      expect(p.goodput).toBeLessThanOrEqual(p.completed + 1e-9);
    }
  });
  it('overload spike builds a queue and raises p99', () => {
    const a = telemetry(TEL);
    expect(Math.max(...a.slice(30, 38).map((p) => p.queue))).toBeGreaterThan(0);
    expect(a[37].ttftP99).toBeGreaterThan(a[10].ttftP99);
  });
});

const TAIL: TailInput = {
  seed: 17, n: 4000, rps: 40, replicas: 8, svcMs: 150, burst: 1, longFrac: 0.05, longMult: 6, slowFrac: 0, slowMult: 4,
  timeoutMs: 5000, retries: false, stallMs: 0, users: 6,
};

describe('Q17 tail latency', () => {
  it('percentiles are ordered and deterministic', () => {
    const r = tailSim(TAIL);
    expect(tailSim(TAIL).p99).toBe(r.p99);
    expect(r.p99).toBeGreaterThanOrEqual(r.p50);
    expect(r.p999).toBeGreaterThanOrEqual(r.p99);
    expect(r.reqs.length).toBe(TAIL.n);
  });
  it('summing component p99s overstates end-to-end p99', () => {
    const r = tailSim(TAIL);
    expect(r.compSumP99).toBeGreaterThan(r.e2eP99);
  });
  it('a slow replica raises p99', () => {
    expect(tailSim({ ...TAIL, slowFrac: 0.125 }).p99).toBeGreaterThan(tailSim(TAIL).p99);
  });
  it('closed-loop measurement hides a stall (coordinated omission)', () => {
    const r = tailSim({ ...TAIL, stallMs: 3000 });
    expect(r.closedP99).toBeLessThan(r.p99);
  });
  it('retries add load and are counted', () => {
    const r = tailSim({ ...TAIL, rps: 52, timeoutMs: 800, retries: true });
    expect(r.retries).toBeGreaterThan(0);
    expect(r.reqs.length).toBe(TAIL.n);
  });
});

describe('Q18 throughput at SLO', () => {
  const m = { capacityTokS: 10_000, baseTtftMs: 200 };
  it('empty system p99 equals base; overload is flagged', () => {
    expect(sloPoint(m, 250, 1000, 0).ttftP99).toBe(200);
    expect(sloPoint(m, 250, 1000, 40).overload).toBe(true);
  });
  it('rate at SLO meets the SLO and grows with capacity', () => {
    const r = rateAtSlo(m, 250, 1000);
    expect(sloPoint(m, 250, 1000, r).ttftP99).toBeLessThanOrEqual(1000 + 1e-6);
    expect(r).toBeLessThan(40);
    expect(rateAtSlo({ ...m, capacityTokS: 20_000 }, 250, 1000)).toBeGreaterThan(r);
  });
  it('matrix size multiplies', () => expect(matrixRuns(3, 2, 6, 5)).toBe(180));
});

describe('Q19 rollout gates', () => {
  it('two-proportion sample size matches hand calculation (0.90 -> 0.88)', () => {
    expect(sampleSizeTwoProp(0.9, 0.88, Z_ALPHA['0.05'], Z_POWER['0.8'])).toBeGreaterThanOrEqual(3024);
    expect(sampleSizeTwoProp(0.9, 0.88, Z_ALPHA['0.05'], Z_POWER['0.8'])).toBeLessThanOrEqual(3028);
  });
  it('a large regression rolls back and later stages are not reached', () => {
    const r = canary({ seed: 19, baseQuality: 0.9, drop: 0.08, baseErr: 0.002, errIncrease: 0, reqPerHour: 100_000, holdHours: 2, offlineN: 500, shadowFrac: 0.05, zA: 1.6449, minSamples: 3000, errThreshold: 0.01, sloAvail: 0.999 });
    expect(r.rollbackAt).not.toBeNull();
    expect(r.stages.slice((r.rollbackAt ?? 0) + 1).every((s) => s.verdict === 'not reached')).toBe(true);
  });
  it('an error spike trips the error gate on live traffic', () => {
    const r = canary({ seed: 3, baseQuality: 0.9, drop: 0, baseErr: 0.002, errIncrease: 0.05, reqPerHour: 100_000, holdHours: 2, offlineN: 500, shadowFrac: 0.05, zA: 3.5, minSamples: 100, errThreshold: 0.01, sloAvail: 0.999 });
    expect(r.rollbackAt).toBe(2);
  });
});

const SC: ScaleInput = {
  seed: 20, minutes: 40, baseTokS: 20_000, spikeMult: 3, spikeAtMin: 10, spikeLenMin: 15, rampSec: 30, perReplicaTokS: 5000,
  minReplicas: 2, targetUtil: 0.7, detectSec: 60, startupSec: 480, warmPool: 6, warmSec: 30, forecastLeadMin: 10, forecastAccuracy: 1,
  maxQueueSec: 30, sloWaitSec: 5, scaleDownUtil: 0.35, cooldownSec: 300, policy: 'reactive',
};

describe('Q20 autoscaling', () => {
  it('queue is never negative and shedding only happens above the bound', () => {
    for (const p of autoscale(SC).points) {
      expect(p.queue).toBeGreaterThanOrEqual(0);
      expect(p.queue).toBeLessThanOrEqual(30 * p.capacity + 1e-6);
    }
  });
  it('warm pool and forecast beat reactive on SLO; reactive is cheapest at idle', () => {
    const re = autoscale(SC);
    const wp = autoscale({ ...SC, policy: 'warmpool' });
    const fc = autoscale({ ...SC, policy: 'forecast' });
    expect(re.violationMin).toBeGreaterThan(0);
    expect(wp.violationMin).toBeLessThan(re.violationMin);
    expect(fc.violationMin).toBeLessThan(re.violationMin);
  });
});
