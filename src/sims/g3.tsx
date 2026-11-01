// Models & GPU performance simulators (Q11-Q15). Each is a self-contained component keyed by question id.
import type { ComponentType } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from 'recharts';
import { GiB, MiB, fmt, fmtBytes, fmtMs, fmtPct, fmtUsd } from '../engines/core';
import {
  GPUS, Q_LABEL, classify, deploy, effectiveBits, layernorm, normTraffic, pipeline, quantize, rmsnorm, ridge, roofline, synthTrace, traceSummary,
  type Fault, type QFormat, type TraceEvent,
} from '../engines/g3';
import {
  C, ChartBox, Chip, DataTable, EvidenceBadge, KindLegend, Presets, Segmented, SimLayout, Slider, Stat, ValuesTable, axis, grid, tooltipStyle, usePresetState,
} from '../components/ui';
import type { Kind } from '../types';

const FORMATS: QFormat[] = ['int8', 'int4', 'int4g', 'fp8', 'nvfp4'];
const F_COLOR: Record<QFormat, string> = { int8: C.request, int4: C.error, int4g: C.kv, fp8: C.decode, nvfp4: C.prefill };
const logTicks = (lo: number, hi: number) => { const t: number[] = []; for (let v = lo; v <= hi; v *= 10) t.push(v); return t; };

// ---------- Q11: quantization explorer ----------

/** Symmetric log so 0.02 and 12 are both visible on one line. Presentation only. */
const symlog = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v) / 0.01);

function QuantSim() {
  const { s, set, active, pick, reset } = usePresetState({
    normal: { outlier: 12, clip: 1, group: 2, format: 'int4g' as QFormat, paramsB: 70 },
    stress: { outlier: 100, clip: 1, group: 2, format: 'fp8' as QFormat, paramsB: 70 },
    failure: { outlier: 100, clip: 1, group: 2, format: 'int4' as QFormat, paramsB: 70 },
  });
  const vec = [0.02, -0.7, 1.4, s.outlier];
  const all = FORMATS.map((f) => quantize(vec, f, s.clip, s.group));
  const cur = all[FORMATS.indexOf(s.format)];
  const W = 760; const H = 170; const pad = 40;
  const dom = symlog(Math.max(...vec.map(Math.abs)) * 1.08);
  const X = (v: number) => pad + ((symlog(v) + dom) / (2 * dom)) * (W - 2 * pad);
  const levels = cur.levels.filter((v) => Math.abs(symlog(v)) <= dom);
  const errRows = vec.map((x, i) => {
    const row: Record<string, number | string> = { el: `x${i + 1} = ${x}` };
    all.forEach((r) => { row[Q_LABEL[r.format]] = +(r.relErr[i] * 100).toFixed(3); });
    return row;
  });
  const mem = FORMATS.map((f) => ({ f: Q_LABEL[f], bits: effectiveBits(f, 1e9), gib: (s.paramsB * 1e9 * effectiveBits(f, 1e9)) / 8 / GiB, fmt: f }));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Format" value={s.format} options={FORMATS.map((f) => ({ value: f, label: Q_LABEL[f] }))} onChange={(v) => set({ format: v })} />
      <Slider label="Outlier value (x4)" value={s.outlier} min={1} max={400} step={1} onChange={(v) => set({ outlier: v })} hint="toy: 12" />
      <Slider label="Clip range (fraction of amax)" value={s.clip} min={0.1} max={1} step={0.05} onChange={(v) => set({ clip: v })} format={(v) => `${fmt(v * 100, 0)} %`} />
      <Segmented label="INT4 group size" value={s.group} options={[1, 2, 4].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ group: v })} />
      <Slider label="Model size (for memory)" value={s.paramsB} min={1} max={405} unit="B params" onChange={(v) => set({ paramsB: v })} />
    </>}>
      <div className="stats">
        <Stat k={`${Q_LABEL[s.format]}: MSE`} v={fmt(cur.mse, 5)} ev="calculated" />
        <Stat k="Worst relative error" v={fmtPct(Math.max(...cur.relErr))} tone={Math.max(...cur.relErr) >= 0.99 ? 'bad' : Math.max(...cur.relErr) > 0.1 ? 'warn' : 'good'} ev="calculated" />
        <Stat k="Values lost to zero" v={cur.deq.filter((d, i) => d === 0 && vec[i] !== 0).length} unit={`of ${vec.length}`} tone={cur.deq.some((d, i) => d === 0 && vec[i] !== 0) ? 'bad' : 'good'} ev="calculated" />
        <Stat k="Bits/value incl. scales (large tensor)" v={fmt(effectiveBits(s.format, 1e9), 3)} ev="calculated" />
        <Stat k={`${s.paramsB}B weights at this format`} v={fmtBytes(mem[FORMATS.indexOf(s.format)].gib * GiB)} ev="calculated" />
      </div>

      <figure className="chart-box" style={{ margin: 0 }}>
        <h3>Representable levels ({Q_LABEL[s.format]}, first scale group) vs inputs — symmetric-log axis</h3>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Number line. Inputs ${vec.join(', ')} reconstruct to ${cur.deq.map((d) => fmt(d, 4)).join(', ')}.`}>
          <line x1={pad} x2={W - pad} y1={90} y2={90} stroke="var(--muted)" />
          {levels.map((v, i) => <line key={i} x1={X(v)} x2={X(v)} y1={80} y2={100} stroke="var(--c-prefill)" strokeOpacity={0.55} />)}
          <line x1={X(0)} x2={X(0)} y1={70} y2={110} stroke="var(--muted)" />
          <text x={X(0)} y={126} textAnchor="middle" fontSize="13" fill="var(--muted)">0</text>
          {vec.map((x, i) => (
            <g key={i}>
              <line x1={X(x)} x2={X(cur.deq[i])} y1={50} y2={90} stroke={cur.relErr[i] >= 0.99 ? 'var(--c-error)' : 'var(--muted)'} strokeDasharray="4 3" />
              <circle cx={X(x)} cy={50} r={6} fill="var(--c-request)" />
              <text x={X(x)} y={36} textAnchor="middle" fontSize="13" fill="var(--text)">{x}</text>
              <rect x={X(cur.deq[i]) - 6} y={84} width={12} height={12} transform={`rotate(45 ${X(cur.deq[i])} 90)`} fill={cur.relErr[i] >= 0.99 ? 'var(--c-error)' : 'var(--c-decode)'} />
              <text x={X(cur.deq[i])} y={150 - (i % 2) * 14} textAnchor="middle" fontSize="13" fill="var(--text)">{fmt(cur.deq[i], 4)}</text>
            </g>
          ))}
        </svg>
        <div style={{ padding: '4px 16px' }} className="legend small">
          <span><span className="sw" style={{ background: C.request, borderRadius: 99 }} />● input</span>
          <span><span className="sw" style={{ background: C.decode }} />◆ reconstructed</span>
          <span><span className="sw" style={{ background: C.prefill }} />| representable level ({levels.length} shown)</span>
          <span><span className="sw" style={{ background: C.error }} />✕ value lost</span>
        </div>
      </figure>

      <ChartBox title="Relative error per element, all formats (%; 100 % = value destroyed)" height={280}>
        <ResponsiveContainer>
          <BarChart data={errRows} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="el" {...axis} />
            <YAxis {...axis} domain={[0, 100]} width={44} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)} %`} />
            <Legend />
            {FORMATS.map((f) => <Bar key={f} dataKey={Q_LABEL[f]} fill={F_COLOR[f]} fillOpacity={f === s.format ? 1 : 0.4} />)}
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      <ChartBox title={`${s.paramsB}B weights by format (GiB, incl. scale metadata)`} height={220}>
        <ResponsiveContainer>
          <BarChart data={mem} layout="vertical" margin={{ left: 16, right: 24 }}>
            <CartesianGrid {...grid} horizontal={false} />
            <XAxis type="number" {...axis} tickFormatter={(v) => fmt(v, 0)} />
            <YAxis type="category" dataKey="f" {...axis} width={170} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} GiB`} />
            <Bar dataKey="gib" name="GiB">{mem.map((m) => <Cell key={m.fmt} fill={F_COLOR[m.fmt]} fillOpacity={m.fmt === s.format ? 1 : 0.45} />)}</Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      <DataTable caption="Decision panel: where each format applies (support depends on engine + GPU; verify before choosing)" cols={['Format', 'Weights', 'Weights + activations', 'KV cache', 'Tensor-core hardware']} rows={[
        ['FP8 E4M3', '✓', '✓ (per-tensor/row scales)', '✓ common', 'Hopper (H100/H200), Blackwell, Ada (L40S)'],
        ['INT8', '✓', '✓ (SmoothQuant-style)', 'some engines', 'Ampere and newer'],
        ['INT4 per-group', '✓ weight-only (AWQ/GPTQ)', 'rare', 'rare', 'Dequantized in kernel; no INT4 math needed'],
        ['NVFP4', '✓', '✓', 'engine-specific', 'Blackwell (B200) FP4 tensor cores only'],
      ]} />

      <ValuesTable cols={['Format', 'Reconstructed vector', 'Scales', 'MSE', 'Bits/value (n=4)', 'Bits/value (n=1e9)']} rows={all.map((r) => [
        Q_LABEL[r.format], `[${r.deq.map((d) => fmt(d, 4)).join(', ')}]`, r.scales.map((x) => fmt(x, 5)).join(', '), fmt(r.mse, 6),
        fmt(effectiveBits(r.format, 4, s.group, 16), 2), fmt(effectiveBits(r.format, 1e9), 3),
      ])} />
    </SimLayout>
  );
}

// ---------- Q12: GPU choice ----------

function GpuSim() {
  const base = { paramsB: 70, wBytes: 2, kvKiB: 320, batch: 32, ctx: 4096, usable: 0.9, mbu: 0.7, mfu: 0.5, gpu: 'h100', prices: Object.fromEntries(GPUS.map((g) => [g.id, g.price])) as Record<string, number> };
  const { s, set, active, pick, reset } = usePresetState({
    normal: base,
    stress: { ...base, wBytes: 1, kvKiB: 160, batch: 128, ctx: 32768, gpu: 'h200' },
    failure: { ...base, paramsB: 405, batch: 64, ctx: 8192, gpu: 'l40s' },
  });
  const input = (id: string) => ({ paramsB: s.paramsB, wBytes: s.wBytes, kvKiBPerToken: s.kvKiB, batch: s.batch, ctxTokens: s.ctx, usableFrac: s.usable, mbu: s.mbu, mfu: s.mfu, price: s.prices[id] });
  const results = GPUS.map((g) => ({ g, r: deploy(g, input(g.id)) }));
  const sel = results.find((x) => x.g.id === s.gpu)!;
  const r = sel.r;
  const peakOf = (g: (typeof GPUS)[number]) => (s.wBytes <= 1 ? g.fp8 : g.bf16);
  const ais: number[] = []; for (let a = 0.25; a <= 8192; a *= 2) ais.push(a);
  const roof = ais.map((ai) => { const row: Record<string, number> = { ai }; GPUS.forEach((g) => { row[g.name] = roofline(peakOf(g), g.bwTBs, ai); }); return row; });
  const bars = results.map(({ g, r: x }) => ({ name: g.name.split(' (')[0], id: g.id, tok: Math.round(x.tokPerSec), usd: +x.usdPerMTok.toFixed(3), gpus: x.tp }));
  const colors = [C.request, C.prefill, C.decode, C.kv];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="GPU" value={s.gpu} options={GPUS.map((g) => ({ value: g.id, label: g.name.split(' (')[0] }))} onChange={(v) => set({ gpu: v })} />
      <Slider label="Model parameters" value={s.paramsB} min={1} max={405} unit="B" onChange={(v) => set({ paramsB: v })} />
      <Segmented label="Weight precision" value={s.wBytes} options={[{ value: 2, label: 'BF16' }, { value: 1, label: 'FP8' }]} onChange={(v) => set({ wBytes: v })} />
      <Segmented label="KV per token (70B-style)" value={s.kvKiB} options={[{ value: 320, label: '320 KiB BF16' }, { value: 160, label: '160 KiB FP8' }]} onChange={(v) => set({ kvKiB: v })} />
      <Slider label="Concurrent sequences (batch)" value={s.batch} min={1} max={256} onChange={(v) => set({ batch: v })} />
      <Slider label="Cached tokens per sequence" value={s.ctx} min={512} max={131072} step={512} unit="tok" onChange={(v) => set({ ctx: v })} />
      <Slider label="Achieved bandwidth (MBU)" value={s.mbu} min={0.3} max={1} step={0.05} onChange={(v) => set({ mbu: v })} format={(v) => `${fmt(v * 100, 0)} % (assumed)`} />
      <Slider label={`Rental price ${sel.g.name.split(' (')[0]}`} value={s.prices[s.gpu]} min={0.2} max={15} step={0.1} unit="$/GPU-h"
        onChange={(v) => set({ prices: { ...s.prices, [s.gpu]: v } })} hint="assumed, not a quote" />
    </>}>
      <div className="stats">
        <Stat k="Weights + KV needed" v={fmtBytes(r.needBytes)} ev="calculated" />
        <Stat k="GPUs (power-of-two TP)" v={r.tp} unit={r.multiNode ? 'multi-node!' : `min ${r.gpusMin}`} tone={r.multiNode ? 'bad' : r.tp > 4 ? 'warn' : 'good'} ev="calculated" />
        <Stat k="Decode step (lower bound)" v={fmtMs(r.stepMs)} unit={`${r.bound}-bound`} ev="calculated" />
        <Stat k="Throughput upper bound" v={fmt(r.tokPerSec, 0)} unit="tok/s" ev="calculated" />
        <Stat k="Per-user speed upper bound" v={fmt(r.perUserTokS, 1)} unit="tok/s" tone={r.perUserTokS < 10 ? 'bad' : undefined} ev="calculated" />
        <Stat k="$ per M output tokens (lower bound)" v={fmtUsd(r.usdPerMTok)} ev="calculated" />
      </div>

      <ChartBox title={`Roofline: attainable TFLOPS vs arithmetic intensity (${s.wBytes <= 1 ? 'FP8' : 'BF16'} dense, log-log)`} height={300}
        legend={<span className="small muted">Purple line = this decode step's intensity ≈ {fmt(r.decodeAI, 1)} FLOP/B. Ridge points: {GPUS.map((g) => `${g.name.split(' ')[0]} ${fmt(ridge(peakOf(g), g.bwTBs), 0)}`).join(' · ')} FLOP/B. Left of a ridge = bandwidth decides.</span>}>
        <ResponsiveContainer>
          <LineChart data={roof} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="ai" type="number" scale="log" domain={[0.25, 8192]} ticks={logTicks(1, 1000)} {...axis} allowDataOverflow height={44}
              label={{ value: 'FLOP per byte', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} />
            <YAxis type="number" scale="log" domain={[0.1, 10000]} ticks={logTicks(1, 10000)} {...axis} allowDataOverflow width={60} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 1)} TFLOPS`} labelFormatter={(l) => `${l} FLOP/B`} />
            <Legend />
            {GPUS.map((g, i) => <Line key={g.id} dataKey={g.name} stroke={colors[i]} strokeWidth={g.id === s.gpu ? 3.5 : 1.8} strokeDasharray={i % 2 ? '6 3' : undefined} dot={false} />)}
            <ReferenceLine x={Math.max(0.25, r.decodeAI)} stroke={C.accent} strokeWidth={2} label={{ value: 'decode', fill: 'var(--accent)', position: 'top' }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      <div className="grid-2">
        <ChartBox title="Throughput upper bound per deployment (tok/s)" height={220}>
          <ResponsiveContainer>
            <BarChart data={bars} margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="name" {...axis} interval={0} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis {...axis} width={60} tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip {...tooltipStyle} formatter={(v, _n, p) => [`${fmt(Number(v), 0)} tok/s on ${p.payload.gpus} GPUs`, 'upper bound']} />
              <Bar dataKey="tok">{bars.map((b, i) => <Cell key={b.id} fill={colors[i]} fillOpacity={b.id === s.gpu ? 1 : 0.45} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="$ per M output tokens (lower bound, assumed prices)" height={220}>
          <ResponsiveContainer>
            <BarChart data={bars} margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="name" {...axis} interval={0} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis {...axis} width={60} />
              <Tooltip {...tooltipStyle} formatter={(v) => fmtUsd(Number(v))} />
              <Bar dataKey="usd">{bars.map((b, i) => <Cell key={b.id} fill={colors[i]} fillOpacity={b.id === s.gpu ? 1 : 0.45} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>

      <DataTable caption="Vendor specifications per GPU (dense tensor TFLOPS; checked 2026-10-31 on nvidia.com)" cols={['GPU', 'Memory', 'Bandwidth', 'BF16', 'FP8', 'Interconnect', 'Evidence', 'Source / note']}
        rows={GPUS.map((g) => [g.name, `${g.memGB} GB`, `${g.bwTBs} TB/s`, fmt(g.bf16, 1), fmt(g.fp8, 0), g.link, <EvidenceBadge e="vendor spec" key="e" />, <span className="small" key="s">{g.source} — {g.note}</span>])} />

      <ValuesTable cols={['GPU', 'GPUs', 'Need', 'Mem time', 'Compute time', 'Bound', 'tok/s', '$/M tok']} rows={results.map(({ g, r: x }) => [
        g.name, `${x.tp}${x.multiNode ? ' (multi-node)' : ''}`, fmtBytes(x.needBytes), fmtMs(x.memMs), fmtMs(x.computeMs), x.bound, fmt(x.tokPerSec, 0), fmtUsd(x.usdPerMTok),
      ])} />
    </SimLayout>
  );
}

// ---------- Q13: profiling classifier + trace ----------

const LANES: TraceEvent['lane'][] = ['CPU launch', 'GPU compute', 'HBM traffic', 'NCCL', 'Idle gap'];
const LANE_KIND: Record<TraceEvent['lane'], Kind> = { 'CPU launch': 'request', 'GPU compute': 'prefill', 'HBM traffic': 'kv', NCCL: 'comm', 'Idle gap': 'error' };

function TraceView({ ev }: { ev: TraceEvent[] }) {
  const end = Math.max(...ev.map((e) => e.start + e.dur));
  const W = 760; const L = 110; const rowH = 30;
  const X = (t: number) => L + (t / end) * (W - L - 10);
  return (
    <svg viewBox={`0 0 ${W} ${LANES.length * rowH + 30}`} width="100%" role="img" aria-label="Synthetic CPU/GPU trace; exact totals in the stats and table.">
      {LANES.map((lane, i) => (
        <g key={lane}>
          <text x={0} y={i * rowH + 20} fontSize="13" fill="var(--muted)">{lane}</text>
          <line x1={L} x2={W - 10} y1={i * rowH + 26} y2={i * rowH + 26} stroke="var(--border)" />
          {ev.filter((e) => e.lane === lane).map((e, k) => (
            <rect key={k} x={X(e.start)} y={i * rowH + 6} width={Math.max(1, X(e.start + e.dur) - X(e.start))} height={18} rx={3}
              fill={`var(--c-${LANE_KIND[lane]})`} fillOpacity={lane === 'Idle gap' ? 0.9 : 0.75}><title>{`${e.label}: ${fmt(e.dur, 1)} µs at ${fmt(e.start, 1)} µs`}</title></rect>
          ))}
        </g>
      ))}
      <text x={L} y={LANES.length * rowH + 24} fontSize="13" fill="var(--muted)">0 µs</text>
      <text x={W - 10} y={LANES.length * rowH + 24} fontSize="13" fill="var(--muted)" textAnchor="end">{fmt(end, 0)} µs</text>
    </svg>
  );
}

function ProfileSim() {
  const { s, set, active, pick, reset } = usePresetState({
    // 70B prefill of 2,048 tokens on one H100-class device (illustrative): big GEMMs.
    normal: { gflop: 286720, gbytes: 150, kernels: 800, launchUs: 5, measuredMs: 420, gpu: 'h100', kernelUs: 400, syncEvery: 10, ncclUs: 60 },
    // 70B decode, batch 1: read every weight for 2 FLOP per weight.
    stress: { gflop: 140, gbytes: 141, kernels: 800, launchUs: 5, measuredMs: 55, gpu: 'h100', kernelUs: 50, syncEvery: 10, ncclUs: 30 },
    // 1B model decode: kernels shorter than launches; host syncs every few kernels.
    failure: { gflop: 2, gbytes: 2.2, kernels: 400, launchUs: 8, measuredMs: 6, gpu: 'h100', kernelUs: 3, syncEvery: 5, ncclUs: 15 },
  });
  const g = GPUS.find((x) => x.id === s.gpu)!;
  const c = classify({ gflop: s.gflop, gbytes: s.gbytes, kernels: s.kernels, launchUs: s.launchUs, measuredMs: s.measuredMs, peakTflops: g.bf16, bwTBs: g.bwTBs });
  const memShare = Math.min(1, c.memMs / Math.max(c.memMs, c.computeMs));
  const ev = synthTrace(24, s.kernelUs, s.launchUs, s.syncEvery, s.ncclUs, memShare);
  const ts = traceSummary(ev);
  const ais: number[] = []; for (let a = 0.1; a <= 20000; a *= 2) ais.push(a);
  const roof = ais.map((ai) => ({ ai, ceiling: roofline(g.bf16, g.bwTBs, ai) }));
  const tone = c.bound === 'compute-bound' ? 'good' : c.bound === 'memory-bandwidth-bound' ? 'warn' : 'bad';
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <span className="small muted">Normal = prefill · Stress = decode batch 1 · Failure = tiny kernels + syncs</span>
      <Segmented label="GPU ceilings (BF16 dense)" value={s.gpu} options={GPUS.map((x) => ({ value: x.id, label: x.name.split(' (')[0] }))} onChange={(v) => set({ gpu: v })} />
      <Slider label="Work" value={s.gflop} min={1} max={400000} unit="GFLOP" onChange={(v) => set({ gflop: v })} />
      <Slider label="HBM bytes moved" value={s.gbytes} min={0.5} max={400} step={0.5} unit="GB" onChange={(v) => set({ gbytes: v })} />
      <Slider label="Kernel launches" value={s.kernels} min={1} max={4000} onChange={(v) => set({ kernels: v })} />
      <Slider label="Launch overhead per kernel" value={s.launchUs} min={0.5} max={20} step={0.5} unit="µs" onChange={(v) => set({ launchUs: v })} hint="CUDA graphs ≈ 1" />
      <Slider label="Measured step time" value={s.measuredMs} min={0.5} max={1000} step={0.5} unit="ms" onChange={(v) => set({ measuredMs: v })} />
      <Slider label="Trace: kernel duration" value={s.kernelUs} min={1} max={500} unit="µs" onChange={(v) => set({ kernelUs: v })} />
      <Slider label="Trace: host sync + all-reduce every" value={s.syncEvery} min={0} max={24} unit="kernels" onChange={(v) => set({ syncEvery: v })} hint="0 = never" />
    </>}>
      <div className="stats">
        <Stat k="Diagnosis" v={c.bound} tone={tone} ev="calculated" />
        <Stat k="Arithmetic intensity" v={fmt(c.ai, 1)} unit={`FLOP/B (ridge ${fmt(c.ridge, 0)})`} ev="calculated" />
        <Stat k="Achieved compute" v={fmt(c.achievedTflops, 1)} unit={`TFLOPS · ${fmtPct(c.pctCompute)}`} ev="calculated" />
        <Stat k="Achieved bandwidth" v={fmt(c.achievedTBs, 2)} unit={`TB/s · ${fmtPct(c.pctBw)}`} ev="calculated" />
        <Stat k="Floors: compute / memory / launch" v={`${fmtMs(c.computeMs)} / ${fmtMs(c.memMs)} / ${fmtMs(c.launchMs)}`} ev="calculated" />
        <Stat k="Unexplained time" v={fmtMs(c.unexplainedMs)} tone={c.unexplainedMs > c.predictedMs * 0.5 ? 'bad' : undefined} ev="calculated" />
      </div>

      <ChartBox title={`Roofline for ${g.name} with this kernel's achieved point (log-log)`} height={280}
        legend={<span className="small muted">Dot below the roof = headroom. Under the slanted part: buy bandwidth or move fewer bytes. Under the flat part: better kernels or less math.</span>}>
        <ResponsiveContainer>
          <ComposedChart data={roof} margin={{ left: 8, right: 24, top: 8 }}>
            <CartesianGrid {...grid} />
            <XAxis dataKey="ai" type="number" scale="log" domain={[0.1, 20000]} ticks={logTicks(1, 10000)} {...axis} allowDataOverflow height={44}
              label={{ value: 'FLOP per byte', position: 'insideBottom', offset: -4, fill: 'var(--muted)' }} />
            <YAxis type="number" scale="log" domain={[0.01, 5000]} ticks={logTicks(0.01, 1000)} {...axis} allowDataOverflow width={60} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)} TFLOPS`} />
            <Line dataKey="ceiling" name="Ceiling (min of compute, bandwidth × AI)" stroke={C.prefill} strokeWidth={2.5} dot={false} />
            <Scatter data={[{ ai: c.ai, ceiling: c.achievedTflops }]} dataKey="ceiling" name="Achieved" fill={C.kv} shape="diamond" />
            <Legend />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartBox>

      <figure className="chart-box" style={{ margin: 0 }}>
        <h3>Synthetic trace, first 24 kernels: GPU busy {fmtPct(ts.busyFrac)}, comms {fmtPct(ts.commFrac)}, idle {fmtPct(ts.idleFrac)}</h3>
        <TraceView ev={ev} />
        <div style={{ padding: '4px 16px' }}><KindLegend kinds={['request', 'prefill', 'kv', 'comm', 'error']} /></div>
      </figure>

      <ValuesTable cols={['Quantity', 'Value', 'Evidence']} rows={[
        ['Compute floor (peak)', fmtMs(c.computeMs), 'calculated'], ['Memory floor (peak)', fmtMs(c.memMs), 'calculated'],
        ['Launch total (no overlap)', fmtMs(c.launchMs), 'calculated'], ['Predicted', fmtMs(c.predictedMs), 'calculated'],
        ['Measured (your input)', fmtMs(s.measuredMs), 'input'], ['Trace span', `${fmt(ts.endUs, 0)} µs`, 'simulated'],
        ['Trace GPU busy / idle', `${fmtPct(ts.busyFrac)} / ${fmtPct(ts.idleFrac)}`, 'simulated'],
      ]} />
    </SimLayout>
  );
}

// ---------- Q14: serving pipeline ----------

const FAULTS: { id: Fault; label: string; evidence: string; experiment: string; expect: string }[] = [
  { id: 'tokenizer', label: 'Tokenizer saturated', evidence: 'API-server CPU at 100 % on one core; tokenize span ≫ queue span', experiment: 'Move tokenization to a process pool / Rust tokenizer; replay same trace', expect: 'Admitted req/s ↑, GPU batch ↑, TTFT ↓' },
  { id: 'eventloop', label: 'Blocked event loop', evidence: 'py-spy shows sync work in async handler; loop-lag metric spikes', experiment: 'Offload blocking call; measure loop lag before/after', expect: 'Loop lag → ms, step-gap ↓, duty ↑' },
  { id: 'admission', label: 'Admission cap too low', evidence: 'Running seqs flat at the cap while waiting queue > 0 and KV free', experiment: 'Raise max-num-seqs in steps; same arrivals', expect: 'Batch ↑, tok/s ↑ until KV or ITL SLO binds' },
  { id: 'kv', label: 'KV cache exhausted', evidence: 'KV usage ≈ 100 %, preemptions/swaps rising', experiment: 'FP8 KV or more memory per replica; compare preemption rate', expect: 'Preemptions ↓, batch ↑' },
  { id: 'imbalance', label: 'Load imbalance', evidence: 'Per-replica queue depth skewed; one replica hot', experiment: 'Switch router to least-outstanding-tokens', expect: 'Max/min replica load ratio → 1, p99 ↓' },
  { id: 'oversync', label: 'Over-synchronization', evidence: 'nsys: cudaStreamSynchronize / .item() between steps; gaps in GPU row', experiment: 'Remove host syncs, overlap sampling with next step', expect: 'Step-gap ↓, tok/s ↑ at same batch' },
];

function PipelineSim() {
  const { s, set, active, pick, reset } = usePresetState({
    normal: { lambda: 30, outTokens: 256, replicas: 4, faults: [] as Fault[] },
    stress: { lambda: 60, outTokens: 256, replicas: 4, faults: [] as Fault[] },
    failure: { lambda: 60, outTokens: 256, replicas: 4, faults: ['tokenizer', 'oversync'] as Fault[] },
  });
  const r = pipeline(s);
  const toggle = (f: Fault) => set({ faults: s.faults.includes(f) ? s.faults.filter((x) => x !== f) : [...s.faults, f] });
  const backlog = r.stages.reduce((a, x) => a + x.queueGrowth, 0) * 60;
  const repRows = r.replicaBatch.map((b, i) => ({ name: `GPU ${i + 1}`, batch: +b.toFixed(1), step: +r.stepMs[i].toFixed(1) }));
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Slider label="Offered load" value={s.lambda} min={1} max={150} unit="req/s" onChange={(v) => set({ lambda: v })} />
      <Slider label="Output tokens per request" value={s.outTokens} min={32} max={1024} step={32} unit="tok" onChange={(v) => set({ outTokens: v })} />
      <Slider label="GPU replicas" value={s.replicas} min={1} max={8} onChange={(v) => set({ replicas: v })} />
      <div className="ctl" role="group" aria-label="Inject faults">
        <span style={{ fontSize: 15, fontWeight: 500 }}>Inject faults</span>
        <div className="seg">{FAULTS.map((f) => <button key={f.id} type="button" aria-pressed={s.faults.includes(f.id)} onClick={() => toggle(f.id)}>{f.label}</button>)}</div>
      </div>
    </>}>
      <div className="stats">
        <Stat k="Delivered" v={fmt(r.delivered, 1)} unit={`of ${s.lambda} req/s`} tone={r.delivered < s.lambda * 0.99 ? 'bad' : 'good'} ev="simulated" />
        <Stat k="Bottleneck stage" v={r.bottleneck} tone={r.bottleneck === 'GPU decode' ? undefined : 'bad'} ev="simulated" />
        <Stat k="GPU duty (what nvidia-smi shows)" v={fmtPct(r.duty)} ev="simulated" />
        <Stat k="Useful work vs healthy max" v={fmtPct(r.usefulWork)} tone={r.usefulWork < 0.4 ? 'bad' : r.usefulWork < 0.7 ? 'warn' : 'good'} ev="simulated" />
        <Stat k="Max batch allowed" v={r.maxBatch} unit="seqs" ev="simulated" />
        <Stat k="Backlog after 60 s" v={fmt(backlog, 0)} unit="requests" tone={backlog > 0 ? 'bad' : 'good'} ev="simulated" />
      </div>

      <div className="card raised" style={{ padding: 18 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>Request path: capacity (req/s) and queue growth. The tightest stage sets throughput.</div>
        <div className="chips" style={{ alignItems: 'center' }}>
          {r.stages.map((st, i) => (
            <span key={st.stage} className="row" style={{ gap: 6 }}>
              {i > 0 && <span className="arrow">→</span>}
              <Chip kind={st.stage === r.bottleneck ? 'error' : st.stage === 'GPU decode' ? 'decode' : 'request'} label={st.stage}
                note={`cap ${fmt(st.capacity, 1)}${st.queueGrowth > 0 ? ` · +${fmt(st.queueGrowth, 1)}/s queue` : ''}`} />
            </span>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <ChartBox title="Offered vs capacity per stage (req/s)" height={260}>
          <ResponsiveContainer>
            <BarChart data={r.stages.map((x) => ({ ...x, capacity: +x.capacity.toFixed(1), offered: +x.offered.toFixed(1) }))} layout="vertical" margin={{ left: 16, right: 16 }}>
              <CartesianGrid {...grid} horizontal={false} />
              <XAxis type="number" {...axis} />
              <YAxis type="category" dataKey="stage" {...axis} width={100} />
              <Tooltip {...tooltipStyle} />
              <Legend />
              <Bar dataKey="offered" name="Offered" fill={C.request} />
              <Bar dataKey="capacity" name="Capacity" fill={C.decode} fillOpacity={0.7} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="Per-replica batch size (sequences)" height={260}>
          <ResponsiveContainer>
            <BarChart data={repRows} margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="name" {...axis} />
              <YAxis {...axis} width={44} />
              <Tooltip {...tooltipStyle} formatter={(v, n) => (n === 'batch' ? `${v} seqs` : `${v} ms`)} />
              <ReferenceLine y={r.maxBatch} stroke={C.error} strokeDasharray="6 4" label={{ value: 'max batch', fill: 'var(--c-error)', position: 'insideTopRight' }} />
              <Bar dataKey="batch" fill={C.prefill} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>

      <DataTable caption="Hypotheses: evidence, controlled experiment, expected metric change" cols={['Injected', 'Hypothesis', 'Evidence', 'Experiment', 'Expected change']}
        rows={FAULTS.map((f) => [s.faults.includes(f.id) ? '✕ yes' : '—', f.label, f.evidence, f.experiment, f.expect])} />

      <ValuesTable cols={['Stage', 'Offered', 'Capacity', 'Passed', 'Queue growth /s']} rows={r.stages.map((x) => [x.stage, fmt(x.offered, 2), fmt(x.capacity, 2), fmt(x.passed, 2), fmt(x.queueGrowth, 2)])} />
    </SimLayout>
  );
}

// ---------- Q15: fused RMSNorm ----------

function NormSim() {
  const { s, set, active, pick, reset } = usePresetState({
    normal: { rows: 4096, hidden: 8192, bytes: 2, bwTBs: 3.35, eff: 0.8, launchUs: 5, baseline: 'eager' as 'eager' | 'compiled', x4: 4 },
    stress: { rows: 65536, hidden: 16384, bytes: 4, bwTBs: 3.35, eff: 0.8, launchUs: 5, baseline: 'eager' as 'eager' | 'compiled', x4: 4 },
    failure: { rows: 4096, hidden: 8192, bytes: 2, bwTBs: 3.35, eff: 0.8, launchUs: 5, baseline: 'compiled' as 'eager' | 'compiled', x4: 4 },
  });
  const t = normTraffic(s);
  const x = [1, 2, 3, s.x4];
  const w = [1, 1, 1, 1];
  const y = rmsnorm(x, w);
  const ln = layernorm(x, w, [0, 0, 0, 0]);
  const ms = x.reduce((a, v) => a + v * v, 0) / 4;
  const rowsSweep = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536].map((rows) => {
    const r = normTraffic({ ...s, rows });
    return { rows, speedup: +r.speedup.toFixed(3), eager: +r.baseUs.toFixed(2), fused: +r.fusedUs.toFixed(2) };
  });
  const bars = [
    { name: s.baseline === 'eager' ? 'PyTorch eager (6 kernels)' : 'Compiled baseline (1 kernel)', mib: t.baseBytes / MiB, us: t.baseUs },
    { name: 'Fused Triton (1 kernel)', mib: t.fusedBytes / MiB, us: t.fusedUs },
  ];
  return (
    <SimLayout controls={<>
      <Presets active={active} onPick={pick} onReset={reset} />
      <Segmented label="Baseline" value={s.baseline} options={[{ value: 'eager', label: 'Eager expression' }, { value: 'compiled', label: 'Already fused' }]} onChange={(v) => set({ baseline: v })} />
      <Segmented label="Rows (tokens in batch)" value={s.rows} options={[1, 64, 4096, 65536].map((v) => ({ value: v, label: v.toLocaleString('en-US') }))} onChange={(v) => set({ rows: v })} />
      <Segmented label="Hidden size" value={s.hidden} options={[2048, 4096, 8192, 16384].map((v) => ({ value: v, label: String(v) }))} onChange={(v) => set({ hidden: v })} />
      <Segmented label="Activation dtype" value={s.bytes} options={[{ value: 2, label: 'BF16' }, { value: 4, label: 'FP32' }]} onChange={(v) => set({ bytes: v })} />
      <Slider label="Launch overhead" value={s.launchUs} min={1} max={20} step={0.5} unit="µs" onChange={(v) => set({ launchUs: v })} />
      <Slider label="Achieved bandwidth fraction" value={s.eff} min={0.3} max={1} step={0.05} onChange={(v) => set({ eff: v })} format={(v) => `${fmt(v * 100, 0)} % of ${s.bwTBs} TB/s`} />
      <Slider label="Worked example: x4" value={s.x4} min={0} max={40} step={1} onChange={(v) => set({ x4: v })} hint="x = [1, 2, 3, x4]" />
    </>}>
      <div className="card raised" style={{ padding: 18 }}>
        <div className="small muted" style={{ marginBottom: 8 }}>Worked row, w = [1, 1, 1, 1], ε = 1e-6 — one fused kernel does all of this in registers</div>
        <div className="chips" style={{ alignItems: 'center' }}>
          <Chip kind="request" label={`x = [${x.join(', ')}]`} />
          <span className="arrow">→</span><Chip kind="prefill" label={`x² = [${x.map((v) => v * v).join(', ')}]`} />
          <span className="arrow">→</span><Chip kind="prefill" label={`mean = ${fmt(ms, 4)}`} />
          <span className="arrow">→</span><Chip kind="prefill" label={`rsqrt(mean + ε) = ${fmt(1 / Math.sqrt(ms + 1e-6), 6)}`} />
          <span className="arrow">→</span><Chip kind="decode" label={`y = [${y.map((v) => fmt(v, 4)).join(', ')}]`} />
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>LayerNorm subtracts the mean first: [{ln.map((v) => fmt(v, 4)).join(', ')}] (sums to 0). RMSNorm keeps the mean: sum = {fmt(y.reduce((a, b) => a + b, 0), 4)}.</p>
      </div>

      <div className="stats">
        <Stat k="Baseline bytes moved" v={fmtBytes(t.baseBytes)} unit={`${t.baseLaunches} launch${t.baseLaunches > 1 ? 'es' : ''}`} ev="calculated" />
        <Stat k="Fused bytes moved" v={fmtBytes(t.fusedBytes)} unit="1 launch" ev="calculated" />
        <Stat k="Baseline time (model)" v={`${fmt(t.baseUs, 1)} µs`} ev="calculated" />
        <Stat k="Fused time (model)" v={`${fmt(t.fusedUs, 1)} µs`} ev="calculated" />
        <Stat k="Speedup upper bound" v={`${fmt(t.speedup, 2)}×`} tone={t.speedup < 1.1 ? 'bad' : 'good'} ev="calculated" />
        <Stat k="GPU result" v="not measured" ev="not measured" />
      </div>

      <div className="grid-2">
        <ChartBox title="Speedup bound vs rows (hidden fixed, log x)" height={260}
          legend={<span className="small muted">Few rows: launch count dominates (up to 6×). Many rows: bytes dominate (→ 7/2 = 3.5×).</span>}>
          <ResponsiveContainer>
            <LineChart data={rowsSweep} margin={{ left: 8, right: 16, top: 8 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="rows" type="number" scale="log" domain={[1, 65536]} ticks={[1, 16, 256, 4096, 65536]} {...axis} />
              <YAxis {...axis} width={44} domain={[0, 'auto']} />
              <Tooltip {...tooltipStyle} formatter={(v) => `${v}×`} labelFormatter={(l) => `${l} rows`} />
              <ReferenceLine x={s.rows} stroke={C.accent} label={{ value: 'now', fill: 'var(--accent)', position: 'top' }} />
              <Line dataKey="speedup" stroke={C.decode} strokeWidth={2.5} dot />
            </LineChart>
          </ResponsiveContainer>
        </ChartBox>
        <ChartBox title="HBM traffic per call (MiB)" height={260}>
          <ResponsiveContainer>
            <BarChart data={bars} margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...grid} />
              <XAxis dataKey="name" {...axis} interval={0} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis {...axis} width={60} tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip {...tooltipStyle} formatter={(v) => `${fmt(Number(v), 2)} MiB`} />
              <Bar dataKey="mib">{bars.map((b, i) => <Cell key={b.name} fill={i ? C.decode : C.error} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBox>
      </div>

      <ValuesTable cols={['Rows', 'Baseline µs', 'Fused µs', 'Speedup bound']} rows={rowsSweep.map((r) => [r.rows.toLocaleString('en-US'), fmt(r.eager, 2), fmt(r.fused, 2), `${r.speedup}×`])} />
    </SimLayout>
  );
}

export const sims: Record<number, ComponentType> = { 11: QuantSim, 12: GpuSim, 13: ProfileSim, 14: PipelineSim, 15: NormSim };
