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
