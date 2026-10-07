import { describe, expect, it } from 'vitest';
import { easterOf, lunarDate, occasionOf, phaseOf, seasonOf } from './occasions';

const on = (date: string, time = '12:00') => new Date(`${date}T${time}:00`);

describe('occasions', () => {
  it('turns the seasons on 立春, 立夏, 立秋 and 立冬', () => {
    expect(seasonOf(on('2026-02-03'))).toBe('winter');
    expect(seasonOf(on('2026-02-05'))).toBe('spring');
    expect(seasonOf(on('2026-05-04'))).toBe('spring');
    expect(seasonOf(on('2026-05-06'))).toBe('summer');
    expect(seasonOf(on('2026-08-06'))).toBe('summer');
    expect(seasonOf(on('2026-08-08'))).toBe('autumn');
    expect(seasonOf(on('2026-11-06'))).toBe('autumn');
    expect(seasonOf(on('2026-11-08'))).toBe('winter');
  });

  it('keeps the Chinese calendar from the new moons and principal terms', () => {
    expect(lunarDate(on('2026-02-17'))).toEqual({ month: 1, day: 1 });
    expect(lunarDate(on('2026-09-25'))).toEqual({ month: 8, day: 15 });
    expect(lunarDate(on('2025-07-26'))).toBeNull(); // 2025's leap sixth month is no festival month
    // Years where the new moon falls close to midnight in China; browsers' built-in calendar gets these wrong.
    expect(lunarDate(on('2027-02-06'))).toEqual({ month: 1, day: 1 });
    expect(lunarDate(on('2030-02-03'))).toEqual({ month: 1, day: 1 });
    expect(lunarDate(on('2018-11-08'))).toEqual({ month: 10, day: 1 });
    // The 2033 problem: the leap month is the one after the eleventh, not the earlier month without a principal term.
    expect(lunarDate(on('2033-08-25'))).toEqual({ month: 8, day: 1 });
    expect(lunarDate(on('2033-12-25'))).toBeNull();
    expect(lunarDate(on('2034-02-19'))).toEqual({ month: 1, day: 1 });
  });

  it('finds Chinese and Western festivals on their local dates', () => {
    expect(occasionOf(on('2026-02-16'))).toBe('spring-festival'); // eve
    expect(occasionOf(on('2026-03-02'))).toBe('spring-festival');
    expect(occasionOf(on('2026-03-03'))).toBe('lantern-festival');
    expect(occasionOf(on('2026-03-04'))).toBeNull();
    expect(occasionOf(on('2026-09-25'))).toBe('mid-autumn');
    expect(occasionOf(on('2026-06-19'))).toBe('dragon-boat');
    expect(occasionOf(on('2026-08-19'))).toBe('qixi');
    expect(occasionOf(on('2027-04-05'))).toBe('qingming');
    expect(occasionOf(on('2027-03-28'))).toBe('easter');
    expect(occasionOf(on('2026-04-01'))).toBe('april-fools');
    expect(occasionOf(on('2026-02-14'))).toBe('valentine');
    expect(occasionOf(on('2026-10-31'))).toBe('halloween');
    expect(occasionOf(on('2026-12-22'))).toBe('winter-solstice');
    expect(occasionOf(on('2026-12-25'))).toBe('christmas');
    expect(occasionOf(on('2026-12-31'))).toBe('new-year');
    expect(occasionOf(on('2026-11-15'))).toBeNull();
  });

  it('lets the Spring Festival win when another day falls inside it', () => {
    expect(occasionOf(on('2027-02-05'))).toBe('spring-festival'); // New Year's Eve 2027
    expect(occasionOf(on('2027-02-14'))).toBe('spring-festival');
  });

  it('computes Easter', () => {
    expect([2026, 2027, 2028].map(easterOf)).toEqual([[4, 5], [3, 28], [4, 16]]);
  });

  it('reads the time of day from the local clock', () => {
    const at = (time: string) => phaseOf(on('2026-10-06', time));
    expect([at('04:59'), at('05:00'), at('09:59'), at('10:00'), at('15:59'), at('16:00'), at('18:59'), at('19:00'), at('00:00')])
      .toEqual(['night', 'morning', 'morning', 'day', 'day', 'dusk', 'dusk', 'night', 'night']);
  });
});
