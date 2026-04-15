// ─────────────────────────────────────────────────────────────────────────────
// App.jsx
// Root component — CSS grid shell, all shared state, reducer wiring, backend calls.
//
// Globals consumed:
//   React, ReactDOM, window.TimelineSchema, window.TimelineReducer,
//   window.VideoPreview, window.Timeline, window.LeftPanel, window.AgentPanel
//
// Mounts to: #root
// No import / export statements (CDN/Babel environment).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const { useState, useReducer, useCallback, useEffect, useRef, useMemo } = React;

  const { initialTimelineState } = window.TimelineSchema;
  const { timelineReducer }      = window.TimelineReducer;

  const VideoPreview = window.VideoPreview;
  const Timeline     = window.Timeline;
  const LeftPanel    = window.LeftPanel;
  const AgentPanel   = window.AgentPanel;
  const ContextMenu  = window.ContextMenu;
  const Header       = window.Header;
  const ExportModal  = window.ExportModal;

  // ── Migrate tracks schema — remove invalid track types, ensure required ones exist ──
  function migrateTracksSchema(tracks) {
    const valid = new Set(['video', 'subtitle', 'audio']);
    const cleaned = {};
    for (const [key, val] of Object.entries(tracks || {})) {
      if (valid.has(key)) cleaned[key] = val;
    }
    if (!cleaned.video)    cleaned.video    = [{ id: 'track_video_0',  index: 0, name: 'Video 1',    locked: false, visible: true, elements: [] }];
    if (!cleaned.subtitle) cleaned.subtitle = [{ id: 'track_sub_0',   index: 0, name: 'Subtitle 1', locked: false, visible: true, elements: [] }];
    if (!cleaned.audio)    cleaned.audio    = [{ id: 'track_audio_0', index: 0, name: 'Audio 1',    locked: false, visible: true, elements: [] }];
    return cleaned;
  }

  // ── Migrate old-format videoClip elements ────────────────────────────
  // Handles two legacy cases:
  //   v1: had zoom/playbackRate/volume top-level fields, no keyframes
  //   v2: had keyframes with speed/volume tracks (now clip-level scalars)
  // LOAD_SOURCE now always creates the current format; migration is only needed
  // for undo-history snapshots that may contain older shapes.
  function migrateVideoClipElement(el) {
    if (!el || el.type !== 'videoClip') return el;

    let result = el;

    // v1 → current: build keyframes from legacy fields
    if (!result.keyframes) {
      result = {
        ...result,
        playbackRate: result.playbackRate !== undefined ? result.playbackRate : 1.0,
        volume:       result.volume       !== undefined ? result.volume       : 1.0,
        keyframes: {
          scale:   [{ time: 0, value: (result.zoom && result.zoom.amount) ? result.zoom.amount : 1.0, easing: 'linear' }],
          opacity: [{ time: 0, value: 1.0, easing: 'linear' }],
        },
      };
    }

    // v2 → current: promote speed/volume keyframe[0] to clip-level scalars, strip those tracks
    const kf = result.keyframes;
    if (kf.speed || kf.volume) {
      const promotedRate = (kf.speed  && kf.speed[0])  ? kf.speed[0].value  : (result.playbackRate || 1.0);
      const promotedVol  = (kf.volume && kf.volume[0]) ? kf.volume[0].value : (result.volume       || 1.0);
      const newKf = { ...kf };
      delete newKf.speed;
      delete newKf.volume;
      result = {
        ...result,
        playbackRate: promotedRate,
        volume:       promotedVol,
        keyframes:    newKf,
      };
    }

    // Correction 4: ensure new fields exist for clips created before this schema version
    if (result.src              === undefined) result = { ...result, src:              null  };
    if (result.originalFilename === undefined) result = { ...result, originalFilename: null  };
    if (result.isImage          === undefined) result = { ...result, isImage:          false };
    if (result.imageDuration    === undefined) result = { ...result, imageDuration:    null  };

    return result;
  }

  // ── Find the next available start time on the video track ────────────────
  function findNextAvailableTime(videoTracks) {
    let max = 0;
    for (const track of (videoTracks || [])) {
      for (const el of (track.elements || [])) {
        if (el.endTime > max) max = el.endTime;
      }
    }
    return max;
  }

  // ── File-size formatter ──────────────────────────────────────────────────
  function fmtFileSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024)        return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Extract thumbnail + metadata from a File object ──────────────────────
  function createMediaItem(file) {
    return new Promise(resolve => {
      const url     = URL.createObjectURL(file);
      const isImage = file.type.startsWith('image/');
      const canvas  = document.createElement('canvas');

      function finish(thumbnailUrl, duration, resolution) {
        URL.revokeObjectURL(url);
        resolve({
          id:                `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          filename:          file.name,
          path:              file.name,
          duration:          duration || 0,
          thumbnailUrl:      thumbnailUrl || null,
          fileSize:          fmtFileSize(file.size),
          resolution:        resolution || '—',
          isImage,
          isAddedToTimeline: false,
          _file:             file,
        });
      }

      if (isImage) {
        // Images: use an <img> element to read dimensions, draw to canvas for thumbnail
        const img = document.createElement('img');
        img.onload = () => {
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          finish(
            canvas.toDataURL('image/jpeg', 0.7),
            10,  // images become 10-second video clips
            `${img.naturalWidth}×${img.naturalHeight}`
          );
        };
        img.onerror = () => finish(null, 10, '—');
        img.src = url;
        return;
      }

      // Video: use a <video> element to read duration and grab a thumbnail frame
      const video = document.createElement('video');
      video.onloadedmetadata = () => {
        video.currentTime = Math.min(0.5, video.duration * 0.1);
      };
      video.onseeked = () => {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        finish(
          canvas.toDataURL('image/jpeg', 0.7),
          video.duration,
          `${video.videoWidth}×${video.videoHeight}`
        );
      };
      video.onerror = () => finish(null, 0, '—');
      video.src = url;
      video.load();
    });
  }

  // ── Root App component ───────────────────────────────────────────────────
  function App() {

    // ── Timeline state (via reducer) ───────────────────────────────────────
    const [state, dispatch] = useReducer(timelineReducer, initialTimelineState);

    // ── UI-only state (not in reducer) ────────────────────────────────────
    const [selectedElementId, setSelectedElementId] = useState(null);
    const [timelineZoom,      setTimelineZoom]       = useState(80);   // px per second
    const [agentMessages,     setAgentMessages]      = useState([]);
    const [isProcessing,      setIsProcessing]       = useState(false);
    const [cachedTranscript,  setCachedTranscript]   = useState(null);

    // Uploaded file tracking (File object + server-side path from /upload response)
    const [uploadedFile,      setUploadedFile]       = useState(null);  // File object
    const [uploadedVideoPath, setUploadedVideoPath]  = useState(null);  // server path string
    const [previewSrc,        setPreviewSrc]         = useState(null);  // blob URL for preview

    // Uploaded audio files (refreshed after each audio upload; Audio tab fetches its own list)
    const [audioFiles, setAudioFiles] = useState([]);

    // Real-time position preview while typing in Properties panel
    // Shape: { elementId, x, y } in video space (0-1080 / 0-1920), or null
    const [previewPosition, setPreviewPosition] = useState(null);

    // Selected keyframe for the Properties panel
    // Shape: { elementId, trackName, index } or null
    const [selectedKeyframe, setSelectedKeyframe] = useState(null);

    // Media items shown in LeftPanel Media tab
    const [mediaItems, setMediaItems] = useState([]);

    // ── Clear preview position and selected keyframe when element changes ─
    useEffect(() => {
      setPreviewPosition(null);
      setSelectedKeyframe(null);
    }, [selectedElementId]);

    // ── Refs for keyboard handler — avoids stale closures in the effect ───
    const selectedElementIdRef = useRef(selectedElementId);
    useEffect(() => { selectedElementIdRef.current = selectedElementId; }, [selectedElementId]);

    const currentTimeRef = useRef(state.playback.currentTime);
    useEffect(() => { currentTimeRef.current = state.playback.currentTime; }, [state.playback.currentTime]);

    // ── Clipboard for Cut / Copy / Paste / Duplicate ───────────────────────
    const [clipboard, setClipboard]   = useState(null);
    const clipboardRef   = useRef(null);
    const stateTracksRef = useRef(state.tracks);
    useEffect(() => { clipboardRef.current   = clipboard;    }, [clipboard]);
    useEffect(() => { stateTracksRef.current = state.tracks; }, [state.tracks]);

    // ── Context menu { x, y, elementId, trackId, pasteTime } or null ───────
    const [contextMenu, setContextMenu] = useState(null);

    // ── Export modal state ────────────────────────────────────────────────
    const [exportModal, setExportModal] = useState(false);   // open/closed
    const [exportJob,   setExportJob]   = useState(null);    // { jobId, status, progress, filename } or null

    // ── Keyboard shortcuts ─────────────────────────────────────────────────
    useEffect(() => {
      function handleKeyDown(e) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const mod   = isMac ? e.metaKey : e.ctrlKey;

        if (mod && e.shiftKey && e.key === 'z') {
          e.preventDefault();
          dispatch({ type: 'REDO' });
          return;
        }
        if (mod && e.key === 'z') {
          e.preventDefault();
          dispatch({ type: 'UNDO' });
          return;
        }
        if (mod && e.key === 'b') {
          e.preventDefault();
          const elemId = selectedElementIdRef.current;
          const t      = currentTimeRef.current;
          if (elemId && t != null) {
            dispatch({ type: 'SPLIT_ELEMENT', payload: { elementId: elemId, splitTime: t } });
          }
          return;
        }
        // B4: Copy / Cut / Paste / Duplicate
        if (mod && e.key === 'c') {
          e.preventDefault();
          const elemId = selectedElementIdRef.current;
          if (elemId) {
            const r = window.TimelineReducer.findElementById(stateTracksRef.current, elemId);
            if (r) setClipboard(r.element);
          }
          return;
        }
        if (mod && e.key === 'x') {
          e.preventDefault();
          const elemId = selectedElementIdRef.current;
          if (elemId) {
            const r = window.TimelineReducer.findElementById(stateTracksRef.current, elemId);
            if (r) {
              setClipboard(r.element);
              dispatch({ type: 'DELETE_ELEMENT', payload: { elementId: elemId } });
              setSelectedElementId(null);
            }
          }
          return;
        }
        if (mod && e.key === 'v') {
          e.preventDefault();
          const cb = clipboardRef.current;
          if (cb) dispatch({ type: 'PASTE_ELEMENT', payload: { clipboardElement: cb, pasteTime: currentTimeRef.current || 0, targetTrackId: null } });
          return;
        }
        if (mod && e.key === 'd') {
          e.preventDefault();
          const elemId = selectedElementIdRef.current;
          if (elemId) dispatch({ type: 'DUPLICATE_ELEMENT', payload: { elementId: elemId } });
          return;
        }
        if (e.key === 'Escape') {
          setSelectedElementId(null);
        }
      }
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // B5 / Correction 3: dismiss context menu on outside left-click or Escape
    useEffect(() => {
      if (!contextMenu) return;
      const onMouse = (e) => { if (e.button !== 0) return; setContextMenu(null); };
      const onKey   = (e) => { if (e.key === 'Escape') setContextMenu(null); };
      const id = setTimeout(() => {
        window.addEventListener('mousedown', onMouse);
        window.addEventListener('keydown',   onKey);
      }, 0);
      return () => {
        clearTimeout(id);
        window.removeEventListener('mousedown', onMouse);
        window.removeEventListener('keydown',   onKey);
      };
    }, [contextMenu]);

    // ── Media import handler ───────────────────────────────────────────────
    // For each imported file:
    //   1. Add to media library immediately (optimistic UI)
    //   2. Upload to server (images are auto-converted to mp4 by the server)
    //   3. Dispatch APPLY_OPERATIONS CREATE to place a videoClip on the timeline
    //   4. Dispatch LOAD_SOURCE only once (Correction 1) to set project metadata,
    //      only if no source file has been set yet (state.source.filename === null)
    const handleMediaImport = useCallback(async (files) => {
      const items = await Promise.all(Array.from(files).map(createMediaItem));
      setMediaItems(prev => [...prev, ...items]);

      // Track start position for sequential placement (React state won't update mid-loop)
      let nextStart = findNextAvailableTime(state.tracks.video);

      for (const item of items) {
        const formData = new FormData();
        formData.append('video', item._file);
        try {
          const res  = await fetch('/upload', { method: 'POST', body: formData });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Upload failed');

          // Always track the most recently uploaded file as the generate source
          setUploadedVideoPath(data.path);

          // Correction 1: dispatch LOAD_SOURCE only once to set project source metadata
          if (!state.source.filename) {
            setUploadedFile(item._file);
            if (!item.isImage) {
              setPreviewSrc(URL.createObjectURL(item._file));
            }
            dispatch({
              type: 'LOAD_SOURCE',
              payload: {
                filename:   item.filename,
                duration:   data.duration || item.duration,
                width:      data.width  || 1080,
                height:     data.height || 1920,
                fps:        30,
                fileSize:   item._file.size,
                thumbnails: item.thumbnailUrl ? [item.thumbnailUrl] : [],
              },
            });
          }

          // Place videoClip on timeline for all video and image files
          const clipDuration = data.duration || 10;
          const newId = 'elem_v_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
          dispatch({
            type:    'APPLY_OPERATIONS',
            payload: {
              operations: [{
                op:      'CREATE',
                trackId: 'track_video_0',
                element: {
                  id:               newId,
                  type:             'videoClip',
                  startTime:        nextStart,
                  endTime:          nextStart + clipDuration,
                  sourceStart:      0,
                  sourceEnd:        clipDuration,
                  playbackRate:     1.0,
                  volume:           1.0,
                  src:              data.path,
                  originalFilename: data.originalFilename || item.filename,
                  isImage:          data.isImage || false,
                  imageDuration:    data.isImage ? clipDuration : null,
                  keyframes: {
                    scale:   [{ time: 0, value: 1.0, easing: 'linear' }],
                    opacity: [{ time: 0, value: 1.0, easing: 'linear' }],
                  },
                },
              }],
              promptText: null,
            },
          });
          nextStart += clipDuration;

        } catch (err) {
          console.error('Upload error:', err);
        }
      }
    }, [state.source.filename, state.tracks.video]);

    const handleMediaRemove = useCallback((id) => {
      setMediaItems(prev => prev.filter(m => m.id !== id));
    }, []);

    // ── Audio import handler ───────────────────────────────────────────────
    // Uploads an audio file via POST /upload (multer now accepts audio).
    // The Audio tab is self-sufficient — it fetches its own list from
    // GET /api/audio/uploads on mount, so no prop drilling needed.
    const handleAudioImport = useCallback(async (file) => {
      const formData = new FormData();
      formData.append('video', file); // multer field name is 'video' — works for audio too
      try {
        const res  = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        // Signal the Audio tab that a new file exists (triggers a re-fetch there)
        setAudioFiles(prev => [...prev, data.filename]);
      } catch (err) {
        console.error('Audio upload error:', err);
      }
    }, []);

    // ── Add audio to timeline handler ──────────────────────────────────────
    // Called when the user clicks + on an Audio tab result or drags to timeline.
    const handleAddAudioToTimeline = useCallback((audioItem) => {
      const newId = 'elem_a_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      dispatch({
        type:    'APPLY_OPERATIONS',
        payload: {
          operations: [{
            op:      'CREATE',
            trackId: 'track_audio_0',
            element: {
              id:         newId,
              type:       'audioClip',
              startTime:  0,
              endTime:    audioItem.duration || state.source.duration || 30,
              src:        audioItem.src,
              volume:     1.0,
              fadeIn:     0,
              fadeOut:    0,
              sourceName: audioItem.sourceName || audioItem.name || 'Audio',
              sourceType: audioItem.sourceType || 'upload',
            },
          }],
          promptText: null,
        },
      });
    }, [state.source.duration]);

    const handleSetCurrentFile = useCallback(async (item) => {
      // Revoke any previous blob URL to avoid memory leaks
      if (previewSrc && previewSrc.startsWith('blob:')) {
        URL.revokeObjectURL(previewSrc);
      }
      const blobUrl = URL.createObjectURL(item._file);
      setPreviewSrc(blobUrl);
      setUploadedFile(item._file);

      const formData = new FormData();
      formData.append('video', item._file);
      try {
        const res  = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
          setUploadedVideoPath(data.path);
          dispatch({
            type: 'LOAD_SOURCE',
            payload: {
              filename:   item.filename,
              duration:   data.duration || item.duration,
              width:      data.width  || 1080,
              height:     data.height || 1920,
              fps:        30,
              fileSize:   item._file.size,
              thumbnails: item.thumbnailUrl ? [item.thumbnailUrl] : [],
            },
          });
        }
      } catch (err) {
        console.error('Upload error:', err);
      }
    }, [previewSrc]);

    // ── Playback handlers ──────────────────────────────────────────────────
    const handlePlayPause = useCallback(() => {
      dispatch({ type: 'TOGGLE_PLAYBACK' });
    }, []);

    const handleSeek = useCallback((t) => {
      dispatch({ type: 'SET_PLAYBACK_TIME', payload: { currentTime: t } });
    }, []);

    const handleTimeUpdate = useCallback((t) => {
      dispatch({ type: 'SET_PLAYBACK_TIME', payload: { currentTime: t } });
    }, []);

    // ── Operation summary builder ────────────────────────────────────────
    /**
     * summarizeOperations
     * Builds a human-readable summary from an operations array.
     * Counts BATCH_CREATE element totals separately from other operations.
     *
     * @param {Array} operations  The operations array from the server response.
     * @returns {string}          e.g. "Added 47 subtitles" or "Added 30 subtitles, updated 2 elements"
     */
    function summarizeOperations(operations) {
      let batchCount = 0;
      const otherCounts = {};

      for (const op of operations) {
        if (op.op === 'BATCH_CREATE') {
          batchCount += (op.elements ? op.elements.length : 0);
        } else {
          otherCounts[op.op] = (otherCounts[op.op] || 0) + 1;
        }
      }

      const parts = [];
      if (batchCount > 0) {
        parts.push('Added ' + batchCount + ' subtitle' + (batchCount !== 1 ? 's' : ''));
      }
      for (const [opType, count] of Object.entries(otherCounts)) {
        if (opType === 'CREATE') {
          parts.push('created ' + count + ' element' + (count !== 1 ? 's' : ''));
        } else if (opType === 'UPDATE') {
          parts.push('updated ' + count + ' element' + (count !== 1 ? 's' : ''));
        } else if (opType === 'DELETE') {
          parts.push('deleted ' + count + ' element' + (count !== 1 ? 's' : ''));
        } else {
          parts.push(count + ' ' + opType);
        }
      }

      return parts.length > 0 ? parts.join(', ') : 'No changes';
    }

    // ── Agent prompt handler ───────────────────────────────────────────────
    const addMessage = useCallback((msg) => {
      setAgentMessages(prev => [...prev, msg]);
    }, []);

    const updateLastStatus = useCallback((content) => {
      setAgentMessages(prev =>
        prev.map(m => m.type === 'status' ? { ...m, content } : m)
      );
    }, []);

    const handleSubmitPrompt = useCallback(async (prompt, language) => {
      if (!uploadedVideoPath) return;

      const userId   = `u-${Date.now()}`;
      const statusId = 'status';

      addMessage({ id: userId,   role: 'user',   type: 'user',   content: prompt,                    timestamp: new Date() });
      addMessage({ id: statusId, role: 'system', type: 'status', content: 'Generating operations…',  timestamp: new Date() });
      setIsProcessing(true);

      try {
        // If no transcript yet, server will transcribe. Pass cached transcript to skip.
        if (!cachedTranscript) {
          updateLastStatus('Extracting audio & transcribing…');
        }

        const res  = await fetch('/generate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            videoPath:     uploadedVideoPath,
            prompt,
            currentTracks: state.tracks,
            transcript:    cachedTranscript || null,
            language:      language || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Generation failed');

        // Cache the transcript for future prompts (avoid re-transcribing)
        if (data.transcript && !cachedTranscript) {
          setCachedTranscript(data.transcript);
        }

        // Apply the returned operations to the timeline
        dispatch({
          type:    'APPLY_OPERATIONS',
          payload: { operations: data.operations, promptText: prompt },
        });

        // Build summary, appending any warnings from failed audio searches
        let summary = summarizeOperations(data.operations);
        if (data.warnings && data.warnings.length > 0) {
          summary += ' (' + data.warnings.join('; ') + ')';
        }

        // Remove status bubble, add success bubble
        setAgentMessages(prev => [
          ...prev.filter(m => m.type !== 'status'),
          {
            id:        `r-${Date.now()}`,
            role:      'system',
            type:      'result',
            content:   { summary, prompt },
            timestamp: new Date(),
          },
        ]);

      } catch (err) {
        setAgentMessages(prev => [
          ...prev.filter(m => m.type !== 'status'),
          {
            id:        `e-${Date.now()}`,
            role:      'system',
            type:      'error',
            content:   err.message,
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsProcessing(false);
      }
    }, [uploadedVideoPath, state.tracks, cachedTranscript, addMessage, updateLastStatus]);

    // ── Preview position handler (from Properties panel typing) ───────────
    const handlePreviewPosition = useCallback(({ elementId, x, y }) => {
      setPreviewPosition(prev => {
        if (prev && prev.elementId === elementId && prev.x === x && prev.y === y) {
          return prev; // same values — same reference, no re-render triggered
        }
        return { elementId, x, y };
      });
    }, []);

    // ── Undo / Redo / UndoLastPrompt ──────────────────────────────────────
    const handleUndo = useCallback(() => dispatch({ type: 'UNDO' }),            []);
    const handleRedo = useCallback(() => dispatch({ type: 'REDO' }),            []);
    const handleUndoLastPrompt = useCallback(() => dispatch({ type: 'UNDO_LAST_PROMPT' }), []);

    const handleSplitElement = useCallback(() => {
      const elemId = selectedElementIdRef.current;
      const t      = currentTimeRef.current;
      if (elemId && t != null) {
        dispatch({ type: 'SPLIT_ELEMENT', payload: { elementId: elemId, splitTime: t } });
      }
    }, []);

    const handleReorderTrack = useCallback(({ trackType, fromIndex, toIndex }) => {
      dispatch({ type: 'REORDER_TRACK', payload: { trackType, fromIndex, toIndex } });
    }, []);

    const handleCreateTrack = useCallback(({ trackType }) => {
      dispatch({
        type:    'APPLY_OPERATIONS',
        payload: {
          operations: [{ op: 'CREATE_TRACK', trackType }],
          promptText: null,
        },
      });
    }, []);

    const handleDeleteTrack = useCallback(({ trackId }) => {
      dispatch({ type: 'DELETE_TRACK', payload: { trackId } });
    }, []);

    // ── Keyframe handlers ─────────────────────────────────────────────────

    const handleKeyframeSelect = useCallback((kf) => {
      // kf: { elementId, trackName, index } or null
      setSelectedKeyframe(kf);
    }, []);

    const handleAddKeyframe = useCallback((elementId, trackName, keyframe) => {
      dispatch({
        type:    'APPLY_OPERATIONS',
        payload: {
          operations: [{ op: 'ADD_KEYFRAME', elementId, trackName, keyframe }],
          promptText: null,
        },
      });
    }, []);

    const handleUpdateKeyframe = useCallback((elementId, trackName, index, changes) => {
      dispatch({
        type:    'APPLY_OPERATIONS',
        payload: {
          operations: [{ op: 'UPDATE_KEYFRAME', elementId, trackName, index, changes }],
          promptText: null,
        },
      });
      // If time changed the keyframe sort order is unpredictable — clear selection
      if (changes.time !== undefined) {
        setSelectedKeyframe(null);
      }
    }, []);

    const handleDeleteKeyframe = useCallback((elementId, trackName, index) => {
      dispatch({
        type:    'APPLY_OPERATIONS',
        payload: {
          operations: [{ op: 'DELETE_KEYFRAME', elementId, trackName, index }],
          promptText: null,
        },
      });
      setSelectedKeyframe(null);
    }, []);

    // ── Clipboard handlers (also used by ContextMenu) ─────────────────────
    const handleCopyElement = useCallback((elementId) => {
      const r = window.TimelineReducer.findElementById(stateTracksRef.current, elementId);
      if (r) setClipboard(r.element);
    }, []);

    const handleCutElement = useCallback((elementId) => {
      const r = window.TimelineReducer.findElementById(stateTracksRef.current, elementId);
      if (r) {
        setClipboard(r.element);
        dispatch({ type: 'DELETE_ELEMENT', payload: { elementId } });
        setSelectedElementId(null);
      }
    }, []);

    const handleDuplicateElement = useCallback((elementId) => {
      dispatch({ type: 'DUPLICATE_ELEMENT', payload: { elementId } });
    }, []);

    const handlePasteElement = useCallback((pasteTime, targetTrackId) => {
      const cb = clipboardRef.current;
      if (!cb) return;
      dispatch({ type: 'PASTE_ELEMENT', payload: { clipboardElement: cb, pasteTime: pasteTime || 0, targetTrackId: targetTrackId || null } });
    }, []);

    const handleContextMenu = useCallback((e, elementId, trackId) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, elementId: elementId || null, trackId: trackId || null });
    }, []);

    // ── Export handlers ───────────────────────────────────────────────────
    const handleExportStart = useCallback(() => {
      setExportJob(null);
      setExportModal(true);
    }, []);

    const handleExportClose = useCallback(() => {
      setExportModal(false);
      setExportJob(null);
    }, []);

    const handleExportSubmit = useCallback(async ({ format, quality, outputFilename }) => {
      try {
        setExportJob({ status: 'queued', progress: 0, filename: outputFilename });
        const res  = await fetch('/export', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ timelineState: state, outputFilename, format, quality }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Export failed');

        const { jobId } = data;
        setExportJob({ jobId, status: 'rendering', progress: 0, filename: outputFilename });

        // Poll for job status every 500 ms
        const poll = setInterval(async () => {
          try {
            const sr   = await fetch('/export/status/' + jobId);
            const sd   = await sr.json();
            if (sd.status === 'done') {
              clearInterval(poll);
              setExportJob({ jobId, status: 'done', progress: 100, filename: sd.filename || outputFilename });
            } else if (sd.status === 'error') {
              clearInterval(poll);
              setExportJob({ jobId, status: 'error', progress: 0, filename: outputFilename, error: sd.error });
            } else {
              setExportJob(prev => prev ? { ...prev, progress: sd.progress || prev.progress } : prev);
            }
          } catch (_) { /* ignore transient poll errors */ }
        }, 500);
      } catch (err) {
        setExportJob({ status: 'error', progress: 0, filename: outputFilename, error: err.message });
      }
    }, [state]);

    // ── Element / track handlers ──────────────────────────────────────────
    const handleElementSelect = useCallback((id) => setSelectedElementId(id), []);

    const handleMoveElement = useCallback(({ elementId, newStartTime, newEndTime, newTrackId }) => {
      dispatch({ type: 'MOVE_ELEMENT', payload: { elementId, newStartTime, newEndTime, newTrackId } });
    }, []);

    const handleUpdateElement = useCallback(({ elementId, changes }) => {
      dispatch({ type: 'UPDATE_ELEMENT', payload: { elementId, changes } });
    }, []);

    const handleDeleteElement = useCallback((elementId) => {
      dispatch({ type: 'DELETE_ELEMENT', payload: { elementId } });
      setSelectedElementId(null);
    }, []);

    const handleTrackVisibility = useCallback(({ trackId, visible }) => {
      dispatch({ type: 'SET_TRACK_VISIBILITY', payload: { trackId, visible } });
    }, []);

    const handleTrackLocked = useCallback(({ trackId, locked }) => {
      dispatch({ type: 'SET_TRACK_LOCKED', payload: { trackId, locked } });
    }, []);

    // ── Derive selected element for Properties panel ──────────────────────
    const selectedElement = selectedElementId
      ? (window.TimelineReducer.findElementById(state.tracks, selectedElementId) || null)
      : null;

    // ── Check if any prompt checkpoint exists (for Undo Last Prompt button) ─
    const hasPromptCheckpoint = state.history.past.some(e => e.isPromptCheckpoint);

    // ── Render ─────────────────────────────────────────────────────────────
    return (
      <div style={{
        display:             'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gridTemplateRows:    '40px calc(100vh - 260px) 220px',
        width:               '100vw',
        height:              '100vh',
        overflow:            'hidden',
        background:          '#111111',
      }}>

        {/* Header bar (row 1, all columns) */}
        {Header && (
          <div style={{ gridColumn: '1 / 4', gridRow: 1, borderBottom: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <Header
              projectName={state.project.name || 'Untitled Project'}
              onRenameProject={(name) => dispatch({ type: 'UPDATE_PROJECT_NAME', payload: { name } })}
              onExport={handleExportStart}
            />
          </div>
        )}

        {/* Column 1 — LeftPanel (row 2) */}
        <div style={{
          gridColumn:  1,
          gridRow:     2,
          borderRight: '1px solid rgba(255,255,255,0.08)',
          overflow:    'hidden',
        }}>
          <LeftPanel
            mediaItems={mediaItems}
            source={state.source}
            project={state.project}
            selectedElement={selectedElement ? migrateVideoClipElement(selectedElement.element) : null}
            selectedElementId={selectedElementId}
            selectedKeyframe={selectedKeyframe}
            audioFiles={audioFiles}
            onMediaImport={handleMediaImport}
            onMediaRemove={handleMediaRemove}
            onSetCurrentFile={handleSetCurrentFile}
            onUpdateElement={handleUpdateElement}
            onDeleteElement={handleDeleteElement}
            onPreviewPosition={handlePreviewPosition}
            onAudioImport={handleAudioImport}
            onAddAudioToTimeline={handleAddAudioToTimeline}
            onUpdateKeyframe={handleUpdateKeyframe}
            onDeleteKeyframe={handleDeleteKeyframe}
          />
        </div>

        {/* Column 2 — VideoPreview (row 2) */}
        <div style={{
          gridColumn:  2,
          gridRow:     2,
          borderRight: '1px solid rgba(255,255,255,0.08)',
          overflow:    'hidden',
        }}>
          <VideoPreview
            videoSrc={previewSrc}
            tracks={state.tracks}
            source={state.source}
            currentTime={state.playback.currentTime}
            isPlaying={state.playback.isPlaying}
            selectedElementId={selectedElementId}
            previewPosition={previewPosition}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onTimeUpdate={handleTimeUpdate}
            onElementSelect={handleElementSelect}
            onUpdateElement={handleUpdateElement}
          />
        </div>

        {/* Columns 1+2 — Timeline (row 3) */}
        <div style={{
          gridColumn: '1 / 3',
          gridRow:    3,
          borderTop:  '1px solid rgba(255,255,255,0.08)',
          overflow:   'hidden',
        }}>
          <Timeline
            tracks={state.tracks}
            currentTime={state.playback.currentTime}
            duration={state.playback.duration || state.source.duration || 60}
            zoom={timelineZoom}
            selectedElementId={selectedElementId}
            selectedKeyframe={selectedKeyframe}
            onZoomChange={setTimelineZoom}
            onSeek={handleSeek}
            onElementSelect={handleElementSelect}
            onMoveElement={handleMoveElement}
            onTrackVisibility={handleTrackVisibility}
            onTrackLocked={handleTrackLocked}
            onReorderTrack={handleReorderTrack}
            onCreateTrack={handleCreateTrack}
            onDeleteTrack={handleDeleteTrack}
            onSplitElement={handleSplitElement}
            onKeyframeSelect={handleKeyframeSelect}
            onAddKeyframe={handleAddKeyframe}
            onUpdateKeyframe={handleUpdateKeyframe}
            onDeleteKeyframe={handleDeleteKeyframe}
            onContextMenu={handleContextMenu}
          />
        </div>

        {/* Column 3 — AgentPanel (rows 2+3, below header) */}
        <div style={{
          gridColumn: 3,
          gridRow:    '2 / 4',
          overflow:   'hidden',
        }}>
          <AgentPanel
            messages={agentMessages}
            isProcessing={isProcessing}
            currentFile={uploadedFile ? { filename: uploadedFile.name } : null}
            hasPromptCheckpoint={hasPromptCheckpoint}
            onSubmitPrompt={handleSubmitPrompt}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onUndoLastPrompt={handleUndoLastPrompt}
          />
        </div>

        {/* Export modal */}
        {exportModal && ExportModal && (
          <ExportModal
            isOpen={exportModal}
            job={exportJob}
            projectName={state.project.name || 'Untitled Project'}
            onSubmit={handleExportSubmit}
            onClose={handleExportClose}
          />
        )}

        {/* Context menu (renders at fixed position over everything) */}
        {contextMenu && ContextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            elementId={contextMenu.elementId}
            trackId={contextMenu.trackId}
            pasteTime={state.playback.currentTime}
            hasClipboard={!!clipboard}
            onCopy={handleCopyElement}
            onCut={handleCutElement}
            onDuplicate={handleDuplicateElement}
            onDelete={handleDeleteElement}
            onPaste={handlePasteElement}
            onClose={() => setContextMenu(null)}
          />
        )}

      </div>
    );
  }

  // ── Mount ──────────────────────────────────────────────────────────────────
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(App));

})();
