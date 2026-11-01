# Inference Engineering Lab

**25 LLM inference interview questions, each with a guided animated lesson, an interactive simulator, a formula card, a runnable lab and a timed interview drill.**

🔗 **Live site:** https://rishabh135.github.io/visualizing_llm_questions/ (goes live once GitHub Pages is enabled — see Delivery below)

```bash
npm install && npm run dev
```

---

## TL;DR

- **What:** a React + TypeScript web app. Pick a question, walk 8 short stages, play with a simulator, practise the answer.
- **How it stays honest:** every number comes from a pure, tested function. Each value carries an evidence label (calculated / simulated / vendor spec / assumed / not measured). No benchmark result is invented.
- **What's not done:** no GPU was available, so GPU benchmarks are protocols with "not measured" results. No video file was rendered; lessons are in-browser animations.

---

## ✅ Delivery checklist

Legend: ✅ done and verified · ⚠️ done, partly verified · ❌ not done (reason given)

### Product
- ✅ All 25 questions, grouped into the 5 original topic groups
- ✅ 8 named stages per question, one panel at a time, Previous / Next, "Stage X of Y", deep links (`#/q/3/simulator`)
- ✅ TL;DR line at the top of every stage; 3-bullet TL;DR per question
- ✅ Searchable curriculum sidebar with filter + highlight
- ✅ Global search palette (<kbd>⌘K</kbd> or <kbd>/</kbd>) across questions, stages, formulas, glossary, tools
- ✅ Glossary (A–Z, searchable, linked back to questions)
- ✅ Formula reference (all 25 KaTeX cards, searchable)
- ✅ Scenario lab (every simulator in one place)
- ✅ Interview practice: Explain / Whiteboard / Debug / Defend modes, timer, hints, collapsed model answers, 6-point rubric, flashcards
- ✅ Progress saved locally, with in-memory fallback when storage is blocked
- ✅ Dark theme (default) + light theme
- ✅ Optional, clearly labelled conceptual embedding map (home page)

### Lesson template (A–L) — applied to every question
- ✅ A. Exact question, why it matters, 3-bullet TL;DR → *Overview*
- ✅ B. Plain explanation + analogy map + where it breaks → *Overview*
- ✅ C. Smallest example, stepper, predict-then-reveal → *Small example*
- ✅ D. 5-scene guided lesson (60–120 s) with Play/Pause, Restart, Prev/Next, speed, scrubber, chapters, captions, transcript → *Guided lesson*
- ✅ D. Simulator with Normal / Stress / Failure presets, Reset, exact-value table, "omits" list → *Simulator*
- ✅ E. Formula card: equation, variables, units, assumptions, substituted numbers, dimensional check, memory cue → *Formula & estimates*
- ✅ F. Estimates table with evidence labels → *Formula & estimates*
- ✅ G. Naive vs improved vs mechanism + comparison table → *Build & measure*
- ✅ H. Runnable lab: code, commands, dependencies, correctness checks, production gap → *Build & measure*
- ✅ I. Benchmark protocol; results marked "not measured" → *Build & measure*
- ✅ J. ≥ 3 pitfalls, ≥ 3 optimizations with trade-offs, when it stops working → *Trade-offs*
- ✅ K. 60–90 s answer, whiteboard steps, ≥ 3 follow-ups, debug + calculation challenge → *Interview*
- ✅ L. "What would change my decision?" + recall check, answers collapsed → *Interview*

### Interaction and accessibility
- ✅ Sliders and numeric inputs drive the same value; charts, stats and tables share one calculation
- ✅ Colour always paired with a glyph (▶ request, ◆ prefill, ● decode, ■ KV, ↔ comms, ✕ error)
- ✅ Keyboard: skip link, visible focus, stage focus management, palette arrow keys, Escape closes dialogs
- ✅ Mobile drawer with focus trap, Escape, focus restore, scroll lock; 44 px touch targets
- ✅ `prefers-reduced-motion` honoured; lesson pauses when the tab is hidden; no autoplay, no audio
- ⚠️ Layout checked by headless-Chrome screenshots at 390 / 768 / 1280 / 1440 px with zero horizontal overflow; manual screen-reader and 200 % zoom passes not done

### Evidence and numbers
- ✅ Binary GiB for memory maths; vendor GB kept decimal and converted explicitly
- ✅ KV anchor: 320 KiB/token → 10 GiB/request → 1,000 GiB for 100 × 32K (BF16); 500 / 250 GiB for FP8 / 4-bit (unit-tested)
- ✅ Speculative decoding boundary cases (a = 0 → 1 token, a = 1 → k + 1) unit-tested
- ⚠️ Hardware specs labelled "vendor spec" with source names; prices are editable assumptions, never quotes
- ❌ GPU measurements — no GPU in the build environment; every GPU result says "not measured"

### Labs (`public/labs/`, downloadable from the app)
- ✅ `sse_server.py` + `sse_client.html` — cancellation-safe SSE streaming with a mock engine (stdlib only)
- ✅ `test_sse_server.py` — 10 cancellation / cleanup tests, passing
- ✅ `benchmark.py` — open-loop streaming benchmark; `--dry-run` runs against a built-in mock
- ⚠️ `rmsnorm.py` — real Triton RMSNorm kernel + checks + CUDA-event benchmark; CPU reference check passes, GPU path not run here
- ✅ `PROTOCOL.md` — rollout, autoscaling, disaggregation and engine-comparison checklists

### Delivery
- ✅ Source pushed to https://github.com/rishabh135/visualizing_llm_questions
- ✅ GitHub Actions build job passes on GitHub: install → typecheck → 143 tests → build → Python lab tests
- ⚠️ Deploy job waits on one manual step: **Settings → Pages → Source: GitHub Actions**, then re-run the workflow
- ✅ `build-visual-artifacts` Claude Code skill bundled in `.claude/skills/`
- ❌ MP4/WebM video export — no render pipeline here; scene data is export-ready, no video file exists
- ⚠️ `package-lock.json` not committed (the local one points at a private npm mirror); all direct dependencies are pinned to exact versions
- ❌ Original reference site content — it requires a ChatGPT sign-in (HTTP 401), so this app was rebuilt from the full specification

---

## 25-question coverage

Every row has all 8 stages, 5 scenes (90 s), ≥ 3 pitfalls, ≥ 3 optimizations, ≥ 3 follow-ups — enforced by `src/render.test.tsx`.

| Q | Group | Topic | Simulator | Lab | Lesson |
| --- | --- | --- | --- | --- | --- |
| 1 | Foundations | Request to first token | Every span comes from ttftSpans() | Span model with asserts (cpu) | 90 s |
| 2 | Foundations | SSE streaming + cancel | simulateCancel() places every event on one timeline | Cancellation-safe SSE server + browser client (cpu) | 90 s |
| 3 | Foundations | KV cache memory | Every number below comes from one function, kvPlan() | KV calculator with asserts (cpu) | 90 s |
| 4 | Foundations | PagedAttention | runOps() replays the toy script on a real allocator | Paged allocator with copy-on-write (browser) | 90 s |
| 5 | Foundations | FlashAttention | onlineAttention() and attentionRef() run on the toy row | Online softmax equals materialized softmax (cpu) | 90 s |
| 6 | Scheduling & latency | Continuous batching | Four policies run on the identical seeded trace | Toy iteration scheduler with invariants (cpu) | 90 s |
| 7 | Scheduling & latency | Chunked prefill | Same seeded trace with one to three long prompts | Chunked vs unchunked toy timeline (cpu) | 90 s |
| 8 | Scheduling & latency | Prefix-aware routing | Three routing policies on the same seeded trace of shared-prefix requests | Chained block hashing with namespace (cpu) | 90 s |
| 9 | Scheduling & latency | Inter-token latency | A roofline step-time model draws the throughput/latency frontier | Frontier calculator (cpu) | 90 s |
| 10 | Scheduling & latency | Speculative decoding | Change acceptance, draft length, draft cost and batch load | Speculation calculator + Monte Carlo check (cpu) | 90 s |
| 11 | Models & GPU performance | Quantization formats | All five formats quantize the same toy vector with one function, quantize() | Fake-quantize a tensor and compare error (cpu) | 90 s |
| 12 | Models & GPU performance | Choosing GPUs | One deploy() function sizes each GPU group, bounds decode step time from bytes and FLOPs, and turns it into tok/s and $ per M tokens | Roofline and cost calculator (cpu) | 90 s |
| 13 | Models & GPU performance | Profiling bottlenecks | classify() turns FLOPs, bytes, launches and measured time into a named bound | Profile a decode step (gpu) | 90 s |
| 14 | Models & GPU performance | Low GPU utilization | pipeline() pushes the offered load through six capacity-limited stages | Pipeline triage checklist (protocol) | 90 s |
| 15 | Models & GPU performance | Fused RMSNorm kernel | normTraffic() counts HBM bytes and launches for the eager expression, an already-fused baseline and your fused kernel | Triton RMSNorm with correctness checks and CUDA-event benchmark (gpu) | 90 s |
| 16 | Production engineering | Observability dashboard | One seeded telemetry run feeds every chart | Histogram buckets and percentile estimates (cpu) | 90 s |
| 17 | Production engineering | p99 = 10× p50 | A seeded open-loop queue across 8 replicas | Stratify a latency log by cause (cpu) | 90 s |
| 18 | Production engineering | Engine benchmark | Build the experiment matrix and see its cost | Open-loop SSE benchmark harness (cpu) | 90 s |
| 19 | Production engineering | Safe model rollout | Inject a hidden quality drop or error spike and watch which gate catches it, how many live requests saw it, and whether each stage had enough samples | Release gate with power check (protocol) | 90 s |
| 20 | Production engineering | GPU autoscaling | Same seeded traffic spike under three policies | Reactive vs warm pool in 30 lines (cpu) | 90 s |
| 21 | Systems design | Fair multi-tenancy | Same seeded arrival trace through FCFS, request round robin and token DRR | Token DRR in 25 lines (cpu) | 90 s |
| 22 | Systems design | Disaggregated P/D | One request’s end-to-end time, monolithic vs disaggregated, from the same disagg() function | Production protocol for a disaggregation trial (protocol) | 90 s |
| 23 | Systems design | MoE parallelism | A seeded top-2 router on 8 tokens feeds the same imbalance into a first-order comparison of TP, PP, EP and hybrid on an illustrative 47B MoE | Top-2 router with capacity, in NumPy (cpu) | 90 s |
| 24 | Systems design | Cut cost 70 % | Hypothetical savings, applied largest first | Multiplicative savings checker (cpu) | 90 s |
| 25 | Systems design | 1M DAU capacity | Every stat, bound, scenario and tornado bar comes from capacity() | Capacity calculator with asserts (cpu) | 90 s |

---

## Run it

| Task | Command |
| --- | --- |
| Install (Node 20.19+; tested on Node 24/26) | `npm install` (direct deps pinned to exact versions; no lockfile committed) |
| Dev server | `npm run dev` |
| Type check | `npm run typecheck` |
| Unit + render tests | `npm test` |
| Production build → `dist/` | `npm run build` |
| Everything | `npm run verify` |
| Python lab tests | `python3 -m unittest discover -s public/labs -p 'test_*.py'` |

`dist/` is a static site with relative paths and hash routing, so it works on any static host.

---

## What's inside

| Path | What |
| --- | --- |
| `src/content/g1–g5.ts` | All 25 lessons as typed data (`src/types.ts`): text, scenes, formulas, estimates, labs, interview material |
| `src/engines/` | Pure, seeded calculation and simulation functions + their tests |
| `src/sims/g1–g5.tsx` | One interactive simulator per question (Recharts + SVG/HTML diagrams) |
| `src/components/ScenePlayer.tsx` | Deterministic guided-lesson player (scrubbing rebuilds state from time) |
| `src/components/ui.tsx` | Shared controls: sliders, presets, stats, charts, tables, evidence badges |
| `src/pages/` | Lesson stages, home, glossary, formulas, scenario lab, practice, labs |
| `src/render.test.tsx` | Template-coverage checks + server render of all 25 × 8 stages |
| `public/labs/` | Runnable Python labs and protocols |
| `.claude/skills/build-visual-artifacts/` | Design-system skill used to build this app |

### Stages in every question

| # | Stage | Contains |
| --- | --- | --- |
| 1 | Overview | Why it matters, 3-bullet TL;DR, plain words, analogy map + limits |
| 2 | Small example | Step-through with exact intermediate states, predict-then-reveal |
| 3 | Guided lesson | 5 scenes, 60–120 s, captions, chapters, transcript |
| 4 | Simulator | Controls, presets, stats, charts, exact-value table, omissions |
| 5 | Formula & estimates | KaTeX formula card + evidence-labelled estimates |
| 6 | Build & measure | Naive vs improved, runnable lab, benchmark protocol |
| 7 | Trade-offs | Pitfalls, optimizations, when it stops working |
| 8 | Interview | Spoken answer, whiteboard, follow-ups, challenges, recall |

---

## Libraries and licences

| Package | Version | Licence | Used for | Loading |
| --- | --- | --- | --- | --- |
| react / react-dom | 19.3.1 | MIT | UI | bundled |
| recharts | 3.10.1 | MIT | All charts | bundled |
| lucide-react | 1.66.0 | ISC | Icons | bundled, tree-shaken |
| katex | 0.19.1 | MIT | Formula rendering | bundled |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 | Interface font | bundled, `font-display: swap` |
| @fontsource/geist-mono | 5.3.0 | OFL-1.1 | Code and numbers | bundled |
| vite / @vitejs/plugin-react | 8.3.5 / 6.1.2 | MIT | Build (dev only) | — |
| vitest | 5.0.5 | MIT | Tests (dev only) | — |
| typescript | 5.9.3 | Apache-2.0 | Types (dev only) | — |

**Deliberately not used:** shadcn/ui, Radix, Motion, React Flow, Dagre, Nivo, Mermaid, Embla, Remotion, three.js and the other optional engines. Every diagram here is a small queue, block, timeline or chart, which semantic HTML + SVG + Recharts explain more exactly. CSS owns all transitions, so no two animation engines compete. Skipping them keeps the bundle small and the build reproducible.

---

## Verification actually run

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | ✅ 0 errors |
| Unit + render tests | `npm test` | ✅ 143 passed in 6 files: engine maths and invariants for all 25 questions, template coverage per question, server render of all 25 × 8 = 200 stages |
| Production build | `npx vite build` | ✅ built; one JS bundle of 1.51 MB (462 KB gzip) |
| Python lab tests | `python3 -m unittest discover -s public/labs -p 'test_*.py'` | ✅ 10 passed (SSE cancellation and cleanup, mock engine) |
| RMSNorm CPU reference | `python3 public/labs/rmsnorm.py --cpu-check` | ✅ `[0.3651, 0.7303, 1.0954, 1.4606]` |
| RMSNorm GPU check + benchmark | `python3 public/labs/rmsnorm.py --check --bench` | ❌ not measured: no CUDA / Triton here |
| Benchmark harness | `python3 public/labs/benchmark.py --dry-run --rate 5 --duration 3` | ✅ 16/16 requests against the built-in mock (mock numbers, not a GPU result) |
| Browser sweep, 1440 / 768 / 390 px | headless Chrome (puppeteer-core): every lesson × stage, every simulator preset, every slider at min and max | ✅ 0 console errors or warnings; 0 px horizontal overflow at all three widths; no stray NaN or undefined values (Q5's "NaN (overflow)" is the intended failure demo) |
| Search, drawer, theme | headless Chrome | ✅ ⌘K palette opens, focuses input, returns results; mobile drawer traps focus; light theme renders |
| Screen reader, 200 % zoom, touch device | — | ❌ not run (no assistive tech or device here) |

Hardware specs (H100 SXM, H200 SXM, L40S, NVFP4 format) were checked against nvidia.com pages on 2026-10-31. B200 per-GPU numbers come from DGX B200 system totals ÷ 8 and are labelled unverified in the app.

---

## Use the design skill

```bash
mkdir -p ~/.claude/skills
cp -R .claude/skills/build-visual-artifacts ~/.claude/skills/
```

Then invoke `/build-visual-artifacts` in Claude Code. Installing it locally does not upload it to Claude.ai.

---

## Limits

- Simulators are teaching models: seeded, deterministic, and simplified. Each one lists what it omits.
- Guided lessons are schematic browser animations, not GPU traces or videos.
- The optional embedding map on the home page is a synthetic 2-D projection, clearly labelled; it is never used to explain allocation, kernels or scheduling.
- A GPU lower bound is not a procurement plan. Measure on your hardware before deciding.
