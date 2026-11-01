// Foundations (Q1-Q5).
import type { Lesson } from '../types';

const q3: Lesson = {
  id: 3,
  group: 'foundations',
  short: 'KV cache memory',
  question:
    'Calculate KV cache memory for a Llama-style 70B model serving 100 concurrent users at 32K context. Account for GQA, KV precision, and memory overhead.',
  why: 'KV cache, not weights, usually decides how many requests one GPU group can hold at once.',
  tldr: [
    'Per token: 2 × layers × KV heads × head dim × bytes = 320 KiB for the assumed 70B config in BF16.',
    '100 requests × 32,768 tokens → 1,000 GiB raw KV; weights add another ~130 GiB.',
    'GQA (8 KV heads, not 64) and FP8 KV are the two biggest levers; paging removes waste, not unique bytes.',
  ],
  plain:
    'Every token the model has seen leaves a key and a value vector in every layer. Those vectors stay in GPU memory until the request ends, so memory grows with tokens × requests. Count the bytes per token once, then multiply.',
  analogy: {
    name: 'Library shelves',
    map: [
      ['One book page per token per shelf', 'One K and one V vector per token per layer'],
      ['A shelf per floor', 'A layer'],
      ['Only 8 copy desks share 64 readers', 'GQA: 8 KV heads serve 64 query heads'],
      ['Thinner paper', 'Lower KV precision (FP8, 4-bit)'],
    ],
    breaks:
      'Library pages are read rarely; KV is read on every decode step, so bandwidth matters as much as space. Thinner paper never loses words; quantized KV can lose accuracy.',
  },
  example: {
    title: 'One token through the byte calculator',
    inputs: 'L = 80 layers, H_kv = 8, D_head = 128, b_kv = 2 bytes (BF16)',
    steps: [
      { label: 'K and V', state: '2 tensors per layer' },
      { label: '× layers', state: '2 × 80 = 160 vectors per KV head' },
      { label: '× KV heads', state: '160 × 8 = 1,280 vectors' },
      { label: '× head dim', state: '1,280 × 128 = 163,840 elements' },
      { label: '× bytes', state: '163,840 × 2 = 327,680 B = 320 KiB per token' },
      { label: '× tokens × requests', state: '320 KiB × 32,768 = 10 GiB per request\n10 GiB × 100 = 1,000 GiB ≈ 0.977 TiB' },
    ],
    output: '1,000 GiB raw BF16 KV for 100 full 32K requests (no sharing, no eviction).',
    predict: {
      q: 'If the same model used full multi-head attention (64 KV heads), how much raw KV would 100 requests need?',
      a: '8× more: 8,000 GiB (≈ 7.8 TiB). GQA divides KV memory by query heads ÷ KV heads = 64 ÷ 8.',
    },
  },
  scenes: [
    {
      id: 'q3-s1', title: 'One token, many vectors', objective: 'See that one token creates K and V in every layer and KV head.', duration: 18,
      narration: 'A single token enters the model. Each of 80 layers writes one key and one value for each of 8 KV heads. Each vector has 128 numbers. That is 163,840 numbers for one token.',
      lanes: [
        { label: 'Token', items: [{ label: '"cat"', kind: 'request' }] },
        { label: 'Per layer', items: [{ label: 'K', kind: 'kv', at: 0.2 }, { label: 'V', kind: 'kv', at: 0.3 }, { label: '× 80 layers', kind: 'neutral', at: 0.45 }] },
        { label: 'Per KV head', items: [{ label: '× 8 heads', kind: 'neutral', at: 0.6 }, { label: '× 128 dims', kind: 'neutral', at: 0.75 }] },
        { label: 'Total', items: [{ label: '163,840 elements', kind: 'prefill', at: 0.9 }] },
      ],
      equation: 'elements/token = 2 × 80 × 8 × 128 = 163,840',
      transition: 'Token expands into per-layer K and V vectors.', action: 'Predict the bytes in BF16 before the next scene.',
    },
    {
      id: 'q3-s2', title: 'Bytes per token', objective: 'Convert elements to bytes for each precision.', duration: 18,
      narration: 'BF16 stores each number in 2 bytes, so one token costs 327,680 bytes, which is 320 KiB. FP8 halves it to 160 KiB. Ideal packed 4-bit halves it again to 80 KiB, before scales and metadata.',
      lanes: [
        { label: 'BF16', items: [{ label: '320 KiB', kind: 'kv', at: 0.15, note: '2 B each' }] },
        { label: 'FP8', items: [{ label: '160 KiB', kind: 'kv', at: 0.45, note: '1 B each' }] },
        { label: '4-bit', items: [{ label: '80 KiB', kind: 'kv', at: 0.75, note: '+ scales' }] },
      ],
      equation: 'bytes/token = 163,840 × b_kv',
      transition: 'Precision bar shrinks from 320 to 80 KiB.', action: 'Ask: is FP8 KV supported and accurate on my engine?',
    },
    {
      id: 'q3-s3', title: 'Multiply by tokens and requests', objective: 'Scale per-token cost to the whole workload.', duration: 18,
      narration: 'One request holds 32,768 tokens. At 320 KiB each, that is exactly 10 GiB. One hundred active requests need 1,000 GiB of raw KV, about 0.98 TiB. That is several times the weights.',
      lanes: [
        { label: 'Request 1', items: [{ label: '10 GiB', kind: 'kv', at: 0.1 }] },
        { label: 'Requests 2-50', items: [{ label: '+490 GiB', kind: 'kv', at: 0.35 }] },
        { label: 'Requests 51-100', items: [{ label: '+500 GiB', kind: 'kv', at: 0.6 }] },
        { label: 'Weights', items: [{ label: '≈130 GiB', kind: 'prefill', at: 0.85, note: '70e9 × 2 B' }] },
      ],
      equation: 'KV = 320 KiB × 32,768 × 100 = 1,000 GiB',
      transition: 'KV stack grows request by request past the weight bar.', action: 'Change concurrency in the simulator and watch the line chart.',
    },
    {
      id: 'q3-s4', title: 'GQA changes everything', objective: 'Show why KV heads, not query heads, set memory.', duration: 18,
      narration: 'The model has 64 query heads but only 8 KV heads. Groups of 8 query heads share one KV head. Using 64 by mistake overstates memory 8 times, to 8,000 GiB.',
      lanes: [
        { label: 'Query heads', items: [{ label: '64 heads', kind: 'request' }] },
        { label: 'KV heads (GQA)', items: [{ label: '8 heads', kind: 'kv', at: 0.3, note: '1,000 GiB' }] },
        { label: 'If MHA', items: [{ label: '64 heads', kind: 'error', at: 0.6, note: '8,000 GiB' }] },
      ],
      equation: 'ratio = H_q / H_kv = 64 / 8 = 8×',
      transition: '64 query heads collapse into 8 KV groups.', action: 'Pick the failure preset: MHA with 64 KV heads.',
    },
    {
      id: 'q3-s5', title: 'Fit it on GPUs', objective: 'Place weights and KV on a tensor-parallel group with headroom.', duration: 18,
      narration: 'Add a 10 to 20 percent planning allowance to KV only. With TP8 on 80 GB GPUs, each rank holds one-eighth of weights and one KV head. Usable memory per rank decides how many replicas you need. Paging removes waste but never removes unique bytes.',
      lanes: [
        { label: 'Per rank', items: [{ label: 'weights 16 GiB', kind: 'prefill', at: 0.1 }, { label: 'KV slice', kind: 'kv', at: 0.3 }, { label: 'reserve', kind: 'neutral', at: 0.45 }] },
        { label: 'Replicas', items: [{ label: 'TP8 #1', kind: 'ok', at: 0.6 }, { label: 'TP8 #2', kind: 'ok', at: 0.7 }, { label: 'TP8 #3', kind: 'ok', at: 0.8 }, { label: '…', kind: 'neutral', at: 0.9 }] },
      ],
      equation: 'replicas = ceil(KV per rank / (usable − weights per rank))',
      transition: 'KV spreads across TP ranks, then across replicas.', action: 'Switch GPU memory to 141 GB and compare the GPU count.',
    },
  ],
  sim: {
    tldr: 'Every number below comes from one function, kvPlan(); change any factor and the chain, bars, line and table update together.',
    omits: [
      'Activation, CUDA graph and communication memory beyond one fixed reserve per GPU.',
      'Quantization scale/metadata bytes for FP8 and 4-bit KV.',
      'Sliding-window or eviction policies; every token stays cached.',
      'Uneven request lengths: all requests hold the same token count.',
    ],
  },
  formula: {
    name: 'KV cache bytes',
    tex: String.raw`\text{KV} = 2 \times L \times H_{\text{kv}} \times D_{\text{head}} \times b_{\text{kv}} \times \sum_i T_i`,
    vars: [
      ['2', 'one K and one V tensor', '—'],
      ['L', 'transformer layers', 'layers'],
      ['H_kv', 'KV heads (not query heads)', 'heads'],
      ['D_head', 'head dimension', 'elements'],
      ['b_kv', 'effective bytes per element', 'B'],
      ['T_i', 'tokens cached for request i', 'tokens'],
    ],
    assumptions: ['No prefix sharing', 'No sliding window', '32K = occupied tokens, not max budget', 'Assumed Llama-style 70B config'],
    substituted: '2 × 80 × 8 × 128 × 2 B × (100 × 32,768) = 1,073,741,824,000 B = 1,000 GiB',
    check: 'layers × heads × elements × B/element × tokens → bytes ✓',
    cue: 'Two caches, every layer, every KV head, every stored token.',
  },
  estimates: [
    { quantity: 'KV per token, BF16', value: '320', unit: 'KiB', assumptions: 'L=80, H_kv=8, D=128', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'KV, 100 × 32K, BF16', value: '1,000', unit: 'GiB', assumptions: 'No sharing', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'KV, same, FP8 / 4-bit', value: '500 / 250', unit: 'GiB', assumptions: 'Excludes scales', source: 'Formula above', evidence: 'calculated' },
    { quantity: 'Weights, 70B BF16', value: '≈130.4', unit: 'GiB', assumptions: '70e9 × 2 B, no padding', source: 'params × bytes', evidence: 'calculated' },
    { quantity: 'Planning allowance on KV', value: '10–20', unit: '%', assumptions: 'Fragmentation, metadata', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'H100 SXM memory', value: '80', unit: 'GB (decimal)', assumptions: 'Board spec', source: 'NVIDIA H100 datasheet', evidence: 'vendor spec' },
  ],
  compare: {
    naive: 'Reserve max context (e.g. 128K) contiguously for every request; count 64 query heads.',
    improved: 'Count KV heads, allocate fixed-size pages on demand, share common prefixes, consider FP8 KV.',
    mechanism: 'Memory follows tokens actually cached × KV heads, not the worst-case reservation.',
    rows: [
      ['Memory per 32K request', '40 GiB reserved (128K)', '10 GiB used + < 1 block waste'],
      ['Concurrency on fixed memory', 'Low (reservations)', '≈ 4× higher here'],
      ['Quality risk', 'None', 'FP8 KV needs evaluation'],
      ['Complexity', 'Low', 'Allocator + kernel support'],
    ],
  },
  lab: {
    title: 'KV calculator with asserts', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 kv_calc.py'], lang: 'python',
    code: `def kv_bytes(L, h_kv, d, b, tokens):
    return 2 * L * h_kv * d * b * sum(tokens)

per_tok = kv_bytes(80, 8, 128, 2, [1])
assert per_tok == 327_680            # 320 KiB
total = kv_bytes(80, 8, 128, 2, [32_768] * 100)
assert total == 1_000 * 1024**3      # exactly 1,000 GiB
for b, name in [(2, "BF16"), (1, "FP8"), (0.5, "4-bit")]:
    print(name, kv_bytes(80, 8, 128, b, [32_768] * 100) / 1024**3, "GiB")`,
    checks: ['per-token anchor = 327,680 B', '100 × 32K = 1,000 GiB exactly', 'FP8 = 500 GiB, 4-bit = 250 GiB'],
    gaps: 'Does not read a real model config or engine block size; real engines add scales and metadata.',
  },
  bench: {
    hypothesis: 'Measured KV pool usage tracks 2·L·H_kv·D·b per cached token within block rounding.',
    baseline: 'Engine-reported KV blocks at 0 active requests.',
    controlled: ['Model + config.json', 'Engine version', 'block size', 'KV dtype', 'GPU'],
    workload: '1, 10, 50 requests at fixed 4K, 16K, 32K cached tokens.',
    warmup: '3 requests discarded.', reps: '5 per point.',
    method: 'Read engine KV-usage metric and nvidia-smi memory after each step.',
    metrics: ['KV blocks used', 'GiB used', 'bytes/token implied'],
    interpret: 'Slope ≈ 320 KiB/token in BF16 confirms the formula; extra = metadata/fragmentation.',
  },
  pitfalls: [
    'Using query heads (64) instead of KV heads (8): 8× overestimate.',
    'Mixing GB (vendor, 10⁹) with GiB (2³⁰): 7.4 % error at this scale.',
    'Treating 32K as occupied tokens when it is a max budget that must also hold generated tokens.',
    'Assuming weight quantization also shrinks KV; they are independent choices.',
  ],
  optimizations: [
    ['FP8 KV cache', 'Halves KV; needs kernel support and quality evaluation on long context.'],
    ['Prefix sharing (paged blocks)', 'Big win for shared system prompts; needs hashing and ref-counting.'],
    ['Higher tensor parallelism', 'Spreads KV across ranks until TP > KV heads, then heads replicate.'],
  ],
  breaks: [
    'TP degree above KV-head count: KV is replicated, so per-GPU KV stops shrinking.',
    'Very long contexts with low reuse: sharing and paging save little; only precision or eviction help.',
  ],
  interview: {
    short:
      'I start from bytes per token: two tensors, K and V, per layer per KV head, each head-dim wide. For the assumed Llama-style 70B with 80 layers, 8 KV heads because of GQA, and head dim 128 in BF16, that is 2 × 80 × 8 × 128 × 2 = 327,680 bytes, or 320 KiB per token. A 32K-token request is exactly 10 GiB, and 100 active requests are 1,000 GiB, about 0.98 TiB. FP8 KV halves that to 500 GiB; ideal 4-bit to 250 GiB, plus scales. I add a 10–20 % allowance on KV for fragmentation and metadata, then account separately for about 130 GiB of BF16 weights, activations and runtime reserves. On 80 GB GPUs with TP8 each rank holds one KV head and one-eighth of the weights, so I would need several TP8 replicas. Paging and prefix sharing reduce waste and duplicate prefixes, but they never remove unique bytes. Finally I confirm whether 32K is occupied or a maximum budget.',
    whiteboard: [
      'Write the formula; circle H_kv and say why it is 8 not 64.',
      'Compute 320 KiB/token → 10 GiB/request → 1,000 GiB.',
      'Precision table: 1,000 / 500 / 250 GiB.',
      'Add allowance on KV only; add weights separately.',
      'Per-rank placement with TP8; compute replicas.',
    ],
    followups: [
      ['What if prompts share a 4K system prompt?', 'With 16-token blocks, 256 shared blocks are stored once: saves 99 × 4K × 320 KiB ≈ 124 GiB.'],
      ['Does INT4 weight quantization reduce KV?', 'No. Weights and KV are separate tensors with separate precision choices.'],
      ['What happens at TP16 with 8 KV heads?', 'Each KV head is replicated on 2 ranks; per-rank KV no longer halves.'],
    ],
    debug: [
      'Your engine OOMs at 60 concurrent 32K requests on 8 × 80 GB even though weights fit. Why?',
      'Per rank: 16.3 GiB weights + 60 × 10 GiB / 8 = 75 GiB KV — already above 74.5 GiB usable before activations. Need fewer requests, FP8 KV, or more replicas.',
    ],
    calc: [
      'FP8 KV, 50 requests × 64K tokens. Raw KV?',
      '160 KiB × 65,536 × 50 = 500 GiB.',
    ],
  },
  changeMind: [
    'Measured KV dtype accuracy loss on my long-context evals.',
    'Real request length distribution (median ≪ 32K changes everything).',
    'Prefix reuse rate from production traces.',
  ],
  recall: [
    ['Bytes per token, 70B BF16 GQA?', '320 KiB'],
    ['Why 8 and not 64 heads?', 'GQA: KV heads are shared by groups of query heads.'],
    ['What does paging save?', 'Reservation waste and duplicate prefixes, not unique bytes.'],
  ],
  glossary: [
    ['KV cache', 'Stored key and value vectors from earlier tokens, reused on every decode step.'],
    ['GQA', 'Grouped-query attention: several query heads share one key/value head.'],
    ['GiB', 'Gibibyte, 2³⁰ bytes. Vendor GB are 10⁹ bytes.'],
    ['Tensor parallelism (TP)', 'Splitting each layer across GPUs; each rank holds a slice of heads.'],
  ],
  tags: ['memory', 'kv', 'gqa', 'quantization', 'capacity'],
};

const q1: Lesson = {
  id: 1,
  group: 'foundations',
  short: 'Request to first token',
  question: 'Walk me through everything that happens from an API request arriving to the first token being generated.',
  why: 'TTFT complaints are diagnosed span by span; candidates who skip the queue or invent an extra pass get lost.',
  tldr: [
    'TTFT = network + gateway/auth + tokenize + queue + cache lookup + admission + prefill + sample + emit + network.',
    'Prefill computes logits at the last prompt position, so token 1 needs no extra decode pass.',
    'Under load the queue, not the GPU math, usually dominates; a warm prefix cache shrinks prefill.',
  ],
  plain:
    'The request crosses the network, is authenticated and tokenized, then waits for the scheduler to admit it into a batch. One prefill forward pass over the uncached prompt tokens produces the logits for the next token. Sampling, detokenizing and writing that token to the stream finishes the server side; the client still waits for the network.',
  analogy: {
    name: 'Restaurant order',
    map: [
      ['Host checks your reservation', 'Gateway, TLS and authentication'],
      ['Waiter writes the order in kitchen shorthand', 'Tokenizer: text → token IDs'],
      ['Order waits for a free burner', 'Queue wait for a batch slot and KV memory'],
      ['Prep already done from an earlier order', 'Prefix-cache hit: cached KV for shared prompt tokens'],
      ['Chef cooks the first dish', 'Prefill → logits → sample token 1'],
      ['Runner carries it to your table', 'Detokenize, SSE write, network to client'],
    ],
    breaks:
      'A kitchen cooks each dish separately; a GPU cooks a whole batch in one pass, so your wait depends on everyone else in the batch. The first dish is not "prepared, then cooked again" — prefill already produces it.',
  },
  example: {
    title: 'A four-token prompt behind two other requests',
    inputs: 'Prompt "A B C D" (R3), R1 and R2 already running; [A, B] cached from R1; illustrative times',
    steps: [
      { label: 'Network in', state: 'client → gateway: 20 ms' },
      { label: 'Gateway + auth', state: 'API key checked, routed: 3 ms' },
      { label: 'Tokenize', state: '"A B C D" → [101, 102, 103, 104]: 0.1 ms' },
      { label: 'Queue', state: 'R1, R2 occupy the batch; R3 waits one iteration: 30 ms' },
      { label: 'Cache lookup', state: '[A, B] hit (2 of 4 tokens); [C, D] must be prefilled: 1 ms' },
      { label: 'Admission', state: 'allocate KV for C, D; join next batch: 2 ms' },
      { label: 'Prefill', state: 'one pass over [C, D] → logits at position D: 10 ms' },
      { label: 'Sample + emit', state: 'argmax/sampling → "E"; detokenize; SSE write: 1.2 ms' },
      { label: 'Network out', state: 'gateway → client: 20 ms' },
    ],
    output: 'Client TTFT ≈ 87.3 ms; server TTFT ≈ 47.3 ms; 30 ms of it was queueing.',
    predict: {
      q: 'How many forward passes run before token "E" exists?',
      a: 'One — the prefill pass. Its output at the last prompt position (D) is the distribution for the next token. Decode passes start with token 2.',
    },
  },
  scenes: [
    {
      id: 'q1-s1', title: 'Arrive and authenticate', objective: 'Follow a request through gateway and auth.', duration: 18,
      narration: 'A client sends a POST with a prompt. It crosses the network to the gateway. The gateway terminates TLS, checks the API key and quota, and picks a model replica.',
      lanes: [
        { label: 'Client', items: [{ label: 'POST /generate', kind: 'request' }] },
        { label: 'Network', items: [{ label: '20 ms', kind: 'comm', at: 0.2 }] },
        { label: 'Gateway', items: [{ label: 'TLS', kind: 'request', at: 0.45 }, { label: 'auth + quota', kind: 'request', at: 0.6 }, { label: 'route → replica 2', kind: 'request', at: 0.8 }] },
      ],
      equation: 't = network_in + gateway',
      transition: 'Request moves from client to a chosen replica.', action: 'In the simulator, raise one-way network to 100 ms.',
    },
    {
      id: 'q1-s2', title: 'Tokenize and wait', objective: 'See that queue time is part of TTFT.', duration: 18,
      narration: 'The text becomes token IDs on the CPU. The scheduler has no free slot this iteration, so the request waits. Under load this queue wait often dominates TTFT.',
      lanes: [
        { label: 'CPU', items: [{ label: '"A B C D" → 4 IDs', kind: 'request' }] },
        { label: 'Queue', items: [{ label: 'R1 running', kind: 'decode', at: 0.2 }, { label: 'R2 running', kind: 'decode', at: 0.3 }, { label: 'R3 waiting…', kind: 'neutral', at: 0.45, note: '30 ms' }] },
        { label: 'Batch slot', items: [{ label: 'slot freed', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'TTFT ⊇ queue_wait',
      transition: 'R3 waits until the batch has room.', action: 'Pick the stress preset and read the queue share.',
    },
    {
      id: 'q1-s3', title: 'Cache lookup and admission', objective: 'Show how a prefix hit removes prefill work.', duration: 18,
      narration: 'The scheduler hashes the prompt prefix. Tokens A and B were cached by an earlier request, so only C and D need prefill. It allocates KV blocks for the new tokens and admits the request.',
      lanes: [
        { label: 'Prompt', items: [{ label: 'A', kind: 'kv', at: 0.2, note: 'hit' }, { label: 'B', kind: 'kv', at: 0.3, note: 'hit' }, { label: 'C', kind: 'prefill', at: 0.45, note: 'miss' }, { label: 'D', kind: 'prefill', at: 0.55, note: 'miss' }] },
        { label: 'KV pool', items: [{ label: 'block for C, D', kind: 'kv', at: 0.8 }] },
      ],
      equation: 'uncached = prompt × (1 − hit)',
      transition: 'Two tokens turn amber (cached), two violet (to compute).', action: 'Toggle warm/cold cache and compare bars.',
    },
    {
      id: 'q1-s4', title: 'Prefill gives the first logits', objective: 'Prefill output at the last position is token 1.', duration: 18,
      narration: 'One prefill pass processes C and D together. The output at position D is a probability distribution over the vocabulary. Sampling it gives token E. No extra decode pass is needed.',
      lanes: [
        { label: 'GPU', items: [{ label: 'prefill [C, D]', kind: 'prefill', at: 0.1, note: '10 ms' }] },
        { label: 'Logits', items: [{ label: 'p(next | A..D)', kind: 'prefill', at: 0.45 }] },
        { label: 'Sample', items: [{ label: '"E"', kind: 'decode', at: 0.7 }] },
        { label: 'Wrong model', items: [{ label: 'extra decode pass', kind: 'error', at: 0.85, out: 0.95 }] },
      ],
      equation: 'token_1 = sample(logits[last prompt position])',
      transition: 'Logits appear; the extra-pass box is struck out.', action: 'Turn on "Extra decode pass" and see the red span.',
    },
    {
      id: 'q1-s5', title: 'Emit and deliver', objective: 'Separate server TTFT from client-visible TTFT.', duration: 18,
      narration: 'The token is detokenized into text and written as an SSE event. Server TTFT ends here. The client sees it only after the network and any proxy buffering, so measure both clocks.',
      lanes: [
        { label: 'Server', items: [{ label: 'detokenize', kind: 'request', at: 0.1 }, { label: 'SSE write', kind: 'request', at: 0.3, note: 'server TTFT' }] },
        { label: 'Network', items: [{ label: '20 ms', kind: 'comm', at: 0.5 }, { label: 'proxy buffer?', kind: 'error', at: 0.7 }] },
        { label: 'Client', items: [{ label: '"E" on screen', kind: 'ok', at: 0.9, note: 'client TTFT' }] },
      ],
      equation: 'client_TTFT = server_TTFT + network_in + network_out (+ buffering)',
      transition: 'Token travels to the client.', action: 'Compare the two TTFT stat cards.',
    },
  ],
  sim: {
    tldr: 'Every span comes from ttftSpans(); the Gantt, the cold/warm bars and the table read the same result.',
    omits: [
      'Batching interference: other requests in the same prefill/decode iteration.',
      'Chunked prefill and preemption (see Q7).',
      'Proxy/CDN buffering and client rendering delays.',
      'Variance: every span is a fixed number, not a distribution.',
    ],
  },
  formula: {
    name: 'Time to first token (TTFT)',
    tex: String.raw`\text{TTFT}_{client} = t_{net,in} + t_{gw} + t_{tok} + t_{queue} + t_{lookup} + t_{admit} + t_{prefill} + t_{sample} + t_{emit} + t_{net,out}`,
    vars: [
      ['t_net', 'one-way network time', 'ms'],
      ['t_queue', 'wait for batch slot and KV', 'ms'],
      ['t_prefill', 'uncached tokens ÷ prefill throughput', 'ms'],
      ['t_sample', 'sampling from first logits', 'ms'],
      ['t_emit', 'detokenize + stream write', 'ms'],
    ],
    assumptions: ['Spans sequential unless measured as overlapping', 'Prefill produces first logits', 'No proxy buffering'],
    substituted: '20 + 3 + 1 + 30 + 1 + 2 + (2,000 ÷ 10,000 tok/s = 200) + 1 + 0.2 + 20 = 278.2 ms',
    check: 'every term is milliseconds; tokens ÷ (tokens/s) = s ✓',
    cue: 'Wire, gate, words, wait, warm-check, admit, prefill, pick, push, wire.',
  },
  estimates: [
    { quantity: 'Prefill throughput, one request', value: '10,000', unit: 'tokens/s', assumptions: 'Placeholder; depends on model, GPU, batch', source: 'Teaching assumption — measure', evidence: 'assumed' },
    { quantity: 'Tokenization, 2K tokens', value: '≈ 1', unit: 'ms', assumptions: 'Fast Rust tokenizer, one CPU core', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'Server TTFT, normal preset', value: '238.2', unit: 'ms', assumptions: 'Inputs in simulator', source: 'ttftSpans()', evidence: 'simulated' },
    { quantity: 'Client TTFT, normal preset', value: '278.2', unit: 'ms', assumptions: '+ 2 × 20 ms network', source: 'ttftSpans()', evidence: 'simulated' },
    { quantity: 'Prefill saved by 80 % prefix hit', value: '160', unit: 'ms', assumptions: '2,000 tokens at 10K tok/s', source: 'ttftSpans()', evidence: 'calculated' },
  ],
  compare: {
    naive: 'Measure only GPU prefill; process requests one at a time; recompute every prompt from scratch.',
    improved: 'Trace every span with server and client timestamps; continuous batching; prefix cache; lookup overlapped with queueing.',
    mechanism: 'TTFT is a sum of spans — shrink the biggest one, usually queue wait or uncached prefill.',
    rows: [
      ['TTFT visibility', 'GPU only', 'All spans, both clocks'],
      ['Prefill work', 'Full prompt', 'Uncached suffix only'],
      ['Queue wait under load', 'Grows unchecked', 'Bounded by admission + batching'],
      ['Complexity', 'Low', 'Tracing + cache index'],
    ],
  },
  lab: {
    title: 'Span model with asserts', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 ttft_model.py'], lang: 'python',
    code: `spans = {"net_in": 20, "gateway": 3, "tokenize": 1, "queue": 30,
         "lookup": 1, "admit": 2, "sample": 1, "emit": 0.2, "net_out": 20}
prompt, hit, rate = 2000, 0.0, 10_000          # tokens, cached share, tok/s
spans["prefill"] = prompt * (1 - hit) / rate * 1000
client = sum(spans.values())
server = client - spans["net_in"] - spans["net_out"]
assert abs(client - 278.2) < 1e-9 and abs(server - 238.2) < 1e-9
assert "decode" not in spans                   # token 1 comes from prefill
print(f"client {client:.1f} ms, server {server:.1f} ms, "
      f"queue share {spans['queue'] / client:.0%}")`,
    checks: ['client TTFT = 278.2 ms', 'server TTFT = client − both network legs', 'no decode span before token 1'],
    gaps: 'Real spans overlap and vary; production needs OpenTelemetry spans with server and client timestamps.',
  },
  bench: {
    hypothesis: 'At fixed load, client TTFT ≈ sum of measured server spans + network, and queue wait grows fastest with arrival rate.',
    baseline: 'Single request on an idle replica, cold cache.',
    controlled: ['Model + engine version', 'GPU and topology', 'Prompt length distribution', 'Cache warmness', 'Client location'],
    workload: 'Open-loop Poisson arrivals at 25 %, 50 %, 80 % of measured max throughput; 2K-token prompts.',
    warmup: '60 s discarded.', reps: '3 runs × 10 min per load level.',
    method: 'OpenTelemetry spans per stage + client-side first-byte timestamp.',
    metrics: ['p50/p99 client TTFT', 'p50/p99 server TTFT', 'queue-wait share', 'prefix hit rate (tokens)'],
    interpret: 'If queue share rises with load, scale or admit less; if prefill dominates, raise cache hits or chunk prefill.',
  },
  pitfalls: [
    'Leaving out queue wait: idle-replica TTFT says nothing about TTFT under load.',
    'Adding a full decode pass after prefill: token 1 is sampled from prefill logits.',
    'Comparing server timestamps with client complaints without measuring proxy buffering.',
    'Counting a prefix-cache hit by requests instead of by tokens saved.',
  ],
  optimizations: [
    ['Prefix caching', 'Big TTFT cut for shared system prompts; needs routing affinity (Q8) and memory.'],
    ['Overlap CPU work (lookup, tokenization) with GPU iterations', 'Hides milliseconds; adds pipeline complexity.'],
    ['Chunked prefill + priority for new prompts', 'Bounds queue wait behind long prompts; slightly lower prefill efficiency (Q7).'],
  ],
  breaks: [
    'At sustained overload no span optimization helps: queue wait grows without bound until admission control rejects work.',
    'Prefix caching does nothing for unique prompts; its lookup cost is pure overhead.',
  ],
  interview: {
    short:
      'I would trace it as spans. The request crosses the network to a gateway that terminates TLS, authenticates, checks quota and routes to a replica. The server tokenizes the prompt, then the request waits in a queue until the scheduler has a batch slot and enough KV memory — under load this wait often dominates. The scheduler looks up the prefix cache by hashed token blocks; cached tokens skip compute. On admission it allocates KV blocks and adds the request to the next iteration. One prefill forward pass over the uncached tokens writes their KV and produces logits at the last prompt position. Sampling those logits gives token one directly — there is no extra decode pass. The token is detokenized, written as an SSE event and flushed; that is server TTFT. Client TTFT adds the return network and any proxy buffering. In practice I measure every span with server and client timestamps, then attack the largest: queue wait with capacity or admission, prefill with prefix caching or chunking, delivery with buffering fixes.',
    whiteboard: [
      'Draw lanes: client, gateway/CPU, scheduler, GPU.',
      'List spans in order; mark which overlap.',
      'Write the TTFT sum; underline queue and prefill.',
      'Mark where token 1 comes from (last prefill position).',
      'Show warm vs cold cache prefill cost.',
    ],
    followups: [
      ['Where does chunked prefill change this picture?', 'Prefill is split across iterations, so a long prompt delays others less but its own TTFT grows slightly (Q7).'],
      ['Why can a warm cache still be slow?', 'The warm replica may be busy; waiting in its queue can cost more than recomputing elsewhere (Q8).'],
      ['What runs on CPU and can stall the GPU?', 'Tokenization, scheduling, detokenization and stream writes; a blocked event loop delays every request (Q14).'],
    ],
    debug: [
      'Server p50 TTFT is 300 ms but users report 2 s before the first word appears.',
      'Measure client timestamps. Likely proxy or CDN buffering of the SSE stream (e.g. buffering on), a cold TLS connection, or client rendering. Disable buffering for the route and confirm first-byte times match.',
    ],
    calc: [
      'Prompt 8,000 tokens, 75 % cached, prefill 10,000 tok/s, queue 50 ms, other CPU 6 ms, sampling 1 ms, network 20 ms each way. Client TTFT?',
      'Uncached 2,000 tokens → 200 ms. 40 + 50 + 6 + 200 + 1 = 297 ms.',
    ],
  },
  changeMind: [
    'Span traces showing GPU prefill, not queueing, dominates under real load.',
    'Low prefix reuse in production prompts (cache lookups become overhead).',
    'Client-side measurements that disagree with server TTFT.',
  ],
  recall: [
    ['Which pass produces token 1?', 'Prefill, from logits at the last prompt position.'],
    ['What usually dominates TTFT under load?', 'Queue wait for a batch slot and KV memory.'],
    ['Server vs client TTFT?', 'Client adds both network legs and any buffering.'],
  ],
  glossary: [
    ['TTFT', 'Time to first token: request sent → first output token received.'],
    ['Prefill', 'The forward pass over the prompt that writes its KV cache and yields the first logits.'],
    ['Logits', 'Unnormalized scores over the vocabulary; softmax turns them into probabilities.'],
    ['SSE', 'Server-Sent Events: a text/event-stream HTTP response carrying incremental events.'],
    ['TLS', 'Transport Layer Security: the encryption handshake on an HTTPS connection.'],
  ],
  tags: ['latency', 'ttft', 'prefill', 'tracing', 'gateway'],
};

const q2: Lesson = {
  id: 2,
  group: 'foundations',
  short: 'SSE streaming + cancel',
  question: 'Build token streaming over SSE. Handle client disconnects, cancellation, and cleanup of GPU resources.',
  why: 'Abandoned streams that keep generating silently burn GPU slots and KV memory at scale.',
  tldr: [
    'Stream tokens as SSE events; parse incrementally with UTF-8-safe decoding and framing that survives any chunk split.',
    'Detect disconnects early (heartbeats, write errors) and propagate cancel by request ID into the engine.',
    'Abort at a safe step boundary, then release KV exactly once; cleanup must be idempotent.',
  ],
  plain:
    'The server writes each token as a small "data:" event over one long HTTP response. When the client leaves, the server only notices on its next write, so heartbeats shorten that blind spot. Cancellation must reach the engine by request ID, stop work at a safe boundary and free KV once.',
  analogy: {
    name: 'Pizza delivery by courier',
    map: [
      ['Courier delivering slices one by one', 'SSE events, one per token'],
      ['Courier finds nobody home', 'Write fails: client disconnected'],
      ['Courier phones the kitchen to stop', 'Cancel propagated to the engine by request ID'],
      ['Kitchen finishes the current pizza step', 'Abort at a safe step boundary'],
      ['Oven freed and logged once', 'Idempotent KV release in finally'],
    ],
    breaks:
      'A kitchen sees the phone call instantly; a server only learns of a dead socket when it writes. A courier never splits a slice in half — the network can split a UTF-8 character across chunks.',
  },
  example: {
    title: 'One stream, split badly, then abandoned',
    inputs: 'Events "héllo 世界 🚀", ": ping", "line 1⏎line 2", "[DONE]"; network chunks of 3 bytes',
    steps: [
      { label: 'Encode', state: '"世" = E4 B8 96 (3 bytes); "🚀" = F0 9F 9A 80 (4 bytes)' },
      { label: 'Chunk', state: '3-byte chunks split "🚀" across two chunks' },
      { label: 'Naive decode', state: 'per-chunk decode → "��" replacement characters' },
      { label: 'Stream decode', state: 'TextDecoder(stream: true) holds partial bytes → "🚀" intact' },
      { label: 'Frame', state: 'blank line ends an event; ": ping" is a heartbeat comment' },
      { label: 'Disconnect', state: 'client leaves at 1,500 ms (decode); the 1,500 ms heartbeat write fails' },
      { label: 'Cancel', state: 'abort(request_id); current step ends at 1,520 ms; KV freed once' },
    ],
    output: '4 events parsed for every chunk size; GPU stops within one decode step of detection.',
    predict: {
      q: 'Without heartbeats, a client disconnects while queued. When does the server find out?',
      a: 'Only at its first write — after the full prefill. All of that prefill is wasted GPU work.',
    },
  },
  scenes: [
    {
      id: 'q2-s1', title: 'Tokens become events', objective: 'See the SSE wire format.', duration: 18,
      narration: 'Each token is wrapped as a data line followed by a blank line. Comment lines starting with a colon are heartbeats. The response stays open until a final done event.',
      lanes: [
        { label: 'Engine', items: [{ label: 'tok "Hel"', kind: 'decode', at: 0.1 }, { label: 'tok "lo"', kind: 'decode', at: 0.35 }, { label: 'done', kind: 'ok', at: 0.85 }] },
        { label: 'Wire', items: [{ label: 'data: Hel\\n\\n', kind: 'comm', at: 0.2 }, { label: ': ping', kind: 'neutral', at: 0.5 }, { label: 'data: lo\\n\\n', kind: 'comm', at: 0.45 }, { label: 'event: done', kind: 'comm', at: 0.9 }] },
      ],
      equation: 'event = field lines + blank line',
      transition: 'Tokens turn into framed events.', action: 'Look at the parsed event chips in the simulator.',
    },
    {
      id: 'q2-s2', title: 'Chunks split characters', objective: 'Show why incremental UTF-8 decoding matters.', duration: 18,
      narration: 'The network may cut bytes anywhere. A four-byte emoji can land in two chunks. Decoding each chunk alone produces replacement characters. A streaming decoder keeps the partial bytes until the rest arrives.',
      lanes: [
        { label: 'Bytes', items: [{ label: 'F0 9F', kind: 'comm', at: 0.1 }, { label: '9A 80', kind: 'comm', at: 0.3 }] },
        { label: 'Naive', items: [{ label: '��', kind: 'error', at: 0.5 }] },
        { label: 'Streaming', items: [{ label: '🚀', kind: 'ok', at: 0.8 }] },
      ],
      equation: 'decode(bytes, {stream: true})',
      transition: 'Broken glyph replaced by the correct one.', action: 'Set chunk size to 1 byte.',
    },
    {
      id: 'q2-s3', title: 'Client walks away', objective: 'Detection happens only on a write.', duration: 18,
      narration: 'The client closes the tab during decode. The server does not know yet. It learns on the next token write or heartbeat that fails. Without heartbeats, a queued request is noticed only after prefill.',
      lanes: [
        { label: 'Client', items: [{ label: 'tab closed', kind: 'error', at: 0.15 }] },
        { label: 'Server', items: [{ label: 'write tok 33', kind: 'decode', at: 0.4 }, { label: 'EPIPE / reset', kind: 'error', at: 0.6 }] },
        { label: 'Engine', items: [{ label: 'still generating', kind: 'decode', at: 0.3, out: 0.9 }] },
      ],
      equation: 't_detect = min(next token write, next heartbeat)',
      transition: 'Failed write reveals the disconnect.', action: 'Turn heartbeats off and move the disconnect into the queue.',
    },
    {
      id: 'q2-s4', title: 'Propagate cancel by ID', objective: 'Stop the engine, not just the handler.', duration: 18,
      narration: 'Exiting the HTTP handler does not stop the GPU. The handler calls abort with the request ID. The scheduler removes queued work at once, or stops running work at the next step boundary.',
      lanes: [
        { label: 'Handler', items: [{ label: 'abort(req-42)', kind: 'request', at: 0.1 }] },
        { label: 'Scheduler', items: [{ label: 'mark cancelled', kind: 'request', at: 0.35 }, { label: 'finish current step', kind: 'decode', at: 0.55 }] },
        { label: 'Batch', items: [{ label: 'req-42', kind: 'decode', out: 0.7 }, { label: 'req-17', kind: 'decode' }, { label: 'req-51', kind: 'decode' }] },
      ],
      equation: 't_stop = next safe boundary after t_detect',
      transition: 'Request leaves the batch at a boundary.', action: 'Pick the failure preset: cancel not propagated.',
    },
    {
      id: 'q2-s5', title: 'Release exactly once', objective: 'Idempotent cleanup in every exit path.', duration: 18,
      narration: 'KV blocks are released only after the engine confirms the request is no longer in flight. Both the abort path and the finally block call release; the second call does nothing. Emptying the allocator cache is not per-request cleanup.',
      lanes: [
        { label: 'KV blocks', items: [{ label: '#12', kind: 'kv', out: 0.5 }, { label: '#13', kind: 'kv', out: 0.5 }, { label: '#40', kind: 'kv', out: 0.5 }] },
        { label: 'Calls', items: [{ label: 'release() → freed 3', kind: 'ok', at: 0.5 }, { label: 'release() → no-op', kind: 'neutral', at: 0.75 }] },
      ],
      equation: 'release(): if done return; done = true; free()',
      transition: 'Blocks freed once; second call ignored.', action: 'Check KV-released time in the simulator.',
    },
  ],
  sim: {
    tldr: 'simulateCancel() places every event on one timeline; the parser panel runs the real SseParser on the chosen chunk size.',
    omits: [
      'Real sockets, kernels and proxies; detection is modelled as "next write".',
      'Backpressure from a slow consumer (see the Python lab: bounded queue + drain timeout).',
      'Batch effects: cancelling one request does not speed up the others here.',
    ],
  },
  formula: {
    name: 'Cancellation waste (model)',
    tex: String.raw`W_{gpu} = t_{stop} - \max(t_{disc},\, t_{prefill\_start}),\quad t_{detect} = \min(t_{next\,write},\, t_{next\,heartbeat})`,
    vars: [
      ['t_disc', 'moment the client disconnects', 'ms'],
      ['t_detect', 'first failed write or heartbeat', 'ms'],
      ['t_stop', 'next safe boundary after detection (end of request if not propagated)', 'ms'],
      ['W_gpu', 'GPU time spent for nobody', 'ms'],
    ],
    assumptions: ['Writes fail promptly on a dead socket', 'Abort only at step/chunk boundaries', 'Single request view'],
    substituted: 'Disconnect 1,500 ms in decode; heartbeat at 1,500 ms detects it; running step ends 1,520 ms → W = 20 ms. Not propagated → W = 2,800 − 1,500 = 1,300 ms',
    check: 'ms − ms = ms ✓',
    cue: 'Notice on write, cancel by ID, stop at a boundary, free once.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Wasted GPU, propagated, normal preset', value: '20', unit: 'ms', assumptions: '40 ms token gap', source: 'simulateCancel()', evidence: 'simulated' },
    { quantity: 'Wasted GPU, not propagated', value: '1,300', unit: 'ms', assumptions: '50-token reply', source: 'simulateCancel()', evidence: 'simulated' },
    { quantity: 'nginx proxy_read_timeout default', value: '60', unit: 's', assumptions: 'Idle streams beyond this are cut', source: 'nginx docs', evidence: 'vendor spec' },
    { quantity: 'Heartbeat interval', value: '5–15', unit: 's', assumptions: 'Below proxy idle timeouts', source: 'Design choice', evidence: 'assumed' },
  ],
  compare: {
    naive: 'Async generator yields tokens; on disconnect the handler exits and hopes the engine stops; per-chunk text decoding.',
    improved: 'Heartbeats + write errors detect early; abort(request_id) into the scheduler; idempotent finally release; streaming UTF-8 decoder; bounded queues.',
    mechanism: 'The engine is a separate actor: only an explicit cancel by ID stops GPU work and frees KV.',
    rows: [
      ['Wasted GPU after disconnect', 'Until the reply finishes', '≤ 1 step after detection'],
      ['KV leak risk', 'High (missed exit paths)', 'Release once in finally'],
      ['Text correctness', 'Broken multi-byte chars', 'Exact for any chunking'],
      ['Complexity', 'Low', 'Cancel API + state machine'],
    ],
  },
  lab: {
    title: 'Cancellation-safe SSE server + browser client', kind: 'cpu', file: 'labs/sse_server.py', deps: 'Python 3.10+, stdlib only; any modern browser',
    commands: ['python3 labs/sse_server.py', 'open labs/sse_client.html', 'python3 -m unittest labs/test_sse_server.py'], lang: 'python',
    code: `async def stream(req_id, writer, engine):
    release = once(lambda: engine.release_kv(req_id))   # idempotent
    try:
        async for tok in engine.generate(req_id):
            writer.write(f"data: {json.dumps({'t': tok})}\\n\\n".encode())
            await asyncio.wait_for(writer.drain(), 5)    # backpressure
    except (ConnectionError, asyncio.TimeoutError, asyncio.CancelledError):
        await engine.abort(req_id)    # stops at next safe boundary
        raise
    finally:
        release()                     # second call is a no-op`,
    checks: ['Disconnect before admission removes the queue entry', 'Disconnect in prefill/decode stops within one boundary', 'Release count is exactly 1 per request', 'Parser output identical for every byte split'],
    gaps: 'Mock CPU engine: real engines need an abort API that is safe against in-flight CUDA work.',
  },
  bench: {
    hypothesis: 'With propagated cancel, KV frees within one decode step of detection and no blocks leak.',
    baseline: 'Handler-only exit (no abort call).',
    controlled: ['Engine version', 'Reply length', 'Token gap', 'Heartbeat interval'],
    workload: '1,000 requests; 30 % disconnect at a uniformly random time.',
    warmup: '50 requests.', reps: '3 runs.',
    method: 'Engine KV-block metric, per-request tokens generated after disconnect, leak check at the end.',
    metrics: ['Detect latency', 'Disconnect → KV free', 'Wasted tokens', 'Leaked blocks (must be 0)'],
    interpret: 'Any nonzero leak or wasted tokens ≫ 1 per cancel means an exit path skips abort or release.',
  },
  pitfalls: [
    'Using EventSource for authenticated prompts: it only does GET and cannot set custom headers; use fetch() streaming with POST.',
    'Assuming the async generator exit stops the GPU engine.',
    'Calling an allocator "empty cache" as per-request cleanup — it frees nothing still referenced and hurts everyone.',
    'Decoding each network chunk separately and corrupting multi-byte characters.',
  ],
  optimizations: [
    ['Heartbeats during queue and prefill', 'Earlier detection; a few bytes of traffic per interval.'],
    ['Bounded per-stream send queue + drain timeout', 'Protects memory from slow consumers; may cut slow clients off.'],
    ['Chunked prefill as preemption points', 'Faster aborts of long prompts; small efficiency loss (Q7).'],
  ],
  breaks: [
    'Proxies that buffer responses hide disconnects and delay tokens; disable buffering on the route.',
    'Engines without an abort API: the only option is finishing the request, so waste equals the remaining reply.',
  ],
  interview: {
    short:
      'I would stream with a POST endpoint returning text/event-stream, because EventSource only supports GET without custom headers. Each token becomes a data event; I add an id, an explicit done event, and comment heartbeats every few seconds so proxies keep the connection and dead clients are noticed. On the client I read the body with fetch, decode with a streaming UTF-8 decoder and split events on blank lines, buffering partial lines, so any chunk boundary works. Per stream I keep a bounded queue and a drain timeout for backpressure. The key part is cancellation: a disconnect is detected on a failed write or heartbeat, and the handler calls engine.abort with the request ID. The scheduler removes queued work immediately or stops running work at the next decode step or prefill chunk boundary. Only after the engine confirms nothing is in flight do I release the KV blocks, in a finally block guarded so a second call is a no-op. I test disconnects before admission, during prefill, during decode, slow consumers and exceptions, and check that no blocks leak.',
    whiteboard: [
      'Draw client ↔ proxy ↔ handler ↔ scheduler ↔ GPU.',
      'Write the SSE event format and heartbeat comment.',
      'State machine: queued → prefill → decode → done / cancelled.',
      'Mark detection points and safe boundaries.',
      'Show idempotent release in finally.',
    ],
    followups: [
      ['Why not WebSockets?', 'SSE is one-way, plain HTTP, proxy-friendly and enough for token streams; WebSockets add bidirectional state you rarely need.'],
      ['How do you resume after a network blip?', 'Send event ids; the client retries with Last-Event-ID and the server replays from a short per-request buffer, if kept.'],
      ['What if the consumer is slower than generation?', 'Bounded queue fills, drain times out; either drop the stream or pause that sequence — never buffer unboundedly.'],
    ],
    debug: [
      'During a spike from mobile clients, KV usage climbs while open connections stay flat.',
      'Disconnects are not reaching the engine: requests keep generating for dead sockets. Compare engine active requests with open streams, then add abort-by-ID in every exit path and heartbeats during queue/prefill.',
    ],
    calc: [
      '100 req/s, 5 % disconnect mid-decode with ~250 tokens left, 40 ms per token, cancel not propagated. Average batch slots wasted?',
      'Little\'s law: 5 req/s × (250 × 0.04 s = 10 s) = 50 slots permanently busy with abandoned work.',
    ],
  },
  changeMind: [
    'An engine whose abort cost exceeds finishing short replies (then just finish them).',
    'Clients that require bidirectional messages (consider WebSockets).',
    'Measured disconnect rates near zero (heartbeat cost may not pay off).',
  ],
  recall: [
    ['How does a server learn of a disconnect?', 'On its next failed write or heartbeat.'],
    ['What must cleanup be?', 'Idempotent and run after the engine stops using the KV.'],
    ['Why fetch instead of EventSource?', 'EventSource is GET-only without custom headers.'],
  ],
  glossary: [
    ['EventSource', 'Browser API for SSE; GET-only and cannot set custom headers.'],
    ['Backpressure', 'Slowing the producer when the consumer cannot keep up.'],
    ['Idempotent', 'Safe to run more than once with the same effect as running once.'],
    ['Heartbeat', 'A periodic comment line (": ping") that keeps the stream alive and tests the socket.'],
  ],
  tags: ['streaming', 'sse', 'cancellation', 'cleanup', 'utf-8'],
};

const q4: Lesson = {
  id: 4,
  group: 'foundations',
  short: 'PagedAttention',
  question: 'Explain how PagedAttention works and why managing KV cache like virtual memory changes LLM serving.',
  why: 'Paged KV is why modern engines fit several times more concurrent requests in the same memory.',
  tldr: [
    'KV lives in fixed-size blocks; a per-sequence block table maps logical blocks to scattered physical blocks.',
    'Waste drops to < 1 block per sequence and shared prefixes are stored once with reference counts.',
    'Writing into a shared partial block triggers copy-on-write; release decrements refs and frees at zero.',
  ],
  plain:
    'Instead of reserving one big contiguous region per request, the engine hands out small fixed blocks (e.g. 16 tokens) as the sequence grows. A block table translates "token i of this sequence" into a physical block, and the attention kernel follows that table. Identical prefixes point to the same blocks until someone writes, which copies just that block.',
  analogy: {
    name: 'Library shelves and borrowing records',
    map: [
      ['Shelves of equal-sized boxes', 'Physical KV blocks in GPU memory'],
      ['Borrowing card listing box numbers', 'Block table per sequence'],
      ['Two readers sharing one box of notes', 'Shared prefix block, ref count 2'],
      ['Photocopy before scribbling in a shared box', 'Copy-on-write'],
      ['Box returns when the last reader leaves', 'Free when ref count hits 0'],
    ],
    breaks:
      'An OS pages to disk on demand; PagedAttention does not transparently swap active attention state — the scheduler must explicitly preempt, swap or recompute. Library boxes are read rarely; KV blocks are read on every decode step through an indirection the kernel must support.',
  },
  example: {
    title: 'Two sequences, 4 tokens per block, shared prefix',
    inputs: 'Prompt "The cat sat on the mat" = 6 tokens; B = 4; 8 physical blocks',
    steps: [
      { label: 'Append A × 6', state: 'A: L0 → #0 (4/4), L1 → #1 (2/4)' },
      { label: 'Fork B from A', state: 'B: L0 → #0, L1 → #1; ref(#0) = ref(#1) = 2; 0 bytes copied' },
      { label: 'Append A × 1', state: '#1 is shared and partial → copy to #2; A: L1 → #2 (3/4)' },
      { label: 'Append B × 3', state: '#1 now private → fills to 4/4; new #3 (1/4)' },
      { label: 'Cancel A', state: 'ref(#0) 2 → 1; #2 freed → free list' },
      { label: 'Cancel A again', state: 'no-op (idempotent)' },
      { label: 'Append B × 4', state: 'fills #3, then reuses freed #2' },
    ],
    output: 'B = 13 tokens in 4 blocks (3 slots spare); 1 copy-on-write; nothing leaked.',
    predict: {
      q: 'When A appends its 7th token, does it write into block #1?',
      a: 'No. #1 is shared (ref 2) and partially filled, so copy-on-write gives A a private copy (#2) first.',
    },
  },
  scenes: [
    {
      id: 'q4-s1', title: 'Contiguous reservation wastes memory', objective: 'See why worst-case reservation hurts.', duration: 18,
      narration: 'A contiguous allocator reserves the maximum length for every request. A request that stops after 7 tokens still holds 32 slots. Most of the reserved memory is empty.',
      lanes: [
        { label: 'Req A (7 used)', items: [{ label: '7 used', kind: 'kv' }, { label: '25 reserved, empty', kind: 'error', at: 0.3 }] },
        { label: 'Req B (13 used)', items: [{ label: '13 used', kind: 'kv', at: 0.4 }, { label: '19 reserved, empty', kind: 'error', at: 0.6 }] },
        { label: 'Req C', items: [{ label: 'no room → rejected', kind: 'error', at: 0.85 }] },
      ],
      equation: 'waste = n × max_len − Σ T_i',
      transition: 'Empty reservations block a new request.', action: 'Raise the contiguous reservation slider.',
    },
    {
      id: 'q4-s2', title: 'Blocks and a block table', objective: 'Map logical blocks to physical blocks.', duration: 18,
      narration: 'Paging splits KV into blocks of 4 tokens. Sequence A gets block 0, then block 1 as it grows. The block table records the mapping; physical blocks need not be adjacent.',
      lanes: [
        { label: 'A logical', items: [{ label: 'L0', kind: 'kv' }, { label: 'L1', kind: 'kv', at: 0.5 }] },
        { label: 'Block table', items: [{ label: 'L0 → #0', kind: 'request', at: 0.25 }, { label: 'L1 → #1', kind: 'request', at: 0.65 }] },
        { label: 'Physical pool', items: [{ label: '#0 4/4', kind: 'kv', at: 0.3 }, { label: '#1 2/4', kind: 'kv', at: 0.7 }, { label: '#2 free', kind: 'neutral' }, { label: '#3 free', kind: 'neutral' }] },
      ],
      equation: 'blocks = Σ ceil(T_i / B)',
      transition: 'Blocks allocated on demand.', action: 'Step to operation 2 in the simulator.',
    },
    {
      id: 'q4-s3', title: 'Fork shares, write copies', objective: 'Understand ref counts and copy-on-write.', duration: 18,
      narration: 'B forks from A, so both tables point to blocks 0 and 1, each with ref count 2. When A writes its next token, block 1 is shared and partial. The allocator copies it to block 2 for A.',
      lanes: [
        { label: 'A', items: [{ label: '#0', kind: 'prefill' }, { label: '#1', kind: 'prefill', out: 0.6 }, { label: '#2 (copy)', kind: 'decode', at: 0.6 }] },
        { label: 'B', items: [{ label: '#0', kind: 'prefill', at: 0.2 }, { label: '#1', kind: 'prefill', at: 0.2 }] },
        { label: 'Refs', items: [{ label: '#0: 2', kind: 'neutral', at: 0.3 }, { label: '#1: 2 → 1', kind: 'neutral', at: 0.7 }] },
      ],
      equation: 'write to block with ref > 1 ⇒ copy first',
      transition: 'A diverges onto its own copy.', action: 'Step to operation 4; watch the COW counter.',
    },
    {
      id: 'q4-s4', title: 'Cancel frees safely', objective: 'Decrement refs; free only at zero.', duration: 18,
      narration: 'A is cancelled. Its private block 2 drops to ref zero and returns to the free list. Shared block 0 drops to one and stays, because B still reads it. Releasing A twice changes nothing.',
      lanes: [
        { label: 'A blocks', items: [{ label: '#0 ref 2→1', kind: 'prefill', out: 0.4 }, { label: '#2 ref 1→0', kind: 'kv', out: 0.4 }] },
        { label: 'Free list', items: [{ label: '#2', kind: 'neutral', at: 0.5 }] },
        { label: 'Second release', items: [{ label: 'no-op', kind: 'ok', at: 0.8 }] },
      ],
      equation: 'ref -= 1; if ref == 0: free',
      transition: 'Only unreferenced blocks are freed.', action: 'Step to operations 6 and 7.',
    },
    {
      id: 'q4-s5', title: 'Capacity and the kernel cost', objective: 'Know the limits.', duration: 18,
      narration: 'When no block is free, the scheduler must preempt, swap or reject; paging does not invent memory. The attention kernel reads through the block table, which costs some indirection and metadata.',
      lanes: [
        { label: 'Pool (3 blocks)', items: [{ label: '#0', kind: 'kv' }, { label: '#1', kind: 'kv' }, { label: '#2', kind: 'kv' }] },
        { label: 'Append B', items: [{ label: 'needs #3', kind: 'request', at: 0.3 }, { label: 'out of blocks', kind: 'error', at: 0.55 }] },
        { label: 'Scheduler', items: [{ label: 'preempt / swap / reject', kind: 'neutral', at: 0.8 }] },
      ],
      equation: 'paging removes waste, not unique bytes',
      transition: 'Allocation fails cleanly; nothing half-written.', action: 'Pick the failure preset (3 blocks).',
    },
  ],
  sim: {
    tldr: 'runOps() replays the toy script on a real allocator; the block tables, pool, counters and waste chart read its states.',
    omits: [
      'The attention kernel and its indirection cost.',
      'Swap to CPU memory and recompute-based preemption.',
      'Prefix hashing to discover shared blocks (Q8); sharing here comes from an explicit fork.',
    ],
  },
  formula: {
    name: 'Paged KV block count',
    tex: String.raw`N_{blocks} = \sum_i \left\lceil \frac{T_i}{B} \right\rceil,\qquad N_{shared} = \left\lfloor \frac{P}{B} \right\rfloor + \sum_i \left\lceil \frac{T_i - B\lfloor P/B \rfloor}{B} \right\rceil`,
    vars: [
      ['T_i', 'tokens cached by sequence i', 'tokens'],
      ['B', 'tokens per block', 'tokens/block'],
      ['P', 'shared prefix length', 'tokens'],
      ['N', 'physical blocks', 'blocks'],
    ],
    assumptions: ['Only full prefix blocks are shared', 'Partial last block is private (copy-on-write)', 'No eviction'],
    substituted: 'B = 16; T = 100, 33, 16 → 7 + 3 + 1 = 11 blocks = 176 slots for 149 tokens (27 slots waste)',
    check: 'tokens ÷ (tokens/block) = blocks ✓',
    cue: 'Pages on demand, table to translate, refs to share, copy before write.',
  },
  estimates: [
    { quantity: 'Max waste per sequence', value: '< B', unit: 'token slots', assumptions: 'Only the last block is partial', source: 'Block formula', evidence: 'calculated' },
    { quantity: 'Default block size (vLLM)', value: '16', unit: 'tokens', assumptions: 'Version-dependent default', source: 'vLLM docs', evidence: 'vendor spec' },
    { quantity: 'KV waste, prior systems vs vLLM', value: '60–80 % vs < 4 %', unit: 'of KV memory', assumptions: 'Paper workloads', source: 'Kwon et al., SOSP 2023 (paper-reported)', evidence: 'measured' },
    { quantity: 'Toy: paged vs contiguous slots', value: '16 vs 32', unit: 'slots (B=13)', assumptions: 'max_len 32, B = 4', source: 'wasteCompare()', evidence: 'simulated' },
  ],
  compare: {
    naive: 'Contiguous max-length reservation per request; every request copies the shared system prompt.',
    improved: 'Fixed-size blocks on demand + block table; ref-counted sharing with copy-on-write.',
    mechanism: 'Indirection lets memory follow actual tokens and lets identical prefixes point to the same blocks.',
    rows: [
      ['Waste per request', 'max_len − T', '< 1 block'],
      ['Shared prefix', 'Copied per request', 'Stored once'],
      ['Concurrency at fixed memory', 'Low', 'Several × higher (workload-dependent)'],
      ['Kernel complexity', 'Simple contiguous reads', 'Block-table indirection'],
    ],
  },
  lab: {
    title: 'Paged allocator with copy-on-write', kind: 'browser', deps: 'Runs in this app (src/engines/g1.ts); Node 20+ for tests',
    commands: ['npx vitest run src/engines/g1.test.ts'], lang: 'ts',
    code: `let s = newAllocator(8, 4);                      // 8 blocks, 4 tokens each
for (const op of [
  { op: 'create', seq: 'A' }, { op: 'append', seq: 'A', n: 6 },
  { op: 'fork', seq: 'B', from: 'A' },            // share #0, #1
  { op: 'append', seq: 'A', n: 1 },               // copy-on-write #1 → #2
  { op: 'release', seq: 'A' }, { op: 'release', seq: 'A' },  // 2nd = no-op
] as AllocOp[]) {
  const r = applyOp(s, op);
  console.assert(checkInvariants(r.state).length === 0, r.note);
  s = r.state;
}`,
    checks: ['refs equal owners after every op', 'no free block is referenced', 'failed append changes nothing', 'release twice = release once'],
    gaps: 'No GPU memory, no attention kernel, no swap; production allocators also handle prefix hashing and eviction.',
  },
  bench: {
    hypothesis: 'At equal GPU memory, paged allocation sustains more concurrent sequences than contiguous max-length reservation.',
    baseline: 'Same engine with contiguous reservation (or block size = max length).',
    controlled: ['Model', 'GPU memory budget', 'Prompt/output length distribution', 'Arrival trace'],
    workload: 'Replay a recorded length distribution at increasing arrival rates.',
    warmup: '2 min.', reps: '3 runs per setting.',
    method: 'Engine metrics: running sequences, KV blocks used, preemptions; throughput at fixed p99 TTFT.',
    metrics: ['Max concurrent sequences', 'KV utilization (tokens / allocated slots)', 'Preemptions/s', 'Throughput at SLO'],
    interpret: 'Gains scale with the gap between max_len and real lengths, and with prefix reuse.',
  },
  pitfalls: [
    'Thinking paging shrinks unique KV bytes — it only removes reservation waste and duplicate prefixes.',
    'Writing into a shared partial block without copy-on-write, corrupting the other sequence.',
    'Freeing blocks while a kernel in the current step may still read them.',
    'Equating it with OS demand paging: active KV is not transparently swapped.',
  ],
  optimizations: [
    ['Smaller block size', 'Less tail waste; bigger tables and more indirection per kernel read.'],
    ['Prefix caching on block hashes', 'Reuse across requests; needs eviction policy and namespace isolation (Q8, Q21).'],
    ['Swap or recompute on pressure', 'Avoids rejection; swap costs PCIe bandwidth, recompute costs prefill.'],
  ],
  breaks: [
    'All sequences near max length with no shared prefixes: little waste to remove.',
    'Kernels without block-table support: you must copy into contiguous buffers, losing the benefit.',
  ],
  interview: {
    short:
      'Classic serving reserved a contiguous KV region for each request sized for its maximum length, so most of that memory sat empty and requests with identical system prompts each kept their own copy. PagedAttention borrows the virtual-memory idea: KV is stored in fixed-size physical blocks, say 16 tokens, allocated only when a sequence actually needs the next block. Each sequence has a block table mapping logical block numbers to physical blocks, and the attention kernel follows that table, so the blocks can be anywhere. Waste drops to less than one block per sequence. Because mapping is indirect, sequences can share blocks: a shared prefix or a parallel-sampling fork points at the same physical blocks with a reference count. If a sequence writes into a shared, partially filled block, the allocator copies just that block first. Cancellation decrements refs and frees at zero, idempotently. The result is several times more concurrent requests at the same memory. Limits: unique bytes are unchanged, the kernel pays an indirection cost, and when blocks run out the scheduler still must preempt, swap or reject.',
    whiteboard: [
      'Draw contiguous reservations with empty tails.',
      'Draw logical blocks → block table → scattered physical blocks.',
      'Show fork with ref counts and copy-on-write.',
      'Write N = Σ ceil(T_i / B).',
      'List limits: unique bytes, indirection, capacity.',
    ],
    followups: [
      ['How does block size trade off?', 'Smaller blocks waste less but enlarge tables and add per-block overhead in the kernel; 16 is a common default.'],
      ['What happens when the pool is full?', 'The scheduler preempts a sequence (swap to CPU or drop and recompute later) or stops admitting.'],
      ['How is beam search cheaper?', 'Beams fork and share all prompt blocks; only diverging blocks are copied.'],
    ],
    debug: [
      'After a load test, free blocks never return to the starting count.',
      'Refs leak: some exit path (error or cancel) skips release, or fork increments refs that release never decrements. Run an invariant check (owners == refs, free ∩ referenced = ∅) after every op to find it.',
    ],
    calc: [
      'B = 16; requests hold 100, 33 and 16 tokens. Blocks? Wasted slots?',
      '7 + 3 + 1 = 11 blocks = 176 slots; 176 − 149 = 27 wasted slots.',
    ],
  },
  changeMind: [
    'Measured kernel slowdown from indirection on my GPU and head sizes.',
    'Length distribution where requests nearly always reach max length.',
    'An engine with contiguous but resizable buffers that already shares prefixes.',
  ],
  recall: [
    ['What maps a logical block to physical memory?', 'The per-sequence block table.'],
    ['When does copy-on-write happen?', 'On writing to a shared, partially filled block.'],
    ['Does paging reduce unique KV bytes?', 'No — it removes waste and duplicate prefixes.'],
  ],
  glossary: [
    ['PagedAttention', 'Attention over KV stored in fixed-size blocks addressed through a block table (vLLM).'],
    ['Block table', 'Per-sequence array mapping logical block index → physical block ID.'],
    ['Copy-on-write (COW)', 'Copying a shared block only when one owner is about to modify it.'],
    ['Reference count', 'Number of sequences pointing at a block; freed at zero.'],
  ],
  tags: ['memory', 'kv', 'paging', 'allocator', 'vllm'],
};

const q5: Lesson = {
  id: 5,
  group: 'foundations',
  short: 'FlashAttention',
  question: 'FlashAttention computes the same attention mathematically. So where do the speedups actually come from?',
  why: 'It tests whether you think in memory traffic, not just FLOPs.',
  tldr: [
    'Same FLOPs (4·N²·d per head); the win is fewer HBM bytes — no N × N score matrix written or re-read.',
    'Tiles of Q, K, V stay in on-chip SRAM; online softmax merges tiles using a running max and normalizer.',
    'Gain grows with tile size and long N; it does not remove quadratic compute.',
  ],
  plain:
    'Naive attention writes the full score matrix to GPU memory (HBM), reads it back for softmax, writes the probabilities, and reads them again. FlashAttention computes scores tile by tile in fast on-chip SRAM and never stores the full matrix. A running max and running sum make the tile-by-tile softmax exact.',
  analogy: {
    name: 'Delivery truck and a workbench',
    map: [
      ['Warehouse across town', 'HBM (large, slower to reach)'],
      ['Workbench in the shop', 'SRAM / shared memory (tiny, very fast)'],
      ['Trips by truck', 'Bytes moved between HBM and the chip'],
      ['Finishing each part on the bench before shipping', 'Fused tiles: score, softmax, weighted sum in SRAM'],
      ['Keeping a running tally', 'Online softmax: running max m and sum l'],
    ],
    breaks:
      'A truck trip is mostly fixed cost; HBM traffic scales with bytes. The bench work (FLOPs) is not reduced — if the chip is already compute-bound, fewer trips help little.',
  },
  example: {
    title: 'One scalar query row over four keys',
    inputs: 'q = 1, k = [1, 2, 3, 4], v = [10, 20, 30, 40] (scalar teaching simplification)',
    steps: [
      { label: 'Key 1', state: 's = 1; m = 1; l = e⁰ = 1; acc = 10 → out 10' },
      { label: 'Key 2', state: 's = 2; m = 2; rescale l, acc by e^(1−2); l = 1.3679; out 17.31' },
      { label: 'Key 3', state: 's = 3; m = 3; l = 1.5032; out 25.75' },
      { label: 'Key 4', state: 's = 4; m = 4; l = 1.5530; out 34.93' },
      { label: 'Reference', state: 'Σ e^{s_j} v_j / Σ e^{s_j} = 34.93 (materialized)' },
    ],
    output: 'Online result equals the materialized softmax-weighted sum (≈ 34.926) without ever storing all scores.',
    predict: {
      q: 'Set q = 200. Scores reach 800. What does exp() without max subtraction return, and does the online version survive?',
      a: 'e⁸⁰⁰ overflows to ∞ and ∞/∞ = NaN. The online version subtracts the running max, so every exponent is ≤ 0 and the result is ≈ 40.',
    },
  },
  scenes: [
    {
      id: 'q5-s1', title: 'Naive attention round-trips HBM', objective: 'Count the N² passes.', duration: 18,
      narration: 'Standard attention computes the score matrix and writes it to HBM. Softmax reads it, writes probabilities, and the next matmul reads them again. That is four passes over an N by N matrix.',
      lanes: [
        { label: 'HBM', items: [{ label: 'Q, K', kind: 'kv' }, { label: 'write S (N²)', kind: 'comm', at: 0.2 }, { label: 'read S', kind: 'comm', at: 0.4 }, { label: 'write P', kind: 'comm', at: 0.6 }, { label: 'read P', kind: 'comm', at: 0.8 }] },
        { label: 'Chip', items: [{ label: 'QKᵀ', kind: 'prefill', at: 0.1 }, { label: 'softmax', kind: 'prefill', at: 0.5 }, { label: 'PV', kind: 'prefill', at: 0.85 }] },
      ],
      equation: 'bytes_naive ≈ (4N² + 4Nd) × b',
      transition: 'Score matrix bounces between chip and HBM.', action: 'Read the materialized-bytes stat.',
    },
    {
      id: 'q5-s2', title: 'Tiles stay on chip', objective: 'See tiling in SRAM.', duration: 18,
      narration: 'FlashAttention loads a tile of queries into SRAM, then streams tiles of keys and values past it. Scores and probabilities for that tile never leave the chip. Only the output row is written.',
      lanes: [
        { label: 'SRAM', items: [{ label: 'Q tile', kind: 'request' }, { label: 'K,V tile 1', kind: 'kv', at: 0.25, out: 0.5 }, { label: 'K,V tile 2', kind: 'kv', at: 0.5, out: 0.75 }, { label: 'K,V tile 3', kind: 'kv', at: 0.75 }] },
        { label: 'HBM writes', items: [{ label: 'O tile only', kind: 'ok', at: 0.9 }] },
      ],
      equation: 'bytes_tiled ≈ (2Nd + 2Nd·⌈N/B_r⌉) × b',
      transition: 'K/V tiles stream through; no N² write.', action: 'Change query rows per tile.',
    },
    {
      id: 'q5-s3', title: 'Online softmax', objective: 'Merge tiles exactly with a running max.', duration: 18,
      narration: 'Each new tile may raise the maximum score. The running sum and the weighted accumulator are rescaled by e to the old max minus new max. At the end, dividing by the sum gives the exact softmax result.',
      lanes: [
        { label: 'Running max m', items: [{ label: '1', kind: 'prefill' }, { label: '2', kind: 'prefill', at: 0.3 }, { label: '3', kind: 'prefill', at: 0.55 }, { label: '4', kind: 'prefill', at: 0.8 }] },
        { label: 'Normalizer l', items: [{ label: '1', kind: 'kv' }, { label: '1.368', kind: 'kv', at: 0.3 }, { label: '1.503', kind: 'kv', at: 0.55 }, { label: '1.553', kind: 'kv', at: 0.8 }] },
        { label: 'Output', items: [{ label: '34.93', kind: 'ok', at: 0.95 }] },
      ],
      equation: "l' = l·e^{m−m'} + e^{s−m'};  acc' = acc·e^{m−m'} + e^{s−m'}·v",
      transition: 'm rises; l and acc rescale.', action: 'Change keys per tile: the output stays the same.',
    },
    {
      id: 'q5-s4', title: 'Same math, different bytes', objective: 'Separate FLOPs from bytes.', duration: 18,
      narration: 'Both versions perform four N squared d floating point operations. Tiling cuts bytes moved, so arithmetic intensity rises. On memory-bound shapes that is the speedup. It also avoids allocating the N by N matrix at all.',
      lanes: [
        { label: 'FLOPs', items: [{ label: 'naive 4N²d', kind: 'prefill' }, { label: 'tiled 4N²d', kind: 'prefill', at: 0.3 }] },
        { label: 'Bytes', items: [{ label: 'naive', kind: 'error', at: 0.5 }, { label: 'tiled (fewer)', kind: 'ok', at: 0.7 }] },
        { label: 'Intensity', items: [{ label: 'FLOP/byte ↑', kind: 'decode', at: 0.9 }] },
      ],
      equation: 'intensity = FLOPs / bytes',
      transition: 'Bytes bar shrinks; FLOPs bar unchanged.', action: 'Pick the stress preset (N = 32K).',
    },
    {
      id: 'q5-s5', title: 'Where it stops helping', objective: 'Know the limits.', duration: 18,
      narration: 'Dense compute is still quadratic in sequence length. Tiles that are too small re-read K and V too often. Very large head dimensions shrink the tile that fits in SRAM, and decode with one query row has little to tile.',
      lanes: [
        { label: 'Limits', items: [{ label: 'O(N²) FLOPs remain', kind: 'error', at: 0.15 }, { label: 'tiny tiles → more reads', kind: 'error', at: 0.4 }, { label: 'large d → small tiles', kind: 'error', at: 0.6 }, { label: 'decode: 1 query row', kind: 'neutral', at: 0.8 }] },
      ],
      equation: 'gain ≈ 2·B_r / d (this model)',
      transition: 'Failure cases appear one by one.', action: 'Pick the failure preset (32-row tiles, q = 200).',
    },
  ],
  sim: {
    tldr: 'onlineAttention() and attentionRef() run on the toy row; attentionTraffic() drives the bytes chart and stats.',
    omits: [
      'L2 cache hits that soften re-reads of K and V.',
      'Extra naive passes (scale, mask, dropout) and FP32 scores, which make real naive traffic higher.',
      'Masking, multiple heads, batching and backward pass.',
      'Kernel launch overhead and achieved bandwidth.',
    ],
  },
  formula: {
    name: 'Online softmax update',
    tex: String.raw`m' = \max(m, s_j),\quad l' = l\,e^{m-m'} + e^{s_j-m'},\quad a' = a\,e^{m-m'} + e^{s_j-m'} v_j,\quad o = a / l`,
    vars: [
      ['s_j', 'score q·k_j for key j', '—'],
      ['m', 'running maximum score', '—'],
      ['l', 'running sum of exponentials', '—'],
      ['a', 'running unnormalized weighted sum', 'units of v'],
      ['o', 'attention output', 'units of v'],
    ],
    assumptions: ['Scalar q, k, v teaching case; real heads use vectors and scale by 1/√d', 'Exact in real arithmetic; floats differ slightly'],
    substituted: 'q = 1, k = [1,2,3,4], v = [10..40]: o = 2,961.5 / 84.79 ≈ 34.926',
    check: 'a has units of v, l is unitless → a/l has units of v ✓',
    cue: 'Keep the max, rescale the sum, never write N².',
  },
  estimates: [
    { quantity: 'Score matrix, one head, N = 32K, BF16', value: '2', unit: 'GiB', assumptions: '32,768² × 2 B', source: 'Arithmetic', evidence: 'calculated' },
    { quantity: 'HBM traffic, N = 4,096, d = 128', value: '132 vs 66', unit: 'MiB (naive vs tiled)', assumptions: '128 query rows per tile, BF16', source: 'attentionTraffic()', evidence: 'calculated' },
    { quantity: 'H100 SXM HBM3 bandwidth', value: '3.35', unit: 'TB/s (decimal)', assumptions: 'Board spec, peak', source: 'NVIDIA H100 datasheet', evidence: 'vendor spec' },
    { quantity: 'H100 shared memory per SM', value: 'up to 228', unit: 'KB', assumptions: 'Configurable split with L1', source: 'NVIDIA Hopper tuning guide', evidence: 'vendor spec' },
  ],
  compare: {
    naive: 'Separate kernels: QKᵀ → write S → softmax → write P → PV, each round-tripping HBM.',
    improved: 'One fused kernel: tiles in SRAM, online softmax, write only O.',
    mechanism: 'Fewer HBM bytes and launches at identical FLOPs; no N × N allocation.',
    rows: [
      ['FLOPs', '4N²d', '4N²d (same)'],
      ['HBM bytes', '≈ 4N² + 4Nd elements', '≈ 2Nd(1 + N/B_r) elements'],
      ['Extra memory', 'N² per head', 'O(N) statistics'],
      ['Kernel launches', 'Several', 'One'],
    ],
  },
  lab: {
    title: 'Online softmax equals materialized softmax', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 online_softmax.py'], lang: 'python',
    code: `import math
def ref(q, ks, vs):
    s = [q * k for k in ks]; m = max(s)
    e = [math.exp(x - m) for x in s]
    return sum(a * v for a, v in zip(e, vs)) / sum(e)

def online(q, ks, vs):
    m, l, acc = -math.inf, 0.0, 0.0
    for k, v in zip(ks, vs):
        s = q * k; m2 = max(m, s); c = math.exp(m - m2)
        l, acc, m = l * c + math.exp(s - m2), acc * c + math.exp(s - m2) * v, m2
    return acc / l

for q in (-3, 0, 1, 200):
    assert abs(online(q, [1, 2, 3, 4], [10, 20, 30, 40]) - ref(q, [1, 2, 3, 4], [10, 20, 30, 40])) < 1e-9
print(online(1, [1, 2, 3, 4], [10, 20, 30, 40]))   # 34.926...`,
    checks: ['Matches reference for negative, zero, small and huge q', 'No overflow at q = 200', 'Order of keys and tile size do not change the result'],
    gaps: 'Scalar CPU teaching code; real kernels tile vectors in SRAM on the GPU.',
  },
  bench: {
    hypothesis: 'A fused tiled attention kernel beats unfused attention most at long N and small d, with identical outputs within tolerance.',
    baseline: 'Unfused PyTorch: matmul → softmax → matmul.',
    controlled: ['GPU', 'dtype', 'batch × heads', 'causal mask on/off', 'library versions'],
    workload: 'N ∈ {512 … 32K}, d ∈ {64, 128}.',
    warmup: '10 iterations.', reps: '100 timed iterations, median and p90.',
    method: 'CUDA events around the kernel; Nsight Compute for DRAM bytes.',
    metrics: ['Latency', 'DRAM bytes read/written', 'Achieved TFLOP/s', 'Max |Δ| vs FP32 reference'],
    interpret: 'Speedup should track the measured DRAM-byte reduction; if not, the shape is compute- or launch-bound.',
  },
  pitfalls: [
    'Claiming FlashAttention reduces FLOPs or makes attention linear.',
    'Expecting identical bits: reordering floating-point sums changes the last digits.',
    'Forgetting fully masked rows: all scores −∞ gives 0/0 unless handled.',
    'Assuming big decode speedups: decode has one query row and is dominated by KV reads.',
  ],
  optimizations: [
    ['Larger query tiles', 'Fewer K/V re-reads; limited by SRAM and register pressure.'],
    ['Causal block skipping', 'Skips fully masked tiles (~2× less work); only for causal masks.'],
    ['Split-K / flash-decoding for long decode', 'Parallelizes over keys for one query; needs a final reduction.'],
  ],
  breaks: [
    'Compute-bound shapes (short N, large batch): traffic savings barely show.',
    'Very large head dimensions or tiny SRAM force small tiles, so K/V are re-read many times.',
  ],
  interview: {
    short:
      'The FLOPs are identical — about four N squared d per head for QK transpose and the weighted sum. The speedup is memory traffic. A standard implementation materializes the N by N score matrix in HBM, reads it back for softmax, writes the probabilities, and reads them again for the second matmul, often across several kernel launches. At long sequence lengths those N-squared passes dominate time, and the matrix itself may not even fit. FlashAttention tiles the problem: it loads a block of queries into on-chip SRAM and streams blocks of keys and values past it, computing scores, softmax and the weighted sum inside SRAM. The trick that makes tiling exact is online softmax: keep a running maximum and a running normalizer, rescale the partial sums when the maximum increases, and divide at the end. Only the output is written back. So arithmetic intensity rises and memory-bound attention becomes faster, with fewer launches and no N-squared allocation. It does not remove quadratic compute, results differ only by floating-point ordering, and gains shrink when tiles are small or the shape is already compute-bound.',
    whiteboard: [
      'Write attention: softmax(QKᵀ/√d)V.',
      'Count HBM passes of the naive pipeline.',
      'Draw Q tile in SRAM, K/V tiles streaming.',
      'Write the online softmax update.',
      'Compare FLOPs (same) vs bytes (fewer).',
    ],
    followups: [
      ['Why is it exact?', 'Rescaling by e^{m−m\'} makes the merged partial sums equal the full softmax in real arithmetic.'],
      ['Does it help decode?', 'Less: one query row means little reuse; decode is bound by reading KV. Split-K variants help long contexts.'],
      ['What limits tile size?', 'SRAM capacity and registers per SM, which shrink as head dim grows.'],
    ],
    debug: [
      'Your custom attention returns NaN at long context in FP16 but not at short context.',
      'exp() overflow without max subtraction, or fully masked rows giving 0/0. Subtract the running max, accumulate in FP32 and special-case rows with no valid keys.',
    ],
    calc: [
      'N = 8,192, BF16. Size of one head\'s score matrix? With 64 heads?',
      '8,192² × 2 B = 128 MiB per head; × 64 heads = 8 GiB per layer per sequence.',
    ],
  },
  changeMind: [
    'Profiler shows attention is compute-bound at my shapes.',
    'Kernel not available for my GPU, dtype or mask pattern.',
    'Workload dominated by decode with short contexts.',
  ],
  recall: [
    ['Does FlashAttention reduce FLOPs?', 'No — it reduces HBM bytes and launches.'],
    ['What makes tiled softmax exact?', 'Running max and normalizer with rescaling.'],
    ['What never gets written to HBM?', 'The N × N score and probability matrices.'],
  ],
  glossary: [
    ['HBM', 'High-bandwidth memory: the GPU\'s main DRAM (tens of GB, TB/s).'],
    ['SRAM / shared memory', 'Small on-chip memory per SM, much faster than HBM.'],
    ['Online softmax', 'Computing softmax in one pass with a running max and sum.'],
    ['Arithmetic intensity', 'FLOPs per byte moved; decides compute- vs memory-bound.'],
    ['SM', 'Streaming multiprocessor: one of the GPU\'s parallel compute units.'],
  ],
  tags: ['kernel', 'attention', 'memory-bandwidth', 'sram', 'softmax'],
};

export const lessons: Lesson[] = [q1, q2, q3, q4, q5];
