# Vibe Editor — Development Roadmap

**April 2026 · 10-Day Plan + v1.1 Batch Processing**

---

## Overview

Vibe Editor is an AI-powered in-house video editing tool. This document defines the complete 10-day development roadmap from the current working prototype to a secure, multi-user, production-deployed application. The roadmap is ordered by technical dependency — each phase must be complete before the next begins.

The seven phases are:

- **Phase 1 — Foundation:** cloud transcription and user authentication
- **Phase 2 — Infrastructure:** project memory and multi-clip editing
- **Phase 3 — Intelligence:** agent memory and Google Fonts
- **Phase 4 — Style System:** preset styles and style recognition
- **Phase 5 — Collaboration:** project sharing and version history
- **Phase 6 — Security and Deployment:** hardening and launch
- **Phase 7 — Batch Processing (v1.1):** multi-video pipeline with script-driven cuts and preset export

---

## At a Glance

| # | Phase | Timeline | Features |
|---|-------|----------|----------|
| 1 | Foundation | Days 1–2 | Whisper Cloud · Auth & Login |
| 2 | Infrastructure | Days 3–4 | Project Memory · Multi-clip Refinement |
| 3 | Intelligence | Days 5–6 | Agent Memory · Google Fonts |
| 4 | Style System | Days 7–8 | Preset Styles · Style Recognition |
| 5 | Collaboration | Day 9 | Project Sharing · Version History |
| 6 | Security & Deploy | Day 10 | Security Review · Deployment |
| 7 | Batch Processing | v1.1 | Batch Job UI · Concurrent Renderer · Progress Dashboard · Bulk Export |

---

## Development Tree

```
Vibe Editor Roadmap
├─ Phase 1 — Foundation  —  Days 1–2
│    ├─ 1. Whisper Cloud Integration  —  deployment blocker — do first
│    └─ 2. Account Auth + Login  —  all ownership features depend on this
├─ Phase 2 — Infrastructure  —  Days 3–4
│    ├─ 3. Project Memory + File Storage  —  requires user identity from Phase 1
│    └─ 4. Multi-clip Timeline Refinement  —  must be correct before agent uses it
├─ Phase 3 — Intelligence  —  Days 5–6
│    ├─ 5. Agent Memory + Conversational AI  —  requires stable timeline from Phase 2
│    └─ 6. Google Fonts Integration  —  agent can reference fonts conversationally
├─ Phase 4 — Style System  —  Days 7–8
│    ├─ 7. Preset Styles Logic  —  requires project storage from Phase 2
│    └─ 8. Style Recognition + Copy  —  requires preset storage to save into
├─ Phase 5 — Collaboration  —  Day 9
│    └─ 9. Project Sharing + Version History  —  requires project memory from Phase 2
├─ Phase 6 — Security + Deployment  —  Day 10
│    └─ 10. Security Review + Launch  —  applied across all phases before go-live
└─ Phase 7 — Batch Processing  —  v1.1 release
     ├─ 11. Batch Job UI  —  upload N videos + scripts, pair them, select preset
     ├─ 12. Concurrent Render Pipeline  —  process up to 3 videos simultaneously
     ├─ 13. Progress Dashboard  —  per-video status tracking across the batch
     └─ 14. Bulk Export + Download  —  individual files ready when each job completes
```

---

## Phase Details

### Phase 1 — Foundation *(Days 1–2)*

**1. Whisper Cloud Integration**
Swap the local Python Whisper subprocess for the OpenAI Whisper cloud API. This is the deployment blocker — the app cannot run on a server without it. One API key, one endpoint call, approximately 2–3 hours of work.

**2. Account Auth + Login**
Implement email and password authentication via Supabase Auth. Every subsequent feature — projects, presets, sharing, version history — requires a user identity to attach to. This is the prerequisite for all ownership logic.

---

### Phase 2 — Infrastructure *(Days 3–4)*

**3. Project Memory + File Storage Migration**
Create the projects table in Supabase (timeline state stored as jsonb). Migrate uploaded video files from local filesystem to Supabase Storage so they have permanent URLs that survive redeployment. Replace localStorage with Supabase save/load. Users can now have multiple named projects and pick up where they left off.

**4. Multi-clip Timeline Refinement**
Improve the agent's ability to reference and edit specific clips when multiple clips are on the timeline. This must be done before agent memory is added — if the agent cannot reliably identify "clip 2 vs clip 3", giving it conversation history compounds the problem. Fix the foundation first.

---

### Phase 3 — Intelligence *(Days 5–6)*

**5. Agent Memory + Conversational Interaction**
Inject a rolling summary of the last N prompts into Claude's context on every request. This allows the agent to reference previous actions, respond to follow-up instructions ("undo what you did to the subtitles"), and ask clarifying questions. Transforms the tool from a command executor into an interactive editing collaborator.

**6. Google Fonts Integration**
Replace the current limited font list with the full Google Fonts catalogue. Fetch available fonts via the Google Fonts API, build a searchable font picker in the LeftPanel, and load selected fonts dynamically. Once agent memory exists, users can also request fonts conversationally.

---

### Phase 4 — Style System *(Days 7–8)*

**7. Preset Styles Logic**
Allow users to save the current element style as a named preset — either via a dedicated save button or by telling the agent "save this as preset X". Presets are stored in the Supabase styles table (already designed). The agent recognises "edit in X style" and fetches the preset to apply. Includes a preset library panel for browsing.

**8. Style Recognition and Copy Logic**
The most technically ambitious feature. Feed video frames to the agent and have Claude analyse the visual properties (subtitle style, zoom patterns, cuts, colour grading) and output a style preset object. Claude uses vision to infer font, colour, effect, and timing values from example videos. Requires preset storage infrastructure from item 7 to already exist.

---

### Phase 5 — Collaboration *(Day 9)*

**9. Project Sharing + Version History**
These are built together. Shareable project links with read or edit permissions enforced via Supabase Row Level Security. Named version snapshots surfaced in the UI — the reducer already maintains a full undo history, this phase exposes it with human-readable names and timestamps and adds the ability to jump to any saved version. Sharing without version history is risky; building them together ensures colleagues can collaborate safely.

---

### Phase 6 — Security and Deployment *(Day 10)*

**10. Security Review + Deployment**
This phase requires an experienced developer to review the entire application before it goes live. Covers: secrets management (API keys moved out of code into server environment variables), Row Level Security policies reviewed and tightened on all Supabase tables, HTTPS enforcement, CORS configuration, rate limiting on API routes, and secure deployment configuration on the hosting platform. This is a hardening and audit phase, not a build phase.

---

### Phase 7 — Batch Processing *(v1.1 Release)*

**11. Batch Job UI**
A dedicated interface for uploading multiple videos alongside their matching scripts, pairing each video to its script, naming the preset to apply, and submitting the entire batch as a single job. Each video becomes its own project in Supabase automatically.

**12. Concurrent Render Pipeline**
A server-side job runner that processes N videos in parallel with a concurrency limit (2–3 simultaneous Remotion renders depending on server capacity). Each task runs the full pipeline: create project, transcribe, compare transcript to script, generate cut operations, apply preset style, render. Whisper transcription and Claude operations run in parallel; Remotion renders are queued to avoid CPU exhaustion.

**13. Progress Dashboard**
A real-time status view showing each video in the batch individually: Queued, Transcribing, Cutting, Styling, Rendering, or Done. Users can see which videos are complete and download them without waiting for the full batch to finish.

**14. Bulk Export + Download**
Each completed video is saved to Supabase Storage and a download link is made available immediately. When the full batch is complete, a single ZIP download option collects all output files. Videos that fail do not block others — they surface an error with the reason so the user can retry individually.

---

## Scheduling Note

The roadmap assumes focused, full-day implementation work. The critical path is:

- **Phase 1 and 2** produce a fully deployable multi-user editor — this is the minimum viable deployment.
- **Phase 3** transforms the tool into an intelligent assistant — this is where it becomes distinctly useful compared to standard editors.
- **Phase 4** delivers the style consistency system — the feature most valuable for in-house content production at scale.
- **Phase 5** makes it a team tool rather than a solo tool.
- **Phase 6** is what makes it safe to give to colleagues.
- **Phase 7 (v1.1)** turns the tool into a production pipeline — the feature that multiplies output without multiplying effort.

> **Note:** Style Recognition (Phase 4, item 8) is the highest-risk item in the 10-day plan. If the week becomes compressed, items 1 through 7 constitute a complete, production-ready product. Item 8 can ship alongside Batch Processing in v1.1.

> **Note:** Batch Processing (Phase 7) is deliberately placed outside the 10-day window. It depends on stable exports (Phase 6), working presets (Phase 4), and multi-user project creation (Phase 2). Building it before those foundations are solid would create a fragile pipeline. Once the core product is in daily use, Phase 7 can be scoped and built as a focused sprint.
