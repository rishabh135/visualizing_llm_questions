import { useEffect, useMemo, useState } from 'react';
import { Pause, Play, RotateCcw, Shuffle } from 'lucide-react';
import { LESSONS, byId } from '../content';
import { SIMS } from '../sims';
import { allGlossary, useStored } from '../lib';
import { Hl } from '../App';
import { Callout, Code, DataTable, Omits, Reveal, TLDR, Tex } from '../components/ui';

const base = import.meta.env?.BASE_URL ?? './';

function Filter({ value, set, label }: { value: string; set: (s: string) => void; label: string }) {
  return <input type="search" value={value} onChange={(e) => set(e.target.value)} placeholder={label} aria-label={label} style={{ maxWidth: 480, width: '100%' }} />;
}
const has = (text: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

export function Glossary() {
  const initial = decodeURIComponent(location.hash.split('?t=')[1] ?? '');
  const [q, setQ] = useState(initial);
  const items = allGlossary().filter((g) => has(`${g.term} ${g.def}`, q));
  const letters = [...new Set(items.map((g) => g.term[0].toUpperCase()))];
  return (
    <div className="stack-lg">
      <h1>Glossary</h1>
      <TLDR>{allGlossary().length} terms collected from all lessons. Each links to the questions that use it.</TLDR>
      <Filter value={q} set={setQ} label="Filter terms" />
      <nav className="row small" aria-label="Jump to letter">{letters.map((c) => <a key={c} href={`#/glossary`} onClick={(e) => { e.preventDefault(); document.getElementById(`gl-${c}`)?.scrollIntoView(); }}>{c}</a>)}</nav>
      <dl className="stack">
        {items.map((g, i) => (
          <div key={g.term} className="card" style={{ padding: 18 }} id={i === 0 || items[i - 1].term[0].toUpperCase() !== g.term[0].toUpperCase() ? `gl-${g.term[0].toUpperCase()}` : undefined}>
            <dt style={{ fontWeight: 650 }}><Hl text={g.term} q={q} /></dt>
            <dd style={{ margin: '4px 0 0' }}><Hl text={g.def} q={q} /> <span className="small">{g.ids.map((id) => <a key={id} href={`#/q/${id}/overview`} style={{ marginLeft: 8 }}>Q{id}</a>)}</span></dd>
          </div>
        ))}
        {!items.length && <p className="muted">No term matches “{q}”.</p>}
      </dl>
    </div>
  );
}

export function Formulas() {
  const [q, setQ] = useState('');
  const ls = LESSONS.filter((l) => has(`${l.formula.name} ${l.formula.cue} ${l.short} ${l.formula.vars.flat().join(' ')}`, q));
  return (
    <div className="stack-lg">
      <h1>Formula reference</h1>
      <TLDR>One card per question: equation, memory cue, variables and a substituted example. Open the question for units and assumptions.</TLDR>
      <Filter value={q} set={setQ} label="Filter formulas" />
      <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))' }}>
        {ls.map((l) => (
          <div key={l.id} className="card stack">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <a href={`#/q/${l.id}/math`}><b>Q{l.id} · {l.formula.name}</b></a>
              {l.formula.isModel && <span className="badge ev-assumed">model</span>}
            </div>
            <div className="formula-tex" style={{ fontSize: '1em' }}><Tex tex={l.formula.tex} /></div>
            <p className="cue" style={{ fontSize: 16 }}>“{l.formula.cue}”</p>
            <Reveal label="Variables and worked numbers">
              <DataTable cols={['Symbol', 'Meaning', 'Unit']} rows={l.formula.vars.map(([s, m, u]) => [<code key={s}>{s}</code>, m, u])} />
              <p className="mono small" style={{ overflowWrap: 'anywhere' }}>{l.formula.substituted}</p>
            </Reveal>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Scenarios() {
  const [id, setId] = useStored<number>('iel-scenario', 3);
  const l = byId(id) ?? LESSONS[0];
  const Sim = SIMS[l.id];
  return (
    <div className="stack-lg">
      <h1>Scenario lab</h1>
      <TLDR>All {Object.keys(SIMS).length} simulators in one place. Pick one, then try Normal → Stress → Failure.</TLDR>
      <label className="row">
        <span>Simulator</span>
        <select value={l.id} onChange={(e) => setId(+e.target.value)} style={{ maxWidth: '100%' }}>
          {LESSONS.map((x) => <option key={x.id} value={x.id}>Q{x.id} · {x.short}</option>)}
        </select>
        <a href={`#/q/${l.id}/overview`}>Open full lesson →</a>
      </label>
      <p className="muted">{l.sim.tldr}</p>
      {Sim ? <Sim key={l.id} /> : <Callout tone="err" title="Unavailable">No simulator for this question.</Callout>}
      <Omits items={l.sim.omits} />
    </div>
  );
}

type Mode = 'explain' | 'whiteboard' | 'debug' | 'defend' | 'flashcards';
const MODES: { id: Mode; label: string; secs: number }[] = [
  { id: 'explain', label: 'Explain in plain English', secs: 90 },
  { id: 'whiteboard', label: 'Calculate on a whiteboard', secs: 300 },
  { id: 'debug', label: 'Debug a production incident', secs: 300 },
  { id: 'defend', label: 'Defend a design', secs: 180 },
  { id: 'flashcards', label: 'Flashcards', secs: 0 },
];
const RUBRIC = ['Correctness', 'Arithmetic and units', 'Trade-offs named', 'How to measure / prove it', 'Failure behaviour', 'Clarity and structure'];

export function Practice() {
  const [mode, setMode] = useState<Mode>('explain');
  const [qid, setQid] = useState(LESSONS[0]?.id ?? 1);
  const [left, setLeft] = useState(MODES[0].secs);
  const [running, setRunning] = useState(false);
  const [score, setScore] = useState<boolean[]>(RUBRIC.map(() => false));
  const [card, setCard] = useState(0);
  const [flip, setFlip] = useState(false);
  const l = byId(qid) ?? LESSONS[0];
  const m = MODES.find((x) => x.id === mode)!;

  useEffect(() => { setLeft(m.secs); setRunning(false); setScore(RUBRIC.map(() => false)); }, [mode, qid, m.secs]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLeft((x) => { if (x <= 1) { setRunning(false); return 0; } return x - 1; }), 1000);
    return () => clearInterval(t);
  }, [running]);

  const prompt = useMemo(() => {
    const iv = l.interview;
    switch (mode) {
      case 'explain': return { q: l.question, hints: l.tldr, a: iv.short };
      case 'whiteboard': return { q: iv.calc[0], hints: [l.formula.cue, ...l.formula.assumptions], a: `${iv.calc[1]}\n\nWhiteboard steps: ${iv.whiteboard.join(' → ')}` };
      case 'debug': return { q: iv.debug[0], hints: l.pitfalls, a: iv.debug[1] };
      default: return { q: `Defend: “${l.compare.improved}” — the interviewer asks: ${iv.followups[0]?.[0] ?? ''}`, hints: [...l.breaks, ...l.changeMind], a: iv.followups[0]?.[1] ?? '' };
    }
  }, [l, mode]);

  const deck = LESSONS;
  const fc = deck[card % deck.length];
  const random = () => setQid(LESSONS[Math.floor(Math.random() * LESSONS.length)].id);

  return (
    <div className="stack-lg">
      <h1>Interview practice</h1>
      <TLDR>Pick a mode, start the timer, answer out loud, then score yourself against the rubric before opening the model answer.</TLDR>
      <div className="seg" role="group" aria-label="Practice mode">
        {MODES.map((x) => <button key={x.id} type="button" aria-pressed={mode === x.id} onClick={() => setMode(x.id)}>{x.label}</button>)}
      </div>

      {mode === 'flashcards' ? (
        <div className="stack" style={{ maxWidth: 760 }}>
          <div className="card flash" aria-live="polite">
            {!flip ? <div className="stack"><span className="eyebrow">Q{fc.id}</span><b>{fc.short}</b><span className="small muted">Intuition · formula · failure condition?</span></div> : (
              <div className="stack" style={{ textAlign: 'left', fontSize: 17 }}>
                <p><b>Intuition:</b> {fc.tldr[0]}</p>
                <p><b>Formula / rule:</b> {fc.formula.cue}</p>
                <p><b>Fails when:</b> {fc.breaks[0]}</p>
              </div>
            )}
          </div>
          <div className="row">
            <button type="button" onClick={() => { setCard((c) => (c - 1 + deck.length) % deck.length); setFlip(false); }}>Previous</button>
            <button type="button" className="btn-primary" onClick={() => setFlip((f) => !f)}>{flip ? 'Show front' : 'Flip card'}</button>
            <button type="button" onClick={() => { setCard((c) => (c + 1) % deck.length); setFlip(false); }}>Next</button>
            <button type="button" onClick={() => { setCard(Math.floor(Math.random() * deck.length)); setFlip(false); }}><Shuffle size={16} aria-hidden="true" />Shuffle</button>
            <span className="muted small num">Card {(card % deck.length) + 1} of {deck.length}</span>
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="card stack">
            <label className="row">
              <span>Question</span>
              <select value={qid} onChange={(e) => setQid(+e.target.value)} style={{ maxWidth: '100%' }}>
                {LESSONS.map((x) => <option key={x.id} value={x.id}>Q{x.id} · {x.short}</option>)}
              </select>
              <button type="button" className="btn-sm" onClick={random}><Shuffle size={14} aria-hidden="true" />Random</button>
            </label>
            <p style={{ fontSize: 19, fontWeight: 500 }}>{prompt.q}</p>
            <div className="row">
              <span className="timer" role="timer" aria-live="off">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
              <button type="button" className="btn-primary" onClick={() => setRunning((r) => !r)} disabled={left === 0}>
                {running ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{running ? 'Pause' : 'Start timer'}
              </button>
              <button type="button" onClick={() => { setLeft(m.secs); setRunning(false); }} aria-label="Reset timer"><RotateCcw size={16} aria-hidden="true" /></button>
            </div>
            {left === 0 && <Callout tone="warn" title="Time">Wrap up in one sentence: the decision and how you would prove it.</Callout>}
            <Reveal label="Hints (open only if stuck)"><ul className="small">{prompt.hints.map((h) => <li key={h}>{h}</li>)}</ul></Reveal>
            <Reveal label="Model answer"><p style={{ whiteSpace: 'pre-wrap' }}>{prompt.a}</p></Reveal>
          </div>
          <div className="card stack">
            <h3>Self-score rubric</h3>
            {RUBRIC.map((r, i) => (
              <label key={r} className="row" style={{ gap: 10, minHeight: 44 }}>
                <input type="checkbox" checked={score[i]} onChange={() => setScore((s) => s.map((x, j) => (j === i ? !x : x)))} style={{ width: 22, height: 22, accentColor: 'var(--accent)' }} />
                {r}
              </label>
            ))}
            <p className="cue">{score.filter(Boolean).length} / {RUBRIC.length}</p>
            <p className="small muted">A strong answer states assumptions, does the arithmetic with units, names one trade-off, and says what measurement would change the decision.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const LAB_FILES: [string, string, string, string][] = [
  ['labs/sse_server.py', 'Cancellation-safe SSE server (mock engine)', 'python3 labs/sse_server.py', 'CPU · stdlib only'],
  ['labs/sse_client.html', 'Browser fetch-stream client with abort', 'open http://localhost:8080/', 'Browser'],
  ['labs/test_sse_server.py', 'Cancellation and cleanup tests', 'python3 -m unittest labs/test_sse_server.py', 'CPU'],
  ['labs/rmsnorm.py', 'Triton fused RMSNorm + checks + benchmark', 'python3 labs/rmsnorm.py --check && python3 labs/rmsnorm.py --bench', 'GPU (CUDA + Triton)'],
  ['labs/benchmark.py', 'Open-loop streaming benchmark harness', 'python3 labs/benchmark.py --dry-run --rate 5 --duration 3', 'CPU client; any OpenAI-compatible server'],
  ['labs/PROTOCOL.md', 'Production protocols: rollout, disaggregation, autoscaling, engine comparison', '—', 'Checklist'],
  ['labs/README.md', 'Lab index with expected outputs', '—', 'Docs'],
];

export function Labs() {
  return (
    <div className="stack-lg">
      <h1>Runnable labs</h1>
      <TLDR>Download, run, and compare against the stated checks. GPU results stay “not measured” until you run them on your hardware.</TLDR>
      <DataTable cols={['File', 'What it is', 'Run', 'Needs']} rows={LAB_FILES.map(([f, d, c, n]) => [<a key={f} href={`${base}${f}`} download>{f.split('/').pop()}</a>, d, <code key="c" style={{ overflowWrap: 'anywhere' }}>{c}</code>, n])} />
      <h2>Per-question labs</h2>
      <DataTable cols={['Q', 'Lab', 'Kind']} rows={LESSONS.map((l) => [`Q${l.id}`, <a key="a" href={`#/q/${l.id}/build`}>{l.lab.title}</a>, l.lab.kind])} />
      <h2>Use the design skill in Claude Code</h2>
      <p>This repo ships the <code>build-visual-artifacts</code> skill under <code>.claude/skills/</code>. Copy it to your personal skills folder:</p>
      <Code lang="bash" code={'mkdir -p ~/.claude/skills\ncp -R .claude/skills/build-visual-artifacts ~/.claude/skills/'} />
    </div>
  );
}
