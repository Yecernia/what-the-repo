import { useLayoutEffect, useState, type RefObject } from 'react';
import { smoothPath, type PenPoint } from './pen-path';

/** A box in the bench scene's own drawing units. */
export interface LawnBox { left: number; top: number; right: number; bottom: number }

/**
 * Where the login page's lawn has to reach, measured in the bench scene's drawing units: the page (left, right and
 * bottom edges) and the button whose lower part the falling lawn runs through (`dip` > 0: how high it stands there at
 * the button's middle, as a share of its height), or passes under (`dip` < 0).
 */
export interface LawnFrame { page: LawnBox; button: LawnBox | null; dip: number }

const round = (value: number) => Math.round(value * 10) / 10;

/** The right end of the scene's ground line (LAWN_MIDDLE in FieldIllustration.tsx): the bench, the top of the hill. */
export const LAWN_CREST: PenPoint = [508, 378.5];
/** How the lawn falls from the bench to the right: units down per unit across. */
const SLOPE = .06;

/** How far the left shoulder falls towards the page edge `run` units away: a gentle slope, never a hill taking over the page. */
function shoulderDrop(run: number, room: number): number {
  return Math.max(0, Math.min(run * .12, room * .3, 120));
}

/** Where the hill's right foot meets the bottom of the page, as a share of the page's width (when the button allows). */
const HILL_FOOT = .86;
/** The far meadow's top at the right edge of the page, as a share of the page's height above its bottom. */
const MEADOW_HEIGHT = .155;
/** How far the shoulder runs out to the right while it falls to the page bottom, as shares of that fall: at least, at most. */
const SHOULDER_RUN = [.55, 1] as const;

/**
 * The hill's right shoulder from `start` (just past the button): part of an ellipse, leaning a little where it
 * leaves the button and steepening as it falls, so it reads as the round side of a small hill. Its flank crosses the
 * bottom of the page near HILL_FOOT of the page's width (further out when the fall is long, so it never turns into a
 * wall); its foot lies below the page, so the shape always closes beneath it.
 */
function rightShoulder([x, y]: PenPoint, page: LawnBox): PenPoint[] {
  const width = page.right - page.left, drop = Math.max(page.bottom - y, 40);
  const run = Math.min(Math.max(page.left + width * HILL_FOOT - x, drop * SHOULDER_RUN[0]), drop * SHOULDER_RUN[1]);
  // From angle `from` (where it leaves the button) to `cross` (where it crosses the page bottom) on the ellipse.
  const from = .1, cross = 1.22;
  const rx = run / (Math.sin(cross) - Math.sin(from)), ry = drop / (Math.cos(from) - Math.cos(cross));
  return [.42, .78, 1.05, cross, 1.42, Math.PI / 2]
    .map(t => [x + rx * (Math.sin(t) - Math.sin(from)), y + ry * (Math.cos(from) - Math.cos(t))] as PenPoint);
}

/**
 * The lawn's height at `x` right of the crest: the slope falling from the bench, and never above the line through the
 * button that stands `dip` of its height inside it at its middle; so the lawn runs through the button's lower part
 * when the page is composed for it, passes under it when not, and only ever falls.
 */
function slopeAt(x: number, crest: PenPoint, button: LawnBox | null, dip: number): number {
  const natural = crest[1] + SLOPE * Math.max(0, x - crest[0]);
  if (!button) return natural;
  const middle = (button.left + button.right) / 2;
  return Math.max(natural, button.bottom - dip * (button.bottom - button.top) + SLOPE * (x - middle));
}

/**
 * The login lawn's hill as one shape in scene units, so it is drawn by the scene behind the tree and bench and takes
 * the scene's seasonal paint. Its top edge runs along the scene's ground line (`ground`, where the tree and bench
 * stand), falls gently off the left edge of the page, and from the bench, its highest point, falls all the way to the
 * right: gently across to the button beside the scene and through its lower part (or under it), then past the button
 * its shoulder curves down off the bottom of the page before the right edge (the far meadow, loginMeadowPath, lies
 * behind it there); below that edge it fills the page to the bottom.
 */
export function loginLawnPath(ground: readonly PenPoint[], { page, button, dip }: LawnFrame): string {
  const first = ground[0], crest = ground[ground.length - 1];
  const left = page.left - 24;
  const edge: PenPoint[] = [];

  const leftRun = first[0] - left;
  if (leftRun > 8) {
    const drop = shoulderDrop(leftRun, page.bottom - first[1]);
    edge.push([left, first[1] + drop]);
    if (leftRun > 80) edge.push([first[0] - leftRun * .5, first[1] + drop * .3]);
  }
  edge.push(...ground);

  const beside = button && button.left > crest[0] ? button : null;
  const along = beside ? [beside.left, (beside.left + beside.right) / 2, beside.right] : [crest[0] + 100];
  if (along[0] - crest[0] > 160) along.unshift((crest[0] + along[0]) / 2);
  for (const x of along) edge.push([x, slopeAt(x, crest, beside, dip)]);
  edge.push(...rightShoulder(edge[edge.length - 1], page));
  const foot = edge[edge.length - 1];
  const bottom = Math.max(page.bottom + 24, foot[1], first[1]);
  const top = edge.map(([x, y]) => [round(x), round(y)] as PenPoint);
  return `${smoothPath(top)}L${round(foot[0])} ${round(bottom)}L${round(left)} ${round(bottom)}Z`;
}

/**
 * The far meadow behind the login hill: a low, paler band across the whole page with a soft, gently rolling top, a
 * little higher towards the right, where it shows past the hill's shoulder and so leaves no gap below it.
 */
export function loginMeadowPath({ page }: Pick<LawnFrame, 'page'>): string {
  const width = page.right - page.left, height = page.bottom - page.top;
  const left = page.left - 24, right = page.right + 24, bottom = page.bottom + 24;
  // Share of the page's width, and the meadow's height there as a share of MEADOW_HEIGHT: low on the left, where the
  // hill hides it, and rolling up to its full height at the right edge.
  const rolls: Array<[number, number]> = [[0, .55], [.3, .62], [.52, .78], [.68, .86], [.8, .8], [.9, .93], [1, 1]];
  const edge = rolls.map(([along, rise]) => [page.left + width * along, page.bottom - height * MEADOW_HEIGHT * rise] as PenPoint);
  edge.unshift([left, edge[0][1]]);
  edge.push([right, edge[edge.length - 1][1]]);
  const top = edge.map(([x, y]) => [round(x), round(y)] as PenPoint);
  return `${smoothPath(top)}L${round(right)} ${round(bottom)}L${round(left)} ${round(bottom)}Z`;
}

/** How high the falling lawn stands in the guest button at its middle, as a share of its height. */
const GUEST_DIP = .22;
/** Without a guest button the lawn passes this far under the GitHub button instead. */
const GITHUB_DIP = -.45;
/** Whether the page is composed so that the lawn falling from the bench runs through the guest button. */
const COMPOSE = true;
/** The most the composition moves the scene and the text column apart (in CSS pixels), and the scene's share of it. */
const MAX_SHIFT = 72;
const LIFT_SHARE = .4;

/** The vertical part of an element's CSS `translate`, in pixels. */
function shiftOf(element: Element): number {
  const [, y = '0'] = (getComputedStyle(element).translate || 'none').split(' ');
  return parseFloat(y) || 0;
}

/**
 * Composes the login page for the lawn: where the guest button stands above the line the lawn falls along from the
 * bench, it lifts the scene and lowers the text column (by CSS `translate`, through --auth-scene-lift and
 * --auth-panel-drop on the shell) just far enough for that line to pass through the button's lower part. Where that
 * would take more than MAX_SHIFT, or more than the room above the scene and below the text, nothing moves and the lawn
 * passes under the button. Positions are worked out as if nothing had moved, so measuring again is stable.
 */
function compose(shell: HTMLElement, matrix: DOMMatrix, guest: HTMLElement | undefined) {
  const figure = shell.querySelector('.auth-illustration'), panel = shell.querySelector('.auth-panel');
  let lift = 0, drop = 0;
  if (COMPOSE && guest && figure && panel) {
    const lifted = -shiftOf(figure), dropped = shiftOf(panel);
    const crestX = matrix.a * LAWN_CREST[0] + matrix.e, crestY = matrix.d * LAWN_CREST[1] + matrix.f + lifted;
    const button = guest.getBoundingClientRect(), bottom = button.bottom - dropped;
    const need = crestY + SLOPE * ((button.left + button.right) / 2 - crestX) + GUEST_DIP * button.height - bottom;
    const ceiling = shell.querySelector('.auth-header')?.getBoundingClientRect().bottom ?? 0;
    const roomUp = figure.getBoundingClientRect().top + lifted - ceiling - 16;
    const roomDown = shell.getBoundingClientRect().bottom - 48 - (panel.getBoundingClientRect().bottom - dropped);
    if (need > 0 && need <= MAX_SHIFT) {
      lift = Math.max(0, Math.min(need * LIFT_SHARE, roomUp));
      drop = Math.max(0, Math.min(need - lift, roomDown));
      lift = Math.max(0, Math.min(need - drop, roomUp));
      if (lift + drop < need - .5) lift = drop = 0;
    }
  }
  shell.style.setProperty('--auth-scene-lift', `${Math.round(lift)}px`);
  shell.style.setProperty('--auth-panel-drop', `${Math.round(drop)}px`);
}

/**
 * Measures the login page for its lawn: the page and the guest button (else the GitHub button) in the bench scene's
 * units, through the scene's screen matrix, after composing the page for it (compose). It measures again whenever the
 * page, the scene or the text column change size (window, language, fonts) and once the scene has finished arriving
 * (its entrance moves it a little).
 */
export function useLoginLawn(shellRef: RefObject<HTMLElement | null>): LawnFrame | null {
  const [frame, setFrame] = useState<LawnFrame | null>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const scene = () => shell.querySelector<SVGSVGElement>('.auth-illustration > svg');
    const measure = () => {
      const svg = scene(), before = svg?.getScreenCTM?.();
      if (!svg || !before || !before.a || typeof DOMPoint === 'undefined') { setFrame(null); return; }
      const [github, guest] = shell.querySelectorAll<HTMLElement>('.auth-panel .auth-action');
      compose(shell, before, guest);
      const matrix = svg.getScreenCTM() ?? before, inverse = matrix.inverse();
      const box = (rect: DOMRect): LawnBox => {
        const a = new DOMPoint(rect.left, rect.top).matrixTransform(inverse);
        const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse);
        return { left: round(a.x), top: round(a.y), right: round(b.x), bottom: round(b.y) };
      };
      const shellRect = shell.getBoundingClientRect();
      const page = box(new DOMRect(shellRect.left, shellRect.top, shellRect.width, Math.max(shellRect.height, shell.scrollHeight)));
      const anchor = guest ?? github;
      const next: LawnFrame = { page, button: anchor ? box(anchor.getBoundingClientRect()) : null, dip: guest ? GUEST_DIP : GITHUB_DIP };
      setFrame(previous => previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const svg = scene(), panel = shell.querySelector('.auth-panel');
    for (const element of [shell, svg, panel]) if (element) observer?.observe(element);
    svg?.addEventListener('animationend', measure);
    window.addEventListener('resize', measure);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) measure(); });
    return () => {
      live = false;
      observer?.disconnect();
      svg?.removeEventListener('animationend', measure);
      window.removeEventListener('resize', measure);
    };
  }, [shellRef]);
  return frame;
}
