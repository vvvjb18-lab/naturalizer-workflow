// rerank_f1.mjs — re-rank the F1 form candidates offline (no engine), with the
// 7.3 form fixes (shortSentenceDensity exempt in formMode), then LT + docx.
import fs from 'node:fs';
import path from 'node:path';
import { candidateStats, rankCandidates, mechanicalPolish } from './candidates.mjs';
import { gramScores, scoreFiles } from './detector_client.mjs';

const WORK = 'E:/download/wf7.2-typetest/F1/.v6-F1_essay_plan';
const SRC = 'F:/Humanizer/pipeline/v6-test/samples/F1_essay_plan.docx';
const OUT_DIR = 'E:/download/wf7.2-typetest/F1';

const originalProse = fs.readFileSync(path.join(WORK, 'original.prose.txt'), 'utf8');
const paras = originalProse.split(/\n\s*\n/).filter((p) => p.trim());
const candFiles = fs.readdirSync(WORK).filter((f) => /^cand\d+\.repaired\.prose\.txt$/.test(f)).sort();

const cands = [];
for (const f of candFiles) {
  const prose = fs.readFileSync(path.join(WORK, f), 'utf8');
  const stats = candidateStats({ originalProse, prose, lang: 'en' });
  const sents = prose.split(/\n+/).flatMap((p) => p.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter(Boolean);
  const grams = await gramScores(sents);
  const low = grams.filter((g) => g < 0.5).length;
  const score = (await scoreFiles([path.join(WORK, f)]))[0];
  cands.push({
    id: f.match(/\d+/)[0], prose, stats, score,
    grammarDamage: low / Math.max(1, grams.length),
  });
  console.log(`cand${f.match(/\d+/)[0]}: cv=${stats.cv.toFixed(3)} ratio=${stats.cvRatio.toFixed(2)} cov=${stats.coverage} dmg=${(low / Math.max(1, grams.length)).toFixed(3)} gen=${score.p_ai_gen.toFixed(3)} ssd=${stats.shortSentenceDensity.toFixed(2)}`);
}

const { eligible, rejected } = rankCandidates(cands, {
  weights: JSON.parse(fs.readFileSync('v6.config.json', 'utf8')).weights,
  filters: { ...JSON.parse(fs.readFileSync('v6.config.json', 'utf8')).filters, formMode: true },
});
console.log('eligible:', eligible.map((c) => `cand${c.id} risk=${c.risk.toFixed(3)}`).join(', ') || 'NONE');
console.log('rejected:', rejected.map((c) => `cand${c.id}`).join(', '));
if (!eligible.length) process.exit(1);

const chosen = eligible[0];
// mechanical + LT pass
let prose = chosen.prose.split(/\n\s*\n/).map((p) => mechanicalPolish(p, 'en')).join('\n\n');
fs.writeFileSync('E:/download/F1_stage.txt', prose, 'utf8');
console.log('chosen cand' + chosen.id + '; run: python ../polish/lt_fix.py fix E:/download/F1_stage.txt E:/download/F1_LT.txt && python docx_bridge.py apply (see rerank notes)');
console.log(JSON.stringify({ cv: chosen.stats.cv, cvRatio: chosen.stats.cvRatio, damage: chosen.grammarDamage, gen: chosen.score.p_ai_gen, ppl: chosen.score.perplexity }, null, 1));
