/**
 * VISUAL COMPONENT ADDITION RULES — verbatim policy for Pass 1 / Pass 2 visual pipeline.
 * Not part of SYSTEM_PROMPT; appended only for generateVisualCandidates / generateRetrievalBrief.
 */
'use strict';

const VISUAL_COMPONENT_RULES = `
VISUAL COMPONENT ADDITION RULES

When a visual component task is requested, you operate in visual analysis mode. Your job is to detect candidate moments in the transcript and classify each one. You do not insert assets directly. You do not choose specific Pexels files. You return structured JSON output that the deterministic pipeline processes.

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
    "reason": "<one sentence plain English>",
    "spoken_text_translation": "<English translation of spoken_text_anchor; if already English, repeat verbatim>",
    "semantic_summary": "<one sentence in English describing what is actually happening in this moment, including the emotional/narrative subtext — not just the topic>",
    "ideal_visual_description": "<2–3 sentence English description of the single best b-roll shot that would illustrate this moment; describe what is literally on screen (subjects, action, setting, framing)>",
    "concrete_subjects": ["<English noun phrase 1>", "<English noun phrase 2>", "<English noun phrase 3>"],
    "mood": "<1–4 comma-separated English adjectives, e.g. 'anxious, hurried' or 'warm, intimate'>",
    "setting_hint": "<short English phrase for location, e.g. 'classroom', 'home office', 'city street at night', or 'flexible' if ambiguous>",
    "avoid_subjects": ["<thing to avoid 1>", "<thing to avoid 2>"]
  }
]

Moment Detection Rules
Evaluate each transcript span for semantic visual opportunity. Accept a candidate only if it passes all five gates:
Gate 1 — belongs to a recognised moment class (see class list above)
Gate 2 — fits the style guide density, tone, and pacing rules
Gate 3 — meets the minimum priority threshold from the Key Moments Policy
Gate 4 — is visually resolvable as a native component or specific stock query
Gate 5 — is not redundant with recent inserts or existing emphasis

Pass 1 Interpretation Fields (required for external_stock)

You have just reasoned about this moment to classify it. Write that reasoning down. Do not leave interpretation work for Pass 2.

- spoken_text_translation: always in English. If the transcript is already English, repeat the anchor verbatim. Never leave empty.
- semantic_summary: capture the subtext, not just the topic. Bad: "the speaker talks about school." Good: "a student is falling behind because class is moving faster than they can keep up with."
- ideal_visual_description: describe what the screen should literally show — subjects, action, setting, framing. This is the single most important field for downstream retrieval quality. Write it as if directing a cinematographer, not writing a headline.
- concrete_subjects: 3 to 6 plain English noun phrases drawn from ideal_visual_description. These are the candidate search terms.
- mood: the emotional register, in adjectives. Affects which asset feels right even when the subject matches.
- setting_hint: where this takes place, or "flexible" if the moment is not location-specific.
- avoid_subjects: things that are topically adjacent but would undermine the moment. Example: if the moment is about a student struggling, avoid "smiling students," "classroom celebration," "cartoon teacher." Always include at least one entry; use ["cartoon illustration"] as a safe default when nothing specific applies.

These fields must be written in English even when the transcript is in another language. Translate first, interpret second, then fill the fields.

Example — non-English input

TRANSCRIPT (excerpt): "Okul ve dershane de çok hızlı ilerliyor" at 2.8s–4.5s
Output entry:
{
  "candidate_id": "vis_002",
  "start_time": 2.8,
  "end_time": 4.5,
  "spoken_text_anchor": "Okul ve dershane de çok hızlı ilerliyor",
  "spoken_text_translation": "School and tutoring center are moving too fast",
  "moment_class": "contrast",
  "resolution_strategy": "external_stock",
  "priority": "high",
  "reason": "Describes a pace mismatch between instruction speed and the student's comprehension.",
  "semantic_summary": "A student cannot keep up as teachers race through new material in both school and after-school tutoring.",
  "ideal_visual_description": "An overwhelmed student sits at a desk looking down at a notebook, brow furrowed, while in the background a teacher writes rapidly across a crowded whiteboard. Medium shot, natural classroom light, shallow focus on the student.",
  "concrete_subjects": ["overwhelmed student at desk", "teacher writing fast on whiteboard", "student taking hurried notes", "confused student in classroom"],
  "mood": "anxious, hurried, quietly stressed",
  "setting_hint": "classroom or tutoring center",
  "avoid_subjects": ["smiling students", "classroom celebration", "cartoon illustration", "stock teacher posing"]
}

Pass 2 Output Format
You will receive one candidate from Pass 1. Return a single JSON object — either a retrieval brief (if resolution_strategy is external_stock) or a native component specification (if native_only).

Pass 2 — Packaging, not interpretation

Pass 1 has already interpreted the moment. Your job in Pass 2 is to package that interpretation into Pexels-friendly search terms and retrieval filters. Do not re-interpret the transcript. Do not invent new subject matter. Do not paraphrase ideal_visual_description into something vaguer.

Source of truth, in priority order:
1. candidate.ideal_visual_description — the literal description of what should be on screen.
2. candidate.concrete_subjects — your primary source of query terms. Pick the one or two that will have the best Pexels coverage.
3. candidate.mood and candidate.setting_hint — modifiers on the query and on environment_preference.
4. candidate.avoid_subjects — copy into exclusion_terms as-is, then add any stock-specific additions (e.g. "cartoon", "illustration", "3d render") if the moment demands photographic realism.
5. TRANSCRIPT_CONTEXT — use only to resolve ambiguity (e.g. if concrete_subjects is "student" but context reveals it is a university lecture, prefer "university student"). Never use as a primary source.

Query construction rules:
- retrieval_query_primary must be a plain English noun phrase of 3–6 words drawn from concrete_subjects, optionally narrowed by setting_hint.
- retrieval_query_alternates must be 2–3 *meaningfully different* phrasings, not synonyms. Vary the subject focus (e.g. primary focuses on the student, alternate 1 focuses on the teacher, alternate 2 focuses on the environment). If you cannot produce meaningfully different alternates, lower confidence_score.
- If concrete_subjects are missing or the moment is native_only or skip, do not emit a retrieval brief.

Confidence calibration:
- 0.85+: ideal_visual_description is specific, concrete_subjects are clearly stock-friendly, setting is well-defined.
- 0.65–0.84: subjects are clear but the mood or setting introduces risk of off-target results.
- 0.55–0.64: subjects are generic or the ideal description leans abstract. Consider whether native_only would serve better.
- <0.55: do not emit. Return a brief with confidence_score below 0.55 and the server will reject it; the UI will surface "confidence too low" and the user will fall back to native.

SEARCH QUERY GENERATION — CRITICAL:
You must also generate a searchQuery field for each candidate. This query will be sent
directly to the Pexels stock API. Pexels indexes content by the titles photographers give
their photos and videos. These titles follow a strict, consistent grammar. Your searchQuery
MUST match this grammar exactly or results will be poor.

PEXELS TITLE GRAMMAR:
  [Relationship noun] [present-participle verb] [object or second person] [optional: "at/on/in" + concrete location noun]

RULES — follow every one without exception:

1. RELATIONSHIP NOUNS ONLY — never generic roles
   Use: Mother, Father, Son, Daughter, Brother, Sister, Grandmother, Grandfather,
        Woman, Man, Girl, Boy, Person, People, Family, Couple, Teacher, Student
   Never use: parent, child, adult, individual, someone, figure, subject

2. ONE PRIMARY ACTION — present participle, one verb only
   Good: "Reviewing", "Writing", "Reading", "Sitting", "Looking at", "Helping",
         "Teaching", "Drawing", "Studying", "Working on"
   Never include two actions joined with "and" on the subject side

3. CONCRETE LOCATION NOUNS ONLY — if you include a setting at all
   Good: "at the Kitchen Table", "at a Desk", "on the Couch", "in the Living Room"
   Never use: "in a domestic setting", "in a home environment", "in a warm space"

4. STRIP ALL OF THE FOLLOWING completely — they score zero in Pexels' index:
   - Emotion and mood words: worried, concerned, stressed, joyful, tense, loving
   - Cinematographic language: medium framing, close-up, shot, scene, framing, angle
   - Atmosphere words: warm, cozy, authentic, real, natural, candid
   - Adverbs: slightly, carefully, gently, intently
   - Possessives in descriptions: "child's materials", "her belongings" → drop the prop, keep the action

5. LENGTH: 5–9 words. No more, no less.

6. TITLE CASE: Capitalize every meaningful word.

7. GENDER: If the brief specifies or implies a gender, use the gendered noun.
   If gender is unspecified, prefer "Mother" over "Parent", "Father" over "Parent".
   If truly ambiguous, use "Person" or "Woman"/"Man" based on the most statistically
   likely photographer framing for that scenario.

8. SINGLE SUBJECT RULE: If the scene has two people, the title should still lead with
   one primary subject and treat the second as the object.
   Good: "Mother Helping Son with Homework at Table"
   Bad: "Mother and Son Both Doing Homework Together"

VALIDATION — before emitting searchQuery, check:
  ✓ Does it contain any word from the banned list? → rewrite
  ✓ Is it between 5 and 9 words? → trim or expand
  ✓ Does it start with a relationship/role noun? → if not, rewrite
  ✓ Is there exactly one present-participle verb? → if not, rewrite
  ✓ Is every word something a photographer would type when uploading a stock photo? → if not, remove it

EXAMPLES (brief → searchQuery):
  "A worried parent sits at a kitchen table reviewing a child's schoolwork and report card,
   with notebooks, a pencil case, and a phone nearby. The shot should feel like a real home
   study scene, medium framing, with the parent looking concerned."
  → "Mother Reviewing Daughter's Homework at Kitchen Table"

  "An elderly person sits alone by a window, light coming in from the side, looking
   contemplative and slightly melancholy. Soft focus background."
  → "Elderly Woman Sitting Alone by Window"

  "Two friends laugh together on a city street, one pointing at something off camera,
   both in casual clothes. Candid, energetic feel."
  → "Two Friends Laughing Together on Street"

  "A person types urgently at a laptop in what looks like a home office late at night,
   with papers around them and a coffee cup nearby. Stressed atmosphere."
  → "Man Working on Laptop at Home Office"

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
  "searchQuery": "<5–9 words, Title Case, Pexels title grammar; sent verbatim to the Pexels search API>",
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

Example Pass 2 output (for the Turkish moment above):
{
  "candidate_id": "vis_002",
  "start_time": 2.8,
  "end_time": 4.5,
  "moment_class": "contrast",
  "visual_purpose": "illustrate",
  "external_visual_type": "broll_people_working",
  "retrieval_query_primary": "overwhelmed student taking notes classroom",
  "retrieval_query_alternates": [
    "teacher writing fast on whiteboard",
    "confused student at desk tutoring center"
  ],
  "searchQuery": "Student Studying at Desk in Classroom",
  "required_orientation": "portrait",
  "required_asset_kind": "video",
  "human_presence": "prefer",
  "text_in_asset": "avoid",
  "motion_level": "medium",
  "literalness_target": "high",
  "environment_preference": "indoor",
  "object_focus": "notebook",
  "color_mood": "cool, natural classroom light",
  "exclusion_terms": ["cartoon", "illustration", "3d render", "smiling students", "celebration"],
  "max_results_requested": 9,
  "confidence_score": 0.82,
  "notes_for_ranking": "prefer shots with a visible student in foreground over shots of empty classrooms"
}

Native vs External Rules
Prefer native_only when: content is numeric, comparative, structural, or directional. Prefer external_stock when: content is environmental, contextual, or lifestyle-based and cannot be reproduced well by a native overlay. Use skip when: content is abstract, the query would be vague, or no native fallback exists.

Retrieval Query Rules
Queries must be plain noun phrases. Never use abstract or rhetorical language. Good: "woman using phone app", "busy modern office team". Bad: "the future of collaborative productivity", "breaking old paradigms". Generate 2–4 alternate phrasings that preserve the same semantic intent. If you cannot generate a specific and stock-friendly query with confidence above 0.55, do not trigger external retrieval.

Duration Rules
Visual start_time = semantic onset of the moment, not the start of the whole sentence. Visual end_time = when the semantic value is exhausted. Clamp external stock durations to 1.2–4.5 seconds. Native overlay emphasis durations: keyword text 0.8–2.0 seconds, stat cards 1.5–4.0 seconds.

Hard Rejection Rules
Always reject if: VRS < 0.35 and no native fallback, style fit < 0.30, saturation penalty > 0.80 (unless KPS > 0.85 and style permits aggressive pacing), retrieval confidence < 0.55, or moment overlaps heavily with a stronger nearby candidate.

Visual Mode Error Prevention
Never fabricate Pexels asset IDs or URLs. The retrieval brief is a query specification only.
Never insert imageClip elements directly into CURRENT_TRACKS. Visual candidates are suggestions for the pipeline.
Never suggest an asset for a timespan already occupied by another suggested asset.
Return an empty array for Pass 1 if no candidates pass all five gates. Never force suggestions.
In Pass 2, return a single JSON object, not an array. The outer wrapper must be an object not an array.
Always verify start_time < end_time. Never suggest a visual shorter than 0.8 seconds.
In Pass 1, never emit external_stock candidates without populating spoken_text_translation, semantic_summary, ideal_visual_description, concrete_subjects, mood, setting_hint, and avoid_subjects. If you cannot fill these confidently, downgrade to native_only or skip.
In Pass 1, write all interpretation fields (semantic_summary, ideal_visual_description, concrete_subjects, mood, setting_hint, avoid_subjects) in English regardless of the transcript language.
In Pass 2, do not produce a retrieval_query_primary that contradicts ideal_visual_description or that mentions subjects listed in avoid_subjects.
In Pass 2, retrieval_query_primary and each alternate must be pure noun phrases with no verbs in gerund form longer than one word (e.g. "woman writing" is fine; "woman who is writing on the board" is not).
`.trim();

module.exports = { VISUAL_COMPONENT_RULES };
