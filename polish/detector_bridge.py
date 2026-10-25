#!/usr/bin/env python3
"""detector_bridge.py — offline AI-likeness scoring for Workflow 6.0+.

Signals, all CPU, no cloud:
  perplexity   mean NLL under GPT-2 (124M). AI-polished text sits lower;
               humanizer output sits higher. Classic GPTZero-style feature.
  p_ai_gen     Oxidane/tmr-ai-text-detector (RoBERTa-base, RAID-trained).
               Probability the text is AI-generated. Index 1 = AI.
  p_ai_edit    adaptive-classifier/ai-detector (EditLens, ICLR 2026).
               Probability the text is AI-generated OR AI-edited.

8.14 token-level features (one GPT-2 forward pass serves all of them):
  mean_surprisal      mean token surprisal in nats (= log perplexity). Baseline.
  surprisal_entropy2  entropy of the discretized second-order differences of
                      the token surprisal sequence (DivEye). Models "rhythmic
                      unpredictability" — the evolution of predictability —
                      which mean perplexity cannot see.
  lrr                 DetectLLM Log-Rank Ratio: mean log of each token's rank
                      in the predicted vocabulary distribution. Lower = the
                      model keeps picking likely tokens = more AI-like.
  burstiness_cv       coefficient of variation of sentence lengths. Primary
                      signal in commercial detectors (Turnitin/GPTZero); our
                      9-point calibration: passing texts 0.54-0.69, pure AI
                      0.27-0.39.
  pattr               penalty-adjusted type-token ratio (lexical diversity,
                      length-corrected).
  ai_risk_score       provisional calibrated blend (CV-dominant per the 9-point
                      mapping): 0.55*cv_risk + 0.45*p_ai_gen. Recalibrate as
                      labelled points grow.

Long texts are split into <=512-token windows; each windowed score is the
token-weighted mean, so a 700-word essay is scored whole instead of silently
truncating.

Usage:
  python detector_bridge.py score text1.txt [text2.txt ...]     → JSON array
  python detector_bridge.py score -                              → stdin, one entry
"""
import sys, os, json, math, re

os.environ.setdefault("HF_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

import torch
torch.set_grad_enabled(False)
# The 12B llama-server shares this box; cap intra-op threads so BLAS does not
# fight it for cores (Qwen report: oversubscription is the top CPU pitfall).
torch.set_num_threads(max(2, min(4, os.cpu_count() or 4)))

import numpy as np

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


def gpt2_surprisal_features(text: str):
    """One GPT-2 sliding-window pass → {perplexity, mean_surprisal,
    surprisal_entropy2, lrr}. Token-level surprisal (and rank) of every
    predicted token; the aggregate perplexity is now a by-product."""
    if not text.strip():
        return None
    tok, model = _gpt2()
    enc = tok(text, return_tensors="pt")
    seq_len = enc.input_ids.size(1)
    if seq_len < 8:
        return None
    max_len = min(1024, model.config.n_positions)
    stride = 512
    surprisals, ranks = [], []
    prev_end = 0
    for begin in range(0, seq_len, stride):
        end = min(begin + max_len, seq_len)
        trg_len = end - prev_end
        ctx = enc.input_ids[:, begin:end]
        logits = model(ctx).logits                      # (1, L, V); logits[j] predicts token j+1
        logp = torch.log_softmax(logits[:, :-1], dim=-1)  # (1, L-1, V)
        tgt = enc.input_ids[0, begin + 1:end]           # predicted tokens
        tgt_logp = logp[0].gather(-1, tgt.unsqueeze(-1)).squeeze(-1)  # (L-1,)
        pos = torch.arange(begin + 1, end)
        mask = pos >= max(1, end - trg_len)             # first window: all; later: new region only
        sel_lp = tgt_logp[mask]
        if sel_lp.numel() == 0:
            prev_end = end
            if end == seq_len:
                break
            continue
        surprisals.extend((-sel_lp).tolist())
        # rank of the actual token among the full vocabulary (1 = most likely);
        # vectorized compare against the log-softmax row — no argsort needed
        row = logp[0][mask]                              # (n, V)
        ranks.extend(((row < sel_lp.unsqueeze(-1)).sum(-1) + 1).tolist())
        prev_end = end
        if end == seq_len:
            break
    if not surprisals:
        return None
    sur = np.asarray(surprisals, dtype=np.float64)
    rk = np.asarray(ranks, dtype=np.float64)
    mean_surprisal = float(sur.mean())
    perplexity = float(np.exp(mean_surprisal))
    d2 = np.diff(np.diff(sur))
    if d2.size >= 2:
        hist, _ = np.histogram(d2, bins=20, density=True)
        pd = hist[hist > 0]
        pd = pd / pd.sum() if pd.size else pd
        entropy2 = float(-(pd * np.log(pd)).sum()) if pd.size else 0.0
    else:
        entropy2 = 0.0
    lrr = float(np.log(np.clip(rk, 1, None)).mean())
    return {"perplexity": perplexity, "mean_surprisal": mean_surprisal,
            "surprisal_entropy2": entropy2, "lrr": lrr}


def perplexity(text: str):
    """Backward-compatible wrapper: mean-NLL perplexity under GPT-2."""
    r = gpt2_surprisal_features(text)
    return None if r is None else r["perplexity"]


_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")

def burstiness_cv(text: str):
    """Coefficient of variation of sentence lengths (burstiness). Primary
    signal in commercial detectors; our calibration: pure AI 0.27-0.39,
    passing 0.54-0.69."""
    sents = [s for s in _SENT_SPLIT.split(text) if s.strip()]
    lens = [len(s.split()) for s in sents]
    if len(lens) < 2:
        return 0.0
    m = float(np.mean(lens))
    return float(np.std(lens) / m) if m > 0 else 0.0


def pattr(text: str, target: int = 400, alpha: float = 0.01):
    """Penalty-adjusted type-token ratio (lexical diversity, length-corrected)."""
    toks = re.findall(r"[a-z']+", text.lower())
    n = len(toks)
    if n == 0:
        return 0.0
    ttr = len(set(toks)) / n
    denom = n + alpha * abs(n - target)
    return float(ttr * (n / denom))


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


def _cv_risk(cv: float) -> float:
    """CV → risk, piecewise-linear between the calibrated anchors
    (pure AI 0.275 → 0.98; passing 0.762 → 0.08); clamped outside."""
    if cv <= 0.275:
        return 0.98
    if cv >= 0.762:
        return 0.08
    return 0.98 + (cv - 0.275) * (0.08 - 0.98) / (0.762 - 0.275)


def score_text(text: str) -> dict:
    out = {"perplexity": None, "p_ai_gen": None, "p_ai_edit": None,
           "mean_surprisal": None, "surprisal_entropy2": None, "lrr": None,
           "burstiness_cv": None, "pattr": None, "ai_risk_score": None}
    for key, fn in (("gpt2_features", gpt2_surprisal_features), ("p_ai_gen", p_ai_gen), ("p_ai_edit", p_ai_edit)):
        try:
            r = fn(text)
            if key == "gpt2_features":
                if r:
                    out["perplexity"] = r["perplexity"]
                    out["mean_surprisal"] = r["mean_surprisal"]
                    out["surprisal_entropy2"] = r["surprisal_entropy2"]
                    out["lrr"] = r["lrr"]
            else:
                out[key] = r
        except Exception as e:
            print(f"detector_bridge: {key} failed: {type(e).__name__}: {e}", file=sys.stderr)
    try:
        out["burstiness_cv"] = burstiness_cv(text)
        out["pattr"] = pattr(text)
    except Exception as e:
        print(f"detector_bridge: text features failed: {type(e).__name__}: {e}", file=sys.stderr)
    out["words"] = len(text.split())
    # 8.14: provisional calibrated blend — CV-dominant per the 9-point mapping
    # (0.55/0.45), recalculate as labelled points grow. gen/edit stay raw.
    if out["burstiness_cv"] is not None and out["p_ai_gen"] is not None:
        out["ai_risk_score"] = round(0.55 * _cv_risk(out["burstiness_cv"]) + 0.45 * out["p_ai_gen"], 4)
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
