// Systems design simulators (Q21-Q25).
import type { ComponentType } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { GiB, fmt, fmtBytes, fmtMs, fmtPct, fmtUsd } from '../engines/core';
import {
  capScenarios, capSensitivity, capacity, costPlan, disagg, disaggBreakEven, moeActiveB, moeParallel, moeToy, runFair,
  type CapInput, type CostInput, type DisaggInput, type FairPolicy, type Intervention, type Tenant,
} from '../engines/g5';
import { C, ChartBox, Chip, KindLegend, Presets, Segmented, SimLayout, Slider, Stat, ValuesTable, axis, grid, tooltipStyle, usePresetState } from '../components/ui';

const POLICY_LABEL: Record<FairPolicy, string> = { fcfs: 'FCFS', rr: 'Request RR', drr: 'Token DRR' };
const POLICY_COLOR: Record<FairPolicy, string> = { fcfs: C.error, rr: C.kv, drr: C.decode };

// ---------- Q21: fair multi-tenant scheduler ----------

interface FairState { capacity: number; bRate: number; bTokens: number; cWeight: number; queueCap: number; bRateLimit: number; seed: number; policy: FairPolicy }
const FAIR_NORMAL: FairState = { capacity: 1400, bRate: 0.25, bTokens: 2000, cWeight: 2, queueCap: 40, bRateLimit: 2, seed: 11, policy: 'drr' };
const FAIR_PRESETS = {
  normal: FAIR_NORMAL,
  stress: { ...FAIR_NORMAL, bRate: 1, bTokens: 3000 },
  failure: { ...FAIR_NORMAL, bRate: 2, bTokens: 4000, queueCap: 5000, bRateLimit: 10, policy: 'fcfs' as FairPolicy },
};

function FairSim() {
  const { s, set, active, pick, reset } = usePresetState(FAIR_PRESETS);
  const tenants: Tenant[] = [
    { name: 'A chat', weight: 1, meanTokens: 200, rate: 1.5, rateLimit: 4, queueCap: s.queueCap },
    { name: 'B batch', weight: 1, meanTokens: s.bTokens, rate: s.bRate, rateLimit: s.bRateLimit, queueCap: s.queueCap },
    { name: 'C premium', weight: s.cWeight, meanTokens: 400, rate: 0.8, rateLimit: 4, queueCap: s.queueCap },
  ];
  const inp = { tenants, capacity: s.capacity, ticks: 240, seed: s.seed, quantum: 200 };
  const runs = (['fcfs', 'rr', 'drr'] as FairPolicy[]).map((p) => runFair(inp, p));
  const sel = runs.find((r) => r.policy === s.policy)!;
  const offered = tenants.reduce((a, t) => a + t.rate * t.meanTokens, 0);
  const shareData = tenants.map((t, k) => ({ tenant: t.name, ...Object.fromEntries(runs.map((r) => [POLICY_LABEL[r.policy], +(r.tenants[k].share * 100).toFixed(2)])) }));
  const waitData = tenants.map((t, k) => ({ tenant: t.name, ...Object.fromEntries(runs.map((r) => [POLICY_LABEL[r.policy], r.tenants[k].p95Wait])) }));
  const bars = (['fcfs', 'rr', 'drr'] as FairPolicy[]).map((p, i) => (
    <Bar key={p} dataKey={POLICY_LABEL[p]} fill={POLICY_COLOR[p]} fillOpacity={[0.55, 0.75, 1][i]} />
  ));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Detail policy" value={s.policy} options={(['fcfs', 'rr', 'drr'] as FairPolicy[]).map((p) => ({ value: p, label: POLICY_LABEL[p] }))} onChange={(v) => set({ policy: v })} />
      <Slider label="Cluster capacity" value={s.capacity} min={400} max={4000} step={100} unit="tok/tick" onChange={(v) => set({ capacity: v })} />
      <Slider label="Tenant B arrivals" value={s.bRate} min={0} max={3} step={0.05} unit="req/tick" onChange={(v) => set({ bRate: v })} />
      <Slider label="Tenant B request size" value={s.bTokens} min={200} max={8000} step={100} unit="tokens" onChange={(v) => set({ bTokens: v })} />
      <Slider label="Tenant B rate limit" value={s.bRateLimit} min={0.25} max={10} step={0.25} unit="req/tick" onChange={(v) => set({ bRateLimit: v })} />
      <Slider label="Tenant C weight" value={s.cWeight} min={1} max={4} step={0.5} onChange={(v) => set({ cWeight: v })} />
      <Slider label="Max requests in system / tenant" value={s.queueCap} min={2} max={5000} step={1} unit="req" onChange={(v) => set({ queueCap: v })} hint="bounded queue" />
      <Slider label="Trace seed" value={s.seed} min={1} max={99} onChange={(v) => set({ seed: v })} />
    </>}>
      <div className="stats">
        <Stat k="Offered / capacity" v={fmtPct(offered / s.capacity, 0)} tone={offered > s.capacity ? 'bad' : 'good'} ev="calculated" />
        <Stat k={`A chat p95 wait (${POLICY_LABEL[s.policy]})`} v={fmt(sel.tenants[0].p95Wait, 0)} unit="ticks" tone={sel.tenants[0].p95Wait > 10 ? 'bad' : 'good'} ev="simulated" />
        <Stat k={`C premium p95 wait`} v={fmt(sel.tenants[2].p95Wait, 0)} unit="ticks" ev="simulated" />
        <Stat k="B rejected" v={sel.tenants[1].rejected} unit={`of ${sel.tenants[1].arrived}`} tone={sel.tenants[1].rejected ? 'warn' : undefined} ev="simulated" />
        <Stat k="Idle ticks with backlog" v={sel.idleWithBacklog} tone={sel.idleWithBacklog ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Work check" v={sel.servedTotal + sel.backlogEnd === sel.admittedWork ? 'balanced' : 'MISMATCH'} tone="good" ev="simulated" />
      </div>
      <ChartBox title="Share of served tokens by tenant (%), same seeded trace, three policies" height={250}>
        <ResponsiveContainer>
          <BarChart data={shareData} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="tenant" {...axis} />
            <YAxis {...axis} unit="%" width={52} domain={[0, 100]} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} %`} />
            <Legend />
            {bars}
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="p95 wait to first service (ticks) — lower is better" height={250}
        legend={<span className="small muted">Unfinished requests count with their censored wait, so starvation is visible.</span>}>
        <ResponsiveContainer>
          <BarChart data={waitData} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="tenant" {...axis} />
            <YAxis {...axis} width={52} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 0)} ticks`} />
            <Legend />
            {bars}
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Policy', 'Tenant', 'Arrived', 'Admitted', 'Rejected', 'Completed', 'Served tokens', 'Share', 'p95 wait']}
        rows={runs.flatMap((r) => r.tenants.map((t) => [POLICY_LABEL[r.policy], t.name, t.arrived, t.admitted, t.rejected, t.completed, t.servedTokens.toLocaleString('en-US'), fmtPct(t.share), fmt(t.p95Wait, 0)]))} />
    </SimLayout>
  );
}

// ---------- Q22: disaggregated prefill / decode ----------

const DIS_NORMAL: DisaggInput = { promptTokens: 8192, outputTokens: 512, kvBytes: 2, linkGBps: 50, concurrentTransfers: 1, setupMs: 2, overlap: 0.8, prefillTps: 20_000, itlMs: 30, interference: 0.3 };
const DIS_PRESETS = {
  normal: DIS_NORMAL,
  stress: { ...DIS_NORMAL, concurrentTransfers: 16, promptTokens: 32768 },
  failure: { ...DIS_NORMAL, promptTokens: 32768, outputTokens: 16, linkGBps: 5, interference: 0.05 },
};

function DisaggSim() {
  const { s, set, active, pick, reset } = usePresetState(DIS_PRESETS);
  const r = disagg(s);
  const be = disaggBreakEven(s);
  const decodeMono = r.e2eMono - r.prefillMs;
  const decodeDis = r.e2eDisagg - r.prefillMs - r.exposedTransferMs;
  const timeline = [
    { name: 'Monolithic', Prefill: r.prefillMs / 1000, 'KV transfer (exposed)': 0, Decode: decodeMono / 1000 },
    { name: 'Disaggregated', Prefill: r.prefillMs / 1000, 'KV transfer (exposed)': r.exposedTransferMs / 1000, Decode: decodeDis / 1000 },
  ];
  const sweep = [1024, 4096, 8192, 16384, 32768, 65536, 131072].map((p) => {
    const x = disagg({ ...s, promptTokens: p });
    return { p, label: `${p / 1024}K`, delta: x.deltaMs / 1000, transfer: x.exposedTransferMs / 1000 };
  });
  const wins = r.deltaMs < 0;
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Prompt (cached) tokens" value={s.promptTokens} min={512} max={131072} step={512} unit="tokens" onChange={(v) => set({ promptTokens: v })} />
      <Slider label="Output tokens" value={s.outputTokens} min={1} max={2048} unit="tokens" onChange={(v) => set({ outputTokens: v })} />
      <Segmented label="KV precision" value={s.kvBytes} options={[{ value: 2, label: 'BF16' }, { value: 1, label: 'FP8' }]} onChange={(v) => set({ kvBytes: v })} />
      <Slider label="Effective link bandwidth" value={s.linkGBps} min={1} max={400} unit="GB/s" onChange={(v) => set({ linkGBps: v })} hint="decimal, measured" />
      <Slider label="Concurrent transfers on link" value={s.concurrentTransfers} min={1} max={32} onChange={(v) => set({ concurrentTransfers: v })} />
      <Slider label="Per-layer overlap" value={Math.round(s.overlap * 100)} min={0} max={100} unit="%" onChange={(v) => set({ overlap: v / 100 })} />
      <Slider label="Decode slowdown when co-located" value={Math.round(s.interference * 100)} min={0} max={100} unit="%" onChange={(v) => set({ interference: v / 100 })} hint="assumed" />
      <Slider label="Decode ITL (isolated)" value={s.itlMs} min={5} max={100} unit="ms" onChange={(v) => set({ itlMs: v })} />
      <Slider label="Prefill throughput" value={s.prefillTps} min={2000} max={80000} step={1000} unit="tok/s" onChange={(v) => set({ prefillTps: v })} hint="assumed" />
    </>}>
      <div className="stats">
        <Stat k="KV to move" v={fmtBytes(r.kvBytes, 2)} ev="calculated" />
        <Stat k="Raw transfer" v={fmtMs(r.rawTransferMs)} ev="calculated" />
        <Stat k="Exposed after overlap" v={fmtMs(r.exposedTransferMs)} tone={r.exposedTransferMs > 200 ? 'warn' : undefined} ev="calculated" />
        <Stat k="E2E monolithic" v={fmtMs(r.e2eMono)} ev="calculated" />
        <Stat k="E2E disaggregated" v={fmtMs(r.e2eDisagg)} tone={wins ? 'good' : 'bad'} ev="calculated" />
        <Stat k="Break-even prompt" v={Number.isFinite(be) ? (be === 0 ? 'never wins' : `${fmt(be / 1024, 1)}K`) : '> 256K'} unit={Number.isFinite(be) && be > 0 ? 'tokens' : ''} ev="calculated" />
      </div>
      <ChartBox title="One request end to end (seconds)" height={170}
        legend={<span className="small muted">Token 1 comes from the prefill pool; exposed transfer delays token 2. TTFT is {fmtMs(r.ttftMono)} in both.</span>}>
        <ResponsiveContainer>
          <BarChart data={timeline} layout="vertical" margin={{ left: 16, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 1)} unit=" s" />
            <YAxis type="category" dataKey="name" {...axis} width={110} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 3)} s`} />
            <Legend />
            <Bar dataKey="Prefill" stackId="a" fill={C.prefill} />
            <Bar dataKey="KV transfer (exposed)" stackId="a" fill={C.comm} />
            <Bar dataKey="Decode" stackId="a" fill={C.decode} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Disaggregated minus monolithic E2E (s) vs prompt length — below 0 = disaggregation wins" height={250}>
        <ResponsiveContainer>
          <LineChart data={sweep} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} tickFormatter={(v) => fmt(v, 1)} width={56} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 3)} s`} />
            <Legend />
            <ReferenceLine y={0} stroke={C.text} strokeDasharray="4 4" />
            <Line dataKey="delta" name="Δ E2E" stroke={C.accent} strokeWidth={2.5} />
            <Line dataKey="transfer" name="Exposed transfer" stroke={C.comm} strokeWidth={2} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Prompt', 'Exposed transfer (s)', 'Δ E2E (s)', 'Verdict']}
        rows={sweep.map((x) => [x.label, fmt(x.transfer, 3), fmt(x.delta, 3), x.delta < 0 ? 'disaggregate' : 'monolithic'])} />
    </SimLayout>
  );
}

// ---------- Q23: MoE routing and parallelism ----------

interface MoeState { skew: number; capacityFactor: number; seed: number; devices: number; tokensPerStep: number; microbatches: number }
const MOE_NORMAL: MoeState = { skew: 0, capacityFactor: 1.25, seed: 4, devices: 8, tokensPerStep: 4096, microbatches: 8 };
const MOE_PRESETS = {
  normal: MOE_NORMAL,
  stress: { ...MOE_NORMAL, skew: 1.2, tokensPerStep: 16384 },
  failure: { ...MOE_NORMAL, skew: 3, capacityFactor: 1 },
};
// Illustrative large MoE (assumed): 8 experts, top-2, 2B shared + 45B expert params.
const BIG = { sharedB: 2, expertsB: 45, experts: 8, topK: 2, dModel: 4096, actBytes: 2, weightBytes: 2, layers: 32 };

function MoeSim() {
  const { s, set, active, pick, reset } = usePresetState(MOE_PRESETS);
  const toy = moeToy({ tokens: 8, experts: 4, topK: 2, devices: 2, skew: s.skew, capacityFactor: s.capacityFactor, seed: s.seed, dModel: 4096, actBytes: 2 });
  const rows = moeParallel({ ...BIG, devices: s.devices, tokensPerStep: s.tokensPerStep, microbatches: s.microbatches, imbalance: toy.imbalance });
  const loadData = toy.load.map((l, e) => ({ expert: `E${e} (dev ${e < 2 ? 0 : 1})`, load: l }));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Router skew toward E0" value={s.skew} min={0} max={4} step={0.1} onChange={(v) => set({ skew: v })} hint="hot expert" />
      <Slider label="Capacity factor" value={s.capacityFactor} min={0.5} max={2} step={0.05} onChange={(v) => set({ capacityFactor: v })} />
      <Slider label="Router seed" value={s.seed} min={1} max={50} onChange={(v) => set({ seed: v })} />
      <Segmented label="Devices (large model)" value={s.devices} options={[2, 4, 8, 16].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ devices: v })} />
      <Slider label="Tokens per step" value={s.tokensPerStep} min={256} max={32768} step={256} unit="tokens" onChange={(v) => set({ tokensPerStep: v })} />
      <Slider label="Pipeline microbatches" value={s.microbatches} min={1} max={32} onChange={(v) => set({ microbatches: v })} />
    </>}>
      <div className="stats">
        <Stat k="Expert capacity" v={toy.capacity} unit="slots each" ev="calculated" />
        <Stat k="Dropped assignments" v={toy.dropped} unit="of 16" tone={toy.dropped ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Cross-device sends" v={toy.remote} ev="simulated" />
        <Stat k="All-to-all bytes (toy)" v={fmtBytes(toy.a2aBytes)} ev="calculated" />
        <Stat k="Device imbalance" v={`${fmt(toy.imbalance, 2)}×`} tone={toy.imbalance > 1.3 ? 'warn' : undefined} ev="simulated" />
        <Stat k="Active / total params" v={`${fmt(moeActiveB(BIG), 1)} / ${BIG.sharedB + BIG.expertsB}`} unit="B" ev="assumed" />
      </div>
      <div className="card raised" style={{ padding: 18 }}>
        <div className="small muted" style={{ marginBottom: 10 }}>Toy step: 8 tokens, 4 experts, top-2, 2 devices (T0–T3 live on device 0, T4–T7 on device 1; E0–E1 on device 0, E2–E3 on device 1)</div>
        <div className="stack" style={{ gap: 8 }}>
          {Array.from({ length: 8 }, (_, t) => (
            <div key={t} className="lane">
              <span className="lane-label">T{t} · dev {t < 4 ? 0 : 1}</span>
              <div className="chips">
                {toy.assigns.filter((a) => a.token === t).map((a, k) => (
                  <Chip key={k} kind={a.dropped ? 'error' : a.remote ? 'comm' : 'decode'} label={`E${a.expert}`} note={a.dropped ? 'dropped' : a.remote ? 'all-to-all' : 'local'} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}><KindLegend kinds={['decode', 'comm', 'error']} /></div>
      </div>
      <ChartBox title="Tokens routed to each expert vs capacity" height={220}>
        <ResponsiveContainer>
          <BarChart data={loadData} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="expert" {...axis} />
            <YAxis {...axis} allowDecimals={false} width={40} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="load" name="Tokens kept" fill={C.decode}>
              {loadData.map((d, i) => <Cell key={i} fill={d.load >= toy.capacity ? C.kv : C.decode} />)}
            </Bar>
            <ReferenceLine y={toy.capacity} stroke={C.error} strokeDasharray="6 4" label={{ value: 'capacity', fill: 'var(--muted)', position: 'right' }} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title={`Large model on ${s.devices} devices: weights per device (GiB) and comm per MoE layer per device (MiB)`} height={280}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ left: 8, right: 8, top: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} interval={0} />
            <YAxis yAxisId="m" {...axis} width={52} />
            <YAxis yAxisId="c" orientation="right" {...axis} width={60} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmt(Number(v), 1)} />
            <Legend />
            <Bar yAxisId="m" dataKey="memGiB" name="Weights / device (GiB)" fill={C.prefill} />
            <Bar yAxisId="c" dataKey="commMiB" name="Comm / layer (MiB)" fill={C.comm} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Strategy', 'Weights / device', 'Comm / layer / device', 'Pipeline bubble', 'Step-time scale from skew']}
        rows={rows.map((r) => [r.name, `${fmt(r.memGiB, 1)} GiB`, `${fmt(r.commMiB, 1)} MiB`, fmtPct(r.bubble), `${fmt(r.computeScale, 2)}×`])} />
    </SimLayout>
  );
}

// ---------- Q24: cost per million tokens ----------

const IVS: Intervention[] = [
  { name: 'Route easy traffic to small model', saving: 0.7, share: 0.5, enabled: true, risk: 'high' },
  { name: 'FP8 weights + KV', saving: 0.35, share: 1, enabled: true, risk: 'medium' },
  { name: 'Prefix caching', saving: 0.3, share: 0.4, enabled: true, risk: 'low' },
  { name: 'Output length caps', saving: 0.2, share: 0.6, enabled: true, risk: 'medium' },
  { name: 'Batching / utilization', saving: 0.3, share: 1, enabled: true, risk: 'low' },
  { name: 'Speculative decoding', saving: 0.2, share: 0.7, enabled: false, risk: 'medium' },
  { name: 'Cheaper hardware', saving: 0.2, share: 1, enabled: false, risk: 'medium' },
];
type CostState = Omit<CostInput, 'interventions'> & { ivs: Intervention[]; sel: number };
const COST_NORMAL: CostState = { gpuHourUsd: 4, gpus: 16, outputTps: 4000, overhead: 0.15, utilization: 0.45, ivs: IVS, sel: 0 };
const COST_PRESETS = {
  normal: COST_NORMAL,
  stress: { ...COST_NORMAL, ivs: IVS.map((x) => ({ ...x, saving: x.saving / 2, enabled: true })) },
  failure: { ...COST_NORMAL, ivs: IVS.map((x, i) => ({ ...x, enabled: i >= 2 && i <= 5 })) },
};

function CostSim() {
  const { s, set, active, pick, reset } = usePresetState(COST_PRESETS);
  const r = costPlan({ ...s, interventions: s.ivs });
  const cur = s.ivs[s.sel];
  const patchIv = (p: Partial<Intervention>) => set({ ivs: s.ivs.map((x, i) => (i === s.sel ? { ...x, ...p } : x)) });
  const water = [
    { name: 'Baseline', base: 0, val: r.baselinePerM, kind: 'base' },
    ...r.steps.map((x) => ({ name: x.name, base: x.after, val: x.drop, kind: 'step' })),
    { name: 'Final', base: 0, val: r.finalPerM, kind: r.meetsTarget ? 'ok' : 'bad' },
  ];
  const colorOf = (k: string) => (k === 'base' ? C.neutral : k === 'step' ? C.decode : k === 'ok' ? C.ok : C.error);
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="GPU price (assumed)" value={s.gpuHourUsd} min={0.5} max={12} step={0.1} unit="$/GPU-h" onChange={(v) => set({ gpuHourUsd: v })} hint="not a quote" />
      <Slider label="Fleet output throughput" value={s.outputTps} min={500} max={20000} step={100} unit="tok/s" onChange={(v) => set({ outputTps: v })} />
      <Slider label="GPU busy fraction" value={Math.round(s.utilization * 100)} min={5} max={100} unit="%" onChange={(v) => set({ utilization: v / 100 })} />
      <fieldset className="ctl" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Interventions (passed quality gate)</legend>
        {s.ivs.map((x, i) => (
          <label key={x.name} className="row small" style={{ gap: 8, minHeight: 32 }}>
            <input type="checkbox" checked={x.enabled} onChange={(e) => set({ ivs: s.ivs.map((y, j) => (j === i ? { ...y, enabled: e.target.checked } : y)) })} />
            {x.name} <span className="muted">({x.risk} risk)</span>
          </label>
        ))}
      </fieldset>
      <label className="ctl">
        <span style={{ fontSize: 15, fontWeight: 500 }}>Edit intervention</span>
        <select value={s.sel} onChange={(e) => set({ sel: +e.target.value })}>
          {s.ivs.map((x, i) => <option key={x.name} value={i}>{x.name}</option>)}
        </select>
      </label>
      <Slider label="Saving on applicable traffic" value={Math.round(cur.saving * 100)} min={0} max={90} unit="%" onChange={(v) => patchIv({ saving: v / 100 })} />
      <Slider label="Share of traffic it applies to" value={Math.round(cur.share * 100)} min={0} max={100} unit="%" onChange={(v) => patchIv({ share: v / 100 })} />
    </>}>
      <div className="stats">
        <Stat k="Baseline" v={fmtUsd(r.baselinePerM)} unit="/ M out" ev="calculated" />
        <Stat k="After plan" v={fmtUsd(r.finalPerM)} unit="/ M out" tone={r.meetsTarget ? 'good' : 'bad'} ev="calculated" />
        <Stat k="Reduction (multiplicative)" v={fmtPct(r.reduction, 0)} tone={r.meetsTarget ? 'good' : 'bad'} ev="calculated" />
        <Stat k="Naive additive sum" v={fmtPct(r.additiveReduction, 0)} tone="warn" ev="calculated" />
        <Stat k="Target (≤ 0.30 × baseline)" v={fmtUsd(r.target)} unit="/ M out" ev="calculated" />
        <Stat k="Verdict" v={r.meetsTarget ? '70 % met' : 'infeasible'} tone={r.meetsTarget ? 'good' : 'bad'} ev="assumed" />
      </div>
      <ChartBox title="Waterfall: $ per million output tokens (hypothetical savings, applied largest first)" height={300}
        legend={<span className="small muted">Dashed line = 70 % target. Additive {fmtPct(r.additiveReduction, 0)} overstates the real {fmtPct(r.reduction, 0)} because each step acts on what is left.</span>}>
        <ResponsiveContainer>
          <BarChart data={water} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
            <CartesianGrid {...grid} vertical={false} />
            <XAxis dataKey="name" {...axis} interval={0} angle={-20} textAnchor="end" height={80} />
            <YAxis {...axis} tickFormatter={(v) => `$${fmt(v, 2)}`} width={64} />
            <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'base' ? null : fmtUsd(Number(v)))} />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="val" name="$ / M" stackId="w">
              {water.map((d, i) => <Cell key={i} fill={colorOf(d.kind)} />)}
            </Bar>
            <ReferenceLine y={r.target} stroke={C.accent} strokeDasharray="6 4" label={{ value: '70 % target', fill: 'var(--accent)', position: 'insideTopRight' }} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ChartBox title="Baseline cost breakdown ($ / M output tokens)" height={170}>
        <ResponsiveContainer>
          <BarChart data={r.breakdown} layout="vertical" margin={{ left: 16, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => `$${fmt(v, 2)}`} />
            <YAxis type="category" dataKey="name" {...axis} width={170} />
            <Tooltip {...tooltipStyle} formatter={(v) => fmtUsd(Number(v))} />
            <Bar dataKey="perM" name="$ / M">
              {r.breakdown.map((_, i) => <Cell key={i} fill={[C.prefill, C.error, C.neutral][i]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <ValuesTable cols={['Step', 'Effective saving', 'Cost after', 'Drop']}
        rows={[['Baseline', '—', fmtUsd(r.baselinePerM), '—'], ...r.steps.map((x) => [x.name, fmtPct(x.drop / (x.after + x.drop)), fmtUsd(x.after), fmtUsd(x.drop)])]} />
    </SimLayout>
  );
}

// ---------- Q25: capacity planner ----------

const CAP_NORMAL: CapInput = {
  dau: 1_000_000, reqPerUserDay: 10, peakFactor: 3, promptTokens: 1500, outputTokens: 400, ttftS: 0.8, itlMs: 40,
  outTpsPerGpu: 1500, prefillTpsPerGpu: 10_000, tp: 8, gpuGB: 80, reserveGiB: 6, paramsB: 70, weightBytes: 2, kvBytes: 2,
  headroom: 0.2, regions: 2, spares: 1, gpuHourUsd: 2.5,
};
const CAP_PRESETS = {
  normal: CAP_NORMAL,
  stress: { ...CAP_NORMAL, peakFactor: 5, outputTokens: 800 },
  failure: { ...CAP_NORMAL, promptTokens: 12000, outTpsPerGpu: 500, itlMs: 70 },
};

function CapacitySim() {
  const { s, set, active, pick, reset } = usePresetState(CAP_PRESETS);
  const r = capacity(s);
  const scen = capScenarios(s);
  const sens = capSensitivity(s);
  const base = r.gpus;
  const tornado = sens.map((x) => ({ label: x.label, lo: x.low, span: x.high - x.low }));
  const bounds = [
    { name: 'Memory (KV + weights)', groups: r.groupsMem },
    { name: 'Throughput (prefill + decode)', groups: r.groupsThroughput },
    { name: 'With headroom', groups: r.groupsBase },
    { name: 'Deployed (regions + spares)', groups: r.gpus / s.tp },
  ];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Daily active users" value={s.dau} min={100_000} max={10_000_000} step={100_000} onChange={(v) => set({ dau: v })} format={(v) => `${fmt(v / 1e6, 1)} M`} />
      <Slider label="Requests / user / day" value={s.reqPerUserDay} min={1} max={50} onChange={(v) => set({ reqPerUserDay: v })} />
      <Slider label="Peak factor (peak / mean)" value={s.peakFactor} min={1} max={8} step={0.1} onChange={(v) => set({ peakFactor: v })} />
      <Slider label="Prompt tokens (mean)" value={s.promptTokens} min={100} max={16000} step={100} onChange={(v) => set({ promptTokens: v })} />
      <Slider label="Output tokens (mean)" value={s.outputTokens} min={20} max={2000} step={10} onChange={(v) => set({ outputTokens: v })} />
      <Slider label="Decode tok/s per GPU at SLO" value={s.outTpsPerGpu} min={100} max={5000} step={50} onChange={(v) => set({ outTpsPerGpu: v })} hint="assumed — measure it" />
      <Slider label="Prefill tok/s per GPU" value={s.prefillTpsPerGpu} min={1000} max={40000} step={500} onChange={(v) => set({ prefillTpsPerGpu: v })} hint="assumed" />
      <Slider label="ITL SLO" value={s.itlMs} min={10} max={150} unit="ms" onChange={(v) => set({ itlMs: v })} />
      <Segmented label="KV precision" value={s.kvBytes} options={[{ value: 2, label: 'BF16' }, { value: 1, label: 'FP8' }]} onChange={(v) => set({ kvBytes: v })} />
      <Slider label="Headroom" value={Math.round(s.headroom * 100)} min={0} max={100} unit="%" onChange={(v) => set({ headroom: v / 100 })} />
      <Segmented label="Regions (each N+1)" value={s.regions} options={[1, 2, 3].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ regions: v })} />
      <Slider label="GPU price (assumed)" value={s.gpuHourUsd} min={0.5} max={10} step={0.1} unit="$/GPU-h" onChange={(v) => set({ gpuHourUsd: v })} hint="not a quote" />
    </>}>
      <div className="stats">
        <Stat k="Peak RPS" v={fmt(r.peakRps, 0)} unit={`avg ${fmt(r.avgRps, 0)}`} ev="calculated" />
        <Stat k="Input / output tok/s" v={`${fmt(r.inTps / 1000, 0)}k / ${fmt(r.outTps / 1000, 0)}k`} ev="calculated" />
        <Stat k="Concurrency (Little)" v={fmt(r.concurrency, 0)} unit={`× ${fmt(r.e2eS, 1)} s`} ev="calculated" />
        <Stat k="KV in use at peak" v={fmtBytes(r.kvGiB * GiB)} ev="calculated" />
        <Stat k={`GPUs (${r.bound}-bound)`} v={Number.isFinite(r.gpus) ? fmt(r.gpus, 0) : '—'} unit={`TP${s.tp}`} tone={r.bound === 'memory' ? 'warn' : undefined} ev="calculated" />
        <Stat k="Serving cost" v={fmtUsd(r.monthlyUsd)} unit={`/ mo · ${fmtUsd(r.usdPerMOut)}/M out`} ev="assumed" />
      </div>
      <ChartBox title={`TP${s.tp} groups needed by each bound`} height={200}>
        <ResponsiveContainer>
          <BarChart data={bounds} layout="vertical" margin={{ left: 16, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} allowDecimals={false} />
            <YAxis type="category" dataKey="name" {...axis} width={200} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${v} groups`} />
            <Bar dataKey="groups" name="groups">
              {bounds.map((_, i) => <Cell key={i} fill={[C.kv, C.decode, C.prefill, C.accent][i]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
      <div className="grid-2">
        <ChartBox title="Low / base / high scenarios (GPUs)" height={220}>
          <ResponsiveContainer>
            <BarChart data={scen} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid {...grid} vertical={false} />
              <XAxis dataKey="name" {...axis} />
              <YAxis {...axis} width={52} />
              <Tooltip {...tooltipStyle} formatter={(v) => `${v} GPUs`} />
              <Bar dataKey="gpus" name="GPUs">{scen.map((_, i) => <Cell key={i} fill={[C.decode, C.prefill, C.error][i]} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="Sensitivity: GPUs when one input moves" height={220}
          legend={<span className="small">Measure first: <b>{sens[0].label}</b> (widest bar).</span>}>
          <ResponsiveContainer>
            <BarChart data={tornado} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...grid} horizontal={false} />
              <XAxis type="number" {...axis} domain={['dataMin', 'dataMax']} />
              <YAxis type="category" dataKey="label" {...axis} width={150} />
              <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'lo' ? null : `${v} GPU range`)} />
              <Bar dataKey="lo" stackId="t" fill="transparent" isAnimationActive={false} />
              <Bar dataKey="span" stackId="t" fill={C.kv} name="range" />
              <ReferenceLine x={base} stroke={C.accent} strokeDasharray="4 4" />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>
      <ValuesTable cols={['Quantity', 'Value', 'Evidence']} rows={[
        ['Average / peak RPS', `${fmt(r.avgRps, 1)} / ${fmt(r.peakRps, 1)}`, 'calculated'],
        ['Input tokens/s at peak', fmt(r.inTps, 0), 'calculated'],
        ['Output tokens/s at peak', fmt(r.outTps, 0), 'calculated'],
        ['E2E per request', `${fmt(r.e2eS, 2)} s`, 'calculated from SLO'],
        ['Concurrency = RPS × E2E', fmt(r.concurrency, 0), "calculated (Little's law, mean)"],
        ['KV at peak', `${fmt(r.kvGiB, 0)} GiB`, 'calculated'],
        ['Weights per replica', `${fmt(r.weightsGiB, 1)} GiB`, 'calculated'],
        ['KV room per TP group', `${fmt(r.kvRoomPerGroupGiB, 1)} GiB`, 'calculated'],
        ['Groups: memory / throughput', `${r.groupsMem} / ${r.groupsThroughput}`, 'calculated'],
        ['Deployed GPUs', String(r.gpus), 'calculated — lower bound, not procurement'],
        ...sens.map((x) => [`Sensitivity: ${x.label}`, `${x.low}–${x.high} GPUs`, 'calculated']),
      ]} />
    </SimLayout>
  );
}

export const sims: Record<number, ComponentType> = { 21: FairSim, 22: DisaggSim, 23: MoeSim, 24: CostSim, 25: CapacitySim };
