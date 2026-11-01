// Scheduling & latency simulators (Q6-Q10). All numbers come from pure functions in engines/g2.ts.
import { useMemo, useState, type ComponentType } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmt, fmtMs, fmtPct } from '../engines/core';
import {
  BATCHES, bestK, frontier, gapBreakdown, makeTrace, maxBatchUnderSlo, route, sampleRound, simulate, specRound, stepMs, warmVsCold,
  type DecodeHw, type Policy, type Route, type SchedConfig, type SchedResult,
} from '../engines/g2';
import { C, ChartBox, Chip, KindLegend, Presets, Segmented, SimLayout, Slider, Stat, ValuesTable, axis, grid, tooltipStyle, usePresetState } from '../components/ui';
import type { Kind } from '../types';

// ---------- Shared: iteration Gantt ----------

const CELL: Record<string, { kind: Kind; label: string }> = {
  P: { kind: 'prefill', label: 'prefill' },
  D: { kind: 'decode', label: 'decode token' },
  W: { kind: 'request', label: 'waiting in queue' },
  S: { kind: 'neutral', label: 'admitted, skipped this iteration' },
  R: { kind: 'error', label: 'rejected' },
  X: { kind: 'error', label: 'cancelled' },
  '.': { kind: 'neutral', label: 'not present' },
};

function Gantt({ g, title }: { g: SchedResult['gantt']; title: string }) {
  return (
    <figure className="chart-box" style={{ margin: 0, padding: 16 }}>
      <h3 style={{ paddingLeft: 0 }}>{title}</h3>
      <div style={{ overflowX: 'auto' }}>
        <div role="table" aria-label={`${title}: rows are requests, columns are iterations`} style={{ display: 'grid', gap: 2, minWidth: 'max-content' }}>
          {g.rows.map((r) => (
            <div role="row" key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span role="rowheader" className="mono small muted" style={{ width: 64 }}>{r.long ? `R${r.id}★` : `R${r.id}`}</span>
              <span role="cell" className="mono" aria-label={r.cells} style={{ display: 'flex', gap: 1 }}>
                {[...r.cells].map((ch, i) => (
                  <span key={i} aria-hidden="true" title={`iter ${i}: ${CELL[ch].label}`}
                    style={{ width: 13, height: 20, display: 'grid', placeItems: 'center', fontSize: 11, borderRadius: 3,
                      background: ch === '.' ? 'transparent' : `color-mix(in srgb, ${C[CELL[ch].kind]} ${ch === 'P' || ch === 'D' ? 70 : 22}%, transparent)`,
                      color: ch === 'P' || ch === 'D' ? 'var(--bg)' : 'var(--muted)' }}>{ch === '.' ? '' : ch}</span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        First {g.rows.length} requests × first {g.iters} iterations. P prefill · D decode · W waiting · S admitted but skipped · R rejected · X cancelled · ★ long prompt.
      </p>
    </figure>
  );
}

const POLICIES: { value: Policy; label: string }[] = [
  { value: 'fcfs', label: 'FCFS' }, { value: 'decode-first', label: 'Decode-first' },
  { value: 'prefill-first', label: 'Prefill-first' }, { value: 'aged', label: 'Aged + deadline' },
];

const BASE_CFG: Omit<SchedConfig, 'policy' | 'tokenBudget' | 'maxSeqs' | 'kvBlocks' | 'maxQueue' | 'chunk'> = {
  blockSize: 16, agingMs: 400, decodeDeadlineMs: 60, baseMs: 15, decodeMsPerSeq: 0.3, prefillMsPerToken: 0.05,
};

// ---------- Q6: continuous batching scheduler ----------

const Q6_NORMAL = { policy: 'decode-first' as Policy, gapMs: 50, promptMean: 400, outputMean: 100, cancelFrac: 0.05, tokenBudget: 512, maxSeqs: 64, kvBlocks: 4000, maxQueue: 200 };
const Q6_PRESETS = {
  normal: Q6_NORMAL,
  stress: { ...Q6_NORMAL, gapMs: 20, promptMean: 600, outputMean: 120 },
  failure: { ...Q6_NORMAL, gapMs: 15, promptMean: 600, outputMean: 300, cancelFrac: 0.2, kvBlocks: 500, maxQueue: 12 },
};

function SchedulerSim() {
  const { s, set, active, pick, reset } = usePresetState(Q6_PRESETS);
  const results = useMemo(() => {
    const trace = makeTrace({ seed: 7, n: 70, gapMs: s.gapMs, promptMean: s.promptMean, outputMean: s.outputMean, cancelFrac: s.cancelFrac });
    return POLICIES.map((p) => ({
      ...p,
      r: simulate(trace, { ...BASE_CFG, policy: p.value, tokenBudget: s.tokenBudget, maxSeqs: s.maxSeqs, kvBlocks: s.kvBlocks, maxQueue: s.maxQueue, chunk: 256 }),
    }));
  }, [s.gapMs, s.promptMean, s.outputMean, s.cancelFrac, s.tokenBudget, s.maxSeqs, s.kvBlocks, s.maxQueue]);
  const cur = results.find((x) => x.value === s.policy)!.r;
  const chart = results.map((x) => ({ name: x.label, 'TTFT p50': x.r.ttftP50, 'TTFT p95': x.r.ttftP95, 'Gap p50': x.r.itlP50, 'Gap p95': x.r.itlP95, sel: x.value === s.policy }));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Policy shown in Gantt" value={s.policy} options={POLICIES} onChange={(v) => set({ policy: v })} />
      <Slider label="Mean arrival gap" value={s.gapMs} min={5} max={200} unit="ms" onChange={(v) => set({ gapMs: v })} hint={`${fmt(1000 / s.gapMs, 1)} req/s`} />
      <Slider label="Mean prompt" value={s.promptMean} min={50} max={2000} step={50} unit="tokens" onChange={(v) => set({ promptMean: v })} />
      <Slider label="Mean output" value={s.outputMean} min={10} max={500} step={10} unit="tokens" onChange={(v) => set({ outputMean: v })} />
      <Slider label="Token budget per iteration" value={s.tokenBudget} min={128} max={4096} step={128} unit="tokens" onChange={(v) => set({ tokenBudget: v })} />
      <Slider label="Max running sequences" value={s.maxSeqs} min={4} max={128} onChange={(v) => set({ maxSeqs: v })} />
      <Slider label="KV capacity" value={s.kvBlocks} min={200} max={8000} step={100} unit="blocks" onChange={(v) => set({ kvBlocks: v })} hint="16 tokens each" />
      <Slider label="Queue limit (then reject)" value={s.maxQueue} min={2} max={200} onChange={(v) => set({ maxQueue: v })} />
      <Slider label="Cancelled by client" value={Math.round(s.cancelFrac * 100)} min={0} max={50} unit="%" onChange={(v) => set({ cancelFrac: v / 100 })} />
    </>}>
      <div className="stats">
        <Stat k="TTFT p95" v={fmtMs(cur.ttftP95)} ev="simulated" tone={cur.ttftP95 > 2000 ? 'bad' : undefined} />
        <Stat k="Token gap p95" v={fmtMs(cur.itlP95)} ev="simulated" tone={cur.itlP95 > 100 ? 'bad' : undefined} />
        <Stat k="Output throughput" v={fmt(cur.throughput, 0)} unit="tok/s" ev="simulated" />
        <Stat k="Completed / rejected / cancelled" v={`${cur.completed} / ${cur.rejected} / ${cur.cancelled}`} tone={cur.rejected ? 'warn' : 'good'} ev="simulated" />
        <Stat k="Fairness (Jain, 1 = even)" v={fmt(cur.fairness, 2)} ev="simulated" />
        <Stat k="Min free KV blocks" v={cur.minFree} tone={cur.minFree < 0 ? 'bad' : 'good'} ev="simulated" />
      </div>
      <ChartBox title="Time to first token by policy, same seeded trace (ms)" height={250}>
        <ResponsiveContainer>
          <BarChart data={chart} margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={64} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} />
            <Legend />
            <Bar dataKey="TTFT p50" fill={C.request} />
            <Bar dataKey="TTFT p95" fill={C.prefill} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Inter-token gap by policy (ms)" height={230}>
        <ResponsiveContainer>
          <BarChart data={chart} margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={64} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} />
            <Legend />
            <Bar dataKey="Gap p50" fill={C.decode} />
            <Bar dataKey="Gap p95" fill={C.kv} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <Gantt g={cur.gantt} title={`Iteration Gantt — ${POLICIES.find((p) => p.value === s.policy)!.label}`} />
      <ValuesTable cols={['Policy', 'TTFT p50', 'TTFT p95', 'Gap p95', 'Tok/s', 'Done', 'Rejected', 'Cancelled', 'Iterations', 'Fairness']}
        rows={results.map((x) => [x.label, fmtMs(x.r.ttftP50), fmtMs(x.r.ttftP95), fmtMs(x.r.itlP95), fmt(x.r.throughput, 0), x.r.completed, x.r.rejected, x.r.cancelled, x.r.iterations, fmt(x.r.fairness, 2)])} />
    </SimLayout>
  );
}

// ---------- Q7: chunked prefill ----------

const Q7_NORMAL = { chunk: 512, longTokens: 100_000, longPrompts: 1, gapMs: 60, tokenBudget: 2048 };
const Q7_PRESETS = {
  normal: Q7_NORMAL,
  stress: { ...Q7_NORMAL, gapMs: 30, longTokens: 150_000 },
  failure: { ...Q7_NORMAL, longPrompts: 3, chunk: 2048 },
};
const CHUNKS = [256, 512, 1024, 2048, 4096];

function ChunkedPrefillSim() {
  const { s, set, active, pick, reset } = usePresetState(Q7_PRESETS);
  const { none, cur, sweep } = useMemo(() => {
    const trace = makeTrace({ seed: 11, n: 50, gapMs: s.gapMs, promptMean: 300, outputMean: 100, cancelFrac: 0, longPrompts: s.longPrompts, longTokens: s.longTokens });
    const run = (chunk: number) => simulate(trace, { ...BASE_CFG, policy: 'decode-first', tokenBudget: s.tokenBudget, maxSeqs: 64, kvBlocks: 40_000, maxQueue: 500, chunk });
    const none = run(Infinity);
    return {
      none,
      cur: Number.isFinite(s.chunk) ? run(s.chunk) : none,
      sweep: CHUNKS.map((c) => { const r = run(c); return { chunk: String(c), 'Short TTFT p95': r.shortTtftP95 / 1000, 'Long TTFT': r.longTtft / 1000 }; }),
    };
  }, [s.chunk, s.longTokens, s.longPrompts, s.gapMs, s.tokenBudget]);
  const iters = cur.gantt.iterMs.map((ms, i) => ({ i, ms }));
  const noneIterMax = Math.max(...none.gantt.iterMs);
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Prefill chunk size (tokens)" value={s.chunk} options={[{ value: Infinity, label: 'No chunking' }, ...CHUNKS.map((c) => ({ value: c, label: String(c) }))]} onChange={(v) => set({ chunk: v })} />
      <Slider label="Long prompt length" value={s.longTokens} min={10_000} max={200_000} step={5_000} unit="tokens" onChange={(v) => set({ longTokens: v })} />
      <Slider label="Long prompts arriving" value={s.longPrompts} min={1} max={3} onChange={(v) => set({ longPrompts: v })} hint="adversarial" />
      <Slider label="Short request arrival gap" value={s.gapMs} min={10} max={200} unit="ms" onChange={(v) => set({ gapMs: v })} />
      <Segmented label="Token budget per iteration" value={s.tokenBudget} options={[1024, 2048, 4096, 8192].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ tokenBudget: v })} />
    </>}>
      <div className="stats">
        <Stat k="Short TTFT p95 (now)" v={fmtMs(cur.shortTtftP95)} tone={cur.shortTtftP95 < none.shortTtftP95 ? 'good' : 'bad'} ev="simulated" />
        <Stat k="Short TTFT p95 (no chunking)" v={fmtMs(none.shortTtftP95)} ev="simulated" />
        <Stat k="Long prompt TTFT (now)" v={fmtMs(cur.longTtft)} tone={cur.longTtft > none.longTtft ? 'warn' : undefined} ev="simulated" />
        <Stat k="Long prompt TTFT (no chunking)" v={fmtMs(none.longTtft)} ev="simulated" />
        <Stat k="Longest iteration (now / none)" v={`${fmtMs(Math.max(...cur.gantt.iterMs))} / ${fmtMs(noneIterMax)}`} ev="simulated" />
        <Stat k="Scheduling overhead" v={fmtMs(cur.overheadMs)} unit={`${cur.iterations} iters`} ev="simulated" />
      </div>
      <ChartBox title="Chunk size trade-off (seconds): short requests win, the long prompt pays" height={260}>
        <ResponsiveContainer>
          <LineChart data={sweep} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="chunk" {...axis} label={{ value: 'chunk size (tokens)', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} height={44} />
            <YAxis {...axis} width={56} tickFormatter={(v) => fmt(v, 1)} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)} s`} />
            <Legend />
            <Line dataKey="Short TTFT p95" stroke={C.request} strokeWidth={2.5} />
            <Line dataKey="Long TTFT" stroke={C.prefill} strokeWidth={2.5} strokeDasharray="6 3" />
            <ReferenceLine y={none.shortTtftP95 / 1000} stroke={C.error} strokeDasharray="4 4" label={{ value: 'short p95, no chunking', fill: 'var(--c-error)', position: 'insideTopRight' }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Duration of the first iterations (ms) — one giant prefill stalls everyone" height={200}>
        <ResponsiveContainer>
          <BarChart data={iters} margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="i" {...axis} />
            <YAxis {...axis} width={64} scale="log" domain={[10, 'auto']} allowDataOverflow tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} labelFormatter={(l) => `iteration ${l}`} />
            <Bar dataKey="ms">{iters.map((x) => <Cell key={x.i} fill={x.ms > 1000 ? C.error : C.prefill} />)}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <Gantt g={cur.gantt} title={`Interleaving — ${Number.isFinite(s.chunk) ? `${s.chunk}-token chunks` : 'no chunking'}`} />
      <ValuesTable cols={['Chunk', 'Short TTFT p95 (s)', 'Long TTFT (s)']} rows={sweep.map((r) => [r.chunk, fmt(r['Short TTFT p95'], 2), fmt(r['Long TTFT'], 2)])} />
    </SimLayout>
  );
}

// ---------- Q8: prefix-aware routing ----------

const Q8_NORMAL = { policy: 'load-aware' as Route, gapMs: 60, hotShare: 0.5, prefixedFrac: 0.8, cacheSlots: 1, prefixA: 4000, warmWait: 80 };
const Q8_PRESETS = {
  normal: Q8_NORMAL,
  stress: { ...Q8_NORMAL, gapMs: 40 },
  failure: { ...Q8_NORMAL, policy: 'affinity' as Route, hotShare: 0.95, gapMs: 45 },
};
const ROUTES: { value: Route; label: string }[] = [{ value: 'random', label: 'Random' }, { value: 'affinity', label: 'Prefix affinity' }, { value: 'load-aware', label: 'Load-aware ECT' }];
const MS_PER_TOK = 0.02;

function RouterSim() {
  const { s, set, active, pick, reset } = usePresetState(Q8_PRESETS);
  const results = useMemo(() => ROUTES.map((r) => ({
    ...r,
    res: route({ seed: 3, n: 150, gapMs: s.gapMs, replicas: 3, prefixA: s.prefixA, prefixB: 6000, prefixedFrac: s.prefixedFrac, hotShare: s.hotShare, suffixMean: 300, prefillMsPerTok: MS_PER_TOK, decodeMs: 60, cacheSlots: s.cacheSlots }, r.value),
  })), [s.gapMs, s.prefixA, s.prefixedFrac, s.hotShare, s.cacheSlots]);
  const cur = results.find((r) => r.value === s.policy)!.res;
  const totalBusy = cur.perReplica.reduce((a, r) => a + r.busyMs, 0);
  const chart = results.map((r) => ({ name: r.label, 'p50 latency': r.res.p50, 'p95 latency': r.res.p95, hit: r.res.tokenHitRate * 100 }));
  const wvc = warmVsCold(s.warmWait, 0, s.prefixA, 300, MS_PER_TOK);
  const be = wvc.breakEvenWarmWait;
  const curve = Array.from({ length: 11 }, (_, i) => {
    const w = (i / 10) * be * 2;
    const x = warmVsCold(w, 0, s.prefixA, 300, MS_PER_TOK);
    return { wait: Math.round(w), 'Wait for warm replica': x.warm, 'Recompute on idle replica': x.cold };
  });
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Policy shown in replica view" value={s.policy} options={ROUTES} onChange={(v) => set({ policy: v })} />
      <Slider label="Mean arrival gap" value={s.gapMs} min={20} max={200} unit="ms" onChange={(v) => set({ gapMs: v })} />
      <Slider label="Share of prefixed requests on prefix A" value={Math.round(s.hotShare * 100)} min={50} max={100} unit="%" onChange={(v) => set({ hotShare: v / 100 })} hint="skew" />
      <Slider label="Requests carrying a shared prefix" value={Math.round(s.prefixedFrac * 100)} min={0} max={100} unit="%" onChange={(v) => set({ prefixedFrac: v / 100 })} />
      <Slider label="Prefix A length" value={s.prefixA} min={500} max={16000} step={500} unit="tokens" onChange={(v) => set({ prefixA: v })} />
      <Segmented label="Prefixes each replica can cache" value={s.cacheSlots} options={[{ value: 0, label: '0 (no cache)' }, { value: 1, label: '1' }, { value: 2, label: '2' }]} onChange={(v) => set({ cacheSlots: v })} />
      <Slider label="Queue wait on the warm replica" value={s.warmWait} min={0} max={Math.round(be * 2)} unit="ms" onChange={(v) => set({ warmWait: v })} hint="decision panel" />
    </>}>
      <div className="stats">
        <Stat k="Prefix hit rate (by tokens)" v={fmtPct(cur.tokenHitRate)} ev="simulated" tone={cur.tokenHitRate > 0.6 ? 'good' : undefined} />
        <Stat k="Latency p50 / p95" v={`${fmtMs(cur.p50)} / ${fmtMs(cur.p95)}`} ev="simulated" tone={cur.p95 > 600 ? 'bad' : undefined} />
        <Stat k="Busiest replica ÷ mean" v={`${fmt(cur.imbalance, 2)}×`} ev="simulated" tone={cur.imbalance > 1.5 ? 'bad' : 'good'} />
        <Stat k="Warm vs recompute now" v={wvc.pickWarm ? 'wait for warm' : 'recompute'} ev="calculated" tone={wvc.pickWarm ? 'good' : 'warn'} />
      </div>
      <div className="card raised stack" style={{ padding: 18 }}>
        <div className="small muted">Replica view — {ROUTES.find((r) => r.value === s.policy)!.label}: final cached prefixes and share of busy time</div>
        {cur.perReplica.map((r, i) => (
          <div className="lane" key={i}>
            <div className="lane-label">Replica {i + 1}</div>
            <div className="chips" style={{ alignItems: 'center' }}>
              {r.cached.length === 0 ? <Chip kind="neutral" label="cache empty" /> : r.cached.map((p) => <Chip key={p} kind="kv" label={`prefix ${p === 0 ? 'A' : 'B'}`} note={`${p === 0 ? s.prefixA : 6000} tok`} />)}
              <Chip kind="request" label={`${r.reqs} requests`} />
              <span style={{ flex: '1 1 120px', minWidth: 120, height: 14, background: 'var(--raised)', borderRadius: 99, overflow: 'hidden' }} aria-label={`busy share ${fmtPct(r.busyMs / totalBusy)}`}>
                <span style={{ display: 'block', height: '100%', width: `${(r.busyMs / totalBusy) * 100}%`, background: C.prefill }} />
              </span>
              <span className="mono small">{fmtPct(r.busyMs / totalBusy, 0)}</span>
            </div>
          </div>
        ))}
        <KindLegend kinds={['kv', 'request']} />
      </div>
      <ChartBox title="End-to-end latency by routing policy, same trace (ms)" height={240}>
        <ResponsiveContainer>
          <BarChart data={chart} margin={{ left: 8, right: 16 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={64} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} />
            <Legend />
            <Bar dataKey="p50 latency" fill={C.request} />
            <Bar dataKey="p95 latency" fill={C.prefill} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title={`Wait for warm or recompute ${fmt(s.prefixA, 0)}-token prefix elsewhere? (ms)`} height={240}
        legend={<span className="small muted">Break-even: waiting beats recompute while warm-replica wait &lt; prefix × {MS_PER_TOK} ms/token = {fmtMs(be)} (idle cold replica assumed).</span>}>
        <ResponsiveContainer>
          <LineChart data={curve} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="wait" {...axis} label={{ value: 'queue wait on warm replica (ms)', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} height={44} />
            <YAxis {...axis} width={56} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} />
            <Legend />
            <Line dataKey="Wait for warm replica" stroke={C.decode} strokeWidth={2.5} dot={false} />
            <Line dataKey="Recompute on idle replica" stroke={C.error} strokeWidth={2.5} strokeDasharray="6 3" dot={false} />
            <ReferenceLine x={Math.round(be)} stroke={C.accent} strokeDasharray="4 4" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Policy', 'Hit rate (tokens)', 'p50', 'p95', 'Imbalance', 'Requests per replica']}
        rows={results.map((r) => [r.label, fmtPct(r.res.tokenHitRate), fmtMs(r.res.p50), fmtMs(r.res.p95), `${fmt(r.res.imbalance, 2)}×`, r.res.perReplica.map((x) => x.reqs).join(' / ')])} />
    </SimLayout>
  );
}

// ---------- Q9: inter-token latency vs throughput ----------

const Q9_NORMAL = { B: 32, ctx: 4096, bwTBs: 3.35, slo: 50, prefillShare: 0.2, prefillChunkMs: 30, flushMs: 0, proxyBufferMs: 0, renderMs: 2 };
const Q9_PRESETS = {
  normal: Q9_NORMAL,
  stress: { ...Q9_NORMAL, B: 128, ctx: 16384, prefillShare: 0.5 },
  failure: { ...Q9_NORMAL, flushMs: 100, proxyBufferMs: 60 },
};

function ItlSim() {
  const { s, set, active, pick, reset } = usePresetState(Q9_PRESETS);
  // Assumed 70B BF16 on TP8 per GPU: 17.5 GB weights, 40 KiB KV/token, 8.75 B params; H100-class peaks (vendor spec).
  const hw: DecodeHw = { fixedMs: 4, perSeqMs: 0.02, weightGB: 17.5, kvKiB: 40, ctx: s.ctx, bwTBs: s.bwTBs, tflops: 989, eff: 0.5, paramsB: 8.75 };
  const t = { prefillShare: s.prefillShare, prefillChunkMs: s.prefillChunkMs, flushMs: s.flushMs, proxyBufferMs: s.proxyBufferMs, renderMs: s.renderMs };
  const f = frontier(hw);
  const step = stepMs(hw, s.B);
  const g = gapBreakdown(hw, s.B, t);
  const extra = g.mean - step.total;
  const bMax = maxBatchUnderSlo(hw, s.slo, extra);
  const pts = f.map((p) => ({ ...p, client: p.itl + extra }));
  const curPt = pts.find((p) => p.B === s.B) ?? pts[0];
  const bars = [{ name: 'Client gap', ...Object.fromEntries(g.parts.map((p) => [p.name, p.ms])) }];
  const colors = [C.decode, C.prefill, C.comm, C.kv, C.neutral];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Decode batch size" value={s.B} options={BATCHES.filter((b) => b >= 4).map((b) => ({ value: b, label: String(b) }))} onChange={(v) => set({ B: v })} />
      <Slider label="Context per sequence" value={s.ctx} min={512} max={32768} step={512} unit="tokens" onChange={(v) => set({ ctx: v })} />
      <Slider label="Effective HBM bandwidth" value={s.bwTBs} min={1} max={8} step={0.05} unit="TB/s" onChange={(v) => set({ bwTBs: v })} />
      <Slider label="Token-gap SLO" value={s.slo} min={10} max={200} unit="ms" onChange={(v) => set({ slo: v })} />
      <Slider label="Steps sharing a prefill chunk" value={Math.round(s.prefillShare * 100)} min={0} max={100} unit="%" onChange={(v) => set({ prefillShare: v / 100 })} />
      <Slider label="Prefill chunk cost" value={s.prefillChunkMs} min={0} max={200} unit="ms" onChange={(v) => set({ prefillChunkMs: v })} />
      <Slider label="Server flush interval" value={s.flushMs} min={0} max={200} unit="ms" onChange={(v) => set({ flushMs: v })} hint="0 = flush per token" />
      <Slider label="Proxy buffering delay" value={s.proxyBufferMs} min={0} max={200} unit="ms" onChange={(v) => set({ proxyBufferMs: v })} />
    </>}>
      <div className="stats">
        <Stat k="Model step (ITL)" v={fmtMs(step.total)} unit={`${step.bound}-bound`} ev="calculated" />
        <Stat k="Client-visible gap (mean)" v={fmtMs(g.mean)} tone={g.mean > s.slo ? 'bad' : 'good'} ev="calculated" />
        <Stat k="Worst-case gap (approx.)" v={fmtMs(g.worst)} tone={g.worst > s.slo * 2 ? 'warn' : undefined} ev="calculated" />
        <Stat k="Per-user speed" v={fmt(1000 / g.mean, 1)} unit="tok/s" ev="calculated" />
        <Stat k="Aggregate (per GPU group)" v={fmt((s.B * 1000) / step.total, 0)} unit="tok/s" ev="calculated" />
        <Stat k="Largest batch meeting SLO" v={bMax || 'none'} tone={bMax ? 'good' : 'bad'} ev="calculated" />
      </div>
      <ChartBox title="Throughput ↔ latency frontier: each point is a batch size" height={280}
        legend={<span className="small muted">Points above the dashed SLO line are infeasible. Throughput keeps rising with batch, but every user waits longer per token.</span>}>
        <ResponsiveContainer>
          <LineChart data={pts} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="aggregate" type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} label={{ value: 'aggregate tokens/s', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} height={44} />
            <YAxis {...axis} width={56} tickFormatter={(v) => fmt(v, 0)} label={{ value: 'ms/token', angle: -90, position: 'insideLeft', fill: 'var(--muted)' }} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} labelFormatter={(l) => `${fmt(Number(l), 0)} tok/s`} />
            <Legend />
            <Line dataKey="itl" name="Model ITL" stroke={C.decode} strokeWidth={2.5} />
            <Line dataKey="client" name="Client-visible gap" stroke={C.comm} strokeWidth={2.5} strokeDasharray="6 3" />
            <ReferenceLine y={s.slo} stroke={C.error} strokeDasharray="4 4" label={{ value: `SLO ${s.slo} ms`, fill: 'var(--c-error)', position: 'insideTopLeft' }} />
            <ReferenceDot x={curPt.aggregate} y={curPt.client} r={7} fill={C.accent} stroke="none" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Where each client-visible token gap goes (ms, mean)" height={140}>
        <ResponsiveContainer>
          <BarChart data={bars} layout="vertical" margin={{ left: 8, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} />
            <YAxis type="category" dataKey="name" {...axis} width={90} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtMs(Number(v))} />
            <Legend />
            {g.parts.map((p, i) => <Bar key={p.name} dataKey={p.name} stackId="g" fill={colors[i]} />)}
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Batch', 'Model ITL', 'Client gap', 'Per-user tok/s', 'Aggregate tok/s', 'Bound']}
        rows={pts.map((p) => [p.B, fmtMs(p.itl), fmtMs(p.client), fmt(1000 / p.client, 1), fmt(p.aggregate, 0), p.bound])} />
    </SimLayout>
  );
}

// ---------- Q10: speculative decoding ----------

const Q10_NORMAL = { a: 0.7, k: 4, draftMs: 3, targetMs: 30, overheadMs: 1, sat: 0.1 };
const Q10_PRESETS = {
  normal: Q10_NORMAL,
  stress: { ...Q10_NORMAL, sat: 0.6 },
  failure: { ...Q10_NORMAL, a: 0.3, draftMs: 8, k: 6, sat: 1 },
};
const TOK_KIND: Record<string, Kind> = { accept: 'ok', reject: 'error', correct: 'decode', bonus: 'prefill' };

function SpeculativeSim() {
  const { s, set, active, pick, reset } = usePresetState(Q10_PRESETS);
  const [seed, setSeed] = useState(1);
  const r = specRound(s);
  const best = bestK(s);
  const accs = [...new Set([0.5, 0.7, 0.9, s.a])].sort();
  const byK = Array.from({ length: 12 }, (_, i) => {
    const k = i + 1;
    const row: Record<string, number> = { k };
    for (const a of accs) row[`a=${a}`] = specRound({ ...s, a, k }).speedup;
    return row;
  });
  const bySat = Array.from({ length: 11 }, (_, i) => ({ sat: i * 10, speedup: specRound({ ...s, sat: i / 10 }).speedup }));
  const round = sampleRound(seed, s.a, s.k);
  const dash = ['', '6 3', '2 3', '10 4'];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Acceptance rate a" value={s.a} min={0} max={1} step={0.01} onChange={(v) => set({ a: v })} format={(v) => v.toFixed(2)} />
      <Slider label="Draft length k" value={s.k} min={1} max={12} unit="tokens" onChange={(v) => set({ k: v })} />
      <Slider label="Draft cost per token" value={s.draftMs} min={0.5} max={15} step={0.5} unit="ms" onChange={(v) => set({ draftMs: v })} />
      <Slider label="Target step (baseline ITL)" value={s.targetMs} min={5} max={100} unit="ms" onChange={(v) => set({ targetMs: v })} />
      <Slider label="Verify cost per extra draft token" value={Math.round(s.sat * 100)} min={0} max={100} unit="% of step" onChange={(v) => set({ sat: v / 100 })} hint="batch load" />
      <Slider label="Sync / rollback overhead" value={s.overheadMs} min={0} max={10} step={0.5} unit="ms" onChange={(v) => set({ overheadMs: v })} />
    </>}>
      <div className="stats">
        <Stat k="E[tokens per round]" v={fmt(r.E, 2)} unit={`of ${s.k + 1} max`} ev="calculated" />
        <Stat k="Round time" v={fmtMs(r.roundMs)} unit={`verify ${fmt(r.verifyMs, 1)}`} ev="calculated" />
        <Stat k="Tokens/s vs baseline" v={`${fmt(r.tps, 1)} / ${fmt(r.base, 1)}`} ev="calculated" />
        <Stat k="Speedup" v={`${fmt(r.speedup, 2)}×`} tone={r.speedup >= 1 ? 'good' : 'bad'} ev="calculated" />
        <Stat k="Best k for these inputs" v={best.k} unit={`${fmt(best.speedup, 2)}×`} ev="calculated" />
      </div>
      <div className="card raised stack" style={{ padding: 18 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">One seeded round (seed {seed}): accept left to right until the first rejection</span>
          <button type="button" className="btn-sm" onClick={() => setSeed((x) => x + 1)}>Draft another round</button>
        </div>
        <div className="chips">
          {round.toks.map((t, i) => <Chip key={i} kind={TOK_KIND[t]} label={t === 'accept' ? `d${i + 1} ✓` : t === 'reject' ? `d${i + 1} ✕` : t === 'bonus' ? 'bonus' : 'correction'} note={t} />)}
        </div>
        <span className="small">Emitted this round: <b>{round.emitted}</b> token{round.emitted === 1 ? '' : 's'} ({round.accepted} accepted + 1 {round.accepted === s.k ? 'bonus' : 'correction'}). Expected: {fmt(r.E, 2)}.</span>
        <KindLegend kinds={['ok', 'error', 'decode', 'prefill']} />
      </div>
      <ChartBox title="Speedup vs draft length, for several acceptance rates" height={270}
        legend={<span className="small muted">Below the dashed 1× line, speculation makes decoding slower.</span>}>
        <ResponsiveContainer>
          <LineChart data={byK} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="k" {...axis} label={{ value: 'draft tokens k', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} height={44} />
            <YAxis {...axis} width={50} tickFormatter={(v) => `${fmt(v, 1)}×`} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)}×`} />
            <Legend />
            {accs.map((a, i) => <Line key={a} dataKey={`a=${a}`} stroke={[C.error, C.kv, C.decode, C.accent][i % 4]} strokeWidth={a === s.a ? 3.5 : 2} strokeDasharray={dash[i % 4]} dot={false} />)}
            <ReferenceLine y={1} stroke={C.muted} strokeDasharray="4 4" />
            <ReferenceLine x={s.k} stroke={C.accent} label={{ value: 'k now', fill: 'var(--accent)', position: 'top' }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Batch load erodes the win: verify cost per draft token (% of a target step)" height={230}>
        <ResponsiveContainer>
          <LineChart data={bySat} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="sat" {...axis} tickFormatter={(v) => `${v}%`} height={36} />
            <YAxis {...axis} width={50} tickFormatter={(v) => `${fmt(v, 1)}×`} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)}×`} labelFormatter={(l) => `${l}% per draft token`} />
            <Line dataKey="speedup" stroke={C.prefill} strokeWidth={2.5} />
            <ReferenceLine y={1} stroke={C.error} strokeDasharray="4 4" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['k', ...accs.map((a) => `speedup a=${a}`)]} rows={byK.map((row) => [row.k, ...accs.map((a) => `${fmt(row[`a=${a}`], 3)}×`)])} />
    </SimLayout>
  );
}

export const sims: Record<number, ComponentType> = { 6: SchedulerSim, 7: ChunkedPrefillSim, 8: RouterSim, 9: ItlSim, 10: SpeculativeSim };
