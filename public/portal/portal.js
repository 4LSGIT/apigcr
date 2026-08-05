// public/portal/portal.js
//
// Client Portal Slice 1 — tiny shared helper for the portal pages.
// Token lives in localStorage['portal_token']; every authed call goes
// through Portal.fetch, which attaches the Bearer header and bounces to
// login on 401 (expired / revoked / disabled — the API is deliberately
// uniform about which).

(function () {
  'use strict';

  const TOKEN_KEY = 'portal_token';

  const Portal = {
    getToken() {
      try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
    },
    setToken(t) {
      try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {}
    },
    clearToken() {
      try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    },
    toLogin() {
      window.location.href = 'login.html';
    },

    /**
     * Authed fetch. On 401: clears the token, redirects to login, and
     * returns a never-resolving promise so callers don't render error
     * states mid-redirect.
     */
    async fetch(path, opts = {}) {
      const token = Portal.getToken();
      if (!token) {
        Portal.toLogin();
        return new Promise(() => {});
      }
      const headers = Object.assign({}, opts.headers || {}, {
        Authorization: 'Bearer ' + token,
      });
      if (opts.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      if (res.status === 401) {
        Portal.clearToken();
        Portal.toLogin();
        return new Promise(() => {});
      }
      return res;
    },

    /** Unauthenticated JSON POST (login flow). Returns { res, data }. */
    async post(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { res, data };
    },
  };

  window.Portal = Portal;
})();
