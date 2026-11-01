# Implementation protocols

Production steps that a browser or CPU mock cannot prove. Each one ends in a measurement, not a claim.

**Evidence labels used everywhere:** `calculated` · `simulated` · `measured` · `vendor spec` · `assumed` · `not measured`.

---

## 1. Results schema (use for every performance claim)

| Field | Example | Required |
| --- | --- | --- |
| environment | 8× H100 SXM 80 GB, NVLink, driver 5xx, CUDA 12.x, engine + version | ✓ |
| workload | arrival trace id, input/output length distributions, prefix reuse %, seed | ✓ |
| baseline | same workload on current production config | ✓ |
| metric + unit | p99 TTFT (ms), output tokens/s at SLO, $/M output tokens | ✓ |
| repetitions | ≥ 3 runs × ≥ 10 min steady state, warm-up discarded | ✓ |
| median and tail | p50 / p90 / p99 with run-to-run spread | ✓ |
| evidence label | `measured` only if it ran on that hardware | ✓ |
| interpretation | what changed, why, what it does not prove | ✓ |

TTFT = time to first token. SLO = service-level objective. p99 = 99th percentile.

---

## 2. Controlled engine comparison (Q18: vLLM vs TensorRT-LLM vs SGLang)

**Fix (identical across engines)**
- [ ] Model weights, tokenizer, chat template, precision (weights and KV)
- [ ] GPU type, count, topology, tensor-parallel degree
- [ ] Arrival trace (open-loop, seeded), length distributions, prefix-cache warmness
- [ ] Sampling parameters, max tokens, stop conditions
- [ ] Tuning budget: same hours per engine, documented flags

**Measure**
- [ ] Throughput **at** the stated SLO (not peak throughput)
- [ ] TTFT and token-gap p50/p99; error and timeout rate
- [ ] Overload behaviour: sweep rate past saturation; record queueing, rejections, recovery
- [ ] Peak memory, startup time to ready, quality on a fixed eval set
- [ ] Feature support needed in production (LoRA, structured output, spec decode, metrics)

**Run**
```bash
python3 benchmark.py --url http://HOST:PORT/v1/completions --api openai --model M --rate R --duration 600 --seed 1 --out engineA_R.jsonl
```
Repeat per rate R in the sweep, per engine, ≥ 3 seeds. Keep raw JSONL.

**Never:** publish a single winner, compare engines on different precisions, or use closed-loop numbers to claim overload behaviour.

---

## 3. Rollout of a new model or quantization (Q19)

States: `offline eval → shadow → canary 1 % → 10 % → 50 % → 100 %`, rollback possible from every state.

| Gate | Pass criterion (set before the test) | Sample / hold |
| --- | --- | --- |
| Offline quality | Task scores within pre-agreed margin of baseline, CI excludes worse-than-margin | Fixed eval sets incl. long context, tool/schema, safety |
| Shadow | Schema/tool-call validity ≥ baseline; latency within SLO on mirrored traffic | Privacy-approved traffic only; outputs not shown to users |
| Canary | Error rate, p99 TTFT, token gap within budget; no quality alarms | Hold ≥ 1 traffic cycle; enough requests for the CI width you need |
| Staged | Same gates at each step | Hold per step |

**Rollback triggers (automatic):** error budget burn > threshold, p99 TTFT > SLO for N minutes, schema-failure spike, safety-classifier spike.

**Checklist**
- [ ] Immutable, versioned artifacts (weights hash, engine image, config)
- [ ] Versioned routing; prefix-cache namespace includes model + tokenizer + quantization version
- [ ] Previous version kept **warm** with enough capacity to take 100 % back
- [ ] Drain in-flight requests before removing a version
- [ ] Rollback rehearsed before the canary starts

---

## 4. Autoscaling with slow GPU startup (Q20)

Startup = detect + provision + image pull + weight load + compile/graph capture + warm-up + readiness. **Measure each span**; minutes are typical, seconds are not.

- [ ] Scale on queued **work** (prompt + expected output tokens), not request count
- [ ] Keep a minimum warm pool sized for the spike you must absorb during startup
- [ ] Bounded queues + admission control + approved degradation (shorter max tokens, smaller model) while capacity arrives
- [ ] Hysteresis and cooldown; scale-down drains in-flight requests first
- [ ] Scheduled pre-warming for known daily peaks
- [ ] Record: time from spike to SLO recovery, rejected requests, cost of idle warm pool

---

## 5. Disaggregated prefill/decode integration (Q22)

- [ ] Compute KV bytes from **actual cached tokens** (2 × L × H_kv × D_head × b_kv × T)
- [ ] Measure effective link bandwidth under contention (not the link's peak) and setup latency
- [ ] Decide transfer granularity: per layer (overlaps with prefill) vs whole request
- [ ] Layout conversion cost if prefill and decode use different TP or block layouts
- [ ] Ownership handoff: KV is freed on the prefill side only after the decode side acknowledges
- [ ] Failure paths: transfer timeout → recompute on decode pool or retry; never leak blocks on either side
- [ ] Backpressure when decode pool is full; pool-ratio tuning (prefill : decode GPUs)
- [ ] Compare against monolithic on the same trace: TTFT, token gap, throughput at SLO, cost

---

## 6. GPU integration gaps in these labs

| Lab | Mocked here | Needed for production |
| --- | --- | --- |
| `sse_server.py` | Sleep-based engine, integer KV blocks | Hook cancel into the engine scheduler; free KV only after the in-flight step finishes |
| `benchmark.py --dry-run` | In-process mock server | Real engine, real hardware, representative trace |
| `rmsnorm.py` | Runs on CPU only for the reference | CUDA GPU + Triton; record GPU, driver, versions |
| Browser simulators | Teaching models | Calibrate with measured step times before using any number |
