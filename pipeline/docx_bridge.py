# -*- coding: utf-8 -*-
"""DOCX bridge for the Humanizer pipeline.

Uses the same approach as hz's own docx support (humanizer/hz_docx.py):
python-docx, body paragraphs in order, rewrite into the first run and clear
the rest, preserving paragraph style/numbering and the first run's formatting.

Commands:
  extract  <in.docx> <out.json>      paragraphs as a JSON array (empty ones kept)
  apply    <base.docx> <map.json> <out.docx>
                                     map = {"indices": [...], "texts": [...]}
  fulltext <in.docx> <out.txt>       non-empty body paragraphs joined by blank lines
  plan     <in.docx> <out.json>      which paragraphs hz would rewrite, using hz's
                                     own planner (identical to `hz --dry-run`)
"""

import json
import sys


def fail(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(1)


def load_docx(path):
    try:
        from docx import Document
    except ImportError:
        fail('python-docx is missing. Install it into the hz tool env:\n'
             '  uv pip install --python "<uv tools>/humanize-model/Scripts/python.exe" python-docx')
    try:
        return Document(path)
    except Exception as e:
        fail(f"cannot open {path}: {e}")


def cmd_extract(src, out):
    doc = load_docx(src)
    paragraphs = [p.text or "" for p in doc.paragraphs]
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"paragraphs": paragraphs}, f, ensure_ascii=False)
    print(f"extracted {len(paragraphs)} paragraphs")


def cmd_apply(base, map_path, out):
    doc = load_docx(base)
    with open(map_path, encoding="utf-8") as f:
        data = json.load(f)
    indices = data.get("indices") or []
    texts = data.get("texts") or []
    if len(indices) != len(texts):
        fail(f"map mismatch: {len(indices)} indices vs {len(texts)} texts")
    paragraphs = doc.paragraphs
    for idx, text in zip(indices, texts):
        if not isinstance(idx, int) or idx < 0 or idx >= len(paragraphs):
            fail(f"paragraph index out of range: {idx}")
        p = paragraphs[idx]
        runs = p.runs
        if not runs:
            fail(f"paragraph {idx} has no runs; refusing to write into it")
        # One paragraph in, one paragraph out; never create line breaks.
        clean = " ".join(str(text).splitlines()).strip()
        runs[0].text = clean
        for r in runs[1:]:
            r.text = ""
    doc.save(out)
    print(f"applied {len(indices)} paragraph(s) -> {out}")


def cmd_fulltext(src, out):
    doc = load_docx(src)
    paras = [(p.text or "").strip() for p in doc.paragraphs]
    text = "\n\n".join(p for p in paras if p)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text + ("\n" if text else ""))
    print(f"wrote {len(text)} chars")


def _load_hz_pkg():
    """Locate the installed humanizer package (uv tool env) and import hz_docx."""
    import glob, os as _os
    cands = []
    env = _os.environ.get("HUMANIZER_PKG_DIR")
    if env:
        cands.append(env)
    appdata = _os.environ.get("APPDATA", "")
    if appdata:
        cands += glob.glob(_os.path.join(appdata, "uv", "tools", "humanize-model*", "Lib", "site-packages", "humanizer"))
        cands += glob.glob(_os.path.join(appdata, "uv", "tools", "humanize-model*", "lib", "python*", "site-packages", "humanizer"))
    local = _os.environ.get("LOCALAPPDATA", "")
    if local:
        cands += glob.glob(_os.path.join(local, "uv", "tools", "humanize-model*", "*", "Lib", "site-packages", "humanizer"))
    for c in cands:
        if _os.path.isfile(_os.path.join(c, "hz_docx.py")):
            sys.path.insert(0, c)
            try:
                import hz_docx, hz_text  # noqa: F401  (loads as top-level modules)
                return hz_docx, hz_text
            except ImportError as e:
                sys.path.pop(0)
                raise RuntimeError(f"found humanizer package at {c} but import failed: {e}")
    raise RuntimeError("cannot find the humanizer package (hz_docx.py); set HUMANIZER_PKG_DIR")


def cmd_plan(src, out):
    doc = load_docx(src)
    hz_docx, hz_text = _load_hz_pkg()
    planner = hz_text.Planner(350, 600)  # hz CLI defaults: --max-words 350 / --max-chars 600
    units, targets, kept = hz_docx.plan(doc, planner)
    out_targets = {}
    for n, (_p, ids, joiner) in targets.items():  # hz keys are 1-based paragraph numbers
        out_targets[str(n - 1)] = {
            "units": [{"id": u.id, "text": u.text} for u in units if u.id in ids],
            "joiner": joiner,
        }
    data = {
        "paragraphs": [p.text or "" for p in doc.paragraphs],
        "targets": out_targets,
        "kept": dict(kept),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    total = sum(len(t["units"]) for t in out_targets.values())
    print(f"plan: {len(out_targets)} paragraph(s), {total} unit(s), kept: {dict(kept)}")


def main():
    if len(sys.argv) < 2:
        fail(__doc__)
    cmd = sys.argv[1]
    if cmd == "extract" and len(sys.argv) == 4:
        cmd_extract(sys.argv[2], sys.argv[3])
    elif cmd == "apply" and len(sys.argv) == 5:
        cmd_apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "fulltext" and len(sys.argv) == 4:
        cmd_fulltext(sys.argv[2], sys.argv[3])
    elif cmd == "plan" and len(sys.argv) == 4:
        cmd_plan(sys.argv[2], sys.argv[3])
    else:
        fail(__doc__)


if __name__ == "__main__":
    main()
