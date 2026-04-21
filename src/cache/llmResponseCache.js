'use strict';

/**
 * In-memory LLM response memoization. Keys are SHA-256 of canonical JSON payloads.
 * A disk/Redis backend can replace makeLRU later without changing call sites if the
 * get(key)/set(key,value) contract stays the same.
 */

const { makeLRU } = require('./lru');
const { canonicalStringify, sha256String } = require('./hash');

function envInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : defaultValue;
}

function makeLlmResponseCache(opts) {
  const name = opts && opts.name ? String(opts.name) : 'llm_response';
  const max = envInt(opts && opts.maxEnv, opts && opts.defaultMax != null ? opts.defaultMax : 200);
  const ttlMs = envInt(opts && opts.ttlMsEnv, opts && opts.defaultTtlMs != null ? opts.defaultTtlMs : 5 * 60 * 1000);
  const lru = makeLRU({ max, ttlMs, name });

  return {
    name,
    max,
    ttlMs,
    keyForPayload(payload) {
      return sha256String(canonicalStringify(payload));
    },
    get(key) {
      const v = lru.get(key);
      if (v === undefined) return undefined;
      try {
        return JSON.parse(JSON.stringify(v));
      } catch (_) {
        return v;
      }
    },
    set(key, value) {
      try {
        lru.set(key, JSON.parse(JSON.stringify(value)));
      } catch (_) {
        lru.set(key, value);
      }
    },
  };
}

module.exports = { makeLlmResponseCache };
