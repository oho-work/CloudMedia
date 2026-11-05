import { z } from 'zod';
import type { Movie, State } from '../shared/types.js';
import { localPosterPath } from '../shared/poster-path.js';

const positiveInteger = (fallback: string) => z.string().default(fallback).transform(Number).refine(value => Number.isSafeInteger(value) && value > 0, '必须是正整数');
const libraryQuerySchema = z.object({
  search: z.string().trim().default(''), type: z.string().trim().default(''), genre: z.string().trim().default(''),
  region: z.string().trim().default(''), year: z.string().trim().default(''), sourceId: z.string().trim().default(''),
  updateStatus: z.enum(['', 'ongoing', 'completed', 'unknown']).default(''),
  hasResources: z.enum(['', 'yes', 'no']).default(''),
  page: positiveInteger('1'), limit: positiveInteger('12').transform(value => Math.min(value, 100)),
});

type UpdateStatus = 'ongoing' | 'completed' | 'unknown';
const metadataValues = (value: string) => value.split(/[/／,，、|]+/).map(item => item.trim()).filter(Boolean);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

function libraryType(movie: Movie): string {
  const type = movie.type.trim();
  // Older collectors classified short dramas as TV series. Derive the display
  // category without rewriting the saved metadata or merging unrelated genres.
  return (type === '电视剧' || !type) && movie.genres.flatMap(metadataValues).includes('短剧') ? '短剧' : type;
}

function updateStatus(value: string): UpdateStatus {
  const status = value.replace(/\s+/g, '');
  if (/未完[结結]|未完|连载|連載|更新中/i.test(status)) return 'ongoing';
  if (/完[结結]|大[结結]局|全集|^(?:全\d+[集话話]|completed)(?:$|[（(])/i.test(status)) return 'completed';
  if (/更新(?:至|到)|更新(?:第)?[\d一二三四五六七八九十百]+[集话話期]|^ongoing$/i.test(status)) return 'ongoing';
  // HD, 正片, and an episode number are quality/position labels, not proof that
  // the series is complete. Keep the original status alongside this category.
  return 'unknown';
}

export function queryLibrary(state: Pick<State, 'movies' | 'resources'>, input: unknown) {
  const query = libraryQuerySchema.parse(input);
  const counts = new Map<string, number>();
  for (const resource of state.resources) counts.set(resource.movieId, (counts.get(resource.movieId) || 0) + 1);
  const catalogue = state.movies.map(movie => ({
    movie, libraryType: libraryType(movie), updateStatus: updateStatus(movie.status),
    genres: movie.genres.flatMap(metadataValues), regions: metadataValues(movie.region), resourceCount: counts.get(movie.id) || 0,
  }));
  const preferredTypes = ['电影', '电视剧', '动漫', '短剧', '综艺'];
  const types = unique(catalogue.map(item => item.libraryType));
  const facets = {
    types: [...preferredTypes.filter(type => types.includes(type)), ...types.filter(type => !preferredTypes.includes(type))],
    genres: unique(catalogue.flatMap(item => item.genres)), regions: unique(catalogue.flatMap(item => item.regions)),
    years: unique(catalogue.map(item => item.movie.year.trim())).sort((a, b) => b.localeCompare(a, 'zh-CN', { numeric: true })),
    updateStatuses: ['ongoing', 'completed', 'unknown'] as const, resourceAvailability: ['yes', 'no'] as const,
  };
  const needle = query.search.toLowerCase();
  const filtered = catalogue.filter(item => {
    const movie = item.movie;
    return (!needle || `${movie.title} ${movie.originalTitle} ${movie.actors.join(' ')} ${movie.director}`.toLowerCase().includes(needle))
      && (!query.type || item.libraryType === query.type) && (!query.genre || item.genres.includes(query.genre))
      && (!query.region || item.regions.includes(query.region)) && (!query.year || movie.year.trim() === query.year)
      && (!query.updateStatus || item.updateStatus === query.updateStatus)
      && (!query.hasResources || (item.resourceCount > 0) === (query.hasResources === 'yes'))
      && (!query.sourceId || movie.sourceRefs.some(ref => ref.sourceId === query.sourceId));
  }).sort((a, b) => b.movie.createdAt.localeCompare(a.movie.createdAt) || a.movie.id.localeCompare(b.movie.id));
  const total = filtered.length;
  const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.limit)));
  const items = filtered.slice((page - 1) * query.limit, page * query.limit).map(item => {
    const { posterArchive: _posterArchive, ...movie } = item.movie;
    return { ...movie, poster: localPosterPath(movie.poster), libraryType: item.libraryType, updateStatus: item.updateStatus, resourceCount: item.resourceCount };
  });
  return { items, total, page, limit: query.limit, ...facets };
}
