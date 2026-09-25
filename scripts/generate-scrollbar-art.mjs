// Regenerates the desktop scrollbar thumb images in web/src/index.css from web/src/scroll-ink.ts.
// Each image is a tapered start, a short even middle and a tapered end; the CSS paints it as a
// border-image so the ends keep their size and the middle repeats instead of stretching. Run from the repository
// root with Node 22.18+ (TypeScript is loaded directly):
//   node scripts/generate-scrollbar-art.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { scrollInkPath, SCROLL_INK_CAP, SCROLL_INK_TILE } = await import(pathToFileURL(join(root, 'web/src/scroll-ink.ts')).href);

const WIDTH = 12;
const LENGTH = SCROLL_INK_CAP * 2 + SCROLL_INK_TILE;
const ink = scrollInkPath(LENGTH, { width: WIDTH, weight: 1.15 });

const svg = (color, horizontal, weight) => {
  const [w, h] = horizontal ? [LENGTH, WIDTH] : [WIDTH, LENGTH];
  const transform = horizontal ? ' transform="matrix(0 1 1 0 0 0)"' : '';
  const ink = scrollInkPath(LENGTH, { width: WIDTH, weight });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${ink}"${transform} fill="${color}"/></svg>`;
};
const url = text => `url("data:image/svg+xml,${encodeURIComponent(text).replace(/'/g, '%27')}")`;
// Brown-black ink; pointing at it deepens it a little and dragging it turns it into the app's green, pressed
// harder (a heavier stroke), so the thumb clearly answers the pointer. The dark theme uses a warm light ink.
const themes = [
  { idle: '#5a4332', hover: '#3e2c20', active: '#39815a' }, // light (:root)
  { idle: '#b9a994', hover: '#d8c9b3', active: '#8cca98' }, // dark
];
const WEIGHT = { idle: 1.15, hover: 1.3, active: 1.55 };

const cssPath = join(root, 'web/src/index.css');
const css = readFileSync(cssPath, 'utf8');
// The light declarations (:root) come before the dark ones; each name appears once per theme.
const seen = new Map();
const next = css.replace(/(--scrollbar-(vertical|horizontal)(?:-(hover|active))?): url\("data:image\/svg\+xml,[^"]*"\);/g,
  (_match, name, axis, state = 'idle') => {
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    const theme = themes[index];
    if (!theme) throw new Error(`unexpected extra ${name} declaration`);
    return `${name}: ${url(svg(theme[state], axis === 'horizontal', WEIGHT[state]))};`;
  });
if ([...seen.values()].length !== 6 || [...seen.values()].some(count => count !== themes.length)) {
  throw new Error('expected every scrollbar image once for the light and the dark theme');
}
writeFileSync(cssPath, next);
console.log('Scrollbar art regenerated.');
