// ─────────────────────────────────────────────────────────────────────────────
// Timeline.jsx
// CapCut-style timeline. Tracks, element blocks, playhead, track controls,
// keyframe visualization (value curve + diamond markers), and keyframe
// interactions (drag, click-to-add, double-click-to-delete, tooltip).
//
// Globals consumed:  React, LucideReact, window.TimelineReducer
// Sets global:       window.Timeline
// No import / export statements.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const { useState, useRef, useCallback, useEffect } = React;
  const { Lock, Unlock, Eye, EyeOff, GripVertical, Scissors, Plus, Trash2, Image } = LucideReact;

  // ── Constants ──────────────────────────────────────────────────────────────
  const HEADER_WIDTH = 100;   // px — left sidebar width
  const TRACK_HEIGHT = 36;    // px — height of each track row
  const RULER_HEIGHT = 24;    // px — ruler at the top
  const SNAP         = 0.1;   // seconds — drag snap increment

  // Element block colour by type
  const ELEMENT_COLORS = {
    videoClip: '#00695C',
    imageClip: 'rgba(138, 92, 246, 0.7)',
    subtitle:  '#1565C0',
    audioClip: '#1B5E20',
  };

  // Track type display labels (short, shown inside track header sidebar)
  const TRACK_LABELS = {
    video:    'VIDEO',
    image:    'IMG',
    subtitle: 'SUB',
    audio:    'AUDIO',
  };

  // Section header labels (full, shown once per track-type group)
  const SECTION_LABELS = {
    video:    'VIDEO',
    image:    'IMAGE LAYER',
    subtitle: 'SUBTITLES',
    audio:    'AUDIO',
  };

  // Section header accent colours (left border on section header)
  const SECTION_COLORS = {
    subtitle: '#1565C0',
    image:    '#8B5CF6',
    video:    '#00695C',
    audio:    '#1B5E20',
  };

  // Human-readable "Add X" button labels per track type
  const ADD_LABELS = {
    video:    'Add Video',
    image:    'Add Image Track',
    subtitle: 'Add Subtitle',
    audio:    'Add Audio',
  };

  // Per-track keyframe curve and diamond colours
  const KF_COLORS = {
    scale:   '#00BCD4',
    speed:   '#FFD700',
    volume:  '#00CC88',
    opacity: '#FF6B6B',
  };

  // ── Snap a time value to the nearest increment ─────────────────────────────
  function snapTime(t) {
    return Math.max(0, Math.round(t / SNAP) * SNAP);
  }

  // ── Format seconds as MM:SS ────────────────────────────────────────────────
  function fmtRuler(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ── normalizeValue: maps a track value to 0–1 for curve rendering ──────────
  // scale:   range 0.5–3.0
  // speed:   range 0.25–4.0
  // volume/opacity: already 0–1
  function normalizeValue(val, track) {
    var norm;
    switch (track) {
      case 'scale':   norm = (val - 0.5)  / 2.5;   break;
      case 'speed':   norm = (val - 0.25) / 3.75;  break;
      case 'volume':  norm = val;                   break;
      case 'opacity': norm = val;                   break;
      default:        norm = val;
    }
    var n = isNaN(norm) ? 0 : norm;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  // ── Format keyframe value for tooltip ─────────────────────────────────────
  function fmtKFValue(val, track) {
    switch (track) {
      case 'scale':   return 'Scale: '   + Math.round(val * 100) + '%';
      case 'speed':   return 'Speed: '   + val.toFixed(2) + 'x';
      case 'volume':  return 'Volume: '  + Math.round(val * 100) + '%';
      case 'opacity': return 'Opacity: ' + Math.round(val * 100) + '%';
      default:        return String(val);
    }
  }

  // ── Ruler component ────────────────────────────────────────────────────────
  function Ruler({ duration, zoom, onSeek }) {
    const marks = [];
    const interval = zoom < 30 ? 10 : zoom < 80 ? 5 : zoom < 150 ? 2 : 1;
    for (var t = 0; t <= duration + interval; t += interval) {
      var x = t * zoom;
      marks.push(
        <div
          key={t}
          style={{
            position:      'absolute',
            left:          x,
            top:           0,
            height:        RULER_HEIGHT,
            display:       'flex',
            alignItems:    'flex-end',
            paddingBottom: 2,
            userSelect:    'none',
          }}
        >
          <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 8, background: '#444' }} />
          <span style={{ color: '#666', fontSize: 9, marginLeft: 2, whiteSpace: 'nowrap' }}>
            {fmtRuler(t)}
          </span>
        </div>
      );
    }

    function handleClick(e) {
      var rect = e.currentTarget.getBoundingClientRect();
      var x    = e.clientX - rect.left;
      onSeek && onSeek(snapTime(x / zoom));
    }

    return (
      <div
        onClick={handleClick}
        style={{
          position:   'relative',
          height:     RULER_HEIGHT,
          background: '#111111',
          cursor:     'pointer',
          overflow:   'hidden',
          flexShrink: 0,
          minWidth:   duration * zoom,
        }}
      >
        {marks}
      </div>
    );
  }

  // ── ElementBlock ────────────────────────────────────────────────────────────
  // Renders one element on a track row. For selected videoClip elements,
  // renders the keyframe value curve (SVG polyline), diamond markers,
  // hover tooltip, ghost diamond, split preview line, and inline delete
  // confirmation. Handles keyframe drag, click-to-add, double-click-to-delete.
  function ElementBlock({
    element, zoom, isSelected, currentTime,
    onSelect, onDragStart,
    activeKeyframeTrack, displayKFTrack, selectedKeyframe,
    onKeyframeSelect, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
    onContextMenu, trackId,
  }) {
    var left         = element.startTime * zoom;
    var width        = Math.max(4, (element.endTime - element.startTime) * zoom);
    var clipDuration = element.endTime - element.startTime;
    var color        = ELEMENT_COLORS[element.type] || '#555555';
    var label        = element.text || element.originalFilename || element.sourceName || element.type || '';

    // Local UI state for keyframe interaction
    var [hoveredKF,     setHoveredKF]     = useState(null);   // { index, x, y } viewport coords
    var [ghostX,        setGhostX]        = useState(null);   // px within block for ghost diamond
    var [kfDragTime,    setKfDragTime]    = useState(null);   // { index, time } during KF drag
    var [confirmDelIdx, setConfirmDelIdx] = useState(null);   // index of KF awaiting confirmation

    var kfDragRef   = useRef(null);
    var clickStartX = useRef(null);

    var supportsKeyframeCurve = (element.type === 'videoClip' || element.type === 'imageClip') && !!element.keyframes;
    // displayKFTrack is 'scale'/'opacity' even when activeKeyframeTrack is 'none'
    var _displayTrack = displayKFTrack || activeKeyframeTrack;
    var kfArray       = supportsKeyframeCurve ? (element.keyframes[_displayTrack] || []) : [];
    var interpolate   = window.TimelineReducer && window.TimelineReducer.interpolateKeyframes;
    var trackColor    = KF_COLORS[_displayTrack] || '#00BCD4';
    var blockH      = TRACK_HEIGHT - 4;
    var diamondY    = blockH / 2;

    // ── Split preview line ─────────────────────────────────────────────────
    var playheadWithin = isSelected
      && currentTime > element.startTime
      && currentTime < element.endTime;
    var splitLineX = playheadWithin ? (currentTime - element.startTime) * zoom : null;

    // ── Build SVG curve polyline points ────────────────────────────────────
    function buildCurvePoints() {
      if (!isSelected || !interpolate || kfArray.length === 0) return '';
      var N = Math.max(2, Math.min(100, Math.floor(width)));
      var pts = [];
      for (var i = 0; i <= N; i++) {
        var localT = (i / N) * clipDuration;
        var val    = interpolate(kfArray, localT);
        var norm   = normalizeValue(val, _displayTrack);
        var x      = (i / N) * width;
        var y      = blockH - (norm * blockH * 0.8 + blockH * 0.1);
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
      }
      return pts.join(' ');
    }

    // ── Build SVG fill polygon points (curve + bottom edge closed) ─────────
    function buildFillPoints() {
      if (!isSelected || !interpolate || kfArray.length === 0) return '';
      var N = Math.max(2, Math.min(100, Math.floor(width)));
      var pts = [];
      for (var i = 0; i <= N; i++) {
        var localT = (i / N) * clipDuration;
        var val    = interpolate(kfArray, localT);
        var norm   = normalizeValue(val, _displayTrack);
        var x      = (i / N) * width;
        var y      = blockH - (norm * blockH * 0.8 + blockH * 0.1);
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
      }
      pts.push(width.toFixed(1) + ',' + blockH);
      pts.push('0,' + blockH);
      return pts.join(' ');
    }

    // ── Resolve diamond x position (uses drag time if dragging this index) ─
    function getDiamondX(kf, idx) {
      if (kfDragTime && kfDragTime.index === idx) {
        return kfDragTime.time * zoom;
      }
      return kf.time * zoom;
    }

    // ── Keyframe drag start ────────────────────────────────────────────────
    function handleDiamondMouseDown(e, kfIdx) {
      e.stopPropagation();
      e.preventDefault();
      var kf = kfArray[kfIdx];
      if (!kf) return;
      kfDragRef.current = { kfIdx: kfIdx, origTime: kf.time, startX: e.clientX };
      setKfDragTime({ index: kfIdx, time: kf.time });

      function onMove(ev) {
        var drag = kfDragRef.current;
        if (!drag) return;
        var dx      = ev.clientX - drag.startX;
        var newTime = snapTime(drag.origTime + dx / zoom);
        newTime = newTime < 0 ? 0 : newTime > clipDuration ? clipDuration : newTime;
        // Clamp between adjacent keyframes
        if (kfIdx > 0 && kfArray[kfIdx - 1]) {
          var minT = kfArray[kfIdx - 1].time + SNAP;
          if (newTime < minT) newTime = minT;
        }
        if (kfIdx < kfArray.length - 1 && kfArray[kfIdx + 1]) {
          var maxT = kfArray[kfIdx + 1].time - SNAP;
          if (newTime > maxT) newTime = maxT;
        }
        setKfDragTime({ index: drag.kfIdx, time: newTime });
      }

      function onUp(ev) {
        var drag = kfDragRef.current;
        if (drag) {
          var dx      = ev.clientX - drag.startX;
          var newTime = snapTime(drag.origTime + dx / zoom);
          newTime = newTime < 0 ? 0 : newTime > clipDuration ? clipDuration : newTime;
          if (kfIdx > 0 && kfArray[kfIdx - 1]) {
            var minT = kfArray[kfIdx - 1].time + SNAP;
            if (newTime < minT) newTime = minT;
          }
          if (kfIdx < kfArray.length - 1 && kfArray[kfIdx + 1]) {
            var maxT = kfArray[kfIdx + 1].time - SNAP;
            if (newTime > maxT) newTime = maxT;
          }
          if (Math.abs(newTime - drag.origTime) > 0.001 && onUpdateKeyframe) {
            onUpdateKeyframe(element.id, _displayTrack, drag.kfIdx, { time: newTime });
          }
        }
        kfDragRef.current = null;
        setKfDragTime(null);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup',   onUp);
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup',   onUp);
    }

    // ── Diamond single click: select keyframe ─────────────────────────────
    function handleDiamondClick(e, kfIdx) {
      e.stopPropagation();
      onKeyframeSelect && onKeyframeSelect({ elementId: element.id, trackName: _displayTrack, index: kfIdx });
    }

    // ── Diamond double-click: delete (inline confirmation if last) ─────────
    function handleDiamondDoubleClick(e, kfIdx) {
      e.stopPropagation();
      if (kfArray.length <= 1) {
        setConfirmDelIdx(kfIdx);
      } else {
        onDeleteKeyframe && onDeleteKeyframe(element.id, _displayTrack, kfIdx);
        onKeyframeSelect && onKeyframeSelect(null);
      }
    }

    // ── Element block mouse down: start element drag ───────────────────────
    function handleBlockMouseDown(e) {
      if (e.target.closest('[data-kf-diamond]')) return;
      clickStartX.current = e.clientX;
      e.stopPropagation();
      onSelect(element.id);
      onDragStart(e, element);
    }

    // ── Element block click: add keyframe at click position ───────────────
    function handleBlockClick(e) {
      if (!isSelected || !supportsKeyframeCurve || !onAddKeyframe) return;
      if (activeKeyframeTrack === 'none') return;
      if (e.target.closest('[data-kf-diamond]')) return;
      // Guard: don't add if mouse moved during mousedown (drag in progress)
      if (clickStartX.current !== null && Math.abs(e.clientX - clickStartX.current) > 3) return;
      var rect      = e.currentTarget.getBoundingClientRect();
      var localX    = e.clientX - rect.left;
      var localTime = snapTime(Math.max(0, Math.min(clipDuration, localX / zoom)));
      // Skip if too close to an existing keyframe on this track
      var tooClose = kfArray.some(function(kf) { return Math.abs(kf.time - localTime) < SNAP; });
      if (tooClose) return;
      var value = (interpolate && kfArray.length > 0) ? interpolate(kfArray, localTime) : 1.0;
      onAddKeyframe(element.id, activeKeyframeTrack, { time: localTime, value: value, easing: 'linear' });
    }

    // ── Element block mouse move: update ghost diamond position ───────────
    function handleBlockMouseMove(e) {
      if (!isSelected || !supportsKeyframeCurve) { if (ghostX !== null) setGhostX(null); return; }
      if (e.target.closest('[data-kf-diamond]')) { if (ghostX !== null) setGhostX(null); return; }
      var rect   = e.currentTarget.getBoundingClientRect();
      var localX = e.clientX - rect.left;
      setGhostX(localX);
    }

    function handleBlockMouseLeave() {
      setGhostX(null);
    }

    return (
      <div
        data-element-id={element.id}
        onMouseDown={handleBlockMouseDown}
        onClick={handleBlockClick}
        onMouseMove={handleBlockMouseMove}
        onMouseLeave={handleBlockMouseLeave}
        onContextMenu={function(e) {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu && onContextMenu(e, element.id, trackId);
        }}
        style={{
          position:      'absolute',
          left:          left,
          top:           2,
          width:         width,
          height:        blockH,
          background:    color,
          borderRadius:  4,
          cursor:        (isSelected && supportsKeyframeCurve && activeKeyframeTrack !== 'none') ? 'crosshair' : 'grab',
          overflow:      'hidden',
          boxSizing:     'border-box',
          outline:       isSelected ? '2px solid #00BCD4' : 'none',
          outlineOffset: isSelected ? '-2px' : 0,
          userSelect:    'none',
          display:       'flex',
          alignItems:    'center',
        }}
      >
        {/* ── Label ─────────────────────────────────────────────────────── */}
        <span style={{
          color:         'rgba(255,255,255,0.85)',
          fontSize:      10,
          padding:       '0 6px',
          overflow:      'hidden',
          textOverflow:  'ellipsis',
          whiteSpace:    'nowrap',
          maxWidth:      '100%',
          position:      'relative',
          zIndex:        2,
          pointerEvents: 'none',
        }}>
          {label}
        </span>

        {/* ── imageClip source badges (PIX / IMG / NAT) ─────────────────── */}
        {element.type === 'imageClip' && (function() {
          var st = element.sourceType;
          var badge = null;
          if (st === 'pixabay' || st === 'pexels') {
            badge = { text: 'PIX', bg: 'rgba(139, 92, 246, 0.85)', fg: '#fff' };
          } else if (st === 'native') {
            badge = { text: 'NAT', bg: 'rgba(245, 158, 11, 0.9)', fg: '#111' };
          } else if (st === 'upload' && element.isImage) {
            badge = { text: 'IMG', bg: 'rgba(45, 212, 191, 0.85)', fg: '#042f2e' };
          }
          if (!badge) return null;
          return (
            <span style={{
              position:      'absolute',
              top:           2,
              right:         4,
              fontSize:      8,
              fontWeight:    700,
              color:         badge.fg,
              background:    badge.bg,
              borderRadius:  2,
              padding:       '1px 4px',
              userSelect:    'none',
              pointerEvents: 'none',
              zIndex:        3,
              letterSpacing: 0.3,
            }}>
              {badge.text}
            </span>
          );
        })()}

        {/* ── SVG value curve (selected videoClip only) ─────────────────── */}
        {isSelected && supportsKeyframeCurve && kfArray.length > 0 && (
          <svg
            style={{
              position:      'absolute',
              inset:         0,
              width:         '100%',
              height:        '100%',
              pointerEvents: 'none',
              zIndex:        1,
            }}
            preserveAspectRatio="none"
            viewBox={'0 0 ' + width + ' ' + blockH}
          >
            <polygon
              points={buildFillPoints()}
              fill={trackColor}
              fillOpacity={0.15}
            />
            <polyline
              points={buildCurvePoints()}
              fill="none"
              stroke={trackColor}
              strokeWidth={1.5}
            />
          </svg>
        )}

        {/* ── Keyframe diamonds ────────────────────────────────────────── */}
        {isSelected && supportsKeyframeCurve && kfArray.map(function(kf, i) {
          var dx = getDiamondX(kf, i);
          var isKFSel = selectedKeyframe
            && selectedKeyframe.elementId === element.id
            && selectedKeyframe.trackName === _displayTrack
            && selectedKeyframe.index     === i;
          var isHov = hoveredKF && hoveredKF.index === i;

          return (
            <div
              key={i}
              data-kf-diamond="1"
              onMouseDown={function(e) { handleDiamondMouseDown(e, i); }}
              onClick={function(e) { handleDiamondClick(e, i); }}
              onDoubleClick={function(e) { handleDiamondDoubleClick(e, i); }}
              onMouseEnter={function(e) { setHoveredKF({ index: i, x: e.clientX, y: e.clientY }); }}
              onMouseLeave={function() { setHoveredKF(null); }}
              style={{
                position:      'absolute',
                left:          dx - 4,
                top:           diamondY - 4,
                width:         8,
                height:        8,
                background:    isKFSel ? '#ffffff' : trackColor,
                border:        isKFSel
                  ? '2px solid ' + trackColor
                  : '1px solid rgba(255,255,255,0.9)',
                transform:     isHov ? 'rotate(45deg) scale(1.3)' : 'rotate(45deg)',
                cursor:        'pointer',
                zIndex:        3,
                transition:    'transform 80ms ease',
                pointerEvents: 'auto',
              }}
            />
          );
        })}

        {/* ── Ghost diamond (hover over empty clip area) ────────────────── */}
        {isSelected && supportsKeyframeCurve && activeKeyframeTrack !== 'none' && ghostX !== null && (function() {
          var localT = ghostX / zoom;
          var onExisting = kfArray.some(function(kf) {
            return Math.abs(kf.time - snapTime(localT)) < SNAP;
          });
          if (onExisting) return null;
          return (
            <div
              key="ghost"
              style={{
                position:      'absolute',
                left:          ghostX - 4,
                top:           diamondY - 4,
                width:         8,
                height:        8,
                background:    'transparent',
                border:        '1px dashed ' + trackColor,
                transform:     'rotate(45deg)',
                pointerEvents: 'none',
                zIndex:        3,
                opacity:       0.6,
              }}
            />
          );
        })()}

        {/* ── Split preview line ────────────────────────────────────────── */}
        {splitLineX !== null && (
          <div style={{
            position:      'absolute',
            left:          splitLineX,
            top:           0,
            width:         1,
            height:        '100%',
            borderLeft:    '1px dashed rgba(255,255,255,0.6)',
            pointerEvents: 'none',
            zIndex:        4,
          }} />
        )}

        {/* ── Inline delete confirmation (only shown if last keyframe) ───── */}
        {confirmDelIdx !== null && (
          <div
            style={{
              position:       'absolute',
              left:           0, top: 0, right: 0, bottom: 0,
              background:     'rgba(0,0,0,0.88)',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            5,
              zIndex:         10,
              padding:        '0 4px',
            }}
            onMouseDown={function(e) { e.stopPropagation(); }}
            onClick={function(e) { e.stopPropagation(); }}
          >
            <span style={{ color: '#ccc', fontSize: 9, whiteSpace: 'nowrap' }}>Reset track?</span>
            <button
              style={{ background: '#FF3B30', border: 'none', borderRadius: 3, color: '#fff', fontSize: 9, padding: '2px 5px', cursor: 'pointer' }}
              onClick={function(e) {
                e.stopPropagation();
                onDeleteKeyframe && onDeleteKeyframe(element.id, _displayTrack, confirmDelIdx);
                onKeyframeSelect && onKeyframeSelect(null);
                setConfirmDelIdx(null);
              }}
            >Yes</button>
            <button
              style={{ background: '#333', border: 'none', borderRadius: 3, color: '#aaa', fontSize: 9, padding: '2px 5px', cursor: 'pointer' }}
              onClick={function(e) { e.stopPropagation(); setConfirmDelIdx(null); }}
            >No</button>
          </div>
        )}

        {/* ── Hover tooltip (position:fixed — not clipped by overflow:hidden) ─ */}
        {hoveredKF !== null && (function() {
          var kf = kfArray[hoveredKF.index];
          if (!kf) return null;
          var dispVal = (kfDragTime && kfDragTime.index === hoveredKF.index) ? kfDragTime.time : kf.time;
          var dispKF  = (kfDragTime && kfDragTime.index === hoveredKF.index)
            ? { value: kf.value, time: kfDragTime.time }
            : kf;
          return (
            <div
              style={{
                position:      'fixed',
                top:           hoveredKF.y - 34,
                left:          hoveredKF.x - 55,
                background:    'rgba(0,0,0,0.82)',
                border:        '1px solid rgba(255,255,255,0.15)',
                borderRadius:  4,
                padding:       '3px 8px',
                color:         trackColor,
                fontSize:      11,
                fontFamily:    'monospace',
                letterSpacing: 0.3,
                whiteSpace:    'nowrap',
                pointerEvents: 'none',
                zIndex:        9999,
                userSelect:    'none',
              }}
            >
              {fmtKFValue(dispKF.value, _displayTrack)} @ {dispKF.time.toFixed(1)}s
            </div>
          );
        })()}
      </div>
    );
  }

  // ── TrackRow ──────────────────────────────────────────────────────────────
  function TrackRow({
    track, trackType, trackCount, zoom, duration, currentTime,
    selectedElementId, onElementSelect, onDragStart,
    onTrackVisibility, onTrackLocked, onDeleteTrack,
    isDragging, isDropTarget, elementDragTargetId, onTrackDragStart,
    activeKeyframeTrack, displayKFTrack, selectedKeyframe,
    onKeyframeSelect, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
    onContextMenu,
  }) {
    var label = TRACK_LABELS[trackType] || trackType.toUpperCase();
    var [headerHovered, setHeaderHovered] = useState(false);
    var canDelete = trackCount > 1 && track.elements.length === 0;
    var showDeleteBtn = trackCount > 1;

    return (
      <div style={{
        display:      'flex',
        height:       TRACK_HEIGHT,
        flexShrink:   0,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        borderTop:    isDropTarget ? '2px solid #00BCD4' : undefined,
        opacity:      isDragging ? 0.4 : 1,
        transition:   'opacity 100ms ease',
      }}>
        {/* Track header */}
        <div
          onMouseEnter={function() { setHeaderHovered(true); }}
          onMouseLeave={function() { setHeaderHovered(false); }}
          style={{
            width:          HEADER_WIDTH,
            flexShrink:     0,
            background:     '#111111',
            borderRight:    '1px solid rgba(255,255,255,0.08)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            padding:        '0 4px 0 2px',
            gap:            2,
          }}
        >
          <div
            onMouseDown={function(e) { onTrackDragStart && onTrackDragStart(e, trackType, track.index); }}
            style={{ cursor: 'grab', color: headerHovered ? '#666' : '#2a2a2a', display: 'flex', alignItems: 'center', flexShrink: 0, padding: '0 1px', transition: 'color 100ms ease' }}
            title="Drag to reorder"
          >
            <GripVertical size={10} />
          </div>
          {trackType === 'image' && (
            <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: '#A78BFA', marginRight: 2 }} title="Image layer">
              <Image size={11} />
            </span>
          )}
          <span style={{
            color:         track.visible ? '#888' : '#444',
            fontSize:      9,
            fontWeight:    600,
            letterSpacing: 0.5,
            userSelect:    'none',
            flex:          1,
            overflow:      'hidden',
            textOverflow:  'ellipsis',
            whiteSpace:    'nowrap',
            maxWidth:      55,
          }}
            title={track.name || label}
          >
            {track.name || label}
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              onClick={function() { onTrackVisibility({ trackId: track.id, visible: !track.visible }); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: track.visible ? '#666' : '#333', padding: 2, display: 'flex', alignItems: 'center' }}
              title={track.visible ? 'Hide track' : 'Show track'}
            >
              {track.visible ? <Eye size={10} /> : <EyeOff size={10} />}
            </button>
            <button
              onClick={function() { onTrackLocked({ trackId: track.id, locked: !track.locked }); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: track.locked ? '#FF9800' : '#666', padding: 2, display: 'flex', alignItems: 'center' }}
              title={track.locked ? 'Unlock track' : 'Lock track'}
            >
              {track.locked ? <Lock size={10} /> : <Unlock size={10} />}
            </button>
            {showDeleteBtn && (
              <button
                onClick={function() { if (canDelete) onDeleteTrack && onDeleteTrack({ trackId: track.id }); }}
                style={{
                  background:  'none',
                  border:      'none',
                  cursor:      canDelete ? 'pointer' : 'default',
                  color:       canDelete ? '#555' : '#2a2a2a',
                  padding:     2,
                  display:     'flex',
                  alignItems:  'center',
                  opacity:     headerHovered ? 1 : 0,
                  transition:  'color 100ms ease, opacity 100ms ease',
                }}
                title={canDelete ? 'Delete track' : 'Remove elements first'}
                onMouseEnter={function(e) { if (canDelete) e.currentTarget.style.color = '#FF6B6B'; }}
                onMouseLeave={function(e) { e.currentTarget.style.color = canDelete ? '#555' : '#2a2a2a'; }}
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        </div>

        {/* Element area */}
        <div
          data-track-id={track.id}
          data-track-type={trackType}
          style={{
            flex:       1,
            position:   'relative',
            minWidth:   duration * zoom,
            opacity:    track.visible ? 1 : 0.3,
            background: track.elements.length === 0 ? 'rgba(255,255,255,0.01)' : 'transparent',
            outline:    elementDragTargetId === track.id ? '2px solid rgba(0,188,212,0.6)' : undefined,
          }}
          onContextMenu={function(e) {
            e.preventDefault();
            onContextMenu && onContextMenu(e, null, track.id);
          }}
        >
          {track.elements.map(function(el) {
            return (
              <ElementBlock
                key={el.id}
                element={el}
                zoom={zoom}
                isSelected={selectedElementId === el.id}
                currentTime={currentTime}
                onSelect={function(id) { if (!track.locked) onElementSelect(id); }}
                onDragStart={function(e, elem) { if (!track.locked) onDragStart(e, elem, track.id, trackType); }}
                activeKeyframeTrack={activeKeyframeTrack}
                displayKFTrack={displayKFTrack}
                selectedKeyframe={selectedKeyframe}
                onKeyframeSelect={onKeyframeSelect}
                onAddKeyframe={onAddKeyframe}
                onUpdateKeyframe={onUpdateKeyframe}
                onDeleteKeyframe={onDeleteKeyframe}
                onContextMenu={onContextMenu}
                trackId={track.id}
              />
            );
          })}
          {track.elements.length === 0 && (
            <div style={{
              position:      'absolute',
              inset:         0,
              display:       'flex',
              alignItems:    'center',
              justifyContent:'center',
              color:         '#333',
              fontSize:      10,
              fontStyle:     'italic',
              pointerEvents: 'none',
              userSelect:    'none',
            }}>
              Empty — drag elements here or use AI
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── TrackSection ──────────────────────────────────────────────────────────
  function TrackSection({
    trackType, trackArray, zoom, duration, currentTime,
    selectedElementId, onElementSelect, onDragStart,
    onTrackVisibility, onTrackLocked, onCreateTrack, onDeleteTrack,
    trackDrag, onTrackDragStart,
    activeKeyframeTrack, displayKFTrack, selectedKeyframe,
    onKeyframeSelect, onAddKeyframe, onUpdateKeyframe, onDeleteKeyframe,
    onContextMenu, elementDragTargetId,
  }) {
    if (!trackArray || trackArray.length === 0) return null;
    var sectionLabel = SECTION_LABELS[trackType] || trackType.toUpperCase();
    var addLabel     = ADD_LABELS[trackType]     || ('Add ' + trackType);
    var [addHovered, setAddHovered] = useState(false);

    var sectionColor = SECTION_COLORS[trackType] || '#555';

    return (
      <div>
        {/* Section header row */}
        <div style={{
          display:     'flex',
          height:      20,
          flexShrink:  0,
          alignItems:  'center',
          background:  'rgba(255,255,255,0.02)',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          borderLeft:  '2px solid ' + sectionColor,
        }}>
          <div style={{ width: HEADER_WIDTH - 2, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px' }}>
            <span style={{ color: sectionColor, fontSize: 8, fontWeight: 700, letterSpacing: 1, userSelect: 'none', textTransform: 'uppercase' }}>
              {sectionLabel}
            </span>
            <button
              onClick={function() { onCreateTrack && onCreateTrack({ trackType: trackType }); }}
              onMouseEnter={function() { setAddHovered(true); }}
              onMouseLeave={function() { setAddHovered(false); }}
              style={{
                background:  'none',
                border:      'none',
                cursor:      'pointer',
                color:       addHovered ? '#aaa' : '#555',
                display:     'flex',
                alignItems:  'center',
                gap:         2,
                padding:     '0 2px',
                fontSize:    9,
                height:      16,
                transition:  'color 100ms ease',
                userSelect:  'none',
              }}
              title={addLabel}
            >
              <Plus size={9} />
              {addLabel}
            </button>
          </div>
          {/* Spacer matching the scrollable track area */}
          <div style={{ flex: 1 }} />
        </div>

        {trackArray.map(function(track) {
          var isDragging   = trackDrag && trackDrag.trackType === trackType && trackDrag.fromIndex === track.index;
          var isDropTarget = trackDrag && trackDrag.trackType === trackType && trackDrag.toIndex   === track.index && !isDragging;
          return (
            <TrackRow
              key={track.id}
              track={track}
              trackType={trackType}
              trackCount={trackArray.length}
              zoom={zoom}
              duration={duration}
              currentTime={currentTime}
              selectedElementId={selectedElementId}
              onElementSelect={onElementSelect}
              onDragStart={onDragStart}
              onTrackVisibility={onTrackVisibility}
              onTrackLocked={onTrackLocked}
              onDeleteTrack={onDeleteTrack}
              isDragging={isDragging}
              isDropTarget={isDropTarget}
              elementDragTargetId={elementDragTargetId}
              onTrackDragStart={onTrackDragStart}
              activeKeyframeTrack={activeKeyframeTrack}
              displayKFTrack={displayKFTrack}
              selectedKeyframe={selectedKeyframe}
              onKeyframeSelect={onKeyframeSelect}
              onAddKeyframe={onAddKeyframe}
              onUpdateKeyframe={onUpdateKeyframe}
              onDeleteKeyframe={onDeleteKeyframe}
              onContextMenu={onContextMenu}
            />
          );
        })}
      </div>
    );
  }

  // ── Playhead ──────────────────────────────────────────────────────────────
  function Playhead({ currentTime, zoom, totalHeight }) {
    var x = currentTime * zoom;
    return (
      <div style={{
        position:      'absolute',
        left:          x,
        top:           0,
        width:         2,
        height:        totalHeight,
        background:    '#FF4444',
        pointerEvents: 'none',
        zIndex:        10,
      }}>
        <div style={{
          position:   'absolute',
          top:        -1,
          left:       -4,
          width:      10,
          height:     10,
          background: '#FF4444',
          clipPath:   'polygon(50% 100%, 0 0, 100% 0)',
        }} />
      </div>
    );
  }

  // ── Main Timeline component ────────────────────────────────────────────────
  function Timeline({
    tracks            = null,
    currentTime       = 0,
    duration          = 60,
    zoom              = 80,
    selectedElementId = null,
    selectedKeyframe  = null,
    onZoomChange,
    onSeek,
    onElementSelect,
    onMoveElement,
    onTrackVisibility,
    onTrackLocked,
    onReorderTrack,
    onCreateTrack,
    onDeleteTrack,
    onSplitElement,
    onKeyframeSelect,
    onAddKeyframe,
    onUpdateKeyframe,
    onDeleteKeyframe,
    onContextMenu,
  }) {
    var containerRef  = useRef(null);
    var scrollAreaRef = useRef(null);
    var dragRef       = useRef(null);
    var trackDragRef  = useRef(null);
    var [trackDrag,           setTrackDrag]           = useState(null);
    var [elementDragTargetId, setElementDragTargetId] = useState(null);

    // Keyframe track selector — shown when a videoClip or imageClip is selected
    // 'none' = no-keyframe mode (clicking clips does not add keyframes).
    var [activeKeyframeTrack, setActiveKeyframeTrack] = useState('none');
    // Tracks the last non-'none' selection so diamonds remain visible in 'none' mode
    var [lastActiveKFTrack, setLastActiveKFTrack] = useState('scale');

    var selectedIsImageClip = (function() {
      if (!tracks || !selectedElementId) return false;
      var ttypes = Object.keys(tracks);
      for (var ti = 0; ti < ttypes.length; ti++) {
        var tt = ttypes[ti];
        for (var tri = 0; tri < tracks[tt].length; tri++) {
          var tr = tracks[tt][tri];
          for (var ei = 0; ei < tr.elements.length; ei++) {
            var el = tr.elements[ei];
            if (el.id === selectedElementId && el.type === 'imageClip') return true;
          }
        }
      }
      return false;
    })();

    // Selected element uses timeline keyframe curve UI (videoClip or imageClip)
    var selectedIsVideoClip = (function() {
      if (!tracks || !selectedElementId) return false;
      var ttypes = Object.keys(tracks);
      for (var ti = 0; ti < ttypes.length; ti++) {
        var tt = ttypes[ti];
        for (var tri = 0; tri < tracks[tt].length; tri++) {
          var tr = tracks[tt][tri];
          for (var ei = 0; ei < tr.elements.length; ei++) {
            var el = tr.elements[ei];
            if (el.id === selectedElementId && (el.type === 'videoClip' || el.type === 'imageClip')) return true;
          }
        }
      }
      return false;
    })();

    var KF_TRACK_OPTIONS = selectedIsImageClip
      ? [
        { value: 'none',    label: '— None'  },
        { value: 'opacity', label: 'Opacity' },
      ]
      : [
        { value: 'none',    label: '— None'  },
        { value: 'scale',   label: 'Scale'   },
        { value: 'opacity', label: 'Opacity' },
      ];

    // Guard: coerce invalid / disallowed track names (imageClip has no scale curve)
    var safeKFTrack = (function() {
      var v = activeKeyframeTrack;
      if (selectedIsImageClip) {
        if (v === 'scale') return 'opacity';
        return ['none', 'opacity'].includes(v) ? v : 'none';
      }
      return ['none', 'scale', 'opacity'].includes(v) ? v : 'none';
    })();

    // For rendering: never 'none' — falls back to last active track (opacity for image clips)
    var displayKFTrack = safeKFTrack === 'none'
      ? (selectedIsImageClip ? 'opacity' : lastActiveKFTrack)
      : safeKFTrack;

    useEffect(function() {
      if (selectedIsImageClip && activeKeyframeTrack === 'scale') {
        setActiveKeyframeTrack('opacity');
        setLastActiveKFTrack('opacity');
      }
    }, [selectedIsImageClip, activeKeyframeTrack, selectedElementId]);

    // ── Scroll playhead into view ──────────────────────────────────────────
    useEffect(function() {
      var el = scrollAreaRef.current;
      if (!el) return;
      var playheadX = currentTime * zoom;
      var viewStart = el.scrollLeft;
      var viewEnd   = viewStart + el.clientWidth - HEADER_WIDTH;
      if (playheadX > viewEnd - 20 || playheadX < viewStart + 20) {
        el.scrollLeft = Math.max(0, playheadX - (el.clientWidth - HEADER_WIDTH) / 2);
      }
    }, [currentTime, zoom]);

    // ── Element drag handlers ──────────────────────────────────────────────
    function handleDragStart(e, element, trackId, trackType) {
      e.preventDefault();
      dragRef.current = {
        elementId:  element.id,
        trackId:    trackId,
        trackType:  trackType,
        origStart:  element.startTime,
        duration:   element.endTime - element.startTime,
        startX:     e.clientX,
        startY:     e.clientY,
        scrollLeft: scrollAreaRef.current ? scrollAreaRef.current.scrollLeft : 0,
        pendingTargetTrackId: null,
      };
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup',   handleDragEnd);
    }

    var handleDragMove = useCallback(function(e) {
      if (!dragRef.current) return;
      var scrollEl   = scrollAreaRef.current;
      var scrollDiff = scrollEl ? scrollEl.scrollLeft - dragRef.current.scrollLeft : 0;
      var dx         = e.clientX - dragRef.current.startX + scrollDiff;
      var newStart   = snapTime(Math.max(0, dragRef.current.origStart + dx / zoom));
      var domEl = document.querySelector('[data-element-id="' + dragRef.current.elementId + '"]');
      if (domEl) domEl.style.left = (newStart * zoom) + 'px';

      // C4: detect cross-track drag target via elementFromPoint + data-track-type
      var targetEl  = document.elementFromPoint(e.clientX, e.clientY);
      var trackArea = targetEl ? targetEl.closest('[data-track-id]') : null;
      if (trackArea) {
        var tType = trackArea.getAttribute('data-track-type');
        var tId   = trackArea.getAttribute('data-track-id');
        if (tType === dragRef.current.trackType && tId !== dragRef.current.trackId) {
          dragRef.current.pendingTargetTrackId = tId;
          setElementDragTargetId(tId);
        } else {
          dragRef.current.pendingTargetTrackId = null;
          setElementDragTargetId(null);
        }
      } else {
        dragRef.current.pendingTargetTrackId = null;
        setElementDragTargetId(null);
      }
    }, [zoom]);

    var handleDragEnd = useCallback(function(e) {
      if (!dragRef.current) return;
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup',   handleDragEnd);
      var scrollEl   = scrollAreaRef.current;
      var scrollDiff = scrollEl ? scrollEl.scrollLeft - dragRef.current.scrollLeft : 0;
      var dx         = e.clientX - dragRef.current.startX + scrollDiff;
      var newStart   = snapTime(Math.max(0, dragRef.current.origStart + dx / zoom));
      var newEnd     = snapTime(newStart + dragRef.current.duration);
      var newTrackId = dragRef.current.pendingTargetTrackId;
      var moved      = Math.abs(newStart - dragRef.current.origStart) > 0.05;
      if (moved || newTrackId) {
        onMoveElement && onMoveElement({
          elementId:    dragRef.current.elementId,
          newStartTime: newStart,
          newEndTime:   newEnd,
          newTrackId:   newTrackId || undefined,
        });
      }
      dragRef.current = null;
      setElementDragTargetId(null);
    }, [zoom, onMoveElement, handleDragMove]);

    // ── Track reorder drag handlers ────────────────────────────────────────
    function handleTrackDragStart(e, trackType, fromIndex) {
      e.preventDefault();
      e.stopPropagation();
      var trackCount = tracks && tracks[trackType] ? tracks[trackType].length : 0;
      trackDragRef.current = { trackType: trackType, fromIndex: fromIndex, startY: e.clientY, trackCount: trackCount };
      setTrackDrag({ trackType: trackType, fromIndex: fromIndex, toIndex: fromIndex });
      window.addEventListener('mousemove', handleTrackDragMove);
      window.addEventListener('mouseup',   handleTrackDragEnd);
    }

    var handleTrackDragMove = useCallback(function(e) {
      if (!trackDragRef.current) return;
      var fromIndex  = trackDragRef.current.fromIndex;
      var startY     = trackDragRef.current.startY;
      var trackCount = trackDragRef.current.trackCount;
      var offset     = Math.round((e.clientY - startY) / TRACK_HEIGHT);
      var toIndex    = Math.max(0, Math.min(trackCount - 1, fromIndex + offset));
      setTrackDrag(function(prev) { return prev ? { fromIndex: prev.fromIndex, trackType: prev.trackType, toIndex: toIndex } : null; });
    }, []);

    var handleTrackDragEnd = useCallback(function(e) {
      if (!trackDragRef.current) return;
      window.removeEventListener('mousemove', handleTrackDragMove);
      window.removeEventListener('mouseup',   handleTrackDragEnd);
      var trackType  = trackDragRef.current.trackType;
      var fromIndex  = trackDragRef.current.fromIndex;
      setTrackDrag(function(prev) {
        var toIndex = prev ? prev.toIndex : fromIndex;
        if (toIndex !== fromIndex) {
          onReorderTrack && onReorderTrack({ trackType: trackType, fromIndex: fromIndex, toIndex: toIndex });
        }
        return null;
      });
      trackDragRef.current = null;
    }, [onReorderTrack, handleTrackDragMove]);

    // Cleanup drag listeners on unmount
    useEffect(function() {
      return function() {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup',   handleDragEnd);
        window.removeEventListener('mousemove', handleTrackDragMove);
        window.removeEventListener('mouseup',   handleTrackDragEnd);
      };
    }, [handleDragMove, handleDragEnd, handleTrackDragMove, handleTrackDragEnd]);

    // ── Ctrl+scroll to zoom ────────────────────────────────────────────────
    useEffect(function() {
      var el = containerRef.current;
      if (!el) return;
      function handleWheel(e) {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          var delta = e.deltaY > 0 ? -10 : 10;
          onZoomChange && onZoomChange(Math.max(10, Math.min(300, zoom + delta)));
        }
      }
      el.addEventListener('wheel', handleWheel, { passive: false });
      return function() { el.removeEventListener('wheel', handleWheel); };
    }, [zoom, onZoomChange]);

    if (!tracks) {
      return (
        <div style={{ height: '100%', background: '#111111', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: '#444', fontSize: 12 }}>No timeline state</span>
        </div>
      );
    }

    var TRACK_ORDER       = ['subtitle', 'image', 'video', 'audio'];
    var totalTracks       = TRACK_ORDER.reduce(function(sum, t) { return sum + (tracks[t] ? tracks[t].length : 0); }, 0);
    var totalSections     = TRACK_ORDER.reduce(function(sum, t) { return sum + (tracks[t] && tracks[t].length > 0 ? 1 : 0); }, 0);
    var totalHeight       = totalTracks * TRACK_HEIGHT + totalSections * 20;
    var contentWidth = HEADER_WIDTH + Math.max(duration * zoom, 200);

    return (
      <div
        ref={containerRef}
        style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#111111', overflow: 'hidden', position: 'relative' }}
      >
        {/* ── Top bar ──────────────────────────────────────────────────── */}
        <div style={{
          height:       32,
          flexShrink:   0,
          background:   '#0d0d0d',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display:      'flex',
          alignItems:   'center',
          padding:      '0 12px',
          gap:          8,
        }}>
          <span style={{ color: '#555', fontSize: 10, userSelect: 'none' }}>TIMELINE</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>

            {/* Keyframe track selector — only visible when videoClip is selected */}
            {selectedIsVideoClip && (
              <React.Fragment>
                <span style={{ color: '#555', fontSize: 9, userSelect: 'none' }}>KF</span>
                <select
                  value={safeKFTrack}
                  onChange={function(e) {
                    var v = e.target.value;
                    setActiveKeyframeTrack(v);
                    if (v !== 'none') setLastActiveKFTrack(v);
                  }}
                  style={{
                    background:   '#1a1a1a',
                    border:       '1px solid #333',
                    borderRadius: 3,
                    color:        safeKFTrack === 'none' ? '#555' : (KF_COLORS[safeKFTrack] || '#888'),
                    fontSize:     10,
                    padding:      '2px 4px',
                    cursor:       'pointer',
                    outline:      'none',
                  }}
                >
                  {KF_TRACK_OPTIONS.map(function(o) {
                    return <option key={o.value} value={o.value}>{o.label}</option>;
                  })}
                </select>
                <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)' }} />
              </React.Fragment>
            )}

            {/* Split at playhead */}
            <button
              onClick={onSplitElement}
              disabled={!selectedElementId}
              title="Split at playhead (Cmd+B)"
              style={{
                background:   selectedElementId ? '#222' : 'transparent',
                border:       'none',
                color:        selectedElementId ? '#888' : '#444',
                cursor:       selectedElementId ? 'pointer' : 'default',
                borderRadius: 3,
                padding:      '2px 8px',
                display:      'flex',
                alignItems:   'center',
              }}
            >
              <Scissors size={12} />
            </button>
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)' }} />
            <button
              onClick={function() { onZoomChange && onZoomChange(Math.max(10, zoom - 20)); }}
              style={{ background: '#222', border: 'none', color: '#888', cursor: 'pointer', borderRadius: 3, padding: '2px 8px', fontSize: 14 }}
            >−</button>
            <span style={{ color: '#555', fontSize: 10, minWidth: 30, textAlign: 'center' }}>{zoom}</span>
            <button
              onClick={function() { onZoomChange && onZoomChange(Math.min(300, zoom + 20)); }}
              style={{ background: '#222', border: 'none', color: '#888', cursor: 'pointer', borderRadius: 3, padding: '2px 8px', fontSize: 14 }}
            >+</button>
          </div>
        </div>

        {/* ── Scrollable area ─────────────────────────────────────────── */}
        <div
          ref={scrollAreaRef}
          style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', position: 'relative' }}
        >
          <div style={{ minWidth: contentWidth, position: 'relative' }}>

            {/* Ruler row (sticky top) */}
            <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 5, background: '#111111' }}>
              <div style={{ width: HEADER_WIDTH, flexShrink: 0, height: RULER_HEIGHT, background: '#0d0d0d', borderRight: '1px solid rgba(255,255,255,0.08)' }} />
              <div style={{ flex: 1 }}>
                <Ruler duration={duration} zoom={zoom} onSeek={onSeek} />
              </div>
            </div>

            {/* Track sections */}
            <div style={{ position: 'relative' }}>
              {TRACK_ORDER.map(function(trackType) {
                return (
                  <TrackSection
                    key={trackType}
                    trackType={trackType}
                    trackArray={tracks[trackType]}
                    zoom={zoom}
                    duration={duration}
                    currentTime={currentTime}
                    selectedElementId={selectedElementId}
                    onElementSelect={onElementSelect}
                    onDragStart={handleDragStart}
                    onTrackVisibility={onTrackVisibility}
                    onTrackLocked={onTrackLocked}
                    onCreateTrack={onCreateTrack}
                    onDeleteTrack={onDeleteTrack}
                    trackDrag={trackDrag}
                    onTrackDragStart={handleTrackDragStart}
                    activeKeyframeTrack={safeKFTrack}
                    displayKFTrack={displayKFTrack}
                    selectedKeyframe={selectedKeyframe}
                    onKeyframeSelect={onKeyframeSelect}
                    onAddKeyframe={onAddKeyframe}
                    onUpdateKeyframe={onUpdateKeyframe}
                    onDeleteKeyframe={onDeleteKeyframe}
                    onContextMenu={onContextMenu}
                    elementDragTargetId={elementDragTargetId}
                  />
                );
              })}

              {/* Playhead — offset by HEADER_WIDTH */}
              <div style={{ position: 'absolute', left: HEADER_WIDTH, top: 0, right: 0, height: totalHeight, pointerEvents: 'none', overflow: 'visible' }}>
                <Playhead currentTime={currentTime} zoom={zoom} totalHeight={totalHeight} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.Timeline = Timeline;
})();
