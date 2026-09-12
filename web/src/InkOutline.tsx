import { useId, useLayoutEffect, useRef } from 'react';
import { penPath, type PenPoint } from './pen-path';

/** Paper and ink have separate edges. Measure layout size, never the graph's zoom. */
export function InkOutline({ paper = false, aged = false }: { paper?: boolean; aged?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const patternId = `paper-${useId().replace(/:/g, '')}`;
  // Write all contours in the observer's pre-paint phase. React state here can
  // leave a new viewport displaying old geometry for one frame.
  useLayoutEffect(() => {
    const svg = ref.current;
    const parent = svg?.parentElement;
    if (!svg || !parent) return;
    let lastWidth = 0, lastHeight = 0;
    const measure = () => {
      const width = parent.clientWidth, height = parent.clientHeight;
      if (!width || !height || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width; lastHeight = height;
      const geometry = paperGeometry(width, height, paper);
      svg.querySelectorAll<SVGPathElement>('[data-paper-contour]').forEach(path => {
        path.setAttribute('d', path.dataset.paperContour === 'ink' ? geometry.ink : geometry.sheet);
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [paper, aged]);
  return <svg ref={ref} className={`ink-outline${paper ? ' ink-outline-paper' : ''}`} aria-hidden="true" focusable="false">
    <defs><pattern id={patternId} patternUnits="userSpaceOnUse" width={aged ? 300 : 540} height={aged ? 300 : 540}><image href="/paper-folds.png" width={aged ? 300 : 540} height={aged ? 300 : 540} /></pattern>
      {aged && <pattern id={patternId + '-wear'} patternUnits="userSpaceOnUse" width="900" height="600">
        {wornFibers.map((fiber, index) => <path key={index} d={fiber.d} fill="#f4f2e9" opacity={fiber.opacity} />)}
      </pattern>}
    </defs>
    <path className="paper-shadow" data-paper-contour="sheet" transform="translate(1.5 3)" />
    <path className="paper-face" data-paper-contour="sheet" />
    <path className="paper-folds" data-paper-contour="sheet" fill={`url(#${patternId})`} />
    {aged && <path className="paper-wear" data-paper-contour="sheet" fill={`url(#${patternId}-wear)`} />}
    <path className="ink-stroke" data-paper-contour="ink" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
  </svg>;
}

function paperGeometry(w: number, h: number, paper: boolean) {
  const m = paper ? 7 : 3.5;
  const radius = Math.min(12, (h - 2 * m) / 4);
  const top = m + radius, bottom = h - m - radius;
  const third = (bottom - top) / 3;
  const points: PenPoint[] = [
    [m + radius, m + .4, .85], [w * .24, m + 1.5, 1.2], [w * .48, m - .3, .9],
    [w * .72, m + 1.1, 1.18], [w - m - radius, m, .8], [w - m, top, 1.25],
    [w - m - 1, top + third, .78], [w - m + .3, bottom - third, 1.15], [w - m - 1.5, bottom, .85],
    [w - m - radius, h - m, 1.18], [w * .73, h - m - 1.1, .8], [w * .46, h - m + .3, 1.3],
    [w * .22, h - m - 1, .95], [m + radius, h - m - .2, 1.2], [m - .5, bottom, .82],
    [m + 1, bottom - third, 1.2], [m - .3, top + third, .85], [m + .5, top, 1.1],
  ];
  const cut = paper ? 3 : 1.4;
  const sheet: PenPoint[] = [
    [4, 3], [w * .08, 0], [w * .2, cut * .4], [w * .31, -cut],
    [w * .43, -.4], [w * .53, cut * .5], [w * .68, -cut * .6], [w * .82, 0],
    [w * .94, -1], [w - 2, 4], [w + 1, h * .12], [w - cut * .75, h * .26],
    [w + 1, h * .38], [w - cut * .5, h * .52], [w + cut * .7, h * .7],
    [w - .5, h * .85], [w - 1, h - 4], [w * .9, h + cut * .5],
    [w * .75, h - 1], [w * .63, h + cut * .7], [w * .49, h - .5],
    [w * .33, h + cut * .75], [w * .2, h - .8], [w * .08, h + cut * .6],
    [1, h - 4], [-cut * .7, h * .89], [cut * .45, h * .71],
    [-cut * .55, h * .54], [1, h * .36], [-cut * .65, h * .21], [-.6, h * .08],
  ];
  return { ink: penPath(points, paper ? 1.55 : 1.45, true), sheet: sheet.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('') + 'Z' };
}

/** Small torn facets clustered around folds, with gaps and frayed tips, not pen strokes.
 * A fixed seed keeps the fibers still while typing; a large tile avoids regular repeats. */
const wornFibers = (() => {
  let seed = 73;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const patches = [[45, 51, 32, 43], [137, 77, 38, 39], [278, 36, -35, 31], [427, 70, 38, 41], [567, 31, -28, 34], [711, 85, -19, 45], [841, 49, 32, 39],
    [159, 207, 31, 35], [493, 246, 36, 42], [341, 351, 29, 38], [738, 374, 41, 46], [117, 433, -21, 40]];
  return patches.flatMap(([x, y, angle, length]) => {
    const radians = angle * Math.PI / 180;
    const point = (u: number, v: number) => `${(x + u * Math.cos(radians) - v * Math.sin(radians)).toFixed(2)} ${(y + u * Math.sin(radians) + v * Math.cos(radians)).toFixed(2)}`;
    return Array.from({ length: 48 }, () => {
      const u = (random() - .5) * length;
      const spread = (1 - Math.abs(u) / (length / 2)) * 2.2;
      const v = (random() - .5) * spread;
      const size = .35 + random() * 2.1;
      const width = .15 + random() * .55;
      const splinter = random() > .8 ? (random() - .5) * 3 : 0;
      return {
        d: 'M' + point(u, v) + 'L' + point(u + size * .35, v - width) + 'L' + point(u + size * .56, v - width * .3) + 'L' + point(u + size, v + splinter) + 'L' + point(u + size * .5, v + width * .45) + 'Z',
        opacity: .2 + random() * .65,
      };
    });
  });
})();
