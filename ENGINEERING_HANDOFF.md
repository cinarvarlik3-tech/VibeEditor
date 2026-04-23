# Vibe Editor — Engineering Handoff

> **Purpose.** One document to onboard a new engineer: how to run and ship the app, where complexity lives, how the product is meant to work, and which older docs or scripts are **stale** vs authoritative. **Verify behavior in code** when in doubt — several markdown files in the repo describe an earlier “JSX-from-LLM” prototype; the live product is **JSON operations + `timelineReducer`**.

**Maintainers:** update this file when you change the operation contract, public routes, env vars, or major UX flows.

**As of:** April 2026 — major refresh of the previous handoff to match current `main`.

**Pair these reads:** `docs/VISUAL_PIPELINE.md` (Scan for Visuals), `VibeEditor_Roadmap_2.md` (product phases — **intent**; not every phase is fully implemented; confirm in code).

---

## Table of contents

1. [TL;DR](#1-tldr)
2. [Product: problem, audience, and philosophy](#2-product-problem-audience-and-philosophy)
3. [End-to-end user flows](#3-end-to-end-user-flows)
4. [What makes this codebase hard (map)](#4-what-makes-this-codebase-hard-map)
5. [Technology stack (exact as in repo)](#5-technology-stack-exact-as-in-repo)
6. [Repository layout](#6-repository-layout)
7. [Architecture](#7-architecture)
8. [Local development](#8-local-development)
9. [Environment variables](#9-environment-variables)
10. [Authentication and Supabase](#10-authentication-and-supabase)
11. [HTTP API reference](#11-http-api-reference)
12. [Timeline state, schema, and reducer](#12-timeline-state-schema-and-reducer)
13. [Agent pipeline: `POST /generate`](#13-agent-pipeline-post-generate)
14. [Visual pipeline (stock + optional Gemini)](#14-visual-pipeline-stock--optional-gemini)
15. [Media: upload, Pexels, audio search, transcription](#15-media-upload-pexels-audio-search-transcription)
16. [Export: Remotion and preview parity](#16-export-remotion-and-preview-parity)
17. [Caching and metrics](#17-caching-and-metrics)
18. [Frontend: no-bundler SPA](#18-frontend-no-bundler-spa)
19. [Testing and quality](#19-testing-and-quality)
20. [Observability and operations](#20-observability-and-operations)
21. [Known limitations and risks](#21-known-limitations-and-risks)
22. [Conventions, traps, and the “change three files” rule](#22-conventions-traps-and-the-change-three-files-rule)
23. [Stale or misleading artifacts](#23-stale-or-misleading-artifacts)
24. [First-week onboarding checklist](#24-first-week-onboarding-checklist)
25. [Ownership handoff table](#25-ownership-handoff-table)
26. [Further reading](#26-further-reading)

---

## 1. TL;DR

- **Product:** An AI-assisted, **portrait (9:16)** multi-track video editor. Users upload video, work on a timeline (subtitles, image overlays, video, audio), drive edits in **natural language** and/or the mouse, and **export** a deterministic MP4 via **Remotion**.
- **Core thesis:** The LLM returns **JSON operations** (add/update/delete/split/keyframes…), not arbitrary JSX. The same **`timelineReducer`** applies **user** edits and **AI** edits, so preview and server-side export stay aligned and the model stays in a **bounded sandbox**.
- **Stack (see §5 for versions):** Node + Express (`src/server.js`), React 18 in the browser via **UMD + Babel Standalone** (no webpack/vite), **OpenAI** (`openai` SDK in `src/claude/generate.js` — the `claude/` folder name is **legacy**), **OpenAI Whisper** for transcription, **Remotion 4** for final render, **Supabase** (Auth + Postgres + Storage), **Pexels** (stock), **Freesound + Jamendo** (audio), optional **Google Gemini** for **AI still** b-roll in the visual flow.
- **Composition base:** **1080×1920** at **30 fps**. Subtitle and image layout math is keyed to this frame; generalizing aspect ratio is a coordinated refactor.
- **Typical local URL:** `npm run dev` → http://localhost:3000 → `/login` → `/landing.html` → open/create project → `/editor?project=<uuid>`. The editor **requires** a `project` query param and a valid session; otherwise it redirects.

---

## 2. Product: problem, audience, and philosophy

### 2.1 Problem and usefulness

**Problem:** Short-form vertical video (Reels, Shorts, TikTok-style) usually forces creators to juggle a **non-linear editor**, **stock** sites, **subtitle** tools, and sometimes a **separate** AI chat — with constant context loss.

**Vibe Editor** compresses that into one surface: a **real timeline** the user can see and control, **transcript-grounded** AI that proposes **verifiable** edits, and **b-roll / overlay** discovery (stock search + optional AI-generated still) without leaving the app.

**Audience (typical):** In-house or power users who need **speed** with **control** — not a faceless “one prompt → video” generator. The user should always understand *what* changed and be able to undo.

### 2.2 What we are not (positioning)

- **Not** a full replacement for Avid / Premiere / Resolve.
- **Not** a real-time multi-user colab suite (roadmap has collaboration phases; check code).
- **Not** “unbounded AI slop” — the center of gravity is **control**, transcript alignment, and **JSON ops** the UI can validate.

### 2.3 Engineering + product principles

| Principle | Meaning |
|-----------|---------|
| **Single mutation path** | All timeline changes go through **`timelineReducer`**. The AI suggests **operations**; it does not own React trees. |
| **Safety over raw expressiveness** | No arbitrary code from the model on the main path. Malformed ops are dropped with **warnings**; prose-only model replies are **`isExplanation`** so state does not corrupt. |
| **Token budget is product** | Bundled system prompt, transcript windowing, rolling conversation summaries, **minimal history** by default — cost and latency are first-class. |
| **Transcript is spine** | Subtitles, many agent flows, and **Scan for Visuals** depend on **word-level** timing. Bad audio → bad transcript → bad everything downstream. |
| **Preview = export state** | **Same** `timelineState` feeds **in-browser preview** and **Remotion serialize**. If MP4 ≠ preview, treat as a bug in **`VideoPreview.jsx`** vs **`serializeToRemotion.js`** (and shared **`effectStyles.js`**). |

---

## 3. End-to-end user flows

1. **Sign in** — `/login` (Supabase email/password) via `public/auth.js` (`window.Auth`).
2. **Projects** — `/landing.html` lists **Postgres** projects; create or open → navigates to **`/editor?project=<id>`** (see `public/landing.html`).
3. **Editor bootstrap** — `public/index.html` verifies session, requires **`project`**, sets **`window.CURRENT_PROJECT_ID`**, then **fetches** `App.jsx` as text, **Babel-transforms** it, and `eval`s the result (so `App` is not a static script tag like other components).
4. **Ingest** — `POST /upload` (multipart). Images may be converted to **MP4** server-side; response includes `permanentUrl`, dimensions, `isImage`, etc.
5. **Transcript** — If not cached, audio is extracted, **Whisper** runs (`getOrTranscribeAudio` with optional **Supabase** transcript cache in `src/cache/transcriptCache.js`).
6. **Edit** — User drags/trim in **`Timeline`** or types in **`AgentPanel`** → `POST /generate` → client dispatches **`APPLY_OPERATIONS`**. Optional **“Undo last prompt”** when a checkpoint is attached.
7. **Scan for Visuals (optional)** — With transcript, multi-pass **scan → brief → pick** (see §14 and `docs/VISUAL_PIPELINE.md`); may **ingest** stock or **generate** a Gemini still then **accept** to storage.
8. **Export** — `POST /export` → job in memory → `serializeToRemotion` overwrites `src/compositions/GeneratedVideo.jsx` → `npx remotion render` → poll **status** → **download** (preview may use `/renders/...` for the same file).

---

## 4. What makes this codebase hard (map)

| Area | Why it is hard | Where to start |
|------|----------------|----------------|
| **Operation contract** | **Three** places must stay aligned: `systemPrompt.js`, `generate.js` (compress/decompress/validation), `timelineReducer.js`. | Read schema → trace one `UPDATE` and `APPLY_OPERATIONS` → read compressed keys in `generate.js`. |
| **Preview vs export** | `public/components/VideoPreview.jsx` and `src/video/serializeToRemotion.js` both interpret the same state; **drift = visible bug**. | Diff when changing effects, fonts, native overlays, or keyframes. |
| **Agent prompt size** | `systemPrompt.js` is large; **`buildSystemPrompt`** + **bundles** + **minimal history** interact. | Grep `buildSystemPrompt`, `selectRuleBundles`, `FEATURE_*`. |
| **Visual pipeline** | Multi-pass LLM + Pexels + gating + optional Gemini. | `docs/VISUAL_PIPELINE.md` + `AgentPanel.jsx` + `/api/visual/*` in `server.js`. |
| **Auth + storage** | JWT on routes, RLS, signed URLs, per-user storage paths. | `server.js` top comment block (SQL) + `requireAuth` + upload handlers. |
| **Monolithic front shell** | `public/App.jsx` is very large; no bundler. | Search by feature; follow props from `App` to panels. |
| **Remotion + CORS** | Headless Chrome uses **`--disable-web-security`** for remote media URLs. | `runExportJob` in `server.js`. |

---

## 5. Technology stack (exact as in repo)

| Layer | Technology | Notes |
|-------|------------|--------|
| Runtime | **Node 18+** (recommended) | `fetch`, async patterns; match production Node. |
| Server | **Express 4** | `src/server.js` — all routes, export orchestration. |
| AI (chat + visual text) | **OpenAI** via `openai` **^6.34.0** | `src/claude/generate.js`. Default model family **`gpt-5.4` / `-mini` / `-nano`** via `OPENAI_MODEL_*` env. |
| Transcription | **OpenAI** `whisper-1` | `src/transcription/transcribe.js` — **verbose_json** for word timings. |
| Image gen (optional) | **Google GenAI** `@google/genai` | `src/assets/aiImageGen.js`; default image model `gemini-2.5-flash-image` unless `GEMINI_IMAGE_MODEL` set. |
| Render | **Remotion 4.0.190** + `@remotion/cli` | Entry `src/index.js` (ES module); `remotion.config.js` points here. `GeneratedVideo.jsx` is **overwritten** each export. |
| Data / auth | **Supabase** `@supabase/supabase-js` | JWT validation server-side; anon key only in HTML. |
| Video processing | **fluent-ffmpeg** (requires **ffmpeg** on `PATH`) | Audio extract, image→video, thumbnails. |
| Client UI | **React 18** UMD, **Babel** standalone, **Tailwind** play CDN, **Framer Motion** UMD, **Lucide** UMD (0.294) | See `public/index.html` **load order**. |
| Caching | **lru-cache** 11 + custom wrappers | Transcript (DB + optional), render (disk), LLM (memory), Pexels, audio search. |

**Version constants in code (useful for support):**

- `GET /status` returns `{ version: '0.2.0', ... }` (`src/server.js`).
- `SYSTEM_PROMPT_VERSION` is **`v2.0.0`** (`src/claude/systemPrompt.js`).

---

## 6. Repository layout

```
VibeEditorCopy/
├── src/
│   ├── server.js                 # Express: routes, auth, export, static mounts
│   ├── index.js                  # Remotion entry (ES modules) — registerRoot
│   ├── claude/
│   │   ├── generate.js           # OpenAI: generateOperations, visual helpers, compress/decompress
│   │   ├── systemPrompt.js       # SYSTEM_PROMPT, buildSystemPrompt, SYSTEM_PROMPT_VERSION, bundles
│   │   └── visualComponentRules.js  # LLM rules for visual pipeline (name legacy)
│   ├── state/
│   │   ├── schema.js             # initialTimelineState; dual global/require
│   │   └── timelineReducer.js    # All mutations + APPLY_OPERATIONS; inline self-tests
│   ├── transcription/transcribe.js
│   ├── video/
│   │   ├── extract.js            # ffmpeg: audio, thumbs, image→mp4
│   │   ├── render.js            # legacy JSX-string render helper (see §23)
│   │   └── serializeToRemotion.js
│   ├── compositions/
│   │   ├── BaseVideo.jsx
│   │   └── GeneratedVideo.jsx   # Overwritten at export — do not hand-edit for features
│   ├── assets/
│   │   ├── audio.js              # Freesound / Jamendo / unified search
│   │   ├── aiImageGen.js         # Gemini image generation
│   │   └── nativeVisuals.js     # native:// overlay payloads
│   ├── cache/                    # LRU, transcript, render, LLM response cache, metrics, hash
│   └── styles/style_guide_v1.json
├── public/                       # No bundler
│   ├── index.html                # Editor shell; dynamic App.jsx load
│   ├── landing.html, login.html
│   ├── App.jsx                   # Root component — large
│   ├── auth.js, fontLoader.js, effectStyles.js, styles.css
│   └── components/               # VideoPreview, Timeline, LeftPanel, AgentPanel, …
├── docs/
│   ├── VISUAL_PIPELINE.md
│   ├── sql/
│   │   └── cache_tables.sql      # transcripts cache table
│   └── VisualSystem_UpdatedSpec.docx
├── tests/
│   ├── test-stage1.js            # Smoke: require generate + metrics (see §19)
│   └── fixtures/
├── uploads/ output/ frames/     # Default local (gitignored)
├── .env.example
├── package.json
├── remotion.config.js
├── run.js                        # Legacy CLI — broken as-is (§23)
├── Stage1Plan.md                 # Historical Stage 1 plan
├── VibeEditor_Roadmap_2.md
└── ENGINEERING_HANDOFF.md        # This file
```

---

## 7. Architecture

```
Browser (public/)
  index.html
    → Tailwind, React UMD, Babel, Framer Motion, Lucide
    → /state/schema.js → window.TimelineSchema
    → /state/timelineReducer.js → window.TimelineReducer
    → effectStyles.js, components (VideoPreview…), then dynamic App.jsx
  window.Auth (auth.js) — session + token for fetch

        │  HTTPS: JSON, multipart, Bearer JWT
        ▼
Express (src/server.js)
  Middleware: cors, body parser (50mb)
  requireAuth: Supabase JWT → req.user
  Static: /state, /renders → output/, /uploads, /audio, public/
  APIs: /upload, /generate, /api/projects, /api/visual/*, /export, …
  Long jobs: exportJobs Map (in-memory) + Remotion child process

        ├── OpenAI (chat, whisper)
        ├── Remotion CLI
        ├── Supabase (auth, DB, storage)
        ├── Pexels, Freesound, Jamendo
        └── Gemini (optional) for AI stills
```

**Mental model:** `timelineState` is the **single source of truth**. The AI never writes Remotion code on the main path — it appends to that state through **operations**.

---

## 8. Local development

### 8.1 Prerequisites

- **Node 18+**
- **ffmpeg** and **ffprobe** on `PATH`
- **OpenAI API key** (chat + whisper)
- **Supabase** project (for anything beyond bare UI — auth + projects + storage are integrated)
- **Pexels** key for stock search in Scan for Visuals
- Optional: **GOOGLE_FONTS_API_KEY**, **FREESOUND_API_KEY**, **JAMENDO_CLIENT_ID**, **GEMINI_API_KEY**

### 8.2 Install and run

```bash
cd VibeEditorCopy
npm install
cp .env.example .env
# Edit .env — see §9
npm run dev
# Open http://localhost:3000  →  login  →  landing  →  open project (editor)
```

`npm run predev` kills port **3000**; `dev` uses **nodemon** on `src/server.js`.

### 8.3 Scripts (`package.json`)

| Script | Purpose |
|--------|---------|
| `npm start` | `node src/server.js` |
| `npm run dev` | nodemon (restart on change) |
| `npm run test:stage1` | Loads `src/claude/generate` + cache metrics (smoke import) — **not** a full E2E test (§19) |

### 8.4 “Hello world”

1. `GET http://localhost:3000/status` → `{ "status":"ok","version":"0.2.0" }`
2. Log in, create a project on landing, land on **`/editor?project=...`**
3. Upload a short MP4, wait for transcript path in UI
4. Send an agent prompt (“make subtitles larger”) — inspect `POST /generate` response: **`operations`**, `modelUsed`, optional `isExplanation`
5. Optional: Scan for Visuals, then Export — poll `GET /export/status/:jobId`

---

## 9. Environment variables

**Authoritative list:** `.env.example` in repo. Do not commit real secrets.

| Variable | Role |
|----------|------|
| `PORT` | HTTP port (default 3000) |
| `OPENAI_API_KEY` | Required for **Whisper** + **agent** + **visual** LLM steps |
| `OPENAI_MODEL_FLAGSHIP` / `MINI` / `NANO` | Model overrides (defaults `gpt-5.4` family) |
| `FEATURE_MODEL_ROUTING` | `true` = route mini/nano; `false` = flagship only |
| `FEATURE_TRANSCRIPT_WINDOWING` | Send transcript window vs full (when possible) |
| `FEATURE_HISTORY_SUMMARIES` | Roll ≥10 turns into a summary call |
| `FEATURE_PROMPT_BUNDLES` | Keyword-selected subsets of the system prompt |
| `FEATURE_MINIMAL_HISTORY` | Default **on** (unset = on): old turns = **prompt text only**; full snapshots when user references past (“undo that”, “same as before”) — see `promptNeedsFullHistorySnapshot` in `generate.js` |
| `GEMINI_API_KEY` / `GEMINI_IMAGE_MODEL` | Optional AI still generation path |
| `CACHE_ENABLED` | Master switch for transcript DB cache and disk render cache |
| `LLM_RESPONSE_CACHE_*`, `LLM_SUMMARIZE_*`, `LLM_VISUAL_*` | Per–call-site in-memory cache sizing/TTL |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` | Auth + server admin client |
| `GOOGLE_FONTS_API_KEY` | Optional; else `/api/fonts` returns fallback list |
| `PEXELS_API_KEY` | Stock search / ingest (Pexels; `Authorization: <key>`, not Bearer) |
| `FREESOUND_API_KEY`, `JAMENDO_CLIENT_ID` | Audio library search |
| `MAX_UPLOAD_MB` | Default very large; set sensibly in production |
| `OPENAI_BASE_URL`, `OPENAI_TRANSCRIBE_TIMEOUT_MS` | Advanced overrides |

If Supabase is **missing**, `requireAuth` returns **503** on protected routes; HTML can still be served with **empty** injected config.

---

## 10. Authentication and Supabase

- **Client:** `public/auth.js` — `Auth.getToken()`, session helpers; token sent as `Authorization: Bearer …` on protected `fetch` calls.
- **Server:** `createClient` with **service role** for `getUser` + storage. **Service key** never in the browser.
- **HTML:** `injectSupabaseConfig` replaces `<!--VIBE_SUPABASE_CONFIG-->` in `index.html` / `landing.html` / `login.html` with `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY`.
- **Storage:** `ensureStorageBuckets()` creates **`videos`**, **`thumbnails`** (public read), **`audio`**, **`image-layer`**. SQL policy **examples** and **`projects` table** hints are in the **block comment** at the top of `src/server.js` — run/adapt in Supabase SQL editor.
- **Transcript cache table:** `docs/sql/cache_tables.sql` — `transcripts` keyed by `audio_hash` + `language_hint`.

---

## 11. HTTP API reference

**Convention:** Unless noted, JSON body/response. **`Authorization: Bearer <JWT>`** required for protected routes.

### 11.1 Public / static

| Method | Path | Notes |
|--------|------|--------|
| GET | `/status` | `{ status, version }` — `?debug=cache` adds metrics snapshot |
| GET | `/` | Redirect to `/landing.html` |
| GET | `/landing`, `/landing.html` | Landing (injected Supabase config) |
| GET | `/editor`, `/index.html` | **Same** `index.html` (editor) — client **requires** `?project=` |
| GET | `/login`, `/login.html` | Login page |
| GET | `/api/fonts` | Google Fonts list or fallback — **no auth** |
| GET | `/state/schema.js`, `/state/timelineReducer.js` | State layer for browser |
| | Static | `/uploads`, `/renders` (from `output/`), `/audio`, then general `public/` |

### 11.2 Auth

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/auth/verify` | `requireAuth` — validates token |

### 11.3 Projects (auth)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/projects` | List |
| POST | `/api/projects` | Create (e.g. `name`) |
| GET | `/api/projects/:id` | Load `timeline` + `transcript` + metadata |
| PATCH | `/api/projects/:id` | Partial update (timeline, name, …) |
| DELETE | `/api/projects/:id` | Delete |

### 11.4 Media and libraries (auth)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/upload` | Multipart `video` field; returns URLs + metadata; may background-upload to storage |
| GET | `/api/pexels/search` | `q` (required), `asset_type` `photos` \| `videos` \| `all`, `per_page` (default 15, max 80); portrait is fixed server-side |
| POST | `/api/pexels/ingest` | `{ asset, projectId }` → download → image→mp4 for photos → `image-layer` + attribution |
| GET | `/api/audio/uploads` | User-uploaded audio list for agent context |
| GET | `/api/audio/search` | `q` required; `sources=freesound,jamendo` (default both) — unified **LRU** |
| GET | `/api/audio/search/freesound` | Direct |
| GET | `/api/audio/search/jamendo` | Direct |

### 11.5 AI and export (auth)

| Method | Path | Notes |
|--------|------|--------|
| POST | `/generate` | Main agent — see §13 |
| POST | `/api/summarize-conversation` | Rolling history compression |
| POST | `/api/visual/scan` | Pass 1 — candidates |
| POST | `/api/visual/brief` | Pass 2 — retrieval brief |
| POST | `/api/visual/claude-pick` | Pick among assets (name says “claude”; **OpenAI**) |
| POST | `/api/visual/generate-image` | Gemini PNG (base64 JSON) — no storage until accept |
| POST | `/api/visual/accept-generated` | PNG → MP4 → storage |
| POST | `/export` | Queue Remotion job |
| GET | `/export/status/:jobId` | `queued` / `running` / `done` / `error` |
| GET | `/download/:filename` | Download finished file from `output/` |
| GET | `/renders/:filename` | Same for preview streaming |
| GET | `/api/_debug/cache`, `GET /api/_debug/token-report` | **Auth** — metrics, caches, token rollups (text for token report) |
| GET | `/presets` | **Stub:** returns `[]` — full preset system not wired here yet |

---

## 12. Timeline state, schema, and reducer

**Files:** `src/state/schema.js`, `src/state/timelineReducer.js`.

- **Dual environment:** `schema.js` and `timelineReducer.js` are written as **IIFEs** that work in **Node** (`require`) and **browser** (global `script`). Do not switch them to ESM without a build step.
- **Top-level state:** `project`, `source`, `tracks: { subtitle, image, video, audio }`, `history`, `playback` — see `initialTimelineState` in `schema.js` for the canonical **defaults** and comments on **element shapes** (`videoClip`, `subtitle`, `audioClip`, `imageClip`, keyframes, `native://` image sources).

**Reducer actions (high level):** `SET_STATE`, `LOAD_SOURCE`, `UPDATE_PROJECT_NAME`, `SET_PLAYBACK_TIME`, `TOGGLE_PLAYBACK`, `MOVE_ELEMENT`, `UPDATE_ELEMENT`, `DELETE_ELEMENT`, `UNDO`, `REDO`, `UNDO_LAST_PROMPT`, `APPLY_OPERATIONS`, track CRUD, keyframe ops, `SPLIT_ELEMENT`, `REORDER_TRACK`, etc. Unknown `op` values are skipped with a warning.

**Architectural rules (from `schema.js`):**
- Effects/animations live **on elements**, not new track types.
- **Image** track is between video and subtitles in z-order; image **overlays** base video.
- **Multiple** `videoClip`s on the **video** track are allowed; gaps show black in preview.

Run **`node src/state/timelineReducer.js`** to execute the file’s **self-tests** at the bottom.

---

## 13. Agent pipeline: `POST /generate`

**Implementation:** `src/claude/generate.js` + `src/claude/systemPrompt.js`.

### 13.1 Request body (typical)

| Field | Required | Notes |
|--------|----------|--------|
| `videoPath` | Yes | **Local** path as returned from upload (e.g. `/uploads/...`) **or** `http(s)` URL — server may **download to temp** for **transcription** |
| `prompt` | Yes | User instruction |
| `currentTracks` | Yes | Current `tracks` object |
| `transcript` | No | If omitted, extract audio + **Whisper** (with cache) |
| `language` | No | Hint for Whisper |
| `presetName` | No | Reserved / Stage roadmap |
| `conversationExchanges` | No | Prior turns for memory / summaries |

### 13.2 Server steps (simplified)

1. Resolve `videoPath` to a file (local under repo or **temp** for URLs).
2. If no `transcript`, **getOrTranscribeAudio** (Whisper, optional DB cache if `CACHE_ENABLED` and table exists).
3. `ffprobe` → **source duration**; `scanUploadedAudio()` for filenames in `uploads/`.
4. **LLM cache** key: canonical hash of user id + prompt + tracks + transcript + duration + audio list + exchanges — on hit, skip model call; usage tokens zeroed in response.
5. **`generateOperations`**: **bundle** selection, optional **transcript window**, **history summaries**, **compressTracks**, **buildMessagesForGenerate** / **`buildSystemPrompt`**, model routing (mini with optional **fallback** to flagship on invalid JSON), OpenAI **chat.completions** — returns **decompressed** operations, **warnings**, **`isExplanation`**, **usage**, **`modelUsed`**, **`fallback`**.

### 13.3 Response (typical)

- `operations` — array for `APPLY_OPERATIONS`
- `transcript` — always returned (server may have generated it)
- `warnings` — string array
- `isExplanation` — true if model did not yield applicable ops
- `claudeUsage` — **usage object** (name is legacy; it is **OpenAI** usage; zeros on cache hit)
- `modelUsed`, `fallback`
- **`llmCacheHit`**, **`llmCache`** — cache diagnostics

### 13.4 Cost / latency guard rails

- **Bundles:** `selectRuleBundles` from keywords — include **subtitles** heuristics for vague “make it bigger” style requests.
- **Model routing** — `METRICS` in `src/cache/metrics.js` (fallback counts, bundle hits, transcript modes, Whisper minutes, etc.).

---

## 14. Visual pipeline (stock + optional Gemini)

**Spec:** `docs/VISUAL_PIPELINE.md` (authoritative for passes, JSON shapes, gating, UI states).

**Stock path (3 LLM steps + Pexels):**
1. `POST /api/visual/scan` — **candidates** from transcript
2. `POST /api/visual/brief` — per-candidate **search brief** (includes `searchQuery` for Pexels, distilled in Pass 2)
3. `POST /api/visual/claude-pick` — pick asset id from ranked results  
Rules text: `src/claude/visualComponentRules.js` (**Pass 1 / Pass 2** in the sense of *rules for the model*, not the Gemini module name).

**AI still path (Gemini):**
- `POST /api/visual/generate-image` — `generateImageFromDescription` in `aiImageGen.js` — **PNG in JSON (base64)**; large response.
- `POST /api/visual/accept-generated` — image → **MP4** (ffmpeg) → **Supabase** `image-layer` — same **shape** as Pexels ingest for client `CREATE` of `imageClip`.
- If **`GEMINI_API_KEY`** is unset, that path **errors** — UI should hide or message clearly.

Each visual endpoint has its own **in-memory** LLM cache (see env names in §9).

---

## 15. Media: upload, Pexels, audio search, transcription

- **Upload:** Multer to `uploads/`; images → `convertImageToVideo`; Supabase upload + **signed** URLs; thumbnails; optional **async** project row update. Max size: `MAX_UPLOAD_MB` (default very large).
- **Pexels:** 24h **in-memory** LRU for search (`pexelsLRU`), `GET /api/pexels/search` (portrait `orientation` hardcoded; photos + videos + interleaved `all`); `POST /api/pexels/ingest` returns `attribution` for UI.
- **Transcription:** ffmpeg extract **16k mono**; Whisper **verbose_json**; cache in **`transcripts`** table when enabled (see `docs/sql/cache_tables.sql`).

---

## 16. Export: Remotion and preview parity

1. `POST /export` with full **timeline** state + filename + `format` (`mp4`|`mov`) + `quality` (`720p`|`1080p`|`4k`).
2. `serializeToRemotion(state)` → string of **`GeneratedVideo.jsx`** + `durationInFrames`.
3. Write file under `src/compositions/`, spawn `npx remotion render` with `src/index.js` `GeneratedVideo`, **scale** from quality, **`--disable-web-security`**.
4. Optional **render cache** on disk under `output/` (hash) when `CACHE_ENABLED`.
5. **`exportJobs`** is **in-memory** — **lost on restart**; not safe for multi-instance without external store.

**Parity rule:** any change to how subtitles, video, image (including `native://`), or audio look in **`VideoPreview.jsx`** must be reflected in **`serializeToRemotion.js`** (and **effectStyles** if shared). **Claude** in Remotion’s `index.js` comments still say “Claude-generated” — **outdated**; the file is **serialized from state**, not from an LLM.

---

## 17. Caching and metrics

| Cache | Location | Scope / TTL (typical) |
|-------|----------|------------------------|
| Transcript (Whisper) | `transcriptCache.js` + Supabase | `audio_hash` + language |
| LLM response | `llmResponseCache.js` | Per user id + payload hash; separate pools per use case |
| Render | `renderCache.js` | Disk under `output/` |
| Pexels / audio / fonts | `server.js` LRUs | In-memory, hours |
| **Metrics** | `src/cache/metrics.js` + `/api/_debug/*` | Rolling windows, bundle hits, routing stats |

**Keys:** `canonicalStringify` + SHA-256 in `src/cache/hash.js` where applicable.

---

## 18. Frontend: no-bundler SPA

- **`index.html` load order** matters: React → ReactDOM → Babel → **Framer Motion** → **Lucide** shim → **/state** → **effectStyles** → **components** → **App via fetch + Babel transform** (not a `script type="text/babel" src=App` tag).
- **Tailwind** is loaded via **CDN** with a small **vibe-*** color extension in a `<script>` config block.
- **Global symbols:** e.g. `window.TimelineSchema`, `window.TimelineReducer`, `window.EffectStyles`, `window.LucideReact` / icons, `window.Motion` (Framer), **`window.CURRENT_PROJECT_ID`** set before App runs.
- **State:** one **`useReducer(timelineReducer, initialTimelineState)`** in `App.jsx`; children get **dispatch** and state slices.
- **Do not** add ES `import` in `public/` without introducing a bundler.

---

## 19. Testing and quality

- **`npm run test:stage1`** — Currently loads `../src/claude/generate` and `metrics.chatSiteStats('generate')` then exits. It **validates the module graph loads**, not a full edit→render E2E. The name is **legacy** from the Stage 1 plan.
- **`node src/state/timelineReducer.js`** — Runs **reducer** self-tests; use as a cheap CI step.
- **No** TypeScript, **no** repo-wide ESLint in `package.json` — use `node --check file.js` and editor tooling.
- Suggested hardening: `node --check` on all JS, reducer self-test, and a smoke that hits `/status` with a real `.env` in CI.

---

## 20. Observability and operations

- **`/api/_debug/cache`** (auth) — JSON: cache sizes, **SYSTEM_PROMPT_VERSION**, metrics snapshot, etc.
- **`/api/_debug/token-report`** (auth) — **plain text** rolling p50/p95 per callsite, routing, Whisper minutes.
- **Logging:** ad-hoc `log()` with timestamps in `server.js` — stdout only; for production, ship to a log stack.

---

## 21. Known limitations and risks

- **In-memory export jobs** — not durable, not multi-instance.
- **Secrets** — rotate if ever committed; only **anon** key belongs in the browser.
- **Aspect ratio** — 1080×1920 and 30 fps assumptions are **pervasive** (UI, Remotion, prompts, image gen suffix).
- **CORS / `--disable-web-security`** on Remotion only — acceptable in **headless** render, not a pattern for normal browser use.
- **Presets** — `/presets` is empty; `presetName` in `/generate` is **forward-looking**.
- **Model names** in env default to a **5.4** family; OpenAI’s catalog can change — **env overrides** are the escape hatch.
- **Roadmap** documents may describe **sharing**, **version history**, **batch** — **verify** in code before assuming shipped.

---

## 22. Conventions, traps, and the “change three files” rule

When you **change the operation vocabulary** (new op, new field on an element, new compressed key):

1. **`src/state/timelineReducer.js`** — apply and validate.
2. **`src/claude/generate.js`** — `compressTracks` / `decompressOperations` (and any validation).
3. **`src/claude/systemPrompt.js`** — model-facing contract and examples.

**Do not** add a **new track type** for “effects” — add **properties** on elements.

**Do not** use **model-suggested element IDs** without checking **CLIP_SUMMARY** / existing state — the prompt layer documents safe reference patterns.

**Do not** treat **prose** model output as operations — the UI should respect **`isExplanation`**.

**Visual policy objects:** e.g. `stylePolicy` / `visualContext` in payloads may be **placeholders** for a future **style system** — see `docs/VISUAL_PIPELINE.md` for how they are (or are not) wired; **empty forever** in prompts may be a bug if the product expects them to drive behavior.

---

## 23. Stale or misleading artifacts

| Artifact | Issue |
|----------|--------|
| **`run.js`** | Imports **`generateVideoComponent`** from `generate.js` — **no longer exported** (replaced by `generateOperations`). **Do not use** without rewriting; will throw at require time if fixed path still wrong. |
| **`Stage1Plan.md`**, **`VibeEditor_Roadmap1.md`** | Describe **old** “Anthropic + JSX to file” **Stage 1** flow. The product **now** uses **OpenAI** + **operations**. Keep as **history** only. |
| **`src/video/render.js`** | Assumes **JSX string** from the old API — only relevant if you restore a CLI **string**-based pipeline. **Export** path uses **`serializeToRemotion`**, not this. |
| **Comments in `src/index.js`** | Say “Claude-generated” for `GeneratedVideo` — file is **serializer output**, not model output. |
| **`/presets` stub** | Not the future preset system from the roadmap. |

---

## 24. First-week onboarding checklist

1. **Clone**, `npm install`, `.env` from `.env.example` — minimum `OPENAI_API_KEY` + **Supabase** for full path + **Pexels** key for stock visuals.
2. **`GET /status`**, then **login** → **landing** → **create project** → confirm URL **`/editor?project=...`**
3. **Upload** a short clip; watch **Network** for `/upload` and transcript behavior.
4. **Agent** prompt; inspect **`/generate`**: `operations`, `modelUsed`, `isExplanation`, **`llmCacheHit`** on repeat.
5. Read **`src/state/schema.js`** top-to-bottom (element types).
6. **Trace** one **`APPLY_OPERATIONS`** path in `timelineReducer.js`; run **`node src/state/timelineReducer.js`**
7. Skim **`systemPrompt.js`** (version + bundles) and **grep** `buildSystemPrompt` / `decompressOperations` in **`generate.js`**
8. Read **`docs/VISUAL_PIPELINE.md`** and click **Scan for Visuals** once.
9. **Export**; read **`runExportJob`** in **`server.js`** and **`serializeToRemotion.js`**; compare a frame to **preview**
10. Skim **`VibeEditor_Roadmap_2.md`**; file tickets for **gaps** between doc and app.

---

## 25. Ownership handoff table

| Surface | Primary files / systems |
|---------|-------------------------|
| Backend, HTTP, export | `src/server.js` |
| Agent, compression, visual LLM | `src/claude/generate.js`, `src/claude/systemPrompt.js` |
| Visual pass rules (text) | `src/claude/visualComponentRules.js` |
| State + ops | `src/state/schema.js`, `src/state/timelineReducer.js` |
| Remotion, export parity | `src/video/serializeToRemotion.js`, `public/components/VideoPreview.jsx`, `public/effectStyles.js`, `src/compositions/BaseVideo.jsx` |
| In-browser shell | `public/index.html`, `public/App.jsx`, `public/components/*` |
| Caching, metrics | `src/cache/*` |
| Transcription | `src/transcription/transcribe.js`, `src/cache/transcriptCache.js` |
| Supabase / SQL | `docs/sql/cache_tables.sql` + `server.js` top SQL comment block |
| **Fill names below for your team** | **Owner:** ___ |

---

## 26. Further reading

- **`docs/VISUAL_PIPELINE.md`** — Scan for Visuals, gates, model passes, client UX.
- **`VibeEditor_Roadmap_2.md`** — Phased product plan (use as **intent**).
- **`src/claude/systemPrompt.js`** — Operation contract, **`SYSTEM_PROMPT_VERSION`**, bundle boundaries.
- **`src/server.js`** (header comment + each route) — **live** API details supersede this doc if they diverge.

---

*This document is the **primary** engineering artifact for continuity. Update it when public behavior, the operation contract, env names, or editor bootstrap change materially.*
