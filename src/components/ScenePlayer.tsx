import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import type { Scene } from '../types';
import { Chip, KindLegend, Reveal } from './ui';

/** Map absolute time to (scene index, progress within scene). Pure, so scrubbing is deterministic. */
export function locate(scenes: Scene[], t: number) {
  let start = 0;
  for (let i = 0; i < scenes.length; i++) {
    const d = scenes[i].duration;
    if (t < start + d || i === scenes.length - 1) return { i, start, p: Math.min(1, Math.max(0, (t - start) / d)) };
    start += d;
  }
  return { i: 0, start: 0, p: 0 };
}

export const sentences = (s: string) => s.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [s];

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Draw one scene at progress p. Items appear at `at` and are struck through at `out`. */
export function SceneView({ scene, p }: { scene: Scene; p: number }) {
  // The most recently appeared item gets a ring: it is "what just happened".
  let freshest = -1;
  let key = '';
  scene.lanes.forEach((lane, li) => lane.items.forEach((it, ii) => {
    const at = it.at ?? 0;
    if (at <= p && at >= freshest && at > 0) { freshest = at; key = `${li}-${ii}`; }
  }));
  const kinds = [...new Set(scene.lanes.flatMap((l) => l.items.map((i) => i.kind)))];
  return (
    <div className="scene-stage">
      {scene.lanes.map((lane, li) => (
        <div className="lane" key={li}>
          <div className="lane-label">{lane.label}</div>
          <div className="chips">
            {lane.items.map((it, ii) => {
              const shown = p >= (it.at ?? 0);
              const gone = it.out != null && p >= it.out;
              const cls = !shown ? 'hidden' : gone ? 'gone' : key === `${li}-${ii}` ? 'fresh' : '';
              return <Chip key={ii} kind={it.kind} label={it.label} note={it.note} className={cls} />;
            })}
          </div>
        </div>
      ))}
      <KindLegend kinds={kinds} />
    </div>
  );
}

export default function ScenePlayer({ scenes }: { scenes: Scene[] }) {
  const total = useMemo(() => scenes.reduce((a, s) => a + s.duration, 0), [scenes]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) { last.current = null; return; }
    let raf = 0;
    const tick = (now: number) => {
      if (last.current != null) {
        const dt = ((now - last.current) / 1000) * speed;
        setT((x) => {
          const nx = x + dt;
          if (nx >= total) { setPlaying(false); return total; }
          return nx;
        });
      }
      last.current = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Pause when the tab is hidden so the lesson never runs unseen.
    const vis = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', vis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis); };
  }, [playing, speed, total]);

  const { i, start, p } = locate(scenes, t);
  const scene = scenes[i];
  const caps = sentences(scene.narration);
  const cap = caps[Math.min(caps.length - 1, Math.floor(p * caps.length))];
  const jump = (idx: number) => { const s = scenes.slice(0, idx).reduce((a, x) => a + x.duration, 0); setT(s); };
  const toggle = () => { if (t >= total) setT(0); setPlaying((x) => !x); };

  return (
    <div className="player">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="eyebrow">Scene {i + 1} of {scenes.length} · {scene.id}</div>
          <h3>{scene.title}</h3>
        </div>
        <span className="mono muted num">{fmtClock(t)} / {fmtClock(total)}</span>
      </div>

      <SceneView scene={scene} p={p} />
      <div className="scene-time" aria-hidden="true"><span style={{ width: `${p * 100}%` }} /></div>
      <div className="caption" aria-live={playing ? 'off' : 'polite'}>{cap}</div>
      {scene.equation && <div className="eq">{scene.equation}</div>}

      <div className="player-controls">
        <button type="button" className="btn-primary" onClick={toggle} aria-label={playing ? 'Pause lesson' : 'Play lesson'}>
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}{playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="icon-btn" onClick={() => { setT(0); setPlaying(false); }} aria-label="Restart lesson"><RotateCcw size={18} aria-hidden="true" /></button>
        <button type="button" className="icon-btn" onClick={() => jump(Math.max(0, p < 0.15 ? i - 1 : i))} aria-label="Previous scene"><SkipBack size={18} aria-hidden="true" /></button>
        <button type="button" className="icon-btn" onClick={() => jump(Math.min(scenes.length - 1, i + 1))} disabled={i === scenes.length - 1} aria-label="Next scene"><SkipForward size={18} aria-hidden="true" /></button>
        <label className="scrub">
          <span className="sr-only">Lesson position in seconds</span>
          <input type="range" min={0} max={total} step={0.1} value={t} onChange={(e) => { setPlaying(false); setT(+e.target.value); }}
            aria-valuetext={`${fmtClock(t)} of ${fmtClock(total)}, scene ${i + 1}`} />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="small muted">Speed</span>
          <select value={speed} onChange={(e) => setSpeed(+e.target.value)} aria-label="Playback speed">
            {[0.5, 0.75, 1, 1.5, 2].map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
        </label>
      </div>

      <div className="chapters" role="group" aria-label="Chapters">
        {scenes.map((s, k) => (
          <button key={s.id} type="button" aria-current={k === i ? 'step' : undefined} onClick={() => jump(k)}>
            <span className="mono small">{k + 1}</span>{s.title}
          </button>
        ))}
      </div>

      <div className="grid-2">
        <div className="card raised stack" style={{ padding: 20 }}>
          <h4>This scene</h4>
          <p><b>Goal:</b> {scene.objective}</p>
          <p><b>Changes:</b> {scene.transition}</p>
          <p><b>Try:</b> {scene.action}</p>
        </div>
        <Reveal label={`Full transcript (${scenes.length} scenes, ${Math.round(total)} s)`}>
          {scenes.map((s, k) => (
            <div key={s.id}>
              <b className="small">{k + 1}. {s.title} <span className="muted mono">({fmtClock(scenes.slice(0, k).reduce((a, x) => a + x.duration, 0))})</span></b>
              <p className="small">{s.narration}</p>
            </div>
          ))}
        </Reveal>
      </div>
      <p className="small muted">Schematic browser lesson, not a GPU trace or an exported video. Scene {i + 1} starts at {fmtClock(start)}.</p>
    </div>
  );
}
