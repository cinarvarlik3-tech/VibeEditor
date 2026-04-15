/*
 * Vibe Editor — Remotion export
 * totalFrames: 454  (= Math.ceil(maxEndTime * 30) + 2 frame buffer)
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

const FPS = 30;
const VIDEO_W = 1080;
const VIDEO_H = 1920;

const SERIALIZED_VIDEO = [
  {
    "id": "elem_v_1776280882941_zsr4",
    "absSrc": "http://localhost:3000/uploads/1776280882290-edit-1774286377250.mp4",
    "startTime": 0,
    "endTime": 15.061333,
    "sourceStart": 0,
    "sourceEnd": 15.061333,
    "playbackRate": 1,
    "volume": 1,
    "keyframes": {
      "scale": [
        {
          "time": 0,
          "value": 1,
          "easing": "linear"
        }
      ],
      "opacity": [
        {
          "time": 0,
          "value": 1,
          "easing": "linear"
        }
      ]
    }
  }
];
const SERIALIZED_SUBTITLES = [
  {
    "id": "elem_s_1742891234_a3f2",
    "startTime": 0,
    "endTime": 6,
    "text": "ÖzelDerZ",
    "style": {
      "color": "#FFFFFF",
      "fontSize": 25,
      "fontFamily": "Impact",
      "fontWeight": "normal",
      "fontStyle": "normal",
      "textTransform": "none",
      "textShadow": null,
      "letterSpacing": "normal",
      "textAlign": "center",
      "backgroundColor": "transparent",
      "padding": 0,
      "borderRadius": 0,
      "effect": {
        "type": "glow",
        "color": "#FF3333"
      }
    },
    "position": {
      "x": "center",
      "y": "center",
      "xOffset": 0,
      "yOffset": 0
    },
    "animation": {
      "in": {
        "type": "fade",
        "duration": 8
      },
      "out": {
        "type": "fade",
        "duration": 8
      }
    }
  }
];
const SERIALIZED_AUDIO = [];

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
