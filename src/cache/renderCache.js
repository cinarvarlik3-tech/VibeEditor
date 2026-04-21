'use strict';

const path = require('path');
const fs   = require('fs');
const { canonicalStringify, sha256String } = require('./hash');
const { SERIALIZER_VERSION } = require('../video/serializeToRemotion');
const { cacheTranscriptRenderEnabled } = require('./config');

/**
 * Strip volatile editor state; only fields that affect Remotion output.
 * @param {object} timelineState
 * @returns {object}
 */
function stripForRenderHash(timelineState) {
  if (!timelineState || typeof timelineState !== 'object') return {};
  return {
    tracks: timelineState.tracks || {},
    source: timelineState.source || {},
  };
}

/**
 * @param {object} timelineState
 * @param {{ format: string, quality: string }} renderOpts
 * @returns {string} hex sha256
 */
function computeRenderHash(timelineState, renderOpts) {
  const payload = {
    v:       SERIALIZER_VERSION,
    core:    stripForRenderHash(timelineState),
    format:  renderOpts.format || 'mp4',
    quality: renderOpts.quality || '1080p',
  };
  return sha256String(canonicalStringify(payload));
}

/**
 * @param {string} projectRoot  repo root (parent of src/)
 * @param {string} hash        hex digest
 * @param {string} format      'mp4' | 'mov'
 */
function renderCacheFilePath(projectRoot, hash, format) {
  const ext = format === 'mov' ? '.mov' : '.mp4';
  const dir = path.join(projectRoot, 'output', '_render_cache');
  return path.join(dir, `${hash}${ext}`);
}

function ensureRenderCacheDir(projectRoot) {
  const dir = path.join(projectRoot, 'output', '_render_cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy finished render into content-addressed cache (best-effort).
 */
function saveRenderToCache(projectRoot, hash, format, outputPath) {
  if (!cacheTranscriptRenderEnabled()) return;
  try {
    if (!fs.existsSync(outputPath)) return;
    ensureRenderCacheDir(projectRoot);
    const dest = renderCacheFilePath(projectRoot, hash, format);
    fs.copyFileSync(outputPath, dest);
  } catch (e) {
    console.warn('[renderCache] save failed —', e.message);
  }
}

module.exports = {
  computeRenderHash,
  renderCacheFilePath,
  ensureRenderCacheDir,
  saveRenderToCache,
  stripForRenderHash,
};
