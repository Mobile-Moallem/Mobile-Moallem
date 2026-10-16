import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../dist/client/site.js', import.meta.url), 'utf8');
const context = {};
runInNewContext(source.slice(source.indexOf('function hazzatHitTokens('), source.indexOf('function safeHazzat(')), context);
const id = 'annual/liturgy-of-the-word/al-el-qorban';
const tokens = text => Array.from(context.hazzatHitTokens(text, id)).filter(x => x && x.trim());
test('the two reported joined passages split into two and three stacks', () => {
  assert.deepEqual(tokens('zc.x'), ['zc.', 'x']);
  assert.deepEqual(tokens('xx.zqedd.zqw'), ['xx.', 'zqedd.', 'zqw']);
});
test('all Al El Qorban notation is preserved and internal stack boundaries split', () => {
  const catalog = JSON.parse(readFileSync(new URL('../dist/client/catalog/annual.json', import.meta.url)));
  const hymn = catalog.flatMap(s => s.hymns).find(h => h.id === 'al-el-qorban');
  const html = hymn.formats['2'][0].content.copticHazzat;
  let extra = 0;
  for (const match of html.matchAll(/<span class="HazzatFont">([^<]*)<\/span>/g)) {
    const text = match[1];
    const split = Array.from(context.hazzatHitTokens(text, id));
    assert.equal(split.join(''), text);
    assert.ok(tokens(text).every(t => !/\.[^)]/.test(t)));
    extra += tokens(text).length - text.split(/\s+/).filter(Boolean).length;
  }
  assert.ok(extra > 20);
});
test('all hymns split joined stacks while repeat endings and double dots stay attached', () => {
  assert.deepEqual(Array.from(context.hazzatHitTokens('xx.zc x.)2', 'another-hymn')), ['xx.', 'zc', ' ', 'x.)2']);
  assert.deepEqual(tokens('x.)2'), ['x.)2']);
  assert.deepEqual(tokens('edd..w'), ['edd..', 'w']);
});
test('migration preserves existing times, leaves new stacks null, and maps repeat ranges', () => {
  const h = { id: 'annual/other', hazzatTimings: [1, 4, 8], repeatSections: [
    { key: 'hazzatTimings', startIndex: 1, endIndex: 2, passes: [[14, 18]] },
    { key: 'timings', startIndex: 0, endIndex: 0, passes: [[20]] }
  ] };
  context.migrateHazzatHitBoxes(h, '<span>notation</span>', [2, 3, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.hazzatTimings)), [1, null, 4, null, null, 8]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.repeatSections[0])), {
    key: 'hazzatTimings', startIndex: 2, endIndex: 5, passes: [[14, null, null, 18]]
  });
  assert.equal(h.repeatSections[1].startIndex, 0);
  const saved = JSON.stringify(h);
  context.migrateHazzatHitBoxes(h, h.notationHtml, [2, 3, 1]);
  assert.equal(JSON.stringify(h), saved);
});
test('Al El Qorban already uses split indices and is not migrated again', () => {
  const h = { id, hazzatTimings: [1, 2, 3] };
  context.migrateHazzatHitBoxes(h, 'notation', [3]);
  assert.deepEqual(h.hazzatTimings, [1, 2, 3]);
});
