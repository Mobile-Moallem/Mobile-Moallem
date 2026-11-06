import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSearchIndex, serialize } from '../dev/build-search-index.mjs';

test('home search index matches the catalog (run node dev/build-search-index.mjs to refresh)', async () => {
  const committed = await readFile(new URL('../dist/client/catalog/search-index.json', import.meta.url), 'utf8');
  assert.equal(committed, serialize(await buildSearchIndex()));
});

test('search index rows are [season/category/hymn id, name, category] and ids are unique', async () => {
  const { hymns } = await buildSearchIndex();
  assert.ok(hymns.length > 500);
  assert.equal(new Set(hymns.map(h => h[0])).size, hymns.length);
  for (const [id, name, category] of hymns) {
    assert.match(id, /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.ok(name && category);
  }
});
