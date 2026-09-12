import type { SVGProps } from 'react';
import { penPath, type PenPoint } from './pen-path';

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };
type Stroke = { points: PenPoint[]; closed?: boolean; width?: number };
function icon(strokes: Stroke[], markerClass = '') {
  const paths = strokes.map(s => penPath(s.points, s.width ?? 2.15, s.closed));
  return function ({ size = 24, className = '', ...props }: IconProps) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props} className={`hand-icon ${markerClass} ${className}`}>
      {paths.map((d, index) => <path key={index} d={d} fillRule="evenodd" />)}
    </svg>;
  };
}

// A waving, faceless little reader. It belongs to the same family as the large scene.
export const UserRound = icon([
  { points: [[10.2,2.9,.8],[6.9,3.8,1.1],[6.2,6.8,1.15],[8.8,9.1,.9],[12,8.8,1.1],[13.2,6.1,.85],[12.4,3.6,1.2]], closed: true },
  { points: [[7.3,10.2,.85],[4.6,12.6,1.1],[4.1,17.2,1.2],[5.4,21,1],[15.8,20.8,.9],[16,17.2,1.1],[14.3,11.3,1.25],[17.3,11.5,1],[19.6,9.7,.8],[19.7,6.4,1]], width: 2.05 },
  { points: [[17.3,3.1,.75],[17.9,4.5,1]], width: 1.4 },
  { points: [[21.6,4.4,1],[20.8,5,.65]], width: 1.4 },
]);
export const Plus = icon([
  { points: [[11.4,3.1,.7],[11.2,8.2,1.2],[12,13.6,1.05],[11.9,20.4,.75]], width: 2.7 },
  { points: [[3.3,12.8,.8],[8.5,12.2,1.1],[15.1,12.3,1.22],[21,11.3,.75]], width: 2.6 },
]);
export const Settings = icon([
  { points: [[10.1,2.1,.9],[13,2,1.1],[14.6,5,.85],[18.1,4.9,1],[20.4,8,1.2],[19,11.1,.9],[21.2,14.1,1.1],[19.5,17.7,.85],[16.1,18.2,1.2],[14.8,21.1,.95],[10.6,21.8,1],[8.5,18.9,1.2],[5.1,19.1,.85],[2.9,15.9,1.1],[4.1,12.2,.9],[2.9,9.2,1.1],[4.6,5.9,1.2],[8.3,5.5,.8]], closed: true, width: 1.85 },
  { points: [[11.4,8.1,1],[8.1,9.5,.8],[7.9,13.1,1.1],[10.7,15.8,1.1],[14.7,14.7,.8],[15.8,11.2,1.15],[13.3,8.4,.9]], closed: true, width: 1.9 },
]);
export const Send = icon([
  { points: [[2.4,9.8,.7],[8.6,7.8,1.15],[14.6,5.2,.85],[21.3,2.4,1.1],[19.9,9.7,.75],[17.8,16.8,1.2],[15.8,21.2,.85],[13.2,17.3,1.1],[10.8,13.4,.8],[6.4,11.6,1.15],[2.4,9.8,.65]], width: 1.55 },
  { points: [[10.8,13.4,.7],[14.9,9.7,1.2],[20.1,3.9,.6]], width: 1.45 },
  { points: [[10.8,13.6,.85],[10.4,18.4,1.1],[13,16.9,.6]], width: 1.2 },
]);
export const X = icon([
  { points: [[5,4.9,.7],[10.1,10.8,1.15],[18.9,19.4,.8]], width: 2.25 },
  { points: [[18.1,4.3,.8],[11.7,11.6,1.25],[4.9,18.6,.7]], width: 2.25 },
], 'hand-close-icon');
export const Sun = icon([
  { points: [[11,6.6,.9],[7.5,8.2,1.1],[6.9,12,1.2],[9,15.8,.85],[13.6,16.8,1],[16.8,13.6,1.1],[16.4,9.3,.9],[13.7,6.6,1.1]], closed: true, width: 2 },
  ...[[[11.2,1],[11.6,3.3]],[[20.8,3.3],[18.9,5.4]],[[20.5,11],[23,10.7]],[[18.2,18.4],[20.3,20.4]],[[11.9,20],[12.4,23]],[[3.5,20.5],[5.7,18.5]],[[1,12.4],[3.3,12]],[[3.5,3.7],[5.3,5.6]]].map(points => ({points: points.map(([x, y]): PenPoint => [x, y]), width:1.6})),
]);
export const Moon = icon([
  { points: [[14.9,2.4,.75],[8.2,3.7,1.1],[3.8,8.4,1.25],[3.3,14,1],[7.1,19.4,1.2],[13.3,21.1,.8],[18.8,18.3,1.15],[21.3,13.7,.7],[15.9,15.2,1.1],[11.6,12.3,1.15],[11,6.8,.9],[14.9,2.4,.75]], width: 2 },
]);
export const LogOut = icon([
  { points: [[12,3.7,.8],[5.4,3.1,1.1],[4,6.8,.9],[4.5,19.7,1.2],[11.4,20,.8]], width: 2 },
  { points: [[10.4,12.3,.7],[16.1,11.8,1.2],[21.3,12.1,.9]], width: 2.3 },
  { points: [[17.2,7.1,.75],[21.6,12.1,1.15],[17,17.1,.7]], width: 2.1 },
]);
export const ChevronDown = icon([{ points: [[5,8.6,.8],[11.6,15,1.2],[18.8,8.1,.8]], width:2 }]);
export const ChevronRight = icon([{ points: [[8.5,4.9,.8],[15.1,11.9,1.15],[8.1,19.1,.8]], width:2 }]);
export const ChevronLeft = icon([{ points: [[15.6,4.8,.8],[8.8,12,1.15],[15.8,19.1,.8]], width:2 }]);
