import type { Run } from '../../shared/types';

export const isRunActive = (run: Run) => run.status === 'running' || run.status === 'queued';
export const hasRunIssues = (run: Run) => run.status === 'error' || (run.progress?.failures.total ?? run.errors.length) > 0;
export const runFailureCount = (run: Run): number | null => run.progress?.failures.total ?? null;

export function discoveredProgress(run: Run): number | null {
  const progress = run.progress;
  if (!progress || progress.discoveredMovies <= 0 || (isRunActive(run) && !progress.paginationComplete)) return null;
  return Math.min(100, Math.max(0, progress.completedMovies / progress.discoveredMovies * 100));
}

export function errorCategory(message: string): string {
  if (/超时|timeout|timed out/i.test(message)) return '请求超时';
  if (/certificate|TLS|SSL|证书/i.test(message)) return '证书 / TLS';
  if (/未发现|未找到|解析|m3u8/i.test(message)) return '资源解析';
  if (/socket|network|ECONN|aborted|fetch failed|网络/i.test(message)) return '网络连接';
  return '其他异常';
}

export function formatRunDuration(run: Run, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
