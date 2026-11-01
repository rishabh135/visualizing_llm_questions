#!/usr/bin/env python3
"""Cancellation-safe SSE token streaming over a mock engine (Q2). Stdlib only.

Run:   python3 sse_server.py --port 8000      then open http://127.0.0.1:8000/
Curl:  curl -N -X POST localhost:8000/generate -d '{"prompt":"hi","max_tokens":20}'

What is mocked: the "engine" sleeps instead of running GPU kernels and "KV blocks" are an
integer counter. The control flow (admission, cancellation by request id, deadlines,
bounded queues, idempotent release) is the part that carries over to a real server.
"""
from __future__ import annotations

import argparse
import asyncio
import itertools
import json
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024


class Overloaded(Exception):
    """Admission queue full: reject now instead of queueing without bound."""


class OutOfBlocks(Exception):
    pass


@dataclass
class Request:
    rid: str
    prompt: str
    max_tokens: int
    deadline: float  # loop.time() at which the request must stop
    # Bounded per-request output queue: this is the backpressure point between engine and socket.
    out: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=8))
    state: str = "queued"  # queued -> prefill -> decode -> done | cancelled | error
    cancel_reason: str | None = None
    blocks: int = 0
    released: bool = False
    tokens_sent: int = 0
    task: asyncio.Task | None = None


class MockEngine:
    def __init__(self, total_blocks=64, max_running=2, queue_max=8, block_tokens=16,
                 prefill_s=0.05, step_s=0.02, slow_consumer_s=2.0, fail_at_step: int | None = None):
        self.total_blocks = total_blocks
        self.free_blocks = total_blocks
        self.slots = asyncio.Semaphore(max_running)
        self.queue_max = queue_max
        self.block_tokens = block_tokens
        self.prefill_s, self.step_s = prefill_s, step_s
        self.slow_consumer_s = slow_consumer_s
        self.fail_at_step = fail_at_step
        self.requests: dict[str, Request] = {}
        self.release_calls: dict[str, int] = {}
        self._ids = itertools.count(1)

    @property
    def in_flight(self) -> int:
        return sum(r.state in ("queued", "prefill", "decode") for r in self.requests.values())

    def submit(self, prompt: str, max_tokens: int, deadline_s: float) -> Request:
        if self.in_flight >= self.queue_max:
            raise Overloaded(f"{self.in_flight} requests in flight (max {self.queue_max})")
        loop = asyncio.get_running_loop()
        req = Request(f"r{next(self._ids)}", prompt, max_tokens, loop.time() + deadline_s)
        self.requests[req.rid] = req
        req.task = asyncio.create_task(self._run(req))
        # Cleanup lives in a done-callback, not only in _run's finally: a task cancelled before its
        # first step never enters its body, so its finally would never run and its blocks would leak.
        req.task.add_done_callback(lambda _t: self._finish(req))
        return req

    def cancel(self, rid: str, reason: str) -> None:
        """Cancel by request id. Idempotent; a finished request is left alone.

        Mock: Task.cancel() interrupts at the next await, which here is always a step boundary.
        Real GPU engine: set a flag the scheduler reads between iterations; a running kernel
        cannot be interrupted, and KV must not be freed while a launched step still reads it.
        """
        req = self.requests.get(rid)
        if req is None or req.state in ("done", "cancelled", "error"):
            return
        req.cancel_reason = req.cancel_reason or reason
        if req.task and not req.task.done():
            req.task.cancel()

    def _alloc(self, req: Request) -> None:
        need = -(-(len(req.prompt.split()) + req.max_tokens) // self.block_tokens)  # ceil
        if need > self.free_blocks:
            raise OutOfBlocks(f"need {need} blocks, {self.free_blocks} free")
        self.free_blocks -= need
        req.blocks = need

    def _release(self, req: Request) -> None:
        """Return this request's KV blocks exactly once.

        Never call torch.cuda.empty_cache() here in a real engine: that returns cached
        allocator memory to the driver, it does not free one request's KV blocks.
        """
        self.release_calls[req.rid] = self.release_calls.get(req.rid, 0) + 1
        if req.released:
            return
        req.released = True
        self.free_blocks += req.blocks
        req.blocks = 0

    async def _emit(self, req: Request, ev: tuple) -> None:
        # A slow client must not stall the engine forever. Real batched engines should not
        # block the whole batch on one socket either: buffer a little, then cancel the laggard.
        try:
            await asyncio.wait_for(req.out.put(ev), self.slow_consumer_s)
        except asyncio.TimeoutError:
            req.cancel_reason = "slow_consumer"
            raise asyncio.CancelledError

    def _check_deadline(self, req: Request) -> None:
        if asyncio.get_running_loop().time() > req.deadline:
            raise TimeoutError("deadline exceeded")

    async def _run(self, req: Request) -> None:
        try:
            async with self.slots:  # admission: waits here while queued
                self._check_deadline(req)
                self._alloc(req)
                req.state = "prefill"
                await asyncio.sleep(self.prefill_s)  # prefill produces the first-token logits
                req.state = "decode"
                for step in range(req.max_tokens):
                    self._check_deadline(req)
                    if self.fail_at_step is not None and step == self.fail_at_step:
                        raise RuntimeError("mock engine fault")
                    await self._emit(req, ("token", {"index": step, "text": f"tok{step} "}))
                    req.tokens_sent += 1
                    await asyncio.sleep(self.step_s)  # next decode iteration
                req.state = "done"
                await self._emit(req, ("done", {"tokens": req.tokens_sent}))
        except asyncio.CancelledError:
            req.state = "cancelled"
            req.cancel_reason = req.cancel_reason or "cancelled"
            self._try_put(req, ("error", {"reason": req.cancel_reason}))
        except Exception as e:  # deadline, fault, out of blocks
            req.state = "error"
            reason = "deadline" if isinstance(e, TimeoutError) else str(e)
            self._try_put(req, ("error", {"reason": reason}))

    def _finish(self, req: Request) -> None:
        """Always runs once when the request task ends, however it ended (the 'finally')."""
        if req.state in ("queued", "prefill", "decode"):  # cancelled before the coroutine started
            req.state = "cancelled"
            req.cancel_reason = req.cancel_reason or "cancelled"
            self._try_put(req, ("error", {"reason": req.cancel_reason}))
        self._release(req)
        self._try_put(req, None)  # end-of-stream sentinel

    @staticmethod
    def _try_put(req: Request, ev) -> None:
        try:
            req.out.put_nowait(ev)
        except asyncio.QueueFull:
            pass  # consumer is gone or hopelessly behind; it will see the state instead


# ---------------- HTTP / SSE layer ----------------

def sse(event: str, data: dict, eid: int) -> bytes:
    body = json.dumps(data)
    return f"id: {eid}\nevent: {event}\ndata: {body}\n\n".encode()


async def read_request(reader: asyncio.StreamReader):
    head = await reader.readuntil(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    method, path, _ = lines[0].split(" ", 2)
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    n = int(headers.get("content-length", "0"))
    if n > MAX_BODY:
        raise ValueError("body too large")
    body = await reader.readexactly(n) if n else b""
    return method, path, headers, body


def respond(writer, status: str, ctype: str, body: bytes) -> None:
    writer.write(f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                 f"Connection: close\r\n\r\n".encode() + body)


async def handle(engine: MockEngine, reader, writer, heartbeat_s=5.0) -> None:
    req = None
    try:
        try:
            method, path, _, body = await read_request(reader)
        except (asyncio.IncompleteReadError, ValueError, asyncio.LimitOverrunError):
            respond(writer, "400 Bad Request", "text/plain", b"bad request")
            return
        if method == "GET" and path == "/":
            respond(writer, "200 OK", "text/html; charset=utf-8", (HERE / "sse_client.html").read_bytes())
            return
        if method != "POST" or path != "/generate":
            respond(writer, "404 Not Found", "text/plain", b"not found")
            return
        try:
            p = json.loads(body or b"{}")
            max_tokens = max(1, min(int(p.get("max_tokens", 32)), 4096))
            deadline_s = max(0.01, min(float(p.get("deadline_s", 30)), 600))
            req = engine.submit(str(p.get("prompt", "")), max_tokens, deadline_s)
        except Overloaded as e:
            respond(writer, "429 Too Many Requests", "application/json", json.dumps({"error": str(e)}).encode())
            return
        except (ValueError, TypeError):
            respond(writer, "400 Bad Request", "text/plain", b"bad json")
            return

        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n"
                     b"Cache-Control: no-cache\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n")
        eid = 0
        writer.write(sse("start", {"request_id": req.rid}, eid))
        # Detect disconnect even while no tokens flow: EOF on the read side means the client left.
        eof = asyncio.create_task(reader.read(1))
        while True:
            get = asyncio.create_task(req.out.get())
            done, _ = await asyncio.wait({get, eof}, timeout=heartbeat_s, return_when=asyncio.FIRST_COMPLETED)
            if eof in done:
                get.cancel()
                engine.cancel(req.rid, "disconnect")
                return
            if not done:
                get.cancel()
                writer.write(b": heartbeat\n\n")
            else:
                ev = get.result()
                if ev is None:
                    break
                eid += 1
                writer.write(sse(ev[0], ev[1], eid))
            # drain() blocks while the socket buffer is full: that is socket-level backpressure.
            await asyncio.wait_for(writer.drain(), 10)
        eof.cancel()
    except (ConnectionError, asyncio.TimeoutError):
        pass
    finally:
        if req is not None:
            engine.cancel(req.rid, "disconnect")  # no-op if already finished
        try:
            writer.close()
            await writer.wait_closed()
        except ConnectionError:
            pass


async def serve(host="127.0.0.1", port=8000, engine: MockEngine | None = None):
    engine = engine or MockEngine()
    server = await asyncio.start_server(lambda r, w: handle(engine, r, w), host, port)
    return server, engine


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    server, _ = await serve(a.host, a.port)
    print(f"SSE mock engine on http://{a.host}:{a.port}/  (POST /generate)")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
