import { penPath, smoothPath, type PenPoint } from './pen-path';

/** The product mark: a learner reaching into a computer folder and pulling out a page of code, drawn with the
 * same weighted pen as the illustrations. Shared by the in-app mark and scripts/generate-brand-icons.mjs. */
type Stroke = { points: PenPoint[]; width: number; closed?: boolean };

// Close pairs of points keep the folder's corners and tab crisp instead of letting the curve round them off.
const back: Stroke = { closed: true, width: 2.2, points: [[17.1,14.2,.85],[17.6,13,1],[18.4,12.8,1],[24.4,12.7,.9],[25,13.1,1],[26.8,15.4,1.1],
  [27.6,15.7,1],[39.8,15.8,.85],[40.7,16.6,1],[40.9,27,1.1],[40.6,38.2,.9],[39.8,38.9,1],[29,39.1,1.1],[18.2,38.9,.9],[17.3,38.1,1],[17,26,1.1]] };
const page: Stroke = { closed: true, width: 1.9, points: [[22.6,10.3,.85],[27.6,9.6,1.1],[32,8.9,.9],[35.3,11.8,1],[36.2,17,1.1],[37,22.4,.9],
  [36.3,23,1],[30.4,23.9,1.1],[24.6,24.7,.9],[24,24.2,1],[23.3,17.5,1.1],[22.4,10.9,1]] };
const pageLines: Stroke[] = [
  { width: 1.5, points: [[25.6,14.8,.7],[28.5,14.3,1.1],[31.2,13.9,.8]] },
  { width: 1.5, points: [[26,17.8,.7],[29.8,17.2,1.1],[33.4,16.7,.8]] },
  { width: 1.5, points: [[26.4,20.8,.7],[28.6,20.5,1.1],[30.2,20.2,.8]] },
];
// The next page out of the folder has different writing on it.
const nextPageLines: Stroke[] = [
  { width: 1.5, points: [[25.4,13.8,.7],[29.6,13.2,1.1],[33,12.8,.8]] },
  { width: 1.5, points: [[25.9,17,.7],[27.8,16.7,1.1],[29.4,16.5,.8]] },
  { width: 1.5, points: [[26.3,20.2,.7],[29.8,19.7,1.1],[33.8,19.2,.8]] },
];
const front: Stroke = { closed: true, width: 2.2, points: [[16.2,22.6,.85],[29,22.3,1.1],[41.8,22.6,.9],[42.5,23.4,1],[41.7,31,1.1],[41,38.3,.9],
  [40,39,1],[29,39.2,1.1],[18,38.9,.9],[17,38.2,1],[16.2,31,1.1],[15.5,23.4,1]] };
const head: Stroke = { closed: true, width: 2.2, points: [[8.5,6.5,.9],[5,7.5,1.2],[3.6,11,.9],[5,14.5,1.1],[8.5,15.6,.85],[12,14,1.2],[12.6,10.5,.9],[11,7.6,1.1]] };
const body: Stroke = { width: 2.5, points: [[5,19,.85],[2.5,25,1.2],[3.5,35,.9],[11,37.5,1.1]] };
// The hand ends on the page's left edge, holding it.
const arm: Stroke = { width: 2.3, points: [[7.5,21,.8],[14.5,17.3,1.1],[22.9,13.4,.85]] };
// Once the repository is understood: the page is back in the folder, the arm rests on its edge,
// and the two little "got it" lines of the first mark appear beside the head.
const restingArm: Stroke = { width: 2.3, points: [[7.5,21,.8],[14,21.2,1.1],[20.8,20.9,.85]] };
const insight: Stroke[] = [
  { width: 1.8, points: [[14.6,5.2,.7],[16.8,2.4,1.1]] },
  { width: 1.8, points: [[16.4,10.4,.8],[20.2,9.6,1.1]] },
];

const ink = (stroke: Stroke) => penPath(stroke.points, stroke.width, stroke.closed);
const shape = (stroke: Stroke) => smoothPath(stroke.points, true);

/** Filled pen outlines (`ink`) plus the plain shapes that hide what lies behind the page and the folder front. */
export const BRAND_MARK = {
  back: ink(back),
  page: ink(page), pageShape: shape(page), pageLines: pageLines.map(ink), nextPageLines: nextPageLines.map(ink),
  front: ink(front), frontShape: shape(front),
  head: ink(head), body: ink(body), arm: ink(arm), restingArm: ink(restingArm), insight: insight.map(ink),
} as const;
