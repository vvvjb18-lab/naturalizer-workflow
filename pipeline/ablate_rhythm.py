#!/usr/bin/env python3
"""ablate_rhythm.py — controlled micro-ablation for the rhythm sources.

Bypasses the pipeline's selection/filters so the measurement isolates ONE
question: does a rhythm source change what the 12B actually generates, and by
how much on our offline scale?

Conditions (same units, same sampling, same seed text):
  base         INSTR + unit
  shred        INSTR + shredded(unit)
  guide        INSTR + style guidance + unit
  shred+guide  INSTR + style guidance + shredded(unit)

Usage:
  python ablate_rhythm.py --plan-json <plan.json> --guide-json style.json \
      --out ablation.json [--units 4] [--shred-rate 0.5]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (HERE, os.path.join(ROOT, "polish")):
    if p not in sys.path:
        sys.path.insert(0, p)

import shredder                      # noqa: E402
import stat_scorer                   # noqa: E402
import detector_bridge as DB         # noqa: E402

APP = os.environ.get("HZ_APP_URL", "http://127.0.0.1:47615")
INSTR = ("Rewrite the text below so it reads like a person wrote it, not a language model.\n"
         "\n"
         "Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\n"
         "throat-clearing, and any sentence that only announces what comes next.\n"
         "Prefer the concrete word over the abstract one. It is fine to sound uneven.\n"
         "\n"
         "Every fact, number, unit, date, name and quotation must survive unchanged.")
SEP = "\n\n### Rewritten:\n\n"


def guidance(style_json, topk=10):
    r = style_json.get("rhythm", {})
    mean = r.get("mean") or 18
    sd = r.get("sd") or 7
    lines = [
        "Style guidance: Write with the following rhythm characteristics:",
        f"- Average sentence length: {int(max(11, min(26, mean)))} words (±{int(max(4, min(12, sd)))})",
        "- Include at least one short sentence (3-6 words) per paragraph",
        "- Use one complex sentence with a relative clause per paragraph",
        "- Avoid uniform sentence lengths; vary between short and long",
    ]
    words = [w.get("word") if isinstance(w, dict) else w for w in (style_json.get("top_words") or [])]
    words = [w for w in words if w][:topk]
    if words:
        lines.append("- Lexical neighbourhood of the target style (use naturally, never force): " + ", ".join(words))
    lines.append("Do not mention this guidance, and keep every fact, number and citation unchanged.")
    return "\n".join(lines)


def complete(prompt, temperature=1.0, top_p=0.95, n_predict=900, timeout=600):
    body = json.dumps({"prompt": prompt, "n_predict": n_predict, "temperature": temperature,
                       "top_p": top_p, "top_k": 0, "min_p": 0, "repeat_penalty": 1.0}).encode()
    req = urllib.request.Request(f"{APP}/api/completion", data=body,
                                 headers={"Content-Type": "application/json", "X-Humanizer": "1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    return " ".join(str(data.get("content") or "").split())


def build_prompt(text, guide=""):
    instr = INSTR + ("\n\n" + guide if guide else "")
    return instr + "\n\n" + text.strip() + SEP


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan-json", required=True)
    ap.add_argument("--guide-json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--units", type=int, default=99)
    ap.add_argument("--shred-rate", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--conditions", default="base,shred,guide,shred+guide")
    a = ap.parse_args()

    plan = json.load(open(a.plan_json, encoding="utf-8"))
    idx = list(plan["targets"].keys())[: a.units]
    units = [(" ".join(u["text"] for u in plan["targets"][i]["units"])) for i in idx]
    style = json.load(open(a.guide_json, encoding="utf-8"))
    guide = guidance(style)

    conditions = [
        ("base", "", False),
        ("shred", "", True),
        ("guide", guide, False),
        ("shred+guide", guide, True),
    ]

    out = {"conditions": {}, "units": len(units), "guide_chars": len(guide)}
    keep = {x.strip() for x in a.conditions.split(",") if x.strip()}
    for name, gd, do_shred in conditions:
        if name not in keep:
            continue
        gen_paras, per_unit = [], []
        t0 = time.time()
        for k, u in enumerate(units):
            src = u
            ops = 0
            if do_shred:
                src, st = shredder.shred(u, rate=a.shred_rate, seed=a.seed, verbose=False)
                ops = sum(st["ops"].values())
                if not shredder.preserves(u, src):
                    src = u
            txt = complete(build_prompt(src, gd))
            sc = stat_scorer.score(txt, light=True)
            try:
                tmr = DB.p_ai_gen(txt)
            except Exception:
                tmr = None
            per_unit.append({"unit": k, "shred_ops": ops, "gen": sc["stat_detectability"],
                             "tmr": tmr, "cv": sc["cv"], "words": sc["words"], "text": txt})
            gen_paras.append(txt)
            print(f"[{name}] unit {k+1}/{len(units)} gen={sc['stat_detectability']:.3f} cv={sc['cv']:.3f} ({len(txt.split())}w)", flush=True)
        doc = (chr(10) * 2).join(gen_paras)
        dsc = stat_scorer.score(doc, light=True)
        try:
            dsc["tmr"] = DB.p_ai_gen(doc)
        except Exception:
            dsc["tmr"] = None
        out["conditions"][name] = {
            "doc": dsc,
            "per_unit": [{k: v for k, v in u.items() if k != "text"} for u in per_unit],
            "texts": [u["text"] for u in per_unit],
            "elapsed_s": round(time.time() - t0, 1),
        }
        print(f"== {name}: doc gen={dsc['stat_detectability']:.3f} tmr={dsc.get('tmr')} cv={dsc['cv']:.3f} "
              f"ppl={dsc['ppl']:.1f} ent2={dsc['ent2']:.3f} reward={dsc['reward']:.4f}", flush=True)
        json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
