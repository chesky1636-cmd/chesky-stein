// Jewish calendar helpers built on @hebcal/core (handles leap years, month lengths and sunset).
import { HDate, HebrewCalendar, Zmanim, Location, gematriya, flags } from '@hebcal/core';
import { config } from './config.js';

export const MONTH_NAMES = {
  1: 'ניסן', 2: 'אייר', 3: 'סיון', 4: 'תמוז', 5: 'אב', 6: 'אלול', 7: 'תשרי',
  8: 'חשון', 9: 'כסלו', 10: 'טבת', 11: 'שבט', 12: 'אדר', 13: 'אדר ב׳',
};

export const GREG_MONTHS = ['יאנואר', 'פעברואר', 'מערץ', 'אפריל', 'מיי', 'יוני', 'יולי', 'אויגוסט', 'סעפטעמבער', 'אקטאבער', 'נאוועמבער', 'דעצעמבער'];
export const WEEKDAYS = ['זונטאג', 'מאנטאג', 'דינסטאג', 'מיטוואך', 'דאנערשטאג', 'פרייטאג', 'שבת קודש'];
export const WEEKDAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש״ק'];

export function monthName(month, year) {
  if (month === 12 && HDate.isLeapYear(year)) return 'אדר א׳';
  return MONTH_NAMES[month];
}

export function gem(n) {
  return gematriya(n);
}

// Hebrew year in gematria without the thousands (תשפ״ז).
export function yearText(y) {
  return gematriya(y % 1000);
}

export function dayText(d) {
  return gematriya(d);
}

// Parse 'YYYY-MM-DD' to a local Date at noon (avoids DST/timezone edge problems).
export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

export function toIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Hebrew date for a civil date; afterSunset moves to the next Hebrew day.
export function hebrewFromIso(iso, afterSunset = false) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  let hd = new HDate(d);
  if (afterSunset) hd = hd.next();
  return describeHDate(hd);
}

export function describeHDate(hd) {
  const y = hd.getFullYear(), m = hd.getMonth(), day = hd.getDate();
  return {
    year: y, month: m, day,
    text: `${dayText(day)} ${monthName(m, y)} ${yearText(y)}`,
    shortText: `${dayText(day)} ${monthName(m, y)}`,
  };
}

// Convert a Hebrew date to the civil (Gregorian) date on which its daytime falls.
export function isoFromHebrew(year, month, day) {
  if (!HDate.isLeapYear(year) && month === 13) return null;
  if (day < 1 || day > HDate.daysInMonth(month, year)) return null;
  return toIso(new HDate(day, month, year).greg());
}

export function gregText(iso) {
  const d = parseIsoDate(iso);
  if (!d) return '';
  return `${d.getDate()} ${GREG_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function weekdayName(iso) {
  const d = parseIsoDate(iso);
  return d ? WEEKDAYS[d.getDay()] : '';
}

// Current civil date and time in the school's timezone.
export function nowInSchoolTz(at = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.location.tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(at); // YYYY-MM-DD
}

const location = () => new Location(config.location.latitude, config.location.longitude, false, config.location.tz);

export function sunsetFor(iso) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  try {
    const t = new Zmanim(location(), d, false).sunset();
    return Number.isNaN(t?.getTime?.()) ? null : t;
  } catch {
    return null;
  }
}

// Is the instant `at` after sunset on its civil day (in the school's location)?
export function isAfterSunset(at = new Date()) {
  const iso = nowInSchoolTz(at);
  const ss = sunsetFor(iso);
  return ss ? at.getTime() >= ss.getTime() : false;
}

export function today(at = new Date()) {
  const iso = nowInSchoolTz(at);
  const after = isAfterSunset(at);
  return { iso, afterSunset: after, hebrew: hebrewFromIso(iso, after), greg: gregText(iso), weekday: weekdayName(iso) };
}

// Ordered months of a Hebrew year (starting from Tishrei).
export function monthsOfYear(year) {
  const leap = HDate.isLeapYear(year);
  const list = [7, 8, 9, 10, 11, 12];
  if (leap) list.push(13);
  list.push(1, 2, 3, 4, 5, 6);
  return list.map((m) => ({ month: m, name: monthName(m, year) }));
}

export function shiftMonth(year, month, delta) {
  let list = monthsOfYear(year);
  let idx = list.findIndex((x) => x.month === month);
  if (idx < 0) idx = list.findIndex((x) => x.month === 12);
  idx += delta;
  while (idx < 0) { year -= 1; list = monthsOfYear(year); idx += list.length; }
  while (idx >= list.length) { idx -= list.length; year += 1; list = monthsOfYear(year); }
  return { year, month: list[idx].month };
}

export function normalizeMonthForYear(year, month) {
  if (month === 13 && !HDate.isLeapYear(year)) return 12;
  return month;
}

const strip = (s) => s.replace(/[֑-ׇ]/g, '');

// Holidays / special days for a civil range, rendered in Hebrew without niqqud (diaspora schedule).
export function holidaysBetween(startIso, endIso) {
  const events = HebrewCalendar.calendar({
    start: parseIsoDate(startIso), end: parseIsoDate(endIso), il: false,
    noModern: true, noSpecialShabbat: false, noMinorFast: false, shabbatMevarchim: false,
  });
  const out = {};
  for (const ev of events) {
    const f = ev.getFlags();
    if (f & (flags.DAF_YOMI | flags.OMER_COUNT | flags.MOLAD | flags.YOM_KIPPUR_KATAN | flags.MODERN_HOLIDAY)) continue;
    const iso = toIso(ev.getDate().greg());
    (out[iso] ||= []).push(strip(ev.render('he-x-NoNikud') || ev.render('he')));
  }
  return out;
}

// Build a month grid (weeks of 7 days, Sunday-first) for a Hebrew month.
export function monthGrid(year, month) {
  month = normalizeMonthForYear(year, month);
  const days = HDate.daysInMonth(month, year);
  const first = new HDate(1, month, year);
  const startDow = first.getDay();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    const hd = new HDate(d, month, year);
    const g = hd.greg();
    cells.push({
      iso: toIso(g), hDay: d, hDayText: dayText(d), gDay: g.getDate(), gMonth: g.getMonth() + 1,
      gMonthName: GREG_MONTHS[g.getMonth()], gYear: g.getFullYear(), dow: hd.getDay(),
    });
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const firstIso = cells.find(Boolean).iso;
  const lastIso = [...cells].reverse().find(Boolean).iso;
  return {
    year, month, name: monthName(month, year), yearText: yearText(year), leap: HDate.isLeapYear(year),
    days, weeks, firstIso, lastIso,
  };
}

// --- Parsing Hebrew dates written in text, e.g. כ"ה תשרי תשפ"ז ---
const LETTERS = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40, נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };

export function fromGematriya(s) {
  const clean = strip(String(s)).replace(/["'״׳`]/g, '');
  if (!clean || /[^א-ת]/.test(clean)) return null;
  let n = 0;
  for (const ch of clean) n += LETTERS[ch] || 0;
  return n || null;
}

const MONTH_PATTERNS = [
  [/^אדר\s*(א|ראשון|1)['׳]?$/, 12, true], [/^אדר\s*(ב|שני|2)['׳]?$/, 13, true],
  [/^תשרי$/, 7], [/^(מר)?חשון$|^(מר)?חשוון$|^חשוואן$/, 8], [/^כסלו$|^כסליו$/, 9], [/^טבת$/, 10], [/^שבט$/, 11],
  [/^אדר$/, 12], [/^ניסן$/, 1], [/^אייר$|^איר$/, 2], [/^סיון$|^סיוון$/, 3], [/^תמוז$/, 4], [/^(מנחם\s*)?אב$/, 5], [/^אלול$/, 6],
];

function matchMonth(word) {
  for (const [re, m] of MONTH_PATTERNS) if (re.test(word)) return m;
  return null;
}

// Returns {year, month, day} or null. Year is optional (defaults to the Hebrew year of `refIso`).
export function parseHebrewDate(text, refIso = nowInSchoolTz()) {
  const t = strip(String(text)).replace(/[״”“]/g, '"').replace(/[׳’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const re = /(?:^|\s)([א-ת]{1,2}["']?[א-ת]?)\s+(?:ל|לחודש\s+)?(אדר\s*(?:א|ב|ראשון|שני)['׳]?|מנחם\s*אב|[א-ת]{2,6})(?:\s+(?:שנת\s+)?(ה?'?[א-ת]{1,3}"[א-ת]|ה?תש[א-ת"']{0,4}))?/g;
  let m;
  while ((m = re.exec(t))) {
    const month = matchMonth(m[2].replace(/\s+/g, ' ').trim()) ?? matchMonth(m[2].replace(/^ל/, ''));
    if (!month) continue;
    const day = fromGematriya(m[1]);
    if (!day || day > 30) continue;
    let year, explicitYear = false;
    if (m[3]) {
      const y = fromGematriya(m[3].replace(/^ה'?/, ''));
      if (y) { year = 5000 + y; explicitYear = true; }
    }
    if (!year) {
      const ref = new HDate(parseIsoDate(refIso));
      year = ref.getFullYear();
    }
    const mm = normalizeMonthForYear(year, month);
    if (day > HDate.daysInMonth(mm, year)) continue;
    return { year, month: mm, day, explicitYear };
  }
  return null;
}

// Parse a civil date written as dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy or yyyy-mm-dd.
export function parseGregDate(text) {
  const s = String(text || '');
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
  if (m) return validIso(+m[3], +m[2], +m[1]);
  return null;
}

function validIso(y, mo, d) {
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return parseIsoDate(iso) ? iso : null;
}
