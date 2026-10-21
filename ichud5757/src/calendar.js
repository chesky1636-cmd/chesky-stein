// Builds the data for the monthly Jewish calendar (shared by pages and the public API).
import { HDate } from '@hebcal/core';
import { monthGrid, holidaysBetween, shiftMonth, monthsOfYear, normalizeMonthForYear, parseIsoDate, yearText, GREG_MONTHS } from './hebrew.js';
import { eventsByHebrewMonth } from './repo/occasions.js';
import { publicOccasion } from './privacy.js';

export async function calendarMonth({ year, month, branch, todayIso, selected }) {
  if (!year || !month) {
    const t = new HDate(parseIsoDate(todayIso));
    year = t.getFullYear(); month = t.getMonth();
  }
  year = Math.min(Math.max(Number(year) || 5787, 5700), 5900);
  month = normalizeMonthForYear(year, Math.min(Math.max(Number(month) || 7, 1), 13));
  const grid = monthGrid(year, month);
  const holidays = holidaysBetween(grid.firstIso, grid.lastIso);
  const rows = await eventsByHebrewMonth(year, month, branch);
  const byDay = {};
  for (const r of rows) (byDay[r.heb_day] ||= []).push(publicOccasion(r, todayIso));
  const weeks = grid.weeks.map((w) => w.map((c) => c && {
    ...c, holidays: holidays[c.iso] || [], events: byDay[c.hDay] || [], isToday: c.iso === todayIso, isSelected: c.iso === selected,
  }));
  const firstG = parseIsoDate(grid.firstIso), lastG = parseIsoDate(grid.lastIso);
  const gregRange = firstG.getMonth() === lastG.getMonth()
    ? `${GREG_MONTHS[firstG.getMonth()]} ${firstG.getFullYear()}`
    : `${GREG_MONTHS[firstG.getMonth()]}${firstG.getFullYear() !== lastG.getFullYear() ? ' ' + firstG.getFullYear() : ''} – ${GREG_MONTHS[lastG.getMonth()]} ${lastG.getFullYear()}`;
  return {
    year, month, name: grid.name, yearText: grid.yearText, leap: grid.leap, gregRange, weeks,
    prev: shiftMonth(year, month, -1), next: shiftMonth(year, month, 1),
    prevYear: { year: year - 1, month: normalizeMonthForYear(year - 1, month) },
    nextYear: { year: year + 1, month: normalizeMonthForYear(year + 1, month) },
    months: monthsOfYear(year),
    years: Array.from({ length: 21 }, (_, i) => year - 10 + i).map((y) => ({ year: y, text: yearText(y) })),
    eventCount: rows.length,
    branch: branch || '',
  };
}
