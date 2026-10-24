# -*- coding: utf-8 -*-
"""lt_fix.py — LanguageTool safe-rule grammar repair (deterministic, no LLM).

Usage:
  python lt_fix.py fix <in.txt> <out.txt> [lang]   # apply safe-category fixes
  python lt_fix.py check <in.txt> [lang]           # list matches only

Safe categories (fix): TYPOS, GRAMMAR, PUNCTUATION, CASING, CONFUSED_WORDS,
TYPOGRAPHY, MISUSED_TERMS. Style/colloquialism/tone suggestions are ignored so
the human flavour survives; this layer exists to remove reader-visible errors,
not to smooth the text.
"""
import os
import sys

# LT 6.8 needs Java >= 17; the repo carries a portable JRE.
_JRE = r'F:\Humanizer\tools\jdk-17.0.20.1+1-jre'
if os.path.isdir(_JRE):
    os.environ['JAVA_HOME'] = _JRE
    os.environ['PATH'] = os.path.join(_JRE, 'bin') + os.pathsep + os.environ.get('PATH', '')

import language_tool_python

SAFE_CATEGORIES = {
    'TYPOS', 'GRAMMAR', 'PUNCTUATION', 'CASING', 'CONFUSED_WORDS',
    'TYPOGRAPHY', 'MISUSED_TERMS', 'MISUSED_TERMS_EU_PRESS',
}

# Rules inside safe categories that still rewrite style rather than errors.
RULE_BLACKLIST = {
    'EN_QUOTES', 'SENTENCE_WHITESSPACE', 'UPPERCASE_SENTENCE_START',
    'SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA', 'OXFORD_SPELLING',
    'COMMA_COMPOUND_SENTENCE', 'MISSING_COMMA_AFTER_INTRODUCTORY_PHRASE',
}

import re as _re

# citation parens like (Sirois & Pychyl, 2013; Tice & Baumeister, 1997) / (Baumrind, 1971)
_CITE_PAREN = _re.compile(r'\([^()]{0,120}?\d{4}[^()]*\)')
# trailing References section
_REFS_SPLIT = _re.compile(r'\n\s*(references|bibliography)\s*:?\s*\n', _re.I)


def protected_spans(text):
    spans = [m.span() for m in _CITE_PAREN.finditer(text)]
    m = _REFS_SPLIT.search(text)
    if m:
        spans.append((m.start(), len(text)))
    return spans


def in_spans(pos, end, spans):
    return any(s <= pos and end <= e for s, e in spans)


def is_proper_noun(bad, text, offset):
    # mid-sentence Capitalized token that is not a dictionary-common word start:
    # LT's morphology flags unknown proper nouns (author names) — never touch them.
    before = text[max(0, offset - 2):offset]
    return bool(bad) and bad[0].isupper() and not before.endswith('. ')


def safe_matches_for(text, matches):
    spans = protected_spans(text)
    for m in matches:
        cat = (getattr(m, 'category', None) or '')
        if cat not in SAFE_CATEGORIES:
            continue
        if m.rule_id in RULE_BLACKLIST:
            continue
        if not m.replacements:
            continue
        end = m.offset + m.error_length
        if in_spans(m.offset, end, spans):
            continue
        if m.rule_id.startswith('MORFOLOGIK') and is_proper_noun(text[m.offset:end], text, m.offset):
            continue
        yield m


def get_matches(tool, text):
    try:
        return tool.check(text)
    except Exception:
        return []


def apply_fixes(text, lang='en-GB', tool=None):
    own = tool is None
    if own:
        tool = language_tool_python.LanguageTool(lang)
    try:
        matches = list(safe_matches_for(text, get_matches(tool, text)))
        # apply from the end so earlier offsets stay valid; skip overlapping fixes
        fixed = text
        applied = []
        last_start = len(text) + 1
        for m in sorted(matches, key=lambda m: -m.offset):
            end = m.offset + m.error_length
            if end > last_start:
                continue
            rep = m.replacements[0]
            fixed = fixed[:m.offset] + rep + fixed[end:]
            applied.append({'rule': m.rule_id, 'cat': getattr(m, 'category', ''),
                            'bad': text[m.offset:end], 'fix': rep,
                            'ctx': text[max(0, m.offset - 30):end + 30]})
            last_start = m.offset
        return fixed, applied
    finally:
        if own:
            tool.close()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == 'check':
        text = open(sys.argv[2], encoding='utf-8').read()
        lang = sys.argv[3] if len(sys.argv) > 3 else 'en-GB'
        tool = language_tool_python.LanguageTool(lang)
        try:
            ms = list(safe_matches_for(text, get_matches(tool, text)))
            print(f'{len(ms)} safe matches')
            for m in ms:
                print(f"  {m.rule_id} [{getattr(m,'category','')}] {text[max(0,m.offset-30):m.offset+m.error_length+30]!r} -> {m.replacements[:2]}")
        finally:
            tool.close()
    elif cmd == 'fix':
        src, dst = sys.argv[2], sys.argv[3]
        lang = sys.argv[4] if len(sys.argv) > 4 else 'en-GB'
        text = open(src, encoding='utf-8').read()
        fixed, applied = apply_fixes(text, lang)
        open(dst, 'w', encoding='utf-8', newline='').write(fixed)
        import json
        meta = dst + '.json'
        open(meta, 'w', encoding='utf-8').write(json.dumps(applied, ensure_ascii=False, indent=1))
        print(f'{len(applied)} fixes applied -> {dst}')
        for a in applied:
            print(f"  {a['rule']}: {a['bad']!r} -> {a['fix']!r}")
    elif cmd == 'fixmap':
        # fixmap <map.json> <out.json> [lang] — map: {indices:[i], texts:[t]}
        # applies safe fixes per paragraph; writes same shape + adds "fixes".
        import json
        mp = json.load(open(sys.argv[2], encoding='utf-8'))
        lang = sys.argv[4] if len(sys.argv) > 4 else 'en-GB'
        if lang.startswith('zh'):
            json.dump({'indices': mp['indices'], 'texts': mp['texts'], 'fixes': [], 'skipped': 'zh unsupported'},
                      open(sys.argv[3], 'w', encoding='utf-8'), ensure_ascii=False)
            print('0 fixes (zh not supported by LT)')
            return
        total = []
        texts = []
        tool = language_tool_python.LanguageTool(lang)
        try:
            for t in mp['texts']:
                if not t or not t.strip():
                    texts.append(t)
                    continue
                fixed, applied = apply_fixes(t, lang, tool)
                texts.append(fixed)
                total.extend(applied)
        finally:
            tool.close()
        json.dump({'indices': mp['indices'], 'texts': texts, 'fixes': total},
                  open(sys.argv[3], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'{len(total)} fixes across {len(texts)} paras')
        for a in total:
            print(f"  {a['rule']}: {a['bad']!r} -> {a['fix']!r}")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
