import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import app from '../dist/server/index.js';

const root = new URL('../', import.meta.url);
const load = () => {
  const ctx = { Math, Float64Array, Float32Array, Int32Array, Uint8Array, Array, Set, Map, Number, Boolean, Error };
  runInNewContext(readFileSync(new URL('dist/client/hazzat-reader.js', root), 'utf8'), ctx);
  return ctx;
};
const reader = load().HazzatReader;

test('note lengths follow the Hazzat key', () => {
  assert.equal(reader.units('z'), 1);          // one full note
  assert.equal(reader.units('x'), 2);          // longer line, longer note
  assert.equal(reader.units('c'), 3);
  assert.equal(reader.units('q'), 0.5);        // short (half) note
  assert.equal(reader.units('w'), 1);
  assert.equal(reader.units('zz'), 2);         // joined notes add up
  assert.equal(reader.units('x.'), 3);         // breath mark ~ one full note
  assert.equal(reader.units('a'), 0.25);       // fast transition (minimum length)
});

test('breaths are expected at new lines and after breath marks only', () => {
  const w = Array.from(reader.breathWeights(['zx.', 'c', 'x', 'z'], [false, false, false, true]));
  assert.deepEqual(w, [0, 1, -0.25, 1]);
});

// A synthetic cantor: each piece is a sung tone lasting its notation length, starting on a
// short consonant gap; breath marks and new lines get a real pause before the next piece.
function synth(glyphs, lineStart, secPerUnit = 0.55, rate = 4000, lead = 1.5, tail = 1.5) {
  const truth = [], chunks = [new Float32Array(Math.round(lead * rate))];
  let t = lead, f = 196;
  glyphs.forEach((g, i) => {
    if (i && (lineStart[i] || glyphs[i - 1].endsWith('.'))) { chunks.push(new Float32Array(Math.round(0.45 * rate))); t += 0.45; }
    truth.push(t);
    const sung = reader.units(g.replace(/\.$/, '')) * secPerUnit, n = Math.round(sung * rate);
    const tone = new Float32Array(n);
    f = f * (i % 3 === 0 ? 1.12 : 0.95);
    for (let k = 0; k < n; k++) {
      const env = Math.min(1, k / (0.05 * rate)) * (k < 0.04 * rate ? 0.15 : 1);
      tone[k] = 0.3 * env * (Math.sin(2 * Math.PI * f * k / rate) + 0.3 * Math.sin(4 * Math.PI * f * k / rate));
    }
    chunks.push(tone); t += sung;
  });
  chunks.push(new Float32Array(Math.round(tail * rate)));
  const pcm = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return { pcm, truth };
}

test('reads a synthetic recording and times every piece', () => {
  const glyphs = ['z', 'x', 'zc.', 'x', 'q', 'w', 'x.', 'c', 'z', 'x', 'xx.', 'z', 'c', 'x', 'v.', 'x', 'z', 'zc', 'x.'];
  const lineStart = glyphs.map((_, i) => i === 7 || i === 15);
  const { pcm, truth } = synth(glyphs, lineStart);
  const { times, duration } = reader.read({ pcm, rate: 4000, glyphs, lineStart });
  assert.equal(times.length, glyphs.length);
  assert.ok(times.every((t, i) => t >= 0 && t < duration && (!i || t >= times[i - 1])));
  const errs = times.map((t, i) => Math.abs(t - truth[i]));
  const within = errs.filter(e => e <= 0.3).length / errs.length;
  assert.ok(within >= 0.8, `only ${(within * 100).toFixed(0)}% of pieces within 0.3 s: ${errs.map(e => e.toFixed(2))}`);
});

test('the editor clip limits where the hymn is searched for', () => {
  const glyphs = ['z', 'x', 'c.', 'x', 'z', 'x.'];
  const { pcm } = synth(glyphs, glyphs.map(() => false), 0.5, 4000, 3, 6);
  const { times } = reader.read({ pcm, rate: 4000, glyphs, lineStart: glyphs.map(() => false), clip: { start: 2.5, end: 9 } });
  assert.ok(times[0] >= 2.5 && times.at(-1) < 9);
});

test('the worker hands Hazzat pieces to the reader', () => {
  const ctx = load();
  runInNewContext(readFileSync(new URL('dist/client/alignment-worker.js', root), 'utf8'), ctx);
  const glyphs = ['z', 'x', 'c.', 'x'];
  const { pcm } = synth(glyphs, [false, false, false, false]);
  const parts = glyphs.map((g, i) => ({ label: 'Piece ' + (i + 1), weight: 1, glyph: g, font: 'HazzatFont', stack: 0 }));
  const result = ctx.RecordingAlignment.analyze({ pcm, rate: 4000, parts, glyphs, lineStart: [false, false, false, false] });
  assert.equal(result.method, 'hazzat-reader');
  assert.equal(result.times.length, 4);
  // Word sections still use the phrase estimate.
  const words = ctx.RecordingAlignment.analyze({ pcm, rate: 4000, parts: [{ label: 'one', weight: 1 }, { label: 'two', weight: 1 }] });
  assert.equal(words.method, 'phrase-estimate');
});

test('the server keeps the reader method on saved suggestions', async () => {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0000_complete_caretaker', '0001_hymn_text', '0002_coptic_text', '0003_section_recordings', '0004_alignment_suggestions']) db.exec(readFileSync(new URL('drizzle/' + f + '.sql', root), 'utf8'));
  const wrap = (sql, values = []) => ({ bind(...a) { return wrap(sql, a); }, async first() { return db.prepare(sql).get(...values) || null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const r = db.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; } });
  const blobs = new Map();
  const env = { DB: { prepare: wrap, async batch(s) { db.exec('BEGIN'); try { const out = []; for (const x of s) out.push(await x.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } }, BUCKET: { async put(k, b) { blobs.set(k, await new Response(b).arrayBuffer()); }, async head(k) { return blobs.has(k) ? {} : null; }, async get(k) { const d = blobs.get(k); return d ? { body: d, writeHttpMetadata: h => h.set('content-type', 'audio/wav') } : null; } }, ASSETS: { fetch: () => new Response('asset') } };
  const hymn = 'annual/test/reader';
  const req = async (path, method = 'GET', body) => {
    const headers = { 'oai-authenticated-user-email': 'mikezaki174@gmail.com' };
    if (body) headers['content-type'] = body instanceof Uint8Array ? 'audio/wav' : 'application/json';
    const r = await app.fetch(new Request('https://test.local' + path, { method, headers, body: body ? (body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined }), env);
    return { status: r.status, ...(await r.json()) };
  };
  await req('/api/project?hymnId=' + hymn, 'PUT', { title: 'T', season: 'annual', service: 'test', timings: [], copticTimings: [], hazzatTimings: [null, null], hazzatLineTimings: [], textContent: '', copticText: '', notationHtml: '<span class="HazzatFont">z x</span>', recordingUrl: 'https://media.tasbeha.org/mp3/test.mp3' });
  await req('/api/upload/audio?hymnId=' + hymn + '&section=hazzat', 'PUT', new Uint8Array([1, 2, 3]));
  let job = (await req('/api/alignment-suggestions?hymnId=' + hymn)).suggestions.find(j => j.section === 'hazzat');
  const act = (j, action, b = {}) => req('/api/alignment-suggestions?hymnId=' + hymn, 'POST', { id: j.id, version: j.version, action, ...b });
  job = (await act(job, 'prepare', { parts: [{ label: 'Piece 1', weight: 1, glyph: 'z', font: 'HazzatFont', stack: 0, line: true }, { label: 'Piece 2', weight: 1, glyph: 'x', font: 'HazzatFont', stack: 0, line: false }], signature: 's', granularity: 'piece' })).suggestion;
  const saved = (await act(job, 'result', { times: [0.5, 1.5], duration: 4, method: 'hazzat-reader', message: 'Read from the Hazzat.' })).suggestion;
  assert.equal(saved.method, 'hazzat-reader');
  assert.deepEqual(saved.times, [0.5, 1.5]);
});
