// Builds dist/client/catalog/search-index.json: a small list of every catalog hymn
// ([full id, name, category name]) so the home search can find any hymn without
// downloading every season's full catalog. Run after changing catalog files:
//   node dev/build-search-index.mjs
// tests/search-index.test.mjs fails if the committed index is out of date.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const catalogDir = new URL('../dist/client/catalog/', import.meta.url);

export async function buildSearchIndex() {
  const index = JSON.parse(await readFile(new URL('index.json', catalogDir), 'utf8'));
  const seasons = Array.isArray(index) ? index : index.seasons;
  const hymns = [];
  for (const season of seasons) {
    const services = JSON.parse(await readFile(new URL(season.id + '.json', catalogDir), 'utf8'));
    for (const service of services) {
      for (const hymn of service.hymns || []) hymns.push([season.id + '/' + service.id + '/' + hymn.id, hymn.name, service.name]);
    }
  }
  return { version: 1, hymns };
}

export const serialize = data => JSON.stringify(data) + '\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await buildSearchIndex();
  await writeFile(new URL('search-index.json', catalogDir), serialize(data));
  console.log('Wrote search-index.json with ' + data.hymns.length + ' hymns');
}
