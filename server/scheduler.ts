import type { Settings } from '../shared/types.js';
import { BEIJING_TIMEZONE, normalizedDailyTimes } from '../shared/schedule-settings.js';

export function localMinute(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
export function nextScheduledAt(settings: Settings, now = new Date()): string | null {
  if (!settings.schedulerEnabled) return null;
  const times = normalizedDailyTimes(settings);
  const cursor = new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000);
  for (let minute = 0; minute < 60 * 49; minute++) {
    if (times.includes(localMinute(cursor, BEIJING_TIMEZONE).time)) return cursor.toISOString();
    cursor.setTime(cursor.getTime() + 60000);
  }
  return null;
}
