import { useEffect, useRef } from 'react';
import rough from 'roughjs/bin/rough';

type SketchDoodleVariant = 'spark' | 'orbit' | 'underline' | 'wave' | 'circle';

const VIEW_BOXES: Record<SketchDoodleVariant, string> = {
  spark: '0 0 52 52',
  orbit: '0 0 150 92',
  underline: '0 0 160 24',
  wave: '0 0 84 28',
  circle: '0 0 132 44',
};

export function SketchDoodle({
  variant,
  className = '',
}: {
  variant: SketchDoodleVariant;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    const sketch = rough.svg(svg);
    const options = {
      stroke: 'currentColor',
      strokeWidth: 1.7,
      roughness: 1.35,
      bowing: 1.15,
      seed: variant.length * 97,
    };

    if (variant === 'spark') {
      [[26, 4, 26, 15], [26, 37, 26, 48], [4, 26, 15, 26], [37, 26, 48, 26],
        [9, 9, 17, 17], [35, 35, 43, 43], [43, 9, 35, 17], [17, 35, 9, 43]]
        .forEach(([x1, y1, x2, y2], index) => {
          svg.appendChild(sketch.line(x1, y1, x2, y2, { ...options, seed: 701 + index }));
        });
      return;
    }

    if (variant === 'orbit') {
      svg.appendChild(sketch.ellipse(75, 46, 132, 68, { ...options, seed: 811 }));
      svg.appendChild(sketch.path('M 22 58 Q 67 5 130 36', { ...options, seed: 812 }));
      return;
    }

    if (variant === 'underline') {
      svg.appendChild(sketch.path('M 5 14 Q 48 7 84 13 T 155 11', { ...options, seed: 907 }));
      return;
    }

    if (variant === 'circle') {
      svg.appendChild(sketch.ellipse(66, 22, 124, 36, {
        ...options,
        strokeWidth: 2,
        roughness: 1.7,
        bowing: 1.4,
        seed: 967,
      }));
      return;
    }

    svg.appendChild(sketch.path('M 3 16 Q 13 5 23 16 T 43 16 T 63 16 T 81 14', {
      ...options,
      seed: 1013,
    }));
  }, [variant]);

  return (
    <svg
      ref={svgRef}
      className={`sketch-doodle ${className}`.trim()}
      viewBox={VIEW_BOXES[variant]}
      aria-hidden="true"
      focusable="false"
    />
  );
}
