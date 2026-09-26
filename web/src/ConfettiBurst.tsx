import { useEffect, useRef, useState } from 'react';

/**
 * A party popper going off: from both lower corners a burst of paper squares and curly streamers shoots up across
 * the screen, slows in the air and flutters down to the bottom, and when the last piece is gone the overlay goes. It never takes clicks. Each time
 * `burst` goes up it fires once; nothing happens on the first render.
 */
export function ConfettiBurst({ burst }: { burst: number }) {
  const seen = useRef(burst);
  const [round, setRound] = useState<number | null>(null);
  useEffect(() => {
    if (burst === seen.current) return;
    seen.current = burst;
    setRound(burst);
  }, [burst]);
  if (round === null) return null;
  return <ConfettiCanvas key={round} onDone={() => setRound(current => current === round ? null : current)} />;
}

const COLORS = ['#c8553d', '#d8a23a', '#4f7cac', '#8e5c8a', '#d97a92', '#34506f', '#e08a3c', '#39815a'];
/** A safety limit; normally the burst ends when the last piece has fallen out of sight. */
const MAX_SECONDS = 10;

type Piece = {
  x: number; y: number; vx: number; vy: number; color: string; ribbon: boolean;
  size: number; spin: number; turn: number; flip: number; flipSpeed: number; phase: number; sway: number;
};

function ConfettiCanvas({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Kept in a ref so a re-render of the page does not restart the burst.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const onDone = () => done.current();
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) { onDone(); return; }
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = window.innerWidth, height = window.innerHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    context.scale(ratio, ratio);
    const scale = Math.max(.6, Math.min(1.4, height / 800));
    const gravity = 1500 * scale;
    const random = (from: number, to: number) => from + Math.random() * (to - from);
    const count = width < 600 ? 55 : 85;
    const pieces: Piece[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < count; i++) {
        // Aimed up and in, tilted 14-44 degrees from upright toward the middle: most pieces peak in the upper
        // quarter of the screen and each burst reaches past the middle, so the two cross and fill it.
        const tilt = random(14, 44) * Math.PI / 180;
        const speed = random(1600, 2600) * scale;
        pieces.push({
          x: side < 0 ? random(-10, 30) : width - random(-10, 30), y: height + random(0, 20),
          vx: Math.sin(tilt) * speed * -side, vy: -Math.cos(tilt) * speed,
          color: COLORS[Math.floor(Math.random() * COLORS.length)]!, ribbon: Math.random() < .3,
          size: random(6, 11) * scale, spin: random(-6, 6), turn: random(0, Math.PI * 2),
          flip: random(0, Math.PI * 2), flipSpeed: random(6, 14), phase: random(0, Math.PI * 2), sway: random(18, 46) * scale,
        });
      }
    }
    let frame = 0, last = performance.now(), elapsed = 0;
    const draw = (now: number) => {
      const dt = Math.min(.05, (now - last) / 1000);
      last = now; elapsed += dt;
      context.clearRect(0, 0, width, height);
      let inSight = false;
      for (const piece of pieces) {
        // Air slows the pieces fast; once falling they drift and sway like paper instead of dropping.
        const drag = piece.ribbon ? 2.1 : 1.7;
        piece.vx *= Math.exp(-drag * dt);
        piece.vy = piece.vy * Math.exp(-drag * dt) + gravity * .45 * dt;
        piece.vy = Math.min(piece.vy, (piece.ribbon ? 150 : 190) * scale);
        piece.x += (piece.vx + Math.sin(elapsed * 3 + piece.phase) * (piece.vy > 0 ? piece.sway : 0)) * dt;
        piece.y += piece.vy * dt;
        piece.turn += piece.spin * dt;
        piece.flip += piece.flipSpeed * dt;
        // Pieces stay until they have fallen below the bottom edge.
        if (piece.y > height + piece.size * 3 && piece.vy > 0) continue;
        inSight = true;
        context.save();
        context.translate(piece.x, piece.y);
        context.rotate(piece.turn);
        context.fillStyle = piece.color;
        context.strokeStyle = piece.color;
        if (piece.ribbon) {
          // A curly streamer: a short wavy strip whose curls roll along it.
          context.lineWidth = 2.6 * scale;
          context.lineCap = 'round';
          context.beginPath();
          const length = piece.size * 4;
          for (let k = 0; k <= 10; k++) {
            const along = (k / 10 - .5) * length;
            const across = Math.sin(k * .9 + piece.flip) * piece.size * .5;
            if (k === 0) context.moveTo(along, across); else context.lineTo(along, across);
          }
          context.stroke();
        } else {
          // A paper square tumbling over: its apparent height follows the flip.
          context.scale(1, Math.cos(piece.flip));
          context.fillRect(-piece.size / 2, -piece.size * .35, piece.size, piece.size * .7);
        }
        context.restore();
      }
      if (inSight && elapsed < MAX_SECONDS) frame = requestAnimationFrame(draw);
      else onDone();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={ref} className="confetti-burst" aria-hidden="true" />;
}
