'use strict';

const { LRUCache } = require('lru-cache');
const metrics = require('./metrics');

/**
 * @param {{ max: number, ttlMs: number, name: string }} opts
 */
function makeLRU(opts) {
  const { max, ttlMs, name } = opts;
  const cache = new LRUCache({
    max,
    ttl: ttlMs,
    updateAgeOnGet: true,
  });

  return {
    get(key) {
      const v = cache.get(key);
      if (v !== undefined) {
        metrics.bumpLru(name, 'hit');
        return v;
      }
      metrics.bumpLru(name, 'miss');
      return undefined;
    },
    set(key, value) {
      cache.set(key, value);
    },
    peek(key) {
      return cache.peek(key);
    },
    get size() {
      return cache.size;
    },
  };
}

module.exports = { makeLRU };
