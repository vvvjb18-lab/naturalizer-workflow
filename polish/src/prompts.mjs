// Prompts for the two model passes.
//
// Pass 1 (audit) only *finds* defects. Pass 2 (repair) returns minimal string
// replacements, never a rewritten document. That split is what keeps the
// humanizer's rhythm intact: the model is structurally unable to re-flow text
// it was not asked about.

const TYPE_GUIDE = `grammar      ungrammatical, missing word, agreement, broken collocation, fragment
meaning      a sentence no longer says what DRAFT A says, or loses a qualifier that changes the claim
register     colloquialism, contraction, second person, rhetorical question, filler, inflated certainty
fact         a number, date, name, unit or quotation differs from DRAFT A or has disappeared
citation     a citation marker is missing, invented, or attached to the wrong claim
structure    prose turned into (1)(2)(3)/bullets/headings that DRAFT A did not have; duplicated or truncated text (not a reworded sentence)
terminology  a key term from DRAFT A replaced by a near-synonym that changes meaning
cohesion     a transition now points at the wrong referent and the sentence no longer parses`;

function langRules(lang) {
  if (lang === 'zh') {
    return `- 學術中文用書面語：不用口語（其實、基本上、真的、挺、搞）、不用第二人稱「你」、不用反問句、不用語氣詞。
- 主張強度要與證據相稱；A 稿用了「可能、似乎、顯示、往往」的地方，B 稿不應改成斷言。
- 不要標記：句長變化、短句、樸素動詞、缺少「綜上所述」、作者本來就用的第一人稱、本來就有的「我們」。
- 所有 quote 必須逐字取自 DRAFT B，保持繁體中文與原標點。`;
  }
  return `- Academic English: complete sentences; no second person, no contractions, no rhetorical questions, no conversational filler; claims calibrated to the evidence.
- Do not flag: varied sentence length, short punchy sentences, plain verbs, absence of "moreover/furthermore", first-person "I" where DRAFT A uses it.
- All quotes must be copied character-for-character from DRAFT B, including punctuation.`;
}

export function auditPrompt({ lang, draftText, chunkText, context, chunkIndex, chunkCount }) {
  const ctx = [];
  if (context?.missingNumbers?.length) {
    ctx.push(`- Numbers present in DRAFT A but absent from DRAFT B: ${context.missingNumbers.join(', ')}.`);
  }
  if (context?.extraNumbers?.length) {
    ctx.push(`- Numbers in DRAFT B that are absent from DRAFT A: ${context.extraNumbers.join(', ')}.`);
  }
  if (context?.missingCitations?.length) {
    ctx.push(`- Citation markers present in DRAFT A but absent from DRAFT B: ${context.missingCitations.join(', ')}. If one still belongs to a claim in DRAFT B, report it as type citation and quote the DRAFT B sentence where it belongs.`);
  }
  if (context?.extraCitations?.length) {
    ctx.push(`- Citation markers in DRAFT B that are absent from DRAFT A: ${context.extraCitations.join(', ')}.`);
  }
  if (context?.hedgeNote) ctx.push(`- ${context.hedgeNote}`);

  return `You are a meticulous academic copy-editor. You do not rewrite and you do not give writing advice. You find defects and return JSON only.

DRAFT B is the current text. It was reorganized by an automated editing tool. That tool deliberately varies sentence length and may sound uneven; this is intentional and must NOT be reported. DRAFT A is the author's earlier version. Use DRAFT A only as the reference for facts, citations, key terms and claim strength.

# DEFECT TYPES (use exactly these codes)
${TYPE_GUIDE}

# WHAT TO REPORT
Report a defect only if a university tutor or journal copy-editor would mark it wrong, or if it breaks meaning, grammar, academic register, citation accuracy, or document structure.

Pay special attention to:
- Vague noun drift: DRAFT B replacing a precise outcome or concept from DRAFT A with a vaguer near-synonym ("productivity gains" → "benefits"; "生產力提升" → "好處"). Report as terminology.
- A pronoun whose antecedent was removed or moved ("it", "they", "它", "他們"), so the sentence no longer has a clear referent. Report as cohesion.

# NEVER REPORT
- Sentence-length variation, short sentences, abrupt rhythm, plain wording.
- A sentence that is not verbatim in DRAFT A but expresses the same claim; rewording is not a defect.
- An added sentence that introduces no new claim, evidence or conclusion.
- Missing transitions, missing topic sentences, or "the flow could be smoother".
- Preferences for more formal vocabulary, more hedging in general, or more signposting.
- Anything that would require adding new content, evidence, examples or conclusions.

# LANGUAGE RULES
${langRules(lang)}

# MACHINE CONTEXT (leads, not verdicts)
${ctx.length ? ctx.join('\n') : '- None.'}

# DRAFT A (reference; may be a slice of a longer document)
<<<A
${draftText}
A

# DRAFT B (audit this; part ${chunkIndex + 1} of ${chunkCount})
<<<B
${chunkText}
B

# EVIDENCE RULES
- Spelled-out numbers and digits are equivalent: "three" = 3, "six" = 6, "two-hour" = 2 hours. Do not report a digit as invented when DRAFT A spells the same number.
- Do not treat a year inside a citation marker (e.g. "Sirois & Pychyl, 2013") as a separate numeric fact.
- "quote": 6–30 words copied exactly from DRAFT B. It must occur exactly once in the DRAFT B text above. Never paraphrase the quote, never use ellipses.
- "problem": state what is wrong. Do not explain how to write better in general.
- "fix": the minimum local change. Never add content or evidence.
- For structure defects, quote the sentence(s) containing the list/numbering.
- If a lost citation can be placed confidently on the same claim, report it. If not, do not guess.
- Report at most 20 issues, most serious first. {"issues":[]} is a valid answer.

# OUTPUT (JSON only)
{"issues":[{"type":"grammar|meaning|register|fact|citation|structure|terminology|cohesion","severity":"critical|major|minor","quote":"...","problem":"...","fix":"..."}]}`;
}

export function cleanupPrompt({ lang, draftText, currentText, issue, skill = '', failed = '' }) {
  return `You are the final academic supervisor. Your job is to make the remaining defect disappear without restoring the author's AI-sounding draft. You may patch locally, or rewrite the sentence or paragraph in a human academic voice.

# THE DEFECT
type: ${issue.type}
severity: ${issue.severity}
quote: ${issue.quote}
problem: ${issue.problem}
suggested fix: ${issue.fix || '(none)'}

# DRAFT A — the author's original. Use it as the source of facts, citations and claim strength, NOT as a style template.
<<<A
${draftText}
A

# CURRENT TEXT B — the humanized text. This is the voice to preserve.
<<<B
${currentText}
B

# GOALS
- Academic: grammatical and formal, but not templated. Keep the same claim and the same claim strength. Keep first-person "I" where B uses it.
- Human: uneven sentence lengths; use a short sentence where it is natural. Concrete verbs. No stock transition at the start of every sentence. No tricolon or parallel triad. No "not only … but also". No AI phrases. Do not over-polish; do not make every sentence medium-length.
- Preserve every number, date, name, unit, quotation and citation from DRAFT A. Do not add facts or citations.

# EDITING CONTRACT FROM THE SELECTED SKILL (follow it)
${skill || '(none)'}

# PREVIOUS ATTEMPT WAS REJECTED
${failed || '(none)'}
If a rejection is shown, correct that specific problem. Keep "before" to one sentence and keep the replacement length close to the original; do not drop citations or numbers.

# CHOOSE ONE ACTION
- "patch": a small local fix is possible. "before" must be copied exactly from B and be one clause or one sentence. "after" is the smallest replacement that fixes the defect.
- "rewrite": the sentence is too damaged, or the defect needs rephrasing. "before" must be the entire current sentence copied exactly from B (or the entire paragraph for a structure issue). "after" is the rewritten sentence or paragraph, in the same voice as B, following the GOALS. Same claim; no new content.
- "skip": neither is safe. Examples: DRAFT A itself has the defect and rewriting would reproduce it; the sentence cannot be rewritten without changing the claim; the sentence already matches DRAFT A.

# RULES
1. Never invent content, citations, facts, examples or explanations.
2. For "rewrite", do not copy DRAFT A's formulaic phrasing. DRAFT A is the fact source; B is the voice. Keep the same claim.
3. For a structure issue, rewrite the entire paragraph as prose; do not keep numbering, bullets or headings.
4. A patch must not add or remove sentences. A rewrite replaces one sentence with one sentence (structure issues: one paragraph with one paragraph), and must not add content.
5. Keep numbers, dates, names, units, quotations and citation markers from DRAFT A; do not introduce new ones.
6. Preserve the intentional unevenness of B; do not smooth the rhythm.
7. Never introduce: "delve", "moreover", "furthermore", "crucial", "pivotal", "multifaceted", "underscores", "landscape", "robust", "seamless", "holistic", "leverage", "not only … but also", "it is important to note", "plays a key role", em-dash chains, tricolons, parallel triads, or any list/numbering/heading.
8. No second person, contractions or rhetorical questions. Keep first-person "I" where B has it.
9. Write in the same language and script as B (${lang === 'zh' ? 'Traditional Chinese' : 'English'}).
10. If the defect exists in DRAFT A as well, "skip" — we do not rewrite the author's own style.
11. If the issue is minor, use "patch" only. A rewrite is allowed only for a major/critical issue or a structure problem.

# OUTPUT (JSON only)
{"action":"patch|rewrite|skip","before":"...","after":"...","reason":"..."}`;
}

export function repairPrompt({ lang, draftText, chunkText, issues, failed = [], strict = false, skill = '' }) {
  const issueList = issues.map((i) => ({
    id: i.id,
    type: i.type,
    severity: i.severity,
    quote: i.quote,
    problem: i.problem,
    fix: i.fix,
  }));

  const failedBlock = failed.length
    ? `\n# REJECTED ATTEMPTS (your previous replacements were refused)\n${failed.map((f) => `- issue ${f.id}: ${f.reason}. Attempted: ${JSON.stringify(f.attempt)}`).join('\n')}\nFix the reason above. In particular, "before" must be copied exactly from DRAFT B and must not add or drop facts, citations, lists or sentences.\n`
    : '';

  const strictBlock = strict
    ? `\nSTRICT MODE: produce at most one short patch per issue, usually 3–25 words of "before". Do not replace a whole paragraph. If you cannot fix it locally, mark it unresolved.\n`
    : '';

  return `You are repairing a text without rewriting it. DRAFT B is the current text. DRAFT A is the author's earlier version and is the reference for facts, citations, terminology and claim strength.

For every issue in the list, return the smallest replacement that fixes it.

# HARD RULES
1. "before" must be copied character-for-character from DRAFT B as shown above. It must appear exactly once. Never use ellipses.
2. Keep "before" to one clause or one sentence. Never span more than two sentences, never span a paragraph break.
3. "after" fixes only that issue. Every other word in the span stays unchanged.
4. Do not merge, split or reorder sentences. Do not change paragraph breaks.
5. Do not add or remove facts, examples, explanations, emphasis or summary sentences.
6. Keep referring expressions as they are. Do not replace a pronoun ("it", "they", "this") with the full noun phrase, and do not repeat a noun phrase that the previous sentence already establishes.
7. Keep every number, date, name, unit, quotation and citation marker. The only exception: the issue is specifically that one was lost or altered — then restore the exact value from DRAFT A.
8. Preserve the intentional unevenness. If the original sentence is short, keep it short. If it is long, keep it long. Do not smooth the rhythm.
9. Register fixes: use the plainest standard academic equivalent. Do not upgrade words that are already acceptable, do not add intensifiers, do not turn verbs into abstract nouns.
10. Never introduce: "delve", "moreover", "furthermore", "crucial", "pivotal", "multifaceted", "underscores", "landscape", "robust", "seamless", "holistic", "leverage", "not only … but also", "it is important to note", "plays a key role", em-dash chains, or any list, numbering, bullet or heading.
11. If a defect cannot be fixed in one local span, or the issue is a false positive, skip it and list it in "unresolved" with a reason. Do not force a change.
12. For a structure issue, convert the enumeration into ordinary prose within the quoted span; keep every item and their order. Merge items that share a grammatical slot into one clause instead of repeating an item both inside the merged clause and as a separate sentence. If another listed issue's quote falls inside that span, fix it in the same replacement.
13. Write "after" in the same language and script as DRAFT B (${lang === 'zh' ? 'Traditional Chinese' : 'English'}), with the same punctuation style.
14. Return one patch per issue. If two issues fall in the same sentence you may fix both in one replacement, but the replacement must visibly address each one. Do not fold unrelated issues into a structural rewrite and then leave them unfixed.

# ISSUE LIST
${JSON.stringify(issueList, null, 2)}
${failedBlock}${strictBlock}
# EDITING CONTRACT FROM THE SELECTED SKILL (follow it)
${skill || '(none)'}

# DRAFT A (reference)
<<<A
${draftText}
A

# DRAFT B (current text)
<<<B
${chunkText}
B

# OUTPUT (JSON only)
{"patches":[{"issue":"C1","before":"exact substring of DRAFT B","after":"replacement","note":"what changed"}],"unresolved":[{"issue":"C1","reason":"..."}]}`;
}

export function qualityJudgePrompt({ lang, originalText, currentText, candidate, issue, contextCurrent = '', contextOriginal = '', minScore = 18, minDimension = 3 }) {
  return `You are a strict academic quality judge. You do not rewrite. You compare three texts and decide whether the candidate may replace the current span.

# THE DEFECT BEING FIXED
type: ${issue.type}
severity: ${issue.severity}
problem: ${issue.problem}

# AUTHOR'S ORIGINAL (facts, citations and claim strength are the reference)
<<<ORIGINAL
${originalText}
ORIGINAL

# CURRENT TEXT (the humanized span; the voice to preserve)
<<<CURRENT
${currentText}
CURRENT

# CANDIDATE (proposed replacement)
<<<CANDIDATE
${candidate}
CANDIDATE

# CURRENT PARAGRAPH (check cohesion and duplicate citations/numbers)
<<<CURRENT_PARAGRAPH
${contextCurrent || currentText}
CURRENT_PARAGRAPH

# ORIGINAL PARAGRAPH (facts and context)
<<<ORIGINAL_PARAGRAPH
${contextOriginal || originalText}
ORIGINAL_PARAGRAPH

# RUBRIC (score 1-5 each; 5 is best)
1. meaning — same claim, conditions and scope as ORIGINAL; no new information, evidence, examples or opinions.
2. academic — formal, grammatical, precise; not casual, slangy or over-humanized.
3. facts — every number, date, name, unit, quotation and citation preserved; no invented facts or citations; a citation or number already used in the current paragraph for the same claim must not be duplicated.
4. naturalness — reads like careful academic prose; not awkward, not over-written, not a string of fragments. Check the surrounding paragraph for duplicated citations/numbers and broken cohesion.
5. register — the author's voice and first-person usage preserved; claims are no stronger than the evidence.

# VERDICT
- "accept" only if total >= ${minScore} and no dimension is below ${minDimension}.
- "revise" if a specific local fix could make it acceptable; put the fix in "fix".
- "reject" if meaning or facts changed, a citation/number was lost or invented, the prose is not academic, or it is over-written.
Do not reward a candidate merely because it sounds more "human"; penalise awkward or informal prose. Do not ask for new content.

# OUTPUT (JSON only)
{"scores":{"meaning":1,"academic":1,"facts":1,"naturalness":1,"register":1},"total":5,"verdict":"accept|revise|reject","problems":["..."],"fix":"..."}`;
}
