#!/usr/bin/env node
// rescore_mapping.mjs — 8.11 歷史標籤重對齊：對所有帶 Turnitin 標籤的交付
// 文本重測真實離線 gen（純正文），輸出修正後的映射表。
// 文本來源：docx 直讀，或從 Turnitin 報告 PDF 的提交頁提取（丟檔案恢復用）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scoreTexts, closeDetector } from './detector_client.mjs';
import { wordCount, splitSentences } from '../polish/src/text.mjs';

const T = 'F:/Humanizer/pipeline/v6-test/turnitin';

function bodyFromText(txt) {
  const paras = txt.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let refs = false;
  for (const p of paras) {
    if (!refs && /^(references?|works cited|bibliography)\s*:?\s*$/i.test(p)) { refs = true; continue; }
    if (!refs) out.push(p);
  }
  return (out.length ? out : paras).join('\n\n');
}

function bodyFromPdf(pdfPath) {
  const pym = `
import sys, re
import pymupdf
doc = pymupdf.open(sys.argv[1])
lines = []
for page in doc:
    for ln in page.get_text().splitlines():
        s = ln.strip()
        if not s: continue
        if re.match(r'Page \\d+ of \\d+', s): continue
        if s.startswith('Submission ID') or s.startswith('trn:oid'): continue
        if re.match(r'^turnitin$', s, re.I): continue
        if re.match(r'AI Writing (Overview|Submission)|Cover Page', s): continue
        if s in ('Download Date','Submission Date','File Name','File Size','Document Details') or re.match(r'^[A-Z][a-z]+ \\d+, \\d{4}', s): continue
        if re.match(r'^[\\d.]+ (Pages|Words|Characters|KB)$', s): continue
        lines.append(s)
print('\\n\\n'.join(lines))
`;
  fs.writeFileSync('pdf_extract_tmp.py', pym);
  const r = spawnSync('python', ['pdf_extract_tmp.py', pdfPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('pdf extract failed: ' + String(r.stderr).slice(0, 150));
  return r.stdout;
}

function docxBody(docxPath) {
  const out = docxPath + '.rescore.txt';
  const r = spawnSync('python', [path.join(import.meta.dirname, 'docx_bridge.py'), 'fulltext', docxPath, out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('docx parse failed');
  return bodyFromText(fs.readFileSync(out, 'utf8'));
}

const PAIRS = [
  { name: 'E2-grind (turnitai)', label: 0, text: () => docxBody('E:/download/wf7.2-typetest/E2-final2/E2-grind.docx') },
  { name: 'E2_oneclick82 (turnitai 0 / origincheck 3)', label: 3, text: () => docxBody('F:/Humanizer/pipeline/canary/e2-oneclick82.docx') },
  { name: 'H2_ideal (turnitai 1)', label: 1, text: () => bodyFromPdf(`${T}/H2_ideal_AI.pdf`) },
  { name: 'H4_prodLT (turnitai 3)', label: 3, text: () => bodyFromPdf(`${T}/H4_prodLT_AI.pdf`) },
  { name: 'assault-0649 (origincheck 8)', label: 8, text: () => bodyFromText(fs.readFileSync('./canary/assault-0649.txt', 'utf8')) },
  { name: 'assault-0782 (origincheck 41)', label: 41, text: () => bodyFromPdf(`${T}/origincheck/assault-0782_AI_origincheck.pdf`) },
  { name: 'highAI-0983 (origincheck 98)', label: 98, text: () => bodyFromText(fs.readFileSync('./canary/highAI-0983.txt', 'utf8')) },
  { name: 'assault-0573 (origincheck 0)', label: 0, text: () => bodyFromPdf(`${T}/origincheck/assault-0573_AI_origincheck.pdf`) },
  { name: 'E2_oneclick81 (turnitai 0/22 — file lost, PDF recover)', label: 22, text: () => bodyFromPdf(`${T}/E2-oneclick81_AI.pdf`) },
];

const rows = [];
for (const p of PAIRS) {
  try {
    const body = p.text();
    const [sc] = await scoreTexts([body]);
    const gen = sc?.p_ai_gen ?? null;
    const sents = splitSentences(body, 'en').map((s) => wordCount(s.text, 'en'));
    const mean = sents.reduce((a, b) => a + b, 0) / Math.max(1, sents.length);
    const va = sents.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sents.length);
    const cv = mean > 0 ? Math.sqrt(va) / mean : 0;
    rows.push({ name: p.name, label: p.label, trueGen: gen, cv: Number(cv.toFixed(3)), words: wordCount(body, 'en'), ppl: sc?.perplexity ?? null });
    console.log(`${p.name}: label ${p.label}% → trueGen ${gen?.toFixed(3)} CV ${cv.toFixed(3)} (${wordCount(body, 'en')} words)`);
  } catch (e) {
    console.log(`${p.name}: SKIP (${e.message.slice(0, 60)})`);
  }
}
fs.writeFileSync('v6-test/mapping/rescored.json', JSON.stringify(rows, null, 1), 'utf8');
console.log('\nsaved → v6-test/mapping/rescored.json');
await closeDetector();
process.exit(0);
