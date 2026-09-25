// Regenerates the tab icons and app icon in web/public from the product mark in web/src/brand-mark.ts,
// then updates their checksums in licenses/assets.json. Run from the repository root after `npm ci` in web/:
//   node scripts/generate-brand-icons.mjs
// PNG and ICO files are rendered with the installed Microsoft Edge through web/'s Playwright.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'web');
const requireFromWeb = createRequire(join(web, 'package.json'));
const { createServer } = await import(pathToFileURL(requireFromWeb.resolve('vite')).href);
const { chromium } = requireFromWeb('playwright');

const vite = await createServer({ root: web, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, entries: [] } });
const { BRAND_MARK: m } = await vite.ssrLoadModule('/src/brand-mark.ts');
await vite.close();

const GREEN = '#39815a';
const PAPER = '#f2ecdf';

const DOT = '#ea6a3b';

/** The mark as a standalone SVG. `done` shows the learner after the work: page tucked back into the folder,
 * arm resting on its edge, the two "got it" lines by the head, and an orange reminder dot in the corner. */
function markSvg({ color, done = false, style = '', background = null, extra = '', viewBox = '0 0 44 44' }) {
  const tuck = done ? ' transform="translate(.6 11)"' : '';
  const page = `<g${tuck}><path d="${m.page}"/>${m.pageLines.map(d => `<path d="${d}"/>`).join('')}</g>`;
  const person = `<path d="${m.head}"/><path d="${m.body}"/><path d="${done ? m.restingArm : m.arm}"/>`
    + (done ? m.insight.map(d => `<path d="${d}"/>`).join('') : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${viewBox}"${extra}>${style}`
    + '<defs>'
    + `<mask id="folder" maskUnits="userSpaceOnUse" x="-10" y="-10" width="64" height="64"><rect x="-10" y="-10" width="64" height="64" fill="#fff"/><path d="${m.pageShape}"${tuck}/><path d="${m.frontShape}"/></mask>`
    + `<mask id="page" maskUnits="userSpaceOnUse" x="-10" y="-10" width="64" height="64"><rect x="-10" y="-10" width="64" height="64" fill="#fff"/><path d="${m.frontShape}"/></mask>`
    + '</defs>'
    + (background ? `<rect x="-10" y="-10" width="64" height="64" fill="${background}"/>` : '')
    + `<g fill="${color}" fill-rule="evenodd">`
    + `<path d="${m.back}" mask="url(#folder)"/><g mask="url(#page)">${page}</g>`
    + `<path d="${m.front}"/>${person}`
    + '</g>'
    + (done ? `<circle cx="38" cy="7" r="5.6" fill="${DOT}"/>` : '')
    + '</svg>\n';
}

const ink = ({ done = false } = {}) => markSvg({ color: 'currentColor', done,
  style: '<style>:root{color:#161713}@media(prefers-color-scheme:dark){:root{color:#ffffff}}</style>' });

const files = {
  'web/public/favicon-ink.svg': ink(),
  'web/public/favicon-done.svg': ink({ done: true }),
  'web/public/favicon.svg': markSvg({ color: GREEN }),
  'web/public/app-icon.svg': markSvg({ color: GREEN }),
};
for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const favicon = await png(markSvg({ color: GREEN, background: PAPER }), 64);
const faviconDone = await png(markSvg({ color: GREEN, background: PAPER, done: true }), 64);
// The app icon keeps a margin so launchers can round its corners without clipping the drawing.
const appIcon = await png(markSvg({ color: GREEN, background: PAPER, viewBox: '-5 -5 54 54' }), 1024);
await browser.close();

// A one-image ICO that simply wraps the 64 px PNG.
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt8(64, 6); header.writeUInt8(64, 7); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(favicon.length, 14); header.writeUInt32LE(22, 18);
const binaries = {
  'web/public/favicon.png': favicon,
  'web/public/favicon-done.png': faviconDone,
  'web/public/app-icon-1024.png': appIcon,
  'web/public/favicon.ico': Buffer.concat([header, favicon]),
};
for (const [path, bytes] of Object.entries(binaries)) writeFileSync(join(root, path), bytes);

// Keep the asset inventory in step with what was just written.
const inventoryPath = join(root, 'licenses/assets.json');
const raw = readFileSync(inventoryPath, 'utf8');
const inventory = JSON.parse(raw);
for (const path of [...Object.keys(files), ...Object.keys(binaries)]) {
  const sha256 = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  const entry = inventory.assets.find(asset => asset.path === path);
  if (entry) { entry.sha256 = sha256; continue; }
  // New files go next to the other tab icons.
  const after = inventory.assets.findIndex(asset => asset.path === 'web/public/favicon.svg');
  inventory.assets.splice(after + 1, 0, { path, sha256, source: 'what-the-repo project assets', license: 'Project license to the extent rights apply',
    evidence: 'Project branding/illustration assets; not a third-party npm dependency.', notices: ['LICENSE'] });
}
writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
console.log('Brand icons regenerated.');
