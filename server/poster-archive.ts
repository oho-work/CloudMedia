import { setTimeout as delay } from 'node:timers/promises';
import type { Movie, PosterArchive } from '../shared/types.js';
import { archivePoster, inspectPoster } from './posters.js';
import { resolvePosterPage } from './collector.js';
import type { Store } from './store.js';

const remote = (value: string) => /^https?:\/\//i.test(value);
const local = (value: string) => /^\/media\/posters\/[a-f0-9]{64}\.(jpg|png|webp|avif|gif)$/.test(value);

/** A single resumable queue; browsing never fetches an original image. */
export class PosterArchiver {
  private controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<void>>();
  private lastRequests = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private loop?: Promise<void>;
  private stopped = false;
  constructor(private store: Store) {}

  summary() {
    const result = { total: this.store.state.movies.length, saved: 0, pending: 0, error: 0, missing: 0, running: Boolean(this.loop) || this.pending.size > 0 };
    for (const movie of this.store.state.movies) {
      const status = movie.posterArchive?.status || (movie.poster ? 'pending' : 'missing'); result[status]++;
    }
    return result;
  }

  start() {
    if (this.stopped || this.timer) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), 60000); this.timer.unref();
  }
  private kick() {
    if (this.stopped || this.loop) return;
    this.loop = this.scan().catch(() => console.error('图片归档状态写入失败，请检查存储连接')).finally(() => { this.loop = undefined; });
  }
  private async scan() {
    // Each item's original URL and state are committed before downloading it.
    // Other items remain untouched; API presentation strips all remote images.
    const movies = [...this.store.state.movies].sort((a, b) => Number(local(b.poster)) - Number(local(a.poster)));
    for (const movie of movies) {
      if (this.stopped) break;
      await this.archiveMovie(movie);
    }
  }
  retry() {
    for (const movie of this.store.state.movies) if (movie.posterArchive && movie.posterArchive.status !== 'saved') {
      movie.posterArchive.nextRetryAt = null; movie.posterArchive.status = 'pending';
    }
    this.kick();
    return this.summary();
  }

  private prepare(movie: Movie, originalUrl = '', referer = ''): PosterArchive {
    const previous = movie.posterArchive;
    const target = remote(originalUrl) ? originalUrl : previous?.originalUrl || (remote(movie.poster) ? movie.poster : '');
    const changed = Boolean(target && previous?.originalUrl !== target);
    const archive: PosterArchive = previous && !changed ? previous : {
      status: 'pending', originalUrl: target, referer: referer || movie.sourceRefs[0]?.pageUrl || '',
      path: local(movie.poster) ? movie.poster : previous?.path || '', attempts: 0, lastAttemptAt: null, nextRetryAt: null, error: null,
    };
    if (referer) archive.referer = referer;
    movie.posterArchive = archive;
    return archive;
  }

  recordPoster(movie: Movie, originalUrl: string, referer: string) {
    if (remote(originalUrl)) this.prepare(movie, originalUrl, referer);
  }

  archiveMovie(movie: Movie, originalUrl = '', referer = '', signal?: AbortSignal, force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.pending.get(movie.id);
    if (existing) return originalUrl || force || signal
      ? existing.then(() => this.archiveMovie(movie, originalUrl, referer, signal, force)) : existing;
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    const task = this.tail.then(() => this.perform(movie, originalUrl, referer, combined, force));
    this.pending.set(movie.id, task);
    this.tail = task.catch(() => {});
    void task.then(() => this.pending.delete(movie.id), () => this.pending.delete(movie.id));
    return task;
  }
  private async throttle(url: string, signal: AbortSignal, interval: number) {
    const host = new URL(url).host;
    const wait = Math.max(0, interval - (Date.now() - (this.lastRequests.get(host) || 0)));
    if (wait) await delay(wait, undefined, { signal });
    signal.throwIfAborted(); this.lastRequests.set(host, Date.now());
  }
  private async recover(movie: Movie, signal: AbortSignal): Promise<{ url: string; referer: string } | null> {
    let failure: unknown;
    for (const reference of movie.sourceRefs) {
      const source = this.store.state.sources.find(item => item.id === reference.sourceId);
      if (!source) continue;
      try {
        await this.throttle(reference.pageUrl, signal, Math.max(0, source.requestIntervalMs));
        const recovered = await resolvePosterPage(source, reference.pageUrl, { settings: this.store.state.settings, signal, log: () => {} });
        if (remote(recovered)) return { url: recovered, referer: reference.pageUrl };
      } catch (error) { signal.throwIfAborted(); failure = error; }
    }
    if (failure) throw failure;
    return null;
  }
  private async perform(movie: Movie, originalUrl: string, referer: string, signal: AbortSignal, force: boolean) {
    if (signal.aborted) return;
    const before = JSON.stringify({ poster: movie.poster, archive: movie.posterArchive });
    const changed = remote(originalUrl) && originalUrl !== movie.posterArchive?.originalUrl;
    const archive = this.prepare(movie, originalUrl, referer);
    const previous = await inspectPoster(movie.poster || archive.path, this.store.posterStorage);
    if (movie.posterArchive !== archive) return;
    movie.poster = previous?.path || '';
    if (previous && !changed && !force && (archive.status === 'saved' || !archive.originalUrl)) {
      movie.poster = previous.path; Object.assign(archive, previous, { status: 'saved', error: null, nextRetryAt: null });
      if (before !== JSON.stringify({ poster: movie.poster, archive: movie.posterArchive })) await this.store.save();
      return;
    }
    if (!force && archive.nextRetryAt && new Date(archive.nextRetryAt).getTime() > Date.now()) {
      if (before !== JSON.stringify({ poster: movie.poster, archive: movie.posterArchive })) await this.store.save();
      return;
    }
    archive.status = 'pending'; archive.lastAttemptAt = new Date().toISOString(); archive.attempts++;
    await this.store.save();
    try {
      if (!archive.originalUrl && local(archive.path)) {
        const recovered = await this.recover(movie, signal);
        if (movie.posterArchive !== archive) return;
        if (recovered) { archive.originalUrl = recovered.url; archive.referer = recovered.referer; }
      }
      if (!archive.originalUrl) {
        archive.status = 'missing'; archive.error = '已归档图片缺失，且没有可恢复的原图地址；请重新采集。';
        archive.nextRetryAt = new Date(Date.now() + 86400000).toISOString();
      } else {
        const source = this.store.state.sources.find(item => movie.sourceRefs.some(reference => reference.sourceId === item.id && reference.pageUrl === archive.referer))
          || movie.sourceRefs.map(reference => this.store.state.sources.find(item => item.id === reference.sourceId)).find(Boolean);
        const interval = source ? Math.max(0, source.requestIntervalMs) : 1000;
        const file = await archivePoster(archive.originalUrl, archive.referer, this.store.state.settings, signal, target => this.throttle(target.href, signal, interval), this.store.posterStorage);
        if (movie.posterArchive !== archive) return;
        movie.poster = file.path;
        Object.assign(archive, file, { status: 'saved', error: null, nextRetryAt: null });
      }
    } catch (error) {
      if (movie.posterArchive !== archive) return;
      archive.status = signal.aborted ? 'pending' : 'error';
      archive.error = signal.aborted ? null : (error instanceof Error ? error.message : '图片归档失败').replace(/https?:\/\/\S+/g, '[图片地址]');
      archive.nextRetryAt = signal.aborted ? null : new Date(Date.now() + Math.min(86400000, 300000 * 2 ** Math.min(archive.attempts - 1, 8))).toISOString();
    }
    await this.store.save();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer); this.controller.abort();
    await this.loop; await this.tail;
  }
}
