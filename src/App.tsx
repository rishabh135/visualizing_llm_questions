import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, CheckCircle2, Command, FlaskConical, GraduationCap, Home as HomeIcon, Menu, Moon, Search, Sigma, SlidersHorizontal, Sun, Terminal, X } from 'lucide-react';
import { GROUPS, LESSONS, byId } from './content';
import { STAGES, emptyProgress, highlightParts, lessonText, search, useRoute, useStored, type Progress, type Route } from './lib';
import Home from './pages/Home';
import LessonPage from './pages/Lesson';
import { Formulas, Glossary, Labs, Practice, Scenarios } from './pages/Tools';

export function Hl({ text, q }: { text: string; q: string }) {
  return <>{highlightParts(text, q).map((p, i) => (p.hit ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}</>;
}

function useMedia(query: string) {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/** Keep Tab inside `root` while active; Escape calls onClose. */
function useFocusTrap(active: boolean, root: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const el = root.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])];
    (el?.querySelector<HTMLElement>('input') ?? focusables()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, [active, root, onClose]);
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, onClose);
  const hits = q.trim() ? search(q) : LESSONS.map((l) => ({ type: 'question' as const, title: `Q${l.id} · ${l.short}`, sub: l.tldr[0], to: `#/q/${l.id}/overview`, score: 0 }));
  const go = (to: string) => { location.hash = to; onClose(); };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search the lab" ref={ref}>
        <input type="search" placeholder="Search questions, formulas, glossary…  (try: kv fp8, p99, chunked)" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter' && hits[sel]) go(hits[sel].to);
          }}
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={hits[sel] ? `ph-${sel}` : undefined} />
        <ul id="palette-list" role="listbox">
          {hits.length === 0 && <li className="muted" style={{ padding: 16 }}>No matches. Try fewer words.</li>}
          {hits.map((h, i) => (
            <li key={h.to + h.title} role="presentation">
              <a id={`ph-${i}`} role="option" aria-selected={i === sel} href={h.to} onClick={(e) => { e.preventDefault(); go(h.to); }} onMouseEnter={() => setSel(i)}>
                <span className="ptype">{h.type}</span>
                <span><Hl text={h.title} q={q} /></span>
                <span className="psub"><Hl text={h.sub} q={q} /></span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SideLink({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return <a className="side-link" href={to} aria-current={current ? 'page' : undefined}>{children}</a>;
}

function Sidebar({ route, progress, filter, setFilter }: { route: Route; progress: Progress; filter: string; setFilter: (s: string) => void }) {
  const f = filter.trim().toLowerCase();
  const matches = (text: string) => f.split(/\s+/).every((w) => text.toLowerCase().includes(w));
  const tools: [string, string, ReactNode][] = [
    ['#/scenarios', 'Scenario lab', <SlidersHorizontal size={18} />],
    ['#/practice', 'Interview practice', <GraduationCap size={18} />],
    ['#/formulas', 'Formula reference', <Sigma size={18} />],
    ['#/glossary', 'Glossary', <BookOpen size={18} />],
    ['#/labs', 'Runnable labs', <Terminal size={18} />],
  ];
  return (
    <>
      <a className="brand" href="#/"><span className="brand-mark"><FlaskConical size={18} aria-hidden="true" /></span>Inference Engineering Lab</a>
      <div className="side-search">
        <Search size={16} aria-hidden="true" />
        <input type="search" placeholder="Filter 25 questions" aria-label="Filter questions" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <nav aria-label="Curriculum">
        <SideLink to="#/" current={route.page === 'home'}><HomeIcon size={18} aria-hidden="true" />Start here</SideLink>
        {GROUPS.map((g) => {
          const ls = LESSONS.filter((l) => l.group === g.id && (!f || matches(lessonText(l))));
          if (!ls.length) return null;
          const done = ls.filter((l) => progress.done.includes(l.id)).length;
          return (
            <div className="side-group" key={g.id}>
              <h4><span>{g.title}</span><span className="num">{done}/{ls.length}</span></h4>
              {ls.map((l) => (
                <SideLink key={l.id} to={`#/q/${l.id}/${route.page === 'lesson' ? route.stage : 'overview'}`} current={route.page === 'lesson' && route.id === l.id}>
                  <span className="qn">Q{l.id}</span>
                  <span><Hl text={l.short} q={filter} /></span>
                  {progress.done.includes(l.id) && <CheckCircle2 size={16} className="done" aria-label="completed" />}
                </SideLink>
              ))}
            </div>
          );
        })}
        {f && !LESSONS.some((l) => matches(lessonText(l))) && <p className="small muted" style={{ padding: 8 }}>No question matches “{filter}”. Press <kbd>⌘K</kbd> for full-text search.</p>}
      </nav>
      <nav className="side-tools" aria-label="Tools">
        {tools.map(([to, label, icon]) => <SideLink key={to} to={to} current={`#/${route.page}` === to}><span aria-hidden="true">{icon}</span>{label}</SideLink>)}
      </nav>
    </>
  );
}

export default function App() {
  const route = useRoute();
  const [theme, setTheme] = useStored<'dark' | 'light'>('iel-theme', 'dark');
  const [progress, setProgress] = useStored<Progress>('iel-progress-v1', emptyProgress);
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState('');
  const mobile = useMedia('(max-width: 900px)');
  const sideRef = useRef<HTMLElement>(null);
  const closeDrawer = useRef(() => setDrawer(false)).current;
  const closePalette = useRef(() => setPalette(false)).current;
  useFocusTrap(mobile && drawer, sideRef, closeDrawer);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { setDrawer(false); window.scrollTo({ top: 0 }); }, [route.page, route.page === 'lesson' ? route.id : 0]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setPalette(true); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  // Record stage visits for honest progress.
  useEffect(() => {
    if (route.page !== 'lesson') return;
    setProgress((p) => {
      const v = p.visited[route.id] ?? [];
      return v.includes(route.stage) ? p : { ...p, visited: { ...p.visited, [route.id]: [...v, route.stage] } };
    });
  }, [route, setProgress]);

  const lesson = route.page === 'lesson' ? byId(route.id) : undefined;
  const stageLabel = route.page === 'lesson' ? STAGES.find((s) => s.id === route.stage)?.label : '';
  const crumb = lesson ? <>Q{lesson.id} · <b>{lesson.short}</b> · {stageLabel}</> : <b>{{ home: 'Start here', glossary: 'Glossary', formulas: 'Formula reference', scenarios: 'Scenario lab', practice: 'Interview practice', labs: 'Runnable labs', lesson: '' }[route.page]}</b>;
  const pct = progress.done.length / LESSONS.length;
  const toggleDone = (id: number) => setProgress((p) => ({ ...p, done: p.done.includes(id) ? p.done.filter((x) => x !== id) : [...p.done, id] }));

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      {mobile && drawer && <div className="overlay" style={{ padding: 0 }} onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside className={`sidebar ${drawer ? 'open' : ''}`} ref={sideRef} inert={mobile && !drawer ? true : undefined}
        role={mobile ? 'dialog' : undefined} aria-modal={mobile && drawer ? true : undefined} aria-label="Navigation">
        {mobile && <button type="button" className="btn-ghost icon-btn" style={{ alignSelf: 'flex-end' }} onClick={() => setDrawer(false)} aria-label="Close menu"><X size={20} /></button>}
        <Sidebar route={route} progress={progress} filter={filter} setFilter={setFilter} />
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="menu-btn icon-btn btn-ghost" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}><Menu size={22} /></button>
          <div className="crumb">{crumb}</div>
          <button type="button" className="btn-sm" onClick={() => setPalette(true)} aria-label="Search (Command K)">
            <Search size={16} aria-hidden="true" /><span className="hide-sm">Search</span><kbd aria-hidden="true"><Command size={11} style={{ verticalAlign: -1 }} />K</kbd>
          </button>
          <div className="progress-pill" title="Questions you marked complete">
            <div className="progress-bar" aria-hidden="true"><span style={{ width: `${pct * 100}%` }} /></div>
            <span className="num">{progress.done.length}/{LESSONS.length}</span><span className="sr-only">questions completed</span>
          </div>
          <button type="button" className="icon-btn btn-ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {route.page === 'home' && <Home progress={progress} />}
          {route.page === 'lesson' && lesson && <LessonPage lesson={lesson} stage={route.stage} progress={progress} toggleDone={toggleDone} />}
          {route.page === 'glossary' && <Glossary />}
          {route.page === 'formulas' && <Formulas />}
          {route.page === 'scenarios' && <Scenarios />}
          {route.page === 'practice' && <Practice />}
          {route.page === 'labs' && <Labs />}
        </main>
      </div>
      {palette && <Palette onClose={closePalette} />}
    </div>
  );
}
