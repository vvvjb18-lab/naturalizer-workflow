#!/usr/bin/env python3
"""detector_daemon.py — long-lived detector process for Workflow 7.0.

Reads one JSON request per line on stdin, writes one JSON response per line on
stdout. Models load lazily on first use and stay in memory, so the Node side
pays the ~30-60s model load once per run instead of once per scoring call.

Request:  {"id": 1, "op": "score_many", "texts": ["...", ...]}
          {"id": 2, "op": "gram",  "sents": ["...", ...]}
          {"id": 3, "op": "nli",   "pairs": [["prem","hyp"], ...]}
          {"id": 4, "op": "ping"}
Response: {"id": 1, "ok": true, "result": ...}
          {"id": 1, "ok": false, "error": "..."}
"""
import json
import sys

import detector_bridge as B


def handle(req):
    op = req.get("op")
    rid = req.get("id")
    if op == "ping":
        return {"id": rid, "ok": True, "result": {"models": sorted(B._MODELS.keys())}}
    if op == "score_many":
        texts = [str(t) for t in (req.get("texts") or [])]
        return {"id": rid, "ok": True, "result": [B.score_text(t) for t in texts]}
    if op == "gram":
        sents = [str(s) for s in (req.get("sents") or [])]
        return {"id": rid, "ok": True, "result": [r["p_gram"] for r in B.gram_list(sents)]}
    if op == "nli":
        pairs = [(str(a), str(b)) for a, b in (req.get("pairs") or [])]
        return {"id": rid, "ok": True, "result": B.nli_list(pairs)}
    return {"id": rid, "ok": False, "error": f"unknown op {op!r}"}


def main():
    sys.stdout.write(json.dumps({"id": None, "ok": True, "result": {"ready": True}}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({"id": None, "ok": False, "error": f"bad json: {e}"}) + "\n")
            sys.stdout.flush()
            continue
        try:
            resp = handle(req)
        except Exception as e:
            resp = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
