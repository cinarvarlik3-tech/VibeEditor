# Stage 1 Plan — Remotion + Claude Integration

**MODE: PLAN**

**Objective:** Prove the core loop: `hardcoded prompt + hardcoded transcript → Claude API → Remotion JSX component → rendered .mp4`

No UI. No real video. No Whisper. Pure integration proof.

---

## Architecture Overview

```
tests/test-stage1.js
  └── calls generateVideoComponent() [src/claude/generate.js]
        └── uses SYSTEM_PROMPT [src/claude/systemPrompt.js]
        └── calls Anthropic API → returns JSX string
  └── calls renderVideo() [src/video/render.js]
        └── writes JSX to src/compositions/GeneratedVideo.jsx
        └── runs: npx remotion render src/index.js GeneratedVideo output/test-stage1-{n}.mp4
```

---

## Files to Create (in order)

| # | File | Purpose |
|---|------|---------|
| 1 | `package.json` | Project manifest + start script |
| 2 | `.env.example` | API key template |
| 3 | `.env` | Real keys (you fill in) |
| 4 | `.gitignore` | Ignore node_modules, .env, uploads/, frames/, output/ |
| 5 | `remotion.config.js` | Points Remotion at `src/index.js`, sets concurrency |
| 6 | `src/index.js` | Remotion entry point — registers compositions |
| 7 | `src/compositions/BaseVideo.jsx` | Hand-written base composition (validates Remotion works) |
| 8 | `src/claude/systemPrompt.js` | Master system prompt — most critical file |
| 9 | `src/claude/generate.js` | Claude API call → returns JSX string |
| 10 | `src/video/render.js` | Writes JSX file → triggers Remotion render → returns .mp4 path |
| 11 | `tests/fixtures/sample-transcript.json` | Hardcoded test transcript (5 entries, 15 seconds) |
| 12 | `tests/test-stage1.js` | 3-test validation script |

---

## Step-by-Step Implementation Plan

### Step 1 — Project Scaffold + npm Install

- Create `package.json` — CommonJS (no `"type": "module"`), includes `start` and `dev` scripts, lists all dependencies
- Install all packages: `remotion @remotion/cli @anthropic-ai/sdk express multer dotenv cors fluent-ffmpeg axios` + dev: `nodemon`
- Create all required empty directories:
  `src/compositions/`, `src/claude/`, `src/video/`, `src/transcription/`,
  `src/presets/defaults/`, `src/assets/`, `public/`,
  `uploads/`, `frames/`, `output/`, `tests/fixtures/`
- Create `.env.example` with placeholders for `ANTHROPIC_API_KEY`, `FREESOUND_API_KEY`, `PIXABAY_API_KEY`, `PORT`
- Create `.gitignore` ignoring `node_modules`, `.env`, `uploads/`, `frames/`, `output/`

### Step 2 — Remotion Configuration

- `remotion.config.js`: minimal config pointing to `src/index.js`, sets concurrency
- `src/index.js`: registers `BaseVideo` composition (1080×1920, 30fps, 150 frames = 5 seconds default) and pre-registers `GeneratedVideo` pointing to `./compositions/GeneratedVideo.jsx`
- `src/compositions/BaseVideo.jsx`: hand-written composition accepting `subtitles`, `primaryColor`, `secondaryColor`, `fontSize`, `backgroundColor`, `fontFamily` — renders subtitles in lower third using `useCurrentFrame` + `interpolate` for opacity
- `src/compositions/GeneratedVideo.jsx`: minimal placeholder component (valid JSX, renders nothing) so Remotion doesn't error on startup
- **Validation gate:** Run `npx remotion render src/index.js BaseVideo output/test-base.mp4 --props='...'` — visually confirm yellow text on black background before proceeding

### Step 3 — System Prompt (Most Critical File)

`src/claude/systemPrompt.js` exports a named string constant `SYSTEM_PROMPT`. It must contain:

1. **Role definition** — Claude is a Remotion video component generator. Produces only raw JSX. Never explanations. Never markdown.
2. **Exact allowed Remotion imports** — `useCurrentFrame`, `useVideoConfig`, `interpolate`, `Sequence`, `AbsoluteFill`, `spring` — nothing outside this list
3. **Exact props interface** — `subtitles`, `primaryColor`, `secondaryColor`, `fontSize`, `backgroundColor`, `fontFamily` plus any additional style props
4. **Strict output format rules:**
   - Raw JSX only
   - No markdown code fences
   - No explanations or comments
   - Starts with import statements
   - Ends with `export default`
   - Must be valid JSX that can be written to a `.jsx` file and run immediately
5. **Transcript data shape** — array of `{ text: string, startTime: number, endTime: number, wordTimings: [{ word: string, start: number, end: number }] }`
6. **Style translation rules** — Claude must convert:
   - Color descriptions → specific hex values
   - Size words (big, small, huge) → specific pixel values relative to 1920×1080
   - Animation descriptions → specific Remotion `interpolate`/`spring` implementations
   - Position words (bottom, top, center, left, right) → specific pixel coordinates
7. **One complete worked example** — full input prompt + full transcript input → complete valid JSX output written out in full (not pseudocode)
8. **Error prevention rules:**
   - Never use hooks conditionally
   - Always handle missing props with defaults
   - Never reference undefined variables
   - Always provide a fallback for empty subtitles array

> The worked example must be long and specific. This is the single highest-leverage element for output quality and reliability.

### Step 4 — Claude API Integration

`src/claude/generate.js` exports `generateVideoComponent(userPrompt, transcript, preset = null)`:

- Uses `@anthropic-ai/sdk`, model `claude-sonnet-4-20250514`, `max_tokens: 4000`
- Loads `ANTHROPIC_API_KEY` from `.env` via `dotenv`
- Constructs user message in this exact format:
  ```
  PROMPT: {userPrompt}

  TRANSCRIPT: {JSON.stringify(transcript)}

  PRESET: {preset ? JSON.stringify(preset) : 'none'}
  ```
- Returns the raw JSX string from Claude's response
- Validates response: throws descriptive error if empty or does not start with `import`
- All errors caught and re-thrown with descriptive messages

### Step 5 — Remotion Render Pipeline

`src/video/render.js` exports `renderVideo(jsxString, outputFilename)`:

- Writes `jsxString` to `src/compositions/GeneratedVideo.jsx` (overwrites every time)
- Executes via Node `child_process.exec`:
  ```
  npx remotion render src/index.js GeneratedVideo output/{outputFilename}
  ```
- Returns full output file path on success
- On failure: throws descriptive error including full Remotion stderr output
- **Registration strategy:** `GeneratedVideo` is pre-registered in `src/index.js` at setup time with a static import. Remotion re-bundles on every render call, so it always picks up the latest written file — no runtime modification of `src/index.js` needed.

### Step 6 — Test Fixture + Test Script

`tests/fixtures/sample-transcript.json`:
- 5 subtitle entries
- Realistic text content
- Timestamps spanning 0–15 seconds
- Word-level timings for each entry

`tests/test-stage1.js`:
- Runs 3 test cases in sequence, logging PASS or FAIL for each
- Exits with code `0` if all pass, code `1` if any fail
- Run with: `node tests/test-stage1.js`

| Test | Prompt | Output File | Validates |
|------|--------|-------------|-----------|
| 1 | `"White subtitles, black background, clean and simple"` | `output/test-stage1-1.mp4` | Capability tests 1 + 2 (basic subtitles, text matches) |
| 2 | `"Bold yellow subtitles, dark gradient background, energetic feel, large font"` | `output/test-stage1-2.mp4` | Capability test 5 (complex styling) |
| 3 | `"Subtitles fade in from bottom, white text with black outline, professional look"` | `output/test-stage1-3.mp4` | Capability test 6 (animations) |

---

## Critical Technical Decisions

1. **Module system:** Node utility files use CommonJS (`require`/`module.exports`). Remotion composition files use ESM/JSX — Remotion's own bundler (esbuild) handles those separately. `package.json` does NOT set `"type": "module"` to keep Node script execution simple.

2. **GeneratedVideo registration strategy:** Pre-register `GeneratedVideo` in `src/index.js` at setup time. Write a minimal placeholder `GeneratedVideo.jsx` on first create. The render pipeline overwrites it before every Remotion call. No runtime `src/index.js` modification needed.

3. **System prompt worked example:** Must be a complete, realistic JSX output — not pseudocode or abbreviated. This is the single highest-leverage element for making Claude produce valid, runnable JSX consistently.

4. **ffmpeg path:** Stage 1 does not use ffmpeg directly, but `fluent-ffmpeg` is installed now. The binary path (`/opt/homebrew/bin/ffmpeg`) will be configured in `src/video/extract.js` in Stage 2.

---

## Stage 1 Validation Checklist

- [ ] Project folder structure matches specification exactly
- [ ] All npm packages installed without errors
- [ ] `.env` file created with real `ANTHROPIC_API_KEY`
- [ ] `BaseVideo` renders `output/test-base.mp4` — visually confirmed in video player (yellow subtitles on black background)
- [ ] System prompt reviewed manually and approved
- [ ] Claude API call returns valid JSX string (no markdown, no explanation text)
- [ ] Render pipeline writes `GeneratedVideo.jsx` and triggers Remotion render successfully
- [ ] `node tests/test-stage1.js` — all 3 tests log PASS
- [ ] Capability tests 1, 2, 3 confirmed by watching the output videos

---

## Implementation Checklist

```
IMPLEMENTATION CHECKLIST

1.  Create package.json (CommonJS, scripts: start/dev, list all dependencies)
2.  Create .env.example with ANTHROPIC_API_KEY, FREESOUND_API_KEY, PIXABAY_API_KEY, PORT
3.  Create .gitignore (node_modules, .env, uploads/, frames/, output/)
4.  Run: npm install remotion @remotion/cli @anthropic-ai/sdk express multer dotenv cors fluent-ffmpeg axios
5.  Run: npm install --save-dev nodemon
6.  Create all required directories: src/compositions, src/claude, src/video, src/transcription,
    src/presets/defaults, src/assets, public, uploads, frames, output, tests/fixtures
7.  Create remotion.config.js pointing to src/index.js
8.  Create src/compositions/BaseVideo.jsx (hand-written, accepts all 6 props, lower-third subtitles,
    opacity interpolation, 1080x1920, 30fps)
9.  Create src/compositions/GeneratedVideo.jsx (minimal placeholder — valid JSX, renders nothing)
10. Create src/index.js registering both BaseVideo and GeneratedVideo
11. Run BaseVideo validation render — confirm output/test-base.mp4 shows yellow subtitles on black background
12. Create src/claude/systemPrompt.js (full system prompt: role, imports, props, format rules,
    translation rules, complete worked example, error prevention rules)
13. Create src/claude/generate.js (generateVideoComponent function, API call, response validation, error handling)
14. Create src/video/render.js (renderVideo function, writes GeneratedVideo.jsx, exec Remotion, returns output path)
15. Create tests/fixtures/sample-transcript.json (5 entries, 0-15s, word-level timings)
16. Create tests/test-stage1.js (3 tests, PASS/FAIL logging, exit codes)
17. Run: node tests/test-stage1.js — confirm all 3 log PASS
18. Visually inspect output/test-stage1-1.mp4, test-stage1-2.mp4, test-stage1-3.mp4
    to confirm capability tests 1, 2, 3 pass
```
