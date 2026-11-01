// Foundations engines (Q1-Q5). Pure functions only.
import { GB, GiB, sum } from './core';

// ---------- Q3: KV cache memory ----------

export interface KvConfig {
  layers: number;
  kvHeads: number;
  headDim: number;
  /** Effective bytes per cached element (2 = BF16, 1 = FP8, 0.5 = packed 4-bit). */
  bytesPerElem: number;
}

/** Llama-style 70B anchor. Assumed example architecture, not every 70B model. */
export const LLAMA70B: KvConfig = { layers: 80, kvHeads: 8, headDim: 128, bytesPerElem: 2 };

/** 2 (K and V) x layers x KV heads x head dim x bytes. */
export const kvBytesPerToken = (c: KvConfig) => 2 * c.layers * c.kvHeads * c.headDim * c.bytesPerElem;

/** Raw KV bytes for a list of cached-token counts. */
export const kvRawBytes = (c: KvConfig, tokens: number[]) => kvBytesPerToken(c) * sum(tokens);

/** Private fixed-size blocks: sum(ceil(T_i / B)). */
export const kvBlocks = (tokens: number[], blockSize: number) => sum(tokens.map((t) => Math.ceil(t / blockSize)));

/**
 * Physical blocks when every request shares the same prefix.
 * Only full prefix blocks are shared; the partial last prefix block is private (copy-on-write on first divergence).
 */
export function kvBlocksShared(tokens: number[], blockSize: number, sharedPrefix: number) {
  const sharedFull = Math.floor(sharedPrefix / blockSize);
  const sharedTokens = sharedFull * blockSize;
  const privateBlocks = sum(tokens.map((t) => Math.ceil(Math.max(0, t - Math.min(t, sharedTokens)) / blockSize)));
  const anyReq = tokens.some((t) => t >= sharedTokens);
  return (anyReq ? sharedFull : 0) + privateBlocks;
}

/** Fraction of a full KV copy that each tensor-parallel rank stores. Replicates heads when TP > KV heads. */
export function kvShardFraction(kvHeads: number, tp: number) {
  return Math.ceil(kvHeads / tp) / kvHeads;
}

export interface KvPlanInput extends KvConfig {
  tokensPerReq: number;
  concurrency: number;
  blockSize: number;
  sharedPrefix: number;
  /** Planning allowance on KV only, e.g. 0.15 = +15 %. */
  kvOverhead: number;
  paramsB: number;
  weightBytes: number;
  tp: number;
  /** Vendor GPU memory in decimal GB. */
  gpuGB: number;
  /** Bytes per GPU reserved for activations, workspaces, graphs, comms, runtime (GiB). */
  nonKvGiBPerGpu: number;
}

export interface KvPlan {
  perTokenBytes: number;
  rawBytes: number;
  allocatedBytes: number;
  sharedBytes: number;
  plannedKvBytes: number;
  weightBytes: number;
  perGpuUsableBytes: number;
  perRankWeights: number;
  perRankKv: number;
  perRankTotal: number;
  replicas: number;
  gpus: number;
  fits1Group: boolean;
}

/** Full plan. Every chart and table in Q3 reads this one function. */
export function kvPlan(i: KvPlanInput): KvPlan {
  const tokens = Array.from({ length: i.concurrency }, () => i.tokensPerReq);
  const perTokenBytes = kvBytesPerToken(i);
  const rawBytes = perTokenBytes * sum(tokens);
  const allocatedBytes = kvBlocks(tokens, i.blockSize) * i.blockSize * perTokenBytes;
  const sharedBytes = kvBlocksShared(tokens, i.blockSize, i.sharedPrefix) * i.blockSize * perTokenBytes;
  const plannedKvBytes = sharedBytes * (1 + i.kvOverhead);
  const weightBytes = i.paramsB * 1e9 * i.weightBytes;
  const perGpuUsableBytes = i.gpuGB * GB - i.nonKvGiBPerGpu * GiB;
  const perRankWeights = weightBytes / i.tp;
  const kvPerGroupFull = plannedKvBytes * kvShardFraction(i.kvHeads, i.tp);
  const kvRoomPerGroup = Math.max(0, perGpuUsableBytes - perRankWeights);
  // How many TP groups (replicas) are needed so that the KV fits: each group holds a slice of the requests.
  const replicas = kvRoomPerGroup <= 0 ? Infinity : Math.max(1, Math.ceil(kvPerGroupFull / kvRoomPerGroup));
  const perRankKv = Number.isFinite(replicas) ? kvPerGroupFull / replicas : kvPerGroupFull;
  return {
    perTokenBytes, rawBytes, allocatedBytes, sharedBytes, plannedKvBytes, weightBytes, perGpuUsableBytes,
    perRankWeights, perRankKv, perRankTotal: perRankWeights + perRankKv,
    replicas, gpus: replicas * i.tp, fits1Group: replicas === 1,
  };
}

// ---------- Q1: request -> first token span model ----------

export type SpanLane = 'client' | 'cpu' | 'gpu';
export interface Span { name: string; lane: SpanLane; start: number; dur: number; kind: 'request' | 'prefill' | 'decode' | 'comm' | 'neutral' | 'error' | 'kv' }

export interface TtftInput {
  networkMs: number;        // one way, client <-> gateway
  gatewayMs: number;        // TLS, routing, auth
  promptTokens: number;
  tokenizeMsPer1k: number;
  queueMs: number;          // wait for admission (batch slot / KV)
  cacheLookupMs: number;
  admissionMs: number;      // schedule, allocate KV, build batch
  warm: boolean;            // prefix cache hit?
  hitFraction: number;      // share of prompt tokens served from cache when warm
  prefillTokPerS: number;   // uncached prompt tokens per second for this request
  prefillFloorMs: number;   // launch / small-batch floor
  sampleMs: number;
  detokMs: number;
  overlap: boolean;         // cache lookup runs while the request waits in queue
  extraDecodePass: boolean; // the classic mistake: an extra forward pass after prefill
  decodeStepMs: number;
}

export interface TtftResult { spans: Span[]; uncachedTokens: number; prefillMs: number; serverTtft: number; clientTtft: number }

/** Sequential span model. Server TTFT = gateway arrival -> first token emitted; client adds both network legs. */
export function ttftSpans(i: TtftInput): TtftResult {
  const spans: Span[] = [];
  let t = 0;
  const add = (name: string, lane: SpanLane, dur: number, kind: Span['kind']) => { spans.push({ name, lane, start: t, dur, kind }); t += dur; };
  add('Network in', 'client', i.networkMs, 'comm');
  add('Gateway + auth', 'cpu', i.gatewayMs, 'request');
  add('Tokenize', 'cpu', (i.promptTokens / 1000) * i.tokenizeMsPer1k, 'request');
  if (i.overlap) {
    // Lookup hidden under the queue wait: only the excess shows.
    spans.push({ name: 'Cache lookup (overlapped)', lane: 'cpu', start: t, dur: i.cacheLookupMs, kind: 'kv' });
    add('Queue wait', 'cpu', Math.max(i.queueMs, i.cacheLookupMs), 'neutral');
  } else {
    add('Queue wait', 'cpu', i.queueMs, 'neutral');
    add('Cache lookup', 'cpu', i.cacheLookupMs, 'kv');
  }
  add('Admission + KV alloc', 'cpu', i.admissionMs, 'request');
  const uncachedTokens = Math.max(1, Math.round(i.promptTokens * (i.warm ? 1 - i.hitFraction : 1)));
  const prefillMs = Math.max(i.prefillFloorMs, (uncachedTokens / i.prefillTokPerS) * 1000);
  add('Prefill → first logits', 'gpu', prefillMs, 'prefill');
  if (i.extraDecodePass) add('Extra decode pass (wrong)', 'gpu', i.decodeStepMs, 'error');
  add('Sample token 1', 'gpu', i.sampleMs, 'decode');
  add('Detokenize + emit', 'cpu', i.detokMs, 'request');
  const serverTtft = t - i.networkMs;
  add('Network out', 'client', i.networkMs, 'comm');
  return { spans, uncachedTokens, prefillMs, serverTtft, clientTtft: t };
}

// ---------- Q2: SSE parsing and cancellation ----------

export interface SseEvent { event: string; data: string; id?: string }

/**
 * Incremental SSE parser. UTF-8 safe across any byte split (TextDecoder stream mode), handles LF, CR, CRLF
 * (including CR at a chunk end), multi-line data, comments/heartbeats, and a bounded pending buffer.
 */
export class SseParser {
  private decoder = new TextDecoder('utf-8');
  private buf = '';
  private data: string[] = [];
  private event = '';
  private id: string | undefined;
  heartbeats = 0;
  constructor(private maxBuffer = 64 * 1024) {}

  feed(bytes: Uint8Array): SseEvent[] {
    this.buf += this.decoder.decode(bytes, { stream: true });
    if (this.buf.length > this.maxBuffer) throw new Error(`SSE buffer over ${this.maxBuffer} chars`);
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A trailing CR may be the first half of CRLF: wait for the next chunk.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.data.length === 0) { this.event = ''; return null; }
      const ev: SseEvent = { event: this.event || 'message', data: this.data.join('\n'), id: this.id };
      this.data = []; this.event = '';
      return ev;
    }
    if (line.startsWith(':')) { this.heartbeats++; return null; }
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.data.push(value);
      if (this.data.reduce((a, d) => a + d.length, 0) > this.maxBuffer) throw new Error('SSE event data too large');
    } else if (field === 'event') this.event = value;
    else if (field === 'id') this.id = value;
    return null;
  }
}

/** Split bytes into fixed-size chunks (the network decides real boundaries; this makes them adversarial). */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** Parse a full stream delivered in chunks of `size` bytes. */
export function parseChunked(text: string, size: number): SseEvent[] {
  const p = new SseParser();
  return chunkBytes(new TextEncoder().encode(text), size).flatMap((c) => p.feed(c));
}

/** What a naive client sees if it decodes each chunk independently (no stream mode). */
export function naiveDecode(text: string, size: number): string {
  return chunkBytes(new TextEncoder().encode(text), size).map((c) => new TextDecoder().decode(c)).join('');
}

export type Phase = 'queued' | 'prefill' | 'decode' | 'done';
export interface CancelInput {
  queueMs: number;
  prefillMs: number;
  /** Prefill is preemptible only at chunk boundaries. */
  prefillChunkMs: number;
  itlMs: number;
  tokens: number;
  disconnectAt: number;
  /** 0 = no heartbeats: a dead socket is only noticed on the next token write. */
  heartbeatMs: number;
  /** false = naive: only the HTTP handler exits; the engine keeps generating. */
  propagate: boolean;
}
export interface CancelEvent { t: number; label: string; kind: 'request' | 'prefill' | 'decode' | 'error' | 'ok' | 'kv' | 'neutral' }
export interface CancelResult {
  phaseAtDisconnect: Phase;
  detectedAt: number;
  stoppedAt: number;
  kvFreedAt: number;
  wastedGpuMs: number;
  tokensAfterDisconnect: number;
  endNormal: number;
  events: CancelEvent[];
}

const ceilTo = (t: number, origin: number, step: number) => origin + Math.ceil((t - origin) / step - 1e-9) * step;

/** Event-time model of disconnect -> detection -> safe-boundary abort -> KV release. */
export function simulateCancel(i: CancelInput): CancelResult {
  const prefillStart = i.queueMs;
  const decodeStart = prefillStart + i.prefillMs;
  const endNormal = decodeStart + i.tokens * i.itlMs;
  const d = i.disconnectAt;
  const phaseAtDisconnect: Phase = d < prefillStart ? 'queued' : d < decodeStart ? 'prefill' : d < endNormal ? 'decode' : 'done';
  const events: CancelEvent[] = [{ t: 0, label: 'Request queued', kind: 'request' }, { t: prefillStart, label: 'Prefill starts, KV allocated', kind: 'prefill' }, { t: decodeStart, label: 'Token 1 written', kind: 'decode' }];
  if (phaseAtDisconnect === 'done') {
    events.push({ t: endNormal, label: 'Completed, KV freed', kind: 'ok' });
    return { phaseAtDisconnect, detectedAt: NaN, stoppedAt: endNormal, kvFreedAt: endNormal, wastedGpuMs: 0, tokensAfterDisconnect: 0, endNormal, events };
  }
  events.push({ t: d, label: 'Client disconnects', kind: 'error' });
  // Detection: the server learns of a dead socket on its next write (token or heartbeat).
  const nextToken = d < decodeStart ? decodeStart : ceilTo(d, decodeStart, i.itlMs);
  const nextBeat = i.heartbeatMs > 0 ? ceilTo(d, 0, i.heartbeatMs) : Infinity;
  const detectedAt = Math.min(nextToken, nextBeat, endNormal);
  events.push({ t: detectedAt, label: 'Server detects disconnect', kind: 'neutral' });
  let stoppedAt: number;
  if (!i.propagate) stoppedAt = endNormal;
  else if (detectedAt < prefillStart) stoppedAt = detectedAt; // removed from queue, nothing running
  else if (detectedAt < decodeStart) stoppedAt = Math.min(decodeStart, ceilTo(detectedAt, prefillStart, i.prefillChunkMs));
  else stoppedAt = Math.min(endNormal, ceilTo(detectedAt, decodeStart, i.itlMs));
  // KV is released only once the engine is off the request, never while a kernel may still read it.
  const kvFreedAt = stoppedAt;
  events.push({ t: stoppedAt, label: i.propagate ? 'Engine aborts at safe boundary' : 'Engine finishes anyway (not cancelled)', kind: i.propagate ? 'ok' : 'error' });
  events.push({ t: kvFreedAt, label: stoppedAt < prefillStart ? 'Queue entry removed (no KV yet)' : 'KV blocks released (idempotent)', kind: 'kv' });
  const gpuFrom = Math.max(d, prefillStart);
  const wastedGpuMs = Math.max(0, stoppedAt - gpuFrom);
  let tokensAfterDisconnect = 0; // token k is produced at decodeStart + k * itl
  for (let k = 0; k < i.tokens; k++) { const tk = decodeStart + k * i.itlMs; if (tk > d && tk < stoppedAt + 1e-9) tokensAfterDisconnect++; }
  events.sort((a, b) => a.t - b.t);
  return { phaseAtDisconnect, detectedAt, stoppedAt, kvFreedAt, wastedGpuMs, tokensAfterDisconnect, endNormal, events };
}

/** Idempotent cleanup: safe to call from both the abort path and `finally`. */
export function makeRelease(onRelease: () => void) {
  let done = false;
  return () => { if (done) return false; done = true; onRelease(); return true; };
}

// ---------- Q4: paged KV allocator ----------

export interface AllocState {
  blockSize: number;
  free: number[];
  ref: number[];
  /** tokens written in each physical block */
  fill: number[];
  tables: Record<string, number[]>;
  lens: Record<string, number>;
}

export type AllocOp =
  | { op: 'create'; seq: string }
  | { op: 'append'; seq: string; n: number }
  | { op: 'fork'; seq: string; from: string }
  | { op: 'release'; seq: string };

export interface OpResult { state: AllocState; ok: boolean; note: string; cow: number[]; allocated: number[]; freed: number[] }

export function newAllocator(numBlocks: number, blockSize: number): AllocState {
  // Free list popped from the end, so block 0 is handed out first.
  return { blockSize, free: Array.from({ length: numBlocks }, (_, i) => numBlocks - 1 - i), ref: Array(numBlocks).fill(0), fill: Array(numBlocks).fill(0), tables: {}, lens: {} };
}

const cloneState = (s: AllocState): AllocState => ({
  blockSize: s.blockSize, free: [...s.free], ref: [...s.ref], fill: [...s.fill],
  tables: Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v]])), lens: { ...s.lens },
});

/** Apply one op to a copy of the state. Failed ops leave the state unchanged (all-or-nothing). */
export function applyOp(prev: AllocState, o: AllocOp): OpResult {
  const s = cloneState(prev);
  const cow: number[] = [], allocated: number[] = [], freed: number[] = [];
  const fail = (note: string): OpResult => ({ state: prev, ok: false, note, cow: [], allocated: [], freed: [] });
  if (o.op === 'create') {
    if (s.tables[o.seq]) return fail(`${o.seq} already exists`);
    s.tables[o.seq] = []; s.lens[o.seq] = 0;
    return { state: s, ok: true, note: `create ${o.seq}`, cow, allocated, freed };
  }
  if (o.op === 'fork') {
    const parent = s.tables[o.from];
    if (!parent) return fail(`${o.from} not found`);
    s.tables[o.seq] = [...parent]; s.lens[o.seq] = s.lens[o.from];
    parent.forEach((b) => s.ref[b]++);
    return { state: s, ok: true, note: `fork ${o.seq} from ${o.from}: ${parent.length} blocks shared, 0 copied`, cow, allocated, freed };
  }
  if (o.op === 'release') {
    const t = s.tables[o.seq];
    if (!t) return { state: prev, ok: true, note: `release ${o.seq}: already released (no-op)`, cow, allocated, freed };
    for (const b of t) { s.ref[b]--; if (s.ref[b] === 0) { s.fill[b] = 0; s.free.push(b); freed.push(b); } }
    delete s.tables[o.seq]; delete s.lens[o.seq];
    return { state: s, ok: true, note: `release ${o.seq}: freed ${freed.length} block(s)`, cow, allocated, freed };
  }
  const t = s.tables[o.seq];
  if (!t) return fail(`${o.seq} not found`);
  const B = s.blockSize;
  for (let k = 0; k < o.n; k++) {
    const len = s.lens[o.seq];
    if (len % B === 0) {
      const b = s.free.pop();
      if (b === undefined) return fail(`append ${o.seq}: out of blocks — preempt, swap or reject`);
      s.ref[b] = 1; s.fill[b] = 0; t.push(b); allocated.push(b);
    } else {
      const last = t[t.length - 1];
      if (s.ref[last] > 1) {
        // Copy-on-write: the partial block is shared, so writing would corrupt the other sequence.
        const b = s.free.pop();
        if (b === undefined) return fail(`append ${o.seq}: copy-on-write needs a free block`);
        s.ref[last]--; s.ref[b] = 1; s.fill[b] = s.fill[last]; t[t.length - 1] = b; cow.push(b);
      }
    }
    s.fill[t[t.length - 1]]++;
    s.lens[o.seq] = len + 1;
  }
  return { state: s, ok: true, note: `append ${o.n} to ${o.seq}${cow.length ? ` (copy-on-write → block ${cow.join(',')})` : ''}`, cow, allocated, freed };
}

/** Run a script and keep every intermediate state for stepping. */
export function runOps(numBlocks: number, blockSize: number, ops: AllocOp[]): OpResult[] {
  const out: OpResult[] = [];
  let s = newAllocator(numBlocks, blockSize);
  for (const o of ops) { const r = applyOp(s, o); out.push(r); s = r.state; }
  return out;
}

/** Invariants a correct allocator must keep. Returns a list of violations (empty = OK). */
export function checkInvariants(s: AllocState): string[] {
  const errs: string[] = [];
  const refs = Array(s.ref.length).fill(0);
  Object.values(s.tables).forEach((t) => t.forEach((b) => refs[b]++));
  refs.forEach((r, b) => { if (r !== s.ref[b]) errs.push(`block ${b}: ref ${s.ref[b]} but ${r} owners`); });
  s.free.forEach((b) => { if (refs[b] > 0) errs.push(`block ${b} free but referenced`); });
  if (new Set(s.free).size !== s.free.length) errs.push('duplicate free block');
  if (s.free.length + refs.filter((r) => r > 0).length !== s.ref.length) errs.push('blocks leaked');
  return errs;
}

/** Waste comparison: contiguous max-length reservation vs paged allocation. Units: token slots. */
export function wasteCompare(lens: number[], blockSize: number, maxLen: number) {
  const used = sum(lens);
  const paged = sum(lens.map((l) => Math.ceil(l / blockSize) * blockSize));
  const contiguous = lens.length * maxLen;
  return { used, paged, contiguous, pagedWaste: paged - used, contiguousWaste: contiguous - used };
}

// ---------- Q5: online softmax and attention memory traffic ----------

/** Materialized scalar attention: s_j = q*k_j, softmax with max subtraction, weighted sum of v. */
export function attentionRef(q: number, ks: number[], vs: number[]): number {
  const s = ks.map((k) => q * k);
  const m = Math.max(...s);
  const e = s.map((x) => Math.exp(x - m));
  const l = sum(e);
  return sum(e.map((x, j) => x * vs[j])) / l;
}

/** Same thing without max subtraction: overflows for large scores. Shown as the failure case. */
export const attentionNoMax = (q: number, ks: number[], vs: number[]) => {
  const e = ks.map((k) => Math.exp(q * k));
  return sum(e.map((x, j) => x * vs[j])) / sum(e);
};

export interface OnlineStep { j: number; score: number; m: number; l: number; acc: number; out: number }

/** Streaming (online) softmax over tiles of keys: running max m, normalizer l, unnormalized sum acc. */
export function onlineAttention(q: number, ks: number[], vs: number[], tile = 1): { out: number; trace: OnlineStep[] } {
  let m = -Infinity, l = 0, acc = 0;
  const trace: OnlineStep[] = [];
  for (let start = 0; start < ks.length; start += tile) {
    const idx = ks.slice(start, start + tile).map((_, k) => start + k);
    const scores = idx.map((j) => q * ks[j]);
    const mNew = Math.max(m, ...scores);
    const scale = Math.exp(m - mNew); // exp(-inf) = 0 on the first tile
    l = l * scale + sum(scores.map((s) => Math.exp(s - mNew)));
    acc = acc * scale + sum(scores.map((s, k) => Math.exp(s - mNew) * vs[idx[k]]));
    m = mNew;
    trace.push({ j: idx[idx.length - 1], score: scores[scores.length - 1], m, l, acc, out: acc / l });
  }
  return { out: acc / l, trace };
}

export interface TrafficInput { n: number; d: number; bytes: number; tileRows: number }
/**
 * Analytical HBM bytes per (batch, head). Naive: write S, read S, write P, read P (4 N^2) plus Q,K,V,O.
 * Tiled: Q read once, K and V streamed once per query tile, O written once; no N x N matrix in HBM.
 * FLOPs are identical: 4 N^2 d (QK^T and PV).
 */
export function attentionTraffic(i: TrafficInput) {
  const { n, d, bytes, tileRows } = i;
  const naive = (4 * n * n + 4 * n * d) * bytes;
  const tiled = (2 * n * d + 2 * n * d * Math.ceil(n / tileRows)) * bytes;
  const flops = 4 * n * n * d;
  return { naive, tiled, flops, aiNaive: flops / naive, aiTiled: flops / tiled, ratio: naive / tiled };
}
