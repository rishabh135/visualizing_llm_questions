// Foundations simulators (Q1-Q5). Each is a self-contained component keyed by question id.
import type { ComponentType } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GiB, KiB, MiB, fmt, fmtBytes, fmtMs } from '../engines/core';
import {
  attentionNoMax, attentionRef, attentionTraffic, checkInvariants, chunkBytes, kvPlan, naiveDecode, onlineAttention, parseChunked,
  runOps, simulateCancel, ttftSpans, wasteCompare, type AllocOp, type KvPlanInput, type TtftInput,
} from '../engines/g1';
import { C, ChartBox, Chip, KindLegend, Presets, Segmented, SimLayout, Slider, Stat, ValuesTable, axis, grid, tooltipStyle, usePresetState } from '../components/ui';
import type { Kind } from '../types';

// ---------- Q3: KV cache calculator ----------

const KV_NORMAL: KvPlanInput = {
  layers: 80, kvHeads: 8, headDim: 128, bytesPerElem: 2, tokensPerReq: 32768, concurrency: 100, blockSize: 16,
  sharedPrefix: 0, kvOverhead: 0.15, paramsB: 70, weightBytes: 2, tp: 8, gpuGB: 80, nonKvGiBPerGpu: 6,
};
const KV_PRESETS = {
  normal: KV_NORMAL,
  stress: { ...KV_NORMAL, tokensPerReq: 131072, concurrency: 200 },
  failure: { ...KV_NORMAL, kvHeads: 64, tp: 8, concurrency: 100 },
};

function KvSim() {
  const { s, set, active, pick, reset } = usePresetState(KV_PRESETS);
  const plan = kvPlan(s);
  const precisions = [
    { label: 'BF16 (2 B)', b: 2 }, { label: 'FP8 (1 B)', b: 1 }, { label: '4-bit (0.5 B)', b: 0.5 },
  ];
  // Concurrency sweep for each precision, sharing the same calculator.
  const sweep = [1, 25, 50, 100, 150, 200, 300, 400].map((n) => {
    const row: Record<string, number> = { n };
    for (const p of precisions) row[p.label] = kvPlan({ ...s, concurrency: n, bytesPerElem: p.b }).rawBytes / GiB;
    return row;
  });
  const rankCap = plan.perGpuUsableBytes / GiB;
  const comp = [{
    name: 'One GPU (rank)',
    Weights: plan.perRankWeights / GiB,
    'KV (planned)': plan.perRankKv / GiB,
    Reserve: s.nonKvGiBPerGpu,
  }];
  const factors: [string, number, boolean][] = [
    ['K and V', 2, false], ['layers', s.layers, s.layers !== 80], ['KV heads', s.kvHeads, s.kvHeads !== 8],
    ['head dim', s.headDim, s.headDim !== 128], ['bytes', s.bytesPerElem, s.bytesPerElem !== 2],
  ];
  const sharedSaved = plan.allocatedBytes - plan.sharedBytes;
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Cached tokens per request" value={s.tokensPerReq} min={1024} max={131072} step={1024} unit="tokens" onChange={(v) => set({ tokensPerReq: v })} />
      <Slider label="Active requests" value={s.concurrency} min={1} max={400} unit="req" onChange={(v) => set({ concurrency: v })} hint="not connected users" />
      <Segmented label="KV heads (GQA)" value={s.kvHeads} options={[1, 8, 16, 64].map((v) => ({ value: v, label: v === 64 ? '64 (MHA)' : String(v) }))} onChange={(v) => set({ kvHeads: v })} />
      <Segmented label="KV precision" value={s.bytesPerElem} options={precisions.map((p) => ({ value: p.b, label: p.label }))} onChange={(v) => set({ bytesPerElem: v })} />
      <Segmented label="Block size (tokens)" value={s.blockSize} options={[16, 32, 128].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ blockSize: v })} />
      <Slider label="Shared prefix per request" value={s.sharedPrefix} min={0} max={Math.min(16384, s.tokensPerReq)} step={256} unit="tokens" onChange={(v) => set({ sharedPrefix: v })} />
      <Slider label="KV planning allowance" value={Math.round(s.kvOverhead * 100)} min={0} max={30} unit="%" onChange={(v) => set({ kvOverhead: v / 100 })} />
      <Segmented label="Tensor parallel (GPUs per replica)" value={s.tp} options={[1, 2, 4, 8].map((v) => ({ value: v, label: `TP${v}` }))} onChange={(v) => set({ tp: v })} />
      <Segmented label="GPU memory (vendor, decimal GB)" value={s.gpuGB} options={[48, 80, 141, 180].map((v) => ({ value: v, label: `${v} GB` }))} onChange={(v) => set({ gpuGB: v })} />
    </>}>
      <div className="card raised" style={{ padding: 18 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>Bytes per cached token = product of five factors (changed factors are highlighted)</div>
        <div className="chips" style={{ alignItems: 'center' }}>
          {factors.map(([k, v, changed], idx) => (
            <span key={k} className="row" style={{ gap: 6 }}>
              {idx > 0 && <span className="arrow">×</span>}
              <Chip kind={changed ? 'error' : 'kv'} label={fmt(v)} note={k} />
            </span>
          ))}
          <span className="arrow">=</span>
          <Chip kind="prefill" label={`${fmt(plan.perTokenBytes, 0)} B`} note={`${fmt(plan.perTokenBytes / KiB)} KiB / token`} />
        </div>
      </div>
      <div className="stats">
        <Stat k="Raw KV (all requests)" v={fmtBytes(plan.rawBytes)} ev="calculated" />
        <Stat k="After blocks + sharing" v={fmtBytes(plan.sharedBytes)} ev="calculated" tone={sharedSaved > 0 ? 'good' : undefined} />
        <Stat k={`Planned KV (+${Math.round(s.kvOverhead * 100)} %)`} v={fmtBytes(plan.plannedKvBytes)} ev="assumed" />
        <Stat k="Weights (70B × 2 B)" v={fmtBytes(plan.weightBytes)} ev="calculated" />
        <Stat k={`Replicas of TP${s.tp} needed`} v={Number.isFinite(plan.replicas) ? plan.replicas : 'never fits'} tone={plan.fits1Group ? 'good' : 'bad'} ev="calculated" />
        <Stat k="GPU lower bound" v={Number.isFinite(plan.gpus) ? plan.gpus : '—'} unit="GPUs" tone={plan.gpus > 16 ? 'warn' : undefined} ev="calculated" />
      </div>

      <ChartBox title="One GPU: what fills its memory (GiB)" height={150}
        legend={<span className="small muted">Dashed line = usable memory per GPU ({fmt(rankCap, 1)} GiB = {s.gpuGB} GB vendor − {s.nonKvGiBPerGpu} GiB reserve).</span>}>
        <ResponsiveContainer>
          <BarChart data={comp} layout="vertical" margin={{ left: 16, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} domain={[0, Math.max(rankCap * 1.1, plan.perRankTotal / GiB + s.nonKvGiBPerGpu)]} tickFormatter={(v) => fmt(v, 0)} />
            <YAxis type="category" dataKey="name" {...axis} width={110} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} GiB`} />
            <Bar dataKey="Weights" stackId="a" fill={C.prefill} />
            <Bar dataKey="KV (planned)" stackId="a" fill={C.kv} />
            <Bar dataKey="Reserve" stackId="a" fill={C.neutral} />
            <ReferenceLine x={s.gpuGB * 1e9 / GiB} stroke={C.error} strokeDasharray="6 4" />
            <Legend />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      <ChartBox title="Raw KV vs active requests, by KV precision (GiB)" height={260}>
        <ResponsiveContainer>
          <LineChart data={sweep} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="n" {...axis} label={{ value: 'active requests', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} height={44} />
            <YAxis {...axis} tickFormatter={(v) => fmt(v, 0)} width={60} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 0)} GiB`} />
            <Legend />
            <Line dataKey="BF16 (2 B)" stroke={C.prefill} strokeWidth={2.5} dot={false} />
            <Line dataKey="FP8 (1 B)" stroke={C.decode} strokeWidth={2.5} strokeDasharray="6 3" dot={false} />
            <Line dataKey="4-bit (0.5 B)" stroke={C.kv} strokeWidth={2.5} strokeDasharray="2 3" dot={false} />
            <ReferenceLine x={s.concurrency} stroke={C.accent} label={{ value: 'now', fill: 'var(--accent)', position: 'top' }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      <ValuesTable cols={['Quantity', 'Value', 'Evidence']} rows={[
        ['Bytes per token', `${fmt(plan.perTokenBytes, 0)} B (${fmt(plan.perTokenBytes / KiB)} KiB)`, 'calculated'],
        ['Raw KV', fmtBytes(plan.rawBytes, 2), 'calculated'],
        ['Allocated in blocks (no sharing)', fmtBytes(plan.allocatedBytes, 2), 'calculated'],
        ['Allocated with shared prefix', fmtBytes(plan.sharedBytes, 2), 'calculated'],
        ['Planned KV incl. allowance', fmtBytes(plan.plannedKvBytes, 2), 'assumed allowance'],
        ['Weights', fmtBytes(plan.weightBytes, 2), 'calculated'],
        ['Per-rank weights + KV', fmtBytes(plan.perRankTotal, 2), 'calculated'],
        ['KV per rank fraction', `${fmt(Math.ceil(s.kvHeads / s.tp))} of ${s.kvHeads} heads${s.tp > s.kvHeads ? ' (replicated)' : ''}`, 'calculated'],
        ['GPU lower bound', String(plan.gpus), 'calculated — not a procurement plan'],
      ]} />
    </SimLayout>
  );
}

// ---------- Q1: request -> first token timeline ----------

const TTFT_NORMAL: TtftInput = {
  networkMs: 20, gatewayMs: 3, promptTokens: 2000, tokenizeMsPer1k: 0.5, queueMs: 30, cacheLookupMs: 1, admissionMs: 2,
  warm: false, hitFraction: 0.8, prefillTokPerS: 10000, prefillFloorMs: 8, sampleMs: 1, detokMs: 0.2, overlap: false,
  extraDecodePass: false, decodeStepMs: 30,
};
const TTFT_PRESETS = {
  normal: TTFT_NORMAL,
  stress: { ...TTFT_NORMAL, promptTokens: 16000, queueMs: 400 },
  failure: { ...TTFT_NORMAL, promptTokens: 16000, queueMs: 3000, extraDecodePass: true },
};
const SPAN_COLOR: Record<string, string> = { comm: C.comm, request: C.request, neutral: C.neutral, kv: C.kv, prefill: C.prefill, decode: C.decode, error: C.error };

/** Group spans into four buckets; overlapped spans run concurrently and are not added. */
function ttftBuckets(i: TtftInput) {
  const r = ttftSpans(i);
  const b = { Network: 0, 'CPU work': 0, Queue: 0, GPU: 0 };
  for (const s of r.spans) {
    if (s.name.includes('overlapped')) continue;
    if (s.lane === 'client') b.Network += s.dur;
    else if (s.lane === 'gpu') b.GPU += s.dur;
    else if (s.name === 'Queue wait') b.Queue += s.dur;
    else b['CPU work'] += s.dur;
  }
  return b;
}

function TtftSim() {
  const { s, set, active, pick, reset } = usePresetState(TTFT_PRESETS);
  const r = ttftSpans(s);
  const rows = r.spans.map((x) => ({ ...x, label: `${x.name} (${x.lane.toUpperCase()})` }));
  const compare = [
    { name: 'Cold cache', ...ttftBuckets({ ...s, warm: false }) },
    { name: 'Warm cache', ...ttftBuckets({ ...s, warm: true }) },
    { name: 'Current', ...ttftBuckets(s) },
  ];
  const queueShare = ttftBuckets(s).Queue / r.clientTtft;
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Prompt tokens" value={s.promptTokens} min={4} max={32000} step={4} unit="tokens" onChange={(v) => set({ promptTokens: v })} />
      <Slider label="Queue wait (admission)" value={s.queueMs} min={0} max={5000} step={10} unit="ms" onChange={(v) => set({ queueMs: v })} />
      <Segmented label="Prefix cache" value={s.warm ? 'warm' : 'cold'} options={[{ value: 'cold', label: 'Cold (miss)' }, { value: 'warm', label: 'Warm (hit)' }]} onChange={(v) => set({ warm: v === 'warm' })} />
      <Slider label="Cached share of prompt (warm)" value={Math.round(s.hitFraction * 100)} min={0} max={99} unit="%" onChange={(v) => set({ hitFraction: v / 100 })} />
      <Slider label="Prefill throughput (this request)" value={s.prefillTokPerS} min={1000} max={50000} step={500} unit="tok/s" onChange={(v) => set({ prefillTokPerS: v })} hint="assumed" />
      <Slider label="Network, one way" value={s.networkMs} min={0} max={200} unit="ms" onChange={(v) => set({ networkMs: v })} />
      <Segmented label="Cache lookup during queue wait" value={s.overlap ? 'yes' : 'no'} options={[{ value: 'no', label: 'Sequential' }, { value: 'yes', label: 'Overlapped' }]} onChange={(v) => set({ overlap: v === 'yes' })} />
      <Segmented label="Extra decode pass after prefill" value={s.extraDecodePass ? 'yes' : 'no'} options={[{ value: 'no', label: 'No (correct)' }, { value: 'yes', label: 'Yes (mistake)' }]} onChange={(v) => set({ extraDecodePass: v === 'yes' })} />
    </>}>
      <div className="stats">
        <Stat k="Client-visible TTFT" v={fmtMs(r.clientTtft)} ev="simulated" tone={r.clientTtft > 1000 ? 'bad' : undefined} />
        <Stat k="Server TTFT (gateway → emit)" v={fmtMs(r.serverTtft)} ev="simulated" />
        <Stat k="Prefill → first logits" v={fmtMs(r.prefillMs)} ev="simulated" />
        <Stat k="Uncached prompt tokens" v={fmt(r.uncachedTokens, 0)} ev="calculated" tone={s.warm ? 'good' : undefined} />
        <Stat k="Share of TTFT spent queued" v={`${fmt(queueShare * 100, 0)} %`} ev="simulated" tone={queueShare > 0.5 ? 'bad' : undefined} />
      </div>
      <ChartBox title="Span timeline: one request, client send → first token on screen (ms)" height={Math.max(300, rows.length * 32)}
        legend={<KindLegend kinds={['comm', 'request', 'neutral', 'kv', 'prefill', 'decode', 'error']} />}>
        <ResponsiveContainer>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24 }} barCategoryGap={4}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} />
            <YAxis type="category" dataKey="label" {...axis} width={210} interval={0} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)} ms`} />
            <Bar dataKey="start" stackId="t" fill="transparent" tooltipType="none" isAnimationActive={false} />
            <Bar dataKey="dur" name="duration" stackId="t" isAnimationActive={false}>
              {rows.map((x, k) => <Cell key={k} fill={SPAN_COLOR[x.kind]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <p className="small muted">Token 1 is sampled from the logits at the last prompt position, which prefill already computed. No decode step runs before it{s.extraDecodePass ? ' — the red span is the mistake' : ''}.</p>
      <ChartBox title="Where TTFT goes: cold vs warm prefix cache (ms)" height={220}>
        <ResponsiveContainer>
          <BarChart data={compare} layout="vertical" margin={{ left: 8, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} />
            <YAxis type="category" dataKey="name" {...axis} width={100} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} ms`} />
            <Legend />
            <Bar dataKey="Network" stackId="a" fill={C.comm} />
            <Bar dataKey="CPU work" stackId="a" fill={C.request} />
            <Bar dataKey="Queue" stackId="a" fill={C.neutral} />
            <Bar dataKey="GPU" stackId="a" fill={C.prefill} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Span', 'Lane', 'Start (ms)', 'Duration (ms)']} rows={r.spans.map((x) => [x.name, x.lane, fmt(x.start, 2), fmt(x.dur, 2)])} />
    </SimLayout>
  );
}

// ---------- Q2: SSE streaming and cancellation ----------

const SSE_SAMPLE = 'event: token\ndata: héllo 世界 🚀\n\n: ping\n\ndata: line 1\ndata: line 2\n\nevent: done\ndata: [DONE]\n\n';
const CANCEL_NORMAL = { queueMs: 200, prefillMs: 600, prefillChunkMs: 100, itlMs: 40, tokens: 50, disconnectAt: 1500, heartbeatMs: 500, propagate: true, split: 3 };
const CANCEL_PRESETS = {
  normal: CANCEL_NORMAL,
  stress: { ...CANCEL_NORMAL, disconnectAt: 100, heartbeatMs: 0, split: 1 },
  failure: { ...CANCEL_NORMAL, disconnectAt: 400, propagate: false, split: 1 },
};

function SseSim() {
  const { s, set, active, pick, reset } = usePresetState(CANCEL_PRESETS);
  const r = simulateCancel(s);
  const total = Math.max(r.endNormal, r.stoppedAt) * 1.02;
  const pct = (t: number) => `${(t / total) * 100}%`;
  const sweep = Array.from({ length: 29 }, (_, k) => {
    const d = (k / 28) * r.endNormal;
    return {
      d: Math.round(d),
      'Propagated + heartbeats': simulateCancel({ ...s, disconnectAt: d, propagate: true, heartbeatMs: s.heartbeatMs || 500 }).wastedGpuMs,
      'Propagated, no heartbeats': simulateCancel({ ...s, disconnectAt: d, propagate: true, heartbeatMs: 0 }).wastedGpuMs,
      'Not propagated': simulateCancel({ ...s, disconnectAt: d, propagate: false }).wastedGpuMs,
    };
  });
  const events = parseChunked(SSE_SAMPLE, s.split);
  const chunks = chunkBytes(new TextEncoder().encode(SSE_SAMPLE), s.split);
  const naive = naiveDecode(SSE_SAMPLE, s.split);
  const phases: [string, number, number, Kind][] = [
    ['queued', 0, s.queueMs, 'request'], ['prefill', s.queueMs, s.queueMs + s.prefillMs, 'prefill'], ['decode', s.queueMs + s.prefillMs, r.endNormal, 'decode'],
  ];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Client disconnects at" value={s.disconnectAt} min={0} max={3000} step={10} unit="ms" onChange={(v) => set({ disconnectAt: v })} />
      <Slider label="Heartbeat interval (0 = off)" value={s.heartbeatMs} min={0} max={2000} step={50} unit="ms" onChange={(v) => set({ heartbeatMs: v })} />
      <Segmented label="Cancel reaches the engine?" value={s.propagate ? 'yes' : 'no'} options={[{ value: 'yes', label: 'Yes, by request ID' }, { value: 'no', label: 'No (handler exits only)' }]} onChange={(v) => set({ propagate: v === 'yes' })} />
      <Slider label="Prefill preemption chunk" value={s.prefillChunkMs} min={50} max={600} step={50} unit="ms" onChange={(v) => set({ prefillChunkMs: v })} />
      <Slider label="Network chunk size (parser demo)" value={s.split} min={1} max={16} unit="bytes" onChange={(v) => set({ split: v })} />
    </>}>
      <div className="stats">
        <Stat k="Phase at disconnect" v={r.phaseAtDisconnect} ev="simulated" />
        <Stat k="Detected after" v={Number.isFinite(r.detectedAt) ? fmtMs(r.detectedAt - s.disconnectAt) : '—'} ev="simulated" tone={r.detectedAt - s.disconnectAt > 300 ? 'warn' : undefined} />
        <Stat k="Wasted GPU time" v={fmtMs(r.wastedGpuMs)} ev="simulated" tone={r.wastedGpuMs > 500 ? 'bad' : r.wastedGpuMs === 0 ? 'good' : undefined} />
        <Stat k="Tokens made for nobody" v={r.tokensAfterDisconnect} ev="simulated" tone={r.tokensAfterDisconnect > 5 ? 'bad' : undefined} />
        <Stat k="KV released at" v={fmtMs(r.kvFreedAt)} ev="simulated" />
      </div>

      <figure className="chart-box" style={{ margin: 0, padding: 16 }}>
        <h3 style={{ paddingLeft: 0 }}>Request lifecycle with disconnect (numbers mark events below)</h3>
        <svg viewBox="0 0 1000 90" width="100%" role="img" aria-label="Lifecycle timeline; event list follows">
          {phases.map(([n, a, b, k]) => (
            <g key={n}>
              <rect x={(a / total) * 1000} y={20} width={Math.max(0, ((b - a) / total) * 1000)} height={28} fill={C[k]} opacity={0.35} stroke={C[k]} />
              <text x={(a / total) * 1000 + 6} y={39} fontSize={15} fill="var(--text)">{n}</text>
            </g>
          ))}
          {r.events.map((e, k) => (
            <g key={k}>
              <line x1={(e.t / total) * 1000} x2={(e.t / total) * 1000} y1={12} y2={60} stroke={C[e.kind]} strokeWidth={2.5} />
              <text x={(e.t / total) * 1000} y={78} fontSize={14} fill={C[e.kind]} textAnchor="middle">{k + 1}</text>
            </g>
          ))}
        </svg>
        <ol className="small" style={{ columns: 2, columnGap: 24, marginTop: 8 }}>
          {r.events.map((e, k) => <li key={k} style={{ breakInside: 'avoid' }}><span className="mono">{fmtMs(e.t)}</span> — {e.label}</li>)}
        </ol>
        <span className="sr-only">Timeline spans to {pct(r.endNormal)} of width.</span>
      </figure>

      <ChartBox title="Wasted GPU time vs moment of disconnect (ms)" height={240}>
        <ResponsiveContainer>
          <LineChart data={sweep} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="d" {...axis} height={44} label={{ value: 'disconnect time (ms)', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} />
            <YAxis {...axis} width={60} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 0)} ms`} />
            <Legend />
            <Line dataKey="Propagated + heartbeats" stroke={C.decode} strokeWidth={2.5} dot={false} />
            <Line dataKey="Propagated, no heartbeats" stroke={C.kv} strokeWidth={2.5} strokeDasharray="6 3" dot={false} />
            <Line dataKey="Not propagated" stroke={C.error} strokeWidth={2.5} strokeDasharray="2 3" dot={false} />
            <ReferenceLine x={Math.round(s.disconnectAt)} stroke={C.accent} label={{ value: 'now', fill: 'var(--accent)', position: 'top' }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      <div className="card raised stack" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 16 }}>UTF-8 safe parser: {chunks.length} chunks of ≤ {s.split} bytes</h3>
        <div className="chips">
          {chunks.slice(0, 14).map((c, k) => <Chip key={k} kind="comm" label={`#${k + 1}`} note={`${c.length} B`} />)}
          {chunks.length > 14 && <Chip kind="neutral" label={`+${chunks.length - 14}`} />}
        </div>
        <div className="chips">
          {events.map((e, k) => <Chip key={k} kind={e.event === 'done' ? 'ok' : 'decode'} label={e.data.replace('\n', ' ⏎ ')} note={`event: ${e.event}`} />)}
        </div>
        <p className="small">Naive per-chunk decode: <span className="mono">{naive.split('\n')[1]}</span> {naive === SSE_SAMPLE ? '✓ intact' : '✕ corrupted (split multi-byte characters)'}</p>
      </div>
      <ValuesTable cols={['Quantity', 'Value']} rows={[
        ['Normal completion', fmtMs(r.endNormal)], ['Disconnect', fmtMs(s.disconnectAt)], ['Detected', fmtMs(r.detectedAt)],
        ['Engine stopped', fmtMs(r.stoppedAt)], ['KV freed', fmtMs(r.kvFreedAt)], ['Wasted GPU', fmtMs(r.wastedGpuMs)],
        ['Parsed events', String(events.length)], ['Chunks', String(chunks.length)],
      ]} />
    </SimLayout>
  );
}

// ---------- Q4: paged KV allocator ----------

const PAGED_SCRIPT: AllocOp[] = [
  { op: 'create', seq: 'A' }, { op: 'append', seq: 'A', n: 6 }, { op: 'fork', seq: 'B', from: 'A' },
  { op: 'append', seq: 'A', n: 1 }, { op: 'append', seq: 'B', n: 3 }, { op: 'release', seq: 'A' },
  { op: 'release', seq: 'A' }, { op: 'append', seq: 'B', n: 4 },
];
const PAGED_NORMAL = { blocks: 8, blockSize: 4, step: PAGED_SCRIPT.length, maxLen: 32 };
const PAGED_PRESETS = { normal: PAGED_NORMAL, stress: { ...PAGED_NORMAL, blocks: 5 }, failure: { ...PAGED_NORMAL, blocks: 3 } };

function PagedSim() {
  const { s, set, active, pick, reset } = usePresetState(PAGED_PRESETS);
  const results = runOps(s.blocks, s.blockSize, PAGED_SCRIPT);
  const cur = results[s.step - 1];
  const st = cur.state;
  const seqs = Object.keys(st.tables);
  const lens = seqs.map((q) => st.lens[q]);
  const w = wasteCompare(lens, s.blockSize, s.maxLen);
  const cows = results.slice(0, s.step).reduce((a, x) => a + x.cow.length, 0);
  const shared = st.ref.filter((x) => x > 1).length;
  const errs = checkInvariants(st);
  const blockKind = (b: number): Kind => (st.ref[b] === 0 ? 'neutral' : cur.cow.includes(b) ? 'decode' : st.ref[b] > 1 ? 'prefill' : 'kv');
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Step through operations" value={s.step} min={1} max={PAGED_SCRIPT.length} onChange={(v) => set({ step: v })} format={(v) => `${v} / ${PAGED_SCRIPT.length}`} />
      <Slider label="Physical blocks in GPU pool" value={s.blocks} min={3} max={12} unit="blocks" onChange={(v) => set({ blocks: v })} />
      <Segmented label="Tokens per block (B)" value={s.blockSize} options={[2, 4, 8].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ blockSize: v })} />
      <Slider label="Contiguous reservation (max length)" value={s.maxLen} min={8} max={64} step={4} unit="tokens" onChange={(v) => set({ maxLen: v })} />
    </>}>
      <ol className="small" aria-label="Operation log" style={{ display: 'grid', gap: 4 }}>
        {results.slice(0, s.step).map((x, k) => (
          <li key={k} style={{ color: x.ok ? undefined : 'var(--error)', fontWeight: k === s.step - 1 ? 600 : 400 }}>{x.ok ? '✓' : '✕'} {x.note}</li>
        ))}
      </ol>
      <div className="stats">
        <Stat k="Free blocks" v={`${st.free.length} / ${s.blocks}`} ev="simulated" tone={st.free.length === 0 ? 'bad' : undefined} />
        <Stat k="Shared blocks (ref > 1)" v={shared} ev="simulated" tone={shared > 0 ? 'good' : undefined} />
        <Stat k="Copy-on-write copies" v={cows} ev="simulated" />
        <Stat k="Invariants" v={errs.length ? `${errs.length} broken` : 'all hold'} tone={errs.length ? 'bad' : 'good'} ev="simulated" />
      </div>

      <div className="card raised stack" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 16 }}>Block tables: logical block → physical block</h3>
        {seqs.length === 0 && <p className="muted small">No live sequences.</p>}
        {seqs.map((q) => (
          <div className="lane" key={q}>
            <div className="lane-label">Seq {q} · {st.lens[q]} tokens</div>
            <div className="chips">
              {st.tables[q].map((b, li) => <Chip key={li} kind={blockKind(b)} label={`L${li} → #${b}`} note={`${st.fill[b]}/${s.blockSize} tok`} />)}
            </div>
          </div>
        ))}
        <h3 style={{ fontSize: 16, marginTop: 8 }}>Physical pool</h3>
        <div className="chips">
          {st.ref.map((r, b) => <Chip key={b} kind={blockKind(b)} label={`#${b}`} note={r === 0 ? 'free' : `ref ${r} · ${st.fill[b]}/${s.blockSize}`} />)}
        </div>
        <div className="legend small">
          <span><Chip kind="kv" label="private" /></span><span><Chip kind="prefill" label="shared (ref > 1)" /></span>
          <span><Chip kind="decode" label="copied on write now" /></span><span><Chip kind="neutral" label="free" /></span>
        </div>
      </div>

      <ChartBox title="Token slots: used vs paged vs contiguous reservation" height={220}>
        <ResponsiveContainer>
          <BarChart data={[{ name: 'Tokens used', v: w.used }, { name: 'Paged allocation', v: w.paged }, { name: 'Contiguous reservation', v: w.contiguous }]} margin={{ left: 8, right: 24 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={48} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${v} token slots`} />
            <Bar dataKey="v" name="token slots" isAnimationActive={false}>
              <Cell fill={C.decode} /><Cell fill={C.kv} /><Cell fill={C.error} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Quantity', 'Value']} rows={[
        ['Live sequences', seqs.join(', ') || 'none'], ['Tokens used', String(w.used)],
        ['Paged slots (waste)', `${w.paged} (${w.pagedWaste})`], ['Contiguous slots (waste)', `${w.contiguous} (${w.contiguousWaste})`],
        ['Free list', st.free.join(', ') || 'empty'], ['Invariant violations', errs.join('; ') || 'none'],
      ]} />
    </SimLayout>
  );
}

// ---------- Q5: online softmax and HBM traffic ----------

const FA_KS = [1, 2, 3, 4];
const FA_VS = [10, 20, 30, 40];
const FA_NORMAL = { q: 1, tile: 1, n: 4096, d: 128, tileRows: 128 };
const FA_PRESETS = { normal: FA_NORMAL, stress: { ...FA_NORMAL, n: 32768 }, failure: { ...FA_NORMAL, q: 200, tileRows: 32 } };

function FlashSim() {
  const { s, set, active, pick, reset } = usePresetState(FA_PRESETS);
  const on = onlineAttention(s.q, FA_KS, FA_VS, s.tile);
  const ref = attentionRef(s.q, FA_KS, FA_VS);
  const noMax = attentionNoMax(s.q, FA_KS, FA_VS);
  const tr = attentionTraffic({ n: s.n, d: s.d, bytes: 2, tileRows: s.tileRows });
  const sweep = [512, 1024, 2048, 4096, 8192, 16384, 32768].map((n) => {
    const t = attentionTraffic({ n, d: s.d, bytes: 2, tileRows: s.tileRows });
    return { n, Materialized: t.naive / MiB, Tiled: t.tiled / MiB };
  });
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Toy query q (scores = q × k)" value={s.q} min={-10} max={250} step={0.5} onChange={(v) => set({ q: v })} />
      <Segmented label="Keys per tile (toy)" value={s.tile} options={[1, 2, 4].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ tile: v })} />
      <Slider label="Sequence length N" value={s.n} min={512} max={32768} step={512} unit="tokens" onChange={(v) => set({ n: v })} />
      <Segmented label="Head dimension d" value={s.d} options={[64, 128, 256].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ d: v })} />
      <Slider label="Query rows per SRAM tile" value={s.tileRows} min={16} max={256} step={16} unit="rows" onChange={(v) => set({ tileRows: v })} />
    </>}>
      <div className="card raised stack" style={{ padding: 18 }}>
        <h3 style={{ fontSize: 16 }}>One query row, keys k = [1, 2, 3, 4], values v = [10, 20, 30, 40]</h3>
        {on.trace.map((t, k) => (
          <div className="lane" key={k}>
            <div className="lane-label">After key {t.j + 1}</div>
            <div className="chips">
              <Chip kind="request" label={fmt(t.score, 2)} note="score" />
              <Chip kind="prefill" label={fmt(t.m, 2)} note="running max m" />
              <Chip kind="kv" label={fmt(t.l, 4)} note="normalizer l" />
              <Chip kind="decode" label={fmt(t.out, 4)} note="acc / l so far" />
            </div>
          </div>
        ))}
      </div>
      <div className="stats">
        <Stat k="Online (tiled) output" v={fmt(on.out, 6)} ev="calculated" tone="good" />
        <Stat k="Materialized reference" v={fmt(ref, 6)} ev="calculated" />
        <Stat k="exp() without max subtraction" v={Number.isFinite(noMax) ? fmt(noMax, 6) : 'NaN (overflow)'} tone={Number.isFinite(noMax) ? undefined : 'bad'} ev="calculated" />
        <Stat k="HBM bytes, materialized" v={fmtBytes(tr.naive)} ev="calculated" />
        <Stat k="HBM bytes, tiled" v={fmtBytes(tr.tiled)} ev="calculated" tone="good" />
        <Stat k="Traffic reduction" v={`${fmt(tr.ratio, 2)}×`} ev="calculated" tone={tr.ratio < 1 ? 'bad' : undefined} />
        <Stat k="Score matrix per head if materialized" v={fmtBytes(s.n * s.n * 2)} ev="calculated" tone={s.n >= 16384 ? 'warn' : undefined} />
      </div>
      <ChartBox title={`HBM traffic per (batch, head) vs N, d = ${s.d}, BF16 (MiB, log scale)`} height={260}>
        <ResponsiveContainer>
          <LineChart data={sweep} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="n" {...axis} height={44} label={{ value: 'sequence length N', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} />
            <YAxis {...axis} scale="log" domain={['auto', 'auto']} width={64} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} MiB`} />
            <Legend />
            <Line dataKey="Materialized" stroke={C.error} strokeWidth={2.5} strokeDasharray="6 3" dot />
            <Line dataKey="Tiled" stroke={C.decode} strokeWidth={2.5} dot />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <p className="small muted">FLOPs are identical for both: 4·N²·d = {fmt(tr.flops / 1e9, 1)} GFLOP per head. Arithmetic intensity rises from {fmt(tr.aiNaive, 1)} to {fmt(tr.aiTiled, 1)} FLOP/byte — that, not less maths, is the speedup.</p>
      <ValuesTable cols={['Quantity', 'Materialized', 'Tiled']} rows={[
        ['HBM bytes', fmtBytes(tr.naive, 2), fmtBytes(tr.tiled, 2)], ['FLOPs', fmt(tr.flops, 0), fmt(tr.flops, 0)],
        ['Intensity (FLOP/B)', fmt(tr.aiNaive, 2), fmt(tr.aiTiled, 2)], ['Toy output', fmt(ref, 8), fmt(on.out, 8)],
      ]} />
    </SimLayout>
  );
}

export const sims: Record<number, ComponentType> = { 1: TtftSim, 2: SseSim, 3: KvSim, 4: PagedSim, 5: FlashSim };
