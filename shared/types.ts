export type Adapter = 'html';
export type CollectionMode = 'today' | 'all' | 'range';
export interface CollectionRequest { mode?: CollectionMode; startDate?: string; endDate?: string }
export interface DateRange { startDate: string; endDate: string; timezone: string }
export interface Source {
  id: string; name: string; baseUrl: string; adapter: Adapter; enabled: boolean;
  listPath: string; detailLinkSelector: string; titleSelector: string; posterSelector: string;
  descriptionSelector: string; resourceSelector: string; nextPageSelector: string;
  requestIntervalMs: number; maxPages: number; maxItems: number; maxResourcePages: number; respectRobots: boolean;
  referer: string; createdAt: string; lastRunAt: string | null; lastError: string | null;
  collectionMode?: CollectionMode | 'updates'; updatesSortedDescending?: boolean;
  startDate?: string; endDate?: string;
}
export interface Settings {
  dailyTime: string; timezone: string; schedulerEnabled: boolean;
  probeEnabled: boolean; sampleSegments: number; sampleBytes: number;
  probeTimeoutMs: number; preferredQuality: 'highest' | 'lowest';
  resourceRefreshHours: number;
  maxRetries: number; userAgent: string;
}
export interface ProbeResult {
  status: 'pending' | 'ok' | 'error'; checkedAt: string | null;
  width: number | null; height: number | null; bandwidth: number | null;
  speedMbps: number | null; latencyMs: number | null; bytesRead: number;
  durationMs: number; sampledSegments: number; playlistUrl: string | null;
  error: string | null;
}
export interface Resource {
  id: string; movieId: string; sourceId: string; name: string; episode: string;
  url: string; referer: string; pageUrl?: string; resolvedAt?: string; probe: ProbeResult; createdAt: string; updatedAt: string;
  urlHistory?: { url: string; referer: string; pageUrl?: string; resolvedAt?: string; archivedAt: string }[];
  probeHistory?: ProbeResult[];
}
export interface PosterArchive {
  status: 'pending' | 'saved' | 'error' | 'missing';
  originalUrl: string; referer: string; path: string;
  sha256?: string; mime?: string; bytes?: number; downloadedAt?: string;
  attempts: number; lastAttemptAt: string | null; nextRetryAt: string | null; error: string | null;
}
export interface Movie {
  id: string; title: string; originalTitle: string; year: string; region: string;
  type: string; genres: string[]; director: string; actors: string[]; description: string;
  poster: string; rating: string; status: string; externalIds: Record<string, string>;
  posterArchive?: PosterArchive;
  sourceRefs: { sourceId: string; externalId: string; pageUrl: string; updatedOn?: string }[];
  createdAt: string; updatedAt: string;
}
export interface Run {
  id: string; sourceId: string; sourceName: string; status: 'queued' | 'running' | 'success' | 'error' | 'interrupted';
  startedAt: string; finishedAt: string | null; scanned: number; added: number; updated: number;
  resourceCount: number; errors: string[]; message: string;
  dateRange?: DateRange;
}
export interface State { sources: Source[]; movies: Movie[]; resources: Resource[]; runs: Run[]; settings: Settings }
export interface CollectedResource { name: string; episode: string; url: string; referer?: string; pageUrl?: string; resolvedAt?: string }
export interface CollectedMovie {
  externalId: string; pageUrl: string; title: string; originalTitle?: string; year?: string;
  region?: string; type?: string; genres?: string[]; director?: string; actors?: string[];
  description?: string; poster?: string; rating?: string; status?: string;
  externalIds?: Record<string, string>; resources: CollectedResource[];
  sourceUpdatedOn?: string;
}
export interface CollectionContext {
  settings: Settings; signal?: AbortSignal;
  dateRange?: DateRange;
  log: (message: string) => void;
  onCollectionError?: (message: string) => void;
  existingResources?: (externalId: string) => CollectedResource[];
  knownPageUrls?: (externalId: string) => string[];
  onCheckpoint?: (movie: CollectedMovie) => Promise<void>;
}
export interface Dashboard {
  movieCount: number; resourceCount: number; sourceCount: number; enabledSourceCount: number;
  healthyResources: number; averageSpeedMbps: number | null; runningCount: number;
  storage: 'postgres' | 'file'; schedulerNextAt: string | null;
}
