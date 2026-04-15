/**
 * src/assets/audio.js
 *
 * Standalone audio search module for Vibe Editor.
 * Provides normalized search wrappers for Freesound and Pixabay.
 *
 * Used by:
 *   - src/server.js  (Express endpoints)
 *   - src/claude/generate.js  (SEARCH_AUDIO operation resolution)
 *
 * All functions return a normalized result array. On API error they log a
 * warning and return [] rather than throwing, so callers can always proceed
 * with whatever subset of results is available.
 */

'use strict';

require('dotenv').config();
const axios = require('axios');

// ---------------------------------------------------------------------------
// Freesound
// ---------------------------------------------------------------------------

/**
 * searchFreesound
 * Searches the Freesound API v2 for CC0-licensed sound effects and music.
 *
 * @param {string} query      Search terms.
 * @param {number} pageSize   Max results to return (default 6).
 * @returns {Promise<Array>}  Normalized result objects, or [] on error.
 *
 * Result shape:
 *   { id, name, duration, previewUrl, license, source: 'freesound' }
 */
async function searchFreesound(query, pageSize = 6) {
  const apiKey = process.env.FREESOUND_API_KEY;
  if (!apiKey) {
    console.warn('searchFreesound: FREESOUND_API_KEY is not set — skipping');
    return [];
  }

  try {
    const response = await axios.get('https://freesound.org/apiv2/search/text/', {
      params: {
        query,
        token:     apiKey,
        fields:    'id,name,duration,previews,license,tags',
        filter:    'license:"Creative Commons 0"',
        page_size: pageSize,
      },
      timeout: 8000,
    });

    const results = (response.data && response.data.results) || [];
    return results.map(r => ({
      id:         String(r.id),
      name:       r.name || 'Untitled',
      duration:   r.duration || 0,
      previewUrl: r.previews && r.previews['preview-hq-mp3'] ? r.previews['preview-hq-mp3'] : null,
      license:    r.license  || 'Creative Commons 0',
      source:     'freesound',
    })).filter(r => r.previewUrl);

  } catch (err) {
    console.warn('searchFreesound: API call failed —', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Jamendo
// ---------------------------------------------------------------------------

/**
 * searchJamendo
 * Searches the Jamendo API v3.0 for Creative Commons licensed music tracks.
 *
 * @param {string} query      Search terms.
 * @param {number} pageSize   Max results to return (default 6).
 * @returns {Promise<Array>}  Normalized result objects, or [] on error.
 *
 * Result shape:
 *   { id, name, duration, previewUrl, license, source: 'jamendo' }
 */
async function searchJamendo(query, pageSize = 6) {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) {
    console.warn('searchJamendo: JAMENDO_CLIENT_ID is not set — skipping');
    return [];
  }

  try {
    const response = await axios.get('https://api.jamendo.com/v3.0/tracks/', {
      params: {
        client_id:   clientId,
        format:      'json',
        limit:       pageSize,
        search:      query,
        audioformat: 'mp32',
      },
      timeout: 8000,
    });

    const data = response.data || {};

    if (data.headers && data.headers.status === 'failed') {
      console.warn('searchJamendo: API error —', data.headers.error_message || 'unknown error');
      return [];
    }

    const results = data.results || [];
    return results.map(r => ({
      id:         String(r.id),
      name:       (r.name || 'Untitled') + (r.artist_name ? ' — ' + r.artist_name : ''),
      duration:   r.duration || 0,
      previewUrl: r.audio || null,
      license:    r.license_ccurl || 'Creative Commons',
      source:     'jamendo',
    })).filter(r => r.previewUrl);

  } catch (err) {
    console.warn('searchJamendo: API call failed —', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

/**
 * searchAudio
 * Calls Freesound and/or Pixabay in parallel and interleaves the results.
 * One source failing does not prevent the other from returning results.
 *
 * @param {string}   query     Search terms.
 * @param {string[]} sources   Which APIs to query, default ['freesound','pixabay'].
 * @param {number}   pageSize  Results per source (default 3, so ~6 total).
 * @returns {Promise<Array>}   Interleaved normalized results.
 */
async function searchAudio(query, sources = ['freesound', 'jamendo'], pageSize = 20) {
  const tasks = [];
  if (sources.includes('freesound')) tasks.push(searchFreesound(query, pageSize));
  else                                tasks.push(Promise.resolve([]));
  if (sources.includes('jamendo'))   tasks.push(searchJamendo(query, pageSize));
  else                                tasks.push(Promise.resolve([]));

  const [fsResults, jmResults] = await Promise.all(tasks);

  // Interleave: fs[0], jm[0], fs[1], jm[1], ...
  const merged = [];
  const maxLen = Math.max(fsResults.length, jmResults.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < fsResults.length) merged.push(fsResults[i]);
    if (i < jmResults.length) merged.push(jmResults[i]);
  }
  return merged;
}

module.exports = { searchFreesound, searchJamendo, searchAudio };
