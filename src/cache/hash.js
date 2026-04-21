'use strict';

const crypto = require('crypto');
const fs     = require('fs');

/**
 * Deterministic JSON for hashing (sorted object keys).
 * @param {unknown} value
 * @returns {string}
 */
function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    out[k] = sortKeysDeep(v[k]);
  }
  return out;
}

/**
 * @param {string} filePath
 * @returns {Promise<string>} hex sha256
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256String(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

module.exports = {
  canonicalStringify,
  sha256File,
  sha256String,
};
