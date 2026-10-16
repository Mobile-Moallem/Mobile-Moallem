// Scores the browser engine (application/dist/client/hazzat-reader.js) exactly as the editor
// would run it: 4 kHz mono audio, one entry per Hazzat piece, clip honoured when set.
// Usage: node eval-js.mjs [auto|anchored]...
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const here = new URL('./', import.meta.url);
const ctx = { Math, Float64Array, Float32Array, Int32Array, Uint8Array, Array, Set, Map, Number, Boolean, Error };
runInNewContext(readFileSync(new URL('../application/dist/client/hazzat-reader.js', here), 'utf8'), ctx);
const reader = ctx.HazzatReader;
const RATE = 4000;

function pieces(word) { return word.split(/(?<=\.)(?=[^\s).])/u).filter(Boolean); }

function load4k(d) {
  const src = new URL('data/' + d.audio, here).pathname, out = src.replace('.f32', '.4k.f32');
  if (!existsSync(out)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(d.rate), '-ac', '1', '-i', src, '-ar', String(RATE), '-f', 'f32le', out]);
  const b = readFileSync(out);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['auto', 'anchored'];
for (const mode of modes) {
  const rows = [];
  const t0 = Date.now();
  for (const file of readdirSync(new URL('data/', here)).filter(f => f.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(new URL('data/' + file, here)));
    const glyphs = [], lineStart = [], owner = [];
    d.tokens.forEach((w, wi) => pieces(w).forEach((p, k) => { glyphs.push(p); owner.push(wi); lineStart.push(Boolean(d.line_start[wi]) && k === 0); }));
    const timed = d.times.filter(t => t != null);
    const args = { pcm: load4k(d), rate: RATE, glyphs, lineStart };
    if (d.clip) args.clip = { start: d.clip[0], end: d.clip[1] };
    if (mode === 'anchored') {
      const gaps = timed.slice(1).map((t, i) => t - timed[i]).sort((a, b) => a - b);
      args.start = timed[0]; args.end = timed.at(-1) + gaps[Math.floor(gaps.length / 2)] * 1.5;
    }
    const s0 = Date.now();
    const { times } = reader.read(args);
    const ms = Date.now() - s0;
    const firstPiece = d.tokens.map((_, wi) => owner.indexOf(wi));
    const errs = d.times.map((t, wi) => t == null ? null : Math.abs(times[firstPiece[wi]] - t)).filter(e => e != null).sort((a, b) => a - b);
    rows.push({ hymn: file.replace('.json', ''), errs, ms });
  }
  const pct = (e, s) => (100 * e.filter(x => x <= s).length / e.length).toFixed(0).padStart(3) + '%';
  console.log(`\n${mode.toUpperCase()} (browser engine, 4 kHz)  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('hymn'.padEnd(34), 'slots', 'median', '≤0.3s', '≤0.5s', ' ≤1s', ' ≤2s', ' time');
  for (const r of rows) console.log(r.hymn.slice(0, 34).padEnd(34), String(r.errs.length).padStart(5), (r.errs[Math.floor(r.errs.length / 2)].toFixed(2) + 's').padStart(6), pct(r.errs, .3).padStart(5), pct(r.errs, .5).padStart(5), pct(r.errs, 1).padStart(4), pct(r.errs, 2).padStart(4), (r.ms / 1000).toFixed(1).padStart(5) + 's');
  const all = rows.flatMap(r => r.errs).sort((a, b) => a - b);
  console.log('ALL'.padEnd(34), String(all.length).padStart(5), (all[Math.floor(all.length / 2)].toFixed(2) + 's').padStart(6), pct(all, .3).padStart(5), pct(all, .5).padStart(5), pct(all, 1).padStart(4), pct(all, 2).padStart(4));
}
