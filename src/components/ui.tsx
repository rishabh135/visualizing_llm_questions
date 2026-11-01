import { useId, useState, type ReactNode } from 'react';
import katex from 'katex';
import { Check, Copy, RotateCcw } from 'lucide-react';
import type { Evidence, Kind } from '../types';

/** Glyph per mechanism so colour is never the only cue. */
export const KIND_GLYPH: Record<Kind, string> = {
  request: '▶', prefill: '◆', decode: '●', kv: '■', comm: '↔', error: '✕', ok: '✓', neutral: '○',
};
export const KIND_LABEL: Record<Kind, string> = {
  request: 'Request', prefill: 'Prefill', decode: 'Decode', kv: 'KV cache', comm: 'Communication', error: 'Error / rejected', ok: 'Done', neutral: 'Other',
};
/** Chart colours resolve from the same CSS tokens as the interface. */
export const C = {
  request: 'var(--c-request)', prefill: 'var(--c-prefill)', decode: 'var(--c-decode)', kv: 'var(--c-kv)',
  comm: 'var(--c-comm)', error: 'var(--c-error)', ok: 'var(--c-ok)', neutral: 'var(--c-neutral)',
  accent: 'var(--accent)', muted: 'var(--muted)', grid: 'var(--border)', text: 'var(--text)', surface: 'var(--surface)',
};

export function TLDR({ children, tag = 'TL;DR' }: { children: ReactNode; tag?: string }) {
  return (
    <div className="tldr">
      <span className="tag">{tag}</span>
      <p>{children}</p>
    </div>
  );
}

export function Callout({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'err' | 'ok'; title?: string; children: ReactNode }) {
  return (
    <div className={`callout ${tone === 'info' ? '' : tone}`} role="note">
      {title && <b>{title}</b>}
      <div>{children}</div>
    </div>
  );
}

export function EvidenceBadge({ e }: { e: Evidence }) {
  return <span className={`badge ev-${e.replace(' ', '-')}`}>{e}</span>;
}

export function Reveal({ label, children, open = false }: { label: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="reveal" open={open}>
      <summary>{label}</summary>
      <div className="reveal-body">{children}</div>
    </details>
  );
}

export function Chip({ kind, label, note, className = '' }: { kind: Kind; label: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <span className={`chip k-${kind} ${className}`}>
      <span><span className="g" aria-hidden="true">{KIND_GLYPH[kind]}</span>{label}</span>
      {note != null && <span className="note">{note}</span>}
    </span>
  );
}

export function KindLegend({ kinds }: { kinds: Kind[] }) {
  return (
    <div className="legend" aria-label="Legend">
      {kinds.map((k) => (
        <span key={k}><span className="sw" style={{ background: C[k] }} aria-hidden="true" /><span aria-hidden="true">{KIND_GLYPH[k]}</span>{KIND_LABEL[k]}</span>
      ))}
    </div>
  );
}

/** Labelled range slider with an exact numeric input; both drive the same value. */
export function Slider({ label, value, min, max, step = 1, unit = '', onChange, format, hint }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void; format?: (v: number) => string; hint?: string;
}) {
  const id = useId();
  const set = (raw: number) => { if (Number.isFinite(raw)) onChange(Math.min(max, Math.max(min, raw))); };
  return (
    <div className="ctl">
      <div className="ctl-top">
        <label htmlFor={id}>{label}</label>
        <span className="val" aria-hidden="true">{format ? format(value) : `${value.toLocaleString('en-US')}${unit ? ' ' + unit : ''}`}</span>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 10 }}>
        <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(+e.target.value)}
          aria-valuetext={format ? format(value) : `${value} ${unit}`} />
        <input type="number" aria-label={`${label} exact value${unit ? ' in ' + unit : ''}`} min={min} max={max} step={step} value={value}
          onChange={(e) => set(+e.target.value)} />
      </div>
      <div className="bounds"><span>{min.toLocaleString('en-US')}</span>{hint && <span>{hint}</span>}<span>{max.toLocaleString('en-US')}{unit ? ' ' + unit : ''}</span></div>
    </div>
  );
}

/** Segmented choice for discrete options (precision, policy, preset). */
export function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="ctl" role="group" aria-label={label}>
      <span style={{ fontSize: 15, fontWeight: 500 }}>{label}</span>
      <div className="seg">
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

export type PresetName = 'normal' | 'stress' | 'failure';
const PRESET_LABEL: Record<PresetName, string> = { normal: '✓ Normal', stress: '▲ Stress', failure: '✕ Failure' };

/** Normal / stress / failure presets plus reset. Every simulator uses this. */
export function Presets({ active, onPick, onReset }: { active: PresetName | null; onPick: (p: PresetName) => void; onReset: () => void }) {
  return (
    <div className="ctl" role="group" aria-label="Scenario presets">
      <span style={{ fontSize: 15, fontWeight: 500 }}>Scenario</span>
      <div className="seg">
        {(['normal', 'stress', 'failure'] as PresetName[]).map((p) => (
          <button key={p} type="button" aria-pressed={active === p} onClick={() => onPick(p)}>{PRESET_LABEL[p]}</button>
        ))}
        <button type="button" onClick={onReset} aria-label="Reset all inputs"><RotateCcw size={16} aria-hidden="true" />Reset</button>
      </div>
    </div>
  );
}

/**
 * State helper for a simulator with presets: preset values are plain objects, any manual edit clears the active label.
 * Returns [state, set(partial), presetName, pick, reset].
 */
export function usePresetState<S extends object>(presets: Record<PresetName, S>) {
  const [state, setState] = useState<S>(presets.normal);
  const [active, setActive] = useState<PresetName | null>('normal');
  const set = (patch: Partial<S>) => { setState((s) => ({ ...s, ...patch })); setActive(null); };
  const pick = (p: PresetName) => { setState(presets[p]); setActive(p); };
  const reset = () => pick('normal');
  return { s: state, set, active, pick, reset };
}

export function Stat({ k, v, unit, tone, ev }: { k: string; v: ReactNode; unit?: string; tone?: 'good' | 'bad' | 'warn'; ev?: Evidence }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="k">{k}</span>
      <span className="v">{v}{unit && <small>{unit}</small>}</span>
      {ev && <span><EvidenceBadge e={ev} /></span>}
    </div>
  );
}

export function ChartBox({ title, height = 280, children, legend }: { title: string; height?: number; children: ReactNode; legend?: ReactNode }) {
  return (
    <figure className="chart-box" style={{ margin: 0 }}>
      <h3>{title}</h3>
      <div style={{ width: '100%', height }}>{children}</div>
      {legend && <div style={{ padding: '8px 16px' }}>{legend}</div>}
    </figure>
  );
}

export function DataTable({ caption, cols, rows }: { caption?: string; cols: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table>
        {caption && <caption>{caption}</caption>}
        <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Accessible exact-value table that sits under a chart, collapsed by default. */
export function ValuesTable({ cols, rows, label = 'Exact values (table)' }: { cols: string[]; rows: ReactNode[][]; label?: string }) {
  return <Reveal label={label}><DataTable cols={cols} rows={rows} /></Reveal>;
}

export function Tex({ tex, block = true }: { tex: string; block?: boolean }) {
  const html = katex.renderToString(tex, { displayMode: block, throwOnError: false, output: 'htmlAndMathml' });
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Code({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="code-wrap">
      <pre className="code" aria-label={lang ? `${lang} code` : 'code'}><code>{code}</code></pre>
      <button type="button" className="copy" onClick={copy} aria-label="Copy code">
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** What the simulator leaves out, always visible under it. */
export function Omits({ items }: { items: string[] }) {
  return (
    <Callout tone="warn" title="This simulator omits">
      <ul className="small">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </Callout>
  );
}

/** Shared layout: controls on the left, outputs on the right. */
export function SimLayout({ controls, children }: { controls: ReactNode; children: ReactNode }) {
  return (
    <div className="sim">
      <form className="sim-controls" onSubmit={(e) => e.preventDefault()} aria-label="Simulator controls">{controls}</form>
      <div className="sim-out" aria-live="polite">{children}</div>
    </div>
  );
}

/** Recharts axis/tooltip props that follow the theme tokens. */
export const axis = { stroke: 'var(--muted)', tick: { fill: 'var(--muted)', fontSize: 13 }, tickLine: false } as const;
export const grid = { stroke: 'var(--border)', strokeDasharray: '3 3' } as const;
export const tooltipStyle = {
  contentStyle: { background: 'var(--raised)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)', fontSize: 14 },
  labelStyle: { color: 'var(--text)' },
  itemStyle: { color: 'var(--text)' },
} as const;
