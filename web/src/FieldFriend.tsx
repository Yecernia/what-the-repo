import { useId } from 'react';
import { Ink, InkUnion } from './field-ink';
import { handOutline, limbOutline, smoothPath, type PenPoint } from './pen-path';
import type { Season } from './occasions';

/**
 * The friend from the promo film, who comes to the bench on the day a learning route is finished: drawn as the film
 * draws them (a round blank head, sweater and sleeves as one silhouette, mitten hands, short dark trousers and shoes),
 * in the orange family whatever the season, and at the learner's scale. There is no room on the seat, so the friend
 * stands behind the bench, right of the learner, forearms on the backrest, leaning in to see the laptop, and gives a
 * small thumbs-up with the other hand. All in the bench's own (unscaled) drawing: `FriendBehind` goes before the
 * backrest, `FriendFront` after it and before the learner.
 */

const round = (value: number) => Math.round(value * 10) / 10;

/** Where the friend stands: the middle of the body, and the backrest's top edge their elbows rest on. */
const CX = 416;
const BAR = 206;

/** A rounded limb from a to b, closed (as the desk figure's). */
function limb(a: PenPoint, b: PenPoint, r: number): PenPoint[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len, nx = -dy * r, ny = dx * r;
  const m: PenPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [[a[0] + nx, a[1] + ny], [m[0] + nx * 1.04, m[1] + ny * 1.04], [b[0] + nx, b[1] + ny], [b[0] + dx * r, b[1] + dy * r],
    [b[0] - nx, b[1] - ny], [m[0] - nx * .96, m[1] - ny * .96], [a[0] - nx, a[1] - ny], [a[0] - dx * r, a[1] - dy * r]];
}
const at = (x: number, y: number): PenPoint => [round(CX + x), round(y)];

/** The body without its arms: from the neck over the shoulders to a short cap over each, cut straight across where the
 * arm comes out (HEMS); its sides run fairly straight down from under the arms to the waist, on down behind the backrest
 * (seen again between the backrest and the seat). In summer the caps are the tee's short sleeves; in the other seasons
 * the long sleeve goes on from them, of a piece. */
const SIDES = (side: -1 | 1): PenPoint[] => [at(side * 31, 206), at(side * 32, 232), at(side * 32.5, 262), at(side * 33, 296)];
const HEAD: PenPoint[] = [[0, -24], [-17, -20], [-24, -8], [-24, 7], [-16, 19], [0, 23], [16, 19], [24, 7], [24, -8], [17, -20]];
/** The head leans in towards the learner's laptop. */
const HEAD_AT = { x: CX - 9, y: 140, tilt: -17 };

const LINE = 4.6;
/**
 * The arms, each from its shoulder joint (inside the body) through a round elbow to the hand. The friend leans on the
 * backrest: the left elbow rests on it just outside the body, the forearm lies along it in front of the chest and the
 * hand rests on it short of the middle; the right elbow is out beside the backrest's end, and the forearm stands up from
 * it to the thumbs-up.
 */
const ARMS = {
  l: { shoulder: at(-33, 180), elbow: at(-48, BAR - 2), wrist: at(-10, BAR - 3) },
  r: { shoulder: at(33, 180), elbow: at(48, BAR - 1), wrist: at(51, 167) },
};
/** Summer: below each cap's straight hem (HEMS, the middle of the arm there, along it from the shoulder joint) the arm
 * is bare (BARE), on to the hand (HAND), of a piece with it; the hem's line runs a little past the arm (HEM_PAST). */
const BARE = 7;
const HAND = 8.5;
const HEM_PAST = 1.8;
const HEM_AT = 10.5;
function along(side: 'l' | 'r', k: number): PenPoint {
  const { shoulder, elbow } = ARMS[side], length = Math.hypot(elbow[0] - shoulder[0], elbow[1] - shoulder[1]);
  return [round(shoulder[0] + (elbow[0] - shoulder[0]) / length * k), round(shoulder[1] + (elbow[1] - shoulder[1]) / length * k)];
}
const HEMS = { l: along('l', HEM_AT), r: along('r', HEM_AT) };
/** Summer: an end of a hem's line, a little past the bare arm (HEM_PAST): towards the chest (`inner` 1) or out (-1);
 * `up` moves it up the arm (so the line also covers the bare arm's colour, nudged up and left past its own top line). */
function hemEnd(side: 'l' | 'r', inner: 1 | -1, up = 1): PenPoint {
  const { shoulder, elbow } = ARMS[side], k = (side === 'l' ? 1 : -1) * inner * (BARE + HEM_PAST), hem = HEMS[side];
  const length = Math.hypot(elbow[0] - shoulder[0], elbow[1] - shoulder[1]), dx = (elbow[0] - shoulder[0]) / length, dy = (elbow[1] - shoulder[1]) / length;
  return [round(hem[0] + dy * k - dx * up), round(hem[1] - dx * k - dy * up)];
}
const BODY: PenPoint[] = [at(0, 163), at(-20, 164), at(-34, 171), ...shoulder(-1), ...SIDES(-1), at(0, 298), ...SIDES(1).reverse(), ...shoulder(1).reverse(),
  at(34, 171), at(20, 164)];
function shoulder(side: -1 | 1): PenPoint[] {
  const arm = side < 0 ? 'l' : 'r', ends = [hemEnd(arm, -1, 0), hemEnd(arm, 1, 0)];
  return [at(side * 41, 177), ...ends];
}

function Shoe({ side }: { side: -1 | 1 }) {
  const points: PenPoint[] = Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * Math.PI * 2;
    return [round(CX + side * 21 + Math.cos(a) * 14), round(364 + Math.sin(a) * (i < 6 ? 7 : 6))];
  });
  return <Ink points={points} width={LINE * .85} closed fill="var(--paint-friend-shoe)" />;
}

/** The friend's body behind the bench: shoes, trousers, the sweater (with the season's outfit on it) and the head. */
export function FriendBehind({ season }: { season: Season }) {
  return <g className="field-friend">
    {([-1, 1] as const).map(side => <g key={side}>
      <Shoe side={side} />
      <Ink points={limb(at(side * 17, 296), at(side * 18, 354), 12)} width={LINE} closed fill="var(--bg)" paint="var(--paint-friend-trousers)" />
    </g>)}
    <Ink points={BODY} width={LINE * 1.05} closed fill="var(--bg)" paint="var(--paint-friend)" />
    {/* A long sleeve leaves the body in a soft armpit (FriendFront): the body's colour over its own right side above
        it, so no line runs on up behind the sleeve (here, so the backrest's winter snow still lies over it). */}
    {season !== 'summer' && <path d={`M${CX + 27.6} 186H${CX + 33.6}V203.6H${CX + 27.6}Z`} fill="var(--paint-friend)" />}
    <FriendOutfit season={season} />
    {/* Summer: a short sleeve's inner edge, from the armpit down to its hem (FriendFront draws the hem). */}
    {season === 'summer' && (['l', 'r'] as const).map(side => <Ink key={side} points={[at(side === 'l' ? -27 : 27, 179), hemEnd(side, 1)]} width={LINE * .8} />)}
    <g className="field-friend-head">
      <g transform={`translate(${HEAD_AT.x} ${HEAD_AT.y}) rotate(${HEAD_AT.tilt})`}>
        <Ink points={HEAD} width={4.4} closed fill="var(--bg)" paint="var(--paint-skin)" />
        {season === 'winter' && <FriendHat />}
      </g>
    </g>
    {season === 'winter' && <FriendScarf />}
  </g>;
}

/** What the season adds on the sweater: a cardigan's open front over a cream top in spring, a tee's round neck in
 * summer, a ribbed neck in autumn, a coat's toggles in winter (under the scarf). */
function FriendOutfit({ season }: { season: Season }) {
  if (season === 'spring') {
    return <g>
      <Ink points={[at(-10, 165), at(10, 165), at(4, 296), at(-4, 296)]} width={LINE * .7} closed fill="var(--paint-cream)" />
      <path d={`M${CX - 1} 240 v2 M${CX - 1} 262 v2`} stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </g>;
  }
  if (season === 'summer') return <path d={`M${CX - 13} 165 Q${CX} 174 ${CX + 13} 165`} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" />;
  if (season === 'autumn') return <Ink points={[at(-14, 165), at(0, 171), at(14, 165)]} width={2.6} />;
  return <g stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
    <path d={`M${CX} 230 V296`} />
    <path d={`M${CX - 5} 248 h8 M${CX - 5} 270 h8`} stroke="var(--paint-cream)" strokeWidth={3} />
  </g>;
}

/** Winter: a knitted scarf, a deep red to set it apart from the learner's mustard one. */
function FriendScarf() {
  return <g>
    <Ink points={[at(14, 168), at(24, 196), at(16, 199), at(6, 171)]} width={2.8} closed fill="var(--paint-friend-scarf)" />
    <Ink points={[at(-24, 160), at(-4, 166), at(20, 159), at(24, 168), at(-2, 175), at(-27, 169)]} width={2.8} closed fill="var(--paint-friend-scarf)" />
    <path d={`M${CX - 14} 164 L${CX - 15} 171 M${CX + 10} 163 L${CX + 11} 170 M${CX + 13} 182 L${CX + 20} 180`} stroke="var(--paint-cream)" strokeWidth={2.2} strokeLinecap="round" fill="none" />
  </g>;
}

/** Winter: a cream knitted beanie with a red band, in the head's own drawing (so it tilts with it). */
function FriendHat() {
  return <g>
    <Ink points={[[-21, -6], [-19, -19], [-8, -27], [8, -27], [19, -19], [21, -6]]} width={2.8} closed fill="var(--paint-cream)" />
    <Ink points={[[-24, -6], [0, -9], [24, -6], [24, 0], [0, -3], [-24, 0]]} width={2.8} closed fill="var(--paint-friend-scarf)" />
    <circle cx={0} cy={-30} r={5} fill="var(--paint-friend-scarf)" stroke="currentColor" strokeWidth={2.4} />
  </g>;
}

/** A round mitten, its colour a little off the line like the rest. */
function Mitten({ x, y, r = 6.6 }: { x: number; y: number; r?: number }) {
  return <g>
    <circle cx={x} cy={y} r={r} fill="var(--bg)" />
    <circle cx={round(x - 1.2)} cy={round(y - .8)} r={r} fill="var(--paint-skin)" />
    <circle cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth={3.4} />
  </g>;
}

/** A fist with the thumb up, at the wrist `x, y` of an arm pointing up. */
function ThumbsUp({ x, y }: { x: number; y: number }) {
  const fist = smoothPath(FIST(x, y), true);
  const thumb = smoothPath(THUMB(x, y), true);
  // A little larger than a mitten, so the thumb still reads at the scene's real size.
  return <g className="field-friend-thumb" transform={`translate(${x} ${y}) scale(1.15) translate(${-x} ${-y})`}>
    <path d={thumb} fill="var(--bg)" /><path d={thumb} fill="var(--paint-skin)" transform="translate(-1.2 -.8)" />
    <path d={thumb} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinejoin="round" />
    <path d={fist} fill="var(--bg)" /><path d={fist} fill="var(--paint-skin)" transform="translate(-1.2 -.8)" />
    <path d={fist} fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinejoin="round" />
    <path d={`M${x + 1} ${y - 8} h6 M${x + 1} ${y - 3.5} h6`} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
  </g>;
}
const FIST = (x: number, y: number): PenPoint[] => [[x - 7.5, y - 1], [x - 8, y - 9], [x - 3, y - 13], [x + 6, y - 13], [x + 8.5, y - 7], [x + 7.5, y], [x, y + 1.5]];
const THUMB = (x: number, y: number): PenPoint[] => [[x - 6, y - 11], [x - 7, y - 20], [x - 3.5, y - 23.5], [x - .5, y - 20], [x, y - 12]];
/** Summer: the fist as a shape in the arm's own drawing (ThumbsUp draws it 1.15 times as large about the wrist), so
 * the bare forearm and the fist can be inked as one. */
const bigFist = (x: number, y: number) => smoothPath(FIST(x, y).map(([px, py]): PenPoint => [x + (px - x) * 1.15, y + (py - y) * 1.15]), true);

/**
 * A long sleeve (spring's cardigan, autumn's sweater, winter's coat), cloth round the arm rather than paint on it: looser
 * than the arm, a soft rounded bag at the outer elbow, the cloth gathered at the inner crook (`folds`), a band of cuff
 * where the hand comes out, and where it leaves the body no sharp notch but a soft, slightly drooping turn. Its outline
 * runs from where it leaves the body's line (`line`, inked) round the arm and back inside the body (`under`, colour
 * only, well clear of the body's own lines), so sleeve and body are one piece. Each point's third number is its share of
 * winter's puffier coat (none where the sleeve meets the body).
 */
type SleevePoint = readonly [x: number, y: number, give?: number];
type LongSleeve = { line: SleevePoint[]; under: SleevePoint[]; cuff: PenPoint[]; folds: PenPoint[][] };
const on = (x: number, y: number, give = 1): SleevePoint => [round(CX + x), round(y), give];
const LONG: Record<'l' | 'r', LongSleeve> = {
  // On the backrest: from the shoulder down the outside to the bagged elbow, along the rail under the forearm to the
  // cuff, back along its top to the crook, where the line folds on down into the sleeve as a crease.
  l: {
    line: [on(-37.7, 173.8, 0), on(-41, 177, 0), on(-47.2, 185, .5), on(-53.2, 194), on(-57.4, 201.5), on(-58.4, 208), on(-55, 213.2), on(-48, 215),
      on(-36, 214.2), on(-23, 213.2), on(-13.5, 212.4), on(-11.5, 208), on(-11.5, 198), on(-13.5, 194.2), on(-22, 194.4),
      on(-27, 194.5), on(-30.4, 195.3, .5), on(-33.4, 197.2, .3), on(-36.8, 198.8, .2)],
    under: [on(-33.6, 196.6, 0), on(-29.6, 193.4, 0), on(-26, 186, 0), on(-30, 180.5, 0), on(-34.3, 177.4, 0)],
    cuff: [at(-14.4, 196), at(-13, 194.6), at(-9.6, 194.8), at(-8.2, 196.4), at(-8, 209.8), at(-9.4, 211.4), at(-13, 211.6), at(-14.2, 210)],
    folds: [[at(-32.4, 201.4), at(-35.8, 202.8), at(-38.6, 203.4)]],
  },
  // The thumbs-up: from the shoulder's line a soft crook up the forearm's inside to the cuff, down its outside to the
  // bagged elbow, back up under the upper arm and over a soft armpit into the body's side.
  r: {
    line: [on(34, 171, 0), on(36.3, 172.6, 0), on(38.1, 174, 0), on(39.5, 175.4, 0), on(41.4, 177.1, .3), on(43, 176.2, .5), on(43.8, 173.6), on(44, 167.8), on(58.8, 167.6),
      on(60, 172), on(61, 183), on(62.2, 196), on(61.8, 207), on(57.5, 214.2), on(50.5, 217), on(44, 214.4), on(40, 209, .6),
      on(37, 206, .3), on(34.2, 204.6, .1), on(32, 204.4, 0), on(31, 206.4, 0), on(31, 208.4, 0)],
    under: [on(29.6, 204.6, 0), on(28.6, 201.4, 0), on(25.5, 199.2, 0), on(26.6, 190, 0), on(31.2, 175.2, 0)],
    cuff: [at(43.4, 169), at(44.8, 167.6), at(57.6, 167.6), at(59, 169), at(59, 172.6), at(57.6, 174), at(44.8, 174), at(43.4, 172.6)],
    folds: [[at(42.4, 180), at(44.2, 184.6), at(46.2, 188.4)]],
  },
};
/** Winter's coat stands a little further off the arm: each point pushed out from the arm's bones by `puff` (its share). */
function loosen(side: 'l' | 'r', points: SleevePoint[], puff: number): PenPoint[] {
  const { shoulder, elbow, wrist } = ARMS[side];
  const away = ([x, y]: SleevePoint, a: PenPoint, b: PenPoint) => {
    const [vx, vy] = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
    const [qx, qy] = [x - a[0] - vx * t, y - a[1] - vy * t], d = Math.hypot(qx, qy) || 1;
    return { d, dx: qx / d, dy: qy / d };
  };
  return points.map(p => {
    const near = [away(p, shoulder, elbow), away(p, elbow, wrist)].sort((m, n) => m.d - n.d)[0], k = puff * (p[2] ?? 1);
    return [round(p[0] + near.dx * k), round(p[1] + near.dy * k)];
  });
}

/** The arms in front of the body and on the backrest. A long sleeve (LONG) is cloth of a piece with the body, ending at
 * a cuff over a mitten (on the right, the thumbs-up fist). Summer's bare arms are each one shape from the short sleeve's
 * hem through a round elbow to the hand, with no line where its parts join, growing into the hand (on the right, into
 * the fist). The right arm turns a little about its shoulder for the thumb's nudge. */
export function FriendFront({ season }: { season: Season }) {
  const id = `friend-${useId().replace(/:/g, '')}`, { l, r } = ARMS;
  const [x, y] = [r.wrist[0] - .5, r.wrist[1] + 2];
  // The right arm turns about its shoulder (the stylesheet's transform-origin for .field-friend-wave).
  const wave = { className: 'field-friend-wave' };
  if (season === 'summer') {
    const thumb = smoothPath(THUMB(x, y), true), length = Math.hypot(l.wrist[0] - l.elbow[0], l.wrist[1] - l.elbow[1]);
    const bare = { width: LINE, fill: 'var(--bg)', paint: 'var(--paint-skin)' };
    const hem = (side: 'l' | 'r') => <path d={`M${hemEnd(side, 1).join(' ')}L${hemEnd(side, -1).join(' ')}`} stroke="currentColor"
      strokeWidth={LINE * .95} strokeLinecap="round" />;
    const forearm = limbOutline(r.elbow, r.wrist, BARE);
    return <g className="field-friend">
      <InkUnion {...bare} paths={[limbOutline(HEMS.l, l.elbow, BARE, true), limbOutline(l.elbow, l.wrist, BARE),
        handOutline(l.wrist, [(l.wrist[0] - l.elbow[0]) / length, (l.wrist[1] - l.elbow[1]) / length], BARE, HAND)]} />
      {hem('l')}
      <g {...wave}>
        {/* The thumb as ThumbsUp draws it, then the bare arm and the fist as one shape, the hem (behind the raised
            forearm) and the knuckles. */}
        <g className="field-friend-thumb" transform={`translate(${x} ${y}) scale(1.15) translate(${-x} ${-y})`}>
          <path d={thumb} fill="var(--bg)" /><path d={thumb} fill="var(--paint-skin)" transform="translate(-1.2 -.8)" />
          <path d={thumb} fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinejoin="round" />
        </g>
        <InkUnion {...bare} paths={[limbOutline(HEMS.r, r.elbow, BARE, true), forearm, bigFist(x, y)]} />
        <clipPath id={`${id}-fore`}><path d={`M300 100H600V300H300Z ${forearm}`} clipRule="evenodd" /></clipPath>
        <g clipPath={`url(#${id}-fore)`}>{hem('r')}</g>
        <g transform={`translate(${x} ${y}) scale(1.15) translate(${-x} ${-y})`}>
          <path d={`M${x + 1} ${y - 8} h6 M${x + 1} ${y - 3.5} h6`} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        </g>
      </g>
    </g>;
  }
  // The body's colour runs on into the sleeve (no paper under it, nothing nudged off), over the body's straight hem across
  // the shoulder; the sleeve's line starts on the body's line and ends on it.
  const puff = season === 'winter' ? 1.6 : 0;
  const sleeve = (side: 'l' | 'r') => {
    const { line, under, cuff, folds } = LONG[side], edge = loosen(side, line, puff);
    return <g className="field-friend-sleeve">
      <path d={`${smoothPath(edge)}${loosen(side, under, puff).map(([px, py]) => `L${px} ${py}`).join('')}Z`} fill="var(--paint-friend)" />
      <path d={smoothPath(edge)} fill="none" stroke="currentColor" strokeWidth={LINE * .95} strokeLinecap="round" strokeLinejoin="round" />
      {folds.map((fold, i) => <path key={i} d={smoothPath(fold)} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />)}
      <Ink points={cuff} width={LINE * .8} closed fill="var(--paint-friend)" paint="var(--paint-friend)" />
    </g>;
  };
  return <g className="field-friend">
    {sleeve('l')}
    <Mitten x={round(l.wrist[0] + 8)} y={round(l.wrist[1] - .3)} />
    <g {...wave}>
      {sleeve('r')}
      <ThumbsUp x={x} y={y} />
    </g>
  </g>;
}
