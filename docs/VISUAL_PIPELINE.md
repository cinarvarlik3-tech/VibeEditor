# Vibe Editor — AI Visual Selection Pipeline

> Everything about how the "**Scan for Visuals**" button turns a transcript
> into suggested b-roll, images, and native overlays — including the exact
> prompts the LLM sees, the JSON schemas it must emit, the Pixabay search
> behaviour, and how the chosen asset ends up on the image track.

Read this alongside:
- `src/claude/visualComponentRules.js` — the verbatim policy appended to the
  system prompt for Pass 1 and Pass 2.
- `src/claude/generate.js` (lines ~1940–2175) — `generateVisualCandidates`,
  `generateRetrievalBrief`, `visualPipelineAiPick`, `extractTranscriptContext`.
- `src/server.js` — the three `/api/visual/*` endpoints + Pixabay proxy.
- `public/App.jsx` — `handleVisualScan`, `handleFindAssets`,
  `handleClaudePickAsset`, `handleCreateImageClip`, `handleUseNative`.
- `public/components/AgentPanel.jsx` — `VisualCandidatesPanel` UI.
- `src/assets/nativeVisuals.js` — native overlay presets.

---

## 1. What the feature is

The **Scan for Visuals** button in the agent panel asks the model to read the
transcript of the user's video and propose **moments** where a visual addition
would materially improve the final video — b-roll, a still image, or a native
on-screen graphic (keyword text, stat card, arrow, highlight box, callout).

It is a **three-pass pipeline** behind a single UI button:

1. **Pass 1 — Scan.** "Given this transcript, which moments warrant a visual,
   and what class of visual?" Returns a lightweight candidate list.
2. **Pass 2 — Brief.** On demand (when the user presses *Find Components*),
   a second model call generates a detailed retrieval brief (search query,
   orientation, filters) for that specific candidate.
3. **Pass 3 — Pick.** After Pixabay returns a grid of ~9 normalized candidates,
   the user can press *Let Claude Pick* and a tiny model call returns the best
   asset id from that grid.

Between Pass 2 and Pass 3 there is a **deterministic Pixabay search** (no LLM).
After Pass 3 there is a **deterministic ingest step** that downloads the asset,
converts images to MP4, uploads to Supabase Storage, and dispatches a `CREATE`
operation on `track_image_0`.

The whole feature is intentionally split so the LLM never writes timeline
operations directly for visuals — it only emits structured suggestions and
picks the winner. The UI holds the user's consent loop between each step.

---

## 2. The UI journey

### 2.1 Entry point — "Scan for Visuals" pill

`public/components/AgentPanel.jsx` renders the pill below the prompt textarea
when `hasCachedTranscript` is true (a transcript exists in memory for this
session/project). Pressing it calls `onVisualScan()` which runs
`handleVisualScan` in `App.jsx`.

```1187:1220:public/App.jsx
    const handleVisualScan = useCallback(async () => {
      if (!cachedTranscript || !Array.isArray(cachedTranscript)) return;
      try {
        const r = await fetch('/api/visual/scan', {
          method:  'POST',
          headers: authHeadersJson(),
          body:    JSON.stringify({
            projectId:          projectId || '',
            transcript:         cachedTranscript,
            stylePolicy:        {},
            keyMomentsPolicy:   {},
            visualContext:      {},
          }),
        });
        // ...pushes a message of type 'visual_candidates' into the agent
        // panel with { candidates: [...] }
      } catch (e) { /* ...error toast... */ }
    }, [cachedTranscript, projectId, addMessage]);
```

### 2.2 Candidate cards

Each candidate renders as a collapsible card with:
- a time range (e.g. `4.2s – 7.8s`)
- a moment-class chip (`hook`, `proof`, `CTA`, etc.) in a class-specific color
- a priority chip (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`)
- a one-sentence `reason`
- three buttons: **Find Components**, **Native**, **Skip**

Card state is local (`VisualCandidatesPanel` uses `useState`) and keyed with
`__vuid` (generated from `candidate_id` or a fallback unique id).

### 2.3 Find Components → Pass 2 + Pixabay

Pressing **Find Components** runs `handleFindAssets(candidate)` in `App.jsx`:

```1222:1260:public/App.jsx
    const handleFindAssets = useCallback(async (candidate) => {
      const r = await fetch('/api/visual/brief', {
        method:  'POST',
        headers: authHeadersJson(),
        body:    JSON.stringify({
          candidate,
          transcript: cachedTranscript || [],
          stylePolicy: {},
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Brief failed');
      if (!data.brief) {
        return { assets: [], lowConfidence: true };
      }
      const b = data.brief;
      const kind   = b.required_asset_kind  === 'image'    ? 'image'    : 'video';
      const orient = b.required_orientation === 'portrait' ? 'portrait' : 'all';
      const qStr   = String(b.retrieval_query_primary || '').trim().slice(0, 100);
      if (!qStr) {
        return { assets: [], lowConfidence: false,
                 searchError: 'Brief did not include a search query.' };
      }
      const qs = new URLSearchParams({ q: qStr, asset_type: kind,
                                       per_page: '9', orientation: orient });
      const pr = await fetch('/api/pixabay/search?' + qs.toString(),
                             { headers: authHeadersBearer() });
      // returns { assets, lowConfidence, searchError? }
    }, [cachedTranscript]);
```

Possible outcomes the UI handles explicitly:

| Backend result | UI treatment |
|----------------|--------------|
| Brief returns `null` (model confidence < 0.55) | Yellow warning: "Confidence too low for Pixabay retrieval. Use native component instead." |
| Brief returned but query was empty | Yellow warning: "Brief did not include a search query." |
| Pixabay returned 429 | Yellow warning: "Pixabay rate limit exceeded. Wait a moment and try again." |
| Pixabay returned other errors | Yellow warning with the error message from Pixabay |
| Pixabay returned zero hits | Grid simply shows nothing (still expanded) |
| Pixabay returned hits | Render a 3×3 grid of thumbnails with per-thumbnail **Use This** buttons + a top-level **Let Claude Pick** button |

### 2.4 Use This → ingest → imageClip

Pressing **Use This** on a card POSTs to `/api/pixabay/ingest` with
`{ assetId, assetType, downloadUrl, projectId, duration }`. The server
downloads the asset, converts images to a 5-second MP4 (via
`convertImageToVideo`), uploads to the `image-layer` Supabase bucket as
`{userId}/{projectId}/pixabay_{assetId}.mp4`, and returns
`{ permanentUrl, storageRef, duration, filename }`.

The UI then calls `handleCreateImageClip` which dispatches:

```js
{ type: 'APPLY_OPERATIONS',
  payload: { operations: [{ op: 'CREATE', trackId: 'track_image_0', element: { ... imageClip } }],
             promptText: null } }
```

The imageClip is built from the candidate's time range + the asset's download
URL + a `defaultImageClipLayoutPayload()` (fullscreen). See
`handleCreateImageClip` in `App.jsx` (~line 1274) for the exact shape.

### 2.5 Let Claude Pick → Pass 3

Pressing **Let Claude Pick** calls `handleClaudePickAsset(candidate, assets)`
which POSTs `{ candidate, assets }` to `/api/visual/claude-pick`. The response
`{ chosen_id }` is matched against the asset list; if found, the UI runs the
same ingest path as **Use This** with that asset.

### 2.6 Native → keyword overlay

Pressing **Native** calls `handleUseNative(candidate)` which dispatches a
`CREATE` for an imageClip with `sourceType: 'native'`, `src: 'native://keyword_text'`,
and a `nativePayload` containing the candidate's `spoken_text_anchor` as the
on-screen text (capped at 80 chars). The serializer + preview render this via
the `keyword_text` native block.

Other native types (`stat_card`, `arrow`, `highlight_box`, `callout`) are
defined in `src/assets/nativeVisuals.js` but the UI currently only exposes
`keyword_text` from the visual-candidates panel. The others are reachable from
the broader agent pipeline when Claude emits them via `CREATE` in `/generate`.

### 2.7 Skip

Removes the candidate from the local list only. It is not persisted — hitting
Scan for Visuals again regenerates candidates (subject to the `visual_scan`
LLM cache).

---

## 3. The backend (three endpoints)

Endpoints are in `src/server.js`:

- `POST /api/visual/scan`          → `generateVisualCandidates(...)`
- `POST /api/visual/brief`         → `generateRetrievalBrief(...)`
- `POST /api/visual/claude-pick`   → `visualPipelineAiPick(...)`

All three require `Authorization: Bearer <Supabase JWT>`.

### 3.1 `/api/visual/scan`

```1325:1362:src/server.js
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
    } else {
      candidates = await generateVisualCandidates(
        transcript, stylePolicy || {}, keyMomentsPolicy || {},
        visualContext || {}, {}, req.user.id
      );
      visualScanLlmCache.set(scanKey, { candidates });
    }
    res.json({ candidates, llmCacheHit: !!cachedScan, llmCache: ... });
  } catch (err) {
    res.status(500).json({ error: err.message || 'visual scan failed' });
  }
});
```

Response shape: `{ candidates: Candidate[], llmCacheHit: boolean, llmCache: {...}|null }`.

`generateVisualCandidates` is a wrapper over the OpenAI chat completions
endpoint. It:

1. Throws if `OPENAI_API_KEY` is missing.
2. Composes a single user message with `canonicalStringify` payloads:
   ```
   PROMPT: Scan this transcript for visual component opportunities.
   TRANSCRIPT: {...full transcript segments...}
   STYLE_VISUAL_POLICY: {...}
   KEY_MOMENTS_POLICY: {...}
   CURRENT_VISUAL_CONTEXT: {...}
   ```
3. Sends the full `visualPassSystemContent()` as the system prompt (see §4).
4. Calls OpenAI with `model = MODEL_FOR_VISUAL_SCAN` (mini by default),
   `max_completion_tokens: 8000`, `callSite: 'visual_scan'`.
5. Records usage to `metrics.recordChatUsage('visual_scan', usage)` which flows
   into `/api/_debug/token-report`.
6. Strips markdown code fences and parses the response as a JSON array.
7. **Priority filter.** Unless `opts.includeAllPriorities` is true, the server
   keeps only `priority === 'critical'` and `priority === 'high'` candidates.
   The server currently always passes `{}` as `opts`, so only critical/high
   are returned by default.

### 3.2 `/api/visual/brief`

```1364:1395:src/server.js
app.post('/api/visual/brief', requireAuth, async (req, res) => {
  try {
    const { candidate, transcript, stylePolicy } = req.body || {};
    if (!candidate) return res.status(400).json({ error: 'candidate is required' });
    const st = candidate.start_time != null ? candidate.start_time : candidate.startTime;
    const ctx = extractTranscriptContext(transcript || [], st, 10);
    // ...cache lookup...
    brief = await generateRetrievalBrief(candidate, ctx, stylePolicy || {}, req.user.id);
    // ...
    res.json({ brief, llmCacheHit, llmCache });
  } catch (err) { res.status(500).json({ error: err.message || 'visual brief failed' }); }
});
```

The server extracts a ±10 s transcript window around the candidate's start time
so Pass 2 has grounded context without sending the whole transcript again:

```1997:2009:src/claude/generate.js
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
```

`generateRetrievalBrief`:

1. Composes the user message:
   ```
   PROMPT: Generate a retrieval brief for this visual candidate.
   CANDIDATE: {candidate object from Pass 1}
   TRANSCRIPT_CONTEXT: [{...±10s segments...}]
   STYLE_VISUAL_POLICY: {...}
   ```
2. Uses `visualPassSystemContent()` as the system prompt (same content as Pass 1).
3. Calls `MODEL_FOR_VISUAL_BRIEF` (mini by default), `max_completion_tokens: 4096`,
   `callSite: 'visual_brief'`.
4. Parses the first JSON object out of the response (strips fences; also
   accepts `[{...}]` and returns `[0]`).
5. **Confidence gate.** If `confidence_score < 0.55` or not finite,
   returns `null` (UI shows "Confidence too low").
6. **Required-field gate.** Returns `null` unless all of these exist:
   `candidate_id`, `retrieval_query_primary`, `retrieval_query_alternates`,
   `required_orientation`, `required_asset_kind`, `confidence_score`, and
   `retrieval_query_alternates` is an array.

Response shape: `{ brief: Brief | null, llmCacheHit, llmCache }`.

### 3.3 `/api/visual/claude-pick`

```1397:1428:src/server.js
app.post('/api/visual/claude-pick', requireAuth, async (req, res) => {
  try {
    const { candidate, assets } = req.body || {};
    // ...cache lookup...
    out = await visualPipelineAiPick(candidate || {}, Array.isArray(assets) ? assets : [], req.user.id);
    // ...
    res.json({ ...out, llmCacheHit, llmCache });
  } catch (err) { res.status(500).json({ error: err.message || 'visual pick failed' }); }
});
```

`visualPipelineAiPick` is deliberately minimal:

```2127:2173:src/claude/generate.js
async function visualPipelineAiPick(candidate, assets, userId = null) {
  const pickSystem = 'You respond with JSON only. No markdown.';
  const userMsg =
    'Given these ranked visual assets for the moment described, choose the single best one. ' +
    'Return only the asset id as a JSON object: { "chosen_id": <number> }\n\n' +
    'CANDIDATE: ' + canonicalStringify(candidate || {}) + '\n' +
    'ASSETS: ' + canonicalStringify(assets || []);

  response = await chatCompletionRequest({
    model:                 MODEL_FOR_VISUAL_PICK,    // nano by default
    messages:              [{ role: 'user', content: userMsg }],
    systemPrompt:          pickSystem,
    max_completion_tokens: 256,
    userId,
    callSite:              'visual_pick',
  });
  // parse { chosen_id: number }, throw if NaN
  return { chosen_id: id };
}
```

Response shape: `{ chosen_id: number, llmCacheHit, llmCache }`.

---

## 4. What the model sees

The visual pipeline deliberately reuses the **full editor system prompt**
(`SYSTEM_PROMPT` from `systemPrompt.js`) with `VISUAL_COMPONENT_RULES`
appended:

```1945:1952:src/claude/generate.js
function visualPassSystemContent() {
  // Visual pipeline always uses the full rule set — it depends on every
  // surface (subtitles, images, animations, tracks, etc.) — so we go
  // through the backwards-compat SYSTEM_PROMPT export rather than trying
  // to enumerate bundles. This matches the v1 behavior of "system prompt +
  // visual rules".
  return `${SYSTEM_PROMPT.trim()}\n\n${VISUAL_COMPONENT_RULES}`;
}
```

### 4.1 `VISUAL_COMPONENT_RULES` (verbatim — the normative policy)

The full text lives in `src/claude/visualComponentRules.js`. Summary:

1. **Role framing.** "You operate in visual analysis mode. Your job is to
   detect candidate moments in the transcript and classify each one. You do
   not insert assets directly. You do not choose specific Pixabay files. You
   return structured JSON output that the deterministic pipeline processes."
2. **Four jobs.** Detect moments → classify them → decide native vs external
   stock → (Pass 2) emit a retrieval brief.
3. **Image layer rule.** "Visual components are placed on the image layer — a
   new track type that sits above the video track and below the subtitle
   track. The image layer never replaces the video track. Both play
   simultaneously."
4. **Pass 1 output format** — one object per detected moment (see §5).
5. **Pass 2 output format** — a single object (not an array) per brief
   (see §6), or a native component spec if `native_only`.
6. **Five gates for moment detection.** Accept a candidate only if all five
   gates pass:
   - **Gate 1** — belongs to a recognised moment class.
   - **Gate 2** — fits style guide density, tone, and pacing.
   - **Gate 3** — meets the minimum priority threshold from the
     `KEY_MOMENTS_POLICY`.
   - **Gate 4** — visually resolvable as a native component or a specific
     stock query.
   - **Gate 5** — not redundant with recent inserts or existing emphasis.
7. **Native vs external rules.** Native for numeric/comparative/structural/
   directional. External stock for environmental/contextual/lifestyle. Skip
   when the query would be vague.
8. **Retrieval query rules.** Plain noun phrases. 2–4 alternates.
   Confidence < 0.55 → do not trigger external retrieval.
9. **Duration rules.** External stock clamp 1.2–4.5 s. Native keyword text
   0.8–2.0 s. Stat cards 1.5–4.0 s. `start_time` = semantic onset, not
   sentence start.
10. **Hard rejection.** VRS < 0.35 and no native fallback; style fit < 0.30;
    saturation penalty > 0.80 unless KPS > 0.85 with aggressive style; any
    overlap with a stronger neighbouring candidate.
11. **Error prevention.** Never fabricate Pixabay IDs/URLs. Never insert
    imageClip elements directly into `CURRENT_TRACKS`. Never overlap two
    suggestions. Empty array if nothing passes all five gates. Pass 2 must
    return a single object, not an array. Always `start_time < end_time`.
    Never suggest a visual shorter than 0.8 s.

### 4.2 Inputs to Pass 1

```
PROMPT: Scan this transcript for visual component opportunities.
TRANSCRIPT: <full transcript segments, canonicalized JSON>
STYLE_VISUAL_POLICY: <stylePolicy or {}>
KEY_MOMENTS_POLICY: <keyMomentsPolicy or {}>
CURRENT_VISUAL_CONTEXT: <visualContext or {}>
```

Today `App.jsx` sends all three policies as `{}`. They are wired so Phase 4
(Preset Styles + Style Recognition) can populate them without a protocol change.

### 4.3 Inputs to Pass 2

```
PROMPT: Generate a retrieval brief for this visual candidate.
CANDIDATE: <single Pass 1 candidate>
TRANSCRIPT_CONTEXT: <±10s window around candidate.start_time>
STYLE_VISUAL_POLICY: <stylePolicy or {}>
```

### 4.4 Inputs to Pass 3 (Pick)

Uses its own minimal system prompt (`'You respond with JSON only. No markdown.'`).
User message:

```
Given these ranked visual assets for the moment described, choose the single best one.
Return only the asset id as a JSON object: { "chosen_id": <number> }

CANDIDATE: <candidate>
ASSETS:    <normalized Pixabay hits>
```

---

## 5. Pass 1 schema — Candidate

Output is a JSON **array** of candidate objects (empty array if nothing passes
the five gates).

```jsonc
{
  "candidate_id":        "vis_001",
  "start_time":          12.3,            // seconds
  "end_time":            15.1,            // seconds
  "spoken_text_anchor":  "the exact phrase from the transcript",
  "moment_class":        "hook",          // see list below
  "resolution_strategy": "external_stock",// external_stock | native_only | skip
  "priority":            "critical",      // critical | high | medium | low
  "reason":              "one sentence plain English"
}
```

**Moment classes** (enum, from VISUAL_COMPONENT_RULES):
`hook`, `explanation`, `proof`, `contrast`, `transition`, `example`,
`instruction`, `entity_mention`, `emotional_peak`, `payoff`, `CTA`,
`retention_rescue`.

**Server-side filtering** keeps only `priority === 'critical'` and
`priority === 'high'` unless `opts.includeAllPriorities` is passed
(it is not, today).

**UI display mapping** (colors in `VisualCandidatesPanel`):

| Moment class | Hex | |
|---|---|---|
| `hook` | `#22D3EE` | cyan |
| `explanation` | `#A78BFA` | purple |
| `proof` | `#34D399` | emerald |
| `contrast` | `#F472B6` | pink |
| `transition` | `#94A3B8` | slate |
| `example` | `#FBBF24` | amber |
| `instruction` | `#60A5FA` | sky |
| `entity_mention` | `#C084FC` | violet |
| `emotional_peak` | `#FB7185` | rose |
| `payoff` | `#4ADE80` | green |
| `CTA` | `#38BDF8` | sky |
| `retention_rescue` | `#F97316` | orange |
| fallback | `#64748B` | |

| Priority | Color | Label |
|---|---|---|
| critical | `rgba(239,68,68,0.2)` / `#F87171` | CRITICAL |
| high | `rgba(249,115,22,0.2)` / `#FB923C` | HIGH |
| medium | `rgba(234,179,8,0.2)` / `#FACC15` | MEDIUM |
| low | `rgba(156,163,175,0.15)` / `#9CA3AF` | LOW |

---

## 6. Pass 2 schema — Retrieval Brief

For `resolution_strategy === 'external_stock'`, Pass 2 returns a **single
object**:

```jsonc
{
  "candidate_id":               "vis_001",
  "start_time":                 12.3,
  "end_time":                   15.1,
  "moment_class":               "hook",
  "visual_purpose":             "explain",
                 // explain | emphasize | illustrate | prove |
                 // retain_attention | transition | emotional_support
  "external_visual_type":       "broll_office",
                 // broll_office | broll_city | broll_phone | broll_lifestyle |
                 // broll_product_generic | broll_people_working |
                 // still_photo_generic | environment_cutaway | conceptual_texture
  "retrieval_query_primary":    "busy modern office team",
  "retrieval_query_alternates": ["coworkers collaborating",
                                 "open plan office",
                                 "startup office meeting"],
  "required_orientation":       "portrait",   // portrait | flexible
  "required_asset_kind":        "video",      // video | image
  "human_presence":             "prefer",     // prefer | avoid | neutral
  "text_in_asset":              "avoid",      // avoid | allow | neutral
  "motion_level":               "medium",     // low | medium | high
  "literalness_target":         "medium",     // low | medium | high
  "environment_preference":     "indoor",     // indoor | outdoor | neutral
  "object_focus":               "laptop",     // string or null
  "color_mood":                 "warm neutral",// string or null
  "exclusion_terms":            ["cartoon", "illustration"],
  "max_results_requested":      9,
  "confidence_score":           0.78,         // 0.0 – 1.0; <0.55 → server returns null
  "notes_for_ranking":          "prefer variety of angles"
}
```

**Server-enforced validation** (`generateRetrievalBrief`):

- `confidence_score` must be finite and ≥ 0.55.
- These keys must all exist (truthy, not undefined/null):
  `candidate_id`, `retrieval_query_primary`, `retrieval_query_alternates`,
  `required_orientation`, `required_asset_kind`, `confidence_score`.
- `retrieval_query_alternates` must be an array.

Failures all collapse to the same outcome — the endpoint returns
`{ brief: null }` and the UI shows the low-confidence warning.

**How the UI uses the brief.**

```text
qStr   = brief.retrieval_query_primary (trimmed, max 100 chars)
kind   = brief.required_asset_kind === 'image'    ? 'image'    : 'video'
orient = brief.required_orientation === 'portrait' ? 'portrait' : 'all'
```

and then:

```
GET /api/pixabay/search?q=<qStr>&asset_type=<kind>&per_page=9&orientation=<orient>
```

Note: **alternates are currently unused** at the UI level. They exist so a
future ranker can try them in a fallback loop if primary returns no hits.

---

## 7. Pixabay layer

### 7.1 Search (`GET /api/pixabay/search`)

Key server behaviour (see `src/server.js`):

- 503 returned if `PIXABAY_API_KEY` is missing.
- 400 returned if `q` is empty.
- `q` is truncated at 100 chars.
- `per_page` clamped to `[1, 20]`.
- **24-hour in-memory LRU** keyed by `{ q, assetType, perPage, orientation }`
  (`pixabayLRU`, max 500 entries).
- `asset_type=image` hits `pixabay.com/api/` with `image_type=photo` and
  `safesearch=true`. `orientation=portrait` maps to Pixabay's
  `orientation=vertical`.
- `asset_type=video` hits `pixabay.com/api/videos/` with `video_type=all`
  and `safesearch=true`.
- `asset_type=all` runs both endpoints in parallel, each at `per_page/2`.
- Hits with `watermark` in `tags` are filtered out post-hoc.
- Pixabay 429 → client sees `429` with message "Pixabay rate limit exceeded.
  Wait a moment and try again." Anything else → `502` with the provider message.

### 7.2 Normalized asset shape

Both image and video hits are normalized to a single shape before being sent
to the browser (and then forwarded to `visualPipelineAiPick`):

```jsonc
{
  "id":           12345,           // pixabay id (number)
  "type":         "video"|"image",
  "previewUrl":   "...",
  "thumbnailUrl": "...",
  "downloadUrl":  "...",           // the largest available URL
  "duration":     number|null,     // seconds for videos, null for images
  "width":        number,
  "height":       number,
  "tags":         "comma, separated",
  "contributor":  "username",
  "pageURL":      "https://pixabay.com/..."
}
```

Response envelope: `{ results: Asset[], query: string, total: number }`.

### 7.3 Ingest (`POST /api/pixabay/ingest`)

Body: `{ assetId, assetType, downloadUrl, projectId, duration }`.

1. Ownership check: the `projects` row must belong to `req.user.id`.
2. Download to `os.tmpdir()` (`axios.get(..., { responseType:'arraybuffer',
   timeout: 120000, maxContentLength: MAX_UPLOAD_BYTES })`).
3. If `assetType === 'image'`, `convertImageToVideo(tmpDl, duration || 5)` to
   produce a 5 s MP4.
4. If video, probe duration via `getVideoDuration` if the browser didn't
   supply it.
5. Upload to `image-layer/{userId}/{projectId}/pixabay_{assetId}.mp4`.
6. Respond: `{ permanentUrl, storageRef:{bucket,path}, duration, filename }`.

This is the only file-creating step in the visual pipeline. The LLM never
touches it.

---

## 8. Native overlays

Native visuals are rendered by the editor itself (no external assets). They are
defined in `src/assets/nativeVisuals.js`:

```js
NATIVE_VISUAL_PRESETS = {
  keyword_text:   { type:'keyword_text', label:'Keyword text',
                    defaultPayload: { text:'Key point', color:'#FFFFFF',
                                      fontSize:56, fontFamily:'Inter, system-ui, sans-serif',
                                      fontWeight:'700', background:'rgba(0,0,0,0.55)' } },
  stat_card:      { type:'stat_card', label:'Stat card',
                    defaultPayload: { value:'42', label:'Metric', unit:'%', color:'#00BCD4' } },
  arrow:          { type:'arrow', label:'Arrow',
                    defaultPayload: { direction:'right', color:'#FFFFFF', size:64 } },
  highlight_box:  { type:'highlight_box', label:'Highlight box',
                    defaultPayload: { x:0.2, y:0.35, width:0.6, height:0.25,
                                      color:'#00BCD4', opacity:0.85 } },
  callout:        { type:'callout', label:'Callout',
                    defaultPayload: { text:'Note', color:'#FFFFFF', fontSize:40 } },
};
```

In the timeline, a native overlay is an **imageClip** with:
- `sourceType: 'native'`
- `src: 'native://{type}'` (e.g. `'native://keyword_text'`)
- `nativePayload: { ...see presets... }` plus any candidate-derived overrides
  (e.g. the spoken phrase as `text`).

Rendering happens in two places and **must stay in sync**:
- `src/video/serializeToRemotion.js → ImageClipBlock` — for export via Remotion.
- `public/components/VideoPreview.jsx` — for the browser preview.

Both branches read `imageLayout` (layoutMode/anchor/box) the same way so the
native graphic occupies the same screen region the user saw in preview.

In the visual pipeline UI, the **Native** button always creates a
`keyword_text` using the candidate's `spoken_text_anchor` (fallback: `reason`).
This is deliberate — `stat_card` / `arrow` / `highlight_box` / `callout`
are currently only produced by the broader `/generate` agent when the user
asks for them directly; the Scan-for-Visuals pipeline doesn't attempt to
classify which native subtype fits a moment.

---

## 9. Model routing, caching, and cost

### 9.1 Model routing (env-driven)

```36:49:src/claude/generate.js
const MODEL_FLAGSHIP         = process.env.OPENAI_MODEL_FLAGSHIP || 'gpt-5.4';
const MODEL_MINI             = process.env.OPENAI_MODEL_MINI     || 'gpt-5.4-mini';
const MODEL_NANO             = process.env.OPENAI_MODEL_NANO     || 'gpt-5.4-nano';
const FEATURE_MODEL_ROUTING  = envFeature('FEATURE_MODEL_ROUTING', true);
// ...
const MODEL_FOR_VISUAL_SCAN  = FEATURE_MODEL_ROUTING ? MODEL_MINI : MODEL_FLAGSHIP;
const MODEL_FOR_VISUAL_BRIEF = FEATURE_MODEL_ROUTING ? MODEL_MINI : MODEL_FLAGSHIP;
const MODEL_FOR_VISUAL_PICK  = FEATURE_MODEL_ROUTING ? MODEL_NANO : MODEL_FLAGSHIP;
```

Rule of thumb:
- **Scan** and **Brief** use **mini** — they need reasoning over policy gates
  and structured output, but not flagship depth.
- **Pick** uses **nano** — it is a constrained id-selection task.
- `FEATURE_MODEL_ROUTING=false` forces flagship everywhere. Use to debug
  quality regressions.

`max_completion_tokens`: 8000 (scan), 4096 (brief), 256 (pick).

### 9.2 Per-callsite LLM caches

Three separate caches live in `src/server.js`:

```100:120:src/server.js
const visualScanLlmCache = makeLlmResponseCache({
  name: 'llm_visual_scan',
  maxEnv: 'LLM_VISUAL_SCAN_CACHE_MAX',   ttlMsEnv: 'LLM_VISUAL_SCAN_CACHE_TTL_MS',
  defaultMax: 60,   defaultTtlMs: 15 * 60 * 1000,
});
const visualBriefLlmCache = makeLlmResponseCache({
  name: 'llm_visual_brief',
  maxEnv: 'LLM_VISUAL_BRIEF_CACHE_MAX',  ttlMsEnv: 'LLM_VISUAL_BRIEF_CACHE_TTL_MS',
  defaultMax: 200,  defaultTtlMs: 15 * 60 * 1000,
});
const visualPickLlmCache = makeLlmResponseCache({
  name: 'llm_visual_pick',
  maxEnv: 'LLM_VISUAL_PICK_CACHE_MAX',   ttlMsEnv: 'LLM_VISUAL_PICK_CACHE_TTL_MS',
  defaultMax: 400,  defaultTtlMs: 15 * 60 * 1000,
});
```

Keying:
- **scan** — `{ userId, transcript, stylePolicy, keyMomentsPolicy, visualContext, opts }`
- **brief** — `{ userId, candidate, transcriptCtx, stylePolicy }`
- **pick** — `{ userId, candidate, assets }`

All keys are `sha256(canonicalStringify(payload))`. Keys are user-scoped — two
users with identical transcripts do *not* share cache entries. Cache hits
skip OpenAI entirely and are surfaced in the response as
`llmCacheHit: true, llmCache: { scope, keyPrefix }` for observability.

### 9.3 Metrics

Every call records usage via `metrics.recordChatUsage(callSite, usage)`:

```
metrics.chatSiteStats('visual_scan')    // totals
metrics.chatSiteStats('visual_brief')
metrics.chatSiteStats('visual_pick')
```

Rolling percentiles (input, output, cached, ratio) for each callsite are visible
in `/api/_debug/cache` (JSON) and `/api/_debug/token-report` (plain text).
Expect `visual_pick` to have very small averages (single-digit output tokens).

---

## 10. End-to-end sequence

```
 User                   App.jsx / AgentPanel          Express               OpenAI        Pixabay     Supabase
  │                           │                           │                    │             │            │
  │ click "Scan for Visuals"  │                           │                    │             │            │
  │──────────────────────────▶│                           │                    │             │            │
  │                           │ POST /api/visual/scan     │                    │             │            │
  │                           │──────────────────────────▶│  cache? ──miss──▶  │ generateVisualCandidates │
  │                           │                           │◀──────────────────│                            │
  │                           │◀── { candidates: [...] } ─│                    │             │            │
  │    (grid of cards)        │                           │                    │             │            │
  │                           │                           │                    │             │            │
  │ click "Find Components"   │                           │                    │             │            │
  │──────────────────────────▶│ POST /api/visual/brief    │                    │             │            │
  │                           │──────────────────────────▶│  cache? ──miss──▶  │ generateRetrievalBrief   │
  │                           │                           │◀──────────────────│                            │
  │                           │◀── { brief: {...} } ──────│                    │             │            │
  │                           │ GET /api/pixabay/search   │                    │             │            │
  │                           │──────────────────────────▶│  LRU hit or ──────▶│             ◀── 9 hits ──│            │
  │                           │◀── { results: [9] } ──────│                    │             │            │
  │    (3×3 thumbnail grid)   │                           │                    │             │            │
  │                           │                           │                    │             │            │
  │ click "Let Claude Pick"   │                           │                    │             │            │
  │──────────────────────────▶│ POST /api/visual/claude-pick                   │             │            │
  │                           │──────────────────────────▶│  cache? ──miss──▶  │ visualPipelineAiPick     │
  │                           │                           │◀──────────────────│                            │
  │                           │◀── { chosen_id } ─────────│                    │             │            │
  │                           │                           │                    │             │            │
  │ click "Use This"          │                           │                    │             │            │
  │──────────────────────────▶│ POST /api/pixabay/ingest  │                    │             │            │
  │                           │──────────────────────────▶│ download asset ────┼────────────▶│            │
  │                           │                           │ ffmpeg if image    │             │            │
  │                           │                           │ upload ────────────┼─────────────┼──────────▶ image-layer/
  │                           │◀── { permanentUrl, ... } ─│                    │             │            │
  │                           │                           │                    │             │            │
  │                           │ dispatch APPLY_OPERATIONS │                    │             │            │
  │                           │ → CREATE imageClip on     │                    │             │            │
  │                           │   track_image_0           │                    │             │            │
  │◀── preview updates ───────│                           │                    │             │            │
```

---

## 11. Observability, debugging, gotchas

### 11.1 Debug endpoints for this pipeline

- `GET /api/_debug/cache` — includes `chatSiteStats.visual_scan`,
  `visual_brief`, `visual_pick`, plus `llmResponseCaches.visualScan/Brief/Pick`
  (max + TTL) and `diagnostics.perSite.visual_*`.
- `GET /api/_debug/token-report` — rolling p50/p95 per callsite in plain text.

### 11.2 Common failure modes

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Scan returns `[]` | No candidates passed all 5 gates; or OpenAI response was unparseable | Read server logs for `[visual-pass1]` usage line; set `opts.includeAllPriorities` temporarily to include medium/low |
| Brief returns `null` (UI: "Confidence too low") | `confidence_score < 0.55` or a required field is missing | Log the raw response in `generateRetrievalBrief` temporarily |
| Pixabay returns 429 | Hit free-tier rate limits | Wait; or add backoff retry in the proxy |
| Pixabay returns 0 results | Query too specific | Add fallback: iterate `retrieval_query_alternates` (not wired today) |
| `claude-pick` returns a valid id but no asset matches | `chosen_id` coerced to number is NaN or not in the shown set | Check `assets.find(a => a.id === id)` — model hallucinated an id |
| Ingest 403 "Invalid project" | `projectId` in request doesn't belong to `req.user.id` | Verify the client is sending the current project id |
| Exported MP4 b-roll is misaligned | `imageLayout` divergence between preview and Remotion render | Diff `ImageClipBlock` in `serializeToRemotion.js` vs `VideoPreview.jsx` |
| Two suggested visuals overlap on timeline | Rule #6 ("never overlap") not enforced server-side — trust the model, but filter | Add a server-side overlap filter in `generateVisualCandidates` post-parse |

### 11.3 Gotchas worth knowing

- **`stylePolicy`, `keyMomentsPolicy`, `visualContext` are currently `{}`.** The
  prompt already consumes them. When Phase 4 (Preset Styles / Style
  Recognition) lands, populate them on the client. Changing the payload shape
  invalidates every LLM cache entry — that's a feature, not a bug.
- **Priority filter is server-side.** The UI never sees `medium`/`low`
  candidates. Changing this requires threading `includeAllPriorities` through
  the endpoint and up into `App.jsx`.
- **Alternates are generated but never used.** `retrieval_query_alternates`
  is in the schema and the model emits them. No server/client path tries them.
  Low-hanging improvement.
- **"Use This" ingests every time.** There is no de-dup. Clicking the same
  thumbnail twice uploads twice (with timestamped filenames) and creates two
  imageClips. Add a per-candidate dedupe on the client if needed.
- **Cache keys are user-scoped** — A/B testing across users will *not* share
  responses. Lower `defaultMax` in prod if this gets memory-heavy.
- **Pass 1 is priced per transcript length.** A 60-min video transcript will be
  a big input. `FEATURE_TRANSCRIPT_WINDOWING` does **not** apply to the visual
  scan — it's a generate-path optimization. If visual-scan cost becomes
  material, add a scan-specific windowing strategy (e.g. chunk the transcript
  into N-minute windows, scan each, merge).
- **No vision model involvement.** The pipeline is text-only; the model never
  sees the actual video frames. It scans the transcript and reasons about
  what kind of b-roll or native overlay would suit the moment.
- **Native overlay duration clamps are not enforced server-side.** The model is
  instructed to clamp to 0.8–4.0 s, but nothing strips overlong candidates
  today. If you see 15-second keyword texts, that's why.

### 11.4 Quick tuning levers

| Goal | Lever |
|------|-------|
| More candidates surfaced | Pass `opts.includeAllPriorities` into `generateVisualCandidates` (requires endpoint change) or lower Pass-1 priority filter. |
| Higher-quality picks | Set `FEATURE_MODEL_ROUTING=false` (visual_pick runs on flagship instead of nano). Cost increases dramatically. |
| Less repeat spend | Raise `LLM_VISUAL_*_CACHE_TTL_MS`. Current default is 15 min. |
| Fewer "low confidence" dead ends | Lower the `< 0.55` threshold in `generateRetrievalBrief` (e.g. to 0.45) — accepts more uncertain briefs. |
| Better query fallback | Wire `retrieval_query_alternates` into the Pixabay loop: try primary, then alternates in order, first non-empty wins. |
| Per-moment guidance from user | Populate `visualContext` in `handleVisualScan` with the agent's memory (preferred topics, banned terms, style preset). |

---

## 12. Extending the feature

### 12.1 Adding a new moment class

1. Add the string to the enum in `VISUAL_COMPONENT_RULES` (Pass 1 schema +
   moment-class list in section "Moment Detection Rules").
2. Add a color mapping in `public/components/AgentPanel.jsx → clsColor`.
3. Optionally bias native vs external for that class in the rules text.

### 12.2 Adding a new native visual type

1. Add preset to `src/assets/nativeVisuals.js`.
2. Add a branch in `src/video/serializeToRemotion.js → ImageClipBlock`.
3. Add the matching preview branch in `public/components/VideoPreview.jsx`.
4. Either teach `VISUAL_COMPONENT_RULES` how/when to emit
   `resolution_strategy: 'native_only'` with the new type, or surface a UI
   button in the candidate card that calls `handleUseNative` with the new
   type encoded in `src` / `nativePayload`.

### 12.3 Swapping the asset provider

- Current: Pixabay only.
- To add another provider (e.g. Pexels), add `/api/<provider>/search` + ingest
  symmetrical to Pixabay in `src/server.js`, then either:
  - Have `handleFindAssets` call both providers in parallel and merge results, or
  - Teach Pass 2 to emit a `preferred_source` field and honor it in
    `handleFindAssets`.

### 12.4 Vision-based scanning

If/when the model should see actual frames (face detection, motion analysis,
color grading cues), introduce a Pass 0 that calls a multimodal model on
thumbnails extracted by `extractThumbnailAtPercent`. Feed the synthesized
observations as a new `CURRENT_VISUAL_CONTEXT` field. No change to the
Pass 1 / Pass 2 contract is required.

---

## 13. Summary for reviewers

- The LLM never touches the timeline directly in this flow. It proposes
  moments, then proposes retrieval criteria, then picks from a shortlist the
  server produced.
- The user is always in the loop: each Pass has an explicit UI click.
- The policy — the five gates, native/external trade-offs, duration clamps,
  confidence thresholds — is a **single text file** (`visualComponentRules.js`).
  Editing it is how you change Scan-for-Visuals behavior.
- The deterministic parts (Pixabay proxy, image→MP4 conversion, Storage
  upload, reducer CREATE) are the same code paths any other media upload uses.
- The caches make re-pressing Scan cheap; the model-routing keeps the per-call
  cost bounded; the debug endpoints make regressions easy to spot.

---

*Last updated to match the code at `src/server.js:1325–1428` and
`src/claude/generate.js:1943–2175`. When you change the payload to any
`/api/visual/*` endpoint, update this doc and the matching schema in
`VISUAL_COMPONENT_RULES` in the same commit.*
