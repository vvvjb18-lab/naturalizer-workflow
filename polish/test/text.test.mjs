import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLang, splitSentences, splitParagraphs, findSpans, chunkText, sentenceMetrics, diffWords,
} from '../src/text.mjs';
import {
  auditDeterministic, validatePatch, validateRewrite, structureAdditions, numbersIn, citationsIn, factNumbers,
} from '../src/checks.mjs';

const cfg = { maxPatchWords: 120, maxEditRatio: 0.15 };

test('language detection', () => {
  assert.equal(detectLang('This is an English academic paragraph with several words.'), 'en');
  assert.equal(detectLang('這是一段中文學術文字，用來測試語言判斷是否正確。'), 'zh');
});

test('sentence splitting respects abbreviations and decimals', () => {
  const s = splitSentences('Dr. Smith wrote the report. It cost 3.5 million dollars. Cf. Appendix A.', 'en');
  assert.equal(s.length, 3);
  assert.match(s[1].text, /3\.5 million/);
});

test('whitespace-tolerant phrase location', () => {
  const text = 'The data  show a clear trend — and “quoted” evidence.';
  const spans = findSpans(text, 'show a clear trend - and "quoted"');
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end).startsWith('show a clear'), true);
});

test('chunking keeps paragraphs together and respects the limit', () => {
  const text = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50) + '\n\n' + 'C'.repeat(50);
  const chunks = chunkText(text, 120);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /A{50}/);
  assert.match(chunks[0].text, /B{50}/);
  assert.match(chunks[1].text, /C{50}/);
  assert.equal(chunks[1].start, text.indexOf('C'.repeat(50)));
});

test('sentence metrics capture deliberate variation', () => {
  const m = sentenceMetrics('One. Two. Three. This sentence is noticeably longer than the others in this paragraph.', 'en');
  assert.ok(m.cv > 0.3);
  assert.equal(m.n, 4);
});

test('detects added (1)(2)(3) structure', () => {
  const draft = 'The method is fast and cheap and works on small samples.';
  const humanized = 'The method is fast. (1) It is cheap. (2) It works on small samples.';
  const added = structureAdditions(draft, humanized);
  assert.equal(added.find((a) => a.kind === 'parenNumber').added, 2);
  const { issues, context } = auditDeterministic(draft, humanized, 'en');
  assert.ok(issues.some((i) => i.type === 'structure'));
  assert.equal(context.missingNumbers.length, 0);
});

test('detects lost numbers and citations', () => {
  const draft = 'The sample contained 42 students (Smith, 2020).';
  const humanized = 'The sample contained students, according to prior work.';
  const { context } = auditDeterministic(draft, humanized, 'en');
  assert.deepEqual(context.missingNumbers, ['42']);
  assert.deepEqual(context.missingCitations, ['(Smith, 2020)']);
});

test('citation extraction does not double-count', () => {
  const c = citationsIn('As shown (Smith et al., 2020, p. 4) and later (Jones, 2019) [3].');
  assert.equal(c.length, 3);
});

test('patch validator rejects dropped numbers', () => {
  const r = validatePatch({
    before: 'It works on 30 small samples.',
    after: 'It works on many small samples.',
    issueType: 'structure', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /drops the number/);
});

test('patch validator rejects newly added lists and AI phrases', () => {
  const list = validatePatch({
    before: 'The method is fast and cheap.',
    after: 'The method is fast. (1) It is cheap. (2) It scales.',
    issueType: 'grammar', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(list.ok, false);

  const ai = validatePatch({
    before: 'The data show a clear trend.',
    after: 'The data delve into a multifaceted landscape.',
    issueType: 'grammar', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(ai.ok, false);
});

test('patch validator rejects wholesale rewrites', () => {
  const before = 'The method is fast and cheap.';
  const after = 'A rapid and economical procedure.';
  const r = validatePatch({
    before, after, issueType: 'grammar', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /length change|sentences|drops|rewrites too much/);
});

test('spelled-out numbers and digits are the same fact', () => {
  const nums = factNumbers('three sub-tasks, six hours, one month').sort();
  assert.deepEqual(nums, ['1', '3', '6']);
  const r = validatePatch({
    before: 'I will spend six hours per week.',
    after: 'I will spend 6 hours per week.',
    issueType: 'grammar', draftChunk: 'six hours', draftFull: 'six hours',
    lang: 'en', cfg, startsSentence: true,
  });
  assert.equal(r.ok, true, r.reason);
});

test('multi-sentence grammar rewrites require the explicit allowance', () => {
  const before = 'The plan is simple I will study every Tuesday and Thursday.';
  const after = 'The plan is simple. I will study every Tuesday and Thursday.';
  const base = { before, after, draftText: before, requiredText: before, lang: 'en', cfg };
  assert.equal(validateRewrite(base).ok, false);
  assert.equal(validateRewrite({ ...base, allowMultiSentence: true }).ok, true);
});

test('patch validator accepts a local grammar fix', () => {
  const r = validatePatch({
    before: 'The results suggests that the treatment work.',
    after: 'The results suggest that the treatment works.',
    issueType: 'grammar', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(r.ok, true);
});

test('Chinese structure and register checks', () => {
  const draft = '這個方法很快，也很便宜，並且適用於小樣本。';
  const humanized = '這個方法很快。（1）其實很便宜。（2）基本上適用於小樣本。';
  assert.ok(structureAdditions(draft, humanized).length > 0);
  const { issues } = auditDeterministic(draft, humanized, 'zh');
  assert.ok(issues.some((i) => i.type === 'structure'));
  assert.ok(issues.some((i) => i.type === 'register'));
});

test('patch validator rejects a lowercase sentence start', () => {
  const r = validatePatch({
    before: 'But 41% reported difficulty disconnecting.',
    after: 'yet 41% reported difficulty disconnecting.',
    issueType: 'register', draftChunk: '', lang: 'en', cfg, startsSentence: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lowercase/);
});

test('patch validator rejects a repeated stock transition', () => {
  const r = validatePatch({
    before: 'But the gains are small.',
    after: 'However, the gains are small.',
    issueType: 'register', draftChunk: '', lang: 'en', cfg,
    startsSentence: true, existingOpeners: { however: 1 },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /repeats the transition/);
});

test('word diff counts actual changes once', () => {
  assert.equal(diffWords('a b c d', 'a b c d', 'en'), 0);
  assert.equal(diffWords('a b c d', 'a b x d', 'en'), 1);
  assert.equal(diffWords('a b c d', 'a b c d e', 'en'), 1);
});

test('patch validator rejects a repeated content bigram', () => {
  const r = validatePatch({
    before: 'This shows that while productivity can increase, it is not a guarantee.',
    after: 'This shows that while productivity gains can occur, productivity gains are conditional.',
    issueType: 'meaning', draftChunk: '', lang: 'en', cfg,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /repeats the phrase/);
});

test('flags sentence-initial But/So but not "So far"', () => {
  const draft = 'However, the effect varies. These findings indicate that gains are conditional.';
  const humanized = 'But the effect varies. So the gains are conditional. So far, evidence is limited.';
  const { issues } = auditDeterministic(draft, humanized, 'en');
  const major = issues.filter((i) => i.type === 'register' && i.severity === 'major');
  assert.equal(major.length, 2);
  assert.ok(!major.some((i) => i.quote.includes('So far')));
});

test('numbers helper keeps percentages and decimals', () => {
  assert.deepEqual(numbersIn('About 3.5% of the 42 cases, i.e. 1.5 of them.'), ['3.5%', '42', '1.5']);
});
