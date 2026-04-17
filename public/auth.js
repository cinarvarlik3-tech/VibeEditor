/**
 * auth.js — Supabase session helpers for Vibe Editor (global script, no imports).
 * Expects window.SUPABASE_URL and window.SUPABASE_ANON_KEY (injected by the server into HTML).
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'vibe_editor_supabase_access_token';

  function getToken() {
    try {
      return global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token == null || token === '') {
        global.localStorage.removeItem(STORAGE_KEY);
      } else {
        global.localStorage.setItem(STORAGE_KEY, token);
      }
    } catch (e) { /* ignore */ }
  }

  function clearToken() {
    setToken(null);
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
    var token = data.access_token;
    if (!token) {
      throw new Error('No access token returned');
    }
    return { token: token, user: data.user };
  }

  function signOut() {
    clearToken();
    global.location.href = '/login.html';
  }

  /**
   * @returns {Promise<{ id: string, email: string }|null>}
   */
  async function verifySession() {
    var t = getToken();
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

  global.Auth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    signIn: signIn,
    signOut: signOut,
    verifySession: verifySession,
  };
})(typeof window !== 'undefined' ? window : this);
