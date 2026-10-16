// Scores the current in-app engine (alignment-worker.js estimate) against hand timings.
// Usage: node eval-baseline.mjs [--trim]   (--trim: crop audio to the hand-timed span ±3 s)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const here = new URL('./', import.meta.url);
const ctx = {};
runInNewContext(readFileSync(new URL('../application/dist/client/alignment-worker.js', here), 'utf8'), ctx);
const engine = ctx.RecordingAlignment;
const trim = process.argv.includes('--trim');

export function score(pred, truth) {
  const errs = [];
  truth.forEach((t, i) => { if (t != null && Number.isFinite(pred[i])) errs.push(Math.abs(pred[i] - t)); });
  errs.sort((a, b) => a - b);
  const within = s => errs.filter(e => e <= s).length / errs.length;
  return { n: errs.length, median: errs[Math.floor(errs.length / 2)], w03: within(0.3), w05: within(0.5), w1: within(1), w2: within(2) };
}

const rows = [];
for (const file of readdirSync(new URL('data/', here)).filter(f => f.endsWith('.json')).sort()) {
  const d = JSON.parse(readFileSync(new URL('data/' + file, here)));
  const buf = readFileSync(new URL('data/' + d.audio, here));
  let pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  let offset = 0;
  const timed = d.times.filter(t => t != null);
  let [start, end] = d.clip || [0, d.duration];
  if (trim) { start = Math.max(0, timed[0] - 3); end = Math.min(d.duration, timed.at(-1) + 3); }
  offset = start;
  pcm = pcm.subarray(Math.round(start * d.rate), Math.round(end * d.rate));
  const parts = d.tokens.map(g => ({ label: g, weight: Math.max(1, [...g].length) }));
  const t0 = performance.now();
  const times = engine.estimate(engine.features(pcm, d.rate), parts).map(t => t + offset);
  const ms = performance.now() - t0;
  const s = score(times, d.times);
  rows.push({ hymn: file.replace('.json', ''), ...s, ms: Math.round(ms) });
  writeFileSync(new URL('data/' + file.replace('.json', trim ? '.baseline-trim.pred' : '.baseline.pred'), here), JSON.stringify(times));
}
const all = rows.reduce((a, r) => a + r.n, 0);
const avg = k => rows.reduce((a, r) => a + r[k] * r.n, 0) / all;
const pct = x => (100 * x).toFixed(0).padStart(3) + '%';
console.log((trim ? 'TRIMMED to timed span' : 'AS STORED (clip if set)') + '\n');
console.log('hymn'.padEnd(34), 'slots', 'median', '≤0.3s', '≤0.5s', ' ≤1s', ' ≤2s');
for (const r of rows) console.log(r.hymn.slice(0, 34).padEnd(34), String(r.n).padStart(5), (r.median.toFixed(2) + 's').padStart(6), pct(r.w03).padStart(5), pct(r.w05).padStart(5), pct(r.w1).padStart(4), pct(r.w2).padStart(4));
console.log('ALL'.padEnd(34), String(all).padStart(5), '      ', pct(avg('w03')).padStart(5), pct(avg('w05')).padStart(5), pct(avg('w1')).padStart(4), pct(avg('w2')).padStart(4));
