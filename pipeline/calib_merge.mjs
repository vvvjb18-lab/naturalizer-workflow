// calib_merge.mjs — 9.0 L5：合併我方 21 點 ＋ hugo 8 點校準語料，逐族做
// 「哪個特徵最能分開 通過(<20)/失敗(≥20)」的門檻掃描。
// 產出：console 報表 + v6-test/calibration-merged.json。
// 立場：門檻設計（threshold design），不是分數預測（hugo 169 特徵回歸 MAE 33pp）。
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ours = JSON.parse(fs.readFileSync(path.join(HERE, 'v6-test', 'calibration.json'), 'utf8'));
const hugo = JSON.parse(fs.readFileSync(path.join(HERE, 'v6-test', 'calibration-hugo.json'), 'utf8'));

const passFail = (t) => {
  const s = String(t);
  if (/<20|not surfaced|0%|0 AI/i.test(s)) return true;
  const m = s.match(/(\d{1,3})/);
  return m ? Number(m[1]) < 20 : null;
};

// 我方點：cv / gen；hugo 點：copula / dose
const featurize = (p) => {
  const f = {};
  if (p.cv != null) f.cv = p.cv;
  if (p.p_ai_gen != null) f.gen = p.p_ai_gen;
  if (p.copula != null) f.copula = p.copula;
  if (p.dose != null) f.dose = p.dose;
  return f;
};

function bestThreshold(points, key) {
  const pts = points.map((p) => ({ v: p.feats[key], pass: p.pass })).filter((x) => Number.isFinite(x.v) && x.pass != null);
  if (pts.length < 3) return null;
  const values = [...new Set(pts.map((x) => x.v))].sort((a, b) => a - b);
  let best = null;
  for (const dir of ['<=', '>=']) {
    for (const t of values) {
      let ok = 0;
      for (const x of pts) ok += (dir === '<=' ? (x.v <= t) === x.pass : (x.v >= t) === x.pass) ? 1 : 0;
      const acc = ok / pts.length;
      if (!best || acc > best.acc) best = { key, dir, threshold: t, acc: +acc.toFixed(2), n: pts.length };
    }
  }
  return best;
}

const build = (points) => points.map((p) => ({ name: p.name, pass: passFail(p.turnitin), feats: featurize(p), turnitin: p.turnitin }));

const oursPts = build(ours.points).filter((p) => p.pass != null && Object.keys(p.feats).length);
const hugoPts = build(hugo.points).filter((p) => p.pass != null && Object.keys(p.feats).length);
const merged = [...oursPts, ...hugoPts];

const report = { generated: new Date().toISOString(), families: {} };
for (const [fam, pts] of [['naturalizer-workflow', oursPts], ['hugo-profile', hugoPts], ['merged', merged]]) {
  const axes = {};
  for (const key of ['cv', 'gen', 'copula', 'dose']) {
    const b = bestThreshold(pts, key);
    if (b) axes[key] = b;
  }
  report.families[fam] = { n: pts.length, pass: pts.filter((p) => p.pass).length, axes };
}

console.log('═══ 9.0 L5 族軸掃描（通過 = Turnitin <20）═══');
for (const [fam, r] of Object.entries(report.families)) {
  console.log(`\n【${fam}】n=${r.n}（通過 ${r.pass}）`);
  for (const [k, b] of Object.entries(r.axes)) {
    console.log(`  ${k.padEnd(7)} ${b.dir} ${b.threshold}\t命中率 ${b.acc}（n=${b.n}）`);
  }
}
console.log('\n教訓：每族的主導軸不同——沒有萬能常數，只有逐族校準（ROADMAP L5）。');

fs.writeFileSync(path.join(HERE, 'v6-test', 'calibration-merged.json'), JSON.stringify({ report, points: merged }, null, 1), 'utf8');
console.log('-> v6-test/calibration-merged.json');
