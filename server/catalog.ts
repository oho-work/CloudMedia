import { randomUUID } from 'node:crypto';
import type { CollectedMovie, Movie, Resource, Source, State } from '../shared/types.js';
import { emptyProbe } from './defaults.js';

function normalized(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s·:：!！?？\-—_]/g, ''); }
/** Keep previous addresses and measurements when a source rotates its links. */
export function rememberResource(resource: Resource) {
  resource.urlHistory ??= [];
  if (!resource.urlHistory.some(item => item.url === resource.url && item.resolvedAt === resource.resolvedAt)) {
    resource.urlHistory.push({ url: resource.url, referer: resource.referer, pageUrl: resource.pageUrl, resolvedAt: resource.resolvedAt, archivedAt: new Date().toISOString() });
  }
  resource.probeHistory ??= [];
  if (resource.probe.checkedAt && !resource.probeHistory.some(item => JSON.stringify(item) === JSON.stringify(resource.probe))) resource.probeHistory.push(structuredClone(resource.probe));
}
export function upsertMovie(state: State, source: Source, input: CollectedMovie): { movie: Movie; added: boolean; resources: Resource[] } {
  const now = new Date().toISOString();
  const title = input.title.trim();
  if (!title) throw new Error('影片标题为空');
  let movie = state.movies.find(item => item.sourceRefs.some(ref => ref.sourceId === source.id && ref.externalId === input.externalId));
  if (!movie && input.externalIds && Object.keys(input.externalIds).length) movie = state.movies.find(item => Object.entries(input.externalIds!).some(([key, value]) => value && item.externalIds[key] === value));
  // Be conservative: do not merge remakes with unknown years or mixed types.
  if (!movie && input.year && input.type) movie = state.movies.find(item => normalized(item.title) === normalized(title) && item.year === input.year && item.type === input.type);
  const added = !movie;
  if (!movie) {
    movie = { id: randomUUID(), title, originalTitle: '', year: '', region: '', type: '', genres: [], director: '', actors: [], description: '', poster: '', rating: '', status: '', externalIds: {}, sourceRefs: [], createdAt: now, updatedAt: now };
    state.movies.push(movie);
  }
  const fields = ['originalTitle', 'year', 'region', 'type', 'director', 'description', 'poster', 'rating', 'status'] as const;
  movie.title = title;
  for (const field of fields) if (input[field]?.trim()) {
    if (field === 'poster' && movie.poster.startsWith('/media/posters/') && !input.poster?.startsWith('/media/posters/')) continue;
    movie[field] = input[field]!.trim();
  }
  if (input.genres?.length) movie.genres = [...new Set([...movie.genres, ...input.genres])];
  if (input.actors?.length) movie.actors = input.actors;
  Object.assign(movie.externalIds, input.externalIds || {});
  const ref = movie.sourceRefs.find(item => item.sourceId === source.id && item.externalId === input.externalId);
  if (ref) { ref.pageUrl = input.pageUrl; if (input.sourceUpdatedOn) ref.updatedOn = input.sourceUpdatedOn; }
  else movie.sourceRefs.push({ sourceId: source.id, externalId: input.externalId, pageUrl: input.pageUrl, ...(input.sourceUpdatedOn ? { updatedOn: input.sourceUpdatedOn } : {}) });
  movie.updatedAt = now;
  const resources: Resource[] = [];
  for (const entry of input.resources) {
    let url: URL; try { url = new URL(entry.url, source.baseUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const existing = state.resources.find(item => item.movieId === movie!.id && item.sourceId === source.id && item.name === entry.name && item.episode === entry.episode);
    if (existing) {
      rememberResource(existing);
      const resolvedAt = entry.resolvedAt || now;
      if (existing.url !== url.href || existing.resolvedAt !== resolvedAt) { existing.url = url.href; existing.probe = emptyProbe(); }
      existing.referer = entry.referer || source.referer || input.pageUrl;
      if (entry.pageUrl) existing.pageUrl = entry.pageUrl;
      existing.resolvedAt = resolvedAt;
      existing.updatedAt = now;
      rememberResource(existing);
      resources.push(existing);
    } else {
      const resource: Resource = { id: randomUUID(), movieId: movie.id, sourceId: source.id, name: entry.name || source.name, episode: entry.episode || '正片', url: url.href, referer: entry.referer || source.referer || input.pageUrl, pageUrl: entry.pageUrl, resolvedAt: entry.resolvedAt || now, probe: emptyProbe(), createdAt: now, updatedAt: now };
      state.resources.push(resource); resources.push(resource);
      rememberResource(resource);
    }
  }
  return { movie, added, resources };
}
