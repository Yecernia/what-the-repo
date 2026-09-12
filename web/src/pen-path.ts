/** Original pen geometry: a smooth centre line with deliberately varying pressure. */
export type PenPoint = readonly [x: number, y: number, pressure?: number];

function controls(a: PenPoint, b: PenPoint, c: PenPoint, d: PenPoint) {
  // Short corner segments must not inherit a long edge's tangent and grow spikes.
  const span = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const first = Math.min(1 / 6, span / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1) / 3);
  const second = Math.min(1 / 6, span / (Math.hypot(d[0] - b[0], d[1] - b[1]) || 1) / 3);
  return [[b[0] + (c[0] - a[0]) * first, b[1] + (c[1] - a[1]) * first], [c[0] - (d[0] - b[0]) * second, c[1] - (d[1] - b[1]) * second]];
}

export function smoothPath(points: readonly PenPoint[], closed = false): string {
  if (points.length < 2) return '';
  const at = (index: number) => closed ? points[(index + points.length) % points.length] : points[Math.max(0, Math.min(points.length - 1, index))];
  let result = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const [first, second] = controls(a, b, c, d);
    result += `C${first[0]} ${first[1]} ${second[0]} ${second[1]} ${c[0]} ${c[1]}`;
  }
  return result + (closed ? 'Z' : '');
}

/** Filled outlines preserve pen pressure at every scale, without random redraws. */
export function penPath(points: readonly PenPoint[], width = 2, closed = false): string {
  if (points.length < 2) return '';
  const at = (index: number) => closed ? points[(index + points.length) % points.length] : points[Math.max(0, Math.min(points.length - 1, index))];
  const samples: Array<[number, number, number]> = [];
  for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const [first, second] = controls(a, b, c, d);
    const steps = Math.max(6, Math.ceil(Math.hypot(c[0] - b[0], c[1] - b[1]) / 3));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      const axis = (j: 0 | 1) => (1 - t) ** 3 * b[j] + 3 * (1 - t) ** 2 * t * first[j] + 3 * (1 - t) * t ** 2 * second[j] + t ** 3 * c[j];
      const pressure = (b[2] ?? 1) * (1 - t) + (c[2] ?? 1) * t;
      samples.push([axis(0), axis(1), width * pressure / 2]);
    }
  }
  if (!closed) { const last = points[points.length - 1]; samples.push([last[0], last[1], width * (last[2] ?? .85) / 2]); }
  const left: PenPoint[] = [], right: PenPoint[] = [];
  samples.forEach((point, index) => {
    const previous = samples[index === 0 ? (closed ? samples.length - 1 : 0) : index - 1];
    const next = samples[index === samples.length - 1 ? (closed ? 0 : index) : index + 1];
    const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]) || 1;
    const nx = -(next[1] - previous[1]) / length * point[2], ny = (next[0] - previous[0]) / length * point[2];
    left.push([point[0] + nx, point[1] + ny]); right.push([point[0] - nx, point[1] - ny]);
  });
  const polygon = (side: PenPoint[]) => side.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('') + 'Z';
  return closed ? polygon(left) + polygon(right.reverse()) : polygon([...left, ...right.reverse()]);
}
