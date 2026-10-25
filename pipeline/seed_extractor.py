#!/usr/bin/env python3
"""seed_extractor.py — "human seed amplifier" (Workflow 8.16).

Turns a Whisper-style transcript of the client's own voice note into rhythm
proxies that can be injected into the rewrite prompt. This is the only
practical route for pure-AI, well-written documents where the local model has
no human rhythm to amplify (see WORKFLOW.md § bottleneck four).

Extracted features (all deterministic, regex + statistics, no models):
  sentence length      mean / sd / cv over transcript "sentences"
  fragmentation        ratio of segments without terminal punctuation
  self-repair          "I mean", "actually", "you know", "no wait", …
  spoken connectives   "so", "but", "and then", "like", "well", …
  hedge density        "maybe", "perhaps", "sort of", "kind of"
  first person         I / we / my frequency (narrative register signal)

Output JSON is the same shape the prompt injector consumes for corpus styles,
so `--style-guide seed.json` and `--seed note.txt` are interchangeable.

Usage:
  python seed_extractor.py transcript.txt [--out seed.json] [--json]
"""
import argparse
import json
import math
import re
import sys

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*")

SELF_REPAIR = [
    r"\bi mean\b", r"\bactually\b", r"\byou know\b", r"\bno wait\b",
    r"\bsorry\b", r"\brather\b", r"\bwhat i meant\b", r"\bscratch that\b",
    r"\bhold on\b", r"\bwell anyway\b",
]
CONNECTIVES = [
    r"\bso\b", r"\bbut\b", r"\band then\b", r"\blike\b", r"\bwell\b",
    r"\banyway\b", r"\bbasically\b", r"\bof course\b", r"\byeah\b",
]
HEDGES = [
    r"\bmaybe\b", r"\bperhaps\b", r"\bsort of\b", r"\bkind of\b",
    r"\bprobably\b", r"\bi guess\b", r"\bnot sure\b",
]
FILLERS = [r"\buh\b", r"\bum\b", r"\ber\b", r"\bmm\b", r"\bhmm\b"]


def _count(patterns, text):
    n = 0
    for p in patterns:
        n += len(re.findall(p, text, re.I))
    return n


def extract(transcript, per=100.0):
    text = transcript.replace("\r\n", "\n").strip()
    words = _WORD.findall(text)
    n_words = max(1, len(words))
    raw_sents = [s.strip() for s in _SENT_SPLIT.split(text) if s.strip()]
    lens, fragments = [], 0
    for s in raw_sents:
        w = len(_WORD.findall(s))
        if w == 0:
            continue
        lens.append(w)
        if not re.search(r"[.!?][\"')\]]?$", s):
            fragments += 1
    sents = len(lens) or 1
    mean = sum(lens) / sents if lens else 0.0
    var = sum((x - mean) ** 2 for x in lens) / sents if lens else 0.0
    sd = math.sqrt(var)

    def freq(patterns):
        return round(_count(patterns, text) * per / n_words, 2)

    feats = {
        "source": "seed-transcript",
        "transcript": {
            "words": n_words,
            "sentences": sents,
            "fragment_ratio": round(fragments / sents, 3),
        },
        "rhythm": {
            "sentences": sents,
            "words": n_words,
            "mean": round(mean, 2),
            "sd": round(sd, 2),
            "cv": round(sd / mean, 3) if mean else 0.0,
            "fragment_ratio": round(fragments / sents, 3),
            "short_ratio": round(sum(1 for x in lens if x <= 6) / sents, 3),
            "long_ratio": round(sum(1 for x in lens if x >= 28) / sents, 3),
        },
        "markers_per_100w": {
            "self_repair": freq(SELF_REPAIR),
            "spoken_connectives": freq(CONNECTIVES),
            "hedges": freq(HEDGES),
            "fillers": freq(FILLERS),
            "first_person": freq([r"\bi\b", r"\bwe\b", r"\bmy\b", r"\bour\b"]),
        },
        "top_words": [],          # seed carries rhythm, not lexical neighbours
        "vector": None,
        "svd": {"applied": False, "reason": "seed mode has no embedding model"},
        "corpus": {"docs": 1, "tokens": n_words, "known_ratio": None},
    }
    # A short, human-sounding target: keep the client's own rhythm band but
    # pull it toward prose (transcripts fragment far more than essays).
    r = feats["rhythm"]
    feats["guidance"] = {
        "target_mean": max(12.0, min(26.0, r["mean"])),
        "target_sd": max(4.0, min(12.0, r["sd"])),
        "short_quota": 1 if r["fragment_ratio"] < 0.5 else 1,
        "hedge_ok": feats["markers_per_100w"]["hedges"] > 1.5,
        "narrative": feats["markers_per_100w"]["first_person"] > 3.0,
    }
    return feats


def to_guidance_text(feats):
    """Same bullet format prompt_injector.mjs emits, for parity checks."""
    r = feats.get("rhythm", {})
    m = feats.get("markers_per_100w", {})
    mean = r.get("mean", 0)
    sd = r.get("sd", 0)
    lines = [
        "Style guidance: Write with the following rhythm characteristics:",
        f"- Average sentence length: {mean:.0f} words (±{sd:.0f})",
        "- Include at least one short sentence (3-6 words) per paragraph",
        "- Use one complex sentence with a relative clause per paragraph",
        "- Avoid uniform sentence lengths; vary between short and long",
    ]
    if m.get("hedges", 0) > 1.5:
        lines.append("- Allow occasional measured hedging (e.g. 'perhaps', 'it seems')")
    if m.get("self_repair", 0) > 0.5:
        lines.append("- Keep the thinking voice: small self-corrections are welcome, but no fillers")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Extract rhythm proxies from a voice transcript")
    ap.add_argument("transcript")
    ap.add_argument("--out", default=None)
    ap.add_argument("--text", action="store_true", help="print the prompt guidance text instead of JSON")
    a = ap.parse_args()
    raw = sys.stdin.read() if a.transcript == "-" else open(a.transcript, encoding="utf-8", errors="replace").read()
    feats = extract(raw)
    if a.text:
        print(to_guidance_text(feats))
        return
    payload = json.dumps(feats, ensure_ascii=False, indent=1)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(payload)
        print(f"wrote {a.out}", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
