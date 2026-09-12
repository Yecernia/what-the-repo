import { describe, expect, it } from 'vitest';
import { isPhoneDevice } from './usePhoneDevice';
const base = { userAgent: '', touchPoints: 5, screenWidth: 390, screenHeight: 844, coarsePointer: true };
describe('phone interaction policy', () => {
  it.each([
    ['iPhone portrait', { userAgent: 'iPhone Mobile Safari' }, true],
    ['iPhone landscape', { userAgent: 'iPhone Mobile Safari', screenWidth: 844, screenHeight: 390 }, true],
    ['Android phone', { userAgent: 'Android 14 Mobile Chrome' }, true],
    ['Android tablet', { userAgent: 'Android 14 Chrome', screenWidth: 800, screenHeight: 1280 }, false],
    ['iPad desktop identity', { userAgent: 'Macintosh Safari', screenWidth: 1024, screenHeight: 768 }, false],
    ['narrow desktop window', { userAgent: 'Windows Chrome', touchPoints: 0, coarsePointer: false }, false],
    ['large touch device', { userAgent: 'Windows Chrome', screenWidth: 1280, screenHeight: 800 }, false],
  ] as const)('%s', (_label, changes, expected) => {
    expect(isPhoneDevice({ ...base, ...changes })).toBe(expected);
  });
});
