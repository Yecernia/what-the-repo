import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserNotices } from './generate-browser-notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventory = JSON.parse(read('licenses/npm-inventory.json'));
const assets = JSON.parse(read('licenses/assets.json'));
const occurrences = new Map();
const notices = new Set();

for (const source of JSON.parse(read('licenses/upstream-sources.json'))) {
  assert.equal(hash(read(source.path)), source.sha256, `Upstream license changed: ${source.path}`);
}

for (const manifest of inventory.manifests) {
  assert.equal(hash(Buffer.from(read(manifest.path).toString('utf8').replace(/\r\n/g, '\n'))), manifest.sha256,
    `Manifest changed; update the license inventory: ${manifest.path}`);
  if (!manifest.path.endsWith('/package-lock.json')) continue;
  const scope = manifest.path.slice(0, -'/package-lock.json'.length);
  const lock = JSON.parse(read(manifest.path));
  assert.equal(lock.packages[''].license, 'MIT', `${scope}: root package license`);
  for (const [location, value] of Object.entries(lock.packages)) {
    if (!location) continue;
    occurrences.set(`${scope}:${location}`, {
      name: value.name || location.split('node_modules/').at(-1),
      version: value.version, dev: !!value.dev, optional: !!value.optional,
    });
  }
}

const packageIds = new Set();
const partial = [];
for (const pkg of inventory.packages) {
  const id = `${pkg.name}@${pkg.version}`;
  assert(!packageIds.has(id), `Duplicate package: ${id}`);
  packageIds.add(id);
  assert(typeof pkg.license === 'string' && pkg.license.length, `Missing license: ${id}`);
  assert(['notice-collected', 'metadata-only-or-partial'].includes(pkg.noticeStatus),
    `Invalid notice status: ${id}`);
  if (pkg.noticeStatus === 'notice-collected') assert(pkg.notices.length, `Missing notice: ${id}`);
  else partial.push(id);
  for (const use of pkg.uses) {
    const key = `${use.scope}:${use.location}`;
    assert.deepEqual(occurrences.get(key), {
      name: pkg.name, version: pkg.version, dev: use.dev, optional: use.optional,
    }, `Lockfile occurrence mismatch: ${key}`);
    occurrences.delete(key);
  }
  for (const notice of pkg.notices) {
    assert(/^licenses\/npm\/[a-f0-9]{64}\.txt$/.test(notice.path), `Invalid notice path: ${id}`);
    if (!notices.has(notice.path)) {
      assert.equal(hash(read(notice.path)), notice.sha256, `Notice hash mismatch: ${id}`);
      notices.add(notice.path);
    }
  }
}
assert.equal(occurrences.size, 0, 'Some lockfile packages are not inventoried');

const assetPaths = new Set();
for (const asset of assets.assets) {
  assert(!assetPaths.has(asset.path), `Duplicate asset: ${asset.path}`);
  assetPaths.add(asset.path);
  assert.equal(hash(read(asset.path)), asset.sha256, `Asset changed: ${asset.path}`);
  assert(asset.source && asset.license && asset.evidence && asset.notices.length,
    `Missing provenance: ${asset.path}`);
  for (const notice of asset.notices) assert(read(notice).length, `Empty asset notice: ${notice}`);
}
function checkAssets(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) checkAssets(path);
    else if (/\.(svg|png|webp|woff2?|ttf|eot)$/.test(entry.name)) {
      assert(assetPaths.has(path), `Unrecorded visual asset: ${path}`);
    }
  }
}
checkAssets('web/public');
// Imported source no longer contains unused Vite template assets.
for (const dir of ['web/src']) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(path);
      else if (/\.(svg|png|webp|woff2?|ttf|eot)$/.test(entry.name)) {
        assert(assetPaths.has(path), `Unrecorded source asset: ${path}`);
      }
    }
  }
}
assert(read('LICENSE').includes('Copyright (c) 2026 Yecernia'), 'Preserve the original project copyright');
assert(read('THIRD_PARTY_NOTICES.md').length, 'Missing third-party notices');
assert.equal(read('web/public/third-party-notices.txt').toString('utf8').replace(/\r\n/g, '\n'), browserNotices(),
  'Browser notices are stale; run node scripts/generate-browser-notices.mjs');
console.log(`License records verified: ${packageIds.size} npm versions, ${assetPaths.size} visual assets, ${notices.size} distinct npm notice files.`);
console.log(`Declared-only / partial notices: ${partial.length}; see licenses/DISTRIBUTION.md. This is not binary redistribution clearance.`);
if (process.argv.includes('--distribution') && partial.length) {
  console.error(`Distribution review required for: ${partial.join(', ')}`);
  process.exitCode = 1;
}
