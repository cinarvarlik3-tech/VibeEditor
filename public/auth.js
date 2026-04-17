/**
 * auth.js — Supabase session helpers for Vibe Editor (global script, no imports).
 * Expects window.SUPABASE_URL and window.SUPABASE_ANON_KEY (injected by the server into HTML).
 * Persists access + refresh tokens and refreshes before expiry.
 */
(function (global) {
  'use strict';

  var LEGACY_STORAGE_KEY = 'vibe_editor_supabase_access_token';
  var TOKEN_KEY = 'vibe_token';
  var REFRESH_KEY = 'vibe_refresh_token';
  var EXPIRY_KEY = 'vibe_token_expiry';

  var refreshInFlight = null;

  function lsGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function lsSet(key, val) {
    try {
      if (val == null || val === '') {
        global.localStorage.removeItem(key);
      } else {
        global.localStorage.setItem(key, val);
      }
    } catch (e) { /* ignore */ }
  }

  function lsRemove(key) {
    try {
      global.localStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  }

  function persistSessionFromAuthResponse(data) {
    if (!data || !data.access_token) return;
    try {
      lsSet(TOKEN_KEY, data.access_token);
      if (data.refresh_token) {
        lsSet(REFRESH_KEY, data.refresh_token);
      }
      var sec = Number(data.expires_in);
      if (!isFinite(sec) || sec <= 0) sec = 3600;
      lsSet(EXPIRY_KEY, String(global.Date.now() + sec * 1000));
      lsRemove(LEGACY_STORAGE_KEY);
    } catch (e) { /* ignore */ }
  }

  function getToken() {
    var t = null;
    try {
      t = lsGet(TOKEN_KEY);
      if (!t) {
        t = lsGet(LEGACY_STORAGE_KEY);
        if (t) {
          lsSet(TOKEN_KEY, t);
        }
      }
    } catch (e) {
      return null;
    }
    if (typeof refreshIfNeeded === 'function') {
      try {
        refreshIfNeeded();
      } catch (e) { /* ignore */ }
    }
    return t;
  }

  function setToken(token) {
    try {
      if (token == null || token === '') {
        lsRemove(TOKEN_KEY);
        lsRemove(LEGACY_STORAGE_KEY);
      } else {
        lsSet(TOKEN_KEY, token);
        lsRemove(LEGACY_STORAGE_KEY);
      }
    } catch (e) { /* ignore */ }
  }

  function clearAllSessionStorage() {
    lsRemove(TOKEN_KEY);
    lsRemove(REFRESH_KEY);
    lsRemove(EXPIRY_KEY);
    lsRemove(LEGACY_STORAGE_KEY);
  }

  function signOut() {
    clearAllSessionStorage();
    global.location.href = '/login.html';
  }

  /**
   * Refreshes the access token when within 5 minutes of expiry (or when expiry unknown).
   * Safe to call frequently; coalesces concurrent attempts.
   */
  async function refreshIfNeeded() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async function () {
      try {
        var expiry = Number(lsGet(EXPIRY_KEY) || 0);
        var fiveMin = 5 * 60 * 1000;
        if (expiry > 0 && global.Date.now() < expiry - fiveMin) {
          return;
        }

        var refreshToken = lsGet(REFRESH_KEY);
        if (!refreshToken) {
          var tok = lsGet(TOKEN_KEY) || lsGet(LEGACY_STORAGE_KEY);
          if (!tok) signOut();
          return;
        }

        var base = String(global.SUPABASE_URL || '').replace(/\/$/, '');
        var anon = global.SUPABASE_ANON_KEY || '';
        if (!base || !anon) {
          return;
        }

        var res = await fetch(
          base + '/auth/v1/token?grant_type=refresh_token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: anon,
              Authorization: 'Bearer ' + anon,
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
          }
        );
        var data = {};
        try {
          data = await res.json();
        } catch (e) {
          data = {};
        }
        if (data.access_token) {
          persistSessionFromAuthResponse(data);
        } else {
          signOut();
        }
      } catch (e) {
        /* network / parse errors — do not sign out; next interval or getToken will retry */
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  }

  /**
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ token: string, user: object }>}
   */
  async function signIn(email, password) {
    var base = String(global.SUPABASE_URL || '').replace(/\/$/, '');
    var anon = global.SUPABASE_ANON_KEY || '';
    if (!base || !anon) {
      throw new Error('Supabase is not configured');
    }
    var url = base + '/auth/v1/token?grant_type=password';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anon,
        Authorization: 'Bearer ' + anon,
      },
      body: JSON.stringify({
        email: String(email || '').trim(),
        password: password,
      }),
    });
    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      var msg =
        data.error_description ||
        data.msg ||
        data.message ||
        data.error ||
        'Sign in failed';
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    if (!data.access_token) {
      throw new Error('No access token returned');
    }
    persistSessionFromAuthResponse(data);
    return { token: data.access_token, user: data.user };
  }

  /**
   * @returns {Promise<{ id: string, email: string }|null>}
   */
  async function verifySession() {
    await refreshIfNeeded();
    var t = null;
    try {
      t = lsGet(TOKEN_KEY) || lsGet(LEGACY_STORAGE_KEY);
    } catch (e) {
      return null;
    }
    if (!t) return null;
    try {
      var res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t },
      });
      if (!res.ok) return null;
      var data = await res.json();
      return data.user || null;
    } catch (e) {
      return null;
    }
  }

  function clearToken() {
    clearAllSessionStorage();
  }

  global.Auth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    signIn: signIn,
    signOut: signOut,
    verifySession: verifySession,
    refreshIfNeeded: refreshIfNeeded,
  };

  if (typeof global.setInterval === 'function') {
    refreshIfNeeded();
    global.setInterval(function () {
      refreshIfNeeded();
    }, 30 * 60 * 1000);
  }
})(typeof window !== 'undefined' ? window : this);
