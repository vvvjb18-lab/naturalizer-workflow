#!/usr/bin/env python3
"""shredder.py — Deterministic Distribution Shredder (Workflow 8.15).

A CPU-only, non-generative preprocessing stage that runs BEFORE candidate
generation. It reshapes the syntax of AI text into a noisier, structurally
human skeleton, so the local LLM rewrites a less-constrained frame instead of
re-sampling its own distribution.

Operations (dependency-tree driven, spaCy en_core_web_sm, no neural models):
  voice    active -> passive   (VERB with nsubj AND dobj, simple clause only)
  split    long sentence -> two (needs >35 words AND a coordinating 'cc',
           or >35 words AND a ';')
  merge    two adjacent short sentences -> one (both <8 words, shared subject)
  reorder  adjunct reordering: fronted adverbial -> post-subject
           parenthetical, or trailing PP -> sentence-initial

Guards:
  - at most one structural operation per sentence; per-sentence probability
    gate (default 0.45) seeded from the document hash → reproducible
  - numbers and (Author, Year) citations must survive verbatim inside a
    sentence, otherwise the transformation is reverted
  - no synonym replacement, no sentence deletion, no paragraph reordering,
    no network / LLM calls, no neural models beyond spaCy's small pipeline

Usage:
  python shredder.py input.txt [out.txt] [--rate 0.45] [--seed 0]
                               [--stats-json stats.json] [--quiet]
"""
import sys, os, re, json, random, hashlib
import argparse


# ── spaCy loading ──────────────────────────────────────────────────────────
def _load_nlp():
    """Load en_core_web_sm, tolerating the Python 3.13 tokenizer-bytes bug.

    On CPython 3.13 loading the packaged tokenizer raises
    `OverflowError: Python int too large to convert to C ssize_t`.
    The parser/tagger/lemmatizer are fine, so we retry with the tokenizer
    excluded: spaCy then builds its standard English tokenizer from the model
    config. Tokenisation quality is unchanged for ordinary prose.
    """
    import spacy
    try:
        return spacy.load("en_core_web_sm", disable=["ner"])
    except Exception:
        pass
    try:
        import en_core_web_sm as _pkg
        base = os.path.dirname(_pkg.__file__)
        cand = [os.path.join(base, d) for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
        for c in cand:
            if os.path.isfile(os.path.join(c, "config.cfg")):
                return spacy.load(c, exclude=["tokenizer"], disable=["ner"])
        if os.path.isfile(os.path.join(base, "config.cfg")):
            return spacy.load(base, exclude=["tokenizer"], disable=["ner"])
    except Exception:
        pass
    raise RuntimeError(
        "spaCy / en_core_web_sm unavailable. Install with:\n"
        "  pip install spacy && python -m spacy download en_core_web_sm"
    )


_NLP = None
def nlp():
    global _NLP
    if _NLP is None:
        _NLP = _load_nlp()
    return _NLP


# ── fact preservation ──────────────────────────────────────────────────────
_NUM = re.compile(r"\d+(?:[.,]\d+)*%?")
_CITE = re.compile(r"\([^()]{0,120}?\b(?:19|20)\d{2}[a-z]?[^()]*\)")

def facts(text):
    """Numbers and parenthetical citations that must survive verbatim."""
    return set(_NUM.findall(text)) | set(_CITE.findall(text))

def preserves(before, after):
    return facts(before) <= facts(after)


# ── verb → past participle ─────────────────────────────────────────────────
_IRREGULAR_VBN = {
    "be": "been", "begin": "begun", "become": "become", "break": "broken",
    "bring": "brought", "build": "built", "buy": "bought", "catch": "caught",
    "choose": "chosen", "come": "come", "cost": "cost", "cut": "cut",
    "deal": "dealt", "do": "done", "draw": "drawn", "drive": "driven",
    "eat": "eaten", "fall": "fallen", "feel": "felt", "fight": "fought",
    "find": "found", "get": "got", "give": "given", "go": "gone",
    "grow": "grown", "have": "had", "hold": "held", "keep": "kept",
    "know": "known", "lead": "led", "leave": "left", "lend": "lent",
    "lie": "lain", "lose": "lost", "make": "made", "mean": "meant",
    "meet": "met", "pay": "paid", "put": "put", "read": "read",
    "rise": "risen", "run": "run", "say": "said", "see": "seen",
    "seek": "sought", "sell": "sold", "send": "sent", "set": "set",
    "show": "shown", "sit": "sat", "speak": "spoken", "spend": "spent",
    "stand": "stood", "take": "taken", "teach": "taught", "tell": "told",
    "think": "thought", "understand": "understood", "win": "won",
    "write": "written", "bear": "borne", "beat": "beaten", "bend": "bent",
    "bind": "bound", "bite": "bitten", "blow": "blown", "breed": "bred",
    "burn": "burnt", "cast": "cast", "creep": "crept", "dig": "dug",
    "drink": "drunk", "feed": "fed", "flee": "fled", "fly": "flown",
    "forbid": "forbidden", "forget": "forgotten", "freeze": "frozen",
    "hide": "hidden", "hit": "hit", "hurt": "hurt", "let": "let",
    "ride": "ridden", "ring": "rung", "shake": "shaken", "shoot": "shot",
    "shut": "shut", "sing": "sung", "sink": "sunk", "sleep": "slept",
    "slide": "slid", "spin": "spun", "split": "split", "spread": "spread",
    "spring": "sprung", "steal": "stolen", "stick": "stuck", "sting": "stung",
    "strike": "struck", "swear": "sworn", "sweep": "swept", "swim": "swum",
    "swing": "swung", "tear": "torn", "throw": "thrown", "wake": "woken",
    "wear": "worn", "weep": "wept", "wind": "wound",
}
_VOWELS = set("aeiou")

def to_vbn(lemma, tag, text):
    """Deterministic past participle. Returns None when unsure."""
    if tag == "VBN":
        return text.lower()
    lem = (lemma or "").lower()
    if lem in _IRREGULAR_VBN:
        return _IRREGULAR_VBN[lem]
    if not lem.isalpha():
        return None
    if lem.endswith("e"):
        return lem + "d"
    if lem.endswith("y") and len(lem) > 2 and lem[-2] not in _VOWELS:
        return lem[:-1] + "ied"
    if lem.endswith("c"):
        return lem + "ked"
    # CVC doubling only for <=4-letter stems: plan→planned, stop→stopped,
    # but offer→offered (doubling two-syllable stems is wrong).
    if 3 <= len(lem) <= 4 and lem[-1] not in _VOWELS and lem[-2] in _VOWELS and lem[-3] not in _VOWELS:
        return lem + lem[-1] + "ed"
    return lem + "ed"


def is_plural(tok):
    try:
        if "Plur" in tok.morph.get("Number"):
            return True
    except Exception:
        pass
    return tok.tag_ == "NNS"


def span_text(sent, left, right):
    a = left.idx - sent.start_char
    b = right.idx - sent.start_char + len(right.text)
    return sent.text[a:b]


# ── operation 1: voice inversion ───────────────────────────────────────────
_CLAUSE_BLOCKERS = {"ccomp", "xcomp", "relcl", "advcl", "csubj", "parataxis"}
_AUX_OK = {"should", "will", "can", "must", "may", "could", "would", "might",
           "has", "have", "had", "is", "are", "was", "were"}
_AUX_BLOCK = {"be", "being"}
# Stative / relational verbs: their passive is unnatural or meaning-changing
# ("X concerns Y" -> "Y is concerned by X" is wrong), so they are never inverted.
_VERB_BLOCK = {"concern", "involve", "include", "comprise", "contain", "feature",
               "possess", "lack", "resemble", "equal", "mean", "represent",
               "entail", "consist", "depend", "reflect", "seem", "appear",
               "become", "remain", "exist", "occur", "happen", "belong",
               "matter", "differ", "correspond"}

def try_voice(sent):
    """Active → passive for a simple main clause. Returns text or None."""
    if sent.text.count('"') or sent.text.count("\u201c") or sent.text.count("\u201d"):
        return None
    if sent.text.rstrip().endswith("?"):
        return None
    for v in sent:
        if v.pos_ not in ("VERB", "AUX") or v.dep_ != "ROOT":
            continue
        kids = list(v.children)
        if any(c.dep_ == "neg" for c in kids):
            continue
        subj = [c for c in kids if c.dep_ in ("nsubj", "nsubjpass")]
        obj = [c for c in kids if c.dep_ in ("dobj", "obj")]
        if len(subj) != 1 or len(obj) != 1:
            continue
        s, o = subj[0], obj[0]
        if any(c.dep_ in _CLAUSE_BLOCKERS for c in s.subtree):
            return None
        if any(c.dep_ in _CLAUSE_BLOCKERS for c in o.subtree):
            return None
        if not (s.i < v.i < o.i):
            return None
        n_sub = len(list(s.subtree)); n_obj = len(list(o.subtree))
        if n_sub > 8 or n_obj > 10:
            return None
        if s.text.lower() in ("there", "it") and s.pos_ == "PRON":
            return None
        auxes = [c for c in kids if c.dep_ in ("aux", "auxpass")]
        if any(a.lemma_.lower() in _AUX_BLOCK for a in auxes):
            return None
        if any(a.tag_ == "VBG" for a in auxes):          # progressive: skip
            return None
        for a in auxes:
            if a.lemma_.lower() not in _AUX_OK:
                return None
        if v.lemma_.lower() in _VERB_BLOCK:
            return None
        vbn = to_vbn(v.lemma_, v.tag_, v.text)
        if not vbn:
            return None
        # build passive verb phrase
        if auxes:
            aux_order = sorted(auxes, key=lambda c: c.i)
            aux_txt = " ".join(a.text for a in aux_order)
            if any(a.lemma_.lower() in ("has", "have", "had") for a in aux_order):
                vp = f"{aux_txt} been {vbn}"
            else:
                vp = f"{aux_txt} be {vbn}"
        else:
            plural = is_plural(o)
            if v.tag_ == "VBD":
                vp = ("were " if plural else "was ") + vbn
            else:
                vp = ("are " if plural else "is ") + vbn
        front = sent.text[: s.left_edge.idx - sent.start_char].strip()
        subj_txt = span_text(sent, s.left_edge, s.right_edge)
        obj_txt = span_text(sent, o.left_edge, o.right_edge)
        tail_toks = [t for t in sent if t.i > o.right_edge.i]
        tail = span_text(sent, tail_toks[0], tail_toks[-1]).strip() if tail_toks else ""
        _DET_LOWER = {"this", "these", "that", "those", "a", "an", "the", "its",
                      "their", "his", "her", "our", "my", "each", "every",
                      "some", "many", "most", "such", "both", "all"}
        first_subj_word = subj_txt.split()[0] if subj_txt.split() else ""
        if first_subj_word[:1].isupper():
            lowerok = first_subj_word.lower() in _DET_LOWER
            if not lowerok and s.left_edge.i == sent.start and s.left_edge.pos_ in ("NOUN", "ADJ", "NUM", "VERB"):
                lowerok = True      # sentence-initial common word, capital is positional only
            if lowerok:
                subj_txt = first_subj_word.lower() + subj_txt[len(first_subj_word):]
        pieces = []
        if front:
            pieces.append(front.rstrip(",").strip() + ",")
        pieces.append(f"{obj_txt} {vp} by {subj_txt}")
        core = " ".join(pieces)
        if tail:
            if tail[0] in ",.;:)]":
                core += tail
            else:
                core += " " + tail
        else:
            core = core.rstrip() + "."
        core = re.sub(r"\s+", " ", core).strip()
        if core:
            core = core[0].upper() + core[1:]
        if re.search(r"(the|a|an|of|to|in|on|for|by)\s*,", core, re.I):
            return None
        if re.search(r"[.,;:]{2,}", core):
            return None
        return core
    return None


# ── operation 2: long-sentence split ───────────────────────────────────────
_LINKERS = {"and": "", "but": "However, ", "so": "As a result, ",
            "or": "Alternatively, ", "yet": "Even so, ", "for": "For this reason, "}

def try_split(sent, min_words=36, min_side=6):
    words = len([t for t in sent if not t.is_punct or t.text in ("-",)])
    if words < min_words:
        return None
    text = sent.text.rstrip()
    # prefer a coordinating conjunction attached to the root verb
    cands = [t for t in sent if t.dep_ == "cc" and t.text.lower() in _LINKERS]
    if not cands:
        semis = [t for t in sent if t.text == ";"]
        if semis:
            cut = semis[0]
            left = text[: cut.idx - sent.start_char].strip().rstrip(",")
            right = text[cut.idx - sent.start_char + 1:].strip()
            if len(left.split()) >= min_side and len(right.split()) >= min_side:
                right = right[0].upper() + right[1:]
                if left and left[-1] not in ".!?":
                    left += "."
                return f"{left} {right}"
        return None
    if not cands:
        # "…or punct": split at a comma where BOTH halves carry a finite verb
        # (parse-verified clause boundary — no fragments by construction).
        FINITE = {"VBP", "VBZ", "VBD", "MD", "VB"}
        for comma in [x for x in sent if x.text == ","]:
            left_toks = [x for x in sent if x.i < comma.i]
            right_toks = [x for x in sent if x.i > comma.i]
            if len(left_toks) < 8 or len(right_toks) < 8:
                continue
            if not any(x.pos_ in ("VERB", "AUX") and x.tag_ in FINITE for x in left_toks):
                continue
            if not any(x.pos_ in ("VERB", "AUX") and x.tag_ in FINITE for x in right_toks):
                continue
            left = text[: comma.idx - sent.start_char].strip().rstrip(",")
            right = text[comma.idx - sent.start_char + 1:].strip()
            if left[-1:] not in ".!?":
                left += "."
            right = right[0].upper() + right[1:]
            return f"{left} {right}"
        return None
    best = None
    for cc in cands:
        left = text[: cc.idx - sent.start_char].strip().rstrip(",")
        right = text[cc.idx - sent.start_char + len(cc.text):].strip()
        lw, rw = len(left.split()), len(right.split())
        if lw < min_side or rw < min_side:
            continue
        score = abs(lw - rw)
        if best is None or score < best[0]:
            best = (score, cc, left, right)
    if not best:
        return None
    _, cc, left, right = best
    linker = _LINKERS.get(cc.text.lower(), "")
    if not linker:
        right = right[0].upper() + right[1:]
    else:
        right = linker + right[0].lower() + right[1:]
    if left and left[-1] not in ".!?":
        left += "."
    return f"{left} {right}"


# ── operation 3: adjacent short-sentence merge ─────────────────────────────
def subject_lemma(sent):
    for t in sent:
        if t.dep_ in ("nsubj", "nsubjpass"):
            return t.lemma_.lower()
    return None

def try_merge(s1, s2, max_words=8):
    if len(s1.text.split()) >= max_words or len(s2.text.split()) >= max_words:
        return None
    t1, t2 = s1.text.strip(), s2.text.strip()
    if not t1.endswith(".") or t2.rstrip().endswith(".") is False:
        return None
    if t1.endswith("?") or t1.endswith("!") or t2.endswith("?") or t2.endswith("!"):
        return None
    subj1, subj2 = subject_lemma(s1), subject_lemma(s2)
    if not subj1 or subj1 != subj2:
        return None
    first2 = next((t for t in s2 if t.is_alpha), None)
    if first2 is not None and (first2.pos_ == "PROPN" or first2.is_title):
        return None
    cut = t1.rstrip()
    if cut.endswith("."):
        cut = cut[:-1]
    merged = f"{cut}; {t2[0].lower()}{t2[1:]}"
    return merged


# ── operation 4: adjunct reordering ────────────────────────────────────────
_FRONT_OK = {"advmod", "npadvmod", "prep"}

def try_reorder(sent, min_words=10):
    if len(sent.text.split()) < min_words:
        return None
    text = sent.text.rstrip()
    if text.endswith("?"):
        return None
    root = next((t for t in sent if t.dep_ == "ROOT"), None)
    if root is None:
        return None
    # (a) fronted adverbial → move behind the subject as a parenthetical
    for t in list(sent)[:2]:
        if t.dep_ in _FRONT_OK and t.head == root and not any(
            c.dep_ in ("nsubj", "nsubjpass") for c in t.subtree
        ):
            adv_span = t.subtree
            adv_txt = span_text(sent, t.left_edge, t.right_edge).strip().rstrip(",")
            # single-word adverbials only: "In conclusion, …" must not become
            # a mid-sentence parenthetical with a capital letter.
            if len(list(t.subtree)) != 1 or t.pos_ not in ("ADV", "SCONJ"):
                break
            subj = next((c for c in root.children if c.dep_ in ("nsubj", "nsubjpass")), None)
            if subj is None or subj.i < t.right_edge.i:
                break
            rest = sent.text[t.right_edge.idx - sent.start_char + len(t.right_edge.text):].strip()
            if rest.startswith(","):
                rest = rest[1:].strip()
            subj_txt = span_text(sent, subj.left_edge, subj.right_edge)
            pos = rest.find(subj_txt)
            if pos < 0:
                break
            after = rest[: pos + len(subj_txt)].rstrip()
            tail = rest[pos + len(subj_txt):]
            # parenthetical form: "Subject, adverb, predicate" — both commas.
            after_cap = after[0].upper() + after[1:]
            adv_mid = adv_txt[0].lower() + adv_txt[1:] if not adv_txt.isupper() else adv_txt
            tail_l = tail if (not tail or tail.startswith((",", ".", ";"))) else " " + tail.lstrip()
            new = f"{after_cap}, {adv_mid},{tail_l}"
            return re.sub(r"\s+", " ", new).strip()
    # (b) trailing PP adjunct → sentence-initial
    preps = [t for t in sent if t.dep_ == "prep" and t.head == root]
    for p in reversed(preps):
        subtree = list(p.subtree)
        if not (2 <= len(subtree) <= 7):
            continue
        p_txt = span_text(sent, p.left_edge, p.right_edge).strip().rstrip(",")
        rest = text[: p.left_edge.idx - sent.start_char].strip().rstrip(",")
        if len(rest.split()) < 6:
            continue
        if rest[-1:] in ".!?":
            rest = rest[:-1]
        new = f"{p_txt[0].upper()}{p_txt[1:]}, {rest[0].lower()}{rest[1:]}."
        return re.sub(r"\s+", " ", new).strip()
    return None


# ── driver ─────────────────────────────────────────────────────────────────
def sentence_lengths(texts):
    lens = []
    for t in texts:
        for s in re.split(r"(?<=[.!?])\s+", t.strip()):
            if s.strip():
                lens.append(len(s.split()))
    if not lens:
        return 0.0, 0.0, 0.0
    m = sum(lens) / len(lens)
    var = sum((x - m) ** 2 for x in lens) / len(lens)
    sd = var ** 0.5
    return m, sd, (sd / m if m else 0.0)


def shred(text, rate=0.50, seed=None, verbose=True):
    paragraphs = re.split(r"\n\s*\n", text.replace("\r\n", "\n"))
    paragraphs = [p.strip() for p in paragraphs]
    docs = list(nlp().pipe(paragraphs, batch_size=8))
    rng = random.Random(seed if seed is not None else int(hashlib.sha256(text.encode()).hexdigest()[:12], 16))
    stats = {"sentences": 0, "changed": 0, "reverted": 0,
             "ops": {"voice": 0, "split": 0, "merge": 0, "reorder": 0}}
    out_paras = []
    in_refs = False
    REF = re.compile(r"^(references?|works cited|bibliography|參考文獻)\s*:?\s*$", re.I)
    for para, doc in zip(paragraphs, docs):
        if not para:
            out_paras.append("")
            continue
        if REF.match(para):
            in_refs = True
        heading = len(para.split()) <= 12 and not re.search(r"[.!?]\s*$", para)
        if in_refs or heading:      # never perturb bibliographies or headings
            out_paras.append(para)
            continue
        sents = list(doc.sents)
        stats["sentences"] += len(sents)
        texts = [s.text.strip() for s in sents]
        changed = [False] * len(texts)
        # pass 1 — per-sentence operations, at most one each
        for i, s in enumerate(sents):
            if rng.random() > rate:
                continue
            before = texts[i]
            got = None
            for name, fn in (("voice", try_voice), ("split", try_split), ("reorder", try_reorder)):
                cand = fn(s)
                if cand and cand != before and preserves(before, cand):
                    got = (name, cand)
                    break
            if got:
                stats["ops"][got[0]] += 1
                texts[i] = got[1]
                changed[i] = True
            elif rng.random() < rate:      # count attempted-but-rejected guards
                pass
        # pass 2 — adjacent short-sentence merges (one op per pair)
        merged_texts, merged_flags = [], []
        i = 0
        while i < len(texts):
            if i + 1 < len(texts) and not changed[i] and not changed[i + 1]:
                if i + 1 < len(sents) and rng.random() <= rate:
                    m = try_merge(sents[i], sents[i + 1])
                    if m and preserves(texts[i] + " " + texts[i + 1], m):
                        merged_texts.append(m)
                        merged_flags.append(True)
                        stats["ops"]["merge"] += 1
                        i += 2
                        continue
            merged_texts.append(texts[i])
            merged_flags.append(changed[i])
            i += 1
        # final fact guard per paragraph: nothing may be lost overall
        rebuilt = " ".join(t for t in merged_texts if t)
        if not preserves(para, rebuilt):
            rebuilt = para
            stats["reverted"] += 1
            merged_flags = [False] * len(merged_texts)
        stats["changed"] += sum(1 for f in merged_flags if f)
        out_paras.append(rebuilt)
    out = "\n\n".join(out_paras)
    # CV is measured over prose only: bibliographies and headings are not
    # sentences and would inflate the variance of both sides equally.
    def _prose(paras):
        keep, refs = [], False
        for p in paras:
            if not p:
                continue
            if REF.match(p):
                refs = True
            if refs:
                continue
            if len(p.split()) <= 12 and not re.search(r"[.!?]\s*$", p):
                continue
            keep.append(p)
        return keep
    m0, sd0, cv0 = sentence_lengths(_prose(paragraphs))
    m1, sd1, cv1 = sentence_lengths(_prose(out_paras))
    stats["before"] = {"mean": round(m0, 2), "sd": round(sd0, 2), "cv": round(cv0, 3)}
    stats["after"] = {"mean": round(m1, 2), "sd": round(sd1, 2), "cv": round(cv1, 3)}
    stats["cv_gain"] = round(cv1 - cv0, 3)
    if verbose:
        print("── Deterministic Distribution Shredder ──")
        print(f"sentences          : {stats['sentences']}")
        print(f"ops applied        : voice {stats['ops']['voice']} · split {stats['ops']['split']} · "
              f"merge {stats['ops']['merge']} · reorder {stats['ops']['reorder']}")
        print(f"sentences changed  : {stats['changed']} "
              f"({(100.0 * stats['changed'] / max(1, stats['sentences'])):.0f}%)")
        if stats["reverted"]:
            print(f"paragraphs reverted: {stats['reverted']} (fact guard)")
        print(f"mean length        : {stats['before']['mean']} → {stats['after']['mean']}")
        print(f"length sd          : {stats['before']['sd']} → {stats['after']['sd']}")
        print(f"CV (burstiness)    : {stats['before']['cv']} → {stats['after']['cv']} "
              f"({'↑' if stats['cv_gain'] >= 0 else '↓'} {stats['cv_gain']})")
        print("STATS_JSON " + json.dumps(stats, ensure_ascii=False))
    return out, stats


def main():
    ap = argparse.ArgumentParser(description="Deterministic Distribution Shredder")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--rate", type=float, default=0.50, help="per-sentence trigger probability (default 0.45)")
    ap.add_argument("--seed", type=int, default=None, help="RNG seed (default: hash of the input text)")
    ap.add_argument("--stats-json", default=None)
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    text = sys.stdin.read() if a.input == "-" else open(a.input, encoding="utf-8").read()
    out, stats = shred(text, rate=a.rate, seed=a.seed, verbose=not a.quiet)
    if a.output and a.output != "-":
        open(a.output, "w", encoding="utf-8").write(out + ("\n" if not out.endswith("\n") else ""))
    else:
        if not a.quiet:
            print()
        sys.stdout.write(out + ("\n" if not out.endswith("\n") else ""))
    if a.stats_json:
        json.dump(stats, open(a.stats_json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
