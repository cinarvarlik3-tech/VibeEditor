/**
 * src/claude/generate.js
 *
 * OpenAI API integration for Vibe Editor.
 * Sends the current timeline state and a user prompt to the model,
 * and returns a JSON operations array ready to dispatch to timelineReducer.
 *
 * Role in project:
 *   Called by POST /generate in src/server.js.
 *   Replaces the old generateVideoComponent() which returned raw JSX.
 *   The model returns structured operations — no JSX, no rendering here.
 */

'use strict';

require('dotenv').config();
const { OpenAI, APIError } = require('openai');
const {
  SYSTEM_PROMPT,
  VISUAL_COMPONENT_RULES,
  SYSTEM_PROMPT_VERSION,
  buildSystemPrompt,
} = require('./systemPrompt');
const { VISUAL_PICK_PROMPT_TEMPLATE } = require('./visualComponentRules');
const { searchAudio } = require('../assets/audio');
const { canonicalStringify } = require('../cache/hash');
const metrics = require('../cache/metrics');

const log = (...args) => console.log('[generate]', ...args);

function envFeature(name, defaultTrue = true) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultTrue;
  return String(v).toLowerCase() !== 'false';
}

const MODEL_FLAGSHIP = process.env.OPENAI_MODEL_FLAGSHIP || 'gpt-5.4';
const MODEL_MINI = process.env.OPENAI_MODEL_MINI || 'gpt-5.4-mini';
const MODEL_NANO = process.env.OPENAI_MODEL_NANO || 'gpt-5.4-nano';

const FEATURE_MODEL_ROUTING = envFeature('FEATURE_MODEL_ROUTING', true);
const FEATURE_TRANSCRIPT_WINDOWING = envFeature('FEATURE_TRANSCRIPT_WINDOWING', true);
const FEATURE_HISTORY_SUMMARIES = envFeature('FEATURE_HISTORY_SUMMARIES', true);
const FEATURE_PROMPT_BUNDLES = envFeature('FEATURE_PROMPT_BUNDLES', true);
const FEATURE_MINIMAL_HISTORY = process.env.FEATURE_MINIMAL_HISTORY !== 'false';

const MODEL_FOR_GENERATE = FEATURE_MODEL_ROUTING ? MODEL_MINI : MODEL_FLAGSHIP;
const MODEL_FOR_SUMMARIZE = FEATURE_MODEL_ROUTING ? MODEL_NANO : MODEL_FLAGSHIP;
const MODEL_FOR_VISUAL_SCAN = FEATURE_MODEL_ROUTING ? MODEL_MINI : MODEL_FLAGSHIP;
const MODEL_FOR_VISUAL_BRIEF = FEATURE_MODEL_ROUTING ? MODEL_MINI : MODEL_FLAGSHIP;
const MODEL_FOR_VISUAL_PICK = FEATURE_MODEL_ROUTING ? MODEL_NANO : MODEL_FLAGSHIP;

// Expanded keyword classifier. Bias toward OVER-triggering — the cost of
// including an unneeded bundle is a few hundred extra tokens; the cost of
// missing a needed bundle is the model failing on the prompt entirely.

const CLIP_KEYWORDS = /\b(clip|clips|first|second|third|fourth|fifth|last|previous|next|the\s+one|the\s+video|shortest|longest|fastest|slowest|all\s+clips|every\s+clip|each\s+clip|track\s+\d)\b/i;

const SUBTITLE_KEYWORDS = /\b(subtitle|subtitles|caption|captions|text|words|word\s+by\s+word|font|bold|italic|normal|regular|bigger|smaller|color|colour|red|blue|green|yellow|white|black|purple|orange|pink|gold|outline|shadow|glow|uppercase|lowercase|align|position|top|bottom|middle|center|corner|sentence|sentences|per\s+word)\b/i;

const ANIMATION_KEYWORDS = /\b(animat|fade|fades|keyframe|transition|opacity|zoom|scale|pan|slide|slow\s+motion|speed|faster|slower|playback|trim|cut|split|gradually|smoothly|instantly|\d+x|half\s+speed|double\s+speed)\b/i;

const AUDIO_KEYWORDS = /\b(audio|sound|music|volume|quiet|quieter|loud|louder|mute|unmute|fade\s+in|fade\s+out|background\s+music|sound\s+effect|ambient|song|soundtrack|freesound|jamendo|uploaded\s+audio|my\s+audio|my\s+music|my\s+sound)\b/i;

const IMAGE_KEYWORDS = /\b(image|images|picture|pictures|photo|photos|overlay|overlays|anchor|layout|fit|cover|contain|fullscreen|image\s+clip)\b/i;

const TRACK_KEYWORDS = /\b(track|tracks|layer|layers|on\s+top|above|below|behind|in\s+front|foreground|background|reorder|rearrange|swap\s+track|move\s+track|delete\s+track|remove\s+track|new\s+track|add\s+track|create\s+track)\b/i;

const CONVERSATION_REFERENCE_KEYWORDS =
  /\b(undo|revert|go\s+back|same|do\s+the\s+same|same\s+thing|repeat|again|that|those|them|the\s+ones|keep\s+going|continue|add\s+more|what\s+did\s+you|start\s+over|clear\s+everything|start\s+fresh)\b/i;

/**
 * Returns true if the current user prompt references prior exchanges in a way
 * that requires historical state (not just summaries) to resolve.
 *
 * @param {string} userPrompt
 * @returns {boolean}
 */
function promptNeedsFullHistorySnapshot(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return false;
  return CONVERSATION_REFERENCE_KEYWORDS.test(userPrompt);
}

/**
 * @param {string} userPrompt
 * @returns {string[]} bundle ids — subset of:
 *   'animations' | 'audio' | 'clips' | 'conversation' | 'images' |
 *   'subtitles' | 'tracks'
 */
function selectRuleBundles(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return [];
  const p = userPrompt.toLowerCase();
  const bundles = new Set();

  if (CLIP_KEYWORDS.test(p)) bundles.add('clips');
  if (SUBTITLE_KEYWORDS.test(p)) bundles.add('subtitles');
  if (ANIMATION_KEYWORDS.test(p)) bundles.add('animations');
  if (AUDIO_KEYWORDS.test(p)) bundles.add('audio');
  if (IMAGE_KEYWORDS.test(p)) bundles.add('images');
  if (TRACK_KEYWORDS.test(p)) bundles.add('tracks');
  if (CONVERSATION_REFERENCE_KEYWORDS.test(p)) bundles.add('conversation');

  // If the prompt looks like a styling request but didn't trigger subtitles,
  // err on the side of including it — styling is the single most common task.
  const looksLikeStyling = /\b(make|change|set|turn).*\b(bigger|smaller|bold|italic|normal|red|blue|green|yellow|white|black|color|font|size)\b/i.test(userPrompt);
  if (looksLikeStyling && !bundles.has('subtitles')) bundles.add('subtitles');

  return Array.from(bundles);
}

/**
 * @param {Array|null|undefined} fullTranscript
 * @param {string} userPrompt
 * @param {{ windowSeconds?: number }} [opts]
 * @returns {{ mode: string, segments: Array } | null}
 */
function selectTranscriptWindow(fullTranscript, userPrompt, opts) {
  const opt = opts || {};
  const segs = Array.isArray(fullTranscript) ? fullTranscript : [];
  if (segs.length === 0) return null;

  if (!FEATURE_TRANSCRIPT_WINDOWING) {
    return { mode: 'full-words', segments: segs };
  }

  const p = String(userPrompt || '');
  const needsWordLevel = /\b(subtitle|caption|word|sync|per\s+word)\b/i.test(p);
  const needsNoTranscript =
    /\b(reorder|swap|move|trim|split|delete|remove|duplicate)\b/i.test(p) &&
    !/\b(say|said|when\s+they|the\s+part\s+where)\b/i.test(p);

  if (needsNoTranscript) return { mode: 'none', segments: [] };
  if (needsWordLevel) return { mode: 'full-words', segments: segs };

  const tsMatch = p.match(/\b(?:at\s+)?(\d+):(\d+)\b/);
  const startMatch = /\b(start|beginning|intro)\b/i.test(p);
  const endMatch = /\b(end|ending|outro|last)\b/i.test(p);

  let windowCenter = null;
  if (tsMatch) {
    windowCenter = parseInt(tsMatch[1], 10) * 60 + parseInt(tsMatch[2], 10);
  } else if (startMatch) {
    windowCenter = 0;
  } else if (endMatch) {
    const last = segs[segs.length - 1];
    const et = last && (last.endTime != null ? last.endTime : last.end);
    windowCenter = typeof et === 'number' ? et : 0;
  }

  if (windowCenter !== null) {
    const w = typeof opt.windowSeconds === 'number' && opt.windowSeconds > 0 ? opt.windowSeconds : 15;
    const filtered = segs.filter(s => {
      const st = s.startTime != null ? s.startTime : s.start;
      const et = s.endTime != null ? s.endTime : s.end;
      if (typeof st !== 'number' || typeof et !== 'number') return false;
      return et >= windowCenter - w && st <= windowCenter + w;
    });
    return {
      mode:         'window',
      segments:     filtered,
      windowCenter,
      windowRadius: w,
    };
  }

  return {
    mode: 'coarse',
    segments: segs.map(s => ({
      startTime: Math.round((s.startTime != null ? s.startTime : s.start) * 10) / 10,
      endTime:   Math.round((s.endTime != null ? s.endTime : s.end) * 10) / 10,
      text:      s.text || '',
    })),
  };
}

/**
 * @param {Array} operations
 * @returns {string}
 */
function summarizeOpsForHistory(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return 'No operations applied.';
  const counts = {};
  const details = [];

  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const name = op.op;
    if (typeof name === 'string') counts[name] = (counts[name] || 0) + 1;

    if (name === 'CREATE' && op.element) {
      const t = op.element.type || 'unknown';
      const id = op.element.id || '';
      details.push(`created ${t}${id ? ' (' + id + ')' : ''}`);
    } else if (name === 'BATCH_CREATE' && Array.isArray(op.elements)) {
      const templateType = op.template && op.template.type ? op.template.type : 'elements';
      const ids = op.elements.map((e) => e && e.id).filter(Boolean);
      if (ids.length <= 4) {
        details.push(`created ${ids.length} ${templateType}(s): ${ids.join(', ')}`);
      } else {
        // Show first 2 and last 2 for ID range recognition without blowing up the summary
        details.push(
          `created ${ids.length} ${templateType}(s): ${ids[0]}, ${ids[1]}, …, ${ids[ids.length - 2]}, ${ids[ids.length - 1]}`
        );
      }
    } else if (name === 'CREATE_SUBTITLES') {
      // Server expands this to BATCH_CREATE at runtime; element IDs aren't known here.
      details.push('created subtitles (ids assigned at dispatch)');
    } else if (name === 'UPDATE' && op.elementId) {
      // Include which fields changed — often the reason for the update is in the change keys
      const changedKeys =
        op.changes && typeof op.changes === 'object' ? Object.keys(op.changes).slice(0, 3).join(',') : '';
      details.push(`updated ${op.elementId}${changedKeys ? ' [' + changedKeys + ']' : ''}`);
    } else if (name === 'DELETE' && op.elementId) {
      details.push(`deleted ${op.elementId}`);
    } else if (name === 'ADD_KEYFRAME' && op.elementId) {
      details.push(`keyframed ${op.trackName || 'track'} on ${op.elementId}`);
    } else if (name === 'SPLIT_ELEMENT' && op.elementId) {
      details.push(`split ${op.elementId} at ${op.splitTime}s`);
    } else if (name === 'CREATE_TRACK' && op.trackType) {
      details.push(`created ${op.trackType} track`);
    } else if (name === 'DELETE_TRACK' && op.trackId) {
      details.push(`deleted track ${op.trackId}`);
    } else if (name === 'REORDER_TRACK') {
      details.push(`reordered ${op.trackType || 'track'} ${op.fromIndex}→${op.toIndex}`);
    } else if (name === 'SEARCH_AUDIO') {
      details.push(`searched audio: "${String(op.query || '').slice(0, 40)}"`);
    } else if (typeof name === 'string') {
      details.push(name);
    }
  }

  const countSummary = Object.entries(counts).map(([t, n]) => n + '×' + t).join(', ');
  const det = details.slice(0, 10).join('; ');
  return `Applied ${operations.length} op(s): ${countSummary}. Details: ${det}${details.length > 10 ? '…' : ''}`;
}

/**
 * @param {string} rawText
 * @returns {{ valid: boolean, reason?: string, isExplanation?: boolean, operations?: Array }}
 */
function parseAndValidateOperationsJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return { valid: false, reason: 'empty' };
  const stripped = stripMarkdownJsonFence(rawText);
  if (stripped.startsWith('[]') && stripped.length > 2) {
    return { valid: true, isExplanation: true, operations: [] };
  }
  let operations;
  try {
    operations = JSON.parse(stripped);
  } catch (e) {
    return { valid: false, reason: 'json: ' + e.message };
  }
  if (!Array.isArray(operations)) return { valid: false, reason: 'not array' };
  for (let i = 0; i < operations.length; i++) {
    const row = operations[i];
    if (!row || typeof row !== 'object') return { valid: false, reason: 'op ' + i + ' not object' };
    const opName = row.op;
    if (typeof opName !== 'string' || !VALID_MODEL_OPERATION_OPS.has(opName)) {
      return { valid: false, reason: 'bad op at ' + i };
    }
  }
  return { valid: true, isExplanation: false, operations };
}

/**
 * Known operation names accepted from the model (reducer + server-side expansion).
 */
const VALID_MODEL_OPERATION_OPS = new Set([
  'CREATE', 'UPDATE', 'DELETE', 'CREATE_TRACK', 'DELETE_TRACK', 'BATCH_CREATE',
  'ADD_KEYFRAME', 'UPDATE_KEYFRAME', 'DELETE_KEYFRAME', 'SPLIT_ELEMENT', 'REORDER_TRACK',
  'SEARCH_AUDIO', 'CREATE_SUBTITLES',
]);

/**
 * Read a numeric field from usage (SDK may expose snake_case or camelCase).
 * @param {object} u
 * @param {string} camelKey
 * @param {string} snakeKey
 * @returns {number}
 */
function pickUsageNumber(u, camelKey, snakeKey) {
  if (!u || typeof u !== 'object') return NaN;
  if (u[camelKey] != null && u[camelKey] !== '') {
    const n = Number(u[camelKey]);
    if (Number.isFinite(n)) return n;
  }
  if (u[snakeKey] != null && u[snakeKey] !== '') {
    const n = Number(u[snakeKey]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/**
 * Normalized usage for JSON responses + UI (matches server "REAL token usage" log).
 * OpenAI: prompt_tokens / completion_tokens / total_tokens.
 * Exposes cache* fields as 0 for compatibility with the existing AgentPanel display.
 * @param {object|null|undefined} resp
 * @returns {{ inputTokens:number, outputTokens:number, totalTokens:number, cacheCreationInputTokens:number, cacheReadInputTokens:number }|null}
 */
function usageFromChatCompletionResponse(resp) {
  const u = resp && resp.usage;
  if (!u || typeof u !== 'object') return null;
  const inTok = pickUsageNumber(u, 'promptTokens', 'prompt_tokens');
  const outTok = pickUsageNumber(u, 'completionTokens', 'completion_tokens');
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const totalFromApi = pickUsageNumber(u, 'totalTokens', 'total_tokens');
  // OpenAI reports automatic prompt-cache hits inside prompt_tokens_details.cached_tokens.
  // These are part of prompt_tokens but billed at a lower rate.
  const details = u.prompt_tokens_details || u.promptTokensDetails || {};
  const cachedIn = pickUsageNumber(details, 'cachedTokens', 'cached_tokens');
  return {
    inputTokens:              inTok,
    outputTokens:             outTok,
    totalTokens:              Number.isFinite(totalFromApi) ? totalFromApi : inTok + outTok,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens:     Number.isFinite(cachedIn) ? cachedIn : 0,
  };
}

function formatOpenAIError(err) {
  if (err instanceof APIError) {
    const status = err.status != null ? String(err.status) : '';
    const req = err.message || String(err);
    return status ? `OpenAI API error ${status}: ${req}` : `OpenAI API error: ${req}`;
  }
  return err && err.message ? err.message : String(err);
}

/**
 * Strip optional markdown code fences and trim (models sometimes wrap JSON).
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownJsonFence(text) {
  if (typeof text !== 'string') return '';
  let raw = text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return raw.trim();
}

/**
 * Ensure each parsed operation has a recognized `op` before decompression.
 * @param {unknown} operations
 */
function validateParsedOperationOps(operations) {
  if (!Array.isArray(operations)) return;
  for (let i = 0; i < operations.length; i++) {
    const row = operations[i];
    if (!row || typeof row !== 'object') {
      throw new Error('generateOperations: operation at index ' + i + ' is not an object');
    }
    const opName = row.op;
    if (typeof opName !== 'string' || !VALID_MODEL_OPERATION_OPS.has(opName)) {
      throw new Error(
        'generateOperations: unknown or missing op at index ' + i + ': ' +
        JSON.stringify(opName)
      );
    }
  }
}

function messageContentToString(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
      try {
        return JSON.stringify(block);
      } catch (_) {
        return '';
      }
    }).join('');
  }
  try {
    return JSON.stringify(content);
  } catch (_) {
    return '';
  }
}

/** Chars÷4 — observability only (aligns with estimateTokens message side). */
function approxTokensForMessageContent(content) {
  return Math.ceil(messageContentToString(content).length / 4);
}

function approxTokensForSystemPrompt(systemPrompt) {
  if (systemPrompt == null || typeof systemPrompt !== 'string') return 0;
  return Math.ceil(systemPrompt.length / 4);
}

/**
 * Segment breakdown before chat.completions.create (system vs history vs current user turn).
 * @param {string} callSite
 * @param {string} systemPrompt
 * @param {Array<{role:string,content?:unknown}>} messages
 * @param {{ bundles?: string[], transcriptMode?: string|null, transcriptSegments?: number|null, historyTurnCount?: number|null }} [meta]
 */
function recordCallBreakdown(callSite, systemPrompt, messages, meta = {}) {
  const systemTokens = approxTokensForSystemPrompt(systemPrompt);
  let historyTokens = 0;
  let currentTurnTokens = 0;
  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = 0; i < messages.length - 1; i++) {
      historyTokens += approxTokensForMessageContent(messages[i].content);
    }
    currentTurnTokens = approxTokensForMessageContent(messages[messages.length - 1].content);
  }
  const total = systemTokens + historyTokens + currentTurnTokens;

  let bundlePart = '';
  if (Array.isArray(meta.bundles)) {
    bundlePart = ` | bundles: ${meta.bundles.length ? meta.bundles.join(',') : 'core-only'}`;
  }
  let trPart = '';
  if (meta.transcriptMode != null) {
    trPart = ` | transcript: ${meta.transcriptMode}`;
    if (meta.transcriptSegments != null) trPart += ` (${meta.transcriptSegments} segs)`;
  }
  const turnsPart = meta.historyTurnCount != null ? ` | turns: ${meta.historyTurnCount}` : '';

  console.log(
    `[${callSite}] breakdown — system: ${systemTokens} | history: ${historyTokens} | current: ${currentTurnTokens} | total_est: ${total}` +
      bundlePart +
      trPart +
      turnsPart
  );

  metrics.recordSample(`${callSite}_systemTokens`, systemTokens);
  metrics.recordSample(`${callSite}_historyTokens`, historyTokens);
  metrics.recordSample(`${callSite}_currentTurnTokens`, currentTurnTokens);
  metrics.recordSample(`${callSite}_estTotalTokens`, total);

  return { systemTokens, historyTokens, currentTurnTokens, total };
}

function recordUsageSamples(callSite, usage) {
  if (!usage || typeof usage !== 'object') return;
  const inT = Number(usage.inputTokens);
  const outT = Number(usage.outputTokens);
  const cIn = Number(usage.cacheReadInputTokens) || 0;
  if (!Number.isFinite(inT) || !Number.isFinite(outT)) return;
  metrics.recordSample(`${callSite}_realInputTokens`, inT);
  metrics.recordSample(`${callSite}_realOutputTokens`, outT);
  metrics.recordSample(`${callSite}_realCachedTokens`, cIn);
  const ratio = inT > 0 ? cIn / inT : 0;
  metrics.recordSample(`${callSite}_cacheHitRatio`, ratio);
}

function recordGenerateRoutingOutcome(fallbackUsed) {
  if (fallbackUsed) {
    metrics.counts.routingRequestFallback = (metrics.counts.routingRequestFallback || 0) + 1;
  } else {
    metrics.counts.routingRequestSuccess = (metrics.counts.routingRequestSuccess || 0) + 1;
  }
}

function deepCloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Track compression (Claude input only) ─────────────────────────────────

function omitKeys(obj, keysToOmit) {
  if (!obj || typeof obj !== 'object') return {};
  const out = { ...obj };
  for (const k of keysToOmit) delete out[k];
  return out;
}

function compressKeyframePoint(kf) {
  if (!kf || typeof kf !== 'object') return kf;
  const pt = {};
  if (kf.time !== undefined) pt.ti = kf.time;
  if (kf.value !== undefined) pt.vl = kf.value;
  if (kf.easing !== undefined) pt.ea = kf.easing;
  return pt;
}

function compressVideoKeyframes(kfRoot) {
  if (!kfRoot || typeof kfRoot !== 'object') return kfRoot;
  const out = {};
  if (Array.isArray(kfRoot.scale)) {
    out.sc = kfRoot.scale.map(compressKeyframePoint);
  }
  if (Array.isArray(kfRoot.opacity)) {
    out.op = kfRoot.opacity.map(compressKeyframePoint);
  }
  return out;
}

function compressSubtitleStyle(style) {
  if (!style || typeof style !== 'object') return {};
  const stripped = omitKeys(style, [
    'textShadow', 'letterSpacing', 'backgroundColor', 'padding', 'borderRadius',
  ]);
  const out = {};
  if (stripped.fontFamily !== undefined) out.ff = stripped.fontFamily;
  if (stripped.fontSize !== undefined) out.fs = stripped.fontSize;
  if (stripped.fontWeight !== undefined) out.fw = stripped.fontWeight;
  if (stripped.fontStyle !== undefined) out.fi = stripped.fontStyle;
  if (stripped.textTransform !== undefined) out.tt = stripped.textTransform;
  if (stripped.textAlign !== undefined) out.ta = stripped.textAlign;
  if (stripped.color !== undefined) out.c = stripped.color;
  if (stripped.effect !== undefined) out.fx = stripped.effect && typeof stripped.effect === 'object'
    ? { ...stripped.effect }
    : stripped.effect;
  return out;
}

function stripAnimInOutDuration(anim) {
  if (!anim || typeof anim !== 'object') return anim;
  const out = { ...anim };
  if (out.in && typeof out.in === 'object') {
    out.in = omitKeys(out.in, ['duration']);
  }
  if (out.out && typeof out.out === 'object') {
    out.out = omitKeys(out.out, ['duration']);
  }
  return out;
}

function compressSubtitleElement(el) {
  const pos = el.position && typeof el.position === 'object'
    ? { x: el.position.x, y: el.position.y }
    : {};
  const an = el.animation ? stripAnimInOutDuration(deepCloneJson(el.animation)) : el.animation;
  return {
    id: el.id,
    st: el.startTime,
    et: el.endTime,
    tp: 'subtitle',
    tx: el.text,
    s:  compressSubtitleStyle(el.style || {}),
    p:  pos,
    an,
  };
}

function compressVideoElement(el) {
  const stripped = omitKeys(el, ['storageRef', 'imageDuration', 'isImage', 'src']);
  const out = {
    id: stripped.id,
    st: stripped.startTime,
    et: stripped.endTime,
    tp: 'videoClip',
  };
  if (stripped.playbackRate !== undefined) out.pr = stripped.playbackRate;
  if (stripped.volume !== undefined) out.v = stripped.volume;
  if (stripped.sourceStart !== undefined) out.ss = stripped.sourceStart;
  if (stripped.sourceEnd !== undefined) out.se = stripped.sourceEnd;
  if (stripped.originalFilename !== undefined) out.fn = stripped.originalFilename;
  if (stripped.keyframes) out.kf = compressVideoKeyframes(stripped.keyframes);
  return out;
}

function compressAudioElement(el) {
  const stripped = omitKeys(el, ['storageRef', 'src']);
  const out = {
    id: stripped.id,
    st: stripped.startTime,
    et: stripped.endTime,
    tp: 'audioClip',
  };
  if (stripped.volume !== undefined) out.v = stripped.volume;
  if (stripped.fadeIn !== undefined) out.fi = stripped.fadeIn;
  if (stripped.fadeOut !== undefined) out.fo = stripped.fadeOut;
  if (stripped.sourceName !== undefined) out.sn = stripped.sourceName;
  if (stripped.sourceType !== undefined) out.st_ = stripped.sourceType;
  return out;
}

/**
 * Compact imageLayout for Claude (CURRENT_TRACKS). Same coordinate space as UI:
 * 1080×1920, origin at frame center; anchor is box center.
 */
function compressImageLayoutForClaude(il) {
  const d = { layoutMode: 'fullscreen', anchor: { x: 0, y: 0 }, box: { width: 1080, height: 1920 }, lockAspect: false };
  const src = il && typeof il === 'object' ? il : {};
  const lm = src.layoutMode === 'custom' ? 'custom' : 'fullscreen';
  const ax = src.anchor && typeof src.anchor.x === 'number' ? src.anchor.x : d.anchor.x;
  const ay = src.anchor && typeof src.anchor.y === 'number' ? src.anchor.y : d.anchor.y;
  const bw = src.box && typeof src.box.width === 'number' ? src.box.width : d.box.width;
  const bh = src.box && typeof src.box.height === 'number' ? src.box.height : d.box.height;
  const out = { lm, ax, ay, bw, bh };
  if (src.lockAspect) out.la = true;
  return out;
}

function decompressImageLayout(il) {
  if (!il || typeof il !== 'object') return undefined;
  const layoutMode = il.lm === 'custom' || il.layoutMode === 'custom' ? 'custom' : 'fullscreen';
  return {
    layoutMode,
    anchor: {
      x: typeof il.ax === 'number' ? il.ax : (il.anchor && typeof il.anchor.x === 'number' ? il.anchor.x : 0),
      y: typeof il.ay === 'number' ? il.ay : (il.anchor && typeof il.anchor.y === 'number' ? il.anchor.y : 0),
    },
    box: {
      width: typeof il.bw === 'number' ? il.bw : (il.box && typeof il.box.width === 'number' ? il.box.width : 1080),
      height: typeof il.bh === 'number' ? il.bh : (il.box && typeof il.box.height === 'number' ? il.box.height : 1920),
    },
    lockAspect: !!(il.la || il.lockAspect),
  };
}

function compressImageClipElement(el) {
  const stripped = omitKeys(el, [
    'storageRef',
    'pixabayId',
    'nativePayload',
    'src',
    'imageLayout',
    'intrinsicAspect',
  ]);
  const out = {
    id: stripped.id,
    st: stripped.startTime,
    et: stripped.endTime,
    tp: 'imageClip',
  };
  out.il = compressImageLayoutForClaude(el.imageLayout);
  if (stripped.originalFilename !== undefined) out.fn = stripped.originalFilename;
  if (stripped.sourceName !== undefined) out.sn = stripped.sourceName;
  if (stripped.sourceType !== undefined) out.st_ = stripped.sourceType;
  if (stripped.isImage !== undefined) out.ii = stripped.isImage;
  if (stripped.opacity !== undefined) out.opv = stripped.opacity;
  if (stripped.volume !== undefined) out.v = stripped.volume;
  if (stripped.fitMode !== undefined) out.fm = stripped.fitMode;
  if (stripped.keyframes) out.kf = compressVideoKeyframes(stripped.keyframes);
  return out;
}

function compressElement(el) {
  if (!el || typeof el !== 'object') return el;
  if (el.type === 'subtitle') return compressSubtitleElement(el);
  if (el.type === 'videoClip') return compressVideoElement(el);
  if (el.type === 'audioClip') return compressAudioElement(el);
  if (el.type === 'imageClip') return compressImageClipElement(el);
  return deepCloneJson(el);
}

function compressTrack(track) {
  if (!track || typeof track !== 'object') return track;
  return {
    id:       track.id,
    index:    track.index,
    name:     track.name,
    elements: (track.elements || []).map(compressElement),
  };
}

/**
 * compressTracks — pure; returns compressed timeline tracks for Claude.
 * @param {object} tracks
 * @returns {object}
 */
function compressTracks(tracks) {
  const raw = deepCloneJson(tracks || {});
  const out = {};
  for (const kind of ['video', 'subtitle', 'audio', 'image']) {
    if (!Array.isArray(raw[kind])) continue;
    out[kind] = raw[kind].map(compressTrack);
  }
  return out;
}

const SUBTITLE_TRACK_KEYWORDS = [
  'subtitle', 'caption', 'text', 'font', 'size', 'color', 'bold', 'italic', 'animation',
  'slide', 'pop', 'typewriter', 'outline', 'shadow', 'glow', 'box', 'uppercase', 'position',
  'align', 'center', 'bottom', 'top',
];
const SUBTITLE_PHRASES = ['word by word', 'fade in', 'fade out'];

const VIDEO_KEYWORDS = [
  'clip', 'video', 'zoom', 'scale', 'speed', 'slow', 'fast', 'trim', 'cut', 'split',
  'keyframe', 'opacity', 'source', 'playback', 'second', 'gradual', 'instant',
  'remove section', 'keep only',
];

const AUDIO_TRACK_KEYWORDS = [
  'audio', 'music', 'sound', 'track', 'volume', 'lofi', 'ambient', 'beat',
  'background', 'jamendo', 'freesound', 'upload', 'song', 'instrumental',
];

function promptMatchesAnyKeyword(promptLower, list) {
  for (const kw of list) {
    if (promptLower.includes(kw)) return true;
  }
  return false;
}

/**
 * selectRelevantTracks — returns a subset of track-type keys based on prompt.
 * Never returns an empty object when input has data (falls back to all types).
 */
function selectRelevantTracks(tracks, prompt) {
  if (!tracks || typeof tracks !== 'object') return tracks;
  const p = String(prompt || '').toLowerCase();
  const words = p.split(/\s+/).filter(Boolean);

  if (words.length < 3) {
    return deepCloneJson(tracks);
  }

  let wantSub = false;
  let wantVid = false;
  let wantAud = false;

  if (/\bfade\b|fade\s*in|fade\s*out/i.test(p)) {
    wantSub = true;
    wantAud = true;
  }

  for (const ph of SUBTITLE_PHRASES) {
    if (p.includes(ph)) wantSub = true;
  }
  if (promptMatchesAnyKeyword(p, SUBTITLE_TRACK_KEYWORDS)) wantSub = true;
  if (promptMatchesAnyKeyword(p, VIDEO_KEYWORDS)) wantVid = true;
  if (promptMatchesAnyKeyword(p, AUDIO_TRACK_KEYWORDS)) wantAud = true;

  if (!wantSub && !wantVid && !wantAud) {
    return deepCloneJson(tracks);
  }

  const out = {};
  if (wantSub && Array.isArray(tracks.subtitle)) out.subtitle = deepCloneJson(tracks.subtitle);
  if (wantVid && Array.isArray(tracks.video)) out.video = deepCloneJson(tracks.video);
  if (wantAud && Array.isArray(tracks.audio)) out.audio = deepCloneJson(tracks.audio);

  if (Object.keys(out).length === 0) {
    return deepCloneJson(tracks);
  }
  return out;
}

function promptNeedsFullTrackTypes(prompt) {
  const p = String(prompt || '');
  return /\b(undo|revert|go\s+back|redo|explain|what\s+did\s+you(\s+do)?)\b/i.test(p);
}

/**
 * Safe compress + optional selection for Claude payloads.
 * @param {object} rawTracks
 * @param {string} prompt
 * @param {{ skipSelection?: boolean }} opts
 */
function prepareTracksForClaude(rawTracks, prompt, opts) {
  try {
    const compressed = compressTracks(rawTracks);
    if (opts && opts.skipSelection) return compressed;
    if (promptNeedsFullTrackTypes(prompt)) return compressed;
    return selectRelevantTracks(compressed, prompt);
  } catch (err) {
    console.warn('[generate] compress/select failed, using raw tracks —', err.message);
    return rawTracks;
  }
}

// ── Operation decompression (Claude output → reducer) ─────────────────────

const UPDATE_CHANGE_KEY_MAP = {
  's.fs': 'style.fontSize',
  's.fw': 'style.fontWeight',
  's.fi': 'style.fontStyle',
  's.c':  'style.color',
  's.ff': 'style.fontFamily',
  's.tt': 'style.textTransform',
  's.ta': 'style.textAlign',
  's.fx.type':  'style.effect.type',
  's.fx.color': 'style.effect.color',
  'p.x':  'position.x',
  'p.y':  'position.y',
  'an.in.type':  'animation.in.type',
  'an.out.type': 'animation.out.type',
  'an.in.duration':  'animation.in.duration',
  'an.out.duration': 'animation.out.duration',
  'tx': 'text',
  'pr': 'playbackRate',
  'v':  'volume',
  'ss': 'sourceStart',
  'se': 'sourceEnd',
  'fn': 'originalFilename',
  'st': 'startTime',
  'et': 'endTime',
  'tp': 'type',
  'fi': 'fadeIn',
  'fo': 'fadeOut',
  'sn': 'sourceName',
  'st_': 'sourceType',
  'il.ax': 'imageLayout.anchor.x',
  'il.ay': 'imageLayout.anchor.y',
  'il.bw': 'imageLayout.box.width',
  'il.bh': 'imageLayout.box.height',
  'il.lm': 'imageLayout.layoutMode',
  'il.la': 'imageLayout.lockAspect',
};

function mapUpdateChangeDotKey(key) {
  if (typeof key !== 'string') return key;
  if (UPDATE_CHANGE_KEY_MAP[key]) return UPDATE_CHANGE_KEY_MAP[key];
  let k = key;
  k = k.replace(/^kf\.sc\.(\d+)\.ti\b/, 'keyframes.scale.$1.time');
  k = k.replace(/^kf\.sc\.(\d+)\.vl\b/, 'keyframes.scale.$1.value');
  k = k.replace(/^kf\.sc\.(\d+)\.ea\b/, 'keyframes.scale.$1.easing');
  k = k.replace(/^kf\.op\.(\d+)\.ti\b/, 'keyframes.opacity.$1.time');
  k = k.replace(/^kf\.op\.(\d+)\.vl\b/, 'keyframes.opacity.$1.value');
  k = k.replace(/^kf\.op\.(\d+)\.ea\b/, 'keyframes.opacity.$1.easing');
  return k;
}

function decompressUpdateChanges(changes) {
  if (!changes || typeof changes !== 'object') return changes;
  const out = {};
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'il' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.imageLayout = decompressImageLayout(v);
      continue;
    }
    out[mapUpdateChangeDotKey(k)] = v;
  }
  return out;
}

const STYLE_COMP_TO_FULL = {
  ff: 'fontFamily', fs: 'fontSize', fw: 'fontWeight', fi: 'fontStyle',
  tt: 'textTransform', ta: 'textAlign', c: 'color', fx: 'effect',
};

function decompressStyleObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.fontFamily !== undefined || obj.fontSize !== undefined) return { ...obj };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = STYLE_COMP_TO_FULL[k] || k;
    out[nk] = v;
  }
  return out;
}

function decompressKeyframePoint(pt) {
  if (!pt || typeof pt !== 'object') return pt;
  if (pt.time !== undefined || pt.value !== undefined) return { ...pt };
  const out = {};
  if (pt.ti !== undefined) out.time = pt.ti;
  if (pt.vl !== undefined) out.value = pt.vl;
  if (pt.ea !== undefined) out.easing = pt.ea;
  return out;
}

function decompressVideoKeyframes(kf) {
  if (!kf || typeof kf !== 'object') return kf;
  if (kf.scale || kf.opacity) return kf;
  const out = {};
  if (Array.isArray(kf.sc)) out.scale = kf.sc.map(decompressKeyframePoint);
  if (Array.isArray(kf.op)) out.opacity = kf.op.map(decompressKeyframePoint);
  return out;
}

function decompressSubtitleLikeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.tp || obj.type;
  if (t && t !== 'subtitle') return obj;
  if (obj.style && !obj.s) return { ...obj };

  const out = {};
  if (obj.id != null) out.id = obj.id;
  out.type = 'subtitle';
  if (obj.startTime != null || obj.st != null) {
    out.startTime = obj.startTime != null ? obj.startTime : obj.st;
  }
  if (obj.endTime != null || obj.et != null) {
    out.endTime = obj.endTime != null ? obj.endTime : obj.et;
  }
  if (obj.text != null || obj.tx != null) {
    out.text = obj.text != null ? obj.text : obj.tx;
  }
  out.style = decompressStyleObject(obj.s || obj.style || {});
  out.position = { ...(obj.p || obj.position || {}) };
  if (obj.an || obj.animation) {
    out.animation = deepCloneJson(obj.an || obj.animation);
  }
  return out;
}

function decompressVideoLikeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.tp || obj.type;
  if (t && t !== 'videoClip') return obj;
  if (obj.keyframes && !obj.kf) return { ...obj };

  const out = {};
  for (const k of Object.keys(obj)) {
    if (['tp', 'st', 'et', 'pr', 'v', 'ss', 'se', 'fn', 'kf'].includes(k)) continue;
    out[k] = obj[k];
  }
  out.type = 'videoClip';
  if (obj.startTime != null || obj.st != null) {
    out.startTime = obj.startTime != null ? obj.startTime : obj.st;
  }
  if (obj.endTime != null || obj.et != null) {
    out.endTime = obj.endTime != null ? obj.endTime : obj.et;
  }
  if (obj.playbackRate != null || obj.pr != null) {
    out.playbackRate = obj.playbackRate != null ? obj.playbackRate : obj.pr;
  }
  if (obj.volume != null || obj.v != null) {
    out.volume = obj.volume != null ? obj.volume : obj.v;
  }
  if (obj.sourceStart != null || obj.ss != null) {
    out.sourceStart = obj.sourceStart != null ? obj.sourceStart : obj.ss;
  }
  if (obj.sourceEnd != null || obj.se != null) {
    out.sourceEnd = obj.sourceEnd != null ? obj.sourceEnd : obj.se;
  }
  if (obj.originalFilename || obj.fn) {
    out.originalFilename = obj.originalFilename || obj.fn;
  }
  if (obj.kf) out.keyframes = decompressVideoKeyframes(obj.kf);
  else if (obj.keyframes) out.keyframes = deepCloneJson(obj.keyframes);
  return out;
}

function decompressImageClipLikeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.tp || obj.type;
  if (t && t !== 'imageClip') return obj;
  if (obj.type === 'imageClip' && obj.imageLayout && !obj.tp) return { ...obj };

  const out = {};
  for (const k of Object.keys(obj)) {
    if (['tp', 'st', 'et', 'ii', 'opv', 'v', 'fm', 'kf', 'fn', 'sn', 'st_', 'il'].includes(k)) continue;
    out[k] = obj[k];
  }
  out.type = 'imageClip';
  if (obj.id != null) out.id = obj.id;
  if (obj.startTime != null || obj.st != null) {
    out.startTime = obj.startTime != null ? obj.startTime : obj.st;
  }
  if (obj.endTime != null || obj.et != null) {
    out.endTime = obj.endTime != null ? obj.endTime : obj.et;
  }
  if (obj.isImage != null || obj.ii != null) {
    out.isImage = obj.isImage != null ? obj.isImage : obj.ii;
  }
  if (obj.opacity != null || obj.opv != null) {
    out.opacity = obj.opacity != null ? obj.opacity : obj.opv;
  }
  if (obj.volume != null || obj.v != null) {
    out.volume = obj.volume != null ? obj.volume : obj.v;
  }
  if (obj.fitMode != null || obj.fm != null) {
    out.fitMode = obj.fitMode != null ? obj.fitMode : obj.fm;
  }
  if (obj.originalFilename || obj.fn) {
    out.originalFilename = obj.originalFilename || obj.fn;
  }
  if (obj.sourceName || obj.sn) {
    out.sourceName = obj.sourceName || obj.sn;
  }
  if (obj.sourceType != null || obj.st_ != null) {
    out.sourceType = obj.sourceType != null ? obj.sourceType : obj.st_;
  }
  if (obj.kf) out.keyframes = decompressVideoKeyframes(obj.kf);
  else if (obj.keyframes) out.keyframes = deepCloneJson(obj.keyframes);
  if (obj.il || obj.imageLayout) {
    out.imageLayout = decompressImageLayout(obj.il || obj.imageLayout);
  }
  return out;
}

function decompressAudioLikeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.tp || obj.type;
  if (t && t !== 'audioClip') return obj;
  const compressed = obj.tp === 'audioClip' || (obj.st_ !== undefined && t !== 'imageClip');
  if (!compressed && obj.type === 'audioClip') return { ...obj };

  const out = {};
  for (const k of Object.keys(obj)) {
    if (['tp', 'st', 'et', 'v', 'fi', 'fo', 'sn', 'st_'].includes(k)) continue;
    out[k] = obj[k];
  }
  out.type = 'audioClip';
  if (obj.startTime != null || obj.st != null) {
    out.startTime = obj.startTime != null ? obj.startTime : obj.st;
  }
  if (obj.endTime != null || obj.et != null) {
    out.endTime = obj.endTime != null ? obj.endTime : obj.et;
  }
  if (obj.volume != null || obj.v != null) {
    out.volume = obj.volume != null ? obj.volume : obj.v;
  }
  if (obj.fadeIn != null || obj.fi != null) {
    out.fadeIn = obj.fadeIn != null ? obj.fadeIn : obj.fi;
  }
  if (obj.fadeOut != null || obj.fo != null) {
    out.fadeOut = obj.fadeOut != null ? obj.fadeOut : obj.fo;
  }
  if (obj.sourceName || obj.sn) {
    out.sourceName = obj.sourceName || obj.sn;
  }
  if (obj.sourceType != null || obj.st_ != null) {
    out.sourceType = obj.sourceType != null ? obj.sourceType : obj.st_;
  }
  return out;
}

function decompressCreateElement(el) {
  if (!el || typeof el !== 'object') return el;
  const t = el.tp || el.type;
  if (t === 'subtitle' || (el.s && !el.style)) return decompressSubtitleLikeBody(el);
  if (t === 'imageClip') return decompressImageClipLikeBody(el);
  if (t === 'videoClip' || (el.kf && !el.keyframes)) return decompressVideoLikeBody(el);
  if (t === 'audioClip' || el.st_ != null) return decompressAudioLikeBody(el);
  return el;
}

function decompressBatchTemplate(tpl) {
  if (!tpl || typeof tpl !== 'object') return tpl;
  const o = decompressSubtitleLikeBody(tpl);
  return o;
}

function decompressBatchElementPatch(el) {
  if (!el || typeof el !== 'object') return el;
  const o = { ...el };
  if (o.st !== undefined) { o.startTime = o.startTime !== undefined ? o.startTime : o.st; delete o.st; }
  if (o.et !== undefined) { o.endTime = o.endTime !== undefined ? o.endTime : o.et; delete o.et; }
  if (o.tx !== undefined) { o.text = o.text !== undefined ? o.text : o.tx; delete o.tx; }
  return o;
}

function decompressKeyframeChangesFlat(ch) {
  if (!ch || typeof ch !== 'object') return ch;
  const out = { ...ch };
  if (out.ti !== undefined) { out.time = out.time !== undefined ? out.time : out.ti; delete out.ti; }
  if (out.vl !== undefined) { out.value = out.value !== undefined ? out.value : out.vl; delete out.vl; }
  if (out.ea !== undefined) { out.easing = out.easing !== undefined ? out.easing : out.ea; delete out.ea; }
  return out;
}

/**
 * decompressOperations — expand compressed keys from Claude before reducer.
 * @param {Array<object>} operations
 * @returns {Array<object>}
 */
function decompressOperations(operations) {
  if (!Array.isArray(operations)) return operations;
  return operations.map(op => {
    if (!op || typeof op !== 'object') return op;
    const out = { ...op };
    switch (op.op) {
      case 'UPDATE':
        if (op.changes) out.changes = decompressUpdateChanges(op.changes);
        break;
      case 'UPDATE_KEYFRAME':
        if (op.changes) out.changes = decompressKeyframeChangesFlat(op.changes);
        break;
      case 'ADD_KEYFRAME':
        if (op.keyframe) out.keyframe = decompressKeyframePoint(op.keyframe);
        break;
      case 'CREATE':
        if (op.element) out.element = decompressCreateElement(op.element);
        break;
      case 'BATCH_CREATE':
        if (op.template) out.template = decompressBatchTemplate(op.template);
        if (Array.isArray(op.elements)) {
          out.elements = op.elements.map(decompressBatchElementPatch);
        }
        break;
      case 'CREATE_SUBTITLES':
        if (op.template) out.template = decompressBatchTemplate(op.template);
        break;
      default:
        break;
    }
    return out;
  });
}

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
 * @param {object}      tracksForCurrentTracksJson  Serialized into CURRENT_TRACKS (may be compressed / selected).
 * @param {Array|null|object}  transcript  Full transcript array, or null, or { mode, segments } from selectTranscriptWindow.
 * @param {number}      sourceDuration
 * @param {Array}       uploadedAudioFiles
 * @param {object}      [tracksForClipSummary]       Full timeline for CLIP_SUMMARY (defaults to tracksForCurrentTracksJson).
 * @param {{ useCanonicalJson?: boolean }} [opts]
 * @returns {string}
 */
function buildUserTurnContent(
  userPrompt,
  tracksForCurrentTracksJson,
  transcript,
  sourceDuration,
  uploadedAudioFiles,
  tracksForClipSummary,
  opts
) {
  const useCanon = opts && opts.useCanonicalJson === true;
  const j = useCanon ? canonicalStringify : (v) => JSON.stringify(v);
  const clipSrc =
    tracksForClipSummary != null && typeof tracksForClipSummary === 'object'
      ? tracksForClipSummary
      : tracksForCurrentTracksJson;

  /** @type {object|null} */
  let transcriptPayload = null;
  if (transcript == null) {
    transcriptPayload = null;
  } else if (Array.isArray(transcript)) {
    transcriptPayload = selectTranscriptWindow(transcript, userPrompt, {});
    log(
      `transcript mode: ${transcriptPayload ? transcriptPayload.mode : 'none'}, segments: ` +
      (transcriptPayload && transcriptPayload.segments ? transcriptPayload.segments.length : 0)
    );
  } else if (typeof transcript === 'object') {
    transcriptPayload = transcript;
  }

  const transStr = transcriptPayload == null ? 'null' : j(transcriptPayload);

  return (
    'PROMPT: ' + userPrompt + '\n\n' +
    'CURRENT_TRACKS: ' + j(tracksForCurrentTracksJson) + '\n\n' +
    'TRANSCRIPT: ' + transStr + '\n\n' +
    buildClipSummary(clipSrc) + '\n\n' +
    'SOURCE_DURATION: ' + (sourceDuration || 0) + '\n\n' +
    'CURRENT_UPLOADS: ' + j(uploadedAudioFiles || [])
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
 * buildStrippedUserMessageFromExchange
 * Older turns: PROMPT + CLIP_SUMMARY only (no CURRENT_TRACKS / TRANSCRIPT / uploads).
 * Uses persisted clipSummary only — no full tracks JSON (token savings).
 *
 * @param {object} ex
 * @returns {string}
 */
function buildStrippedUserMessageFromExchange(ex) {
  const prompt = ex && ex.promptText != null ? String(ex.promptText) : '';

  // When minimal history is enabled, past user turns carry only the prompt.
  // CLIP_SUMMARY and tracks from a past turn are stale by the next turn anyway
  // (the current turn's CURRENT_TRACKS is ground truth). The assistant's
  // enriched summary carries the element IDs needed for reference resolution.
  if (FEATURE_MINIMAL_HISTORY) {
    return 'PROMPT: ' + prompt;
  }

  // Legacy behavior (FEATURE_MINIMAL_HISTORY=false): keep CLIP_SUMMARY.
  const raw = ex && ex.clipSummary != null ? String(ex.clipSummary).trim() : '';
  if (raw) {
    if (/^CLIP_SUMMARY:/i.test(raw)) {
      return 'PROMPT: ' + prompt + '\n\n' + raw;
    }
    return 'PROMPT: ' + prompt + '\n\n' + 'CLIP_SUMMARY:\n' + raw;
  }
  return 'PROMPT: ' + prompt + '\n\n' + 'CLIP_SUMMARY:\n' + 'N/A';
}

/**
 * buildFullUserMessageFromExchange
 * Recent turns: full user turn including CURRENT_TRACKS (same shape as the live prompt).
 *
 * @param {object} ex
 * @returns {string}
 */
function buildFullUserMessageFromExchange(ex) {
  const rawTracks = ex && ex.tracksSnapshot && typeof ex.tracksSnapshot === 'object' ? ex.tracksSnapshot : {};
  const transcript = ex && ex.transcriptSnapshot !== undefined ? ex.transcriptSnapshot : null;
  const dur = ex && Number(ex.sourceDuration) ? Number(ex.sourceDuration) : 0;
  const prompt = ex && ex.promptText != null ? String(ex.promptText) : '';
  const tracksPayload = prepareTracksForClaude(rawTracks, prompt, {});
  return buildUserTurnContent(prompt, tracksPayload, transcript, dur, [], rawTracks, {
    useCanonicalJson: true,
  });
}

// When FEATURE_MINIMAL_HISTORY is true, the default is 0 full snapshots.
// Conversational prompts bump this to 1 at call time via
// promptNeedsFullHistorySnapshot(). Callers that want explicit control
// still pass fullSnapshotCount directly to buildMessagesForGenerate.
const FULL_SNAPSHOT_DEFAULT = FEATURE_MINIMAL_HISTORY ? 0 : 1;
const MAX_HISTORY_EXCHANGES   = 10;

/**
 * Rough token estimate for rate-limit / payload guarding (chars ÷ 4).
 * Include system prompt when estimating total request size.
 *
 * @param {Array<{role:string,content?:unknown}>} messages
 * @param {string} [systemPrompt]
 * @returns {number}
 */
function estimateTokens(messages, systemPrompt) {
  const sysChars = systemPrompt && typeof systemPrompt === 'string' ? systemPrompt.length : 0;
  if (!Array.isArray(messages)) return Math.ceil(sysChars / 4);
  const msgChars = messages.reduce((total, msg) => {
    const c = msg && msg.content;
    const s = messageContentToString(c);
    return total + String(s).length;
  }, 0);
  return Math.ceil((sysChars + msgChars) / 4);
}

/**
 * buildHistoryMessagesFromConversationExchanges
 * Builds chat messages[] (user / assistant turns only; system is added by the caller).
 * Only the last `fullSnapshotCount` exchanges in the retained tail include full CURRENT_TRACKS;
 * older retained exchanges use stripped PROMPT + CLIP_SUMMARY only.
 *
 * @param {Array<object>} exchanges
 * @param {number}        [fullSnapshotCount=3]
 * @returns {Array<{role:string,content:string}>}
 */
function buildHistoryMessagesFromConversationExchanges(exchanges, fullSnapshotCount) {
  const messages = [];
  if (!Array.isArray(exchanges) || exchanges.length === 0) return messages;

  const nFull =
    typeof fullSnapshotCount === 'number' && fullSnapshotCount >= 0
      ? Math.floor(fullSnapshotCount)
      : FULL_SNAPSHOT_DEFAULT;

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

  const nonSummary = (body || []).filter(ex => !isSummaryExchangeRow(ex));
  const tail =
    nonSummary.length > MAX_HISTORY_EXCHANGES
      ? nonSummary.slice(-MAX_HISTORY_EXCHANGES)
      : nonSummary.slice();

  const cappedFull = Math.max(0, Math.min(nFull, tail.length));
  const nStripped = Math.max(0, tail.length - nFull);
  metrics.counts.historyFullSnapshots = (metrics.counts.historyFullSnapshots || 0) + cappedFull;
  metrics.counts.historyStrippedTurns = (metrics.counts.historyStrippedTurns || 0) + nStripped;

  const startFullSnapshotIndex = Math.max(0, tail.length - nFull);

  for (let index = 0; index < tail.length; index++) {
    const ex = tail[index];
    const includeFullSnapshot = index >= startFullSnapshotIndex;
    const userContent = includeFullSnapshot
      ? buildFullUserMessageFromExchange(ex)
      : buildStrippedUserMessageFromExchange(ex);
    messages.push({ role: 'user', content: userContent });
    const useSummary =
      FEATURE_HISTORY_SUMMARIES && index < tail.length - 1;
    const assistantContent = useSummary
      ? summarizeOpsForHistory(Array.isArray(ex.operations) ? ex.operations : [])
      : JSON.stringify(Array.isArray(ex.operations) ? ex.operations : []);
    if (useSummary) {
      metrics.counts.historySummaryUsed = (metrics.counts.historySummaryUsed || 0) + 1;
    } else {
      metrics.counts.historyRawJsonUsed = (metrics.counts.historyRawJsonUsed || 0) + 1;
    }
    messages.push({
      role:      'assistant',
      content:   assistantContent,
    });
  }
  return messages;
}

/**
 * Full messages array for generateOperations: prior turns + current user turn.
 *
 * @param {Array<object>} conversationExchanges
 * @param {string}        currentUserMessageContent
 * @param {number}        [fullSnapshotCount] — if omitted, derived from the current turn (PROMPT line).
 * @returns {{ messages: Array<{role:string,content:string}>, resolvedFullSnapshotCount: number }}
 */
function buildMessagesForGenerate(conversationExchanges, currentUserMessageContent, fullSnapshotCount) {
  let nFull = fullSnapshotCount;
  if (nFull === undefined || nFull === null) {
    const promptMatch =
      typeof currentUserMessageContent === 'string'
        ? currentUserMessageContent.match(/^PROMPT:\s*([^\n]*)/)
        : null;
    const currentPrompt = promptMatch ? promptMatch[1] : '';
    const needsFull = promptNeedsFullHistorySnapshot(currentPrompt);
    nFull = needsFull ? 1 : FULL_SNAPSHOT_DEFAULT;
    if (needsFull) {
      metrics.counts.historyConversationalEscalation = (metrics.counts.historyConversationalEscalation || 0) + 1;
    }
  }

  const prior = buildHistoryMessagesFromConversationExchanges(
    Array.isArray(conversationExchanges) ? conversationExchanges : [],
    nFull
  );
  if (prior.length === 0) {
    return { messages: [{ role: 'user', content: currentUserMessageContent }], resolvedFullSnapshotCount: nFull };
  }
  return { messages: [...prior, { role: 'user', content: currentUserMessageContent }], resolvedFullSnapshotCount: nFull };
}

const SUMMARY_SYSTEM =
  'You are summarizing a video editing conversation. Respond with plain prose only — no JSON, no markdown code fences, no bullet list unless necessary.';

/**
 * summarizeEditingConversation
 * Separate API call to compress the last N editing exchanges into a short summary.
 *
 * @param {Array<{ promptText: string, operations: Array }>} exchanges
 * @returns {Promise<string>}
 */
async function summarizeEditingConversation(exchanges, userId = null) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) {
    throw new Error('summarizeEditingConversation: exchanges must be a non-empty array');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('summarizeEditingConversation: OPENAI_API_KEY is not set in environment');
  }
  const lines = [];
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i];
    lines.push('Exchange ' + (i + 1) + ':');
    lines.push('User prompt: ' + (ex && ex.promptText != null ? String(ex.promptText) : ''));
    lines.push(
      'Operations: ' + canonicalStringify(ex && Array.isArray(ex.operations) ? ex.operations : [])
    );
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
    response = await chatCompletionRequest({
      model:                 MODEL_FOR_SUMMARIZE,
      messages:              [{ role: 'user', content: userMsg }],
      systemPrompt:          SUMMARY_SYSTEM,
      max_completion_tokens: 1024,
      userId,
      callSite:              'summarize',
    });
  } catch (err) {
    throw new Error('summarizeEditingConversation: API call failed — ' + formatOpenAIError(err));
  }
  const usage = usageFromChatCompletionResponse(response);
  if (usage) {
    metrics.recordChatUsage('summarize', usage);
    log(
      `[summarize] usage — in: ${usage.inputTokens} (cached: ${usage.cacheReadInputTokens}) | out: ${usage.outputTokens}`
    );
  }
  const raw = response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const text = typeof raw === 'string' ? raw : messageContentToString(raw);
  if (!text || !String(text).trim()) {
    throw new Error('summarizeEditingConversation: model returned no text');
  }
  return String(text).trim();
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
        `The model referenced clip IDs that don't exist on the timeline: ${details}. This can happen if you described a clip by number or name and the model misidentified it. Try rephrasing with the exact filename or clip number from the timeline.`,
      ],
      isExplanation:  false,
    };
  }
  return null;
}

// Initialise OpenAI client once at module load.
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * @param {{ model: string, messages: Array, systemPrompt: string, max_completion_tokens: number, userId?: string|null, callSite: string, breakdownMeta?: object }} opts
 */
async function chatCompletionRequest(opts) {
  recordCallBreakdown(opts.callSite, opts.systemPrompt, opts.messages, opts.breakdownMeta || {});

  const body = {
    model:                 opts.model,
    messages:              [
      { role: 'system', content: opts.systemPrompt },
      ...opts.messages,
    ],
    max_completion_tokens: opts.max_completion_tokens,
  };
  if (opts.userId && String(opts.userId).trim()) {
    body.prompt_cache_key = `vibe-${opts.userId}-${opts.callSite}`;
  }
  const response = await client.chat.completions.create(body);
  const usage = usageFromChatCompletionResponse(response);
  if (usage) recordUsageSamples(opts.callSite, usage);
  return response;
}

/**
 * expandSubtitleOps
 * Replaces any CREATE_SUBTITLES operation with a single BATCH_CREATE operation
 * by expanding the transcript server-side. The model may return CREATE_SUBTITLES as
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
 * @param {Array}       operations  Parsed operations array from the model.
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
 * Calls the language model with the current timeline state and user prompt.
 * Returns a validated JSON operations array.
 *
 * @param {string}      userPrompt     Natural-language edit instruction from the user.
 * @param {object}      currentTracks  The tracks object from the current timeline state.
 * @param {Array|null}  transcript     Whisper transcript array, or null if not yet transcribed.
 * @param {number}      sourceDuration Total source video duration in seconds.
 * @param {Array<object>} conversationExchanges Optional prior structured exchanges (max 10 used); only the last few include full tracks in user content (see buildHistoryMessagesFromConversationExchanges).
 *
 * @returns {Promise<{operations:Array,warnings?:Array,isExplanation?:boolean,claudeUsage?:{inputTokens:number,outputTokens:number,totalTokens:number}|null}>} claudeUsage key kept for API compatibility with the editor UI.
 * @throws  {Error}           Descriptive error if API call fails or response is not valid JSON array.
 */
async function generateOperations(
  userPrompt,
  currentTracks,
  transcript,
  sourceDuration,
  uploadedAudioFiles = [],
  conversationExchanges = [],
  userId = null
) {
  if (!userPrompt || typeof userPrompt !== 'string') {
    throw new Error('generateOperations: userPrompt must be a non-empty string');
  }
  if (!currentTracks || typeof currentTracks !== 'object') {
    throw new Error('generateOperations: currentTracks must be an object');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('generateOperations: OPENAI_API_KEY is not set in environment');
  }

  const fullTranscript = Array.isArray(transcript) ? transcript : [];

  const keywordBundles = selectRuleBundles(userPrompt);
  const bundleCountKey = `bundles_${keywordBundles.length ? keywordBundles.join('_') : 'coreOnly'}`;
  metrics.counts[bundleCountKey] = (metrics.counts[bundleCountKey] || 0) + 1;

  const twForDiag =
    fullTranscript.length > 0 ? selectTranscriptWindow(fullTranscript, userPrompt, {}) : null;
  const transcriptModeForDiag = twForDiag ? twForDiag.mode : 'none';
  const transcriptSegCount =
    twForDiag && Array.isArray(twForDiag.segments) ? twForDiag.segments.length : 0;
  const transcriptModeCountKey = `transcriptMode_${transcriptModeForDiag}`;
  metrics.counts[transcriptModeCountKey] = (metrics.counts[transcriptModeCountKey] || 0) + 1;

  let systemPrompt;
  if (!FEATURE_PROMPT_BUNDLES) {
    systemPrompt = SYSTEM_PROMPT;
    log('rule bundles: FEATURE_PROMPT_BUNDLES off — full prompt');
  } else {
    const bundles = keywordBundles;
    if (bundles.length === 0) {
      systemPrompt = SYSTEM_PROMPT;
      log('rule bundles: no keyword match — full prompt');
    } else {
      systemPrompt = buildSystemPrompt(bundles, true);
      log(`rule bundles: ${bundles.join(',')}`);
    }
  }

  const tracksPayload = prepareTracksForClaude(currentTracks, userPrompt, {});
  const userMessage = buildUserTurnContent(
    userPrompt,
    tracksPayload,
    transcript,
    sourceDuration,
    uploadedAudioFiles,
    currentTracks,
    { useCanonicalJson: true }
  );

  let { messages, resolvedFullSnapshotCount: fullSnapshotsUsed } = buildMessagesForGenerate(
    Array.isArray(conversationExchanges) ? conversationExchanges : [],
    userMessage
  );

  if (estimateTokens(messages, systemPrompt) > 20000) {
    ({ messages, resolvedFullSnapshotCount: fullSnapshotsUsed } = buildMessagesForGenerate(
      Array.isArray(conversationExchanges) ? conversationExchanges : [],
      userMessage,
      1
    ));
  }

  if (estimateTokens(messages, systemPrompt) > 25000) {
    fullSnapshotsUsed = 0;
    messages = [{ role: 'user', content: userMessage }];
    console.warn(
      '[generateOperations] Warning: conversation history dropped due to token limit (estimate > 25000 incl. system)'
    );
  }

  if (fullSnapshotsUsed > 1) {
    metrics.counts.historyFullSnapshotsGt1 = (metrics.counts.historyFullSnapshotsGt1 || 0) + 1;
  }

  const estimatedTokens = estimateTokens(messages, systemPrompt);
  log(
    `Token estimate — ~${estimatedTokens} (chars÷4, system+messages) | version ${SYSTEM_PROMPT_VERSION}`
  );

  const tryModels = FEATURE_MODEL_ROUTING && MODEL_FOR_GENERATE !== MODEL_FLAGSHIP
    ? [MODEL_FOR_GENERATE, MODEL_FLAGSHIP]
    : [MODEL_FOR_GENERATE];

  let rawText = '';
  let claudeUsage = null;
  let modelUsed = MODEL_FOR_GENERATE;
  let fallbackUsed = false;

  for (let ti = 0; ti < tryModels.length; ti++) {
    const model = tryModels[ti];
    let response;
    try {
      response = await chatCompletionRequest({
        model,
        messages,
        systemPrompt,
        max_completion_tokens: 8000,
        userId,
        callSite: 'generate',
        breakdownMeta: {
          bundles:        keywordBundles,
          transcriptMode: transcriptModeForDiag,
          transcriptSegments: transcriptSegCount,
          historyTurnCount: messages.length >= 1 ? Math.floor((messages.length - 1) / 2) : 0,
        },
      });
    } catch (err) {
      if (ti === tryModels.length - 1) {
        throw new Error('generateOperations: API call failed — ' + formatOpenAIError(err));
      }
      console.warn(`[generate] model ${model} failed: ${err.message} — retrying with fallback`);
      metrics.counts.routingFallback += 1;
      continue;
    }

    claudeUsage = usageFromChatCompletionResponse(response);
    if (claudeUsage) {
      metrics.recordChatUsage('generate', claudeUsage);
      const cachedRead = claudeUsage.cacheReadInputTokens || 0;
      const freshIn = Math.max(0, claudeUsage.inputTokens - cachedRead);
      log(
        'REAL token usage — ' +
        'input: ' + claudeUsage.inputTokens + ' (fresh ' + freshIn + ' + cached ' + cachedRead + ') | ' +
        'output: ' + claudeUsage.outputTokens + ' | ' +
        'total: ' + claudeUsage.totalTokens + ' | ' +
        'estimated: ' + estimatedTokens +
        ` | model: ${model}`
      );
    }

    const rawMsg = response.choices && response.choices[0] && response.choices[0].message
      ? response.choices[0].message.content
      : '';
    rawText = stripMarkdownJsonFence(
      typeof rawMsg === 'string' ? rawMsg : messageContentToString(rawMsg)
    );
    if (!rawText) {
      if (ti === tryModels.length - 1) {
        throw new Error('generateOperations: model returned an empty response');
      }
      metrics.counts.routingFallback += 1;
      continue;
    }

    const pv = parseAndValidateOperationsJson(rawText);
    if (pv.valid) {
      modelUsed = model;
      if (ti > 0) fallbackUsed = true;
      break;
    }
    if (ti === tryModels.length - 1) {
      throw new Error(
        'generateOperations: invalid operations JSON from all models — ' + (pv.reason || 'unknown')
      );
    }
    console.warn(`[generate] model ${model} invalid ops (${pv.reason}) — falling back`);
    metrics.counts.routingFallback += 1;
  }

  const pvFinal = parseAndValidateOperationsJson(rawText);
  if (!pvFinal.valid) {
    throw new Error('generateOperations: parse failed — ' + (pvFinal.reason || ''));
  }

  if (pvFinal.isExplanation) {
    const st = stripMarkdownJsonFence(rawText);
    const explanation = st.startsWith('[]') && st.length > 2 ? st.slice(2).trim() : '';
    recordGenerateRoutingOutcome(fallbackUsed);
    return {
      operations:    [],
      warnings:      explanation ? [explanation] : ['No explanation text after [].'],
      isExplanation: true,
      claudeUsage,
      modelUsed,
      fallback:      fallbackUsed,
    };
  }

  let operations = pvFinal.operations;
  if (!Array.isArray(operations)) {
    throw new Error('generateOperations: internal parse missing operations array');
  }

  validateParsedOperationOps(operations);

  operations = decompressOperations(operations);

  // Expand any CREATE_SUBTITLES operations into BATCH_CREATE server-side.
  operations = expandSubtitleOps(operations, fullTranscript);

  const refInvalid = validateOperationElementRefs(operations, currentTracks);
  if (refInvalid) {
    recordGenerateRoutingOutcome(fallbackUsed);
    return { ...refInvalid, claudeUsage, modelUsed, fallback: fallbackUsed };
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

  recordGenerateRoutingOutcome(fallbackUsed);
  return {
    operations,
    warnings,
    isExplanation: false,
    claudeUsage,
    modelUsed,
    fallback:      fallbackUsed,
  };
}

// ── Visual pipeline (Pass 1 / Pass 2) — VISUAL_COMPONENT_RULES never mixed into generateOperations ──

function visualPassSystemContent() {
  // Visual pipeline always uses the full rule set — it depends on every
  // surface (subtitles, images, animations, tracks, etc.) — so we go
  // through the backwards-compat SYSTEM_PROMPT export rather than trying
  // to enumerate bundles. This matches the v1 behavior of "system prompt +
  // visual rules".
  return `${SYSTEM_PROMPT.trim()}\n\n${VISUAL_COMPONENT_RULES}`;
}

function detectVisualIntent(prompt) {
  const p = String(prompt || '').toLowerCase();
  const keys = [
    'b-roll', 'broll', 'visual', 'footage', 'cutaway', 'stock', 'overlay',
    'image layer', 'add footage', 'pexels', 'pixabay', 'illustrate', 'emphasize visually',
    'show footage', 'visual component', 'add visuals', 'suggest visuals',
    'analyse visuals', 'analyze visuals', 'scan for visuals', 'scan visuals',
  ];
  return keys.some(k => p.includes(k));
}

function parseJsonArrayFromText(text) {
  if (!text || typeof text !== 'string') return [];
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObjectFromText(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Array<{startTime?:number,endTime?:number,text?:string}>} transcript
 * @param {number} centerT
 * @param {number} windowSec
 */
function extractTranscriptContext(transcript, centerT, windowSec) {
  const w = typeof windowSec === 'number' && windowSec > 0 ? windowSec : 10;
  const c = Number(centerT) || 0;
  const lo = c - w;
  const hi = c + w;
  const segs = Array.isArray(transcript) ? transcript : [];
  return segs.filter(s => {
    const st = s.startTime != null ? s.startTime : s.start;
    const et = s.endTime != null ? s.endTime : s.end;
    if (typeof st !== 'number' || typeof et !== 'number') return false;
    return et >= lo && st <= hi;
  });
}

/**
 * Pass 1 — visual candidate scan.
 * @param {{ includeAllPriorities?: boolean }} [opts]
 */
async function generateVisualCandidates(
  transcript,
  stylePolicy,
  keyMomentsPolicy,
  visualContext,
  opts = {},
  userId = null
) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('generateVisualCandidates: OPENAI_API_KEY is not set');
  }
  const userMsg =
    'PROMPT: Scan this transcript for visual component opportunities.\n' +
    'TRANSCRIPT: ' + canonicalStringify(transcript || []) + '\n' +
    'STYLE_VISUAL_POLICY: ' + canonicalStringify(stylePolicy || {}) + '\n' +
    'KEY_MOMENTS_POLICY: ' + canonicalStringify(keyMomentsPolicy || {}) + '\n' +
    'CURRENT_VISUAL_CONTEXT: ' + canonicalStringify(visualContext || {});

  let response;
  try {
    response = await chatCompletionRequest({
      model:                 MODEL_FOR_VISUAL_SCAN,
      messages:              [{ role: 'user', content: userMsg }],
      systemPrompt:          visualPassSystemContent(),
      max_completion_tokens: 8000,
      userId,
      callSite:              'visual_scan',
    });
  } catch (err) {
    throw new Error('generateVisualCandidates: API failed — ' + formatOpenAIError(err));
  }

  const usage = usageFromChatCompletionResponse(response);
  if (usage) {
    metrics.recordChatUsage('visual_scan', usage);
    log(
      `[visual-pass1] usage — in: ${usage.inputTokens} (cached: ${usage.cacheReadInputTokens}) | out: ${usage.outputTokens}`
    );
  }

  const rawMsg = response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const rawText = stripMarkdownJsonFence(
    typeof rawMsg === 'string' ? rawMsg : messageContentToString(rawMsg)
  );
  let arr = parseJsonArrayFromText(rawText);
  if (!opts.includeAllPriorities) {
    arr = arr.filter(c => {
      const pr = String(c.priority || '').toLowerCase();
      return pr === 'critical' || pr === 'high';
    });
  }

  const REQUIRED_INTERP_FIELDS = [
    'spoken_text_translation',
    'semantic_summary',
    'ideal_visual_description',
    'concrete_subjects',
    'mood',
    'setting_hint',
    'avoid_subjects',
  ];
  for (const c of arr) {
    if (String(c.resolution_strategy || '') !== 'external_stock') continue;
    const missing = REQUIRED_INTERP_FIELDS.filter(k => {
      const v = c[k];
      if (v == null) return true;
      if (Array.isArray(v) && v.length === 0) return true;
      if (typeof v === 'string' && !v.trim()) return true;
      return false;
    });
    if (missing.length > 0) {
      log(
        `[visual-pass1] candidate ${c.candidate_id || '(no id)'} missing interpretation fields: ${missing.join(', ')}`
      );
    }
  }
  return arr;
}

async function generateRetrievalBrief(candidate, transcriptContext, stylePolicy, userId = null) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('generateRetrievalBrief: OPENAI_API_KEY is not set');
  }
  const userMsg =
    'PROMPT: Generate a retrieval brief for this visual candidate.\n' +
    'CANDIDATE: ' + canonicalStringify(candidate || {}) + '\n' +
    'TRANSCRIPT_CONTEXT: ' + canonicalStringify(transcriptContext || []) + '\n' +
    'STYLE_VISUAL_POLICY: ' + canonicalStringify(stylePolicy || {});

  let response;
  try {
    response = await chatCompletionRequest({
      model:                 MODEL_FOR_VISUAL_BRIEF,
      messages:              [{ role: 'user', content: userMsg }],
      systemPrompt:          visualPassSystemContent(),
      max_completion_tokens: 4096,
      userId,
      callSite:              'visual_brief',
    });
  } catch (err) {
    throw new Error('generateRetrievalBrief: API failed — ' + formatOpenAIError(err));
  }

  const usage = usageFromChatCompletionResponse(response);
  if (usage) {
    metrics.recordChatUsage('visual_brief', usage);
    log(
      `[visual-pass2] usage — in: ${usage.inputTokens} (cached: ${usage.cacheReadInputTokens}) | out: ${usage.outputTokens}`
    );
  }

  const rawMsg = response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const rawText = stripMarkdownJsonFence(
    typeof rawMsg === 'string' ? rawMsg : messageContentToString(rawMsg)
  );
  const obj = parseJsonObjectFromText(rawText);
  if (!obj) return null;

  const conf = Number(obj.confidence_score);
  if (!Number.isFinite(conf) || conf < 0.55) return null;

  const req = [
    'candidate_id', 'retrieval_query_primary', 'retrieval_query_alternates',
    'required_orientation', 'required_asset_kind', 'confidence_score',
  ];
  for (const k of req) {
    if (obj[k] === undefined || obj[k] === null) return null;
  }
  if (!Array.isArray(obj.retrieval_query_alternates)) return null;

  log(
    `[visual-pass2] candidate=${obj.candidate_id} primary="${obj.retrieval_query_primary}" ` +
    `searchQuery=${JSON.stringify(obj.searchQuery != null ? obj.searchQuery : '')} ` +
    `alternates=${JSON.stringify(obj.retrieval_query_alternates)} conf=${obj.confidence_score}`
  );
  return obj;
}

function narrowAssetsForVisualPick(assets) {
  return (Array.isArray(assets) ? assets : []).map(a => {
    const altStr = a.alt != null && String(a.alt).trim() !== '' ? String(a.alt) : 'No title available';
    return {
      id:         String(a.id),
      type:       a.type === 'video' ? 'video' : 'photo',
      width:      typeof a.width === 'number' ? a.width : Number(a.width) || 0,
      height:     typeof a.height === 'number' ? a.height : Number(a.height) || 0,
      duration:   a.duration != null && a.duration !== '' ? Number(a.duration) : null,
      alt:        altStr,
      thumbnail:  a.thumbnail != null ? String(a.thumbnail) : '',
    };
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.originalDescription]
 * @param {string} [opts.searchQuery]
 * @returns {Promise<object>} Response body fields for /api/visual/claude-pick (before llmCache*).
 */
async function visualPipelineAiPick(candidate, assets, userId = null, opts = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('visualPipelineAiPick: OPENAI_API_KEY is not set');
  }
  const narrow = narrowAssetsForVisualPick(assets);
  const firstId = narrow.length > 0 ? String(narrow[0].id) : null;

  let orig =
    String(opts.originalDescription != null && opts.originalDescription !== ''
      ? opts.originalDescription
      : (candidate && candidate.originalDescription) || (candidate && candidate.ideal_visual_description) || ''
    ).trim();
  if (!orig) {
    log('[visual-pick] missing originalDescription — substituting');
    orig = 'No scene description available.';
  }

  let sq =
    String(opts.searchQuery != null && opts.searchQuery !== ''
      ? opts.searchQuery
      : (candidate && candidate.searchQuery) || ''
    ).trim();
  if (!sq) {
    log('[visual-pick] missing searchQuery — substituting');
    sq = 'No search query available.';
  }

  const pickSystem = 'You respond with JSON only. No markdown.';
  const userMsg =
    VISUAL_PICK_PROMPT_TEMPLATE
      .replace('"{originalDescription}"', JSON.stringify(orig))
      .replace('"{searchQuery}"', JSON.stringify(sq)) +
    '\n' +
    'ASSETS: ' +
    canonicalStringify(narrow);

  let response;
  try {
    response = await chatCompletionRequest({
      model:                 MODEL_FOR_VISUAL_PICK,
      messages:              [{ role: 'user', content: userMsg }],
      systemPrompt:          pickSystem,
      max_completion_tokens: 800,
      userId,
      callSite:              'visual_pick',
    });
  } catch (err) {
    throw new Error('visualPipelineAiPick: API failed — ' + formatOpenAIError(err));
  }
  const usage = usageFromChatCompletionResponse(response);
  if (usage) {
    metrics.recordChatUsage('visual_pick', usage);
    log(
      `[visual-pick] usage — in: ${usage.inputTokens} (cached: ${usage.cacheReadInputTokens}) | out: ${usage.outputTokens}`
    );
  }
  const rawMsg = response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const raw = stripMarkdownJsonFence(
    typeof rawMsg === 'string' ? rawMsg : messageContentToString(rawMsg)
  ) || '{}';
  const cleaned = String(raw)
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed;
  let parseFailed = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    parseFailed = true;
    parsed = null;
  }

  function idInAssets(id) {
    const s = id != null ? String(id).trim() : '';
    if (!s) return null;
    return narrow.some(a => String(a.id) === s) ? s : null;
  }

  function optionCAmbiguous(expressionNote) {
    const id = firstId;
    if (!id) {
      throw new Error('visualPipelineAiPick: no assets to pick from');
    }
    return {
      chosen_id:         id,
      picked:            {
        chosen_id:         id,
        expressionMatch:   null,
        expressionNote:    expressionNote || 'Could not parse model response; using first result.',
      },
      rejected:          false,
      expressionMatch:   null,
      expressionNote:    expressionNote || 'Could not parse model response; using first result.',
      suggestAiGeneration: false,
      rejectReason:      undefined,
      rejectDetail:      undefined,
    };
  }

  if (parseFailed || !parsed || typeof parsed !== 'object') {
    log(`[visual-pick] JSON parse failed — treating as ambiguous (Option C)`);
    return optionCAmbiguous('Response was not valid JSON; using first result.');
  }

  if (parsed.reject === true) {
    if (!parsed.rejectReason) {
      log(`[visual-pick] reject without rejectReason — treating as ambiguous (Option C)`);
      return optionCAmbiguous('Model rejected but gave no reason; using first result.');
    }
    return {
      chosen_id:             undefined,
      picked:                null,
      rejected:              true,
      expressionMatch:       false,
      suggestAiGeneration:   true,
      rejectReason:          parsed.rejectReason,
      rejectDetail:          parsed.rejectDetail != null ? String(parsed.rejectDetail) : '',
      expressionNote:        undefined,
    };
  }

  const ex = parsed.expressionMatch;
  const chosenRaw = parsed.chosen_id;
  if (chosenRaw == null) {
    log(`[visual-pick] missing chosen_id after non-reject — ambiguous (Option C)`);
    return optionCAmbiguous('Model did not return chosen_id; using first result.');
  }

  const idStr = idInAssets(chosenRaw);
  if (!idStr) {
    log(`[visual-pick] chosen_id not in ASSETS — ambiguous (Option C)`);
    if (firstId) {
      return {
        chosen_id:         firstId,
        picked:            {
          chosen_id:         firstId,
          expressionMatch:   null,
          expressionNote:    (parsed && parsed.expressionNote != null)
            ? String(parsed.expressionNote)
            : 'requested id not in result set; using first result',
        },
        rejected:            false,
        expressionMatch:     null,
        expressionNote:      (parsed && parsed.expressionNote != null)
          ? String(parsed.expressionNote)
          : 'requested id not in result set; using first result',
        suggestAiGeneration: false,
      };
    }
    throw new Error('visualPipelineAiPick: chosen_id not in asset list');
  }

  if (ex === null) {
    return {
      chosen_id:         idStr,
      picked:            { ...parsed, chosen_id: idStr, expressionMatch: null },
      rejected:          false,
      expressionMatch:   null,
      expressionNote:    parsed.expressionNote != null ? String(parsed.expressionNote) : '',
      suggestAiGeneration: false,
    };
  }

  return {
    chosen_id:         idStr,
    picked:            { ...parsed, chosen_id: idStr, expressionMatch: true },
    rejected:          false,
    expressionMatch:   true,
    suggestAiGeneration: false,
    expressionNote:    undefined,
  };
}

(function logCompressionRatioOnce() {
  try {
    const sampleSubtitle = {
      id: 'elem_s_test',
      type: 'subtitle',
      startTime: 0,
      endTime: 1,
      text: 'test',
      style: {
        color: '#fff',
        fontSize: 52,
        fontFamily: 'Arial',
        fontWeight: 'bold',
        fontStyle: 'normal',
        textTransform: 'none',
        textShadow: null,
        letterSpacing: 'normal',
        textAlign: 'center',
        backgroundColor: 'transparent',
        padding: 0,
        borderRadius: 0,
        effect: { type: 'none', color: null },
      },
      position: { x: 0, y: 0, xOffset: 0, yOffset: 0 },
      animation: {
        in:  { type: 'none', duration: 8 },
        out: { type: 'none', duration: 8 },
      },
    };
    const sampleTrack = { id: 'track_sub_0', index: 0, elements: [sampleSubtitle] };
    const sampleTracks = { subtitle: [sampleTrack], image: [], video: [], audio: [] };
    const compressed = compressTracks(sampleTracks);
    const before = JSON.stringify(sampleTracks).length;
    const after = JSON.stringify(compressed).length;
    log(
      `Track compression ratio: ${before} chars → ${after} chars (${Math.round((1 - after / before) * 100)}% reduction per element)`
    );
  } catch (e) {
    console.warn('[generate] compression verification log failed —', e.message);
  }
})();

module.exports = {
  generateOperations,
  summarizeEditingConversation,
  buildClipSummary,
  buildUserTurnContent,
  buildHistoryMessagesFromConversationExchanges,
  estimateTokens,
  usageFromChatCompletionResponse,
  buildMessagesForGenerate,
  compressTracks,
  selectRelevantTracks,
  decompressOperations,
  detectVisualIntent,
  generateVisualCandidates,
  generateRetrievalBrief,
  visualPipelineAiPick,
  extractTranscriptContext,
};
