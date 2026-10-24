// rerank.mjs — offline re-rank of an existing v6 work dir's candidates.
// Usage: node rerank.mjs <workDir> <lang> [--min-coverage F] [--form]
// Reads cand*.repaired.prose.txt + original.prose.txt; applies the 7.3 form
// fixes; prints a table + chosen candidate profile. No engine use.
import fs from 'node:fs';
import path from 'node:path';
import { candidateStats, rankCandidates, mechanicalPolish } from './candidates.mjs';
import { gramScores, scoreFiles } from './detector_client.mjs';

const args = process.argv.slice(2);
const WORK = args[0];
const lang = args[1] || 'en';
const minCov = args.includes('--min-coverage') ? parseFloat(args[args.indexOf('--min-coverage') + 1]) : 1;
const form = args.includes('--form');

const originalProse = fs.readFileSync(path.join(WORK, 'original.prose.txt'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(new URL('./v6.config.json', import.meta.url), 'utf8'));
const candFiles = fs.readdirSync(WORK).filter((f) => /^cand\d+\.repaired\.prose\.txt$/.test(f)).sort();

function sentSplit(t) {
  return t.split(/\n+/).flatMap((p) => p.split(/(?<=[.!?。！？])\s*/)).map((s) => s.trim()).filter(Boolean);
}

const cands = [];
for (const f of candFiles) {
  const fp = path.join(WORK, f);
  const prose = fs.readFileSync(fp, 'utf8');
  const stats = candidateStats({ originalProse, prose, lang });
  const sents = sentSplit(prose);
  const grams = await gramScores(lang === 'zh' ? sents.slice(0, 5) : sents); // zh: CoLA is en-only
  const low = grams.filter((g) => g < 0.5).length;
  const score = (await scoreFiles([fp]))[0];
  const c = {
    id: f.match(/\d+/)[0], file: fp, prose, stats, score,
    grammarDamage: low / Math.max(1, grams.length),
  };
  cands.push(c);
  console.log(`cand${c.id}: cv=${stats.cv?.toFixed(3)} ratio=${stats.cvRatio?.toFixed(2)} cov=${stats.coverage?.toFixed(2)} dmg=${c.grammarDamage.toFixed(3)} gen=${score.p_ai_gen?.toFixed(3)} edit=${score.p_ai_edit?.toFixed(3)} ppl=${score.perplexity?.toFixed(1)}`);
}

const filters = { ...cfg.filters, formMode: form, minCoverage: minCov };
const { eligible, rejected } = rankCandidates(cands, { weights: cfg.weights, filters });
console.log('eligible:', eligible.map((c) => `cand${c.id}(risk ${c.risk.toFixed(3)})`).join(' ') || 'NONE');
if (!eligible.length) process.exit(1);
const chosen = eligible[0];
const out = path.join(path.dirname(WORK), 'rerank-chosen.prose.txt');
fs.writeFileSync(out, chosen.prose.split(/\n\s*\n/).map((p) => mechanicalPolish(p, lang)).join('\n\n'), 'utf8');
console.log('chosen cand' + chosen.id + ' -> ' + out);
