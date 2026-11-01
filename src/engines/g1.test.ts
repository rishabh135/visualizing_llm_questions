import { describe, expect, it } from 'vitest';
import { GiB, KiB } from './core';
import {
  LLAMA70B, SseParser, applyOp, attentionNoMax, attentionRef, attentionTraffic, checkInvariants, kvBlocks, kvBlocksShared,
  kvBytesPerToken, kvPlan, kvRawBytes, kvShardFraction, makeRelease, naiveDecode, newAllocator, onlineAttention, parseChunked,
  runOps, simulateCancel, ttftSpans, wasteCompare, type AllocOp,
} from './g1';

describe('Q3 KV anchor', () => {
  it('320 KiB per token for the assumed 70B BF16 config', () => {
    expect(kvBytesPerToken(LLAMA70B)).toBe(327_680);
    expect(kvBytesPerToken(LLAMA70B) / KiB).toBe(320);
  });
  it('100 x 32K = 1,000 GiB raw; FP8 500; 4-bit 250', () => {
    const t = Array(100).fill(32_768);
    expect(kvRawBytes(LLAMA70B, t) / GiB).toBe(1000);
    expect(kvRawBytes({ ...LLAMA70B, bytesPerElem: 1 }, t) / GiB).toBe(500);
    expect(kvRawBytes({ ...LLAMA70B, bytesPerElem: 0.5 }, t) / GiB).toBe(250);
  });
  it('block counts round up per request and sharing stores full prefix blocks once', () => {
    expect(kvBlocks([17, 16, 1], 16)).toBe(2 + 1 + 1);
    // 2 requests x 40 tokens, 32-token shared prefix, B=16: 2 shared + 2 x ceil(8/16) = 4
    expect(kvBlocksShared([40, 40], 16, 32)).toBe(4);
    expect(kvBlocksShared([40, 40], 16, 0)).toBe(kvBlocks([40, 40], 16));
  });
  it('TP beyond KV heads replicates', () => {
    expect(kvShardFraction(8, 8)).toBe(1 / 8);
    expect(kvShardFraction(8, 16)).toBe(1 / 8);
    expect(kvShardFraction(8, 2)).toBe(1 / 2);
  });
  it('plan totals reconcile', () => {
    const p = kvPlan({ ...LLAMA70B, tokensPerReq: 32768, concurrency: 100, blockSize: 16, sharedPrefix: 0, kvOverhead: 0, paramsB: 70, weightBytes: 2, tp: 8, gpuGB: 80, nonKvGiBPerGpu: 6 });
    expect(p.rawBytes).toBe(p.allocatedBytes); // 32768 divides by 16
    expect(p.perRankKv * p.replicas * 8).toBeCloseTo(p.plannedKvBytes, 0);
    expect(p.gpus).toBe(p.replicas * 8);
  });
});

describe('Q1 TTFT spans', () => {
  const base = {
    networkMs: 20, gatewayMs: 3, promptTokens: 2000, tokenizeMsPer1k: 0.5, queueMs: 30, cacheLookupMs: 1, admissionMs: 2,
    warm: false, hitFraction: 0.8, prefillTokPerS: 10000, prefillFloorMs: 8, sampleMs: 1, detokMs: 0.2, overlap: false,
    extraDecodePass: false, decodeStepMs: 30,
  };
  it('sequential spans sum to client TTFT; server excludes both network legs', () => {
    const r = ttftSpans(base);
    const seq = r.spans.reduce((a, s) => a + s.dur, 0);
    expect(r.clientTtft).toBeCloseTo(seq, 9);
    expect(r.serverTtft).toBeCloseTo(r.clientTtft - 40, 9);
    expect(r.prefillMs).toBe(200);
  });
  it('warm cache shrinks prefill; overlap hides lookup; extra pass only adds time', () => {
    expect(ttftSpans({ ...base, warm: true }).prefillMs).toBe(40);
    expect(ttftSpans({ ...base, overlap: true }).clientTtft).toBeCloseTo(ttftSpans(base).clientTtft - 1, 9);
    expect(ttftSpans({ ...base, extraDecodePass: true }).clientTtft).toBeCloseTo(ttftSpans(base).clientTtft + 30, 9);
  });
});

describe('Q2 SSE parser', () => {
  const stream = 'event: token\r\ndata: héllo 世界 🚀\r\n\r\n: heartbeat\n\ndata: line1\ndata: line2\n\nid: 7\rdata: done\r\r\n';
  const expected = [
    { event: 'token', data: 'héllo 世界 🚀', id: undefined },
    { event: 'message', data: 'line1\nline2', id: undefined },
    { event: 'message', data: 'done', id: '7' },
  ];
  it('decodes identically for every chunk size, including 1 byte', () => {
    const n = new TextEncoder().encode(stream).length;
    for (let size = 1; size <= n; size++) expect(parseChunked(stream, size)).toEqual(expected);
  });
  it('splits at every byte position (two chunks)', () => {
    const bytes = new TextEncoder().encode(stream);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const p = new SseParser();
      expect([...p.feed(bytes.slice(0, cut)), ...p.feed(bytes.slice(cut))]).toEqual(expected);
    }
  });
  it('counts heartbeats and bounds memory', () => {
    const p = new SseParser();
    p.feed(new TextEncoder().encode(': ping\n\n: ping\n\n'));
    expect(p.heartbeats).toBe(2);
    expect(() => new SseParser(16).feed(new TextEncoder().encode('data: ' + 'x'.repeat(100)))).toThrow();
  });
  it('naive per-chunk decoding corrupts multi-byte characters', () => {
    expect(naiveDecode('世界', 1)).not.toBe('世界');
  });
});

describe('Q2 cancellation', () => {
  const c = { queueMs: 100, prefillMs: 400, prefillChunkMs: 100, itlMs: 50, tokens: 20, disconnectAt: 50, heartbeatMs: 0, propagate: true };
  it('disconnect in queue with heartbeats removes it before prefill', () => {
    const r = simulateCancel({ ...c, heartbeatMs: 30 });
    expect(r.phaseAtDisconnect).toBe('queued');
    expect(r.stoppedAt).toBe(60);
    expect(r.wastedGpuMs).toBe(0);
  });
  it('without heartbeats a queued disconnect is only seen at the first token: full prefill wasted', () => {
    const r = simulateCancel(c);
    expect(r.detectedAt).toBe(500);
    expect(r.wastedGpuMs).toBe(400);
  });
  it('decode-time disconnect stops at a step boundary; no propagation runs to the end', () => {
    const r = simulateCancel({ ...c, disconnectAt: 620 });
    expect(r.phaseAtDisconnect).toBe('decode');
    expect(r.stoppedAt).toBe(650);
    const naive = simulateCancel({ ...c, disconnectAt: 620, propagate: false });
    expect(naive.stoppedAt).toBe(naive.endNormal);
    expect(naive.tokensAfterDisconnect).toBeGreaterThan(r.tokensAfterDisconnect);
  });
  it('release is idempotent', () => {
    let n = 0;
    const rel = makeRelease(() => n++);
    expect(rel()).toBe(true);
    expect(rel()).toBe(false);
    expect(n).toBe(1);
  });
});

describe('Q4 paged allocator', () => {
  const script: AllocOp[] = [
    { op: 'create', seq: 'A' }, { op: 'append', seq: 'A', n: 6 }, { op: 'fork', seq: 'B', from: 'A' },
    { op: 'append', seq: 'A', n: 1 }, { op: 'append', seq: 'B', n: 3 }, { op: 'release', seq: 'A' },
    { op: 'release', seq: 'A' }, { op: 'append', seq: 'B', n: 4 },
  ];
  it('shares on fork, copies on write, frees on release, release idempotent', () => {
    const r = runOps(8, 4, script);
    for (const x of r) expect(checkInvariants(x.state)).toEqual([]);
    expect(r[2].state.ref[0]).toBe(2);
    expect(r[3].cow.length).toBe(1);
    expect(r[3].state.tables.A).not.toEqual(r[3].state.tables.B);
    expect(r[5].freed.length).toBe(1); // only A's private copy; block 0 still used by B
    expect(r[6].state).toEqual(r[5].state);
    expect(r[7].state.lens.B).toBe(13);
  });
  it('fails cleanly at capacity and never goes negative', () => {
    const s = newAllocator(2, 4);
    const a = applyOp(applyOp(s, { op: 'create', seq: 'X' }).state, { op: 'append', seq: 'X', n: 9 });
    expect(a.ok).toBe(false);
    expect(a.state.free.length).toBe(2); // all-or-nothing
    expect(checkInvariants(a.state)).toEqual([]);
  });
  it('waste: paged < contiguous', () => {
    const w = wasteCompare([7, 13], 4, 32);
    expect(w).toMatchObject({ used: 20, paged: 24, contiguous: 64 });
  });
});

describe('Q5 online softmax', () => {
  const ks = [1, 2, 3, 4], vs = [10, 20, 30, 40];
  it('matches the materialized reference for tiles 1, 2, 4', () => {
    for (const q of [-3, 0, 0.5, 2]) for (const t of [1, 2, 4]) expect(onlineAttention(q, ks, vs, t).out).toBeCloseTo(attentionRef(q, ks, vs), 10);
  });
  it('stays finite for huge scores where the no-max version overflows', () => {
    expect(Number.isFinite(onlineAttention(250, ks, vs).out)).toBe(true);
    expect(onlineAttention(250, ks, vs).out).toBeCloseTo(40, 6);
    expect(Number.isNaN(attentionNoMax(250, ks, vs))).toBe(true);
  });
  it('traffic: same FLOPs, far fewer bytes when tiled at long N', () => {
    const t = attentionTraffic({ n: 4096, d: 128, bytes: 2, tileRows: 128 });
    expect(t.flops).toBe(4 * 4096 * 4096 * 128);
    expect(t.naive).toBeGreaterThan(t.tiled);
  });
});
