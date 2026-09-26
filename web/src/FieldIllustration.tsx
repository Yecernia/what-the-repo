import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { BRAND_MARK } from './brand-mark';
import { BrandWordmark } from './BrandWordmark';
import { smoothPath, type PenPoint } from './pen-path';
import { litMoonPath, moonPhase } from './moon-phase';
import { Ink } from './field-ink';
import { BenchSnow, BranchSnow, CrownSeason, Dumplings, FallingThing, GroundSnow, Magpie, MilkyWay, MoonRabbit, OccasionScenery,
  SantaHat, Tangyuan, Tea } from './FieldOccasions';
import { occasionOf, seasonOf } from './occasions';


/** A rounded limb from a to b, closed so it can hide what is behind it. */
function limb(a: PenPoint, b: PenPoint, r: number): PenPoint[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, nx = -dy * r, ny = dx * r;
  const m: PenPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [[a[0] + nx, a[1] + ny], [m[0] + nx * 1.04, m[1] + ny * 1.04], [b[0] + nx, b[1] + ny], [b[0] + dx * r, b[1] + dy * r],
    [b[0] - nx, b[1] - ny], [m[0] - nx * .96, m[1] - ny * .96], [a[0] - nx, a[1] - ny], [a[0] - dx * r, a[1] - dy * r]];
}

const TORSO: PenPoint[] = [[96,60],[84,70],[80,94],[83,115],[148,115],[149,89],[141,68],[126,60]];

/** The seated learner's torso and arms jointed at shoulder and elbow; at the keyboard the arms
 * hang down behind the lid, so only the pose decides what shows.
 * Rendered twice (outline pass, then fill pass) so overlapping parts merge into one shape:
 * no seam where an arm leaves the body or at the elbow. */
function Silhouette({ pass }: { pass: 'stroke' | 'fill' }) {
  const paint = pass === 'stroke'
    ? { fill: 'none', stroke: 'currentColor', strokeWidth: 6.6, strokeLinejoin: 'round' as const }
    : { fill: 'var(--chat-bg, var(--bg))' };
  const shape = (points: PenPoint[]) => <path d={smoothPath(points, true)} />;
  return <g {...paint}>
    {shape(TORSO)}
    <g className="field-upper-l"><g className="field-fore-l">{shape(limb([70,42], [101,38], 5))}</g>{shape(limb([97,72], [70,42], 5.5))}</g>
    <g className="field-upper-r"><g className="field-fore-r">{shape(limb([156,42], [125,38], 5))}</g>{shape(limb([129,72], [156,42], 5.5))}</g>
  </g>;
}

export type FieldPose = 'rest' | 'waiting' | 'puzzled';
const POSES: FieldPose[] = ['rest', 'waiting', 'puzzled'];
const PARTS = ['lean', 'rock', 'stretch-body', 'head', 'upper-l', 'fore-l', 'upper-r', 'fore-r'] as const;
type Part = typeof PARTS[number];
/** Turn (deg) each part holds as a pose begins; the stylesheet keeps the same values. At rest the arms
 * hang behind the lid; waiting starts from the hands-behind-head drawing; puzzled keeps one hand up. */
const POSE_START: Record<FieldPose, Partial<Record<Part, number>>> = {
  rest: { 'upper-l': -123, 'fore-l': 50, 'upper-r': 123, 'fore-r': -50 },
  waiting: {},
  puzzled: { head: 5, 'upper-r': 123, 'fore-r': -50 },
};
/** Once the wait is over: one slow stretch (the same reach as the idle one), then both arms come down as mirror
 * images of each other: elbows lower outward while the forearms fold in (left clockwise, right anticlockwise)
 * through a matching bent-arms pose, and the hands go back behind the lid. */
const FINISH_OFFSETS = [0, .28, .45, .56, .78, 1];
/** The way down runs straight through the bent-arms pose without slowing there. */
const FINISH_EASING = ['ease-in-out', 'ease-in-out', 'ease-in-out', 'cubic-bezier(.42, 0, .8, .6)', 'cubic-bezier(.2, .4, .58, 1)'];
const FINISH: Partial<Record<Part, number[]>> = {
  'upper-l': [19, 22, 22, -61, -123], 'fore-l': [-114, -118, -118, 25, 50],
  'upper-r': [-1, -3, -3, 61, 123], 'fore-r': [140, 146, 146, -25, -50],
  'stretch-body': [3.5, 4.5, 4.5, 1, 0], head: [-3, -3, -2, 0, 0],
};
const POSE_CHANGE_MS = 1200;
const FINISH_MS = 5600;

/** The heart the arms make over the head: up and out from each shoulder, round over the two lobes and down to the
 * hands meeting on top of the head. */
const HEART_ARMS = 'M97 72 C86 58 72 44 74 28 C76 14 92 9 103 15 C108 18 111 22 113 27 '
  + 'M129 72 C140 58 154 44 152 28 C150 14 134 9 123 15 C118 18 115 22 113 27';
/** The same two arms straight up, exactly where the jointed arms are in ARMS_UP, with the same commands as the heart
 * so one can bend into the other. */
const HEART_ARMS_UP = 'M97 72 C92 60 86 47 81.2 34.8 C79.5 27 77.5 19 76.8 14.4 C76 10.5 75.2 7 74.5 4.2 '
  + 'M129 72 C134 60 140 47 144.8 34.8 C146.5 27 148.5 19 149.2 14.4 C150 10.5 150.8 7 151.5 4.2';

function turnMatrix(deg: number): string {
  const r = deg * Math.PI / 180;
  return `matrix(${Math.cos(r)}, ${Math.sin(r)}, ${-Math.sin(r)}, ${Math.cos(r)}, 0, 0)`;
}

function currentTurn(transform: string): number {
  const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(transform);
  return m ? Math.atan2(Number(m[2]), Number(m[1])) * 180 / Math.PI : 0;
}

/** Arms straight up beside the head, the pose the heart is raised through (same as the idle stretch). */
const ARMS_UP: Partial<Record<Part, number>> = { 'upper-l': 19, 'fore-l': -114, 'upper-r': -19, 'fore-r': 114 };
/** Unhurried: about a second to raise the arms, another to bend them into the heart, a pause, and back down. */
const HEART_MS = 4800;

/** Moves between poses from wherever the figure is, so nothing ever snaps. The pose class is set here, not by
 * React, so the old pose can still be read when it changes. Idle loops wait POSE_CHANGE_MS before starting. */
function useFieldPose(ref: RefObject<SVGSVGElement | null>, pose: FieldPose, greet = false) {
  const shown = useRef<FieldPose | null>(null);
  const greeted = useRef(false);
  const change = useRef(0);
  if (!greet) greeted.current = false;
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    // Appearing already at work (the chat opens as an analysis starts), the figure still begins at rest and settles
    // into the wait, instead of showing the finished hands-behind-head pose at once.
    const arriving = shown.current === null && pose !== 'rest';
    const previous = arriving ? 'rest' : shown.current;
    // Nothing changed (React may run this twice for one pose): leave running motions alone.
    if (previous === pose) return;
    shown.current = pose;
    const token = ++change.current;
    // Each part exists twice (outline pass and fill pass); both copies move together.
    const parts = PARTS.flatMap(part => [...svg.querySelectorAll<SVGGElement>(`.field-${part}`)].map(el => ({ part, el })));
    const from = parts.map(({ part, el }) => arriving ? turnMatrix(POSE_START.rest[part] ?? 0) : getComputedStyle(el).transform);
    // Drop any move still under way, including a heart gesture cut short.
    const moving = [...parts.map(({ el }) => el), ...svg.querySelectorAll('.field-heart-arms, .field-heart-arms path, .field-heart')];
    for (const el of moving) for (const a of el.getAnimations?.() ?? []) if (!('animationName' in a)) a.cancel();
    svg.classList.remove(...POSES.map(name => `field-${name}`));
    svg.classList.add(`field-${pose}`);
    if (previous === null) {
      svg.classList.remove('field-moving');
      return;
    }
    // While the figure moves into the new pose, that pose's idle loops stay off (.field-moving), so nothing else can
    // take over the arms. Each move holds its last frame; when all have ended, the loops start from that same frame
    // and the moves are dropped, in one step, so no other drawing shows in between.
    svg.classList.add('field-moving');
    const moves: Animation[] = [];
    const animate = (el: Element, frames: Keyframe[], options: KeyframeAnimationOptions | number) => {
      const move = el.animate?.(frames, { ...(typeof options === 'number' ? { duration: options } : options), fill: 'forwards' });
      if (move) moves.push(move);
    };
    // Reading our own repository: once, as the analysis starts, a big heart over the head, then the usual wait.
    // The arms rise from the sides (never through the hands-behind-head drawing). A jointed arm cannot curve, so at
    // the top it gives way to a drawn arm of exactly the same shape, which then bends into the heart and back.
    if (greet && pose === 'waiting' && !greeted.current) {
      greeted.current = true;
      const timing = { duration: HEART_MS, easing: 'linear' };
      parts.forEach(({ part, el }, i) => {
        // Only the arms take part; the head and body carry on with the wait underneath.
        if (!(part in ARMS_UP)) return;
        const start = currentTurn(from[i]), up = ARMS_UP[part] ?? 0;
        // Halfway up the elbows are out to the sides and the forearms point up, clear of the head.
        const side = part === 'fore-l' ? -40 : part === 'fore-r' ? 40 : part === 'upper-l' ? -50 : part === 'upper-r' ? 50 : 0;
        const arm = part.startsWith('upper');
        // The two kinds of arm overlap while they change places (same shape, so it cannot be seen) instead of
        // swapping at one instant, where a single frame could land with neither on screen.
        animate(el, [
          { transform: `rotate(${start}deg)`, opacity: 1, easing: 'ease-in' },
          { transform: `rotate(${side}deg)`, opacity: 1, offset: .08, easing: 'ease-out' },
          { transform: `rotate(${up}deg)`, opacity: 1, offset: .16 },
          { transform: `rotate(${up}deg)`, opacity: 1, offset: .175 },
          { transform: `rotate(${up}deg)`, opacity: arm ? 0 : 1, offset: .18 },
          { transform: `rotate(${up}deg)`, opacity: arm ? 0 : 1, offset: .8 },
          { transform: `rotate(${up}deg)`, opacity: 1, offset: .805 },
          { transform: `rotate(${up}deg)`, opacity: 1, offset: .83, easing: 'ease-in-out' },
          { transform: 'rotate(0deg)', opacity: 1 }], timing);
      });
      svg.querySelectorAll('.field-heart-arms').forEach(arms => animate(arms, [{ opacity: 0 }, { opacity: 0, offset: .16 },
        { opacity: 1, offset: .165 }, { opacity: 1, offset: .82 }, { opacity: 0, offset: .825 }, { opacity: 0 }], timing));
      const straight = `path("${HEART_ARMS_UP}")`, heart = `path("${HEART_ARMS}")`;
      svg.querySelectorAll('.field-heart-arms path').forEach(path => animate(path, [{ d: straight },
        { d: straight, offset: .18, easing: 'ease-in-out' }, { d: heart, offset: .36 }, { d: heart, offset: .62, easing: 'ease-in-out' },
        { d: straight, offset: .79 }, { d: straight }], timing));
      const pop = svg.querySelector('.field-heart');
      if (pop) animate(pop, [{ opacity: 0, transform: 'translateY(4px) scale(.6)' },
        { opacity: 0, transform: 'translateY(4px) scale(.6)', offset: .3 }, { opacity: 1, transform: 'scale(1.1)', offset: .38 },
        { opacity: 1, transform: 'translateY(-3px)', offset: .64 }, { opacity: 0, transform: 'translateY(-8px) scale(.9)', offset: .76 },
        { opacity: 0 }], { duration: HEART_MS, easing: 'ease-out' });
    } else {
      const finishing = previous === 'waiting' && pose === 'rest';
      parts.forEach(({ part, el }, i) => {
        if (part === 'lean') {
          animate(el, [{ transform: from[i] }, { transform: 'none' }], { duration: POSE_CHANGE_MS, easing: 'ease-in-out' });
          return;
        }
        const start = `rotate(${currentTurn(from[i])}deg)`;
        const path = finishing ? FINISH[part] : undefined;
        if (path) {
          animate(el, [{ transform: start }, ...path.map(turn => ({ transform: `rotate(${turn}deg)` }))]
            .map((frame, k) => ({ ...frame, offset: FINISH_OFFSETS[k], easing: FINISH_EASING[k] })), FINISH_MS);
        } else {
          animate(el, [{ transform: start }, { transform: `rotate(${POSE_START[pose][part] ?? 0}deg)` }],
            { duration: finishing ? FINISH_MS * .4 : POSE_CHANGE_MS, easing: 'ease-in-out' });
        }
      });
    }
    const handOver = () => {
      if (token !== change.current) return;
      svg.classList.remove('field-moving');
      for (const { el } of parts) void getComputedStyle(el).transform;
      for (const move of moves) move.cancel();
    };
    if (!moves.length) handOver();
    else void Promise.all(moves.map(move => move.finished)).then(handOver, () => undefined);
  }, [ref, pose, greet]);
}

/** The product mark: a learner reaching into a computer folder for a page of code. Resting the pointer on it lifts
 * the page for a closer look. While the agent works (`busy`) he takes a page out, reads it, puts it back and takes
 * the next one (the writing on the page changes while it is out of sight). When the work is done he tucks the page
 * away, rests his arm on the folder and the two "got it" lines of the first mark appear by his head.
 * The page is drawn twice, once as ink and once inside the mask that hides the folder behind it, so both copies
 * share the class that moves them. The busy class is set here rather than by React, so the current pose can be
 * read when the work ends and the closing moment can start from it. */
export function FieldMark({ busy = false, celebrate = 0 }: { busy?: boolean; celebrate?: number }) {
  const id = `${useId().replace(/:/g, '')}-mark`;
  const ref = useRef<SVGSVGElement>(null);
  const shown = useRef<boolean | null>(null);
  // Each time `celebrate` goes up (a learning route was just finished) he cheers: tosses the page he was reading up
  // into the air, throws his arm up and hops twice, says "got it", and a moment later the page is back in the folder.
  // Nothing happens on the first render.
  const celebrated = useRef(celebrate);
  useLayoutEffect(() => {
    if (celebrate === celebrated.current) return;
    celebrated.current = celebrate;
    const svg = ref.current;
    if (!svg) return;
    const run = (selector: string, frames: Keyframe[], duration = 3000) =>
      svg.querySelectorAll<SVGElement>(selector).forEach(el => el.animate?.(frames, { duration, easing: 'ease-in-out' }));
    run('.field-mark-page', [{ transform: 'none', opacity: 1 },
      { transform: 'translate(3px, -6px) rotate(-12deg)', opacity: 1, offset: .12, easing: 'cubic-bezier(.2, .7, .4, 1)' },
      { transform: 'translate(12px, -24px) rotate(-150deg)', opacity: .9, offset: .38 },
      { transform: 'translate(17px, -30px) rotate(-240deg)', opacity: 0, offset: .5 },
      { transform: 'translate(.6px, 11px)', opacity: 0, offset: .51 }, { transform: 'translate(.6px, 11px)', opacity: 1, offset: .82 },
      { transform: 'none', opacity: 1 }]);
    run('.field-mark-arm', [{ transform: 'none' }, { transform: 'rotate(-8deg)', offset: .12 }, { transform: 'rotate(-30deg)', offset: .26 },
      { transform: 'rotate(-20deg)', offset: .4 }, { transform: 'rotate(-30deg)', offset: .54 }, { transform: 'rotate(-26deg)', offset: .7 },
      { transform: 'none' }]);
    run('.field-mark-hop', [{ transform: 'none' }, { transform: 'none', offset: .2 }, { transform: 'translateY(-2.2px)', offset: .3 },
      { transform: 'none', offset: .4 }, { transform: 'translateY(-2.2px)', offset: .5 }, { transform: 'none', offset: .6 }, { transform: 'none' }]);
    run('.field-mark-insight', [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(.6)', offset: .24 },
      { opacity: 1, transform: 'scale(1.12)', offset: .34 }, { opacity: 1, transform: 'none', offset: .75 }, { opacity: 0, transform: 'none' }]);
  }, [celebrate]);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const previous = shown.current;
    shown.current = busy;
    const pages = [...svg.querySelectorAll<SVGGElement>('.field-mark-page')];
    const arm = svg.querySelector<SVGGElement>('.field-mark-arm');
    const from = { pages: pages.map(el => getComputedStyle(el).transform), arm: arm ? getComputedStyle(arm).transform : 'none' };
    svg.classList.toggle('field-mark-busy', busy);
    if (previous !== true || busy) return;
    const tucked = 'translate(.6px, 11px)';
    pages.forEach((el, i) => el.animate?.([{ transform: from.pages[i] }, { transform: tucked, offset: .25 }, { transform: tucked, offset: .8 }, { transform: 'none' }],
      { duration: 2800, easing: 'ease-in-out' }));
    arm?.animate?.([{ transform: from.arm }, { transform: 'rotate(27deg)', offset: .25 }, { transform: 'rotate(27deg)', offset: .8 }, { transform: 'none' }],
      { duration: 2800, easing: 'ease-in-out' });
    svg.querySelector('.field-mark-insight')?.animate?.([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 0, transform: 'scale(.6)', offset: .22 },
      { opacity: 1, transform: 'scale(1.1)', offset: .34 }, { opacity: 1, transform: 'none', offset: .78 }, { opacity: 0, transform: 'none' }],
      { duration: 2800, easing: 'ease-out' });
  }, [busy]);
  const m = BRAND_MARK;
  return <svg ref={ref} className="field-mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
    <defs>
      <mask id={`${id}-folder`} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="white" />
        <g className="field-mark-page"><path d={m.pageShape} fill="black" /></g>
        <path d={m.frontShape} fill="black" />
      </mask>
      <mask id={`${id}-page`} maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="white" /><path d={m.frontShape} fill="black" />
      </mask>
    </defs>
    <g fill="currentColor" fillRule="evenodd">
      <path d={m.back} mask={`url(#${id}-folder)`} />
      <g mask={`url(#${id}-page)`}><g className="field-mark-page"><path d={m.page} />
        <g className="field-mark-lines">{m.pageLines.map(d => <path key={d} d={d} />)}</g>
        <g className="field-mark-lines-next">{m.nextPageLines.map(d => <path key={d} d={d} />)}</g>
      </g></g>
      <path d={m.front} />
      <g className="field-mark-hop"><path d={m.head} /><path d={m.body} /></g>
      {/* The arm shares the page's mask, so a hand reaching into the folder goes behind its front. */}
      <g mask={`url(#${id}-page)`}><g className="field-mark-arm"><path d={m.arm} /></g></g>
      <g className="field-mark-insight">{m.insight.map(d => <path key={d} d={d} />)}</g>
    </g>
  </svg>;
}

export function FieldScene({ className = '', at }: { className?: string; at?: Date }) {
  return <figure className={`field-scene ${className}`}><FieldIllustration at={at} />
    <figcaption aria-label="what-the-repo"><BrandWordmark /></figcaption>
  </figure>;
}

/** Front view at a laptop, with a chair back behind. While the agent works, the learner folds their arms
 * behind their head and now and then leans back or stretches; when something fails they scratch their head. */
function FieldDesk({ pose, className, ownRepository }: { pose: FieldPose; className: string; ownRepository: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  useFieldPose(ref, pose, ownRepository);
  return <svg ref={ref} className={`field-illustration field-illustration-small ${className}`} viewBox="0 0 240 150" aria-hidden="true" focusable="false">
    {/* Nested groups carry independent loops (sink back, rock, tilt head, stretch) with
        unrelated periods, so their combination keeps changing instead of repeating.
        Arms stay attached to the body; only the head tilts on its own. */}
    <g className="field-lean"><g className="field-rock">
      <Ink points={[[86,22],[114,19],[142,22],[150,50],[151,104],[79,104],[80,50]]} width={3.2} closed fill="var(--chat-bg, var(--bg))" />
      <g className="field-stretch-body">
      {/* Arms bent into a heart over the head, shown only at the top of the heart gesture. Like the jointed arms they
          are drawn outline first and filling second, so the body's outline never shows across the shoulders. */}
      <g className="field-heart-arms" fill="none" strokeLinecap="round">
        <path d={HEART_ARMS_UP} stroke="currentColor" strokeWidth={16.6} />
      </g>
      <Silhouette pass="stroke" />
      <g className="field-heart-arms" fill="none" strokeLinecap="round">
        <path d={HEART_ARMS_UP} stroke="var(--chat-bg, var(--bg))" strokeWidth={10} />
      </g>
      <Silhouette pass="fill" />
      <g className="field-head">
        <Ink points={[[111,29,.85],[101,33,1.2],[97,42,1.1],[100,52,.9],[111,56,1.15],[123,53,.85],[127,43,1.2],[123,33,.9]]} width={3.6} closed fill="var(--chat-bg, var(--bg))" />
      </g>
      </g>
    </g></g>
    {/* A small hand-written question mark, only while puzzled. */}
    <g className="field-puzzle-mark">
      <Ink points={[[161,22],[164,16],[171,15],[174,20],[170,25],[168,30]]} width={2.6} />
      <circle cx="168" cy="36" r="1.7" fill="currentColor" />
    </g>
    {/* We see the plain back of the lid and its thin bottom edge, not the screen or keyboard. */}
    <Ink points={[[69,79,.85],[86,80,1.2],[149,79,.9],[171,81,1.1],[169,98,.85],[166,120,1.2],[148,121,.9],[91,120,1.15],[74,119,.85],[71,98,1.1]]} width={3.3} closed fill="var(--chat-bg, var(--bg))" />
    <Ink points={[[70,122,.85],[89,125,1.1],[149,126,.9],[171,123,1.1]]} width={2.6} />
    {/* Shown only during the heart gesture for our own repository. */}
    <path className="field-heart" d="M184 40 C175 33 174 25 179 23 C182 22 184 24 184 27 C184 24 186 22 189 23 C194 25 193 33 184 40 Z"
      fill="#e58a9c" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
  </svg>;
}

/**
 * Tonight's moon for the dark-mode sky, drawn in SVG user units. The whole disc stays faintly drawn, so a new
 * moon still leaves a trace; the lit part follows the date, with a few faint craters only where the light falls.
 */
export function NightMoon({ cx = 452, cy = 130, r = 24, phase }: { cx?: number; cy?: number; r?: number; phase?: number }) {
  const clip = `field-moon-${useId().replace(/:/g, '')}`;
  const lit = litMoonPath(cx, cy, r, phase ?? moonPhase());
  const at = (dx: number, dy: number) => ({ cx: cx + dx * r / 24, cy: cy + dy * r / 24 });
  return <g color="var(--moon)">
    <circle className="field-moon-disc" cx={cx} cy={cy} r={r} fill="none" stroke="currentColor" strokeWidth={1.6} />
    {lit && <>
      <clipPath id={clip}><path d={lit} /></clipPath>
      <path d={lit} fill="color-mix(in srgb, var(--moon) 42%, var(--bg))" />
      <g clipPath={`url(#${clip})`} className="field-moon-craters" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle {...at(-8, -8)} r={4.2 * r / 24} /><circle {...at(8, 9)} r={3 * r / 24} /><circle {...at(-5, 13)} r={1.8 * r / 24} />
      </g>
      <path d={lit} fill="none" stroke="currentColor" strokeWidth={2.9} strokeLinejoin="round" />
    </>}
  </g>;
}

/** `at` shows the scene as on another date (the gallery uses it); the page itself always shows today. */
export function FieldIllustration({ compact = false, pose = 'rest', className = '', at, ownRepository = false }: {
  compact?: boolean; pose?: FieldPose; className?: string; at?: Date; ownRepository?: boolean;
}) {
  if (compact) return <FieldDesk pose={pose} className={className} ownRepository={ownRepository} />;
  const now = at ?? new Date();
  const season = seasonOf(now), occasion = occasionOf(now);
  return <svg className={`field-illustration ${className}`} viewBox="0 0 600 440" aria-hidden="true" focusable="false"
    data-season={season} data-occasion={occasion ?? undefined}>
    {/* An open-air study spot: a big, loosely drawn tree, a long park bench and a little breeze.
        The canopy is uneven on purpose, and its line overshoots where it starts and ends. */}
    <g className="field-canopy">
      <Ink points={[[134,262],[104,267],[72,258],[48,240],[36,214],[42,193],[31,171],[29,145],[42,121],[61,109],[67,86],[86,65],
        [110,57],[127,40],[152,29],[180,31],[201,42],[214,57],[238,58],[259,73],[271,95],[268,117],[283,135],[289,160],[279,183],
        [265,196],[270,219],[257,241],[234,252],[208,253],[187,262],[160,266]]} width={4.4} color="var(--accent)"
        fill="color-mix(in srgb, var(--accent-soft) 30%, var(--bg))" />
      {/* A few different doodles in the crown, never the same mark twice. */}
      <Ink points={[[70,158],[80,146],[94,142],[90,154],[70,158]]} width={3} color="var(--accent)" closed />
      <Ink points={[[70,158],[84,150]]} width={2.4} color="var(--accent)" />
      <Ink points={[[110,96],[118,86],[128,84],[134,90],[128,96]]} width={3} color="var(--accent)" />
      <Ink points={[[200,112],[208,100],[212,90]]} width={2.8} color="var(--accent)" />
      <Ink points={[[208,100],[200,94],[196,86],[204,88],[208,98]]} width={2.8} color="var(--accent)" closed />
      <Ink points={[[210,94],[218,88],[226,88],[222,95],[211,96]]} width={2.8} color="var(--accent)" closed />
      <g fill="var(--accent)"><circle cx="232" cy="182" r="3.2" /><circle cx="241" cy="186" r="3" /><circle cx="234" cy="192" r="2.8" /></g>
      <Ink points={[[56,216],[64,206],[70,214]]} width={2.8} color="var(--accent)" />
      <CrownSeason season={season} />
    </g>
    {/* A wobbly, slightly leaning trunk that forks into the crown, outlined in brown ink. */}
    <g fill="var(--bg)" stroke="color-mix(in srgb, var(--fg) 80%, var(--warn) 20%)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round">
      <path d="M126 373 Q121 346 128 312 Q133 284 131 250 L161 250 Q158 284 163 314 Q170 346 168 373" />
      <path className="field-branches" d="M131 256 Q129 238 116 222 Q104 208 90 200 Q84 195 92 194 Q108 199 126 214 Q136 224 139 230
        Q140 196 141 162 Q142 132 146 118 Q150 112 152 120 Q154 150 154 196 Q168 178 186 160 Q198 150 204 154 Q206 160 196 168
        Q174 190 162 218 Q160 238 161 256" />
    </g>
    {season === 'winter' && <BranchSnow />}
    <OccasionScenery occasion={occasion} />
    {/* Bench and learner sit a little smaller than the tree. */}
    <g transform="translate(345 373) scale(.86) translate(-345 -373)">
    {/* The bench remains one simple background shape, with clear space below the seat. */}
    <Ink points={[[246,207,.85],[308,209,1.1],[371,206,.9],[443,208,1.15],[444,231,.85],[367,230,1.15],[305,233,.9],[245,230,1.1]]} width={3.8} closed fill="var(--bg)" />
    {season === 'winter' && <BenchSnow />}
    <Ink points={[[256,233,.8],[257,288,1.1]]} width={3.3} />
    <Ink points={[[430,231,.8],[427,290,1.1]]} width={3.3} />
    <Ink points={[[232,291,.85],[295,290,1.1],[365,293,.9],[457,291,1.15],[459,304,.85],[379,307,1.1],[296,304,.9],[232,305,1.1]]} width={3.8} closed fill="var(--bg)" />
    <Ink points={[[253,308,.8],[250,339,1.1],[253,373,.75]]} width={3.8} />
    <Ink points={[[435,308,.8],[435,340,1.1],[438,373,.75]]} width={3.8} />
    {/* Broad sleeves and roomy trouser shapes, without narrow wrists or separate shoes. */}
    <Ink points={[[345,288,.85],[375,301,1.15],[385,325,.9],[386,347,1.1],[382,368,.85],[364,371,1.1],[343,368,.9],[341,344,1.15],[334,316,.85]]} width={5.2} closed fill="var(--bg)" />
    <Ink points={[[297,291,.85],[323,298,1.15],[336,313,.9],[334,338,1.1],[331,369,.85],[312,372,1.15],[289,369,.9],[285,345,1.1],[280,322,.85],[279,308,1.15]]} width={5.4} closed fill="var(--bg)" />
    <Ink points={[[305,196,.85],[283,212,1.15],[268,240,.9],[272,272,1.2],[298,293,.85],[352,300,1.1],[381,289,.9],[395,263,1.2],[389,233,.85],[369,211,1.1],[344,198,.9]]} width={5.5} closed fill="var(--bg)" />
    <Ink points={[[313,147,.85],[297,150,1.2],[289,162,1.1],[291,178,.9],[304,188,1.2],[323,187,.85],[338,178,1.1],[339,165,1.2],[328,150,.85]]} width={4.8} closed fill="var(--bg)" />
    {occasion === 'christmas' && <SantaHat />}
    <Ink points={[[291,221,.85],[280,244,1.15],[285,260,.9]]} width={4.6} />
    {/* The left hand (on our right) keeps only its inner edge; the torso already draws its outside. */}
    <Ink points={[[350,232,.9],[358,250,1.1],[352,261,.85],[332,260,1.15],[327,276,.9],[337,286,1.1],[366,290,.85],[380,287,.9]]} width={5.1} />
    {/* The plain rear of the lid faces us; the screen and hands are on the person's side. */}
    <Ink points={[[247,239,.85],[273,241,1.1],[309,243,.9],[343,245,1.2],[343,263,.85],[339,287,1.1],[309,288,.9],[264,284,1.2],[258,266,.85],[252,252,1.1]]} width={4.2} closed fill="var(--panel)" />
    <Ink points={[[258,289,.85],[298,293,1.1],[341,292,.85]]} width={3.1} />
    {/* One thing at a time beside the learner: the solstice dumplings, the Lantern Festival tangyuan, or tea in dark mode. */}
    {occasion === 'winter-solstice' ? <Dumplings /> : occasion === 'lantern-festival' ? <Tangyuan />
      : <Tea upsideDown={occasion === 'april-fools'} />}
    </g>
    {/* Daytime has a breeze; in dark mode the same corner holds tonight's moon and a few stars instead. */}
    <g className="field-day">
      <Ink className="field-breeze" points={[[396,139,.7],[417,135,1.1],[437,138,.8]]} width={2.4} color="var(--accent)" />
      <Ink className="field-breeze field-breeze-second" points={[[413,151,.7],[443,148,1.1],[462,151,.75]]} width={2.4} color="var(--accent)" />
    </g>
    <g className="field-night" color="var(--moon)">
      {occasion === 'qixi' && <MilkyWay />}
      <NightMoon phase={moonPhase(now)} />
      <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
        <path className="field-star field-star-twinkle" d="M401 118 L401.5 128 M396 123.3 L406.5 122.8" />
        <path className="field-star" d="M497 118 L497.3 124 M494 121.2 L500.4 121" />
        <path className="field-star field-star-late" d="M418 160 L418.2 166 M415 163.1 L421.3 162.8" />
      </g>
    </g>
    {/* Now and then a leaf lets go of the crown and drifts down with the breeze. Falling, swaying sideways and
        rocking are separate layers, so the leaf never stops in mid-air while it changes direction. */}
    <g transform="translate(186 258)"><g className="field-leaf-fall"><g className="field-leaf-drift"><g className="field-leaf-swing">
      <FallingThing season={season} occasion={occasion} />
    </g></g></g></g>
    <g transform="translate(74 250)"><g className="field-leaf-fall field-leaf-fall-second"><g className="field-leaf-drift field-leaf-drift-second"><g className="field-leaf-swing field-leaf-swing-second">
      <FallingThing season={season} occasion={occasion} second />
    </g></g></g></g>
    <Ink points={[[484,346,.75],[493,363,1.1],[501,345,.8]]} width={3} color="var(--accent)" />
    <Ink points={[[88,355,.7],[98,371,1.1],[105,355,.75]]} width={3} color="var(--accent)" />
    <Ink points={[[101,379,.7],[170,377,1.15],[222,379,.85],[269,378,.7]]} width={2.6} />
    <Ink points={[[290,381,.75],[365,379,1.1],[433,381,.85],[508,377,.7]]} width={2.6} />
    {season === 'winter' && <GroundSnow />}
    {/* The animals come last, in front of the bench, the grass and the snow they hop past. */}
    {occasion === 'mid-autumn' && <MoonRabbit />}
    {occasion === 'qixi' && <Magpie />}
  </svg>;
}
