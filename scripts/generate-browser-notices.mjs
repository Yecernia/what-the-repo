import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n');

export function browserNotices() {
  const inventory = JSON.parse(read('licenses/npm-inventory.json'));
  const packages = inventory.packages.filter((pkg) => pkg.uses.some((use) => use.scope === 'web' && !use.dev));
  const paths = new Set(packages.flatMap((pkg) => pkg.notices.map((notice) => notice.path)));
  for (const asset of JSON.parse(read('licenses/assets.json')).assets) {
    for (const notice of asset.notices) paths.add(notice);
  }
  paths.add('licenses/upstream/sketchyicons-NOTICE.txt');
  let text = 'what-the-repo — browser distribution notices\n\nOriginal project code: MIT, copyright 2026 Yecernia.\nThird-party materials retain their own terms. Logos do not imply endorsement.\n\n';
  text += 'Browser runtime dependencies (unmodified npm packages):\n';
  text += packages.map((pkg) => `${pkg.name}@${pkg.version}: ${pkg.license}`).join('\n') + '\n\n';
  text += read('licenses/ASSETS.md') + '\n';
  for (const path of [...paths].sort()) {
    text += '\n============================================================\n' + path;
    text += '\n============================================================\n\n' + read(path) + '\n';
  }
  return text.replace(/[\t ]+$/gm, '').trimEnd() + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(join(root, 'web/public/third-party-notices.txt'), browserNotices());
  console.log('Updated browser-distributed copyright and license notices.');
}
