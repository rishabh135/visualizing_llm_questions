// Routing, storage and search. Small hand-rolled pieces: no router or search dependency needed.
import { useCallback, useEffect, useState } from 'react';
import { LESSONS } from './content';
import type { Lesson } from './types';

export const STAGES = [
  { id: 'overview', label: 'Overview', blurb: 'Question, TL;DR, analogy' },
  { id: 'example', label: 'Small example', blurb: 'Predict, then step through' },
  { id: 'lesson', label: 'Guided lesson', blurb: '60–120 s animated walkthrough' },
  { id: 'simulator', label: 'Simulator', blurb: 'Change inputs, watch numbers move' },
  { id: 'math', label: 'Formula & estimates', blurb: 'Equation, units, evidence' },
  { id: 'build', label: 'Build & measure', blurb: 'Naive vs better, lab, benchmark' },
  { id: 'tradeoffs', label: 'Trade-offs', blurb: 'Pitfalls, optimizations, limits' },
  { id: 'interview', label: 'Interview', blurb: 'Answers, follow-ups, challenges' },
] as const;
export type StageId = (typeof STAGES)[number]['id'];

export type Route =
  | { page: 'home' }
  | { page: 'lesson'; id: number; stage: StageId }
  | { page: 'glossary' | 'formulas' | 'scenarios' | 'practice' | 'labs' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'q') {
    const id = Number(parts[1]);
    const stage = (STAGES.find((s) => s.id === parts[2])?.id ?? 'overview') as StageId;
    if (LESSONS.some((l) => l.id === id)) return { page: 'lesson', id, stage };
  }
  if (['glossary', 'formulas', 'scenarios', 'practice', 'labs'].includes(parts[0])) return { page: parts[0] as 'glossary' };
  return { page: 'home' };
}

export const href = (r: Route) => (r.page === 'home' ? '#/' : r.page === 'lesson' ? `#/q/${r.id}/${r.stage}` : `#/${r.page}`);

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(typeof location === 'undefined' ? '' : location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** localStorage with in-memory fallback: denied, full or corrupt storage never breaks the app. */
const memory = new Map<string, string>();
function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key) ?? memory.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, v: unknown) {
  const raw = JSON.stringify(v);
  memory.set(key, raw);
  try { localStorage.setItem(key, raw); } catch { /* memory fallback only */ }
}

export function useStored<T>(key: string, fallback: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => readStore(key, fallback));
  const set = useCallback((n: T | ((p: T) => T)) => {
    setV((p) => {
      const next = typeof n === 'function' ? (n as (p: T) => T)(p) : n;
      writeStore(key, next);
      return next;
    });
  }, [key]);
  return [v, set];
}

export interface Progress { visited: Record<number, string[]>; done: number[] }
export const emptyProgress: Progress = { visited: {}, done: [] };

// ---------- Search ----------

export interface SearchHit { type: 'question' | 'stage' | 'glossary' | 'formula' | 'page'; title: string; sub: string; to: string; score: number }

const norm = (s: string) => s.toLowerCase();

/** Collected glossary across lessons, de-duplicated by term. */
export function allGlossary(): { term: string; def: string; ids: number[] }[] {
  const m = new Map<string, { term: string; def: string; ids: number[] }>();
  for (const l of LESSONS) for (const [term, def] of l.glossary) {
    const k = norm(term);
    const e = m.get(k);
    if (e) { if (!e.ids.includes(l.id)) e.ids.push(l.id); } else m.set(k, { term, def, ids: [l.id] });
  }
  return [...m.values()].sort((a, b) => a.term.localeCompare(b.term));
}

const PAGES = [
  { title: 'Glossary', sub: 'Every acronym and term, searchable', to: '#/glossary' },
  { title: 'Formula reference', sub: 'All formula cards with units and cues', to: '#/formulas' },
  { title: 'Scenario lab', sub: 'Every simulator with normal/stress/failure presets', to: '#/scenarios' },
  { title: 'Interview practice', sub: 'Timed prompts, rubric, flashcards', to: '#/practice' },
  { title: 'Runnable labs', sub: 'SSE server, Triton RMSNorm, benchmark harness', to: '#/labs' },
];

/** Token-AND search: every query word must appear; title hits rank above body hits. */
export function search(q: string, limit = 30): SearchHit[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  const score = (title: string, body: string) => {
    const t = norm(title), b = norm(body);
    let s = 0;
    for (const w of words) {
      if (t.includes(w)) s += 3; else if (b.includes(w)) s += 1; else return 0;
    }
    return s;
  };
  const push = (type: SearchHit['type'], title: string, sub: string, to: string, body: string, bonus = 0) => {
    const s = score(title, body);
    if (s) hits.push({ type, title, sub, to, score: s + bonus });
  };
  for (const l of LESSONS) {
    push('question', `Q${l.id} · ${l.short}`, l.question, `#/q/${l.id}/overview`, [l.question, l.why, ...l.tldr, l.plain, ...l.tags].join(' '), 1);
    push('stage', `Q${l.id} · Simulator`, l.sim.tldr, `#/q/${l.id}/simulator`, [l.short, l.sim.tldr, ...l.sim.omits].join(' '));
    push('stage', `Q${l.id} · Pitfalls & limits`, l.pitfalls[0] ?? '', `#/q/${l.id}/tradeoffs`, [l.short, ...l.pitfalls, ...l.breaks, ...l.optimizations.flat()].join(' '));
    push('stage', `Q${l.id} · Interview answer`, l.interview.followups[0]?.[0] ?? '', `#/q/${l.id}/interview`, [l.short, l.interview.short, ...l.interview.followups.flat()].join(' '));
    push('formula', l.formula.name, l.formula.cue, `#/q/${l.id}/math`, [l.short, l.formula.substituted, ...l.formula.vars.map((v) => v.join(' '))].join(' '));
  }
  for (const g of allGlossary()) push('glossary', g.term, g.def, `#/glossary?t=${encodeURIComponent(g.term)}`, g.def, 1);
  for (const p of PAGES) push('page', p.title, p.sub, p.to, p.sub, 2);
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Highlight query words in a string (presentation only). */
export function highlightParts(text: string, q: string): { t: string; hit: boolean }[] {
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [{ t: text, hit: false }];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).filter(Boolean).map((t) => ({ t, hit: words.includes(norm(t)) }));
}

export const lessonText = (l: Lesson) => [l.short, l.question, ...l.tldr, ...l.tags].join(' ');
