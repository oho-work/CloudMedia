import { randomUUID } from 'node:crypto';
import type { CollectedMovie, CollectionRequest, DateRange, Resource, Run, Source } from '../shared/types.js';
import { collectSource, resolvePlaybackPage } from './collector.js';
import { rememberResource, upsertMovie } from './catalog.js';
import { probeResource } from './hls.js';
import { localMinute } from './scheduler.js';
import type { Store } from './store.js';
import { PosterArchiver } from './poster-archive.js';
import { emptyProbe } from './defaults.js';
import { resolveDateRange } from './dates.js';
import { concurrentBatch, TaskLimiter } from './concurrency.js';

export class WorkerRequestError extends Error {
  constructor(message: string, readonly status: 400 | 409) { super(message); }
}

function collectionRange(source: Source, request: CollectionRequest, timezone: string): DateRange | undefined {
  const hasDates = request.startDate !== undefined || request.endDate !== undefined;
  const mode = request.mode || (hasDates ? 'range' : source.collectionMode === 'updates' ? 'today' : source.collectionMode || 'all');
  if (mode === 'all') return undefined;
  try {
    if (mode === 'today') return resolveDateRange({}, timezone);
    const dates = hasDates ? request : { startDate: source.startDate, endDate: source.endDate };
    // Old date-only API requests keep their single-day shorthand; configured/explicit ranges need both boundaries.
    if ((request.mode === 'range' || !hasDates) && (!dates.startDate || !dates.endDate)) throw new Error('区间采集需要开始日期和结束日期');
    return resolveDateRange(dates, timezone);
  } catch (error) { throw new WorkerRequestError(error instanceof Error ? error.message : '日期范围无效', 400); }
}

function sameRange(left?: DateRange, right?: DateRange) {
  return left?.startDate === right?.startDate && left?.endDate === right?.endDate && left?.timezone === right?.timezone;
}

export class Worker {
  private queue: { source: Source; run: Run }[] = [];
  private working = false;
  private stopping = false;
  private controller = new AbortController();
  private runControllers = new Map<string, AbortController>();
  private pendingProbes = new Map<string, Promise<Resource>>();
  private sourceLimiters = new Map<string, TaskLimiter>();
  private resourceLimiters = new Map<string, { limiter: TaskLimiter; pending: number }>();
  private frozenSourceLimits = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  readonly posters: PosterArchiver;
  constructor(private store: Store) { this.posters = new PosterArchiver(store); }
  enqueue(source: Source, request: CollectionRequest = {}): Run {
    const dateRange = collectionRange(source, request, this.store.state.settings.timezone);
    const existing = this.store.state.runs.find(run => run.sourceId === source.id && ['queued', 'running'].includes(run.status));
    if (existing) {
      if (!sameRange(existing.dateRange, dateRange)) throw new WorkerRequestError('该源已有其他采集范围的任务，请等待完成或取消后重试', 409);
      return existing;
    }
    const run: Run = { id: randomUUID(), sourceId: source.id, sourceName: source.name, status: 'queued', startedAt: new Date().toISOString(), finishedAt: null, scanned: 0, added: 0, updated: 0, resourceCount: 0, errors: [], message: '等待采集', ...(dateRange ? { dateRange } : {}) };
    this.store.state.runs.unshift(run);
    const snapshot = structuredClone(source);
    this.frozenSourceLimits.set(source.id, snapshot.concurrency || 1);
    this.sourceLimiter(source.id);
    snapshot.collectionMode = dateRange ? 'updates' : 'all';
    snapshot.maxPages = snapshot.maxItems = snapshot.maxResourcePages = 0;
    this.queue.push({ source: snapshot, run });
    this.runControllers.set(run.id, new AbortController());
    this.store.state.runs = this.store.state.runs.slice(0, 1000);
    void this.process();
    return run;
  }
  async cancel(id: string): Promise<Run | undefined> {
    const run = this.store.state.runs.find(item => item.id === id);
    if (!run || !['queued', 'running'].includes(run.status)) return run;
    this.runControllers.get(id)?.abort(new Error('用户取消了采集任务'));
    if (run.status === 'queued') {
      this.queue = this.queue.filter(item => item.run.id !== id);
      run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.message = '用户取消，已保存的采集结果保留';
      this.runControllers.delete(id);
      this.releaseSourceLimit(run.sourceId);
    } else run.message = '正在取消采集，已保存的结果保留';
    await this.store.save();
    return run;
  }
  private async process() {
    if (this.working || this.stopping) return;
    this.working = true;
    let activeRun: Run | undefined;
    try {
      while (this.queue.length && !this.stopping) {
        const { source, run } = this.queue.shift()!;
        activeRun = run;
        const runController = this.runControllers.get(run.id)!;
        const cancellation = AbortSignal.any([this.controller.signal, runController.signal]);
        const processingController = new AbortController();
        const signal = AbortSignal.any([cancellation, processingController.signal]);
        run.status = 'running'; run.message = '正在读取源页面';
        try {
          await this.store.save();
          const settings = this.store.state.settings;
          const countedMovies = new Set<string>();
          const countedResources = new Set<string>();
          let collectionErrors = 0;
          const persist = async (input: CollectedMovie) => {
            const result = upsertMovie(this.store.state, source, input);
            if (input.poster) this.posters.recordPoster(result.movie, input.poster, input.pageUrl);
            if (!countedMovies.has(input.externalId)) {
              countedMovies.add(input.externalId); run.scanned++;
              if (result.added) run.added++; else run.updated++;
            }
            for (const resource of result.resources) countedResources.add(resource.id);
            run.resourceCount = countedResources.size;
            await this.store.save();
            return result;
          };
          const processMovie = async (input: CollectedMovie) => {
            try {
              signal.throwIfAborted();
              // Metadata reaches storage before any slow poster download or stream probe.
              const result = await persist(input);
              await this.posters.archiveMovie(result.movie, input.poster, input.pageUrl, signal);
              signal.throwIfAborted();
              if (this.store.state.settings.probeEnabled) {
                await concurrentBatch(result.resources, source.concurrency || 1, async resource => {
                  try {
                    signal.throwIfAborted();
                    if (resource.probe.status !== 'pending') return;
                    run.message = `正在检测「${result.movie.title}」${resource.name} / ${resource.episode}`;
                    const checked = await this.probe(resource, false, signal);
                    signal.throwIfAborted();
                    if (checked.probe.status === 'error' && run.errors.length < 30) run.errors.push(`${resource.episode}：${checked.probe.error}`);
                  } catch (error) { processingController.abort(error); throw error; }
                }, signal);
              }
            } catch (error) { processingController.abort(error); throw error; }
          };
          let batch: CollectedMovie[] = [];
          for await (const input of collectSource(source, { settings, dateRange: run.dateRange, signal, runSourceTask: (action, taskSignal) => this.sourceLimiter(source.id).run(action, taskSignal), onCollectionError: message => { collectionErrors++; if (run.errors.length < 30) run.errors.push(message); }, log: message => { if (!signal.aborted) run.message = message; }, onCheckpoint: async input => { await persist(input); }, existingResources: externalId => {
            const movie = this.store.state.movies.find(item => item.sourceRefs.some(ref => ref.sourceId === source.id && ref.externalId === externalId));
            if (!movie) return [];
            return this.store.state.resources.filter(item => item.movieId === movie.id && item.sourceId === source.id && item.probe.status !== 'error' && Date.now() - new Date(item.resolvedAt || item.createdAt).getTime() < settings.resourceRefreshHours * 3600000)
              .map(item => ({ name: item.name, episode: item.episode, url: item.url, referer: item.referer, pageUrl: item.pageUrl, resolvedAt: item.resolvedAt || item.createdAt }));
          }, knownPageUrls: externalId => {
            const movie = this.store.state.movies.find(item => item.sourceRefs.some(ref => ref.sourceId === source.id && ref.externalId === externalId));
            return this.store.state.resources.filter(item => item.movieId === movie?.id && item.sourceId === source.id && item.pageUrl).map(item => item.pageUrl!);
          } })) {
            signal.throwIfAborted();
            batch.push(input);
            if (batch.length >= (source.concurrency || 1)) {
              await concurrentBatch(batch, source.concurrency || 1, processMovie, signal);
              batch = [];
            }
          }
          await concurrentBatch(batch, source.concurrency || 1, processMovie, signal);
          signal.throwIfAborted();
          run.status = collectionErrors ? 'error' : 'success';
          run.message = `已扫描 ${run.scanned} 部，新增 ${run.added} 部，更新 ${run.updated} 部${collectionErrors ? `；${collectionErrors} 个播放页未取得地址，可重新采集补齐` : ''}`;
        } catch (error) {
          run.status = cancellation.aborted ? 'interrupted' : 'error';
          run.message = cancellation.aborted ? (this.stopping ? '服务停止，已保存的采集结果保留' : '用户取消，已保存的采集结果保留') : error instanceof Error ? error.message : '采集失败';
          if (!cancellation.aborted) run.errors.push(run.message);
        }
        this.runControllers.delete(run.id);
        this.releaseSourceLimit(source.id);
        run.finishedAt = new Date().toISOString();
        const current = this.store.state.sources.find(item => item.id === source.id);
        if (current) { current.lastRunAt = run.finishedAt; current.lastError = run.status === 'error' ? run.message : null; }
        try { await this.store.save(); }
        catch (error) {
          run.status = 'error'; run.message = `任务写入失败：${error instanceof Error ? error.message : '未知错误'}`;
          run.errors.push(run.message);
          if (current) current.lastError = run.message;
          // A transient final write must persist an error rather than report an unsaved success.
          await this.store.save();
        }
        activeRun = undefined;
      }
    } catch (error) {
      const message = `存储写入失败，排队任务已中断：${error instanceof Error ? error.message : '未知错误'}`;
      console.error(message);
      for (const { run } of this.queue) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.message = message; run.errors.push(message);
        this.runControllers.delete(run.id);
        this.releaseSourceLimit(run.sourceId);
      }
      this.queue.length = 0;
      await this.store.save().catch(() => console.error('任务错误状态保存失败，请检查存储连接'));
    }
    finally {
      if (activeRun) this.runControllers.delete(activeRun.id);
      this.working = false;
      // Requests may enqueue a fresh retry while the failure state is being persisted.
      if (this.queue.length && !this.stopping) void this.process();
    }
  }
  private sourceLimiter(sourceId: string): TaskLimiter {
    const limit = this.frozenSourceLimits.get(sourceId) || this.store.state.sources.find(source => source.id === sourceId)?.concurrency || 1;
    let limiter = this.sourceLimiters.get(sourceId);
    if (!limiter) { limiter = new TaskLimiter(limit); this.sourceLimiters.set(sourceId, limiter); }
    else limiter.setLimit(limit);
    return limiter;
  }
  private releaseSourceLimit(sourceId: string) {
    this.frozenSourceLimits.delete(sourceId);
    this.sourceLimiter(sourceId);
  }
  probe(resource: Resource, refresh = false, signal = this.controller.signal): Promise<Resource> {
    if (this.stopping) return Promise.reject(new Error('服务正在停止'));
    const key = `${resource.id}:${refresh}:${signal === this.controller.signal ? 'manual' : 'run'}`;
    const pending = this.pendingProbes.get(key);
    if (pending) return pending;
    const combinedSignal = AbortSignal.any([this.controller.signal, signal]);
    const sourceLimiter = this.sourceLimiter(resource.sourceId);
    let serial = this.resourceLimiters.get(resource.id);
    if (!serial) { serial = { limiter: new TaskLimiter(1), pending: 0 }; this.resourceLimiters.set(resource.id, serial); }
    serial.pending++;
    const task = serial.limiter.run(() => sourceLimiter.run(async () => {
      if (this.stopping) throw new Error('服务正在停止');
      combinedSignal.throwIfAborted();
      if (refresh) {
        const source = this.store.state.sources.find(item => item.id === resource.sourceId);
        if (!source || !resource.pageUrl) throw new Error('该资源没有可用的原始播放页，请重新采集来源');
        const movie = this.store.state.movies.find(item => item.id === resource.movieId);
        const detailPage = movie?.sourceRefs.find(reference => reference.sourceId === source.id && reference.pageUrl)?.pageUrl;
        const previousUrl = resource.url, previousResolvedAt = resource.resolvedAt;
        const resolved = await resolvePlaybackPage(source, resource.pageUrl, { settings: this.store.state.settings, signal: combinedSignal, log: () => {} }, detailPage || source.baseUrl);
        combinedSignal.throwIfAborted();
        if (resource.url !== previousUrl || resource.resolvedAt !== previousResolvedAt) return resource;
        const selected = resolved.find(item => item.url === resource.url) || (resolved.length === 1 ? resolved[0] : undefined);
        if (!selected) throw new Error(resolved.length ? '原始页面有多个播放地址，请从采集源重新采集以确认剧集' : '原始页面未发现公开的 m3u8 地址');
        rememberResource(resource);
        resource.url = selected.url; resource.resolvedAt = selected.resolvedAt || new Date().toISOString();
        resource.referer = selected.referer || resource.pageUrl;
        resource.probe = emptyProbe(); rememberResource(resource); await this.store.save();
      }
      const original = resource.url, resolvedAt = resource.resolvedAt;
      const result = await probeResource({ ...resource }, { ...this.store.state.settings }, combinedSignal);
      combinedSignal.throwIfAborted();
      if (resource.url === original && resource.resolvedAt === resolvedAt) { rememberResource(resource); resource.probe = result; rememberResource(resource); resource.updatedAt = new Date().toISOString(); await this.store.save(); }
      return resource;
    }, combinedSignal), combinedSignal);
    this.pendingProbes.set(key, task);
    void task.finally(() => {
      this.pendingProbes.delete(key);
      if (--serial.pending === 0) this.resourceLimiters.delete(resource.id);
    }).catch(() => {});
    return task;
  }
  startScheduler() {
    this.posters.start();
    const tick = async () => {
      const settings = this.store.state.settings;
      if (!settings.schedulerEnabled || this.stopping) return;
      const now = localMinute(new Date(), settings.timezone);
      if (now.time < settings.dailyTime) return;
      for (const source of this.store.state.sources) {
        if (!source.enabled) continue;
        if (this.store.state.runs.some(run => run.sourceId === source.id && ['queued', 'running'].includes(run.status))) continue;
        const scope = collectionRange(source, {}, settings.timezone);
        const ranToday = this.store.state.runs.some(run => run.sourceId === source.id && localMinute(new Date(run.startedAt), settings.timezone).day === now.day && sameRange(run.dateRange, scope));
        if (!ranToday) this.enqueue(source);
      }
      await this.store.save();
    };
    this.timer = setInterval(() => { void tick().catch(() => console.error('定时任务写入失败')); }, 30000);
    this.timer.unref();
    void tick().catch(() => console.error('定时任务初始化失败'));
  }
  async stop() {
    this.stopping = true; clearInterval(this.timer); this.controller.abort();
    await this.posters.stop();
    for (const { run } of this.queue) { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.message = '服务停止，排队任务已中断'; this.runControllers.delete(run.id); this.releaseSourceLimit(run.sourceId); }
    this.queue.length = 0;
    while (this.working) await new Promise(resolve => setTimeout(resolve, 100));
    await Promise.allSettled([...this.pendingProbes.values()]);
    await this.store.save();
  }
}
