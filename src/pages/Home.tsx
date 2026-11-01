import { ArrowRight, BookOpen, GraduationCap, SlidersHorizontal } from 'lucide-react';
import { GROUPS, LESSONS } from '../content';
import { STAGES, type Progress } from '../lib';
import { KindLegend, Reveal } from '../components/ui';
import Manifold from '../components/Manifold';

export default function Home({ progress }: { progress: Progress }) {
  const next = LESSONS.find((l) => !progress.done.includes(l.id)) ?? LESSONS[0];
  const scenes = LESSONS.reduce((a, l) => a + l.scenes.length, 0);
  return (
    <>
      <section className="hero">
        <span className="eyebrow">25 interview questions · 8 stages each</span>
        <h1>LLM Inference Engineering Lab</h1>
        <p>Calculate it, simulate it, build it, then defend it. Every number comes from a visible formula; nothing is a made-up benchmark.</p>
        <div className="row">
          <a className="btn btn-primary" href={`#/q/${next.id}/overview`}>{progress.done.length ? 'Continue' : 'Start'}: Q{next.id} {next.short}<ArrowRight size={16} aria-hidden="true" /></a>
          <a className="btn" href="#/scenarios"><SlidersHorizontal size={16} aria-hidden="true" />Scenario lab</a>
          <a className="btn" href="#/practice"><GraduationCap size={16} aria-hidden="true" />Practice</a>
          <a className="btn" href="#/formulas"><BookOpen size={16} aria-hidden="true" />Formulas</a>
        </div>
        <p className="small muted">Press <kbd>⌘K</kbd> or <kbd>/</kbd> to search everything.</p>
      </section>

      <section className="grid-3" aria-label="How each lesson works">
        <div className="card stack"><span className="eyebrow">1 · Understand</span><p>TL;DR, an analogy with its limits, and a tiny example you predict before revealing.</p></div>
        <div className="card stack"><span className="eyebrow">2 · Play</span><p>A {Math.round(LESSONS.reduce((a, l) => a + l.scenes.reduce((b, s) => b + s.duration, 0), 0) / LESSONS.length)}-second guided lesson, then a simulator with normal, stress and failure presets.</p></div>
        <div className="card stack"><span className="eyebrow">3 · Defend</span><p>Formula card, runnable lab, benchmark protocol, trade-offs and a timed interview answer.</p></div>
      </section>

      <section className="card stack" aria-label="Stages and colour key">
        <h4>Stages in every question</h4>
        <div className="chips">{STAGES.map((s, i) => <span key={s.id} className="chip k-neutral"><span><span className="g">{i + 1}</span>{s.label}</span><span className="note">{s.blurb}</span></span>)}</div>
        <h4 style={{ marginTop: 8 }}>Colour key (always paired with a symbol)</h4>
        <KindLegend kinds={['request', 'prefill', 'decode', 'kv', 'comm', 'error']} />
        <p className="small muted">{LESSONS.length} questions · {scenes} guided scenes · {LESSONS.length} simulators. Progress is saved in this browser only.</p>
      </section>

      <Reveal label="Optional · Conceptual embedding map (not a mechanism diagram)"><Manifold /></Reveal>

      {GROUPS.map((g) => {
        const ls = LESSONS.filter((l) => l.group === g.id);
        return (
          <section key={g.id} className="stack" aria-labelledby={`g-${g.id}`}>
            <div className="group-head"><h2 id={`g-${g.id}`}>{g.title}</h2><span className="muted small">{g.blurb}</span></div>
            <div className="grid-auto">
              {ls.map((l) => (
                <a key={l.id} className="qcard" href={`#/q/${l.id}/overview`}>
                  <span className="qn">Q{l.id}{progress.done.includes(l.id) ? ' · ✓ done' : ''}</span>
                  <h3>{l.short}</h3>
                  <p>{l.tldr[0]}</p>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
