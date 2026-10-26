// arch90.test.mjs — 9.0 L0–L4 模組測試：帳本、三環否決、路由、診斷、骨架。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger, diffSummary } from '../../pipeline/ledger.mjs';
import { evaluateText, hedgeCount } from '../../pipeline/verify_gates.mjs';
import { classifyDraft, unsourcedStatRatio } from '../../pipeline/router.mjs';
import { diagnoseText } from '../../pipeline/diagnostics.mjs';
import { buildArgumentMap, skeletonSurvived } from '../../pipeline/argument_map.mjs';
import { findRepetitivePairs, DEDUP_INSTR } from '../../pipeline/grind.mjs';
import { gradeAgainstAnchor } from '../../pipeline/anchor_gate.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));

// ── L4 ledger ────────────────────────────────────────────────────────────────

test('diffSummary classifies kept/changed/added/removed sentences', () => {
  const before = 'The method is fast and cheap. Results may differ across runs. It scales well.';
  const after = 'The method is fast and cheap. Results can vary between runs. Also it is portable.';
  const d = diffSummary(before, after, 'en');
  assert.equal(d.sentences.before, 3);
  assert.equal(d.sentences.after, 3);
  assert.equal(d.kept, 1);
  assert.equal(d.changed, 1);
  assert.equal(d.added, 1);
});

test('ledger append/rollbackPoint/report', () => {
  const dir = tmp();
  try {
    const led = createLedger(dir, { docId: 't' });
    assert.equal(led.size, 0);
    const original = 'Original text one. Original text two.';
    led.append({ stage: 'original', before: original, after: original, verdict: { pass: true } });
    led.append({ stage: 'cand', before: original, after: 'Bad edit drops numbers 42.', verdict: { pass: false, vetoes: [{ ring: 1, rule: 'missingNumbers' }] } });
    led.append({ stage: 'cand2', before: 'Bad edit drops numbers 42.', after: 'Good edit keeps 42. Original text two-ish.', verdict: { pass: true }, meta: { paras: { 0: 'Good edit keeps 42. Original text two-ish.' } } });
    assert.equal(led.size, 3);
    assert.equal(led.rollbackPoint(), 2);
    assert.match(led.textAt(2), /Good edit keeps 42/);
    const rep = led.report();
    assert.equal(rep.rollbackPoint, 2);
    assert.equal(rep.vetoes.length, 1);
    assert.equal(rep.vetoes[0].rule, 'missingNumbers');
    // 重開帳本（崩潰恢復）
    const led2 = createLedger(dir, { docId: 't' });
    assert.equal(led2.size, 3);
    assert.equal(led2.rollbackPoint(), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── L3 verify_gates ─────────────────────────────────────────────────────────

const DRAFT = 'Remote work may enhance productivity (Smith & Lee, 2021). The effect appears to depend on task type. About 60 percent of firms adopted it by 2023, and the APA guidelines apply.';
const GOOD = 'Remote work may enhance productivity (Smith & Lee, 2021). The effect appears to depend on task type. Roughly 60 percent of firms adopted it by 2023, and the APA guidelines apply.';
const BAD_DROP = 'Remote work enhances productivity. The effect depends on task type. Most firms adopted it, and the APA guidelines apply.';
const BAD_INVENT = GOOD + ' Studies show 95 percent satisfaction.';

test('hedgeCount counts hedges', () => {
  assert.ok(hedgeCount(DRAFT) >= 2);
});

test('evaluateText passes a faithful rewrite', () => {
  const v = evaluateText({ draft: DRAFT, prose: GOOD, lang: 'en' });
  assert.equal(v.pass, true, JSON.stringify(v.vetoes));
  assert.ok(v.dimensions.fidelity > 0.8);
});

test('evaluateText vetoes hedge loss, number loss, acronym loss', () => {
  const v = evaluateText({ draft: DRAFT, prose: BAD_DROP, lang: 'en' });
  assert.equal(v.pass, false);
  const rules = v.vetoes.map((x) => x.rule);
  assert.ok(rules.includes('hedgeLoss'), rules.join(','));
  assert.ok(rules.includes('missingNumbers'), rules.join(','));
  assert.ok(rules.includes('missingCitations'), rules.join(','));
});

test('evaluateText vetoes invented numbers (fabrication)', () => {
  const v = evaluateText({ draft: DRAFT, prose: BAD_INVENT, lang: 'en' });
  assert.equal(v.pass, false);
  assert.ok(v.vetoes.some((x) => x.rule === 'inventedNumbers'));
});

test('evaluateText vetoes NLI contradiction and structure additions', () => {
  const v = evaluateText({
    draft: DRAFT, prose: GOOD, lang: 'en',
    nli: { maxContradict: 0.7, meanEntail: 0.3 },
  });
  assert.ok(v.vetoes.some((x) => x.rule === 'nliContradiction'));
  const v2 = evaluateText({ draft: DRAFT, prose: GOOD + '\n\n- bullet one\n- bullet two', lang: 'en' });
  assert.ok(v2.vetoes.some((x) => x.rule === 'structureAdditions'));
});

// ── L0 router ───────────────────────────────────────────────────────────────

test('router: citations without references → S5 (stop, verify sources)', () => {
  const r = classifyDraft({ text: 'Some claim (Ng, 2020) with evidence. More text here. Another sentence entirely.' });
  assert.equal(r.state, 'S5');
  assert.equal(r.exitCode, 4);
});

test('router: heavy AI without author analysis → S4 (return to author)', () => {
  const text = Array.from({ length: 6 }, (_, i) => `The system furthermore improves efficiency in context ${i}. It processes data through several stages of analysis and produces structured results each time.`).join('\n\n');
  const r = classifyDraft({ text, gen: 0.9, cv: 0.3 });
  assert.equal(r.state, 'S4');
  assert.equal(r.exitCode, 3);
});

test('router: clean human-ish draft → S1 (conservative)', () => {
  const text = 'My first experiment failed badly. I tried a different sampling frame the next week. The results finally made sense to me, though the margins were thin. I documented every step of the second attempt carefully.';
  const r = classifyDraft({ text, gen: 0.3, cv: 0.5 });
  assert.equal(r.state, 'S1');
});

test('router: repetitive paragraphs → S3 warning', () => {
  const p = 'The library chatbot answers common questions and searches the catalogue every day for students and staff members.';
  const text = `${p}\n\n${p}\n\n${p}`;
  const r = classifyDraft({ text, gen: 0.5, cv: 0.5 });
  assert.equal(r.state, 'S3');
});

test('router: standard case → S2', () => {
  const text = 'Taxation of sugar remains contested. Evidence from Mexico shows a 7.6 percent drop (Colchero et al., 2016).\n\nReferences\n\nColchero et al. (2016). Health Affairs.';
  const r = classifyDraft({ text, gen: 0.55, cv: 0.5 });
  assert.equal(r.state, 'S2');
});

test('unsourcedStatRatio flags unsupported statistics', () => {
  const withSrc = 'A survey of 200 students showed 62 percent had trouble. This matches prior findings (Lee, 2020).';
  const noSrc = 'A survey of 200 students showed 62 percent had trouble. Another 30 percent disagreed strongly. The remaining 10 percent were neutral about it.';
  assert.equal(unsourcedStatRatio(withSrc), 0);
  assert.equal(unsourcedStatRatio(noSrc), 1);
});

// ── L1 diagnostics ──────────────────────────────────────────────────────────

test('diagnostics: uniform paragraphs + aphorism endings detected', () => {
  const para = (n) => `Paragraph ${n} develops one point with moderate length and steady pacing here. It continues with a supporting observation that fills out the middle nicely. A further clause extends the development even further along. The rent and the food does not pay themselves.`;
  const text = Array.from({ length: 5 }, (_, i) => para(i)).join('\n\n');
  const d = diagnoseText(text, 'en');
  assert.ok(d.metrics.paragraphLenCv < 0.15);
  assert.ok(d.issues.some((x) => x.id === 'aphorismEndings'), JSON.stringify(d.issues.map((x) => x.id)));
  assert.ok(d.issues.some((x) => x.id === 'uniformParagraphs'));
});

test('diagnostics: unsourced stats flagged with evidence', () => {
  const text = 'Sales fell 12 percent last year. Costs rose 8 percent in the same period. Staff turnover reached 15 percent overall. The board reviewed all figures twice.';
  const d = diagnoseText(text, 'en');
  assert.ok(d.issues.some((x) => x.id === 'unsourcedStats'));
});

test('diagnostics: clean varied text has no high issues', () => {
  const text = `The 2016 Mexico tax cut purchases by 7.6 percent (Colchero et al., 2016). Berkeley earmarked revenue for schools (Falbe et al., 2016).\n\nCritics call such taxes regressive and paternalistic in effect. This carries some weight but misses two points about burdens.\n\nOverall the evidence supports proportionate taxation with earmarking, though design details matter greatly.`;
  const d = diagnoseText(text, 'en');
  assert.ok(!d.issues.some((x) => x.severity === 'high'), JSON.stringify(d.issues));
});

// ── L2 argument map ─────────────────────────────────────────────────────────

const ARG = `Sugar taxes are contested, but this essay argues they should be adopted. Governments need tools to curb consumption. Early data may support the case.\n\nMexico recorded a 7.6 percent purchase drop (Colchero et al., 2016). Berkeley funded school programmes with the revenue (Falbe et al., 2016).\n\nCritics note the tax can be regressive for poorer households. In conclusion, the evidence supports proportionate taxation.`;

test('argument map extracts claims/evidence/limitations and roles', () => {
  const m = buildArgumentMap(ARG, 'en');
  assert.deepEqual(m.roles, ['intro', 'body', 'conclusion']);
  assert.ok(m.claims.length >= 1);
  assert.ok(m.evidence.length >= 2);
  assert.ok(m.limitations.length >= 1);
  assert.ok(m.stats.evidenceCoverage > 0.5);
});

test('skeletonSurvived detects evidence loss after a bad rewrite', () => {
  const before = buildArgumentMap(ARG, 'en');
  const gutted = buildArgumentMap('Sugar taxes are debated at length. In conclusion, views differ.', 'en');
  const r = skeletonSurvived(before, gutted);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /證據句/.test(p)));
  const fine = skeletonSurvived(before, buildArgumentMap(ARG + ' Additional context was added here for length.', 'en'));
  assert.equal(fine.ok, true);
});

// ── 9.0 第二輪：重複段對 / 帳本 entryAt / 代名詞 one 回歸 ────────────────────

test('findRepetitivePairs detects overlapping adjacent paragraphs only', () => {
  const dup = 'The library chatbot answers common questions and searches the catalogue for students and staff members every single day of the week. It also handles hold requests and renewal reminders reliably. Students appreciate the quick response times during busy exam periods.';
  const other = 'Privacy remains a serious concern for any campus deployment of conversational software today. The system must log every query and apply retention limits with genuine staff oversight. Committees should review the data policy each term.';
  const paras = [dup, dup, other];
  const pairs = findRepetitivePairs(paras, [0, 1, 2], 'en');
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].i, pairs[0].j], [0, 1]);
  const distinct = findRepetitivePairs([dup, other, dup + ' The budget covers licences.'], [0, 1, 2], 'en');
  assert.equal(distinct.length, 0);
  assert.ok(DEDUP_INSTR.length > 40);
});

test('ledger entryAt exposes stored paras for intermediate rollback', () => {
  const dir = tmp();
  try {
    const led = createLedger(dir, { docId: 't' });
    led.append({ stage: 'original', before: 'orig', after: 'orig', verdict: { pass: true } });
    led.append({ stage: 'candidate', label: 'cand1', before: 'orig', after: 'cand text', verdict: { pass: true }, meta: { paras: { 0: 'cand text' } } });
    led.append({ stage: 'delivery', before: 'orig', after: 'bad delivery', verdict: { pass: false, vetoes: [{ ring: 1, rule: 'x' }] } });
    const rp = led.rollbackPoint();
    assert.equal(rp, 1);
    const green = led.entryAt(rp);
    assert.equal(green.meta.paras[0], 'cand text');
    assert.equal(led.textAt(rp), 'cand text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pronoun "one" in rewrite no longer triggers inventedNumbers (9.0 scrub)', () => {
  const draft = 'Stakeholders must navigate these adoption barriers carefully across diverse educational environments and funding models.';
  const prose = 'Stakeholders must navigate these adoption barriers carefully. One of the great things about this approach is its flexibility across environments.';
  const v = evaluateText({ draft, prose, lang: 'en' });
  assert.ok(!v.vetoes.some((x) => x.rule === 'inventedNumbers'), JSON.stringify(v.vetoes));
  // 量詞用法仍受保護：one percent 是事實數字
  const v2 = evaluateText({ draft, prose: prose.replace('One of', 'One percent of') + ' Adoption rose by one percent.', lang: 'en' });
  assert.ok(v2.vetoes.some((x) => x.rule === 'inventedNumbers'), 'real quantifier one should be caught');
});

// ── 9.0 第三輪：回退檢查點縫隙 / 作者錨定距離 ────────────────────────────────

test('rollbackPoint skips green entries without paragraph mapping', () => {
  const dir = tmp();
  try {
    const led = createLedger(dir, { docId: 't' });
    led.append({ stage: 'original', before: 'o', after: 'o', verdict: { pass: true } });
    led.append({ stage: 'candidate', label: 'cand1', before: 'o', after: 'c1', verdict: { pass: true }, meta: { paras: { 0: 'c1' } } });
    led.append({ stage: 'skeleton', before: 'o', after: 'c1', verdict: { pass: true } });   // 無映射，不可作為回退點
    led.append({ stage: 'delivery', before: 'o', after: 'bad', verdict: { pass: false, vetoes: [{ ring: 1, rule: 'x' }] } });
    assert.equal(led.rollbackPoint(), 1);
    // 原稿之後只有無映射綠點 → 回 #0
    fs.mkdirSync(dir + '2', { recursive: true });
    const led2 = createLedger(dir + '2', { docId: 't2' });
    led2.append({ stage: 'original', before: 'o', after: 'o', verdict: { pass: true } });
    led2.append({ stage: 'skeleton', before: 'o', after: 'x', verdict: { pass: true } });
    led2.append({ stage: 'delivery', before: 'o', after: 'bad', verdict: { pass: false, vetoes: [{ ring: 1, rule: 'x' }] } });
    assert.equal(led2.rollbackPoint(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '2', { recursive: true, force: true }); }
});

test('diagnostics authorDrift flags style distance from author sample', () => {
  // 作者樣本：長句鬆散、低 CV；文稿：碎片化高 CV
  const author = Array.from({ length: 5 }, (_, i) => `The committee reviewed the proposal carefully during the meeting and discussed every line of the budget with great attention before reaching any decision at all in the end, which took a while, ${i}.`).join('\n\n');
  const draft = 'Short point here. Very long sentence with many clauses and qualifiers stretching across the whole paragraph width. Another short one. Then an extremely extended sentence that keeps going and going and carries multiple subordinate clauses until it finally lands somewhere unexpected.';
  const d = diagnoseText(draft, 'en', { authorSample: author });
  assert.ok(d.metrics.authorDistance, 'authorDistance should be computed');
  assert.ok(d.issues.some((x) => x.id === 'authorDrift'), JSON.stringify(d.issues.map((x) => x.id)));
  // 無作者樣本時不產生 authorDrift
  const d2 = diagnoseText(draft, 'en');
  assert.ok(!d2.issues.some((x) => x.id === 'authorDrift'));
});

// ── 9.0 畢業考修復：量詞 one 對稱／分數詞等價／引用年份對齊 ─────────────────

test('one penny -> 1 penny is a legal conversion, not an invented fact', () => {
  const draft = 'A one penny per ounce tax reduced purchases across two cities. The evidence was clear.';
  const prose = 'A 1 penny per ounce tax reduced purchases across two cities. The evidence was clear.';
  const v = evaluateText({ draft, prose, lang: 'en' });
  assert.ok(!v.vetoes.some((x) => x.rule === 'inventedNumbers'), JSON.stringify(v.vetoes));
});

test('over half -> over 50% is a legal paraphrase', () => {
  const draft = 'Manufacturers reformulated over half of their products to reduce sugar content in response.';
  const prose = 'Manufacturers reformulated over 50% of their products to reduce sugar content in response.';
  const v = evaluateText({ draft, prose, lang: 'en' });
  assert.ok(!v.vetoes.some((x) => x.rule === 'inventedNumbers'), JSON.stringify(v.vetoes));
});

test('citation year alignment (8.2 authority) is not a citation mismatch', () => {
  const draft = 'Purchases fell after the tax (Colchero, 2016). The effect persisted over time.';
  const prose = 'Purchases fell after the tax (Colchero, 2017). The effect persisted over time.';
  const paragraphs = ['Purchases fell after the tax (Colchero, 2016).', 'References', 'Colchero, A. (2017). Beverage purchases. Health Affairs, 36(3).'];
  const v = evaluateText({ draft, prose, lang: 'en', paragraphs });
  assert.ok(!v.vetoes.some((x) => x.rule === 'missingCitations' || x.rule === 'inventedCitations'), JSON.stringify(v.vetoes));
});

test('twenty-first century -> 21st century is a legal ordinal conversion', () => {
  const draft = 'Obesity has become one of the most serious public health problems of the twenty-first century worldwide.';
  const prose = 'Obesity is among the most serious public health problems of the 21st century worldwide today.';
  const v = evaluateText({ draft, prose, lang: 'en' });
  assert.ok(!v.vetoes.some((x) => x.rule === 'inventedNumbers'), JSON.stringify(v.vetoes));
});

test('duplicate citation across paragraphs is not fabrication (set semantics)', () => {
  const draft = 'Sales fell after the tax (Bandy et al., 2020). Reformulation was the main driver.';
  const prose = 'Sales fell after the tax (Bandy et al., 2020). Industry data from Bandy et al., 2020 confirms reformulation.';
  const v = evaluateText({ draft, prose, lang: 'en' });
  assert.ok(!v.vetoes.some((x) => x.rule === 'inventedCitations'), JSON.stringify(v.vetoes));
});

// ── 9.0 課程品質門（hkuspace B+）────────────────────────────────────────────

const ANCHOR = JSON.parse(fs.readFileSync(new URL('../../pipeline/anchors/hkuspace-anchor.json', import.meta.url), 'utf8'));

test('anchor gate: B+ quality text passes all three rubric dimensions', () => {
  const body = [
    'The taxation of sugary drinks remains a contested policy instrument. This essay examines the fiscal and public health case, and argues that a well-designed levy is justified. The discussion draws on evidence from two national implementations.',
    'First, consumption evidence supports the tax. Mexico recorded a 7.6 percent purchase decline after its levy (Colchero, 2016), and Berkeley directed the revenue into school nutrition programmes (Falbe, 2016). Colchero (2016) points out that price signals change behaviour at population scale, particularly among heavier consumers.',
    'Second, the industry response matters. Over half of relevant products were reformulated with less sugar following the UK levy (Bandy, 2020), which means benefits reach consumers regardless of their purchasing choices. The revenue can also fund community health work in the most affected areas.',
    'In conclusion, the evidence supports a proportionate levy. Although regressivity concerns deserve attention, earmarking the revenue addresses them directly. A carefully designed tax is therefore both effective and equitable.',
  ].join('\n\n');
  const text = body + '\n\nReferences\n\nBandy, L. (2020). Sugar reductions. BMC Medicine, 18(1).\nColchero, M. (2016). Beverage purchases. Health Affairs, 36(3).\nFalbe, J. (2016). Berkeley excise tax. AJPH, 106(10).';
  // 測試用降門檻剖面（正文 100 詞起）——門檻本身由 fail-path 測試覆蓋
  const P = JSON.parse(JSON.stringify(ANCHOR));
  P.bplusGate.content.minWords = 100;
  P.profile.words = [100, 750];
  const g = gradeAgainstAnchor({ text, body, profile: P });
  assert.equal(g.grade, 'B+');
  assert.equal(g.pass, true);
  assert.ok(g.metrics.citationsPer1k >= 12, JSON.stringify(g.metrics));
  assert.ok(!g.fails.length, JSON.stringify(g.fails));
});

test('anchor gate: colloquial short text fails with FAIL items', () => {
  const body = 'So basically the tax is a big deal. You can see it works everywhere. It is kinda obvious really.';
  const g = gradeAgainstAnchor({ text: body, body, profile: ANCHOR });
  assert.equal(g.grade, 'BELOW-B+');
  assert.ok(g.fails.some((x) => x.rule === 'wordCount'), JSON.stringify(g.fails));
  assert.ok(g.fails.some((x) => x.rule === 'paragraphs'));
  assert.ok(g.fails.some((x) => x.rule === 'colloquial'));
  assert.ok(g.fails.some((x) => x.rule === 'secondPerson'));
});
