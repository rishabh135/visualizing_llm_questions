import React, { useId, useRef, useState } from 'react';

// In a project, import './theme.css' from the copied asset location.
// For a single-file artifact, inline that CSS in a <style> element in this root.
// stages: [{ id, label, title, description, render: ({ active, theme }) => <View /> }]
// Render components from render(); do not call Hooks directly in the callback.
// Use active to pause timers and to remeasure diagrams after a stage becomes visible.
export default function CarouselShell({ title = 'Interactive explanation', subtitle,
  stages = [], initialTheme = 'dark' }) {
  const [index, setIndex] = useState(0);
  const [theme, setTheme] = useState(initialTheme);
  const [visited, setVisited] = useState(() => new Set([0]));
  const navigation = useRef(null);
  const uid = useId();
  const current = Math.min(index, Math.max(stages.length - 1, 0));

  function select(next, moveFocus = false) {
    if (next < 0 || next >= stages.length) return;
    setVisited(previous => new Set([...previous, next]));
    setIndex(next);
    if (moveFocus) navigation.current?.querySelectorAll('button')[next]?.focus();
  }

  function handleNavigationKey(event, itemIndex) {
    const offsets = { ArrowRight: 1, ArrowLeft: -1 };
    let next;
    if (event.key in offsets) next = Math.max(0, Math.min(stages.length - 1, itemIndex + offsets[event.key]));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = stages.length - 1;
    else return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <div className="va" data-theme={theme}>
      <div className="va-frame">
        <header className="va-header">
          <div><h1>{title}</h1>{subtitle && <p className="va-muted">{subtitle}</p>}</div>
          <button type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </header>
        {stages.length === 0 ? <p role="status">No stages are available.</p> : <>
          <nav className="va-stages" ref={navigation} aria-label="Explanation stages">
            {stages.map((stage, itemIndex) => <button key={stage.id} type="button"
              aria-current={itemIndex === current ? 'step' : undefined}
              aria-controls={`${uid}-panel-${stage.id}`}
              onKeyDown={event => handleNavigationKey(event, itemIndex)}
              onClick={() => select(itemIndex)}>
              {itemIndex + 1}. {stage.label}
            </button>)}
          </nav>
          {stages.map((stage, itemIndex) => <section key={stage.id}
            className={`va-panel${itemIndex === current ? ' va-stage-enter' : ''}`}
            id={`${uid}-panel-${stage.id}`} hidden={itemIndex !== current}
            aria-labelledby={`${uid}-title-${stage.id}`}>
            <h2 id={`${uid}-title-${stage.id}`}>{stage.title || stage.label}</h2>
            {stage.description && <p className="va-muted">{stage.description}</p>}
            {visited.has(itemIndex) && stage.render?.({ active: itemIndex === current, theme })}
          </section>)}
          <footer className="va-footer">
            <p className="va-count" role="status" aria-live="polite" aria-atomic="true">
              Stage {current + 1} of {stages.length}: {stages[current].label}
            </p>
            <div className="va-footer-actions">
              <button type="button" disabled={current === 0} onClick={() => select(current - 1)}>Previous</button>
              <button type="button" disabled={current === stages.length - 1} onClick={() => select(current + 1)}>Next</button>
            </div>
          </footer>
        </>}
      </div>
    </div>
  );
}
