// Copies every backed-up recording/image into the STAGING R2 bucket with wrangler,
// then downloads each one again and checks size and SHA-256. Run by GitHub Actions
// (.github/workflows/staging.yml) with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
import { readFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BUCKET = 'mobile-moallem-staging-media';
if (process.argv[2] !== BUCKET) throw new Error('Pass the staging bucket name explicitly: ' + BUCKET);
const root = new URL('../live-backup/', import.meta.url).pathname;
const wrangler = ['--yes', 'wrangler@4.151.2'];
const sets = [
  { dir: 'media', objects: JSON.parse(readFileSync(root + 'objects.json')), hashes: Object.fromEntries(JSON.parse(readFileSync(root + 'COMPLETE.json')).objects.map(o => [o.key, o.sha256])) },
  { dir: 'media-added-2026-11-02', objects: JSON.parse(readFileSync(root + 'media-added-2026-11-02/objects.json')).objects },
];
const sha = b => createHash('sha256').update(b).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'r2-'));
let count = 0, bytes = 0;
for (const set of sets) for (const obj of set.objects) {
  const key = obj.key;
  if (!/^(recordings|hazzat)\/[0-9a-f-]{36}$/.test(key)) throw new Error('Unexpected key ' + key);
  const file = join(root, set.dir, key), data = readFileSync(file);
  const want = obj.sha256 || set.hashes?.[key];
  if (data.length !== obj.size || sha(data) !== want) throw new Error('Backup file does not match its record: ' + key);
  const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote'];
  const ct = obj.httpMetadata?.contentType; if (ct) args.push('--content-type', ct);
  execFileSync('npx', [...wrangler, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  const back = join(tmp, key.replace('/', '_'));
  execFileSync('npx', [...wrangler, 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', back, '--remote'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const got = readFileSync(back);
  if (got.length !== obj.size || sha(got) !== want) throw new Error('Uploaded copy does not match: ' + key);
  count++; bytes += got.length;
  console.log(`uploaded and verified ${key} (${got.length} bytes)`);
}
console.log(JSON.stringify({ bucket: BUCKET, objects: count, bytes }));
