import type { CollectionRequest, DateRange } from '../shared/types.js';
import { localMinute } from './scheduler.js';

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Freeze the inclusive range at enqueue time, including across midnight. */
export function resolveDateRange(request: CollectionRequest, timezone: string, now = new Date()): DateRange {
  const today = localMinute(now, timezone).day;
  const startDate = request.startDate ?? request.endDate ?? today;
  const endDate = request.endDate ?? request.startDate ?? today;
  if (!validDate(startDate) || !validDate(endDate)) throw new Error('日期必须是有效的 YYYY-MM-DD 日期');
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期');
  return { startDate, endDate, timezone };
}

/** Read the site's update date, never infer it from the collection time. */
export function sourceDate(value: unknown, timezone = 'Asia/Shanghai'): string | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10}(?:\d{3})?$/.test(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isFinite(date.getTime()) ? localMinute(date, timezone).day : undefined;
  }
  if (typeof value !== 'string') return undefined;
  // ISO values carrying an offset represent an instant; bare site dates are local calendar dates.
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    const timestamp = value.trim();
    if (!validDate(timestamp.slice(0, 10))) return undefined;
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? localMinute(date, timezone).day : undefined;
  }
  const match = value.match(/(?:^|\D)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/);
  if (!match) return undefined;
  const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return validDate(day) ? day : undefined;
}
