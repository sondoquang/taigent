// Calendar days (`YYYY-MM-DD`) in the local time zone (TZ), the unit of due dates, reporting periods and weeks.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local midnight of a YYYY-MM-DD day, or undefined when `value` is no such calendar day. */
export function parseDay(value: string): Date | undefined {
  const match = DAY.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : undefined;
}

/** `YYYY-MM-DD` of an instant in the local time zone. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD HH:mm` of an instant (ISO 8601) in the local time zone. */
export function localMinute(iso: string): string {
  const date = new Date(iso);
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day `days` after the calendar day `day` (before it when negative). */
export function addDays(day: string, days: number): string {
  const date = parseDay(day)!;
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

/** Calendar days from `from` to `to` (negative when `to` is earlier); daylight saving changes do not count. */
export function daysBetween(from: string, to: string): number {
  const utc = (day: string) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** The Monday of the week (Monday to Sunday) holding the calendar day `day`. */
export function mondayOf(day: string): string {
  return addDays(day, -((parseDay(day)!.getDay() + 6) % 7));
}
