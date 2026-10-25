#!/usr/bin/env node
// prompt_injector.mjs — turns a style/seed JSON into soft prompt guidance.
//
// Reads the JSON produced by style_vector.py (corpus style) or
// seed_extractor.py (voice-note seed) and emits the guidance block that
// candidates.mjs appends to the rewrite prompt when --style-guide / --seed is
// used. Default runs are untouched: without a guide the prompt is byte-exact.
//
// Usage:
//   node prompt_injector.mjs style.json            # print guidance text
//   node prompt_injector.mjs style.json --json     # print {guide, meta}
//   import { buildStyleGuidance } from './prompt_injector.mjs'

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Build the "Style guidance:" block.
 * @param {object} style  JSON from style_vector.py or seed_extractor.py
 * @param {{maxWords?: number, maxTopWords?: number}} [opts]
 * @returns {{guide: string, meta: object}}
 */
export function buildStyleGuidance(style, opts = {}) {
  const r = style?.rhythm || {};
  const mean = Number.isFinite(r.mean) && r.mean > 0 ? r.mean : null;
  const sd = Number.isFinite(r.sd) && r.sd > 0 ? r.sd : null;
  const cv = Number.isFinite(r.cv) ? r.cv : null;
  const markers = style?.markers_per_100w || {};
  const topWords = Array.isArray(style?.top_words) ? style.top_words : [];
  const maxTop = opts.maxTopWords ?? 12;

  const lines = [];
  lines.push('Style guidance: Write with the following rhythm characteristics:');
  if (mean != null) {
    // transcript seeds fragment heavily; a rewrite must stay within prose range
    const m = clamp(Math.round(mean), 11, 26);
    const s = sd != null ? clamp(Math.round(sd), 4, 12) : 6;
    lines.push(`- Average sentence length: ${m} words (±${s})`);
  } else {
    lines.push('- Average sentence length: 16-22 words, not uniform');
  }
  lines.push('- Include at least one short sentence (3-6 words) per paragraph');
  lines.push('- Use one complex sentence with a relative clause per paragraph');
  lines.push('- Avoid uniform sentence lengths; vary between short and long');
  if (cv != null && cv >= 0.5) {
    lines.push('- Keep strong sentence-length contrast; irregular rhythm reads human');
  }
  if (r.short_ratio != null && r.short_ratio > 0.2) {
    lines.push(`- Roughly ${Math.round(r.short_ratio * 100)}% of sentences may be very short (under 7 words)`);
  }
  if (Number(markers.hedges) > 1.5) {
    lines.push("- Allow occasional measured hedging ('perhaps', 'it seems') — do not overuse");
  }
  if (Number(markers.self_repair) > 0.5) {
    lines.push('- Keep a thinking voice: light self-correction is natural; no filler sounds');
  }
  if (Number(markers.first_person) > 3) {
    lines.push('- First person is acceptable where the argument is the author\'s own');
  }
  if (Array.isArray(style?.guidance?.notes)) {
    for (const n of style.guidance.notes) lines.push(`- ${n}`);
  }
  if (topWords.length) {
    const words = topWords
      .map((t) => (typeof t === 'string' ? t : t.word))
      .filter(Boolean)
      .slice(0, maxTop);
    if (words.length) {
      lines.push(`- Lexical neighbourhood of the target style (use naturally, never force): ${words.join(', ')}`);
    }
  }
  lines.push('Do not mention this guidance, and keep every fact, number and citation unchanged.');

  const guide = lines.join('\n');
  const meta = {
    source: style?.source || 'unknown',
    mean, sd, cv,
    topWords: Math.min(topWords.length, maxTop),
    chars: guide.length,
  };
  return { guide, meta };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const asJson = args.includes('--json');
  if (!file) {
    console.error('usage: node prompt_injector.mjs <style.json> [--json]');
    process.exit(1);
  }
  const style = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { guide, meta } = buildStyleGuidance(style);
  if (asJson) console.log(JSON.stringify({ guide, meta }, null, 1));
  else console.log(guide);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) main();
