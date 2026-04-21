# Vibe Editor — Engineering Handoff

**Purpose:** Give a new engineer enough context to run, extend, and ship the product without tribal knowledge.  
**Companion doc:** `VibeEditor_Roadmap_2.md` (phased product plan through v1.1 batch processing).  
**Stack at a glance:** Node (Express) + React 18 (UMD + Babel in-browser) + single `useReducer` timeline + Anthropic Claude + OpenAI Whisper + Remotion CLI + Supabase (auth, projects, storage).

---

## 1. What this project is

**Vibe Editor** is an in-house, AI-assisted **timeline-based video editor**. Users upload (or reference) media, edit on a **multi-track timeline** (video, image overlays, audio, subtitles), optionally drive edits via **natural language** (“trim the first clip”, “bigger subtitles”), and **export** a rendered file through **Remotion**.

The product thesis: **structured operations instead of generated JSX** — the model returns a JSON **operation list** that applies to the same reducer the UI uses, so preview and export stay aligned.

---

## 2. What it does today

| Area | Behavior |
|------|----------|
| **Timeline** | Video, image, subtitle, and audio tracks; drag clips; trim; split; reorder tracks; visibility/lock; undo/redo and “undo last prompt”. |
| **Preview** | Browser-side composition (1080×1920 portrait assumption in many paths); video + image layers + subtitles + audio playback. |
| **Subtitles** | Style, position, animation; word-level timing from transcript when available. |
| **Image layer** | `imageClip` elements (uploads, Pixabay, native overlays) with `fitMode`, opacity keyframes, and **`imageLayout`** (fullscreen vs custom box, anchor/box in shared coordinate space with subtitles — center origin). |
| **AI edit** | `POST /generate`: optional transcription + Claude → `{ operations, transcript, ... }`; client dispatches `APPLY_OPERATIONS`. |
| **Visual suggestions** | Separate pipeline endpoints (`/api/visual/*`) for scanning / brief / Claude pick (see server). |
| **Export** | `POST /export` queues a job; server writes `src/compositions/GeneratedVideo.jsx` from `serializeToRemotion()`, runs `npx remotion render`; poll `GET /export/status/:jobId`; download `GET /download/:filename`. |
| **Auth** | Supabase JWT; protected routes use `Authorization: Bearer <token>`. |
| **Projects** | CRUD against Supabase `projects` (timeline JSON, transcript, metadata) when configured. |
| **Assets** | Upload video/audio/images; Pixabay search/ingest; Freesound/Jamendo search helpers; optional Supabase Storage URLs. |

---

## 3. What it will do (roadmap)

See **`VibeEditor_Roadmap_2.md`** for the authoritative phased plan. Summary:

1. **Foundation** — Cloud transcription hardening, auth/login (Supabase).  
2. **Infrastructure** — Project memory, storage migration, multi-clip agent reliability.  
3. **Intelligence** — Agent memory / rolling summaries, richer fonts.  
4. **Style system** — Presets, (optional) vision-based style copy.  
5. **Collaboration** — Sharing + named versions.  
6. **Security & deploy** — Audit, RLS, rate limits, HTTPS.  
7. **v1.1 Batch** — Multi-video pipeline, concurrent renders, bulk export.

Treat the roadmap as **product intent**; implementation status may lag—verify in code and UI.

---

## 4. Philosophy & design principles

1. **Single source of truth** — All timeline mutations go through **`timelineReducer`** (user edits and AI `APPLY_OPERATIONS`). Avoid parallel “shadow state” for the same facts.  
2. **Operations, not pixels** — Claude outputs **JSON operations** (`CREATE`, `UPDATE`, `DELETE`, keyframe ops, etc.), not React/Remotion source from the model.  
3. **Preview ≈ export** — `serializeToRemotion.js` is written to mirror preview semantics (composition size, subtitles, video, **image layout**, etc.). When they diverge, treat it as a bug.  
4. **Effects live on elements** — Schema explicitly states: animations/effects are **properties of elements**, not new track types (CapCut-style mental model).  
5. **Pragmatic frontend delivery** — No bundler in the default path: React UMD + Babel in the browser keeps the repo simple; tradeoff is less IDE tooling than Vite/Next.  
6. **Compress model context** — `compressTracks()` shortens keys for Claude input; server **`decompressOperations()`** expands before applying. Image clips include compact **`il`** (layout) so the model can read anchors.

---

## 5. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (public/)                                                │
│  index.html → React App.jsx → VideoPreview, Timeline, LeftPanel,  │
│  AgentPanel, …                                                   │
│  Globals: TimelineSchema, TimelineReducer (script tags)           │
└───────────────┬───────────────────────────────────────────────────┘
                │ HTTPS JSON + multipart + Bearer JWT
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Express (src/server.js)                                        │
│  Static /public, /state/* (schema + reducer), APIs              │
│  /upload, /generate, /export, projects, audio, pixabay, visual…   │
└───┬─────────────┬───────────────────────────────┬───────────────┘
    │             │                               │
    ▼             ▼                               ▼
 OpenAI        Anthropic                      Remotion CLI
 (Whisper)     (generate.js)                  (render job)
    │             │                               │
    └─────────────┴───────────────────────────────┘
                    Supabase (auth + DB + storage when enabled)
```

**Data flow (AI edit):**  
Client sends `{ prompt, timelineState, transcript?, … }` → server may transcribe → `generateOperations()` builds Claude messages with **compressed tracks** + system prompt → Claude returns JSON array → **`decompressOperations`** → client **`APPLY_OPERATIONS`** → reducer updates → UI re-renders.

---

## 6. Repository layout ( engineer map )

| Path | Role |
|------|------|
| `public/` | SPA: `App.jsx`, components (`VideoPreview`, `Timeline`, `LeftPanel`, `AgentPanel`, …), `auth.js`, `styles.css`, `index.html`. No ES modules in the default setup. |
| `src/server.js` | Express app, routes, auth middleware, export job runner, upload handling. |
| `src/state/schema.js` | Initial timeline state + **documentation** of element shapes; `defaultImageClipLayout()` etc. |
| `src/state/timelineReducer.js` | All reducer actions + `APPLY_OPERATIONS` / `applyOperation` + tests at bottom of file. |
| `src/claude/generate.js` | Anthropic client, compress/decompress tracks & ops, `generateOperations`, summarization, visual helpers. |
| `src/claude/systemPrompt.js` | Large `SYSTEM_PROMPT` + rules; documents compressed key vocabulary for Claude. |
| `src/video/serializeToRemotion.js` | Timeline → self-contained `GeneratedVideo.jsx` string. |
| `src/video/extract.js` | FFmpeg: audio extract, thumbnails, image→video, etc. |
| `src/transcription/transcribe.js` | OpenAI audio transcriptions API (`whisper-1`, verbose_json). |
| `src/assets/` | Audio search integrations (Freesound, Jamendo, unified search). |
| `src/compositions/` | Runtime-written `GeneratedVideo.jsx` + Remotion entry (`src/index.js` per package usage—verify in repo). |
| `uploads/`, `output/` | Local media and rendered exports (gitignored as appropriate). |
| `tests/` | e.g. `test-stage1.js` — extend for CI. |

---

## 7. Timeline state model (mental model)

Top-level reducer state (see `schema.js`) includes:

- **`project`** — id, name, timestamps.  
- **`source`** — main video metadata (duration, fps, thumbnails, …).  
- **`tracks`** — `subtitle[]`, `image[]`, `video[]`, `audio[]` each an array of **tracks** with `{ id, index, name, locked, visible, elements[] }`.  
- **`history`** — undo stacks (`past` / `future`), prompt checkpoints for “undo last AI edit”.  
- **`playback`** — current time, playing flag, derived duration, etc.

**Element types** (non-exhaustive): `subtitle`, `videoClip`, `imageClip`, `audioClip`.  
**Image clips** carry `imageLayout` (`layoutMode`, `anchor`, `box`, `lockAspect`) and optional `intrinsicAspect` for aspect lock in the UI.

**Compositing order (bottom → top):** video → **image** → subtitles (see schema comments). Audio is not a video layer.

---

## 8. APIs (HTTP)

Unless noted, **JSON** body/response. Many routes require **`Authorization: Bearer <Supabase JWT>`**.

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/status` | No | Health: `{ status, version }`. |
| GET | `/` , `/editor`, `/login`, `/landing` | No | HTML shells; Supabase keys may be injected via placeholder in HTML. |
| POST | `/api/auth/verify` | Yes | Validates JWT. |
| GET/POST/DELETE | `/api/projects`, `/api/projects/:id` | Yes | List/create/load/delete projects (Supabase). |
| POST | `/upload` | Yes | Multipart `video` field; returns paths/URLs/metadata. |
| POST | `/generate` | Yes | Main AI edit endpoint. |
| POST | `/export` | Yes | Queue Remotion job → `{ jobId, filename }`. |
| GET | `/export/status/:jobId` | Yes | Poll job. |
| GET | `/download/:filename` | Yes | Download from `output/`. |
| GET | `/renders/*` | varies | Served media for preview (see server). |
| GET | `/state/schema.js` , `/state/timelineReducer.js` | No | Browser loads state layer. |
| GET | `/api/fonts` | No | Google Fonts catalogue (API key optional; fallback list). |
| GET | `/presets` | No | Style presets list (if implemented on disk/DB). |
| POST | `/api/summarize-conversation` | Yes | Rolling summary for long sessions. |
| GET | `/api/pixabay/search` | Yes | Image search proxy. |
| POST | `/api/pixabay/ingest` | Yes | Ingest asset to user storage. |
| POST | `/api/visual/scan`, `/api/visual/brief`, `/api/visual/claude-pick` | Yes | Visual suggestion pipeline. |
| GET | `/api/audio/*` | Yes | Uploads listing + search proxies. |

**Details and request shapes:** read the comment blocks above each handler in **`src/server.js`** (they are the closest thing to an OpenAPI spec today).

---

## 9. Environment variables (names only)

Never commit real secrets. Typical variables (check `server.js` and `generate.js` for full usage):

- **`PORT`** — HTTP port (default 3000).  
- **`ANTHROPIC_API_KEY`** — Claude.  
- **`OPENAI_API_KEY`** — Whisper / transcriptions.  
- **`OPENAI_BASE_URL`**, **`OPENAI_TRANSCRIBE_TIMEOUT_MS`** — optional.  
- **`SUPABASE_URL`**, **`SUPABASE_ANON_KEY`** (browser-injected), **`SUPABASE_SERVICE_KEY`** (server only).  
- **`GOOGLE_FONTS_API_KEY`** — optional; fallback font list if missing.  
- **`FREESOUND_API_KEY`**, **`JAMENDO_CLIENT_ID`** — audio search.  
- **`PIXABAY_API_KEY`** — stock images.  
- **`MAX_UPLOAD_MB`** — upload size cap.

---

## 10. Claude integration (technical)

- **Entry:** `generateOperations()` in `src/claude/generate.js`, invoked from `POST /generate`.  
- **System prompt:** `src/claude/systemPrompt.js` — defines operation vocabulary, compressed track format, safety rules.  
- **Track compression:** `compressTracks()` shrinks property names for `CURRENT_TRACKS` in the user message. Subtitles use `p` for position; image clips use **`il`** for `imageLayout` (`lm`, `ax`, `ay`, `bw`, `bh`, `la`).  
- **Decompression:** `decompressOperations()` maps short op payloads and `UPDATE` change keys back to full reducer field paths before `APPLY_OPERATIONS`.  
- **CLIP_SUMMARY:** Server builds a numbered summary of **video** clips so the model can resolve “clip 2” without hallucinating IDs.

**Adding a new element field the AI must see:**  
1. Include it in compression (or accept larger payloads).  
2. Document short keys in `systemPrompt.js`.  
3. Extend `decompressOperations` / `decompressCreateElement` paths as needed.

---

## 11. Export / Remotion pipeline

1. Client posts full **`timelineState`** to `/export`.  
2. Server **`serializeToRemotion(timelineState)`** → JSX string + `totalFrames`.  
3. Writes **`src/compositions/GeneratedVideo.jsx`**.  
4. Spawns **`npx remotion render`** with `--frames=0-(N-1)`, codec (H.264 / ProRes), optional `--scale` from quality preset.  
5. Output under **`output/`**; client polls status then hits **`/download/...`**.

**Implication:** Export machine needs Node, FFmpeg ecosystem expectations, and network if media URLs are remote (see `--disable-web-security` flag used for headless fetches).

---

## 12. Authentication & multi-user

- **Browser:** `public/auth.js` + login HTML; tokens stored for API calls (`authHeadersJson()` pattern in `App.jsx`).  
- **Server:** `requireAuth` uses Supabase service client to **`getUser(jwt)`**.  
- **Storage:** SQL policy examples live in comments in `server.js` (`videos`, `audio`, `image-layer`, `thumbnails` buckets, `projects` table).

New engineers should read **`server.js`** comments near `ensureStorageBuckets` and project routes before changing ownership or paths.

---

## 13. Key engineering decisions (and why)

| Decision | Rationale |
|----------|-----------|
| **Reducer-centric state** | One mutation path; AI and UI stay consistent; time-travel undo is simpler. |
| **Claude returns operations** | Safer than executing model-produced code; easier to validate and log. |
| **Compressed tracks in prompts** | Token/cost control; requires disciplined decompress + docs. |
| **Remotion for final render** | Programmatic video from the same logical timeline; headless render. |
| **UMD React in browser** | Fast iteration without a bundler; cost is DX and tree-shaking. |
| **1080×1920 portrait as reference** | Subtitles and image layout math assume this composition space in several places—changing aspect needs a coordinated pass. |
| **Image uploads may become MP4 server-side** | Legacy pipeline compatibility; frontend still uses `imageClip` on the image track when appropriate. |

---

## 14. Testing & quality today

- **`node src/state/timelineReducer.js`** — runs embedded self-tests (see bottom of file).  
- **`npm run test:stage1`** — pipeline smoke test.  
- **Linting:** No unified ESLint config called out in `package.json`; rely on editor + `--check` for edited Node files.

**Recommendation for takeover:** add CI (GitHub Actions) running reducer tests + `node --check` on `src/**/*.js` + minimal API smoke.

---

## 15. KPIs & success metrics

The repo does **not** define formal KPIs in code. Suggested metrics for a production rollout:

| Metric | Why |
|--------|-----|
| **Time-to-first-export** | Onboarding friction. |
| **Generate success rate** | `%` of `/generate` calls returning valid JSON ops without repair. |
| **Op apply failure rate** | Ops rejected by reducer / validation. |
| **Export success rate & p95 duration** | Remotion/FFmpeg stability. |
| **Cost per edit** | Anthropic + OpenAI token usage per session (log from server). |
| **Undo-last-prompt usage** | Proxy for AI trust / correction loops. |
| **DAU / projects saved** | Adoption (Supabase-side queries). |

Instrument **`/generate`**, **`/export`**, and **`APPLY_OPERATIONS` errors** first—they surface the real user pain.

---

## 16. Known limitations & risks

- **Secrets in repo:** Ensure `.env` is never pushed (rotate keys if ever leaked).  
- **In-memory export jobs:** Server restart loses job map; not durable for horizontal scale.  
- **Dual environment for state files:** `schema.js` / `timelineReducer.js` must remain valid in **both** browser script tags and Node `require()`—do not casually add `import` syntax without a build step.  
- **Track selection for Claude:** Prompt-based subset of tracks may omit data—model must return `[]` when data missing (documented in system prompt).  
- **Roadmap vs code:** Features like full batch pipeline or vision style copy may not exist yet—always verify.

---

## 17. First-week onboarding checklist

1. Clone repo, `npm install`, copy `.env` from a teammate (no secrets in chat).  
2. Run `npm run dev`, open `/editor`, complete login if Supabase configured.  
3. Upload a short video; add subtitle + image clip; export; verify file plays.  
4. Read **`schema.js`** comments end-to-end.  
5. Step through **`APPLY_OPERATIONS`** and one **`UPDATE`** in `timelineReducer.js`.  
6. Read **`compressTracks` / `decompressOperations`** in `generate.js` + matching section of **`systemPrompt.js`**.  
7. Trace **`serializeToRemotion.js`** for one subtitle + one image clip.  
8. Read **`VibeEditor_Roadmap_2.md`** and file issues for gaps you find.

---

## 18. Ownership & handoff etiquette

- **Primary artifact:** this file + `VibeEditor_Roadmap_2.md` + inline comments in `server.js`, `schema.js`, and `systemPrompt.js`.  
- When you change **compressed track format** or **operations schema**, update **three places:** reducer acceptance, `generate.js` (de)compression, and **`systemPrompt.js`** (model contract).

---

*Document generated for engineering continuity. Update it when architecture or APIs materially change.*
