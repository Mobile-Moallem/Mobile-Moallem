import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../dist/client/site.js', import.meta.url), 'utf8');
const clockSource = source.slice(source.indexOf('let latencyContext'), source.indexOf('let karaokeFrame'));

function load(latency = 0) {
  class FakeContext { constructor() { this.outputLatency = latency; this.baseLatency = 0; this.state = 'running'; } }
  const c = {window: {AudioContext: FakeContext}, WeakMap, Math, Number, performance: {now: () => 0}};
  runInNewContext(clockSource, c);
  return c;
}
const player = (currentTime, extra = {}) => ({currentTime, paused: false, seeking: false, playbackRate: 1, ...extra});

test('a paused player shows exactly where it stopped', () => {
  const c = load(0.2);
  assert.equal(c.heardTime(player(12.5, {paused: true}), 0), 12.5);
});

test('glides between the browser\'s few position reports', () => {
  const c = load();
  const p = player(10);
  assert.equal(c.heardTime(p, 1000), 10);
  assert.ok(Math.abs(c.heardTime(p, 1100) - 10.1) < 1e-9); // no new report yet, still moves
  p.playbackRate = 0.5; p.currentTime = 10.2;
  assert.ok(Math.abs(c.heardTime(p, 1300) - 10.2) < 1e-9);
  assert.ok(Math.abs(c.heardTime(p, 1500) - 10.3) < 1e-9);
});

test('a late report never pulls the highlight backwards', () => {
  const c = load();
  const p = player(5);
  c.heardTime(p, 0);
  assert.ok(Math.abs(c.heardTime(p, 240) - 5.24) < 1e-9);
  p.currentTime = 5.2; // report arrives late
  assert.ok(c.heardTime(p, 241) >= 5.24);
});

test('steps back by the output delay, but not before where playback started', () => {
  const c = load(0.2);
  const p = player(30, {paused: true});
  c.heardTime(p, 0); // tapped a mark at 30 s
  p.paused = false;
  assert.equal(c.heardTime(p, 100), 30); // would be 29.9 without the floor
  p.currentTime = 31;
  assert.ok(Math.abs(c.heardTime(p, 1000) - 30.8) < 1e-9);
});

test('the output delay is capped at half a second', () => {
  const c = load(3);
  const p = player(20);
  c.heardTime(p, 0);
  p.currentTime = 50; // a loop or seek while playing resets the floor
  assert.equal(c.heardTime(p, 10), 50);
  p.currentTime = 51.99;
  assert.ok(Math.abs(c.heardTime(p, 2000) - 51.49) < 1e-9);
});

test('no audio context means no delay correction', () => {
  const c = {window: {}, WeakMap, Math, Number, performance: {now: () => 0}};
  runInNewContext(clockSource, c);
  const p = player(8);
  c.heardTime(p, 0);
  assert.equal(c.heardTime(p, 0), 8);
});

const fillSource = source.slice(source.indexOf('function fillTimingGaps('), source.indexOf('function hazzatPlaybackTimings('));
test('untimed marks between two timed ones get a time, so none is skipped', () => {
  const c = {Math, Number, Array};
  runInNewContext(fillSource, c);
  // equal sizes: evenly spaced
  assert.deepEqual([...c.fillTimingGaps([2, null, 4, null, null, 7])], [2, 3, 4, 5, 6, 7]);
  // a longer mark gets more of the time
  assert.deepEqual([...c.fillTimingGaps([0, null, 4], [3, 1, 1])], [0, 3, 4]);
  // leading and trailing untimed marks stay untimed; the saved array is not changed
  const saved = [null, 1, null, 3, null];
  assert.deepEqual([...c.fillTimingGaps(saved)], [null, 1, 2, 3, null]);
  assert.deepEqual(saved, [null, 1, null, 3, null]);
});

const noteSource = source.slice(source.indexOf('const HAZZAT_GLYPHS'), source.indexOf('function inkHazzatRun('));
function notes() { const c = {Array, Number, Math, Object}; runInNewContext(noteSource, c); return c; }

test('a long held note drawn with several letters is one note', () => {
  const c = notes();
  assert.equal(c.hazzatRuns('zz').length, 1);       // one long bottom line
  assert.equal(c.hazzatRuns('xx').length, 2);       // two long lines, the upper one stepped
  const zqw = c.hazzatRuns('zqw');                   // a long bottom line, then a short step up at the end
  assert.equal(zqw.length, 2);
  assert.deepEqual(JSON.stringify([zqw[0].level, zqw[1].level]), '[0,1]');
  assert.ok(zqw[0].x1 - zqw[0].x0 > 2000);
  assert.equal(JSON.stringify(c.hazzatRuns('c').map(r => r.level)), '[0,1,2]'); // a three-step staircase
  assert.equal(c.hazzatRuns('x.x').length, 4);      // a dot breaks the lines
});

test('each line of a mark gets time by its own length: a held line stays lit, every step gets its turn', () => {
  const c = notes();
  const zqw = c.hazzatRuns('zqw'), filled = [10, 13, 30];
  // the long bottom line holds for ~78% of the mark, then the short step up
  for (const t of [10, 10.5, 11.1]) assert.equal(c.hazzatNoteIndex(zqw, filled, 0, t), 0);
  assert.equal(c.hazzatNoteIndex(zqw, filled, 0, 11.3), 1);
  // a single line never changes
  assert.equal(c.hazzatNoteIndex(c.hazzatRuns('zz'), filled, 1, 14), 0);
  // a three-step staircase: equal thirds, so no step is a flash; a breath after it does not stretch it
  const cc = c.hazzatRuns('c');
  assert.equal(c.hazzatNoteIndex(cc, filled, 1, 13.3), 0);
  assert.equal(c.hazzatNoteIndex(cc, filled, 1, 13.9), 1);
  assert.equal(c.hazzatNoteIndex(cc, filled, 1, 14.5), 2);
  assert.equal(c.hazzatNoteIndex(cc, filled, 1, 25), 2);
});
