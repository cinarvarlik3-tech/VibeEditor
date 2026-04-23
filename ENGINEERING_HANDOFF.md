# Vibe Editor — Engineering Handoff

> **Purpose.** A single doc that contains every detail a new engineer needs to run,
> extend, ship, and operate this codebase without tribal knowledge. Pair this with
> `VibeEditor_Roadmap_2.md` (product phases) and `docs/VISUAL_PIPELINE.md`
> (deep-dive on the AI visual selection / "Scan for Visuals" feature).

---

## 0. TL;DR

- **Product:** an AI-assisted, timeline-based video editor. Users upload a video,
  edit on a multi-track timeline (video, image overlays, audio, subtitles),
  optionally drive edits via natural language ("make subtitles bigger", "add b-roll
  when she mentions the office"), and export via Remotion.
- **Thesis:** the LLM returns **JSON operations**, not JSX. The same
  `timelineReducer` applies user edits and AI edits. That keeps preview and export
  aligned and keeps the model inside a sandbox.
- **Stack:**
  - Node 18+ / Express backend (`src/server.js`)
  - React 18 via **UMD + Babel Standalone** in the browser (no bundler)
  - OpenAI (`gpt-5.4` family via routing) for agent + visual pipeline
  - OpenAI `whisper-1` for transcription
  - Remotion CLI for final render
  - Supabase (Auth + Postgres + Storage) for users, projects, media
  - Pixabay API for b-roll search, Freesound + Jamendo for audio
- **Composition base:** 1080×1920 portrait at 30 fps. Many subtitle / image math
  paths assume this base; changing aspect is a coordinated refactor.
- **Entry points:** `npm run dev` → http://localhost:3000/landing.html →
  /login → /editor.

---

## 1. Repository layout

```
VibeEditorCopy/
├── src/
│   ├── server.js                  # Express app, all HTTP routes, export runner
│   ├── index.js                   # (Remotion entry — registers compositions)
│   ├── claude/
│   │   ├── generate.js            # OpenAI client: generateOperations, visual pipeline,
│   │   │                          #   summarize, compression/decompression
│   │   ├── systemPrompt.js        # SYSTEM_PROMPT_VERSION + big multi-bundle prompt
│   │   └── visualComponentRules.js# VISUAL_COMPONENT_RULES (Pass 1 / Pass 2)
│   ├── state/
│   │   ├── schema.js              # initialTimelineState + element-shape docs
│   │   └── timelineReducer.js     # single reducer for UI + AI ops + inline tests
│   ├── transcription/transcribe.js# OpenAI whisper-1 verbose_json wrapper
│   ├── video/
│   │   ├── extract.js             # ffmpeg helpers: extractAudio, thumbnails, image→video
│   │   ├── render.js              # legacy render helper (CLI wrapper)
│   │   └── serializeToRemotion.js # timelineState → full GeneratedVideo.jsx string
│   ├── compositions/
│   │   ├── BaseVideo.jsx          # Remotion scaffold
│   │   └── GeneratedVideo.jsx     # WRITTEN AT EXPORT TIME — do not hand-edit
│   ├── presets/defaults/          # on-disk presets (if used)
│   ├── styles/style_guide_v1.json
│   ├── assets/
│   │   ├── audio.js               # Freesound / Jamendo / unified audio search
│   │   └── nativeVisuals.js       # keyword_text / stat_card / arrow / box / callout
│   └── cache/
│       ├── config.js              # CACHE_ENABLED env flag
│       ├── lru.js                 # in-memory LRU w/ TTL
│       ├── llmResponseCache.js    # LLM response memoization wrapper
│       ├── transcriptCache.js     # supabase-backed transcript cache
│       ├── renderCache.js         # disk render cache
│       ├── metrics.js             # rolling stats + counters
│       └── hash.js                # canonicalStringify + sha256
├── public/                         # SPA (no bundler)
│   ├── index.html                  # editor entry, injects SUPABASE_URL/ANON_KEY
│   ├── landing.html                # marketing landing
│   ├── login.html                  # auth entry
│   ├── App.jsx                     # root React component (huge, orchestrates everything)
│   ├── auth.js                     # window.Auth (login/logout, token storage)
│   ├── components/
│   │   ├── AgentPanel.jsx          # chat UI, "Scan for Visuals" button, candidate cards
│   │   ├── VideoPreview.jsx        # 1080×1920 preview renderer
│   │   ├── Timeline.jsx            # multi-track timeline with drag/trim/split
│   │   ├── LeftPanel.jsx           # media + styles + fonts + presets
│   │   ├── Header.jsx
│   │   ├── ExportModal.jsx
│   │   └── ContextMenu.jsx
│   ├── effectStyles.js             # shared effect/animation render helpers
│   └── fontLoader.js               # dynamic Google Fonts loader
├── docs/
│   ├── VISUAL_PIPELINE.md          # AI visual selection detailed spec (this repo)
│   ├── VisualSystem_UpdatedSpec.docx
│   └── sql/                        # Supabase SQL snippets (policies, tables)
├── tests/                          # smoke + stage tests
├── uploads/                        # dev local media (user-uploaded, gitignored)
├── output/                         # rendered exports (gitignored)
├── frames/                         # scratch
├── nodemon.json
├── remotion.config.js
├── run.js                          # utility script (one-shot pipeline run)
├── package.json                    # scripts: dev, start, test:stage1
├── Stage1Plan.md
├── VibeEditor_Roadmap1.md
├── VibeEditor_Roadmap_2.md         # authoritative product roadmap
└── ENGINEERING_HANDOFF.md          # this file
```

---

## 2. High-level architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Browser (public/)                                                      │
│                                                                        │
│   index.html ──▶ React UMD + Babel Standalone                          │
│   App.jsx       (root; orchestrates upload, agent, export, visual)     │
│   ├─ VideoPreview.jsx  (1080×1920 preview)                             │
│   ├─ Timeline.jsx      (drag/trim/split multi-track)                   │
│   ├─ LeftPanel.jsx     (media, fonts, audio search, presets)           │
│   └─ AgentPanel.jsx    (chat, visual candidates, quick actions)        │
│                                                                        │
│   Globals loaded via <script src="/state/schema.js"> and               │
│   <script src="/state/timelineReducer.js">                             │
│   → window.TimelineSchema / window.TimelineReducer                     │
│   → window.Auth (public/auth.js) for Supabase session + fetch helpers  │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ HTTPS JSON + multipart + Bearer <Supabase JWT>
               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Express (src/server.js)                                                │
│                                                                        │
│  Middleware: cors(), json({50mb}), requireAuth (validates JWT via      │
│              supabaseAdmin.auth.getUser)                               │
│                                                                        │
│  Static:  /           redirects to /landing.html                       │
│           /editor     → public/index.html (SPA)                        │
│           /login      → public/login.html                              │
│           /state/*    → src/state (schema, reducer)                    │
│           /renders/*  → output/ (streamable for VideoPreview)          │
│           /uploads/*  → uploads/ (served raw)                          │
│           /audio/*    → uploads/ (audio streaming)                     │
│                                                                        │
│  APIs:                                                                 │
│   /upload               /generate           /export                    │
│   /api/projects         /api/auth/verify    /api/fonts                 │
│   /api/audio/*          /api/pixabay/*      /api/visual/*              │
│   /api/summarize-conversation                                          │
│   /api/_debug/cache     /api/_debug/token-report                       │
│                                                                        │
│  Long jobs: export runner (in-memory exportJobs Map; spawns            │
│             `npx remotion render`)                                     │
└──┬────────────────┬────────────────┬─────────────────┬─────────────────┘
   │                │                │                 │
   ▼                ▼                ▼                 ▼
 OpenAI         OpenAI            Remotion         Supabase
 Chat           Whisper-1         CLI              - Auth (JWT)
 (agent +       (verbose_json)    (render job,     - Postgres (projects)
  visual)                          spawn npx)      - Storage buckets:
                                                     videos, audio,
                                                     image-layer,
                                                     thumbnails
 Pixabay API — b-roll search + ingest
 Freesound / Jamendo — audio library search
 Google Fonts — catalogue (fallback list if no key)
```

### Single-source-of-truth mental model

- **All timeline mutations** (user clicks, drags, AI-returned operations) go
  through `timelineReducer.js`.
- Claude/OpenAI returns a JSON array of operations. The server `decompressOperations()`
  expands short keys, the browser dispatches `APPLY_OPERATIONS`, which calls
  `applyOperation` for each entry.
- Preview and export both consume the same `timelineState`. `serializeToRemotion`
  exists to mirror preview semantics 1:1 — if the exported MP4 ever diverges
  from what the preview showed, treat it as a bug in one of those two files.

---

## 3. Getting the project running locally

### Prerequisites

- Node 18+ (for native `fetch`, `AbortController`, modern async)
- `ffmpeg` on PATH (fluent-ffmpeg shells out to it)
- An OpenAI API key with access to the `gpt-5.4` family and `whisper-1`
- (Recommended) a Supabase project with the buckets + tables listed below
- (Recommended) a Pixabay API key for visual b-roll search

### 3.1 Install

```bash
git clone <repo> VibeEditorCopy
cd VibeEditorCopy
npm install
cp .env.example .env
# fill keys, see section 5
```

### 3.2 Scripts

From `package.json`:

| Script | What it does |
|--------|--------------|
| `npm run predev` | kills any process on port 3000 |
| `npm run dev` | starts nodemon → `node src/server.js` |
| `npm start` | `node src/server.js` (prod-mode) |
| `npm run test:stage1` | runs `tests/test-stage1.js` smoke suite |

You can also run `node src/state/timelineReducer.js` directly — the file has a
self-test block at the bottom that exercises `APPLY_OPERATIONS`.

### 3.3 First-run loop (the "hello world")

1. `npm run dev`, open http://localhost:3000/
2. Log in (or bypass Supabase by leaving `SUPABASE_*` empty — see notes in §6).
3. Upload a short video (`.mp4`, `.mov`, or a JPG/PNG — images are auto-converted
   to 10-second MP4s server-side via `convertImageToVideo`).
4. The transcript is auto-fetched once the video is loaded (controlled via the
   **Generate Transcript** / cached-transcript path in `App.jsx`).
5. Type a prompt in AgentPanel ("make subtitles bigger and red"). It posts to
   `/generate` and the ops are dispatched.
6. Press **Scan for Visuals** (only visible when a cached transcript exists)
   to trigger the Pass 1 visual pipeline. See `docs/VISUAL_PIPELINE.md`.
7. Click **Export** → poll `/export/status/:jobId` → `/download/:filename`.

---

## 4. Data model / timeline state

Defined in `src/state/schema.js` (dual-exported for Node `require` and browser
`<script>` tag). Do **not** convert this file to ES modules without a build
step — it runs in both environments.

### 4.1 Top-level state

```js
{
  project:  { id, name, createdAt, updatedAt },
  source:   { filename, duration, width, height, fps, fileSize, thumbnails[] },
  tracks: {
    subtitle: [{ id, index, name, locked, visible, elements[] }],
    image:    [...],
    video:    [...],
    audio:    [...],
  },
  history:  { past[], future[], maxEntries: 100 }, // undo/redo + prompt checkpoints
  playback: { currentTime, isPlaying, duration },
}
```

### 4.2 Element shapes (canonical — quoting `schema.js`)

- **videoClip** — `{ id, type:'videoClip', startTime, endTime, sourceStart, sourceEnd,
  playbackRate, volume, src, originalFilename, isImage, imageDuration,
  keyframes:{ scale:[], opacity:[] } }`. `volume` and `playbackRate` are clip-level
  scalars; only `scale` and `opacity` are keyframable.
- **subtitle** — `{ id, type:'subtitle', startTime, endTime, text, style{...},
  position{ x, y, xOffset, yOffset }, animation{ in, out } }`. Position accepts
  string anchors (`'left'|'center'|'right'` / `'top'|'center'|'bottom'`) or
  numeric offsets in a centered coordinate system
  (x: −540..+540, y: −960..+960).
- **audioClip** — `{ id, type:'audioClip', startTime, endTime, src, volume,
  fadeIn, fadeOut, sourceName, sourceType }`.
- **imageClip** (most complex — this is the b-roll / overlay element):
  ```
  { id, type:'imageClip', startTime, endTime, src,
    originalFilename, isImage, sourceName,
    sourceType: 'upload' | 'pixabay' | 'native',
    pixabayId: number|null,
    opacity, volume, fitMode: 'cover' | 'contain' | 'fill',
    nativePayload?: object,       // when sourceType === 'native'
    keyframes: { opacity: [...] },
    imageLayout: {
      layoutMode: 'fullscreen' | 'custom',
      anchor: { x, y },           // pixels, origin = frame center (1080×1920 base)
      box:    { width, height },  // pixels in that same space
      lockAspect: boolean,
    },
    intrinsicAspect: number|null,
  }
  ```
  `src: 'native://keyword_text'` (etc.) is how native overlays are represented.
  See `public/components/VideoPreview.jsx` and
  `src/video/serializeToRemotion.js → ImageClipBlock` for the matching render
  logic.

- **Keyframe** — `{ time, value, easing: 'linear'|'ease-in'|'ease-out'|'ease-in-out'|'hold' }`.

### 4.3 Architectural rules (from `schema.js` — memorize these)

- **Effects and animations are element properties, not tracks.** Do not create an
  "effects track" or "zoom track". Add a field on the element.
- **Image layer sits above video, below subtitles** in compositing order. Image
  clips overlay, never replace, the underlying video.
- **Video track can hold any number of videoClips.** Gaps produce black frames
  in the preview.

### 4.4 Reducer actions (from `timelineReducer.js`)

- `SET_STATE`, `LOAD_SOURCE`, `UPDATE_PROJECT_NAME`, `SET_PLAYBACK_TIME`,
  `TOGGLE_PLAYBACK`
- `MOVE_ELEMENT`, `UPDATE_ELEMENT`, `DELETE_ELEMENT`
- `UNDO`, `REDO`, `UNDO_LAST_PROMPT`
- `APPLY_OPERATIONS` — primary AI-edit entry; batches operations and pushes one
  history entry with an optional `promptText` checkpoint used by "Undo last
  prompt" / "Undo last edit".

Inside `APPLY_OPERATIONS`, the supported `operation.op` values are:
`CREATE`, `UPDATE`, `DELETE`, `CREATE_TRACK`, `DELETE_TRACK`, `BATCH_CREATE`,
`ADD_KEYFRAME`, `UPDATE_KEYFRAME`, `DELETE_KEYFRAME`, `SPLIT_ELEMENT`,
`REORDER_TRACK`. Unknown ops are warned and skipped.

---

## 5. Environment variables

Nothing secret belongs in the repo. `.env.example` is the source of truth for
names. The full list with intent:

| Var | Required | Notes |
|-----|----------|-------|
| `PORT` | No (3000) | HTTP port |
| `OPENAI_API_KEY` | Yes | Whisper + agent + visual pipeline |
| `OPENAI_MODEL_FLAGSHIP` | No (`gpt-5.4`) | Full-quality model |
| `OPENAI_MODEL_MINI` | No (`gpt-5.4-mini`) | Cost-optimized default for `/generate` and visual scan/brief |
| `OPENAI_MODEL_NANO` | No (`gpt-5.4-nano`) | Used for summarize and visual_pick |
| `FEATURE_MODEL_ROUTING` | No (true) | When false, all call sites use flagship |
| `FEATURE_TRANSCRIPT_WINDOWING` | No (true) | Sends only transcript window near the prompt focus instead of full |
| `FEATURE_HISTORY_SUMMARIES` | No (true) | Rolls up ≥10 turns into a single summary exchange |
| `FEATURE_PROMPT_BUNDLES` | No (true) | Keyword-driven subset of system-prompt bundles |
| `CACHE_ENABLED` | No (true) | Global kill switch for transcript DB cache + render disk cache |
| `LLM_RESPONSE_CACHE_MAX` | No (200) | `/generate` LLM response cache entries |
| `LLM_RESPONSE_CACHE_TTL_MS` | No (300000) | TTL in ms |
| `LLM_SUMMARIZE_CACHE_MAX` / `_TTL_MS` | No | Conversation summary cache |
| `LLM_VISUAL_SCAN_CACHE_MAX` / `_TTL_MS` | No | Pass-1 candidate cache |
| `LLM_VISUAL_BRIEF_CACHE_MAX` / `_TTL_MS` | No | Pass-2 retrieval-brief cache |
| `LLM_VISUAL_PICK_CACHE_MAX` / `_TTL_MS` | No | Claude-pick cache |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` | Yes for auth + projects | anon key injected into HTML, service key server-only |
| `GOOGLE_FONTS_API_KEY` | No | falls back to `FONTS_FALLBACK` list |
| `PIXABAY_API_KEY` | Yes for visual search | `/api/pixabay/search` returns 503 without it |
| `FREESOUND_API_KEY` | No | audio search |
| `JAMENDO_CLIENT_ID` | No | audio search |
| `MAX_UPLOAD_MB` | No (10240) | multipart upload cap |
| `OPENAI_BASE_URL` / `OPENAI_TRANSCRIBE_TIMEOUT_MS` | No | override defaults |

When a Supabase piece is missing, `requireAuth` returns 503
(`Supabase auth is not configured on the server`). The landing/editor/login pages
still render because `sendInjectedHtml` just injects empty strings.

---

## 6. Authentication model

- **Frontend.** `public/auth.js` wraps `supabase-js`. It stores the session in
  `localStorage` under the default Supabase key and exposes `window.Auth` with
  helpers used across App.jsx:
  - `Auth.getToken()` — JWT
  - `authHeadersJson()` and `authHeadersBearer()` helpers inside App.jsx build
    fetch headers
- **Backend.** Every mutating route sits behind `requireAuth` (validates the
  Bearer JWT via `supabaseAdmin.auth.getUser(token)` and sets `req.user`).
  `supabaseAdmin` is created from `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`.
- **HTML injection.** `sendInjectedHtml` writes
  `<script>window.SUPABASE_URL=...;window.SUPABASE_ANON_KEY=...;</script>`
  into the served HTML (replacing `<!--VIBE_SUPABASE_CONFIG-->` or injecting
  after `<head>`). The service key is **never** sent to the browser.
- **Storage buckets.** `ensureStorageBuckets()` at boot creates
  `videos`, `thumbnails`, `audio`, and `image-layer`. Thumbnails is the only
  public bucket. RLS policy examples are in comments in `src/server.js` near the
  top (copy-pasteable into the Supabase SQL editor).
- **Projects table.** SQL skeleton and ALTERs are in the same comment block —
  columns: `id uuid PK`, `user_id uuid references auth.users`, `name`,
  `timeline jsonb`, `transcript jsonb`, `video_path`, `thumbnail_url`,
  `duration`, `created_at`, `updated_at`.

---

## 7. HTTP API reference

Unless noted, requests and responses are JSON. `Auth` means
`Authorization: Bearer <Supabase JWT>` is required.

### 7.1 Public

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/status` | Health `{ status, version }`. Append `?debug=cache` for LRU snapshots. |
| GET | `/` | 302 → `/landing.html` |
| GET | `/landing`, `/landing.html` | Landing SPA |
| GET | `/editor` | Editor SPA (`public/index.html`) |
| GET | `/login`, `/login.html` | Login SPA |
| GET | `/api/fonts` | Google Fonts list or fallback |
| GET | `/state/schema.js`, `/state/timelineReducer.js` | Browser loads state layer |

### 7.2 Auth

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/verify` | Validates Bearer token |

### 7.3 Projects (all Auth-guarded)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | List user projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Load full project (timeline + transcript + metadata) |
| PUT | `/api/projects/:id` | Update (timeline jsonb, name, etc.) |
| DELETE | `/api/projects/:id` | Delete |

### 7.4 Media (all Auth-guarded)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/upload` | Multipart `video` field. Image files auto-converted to MP4 via `convertImageToVideo`. Returns `{ uploadedPath, permanentUrl, duration, width, height, originalFilename, isImage }`. Uploads can land in Supabase Storage `videos` or `image-layer` bucket depending on detected type. |
| GET | `/api/audio/uploads` | List uploaded audio for inclusion in the agent prompt. |
| GET | `/api/audio/search?provider=freesound|jamendo&q=...` | Audio library search (LRU-cached). |
| GET | `/api/pixabay/search?q=&asset_type=video|image|all&per_page=&orientation=` | Pixabay proxy, normalized `{ results[], query, total }`. See §8. |
| POST | `/api/pixabay/ingest` | Download asset → convert if image → upload to `image-layer` bucket → return `{ permanentUrl, storageRef, duration, filename }`. |

### 7.5 AI edit

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/generate` | Core AI-edit entry. Body: `{ videoPath, prompt, currentTracks, transcript?, language?, presetName?, conversationExchanges? }`. See §9 for the full flow. Returns `{ operations, warnings, isExplanation, claudeUsage, modelUsed, fallback }` + transcription metadata. |
| POST | `/api/summarize-conversation` | Rolls 10 prior exchanges into a single summary (used by the rolling-history feature). |

### 7.6 Visual pipeline (Auth-guarded) — see `docs/VISUAL_PIPELINE.md`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/visual/scan` | Pass 1: detect visual candidate moments in the transcript. |
| POST | `/api/visual/brief` | Pass 2: per-candidate retrieval brief (query, orientation, filters). |
| POST | `/api/visual/claude-pick` | Given a candidate + ranked Pixabay assets, return `{ chosen_id }`. |

### 7.7 Export

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/export` | Body: `{ timelineState, filename, format:'mp4'|'mov', quality:'720p'|'1080p'|'4k' }`. Queues a job, returns `{ jobId, filename }`. |
| GET | `/export/status/:jobId` | `{ status: 'queued'|'running'|'done'|'error', progress, filename, error? }`. |
| GET | `/download/:filename` | Stream the finished file from `output/`. |
| GET | `/renders/:filename` | Same file served as streamable `video/*` for `VideoPreview`. |

### 7.8 Ops / debug

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/_debug/cache` | Full JSON snapshot of all caches + rolling stats + system prompt version + per-callsite token stats. |
| GET | `/api/_debug/token-report` | Plain-text rolling p50/p95 usage per callsite + bundle hit distribution. |

---

## 8. Media pipeline

### 8.1 Upload

1. Browser posts multipart `video` field to `/upload`.
2. Multer saves to `uploads/{timestamp-filename}` (disk). Filter accepts MP4/MOV/AVI/WebM + MP3/WAV/AAC/OGG/M4A + JPG/PNG/GIF/WebP.
3. For images, `convertImageToVideo(filePath, 10)` produces a 10-second MP4 and
   the frontend is told `isImage: true` so it can place it as an `imageClip`
   instead of a videoClip.
4. Duration is probed via `ffprobe` (`getVideoDuration`).
5. File is uploaded to the correct Supabase bucket
   (`videos` or `image-layer`), and a signed URL is issued (TTL = 7 days).
6. Thumbnails are generated via `extractThumbnailAtPercent` and uploaded to
   `thumbnails` (public bucket).
7. Response contains `uploadedPath` (local), `permanentUrl` (Supabase signed),
   `duration`, width/height, `originalFilename`, `isImage`.

### 8.2 Pixabay search (`/api/pixabay/search`)

- Keyed by `{ q, assetType, perPage, orientation }` in a 24h in-memory LRU
  (`pixabayLRU`, max 500).
- `asset_type=video` → `pixabay.com/api/videos/` with `video_type=all`.
- `asset_type=image` → `pixabay.com/api/` with `image_type=photo`. `orientation=portrait`
  translates to Pixabay's `orientation=vertical`.
- `asset_type=all` → half/half parallel search across both endpoints.
- Results normalized to a shared shape:
  `{ id, type:'video'|'image', previewUrl, thumbnailUrl, downloadUrl,
    duration, width, height, tags, contributor, pageURL }`.
- Results with `watermark` in `tags` are filtered out.

### 8.3 Pixabay ingest (`/api/pixabay/ingest`)

- Downloads the asset to `os.tmpdir()`.
- If image, converts to a 5-second (or requested) MP4.
- Uploads to `image-layer/{userId}/{projectId}/pixabay_{assetId}.mp4` and
  returns a signed `permanentUrl` + `storageRef`.

### 8.4 Transcription

`src/transcription/transcribe.js` wraps OpenAI's `whisper-1` with
`response_format: 'verbose_json'` to get word-level timings. The file is first
extracted with ffmpeg to 16 kHz mono and streamed to OpenAI. `getOrTranscribeAudio`
in `src/cache/transcriptCache.js` adds a Supabase-backed cache keyed by audio
hash (see `docs/sql/`). Cumulative Whisper minutes are tracked in
`metrics.whisperMinutes` for the debug endpoints.

### 8.5 Rendering (Remotion)

`POST /export` flow:

1. Client posts the full timeline state.
2. Server `runExportJob(jobId, timelineState, filename, format, quality)`:
   - `serializeToRemotion(timelineState)` emits a complete self-contained
     `GeneratedVideo.jsx` string + `totalFrames`.
   - Writes `src/compositions/GeneratedVideo.jsx` (overwrites each render).
   - Spawns `npx remotion render` with `--frames=0-(N-1)`, codec
     (`h264` or `prores`) per `format`, and `--scale` per quality preset
     (`REMOTION_QUALITY_SCALE = { '720p': 720/1080, '1080p': 1, '4k': 3840/1080 }`).
   - `--disable-web-security` is passed so the headless Chromium can fetch cross-origin media (Supabase + Pixabay + uploads).
3. Updates `exportJobs.get(jobId)` with status/progress/filename/error.
4. Client polls `/export/status/:jobId`, then downloads from `/download/:filename`.

**Known limitation:** `exportJobs` is an in-memory `Map`. If the server restarts,
in-flight jobs are lost. For durability, move this to Supabase
(`export_jobs` table) or Redis.

### 8.6 Render cache

`src/cache/renderCache.js` hashes the serialized composition + props via
`computeRenderHash`. If the same hash exists under `output/`, the cached MP4
is reused and the job skips straight to `done`. Disable with `CACHE_ENABLED=false`.

---

## 9. Agent pipeline (`/generate`)

The core loop. Full contract lives in `src/claude/generate.js` + `src/claude/systemPrompt.js`.

1. **Request body:** `{ videoPath, prompt, currentTracks, transcript?, language?,
   presetName?, conversationExchanges? }`.
2. **Transcript sourcing:** if `transcript` is absent, extract audio and
   transcribe via `getOrTranscribeAudio` (Supabase-backed cache when enabled).
3. **Source duration:** `ffprobe` via `getVideoDuration`.
4. **Uploaded audio list:** `scanUploadedAudio()` walks `uploads/` and returns
   audio filenames so the model can suggest them when asked.
5. **LLM cache lookup:** `generateLlmCache` keys a SHA-256 of canonical JSON of
   `{ userId, prompt, currentTracks, transcript, sourceDuration,
   uploadedAudioFiles, conversationExchanges }`. Hits skip the OpenAI call.
6. **Call `generateOperations(...)`** which:
   - Classifies the prompt with regex-based rule-bundle selector (`CLIP_KEYWORDS`,
     `SUBTITLE_KEYWORDS`, `ANIMATION_KEYWORDS`, `AUDIO_KEYWORDS`, `IMAGE_KEYWORDS`,
     `TRACK_KEYWORDS`, `CONVERSATION_KEYWORDS`) → subset of rule bundles:
     `animations | audio | clips | conversation | images | subtitles | tracks`.
   - Optionally **windows the transcript** around the prompt focus to save tokens.
   - Optionally **summarizes conversation history** when there are ≥10 prior
     exchanges (delegates to `summarizeEditingConversation` — nano model).
   - **Compresses tracks** via `compressTracks()` — short keys for Claude input
     (e.g. subtitles use `p` for position; image clips use `il` for imageLayout
     with `lm`, `ax`, `ay`, `bw`, `bh`, `la`).
   - Builds `CLIP_SUMMARY` — a numbered list of video clips so the model can
     say "clip 2" without hallucinating IDs.
   - Chooses the model: `MODEL_FOR_GENERATE` (mini) with automatic fallback to
     `MODEL_FLAGSHIP` if mini returns invalid JSON. Fallback counter is tracked
     in `metrics.routingRequestFallback` / `routingRequestSuccess`.
   - Sends messages to OpenAI chat completions with `SYSTEM_PROMPT`.
7. **Decompress operations:** `decompressOperations()` maps short op keys back
   to full reducer field paths. `decompressCreateElement` handles element
   payloads inside `CREATE`/`BATCH_CREATE`.
8. **Validation:** invalid operations are stripped with a warning; detected
   "explanations" (model text replying in prose instead of JSON) are returned
   as `isExplanation: true` with `operations: []`.
9. **Response:** `{ operations, warnings, isExplanation, claudeUsage,
   modelUsed, fallback, transcript?, cached? }`.

### Token/cost guard rails

- `FEATURE_PROMPT_BUNDLES` — only include rule bundles the prompt actually needs.
- `FEATURE_TRANSCRIPT_WINDOWING` — ship a time-window of the transcript.
- `FEATURE_HISTORY_SUMMARIES` — roll up history to one paragraph.
- `FEATURE_MODEL_ROUTING` — use mini/nano where safe, flagship only on fallback.
- LLM response cache on `/generate`, `/api/visual/*`, and
  `/api/summarize-conversation` deduplicates identical repeat requests per
  authenticated user.

Observability: `/api/_debug/token-report` gives you a plain-text rolling
window of input/output/cached tokens per callsite, routing fallback rate,
bundle hit distribution, transcript-mode distribution, and Whisper usage.

---

## 10. Visual pipeline (high-level)

Three endpoints + a rich UI flow in `AgentPanel.jsx`:

1. `/api/visual/scan` → Pass 1 candidate list
2. `/api/visual/brief` → Pass 2 retrieval brief for a single candidate
3. `/api/visual/claude-pick` → chosen Pixabay asset id

Plus Pixabay search and ingest. All of this has its own deep-dive in
**`docs/VISUAL_PIPELINE.md`**, including: the exact system prompt (Pass 1/2),
the 5-gate moment-detection rules, the Gate/Reject criteria, the JSON schemas
for candidates and briefs, UI states, caching, model routing, and gotchas.

---

## 11. Serialization to Remotion

`src/video/serializeToRemotion.js` is the bridge from timeline state to a
runnable Remotion composition. It:

- Collects clips from `tracks.video`, `tracks.image`, `tracks.subtitle`, `tracks.audio`.
- Emits JS that computes `totalFrames` from the longest track.
- Emits `<BaseVideo>`-shaped JSX with:
  - `<Video>` components for each video clip (with `playbackRate`, `trimBefore`,
    `trimAfter` derived from `sourceStart`/`sourceEnd`).
  - `<AbsoluteFill>` blocks for each `imageClip`, using `imageClipLayoutStyle`
    to position custom-layout overlays in percentage coordinates keyed off
    `1080×1920`.
  - Native overlay branch when `sourceType === 'native'` and `src.startsWith('native://')`:
    renders `keyword_text`, `stat_card`, `arrow`, `highlight_box`, `callout` via
    inline JSX (must stay in sync with `VideoPreview.jsx` and
    `src/assets/nativeVisuals.js`).
  - Subtitle `<AbsoluteFill>` with fonts, shadows, animations from
    `public/effectStyles.js`.
  - Audio via Remotion's `<Audio>` with `trimBefore`/`trimAfter` and volume.

**When preview diverges from export,** compare this file against
`VideoPreview.jsx` and `effectStyles.js` — one of them drifted.

---

## 12. Caching architecture

All caches live under `src/cache/`:

| Cache | File | Backing | Scope | TTL default | Disable |
|-------|------|---------|-------|-------------|---------|
| Transcript (Whisper) | `transcriptCache.js` | Supabase table (see `docs/sql/`) | audio hash | until evicted | `CACHE_ENABLED=false` |
| Render | `renderCache.js` | Disk (under `output/`) | composition hash | until evicted | `CACHE_ENABLED=false` |
| LLM `/generate` | `llmResponseCache.js` (via `generateLlmCache`) | in-memory LRU | per `{userId, payload}` | 5 min | `LLM_RESPONSE_CACHE_MAX=0` |
| LLM summarize | ^ | same | same | 30 min | same pattern |
| LLM visual_scan | ^ | same | same | 15 min | same |
| LLM visual_brief | ^ | same | same | 15 min | same |
| LLM visual_pick | ^ | same | same | 15 min | same |
| Fonts | `makeLRU` | in-memory | `google-fonts` | 24 h | — |
| Pixabay | `pixabayLRU` | in-memory | `{q,assetType,perPage,orientation}` | 24 h | — |
| Audio search (Freesound/Jamendo/unified) | `makeLRU` | in-memory | query | 30 min | — |

Keys are stable: `canonicalStringify` (sorted keys, deterministic) → SHA-256.

**Metrics.** `src/cache/metrics.js` exposes:
- Counters: `routingRequestSuccess`, `routingRequestFallback`, `bundles_*`,
  `transcriptMode_*`, `historySummaryUsed`, `historyRawJsonUsed`, `whisperCalls`,
  `whisperMinutes`, `historyFullSnapshotsGt1`.
- Rolling windows (last N = `ROLLING_WINDOW`) for `{callsite}_{metric}` where
  metric ∈ `estTotalTokens`, `realInputTokens`, `realOutputTokens`,
  `realCachedTokens`, `cacheHitRatio`, `systemTokens`, `historyTokens`,
  `currentTurnTokens`.

---

## 13. Frontend conventions

- **No bundler.** `public/index.html` loads React UMD + Babel Standalone, then
  loads `/state/schema.js` and `/state/timelineReducer.js` as globals, then
  `public/auth.js`, then component files (`*.jsx`) which Babel transpiles in the
  browser. Don't use ES modules in `public/` unless you set up a bundler.
- **Global `React`, `ReactDOM`, `TimelineSchema`, `TimelineReducer`, `Auth`.**
- **State.** Single `useReducer(TimelineReducer.timelineReducer, TimelineSchema.initialTimelineState)`
  in `App.jsx`. All downstream components are read-only or dispatch via props.
- **Keyed re-renders.** Expensive lists (timeline rows, visual candidates) use
  stable ids — if you add a field that can make IDs collide, use a `__vuid`
  pattern like `VisualCandidatesPanel` does.
- **Animations.** `framer-motion` is available as a UMD global in the HTML.

---

## 14. Testing and quality

- `node src/state/timelineReducer.js` — runs inline self-tests for
  `applyOperation`, undo, split, keyframes, track CRUD.
- `npm run test:stage1` — `tests/test-stage1.js` exercises an end-to-end
  generate → serialize smoke path.
- **No unified ESLint** and no TypeScript. Rely on `node --check src/**/*.js`
  and editor tooling.
- **Recommended CI additions:**
  1. `node --check` on every JS/JSX file.
  2. `node src/state/timelineReducer.js` as a test step.
  3. A `/status`, `/api/_debug/token-report` smoke (pointing at a disposable
     Supabase project + OpenAI key) on PRs to `main`.

---

## 15. Observability / ops

- **`/api/_debug/cache`** (auth): full JSON dump of metrics, cache hit ratios,
  rule-bundle distribution, transcript mode distribution, Whisper usage, system
  prompt version, LLM response cache settings.
- **`/api/_debug/token-report`** (auth): plain-text rolling p50/p95 for each
  callsite, routing fallback rate, bundle hits, Whisper minutes. Point Grafana
  or a cron at this.
- Server-side `log(msg)` prepends ISO timestamps; stdout is the only sink today.
  Ship to a platform logger when deploying.

---

## 16. Key engineering decisions (and why)

| Decision | Rationale |
|----------|-----------|
| Reducer-centric state | One mutation path; UI + AI stay consistent; undo is trivial. |
| LLM returns operations, not JSX | Safer to validate; no sandboxing; operations are trivially replayable. |
| Compressed track format in prompts | 30–60% token reduction per element; disciplined `decompressOperations` + docs. |
| Two-pass visual pipeline | Keeps Pass 1 cheap (mini model + shortlist) and defers the expensive per-candidate brief (Pass 2). |
| `claude-pick` uses nano | Picking an id from 9 scored assets needs almost no reasoning. Routing makes this ~free. |
| Remotion for final render | Programmatic video from the same timeline; headless render on any box with Node+Chromium. |
| UMD React in browser | Fast iteration without a bundler; trades IDE tooling for simplicity. |
| 1080×1920 portrait as reference | Subtitles and image anchors live in a centered coord space keyed to this size. |
| Native overlays via `src: 'native://{type}'` | Keeps everything on the image track uniformly — no separate "overlay track" type. |
| LLM response cache with user scoping | Cuts duplicate spend without cross-user leakage. |
| Separate LRUs per callsite | Hit/TTL tuned to each workload (scan shorter, pick longer). |

---

## 17. Known limitations / risks

- **Secrets handling.** `.env` is gitignored, but rotate if you ever committed a
  real key. The anon Supabase key is always public; service key must stay
  server-only.
- **In-memory job store.** `exportJobs` Map dies with the process. Not durable
  for horizontal scaling.
- **Dual-environment state files.** `schema.js` and `timelineReducer.js` must
  remain valid in *both* Node `require` and browser `<script>`. Don't add
  `import` syntax without adding a build step.
- **Aspect ratio assumption.** 1080×1920 is hardcoded in several places
  (subtitle positions, imageLayout boxes, Remotion scale table). Changing aspect
  is a coordinated pass across `schema.js`, `VideoPreview.jsx`,
  `serializeToRemotion.js`, `REMOTION_QUALITY_SCALE`, and the agent prompts.
- **Model name drift.** Defaults are `gpt-5.4[.-mini|.-nano]` (OpenAI).
  Override with `OPENAI_MODEL_*` env vars if they change.
- **Roadmap vs. code.** Features in `VibeEditor_Roadmap_2.md` may not yet exist
  — always verify in code and UI.
- **CSP / `--disable-web-security`.** Remotion render passes this flag to fetch
  cross-origin media. Acceptable in a headless render context but not in a
  browser-facing fetch.
- **Image conversion.** Uploaded images become MP4s server-side via ffmpeg. The
  frontend still treats them as imageClip when `isImage` is set. Respect both
  branches when touching `/upload`.

---

## 18. First-week onboarding checklist

1. Clone, `npm install`, `cp .env.example .env`, fill `OPENAI_API_KEY`,
   `PIXABAY_API_KEY`, and (optionally) Supabase keys.
2. `npm run dev`. Visit `/status`, then `/editor`.
3. Upload a short MP4. Watch the `/upload` response in DevTools.
4. Run a prompt in AgentPanel. Inspect the `/generate` response body — confirm
   you see `operations`, `claudeUsage`, and a `modelUsed` value.
5. Hit `/api/_debug/token-report` to confirm metrics update per call.
6. Read `src/state/schema.js` top-to-bottom. This is the canonical contract.
7. Step through `APPLY_OPERATIONS` and one `UPDATE` in
   `src/state/timelineReducer.js`. Run `node src/state/timelineReducer.js` to
   execute the self-tests.
8. Read `src/claude/systemPrompt.js` — the operation vocabulary, compressed key
   dictionary, and safety rules are normative.
9. Trace `compressTracks` → LLM → `decompressOperations` in
   `src/claude/generate.js`.
10. Press **Scan for Visuals** after your upload. Read `docs/VISUAL_PIPELINE.md`
    while candidates appear.
11. Trigger an export. Read `runExportJob` in `src/server.js` and
    `serializeToRemotion.js`. Diff the resulting MP4 against the live preview.
12. Open `VibeEditor_Roadmap_2.md` and file issues for the gaps you found.

---

## 19. Who owns what (for a real handoff)

Fill this in before the calendar meeting:

| Surface | Owner | Notes |
|---------|-------|-------|
| Backend (`src/server.js`, export pipeline) | | |
| Agent / Claude pipeline (`src/claude/*`) | | |
| Visual pipeline (`visualComponentRules.js`, `/api/visual/*`) | | |
| Frontend shell (`App.jsx`, auth, UI) | | |
| Timeline + reducer (`src/state/*`) | | |
| Render / Remotion (`serializeToRemotion.js`, compositions) | | |
| Supabase + storage + SQL migrations (`docs/sql/`) | | |
| Observability (`src/cache/metrics.js`, debug endpoints) | | |

---

## 20. Conventions and traps

- **Never add a new timeline track type for an effect.** It goes on the element.
- **Never let Claude write JSX.** Operations only. If Claude replies in prose,
  we surface that as `isExplanation` in the UI.
- **Never trust IDs from the model.** Use `CLIP_SUMMARY` numbering (from
  `generate.js`) for selection; validate element IDs exist before dispatching.
- **Always update three places** when you change the operations contract:
  1. `src/state/timelineReducer.js` (acceptance)
  2. `src/claude/generate.js` — `compressTracks` / `decompressOperations`
  3. `src/claude/systemPrompt.js` — the model contract
  (Forgetting any one of these is the most common source of silent bugs.)
- **Never commit real secrets.** Rotate if you did.
- **Never render the visual pipeline's `stylePolicy` / `keyMomentsPolicy` /
  `visualContext` as empty forever.** They are part of the request payload
  today but wired to `{}` pending the style system (Phase 4). The prompt
  contract already consumes them — see `docs/VISUAL_PIPELINE.md` §4.

---

## 21. Pointers to read next

- `docs/VISUAL_PIPELINE.md` — the "scan for visuals" feature end-to-end.
- `VibeEditor_Roadmap_2.md` — phased product plan through v1.1 batch processing.
- `src/claude/systemPrompt.js` — operation vocabulary and compression keys.
- Inline comments in `src/server.js` near `ensureStorageBuckets` — Supabase
  policies and table shape.

---

*This document is the primary engineering artifact for continuity. Update it
when architecture, APIs, or the operation contract materially change.*
