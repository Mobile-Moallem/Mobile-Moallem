import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const context = {};
runInNewContext(readFileSync(new URL('../dist/client/paste-timings.js', import.meta.url), 'utf8'), context);
const {parse, check} = context.PasteTimings;
const values = text => Array.from(parse(text).values);

test('plain seconds separated by commas, spaces and new lines', () => {
  assert.deepEqual(values('1.5, 2\n3.25  4'), [1.5, 2, 3.25, 4]);
});

test('m:ss and h:mm:ss times', () => {
  assert.deepEqual(values('0:10.21 1:02.5 1:00:00'), [10.21, 62.5, 3600]);
});

test('dashes and null mark untimed parts', () => {
  assert.deepEqual(values('- null 3 —'), [null, null, 3, null]);
});

test('JSON array, including nulls', () => {
  assert.deepEqual(values('[null, 0.38, 0.84]'), [null, 0.38, 0.84]);
});

test('aligner output shapes', () => {
  assert.deepEqual(values(JSON.stringify({words: [{forced: 1}, {forced: 2.5}]})), [1, 2.5]);
  assert.deepEqual(values(JSON.stringify({new_timings: [4, 5]})), [4, 5]);
  assert.deepEqual(values(JSON.stringify({project: {copticTimings: [7, 8], timings: [1]}})), [7, 8]);
  assert.deepEqual(Array.from(parse(JSON.stringify({timings: [1], copticTimings: [7, 8]}), 'timings').values), [1]);
});

test('rounds to hundredths', () => {
  assert.deepEqual(values('1.234 2.236'), [1.23, 2.24]);
});

test('rejects things that are not times', () => {
  assert.match(parse('1 2 abc').error, /Item 3/);
  assert.match(parse('-1').error, /Item 1/);
  assert.match(parse('').error, /Paste/);
  assert.match(parse('[1, 2').error, /JSON/);
  assert.match(parse('{"x": 1}').error, /Could not find/);
});

test('rejects times that go backwards, ignoring untimed parts', () => {
  assert.match(parse('1 3 2').error, /Item 3.*item 2/);
  assert.equal(parse('1 - 3').error, undefined);
});

test('count must match the hymn exactly', () => {
  assert.match(check([1, 2], 3).error, /2 timings but this section has 3/);
  assert.match(check([], 0).error, /nothing to time/);
  const ok = check([null, 1, 2], 3);
  assert.equal(ok.timed, 2);
  assert.equal(ok.first, 1);
  assert.equal(ok.last, 2);
});
