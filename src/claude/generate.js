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
const { SYSTEM_PROMPT, VISUAL_COMPONENT_RULES } = require('./systemPrompt');
const { searchAudio }   = require('../assets/audio');

const log = (...args) => console.log('[generate]', ...args);

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

function compressImageClipElement(el) {
  const stripped = omitKeys(el, ['storageRef', 'pixabayId', 'nativePayload', 'src']);
  const out = {
    id: stripped.id,
    st: stripped.startTime,
    et: stripped.endTime,
    tp: 'imageClip',
  };
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

const SUBTITLE_KEYWORDS = [
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

const AUDIO_KEYWORDS = [
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
  if (promptMatchesAnyKeyword(p, SUBTITLE_KEYWORDS)) wantSub = true;
  if (promptMatchesAnyKeyword(p, VIDEO_KEYWORDS)) wantVid = true;
  if (promptMatchesAnyKeyword(p, AUDIO_KEYWORDS)) wantAud = true;

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

function decompressAudioLikeBody(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const t = obj.tp || obj.type;
  if (t && t !== 'audioClip') return obj;
  const compressed = obj.tp === 'audioClip' || obj.st_ !== undefined;
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
 * @param {Array|null}  transcript
 * @param {number}      sourceDuration
 * @param {Array}       uploadedAudioFiles
 * @param {object}      [tracksForClipSummary]       Full timeline for CLIP_SUMMARY (defaults to tracksForCurrentTracksJson).
 * @returns {string}
 */
function buildUserTurnContent(
  userPrompt,
  tracksForCurrentTracksJson,
  transcript,
  sourceDuration,
  uploadedAudioFiles,
  tracksForClipSummary
) {
  const clipSrc =
    tracksForClipSummary != null && typeof tracksForClipSummary === 'object'
      ? tracksForClipSummary
      : tracksForCurrentTracksJson;
  return (
    'PROMPT: ' + userPrompt + '\n\n' +
    'CURRENT_TRACKS: ' + JSON.stringify(tracksForCurrentTracksJson) + '\n\n' +
    'TRANSCRIPT: ' + (transcript ? JSON.stringify(transcript) : 'null') + '\n\n' +
    buildClipSummary(clipSrc) + '\n\n' +
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
 * buildStrippedUserMessageFromExchange
 * Older turns: PROMPT + CLIP_SUMMARY only (no CURRENT_TRACKS / TRANSCRIPT / uploads).
 * Uses persisted clipSummary only — no full tracks JSON (token savings).
 *
 * @param {object} ex
 * @returns {string}
 */
function buildStrippedUserMessageFromExchange(ex) {
  const prompt = ex && ex.promptText != null ? String(ex.promptText) : '';
  const raw = ex && ex.clipSummary != null ? String(ex.clipSummary).trim() : '';
  if (raw) {
    // Client stores clipSummary already prefixed with "CLIP_SUMMARY:\n…"
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
  return buildUserTurnContent(prompt, tracksPayload, transcript, dur, [], rawTracks);
}

const FULL_SNAPSHOT_DEFAULT = 3;
const MAX_HISTORY_EXCHANGES   = 10;

/**
 * Rough token estimate for rate-limit / payload guarding (chars ÷ 4).
 *
 * @param {Array<{role:string,content?:unknown}>} messages
 * @returns {number}
 */
function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, msg) => {
    const c = msg && msg.content;
    const s =
      typeof c === 'string'
        ? c
        : c === undefined || c === null
          ? ''
          : JSON.stringify(c);
    return total + Math.ceil(String(s).length / 4);
  }, 0);
}

/**
 * buildHistoryMessagesFromConversationExchanges
 * Builds Anthropic messages[] from structured exchanges.
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

  const startFullSnapshotIndex = Math.max(0, tail.length - nFull);

  for (let index = 0; index < tail.length; index++) {
    const ex = tail[index];
    const includeFullSnapshot = index >= startFullSnapshotIndex;
    const userContent = includeFullSnapshot
      ? buildFullUserMessageFromExchange(ex)
      : buildStrippedUserMessageFromExchange(ex);
    messages.push({ role: 'user', content: userContent });
    messages.push({
      role:      'assistant',
      content:   JSON.stringify(Array.isArray(ex.operations) ? ex.operations : []),
    });
  }
  return messages;
}

/**
 * Full messages array for generateOperations: prior turns + current user turn.
 *
 * @param {Array<object>} conversationExchanges
 * @param {string}        currentUserMessageContent
 * @param {number}        fullSnapshotCount
 * @returns {Array<{role:string,content:string}>}
 */
function buildMessagesForGenerate(conversationExchanges, currentUserMessageContent, fullSnapshotCount) {
  const prior = buildHistoryMessagesFromConversationExchanges(
    Array.isArray(conversationExchanges) ? conversationExchanges : [],
    fullSnapshotCount
  );
  return prior.length > 0
    ? [...prior, { role: 'user', content: currentUserMessageContent }]
    : [{ role: 'user', content: currentUserMessageContent }];
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
 * @param {Array<object>} conversationExchanges Optional prior structured exchanges (max 10 used); only the last few include full tracks in user content (see buildHistoryMessagesFromConversationExchanges).
 *
 * @returns {Promise<{operations:Array,warnings?:Array,isExplanation?:boolean,claudeUsage?:{inputTokens:number,outputTokens:number,totalTokens:number}|null}>}
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

  const tracksPayload = prepareTracksForClaude(currentTracks, userPrompt, {});
  const userMessage = buildUserTurnContent(
    userPrompt,
    tracksPayload,
    transcript,
    sourceDuration,
    uploadedAudioFiles,
    currentTracks
  );

  let messages = buildMessagesForGenerate(
    Array.isArray(conversationExchanges) ? conversationExchanges : [],
    userMessage,
    FULL_SNAPSHOT_DEFAULT
  );

  if (estimateTokens(messages) > 20000) {
    messages = buildMessagesForGenerate(
      Array.isArray(conversationExchanges) ? conversationExchanges : [],
      userMessage,
      1
    );
  }

  if (estimateTokens(messages) > 25000) {
    messages = [{ role: 'user', content: userMessage }];
    console.warn(
      '[generateOperations] Warning: conversation history dropped due to token limit (messages-only estimate > 25000)'
    );
  }

  const estSys = Math.ceil(String(SYSTEM_PROMPT).length / 4);
  const estimatedTokens = estimateTokens(messages);
  log(
    `Token estimate — system: ~${estSys} | messages: ~${estimatedTokens} | total: ~${estSys + estimatedTokens}`
  );

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

  log(
    'REAL token usage — ' +
    'input: ' + response.usage.input_tokens + ' | ' +
    'output: ' + response.usage.output_tokens + ' | ' +
    'total: ' + (response.usage.input_tokens + response.usage.output_tokens) + ' | ' +
    'estimated was: ' + estimatedTokens
  );

  const claudeUsage = (function usageFromAnthropicMessage(resp) {
    const u = resp && resp.usage;
    if (!u || typeof u !== 'object') return null;
    const input = Number(u.input_tokens != null ? u.input_tokens : u.inputTokens);
    const output = Number(u.output_tokens != null ? u.output_tokens : u.outputTokens);
    const inTok = Number.isFinite(input) ? input : 0;
    const outTok = Number.isFinite(output) ? output : 0;
    return { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok };
  })(response);

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
      claudeUsage,
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

  operations = decompressOperations(operations);

  // Expand any CREATE_SUBTITLES operations into BATCH_CREATE server-side.
  operations = expandSubtitleOps(operations, transcript);

  const refInvalid = validateOperationElementRefs(operations, currentTracks);
  if (refInvalid) {
    return { ...refInvalid, claudeUsage };
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

  return { operations, warnings, isExplanation: false, claudeUsage };
}

// ── Visual pipeline (Pass 1 / Pass 2) — VISUAL_COMPONENT_RULES never mixed into generateOperations ──

const VISUAL_PASS_SYSTEM = () => `${SYSTEM_PROMPT.trim()}\n\n${VISUAL_COMPONENT_RULES}`;

function detectVisualIntent(prompt) {
  const p = String(prompt || '').toLowerCase();
  const keys = [
    'b-roll', 'broll', 'visual', 'footage', 'cutaway', 'stock', 'overlay',
    'image layer', 'add footage', 'pixabay', 'illustrate', 'emphasize visually',
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
  opts = {}
) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('generateVisualCandidates: ANTHROPIC_API_KEY is not set');
  }
  const userMsg =
    'PROMPT: Scan this transcript for visual component opportunities.\n' +
    'TRANSCRIPT: ' + JSON.stringify(transcript || []) + '\n' +
    'STYLE_VISUAL_POLICY: ' + JSON.stringify(stylePolicy || {}) + '\n' +
    'KEY_MOMENTS_POLICY: ' + JSON.stringify(keyMomentsPolicy || {}) + '\n' +
    'CURRENT_VISUAL_CONTEXT: ' + JSON.stringify(visualContext || {});

  let response;
  try {
    response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system:     VISUAL_PASS_SYSTEM(),
      messages:   [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    throw new Error('generateVisualCandidates: Claude API failed — ' + err.message);
  }

  const u = response.usage || {};
  const inTok = Number(u.input_tokens != null ? u.input_tokens : u.inputTokens) || 0;
  const outTok = Number(u.output_tokens != null ? u.output_tokens : u.outputTokens) || 0;
  console.log('[visual-pass1] input_tokens=' + inTok + ' output_tokens=' + outTok);

  const textBlock = response.content && response.content.find(b => b.type === 'text');
  const rawText = textBlock && textBlock.text ? textBlock.text.trim() : '';
  let arr = parseJsonArrayFromText(rawText);
  if (!opts.includeAllPriorities) {
    arr = arr.filter(c => {
      const pr = String(c.priority || '').toLowerCase();
      return pr === 'critical' || pr === 'high';
    });
  }
  return arr;
}

async function generateRetrievalBrief(candidate, transcriptContext, stylePolicy) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('generateRetrievalBrief: ANTHROPIC_API_KEY is not set');
  }
  const userMsg =
    'PROMPT: Generate a retrieval brief for this visual candidate.\n' +
    'CANDIDATE: ' + JSON.stringify(candidate || {}) + '\n' +
    'TRANSCRIPT_CONTEXT: ' + JSON.stringify(transcriptContext || []) + '\n' +
    'STYLE_VISUAL_POLICY: ' + JSON.stringify(stylePolicy || {});

  let response;
  try {
    response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system:     VISUAL_PASS_SYSTEM(),
      messages:   [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    throw new Error('generateRetrievalBrief: Claude API failed — ' + err.message);
  }

  const u = response.usage || {};
  const inTok = Number(u.input_tokens != null ? u.input_tokens : u.inputTokens) || 0;
  const outTok = Number(u.output_tokens != null ? u.output_tokens : u.outputTokens) || 0;
  console.log('[visual-pass2] input_tokens=' + inTok + ' output_tokens=' + outTok);

  const textBlock = response.content && response.content.find(b => b.type === 'text');
  const rawText = textBlock && textBlock.text ? textBlock.text.trim() : '';
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

  return obj;
}

async function visualPipelineClaudePick(candidate, assets) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('visualPipelineClaudePick: ANTHROPIC_API_KEY is not set');
  }
  const userMsg =
    'Given these ranked visual assets for the moment described, choose the single best one. ' +
    'Return only the asset id as a JSON object: { "chosen_id": <number> }\n\n' +
    'CANDIDATE: ' + JSON.stringify(candidate || {}) + '\n' +
    'ASSETS: ' + JSON.stringify(assets || []);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 256,
    system:     'You respond with JSON only. No markdown.',
    messages:   [{ role: 'user', content: userMsg }],
  });
  const textBlock = response.content && response.content.find(b => b.type === 'text');
  const raw = textBlock && textBlock.text ? textBlock.text.trim() : '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
  } catch (_) {
    parsed = {};
  }
  const id = parsed && parsed.chosen_id != null ? Number(parsed.chosen_id) : NaN;
  if (!Number.isFinite(id)) throw new Error('visualPipelineClaudePick: invalid chosen_id');
  return { chosen_id: id };
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
  buildMessagesForGenerate,
  compressTracks,
  selectRelevantTracks,
  decompressOperations,
  detectVisualIntent,
  generateVisualCandidates,
  generateRetrievalBrief,
  visualPipelineClaudePick,
  extractTranscriptContext,
};
