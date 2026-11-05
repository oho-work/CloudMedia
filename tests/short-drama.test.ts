import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHtmlMovie } from '../server/collector.js';
import { sourceDefaults } from '../server/defaults.js';

test('a source short-drama category is archived separately from television series', () => {
  const movie = parseHtmlMovie('<h1>短剧样本</h1><nav class="breadcrumb"><a>首页</a><a>短剧</a></nav><div class="module-info-tag-link">2026</div>', sourceDefaults(), 'https://example.com/voddetail/1');
  assert.equal(movie?.type, '短剧');
  const tagged = parseHtmlMovie('<h1>短剧样本</h1><div class="module-info-tag-link">2026</div><div class="module-info-tag-link">中国大陆</div><div class="module-info-tag-link"><a>短剧</a></div>', sourceDefaults(), 'https://example.com/voddetail/2');
  assert.equal(tagged?.type, '短剧');
});
