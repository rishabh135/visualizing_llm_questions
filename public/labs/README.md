# Runnable labs

Python 3.11+ (stdlib only) unless noted. Run from this folder.

| Lab | Command | Expected output | What is mocked |
| --- | --- | --- | --- |
| SSE streaming server (Q2) | `python3 sse_server.py --port 8000` then open http://127.0.0.1:8000/ | Tokens stream into the page; **Cancel** stops the engine and frees blocks | Engine sleeps instead of running kernels; KV blocks are a counter |
| SSE tests (Q2) | `python3 -m unittest test_sse_server.py` | `Ran 10 tests … OK` | Same mock engine; not GPU cancellation |
| SSE client (Q2) | served by the server at `/` | Live tokens, event log, heartbeats | — |
| RMSNorm reference (Q15) | `python3 rmsnorm.py --cpu-check` | `y = [0.3651, 0.7303, 1.0954, 1.4606]`, `cpu-check OK` | Nothing: pure Python |
| RMSNorm Triton kernel (Q15) | `pip install torch triton` then `python3 rmsnorm.py --check --bench` | Per shape/dtype `ok … max\|err\|`, then a timing table with GB/s | Needs a CUDA GPU; prints `not measured` without one |
| Streaming benchmark (Q18) | `python3 benchmark.py --dry-run --rate 5 --duration 3` | p50/p90/p99 TTFT and token gap, success rate, raw JSONL | `--dry-run` targets an in-process mock server |
| Benchmark a real engine (Q18) | `python3 benchmark.py --url http://HOST:PORT/v1/completions --api openai --model M --rate 4 --duration 600` | Same table against a real OpenAI-compatible server | Nothing; label results `measured` with the environment |
| Production protocols (Q18–Q22) | read `PROTOCOL.md` | Checklists, gates, results schema | Not runnable: implementation protocols |

**Why dry-run TTFT climbs:** the mock serves 4 requests at once at ~1.3 s each (≈ 3 req/s); 5 req/s open-loop arrivals exceed that, so requests queue. That is the open-loop overload behaviour a closed-loop client would hide.

**Status:** CPU checks and SSE tests were run. Triton/CUDA was unavailable, so every GPU result is **not measured**.
