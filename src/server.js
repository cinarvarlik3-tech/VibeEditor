/**
 * src/server.js
 * Express backend for Vibe Editor.
 *
 * Serves the static frontend, state files, and orchestrates the pipeline:
 *   POST /upload    → save video, return metadata
 *   POST /generate  → (optional) transcribe + Claude operations → return { operations, transcript }
 *   POST /export    → serialize timeline → Remotion render → output file
 *   GET  /download/:filename → serve rendered video as download
 *   GET  /renders/*          → serve rendered output as streamable video (for VideoPreview)
 *   GET  /state/*            → serve state JS files to browser (schema, reducer)
 *   GET  /presets   → list style presets
 *   GET  /status    → health check
 */

'use strict';

require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const ffmpeg  = require('fluent-ffmpeg');
const { spawn } = require('child_process');

const { extractAudio, convertImageToVideo } = require('./video/extract');
const { serializeToRemotion } = require('./video/serializeToRemotion');
const { transcribeAudio }     = require('./transcription/transcribe');
const { generateOperations }  = require('./claude/generate');
const { searchFreesound, searchJamendo, searchAudio } = require('./assets/audio');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// Serve state files (schema.js, timelineReducer.js) to the browser.
app.use('/state', express.static(path.join(__dirname, 'state')));

// Serve rendered output videos as streamable (for VideoPreview <video> element).
app.use('/renders', express.static(path.join(__dirname, '..', 'output')));

// Serve uploaded audio files for in-browser playback via /audio/filename.mp3.
app.use('/audio', express.static(path.join(__dirname, '..', 'uploads')));

// Serve all uploaded files (video, image-derived mp4) via /uploads/filename.
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Serve the static frontend from /public.
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB — covers large audio files
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
// POST /upload
// ---------------------------------------------------------------------------

/**
 * Accepts a single video, audio, or image file upload.
 * Images (jpg/png/gif/webp) are auto-converted to a 10-second mp4 via ffmpeg.
 *
 * Request:  multipart/form-data, field name: "video"
 * Response: {
 *   filename,                  // saved filename in /uploads (may be .mp4 for images)
 *   path,                      // served URL path: '/uploads/<filename>'
 *   duration,                  // seconds
 *   originalFilename,          // user's original filename (e.g. "logo.png")
 *   isImage,                   // true if source was an image
 *   width,                     // video width in px (0 for audio)
 *   height,                    // video height in px (0 for audio)
 * }
 */
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const { filename, path: filePath, mimetype, originalname } = req.file;

  try {
    const isImage = mimetype.startsWith('image/');

    if (isImage) {
      // Convert image → mp4, then return mp4 metadata
      log(`Image upload received: ${filename} — converting to mp4...`);
      const { outputPath, duration, width, height } = await convertImageToVideo(filePath, 10);
      const mp4Filename = path.basename(outputPath);
      log(`Image converted → ${mp4Filename} (${width}x${height}, ${duration}s)`);
      res.json({
        filename:         mp4Filename,
        path:             '/uploads/' + mp4Filename,
        duration,
        originalFilename: originalname,
        isImage:          true,
        width,
        height,
      });
    } else {
      // Video or audio — probe metadata directly
      const duration = await getVideoDuration(filePath);
      let width = 0, height = 0;
      // Probe width/height for video files
      if (mimetype.startsWith('video/')) {
        try {
          const meta = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, m) => err ? reject(err) : resolve(m));
          });
          const vs = (meta.streams || []).find(s => s.codec_type === 'video');
          if (vs) { width = vs.width || 0; height = vs.height || 0; }
        } catch (_) { /* non-fatal */ }
      }
      log(`Upload received: ${filename} (${duration.toFixed(1)}s)`);
      res.json({
        filename,
        path:             '/uploads/' + filename,
        duration,
        originalFilename: originalname,
        isImage:          false,
        width,
        height,
      });
    }
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
 *
 * Response: { operations: Array, transcript: Array }
 */
app.post('/generate', async (req, res) => {
  const { videoPath, prompt, currentTracks, transcript: providedTranscript, language, presetName } = req.body;

  if (!videoPath)      return res.status(400).json({ error: 'videoPath is required' });
  if (!prompt)         return res.status(400).json({ error: 'prompt is required' });
  if (!currentTracks)  return res.status(400).json({ error: 'currentTracks is required' });

  // Resolve served URL paths (e.g. '/uploads/foo.mp4') to absolute filesystem paths
  const resolvedVideoPath = videoPath.startsWith('/')
    ? path.join(__dirname, '..', videoPath.replace(/^\//, ''))
    : videoPath;

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

      log('Step 2/2 — Transcribing with Whisper...');
      transcript = await transcribeAudio(audioPath, language || null);
      log(`Transcription complete — ${transcript.length} segments`);
    } else {
      log('Transcript provided — skipping extraction and transcription');
    }

    // ── Step 2: Get source duration ──────────────────────────────────────────
    const sourceDuration = await getVideoDuration(resolvedVideoPath);

    // ── Step 3: Generate operations via Claude ───────────────────────────────
    log('Generating operations with Claude...');
    const uploadedAudioFiles = scanUploadedAudio();
    const result = await generateOperations(prompt, currentTracks, transcript, sourceDuration, uploadedAudioFiles);
    const { operations, warnings } = result;
    log(`Operations generated — ${operations.length} operation(s)`);
    if (warnings && warnings.length > 0) {
      log(`Warnings: ${warnings.join('; ')}`);
    }

    res.json({ operations, transcript, warnings: warnings || [] });

  } catch (err) {
    log(`Pipeline error: ${err.message}`);
    res.status(500).json({ error: err.message });
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
app.post('/export', (req, res) => {
  const { timelineState, outputFilename, format, quality } = req.body;
  if (!timelineState) return res.status(400).json({ error: 'timelineState is required' });

  const jobId    = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const filename = path.basename(
    outputFilename || ('export_' + Date.now() + (format === 'mov' ? '.mov' : '.mp4'))
  );
  const fmt      = ['mp4', 'mov'].includes(format) ? format : 'mp4';
  const qual     = ['720p', '1080p', '4k'].includes(quality) ? quality : '1080p';

  exportJobs.set(jobId, { status: 'queued', progress: 0, filename });
  log(`Export job ${jobId} queued → ${filename}`);

  // Start render asynchronously (do not await — respond immediately)
  runExportJob(jobId, timelineState, filename, fmt, qual).catch(err => {
    log(`Export job ${jobId} crashed: ${err.message}`);
  });

  res.json({ jobId, filename });
});

// ---------------------------------------------------------------------------
// GET /export/status/:jobId
// ---------------------------------------------------------------------------

/**
 * Returns the current status of a render job.
 * Response: { status, progress, filename, error? }
 */
app.get('/export/status/:jobId', (req, res) => {
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
app.get('/download/:filename', (req, res) => {
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
 * Called before generateOperations so Claude knows which files are available.
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
app.get('/api/audio/uploads', (req, res) => {
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
app.get('/api/audio/search/freesound', async (req, res) => {
  const { q, page_size } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  try {
    const results = await searchFreesound(q, Number(page_size) || 6);
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
app.get('/api/audio/search/jamendo', async (req, res) => {
  const { q, page_size } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  try {
    const results = await searchJamendo(q, Number(page_size) || 6);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audio/search  (combined)
// ---------------------------------------------------------------------------

/**
 * Searches Freesound and Pixabay in parallel, interleaves results.
 * Query params: q (required), sources (comma-separated, default "freesound,pixabay")
 * Response: { results, query, warning? }
 */
app.get('/api/audio/search', async (req, res) => {
  const { q, sources } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });

  const sourceList = sources
    ? sources.split(',').map(s => s.trim()).filter(Boolean)
    : ['freesound', 'jamendo'];

  try {
    const results = await searchAudio(q, sourceList, 20);
    res.json({ results, query: q });
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
// GET /status
// ---------------------------------------------------------------------------

/**
 * Health check — confirms the server is running.
 */
app.get('/status', (req, res) => {
  res.json({ status: 'ok', version: '0.2.0' });
});

// ---------------------------------------------------------------------------
// Global error handler — always returns JSON
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  log(`Vibe Editor server running at http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  log('[server] SIGTERM received — closing HTTP server');
  server.close(() => {
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
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 5000);
});
