// Production engineering (Q16-Q20).
import type { Lesson } from '../types';

const q16: Lesson = {
  id: 16,
  group: 'production',
  short: 'Observability dashboard',
  question:
    'Design an observability dashboard for inference. Which metrics would you track for latency, KV cache pressure, cache hits, throughput, and cost?',
  why: 'Without the right metrics you cannot tell overload from a slow kernel, or a cheap hour from a broken one.',
  tldr: [
    'Track latency as histograms: client and server TTFT, token gaps, queue wait, prefill and decode time.',
    'Pair offered, admitted, completed and goodput with KV occupancy, evictions and prefix-token hit rate.',
    'Cost = GPU dollars ÷ delivered output tokens over the same window; alert on tails, never averages.',
  ],
  plain:
    'A dashboard should answer three questions fast: are users getting tokens on time, why not, and what does it cost. Latency comes from histograms split by stage, pressure comes from queues and KV cache, and cost comes from dividing spend by tokens actually delivered. Keep labels bounded so the metrics system itself stays cheap.',
  analogy: {
    name: 'Hospital vital signs',
    map: [
      ['Heart rate and blood pressure', 'TTFT and token-gap percentiles'],
      ['Waiting-room head count', 'Queue depth and queue wait'],
      ['Bed occupancy', 'KV cache occupancy'],
      ['Patients treated vs turned away', 'Completed vs rejected requests'],
      ['Bill per patient', '$ per million output tokens'],
    ],
    breaks:
      'Vital signs describe one patient; serving metrics aggregate thousands of requests, so a healthy average can hide a sick 1 %. A monitor never harms the patient, but high-cardinality metrics can slow the serving stack.',
  },
  example: {
    title: 'Why a mean hides the incident',
    inputs: '10 one-minute windows, equal traffic. 9 minutes: every request 400 ms. 1 minute: 5 % of requests take 12 s (queue spike).',
    steps: [
      { label: 'Hour-level mean', state: '(9 × 400 + 1 × (0.95 × 400 + 0.05 × 12,000)) / 10\n= (3,600 + 980) / 10 = 458 ms' },
      { label: 'Spike-minute p50', state: '400 ms (95 % of requests unaffected)' },
      { label: 'Spike-minute p99', state: '12,000 ms (the slowest 5 % are all 12 s)' },
      { label: 'Pooled 10-minute p99', state: 'slow share = 5 % / 10 = 0.5 % < 1 %\n→ pooled p99 = 400 ms' },
      { label: 'Alert rule', state: 'p99 per 1-minute window > 2 s → fires in the spike minute' },
    ],
    output: 'Mean 458 ms and pooled p99 400 ms both look healthy; the 1-minute p99 of 12 s is the incident.',
    predict: {
      q: 'Pooling all 10 minutes, does p99 catch the spike?',
      a: 'No. Only 0.5 % of all requests are slow, so pooled p99 = 400 ms. Short windows (or p99.9) expose it.',
    },
  },
  scenes: [
    {
      id: 'q16-s1', title: 'One request, many timestamps', objective: 'See which spans a dashboard must measure.', duration: 18,
      narration: 'A request leaves the client, passes the gateway and waits in the queue. Prefill produces the first token, then decode streams the rest. Each boundary is a timestamp, and each gap is a metric. Client time to first token also includes network and proxy buffering.',
      lanes: [
        { label: 'Client', items: [{ label: 'send', kind: 'request' }, { label: 'first byte', kind: 'decode', at: 0.7 }, { label: 'last byte', kind: 'ok', at: 0.9 }] },
        { label: 'Server', items: [{ label: 'arrive', kind: 'request', at: 0.15 }, { label: 'queue wait', kind: 'neutral', at: 0.3 }, { label: 'prefill', kind: 'prefill', at: 0.45 }, { label: 'token 1', kind: 'decode', at: 0.6 }, { label: 'decode…', kind: 'decode', at: 0.8 }] },
        { label: 'Metrics', items: [{ label: 'queue_wait_seconds', kind: 'kv', at: 0.35 }, { label: 'ttft_seconds', kind: 'kv', at: 0.65 }, { label: 'inter_token_seconds', kind: 'kv', at: 0.85 }] },
      ],
      equation: 'client TTFT = server TTFT + network + proxy buffering',
      transition: 'Timestamps appear at each boundary, then turn into histogram metrics.', action: 'Name one span that only the client can see.',
    },
    {
      id: 'q16-s2', title: 'Histograms, not averages', objective: 'Show how a mean hides a slow tail.', duration: 18,
      narration: 'Ten requests: nine take 400 milliseconds and one takes 12 seconds. The mean is 1.56 seconds, which describes nobody. The median is 400 milliseconds and the 99th percentile is 12 seconds. Store histograms so you can compute both.',
      lanes: [
        { label: 'Requests', items: [...Array.from({ length: 9 }, (_, k) => ({ label: '0.4 s', kind: 'decode' as const, at: 0.05 + k * 0.03 })), { label: '12 s', kind: 'error', at: 0.4 }] },
        { label: 'Summaries', items: [{ label: 'mean 1.56 s', kind: 'neutral', at: 0.55, out: 0.85 }, { label: 'p50 0.4 s', kind: 'ok', at: 0.7 }, { label: 'p99 12 s', kind: 'error', at: 0.8 }] },
      ],
      equation: 'mean = (9 × 0.4 + 12) / 10 = 1.56 s',
      transition: 'The mean appears, then is struck out in favour of p50 and p99.', action: 'In the simulator, compare the mean line with p99 at minute 34.',
    },
    {
      id: 'q16-s3', title: 'Pressure gauges', objective: 'Link queue, KV occupancy, evictions and prefix hits.', duration: 18,
      narration: 'As load rises the queue grows and KV cache occupancy climbs. Past about 90 percent, the engine evicts or preempts, and the prefix-cache hit rate falls. That raises prefill work, which grows the queue further.',
      lanes: [
        { label: 'Queue depth', items: [{ label: '12', kind: 'request' }, { label: '40', kind: 'request', at: 0.25 }, { label: '160', kind: 'error', at: 0.6 }] },
        { label: 'KV occupancy', items: [{ label: '70 %', kind: 'kv' }, { label: '88 %', kind: 'kv', at: 0.3 }, { label: '97 %', kind: 'error', at: 0.55 }] },
        { label: 'Evictions', items: [{ label: 'blocks evicted', kind: 'error', at: 0.65 }] },
        { label: 'Prefix hit (tokens)', items: [{ label: '40 %', kind: 'comm', out: 0.7 }, { label: '15 %', kind: 'comm', at: 0.75 }] },
      ],
      equation: 'prefix hit rate = cached prompt tokens / prompt tokens',
      transition: 'Gauges climb together; the hit rate drops after evictions start.', action: 'Lower the KV pool size and watch the hit-rate line.',
    },
    {
      id: 'q16-s4', title: 'Goodput, not throughput', objective: 'Separate offered, admitted, completed and on-time work.', duration: 18,
      narration: 'Thirty requests per second are offered. Two are rejected, so 28 are admitted and completed. Only 22 meet the latency SLO. Goodput is 22, and that is the number users feel.',
      lanes: [
        { label: 'Offered', items: [{ label: '30 req/s', kind: 'request' }] },
        { label: 'Admitted', items: [{ label: '28 req/s', kind: 'request', at: 0.25 }, { label: '2 rejected', kind: 'error', at: 0.3 }] },
        { label: 'Completed', items: [{ label: '28 req/s', kind: 'decode', at: 0.5 }] },
        { label: 'Within SLO', items: [{ label: '22 req/s goodput', kind: 'ok', at: 0.75 }, { label: '6 late', kind: 'error', at: 0.8 }] },
      ],
      equation: 'goodput = requests meeting SLO / second = 22 req/s',
      transition: 'Each stage filters requests until only on-time ones remain.', action: 'Find the minute where completed stays high but goodput drops.',
    },
    {
      id: 'q16-s5', title: 'Cost per delivered token', objective: 'Compute $ per million output tokens from the same window.', duration: 18,
      narration: 'Sixteen GPUs at three dollars per hour cost 48 dollars per hour. If 6.5 million output tokens reach users in that hour, cost is 7.38 dollars per million tokens. Decide up front whether failed, cancelled or cached tokens count.',
      lanes: [
        { label: 'Spend', items: [{ label: '16 GPUs × $3/h', kind: 'kv' }, { label: '$48 / h', kind: 'kv', at: 0.3 }] },
        { label: 'Delivered', items: [{ label: '6.5 M tokens / h', kind: 'decode', at: 0.45 }, { label: 'failed tokens excluded', kind: 'error', at: 0.6 }] },
        { label: 'Unit cost', items: [{ label: '$7.38 / M tokens', kind: 'ok', at: 0.85 }] },
      ],
      equation: '$/M = 48 / 6.5 = $7.38',
      transition: 'Spend and delivered tokens combine into one unit cost.', action: 'Raise traffic in the simulator: does $/M fall?',
    },
  ],
  sim: {
    tldr: 'One seeded telemetry run feeds every chart; drag the minute cursor to link them and watch the mean stay calm while p99 spikes.',
    omits: [
      'Per-replica breakdowns and real trace sampling.',
      'Client-side network and rendering delays (server-side view only).',
      'Histogram bucket error: percentiles come from raw samples here.',
      'Cancellations and retries.',
    ],
  },
  formula: {
    name: 'Goodput and cost per delivered token',
    tex: String.raw`\text{goodput} = \frac{\#\{\text{requests meeting SLO}\}}{\Delta t}, \qquad \frac{\$}{\text{M tok}} = \frac{\sum \text{GPU cost}}{\text{delivered output tokens}} \times 10^{6}`,
    vars: [
      ['goodput', 'on-time requests per second', 'req/s'],
      ['Δt', 'measurement window', 's'],
      ['GPU cost', 'all GPU spend in the window, idle included', '$'],
      ['delivered output tokens', 'tokens that reached users', 'tokens'],
    ],
    assumptions: ['Same window for cost and tokens', 'Failed, rejected and cancelled tokens excluded (declare it)', 'SLO defined per request: TTFT and token-gap p99'],
    substituted: '16 GPUs × $3/h = $48/h; 6.5 M tokens/h delivered → 48 / 6.5 = $7.38 per M output tokens',
    check: '$ ÷ tokens × 10⁶ → $ per M tokens ✓',
    cue: 'Measure what users get; divide what you pay.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Histogram buckets per latency metric', value: '10–30', unit: 'buckets', assumptions: 'Log-spaced 10 ms – 60 s, dense near SLO', source: 'Prometheus histogram practice', evidence: 'assumed' },
    { quantity: 'Scrape interval', value: '10–30', unit: 's', assumptions: 'Shorter costs more storage', source: 'Common Prometheus default', evidence: 'assumed' },
    { quantity: 'Series, bounded labels', value: '3 models × 4 regions × 5 status = 60', unit: 'series/metric', assumptions: 'Per histogram bucket too', source: 'Product of label values', evidence: 'calculated' },
    { quantity: 'Series if labelled by request_id', value: '≈ requests per day (10⁷)', unit: 'series/metric', assumptions: 'Unbounded label', source: 'Product of label values', evidence: 'calculated' },
    { quantity: '$/M output tokens (example)', value: '7.38', unit: '$', assumptions: '$48/h, 6.5 M tok/h', source: 'Worked example', evidence: 'calculated' },
    { quantity: 'KV-occupancy alert threshold', value: '0.9', unit: 'ratio', assumptions: 'Evictions follow above this', source: 'Teaching assumption', evidence: 'assumed' },
  ],
  compare: {
    naive: 'One panel: GPU utilisation, average latency and requests per second.',
    improved: 'Per-stage latency histograms, goodput at SLO, KV and queue pressure, prefix-token hit rate and $ per delivered token, with bounded labels and trace exemplars.',
    mechanism: 'Short-window percentiles per stage show where time goes; goodput and unit cost tie it to users and money.',
    rows: [
      ['Detects tail incidents', 'No (mean)', 'Yes (p99 per window)'],
      ['Explains the cause', 'No', 'Queue vs prefill vs decode spans'],
      ['Cost visibility', 'GPU hours only', '$ per delivered M tokens'],
      ['Metrics storage', 'Low', 'Moderate; bounded labels keep it linear'],
    ],
  },
  lab: {
    title: 'Histogram buckets and percentile estimates', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 hist.py'], lang: 'python',
    code: `import bisect, random
BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]  # seconds, upper bounds (le)
counts = [0] * (len(BUCKETS) + 1)                      # last bucket = +Inf

def observe(x):
    counts[bisect.bisect_left(BUCKETS, x)] += 1

def quantile(q):
    target, cum = q * sum(counts), 0
    for i, c in enumerate(counts):
        if c and cum + c >= target:
            lo = BUCKETS[i - 1] if i else 0.0
            hi = BUCKETS[i] if i < len(BUCKETS) else BUCKETS[-1]
            return lo + (hi - lo) * (target - cum) / c   # linear inside the bucket
        cum += c

random.seed(16)
for _ in range(9900): observe(random.uniform(0.3, 0.5))
for _ in range(100):  observe(12.0)                   # 1 % tail at 12 s
print(f"p50={quantile(.5):.3f}s p99={quantile(.99):.3f}s p99.9={quantile(.999):.1f}s")
assert 0.25 <= quantile(0.50) <= 0.5
assert quantile(0.999) > 10        # tail lands in the 10-30 s bucket: 28 s, not 12 s`,
    checks: [
      'p50 ≈ 0.376 s (true ≈ 0.4 s): interpolation inside the 0.25–0.5 s bucket',
      'p99.9 estimated 28 s vs true 12 s: bucket boundaries set precision',
      'Merging replicas = adding counts per bucket, then one quantile',
    ],
    gaps: 'Not a Prometheus client: no exemplars, labels or time windows.',
  },
  bench: {
    hypothesis: 'The dashboard instrumentation costs < 1 % of output-token throughput.',
    baseline: 'Same server with metrics disabled.',
    controlled: ['Model, GPU, engine version', 'Arrival trace', 'Scrape interval', 'Label set'],
    workload: 'Open-loop trace at 70 % of saturation for 10 min.',
    warmup: '2 min discarded.', reps: '5 per arm, alternating order.',
    method: 'Compare output tokens/s and p99 TTFT; count series in the time-series database.',
    metrics: ['tokens/s', 'p99 TTFT', 'series count', 'scrape duration'],
    interpret: 'Overhead within run-to-run noise → keep. Series growing with traffic → an unbounded label slipped in. Results: not measured here.',
  },
  pitfalls: [
    'Alerting on mean latency: a 1 % tail barely moves it.',
    'Averaging per-replica p99s; sum histogram buckets, then compute the quantile.',
    'Labelling metrics with request_id or user_id: series count explodes.',
    'Reporting throughput without goodput: overload looks like success.',
    'Mixing server TTFT with client TTFT; proxy buffering lives between them.',
  ],
  optimizations: [
    ['Trace exemplars on histograms', 'Jump from a p99 bucket to one real trace; needs a tracing backend and sampling.'],
    ['Recording rules for p99 per window', 'Cheap dashboards; fixed windows can hide shorter spikes.'],
    ['Per-stage spans (queue, prefill, decode, flush)', 'Explains tails; small CPU cost per request.'],
  ],
  breaks: [
    'Very low traffic: a 1-minute p99 from 20 requests is noise; widen windows or count requests over the SLO.',
    'Coarse buckets near the SLO: alerts fire late or early.',
  ],
  interview: {
    short:
      'I organise the dashboard around three questions: are users getting tokens on time, why not, and what does it cost. For latency I keep histograms, never averages: client and server time to first token, inter-token gaps, total request duration, queue wait, and prefill and decode time, shown as p50, p95 and p99 over short windows. For load I track offered, admitted, completed, rejected and cancelled requests, plus goodput, meaning work delivered within the SLO. For pressure I watch queue depth, KV cache occupancy, evictions or preemptions, and the prefix-cache hit rate measured in tokens, not requests. GPU memory, bandwidth and compute utilisation stay on a diagnosis panel. For cost I divide GPU dollars by delivered output tokens over the same window. Labels stay bounded, such as model, region, route and status, never request or user IDs. Alerts fire on SLO burn rate and per-window p99, and every latency histogram links to sampled traces so the on-call engineer can see which span grew.',
    whiteboard: [
      'Draw the request timeline; mark each span you will measure.',
      'Sort metrics by type: histogram, counter, gauge.',
      'Write the goodput and $/M tokens formulas.',
      'Pick labels; cross out request_id.',
      'Write two alerts: SLO burn rate, and KV > 0.9 for 5 min.',
    ],
    followups: [
      ['Why prefix hit rate in tokens, not requests?', 'A request that reuses 10 of 4,000 tokens counts as a hit but saves almost nothing; tokens measure saved prefill work.'],
      ['How do you get fleet p99 from 50 replicas?', 'Sum histogram buckets across replicas, then compute the quantile. Never average per-replica p99s.'],
      ['GPU utilisation is 95 %. Healthy?', 'Not necessarily: it is the share of time a kernel runs, not useful work. Check goodput, batch size and bandwidth.'],
    ],
    debug: [
      'Dashboards show flat mean TTFT and steady GPU utilisation, yet users report freezes every few minutes.',
      'Plot 1-minute p99 TTFT and token-gap p99, and queue depth per replica. A periodic stall (long prefill, garbage collection) on one replica hides inside the hourly mean and the utilisation gauge.',
    ],
    calc: ['16 GPUs at $3/h deliver 6.5 M output tokens per hour. Cost per million output tokens?', '$48 / 6.5 = $7.38 per M output tokens.'],
  },
  changeMind: [
    'Traffic too low for stable per-minute percentiles.',
    'An existing tracing system already gives per-span histograms.',
    'Cost allocation rules that charge reserved or idle GPUs differently.',
  ],
  recall: [
    ['Why not alert on mean latency?', 'A small slow tail barely moves the mean.'],
    ['Fleet p99 from replicas?', 'Merge histogram buckets, then take the quantile.'],
    ['Goodput?', 'Work delivered within the SLO per unit time.'],
  ],
  glossary: [
    ['TTFT', 'Time to first token: from request arrival until the first output token is emitted.'],
    ['Goodput', 'Requests or tokens delivered within their SLO per second.'],
    ['SLO', 'Service-level objective, e.g. p99 TTFT ≤ 2 s.'],
    ['Cardinality', 'Number of distinct label combinations (time series) for one metric.'],
    ['Histogram metric', 'Counts of observations in fixed buckets; percentiles are estimated from them.'],
  ],
  tags: ['observability', 'metrics', 'latency', 'cost', 'slo', 'prometheus'],
};

const q17: Lesson = {
  id: 17,
  group: 'production',
  short: 'p99 = 10× p50',
  question: 'Your p99 latency is 10x your p50. Find the bottleneck and explain how you’d prove your diagnosis.',
  why: 'Tail latency is what users remember; the interviewer wants a method, not a guess.',
  tldr: [
    'p99 / p50 = 10 means a small group of requests waits or works much longer; find who they are first.',
    'Stratify by length, replica, cache status and retries; rule out bursts and coordinated omission.',
    'Prove it: reproduce, change one suspected cause, show p99 moves beyond noise while a control does not.',
  ],
  plain:
    'A 10× gap between median and p99 means most requests are fine and a few are not. Split latency by request properties until one group explains the tail. Then test that hypothesis by removing the cause and re-measuring on the same traffic.',
  analogy: {
    name: 'Supermarket checkout',
    map: [
      ['Shoppers arriving', 'Requests (open-loop arrivals)'],
      ['A full trolley', 'A long prompt'],
      ['One slow cashier', 'One degraded replica'],
      ['Shoppers who give up and rejoin', 'Client retries'],
      ['A coach party arriving at once', 'Bursty traffic'],
    ],
    breaks:
      'Shoppers pick the shortest line; random or hash routing does not. A GPU also serves many requests in one batch, so a long prompt slows everyone in the batch, not only the next in line.',
  },
  example: {
    title: 'Ten requests, one slow replica',
    inputs: '10 requests, 200 ms service each. Requests 3 and 8 land on replica R2, which is 5× slower. Request 8 arrives 400 ms after request 3.',
    steps: [
      { label: 'Normal requests (8)', state: '200 ms each' },
      { label: 'Request 3 on R2', state: '5 × 200 = 1,000 ms' },
      { label: 'Request 8 on R2', state: 'waits 1,000 − 400 = 600 ms, then 1,000 ms\n→ 1,600 ms' },
      { label: 'Sorted latencies', state: '200 × 8, 1,000, 1,600 ms' },
      { label: 'p50 / p90 / max', state: '200 / 1,000 / 1,600 ms → max / p50 = 8×' },
    ],
    output: 'Stratifying by replica isolates R2: its median is 1,300 ms; every other replica is 200 ms.',
    predict: {
      q: 'If request 8 times out at 500 ms and retries on a healthy replica, what latency does the user see?',
      a: '500 ms + 200 ms = 700 ms, and R2 still burns 1,000 ms on the abandoned request (wasted work, extra load).',
    },
  },
  scenes: [
    {
      id: 'q17-s1', title: 'Median vs tail', objective: 'See that a few slow requests set p99.', duration: 18,
      narration: 'Most requests finish in about 200 milliseconds. A handful take two seconds. The median stays at 200 milliseconds while the 99th percentile jumps to two seconds. The question is not how fast the system is, but who the slow requests are.',
      lanes: [
        { label: 'Fast requests', items: Array.from({ length: 7 }, (_, k) => ({ label: '0.2 s', kind: 'decode' as const, at: 0.05 + k * 0.05 })) },
        { label: 'Slow requests', items: [{ label: '2.0 s', kind: 'error', at: 0.45 }, { label: '1.8 s', kind: 'error', at: 0.5 }] },
        { label: 'Summary', items: [{ label: 'p50 0.2 s', kind: 'ok', at: 0.7 }, { label: 'p99 2.0 s', kind: 'error', at: 0.85 }] },
      ],
      equation: 'ratio = p99 / p50 = 2.0 / 0.2 = 10×',
      transition: 'Slow requests appear after the fast ones and pull p99 up.', action: 'Predict which group owns the tail before the next scene.',
    },
    {
      id: 'q17-s2', title: 'Stratify by cause', objective: 'Split latency by request properties.', duration: 18,
      narration: 'Split p99 by prompt length, replica, cache hit and retry status. Short prompts have a p99 of 0.3 seconds; long prompts 2.4 seconds. Replica 8 is slow for everyone. The group whose p99 matches the overall tail is the suspect.',
      lanes: [
        { label: 'By length', items: [{ label: 'short p99 0.3 s', kind: 'ok', at: 0.1 }, { label: 'long p99 2.4 s', kind: 'error', at: 0.25 }] },
        { label: 'By replica', items: [{ label: 'R1–R7 0.4 s', kind: 'ok', at: 0.4 }, { label: 'R8 2.1 s', kind: 'error', at: 0.5 }] },
        { label: 'By cache', items: [{ label: 'hit 0.3 s', kind: 'ok', at: 0.65 }, { label: 'miss 0.9 s', kind: 'kv', at: 0.7 }] },
        { label: 'By retry', items: [{ label: 'retried 4.0 s', kind: 'error', at: 0.85 }] },
      ],
      transition: 'Each split reveals a group far above the others.', action: 'Use the stratify chart in the simulator.',
    },
    {
      id: 'q17-s3', title: 'Queueing amplifies', objective: 'See why bursts and high utilisation stretch the tail.', duration: 18,
      narration: 'A burst of eight requests arrives at once. The queue grows faster than the server drains it, so later arrivals wait longer and longer. Near full utilisation, queue wait grows like rho over one minus rho, so ten percent more load can quadruple the wait.',
      lanes: [
        { label: 'Burst arrivals', items: Array.from({ length: 8 }, (_, k) => ({ label: `r${k + 1}`, kind: 'request' as const, at: 0.05 + k * 0.03 })) },
        { label: 'Queue', items: Array.from({ length: 6 }, (_, k) => ({ label: `wait ${(k + 1) * 0.2} s`, kind: 'neutral' as const, at: 0.35 + k * 0.05, out: 0.75 + k * 0.03 })) },
        { label: 'Latency', items: [{ label: '0.2 s', kind: 'ok', at: 0.4 }, { label: '0.8 s', kind: 'kv', at: 0.6 }, { label: '1.4 s', kind: 'error', at: 0.8 }] },
      ],
      equation: 'M/M/1: W_q ≈ ρ / (1 − ρ) × S̄;  ρ 0.7 → 0.9 ⇒ 3.9× longer wait',
      transition: 'Queue fills during the burst, then drains.', action: 'Raise burstiness to 3× and watch p99.',
    },
    {
      id: 'q17-s4', title: 'Measurement traps', objective: 'Recognise coordinated omission and non-additive percentiles.', duration: 18,
      narration: 'During a three-second stall, a closed-loop tester with six users sends only six requests, so only six samples are slow. Open-loop users keep arriving: ninety requests see the stall. Separately, adding the p99 of each stage overstates the end-to-end p99, because the slow cases rarely coincide.',
      lanes: [
        { label: 'Stall', items: [{ label: '3 s pause', kind: 'error', at: 0.05 }] },
        { label: 'Closed loop', items: [{ label: '6 slow samples', kind: 'neutral', at: 0.25 }, { label: 'p99 looks fine', kind: 'ok', at: 0.35 }] },
        { label: 'Open loop', items: [{ label: '90 slow requests', kind: 'error', at: 0.45 }, { label: 'real p99', kind: 'error', at: 0.55 }] },
        { label: 'Percentiles', items: [{ label: 'Σ stage p99 = 2.9 s', kind: 'kv', at: 0.7 }, { label: '≠ e2e p99 2.1 s', kind: 'error', at: 0.85 }] },
      ],
      equation: 'p99(A + B) ≠ p99(A) + p99(B)',
      transition: 'The closed-loop view hides the stall; the open-loop view shows it.', action: 'Add a 3 s stall in the simulator and compare closed-loop p99.',
    },
    {
      id: 'q17-s5', title: 'Prove it', objective: 'Turn a hypothesis into evidence.', duration: 18,
      narration: 'Hypothesis: replica 8 is slow. Replay the same arrivals, open loop, and drain only replica 8. p99 falls from two seconds to 0.4 seconds. As a control, drain a healthy replica instead: p99 does not improve. Repeat five times and report a confidence interval.',
      lanes: [
        { label: 'Hypothesis', items: [{ label: 'R8 is slow', kind: 'request' }] },
        { label: 'Intervention', items: [{ label: 'drain R8', kind: 'decode', at: 0.2 }, { label: 'p99 2.0 s', kind: 'error', at: 0.3, out: 0.5 }, { label: 'p99 0.4 s', kind: 'ok', at: 0.5 }] },
        { label: 'Control', items: [{ label: 'drain R3 instead', kind: 'neutral', at: 0.65 }, { label: 'p99 unchanged', kind: 'neutral', at: 0.75 }] },
        { label: 'Repeat', items: [{ label: '5 seeds, CI', kind: 'ok', at: 0.9 }] },
      ],
      equation: 'effect ≫ run-to-run spread, control ≈ 0',
      transition: 'p99 drops only for the real intervention.', action: 'Apply each fix in the simulator and compare before and after.',
    },
  ],
  sim: {
    tldr: 'A seeded open-loop queue across 8 replicas; add bursts, a slow replica, long prompts, retries or a stall, then apply one fix and compare p99 on identical arrivals.',
    omits: [
      'Batching: each replica serves one request at a time (first come, first served).',
      'Load-aware routing: replicas are picked at random.',
      'Streaming: latency is total request time, not TTFT or token gaps.',
      'Retry backoff and jitter; at most one retry.',
    ],
  },
  formula: {
    name: 'Queue wait near the knee (model) and percentile rule',
    tex: String.raw`W_q \approx \frac{\rho}{1-\rho}\,\bar S \;\;(\text{M/M/1}), \qquad p_{99}(A+B) \ne p_{99}(A) + p_{99}(B)`,
    vars: [
      ['ρ', 'utilisation = arrival rate × mean service time', '—'],
      ['S̄', 'mean service time', 'ms'],
      ['W_q', 'mean queue wait', 'ms'],
      ['p99(X)', '99th percentile of X', 'ms'],
    ],
    assumptions: ['M/M/1: Poisson arrivals, exponential service, one server', 'Batched GPU servers differ; use this only for the shape of the knee', 'Percentiles do not add unless slow cases always coincide'],
    substituted: 'ρ = 0.7, S̄ = 190 ms → W_q ≈ 0.7 / 0.3 × 190 = 443 ms; ρ = 0.9 → 9 × 190 = 1,710 ms (3.9× for +29 % load)',
    check: 'dimensionless × ms → ms ✓',
    cue: 'Near the knee, a little load means a lot of wait; percentiles never add.',
    isModel: true,
  },
  estimates: [
    { quantity: 'p99 / p50 of a healthy M/M/1 response time', value: '6.6', unit: '×', assumptions: 'Exponential: ln 100 / ln 2', source: 'Calculated', evidence: 'calculated' },
    { quantity: 'Samples for a stable p99', value: '≥ 1,000', unit: 'requests', assumptions: '≈ 10 points above the percentile', source: 'Rule of thumb', evidence: 'assumed' },
    { quantity: 'Samples for p99.9', value: '≥ 10,000', unit: 'requests', assumptions: 'Same rule', source: 'Rule of thumb', evidence: 'assumed' },
    { quantity: 'Wait growth, ρ 0.7 → 0.9', value: '3.9', unit: '×', assumptions: 'M/M/1', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Sim default: p99 / p50', value: '≈ 6.8', unit: '×', assumptions: 'Normal preset, seed 17', source: 'This app (tailSim())', evidence: 'simulated' },
  ],
  compare: {
    naive: 'Look at the p99 panel, guess “GPU is slow”, add replicas.',
    improved: 'Check measurement, stratify by cause, trace slow requests, intervene on one variable, compare before/after with confidence intervals and a control.',
    mechanism: 'Finding the group that owns the tail turns a guess into a testable hypothesis.',
    rows: [
      ['Time to diagnosis', 'Days of guessing', 'Hours with traces'],
      ['Cost', 'More GPUs; tail persists', 'Targeted fix'],
      ['Confidence', 'Anecdote', 'Before/after with CI and a control'],
      ['Retry storms', 'Unnoticed', 'Measured explicitly'],
    ],
  },
  lab: {
    title: 'Stratify a latency log by cause', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 stratify.py'], lang: 'python',
    code: `import random
random.seed(17)
rows = []  # (latency_ms, replica, long_prompt)
for _ in range(5000):
    rep, long = random.randrange(8), random.random() < 0.05
    ms = random.expovariate(1 / 150) + 50
    if long: ms *= 6
    if rep == 7: ms *= 4                          # one degraded replica
    rows.append((ms, rep, long))

def p(xs, q):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))]

allv = [r[0] for r in rows]
print(f"all      n={len(allv)} p50={p(allv, .5):.0f} p99={p(allv, .99):.0f}")
for name, f in [("replica7", lambda r: r[1] == 7), ("long", lambda r: r[2]),
                ("rest", lambda r: r[1] != 7 and not r[2])]:
    xs = [r[0] for r in rows if f(r)]
    print(f"{name:8} n={len(xs)} p99={p(xs, .99):.0f}")
rest = [r[0] for r in rows if r[1] != 7 and not r[2]]
assert p(rest, .99) < p(allv, .99) / 2            # the two causes own the tail`,
    checks: ['all p99 ≈ 2,471 ms; rest p99 ≈ 760 ms', 'replica7 p99 ≈ 5,630 ms and long p99 ≈ 8,856 ms', 'Fixed seed → identical output'],
    gaps: 'Synthetic log. In production, join latency with replica, cache and retry fields from traces.',
  },
  bench: {
    hypothesis: 'Draining replica R7 cuts end-to-end p99 by more than 30 % at the same offered load.',
    baseline: 'Current fleet, same arrival trace.',
    controlled: ['Arrival trace replayed open loop', 'Prompt/output length mix', 'Model and engine version', 'Time of day and co-tenants'],
    workload: 'Replay 30 min of production arrivals (scaled) through an open-loop generator.',
    warmup: '5 min.', reps: '5 alternating A/B runs plus a control (drain a healthy replica).',
    method: 'Client timestamps at scheduled send and last byte; fine histogram buckets near p99; retries counted separately.',
    metrics: ['p50 / p99 / p99.9', 'retry rate', 'per-replica p99', 'queue wait'],
    interpret: 'Effect larger than the bootstrap CI of p99, and no change in the control, confirms the diagnosis. Results: not measured here.',
  },
  pitfalls: [
    'Closed-loop load tests (coordinated omission) under-report tails.',
    'Adding stage p99s to explain the end-to-end p99.',
    'Too few samples: a p99 from 200 requests rests on 2 points.',
    'Ignoring retries: they add load and hide original latency.',
    'Averaging p99 across replicas or time windows.',
  ],
  optimizations: [
    ['Separate pool or chunked prefill for long prompts', 'Shorter tail for short requests; pool sizing and imbalance risk.'],
    ['Retry budgets with backoff and jitter', 'Prevents retry storms; some failures stay failed.'],
    ['Outlier ejection or load-aware routing', 'Removes slow replicas fast; can overload the rest if many are ejected.'],
  ],
  breaks: [
    'Utilisation near 1: every fix helps little until load drops or capacity rises.',
    'Rare events (a stall every hour): short tests miss them; run long soak tests.',
  ],
  interview: {
    short:
      'First I check the measurement: is the load generator open loop, are client and server timestamps separate, and do I have enough samples, roughly a thousand per window for a stable p99. Then I stratify. I split latency by prompt and output length, replica, cache hit or miss, tenant and retry status, and I read the critical path of slow traces: queue wait versus prefill versus decode versus network. Usually one group owns the tail: long prompts blocking short ones, one degraded replica, bursts pushing utilisation past the knee, or retries amplifying load. I never add stage p99s to explain the end-to-end p99, because the slow cases rarely coincide. To prove a diagnosis I state a hypothesis such as “replica 7 is slow”, replay the same arrival trace open loop, change only that factor, and compare p99 before and after over several runs with a confidence interval. I also run a control, such as draining a healthy replica, to rule out a simple capacity effect. If only the real intervention moves p99 beyond noise, the diagnosis holds.',
    whiteboard: [
      'Draw the latency CDF; mark p50 and p99.',
      'Table: p99 by length, replica, cache, retry.',
      'Trace one slow request: which span grew?',
      'Write the M/M/1 wait to show the knee.',
      'Design the A/B intervention plus a control, with N runs.',
    ],
    followups: [
      ['What is coordinated omission?', 'A closed-loop tester waits for slow responses before sending more, so it under-samples the slow periods. Use open-loop arrivals or correct for missed sends.'],
      ['Why not sum stage p99s?', 'Percentiles are not additive; the slowest 1 % of each stage are usually different requests, so the sum overstates end-to-end p99.'],
      ['How many samples for p99.9?', 'About 10,000 per window to have about 10 points above it; otherwise report it with a wide CI.'],
    ],
    debug: [
      'p99 doubled after a deploy, but every per-stage p99 is unchanged.',
      'The correlation changed: slow stages now hit the same requests (e.g. long prefills now also wait in queue), or retries were enabled. Compare per-request critical paths, not per-stage percentiles.',
    ],
    calc: ['Exponential response times with mean 300 ms. What are p50 and p99?', 'p50 = 0.693 × 300 = 208 ms; p99 = 4.605 × 300 = 1,382 ms (6.6×).'],
  },
  changeMind: [
    'Traces show time spread evenly across all requests (no group owns the tail): it is utilisation; add capacity.',
    'The tail appears only in client metrics: look at network and proxy buffering, not the engine.',
    'The tail appears only at fixed times: periodic jobs or garbage collection, not load.',
  ],
  recall: [
    ['Coordinated omission?', 'Closed-loop testers skip sends during stalls and hide the tail.'],
    ['Do percentiles add?', 'No.'],
    ['Proof of a diagnosis?', 'An intervention on one cause moves p99 beyond noise; a control does not.'],
  ],
  glossary: [
    ['p50 / p99', 'Median and 99th-percentile latency.'],
    ['Open loop', 'The load generator sends on a schedule regardless of responses.'],
    ['Closed loop', 'Each virtual user waits for a response before sending the next request.'],
    ['Coordinated omission', 'Measurement bias where a closed-loop tester stops sending during slow periods.'],
    ['Stratify', 'Split measurements by a property and compare the groups.'],
  ],
  tags: ['tail latency', 'p99', 'queueing', 'debugging', 'measurement', 'retries'],
};

const q18: Lesson = {
  id: 18,
  group: 'production',
  short: 'Engine benchmark',
  question:
    'Benchmark vLLM, TensorRT-LLM, and SGLang on the same realistic workload. What would make you choose one over the others?',
  why: 'Engine choice locks in months of work; the interviewer checks whether you can run a fair, reproducible comparison.',
  tldr: [
    'Fix everything except the engine: model, tokenizer, GPUs, precision, lengths, arrivals, cache state, tuning budget.',
    'Report throughput at your latency SLO from open-loop sweeps, plus tails, errors, memory and startup time.',
    'Choose on goodput at SLO, quality parity, required features and operating cost; there is no universal winner.',
  ],
  plain:
    'A fair benchmark changes one thing, the engine, and holds the workload constant. Sweep arrival rates open loop, find the highest rate that meets the SLO, and repeat runs to get uncertainty. Then weigh that number against features, stability and how easily your team can operate it.',
  analogy: {
    name: 'Test-driving delivery vans',
    map: [
      ['Same route, same parcels', 'Same model, prompts and arrival trace'],
      ['Delivery deadline', 'TTFT and token-gap SLO'],
      ['Parcels delivered on time per hour', 'Goodput at SLO'],
      ['Fuel and maintenance', 'GPU cost and operational effort'],
      ['Fridge or tail lift', 'Engine features: LoRA, structured output, speculative decoding'],
    ],
    breaks:
      'A van does not change with tuning; engines do, so equal tuning effort is part of the control. A van test result lasts years; engine versions change monthly, so results expire.',
  },
  example: {
    title: 'Peak throughput vs throughput at SLO (illustrative model)',
    inputs: 'Config A: saturates at 12,000 tok/s, empty-queue TTFT 250 ms. Config B: 15,000 tok/s, 700 ms. 300 output tokens per request. SLO: p99 TTFT ≤ 2,000 ms.',
    steps: [
      { label: 'Offered load', state: 'λ req/s × 300 tokens' },
      { label: 'Utilisation', state: 'ρ = λ × 300 / capacity' },
      { label: 'p99 TTFT model', state: 'base + base / (1 − ρ) × ln(100ρ)' },
      { label: 'A meets 2 s up to', state: 'ρ ≈ 0.455 → λ* ≈ 18.2 req/s' },
      { label: 'B meets 2 s up to', state: 'ρ ≈ 0.058 → λ* ≈ 2.9 req/s' },
    ],
    output: 'B has 25 % more peak throughput but about 6× less throughput at the SLO.',
    predict: {
      q: 'How loose must the SLO be before B wins?',
      a: 'Very loose: at 5 s A still wins (30.9 vs 20.0 req/s); only around 20 s does B lead (42.0 vs 37.7). Ranking depends on the SLO.',
    },
  },
  scenes: [
    {
      id: 'q18-s1', title: 'Hold everything else fixed', objective: 'List the controlled variables.', duration: 18,
      narration: 'Only the engine may change. The model weights, tokenizer and chat template stay fixed, as do the GPUs and topology, the precision, the length distributions, the arrival trace and the cache warm-up. Each engine also gets the same tuning budget.',
      lanes: [
        { label: 'Fixed', items: [
          { label: 'model + tokenizer', kind: 'neutral', at: 0.05 }, { label: 'GPU + topology', kind: 'neutral', at: 0.15 }, { label: 'precision + KV dtype', kind: 'neutral', at: 0.25 },
          { label: 'length mix', kind: 'neutral', at: 0.35 }, { label: 'arrival trace', kind: 'neutral', at: 0.45 }, { label: 'cache warm-up', kind: 'neutral', at: 0.55 }, { label: 'tuning budget', kind: 'neutral', at: 0.65 },
        ] },
        { label: 'Varies', items: [{ label: 'vLLM', kind: 'request', at: 0.75 }, { label: 'TensorRT-LLM', kind: 'request', at: 0.8 }, { label: 'SGLang', kind: 'request', at: 0.85 }] },
      ],
      transition: 'Controls stack up before the engines appear.', action: 'Uncheck a control in the simulator and read the warning.',
    },
    {
      id: 'q18-s2', title: 'Open-loop rate sweep', objective: 'See why rate, not concurrency, is the input.', duration: 18,
      narration: 'Send requests on a fixed schedule at 2, 4, 8 and 16 requests per second, without waiting for responses. Each rate is one run, after a warm-up, repeated several times. Past saturation the queue grows without bound, and the engine must shed load gracefully.',
      lanes: [
        { label: 'Rates', items: [{ label: '2 req/s', kind: 'request', at: 0.1 }, { label: '4 req/s', kind: 'request', at: 0.25 }, { label: '8 req/s', kind: 'request', at: 0.4 }, { label: '16 req/s', kind: 'request', at: 0.55 }] },
        { label: 'p99 TTFT', items: [{ label: '0.3 s', kind: 'ok', at: 0.15 }, { label: '0.5 s', kind: 'ok', at: 0.3 }, { label: '1.2 s', kind: 'kv', at: 0.45 }, { label: 'overload', kind: 'error', at: 0.7 }] },
        { label: 'Repeats', items: [{ label: '× 5 runs each', kind: 'neutral', at: 0.85 }] },
      ],
      equation: 'ρ = λ × output tokens / capacity',
      transition: 'Each new rate adds a point; the last one overloads.', action: 'Sweep the SLO slider and watch the vertical λ* lines move.',
    },
    {
      id: 'q18-s3', title: 'Throughput at SLO', objective: 'Rank by goodput at the SLO, not peak tokens per second.', duration: 18,
      narration: 'Config B has the higher peak, 15,000 tokens per second. But its empty-queue time to first token is 700 milliseconds, so it crosses the two-second SLO at only 2.9 requests per second. Config A stays under the SLO up to 18.2 requests per second.',
      lanes: [
        { label: 'Config A', items: [{ label: 'peak 12k tok/s', kind: 'prefill', at: 0.1 }, { label: 'λ* 18.2 req/s', kind: 'ok', at: 0.6 }] },
        { label: 'Config B', items: [{ label: 'peak 15k tok/s', kind: 'prefill', at: 0.25, out: 0.75 }, { label: 'λ* 2.9 req/s', kind: 'error', at: 0.7 }] },
      ],
      equation: 'λ* = max λ such that p99 TTFT(λ) ≤ SLO',
      transition: 'B’s peak advantage is struck out once the SLO applies.', action: 'Find an SLO where B wins.',
    },
    {
      id: 'q18-s4', title: 'Beyond speed', objective: 'List the non-speed decision factors.', duration: 18,
      narration: 'Speed is one column. Check output quality on an evaluation set, error rate under overload, memory headroom and startup time. Then features you need, such as structured output, LoRA adapters or speculative decoding, and the cost of operating and upgrading the engine.',
      lanes: [
        { label: 'Must pass', items: [{ label: 'quality parity', kind: 'ok', at: 0.1 }, { label: 'errors < budget', kind: 'ok', at: 0.2 }, { label: 'graceful overload', kind: 'ok', at: 0.3 }] },
        { label: 'Measure', items: [{ label: 'memory headroom', kind: 'kv', at: 0.45 }, { label: 'startup to ready', kind: 'neutral', at: 0.55 }] },
        { label: 'Fit', items: [{ label: 'features needed', kind: 'request', at: 0.7 }, { label: 'ops + upgrades', kind: 'comm', at: 0.85 }] },
      ],
      transition: 'Decision factors appear in order of importance.', action: 'Write your own must-pass list.',
    },
    {
      id: 'q18-s5', title: 'Decide and record', objective: 'Make the result reproducible and time-stamped.', duration: 18,
      narration: 'Pick the engine with the highest goodput at your SLO among those that pass quality and features. If confidence intervals overlap, decide on operations. Record versions, flags, model hash, driver, commands and raw per-request results, so the benchmark can be re-run on every upgrade.',
      lanes: [
        { label: 'Decision', items: [{ label: 'filter: quality + features', kind: 'ok', at: 0.1 }, { label: 'rank: λ* with CI', kind: 'ok', at: 0.3 }, { label: 'tie → ops cost', kind: 'neutral', at: 0.45 }] },
        { label: 'Record', items: [{ label: 'versions + flags', kind: 'comm', at: 0.6 }, { label: 'model hash, driver', kind: 'comm', at: 0.7 }, { label: 'raw JSONL', kind: 'comm', at: 0.8 }, { label: 're-run on upgrade', kind: 'request', at: 0.9 }] },
      ],
      transition: 'The decision rule resolves, then the record is written.', action: 'Open labs/benchmark.py and note what it records.',
    },
  ],
  sim: {
    tldr: 'Build the experiment matrix and see its cost; the curves use a generic queueing model with editable parameters, not real engine data.',
    omits: [
      'Real engine behaviour: batching, chunked prefill, prefix caching, CUDA graphs.',
      'Token-gap (ITL) SLOs; only TTFT is modelled.',
      'Length distributions: every request outputs the same number of tokens.',
      'Quality, memory and startup measurements.',
    ],
  },
  formula: {
    name: 'Throughput at SLO (decision rule)',
    tex: String.raw`\lambda^{*} = \max\{\lambda : p_{99}\,\mathrm{TTFT}(\lambda) \le \mathrm{SLO}_{TTFT},\; p_{99}\,\mathrm{ITL}(\lambda) \le \mathrm{SLO}_{ITL},\; \text{errors} \le \epsilon\}`,
    vars: [
      ['λ', 'open-loop arrival rate', 'req/s'],
      ['λ*', 'highest rate meeting every SLO', 'req/s'],
      ['p99 TTFT(λ)', 'measured tail time to first token at rate λ', 'ms'],
      ['ITL', 'inter-token latency', 'ms'],
      ['ε', 'allowed error rate', '%'],
    ],
    assumptions: ['Same workload and hardware for every engine', 'Open-loop arrivals from a realistic trace', 'Quality parity checked separately'],
    substituted: 'Illustrative: config A λ* ≈ 18.2 req/s × 300 tok = 5,460 tok/s at SLO; config B λ* ≈ 2.9 req/s (≈ 860 tok/s) despite the higher peak',
    check: 'req/s × tokens/req → tokens/s ✓',
    cue: 'Rank by goodput at your SLO, not by peak tokens per second.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Arrival rates per sweep', value: '6–12', unit: 'points', assumptions: 'Dense near the knee', source: 'Protocol choice', evidence: 'assumed' },
    { quantity: 'Repetitions per point', value: '≥ 3 (5 preferred)', unit: 'runs', assumptions: 'For a confidence interval', source: 'Protocol choice', evidence: 'assumed' },
    { quantity: 'Run length per point', value: '5–10', unit: 'min', assumptions: 'After warm-up; enough for p99', source: 'Protocol choice', evidence: 'assumed' },
    { quantity: '3 engines × 2 configs × 8 rates × 5 reps', value: '240', unit: 'runs', assumptions: 'As listed', source: 'matrixRuns()', evidence: 'calculated' },
    { quantity: 'GPU-hours for that matrix (8 GPUs, 6 min/run)', value: '192', unit: 'GPU-h', assumptions: '240 × 0.1 h × 8', source: 'Calculated', evidence: 'calculated' },
    { quantity: 'vLLM / TensorRT-LLM / SGLang throughput', value: 'not measured', unit: '—', assumptions: 'Run labs/benchmark.py on your hardware', source: 'This app', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Run each engine’s own benchmark script with default flags and compare peak tokens per second.',
    improved: 'Same model, hardware, precision, trace and cache state; open-loop rate sweep; throughput at SLO with CIs; plus quality, errors, memory, startup and features.',
    mechanism: 'Controlling the workload isolates the engine; the SLO turns raw speed into user-relevant capacity.',
    rows: [
      ['Validity', 'Different workloads per engine', 'One trace, one model, recorded versions'],
      ['Headline metric', 'Peak tokens/s (closed loop)', 'Goodput at SLO (open loop)'],
      ['Uncertainty', 'Single run', '≥ 3 reps with CI'],
      ['Cost', 'Minutes', '≈ 200 GPU-hours for a full matrix'],
    ],
  },
  lab: {
    title: 'Open-loop SSE benchmark harness', kind: 'cpu', file: 'labs/benchmark.py',
    deps: 'Python 3.10+ client; an OpenAI-compatible server per engine (GPU) for real numbers',
    commands: ['python3 labs/benchmark.py --url http://localhost:8000/v1/completions --rate 4 --duration 60 --out results.jsonl'],
    lang: 'python',
    code: `import asyncio, random, time

async def open_loop(send, rate_rps, duration_s, seed=18):
    """Send on a Poisson schedule; never wait for a response before the next send."""
    rng, tasks, t0, next_at = random.Random(seed), [], time.perf_counter(), 0.0
    while next_at < duration_s:
        await asyncio.sleep(max(0.0, t0 + next_at - time.perf_counter()))
        tasks.append(asyncio.create_task(send(scheduled=t0 + next_at)))
        next_at += rng.expovariate(rate_rps)
    return await asyncio.gather(*tasks, return_exceptions=True)

# Latency counts from the *scheduled* send time, so a stalled client
# cannot hide server delay (no coordinated omission).
async def fake_send(scheduled):
    await asyncio.sleep(0.01)
    return time.perf_counter() - scheduled

res = asyncio.run(open_loop(fake_send, rate_rps=50, duration_s=1))
print(len(res), "requests, min latency", round(min(res), 4))
assert 30 < len(res) < 75 and all(r >= 0.009 for r in res)`,
    checks: [
      'Sends follow a Poisson schedule regardless of response time',
      'Latency is measured from the scheduled send time',
      'Record engine version, flags, model hash, GPU and driver with every result',
    ],
    gaps: 'The snippet uses a fake sender; labs/benchmark.py talks to a real server. Engines must be launched with equivalent settings. No GPU results are measured in this app.',
  },
  bench: {
    hypothesis: 'At p99 TTFT ≤ 2 s and p99 ITL ≤ 100 ms, one engine sustains a higher arrival rate than the others on our trace.',
    baseline: 'Current production engine and configuration.',
    controlled: ['Model weights, tokenizer, chat template', 'GPU SKU, count, topology, driver/CUDA', 'Precision and KV dtype', 'Production input/output length distribution', 'Arrival trace and cache warm-up procedure', 'Maximum tuning time per engine'],
    workload: 'Production-sampled prompts; open-loop rate sweep from 10 % to 110 % of estimated saturation.',
    warmup: '2 min per point, discarded.', reps: '5 per point, randomised engine order.',
    method: 'labs/benchmark.py: per-request scheduled send, first byte, per-token and end timestamps; errors and retries recorded.',
    metrics: ['λ* at SLO', 'p50 / p99 TTFT and ITL', 'error rate', 'peak memory', 'startup to ready', 'quality score on eval set'],
    interpret: 'Prefer the engine whose λ* CI is higher with quality parity; if CIs overlap, decide on features and operating cost. Results: not measured here.',
  },
  pitfalls: [
    'Comparing different quantization or KV dtypes across engines.',
    'Closed-loop tools with fixed concurrency: they hide overload behaviour.',
    'Tuning one engine for a week and another for an hour.',
    'Counting characters or SSE events as tokens.',
    'Publishing one run without versions, flags or a CI.',
  ],
  optimizations: [
    ['Bisect the arrival rate near the knee', 'Fewer runs; may miss non-monotonic behaviour.'],
    ['Replay real production traces', 'Realistic; needs privacy review and scrubbing.'],
    ['Automate the matrix in CI', 'Catches regressions on upgrades; costs GPU-hours every week.'],
  ],
  breaks: [
    'The workload changes (longer contexts, new features): the ranking may flip.',
    'Engines release monthly: results expire; re-run on every upgrade.',
  ],
  interview: {
    short:
      'I treat it as a controlled experiment where the engine is the only variable. I fix the model weights, tokenizer and chat template, the GPU type and topology, and the precision including KV dtype. I replay a production-like workload: real input and output length distributions and an open-loop arrival trace, with the same cache warm-up for every engine. Each engine gets the same tuning budget, and I record versions and flags. Then I sweep the arrival rate from light load past saturation, with warm-up and at least three repetitions per point, measuring TTFT and inter-token latency tails, errors and successful output tokens. The headline number is throughput at SLO: the highest rate where p99 TTFT and token gaps meet targets with errors under budget. I also check output quality on an eval set, memory headroom, startup time, overload behaviour, and features we need, such as structured output, LoRA or speculative decoding. I choose the engine with the best goodput at our SLO and quality parity; if results overlap within noise, I decide on features, stability and how easily my team can operate it. There is no universal winner.',
    whiteboard: [
      'Table of controlled variables vs the one varied.',
      'Plot p99 TTFT vs arrival rate with an SLO line for each engine.',
      'Mark λ* per engine with error bars.',
      'Second table: quality, errors, memory, startup, features.',
      'Decision rule, and when to re-run.',
    ],
    followups: [
      ['Why open loop?', 'Real users do not wait for each other; closed-loop testers slow down under load and hide queueing and overload.'],
      ['Engine A wins on throughput but crashes under overload. Choose it?', 'Usually not: overload behaviour (bounded queues, shedding, no crash) is part of the SLO. Re-test with admission control.'],
      ['How do you check output equivalence?', 'Same weights and template, greedy decoding on a fixed eval set; compare scores and token-level agreement. Large differences point to kernel or config bugs.'],
    ],
    debug: [
      'Engine B showed 2× the throughput of A in your benchmark, but production on B is slower.',
      'Check the controls: the benchmark used shorter outputs, a warm prefix cache or closed-loop concurrency, while production has longer prompts and bursts. Replay the production trace open loop.',
    ],
    calc: ['3 engines × 2 configs × 10 rates × 5 reps, 6 min per run on 8 GPUs. GPU-hours?', '300 runs × 0.1 h × 8 GPUs = 240 GPU-hours.'],
  },
  changeMind: [
    'A required feature (structured output, a specific quantization) is missing in the leader.',
    'Quality differs beyond tolerance on our evals.',
    'Operating cost: team expertise, upgrade cadence, observability support.',
  ],
  recall: [
    ['Headline metric?', 'Throughput at SLO (goodput), measured open loop.'],
    ['Minimum repetitions?', '3, preferably 5, with a CI.'],
    ['Universal winner?', 'No; it depends on workload, hardware and SLO.'],
  ],
  glossary: [
    ['vLLM', 'Open-source LLM serving engine built around PagedAttention.'],
    ['TensorRT-LLM', 'NVIDIA library for compiled, optimised LLM inference on NVIDIA GPUs.'],
    ['SGLang', 'Open-source serving framework with RadixAttention prefix caching.'],
    ['λ* (rate at SLO)', 'Highest arrival rate meeting all latency and error targets.'],
    ['ITL', 'Inter-token latency: the gap between consecutive output tokens.'],
  ],
  tags: ['benchmark', 'vllm', 'tensorrt-llm', 'sglang', 'slo', 'methodology'],
};

const q19: Lesson = {
  id: 19,
  group: 'production',
  short: 'Safe model rollout',
  question:
    'Roll out a new model or quantization format without breaking production. Design the evaluation, canary, and rollback strategy.',
  why: 'Model changes fail quietly: outputs still look fluent while quality, tool calls or latency regress.',
  tldr: [
    'Gate each stage: offline evals, shadow traffic, then a 1 → 10 → 50 → 100 % canary with fixed holds.',
    'Size every gate: samples to detect the smallest drop you care about, plus error-budget burn limits.',
    'Make rollback instant: versioned routing, immutable artifacts, warm old capacity, separate cache namespaces.',
  ],
  plain:
    'Treat a new model or quantization like a risky deploy. Prove quality offline, then expose it to more traffic in steps, and at each step compare it with the current version using enough samples to see a real drop. Keep the old version warm so rollback is a routing change, not a redeploy.',
  analogy: {
    name: 'New recipe in a restaurant chain',
    map: [
      ['Kitchen taste test', 'Offline evaluation suite'],
      ['Cook it alongside, do not serve it', 'Shadow traffic'],
      ['Serve it at one branch', 'Canary at 1 %'],
      ['Complaints per 1,000 meals', 'Quality and error-rate gates'],
      ['Old recipe still stocked', 'Warm previous version for rollback'],
    ],
    breaks:
      'A chef can taste every plate; you can only sample, so statistical power matters. Model regressions are often invisible per request (slightly worse answers) and only show up in aggregates.',
  },
  example: {
    title: 'How many samples to see a 2-point drop?',
    inputs: 'Baseline pass rate 90 %. Smallest drop to detect: 2 points (to 88 %). One-sided α = 0.05, power 0.8. Live traffic 50,000 req/h.',
    steps: [
      { label: 'z values', state: 'z_α = 1.645, z_β = 0.842' },
      { label: 'Pooled p̄', state: '(0.90 + 0.88) / 2 = 0.89' },
      { label: 'Numerator', state: '(1.645 × √(2 × 0.89 × 0.11) + 0.842 × √(0.09 + 0.1056))²\n= (0.728 + 0.372)² = 1.210' },
      { label: 'Divide by d²', state: '1.210 / 0.02² = 3,025.4 → 3,026 per arm' },
      { label: 'Canary hold', state: '1 % of 50,000 = 500 req/h → 3,026 / 500 ≈ 6.1 h' },
    ],
    output: 'A 1 % canary needs about 6 hours at 50,000 req/h to detect a 2-point drop; a 2-hour hold is underpowered.',
    predict: {
      q: 'To detect a 1-point drop instead, roughly how many samples per arm?',
      a: '≈ 11,620 per arm, about 3.8× more: n scales with 1 / drop².',
    },
  },
  scenes: [
    {
      id: 'q19-s1', title: 'Offline gates first', objective: 'List what must pass before any user sees the model.', duration: 18,
      narration: 'Before any live traffic, run a fixed evaluation suite against the current version. Check task quality, safety, structured output and tool-call schemas, and long-context behaviour. Also check latency and memory fit on the target hardware. Each check has a threshold set in advance.',
      lanes: [
        { label: 'Eval suites', items: [{ label: 'task quality', kind: 'ok', at: 0.1 }, { label: 'safety', kind: 'ok', at: 0.25 }, { label: 'tool-call schema', kind: 'ok', at: 0.4 }, { label: 'long context', kind: 'ok', at: 0.55 }] },
        { label: 'Fit', items: [{ label: 'p99 TTFT on target GPU', kind: 'prefill', at: 0.7 }, { label: 'memory headroom', kind: 'kv', at: 0.8 }] },
        { label: 'Gate', items: [{ label: 'pass → shadow', kind: 'ok', at: 0.92 }] },
      ],
      transition: 'Checks turn green one by one, then the gate opens.', action: 'Write the thresholds before looking at results.',
    },
    {
      id: 'q19-s2', title: 'Shadow traffic', objective: 'Compare on real requests without user exposure.', duration: 18,
      narration: 'Mirror a sample of live requests to the new version. The old version still answers the user; the new response is compared and discarded. Shadowing copies user data to a new system, so privacy rules apply.',
      lanes: [
        { label: 'Live request', items: [{ label: 'user prompt', kind: 'request' }] },
        { label: 'Old version', items: [{ label: 'answers user', kind: 'ok', at: 0.25 }] },
        { label: 'New version', items: [{ label: 'mirrored copy', kind: 'comm', at: 0.35 }, { label: 'response discarded', kind: 'neutral', at: 0.55, out: 0.8 }] },
        { label: 'Compare', items: [{ label: 'quality, latency', kind: 'kv', at: 0.65 }, { label: 'privacy rules', kind: 'error', at: 0.85 }] },
      ],
      transition: 'The request forks; only the old answer reaches the user.', action: 'Set shadow share to 0 % in the simulator and see what escapes.',
    },
    {
      id: 'q19-s3', title: 'Canary steps', objective: 'Grow exposure only after each hold collects enough samples.', duration: 18,
      narration: 'Route 1 percent of traffic to the new version and hold until the gate has its samples. Then 10, 50 and 100 percent. At 50,000 requests per hour, a 1 percent canary collects 500 samples per hour, so a 2-point drop needs about six hours.',
      lanes: [
        { label: 'Stages', items: [{ label: '1 %', kind: 'request', at: 0.1 }, { label: '10 %', kind: 'request', at: 0.35 }, { label: '50 %', kind: 'request', at: 0.6 }, { label: '100 %', kind: 'ok', at: 0.85 }] },
        { label: 'Samples / h', items: [{ label: '500', kind: 'neutral', at: 0.15 }, { label: '5,000', kind: 'neutral', at: 0.4 }, { label: '25,000', kind: 'neutral', at: 0.65 }] },
        { label: 'Needed', items: [{ label: 'n = 3,026', kind: 'kv', at: 0.2 }] },
      ],
      equation: 'hold = n / (traffic × share) = 3,026 / 500 ≈ 6.1 h',
      transition: 'Traffic share steps up only after each hold.', action: 'Shorten the hold to 0.25 h and watch stages turn underpowered.',
    },
    {
      id: 'q19-s4', title: 'A gate trips', objective: 'See a statistical gate detect a regression.', duration: 18,
      narration: 'At 10 percent the new version passes 88.1 percent of tasks against 90.0 percent for the baseline. With 5,000 canary samples the z-score is 4.2, far above 1.645. The gate trips, and the 50 and 100 percent stages are never reached.',
      lanes: [
        { label: 'Canary 10 %', items: [{ label: 'baseline 90.0 %', kind: 'ok', at: 0.1 }, { label: 'new 88.1 %', kind: 'error', at: 0.3 }, { label: 'z = 4.2 > 1.645', kind: 'error', at: 0.5 }] },
        { label: 'Later stages', items: [{ label: '50 %', kind: 'neutral', out: 0.65 }, { label: '100 %', kind: 'neutral', out: 0.7 }] },
        { label: 'Action', items: [{ label: 'ROLLBACK', kind: 'error', at: 0.8 }] },
      ],
      equation: 'z = (p_base − p_new) / √(p̄(1−p̄)(1/n_b + 1/n_c))',
      transition: 'The z-score crosses the threshold and later stages are cancelled.', action: 'Inject a 2-point drop in the simulator and find which gate catches it.',
    },
    {
      id: 'q19-s5', title: 'Instant rollback', objective: 'Make rollback a routing change.', duration: 18,
      narration: 'Set the new version’s routing weight to zero. In-flight streams finish or are cut at a deadline. The old version is still warm, so it absorbs the traffic within seconds. The new version’s cache namespace is evicted, so no stale state leaks back.',
      lanes: [
        { label: 'Router', items: [{ label: 'v2 weight 10 %', kind: 'request', out: 0.25 }, { label: 'v2 weight 0 %', kind: 'ok', at: 0.25 }] },
        { label: 'In flight', items: [{ label: 'v2 streams drain', kind: 'decode', at: 0.35, out: 0.7 }] },
        { label: 'Old version', items: [{ label: 'v1 warm, 100 %', kind: 'ok', at: 0.5 }] },
        { label: 'Caches', items: [{ label: 'v2 namespace', kind: 'kv', at: 0.1, out: 0.85 }] },
      ],
      transition: 'Traffic shifts back; v2 streams drain; v2 cache is dropped.', action: 'Explain why rollback by redeploy is too slow.',
    },
  ],
  sim: {
    tldr: 'Inject a hidden quality drop or error spike and watch which gate catches it, how many live requests saw it, and whether each stage had enough samples.',
    omits: [
      'Correlated failures (one tenant or language): samples are independent here.',
      'Latency and memory gates; only quality and error rate are tested.',
      'Sequential-testing corrections for peeking at results.',
      'Human review and safety red-teaming.',
    ],
  },
  formula: {
    name: 'Two-proportion sample size (one-sided)',
    tex: String.raw`n = \frac{\left(z_{1-\alpha}\sqrt{2\bar p(1-\bar p)} + z_{1-\beta}\sqrt{p_1(1-p_1)+p_2(1-p_2)}\right)^2}{(p_1-p_2)^2}`,
    vars: [
      ['n', 'samples per arm (baseline and canary)', 'requests'],
      ['p₁, p₂', 'baseline and degraded pass rate', '—'],
      ['p̄', '(p₁ + p₂) / 2', '—'],
      ['z₁₋α', 'one-sided significance quantile (1.645 for α = 0.05)', '—'],
      ['z₁₋β', 'power quantile (0.842 for 80 %)', '—'],
    ],
    assumptions: ['Independent samples, binary pass/fail', 'Fixed sample size (no peeking without correction)', 'Same grader for both arms'],
    substituted: 'p₁ = 0.90, p₂ = 0.88 → (0.728 + 0.372)² / 0.0004 = 3,026 per arm',
    check: '(dimensionless)² / (dimensionless)² → a count ✓',
    cue: 'Half the drop, four times the samples.',
  },
  estimates: [
    { quantity: 'Samples to detect a 2-pp drop from 90 %', value: '3,026', unit: 'per arm', assumptions: 'α 0.05 one-sided, power 0.8', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Samples to detect a 1-pp drop', value: '≈ 11,620', unit: 'per arm', assumptions: 'Same', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Hold for 1 % canary at 50k req/h (2 pp)', value: '≈ 6.1', unit: 'h', assumptions: '500 req/h to canary', source: 'Calculated', evidence: 'calculated' },
    { quantity: 'Error budget at 99.9 % availability', value: '0.1', unit: '% of requests', assumptions: '30-day window', source: 'SRE practice', evidence: 'assumed' },
    { quantity: 'Fast-burn page threshold', value: '14.4', unit: '× burn rate', assumptions: 'Spends 2 % of a 30-day budget in 1 h', source: 'Google SRE Workbook, alerting on SLOs', evidence: 'assumed' },
  ],
  compare: {
    naive: 'Swap the model behind the endpoint after a quick benchmark; roll back by redeploying.',
    improved: 'Offline + shadow + stepped canary with powered gates, versioned routing and caches, warm previous version and automated rollback triggers.',
    mechanism: 'Small, measured exposure bounds the blast radius; warm old capacity makes rollback a routing change.',
    rows: [
      ['Users exposed to a regression', 'All', '≤ 1–10 % until a gate trips'],
      ['Rollback time', 'Minutes to hours (reload weights)', 'Seconds (route weight to 0)'],
      ['Detects a 2-pp quality drop', 'Rarely', 'Yes, when gates are powered'],
      ['Extra cost', 'None', 'Shadow compute + warm old capacity'],
    ],
  },
  lab: {
    title: 'Release gate with power check', kind: 'protocol', file: 'labs/PROTOCOL.md',
    deps: 'Python 3.10+, no packages (gate); PROTOCOL.md is the full runbook',
    commands: ['python3 gate.py', 'open labs/PROTOCOL.md'], lang: 'python',
    code: `from math import ceil, sqrt

def n_per_arm(p1, p2, za=1.6449, zb=0.8416):
    pb = (p1 + p2) / 2
    num = (za * sqrt(2 * pb * (1 - pb)) + zb * sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    return ceil(num / (p1 - p2) ** 2)

def gate(base_pass, base_n, can_pass, can_n, can_err, need, za=1.6449, err_max=0.01):
    pool = (base_pass * base_n + can_pass * can_n) / (base_n + can_n)
    z = (base_pass - can_pass) / sqrt(pool * (1 - pool) * (1 / base_n + 1 / can_n))
    if z > za or can_err > err_max:
        return "ROLLBACK", z
    if can_n < need:
        return "EXTEND_HOLD", z
    return "PROMOTE", z

need = n_per_arm(0.90, 0.88)
print("samples per arm for a 2-pp drop:", need)
assert need == 3026
assert gate(0.90, 50_000, 0.881, 5_000, 0.002, need)[0] == "ROLLBACK"
assert gate(0.90, 50_000, 0.899, 1_000, 0.002, need)[0] == "EXTEND_HOLD"
assert gate(0.90, 50_000, 0.899, 5_000, 0.002, need)[0] == "PROMOTE"`,
    checks: ['n_per_arm(0.90, 0.88) == 3026', 'A significant drop → ROLLBACK (z ≈ 4.2)', 'Too few samples → EXTEND_HOLD, never PROMOTE'],
    gaps: 'No sequential-testing correction, latency gate or router integration; PROTOCOL.md lists them as production tasks.',
  },
  bench: {
    hypothesis: 'FP8 weights keep task pass rate within 1 point of BF16 and cut p99 TTFT by ≥ 10 % at equal load.',
    baseline: 'BF16 model in production.',
    controlled: ['Eval set and grader version', 'Prompt template and sampling parameters', 'Hardware and engine version', 'Traffic mix during the canary'],
    workload: 'Offline: 5,000-item task suite, long-context and tool-call schema tests. Online: 1 % → 10 % canary.',
    warmup: 'Exclude the first 15 min after each traffic step (cold caches).',
    reps: 'Offline eval with 3 seeds; online hold until n per arm is reached.',
    method: 'Paired offline comparison; online two-proportion z-test per gate; latency from server histograms.',
    metrics: ['task pass rate', 'schema-valid tool calls', 'refusal and safety rate', 'p99 TTFT and ITL', 'error rate and burn rate'],
    interpret: 'Promote only if every gate passes with the required n; any trip → automated rollback and diff analysis. Results: not measured here.',
  },
  pitfalls: [
    'Underpowered canaries: “no significant drop” from 500 samples means nothing.',
    'Peeking every hour without a sequential correction inflates false alarms.',
    'Sharing prefix or KV cache namespaces between versions: stale cached states.',
    'Releasing the old version’s capacity before the hold ends: rollback becomes a cold start.',
    'Shadowing user traffic without privacy review.',
  ],
  optimizations: [
    ['Automated rollback on burn rate or z-gate', 'Fast; thresholds must be tuned to avoid flapping.'],
    ['Stratified canary (per tenant or language)', 'Catches local regressions; each stratum needs its own samples.'],
    ['LLM-as-judge for online quality', 'Scales grading; judge bias must be calibrated against human labels.'],
  ],
  breaks: [
    'Low traffic: a 1 % canary never reaches the needed samples; rely on offline gates and longer holds.',
    'Regressions that need long-term signals (retention, satisfaction) stay invisible in hour-long gates.',
  ],
  interview: {
    short:
      'I treat a model or quantization change as a staged release with explicit gates. First, offline: a fixed evaluation suite covering task quality, safety, structured output and tool-call schemas, and long-context behaviour, plus performance and memory fit on the target hardware, compared with the current version against thresholds set in advance. Second, shadow traffic: mirror a sample of real requests to the new version, discard its responses, and compare quality and latency, under privacy rules. Third, a canary at 1 %, then 10, 50 and 100 %, each with a hold long enough to collect the samples needed to detect the smallest regression we care about; for a two-point drop from 90 % that is about three thousand per arm. Gates check quality with a statistical test, error rate and SLO burn rate, and rollback triggers are automatic. To make rollback instant I keep artifacts immutable, route by version with weights, use separate cache namespaces per version, drain in-flight requests, and keep the previous version warm with enough capacity to take all traffic back.',
    whiteboard: [
      'Draw the state machine with a rollback edge from every stage.',
      'Write the sample-size formula; compute n for 2 points.',
      'Convert n into hold hours per stage.',
      'List gates: quality z-test, errors, burn rate, latency.',
      'Show the versioned router, cache namespaces and warm old pool.',
    ],
    followups: [
      ['Why a separate cache namespace per version?', 'KV and prefix caches computed by one model or quantization are invalid for another; mixing them silently corrupts outputs.'],
      ['Canary looks fine at 1 % but complaints arrive at 50 %. Why?', 'Underpowered gates, or a group (tenant, language, long prompts) barely present at 1 %. Stratify and size each gate.'],
      ['How fast must rollback be?', 'Faster than the error budget burns: with a 14× burn alert, seconds to minutes, so it must be a routing change.'],
    ],
    debug: [
      'After rollback, the error rate stays high for 10 minutes.',
      'The old version was scaled down and is cold-starting, or caches and sessions still point at the new version’s namespace. Keep warm capacity and per-version cache keys.',
    ],
    calc: ['A 10 % canary of 20,000 req/h needs 3,026 samples. Hold time?', '2,000 req/h to the canary → 3,026 / 2,000 ≈ 1.5 h.'],
  },
  changeMind: [
    'Traffic too low for powered online gates: shift weight to offline evals and longer holds.',
    'The change is bit-exact infrastructure (same weights, new engine build): lighter gates.',
    'Regulated or safety-critical domain: add a human review gate.',
  ],
  recall: [
    ['Order of stages?', 'Offline → shadow → 1 % → 10 % → 50 % → 100 %.'],
    ['Samples scale with?', '1 / drop².'],
    ['What makes rollback instant?', 'Versioned routing, warm old capacity, separate caches.'],
  ],
  glossary: [
    ['Canary', 'A small share of live traffic sent to a new version to detect regressions.'],
    ['Shadow traffic', 'Mirrored requests processed by the new version with responses discarded.'],
    ['Error budget', 'Allowed unreliability: 1 − SLO (e.g. 0.1 % of requests).'],
    ['Burn rate', 'Observed error rate ÷ budgeted error rate; 1 = spending exactly on budget.'],
    ['Statistical power', 'Probability that a test detects a real effect of a given size.'],
  ],
  tags: ['rollout', 'canary', 'evaluation', 'quantization', 'rollback', 'statistics'],
};

const q20: Lesson = {
  id: 20,
  group: 'production',
  short: 'GPU autoscaling',
  question: 'Design GPU autoscaling when provisioning new instances takes minutes and traffic can spike in seconds.',
  why: 'Reactive scaling alone fails here; the interviewer wants buffers, forecasts and graceful degradation.',
  tldr: [
    'New capacity arrives after detection + provisioning + model load + warm-up: often 5–15 minutes, versus spikes in seconds.',
    'Bridge the gap with headroom, warm pools, forecast pre-scaling, bounded queues and admission shedding.',
    'Scale on token demand and queue wait, not request count; scale down slowly with hysteresis and draining.',
  ],
  plain:
    'An autoscaler can only add GPUs that become ready minutes later, so anything faster must be absorbed by spare capacity or by shedding load. Keep warm replicas ready, pre-scale for known peaks, and cap queues so excess traffic gets a fast “try later” instead of a slow timeout.',
  analogy: {
    name: 'Hiring cashiers for a rush',
    map: [
      ['A sudden rush of shoppers', 'Traffic spike'],
      ['Hiring and training a new cashier', 'Provision + model load + warm-up'],
      ['Staff on break in the back room', 'Warm pool'],
      ['Saturday-morning rota', 'Scheduled or forecast pre-scaling'],
      ['“Store full, come back later” sign', 'Admission control and shedding'],
    ],
    breaks:
      'A cashier serves one customer at a time; a GPU batches, so its capacity depends on prompt and output lengths. A warm GPU replica also costs almost as much as a busy one.',
  },
  example: {
    title: 'Spike vs startup lag',
    inputs: 'Baseline 20k tok/s on 6 replicas (5k tok/s each, target 70 %). Demand triples to 60k tok/s. Detection 60 s, cold start 8 min, queue bound 30 s.',
    steps: [
      { label: 'Capacity at the spike', state: '6 × 5k = 30k tok/s → deficit 30k tok/s' },
      { label: 'Detection', state: 'the autoscaler sees it at t + 60 s' },
      { label: 'Replicas wanted', state: 'ceil(60k / (5k × 0.7)) = 18 → order 12 more' },
      { label: 'Ready at', state: 't + 60 s + 480 s = t + 9 min' },
      { label: 'Meanwhile', state: 'queue hits its 30-s bound (900k tokens);\nthe rest is shed for ≈ 9 min' },
    ],
    output: 'Reactive scaling violates the SLO for about 9 minutes (simulator: 9.2 min); a warm pool of 6 cuts that to 4.1 min.',
    predict: {
      q: 'Forecast pre-scaling starts 10 minutes before a known spike, and cold start is 8 minutes. Violation minutes?',
      a: 'About zero: capacity is ready 2 minutes before the spike (simulator: 0.0 min), at the cost of 10 extra minutes of idle replicas.',
    },
  },
  scenes: [
    {
      id: 'q20-s1', title: 'The spike outruns startup', objective: 'Break startup lag into its phases.', duration: 18,
      narration: 'Demand triples from 20,000 to 60,000 tokens per second within a minute. Six replicas give 30,000. The autoscaler notices after 60 seconds. Then the node is provisioned, the image and weights load, kernels compile and warm up. The new replicas are ready about nine minutes after the spike.',
      lanes: [
        { label: 'Demand', items: [{ label: '20k tok/s', kind: 'request' }, { label: '60k tok/s', kind: 'error', at: 0.2 }] },
        { label: 'Capacity', items: [{ label: '30k (6 replicas)', kind: 'decode' }] },
        { label: 'Startup', items: [{ label: 'detect 60 s', kind: 'neutral', at: 0.35 }, { label: 'provision', kind: 'neutral', at: 0.5 }, { label: 'image + weights', kind: 'neutral', at: 0.62 }, { label: 'compile + warm-up', kind: 'neutral', at: 0.74 }, { label: 'ready at +9 min', kind: 'ok', at: 0.9 }] },
      ],
      equation: 'T_lag = T_detect + T_provision + T_load + T_warm ≈ 9 min',
      transition: 'Demand jumps first; startup phases follow one by one.', action: 'Set cold start to 15 minutes in the simulator.',
    },
    {
      id: 'q20-s2', title: 'Queue fills, then shed', objective: 'See why queues must be bounded.', duration: 18,
      narration: 'The extra 30,000 tokens per second pile up in the queue. Once the queue holds 30 seconds of work, waiting longer helps nobody: the client would time out anyway. Admission control returns 429 with Retry-After, a fast failure instead of a slow one.',
      lanes: [
        { label: 'Queue', items: [{ label: '5 s', kind: 'kv', at: 0.1 }, { label: '15 s', kind: 'kv', at: 0.25 }, { label: '30 s (bound)', kind: 'error', at: 0.4 }] },
        { label: 'Admission', items: [{ label: '429 + Retry-After', kind: 'error', at: 0.6 }, { label: 'priority traffic kept', kind: 'ok', at: 0.75 }] },
        { label: 'Degrade', items: [{ label: 'shorter max output', kind: 'neutral', at: 0.88 }] },
      ],
      equation: 'queue bound = 30 s × 30k tok/s = 900k tokens',
      transition: 'The queue grows to its bound, then shedding starts.', action: 'Raise the queue bound to 120 s: does the SLO improve?',
    },
    {
      id: 'q20-s3', title: 'A warm pool bridges the gap', objective: 'See how pre-loaded replicas cut the lag to seconds.', duration: 18,
      narration: 'Six replicas sit warm with weights loaded. When the spike is detected, they start serving within 30 seconds, and the pool begins refilling with cold starts. Violation time falls from 9.2 to 4.1 minutes in the simulator. The pool costs money even when idle.',
      lanes: [
        { label: 'Warm pool', items: Array.from({ length: 6 }, (_, k) => ({ label: 'warm', kind: 'ok' as const, out: 0.35 + k * 0.02 })) },
        { label: 'Serving', items: [{ label: '+6 in 30 s', kind: 'decode', at: 0.45 }] },
        { label: 'Refill', items: [{ label: 'cold start 8 min', kind: 'neutral', at: 0.65 }] },
      ],
      equation: 'violation (sim, 3× spike): reactive 9.2 min → warm pool 4.1 min',
      transition: 'Pool replicas move into service; refills start behind them.', action: 'Set warm pool to 0, 6 and 12 and compare replica-minutes.',
    },
    {
      id: 'q20-s4', title: 'Forecast pre-scaling', objective: 'Scale before known peaks.', duration: 18,
      narration: 'Traffic peaks every weekday at nine. The scheduler starts replicas at 8:50, they are ready by 8:58, and the spike at nine is absorbed. This only works if the lead time exceeds the startup lag and the forecast is close to the real peak.',
      lanes: [
        { label: 'Schedule', items: [{ label: 'peak 09:00 daily', kind: 'request' }, { label: 'start 08:50', kind: 'neutral', at: 0.25 }] },
        { label: 'Replicas', items: [{ label: 'ready 08:58', kind: 'ok', at: 0.55 }] },
        { label: 'Spike', items: [{ label: '09:00 absorbed', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'lead ≥ T_lag and forecast ≈ real peak',
      transition: 'Capacity arrives before demand.', action: 'Set forecast accuracy to 60 % and watch violations return.',
    },
    {
      id: 'q20-s5', title: 'Scale down slowly', objective: 'Avoid flapping with hysteresis and draining.', duration: 18,
      narration: 'After the spike, utilisation drops below 35 percent. The autoscaler waits for a five-minute cooldown, stops routing new requests to one replica, lets in-flight streams finish, and only then releases the GPU. A minimum warm floor always stays.',
      lanes: [
        { label: 'Utilisation', items: [{ label: '30 % < 35 %', kind: 'neutral', at: 0.1 }] },
        { label: 'Cooldown', items: [{ label: '5 min', kind: 'kv', at: 0.3 }] },
        { label: 'Replica', items: [{ label: 'stop routing', kind: 'request', at: 0.45 }, { label: 'drain streams', kind: 'decode', at: 0.6, out: 0.8 }, { label: 'release GPU', kind: 'neutral', at: 0.85 }] },
        { label: 'Floor', items: [{ label: 'min warm replicas', kind: 'ok', at: 0.92 }] },
      ],
      equation: 'scale up at 70 %, down below 35 % for 5 min',
      transition: 'One replica drains and leaves; the floor remains.', action: 'Use the failure preset: aggressive scale-down after the spike.',
    },
  ],
  sim: {
    tldr: 'Same seeded traffic spike under three policies; drag startup lag, warm pool and forecast accuracy and watch SLO minutes trade against replica-minutes.',
    omits: [
      'Per-request latency: the SLO is queue wait > 5 s or shedding.',
      'Prefill/decode mix: capacity is one tokens/s number per replica.',
      'GPU availability: provisioning always succeeds.',
      'Retries triggered by shed requests.',
    ],
  },
  formula: {
    name: 'Warm capacity needed to survive the lag (decision rule)',
    tex: String.raw`T_{lag} = T_{detect}+T_{prov}+T_{load}+T_{warm}, \qquad N_{warm} \ge \left\lceil \frac{D_{peak} - C_{ready}}{c\,u^{*}} \right\rceil`,
    vars: [
      ['T_lag', 'time from spike to new replica serving', 's'],
      ['D_peak', 'peak demand reached within T_lag', 'tok/s'],
      ['C_ready', 'capacity of ready replicas', 'tok/s'],
      ['c', 'tokens/s one replica sustains at SLO', 'tok/s'],
      ['u*', 'target utilisation', '—'],
      ['N_warm', 'warm or spare replicas needed', 'replicas'],
    ],
    assumptions: ['Per-replica capacity measured at SLO for this length mix', 'Spike size from history (e.g. p99 growth within T_lag)', 'Warm replicas serve within seconds'],
    substituted: 'D_peak = 60k, C_ready = 30k, c = 5k, u* = 0.7 → N_warm ≥ ceil(30k / 3.5k) = 9 replicas',
    check: '(tok/s) / (tok/s) → replicas ✓',
    cue: 'Whatever arrives faster than your lag must already be warm, or be shed.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Detection (scrape + alert window)', value: '30–120', unit: 's', assumptions: 'Scrape interval + 1-min rule', source: 'Typical configuration', evidence: 'assumed' },
    { quantity: 'GPU node provisioning', value: '1–10+', unit: 'min', assumptions: 'Cloud, region and quota dependent', source: 'Not measured here', evidence: 'not measured' },
    { quantity: 'Weight load, 70B BF16 (140 GB) at 2 GB/s', value: '70', unit: 's', assumptions: 'Storage throughput assumption', source: '140 GB / 2 GB/s', evidence: 'calculated' },
    { quantity: 'Compile, graph capture, warm-up', value: 'tens of s – minutes', unit: '—', assumptions: 'Engine and shape dependent', source: 'Not measured here', evidence: 'not measured' },
    { quantity: 'Sim: SLO minutes, 3× spike (reactive / pool 6 / forecast)', value: '9.2 / 4.1 / 0.0', unit: 'min', assumptions: 'Default preset, seed 20', source: 'This app (autoscale())', evidence: 'simulated' },
    { quantity: 'Sim: replica-minutes, same runs', value: '772 / 986 / 732', unit: 'replica-min', assumptions: 'Idle pool replicas billed', source: 'This app (autoscale())', evidence: 'simulated' },
  ],
  compare: {
    naive: 'Scale on GPU utilisation or request count with a 1-minute loop; unbounded queues.',
    improved: 'Scale on token demand + queue wait, keep headroom and a warm pool, pre-scale on forecasts, bound queues and shed early, scale down with hysteresis and draining.',
    mechanism: 'Capacity that is already warm or scheduled covers the lag; bounded queues turn overload into fast rejections instead of timeouts.',
    rows: [
      ['SLO minutes (3× spike, sim)', '9.2', '0.0–4.1'],
      ['Idle cost', 'Lowest', '+ warm pool or headroom'],
      ['Overload behaviour', 'Timeouts, retry storms', 'Fast 429 + Retry-After'],
      ['Complexity', 'Low', 'Forecasts, pool management'],
    ],
  },
  lab: {
    title: 'Reactive vs warm pool in 30 lines', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 autoscale.py'], lang: 'python',
    code: `import math

def simulate(policy, minutes=40, base=20_000, mult=3, spike=(10, 25), per=5_000,
             target=0.7, detect=60, startup=480, pool=9, warm=30, qmax_s=30, step=5):
    ready = math.ceil(base / (per * target))
    pending, q, bad, hist = [], 0.0, 0, []
    for k in range(minutes * 60 // step):
        t = k * step
        ready += sum(r <= t for r in pending)
        pending = [r for r in pending if r > t]
        d = base * (mult if spike[0] * 60 <= t < spike[1] * 60 else 1)
        hist.append(d)
        cap = ready * per
        q = min(max(0.0, q + (d - cap) * step), qmax_s * cap)  # bounded queue; excess shed
        bad += step if q / cap > 5 else 0                      # SLO: wait <= 5 s
        seen = hist[max(0, len(hist) - 1 - detect // step)]    # metric arrives late
        need = math.ceil((seen + q / 60) / (per * target)) - ready - len(pending)
        for _ in range(max(0, need)):
            use_pool = policy == "warmpool" and pool > 0
            pool -= use_pool
            pending.append(t + (warm if use_pool else startup))
    return bad / 60

r, w = simulate("reactive"), simulate("warmpool")
print(f"SLO-violation minutes: reactive={r:.1f} warm pool={w:.1f}")
assert w < r`,
    checks: [
      'Reactive ≈ 9.2 min; warm pool of 9 (formula-sized) ≈ 2.4 min',
      'Pool of 6 (below the 9-replica deficit) ≈ 9.1 min: an undersized pool barely helps when the queue sits at its bound',
      'Queue never exceeds 30 s of capacity',
    ],
    gaps: 'No forecasting, scale-down, pool refill or real provisioning API; the in-app engine adds those.',
  },
  bench: {
    hypothesis: 'A formula-sized warm pool keeps p99 queue wait ≤ 5 s for 3× spikes with 60-s ramps.',
    baseline: 'Reactive autoscaler with no pool.',
    controlled: ['Replayed spike shape', 'Model, GPU type, container image', 'Autoscaler thresholds', 'Region and quota'],
    workload: 'Synthetic spikes 1× → 2× → 3× in staging, with the production length mix.',
    warmup: 'Steady 1× load for 15 min before each spike.', reps: '3 spikes per policy.',
    method: 'Timestamp each startup phase (requested, node ready, image pulled, weights loaded, warm-up done, serving) and record queue-wait histograms.',
    metrics: ['startup phase durations', 'SLO-violation minutes', 'shed requests', 'GPU-minutes'],
    interpret: 'Measured phase durations replace the assumed lag in the model; pool size = deficit over the measured lag. Results: not measured here.',
  },
  pitfalls: [
    'Scaling on GPU utilisation: it reads near 100 % long before latency explodes and says nothing about the queue.',
    'Counting requests instead of tokens: one 100K-token prompt is not one chat turn.',
    'Unbounded queues: requests finish after the client gave up, wasting GPU time.',
    'Scaling down too eagerly: flapping and cold starts on the next wave.',
    'Measuring startup to “pod running” instead of “warm and serving”.',
  ],
  optimizations: [
    ['Warm pool or standby replicas', 'Cuts lag to seconds; you pay for idle GPUs.'],
    ['Faster cold start (local NVMe weight cache, prebuilt engines, snapshots)', 'Shrinks the lag for every policy; engineering and storage cost.'],
    ['Graceful degradation (smaller model, shorter max output) under overload', 'Keeps serving; the lower quality must be pre-approved.'],
  ],
  breaks: [
    'Spikes larger than pool + headroom with ramps shorter than the lag: shedding is unavoidable.',
    'GPU quota or stock-outs: provisioning never completes, and forecasts do not help.',
  ],
  interview: {
    short:
      'The core problem is that capacity arrives after detection, provisioning, image and weight loading, compilation and warm-up, which together can take five to fifteen minutes, while demand can triple in seconds. So reactive autoscaling alone cannot protect the SLO; something must absorb the gap. I size baseline headroom and a warm pool of pre-loaded replicas from the historical spike size over the startup lag, and I pre-scale on schedules and forecasts for known peaks. I scale on token-level demand and queue wait, not request counts or GPU utilisation, because a long prompt costs far more than a short one. Queues are bounded in seconds of work; beyond that, admission control returns a fast 429 with Retry-After, prioritises interactive or paid traffic, and can switch to approved degraded modes such as a smaller model or shorter maximum output. Scale-down is slow and hysteretic: low utilisation must persist through a cooldown, replicas drain in-flight requests first, and a minimum warm floor stays. Finally I measure each startup phase and shrink it, because every minute removed from cold start shrinks the warm pool I pay for.',
    whiteboard: [
      'Timeline: spike at t₀, detection, provision, load, warm-up, ready.',
      'Shade the gap; compute deficit × lag.',
      'Size the warm pool = ceil(deficit / (c × u*)).',
      'Add the bounded queue and shedding policy.',
      'Draw scale-down hysteresis and draining.',
    ],
    followups: [
      ['Why not scale on GPU utilisation?', 'It is a duty-cycle signal that reads near 100 % at both moderate and extreme load; queue wait and token demand show overload directly.'],
      ['How big should the warm pool be?', 'Enough to cover the expected spike deficit over the startup lag, e.g. from the p99 demand growth within that lag; trade against idle cost.'],
      ['What happens to requests during scale-down?', 'Stop routing new ones to the replica, let in-flight streams finish within a deadline, then release the GPU.'],
    ],
    debug: [
      'After every spike the fleet oscillates: up, down, up again for 30 minutes.',
      'Thresholds too close and cooldown too short (no hysteresis), or scale-up ignores replicas still starting. Widen the gap (up at 70 %, down below 35 % for 5 min) and count pending capacity.',
    ],
    calc: ['Demand will jump from 20k to 50k tok/s. Ready capacity 30k, 5k tok/s per replica at a 70 % target. Warm replicas needed?', 'Deficit 20k / (5k × 0.7) = 5.7 → 6 replicas.'],
  },
  changeMind: [
    'Measured cold start under 1 minute: smaller pool, more reactive scaling.',
    'Spikes are predictable (scheduled events): forecasts beat pools.',
    'Users accept waiting (batch jobs): longer queues, rarer shedding.',
  ],
  recall: [
    ['What makes up startup lag?', 'Detect + provision + load + compile/warm-up.'],
    ['Scaling signal?', 'Token demand and queue wait, not request count or GPU utilisation.'],
    ['Overload policy?', 'Bounded queue, fast 429 with Retry-After, approved degradation.'],
  ],
  glossary: [
    ['Warm pool', 'Pre-provisioned replicas with weights loaded, ready to serve within seconds.'],
    ['Hysteresis', 'Different thresholds or delays for scaling up and down, to avoid flapping.'],
    ['Admission control', 'Rejecting or deferring requests at the front door when capacity is short.'],
    ['HPA', 'Kubernetes Horizontal Pod Autoscaler: changes replica counts from metrics.'],
    ['Cold start', 'Time from requesting capacity to serving traffic at full speed.'],
  ],
  tags: ['autoscaling', 'capacity', 'warm pool', 'admission control', 'slo', 'kubernetes'],
};

export const lessons: Lesson[] = [q16, q17, q18, q19, q20];
