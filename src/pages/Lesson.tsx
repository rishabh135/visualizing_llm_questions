import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, Download } from 'lucide-react';
import type { Lesson } from '../types';
import { STAGES, type Progress, type StageId } from '../lib';
import { GROUPS, LESSONS } from '../content';
import { SIMS } from '../sims';
import ScenePlayer from '../components/ScenePlayer';
import { Callout, Code, DataTable, EvidenceBadge, Omits, Reveal, TLDR, Tex } from '../components/ui';

const base = import.meta.env?.BASE_URL ?? './';

function Overview({ l }: { l: Lesson }) {
  return (
    <>
      <div className="card stack-lg">
        <h4>TL;DR</h4>
        <ol className="tldr-list">{l.tldr.map((t) => <li key={t}>{t}</li>)}</ol>
      </div>
      <div className="grid-2">
        <div className="card stack">
          <h3>In plain words</h3>
          <p>{l.plain}</p>
        </div>
        <div className="card stack">
          <h3>Analogy: {l.analogy.name}</h3>
          <div className="table-wrap map-table">
            <table>
              <thead><tr><th scope="col">Everyday</th><th scope="col">System</th></tr></thead>
              <tbody>{l.analogy.map.map(([a, b]) => <tr key={a}><td>{a}</td><td><span className="arrow" aria-hidden="true">→ </span>{b}</td></tr>)}</tbody>
            </table>
          </div>
          <Callout tone="warn" title="Where the analogy breaks">{l.analogy.breaks}</Callout>
        </div>
      </div>
    </>
  );
}

function Example({ l }: { l: Lesson }) {
  const [revealed, setRevealed] = useState(false);
  const [guess, setGuess] = useState('');
  const [step, setStep] = useState(0);
  const ex = l.example;
  return (
    <div className="split">
      <div className="card stack">
        <h3>{ex.title}</h3>
        <p className="mono small muted">Inputs: {ex.inputs}</p>
        <div className="stepper">
          <div className="step-dots" role="group" aria-label="Example steps">
            {ex.steps.map((s, i) => (
              <button key={i} type="button" className="btn-sm" aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>{i + 1}. {s.label}</button>
            ))}
          </div>
          <div className="state-box" aria-live="polite"><b>Step {step + 1} of {ex.steps.length} · {ex.steps[step].label}</b>{'\n'}{ex.steps[step].state}</div>
          <div className="row">
            <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><ArrowLeft size={16} aria-hidden="true" />Back</button>
            <button type="button" onClick={() => setStep((s) => Math.min(ex.steps.length - 1, s + 1))} disabled={step === ex.steps.length - 1}>Next step<ArrowRight size={16} aria-hidden="true" /></button>
          </div>
        </div>
        {step === ex.steps.length - 1 && <Callout tone="ok" title="Output">{ex.output}</Callout>}
      </div>
      <div className="card stack">
        <span className="eyebrow">Predict first</span>
        <p style={{ fontWeight: 500 }}>{ex.predict.q}</p>
        <label className="stack" style={{ gap: 6 }}>
          <span className="small muted">Your guess (kept only on this page)</span>
          <input type="text" value={guess} onChange={(e) => setGuess(e.target.value)} placeholder="e.g. 8× more" />
        </label>
        <button type="button" className="btn-primary" onClick={() => setRevealed((r) => !r)} aria-expanded={revealed}>{revealed ? 'Hide answer' : 'Reveal answer'}</button>
        {revealed && <Callout tone="ok" title={guess ? `You said: ${guess}` : 'Answer'}>{ex.predict.a}</Callout>}
      </div>
    </div>
  );
}

function Simulator({ l }: { l: Lesson }) {
  const Sim = SIMS[l.id];
  return (
    <>
      {Sim ? <Sim /> : <Callout tone="err" title="Simulator unavailable">No simulator registered for Q{l.id}.</Callout>}
      <Omits items={l.sim.omits} />
    </>
  );
}

function MathStage({ l }: { l: Lesson }) {
  const f = l.formula;
  return (
    <>
      <div className="card stack-lg">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>{f.name}</h3>
          <span className="badge ev-calculated">{f.isModel ? 'model / decision rule' : 'formula'}</span>
        </div>
        <div className="formula-tex"><Tex tex={f.tex} /></div>
        <p className="cue">“{f.cue}”</p>
        <div className="grid-2">
          <DataTable cols={['Symbol', 'Meaning', 'Unit']} rows={f.vars.map(([s, m, u]) => [<code key={s}>{s}</code>, m, u])} />
          <div className="stack">
            <div><h4>Substituted</h4><p className="mono small" style={{ overflowWrap: 'anywhere' }}>{f.substituted}</p></div>
            <div><h4>Dimensional check</h4><p className="small">{f.check}</p></div>
            <div><h4>Assumptions</h4><ul className="small">{f.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></div>
          </div>
        </div>
      </div>
      <div className="stack">
        <h3>Practical estimates</h3>
        <DataTable cols={['Quantity', 'Value', 'Unit', 'Assumptions', 'Source', 'Evidence']}
          rows={l.estimates.map((e) => [e.quantity, <b key="v" className="num">{e.value}</b>, e.unit, e.assumptions, e.source, <EvidenceBadge key="e" e={e.evidence} />])} />
        <p className="small muted">Evidence: <EvidenceBadge e="calculated" /> from formula · <EvidenceBadge e="simulated" /> browser model · <EvidenceBadge e="vendor spec" /> datasheet · <EvidenceBadge e="assumed" /> editable input · <EvidenceBadge e="not measured" /> needs hardware.</p>
      </div>
    </>
  );
}

function Build({ l }: { l: Lesson }) {
  const c = l.compare, lab = l.lab, b = l.bench;
  return (
    <>
      <div className="grid-3">
        <div className="card stack"><span className="badge ev-not-measured" style={{ justifySelf: 'start' }}>✕ Naive</span><p>{c.naive}</p></div>
        <div className="card stack"><span className="badge ev-measured" style={{ justifySelf: 'start' }}>✓ Improved</span><p>{c.improved}</p></div>
        <div className="card stack"><span className="badge ev-calculated" style={{ justifySelf: 'start' }}>⚙ Mechanism</span><p>{c.mechanism}</p></div>
      </div>
      <DataTable cols={['Metric', 'Naive', 'Improved']} rows={c.rows} />
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>Lab: {lab.title}</h3>
          <span className="badge ev-assumed">{{ browser: 'Browser', cpu: 'CPU', gpu: 'GPU required', protocol: 'Implementation protocol' }[lab.kind]}</span>
        </div>
        <p className="small muted">Dependencies: {lab.deps}</p>
        <Code code={lab.code} lang={lab.lang} />
        <div className="grid-2">
          <div><h4>Run</h4><Code code={lab.commands.join('\n')} lang="bash" /></div>
          <div><h4>Correctness checks</h4><ul className="small">{lab.checks.map((x) => <li key={x}>{x}</li>)}</ul></div>
        </div>
        {lab.file && <a className="btn" href={`${base}${lab.file}`} download><Download size={16} aria-hidden="true" />Download {lab.file.split('/').pop()}</a>}
        <Callout tone="warn" title="Production gap">{lab.gaps}</Callout>
      </div>
      <Reveal label="Benchmark protocol (no results are invented)">
        <DataTable cols={['Field', 'Plan']} rows={[
          ['Hypothesis', b.hypothesis], ['Baseline', b.baseline], ['Controlled', b.controlled.join(' · ')], ['Workload', b.workload],
          ['Warm-up', b.warmup], ['Repetitions', b.reps], ['Measurement', b.method], ['Interpretation', b.interpret],
        ]} />
        <DataTable caption="Results" cols={['Metric', 'Median', 'p99 / CI', 'Evidence']}
          rows={b.metrics.map((m) => [m, '—', '—', <EvidenceBadge key="e" e="not measured" />])} />
      </Reveal>
    </>
  );
}

function Tradeoffs({ l }: { l: Lesson }) {
  return (
    <div className="grid-3">
      <div className="card stack"><h3>✕ Pitfalls</h3><ul>{l.pitfalls.map((p) => <li key={p}>{p}</li>)}</ul></div>
      <div className="card stack">
        <h3>⚙ Optimizations</h3>
        {l.optimizations.map(([o, t]) => <div key={o}><b>{o}</b><p className="small muted">Trade-off: {t}</p></div>)}
      </div>
      <div className="card stack"><h3>⚠ Stops working when</h3><ul>{l.breaks.map((p) => <li key={p}>{p}</li>)}</ul></div>
    </div>
  );
}

function Interview({ l }: { l: Lesson }) {
  const iv = l.interview;
  const words = iv.short.split(/\s+/).length;
  return (
    <>
      <Reveal label={`60–90 second answer (${words} words ≈ ${Math.round(words / 2.5)} s spoken)`}><p>{iv.short}</p></Reveal>
      <Reveal label="Whiteboard answer (step by step)"><ol>{iv.whiteboard.map((w) => <li key={w}>{w}</li>)}</ol></Reveal>
      <div className="stack">
        <h3>Follow-ups</h3>
        {iv.followups.map(([q, a]) => <Reveal key={q} label={q}><p>{a}</p></Reveal>)}
      </div>
      <div className="grid-2">
        <div className="card stack"><span className="eyebrow">Debug challenge</span><p>{iv.debug[0]}</p><Reveal label="Show diagnosis"><p>{iv.debug[1]}</p></Reveal></div>
        <div className="card stack"><span className="eyebrow">Calculation challenge</span><p>{iv.calc[0]}</p><Reveal label="Show working"><p className="mono small">{iv.calc[1]}</p></Reveal></div>
      </div>
      <div className="grid-2">
        <div className="card stack"><h3>What would change my decision?</h3><ul>{l.changeMind.map((c) => <li key={c}>{c}</li>)}</ul></div>
        <div className="card stack"><h3>Recall check</h3>{l.recall.map(([q, a]) => <Reveal key={q} label={q}><p>{a}</p></Reveal>)}</div>
      </div>
    </>
  );
}

/** Key line per stage, taken from lesson content so every stage opens with a TL;DR. */
function stageKey(l: Lesson, s: StageId): string {
  switch (s) {
    case 'overview': return l.why;
    case 'example': return `${l.example.inputs} → ${l.example.output}`;
    case 'lesson': return `${l.scenes.length} scenes, ${l.scenes.reduce((a, x) => a + x.duration, 0)} s. Press Play, or scrub to any moment.`;
    case 'simulator': return `${l.sim.tldr} Try Normal → Stress → Failure.`;
    case 'math': return l.formula.cue;
    case 'build': return l.compare.mechanism;
    case 'tradeoffs': return l.breaks[0];
    case 'interview': return l.recall[0] ? `${l.recall[0][0]} → ${l.recall[0][1]}` : '';
  }
}

export default function LessonPage({ lesson: l, stage, progress, toggleDone }: { lesson: Lesson; stage: StageId; progress: Progress; toggleDone: (id: number) => void }) {
  const idx = STAGES.findIndex((s) => s.id === stage);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownKey = useRef(`${l.id}/${stage}`);
  const visited = progress.visited[l.id] ?? [];
  const done = progress.done.includes(l.id);
  const group = GROUPS.find((g) => g.id === l.group);
  const pos = LESSONS.findIndex((x) => x.id === l.id);
  const prevQ = LESSONS[pos - 1], nextQ = LESSONS[pos + 1];

  // Move focus to the stage heading on deliberate stage changes (not on first load).
  useEffect(() => {
    const k = `${l.id}/${stage}`;
    if (shownKey.current === k) return;
    shownKey.current = k;
    heading.current?.focus({ preventScroll: true });
  }, [stage, l.id]);

  const go = (i: number) => { location.hash = `#/q/${l.id}/${STAGES[i].id}`; };

  return (
    <article className="stack-lg" aria-labelledby="lesson-title">
      <header className="lesson-head">
        <span className="eyebrow">Q{l.id} of 25 · {group?.title}</span>
        <h1 id="lesson-title">{l.short}</h1>
        <p className="q">“{l.question}”</p>
      </header>

      <nav className="stage-nav" aria-label="Lesson stages">
        {STAGES.map((s, i) => (
          <button key={s.id} type="button" aria-current={i === idx ? 'step' : undefined} onClick={() => go(i)} aria-label={`Stage ${i + 1}: ${s.label}${visited.includes(s.id) ? ', visited' : ''}`}>
            <span className="sn" aria-hidden="true">{visited.includes(s.id) && i !== idx ? '✓' : i + 1}</span><span className="lbl">{s.label}</span>
          </button>
        ))}
      </nav>

      <section className="stage-panel" key={stage} aria-labelledby="stage-title">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 id="stage-title" ref={heading} tabIndex={-1}>{STAGES[idx].label}</h2>
          <span className="small muted num">Stage {idx + 1} of {STAGES.length}</span>
        </div>
        <TLDR tag={stage === 'overview' ? 'WHY' : 'TL;DR'}>{stageKey(l, stage)}</TLDR>
        {stage === 'overview' && <Overview l={l} />}
        {stage === 'example' && <Example l={l} />}
        {stage === 'lesson' && <ScenePlayer scenes={l.scenes} />}
        {stage === 'simulator' && <Simulator l={l} />}
        {stage === 'math' && <MathStage l={l} />}
        {stage === 'build' && <Build l={l} />}
        {stage === 'tradeoffs' && <Tradeoffs l={l} />}
        {stage === 'interview' && <Interview l={l} />}
      </section>

      <footer className="stage-foot">
        <button type="button" onClick={() => go(idx - 1)} disabled={idx === 0}><ArrowLeft size={16} aria-hidden="true" />{idx > 0 ? STAGES[idx - 1].label : 'Previous'}</button>
        <button type="button" onClick={() => toggleDone(l.id)} aria-pressed={done}>
          {done ? <CheckCircle2 size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}{done ? 'Completed' : 'Mark question complete'}
        </button>
        {idx < STAGES.length - 1
          ? <button type="button" className="btn-primary" onClick={() => go(idx + 1)}>{STAGES[idx + 1].label}<ArrowRight size={16} aria-hidden="true" /></button>
          : nextQ
            ? <a className="btn btn-primary" href={`#/q/${nextQ.id}/overview`}>Next: Q{nextQ.id} {nextQ.short}<ArrowRight size={16} aria-hidden="true" /></a>
            : <a className="btn btn-primary" href="#/practice">Interview practice<ArrowRight size={16} aria-hidden="true" /></a>}
      </footer>
      {idx === 0 && prevQ && <p className="small muted">Previous question: <a href={`#/q/${prevQ.id}/overview`}>Q{prevQ.id} {prevQ.short}</a></p>}
    </article>
  );
}
