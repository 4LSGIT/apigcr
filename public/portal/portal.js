// public/portal/portal.js
//
// Client Portal Slice 1 — tiny shared helper for the portal pages.
// Token lives in localStorage['portal_token']; every authed call goes
// through Portal.fetch, which attaches the Bearer header and bounces to
// login on 401 (expired / revoked / disabled — the API is deliberately
// uniform about which).
//
// S5 additions — shared branding chrome:
//   Portal.branding()          one fetch of GET /api/portal/branding
//                              (PUBLIC endpoint — works pre-auth); resolves
//                              { logo_url, site_url, phone } with nulls on
//                              any failure (branding is cosmetic — it must
//                              never break a page).
//   Portal.logout()            the ONE logout flow (best-effort POST, token
//                              discard, bounce to login) — previously
//                              inlined in cases.html.
//   Portal.initChrome(opts)    injects the favicon + a slim shared header
//                              (logo → home.html on authed pages, plain on
//                              login; Log out button on authed pages) at
//                              the top of <body>, plus its own styles. All
//                              branding values are applied via DOM
//                              PROPERTIES (img.src / a.href / textContent),
//                              never innerHTML — a settings row can't
//                              inject markup.
//   Pages opt in with one call: Portal.initChrome({ authed: true|false }).
//   index.html (the instant router) deliberately doesn't — it never paints.

(function () {
  'use strict';

  const TOKEN_KEY = 'portal_token';

  let _brandingPromise = null;

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

    // ── S5: branding chrome ──────────────────────────────────────────────

    /**
     * Firm branding (PUBLIC endpoint; server caches 5 min). Never rejects:
     * any failure resolves to all-null branding.
     * @returns {Promise<{logo_url:string|null, site_url:string|null, phone:string|null}>}
     */
    branding() {
      if (!_brandingPromise) {
        _brandingPromise = fetch('/api/portal/branding')
          .then(r => (r.ok ? r.json() : null))
          .then(d => ({
            logo_url: (d && d.logo_url) || null,
            site_url: (d && d.site_url) || null,
            phone:    (d && d.phone)    || null,
          }))
          .catch(() => ({ logo_url: null, site_url: null, phone: null }));
      }
      return _brandingPromise;
    },

    /**
     * The one logout flow (was inlined in cases.html pre-S5): best-effort
     * server logout (writes the access-log row), then token discard + login
     * bounce regardless.
     */
    async logout() {
      try {
        await Portal.fetch('/api/portal/logout', { method: 'POST' });
      } catch (_) { /* best-effort — token discard is what matters */ }
      Portal.clearToken();
      Portal.toLogin();
    },

    /**
     * Inject the favicon + shared header. Call once, at the top of each
     * page's script (scripts sit at the end of <body>, so the DOM exists).
     * @param {object} [opts]
     * @param {boolean} [opts.authed=true]  authed pages: logo links to
     *        home.html + a Log out button. Login: plain logo, no logout.
     */
    initChrome(opts) {
      const authed = !opts || opts.authed !== false;

      // Styles (once).
      if (!document.getElementById('portal-chrome-style')) {
        const style = document.createElement('style');
        style.id = 'portal-chrome-style';
        style.textContent =
          '.portal-chrome{background:#ffffff;border-bottom:1px solid #e5e7eb;}' +
          '.portal-chrome-inner{max-width:520px;margin:0 auto;padding:10px 16px;' +
            'display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
          '.portal-chrome-brand{display:inline-flex;align-items:center;gap:8px;' +
            'text-decoration:none;color:#1f2937;font-weight:700;font-size:15px;min-width:0;}' +
          '.portal-chrome-brand img{display:block;height:30px;max-width:220px;object-fit:contain;}' +
          '.portal-chrome-logout{border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;' +
            'color:#6b7280;font:inherit;font-size:13px;font-weight:600;padding:6px 12px;' +
            'cursor:pointer;flex-shrink:0;}' +
          '.portal-chrome-logout:hover{color:#2563eb;border-color:#2563eb;}' +
          '.portal-chrome-logout:disabled{opacity:0.6;cursor:default;}';
        document.head.appendChild(style);
      }

      // Header (once) — DOM-built; branding values only ever land in
      // properties, never markup.
      let bar = document.getElementById('portal-chrome');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'portal-chrome';
        bar.className = 'portal-chrome';
        const inner = document.createElement('div');
        inner.className = 'portal-chrome-inner';

        const brand = document.createElement(authed ? 'a' : 'span');
        brand.className = 'portal-chrome-brand';
        if (authed) brand.href = 'home.html';
        brand.textContent = 'Client Portal';        // text fallback until/if a logo loads
        inner.appendChild(brand);

        if (authed) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'portal-chrome-logout';
          btn.textContent = 'Log out';
          btn.addEventListener('click', () => { btn.disabled = true; Portal.logout(); });
          inner.appendChild(btn);
        }

        bar.appendChild(inner);
        document.body.insertBefore(bar, document.body.firstChild);
      }

      // Branding (async): favicon + logo image.
      Portal.branding().then(b => {
        if (!b.logo_url) return;
        // Favicon — the firm logo (png favicons are fine everywhere modern).
        if (!document.querySelector('link[rel="icon"]')) {
          const link = document.createElement('link');
          link.rel = 'icon';
          link.href = b.logo_url;
          document.head.appendChild(link);
        }
        // Logo image replaces the text fallback once it actually loads —
        // a broken URL keeps the text, never a broken-image icon.
        const brand = bar.querySelector('.portal-chrome-brand');
        if (!brand || brand.querySelector('img')) return;
        const img = new Image();
        img.alt = 'Logo';
        img.onload = () => {
          brand.textContent = '';
          brand.appendChild(img);
        };
        img.src = b.logo_url;
      });
    },
  };

  window.Portal = Portal;
})();
