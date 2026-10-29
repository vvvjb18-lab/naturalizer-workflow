#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""register.py — four-feature register routing for 10.0 (no model, <5ms).

Separates "what kind of writing is this" from "how AI-ish is it".
gen/CV alone cannot tell a first-year reflective essay from a literature review
written with ChatGPT; both show gen>0.9 and CV<0.30.

Thresholds calibrated on documents with known outcomes (3/3 correct):

  highAI-0983 (98% AI, formal)   p1 0.00  nom 4.09  para 137  -> academic
  assault-0649 (8% AI, formal)   p1 0.22  nom 2.85  para 182  -> academic
  E2-oneclick82 (0% AI, essay)   p1 0.92  nom 4.43  para  60  -> academic
  PELIC sample (student)         p1 5.31  nom 2.46  para 101  -> student

Usage:
  python register.py <file.txt> [more.txt ...]
  python register.py --json <file.txt>
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

P1_RE = re.compile(r"\b(I|my|me|mine|we|our|us|ours)\b", re.I)
CITE_RE = re.compile(r"\([A-Z][A-Za-z&.,\s\-']{1,60},\s*\d{4}[a-z]?\)|\[\d+\]")
NUM_RE = re.compile(r"\b\d+(?:[.,]\d+)*%?\b")
NOM_RE = re.compile(r"\b\w{4,}(?:tion|sion|ment|ity|ance|ence)\b", re.I)
WORD_RE = re.compile(r"[A-Za-z']+")

# Thresholds (see module docstring for the calibration set).
P1_STUDENT = 2.0        # first-person density at or above this -> student
P1_ACADEMIC_MAX = 1.0   # below this AND (nominalisation or paragraph size) -> academic
NOM_ACADEMIC = 3.5
PARA_ACADEMIC = 120


def split_paras(text: str) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    if len(paras) < 2:
        paras = [p.strip() for p in text.split("\n") if p.strip()] or [text.strip()]
    return paras


def features(text: str) -> dict:
    paras = split_paras(text)
    words = WORD_RE.findall(text)
    nw = max(1, len(words))
    cites = len(CITE_RE.findall(text))
    nums = len(NUM_RE.findall(text))
    return {
        "words": nw,
        "paras": len(paras),
        "p1_rate": round(len(P1_RE.findall(text)) * 100 / nw, 2),
        "cite_num_rate": round((cites + nums) / max(1, len(paras)), 2),
        "nom_rate": round(len(NOM_RE.findall(text)) * 100 / nw, 2),
        "mean_para_words": round(nw / max(1, len(paras)), 1),
    }


def classify(f: dict) -> str:
    """Return 'student' | 'academic' | 'mixed'."""
    if f["p1_rate"] >= P1_STUDENT:
        return "student"
    if f["p1_rate"] < P1_ACADEMIC_MAX and (
            f["nom_rate"] >= NOM_ACADEMIC or f["mean_para_words"] >= PARA_ACADEMIC):
        return "academic"
    return "mixed"


def route_plan(f: dict) -> dict:
    """Candidate allocation for the parallel pool (see WORKFLOW-10.0 §2.3)."""
    reg = classify(f)
    if reg == "student":
        return {"register": reg, "path": "alpha",
                "candidates": {"routeb": 3, "routea": 2},
                "contractions": "keep", "register_surgery": "off"}
    if reg == "academic":
        return {"register": reg, "path": "beta",
                "candidates": {"routeb": 3, "routea": 1},
                "contractions": "expand", "register_surgery": "deterministic_only"}
    return {"register": reg, "path": "gamma",
            "candidates": {"routeb": 2, "routea": 3},
            "contractions": "expand", "register_surgery": "deterministic_only"}


def analyse(text: str) -> dict:
    f = features(text)
    plan = route_plan(f)
    return {**f, **plan}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    if not args:
        print(__doc__)
        return 2

    out = []
    for a in args:
        p = Path(a)
        if not p.exists():
            print(f"missing: {a}", file=sys.stderr)
            continue
        r = analyse(p.read_text(encoding="utf-8", errors="ignore"))
        r["file"] = p.name
        out.append(r)

    if as_json:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print(f"{'file':38s} {'p1':>5s} {'cite':>5s} {'nom':>5s} {'para':>5s}  {'register':9s} {'path'}")
        for r in out:
            print(f"{r['file'][:38]:38s} {r['p1_rate']:5.2f} {r['cite_num_rate']:5.2f} "
                  f"{r['nom_rate']:5.2f} {r['mean_para_words']:5.0f}  "
                  f"{r['register']:9s} {r['path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
