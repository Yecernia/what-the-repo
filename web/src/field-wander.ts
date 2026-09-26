/**
 * The festival animals wander at random: each move is one short Web Animation, chosen when the last one ends, and
 * between moves only a timer waits. An aborted signal stops whatever is running.
 */
export type Point = [number, number];

export const between = (low: number, high: number) => low + Math.random() * (high - low);

/** How long an animal stays put before going somewhere else: usually a good while, only now and then briefly. */
export const stayFor = () => Math.random() < .15 ? between(3000, 7000) : between(10_000, 28_000);

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** Stays for `ms`, doing some little thing (`act`) every few seconds meanwhile. */
export async function linger(ms: number, signal: AbortSignal, act: () => Promise<void>) {
  const end = performance.now() + ms;
  for (;;) {
    const left = end - performance.now(), wait = between(1500, 4500);
    if (wait >= left) { await pause(Math.max(left, 0), signal); return; }
    await pause(wait, signal);
    await act();
  }
}

/** Plays transform keyframes and leaves the element at the last one. */
export async function play(element: SVGElement, keyframes: Keyframe[], duration: number, signal: AbortSignal, easing = 'linear') {
  if (signal.aborted) throw signal.reason;
  const animation = element.animate(keyframes, { duration, easing, fill: 'forwards' });
  const stop = () => animation.cancel();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await animation.finished;
  } finally {
    signal.removeEventListener('abort', stop);
  }
  element.style.transform = String(keyframes[keyframes.length - 1].transform ?? '');
  animation.cancel();
}

const easeInOut = (t: number) => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

/**
 * Translations along a jump or a flight from one point to another, rising `lift` above the straight line at the
 * middle. A jump keeps an even pace across (the height then follows a true parabola in time); a flight eases off and
 * lands gently.
 */
export function arc(from: Point, to: Point, lift: number, gentle = false, steps = 14): Keyframe[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = gentle ? easeInOut(i / steps) : i / steps;
    const x = from[0] + (to[0] - from[0]) * t, y = from[1] + (to[1] - from[1]) * t - 4 * lift * t * (1 - t);
    return { transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` };
  });
}
