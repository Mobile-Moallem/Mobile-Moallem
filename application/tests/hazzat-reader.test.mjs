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

test('repeat marks in the Hazzat are sung again, and each pass is timed', () => {
  const glyphs = ['z', '(x', 'zc.', 'x)2', 'c', 'x.'];
  assert.deepEqual(JSON.parse(JSON.stringify(reader.repeatGroups(glyphs))), [{ start: 1, end: 3, times: 2 }]);
  // ')2' at the start of a piece closes the group before it
  assert.deepEqual(JSON.parse(JSON.stringify(reader.repeatGroups(['(z', 'x.', ')2zz.', 'x']))), [{ start: 0, end: 1, times: 2 }]);
  const order = JSON.parse(JSON.stringify(reader.sungOrder(glyphs).map(([i]) => i)));
  assert.deepEqual(order, [0, 1, 2, 3, 1, 2, 3, 4, 5]);
  const sung = order.map(i => glyphs[i]);
  const { pcm, truth } = synth(sung, order.map((i, k) => k > 0 && order[k - 1] !== i - 1));
  const { times, repeats } = reader.read({ pcm, rate: 4000, glyphs, lineStart: glyphs.map(() => false) });
  assert.equal(times.length, glyphs.length);
  assert.equal(repeats.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify([repeats[0].key, repeats[0].startIndex, repeats[0].endIndex, repeats[0].passes.length])), ['hazzatTimings', 1, 3, 1]);
  const second = repeats[0].passes[0];
  assert.ok(second[0] > times[3], 'the second pass starts after the first pass ends');
  const all = [times[0], times[1], times[2], times[3], ...second, times[4], times[5]];
  const errs = all.map((t, k) => Math.abs(t - truth[k]));
  assert.ok(errs.filter(e => e <= 0.3).length >= errs.length - 1, 'pieces within 0.3 s: ' + errs.map(e => e.toFixed(2)));
});

function server() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0000_complete_caretaker', '0001_hymn_text', '0002_coptic_text', '0003_section_recordings', '0004_alignment_suggestions']) db.exec(readFileSync(new URL('drizzle/' + f + '.sql', root), 'utf8'));
  const wrap = (sql, values = []) => ({ bind(...a) { return wrap(sql, a); }, async first() { return db.prepare(sql).get(...values) || null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const r = db.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; } });
  const blobs = new Map();
  const env = { DB: { prepare: wrap, async batch(s) { db.exec('BEGIN'); try { const out = []; for (const x of s) out.push(await x.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } }, BUCKET: { async put(k, b) { blobs.set(k, await new Response(b).arrayBuffer()); }, async head(k) { return blobs.has(k) ? {} : null; }, async get(k) { const d = blobs.get(k); return d ? { body: d, writeHttpMetadata: h => h.set('content-type', 'audio/wav') } : null; } }, ASSETS: { fetch: () => new Response('asset') } };
  const hymn = 'annual/test/repeats';
  const req = async (path, method = 'GET', body) => {
    const headers = { 'oai-authenticated-user-email': 'mikezaki174@gmail.com' };
    if (body) headers['content-type'] = body instanceof Uint8Array ? 'audio/wav' : 'application/json';
    const r = await app.fetch(new Request('https://test.local' + path, { method, headers, body: body ? (body instanceof Uint8Array ? body : JSON.stringify(body)) : undefined }), env);
    return { status: r.status, ...(await r.json()) };
  };
  const project = { title: 'T', season: 'annual', service: 'test', timings: [], copticTimings: [], hazzatTimings: [null, null, null], hazzatLineTimings: [], textContent: '', copticText: '',
    notationHtml: '<span class="HazzatFont">(z x)2 c</span>', recordingUrl: 'https://media.tasbeha.org/mp3/test.mp3',
    repeatSections: [{ key: 'timings', startIndex: 0, endIndex: 0, passes: [[9]] }] };
  const api = '/api/alignment-suggestions?hymnId=' + hymn;
  const act = (j, action, b = {}) => req(api, 'POST', { id: j.id, version: j.version, action, ...b });
  const parts = [{ label: 'Piece 1', weight: 1, glyph: '(z', font: 'HazzatFont', stack: 0, line: true }, { label: 'Piece 2', weight: 1, glyph: 'x)2', font: 'HazzatFont', stack: 0, line: false }, { label: 'Piece 3', weight: 1, glyph: 'c', font: 'HazzatFont', stack: 0, line: false }];
  async function pending(repeats) {
    await req('/api/project?hymnId=' + hymn, 'PUT', project);
    await req('/api/upload/audio?hymnId=' + hymn + '&section=hazzat', 'PUT', new Uint8Array([1, 2, 3]));
    let job = (await req(api)).suggestions.find(j => j.section === 'hazzat');
    job = (await act(job, 'prepare', { parts, signature: 's', granularity: 'piece' })).suggestion;
    return act(job, 'result', { times: [1, 2, 5], repeats, duration: 9, method: 'hazzat-reader' });
  }
  return { req, act, pending, hymn, project };
}

test('accepting a reader suggestion also saves its repeat passes and keeps other channels', async () => {
  const s = server();
  const repeats = [{ key: 'hazzatTimings', startIndex: 0, endIndex: 1, passes: [[3, 4]] }];
  const saved = await s.pending(repeats);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.suggestion.repeats, repeats);
  const accepted = await s.act(saved.suggestion, 'accept', { times: [1, 2, 5], signature: 's' });
  assert.equal(accepted.status, 200, accepted.error);
  assert.deepEqual(accepted.project.hazzatTimings, [1, 2, 5]);
  assert.deepEqual(accepted.project.repeatSections, [{ key: 'timings', startIndex: 0, endIndex: 0, passes: [[9]] }, ...repeats]);
});

test('bad repeat passes are refused, and repeats changed by hand are never overwritten', async () => {
  const s = server();
  for (const bad of [[{ key: 'hazzatTimings', startIndex: 0, endIndex: 5, passes: [[1, 2, 3, 4, 5, 6]] }],
    [{ key: 'hazzatTimings', startIndex: 0, endIndex: 1, passes: [[4, 3]] }],
    [{ key: 'hazzatTimings', startIndex: 0, endIndex: 1, passes: [[3, 99]] }],
    [{ key: 'timings', startIndex: 0, endIndex: 1, passes: [[3, 4]] }]]) {
    assert.equal((await s.pending(bad)).status, 400);
  }
  const saved = await s.pending([{ key: 'hazzatTimings', startIndex: 0, endIndex: 1, passes: [[3, 4]] }]);
  assert.equal(saved.status, 200);
  // An editor changes repeats by hand while the suggestion waits for review.
  const manual = [{ key: 'hazzatTimings', startIndex: 0, endIndex: 1, passes: [[3.5, 4.5]] }];
  const project = (await s.req('/api/project?hymnId=' + s.hymn)).project;
  await s.req('/api/project?hymnId=' + s.hymn, 'PUT', { ...s.project, hazzatTimings: project.hazzatTimings, repeatSections: manual });
  const refused = await s.act(saved.suggestion, 'accept', { times: [1, 2, 5], signature: 's' });
  assert.equal(refused.status, 409);
  assert.deepEqual((await s.req('/api/project?hymnId=' + s.hymn)).project.repeatSections, manual);
});

test('words only: phrase-final and half-verse words are expected to be held longer', () => {
  const words = ['Ainahi', 'e;be', 'vai@', 'aicaji', 'qen', 'oujom.', 'Bo`h;in'];
  const lineStart = [true, false, false, false, false, false, true];
  const u = Array.from(reader.wordUnits(words, lineStart));
  assert.ok(u[2] > reader.wordUnits(['vai', 'qen'], [true, false])[0] * 1.3);   // '@' half verse
  assert.ok(u[5] > u[3]);                                         // '.' ends the phrase
  assert.deepEqual(Array.from(reader.wordWeights(words, lineStart)), [0, -0.25, -0.25, 1, -0.25, -0.25, 1]);
});

test('words only: reads a synthetic recording without Hazzat', () => {
  const words = 'Ainahi e;be vai@ aicaji qen oujom@ e;be peknis] `nnai@ P[oic `nte nijom. Bo`h;in `eroi Pa[oic@ Iycouc pirefsenhyt@ e;ri]wou `nta[oic.'.split(' ');
  const lineStart = words.map((_, i) => i === 0 || i === 12);
  const units = reader.wordUnits(words, lineStart), rate = 4000, truth = [];
  const chunks = [new Float32Array(rate * 1.5)]; let t = 1.5, f = 220;
  words.forEach((w, i) => {
    if (i && /[@.]$/.test(words[i - 1])) { chunks.push(new Float32Array(Math.round(0.4 * rate))); t += 0.4; }
    truth.push(t);
    const n = Math.round(units[i] * 0.3 * rate), tone = new Float32Array(n);
    f *= i % 2 ? 1.08 : 0.94;
    for (let k = 0; k < n; k++) tone[k] = 0.3 * Math.min(1, k / (0.05 * rate)) * (k < 0.04 * rate ? 0.15 : 1) * Math.sin(2 * Math.PI * f * k / rate);
    chunks.push(tone); t += n / rate;
  });
  chunks.push(new Float32Array(rate * 1.5));
  const pcm = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
  const { times } = reader.readWords({ pcm, rate, words, lineStart });
  assert.equal(times.length, words.length);
  const within = times.filter((x, i) => Math.abs(x - truth[i]) <= 0.3).length / words.length;
  assert.ok(within >= 0.8, `only ${(within * 100).toFixed(0)}% within 0.3 s: ${times.map((x, i) => (x - truth[i]).toFixed(2))}`);
});
