// Production engineering simulators (Q16-Q20). All numbers come from src/engines/g4.ts.
import { useMemo, useState, type ComponentType } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Area,
} from 'recharts';
import { fmt, fmtMs, fmtPct, fmtUsd, mean } from '../engines/core';
import {
  METRICS, STAGES, Z_ALPHA, Z_POWER, autoscale, canary, matrixRuns, rateAtSlo, sampleSizeTwoProp, sloPoint, tailSim, telemetry,
  type ScaleInput, type ScalePolicy, type TailInput, type TelemetryInput, type Verdict,
} from '../engines/g4';
import { C, Callout, ChartBox, Chip, DataTable, Presets, Segmented, SimLayout, Slider, Stat, ValuesTable, axis, grid, tooltipStyle, usePresetState } from '../components/ui';
import type { Kind } from '../types';

const ms = (v: unknown) => fmtMs(Number(v));

// ---------- Q16: observability dashboard ----------

const OBS_NORMAL: TelemetryInput = {
  seed: 16, minutes: 60, baseRps: 20, spikeAt: 30, spikeLen: 8, spikeMult: 1.25, capacityRps: 30, prefillMs: 250, itlMs: 30,
  outTokens: 300, kvCapacityReqs: 600, prefixReuse: 0.4, gpus: 16, gpuHourUsd: 3, ttftSloMs: 2000, maxQueue: 2000,
};
const OBS_PRESETS = {
  normal: OBS_NORMAL,
  stress: { ...OBS_NORMAL, spikeMult: 1.6, prefixReuse: 0.25 },
  failure: { ...OBS_NORMAL, capacityRps: 18, kvCapacityReqs: 300, maxQueue: 600 },
};

function ObservabilitySim() {
  const { s, set, active, pick, reset } = usePresetState(OBS_PRESETS);
  const [minute, setMinute] = useState(34);
  const data = useMemo(() => telemetry(s).map((p) => ({
    ...p, kvPct: p.kvOcc * 100, hitPct: p.prefixHit * 100, usd: Number.isFinite(p.usdPerM) ? p.usdPerM : null,
  })), [s]);
  const sel = data[Math.min(minute, data.length - 1)];
  const worst = data.reduce((a, p) => (p.ttftP99 > a.ttftP99 ? p : a), data[0]);
  const hourAttain = mean(data.map((p) => p.sloAttain));
  const totalTok = data.reduce((a, p) => a + p.completed * 60 * s.outTokens, 0);
  const hourUsdPerM = (s.gpus * s.gpuHourUsd) / (totalTok / 1e6);
  const rejected = data.reduce((a, p) => a + p.rejected * 60, 0);
  const meanOfMeans = mean(data.map((p) => p.ttftMean));
  const cursor = <ReferenceLine x={minute} stroke={C.accent} strokeWidth={2} />;
  const small = 190;
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Selected minute (links all charts)" value={minute} min={0} max={s.minutes - 1} unit="min" onChange={setMinute} />
      <Slider label="Baseline traffic" value={s.baseRps} min={5} max={40} unit="req/s" onChange={(v) => set({ baseRps: v })} />
      <Slider label="Spike multiplier (min 30-37)" value={s.spikeMult} min={1} max={2.5} step={0.05} unit="×" onChange={(v) => set({ spikeMult: v })} />
      <Slider label="Fleet capacity" value={s.capacityRps} min={10} max={60} unit="req/s" onChange={(v) => set({ capacityRps: v })} />
      <Slider label="KV pool holds" value={s.kvCapacityReqs} min={100} max={1500} step={50} unit="req" onChange={(v) => set({ kvCapacityReqs: v })} />
      <Slider label="Reusable prefix share" value={Math.round(s.prefixReuse * 100)} min={0} max={90} unit="%" onChange={(v) => set({ prefixReuse: v / 100 })} />
      <Slider label="TTFT SLO" value={s.ttftSloMs} min={500} max={5000} step={100} unit="ms" onChange={(v) => set({ ttftSloMs: v })} />
    </>}>
      <div className="stats">
        <Stat k={`Worst minute TTFT p99 (min ${worst.t})`} v={fmtMs(worst.ttftP99)} tone={worst.ttftP99 > s.ttftSloMs ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Hour average of mean TTFT" v={fmtMs(meanOfMeans)} tone={meanOfMeans < s.ttftSloMs ? 'good' : 'bad'} ev="simulated" />
        <Stat k="SLO attainment, hour" v={fmtPct(hourAttain)} tone={hourAttain >= 0.99 ? 'good' : hourAttain >= 0.95 ? 'warn' : 'bad'} ev="simulated" />
        <Stat k="Requests rejected" v={fmt(rejected, 0)} tone={rejected > 0 ? 'bad' : 'good'} ev="simulated" />
        <Stat k="$ per M output tokens" v={fmtUsd(hourUsdPerM)} ev="simulated" />
        <Stat k="Peak KV occupancy" v={fmtPct(Math.max(...data.map((p) => p.kvOcc)))} tone={Math.max(...data.map((p) => p.kvOcc)) > 0.9 ? 'warn' : undefined} ev="simulated" />
      </div>
      {meanOfMeans < s.ttftSloMs && worst.ttftP99 > s.ttftSloMs && (
        <Callout tone="warn" title="The mean hides the incident">
          Hour-average mean TTFT {fmtMs(meanOfMeans)} looks inside the {fmtMs(s.ttftSloMs)} SLO, but minute {worst.t} had p99 {fmtMs(worst.ttftP99)}. Alert on percentiles from histograms, per short window.
        </Callout>
      )}
      <ChartBox title="Latency: TTFT mean vs p50 vs p99 (ms), dashed = SLO" height={small}>
        <ResponsiveContainer>
          <LineChart data={data} syncId="obs" margin={{ left: 8, right: 16, top: 4 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" {...axis} />
            <YAxis {...axis} width={64} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={ms} labelFormatter={(l) => `minute ${l}`} />
            <Legend />
            <Line dataKey="ttftMean" name="mean" stroke={C.neutral} dot={false} strokeWidth={2} strokeDasharray="2 3" />
            <Line dataKey="ttftP50" name="p50" stroke={C.decode} dot={false} strokeWidth={2} />
            <Line dataKey="ttftP99" name="p99" stroke={C.error} dot={false} strokeWidth={2.5} />
            <ReferenceLine y={s.ttftSloMs} stroke={C.kv} strokeDasharray="6 4" />
            {cursor}
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Traffic: offered vs completed vs goodput (req/s within SLO)" height={small}>
        <ResponsiveContainer>
          <LineChart data={data} syncId="obs" margin={{ left: 8, right: 16, top: 4 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" {...axis} />
            <YAxis {...axis} width={64} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} req/s`} labelFormatter={(l) => `minute ${l}`} />
            <Legend />
            <Line dataKey="offered" stroke={C.request} dot={false} strokeWidth={2} />
            <Line dataKey="completed" stroke={C.prefill} dot={false} strokeWidth={2} strokeDasharray="6 3" />
            <Line dataKey="goodput" stroke={C.ok} dot={false} strokeWidth={2.5} />
            {cursor}
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Pressure: queue depth (req, left) · KV occupancy and prefix-token hit rate (%, right)" height={small}>
        <ResponsiveContainer>
          <ComposedChart data={data} syncId="obs" margin={{ left: 8, right: 8, top: 4 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" {...axis} />
            <YAxis yAxisId="q" {...axis} width={64} />
            <YAxis yAxisId="p" orientation="right" {...axis} domain={[0, 100]} width={44} />
            <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'queue' ? `${fmt(Number(v), 0)} req` : `${fmt(Number(v), 0)} %`)} labelFormatter={(l) => `minute ${l}`} />
            <Legend />
            <Area yAxisId="q" dataKey="queue" fill={C.request} fillOpacity={0.25} stroke={C.request} />
            <Line yAxisId="p" dataKey="kvPct" name="KV occupancy" stroke={C.kv} dot={false} strokeWidth={2} />
            <Line yAxisId="p" dataKey="hitPct" name="prefix hit" stroke={C.comm} dot={false} strokeWidth={2} strokeDasharray="6 3" />
            <ReferenceLine x={minute} yAxisId="q" stroke={C.accent} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Streaming and cost: token-gap p99 (ms, left) · $ per M output tokens (right)" height={small}>
        <ResponsiveContainer>
          <LineChart data={data} syncId="obs" margin={{ left: 8, right: 8, top: 4 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" {...axis} />
            <YAxis yAxisId="g" {...axis} width={64} />
            <YAxis yAxisId="c" orientation="right" {...axis} width={44} />
            <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'gap p99' ? fmtMs(Number(v)) : fmtUsd(Number(v)))} labelFormatter={(l) => `minute ${l}`} />
            <Legend />
            <Line yAxisId="g" dataKey="gapP99" name="gap p99" stroke={C.decode} dot={false} strokeWidth={2} />
            <Line yAxisId="c" dataKey="usd" name="$/M tokens" stroke={C.kv} dot={false} strokeWidth={2} strokeDasharray="6 3" />
            <ReferenceLine x={minute} yAxisId="g" stroke={C.accent} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable label={`Exact values at minute ${sel.t}`} cols={['Metric', 'Value']} rows={[
        ['Offered / completed / goodput', `${fmt(sel.offered, 1)} / ${fmt(sel.completed, 1)} / ${fmt(sel.goodput, 1)} req/s`],
        ['Rejected', `${fmt(sel.rejected, 2)} req/s`],
        ['TTFT mean / p50 / p99', `${fmtMs(sel.ttftMean)} / ${fmtMs(sel.ttftP50)} / ${fmtMs(sel.ttftP99)}`],
        ['Token gap p99', fmtMs(sel.gapP99)],
        ['Queue depth', `${fmt(sel.queue, 0)} req`],
        ['KV occupancy / prefix hit', `${fmtPct(sel.kvOcc)} / ${fmtPct(sel.prefixHit)}`],
        ['SLO attainment', fmtPct(sel.sloAttain)],
        ['$ / M output tokens', fmtUsd(sel.usdPerM)],
      ]} />
      <h3>Metric catalog</h3>
      <DataTable cols={['Metric', 'Type', 'Unit', 'Labels (bounded)', 'Aggregation', 'Alert intent']}
        rows={METRICS.map((m) => [<code key="n">{m.name}</code>, m.type, m.unit, m.labels, m.agg, m.alert])} />
      <Callout tone="err" title="Never label by request_id, user_id or prompt">
        Each unique label value creates a new time series. Unbounded labels explode storage and query cost; put per-request detail in traces and logs, sampled.
      </Callout>
    </SimLayout>
  );
}

// ---------- Q17: p99 = 10x p50 ----------

const TAIL_NORMAL: TailInput = {
  seed: 17, n: 4000, rps: 24, replicas: 8, svcMs: 150, burst: 1, longFrac: 0.02, longMult: 6, slowFrac: 0, slowMult: 1.3,
  timeoutMs: 4000, retries: false, stallMs: 0, users: 6,
};
const TAIL_PRESETS = {
  normal: TAIL_NORMAL,
  stress: { ...TAIL_NORMAL, burst: 2.5, slowFrac: 0.125, longFrac: 0.08 },
  failure: { ...TAIL_NORMAL, slowFrac: 0.125, slowMult: 3, retries: true, timeoutMs: 1500, stallMs: 3000 },
};
type Fix = 'none' | 'drain slow replica' | 'cap retries' | 'separate long prompts';

function TailSim() {
  const { s, set, active, pick, reset } = usePresetState(TAIL_PRESETS);
  const [fix, setFix] = useState<Fix>('separate long prompts');
  const r = useMemo(() => tailSim(s), [s]);
  const fixed = useMemo(() => tailSim({
    ...s,
    slowFrac: fix === 'drain slow replica' ? 0 : s.slowFrac,
    retries: fix === 'cap retries' ? false : s.retries,
    longFrac: fix === 'separate long prompts' ? 0 : s.longFrac,
  }), [s, fix]);
  const ratio = r.p99 / r.p50;
  const causes = r.byCause.filter((c) => c.count > 0);
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Arrival rate (open loop)" value={s.rps} min={10} max={50} unit="req/s" onChange={(v) => set({ rps: v })} hint="8 replicas" />
      <Slider label="Burstiness" value={s.burst} min={1} max={4} step={0.25} unit="×" onChange={(v) => set({ burst: v })} hint="1 = Poisson" />
      <Slider label="Long-prompt share (6× service)" value={Math.round(s.longFrac * 100)} min={0} max={20} unit="%" onChange={(v) => set({ longFrac: v / 100 })} />
      <Segmented label="Slow replicas (of 8)" value={Math.round(s.slowFrac * 8)} options={[0, 1, 2].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ slowFrac: v / 8 })} />
      <Slider label="Slow replica slowdown" value={s.slowMult} min={1} max={4} step={0.1} unit="×" onChange={(v) => set({ slowMult: v })} />
      <Segmented label="Client retries on timeout" value={s.retries ? 'on' : 'off'} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On (1 retry)' }]} onChange={(v) => set({ retries: v === 'on' })} />
      <Slider label="Client timeout" value={s.timeoutMs} min={500} max={8000} step={100} unit="ms" onChange={(v) => set({ timeoutMs: v })} />
      <Slider label="Fleet stall (GC / network)" value={s.stallMs} min={0} max={5000} step={250} unit="ms" onChange={(v) => set({ stallMs: v })} />
      <Slider label="Closed-loop benchmark users" value={s.users} min={2} max={32} unit="users" onChange={(v) => set({ users: v })} />
    </>}>
      <div className="stats">
        <Stat k="p50" v={fmtMs(r.p50)} ev="simulated" />
        <Stat k="p99" v={fmtMs(r.p99)} tone={ratio > 10 ? 'bad' : ratio > 4 ? 'warn' : 'good'} ev="simulated" />
        <Stat k="p99 / p50" v={`${fmt(ratio, 1)}×`} tone={ratio > 10 ? 'bad' : undefined} ev="simulated" />
        <Stat k="p99.9" v={fmtMs(r.p999)} ev="simulated" />
        <Stat k={`Closed-loop p99 (${s.users} users)`} v={fmtMs(r.closedP99)} tone={r.closedP99 < r.p99 / 2 ? 'warn' : undefined} ev="simulated" />
        <Stat k="Retries (wasted work)" v={`${r.retries}`} unit={r.retries ? `· ${fmt(r.wastedMs / 1000, 0)} s GPU` : ''} tone={r.retries > 0 ? 'bad' : 'good'} ev="simulated" />
      </div>
      {r.closedP99 < r.p99 / 2 && (
        <Callout tone="warn" title="Coordinated omission">
          A closed-loop load tester waits for each response before sending the next, so it sends fewer requests exactly when the system is slow. It reports p99 {fmtMs(r.closedP99)}; open-loop users see {fmtMs(r.p99)}.
        </Callout>
      )}
      <div className="grid-2">
        <ChartBox title="Latency histogram (log-spaced bins, count)" height={230}>
          <ResponsiveContainer>
            <BarChart data={r.hist} margin={{ left: 0, right: 8, top: 4 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="bin" {...axis} interval={3} />
              <YAxis {...axis} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v) => `${v} requests`} labelFormatter={(l) => `from ${l} ms`} />
              <Bar dataKey="count" fill={C.request}>
                {r.hist.map((h) => <Cell key={h.lo} fill={h.lo >= r.p99 ? C.error : h.lo >= r.p50 * 2 ? C.kv : C.request} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="CDF: latency (ms, log) at each percentile" height={230}>
          <ResponsiveContainer>
            <LineChart data={r.cdf} margin={{ left: 8, right: 8, top: 4 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="q" {...axis} type="number" domain={[0, 100]} unit="%" />
              <YAxis {...axis} scale="log" domain={['auto', 'auto']} width={60} tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip {...tooltipStyle} formatter={ms} labelFormatter={(l) => `p${l}`} />
              <Line dataKey="ms" stroke={C.prefill} dot={false} strokeWidth={2.5} />
              <ReferenceLine x={50} stroke={C.decode} strokeDasharray="4 3" />
              <ReferenceLine x={98} stroke={C.error} strokeDasharray="4 3" />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
      <div className="grid-2">
        <ChartBox title="Stratify: p99 by request group (ms)" height={230}>
          <ResponsiveContainer>
            <BarChart data={causes} layout="vertical" margin={{ left: 8, right: 24 }}>
              <CartesianGrid {...grid} horizontal={false} />
              <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} />
              <YAxis type="category" dataKey="cause" {...axis} width={100} />
              <Tooltip {...tooltipStyle} formatter={ms} />
              <Bar dataKey="p99" name="p99">
                {causes.map((c) => <Cell key={c.cause} fill={c.cause === 'all' ? C.neutral : c.p99 > r.p99 ? C.error : C.decode} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="Σ component p99s ≠ end-to-end p99 (ms)" height={230}>
          <ResponsiveContainer>
            <BarChart data={[
              { name: 'Σ of p99s', ...Object.fromEntries(r.comps.map((c) => [c.name, c.p99])) },
              { name: 'end-to-end p99', e2e: r.e2eP99 },
            ]} margin={{ left: 8, right: 8, top: 4 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="name" {...axis} />
              <YAxis {...axis} width={60} tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip {...tooltipStyle} formatter={ms} />
              <Legend />
              <Bar dataKey="gateway" stackId="a" fill={C.request} />
              <Bar dataKey="queue wait" stackId="a" fill={C.kv} />
              <Bar dataKey="service" stackId="a" fill={C.prefill} />
              <Bar dataKey="network" stackId="a" fill={C.comm} />
              <Bar dataKey="e2e" name="measured e2e p99" stackId="a" fill={C.error} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
      <div className="card raised stack" style={{ padding: 18 }}>
        <Segmented<Fix> label="Prove it: apply one intervention, same seed and arrivals" value={fix}
          options={(['drain slow replica', 'cap retries', 'separate long prompts'] as Fix[]).map((v) => ({ value: v, label: v }))} onChange={setFix} />
        <div className="stats">
          <Stat k="p99 before" v={fmtMs(r.p99)} ev="simulated" />
          <Stat k="p99 after" v={fmtMs(fixed.p99)} tone={fixed.p99 < r.p99 * 0.7 ? 'good' : 'warn'} ev="simulated" />
          <Stat k="Change" v={fmtPct(fixed.p99 / r.p99 - 1)} tone={fixed.p99 < r.p99 * 0.7 ? 'good' : undefined} ev="simulated" />
        </div>
        <p className="small muted">A diagnosis is proven when removing the suspected cause moves p99 by more than run-to-run noise (re-run 5 seeds) and the alternative causes do not.</p>
      </div>
      <ValuesTable cols={['Group', 'Requests', 'p50', 'p99']} rows={r.byCause.map((c) => [c.cause, c.count, fmtMs(c.p50), fmtMs(c.p99)])} />
    </SimLayout>
  );
}

// ---------- Q18: engine benchmark design ----------

const CONTROLS = [
  'Model weights + tokenizer', 'GPU type + topology', 'Precision / quantization', 'Input/output length distribution',
  'Open-loop arrival trace', 'Cache warmness + prefix policy', 'Equal tuning budget', 'Versions + flags recorded',
];
interface BenchState {
  engines: string[]; configs: number; rates: number; reps: number; durationS: number; gpus: number; controlled: string[];
  capA: number; baseA: number; capB: number; baseB: number; outTokens: number; sloMs: number;
}
const BENCH_NORMAL: BenchState = {
  engines: ['vLLM', 'TensorRT-LLM', 'SGLang'], configs: 2, rates: 8, reps: 5, durationS: 300, gpus: 8, controlled: CONTROLS,
  capA: 12_000, baseA: 250, capB: 15_000, baseB: 700, outTokens: 300, sloMs: 2000,
};
const BENCH_PRESETS = {
  normal: BENCH_NORMAL,
  stress: { ...BENCH_NORMAL, sloMs: 900 },
  failure: { ...BENCH_NORMAL, reps: 1, rates: 1, controlled: CONTROLS.slice(0, 3) },
};

function BenchSim() {
  const { s, set, active, pick, reset } = usePresetState(BENCH_PRESETS);
  const A = { capacityTokS: s.capA, baseTtftMs: s.baseA };
  const B = { capacityTokS: s.capB, baseTtftMs: s.baseB };
  const maxRate = (Math.max(s.capA, s.capB) / s.outTokens) * 1.1;
  const curve = Array.from({ length: 41 }, (_, k) => {
    const rate = (maxRate * k) / 40;
    const a = sloPoint(A, s.outTokens, s.sloMs, rate);
    const b = sloPoint(B, s.outTokens, s.sloMs, rate);
    return {
      rate: +rate.toFixed(2),
      'A p99 TTFT': a.overload ? null : Math.min(a.ttftP99, s.sloMs * 4), 'B p99 TTFT': b.overload ? null : Math.min(b.ttftP99, s.sloMs * 4),
      'A goodput': a.goodTokS, 'B goodput': b.goodTokS, offered: a.offeredTokS,
    };
  });
  const rA = rateAtSlo(A, s.outTokens, s.sloMs);
  const rB = rateAtSlo(B, s.outTokens, s.sloMs);
  const runs = matrixRuns(s.engines.length, s.configs, s.rates, s.reps);
  const gpuHours = (runs * (s.durationS + 60) * s.gpus) / 3600;
  const missing = CONTROLS.filter((c) => !s.controlled.includes(c));
  const toggle = (list: string[], x: string) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <div className="ctl" role="group" aria-label="Engines">
        <span style={{ fontSize: 15, fontWeight: 500 }}>Engines under test</span>
        <div className="seg">{['vLLM', 'TensorRT-LLM', 'SGLang'].map((e) => (
          <button key={e} type="button" aria-pressed={s.engines.includes(e)} onClick={() => set({ engines: toggle(s.engines, e) })}>{e}</button>
        ))}</div>
      </div>
      <Slider label="Configs per engine" value={s.configs} min={1} max={4} onChange={(v) => set({ configs: v })} />
      <Slider label="Arrival rates in sweep" value={s.rates} min={1} max={12} onChange={(v) => set({ rates: v })} />
      <Slider label="Repetitions per point" value={s.reps} min={1} max={10} onChange={(v) => set({ reps: v })} />
      <div className="ctl" role="group" aria-label="Controlled variables">
        <span style={{ fontSize: 15, fontWeight: 500 }}>Held constant across engines</span>
        <div className="seg">{CONTROLS.map((c) => (
          <button key={c} type="button" className="btn-sm" aria-pressed={s.controlled.includes(c)} onClick={() => set({ controlled: toggle(s.controlled, c) })}>{s.controlled.includes(c) ? '✓ ' : '✕ '}{c}</button>
        ))}</div>
      </div>
      <hr className="divider" />
      <span className="small muted">Illustrative model: two generic configurations</span>
      <Slider label="A: saturation throughput" value={s.capA} min={2000} max={30000} step={500} unit="tok/s" onChange={(v) => set({ capA: v })} />
      <Slider label="A: empty-queue TTFT" value={s.baseA} min={50} max={1500} step={25} unit="ms" onChange={(v) => set({ baseA: v })} />
      <Slider label="B: saturation throughput" value={s.capB} min={2000} max={30000} step={500} unit="tok/s" onChange={(v) => set({ capB: v })} />
      <Slider label="B: empty-queue TTFT" value={s.baseB} min={50} max={1500} step={25} unit="ms" onChange={(v) => set({ baseB: v })} />
      <Slider label="TTFT p99 SLO" value={s.sloMs} min={300} max={5000} step={100} unit="ms" onChange={(v) => set({ sloMs: v })} />
    </>}>
      <Callout tone="warn" title="Illustrative model, not engine data">
        A and B are generic configurations with editable parameters. No vLLM, TensorRT-LLM or SGLang result is shown or implied: measure them with labs/benchmark.py.
      </Callout>
      <div className="stats">
        <Stat k="Runs in matrix" v={fmt(runs, 0)} ev="calculated" />
        <Stat k="GPU-hours (incl. 60 s warm-up)" v={fmt(gpuHours, 0)} ev="calculated" />
        <Stat k="Uncontrolled variables" v={missing.length} tone={missing.length ? 'bad' : 'good'} ev="calculated" />
        <Stat k="A: rate at SLO" v={fmt(rA, 1)} unit="req/s" ev="simulated" tone={rA >= rB ? 'good' : undefined} />
        <Stat k="B: rate at SLO" v={fmt(rB, 1)} unit="req/s" ev="simulated" tone={rB > rA ? 'good' : undefined} />
        <Stat k="Peak throughput winner" v={s.capA >= s.capB ? 'A' : 'B'} unit={((s.capA >= s.capB) === (rA >= rB)) ? 'same as SLO' : '≠ SLO winner'} tone={((s.capA >= s.capB) === (rA >= rB)) ? undefined : 'warn'} ev="simulated" />
      </div>
      {(missing.length > 0 || s.reps < 3) && (
        <Callout tone="err" title="This comparison is not valid yet">
          {missing.length > 0 && <>Not controlled: {missing.join(', ')}. </>}
          {s.reps < 3 && <>Fewer than 3 repetitions: no uncertainty estimate.</>}
        </Callout>
      )}
      <div className="card raised" style={{ padding: 16 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>Experiment matrix ({s.engines.length} engines × {s.configs} configs × {s.rates} rates × {s.reps} reps)</div>
        <div className="chips">
          {s.engines.flatMap((e) => Array.from({ length: s.configs }, (_, c) => <Chip key={e + c} kind="request" label={`${e} · cfg ${c + 1}`} note={`${s.rates * s.reps} runs`} />))}
        </div>
      </div>
      <ChartBox title="p99 TTFT vs arrival rate (ms) — gaps = overload, queue unbounded" height={250}>
        <ResponsiveContainer>
          <LineChart data={curve} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="rate" type="number" {...axis} domain={[0, 'dataMax']} label={{ value: 'req/s', position: 'insideBottomRight', offset: -4, fill: 'var(--muted)' }} />
            <YAxis {...axis} width={60} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={ms} labelFormatter={(l) => `${l} req/s`} />
            <Legend />
            <Line dataKey="A p99 TTFT" stroke={C.prefill} dot={false} strokeWidth={2.5} connectNulls={false} />
            <Line dataKey="B p99 TTFT" stroke={C.decode} dot={false} strokeWidth={2.5} strokeDasharray="6 3" connectNulls={false} />
            <ReferenceLine y={s.sloMs} stroke={C.kv} strokeDasharray="6 4" label={{ value: 'SLO', fill: 'var(--c-kv)', position: 'right' }} />
            <ReferenceLine x={+rA.toFixed(2)} stroke={C.prefill} strokeDasharray="2 3" />
            <ReferenceLine x={+rB.toFixed(2)} stroke={C.decode} strokeDasharray="2 3" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Goodput: output tokens/s delivered within SLO" height={230}>
        <ResponsiveContainer>
          <LineChart data={curve} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="rate" type="number" {...axis} domain={[0, 'dataMax']} />
            <YAxis {...axis} width={60} tickFormatter={(v) => fmt(v, 0)} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 0)} tok/s`} labelFormatter={(l) => `${l} req/s`} />
            <Legend />
            <Line dataKey="offered" stroke={C.neutral} dot={false} strokeDasharray="2 3" />
            <Line dataKey="A goodput" stroke={C.prefill} dot={false} strokeWidth={2.5} />
            <Line dataKey="B goodput" stroke={C.decode} dot={false} strokeWidth={2.5} strokeDasharray="6 3" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Config', 'Saturation tok/s', 'Empty TTFT', 'Rate at SLO', 'Tokens/s at SLO']} rows={[
        ['A', fmt(s.capA, 0), fmtMs(s.baseA), `${fmt(rA, 2)} req/s`, fmt(rA * s.outTokens, 0)],
        ['B', fmt(s.capB, 0), fmtMs(s.baseB), `${fmt(rB, 2)} req/s`, fmt(rB * s.outTokens, 0)],
      ]} />
    </SimLayout>
  );
}

// ---------- Q19: rollout gates ----------

interface RolloutState {
  seed: number; baseQuality: number; drop: number; baseErr: number; errIncrease: number; reqPerHour: number; holdHours: number;
  offlineN: number; shadowFrac: number; alpha: string; power: string; mde: number; errThreshold: number; sloAvail: number;
}
const RO_NORMAL: RolloutState = {
  seed: 19, baseQuality: 0.9, drop: 0, baseErr: 0.002, errIncrease: 0, reqPerHour: 50_000, holdHours: 2, offlineN: 3000,
  shadowFrac: 0.05, alpha: '0.05', power: '0.8', mde: 0.02, errThreshold: 0.01, sloAvail: 0.999,
};
const RO_PRESETS = {
  normal: RO_NORMAL,
  stress: { ...RO_NORMAL, drop: 0.02, offlineN: 1000 },
  failure: { ...RO_NORMAL, drop: 0.02, holdHours: 0.25, offlineN: 300, shadowFrac: 0 },
};
const VERDICT_KIND: Record<Verdict, Kind> = { pass: 'ok', underpowered: 'kv', rollback: 'error', 'not reached': 'neutral' };

function RolloutSim() {
  const { s, set, active, pick, reset } = usePresetState(RO_PRESETS);
  const zA = Z_ALPHA[s.alpha];
  const need = sampleSizeTwoProp(s.baseQuality, s.baseQuality - s.mde, zA, Z_POWER[s.power]);
  const r = canary({ ...s, zA, minSamples: need });
  const caught = r.rollbackAt != null ? r.stages[r.rollbackAt].name : null;
  const live = r.stages.filter((x) => x.frac > 0 && x.verdict !== 'not reached');
  const peakBurn = Math.max(0, ...live.map((x) => x.burn));
  const chart = r.stages.map((x) => ({ name: x.name, z: Number.isFinite(x.z) ? x.z : 0, n: x.n, verdict: x.verdict }));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="True quality drop (injected)" value={+(s.drop * 100).toFixed(1)} min={0} max={10} step={0.5} unit="pp" onChange={(v) => set({ drop: v / 100 })} />
      <Slider label="True error-rate increase" value={+(s.errIncrease * 100).toFixed(1)} min={0} max={3} step={0.1} unit="pp" onChange={(v) => set({ errIncrease: v / 100 })} />
      <Slider label="Baseline task pass rate" value={Math.round(s.baseQuality * 100)} min={60} max={99} unit="%" onChange={(v) => set({ baseQuality: v / 100 })} />
      <Slider label="Live traffic" value={s.reqPerHour} min={1000} max={200_000} step={1000} unit="req/h" onChange={(v) => set({ reqPerHour: v })} />
      <Slider label="Hold per stage" value={s.holdHours} min={0.25} max={6} step={0.25} unit="h" onChange={(v) => set({ holdHours: v })} />
      <Slider label="Offline eval set" value={s.offlineN} min={100} max={10_000} step={100} unit="items" onChange={(v) => set({ offlineN: v })} />
      <Slider label="Shadow mirror share" value={Math.round(s.shadowFrac * 100)} min={0} max={20} unit="%" onChange={(v) => set({ shadowFrac: v / 100 })} />
      <Slider label="Smallest drop we must detect" value={+(s.mde * 100).toFixed(1)} min={0.5} max={5} step={0.5} unit="pp" onChange={(v) => set({ mde: v / 100 })} />
      <Segmented label="One-sided α" value={s.alpha} options={['0.05', '0.01'].map((v) => ({ value: v, label: v }))} onChange={(v) => set({ alpha: v })} />
      <Segmented label="Power" value={s.power} options={['0.8', '0.9'].map((v) => ({ value: v, label: v }))} onChange={(v) => set({ power: v })} />
      <Slider label="Random seed (re-run noise)" value={s.seed} min={1} max={50} onChange={(v) => set({ seed: v })} />
    </>}>
      <div className="stats">
        <Stat k={`Samples per arm for ${fmt(s.mde * 100, 1)} pp drop`} v={fmt(need, 0)} ev="calculated" />
        <Stat k="Rollback triggered at" v={caught ?? 'none'} tone={caught ? (s.drop > 0 || s.errIncrease > 0 ? 'good' : 'warn') : s.drop > 0 || s.errIncrease > 0 ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Live requests on new version" v={fmt(r.exposedTotal, 0)} tone={s.drop > 0 && r.exposedTotal > 10_000 ? 'bad' : undefined} ev="simulated" />
        <Stat k="Peak error-budget burn rate" v={`${fmt(peakBurn, 1)}×`} tone={peakBurn > 2 ? 'bad' : 'good'} ev="simulated" />
      </div>
      {s.drop > 0 && !caught && <Callout tone="err" title="Regression escaped">Every gate passed or was underpowered. Lengthen holds, enlarge the offline set, or lower the minimum detectable drop.</Callout>}
      <div className="card raised" style={{ padding: 16 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>Release state machine (✓ pass · ■ underpowered · ✕ rollback · ○ not reached)</div>
        <div className="chips" style={{ alignItems: 'center' }}>
          {r.stages.map((x, k) => (
            <span key={x.name} className="row" style={{ gap: 6 }}>
              {k > 0 && <span className="arrow" aria-hidden="true">→</span>}
              <Chip kind={VERDICT_KIND[x.verdict]} label={x.name} note={`${x.verdict} · n=${fmt(x.n, 0)}`} />
            </span>
          ))}
          {caught && <><span className="arrow" aria-hidden="true">↩</span><Chip kind="error" label="Rollback to previous version" note="warm capacity kept" /></>}
        </div>
      </div>
      <div className="grid-2">
        <ChartBox title={`Quality gate: z-score per stage (trips above ${zA})`} height={240}>
          <ResponsiveContainer>
            <BarChart data={chart} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="name" {...axis} interval={0} angle={-20} textAnchor="end" height={56} />
              <YAxis {...axis} width={40} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v), 2)} />
              <Bar dataKey="z">{chart.map((c) => <Cell key={c.name} fill={c.verdict === 'rollback' ? C.error : c.verdict === 'underpowered' ? C.kv : c.verdict === 'pass' ? C.ok : C.neutral} />)}</Bar>
              <ReferenceLine y={zA} stroke={C.error} strokeDasharray="6 4" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="Samples per stage vs samples needed" height={240}>
          <ResponsiveContainer>
            <BarChart data={chart} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="name" {...axis} interval={0} angle={-20} textAnchor="end" height={56} />
              <YAxis {...axis} scale="log" domain={[10, 'auto']} allowDataOverflow width={56} tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v), 0)} />
              <Bar dataKey="n" fill={C.request}>{chart.map((c) => <Cell key={c.name} fill={c.n >= need ? C.request : C.kv} />)}</Bar>
              <ReferenceLine y={need} stroke={C.accent} strokeDasharray="6 4" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
      <ValuesTable cols={['Stage', 'Traffic', 'n', 'Baseline pass', 'New pass', 'z', 'Error rate', 'Burn', 'Verdict']} rows={r.stages.map((x, k) => [
        x.name, STAGES[k].shadow ? 'mirrored' : fmtPct(x.frac, 0), fmt(x.n, 0), fmtPct(x.baseObs), fmtPct(x.canObs), fmt(x.z, 2),
        x.frac > 0 ? fmtPct(x.errObs, 2) : '—', x.frac > 0 ? `${fmt(x.burn, 1)}×` : '—', x.verdict,
      ])} />
    </SimLayout>
  );
}

// ---------- Q20: autoscaling with startup lag ----------

const SC_NORMAL: ScaleInput = {
  seed: 20, minutes: 40, baseTokS: 20_000, spikeMult: 3, spikeAtMin: 10, spikeLenMin: 15, rampSec: 60, perReplicaTokS: 5000,
  minReplicas: 2, targetUtil: 0.7, detectSec: 60, startupSec: 480, warmPool: 6, warmSec: 30, forecastLeadMin: 10, forecastAccuracy: 1,
  maxQueueSec: 30, sloWaitSec: 5, scaleDownUtil: 0.35, cooldownSec: 300, policy: 'reactive',
};
const SC_PRESETS = {
  normal: SC_NORMAL,
  stress: { ...SC_NORMAL, spikeMult: 5, rampSec: 15, policy: 'warmpool' as ScalePolicy },
  failure: { ...SC_NORMAL, startupSec: 900, detectSec: 120, scaleDownUtil: 0.6, cooldownSec: 60 },
};

function AutoscaleSim() {
  const { s, set, active, pick, reset } = usePresetState(SC_PRESETS);
  const all = useMemo(() => (['reactive', 'warmpool', 'forecast'] as ScalePolicy[]).map((p) => ({ p, r: autoscale({ ...s, policy: p }) })), [s]);
  const r = all.find((x) => x.p === s.policy)!.r;
  const data = r.points.map((p) => ({ t: +p.t.toFixed(2), demand: p.demand / 1000, capacity: p.capacity / 1000, wait: Math.min(p.waitSec, 60), ready: p.replicas, pending: p.pending }));
  // Contiguous SLO-violation windows, shaded on the timeline.
  const bands: [number, number][] = [];
  r.points.forEach((p, k) => {
    if (!p.violating) return;
    const prev = bands[bands.length - 1];
    if (prev && Math.abs(prev[1] - r.points[k - 1]?.t) < 1e-9) prev[1] = p.t; else bands.push([p.t, p.t]);
  });
  const names: Record<ScalePolicy, string> = { reactive: 'Reactive', warmpool: 'Warm pool', forecast: 'Forecast pre-scale' };
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented<ScalePolicy> label="Policy" value={s.policy} options={(['reactive', 'warmpool', 'forecast'] as ScalePolicy[]).map((v) => ({ value: v, label: names[v] }))} onChange={(v) => set({ policy: v })} />
      <Slider label="Spike size (min 10-25)" value={s.spikeMult} min={1} max={6} step={0.25} unit="×" onChange={(v) => set({ spikeMult: v })} />
      <Slider label="Spike ramp" value={s.rampSec} min={5} max={600} step={5} unit="s" onChange={(v) => set({ rampSec: v })} />
      <Slider label="Cold start (provision → ready)" value={s.startupSec} min={60} max={1200} step={30} unit="s" onChange={(v) => set({ startupSec: v })} />
      <Slider label="Detection delay" value={s.detectSec} min={15} max={300} step={15} unit="s" onChange={(v) => set({ detectSec: v })} />
      <Slider label="Warm pool size" value={s.warmPool} min={0} max={20} unit="replicas" onChange={(v) => set({ warmPool: v })} />
      <Slider label="Forecast accuracy (peak)" value={Math.round(s.forecastAccuracy * 100)} min={50} max={150} step={5} unit="%" onChange={(v) => set({ forecastAccuracy: v / 100 })} />
      <Slider label="Forecast lead" value={s.forecastLeadMin} min={0} max={30} unit="min" onChange={(v) => set({ forecastLeadMin: v })} />
      <Slider label="Target utilisation" value={Math.round(s.targetUtil * 100)} min={40} max={90} unit="%" onChange={(v) => set({ targetUtil: v / 100 })} />
      <Slider label="Queue bound (then shed)" value={s.maxQueueSec} min={5} max={120} step={5} unit="s" onChange={(v) => set({ maxQueueSec: v })} />
      <Slider label="Scale-down below" value={Math.round(s.scaleDownUtil * 100)} min={10} max={65} unit="%" onChange={(v) => set({ scaleDownUtil: v / 100 })} />
      <Slider label="Scale-down cooldown" value={s.cooldownSec} min={30} max={900} step={30} unit="s" onChange={(v) => set({ cooldownSec: v })} />
    </>}>
      <div className="stats">
        <Stat k="SLO-violation minutes" v={fmt(r.violationMin, 1)} unit="min" tone={r.violationMin > 1 ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Tokens shed (admission)" v={fmt(r.shedTokens / 1e6, 1)} unit="M tok" tone={r.shedTokens > 0 ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Replica-minutes billed" v={fmt(r.replicaMinutes, 0)} ev="simulated" />
        <Stat k="Peak queue wait" v={fmt(r.peakWaitSec, 0)} unit="s" tone={r.peakWaitSec > s.sloWaitSec ? 'warn' : 'good'} ev="simulated" />
      </div>
      <ChartBox title="Demand vs ready capacity (k tokens/s) · shaded = SLO violated" height={250}>
        <ResponsiveContainer>
          <ComposedChart data={data} syncId="scale" margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" type="number" domain={[0, s.minutes]} {...axis} unit=" min" />
            <YAxis yAxisId="tok" {...axis} width={48} />
            <YAxis yAxisId="w" orientation="right" {...axis} width={40} unit="s" />
            <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'queue wait' ? `${fmt(Number(v), 1)} s` : `${fmt(Number(v), 1)} k tok/s`)} labelFormatter={(l) => `${l} min`} />
            <Legend />
            {bands.map(([a, b]) => <ReferenceArea key={a} yAxisId="tok" x1={a} x2={b + 5 / 60} fill={C.error} fillOpacity={0.15} />)}
            <Line yAxisId="tok" dataKey="demand" stroke={C.request} dot={false} strokeWidth={2} />
            <Line yAxisId="tok" dataKey="capacity" type="stepAfter" stroke={C.decode} dot={false} strokeWidth={2.5} />
            <Area yAxisId="w" dataKey="wait" name="queue wait" stroke={C.kv} fill={C.kv} fillOpacity={0.2} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Replicas: ready vs still starting" height={200}>
        <ResponsiveContainer>
          <ComposedChart data={data} syncId="scale" margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="t" type="number" domain={[0, s.minutes]} {...axis} unit=" min" />
            <YAxis {...axis} width={48} allowDecimals={false} />
            <Tooltip {...tooltipStyle} labelFormatter={(l) => `${l} min`} />
            <Legend />
            <Area dataKey="ready" type="stepAfter" stackId="r" stroke={C.decode} fill={C.decode} fillOpacity={0.35} />
            <Area dataKey="pending" name="starting" type="stepAfter" stackId="r" stroke={C.kv} fill={C.kv} fillOpacity={0.25} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Same trace, three policies: SLO minutes vs replica-minutes" height={220}>
        <ResponsiveContainer>
          <BarChart data={all.map(({ p, r: x }) => ({ name: names[p], 'violation min': +x.violationMin.toFixed(1), 'replica-min / 100': +(x.replicaMinutes / 100).toFixed(1) }))} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} />
            <YAxis {...axis} width={40} />
            <Tooltip {...tooltipStyle} />
            <Legend />
            <Bar dataKey="violation min" fill={C.error} />
            <Bar dataKey="replica-min / 100" fill={C.prefill} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Policy', 'SLO min', 'Shed (M tok)', 'Replica-min', 'Peak wait']} rows={all.map(({ p, r: x }) => [
        names[p], fmt(x.violationMin, 1), fmt(x.shedTokens / 1e6, 2), fmt(x.replicaMinutes, 0), `${fmt(x.peakWaitSec, 1)} s`,
      ])} />
    </SimLayout>
  );
}

export const sims: Record<number, ComponentType> = { 16: ObservabilitySim, 17: TailSim, 18: BenchSim, 19: RolloutSim, 20: AutoscaleSim };
