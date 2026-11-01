// Content model shared by every lesson. Rendering code reads only these types.

/** Mechanism colour roles. Every role also has a text glyph so colour is never the only cue. */
export type Kind = 'request' | 'prefill' | 'decode' | 'kv' | 'comm' | 'error' | 'ok' | 'neutral';

/** Evidence label shown beside every number. */
export type Evidence = 'calculated' | 'simulated' | 'measured' | 'vendor spec' | 'assumed' | 'not measured';

export type GroupId = 'foundations' | 'scheduling' | 'gpu' | 'production' | 'systems';

/** One box in a guided-lesson scene. `at`/`out` are fractions (0..1) of the scene's duration. */
export interface SceneItem {
  label: string;
  kind: Kind;
  /** Appears when scene progress >= at (default 0). */
  at?: number;
  /** Fades and is struck through when scene progress >= out (freed, rejected, cancelled). */
  out?: number;
  /** Short exact-value note shown under the label. */
  note?: string;
}

export interface SceneLane {
  label: string;
  items: SceneItem[];
}

/** Export-ready scene record: everything a video renderer would need. */
export interface Scene {
  id: string;
  title: string;
  objective: string;
  /** Seconds. 5 scenes x 12-24 s gives a 60-120 s lesson. */
  duration: number;
  /** Narration; split into sentences for timed captions. */
  narration: string;
  lanes: SceneLane[];
  /** Highlighted equation (plain text, not TeX). */
  equation?: string;
  /** What changes between the start and end of this scene. */
  transition: string;
  /** What the learner should try. */
  action: string;
}

export interface EstimateRow {
  quantity: string;
  value: string;
  unit: string;
  assumptions: string;
  source: string;
  evidence: Evidence;
}

export interface Lesson {
  id: number;
  group: GroupId;
  /** <= 4 words, shown in sidebar. */
  short: string;
  /** The exact interview question. */
  question: string;
  /** One sentence: why an interviewer asks this. */
  why: string;
  tldr: [string, string, string];
  /** Two to three sentences, plain language. */
  plain: string;
  analogy: {
    name: string;
    /** [everyday object, system component] */
    map: [string, string][];
    breaks: string;
  };
  example: {
    title: string;
    inputs: string;
    steps: { label: string; state: string }[];
    output: string;
    predict: { q: string; a: string };
  };
  scenes: Scene[];
  sim: {
    /** One line shown above the simulator. */
    tldr: string;
    omits: string[];
  };
  formula: {
    name: string;
    /** KaTeX source. */
    tex: string;
    /** [symbol, meaning, unit] */
    vars: [string, string, string][];
    assumptions: string[];
    substituted: string;
    check: string;
    cue: string;
    /** true when this is a decision rule or model rather than an exact formula. */
    isModel?: boolean;
  };
  estimates: EstimateRow[];
  compare: {
    naive: string;
    improved: string;
    mechanism: string;
    /** [metric, naive, improved] */
    rows: [string, string, string][];
  };
  lab: {
    title: string;
    kind: 'browser' | 'cpu' | 'gpu' | 'protocol';
    /** Path under public/ when a runnable file ships with the app. */
    file?: string;
    deps: string;
    commands: string[];
    lang: string;
    code: string;
    checks: string[];
    gaps: string;
  };
  bench: {
    hypothesis: string;
    baseline: string;
    controlled: string[];
    workload: string;
    warmup: string;
    reps: string;
    method: string;
    metrics: string[];
    interpret: string;
  };
  pitfalls: string[];
  /** [optimization, trade-off] */
  optimizations: [string, string][];
  /** Conditions where the technique stops working or hurts. */
  breaks: string[];
  interview: {
    /** 60-90 second spoken answer (~150-220 words). */
    short: string;
    whiteboard: string[];
    followups: [string, string][];
    debug: [string, string];
    calc: [string, string];
  };
  changeMind: string[];
  recall: [string, string][];
  glossary: [string, string][];
  tags: string[];
}
