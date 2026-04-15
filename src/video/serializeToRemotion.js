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
  for (const kind of ['video', 'subtitle', 'audio']) {
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
  const audioClips = collectClips(tracks, 'audio', el => el.type === 'audioClip' && el.src);
  const subtitles = collectClips(tracks, 'subtitle', el => el.type === 'subtitle');

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

  const videoJson = JSON.stringify(serialVideo, null, 2);
  const audioJson = JSON.stringify(serialAudio, null, 2);
  const subsJson = JSON.stringify(serialSubs, null, 2);

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
const SERIALIZED_SUBTITLES = ${subsJson};
const SERIALIZED_AUDIO = ${audioJson};

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
      <CompositionFpsGuard />
      {SERIALIZED_VIDEO.map(function (clip) {
        var from = Math.max(0, Math.round(clip.startTime * FPS));
        var dur = Math.max(1, Math.round((clip.endTime - clip.startTime) * FPS));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={dur}>
            <AbsoluteFill>
              <VideoBlock clip={clip} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      {SERIALIZED_SUBTITLES.map(function (el) {
        var from = Math.max(0, Math.round(el.startTime * FPS));
        var dur = Math.max(1, Math.round((el.endTime - el.startTime) * FPS));
        return (
          <Sequence key={el.id} from={from} durationInFrames={dur}>
            <SubtitleBlock el={el} />
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
};
