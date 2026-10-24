#!/usr/bin/env python3
"""detector_bridge.py — offline AI-likeness scoring for Workflow 6.0.

Three independent signals, all CPU, no cloud:
  perplexity  mean NLL under GPT-2 (124M). AI-polished text sits lower;
              humanizer output sits higher. Classic GPTZero-style feature.
  p_ai_gen    Oxidane/tmr-ai-text-detector (RoBERTa-base, RAID-trained).
              Probability the text is AI-generated. Index 1 = AI.
  p_ai_edit   adaptive-classifier/ai-detector (EditLens, ICLR 2026).
              Probability the text is AI-generated OR AI-edited.

Long texts are split into <=512-token windows; each detector's score is the
token-weighted mean over windows, so a 700-word essay is scored whole instead
of silently truncating.

Usage:
  python detector_bridge.py score text1.txt [text2.txt ...]     → JSON array
  python detector_bridge.py score -                              → stdin, one entry
"""
import sys, os, json, math

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

import torch
torch.set_grad_enabled(False)

_MODELS = {}

def _gpt2():
    if "gpt2" not in _MODELS:
        from transformers import AutoTokenizer, AutoModelForCausalLM
        tok = AutoTokenizer.from_pretrained("gpt2")
        tok.pad_token = tok.eos_token
        model = AutoModelForCausalLM.from_pretrained("gpt2")
        model.eval()
        _MODELS["gpt2"] = (tok, model)
    return _MODELS["gpt2"]

def _tmr():
    if "tmr" not in _MODELS:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        tok = AutoTokenizer.from_pretrained("Oxidane/tmr-ai-text-detector")
        model = AutoModelForSequenceClassification.from_pretrained("Oxidane/tmr-ai-text-detector")
        model.eval()
        _MODELS["tmr"] = (tok, model)
    return _MODELS["tmr"]

def _editlens():
    if "editlens" not in _MODELS:
        from adaptive_classifier import AdaptiveClassifier
        _MODELS["editlens"] = AdaptiveClassifier.from_pretrained("adaptive-classifier/ai-detector")
    return _MODELS["editlens"]


def perplexity(text: str):
    """Mean-NLL perplexity under GPT-2 with the standard sliding-window recipe."""
    if not text.strip():
        return None
    tok, model = _gpt2()
    enc = tok(text, return_tensors="pt")
    seq_len = enc.input_ids.size(1)
    if seq_len < 2:
        return None
    max_len = min(1024, model.config.n_positions)
    stride = 512
    nlls, n_tok = [], 0
    prev_end = 0
    for begin in range(0, seq_len, stride):
        end = min(begin + max_len, seq_len)
        trg_len = end - prev_end
        ids = enc.input_ids[:, begin:end]
        target = ids.clone()
        if trg_len < target.size(1):
            target[:, :-trg_len] = -100
        out = model(ids, labels=target)
        n = int((target != -100).sum())
        nlls.append(float(out.loss) * n)
        n_tok += n
        prev_end = end
        if end == seq_len:
            break
    return math.exp(sum(nlls) / max(1, n_tok))


def _windows(text: str, tok, limit: int = 512):
    """Split into <=limit-token windows; returns (list_of_texts, token_weights)."""
    if not text.strip():
        return [], []
    out, weights = [], []
    paras = [p for p in text.split("\n") if p.strip()]
    buf, buf_ids = [], []
    for p in paras:
        p_ids = tok(p, add_special_tokens=False).input_ids
        if buf_ids and len(buf_ids) + len(p_ids) + 2 > limit:
            out.append(" ".join(buf)); weights.append(len(buf_ids))
            buf, buf_ids = [], []
        buf.append(p.strip()); buf_ids.extend(p_ids)
    if buf_ids:
        out.append(" ".join(buf)); weights.append(len(buf_ids))
    return out, weights


def p_ai_gen(text: str):
    tok, model = _tmr()
    wins, weights = _windows(text, tok)
    if not wins:
        return None
    probs = []
    for w in wins:
        inputs = tok(w, return_tensors="pt", truncation=True, max_length=512)
        logits = model(**inputs).logits
        p = torch.softmax(logits, dim=-1)[0]
        probs.append(float(p[1]))          # index 1 = AI-generated
    total = sum(weights)
    return sum(p * wt for p, wt in zip(probs, weights)) / max(1, total)


def p_ai_edit(text: str):
    clf = _editlens()
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained("Oxidane/tmr-ai-text-detector")  # any 512-token tokenizer works for splitting
    wins, weights = _windows(text, tok)
    if not wins:
        return None
    probs = []
    for w in wins:
        try:
            pred = clf.predict(w)
            d = {label: p for label, p in pred}
            probs.append(float(d.get("ai", 0.0)))
        except Exception:
            weights = weights[:len(probs)] + weights[len(probs) + 1:]  # drop unmatched weight
    if not probs:
        return None
    total = sum(weights[:len(probs)])
    return sum(p * wt for p, wt in zip(probs, weights[:len(probs)])) / max(1, total)


def score_text(text: str) -> dict:
    out = {"perplexity": None, "p_ai_gen": None, "p_ai_edit": None}
    for key, fn in (("perplexity", perplexity), ("p_ai_gen", p_ai_gen), ("p_ai_edit", p_ai_edit)):
        try:
            out[key] = fn(text)
        except Exception as e:
            print(f"detector_bridge: {key} failed: {type(e).__name__}: {e}", file=sys.stderr)
    out["words"] = len(text.split())
    return out


def _cola():
    """CoLA grammatical-acceptability classifier. Returns (tok, model, ok_index)."""
    if "cola" not in _MODELS:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        MID = "textattack/roberta-base-CoLA"
        tok = AutoTokenizer.from_pretrained(MID)
        model = AutoModelForSequenceClassification.from_pretrained(MID)
        model.eval()
        # Work out which softmax index means "acceptable": GLUE CoLA uses 1,
        # but verify with a known pair so a different fine-tune cannot silently invert it.
        def p1(s):
            import torch as _t
            ii = tok(s, return_tensors="pt", truncation=True, max_length=256)
            return float(torch.softmax(model(**ii).logits, dim=-1)[0][1])
        good = p1("He has always gone to school by bus.")
        bad = p1("He have always go to school by bus yesterday.")
        ok_index = 1 if good >= bad else 0
        _MODELS["cola"] = (tok, model, ok_index)
    return _MODELS["cola"]


def gram_list(sents):
    """[{i, p_gram}] for a list of sentences."""
    tok, model, ok_index = _cola()
    out = []
    for i, s in enumerate(sents):
        ii = tok(s, return_tensors="pt", truncation=True, max_length=256)
        p = torch.softmax(model(**ii).logits, dim=-1)[0]
        out.append({"i": i, "p_gram": float(p[ok_index])})
    return out


def cmd_gram(path):
    """One sentence per line -> JSON [{i, p_gram}]."""
    sents = [l.rstrip("\n") for l in open(path, encoding="utf-8") if l.strip()]
    print(json.dumps(gram_list(sents), ensure_ascii=False))


def _nli():
    """Small NLI cross-encoder. Returns (tok, model, label_order)."""
    if "nli" not in _MODELS:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        MID = "cross-encoder/nli-deberta-v3-xsmall"
        tok = AutoTokenizer.from_pretrained(MID)
        model = AutoModelForSequenceClassification.from_pretrained(MID)
        model.eval()
        _MODELS["nli"] = (tok, model, list(model.config.id2label.values()))
    return _MODELS["nli"]


def nli_list(pairs):
    """[{i, entail, contradict}] for [(premise, hypothesis), ...]."""
    tok, model, labels = _nli()
    def idx(name):
        for i, l in enumerate(labels):
            if name in l.lower():
                return i
        return None
    e_i, c_i = idx("entail"), idx("contradict")
    out = []
    for i, (prem, hyp) in enumerate(pairs):
        ii = tok(prem, hyp, return_tensors="pt", truncation=True, max_length=512)
        p = torch.softmax(model(**ii).logits, dim=-1)[0]
        out.append({
            "i": i,
            "entail": float(p[e_i]) if e_i is not None else None,
            "contradict": float(p[c_i]) if c_i is not None else None,
        })
    return out


def cmd_nli(path):
    """TSV pairs -> JSON."""
    pairs = [l.rstrip("\n").split("\t", 1) for l in open(path, encoding="utf-8") if l.strip() and "\t" in l]
    print(json.dumps(nli_list(pairs), ensure_ascii=False))


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "score":
        paths = sys.argv[2:]
        results = []
        for p in paths:
            if p == "-":
                text = sys.stdin.read()
                name = "stdin"
            else:
                text = open(p, encoding="utf-8", errors="replace").read()
                name = p
            r = score_text(text)
            r["file"] = name
            results.append(r)
        print(json.dumps(results, ensure_ascii=False))
    elif len(sys.argv) == 3 and sys.argv[1] == "gram":
        cmd_gram(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "nli":
        cmd_nli(sys.argv[2])
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
