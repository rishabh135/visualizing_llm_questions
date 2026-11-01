// Scheduling & latency (Q6-Q10).
import type { Lesson } from '../types';

const q6: Lesson = {
  id: 6,
  group: 'scheduling',
  short: 'Continuous batching',
  question: 'Design a continuous batching scheduler. How would you balance throughput against per-request latency?',
  why: 'The scheduler decides who runs every iteration, so it sets TTFT, token gaps, throughput and fairness at once.',
  tldr: [
    'Schedule per iteration, not per batch: finished requests leave and new ones join every step.',
    'A token budget and sequence cap bound each step; KV capacity bounds admission.',
    'Decode-first protects token gaps; aging and deadlines stop prefills or decodes from starving.',
  ],
  plain:
    'Static batching waits for the slowest request before starting new ones. Continuous batching rebuilds the batch every forward pass, so free slots are refilled immediately. The policy that orders prefill and decode work is where throughput and latency are traded.',
  analogy: {
    name: 'Restaurant kitchen',
    map: [
      ['Each cooking round on the stove', 'One model iteration (forward pass)'],
      ['Burner count', 'Token budget and max running sequences'],
      ['Fridge space for open orders', 'KV cache blocks reserved per request'],
      ['Starting a new order vs plating a dish', 'Prefill a new prompt vs decode one more token'],
      ['Host turning guests away', 'Admission control with a bounded queue'],
    ],
    breaks:
      'A chef finishes dishes independently; a GPU iteration runs all requests together, so one big prefill slows every decode in that step. Kitchens also do not pre-reserve fridge space for food they have not cooked yet.',
  },
  example: {
    title: 'Three requests, token budget 6, decode-first',
    inputs: 'R1: prompt 4, output 3 (arrives it0) · R2: prompt 6, output 2 (it1) · R3: prompt 2, output 2 (it2)',
    steps: [
      { label: 'it0', state: 'R1 prefill 4 tokens → R1 token 1\nbudget used 4 / 6' },
      { label: 'it1', state: 'R1 decode 1 → R1 token 2\nR2 prefill 5 of 6 (budget runs out)\nbudget used 6 / 6' },
      { label: 'it2', state: 'R1 decode 1 → R1 token 3, R1 leaves\nR2 prefill last 1 → R2 token 1\nR3 prefill 2 → R3 token 1\nbudget used 5 / 6' },
      { label: 'it3', state: 'R2 decode → token 2, leaves\nR3 decode → token 2, leaves' },
    ],
    output: 'All three finish in 4 iterations. Static batching would hold R2 and R3 until R1 finished (it3) and then start both.',
    predict: {
      q: 'In iteration 2, how many requests emit a token?',
      a: 'Three: R1 (its last), R2 (first token, prefill finished) and R3 (its 2-token prefill fits the leftover budget). Prefill produces token 1 — no extra decode pass.',
    },
  },
  scenes: [
    {
      id: 'q6-s1', title: 'Static batching wastes slots', objective: 'See idle slots when a batch waits for its longest request.', duration: 18,
      narration: 'A static batch starts four requests together. Three finish early, but their slots stay empty until the longest one ends. New arrivals wait outside the whole time.',
      lanes: [
        { label: 'Batch slots', items: [{ label: 'R1 long', kind: 'decode' }, { label: 'R2', kind: 'decode', out: 0.35 }, { label: 'R3', kind: 'decode', out: 0.45 }, { label: 'R4', kind: 'decode', out: 0.55 }] },
        { label: 'Queue', items: [{ label: 'R5', kind: 'request', at: 0.3 }, { label: 'R6', kind: 'request', at: 0.5 }, { label: 'R7', kind: 'request', at: 0.7 }] },
        { label: 'Idle slots', items: [{ label: 'empty', kind: 'error', at: 0.4 }, { label: 'empty', kind: 'error', at: 0.5 }, { label: 'empty', kind: 'error', at: 0.6 }] },
      ],
      transition: 'Slots empty out while the queue grows.', action: 'Count how many slot-iterations are wasted.',
    },
    {
      id: 'q6-s2', title: 'Rebuild the batch every iteration', objective: 'Continuous batching refills a slot as soon as a request leaves.', duration: 18,
      narration: 'Now the scheduler runs once per iteration. When R2 finishes, R5 is admitted in the very next step. The GPU stays full and new requests start sooner.',
      lanes: [
        { label: 'Iteration n', items: [{ label: 'R1 ●', kind: 'decode' }, { label: 'R2 ● last', kind: 'decode', out: 0.3 }, { label: 'R3 ●', kind: 'decode' }] },
        { label: 'Iteration n+1', items: [{ label: 'R1 ●', kind: 'decode', at: 0.35 }, { label: 'R5 ◆ prefill', kind: 'prefill', at: 0.45 }, { label: 'R3 ●', kind: 'decode', at: 0.4 }] },
        { label: 'Queue', items: [{ label: 'R5', kind: 'request', out: 0.45 }, { label: 'R6', kind: 'request', at: 0.6 }] },
      ],
      equation: 'per iteration: Σ prefill tokens + #decodes ≤ token budget',
      transition: 'R2 leaves; R5 moves from queue to the batch.', action: 'Open the Gantt in the simulator and find a row turning from W to P.',
    },
    {
      id: 'q6-s3', title: 'Budget, sequences, KV blocks', objective: 'Name the three limits that bound each step.', duration: 18,
      narration: 'Each iteration has a token budget, a cap on running sequences, and the KV blocks left in memory. A request is admitted only if all three allow it. If KV is full, it waits or is rejected.',
      lanes: [
        { label: 'Token budget', items: [{ label: '512 tokens', kind: 'neutral' }, { label: 'decodes 40', kind: 'decode', at: 0.2 }, { label: 'prefill 472', kind: 'prefill', at: 0.35 }] },
        { label: 'Sequences', items: [{ label: '62 / 64', kind: 'neutral', at: 0.5 }] },
        { label: 'KV blocks', items: [{ label: '3,920 / 4,000 used', kind: 'kv', at: 0.65 }, { label: 'R9 needs 120', kind: 'error', at: 0.85 }] },
      ],
      equation: 'admit if seqs < cap AND blocks_needed ≤ free_blocks',
      transition: 'Budget fills; KV check rejects R9.', action: 'Pick the failure preset and watch rejections rise.',
    },
    {
      id: 'q6-s4', title: 'Who goes first?', objective: 'Compare decode-first, prefill-first and FCFS ordering.', duration: 18,
      narration: 'Decode-first gives every running request one token before any prefill, which keeps token gaps steady. Prefill-first starts new requests sooner but stretches gaps for everyone already streaming. FCFS mostly behaves like decode-first, because running requests are older.',
      lanes: [
        { label: 'Decode-first', items: [{ label: '● ● ● ●', kind: 'decode', at: 0.1 }, { label: '◆ leftover', kind: 'prefill', at: 0.25 }] },
        { label: 'Prefill-first', items: [{ label: '◆◆◆ big chunk', kind: 'prefill', at: 0.45 }, { label: '● starved', kind: 'error', at: 0.6 }] },
        { label: 'Effect', items: [{ label: 'lower TTFT', kind: 'ok', at: 0.75 }, { label: 'longer gaps', kind: 'error', at: 0.85 }] },
      ],
      transition: 'Same work, different order, different tails.', action: 'Compare TTFT p95 and gap p95 bars across policies.',
    },
    {
      id: 'q6-s5', title: 'Aging and deadlines', objective: 'Prevent starvation under sustained load.', duration: 18,
      narration: 'Priorities alone can starve someone forever. Aging promotes requests that have waited too long. A decode deadline puts any stream whose last token is too old at the front. Under true overload, only admission control keeps queues bounded.',
      lanes: [
        { label: 'Priority 0', items: [{ label: 'decode overdue > 60 ms', kind: 'decode', at: 0.15 }] },
        { label: 'Priority 1', items: [{ label: 'waited > 400 ms', kind: 'request', at: 0.35 }] },
        { label: 'Priority 2-3', items: [{ label: 'normal decode', kind: 'decode', at: 0.5 }, { label: 'normal prefill', kind: 'prefill', at: 0.6 }] },
        { label: 'Overload', items: [{ label: 'queue full → 429', kind: 'error', at: 0.85 }] },
      ],
      transition: 'Old work climbs the priority ladder; overflow is rejected.', action: 'Lower the queue limit and see rejections replace unbounded TTFT.',
    },
  ],
  sim: {
    tldr: 'Four policies run on the identical seeded trace; change load or limits and compare TTFT, token gaps, throughput and rejections.',
    omits: [
      'Real GPU kernels: iteration time = 15 ms + 0.3 ms per decode + 0.05 ms per prefill token (assumed).',
      'Attention cost growing with context length.',
      'Preemption/swap of running requests; KV is reserved for full growth at admission.',
      'Multiple GPUs, network and tokenization time.',
    ],
  },
  formula: {
    name: 'Iteration budget and Little’s law',
    tex: String.raw`\sum_{p \in \text{prefill}} c_p + |\text{decode}| \le B_{tok}, \qquad \bar{N} = \lambda \cdot \bar{W}`,
    vars: [
      ['c_p', 'prefill tokens for request p this iteration (chunk)', 'tokens'],
      ['|decode|', 'running requests that get one token', 'tokens'],
      ['B_tok', 'token budget per iteration', 'tokens'],
      ['N̄', 'mean requests in the system', 'requests'],
      ['λ', 'stable arrival rate', 'req/s'],
      ['W̄', 'mean time in system', 's'],
    ],
    assumptions: ['Steady state for Little’s law (average only, not p99)', 'One token per decode per iteration'],
    substituted: 'λ = 20 req/s, W̄ = 3.2 s → N̄ = 64 requests in flight → needs ≥ 64 sequence slots',
    check: 'req/s × s = requests ✓; tokens + tokens ≤ tokens ✓',
    cue: 'Budget the step, cap the sequences, reserve the blocks, age the waiters.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Token budget per iteration', value: '256–8,192', unit: 'tokens', assumptions: 'Engine-dependent knob', source: 'Engine docs (e.g. max batched tokens)', evidence: 'assumed' },
    { quantity: 'Decode step, 70B TP8', value: '10–30', unit: 'ms', assumptions: 'Batch 1–128, short context', source: 'Q9 roofline model', evidence: 'calculated' },
    { quantity: 'Iteration overhead', value: '15', unit: 'ms', assumptions: 'Simulator constant', source: 'This simulator', evidence: 'assumed' },
    { quantity: 'Policy TTFT/gap differences', value: 'see simulator', unit: 'ms', assumptions: 'Seed 7, 70 requests', source: 'This simulator', evidence: 'simulated' },
    { quantity: 'Real engine TTFT/ITL', value: 'not measured', unit: 'ms', assumptions: 'Needs GPU benchmark', source: 'Bench protocol below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Static batching: collect N requests, run until all finish, then take the next N.',
    improved: 'Iteration-level scheduling with token budget, sequence cap, KV-aware admission, decode-first order, aging and bounded queues.',
    mechanism: 'Slots freed by finished requests are refilled on the next step, and the budget bounds how much prefill can delay running streams.',
    rows: [
      ['Throughput', 'Low (idle slots)', 'High (slots refilled per step)'],
      ['TTFT', 'Waits for whole batch', 'Next iteration with free capacity'],
      ['Token gaps', 'Steady', 'Steady if decode-first; spikes if prefill dominates'],
      ['Fairness', 'Batch-level', 'Needs aging + deadlines'],
      ['Complexity', 'Trivial', 'Scheduler, allocator, cancellation paths'],
    ],
  },
  lab: {
    title: 'Toy iteration scheduler with invariants', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 toy_sched.py'], lang: 'python',
    code: `from dataclasses import dataclass

@dataclass
class R: id: int; arrive: int; prompt: int; out: int

def run(reqs, budget=6):
    left = {r.id: r.prompt for r in reqs}; outl = {r.id: r.out for r in reqs}
    t, done, work = 0, set(), 0
    while len(done) < len(reqs):
        b = budget
        live = [r for r in reqs if r.arrive <= t and r.id not in done]
        for r in sorted(live, key=lambda r: (left[r.id] > 0, r.arrive)):  # decode first
            if left[r.id] == 0 and b >= 1: b -= 1; outl[r.id] -= 1; work += 1
            elif left[r.id] > 0:
                take = min(left[r.id], b); left[r.id] -= take; b -= take; work += take
                if left[r.id] == 0 and take: outl[r.id] -= 1     # prefill emits token 1
            if outl[r.id] == 0: done.add(r.id)
        assert b >= 0
        t += 1
    return t, work

reqs = [R(1, 0, 4, 3), R(2, 1, 6, 2), R(3, 2, 2, 2)]
iters, work = run(reqs)
assert work == sum(r.prompt + r.out - 1 for r in reqs)   # work conservation
print("iterations:", iters)                              # 4`,
    checks: ['Work conservation: processed = Σ(prompt + output − 1)', 'Budget never negative', 'Example finishes in 4 iterations'],
    gaps: 'No KV accounting, cancellation, aging or timing; see engines/g2.ts simulate() for the full teaching version.',
  },
  bench: {
    hypothesis: 'Decode-first lowers token-gap p95 versus prefill-first at equal throughput within 5 %.',
    baseline: 'Engine default scheduling policy.',
    controlled: ['Model + weights', 'GPU type and count', 'Token budget', 'Max sequences', 'KV dtype and blocks', 'Engine version'],
    workload: 'Open-loop Poisson arrivals at 50 %, 80 %, 95 % of measured max throughput; prompt/output lengths sampled from production.',
    warmup: '2 minutes discarded.', reps: '5 runs × 10 minutes per setting.',
    method: 'Client-side timestamps per SSE token; server logs for queue and iteration spans.',
    metrics: ['TTFT p50/p95/p99', 'token gap p50/p95/p99', 'output tok/s', 'rejected %', 'per-tenant slowdown'],
    interpret: 'Report medians with 95 % bootstrap intervals; a policy wins only if its interval does not overlap and throughput stays within tolerance.',
  },
  pitfalls: [
    'Admitting without KV headroom, then preempting or OOMing mid-generation.',
    'Unbounded queues: under overload TTFT grows without limit instead of failing fast.',
    'Treating an average from Little’s law as a p99 guarantee.',
    'Forgetting cancelled requests: their KV and batch slots must be released at the next safe boundary.',
  ],
  optimizations: [
    ['Decode-first with leftover-budget prefill', 'Steady token gaps; new requests may wait longer for their first token.'],
    ['Aging + decode deadlines', 'Prevents starvation; adds tuning knobs that interact with load.'],
    ['Dynamic token budget by SLO', 'Keeps gaps under target; costs throughput when the budget shrinks.'],
  ],
  breaks: [
    'Sustained arrival rate above service rate: no ordering fixes it; only admission control or more capacity.',
    'Highly variable prompt lengths without chunking: one huge prefill still blocks a whole iteration (see Q7).',
  ],
  interview: {
    short:
      'I schedule at the iteration level. Every forward pass the scheduler rebuilds the batch: finished or cancelled requests leave and release their KV blocks, and waiting requests join if three limits allow it — a token budget for the step, a cap on running sequences, and enough free KV blocks. Within the budget I run decodes first, one token per running request, then fill the remaining budget with prefill chunks, because decode gaps are what users feel while streaming. To stop starvation I add aging, so long-waiting prefills get promoted, and a decode deadline, so any stream whose last token is too old moves to the front. The queue is bounded: under overload I reject with a retry hint instead of letting TTFT grow without limit. The trade-off knob is the token budget: larger budgets raise throughput and lower TTFT but stretch every token gap in that step. I would compare policies on an identical seeded arrival trace and report TTFT and gap percentiles, throughput, rejections and a fairness index.',
    whiteboard: [
      'Draw iterations as columns, requests as rows (Gantt).',
      'Write the per-step constraint: Σ prefill chunks + #decodes ≤ budget.',
      'Admission check: seqs < cap and blocks needed ≤ free blocks.',
      'Ordering: overdue decodes > aged waiters > decodes > prefills.',
      'Overload path: bounded queue → reject with Retry-After.',
    ],
    followups: [
      ['Why not maximize batch size always?', 'Larger batches raise throughput but each step gets slower, so per-user token gaps grow; the SLO caps the useful batch.'],
      ['How do you handle KV exhaustion mid-decode?', 'Reserve conservatively at admission, or preempt (swap or recompute) the newest request; never let free blocks go negative.'],
      ['How do you test the scheduler?', 'Seeded traces plus invariants: work conservation, no negative free blocks, cancelled requests stop, finite load completes.'],
    ],
    debug: [
      'Throughput doubled after raising the token budget from 512 to 8,192, but users complain streams stutter. Why?',
      'Big prefills now share iterations with decodes, so some steps take hundreds of ms; token-gap p95 rose. Lower the budget or chunk prefills and keep decode-first.',
    ],
    calc: [
      'Arrivals 20 req/s, mean time in system 3.2 s. How many sequence slots do you need on average?',
      'Little’s law: 20 × 3.2 = 64 requests in flight on average; plan more for bursts.',
    ],
  },
  changeMind: [
    'Measured token-gap SLO violations under decode-first (then cap budget dynamically).',
    'A workload of mostly very short outputs, where TTFT dominates (then favor prefill).',
    'Engine support for cheap preemption, which changes the admission policy.',
  ],
  recall: [
    ['Three per-iteration limits?', 'Token budget, max sequences, free KV blocks.'],
    ['Why decode-first?', 'It keeps token gaps steady for requests already streaming.'],
    ['What stops starvation?', 'Aging for waiters and deadlines for decodes.'],
  ],
  glossary: [
    ['Continuous batching', 'Rebuilding the batch every iteration so finished requests leave and new ones join immediately.'],
    ['TTFT', 'Time to first token: from request arrival to the first generated token.'],
    ['ITL', 'Inter-token latency: time between consecutive generated tokens of one request.'],
    ['FCFS', 'First come, first served ordering.'],
    ['Aging', 'Raising a request’s priority the longer it waits.'],
  ],
  tags: ['scheduling', 'batching', 'latency', 'throughput', 'fairness'],
};

const q7: Lesson = {
  id: 7,
  group: 'scheduling',
  short: 'Chunked prefill',
  question: 'A 100K-token prompt is making short requests wait forever. How would you use chunked prefill and scheduling to fix TTFT?',
  why: 'Long-context traffic is common, and one unbounded prefill can stall every request on the GPU.',
  tldr: [
    'Split long prefills into bounded chunks so each iteration stays short.',
    'Short prompts and decodes slot in between chunks: their TTFT drops by seconds.',
    'The long prompt itself gets slower; aging prevents it from starving.',
  ],
  plain:
    'Without chunking, a 100K-token prompt runs as one giant iteration lasting seconds, and everyone else waits. Chunked prefill processes, say, 512 tokens of it per iteration and shares the rest of the token budget with other work. Short requests get their first token quickly while the long prompt finishes a bit later.',
  analogy: {
    name: 'Checkout queue',
    map: [
      ['A shopper with a full trolley', 'The 100K-token prompt'],
      ['Shoppers with one item', 'Short requests'],
      ['Cashier scans 10 items, then serves the next person', 'Chunk the prefill, interleave others'],
      ['Scanning speed', 'Prefill tokens per second'],
    ],
    breaks:
      'A cashier switches customers at no cost; each extra GPU iteration adds launch and scheduling overhead, smaller chunks use the GPU less efficiently, and attention over a long prefix keeps getting more expensive per chunk.',
  },
  example: {
    title: 'Long prompt L (20 tokens) and short S (2 tokens)',
    inputs: 'Iteration cost = 1 ms + 1 ms per token. L arrives at t = 0, S at t = 1. Chunk = 4.',
    steps: [
      { label: 'No chunking', state: 'it0: L 20 tokens → 21 ms (ends t=21)\nit1: S 2 tokens → 3 ms (ends t=24)\nS TTFT = 24 − 1 = 23 ms, L TTFT = 21 ms' },
      { label: 'Chunk 4: it0', state: 'L 4 → 5 ms (t=5)' },
      { label: 'it1', state: 'L 4 + S 2 → 7 ms (t=12)\nS TTFT = 12 − 1 = 11 ms' },
      { label: 'it2–it4', state: 'it2: L 4 + S decode 1 → t=18\nit3: L 4 → t=23\nit4: L 4 → t=28 → L TTFT = 28 ms' },
    ],
    output: 'S TTFT 23 → 11 ms. L TTFT 21 → 28 ms (more iterations, shared budget).',
    predict: {
      q: 'Does chunking make the long prompt’s own TTFT better or worse?',
      a: 'Worse: 21 → 28 ms here. It pays per-iteration overhead and shares each step with others. The win is for everyone else.',
    },
  },
  scenes: [
    {
      id: 'q7-s1', title: 'One prefill blocks everyone', objective: 'See a single unchunked prefill occupy seconds of GPU time.', duration: 18,
      narration: 'A 100,000-token prompt arrives first. Without chunking its whole prefill runs as one iteration of about five seconds. Short requests that arrive meanwhile can only wait.',
      lanes: [
        { label: 'Iteration 0', items: [{ label: 'L ◆ 100K tokens ≈ 5 s', kind: 'prefill' }] },
        { label: 'Waiting', items: [{ label: 'S1', kind: 'request', at: 0.2 }, { label: 'S2', kind: 'request', at: 0.4 }, { label: 'S3', kind: 'request', at: 0.6 }, { label: 'S4', kind: 'request', at: 0.8 }] },
        { label: 'Decodes', items: [{ label: 'stalled', kind: 'error', at: 0.5 }] },
      ],
      equation: 'iteration time ≈ 15 ms + 0.05 ms × 100,000 = 5.0 s',
      transition: 'Queue grows behind a single giant iteration.', action: 'Set chunk to "No chunking" and read the longest-iteration stat.',
    },
    {
      id: 'q7-s2', title: 'Cut it into chunks', objective: 'Bound every iteration with a chunk size.', duration: 18,
      narration: 'Now the long prompt is processed 512 tokens per iteration. Each step is short again. The remaining token budget goes to decodes and short prompts.',
      lanes: [
        { label: 'Iteration 0', items: [{ label: 'L ◆ 512', kind: 'prefill', at: 0.1 }, { label: 'S1 ◆ 300', kind: 'prefill', at: 0.25 }] },
        { label: 'Iteration 1', items: [{ label: 'L ◆ 512', kind: 'prefill', at: 0.4 }, { label: 'S1 ●', kind: 'decode', at: 0.5 }, { label: 'S2 ◆', kind: 'prefill', at: 0.55 }] },
        { label: 'Iteration 2', items: [{ label: 'L ◆ 512', kind: 'prefill', at: 0.7 }, { label: 'S1 ● S2 ●', kind: 'decode', at: 0.8 }] },
      ],
      equation: 'per step: chunk + others ≤ budget (e.g. 512 + 1,536 ≤ 2,048)',
      transition: 'Giant block splits into a train of small blocks.', action: 'Drag chunk size from 4096 to 256 and watch short TTFT p95.',
    },
    {
      id: 'q7-s3', title: 'Short requests win', objective: 'Quantify the TTFT improvement for short requests.', duration: 18,
      narration: 'In the simulator, short-request TTFT p95 drops from about five seconds to under half a second. Their first token comes from the iteration right after they arrive, not after the giant prefill.',
      lanes: [
        { label: 'No chunking', items: [{ label: 'short p95 ≈ 5 s', kind: 'error', at: 0.2 }] },
        { label: 'Chunk 512', items: [{ label: 'short p95 ≈ 0.5 s', kind: 'ok', at: 0.55 }] },
      ],
      transition: 'TTFT bar shrinks by an order of magnitude.', action: 'Compare the two short-TTFT stat cards.',
    },
    {
      id: 'q7-s4', title: 'The long prompt pays', objective: 'Name the costs: overhead, efficiency, interference.', duration: 18,
      narration: 'Chunking is not free. The long prompt needs about 200 iterations instead of one, each with fixed overhead. Small chunks use the matrix units less efficiently. Its own TTFT roughly doubles.',
      lanes: [
        { label: 'Costs', items: [{ label: '+ iteration overhead', kind: 'error', at: 0.15 }, { label: '+ small-matmul inefficiency', kind: 'error', at: 0.35 }, { label: '+ shares budget', kind: 'error', at: 0.55 }] },
        { label: 'Long TTFT', items: [{ label: '≈ 5 s → ≈ 11 s', kind: 'prefill', at: 0.8 }] },
      ],
      transition: 'Cost tags attach to the long request.', action: 'Find the chunk size where both lines in the trade-off chart are acceptable.',
    },
    {
      id: 'q7-s5', title: 'Adversarial long prompts', objective: 'Keep the system fair when many long prompts arrive.', duration: 18,
      narration: 'If several long prompts arrive, a chunk as big as the whole budget recreates the original problem. Cap prefill tokens per iteration, interleave across requests, and age long jobs so they still finish. There is no literal mid-kernel preemption: switching happens only at iteration boundaries.',
      lanes: [
        { label: 'Arrivals', items: [{ label: 'L1', kind: 'prefill' }, { label: 'L2', kind: 'prefill', at: 0.2 }, { label: 'L3', kind: 'prefill', at: 0.4 }] },
        { label: 'Policy', items: [{ label: 'cap prefill share', kind: 'ok', at: 0.6 }, { label: 'age long jobs', kind: 'ok', at: 0.75 }, { label: 'switch at boundaries only', kind: 'neutral', at: 0.9 }] },
      ],
      transition: 'Three long prompts share a capped prefill lane.', action: 'Pick the failure preset (3 long prompts, chunk = budget).',
    },
  ],
  sim: {
    tldr: 'Same seeded trace with one to three long prompts; compare no chunking against your chunk size and read both short and long TTFT.',
    omits: [
      'Attention cost growing with the already-prefilled prefix (later chunks are slower in reality).',
      'Small-chunk inefficiency is an assumed factor 1 + 128/chunk.',
      'Prefill/decode disaggregation and multi-GPU pipelines.',
      'Preemption inside a kernel (not possible; switching is per iteration).',
    ],
  },
  formula: {
    name: 'Chunked prefill timing model',
    tex: String.raw`T_{iter} = t_0 + t_d \cdot n_{dec} + t_p \cdot \Big(\sum c_i\Big)\Big(1 + \tfrac{128}{C}\Big), \quad n_{iter}^{long} \approx \Big\lceil \tfrac{P}{C} \Big\rceil`,
    vars: [
      ['t_0', 'fixed overhead per iteration', 'ms'],
      ['t_d', 'cost per decode sequence', 'ms'],
      ['t_p', 'cost per prefill token', 'ms/token'],
      ['c_i', 'prefill tokens processed this step', 'tokens'],
      ['C', 'chunk size', 'tokens'],
      ['P', 'long prompt length', 'tokens'],
    ],
    assumptions: ['Linear prefill cost (ignores quadratic attention)', 'Inefficiency factor is a teaching assumption'],
    substituted: 'P = 100,000, C = 512 → ≥ 196 iterations × 15 ms = 2.9 s of pure overhead for the long prompt',
    check: 'ms + ms/seq × seq + ms/token × tokens = ms ✓',
    cue: 'Bound every step; let the short jobs through; age the giant.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Prefill throughput, 70B TP8', value: '≈ 20,000', unit: 'tokens/s', assumptions: '0.05 ms/token in simulator', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'Unchunked 100K prefill', value: '≈ 5', unit: 's', assumptions: 'Linear model', source: 'Simulator', evidence: 'simulated' },
    { quantity: 'Short TTFT p95, chunk 512', value: '≈ 0.5', unit: 's', assumptions: 'Seed 11, 60 ms gaps', source: 'Simulator', evidence: 'simulated' },
    { quantity: 'Typical chunk sizes', value: '256–8,192', unit: 'tokens', assumptions: 'Engine setting', source: 'Engine docs', evidence: 'assumed' },
    { quantity: 'Real GPU chunk overhead', value: 'not measured', unit: 'ms', assumptions: 'Needs profiling', source: 'Bench protocol', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Run each prompt’s whole prefill in one iteration; FCFS order.',
    improved: 'Chunk prefill to C tokens per request per iteration, decode-first, cap total prefill per step, age long jobs.',
    mechanism: 'Iteration time is bounded by the budget, so arrivals are served at the next boundary instead of after the giant prefill.',
    rows: [
      ['Short TTFT p95', 'Seconds (behind long prefill)', 'Hundreds of ms'],
      ['Long TTFT', 'Best possible', '≈ 2× worse in simulator'],
      ['Token gaps', 'Multi-second stalls', 'Bounded by chunk cost'],
      ['GPU efficiency', 'Large efficient matmuls', 'More launches, smaller matmuls'],
    ],
  },
  lab: {
    title: 'Chunked vs unchunked toy timeline', kind: 'cpu', deps: 'Python 3.10+',
    commands: ['python3 chunk_toy.py'], lang: 'python',
    code: `def ttft(chunk, L=20, S=2, s_arrive=1, base=1.0, per_tok=1.0):
    t, l_left, s_left, s_first, l_first = 0.0, L, S, None, None
    while l_first is None or s_first is None:
        take_l = l_left if chunk is None else min(chunk, l_left)
        take_s = s_left if t >= s_arrive and (chunk or l_left == 0) else 0
        if chunk is None and l_left == 0: take_l = 0
        t += base + per_tok * (take_l + take_s)
        l_left -= take_l; s_left -= take_s
        if l_left == 0 and l_first is None: l_first = t
        if s_left == 0 and take_s and s_first is None: s_first = t - s_arrive
    return s_first, l_first

assert ttft(None) == (23.0, 21.0)
s, l = ttft(4)
assert s == 11.0 and l > 21.0
print("chunk 4:", s, l)`,
    checks: ['Unchunked: S TTFT 23 ms, L TTFT 21 ms', 'Chunk 4: S TTFT 11 ms and L TTFT > 21 ms'],
    gaps: 'Ignores decode tokens of S after the first; the full model is simulate() in engines/g2.ts.',
  },
  bench: {
    hypothesis: 'Enabling chunked prefill (C = 512) cuts short-request TTFT p95 by > 5× when 1 % of requests carry 100K-token prompts.',
    baseline: 'Same engine with chunked prefill disabled.',
    controlled: ['Model', 'GPU', 'token budget', 'arrival trace', 'prompt mix', 'engine version'],
    workload: 'Replay of production-like short prompts plus injected 100K prompts at fixed times.',
    warmup: '1 minute.', reps: '5 runs per chunk size (256, 512, 2048, off).',
    method: 'Client TTFT per request class; engine iteration-time histogram.',
    metrics: ['short TTFT p50/p95', 'long TTFT', 'iteration time p99', 'throughput'],
    interpret: 'Pick the largest chunk that meets the short-TTFT SLO; report the long-prompt penalty explicitly.',
  },
  pitfalls: [
    'Chunk equal to the whole budget: the long prompt still owns every iteration.',
    'Assuming chunking preempts a running kernel; it only switches at iteration boundaries.',
    'Ignoring that later chunks attend to a longer prefix and get slower.',
  ],
  optimizations: [
    ['Smaller chunks', 'Better short TTFT; more overhead and lower matmul efficiency.'],
    ['Cap prefill tokens per iteration', 'Protects decodes; long prompts finish later.'],
    ['Separate prefill pool (Q22)', 'Removes interference; costs KV transfer and operational complexity.'],
  ],
  breaks: [
    'Workloads where almost every prompt is long: chunking just adds overhead.',
    'Strict TTFT SLO for the long prompt itself: chunking makes it worse.',
  ],
  interview: {
    short:
      'The problem is head-of-line blocking at the iteration level. Without chunking, a 100K-token prompt runs as one forward pass that can take several seconds, and no other request can start or even emit a decode token until it finishes. I would enable chunked prefill: process at most C tokens of any prompt per iteration — say 512 — and fill the rest of the token budget with decodes first and short prefills next. Each iteration stays tens of milliseconds, so a short request that arrives mid-way gets its first token one or two iterations later instead of after the giant prefill. The price is that the long prompt needs about 200 iterations, each paying fixed overhead and using smaller, less efficient matmuls, so its own TTFT roughly doubles in my model. To stay fair I cap total prefill tokens per step and age long jobs so they cannot starve. Switching happens only at iteration boundaries — there is no mid-kernel preemption. I would sweep chunk sizes on a replayed trace and choose the largest chunk that meets the short-request TTFT SLO.',
    whiteboard: [
      'Draw one 5 s iteration vs a train of 25 ms iterations.',
      'Write T_iter and ceil(P / C).',
      'Show short TTFT before/after.',
      'List costs: overhead, efficiency, attention growth.',
      'Add caps and aging for many long prompts.',
    ],
    followups: [
      ['How do you choose C?', 'Sweep it: largest chunk meeting the short TTFT and token-gap SLO with acceptable long-prompt penalty.'],
      ['Does chunking change the output?', 'No; prefill is exact attention over the same tokens, just computed in pieces with the KV cache.'],
      ['What if 30 % of prompts are 100K?', 'Then capacity, not ordering, is the issue; consider a separate long-context pool or admission limits.'],
    ],
    debug: [
      'After enabling chunking, short TTFT improved but token-gap p99 is still 2 s. What do you check?',
      'Whether the chunk or per-step prefill cap is still huge (e.g. equal to budget 8,192), and whether multiple long prompts run in the same iteration.',
    ],
    calc: [
      'Prefill at 20,000 tokens/s, 100K prompt, iteration overhead 15 ms, C = 1,000. Minimum long TTFT?',
      '100 chunks × (15 ms + 50 ms) = 6.5 s versus 5.0 s unchunked.',
    ],
  },
  changeMind: [
    'Measured iteration-time p99 already low because long prompts are rare and off-peak.',
    'A separate long-context pool available at acceptable cost.',
    'SLO that prioritizes long-document users over short chat users.',
  ],
  recall: [
    ['What does chunking bound?', 'The duration of every iteration.'],
    ['Who pays?', 'The long prompt: more iterations and overhead.'],
    ['Where does switching happen?', 'Only at iteration boundaries.'],
  ],
  glossary: [
    ['Chunked prefill', 'Processing a long prompt’s prefill in fixed-size pieces across several iterations.'],
    ['Head-of-line blocking', 'One large job at the front delaying every job behind it.'],
    ['Prefill', 'The forward pass over the prompt that builds the KV cache and yields the first token’s logits.'],
  ],
  tags: ['scheduling', 'prefill', 'ttft', 'long-context'],
};

const q8: Lesson = {
  id: 8,
  group: 'scheduling',
  short: 'Prefix-aware routing',
  question: 'Design prefix caching across multiple GPU replicas. How would you route requests to reuse cached KV blocks?',
  why: 'Shared system prompts and few-shot templates can skip most prefill work — but only if requests land where the KV already lives.',
  tldr: [
    'Hash token blocks (plus model, tokenizer, adapter and tenant) to identify cached prefixes per replica.',
    'Route by expected completion time: queue wait + uncached prefill, not affinity alone.',
    'Waiting for a warm replica only pays while its queue wait < prefix recompute time.',
  ],
  plain:
    'Each replica keeps KV blocks for prefixes it has seen. A router that knows which replica holds which prefix can skip recomputing thousands of tokens. Pure affinity overloads replicas that hold popular prefixes, so the router must weigh cache hits against queue length.',
  analogy: {
    name: 'Bakeries with pre-made dough',
    map: [
      ['Pre-made dough on a shop shelf', 'Cached KV blocks for a prefix on one replica'],
      ['Sending a customer to the shop that has the dough', 'Prefix affinity routing'],
      ['A long line at that shop', 'Queue wait on the warm replica'],
      ['Making dough from scratch at an empty shop', 'Recomputing the prefix on a cold replica'],
    ],
    breaks:
      'Dough is visible on a shelf; a router’s view of remote caches is a directory that can be stale. And a shop can hand dough to another shop; KV does not move between replicas unless you build a transfer path.',
  },
  example: {
    title: 'Five requests, two prefixes, three replicas, 1 cache slot each',
    inputs: 'Prefix A and B are 1,000 tokens each; every request adds 100 suffix tokens. Order: A, A, B, A, B.',
    steps: [
      { label: 'Affinity', state: 'A→R1 miss · A→R1 hit · B→R2 miss · A→R1 hit · B→R2 hit\ncached tokens = 3 × 1,000 = 3,000' },
      { label: 'Random (seeded)', state: 'A→R1 miss · A→R3 miss · B→R2 miss · A→R1 hit · B→R1 miss\ncached tokens = 1,000' },
      { label: 'Hit rate by tokens', state: 'total prompt tokens = 5 × 1,100 = 5,500\naffinity 3,000 / 5,500 = 54.5 %\nrandom 1,000 / 5,500 = 18.2 %' },
    ],
    output: 'Affinity saves 3× more prefill tokens on this sequence; under skew it also overloads R1.',
    predict: {
      q: 'If 95 % of traffic uses prefix A, what happens to replica R1 under pure affinity?',
      a: 'It receives ~95 % of prefixed requests while R2/R3 idle; its queue explodes. Load-aware routing spills some A traffic and recomputes the prefix elsewhere.',
    },
  },
  scenes: [
    {
      id: 'q8-s1', title: 'Same prefix, repeated work', objective: 'See prefill recomputed for a shared prefix.', duration: 18,
      narration: 'Many requests start with the same 4,000-token system prompt. Without caching, every replica recomputes those tokens for every request. That is pure waste.',
      lanes: [
        { label: 'Requests', items: [{ label: 'A + q1', kind: 'request' }, { label: 'A + q2', kind: 'request', at: 0.2 }, { label: 'A + q3', kind: 'request', at: 0.4 }] },
        { label: 'Prefill work', items: [{ label: 'A 4,000 tok', kind: 'prefill', at: 0.1 }, { label: 'A 4,000 tok', kind: 'error', at: 0.3 }, { label: 'A 4,000 tok', kind: 'error', at: 0.5 }] },
      ],
      transition: 'The same prefix block is computed three times.', action: 'Set cache slots to 0 in the simulator.',
    },
    {
      id: 'q8-s2', title: 'Hash blocks into a directory', objective: 'Identify cached prefixes safely.', duration: 18,
      narration: 'Each full block of tokens gets a hash chained from its parent block. The key also includes model version, tokenizer, adapter and tenant namespace. A directory maps these hashes to the replicas that hold them.',
      lanes: [
        { label: 'Block hashes', items: [{ label: 'h1 = H(model, tok, tenant, blk1)', kind: 'kv', at: 0.1 }, { label: 'h2 = H(h1, blk2)', kind: 'kv', at: 0.3 }] },
        { label: 'Directory', items: [{ label: 'h1,h2 → R1', kind: 'comm', at: 0.55 }, { label: 'h1 → R3 (stale?)', kind: 'neutral', at: 0.75 }] },
      ],
      equation: 'key_i = H(key_{i-1}, tokens of block i) — scoped by model/tokenizer/adapter/tenant',
      transition: 'Blocks turn into chained hashes and directory entries.', action: 'Think: why must tenant be part of the key?',
    },
    {
      id: 'q8-s3', title: 'Affinity routing', objective: 'Send requests to the replica holding their prefix.', duration: 18,
      narration: 'Affinity sends all prefix A traffic to replica 1 and prefix B to replica 2. Hit rate jumps above 80 percent. But if A is hot, replica 1 builds a long queue while others idle.',
      lanes: [
        { label: 'Replica 1 (A)', items: [{ label: 'A', kind: 'kv' }, { label: 'q', kind: 'request', at: 0.2 }, { label: 'q', kind: 'request', at: 0.35 }, { label: 'q', kind: 'request', at: 0.5 }, { label: 'q queue!', kind: 'error', at: 0.7 }] },
        { label: 'Replica 2 (B)', items: [{ label: 'B', kind: 'kv' }, { label: 'q', kind: 'request', at: 0.4 }] },
        { label: 'Replica 3', items: [{ label: 'idle', kind: 'neutral', at: 0.6 }] },
      ],
      transition: 'Hot prefix piles up on one replica.', action: 'Pick the failure preset (95 % on A, affinity).',
    },
    {
      id: 'q8-s4', title: 'Expected completion time', objective: 'Route by queue wait plus uncached work.', duration: 18,
      narration: 'Load-aware routing estimates, for each replica, the queue wait plus the prefill it would need. A warm replica saves the prefix; a cold one costs recomputation. Pick the minimum.',
      lanes: [
        { label: 'R1 warm', items: [{ label: 'wait 300 ms', kind: 'neutral', at: 0.1 }, { label: '+ suffix 6 ms', kind: 'prefill', at: 0.2 }, { label: '= 306 ms', kind: 'error', at: 0.3 }] },
        { label: 'R3 cold', items: [{ label: 'wait 0 ms', kind: 'neutral', at: 0.45 }, { label: '+ prefix+suffix 86 ms', kind: 'prefill', at: 0.55 }, { label: '= 86 ms ✓', kind: 'ok', at: 0.7 }] },
      ],
      equation: 'ECT(r) = wait(r) + (uncached tokens on r) × ms/token + decode',
      transition: 'Router chooses the cold replica because it finishes sooner.', action: 'Move the warm-wait slider past the break-even line.',
    },
    {
      id: 'q8-s5', title: 'Eviction, staleness, security', objective: 'Handle the production edge cases.', duration: 18,
      narration: 'Caches evict, so directory entries go stale; treat a miss as recompute, not an error. Bump a cache epoch when model or tokenizer changes. Never share blocks across tenants unless the prefix is explicitly public. Measure hit rate by tokens, not requests.',
      lanes: [
        { label: 'Eviction', items: [{ label: 'LRU drops A on R3', kind: 'kv', out: 0.3 }] },
        { label: 'Versioning', items: [{ label: 'epoch 7 → 8', kind: 'neutral', at: 0.4 }] },
        { label: 'Isolation', items: [{ label: 'tenant X ≠ tenant Y', kind: 'error', at: 0.6 }] },
        { label: 'Metric', items: [{ label: 'hit rate by tokens', kind: 'ok', at: 0.8 }] },
      ],
      transition: 'Edge cases attach to the directory.', action: 'Set prefixes per replica to 2 and compare hit rates.',
    },
  ],
  sim: {
    tldr: 'Three routing policies on the same seeded trace of shared-prefix requests; compare token hit rate, tail latency and load imbalance.',
    omits: [
      'Batching inside a replica (each replica serves one request at a time here).',
      'Partial prefix matches and block-level hashing (whole prefixes only).',
      'Stale directory entries and network latency of directory lookups.',
      'KV transfer between replicas.',
    ],
  },
  formula: {
    name: 'Expected completion time routing rule',
    tex: String.raw`r^* = \arg\min_r \Big[ W_r + \big(P \cdot [\text{miss}_r] + S\big)\, t_p + D \Big], \quad \text{wait warm iff } W_{warm} < W_{cold} + P\, t_p`,
    vars: [
      ['W_r', 'queue wait on replica r', 'ms'],
      ['P', 'shared prefix length', 'tokens'],
      ['miss_r', '1 if prefix not cached on r', '—'],
      ['S', 'unique suffix length', 'tokens'],
      ['t_p', 'prefill time per token', 'ms/token'],
      ['D', 'decode time', 'ms'],
    ],
    assumptions: ['Directory is fresh', 'Prefill cost linear in tokens', 'Decode time independent of replica'],
    substituted: 'P = 4,000, t_p = 0.02 ms → warm replica worth waiting for only while W_warm < W_cold + 80 ms',
    check: 'ms + tokens × ms/token = ms ✓',
    cue: 'Cache hits are worth their queue wait — and not one millisecond more.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Prefix recompute, 4K tokens', value: '80', unit: 'ms', assumptions: '0.02 ms/token prefill', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Token hit rate, affinity', value: '≈ 90', unit: '%', assumptions: '80 % prefixed, seed 3', source: 'Simulator', evidence: 'simulated' },
    { quantity: 'Token hit rate, random', value: '≈ 37', unit: '%', assumptions: 'Same trace', source: 'Simulator', evidence: 'simulated' },
    { quantity: 'KV per 4K-token prefix, 70B BF16', value: '1.25', unit: 'GiB', assumptions: '320 KiB/token (Q3)', source: 'Q3 formula', evidence: 'calculated' },
    { quantity: 'Production hit rate', value: 'not measured', unit: '%', assumptions: 'Workload dependent', source: 'Needs traces', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Round-robin or random routing; each replica caches whatever it sees.',
    improved: 'Chained block hashes scoped by model/tokenizer/adapter/tenant, a directory, and expected-completion-time routing with load spill.',
    mechanism: 'Requests land where their prefix KV already lives unless that replica’s queue costs more than recomputing.',
    rows: [
      ['Prefill tokens saved', 'Low (chance hits)', 'High (directed hits)'],
      ['Tail latency under skew', 'Even load', 'Even load (affinity alone: hotspots)'],
      ['Memory duplication', 'Prefix on every replica', 'Fewer copies'],
      ['Complexity', 'None', 'Directory, hashing, epochs, isolation'],
    ],
  },
  lab: {
    title: 'Chained block hashing with namespace', kind: 'cpu', deps: 'Python 3.10+ (hashlib)',
    commands: ['python3 prefix_hash.py'], lang: 'python',
    code: `import hashlib

def block_keys(tokens, block=16, ns=("llama-70b@v3", "tok@v2", "adapter:none", "tenant:acme")):
    h = hashlib.sha256("|".join(ns).encode()).digest()
    keys = []
    for i in range(0, len(tokens) - len(tokens) % block, block):   # full blocks only
        h = hashlib.sha256(h + str(tokens[i:i + block]).encode()).digest()
        keys.append(h.hex()[:12])
    return keys

a = block_keys(list(range(40)))
b = block_keys(list(range(32)) + [999] * 8)
assert a[:2] == b[:2] and len(a) == 2         # shared 32-token prefix → 2 shared blocks
other = block_keys(list(range(40)), ns=("llama-70b@v3", "tok@v2", "adapter:none", "tenant:evil"))
assert other[0] != a[0]                       # tenants never collide
print(a)`,
    checks: ['Shared 32-token prefix gives 2 equal block keys', 'Partial last block is not hashed', 'Different tenant → different keys'],
    gaps: 'No directory, eviction or routing; see route() in engines/g2.ts.',
  },
  bench: {
    hypothesis: 'Load-aware ECT routing achieves ≥ 80 % of affinity’s token hit rate with ≤ 1.2× load imbalance and lower p95 under skew.',
    baseline: 'Round-robin routing with per-replica prefix caching on.',
    controlled: ['Model + engine version', 'replica count and GPU', 'cache size per replica', 'trace (prefix mix, skew)', 'arrival rate'],
    workload: 'Replay with 2–20 shared prefixes, skew 50–95 %, arrival 50–90 % of capacity.',
    warmup: 'Cold start included and reported separately; then 5 min warm.', reps: '5 runs per policy × skew.',
    method: 'Engine prefix-cache metrics (cached tokens), router logs, client latency.',
    metrics: ['token hit rate', 'TTFT p50/p95', 'imbalance (max/mean busy)', 'duplicated prefix copies'],
    interpret: 'Plot hit rate vs p95 per policy; prefer the policy on the Pareto front at the target skew.',
  },
  pitfalls: [
    'Hit rate by requests instead of tokens hides that misses are often the long prefixes.',
    'Forgetting tokenizer/model/adapter version in the key → wrong KV reused after a deploy.',
    'Cross-tenant sharing of blocks: a timing side channel and a privacy risk.',
    'Assuming a directory hit means KV moves to you; it only says where it lives.',
  ],
  optimizations: [
    ['Consistent hashing with bounded load', 'Stable affinity with spill; still needs per-request ECT for big prefixes.'],
    ['Replicate hot prefixes on k replicas', 'Spreads hot load; costs memory per extra copy.'],
    ['Prefix-aware admission in the engine', 'Fewer recomputes; more scheduler state.'],
  ],
  breaks: [
    'Prefixes shorter than one block or mostly unique prompts: no reuse.',
    'Very hot single prefix with strict affinity: one replica saturates.',
    'Frequent model/adapter rollouts: epochs invalidate caches constantly.',
  ],
  interview: {
    short:
      'Each replica already has a local prefix cache: full KV blocks keyed by a hash chained from the previous block, scoped by model version, tokenizer, adapter and tenant so different deployments or customers never collide. Across replicas I add a router with a directory of which block hashes live where, fed by replica events and treated as possibly stale. For each request the router computes the longest cached prefix per replica and estimates expected completion time: queue wait plus prefill for the uncached tokens plus decode. It picks the minimum. Pure affinity maximizes hits but turns a hot prefix into a hotspot; the ECT rule spills traffic once the warm replica’s wait exceeds the recompute cost. Concretely, a 4,000-token prefix at 0.02 ms per token costs 80 ms, so waiting for a warm replica is worth it only while its extra wait is under 80 ms. I measure hit rate by tokens, track imbalance and tail latency, bump a cache epoch on any model or tokenizer change, and never share blocks across tenants unless the prefix is explicitly public.',
    whiteboard: [
      'Draw 3 replicas with cached prefix chips.',
      'Write block key chaining with namespace fields.',
      'Write ECT(r) and the break-even inequality.',
      'Show affinity hotspot under skew, then ECT spill.',
      'List edge cases: eviction, staleness, epochs, tenants.',
    ],
    followups: [
      ['How stale can the directory be?', 'Any staleness is safe if a miss falls back to recompute; it only costs efficiency, so prefer cheap eventual updates.'],
      ['Should you transfer KV from the warm replica instead?', 'Only if transfer time (bytes / effective bandwidth + setup) beats recompute and the link is free; see Q22.'],
      ['How do you measure success?', 'Token-weighted hit rate, TTFT p95, imbalance, and GPU-seconds saved per hour.'],
    ],
    debug: [
      'After a tokenizer patch, answers become subtly wrong for some users. Router hit rate is 92 %. What happened?',
      'Cache keys did not include the tokenizer version, so old KV is reused for differently tokenized prompts; add version to the key and bump the epoch.',
    ],
    calc: [
      'Prefix 6,000 tokens, prefill 0.025 ms/token. Warm replica wait 120 ms, cold replica wait 10 ms. Where do you route?',
      'Warm: 120 ms (+ suffix). Cold: 10 + 150 = 160 ms (+ suffix). Route to warm.',
    ],
  },
  changeMind: [
    'Trace data showing few shared prefixes (caching won’t pay).',
    'Measured cheap KV transfer between replicas (then route by load and transfer).',
    'Hard tenant isolation requirements forbidding any shared cache.',
  ],
  recall: [
    ['What goes into a block key?', 'Parent hash + block tokens, scoped by model, tokenizer, adapter, tenant.'],
    ['When is waiting for a warm replica worth it?', 'While its extra wait < prefix recompute time.'],
    ['Hit rate measured by?', 'Tokens, not requests.'],
  ],
  glossary: [
    ['Prefix caching', 'Reusing KV blocks computed for an identical leading token sequence.'],
    ['ECT', 'Expected completion time: estimated queue wait plus service time on a replica.'],
    ['Cache epoch', 'A version number that invalidates all cached entries when bumped.'],
  ],
  tags: ['routing', 'prefix-cache', 'kv', 'load-balancing'],
};

const q9: Lesson = {
  id: 9,
  group: 'scheduling',
  short: 'Inter-token latency',
  question: 'Your throughput looks great, but users complain that tokens arrive too slowly. How would you reduce inter-token latency without destroying throughput?',
  why: 'Aggregate tokens per second and per-user token gaps move in opposite directions as batch size grows.',
  tldr: [
    'Each decode step serves the whole batch: bigger batch → more total tokens/s, longer gap per user.',
    'Pick the largest batch on the throughput/latency frontier that meets the token-gap SLO.',
    'Check the transport too: flush intervals and proxy buffering can dominate what users see.',
  ],
  plain:
    'One decode step reads all weights once and produces one token for every request in the batch. Adding requests raises total throughput but makes each step slower, so every user waits longer between tokens. Users also see delays added after the GPU: server flushing, proxies and rendering.',
  analogy: {
    name: 'Delivery truck',
    map: [
      ['One truck trip', 'One decode step'],
      ['Parcels per trip', 'Requests in the batch'],
      ['Loading the truck with the depot inventory each trip', 'Reading all weights from HBM each step'],
      ['Each household waiting for its next parcel', 'One user waiting for the next token'],
      ['Parcels held at the local post office', 'Proxy buffering'],
    ],
    breaks:
      'A bigger truck does not drive slower, but a bigger batch reads more KV and does more compute per step. And parcels do not depend on the previous parcel; each token depends on the one before.',
  },
  example: {
    title: 'Roofline step time for a 70B TP8 rank (assumed H100-class)',
    inputs: '17.5 GB weights/GPU, 40 KiB KV/token/GPU, 4,096-token context, 3.35 TB/s, 4 ms fixed overhead',
    steps: [
      { label: 'Batch 1', state: 'memory = (17.5e9 + 4,096 × 40 KiB) / 3.35e12 = 5.27 ms\nstep = 4 + 0.02 + 5.27 = 9.29 ms → 108 tok/s per user, 108 total' },
      { label: 'Batch 64', state: 'memory = 8.43 ms, compute = 2.27 ms → memory-bound\nstep = 4 + 1.28 + 8.43 = 13.71 ms → 73 tok/s per user, 4,668 total' },
      { label: 'Batch 256', state: 'step = 27.17 ms → 37 tok/s per user, 9,424 total' },
      { label: 'Add transport', state: 'batch 32 model gap 11.5 ms\n+ prefill 6 + flush 50 + proxy 60 + render 2 = 129 ms per token' },
    ],
    output: 'The GPU is not the slow part at batch 32: buffering adds 110 ms per token.',
    predict: {
      q: 'Going from batch 64 to 256 multiplies total throughput by how much, and per-user speed by how much?',
      a: 'Total ×2.0 (4,668 → 9,424 tok/s); per user ×0.5 (73 → 37 tok/s).',
    },
  },
  scenes: [
    {
      id: 'q9-s1', title: 'Two different speeds', objective: 'Separate aggregate throughput from per-user token gaps.', duration: 18,
      narration: 'The dashboard says 9,000 tokens per second. But each user only gets one token per step, and a step at batch 256 takes 27 milliseconds. Users feel 37 tokens per second.',
      lanes: [
        { label: 'Aggregate', items: [{ label: '9,424 tok/s', kind: 'ok' }] },
        { label: 'User A', items: [{ label: 't', kind: 'decode', at: 0.2 }, { label: 't', kind: 'decode', at: 0.5 }, { label: 't', kind: 'decode', at: 0.8 }] },
        { label: 'Gap', items: [{ label: '27 ms each', kind: 'error', at: 0.6 }] },
      ],
      equation: 'per-user tok/s = 1000 / step_ms ; total = B × per-user',
      transition: 'One big counter vs a slow trickle per user.', action: 'Find both numbers in the simulator stats.',
    },
    {
      id: 'q9-s2', title: 'Why steps grow with batch', objective: 'Use the roofline to explain step time.', duration: 18,
      narration: 'Every step reads all weights once, about 17.5 gigabytes per GPU. Each extra request adds its own KV reads and some compute. At small batch, weight reads dominate; at large batch, KV and compute catch up.',
      lanes: [
        { label: 'Weights read', items: [{ label: '17.5 GB / step', kind: 'kv' }] },
        { label: 'KV read', items: [{ label: 'B × ctx × 40 KiB', kind: 'kv', at: 0.35 }] },
        { label: 'Compute', items: [{ label: '2 × params × B', kind: 'prefill', at: 0.6 }] },
        { label: 'Step', items: [{ label: 'fixed + max(mem, compute)', kind: 'decode', at: 0.85 }] },
      ],
      equation: 'step ≈ t_fixed + t_seq·B + max(bytes / BW, FLOPs / peak)',
      transition: 'Step bar grows as KV and compute bars grow.', action: 'Raise context to 16K and watch the frontier move up.',
    },
    {
      id: 'q9-s3', title: 'The frontier and the SLO', objective: 'Choose a batch size from the Pareto curve.', duration: 18,
      narration: 'Plot token gap against total throughput for each batch size. Draw the SLO line, for example 50 milliseconds per token. The best operating point is the highest throughput still under the line.',
      lanes: [
        { label: 'Batch', items: [{ label: '8', kind: 'neutral', at: 0.1 }, { label: '32', kind: 'neutral', at: 0.25 }, { label: '128', kind: 'neutral', at: 0.4 }, { label: '256', kind: 'neutral', at: 0.55 }] },
        { label: 'Feasible', items: [{ label: 'under SLO ✓', kind: 'ok', at: 0.7 }] },
        { label: 'Infeasible', items: [{ label: 'over SLO', kind: 'error', at: 0.85 }] },
      ],
      transition: 'Points split into feasible and infeasible.', action: 'Lower the SLO slider to 20 ms and read the largest feasible batch.',
    },
    {
      id: 'q9-s4', title: 'Prefill interference', objective: 'See how prefill chunks inflate some gaps.', duration: 18,
      narration: 'When a prefill chunk shares a step with decodes, that step takes longer. If one step in five carries a 30 millisecond chunk, the mean gap rises 6 milliseconds and the worst gaps rise 30.',
      lanes: [
        { label: 'Steps', items: [{ label: '●', kind: 'decode', at: 0.1 }, { label: '●', kind: 'decode', at: 0.2 }, { label: '● + ◆ chunk', kind: 'prefill', at: 0.35 }, { label: '●', kind: 'decode', at: 0.5 }, { label: '●', kind: 'decode', at: 0.6 }] },
        { label: 'Gap', items: [{ label: '11 ms', kind: 'ok', at: 0.2 }, { label: '41 ms spike', kind: 'error', at: 0.4 }] },
      ],
      equation: 'mean gap += share × chunk_ms ; worst gap += chunk_ms',
      transition: 'One step stretches when a chunk joins.', action: 'Set prefill share to 50 % (stress preset).',
    },
    {
      id: 'q9-s5', title: 'It might not be the GPU', objective: 'Measure transport delays separately.', duration: 18,
      narration: 'A server that flushes every 100 milliseconds, or a proxy that buffers responses, delivers tokens in bursts. The GPU gap is 11 milliseconds, but users see 129. Fix flushing and disable proxy buffering before touching the batch.',
      lanes: [
        { label: 'GPU', items: [{ label: '11 ms', kind: 'decode' }] },
        { label: 'Server flush', items: [{ label: '+50 ms', kind: 'comm', at: 0.3 }] },
        { label: 'Proxy', items: [{ label: '+60 ms', kind: 'comm', at: 0.5 }] },
        { label: 'Client sees', items: [{ label: '129 ms bursts', kind: 'error', at: 0.75 }] },
      ],
      transition: 'Gap bar grows mostly outside the GPU.', action: 'Pick the failure preset and read the breakdown bar.',
    },
  ],
  sim: {
    tldr: 'A roofline step-time model draws the throughput/latency frontier; the breakdown bar shows how much of each client gap is not the GPU.',
    omits: [
      'Attention kernel efficiency and real overlap of compute with memory.',
      'Variance between steps other than prefill chunks; worst case is approximate.',
      'Tensor-parallel communication cost (folded into the 4 ms fixed term).',
      'Assumed hardware: 3.35 TB/s and 989 TFLOPS dense BF16 are vendor peaks, scaled by an assumed 50 % efficiency.',
    ],
  },
  formula: {
    name: 'Decode step and token gap',
    tex: String.raw`t_{step}(B) = t_0 + t_s B + \max\!\Big(\tfrac{W + B\,c\,k}{BW},\ \tfrac{2 P B}{\eta F}\Big), \quad \text{gap}_{client} = t_{step} + \rho\, t_{chunk} + \tfrac{t_{flush}}{2} + t_{proxy} + t_{render}`,
    vars: [
      ['B', 'decode batch size', 'requests'],
      ['W', 'weight bytes per GPU', 'B'],
      ['c', 'context tokens per request', 'tokens'],
      ['k', 'KV bytes per token per GPU', 'B/token'],
      ['BW', 'effective HBM bandwidth', 'B/s'],
      ['P', 'parameters per GPU', 'params'],
      ['ηF', 'achieved FLOP/s', 'FLOP/s'],
      ['ρ', 'share of steps carrying a prefill chunk', '—'],
    ],
    assumptions: ['Roofline lower bound, no overlap gains', 'Flush delay uniform in [0, interval]'],
    substituted: 'B = 64: 4 + 1.28 + max(8.43, 2.27) = 13.71 ms → 72.9 tok/s/user, 4,668 tok/s total',
    check: 'B / (B/s) = s; FLOP / (FLOP/s) = s ✓',
    cue: 'Batch buys throughput with every user’s time; check the pipe before the GPU.',
    isModel: true,
  },
  estimates: [
    { quantity: 'H100 SXM HBM3 bandwidth', value: '3.35', unit: 'TB/s', assumptions: 'Peak, decimal', source: 'NVIDIA H100 datasheet', evidence: 'vendor spec' },
    { quantity: 'H100 SXM dense BF16', value: '989', unit: 'TFLOPS', assumptions: 'Peak, no sparsity', source: 'NVIDIA H100 datasheet', evidence: 'vendor spec' },
    { quantity: 'Model step at B=64, 4K ctx', value: '13.7', unit: 'ms', assumptions: '70B TP8, 50 % compute eff.', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Comfortable reading speed', value: '≈ 5–10', unit: 'tokens/s', assumptions: 'English prose, ~0.75 words/token', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'Real step times', value: 'not measured', unit: 'ms', assumptions: 'Needs profiling', source: 'Bench protocol', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Maximize batch size and token budget to max out tokens/s; flush output in large buffers.',
    improved: 'Pick batch on the frontier under a token-gap SLO, cap prefill per step, flush per token, disable proxy buffering.',
    mechanism: 'Step time sets the model gap; transport settings add to it independently, so both are tuned against the same SLO.',
    rows: [
      ['Aggregate tok/s', 'Maximum', 'Slightly lower (SLO cap)'],
      ['Per-user gap', 'Long and bursty', 'Under SLO'],
      ['Cost per token', 'Lowest', 'Slightly higher'],
      ['Fairness', 'Prefill spikes hit everyone', 'Bounded by prefill cap'],
    ],
  },
  lab: {
    title: 'Frontier calculator', kind: 'cpu', deps: 'Python 3.10+',
    commands: ['python3 frontier.py'], lang: 'python',
    code: `def step_ms(B, ctx=4096, W=17.5e9, kv=40*1024, bw=3.35e12, P=8.75e9, F=989e12*0.5, t0=4, ts=0.02):
    mem = (W + B * ctx * kv) / bw * 1e3
    comp = 2 * P * B / F * 1e3
    return t0 + ts * B + max(mem, comp)

rows = [(B, step_ms(B)) for B in (1, 8, 32, 64, 128, 256)]
for B, s in rows:
    print(f"B={B:4d} gap={s:6.2f} ms  user={1000/s:6.1f} tok/s  total={B*1000/s:8.0f} tok/s")
assert abs(step_ms(64) - 13.709) < 0.01
slo = 20
best = max(B for B, s in rows if s <= slo)
print("largest batch under", slo, "ms:", best)`,
    checks: ['B=64 gives 13.71 ms', 'Gap strictly increases with B', 'Total tokens/s strictly increases with B'],
    gaps: 'No measured curve; replace the model with your own measured step times per batch.',
  },
  bench: {
    hypothesis: 'Disabling proxy buffering and flushing per token cuts client token-gap p95 by > 50 % with no throughput change.',
    baseline: 'Current gateway/proxy configuration at the same batch size.',
    controlled: ['Engine config and batch cap', 'GPU', 'request mix', 'client location', 'proxy version'],
    workload: 'Steady open-loop load at 70 % of capacity; 1,000 streaming requests.',
    warmup: '1 minute.', reps: '3 runs per configuration.',
    method: 'Server timestamps at token emission + client receive timestamps; compute both gap distributions.',
    metrics: ['server gap p50/p95', 'client gap p50/p95', 'burst size (tokens per network read)', 'throughput'],
    interpret: 'If client gaps ≫ server gaps, fix transport before batching. Then sweep batch caps to draw the measured frontier.',
  },
  pitfalls: [
    'Optimizing only aggregate tokens/s: users feel per-request gaps.',
    'Measuring gaps at the server only: proxies, compression and buffering are invisible.',
    'Over-prioritizing decode: new requests then wait too long for their first token.',
  ],
  optimizations: [
    ['Batch cap from the SLO frontier', 'Meets gap SLO; caps cost efficiency.'],
    ['Per-token flush + no proxy buffering', 'Removes bursts; more packets and syscalls.'],
    ['Speculative decoding (Q10)', 'Fewer steps per token at low batch; less useful when saturated.'],
  ],
  breaks: [
    'Memory-bound step dominated by weights: shrinking batch barely helps, use faster memory, quantization or speculation.',
    'Network-limited clients: GPU tuning cannot fix slow last-mile links.',
  ],
  interview: {
    short:
      'First I would separate the two speeds. Aggregate tokens per second counts every request; a user gets one token per decode step, so their speed is one over the step time. Bigger batches raise aggregate throughput but each step reads more KV and does more compute, so every user’s gap grows. I would measure the step time per batch size and plot the throughput-latency frontier, then choose the largest batch whose token gap meets the SLO — say 50 ms. Second, I would check prefill interference: if prefill chunks share decode steps, cap prefill tokens per step or chunk smaller. Third, and often the real cause, I would compare server-side and client-side token timestamps. A server that flushes every 100 ms or a proxy that buffers responses turns 11 ms GPU gaps into 100+ ms bursts. Fixing flush-per-token and disabling proxy buffering costs no throughput. Only after that would I consider speculative decoding or faster hardware. I would be careful not to over-prioritize decode, which hurts TTFT for new requests.',
    whiteboard: [
      'Two formulas: per-user = 1000 / step; total = B × per-user.',
      'Roofline step: fixed + max(bytes/BW, FLOPs/peak).',
      'Draw the frontier with SLO line.',
      'Stack the client gap: model + prefill + flush + proxy + render.',
      'Order of fixes: transport → prefill cap → batch cap → speculation.',
    ],
    followups: [
      ['How do you detect proxy buffering?', 'Compare server emit timestamps with client receive timestamps; buffering shows as bursts of many tokens per read.'],
      ['Can you keep throughput with smaller batches?', 'Partly: more replicas at smaller batch cost more GPUs; speculation or quantization lower step time instead.'],
      ['Why does context length matter?', 'KV read per step scales with batch × context, so long contexts make each step slower.'],
    ],
    debug: [
      'GPU step time is 12 ms, but users report ~10 tokens appearing every second in bursts. Cause?',
      'Output is buffered: a flush interval or proxy buffering (e.g. Nginx proxy_buffering on) holds tokens; flush per event and disable buffering for SSE.',
    ],
    calc: [
      'Step time 20 ms at batch 96. Per-user and total tokens/s?',
      'Per user 1000/20 = 50 tok/s; total 96 × 50 = 4,800 tok/s.',
    ],
  },
  changeMind: [
    'Measured client gaps equal server gaps (then it really is the GPU).',
    'A product where users read slowly anyway (relax the gap SLO, save cost).',
    'Measured frontier that is flat (memory-bound by weights): batch changes won’t help.',
  ],
  recall: [
    ['Per-user tok/s formula?', '1000 / step_ms.'],
    ['What sets the batch cap?', 'The largest batch on the frontier under the gap SLO.'],
    ['First non-GPU suspect?', 'Flush interval and proxy buffering.'],
  ],
  glossary: [
    ['Pareto frontier', 'The set of settings where you cannot improve one metric without worsening another.'],
    ['SLO', 'Service-level objective: a target for a measured metric, e.g. token gap p95 ≤ 50 ms.'],
    ['Roofline', 'Bound on performance by either compute peak or memory bandwidth × arithmetic intensity.'],
    ['HBM', 'High-bandwidth memory on the GPU package.'],
  ],
  tags: ['latency', 'itl', 'batching', 'streaming', 'roofline'],
};

const q10: Lesson = {
  id: 10,
  group: 'scheduling',
  short: 'Speculative decoding',
  question: 'Explain speculative decoding. Calculate when the extra draft-model work is worth it, and when it makes inference slower.',
  why: 'It can cut latency 1.5–3× at low load, or make serving slower when acceptance is low or the GPU is saturated.',
  tldr: [
    'A cheap drafter proposes k tokens; the target verifies all of them in one forward pass.',
    'Expected tokens per round = (1 − a^(k+1)) / (1 − a) under a simple constant-acceptance model.',
    'It wins only if those tokens per round time beat the baseline; batch saturation erases the win.',
  ],
  plain:
    'Decoding is slow because each token needs a full pass of the big model. A small draft model guesses several tokens ahead, and the big model checks them all at once. Accepted guesses are free extra tokens; a rejected guess is replaced by the big model’s own choice.',
  analogy: {
    name: 'Draft writer and editor',
    map: [
      ['Junior writer drafting a sentence ahead', 'Draft model proposing k tokens'],
      ['Editor reading the whole draft in one sitting', 'Target model verifying k tokens in one pass'],
      ['Editor keeps words until the first mistake and fixes it', 'Accept prefix, emit one correction token'],
      ['Draft fully accepted → editor adds one more word', 'Bonus token when all k are accepted'],
    ],
    breaks:
      'An editor’s reading time grows with draft length; a memory-bound GPU verifies k tokens almost as fast as one — until the batch saturates compute. And the acceptance rule must preserve the target’s probability distribution, not just “agree”.',
  },
  example: {
    title: 'Break-even with illustrative timings',
    inputs: 'a = 0.7, k = 4, draft 3 ms/token, target step 30 ms, verify +10 % per draft token, 1 ms overhead',
    steps: [
      { label: 'E[tokens]', state: '(1 − 0.7⁵) / (1 − 0.7) = (1 − 0.16807) / 0.3 = 2.773' },
      { label: 'Round time', state: 'draft 4 × 3 = 12 ms\nverify 30 × (1 + 0.1 × 4) = 42 ms\n+1 ms → 55 ms' },
      { label: 'Throughput', state: 'speculative 2.773 / 55 ms = 50.4 tok/s\nbaseline 1 / 30 ms = 33.3 tok/s' },
      { label: 'Speedup', state: '50.4 / 33.3 = 1.51×' },
    ],
    output: '1.51× faster at low load. With verify +60 % per draft token (saturated batch) the same setup gives 0.72× — slower.',
    predict: {
      q: 'With a = 0.3, k = 6, draft 8 ms and a saturated verifier, faster or slower than baseline?',
      a: 'Much slower: E = 1.43 tokens per 259 ms round → 5.5 tok/s vs 33.3 (0.17×).',
    },
  },
  scenes: [
    {
      id: 'q10-s1', title: 'One token per big pass', objective: 'See why decoding is serial and memory-bound.', duration: 18,
      narration: 'Normally the target model produces one token per forward pass. Each pass reads all weights, about 30 milliseconds here. A 100-token answer takes 100 passes.',
      lanes: [
        { label: 'Target passes', items: [{ label: 't1 30 ms', kind: 'decode', at: 0.1 }, { label: 't2 30 ms', kind: 'decode', at: 0.35 }, { label: 't3 30 ms', kind: 'decode', at: 0.6 }, { label: 't4 30 ms', kind: 'decode', at: 0.85 }] },
      ],
      equation: 'baseline = 1 token / 30 ms = 33.3 tok/s',
      transition: 'Tokens appear one per pass.', action: 'Note the baseline tokens/s stat.',
    },
    {
      id: 'q10-s2', title: 'Draft k tokens cheaply', objective: 'Introduce the drafter.', duration: 18,
      narration: 'A small draft model, ten times cheaper, guesses four tokens in a row: twelve milliseconds total. These are only proposals.',
      lanes: [
        { label: 'Draft model', items: [{ label: 'd1', kind: 'prefill', at: 0.15 }, { label: 'd2', kind: 'prefill', at: 0.35 }, { label: 'd3', kind: 'prefill', at: 0.55 }, { label: 'd4', kind: 'prefill', at: 0.75 }] },
        { label: 'Cost', items: [{ label: '4 × 3 ms = 12 ms', kind: 'neutral', at: 0.9 }] },
      ],
      transition: 'Four draft chips appear.', action: 'Change draft length k and watch round time.',
    },
    {
      id: 'q10-s3', title: 'Verify in one pass', objective: 'Accept the longest correct prefix and correct the first miss.', duration: 18,
      narration: 'The target scores all four proposals in one pass. It accepts d1 and d2, rejects d3, and emits its own token instead. d4 is discarded. Three tokens for one big pass plus drafting.',
      lanes: [
        { label: 'Verify', items: [{ label: 'd1 ✓', kind: 'ok', at: 0.15 }, { label: 'd2 ✓', kind: 'ok', at: 0.3 }, { label: 'd3 ✕', kind: 'error', at: 0.45 }, { label: 'd4', kind: 'neutral', out: 0.5 }] },
        { label: 'Emitted', items: [{ label: 'd1', kind: 'decode', at: 0.6 }, { label: 'd2', kind: 'decode', at: 0.7 }, { label: 'correction', kind: 'decode', at: 0.85 }] },
      ],
      equation: 'E[emitted] = Σ_{i=0..k} a^i = (1 − a^{k+1}) / (1 − a)',
      transition: 'Rejected draft is replaced; the tail is dropped.', action: 'Press "Draft another round" a few times.',
    },
    {
      id: 'q10-s4', title: 'Exactness for sampling', objective: 'Explain distribution-preserving acceptance.', duration: 18,
      narration: 'For greedy decoding, accept while tokens match. For sampling, accept each draft token with probability min of one and p target over q draft; on rejection, sample from the normalized leftover distribution. Then outputs follow the target exactly. Simple agreement is not enough.',
      lanes: [
        { label: 'Rule', items: [{ label: 'accept w.p. min(1, p/q)', kind: 'ok', at: 0.2 }] },
        { label: 'On reject', items: [{ label: 'sample from norm(max(0, p − q))', kind: 'decode', at: 0.5 }] },
        { label: 'Result', items: [{ label: 'same distribution as target', kind: 'ok', at: 0.8 }] },
      ],
      equation: 'P(accept x) = min(1, p(x) / q(x))',
      transition: 'Acceptance rule appears, then the correction rule.', action: 'Name one approximate variant that breaks exactness.',
    },
    {
      id: 'q10-s5', title: 'When it gets slower', objective: 'Identify low acceptance, expensive drafts and saturated batches.', duration: 18,
      narration: 'If acceptance is low, most drafts are wasted. If the drafter is expensive, drafting eats the savings. And at large batch the target is compute-bound, so verifying k extra tokens costs nearly k extra passes. Then speculation is slower than plain decoding.',
      lanes: [
        { label: 'Low a = 0.3', items: [{ label: '1.43 tokens/round', kind: 'error', at: 0.2 }] },
        { label: 'Saturated verify', items: [{ label: '210 ms verify', kind: 'error', at: 0.45 }] },
        { label: 'Speedup', items: [{ label: '0.17× (slower)', kind: 'error', at: 0.7 }, { label: 'turn it off', kind: 'ok', at: 0.9 }] },
      ],
      transition: 'Speedup bar drops below the 1× line.', action: 'Pick the failure preset.',
    },
  ],
  sim: {
    tldr: 'Change acceptance, draft length, draft cost and batch load; the speedup curves and the sampled round all use the same round-time model.',
    omits: [
      'Position-dependent acceptance (real a drops later in the draft).',
      'Tree drafting, self-speculation and multi-token heads (different formulas).',
      'KV cache rollback cost beyond a fixed overhead.',
      'Interaction with continuous batching across many requests.',
    ],
  },
  formula: {
    name: 'Speculative speedup (sequential, constant acceptance)',
    tex: String.raw`E[N] = \sum_{i=0}^{k} a^i = \frac{1 - a^{k+1}}{1 - a}, \quad \text{speedup} = \frac{E[N] / (k\,t_d + t_v(k) + t_o)}{1 / t_t}`,
    vars: [
      ['a', 'probability each draft token is accepted, given the previous ones were', '—'],
      ['k', 'draft tokens per round', 'tokens'],
      ['t_d', 'draft time per token', 'ms'],
      ['t_v(k)', 'target verify time for k drafts', 'ms'],
      ['t_o', 'sync / sampling / rollback overhead', 'ms'],
      ['t_t', 'baseline target step', 'ms'],
    ],
    assumptions: ['Constant, independent acceptance a', 'One bonus or correction token per round', 't_v(k) = t_t(1 + s·k), s from batch load'],
    substituted: 'a = 0.7, k = 4: E = 2.773; round = 12 + 42 + 1 = 55 ms; speedup = (2.773/55)/(1/30) = 1.51×',
    check: '(tokens / ms) / (tokens / ms) = dimensionless ✓; a = 1 → k + 1, a = 0 → 1 ✓',
    cue: 'Tokens per round over time per round — beat one token per target step.',
  },
  estimates: [
    { quantity: 'Worked-example speedup', value: '1.51', unit: '×', assumptions: 'a=0.7, k=4, illustrative timings', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Same, saturated verify (s=0.6)', value: '0.72', unit: '×', assumptions: 'Batch compute-bound', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Draft/target cost ratio', value: '1/20–1/5', unit: '—', assumptions: 'Small drafter vs 70B', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'Acceptance rate in production', value: 'not measured', unit: '—', assumptions: 'Task and drafter dependent', source: 'Needs logging', evidence: 'not measured' },
  ],
  compare: {
    naive: 'One target forward pass per output token.',
    improved: 'Draft k tokens cheaply, verify in one target pass with distribution-preserving acceptance; tune k per load and disable under saturation.',
    mechanism: 'At low batch a target pass is memory-bound, so verifying k+1 positions costs about the same as one; accepted drafts become extra tokens per pass.',
    rows: [
      ['Per-user latency (low load)', 'Baseline', '1.5–3× faster if a is high'],
      ['Throughput (high load)', 'Baseline', 'Can drop: wasted verify compute'],
      ['Memory', 'Target only', '+ draft model weights and KV'],
      ['Quality', 'Exact', 'Exact with proper acceptance; approximate variants differ'],
      ['Complexity', 'Low', 'Two models, rollback, tuning'],
    ],
  },
  lab: {
    title: 'Speculation calculator + Monte Carlo check', kind: 'cpu', deps: 'Python 3.10+',
    commands: ['python3 spec.py'], lang: 'python',
    code: `import random

def expected(a, k):
    return k + 1 if a >= 1 else (1 - a ** (k + 1)) / (1 - a)

def speedup(a, k, td, tt, s, to=1.0):
    return expected(a, k) / (k * td + tt * (1 + s * k) + to) * tt

assert expected(0, 4) == 1 and expected(1, 4) == 5
assert abs(speedup(0.7, 4, 3, 30, 0.1) - 1.5126) < 1e-3

rng = random.Random(0)
def sample(a, k):
    n = 0
    while n < k and rng.random() < a: n += 1
    return n + 1                      # accepted + bonus/correction
mc = sum(sample(0.7, 4) for _ in range(200_000)) / 200_000
assert abs(mc - expected(0.7, 4)) < 0.02
print("E =", round(expected(0.7, 4), 3), "MC =", round(mc, 3))`,
    checks: ['a = 0 → 1 and a = 1 → k + 1', 'Worked example 1.51×', 'Monte Carlo mean within 0.02 of the formula'],
    gaps: 'No real models; measure a, t_d and t_v(k) on your engine before trusting any speedup.',
  },
  bench: {
    hypothesis: 'Speculative decoding (k = 4) improves per-user tokens/s by ≥ 1.3× at batch ≤ 8 and does not reduce throughput at batch 64 by more than 5 %.',
    baseline: 'Same engine, speculation off.',
    controlled: ['Target and draft model versions', 'sampling params (temperature)', 'GPU', 'batch caps', 'prompt set'],
    workload: 'Fixed prompt set per task type (code, chat, summarization) at batch 1, 8, 32, 64.',
    warmup: '20 requests.', reps: '5 runs per (task, batch, k).',
    method: 'Engine metrics for acceptance rate per position; client tokens/s; verify output distribution on a held-out set.',
    metrics: ['acceptance rate a by position', 'tokens/s per user', 'aggregate throughput', 'quality metric deltas'],
    interpret: 'Fit measured a and timings into the formula; enable speculation only in the (task, batch) cells where measured speedup > 1 with interval excluding 1.',
  },
  pitfalls: [
    'Using agreement-only acceptance with sampling: changes the output distribution.',
    'Measuring a on easy prompts, then deploying on hard ones.',
    'Keeping speculation on at high batch where verify is compute-bound.',
    'Ignoring the draft model’s own memory and KV footprint.',
  ],
  optimizations: [
    ['Adaptive k per request and load', 'Keeps speedup near optimum; more control logic.'],
    ['Better drafters (distilled, same tokenizer)', 'Higher a; training and memory cost.'],
    ['Disable above a batch threshold', 'Protects throughput; loses low-latency benefit at peak.'],
  ],
  breaks: [
    'Acceptance rate below ~0.4 with a non-trivial draft cost.',
    'Saturated, compute-bound batches where verify cost grows ~linearly with k.',
    'Tokenizer mismatch between drafter and target.',
  ],
  interview: {
    short:
      'Decoding is serial: one target forward pass per token, and at low batch that pass is limited by reading the weights, not by math. Speculative decoding uses a cheap drafter to propose k tokens, then the target scores all k positions in one pass. It keeps the longest accepted prefix and emits one more token — a correction at the first rejection, or a bonus if all k pass. For sampling, each draft token is accepted with probability min(1, p over q) and a rejection resamples from the leftover distribution, which keeps the output distribution exactly the target’s. With constant acceptance a, expected tokens per round are (1 − a^(k+1)) / (1 − a). Speculation pays off when that divided by the round time — k draft steps plus verification plus overhead — beats one token per baseline step. With a = 0.7, k = 4, 3 ms drafts and a 30 ms target, I get 2.77 tokens per 55 ms, a 1.51× speedup. It becomes slower when acceptance is low, the drafter is expensive, or the batch is large enough that verification is compute-bound; so I would measure a per task and disable or shrink k under load.',
    whiteboard: [
      'Draw draft chips d1..dk, verify pass, accept/reject.',
      'Derive E[N] as a geometric sum.',
      'Write round time and speedup ratio.',
      'Plug numbers: 1.51×.',
      'Show the saturated case: 0.72×.',
    ],
    followups: [
      ['Why is verifying k tokens nearly free?', 'At small batch the target pass is memory-bound on weights; extra positions add little time until compute saturates.'],
      ['Is speculative decoding exact?', 'Yes with the rejection-sampling acceptance rule (or greedy match); approximate variants that relax acceptance are not.'],
      ['How do you choose k?', 'Maximize speedup(k) with measured a and timings; typically 2–6, lower under load.'],
    ],
    debug: [
      'Speculation shows 1.8× in the lab but production throughput dropped 15 %. Why?',
      'Production runs at large batch where verification is compute-bound and acceptance is lower on real prompts; disable above a batch threshold.',
    ],
    calc: [
      'a = 0.8, k = 3, draft 2 ms, target 25 ms, verify +5 % per draft token, overhead 1 ms. Speedup?',
      'E = (1 − 0.8⁴)/0.2 = 2.952; round = 6 + 28.75 + 1 = 35.75 ms; 2.952/35.75 × 25 = 2.06×.',
    ],
  },
  changeMind: [
    'Measured per-position acceptance much lower than average a.',
    'Deployment runs mostly at high batch (throughput-bound).',
    'An engine with tree drafting or Medusa-style heads (different cost model).',
  ],
  recall: [
    ['E[tokens/round] formula?', '(1 − a^(k+1)) / (1 − a); k + 1 when a = 1.'],
    ['What keeps it exact for sampling?', 'Accept w.p. min(1, p/q); resample from the leftover on reject.'],
    ['When is it slower?', 'Low acceptance, expensive draft, saturated batch.'],
  ],
  glossary: [
    ['Speculative decoding', 'Drafting several tokens cheaply and verifying them in one target-model pass.'],
    ['Acceptance rate', 'Probability that a draft token is kept by the verifier.'],
    ['Bonus token', 'The extra target token emitted when every draft token is accepted.'],
  ],
  tags: ['speculative', 'latency', 'decoding', 'break-even'],
};

export const lessons: Lesson[] = [q6, q7, q8, q9, q10];
