// ─────────────────────────────────────────────────────────────────────────────
// VideoPreview.jsx
// Central video preview panel with DOM-based overlay renderer.
//
// Architecture:
//   - HTML5 <video> element is the base layer (raw source video)
//   - An absolutely-positioned overlay div renders active timeline elements
//     (subtitles, effects, overlays) as styled DOM nodes synced to video time
//   - A requestAnimationFrame loop reads video.currentTime at ~60fps for smooth
//     animation. The loop is cancelled on unmount to prevent memory leaks.
//   - Subtitle and overlay elements are draggable in the preview. Dragging
//     updates position in video-space coordinates (0–1080 × 0–1920). The
//     position is committed to the reducer on mouseup via onUpdateElement.
//   - While typing in the Properties panel, previewPosition drives the display
//     position in real-time without touching undo history.
//
// Globals consumed:  React, LucideReact
// Sets global:       window.VideoPreview
// No import / export statements.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const { Play, Pause, Camera, Maximize2, Crop } = LucideReact;

  // ── Video coordinate space ────────────────────────────────────────────────
  const VIDEO_W = 1080;
  const VIDEO_H = 1920;

  // ── Timecode formatter ────────────────────────────────────────────────────
  function formatTimecode(seconds) {
    const s  = Math.max(0, seconds);
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    const ff = Math.floor((s % 1) * 30);
    return [h, m, sc, ff].map(n => String(n).padStart(2, '0')).join(':');
  }

  // ── Z-index base values per track type ───────────────────────────────────
  // final z-index = Z_BASE[trackType] + track.index
  const Z_BASE = { video: 10, subtitle: 40 };

  // ── Linear interpolation helper (mirrors Remotion's interpolate) ──────────
  function lerp(value, inputMin, inputMax, outputMin, outputMax) {
    if (inputMax === inputMin) return outputMin;
    const clamped = Math.max(inputMin, Math.min(inputMax, value));
    const t = (clamped - inputMin) / (inputMax - inputMin);
    return outputMin + t * (outputMax - outputMin);
  }

  // ── Convert video-space {x, y} to container-pixel {top, left} ─────────────
  // Origin is center: (0,0) maps to 50%/50%. Range: x -540→+540, y -960→+960.
  function translatePosition({ x, y }, containerWidth, containerHeight) {
    return {
      top:  ((y + VIDEO_H / 2) / VIDEO_H) * containerHeight,
      left: ((x + VIDEO_W / 2) / VIDEO_W) * containerWidth,
    };
  }

  // ── Collect all active elements at the given time ────────────────────────
  // Returns elements sorted by render order: video → subtitle
  // Also yields trackIndex so the overlay renderer can compute z-index.
  function getActiveElements(tracks, currentTime) {
    const ORDER = ['video', 'subtitle', 'audio'];
    const results = [];
    for (const trackType of ORDER) {
      if (!tracks[trackType]) continue;
      for (const track of tracks[trackType]) {
        if (!track.visible) continue;
        for (const element of track.elements) {
          if (currentTime >= element.startTime && currentTime < element.endTime) {
            results.push({ element, trackType, trackIndex: track.index || 0 });
          }
        }
      }
    }
    return results;
  }

  // ── Resolve position schema → CSS style object ───────────────────────────
  // Numeric x/y values are treated as video-space coordinates (0–1080 / 0–1920)
  // and converted to percentages so the result is container-size-independent.
  function resolvePosition(position) {
    const style = { position: 'absolute' };
    let needTranslateX = false;
    let needTranslateY = false;

    // X axis
    if (position.x === 'center') {
      style.left      = 0;
      style.right     = 0;
      style.textAlign = 'center';
    } else if (position.x === 'left') {
      style.left = (position.xOffset || 60);
    } else if (position.x === 'right') {
      style.right = (position.xOffset || 60);
    } else if (typeof position.x === 'number') {
      style.left = `${((position.x + VIDEO_W / 2) / VIDEO_W) * 100}%`;
      needTranslateX = true;
    } else {
      style.left = 0; style.right = 0; style.textAlign = 'center';
    }

    // Y axis
    if (position.y === 'bottom') {
      style.bottom = (position.yOffset || 180);
    } else if (position.y === 'top') {
      style.top = (position.yOffset || 180);
    } else if (position.y === 'center') {
      style.top       = '50%';
      style.transform = (style.transform || '') + ' translateY(-50%)';
    } else if (typeof position.y === 'number') {
      style.top = `${((position.y + VIDEO_H / 2) / VIDEO_H) * 100}%`;
      needTranslateY = true;
    } else {
      style.bottom = 180;
    }

    // Center the element on the coordinate point (not its top-left corner)
    if (needTranslateX || needTranslateY) {
      const parts = [];
      if (needTranslateX) parts.push('translateX(-50%)');
      if (needTranslateY) parts.push('translateY(-50%)');
      style.transform = ((style.transform || '') + ' ' + parts.join(' ')).trim();
    }

    return style;
  }

  // ── Compute animation opacity + transform for an element ─────────────────
  function computeAnimation(animation, currentTime, startTime, endTime) {
    const animIn  = animation && animation.in  ? animation.in  : { type: 'none', duration: 0 };
    const animOut = animation && animation.out ? animation.out : { type: 'none', duration: 0 };

    const fpsFactor = 1 / 30; // duration in frames → seconds
    const inDur  = animIn.duration  * fpsFactor;
    const outDur = animOut.duration * fpsFactor;

    let opacity   = 1;
    let translateY = 0;
    let scale      = 1;

    // Animate in
    const inProgress = inDur > 0 ? lerp(currentTime, startTime, startTime + inDur, 0, 1) : 1;

    switch (animIn.type) {
      case 'fade':
        opacity = inProgress;
        break;
      case 'slideUp':
        opacity    = inProgress;
        translateY = lerp(currentTime, startTime, startTime + inDur, 40, 0);
        break;
      case 'slideDown':
        opacity    = inProgress;
        translateY = lerp(currentTime, startTime, startTime + inDur, -40, 0);
        break;
      case 'pop':
        scale   = lerp(currentTime, startTime, startTime + inDur, 0.5, 1);
        opacity = inProgress;
        break;
      default:
        break;
    }

    // Animate out (overrides in if in the out window)
    if (outDur > 0 && currentTime > endTime - outDur) {
      const outProgress = lerp(currentTime, endTime - outDur, endTime, 1, 0);
      switch (animOut.type) {
        case 'fade':
          opacity = outProgress;
          break;
        case 'slideUp':
          opacity    = outProgress;
          translateY = lerp(currentTime, endTime - outDur, endTime, 0, -40);
          break;
        case 'slideDown':
          opacity    = outProgress;
          translateY = lerp(currentTime, endTime - outDur, endTime, 0, 40);
          break;
        case 'pop':
          scale   = lerp(currentTime, endTime - outDur, endTime, 1, 0.5);
          opacity = outProgress;
          break;
        default:
          break;
      }
    }

    const transform = [
      translateY !== 0 ? `translateY(${translateY}px)` : '',
      scale !== 1      ? `scale(${scale})`             : '',
    ].filter(Boolean).join(' ') || 'none';

    return { opacity, transform };
  }

  // ── Render a single subtitle element as a DOM node ───────────────────────
  // overridePosition: optional {x, y} in video space to use instead of element.position
  // dragProps: optional { onMouseDown, pointerEvents, cursor }
  function renderSubtitle(element, currentTime, zIndex, overridePosition, dragProps) {
    const { style: s, animation } = element;
    const position = overridePosition || element.position;
    const { opacity, transform } = computeAnimation(animation, currentTime, element.startTime, element.endTime);
    const posStyle = resolvePosition(position);

    const existingTransform = posStyle.transform || '';
    const combinedTransform = [existingTransform, transform !== 'none' ? transform : '']
      .filter(Boolean).join(' ') || 'none';

    const fx = window.EffectStyles
      ? window.EffectStyles.resolveEffectCSS(s.effect)
      : {};

    return (
      <div
        key={element.id}
        onMouseDown={dragProps && dragProps.onMouseDown}
        style={{
          ...posStyle,
          transform:     combinedTransform,
          opacity,
          zIndex:        zIndex || 40,
          pointerEvents: dragProps ? dragProps.pointerEvents : 'none',
          cursor:        dragProps ? dragProps.cursor : undefined,
          padding:       s.padding || 0,
        }}
      >
        <span style={{
          color:           s.color          || '#ffffff',
          fontSize:        s.fontSize       || 52,
          fontFamily:      s.fontFamily     || 'Arial',
          fontWeight:      s.fontWeight     || 'normal',
          fontStyle:       s.fontStyle      || 'normal',
          textTransform:   s.textTransform  || 'none',
          textShadow:      fx.textShadow   || s.textShadow || 'none',
          letterSpacing:   s.letterSpacing  || 'normal',
          textAlign:       s.textAlign      || 'center',
          backgroundColor: fx.backgroundColor
            || (s.backgroundColor && s.backgroundColor !== 'transparent' ? s.backgroundColor : undefined),
          borderRadius:    fx.borderRadius  || s.borderRadius || 0,
          padding:         fx.padding       || undefined,
          WebkitTextStroke: fx.WebkitTextStroke || undefined,
          paintOrder:      fx.paintOrder    || undefined,
          lineHeight:      1.3,
          display:         'inline-block',
        }}>
          {element.text}
        </span>
      </div>
    );
  }

  // ── Find the active videoClip at a given composition time ────────────────
  // Iterates all video tracks; returns the first visible clip whose time window
  // includes the given time, or null if none.
  function getActiveVideoClip(tracks, time) {
    if (!tracks || !tracks.video) return null;
    for (var vi = 0; vi < tracks.video.length; vi++) {
      var track = tracks.video[vi];
      if (!track.visible) continue;
      for (var ei = 0; ei < track.elements.length; ei++) {
        var el = track.elements[ei];
        if (el.type === 'videoClip' && time >= el.startTime && time < el.endTime) {
          return el;
        }
      }
    }
    return null;
  }

  // ── Find the next videoClip that starts after a given composition time ─────
  // Used for gap-jumping when a deleted section leaves a hole in the timeline.
  function getNextVideoClip(tracks, afterTime) {
    if (!tracks || !tracks.video) return null;
    var best = null;
    for (var vi = 0; vi < tracks.video.length; vi++) {
      var track = tracks.video[vi];
      if (!track.visible) continue;
      for (var ei = 0; ei < track.elements.length; ei++) {
        var el = track.elements[ei];
        if (el.type === 'videoClip' && el.startTime > afterTime) {
          if (!best || el.startTime < best.startTime) best = el;
        }
      }
    }
    return best;
  }

  function looksLikeImageFile(src, isImageFlag) {
    if (isImageFlag) return true;
    if (!src || typeof src !== 'string') return false;
    return /\.(jpg|jpeg|png|gif|webp)(\?|#|$)/i.test(src);
  }

  function parseNativeVisualType(src) {
    if (!src || typeof src !== 'string' || !src.startsWith('native://')) return null;
    return src.slice('native://'.length) || null;
  }

  function defaultImageLayoutRead() {
    return window.TimelineSchema && typeof window.TimelineSchema.defaultImageClipLayout === 'function'
      ? window.TimelineSchema.defaultImageClipLayout()
      : { layoutMode: 'fullscreen', anchor: { x: 0, y: 0 }, box: { width: 1080, height: 1920 }, lockAspect: false };
  }

  function mergeImageLayout(el) {
    var d = defaultImageLayoutRead();
    var il = el && el.imageLayout && typeof el.imageLayout === 'object' ? el.imageLayout : {};
    var ax = il.anchor && typeof il.anchor.x === 'number' ? il.anchor.x : d.anchor.x;
    var ay = il.anchor && typeof il.anchor.y === 'number' ? il.anchor.y : d.anchor.y;
    var bw = il.box && typeof il.box.width === 'number' ? il.box.width : d.box.width;
    var bh = il.box && typeof il.box.height === 'number' ? il.box.height : d.box.height;
    return {
      layoutMode: il.layoutMode === 'custom' ? 'custom' : 'fullscreen',
      anchor:     { x: ax, y: ay },
      box:        { width: bw, height: bh },
      lockAspect: !!il.lockAspect,
    };
  }

  /**
   * Effective layout for preview (committed state + in-progress drag / properties typing).
   */
  function effectiveImageLayout(el, previewPosition, previewDrag) {
    var base = mergeImageLayout(el);
    if (previewDrag && previewDrag.dragKind === 'imageAnchor' && previewDrag.elementId === el.id) {
      return {
        layoutMode: 'custom',
        anchor:     { x: previewDrag.currentPosX, y: previewDrag.currentPosY },
        box:        { width: base.box.width, height: base.box.height },
        lockAspect: base.lockAspect,
      };
    }
    if (previewPosition && previewPosition.elementId === el.id
        && typeof previewPosition.x === 'number' && typeof previewPosition.y === 'number') {
      return {
        layoutMode: 'custom',
        anchor:     { x: previewPosition.x, y: previewPosition.y },
        box:        {
          width:  typeof previewPosition.w === 'number' ? previewPosition.w : base.box.width,
          height: typeof previewPosition.h === 'number' ? previewPosition.h : base.box.height,
        },
        lockAspect: base.lockAspect,
      };
    }
    return base;
  }

  /** Position/size of image wrapper in % of preview frame (composition 1080×1920 space). */
  function imageBoxWrapperStyle(layout) {
    if (!layout || layout.layoutMode !== 'custom') {
      return { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' };
    }
    var ax = layout.anchor.x;
    var ay = layout.anchor.y;
    var bw = layout.box.width;
    var bh = layout.box.height;
    var xtl = ax - bw / 2;
    var ytl = ay - bh / 2;
    return {
      position: 'absolute',
      left:   ((xtl + VIDEO_W / 2) / VIDEO_W) * 100 + '%',
      top:    ((ytl + VIDEO_H / 2) / VIDEO_H) * 100 + '%',
      width:  (bw / VIDEO_W) * 100 + '%',
      height: (bh / VIDEO_H) * 100 + '%',
      overflow: 'hidden',
    };
  }

  /** Active imageClip elements on visible image tracks at composition time `t`. */
  function getActiveImageClips(tracks, t) {
    var out = [];
    if (!tracks || !tracks.image) return out;
    var interpolate = window.TimelineReducer && window.TimelineReducer.interpolateKeyframes;
    for (var ti = 0; ti < tracks.image.length; ti++) {
      var tr = tracks.image[ti];
      if (!tr.visible) continue;
      for (var ei = 0; ei < tr.elements.length; ei++) {
        var el = tr.elements[ei];
        if (el.type !== 'imageClip' || !el.src) continue;
        if (t < el.startTime || t >= el.endTime) continue;
        var local = t - el.startTime;
        var kf = el.keyframes && el.keyframes.opacity;
        var op = interpolate && kf ? interpolate(kf, local) : (typeof el.opacity === 'number' ? el.opacity : 1);
        out.push({ element: el, track: tr, localTime: local, opacity: op });
      }
    }
    return out;
  }

  function renderNativeVisual(element, opacity) {
    var p = element.nativePayload || {};
    var t = parseNativeVisualType(element.src);
    if (!t) return null;
    var fit = element.fitMode || 'cover';
    var base = {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      pointerEvents: 'none', opacity: opacity,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
    if (t === 'keyword_text') {
      return React.createElement('div', { key: element.id + '-nt', style: base },
        React.createElement('div', {
          style: {
            color: p.color || '#fff', fontSize: (p.fontSize || 48) + 'px',
            fontFamily: p.fontFamily || 'Arial', fontWeight: p.fontWeight || '700',
            background: p.background || 'rgba(0,0,0,0.55)', padding: '8px 16px', borderRadius: 4,
          },
        }, p.text || '')
      );
    }
    if (t === 'stat_card') {
      var unit = p.unit != null ? String(p.unit) : '';
      return React.createElement('div', { key: element.id + '-sc', style: Object.assign({}, base, { alignItems: 'flex-end', paddingBottom: '18%' }) },
        React.createElement('div', {
          style: {
            background: 'rgba(0,0,0,0.75)', borderRadius: 8, padding: '16px 24px', textAlign: 'center',
          },
        }, [
          React.createElement('div', { key: 'v', style: { fontSize: 48, fontWeight: 'bold', color: p.color || '#00BCD4' } }, (p.value || '') + unit),
          React.createElement('div', { key: 'l', style: { fontSize: 16, color: '#ccc', marginTop: 4 } }, p.label || ''),
        ])
      );
    }
    if (t === 'arrow') {
      var dir = p.direction || 'right';
      var sz = p.size || 64;
      var c = p.color || '#fff';
      var rot = dir === 'up' ? -90 : dir === 'down' ? 90 : dir === 'left' ? 180 : 0;
      return React.createElement('div', { key: element.id + '-ar', style: base },
        React.createElement('svg', { width: sz * 2, height: sz * 2, viewBox: '0 0 100 100', style: { transform: 'rotate(' + rot + 'deg)' } },
          React.createElement('polygon', { points: '10,50 75,20 75,35 90,35 90,65 75,65 75,80', fill: c })
        )
      );
    }
    if (t === 'highlight_box') {
      return React.createElement('div', { key: element.id + '-hb', style: Object.assign({}, base, { display: 'block' }) },
        React.createElement('div', {
          style: {
            position: 'absolute',
            left: ((p.x != null ? p.x : 0.2) * 100) + '%',
            top: ((p.y != null ? p.y : 0.35) * 100) + '%',
            width: ((p.width != null ? p.width : 0.6) * 100) + '%',
            height: ((p.height != null ? p.height : 0.25) * 100) + '%',
            border: '3px solid ' + (p.color || '#00BCD4'),
            opacity: p.opacity != null ? p.opacity * opacity : opacity,
            borderRadius: 4,
          },
        })
      );
    }
    if (t === 'callout') {
      return React.createElement('div', { key: element.id + '-co', style: Object.assign({}, base, { alignItems: 'flex-start', justifyContent: 'flex-start', padding: '10% 8%' }) },
        React.createElement('div', {
          style: {
            position: 'relative', background: 'rgba(0,0,0,0.82)', color: p.color || '#fff',
            fontSize: (p.fontSize || 36) + 'px', padding: '12px 18px', borderRadius: 12,
            border: '2px solid rgba(255,255,255,0.25)', maxWidth: '75%',
          },
        }, [
          React.createElement('div', {
            key: 'tail',
            style: {
              position: 'absolute', bottom: -8, left: 24, width: 0, height: 0,
              borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: '8px solid rgba(0,0,0,0.82)',
            },
          }),
          p.text || '',
        ])
      );
    }
    return null;
  }

  // ── Overlay layer — memoized to decouple overlay renders from playback ──────
  // During playback the custom comparison skips re-renders as long as tracks,
  // previewDrag, and previewPosition are unchanged. React state updates at ~10fps
  // (Fix 1) drive any necessary overlay updates; this memo prevents additional
  // re-renders triggered by other VideoPreview state or prop changes.
  var OverlayLayer = React.memo(function OverlayLayer({
    tracks, currentTime, isPlaying, previewDrag, previewPosition,
    containerRef, onDragStart, onElementSelect,
  }) {
    if (!tracks) return null;

    function makeElementMouseDown(element) {
      return function(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        var container = containerRef.current;
        if (!container) return;
        var rect = container.getBoundingClientRect();
        var origX = typeof element.position.x === 'number' ? element.position.x : 0;
        var origY = typeof element.position.y === 'number' ? element.position.y : 0;
        var startVideoX = ((e.clientX - rect.left) / rect.width)  * VIDEO_W - VIDEO_W / 2;
        var startVideoY = ((e.clientY - rect.top)  / rect.height) * VIDEO_H - VIDEO_H / 2;
        onDragStart({
          elementId:   element.id,
          startVideoX, startVideoY, origX, origY,
          currentPosX: origX,
          currentPosY: origY,
        });
        onElementSelect && onElementSelect(element.id);
      };
    }

    var active = getActiveElements(tracks, currentTime);
    var nodes  = [];

    for (var _i = 0; _i < active.length; _i++) {
      var _ref = active[_i];
      var element    = _ref.element;
      var trackType  = _ref.trackType;
      var trackIndex = _ref.trackIndex;

      if (trackType === 'video' || trackType === 'audio') continue;

      var zIndex      = (Z_BASE[trackType] || 10) + (trackIndex || 0);
      var isDraggable = trackType === 'subtitle';

      var isBeingDragged  = previewDrag     && previewDrag.elementId     === element.id;
      var isTypingPreview = previewPosition && previewPosition.elementId === element.id;

      var overridePos = isBeingDragged
        ? { x: previewDrag.currentPosX, y: previewDrag.currentPosY }
        : isTypingPreview
          ? { x: previewPosition.x, y: previewPosition.y }
          : null;

      var dragProps = isDraggable ? {
        onMouseDown:   makeElementMouseDown(element),
        pointerEvents: 'auto',
        cursor:        isBeingDragged ? 'grabbing' : 'grab',
      } : null;

      if (trackType === 'subtitle') nodes.push(renderSubtitle(element, currentTime, zIndex, overridePos, dragProps));
    }

    if (nodes.length === 0) return null;
    return React.createElement(React.Fragment, null, nodes);
  }, function areOverlayPropsEqual(prev, next) {
    // Skip re-renders only when nothing that affects the displayed overlay has changed.
    // currentTime must be included: it determines which subtitle/overlay is active.
    if (prev.currentTime       === next.currentTime
        && prev.tracks          === next.tracks
        && prev.isPlaying       === next.isPlaying
        && prev.previewDrag     === next.previewDrag
        && prev.previewPosition === next.previewPosition
        && prev.onDragStart     === next.onDragStart
        && prev.onElementSelect === next.onElementSelect) {
      return true; // no re-render needed
    }
    return false;
  });

  // ── VideoPreview main component ───────────────────────────────────────────
  function VideoPreview({
    videoSrc          = null,
    tracks            = null,
    source            = null,
    currentTime       = 0,
    isPlaying         = false,
    selectedElementId = null,
    previewPosition   = null,   // { elementId, x, y } from Properties panel typing
    onPlayPause,
    onSeek,
    onTimeUpdate,
    onElementSelect,
    onUpdateElement,
  }) {
    const videoRef    = useRef(null);
    const overlayRef  = useRef(null);
    const rafRef      = useRef(null);         // requestAnimationFrame id
    const audioRefs   = useRef(new Map());    // elementId → HTMLAudioElement
    const imageBrollVideoRefs = useRef(new Map()); // elementId → HTMLVideoElement (image-track b-roll)

    // Refs for keyframe-based rAF property application
    const zoomWrapRef    = useRef(null);
    const tracksRef      = useRef(tracks);    // always-current tracks without re-registering rAF
    const lastScaleRef   = useRef(1.0);
    const lastSpeedRef   = useRef(1.0);
    const lastVolumeRef  = useRef(1.0);
    const lastOpacityRef = useRef(1.0);

    // Composition-clock refs (source time ≠ composition time after split/delete)
    const compTimeRef     = useRef(currentTime);  // authoritative composition clock
    const lastTickRef     = useRef(null);          // performance.now() of last rAF frame
    const activeClipIdRef = useRef(null);          // detect clip changes for one-shot seeks
    const lastSrcRef      = useRef(null);          // last src loaded into the video element
    const isInternalTimeUpdate = useRef(false);   // true when onTimeUpdate is called by rAF (not a user seek)
    const lastStateUpdateRef = useRef(0);         // performance.now() of last React state update (~10fps throttle)

    // Keep tracksRef current when tracks changes
    useEffect(() => { tracksRef.current = tracks; }, [tracks]);

    // ── Drag state (video-space coordinates 0–1080 / 0–1920) ─────────────
    const previewDragRef = useRef(null);
    const [previewDrag, setPreviewDrag] = useState(null);

    // Stable callback passed to OverlayLayer so memo comparison stays valid
    const handleOverlayDragStart = useCallback((drag) => {
      previewDragRef.current = drag;
      setPreviewDrag(drag);
    }, []);

    // Keep onUpdateElement current without re-registering drag listeners
    const onUpdateElementRef = useRef(onUpdateElement);
    useEffect(() => { onUpdateElementRef.current = onUpdateElement; }, [onUpdateElement]);

    // ── Register drag mousemove / mouseup once on document ───────────────
    useEffect(() => {
      function handleMouseMove(e) {
        const drag = previewDragRef.current;
        if (!drag) return;
        const container = overlayRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const mx = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
        const my = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        const dx = ((mx / rect.width)  * VIDEO_W - VIDEO_W / 2) - drag.startVideoX;
        const dy = ((my / rect.height) * VIDEO_H - VIDEO_H / 2) - drag.startVideoY;
        const newX = Math.max(-VIDEO_W / 2, Math.min(VIDEO_W / 2, drag.origX + dx));
        const newY = Math.max(-VIDEO_H / 2, Math.min(VIDEO_H / 2, drag.origY + dy));
        const updated = { ...drag, currentPosX: newX, currentPosY: newY };
        previewDragRef.current = updated;
        setPreviewDrag({ ...updated });
      }

      function handleMouseUp() {
        const drag = previewDragRef.current;
        if (!drag) return;
        if (drag.dragKind === 'imageAnchor') {
          onUpdateElementRef.current && onUpdateElementRef.current({
            elementId: drag.elementId,
            changes: {
              'imageLayout.anchor.x': Math.round(drag.currentPosX),
              'imageLayout.anchor.y': Math.round(drag.currentPosY),
              'imageLayout.layoutMode': 'custom',
            },
          });
        } else {
          onUpdateElementRef.current && onUpdateElementRef.current({
            elementId: drag.elementId,
            changes: {
              'position.x': Math.round(drag.currentPosX),
              'position.y': Math.round(drag.currentPosY),
            },
          });
        }
        previewDragRef.current = null;
        setPreviewDrag(null);
      }

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup',   handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup',   handleMouseUp);
      };
    }, []);

    // ── RAF loop: composition-clock-based playback ───────────────────────────
    // The authoritative time is compTimeRef (wall-clock composition time), NOT
    // video.currentTime (source position). This decouples source time from
    // composition time, making split/delete, gaps, and clip-level speed work.
    useEffect(() => {
      var interpolate = window.TimelineReducer && window.TimelineReducer.interpolateKeyframes;

      function tick() {
        var video = videoRef.current;
        if (video) {

          // 1. Advance composition clock by wall-clock delta (only while playing)
          if (!video.paused && !video.ended) {
            var nowMs = performance.now();
            if (lastTickRef.current !== null) {
              var dt = (nowMs - lastTickRef.current) / 1000;
              // Cap dt to 0.1s to prevent large jumps after tab wake-up
              compTimeRef.current += Math.min(dt, 0.1);
            }
            lastTickRef.current = nowMs;
          } else {
            lastTickRef.current = null;
          }

          var compTime = compTimeRef.current;

          // 2. Find active clip using composition time (not video.currentTime)
          var clip = getActiveVideoClip(tracksRef.current, compTime);

          // 3. Handle gaps: jump to next clip or stop at end
          if (!clip && !video.paused) {
            var nextClip = getNextVideoClip(tracksRef.current, compTime);
            if (nextClip) {
              // Skip the gap — jump composition clock to next clip start
              compTimeRef.current = nextClip.startTime;
              compTime = nextClip.startTime;
              clip = nextClip;
              var jumpRate = clip.playbackRate || 1;
              video.currentTime = clip.sourceStart;
              video.playbackRate = Math.max(0.0625, Math.min(16, jumpRate));
              activeClipIdRef.current = clip.id;
              lastSpeedRef.current = jumpRate;
            } else {
              // End of composition — nothing more to play
              video.pause();
              onTimeUpdate && onTimeUpdate(compTime);
              rafRef.current = requestAnimationFrame(tick);
              return;
            }
          }

          if (clip) {
            var rate     = clip.playbackRate || 1.0;
            var localTime = compTime - clip.startTime;

            // 4. On clip change: switch src if needed, seek to correct source position and set rate
            if (clip.id !== activeClipIdRef.current) {
              // Switch video src when clip has its own src (multi-clip support)
              var clipSrc = clip.src || null;
              if (clipSrc && clipSrc !== lastSrcRef.current) {
                video.src = clipSrc;
                lastSrcRef.current = clipSrc;
              }
              var initSourcePos = clip.sourceStart + localTime * rate;
              video.currentTime  = initSourcePos;
              video.playbackRate = Math.max(0.0625, Math.min(16, rate));
              activeClipIdRef.current = clip.id;
              lastSpeedRef.current    = rate;
            } else {
              // 5. Apply clip-level playbackRate if changed between frames
              if (Math.abs(rate - lastSpeedRef.current) > 0.001) {
                video.playbackRate   = Math.max(0.0625, Math.min(16, rate));
                lastSpeedRef.current = rate;
              }

              // 6. Correct source position drift (> 0.5s) — handles seeks and rate changes.
              // Threshold raised from 0.15s to 0.5s so brief render stalls don't trigger
              // a backward seek. After any seek, re-anchor compTimeRef to prevent the
              // next tick from immediately re-triggering the correction.
              var expectedSourcePos = clip.sourceStart + localTime * rate;
              var drift = video.currentTime - expectedSourcePos;
              if (Math.abs(drift) > 0.5) {
                video.currentTime = expectedSourcePos;
                compTimeRef.current = clip.startTime + (video.currentTime - clip.sourceStart) / rate;
              }
            }

            // 7. Apply clip-level volume (skip if unchanged)
            var vol = clip.volume !== undefined ? clip.volume : 1.0;
            if (Math.abs(vol - lastVolumeRef.current) > 0.001) {
              lastVolumeRef.current = vol;
              video.volume = Math.max(0, Math.min(1, vol));
            }

            // 8. Apply scale keyframes (localTime is composition-relative)
            var kf = clip.keyframes;
            var scale = (interpolate && kf && kf.scale)
              ? interpolate(kf.scale, localTime)
              : (clip.zoom && clip.zoom.type !== 'none' ? (clip.zoom.amount || 1.0) : 1.0);
            if (Math.abs(scale - lastScaleRef.current) > 0.001) {
              lastScaleRef.current = scale;
              if (zoomWrapRef.current) {
                zoomWrapRef.current.style.transform = scale !== 1.0 ? ('scale(' + scale + ')') : '';
              }
            }

            // 9. Apply opacity keyframes
            var opacity = (interpolate && kf && kf.opacity)
              ? interpolate(kf.opacity, localTime)
              : 1.0;
            if (Math.abs(opacity - lastOpacityRef.current) > 0.001) {
              lastOpacityRef.current = opacity;
              if (zoomWrapRef.current) {
                zoomWrapRef.current.style.opacity = String(opacity);
              }
            }
          }

          // 10b. Image-track b-roll <video> — keep in sync with composition clock
          if (tracksRef.current && tracksRef.current.image) {
            for (var ii = 0; ii < tracksRef.current.image.length; ii++) {
              var imTr = tracksRef.current.image[ii];
              if (!imTr.visible) continue;
              for (var ij = 0; ij < imTr.elements.length; ij++) {
                var imEl = imTr.elements[ij];
                if (!imEl || imEl.type !== 'imageClip' || !imEl.src) continue;
                var vel = imageBrollVideoRefs.current.get(imEl.id);
                if (!vel) continue;
                if (imEl.sourceType === 'native') {
                  vel.pause();
                  continue;
                }
                if (looksLikeImageFile(imEl.src, imEl.isImage)) {
                  vel.pause();
                  continue;
                }
                if (compTime < imEl.startTime || compTime >= imEl.endTime) {
                  vel.pause();
                  continue;
                }
                var iLocal = compTime - imEl.startTime;
                if (Math.abs(vel.currentTime - iLocal) > 0.05) vel.currentTime = iLocal;
                if (!video.paused && !video.ended) vel.play().catch(function() {});
                else vel.pause();
              }
            }
          }

          // 10. Audio drift correction — cheap arithmetic only, no React/DOM overhead
          if (!video.paused && !video.ended) {
            audioRefs.current.forEach(function(audioEl, clipId) {
              if (audioEl.paused) return;
              var audioTracks = tracksRef.current && tracksRef.current.audio;
              if (!audioTracks) return;
              var ac = null;
              for (var ai = 0; ai < audioTracks.length; ai++) {
                var elems = audioTracks[ai].elements;
                for (var aii = 0; aii < elems.length; aii++) {
                  if (elems[aii].id === clipId) { ac = elems[aii]; break; }
                }
                if (ac) break;
              }
              if (!ac) return;
              var aElapsed = compTime - ac.startTime;
              if (aElapsed < 0 || aElapsed > (ac.endTime - ac.startTime)) {
                audioEl.pause();
                return;
              }
              if (Math.abs(audioEl.currentTime - aElapsed) > 0.5) {
                audioEl.currentTime = aElapsed;
              }
            });
          }

          // 11. Report composition time to React state at ~10fps (not 60fps).
          // All playback decisions use compTimeRef directly; React state is only
          // needed for the timeline scrubber and timecode display.
          if (!video.paused && !video.ended) {
            var nowMs2 = performance.now();
            if (nowMs2 - lastStateUpdateRef.current > 100) {
              lastStateUpdateRef.current = nowMs2;
              isInternalTimeUpdate.current = true;
              onTimeUpdate && onTimeUpdate(compTime);
            }
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      }

      rafRef.current = requestAnimationFrame(tick);

      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, [onTimeUpdate]);

    // ── Sync play / pause to prop ────────────────────────────────────────
    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      if (isPlaying) v.play().catch(() => {});
      else           v.pause();
    }, [isPlaying]);

    // ── Audio sync — play / pause / seek all audioClip elements ─────────
    // Runs when track state or isPlaying changes — NOT on every time update.
    // Drift correction during playback is handled in the rAF tick instead.
    // One HTMLAudioElement is created per active audioClip and cached in
    // audioRefs so we don't recreate elements on every frame.
    useEffect(() => {
      if (!tracks || !tracks.audio) return;

      const allAudioClips = (tracks.audio || [])
        .filter(t => t.visible && !t.locked)
        .flatMap(t => t.elements)
        .filter(e => e.type === 'audioClip' && e.src);

      const activeIds = new Set(allAudioClips.map(e => e.id));

      for (const clip of allAudioClips) {
        // Create HTML Audio element if it doesn't exist yet
        let audioEl = audioRefs.current.get(clip.id);
        if (!audioEl) {
          audioEl = new Audio(clip.src);
          audioEl._lastSrc = clip.src;
          audioRefs.current.set(clip.id, audioEl);
        }

        // Update src if it changed (e.g. element was replaced)
        if (audioEl._lastSrc !== clip.src) {
          audioEl.src      = clip.src;
          audioEl._lastSrc = clip.src;
        }

        const compNow    = compTimeRef.current;
        const baseVolume = clip.volume !== undefined ? clip.volume : 1.0;
        const isActive   = compNow >= clip.startTime && compNow < clip.endTime;

        if (isActive) {
          const elapsed   = compNow - clip.startTime;
          const remaining = clip.endTime - compNow;

          // Approximate fade in / fade out by scaling volume
          let vol = baseVolume;
          if (clip.fadeIn  > 0 && elapsed   < clip.fadeIn)  vol *= elapsed   / clip.fadeIn;
          if (clip.fadeOut > 0 && remaining < clip.fadeOut) vol *= remaining / clip.fadeOut;
          audioEl.volume = Math.max(0, Math.min(1, vol));

          if (isPlaying && audioEl.paused) {
            audioEl.currentTime = elapsed;
            audioEl.play().catch(() => {});
          } else if (!isPlaying && !audioEl.paused) {
            audioEl.pause();
          }
        } else {
          if (!audioEl.paused) audioEl.pause();
          audioEl.currentTime = 0;
        }
      }

      // Remove audio elements for clips no longer in state
      for (const [id, audioEl] of audioRefs.current) {
        if (!activeIds.has(id)) {
          audioEl.pause();
          audioEl.src = '';
          audioRefs.current.delete(id);
        }
      }
    }, [tracks, isPlaying]);

    // ── Cleanup all audio elements on unmount ────────────────────────────
    useEffect(() => {
      return () => {
        audioRefs.current.forEach(audio => {
          audio.pause();
          audio.src = '';
        });
        audioRefs.current.clear();
      };
    }, []);

    // ── Seek the video when currentTime changes from outside ─────────────
    // Converts composition time → source file position for the active clip.
    // Also resets the composition clock so the rAF loop doesn't jump.
    // IMPORTANT: bail out immediately when the change came from the rAF loop's
    // own onTimeUpdate call — those are not external seeks, and seeking on every
    // frame causes constant video buffering (lag) and silences the audio decoder.
    useEffect(() => {
      if (isInternalTimeUpdate.current) {
        isInternalTimeUpdate.current = false;
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      // Sync composition clock to the external seek target
      compTimeRef.current  = currentTime;
      lastTickRef.current  = null;     // reset delta so first tick doesn't jump
      activeClipIdRef.current = null;  // force clip re-init on next tick

      const clip = getActiveVideoClip(tracksRef.current, currentTime);
      if (clip) {
        const rate      = clip.playbackRate || 1;
        const localTime = currentTime - clip.startTime;
        v.currentTime   = clip.sourceStart + localTime * rate;
      } else {
        // In a gap or before any clip — seek to nearest next clip's start
        const next = getNextVideoClip(tracksRef.current, currentTime);
        if (next) v.currentTime = next.sourceStart;
      }
    }, [currentTime]);

    // ── Reload src when videoSrc prop changes ───────────────────────────
    useEffect(() => {
      const v = videoRef.current;
      if (!v || !videoSrc) return;
      lastSrcRef.current = videoSrc;
      v.load();
    }, [videoSrc]);

    // (overlay rendering delegated to OverlayLayer — see module-level component above)

    // ── Coordinate readout pill (shown during drag, clamped to container) ─
    function buildPillNode() {
      if (!previewDrag) return null;
      const container     = overlayRef.current;
      const containerH    = container ? container.offsetHeight : 640;
      const containerW    = container ? container.offsetWidth  : 360;

      const pillPos = translatePosition(
        { x: previewDrag.currentPosX, y: previewDrag.currentPosY },
        containerW,
        containerH
      );

      const PILL_W       = 120;
      const PILL_H       = 22;
      const PILL_OFFSET_Y = 28;

      // Clamp pill so it stays inside the overlay container
      const pillTop = Math.max(
        4,
        pillPos.top - PILL_OFFSET_Y
      );

      // pillLeft = center of element, clamped so pill fits inside container
      const pillLeft = Math.max(
        4,
        Math.min(
          containerW - PILL_W - 4,
          pillPos.left - PILL_W / 2   // centered on element
        )
      );

      return (
        <div
          key="drag-pill"
          style={{
            position:       'absolute',
            top:            pillTop,
            left:           pillLeft,
            width:          PILL_W,
            height:         PILL_H,
            background:     'rgba(0,0,0,0.78)',
            borderRadius:   4,
            border:         '1px solid rgba(255,255,255,0.18)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            zIndex:         200,
            pointerEvents:  'none',
            fontSize:       11,
            color:          '#00BCD4',
            fontFamily:     'monospace',
            letterSpacing:  0.3,
            userSelect:     'none',
          }}
        >
          X:{Math.round(previewDrag.currentPosX)} Y:{Math.round(previewDrag.currentPosY)}
        </div>
      );
    }

    // ── Coordinate grid overlay ──────────────────────────────────────────
    // SVG viewBox matches video coordinate space (-540→+540, -960→+960).
    // Lines drawn at x=0 / y=0 are the center axes; all others are guides.
    // vector-effect="non-scaling-stroke" keeps every line exactly 1 px wide
    // at any display size.
    function buildGridNode() {
      const COLS = [-360, -180, 0, 180, 360];           // interior vertical lines (x)
      const ROWS = [-768, -576, -384, -192, 0, 192, 384, 576, 768]; // interior horizontal (y)
      const AXIS_COLOR  = '#00BCD4';
      const GUIDE_COLOR = 'rgba(255,255,255,0.1)';

      return (
        <svg
          viewBox="-540 -960 1080 1920"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            position:      'absolute',
            inset:         0,
            width:         '100%',
            height:        '100%',
            pointerEvents: 'none',
            zIndex:        1,
            overflow:      'visible',
          }}
        >
          {/* Vertical guide lines */}
          {COLS.map(x => (
            <line
              key={`vg${x}`}
              x1={x} y1={-960} x2={x} y2={960}
              stroke={x === 0 ? AXIS_COLOR : GUIDE_COLOR}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Horizontal guide lines */}
          {ROWS.map(y => (
            <line
              key={`hg${y}`}
              x1={-540} y1={y} x2={540} y2={y}
              stroke={y === 0 ? AXIS_COLOR : GUIDE_COLOR}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* Origin marker */}
          <circle cx={0} cy={0} r={6} fill="none" stroke={AXIS_COLOR} strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.7} />
          <circle cx={0} cy={0} r={1.5} fill={AXIS_COLOR} opacity={0.9} />
        </svg>
      );
    }

    const pillNode     = buildPillNode();
    const gridNode     = buildGridNode();
    const totalDuration = source && source.duration ? source.duration : 0;
    const hasVideoClips = tracks && tracks.video &&
      tracks.video.some(t => t.elements && t.elements.length > 0);

    function bindImageClipDrag(el, effLayout) {
      return function (e) {
        if (effLayout.layoutMode !== 'custom') return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onElementSelect && onElementSelect(el.id);
        var container = overlayRef.current;
        if (!container) return;
        var rect = container.getBoundingClientRect();
        var startVideoX = ((e.clientX - rect.left) / rect.width) * VIDEO_W - VIDEO_W / 2;
        var startVideoY = ((e.clientY - rect.top) / rect.height) * VIDEO_H - VIDEO_H / 2;
        handleOverlayDragStart({
          dragKind:    'imageAnchor',
          elementId:   el.id,
          startVideoX: startVideoX,
          startVideoY: startVideoY,
          origX:       effLayout.anchor.x,
          origY:       effLayout.anchor.y,
          currentPosX: effLayout.anchor.x,
          currentPosY: effLayout.anchor.y,
        });
      };
    }

    var imageLayerNodes = null;
    if (tracks && tracks.image) {
      var activeImg = getActiveImageClips(tracks, currentTime);
      if (activeImg.length > 0) {
        imageLayerNodes = activeImg.map(function(row) {
          var el = row.element;
          var op = row.opacity;
          var fit = el.fitMode || 'cover';
          var vol = el.volume !== undefined ? el.volume : 0;
          var eff = effectiveImageLayout(el, previewPosition, previewDrag);
          var wrapStyle = imageBoxWrapperStyle(eff);
          var sel = selectedElementId === el.id;
          var pe = eff.layoutMode === 'custom' ? 'auto' : 'none';
          var outline = sel && eff.layoutMode === 'custom' ? '1px solid rgba(45,212,191,0.85)' : 'none';
          var onImgMouseDown = bindImageClipDrag(el, eff);

          function wrapInner(innerReactEl) {
            return React.createElement('div', {
              key: el.id + '-ilwrap',
              style: Object.assign({}, wrapStyle, {
                pointerEvents: pe,
                outline: outline,
                outlineOffset: -1,
              }),
              onMouseDown: onImgMouseDown,
            }, innerReactEl);
          }

          if (el.sourceType === 'native') {
            return wrapInner(renderNativeVisual(el, op));
          }
          if (looksLikeImageFile(el.src, el.isImage)) {
            return wrapInner(React.createElement('img', {
              key: el.id + '-img',
              src: el.src,
              alt: '',
              draggable: false,
              style: {
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                objectFit: fit, pointerEvents: 'none', opacity: op, display: 'block',
              },
            }));
          }
          return wrapInner(React.createElement('video', {
            key: el.id + '-vid',
            ref: function(node) {
              if (node) imageBrollVideoRefs.current.set(el.id, node);
              else imageBrollVideoRefs.current.delete(el.id);
            },
            src: el.src,
            playsInline: true,
            muted: !(vol > 0),
            loop: false,
            style: {
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              objectFit: fit, pointerEvents: 'none', opacity: op, display: 'block',
            },
          }));
        });
      }
    }

    return (
      <div style={{
        display:       'flex',
        flexDirection: 'column',
        height:        '100%',
        background:    '#1e1e1e',
        overflow:      'hidden',
      }}>

        {/* ── Top bar ──────────────────────────────────────────────────── */}
        <div style={{
          height:         48,
          flexShrink:     0,
          background:     '#161616',
          borderBottom:   '1px solid rgba(255,255,255,0.06)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '0 20px',
        }}>
          <span style={{ color: '#ffffff', fontSize: 14, fontWeight: 400 }}>
            {source && source.filename ? source.filename : 'Vibe Editor'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', display: 'flex', alignItems: 'center' }} title="Crop">
              <Crop size={14} />
            </button>
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', display: 'flex', alignItems: 'center' }} title="Fullscreen">
              <Maximize2 size={14} />
            </button>
          </div>
        </div>

        {/* ── Preview area ─────────────────────────────────────────────── */}
        <div style={{
          flex:           1,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          background:     '#1e1e1e',
          overflow:       'hidden',
          position:       'relative',
        }}>
          {(videoSrc || hasVideoClips) ? (
            <div style={{
              aspectRatio: '9 / 16',
              height:      '100%',
              position:    'relative',
              overflow:    'hidden',
              borderRadius: 0,
              background:  '#000',
            }}>
              {/* Video layer — zoomWrapRef receives keyframe-interpolated transform/opacity from rAF */}
              <div
                ref={zoomWrapRef}
                style={{ width: '100%', height: '100%', transformOrigin: 'center center', overflow: 'hidden', position: 'relative', zIndex: 1 }}
              >
                <video
                  ref={videoRef}
                  src={videoSrc || ''}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  preload="metadata"
                />
              </div>

              {/* Image layer — above source video, below subtitle overlay */}
              {imageLayerNodes && imageLayerNodes.length > 0 ? (
                <div style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', overflow: 'hidden' }}>
                  {imageLayerNodes}
                </div>
              ) : null}

              {/* DOM overlay layer — grid, subtitles, drag pill */}
              <div
                ref={overlayRef}
                style={{
                  position:      'absolute',
                  inset:         0,
                  pointerEvents: 'none',
                  overflow:      'hidden',
                  zIndex:        3,
                }}
              >
                {gridNode}
                <OverlayLayer
                  tracks={tracks}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  previewDrag={previewDrag}
                  previewPosition={previewPosition}
                  containerRef={overlayRef}
                  onDragStart={handleOverlayDragStart}
                  onElementSelect={onElementSelect}
                />
                {pillNode}
              </div>
            </div>
          ) : (
            <div style={{
              display:       'flex',
              flexDirection: 'column',
              alignItems:    'center',
              justifyContent: 'center',
              gap:           12,
              opacity:       0.4,
            }}>
              <Camera size={36} color="#555" />
              <span style={{ color: '#555', fontSize: 13 }}>No video loaded</span>
            </div>
          )}
        </div>

        {/* ── Controls bar ─────────────────────────────────────────────── */}
        <div style={{
          height:         56,
          flexShrink:     0,
          background:     '#161616',
          borderTop:      '1px solid rgba(255,255,255,0.06)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '0 20px',
        }}>

          {/* LEFT: timecodes */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="monospace" style={{ color: '#00BCD4', fontSize: 13 }}>
              {formatTimecode(currentTime)}
            </span>
            <span style={{ color: '#555', fontSize: 13 }}>/</span>
            <span className="monospace" style={{ color: '#ffffff', fontSize: 13 }}>
              {formatTimecode(totalDuration)}
            </span>
          </div>

          {/* CENTER: play / pause */}
          <button
            onClick={onPlayPause}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: '#ffffff', display: 'flex', alignItems: 'center', padding: 4,
            }}
          >
            {isPlaying
              ? <Pause size={20} fill="#ffffff" />
              : <Play  size={20} fill="#ffffff" />}
          </button>

          {/* RIGHT: resolution/fps labels */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {source && source.width ? (
              <span style={{ color: '#555', fontSize: 11 }}>
                {source.width}×{source.height} · {source.fps}fps
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  window.VideoPreview = VideoPreview;
})();
