/**
 * src/claude/generate.js
 *
 * Claude API integration for Vibe Editor.
 * Sends the current timeline state and a user prompt to Claude,
 * and returns a JSON operations array ready to dispatch to timelineReducer.
 *
 * Role in project:
 *   Called by POST /generate in src/server.js.
 *   Replaces the old generateVideoComponent() which returned raw JSX.
 *   Claude now returns structured operations — no JSX, no rendering here.
 */

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { searchAudio }   = require('../assets/audio');

// Initialise Anthropic client once at module load.
const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * expandSubtitleOps
 * Replaces any CREATE_SUBTITLES operation with a single BATCH_CREATE operation
 * by expanding the transcript server-side. Claude may return CREATE_SUBTITLES as
 * a compact fallback (mode + styling template); this function does the mechanical
 * splitting and produces one BATCH_CREATE with template + elements array.
 *
 * Supported segmentation modes:
 *   "sentence" — one element per transcript segment
 *   "word"     — one element per word (uses wordTimings)
 *   "group"    — one element per N consecutive words (uses wordTimings)
 *
 * Falls back to "sentence" if wordTimings are missing across all segments.
 *
 * @param {Array}       operations  Parsed operations array from Claude.
 * @param {Array|null}  transcript  Whisper transcript segments array, or null.
 * @returns {Array}     New operations array with CREATE_SUBTITLES expanded to BATCH_CREATE.
 */
function expandSubtitleOps(operations, transcript) {
  const result = [];
  const segments = transcript || [];

  for (const op of operations) {
    if (op.op !== 'CREATE_SUBTITLES') {
      result.push(op);
      continue;
    }

    const { trackId, segmentation, template } = op;
    const mode = (segmentation && segmentation.mode) || 'sentence';
    const n    = (segmentation && segmentation.n)    || 3;

    // Build the flat list of { text, startTime, endTime } items.
    let items = [];

    if (mode === 'sentence') {
      items = segments.map(seg => ({
        text:      seg.text,
        startTime: seg.startTime,
        endTime:   seg.endTime,
      }));
    } else {
      // Flatten wordTimings across all segments.
      const allWords = [];
      for (const seg of segments) {
        if (seg.wordTimings && seg.wordTimings.length > 0) {
          for (const w of seg.wordTimings) {
            allWords.push({ ...w, _segEndTime: seg.endTime });
          }
        }
      }

      // If no segments have wordTimings, fall back to sentence mode.
      if (allWords.length === 0) {
        items = segments.map(seg => ({
          text:      seg.text,
          startTime: seg.startTime,
          endTime:   seg.endTime,
        }));
      } else if (mode === 'word') {
        items = allWords.map((w, i) => ({
          text:      w.word,
          startTime: w.start,
          endTime:   w.end || (allWords[i + 1] ? allWords[i + 1].start : w._segEndTime),
        }));
      } else if (mode === 'group') {
        for (let i = 0; i < allWords.length; i += n) {
          const chunk = allWords.slice(i, i + n);
          const last  = chunk[chunk.length - 1];
          items.push({
            text:      chunk.map(w => w.word).join(' '),
            startTime: chunk[0].start,
            endTime:   last.end || (allWords[i + n] ? allWords[i + n].start : last._segEndTime),
          });
        }
      }
    }

    // Build the elements array for a single BATCH_CREATE operation.
    const batchElements = [];
    const baseMs = Date.now();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.text || !item.text.trim()) continue;
      if (item.startTime >= item.endTime) item.endTime = item.startTime + 0.1;

      batchElements.push({
        id:        `elem_s_${baseMs + i}_${Math.random().toString(36).substr(2, 4)}`,
        startTime: item.startTime,
        endTime:   item.endTime,
        text:      item.text,
      });
    }

    if (batchElements.length > 0) {
      result.push({
        op:       'BATCH_CREATE',
        trackId:  trackId,
        template: {
          type:      'subtitle',
          style:     template.style,
          position:  template.position,
          animation: template.animation,
        },
        elements: batchElements,
      });
    }
  }

  return result;
}

/**
 * generateOperations
 * Calls Claude with the current timeline state and user prompt.
 * Returns a validated JSON operations array.
 *
 * @param {string}      userPrompt     Natural-language edit instruction from the user.
 * @param {object}      currentTracks  The tracks object from the current timeline state.
 * @param {Array|null}  transcript     Whisper transcript array, or null if not yet transcribed.
 * @param {number}      sourceDuration Total source video duration in seconds.
 *
 * @returns {Promise<Array>}  Parsed operations array, e.g. [{ op: "CREATE", ... }]
 * @throws  {Error}           Descriptive error if API call fails or response is not valid JSON array.
 */
async function generateOperations(userPrompt, currentTracks, transcript, sourceDuration, uploadedAudioFiles = []) {
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('generateOperations: userPrompt must be a non-empty string');
  }
  if (!currentTracks || typeof currentTracks !== 'object') {
    throw new Error('generateOperations: currentTracks must be an object');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('generateOperations: ANTHROPIC_API_KEY is not set in environment');
  }

  // Construct the user message in the exact format the system prompt expects.
  const userMessage =
    'PROMPT: ' + userPrompt + '\n\n' +
    'CURRENT_TRACKS: ' + JSON.stringify(currentTracks) + '\n\n' +
    'TRANSCRIPT: ' + (transcript ? JSON.stringify(transcript) : 'null') + '\n\n' +
    'SOURCE_DURATION: ' + (sourceDuration || 0) + '\n\n' +
    'CURRENT_UPLOADS: ' + JSON.stringify(uploadedAudioFiles || []);

  let response;
  try {
    response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    throw new Error('generateOperations: Claude API call failed — ' + err.message);
  }

  // Extract text content from the response.
  const content = response.content;
  if (!content || content.length === 0) {
    throw new Error('generateOperations: Claude returned an empty response');
  }

  const textBlock = content.find(block => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('generateOperations: Claude response contained no text block');
  }

  const rawText = textBlock.text.trim();

  // Parse as JSON — response must be a valid JSON array.
  let operations;
  try {
    operations = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      'generateOperations: Claude response is not valid JSON.\n' +
      'Parse error: ' + err.message + '\n' +
      'Response starts with: ' + rawText.substring(0, 200)
    );
  }

  // Expand any CREATE_SUBTITLES operations into BATCH_CREATE server-side.
  operations = expandSubtitleOps(operations, transcript);

  // Validate BATCH_CREATE operations before dispatching to reducer.
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== 'BATCH_CREATE') continue;

    if (!op.trackId || typeof op.trackId !== 'string') {
      throw new Error(
        'generateOperations: BATCH_CREATE at index ' + i + ' is missing a valid trackId'
      );
    }
    if (!op.template || typeof op.template !== 'object') {
      throw new Error(
        'generateOperations: BATCH_CREATE at index ' + i + ' is missing a valid template object'
      );
    }
    if (!Array.isArray(op.elements) || op.elements.length === 0) {
      throw new Error(
        'generateOperations: BATCH_CREATE at index ' + i + ' has empty or missing elements array'
      );
    }
    for (let j = 0; j < op.elements.length; j++) {
      const elem = op.elements[j];
      if (!elem.id)                     throw new Error('generateOperations: BATCH_CREATE[' + i + '].elements[' + j + '] missing id');
      if (elem.startTime === undefined) throw new Error('generateOperations: BATCH_CREATE[' + i + '].elements[' + j + '] missing startTime');
      if (elem.endTime === undefined)   throw new Error('generateOperations: BATCH_CREATE[' + i + '].elements[' + j + '] missing endTime');
      if (elem.text === undefined)      throw new Error('generateOperations: BATCH_CREATE[' + i + '].elements[' + j + '] missing text');
    }
  }

  if (!Array.isArray(operations)) {
    throw new Error(
      'generateOperations: Claude response parsed as JSON but is not an array. ' +
      'Got: ' + typeof operations
    );
  }

  // Validate keyframe and split operations produced by Claude.
  const VALID_KF_TRACKS  = new Set(['scale', 'opacity']);
  const VALID_KF_EASINGS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']);

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (op.op === 'ADD_KEYFRAME') {
      if (!op.elementId || typeof op.elementId !== 'string') {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' missing valid elementId');
      }
      if (!VALID_KF_TRACKS.has(op.trackName)) {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' has invalid trackName "' + op.trackName + '"');
      }
      if (!op.keyframe || typeof op.keyframe !== 'object') {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' missing keyframe object');
      }
      if (typeof op.keyframe.time !== 'number' || op.keyframe.time < 0) {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' keyframe.time must be a non-negative number');
      }
      if (typeof op.keyframe.value !== 'number') {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' keyframe.value must be a number');
      }
      if (op.keyframe.easing && !VALID_KF_EASINGS.has(op.keyframe.easing)) {
        throw new Error('generateOperations: ADD_KEYFRAME at index ' + i + ' invalid easing "' + op.keyframe.easing + '"');
      }
    }

    if (op.op === 'UPDATE_KEYFRAME') {
      if (!op.elementId || typeof op.elementId !== 'string') {
        throw new Error('generateOperations: UPDATE_KEYFRAME at index ' + i + ' missing valid elementId');
      }
      if (!VALID_KF_TRACKS.has(op.trackName)) {
        throw new Error('generateOperations: UPDATE_KEYFRAME at index ' + i + ' has invalid trackName "' + op.trackName + '"');
      }
      if (typeof op.index !== 'number' || op.index < 0) {
        throw new Error('generateOperations: UPDATE_KEYFRAME at index ' + i + ' missing valid index');
      }
      if (!op.changes || typeof op.changes !== 'object') {
        throw new Error('generateOperations: UPDATE_KEYFRAME at index ' + i + ' missing changes object');
      }
      if (op.changes.easing && !VALID_KF_EASINGS.has(op.changes.easing)) {
        throw new Error('generateOperations: UPDATE_KEYFRAME at index ' + i + ' invalid changes.easing "' + op.changes.easing + '"');
      }
    }

    if (op.op === 'DELETE_KEYFRAME') {
      if (!op.elementId || typeof op.elementId !== 'string') {
        throw new Error('generateOperations: DELETE_KEYFRAME at index ' + i + ' missing valid elementId');
      }
      if (!VALID_KF_TRACKS.has(op.trackName)) {
        throw new Error('generateOperations: DELETE_KEYFRAME at index ' + i + ' has invalid trackName "' + op.trackName + '"');
      }
      if (typeof op.index !== 'number' || op.index < 0) {
        throw new Error('generateOperations: DELETE_KEYFRAME at index ' + i + ' missing valid index');
      }
    }

    if (op.op === 'SPLIT_ELEMENT') {
      if (!op.elementId || typeof op.elementId !== 'string') {
        throw new Error('generateOperations: SPLIT_ELEMENT at index ' + i + ' missing valid elementId');
      }
      if (typeof op.splitTime !== 'number' || op.splitTime <= 0) {
        throw new Error('generateOperations: SPLIT_ELEMENT at index ' + i + ' splitTime must be a positive number');
      }
    }

    if (op.op === 'REORDER_TRACK') {
      if (!op.trackType || typeof op.trackType !== 'string') {
        throw new Error('generateOperations: REORDER_TRACK at index ' + i + ' missing valid trackType');
      }
      if (typeof op.fromIndex !== 'number' || op.fromIndex < 0) {
        throw new Error('generateOperations: REORDER_TRACK at index ' + i + ' missing valid fromIndex');
      }
      if (typeof op.toIndex !== 'number' || op.toIndex < 0) {
        throw new Error('generateOperations: REORDER_TRACK at index ' + i + ' missing valid toIndex');
      }
    }
  }

  // ── Resolve SEARCH_AUDIO operations into CREATE operations ──────────────
  // Claude returns SEARCH_AUDIO when it cannot supply a real audio URL.
  // We call the audio search APIs here (server-side) and replace each
  // SEARCH_AUDIO with a concrete CREATE operation, or drop it if no
  // results are found, so the caller always receives standard operations.
  const warnings = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== 'SEARCH_AUDIO') continue;

    const sources   = Array.isArray(op.sources) ? op.sources : ['freesound', 'jamendo'];
    const query     = op.query || '';
    const placement = op.placement || {};

    try {
      const results = await searchAudio(query, sources, 3);

      if (results.length > 0) {
        const result  = results[0];
        const newId   = 'elem_a_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
        operations[i] = {
          op:      'CREATE',
          trackId: 'track_audio_0',
          element: {
            id:         newId,
            type:       'audioClip',
            startTime:  typeof placement.startTime === 'number' ? placement.startTime : 0,
            endTime:    typeof placement.endTime   === 'number' ? placement.endTime   : (sourceDuration || 30),
            src:        result.previewUrl,
            volume:     typeof placement.volume  === 'number' ? placement.volume  : 0.5,
            fadeIn:     typeof placement.fadeIn  === 'number' ? placement.fadeIn  : 1.0,
            fadeOut:    typeof placement.fadeOut === 'number' ? placement.fadeOut : 1.0,
            sourceName: result.source + ': ' + result.name,
            sourceType: result.source,
          },
        };
      } else {
        console.warn('generateOperations: SEARCH_AUDIO — no results for "' + query + '", removing operation');
        warnings.push('Audio search returned no results for "' + query + '" — try different keywords');
        operations.splice(i, 1);
        i--;
      }
    } catch (err) {
      console.warn('generateOperations: SEARCH_AUDIO resolution failed —', err.message);
      warnings.push('Audio search failed: ' + err.message);
      operations.splice(i, 1);
      i--;
    }
  }

  return { operations, warnings };
}

module.exports = { generateOperations };
