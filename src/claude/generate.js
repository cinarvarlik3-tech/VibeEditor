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

/**
 * buildClipSummary
 * Numbered reference for every videoClip on the timeline (by startTime order).
 * Injected into the Claude user message so the model can resolve clip references.
 *
 * @param {object} tracks  Timeline tracks object { video, subtitle, audio }
 * @returns {string}
 */
function buildClipSummary(tracks) {
  const allClips = [];
  for (const track of tracks.video || []) {
    for (const el of track.elements || []) {
      if (el.type === 'videoClip') {
        allClips.push({ ...el, trackId: track.id, trackIndex: track.index });
      }
    }
  }

  allClips.sort((a, b) => a.startTime - b.startTime);

  if (allClips.length === 0) return 'CLIP_SUMMARY: No video clips on timeline.';

  const lines = allClips.map((clip, i) => {
    const num = i + 1;
    const filename = clip.originalFilename || (clip.src && clip.src.split('/').pop()) || 'unknown';
    const startSec = Number(clip.startTime).toFixed(2);
    const endSec = Number(clip.endTime).toFixed(2);
    const duration = (Number(clip.endTime) - Number(clip.startTime)).toFixed(2);
    const sourceIn = clip.sourceStart != null ? Number(clip.sourceStart).toFixed(2) : '0.00';
    const sourceOut = clip.sourceEnd != null ? Number(clip.sourceEnd).toFixed(2) : duration;
    const speed = clip.playbackRate != null && Number(clip.playbackRate) !== 1.0
      ? ` | speed ${clip.playbackRate}x`
      : '';
    const isImg = clip.isImage ? ' | IMAGE' : '';
    return `Clip ${num}: ${filename} | timeline ${startSec}s–${endSec}s | duration ${duration}s | source ${sourceIn}s–${sourceOut}s | id:${clip.id} | track:${clip.trackId}${speed}${isImg}`;
  });

  return 'CLIP_SUMMARY:\n' + lines.join('\n');
}

/**
 * buildUserTurnContent
 * Single user turn in the format the system prompt expects (PROMPT + state blocks).
 *
 * @param {string}      userPrompt
 * @param {object}      currentTracks
 * @param {Array|null}  transcript
 * @param {number}      sourceDuration
 * @param {Array}       uploadedAudioFiles
 * @returns {string}
 */
function buildUserTurnContent(userPrompt, currentTracks, transcript, sourceDuration, uploadedAudioFiles) {
  return (
    'PROMPT: ' + userPrompt + '\n\n' +
    'CURRENT_TRACKS: ' + JSON.stringify(currentTracks) + '\n\n' +
    'TRANSCRIPT: ' + (transcript ? JSON.stringify(transcript) : 'null') + '\n\n' +
    buildClipSummary(currentTracks) + '\n\n' +
    'SOURCE_DURATION: ' + (sourceDuration || 0) + '\n\n' +
    'CURRENT_UPLOADS: ' + JSON.stringify(uploadedAudioFiles || [])
  );
}

/**
 * isSummaryExchangeRow
 * Rolled-up summary object stored as the first history entry.
 *
 * @param {object} ex
 * @returns {boolean}
 */
function isSummaryExchangeRow(ex) {
  return !!(ex && String(ex.id || '').startsWith('summary-') && ex.summary);
}

/**
 * buildLightUserMessageFromExchange
 * Older turns: PROMPT + CLIP_SUMMARY only (no CURRENT_TRACKS) to bound token usage.
 *
 * @param {object} ex
 * @returns {string}
 */
function buildLightUserMessageFromExchange(ex) {
  const prompt = ex && ex.promptText != null ? String(ex.promptText) : '';
  let clipBlock = '';
  if (ex && ex.clipSummary && String(ex.clipSummary).trim()) {
    clipBlock = String(ex.clipSummary).trim();
  } else if (ex && ex.tracksSnapshot && typeof ex.tracksSnapshot === 'object') {
    clipBlock = buildClipSummary(ex.tracksSnapshot);
  } else {
    clipBlock = 'CLIP_SUMMARY: (not available for this turn; use PROMPT and prior assistant JSON only.)';
  }
  return 'PROMPT: ' + prompt + '\n\n' + clipBlock;
}

/**
 * buildFullUserMessageFromExchange
 * Recent turns: full user turn including CURRENT_TRACKS (same shape as the live prompt).
 *
 * @param {object} ex
 * @returns {string}
 */
function buildFullUserMessageFromExchange(ex) {
  const tracks = ex && ex.tracksSnapshot && typeof ex.tracksSnapshot === 'object' ? ex.tracksSnapshot : {};
  const transcript = ex && ex.transcriptSnapshot !== undefined ? ex.transcriptSnapshot : null;
  const dur = ex && Number(ex.sourceDuration) ? Number(ex.sourceDuration) : 0;
  const prompt = ex && ex.promptText != null ? String(ex.promptText) : '';
  return buildUserTurnContent(prompt, tracks, transcript, dur, []);
}

/**
 * buildHistoryMessagesFromConversationExchanges
 * Builds Anthropic messages[] from structured exchanges; only the last 3 turns include full tracks.
 *
 * @param {Array<object>} exchanges
 * @returns {Array<{role:string,content:string}>}
 */
function buildHistoryMessagesFromConversationExchanges(exchanges) {
  const messages = [];
  if (!Array.isArray(exchanges) || exchanges.length === 0) return messages;

  let body = exchanges;
  if (isSummaryExchangeRow(exchanges[0])) {
    messages.push({
      role:    'user',
      content: 'Here is a summary of our previous editing session:\n' + String(exchanges[0].summary),
    });
    messages.push({
      role:      'assistant',
      content:   'Understood. I have context of the previous edits.',
    });
    body = exchanges.slice(1);
  }

  const maxExchanges = 10;
  const tail = body.length > maxExchanges ? body.slice(-maxExchanges) : body.slice();
  const recentCount = 3;

  for (let index = 0; index < tail.length; index++) {
    const ex = tail[index];
    if (isSummaryExchangeRow(ex)) continue;
    const isRecent = index >= tail.length - recentCount;
    const userContent = isRecent
      ? buildFullUserMessageFromExchange(ex)
      : buildLightUserMessageFromExchange(ex);
    messages.push({ role: 'user', content: userContent });
    messages.push({
      role:      'assistant',
      content:   JSON.stringify(Array.isArray(ex.operations) ? ex.operations : []),
    });
  }
  return messages;
}

const SUMMARY_SYSTEM =
  'You are summarizing a video editing conversation. Respond with plain prose only — no JSON, no markdown code fences, no bullet list unless necessary.';

/**
 * summarizeEditingConversation
 * Separate Claude call to compress the last N editing exchanges into a short summary.
 *
 * @param {Array<{ promptText: string, operations: Array }>} exchanges
 * @returns {Promise<string>}
 */
async function summarizeEditingConversation(exchanges) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) {
    throw new Error('summarizeEditingConversation: exchanges must be a non-empty array');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('summarizeEditingConversation: ANTHROPIC_API_KEY is not set in environment');
  }
  const lines = [];
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i];
    lines.push('Exchange ' + (i + 1) + ':');
    lines.push('User prompt: ' + (ex && ex.promptText != null ? String(ex.promptText) : ''));
    lines.push('Operations: ' + JSON.stringify(ex && Array.isArray(ex.operations) ? ex.operations : []));
    lines.push('');
  }
  const userMsg =
    'Here are the last ' + exchanges.length + ' editing exchanges. Summarize what was ' +
    'done concisely in 3-5 sentences, focusing on: what elements were created or modified, ' +
    'what style decisions were made, and what the current state of the edit is. Be specific ' +
    'about element types, counts, and property values.\n\n' +
    lines.join('\n');

  let response;
  try {
    response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system:     SUMMARY_SYSTEM,
      messages:   [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    throw new Error('summarizeEditingConversation: Claude API call failed — ' + err.message);
  }
  const content = response.content;
  const textBlock = content && content.find(block => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('summarizeEditingConversation: Claude returned no text');
  }
  return textBlock.text.trim();
}

/**
 * collectAllElementIds — every element id on the timeline (all track types).
 *
 * @param {object} tracks
 * @returns {Set<string>}
 */
function collectAllElementIds(tracks) {
  const ids = new Set();
  for (const trackType of Object.keys(tracks)) {
    for (const track of tracks[trackType] || []) {
      for (const el of track.elements || []) {
        if (el && el.id) ids.add(el.id);
      }
    }
  }
  return ids;
}

/**
 * If any operation references a missing elementId, return a warning payload
 * (empty operations). Otherwise null.
 *
 * @param {Array} operations
 * @param {object} currentTracks
 * @returns {{ operations: [], warnings: string[] }|null}
 */
function validateOperationElementRefs(operations, currentTracks) {
  const validIds = collectAllElementIds(currentTracks);
  const OPS_THAT_REFERENCE_ELEMENTS = [
    'UPDATE', 'DELETE', 'ADD_KEYFRAME', 'UPDATE_KEYFRAME',
    'DELETE_KEYFRAME', 'SPLIT_ELEMENT', 'DUPLICATE_ELEMENT',
  ];

  const invalidRefs = [];
  for (const op of operations) {
    if (OPS_THAT_REFERENCE_ELEMENTS.includes(op.op)) {
      const id = op.elementId;
      if (id && !validIds.has(id)) {
        invalidRefs.push({ op: op.op, elementId: id });
      }
    }
  }

  if (invalidRefs.length > 0) {
    const details = invalidRefs
      .map(r => `${r.op} on "${r.elementId}"`)
      .join(', ');
    return {
      operations:     [],
      warnings:       [
        `Claude referenced clip IDs that don't exist on the timeline: ${details}. This can happen if you described a clip by number or name and Claude misidentified it. Try rephrasing with the exact filename or clip number from the timeline.`,
      ],
      isExplanation:  false,
    };
  }
  return null;
}

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
 * @param {Array<object>} conversationExchanges Optional prior structured exchanges (max 10 used); recent 3 include full tracks in user content.
 *
 * @returns {Promise<{operations:Array,warnings?:Array,isExplanation?:boolean}>}
 * @throws  {Error}           Descriptive error if API call fails or response is not valid JSON array.
 */
async function generateOperations(
  userPrompt,
  currentTracks,
  transcript,
  sourceDuration,
  uploadedAudioFiles = [],
  conversationExchanges = []
) {
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('generateOperations: userPrompt must be a non-empty string');
  }
  if (!currentTracks || typeof currentTracks !== 'object') {
    throw new Error('generateOperations: currentTracks must be an object');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('generateOperations: ANTHROPIC_API_KEY is not set in environment');
  }

  const prior = buildHistoryMessagesFromConversationExchanges(
    Array.isArray(conversationExchanges) ? conversationExchanges : []
  );
  const userMessage = buildUserTurnContent(
    userPrompt,
    currentTracks,
    transcript,
    sourceDuration,
    uploadedAudioFiles
  );
  const messages = prior.length > 0 ? [...prior, { role: 'user', content: userMessage }] : [{ role: 'user', content: userMessage }];

  let response;
  try {
    response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system:     SYSTEM_PROMPT,
      messages,
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

  // [] followed by plain-language explanation (e.g. explain-last-change replies)
  if (rawText.startsWith('[]') && rawText.length > 2) {
    const explanation = rawText.slice(2).trim();
    return {
      operations:    [],
      warnings:      explanation ? [explanation] : ['No explanation text after [].'],
      isExplanation: true,
    };
  }

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

  if (!Array.isArray(operations)) {
    throw new Error(
      'generateOperations: Claude response parsed as JSON but is not an array. ' +
      'Got: ' + typeof operations
    );
  }

  // Expand any CREATE_SUBTITLES operations into BATCH_CREATE server-side.
  operations = expandSubtitleOps(operations, transcript);

  const refInvalid = validateOperationElementRefs(operations, currentTracks);
  if (refInvalid) {
    return refInvalid;
  }

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

  return { operations, warnings, isExplanation: false };
}

module.exports = {
  generateOperations,
  summarizeEditingConversation,
  buildClipSummary,
  buildUserTurnContent,
  buildHistoryMessagesFromConversationExchanges,
};
