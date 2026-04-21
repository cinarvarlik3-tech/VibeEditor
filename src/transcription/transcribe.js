/**
 * transcribe.js
 * Whisper transcription for Vibe Editor via OpenAI Audio API.
 *
 * POSTs the extracted WAV to /v1/audio/transcriptions (whisper-1,
 * verbose_json + word timestamps) and returns segments in the shape
 * expected by Claude and the Remotion render pipeline.
 *
 * Exports:
 *   transcribeAudio(audioPath, language?) → Promise<Segment[]>
 *
 * Segment shape:
 *   { text: string, startTime: number, endTime: number,
 *     wordTimings: [{ word: string, start: number, end: number }] }
 *
 * Env:
 *   OPENAI_API_KEY        — required
 *   OPENAI_BASE_URL       — optional, default https://api.openai.com/v1
 *   OPENAI_TRANSCRIBE_TIMEOUT_MS — optional HTTP timeout (default 600000)
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
const FormData = require('form-data');

/** OpenAI transcription file limit (bytes). */
const OPENAI_MAX_FILE_BYTES = 25 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 600000;

const LANGUAGE_MAP = {
  turkish: 'tr',
  english: 'en',
  spanish: 'es',
  french:  'fr',
  german:  'de',
};

function transcriptionUrl() {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return `${base}/audio/transcriptions`;
}

/**
 * Maps UI / loose hints to ISO-639-1 for OpenAI.
 * @param {string|null|undefined} language
 * @returns {string|null}
 */
function mapLanguage(language) {
  if (language == null || language === '') return null;
  const key = String(language).trim().toLowerCase();
  if (LANGUAGE_MAP[key]) return LANGUAGE_MAP[key];
  if (/^[a-z]{2}$/i.test(key)) return key.toLowerCase();
  return null;
}

/**
 * Assign each API word to exactly one segment (max time overlap).
 * @param {Array<{ start: number, end: number, word: string }>} words
 * @param {Array<{ start: number, end: number }>} segments
 * @returns {Array<Array<typeof words[0]>>}
 */
function assignWordsToSegments(words, segments) {
  const buckets = segments.map(() => []);
  for (const w of words) {
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const overlap = Math.min(w.end, seg.end) - Math.max(w.start, seg.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestOverlap > 0) buckets[bestIdx].push(w);
  }
  for (const b of buckets) b.sort((a, b) => a.start - b.start);
  return buckets;
}

/**
 * Converts OpenAI TranscriptionVerbose JSON to Vibe Editor segments.
 * @param {object} data
 * @returns {Array<{ text: string, startTime: number, endTime: number, wordTimings: object[] }>}
 */
function normalizeVerboseJson(data) {
  const rawSegments = data.segments || [];
  const words = (data.words || []).map(w => ({
    word:  w.word,
    start: w.start,
    end:   w.end,
  }));

  if (rawSegments.length === 0) {
    const text = (data.text || '').trim();
    const duration = typeof data.duration === 'number' ? data.duration : 0;
    if (!text && words.length === 0) return [];

    const wordTimings = words.length
      ? words.map(w => ({ word: String(w.word || '').trim(), start: w.start, end: w.end }))
      : text
        ? [{ word: text, start: 0, end: duration }]
        : [];

    return [{
      text,
      startTime: 0,
      endTime: duration,
      wordTimings,
    }];
  }

  const wordBuckets = assignWordsToSegments(words, rawSegments);

  return rawSegments.map((seg, i) => {
    const segWords = wordBuckets[i] || [];
    let wordTimings = segWords.map(w => ({
      word:  String(w.word || '').trim(),
      start: w.start,
      end:   w.end,
    }));

    if (wordTimings.length === 0) {
      const t = (seg.text || '').trim();
      if (t) {
        wordTimings = [{ word: t, start: seg.start, end: seg.end }];
      }
    }

    return {
      text:      (seg.text || '').trim(),
      startTime: seg.start,
      endTime:   seg.end,
      wordTimings,
    };
  });
}

/**
 * @param {string}      audioPath  Absolute path to a WAV (e.g. 16 kHz mono from extractAudio)
 * @param {string|null} language   Optional hint: ISO-639-1 or UI name (turkish, english, …)
 * @returns {Promise<Array>}
 */
async function transcribeAudio(audioPath, language = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('transcribeAudio: OPENAI_API_KEY is not set');
  }

  let stat;
  try {
    stat = fs.statSync(audioPath);
  } catch (e) {
    throw new Error(`transcribeAudio: cannot read audio file — ${e.message}`);
  }

  if (stat.size > OPENAI_MAX_FILE_BYTES) {
    throw new Error(
      `transcribeAudio: file exceeds OpenAI limit (${OPENAI_MAX_FILE_BYTES} bytes, got ${stat.size}). ` +
      'Shorten the video or split the audio.'
    );
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), {
    filename: path.basename(audioPath) || 'audio.wav',
    contentType: 'audio/wav',
  });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');

  const isoLang = mapLanguage(language);
  if (isoLang) form.append('language', isoLang);

  const timeoutMs = (() => {
    const raw = process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  })();

  let response;
  try {
    response = await axios.post(transcriptionUrl(), form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${apiKey}`,
      },
      maxBodyLength:   Infinity,
      maxContentLength: Infinity,
      timeout:         timeoutMs,
      validateStatus:  () => true,
    });
  } catch (err) {
    const msg = err.response?.data
      ? safeStringify(err.response.data)
      : err.message;
    throw new Error(`transcribeAudio: OpenAI request failed — ${msg}`);
  }

  if (response.status < 200 || response.status >= 300) {
    const body = safeStringify(response.data);
    throw new Error(`transcribeAudio: OpenAI returned ${response.status} — ${body}`);
  }

  const data = response.data;
  if (!data || typeof data !== 'object') {
    throw new Error('transcribeAudio: unexpected response body');
  }

  return normalizeVerboseJson(data);
}

function safeStringify(x) {
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/**
 * Stable key for transcript cache rows (ISO-639-1 or 'auto' when Whisper auto-detects).
 * @param {string|null|undefined} language
 * @returns {string}
 */
function languageHintForCache(language) {
  const iso = mapLanguage(language);
  return iso || 'auto';
}

module.exports = { transcribeAudio, languageHintForCache };
