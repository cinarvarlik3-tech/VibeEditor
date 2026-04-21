'use strict';

/**
 * Global cache feature flags (env-driven).
 * CACHE_ENABLED=false disables transcript/render caches.
 * LLM response memoization (POST /generate, visual pipeline, summarize) uses env vars
 * prefixed with LLM_*_CACHE_* — see src/cache/llmResponseCache.js.
 * Proxy LRU + HTTP static maxAge are always safe and stay on.
 */
function cacheTranscriptRenderEnabled() {
  return process.env.CACHE_ENABLED !== 'false';
}

module.exports = { cacheTranscriptRenderEnabled };
