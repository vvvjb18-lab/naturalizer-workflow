#!/usr/bin/env python3
"""stat_scorer.py — scalar "statistical detectability" scorer (Workflow 8.17).

A thin, MCTS-friendly facade over ``detector_bridge`` (the 8.14 rewrite).
It exposes exactly the two quantities the search needs:

  stat_detectability     higher = easier for a detector to recognise as AI
  distributional_penalty higher = rhythm statistics deviate from the human band
  reward                 = -(w1 * stat_detectability + w2 * distributional_penalty)

Fast mode (default) uses only the GPT-2 single-pass features plus the
sentence-length statistics (~0.8 s warm) so a whole MCTS iteration stays
inside the 2 s budget. ``--full`` adds tmr/EditLens (~2.1 s) for calibration
runs; both use the same scales.

Calibrated anchors (WORKFLOW.md, 9-point mapping):
  CV 0.275 → detectability ~0.98      CV 0.762 → ~0.08
  CV ≥ 0.54 passes regardless of gen  (measured 0-3 %)
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import detector_bridge as DB          # noqa: E402  (same directory)

# Calibration anchors, kept in one place so search and reporting agree.
TARGET_CV = 0.55          # middle of the passing band 0.54-0.69
CV_AI, CV_HUMAN = 0.275, 0.762
HUMAN_ENT2 = 2.4          # observed passing texts (E2 family)
W1, W2 = 0.6, 0.4


def _cv_risk(cv):
    if cv is None:
        return 0.5
    return float(DB._cv_risk(cv))


def _surprisal_risk(ent2):
    """DivEye: flatter second-order surprisal entropy reads more AI-like.
    Mapped softly — this term only breaks ties, CV dominates."""
    if ent2 is None:
        return 0.5
    lo, hi = 1.2, 2.8
    x = min(hi, max(lo, ent2))
    return float((hi - x) / (hi - lo))


def _gpt2_light(text):
    """Mean surprisal + perplexity from one GPT-2 pass, without the LRR rank
    tensor (~0.4 s vs ~0.8 s). Rhythm terms come from burstiness instead."""
    import torch
    tok, model = DB._gpt2()
    enc = tok(text, return_tensors="pt")
    n = enc.input_ids.size(1)
    if n < 8:
        return None
    max_len = min(1024, model.config.n_positions)
    stride = 512
    sur = []
    prev_end = 0
    for begin in range(0, n, stride):
        end = min(begin + max_len, n)
        trg = end - prev_end
        ctx = enc.input_ids[:, begin:end]
        logits = model(ctx).logits
        logp = torch.log_softmax(logits[:, :-1], dim=-1)
        tgt = enc.input_ids[0, begin + 1:end]
        sel = logp[0].gather(-1, tgt.unsqueeze(-1)).squeeze(-1)
        pos = torch.arange(begin + 1, end)
        mask = pos >= max(1, end - trg)
        sur.extend((-sel[mask]).tolist())
        prev_end = end
        if end == n:
            break
    if not sur:
        return None
    import numpy as np
    arr = np.asarray(sur, dtype="float64")
    d2 = np.diff(np.diff(arr))
    ent2 = 0.0
    if d2.size >= 2:
        hist, _ = np.histogram(d2, bins=20, density=True)
        pd = hist[hist > 0]
        pd = pd / pd.sum() if pd.size else pd
        ent2 = float(-(pd * np.log(pd)).sum()) if pd.size else 0.0
    return {"perplexity": float(np.exp(arr.mean())), "surprisal_entropy2": ent2}


def score(text, full=False, w1=W1, w2=W2, light=False):
    """Return the reward payload for one candidate text."""
    # 8.17.1: LRR measured at ~0 ms marginal cost (the forward pass dominates),
    # so light mode keeps the full feature set; only EditLens/tmr are skipped.
    feats = DB.gpt2_surprisal_features(text) or {}
    cv = DB.burstiness_cv(text)
    pattr = DB.pattr(text)
    ent2 = feats.get("surprisal_entropy2")
    ppl = feats.get("perplexity")

    stat = _cv_risk(cv) * 0.65 + _surprisal_risk(ent2) * 0.35
    # distributional penalty: distance from the calibrated human band
    shape_pen = min(1.0, abs(cv - TARGET_CV) / TARGET_CV)
    div_pen = 0.0 if pattr is None else min(1.0, max(0.0, (0.45 - pattr) / 0.45))
    penalty = 0.75 * shape_pen + 0.25 * div_pen

    out = {
        "stat_detectability": round(stat, 4),
        "distributional_penalty": round(penalty, 4),
        "reward": round(-(w1 * stat + w2 * penalty), 4),
        "cv": round(cv, 4),
        "pattr": round(pattr, 4),
        "ppl": round(ppl, 2) if ppl else None,
        "ent2": round(ent2, 4) if ent2 is not None else None,
        "lrr": round(feats["lrr"], 4) if feats.get("lrr") else None,
        "words": len(text.split()),
        "mode": "full" if full else ("light" if light else "fast"),
    }
    if full:
        try:
            m = DB._tmr()                       # noqa: SLF001 - intentional reuse
            import torch
            inputs = m[0](text, return_tensors="pt", truncation=True, max_length=512)
            probs = torch.softmax(m[1](**inputs).logits, dim=-1)[0]
            out["tmr"] = round(float(probs[1]), 4)
        except Exception:
            out["tmr"] = None
        try:
            out["editlens"] = round(float(DB.p_ai_edit(text) or 0.0), 4)
        except Exception:
            out["editlens"] = None
    return out


def main():
    ap = argparse.ArgumentParser(description="Scalar detectability + distributional penalty")
    ap.add_argument("path", nargs="?")
    ap.add_argument("--full", action="store_true", help="also run tmr/EditLens (~2 s)")
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    if a.test:
        sample = ("Physical stores require expenditure on rent, utilities and wages. "
                  "This raises operating costs but also creates immediate availability for customers. "
                  "E-commerce platforms avoid premises costs yet carry delivery and returns overhead.")
        print(json.dumps(score(sample), ensure_ascii=False))
        return
    if not a.path:
        ap.error("path required (or --test)")
    text = sys.stdin.read() if a.path == "-" else open(a.path, encoding="utf-8", errors="replace").read()
    print(json.dumps(score(text, full=a.full), ensure_ascii=False))


if __name__ == "__main__":
    main()
