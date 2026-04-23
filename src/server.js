/**
 * src/server.js
 * Express backend for Vibe Editor.
 *
 * Serves the static frontend, state files, and orchestrates the pipeline:
 *   POST /upload    → save video, return metadata
 *   POST /generate  → (optional) transcribe + AI operations → return { operations, transcript }
 *   POST /export    → serialize timeline → Remotion render → output file
 *   GET  /download/:filename → serve rendered video as download
 *   GET  /renders/*          → serve rendered output as streamable video (for VideoPreview)
 *   GET  /state/*            → serve state JS files to browser (schema, reducer)
 *   GET  /presets   → list style presets
 *   GET  /status    → health check (public)
 *   POST /api/auth/verify → validate JWT (requires Bearer token)
 *   Supabase JWT required on: /upload, /generate, /export, /download, /api/audio/*, /api/summarize-conversation
 */

'use strict';

require('dotenv').config();

/**
 * Max multipart upload size (video / audio / image).
 * Default 10240 MB (10 GiB); set MAX_UPLOAD_MB in .env to override.
 */
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.MAX_UPLOAD_MB;
  if (raw !== undefined && raw !== '') {
    const mb = Number(raw);
    if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  }
  return 10240 * 1024 * 1024;
})();

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { randomUUID } = require('crypto');
const axios   = require('axios');
const ffmpeg  = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const { extractAudio, convertImageToVideo, extractThumbnailAtPercent } = require('./video/extract');
const { serializeToRemotion } = require('./video/serializeToRemotion');
const {
  generateOperations,
  summarizeEditingConversation,
  generateVisualCandidates,
  generateRetrievalBrief,
  extractTranscriptContext,
  visualPipelineAiPick,
} = require('./claude/generate');
const { SYSTEM_PROMPT_VERSION } = require('./claude/systemPrompt');
const { searchFreesound, searchJamendo, searchAudio } = require('./assets/audio');
const { generateImageFromDescription } = require('./assets/aiImageGen');

const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

const { makeLRU } = require('./cache/lru');
const { getOrTranscribeAudio } = require('./cache/transcriptCache');
const {
  computeRenderHash,
  renderCacheFilePath,
  saveRenderToCache,
} = require('./cache/renderCache');
const metrics = require('./cache/metrics');
const { allRollingStats, ROLLING_WINDOW } = metrics;
const { cacheTranscriptRenderEnabled } = require('./cache/config');
const { makeLlmResponseCache } = require('./cache/llmResponseCache');

/** In-memory API response caches (see docs/sql/cache_tables.sql for Supabase transcript cache). */
const fontsLRU           = makeLRU({ max: 2, ttlMs: 24 * 60 * 60 * 1000, name: 'fonts' });
const pexelsLRU          = makeLRU({ max: 500, ttlMs: 24 * 60 * 60 * 1000, name: 'pexels' });
const audioFreesoundLRU  = makeLRU({ max: 500, ttlMs: 30 * 60 * 1000, name: 'audio_freesound' });
const audioJamendoLRU    = makeLRU({ max: 500, ttlMs: 30 * 60 * 1000, name: 'audio_jamendo' });
const audioUnifiedLRU    = makeLRU({ max: 500, ttlMs: 30 * 60 * 1000, name: 'audio_unified' });

/** Deterministic LLM response memoization (per-user; in-memory). */
const generateLlmCache = makeLlmResponseCache({
  name:       'llm_generate',
  maxEnv:     'LLM_RESPONSE_CACHE_MAX',
  ttlMsEnv:   'LLM_RESPONSE_CACHE_TTL_MS',
  defaultMax: 200,
  defaultTtlMs: 5 * 60 * 1000,
});
const summarizeLlmCache = makeLlmResponseCache({
  name:       'llm_summarize',
  maxEnv:     'LLM_SUMMARIZE_CACHE_MAX',
  ttlMsEnv:   'LLM_SUMMARIZE_CACHE_TTL_MS',
  defaultMax: 80,
  defaultTtlMs: 30 * 60 * 1000,
});
const visualScanLlmCache = makeLlmResponseCache({
  name:       'llm_visual_scan',
  maxEnv:     'LLM_VISUAL_SCAN_CACHE_MAX',
  ttlMsEnv:   'LLM_VISUAL_SCAN_CACHE_TTL_MS',
  defaultMax: 60,
  defaultTtlMs: 15 * 60 * 1000,
});
const visualBriefLlmCache = makeLlmResponseCache({
  name:       'llm_visual_brief',
  maxEnv:     'LLM_VISUAL_BRIEF_CACHE_MAX',
  ttlMsEnv:   'LLM_VISUAL_BRIEF_CACHE_TTL_MS',
  defaultMax: 200,
  defaultTtlMs: 15 * 60 * 1000,
});
const visualPickLlmCache = makeLlmResponseCache({
  name:       'llm_visual_pick',
  maxEnv:     'LLM_VISUAL_PICK_CACHE_MAX',
  ttlMsEnv:   'LLM_VISUAL_PICK_CACHE_TTL_MS',
  defaultMax: 400,
  defaultTtlMs: 15 * 60 * 1000,
});

/*
  Run in Supabase SQL editor (Storage + projects):

  -- Storage policies
  create policy "users manage own videos" on storage.objects
    for all using (
      bucket_id = 'videos' AND
      auth.uid()::text = (storage.foldername(name))[1]
    );

  create policy "users manage own audio" on storage.objects
    for all using (
      bucket_id = 'audio' AND
      auth.uid()::text = (storage.foldername(name))[1]
    );

  -- image-layer bucket policy
  create policy "users manage own image layer" on storage.objects
    for all using (
      bucket_id = 'image-layer' AND
      auth.uid()::text = (storage.foldername(name))[1]
    );

  -- Create image-layer bucket manually in Supabase dashboard if
  -- ensureStorageBuckets() fails due to permissions.

  create policy "thumbnails are public" on storage.objects
    for select using (bucket_id = 'thumbnails');

  create policy "users manage own thumbnails" on storage.objects
    for insert with check (
      bucket_id = 'thumbnails' AND
      auth.uid()::text = (storage.foldername(name))[1]
    );

  alter table projects add column if not exists thumbnail_url text;
  alter table projects add column if not exists duration numeric default 0;
  alter table projects add column if not exists transcript jsonb;
  alter table projects add column if not exists timeline jsonb default '{}'::jsonb;
  alter table projects add column if not exists video_path text;

  -- If projects table does not exist yet:
  -- create table if not exists projects (
  --   id uuid primary key default gen_random_uuid(),
  --   user_id uuid not null references auth.users (id) on delete cascade,
  --   name text,
  --   timeline jsonb default '{}'::jsonb,
  --   transcript jsonb,
  --   video_path text,
  --   thumbnail_url text,
  --   duration numeric default 0,
  --   created_at timestamptz default now(),
  --   updated_at timestamptz default now()
  -- );
*/

const SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7; // 7 days (Supabase typical max)

/**
 * requireAuth — validates Supabase JWT from Authorization: Bearer <token>.
 */
async function requireAuth(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase auth is not configured on the server' });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  req.user = user;
  next();
}

/**
 * Injects window.SUPABASE_URL / window.SUPABASE_ANON_KEY into HTML served to the browser.
 */
function injectSupabaseConfig(html) {
  const inj = `<script>window.SUPABASE_URL=${JSON.stringify(process.env.SUPABASE_URL || '')};window.SUPABASE_ANON_KEY=${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')};</script>`;
  if (html.includes('<!--VIBE_SUPABASE_CONFIG-->')) {
    return html.replace('<!--VIBE_SUPABASE_CONFIG-->', inj);
  }
  return html.replace('<head>', '<head>\n' + inj + '\n');
}

function sendInjectedHtml(res, publicFilename) {
  const abs = path.join(__dirname, '..', 'public', publicFilename);
  const html = injectSupabaseConfig(fs.readFileSync(abs, 'utf8'));
  res.type('html').send(html);
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---------------------------------------------------------------------------
// Health + HTML entry (before static /public so / is not shadowed)
// ---------------------------------------------------------------------------

app.get('/status', (req, res) => {
  const base = { status: 'ok', version: '0.2.0' };
  if (String(req.query.debug || '') === 'cache') {
    return res.json({ ...base, cache: metrics.snapshot() });
  }
  res.json(base);
});

/** Google Fonts catalogue — used when GOOGLE_FONTS_API_KEY is missing or API fails */
const FONTS_FALLBACK = [
  { family: 'Inter', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Roboto', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Open Sans', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Lato', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Montserrat', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Oswald', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Raleway', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Poppins', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Nunito', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Playfair Display', category: 'serif', variants: ['400', '700'] },
  { family: 'Merriweather', category: 'serif', variants: ['400', '700'] },
  { family: 'Anton', category: 'sans-serif', variants: ['400'] },
  { family: 'Bebas Neue', category: 'display', variants: ['400'] },
  { family: 'Impact', category: 'sans-serif', variants: ['400'] },
  { family: 'PT Sans', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Source Sans Pro', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Ubuntu', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Noto Sans', category: 'sans-serif', variants: ['400', '700'] },
  { family: 'Crimson Text', category: 'serif', variants: ['400', '700'] },
  { family: 'Dancing Script', category: 'handwriting', variants: ['400', '700'] },
];

const FONTS_LRU_KEY = 'google-fonts';

/**
 * GET /api/fonts — simplified Google Web Fonts list (public, no auth).
 * Cached 24h in memory (LRU). Falls back to FONTS_FALLBACK if no API key or request fails.
 */
app.get('/api/fonts', async (req, res) => {
  try {
    const cached = fontsLRU.get(FONTS_LRU_KEY);
    if (cached !== undefined) return res.json(cached);
    const key = process.env.GOOGLE_FONTS_API_KEY;
    if (!key || !String(key).trim()) {
      fontsLRU.set(FONTS_LRU_KEY, FONTS_FALLBACK);
      return res.json(FONTS_FALLBACK);
    }
    const url =
      'https://www.googleapis.com/webfonts/v1/webfonts?key=' +
      encodeURIComponent(String(key).trim()) +
      '&sort=popularity';
    const r = await axios.get(url, { timeout: 20000 });
    const items = r.data && r.data.items;
    if (!Array.isArray(items) || items.length === 0) {
      fontsLRU.set(FONTS_LRU_KEY, FONTS_FALLBACK);
      return res.json(FONTS_FALLBACK);
    }
    const list = items.map(it => ({
      family:   it.family,
      category: it.category || 'sans-serif',
      variants: Array.isArray(it.variants) ? it.variants : ['400', '700'],
    }));
    fontsLRU.set(FONTS_LRU_KEY, list);
    res.json(list);
  } catch (err) {
    log('GET /api/fonts failed: ' + (err.message || err));
    res.json(FONTS_FALLBACK);
  }
});

app.get('/', (req, res) => {
  res.redirect(302, '/landing.html');
});

app.get('/landing', (req, res) => {
  sendInjectedHtml(res, 'landing.html');
});

app.get('/landing.html', (req, res) => {
  sendInjectedHtml(res, 'landing.html');
});

app.get('/editor', (req, res) => {
  sendInjectedHtml(res, 'index.html');
});

app.get('/index.html', (req, res) => {
  res.redirect(302, '/landing.html');
});

app.get('/login', (req, res) => {
  sendInjectedHtml(res, 'login.html');
});

app.get('/login.html', (req, res) => {
  sendInjectedHtml(res, 'login.html');
});

app.post('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

/**
 * GET /api/_debug/cache — LRU + transcript/render hit counters (auth required).
 */
app.get('/api/_debug/cache', requireAuth, (req, res) => {
  const snap = metrics.snapshot();
  const rolling = allRollingStats();

  const callSites = ['generate', 'summarize', 'visual_scan', 'visual_brief', 'visual_pick'];
  const perSite = {};
  for (const site of callSites) {
    perSite[site] = {
      estTotalTokens: rolling[`${site}_estTotalTokens`] || null,
      realInputTokens: rolling[`${site}_realInputTokens`] || null,
      realOutputTokens: rolling[`${site}_realOutputTokens`] || null,
      realCachedTokens: rolling[`${site}_realCachedTokens`] || null,
      cacheHitRatio: rolling[`${site}_cacheHitRatio`] || null,
      breakdown: {
        systemTokens: rolling[`${site}_systemTokens`] || null,
        historyTokens: rolling[`${site}_historyTokens`] || null,
        currentTurnTokens: rolling[`${site}_currentTurnTokens`] || null,
      },
    };
  }

  const bundleDistribution = {};
  const transcriptModeDistribution = {};
  for (const [key, value] of Object.entries(snap)) {
    if (key.startsWith('bundles_')) bundleDistribution[key.replace('bundles_', '')] = value;
    if (key.startsWith('transcriptMode_')) transcriptModeDistribution[key.replace('transcriptMode_', '')] = value;
  }

  const routingFallbackRate =
    (snap.routingRequestFallback || 0) /
    Math.max(1, (snap.routingRequestFallback || 0) + (snap.routingRequestSuccess || 0));

  res.json({
    SYSTEM_PROMPT_VERSION,
    /** In-process LRU hit/miss counters (includes `pexels`, `fonts`, audio pools, etc.) */
    lru: snap.lru,
    cacheMetrics:     snap,
    routingFallback:  snap.routingFallback,
    whisperMinutes:   snap.whisperMinutes,
    chatSiteStats: {
      generate:     metrics.chatSiteStats('generate'),
      summarize:    metrics.chatSiteStats('summarize'),
      visual_scan:  metrics.chatSiteStats('visual_scan'),
      visual_brief:   metrics.chatSiteStats('visual_brief'),
      visual_pick:    metrics.chatSiteStats('visual_pick'),
    },
    cacheTranscriptRender: process.env.CACHE_ENABLED !== 'false',
    transcriptRender: process.env.CACHE_ENABLED !== 'false',
    llmResponseCaches: {
      generate:   { max: generateLlmCache.max, ttlMs: generateLlmCache.ttlMs },
      summarize:  { max: summarizeLlmCache.max, ttlMs: summarizeLlmCache.ttlMs },
      visualScan: { max: visualScanLlmCache.max, ttlMs: visualScanLlmCache.ttlMs },
      visualBrief:{ max: visualBriefLlmCache.max, ttlMs: visualBriefLlmCache.ttlMs },
      visualPick: { max: visualPickLlmCache.max, ttlMs: visualPickLlmCache.ttlMs },
    },
    diagnostics: {
      perSite,
      bundleDistribution,
      transcriptModeDistribution,
      routing: {
        successCount: snap.routingRequestSuccess || 0,
        fallbackCount: snap.routingRequestFallback || 0,
        fallbackRate: routingFallbackRate,
      },
      history: {
        summaryUsedCount: snap.historySummaryUsed || 0,
        rawJsonUsedCount: snap.historyRawJsonUsed || 0,
        fullSnapshotsGt1Count: snap.historyFullSnapshotsGt1 || 0,
        conversationalEscalationCount: snap.historyConversationalEscalation || 0,
        fullSnapshotsIncluded: snap.historyFullSnapshots || 0,
        strippedTurnsIncluded: snap.historyStrippedTurns || 0,
      },
      whisper: {
        calls: snap.whisperCalls || 0,
        cumulativeMinutes: snap.whisperMinutes || 0,
      },
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      rollingWindowSize: ROLLING_WINDOW,
    },
  });
});

/**
 * GET /api/_debug/token-report — plain-text rolling token / routing diagnostics (auth required).
 */
app.get('/api/_debug/token-report', requireAuth, (req, res) => {
  const rolling = allRollingStats();
  const snap = metrics.snapshot();
  const callSites = ['generate', 'summarize', 'visual_scan', 'visual_brief', 'visual_pick'];

  const lines = [];
  lines.push('=== Vibe Editor Token Report ===');
  lines.push(`Rolling window: last ${ROLLING_WINDOW} calls per metric`);
  lines.push('');

  for (const site of callSites) {
    const est = rolling[`${site}_estTotalTokens`];
    const real = rolling[`${site}_realInputTokens`];
    if (!est || est.n === 0) {
      lines.push(`[${site}] no samples yet`);
      lines.push('');
      continue;
    }
    const sys = rolling[`${site}_systemTokens`];
    const hist = rolling[`${site}_historyTokens`];
    const curr = rolling[`${site}_currentTurnTokens`];
    const cached = rolling[`${site}_realCachedTokens`];
    const cacheRatio = rolling[`${site}_cacheHitRatio`];

    lines.push(`[${site}] n=${est.n}`);
    lines.push(
      `  real input tokens (OpenAI) — avg: ${real && real.n ? real.avg : '?'} | p50: ${real && real.n ? real.p50 : '?'} | p95: ${real && real.n ? real.p95 : '?'}`
    );
    lines.push(
      `  cached tokens — avg: ${cached && cached.n ? cached.avg : '?'} | hit ratio avg: ${((cacheRatio && cacheRatio.n ? cacheRatio.avg : 0) * 100).toFixed(1)}%`
    );
    lines.push(
      `  est breakdown — system: ${sys && sys.n ? sys.avg : '?'} | history: ${hist && hist.n ? hist.avg : '?'} | current: ${curr && curr.n ? curr.avg : '?'}`
    );
    lines.push('');
  }

  const fb = snap.routingRequestFallback || 0;
  const ok = snap.routingRequestSuccess || 0;
  const fallbackRate = (fb / Math.max(1, fb + ok)) * 100;
  lines.push(`Routing fallback (mini → flagship, per completed /generate): ${fb} / ${fb + ok} = ${fallbackRate.toFixed(1)}%`);
  lines.push('');

  lines.push('Rule bundle distribution (keyword hits, per /generate):');
  for (const [key, value] of Object.entries(snap)) {
    if (key.startsWith('bundles_')) lines.push(`  ${key.replace('bundles_', '')}: ${value}`);
  }
  lines.push('');

  lines.push('Transcript mode distribution (per /generate):');
  for (const [key, value] of Object.entries(snap)) {
    if (key.startsWith('transcriptMode_')) lines.push(`  ${key.replace('transcriptMode_', '')}: ${value}`);
  }
  lines.push('');

  lines.push(
    `Whisper: ${snap.whisperCalls || 0} calls, ${(snap.whisperMinutes || 0).toFixed(1)} min cumulative`
  );
  lines.push(`System prompt version: ${SYSTEM_PROMPT_VERSION || 'unknown'}`);

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(lines.join('\n'));
});

// Serve state files (schema.js, timelineReducer.js) to the browser.
app.use('/state', express.static(path.join(__dirname, 'state'), {
  maxAge: 5 * 60 * 1000,
  etag:   true,
}));

// Serve rendered output videos as streamable (for VideoPreview <video> element).
app.use('/renders', express.static(path.join(__dirname, '..', 'output'), {
  maxAge: 24 * 60 * 60 * 1000,
  etag:   true,
}));

// Serve uploaded audio files for in-browser playback via /audio/filename.mp3.
app.use('/audio', express.static(path.join(__dirname, '..', 'uploads'), {
  maxAge: 60 * 60 * 1000,
  etag:   true,
}));

// Serve all uploaded files (video, image-derived mp4) via /uploads/filename.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  maxAge: 60 * 60 * 1000,
  etag:   true,
}));

// ---------------------------------------------------------------------------
// Multer — video upload storage
// ---------------------------------------------------------------------------

/**
 * Saves uploaded files to /uploads with a timestamp prefix for uniqueness.
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = [
      // Video types
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm',
      // Audio types
      'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg',
      'audio/mp4', 'audio/x-m4a',
      // Image types (auto-converted to mp4 on upload)
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Accepted: MP4, MOV, AVI, WebM, MP3, WAV, AAC, OGG, M4A, JPG, PNG, GIF, WebP.'));
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * log
 * Writes a timestamped message to stdout for pipeline step tracing.
 * @param {string} msg
 */
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * getVideoDuration
 * Reads video duration via ffprobe.
 * @param  {string} filePath  Absolute path to video file.
 * @returns {Promise<number>} Duration in seconds.
 */
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration || 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Supabase Storage + Projects API
// ---------------------------------------------------------------------------

async function ensureStorageBuckets() {
  if (!supabaseAdmin) return;
  const buckets = ['videos', 'thumbnails', 'audio', 'image-layer'];
  for (const bucket of buckets) {
    const { error } = await supabaseAdmin.storage.createBucket(bucket, {
      public: bucket === 'thumbnails',
      fileSizeLimit: 524288000,
    });
    if (error && !/already exists|duplicate/i.test(String(error.message || error))) {
      console.error('Bucket creation error:', bucket, error);
    }
  }
}

async function signStoragePath(bucket, storagePath) {
  if (!supabaseAdmin || !bucket || !storagePath) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Upload buffer to Supabase; returns signed URL (private buckets) or public URL (thumbnails).
 */
async function uploadBufferToSupabase(bucket, storagePath, buffer, contentType) {
  const { error } = await supabaseAdmin.storage.from(bucket).upload(storagePath, buffer, {
    upsert: true,
    contentType: contentType || 'application/octet-stream',
  });
  if (error) throw new Error('Storage upload failed: ' + error.message);
  if (bucket === 'thumbnails') {
    const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(storagePath);
    return { permanentUrl: data.publicUrl, storagePath, bucket };
  }
  const signed = await signStoragePath(bucket, storagePath);
  return { permanentUrl: signed, storagePath, bucket };
}

async function hydrateTimelineMediaUrlsAsync(timeline) {
  if (!timeline || typeof timeline !== 'object' || !timeline.tracks) return timeline;
  const out = JSON.parse(JSON.stringify(timeline));
  const types = ['video', 'audio', 'image'];
  for (const tt of types) {
    const rows = out.tracks[tt];
    if (!Array.isArray(rows)) continue;
    for (const track of rows) {
      if (!track.elements) continue;
      for (const el of track.elements) {
        const ref = el.storageRef;
        if (ref && ref.bucket && ref.path) {
          const u = await signStoragePath(ref.bucket, ref.path);
          if (u) el.src = u;
        }
      }
    }
  }
  return out;
}

async function signVideoPathField(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') return videoPath;
  if (!videoPath.startsWith('storage:')) return videoPath;
  const rest = videoPath.slice('storage:'.length);
  const idx = rest.indexOf(':');
  if (idx === -1) return videoPath;
  const bucket = rest.slice(0, idx);
  const storagePath = rest.slice(idx + 1);
  const signed = await signStoragePath(bucket, storagePath);
  return signed || videoPath;
}

async function deleteStorageFolder(bucket, folderPrefix) {
  if (!supabaseAdmin) return;
  const { data: entries, error } = await supabaseAdmin.storage.from(bucket).list(folderPrefix, { limit: 1000 });
  if (error || !entries || !entries.length) return;
  const paths = entries.map(e => `${folderPrefix}/${e.name}`);
  await supabaseAdmin.storage.from(bucket).remove(paths);
}

// --- Projects CRUD (requireAuth on each route) ---
// Supabase migration (run once): store agent conversation without tracks snapshots:
//   alter table projects
//     add column if not exists conversation_history jsonb default '[]'::jsonb;

app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const { name, videoPath, duration } = req.body || {};
    const row = {
      user_id: req.user.id,
      name: name && String(name).trim() ? String(name).trim() : 'Untitled Project',
      timeline: {},
      duration: Number(duration) || 0,
      video_path: videoPath || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin.from('projects').insert(row).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create project' });
  }
});

app.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('id, name, thumbnail_url, duration, created_at, updated_at')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ projects: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list projects' });
  }
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Project not found' });
    if (data.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    let timeline = data.timeline;
    if (timeline && typeof timeline === 'object') {
      timeline = await hydrateTimelineMediaUrlsAsync(timeline);
    }
    const video_path = await signVideoPathField(data.video_path);
    res.json({ ...data, timeline, video_path });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load project' });
  }
});

app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', req.params.id)
      .single();
    if (exErr || !existing) return res.status(404).json({ error: 'Project not found' });
    if (existing.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { timeline, transcript, name, video_path, duration, thumbnail_url, conversation_history } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (timeline !== undefined) patch.timeline = timeline;
    if (transcript !== undefined) patch.transcript = transcript;
    if (conversation_history !== undefined) patch.conversation_history = conversation_history;
    if (name !== undefined) patch.name = String(name).trim() || 'Untitled Project';
    if (video_path !== undefined) patch.video_path = video_path;
    if (duration !== undefined) patch.duration = Number(duration) || 0;
    if (thumbnail_url !== undefined) patch.thumbnail_url = thumbnail_url;

    const { error } = await supabaseAdmin.from('projects').update(patch).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save project' });
  }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('projects')
      .select('user_id, id')
      .eq('id', req.params.id)
      .single();
    if (exErr || !existing) return res.status(404).json({ error: 'Project not found' });
    if (existing.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const uid = req.user.id;
    const pid = req.params.id;
    const prefix = `${uid}/${pid}`;
    await deleteStorageFolder('videos', prefix);
    await deleteStorageFolder('audio', prefix);
    await deleteStorageFolder('thumbnails', prefix);
    await deleteStorageFolder('image-layer', prefix);

    const { error } = await supabaseAdmin.from('projects').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete project' });
  }
});

// ---------------------------------------------------------------------------
// POST /upload
// ---------------------------------------------------------------------------

/**
 * Accepts multipart "video" file; multer saves to /uploads; response returns local URLs immediately.
 * Supabase Storage upload and project row thumbnail/video_path run in the background (non-blocking).
 * Optional form field projectId — if omitted, creates a new project row first.
 */
app.post('/upload', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Supabase is not configured' });
  }

  const userId = req.user.id;
  let projectId = req.body.projectId || req.body.project_id || null;
  const { filename, path: filePath, mimetype, originalname } = req.file;

  try {
    if (!projectId) {
      const { data: proj, error: pErr } = await supabaseAdmin
        .from('projects')
        .insert({
          user_id: userId,
          name: 'Untitled Project',
          timeline: {},
          duration: 0,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (pErr || !proj) throw new Error(pErr ? pErr.message : 'Could not create project');
      projectId = proj.id;
    } else {
      const { data: chk, error: cErr } = await supabaseAdmin
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .single();
      if (cErr || !chk || chk.user_id !== userId) {
        return res.status(403).json({ error: 'Invalid or forbidden projectId' });
      }
    }

    const isImage = mimetype.startsWith('image/');
    let finalPath = filePath;
    let finalFilename = filename;
    let duration = 0;
    let width = 0;
    let height = 0;
    let isImageOut = false;

    if (isImage) {
      log(`Image upload received: ${filename} — converting to mp4...`);
      const conv = await convertImageToVideo(filePath, 10);
      finalPath = conv.outputPath;
      finalFilename = path.basename(finalPath);
      duration = conv.duration;
      width = conv.width;
      height = conv.height;
      isImageOut = true;
    } else {
      duration = await getVideoDuration(filePath);
      if (mimetype.startsWith('video/')) {
        try {
          const meta = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, m) => (err ? reject(err) : resolve(m)));
          });
          const vs = (meta.streams || []).find(s => s.codec_type === 'video');
          if (vs) {
            width = vs.width || 0;
            height = vs.height || 0;
          }
        } catch (_) { /* non-fatal */ }
      }
    }

    const isAudio = mimetype.startsWith('audio/') && !isImageOut;
    const localUrl = '/uploads/' + finalFilename;

    const uploadJson = {
      filename: finalFilename,
      path: localUrl,
      permanentUrl: localUrl,
      storageRef: null,
      projectId,
      duration,
      originalFilename: originalname,
      isImage: isImageOut,
      width,
      height,
      thumbnailUrl: null,
    };
    if (!isAudio) {
      uploadJson.recommendedTrack = isImage ? 'image' : 'video';
    }

    // ── Step 1: fast local processing (multer has already saved the file) ──
    res.json(uploadJson);

    // ── Step 2: background Supabase work (does not block response) ─────────
    setImmediate(() => {
      void (async () => {
        try {
          const bucket = isAudio ? 'audio' : (isImage ? 'image-layer' : 'videos');
          const storagePath = `${userId}/${projectId}/${finalFilename}`;
          const buf = fs.readFileSync(finalPath);
          const contentType = isAudio ? mimetype : 'video/mp4';

          await uploadBufferToSupabase(bucket, storagePath, buf, contentType);

          let thumbnailUrl = null;
          if (!isAudio) {
            try {
              const thumbLocal = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`);
              await extractThumbnailAtPercent(finalPath, 10, thumbLocal);
              const thumbBuf = fs.readFileSync(thumbLocal);
              const thumbPath = `${userId}/${projectId}/poster.jpg`;
              try {
                const upThumb = await uploadBufferToSupabase(
                  'thumbnails',
                  thumbPath,
                  thumbBuf,
                  'image/jpeg',
                );
                thumbnailUrl = upThumb.permanentUrl;
              } catch (thumbStorageErr) {
                log(`Thumbnail storage upload failed (non-fatal): ${thumbStorageErr.message}`);
              }
              try {
                fs.unlinkSync(thumbLocal);
              } catch (_) {
                /* ignore */
              }
            } catch (te) {
              log(`Thumbnail extraction skipped: ${te.message}`);
            }
          }

          try {
            await supabaseAdmin
              .from('projects')
              .update({
                duration: duration || 0,
                thumbnail_url: thumbnailUrl,
                video_path: `storage:${bucket}:${storagePath}`,
                updated_at: new Date().toISOString(),
              })
              .eq('id', projectId);
          } catch (dbErr) {
            log('Project update after background upload failed (non-fatal): ' + dbErr.message);
          }

          log(`Background storage upload complete: ${bucket}/${storagePath}`);
        } catch (err) {
          log(`Background storage upload failed (non-fatal): ${err.message}`);
        }
      })();
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to process upload: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /generate
// ---------------------------------------------------------------------------

/**
 * Runs Claude operations generation.
 * Optionally transcribes audio if no transcript is provided in the request.
 * Does NOT render — rendering is triggered by POST /export.
 *
 * Request body:
 *   videoPath     {string}        Served URL path returned by POST /upload (e.g. '/uploads/filename.mp4')
 *   prompt        {string}        User's natural-language edit instruction
 *   currentTracks {object}        Current tracks object from timeline state
 *   transcript    {Array|null}    Cached transcript (skip transcription if provided)
 *   language      {string|null}   Optional Whisper language hint (e.g. "turkish")
 *   presetName    {string|null}   Optional preset (Stage 3)
 *   conversationExchanges {Array<object>} Optional structured prior exchanges (see generate.js)
 *
 * Response: { operations, transcript, warnings?, isExplanation?, claudeUsage?, llmCacheHit?, llmCache? }
   */
app.post('/generate', requireAuth, async (req, res) => {
  const {
    videoPath,
    prompt,
    currentTracks,
    transcript: providedTranscript,
    language,
    presetName,
    conversationExchanges,
  } = req.body;

  if (!videoPath)      return res.status(400).json({ error: 'videoPath is required' });
  if (!prompt)         return res.status(400).json({ error: 'prompt is required' });
  if (!currentTracks)  return res.status(400).json({ error: 'currentTracks is required' });

  let tmpVideoPath = null;
  let resolvedVideoPath;

  if (/^https?:\/\//i.test(String(videoPath))) {
    try {
      tmpVideoPath = path.join(os.tmpdir(), `vibe-gen-${Date.now()}.mp4`);
      const resp = await axios.get(videoPath, { responseType: 'arraybuffer', maxContentLength: MAX_UPLOAD_BYTES });
      fs.writeFileSync(tmpVideoPath, Buffer.from(resp.data));
      resolvedVideoPath = tmpVideoPath;
    } catch (e) {
      return res.status(400).json({ error: `Could not download video for transcription: ${e.message}` });
    }
  } else {
    resolvedVideoPath = videoPath.startsWith('/')
      ? path.join(__dirname, '..', videoPath.replace(/^\//, ''))
      : videoPath;
  }

  if (!fs.existsSync(resolvedVideoPath)) {
    return res.status(400).json({ error: `Video file not found: ${resolvedVideoPath}` });
  }

  try {
    // ── Step 1: Transcribe (only if no transcript was cached on the frontend) ─
    let transcript = providedTranscript || null;
    if (!transcript) {
      log('Step 1/2 — Extracting audio for transcription...');
      const audioPath = await extractAudio(resolvedVideoPath);
      log(`Audio extracted → ${audioPath}`);

      log('Step 2/2 — Transcribing with OpenAI (whisper-1)...');
      transcript = await getOrTranscribeAudio({
        audioPath,
        language: language || null,
        supabaseAdmin,
      });
      log(`Transcription complete — ${transcript.length} segments`);
    } else {
      log('Transcript provided — skipping extraction and transcription');
    }

    // ── Step 2: Get source duration ──────────────────────────────────────────
    const sourceDuration = await getVideoDuration(resolvedVideoPath);

    // ── Step 3: Generate operations via OpenAI ───────────────────────────────
    log('Generating operations with OpenAI...');
    const uploadedAudioFiles = scanUploadedAudio();
    const priorEx = Array.isArray(conversationExchanges) ? conversationExchanges : [];

    const generateCachePayload = {
      userId:                 req.user.id,
      prompt:                 String(prompt),
      currentTracks,
      transcript,
      sourceDuration,
      uploadedAudioFiles,
      conversationExchanges:  priorEx,
    };
    const generateCacheKey = generateLlmCache.keyForPayload(generateCachePayload);
    const cachedGenerate = generateLlmCache.get(generateCacheKey);
    let result;
    if (cachedGenerate) {
      log(`LLM response cache HIT (${generateLlmCache.name}) key=${generateCacheKey.slice(0, 12)}…`);
      result = cachedGenerate;
    } else {
      result = await generateOperations(
        prompt,
        currentTracks,
        transcript,
        sourceDuration,
        uploadedAudioFiles,
        priorEx,
        req.user.id
      );
      generateLlmCache.set(generateCacheKey, result);
      log(`LLM response cache MISS (${generateLlmCache.name}) key=${generateCacheKey.slice(0, 12)}…`);
    }

    const {
      operations,
      warnings,
      isExplanation,
      claudeUsage,
      modelUsed,
      fallback,
    } = result;
    const usageOut = cachedGenerate
      ? {
        inputTokens:              0,
        outputTokens:             0,
        totalTokens:              0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens:     0,
      }
      : (claudeUsage && typeof claudeUsage === 'object' ? claudeUsage : null);

    log(`Operations generated — ${operations.length} operation(s)`);
    if (usageOut && typeof usageOut.totalTokens === 'number') {
      log(`LLM tokens — in: ${usageOut.inputTokens} · out: ${usageOut.outputTokens} · total: ${usageOut.totalTokens}`);
    }
    if (warnings && warnings.length > 0) {
      log(`Warnings: ${warnings.join('; ')}`);
    }
    if (isExplanation) {
      log('Response classified as explanation (no operations)');
    }

    res.json({
      operations:     operations || [],
      transcript,
      warnings:       warnings != null && Array.isArray(warnings) ? warnings : [],
      isExplanation:  !!isExplanation,
      claudeUsage:    usageOut,
      modelUsed:      modelUsed != null ? modelUsed : null,
      fallback:       fallback === true,
      llmCacheHit:    !!cachedGenerate,
      llmCache:       cachedGenerate ? { scope: 'generate', keyPrefix: generateCacheKey.slice(0, 12) } : null,
    });

  } catch (err) {
    log(`Pipeline error: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpVideoPath) {
      try { if (fs.existsSync(tmpVideoPath)) fs.unlinkSync(tmpVideoPath); } catch (_) { /* ignore */ }
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/summarize-conversation
// Compresses up to 10 editing exchanges via a separate LLM call (after edits complete).
// ---------------------------------------------------------------------------
app.post('/api/summarize-conversation', requireAuth, async (req, res) => {
  try {
    const { exchanges } = req.body || {};
    if (!Array.isArray(exchanges) || exchanges.length === 0) {
      return res.status(400).json({ error: 'exchanges must be a non-empty array' });
    }
    if (exchanges.length > 10) {
      return res.status(400).json({ error: 'exchanges must contain at most 10 items' });
    }

    const sumKeyPayload = { userId: req.user.id, exchanges };
    const sumKey = summarizeLlmCache.keyForPayload(sumKeyPayload);
    const cachedSum = summarizeLlmCache.get(sumKey);
    let text;
    if (cachedSum && typeof cachedSum.summary === 'string') {
      text = cachedSum.summary;
      log(`LLM response cache HIT (${summarizeLlmCache.name}) key=${sumKey.slice(0, 12)}…`);
    } else {
      text = await summarizeEditingConversation(exchanges, req.user.id);
      summarizeLlmCache.set(sumKey, { summary: text });
      log(`LLM response cache MISS (${summarizeLlmCache.name}) key=${sumKey.slice(0, 12)}…`);
    }

    res.json({
      summary:     text,
      llmCacheHit: !!cachedSum,
      llmCache:    cachedSum ? { scope: 'summarize', keyPrefix: sumKey.slice(0, 12) } : null,
    });
  } catch (err) {
    log(`summarize-conversation error: ${err.message}`);
    res.status(500).json({ error: err.message || 'Summarization failed' });
  }
});

// ---------------------------------------------------------------------------
// Pexels stock + visual pipeline (server-side only — key never sent to browser)
// SMOKE TEST:
// 1. GET /api/pexels/search?q=Mother+Reviewing+Homework&asset_type=videos
//    → expect results array, all items portrait orientation, source: "pexels"
// 2. GET /api/pexels/search?q=Mother+Reviewing+Homework&asset_type=all
//    → expect interleaved photos and videos
// 3. GET /api/pexels/search (no q param) → expect 400
// 4. Run Scan for Visuals end-to-end → confirm searchQuery appears in brief response
//    and is used (not the full description) in the Pexels search call
// 5. Accept a visual → confirm attribution renders in the UI
// 6. GET /api/_debug/cache → confirm "pixabay" no longer appears, "pexels" does
// ---------------------------------------------------------------------------

const SEARCH_QUERY_BANNED_RE =
  /\b(worried|concerned|stressed|framing|shot|scene|candid|authentic|warm|cozy|natural|domestic|slightly|gently|carefully)\b/i;
const SEARCH_QUERY_BANNED_WORDS = new Set([
  'worried', 'concerned', 'stressed', 'framing', 'shot', 'scene', 'candid', 'authentic',
  'warm', 'cozy', 'natural', 'domestic', 'slightly', 'gently', 'carefully',
]);

function fallbackSearchQueryFromCandidate(candidate) {
  const desc = String(
    (candidate && candidate.ideal_visual_description) ||
    (candidate && candidate.retrieval_query_primary) ||
    ''
  ).trim();
  const words = desc.split(/\s+/).filter(Boolean);
  const first6 = words.slice(0, 6);
  const filtered = first6.filter(w => {
    const alpha = w.replace(/[^a-zA-Z]/g, '');
    if (!alpha) return false;
    return !SEARCH_QUERY_BANNED_WORDS.has(alpha.toLowerCase());
  });
  let out = filtered.join(' ').trim();
  if (!out) out = 'Person Working at Desk';
  if (out.length > 80) out = out.slice(0, 80);
  return out;
}

function isSearchQueryValid(sq) {
  if (sq == null) return false;
  const t = String(sq).trim();
  if (!t || t.length > 80) return false;
  if (SEARCH_QUERY_BANNED_RE.test(t)) return false;
  return true;
}

/**
 * @param {object|null} brief
 * @param {object} candidate
 * @returns {object|null}
 */
function applySearchQueryToBrief(brief, candidate) {
  if (!brief || typeof brief !== 'object') return brief;
  const raw = brief.searchQuery;
  if (isSearchQueryValid(raw)) {
    brief.searchQuery = String(raw).trim();
  } else {
    log(
      '[visual-brief] searchQuery missing/invalid; fallback from description — ' +
      `candidate=${brief.candidate_id || '?'}`
    );
    brief.searchQuery = fallbackSearchQueryFromCandidate(candidate);
  }
  return brief;
}

function selectBestPexelsVideoFile(videoFiles) {
  if (!Array.isArray(videoFiles) || !videoFiles.length) return null;
  const withDims = videoFiles.filter(f => f && Number(f.width) > 0 && Number(f.height) > 0);
  const pool = withDims.length ? withDims : videoFiles;
  const portrait = pool.filter(f => Number(f.height) > Number(f.width));
  const use = portrait.length ? portrait : pool;
  return use.sort(
    (a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height)
  )[0];
}

function forwardPexelsRateHeadersFromFetch(resp, res) {
  if (!resp || !resp.headers || !res) return;
  const rem = resp.headers.get('x-ratelimit-remaining');
  const reset = resp.headers.get('x-ratelimit-reset');
  if (rem) res.setHeader('X-Ratelimit-Remaining', rem);
  if (reset) res.setHeader('X-Ratelimit-Reset', reset);
}

function normalizePexelsPhoto(hit) {
  const src = hit.src || {};
  const altRaw = hit.alt;
  const alt = altRaw != null && String(altRaw).trim() ? String(altRaw).trim() : null;
  return {
    id: String(hit.id),
    type: 'photo',
    width: Number(hit.width) || 0,
    height: Number(hit.height) || 0,
    duration: null,
    thumbnail: src.medium || src.small || src.tiny || '',
    url: src.original || src.large2x || src.large || '',
    pexelsUrl: String(hit.url || ''),
    photographer: String(hit.photographer || ''),
    photographerUrl: String(hit.photographer_url || ''),
    alt,
  };
}

function normalizePexelsVideo(hit) {
  const user = hit.user || {};
  const best = selectBestPexelsVideoFile(hit.video_files);
  const link = best && best.link ? String(best.link) : '';
  return {
    id: String(hit.id),
    type: 'video',
    width: Number(hit.width) || 0,
    height: Number(hit.height) || 0,
    duration: typeof hit.duration === 'number' ? hit.duration : (hit.duration != null ? Number(hit.duration) : null),
    thumbnail: String(hit.image || ''),
    url: link,
    pexelsUrl: String(hit.url || ''),
    photographer: String(user.name || ''),
    photographerUrl: String(user.url || ''),
    alt: null,
  };
}

function interleavePexelsResults(videos, photos) {
  const out = [];
  const n = Math.max(videos.length, photos.length);
  for (let i = 0; i < n; i++) {
    if (i < videos.length) out.push(videos[i]);
    if (i < photos.length) out.push(photos[i]);
  }
  return out;
}

function pexelsPhotoSearchUrl(q, perPage) {
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', q);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('orientation', 'portrait');
  u.searchParams.set('locale', 'en-US');
  return u.toString();
}

function pexelsVideoSearchUrl(q, perPage) {
  const u = new URL('https://api.pexels.com/videos/search');
  u.searchParams.set('query', q);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('orientation', 'portrait');
  u.searchParams.set('locale', 'en-US');
  return u.toString();
}

app.get('/api/pexels/search', requireAuth, async (req, res) => {
  const key = process.env.PEXELS_API_KEY;
  if (!key || !String(key).trim()) {
    return res.status(503).json({ results: [], error: 'PEXELS_API_KEY not configured' });
  }
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q is required' });
  }
  let assetType = String(req.query.asset_type || 'all').toLowerCase();
  if (assetType !== 'photos' && assetType !== 'videos' && assetType !== 'all') {
    assetType = 'all';
  }
  let perPage = parseInt(String(req.query.per_page || '15'), 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 15;
  perPage = Math.min(80, Math.max(1, perPage));

  const cacheKey = `${assetType}:${q}`;
  const cachedVal = pexelsLRU.get(cacheKey);
  if (cachedVal !== undefined) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({ ...cachedVal, cache: 'HIT' });
  }

  const authKey = String(key).trim();
  const authHeaders = { Authorization: authKey };

  const readPexelsError = (resp, text) => {
    log(`[pexels-search] upstream status=${resp.status} body=${(text || '').slice(0, 800)}`);
  };

  try {
    if (assetType === 'photos') {
      const url = pexelsPhotoSearchUrl(q, perPage);
      const resp = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(25000) });
      const text = await resp.text();
      if (!resp.ok) {
        readPexelsError(resp, text);
        return res.status(502).json({ error: 'Pexels stock search failed' });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return res.status(502).json({ error: 'Pexels stock search failed' });
      }
      forwardPexelsRateHeadersFromFetch(resp, res);
      res.setHeader('X-Cache', 'MISS');
      const results = (data.photos || []).map(normalizePexelsPhoto);
      const body = {
        results,
        total_results: data.total_results != null ? Number(data.total_results) : results.length,
        warnings: [],
        source: 'pexels',
      };
      pexelsLRU.set(cacheKey, body);
      return res.json({ ...body, cache: 'MISS' });
    }
    if (assetType === 'videos') {
      const url = pexelsVideoSearchUrl(q, perPage);
      const resp = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(25000) });
      const text = await resp.text();
      if (!resp.ok) {
        readPexelsError(resp, text);
        return res.status(502).json({ error: 'Pexels stock search failed' });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return res.status(502).json({ error: 'Pexels stock search failed' });
      }
      forwardPexelsRateHeadersFromFetch(resp, res);
      res.setHeader('X-Cache', 'MISS');
      const results = (data.videos || []).map(normalizePexelsVideo).filter(x => x.url);
      const body = {
        results,
        total_results: data.total_results != null ? Number(data.total_results) : results.length,
        warnings: [],
        source: 'pexels',
      };
      pexelsLRU.set(cacheKey, body);
      return res.json({ ...body, cache: 'MISS' });
    }

    // asset_type === 'all'
    const urlV = pexelsVideoSearchUrl(q, perPage);
    const urlP = pexelsPhotoSearchUrl(q, perPage);
    const [vOutcome, pOutcome] = await Promise.all([
      (async () => {
        try {
          const r = await fetch(urlV, { headers: authHeaders, signal: AbortSignal.timeout(25000) });
          const t = await r.text();
          return { r, t };
        } catch (e) {
          return { err: e };
        }
      })(),
      (async () => {
        try {
          const r = await fetch(urlP, { headers: authHeaders, signal: AbortSignal.timeout(25000) });
          const t = await r.text();
          return { r, t };
        } catch (e) {
          return { err: e };
        }
      })(),
    ]);

    const warnings = [];
    let vData = { videos: [], total_results: 0 };
    let pData = { photos: [], total_results: 0 };
    let rateFrom = null;

    if (vOutcome.err) {
      log(`[pexels-search] videos parallel error: ${vOutcome.err.message || vOutcome.err}`);
      warnings.push('videos: request failed');
    } else {
      rateFrom = vOutcome.r;
      if (!vOutcome.r.ok) {
        readPexelsError(vOutcome.r, vOutcome.t);
        warnings.push('videos: upstream request failed');
      } else {
        try {
          vData = JSON.parse(vOutcome.t);
        } catch (_) {
          warnings.push('videos: invalid response');
        }
      }
    }

    if (pOutcome.err) {
      log(`[pexels-search] photos parallel error: ${pOutcome.err.message || pOutcome.err}`);
      warnings.push('photos: request failed');
    } else {
      if (!rateFrom) rateFrom = pOutcome.r;
      if (!pOutcome.r.ok) {
        readPexelsError(pOutcome.r, pOutcome.t);
        warnings.push('photos: upstream request failed');
      } else {
        try {
          pData = JSON.parse(pOutcome.t);
        } catch (_) {
          warnings.push('photos: invalid response');
        }
      }
    }

    if (rateFrom) forwardPexelsRateHeadersFromFetch(rateFrom, res);
    res.setHeader('X-Cache', 'MISS');

    const vNorm = (vData.videos || []).map(normalizePexelsVideo).filter(x => x.url);
    const pNorm = (pData.photos || []).map(normalizePexelsPhoto);
    const interleaved = interleavePexelsResults(vNorm, pNorm).slice(0, perPage);
    const total_results =
      (vData.total_results != null ? Number(vData.total_results) : 0) +
      (pData.total_results != null ? Number(pData.total_results) : 0);

    const body = {
      results: interleaved,
      total_results: Number.isFinite(total_results) ? total_results : interleaved.length,
      warnings: warnings.length ? warnings : [],
      source: 'pexels',
    };
    pexelsLRU.set(cacheKey, body);
    return res.json({ ...body, cache: 'MISS' });
  } catch (err) {
    log(`[pexels-search] ${err.message || err}`);
    return res.status(502).json({ error: 'Pexels stock search failed' });
  }
});

app.post('/api/pexels/ingest', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { asset, projectId } = req.body || {};
  if (!asset || typeof asset !== 'object' || !projectId) {
    return res.status(400).json({ error: 'asset and projectId are required' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Storage is not configured' });
  const { data: chk } = await supabaseAdmin.from('projects').select('user_id').eq('id', projectId).single();
  if (!chk || chk.user_id !== userId) return res.status(403).json({ error: 'Invalid project' });

  const type = String(asset.type || '').toLowerCase();
  const isPhoto = type === 'photo';
  const mediaUrl = String(asset.url || '').trim();
  if (!mediaUrl) return res.status(400).json({ error: 'asset.url is required' });

  const uid = randomUUID();
  const ext = isPhoto ? '.jpg' : '.mp4';
  const tmpDl = path.join(os.tmpdir(), `pexels_dl_${uid}${ext}`);
  let uploadPath = tmpDl;
  let tmpConvertPath = null;

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30000);
    let resp;
    try {
      resp = await fetch(mediaUrl, { signal: ac.signal });
    } finally {
      clearTimeout(to);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      log(`[pexels-ingest] download failed status=${resp.status} body=${t.slice(0, 400)}`);
      return res.status(502).json({ error: 'Failed to download asset from Pexels' });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf || !buf.length) {
      return res.status(502).json({ error: 'Downloaded file was empty' });
    }
    fs.writeFileSync(tmpDl, buf);

    let outW = Number(asset.width) || 0;
    let outH = Number(asset.height) || 0;
    let outDuration = typeof asset.duration === 'number' && asset.duration > 0 ? asset.duration : null;

    if (isPhoto) {
      const conv = await convertImageToVideo(tmpDl, 5);
      tmpConvertPath = conv.outputPath;
      uploadPath = conv.outputPath;
      outDuration = conv.duration;
      outW = conv.width > 0 ? conv.width : outW;
      outH = conv.height > 0 ? conv.height : outH;
      try { if (fs.existsSync(tmpDl)) fs.unlinkSync(tmpDl); } catch (_) { /* ignore */ }
    } else if (outDuration == null || outDuration <= 0) {
      outDuration = await getVideoDuration(uploadPath);
    }

    const fileBase = `pexels_${String(asset.id || uid).replace(/[^\w-]/g, '_')}_${uid.slice(0, 8)}.mp4`;
    const storagePath = `${userId}/${projectId}/${fileBase}`;
    const upBuf = fs.readFileSync(uploadPath);
    const up = await uploadBufferToSupabase('image-layer', storagePath, upBuf, 'video/mp4');

    const thumb = String(asset.thumbnail || '');
    const pexU = String(asset.pexelsUrl || 'https://www.pexels.com/');
    const pName = String(asset.photographer || '');
    const pUrl = String(asset.photographerUrl || pexU);
    const isVid = !isPhoto;
    const attribution = isVid
      ? {
        photographer: pName,
        photographerUrl: pUrl,
        pexelsUrl: pexU,
        text: 'Video provided by Pexels',
      }
      : {
        photographer: pName,
        photographerUrl: pUrl,
        pexelsUrl: pexU,
        text: 'Photo provided by Pexels',
      };

    return res.json({
      permanentUrl: up.permanentUrl,
      storageRef: { bucket: 'image-layer', path: storagePath },
      width: outW,
      height: outH,
      duration: outDuration != null && outDuration > 0 ? outDuration : 5,
      thumbnail: thumb,
      filename: fileBase,
      attribution,
    });
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'Download timed out' : (err.message || 'Ingest failed');
    if (err && err.name === 'AbortError') {
      return res.status(502).json({ error: 'Failed to download asset from Pexels' });
    }
    log(`[pexels-ingest] ${msg}`);
    return res.status(502).json({ error: 'Failed to download or process asset' });
  } finally {
    try { if (fs.existsSync(tmpDl)) fs.unlinkSync(tmpDl); } catch (_) { /* ignore */ }
    if (tmpConvertPath) {
      try { if (fs.existsSync(tmpConvertPath) && tmpConvertPath !== tmpDl) fs.unlinkSync(tmpConvertPath); } catch (_) { /* ignore */ }
    }
  }
});

app.post('/api/visual/scan', requireAuth, async (req, res) => {
  try {
    const { transcript, stylePolicy, keyMomentsPolicy, visualContext } = req.body || {};
    const scanPayload = {
      userId:           req.user.id,
      transcript,
      stylePolicy:      stylePolicy || {},
      keyMomentsPolicy: keyMomentsPolicy || {},
      visualContext:    visualContext || {},
      opts:             {},
    };
    const scanKey = visualScanLlmCache.keyForPayload(scanPayload);
    const cachedScan = visualScanLlmCache.get(scanKey);
    let candidates;
    if (cachedScan && Array.isArray(cachedScan.candidates)) {
      candidates = cachedScan.candidates;
      log(`LLM response cache HIT (${visualScanLlmCache.name}) key=${scanKey.slice(0, 12)}…`);
    } else {
      candidates = await generateVisualCandidates(
        transcript,
        stylePolicy || {},
        keyMomentsPolicy || {},
        visualContext || {},
        {},
        req.user.id
      );
      visualScanLlmCache.set(scanKey, { candidates });
      log(`LLM response cache MISS (${visualScanLlmCache.name}) key=${scanKey.slice(0, 12)}…`);
    }
    res.json({
      candidates,
      llmCacheHit: !!cachedScan,
      llmCache:    cachedScan ? { scope: 'visual_scan', keyPrefix: scanKey.slice(0, 12) } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'visual scan failed' });
  }
});

app.post('/api/visual/brief', requireAuth, async (req, res) => {
  try {
    const { candidate, transcript, stylePolicy } = req.body || {};
    if (!candidate) return res.status(400).json({ error: 'candidate is required' });
    const st = candidate.start_time != null ? candidate.start_time : candidate.startTime;
    const ctx = extractTranscriptContext(transcript || [], st, 10);
    const briefPayload = {
      userId:        req.user.id,
      candidate,
      transcriptCtx: ctx,
      stylePolicy:   stylePolicy || {},
      stockProvider: 'pexels',
    };
    const briefKey = visualBriefLlmCache.keyForPayload(briefPayload);
    const cachedBrief = visualBriefLlmCache.get(briefKey);
    let brief;
    if (cachedBrief && Object.prototype.hasOwnProperty.call(cachedBrief, 'brief')) {
      brief = cachedBrief.brief;
      log(`LLM response cache HIT (${visualBriefLlmCache.name}) key=${briefKey.slice(0, 12)}…`);
    } else {
      brief = await generateRetrievalBrief(candidate, ctx, stylePolicy || {}, req.user.id);
      visualBriefLlmCache.set(briefKey, { brief });
      log(`LLM response cache MISS (${visualBriefLlmCache.name}) key=${briefKey.slice(0, 12)}…`);
    }
    if (brief) {
      applySearchQueryToBrief(brief, candidate);
    }
    res.json({
      brief,
      llmCacheHit: !!cachedBrief,
      llmCache:    cachedBrief ? { scope: 'visual_brief', keyPrefix: briefKey.slice(0, 12) } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'visual brief failed' });
  }
});

app.post('/api/visual/claude-pick', requireAuth, async (req, res) => {
  try {
    const { candidate, assets } = req.body || {};
    const pickPayload = {
      userId:   req.user.id,
      candidate: candidate || {},
      assets:    Array.isArray(assets) ? assets : [],
      stockProvider: 'pexels',
    };
    const pickKey = visualPickLlmCache.keyForPayload(pickPayload);
    const cachedPick = visualPickLlmCache.get(pickKey);
    let out;
    if (cachedPick && cachedPick.chosen_id != null) {
      out = cachedPick;
      log(`LLM response cache HIT (${visualPickLlmCache.name}) key=${pickKey.slice(0, 12)}…`);
    } else {
      out = await visualPipelineAiPick(
        candidate || {},
        Array.isArray(assets) ? assets : [],
        req.user.id
      );
      visualPickLlmCache.set(pickKey, out);
      log(`LLM response cache MISS (${visualPickLlmCache.name}) key=${pickKey.slice(0, 12)}…`);
    }
    res.json({
      ...out,
      llmCacheHit: !!cachedPick,
      llmCache:    cachedPick ? { scope: 'visual_pick', keyPrefix: pickKey.slice(0, 12) } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'visual pick failed' });
  }
});

/**
 * POST /api/visual/generate-image
 * Generates an image from a candidate's ideal_visual_description (with
 * fallback to reason + translation if unavailable). Returns the PNG as
 * base64 without uploading anywhere. The client holds the preview; only
 * on Accept does /api/visual/accept-generated persist to Supabase.
 *
 * NOTE on base64 transport: each image is ~1-3 MB. At current scale this
 * is fine (localhost or single-user sessions); if usage grows, replace
 * with a server-side temp store keyed by token and return the token
 * instead of the bytes. The endpoint shape would stay the same.
 */
app.post('/api/visual/generate-image', requireAuth, async (req, res) => {
  const { candidate } = req.body || {};
  if (!candidate || typeof candidate !== 'object') {
    return res.status(400).json({ error: 'candidate is required' });
  }

  // Prefer Pass 1's rich description. Fall back for candidates from older
  // scans that predate the schema extension.
  const description =
    String(candidate.ideal_visual_description || '').trim() ||
    [
      candidate.reason || '',
      candidate.spoken_text_translation || candidate.spoken_text_anchor || '',
    ]
      .filter(Boolean)
      .join('. ')
      .trim();

  if (!description) {
    return res.status(400).json({
      error: 'candidate has no ideal_visual_description or usable fallback',
    });
  }

  try {
    const gen = await generateImageFromDescription(description);
    const base64 = gen.pngBuffer.toString('base64');

    log(
      `[visual-generate] candidate=${candidate.candidate_id || '?'} ` +
      `model=${gen.model} size=${gen.pngBuffer.length}B`
    );

    return res.json({
      base64,
      mimeType: gen.mimeType,
      model: gen.model,
      promptUsed: gen.promptUsed,
    });
  } catch (err) {
    log(`[visual-generate] generation failed: ${err.message}`);
    return res.status(502).json({ error: err.message || 'Image generation failed' });
  }
});

/**
 * POST /api/visual/accept-generated
 * Accepts a base64-encoded PNG previously returned by
 * /api/visual/generate-image, converts it to a 5s MP4, and uploads to
 * the image-layer bucket. Returns permanentUrl + storageRef in the same
 * shape as /api/pexels/ingest so the client-side CREATE dispatch is
 * symmetric with stock.
 */
app.post('/api/visual/accept-generated', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { base64, projectId, durationSec, candidateId } = req.body || {};

  if (!base64 || typeof base64 !== 'string') {
    return res.status(400).json({ error: 'base64 image data is required' });
  }
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  // Ownership check — same pattern as /api/pexels/ingest.
  const { data: chk } = await supabaseAdmin
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();
  if (!chk || chk.user_id !== userId) {
    return res.status(403).json({ error: 'Invalid project' });
  }

  const clipDuration =
    typeof durationSec === 'number' && durationSec > 0 ? durationSec : 5;
  const tag = candidateId ? String(candidateId).replace(/[^\w-]/g, '') : 'gen';
  const tmpBase = path.join(
    os.tmpdir(),
    `aigen_${userId}_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  );
  const tmpPng = tmpBase + '.png';

  let pngBuffer;
  try {
    pngBuffer = Buffer.from(base64, 'base64');
    if (!pngBuffer || pngBuffer.length === 0) {
      throw new Error('decoded buffer is empty');
    }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid base64 image data' });
  }

  try {
    fs.writeFileSync(tmpPng, pngBuffer);
    const conv = await convertImageToVideo(tmpPng, clipDuration);
    const uploadPath = conv.outputPath;
    const outDuration = conv.duration || clipDuration;

    const filename = `aigen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`;
    const storagePath = `${userId}/${projectId}/${filename}`;
    const buf = fs.readFileSync(uploadPath);
    const up = await uploadBufferToSupabase(
      'image-layer',
      storagePath,
      buf,
      'video/mp4'
    );

    try { fs.unlinkSync(tmpPng); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(uploadPath); } catch (_) { /* ignore */ }

    log(
      `[visual-accept] candidate=${tag} uploaded=${storagePath} duration=${outDuration}s`
    );

    return res.json({
      permanentUrl: up.permanentUrl,
      storageRef: { bucket: 'image-layer', path: storagePath },
      duration: outDuration,
      filename,
    });
  } catch (err) {
    try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch (_) { /* ignore */ }
    log(`[visual-accept] upload failed: ${err.message}`);
    return res.status(500).json({
      error: err.message || 'Accept / upload failed',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /export  (stub — full implementation after frontend is complete)
// ---------------------------------------------------------------------------
// Export job store
// ---------------------------------------------------------------------------

/** In-memory map of jobId → { status, progress, filename, error } */
const exportJobs = new Map();

/**
 * Remotion output scale from quality preset (portrait 1080×1920 base composition).
 */
const REMOTION_QUALITY_SCALE = {
  '720p':  720 / 1080,
  '1080p': 1,
  '4k':    3840 / 1080,
};

/**
 * runExportJob
 * Writes a serialized Remotion composition (GeneratedVideo.jsx), then runs
 * `npx remotion render` with timeline-derived frame count and optional scale/codec.
 *
 * @param {string}  jobId
 * @param {object}  timelineState  Full state object from the browser
 * @param {string}  outputFilename Desired filename (e.g. "project_1080p.mp4")
 * @param {string}  format         'mp4' | 'mov'
 * @param {string}  quality        '720p' | '1080p' | '4k'
 */
async function runExportJob(jobId, timelineState, outputFilename, format, quality) {
  const projectRoot = path.join(__dirname, '..');
  const outputDir   = path.join(projectRoot, 'output');
  const safeName    = path.basename(outputFilename || 'export.mp4');
  const outputPath  = path.join(outputDir, safeName);
  const compDir     = path.join(__dirname, 'compositions');
  const jsxPath     = path.join(compDir, 'GeneratedVideo.jsx');
  const propsPath   = path.join(outputDir, '.render-export-props.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(compDir, { recursive: true });

  const job = exportJobs.get(jobId);
  if (!job) return;

  try {
    job.status   = 'running';
    job.progress = 1;
    exportJobs.set(jobId, { ...job });

    const { jsx, totalFrames } = serializeToRemotion(timelineState);
    fs.writeFileSync(jsxPath, jsx, 'utf8');
    fs.writeFileSync(
      propsPath,
      JSON.stringify(
        {
          durationInFrames: totalFrames,
          subtitles:      [],
          videoSrc:       null,
        },
        null,
        2
      ),
      'utf8'
    );

    const frameCount = totalFrames;
    const lastFrame  = Math.max(0, frameCount - 1);
    const scale      = REMOTION_QUALITY_SCALE[quality] || REMOTION_QUALITY_SCALE['1080p'];
    const isProRes   = format === 'mov';

    const args = [
      'remotion',
      'render',
      path.join('src', 'index.js'),
      'GeneratedVideo',
      path.join('output', safeName),
      `--frames=0-${lastFrame}`,
      '--overwrite',
      '--bundle-cache=false',
      '--disable-web-security',
      '--log=verbose',
      `--props=${propsPath}`,
    ];

    if (scale !== 1 && scale > 0) {
      args.push(`--scale=${scale}`);
    }

    if (isProRes) {
      args.push('--codec=prores');
    } else {
      args.push('--codec=h264');
    }

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    await new Promise((resolve, reject) => {
      const proc = spawn(npxCmd, args, {
        cwd:   projectRoot,
        env:   process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let logTail = '';

      const onChunk = (chunk) => {
        const s = chunk.toString();
        logTail = (logTail + s).slice(-8000);
        const m = s.match(/Rendered\s+(\d+)\s*\/\s*(\d+)/);
        if (m) {
          const cur = Number(m[1]);
          const tot = Number(m[2]);
          if (tot > 0) {
            job.progress = Math.min(99, Math.round((cur / tot) * 100));
            exportJobs.set(jobId, { ...job });
          }
        }
      };

      proc.stdout.on('data', onChunk);
      proc.stderr.on('data', onChunk);

      proc.on('error', (err) => {
        reject(err);
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else {
          const hint = logTail.trim().split('\n').slice(-12).join('\n');
          reject(new Error(
            `remotion render exited with code ${code}` + (hint ? `\n${hint}` : '')
          ));
        }
      });
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Render finished but output file is missing');
    }

    const renderHash = computeRenderHash(timelineState, { format, quality });
    saveRenderToCache(projectRoot, renderHash, format, outputPath);

    job.status    = 'done';
    job.progress  = 100;
    job.filename  = safeName;
    exportJobs.set(jobId, { ...job });
    log(`Export done → ${safeName}`);
  } catch (err) {
    const job2 = exportJobs.get(jobId) || {};
    job2.status  = 'error';
    job2.error   = err.message;
    exportJobs.set(jobId, job2);
    log(`Export error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// POST /export
// ---------------------------------------------------------------------------

/**
 * Enqueues a new render job and returns { jobId } immediately.
 *
 * Request body:
 *   timelineState  {object}  Full timeline state from the frontend
 *   outputFilename {string}  Desired output filename
 *   format         {string}  'mp4' | 'mov'
 *   quality        {string}  '720p' | '1080p' | '4k'
 */
app.post('/export', requireAuth, (req, res) => {
  const { timelineState, outputFilename, format, quality } = req.body;
  if (!timelineState) return res.status(400).json({ error: 'timelineState is required' });

  const jobId    = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const filename = path.basename(
    outputFilename || ('export_' + Date.now() + (format === 'mov' ? '.mov' : '.mp4'))
  );
  const fmt      = ['mp4', 'mov'].includes(format) ? format : 'mp4';
  const qual     = ['720p', '1080p', '4k'].includes(quality) ? quality : '1080p';

  const projectRoot = path.join(__dirname, '..');
  const outputDir   = path.join(projectRoot, 'output');
  if (cacheTranscriptRenderEnabled()) {
    const rh = computeRenderHash(timelineState, { format: fmt, quality: qual });
    const cachePath = renderCacheFilePath(projectRoot, rh, fmt);
    if (fs.existsSync(cachePath)) {
      try {
        fs.mkdirSync(outputDir, { recursive: true });
        const dest = path.join(outputDir, filename);
        fs.copyFileSync(cachePath, dest);
        metrics.counts.renderHit += 1;
        exportJobs.set(jobId, { status: 'done', progress: 100, filename });
        log(`Export cache HIT (${rh.slice(0, 12)}…) → ${filename}`);
        return res.json({ jobId, filename, cached: true });
      } catch (e) {
        log(`Export cache copy failed — ${e.message}`);
      }
    } else {
      metrics.counts.renderMiss += 1;
    }
  }

  exportJobs.set(jobId, { status: 'queued', progress: 0, filename });
  log(`Export job ${jobId} queued → ${filename}`);

  // Start render asynchronously (do not await — respond immediately)
  runExportJob(jobId, timelineState, filename, fmt, qual).catch(err => {
    log(`Export job ${jobId} crashed: ${err.message}`);
  });

  res.json({ jobId, filename, cached: false });
});

// ---------------------------------------------------------------------------
// GET /export/status/:jobId
// ---------------------------------------------------------------------------

/**
 * Returns the current status of a render job.
 * Response: { status, progress, filename, error? }
 */
app.get('/export/status/:jobId', requireAuth, (req, res) => {
  const job = exportJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// GET /download/:filename
// ---------------------------------------------------------------------------

/**
 * Serves a rendered MP4 from the /output directory as a file download.
 * @param filename  The output filename from POST /export (when implemented)
 */
app.get('/download/:filename', requireAuth, (req, res) => {
  const filePath = path.join(__dirname, '..', 'output', req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Output file not found' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// Helpers — audio
// ---------------------------------------------------------------------------

/**
 * scanUploadedAudio
 * Scans the uploads/ directory and returns metadata for every audio file found.
 * Called before generateOperations so the model knows which files are available.
 *
 * @returns {Array} Array of { filename, url, name }
 */
function scanUploadedAudio() {
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  const audioExts  = new Set(['.mp3', '.wav', '.aac', '.ogg', '.m4a']);
  try {
    return fs.readdirSync(uploadsDir)
      .filter(f => audioExts.has(path.extname(f).toLowerCase()))
      .map(f => ({
        filename: f,
        url:      '/audio/' + f,
        name:     path.basename(f, path.extname(f)),
      }));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/audio/uploads
// ---------------------------------------------------------------------------

/**
 * Returns metadata for every audio file in the uploads/ directory.
 * Used by the Audio tab to populate the Uploads filter on mount.
 */
app.get('/api/audio/uploads', requireAuth, (req, res) => {
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  const audioExts  = new Set(['.mp3', '.wav', '.aac', '.ogg', '.m4a']);
  try {
    const uploads = fs.readdirSync(uploadsDir)
      .filter(f => audioExts.has(path.extname(f).toLowerCase()))
      .map(f => {
        const fullPath = path.join(uploadsDir, f);
        let fileSize = 0;
        try { fileSize = fs.statSync(fullPath).size; } catch (_) {}
        return {
          filename:   f,
          url:        '/audio/' + f,
          source:     'upload',
          name:       path.basename(f, path.extname(f)),
          fileSize,
        };
      });
    res.json({ uploads });
  } catch (err) {
    res.status(500).json({ error: 'Failed to scan uploads: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audio/search/freesound
// ---------------------------------------------------------------------------

/**
 * Searches Freesound for CC0 audio.
 * Query params: q (required), page_size (default 6)
 */
app.get('/api/audio/search/freesound', requireAuth, async (req, res) => {
  const { q, page_size } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  const cacheKey = `fs::${String(q).toLowerCase().trim()}::${Number(page_size) || 6}`;
  const cached = audioFreesoundLRU.get(cacheKey);
  if (cached !== undefined) return res.json(cached);

  try {
    const results = await searchFreesound(q, Number(page_size) || 6);
    audioFreesoundLRU.set(cacheKey, results);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audio/search/jamendo
// ---------------------------------------------------------------------------

/**
 * Searches Jamendo music API.
 * Query params: q (required), page_size (default 6)
 */
app.get('/api/audio/search/jamendo', requireAuth, async (req, res) => {
  const { q, page_size } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  const cacheKey = `jm::${String(q).toLowerCase().trim()}::${Number(page_size) || 6}`;
  const cached = audioJamendoLRU.get(cacheKey);
  if (cached !== undefined) return res.json(cached);

  try {
    const results = await searchJamendo(q, Number(page_size) || 6);
    audioJamendoLRU.set(cacheKey, results);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audio/search  (combined)
// ---------------------------------------------------------------------------

/**
 * Searches Freesound and Jamendo in parallel, interleaves results.
 * Query params: q (required), sources (comma-separated, default "freesound,jamendo")
 * Response: { results, query, warning? }
 */
app.get('/api/audio/search', requireAuth, async (req, res) => {
  const { q, sources } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  const sourceList = sources
    ? sources.split(',').map(s => s.trim()).filter(Boolean)
    : ['freesound', 'jamendo'];

  const cacheKey = `mix::${String(q).toLowerCase().trim()}::${sourceList.join(',')}`;
  const cached = audioUnifiedLRU.get(cacheKey);
  if (cached !== undefined) return res.json(cached);

  try {
    const results = await searchAudio(q, sourceList, 20);
    const payload = { results, query: q };
    audioUnifiedLRU.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /presets  (stub — full implementation in Stage 3)
// ---------------------------------------------------------------------------

/**
 * Returns the list of available style presets.
 */
app.get('/presets', (req, res) => {
  res.json([]);
});

// ---------------------------------------------------------------------------
// Static frontend (/public) — must be after API routes; does not use requireAuth
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Global error handler — always returns JSON
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    log(`Upload rejected: file exceeds ${maxMb} MB limit`);
    return res.status(413).json({
      error: `File too large (max ${maxMb} MB). Increase MAX_UPLOAD_MB in .env and restart the server.`,
    });
  }
  log(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

let httpServer;

function startListening() {
  httpServer = app.listen(PORT, () => {
    log(`Vibe Editor server running at http://localhost:${PORT}`);
    log(`Max upload size: ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
  });
}

ensureStorageBuckets()
  .then(startListening)
  .catch((e) => {
    console.error('ensureStorageBuckets failed:', e);
    startListening();
  });

process.on('SIGTERM', () => {
  log('[server] SIGTERM received — closing HTTP server');
  if (!httpServer) return process.exit(0);
  httpServer.close(() => {
    log('[server] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    log('[server] Forcing exit after timeout');
    process.exit(1);
  }, 5000);
});

process.on('SIGINT', () => {
  log('[server] SIGINT received — closing HTTP server');
  if (!httpServer) return process.exit(0);
  httpServer.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 5000);
});
