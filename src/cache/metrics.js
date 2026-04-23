'use strict';

/**
 * In-process counters for cache observability (GET /status?debug=cache).
 */
const counts = {
  transcriptHit:    0,
  transcriptMiss:   0,
  renderHit:        0,
  renderMiss:       0,
  lru:              {}, // name -> { hit, miss }
  routingFallback:  0,
  whisperCalls:     0,
  whisperMinutes:   0,
  /** Per Chat Completions call-site token totals (cumulative since process start). */
  generateTokensInput:   0,
  generateTokensOutput:   0,
  generateTokensCached: 0,
  summarizeTokensInput:   0,
  summarizeTokensOutput:   0,
  summarizeTokensCached:  0,
  visual_scanTokensInput:   0,
  visual_scanTokensOutput:   0,
  visual_scanTokensCached:  0,
  visual_briefTokensInput:   0,
  visual_briefTokensOutput:   0,
  visual_briefTokensCached:  0,
  visual_pickTokensInput:   0,
  visual_pickTokensOutput:   0,
  visual_pickTokensCached:  0,
  /** Per-request routing outcome for /generate (mini first try vs flagship fallback). */
  routingRequestSuccess:  0,
  routingRequestFallback:   0,
  historySummaryUsed:       0,
  historyRawJsonUsed:       0,
  historyFullSnapshotsGt1:    0,
  historyConversationalEscalation: 0,
  historyFullSnapshots: 0,
  historyStrippedTurns: 0,
};

/** Bounded ring buffer of recent samples per metric name (avg / p50 / p95). */
const ROLLING_WINDOW = 500;
const rolling = {}; // { metricName: number[] }

function bumpLru(name, kind) {
  if (!counts.lru[name]) counts.lru[name] = { hit: 0, miss: 0 };
  counts.lru[name][kind] += 1;
}

function recordChatUsage(callSite, usage) {
  if (!usage || typeof usage !== 'object') return;
  const inT = Number(usage.inputTokens);
  const outT = Number(usage.outputTokens);
  const cIn = Number(usage.cacheReadInputTokens) || 0;
  const map = {
    generate:     ['generateTokensInput', 'generateTokensOutput', 'generateTokensCached'],
    summarize:    ['summarizeTokensInput', 'summarizeTokensOutput', 'summarizeTokensCached'],
    visual_scan:  ['visual_scanTokensInput', 'visual_scanTokensOutput', 'visual_scanTokensCached'],
    visual_brief: ['visual_briefTokensInput', 'visual_briefTokensOutput', 'visual_briefTokensCached'],
    visual_pick:  ['visual_pickTokensInput', 'visual_pickTokensOutput', 'visual_pickTokensCached'],
  };
  const keys = map[callSite];
  if (!keys || !Number.isFinite(inT) || !Number.isFinite(outT)) return;
  counts[keys[0]] += inT;
  counts[keys[1]] += outT;
  counts[keys[2]] += cIn;
}

/**
 * cache hit rate ≈ cached input tokens / prompt input tokens (OpenAI convention).
 * @param {string} site
 * @returns {{ input: number, output: number, cached: number, cacheHitRate: number|null }}
 */
function chatSiteStats(site) {
  const map = {
    generate:     ['generateTokensInput', 'generateTokensOutput', 'generateTokensCached'],
    summarize:    ['summarizeTokensInput', 'summarizeTokensOutput', 'summarizeTokensCached'],
    visual_scan:  ['visual_scanTokensInput', 'visual_scanTokensOutput', 'visual_scanTokensCached'],
    visual_brief: ['visual_briefTokensInput', 'visual_briefTokensOutput', 'visual_briefTokensCached'],
    visual_pick:  ['visual_pickTokensInput', 'visual_pickTokensOutput', 'visual_pickTokensCached'],
  };
  const k = map[site];
  if (!k) return { input: 0, output: 0, cached: 0, cacheHitRate: null };
  const input = counts[k[0]] || 0;
  const cached = counts[k[2]] || 0;
  const rate = input > 0 ? cached / input : null;
  return {
    input,
    output: counts[k[1]] || 0,
    cached,
    cacheHitRate: rate != null && Number.isFinite(rate) ? rate : null,
  };
}

function recordSample(name, value) {
  if (typeof name !== 'string' || !name) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  if (!rolling[name]) rolling[name] = [];
  const arr = rolling[name];
  arr.push(n);
  if (arr.length > ROLLING_WINDOW) arr.shift();
}

function statsFor(name) {
  const arr = rolling[name];
  if (!arr || arr.length === 0) return { n: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n:   arr.length,
    avg: Math.round(sum / arr.length),
    p50: pct(0.5),
    p95: pct(0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function allRollingStats() {
  const out = {};
  for (const name of Object.keys(rolling)) out[name] = statsFor(name);
  return out;
}

function snapshot() {
  return JSON.parse(JSON.stringify(counts));
}

function reset() {
  counts.transcriptHit = 0;
  counts.transcriptMiss = 0;
  counts.renderHit = 0;
  counts.renderMiss = 0;
  counts.lru = {};
  counts.routingFallback = 0;
  counts.whisperCalls = 0;
  counts.whisperMinutes = 0;
  counts.generateTokensInput = 0;
  counts.generateTokensOutput = 0;
  counts.generateTokensCached = 0;
  counts.summarizeTokensInput = 0;
  counts.summarizeTokensOutput = 0;
  counts.summarizeTokensCached = 0;
  counts.visual_scanTokensInput = 0;
  counts.visual_scanTokensOutput = 0;
  counts.visual_scanTokensCached = 0;
  counts.visual_briefTokensInput = 0;
  counts.visual_briefTokensOutput = 0;
  counts.visual_briefTokensCached = 0;
  counts.visual_pickTokensInput = 0;
  counts.visual_pickTokensOutput = 0;
  counts.visual_pickTokensCached = 0;
  counts.routingRequestSuccess = 0;
  counts.routingRequestFallback = 0;
  counts.historySummaryUsed = 0;
  counts.historyRawJsonUsed = 0;
  counts.historyFullSnapshotsGt1 = 0;
  counts.historyConversationalEscalation = 0;
  counts.historyFullSnapshots = 0;
  counts.historyStrippedTurns = 0;
  for (const k of [...Object.keys(counts)]) {
    if (k.startsWith('bundles_') || k.startsWith('transcriptMode_')) delete counts[k];
  }
  for (const k of Object.keys(rolling)) delete rolling[k];
}

module.exports = {
  counts,
  bumpLru,
  snapshot,
  reset,
  recordChatUsage,
  chatSiteStats,
  recordSample,
  statsFor,
  allRollingStats,
  ROLLING_WINDOW,
};
