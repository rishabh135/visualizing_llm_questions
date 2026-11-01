#!/usr/bin/env python3
"""Open-loop streaming benchmark (Q18). Stdlib only.

  python3 benchmark.py --dry-run --rate 5 --duration 3
  python3 benchmark.py --url http://localhost:8000/v1/completions --api openai --model my-model --rate 4 --duration 60

Open loop: arrival times are drawn up front (seeded Poisson) and each request is sent at its time
whether or not earlier ones finished. Closed-loop clients hide overload (coordinated omission).

Units are kept separate:  events = SSE events received;  tokens = server-reported usage (None if absent);
chars = decoded text characters. A token gap is the time between consecutive content events.
"""
from __future__ import annotations

import argparse
import asyncio
import codecs
import json
import random
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit


def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, -(-len(s) * p // 100) - 1))]  # nearest rank


async def open_stream(url: str, payload: dict):
    u = urlsplit(url)
    reader, writer = await asyncio.open_connection(u.hostname, u.port or 80)
    body = json.dumps(payload).encode()
    writer.write(f"POST {u.path or '/'} HTTP/1.1\r\nHost: {u.netloc}\r\nContent-Type: application/json\r\n"
                 f"Accept: text/event-stream\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    return reader, writer, status, headers.get("transfer-encoding", "").lower() == "chunked"


async def body_chunks(reader: asyncio.StreamReader, chunked: bool):
    if not chunked:
        while data := await reader.read(65536):
            yield data
        return
    while True:
        size = int((await reader.readline()).split(b";")[0].strip() or b"0", 16)
        if size == 0:
            return
        yield await reader.readexactly(size)
        await reader.readline()  # CRLF after each chunk


def sse_events(decoder, buf: list[str], data: bytes):
    """Incremental SSE framing; UTF-8 safe across chunk splits. Returns complete (event, data) pairs."""
    buf[0] += decoder.decode(data)
    text = buf[0].replace("\r\n", "\n").replace("\r", "\n")
    *blocks, buf[0] = text.split("\n\n")
    out = []
    for blk in blocks:
        ev, datas = "message", []
        for line in blk.split("\n"):
            if line.startswith(":"):
                continue
            k, _, v = line.partition(":")
            v = v[1:] if v.startswith(" ") else v
            if k == "event":
                ev = v
            elif k == "data":
                datas.append(v)
        if datas:
            out.append((ev, "\n".join(datas)))
    return out


async def one_request(i: int, url: str, api: str, args, t0: float, sched: float) -> dict:
    rec = {"id": i, "scheduled_s": sched, "send_s": None, "first_byte_s": None, "first_token_s": None,
           "gaps_ms": [], "end_s": None, "status": None, "error": None, "events": 0, "tokens": None, "chars": 0}
    payload = ({"prompt": args.prompt, "max_tokens": args.max_tokens, "deadline_s": args.timeout} if api == "mock"
               else {"model": args.model, "prompt": args.prompt, "max_tokens": args.max_tokens, "stream": True,
                     "stream_options": {"include_usage": True}})
    now = lambda: time.perf_counter() - t0  # noqa: E731
    rec["send_s"] = now()
    last = None
    try:
        async with asyncio.timeout(args.timeout):
            reader, writer, status, chunked = await open_stream(url, payload)
            rec["status"] = status
            dec, buf = codecs.getincrementaldecoder("utf-8")(), [""]
            try:
                async for data in body_chunks(reader, chunked):
                    if rec["first_byte_s"] is None:
                        rec["first_byte_s"] = now()
                    for ev, d in sse_events(dec, buf, data):
                        rec["events"] += 1
                        text = None
                        if api == "mock":
                            if ev == "token":
                                text = json.loads(d)["text"]
                            elif ev == "error":
                                rec["error"] = json.loads(d).get("reason")
                        elif d.strip() != "[DONE]":
                            j = json.loads(d)
                            if j.get("usage"):
                                rec["tokens"] = j["usage"].get("completion_tokens")
                            ch = j.get("choices") or []
                            text = (ch[0].get("text") or (ch[0].get("delta") or {}).get("content")) if ch else None
                        if text:
                            t = now()
                            if rec["first_token_s"] is None:
                                rec["first_token_s"] = t
                            else:
                                rec["gaps_ms"].append((t - last) * 1000)
                            last = t
                            rec["chars"] += len(text)
            finally:
                writer.close()
        if status != 200 and not rec["error"]:
            rec["error"] = f"http {status}"
    except Exception as e:  # timeout, refused, reset: recorded, never dropped
        rec["error"] = type(e).__name__ + (f": {e}" if str(e) else "")
    rec["end_s"] = now()
    return rec


async def run(args) -> int:
    url, api, server = args.url, args.api, None
    if args.dry_run:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from sse_server import MockEngine, serve
        server, _ = await serve("127.0.0.1", 0, MockEngine(max_running=4, queue_max=16, prefill_s=0.05, step_s=0.02))
        url, api = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/generate", "mock"
    rnd = random.Random(args.seed)
    arrivals, t = [], rnd.expovariate(args.rate)
    while t < args.duration:
        arrivals.append(t)
        t += rnd.expovariate(args.rate)
    t0 = time.perf_counter()

    async def at(i, s):
        await asyncio.sleep(max(0.0, s - (time.perf_counter() - t0)))
        return await one_request(i, url, api, args, t0, s)

    recs = await asyncio.gather(*(at(i, s) for i, s in enumerate(arrivals)))
    if server:
        server.close()
    with open(args.out, "w") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")

    ok = [r for r in recs if not r["error"] and r["first_token_s"] is not None]
    ttft = [(r["first_token_s"] - r["send_s"]) * 1000 for r in ok]
    gaps = [g for r in ok for g in r["gaps_ms"]]
    late = [(r["send_s"] - r["scheduled_s"]) * 1000 for r in recs]
    fmt = lambda v: "—" if v is None else f"{v:8.1f}"  # noqa: E731
    print(f"target {url}  api={api}  rate={args.rate}/s  duration={args.duration}s  seed={args.seed}")
    print(f"requests sent {len(recs)}  succeeded {len(ok)}  success rate {len(ok) / max(1, len(recs)):.1%}")
    errs = {}
    for r in recs:
        if r["error"]:
            errs[r["error"]] = errs.get(r["error"], 0) + 1
    if errs:
        print("errors:", errs)
    print(f"{'metric':<22}{'p50':>9}{'p90':>9}{'p99':>9}   n")
    for name, xs in (("TTFT ms (client)", ttft), ("token gap ms", gaps), ("send lateness ms", late)):
        print(f"{name:<22}{fmt(pct(xs, 50))}{fmt(pct(xs, 90))}{fmt(pct(xs, 99))}   {len(xs)}")
    tok = [r["tokens"] for r in ok if r["tokens"] is not None]
    print(f"events {sum(r['events'] for r in recs)}  chars {sum(r['chars'] for r in ok)}  "
          f"tokens {sum(tok) if tok else 'not reported by server'}")
    print(f"raw records: {args.out}")
    print("Evidence label: measured on this client/target only" + (" (mock engine — not a GPU result)." if args.dry_run else "."))
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8000/v1/completions")
    ap.add_argument("--api", choices=["openai", "mock"], default="openai")
    ap.add_argument("--model", default="model")
    ap.add_argument("--prompt", default="Explain the KV cache in two sentences.")
    ap.add_argument("--max-tokens", type=int, default=64)
    ap.add_argument("--rate", type=float, default=2.0, help="mean arrivals per second (Poisson)")
    ap.add_argument("--duration", type=float, default=30.0, help="seconds of arrivals")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="bench_records.jsonl")
    ap.add_argument("--dry-run", action="store_true", help="benchmark an in-process mock server")
    sys.exit(asyncio.run(run(ap.parse_args())))


if __name__ == "__main__":
    main()
