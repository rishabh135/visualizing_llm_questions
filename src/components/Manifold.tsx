import { useMemo, useState } from 'react';
import { rng } from '../engines/core';
import { C } from './ui';

// Conceptual only: synthetic 2-D points drawn on a curved sheet. Not a real model's embeddings.
const CLUSTERS = [
  { name: 'animals', color: C.decode, words: ['cat', 'kitten', 'dog', 'puppy', 'tiger'], cx: 0.25, cy: 0.35 },
  { name: 'GPU terms', color: C.prefill, words: ['GPU', 'kernel', 'HBM', 'SRAM', 'warp'], cx: 0.7, cy: 0.3 },
  { name: 'cities', color: C.kv, words: ['Paris', 'Berlin', 'Tokyo', 'Delhi', 'Lima'], cx: 0.5, cy: 0.72 },
];

/** Map unit-square coordinates onto a bent sheet so the "surface" reads as curved. */
const bend = (u: number, v: number, w: number, h: number) => ({
  x: 40 + u * (w - 80),
  y: 30 + v * (h - 60) + Math.sin(u * Math.PI) * 40 - 20,
});

export default function Manifold() {
  const W = 640, H = 360;
  const pts = useMemo(() => {
    const r = rng(7);
    return CLUSTERS.flatMap((c) => c.words.map((w) => {
      const u = c.cx + (r() - 0.5) * 0.18, v = c.cy + (r() - 0.5) * 0.18;
      return { w, c, u, v, ...bend(u, v, W, H) };
    }));
  }, []);
  const [sel, setSel] = useState(0);
  const p = pts[sel];
  const near = pts.map((q, i) => ({ i, d: Math.hypot(q.u - p.u, q.v - p.v) })).filter((x) => x.i !== sel).sort((a, b) => a.d - b.d).slice(0, 3);
  const grid = [];
  for (let k = 0; k <= 8; k++) {
    const a = Array.from({ length: 21 }, (_, j) => bend(j / 20, k / 8, W, H));
    const b = Array.from({ length: 21 }, (_, j) => bend(k / 8, j / 20, W, H));
    grid.push(<polyline key={`h${k}`} points={a.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="var(--border)" />);
    grid.push(<polyline key={`v${k}`} points={b.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="var(--border)" />);
  }
  return (
    <div className="stack">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Conceptual embedding map. Selected ${p.w}; nearest: ${near.map((n) => pts[n.i].w).join(', ')}`} style={{ width: '100%', height: 'auto', background: 'var(--surface)', borderRadius: 12 }}>
        {grid}
        {near.map((n) => <line key={n.i} x1={p.x} y1={p.y} x2={pts[n.i].x} y2={pts[n.i].y} stroke="var(--accent)" strokeDasharray="4 3" />)}
        {pts.map((q, i) => (
          <g key={q.w} onClick={() => setSel(i)} style={{ cursor: 'pointer' }}>
            <circle cx={q.x} cy={q.y} r={i === sel ? 9 : 6} fill={q.c.color} stroke={i === sel ? 'var(--text)' : 'none'} strokeWidth={2} />
            <text x={q.x + 10} y={q.y + 4} fontSize={14} fill="var(--text)">{q.w}</text>
          </g>
        ))}
      </svg>
      <div className="seg" role="group" aria-label="Select a word">
        {pts.map((q, i) => <button key={q.w} type="button" className="btn-sm" aria-pressed={i === sel} onClick={() => setSel(i)}>{q.w}</button>)}
      </div>
      <p className="small">Nearest to <b>{p.w}</b> on this projection: {near.map((n) => pts[n.i].w).join(', ')}.</p>
      <p className="small muted">Synthetic points on a 2-D projection. Real embeddings have thousands of dimensions; projection distorts distances. This picture explains semantic neighbourhoods only — never KV allocation, kernel speed or scheduling.</p>
    </div>
  );
}
