/**
 * VISUAL COMPONENT ADDITION RULES — verbatim policy for Pass 1 / Pass 2 visual pipeline.
 * Not part of SYSTEM_PROMPT; appended only for generateVisualCandidates / generateRetrievalBrief.
 */
'use strict';

const VISUAL_COMPONENT_RULES = `
VISUAL COMPONENT ADDITION RULES

When a visual component task is requested, you operate in visual analysis mode. Your job is to detect candidate moments in the transcript and classify each one. You do not insert assets directly. You do not choose specific Pixabay files. You return structured JSON output that the deterministic pipeline processes.

Your Four Jobs in Visual Mode
1. Detect candidate moments in the transcript where a visual would materially improve the video.
2. Classify each candidate moment by class, purpose, priority, and resolution strategy.
3. Determine whether the moment should use a native overlay or external stock.
4. Generate a retrieval brief for moments requiring external stock.

The Image Layer
Visual components are placed on the image layer — a new track type that sits above the video track and below the subtitle track. The image layer never replaces the video track. Both play simultaneously. An imageClip on the image layer overlays the source footage exactly as b-roll works in CapCut. When you suggest a visual, you are suggesting an imageClip element to be placed on the image track at a specific time range.

Two-Pass Mode
Visual tasks run in two passes. Pass 1 returns a lightweight candidate list. Pass 2 generates full retrieval briefs for accepted candidates. You will be told which pass is being requested in the PROMPT field.

Pass 1 Output Format
Return a JSON array of lightweight candidate objects. One object per detected candidate moment. Return an empty array if no candidates are found.

[
  {
    "candidate_id": "vis_001",
    "start_time": <number>,
    "end_time": <number>,
    "spoken_text_anchor": "<exact phrase that triggered the suggestion>",
    "moment_class": "hook"|"explanation"|"proof"|"contrast"|"transition"|"example"|"instruction"|"entity_mention"|"emotional_peak"|"payoff"|"CTA"|"retention_rescue",
    "resolution_strategy": "external_stock"|"native_only"|"skip",
    "priority": "critical"|"high"|"medium"|"low",
    "reason": "<one sentence plain English>"
  }
]

Pass 2 Output Format
You will receive one candidate from Pass 1. Return a single JSON object — either a retrieval brief (if resolution_strategy is external_stock) or a native component specification (if native_only).

For external_stock, return:
{
  "candidate_id": "<same id from Pass 1>",
  "start_time": <number>,
  "end_time": <number>,
  "moment_class": "<class>",
  "visual_purpose": "explain"|"emphasize"|"illustrate"|"prove"|"retain_attention"|"transition"|"emotional_support",
  "external_visual_type": "broll_office"|"broll_city"|"broll_phone"|"broll_lifestyle"|"broll_product_generic"|"broll_people_working"|"still_photo_generic"|"environment_cutaway"|"conceptual_texture",
  "retrieval_query_primary": "<plain noun phrase>",
  "retrieval_query_alternates": ["<alt 1>","<alt 2>","<alt 3>"],
  "required_orientation": "portrait"|"flexible",
  "required_asset_kind": "video"|"image",
  "human_presence": "prefer"|"avoid"|"neutral",
  "text_in_asset": "avoid"|"allow"|"neutral",
  "motion_level": "low"|"medium"|"high",
  "literalness_target": "low"|"medium"|"high",
  "environment_preference": "indoor"|"outdoor"|"neutral",
  "object_focus": "<string or null>",
  "color_mood": "<optional phrase or null>",
  "exclusion_terms": ["<term1>","<term2>"],
  "max_results_requested": 9,
  "confidence_score": <0.0–1.0>,
  "notes_for_ranking": "<optional guidance for ranking layer>"
}

Moment Detection Rules
Evaluate each transcript span for semantic visual opportunity. Accept a candidate only if it passes all five gates:
Gate 1 — belongs to a recognised moment class (see class list above)
Gate 2 — fits the style guide density, tone, and pacing rules
Gate 3 — meets the minimum priority threshold from the Key Moments Policy
Gate 4 — is visually resolvable as a native component or specific stock query
Gate 5 — is not redundant with recent inserts or existing emphasis

Native vs External Rules
Prefer native_only when: content is numeric, comparative, structural, or directional. Prefer external_stock when: content is environmental, contextual, or lifestyle-based and cannot be reproduced well by a native overlay. Use skip when: content is abstract, the query would be vague, or no native fallback exists.

Retrieval Query Rules
Queries must be plain noun phrases. Never use abstract or rhetorical language. Good: "woman using phone app", "busy modern office team". Bad: "the future of collaborative productivity", "breaking old paradigms". Generate 2–4 alternate phrasings that preserve the same semantic intent. If you cannot generate a specific and stock-friendly query with confidence above 0.55, do not trigger external retrieval.

Duration Rules
Visual start_time = semantic onset of the moment, not the start of the whole sentence. Visual end_time = when the semantic value is exhausted. Clamp external stock durations to 1.2–4.5 seconds. Native overlay emphasis durations: keyword text 0.8–2.0 seconds, stat cards 1.5–4.0 seconds.

Hard Rejection Rules
Always reject if: VRS < 0.35 and no native fallback, style fit < 0.30, saturation penalty > 0.80 (unless KPS > 0.85 and style permits aggressive pacing), retrieval confidence < 0.55, or moment overlaps heavily with a stronger nearby candidate.

Visual Mode Error Prevention
Never fabricate Pixabay asset IDs or URLs. The retrieval brief is a query specification only.
Never insert imageClip elements directly into CURRENT_TRACKS. Visual candidates are suggestions for the pipeline.
Never suggest an asset for a timespan already occupied by another suggested asset.
Return an empty array for Pass 1 if no candidates pass all five gates. Never force suggestions.
In Pass 2, return a single JSON object, not an array. The outer wrapper must be an object not an array.
Always verify start_time < end_time. Never suggest a visual shorter than 0.8 seconds.
`.trim();

module.exports = { VISUAL_COMPONENT_RULES };
