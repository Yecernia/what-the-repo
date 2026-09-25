type SketchDoodleVariant = 'spark' | 'orbit' | 'underline' | 'wave' | 'circle';

const VIEW_BOXES: Record<SketchDoodleVariant, string> = {
  spark: '0 0 52 52',
  orbit: '0 0 150 92',
  underline: '0 0 160 24',
  wave: '0 0 84 28',
  circle: '0 0 132 44',
};

// Each doodle is one confident pen stroke: a flick at the end of an underline,
// a ring that overshoots where it started, never a scribbled double line.
const PATHS: Record<SketchDoodleVariant, string[]> = {
  spark: ['M26 5 L26.5 15', 'M40 12 L34.5 19', 'M47 27 L37 27.5', 'M12 12 L18 18.5', 'M6 28 L15 27.5'],
  orbit: ['M118 22 C88 4 22 12 12 44 C4 72 70 86 116 72 C146 62 146 34 120 24 C104 18 86 18 70 21'],
  underline: ['M5 15 C40 9.5 88 10 126 12.5 C140 13.5 149 12.5 155 8.5'],
  wave: ['M3 17 C9 8 15 7 20 14.5 C25 22 31 23.5 36 15.5 C41 8 47 6.5 52 14 C57 21.5 63 22.5 68 15 C72 10 77 9 81 12'],
  circle: ['M108 10 C80 3.5 20 6 8 19 C0 30 28 40 64 40 C100 40 128 33 126 19 C124 7 98 0 68 2'],
};

export function SketchDoodle({
  variant,
  className = '',
}: {
  variant: SketchDoodleVariant;
  className?: string;
}) {
  return (
    <svg
      className={`sketch-doodle ${className}`.trim()}
      viewBox={VIEW_BOXES[variant]}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[variant].map(d => <path key={d} d={d} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
