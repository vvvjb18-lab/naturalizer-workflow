#!/usr/bin/env python3
"""shred_batch.py — batch wrapper around shredder.py for pipeline use.

Loads the spaCy model once, then perturbs a list of paragraph units in one
process (spawning Python per paragraph would cost ~2.5 s each).

Input JSON:  {"units": [{"id": "...", "text": "..."}], "rate": 0.5, "seed": 0}
Output JSON: {"units": [{"id": "...", "text": "..."}],
              "stats": {"units": n, "ops": {...}, "cv_before": ..., "cv_after": ...},
              "fact_loss": 0}
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import shredder  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--rate", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=None)
    a = ap.parse_args()

    data = json.load(open(a.input, encoding="utf-8"))
    units = data.get("units") or []
    out_units, ops = [], {"voice": 0, "split": 0, "merge": 0, "reorder": 0}
    cvs_before, cvs_after = [], []
    fact_loss = 0

    for u in units:
        text = u.get("text") or ""
        if not text.strip():
            out_units.append({"id": u.get("id"), "text": text})
            continue
        new, st = shredder.shred(text, rate=data.get("rate", a.rate),
                                 seed=a.seed if a.seed is not None else data.get("seed"),
                                 verbose=False)
        for k in ops:
            ops[k] += st["ops"].get(k, 0)
        cvs_before.append(st["before"]["cv"])
        cvs_after.append(st["after"]["cv"])
        if not shredder.preserves(text, new):
            fact_loss += 1
            new = text                      # hard guard: never lose a fact
        out_units.append({"id": u.get("id"), "text": new})

    mean = lambda xs: round(sum(xs) / len(xs), 4) if xs else 0.0
    payload = {
        "units": out_units,
        "stats": {
            "units": len(units),
            "ops": ops,
            "ops_total": sum(ops.values()),
            "cv_before": mean(cvs_before),
            "cv_after": mean(cvs_after),
        },
        "fact_loss": fact_loss,
    }
    json.dump(payload, open(a.output, "w", encoding="utf-8"), ensure_ascii=False)
    print(json.dumps(payload["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
