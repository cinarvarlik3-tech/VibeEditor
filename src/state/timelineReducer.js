/**
 * src/state/timelineReducer.js
 *
 * Central state machine for the Vibe Editor timeline.
 * All state changes — whether from user interaction or AI operations —
 * flow through this reducer.
 *
 * Loaded in Node.js via require() and in the browser via <script> tag.
 * The dual-export IIFE pattern makes it work in both environments.
 *
 * Action types handled:
 *   LOAD_SOURCE, APPLY_OPERATIONS, MOVE_ELEMENT, UPDATE_ELEMENT,
 *   DELETE_ELEMENT, SPLIT_ELEMENT, DELETE_TRACK, UNDO, REDO, UNDO_LAST_PROMPT,
 *   SET_PLAYBACK_TIME, TOGGLE_PLAYBACK,
 *   SET_TRACK_VISIBILITY, SET_TRACK_LOCKED, REORDER_TRACK
 *
 * Operations handled inside APPLY_OPERATIONS (via applyOperation):
 *   CREATE, UPDATE, DELETE, CREATE_TRACK, DELETE_TRACK, BATCH_CREATE,
 *   ADD_KEYFRAME, UPDATE_KEYFRAME, DELETE_KEYFRAME, REORDER_TRACK
 *
 * Exported helpers:
 *   generateId, deepClone, applyDotNotation,
 *   findElementById, findTrackById
 */

(function () {

  // ---------------------------------------------------------------------------
  // Helper utilities
  // ---------------------------------------------------------------------------

  /**
   * generateId
   * Returns a unique id string with a human-readable prefix.
   *
   * @param {string} prefix  e.g. "elem_s", "track_sub"
   * @returns {string}
   */
  function generateId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  }

  /**
   * deepClone
   * Returns a deep copy of any JSON-serialisable object.
   *
   * @param {*} obj
   * @returns {*}
   */
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * applyDotNotation
   * Sets a nested property on obj using a dot-notation path string.
   * Mutates a clone — always pass a cloned object.
   *
   * @param {object} obj       Target object (will be mutated)
   * @param {string} dotPath   e.g. "style.fontSize"
   * @param {*}      value     Value to set
   * @returns {object}         The mutated object (same reference)
   */
  function applyDotNotation(obj, dotPath, value) {
    const keys = dotPath.split('.');
    let cursor = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cursor[keys[i]] === undefined || cursor[keys[i]] === null) {
        cursor[keys[i]] = {};
      }
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
    return obj;
  }

  /**
   * findElementById
   * Searches all tracks for an element with the given id.
   *
   * @param {object} tracks     The tracks object from timeline state
   * @param {string} elementId
   * @returns {{ element, track, trackType } | null}
   */
  function findElementById(tracks, elementId) {
    const trackTypes = Object.keys(tracks);
    for (const trackType of trackTypes) {
      for (const track of tracks[trackType]) {
        for (const element of track.elements) {
          if (element.id === elementId) {
            return { element, track, trackType };
          }
        }
      }
    }
    return null;
  }

  /**
   * findTrackById
   * Searches all track type arrays for a track with the given id.
   *
   * @param {object} tracks   The tracks object from timeline state
   * @param {string} trackId
   * @returns {{ track, trackType } | null}
   */
  function findTrackById(tracks, trackId) {
    const trackTypes = Object.keys(tracks);
    for (const trackType of trackTypes) {
      for (const track of tracks[trackType]) {
        if (track.id === trackId) {
          return { track, trackType };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Track type display labels (used when auto-naming new tracks)
  // ---------------------------------------------------------------------------

  var TRACK_TYPE_LABELS = {
    video:    'Video',
    subtitle: 'Subtitle',
    audio:    'Audio',
  };

  // Valid track types — effect and overlay are no longer supported
  var VALID_TRACK_TYPES = new Set(['video', 'subtitle', 'audio']);

  // ---------------------------------------------------------------------------
  // History helpers
  // ---------------------------------------------------------------------------

  /**
   * pushHistory
   * Appends a snapshot of current tracks to history.past.
   * Clears history.future on any new action (except UNDO/REDO).
   * Trims past to maxEntries.
   *
   * @param {object}  history        Current history slice
   * @param {object}  tracks         Current tracks slice (will be deep-cloned)
   * @param {boolean} isPromptCheckpoint
   * @param {string}  description
   * @returns {object}               New history object
   */
  function pushHistory(history, tracks, isPromptCheckpoint, description) {
    const entry = {
      snapshot:           deepClone(tracks),
      isPromptCheckpoint: isPromptCheckpoint,
      description:        description || '',
      timestamp:          Date.now(),
    };

    let past = [...history.past, entry];
    if (past.length > history.maxEntries) {
      past = past.slice(past.length - history.maxEntries);
    }

    return {
      ...history,
      past:   past,
      future: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Operation applicator (used by APPLY_OPERATIONS)
  // ---------------------------------------------------------------------------

  /**
   * applyOperation
   * Applies a single operation object to a deep-cloned tracks object.
   * Mutates tracks in place — always pass a clone.
   *
   * Supported ops: CREATE, UPDATE, DELETE, CREATE_TRACK, DELETE_TRACK, BATCH_CREATE
   *
   * @param {object} tracks     Cloned tracks object
   * @param {object} operation  { op, ...params }
   * @returns {object}          Mutated tracks
   */
  function applyOperation(tracks, operation) {
    switch (operation.op) {

      case 'CREATE': {
        const result = findTrackById(tracks, operation.trackId);
        if (!result) {
          console.warn('APPLY_OPERATIONS CREATE: trackId not found:', operation.trackId);
          break;
        }
        result.track.elements.push(deepClone(operation.element));
        break;
      }

      case 'UPDATE': {
        const result = findElementById(tracks, operation.elementId);
        if (!result) {
          console.warn('APPLY_OPERATIONS UPDATE: elementId not found:', operation.elementId);
          break;
        }
        const changes = operation.changes || {};
        for (const [dotPath, value] of Object.entries(changes)) {
          applyDotNotation(result.element, dotPath, value);
        }
        break;
      }

      case 'DELETE': {
        const result = findElementById(tracks, operation.elementId);
        if (!result) {
          console.warn('APPLY_OPERATIONS DELETE: elementId not found:', operation.elementId);
          break;
        }
        result.track.elements = result.track.elements.filter(
          e => e.id !== operation.elementId
        );
        break;
      }

      case 'CREATE_TRACK': {
        const trackType = operation.trackType;
        if (!VALID_TRACK_TYPES.has(trackType)) {
          console.warn('APPLY_OPERATIONS CREATE_TRACK: invalid trackType "' + trackType + '" — only video, subtitle, audio are supported');
          break;
        }
        if (!tracks[trackType]) {
          console.warn('APPLY_OPERATIONS CREATE_TRACK: trackType array not found:', trackType);
          break;
        }
        const existingCount = tracks[trackType].length;
        const typeLabel = TRACK_TYPE_LABELS[trackType] || trackType;
        tracks[trackType].push({
          id:       generateId('track_' + trackType.charAt(0)),
          index:    existingCount,
          name:     typeLabel + ' ' + (existingCount + 1),
          locked:   false,
          visible:  true,
          elements: [],
        });
        break;
      }

      case 'DELETE_TRACK': {
        const result = findTrackById(tracks, operation.trackId);
        if (!result) {
          console.warn('APPLY_OPERATIONS DELETE_TRACK: trackId not found:', operation.trackId);
          break;
        }
        if (result.track.elements.length > 0) {
          console.warn('APPLY_OPERATIONS DELETE_TRACK: track has elements, skipping');
          break;
        }
        if (tracks[result.trackType].length <= 1) {
          console.warn('APPLY_OPERATIONS DELETE_TRACK: cannot delete last track of type', result.trackType);
          break;
        }
        tracks[result.trackType] = tracks[result.trackType].filter(
          t => t.id !== operation.trackId
        );
        tracks[result.trackType].forEach(function(t, i) { t.index = i; });
        break;
      }

      case 'BATCH_CREATE': {
        const result = findTrackById(tracks, operation.trackId);
        if (!result) {
          console.warn('APPLY_OPERATIONS BATCH_CREATE: trackId not found:', operation.trackId);
          break;
        }
        const template = operation.template || {};
        const elements = operation.elements || [];
        for (const elem of elements) {
          const fullElement = { ...deepClone(template), ...elem };
          result.track.elements.push(fullElement);
        }
        break;
      }

      // ── ADD_KEYFRAME ─────────────────────────────────────────────────────
      // Appends a keyframe to a named track on an element's keyframes object.
      // Keeps the track array sorted by time after insertion.
      // Only scale and opacity are keyframe-animated; speed/volume are clip-level scalars.
      case 'ADD_KEYFRAME': {
        var addResult = findElementById(tracks, operation.elementId);
        if (!addResult) {
          console.warn('ADD_KEYFRAME: elementId not found:', operation.elementId);
          break;
        }
        var addTrack = operation.trackName;
        if (addTrack === 'speed' || addTrack === 'volume') {
          console.warn('ADD_KEYFRAME: "' + addTrack + '" is a clip-level scalar; use UPDATE_ELEMENT instead');
          break;
        }
        var addKf    = operation.keyframe;
        if (!addResult.element.keyframes)             addResult.element.keyframes = {};
        if (!addResult.element.keyframes[addTrack])   addResult.element.keyframes[addTrack] = [];
        addResult.element.keyframes[addTrack].push(deepClone(addKf));
        addResult.element.keyframes[addTrack].sort(function (a, b) { return a.time - b.time; });
        break;
      }

      // ── UPDATE_KEYFRAME ───────────────────────────────────────────────────
      // Merges changes into an existing keyframe at the given index, then
      // re-sorts the track by time in case the time field was changed.
      case 'UPDATE_KEYFRAME': {
        var updResult = findElementById(tracks, operation.elementId);
        if (!updResult) {
          console.warn('UPDATE_KEYFRAME: elementId not found:', operation.elementId);
          break;
        }
        var updTrack = operation.trackName;
        if (updTrack === 'speed' || updTrack === 'volume') {
          console.warn('UPDATE_KEYFRAME: "' + updTrack + '" is a clip-level scalar; use UPDATE_ELEMENT instead');
          break;
        }
        var updIdx   = operation.index;
        var updArr   = updResult.element.keyframes && updResult.element.keyframes[updTrack];
        if (!updArr) { console.warn('UPDATE_KEYFRAME: trackName not found:', updTrack); break; }
        if (updIdx < 0 || updIdx >= updArr.length) { console.warn('UPDATE_KEYFRAME: index out of bounds:', updIdx); break; }
        Object.assign(updArr[updIdx], operation.changes);
        updArr.sort(function (a, b) { return a.time - b.time; });
        break;
      }

      // ── DELETE_KEYFRAME ───────────────────────────────────────────────────
      // Removes a keyframe by index. If the track becomes empty, restores a
      // single default keyframe so the element always has at least one value.
      case 'DELETE_KEYFRAME': {
        var KFDEFAULTS = { scale: 1.0, opacity: 1.0 };
        var delResult  = findElementById(tracks, operation.elementId);
        if (!delResult) {
          console.warn('DELETE_KEYFRAME: elementId not found:', operation.elementId);
          break;
        }
        var delTrack = operation.trackName;
        if (delTrack === 'speed' || delTrack === 'volume') {
          console.warn('DELETE_KEYFRAME: "' + delTrack + '" is a clip-level scalar; use UPDATE_ELEMENT instead');
          break;
        }
        var delIdx   = operation.index;
        var delArr   = delResult.element.keyframes && delResult.element.keyframes[delTrack];
        if (!delArr) { console.warn('DELETE_KEYFRAME: trackName not found:', delTrack); break; }
        if (delIdx < 0 || delIdx >= delArr.length) { console.warn('DELETE_KEYFRAME: index out of bounds:', delIdx); break; }
        delArr.splice(delIdx, 1);
        if (delArr.length === 0) {
          delArr.push({ time: 0, value: KFDEFAULTS[delTrack] !== undefined ? KFDEFAULTS[delTrack] : 1.0, easing: 'linear' });
        }
        break;
      }

      // ── REORDER_TRACK ─────────────────────────────────────────────────────
      // Allows Claude to reorder tracks within a type as part of an operation
      // sequence (e.g. CREATE_TRACK followed by REORDER_TRACK for positioning).
      case 'REORDER_TRACK': {
        var rTrackType = operation.trackType;
        if (!tracks[rTrackType]) {
          console.warn('APPLY_OPERATIONS REORDER_TRACK: unknown trackType:', rTrackType);
          break;
        }
        var rArr  = tracks[rTrackType];
        var rFrom = operation.fromIndex;
        var rTo   = operation.toIndex;
        if (rFrom === rTo) break;
        if (rFrom < 0 || rFrom >= rArr.length) break;
        var rClampedTo = Math.max(0, Math.min(rArr.length - 1, rTo));
        var rRemoved = rArr.splice(rFrom, 1)[0];
        rArr.splice(rClampedTo, 0, rRemoved);
        rArr.forEach(function(t, i) { t.index = i; });
        break;
      }

      default:
        console.warn('APPLY_OPERATIONS: unknown op:', operation.op);
    }

    return tracks;
  }

  // ---------------------------------------------------------------------------
  // getDerivedDuration
  // ---------------------------------------------------------------------------

  /**
   * getDerivedDuration
   * Returns the maximum endTime across all elements in all tracks.
   * Used to dynamically extend playback.duration as clips are added.
   *
   * @param {object} tracks  The tracks object from timeline state
   * @returns {number}       Maximum endTime, or 0 if all tracks are empty
   */
  function getDerivedDuration(tracks) {
    let max = 0;
    const trackTypes = Object.keys(tracks);
    for (const trackType of trackTypes) {
      for (const track of tracks[trackType]) {
        for (const element of track.elements) {
          if (element.endTime > max) max = element.endTime;
        }
      }
    }
    return max;
  }

  // ---------------------------------------------------------------------------
  // Main reducer
  // ---------------------------------------------------------------------------

  /**
   * timelineReducer
   * Pure function. Takes current state + action, returns new state.
   *
   * @param {object} state   Current timeline state
   * @param {object} action  { type: string, payload?: object }
   * @returns {object}       New timeline state
   */
  function timelineReducer(state, action) {
    switch (action.type) {

      // ── LOAD_SOURCE ────────────────────────────────────────────────────────
      // Sets source metadata only. Does NOT create or modify any track elements.
      // Video components are added separately via APPLY_OPERATIONS CREATE.
      // ── UPDATE_PROJECT_NAME ──────────────────────────────────────────────────
      case 'UPDATE_PROJECT_NAME': {
        return {
          ...state,
          project: {
            ...state.project,
            name:      action.payload.name,
            updatedAt: new Date().toISOString(),
          },
        };
      }

      case 'LOAD_SOURCE': {
        const p = action.payload;

        const newHistory = pushHistory(
          state.history,
          state.tracks,
          false,
          'Load source'
        );

        // Keep duration as max of derived timeline duration and source duration,
        // so the ruler always shows at least the source file length.
        const derivedDuration = getDerivedDuration(state.tracks);
        const newDuration = Math.max(derivedDuration, p.duration || 0);

        return {
          ...state,
          project: {
            ...state.project,
            id:        state.project.id || String(Date.now()),
            createdAt: state.project.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          source: {
            filename:   p.filename   || null,
            duration:   p.duration   || 0,
            width:      p.width      || 1080,
            height:     p.height     || 1920,
            fps:        p.fps        || 30,
            fileSize:   p.fileSize   || 0,
            thumbnails: p.thumbnails || [],
          },
          history:  newHistory,
          playback: {
            ...state.playback,
            duration: newDuration,
          },
        };
      }

      // ── APPLY_OPERATIONS ───────────────────────────────────────────────────
      // AI action. Applies an array of operations atomically.
      case 'APPLY_OPERATIONS': {
        const { operations = [], promptText = null } = action.payload || {};

        let newTracks = deepClone(state.tracks);
        // Track IDs assigned by CREATE_TRACK so subsequent ops can use "new:{trackType}"
        var newTrackIds = {};
        for (const op of operations) {
          // Resolve "new:{trackType}" trackId to the most recently created track of that type
          if (op.trackId && typeof op.trackId === 'string' && op.trackId.startsWith('new:')) {
            var resolveType = op.trackId.replace('new:', '');
            if (newTrackIds[resolveType]) {
              op.trackId = newTrackIds[resolveType];
            }
          }
          newTracks = applyOperation(newTracks, op);
          // After CREATE_TRACK, capture the new track's ID for "new:" resolution
          if (op.op === 'CREATE_TRACK' && newTracks[op.trackType]) {
            var createdArr = newTracks[op.trackType];
            newTrackIds[op.trackType] = createdArr[createdArr.length - 1].id;
          }
        }

        const description = promptText
          || (operations.length > 0
            ? operations[0].op + ' (' + operations.length + ' ops)'
            : 'No-op');

        const newHistory = pushHistory(
          state.history,
          state.tracks,
          promptText !== null,
          description
        );

        const newDuration = Math.max(getDerivedDuration(newTracks), state.source.duration || 0);

        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
          playback: {
            ...state.playback,
            duration: newDuration,
          },
        };
      }

      // ── MOVE_ELEMENT ───────────────────────────────────────────────────────
      // Moves an element to a new time range, optionally to a different track.
      case 'MOVE_ELEMENT': {
        const { elementId, newStartTime, newEndTime, newTrackId } = action.payload;

        const newTracks = deepClone(state.tracks);
        const result = findElementById(newTracks, elementId);
        if (!result) return state;

        const duration = result.element.endTime - result.element.startTime;

        if (newTrackId && newTrackId !== result.track.id) {
          // Move to a different track
          let targetTrack = findTrackById(newTracks, newTrackId);

          // C1: Prevent cross-type moves (e.g. videoClip onto subtitle track)
          if (targetTrack && targetTrack.trackType !== result.trackType) {
            console.warn('MOVE_ELEMENT: cannot move element to a different track type');
            return state;
          }

          result.track.elements = result.track.elements.filter(e => e.id !== elementId);

          if (!targetTrack) {
            // Create a new track of the same type if needed
            const trackType = result.trackType;
            const existingCount = newTracks[trackType].length;
            const newTrack = {
              id:       newTrackId,
              index:    existingCount,
              locked:   false,
              visible:  true,
              elements: [],
            };
            newTracks[trackType].push(newTrack);
            targetTrack = { track: newTrack, trackType };
          }

          const movedElement = { ...result.element };
          movedElement.startTime = newStartTime !== undefined ? newStartTime : movedElement.startTime;
          movedElement.endTime   = newEndTime   !== undefined ? newEndTime   : movedElement.startTime + duration;
          targetTrack.track.elements.push(movedElement);
          // C2: sort by startTime after cross-track move
          targetTrack.track.elements.sort((a, b) => a.startTime - b.startTime);
        } else {
          // Same track — update times only
          result.element.startTime = newStartTime !== undefined ? newStartTime : result.element.startTime;
          result.element.endTime   = newEndTime   !== undefined ? newEndTime   : result.element.startTime + duration;
        }

        const newHistory = pushHistory(state.history, state.tracks, false, 'Move element');

        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
          playback: { ...state.playback, duration: Math.max(getDerivedDuration(newTracks), state.source.duration || 0) },
        };
      }

      // ── UPDATE_ELEMENT ─────────────────────────────────────────────────────
      // Human-initiated property edit via the Properties panel.
      case 'UPDATE_ELEMENT': {
        const { elementId, changes } = action.payload;

        const newTracks = deepClone(state.tracks);
        const result = findElementById(newTracks, elementId);
        if (!result) return state;

        for (const [dotPath, value] of Object.entries(changes)) {
          applyDotNotation(result.element, dotPath, value);
        }

        const newHistory = pushHistory(state.history, state.tracks, false, 'Update element');

        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
        };
      }

      // ── DELETE_ELEMENT ─────────────────────────────────────────────────────
      case 'DELETE_ELEMENT': {
        const { elementId } = action.payload;

        const newTracks = deepClone(state.tracks);
        const result = findElementById(newTracks, elementId);
        if (!result) return state;

        result.track.elements = result.track.elements.filter(e => e.id !== elementId);

        const newHistory = pushHistory(state.history, state.tracks, false, 'Delete element');

        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
          playback: { ...state.playback, duration: Math.max(getDerivedDuration(newTracks), state.source.duration || 0) },
        };
      }

      // ── UNDO ───────────────────────────────────────────────────────────────
      case 'UNDO': {
        if (state.history.past.length === 0) return state;

        const past   = [...state.history.past];
        const entry  = past.pop();
        // Preserve isPromptCheckpoint in the future entry so UNDO_LAST_PROMPT
        // remains functional after an UNDO → REDO cycle.
        const future = [{
          snapshot:           deepClone(state.tracks),
          isPromptCheckpoint: entry.isPromptCheckpoint,
          description:        entry.description,
          timestamp:          Date.now(),
        }, ...state.history.future];

        const newTracks = deepClone(entry.snapshot);
        const undoDuration = Math.max(getDerivedDuration(newTracks), state.source.duration || 0);

        return {
          ...state,
          tracks:  newTracks,
          history: { ...state.history, past, future },
          playback: {
            ...state.playback,
            duration: undoDuration,
          },
        };
      }

      // ── REDO ───────────────────────────────────────────────────────────────
      case 'REDO': {
        if (state.history.future.length === 0) return state;

        const future = [...state.history.future];
        const entry  = future.shift();
        // Preserve isPromptCheckpoint so UNDO_LAST_PROMPT can find it after a REDO cycle.
        const past   = [...state.history.past, {
          snapshot:           deepClone(state.tracks),
          isPromptCheckpoint: entry.isPromptCheckpoint,
          description:        entry.description,
          timestamp:          Date.now(),
        }];

        const redoTracks = deepClone(entry.snapshot);
        const redoDuration = Math.max(getDerivedDuration(redoTracks), state.source.duration || 0);

        return {
          ...state,
          tracks:  redoTracks,
          history: { ...state.history, past, future },
          playback: {
            ...state.playback,
            duration: redoDuration,
          },
        };
      }

      // ── UNDO_LAST_PROMPT ───────────────────────────────────────────────────
      // Rolls back to the state immediately before the most recent AI prompt.
      case 'UNDO_LAST_PROMPT': {
        const past = state.history.past;
        if (past.length === 0) return state;

        // Find the most recent prompt checkpoint (searching newest → oldest)
        let checkpointIndex = -1;
        for (let i = past.length - 1; i >= 0; i--) {
          if (past[i].isPromptCheckpoint) {
            checkpointIndex = i;
            break;
          }
        }
        if (checkpointIndex === -1) return state;

        // Restore to the snapshot that existed BEFORE the checkpoint was pushed.
        // That snapshot lives at checkpointIndex - 1.
        // If the checkpoint is the very first entry, restore initial tracks via
        // the snapshot stored in the entry itself (which captured the pre-prompt state).
        const restoreSnapshot = checkpointIndex > 0
          ? past[checkpointIndex - 1].snapshot
          : past[checkpointIndex].snapshot;

        // Entries from checkpointIndex onward move to future (reversed for REDO)
        const newFuture = past
          .slice(checkpointIndex)
          .reverse()
          .map(e => ({ ...e, isPromptCheckpoint: false }));

        const newPast = past.slice(0, checkpointIndex);

        return {
          ...state,
          tracks:  deepClone(restoreSnapshot),
          history: { ...state.history, past: newPast, future: newFuture },
        };
      }

      // ── SET_PLAYBACK_TIME ──────────────────────────────────────────────────
      case 'SET_PLAYBACK_TIME': {
        return {
          ...state,
          playback: { ...state.playback, currentTime: action.payload.currentTime },
        };
      }

      // ── TOGGLE_PLAYBACK ────────────────────────────────────────────────────
      case 'TOGGLE_PLAYBACK': {
        return {
          ...state,
          playback: { ...state.playback, isPlaying: !state.playback.isPlaying },
        };
      }

      // ── SET_TRACK_VISIBILITY ───────────────────────────────────────────────
      case 'SET_TRACK_VISIBILITY': {
        const { trackId, visible } = action.payload;
        const newTracks = deepClone(state.tracks);
        const result = findTrackById(newTracks, trackId);
        if (!result) return state;
        result.track.visible = visible;

        const newHistory = pushHistory(state.history, state.tracks, false, 'Set track visibility');
        return { ...state, tracks: newTracks, history: newHistory };
      }

      // ── SET_TRACK_LOCKED ───────────────────────────────────────────────────
      case 'SET_TRACK_LOCKED': {
        const { trackId, locked } = action.payload;
        const newTracks = deepClone(state.tracks);
        const result = findTrackById(newTracks, trackId);
        if (!result) return state;
        result.track.locked = locked;

        const newHistory = pushHistory(state.history, state.tracks, false, 'Set track locked');
        return { ...state, tracks: newTracks, history: newHistory };
      }

      // ── REORDER_TRACK ──────────────────────────────────────────────────────
      // Moves a track within its type array, re-assigns index fields, undoable.
      case 'REORDER_TRACK': {
        const { trackType, fromIndex, toIndex } = action.payload;
        if (!state.tracks[trackType]) return state;

        const newTracks = deepClone(state.tracks);
        const arr = newTracks[trackType];

        if (fromIndex === toIndex) return state;
        if (fromIndex < 0 || fromIndex >= arr.length) return state;
        const clampedTo = Math.max(0, Math.min(arr.length - 1, toIndex));

        const [removed] = arr.splice(fromIndex, 1);
        arr.splice(clampedTo, 0, removed);

        // Re-assign index fields to match new array positions
        arr.forEach((track, i) => { track.index = i; });

        const newHistory = pushHistory(state.history, state.tracks, false, 'Reorder track');
        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
        };
      }

      // ── DELETE_TRACK ───────────────────────────────────────────────────────
      // Human-initiated track deletion from the Timeline UI.
      // Guards: track must be empty, and must not be the last of its type.
      case 'DELETE_TRACK': {
        const { trackId } = action.payload;
        const newTracks = deepClone(state.tracks);
        const result = findTrackById(newTracks, trackId);
        if (!result) return state;
        if (result.track.elements.length > 0) return state;
        if (newTracks[result.trackType].length <= 1) return state;

        newTracks[result.trackType] = newTracks[result.trackType].filter(
          t => t.id !== trackId
        );
        newTracks[result.trackType].forEach(function(t, i) { t.index = i; });

        const newHistory = pushHistory(
          state.history, state.tracks, false,
          'Deleted empty track ' + trackId
        );
        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
        };
      }

      // ── DUPLICATE_ELEMENT ──────────────────────────────────────────────────
      // Creates a copy of an element placed immediately after the original.
      case 'DUPLICATE_ELEMENT': {
        const { elementId } = action.payload;
        const newTracks = deepClone(state.tracks);
        const result = findElementById(newTracks, elementId);
        if (!result) return state;

        const orig = result.element;
        const dur  = orig.endTime - orig.startTime;
        const copy = deepClone(orig);
        copy.id        = generateId('elem_' + orig.type[0]);
        copy.startTime = orig.endTime;
        copy.endTime   = orig.endTime + dur;

        result.track.elements.push(copy);
        result.track.elements.sort(function(a, b) { return a.startTime - b.startTime; });

        const newHistory = pushHistory(state.history, state.tracks, false, 'Duplicate element');
        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
          playback: { ...state.playback, duration: Math.max(getDerivedDuration(newTracks), state.source.duration || 0) },
        };
      }

      // ── PASTE_ELEMENT ───────────────────────────────────────────────────────
      // Pastes a clipboard element onto the track of the same type, at pasteTime.
      case 'PASTE_ELEMENT': {
        const { clipboardElement, pasteTime, targetTrackId } = action.payload;
        if (!clipboardElement) return state;

        const newTracks = deepClone(state.tracks);

        // Find target track — prefer targetTrackId, fall back to first track of matching type
        let targetTrack = targetTrackId ? findTrackById(newTracks, targetTrackId) : null;
        if (!targetTrack) {
          // Find first track of the right type
          var pasteType = clipboardElement.type === 'videoClip' ? 'video'
            : clipboardElement.type === 'subtitle'  ? 'subtitle'
            : clipboardElement.type === 'audioClip' ? 'audio'
            : null;
          if (pasteType && newTracks[pasteType] && newTracks[pasteType].length > 0) {
            targetTrack = { track: newTracks[pasteType][0], trackType: pasteType };
          }
        }
        if (!targetTrack) return state;

        const dur  = clipboardElement.endTime - clipboardElement.startTime;
        const pasted = deepClone(clipboardElement);
        pasted.id        = generateId('elem_' + clipboardElement.type[0]);
        pasted.startTime = pasteTime !== undefined ? pasteTime : 0;
        pasted.endTime   = pasted.startTime + dur;

        targetTrack.track.elements.push(pasted);
        targetTrack.track.elements.sort(function(a, b) { return a.startTime - b.startTime; });

        const pasteHistory = pushHistory(state.history, state.tracks, false, 'Paste element');
        return {
          ...state,
          tracks:  newTracks,
          history: pasteHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
          playback: { ...state.playback, duration: Math.max(getDerivedDuration(newTracks), state.source.duration || 0) },
        };
      }

      // ── SPLIT_ELEMENT ──────────────────────────────────────────────────────
      // Splits an element at a given global timeline time into two independent
      // elements on the same track. The second element resets animated properties.
      case 'SPLIT_ELEMENT': {
        const { elementId, splitTime } = action.payload;

        const newTracks = deepClone(state.tracks);
        const result = findElementById(newTracks, elementId);
        if (!result) return state;

        const element = result.element;

        // Validate split is strictly within element bounds
        if (splitTime <= element.startTime || splitTime >= element.endTime) return state;

        const localSplitTime = splitTime - element.startTime;

        // Build elementA (first half) — inherits all properties
        const elementA = deepClone(element);
        elementA.id      = generateId('elem_' + element.type[0]);
        elementA.endTime = splitTime;

        // Build elementB (second half) — resets animated properties
        const elementB = deepClone(element);
        elementB.id        = generateId('elem_' + element.type[0]);
        elementB.startTime = splitTime;

        // Type-specific split logic
        if (element.type === 'videoClip') {
          // Source cut-point split using clip-level playbackRate
          var rate = element.playbackRate || 1;
          var sourceSplitTime = element.sourceStart + (localSplitTime * rate);

          elementA.sourceEnd   = sourceSplitTime;
          elementB.sourceStart = sourceSplitTime;

          // Copy clip-level scalars to both halves
          elementA.playbackRate = element.playbackRate || 1.0;
          elementA.volume       = element.volume !== undefined ? element.volume : 1.0;
          elementB.playbackRate = element.playbackRate || 1.0;
          elementB.volume       = element.volume !== undefined ? element.volume : 1.0;

          // Keyframe-aware split (scale and opacity only)
          if (element.keyframes) {
            var TRACK_DEFAULTS = { scale: 1.0, opacity: 1.0 };
            var kfTracks = ['scale', 'opacity'];

            for (var ki = 0; ki < kfTracks.length; ki++) {
              var trackName = kfTracks[ki];
              var kfArray   = element.keyframes[trackName];
              if (!kfArray || kfArray.length === 0) continue;

              // elementA: keep keyframes up to localSplitTime, add boundary
              var keptA = kfArray.filter(function (kf) { return kf.time <= localSplitTime; });
              if (keptA.length > 0 && keptA[keptA.length - 1].time < localSplitTime) {
                var interpVal = interpolateKeyframes(kfArray, localSplitTime);
                keptA.push({ time: localSplitTime, value: interpVal, easing: 'linear' });
              }
              if (keptA.length === 0) {
                keptA = [{ time: 0, value: TRACK_DEFAULTS[trackName] || 1.0, easing: 'linear' }];
              }
              elementA.keyframes[trackName] = keptA;

              // elementB: reset to default
              elementB.keyframes[trackName] = [{ time: 0, value: TRACK_DEFAULTS[trackName] || 1.0, easing: 'linear' }];
            }
          }
        }

        if (element.type === 'audioClip') {
          elementB.volume = 1.0;
        }

        // Replace original with the two halves
        var idx = result.track.elements.indexOf(
          result.track.elements.find(function (e) { return e.id === elementId; })
        );
        result.track.elements.splice(idx, 1, elementA, elementB);

        var newHistory = pushHistory(
          state.history, state.tracks, false,
          'Split element at ' + splitTime.toFixed(1) + 's'
        );

        return {
          ...state,
          tracks:  newTracks,
          history: newHistory,
          project: { ...state.project, updatedAt: new Date().toISOString() },
        };
      }

      default:
        return state;
    }
  }

  // ---------------------------------------------------------------------------
  // Keyframe interpolation
  // ---------------------------------------------------------------------------

  /**
   * interpolateKeyframes
   * Returns the interpolated value at a given local time from a sorted keyframe array.
   *
   * @param {Array}  keyframes  Sorted array of { time, value, easing }
   * @param {number} localTime  Time in seconds relative to the clip's startTime
   * @returns {number}          Interpolated value
   */
  function interpolateKeyframes(keyframes, localTime) {
    if (!keyframes || keyframes.length === 0) return 1.0;
    if (keyframes.length === 1) return keyframes[0].value;

    // Before first keyframe — hold first value
    if (localTime <= keyframes[0].time) return keyframes[0].value;

    // After last keyframe — hold last value
    if (localTime >= keyframes[keyframes.length - 1].time) return keyframes[keyframes.length - 1].value;

    // Find surrounding keyframes
    var prevKF = null;
    var nextKF = null;
    for (var i = 0; i < keyframes.length - 1; i++) {
      if (localTime >= keyframes[i].time && localTime < keyframes[i + 1].time) {
        prevKF = keyframes[i];
        nextKF = keyframes[i + 1];
        break;
      }
    }
    if (!prevKF || !nextKF) return keyframes[keyframes.length - 1].value;

    // Hold easing — jump, no interpolation
    if (prevKF.easing === 'hold') return prevKF.value;

    // Calculate normalised t (0→1) across the segment
    var span = nextKF.time - prevKF.time;
    if (span === 0) return prevKF.value;
    var t = (localTime - prevKF.time) / span;

    // Apply easing curve
    var easedT;
    switch (prevKF.easing) {
      case 'ease-in':
        easedT = t * t;
        break;
      case 'ease-out':
        easedT = t * (2 - t);
        break;
      case 'ease-in-out':
        easedT = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        break;
      default: // linear
        easedT = t;
    }

    return prevKF.value + (nextKF.value - prevKF.value) * easedT;
  }

  // ---------------------------------------------------------------------------
  // Dual export: CommonJS (Node) + browser global
  // ---------------------------------------------------------------------------

  const exports = {
    timelineReducer,
    generateId,
    deepClone,
    applyDotNotation,
    findElementById,
    findTrackById,
    interpolateKeyframes,
  };

  if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, exports);
  }
  if (typeof window !== 'undefined') {
    window.TimelineReducer = exports;
  }

  // ---------------------------------------------------------------------------
  // Built-in self-test (Node only — run: node src/state/timelineReducer.js)
  // ---------------------------------------------------------------------------

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const { initialTimelineState } = require('./schema.js');
    let state = deepClone(initialTimelineState);

    function assert(condition, msg) {
      if (!condition) throw new Error('FAIL: ' + msg);
    }

    // Test 1: LOAD_SOURCE — metadata only, no videoClip auto-creation
    state = timelineReducer(state, {
      type: 'LOAD_SOURCE',
      payload: { filename: 'test.mp4', duration: 15, width: 1080, height: 1920, fps: 30, fileSize: 1024, thumbnails: [] },
    });
    assert(state.tracks.video[0].elements.length === 0, 'LOAD_SOURCE: should NOT create any videoClip elements');
    assert(state.source.duration === 15, 'LOAD_SOURCE: duration should be 15');
    assert(state.source.filename === 'test.mp4', 'LOAD_SOURCE: filename set correctly');
    assert(state.history.past.length === 1, 'LOAD_SOURCE: should push 1 history entry');
    assert(state.playback.duration === 15, 'LOAD_SOURCE: playback.duration set to source duration');
    console.log('✓ LOAD_SOURCE (metadata only, no videoClip)');

    // Test 2: APPLY_OPERATIONS — CREATE subtitle
    const testOp = {
      op:      'CREATE',
      trackId: 'track_sub_0',
      element: {
        id: 'elem_s_test_0001', type: 'subtitle',
        startTime: 0, endTime: 2, text: 'Hello',
        style: { color: '#FFD700', fontSize: 52, fontFamily: 'Arial', fontWeight: 'bold',
          fontStyle: 'normal', textTransform: 'none', textShadow: null, letterSpacing: 'normal',
          textAlign: 'center', backgroundColor: 'transparent', padding: 0, borderRadius: 0 },
        position: { x: 'center', y: 'bottom', xOffset: 0, yOffset: 180 },
        animation: { in: { type: 'fade', duration: 8 }, out: { type: 'none', duration: 8 } },
      },
    };
    state = timelineReducer(state, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [testOp], promptText: 'add bold yellow subtitles' },
    });
    assert(state.tracks.subtitle[0].elements.length === 1, 'APPLY_OPERATIONS: should create 1 subtitle');
    assert(state.history.past.length === 2, 'APPLY_OPERATIONS: should push history');
    assert(state.history.past[1].isPromptCheckpoint === true, 'APPLY_OPERATIONS: should be prompt checkpoint');
    console.log('✓ APPLY_OPERATIONS (CREATE)');

    // Test 3: UNDO
    state = timelineReducer(state, { type: 'UNDO' });
    assert(state.tracks.subtitle[0].elements.length === 0, 'UNDO: subtitle should be gone');
    assert(state.history.future.length === 1, 'UNDO: should push to future');
    console.log('✓ UNDO');

    // Test 4: REDO
    state = timelineReducer(state, { type: 'REDO' });
    assert(state.tracks.subtitle[0].elements.length === 1, 'REDO: subtitle should be back');
    console.log('✓ REDO');

    // Test 5: UNDO_LAST_PROMPT
    state = timelineReducer(state, { type: 'UNDO_LAST_PROMPT' });
    assert(state.tracks.subtitle[0].elements.length === 0, 'UNDO_LAST_PROMPT: subtitle should be removed');
    console.log('✓ UNDO_LAST_PROMPT');

    // Test 6: UPDATE_ELEMENT
    state = timelineReducer(state, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [testOp], promptText: null },
    });
    state = timelineReducer(state, {
      type: 'UPDATE_ELEMENT',
      payload: { elementId: 'elem_s_test_0001', changes: { 'style.fontSize': 72 } },
    });
    const updated = findElementById(state.tracks, 'elem_s_test_0001');
    assert(updated && updated.element.style.fontSize === 72, 'UPDATE_ELEMENT: fontSize should be 72');
    console.log('✓ UPDATE_ELEMENT');

    // Test 7: DELETE_ELEMENT
    state = timelineReducer(state, {
      type: 'DELETE_ELEMENT',
      payload: { elementId: 'elem_s_test_0001' },
    });
    assert(state.tracks.subtitle[0].elements.length === 0, 'DELETE_ELEMENT: subtitle should be gone');
    console.log('✓ DELETE_ELEMENT');

    // Test 8: REORDER_TRACK
    state = timelineReducer(state, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{ op: 'CREATE_TRACK', trackType: 'subtitle' }], promptText: null },
    });
    assert(state.tracks.subtitle.length === 2, 'REORDER_TRACK setup: should have 2 subtitle tracks');
    state = timelineReducer(state, {
      type: 'REORDER_TRACK',
      payload: { trackType: 'subtitle', fromIndex: 1, toIndex: 0 },
    });
    assert(state.tracks.subtitle[0].index === 0, 'REORDER_TRACK: index 0 reassigned correctly');
    assert(state.tracks.subtitle[1].index === 1, 'REORDER_TRACK: index 1 reassigned correctly');
    assert(state.history.past.length > 0, 'REORDER_TRACK: should push history entry');
    console.log('✓ REORDER_TRACK');

    // Test 9: BATCH_CREATE
    const batchOp = {
      op: 'BATCH_CREATE',
      trackId: 'track_sub_0',
      template: {
        type: 'subtitle',
        style: { color: '#FFD700', fontSize: 52, fontFamily: 'Arial', fontWeight: 'bold',
          fontStyle: 'normal', textTransform: 'none', textShadow: null, letterSpacing: 'normal',
          textAlign: 'center', backgroundColor: 'transparent', padding: 0, borderRadius: 0 },
        position: { x: 'center', y: 'bottom', xOffset: 0, yOffset: 180 },
        animation: { in: { type: 'fade', duration: 8 }, out: { type: 'none', duration: 8 } },
      },
      elements: [
        { id: 'elem_s_batch_0001', startTime: 0, endTime: 1.5, text: 'Hello' },
        { id: 'elem_s_batch_0002', startTime: 1.5, endTime: 3.0, text: 'World' },
        { id: 'elem_s_batch_0003', startTime: 3.0, endTime: 4.5, text: 'Test' },
      ],
    };
    state = timelineReducer(state, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [batchOp], promptText: 'batch create test' },
    });
    const batchTarget = state.tracks.subtitle.find(t => t.id === 'track_sub_0');
    assert(batchTarget, 'BATCH_CREATE: track_sub_0 should exist');
    assert(batchTarget.elements.length === 3, 'BATCH_CREATE: should create 3 subtitle elements');
    assert(batchTarget.elements[0].text === 'Hello', 'BATCH_CREATE: first element text');
    assert(batchTarget.elements[0].style.color === '#FFD700', 'BATCH_CREATE: template style applied');
    assert(batchTarget.elements[1].id === 'elem_s_batch_0002', 'BATCH_CREATE: element id preserved');
    // Verify undo reverts all three at once
    state = timelineReducer(state, { type: 'UNDO' });
    const batchTargetAfterUndo = state.tracks.subtitle.find(t => t.id === 'track_sub_0');
    assert(batchTargetAfterUndo.elements.length === 0, 'BATCH_CREATE UNDO: all 3 elements removed');
    console.log('✓ BATCH_CREATE');

    // Test 10: SPLIT_ELEMENT — subtitle
    // Create a subtitle from 0 to 10
    state = timelineReducer(state, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{
        op: 'CREATE', trackId: 'track_sub_0',
        element: { id: 'elem_s_split_01', type: 'subtitle', startTime: 0, endTime: 10, text: 'Split me',
          style: { color: '#fff', fontSize: 52, fontFamily: 'Arial', fontWeight: 'normal',
            fontStyle: 'normal', textTransform: 'none', textShadow: null, letterSpacing: 'normal',
            textAlign: 'center', backgroundColor: 'transparent', padding: 0, borderRadius: 0,
            effect: { type: 'none', color: null } },
          position: { x: 'center', y: 'bottom', xOffset: 0, yOffset: 180 },
          animation: { in: { type: 'none', duration: 0 }, out: { type: 'none', duration: 0 } } },
      }], promptText: null },
    });
    var preSplitHistLen = state.history.past.length;
    state = timelineReducer(state, {
      type: 'SPLIT_ELEMENT',
      payload: { elementId: 'elem_s_split_01', splitTime: 4 },
    });
    var subTrack = state.tracks.subtitle.find(function(t) { return t.id === 'track_sub_0'; });
    assert(subTrack.elements.length === 2, 'SPLIT_ELEMENT: should produce 2 elements');
    assert(subTrack.elements[0].startTime === 0,  'SPLIT_ELEMENT: A.startTime === 0');
    assert(subTrack.elements[0].endTime   === 4,  'SPLIT_ELEMENT: A.endTime === 4');
    assert(subTrack.elements[1].startTime === 4,  'SPLIT_ELEMENT: B.startTime === 4');
    assert(subTrack.elements[1].endTime   === 10, 'SPLIT_ELEMENT: B.endTime === 10');
    assert(subTrack.elements[0].text === 'Split me', 'SPLIT_ELEMENT: A preserves text');
    assert(subTrack.elements[1].text === 'Split me', 'SPLIT_ELEMENT: B preserves text');
    assert(state.history.past.length === preSplitHistLen + 1, 'SPLIT_ELEMENT: pushes history');
    console.log('✓ SPLIT_ELEMENT (subtitle)');

    // Test 11: SPLIT_ELEMENT — outside bounds (no-op)
    var stateBeforeNoOp = state;
    state = timelineReducer(state, {
      type: 'SPLIT_ELEMENT',
      payload: { elementId: subTrack.elements[0].id, splitTime: 15 },
    });
    assert(state === stateBeforeNoOp, 'SPLIT_ELEMENT: out-of-bounds returns same state');
    console.log('✓ SPLIT_ELEMENT (out-of-bounds no-op)');

    // Test 12: UNDO restores original single element
    state = timelineReducer(state, { type: 'UNDO' });
    subTrack = state.tracks.subtitle.find(function(t) { return t.id === 'track_sub_0'; });
    assert(subTrack.elements.length === 1, 'SPLIT_ELEMENT UNDO: restores 1 element');
    assert(subTrack.elements[0].id === 'elem_s_split_01', 'SPLIT_ELEMENT UNDO: original id');
    console.log('✓ SPLIT_ELEMENT UNDO');

    // Test 13: interpolateKeyframes — linear midpoint
    var kfLinear = [{ time: 0, value: 1.0, easing: 'linear' }, { time: 5, value: 1.5, easing: 'linear' }];
    var interpMid = interpolateKeyframes(kfLinear, 2.5);
    assert(Math.abs(interpMid - 1.25) < 0.001, 'interpolateKeyframes: midpoint should be 1.25, got ' + interpMid);
    console.log('✓ interpolateKeyframes (linear midpoint)');

    // Test 14: interpolateKeyframes — after last keyframe (hold last value)
    var interpAfter = interpolateKeyframes(kfLinear, 6);
    assert(Math.abs(interpAfter - 1.5) < 0.001, 'interpolateKeyframes: after last should be 1.5, got ' + interpAfter);
    console.log('✓ interpolateKeyframes (hold last value)');

    // Test 15: interpolateKeyframes — single keyframe
    var kfSingle = [{ time: 0, value: 2.0, easing: 'linear' }];
    assert(interpolateKeyframes(kfSingle, 5) === 2.0, 'interpolateKeyframes: single kf returns value');
    console.log('✓ interpolateKeyframes (single keyframe)');

    // Test 16: interpolateKeyframes — hold easing
    var kfHold = [{ time: 0, value: 1.0, easing: 'hold' }, { time: 5, value: 2.0, easing: 'linear' }];
    assert(interpolateKeyframes(kfHold, 2.5) === 1.0, 'interpolateKeyframes: hold easing returns prevKF value');
    console.log('✓ interpolateKeyframes (hold easing)');

    // Test 17: interpolateKeyframes — empty/undefined
    assert(interpolateKeyframes([], 1) === 1.0, 'interpolateKeyframes: empty array returns 1.0');
    assert(interpolateKeyframes(undefined, 1) === 1.0, 'interpolateKeyframes: undefined returns 1.0');
    console.log('✓ interpolateKeyframes (empty/undefined)');

    // ── Phase 2: keyframe operations ──────────────────────────────────────

    // Test 18: videoClip created via APPLY_OPERATIONS has correct schema
    //   (playbackRate/volume top-level, only scale/opacity keyframes, src/isImage/imageDuration/originalFilename)
    var stateKf = deepClone(initialTimelineState);
    stateKf = timelineReducer(stateKf, {
      type:    'LOAD_SOURCE',
      payload: { filename: 'kf-test.mp4', duration: 10, width: 1080, height: 1920, fps: 30, fileSize: 512, thumbnails: [] },
    });
    assert(stateKf.tracks.video[0].elements.length === 0, 'Test18 setup: LOAD_SOURCE leaves video track empty');
    stateKf = timelineReducer(stateKf, {
      type:    'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op:      'CREATE',
          trackId: 'track_video_0',
          element: {
            id:               'elem_v_kftest_0001',
            type:             'videoClip',
            startTime:        0,
            endTime:          10,
            sourceStart:      0,
            sourceEnd:        10,
            playbackRate:     1.0,
            volume:           1.0,
            src:              '/uploads/test-kf-test.mp4',
            originalFilename: 'kf-test.mp4',
            isImage:          false,
            imageDuration:    null,
            keyframes: {
              scale:   [{ time: 0, value: 1.0, easing: 'linear' }],
              opacity: [{ time: 0, value: 1.0, easing: 'linear' }],
            },
          },
        }],
        promptText: null,
      },
    });
    var kfClip = stateKf.tracks.video[0].elements[0];
    assert(kfClip,                                           'videoClip schema: element created');
    assert(kfClip.keyframes,                                 'videoClip schema: keyframes object present');
    assert(Array.isArray(kfClip.keyframes.scale),            'videoClip schema: scale array present');
    assert(Array.isArray(kfClip.keyframes.opacity),          'videoClip schema: opacity array present');
    assert(kfClip.keyframes.scale[0].value   === 1.0,        'videoClip schema: scale default 1.0');
    assert(kfClip.keyframes.opacity[0].value === 1.0,        'videoClip schema: opacity default 1.0');
    assert(!kfClip.keyframes.speed,                          'videoClip schema: no speed keyframe track');
    assert(!kfClip.keyframes.volume,                         'videoClip schema: no volume keyframe track');
    assert(kfClip.playbackRate === 1.0,                      'videoClip schema: playbackRate top-level = 1.0');
    assert(kfClip.volume       === 1.0,                      'videoClip schema: volume top-level = 1.0');
    assert(!kfClip.zoom,                                     'videoClip schema: no legacy zoom field');
    assert(kfClip.src              === '/uploads/test-kf-test.mp4', 'videoClip schema: src field present');
    assert(kfClip.originalFilename === 'kf-test.mp4',        'videoClip schema: originalFilename present');
    assert(kfClip.isImage          === false,                'videoClip schema: isImage = false');
    assert(kfClip.imageDuration    === null,                 'videoClip schema: imageDuration = null');
    console.log('✓ videoClip schema (via APPLY_OPERATIONS CREATE)');

    // Test 19: ADD_KEYFRAME — adds and keeps array sorted
    stateKf = timelineReducer(stateKf, {
      type:    'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op:        'ADD_KEYFRAME',
          elementId: kfClip.id,
          trackName: 'scale',
          keyframe:  { time: 5, value: 2.0, easing: 'ease-in-out' },
        }],
        promptText: null,
      },
    });
    var kfClipAfterAdd = stateKf.tracks.video[0].elements[0];
    assert(kfClipAfterAdd.keyframes.scale.length === 2, 'ADD_KEYFRAME: scale array has 2 entries');
    assert(kfClipAfterAdd.keyframes.scale[0].time === 0, 'ADD_KEYFRAME: first kf time=0');
    assert(kfClipAfterAdd.keyframes.scale[1].time === 5, 'ADD_KEYFRAME: second kf time=5');
    assert(kfClipAfterAdd.keyframes.scale[1].value === 2.0, 'ADD_KEYFRAME: value 2.0');
    console.log('✓ ADD_KEYFRAME');

    // Test 20: UPDATE_KEYFRAME — updates value, re-sorts if time changes
    stateKf = timelineReducer(stateKf, {
      type:    'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op:        'UPDATE_KEYFRAME',
          elementId: kfClip.id,
          trackName: 'scale',
          index:     1,
          changes:   { value: 1.5 },
        }],
        promptText: null,
      },
    });
    var kfClipAfterUpd = stateKf.tracks.video[0].elements[0];
    assert(kfClipAfterUpd.keyframes.scale[1].value === 1.5, 'UPDATE_KEYFRAME: value updated to 1.5');
    console.log('✓ UPDATE_KEYFRAME');

    // Test 21: DELETE_KEYFRAME — removes entry; last keyframe replaced with default
    stateKf = timelineReducer(stateKf, {
      type:    'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op:        'DELETE_KEYFRAME',
          elementId: kfClip.id,
          trackName: 'scale',
          index:     0,           // remove the time=0 entry
        }],
        promptText: null,
      },
    });
    var kfClipAfterDel = stateKf.tracks.video[0].elements[0];
    assert(kfClipAfterDel.keyframes.scale.length === 1, 'DELETE_KEYFRAME: one entry remains');
    assert(kfClipAfterDel.keyframes.scale[0].time === 5, 'DELETE_KEYFRAME: remaining entry is time=5');
    // Now delete the last remaining one — should restore default
    stateKf = timelineReducer(stateKf, {
      type:    'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op:        'DELETE_KEYFRAME',
          elementId: kfClip.id,
          trackName: 'scale',
          index:     0,
        }],
        promptText: null,
      },
    });
    var kfClipAfterDelLast = stateKf.tracks.video[0].elements[0];
    assert(kfClipAfterDelLast.keyframes.scale.length === 1,    'DELETE_KEYFRAME last: default restored');
    assert(kfClipAfterDelLast.keyframes.scale[0].time  === 0,  'DELETE_KEYFRAME last: default time=0');
    assert(kfClipAfterDelLast.keyframes.scale[0].value === 1.0,'DELETE_KEYFRAME last: default value=1.0');
    console.log('✓ DELETE_KEYFRAME (including last-entry default restore)');

    // Test 22: CREATE_TRACK generates name field
    var stateN = deepClone(initialTimelineState);
    stateN = timelineReducer(stateN, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{ op: 'CREATE_TRACK', trackType: 'subtitle' }], promptText: null },
    });
    assert(stateN.tracks.subtitle.length === 2, 'CREATE_TRACK name: 2 subtitle tracks');
    assert(stateN.tracks.subtitle[1].name === 'Subtitle 2', 'CREATE_TRACK name: second track named "Subtitle 2", got: ' + stateN.tracks.subtitle[1].name);
    assert(stateN.tracks.subtitle[0].name === 'Subtitle 1', 'CREATE_TRACK name: initial track named "Subtitle 1"');
    // UNDO removes new track
    stateN = timelineReducer(stateN, { type: 'UNDO' });
    assert(stateN.tracks.subtitle.length === 1, 'CREATE_TRACK name UNDO: back to 1 track');
    console.log('✓ CREATE_TRACK name field');

    // Test 23: DELETE_TRACK (standalone) re-indexes + last-track guard
    var stateDT = deepClone(initialTimelineState);
    stateDT = timelineReducer(stateDT, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{ op: 'CREATE_TRACK', trackType: 'subtitle' }], promptText: null },
    });
    var newTrackId = stateDT.tracks.subtitle[1].id;
    stateDT = timelineReducer(stateDT, { type: 'DELETE_TRACK', payload: { trackId: newTrackId } });
    assert(stateDT.tracks.subtitle.length === 1, 'DELETE_TRACK: back to 1 track');
    assert(stateDT.tracks.subtitle[0].index === 0, 'DELETE_TRACK: re-index after delete');
    // UNDO restores deleted track
    stateDT = timelineReducer(stateDT, { type: 'UNDO' });
    assert(stateDT.tracks.subtitle.length === 2, 'DELETE_TRACK UNDO: 2 tracks restored');
    // Last-track guard
    var stateGuard = deepClone(initialTimelineState);
    stateGuard = timelineReducer(stateGuard, { type: 'DELETE_TRACK', payload: { trackId: 'track_sub_0' } });
    assert(stateGuard.tracks.subtitle.length === 1, 'DELETE_TRACK guard: cannot delete last track');
    console.log('✓ DELETE_TRACK standalone + last-track guard');

    // Test 24: REORDER_TRACK inside APPLY_OPERATIONS
    var stateRO = deepClone(initialTimelineState);
    stateRO = timelineReducer(stateRO, {
      type: 'APPLY_OPERATIONS',
      payload: {
        operations: [
          { op: 'CREATE_TRACK', trackType: 'subtitle' },
          { op: 'REORDER_TRACK', trackType: 'subtitle', fromIndex: 1, toIndex: 0 },
        ],
        promptText: null,
      },
    });
    assert(stateRO.tracks.subtitle.length === 2, 'REORDER_TRACK in APPLY_OPERATIONS: 2 tracks');
    assert(stateRO.tracks.subtitle[0].id !== 'track_sub_0', 'REORDER_TRACK in APPLY_OPERATIONS: new track moved to front');
    assert(stateRO.tracks.subtitle[1].id === 'track_sub_0', 'REORDER_TRACK in APPLY_OPERATIONS: original at index 1');
    assert(stateRO.tracks.subtitle[0].index === 0, 'REORDER_TRACK in APPLY_OPERATIONS: index 0 correct');
    assert(stateRO.tracks.subtitle[1].index === 1, 'REORDER_TRACK in APPLY_OPERATIONS: index 1 correct');
    console.log('✓ REORDER_TRACK inside APPLY_OPERATIONS');

    // Test 25: new:trackType resolution + REORDER_TRACK interop
    var stateNR = deepClone(initialTimelineState);
    stateNR = timelineReducer(stateNR, {
      type: 'APPLY_OPERATIONS',
      payload: {
        operations: [
          { op: 'CREATE_TRACK', trackType: 'subtitle' },
          { op: 'REORDER_TRACK', trackType: 'subtitle', fromIndex: 1, toIndex: 0 },
          { op: 'CREATE', trackId: 'new:subtitle', element: {
            id: 'elem_s_resolve_test_01', type: 'subtitle', startTime: 0, endTime: 1, text: 'new',
            style: { color: '#fff', fontSize: 52, fontFamily: 'Arial', fontWeight: 'normal',
              fontStyle: 'normal', textTransform: 'none', textShadow: null, letterSpacing: 'normal',
              textAlign: 'center', backgroundColor: 'transparent', padding: 0, borderRadius: 0,
              effect: { type: 'none', color: null } },
            position: { x: 'center', y: 'bottom', xOffset: 0, yOffset: 180 },
            animation: { in: { type: 'none', duration: 0 }, out: { type: 'none', duration: 0 } },
          }},
        ],
        promptText: null,
      },
    });
    // After reorder: new track is at index 0, original (track_sub_0) at index 1
    var resolvedTrack = stateNR.tracks.subtitle[0];
    assert(resolvedTrack.id !== 'track_sub_0', 'new:trackType: element landed on new track (not original)');
    assert(resolvedTrack.elements.length === 1, 'new:trackType: new track has 1 element');
    assert(resolvedTrack.elements[0].id === 'elem_s_resolve_test_01', 'new:trackType: correct element');
    assert(stateNR.tracks.subtitle[1].elements.length === 0, 'new:trackType: original track untouched');
    console.log('✓ new:trackType resolution with REORDER_TRACK interop');

    // ── New tests for architectural changes ───────────────────────────────

    // New Test A: CREATE_TRACK with invalid type ('effect') — must be rejected
    var stateInvalidTrack = deepClone(initialTimelineState);
    stateInvalidTrack = timelineReducer(stateInvalidTrack, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{ op: 'CREATE_TRACK', trackType: 'effect' }], promptText: null },
    });
    assert(!stateInvalidTrack.tracks.effect, 'CREATE_TRACK invalid: no "effect" key in tracks');
    assert(!stateInvalidTrack.tracks.overlay, 'CREATE_TRACK invalid: no "overlay" key in tracks');
    assert(stateInvalidTrack.tracks.video.length   === 1, 'CREATE_TRACK invalid: video tracks unaffected');
    assert(stateInvalidTrack.tracks.subtitle.length === 1, 'CREATE_TRACK invalid: subtitle tracks unaffected');
    assert(stateInvalidTrack.tracks.audio.length   === 1, 'CREATE_TRACK invalid: audio tracks unaffected');
    console.log('✓ CREATE_TRACK with invalid type "effect" is rejected');

    // New Test B: CREATE_TRACK with invalid type ('overlay') — must be rejected
    stateInvalidTrack = timelineReducer(stateInvalidTrack, {
      type: 'APPLY_OPERATIONS',
      payload: { operations: [{ op: 'CREATE_TRACK', trackType: 'overlay' }], promptText: null },
    });
    assert(!stateInvalidTrack.tracks.overlay, 'CREATE_TRACK invalid overlay: no "overlay" key in tracks');
    console.log('✓ CREATE_TRACK with invalid type "overlay" is rejected');

    // New Test C: Multiple videoClip elements on the same track
    var stateMultiClip = deepClone(initialTimelineState);
    stateMultiClip = timelineReducer(stateMultiClip, {
      type: 'APPLY_OPERATIONS',
      payload: {
        operations: [
          {
            op: 'CREATE', trackId: 'track_video_0',
            element: {
              id: 'elem_v_mc_001', type: 'videoClip',
              startTime: 0, endTime: 10,
              sourceStart: 0, sourceEnd: 10,
              playbackRate: 1.0, volume: 1.0,
              src: '/uploads/clip1.mp4', originalFilename: 'clip1.mp4',
              isImage: false, imageDuration: null,
              keyframes: { scale: [{ time: 0, value: 1.0, easing: 'linear' }], opacity: [{ time: 0, value: 1.0, easing: 'linear' }] },
            },
          },
        ],
        promptText: null,
      },
    });
    assert(stateMultiClip.tracks.video[0].elements.length === 1, 'Multi-clip: first clip created');
    assert(stateMultiClip.playback.duration === 10, 'Multi-clip: playback.duration = 10 after first clip');

    stateMultiClip = timelineReducer(stateMultiClip, {
      type: 'APPLY_OPERATIONS',
      payload: {
        operations: [
          {
            op: 'CREATE', trackId: 'track_video_0',
            element: {
              id: 'elem_v_mc_002', type: 'videoClip',
              startTime: 10, endTime: 20,
              sourceStart: 0, sourceEnd: 10,
              playbackRate: 1.0, volume: 1.0,
              src: '/uploads/clip2.mp4', originalFilename: 'clip2.mp4',
              isImage: false, imageDuration: null,
              keyframes: { scale: [{ time: 0, value: 1.0, easing: 'linear' }], opacity: [{ time: 0, value: 1.0, easing: 'linear' }] },
            },
          },
        ],
        promptText: null,
      },
    });
    assert(stateMultiClip.tracks.video[0].elements.length === 2, 'Multi-clip: two videoClip elements on same track');
    assert(stateMultiClip.tracks.video[0].elements[0].id === 'elem_v_mc_001', 'Multi-clip: first clip id correct');
    assert(stateMultiClip.tracks.video[0].elements[1].id === 'elem_v_mc_002', 'Multi-clip: second clip id correct');
    assert(stateMultiClip.playback.duration === 20, 'Multi-clip: playback.duration = 20 after second clip');
    // UNDO removes second clip
    stateMultiClip = timelineReducer(stateMultiClip, { type: 'UNDO' });
    assert(stateMultiClip.tracks.video[0].elements.length === 1, 'Multi-clip UNDO: back to 1 element');
    assert(stateMultiClip.playback.duration === 10, 'Multi-clip UNDO: playback.duration reduced back to 10');
    console.log('✓ Multiple videoClip elements on same track + UNDO duration recalculation');

    // New Test D: isImage videoClip with imageDuration
    var stateImg = deepClone(initialTimelineState);
    stateImg = timelineReducer(stateImg, {
      type: 'APPLY_OPERATIONS',
      payload: {
        operations: [{
          op: 'CREATE', trackId: 'track_video_0',
          element: {
            id: 'elem_v_img_001', type: 'videoClip',
            startTime: 0, endTime: 10,
            sourceStart: 0, sourceEnd: 10,
            playbackRate: 1.0, volume: 1.0,
            src: '/uploads/1234567890-logo.mp4',
            originalFilename: 'logo.png',
            isImage: true,
            imageDuration: 10,
            keyframes: { scale: [{ time: 0, value: 1.0, easing: 'linear' }], opacity: [{ time: 0, value: 1.0, easing: 'linear' }] },
          },
        }],
        promptText: null,
      },
    });
    var imgClip = stateImg.tracks.video[0].elements[0];
    assert(imgClip.isImage          === true,          'isImage clip: isImage = true');
    assert(imgClip.imageDuration    === 10,            'isImage clip: imageDuration = 10');
    assert(imgClip.originalFilename === 'logo.png',    'isImage clip: originalFilename = logo.png');
    assert(imgClip.src.endsWith('.mp4'),               'isImage clip: src is mp4');
    console.log('✓ isImage videoClip element with imageDuration and originalFilename');

    // New Test E: getDerivedDuration returns 0 when tracks empty
    var emptyState = deepClone(initialTimelineState);
    assert(getDerivedDuration(emptyState.tracks) === 0, 'getDerivedDuration: returns 0 for empty tracks');
    console.log('✓ getDerivedDuration returns 0 for empty tracks');

    console.log('\nAll tests passed.');
  }

})();
