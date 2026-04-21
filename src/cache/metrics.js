'use strict';

/**
 * In-process counters for cache observability (GET /status?debug=cache).
 */
const counts = {
  transcriptHit:   0,
  transcriptMiss: 0,
  renderHit:       0,
  renderMiss:      0,
  lru:             {}, // name -> { hit, miss }
};

function bumpLru(name, kind) {
  if (!counts.lru[name]) counts.lru[name] = { hit: 0, miss: 0 };
  counts.lru[name][kind] += 1;
}

function snapshot() {
  return JSON.parse(JSON.stringify(counts));
}

function reset() {
  counts.transcriptHit = 0;
  counts.transcriptMiss = 0;
  counts.renderHit = 0;
  counts.renderMiss = 0;
  counts.lru = {};
}

module.exports = {
  counts,
  bumpLru,
  snapshot,
  reset,
};
