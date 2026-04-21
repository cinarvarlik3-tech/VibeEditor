/**
 * serializeToRemotion.js
 *
 * Converts Vibe Editor timeline state into a single self-contained Remotion
 * composition module (GeneratedVideo.jsx) that mirrors browser preview logic.
 */

'use strict';

const DEFAULT_FPS = 30;
const VIDEO_W = 1080;
const VIDEO_H = 1920;

/** Bump when Remotion serialization semantics change (invalidates render disk cache). */
const SERIALIZER_VERSION = 1;

/**
 * Turn timeline media src into an absolute URL Remotion can fetch (Headless Chrome).
 * Relative paths are served by the Vibe Editor Express app during export.
 */
function toAbsoluteUrl(src) {
  if (!src) return src;
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  return 'http://localhost:3000' + (src.startsWith('/') ? src : '/' + src);
}

/**
 * Stable sort: lower track index first (renders behind), same order as timeline rows.
 */
function sortedTracks(trackArr) {
  return [...(trackArr || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
}

function collectClips(tracks, kind, filterFn) {
  const out = [];
  for (const track of sortedTracks(tracks[kind])) {
    if (track && track.visible === false) continue;
    for (const el of track.elements || []) {
      if (filterFn(el)) out.push(el);
    }
  }
  return out;
}

function maxEndTime(state) {
  let t = state.source && typeof state.source.duration === 'number' ? state.source.duration : 0;
  const tracks = state.tracks || {};
  for (const kind of ['video', 'subtitle', 'audio', 'image']) {
    for (const track of tracks[kind] || []) {
      for (const el of track.elements || []) {
        const e = el.endTime;
        if (typeof e === 'number' && e > t) t = e;
      }
    }
  }
  return t;
}

/**
 * Total composition length in frames for export / Remotion CLI.
 * Uses Math.ceil(maxEndTime * fps) + 2 to avoid off-by-one at the last frame.
 */
function getRemotionDurationInFrames(timelineState, fps) {
  const f = fps || DEFAULT_FPS;
  return Math.max(1, Math.ceil(maxEndTime(timelineState) * f) + 2);
}

/**
 * serializeToRemotion
 * Builds a full JSX source string for src/compositions/GeneratedVideo.jsx
 *
 * @param {object} timelineState  Full editor state (must include tracks, source)
 * @returns {{ jsx: string, totalFrames: number }}
 */
function serializeToRemotion(timelineState) {
  /** Spec: all frame math uses 30 fps regardless of source.fps */
  const fps = DEFAULT_FPS;
  const totalFrames = getRemotionDurationInFrames(timelineState, fps);
  const tracks = timelineState.tracks || {};

  const videoClips = collectClips(tracks, 'video', el => el.type === 'videoClip' && el.src);
  const imageClips = collectClips(tracks, 'image', el => el.type === 'imageClip' && el.src);
  const audioClips = collectClips(tracks, 'audio', el => el.type === 'audioClip' && el.src);
  const subtitles = collectClips(tracks, 'subtitle', el => el.type === 'subtitle');

  imageClips.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  const serialVideo = videoClips.map(el => {
    return {
      id: el.id,
      absSrc: toAbsoluteUrl(el.src),
      startTime: el.startTime || 0,
      endTime: el.endTime || 0,
      sourceStart: el.sourceStart != null ? el.sourceStart : 0,
      sourceEnd: el.sourceEnd != null ? el.sourceEnd : (el.endTime || 0),
      playbackRate: el.playbackRate != null ? el.playbackRate : 1,
      volume: el.volume != null ? el.volume : 1,
      keyframes: {
        scale: Array.isArray(el.keyframes && el.keyframes.scale) ? el.keyframes.scale : [{ time: 0, value: 1, easing: 'linear' }],
        opacity: Array.isArray(el.keyframes && el.keyframes.opacity) ? el.keyframes.opacity : [{ time: 0, value: 1, easing: 'linear' }],
      },
    };
  });

  const serialAudio = audioClips.map(el => {
    return {
      id: el.id,
      absSrc: toAbsoluteUrl(el.src),
      startTime: el.startTime || 0,
      endTime: el.endTime || 0,
      volume: el.volume != null ? el.volume : 1,
      fadeIn: el.fadeIn || 0,
      fadeOut: el.fadeOut || 0,
    };
  });

  const serialSubs = subtitles.map(el => ({
    id: el.id,
    startTime: el.startTime || 0,
    endTime: el.endTime || 0,
    text: el.text != null ? String(el.text) : '',
    style: el.style || {},
    position: el.position || { x: 'center', y: 'bottom', xOffset: 0, yOffset: 0 },
    animation: el.animation || { in: { type: 'none', duration: 0 }, out: { type: 'none', duration: 0 } },
  }));

  const serialImage = imageClips.map(el => {
    const src = el.src || '';
    let nativeType = null;
    if (String(el.sourceType || '') === 'native' && typeof src === 'string' && src.startsWith('native://')) {
      nativeType = src.replace(/^native:\/\//, '');
    }
    const defIL = { layoutMode: 'fullscreen', anchor: { x: 0, y: 0 }, box: { width: 1080, height: 1920 }, lockAspect: false };
    const il = el.imageLayout && typeof el.imageLayout === 'object' ? el.imageLayout : {};
    const imageLayout = {
      layoutMode: il.layoutMode === 'custom' ? 'custom' : 'fullscreen',
      anchor: {
        x: il.anchor && typeof il.anchor.x === 'number' ? il.anchor.x : defIL.anchor.x,
        y: il.anchor && typeof il.anchor.y === 'number' ? il.anchor.y : defIL.anchor.y,
      },
      box: {
        width: il.box && typeof il.box.width === 'number' ? il.box.width : defIL.box.width,
        height: il.box && typeof il.box.height === 'number' ? il.box.height : defIL.box.height,
      },
      lockAspect: !!il.lockAspect,
    };
    return {
      id: el.id,
      absSrc: toAbsoluteUrl(src),
      startTime: el.startTime || 0,
      endTime: el.endTime || 0,
      isImage: !!el.isImage,
      fitMode: el.fitMode || 'cover',
      volume: el.volume != null ? el.volume : 0,
      sourceType: el.sourceType || 'upload',
      nativeType,
      nativePayload: el.nativePayload && typeof el.nativePayload === 'object' ? el.nativePayload : {},
      imageLayout,
      keyframes: {
        opacity: Array.isArray(el.keyframes && el.keyframes.opacity)
          ? el.keyframes.opacity
          : [{ time: 0, value: 1, easing: 'linear' }],
      },
    };
  });

  const videoJson = JSON.stringify(serialVideo, null, 2);
  const imageJson = JSON.stringify(serialImage, null, 2);
  const audioJson = JSON.stringify(serialAudio, null, 2);
  const subsJson = JSON.stringify(serialSubs, null, 2);

  const fontFamiliesArr = [...new Set(
    serialSubs.map(el => el.style && el.style.fontFamily).filter(Boolean)
  )];
  const fontImportsStr = fontFamiliesArr.length
    ? fontFamiliesArr.map(f =>
      '@import url(\'https://fonts.googleapis.com/css2?family=' +
      encodeURIComponent(f).replace(/%20/g, '+') +
      ':wght@400;700&display=swap\');'
    ).join('\n')
    : '';
  const fontImportsLiteral = JSON.stringify(fontImportsStr);

  const jsx = `/*
 * Vibe Editor — Remotion export
 * totalFrames: ${totalFrames}  (= Math.ceil(maxEndTime * ${fps}) + 2 frame buffer)
 */
import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';

const FPS = ${fps};
const VIDEO_W = ${VIDEO_W};
const VIDEO_H = ${VIDEO_H};

const SERIALIZED_VIDEO = ${videoJson};
const SERIALIZED_IMAGE = ${imageJson};
const SERIALIZED_SUBTITLES = ${subsJson};
const SERIALIZED_AUDIO = ${audioJson};
const GOOGLE_FONT_IMPORT_CSS = ${fontImportsLiteral};

function interpolateKeyframes(keyframes, localTime) {
  if (!keyframes || keyframes.length === 0) return 1.0;
  if (keyframes.length === 1) return keyframes[0].value;
  if (localTime <= keyframes[0].time) return keyframes[0].value;
  if (localTime >= keyframes[keyframes.length - 1].time)
    return keyframes[keyframes.length - 1].value;

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
  if (prevKF.easing === 'hold') return prevKF.value;
  var span = nextKF.time - prevKF.time;
  if (span === 0) return prevKF.value;
  var t = (localTime - prevKF.time) / span;
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
    default:
      easedT = t;
  }
  return prevKF.value + (nextKF.value - prevKF.value) * easedT;
}

function resolveEffectCSS(effect) {
  if (!effect || !effect.type || effect.type === 'none') return {};
  var c = effect.color || '#000000';
  switch (effect.type) {
    case 'outline':
      return { WebkitTextStroke: '3px ' + c, paintOrder: 'stroke fill' };
    case 'shadow':
      return { textShadow: '3px 3px 8px ' + c + ', 1px 1px 3px ' + c };
    case 'glow':
      return {
        textShadow:
          '0 0 7px ' +
          c +
          ', 0 0 10px ' +
          c +
          ', 0 0 21px ' +
          c +
          ', 0 0 42px ' +
          c,
      };
    case 'textBox':
      return { backgroundColor: c, padding: '8px 20px', borderRadius: 12 };
    default:
      return {};
  }
}

function lerpLinear(value, inputMin, inputMax, outputMin, outputMax) {
  if (inputMax === inputMin) return outputMin;
  var clamped = Math.max(inputMin, Math.min(inputMax, value));
  var t = (clamped - inputMin) / (inputMax - inputMin);
  return outputMin + t * (outputMax - outputMin);
}

function computeSubtitleAnim(animation, currentTimeSec, startTime, endTime) {
  var animIn = animation && animation.in ? animation.in : { type: 'none', duration: 0 };
  var animOut = animation && animation.out ? animation.out : { type: 'none', duration: 0 };
  var fpsFactor = 1 / FPS;
  var inDur = animIn.duration * fpsFactor;
  var outDur = animOut.duration * fpsFactor;
  var opacity = 1;
  var translateY = 0;
  var scale = 1;
  var inProgress = inDur > 0 ? lerpLinear(currentTimeSec, startTime, startTime + inDur, 0, 1) : 1;

  switch (animIn.type) {
    case 'fade':
      opacity = inProgress;
      break;
    case 'slideUp':
      opacity = inProgress;
      translateY = lerpLinear(currentTimeSec, startTime, startTime + inDur, 40, 0);
      break;
    case 'slideDown':
      opacity = inProgress;
      translateY = lerpLinear(currentTimeSec, startTime, startTime + inDur, -40, 0);
      break;
    case 'pop':
      scale = lerpLinear(currentTimeSec, startTime, startTime + inDur, 0.5, 1);
      opacity = inProgress;
      break;
    default:
      break;
  }

  if (outDur > 0 && currentTimeSec > endTime - outDur) {
    var outProgress = lerpLinear(currentTimeSec, endTime - outDur, endTime, 1, 0);
    switch (animOut.type) {
      case 'fade':
        opacity = outProgress;
        break;
      case 'slideUp':
        opacity = outProgress;
        translateY = lerpLinear(currentTimeSec, endTime - outDur, endTime, 0, -40);
        break;
      case 'slideDown':
        opacity = outProgress;
        translateY = lerpLinear(currentTimeSec, endTime - outDur, endTime, 0, 40);
        break;
      case 'pop':
        scale = lerpLinear(currentTimeSec, endTime - outDur, endTime, 1, 0.5);
        opacity = outProgress;
        break;
      default:
        break;
    }
  }

  var tf =
    (translateY !== 0 ? 'translateY(' + translateY + 'px) ' : '') +
    (scale !== 1 ? 'scale(' + scale + ')' : '');
  return { opacity: opacity, transform: tf.trim() || 'none' };
}

function subtitlePositionStyle(pos) {
  var x = pos.x;
  var y = pos.y;
  var xOff = pos.xOffset || 0;
  var yOff = pos.yOffset || 0;

  var leftPct;
  if (typeof x === 'number') {
    leftPct = ((x + VIDEO_W / 2) / VIDEO_W) * 100;
  } else if (x === 'left') {
    leftPct = 10;
  } else if (x === 'right') {
    leftPct = 90;
  } else {
    leftPct = 50;
  }

  var topPct;
  if (typeof y === 'number') {
    topPct = ((y + VIDEO_H / 2) / VIDEO_H) * 100;
  } else if (y === 'top') {
    topPct = 15;
  } else if (y === 'center') {
    topPct = 50;
  } else {
    topPct = 75;
  }

  return {
    position: 'absolute',
    left: 'calc(' + leftPct + '% + ' + xOff + 'px)',
    top: 'calc(' + topPct + '% + ' + yOff + 'px)',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center',
    zIndex: 50,
  };
}

function CompositionFpsGuard() {
  var cfg = useVideoConfig();
  if (cfg.fps !== 30) {
    console.warn('[VibeEditor export] Expected composition fps 30, got', cfg.fps);
  }
  return null;
}

function SubtitleBlock(props) {
  var el = props.el;
  var frame = useCurrentFrame();
  var globalSec = el.startTime + frame / FPS;
  var anim = computeSubtitleAnim(el.animation, globalSec, el.startTime, el.endTime);
  var s = el.style || {};
  var fx = resolveEffectCSS(s.effect);

  var spanStyle = {
    color: s.color || '#ffffff',
    fontSize: (s.fontSize || 52) + 'px',
    fontFamily: s.fontFamily || 'Arial',
    fontWeight: s.fontWeight || 'normal',
    fontStyle: s.fontStyle || 'normal',
    textTransform: s.textTransform || 'none',
    letterSpacing: s.letterSpacing || 'normal',
    textAlign: s.textAlign || 'center',
    lineHeight: 1.3,
    display: 'inline-block',
    textShadow: fx.textShadow || s.textShadow || 'none',
    backgroundColor: fx.backgroundColor || undefined,
    borderRadius: fx.borderRadius != null ? fx.borderRadius : s.borderRadius || 0,
    padding: fx.padding || undefined,
    WebkitTextStroke: fx.WebkitTextStroke,
    paintOrder: fx.paintOrder,
    opacity: anim.opacity,
    transform: anim.transform === 'none' ? undefined : anim.transform,
  };

  var wrap = {};
  Object.assign(wrap, subtitlePositionStyle(el.position || {}));

  return (
    <div style={wrap}>
      <span style={spanStyle}>{el.text}</span>
    </div>
  );
}

function VideoBlock(props) {
  var clip = props.clip;
  var frame = useCurrentFrame();
  var localSec = frame / FPS;
  var scaleKF = clip.keyframes && clip.keyframes.scale ? clip.keyframes.scale : [{ time: 0, value: 1, easing: 'linear' }];
  var opacityKF = clip.keyframes && clip.keyframes.opacity ? clip.keyframes.opacity : [{ time: 0, value: 1, easing: 'linear' }];
  var sc = interpolateKeyframes(scaleKF, localSec);
  var op = interpolateKeyframes(opacityKF, localSec);

  var startFrom = Math.round(clip.sourceStart * FPS);
  var endAt = Math.max(startFrom + 1, Math.round(clip.sourceEnd * FPS));

  return (
    <OffthreadVideo
      src={clip.absSrc}
      startFrom={startFrom}
      endAt={endAt}
      playbackRate={clip.playbackRate}
      volume={clip.volume}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        opacity: op,
        transform: 'scale(' + sc + ')',
        transformOrigin: 'center center',
      }}
    />
  );
}

/** Same geometry as preview imageBoxWrapperStyle (1080×1920, anchor = box center). */
function imageClipLayoutStyle(clip) {
  var il = clip.imageLayout;
  if (!il || il.layoutMode !== 'custom') {
    return { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' };
  }
  var ax = il.anchor && typeof il.anchor.x === 'number' ? il.anchor.x : 0;
  var ay = il.anchor && typeof il.anchor.y === 'number' ? il.anchor.y : 0;
  var bw = il.box && typeof il.box.width === 'number' ? il.box.width : VIDEO_W;
  var bh = il.box && typeof il.box.height === 'number' ? il.box.height : VIDEO_H;
  var xtl = ax - bw / 2;
  var ytl = ay - bh / 2;
  return {
    position: 'absolute',
    left: ((xtl + VIDEO_W / 2) / VIDEO_W) * 100 + '%',
    top: ((ytl + VIDEO_H / 2) / VIDEO_H) * 100 + '%',
    width: (bw / VIDEO_W) * 100 + '%',
    height: (bh / VIDEO_H) * 100 + '%',
    overflow: 'hidden',
  };
}

function ImageClipBlock(props) {
  var clip = props.clip;
  var frame = useCurrentFrame();
  var localSec = frame / FPS;
  var opacityKF = clip.keyframes && clip.keyframes.opacity ? clip.keyframes.opacity : [{ time: 0, value: 1, easing: 'linear' }];
  var op = interpolateKeyframes(opacityKF, localSec);
  var fit = clip.fitMode || 'cover';
  var p = clip.nativePayload || {};
  var lw = imageClipLayoutStyle(clip);
  var fill = { width: '100%', height: '100%', position: 'relative' };

  if (clip.sourceType === 'native' && clip.nativeType) {
    if (clip.nativeType === 'keyword_text') {
      return (
        <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
          <div style={lw}>
            <div style={Object.assign({}, fill, { display: 'flex', alignItems: 'center', justifyContent: 'center' })}>
              <div style={{
                color: p.color || '#fff',
                fontSize: (p.fontSize || 48) + 'px',
                fontFamily: p.fontFamily || 'Arial',
                fontWeight: p.fontWeight || '700',
                background: p.background || 'rgba(0,0,0,0.55)',
                padding: '8px 16px',
                borderRadius: 4,
                opacity: op,
              }}>{p.text || ''}</div>
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    if (clip.nativeType === 'stat_card') {
      var unit = p.unit != null ? String(p.unit) : '';
      return (
        <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
          <div style={lw}>
            <div style={fill}>
              <div style={{
                position: 'absolute', bottom: '20%', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.75)', borderRadius: 8, padding: '16px 24px', textAlign: 'center', opacity: op,
              }}>
                <div style={{ fontSize: 48, fontWeight: 'bold', color: p.color || '#00BCD4' }}>{p.value || ''}{unit}</div>
                <div style={{ fontSize: 16, color: '#ccc', marginTop: 4 }}>{p.label || ''}</div>
              </div>
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    if (clip.nativeType === 'arrow') {
      var dir = p.direction || 'right';
      var sz = p.size || 64;
      var c = p.color || '#fff';
      var rot = dir === 'up' ? -90 : dir === 'down' ? 90 : dir === 'left' ? 180 : 0;
      return (
        <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
          <div style={lw}>
            <div style={Object.assign({}, fill, { display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: op })}>
              <svg width={sz * 2} height={sz * 2} viewBox="0 0 100 100" style={{ transform: 'rotate(' + rot + 'deg)' }}>
                <polygon points="10,50 75,20 75,35 90,35 90,65 75,65 75,80" fill={c} />
              </svg>
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    if (clip.nativeType === 'highlight_box') {
      return (
        <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
          <div style={lw}>
            <div style={Object.assign({}, fill, { opacity: op })}>
              <div style={{
                position: 'absolute',
                left: (p.x != null ? p.x : 0.2) * 100 + '%',
                top: (p.y != null ? p.y : 0.35) * 100 + '%',
                width: (p.width != null ? p.width : 0.6) * 100 + '%',
                height: (p.height != null ? p.height : 0.25) * 100 + '%',
                border: '3px solid ' + (p.color || '#00BCD4'),
                opacity: p.opacity != null ? p.opacity : 1,
                borderRadius: 4,
              }} />
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    if (clip.nativeType === 'callout') {
      return (
        <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
          <div style={lw}>
            <div style={fill}>
              <div style={{
                position: 'absolute', top: '12%', left: '8%',
                background: 'rgba(0,0,0,0.82)', color: p.color || '#fff',
                fontSize: (p.fontSize || 36) + 'px', padding: '12px 18px', borderRadius: 12,
                border: '2px solid rgba(255,255,255,0.25)', maxWidth: '75%', opacity: op,
              }}>
                <div style={{ position: 'absolute', bottom: -10, left: 24, width: 0, height: 0,
                  borderLeft: '10px solid transparent', borderRight: '10px solid transparent', borderTop: '10px solid rgba(0,0,0,0.82)' }} />
                {p.text || ''}
              </div>
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    return (
      <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
        <div style={lw}>
          <div style={Object.assign({}, fill, { backgroundColor: 'rgba(0,0,0,0.4)' })} />
        </div>
      </AbsoluteFill>
    );
  }

  var srcLower = String(clip.absSrc || '').toLowerCase();
  var looksImage = clip.isImage || /\\.(jpg|jpeg|png|gif|webp)(\\?|$)/i.test(srcLower);
  if (looksImage) {
    return (
      <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
        <div style={lw}>
          <img
            src={clip.absSrc}
            style={{ width: '100%', height: '100%', objectFit: fit, opacity: op }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  var durSec = Math.max(0.1, (clip.endTime || 0) - (clip.startTime || 0));
  var startFrom = Math.round(localSec * FPS);
  var endAt = Math.max(startFrom + 1, Math.round(durSec * FPS));
  return (
    <AbsoluteFill style={{ zIndex: 2, pointerEvents: 'none' }}>
      <div style={lw}>
        <OffthreadVideo
          src={clip.absSrc}
          startFrom={startFrom}
          endAt={endAt}
          volume={clip.volume != null ? clip.volume : 0}
          style={{ width: '100%', height: '100%', objectFit: fit, opacity: op }}
        />
      </div>
    </AbsoluteFill>
  );
}

function AudioBlock(props) {
  var a = props.a;
  var frame = useCurrentFrame();
  var durFrames = Math.max(1, Math.round((a.endTime - a.startTime) * FPS));
  var baseVol = typeof a.volume === 'number' ? a.volume : 1;
  var fadeInF = Math.round((a.fadeIn || 0) * FPS);
  var fadeOutF = Math.round((a.fadeOut || 0) * FPS);

  var vol =
    fadeInF > 0
      ? interpolate(frame, [0, fadeInF], [0, baseVol], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : baseVol;

  if (fadeOutF > 0 && durFrames > fadeOutF) {
    var outStart = durFrames - fadeOutF;
    vol =
      vol *
      interpolate(frame, [outStart, durFrames], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  }

  return <Audio src={a.absSrc} volume={vol} />;
}

export const VibeComposition = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {GOOGLE_FONT_IMPORT_CSS ? (
        <style dangerouslySetInnerHTML={{ __html: GOOGLE_FONT_IMPORT_CSS }} />
      ) : null}
      <CompositionFpsGuard />
      {SERIALIZED_VIDEO.map(function (clip) {
        var from = Math.max(0, Math.round(clip.startTime * FPS));
        var dur = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ zIndex: 1 }}>
              <VideoBlock clip={clip} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {SERIALIZED_IMAGE.map(function (clip) {
        var from = Math.max(0, Math.round(clip.startTime * FPS));
        var dur = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <ImageClipBlock clip={clip} />
          </Sequence>
        );
      })}
      {SERIALIZED_SUBTITLES.map(function (el) {
        var from = Math.max(0, Math.round(el.startTime * FPS));
        var dur = Math.max(1, Math.round((el.endTime - el.startTime) * FPS));
        return (
          <Sequence key={el.id} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ zIndex: 3 }}>
              <SubtitleBlock el={el} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {SERIALIZED_AUDIO.map(function (a) {
        var from = Math.max(0, Math.round(a.startTime * FPS));
        var dur = Math.max(1, Math.round((a.endTime - a.startTime) * FPS));
        return (
          <Sequence key={a.id} from={from} durationInFrames={dur}>
            <AudioBlock a={a} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export default VibeComposition;
`;

  return { jsx, totalFrames };
}

module.exports = {
  serializeToRemotion,
  getRemotionDurationInFrames,
  SERIALIZER_VERSION,
};
