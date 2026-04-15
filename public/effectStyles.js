// ─────────────────────────────────────────────────────────────────────────────
// effectStyles.js
// Shared utility that resolves a subtitle effect preset into CSS properties.
//
// Used by VideoPreview.jsx (browser) and potentially by the Remotion export
// pipeline. Loaded via <script> in index.html before any component scripts.
//
// Globals consumed:  none
// Sets global:       window.EffectStyles
// ─────────────────────────────────────────────────────────────────────────────

(function () {

  /**
   * resolveEffectCSS
   * Converts an effect descriptor { type, color } into a flat object of
   * CSS properties that can be spread onto a subtitle <span>.
   *
   * @param {object|null|undefined} effect  - { type: string, color: string }
   * @returns {object}  CSS property bag (may be empty)
   */
  function resolveEffectCSS(effect) {
    if (!effect || !effect.type || effect.type === 'none') return {};

    var c = effect.color || '#000000';

    switch (effect.type) {

      case 'outline':
        return {
          WebkitTextStroke: '3px ' + c,
          paintOrder: 'stroke fill',
        };

      case 'shadow':
        return {
          textShadow: '3px 3px 8px ' + c + ', 1px 1px 3px ' + c,
        };

      case 'glow':
        return {
          textShadow: '0 0 7px ' + c + ', 0 0 10px ' + c + ', 0 0 21px ' + c + ', 0 0 42px ' + c,
        };

      case 'textBox':
        return {
          backgroundColor: c,
          padding: '8px 20px',
          borderRadius: 12,
        };

      default:
        return {};
    }
  }

  // Dual export: browser global + CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { resolveEffectCSS: resolveEffectCSS };
  }
  if (typeof window !== 'undefined') {
    window.EffectStyles = { resolveEffectCSS: resolveEffectCSS };
  }

})();
