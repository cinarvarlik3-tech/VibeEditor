/**
 * Default payloads for native visual overlays (imageClip with sourceType "native").
 * Renderer reads element.nativePayload merged with preset defaults.
 */
'use strict';

const NATIVE_VISUAL_PRESETS = {
  keyword_text: {
    type: 'keyword_text',
    label: 'Keyword text',
    defaultPayload: {
      text: 'Key point',
      color: '#FFFFFF',
      fontSize: 56,
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: '700',
      background: 'rgba(0,0,0,0.55)',
    },
  },
  stat_card: {
    type: 'stat_card',
    label: 'Stat card',
    defaultPayload: {
      value: '42',
      label: 'Metric',
      unit: '%',
      color: '#00BCD4',
    },
  },
  arrow: {
    type: 'arrow',
    label: 'Arrow',
    defaultPayload: {
      direction: 'right',
      color: '#FFFFFF',
      size: 64,
    },
  },
  highlight_box: {
    type: 'highlight_box',
    label: 'Highlight box',
    defaultPayload: {
      x: 0.2,
      y: 0.35,
      width: 0.6,
      height: 0.25,
      color: '#00BCD4',
      opacity: 0.85,
    },
  },
  callout: {
    type: 'callout',
    label: 'Callout',
    defaultPayload: {
      text: 'Note',
      color: '#FFFFFF',
      fontSize: 40,
    },
  },
};

module.exports = { NATIVE_VISUAL_PRESETS };
