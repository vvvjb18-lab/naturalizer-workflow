import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrompt, validateUnit, candidateStats, rankCandidates,
  detectDocType, surgicalRepair, assembleCrossover, shouldStopEarly,
  mechanicalPolish,
} from '../../pipeline/candidates.mjs';

test('hz prompt is byte-exact (fingerprint check inside buildPrompt)', () => {
  const p = buildPrompt('Some draft.');
  assert.ok(p.startsWith('Rewrite the text below'));
  assert.ok(p.endsWith('\n\n### Rewritten:\n\n'));
  // buildPrompt throws if the fingerprint drifts, so reaching here is the assert.
});

test('validateUnit keeps facts and rejects damage', () => {
  const before = 'In a survey of 412 workers, 68% focused better (Smith & Lee, 2021).';
  assert.equal(validateUnit(before, 'Of 412 surveyed workers, 68% focused better (Smith & Lee, 2021).').ok, true);
  assert.equal(validateUnit(before, 'Of 412 surveyed workers, most focused better (Smith & Lee, 2021).').ok, false);
  assert.equal(validateUnit(before, 'Of 412 surveyed workers, 68% focused better.').ok, false);
  assert.equal(validateUnit(before, before).ok, false);
});

test('validateUnit rejects repeated sentences', () => {
  const before = 'The method is fast and cheap. Results may differ across runs.';
  const dup = 'The method was quick and inexpensive. The method was quick and inexpensive.';
  assert.match(validateUnit(before, dup).reason, /repeats/);
});

test('candidateStats measures inflation and copy rate', () => {
  const original = 'This is a long sentence about productivity gains in remote work settings. Another sentence follows here with different words entirely.';
  const prose = 'Short burst. This is a long sentence about productivity gains in remote work settings. Another sentence follows here with different words entirely.';
  const s = candidateStats({ originalProse: original, prose, lang: 'en' });
  assert.equal(s.sentencesBefore, 2);
  assert.equal(s.sentencesAfter, 3);
  assert.ok(s.sentenceInflation > 1.3);
  assert.ok(s.copyRate > 0.3);   // one sentence copied verbatim
  assert.ok(s.copyRate < 1.0);
});

test('rankCandidates targets the CV band and rejects smoother-than-original', () => {
  const mk = (id, gen, cv, cvRatio, cov = 1) => ({
    id,
    coverage: cov,
    stats: {
      cv, cvRatio, sentenceInflation: 1.2, shortSentenceDensity: 0.1, copyRate: 0.1,
      sentencesBefore: 10, sentencesAfter: 12, words: 100,
    },
    score: { p_ai_gen: gen, p_ai_edit: 0.15, perplexity: 30 },
  });
  const cands = [
    mk(1, 0.02, 0.30, 0.80),   // smoother than the AI draft → hard reject (final6.0 lesson)
    mk(2, 0.01, 0.55, 1.35),   // in band, lowest gen → winner
    mk(3, 0.30, 0.50, 1.25),   // in band, higher gen → eligible
    mk(4, 0.10, 0.52, 1.30, 0.8), // coverage broken → reject
  ];
  const { eligible, rejected } = rankCandidates(cands);
  assert.deepEqual(rejected.map((c) => c.id).sort(), [1, 4]);
  assert.equal(eligible[0].id, 2);
  assert.ok(eligible[0].risk < eligible[1].risk);
});

test('candidateStats reports CV ratio against the original', () => {
  const even = 'One two three four five six seven eight. Nine ten eleven twelve thirteen fourteen.';
  const bursty = 'Short. Another very long sentence with many more words in it than all the others here.';
  const s = candidateStats({ originalProse: even, prose: bursty, lang: 'en' });
  assert.ok(s.cv > 0);
  assert.ok(s.cvRatio > 1);   // burstier than the even original
});

test('detectDocType separates essays from template forms', () => {
  const essay = {
    paragraphs: [
      'Procrastination has affected my studies since primary school.',
      'My parents monitored my homework closely.',
      'References', 'Smith, J. (2021). Study habits. Journal, 12(3), 45-60.',
    ],
  };
  const form = {
    paragraphs: [
      'Class: CLxx Student Name: xxxxx',
      'Hook Statement (1 Complete Sentence)',
      'Background Information (3 Bullet Points)',
      'Complete APA reference (indentation, italics)',
      'Some prose sentence here about caffeine and sleep quality in students.',
    ],
  };
  assert.equal(detectDocType(essay).form, false);
  assert.equal(detectDocType(form).form, true);
});

test('surgicalRepair regenerates damaged sentences from the original', async () => {
  const original = 'The method is fast and cheap. Results may differ across runs. Every number stays.';
  const paras = {
    0: 'The method are fast and cheap. Results may differ across runs. Every number stays.',
  };
  const originalsByPara = { 0: original };
  const scorer = (sents) => sents.map((s) => (s.includes('are fast') ? 0.1 : 0.95));
  const completer = async ({ text }) => `Rewritten: ${text}`;
  const out = await surgicalRepair({
    paras, originalsByPara, lang: 'en',
    cfg: { grammarThreshold: 0.5, maxSurgeries: 4, surgeryTries: 2 },
    scorer, completer, log: () => {},
  });
  assert.equal(out.surgeries.length, 1);
  assert.match(out.surgeries[0].before, /are fast/);
  assert.match(out.paras[0], /Rewritten: The method is fast and cheap\./);
  assert.ok(out.paras[0].includes('Every number stays.'));   // untouched part intact
  assert.equal(out.residualDamaged, 0);
});


test('shouldStopEarly stops only on in-zone candidates (7.0)', () => {
  const mk = (cv, dmg, cov = 1) => ({ stats: { cv, coverage: cov }, grammarDamagePre: dmg });
  // balanced, essay: needs CV in band AND low damage
  assert.equal(shouldStopEarly([mk(0.3, 0), mk(0.5, 0)], {}), true);
  assert.equal(shouldStopEarly([mk(0.5, 0.2)], {}), false);
  assert.equal(shouldStopEarly([mk(0.3, 0)], {}), false);
  // ideal: roughness band
  assert.equal(shouldStopEarly([mk(0.5, 0.1)], { target: 'ideal' }), true);
  assert.equal(shouldStopEarly([mk(0.5, 0)], { target: 'ideal' }), false);
  // form: damage only
  assert.equal(shouldStopEarly([mk(0.2, 0.02)], { formMode: true }), true);
  // coverage broken never stops
  assert.equal(shouldStopEarly([mk(0.5, 0, 0.8)], {}), false);
});

test('assembleCrossover picks best paragraph per position with stickiness', () => {
  const cands = [
    { id: 1, risk: 0.1, paras: { 0: 'para0 from cand1', 1: 'para1 from cand1' } },
    { id: 2, risk: 0.9, paras: { 0: 'para0 from cand2', 1: 'para1 from cand2' } },
  ];
  const paraStats = {
    0: [
      { candId: 1, damage: 0.2, cv: 0.5 },
      { candId: 2, damage: 0.0, cv: 0.5 },   // cand2 clearly better here
    ],
    1: [
      { candId: 1, damage: 0.0, cv: 0.55 },
      { candId: 2, damage: 0.0, cv: 0.56 },  // near-tie → stickiness keeps cand1
    ],
  };
  const { paras, provenance } = assembleCrossover({ cands, paraStats });
  assert.equal(provenance[0], 2);
  assert.match(paras[0], /cand2/);
  assert.equal(provenance[1], 1);
  assert.match(paras[1], /cand1/);
});

test('surgicalRepair rejects a fix that duplicates an existing sentence (7.0)', async () => {
  const original = 'The method is fast and cheap. Results may differ across runs.';
  const paras = { 0: 'The method are fast and cheap. Results may differ across runs.' };
  const scorer = (sents) => sents.map((s) => (s.includes('are fast') ? 0.1 : 0.95));
  // the "fix" restates the neighbouring sentence
  const completer = async () => 'Results may differ across the runs.';
  const out = await surgicalRepair({
    paras, originalsByPara: { 0: original }, lang: 'en',
    cfg: { grammarThreshold: 0.5, maxSurgeries: 4, surgeryTries: 1 },
    scorer, completer, log: () => {},
  });
  assert.equal(out.surgeries.length, 0);
  assert.equal(out.residualDamaged, 1);
  assert.match(out.paras[0], /are fast/);   // damaged sentence left untouched
});

test('surgicalRepair accepts a clean, non-duplicating fix', async () => {
  const original = 'The method is fast and cheap. Results may differ across runs.';
  const paras = { 0: 'The method are fast and cheap. Results may differ across runs.' };
  const scorer = (sents) => sents.map((s) => (s.includes('are fast') ? 0.1 : 0.95));
  const completer = async ({ text }) => `Rewritten: ${text}`;
  const out = await surgicalRepair({
    paras, originalsByPara: { 0: original }, lang: 'en',
    cfg: { grammarThreshold: 0.5, maxSurgeries: 4, surgeryTries: 1 },
    scorer, completer, log: () => {},
  });
  assert.equal(out.surgeries.length, 1);
  assert.match(out.paras[0], /Rewritten: The method is fast and cheap\./);
});


test('mechanicalPolish fixes citation punctuation and quotes (7.1)', () => {
  // period stranded before the citation (user QA on 7.0)
  const a = 'This often leads children to become fearful of failure. (Baumrind, 1971).';
  assert.equal(mechanicalPolish(a), 'This often leads children to become fearful of failure (Baumrind, 1971).');
  // curly quotes normalised
  const b = 'I tied my self-worth to “perfect” grades and my parents’ judgements.';
  const wantB = 'I tied my self-worth to "perfect" grades and my parents' + String.fromCharCode(39) + ' judgements.';
  assert.equal(mechanicalPolish(b), wantB);
  // citation paren directly followed by a SMART label with no period
  const c = "It shapes academic performance (Hanna et al., 2010) 'T' (time-bound): I will follow the plan.";
  assert.equal(mechanicalPolish(c), "It shapes academic performance (Hanna et al., 2010). 'T' (time-bound): I will follow the plan.");
  // double period after closing citation collapses
  const d = 'as shown above (Smith, 2020)..';
  assert.equal(mechanicalPolish(d), 'as shown above (Smith, 2020).');
  // untouched text stays untouched
  const e = 'Normal sentence with one citation (Lee, 2019). Next sentence.';
  assert.equal(mechanicalPolish(e), e);
});
