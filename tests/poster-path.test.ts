import test from 'node:test';
import assert from 'node:assert/strict';
import { localPosterPath } from '../shared/poster-path.js';

const digest = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('local poster paths retain each supported archived image format', () => {
  for (const extension of ['jpg', 'png', 'webp', 'avif', 'gif']) {
    const path = `/media/posters/${digest}.${extension}`;
    assert.equal(localPosterPath(path), path);
  }
});

test('remote image URLs cannot be used as poster sources', () => {
  for (const value of [
    'https://images.example/poster.jpg',
    `https://images.example/media/posters/${digest}.jpg`,
    '//images.example/poster.jpg',
    'data:image/png;base64,aGVsbG8=',
    'blob:https://images.example/poster',
    'javascript:alert(1)',
  ]) assert.equal(localPosterPath(value), '', value);
});

test('poster paths reject traversal, malformed names and appended URL components', () => {
  for (const value of [
    '', '/media/posters/../private.jpg', `/media/posters/%2e%2e/${digest}.jpg`,
    `/media/posters/${digest}/../${digest}.jpg`, `/media/posters/${digest}.svg`,
    `/media/posters/${digest.slice(1)}.jpg`, `/media/posters/${digest}0.jpg`,
    `/media/posters/${digest.toUpperCase()}.jpg`, `/media/posters/${digest}.JPG`,
    `/media/posters/${digest}.jpg?url=https://images.example/poster.jpg`,
    `/media/posters/${digest}.jpg#poster`, `/media/posters/${digest}.jpg/extra`,
    ` /media/posters/${digest}.jpg`, `/media/posters/${digest}.jpg\n`,
    `/media/posters/${digest}.jpg\u0000`, `/media\\posters\\${digest}.jpg`,
  ]) assert.equal(localPosterPath(value), '', JSON.stringify(value));
});
