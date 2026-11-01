"""Tests for the mock SSE engine. Run from repo root or public/:  python3 -m unittest labs/test_sse_server.py
These exercise a CPU mock engine, not GPU engine cancellation."""
import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sse_server import MockEngine, Overloaded, serve  # noqa: E402


async def drain(req):
    evs = []
    while (ev := await req.out.get()) is not None:
        evs.append(ev)
    return evs


async def wait_state(req, states, timeout=2.0):
    end = asyncio.get_running_loop().time() + timeout
    while req.state not in states:
        if asyncio.get_running_loop().time() > end:
            raise AssertionError(f"state stuck at {req.state}")
        await asyncio.sleep(0.005)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    def assertCleanedUp(self, eng, req):
        self.assertEqual(eng.release_calls[req.rid], 1)
        self.assertTrue(req.released)
        self.assertTrue(req.task.done())

    async def test_normal_completion(self):
        eng = MockEngine(step_s=0.001, prefill_s=0.001)
        req = eng.submit("a b c", 5, 10)
        evs = await drain(req)
        self.assertEqual([e[0] for e in evs], ["token"] * 5 + ["done"])
        self.assertEqual(req.state, "done")
        self.assertEqual(eng.free_blocks, eng.total_blocks)
        self.assertCleanedUp(eng, req)

    async def test_cancel_before_admission(self):
        eng = MockEngine(max_running=1, prefill_s=0.2)
        a = eng.submit("x", 3, 10)
        b = eng.submit("y", 3, 10)
        await asyncio.sleep(0.01)
        self.assertEqual(b.state, "queued")
        eng.cancel(b.rid, "disconnect")
        evs = await drain(b)
        self.assertEqual(b.state, "cancelled")
        self.assertEqual(evs[-1], ("error", {"reason": "disconnect"}))
        self.assertEqual(b.blocks, 0)  # never allocated
        self.assertCleanedUp(eng, b)
        eng.cancel(a.rid, "test")
        await drain(a)
        self.assertEqual(eng.free_blocks, eng.total_blocks)

    async def test_cancel_during_prefill(self):
        eng = MockEngine(prefill_s=0.5)
        req = eng.submit("x", 10, 10)
        await wait_state(req, {"prefill"})
        self.assertLess(eng.free_blocks, eng.total_blocks)
        eng.cancel(req.rid, "disconnect")
        await drain(req)
        self.assertEqual(req.state, "cancelled")
        self.assertEqual(req.tokens_sent, 0)
        self.assertEqual(eng.free_blocks, eng.total_blocks)
        self.assertCleanedUp(eng, req)

    async def test_cancel_during_decode_stops_engine(self):
        eng = MockEngine(prefill_s=0.001, step_s=0.01)
        req = eng.submit("x", 1000, 10)
        got = 0
        while got < 3:
            ev = await req.out.get()
            got += ev[0] == "token"
        eng.cancel(req.rid, "disconnect")
        eng.cancel(req.rid, "again")  # repeated cancel is a no-op
        await drain(req)
        sent = req.tokens_sent
        await asyncio.sleep(0.05)
        self.assertEqual(req.tokens_sent, sent)  # engine really stopped
        self.assertLess(sent, 20)
        self.assertEqual(req.cancel_reason, "disconnect")
        self.assertCleanedUp(eng, req)

    async def test_deadline(self):
        eng = MockEngine(prefill_s=0.001, step_s=0.02)
        req = eng.submit("x", 1000, 0.05)
        evs = await drain(req)
        self.assertEqual(req.state, "error")
        self.assertEqual(evs[-1], ("error", {"reason": "deadline"}))
        self.assertCleanedUp(eng, req)
        self.assertEqual(eng.free_blocks, eng.total_blocks)

    async def test_engine_exception(self):
        eng = MockEngine(prefill_s=0.001, step_s=0.001, fail_at_step=2)
        req = eng.submit("x", 10, 10)
        evs = await drain(req)
        self.assertEqual([e[0] for e in evs], ["token", "token", "error"])
        self.assertIn("fault", evs[-1][1]["reason"])
        self.assertCleanedUp(eng, req)
        self.assertEqual(eng.free_blocks, eng.total_blocks)

    async def test_bounded_queue_rejects(self):
        eng = MockEngine(queue_max=2, max_running=1, prefill_s=0.2)
        a, b = eng.submit("x", 2, 10), eng.submit("y", 2, 10)
        with self.assertRaises(Overloaded):
            eng.submit("z", 2, 10)
        for r in (a, b):
            eng.cancel(r.rid, "test")
            await drain(r)
            self.assertCleanedUp(eng, r)
        eng.submit("z", 1, 10)  # capacity is back

    async def test_slow_consumer_is_cancelled(self):
        eng = MockEngine(prefill_s=0.001, step_s=0.0, slow_consumer_s=0.05)
        req = eng.submit("x", 100, 10)  # nobody reads: out queue (8) fills
        await wait_state(req, {"cancelled"})
        self.assertEqual(req.cancel_reason, "slow_consumer")
        self.assertCleanedUp(eng, req)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_cancels_by_request_id(self):
        server, eng = await serve("127.0.0.1", 0, MockEngine(prefill_s=0.001, step_s=0.02))
        port = server.sockets[0].getsockname()[1]
        async with server:
            r, w = await asyncio.open_connection("127.0.0.1", port)
            body = json.dumps({"prompt": "hi", "max_tokens": 1000}).encode()
            w.write(b"POST /generate HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            await w.drain()
            seen = b""
            while seen.count(b"event: token") < 2:
                seen += await r.read(1024)
            self.assertIn(b"text/event-stream", seen)
            w.close()  # client disconnects mid-decode
            req = next(iter(eng.requests.values()))
            await wait_state(req, {"cancelled"})
            self.assertEqual(req.cancel_reason, "disconnect")
            self.assertEqual(eng.release_calls[req.rid], 1)
            self.assertEqual(eng.free_blocks, eng.total_blocks)

    async def test_full_stream_framing(self):
        server, _ = await serve("127.0.0.1", 0, MockEngine(prefill_s=0.001, step_s=0.001))
        port = server.sockets[0].getsockname()[1]
        async with server:
            r, w = await asyncio.open_connection("127.0.0.1", port)
            body = b'{"prompt":"hi","max_tokens":3}'
            w.write(b"POST /generate HTTP/1.1\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            data = await asyncio.wait_for(r.read(), 2)
            w.close()
            events = [blk for blk in data.split(b"\r\n\r\n", 1)[1].split(b"\n\n") if blk]
            names = [l.split(b": ", 1)[1] for e in events for l in e.split(b"\n") if l.startswith(b"event:")]
            self.assertEqual(names, [b"start", b"token", b"token", b"token", b"done"])


if __name__ == "__main__":
    unittest.main()
