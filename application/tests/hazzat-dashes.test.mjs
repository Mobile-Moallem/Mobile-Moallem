import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Loads the dash table and splitter from site.js without a browser.
const site = readFileSync(new URL('../dist/client/site.js', import.meta.url), 'utf8');
const code = site.slice(site.indexOf('const HAZZAT_DASHES'), site.indexOf('// A piece with no dash'));
const ctx = {}; runInNewContext(code + '\nglobalThis.hazzatDashes = hazzatDashes;', ctx);
const count = t => ctx.hazzatDashes(t, 'HazzatFont').length;

test('each black dash of the Hazzat gets its own hit box', () => {
  assert.equal(count('z'), 1);
  assert.equal(count('x'), 2);     // two stacked dashes
  assert.equal(count('c'), 3);
  assert.equal(count('m'), 7);
  assert.equal(count('w'), 2);     // short (half) dashes stack too
  assert.equal(count('z.c.'), 4);  // breath marks are not dashes
  assert.equal(count('a'), 0);     // a transition is not a dash
});

test('a continuation stroke lengthens the dash before it instead of adding one', () => {
  assert.equal(count('xs'), 2);    // s continues the top dash of x
  assert.equal(count('ed'), 3);    // d continues the top dash of e
  assert.equal(count('zz'), 1);    // two full dashes side by side draw one long dash
  assert.equal(count('zc'), 3);    // z runs straight into the bottom dash of c
  assert.equal(count('zs'), 2);    // s is higher than z: a new dash
  assert.equal(count('z.s'), 2);   // separated by a breath: not joined
});

test('the vertical Hazzat font keeps one box per piece', () => {
  assert.equal(ctx.hazzatDashes('zc', 'HazzatVFont').length, 0);
});
