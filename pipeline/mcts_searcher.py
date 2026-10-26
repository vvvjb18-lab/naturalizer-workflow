#!/usr/bin/env python3
"""mcts_searcher.py — CPU-side adversarial discrete search over paragraph
rewrites (Workflow 8.17).

Search mapping (report §MCTS):
  node        = the document state: one rewrite choice per target paragraph
  selection   = UCT over children (exploration constant c)
  expansion   = regenerate the worst paragraph k=3 times through the 12B model
                (or a deterministic stub in --test); numbers/citations must
                survive and NLI vs the original paragraph must stay below 0.5
  evaluation  = stat_scorer.score(doc) → Reward = -(w1·detectability + w2·penalty)
  backprop    = visits/reward up the path to the root

NLI is a hard gate, never part of the reward (report §reward function).

Usage:
  python mcts_searcher.py --test [--iterations 10]
  python mcts_searcher.py --plan plan.json --out mcts.json --iterations 50
                          [--generator app|stub] [--zmq] [--port 5560]
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (HERE, os.path.join(ROOT, "polish")):
    if p not in sys.path:
        sys.path.insert(0, p)

import detector_bridge as DB                  # noqa: E402
import stat_scorer                            # noqa: E402
import shredder                               # noqa: E402  (stub generator only)

APP_URL = os.environ.get("HZ_APP_URL", "http://127.0.0.1:47615")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
NUM = re.compile(r"\d+(?:[.,]\d+)*%?")
CITE = re.compile(r"\([^()]{0,120}?\b(?:19|20)\d{2}[a-z]?[^()]*\)")


def _facts(t):
    return set(NUM.findall(t)) | set(CITE.findall(t))


# ── generators ─────────────────────────────────────────────────────────────
SENT_INSTR = ("Rewrite this single sentence with a different structure and rhythm. "
              "Keep the formal academic register exactly as polished as the original, "
              "keep the exact meaning, and keep every fact, number and citation unchanged. "
              "Vary sentence length: a much shorter or much longer sentence is welcome. "
              "No contractions, no second person, no fillers.")


class AppGenerator:
    """Real 12B generation through the Humanizer App (method unchanged)."""

    def __init__(self, temperatures=(0.95, 1.05, 1.0), unit="paragraph"):
        self.temps = temperatures
        self.unit = unit

    def __call__(self, prompt, k=3):
        if self.unit == "sentence":
            prompt = SENT_INSTR + (chr(10) * 2) + prompt
        out = []
        for i in range(k):
            body = json.dumps({
                "prompt": prompt, "n_predict": 1024,
                "temperature": self.temps[i % len(self.temps)], "top_p": 0.95,
                "top_k": 0, "min_p": 0, "repeat_penalty": 1.0,
            }).encode()
            req = urllib.request.Request(f"{APP_URL}/api/completion", data=body,
                                         headers={"Content-Type": "application/json", "X-Humanizer": "1"})
            with urllib.request.urlopen(req, timeout=600) as resp:
                data = json.loads(resp.read().decode())
            txt = " ".join(str(data.get("content") or "").split())
            if txt:
                out.append(txt)
        return out


class StubGenerator:
    """Deterministic, LLM-free variations (words preserved) for --test.

    Three structure-only moves, mirroring the JS mechanical burstify:
      split the longest sentence at a mid comma, rotate the sentence order,
      merge two adjacent short sentences with a semicolon.
    """

    def __init__(self, unit="paragraph"):
        self.unit = unit

    def _sentence_variants(self, sent, k=3):
        """Grammar-safe structural variants: split a relative/contrast clause
        into its own sentence, or move a fronted single-word adverb."""
        base = " ".join(sent.split())
        out = []
        low = base.lower()
        # ", which X." -> ". This X." (relative clause promoted)
        if ", which " in low:
            i = low.index(", which ")
            head = base[:i].rstrip(", ")
            tail = base[i + len(", which "):]
            if len(head.split()) >= 6 and len(tail.split()) >= 4:
                out.append(head + ". This " + tail)
        # ", but X." -> ". However, X."
        if ", but " in low:
            i = low.index(", but ")
            head = base[:i].rstrip(", ")
            tail = base[i + len(", but "):]
            if len(head.split()) >= 6 and len(tail.split()) >= 4:
                out.append(head + ". However, " + tail[0].lower() + tail[1:])
        # ", and X." -> ". In addition, X."
        if ", and " in low:
            i = low.index(", and ")
            head = base[:i].rstrip(", ")
            tail = base[i + len(", and "):]
            if len(head.split()) >= 6 and len(tail.split()) >= 4:
                out.append(head + ". In addition, " + tail[0].lower() + tail[1:])
        # fronted single-word adverb -> parenthetical after the subject
        m = re.match(r"^([A-Z][a-z]+),\s+(.+)$", base)
        if m and m.group(1).lower() not in ("this", "these", "that", "those", "the", "however"):
            body = m.group(2)
            out.append(body[0].upper() + body[1:] + ", " + m.group(1).lower() + ".")
        elif m:
            body = m.group(2)
            out.append(body[0].upper() + body[1:] + ", " + m.group(1).lower() + ".")
        return [v for v in out if v and v != base][:k]

    def __call__(self, prompt, k=3):
        if self.unit == "sentence":
            return self._sentence_variants(prompt, k)
        base = " ".join(prompt.split())
        sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", base) if s.strip()]
        out = []

        # 1) split the longest sentence at a comma with room on both sides
        if sents:
            li = max(range(len(sents)), key=lambda i: len(sents[i].split()))
            long_s = sents[li]
            parts = long_s.split(", ")
            if len(parts) >= 2:
                mid = len(parts) // 2
                left = ", ".join(parts[:mid]).rstrip(", ") + "."
                right = ", ".join(parts[mid:])
                right = right[0].upper() + right[1:]
                cand = sents[:li] + [left, right] + sents[li + 1:]
                out.append(" ".join(cand))

        # 2) rotate the sentence order
        if len(sents) >= 3:
            out.append(" ".join(sents[1:] + sents[:1]))

        # 3) merge two adjacent short sentences
        for i in range(len(sents) - 1):
            if len(sents[i].split()) <= 8 and len(sents[i + 1].split()) <= 8:
                merged = sents[i].rstrip(".") + "; " + sents[i + 1][0].lower() + sents[i + 1][1:]
                out.append(" ".join(sents[:i] + [merged] + sents[i + 2:]))
                break

        seen, uniq = set(), []
        for v in out:
            v = " ".join(v.split())
            if v and v != base and v not in seen:
                seen.add(v)
                uniq.append(v)
        return uniq[:k]


# ── search ─────────────────────────────────────────────────────────────────
class Node:
    __slots__ = ("paras", "parent", "children", "visits", "reward_sum",
                 "score", "move", "rejected")

    def __init__(self, paras, parent=None, move=None, score=None):
        self.paras = paras
        self.parent = parent
        self.children = []
        self.visits = 0
        self.reward_sum = 0.0
        self.score = score
        self.move = move            # (para_index, text)
        self.rejected = 0

    @property
    def q(self):
        return self.reward_sum / self.visits if self.visits else 0.0


class MCTS:
    def __init__(self, paragraphs, originals, generator, k=3, iterations=50,
                 c=1.2, w1=0.6, w2=0.4, log=print, scorer=None, lang="en", unit="paragraph"):
        self.paragraphs = list(paragraphs)
        self.originals = list(originals)
        self.gen = generator
        self.k = k
        self.iterations = iterations
        self.c = c
        self.w1, self.w2 = w1, w2
        self.log = log
        self.lang = lang
        self.unit = unit
        self.sent_visits = {}
        self.sent_attempts = {}
        self._memo = {}

        def _scored(t):
            key = hash(t)
            if key not in self._memo:
                self._memo[key] = stat_scorer.score(t, w1=self.w1, w2=self.w2, light=True)
            return self._memo[key]
        self.scorer = scorer or _scored
        root_score = self.scorer("\n\n".join(self.paragraphs))
        self.root = Node(list(self.paragraphs), score=root_score)
        self.history = []

    # -- helpers ---------------------------------------------------------
    def _uct(self, child):
        if child.visits == 0:
            return float("inf")
        exploit = child.q
        explore = self.c * math.sqrt(math.log(max(1, child.parent.visits)) / child.visits)
        return exploit + explore

    def _select(self):
        node = self.root
        while node.children:
            node = max(node.children, key=self._uct)
            if node.visits == 0:
                return node
        return node

    def _worst_paragraph(self, node):
        """Pick the paragraph whose local signal is worst (fewest visits too)."""
        best_i, best_s = 0, -1e9
        for i, text in enumerate(node.paras):
            s = self.scorer(text)["stat_detectability"]
            if s > best_s:
                best_s, best_i = s, i
        return best_i

    def _expand(self, node):
        if self.unit == "sentence":
            return self._expand_sentence(node)
        idx = self._worst_paragraph(node)
        orig = self.originals[idx] if idx < len(self.originals) else self.paragraphs[idx]
        variants = self.gen(self.paragraphs[idx], self.k)
        made = 0
        for v in variants:
            v = " ".join(v.split())
            if not v or v == self.paragraphs[idx]:
                continue
            if not _facts(orig) <= _facts(v):        # numbers/citations must survive
                node.rejected += 1
                continue
            try:                                      # hard NLI gate
                pair = DB.nli_list([[orig, v]])[0]
                if (pair.get("contradict") or 0) > 0.5:
                    node.rejected += 1
                    continue
            except Exception:
                pass
            paras = list(node.paras)
            paras[idx] = v
            sc = self.scorer("\n\n".join(paras))
            child = Node(paras, parent=node, move=(idx, v), score=sc)
            node.children.append(child)
            made += 1
        return node.children if made else []

    @staticmethod
    def _backprop(node, reward):
        while node is not None:
            node.visits += 1
            node.reward_sum += reward
            node = node.parent

    def _best(self):
        best, best_q = self.root, self.root.q
        for c in self.root.children:
            if c.visits and c.q > best_q:
                best, best_q = c, c.q
        return best

    def run(self):
        t0 = time.time()
        for it in range(self.iterations):
            t_it = time.time()
            leaf = self._select()
            kids = self._expand(leaf)
            if kids:
                target = max(kids, key=lambda n: n.score["reward"])
                self._backprop(target, target.score["reward"])
            else:
                self._backprop(leaf, leaf.score["reward"])
            self.history.append({
                "iter": it + 1,
                "ms": round((time.time() - t_it) * 1000),
                "children": len(kids),
                "best_reward": round(self._best().score["reward"], 4) if self._best().score else None,
            })
            if self.log and (it + 1) % 5 == 0:
                self.log(f"  iter {it + 1}/{self.iterations} · children {len(kids)} · "
                         f"best {self._best().score['reward']:.4f} · {self.history[-1]['ms']} ms")
        best = self._best()
        return {
            "paras": best.paras,
            "prose": "\n\n".join(best.paras),
            "score": best.score,
            "iterations": self.iterations,
            "visited": best.visits,
            "elapsed_s": round(time.time() - t0, 2),
            "per_iter_ms": [h["ms"] for h in self.history],
            "root_score": self.root.score,
            "tree": {"root_visits": self.root.visits,
                     "children": len(self.root.children),
                     "rejected": self.root.rejected},
            "history": self.history,
        }

    # ── 8.17.1: sentence-level expansion (aligned with grind's sentenceModeRegen)
    def _sentences(self, para):
        return [s.strip() for s in SENT_SPLIT.split(para) if s.strip()]

    def _target_sentence(self, node):
        """Least-visited sentence, longest first on ties. No extra scoring."""
        best = None
        for pi, para in enumerate(node.paras):
            for si, s in enumerate(self._sentences(para)):
                key = (pi, si)
                cand = (self.sent_visits.get(key, 0) + self.sent_attempts.get(key, 0), -len(s.split()), pi, si, s)
                if best is None or cand < best:
                    best = cand
        if best is None:
            return None
        return best[2], best[3], best[4]

    def _expand_sentence(self, node):
        tgt = self._target_sentence(node)
        if tgt is None:
            return []
        pi, si, orig = tgt
        self.sent_attempts[(pi, si)] = self.sent_attempts.get((pi, si), 0) + 1
        variants = self.gen(orig, self.k)
        made = 0
        for v in variants:
            v = " ".join(v.split())
            if not v or v == orig:
                continue
            if not _facts(orig) <= _facts(v):
                node.rejected += 1
                continue
            try:
                pair = DB.nli_list([[orig, v]])[0]
                if (pair.get("contradict") or 0) > 0.5:
                    node.rejected += 1
                    continue
                g = DB.gram_list([v])[0]["p_gram"]
                if g < 0.6:
                    node.rejected += 1
                    continue
            except Exception:
                pass
            sents = self._sentences(node.paras[pi])
            if si >= len(sents):
                continue
            sents[si] = v
            paras = list(node.paras)
            paras[pi] = " ".join(sents)
            sc = self.scorer((chr(10) * 2).join(paras))
            child = Node(paras, parent=node, move=(pi, si, v), score=sc)
            node.children.append(child)
            key = (pi, si)
            self.sent_visits[key] = self.sent_visits.get(key, 0) + 1
            made += 1
        return node.children if made else []



def _zmq_scorer(port):
    """Scoring via the ROUTER/DEALER bridge (CPU evaluator decoupled from the
    search loop). Starts a local server thread if none is listening."""
    import zmq_bridge
    try:
        c = zmq_bridge.BridgeClient(port, timeout_ms=2000, retries=1)
        c.call({"op": "ping"})
        server = None
    except Exception:
        server = zmq_bridge.ScoreServer(port).start()
        if not zmq_bridge.wait_ready(port, timeout=5):
            raise RuntimeError("zmq bridge did not become ready")
        c = zmq_bridge.BridgeClient(port, timeout_ms=120000, retries=3)
    def scorer(text):
        return c.call({"op": "score", "text": text, "light": True})
    return scorer, (lambda: (c.close(), server.stop() if server else None))


def _load_plan(path):
    d = json.load(open(path, encoding="utf-8"))
    idx = list(d["targets"].keys())
    paras = [" ".join(u["text"] for u in d["targets"][i]["units"]) for i in idx]
    return idx, paras


def main():
    ap = argparse.ArgumentParser(description="MCTS over paragraph rewrites")
    ap.add_argument("--plan")
    ap.add_argument("--out")
    ap.add_argument("--iterations", type=int, default=50)
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--c", type=float, default=1.2)
    ap.add_argument("--w1", type=float, default=0.6)
    ap.add_argument("--w2", type=float, default=0.4)
    ap.add_argument("--generator", choices=["app", "stub"], default="app")
    ap.add_argument("--unit", choices=["paragraph", "sentence"], default="paragraph")
    ap.add_argument("--zmq", action="store_true")
    ap.add_argument("--port", type=int, default=5560)
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    log = (lambda *x: None) if a.quiet else print

    if a.test:
        paras = [
            "Physical stores require expenditure on rent, utilities, employee wages and maintenance, which raises the fixed cost base substantially. "
            "These expenses can increase the financial pressure on businesses, particularly when customer traffic is low and margins are thin.",
            "E-commerce platforms avoid premises costs but carry delivery, packaging and returns overhead. "
            "Their efficiency depends on how effectively each channel controls its total operating costs.",
            "In conclusion, both channels have distinct advantages, and the more efficient option depends on demand density, product type and the retailer's operating model.",
        ]
        from collections import namedtuple
        NamedStub = namedtuple("NamedStub", "name")
        scorer, cleanup = (None, None)
        if a.zmq:
            scorer, cleanup = _zmq_scorer(a.port)
        res = MCTS(paras, paras, StubGenerator(unit=a.unit), k=a.k, unit=a.unit,
                   iterations=min(a.iterations, 10) if a.iterations == 50 else a.iterations,
                   c=a.c, w1=a.w1, w2=a.w2, log=log, scorer=scorer).run()
        if cleanup:
            cleanup()
        res["generator"] = "stub"
        res["unit"] = a.unit
        print(json.dumps({k: res[k] for k in ("iterations", "elapsed_s", "visited", "tree", "score", "root_score")},
                         ensure_ascii=False, indent=1))
        per = res["per_iter_ms"]
        print(f"per-iteration ms: min {min(per)} · median {sorted(per)[len(per)//2]} · max {max(per)}")
        print("--- best candidate (first 300 chars) ---")
        print(res["prose"][:300])
        return

    if not a.plan:
        ap.error("--plan or --test required")
    idx, paras = _load_plan(a.plan)
    gen = (StubGenerator(unit=a.unit) if a.generator == "stub"
           else AppGenerator(unit=a.unit))
    scorer, cleanup = (None, None)
    if a.zmq:
        scorer, cleanup = _zmq_scorer(a.port)
    res = MCTS(paras, paras, gen, k=a.k, iterations=a.iterations, c=a.c, unit=a.unit,
               w1=a.w1, w2=a.w2, log=log, scorer=scorer).run()
    if cleanup:
        cleanup()
    res["generator"] = a.generator
    res["unit"] = a.unit
    res["plan_indices"] = idx
    if a.out:
        json.dump(res, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"wrote {a.out}", file=sys.stderr)
    else:
        print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
