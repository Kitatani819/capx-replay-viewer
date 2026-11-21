/** Local calendar dates shared by the evaluation and trial lists. */
export type Period = 'all' | 'today' | '3d' | '7d' | 'custom';
export type DateFilter = { period: Period; from: string; to: string };
type Timestamp = string | number | null | undefined;

/** Keep real person, task and run values distinct from the filter defaults. */
export function listOptionValue(value: string): string {
  return value === 'all' || value === 'mine' || value.startsWith('value:') ? `value:${value}` : value;
}

function dateOf(value: Timestamp): Date {
  if (value === null || value === undefined || value === '') return new Date(NaN);
  return new Date(typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : value);
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === value;
}

export function dateKey(value: Timestamp): string {
  const date = dateOf(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dateHeading(value: Timestamp): string {
  const date = dateOf(value);
  if (!Number.isFinite(date.getTime())) return '日付不明';
  return `${date.getMonth() + 1}月${date.getDate()}日（${'日月火水木金土'[date.getDay()]}）`;
}

export function matchesPeriod(value: Timestamp, filter: DateFilter, now: number): boolean {
  if (filter.period === 'all') return true;
  const time = dateOf(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (filter.period === 'custom') {
    const from = validDate(filter.from) ? new Date(`${filter.from}T00:00:00`).getTime() : -Infinity;
    const end = validDate(filter.to) ? new Date(`${filter.to}T00:00:00`) : null;
    if (end) end.setDate(end.getDate() + 1);
    return time >= from && time < (end?.getTime() ?? Infinity);
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  start.setDate(start.getDate() - (filter.period === '7d' ? 6 : filter.period === '3d' ? 2 : 0));
  return time >= start.getTime() && time < end.getTime();
}
