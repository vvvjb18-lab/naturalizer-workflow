#!/usr/bin/env python3
"""style_vector.py — corpus style vector + rhythm fingerprint (Workflow 8.16).

Implements the "rhythm fingerprint" half of the Syntax-RAG report: a document
corpus is projected onto a *style vector* with static fastText embeddings
(CPU only, no transformer), and its measurable rhythm statistics are emitted
so a prompt injector can turn them into soft guidance.

Design constraints taken from the task:
  - gensim + pretrained fastText English vectors
  - <= 1 GB resident model: the loader reads only the first `--limit` words
    (default 16000) and refuses any pre-loaded model larger than 1 GB unless
    --allow-large is given
  - optional TruncatedSVD reduction to 100 dimensions

Memory-safe loading of wiki.en-style models:
  * ``*.vec``           → gensim KeyedVectors, streamed with ``limit=16000``
  * ``*.vec.zip``       → the member is decompressed *lazily*; only the first
                          ``limit`` lines are ever read (no 4 GB extraction)
  * ``*.bin``           → fastText binary (guarded by the 1 GB rule)
  * ``*.kv`` / ``*.model`` → gensim native save()

Usage:
  python style_vector.py --corpus a.txt b.txt [--model path] [--limit 16000]
                         [--dim 100] [--topk 25] [--out style.json]
  python style_vector.py --self-test          # synthetic vocab, no model file
"""
import argparse
import io
import json
import math
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")
MAX_MODEL_BYTES = 1024 ** 3          # 1 GiB resident-model ceiling
DEFAULT_CANDIDATES = [
    "wiki.en.vec", "wiki.en.vec.zip", "wiki.en.bin",
    "wiki-news-300d-1M.vec", "wiki-news-300d-1M.vec.zip",
    "cc.en.300.vec",
]

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
_TOKEN = re.compile(r"[A-Za-z][A-Za-z'\-]+")


# ── model loading ──────────────────────────────────────────────────────────
def _find_model(explicit=None):
    if explicit:
        return explicit if os.path.exists(explicit) else None
    env = os.environ.get("STYLE_VECTOR_MODEL")
    if env and os.path.exists(env):
        return env
    for name in DEFAULT_CANDIDATES:
        p = os.path.join(MODELS_DIR, name)
        if os.path.exists(p):
            return p
    # any single model-ish file in models/
    if os.path.isdir(MODELS_DIR):
        for name in sorted(os.listdir(MODELS_DIR)):
            if name.endswith((".vec", ".vec.zip", ".bin", ".kv", ".model", ".npy")):
                return os.path.join(MODELS_DIR, name)
    return None


def _stream_zip_vectors(zip_path, limit):
    """Read at most ``limit`` word rows from the first member of a zip."""
    with zipfile.ZipFile(zip_path) as z:
        members = [m for m in z.namelist() if m.endswith((".vec", ".txt"))]
        if not members:
            raise RuntimeError(f"{zip_path}: no .vec member inside")
        with z.open(members[0]) as f:
            header = f.readline().decode("utf-8", "replace")
            parts = header.split()
            if len(parts) != 2:
                raise RuntimeError(f"{zip_path}: unexpected header {header[:60]!r}")
            total, dim = int(parts[0]), int(parts[1])
            n = min(limit, total)
            rows = []
            for _ in range(n):
                line = f.readline()
                if not line:
                    break
                rows.append(line.decode("utf-8", "replace"))
    return header, "".join(rows), total, dim


def load_vectors(path, limit=16000, allow_large=False, verbose=True):
    """Return (KeyedVectors, meta). Enforces the 1 GiB resident ceiling."""
    from gensim.models import KeyedVectors

    size = os.path.getsize(path)
    meta = {"path": path, "file_bytes": size, "limit": limit}

    def _est(n_rows, dim):
        return n_rows * dim * 4

    if path.endswith(".vec.zip"):
        header, body, total, dim = _stream_zip_vectors(path, limit)
        est = _est(min(limit, total), dim)
        if est > MAX_MODEL_BYTES and not allow_large:
            raise RuntimeError(f"refusing to load ~{est / 1e9:.1f} GB resident vectors")
        # gensim 4.x goes through smart_open, which wants a real path → spill the
        # first `limit` rows to a temp file (~60 MB) and delete it immediately.
        import tempfile
        fd, tmp = tempfile.mkstemp(suffix=".vec", dir=os.path.dirname(os.path.abspath(path)))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(header)
                fh.write(body)
            kv = KeyedVectors.load_word2vec_format(tmp, binary=False, limit=limit)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        meta.update({"format": "vec.zip(streamed)", "total_vocab": total, "loaded_vocab": len(kv), "dim": kv.vector_size})
    elif path.endswith((".vec", ".txt")):
        kv = KeyedVectors.load_word2vec_format(path, binary=False, limit=limit)
        meta.update({"format": "vec", "loaded_vocab": len(kv), "dim": kv.vector_size})
    elif path.endswith(".bin"):
        if size > MAX_MODEL_BYTES and not allow_large:
            raise RuntimeError(
                f"{os.path.basename(path)} is {size / 1e9:.1f} GB — over the 1 GiB "
                "resident ceiling. Use a .vec(.zip) source with --limit, or pass --allow-large."
            )
        from gensim.models import FastText
        ft = FastText.load_fasttext_format(path)
        kv = ft.wv
        meta.update({"format": "fasttext-bin", "loaded_vocab": len(kv), "dim": kv.vector_size})
    elif path.endswith((".kv", ".model")):
        kv = KeyedVectors.load(path, mmap="r")
        meta.update({"format": "gensim", "loaded_vocab": len(kv), "dim": kv.vector_size})
    elif path.endswith(".npy"):
        kv = KeyedVectors.load(path, mmap="r")
        meta.update({"format": "npy", "loaded_vocab": len(kv), "dim": kv.vector_size})
    else:
        raise RuntimeError(f"unsupported vector file: {path}")

    resident = len(kv) * kv.vector_size * 4
    meta["resident_bytes"] = resident
    if resident > MAX_MODEL_BYTES and not allow_large:
        raise RuntimeError(f"resident vectors {resident / 1e9:.2f} GB exceed the 1 GiB ceiling")
    if verbose:
        print(f"[style_vector] {meta['format']} · vocab {len(kv)} · dim {kv.vector_size} "
              f"· resident ~{resident / 1e6:.1f} MB", file=sys.stderr)
    return kv, meta


# ── rhythm statistics ──────────────────────────────────────────────────────
def rhythm_stats(texts):
    """Sentence-length distribution + fragmentation proxy over a corpus."""
    lens, frags, total_sents, words = [], 0, 0, 0
    for t in texts:
        body = re.sub(r"\n{2,}", "\n", t.strip())
        sents = [s.strip() for s in _SENT_SPLIT.split(body) if s.strip()]
        for s in sents:
            n = len(_TOKEN.findall(s))
            if n == 0:
                continue
            total_sents += 1
            words += n
            lens.append(n)
            # fragment proxy: no terminal punctuation and no finite-verb-ish token
            if not re.search(r"[.!?][\"')\]]?$", s):
                frags += 1
    if not lens:
        return {"sentences": 0, "words": 0, "mean": 0.0, "sd": 0.0, "cv": 0.0, "fragment_ratio": 0.0}
    mean = sum(lens) / len(lens)
    var = sum((x - mean) ** 2 for x in lens) / len(lens)
    sd = math.sqrt(var)
    return {
        "sentences": total_sents,
        "words": words,
        "mean": round(mean, 2),
        "sd": round(sd, 2),
        "cv": round(sd / mean, 3) if mean else 0.0,
        "fragment_ratio": round(frags / total_sents, 3),
        "short_ratio": round(sum(1 for x in lens if x <= 6) / len(lens), 3),
        "long_ratio": round(sum(1 for x in lens if x >= 28) / len(lens), 3),
    }


# ── style vector ───────────────────────────────────────────────────────────
def calculate_stylistic_vector(corpus_paths, model_path=None, limit=16000,
                               dim=100, topk=25, allow_large=False, verbose=True):
    """Weighted mean fastText vector over a corpus (+ optional SVD to `dim`).

    SIF-style weighting (a/(a+p(w))) downweights corpus-frequent function words,
    which is what makes the mean vector reflect style rather than topic.
    """
    kv, meta = load_vectors(model_path, limit=limit, allow_large=allow_large, verbose=verbose)
    texts = []
    for p in corpus_paths:
        with open(p, encoding="utf-8", errors="replace") as f:
            texts.append(f.read())
    corpus = "\n\n".join(texts)

    # Function words carry no style: averaging over them makes every corpus
    # look alike. Drop English stopwords before the weighted mean.
    try:
        from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS as _STOP
    except Exception:
        _STOP = frozenset()
    toks_all = [w.lower() for w in _TOKEN.findall(corpus)]
    toks = [w for w in toks_all if w not in _STOP]
    freq = {}
    for w in toks:
        freq[w] = freq.get(w, 0) + 1
    n_tok = max(1, len(toks))
    a = 1e-3
    acc, used, known = None, 0, 0
    for w in toks:
        try:
            vec = kv[w]
        except KeyError:
            continue
        known += 1
        weight = a / (a + freq[w] / n_tok)
        acc = vec * weight if acc is None else acc + vec * weight
        used += 1
    if acc is None or used == 0:
        raise RuntimeError("no corpus token found in the embedding vocabulary")

    from numpy.linalg import norm
    import numpy as np
    acc = np.asarray(acc, dtype="float32")
    acc = acc / (norm(acc) or 1.0)

    # sentence-level matrix for the optional SVD (style directions, not topic)
    sent_vecs = []
    for s in _SENT_SPLIT.split(corpus.replace("\n", " ")):
        ws = [w.lower() for w in _TOKEN.findall(s)]
        if len(ws) < 4:
            continue
        v = None
        for w in ws:
            try:
                vv = kv[w]
            except KeyError:
                continue
            v = vv if v is None else v + vv
        if v is not None:
            v = np.asarray(v, dtype="float32")
            sent_vecs.append(v / (norm(v) or 1.0))

    reduced = None
    svd_info = {"applied": False}
    if dim and len(sent_vecs) > dim:
        try:
            from sklearn.decomposition import TruncatedSVD
            svd = TruncatedSVD(n_components=dim, random_state=0)
            svd.fit(np.vstack(sent_vecs))
            reduced = svd.transform(acc.reshape(1, -1))[0]
            svd_info = {
                "applied": True, "dim": dim,
                "explained_variance": round(float(svd.explained_variance_ratio_.sum()), 4),
            }
        except Exception as e:                     # noqa: BLE001 - optional step
            svd_info = {"applied": False, "error": f"{type(e).__name__}: {e}"}
    else:
        svd_info = {"applied": False, "reason": f"only {len(sent_vecs)} sentence vectors (need > {dim})"}

    try:
        # ask for extra neighbours, then drop function words: a style
        # neighbourhood made of "of/the/one" tells the prompt nothing.
        raw = kv.most_similar(positive=[acc], topn=min(topk * 4, 400))
        neighbours = [x for x in raw if x[0].lower() not in _STOP][:topk]
        if not neighbours:
            neighbours = raw[:topk]
    except Exception:
        neighbours = []

    return {
        "source": "corpus",
        "model": meta,
        "vector": {
            "dim": int(acc.shape[0]),
            "l2norm": 1.0,
            "preview": [round(float(x), 5) for x in acc[:8]],
        },
        "reduced": ({"dim": dim, "preview": [round(float(x), 5) for x in reduced[:8]]} if reduced is not None else None),
        "svd": svd_info,
        "top_words": [{"word": w, "score": round(float(s), 4)} for w, s in neighbours],
        "rhythm": rhythm_stats(texts),
        "corpus": {"docs": len(corpus_paths), "tokens": len(toks_all), "content_tokens": n_tok, "known_ratio": round(known / n_tok, 3)},
    }


# ── self-test (no model file: deterministic synthetic vectors) ─────────────
class _SynthKV:
    """Deterministic stand-in so the pipeline can be exercised without a model."""

    def __init__(self, vocab, dim=300):
        import numpy as np
        self.vector_size = dim
        self._v = {}
        rng = np.random.default_rng(7)
        for w in vocab:
            v = rng.normal(size=dim).astype("float32")
            self._v[w] = v / np.linalg.norm(v)
        self.key_to_index = {w: i for i, w in enumerate(vocab)}

    def __len__(self):
        return len(self._v)

    def __contains__(self, w):
        return w in self._v

    def __getitem__(self, w):
        return self._v[w]

    def most_similar(self, positive=None, topn=10):
        import numpy as np
        q = np.asarray(positive[0], dtype="float32")
        q = q / (np.linalg.norm(q) or 1)
        scored = [(w, float(np.dot(q, v))) for w, v in self._v.items()]
        scored.sort(key=lambda x: -x[1])
        return scored[:topn]


def self_test(corpus_paths, dim=100, topk=10):
    import numpy as np
    texts = [open(p, encoding="utf-8", errors="replace").read() for p in corpus_paths]
    vocab = sorted({w.lower() for t in texts for w in _TOKEN.findall(t)})[:4000]
    kv = _SynthKV(vocab)
    global load_vectors
    _orig = load_vectors
    load_vectors = lambda *a, **k: (kv, {"path": "self-test-synthetic", "format": "synthetic", "loaded_vocab": len(kv), "dim": 300, "resident_bytes": len(kv) * 300 * 4})
    try:
        res = calculate_stylistic_vector(corpus_paths, model_path=None, limit=16000, dim=dim, topk=topk)
    finally:
        load_vectors = _orig
    res["source"] = "self-test"
    res["note"] = "synthetic embeddings — validates the pipeline, not language semantics"
    return res


def main():
    ap = argparse.ArgumentParser(description="Corpus style vector + rhythm fingerprint")
    ap.add_argument("--corpus", nargs="+", help="UTF-8 text files (human corpus)")
    ap.add_argument("--model", default=None, help="path to .vec / .vec.zip / .bin (default: pipeline/models/*)")
    ap.add_argument("--limit", type=int, default=16000, help="vocabulary rows to load (default 16000)")
    ap.add_argument("--dim", type=int, default=100, help="optional SVD target dimension (0 disables)")
    ap.add_argument("--topk", type=int, default=25)
    ap.add_argument("--out", default=None)
    ap.add_argument("--allow-large", action="store_true", help="override the 1 GiB resident ceiling")
    ap.add_argument("--self-test", action="store_true", help="run with synthetic vectors (no model file)")
    a = ap.parse_args()
    if not a.corpus:
        ap.error("--corpus is required")
    if a.self_test:
        res = self_test(a.corpus, dim=a.dim, topk=a.topk)
    else:
        model = _find_model(a.model)
        if not model:
            print("[style_vector] no embedding file found in pipeline/models/.\n"
                  "  Expected one of: " + ", ".join(DEFAULT_CANDIDATES) + "\n"
                  "  Run with --self-test to validate the pipeline without a model.", file=sys.stderr)
            sys.exit(2)
        res = calculate_stylistic_vector(a.corpus, model_path=model, limit=a.limit,
                                         dim=a.dim, topk=a.topk, allow_large=a.allow_large)
    payload = json.dumps(res, ensure_ascii=False, indent=1)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(payload)
        print(f"wrote {a.out}", file=sys.stderr)
    else:
        print(payload)


if __name__ == "__main__":
    main()
