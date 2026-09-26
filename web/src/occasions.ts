/**
 * Small seasonal touches for the illustrations, worked out from the viewer's own clock like the moon: no request,
 * just the local date. Everything comes from one small piece of astronomy: the solar terms (立春, 清明, 冬至...)
 * from where the sun stands, and the Chinese calendar from the new moons and the principal terms, reckoned on
 * China's calendar days as the official calendar is. (Browsers carry a Chinese calendar too, but without the solar
 * terms, and theirs puts the 2027 New Year a day late.)
 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Occasion =
  | 'new-year' | 'spring-festival' | 'lantern-festival' | 'valentine' | 'april-fools' | 'qingming' | 'easter' | 'dragon-boat' | 'qixi'
  | 'mid-autumn' | 'halloween' | 'winter-solstice' | 'christmas';

const DAY = 86_400_000;
const CHINA_OFFSET = 8 * 3_600_000;
const SYNODIC = 29.530588861;

/**
 * The instant of new moon number `k` (0 is the one of 6 January 2000), from Meeus' "Astronomical Algorithms",
 * chapter 49, with all its periodic terms: good to well under a minute.
 */
export function newMoon(k: number): number {
  const t = k / 1236.85, rad = Math.PI / 180;
  const jde = 2451550.09766 + SYNODIC * k + .00015437 * t ** 2 - .00000015 * t ** 3 + .00000000073 * t ** 4;
  const e = 1 - .002516 * t - .0000074 * t ** 2;
  const m = (2.5534 + 29.1053567 * k - .0000014 * t ** 2 - .00000011 * t ** 3) * rad;
  const mm = (201.5643 + 385.81693528 * k + .0107582 * t ** 2 + .00001238 * t ** 3 - .000000058 * t ** 4) * rad;
  const f = (160.7108 + 390.67050284 * k - .0016118 * t ** 2 - .00000227 * t ** 3 + .000000011 * t ** 4) * rad;
  const omega = (124.7746 - 1.56375588 * k + .0020672 * t ** 2 + .00000215 * t ** 3) * rad;
  const s = Math.sin;
  let correction = -.4072 * s(mm) + .17241 * e * s(m) + .01608 * s(2 * mm) + .01039 * s(2 * f) + .00739 * e * s(mm - m)
    - .00514 * e * s(mm + m) + .00208 * e * e * s(2 * m) - .00111 * s(mm - 2 * f) - .00057 * s(mm + 2 * f)
    + .00056 * e * s(2 * mm + m) - .00042 * s(3 * mm) + .00042 * e * s(m + 2 * f) + .00038 * e * s(m - 2 * f)
    - .00024 * e * s(2 * mm - m) - .00017 * s(omega) - .00007 * s(mm + 2 * m) + .00004 * s(2 * mm - 2 * f)
    + .00004 * s(3 * m) + .00003 * s(mm + m - 2 * f) + .00003 * s(2 * mm + 2 * f) - .00003 * s(mm + m + 2 * f)
    + .00003 * s(mm - m + 2 * f) - .00002 * s(mm - m - 2 * f) - .00002 * s(3 * mm + m) + .00002 * s(4 * mm);
  const planets: Array<[number, number, number]> = [
    [.000325, 299.77, .107408], [.000165, 251.88, .016321], [.000164, 251.83, 26.651886], [.000126, 349.42, 36.412478],
    [.00011, 84.66, 18.206239], [.000062, 141.74, 53.303771], [.00006, 207.14, 2.453732], [.000056, 154.84, 7.30686],
    [.000047, 34.52, 27.261239], [.000042, 207.19, .121824], [.00004, 291.34, 1.844379], [.000037, 161.72, 24.198154],
    [.000035, 239.56, 25.513099], [.000023, 331.55, 3.592518],
  ];
  for (const [amount, base, rate] of planets) correction += amount * s((base + rate * k - (base === 299.77 ? .009173 * t * t : 0)) * rad);
  // Terrestrial time runs about 69 s ahead of the clock in these years.
  return (jde + correction - 2440587.5) * DAY - 69_000;
}

/** The sun's apparent ecliptic longitude in degrees (a short formula from Meeus, good to a few minutes of time). */
export function sunLongitude(at: Date): number {
  const t = (at.getTime() / DAY + 2440587.5 - 2451545) / 36525;
  const rad = Math.PI / 180;
  const l0 = 280.46646 + 36000.76983 * t + .0003032 * t * t;
  const m = (357.52911 + 35999.05029 * t - .0001537 * t * t) * rad;
  const c = (1.914602 - .004817 * t - .000014 * t * t) * Math.sin(m) + (.019993 - .000101 * t) * Math.sin(2 * m)
    + .000289 * Math.sin(3 * m);
  const omega = (125.04 - 1934.136 * t) * rad;
  return (((l0 + c - .00569 - .00478 * Math.sin(omega)) % 360) + 360) % 360;
}

/** 立春 is at 315°, 立夏 45°, 立秋 135°, 立冬 225°; each season lasts until the next of them. */
export function seasonOf(at: Date): Season {
  const shifted = (sunLongitude(at) + 45) % 360;
  return shifted < 90 ? 'spring' : shifted < 180 ? 'summer' : shifted < 270 ? 'autumn' : 'winter';
}

/** A local calendar date as a day number, taken as the same date in China, where the official calendar is kept. */
function dayNumber(at: Date): number {
  return Math.round(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY);
}
/** The China calendar day an instant falls on. */
function chinaDay(time: number): number {
  return Math.floor((time + CHINA_OFFSET) / DAY);
}
/** The first sun longitude that is a multiple of `step` reached between two instants, if any. */
function termBetween(from: number, to: number, step: number, only?: number): number | null {
  const start = sunLongitude(new Date(from)), end = sunLongitude(new Date(to));
  const next = (Math.floor(start / step) + 1) * step % 360;
  if ((next - start + 360) % 360 > (end - start + 360) % 360) return null;
  return only === undefined || next === only ? next : null;
}
const midnight = (day: number) => day * DAY - CHINA_OFFSET;

/** Whether the sun reaches `longitude` on this (China) calendar day: the day of that solar term. */
function solarTermToday(at: Date, longitude: number): boolean {
  const day = dayNumber(at);
  return termBetween(midnight(day), midnight(day + 1), 15, longitude) !== null;
}

/** The (China) calendar day the lunar month starting at new moon `k` begins. */
const monthStart = (k: number) => chinaDay(newMoon(k));
/** The principal term (a multiple of 30° of the sun) falling in lunar month `k`, or null if none does. */
const principalTerm = (k: number) => termBetween(midnight(monthStart(k)), midnight(monthStart(k + 1)), 30);
/** Whether lunar month `k` holds 冬至 (270°), which is always in the eleventh month. */
const holdsSolstice = (k: number) => termBetween(midnight(monthStart(k)), midnight(monthStart(k + 1)), 90, 270) !== null
  || principalTerm(k) === 270;

/**
 * Month and day in the Chinese calendar, or null in a leap month. A month runs from the day of one new moon to the
 * day before the next. The month holding 冬至 is the eleventh; when thirteen months lie between one such month and
 * the next, the first of them without a principal term is the leap month, and the others are numbered in turn.
 */
let lunarCache: { day: number; value: { month: number; day: number } | null } | null = null;
export function lunarDate(at: Date): { month: number; day: number } | null {
  const day = dayNumber(at);
  if (lunarCache?.day === day) return lunarCache.value;
  const value = reckonLunarDate(day);
  lunarCache = { day, value };
  return value;
}

function reckonLunarDate(day: number): { month: number; day: number } | null {
  let k = Math.floor((midnight(day) - newMoon(0)) / (SYNODIC * DAY));
  while (monthStart(k + 1) <= day) k++;
  while (monthStart(k) > day) k--;
  let eleventh = k;
  while (!holdsSolstice(eleventh)) eleventh--;
  let nextEleventh = eleventh + 11;
  while (!holdsSolstice(nextEleventh)) nextEleventh++;
  let leap: number | null = null;
  if (nextEleventh - eleventh === 13) {
    for (let month = eleventh + 1; month < nextEleventh && leap === null; month++) if (principalTerm(month) === null) leap = month;
  }
  if (k === leap) return null;
  const steps = k - eleventh - (leap !== null && k > leap ? 1 : 0);
  return { month: (10 + steps) % 12 + 1, day: day - monthStart(k) + 1 };
}

/** Easter Sunday of a year (the anonymous Gregorian computus), as month (1-12) and day. */
export function easterOf(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}

/** The festival being celebrated on this day, if any. The Spring Festival runs from its eve up to the Lantern Festival. */
export function occasionOf(at: Date): Occasion | null {
  const month = at.getMonth() + 1, day = at.getDate();
  const lunar = lunarDate(at);
  const tomorrow = lunarDate(new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1));
  if (lunar?.month === 1 && lunar.day === 15) return 'lantern-festival';
  if ((lunar?.month === 1 && lunar.day < 15) || (tomorrow?.month === 1 && tomorrow.day === 1)) return 'spring-festival';
  if (lunar?.month === 8 && lunar.day >= 14 && lunar.day <= 16) return 'mid-autumn';
  if (lunar?.month === 5 && lunar.day === 5) return 'dragon-boat';
  if (lunar?.month === 7 && lunar.day === 7) return 'qixi';
  if ((month === 12 && day === 31) || (month === 1 && day === 1)) return 'new-year';
  if (month === 2 && day === 14) return 'valentine';
  if (month === 4 && day === 1) return 'april-fools';
  if (solarTermToday(at, 15)) return 'qingming';
  const [easterMonth, easterDay] = easterOf(at.getFullYear());
  if (month === easterMonth && day === easterDay) return 'easter';
  if (month === 10 && (day === 30 || day === 31)) return 'halloween';
  if (solarTermToday(at, 270)) return 'winter-solstice';
  if (month === 12 && day >= 24 && day <= 26) return 'christmas';
  return null;
}
