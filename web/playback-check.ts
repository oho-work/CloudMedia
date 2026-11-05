import type { Resource } from '../shared/types';
import { episodeKey } from '../shared/episode';

export class PlaybackCheckClient {
  private pending = new Map<string, Promise<Resource[]>>();
  constructor(private request: (resourceId: string) => Promise<Resource[]>) {}
  check(resource: Resource): Promise<Resource[]> {
    const key = JSON.stringify([resource.movieId, episodeKey(resource.episode)]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.request(resource.id);
    this.pending.set(key, request);
    void request.finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); }).catch(() => {});
    return request;
  }
}
