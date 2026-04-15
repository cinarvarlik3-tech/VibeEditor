# Vibe Editor — Master Build Guide
### Complete implementation reference for Claude Code

---

## (HUMAN) How to Use This Document

This document is your single source of truth for building the Vibe Editor. It is written to be given directly to Claude Code at the start of every session.

**Every time you open Claude Code, start with:**
> "Read this entire document before doing anything. Confirm you understand it. Then wait for my instruction."

Work through stages in strict order. Never skip ahead. Each stage has a validation checklist — nothing moves forward until every box is checked.

---

## (CLAUDE) Claude Code Operating Protocol

Claude Code must follow this protocol for the entire duration of the project. Paste this at the start of every Claude Code session.

---

### (CLAUDE) Development Chain of Thought Protocol

When updating the codebase, you must adhere to the following strict protocol to avoid unauthorized changes that could introduce bugs or break functionality. Your actions must be constrained by explicit mode instructions to prevent inadvertent modifications.

**Mode Transitions:** You will start in RESEARCH mode, and only transition modes when explicitly told using the exact key phrase `MODE: (mode name)`. You must declare your current mode at the beginning of every response.

**MODE 1: RESEARCH**
- Purpose: Gather information about the codebase without suggesting or planning any changes.
- Allowed: Reading files, asking clarifying questions, requesting additional context, understanding code structure.
- Forbidden: Suggestions, planning, or implementation.
- Output: Exclusively observations and clarifying questions.

**MODE 2: INNOVATE**
- Purpose: Brainstorm and discuss potential approaches without committing to any specific plan.
- Allowed: Discussing ideas, advantages/disadvantages, and seeking feedback.
- Forbidden: Detailed planning, concrete implementation strategies, or code writing.
- Output: Only possibilities and considerations.

**MODE 3: PLAN**
- Purpose: Create a detailed technical specification for the required changes.
- Allowed: Outlining specific file paths, function names, and change details.
- Forbidden: Any code implementation or example code.
- Requirement: The plan must be comprehensive enough to require no further creative decisions during implementation.
- Conclude with a numbered sequential implementation checklist:
```
IMPLEMENTATION CHECKLIST
1. [Specific action 1]
2. [Specific action 2]
n. [Final action]
```
- Output: Exclusively the specifications and checklist.

**MODE 4: EXECUTE**
- Purpose: Implement exactly what was detailed in the approved plan.
- Allowed: Only actions explicitly listed in the plan.
- Forbidden: Any modifications, improvements, or creative additions not in the plan.
- Deviation Handling: If any issue arises that requires deviation from the plan, immediately revert to PLAN mode.

**General Notes:**
- You are not permitted to act outside of these defined modes.
- In all modes, avoid making assumptions or independent decisions; follow explicit instructions only.
- If there is any uncertainty or if further clarification is needed, ask clarifying questions before proceeding.

---

### (CLAUDE) Engineering Standards

All code produced must adhere to these standards without exception:

**Best Practices:** Optimize for performance, maintainability, readability, and modularity.

**Functional Modularity:** Design well-defined, reusable functions to handle discrete tasks. Each function must have a single, clear purpose.

**File Modularity:** Organize the codebase across multiple files to reduce complexity and enforce a black-box design. Isolate core modules into separate files that are imported into the main executable.

**Comments and Documentation:**
- Begin every file with a comment block that explains its purpose and role within the project.
- Document every function with a comment block describing its functionality, inputs, and outputs.
- Use inline comments to clarify the purpose of non-obvious code segments.
- For any external function calls, include a comment explaining their inputs, outputs, and purpose.

**Readability:** Use intuitive naming conventions and maintain a logical, organized structure throughout.

---

## (HUMAN) Environment Context

Your confirmed environment. Paste the block below to Claude Code at the start of every session.

```
OS: macOS (Apple Silicon — M-series)
Node.js: v24.11.1
Python: 3.14.2
ffmpeg: 8.1 — installed via Homebrew at /opt/homebrew/bin/ffmpeg
Package manager: npm
Shell: zsh (macOS default)
Working directory: ~/vibe-editor
API keys: stored in .env file, never hardcoded
```

**Paste this exact block to Claude Code at the start of every session:**
```
Environment confirmed:
- OS: macOS Apple Silicon
- Node.js: v24.11.1
- Python: 3.14.2
- ffmpeg: version 8.1 at /opt/homebrew/bin/ffmpeg
- Package manager: npm
- Shell: zsh
```

---

## (HUMAN) Complete Folder Structure

This is the target structure for the finished project. Claude Code should build toward this incrementally — do not create everything at once.

```
vibe-editor/
│
├── src/
│   ├── compositions/
│   │   ├── BaseVideo.jsx          # Base Remotion composition template
│   │   └── GeneratedVideo.jsx     # Claude-generated composition (auto-written)
│   │
│   ├── claude/
│   │   ├── systemPrompt.js        # The master system prompt for video generation
│   │   ├── generate.js            # Claude API call — takes prompt, returns JSX
│   │   ├── analyzeFrames.js       # Claude Vision — analyzes extracted video frames
│   │   └── presetPrompt.js        # Prompt logic when a style preset is active
│   │
│   ├── video/
│   │   ├── extract.js             # ffmpeg — extracts audio and frames from video
│   │   ├── render.js              # Remotion — triggers render, saves output
│   │   └── download.js            # yt-dlp — downloads video from URL
│   │
│   ├── transcription/
│   │   └── transcribe.js          # Whisper — audio to timestamped transcript
│   │
│   ├── presets/
│   │   ├── presetManager.js       # Save, load, list, delete presets
│   │   └── defaults/
│   │       ├── corporate-clean.json
│   │       ├── street-energy.json
│   │       └── minimal-luxury.json
│   │
│   ├── assets/
│   │   ├── freesound.js           # Freesound API — sound effect search
│   │   └── pixabay.js             # Pixabay API — background music search
│   │
│   ├── server.js                  # Express backend — API endpoints
│   └── index.js                   # Remotion entry point — registers compositions
│
├── public/
│   ├── index.html                 # Frontend UI
│   ├── style.css                  # UI styles
│   └── app.js                     # Frontend JavaScript
│
├── uploads/                       # Temporary uploaded video files (git ignored)
├── frames/                        # Temporary extracted frames (git ignored)
├── output/                        # Rendered output videos (git ignored)
│
├── tests/
│   ├── test-stage1.js             # Stage 1 validation test
│   ├── test-stage2.js             # Stage 2 validation test
│   └── fixtures/
│       └── sample-transcript.json # Hardcoded test transcript
│
├── remotion.config.js             # Remotion configuration
├── package.json
├── .env                           # API keys (git ignored)
├── .env.example                   # Template for required env vars
├── .gitignore
└── README.md
```

---

## (HUMAN) Dependencies

### (HUMAN) System Dependencies — Already Installed

| Tool | Your Version | Purpose |
|------|-------------|---------|
| ffmpeg | 8.1 (Homebrew) | Audio extraction, frame extraction, video manipulation |
| Python | 3.14.2 | Whisper runtime |
| Node.js | v24.11.1 | All JavaScript/Remotion code |
| npm | bundled with Node | Package management |

### (HUMAN) Node.js Packages — Install Before Starting

Run this once in the project folder:
```bash
npm install remotion @remotion/cli @anthropic-ai/sdk express multer dotenv cors fluent-ffmpeg axios
npm install --save-dev nodemon
```

| Package | Purpose |
|---------|---------|
| `remotion` | Video composition and rendering engine |
| `@remotion/cli` | Remotion command line tools |
| `@anthropic-ai/sdk` | Official Anthropic API client |
| `express` | Backend web server |
| `multer` | File upload handling |
| `dotenv` | Load API keys from .env file |
| `cors` | Allow frontend to talk to backend |
| `fluent-ffmpeg` | Node.js interface for ffmpeg commands |
| `axios` | HTTP requests for asset APIs |
| `nodemon` | Auto-restart server during development |

### (HUMAN) Python Packages — Install Before Starting

```bash
pip3 install openai-whisper
```

| Package | Purpose |
|---------|---------|
| `openai-whisper` | Speech to text with word-level timestamps |

### (HUMAN) External APIs — Register Before Starting

| API | Purpose | Register at |
|-----|---------|-------------|
| Anthropic API | Claude for code generation and frame analysis | console.anthropic.com |
| Freesound API | Sound effects search | freesound.org/apiv2 |
| Pixabay API | Background music and video search | pixabay.com/api/docs |

### (HUMAN) .env Setup

Create a file called `.env` in the project root with your real keys:
```
ANTHROPIC_API_KEY=your_key_here
FREESOUND_API_KEY=your_key_here
PIXABAY_API_KEY=your_key_here
PORT=3000
```

---

## (HUMAN) Validation Test Sequence

Every build stage must pass its validation tests before proceeding. These tests are also your product capability benchmarks — run the full sequence when you think the product is ready.

### (HUMAN) The 10 Capability Tests

Run these in order. Each test must pass before the next is attempted. Document pass/fail and notes for each.

| # | Test | What You're Checking | Pass Condition |
|---|------|---------------------|----------------|
| 1 | Generate subtitles from hardcoded transcript | Core Remotion pipeline works | Subtitles appear on screen |
| 2 | Subtitles match given script exactly | Transcript data flows correctly | Every line matches source text |
| 3 | Subtitles appear at correct timestamps | Timing logic is accurate | Each line appears within 0.2s of its start time |
| 4 | Basic operations: cut, zoom, speed change | ffmpeg + Remotion cooperate | Operations execute without errors |
| 5 | Complex styling: mixed fonts, sizes, colors | Claude generates valid styled JSX | Visual output matches prompt description |
| 6 | Animations: subtitle and screen in/out effects | Remotion animation APIs work | Smooth animations render correctly |
| 7 | Spatial placement from natural language | Claude translates position words to coordinates | Elements appear where prompt described |
| 8 | Video content understanding from frames | Claude Vision analysis pipeline works | Analysis output is accurate and useful |
| 9 | Style replication from reference content | Preset system applies styles to new content | New video visually matches reference style |
| 10 | Reliable end-to-end on 5 different videos | Full pipeline stability | All 5 produce acceptable output without crashes |

**Test 10 is the commercial viability gate.** If the system passes tests 1-9 but fails Test 10, the system prompt needs more work before the product is viable.

---

## (HUMAN) Stage 1 — Remotion + Claude Integration

**Goal:** Prove the core loop works. No UI. No real video. Just prompt → Remotion component → rendered .mp4.

**What you're building:**
```
hardcoded prompt + hardcoded transcript → Claude → JSX component → Remotion render → .mp4
```

**Do not use real video. Do not build any UI. Do not integrate Whisper. All of that is Stage 2.**

---

### (HUMAN) Step 1.1 — Project Setup

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

We are starting a new project called vibe-editor.

Environment:
- macOS Apple Silicon
- Node.js v24.11.1
- Python 3.14.2
- ffmpeg 8.1 installed via Homebrew at /opt/homebrew/bin/ffmpeg
- npm for package management

Create a plan to:
1. Initialize a new Node.js project in a folder called vibe-editor
2. Install these exact packages:
   remotion @remotion/cli @anthropic-ai/sdk express multer dotenv cors fluent-ffmpeg axios
3. Install dev dependency: nodemon
4. Create the following folder structure exactly:
   src/compositions/, src/claude/, src/video/, src/transcription/,
   src/presets/defaults/, src/assets/, public/,
   uploads/, frames/, output/, tests/fixtures/
5. Create .env.example with placeholders for:
   ANTHROPIC_API_KEY, FREESOUND_API_KEY, PIXABAY_API_KEY, PORT
6. Create .gitignore ignoring: node_modules, .env, uploads/, frames/, output/
7. Create package.json with start script: nodemon src/server.js

Do not implement anything yet. Give me the plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (HUMAN) Step 1.2 — Base Remotion Composition

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for a Remotion composition called BaseVideo
at src/compositions/BaseVideo.jsx.

Requirements:
- File must begin with a comment block explaining its purpose
- Every function must have a comment block documenting inputs and outputs
- The composition accepts these props:
  subtitles (array of {text, startTime, endTime}),
  primaryColor (hex string), secondaryColor (hex string),
  fontSize (number), backgroundColor (hex string), fontFamily (string)
- Each subtitle appears at its startTime and disappears at its endTime
  using Remotion's useCurrentFrame and interpolate
- Subtitles centered horizontally, positioned in lower third of frame
- Composition dimensions: 1080x1920 (vertical) at 30fps
- Register the composition in src/index.js
- Include a remotion.config.js pointing to src/index.js
- After creating files, run this render command to validate:
  npx remotion render src/index.js BaseVideo output/test-base.mp4
  --props='{"subtitles":[{"text":"Hello World","startTime":0,"endTime":2},
  {"text":"This is a test","startTime":2,"endTime":4}],
  "primaryColor":"#FFFF00","secondaryColor":"#FFFFFF",
  "fontSize":48,"backgroundColor":"#000000","fontFamily":"Arial"}'

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

### (HUMAN) Validation gate:
Open `/output/test-base.mp4`. You must see yellow subtitles on a black background before proceeding. If the file does not exist or the video is blank, stay in PLAN mode and debug.

---

### (CLAUDE) Step 1.3 — The System Prompt

**This is the most critical file in the entire project.** Its quality determines whether the product works reliably. Review it carefully after Claude Code writes it — do not just execute and move on.

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the Claude system prompt file at src/claude/systemPrompt.js.

This system prompt is sent to Claude API on every video generation request.
It must instruct Claude to produce valid Remotion JSX code and nothing else.

The system prompt must include:

1. Role definition: Claude is a Remotion video component generator.
   It produces only raw JSX. Never explanations. Never markdown.

2. Exact allowed Remotion imports:
   useCurrentFrame, useVideoConfig, interpolate, Sequence,
   AbsoluteFill, spring — and nothing outside this list

3. Exact props interface the generated component must accept:
   subtitles, primaryColor, secondaryColor, fontSize,
   backgroundColor, fontFamily — plus any additional style props

4. Strict output format rules:
   - Raw JSX only
   - No markdown code fences
   - No explanations or comments
   - Starts with import statements
   - Ends with export default
   - Must be valid JSX that can be written to a .jsx file and run immediately

5. Exact shape of transcript data Claude will receive:
   Array of { text: string, startTime: number, endTime: number,
   wordTimings: array of { word: string, start: number, end: number } }

6. Style translation rules — Claude must convert:
   - Color descriptions → specific hex values
   - Size words (big, small, huge) → specific pixel values relative to 1920x1080
   - Animation descriptions → specific Remotion interpolate/spring implementations
   - Position words (bottom, top, center, left, right) → specific pixel coordinates

7. One complete worked example:
   Input prompt + input transcript → exact valid JSX output (fully written out)

8. Error prevention rules:
   - Never use hooks conditionally
   - Always handle missing props with defaults
   - Never reference undefined variables
   - Always provide a fallback for empty subtitles array

Export the system prompt as a named string constant: SYSTEM_PROMPT

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

### (HUMAN) After execution — manually review the system prompt file and ask yourself:
- Is the output format completely unambiguous?
- Is the worked example realistic and fully written out?
- Are the style translation rules specific enough to produce consistent results?
- Would a developer reading this know exactly what output to produce?

If anything is vague, go back to PLAN mode and refine before moving on.

---

### (CLAUDE) Step 1.4 — Claude API Integration

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the Claude API integration at src/claude/generate.js.

Requirements:
- File begins with comment block explaining purpose and role in project
- Every function has a comment block with inputs and outputs documented
- Export one main async function:
  generateVideoComponent(userPrompt, transcript, preset = null)
- Calls Anthropic API using model: claude-sonnet-4-20250514
- Uses SYSTEM_PROMPT exported from src/claude/systemPrompt.js
- Constructs user message in this exact format:
  "PROMPT: {userPrompt}

  TRANSCRIPT: {JSON.stringify(transcript)}

  PRESET: {preset ? JSON.stringify(preset) : 'none'}"
- Returns the raw JSX string from Claude's response
- Validates response: if empty or does not start with 'import', throws descriptive error
- max_tokens: 4000
- API key from process.env.ANTHROPIC_API_KEY via dotenv
- All errors caught and re-thrown with descriptive messages

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 1.5 — Remotion Render Pipeline

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the render pipeline at src/video/render.js.

Requirements:
- File begins with comment block
- Every function documented with inputs and outputs
- Export one main async function: renderVideo(jsxString, outputFilename)
- Writes jsxString to src/compositions/GeneratedVideo.jsx,
  overwriting any existing file
- Executes Remotion render via Node child_process exec:
  npx remotion render src/index.js GeneratedVideo output/{outputFilename}
- Returns the full output file path on success
- On failure: throws descriptive error including full Remotion error output
- Register GeneratedVideo in src/index.js alongside BaseVideo
  using dynamic import so it picks up the latest written file

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 1.6 — Stage 1 Test Script

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the Stage 1 end-to-end test at tests/test-stage1.js.

Requirements:
- File begins with comment block explaining it is the Stage 1 validation test
- Create fixture at tests/fixtures/sample-transcript.json with:
  5 subtitle entries, realistic text, timestamps spanning 15 seconds,
  word-level timings for each entry
- Run 3 test cases in sequence, logging PASS or FAIL for each:

  TEST 1 — Capability tests 1 and 2: Basic subtitles
  Prompt: "White subtitles, black background, clean and simple"
  Validates: file renders without error, output file exists

  TEST 2 — Capability test 5: Styled subtitles
  Prompt: "Bold yellow subtitles, dark gradient background,
           energetic feel, large font"
  Validates: renders without error, output file exists

  TEST 3 — Capability test 6: Animated subtitles
  Prompt: "Subtitles fade in from bottom, white text with black outline,
           professional look"
  Validates: renders without error, output file exists

- Each test saves to output/test-stage1-{n}.mp4
- Script exits with code 0 if all pass, code 1 if any fail
- Run with: node tests/test-stage1.js

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

### (HUMAN) Run the test:
```bash
node tests/test-stage1.js
```

All 3 must log PASS. If any fail, share the full error output with Claude Code and ask it to diagnose before fixing.

---

### (HUMAN) Stage 1 Validation Checklist

- [ ] Project folder structure matches specification exactly
- [ ] All npm packages installed without errors
- [ ] .env file created with real ANTHROPIC_API_KEY
- [ ] BaseVideo renders test-base.mp4 — visually confirmed in video player
- [ ] System prompt reviewed manually and approved
- [ ] Claude API call returns valid JSX string (no markdown, no explanation text)
- [ ] Render pipeline writes GeneratedVideo.jsx and triggers Remotion render
- [ ] node tests/test-stage1.js — all 3 tests PASS
- [ ] Capability tests 1, 2, 3 confirmed by watching the output videos

---

## (HUMAN) Stage 2 — Minimal UI

**Goal:** Wrap the Stage 1 pipeline in the simplest possible browser interface. Upload a video, type a prompt, get a download link.

**What you're building:**
```
Browser → Express server → ffmpeg (audio) → Whisper (transcript) → Stage 1 pipeline → download
```

---

### (CLAUDE) Step 2.1 — Express Backend

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the Express backend at src/server.js.

Requirements:
- File begins with comment block
- All functions documented
- Loads .env using dotenv at top of file
- Serves static files from /public
- Uses multer for uploads, storing to /uploads with timestamp prefix
- Endpoints:

  POST /upload
  Accepts video file (mp4, mov, avi, webm)
  Saves to uploads/ folder
  Returns: { filename, path, duration }
  Gets duration using fluent-ffmpeg

  POST /generate
  Body: { videoPath, prompt, presetName (optional) }
  Runs: audio extraction → Whisper → Claude → Remotion render
  Logs each step to console with timestamps
  Returns: { outputPath, filename, transcriptUsed }
  Returns descriptive JSON error on any failure

  GET /download/:filename
  Serves file from output/ folder
  Sets Content-Disposition header for download

  GET /presets
  Returns list of available presets (stub — returns empty array for now)

  GET /status
  Returns: { status: 'ok', version: '0.1.0' }

- Listens on process.env.PORT or 3000
- All unhandled errors return JSON: { error: descriptive message }

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 2.2 — Audio Extraction Module

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the audio extraction module at src/video/extract.js.

Requirements:
- File begins with comment block
- All functions documented with inputs and outputs

Export async function: extractAudio(videoPath)
- Returns path to extracted .wav file
- Uses fluent-ffmpeg
- Output: uploads/{originalName}-audio.wav
- Sample rate: 16000 Hz (required by Whisper)
- Channels: 1 mono (required by Whisper)
- Throws descriptive error if video has no audio track

Export async function: extractFrames(videoPath, count = 5)
- Returns array of frame image file paths
- Extracts {count} evenly spaced frames as JPG files
- Saves to frames/{originalName}-frame-{n}.jpg
- Uses ffmpeg select filter for even spacing
- Returns array of absolute file paths

Note: ffmpeg is at /opt/homebrew/bin/ffmpeg on this machine.

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 2.3 — Whisper Transcription Module

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the Whisper transcription module at src/transcription/transcribe.js.

Requirements:
- File begins with comment block
- All functions documented

Export async function: transcribeAudio(audioPath, language = null)
- Returns transcript array
- Calls Python Whisper via Node child_process exec
- Command: python3 -m whisper {audioPath} --model base
  --word_timestamps True --output_format json --output_dir {tempDir}
- If language provided, appends: --language {language}
- Parses the JSON output file Whisper creates
- Returns array of:
  { text, startTime, endTime,
    wordTimings: [{ word, start, end }] }
- Deletes Whisper JSON output file after parsing
- Throws descriptive error on failure, includes Python stderr output

Note: ffmpeg is at /opt/homebrew/bin/ffmpeg — ensure PATH includes
/opt/homebrew/bin so Whisper can find it.

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 2.4 — Frontend UI

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the frontend UI:
public/index.html, public/style.css, public/app.js

Design requirements:
- Single page, no frameworks
- Dark theme: #0a0a0a background, #ffffff primary text
- Clean, minimal, functional
- Components:
  1. Header: "Vibe Editor" + "v0.1.0"
  2. Video upload zone: drag-and-drop + click to browse,
     shows selected filename when chosen
  3. Prompt textarea: full width, 4 rows,
     placeholder "Describe how you want your video to look..."
  4. Preset dropdown: "Style Preset (optional)",
     populated via GET /presets on page load, first option "None"
  5. Generate button: full width, disabled while processing
  6. Progress indicator: shows current step —
     Uploading → Extracting audio → Transcribing → Generating → Rendering
     Hidden until generation starts
  7. Result section: hidden until complete,
     video preview element + Download button
  8. Error section: hidden until error,
     red background, shows error message text

app.js requirements:
- All functions documented
- On load: fetch GET /presets, populate dropdown
- On file select or drop: store file in memory
- On Generate click:
  POST /upload → store videoPath
  POST /generate with { videoPath, prompt, presetName }
  Update progress text at each step
  On success: show preview + download button
  On error: show error section with message
- Re-enable Generate button after completion or error

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (HUMAN) Stage 2 Validation Checklist

- [ ] node src/server.js starts without errors
- [ ] http://localhost:3000 loads in browser
- [ ] Video file drag-and-drop works
- [ ] POST /upload returns metadata
- [ ] Audio extraction creates a .wav file in /uploads
- [ ] Whisper transcribes the audio and returns timestamped segments
- [ ] Full pipeline runs end-to-end via the Generate button
- [ ] Progress steps update visibly during generation
- [ ] Download link appears and downloads a real .mp4
- [ ] Error message displays when something fails
- [ ] Capability tests 1-5 pass using the browser interface

**Stage 2 complete = you have a working MVP.**

---

## (HUMAN) Stage 3 — Video Understanding + Presets

**Goal:** Build the preset system and visual intelligence that makes this a real product.

---

### (CLAUDE) Step 3.1 — Preset Schema and Default Presets

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for the preset schema and 3 default preset files.

Each preset JSON file must have exactly these fields:
{
  "name": string,
  "description": string,
  "fontFamily": string,
  "fontSizeBase": number,
  "fontSizeEmphasis": number,
  "primaryColor": hex string,
  "secondaryColor": hex string,
  "accentColor": hex string,
  "backgroundColor": hex string or "transparent",
  "subtitlePosition": "top" | "center" | "bottom",
  "subtitleAnimation": "fade" | "slide-up" | "pop" | "typewriter" | "none",
  "animationDuration": number (frames),
  "backgroundTreatment": "solid" | "gradient" | "blur" | "none",
  "emphasisStyle": "bold" | "color" | "size" | "all",
  "musicMoodKeywords": array of strings,
  "sfxOnSubtitle": boolean,
  "sfxType": string or null,
  "energyLevel": "low" | "medium" | "high"
}

Create 3 files in src/presets/defaults/:

corporate-clean.json
Professional, minimal. Blue/white palette. Fade animations.
Medium energy. No sound effects. Clean sans-serif font.

street-energy.json
Bold, high contrast. Yellow/black palette. Pop animations.
High energy. Sound effects on subtitles. Heavy sans-serif font.

minimal-luxury.json
Elegant, refined. Cream/gold palette. Slow fade animations.
Low energy. No sound effects. Serif font.

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 3.2 — Preset Manager

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for src/presets/presetManager.js and server endpoint updates.

Module requirements:
- File begins with comment block, all functions documented

Export these functions:
- listPresets() → array of { name, description } for all presets
- loadPreset(name) → full preset JSON object, throws if not found
- savePreset(name, presetObject) → saves to src/presets/{name}.json
- deletePreset(name) → deletes file, throws if it's a default preset
- presetExists(name) → boolean

Update src/server.js to replace the GET /presets stub with:
- GET /presets → listPresets()
- GET /presets/:name → loadPreset(name)
- POST /presets → savePreset from request body
- DELETE /presets/:name → deletePreset(name)

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 3.3 — Frame Analysis Module

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for src/claude/analyzeFrames.js.

Requirements:
- File begins with comment block, all functions documented

Export async function: analyzeVideoFrames(framePaths)
- Reads each frame file as base64
- Sends all frames to Claude API in a single message using vision
- Model: claude-sonnet-4-20250514
- System prompt: return ONLY valid JSON, no markdown, no explanation
- User message requests JSON with these exact fields:
  visualStyle, colorPalette (3-5 hex colors),
  energyLevel (low/medium/high),
  contentType (talking-head/tutorial/vlog/product/other),
  lightingStyle (bright/dark/moody/neutral),
  hasText (boolean),
  suggestedMusicMood (2-3 keywords),
  estimatedAudience
- Parses and returns the JSON
- On JSON parse failure: returns safe default object with neutral values
- Deletes frame files after analysis completes

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 3.4 — Upgrade Generate for Presets and Vision

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan to upgrade src/claude/generate.js to use preset
and frame analysis data.

Changes:
- generateVideoComponent gains a fourth parameter:
  frameAnalysis (object or null)
- When preset provided: Claude uses preset as base style,
  only overrides what the user's prompt explicitly changes
- When frameAnalysis provided: include in user message as VIDEO_ANALYSIS
- Updated user message format with all four sections labeled:
  PROMPT, TRANSCRIPT, PRESET, VIDEO_ANALYSIS
- New export: generatePresetFromVideo(frameAnalysis, transcript)
  Asks Claude to return a preset JSON based on video analysis
  Returns parsed JSON preset object

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (CLAUDE) Step 3.5 — Asset Search

Copy this prompt and paste it into Claude Code:

```
MODE: PLAN

Create a plan for two asset search modules and two new server endpoints.

src/assets/freesound.js:
- File begins with comment block, all functions documented
- Export async function: searchSoundEffect(keywords, duration = null)
  Returns array of { name, url, duration, license }
  Uses Freesound API v2 search endpoint
  Filters for CC0 license only, returns top 3 results
  API key from process.env.FREESOUND_API_KEY

src/assets/pixabay.js:
- File begins with comment block, all functions documented
- Export async function: searchMusic(moodKeywords)
  Returns array of { name, url, duration }
  Uses Pixabay music API, joins moodKeywords into search query
  Returns top 3 results
  API key from process.env.PIXABAY_API_KEY

Add to src/server.js:
- GET /assets/sfx?keywords={keywords} → searchSoundEffect
- GET /assets/music?mood={mood} → searchMusic

Plan and checklist only.
```

### (HUMAN) After reviewing the plan, say:
```
MODE: EXECUTE
```

---

### (HUMAN) Stage 3 Validation Checklist

- [ ] 3 default presets load correctly via GET /presets
- [ ] Preset dropdown in UI shows all 3 presets
- [ ] Selecting a preset visibly changes the output style
- [ ] Frame extraction creates JPG files in /frames
- [ ] Frame analysis returns valid JSON with all required fields
- [ ] Video generation uses frame analysis when no preset is selected
- [ ] Asset search returns results for test query "energetic upbeat"
- [ ] Capability tests 6, 7, 8, 9 pass

---

## (HUMAN) Stage 4 — Test With Real Content

**Goal:** Break the product before real users do.

---

### (HUMAN) Step 4.1 — Run the Full Validation Sequence

Run all 10 capability tests using 3 different real videos. For each test record: PASS / FAIL / notes.

---

### (HUMAN) Step 4.2 — Triage Failures

Categorize every failure and fix in priority order:

**Category B — Pipeline failures** (crashes, file errors, timeouts) — Fix all of these.

**Category A — System prompt failures** (wrong style, ignores instructions) — Fix top 2.

**Category C — Quality failures** (works but looks bad) — Document and ship with known limitations.

---

### (HUMAN) Step 4.3 — External User Test

Find one person who makes video content. Give them access with no instructions. Watch without helping. Where they get confused is your next feature sprint.

---

### (HUMAN) Stage 4 Validation Checklist

- [ ] All 10 capability tests pass on at least 3 different videos
- [ ] No pipeline crashes on any test
- [ ] At least 3 presets produce visually distinct output reliably
- [ ] All error messages are human-readable — no raw stack traces shown to user
- [ ] Full pipeline completes in under 3 minutes for a 60-second video
- [ ] One external person uses it without help and produces acceptable output

---

## (HUMAN) Quick Reference — Claude Code Session Starter

Copy and paste this entire block at the start of every new Claude Code session:

```
You are helping me build Vibe Editor, an AI-powered video styling tool.

ENVIRONMENT:
- macOS Apple Silicon
- Node.js v24.11.1, npm
- ffmpeg 8.1 installed via Homebrew at /opt/homebrew/bin/ffmpeg
- Python 3.14.2 with openai-whisper installed
- Project is at ~/vibe-editor

OPERATING PROTOCOL:
Follow the Development Chain of Thought Protocol at all times.
Start in RESEARCH mode.
Declare your current mode at the start of every response.
Do not write any code until I explicitly say MODE: EXECUTE.

ENGINEERING STANDARDS:
Every file must begin with a comment block explaining its purpose.
Every function must be documented with inputs and outputs.
Optimize for readability and modularity.
No hardcoded values — use .env for all configuration.

CURRENT SESSION GOAL:
[describe what you want to accomplish today]

Read this context, confirm you understand it, then enter RESEARCH mode
and wait for my first instruction.
```

---

## (HUMAN) Full Stack Summary

| Layer | Technology | File | Purpose |
|-------|-----------|------|---------|
| Video download | yt-dlp | src/video/download.js | Fetch from YouTube/Instagram |
| Audio extraction | ffmpeg 8.1 (Homebrew) | src/video/extract.js | Strip audio, extract frames |
| Transcription | Whisper + Python 3.14.2 | src/transcription/transcribe.js | Speech to timestamped text |
| Frame analysis | Claude Vision API | src/claude/analyzeFrames.js | Understand video content |
| Style generation | Claude API | src/claude/generate.js | Prompt → Remotion JSX |
| System prompt | — | src/claude/systemPrompt.js | Constrains Claude output |
| Video rendering | Remotion | src/video/render.js | JSX → .mp4 |
| Preset management | JSON files | src/presets/presetManager.js | Save and reuse styles |
| Asset sourcing | Freesound + Pixabay | src/assets/ | Music and sound effects |
| Backend | Express.js | src/server.js | Orchestrates everything |
| Frontend | HTML/CSS/JS | public/ | Browser interface |

---

*Built with: Remotion · Claude API · Whisper · ffmpeg 8.1 · Express.js · yt-dlp · Freesound · Pixabay*
*Environment: macOS Apple Silicon · Node.js v24.11.1 · Python 3.14.2*
