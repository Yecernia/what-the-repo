import { useEffect, useId, useRef } from 'react';
import { Ink } from './field-ink';
import { smoothPath } from './pen-path';
import { arc, between, linger, pause, play, stayFor, type Point } from './field-wander';
import type { Occasion, Season } from './occasions';

/**
 * Small touches the home illustration picks up from the date: the tree changes with the seasons, and on festivals
 * one little thing appears. Each is a few pen strokes in the same felt-tip style, placed where it does not cover the
 * learner, and all coordinates are in the illustration's 600 x 440 drawing.
 */

/** What drifts down from the crown: a leaf, an autumn leaf, a snowflake or a willow catkin. */
export function FallingThing({ season, occasion, second = false }: { season: Season; occasion: Occasion | null; second?: boolean }) {
  if (occasion === 'qingming') {
    return <g className="field-catkin" fill="var(--catkin)" stroke="color-mix(in srgb, var(--fg) 35%, transparent)" strokeWidth={1.2}>
      <circle r={second ? 3.4 : 4} /><path d="M0 -4 L1.5 -9 M3 -2 L7 -5 M-3 -2 L-6 -6" fill="none" strokeLinecap="round" />
    </g>;
  }
  if (season === 'winter') {
    return <path className="field-snowflake" d={second ? 'M-4.5 0 H4.5 M-2.2 -3.9 L2.2 3.9 M-2.2 3.9 L2.2 -3.9' : 'M-6 0 H6 M-3 -5.2 L3 5.2 M-3 5.2 L3 -5.2'}
      fill="none" stroke="var(--snow-ink)" strokeWidth={2.2} strokeLinecap="round" />;
  }
  return <path d={second ? 'M-5 2 C-4 -4 3 -6 6 -4 C5 2 0 5 -5 2 Z M-5 2 L2 -2' : 'M-6 1 C-3 -5 4 -6 7 -3 C4 3 -2 5 -6 1 Z M-6 1 L3 -2'}
    fill="var(--leaf-fill)" stroke="var(--leaf-ink)" strokeWidth={second ? 2.3 : 2.4} strokeLinecap="round" strokeLinejoin="round" />;
}

const BLOSSOMS: Array<[number, number]> = [[86, 114], [162, 54], [242, 124], [250, 214], [46, 186], [178, 226], [124, 196]];

/** Spring: a few small blossoms in the crown. Drawn after the crown. */
export function CrownSeason({ season }: { season: Season }) {
  if (season === 'spring') {
    return <g className="field-blossoms">{BLOSSOMS.map(([x, y]) => <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
      {[0, 72, 144, 216, 288].map(turn => <circle key={turn} cx={Math.cos(turn * Math.PI / 180) * 4.2} cy={Math.sin(turn * Math.PI / 180) * 4.2}
        r={3.1} fill="var(--blossom)" />)}
      <circle r={1.9} fill="var(--blossom-heart)" />
    </g>)}</g>;
  }
  return null;
}

/** Winter: snow lying along the tops of the bare branches, swaying with them. */
export function BranchSnow() {
  return <g className="field-branches">
    <Ink points={[[87,191],[99,189],[112,194],[126,206],[138,221],[139,229],[126,214],[108,199],[92,195]]} width={2}
      closed fill="var(--snow)" color="var(--snow-ink)" />
    <Ink points={[[142,119],[145,110],[150,107],[155,111],[156,120],[152,119],[149,114],[145,117]]} width={2}
      closed fill="var(--snow)" color="var(--snow-ink)" />
    <Ink points={[[151,190],[166,173],[182,156],[197,146],[207,149],[204,154],[198,150],[186,160],[168,178],[155,195]]} width={2}
      closed fill="var(--snow)" color="var(--snow-ink)" />
  </g>;
}

/** Winter snow on the bench's backrest, in the bench's own (unscaled) drawing. */
export function BenchSnow() {
  return <Ink points={[[244,207],[276,199],[330,197],[392,198],[445,202],[444,209],[372,206],[306,209],[245,209]]}
    width={2.2} closed fill="var(--snow)" color="var(--snow-ink)" />;
}

/** Winter: a small drift at the foot of the tree and by the bench. */
export function GroundSnow() {
  return <g>
    <Ink points={[[98,378],[118,370],[140,372],[176,370],[200,376]]} width={2.2} closed fill="var(--snow)" color="var(--snow-ink)" />
    <Ink points={[[440,378],[462,371],[492,372],[512,377]]} width={2.2} closed fill="var(--snow)" color="var(--snow-ink)" />
  </g>;
}

/** A red lantern for the Spring Festival, hanging from the right branch (the tree is bare in winter) and swaying a
 * little. It is drawn at the crown's edge and moved onto the branch as a whole. */
function Lantern() {
  return <g transform="translate(-41 -73)"><g className="field-lantern">
    <path d="M227 250 L227 266" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    <rect x={219} y={265} width={16} height={5} rx={1.5} fill="var(--paint-gold)" stroke="currentColor" strokeWidth={1.8} />
    <Ink points={[[227,269],[214,274],[211,283],[215,292],[227,297],[239,292],[243,283],[240,274]]} width={2.6} closed fill="var(--paint-red)" />
    <path d="M221 271 Q216 283 221 295 M233 271 Q238 283 233 295 M227 269 V297" fill="none" stroke="color-mix(in srgb, currentColor 45%, var(--paint-red))"
      strokeWidth={1.4} />
    <rect x={220} y={296} width={14} height={4.5} rx={1.5} fill="var(--paint-gold)" stroke="currentColor" strokeWidth={1.8} />
    <path d="M224 301 L223 314 M227 301 L227 316 M230 301 L231 314" stroke="var(--paint-gold)" strokeWidth={2} strokeLinecap="round" />
  </g></g>;
}

/** New Year's Eve and Day: two small bursts of fireworks in the open sky. */
function Fireworks() {
  // The burst's position stays on the outer group; the animation scales the inner one.
  const burst = (x: number, y: number, r: number, color: string, delay: string) => <g transform={`translate(${x} ${y})`}>
    <g className="field-firework" style={{ animationDelay: delay }} stroke={color} strokeWidth={2.4} strokeLinecap="round">
      {Array.from({ length: 10 }, (_, i) => {
        const a = i * Math.PI / 5 + .2;
        return <path key={i} d={`M${Math.cos(a) * r * .45} ${Math.sin(a) * r * .45} L${Math.cos(a) * r} ${Math.sin(a) * r}`} />;
      })}
      <circle r={2} fill={color} stroke="none" />
    </g>
  </g>;
  return <g>{burst(528, 64, 22, 'var(--paint-red)', '0s')}{burst(566, 118, 15, 'var(--paint-gold)', '-1.4s')}</g>;
}

/** Valentine's Day: a small heart scratched into the trunk. */
function TrunkHeart() {
  return <path d="M146 331 C137 324 136 316 141 314 C144 313 146 315 146 318 C146 315 148 313 151 314 C156 316 155 324 146 331 Z"
    fill="none" stroke="var(--paint-rose)" strokeWidth={2.3} strokeLinejoin="round" />;
}

/** Dragon Boat Festival: a zongzi resting on the grass beside the tree. */
function Zongzi() {
  return <g>
    <Ink points={[[204,377],[218,351],[233,377]]} width={2.8} closed fill="var(--paint-leaf)" />
    <path d="M211 364 L226 366" stroke="var(--paint-twine)" strokeWidth={2.4} strokeLinecap="round" />
    <path d="M218 353 L214 376" stroke="color-mix(in srgb, currentColor 40%, var(--paint-leaf))" strokeWidth={1.4} strokeLinecap="round" />
  </g>;
}

/** Asked for less motion, the festival animals simply sit still where they are drawn. */
const stillScene = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type RabbitSpot = 'grass' | 'bench' | 'feet' | 'tree';
/** Where the rabbit sits, as moves from its place on the grass right of the bench; the tree is across the scene. */
const RABBIT_SPOTS: Record<RabbitSpot, Point> = { grass: [0, 0], bench: [-111, -75], feet: [-119, 0], tree: [-300, 0] };
/** How far it hops about on the spot, left and right, where there is room. */
const RABBIT_ROOM: Partial<Record<RabbitSpot, [number, number]>> = { grass: [-12, 18], tree: [-18, 14] };
/** Where it goes next from each spot, and how likely; the bench only when nothing stands on it. */
const RABBIT_NEXT: Record<RabbitSpot, Array<[RabbitSpot, number]>> = {
  grass: [['bench', .45], ['feet', .3], ['tree', .25]], bench: [['grass', 1]], feet: [['grass', .6], ['tree', .4]],
  tree: [['grass', .5], ['feet', .5]],
};

/**
 * Mid-Autumn Festival: a rabbit on the grass to the right of the bench. It stays a good while, looking about,
 * twitching its ears, sitting up or hopping a little to and fro; then it hops up onto the
 * bench beside the learner (unless something already stands there, like the tea in dark mode), to the learner's
 * feet, or across to the tree, and later on again. Each jump crouches, springs along a real arc, leaning into it as
 * much as it travels, and squashes a little on landing; it always faces the way it goes.
 */
export function MoonRabbit() {
  const trip = useRef<SVGGElement>(null), face = useRef<SVGGElement>(null), body = useRef<SVGGElement>(null);
  useEffect(() => {
    const [tripEl, faceEl, bodyEl] = [trip.current, face.current, body.current];
    if (!tripEl || !faceEl || !bodyEl || stillScene()) return;
    const ears = [...bodyEl.querySelectorAll<SVGGElement>('.field-rabbit-ear')];
    const stop = new AbortController(), { signal } = stop;
    let spot: RabbitSpot = 'grass', pos = RABBIT_SPOTS.grass;
    const benchTaken = () => [...(tripEl.ownerSVGElement?.querySelectorAll('[data-bench-item]') ?? [])]
      .some(item => getComputedStyle(item).display !== 'none');
    // Drawn facing right.
    const faceLeft = (left: boolean) => { faceEl.style.transform = left ? 'scaleX(-1)' : ''; };
    const jump = async (to: Point, lift: number, airborne: number) => {
      const across = Math.abs(to[0] - pos[0]);
      if (across > 0) faceLeft(to[0] < pos[0]);
      // It leans only as much as it travels: a hop on the spot goes straight up and down.
      const lean = Math.min(1, across / 45), tilt = (degrees: number) => `rotate(${(degrees * lean).toFixed(1)}deg)`;
      await play(bodyEl, [{ transform: 'none' }, { transform: 'scale(1.1, .82)' }], lift > 30 ? 200 : 110, signal, 'ease-out');
      await Promise.all([
        play(tripEl, arc(pos, to, lift), airborne, signal),
        play(bodyEl, [{ transform: 'scale(1.1, .82)' }, { transform: `scale(.92, 1.1) ${tilt(-12)}`, offset: .22 },
          { transform: tilt(-3), offset: .5 }, { transform: tilt(7), offset: .88 }, { transform: tilt(5) }], airborne, signal),
      ]);
      pos = to;
      await play(bodyEl, [{ transform: tilt(5) }, { transform: 'scale(1.08, .88)', offset: .35 }, { transform: 'scale(.98, 1.02)', offset: .7 },
        { transform: 'none' }], 230, signal, 'ease-out');
    };
    // Along the grass it goes in short bounces rather than one long leap, quicker over a longer way.
    const bounce = async (to: Point) => {
      const from = pos, far = Math.abs(to[0] - from[0]) > 150;
      const steps = Math.max(1, Math.round(Math.abs(to[0] - from[0]) / (far ? 36 : 40)));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        await jump([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], far ? 11 : 13, far ? 260 : 300);
        if (step < steps) await pause(far ? between(30, 80) : between(60, 160), signal);
      }
    };
    const twitch = (ear: SVGGElement, delay: number) => pause(delay, signal).then(() => play(ear, [{ transform: 'none' },
      { transform: 'rotate(-16deg)', offset: .25 }, { transform: 'none', offset: .5 }, { transform: 'rotate(-8deg)', offset: .75 }, { transform: 'none' }], 480, signal));
    // The little things it does while it stays.
    const fidget = async () => {
      const roll = Math.random(), room = RABBIT_ROOM[spot];
      if (roll < .25) faceLeft(!faceEl.style.transform);
      else if (roll < .47) await (Math.random() < .5 ? Promise.all(ears.map((ear, i) => twitch(ear, i * 90))) : twitch(ears[Math.floor(Math.random() * ears.length)], 0));
      else if (roll < .62) await play(bodyEl, [{ transform: 'none' }, { transform: 'scale(.94, 1.09)', offset: .2 }, { transform: 'scale(.94, 1.09)', offset: .8 },
        { transform: 'none' }], between(1200, 2200), signal, 'ease-in-out'); // sits up and looks round
      else if (room) {
        const to: Point = [RABBIT_SPOTS[spot][0] + between(room[0], room[1]), 0];
        await jump(Math.abs(to[0] - pos[0]) > 5 ? to : pos, 9, 260);
      } else faceLeft(!faceEl.style.transform);
    };
    (async () => {
      for (;;) {
        await linger(stayFor(), signal, fidget);
        const choices: Array<[RabbitSpot, number]> = RABBIT_NEXT[spot].filter(([next]) => next !== 'bench' || !benchTaken());
        let roll = Math.random() * choices.reduce((sum, [, weight]) => sum + weight, 0);
        const next: RabbitSpot = choices.find(([, weight]) => (roll -= weight) < 0)?.[0] ?? choices[choices.length - 1][0];
        if (next === 'bench') await jump(RABBIT_SPOTS.bench, 58, 520);
        else if (spot === 'bench') await jump(RABBIT_SPOTS.grass, 24, 480);
        else await bounce(RABBIT_SPOTS[next]);
        spot = next;
        if (spot === 'bench' || spot === 'feet') faceLeft(true); // settle facing the learner
        else if (spot === 'tree') faceLeft(false);
      }
    })().catch(() => undefined);
    return () => {
      stop.abort();
      for (const element of [tripEl, faceEl, bodyEl, ...ears]) element.style.transform = '';
    };
  }, []);
  return <g ref={trip}><g ref={face} className="field-rabbit-face"><g ref={body} className="field-rabbit-hop">
    <Ink points={[[504,377],[502,365],[508,355],[520,352],[530,358],[533,370],[530,377]]} width={2.6} closed fill="var(--bg)" />
    <circle cx={501} cy={368} r={3.4} fill="var(--bg)" stroke="currentColor" strokeWidth={2} />
    <g className="field-rabbit-ear"><Ink points={[[523,346],[520,326],[523,322],[527,328],[528,344]]} width={2.4} closed fill="var(--bg)" /></g>
    <g className="field-rabbit-ear">
      <Ink points={[[531,346],[532,327],[536,324],[539,330],[536,346]]} width={2.4} closed fill="var(--bg)" />
    </g>
    <Ink points={[[519,352],[518,344],[525,338],[535,339],[541,347],[537,355],[527,358]]} width={2.6} closed fill="var(--bg)" />
    <circle cx={532} cy={346} r={1.6} fill="currentColor" />
  </g></g></g>;
}

/** Halloween: a carved pumpkin on the grass between the tree and the bench; its face glows at night. */
function Pumpkin() {
  return <g>
    <path d="M217 348 Q216 341 222 338" fill="none" stroke="var(--paint-stem)" strokeWidth={3} strokeLinecap="round" />
    <Ink points={[[216,349],[202,351],[196,362],[201,374],[216,378],[232,374],[237,362],[231,351]]} width={2.8} closed fill="var(--paint-pumpkin)" />
    <path d="M210 350 Q205 363 210 377 M223 350 Q228 363 223 377" fill="none" stroke="color-mix(in srgb, currentColor 35%, var(--paint-pumpkin))" strokeWidth={1.5} />
    <g fill="var(--pumpkin-face)">
      <path d="M205 361 L209 355 L213 361 Z" /><path d="M220 361 L224 355 L228 361 Z" />
      <path d="M204 366 L208 369 L212 366 L216 370 L220 366 L224 369 L229 366 L226 372 L208 372 Z" />
    </g>
  </g>;
}

/** Christmas: a Santa hat on the learner, in the bench-and-learner drawing (before its scale). */
export function SantaHat() {
  return <g>
    <Ink points={[[296,153],[311,127],[331,116],[347,124],[338,151]]} width={3} closed fill="var(--paint-red)" />
    <Ink points={[[289,160],[313,152],[341,157],[340,149],[313,145],[291,152]]} width={3} closed fill="var(--paint-white)" />
    <circle cx={349} cy={126} r={6} fill="var(--paint-white)" stroke="currentColor" strokeWidth={2.6} />
  </g>;
}

/**
 * A cup of tea steaming beside the learner on the bench after dark (bench drawing, before its scale); in winter a hot
 * drink stands there all day. On April Fools' Day the cup stands upside down in daylight instead.
 */
export function Tea({ upsideDown = false, hot = false }: { upsideDown?: boolean; hot?: boolean }) {
  return <g className={upsideDown ? 'field-day-only' : hot ? undefined : 'field-night-only'} data-bench-item="">
    <g transform={upsideDown ? 'rotate(180 410 281)' : undefined}>
      <Ink points={[[398,272],[422,272],[419,290],[401,290]]} width={3} closed fill="var(--bg)" paint="var(--paint-cup)" shift={[-1.6, -1.1]} />
      <path d="M421 276 C430 276 430 286 420 286" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />
    </g>
    {!upsideDown && <g className="field-steam" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M405 266 C401 260 409 256 405 249" /><path className="field-steam-second" d="M414 266 C410 260 418 256 414 249" />
    </g>}
  </g>;
}

/** Summer: an iced drink with a straw on the bench beside the learner, in the tea's place (bench drawing). */
export function IcedDrink() {
  return <g data-bench-item="">
    <path d="M414 270 L420 247 L427 244" fill="none" stroke="var(--paint-straw-stripe)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    <path d={smoothPath([[401,268],[419,268],[418,289],[402,289]], true)} fill="var(--paint-drink)" transform="translate(-1.6 -1.1)" />
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round">
      <path d="M404 272 L410 271 L411 277 L405 278 Z" /><path d="M410.5 278.5 L416 277 L417.5 282.5 L412 284 Z" />
    </g>
    <Ink points={[[399,263],[421,263],[419,290],[401,290]]} width={3} closed />
  </g>;
}

/**
 * The learner's outfit for the season, over the sweater (bench drawing): an open light cardigan over a cream top in
 * spring, a light short-sleeved tee in summer. Autumn keeps the film's green sweater; winter adds a scarf (below).
 */
export function SeasonTop({ season }: { season: Season }) {
  if (season === 'spring') {
    return <g>
      <Ink points={[[309,195],[341,197],[326,219]]} width={2.8} closed fill="var(--paint-cream)" />
      <Ink points={[[326,219],[327,243]]} width={2.8} />
    </g>;
  }
  if (season === 'summer') {
    return <g>
      {/* Short sleeves end halfway down the upper arm: bare below the hems, down the upper arm, round the elbow and
          along the forearm to the hand; the other arm shows only a little above the lid. */}
      <path d={smoothPath([[357,243],[389,245],[392,262],[386,278],[377,286],[364,288],[338,286],[329,276],[333,260],[352,260],[357,250]], true)}
        fill="var(--paint-skin)" />
      <path d={smoothPath([[273,233],[285,235],[281,245],[270,244]], true)} fill="var(--paint-skin)" />
      <Ink points={[[355,242],[373,245],[391,244]]} width={3} />
      <Ink points={[[272,232],[287,234]]} width={3} />
      <Ink points={[[310,197],[325,204],[341,198]]} width={2.8} />
    </g>;
  }
  return null;
}

/** Winter: a mustard knit scarf round the neck with one end hanging down (bench drawing, over the head's chin). */
export function WinterScarf() {
  return <g>
    <Ink points={[[328,196],[339,222],[331,226],[321,199]]} width={2.8} closed fill="var(--paint-knit)" />
    <path d="M326 207 L334 205 M329 215 L336 213" stroke="var(--paint-knit-stripe)" strokeWidth={2.4} strokeLinecap="round" fill="none" />
    <Ink points={[[296,184],[318,190],[343,183],[347,192],[336,200],[318,203],[299,199],[292,191]]} width={3} closed fill="var(--paint-knit)" />
    <path d="M305 189 Q308 195 306 200 M331 189 Q333 195 331 200" stroke="var(--paint-knit-stripe)" strokeWidth={2.2} strokeLinecap="round" fill="none" />
  </g>;
}

/** Summer: a denim-blue bucket hat over the light blue tee (bench drawing), a shade deeper than the tee, with a cream
 * band and a stitched, sloping brim. */
function BucketHat() {
  return <g>
    <Ink points={[[298,153],[300,139],[310,132],[322,132],[331,138],[333,153]]} width={3} closed fill="var(--bg)" paint="var(--paint-plate-line)" />
    <path d="M300 148 Q316 144 332 148" fill="none" stroke="var(--paint-cream)" strokeWidth={4} strokeLinecap="round" />
    <Ink points={[[293,151],[316,148],[339,151],[349,164],[316,160],[283,164]]} width={3} closed fill="var(--bg)" paint="var(--paint-plate-line)" />
    <path d="M291 158 Q316 154.5 342 158" fill="none" stroke="var(--paint-cream)" strokeWidth={1.6} strokeLinecap="round" strokeDasharray="3 3.5" />
  </g>;
}

/** The season's hat (bench drawing): a bucket hat in summer, a knitted bobble hat in winter. */
export function SeasonHat({ season }: { season: Season }) {
  if (season === 'summer') return <BucketHat />;
  if (season === 'winter') {
    return <g>
      <Ink points={[[290,160],[294,146],[305,137],[318,134],[331,139],[339,149],[341,160]]} width={3} closed fill="var(--paint-knit)" />
      <Ink points={[[287,160],[314,154],[343,159],[343,167],[314,162],[287,168]]} width={3} closed fill="var(--paint-knit-stripe)" />
      <circle cx={317} cy={130} r={6.5} fill="var(--paint-cream)" stroke="currentColor" strokeWidth={2.6} />
    </g>;
  }
  return null;
}

/** The bench-and-learner drawing is shrunk into the scene; animals drawn in its units go through the same. */
const BENCH_SCALE = 'translate(345 373) scale(.86) translate(-345 -373)';

/** The Milky Way's course across the night sky, above the moon and clear of the crown. */
const MILKY_WAY = 'M302 28 C382 30 472 48 596 110';
const MILKY_WAY_POINTS = [[302, 28], [382, 30], [472, 48], [596, 110]];
/** A point on the course at t (0 to 1) and the unit normal there. */
function milkyWayAt(t: number): [number, number, number, number] {
  const u = 1 - t, [p0, p1, p2, p3] = MILKY_WAY_POINTS;
  const axis = (k: 0 | 1) => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k];
  const slope = (k: 0 | 1) => 3 * u * u * (p1[k] - p0[k]) + 6 * u * t * (p2[k] - p1[k]) + 3 * t * t * (p3[k] - p2[k]);
  const len = Math.hypot(slope(0), slope(1)) || 1;
  return [axis(0), axis(1), -slope(1) / len, slope(0) / len];
}
const r1 = (value: number) => Math.round(value * 10) / 10;
/** Where the stars of the river crowd together: two soft clusters along it. */
const MILKY_WAY_CLUSTERS = [.3, .66];
/**
 * The river of stars, the same every night: a brighter core of uneven density (soft blobs along the course) and star
 * dust in three sizes, thick near the middle, thinner at the edges, gathering in the clusters.
 */
const MILKY_WAY_STARS = (() => {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => (next() + next() + next() - 1.5) / 1.5;
  const core = Array.from({ length: 16 }, (_, i) => {
    const t = (i + .5) / 16, [x, y, nx, ny] = milkyWayAt(t), off = gauss() * 5;
    const near = Math.max(...MILKY_WAY_CLUSTERS.map(c => 1 - Math.min(1, Math.abs(t - c) / .12)));
    return [r1(x + nx * off), r1(y + ny * off), r1(9 + next() * 7 + near * 6), r1(.3 + next() * .35 + near * .35)];
  });
  const dust = Array.from({ length: 170 }, () => {
    const clustered = next() < .35, centre = MILKY_WAY_CLUSTERS[next() < .5 ? 0 : 1];
    const t = clustered ? centre + gauss() * .05 : .02 + next() * .96;
    const [x, y, nx, ny] = milkyWayAt(Math.min(.99, Math.max(.01, t))), spread = clustered ? 7 : next() < .65 ? 10 : 20;
    const off = gauss() * spread, size = next();
    return [r1(x + nx * off + (next() - .5) * 4), r1(y + ny * off), size < .62 ? .55 : size < .9 ? .9 : 1.35];
  });
  return { core, dust };
})();

/** A brighter star: a small soft halo, a dot and four short rays; it does not twinkle. */
function BrightStar({ x, y, size }: { x: number; y: number; size: number }) {
  return <g>
    <circle cx={x} cy={y} r={size * 2.6} fill="currentColor" opacity={.16} />
    <circle cx={x} cy={y} r={size} fill="currentColor" />
    <path d={`M${x} ${y - size * 3.4} V${y + size * 3.4} M${x - size * 3.4} ${y} H${x + size * 3.4}`} stroke="currentColor"
      strokeWidth={size * .7} strokeLinecap="round" opacity={.8} />
  </g>;
}

/**
 * Qixi night: the Milky Way flows across the sky as a river of stars (a faint wide glow, a brighter core of uneven
 * density, dust in three sizes with two soft clusters), with the Weaver Girl (Vega) and the Cowherd (Altair) shining
 * on either side of it. Calm: nothing in it twinkles.
 */
export function MilkyWay() {
  const id = `field-milky-way-${useId().replace(/:/g, '')}`;
  const { core, dust } = MILKY_WAY_STARS;
  return <g className="field-milky-way" color="var(--paint-starlight)">
    {/* Soft light rather than bands with edges; it never moves, so the blurs are drawn once. */}
    <filter id={`${id}-wide`} x="-30%" y="-120%" width="160%" height="340%"><feGaussianBlur stdDeviation={14} /></filter>
    <filter id={`${id}-core`} x="-30%" y="-120%" width="160%" height="340%"><feGaussianBlur stdDeviation={6} /></filter>
    <path d={MILKY_WAY} fill="none" stroke="currentColor" strokeWidth={64} strokeLinecap="round" opacity={.09} filter={`url(#${id}-wide)`} />
    <g fill="currentColor" opacity={.32} filter={`url(#${id}-core)`}>
      {core.map(([x, y, r, o]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity={o} />)}
    </g>
    <g fill="currentColor">{dust.map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} opacity={r > 1 ? .85 : r > .6 ? .65 : .45} />)}</g>
    {/* Vega above the river (the Weaver Girl), Altair below it across the water (the Cowherd). */}
    <BrightStar x={356} y={62} size={2} />
    <BrightStar x={536} y={46} size={1.7} />
  </g>;
}

/**
 * Where the magpie perches, as moves from the end of the backrest: the right branch, the treetop, the left branch,
 * and the grass right of the bench and between the tree and the bench. On the backrest and the grass it can hop
 * about a little (`walk`, the range left and right); on the grass it pecks for food.
 */
const MAGPIE_PERCHES: Array<{ at: Point; walk?: [number, number]; ground?: boolean }> = [
  { at: [0, 0], walk: [-24, 0] }, { at: [-222, -77] }, { at: [-265, -120] }, { at: [-311, -35] },
  { at: [40, 148], walk: [-18, 20], ground: true }, { at: [-215, 148], walk: [-6, 16], ground: true },
];

/**
 * Qixi: a magpie (they build the bridge for the two lovers). It stays a good while, looking left and right,
 * pecking, flicking its tail, fluttering its wings or hopping about, then flies off to any other perch at random.
 * Its wing shows only when it flies or flutters, and it faces the way it goes. The trip moves it in the scene's own
 * units; its body is drawn in the bench's units like the bench it starts on.
 */
export function Magpie() {
  const trip = useRef<SVGGElement>(null), face = useRef<SVGGElement>(null);
  useEffect(() => {
    const [tripEl, faceEl] = [trip.current, face.current];
    const head = tripEl?.querySelector<SVGGElement>('.field-magpie-head'), tail = tripEl?.querySelector<SVGGElement>('.field-magpie-tail');
    if (!tripEl || !faceEl || !head || !tail || stillScene()) return;
    const stop = new AbortController(), { signal } = stop;
    let perch = 0, pos = MAGPIE_PERCHES[0].at;
    // Drawn facing left.
    const faceRight = (right: boolean) => { faceEl.style.transform = right ? 'scaleX(-1)' : ''; };
    const withClass = async (name: string, action: () => Promise<void>) => {
      tripEl.classList.add(name);
      try { await action(); } finally { tripEl.classList.remove(name); }
    };
    // The little things it does while it stays.
    const fidget = async () => {
      const { at, walk, ground } = MAGPIE_PERCHES[perch], roll = Math.random();
      if (roll < .26) faceRight(!faceEl.style.transform);
      else if (roll < .5) {
        const deep = ground ? -46 : -24;
        await play(head, [{ transform: 'none' }, { transform: `rotate(${deep}deg)` }, { transform: `rotate(${deep / 4}deg)` },
          { transform: `rotate(${deep}deg)` }, { transform: 'none' }], ground ? 820 : 640, signal, 'ease-in-out');
      } else if (roll < .64) {
        await play(tail, [{ transform: 'none' }, { transform: 'rotate(-16deg)', offset: .35 }, { transform: 'rotate(5deg)', offset: .7 },
          { transform: 'none' }], 620, signal, 'ease-in-out');
      } else if (roll < .78 || !walk) {
        await withClass('field-magpie-flutter', () => pause(between(450, 900), signal));
      } else {
        const x = at[0] + between(walk[0], walk[1]), steps = Math.max(1, Math.round(Math.abs(x - pos[0]) / 7));
        const from = pos;
        faceRight(x > pos[0]);
        for (let step = 1; step <= steps; step++) {
          const to: Point = [from[0] + (x - from[0]) * step / steps, at[1]];
          await play(tripEl, arc(pos, to, 3, false, 4), 150, signal);
          pos = to;
          await pause(between(40, 110), signal);
        }
      }
    };
    (async () => {
      for (;;) {
        await linger(stayFor(), signal, fidget);
        let next = Math.floor(Math.random() * (MAGPIE_PERCHES.length - 1));
        if (next >= perch) next++;
        const to = MAGPIE_PERCHES[next].at;
        const distance = Math.hypot(to[0] - pos[0], to[1] - pos[1]);
        faceRight(to[0] > pos[0]);
        await withClass('field-magpie-flying', () => play(tripEl, arc(pos, to, 14 + distance * .12, true), 550 + distance * 3.4, signal));
        perch = next;
        pos = to;
      }
    })().catch(() => undefined);
    return () => {
      stop.abort();
      for (const element of [tripEl, faceEl, head, tail]) element.style.transform = '';
    };
  }, []);
  return <g ref={trip}><g ref={face} className="field-magpie-face"><g transform={BENCH_SCALE}>
    <g className="field-magpie-tail"><Ink points={[[433,200],[453,209],[451,213],[432,205]]} width={2.2} closed fill="currentColor" /></g>
    <Ink points={[[411,206],[415,196],[425,192],[434,196],[436,204],[427,208]]} width={2.4} closed fill="currentColor" />
    <Ink points={[[418,204],[422,198],[430,200],[428,206]]} width={1} closed fill="var(--bg)" color="var(--bg)" />
    {/* Only in flight: a wing beating over the back. */}
    <g className="field-magpie-wing"><path d="M419 198 L431 179 L437 197 Z" fill="currentColor" stroke="currentColor"
      strokeWidth={2} strokeLinejoin="round" /></g>
    <g className="field-magpie-head">
      <circle cx={413} cy={192} r={5.6} fill="currentColor" />
      <path d="M408 190.5 L402.5 192.5 L408 194.5 Z" fill="currentColor" />
      <circle cx={411.5} cy={190.8} r={1.3} fill="var(--bg)" />
    </g>
  </g></g></g>;
}

/** Winter solstice: a plate of dumplings on the bench beside the learner (bench drawing), in place of tea. */
export function Dumplings() {
  return <g data-bench-item="">
    <g className="field-steam" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M405 274 C401 268 409 264 405 257" /><path className="field-steam-second" d="M419 273 C415 267 423 263 419 256" />
    </g>
    {[[413, 283], [401, 286.5], [425, 286.5]].map(([x, y]) => <g key={x}>
      <path d={`M${x - 10} ${y - 1} C${x - 6} ${y - 10} ${x + 6} ${y - 10} ${x + 10} ${y - 1} Q${x} ${y + 2} ${x - 10} ${y - 1} Z`} fill="var(--paint-white)" stroke="currentColor" strokeWidth={2}
        strokeLinejoin="round" />
    </g>)}
    <Ink points={[[389,285],[437,285],[432,291],[394,291]]} width={2.4} closed fill="var(--paint-plate)" />
    <path d="M395 288 H431" stroke="var(--paint-plate-line)" strokeWidth={1.4} strokeLinecap="round" />
  </g>;
}

/** Lantern Festival: a steaming bowl of tangyuan on the bench beside the learner (bench drawing), in place of tea. */
export function Tangyuan() {
  return <g data-bench-item="">
    {[[405, 276, 'var(--paint-white)'], [421, 276, 'var(--paint-pink)'], [413, 273, 'var(--paint-white)']].map(([x, y, fill]) => <circle key={x} cx={x} cy={y} r={5}
      fill={String(fill)} stroke="currentColor" strokeWidth={2} />)}
    <Ink points={[[395,277],[431,277],[427,285],[418,290],[408,290],[399,285]]} width={2.6} closed fill="var(--paint-plate)" />
    <path d="M398 281 H428" stroke="var(--paint-red)" strokeWidth={1.8} strokeLinecap="round" />
    <g className="field-steam" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M407 265 C403 259 411 255 407 248" /><path className="field-steam-second" d="M419 265 C415 259 423 255 419 248" />
    </g>
  </g>;
}

/** Easter: a painted egg hidden in the grass between the tree and the bench. */
function EasterEgg() {
  return <g transform="rotate(-12 216 366)">
    <ellipse cx={216} cy={366} rx={9.5} ry={12} fill="var(--paint-egg)" stroke="currentColor" strokeWidth={2.4} />
    <path d="M207 364 L211 360 L215 364 L219 360 L223 364 L225.5 361" fill="none" stroke="var(--paint-egg-zigzag)" strokeWidth={2.2}
      strokeLinejoin="round" strokeLinecap="round" />
    <circle cx={212} cy={371} r={1.6} fill="var(--paint-gold)" /><circle cx={220} cy={371} r={1.6} fill="var(--paint-gold)" />
  </g>;
}

/** The one festival touch outside the bench group, or nothing. */
export function OccasionScenery({ occasion }: { occasion: Occasion | null }) {
  switch (occasion) {
    case 'spring-festival': case 'lantern-festival': return <Lantern />;
    case 'new-year': return <Fireworks />;
    case 'valentine': return <TrunkHeart />;
    case 'dragon-boat': return <Zongzi />;
    case 'halloween': return <Pumpkin />;
    case 'easter': return <EasterEgg />;
    default: return null;
  }
}
