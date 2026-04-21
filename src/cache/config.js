'use strict';

/**
 * Global cache feature flags (env-driven).
 * CACHE_ENABLED=false disables Anthropic prompt caching + transcript/render caches.
 * Proxy LRU + HTTP static maxAge are always safe and stay on.
 */
function cacheAnthropicEnabled() {
  return process.env.CACHE_ENABLED !== 'false';
}

function cacheTranscriptRenderEnabled() {
  return process.env.CACHE_ENABLED !== 'false';
}

module.exports = { cacheAnthropicEnabled, cacheTranscriptRenderEnabled };
