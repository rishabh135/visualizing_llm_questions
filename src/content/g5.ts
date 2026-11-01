// Systems design (Q21-Q25).
import type { Lesson } from '../types';

const q21: Lesson = {
  id: 21,
  group: 'systems',
  short: 'Fair multi-tenancy',
  question:
    'Multiple customers share the same inference cluster. Design fair scheduling, admission control, and priority queues without letting one tenant ruin everyone else’s latency.',
  why: 'Shared clusters fail socially before they fail technically: one heavy tenant can starve everyone.',
  tldr: [
    'Charge fairness in tokens (compute), not requests: a 2,000-token request costs ten 200-token ones.',
    'Deficit round robin with weights gives each backlogged tenant its share; admission limits keep queues bounded.',
    'Weights bound shares, not latency: under arbitrary overload you must reject, shed or degrade.',
  ],
  plain:
    'Give every tenant its own queue. A scheduler hands out GPU work in proportion to tenant weights, counting tokens rather than requests. Rate limits and bounded queues reject excess work early so it never sits in front of someone else.',
  analogy: {
    name: 'Shared kitchen with order tickets',
    map: [
      ['Each restaurant chain has its own ticket rail', 'Per-tenant queue'],
      ['Chef cooks N minutes per chain per round', 'DRR quantum × weight (tokens)'],
      ['Banquet order of 200 plates', 'Long prompt / long output request'],
      ['Host stops seating when the rail is full', 'Admission control, bounded queue, 429'],
    ],
    breaks:
      'Chefs cook dishes independently; GPUs batch many tenants into one step, so one tenant’s long prefill still slows everyone’s decode unless chunked.',
  },
  example: {
    title: 'One DRR round, three tenants',
    inputs: 'A: weight 1, 200-token requests · B: weight 1, 2,000-token requests · C: weight 2, 400-token requests · quantum 200 tokens per weight',
    steps: [
      { label: 'Add credit', state: 'deficit A = 200, B = 200, C = 400' },
      { label: 'Serve A', state: 'A runs one 200-token request → deficit 0' },
      { label: 'Serve B', state: 'B runs 200 of its 2,000 tokens (preempt at token boundary) → deficit 0' },
      { label: 'Serve C', state: 'C runs one 400-token request → deficit 0' },
      { label: 'Round total', state: 'tokens A : B : C = 200 : 200 : 400 = 25 % : 25 % : 50 %' },
    ],
    output: 'Shares match weights 1 : 1 : 2 while all three are backlogged.',
    predict: {
      q: 'Under request-count round robin (one whole request per turn), what share of tokens does B get?',
      a: '2,000 / (200 + 2,000 + 400) ≈ 77 %. Counting requests rewards the tenant with the biggest requests.',
    },
  },
  scenes: [
    {
      id: 'q21-s1', title: 'One shared FIFO', objective: 'See a noisy neighbour block small requests.', duration: 18,
      narration: 'All tenants share one first-come queue. Tenant B submits a burst of huge batch jobs. Chat requests from tenant A land behind them and wait. Nothing is wrong with A, it is just behind B.',
      lanes: [
        { label: 'Shared queue', items: [{ label: 'B 4K', kind: 'error', at: 0.1 }, { label: 'B 4K', kind: 'error', at: 0.2 }, { label: 'B 4K', kind: 'error', at: 0.3 }, { label: 'A 200', kind: 'request', at: 0.5 }, { label: 'C 400', kind: 'request', at: 0.6 }] },
        { label: 'GPU', items: [{ label: 'serving B', kind: 'decode', at: 0.3 }] },
        { label: 'A latency', items: [{ label: 'p95 ↑ 100+ ticks', kind: 'error', at: 0.85 }] },
      ],
      equation: 'wait_A ≈ Σ work ahead / capacity',
      transition: 'B burst fills the shared queue ahead of A.', action: 'Pick the failure preset with FCFS.',
    },
    {
      id: 'q21-s2', title: 'Split queues per tenant', objective: 'Isolate tenants with their own bounded queues.', duration: 18,
      narration: 'Give each tenant its own queue with a cap. When B exceeds its cap or rate limit, new B requests get a fast rejection with retry advice. A and C never see B’s backlog.',
      lanes: [
        { label: 'Tenant A', items: [{ label: 'A 200', kind: 'request', at: 0.1 }, { label: 'A 200', kind: 'request', at: 0.2 }] },
        { label: 'Tenant B (cap 3)', items: [{ label: 'B 4K', kind: 'request', at: 0.1 }, { label: 'B 4K', kind: 'request', at: 0.2 }, { label: 'B 4K', kind: 'request', at: 0.3 }, { label: '429 retry', kind: 'error', at: 0.55, out: 0.85 }] },
        { label: 'Tenant C', items: [{ label: 'C 400', kind: 'request', at: 0.15 }] },
      ],
      equation: 'admit if in_system_B < cap_B and bucket_B ≥ 1',
      transition: 'Excess B work is rejected at the door, not queued.', action: 'Lower “Max requests in system” and watch B rejections rise.',
    },
    {
      id: 'q21-s3', title: 'Deficit round robin in tokens', objective: 'Show token-weighted service.', duration: 18,
      narration: 'Each round, every backlogged tenant earns quantum times weight in token credit. It may spend that credit on prefill or decode tokens. C has weight 2, so it earns twice as much. Shares converge to 25, 25 and 50 percent.',
      lanes: [
        { label: 'Credit', items: [{ label: 'A +200', kind: 'kv', at: 0.1 }, { label: 'B +200', kind: 'kv', at: 0.15 }, { label: 'C +400', kind: 'kv', at: 0.2 }] },
        { label: 'GPU tokens', items: [{ label: 'A 200', kind: 'decode', at: 0.4 }, { label: 'B 200', kind: 'prefill', at: 0.55 }, { label: 'C 400', kind: 'decode', at: 0.7 }] },
        { label: 'Share', items: [{ label: '25 / 25 / 50 %', kind: 'ok', at: 0.9 }] },
      ],
      equation: 'share_i → w_i / Σ_backlogged w_j',
      transition: 'Credits turn into proportional token service.', action: 'Compare Request RR vs Token DRR shares in the chart.',
    },
    {
      id: 'q21-s4', title: 'Priority without starvation', objective: 'Add priority classes and aging safely.', duration: 18,
      narration: 'Interactive traffic gets a higher weight or a strict class, but batch traffic ages: its effective priority grows with wait time. A guaranteed minimum share stops low priority work from starving. Priority must be authenticated, or every client will claim it.',
      lanes: [
        { label: 'Interactive', items: [{ label: 'chat', kind: 'request', at: 0.1 }, { label: 'chat', kind: 'request', at: 0.2 }] },
        { label: 'Batch', items: [{ label: 'job (aging)', kind: 'neutral', at: 0.1 }, { label: 'priority ↑', kind: 'kv', at: 0.6 }] },
        { label: 'Abuse', items: [{ label: 'fake “urgent”', kind: 'error', at: 0.75, out: 0.9 }] },
      ],
      equation: 'eff_priority = base + α × wait',
      transition: 'Batch job ages up; forged priority is rejected.', action: 'Raise tenant C weight and watch its p95 wait.',
    },
    {
      id: 'q21-s5', title: 'Memory and cache isolation', objective: 'Fair compute is not enough: isolate KV and caches.', duration: 18,
      narration: 'Each tenant also gets a KV block budget, so one tenant’s long contexts cannot evict everyone’s cache. Prefix caches are namespaced per tenant to avoid timing leaks. Under overload beyond total capacity, someone must be rejected.',
      lanes: [
        { label: 'KV pool', items: [{ label: 'A ■■', kind: 'kv', at: 0.1 }, { label: 'B ■■■■', kind: 'kv', at: 0.2 }, { label: 'B over budget', kind: 'error', at: 0.5, out: 0.7 }, { label: 'C ■■■', kind: 'kv', at: 0.3 }] },
        { label: 'Prefix cache', items: [{ label: 'ns:A', kind: 'comm', at: 0.6 }, { label: 'ns:B', kind: 'comm', at: 0.65 }, { label: 'ns:C', kind: 'comm', at: 0.7 }] },
        { label: 'Overload', items: [{ label: 'shed / degrade', kind: 'error', at: 0.9 }] },
      ],
      equation: 'Σ admitted work ≤ capacity, else reject',
      transition: 'KV budgets and cache namespaces separate tenants.', action: 'Try the stress preset: DRR protects A and C, B absorbs rejections.',
    },
  ],
  sim: {
    tldr: 'Same seeded arrival trace through FCFS, request round robin and token DRR; only the policy differs.',
    omits: [
      'Batching: one token budget per tick stands in for a GPU step; prefill and decode cost the same per token.',
      'KV memory budgets and prefix-cache isolation (described, not simulated).',
      'Client retries after rejection (a real source of amplification).',
      'Priority classes and aging; weights are the only priority mechanism here.',
    ],
  },
  formula: {
    name: 'Weighted deficit round robin (decision model)',
    tex: String.raw`\text{deficit}_i \mathrel{+}= Q \cdot w_i,\quad \text{share}_i \to \frac{w_i}{\sum_{j \in \text{backlogged}} w_j}`,
    vars: [
      ['Q', 'quantum per round', 'tokens'],
      ['w_i', 'weight of tenant i', '—'],
      ['deficit_i', 'unspent token credit of tenant i', 'tokens'],
      ['share_i', 'long-run fraction of served tokens', '—'],
    ],
    assumptions: ['All listed tenants stay backlogged', 'Work is preemptible at token boundaries', 'Cost per token is uniform'],
    substituted: 'w = 1, 1, 2 → shares = 1/4, 1/4, 2/4 = 25 %, 25 %, 50 %',
    check: 'tokens / tokens → dimensionless share; shares sum to 1 ✓',
    cue: 'Charge for tokens, cap the queue, age the waiters.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Share under DRR, w = 1:1:2, all backlogged', value: '25 / 25 / 50', unit: '%', assumptions: 'Token-preemptible', source: 'Engine test (g5.test.ts)', evidence: 'simulated' },
    { quantity: 'B token share under request RR, stress preset', value: '84', unit: '%', assumptions: 'Seed 11, 240 ticks', source: 'This simulator', evidence: 'simulated' },
    { quantity: 'Tenant A p95 wait, stress, FCFS vs DRR', value: '106 vs 0', unit: 'ticks', assumptions: 'Seed 11, capacity 1,400 tok/tick', source: 'This simulator', evidence: 'simulated' },
    { quantity: 'Real-cluster p95 TTFT per tenant', value: '—', unit: 'ms', assumptions: 'Needs production trace', source: 'Benchmark below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'One FIFO queue, per-request rate limits, priority header trusted from the client.',
    improved: 'Per-tenant bounded queues, token-weighted DRR with aging, per-tenant KV budgets, authenticated priority, fast 429s.',
    mechanism: 'Service is charged in tokens and isolated per tenant, so one tenant’s backlog only delays itself.',
    rows: [
      ['Small-tenant p95 under noisy neighbour', 'Grows with B’s backlog', 'Near its solo value'],
      ['Throughput', 'Work conserving', 'Work conserving'],
      ['Fairness unit', 'Requests', 'Tokens (≈ GPU time)'],
      ['Complexity', 'Trivial', 'Scheduler + accounting + quotas'],
    ],
  },
  lab: {
    title: 'Token DRR in 25 lines', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 drr.py'], lang: 'python',
    code: `from collections import deque
def drr(queues, weights, quantum, budget):
    """queues: list of deques of token counts. Returns tokens served per tenant."""
    served, deficit = [0] * len(queues), [0] * len(queues)
    while budget > 0 and any(queues):
        for i, q in enumerate(queues):
            if not q: deficit[i] = 0; continue
            deficit[i] += quantum * weights[i]
            while q and deficit[i] > 0 and budget > 0:
                amt = min(q[0], deficit[i], budget)
                q[0] -= amt; deficit[i] -= amt; budget -= amt; served[i] += amt
                if q[0] == 0: q.popleft()
    return served

qs = [deque([200] * 500), deque([2000] * 50), deque([400] * 250)]
s = drr(qs, [1, 1, 2], 200, 80_000)
assert sum(s) == 80_000                      # work conserving
assert [round(x / 80_000, 2) for x in s] == [0.25, 0.25, 0.5]
print(s)`,
    checks: ['Total served equals budget while backlogged', 'Shares 25/25/50 for weights 1:1:2', 'Empty queue resets its deficit'],
    gaps: 'No admission control, aging, KV budgets, or batching; a real scheduler charges measured cost per prefill/decode token.',
  },
  bench: {
    hypothesis: 'Token DRR keeps tenant A’s p95 TTFT within 1.5× of its solo value while tenant B floods at 3× its quota.',
    baseline: 'Same engine with one shared FCFS queue.',
    controlled: ['Model, engine version, GPU', 'Seeded open-loop arrival trace per tenant', 'Prompt/output length distributions', 'Quotas and weights'],
    workload: 'A: chat 200/150 tokens at 5 RPS; B: 4K/1K batch ramping 1→3× quota; C: 400/300 at 2 RPS.',
    warmup: '2 min at nominal load, discarded.', reps: '5 runs × 10 min per policy.',
    method: 'Client-side TTFT and token gaps per tenant; server rejections; served tokens from engine counters.',
    metrics: ['p50/p95/p99 TTFT per tenant', 'Served token share', '429 rate per tenant', 'Total goodput'],
    interpret: 'Success if A and C tails stay near solo while B absorbs rejections and total goodput does not drop.',
  },
  pitfalls: [
    'Fairness by request count: long-request tenants silently take most of the GPU.',
    'Unbounded per-tenant queues: rejections become timeouts minutes later.',
    'Trusting a client-supplied priority header: everyone becomes “urgent”.',
    'Shared prefix cache across tenants: cross-tenant timing side channel and eviction storms.',
  ],
  optimizations: [
    ['Cost model per token type (prefill vs decode, context length)', 'More accurate fairness; needs calibration per model and GPU.'],
    ['Aging for low-priority work', 'Prevents starvation; weakens strict priority guarantees.'],
    ['Per-tenant KV block budgets', 'Stops cache eviction storms; may leave memory idle unless borrowable.'],
  ],
  breaks: [
    'Sum of guaranteed shares exceeds capacity: weights cannot create GPUs; something must be rejected.',
    'One request is huge (100K-token prefill): without chunking it blocks a whole batch step regardless of weights.',
  ],
  interview: {
    short:
      'I separate three problems: who gets in, who goes next, and what each tenant may hold. Admission: every tenant has a token-bucket rate limit and a bounded queue measured in tokens, so excess work gets a fast 429 with Retry-After instead of waiting in front of others. Scheduling: per-tenant queues feeding a weighted deficit round robin that charges in tokens, ideally a calibrated cost per prefill and decode token, because request counts reward tenants with huge requests. Interactive traffic gets a higher weight or class, and batch work ages so it cannot starve. Resources: per-tenant KV block budgets and namespaced prefix caches so one tenant cannot evict or observe another. Priority is set by the platform from authenticated identity, never by a client header. I would prove it with a seeded noisy-neighbour test: tenant B floods at three times quota and I check that A and C keep p95 TTFT near their solo baseline while total goodput holds. I would also say clearly that weights bound shares, not latency: when total demand exceeds capacity the system must shed, degrade or reject.',
    whiteboard: [
      'Draw admission → per-tenant queues → DRR → batcher → GPU.',
      'Work one DRR round with weights 1:1:2 in tokens.',
      'Show request-RR giving B ≈ 77 % with 2K-token requests.',
      'Add KV budget per tenant and cache namespaces.',
      'State the overload rule: reject, shed, or degrade.',
    ],
    followups: [
      ['Why not strict priority for premium tenants?', 'Strict priority starves lower classes under sustained premium load; use weights plus a minimum share and aging.'],
      ['How do you charge prefill vs decode?', 'Calibrate cost per token type from profiling (prefill tokens are cheaper per token in large batches; decode costs memory bandwidth) and charge both against the deficit.'],
      ['What if tenants retry rejected requests immediately?', 'Return Retry-After, apply exponential backoff in SDKs, and count retries against the same bucket to avoid amplification.'],
    ],
    debug: [
      'Tenant A’s p99 TTFT spikes every night at 02:00 even though DRR shares look correct. What do you check?',
      'A nightly batch tenant with 100K-token prompts: each unchunked prefill blocks a full step. Check prefill lengths and enable chunked prefill with a per-step token cap.',
    ],
    calc: [
      'Weights 1:1:2, capacity 1,400 tokens/tick, all backlogged. Tokens per tick for C?',
      '1,400 × 2/4 = 700 tokens per tick.',
    ],
  },
  changeMind: [
    'Contracts require hard latency SLOs per tenant → dedicated capacity or reservations, not shared weights.',
    'Measured prefill/decode cost ratio differs a lot from 1 → switch to a calibrated cost model.',
    'Tenant mix is one dominant tenant → simpler quota plus overflow pool may be enough.',
  ],
  recall: [
    ['Fairness unit?', 'Tokens or measured GPU cost, not requests.'],
    ['What do bounded queues buy?', 'Fast rejection instead of hidden waiting in front of others.'],
    ['Do weights guarantee latency?', 'No. They bound shares; overload needs rejection or degradation.'],
  ],
  glossary: [
    ['DRR', 'Deficit round robin: each queue earns credit per round and spends it on work, giving weighted shares.'],
    ['FCFS', 'First-come, first-served: one global arrival-order queue.'],
    ['Noisy neighbour', 'A tenant whose load degrades other tenants on shared hardware.'],
    ['Admission control', 'Deciding at arrival whether to accept work, based on quotas and capacity.'],
    ['429', 'HTTP “Too Many Requests”; a fast, explicit rejection with retry guidance.'],
  ],
  tags: ['fairness', 'multi-tenant', 'scheduling', 'admission', 'drr', 'priority'],
};

const q22: Lesson = {
  id: 22,
  group: 'systems',
  short: 'Disaggregated P/D',
  question:
    'Explain disaggregated prefill and decode. When is transferring KV cache between separate GPU pools worth the overhead?',
  why: 'Prefill is compute-bound and decode is bandwidth-bound; mixing them on one GPU hurts both SLOs.',
  tldr: [
    'Prefill pool builds the KV cache; it is shipped to a decode pool that only generates tokens.',
    'Cost: KV bytes ÷ effective link bandwidth, minus what overlaps with prefill. 8K tokens = 2.5 GiB here.',
    'Worth it when removed decode interference × output tokens beats the exposed transfer time.',
  ],
  plain:
    'Prefill crunches the whole prompt at once and hogs compute; decode emits one token at a time and needs memory bandwidth. Running both on the same GPUs makes decode stutter whenever a prefill arrives. Disaggregation runs them on separate pools and pays to move the KV cache between them.',
  analogy: {
    name: 'Kitchen prep line and plating line',
    map: [
      ['Prep cooks chop everything for an order', 'Prefill pool processes the prompt'],
      ['Tray of prepped ingredients', 'KV cache of the request'],
      ['Cart rolling trays to the plating line', 'RDMA / NVLink transfer of KV'],
      ['Plating line serves one plate at a time', 'Decode pool emits tokens'],
    ],
    breaks:
      'A cart moves one tray at a time with no size limit; KV transfer competes for shared link bandwidth and must match memory layouts and ownership.',
  },
  example: {
    title: '8K-token prompt, 512 output tokens',
    inputs: 'KV 320 KiB/token (70B BF16, assumed), link 50 GB/s effective, setup 2 ms, 80 % per-layer overlap, prefill 20,000 tok/s, ITL 30 ms isolated, +30 % when co-located',
    steps: [
      { label: 'KV bytes', state: '8,192 × 327,680 B = 2,684,354,560 B = 2.5 GiB' },
      { label: 'Raw transfer', state: '2.684e9 B ÷ 50e9 B/s = 53.7 ms' },
      { label: 'Overlap', state: 'prefill = 8,192 ÷ 20,000 = 409.6 ms; hides min(0.8 × 53.7, 409.6) = 42.9 ms' },
      { label: 'Exposed', state: '2 ms setup + 53.7 − 42.9 = 12.7 ms (delays token 2)' },
      { label: 'Decode gain', state: '511 gaps × (39 − 30) ms = 4.6 s saved' },
    ],
    output: 'Disaggregated E2E ≈ 15.75 s vs monolithic ≈ 20.34 s; TTFT unchanged at 409.6 ms.',
    predict: {
      q: 'Make it a 32K prompt, 16 output tokens, a 5 GB/s TCP link and only +5 % interference. Who wins?',
      a: 'Monolithic. 10 GiB takes 2,147 ms raw; 511 ms stays exposed, but decode only saves 15 × 1.5 = 22.5 ms. Disaggregation loses by ≈ 0.49 s.',
    },
  },
  scenes: [
    {
      id: 'q22-s1', title: 'Interference on one GPU', objective: 'See prefill stall co-located decode.', duration: 18,
      narration: 'On a monolithic server, decode requests emit a token every step. A long prefill arrives and takes the whole step. Every decoding user sees a gap. Inter-token latency spikes even though nothing failed.',
      lanes: [
        { label: 'GPU steps', items: [{ label: 'decode', kind: 'decode', at: 0.05 }, { label: 'decode', kind: 'decode', at: 0.15 }, { label: 'PREFILL 8K', kind: 'prefill', at: 0.35 }, { label: 'decode', kind: 'decode', at: 0.65 }] },
        { label: 'User token gaps', items: [{ label: '30 ms', kind: 'ok', at: 0.1 }, { label: '30 ms', kind: 'ok', at: 0.2 }, { label: '440 ms spike', kind: 'error', at: 0.6 }] },
      ],
      equation: 'ITL_mono = ITL × (1 + interference)',
      transition: 'One prefill interrupts the decode cadence.', action: 'Set “Decode slowdown when co-located” to 0 and see the benefit vanish.',
    },
    {
      id: 'q22-s2', title: 'Split the pools', objective: 'Separate prefill and decode onto different GPUs.', duration: 18,
      narration: 'Now a prefill pool only runs prompts and emits the first token. A decode pool only generates. Each pool can use its own batch size, parallelism and even GPU type.',
      lanes: [
        { label: 'Prefill pool', items: [{ label: 'P 8K', kind: 'prefill', at: 0.1 }, { label: 'P 2K', kind: 'prefill', at: 0.3 }, { label: 'token 1', kind: 'request', at: 0.5 }] },
        { label: 'Decode pool', items: [{ label: 'decode', kind: 'decode', at: 0.2 }, { label: 'decode', kind: 'decode', at: 0.4 }, { label: 'decode', kind: 'decode', at: 0.6 }, { label: 'steady 30 ms', kind: 'ok', at: 0.8 }] },
      ],
      equation: 'TTFT ≈ prefill; token 2 waits for KV',
      transition: 'Pools specialise; decode cadence stays flat.', action: 'Compare the two bars in the timeline chart.',
    },
    {
      id: 'q22-s3', title: 'Move the KV cache', objective: 'Count the bytes that must cross the link.', duration: 18,
      narration: 'The decode pool needs the request’s KV cache. For 8K tokens that is 2.5 GiB at 320 KiB per token. At 50 GB/s effective it takes 54 ms. Sending layer by layer during prefill hides most of it.',
      lanes: [
        { label: 'Prefill layers', items: [{ label: 'L1-20', kind: 'prefill', at: 0.1 }, { label: 'L21-40', kind: 'prefill', at: 0.3 }, { label: 'L41-60', kind: 'prefill', at: 0.5 }, { label: 'L61-80', kind: 'prefill', at: 0.7 }] },
        { label: 'Link', items: [{ label: 'KV L1-20', kind: 'comm', at: 0.3 }, { label: 'KV L21-40', kind: 'comm', at: 0.5 }, { label: 'KV L41-60', kind: 'comm', at: 0.7 }, { label: 'KV L61-80 (exposed)', kind: 'comm', at: 0.9 }] },
      ],
      equation: 'exposed = setup + bytes/BW − min(overlap·bytes/BW, T_prefill)',
      transition: 'Per-layer chunks stream while later layers compute.', action: 'Drag “Per-layer overlap” to 0 %.',
    },
    {
      id: 'q22-s4', title: 'Shared link contention', objective: 'Show many transfers dividing one link.', duration: 18,
      narration: 'Transfers share links. With 16 prompts finishing together, each sees one sixteenth of the bandwidth. Exposed transfer time jumps from milliseconds to hundreds of milliseconds and the queue builds.',
      lanes: [
        { label: 'Link queue', items: [{ label: 'xfer 1', kind: 'comm', at: 0.1 }, { label: 'xfer 2', kind: 'comm', at: 0.2 }, { label: '…', kind: 'neutral', at: 0.3 }, { label: 'xfer 16', kind: 'comm', at: 0.4 }] },
        { label: 'Per-transfer BW', items: [{ label: '50 GB/s', kind: 'ok', at: 0.05, out: 0.45 }, { label: '3.1 GB/s', kind: 'error', at: 0.5 }] },
        { label: 'Decode pool', items: [{ label: 'waiting for KV', kind: 'error', at: 0.75 }] },
      ],
      equation: 'BW_each = BW_eff / N_concurrent',
      transition: 'Bandwidth per transfer collapses under fan-in.', action: 'Try the stress preset.',
    },
    {
      id: 'q22-s5', title: 'Find the break-even', objective: 'Decide with numbers, not fashion.', duration: 18,
      narration: 'Disaggregation wins when the decode slowdown it removes, times the number of output tokens, beats the exposed transfer. Short outputs, slow links or little interference flip the answer. Measure both on your workload.',
      lanes: [
        { label: 'Wins', items: [{ label: 'long outputs', kind: 'ok', at: 0.1 }, { label: 'fast RDMA/NVLink', kind: 'ok', at: 0.2 }, { label: 'strict ITL SLO', kind: 'ok', at: 0.3 }] },
        { label: 'Loses', items: [{ label: '16-token outputs', kind: 'error', at: 0.5 }, { label: '5 GB/s TCP', kind: 'error', at: 0.6 }, { label: 'idle decode pool', kind: 'error', at: 0.7 }] },
        { label: 'Decision', items: [{ label: 'measure Δ E2E', kind: 'kv', at: 0.9 }] },
      ],
      equation: 'win if exposed < (N−1)(ITL_mono − ITL_disagg)',
      transition: 'Trade-off lists resolve into one inequality.', action: 'Pick the failure preset and read the Δ line.',
    },
  ],
  sim: {
    tldr: 'One request’s end-to-end time, monolithic vs disaggregated, from the same disagg() function; the sweep finds the break-even prompt length.',
    omits: [
      'Queueing and batching inside each pool; one request is modelled.',
      'Pool sizing imbalance (idle prefill or decode GPUs) and its cost.',
      'KV layout conversion, failures and retransmits, ownership handoff.',
      'Prefill and decode pools using different tensor-parallel layouts.',
    ],
  },
  formula: {
    name: 'KV transfer and break-even',
    tex: String.raw`T_{\text{exp}} = t_{\text{setup}} + \frac{B_{kv}}{BW/N} - \min\!\Big(\alpha \tfrac{B_{kv}}{BW/N},\ T_{\text{prefill}}\Big),\quad \text{win if } T_{\text{exp}} < (N_{out}-1)\,\Delta_{ITL}`,
    vars: [
      ['B_kv', 'KV bytes = 320 KiB × cached tokens (assumed 70B BF16)', 'B'],
      ['BW', 'effective link bandwidth', 'B/s'],
      ['N', 'concurrent transfers sharing the link', '—'],
      ['α', 'fraction overlappable with prefill', '—'],
      ['N_out', 'output tokens', 'tokens'],
      ['Δ_ITL', 'decode slowdown removed by isolation', 's/token'],
    ],
    assumptions: ['Prefill pool emits token 1', 'Interference is a constant fractional slowdown', 'No transfer failures'],
    substituted: '2 ms + 53.7 ms − 42.9 ms = 12.7 ms < 511 × 9 ms = 4.6 s → disaggregate',
    check: 'B ÷ (B/s) = s; tokens × s/token = s ✓',
    cue: 'Bytes over the wire must cost less than the stutter they remove.',
  },
  estimates: [
    { quantity: 'KV for 8K prompt (70B BF16)', value: '2.5', unit: 'GiB', assumptions: '320 KiB/token', source: 'Q3 formula', evidence: 'calculated' },
    { quantity: 'Raw transfer at 50 GB/s', value: '53.7', unit: 'ms', assumptions: 'No contention', source: 'Formula above', evidence: 'calculated' },
    { quantity: '400 Gb/s NIC line rate', value: '50', unit: 'GB/s (decimal)', assumptions: 'Before protocol overhead', source: 'Line-rate arithmetic (400 / 8)', evidence: 'vendor spec' },
    { quantity: 'Decode slowdown when co-located', value: '30', unit: '%', assumptions: 'Teaching input; workload-specific', source: 'Assumption — measure it', evidence: 'assumed' },
    { quantity: 'Measured break-even prompt on your cluster', value: '—', unit: 'tokens', assumptions: 'Needs both deployments', source: 'Benchmark below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Monolithic replicas run prefill and decode in the same batches.',
    improved: 'Separate prefill and decode pools, per-layer streamed KV transfer over RDMA, independent scaling and SLOs.',
    mechanism: 'Removes prefill-decode interference so ITL stays flat; pays exposed KV transfer once per request.',
    rows: [
      ['TTFT', 'Prefill (+ queue behind decode)', 'Prefill (dedicated pool)'],
      ['ITL tail', 'Spikes when prefills land', 'Flat; set by decode batch'],
      ['Extra cost', 'None', 'KV bytes over network, more pools to balance'],
      ['Complexity', 'Low', 'High: transfer, ownership, failure handling'],
    ],
  },
  lab: {
    title: 'Production protocol for a disaggregation trial', kind: 'protocol', file: 'labs/PROTOCOL.md',
    deps: 'An engine with P/D disaggregation support, two GPU pools, RDMA-capable network',
    commands: ['open labs/PROTOCOL.md', 'python3 disagg_calc.py   # break-even sanity check below'], lang: 'python',
    code: `KV_PER_TOKEN = 2 * 80 * 8 * 128 * 2   # 327,680 B, assumed 70B BF16
def exposed_ms(prompt, gbps, n=1, setup=2.0, overlap=0.8, prefill_tps=20_000):
    raw = prompt * KV_PER_TOKEN / (gbps * 1e9 / n) * 1e3
    return setup + raw - min(overlap * raw, prompt / prefill_tps * 1e3)
def gain_ms(out_tokens, itl=30.0, interference=0.3):
    return (out_tokens - 1) * itl * interference

assert abs(exposed_ms(8192, 50) - 12.74) < 0.01
assert gain_ms(512) > exposed_ms(8192, 50)                          # disaggregate
assert gain_ms(16, interference=0.05) < exposed_ms(32768, 5)        # stay monolithic`,
    checks: ['8K / 50 GB/s → 12.74 ms exposed', 'Normal case favours disaggregation', 'Failure case favours monolithic'],
    gaps: 'Arithmetic only; the protocol file covers layout conversion, backpressure, ownership handoff and failure tests on real GPUs.',
  },
  bench: {
    hypothesis: 'At the target ITL SLO, disaggregated P/D delivers more goodput per GPU than monolithic for our prompt/output mix.',
    baseline: 'Monolithic replicas with chunked prefill on the same total GPU count.',
    controlled: ['Model, precision, engine version', 'Total GPUs and topology', 'Seeded open-loop arrival trace', 'Prompt/output length distribution'],
    workload: 'Production-shaped trace; sweep prompt length buckets 1K–64K and output 16–1K.',
    warmup: '5 min, discarded.', reps: '3 runs per configuration and P:D ratio.',
    method: 'Client TTFT and token gaps; engine KV transfer spans; link utilisation from NIC counters.',
    metrics: ['Goodput at ITL/TTFT SLO', 'p99 ITL', 'Exposed transfer p50/p99', 'Link utilisation'],
    interpret: 'Plot Δ goodput vs prompt bucket; the zero crossing is the measured break-even. Report P:D ratio used.',
  },
  pitfalls: [
    'Treating KV transfer as free: 2.5 GiB per 8K request is real link time.',
    'Ignoring fan-in: many prefills finishing together divide the link.',
    'Mis-sized pools: one side idles while the other queues, erasing the gain.',
    'Freeing prefill-side KV before the decode side confirms receipt (ownership bug).',
  ],
  optimizations: [
    ['Per-layer streaming during prefill', 'Hides most transfer; needs layout-compatible chunks and ordering.'],
    ['FP8 KV for transfer and storage', 'Halves bytes; must be validated for quality.'],
    ['Dynamic P:D ratio with backpressure', 'Balances pools; adds control-plane complexity.'],
  ],
  breaks: [
    'Short outputs (tens of tokens): little decode time to protect.',
    'Slow or shared network (TCP, oversubscribed spine): exposed transfer dominates.',
  ],
  interview: {
    short:
      'Prefill processes the whole prompt in parallel and is compute-bound; decode produces one token per step and is memory-bandwidth-bound. On shared GPUs a long prefill steals a whole step, so decoding users see inter-token latency spikes. Disaggregation runs prefill and decode on separate pools: the prefill pool emits the first token and ships the KV cache to a decode pool. The price is moving KV bytes. For the assumed 70B in BF16 that is 320 KiB per token, so an 8K prompt is 2.5 GiB; at 50 GB/s effective that is about 54 ms, and streaming layer by layer during prefill hides most of it, leaving roughly 13 ms exposed. It pays off when the slowdown it removes times the number of output tokens exceeds the exposed transfer: here 511 gaps × 9 ms ≈ 4.6 s versus 13 ms. It loses for short outputs, slow or contended links, or when chunked prefill already keeps interference low. I would prove it with a controlled trace at equal GPU count, measuring goodput at SLO per prompt bucket, plus link utilisation and failure handling.',
    whiteboard: [
      'Draw prefill pool → link → decode pool; mark token 1 and token 2.',
      'Compute KV bytes for 8K tokens: 2.5 GiB.',
      'Transfer time and overlap; exposed ≈ 12.7 ms.',
      'Write the break-even inequality and plug both cases.',
      'List operational costs: pool balance, ownership, failures.',
    ],
    followups: [
      ['Does disaggregation improve TTFT?', 'Only indirectly: prefill no longer waits behind decode batches. Transfer delays token 2, not token 1, if the prefill pool emits token 1.'],
      ['How does chunked prefill compare?', 'Chunking bounds interference on monolithic GPUs at some efficiency cost; it is the baseline disaggregation must beat.'],
      ['What if TP differs between pools?', 'KV head sharding differs, so transfer must re-shard or convert layouts, adding time and complexity.'],
    ],
    debug: [
      'After enabling disaggregation, p99 ITL improved but p99 time-to-second-token got 400 ms worse at peak. Why?',
      'Link fan-in: many transfers at once divide bandwidth. Check NIC utilisation and concurrent transfers; add per-layer streaming, FP8 KV, or more links.',
    ],
    calc: [
      'FP8 KV, 16K prompt, 100 GB/s, no overlap, 1 ms setup. Exposed transfer?',
      '16,384 × 163,840 B = 2.684e9 B ÷ 100e9 = 26.8 ms + 1 ms ≈ 27.8 ms.',
    ],
  },
  changeMind: [
    'Measured interference with chunked prefill is already < 5 %.',
    'Output lengths are mostly < 50 tokens.',
    'Network is oversubscribed or lacks RDMA.',
  ],
  recall: [
    ['Which phase is bandwidth-bound?', 'Decode.'],
    ['KV bytes for 8K tokens, 70B BF16?', '2.5 GiB.'],
    ['Break-even rule?', 'Exposed transfer < (N_out − 1) × ITL slowdown removed.'],
  ],
  glossary: [
    ['Disaggregation (P/D)', 'Running prefill and decode on separate GPU pools.'],
    ['RDMA', 'Remote direct memory access: network transfer into GPU/host memory without CPU copies.'],
    ['ITL', 'Inter-token latency: gap between consecutive streamed tokens.'],
    ['Exposed transfer', 'Part of KV transfer not hidden under prefill compute.'],
  ],
  tags: ['disaggregation', 'prefill', 'decode', 'kv transfer', 'rdma', 'latency'],
};

const q23: Lesson = {
  id: 23,
  group: 'systems',
  short: 'MoE parallelism',
  question:
    'You’re serving a large MoE model. Choose between tensor, pipeline, and expert parallelism, and explain how all-to-all communication affects performance.',
  why: 'MoE stores many parameters but uses few per token; placement and routing decide speed.',
  tldr: [
    'Store all experts, compute only top-k per token: active params = shared + experts × k/E.',
    'Expert parallelism shards experts and pays two all-to-alls per MoE layer (dispatch and combine).',
    'Routing skew makes the hottest device set step time; capacity limits trade drops for balance.',
  ],
  plain:
    'A mixture-of-experts layer has many feed-forward “experts”, and a router sends each token to its top few. If experts live on different GPUs, tokens must travel to their experts and back. That all-to-all traffic and uneven expert popularity usually decide performance.',
  analogy: {
    name: 'Hospital specialists across buildings',
    map: [
      ['Patients (tokens) in two buildings', 'Tokens on each GPU'],
      ['Triage nurse picks 2 specialists', 'Router picks top-2 experts'],
      ['Shuttle between buildings', 'All-to-all dispatch and combine'],
      ['Specialist with a full waiting room', 'Hot expert at capacity'],
    ],
    breaks:
      'Patients wait individually; GPUs wait for the slowest device in a synchronous step, so one hot expert delays everyone.',
  },
  example: {
    title: '8 tokens, 4 experts, top-2, 2 devices',
    inputs: 'Tokens T0–T3 on device 0, T4–T7 on device 1; experts E0–E1 on device 0, E2–E3 on device 1; capacity factor 1.25; d_model 4,096; BF16',
    steps: [
      { label: 'Assignments', state: '8 tokens × top-2 = 16 token-expert pairs' },
      { label: 'Capacity', state: 'ceil(1.25 × 16 / 4) = 5 slots per expert' },
      { label: 'Route (seed 4)', state: 'loads E0..E3 = 2, 5, 4, 5 → 0 dropped' },
      { label: 'Cross-device', state: '5 pairs need the other device' },
      { label: 'Bytes', state: '5 × 4,096 × 2 B × 2 (dispatch + combine) = 81,920 B = 80 KiB' },
    ],
    output: 'Device loads 7 vs 9 → imbalance 1.125×; the busier device sets the step time.',
    predict: {
      q: 'Add router skew 3 toward E0 and cut the capacity factor to 1.0. What happens?',
      a: 'Capacity falls to 4; E0 fills and 4 assignments are dropped (or rerouted, depending on policy). Fewer bytes move, but quality can suffer.',
    },
  },
  scenes: [
    {
      id: 'q23-s1', title: 'Total vs active parameters', objective: 'Separate memory from per-token compute.', duration: 18,
      narration: 'This illustrative MoE stores 47 billion parameters: 2 billion shared and 45 billion across 8 experts. Each token uses only 2 experts. So it computes with about 13 billion parameters but must store all 47.',
      lanes: [
        { label: 'Stored', items: [{ label: 'shared 2B', kind: 'prefill' }, { label: 'E0..E7 45B', kind: 'kv', at: 0.2 }] },
        { label: 'Used per token', items: [{ label: 'shared 2B', kind: 'prefill', at: 0.5 }, { label: '2 experts 11.25B', kind: 'decode', at: 0.65 }] },
        { label: 'Active', items: [{ label: '≈ 13.25B', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'active = shared + experts × k / E = 2 + 45 × 2/8',
      transition: 'Memory and compute split apart.', action: 'Read the active/total stat in the simulator.',
    },
    {
      id: 'q23-s2', title: 'Router picks top-2', objective: 'Show token-to-expert assignment and capacity.', duration: 18,
      narration: 'The router scores each token against each expert and keeps the top two. Each expert has a fixed number of slots for the step. Popular experts fill up first.',
      lanes: [
        { label: 'Tokens', items: [{ label: 'T0', kind: 'request' }, { label: 'T1', kind: 'request' }, { label: 'T2', kind: 'request' }, { label: 'T3', kind: 'request' }] },
        { label: 'E0 (cap 5)', items: [{ label: 'T0', kind: 'decode', at: 0.2 }, { label: 'T5', kind: 'decode', at: 0.4 }] },
        { label: 'E1 (cap 5)', items: [{ label: 'T0', kind: 'decode', at: 0.25 }, { label: 'T1', kind: 'decode', at: 0.35 }, { label: 'T2', kind: 'decode', at: 0.45 }, { label: 'T3', kind: 'decode', at: 0.55 }, { label: 'T6', kind: 'decode', at: 0.65 }] },
        { label: 'E1 overflow', items: [{ label: 'T7 dropped', kind: 'error', at: 0.85 }] },
      ],
      equation: 'capacity = ceil(cf × T × k / E)',
      transition: 'Slots fill; the next token overflows.', action: 'Lower the capacity factor slider.',
    },
    {
      id: 'q23-s3', title: 'All-to-all dispatch and combine', objective: 'Count bytes that cross devices.', duration: 18,
      narration: 'With expert parallelism, a token whose expert lives on another GPU sends its hidden vector there, then the result comes back. That is two all-to-alls per MoE layer. For 4,096 tokens on 8 GPUs it is about 14 MiB per device per layer.',
      lanes: [
        { label: 'Device 0', items: [{ label: 'T1 → E3', kind: 'comm', at: 0.2 }, { label: 'T2 → E2', kind: 'comm', at: 0.3 }] },
        { label: 'Device 1', items: [{ label: 'T5 → E0', kind: 'comm', at: 0.35 }, { label: 'T6 → E1', kind: 'comm', at: 0.45 }] },
        { label: 'Combine', items: [{ label: 'results back', kind: 'comm', at: 0.7 }, { label: '2 × per layer', kind: 'kv', at: 0.85 }] },
      ],
      equation: 'a2a ≈ 2 × (T·k/D) × d × b × (D−1)/D',
      transition: 'Hidden states cross devices and return.', action: 'Change devices to 16 and compare comm bars.',
    },
    {
      id: 'q23-s4', title: 'Hot experts and stragglers', objective: 'Show skew turning into step time.', duration: 18,
      narration: 'If the router favours one expert, its device gets more tokens. All devices wait for the slowest in each synchronous step. Capacity limits cap the damage by dropping or rerouting tokens, which can change outputs.',
      lanes: [
        { label: 'Device 0 load', items: [{ label: '■■■■■■■', kind: 'error', at: 0.2 }] },
        { label: 'Device 1 load', items: [{ label: '■■■■', kind: 'decode', at: 0.2 }, { label: 'idle', kind: 'neutral', at: 0.5 }] },
        { label: 'Policy', items: [{ label: 'drop 4 tokens', kind: 'error', at: 0.7 }, { label: 'quality check', kind: 'kv', at: 0.85 }] },
      ],
      equation: 'step time ∝ max device load',
      transition: 'Imbalance appears, then capacity clips it.', action: 'Pick the failure preset.',
    },
    {
      id: 'q23-s5', title: 'Choose a layout', objective: 'Compare TP, PP, EP and hybrid.', duration: 18,
      narration: 'Tensor parallelism splits every matrix and pays all-reduces every layer. Pipeline parallelism splits layers and pays bubbles. Expert parallelism shards experts and pays all-to-all. Most large deployments mix tensor parallel attention with expert parallel feed-forward inside a fast NVLink domain.',
      lanes: [
        { label: 'TP', items: [{ label: '10.9 GiB', kind: 'kv', at: 0.1 }, { label: '112 MiB comm', kind: 'comm', at: 0.2 }] },
        { label: 'PP', items: [{ label: '10.9 GiB', kind: 'kv', at: 0.3 }, { label: 'bubble 47 %', kind: 'error', at: 0.4 }] },
        { label: 'EP', items: [{ label: '14.2 GiB', kind: 'kv', at: 0.5 }, { label: '14 MiB a2a', kind: 'comm', at: 0.6 }] },
        { label: 'Hybrid', items: [{ label: 'TP attn + EP FFN', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'choose min step time subject to memory fit',
      transition: 'Four layouts, four cost profiles.', action: 'Raise microbatches and watch the PP bubble shrink.',
    },
  ],
  sim: {
    tldr: 'A seeded top-2 router on 8 tokens feeds the same imbalance into a first-order comparison of TP, PP, EP and hybrid on an illustrative 47B MoE.',
    omits: [
      'Real attention and FFN compute times; only memory, bytes and imbalance are modelled.',
      'Topology: NVLink vs inter-node links have very different bandwidth.',
      'Token rerouting policies (second choice, auxiliary balancing loss).',
      'Activation layout differences (TP replicates activations, EP usually pairs with data-parallel attention).',
    ],
  },
  formula: {
    name: 'MoE active parameters and all-to-all bytes',
    tex: String.raw`P_{active} = P_{shared} + P_{experts}\frac{k}{E},\qquad B_{a2a} \approx 2\cdot\frac{T k}{D}\cdot d \cdot b \cdot \frac{D-1}{D}`,
    vars: [
      ['P_shared', 'attention, embeddings, router params', 'params'],
      ['P_experts', 'all expert params', 'params'],
      ['k, E', 'experts per token, total experts', '—'],
      ['T', 'tokens per step', 'tokens'],
      ['D', 'devices in the EP group', '—'],
      ['d, b', 'hidden size, bytes per element', 'elements, B'],
    ],
    assumptions: ['Uniform routing for the byte estimate', 'Dispatch and combine move equal bytes', 'Illustrative config, not a specific model'],
    substituted: '2 × (4,096 × 2 / 8) × 4,096 × 2 B × 7/8 = 14 MiB per device per MoE layer; P_active = 2 + 45 × 2/8 = 13.25B',
    check: 'tokens × elements × B/element = B ✓',
    cue: 'Store all, compute k, ship twice, wait for the hottest.',
  },
  estimates: [
    { quantity: 'Active params, illustrative MoE', value: '13.25', unit: 'B', assumptions: '2B shared, 45B experts, top-2 of 8', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Weights per device, EP over 8', value: '14.2', unit: 'GiB', assumptions: 'BF16, shared replicated', source: 'moeParallel()', evidence: 'calculated' },
    { quantity: 'All-to-all per device per layer', value: '14', unit: 'MiB', assumptions: '4,096 tokens, d = 4,096, BF16', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'PP bubble, 8 stages, 8 microbatches', value: '46.7', unit: '%', assumptions: 'GPipe-style schedule', source: '(D−1)/(m+D−1)', evidence: 'calculated' },
    { quantity: 'All-to-all time on your fabric', value: '—', unit: 'ms', assumptions: 'Depends on topology', source: 'Benchmark below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Treat the MoE like a dense model: tensor-parallel everything across nodes.',
    improved: 'Expert parallel FFN within a fast domain, TP for attention, capacity factor and balancing tuned, hot experts replicated.',
    mechanism: 'Shards the large expert weights without all-reducing them every layer; only routed tokens move.',
    rows: [
      ['Memory per device', 'total / D', 'shared/D + experts/D'],
      ['Comm per layer', 'All-reduce of full activations', 'All-to-all of routed tokens'],
      ['Sensitivity to skew', 'Low', 'High — needs balancing'],
      ['Quality risk', 'None', 'Token drops if capacity too tight'],
    ],
  },
  lab: {
    title: 'Top-2 router with capacity, in NumPy', kind: 'cpu', deps: 'Python 3.10+, numpy',
    commands: ['pip install numpy', 'python3 moe_route.py'], lang: 'python',
    code: `import math, numpy as np
rng = np.random.default_rng(4)
T, E, K, D, cf, d, b = 8, 4, 2, 2, 1.25, 4096, 2
cap = math.ceil(cf * T * K / E)
logits = rng.random((T, E)) * 2
load, dropped, remote = np.zeros(E, int), 0, 0
for t in range(T):
    for e in np.argsort(-logits[t])[:K]:
        if load[e] >= cap: dropped += 1; continue
        load[e] += 1
        remote += (e * D // E) != (t * D // T)
assert load.sum() + dropped == T * K
assert load.max() <= cap
print("load", load, "dropped", dropped, "a2a bytes", remote * d * b * 2)`,
    checks: ['Kept + dropped = T × k', 'No expert above capacity', 'Bytes = remote pairs × d × b × 2'],
    gaps: 'NumPy RNG differs from the browser seed; no real expert compute or NCCL all-to-all.',
  },
  bench: {
    hypothesis: 'Hybrid TP-attention + EP-FFN gives higher tokens/s at the same ITL SLO than pure TP for this MoE on one 8-GPU node.',
    baseline: 'Pure tensor parallelism across the same 8 GPUs.',
    controlled: ['Model and precision', 'Engine version', 'Batch/token budget', 'Prompt/output distribution', 'Single NVLink node'],
    workload: 'Open-loop trace at 3 load levels; also a skewed-domain dataset to stress routing.',
    warmup: '200 requests discarded.', reps: '5 runs per layout × load.',
    method: 'Engine step profiler: all-to-all and all-reduce durations; per-expert token counts; client ITL.',
    metrics: ['Tokens/s at SLO', 'All-to-all ms per layer', 'Max/mean expert load', 'Dropped-token rate', 'Task quality delta'],
    interpret: 'If EP wins at uniform routing but loses on skewed data, add expert replication or rebalancing before switching.',
  },
  pitfalls: [
    'Sizing memory by active params: you must store all experts.',
    'Ignoring skew: averages hide the hottest device that sets step time.',
    'Spanning EP across slow inter-node links: all-to-all dominates.',
    'Changing capacity factor or dropping policy without a quality evaluation.',
  ],
  optimizations: [
    ['Replicate hot experts', 'Balances load; costs memory and complicates routing.'],
    ['Overlap all-to-all with shared/attention compute', 'Hides comm; needs careful stream scheduling.'],
    ['Larger batches per step', 'Amortises all-to-all latency; raises ITL.'],
  ],
  breaks: [
    'Tiny batches: all-to-all latency, not bandwidth, dominates and EP stops paying off.',
    'Strongly skewed traffic (one domain): a few experts saturate and capacity drops hurt quality.',
  ],
  interview: {
    short:
      'First I separate memory from compute. An MoE stores every expert but runs only top-k per token: an illustrative 47B model with 2B shared and 45B across 8 experts, top-2, computes about 13B parameters per token but must store all 47B. Tensor parallelism splits every matrix and all-reduces activations every layer, which is heavy for big feed-forward blocks. Pipeline parallelism splits layers and suffers bubbles: 8 stages with 8 microbatches waste about 47 %. Expert parallelism places different experts on different GPUs; each MoE layer then needs two all-to-alls, dispatch and combine, roughly 2 × (T·k/D) × d × bytes × (D−1)/D, about 14 MiB per device per layer for 4,096 tokens on 8 GPUs. Its weak spot is skew: a popular expert makes its device the straggler, so I set a capacity factor, watch drop rates and replicate hot experts. My default is tensor-parallel attention plus expert-parallel FFN inside one NVLink domain, pipeline across nodes only if it does not fit. I would confirm with profiler traces of all-to-all time, per-expert loads and a quality check on dropped tokens.',
    whiteboard: [
      'Total vs active params; memory fit per device.',
      'Draw tokens → router → experts on 2 devices; mark cross-device pairs.',
      'Compute a2a bytes; compare with TP all-reduce bytes.',
      'Show skew → straggler → capacity drops.',
      'Pick hybrid layout and state the topology condition.',
    ],
    followups: [
      ['Why not just use TP for the experts?', 'Each expert is small relative to the batch; TP all-reduces full activations every layer, while EP only moves routed tokens.'],
      ['What does capacity factor trade?', 'Higher cf avoids drops but pads buffers and allows more imbalance; lower cf balances but drops tokens.'],
      ['How does batch size change the choice?', 'Larger batches amortise all-to-all latency and smooth routing; tiny batches make EP latency-bound.'],
    ],
    debug: [
      'MoE throughput halves only on traffic from one customer. GPU utilisation is uneven across devices. What happened?',
      'Domain-specific prompts route to a few experts: those devices straggle. Check per-expert token counts; replicate hot experts or rebalance placement.',
    ],
    calc: [
      '16 experts, top-2, 4B shared, 96B in experts. Active params per token?',
      '4 + 96 × 2/16 = 16B.',
    ],
  },
  changeMind: [
    'Measured all-to-all time is small next to expert compute (fast NVLink, big batches).',
    'Traffic is highly skewed to a few experts.',
    'Model fits on one device per replica with room for KV.',
  ],
  recall: [
    ['Active params formula?', 'shared + experts × k / E.'],
    ['How many all-to-alls per MoE layer?', 'Two: dispatch and combine.'],
    ['What sets EP step time?', 'The most loaded device.'],
  ],
  glossary: [
    ['MoE', 'Mixture of experts: layers with many expert FFNs; a router picks a few per token.'],
    ['EP', 'Expert parallelism: different experts on different devices.'],
    ['PP', 'Pipeline parallelism: different layers on different devices.'],
    ['All-to-all', 'Collective where every device sends a distinct chunk to every other device.'],
    ['Capacity factor', 'Multiplier on average tokens per expert that sets per-expert slots per step.'],
  ],
  tags: ['moe', 'expert parallelism', 'all-to-all', 'tensor parallel', 'pipeline'],
};

const q24: Lesson = {
  id: 24,
  group: 'systems',
  short: 'Cut cost 70 %',
  question:
    'Your inference bill is ridiculous. Design a plan to cut cost per million tokens by 70% without sacrificing acceptable output quality.',
  why: 'Tests whether you can rank levers by measured opportunity and combine them honestly.',
  tldr: [
    'Target: final cost ≤ 0.30 × baseline. Define “acceptable quality” with evals before cutting anything.',
    'Savings multiply, they do not add: three 35 % cuts give 73 %, not 105 %.',
    'Biggest levers usually: routing to smaller models, utilization/batching, quantization, caching.',
  ],
  plain:
    'Cost per million tokens is GPU dollars divided by tokens delivered. You lower it by delivering more tokens per GPU-hour or by needing cheaper work per token. Each change acts on what is left after the previous one, so you multiply remaining fractions.',
  analogy: {
    name: 'Stacked discount coupons',
    map: [
      ['Store price', 'Baseline $ per M tokens'],
      ['30 % off coupon', 'One intervention’s saving'],
      ['Coupon only valid on some items', 'Share of traffic it applies to'],
      ['Second coupon applies to discounted price', 'Multiplicative combination'],
    ],
    breaks:
      'Coupons never change the product; cheaper models and quantization can change output quality, so each “coupon” needs an eval gate.',
  },
  example: {
    title: 'Hypothetical fleet, five interventions',
    inputs: '16 GPUs × $4/GPU-h (assumed) + 15 % overhead; 4,000 output tok/s delivered; 45 % busy',
    steps: [
      { label: 'Baseline', state: '$73.6/h ÷ 14.4 M tok/h = $5.11 / M' },
      { label: 'Routing (70 % on 50 %)', state: '× (1 − 0.35) → $3.32' },
      { label: 'FP8 (35 % on 100 %)', state: '× 0.65 → $2.16' },
      { label: 'Batching (30 %)', state: '× 0.70 → $1.51' },
      { label: 'Prefix cache, length caps', state: '× 0.88 × 0.88 → $1.17' },
    ],
    output: '$1.17 / M = 77 % reduction ≤ $1.53 target. A naive additive sum claims 124 %, which is impossible.',
    predict: {
      q: 'Routing and FP8 both fail the quality gate. Can the remaining four reach 70 %?',
      a: 'No: 0.88 × 0.88 × 0.70 × 0.86 ≈ 0.47 remaining → 53 % reduction. The target is infeasible without new levers.',
    },
  },
  scenes: [
    {
      id: 'q24-s1', title: 'Where the money goes', objective: 'Break baseline cost into busy, idle and overhead.', duration: 18,
      narration: 'Start from the bill. Sixteen GPUs at an assumed 4 dollars per hour plus 15 percent overhead deliver 4,000 output tokens per second. That is 5.11 dollars per million tokens. More than half of the GPU time is idle headroom.',
      lanes: [
        { label: 'Baseline $/M', items: [{ label: 'busy $2.00', kind: 'prefill', at: 0.2 }, { label: 'idle $2.44', kind: 'error', at: 0.4 }, { label: 'overhead $0.67', kind: 'neutral', at: 0.6 }] },
        { label: 'Total', items: [{ label: '$5.11 / M', kind: 'kv', at: 0.85 }] },
      ],
      equation: '$/M = hourly cost ÷ (tokens/s × 3,600) × 10⁶',
      transition: 'One bill becomes three bars.', action: 'Raise “GPU busy fraction” and see idle shrink.',
    },
    {
      id: 'q24-s2', title: 'Define acceptable quality first', objective: 'Set gates before cutting.', duration: 18,
      narration: 'Before any change, fix representative task evals with confidence intervals and a maximum allowed regression. Every intervention must pass the gate. Cost cuts that fail it do not count.',
      lanes: [
        { label: 'Eval suite', items: [{ label: 'tasks', kind: 'request', at: 0.1 }, { label: 'long context', kind: 'request', at: 0.2 }, { label: 'safety', kind: 'request', at: 0.3 }] },
        { label: 'Gate', items: [{ label: 'Δ ≤ 1 pt, 95 % CI', kind: 'kv', at: 0.5 }] },
        { label: 'Candidates', items: [{ label: 'FP8 ✓', kind: 'ok', at: 0.7 }, { label: 'small model ✕', kind: 'error', at: 0.8 }] },
      ],
      equation: 'accept if lower CI bound of Δquality ≥ −threshold',
      transition: 'Candidates pass or fail a fixed gate.', action: 'Uncheck an intervention to simulate a gate failure.',
    },
    {
      id: 'q24-s3', title: 'Multiply, don’t add', objective: 'Combine savings correctly.', duration: 18,
      narration: 'Each saving acts on what is left. Routing takes 35 percent off. FP8 takes 35 percent of the remainder, not of the original. Five interventions leave 23 percent, a 77 percent cut. Adding them would claim 124 percent.',
      lanes: [
        { label: 'Remaining', items: [{ label: '100 %', kind: 'neutral' }, { label: '65 %', kind: 'decode', at: 0.2 }, { label: '42 %', kind: 'decode', at: 0.4 }, { label: '30 %', kind: 'decode', at: 0.6 }, { label: '23 %', kind: 'ok', at: 0.8 }] },
        { label: 'Additive (wrong)', items: [{ label: '−124 %', kind: 'error', at: 0.9 }] },
      ],
      equation: 'remaining = Π (1 − s_i × a_i)',
      transition: 'Waterfall bars shrink step by step.', action: 'Compare the two reduction stats.',
    },
    {
      id: 'q24-s4', title: 'Rank by opportunity and risk', objective: 'Order levers by measured size and quality risk.', duration: 18,
      narration: 'Do low-risk wins first: batching and utilization, prefix caching, length limits. Then medium risk: quantization, speculation. Model routing is often the biggest lever but carries the most quality risk and needs a good router.',
      lanes: [
        { label: 'Low risk', items: [{ label: 'batching', kind: 'ok', at: 0.1 }, { label: 'prefix cache', kind: 'ok', at: 0.2 }] },
        { label: 'Medium', items: [{ label: 'FP8', kind: 'kv', at: 0.4 }, { label: 'length caps', kind: 'kv', at: 0.5 }, { label: 'speculation', kind: 'kv', at: 0.6 }] },
        { label: 'High', items: [{ label: 'small-model routing', kind: 'error', at: 0.8 }] },
      ],
      equation: 'priority ≈ expected saving ÷ (risk × effort)',
      transition: 'Levers sort into risk tiers.', action: 'Edit one intervention’s saving and share.',
    },
    {
      id: 'q24-s5', title: 'When 70 % is infeasible', objective: 'Recognise and report infeasibility.', duration: 18,
      narration: 'If routing and quantization fail quality, the rest reach only about 53 percent. Say so with numbers. Options are a contract change, a different model, or relaxing the target, not hiding quality loss.',
      lanes: [
        { label: 'Blocked', items: [{ label: 'routing ✕', kind: 'error', at: 0.1 }, { label: 'FP8 ✕', kind: 'error', at: 0.2 }] },
        { label: 'Result', items: [{ label: '53 % only', kind: 'error', at: 0.5 }] },
        { label: 'Next', items: [{ label: 'new model', kind: 'neutral', at: 0.7 }, { label: 'relax target', kind: 'neutral', at: 0.8 }, { label: 'renegotiate', kind: 'neutral', at: 0.9 }] },
      ],
      equation: 'final > 0.30 × baseline → infeasible',
      transition: 'Plan turns red; alternatives appear.', action: 'Pick the failure preset.',
    },
  ],
  sim: {
    tldr: 'Hypothetical savings, applied largest first; the waterfall, verdict and table all come from costPlan().',
    omits: [
      'Interactions beyond multiplication (e.g. quantization lowers the gain from cheaper hardware).',
      'Input-token (prefill) cost reported separately from output-token cost.',
      'Engineering effort and migration cost of each intervention.',
      'Price changes over time; GPU price is an assumption, not a quote.',
    ],
  },
  formula: {
    name: 'Cost per million tokens and combined savings',
    tex: String.raw`\frac{\$}{\text{M tok}} = \frac{\text{cost per hour}}{\text{tok/s}\times 3600}\times 10^6,\qquad \text{final} = \text{base}\prod_i (1 - s_i a_i) \le 0.30\,\text{base}`,
    vars: [
      ['cost per hour', 'GPUs × $/GPU-h × (1 + overhead)', '$/h'],
      ['tok/s', 'delivered output tokens per second (same period)', 'tokens/s'],
      ['s_i', 'saving of intervention i on traffic it touches', '—'],
      ['a_i', 'share of traffic it applies to', '—'],
    ],
    assumptions: ['Savings independent enough to multiply', 'Delivered tokens exclude failed/rejected ones', 'Same quality gate for all'],
    substituted: '$73.6/h ÷ (4,000 × 3,600) × 10⁶ = $5.11; × 0.65 × 0.65 × 0.70 × 0.88 × 0.88 = $1.17 (77 %)',
    check: '($/h) ÷ (tokens/h) × 10⁶ = $/M tokens ✓',
    cue: 'Gate quality, multiply remainders, stop at 0.30.',
  },
  estimates: [
    { quantity: 'Baseline cost (hypothetical fleet)', value: '5.11', unit: '$/M out', assumptions: '$4/GPU-h assumed, 16 GPUs', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Plan result, 5 interventions', value: '1.17 (77 %)', unit: '$/M out', assumptions: 'Hypothetical savings', source: 'costPlan()', evidence: 'calculated' },
    { quantity: 'Same plan, routing + FP8 blocked', value: '53', unit: '% reduction', assumptions: 'Quality gate failure', source: 'costPlan()', evidence: 'calculated' },
    { quantity: 'GPU rental price', value: '4', unit: '$/GPU-h', assumptions: 'Teaching input', source: 'Not a current quote', evidence: 'assumed' },
    { quantity: 'Each intervention’s real saving', value: '—', unit: '%', assumptions: 'Per workload', source: 'Benchmark below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Buy cheaper GPUs and quantize everything to 4-bit, add up vendor-claimed savings.',
    improved: 'Measure the cost breakdown, gate each change on evals, rank by opportunity/risk, multiply savings, verify on canaries.',
    mechanism: 'Targets the largest real cost (often idle GPU time and oversized models) while bounding quality loss.',
    rows: [
      ['Projected saving', 'Overstated (additive)', 'Honest (multiplicative)'],
      ['Quality risk', 'Unmeasured', 'Gated with CIs'],
      ['Latency', 'May regress', 'Checked against SLO'],
      ['Effort', 'Low', 'Higher: evals, routing, canaries'],
    ],
  },
  lab: {
    title: 'Multiplicative savings checker', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 cost_plan.py'], lang: 'python',
    code: `def per_m(gpus, usd_h, overhead, tok_s):
    return gpus * usd_h * (1 + overhead) / (tok_s * 3600) * 1e6

base = per_m(16, 4.0, 0.15, 4000)
plan = [(0.7, 0.5), (0.35, 1.0), (0.3, 1.0), (0.3, 0.4), (0.2, 0.6)]
remaining = 1.0
for s, a in sorted(plan, key=lambda x: -x[0] * x[1]):
    remaining *= 1 - s * a
additive = sum(s * a for s, a in plan)
assert abs(base - 5.111) < 1e-3
assert abs(remaining - 0.2290) < 1e-3          # 77 % reduction
assert additive > 1                             # additive claim is impossible
print(f"base {base:.2f} final {base*remaining:.2f} target {0.3*base:.2f}")`,
    checks: ['Baseline $5.11/M', 'Remaining 22.9 % → meets 30 % target', 'Additive sum exceeds 100 %'],
    gaps: 'Savings are hypothetical inputs; real values come from canary measurements per intervention.',
  },
  bench: {
    hypothesis: 'Each intervention reduces $/M delivered output tokens by its estimated amount at unchanged quality and SLO.',
    baseline: 'Current production configuration over a fixed traffic replay.',
    controlled: ['Traffic replay (prompts, arrival trace)', 'Eval suite and grader', 'SLO thresholds', 'Accounting period and token definition'],
    workload: 'One-week production replay, stratified by task type.',
    warmup: 'Discard first hour of each replay.', reps: '3 replays per intervention, then cumulative stack.',
    method: 'GPU-hours from billing, delivered tokens from gateway, quality from eval suite with bootstrap CIs.',
    metrics: ['$/M output tokens', '$/M input tokens', 'Quality Δ with 95 % CI', 'p95 TTFT and ITL'],
    interpret: 'Accept only interventions whose quality CI stays within the threshold; re-measure the stack, do not multiply estimates blindly.',
  },
  pitfalls: [
    'Adding percentage savings: overstates and can exceed 100 %.',
    'Counting failed, cached or speculative tokens as delivered.',
    'Changing model or precision without a fixed eval gate.',
    'Optimising output cost while input (prefill) cost dominates the bill.',
  ],
  optimizations: [
    ['Route easy requests to a smaller model', 'Largest lever; needs a reliable router and fallback.'],
    ['Raise utilization with better batching and autoscaling', 'Low quality risk; can raise tail latency.'],
    ['Quantize weights and KV (FP8)', 'Large memory and speed gains; needs per-task quality checks.'],
  ],
  breaks: [
    'Workload already at high utilization on the smallest acceptable model: little left to cut.',
    'Quality bar is strict on long-context or reasoning tasks where small models and low precision fail.',
  ],
  interview: {
    short:
      'I would first define acceptable quality as an eval suite with a maximum regression and confidence intervals, and agree that a 70 % cut means final cost per million delivered tokens at most 0.30 times baseline, over the same period and token definition. Then I break down the baseline: busy GPU time, idle headroom and overhead, plus input versus output tokens, because the biggest waste is often idle capacity or an oversized model. I rank levers by opportunity and risk: batching and utilization, prefix caching and output length limits are low risk; FP8 quantization and speculation medium; routing easy traffic to a smaller model is often largest but riskiest. Savings combine multiplicatively: in a hypothetical fleet at 5.11 dollars per million, routing half the traffic at 70 % off, FP8, better batching, prefix caching and length caps leave 23 %, a 77 % cut, whereas adding them would claim 124 %. Each change ships behind a canary with quality and SLO gates, and I re-measure the stack rather than trusting the product. If routing and quantization fail quality, the rest give only about 53 %, and I would report that the target is infeasible.',
    whiteboard: [
      'Write $/M = $/h ÷ tokens/h × 10⁶; compute baseline.',
      'Draw the breakdown: busy, idle, overhead.',
      'List levers with saving × share and risk.',
      'Multiply remainders; mark 0.30 line.',
      'Show infeasible case and what to do.',
    ],
    followups: [
      ['Why multiply instead of add?', 'Each lever acts on remaining cost; overlapping levers (FP8 and cheaper hardware) also shrink each other’s gain.'],
      ['How do you know routing is safe?', 'Offline eval per route plus online canary with fallback to the large model when the router is unsure.'],
      ['Which tokens count as delivered?', 'Successful output tokens to the client; exclude failed, rejected and rejected-speculative tokens; report input separately.'],
    ],
    debug: [
      'After FP8 rollout, $/M fell 30 % but customer complaints about long documents doubled. What happened?',
      'Long-context quality regressed with FP8 KV. The eval suite under-sampled long context; add stratified long-context evals and keep BF16 KV for long requests.',
    ],
    calc: [
      'Three interventions: 40 % on all, 50 % on 60 %, 20 % on all. Combined reduction?',
      '1 − 0.60 × 0.70 × 0.80 = 1 − 0.336 = 66.4 %.',
    ],
  },
  changeMind: [
    'Measured utilization already above 80 %.',
    'Eval CIs too wide to detect a meaningful regression (need more samples).',
    'Input tokens dominate cost (long prompts): prioritise caching and prompt trimming.',
  ],
  recall: [
    ['70 % cut means?', 'Final ≤ 0.30 × baseline.'],
    ['Combine savings how?', 'Multiply remaining fractions.'],
    ['First step?', 'Define acceptable quality with evals.'],
  ],
  glossary: [
    ['$/M tokens', 'Dollars per million delivered tokens over a stated period.'],
    ['Model routing', 'Sending each request to the cheapest model that meets its quality bar.'],
    ['Canary', 'Small slice of live traffic used to test a change before full rollout.'],
    ['CI', 'Confidence interval: range likely to contain the true value.'],
  ],
  tags: ['cost', 'efficiency', 'quantization', 'routing', 'utilization'],
};

const q25: Lesson = {
  id: 25,
  group: 'systems',
  short: '1M DAU capacity',
  question:
    'Design an inference platform for 1M daily active users. Estimate peak traffic, concurrency, GPU requirements, memory capacity, and serving cost.',
  why: 'Capacity planning shows whether you can turn vague demand into defensible numbers and uncertainty.',
  tldr: [
    '1M DAU × 10 req/day = 116 RPS average; × 3 peak factor ≈ 347 RPS.',
    'Little’s law: concurrency = RPS × time in system ≈ 347 × 16.8 s ≈ 5,800 active requests.',
    'GPUs = max(memory, throughput) rounded to TP groups, plus headroom, regions, N+1. Report ranges.',
  ],
  plain:
    'Turn users into requests per second at peak, then into input and output tokens per second. Little’s law turns arrival rate and latency into how many requests are in flight, which sets KV memory. Compare the memory bound and the throughput bound, take the larger, and add headroom and failover.',
  analogy: {
    name: 'Planning checkout lanes for a stadium',
    map: [
      ['Fans attending per day', 'Daily active users'],
      ['Half-time rush', 'Peak factor'],
      ['Fans at the counter at once', 'Concurrency (Little’s law)'],
      ['Counter space vs cashier speed', 'Memory bound vs throughput bound'],
    ],
    breaks:
      'Cashiers serve one fan at a time; GPUs batch many requests, so throughput per GPU depends on batch size and SLO, which you must measure.',
  },
  example: {
    title: 'Base case, 70B model on 80 GB GPUs (assumed inputs)',
    inputs: '1M DAU, 10 req/user/day, peak ×3, prompt 1,500, output 400 tokens, TTFT 0.8 s, ITL 40 ms, 1,500 decode tok/s/GPU and 10,000 prefill tok/s/GPU (assumed), TP8, 20 % headroom, 2 regions N+1',
    steps: [
      { label: 'RPS', state: '10,000,000 / 86,400 = 115.7 avg → × 3 = 347.2 peak' },
      { label: 'Token rates', state: 'input 347.2 × 1,500 = 520,833 tok/s · output 347.2 × 400 = 138,889 tok/s' },
      { label: 'Concurrency', state: 'E2E = 0.8 + 399 × 0.04 = 16.76 s → 347.2 × 16.76 = 5,819 in flight' },
      { label: 'Memory bound', state: 'KV ≈ 5,819 × 1,700 avg tokens × 320 KiB = 3,019 GiB → ÷ 417.7 GiB KV room per TP8 group = 8 groups' },
      { label: 'Throughput bound', state: '138,889 / 1,500 + 520,833 / 10,000 = 144.7 GPUs → 19 TP8 groups' },
      { label: 'Deploy', state: 'max(8, 19) × 1.2 = 23 groups → 2 regions × (12 + 1) = 26 groups = 208 GPUs' },
    ],
    output: '208 GPUs, ≈ $379,600 / month at an assumed $2.50/GPU-h → ≈ $3.12 per M output tokens. Throughput-bound.',
    predict: {
      q: 'Which single input moves the GPU count most if it is wrong by ±50 %?',
      a: 'Requests per user per day: 112 to 288 GPUs. It scales every downstream rate, so measure it (or a proxy) first.',
    },
  },
  scenes: [
    {
      id: 'q25-s1', title: 'Users to requests per second', objective: 'Convert DAU into peak RPS.', duration: 18,
      narration: 'One million daily users making ten requests each is ten million requests a day. Divided by 86,400 seconds that is about 116 per second on average. Traffic bunches up, so a peak factor of three gives about 347 per second.',
      lanes: [
        { label: 'Demand', items: [{ label: '1M DAU', kind: 'request' }, { label: '× 10 req', kind: 'request', at: 0.2 }] },
        { label: 'Average', items: [{ label: '115.7 RPS', kind: 'neutral', at: 0.45 }] },
        { label: 'Peak', items: [{ label: '× 3 → 347 RPS', kind: 'error', at: 0.75 }] },
      ],
      equation: 'peak RPS = DAU × req/user/day ÷ 86,400 × peak factor',
      transition: 'Daily total becomes a peak rate.', action: 'Move the peak factor slider.',
    },
    {
      id: 'q25-s2', title: 'Tokens, not requests', objective: 'Split input and output token rates.', duration: 18,
      narration: 'Each request brings 1,500 prompt tokens and generates 400. At peak that is 521 thousand input tokens per second and 139 thousand output tokens per second. Prefill and decode stress different resources, so keep them separate.',
      lanes: [
        { label: 'Input (prefill)', items: [{ label: '520,833 tok/s', kind: 'prefill', at: 0.3 }] },
        { label: 'Output (decode)', items: [{ label: '138,889 tok/s', kind: 'decode', at: 0.6 }] },
      ],
      equation: 'tok/s = RPS × tokens per request',
      transition: 'One RPS number splits into two token rates.', action: 'Double output tokens and watch which bound grows.',
    },
    {
      id: 'q25-s3', title: 'Little’s law to concurrency', objective: 'Find requests in flight and their KV.', duration: 18,
      narration: 'Each request lives about 16.8 seconds: 0.8 to the first token plus 399 gaps of 40 milliseconds. Little’s law says 347 per second times 16.8 seconds is about 5,800 requests in flight on average. Their KV cache is about 3,000 GiB.',
      lanes: [
        { label: 'Arrivals', items: [{ label: '347 / s', kind: 'request', at: 0.1 }] },
        { label: 'Time in system', items: [{ label: '16.76 s', kind: 'neutral', at: 0.3 }] },
        { label: 'In flight', items: [{ label: '≈ 5,819', kind: 'kv', at: 0.55 }, { label: 'KV ≈ 3,019 GiB', kind: 'kv', at: 0.8 }] },
      ],
      equation: 'L = λ × W',
      transition: 'Rate × time becomes a standing population.', action: 'Raise ITL SLO and see concurrency rise.',
    },
    {
      id: 'q25-s4', title: 'Memory vs throughput bound', objective: 'Take the larger of two GPU lower bounds.', duration: 18,
      narration: 'Memory needs 8 TP8 groups to hold weights and KV. Throughput needs 19 groups at the assumed per-GPU rates. The larger one wins: this design is throughput-bound. Then add 20 percent headroom, two regions and a spare group each.',
      lanes: [
        { label: 'Memory', items: [{ label: '8 groups', kind: 'kv', at: 0.2 }] },
        { label: 'Throughput', items: [{ label: '19 groups', kind: 'decode', at: 0.4 }] },
        { label: 'Deployed', items: [{ label: '× 1.2 → 23', kind: 'prefill', at: 0.6 }, { label: '2 × (12 + 1) = 26', kind: 'ok', at: 0.8 }, { label: '208 GPUs', kind: 'ok', at: 0.9 }] },
      ],
      equation: 'GPUs ≥ max(memory, throughput) → TP multiples → + headroom + N+1',
      transition: 'Two bounds collapse to one deployed number.', action: 'Pick the failure preset: long prompts flip it toward memory.',
    },
    {
      id: 'q25-s5', title: 'Ranges and what to measure', objective: 'Report uncertainty, not one number.', duration: 18,
      narration: 'Low, base and high scenarios give 112, 208 and 432 GPUs. The sensitivity chart shows requests per user per day as the widest bar. Measure that, and measured tokens per second per GPU at your SLO, before buying anything.',
      lanes: [
        { label: 'Scenarios', items: [{ label: 'low 112', kind: 'decode', at: 0.1 }, { label: 'base 208', kind: 'prefill', at: 0.25 }, { label: 'high 432', kind: 'error', at: 0.4 }] },
        { label: 'Measure first', items: [{ label: 'req/user/day', kind: 'kv', at: 0.65 }, { label: 'tok/s/GPU at SLO', kind: 'kv', at: 0.8 }] },
      ],
      equation: 'report: low / base / high + sensitivity',
      transition: 'One estimate widens into a defensible range.', action: 'Read the tornado chart’s top bar.',
    },
  ],
  sim: {
    tldr: 'Every stat, bound, scenario and tornado bar comes from capacity(); change an input and all of them move together.',
    omits: [
      'Length distributions: means only; real tails raise KV and latency.',
      'Prefix reuse, cancellations and retries.',
      'Model mix (several models or adapters) and per-model pools.',
      'Startup lag and autoscaling; this sizes for peak with static headroom.',
    ],
  },
  formula: {
    name: 'Peak traffic, concurrency and GPU lower bound',
    tex: String.raw`\lambda = \frac{\text{DAU}\cdot r}{86400}\,p,\quad L = \lambda W,\quad N_{GPU} \ge \max\!\Big(\frac{M_{\text{weights}}+M_{kv}(L)}{M_{\text{usable}}},\ \frac{\lambda\, o}{R_{dec}} + \frac{\lambda\, i}{R_{pre}}\Big)`,
    vars: [
      ['r', 'requests per user per day', 'req/day'],
      ['p', 'peak factor (peak / mean)', '—'],
      ['W', 'mean time in system = TTFT + (o−1)·ITL', 's'],
      ['i, o', 'prompt and output tokens per request', 'tokens'],
      ['R_dec, R_pre', 'measured decode and prefill tok/s per GPU at SLO', 'tokens/s'],
      ['M_usable', 'usable memory per GPU after reserve', 'GiB'],
    ],
    assumptions: ['Steady-state mean (not p99)', 'Prefill and decode load add on shared GPUs', 'Weights replicated per TP group'],
    substituted: 'λ = 10⁷/86,400 × 3 = 347.2/s; L = 347.2 × 16.76 = 5,819; throughput = 92.6 + 52.1 = 144.7 GPUs → 19 TP8 groups',
    check: 'req/s × s = req; (tok/s) ÷ (tok/s per GPU) = GPUs ✓',
    cue: 'Users → RPS → tokens → Little → max(memory, throughput) → headroom.',
  },
  estimates: [
    { quantity: 'Peak RPS', value: '347', unit: 'req/s', assumptions: '10 req/user/day, ×3 peak', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Concurrency', value: '5,819', unit: 'requests', assumptions: 'E2E 16.76 s', source: "Little's law", evidence: 'calculated' },
    { quantity: 'KV at peak (BF16)', value: '3,019', unit: 'GiB', assumptions: '1,700 avg cached tokens', source: 'Q3 formula', evidence: 'calculated' },
    { quantity: 'Decode tok/s per GPU at SLO', value: '1,500', unit: 'tok/s', assumptions: '70B, TP8, ITL 40 ms', source: 'Teaching input — measure it', evidence: 'assumed' },
    { quantity: 'Deployed GPUs (base)', value: '208 (range 112–432)', unit: 'GPUs', assumptions: 'TP8, 2 regions N+1, 20 % headroom', source: 'capacity()', evidence: 'calculated' },
    { quantity: 'GPU price', value: '2.50', unit: '$/GPU-h', assumptions: 'Teaching input', source: 'Not a current quote', evidence: 'assumed' },
  ],
  compare: {
    naive: 'Divide total daily tokens by a vendor peak FLOPS number; buy that many GPUs.',
    improved: 'Peak token rates, Little’s law concurrency, measured tok/s per GPU at SLO, memory and throughput bounds, TP rounding, headroom, regions, ranges.',
    mechanism: 'Uses measured serving curves at the latency target and peak demand, not averages or theoretical peaks.',
    rows: [
      ['Traffic basis', 'Daily average', 'Peak with factor'],
      ['Per-GPU rate', 'Vendor peak FLOPS', 'Measured at SLO'],
      ['Memory', 'Ignored', 'KV from concurrency + weights'],
      ['Output', 'One number', 'Low / base / high + sensitivity'],
    ],
  },
  lab: {
    title: 'Capacity calculator with asserts', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 capacity.py'], lang: 'python',
    code: `import math
dau, rpd, peak, p_in, p_out = 1_000_000, 10, 3, 1500, 400
ttft, itl, r_dec, r_pre, tp = 0.8, 0.040, 1500, 10_000, 8
rps = dau * rpd / 86_400 * peak
e2e = ttft + (p_out - 1) * itl
conc = rps * e2e                                  # Little's law (mean)
kv_gib = conc * (p_in + p_out / 2) * 327_680 / 2**30
room = tp * (80e9 / 2**30 - 6) - 70e9 * 2 / 2**30  # KV room per TP8 group
g_mem = math.ceil(kv_gib / room)
g_thr = math.ceil((rps * p_out / r_dec + rps * p_in / r_pre) / tp)
groups = math.ceil(max(g_mem, g_thr) * 1.2)
gpus = 2 * (math.ceil(groups / 2) + 1) * tp
assert round(rps, 1) == 347.2 and round(conc) == 5819
assert (g_mem, g_thr, gpus) == (8, 19, 208)
print(rps, conc, kv_gib, g_mem, g_thr, gpus)`,
    checks: ['Peak RPS 347.2', 'Concurrency 5,819', 'Memory 8 groups, throughput 19, deployed 208 GPUs'],
    gaps: 'Means only; no length distributions, prefix reuse, model mix or measured serving curve.',
  },
  bench: {
    hypothesis: 'One TP8 group sustains ≥ 12,000 decode tok/s and the assumed prefill rate at ITL p95 ≤ 40 ms for our length mix.',
    baseline: 'Single TP8 replica with default engine settings.',
    controlled: ['Model, precision, engine version', 'GPU type and topology', 'Prompt/output length distribution from production sample', 'Seeded open-loop arrivals'],
    workload: 'Load sweep from 10 % to 120 % of estimated per-group capacity.',
    warmup: '3 min per load step, discarded.', reps: '3 runs per load step.',
    method: 'Client TTFT and ITL; server tok/s; record the highest load meeting SLO (goodput at SLO).',
    metrics: ['Decode and prefill tok/s at SLO per GPU', 'p95/p99 TTFT and ITL', 'KV utilisation', 'Error rate'],
    interpret: 'Replace the assumed R_dec and R_pre with the measured knee; recompute GPUs and ranges.',
  },
  pitfalls: [
    'Using average RPS instead of peak.',
    'Treating Little’s law mean concurrency as a p99 safe target.',
    'Using vendor peak throughput instead of measured tok/s at the SLO.',
    'Forgetting TP rounding, failover capacity and a spare per region.',
  ],
  optimizations: [
    ['Prefix caching for shared system prompts', 'Cuts prefill load; needs routing affinity.'],
    ['FP8 weights and KV', 'Fewer GPUs per replica and more KV room; quality must be checked.'],
    ['Smaller model for easy traffic', 'Large cost cut; needs routing and evals.'],
  ],
  breaks: [
    'Peak factor or per-user demand is unknown: estimates span 2–4×; measure before committing.',
    'Very long contexts make memory, not throughput, the binding constraint.',
  ],
  interview: {
    short:
      'I would state assumptions out loud and keep them editable. One million daily users at ten requests each is ten million a day, 116 per second on average; with a peak factor of three, about 347 per second. With 1,500 prompt and 400 output tokens, that is about 521 thousand input and 139 thousand output tokens per second at peak. Each request lives about 0.8 seconds to first token plus 399 gaps of 40 milliseconds, 16.8 seconds, so Little’s law gives about 5,800 requests in flight on average, which for an assumed 70B model in BF16 is roughly 3,000 GiB of KV. Memory then needs about 8 TP8 groups; throughput, using an assumed 1,500 decode and 10,000 prefill tokens per second per GPU at the SLO, needs 19 groups. I take the larger, add 20 % headroom, split over two regions with one spare group each: 208 GPUs, roughly 380 thousand dollars a month at an assumed 2.50 dollars per GPU-hour. I would present low, base and high, 112 to 432 GPUs, and say the most valuable measurements are requests per user and tokens per second per GPU at our SLO.',
    whiteboard: [
      'DAU → avg RPS → peak RPS.',
      'Split input and output token rates.',
      "Little's law: concurrency and KV GiB.",
      'Memory bound vs throughput bound; take max.',
      'TP rounding, headroom, regions, N+1, cost, ranges.',
    ],
    followups: [
      ['Why not size for average?', 'Queues grow without bound whenever arrival rate exceeds capacity; peaks drive SLO violations.'],
      ['Is Little’s law concurrency safe to provision for?', 'No. It is a mean; add headroom for bursts and tail latency.'],
      ['How would prefix caching change the plan?', 'It lowers prefill tokens per second and KV per request, shifting both bounds down.'],
    ],
    debug: [
      'You deployed 208 GPUs, average utilisation is 35 %, yet p99 TTFT breaches at peak. Why?',
      'Load imbalance or bursts above the assumed peak factor; also prefill contention. Check per-replica queue depth and the actual peak-to-mean ratio.',
    ],
    calc: [
      '500K DAU, 6 req/day, peak ×4, 20 s per request. Mean concurrency at peak?',
      '500,000 × 6 / 86,400 × 4 = 138.9 RPS × 20 s ≈ 2,778.',
    ],
  },
  changeMind: [
    'Measured tok/s per GPU at SLO differs by more than 30 % from the assumption.',
    'Production traces show a different peak factor or length distribution.',
    'Prefix reuse rate is high enough to cut prefill load in half.',
  ],
  recall: [
    ['Peak RPS formula?', 'DAU × req/user/day ÷ 86,400 × peak factor.'],
    ["Little's law?", 'Concurrency = arrival rate × time in system.'],
    ['GPU lower bound?', 'max(memory, throughput) rounded to TP groups, then headroom and N+1.'],
  ],
  glossary: [
    ['DAU', 'Daily active users.'],
    ['RPS', 'Requests per second.'],
    ["Little's law", 'L = λW: mean items in system equals arrival rate times mean time in system.'],
    ['N+1', 'One spare unit beyond what is needed, to survive a single failure.'],
    ['SLO', 'Service level objective, e.g. p95 ITL ≤ 40 ms.'],
  ],
  tags: ['capacity', 'planning', 'littles law', 'cost', 'gpu count', 'dau'],
};

export const lessons: Lesson[] = [q21, q22, q23, q24, q25];
