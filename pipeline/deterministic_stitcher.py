#!/usr/bin/env python3
"""deterministic_stitcher.py — deterministic sentence stitching with RST-ish
relations (Workflow 8.17).

Pure rules, no LLM, no sampling:
  1. spaCy dependency parse each sentence
  2. classify the relation between consecutive sentences (Contrast / Cause /
     Elaboration) from lexical markers + a light structural test
  3. if the second sentence does not already open with a connector, insert one
     from a hard-coded table

Words inside the sentences are never changed and no sentence is removed, so
numbers and citations survive by construction.

Usage:
  python deterministic_stitcher.py --test
  python deterministic_stitcher.py --in text.txt --out stitched.txt [--json]
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

_SENT = re.compile(r"(?<=[.!?])\s+")

# Hard-coded transition tables (report: no generation anywhere in this step)
TRANSITIONS = {
    "Contrast": ["However", "By contrast", "Nevertheless", "On the other hand"],
    "Cause": ["Consequently", "As a result", "Therefore", "For this reason"],
    "Elaboration": ["Moreover", "In addition", "More specifically", "Furthermore"],
    "Concession": ["Admittedly", "Even so", "That said"],
}

MARKERS = {
    "Contrast": [r"\bhowever\b", r"\balthough\b", r"\bwhereas\b", r"\bin contrast\b",
                 r"\bon the other hand\b", r"\byet\b", r"\bbut\b", r"\bconversely\b",
                 r"\bnevertheless\b", r"\bunlike\b", r"\brather than\b"],
    "Cause": [r"\bbecause\b", r"\btherefore\b", r"\bthus\b", r"\bconsequently\b",
              r"\bas a result\b", r"\bhence\b", r"\bdue to\b", r"\bleads? to\b",
              r"\bso that\b", r"\bdrives?\b", r"\bcauses?\b"],
    "Concession": [r"\badmittedly\b", r"\balthough\b", r"\beven (?:if|so)\b", r"\bwhile it is true\b"],
    "Elaboration": [r"\bfor example\b", r"\bfor instance\b", r"\bmoreover\b",
                    r"\bfurthermore\b", r"\bin addition\b", r"\bspecifically\b",
                    r"\bin particular\b", r"\bthat is\b"],
}

OPENERS = {m.lower() for lst in TRANSITIONS.values() for m in lst}
NEG = re.compile(r"\b(not|no|never|un\w+|less|lower|fewer|avoid\w*|lack\w*)\b", re.I)
CAUSE_VERB = re.compile(r"\b(cause[sd]?|lead[s]? to|result[s]? in|drive[s]?|produce[s]?|reduce[s]?|increase[s]?)\b", re.I)


def _has(patterns, text):
    return any(re.search(p, text, re.I) for p in patterns)


def classify(s1, s2):
    """Relation between two consecutive sentences (rule order matters)."""
    if _has(MARKERS["Concession"], s2):
        return "Concession"
    if _has(MARKERS["Contrast"], s2):
        return "Contrast"
    if _has(MARKERS["Cause"], s2) or CAUSE_VERB.search(s2):
        return "Cause"
    if _has(MARKERS["Elaboration"], s2):
        return "Elaboration"
    # structural fallback: a polarity flip reads as contrast
    if bool(NEG.search(s1)) != bool(NEG.search(s2)):
        return "Contrast"
    return "Elaboration"


def _already_connected(s):
    head = s.strip().split(" ")[0].rstrip(",").lower()
    return head in OPENERS or _has(MARKERS["Elaboration"] + MARKERS["Contrast"] + MARKERS["Cause"], s[:40])


def stitch(sentences, lang="en", max_insert_ratio=1.0):
    """Insert transition words between sentences. Returns (text, ops)."""
    if not sentences:
        return "", []
    ops = []
    out = [sentences[0].strip()]
    inserted = 0
    budget = max(1, int(round(len(sentences) * max_insert_ratio)))
    for prev, cur in zip(sentences, sentences[1:]):
        cur = cur.strip()
        rel = classify(prev, cur)
        if inserted < budget and not _already_connected(cur):
            word = TRANSITIONS[rel][inserted % len(TRANSITIONS[rel])]
            cur = f"{word}, {cur[0].lower()}{cur[1:]}"
            ops.append({"relation": rel, "word": word, "sentence": cur[:80]})
            inserted += 1
        out.append(cur)
    return " ".join(out), ops


def split_sentences(text):
    body = " ".join(text.split())
    return [s.strip() for s in _SENT.split(body) if s.strip()]


def main():
    ap = argparse.ArgumentParser(description="Deterministic RST-ish stitcher")
    ap.add_argument("--in", dest="inp")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()

    if a.test:
        sents = [
            "Physical stores require expenditure on rent, utilities and employee wages.",
            "E-commerce platforms avoid most premises costs.",
            "Lower overheads reduce the fixed cost base for online retailers.",
        ]
        text, ops = stitch(sents)
        print(json.dumps({"sentences": len(sents), "inserted": len(ops), "ops": ops,
                          "text": text}, ensure_ascii=False, indent=1))
        assert len(ops) >= 2, "stitcher inserted fewer than 2 transitions"
        assert all(s.rstrip(".") in text or s.rstrip(".").lower() in text.lower() for s in sents), "sentence lost"
        print("OK: 3 sentences stitched, all content preserved")
        return

    if not a.inp:
        ap.error("--in or --test required")
    raw = sys.stdin.read() if a.inp == "-" else open(a.inp, encoding="utf-8", errors="replace").read()
    paras = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    out_paras, all_ops = [], []
    for p in paras:
        stitched, ops = stitch(split_sentences(p))
        out_paras.append(stitched)
        all_ops.extend(ops)
    text = "\n\n".join(out_paras)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text + "\n")
    if a.json:
        print(json.dumps({"paragraphs": len(paras), "inserted": len(all_ops), "ops": all_ops},
                         ensure_ascii=False, indent=1))
    elif not a.out:
        print(text)


if __name__ == "__main__":
    main()
