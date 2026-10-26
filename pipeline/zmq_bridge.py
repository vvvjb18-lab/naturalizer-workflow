#!/usr/bin/env python3
"""zmq_bridge.py — ROUTER/DEALER async bridge between generation and scoring.

Topology (from the report):
  ROUTER (CPU, this file, --serve)   scores candidates, keeps every model warm
  DEALER (GPU / search side)         sends generation or scoring requests

Why async: ROCm-style latency spikes must never block the coordinator. Every
socket sets SNDHWM/RCVHWM so a stalled peer queues messages instead of
deadlocking, and clients retry with backoff instead of failing the run.

Protocol (multipart, JSON bodies):
  request   [b"", b'{"id":"...","op":"ping|score|score_many|generate","...'}']
  response  [b"", b'{"id":"...","ok":true,"result":...}']

Requests:
  {"op":"ping"}
  {"op":"score","text":"...","full":false}
  {"op":"score_many","texts":["..."],"full":false}
  {"op":"generate","text":"...","sampling":{...}}   → forwarded to the local
      Humanizer App /api/completion (the 12B call method is unchanged)

Usage:
  python zmq_bridge.py --test
  python zmq_bridge.py --serve [--port 5560]
  python zmq_bridge.py --client-score a.txt b.txt [--port 5560]
  python zmq_bridge.py --ping [--port 5560]
"""
import argparse
import json
import os
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (HERE, os.path.join(ROOT, "polish")):
    if p not in sys.path:
        sys.path.insert(0, p)

import zmq                                    # noqa: E402

try:
    import stat_scorer                        # noqa: E402
except Exception:                             # pragma: no cover
    stat_scorer = None

DEFAULT_PORT = 5560
HWM = 1000                                    # messages queued per peer
APP_URL = os.environ.get("HZ_APP_URL", "http://127.0.0.1:47615")


# ── server (ROUTER) ────────────────────────────────────────────────────────
class ScoreServer:
    def __init__(self, port=DEFAULT_PORT, full=False):
        self.port = port
        self.full = full
        self.ctx = zmq.Context.instance()
        self.sock = self.ctx.socket(zmq.ROUTER)
        self.sock.setsockopt(zmq.SNDHWM, HWM)
        self.sock.setsockopt(zmq.RCVHWM, HWM)
        self.sock.setsockopt(zmq.LINGER, 0)
        self.sock.bind(f"tcp://127.0.0.1:{port}")
        self._stop = threading.Event()
        self.thread = None
        self.handled = 0

    # -- request handling --------------------------------------------------
    def handle(self, req):
        op = req.get("op")
        if op == "ping":
            return {"pong": True, "ts": time.time(), "hwm": HWM}
        if op == "score":
            if stat_scorer is None:
                raise RuntimeError("stat_scorer unavailable")
            return stat_scorer.score(str(req.get("text") or ""),
                                     full=bool(req.get("full", self.full)),
                                     light=bool(req.get("light", False)))
        if op == "score_many":
            if stat_scorer is None:
                raise RuntimeError("stat_scorer unavailable")
            texts = [str(t) for t in (req.get("texts") or [])]
            full = bool(req.get("full", self.full))
            light = bool(req.get("light", False))
            return [stat_scorer.score(t, full=full, light=light) for t in texts]
        if op == "generate":
            return generate(req)
        raise ValueError(f"unknown op {op!r}")

    def serve_forever(self):
        poller = zmq.Poller()
        poller.register(self.sock, zmq.POLLIN)
        while not self._stop.is_set():
            if poller.poll(200) == []:
                continue
            try:
                frames = self.sock.recv_multipart()
            except zmq.ZMQError:
                break
            if len(frames) < 2:
                continue
            ident, payload = frames[0], frames[-1]
            try:
                req = json.loads(payload.decode("utf-8"))
            except Exception as e:                      # noqa: BLE001
                self.sock.send_multipart([ident, json.dumps({"ok": False, "error": f"bad json: {e}"}).encode()])
                continue
            rid = req.get("id")
            try:
                result = self.handle(req)
                resp = {"id": rid, "ok": True, "result": result}
            except Exception as e:                      # noqa: BLE001
                resp = {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}
            try:
                self.sock.send_multipart([ident, json.dumps(resp, ensure_ascii=False).encode()])
            except zmq.ZMQError as e:                   # peer gone: never die
                print(f"[zmq_bridge] send failed: {e}", file=sys.stderr)
            self.handled += 1

    def start(self):
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.sock.close(0)


def generate(req):
    """Generation goes through the Humanizer App exactly as before."""
    import urllib.request
    text = str(req.get("text") or "")
    sampling = req.get("sampling") or {}
    body = json.dumps({
        "prompt": text,
        "n_predict": int(req.get("n_predict", 512)),
        "temperature": sampling.get("temperature", 1.0),
        "top_p": sampling.get("topP", 0.95),
        "top_k": 0, "min_p": 0, "repeat_penalty": 1.0,
    }).encode()
    r = urllib.request.Request(f"{APP_URL}/api/completion", data=body,
                               headers={"Content-Type": "application/json", "X-Humanizer": "1"})
    with urllib.request.urlopen(r, timeout=300) as resp:
        data = json.loads(resp.read().decode())
    return {"content": str(data.get("content") or "").strip()}


# ── client (DEALER) ────────────────────────────────────────────────────────
class BridgeClient:
    def __init__(self, port=DEFAULT_PORT, timeout_ms=60000, retries=3):
        self.ctx = zmq.Context.instance()
        self.sock = self.ctx.socket(zmq.DEALER)
        self.sock.setsockopt(zmq.SNDHWM, HWM)
        self.sock.setsockopt(zmq.RCVHWM, HWM)
        self.sock.setsockopt(zmq.LINGER, 0)
        self.sock.connect(f"tcp://127.0.0.1:{port}")
        self.timeout_ms = timeout_ms
        self.retries = retries

    def call(self, payload):
        rid = payload.setdefault("id", uuid.uuid4().hex[:12])
        raw = json.dumps(payload, ensure_ascii=False).encode()
        last = None
        for attempt in range(self.retries):
            self.sock.send_multipart([b"", raw])
            poller = zmq.Poller()
            poller.register(self.sock, zmq.POLLIN)
            if poller.poll(self.timeout_ms) == []:
                last = TimeoutError(f"no reply within {self.timeout_ms} ms")
                time.sleep(0.2 * (2 ** attempt))         # ROCm spike backoff
                continue
            frames = self.sock.recv_multipart()
            try:
                resp = json.loads(frames[-1].decode("utf-8"))
            except Exception as e:                      # noqa: BLE001
                last = e
                continue
            if resp.get("ok"):
                return resp.get("result")
            last = RuntimeError(resp.get("error"))
        raise RuntimeError(f"bridge call failed after {self.retries} tries: {last}")

    def close(self):
        self.sock.close(0)


def wait_ready(port, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            c = BridgeClient(port, timeout_ms=500, retries=1)
            c.call({"op": "ping"})
            c.close()
            return True
        except Exception:
            time.sleep(0.15)
    return False


# ── self-test ──────────────────────────────────────────────────────────────
def self_test(port=DEFAULT_PORT + 17):
    srv = ScoreServer(port).start()
    ok_ping = wait_ready(port, timeout=5)
    cli = BridgeClient(port, timeout_ms=20000, retries=2)
    t0 = time.time()
    score = cli.call({"op": "score", "text": "Physical stores carry rent and staffing costs. Online channels trade those for delivery and returns overhead."})
    dt_score = time.time() - t0
    t0 = time.time()
    many = cli.call({"op": "score_many", "texts": ["Short text about costs.", "Another text about logistics and delivery overheads."]})
    dt_many = time.time() - t0
    cli.close()
    srv.stop()
    print(json.dumps({
        "ping": ok_ping,
        "score": score,
        "score_latency_ms": round(dt_score * 1000),
        "score_many_n": len(many) if isinstance(many, list) else None,
        "score_many_latency_ms": round(dt_many * 1000),
        "handled": srv.handled,
        "hwm": HWM,
    }, ensure_ascii=False, indent=1))


def main():
    ap = argparse.ArgumentParser(description="ZMQ ROUTER/DEALER bridge for scoring + generation")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--ping", action="store_true")
    ap.add_argument("--client-score", nargs="*", default=None)
    ap.add_argument("--full", action="store_true")
    a = ap.parse_args()

    if a.test:
        self_test(a.port + 17)
        return
    if a.serve:
        srv = ScoreServer(a.port, full=a.full)
        print(f"[zmq_bridge] ROUTER listening on tcp://127.0.0.1:{a.port} · HWM {HWM}", file=sys.stderr)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            srv.stop()
        return
    if a.ping:
        print(json.dumps(BridgeClient(a.port, timeout_ms=3000, retries=1).call({"op": "ping"}), ensure_ascii=False))
        return
    if a.client_score is not None:
        cli = BridgeClient(a.port, timeout_ms=120000, retries=3)
        texts = [open(p, encoding="utf-8", errors="replace").read() for p in a.client_score]
        res = cli.call({"op": "score_many", "texts": texts, "full": a.full})
        for p, r in zip(a.client_score, res):
            r["file"] = p
        print(json.dumps(res, ensure_ascii=False))
        cli.close()
        return
    ap.print_help()


if __name__ == "__main__":
    main()
