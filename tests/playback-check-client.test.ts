import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackCheckClient } from '../web/playback-check.js';
import type { Resource } from '../shared/types.js';

const resource = (id: string, episode: string, movieId = 'movie') => ({ id, episode, movieId } as Resource);

test('browsing starts no measurement; playing another line of the same episode reuses the pending check', async () => {
  const requested: string[] = [];
  const releases: (() => void)[] = [];
  const client = new PlaybackCheckClient(async id => {
    requested.push(id);
    await new Promise<void>(resolve => releases.push(resolve));
    return [resource(id, '第1集')];
  });
  assert.deepEqual(requested, [], 'construction and selection are inert until play is requested');
  const first = client.check(resource('a', '第01集'));
  const sameEpisode = client.check(resource('b', '第1集'));
  const next = client.check(resource('c', '第2集'));
  assert.equal(first, sameEpisode);
  assert.notEqual(first, next);
  assert.deepEqual(requested, ['a', 'c'], 'play must start the request immediately without awaiting a video event');
  releases.forEach(release => release());
  await Promise.all([first, sameEpisode, next]);
});

test('completed or failed playback checks can run again on a later play', async () => {
  let calls = 0;
  const client = new PlaybackCheckClient(async () => {
    if (++calls === 1) throw new Error('connection failed');
    return [resource('a', '正片')];
  });
  await assert.rejects(client.check(resource('a', '正片')), /connection failed/);
  assert.equal((await client.check(resource('a', '正片')))[0].id, 'a');
  await client.check(resource('a', '正片'));
  assert.equal(calls, 3);
});
