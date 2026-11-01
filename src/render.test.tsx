// Server-render every lesson x stage and every tool page. Catches render exceptions and missing content,
// not browser behaviour.
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { LESSONS } from './content';
import { SIMS } from './sims';
import { STAGES } from './lib';
import LessonPage from './pages/Lesson';
import Home from './pages/Home';
import { Formulas, Glossary, Labs, Practice, Scenarios } from './pages/Tools';

vi.stubGlobal('location', { hash: '#/' });
const progress = { visited: {}, done: [] };

describe('curriculum coverage', () => {
  it('has all 25 questions with ids 1..25', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
  it.each(LESSONS.map((l) => [l.id, l] as const))('Q%i meets the lesson template', (_, l) => {
    expect(l.tldr).toHaveLength(3);
    expect(l.analogy.map.length).toBeGreaterThanOrEqual(3);
    expect(l.example.steps.length).toBeGreaterThanOrEqual(3);
    expect(l.scenes).toHaveLength(5);
    const total = l.scenes.reduce((a, s) => a + s.duration, 0);
    expect(total).toBeGreaterThanOrEqual(60);
    expect(total).toBeLessThanOrEqual(120);
    expect(new Set(l.scenes.map((s) => s.id)).size).toBe(5);
    expect(l.estimates.length).toBeGreaterThanOrEqual(3);
    expect(l.pitfalls.length).toBeGreaterThanOrEqual(3);
    expect(l.optimizations.length).toBeGreaterThanOrEqual(3);
    expect(l.breaks.length).toBeGreaterThanOrEqual(1);
    expect(l.interview.followups.length).toBeGreaterThanOrEqual(3);
    expect(l.sim.omits.length).toBeGreaterThanOrEqual(1);
    expect(SIMS[l.id], `simulator for Q${l.id}`).toBeTypeOf('function');
  });
});

describe('server render', () => {
  for (const l of LESSONS) {
    it(`Q${l.id} renders all ${STAGES.length} stages`, () => {
      for (const s of STAGES) {
        const html = renderToString(<LessonPage lesson={l} stage={s.id} progress={progress} toggleDone={() => {}} />);
        expect(html.length, `${l.id}/${s.id}`).toBeGreaterThan(500);
      }
    });
  }
  it('tool pages render', () => {
    for (const C of [Glossary, Formulas, Scenarios, Practice, Labs]) expect(renderToString(<C />).length).toBeGreaterThan(200);
    expect(renderToString(<Home progress={progress} />)).toContain('Inference Engineering Lab');
  });
});
