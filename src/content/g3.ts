// Models & GPU performance (Q11-Q15).
import type { Lesson } from '../types';

const q11: Lesson = {
  id: 11,
  group: 'gpu',
  short: 'Quantization formats',
  question: 'Compare FP8, INT8, INT4, and NVFP4. Choose a quantization strategy, then measure its impact on quality, latency, and memory.',
  why: 'Quantization is the cheapest memory and cost lever, and the easiest way to silently break quality.',
  tldr: [
    'Quantizing = divide by a scale, round to a few levels; error comes from rounding small values and clipping outliers.',
    'FP8 keeps relative precision; INT4 and NVFP4 need fine-grained scales, and effective bits must include that scale metadata.',
    'Choose weights, activations and KV separately; then measure quality, latency and memory on your engine and GPU.',
  ],
  plain:
    'Quantization stores each number with fewer bits: divide by a scale, round to the nearest allowed level, multiply back. One large outlier stretches the scale so small values round to zero. Formats differ in how levels are spaced (even for INT, logarithmic for FP) and how many scales they keep.',
  analogy: {
    name: 'A ruler with fewer marks',
    map: [
      ['Marks on the ruler', 'Representable levels (255 for INT8, 15 for INT4)'],
      ['Ruler length', 'Scale × maximum level = clipping range'],
      ['Measuring a 12 m pole with a 1 m-marked ruler', 'An outlier forcing a coarse scale'],
      ['A small ruler per drawer', 'Per-group (INT4) or per-16-value block (NVFP4) scales'],
    ],
    breaks:
      'A ruler error is visible on one object; a quantization error spreads through billions of multiply-adds and may only show on some tasks or long contexts.',
  },
  example: {
    title: 'Toy vector [0.02, −0.7, 1.4, 12] through five formats',
    inputs: 'x = [0.02, −0.7, 1.4, 12], amax = 12, symmetric scales',
    steps: [
      { label: 'INT8 per-tensor', state: 's = 12/127 = 0.0945\nq = round(x/s) = [0, −7, 15, 127]\nx̂ = [0, −0.661, 1.417, 12]   ← 0.02 lost' },
      { label: 'INT4 per-tensor', state: 's = 12/7 = 1.714\nq = [0, 0, 1, 7]\nx̂ = [0, 0, 1.714, 12]   ← two values lost' },
      { label: 'INT4 per-group (2)', state: 'group 1: s = 0.7/7 = 0.1 → [0, −0.7]\ngroup 2: s = 1.714 → [1.714, 12]' },
      { label: 'FP8 E4M3 per-tensor', state: 's = 12/448 = 0.0268\nx/s = [0.747, −26.1, 52.3, 448] → grid [0.75, −26, 52, 448]\nx̂ = [0.0201, −0.696, 1.393, 12]' },
      { label: 'NVFP4 (E2M1, 16-block)', state: 'tensor scale = 12/(6·448); block scale (E4M3) = 448 → s = 2\nx/s = [0.01, −0.35, 0.7, 6] → [0, −0.5, 0.5, 6] → x̂ = [0, −1, 1, 12]' },
    ],
    output: 'FP8 keeps every value within 1 %; per-tensor INT8/INT4 destroy the small values; finer scales fix INT4.',
    predict: {
      q: 'Under INT4 per-tensor, what does −0.7 reconstruct to?',
      a: '0. The scale is 12/7 ≈ 1.71, so −0.7/1.71 ≈ −0.41 rounds to 0. The outlier set the ruler.',
    },
  },
  scenes: [
    {
      id: 'q11-s1', title: 'Scale, round, rescale', objective: 'See the three steps of symmetric quantization.', duration: 18,
      narration: 'Quantization has three steps. Divide by a scale. Round to the nearest integer level. Multiply back by the scale. The scale is the largest absolute value divided by the largest level.',
      lanes: [
        { label: 'Input', items: [{ label: '0.02', kind: 'request' }, { label: '−0.7', kind: 'request' }, { label: '1.4', kind: 'request' }, { label: '12', kind: 'request' }] },
        { label: 'Scale', items: [{ label: 's = 12 / 127', kind: 'prefill', at: 0.3, note: '0.0945' }] },
        { label: 'Integers', items: [{ label: '0', kind: 'kv', at: 0.55 }, { label: '−7', kind: 'kv', at: 0.6 }, { label: '15', kind: 'kv', at: 0.65 }, { label: '127', kind: 'kv', at: 0.7 }] },
        { label: 'Rebuilt', items: [{ label: '0', kind: 'error', at: 0.85 }, { label: '−0.661', kind: 'decode', at: 0.88 }, { label: '1.417', kind: 'decode', at: 0.91 }, { label: '12', kind: 'decode', at: 0.94 }] },
      ],
      equation: 'x̂ = s · round(x / s),  s = amax / 127',
      transition: 'Values become integers, then reconstructed values; 0.02 becomes 0.', action: 'Predict which value is lost before it appears.',
    },
    {
      id: 'q11-s2', title: 'One outlier ruins the ruler', objective: 'Show how an outlier coarsens the scale for everyone.', duration: 18,
      narration: 'Raise the outlier and the scale grows with it. With INT4 per-tensor there are only 15 levels. The step becomes 1.7, so minus 0.7 and 0.02 both collapse to zero.',
      lanes: [
        { label: 'INT4 levels', items: [{ label: '−12 … 0 … 12', kind: 'prefill', note: '15 levels, step 1.71' }] },
        { label: 'Small values', items: [{ label: '0.02 → 0', kind: 'error', at: 0.35 }, { label: '−0.7 → 0', kind: 'error', at: 0.5 }] },
        { label: 'Large values', items: [{ label: '1.4 → 1.71', kind: 'kv', at: 0.65 }, { label: '12 → 12', kind: 'decode', at: 0.8 }] },
      ],
      equation: 'step = 12 / 7 = 1.714',
      transition: 'Small values fall into the zero bucket.', action: 'Pick the Failure preset and raise the outlier to 100.',
    },
    {
      id: 'q11-s3', title: 'Finer scales: groups and blocks', objective: 'Explain per-group INT4 and NVFP4 block scaling.', duration: 18,
      narration: 'Give each small group its own scale and the outlier only hurts its neighbours. INT4 weight-only methods use groups of about 128. NVFP4 uses one FP8 E4M3 scale per 16 values plus one FP32 scale per tensor.',
      lanes: [
        { label: 'Group 1', items: [{ label: '0.02, −0.7', kind: 'request' }, { label: 's = 0.1', kind: 'prefill', at: 0.3 }, { label: '−0.7 kept', kind: 'decode', at: 0.5 }] },
        { label: 'Group 2', items: [{ label: '1.4, 12', kind: 'request' }, { label: 's = 1.71', kind: 'prefill', at: 0.4 }] },
        { label: 'Metadata', items: [{ label: '+16 bits / 128 values', kind: 'kv', at: 0.7, note: 'INT4 g128 → 4.125 b' }, { label: '+8 bits / 16 values', kind: 'kv', at: 0.85, note: 'NVFP4 → 4.5 b' }] },
      ],
      equation: 'bits/value = payload + scale_bits / group',
      transition: 'One scale splits into many; metadata bytes appear.', action: 'Change INT4 group size from 4 to 1 and watch the error bars.',
    },
    {
      id: 'q11-s4', title: 'Floating-point levels', objective: 'Contrast evenly spaced INT levels with log-spaced FP levels.', duration: 18,
      narration: 'FP8 E4M3 has four exponent bits, so its levels are dense near zero and sparse near the maximum of 448. Every value keeps roughly the same relative error, about 6 percent at worst. That is why FP8 tolerates outliers better than INT8.',
      lanes: [
        { label: 'INT8 grid', items: [{ label: 'even steps', kind: 'neutral', note: 'abs error ≤ s/2' }] },
        { label: 'FP8 grid', items: [{ label: 'dense near 0', kind: 'prefill', at: 0.3 }, { label: 'sparse near 448', kind: 'prefill', at: 0.45 }] },
        { label: 'Result', items: [{ label: '0.02 → 0.0201', kind: 'decode', at: 0.65 }, { label: '−0.7 → −0.696', kind: 'decode', at: 0.75 }, { label: '1.4 → 1.393', kind: 'decode', at: 0.85 }] },
      ],
      equation: 'E4M3: (1 + m/8) · 2^(e−7), max 448',
      transition: 'All four values survive under FP8.', action: 'Switch format to FP8 and compare MSE with INT8.',
    },
    {
      id: 'q11-s5', title: 'Choose, then measure', objective: 'Turn the comparison into a deployment decision with measurements.', duration: 18,
      narration: 'Decide per tensor type. Weights, activations and KV cache are separate choices. Check hardware support: FP8 needs Hopper or newer, NVFP4 needs Blackwell. Then measure task quality, latency at your batch sizes, and memory. Four bits is not automatically faster.',
      lanes: [
        { label: 'Weights', items: [{ label: 'FP8 / INT4 g128 / NVFP4', kind: 'prefill', at: 0.1 }] },
        { label: 'Activations', items: [{ label: 'FP8 (if kernels)', kind: 'decode', at: 0.3 }] },
        { label: 'KV cache', items: [{ label: 'FP8 after long-ctx eval', kind: 'kv', at: 0.5 }] },
        { label: 'Gates', items: [{ label: 'quality Δ', kind: 'ok', at: 0.65 }, { label: 'p50/p99 latency', kind: 'ok', at: 0.75 }, { label: 'GiB', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'ship if Δquality ≤ budget AND latency/memory improve on target GPU',
      transition: 'Three tensor types get separate formats and gates.', action: 'Read the decision panel under the simulator.',
    },
  ],
  sim: {
    tldr: 'All five formats quantize the same toy vector with one function, quantize(); move the outlier or clip range and every chart updates together.',
    omits: [
      'Calibration data and algorithms (GPTQ, AWQ, SmoothQuant); scales here come from amax only.',
      'Error propagation through matmuls and layers; only per-element error is shown.',
      'Kernel speed: no latency is simulated, because it depends on engine kernels and hardware.',
      'FP8 E5M2 and MXFP4; NVFP4 block scale rounding follows the 2025 NVIDIA description.',
    ],
  },
  formula: {
    name: 'Symmetric quantization',
    tex: String.raw`\hat{x} = s \cdot \operatorname{clamp}\!\left(\operatorname{round}\!\left(\tfrac{x}{s}\right), -q_{max}, q_{max}\right),\quad s = \frac{c \cdot \max|x|}{q_{max}}`,
    vars: [
      ['x, x̂', 'original and reconstructed value', 'same as x'],
      ['s', 'scale (per tensor, group or block)', 'same as x'],
      ['q_max', 'largest integer level (127 INT8, 7 INT4)', 'levels'],
      ['c', 'clip fraction of the range (≤ 1)', '—'],
      ['bits/value', 'payload bits + scale bits ÷ group size', 'bits'],
    ],
    assumptions: ['Symmetric, zero-point free', 'Round-to-nearest', 'Scales stored in FP16 (INT4 g128) or E4M3 (NVFP4)'],
    substituted: 's = 12/127 = 0.0945;  x̂(0.02) = 0.0945 · round(0.212) = 0  →  100 % error',
    check: 'x / s is dimensionless → integer level → × s returns units of x ✓',
    cue: 'The biggest value sets the ruler; small values fall between the marks.',
  },
  estimates: [
    { quantity: '70B weights, BF16', value: '130.4', unit: 'GiB', assumptions: '70e9 × 2 B', source: 'params × bytes', evidence: 'calculated' },
    { quantity: '70B weights, FP8', value: '65.2', unit: 'GiB', assumptions: 'Per-tensor scales ignored', source: 'params × bytes', evidence: 'calculated' },
    { quantity: '70B weights, INT4 g128', value: '33.6', unit: 'GiB', assumptions: '4 + 16/128 = 4.125 bits', source: 'params × bits / 8', evidence: 'calculated' },
    { quantity: '70B weights, NVFP4', value: '36.7', unit: 'GiB', assumptions: '4 + 8/16 = 4.5 bits', source: 'NVIDIA NVFP4 blog, 2025-06-24', evidence: 'calculated' },
    { quantity: 'NVFP4 memory vs FP16', value: '≈ 3.5×', unit: 'smaller', assumptions: 'Vendor claim', source: 'NVIDIA technical blog, 2025-06-24', evidence: 'vendor spec' },
    { quantity: 'Quality change on your tasks', value: 'not measured', unit: 'points', assumptions: 'Needs your eval set', source: 'Benchmark protocol below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'Per-tensor INT4 for weights, activations and KV, no calibration, ship if perplexity looks fine.',
    improved: 'FP8 weights + activations where kernels exist; INT4 per-group or NVFP4 weights with calibration; FP8 KV only after long-context evals.',
    mechanism: 'Finer scales keep small values off the zero bucket; matching the format to tensor-core support avoids dequantization overhead.',
    rows: [
      ['Weight memory (70B)', '≈ 33 GiB but broken outputs', '33–65 GiB depending on format'],
      ['Quality', 'Unknown, often large drop', 'Measured against a budget'],
      ['Latency', 'Can be slower (dequant at large batch)', 'Faster where memory-bound and supported'],
      ['Complexity', 'Low', 'Calibration + per-format evals'],
    ],
  },
  lab: {
    title: 'Fake-quantize a tensor and compare error', kind: 'cpu', deps: 'Python 3.10+, numpy',
    commands: ['pip install numpy', 'python3 quant_lab.py'], lang: 'python',
    code: `import numpy as np
x = np.array([0.02, -0.7, 1.4, 12.0])

def int_q(x, qmax, group=None):
    g = x.reshape(-1, group or x.size)
    s = np.abs(g).max(1, keepdims=True) / qmax
    return (np.clip(np.round(g / s), -qmax, qmax) * s).ravel()

for name, xh in [("INT8", int_q(x, 127)), ("INT4", int_q(x, 7)),
                 ("INT4 g2", int_q(x, 7, 2))]:
    print(f"{name:8s}", np.round(xh, 4), "mse", ((x - xh) ** 2).mean())

assert int_q(x, 127)[0] == 0          # outlier kills 0.02
assert abs(int_q(x, 7, 2)[1] + 0.7) < 1e-9  # grouping saves -0.7`,
    checks: ['INT8 per-tensor maps 0.02 → 0', 'INT4 per-group(2) recovers −0.7 exactly', 'MSE: INT4 g2 < INT4 per-tensor'],
    gaps: 'Fake quantization on CPU; real speed needs engine kernels (e.g. FP8 GEMM, Marlin-style INT4) on a supported GPU.',
  },
  bench: {
    hypothesis: 'FP8 W8A8 reduces decode step time and memory vs BF16 with ≤ 1 point drop on our task suite.',
    baseline: 'BF16 weights, BF16 KV, same engine version and GPU.',
    controlled: ['Model checkpoint', 'Engine + version', 'GPU + driver', 'Batch sizes', 'Prompt/output length distribution', 'Sampling (greedy for evals)'],
    workload: 'Task suite (≥ 500 items per task incl. long-context), plus a latency sweep at batch 1, 8, 32, 128.',
    warmup: 'Discard first 20 requests per configuration (graph capture, autotune).', reps: '5 runs per point; report median and spread.',
    method: 'Quality: exact-match / pass@1 with bootstrap CI. Latency: server TTFT, inter-token latency p50/p99. Memory: engine-reported weight + KV GiB.',
    metrics: ['Δ quality with 95 % CI', 'TTFT / ITL p50, p99', 'tok/s at SLO', 'weight GiB, KV capacity (tokens)'],
    interpret: 'Ship only if the CI on Δquality lies within budget AND latency improves at the batch sizes that carry traffic.',
  },
  pitfalls: [
    'Judging quality by perplexity only: task and long-context accuracy can drop while perplexity barely moves.',
    'Assuming 4-bit is faster: weight-only INT4 dequantizes in the kernel and can be slower at large, compute-bound batches.',
    'Forgetting scale metadata: INT4 g128 is 4.125 bits, NVFP4 is 4.5 bits per value.',
    'Using NVFP4 or FP8 on GPUs without matching tensor cores: emulation erases the win.',
  ],
  optimizations: [
    ['Per-group / per-block scales', 'Lower error; more metadata bytes and slightly more complex kernels.'],
    ['Outlier handling (SmoothQuant-style rescaling, keep sensitive layers in BF16)', 'Better quality; mixed-precision bookkeeping.'],
    ['FP8 KV cache', 'Halves KV memory → more concurrency; needs long-context quality checks.'],
  ],
  breaks: [
    'Compute-bound large-batch prefill with weight-only INT4: dequant overhead can make it slower than BF16.',
    'Small models or reasoning-heavy tasks where every point of accuracy matters more than memory.',
    'Hardware without native support for the format (e.g. NVFP4 before Blackwell).',
  ],
  interview: {
    short:
      'Quantization divides values by a scale and rounds them to a small set of levels, so the errors come from rounding small values and clipping outliers. FP8 E4M3 has floating-point spacing, so it keeps relative precision across magnitudes and works for weights, activations and KV on Hopper and newer. INT8 has even spacing and needs outlier handling for activations. INT4 is mostly used weight-only, with per-group scales around 128 values, which costs about 4.125 bits per weight. NVFP4 is NVIDIA’s Blackwell format: 4-bit E2M1 values with an FP8 scale per 16 values plus an FP32 tensor scale, about 4.5 bits. My default strategy: FP8 weights and activations if the GPU and engine support it; INT4 or NVFP4 weights when memory is the binding constraint, with calibration; FP8 KV only after long-context evals. Then I measure three things on the target engine: task quality with confidence intervals against a budget, latency at the batch sizes that carry traffic, and weight plus KV memory. Four bits is not automatically faster.',
    whiteboard: [
      'Write x̂ = s·round(x/s); compute s for the toy vector.',
      'Show INT8 per-tensor destroying 0.02; INT4 per-group fixing it.',
      'Draw FP8 log-spaced levels vs INT even levels.',
      'Table: format × {weights, activations, KV} × hardware.',
      'Measurement plan: quality CI, latency sweep, memory.',
    ],
    followups: [
      ['Why can weight-only INT4 be slower?', 'Matmuls still run in BF16 after in-kernel dequantization; at large batch the GEMM is compute-bound, so dequant adds work with no bandwidth saving to offset it.'],
      ['How is NVFP4 different from generic INT4?', 'E2M1 floating-point values {0 … 6} with an FP8 E4M3 scale per 16 values and an FP32 tensor scale, executed natively by Blackwell tensor cores.'],
      ['Does quantizing weights shrink the KV cache?', 'No. KV precision is a separate setting; weights and KV are different tensors.'],
    ],
    debug: [
      'After INT4 weight-only quantization, p50 latency at batch 64 got worse than BF16. Why?',
      'At batch 64 the GEMMs are closer to compute-bound; INT4 weights are dequantized to BF16 inside the kernel, adding work without the bandwidth benefit. INT4 weight-only mainly helps memory-bound small-batch decode.',
    ],
    calc: ['A 70B model in NVFP4 (4.5 bits incl. block scales). Weight memory in GiB?', '70e9 × 4.5 / 8 = 39.4e9 B ≈ 36.7 GiB.'],
  },
  changeMind: [
    'Quality CI on our own tasks crossing the budget for a format.',
    'Engine lacking fast kernels for the format on our GPU.',
    'Traffic dominated by large batches (compute-bound) rather than small-batch decode.',
  ],
  recall: [
    ['What sets the scale in symmetric per-tensor quantization?', 'The largest absolute value (amax) divided by the max level.'],
    ['Effective bits for NVFP4?', '≈ 4.5 (4-bit value + FP8 scale per 16).'],
    ['Which GPUs run NVFP4 natively?', 'Blackwell (e.g. B200).'],
  ],
  glossary: [
    ['FP8 E4M3', '8-bit float with 4 exponent and 3 mantissa bits; max 448.'],
    ['INT8 / INT4', 'Integer formats with 255 / 15 symmetric levels.'],
    ['NVFP4', 'NVIDIA 4-bit float (E2M1) with an E4M3 scale per 16 values and an FP32 tensor scale.'],
    ['Per-group quantization', 'One scale per small group of values (e.g. 128) instead of per tensor.'],
    ['Calibration', 'Choosing scales from representative data to minimize error.'],
  ],
  tags: ['quantization', 'fp8', 'int4', 'nvfp4', 'memory', 'quality'],
};

const q12: Lesson = {
  id: 12,
  group: 'gpu',
  short: 'Choosing GPUs',
  question: 'You’re deploying an LLM. How would you choose between H100, H200, B200, and L40S based on bandwidth, memory capacity, compute, and cost?',
  why: 'Hardware is the largest cost line, and the right GPU depends on whether your workload is limited by fit, bandwidth or compute.',
  tldr: [
    'First check fit: weights plus KV must fit a feasible tensor-parallel group, with headroom for runtime memory.',
    'Decode is usually bandwidth-bound: tokens/s ≤ bandwidth ÷ bytes read per step. Prefill and big batches lean on compute.',
    'Compare dollars per delivered token at your latency SLO, measured on your workload — not peak TFLOPS per dollar.',
  ],
  plain:
    'Each decode step reads every weight and the active KV from memory, so memory bandwidth caps tokens per second. Memory capacity decides how many GPUs you need to fit the model and how much KV (concurrency) is left. Compute matters for prefill and large batches.',
  analogy: {
    name: 'Delivery trucks',
    map: [
      ['Truck cargo space', 'GPU memory capacity (GB)'],
      ['Road speed and lanes', 'Memory bandwidth (TB/s)'],
      ['Loading crew speed', 'Tensor-core compute (TFLOPS)'],
      ['Trucks driving as a convoy', 'Tensor-parallel group over NVLink'],
      ['Daily rental fee', '$ per GPU-hour'],
    ],
    breaks:
      'Trucks do not exchange cargo mid-trip; tensor-parallel GPUs exchange activations every layer, so interconnect (NVLink vs PCIe) changes the answer.',
  },
  example: {
    title: '70B BF16, batch 1: who is fastest per user?',
    inputs: 'Weights 140 GB (130.4 GiB), batch 1, KV small, 100 % of peak bandwidth (upper bound)',
    steps: [
      { label: 'Fit', state: 'H100 80 GB → TP2 · H200 141 GB → TP2 (1 GPU leaves ~1 GB) · B200 180 GB → 1 GPU · L40S 48 GB → TP4' },
      { label: 'Bytes per step', state: '≈ 140 GB (all weights read once per token)' },
      { label: 'Step time ≥ bytes ÷ total bandwidth', state: 'H100×2: 140 / 6.7 = 20.9 ms\nH200×2: 140 / 9.6 = 14.6 ms\nB200×1: 140 / 8.0 = 17.5 ms\nL40S×4: 140 / 3.46 = 40.5 ms' },
      { label: 'Tokens/s per user ≤ 1 / step', state: '48 · 69 · 57 · 25 tok/s' },
    ],
    output: 'Bandwidth decides batch-1 speed. B200 fits on one GPU; H200 TP2 is fastest per user; L40S is slowest and needs PCIe TP.',
    predict: {
      q: 'Same compute, more bandwidth: how much faster is batch-1 decode on 2×H200 than 2×H100?',
      a: '4.8 / 3.35 ≈ 1.43×, if the step is memory-bound and both reach the same fraction of peak bandwidth.',
    },
  },
  scenes: [
    {
      id: 'q12-s1', title: 'Does it fit?', objective: 'Size weights and KV against GPU memory.', duration: 18,
      narration: 'Start with fit. A 70 billion parameter model in BF16 needs 140 gigabytes for weights alone. One H100 has 80. Add KV cache and runtime reserves, then round up to a feasible tensor-parallel group.',
      lanes: [
        { label: 'Need', items: [{ label: 'weights 140 GB', kind: 'prefill' }, { label: '+ KV', kind: 'kv', at: 0.3 }, { label: '+ reserve', kind: 'neutral', at: 0.45 }] },
        { label: 'H100 80 GB', items: [{ label: 'GPU 1', kind: 'request', at: 0.6 }, { label: 'GPU 2', kind: 'request', at: 0.7 }, { label: 'TP2', kind: 'ok', at: 0.85 }] },
        { label: 'B200 180 GB', items: [{ label: 'GPU 1', kind: 'ok', at: 0.75, note: 'fits alone' }] },
      ],
      equation: 'GPUs ≥ (weights + KV) / usable memory per GPU',
      transition: 'Need bar fills GPUs one by one.', action: 'Set the failure preset: 405B on L40S.',
    },
    {
      id: 'q12-s2', title: 'Decode reads everything', objective: 'Show why bandwidth sets decode speed.', duration: 18,
      narration: 'Every decode step reads all weights and the active KV once, then does only about two operations per weight per sequence. At batch one the GPU spends almost all its time moving bytes.',
      lanes: [
        { label: 'HBM', items: [{ label: '140 GB', kind: 'kv' }] },
        { label: 'Bus', items: [{ label: '→ 3.35 TB/s →', kind: 'comm', at: 0.3 }, { label: '20.9 ms on TP2', kind: 'comm', at: 0.6 }] },
        { label: 'Tensor cores', items: [{ label: '140 GFLOP', kind: 'prefill', at: 0.5, note: '0.07 ms at peak' }, { label: 'idle', kind: 'error', at: 0.8 }] },
      ],
      equation: 't_step ≥ bytes / (N · BW)',
      transition: 'Bytes stream across the bus while compute sits mostly idle.', action: 'Raise batch in the simulator and watch the decode line move right.',
    },
    {
      id: 'q12-s3', title: 'Roofline and ridge points', objective: 'Place decode and prefill on the roofline.', duration: 18,
      narration: 'The ridge point is peak FLOPS divided by bandwidth: about 295 FLOP per byte for H100 BF16. Batch-one decode sits near 1. Long prefill sits in the thousands. Only workloads right of the ridge benefit from more compute.',
      lanes: [
        { label: 'Decode b=1', items: [{ label: 'AI ≈ 1', kind: 'decode', at: 0.2, note: 'bandwidth-bound' }] },
        { label: 'Decode b=128', items: [{ label: 'AI ≈ 100', kind: 'decode', at: 0.4 }] },
        { label: 'Ridge', items: [{ label: 'H200 206 · H100 295 · B200 281 · L40S 419', kind: 'neutral', at: 0.6 }] },
        { label: 'Prefill 2K', items: [{ label: 'AI ≈ 2,000', kind: 'prefill', at: 0.8, note: 'compute-bound' }] },
      ],
      equation: 'ridge = peak TFLOPS / bandwidth',
      transition: 'Workloads appear left and right of the ridge.', action: 'Find each ridge point in the roofline chart.',
    },
    {
      id: 'q12-s4', title: 'Interconnect and topology', objective: 'Explain why NVLink vs PCIe matters for tensor parallelism.', duration: 18,
      narration: 'Tensor parallelism all-reduces activations twice per layer. H100, H200 and B200 use NVLink at hundreds of gigabytes per second to terabytes per second. L40S uses PCIe, about 64 gigabytes per second, so large TP groups pay heavily in communication.',
      lanes: [
        { label: 'H100/H200', items: [{ label: 'NVLink 900 GB/s', kind: 'comm', at: 0.2 }] },
        { label: 'B200', items: [{ label: 'NVLink 1.8 TB/s', kind: 'comm', at: 0.4 }] },
        { label: 'L40S', items: [{ label: 'PCIe Gen4 64 GB/s', kind: 'error', at: 0.6, note: 'bidirectional' }] },
      ],
      equation: 't_comm ≈ 2 · layers · all-reduce(bytes) / link BW',
      transition: 'Link widths shrink from B200 to L40S.', action: 'Compare TP4 on L40S with TP1 on B200 for 70B.',
    },
    {
      id: 'q12-s5', title: 'Cost per delivered token', objective: 'Convert throughput and price into $ per million tokens.', duration: 18,
      narration: 'Cost per million tokens is GPUs times price per hour, divided by tokens per hour. Use measured throughput at your latency SLO, not the upper bound. Rental prices here are editable assumptions, never quotes.',
      lanes: [
        { label: 'Inputs', items: [{ label: 'N GPUs × $/h', kind: 'request' }, { label: 'tok/s at SLO', kind: 'decode', at: 0.3 }] },
        { label: 'Result', items: [{ label: '$ / M tokens', kind: 'ok', at: 0.6 }] },
        { label: 'Check', items: [{ label: 'measure, don’t assume', kind: 'kv', at: 0.85 }] },
      ],
      equation: '$/M = N · price / (tok/s · 3600) · 10⁶',
      transition: 'Price and throughput combine into one bar per GPU.', action: 'Edit the H200 price and see when it beats H100.',
    },
  ],
  sim: {
    tldr: 'One deploy() function sizes each GPU group, bounds decode step time from bytes and FLOPs, and turns it into tok/s and $ per M tokens.',
    omits: [
      'Communication time for tensor parallelism (assumes perfect NVLink overlap; PCIe L40S is optimistic).',
      'Prefill work, scheduling and queueing: decode-only steady state.',
      'Real achieved bandwidth and kernel efficiency: MBU and MFU are assumptions you set.',
      'Availability, power, cooling and rack constraints. Prices are assumptions, not quotes.',
    ],
  },
  formula: {
    name: 'Decode step lower bound (model)',
    tex: String.raw`t_{step} \ge \max\!\left(\frac{W + KV}{N \cdot BW \cdot \text{MBU}},\ \frac{2 P B}{N \cdot F_{peak} \cdot \text{MFU}}\right),\quad \tfrac{tok}{s} \le \frac{B}{t_{step}}`,
    vars: [
      ['W, KV', 'weight and active KV bytes read per step', 'B'],
      ['N', 'GPUs in the tensor-parallel group', 'GPUs'],
      ['BW', 'vendor memory bandwidth per GPU', 'B/s'],
      ['P', 'parameters', 'params'],
      ['B', 'concurrent sequences (batch)', 'seqs'],
      ['F_peak', 'dense tensor FLOPS per GPU', 'FLOP/s'],
      ['MBU, MFU', 'achieved fraction of bandwidth / compute', '—'],
    ],
    assumptions: ['Decode only', 'Weights + KV read once per step', 'Perfect TP scaling', 'Dense (no sparsity) peaks'],
    substituted: '(140 GB) / (2 × 3.35 TB/s × 1.0) = 20.9 ms  → ≤ 48 tok/s per user on 2×H100',
    check: 'B ÷ (B/s) = s; FLOP ÷ (FLOP/s) = s ✓',
    cue: 'Decode moves bytes; prefill does math. Fit first, then bandwidth, then dollars.',
    isModel: true,
  },
  estimates: [
    { quantity: 'H100 SXM memory / bandwidth', value: '80 / 3.35', unit: 'GB / TB/s', assumptions: 'Board spec', source: 'nvidia.com H100 page, checked 2026-10-31', evidence: 'vendor spec' },
    { quantity: 'H200 SXM memory / bandwidth', value: '141 / 4.8', unit: 'GB / TB/s', assumptions: 'Board spec', source: 'nvidia.com H200 page, checked 2026-10-31', evidence: 'vendor spec' },
    { quantity: 'B200 memory / bandwidth per GPU', value: '180 / 8', unit: 'GB / TB/s', assumptions: 'DGX B200 1,440 GB / 64 TB/s ÷ 8', source: 'nvidia.com DGX B200 page, checked 2026-10-31', evidence: 'vendor spec' },
    { quantity: 'L40S memory / bandwidth', value: '48 / 0.864', unit: 'GB / TB/s', assumptions: 'GDDR6, PCIe', source: 'nvidia.com L40S page, checked 2026-10-31', evidence: 'vendor spec' },
    { quantity: 'H100 BF16 dense ridge point', value: '≈ 295', unit: 'FLOP/B', assumptions: '989.5 TFLOPS ÷ 3.35 TB/s', source: 'Vendor sparse spec ÷ 2', evidence: 'calculated' },
    { quantity: 'Rental price', value: '1–6', unit: '$/GPU-hour', assumptions: 'Editable placeholder', source: 'None — not a quote', evidence: 'assumed' },
  ],
  compare: {
    naive: 'Pick the GPU with the highest peak TFLOPS per dollar.',
    improved: 'Pick by fit, then bandwidth for decode and compute for prefill, then $ per delivered token at the SLO, measured on real traffic.',
    mechanism: 'Decode intensity (≈ batch FLOP per byte in BF16) sits far left of every ridge point (≈ 200–420 FLOP/B), so bandwidth, not FLOPS, sets speed.',
    rows: [
      ['Decode speed', 'Over-predicted from TFLOPS', 'Bounded by bandwidth'],
      ['GPU count', 'Ignores KV and headroom', 'Weights + KV + reserve, feasible TP'],
      ['Cost', '$ per peak TFLOP', '$ per delivered token at SLO'],
    ],
  },
  lab: {
    title: 'Roofline and cost calculator', kind: 'cpu', deps: 'Python 3.10+, no packages',
    commands: ['python3 gpu_choice.py'], lang: 'python',
    code: `GPUS = {  # vendor specs (decimal), dense TFLOPS; price = your assumption
  "H100": dict(gb=80,  tbs=3.35, bf16=989.5, price=2.5),
  "H200": dict(gb=141, tbs=4.8,  bf16=989.5, price=3.5),
  "B200": dict(gb=180, tbs=8.0,  bf16=2250,  price=5.5),
  "L40S": dict(gb=48,  tbs=0.864, bf16=362,  price=1.0),
}
P, wb, batch, kv_gb = 70e9, 2, 32, 40
need = P * wb + kv_gb * 1e9
for name, g in GPUS.items():
    n = 1
    while n * g["gb"] * 0.9e9 < need: n *= 2
    t = max(need / (n * g["tbs"] * 1e12), 2 * P * batch / (n * g["bf16"] * 1e12))
    tps = batch / t
    print(f"{name}: TP{n} step>={t*1e3:.1f} ms tok/s<={tps:,.0f}"
          f" $/M>={n * g['price'] / (tps * 3600) * 1e6:.2f}")`,
    checks: ['H100 ridge ≈ 295 FLOP/B', '70B BF16 batch 1 on 2×H100 ≥ 20.9 ms/step', 'tp is always a power of two'],
    gaps: 'Upper bounds only; ignores communication, prefill, scheduling and kernel efficiency.',
  },
  bench: {
    hypothesis: 'H200 TP2 sustains ≥ 30 % more concurrent requests than H100 TP2 at the same TTFT/ITL SLO for our 70B workload.',
    baseline: 'H100 SXM TP2, same engine, model, precision.',
    controlled: ['Engine version + flags', 'Model + precision', 'TP degree', 'Prompt/output length trace', 'Arrival process (open loop)', 'SLO thresholds'],
    workload: 'Replay of a production trace at increasing arrival rates until SLO violations exceed 1 %.',
    warmup: '5 min at low load per GPU type.', reps: '3 runs per arrival rate.',
    method: 'Client-side TTFT and ITL percentiles; server tok/s; nvidia-smi memory; cost = GPUs × assumed price.',
    metrics: ['max req/s at SLO', 'tok/s at SLO', 'p99 TTFT / ITL', '$ per M output tokens'],
    interpret: 'Choose the GPU with the lowest $ per M tokens at the SLO; check that the gap exceeds run-to-run spread.',
  },
  pitfalls: [
    'Comparing sparse vendor TFLOPS with dense ones: NVIDIA pages print 2:4-sparse peaks; dense is half.',
    'Comparing an 8-GPU system total with a single-GPU spec.',
    'Ignoring KV: a model that “fits” leaves no room for concurrency.',
    'Treating a historical rental price as a current quote.',
  ],
  optimizations: [
    ['Larger-memory GPUs (H200, B200) to avoid tensor parallelism', 'Fewer collectives and more KV; higher hourly price.'],
    ['FP8 weights on Hopper/Blackwell', 'Halves bytes per step; needs quality checks.'],
    ['Separate prefill and decode pools on different GPUs', 'Matches compute vs bandwidth needs; adds KV transfer and complexity.'],
  ],
  breaks: [
    'Bandwidth model fails when steps are dominated by launches, CPU scheduling or communication.',
    'L40S tensor parallelism over PCIe for large models: communication dominates.',
    'Capacity-constrained regions where the “best” GPU is unavailable.',
  ],
  interview: {
    short:
      'I decide in three passes. First, fit: weights plus the KV cache I need for target concurrency, plus runtime reserves, must fit in a feasible tensor-parallel group, which I round to a power of two. A 70B BF16 model is 140 GB of weights, so it needs two H100s, two H200s once KV is included, one B200, or four L40S. Second, the roofline: decode reads every weight and the active KV each step and does about two FLOPs per weight per sequence, so it sits far left of every ridge point and its speed is bounded by memory bandwidth. That makes H200 about 1.4 times faster per user than H100 at batch one with the same compute. Prefill and large batches move right, where compute matters and B200 wins. L40S has PCIe, not NVLink, so I avoid tensor parallelism across it. Third, cost: I compute dollars per million delivered tokens at my latency SLO from measured throughput, never from peak specs, and I treat rental prices as inputs I verify, not facts.',
    whiteboard: [
      'Table: memory, bandwidth, dense TFLOPS, interconnect per GPU (sources).',
      'Fit: weights + KV + reserve → GPUs → TP power of two.',
      'Roofline: ridge points; place decode b=1, b=128, prefill.',
      'Step time ≥ bytes / bandwidth → tok/s.',
      '$/M tokens = N · price / (tok/s · 3600) · 1e6 at the SLO.',
    ],
    followups: [
      ['When would you pick L40S?', 'Small models (≤ ~20B in FP8) that fit on one card, batch-heavy offline jobs, or where price and availability dominate and no tensor parallelism is needed.'],
      ['When does B200 compute matter?', 'Long prompts (prefill), large batches, and FP8/FP4 workloads that sit right of the ridge point.'],
      ['Why is H200 attractive for 70B?', 'Same compute as H100 but 1.76× memory and 1.43× bandwidth: more KV per GPU and faster memory-bound decode.'],
    ],
    debug: [
      'You moved from H100 to H200 and batch-1 latency improved only 10 %, not 43 %. Why?',
      'The step is not purely bandwidth-bound: launch overhead, CPU scheduling, sampling or TP communication take a fixed share. Profile the step; enable CUDA graphs; check achieved bandwidth.',
    ],
    calc: [
      '405B in FP8, 90 % usable memory. How many H200 for weights alone?',
      '405 GB / (141 × 0.9 = 126.9 GB) = 3.2 → 4 GPUs; with KV and headroom, TP8 is realistic.',
    ],
  },
  changeMind: [
    'Measured tok/s at SLO on each GPU for our trace.',
    'Real, current price and availability quotes.',
    'Workload mix: prefill-heavy (long prompts) vs decode-heavy (long outputs).',
  ],
  recall: [
    ['What bounds batch-1 decode speed?', 'Memory bandwidth ÷ bytes read per step.'],
    ['H100 BF16 ridge point?', '≈ 295 FLOP/B (dense).'],
    ['Interconnect of L40S?', 'PCIe Gen4 x16, no NVLink.'],
  ],
  glossary: [
    ['HBM', 'High-bandwidth memory stacked next to the GPU die.'],
    ['NVLink', 'NVIDIA GPU-to-GPU interconnect, much faster than PCIe.'],
    ['Roofline', 'Plot of attainable performance = min(peak compute, bandwidth × intensity).'],
    ['Ridge point', 'Arithmetic intensity where compute and bandwidth ceilings meet.'],
    ['MBU / MFU', 'Model bandwidth / FLOPS utilization: achieved fraction of peak.'],
  ],
  tags: ['hardware', 'gpu', 'bandwidth', 'roofline', 'cost'],
};

const q13: Lesson = {
  id: 13,
  group: 'gpu',
  short: 'Profiling bottlenecks',
  question: 'A model is running slower than expected. Use profiling to determine whether you’re compute-bound, memory-bandwidth-bound, or bottlenecked by kernel launches.',
  why: 'Optimizing the wrong resource wastes weeks; profiling turns “slow” into a named, provable bottleneck.',
  tldr: [
    'Compute three floors first: FLOPs ÷ peak, bytes ÷ bandwidth, launches × overhead. Compare them with measured time.',
    'Arithmetic intensity versus the ridge point picks the ceiling; gaps in the GPU timeline mean neither ceiling applies.',
    'Change one variable at a time (batch, CUDA graphs, dtype) and confirm time moves as predicted.',
  ],
  plain:
    'A step is slow for one of three reasons: too much math, too many bytes, or the GPU waiting on the CPU (launches, host syncs, communication). Profile to see where time goes, compare it with roofline floors, then prove the diagnosis by changing one thing.',
  analogy: {
    name: 'A restaurant kitchen',
    map: [
      ['Chef’s chopping speed', 'Tensor-core compute'],
      ['Trips to the pantry', 'HBM memory traffic'],
      ['Waiter handing in tickets one at a time', 'CPU kernel launches'],
      ['Chef waiting at the pass', 'Host sync / idle gap'],
      ['Ingredients shared with another kitchen', 'NCCL collectives'],
    ],
    breaks:
      'A kitchen rarely overlaps fetching and chopping perfectly; GPU kernels do overlap memory and compute, so the floor is max(compute, memory), not their sum.',
  },
  example: {
    title: '70B decode, batch 1, H100-class ceilings',
    inputs: 'FLOPs = 2 × 70e9 = 140 GFLOP; bytes ≈ 141 GB; 800 kernels × 5 µs; measured 55 ms',
    steps: [
      { label: 'Intensity', state: 'AI = 140 GFLOP / 141 GB ≈ 1 FLOP/B' },
      { label: 'Ridge', state: '989.5 TFLOPS / 3.35 TB/s ≈ 295 FLOP/B → far left → memory-bound' },
      { label: 'Floors', state: 'memory 141 / 3.35 = 42.1 ms\ncompute 140 / 989.5 = 0.14 ms\nlaunch 800 × 5 µs = 4.0 ms' },
      { label: 'Predicted vs measured', state: 'predicted ≈ 46.1 ms; measured 55 ms\n→ 8.9 ms unexplained: look for syncs / CPU gaps' },
    ],
    output: 'Memory-bandwidth-bound with ~9 ms of gaps worth investigating in the timeline.',
    predict: {
      q: 'Double the batch from 1 to 2. Roughly what happens to step time?',
      a: 'Almost nothing: bytes barely change (weights dominate) and FLOPs stay far below the compute floor. Tokens per second nearly doubles.',
    },
  },
  scenes: [
    {
      id: 'q13-s1', title: 'Three floors', objective: 'Compute expected time from FLOPs, bytes and launches.', duration: 18,
      narration: 'Before opening a profiler, compute three floors. Math time is FLOPs over peak. Memory time is bytes over bandwidth. Launch time is kernels times overhead. The slowest floor is your first suspect.',
      lanes: [
        { label: 'Compute', items: [{ label: '0.14 ms', kind: 'prefill', at: 0.2 }] },
        { label: 'Memory', items: [{ label: '42.1 ms', kind: 'kv', at: 0.4 }] },
        { label: 'Launch', items: [{ label: '4.0 ms', kind: 'request', at: 0.6 }] },
        { label: 'Measured', items: [{ label: '55 ms', kind: 'error', at: 0.85, note: '8.9 ms unexplained' }] },
      ],
      equation: 't ≥ max(FLOPs/peak, bytes/BW) + uncovered launches',
      transition: 'Three bars appear, then the measured bar exceeds them.', action: 'Enter your own numbers in the classifier.',
    },
    {
      id: 'q13-s2', title: 'Roofline placement', objective: 'Use intensity and ridge point to name the ceiling.', duration: 18,
      narration: 'Arithmetic intensity is FLOPs per byte. If it is left of the ridge point, bandwidth is the ceiling. Right of it, compute is. Decode at batch one sits near 1, prefill near 2,000, and the H100 ridge is about 295.',
      lanes: [
        { label: 'Decode', items: [{ label: 'AI ≈ 1', kind: 'decode', at: 0.2 }, { label: 'under slanted roof', kind: 'kv', at: 0.4 }] },
        { label: 'Ridge', items: [{ label: '≈ 295 FLOP/B', kind: 'neutral', at: 0.5 }] },
        { label: 'Prefill', items: [{ label: 'AI ≈ 1,900', kind: 'prefill', at: 0.7 }, { label: 'under flat roof', kind: 'prefill', at: 0.85 }] },
      ],
      equation: 'P ≤ min(P_peak, BW × AI)',
      transition: 'Workloads land under different parts of the roof.', action: 'Switch presets between Normal (prefill) and Stress (decode).',
    },
    {
      id: 'q13-s3', title: 'Reading the timeline', objective: 'Spot launch gaps, syncs and communication in a trace.', duration: 18,
      narration: 'Open the timeline. The CPU row shows launches. The GPU row shows kernels. If GPU kernels are shorter than launches, gaps appear between them. A host sync stalls the CPU until the GPU drains, then another gap follows.',
      lanes: [
        { label: 'CPU launch', items: [{ label: 'L1', kind: 'request', at: 0.1 }, { label: 'L2', kind: 'request', at: 0.2 }, { label: 'L3', kind: 'request', at: 0.3 }, { label: 'sync', kind: 'error', at: 0.6 }] },
        { label: 'GPU', items: [{ label: 'K1', kind: 'prefill', at: 0.15 }, { label: 'gap', kind: 'error', at: 0.22 }, { label: 'K2', kind: 'prefill', at: 0.25 }, { label: 'gap', kind: 'error', at: 0.32 }, { label: 'K3', kind: 'prefill', at: 0.35 }] },
        { label: 'NCCL', items: [{ label: 'all-reduce', kind: 'comm', at: 0.5 }] },
      ],
      equation: 'idle = span − kernel time − comm time',
      transition: 'Gaps appear between short kernels and after syncs.', action: 'Pick the Failure preset and read the trace idle %.',
    },
    {
      id: 'q13-s4', title: 'Prove it with one change', objective: 'Validate the diagnosis with a controlled experiment.', duration: 18,
      narration: 'A diagnosis needs a prediction. If you are launch-bound, CUDA graphs should cut step time by roughly the launch total. If memory-bound, FP8 weights should cut it by about half. If time does not move, the diagnosis was wrong.',
      lanes: [
        { label: 'Launch-bound?', items: [{ label: 'CUDA graphs', kind: 'request', at: 0.2 }, { label: '−launch ms', kind: 'ok', at: 0.4 }] },
        { label: 'Memory-bound?', items: [{ label: 'FP8 weights', kind: 'kv', at: 0.5 }, { label: '≈ −50 % bytes', kind: 'ok', at: 0.65 }] },
        { label: 'Compute-bound?', items: [{ label: 'better kernel / less math', kind: 'prefill', at: 0.8 }] },
      ],
      equation: 'Δt_predicted ≈ Δt_measured → diagnosis holds',
      transition: 'Each hypothesis gets an intervention and an expected change.', action: 'Lower launch overhead to 1 µs and see what the failure preset becomes.',
    },
    {
      id: 'q13-s5', title: 'Tools and traps', objective: 'Map tools to questions and avoid measurement errors.', duration: 18,
      narration: 'Use Nsight Systems or the PyTorch profiler for the timeline, Nsight Compute for per-kernel throughput. Warm up first, synchronize before timing, and use production shapes. Utilization percent only says a kernel was running, not how well.',
      lanes: [
        { label: 'Timeline', items: [{ label: 'nsys / torch.profiler', kind: 'request', at: 0.15 }] },
        { label: 'Per kernel', items: [{ label: 'ncu: SM %, DRAM %', kind: 'prefill', at: 0.35 }] },
        { label: 'Traps', items: [{ label: 'no warm-up', kind: 'error', at: 0.55 }, { label: 'no sync', kind: 'error', at: 0.7 }, { label: 'toy shapes', kind: 'error', at: 0.85 }] },
      ],
      equation: 'nvidia-smi util % = time a kernel ran, not efficiency',
      transition: 'Tools line up with questions; traps are struck out.', action: 'Read the lab commands below.',
    },
  ],
  sim: {
    tldr: 'classify() turns FLOPs, bytes, launches and measured time into a named bound; synthTrace() draws what that looks like on a CPU/GPU timeline.',
    omits: [
      'Caches (L2, shared memory) — only one HBM boundary is modelled.',
      'Overlap between streams and between communication and compute.',
      'PCIe, network and CPU preprocessing bottlenecks outside the step.',
      'The trace is synthetic and schematic, not a captured profile.',
    ],
  },
  formula: {
    name: 'Roofline bound',
    tex: String.raw`AI = \frac{\text{FLOPs}}{\text{bytes}},\quad P \le \min(P_{peak},\ BW \cdot AI),\quad t \gtrsim \max\!\left(\frac{\text{FLOPs}}{P_{peak}}, \frac{\text{bytes}}{BW}\right) + t_{uncovered}`,
    vars: [
      ['AI', 'arithmetic intensity at the HBM boundary', 'FLOP/B'],
      ['P', 'achieved performance', 'FLOP/s'],
      ['P_peak', 'peak compute for the dtype', 'FLOP/s'],
      ['BW', 'peak memory bandwidth', 'B/s'],
      ['t_uncovered', 'launch, sync and comms not hidden by overlap', 's'],
    ],
    assumptions: ['One memory level (HBM)', 'Dense peak for the dtype in use', 'Perfect overlap inside kernels'],
    substituted: 'AI = 140 GFLOP / 141 GB ≈ 1 → P ≤ 3.35 TB/s × 1 = 3.35 TFLOPS ≪ 989.5 → memory floor 42.1 ms',
    check: 'FLOP ÷ (FLOP/s) = s; B ÷ (B/s) = s ✓',
    cue: 'Left of the ridge: bytes. Right: math. Gaps: neither — look at the CPU.',
  },
  estimates: [
    { quantity: 'H100 BF16 ridge point', value: '≈ 295', unit: 'FLOP/B', assumptions: 'Dense 989.5 TFLOPS / 3.35 TB/s', source: 'NVIDIA H100 page', evidence: 'calculated' },
    { quantity: 'Decode intensity, batch 1, BF16', value: '≈ 1', unit: 'FLOP/B', assumptions: '2 FLOP per 2-byte weight', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Prefill intensity, 2,048 tokens', value: '≈ 1,900', unit: 'FLOP/B', assumptions: '2·P·T / ~150 GB', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Kernel launch overhead', value: '2–10', unit: 'µs', assumptions: 'Python + driver path, no CUDA graphs', source: 'Teaching assumption — measure it', evidence: 'assumed' },
    { quantity: 'Your step breakdown', value: 'not measured', unit: 'ms', assumptions: 'Needs a profile', source: 'Lab below', evidence: 'not measured' },
  ],
  compare: {
    naive: 'See low tokens/s, buy faster GPUs or rewrite kernels at random.',
    improved: 'Compute floors, profile with warm-up and syncs, name the bound, change one variable, confirm the predicted Δ.',
    mechanism: 'The roofline gives an expected time; the trace shows where measured time exceeds it.',
    rows: [
      ['Time to diagnosis', 'Weeks of guessing', 'Hours with a profile'],
      ['Fix chosen', 'Often wrong resource', 'Targets the binding resource'],
      ['Evidence', 'Anecdotes', 'Before/after with predicted Δ'],
    ],
  },
  lab: {
    title: 'Profile a decode step', kind: 'gpu', deps: 'CUDA GPU, PyTorch ≥ 2.1, Nsight Systems / Compute (optional)',
    commands: [
      'python3 profile_step.py            # torch.profiler table + trace.json',
      'nsys profile -t cuda,nvtx,osrt -o step python3 profile_step.py',
      'ncu --set full -k regex:gemm -c 5 python3 profile_step.py',
    ], lang: 'python',
    code: `import torch
from torch.profiler import profile, ProfilerActivity
step = lambda: model(input_ids)          # your decode step
for _ in range(20): step()               # warm-up: compile, autotune, allocator
torch.cuda.synchronize()
start, end = torch.cuda.Event(True), torch.cuda.Event(True)
start.record(); [step() for _ in range(50)]; end.record()
torch.cuda.synchronize()
print("ms/step", start.elapsed_time(end) / 50)
with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as p:
    for _ in range(5): step()
    torch.cuda.synchronize()
print(p.key_averages().table(sort_by="cuda_time_total", row_limit=15))
p.export_chrome_trace("trace.json")      # open in Perfetto / chrome://tracing`,
    checks: ['ms/step stable across 3 runs (< 3 % spread)', 'Sum of CUDA kernel time vs wall time → idle share', 'Top kernels: compare DRAM throughput % (ncu) with the bound'],
    gaps: 'Requires a GPU; results here are not measured. Real shapes and engine settings must match production.',
  },
  bench: {
    hypothesis: 'Decode step time at batch ≤ 32 is bandwidth-bound: it stays within 15 % of bytes ÷ achieved bandwidth and barely grows with batch.',
    baseline: 'Batch 1, eager mode, BF16.',
    controlled: ['GPU + clocks', 'Driver/CUDA', 'Model + dtype', 'Sequence length', 'Engine flags'],
    workload: 'Decode steps at batch 1, 2, 4, 8, 16, 32 with fixed context length; with and without CUDA graphs.',
    warmup: '20 steps per configuration.', reps: '50 timed steps × 3 runs.',
    method: 'CUDA events around steps; nsys timeline for gaps; ncu DRAM throughput for top kernels.',
    metrics: ['ms/step', 'achieved TB/s', 'GPU idle %', 'kernel count per step'],
    interpret: 'Flat step time vs batch confirms memory-bound; a large drop with CUDA graphs confirms launch-bound.',
  },
  pitfalls: [
    'Reading GPU utilization % as efficiency: it counts time a kernel runs, not SM or bandwidth usage.',
    'Timing without synchronize or CUDA events: asynchronous launches make CPU timers lie.',
    'Profiling the first iterations: compilation, autotuning and allocator growth dominate.',
    'Profiling toy shapes that behave nothing like production batch and sequence lengths.',
  ],
  optimizations: [
    ['CUDA graphs', 'Removes per-kernel launch cost; needs static shapes and extra memory for graph pools.'],
    ['Kernel fusion', 'Fewer launches and HBM round-trips; more custom code to maintain.'],
    ['Larger batch / FP8 weights', 'Moves decode right on the roofline or reduces bytes; raises latency or needs quality checks.'],
  ],
  breaks: [
    'Multi-GPU steps where NCCL or PCIe dominates: neither roofline ceiling applies.',
    'Heavy cache reuse (L2/SMEM) makes a one-level HBM roofline misleading.',
    'Overlapping streams make per-kernel attribution of time ambiguous.',
  ],
  interview: {
    short:
      'I start with arithmetic before tools. For the slow step I estimate FLOPs, bytes moved through HBM and the number of kernel launches, then compute three floors: FLOPs over peak compute, bytes over peak bandwidth, and launches times per-launch overhead. Intensity, FLOPs per byte, compared with the GPU’s ridge point, tells me which roof applies: batch-one decode is around one FLOP per byte, far below the H100’s roughly 295, so it should be memory-bound. Then I measure properly: warm up, synchronize, use CUDA events and production shapes. In an Nsight Systems or PyTorch profiler timeline I look for gaps between kernels, host syncs and NCCL time. If measured time is close to the memory floor, I am bandwidth-bound; if kernel time is small but wall time is large with gaps, I am launch- or CPU-bound; if kernels sit near peak SM throughput in Nsight Compute, compute-bound. Finally I prove it with one change, like CUDA graphs or FP8 weights, and check that the time moves by the predicted amount. GPU utilization percent alone proves nothing.',
    whiteboard: [
      'Write AI = FLOPs/bytes and the roofline min().',
      'Compute the three floors for a concrete step.',
      'Sketch a trace: CPU launches, GPU kernels, gaps, NCCL.',
      'Map tools: nsys timeline, ncu per-kernel, torch.profiler.',
      'Name the experiment and the expected Δ.',
    ],
    followups: [
      ['nvidia-smi shows 95 % utilization. Are we compute-bound?', 'Not necessarily: utilization is the fraction of time any kernel runs. A memory-bound kernel at 30 % of SM throughput still shows 95 %.'],
      ['How do CUDA graphs help?', 'They replay a captured sequence of kernels with one launch, removing per-kernel CPU and driver overhead.'],
      ['Why time with CUDA events?', 'Kernel launches are asynchronous; events record on the GPU stream, so they measure GPU execution, not launch time.'],
    ],
    debug: [
      'A 1B model decodes at 6 ms/step on an H100, though bytes/bandwidth predicts 0.7 ms. What is going on?',
      '400 launches × 8 µs = 3.2 ms of launch overhead plus syncs: the step is launch-bound. CUDA graphs or fused kernels should cut it toward ~1 ms.',
    ],
    calc: [
      'A kernel does 50 GFLOP and moves 2 GB on an H100 (BF16 989.5 TFLOPS, 3.35 TB/s). Which bound and floor?',
      'AI = 25 FLOP/B < 295 → memory-bound; floor = 2 / 3.35 = 0.60 ms (compute floor 0.05 ms).',
    ],
  },
  changeMind: [
    'A profile showing large gaps despite a memory-bound prediction.',
    'ncu showing DRAM throughput far below peak (kernel inefficiency, not hardware limit).',
    'Multi-GPU steps where NCCL time exceeds kernel time.',
  ],
  recall: [
    ['Three floors?', 'FLOPs/peak, bytes/bandwidth, launches × overhead.'],
    ['What does GPU util % measure?', 'Fraction of time a kernel was running.'],
    ['Why warm up before timing?', 'Compilation, autotuning and allocator growth distort early iterations.'],
  ],
  glossary: [
    ['Arithmetic intensity (AI)', 'FLOPs performed per byte moved across a memory boundary.'],
    ['Kernel launch', 'CPU-side submission of a GPU function; costs microseconds each.'],
    ['CUDA graph', 'A captured sequence of kernels replayed with one launch.'],
    ['NCCL', 'NVIDIA Collective Communications Library (all-reduce, all-gather).'],
    ['Nsight Systems / Compute', 'NVIDIA timeline profiler / per-kernel profiler.'],
  ],
  tags: ['profiling', 'roofline', 'performance', 'kernels', 'cuda graphs'],
};

const q14: Lesson = {
  id: 14,
  group: 'gpu',
  short: 'Low GPU utilization',
  question: 'Your GPUs are sitting at 30% utilization despite heavy traffic. Debug the entire serving pipeline instead of immediately adding more GPUs.',
  why: 'Adding GPUs behind a CPU, scheduler or admission bottleneck multiplies cost without adding throughput.',
  tldr: [
    'Throughput equals the slowest stage; heavy traffic at the gateway does not mean heavy work reaches the GPU.',
    'Check capacity and queue depth at every stage: gateway, tokenizer, scheduler, GPU batch, detokenize, flush.',
    'Every hypothesis needs evidence, a controlled experiment and an expected metric change before you add GPUs.',
  ],
  plain:
    'GPUs sit idle when work does not reach them: requests stuck upstream, the CPU stalling between steps, or batches capped by admission or KV limits. Find the stage where the queue grows; the stage just after it is the bottleneck. More GPUs behind that bottleneck only add cost.',
  analogy: {
    name: 'A factory assembly line',
    map: [
      ['Loading dock', 'API gateway'],
      ['Label printer', 'Tokenizer'],
      ['Floor manager', 'Scheduler / admission control'],
      ['Main machine', 'GPU decode batch'],
      ['Packing and shipping door', 'Detokenizer and SSE flush'],
    ],
    breaks:
      'An idle factory machine is obvious; nvidia-smi “utilization” counts any running kernel, so 30 % can hide a GPU that is busy but doing little useful work, or the reverse.',
  },
  example: {
    title: 'Tokenizer starves four GPUs',
    inputs: '60 req/s offered, 256 output tokens, 4 replicas, tokenizer saturated at 15 req/s',
    steps: [
      { label: 'Gateway', state: 'passes 60 req/s (cap 500)' },
      { label: 'Tokenizer', state: 'passes 15 req/s (cap 15) → queue grows 45 req/s' },
      { label: 'GPU', state: '15 / 4 = 3.75 req/s per replica × 256 tok = 960 tok/s\nbatch ≈ 32 of 256 possible' },
      { label: 'Useful work', state: '15 req/s ÷ 44.9 req/s healthy capacity = 33 %' },
    ],
    output: 'GPUs look “30 % utilized” because they only receive 15 req/s. The fix is CPU-side, not more GPUs.',
    predict: {
      q: 'You double to 8 GPUs. What happens to delivered requests per second?',
      a: 'Nothing: still 15 req/s. The tokenizer is the bottleneck; cost doubles.',
    },
  },
  scenes: [
    {
      id: 'q14-s1', title: 'The pipeline', objective: 'Lay out every stage a request crosses.', duration: 18,
      narration: 'A request crosses six stages: gateway, tokenizer, scheduler, GPU, detokenizer and the response flush. Each stage has its own capacity. The slowest one sets the throughput of the whole system.',
      lanes: [
        { label: 'Stages', items: [{ label: 'Gateway', kind: 'request', at: 0.1 }, { label: 'Tokenizer', kind: 'request', at: 0.2 }, { label: 'Scheduler', kind: 'request', at: 0.3 }, { label: 'GPU', kind: 'decode', at: 0.4 }, { label: 'Detok', kind: 'request', at: 0.5 }, { label: 'Flush', kind: 'comm', at: 0.6 }] },
        { label: 'Throughput', items: [{ label: 'X = min(capacities)', kind: 'neutral', at: 0.85 }] },
      ],
      equation: 'X = min(λ, c₁, …, c₆)',
      transition: 'Stages appear left to right.', action: 'Look at the capacity chart in the simulator.',
    },
    {
      id: 'q14-s2', title: 'Where the queue builds', objective: 'Locate the bottleneck from queue growth.', duration: 18,
      narration: 'Inject a tokenizer saturated by long prompts. Sixty requests per second arrive, fifteen get through. The queue in front of the tokenizer grows by forty-five per second, while the GPU queue stays empty.',
      lanes: [
        { label: 'Before tokenizer', items: [{ label: 'q +45/s', kind: 'error', at: 0.3 }, { label: '+90', kind: 'error', at: 0.5 }, { label: '+135', kind: 'error', at: 0.7 }] },
        { label: 'Tokenizer', items: [{ label: '15 req/s', kind: 'request', at: 0.2 }] },
        { label: 'GPU queue', items: [{ label: 'empty', kind: 'ok', at: 0.6 }] },
      ],
      equation: 'dQ/dt = λ − c = 60 − 15 = 45 req/s',
      transition: 'Upstream queue grows; GPU queue stays empty.', action: 'Pick the Failure preset.',
    },
    {
      id: 'q14-s3', title: 'Small batches, idle steps', objective: 'Connect starvation to small batches and low useful work.', duration: 18,
      narration: 'With only fifteen requests per second, each replica runs a batch of about thirty sequences instead of two hundred fifty six. Steps still run, so utilization looks non-zero, but useful work is a third of capacity. Host syncs between steps add visible gaps.',
      lanes: [
        { label: 'Replica batch', items: [{ label: '≈ 32 seqs', kind: 'decode', at: 0.2 }, { label: 'max 256', kind: 'neutral', at: 0.35 }] },
        { label: 'Step', items: [{ label: 'kernel', kind: 'prefill', at: 0.45 }, { label: 'sync gap 15 ms', kind: 'error', at: 0.6 }, { label: 'kernel', kind: 'prefill', at: 0.75 }] },
        { label: 'Useful work', items: [{ label: '≈ 33 %', kind: 'error', at: 0.9 }] },
      ],
      equation: 'useful work = delivered tok/s ÷ healthy max tok/s',
      transition: 'Batch shrinks and gaps open between steps.', action: 'Compare GPU duty and useful work in the stats.',
    },
    {
      id: 'q14-s4', title: 'Hypothesis, evidence, experiment', objective: 'Test each suspect with a controlled change.', duration: 18,
      narration: 'For each suspect write the evidence you expect, an experiment that changes one thing, and the metric that should move. Tokenizer: CPU pinned on one core; move it to a worker pool. Admission cap: running sequences flat at the limit; raise it.',
      lanes: [
        { label: 'Tokenizer', items: [{ label: 'CPU 100 % one core', kind: 'request', at: 0.15 }, { label: 'process pool', kind: 'ok', at: 0.3 }] },
        { label: 'Event loop', items: [{ label: 'loop lag spikes', kind: 'request', at: 0.4 }, { label: 'offload blocking call', kind: 'ok', at: 0.55 }] },
        { label: 'Admission', items: [{ label: 'running = cap, KV free', kind: 'request', at: 0.7 }, { label: 'raise max seqs', kind: 'ok', at: 0.85 }] },
      ],
      equation: 'accept a cause only if Δmetric matches prediction',
      transition: 'Each hypothesis gets evidence and an experiment.', action: 'Read the hypothesis table.',
    },
    {
      id: 'q14-s5', title: 'Then, maybe, more GPUs', objective: 'Know when adding GPUs is actually correct.', duration: 18,
      narration: 'Once upstream stages keep up, the GPU becomes the bottleneck. Its batch is near the maximum, queues build in front of it, and useful work is high. Only then does adding replicas raise throughput.',
      lanes: [
        { label: 'Fixed pipeline', items: [{ label: 'tokenizer 120/s', kind: 'ok', at: 0.2 }, { label: 'GPU queue builds', kind: 'kv', at: 0.45 }] },
        { label: 'Decision', items: [{ label: 'batch ≈ max', kind: 'decode', at: 0.6 }, { label: 'add replicas', kind: 'ok', at: 0.8 }] },
      ],
      equation: 'add GPUs only if GPU is min(capacities)',
      transition: 'Bottleneck moves to the GPU; adding replicas helps.', action: 'Pick Stress and add replicas until backlog reaches 0.',
    },
  ],
  sim: {
    tldr: 'pipeline() pushes the offered load through six capacity-limited stages; faults change capacities, batch limits and step gaps, so you can see utilization and useful work diverge.',
    omits: [
      'Burstiness and queueing delay (fluid steady-state model, no p99).',
      'Prefill work: GPU capacity is decode-only.',
      'Capacities are illustrative assumptions, not measurements.',
      'Cross-effects such as retries and client timeouts.',
    ],
  },
  formula: {
    name: 'Bottleneck and queue growth (model)',
    tex: String.raw`X = \min(\lambda, c_1, \dots, c_n),\qquad \frac{dQ_k}{dt} = \max(0,\ \lambda_k - c_k),\qquad L = \lambda W`,
    vars: [
      ['X', 'delivered throughput', 'req/s'],
      ['λ, λ_k', 'offered load, load arriving at stage k', 'req/s'],
      ['c_k', 'capacity of stage k', 'req/s'],
      ['Q_k', 'queue in front of stage k', 'requests'],
      ['L, W', 'in-flight requests, mean time in system (Little’s law)', 'req, s'],
    ],
    assumptions: ['Steady state', 'Each request visits every stage once', 'Capacities fixed during the window'],
    substituted: 'X = min(60, 500, 15, 400, 44.9, 300, 300) = 15 req/s;  dQ_tok/dt = 60 − 15 = 45 req/s',
    check: 'req/s compared with req/s; queue growth in req/s × s = requests ✓',
    cue: 'Find the growing queue; the stage after it is the bottleneck.',
    isModel: true,
  },
  estimates: [
    { quantity: 'Healthy replica capacity', value: '11.2', unit: 'req/s', assumptions: '25 ms + 0.25 ms/seq step, batch 256, 256 tokens', source: 'Simulator step model', evidence: 'simulated' },
    { quantity: 'Saturated tokenizer', value: '15', unit: 'req/s', assumptions: 'Long prompts, one core', source: 'Illustrative input', evidence: 'assumed' },
    { quantity: 'Useful work in failure case', value: '≈ 33', unit: '%', assumptions: '15 / 44.9 req/s', source: 'Simulator', evidence: 'simulated' },
    { quantity: 'Your stage capacities', value: 'not measured', unit: 'req/s', assumptions: 'Per-stage spans needed', source: 'Lab protocol', evidence: 'not measured' },
  ],
  compare: {
    naive: 'GPUs at 30 % with heavy traffic → buy more GPUs or raise batch size blindly.',
    improved: 'Measure per-stage capacity and queue depth, inject or remove one fault at a time, fix the binding stage, then scale.',
    mechanism: 'Throughput is the minimum stage capacity; fixing the minimum raises everything downstream.',
    rows: [
      ['Delivered req/s', 'Unchanged after adding GPUs', 'Rises when the bottleneck is fixed'],
      ['Cost', 'Up', 'Flat or down'],
      ['Evidence', 'nvidia-smi only', 'Per-stage spans, queue depth, loop lag'],
    ],
  },
  lab: {
    title: 'Pipeline triage checklist', kind: 'protocol', deps: 'Access to API servers, engine metrics endpoint, nvidia-smi, py-spy',
    commands: [
      'nvidia-smi dmon -s um -d 1                 # util % and memory per second',
      'curl -s localhost:8000/metrics | grep -E "num_requests_(running|waiting)|kv_cache_usage|preempt"',
      'py-spy dump --pid $(pgrep -f api_server)    # what is the event loop doing?',
      'py-spy top --pid $(pgrep -f tokenizer)      # tokenizer CPU hot spots',
    ], lang: 'text',
    code: `For each stage record per minute:
  arrivals/s, completions/s, queue depth, p99 time in stage
Bottleneck = first stage whose queue grows while the next is idle.

Checks, in order:
1. running seqs == max-num-seqs while waiting > 0 and KV < 90 %?  -> admission cap
2. KV usage ~100 %, preemptions > 0?                              -> KV exhaustion
3. API CPU 100 % on one core, tokenize p99 >> queue p99?          -> tokenizer
4. event-loop lag > 10 ms?                                        -> blocked loop
5. per-replica queue skew > 2x?                                   -> routing imbalance
6. nsys: gaps between decode steps, cudaStreamSynchronize?        -> oversync`,
    checks: ['Queue growth located at exactly one stage', 'After the fix, delivered req/s rises by the predicted amount', 'GPU batch size rises toward the cap'],
    gaps: 'Metric names vary by engine; adapt grep patterns. No production data is measured here.',
  },
  bench: {
    hypothesis: 'Moving tokenization to a 4-process pool raises delivered req/s from 15 to ≥ 40 on the same trace.',
    baseline: 'Current single-threaded tokenizer, same replicas.',
    controlled: ['Arrival trace (replayed)', 'Engine flags', 'Replica count', 'Prompt length distribution'],
    workload: 'Replay of a 30-minute production trace at 60 req/s.',
    warmup: '5 min.', reps: '3 replays per configuration.',
    method: 'Per-stage spans from tracing; engine metrics; nvidia-smi dmon.',
    metrics: ['delivered req/s', 'queue depth per stage', 'GPU batch size', 'TTFT p99'],
    interpret: 'Accept the diagnosis only if the queue moves from the tokenizer to the GPU and delivered req/s rises as predicted.',
  },
  pitfalls: [
    'Treating nvidia-smi utilization as useful work: it is kernel duty cycle, not SM or bandwidth use.',
    'Measuring only GPU metrics; the bottleneck is often in Python on the CPU.',
    'Raising batch caps until KV exhausts, causing preemption thrash.',
    'Changing several settings at once, so no change can be attributed.',
  ],
  optimizations: [
    ['Tokenize in a separate process pool or with a native tokenizer', 'More CPU and memory; another failure domain.'],
    ['Raise admission cap with KV-aware limits', 'Higher throughput; higher inter-token latency.'],
    ['Load-aware routing (least outstanding tokens)', 'Even replicas; needs fresh load signals.'],
  ],
  breaks: [
    'When the GPU truly is the bottleneck (batch at max, queue in front of GPU): then adding capacity is right.',
    'Bursty traffic: average capacities look fine while short bursts overflow queues.',
  ],
  interview: {
    short:
      'Thirty percent utilization under heavy traffic says work is not reaching the GPU, so I debug the pipeline before buying hardware. Throughput equals the minimum capacity across stages: gateway, tokenizer, scheduler and admission, the GPU batch, detokenization and the response flush. I instrument each stage with arrivals, completions, queue depth and time in stage, and find where the queue grows; the stage after it is the bottleneck. Typical suspects: a tokenizer pinned on one CPU core by long prompts, a blocked async event loop, an admission cap like max-num-seqs set too low, KV cache exhaustion causing preemptions, load imbalance across replicas, and host synchronizations between decode steps. For each I write the evidence, a controlled experiment that changes one thing, and the metric I expect to move. I also distinguish nvidia-smi utilization, which only says a kernel was running, from useful work like tokens per second relative to capacity. Only when the GPU batch is near its maximum and the queue sits in front of the GPU do I add replicas.',
    whiteboard: [
      'Draw the six stages with capacities.',
      'X = min(capacities); mark the growing queue.',
      'List suspects with evidence and experiment.',
      'Distinguish duty cycle vs useful work.',
      'Decision rule for adding GPUs.',
    ],
    followups: [
      ['How do you detect a blocked event loop?', 'Measure loop lag (scheduled vs actual callback time); py-spy dump shows the blocking call.'],
      ['Why can batch caps hurt latency?', 'Larger batches lengthen each decode step, raising inter-token latency for everyone.'],
      ['What is useful work for an LLM server?', 'Delivered output tokens per second (at SLO) relative to measured maximum at that model and GPU.'],
    ],
    debug: [
      'Running sequences stay flat at 16 while 200 requests wait and KV usage is 20 %. Diagnosis?',
      'Admission cap (max concurrent sequences) is the bottleneck, not memory. Raise it in steps while watching ITL and KV.',
    ],
    calc: [
      'Each replica serves 11.2 req/s at max batch. Tokenizer passes 15 req/s. How many replicas are useful?',
      '15 / 11.2 = 1.34 → 2 replicas; the other two are idle cost until the tokenizer is fixed.',
    ],
  },
  changeMind: [
    'Per-stage metrics showing the queue in front of the GPU (then scale GPUs).',
    'Traffic bursts that exceed capacity only briefly (then add queueing / admission, not capacity).',
  ],
  recall: [
    ['Throughput of a pipeline?', 'The minimum stage capacity.'],
    ['How do you find the bottleneck?', 'Where the queue grows; the stage after it.'],
    ['What does nvidia-smi utilization measure?', 'Fraction of time any kernel runs.'],
  ],
  glossary: [
    ['Admission control', 'Deciding which requests enter the running batch.'],
    ['Event loop', 'Single-threaded async scheduler (e.g. asyncio); blocking calls stall all requests.'],
    ['Duty cycle', 'Fraction of time a resource is busy, regardless of how efficiently.'],
    ['Preemption', 'Evicting a running sequence (e.g. when KV runs out) and recomputing later.'],
  ],
  tags: ['utilization', 'debugging', 'pipeline', 'bottleneck', 'scheduler'],
};

const q15: Lesson = {
  id: 15,
  group: 'gpu',
  short: 'Fused RMSNorm kernel',
  question: 'Implement a fused RMSNorm kernel in CUDA or Triton. Benchmark it against PyTorch and explain where the speedup comes from.',
  why: 'Tests whether you can write a correct GPU kernel and explain performance with bytes moved, not folklore.',
  tldr: [
    'y = x · rsqrt(mean(x²) + ε) · w: one reduction per row and no mean subtraction, unlike LayerNorm.',
    'Eager PyTorch launches ~6 kernels and moves ~7 full tensors through HBM; a fused kernel reads x once, writes y once.',
    'Speedup comes from bytes (≤ 3.5×) and fewer launches; an already-fused baseline such as torch.compile may tie or win.',
  ],
  plain:
    'RMSNorm does little math per byte, so it is memory-bound. Running it as separate PyTorch ops writes intermediates to HBM and reads them back. A fused kernel keeps each row in registers, so it moves only x, w and y.',
  analogy: {
    name: 'Doing laundry',
    map: [
      ['Carrying the basket to the machine and back', 'Reading and writing a tensor in HBM'],
      ['Wash, rinse and dry as separate trips', 'Separate kernels with intermediate tensors'],
      ['One machine running all cycles', 'One fused kernel'],
      ['Folding table next to the machine', 'Registers / shared memory'],
    ],
    breaks:
      'A bigger basket never spills; a very wide row can exceed registers, spill to slower local memory and erase the fusion win.',
  },
  example: {
    title: 'x = [1, 2, 3, 4], w = 1, ε = 1e-6',
    inputs: 'One row, hidden size 4',
    steps: [
      { label: 'Square', state: 'x² = [1, 4, 9, 16]' },
      { label: 'Row mean', state: 'mean = 30 / 4 = 7.5' },
      { label: '+ ε, rsqrt', state: 'rsqrt(7.500001) = 0.365148' },
      { label: 'Scale', state: 'y = x · 0.365148 · w = [0.3651, 0.7303, 1.0954, 1.4606]' },
      { label: 'LayerNorm, for contrast', state: 'mean 2.5, var 1.25 → [−1.3416, −0.4472, 0.4472, 1.3416]' },
    ],
    output: 'RMSNorm rescales without centering; LayerNorm centers then rescales.',
    predict: {
      q: 'Does RMSNorm output for [1, 2, 3, 4] have zero mean?',
      a: 'No. The sum is ≈ 3.65. Only LayerNorm subtracts the mean.',
    },
  },
  scenes: [
    {
      id: 'q15-s1', title: 'The math on one row', objective: 'Compute RMSNorm step by step.', duration: 18,
      narration: 'Take one row x equals one, two, three, four. Square each element, average them to get 7.5, add a tiny epsilon, and take the reciprocal square root. Multiply every element by that and by the learned weight.',
      lanes: [
        { label: 'x', items: [{ label: '[1, 2, 3, 4]', kind: 'request' }] },
        { label: 'Reduce', items: [{ label: 'x² = [1, 4, 9, 16]', kind: 'prefill', at: 0.25 }, { label: 'mean 7.5', kind: 'prefill', at: 0.45 }, { label: 'rsqrt → 0.3651', kind: 'prefill', at: 0.6 }] },
        { label: 'y', items: [{ label: '[0.365, 0.730, 1.095, 1.461]', kind: 'decode', at: 0.85 }] },
      ],
      equation: 'y_i = x_i · rsqrt(mean(x²) + ε) · w_i',
      transition: 'Row is squared, reduced, then rescaled.', action: 'Move x4 in the simulator and watch y change.',
    },
    {
      id: 'q15-s2', title: 'Eager: six kernels', objective: 'Count HBM traffic for the PyTorch expression.', duration: 18,
      narration: 'The eager expression runs pow, mean, add, rsqrt and two multiplies as separate kernels. Each writes its result to HBM and the next reads it back. Full-size tensors cross HBM about seven times.',
      lanes: [
        { label: 'Kernels', items: [{ label: 'pow', kind: 'prefill', at: 0.1 }, { label: 'mean', kind: 'prefill', at: 0.2 }, { label: 'add', kind: 'prefill', at: 0.3 }, { label: 'rsqrt', kind: 'prefill', at: 0.4 }, { label: 'mul', kind: 'prefill', at: 0.5 }, { label: 'mul', kind: 'prefill', at: 0.6 }] },
        { label: 'HBM', items: [{ label: 'R x', kind: 'kv', at: 0.12 }, { label: 'W x²', kind: 'kv', at: 0.15 }, { label: 'R x²', kind: 'kv', at: 0.22 }, { label: 'R x', kind: 'kv', at: 0.52 }, { label: 'W y₁', kind: 'kv', at: 0.55 }, { label: 'R y₁', kind: 'kv', at: 0.62 }, { label: 'W y', kind: 'kv', at: 0.66 }] },
      ],
      equation: 'bytes_eager ≈ 7 · R · H · b',
      transition: 'Each kernel adds HBM round-trips.', action: 'Note the eager bytes in the stats.',
    },
    {
      id: 'q15-s3', title: 'Fused: one pass', objective: 'Show the fused kernel’s single read and write.', duration: 18,
      narration: 'A fused Triton kernel gives each program one row. It loads x into registers, reduces x squared in FP32, computes the scale, multiplies by w and stores y. Intermediates never leave the chip. HBM sees x once and y once.',
      lanes: [
        { label: 'Program per row', items: [{ label: 'load x', kind: 'kv', at: 0.15 }, { label: 'Σx² (FP32)', kind: 'prefill', at: 0.35 }, { label: 'rsqrt', kind: 'prefill', at: 0.5 }, { label: '× w', kind: 'prefill', at: 0.65 }, { label: 'store y', kind: 'kv', at: 0.8 }] },
        { label: 'Removed', items: [{ label: 'x² tensor', kind: 'error', at: 0.3, out: 0.6 }, { label: 'y₁ tensor', kind: 'error', at: 0.4, out: 0.7 }] },
      ],
      equation: 'bytes_fused ≈ 2 · R · H · b + H · b',
      transition: 'Intermediate tensors disappear.', action: 'Compare the traffic bars.',
    },
    {
      id: 'q15-s4', title: 'Where the speedup comes from', objective: 'Bound the speedup from bytes and launches.', duration: 18,
      narration: 'For large tensors time is bytes over bandwidth, so the bound is seven over two, 3.5 times. For tiny tensors the six launches dominate, so fusion can approach six times. Real kernels land below these bounds.',
      lanes: [
        { label: 'Large R·H', items: [{ label: 'bytes-bound', kind: 'kv', at: 0.2 }, { label: '≤ 3.5×', kind: 'ok', at: 0.4 }] },
        { label: 'Small R·H', items: [{ label: 'launch-bound', kind: 'request', at: 0.55 }, { label: '≤ 6×', kind: 'ok', at: 0.7 }] },
        { label: 'Measured', items: [{ label: 'not measured', kind: 'error', at: 0.9 }] },
      ],
      equation: 'speedup ≤ (bytes_e/BW + 6·t_launch) / (bytes_f/BW + t_launch)',
      transition: 'Two regimes with two bounds.', action: 'Change rows from 1 to 65,536 and watch the curve.',
    },
    {
      id: 'q15-s5', title: 'When the baseline wins', objective: 'Know when fusion gives nothing.', duration: 18,
      narration: 'torch.compile and vendor libraries already fuse RMSNorm. Against those, your kernel moves the same bytes and should only tie. Very wide rows can spill registers. Validate correctness across dtypes and odd sizes before trusting any speedup.',
      lanes: [
        { label: 'Baselines', items: [{ label: 'eager: 6 kernels', kind: 'neutral', at: 0.15 }, { label: 'compiled: 1 kernel', kind: 'decode', at: 0.35 }] },
        { label: 'Risks', items: [{ label: 'register spill', kind: 'error', at: 0.55 }, { label: 'masking bugs', kind: 'error', at: 0.7 }, { label: 'dtype tolerance', kind: 'error', at: 0.85 }] },
      ],
      equation: 'vs fused baseline: speedup ≈ 1×',
      transition: 'The speedup vanishes against an already-fused baseline.', action: 'Pick the Failure preset.',
    },
  ],
  sim: {
    tldr: 'normTraffic() counts HBM bytes and launches for the eager expression, an already-fused baseline and your fused kernel; the curve and bars share it.',
    omits: [
      'Caching of x between eager kernels in L2 (makes eager faster than modelled for small tensors).',
      'Register pressure and occupancy effects for very wide rows.',
      'FP32 up-casting traffic inside eager PyTorch.',
      'Any measured GPU number: results stay “not measured” until you run the lab.',
    ],
  },
  formula: {
    name: 'RMSNorm and its traffic',
    tex: String.raw`y_i = \frac{x_i}{\sqrt{\frac{1}{H}\sum_{j=1}^{H} x_j^2 + \varepsilon}}\, w_i,\qquad \text{bytes}_{eager} \approx 7RHb,\ \ \text{bytes}_{fused} \approx 2RHb + Hb`,
    vars: [
      ['x, y', 'input and output row', 'activations'],
      ['w', 'learned per-channel weight', '—'],
      ['H', 'hidden size (row length)', 'elements'],
      ['R', 'rows (tokens)', 'rows'],
      ['b', 'bytes per element', 'B'],
      ['ε', 'stability constant, e.g. 1e-6', '—'],
    ],
    assumptions: ['Row fits in one program’s registers', 'w cached across rows', 'Eager = 6 separate kernels'],
    substituted: 'R=4096, H=8192, b=2: eager ≈ 7 × 64 MiB = 448 MiB; fused ≈ 128 MiB → bound 3.5×',
    check: 'mean(x²) has units x²; rsqrt gives 1/x; x · (1/x) is dimensionless × w ✓',
    cue: 'Square, mean, rsqrt, scale — in one trip through memory.',
  },
  estimates: [
    { quantity: 'Tensor size, 4096 × 8192 BF16', value: '64', unit: 'MiB', assumptions: 'R·H·2 B', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Eager traffic / fused traffic', value: '448 / 128', unit: 'MiB', assumptions: '7 vs 2 full passes', source: 'Formula', evidence: 'calculated' },
    { quantity: 'Speedup bound, large tensors', value: '≈ 3.5', unit: '×', assumptions: 'Bytes-bound, same achieved BW', source: 'Model', evidence: 'calculated' },
    { quantity: 'H100 SXM bandwidth', value: '3.35', unit: 'TB/s', assumptions: 'Peak', source: 'NVIDIA H100 page', evidence: 'vendor spec' },
    { quantity: 'Kernel launch overhead', value: '≈ 5', unit: 'µs', assumptions: 'Eager PyTorch', source: 'Teaching assumption', evidence: 'assumed' },
    { quantity: 'Fused kernel time on GPU', value: 'not measured', unit: 'µs', assumptions: 'Run labs/rmsnorm.py --bench', source: 'Lab', evidence: 'not measured' },
  ],
  compare: {
    naive: 'x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps) * w in eager PyTorch.',
    improved: 'One Triton program per row: load x, FP32 sum of squares, rsqrt, multiply by w, store y; masked for any hidden size.',
    mechanism: 'Intermediates stay in registers, so HBM traffic drops from ~7 to ~2 tensor passes and launches from 6 to 1.',
    rows: [
      ['HBM traffic', '≈ 7 R·H·b', '≈ 2 R·H·b'],
      ['Kernel launches', '6', '1'],
      ['Numerics', 'Depends on dtype of ops', 'FP32 accumulation by design'],
      ['Complexity', 'One line', 'Custom kernel + tests'],
    ],
  },
  lab: {
    title: 'Triton RMSNorm with correctness checks and CUDA-event benchmark', kind: 'gpu', file: 'labs/rmsnorm.py',
    deps: 'NVIDIA GPU, PyTorch ≥ 2.1 with CUDA, triton',
    commands: ['pip install torch triton', 'python3 labs/rmsnorm.py --check', 'python3 labs/rmsnorm.py --bench'], lang: 'python',
    code: `@triton.jit
def rmsnorm_kernel(X, W, Y, stride, H, eps, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    cols = tl.arange(0, BLOCK)
    mask = cols < H                                   # any hidden size
    x = tl.load(X + row * stride + cols, mask=mask, other=0.).to(tl.float32)
    w = tl.load(W + cols, mask=mask, other=0.).to(tl.float32)
    r = 1.0 / tl.sqrt(tl.sum(x * x, axis=0) / H + eps)  # FP32 reduction
    tl.store(Y + row * stride + cols, (x * r * w).to(Y.dtype.element_ty), mask=mask)`,
    checks: [
      'Matches FP32 reference within tolerance (BF16 atol ≈ 1e-2, FP32 ≈ 1e-5) on H ∈ {1, 127, 4096, 8191}',
      'x = [1, 2, 3, 4] → [0.3651, 0.7303, 1.0954, 1.4606]',
      'Benchmark reports effective GB/s = bytes moved ÷ time',
    ],
    gaps: 'Single row per program; very wide rows (> ~64K) may spill registers. No backward pass.',
  },
  bench: {
    hypothesis: 'Fused kernel ≥ 2.5× faster than the eager expression at 4096 × 8192 BF16 on H100, and within ±10 % of torch.compile.',
    baseline: 'Eager PyTorch expression; separately torch.compile output and torch.nn.functional.rms_norm if available.',
    controlled: ['GPU + clocks', 'PyTorch / Triton versions', 'dtype', 'shapes', 'ε'],
    workload: 'Rows ∈ {1, 64, 4096, 65536} × hidden ∈ {2048, 4096, 8192, 16384}, BF16 and FP32.',
    warmup: '25 iterations; exclude Triton JIT compile and autotune.', reps: '100 timed iterations × 3 runs.',
    method: 'CUDA events (triton.testing.do_bench or torch.cuda.Event) with synchronize; effective bandwidth = model bytes ÷ time.',
    metrics: ['median µs', 'p90 µs', 'effective GB/s', 'speedup vs each baseline'],
    interpret: 'Fused GB/s near peak confirms the memory-bound model; parity with torch.compile is the expected outcome, not a failure.',
  },
  pitfalls: [
    'Accumulating the sum of squares in BF16: loses precision on wide rows; accumulate in FP32.',
    'Forgetting the mask: hidden sizes that are not a power of two read out of bounds.',
    'Including Triton compile time in the benchmark.',
    'Comparing only with eager PyTorch and calling it a win when torch.compile already fuses.',
  ],
  optimizations: [
    ['Multiple rows per program for small H', 'Better occupancy; more indexing logic.'],
    ['Fuse residual add + RMSNorm (+ quantize to FP8)', 'Fewer passes again; less reusable kernel.'],
    ['Autotune BLOCK and num_warps per shape', 'Better speed; compile time and cache management.'],
  ],
  breaks: [
    'Baseline already fused (torch.compile, vendor kernels): ≈ 1×.',
    'Very wide rows exceeding registers: spills to local memory erase the gain.',
    'Tiny tensors inside CUDA graphs: launch savings vanish because launches are already amortized.',
  ],
  interview: {
    short:
      'RMSNorm computes, per row, y equals x times the reciprocal square root of the mean of x squared plus epsilon, times a learned weight; unlike LayerNorm it does not subtract the mean. It does very little math per byte, so it is memory-bound. The eager PyTorch expression runs about six kernels, pow, mean, add, rsqrt and two multiplies, and writes intermediates to HBM, so full-size tensors cross memory roughly seven times. My Triton kernel assigns one program per row, loads x with a mask so any hidden size works, accumulates the sum of squares in FP32, computes rsqrt, multiplies by w and stores y once. That is about two passes instead of seven, so for large tensors the speedup bound is roughly 3.5 times, plus fewer launches for small tensors. I validate against an FP32 reference for several dtypes and odd sizes, then benchmark with warm-up, CUDA events, excluding compilation, and report effective gigabytes per second. Against torch.compile or a vendor kernel I expect parity, because they are already fused.',
    whiteboard: [
      'Write the formula; contrast with LayerNorm.',
      'List eager kernels and count HBM passes (7).',
      'Sketch the Triton kernel: load, FP32 reduce, rsqrt, scale, store, mask.',
      'Bound: 7/2 for bytes, 6 launches → 1.',
      'Benchmark protocol and correctness tolerances.',
    ],
    followups: [
      ['Why accumulate in FP32?', 'Summing thousands of BF16 squares loses precision; FP32 accumulation keeps the norm accurate at small cost.'],
      ['Why is fusing residual add useful?', 'The residual sum is read by RMSNorm anyway; fusing saves another full write and read.'],
      ['When does one-row-per-program hurt?', 'Small H (few elements per program → low occupancy) and huge H (register spills).'],
    ],
    debug: [
      'Your kernel matches the reference for H = 4096 but gives NaN for H = 4097. Why?',
      'Missing or wrong mask: lanes beyond H read garbage (possibly NaN) and pollute the sum. Load with mask and other=0.',
    ],
    calc: [
      '65,536 rows × 8,192 BF16 on 3.35 TB/s at 80 % efficiency. Fused time floor?',
      'Bytes ≈ 2 × 65,536 × 8,192 × 2 = 2.15 GB → 2.15e9 / 2.68e12 ≈ 0.80 ms.',
    ],
  },
  changeMind: [
    'torch.compile or a library kernel already matching my kernel’s GB/s.',
    'Profiles showing RMSNorm is < 1 % of step time (not worth custom code).',
    'Precision problems that need a two-pass or Welford-style reduction.',
  ],
  recall: [
    ['RMSNorm vs LayerNorm?', 'RMSNorm does not subtract the mean.'],
    ['Eager vs fused HBM passes?', '≈ 7 vs ≈ 2.'],
    ['Why mask the load?', 'Hidden sizes not equal to BLOCK would read out of bounds.'],
  ],
  glossary: [
    ['RMSNorm', 'Root-mean-square normalization: scale by 1/√(mean(x²)+ε) and a learned weight.'],
    ['Triton', 'Python DSL for writing GPU kernels compiled by OpenAI Triton.'],
    ['Kernel fusion', 'Combining several operations into one GPU kernel to avoid intermediate memory traffic.'],
    ['Register spill', 'When a kernel needs more registers than available and uses slower local memory.'],
  ],
  tags: ['kernels', 'triton', 'fusion', 'rmsnorm', 'benchmark'],
};

export const lessons: Lesson[] = [q11, q12, q13, q14, q15];
