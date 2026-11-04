import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { upsertMovie } from '../server/catalog.js';
import { initialState, sourceDefaults } from '../server/defaults.js';
import type { Store } from '../server/store.js';
import type { Worker } from '../server/worker.js';
import type { Run } from '../shared/types.js';

test('catalogue, sources and runs return newest creation first without reordering storage', async t => {
  const previousAuth = process.env.APP_AUTH_TOKEN;
  delete process.env.APP_AUTH_TOKEN;
  const state = initialState();
  const older = '2026-11-03T01:00:00.000Z';
  const newer = '2026-11-04T01:00:00.000Z';
  const muchLater = '2026-11-10T01:00:00.000Z';
  const sourceOld = sourceDefaults({ id: 'source-old', name: '较早源', createdAt: older, baseUrl: 'https://fixture.example' });
  const sourceB = sourceDefaults({ id: 'source-b', name: '新源B', createdAt: newer, baseUrl: 'https://fixture.example' });
  const sourceA = sourceDefaults({ id: 'source-a', name: '新源A', createdAt: newer, baseUrl: 'https://fixture.example' });
  state.sources = [sourceOld, sourceB, sourceA];
  const createMovie = (id: string, createdAt: string, updatedAt: string) => {
    const movie = upsertMovie(state, sourceOld, { externalId: id, title: id, pageUrl: 'https://fixture.example/' + id, resources: [] }).movie;
    Object.assign(movie, { id, createdAt, updatedAt });
    return movie;
  };
  const movieOld = createMovie('movie-old', older, muchLater);
  const movieB = createMovie('movie-b', newer, older);
  const movieA = createMovie('movie-a', newer, newer);
  state.movies = [movieOld, movieB, movieA];
  const run = (id: string, startedAt: string, finishedAt: string): Run => ({
    id, sourceId: sourceOld.id, sourceName: sourceOld.name, status: 'success', startedAt, finishedAt,
    scanned: 0, added: 0, updated: 0, resourceCount: 0, errors: [], message: '',
  });
  state.runs = [run('run-old', older, muchLater), run('run-b', newer, older), run('run-a', newer, newer)];
  const store = { state, healthy: true, mode: 'file' } as unknown as Store;
  const server = createApp(store, {} as Worker).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (previousAuth === undefined) delete process.env.APP_AUTH_TOKEN; else process.env.APP_AUTH_TOKEN = previousAuth;
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (pathname: string) => {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = structuredClone(state);
  const first = await get('/api/movies?limit=2&page=1');
  const second = await get('/api/movies?limit=2&page=2');
  assert.deepEqual(first.items.map((movie: { id: string }) => movie.id), ['movie-a', 'movie-b']);
  assert.deepEqual(second.items.map((movie: { id: string }) => movie.id), ['movie-old']);
  assert.deepEqual((await get('/api/sources')).map((source: { id: string }) => source.id), ['source-a', 'source-b', 'source-old']);
  assert.deepEqual((await get('/api/runs')).map((item: Run) => item.id), ['run-a', 'run-b', 'run-old']);
  assert.deepEqual(state, before, 'list requests must not mutate in-memory ordering or records');
  movieOld.updatedAt = '2030-01-01T00:00:00.000Z';
  movieA.updatedAt = older;
  assert.deepEqual((await get('/api/movies')).items.map((movie: { id: string }) => movie.id), ['movie-a', 'movie-b', 'movie-old']);
  state.movies = [movieB, movieOld, movieA];
  assert.deepEqual((await get('/api/movies')).items.map((movie: { id: string }) => movie.id), ['movie-a', 'movie-b', 'movie-old'], 'equal creation times retain a deterministic order across database reloads');
});
