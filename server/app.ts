import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response, type NextFunction } from 'express';
import { ZodError } from 'zod';
import type { Dashboard, Source } from '../shared/types.js';
import type { Store } from './store.js';
import { Worker, WorkerRequestError } from './worker.js';
import { sourceDefaults } from './defaults.js';
import { collectionRequestSchema, sourceSchema, settingsSchema } from './validation.js';
import { nextScheduledAt } from './scheduler.js';
import { playbackRouter } from './playback.js';
import { posterDirectory } from './posters.js';
import { localPosterPath } from '../shared/poster-path.js';

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
export function createApp(store: Store, worker: Worker) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
  app.get('/api/health', (_req, res) => res.status(store.healthy ? 200 : 503).json({ ok: store.healthy, storage: store.mode, authRequired: Boolean(process.env.APP_AUTH_TOKEN) }));
  app.use('/api', (req, res, next) => {
    if (!store.healthy) { res.status(503).json({ error: '数据库连接中断，请重新启动服务' }); return; }
    const origin = req.get('origin');
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      try { if (new URL(origin).host !== req.get('host')) { res.status(403).json({ error: '禁止跨站修改配置' }); return; } }
      catch { res.status(403).json({ error: '请求来源无效' }); return; }
    }
    const required = process.env.APP_AUTH_TOKEN;
    if (!required || /^\/play\/[^/]+\/asset$/.test(req.path)) { next(); return; }
    const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') || (req.path.startsWith('/play/') ? String(req.query.token || '') : '');
    const left = Buffer.from(required); const right = Buffer.from(provided);
    if (left.length !== right.length || !timingSafeEqual(left, right)) { res.status(401).json({ error: '请输入访问令牌' }); return; }
    next();
  });
  app.get('/api/dashboard', (_req, res) => {
    const state = store.state;
    const speeds = state.resources.filter(item => item.probe.status === 'ok' && item.probe.speedMbps != null).map(item => item.probe.speedMbps!);
    const dashboard: Dashboard = { movieCount: state.movies.length, resourceCount: state.resources.length, sourceCount: state.sources.length,
      enabledSourceCount: state.sources.filter(source => source.enabled).length, healthyResources: state.resources.filter(item => item.probe.status === 'ok').length,
      averageSpeedMbps: speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : null,
      runningCount: state.runs.filter(run => ['running', 'queued'].includes(run.status)).length, storage: store.mode, schedulerNextAt: nextScheduledAt(state.settings) };
    res.json(dashboard);
  });
  app.get('/api/movies', (req, res) => {
    const { search = '', type = '', year = '', sourceId = '' } = req.query;
    const pageValue = req.query.page ?? '1'; const limitValue = req.query.limit ?? '24';
    const page = Number(pageValue); const requestedLimit = Number(limitValue);
    if (typeof pageValue !== 'string' || typeof limitValue !== 'string' || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      res.status(400).json({ error: 'page 和 limit 必须是正整数' }); return;
    }
    const limit = Math.min(100, requestedLimit);
    const needle = String(search).trim().toLowerCase();
    const movies = store.state.movies.filter(movie => (!needle || `${movie.title} ${movie.originalTitle} ${movie.actors.join(' ')} ${movie.director}`.toLowerCase().includes(needle)) && (!type || movie.type === type) && (!year || movie.year === year) && (!sourceId || movie.sourceRefs.some(ref => ref.sourceId === sourceId))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const counts = new Map<string, number>(); for (const resource of store.state.resources) counts.set(resource.movieId, (counts.get(resource.movieId) || 0) + 1);
    res.json({ items: movies.slice((page - 1) * limit, page * limit).map(movie => ({ ...movie, poster: localPosterPath(movie.poster), resourceCount: counts.get(movie.id) || 0 })), total: movies.length, page, limit,
      types: [...new Set(store.state.movies.map(movie => movie.type).filter(Boolean))].sort(), years: [...new Set(store.state.movies.map(movie => movie.year).filter(Boolean))].sort().reverse() });
  });
  app.get('/api/movies/:id', (req, res) => {
    const movie = store.state.movies.find(item => item.id === req.params.id);
    if (!movie) { res.status(404).json({ error: '影片不存在' }); return; }
    res.json({ movie: { ...movie, poster: localPosterPath(movie.poster) }, resources: store.state.resources.filter(item => item.movieId === movie.id) });
  });
  app.get('/api/archive/posters', (_req, res) => res.json(worker.posters.summary()));
  app.post('/api/archive/posters/retry', asyncRoute(async (_req, res) => {
    const summary = worker.posters.retry(); await store.save(); res.status(202).json(summary);
  }));
  app.get('/api/sources', (_req, res) => res.json(store.state.sources));
  app.post('/api/sources', asyncRoute(async (req, res) => {
    const input = sourceSchema.parse(sourceDefaults(req.body));
    const source = sourceDefaults(input); store.state.sources.push(source); await store.save(); res.status(201).json(source);
  }));
  app.put('/api/sources/:id', asyncRoute(async (req, res) => {
    const source = store.state.sources.find(item => item.id === req.params.id);
    if (!source) { res.status(404).json({ error: '采集源不存在' }); return; }
    const oldOrigin = new URL(source.baseUrl).origin;
    const input = sourceSchema.parse({ ...source, ...req.body });
    Object.assign(source, input);
    const newOrigin = new URL(source.baseUrl).origin;
    if (oldOrigin !== newOrigin) {
      // Only rewrite catalog references. CDN/playback URLs keep their original identity.
      for (const movie of store.state.movies) for (const ref of movie.sourceRefs) if (ref.sourceId === source.id && ref.pageUrl.startsWith(oldOrigin + '/')) ref.pageUrl = newOrigin + ref.pageUrl.slice(oldOrigin.length);
      for (const resource of store.state.resources) if (resource.sourceId === source.id) {
        if (resource.pageUrl?.startsWith(oldOrigin + '/')) resource.pageUrl = newOrigin + resource.pageUrl.slice(oldOrigin.length);
        if (resource.referer.startsWith(oldOrigin + '/')) resource.referer = newOrigin + resource.referer.slice(oldOrigin.length);
      }
    }
    await store.save(); res.json(source);
  }));
  app.delete('/api/sources/:id', asyncRoute(async (req, res) => {
    if (store.state.runs.some(run => run.sourceId === req.params.id && ['queued', 'running'].includes(run.status))) { res.status(409).json({ error: '请等待采集任务结束后再删除源' }); return; }
    store.state.sources = store.state.sources.filter(source => source.id !== req.params.id);
    await store.save(); res.json({ ok: true });
  }));
  app.post('/api/sources/:id/run', asyncRoute(async (req, res) => {
    const source = store.state.sources.find(item => item.id === req.params.id);
    if (!source) { res.status(404).json({ error: '采集源不存在' }); return; }
    const request = collectionRequestSchema.parse(req.body ?? {});
    const run = worker.enqueue(source, request); await store.save(); res.status(202).json(run);
  }));
  app.get('/api/runs', (_req, res) => res.json(store.state.runs));
  app.post('/api/runs/:id/cancel', asyncRoute(async (req, res) => {
    const run = await worker.cancel(String(req.params.id));
    if (!run) { res.status(404).json({ error: '采集任务不存在' }); return; }
    res.json(run);
  }));
  app.get('/api/settings', (_req, res) => res.json(store.state.settings));
  app.put('/api/settings', asyncRoute(async (req, res) => {
    const settings = settingsSchema.parse({ ...store.state.settings, ...req.body });
    store.state.settings = settings; await store.save(); res.json(settings);
  }));
  app.post('/api/resources/:id/probe', asyncRoute(async (req, res) => {
    const resource = store.state.resources.find(item => item.id === req.params.id);
    if (!resource) { res.status(404).json({ error: '资源不存在' }); return; }
    res.json(await worker.probe(resource));
  }));
  app.post('/api/resources/:id/refresh', asyncRoute(async (req, res) => {
    const resource = store.state.resources.find(item => item.id === req.params.id);
    if (!resource) { res.status(404).json({ error: '资源不存在' }); return; }
    res.json(await worker.probe(resource, true));
  }));
  app.post('/api/movies/:id/probe', asyncRoute(async (req, res) => {
    if (!store.state.movies.some(movie => movie.id === req.params.id)) { res.status(404).json({ error: '影片不存在' }); return; }
    const resources = store.state.resources.filter(item => item.movieId === req.params.id);
    for (const resource of resources) void worker.probe(resource).catch(() => console.error('资源检测写入失败'));
    res.status(202).json({ queued: resources.length });
  }));
  app.use('/api/play', playbackRouter(store));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use('/media/posters', express.static(posterDirectory(), { dotfiles: 'deny', immutable: true, maxAge: '30d' }));
  app.use('/media/posters', (_req, res) => res.status(404).end());
  app.use(express.static(path.resolve('dist'), { index: false }));
  app.get('*', (_req, res) => res.sendFile(path.resolve('dist/index.html'), error => { if (error && !res.headersSent) res.status(503).send('前端尚未构建，请运行 npm run dev 或 npm run build'); }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }); return; }
    if (error instanceof WorkerRequestError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'JSON 格式错误' }); return; }
    const message = error instanceof Error ? error.message : '服务发生错误';
    res.status(500).json({ error: message.replace(/(https?:\/\/)[^\s]+/g, '$1[地址已隐藏]') });
  };
  app.use(errorHandler);
  return app;
}
