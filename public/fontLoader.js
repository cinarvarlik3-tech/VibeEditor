/**
 * fontLoader.js — dynamic Google Fonts loading for Vibe Editor (global script).
 * Best-effort only: never throws to callers.
 */
(function (global) {
  'use strict';

  var FontLoader = {
    _loaded: new Set(),

    load: function (family) {
      try {
        if (!family || typeof family !== 'string') return;
        if (this._loaded.has(family)) return;
        this._loaded.add(family);
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href =
          'https://fonts.googleapis.com/css2?family=' +
          encodeURIComponent(family).replace(/%20/g, '+') +
          ':wght@400;700&display=swap';
        document.head.appendChild(link);
      } catch (e) { /* ignore */ }
    },

    loadAll: function (families) {
      try {
        (families || []).forEach(function (f) {
          FontLoader.load(f);
        });
      } catch (e) { /* ignore */ }
    },

    isLoaded: function (family) {
      return !!(family && this._loaded.has(family));
    },
  };

  global.FontLoader = FontLoader;
})(typeof window !== 'undefined' ? window : this);
