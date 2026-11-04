export const BEIJING_TIMEZONE = 'Asia/Shanghai';
export const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_DAILY_TIME = '03:00';
export const MAX_DAILY_TIMES = 24;

/** Normalize persisted schedules while retaining installations with only dailyTime. */
export function normalizedDailyTimes(settings: { dailyTimes?: string[]; dailyTime?: string }): string[] {
  const saved = Array.isArray(settings.dailyTimes)
    ? settings.dailyTimes.filter(value => typeof value === 'string' && value.length === 5 && DAILY_TIME_PATTERN.test(value)) : [];
  const fallback = typeof settings.dailyTime === 'string' && settings.dailyTime.length === 5 && DAILY_TIME_PATTERN.test(settings.dailyTime)
    ? settings.dailyTime : DEFAULT_DAILY_TIME;
  return [...new Set(saved.length ? saved : [fallback])].sort().slice(0, MAX_DAILY_TIMES);
}
