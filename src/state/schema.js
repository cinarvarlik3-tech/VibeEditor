/**
 * src/state/schema.js
 *
 * Canonical data model for the Vibe Editor timeline state.
 * This file serves two purposes:
 *   1. Exports the initial empty timeline state as a JavaScript object.
 *   2. Living documentation for all element shapes used throughout the app.
 *
 * Loaded in Node.js via require() and in the browser via <script> tag.
 * The dual-export IIFE pattern makes it work in both environments.
 *
 * Role in project:
 *   - App.jsx initialises useReducer with initialTimelineState
 *   - timelineReducer.js uses this shape as the source of truth
 *   - server.js can require this for validation and export rendering
 */

/*
 * ARCHITECTURAL RULE — EFFECTS AND ANIMATIONS:
 *
 * Effects and animations are PROPERTIES of elements, not separate timeline tracks.
 * They live inside the element object as fields (e.g. the animation field on
 * subtitle elements, or keyframes.opacity on videoClip elements).
 *
 * When implementing new visual effects (color grading, blur, glow, etc.) in the
 * future, they must be added as fields inside the relevant element type — never
 * as a new track type or new element type on the timeline.
 *
 * This mirrors how CapCut handles effects: each clip has its own effects panel,
 * not a separate effects track.
 *
 * ARCHITECTURAL RULE — OVERLAYS AND IMAGES:
 *
 * Images and visual overlays are NOT a separate track type. When a user imports
 * an image (jpg/jpeg/png/gif/webp), the server automatically converts it to a
 * 10-second mp4 using ffmpeg. The resulting mp4 is treated identically to any
 * other video component — it becomes a videoClip element on the video track with
 * isImage: true.
 *
 * ARCHITECTURAL RULE — MULTIPLE VIDEO COMPONENTS:
 *
 * The video track holds any number of independent videoClip elements. There is no
 * limit of one. Elements are placed sequentially by default, with each clip's
 * startTime/endTime defining its position on the timeline. Gaps between clips
 * show a black frame in the preview.
 */

(function () {

  // ---------------------------------------------------------------------------
  // Initial timeline state
  // ---------------------------------------------------------------------------

  const initialTimelineState = {

    project: {
      id:        null,
      name:      'Untitled Project',
      createdAt: null,
      updatedAt: null,
    },

    source: {
      filename:   null,
      duration:   0,
      width:      1080,
      height:     1920,
      fps:        30,
      fileSize:   0,
      thumbnails: [],
    },

    tracks: {
      video: [
        {
          id:       'track_video_0',
          index:    0,
          name:     'Video 1',
          locked:   false,
          visible:  true,
          elements: [],
        },
      ],
      subtitle: [
        {
          id:       'track_sub_0',
          index:    0,
          name:     'Subtitle 1',
          locked:   false,
          visible:  true,
          elements: [],
        },
      ],
      audio: [
        {
          id:       'track_audio_0',
          index:    0,
          name:     'Audio 1',
          locked:   false,
          visible:  true,
          elements: [],
        },
      ],
    },

    history: {
      past:       [],
      future:     [],
      maxEntries: 100,
    },

    playback: {
      currentTime: 0,
      isPlaying:   false,
      duration:    0,
    },

  };

  // ---------------------------------------------------------------------------
  // Element shape reference (comments only — canonical schema documentation)
  // ---------------------------------------------------------------------------

  /*
  Track shape (all track types share this structure):
  {
    id:       string,    // e.g. "track_sub_0"
    index:    number,    // position within this type's array; 0 = bottom of stack
    name:     string,    // display label: "Subtitle 1", "Subtitle 2", etc.
    locked:   boolean,
    visible:  boolean,
    elements: Array,     // element objects of the appropriate type
  }

  videoClip element:
  {
    id:               string,
    type:             "videoClip",
    startTime:        number,            // composition time (seconds) — position on timeline
    endTime:          number,            // composition time (seconds) — position on timeline
    sourceStart:      number,            // source video cut-in point (seconds)
    sourceEnd:        number,            // source video cut-out point (seconds)
    playbackRate:     number,            // clip-level speed scalar: 1.0=normal, 2.0=2x, 0.5=half
    volume:           number,            // clip-level volume: 0.0 to 1.0
    src:              string,            // served URL: '/uploads/timestamp-filename.mp4'
    originalFilename: string|null,       // original upload name (e.g. "logo.png") — display name in timeline
    isImage:          boolean,           // true when source was jpg/png/gif/webp auto-converted to mp4
    imageDuration:    number|null,       // 10 (seconds) for image-derived clips, null otherwise
    keyframes: {
      scale:   Array<Keyframe>,          // 1.0 = 100%, e.g. 2.0 = 200% zoom
      opacity: Array<Keyframe>,          // 0.0 to 1.0
    }
    // NOTE: volume and playbackRate are clip-level scalars — NOT keyframe tracks.
    // Only scale and opacity support keyframe animation.
  }

  Keyframe shape:
  {
    time:   number,                  // local time in seconds (0 = clip start)
    value:  number,
    easing: "linear"|"ease-in"|"ease-out"|"ease-in-out"|"hold"
  }

  subtitle element:
  {
    id:        string,
    type:      "subtitle",
    startTime: number,
    endTime:   number,
    text:      string,
    style: {
      color:           string,       // hex
      fontSize:        number,       // px
      fontFamily:      string,
      fontWeight:      "normal"|"bold",
      fontStyle:       "normal"|"italic",
      textTransform:   "none"|"uppercase"|"lowercase",
      textShadow:      null|string,
      letterSpacing:   "normal"|string,
      textAlign:       "left"|"center"|"right",
      backgroundColor: string,
      padding:         number,
      borderRadius:    number,
      effect: {
        type:  "none"|"outline"|"shadow"|"glow"|"textBox",
        color: string,               // hex — meaning varies by type:
                                      //   outline → stroke color
                                      //   shadow  → shadow color
                                      //   glow    → emission color
                                      //   textBox → box background color
      },
    },
    position: {
      x:       "left"|"center"|"right"|number,   // number: -540 (left edge) → +540 (right edge), 0 = center
      y:       "top"|"center"|"bottom"|number,   // number: -960 (top edge)  → +960 (bottom edge), 0 = center
      xOffset: number,
      yOffset: number,
    },
    animation: {
      in:  { type: "none"|"fade"|"slideUp"|"slideDown"|"pop"|"typewriter"|"wordByWord", duration: number },
      out: { type: "none"|"fade"|"slideUp"|"slideDown"|"pop",                          duration: number },
    }
  }

  audioClip element:
  {
    id:        string,
    type:      "audioClip",
    startTime: number,
    endTime:   number,
    src:       string,   // uploaded: '/audio/filename.mp3'  |  external: full https:// URL
    volume:    number,   // 0.0 to 1.0
    fadeIn:    number,   // seconds, default 0
    fadeOut:   number,   // seconds, default 0
    sourceName: string,  // display name: "lo-fi-chill.mp3" or "Freesound: Rain Ambience"
    sourceType: string,  // "upload" | "freesound" | "pixabay"
  }
  */

  // ---------------------------------------------------------------------------
  // Dual export: CommonJS (Node) + browser global
  // ---------------------------------------------------------------------------

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initialTimelineState };
  }
  if (typeof window !== 'undefined') {
    window.TimelineSchema = { initialTimelineState };
  }

})();
