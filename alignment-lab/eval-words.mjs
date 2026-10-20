// Scores the words-only reader (HazzatReader.readWords) against hand-timed text words.
// Usage: node eval-words.mjs [auto|anchored]...   Data: words-data/*.json (see README).
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const here = new URL('./', import.meta.url);
const ctx = { Math, Float64Array, Float32Array, Int32Array, Uint8Array, Array, Set, Map, Number, Boolean, Error };
runInNewContext(readFileSync(new URL('../application/dist/client/hazzat-reader.js', here), 'utf8'), ctx);
const R = ctx.HazzatReader;
const pct = (e, s) => (100 * e.filter(x => x <= s).length / e.length).toFixed(0).padStart(4) + '%';
for (const mode of process.argv.slice(2).length ? process.argv.slice(2) : ['anchored', 'auto']) {
  const all = [], allBase = [];
  console.log(`\n${mode.toUpperCase()}`); console.log('hymn'.padEnd(20), 'words', 'median', ' ≤0.25', ' ≤0.5', '  ≤1s', '  ≤2s', '| letters-only ≤0.5 ≤1s');
  for (const f of readdirSync(new URL('words-data/', here)).filter(f => f.endsWith('.json')).sort()) {
    const d = JSON.parse(readFileSync(new URL('words-data/' + f, here)));
    const b = readFileSync(new URL('words-data/' + d.audio, here));
    const pcm = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    const timed = d.times.filter(t => t != null);
    const args = { pcm, rate: 4000, words: d.words, lineStart: d.line_start };
    if (mode === 'anchored') { args.start = timed[0]; args.end = timed.at(-1) + 2; }
    const { times, start, end } = R.readWords(args);
    const errs = d.times.map((t, i) => t == null ? null : Math.abs(times[i] - t)).filter(e => e != null).sort((a, b) => a - b);
    // Naive baseline: same span, spread by letters only (what the old estimate does).
    const L = d.words.map(w => Math.max(1, w.length)); const sum = L.reduce((a, b) => a + b, 0);
    let acc = start; const base = L.map(l => { const t = acc; acc += l / sum * (end - start); return t; });
    const be = d.times.map((t, i) => t == null ? null : Math.abs(base[i] - t)).filter(e => e != null);
    all.push(...errs); allBase.push(...be);
    console.log(f.replace('.json', '').padEnd(20), String(errs.length).padStart(5), (errs[errs.length >> 1].toFixed(2) + 's').padStart(6), pct(errs, .25), pct(errs, .5), pct(errs, 1), pct(errs, 2), '|', pct(be, .5), pct(be, 1), ` span ${start.toFixed(1)}-${end.toFixed(1)} (hand ${timed[0]}-${timed.at(-1)})`);
  }
  all.sort((a, b) => a - b);
  console.log('ALL'.padEnd(20), String(all.length).padStart(5), (all[all.length >> 1].toFixed(2) + 's').padStart(6), pct(all, .25), pct(all, .5), pct(all, 1), pct(all, 2), '|', pct(allBase, .5), pct(allBase, 1));
}
