// routes/pageLanding.js
//
/**
 * Landing Pages — public serve + form submit (Slice 1)
 * routes/pageLanding.js
 *
 * PUBLIC (no auth):
 *   GET  /p/:slug   — serve a live page's stored HTML. Draft/missing → 404.
 *   POST /p/:slug   — accept a form submission, forward to the page's
 *                     YisraHook (direct executeHook call, no HTTP self-call),
 *                     303-redirect to the thank-you target. ALWAYS 303 —
 *                     never an error page, never a render on POST.
 *
 * HOST-ROUTING MIDDLEWARE (exported as `router.pageHostMiddleware`):
 *   Registered in server.js BEFORE express.static (see server.js edit) so a
 *   mapped domain's root request never falls into public/index.html. The
 *   middleware is a closure over the db pool because it runs before the
 *   req.db-attaching middleware. Three jobs since 2026-08-16 (origin
 *   separation — see the block comment above pageHostMiddleware):
 *     1. vanity host+path pages (the original job, unchanged),
 *     2. LANDING HOSTS (landing_hosts setting): serve ONLY the public
 *        allowlist + pages (prefix, root-slug, or pinned); dead-end all else,
 *     3. non-landing hosts: 302 the migrated public GET surface to the
 *        canonical landing host when landing_redirect = '1'.
 *
 *   Effective host = x-original-host header (set by the Cloudflare Worker /
 *   proxy in front of mapped domains) falling back to req.hostname
 *   (X-Forwarded-Host aware — trust proxy is 1). Unknown hosts next()
 *   immediately at zero DB cost via pageService's host cache.
 *
 * Submission envelope (FLAT — deliberately not the {body,headers,...} shape
 * the /hooks/:slug HTTP receiver builds):
 *   { ...formFields, _page, _host, _ip, _referrer, _ua }
 *   Hook filters/mappers for landing pages therefore use bare paths
 *   ("website", "_page"), not "body.website". A hook wired to a landing page
 *   that ALSO receives direct POSTs at /hooks/<slug> will see two different
 *   shapes — don't share slugs between the two ingest styles.
 *
 * Anti-spam (this slice, all in-memory / per-instance):
 *   - Honeypot: non-empty `website` field → silently drop, still 303.
 *   - Rate limit: 10 POSTs/min/IP (fixed window) → silently drop, still 303.
 *   Client IP = cf-connecting-ip header falling back to req.ip.
 *
 * Auto-mounts via the routes/ scan in server.js. `/p/:slug` is two segments,
 * so the single-segment `GET /:page` static catch-all doesn't intercept it
 * (same reasoning as /r/:slug in api.redirects.js).
 */

const express = require('express');
const router = express.Router();
const pageService = require('../services/pageService');
const hookService = require('../services/hookService');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

/** Effective host: proxy-supplied original host, else Express's (XFH-aware). */
function effectiveHost(req) {
  const raw = req.headers['x-original-host'] || req.hostname || '';
  return String(raw).toLowerCase().replace(/:\d+$/, '');
}

// ── Rate limiter: fixed 60s window, 10 POSTs per IP, in-memory ──
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 10;
const rlBuckets = new Map(); // ip -> { windowStart, count }

function rateLimited(ip) {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now - b.windowStart >= RL_WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    rlBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count > RL_MAX;
}

// Sweep stale buckets so the Map can't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, b] of rlBuckets) {
    if (b.windowStart < cutoff) rlBuckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────
// Serve
// ─────────────────────────────────────────────────────────────

/**
 * Dead-page response: a visitor hitting a missing/draft/malformed slug gets
 * 302'd (303 for POSTs — covers stale open tabs) to the firm site
 * (fe-firm_site_url setting → FIRM_URL env) when set, else a plain 404.
 * Better to land a lost lead on the firm's main site than a bare error.
 */
function deadPage(res, { post = false } = {}) {
  const { cfg } = require('../lib/firmConfig');
  const url = (cfg('fe-firm_site_url') || '').trim();
  if (/^https?:\/\//i.test(url)) return res.redirect(post ? 303 : 302, url);
  return res.status(404).type('text').send('Not found');
}

function servePage(res, page) {
  res.status(200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-cache')
    .send(page.html);
}

// ─────────────────────────────────────────────────────────────
// Submit (shared by /p/:slug POST and the vanity-host middleware)
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the 303 Location for a page submission.
 *   absolute http(s) URL → as-is
 *   non-empty other      → treated as a page slug → /p/<slug>
 *   empty/null           → back to the URL the POST arrived on + ?submitted=1
 * Relative Locations resolve against the current host, so vanity-domain
 * submits stay on the vanity domain.
 */
function thankyouLocation(page, req) {
  const t = (page.thankyou_url || '').trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (t) return '/p/' + encodeURIComponent(t.toLowerCase());
  const base = (req.originalUrl || '/').split('?')[0];
  return base + '?submitted=1';
}

/**
 * Handle a form POST for an already-resolved live page.
 * Contract: ALWAYS responds 303 (drops are silent). Never errors to client.
 */
function handleSubmit(req, res, page) {
  const location = thankyouLocation(page, req);

  try {
    const ip = clientIp(req);

    // Rate limit → silent drop, still 303
    if (rateLimited(ip)) {
      return res.redirect(303, location);
    }

    // Honeypot → silent drop, still 303
    const body = req.body || {};
    if (body.website != null && String(body.website).trim() !== '') {
      return res.redirect(303, location);
    }

    // Build the flat envelope. Meta fields spread LAST so a malicious form
    // can't spoof _page/_ip etc.
    const input = {
      ...body,
      _page: page.slug,
      _host: effectiveHost(req),
      _ip: ip,
      _referrer: req.headers['referer'] || null,
      _ua: req.headers['user-agent'] || null,
    };

    if (page.hook_slug) {
      // Direct internal call — fire-and-forget. Respond before the pipeline
      // finishes; hook_executions carries the audit trail.
      hookService.executeHook(req.db, page.hook_slug, input).catch(err => {
        console.error(`[pages] hook pipeline error (page=${page.slug}, hook=${page.hook_slug}):`, err);
      });
    } else {
      console.warn(`[pages] submission received for page "${page.slug}" with no hook_slug — payload discarded`);
    }
  } catch (err) {
    // Never surface an error on POST — log and fall through to the redirect.
    console.error(`[pages] submit handler error (page=${page.slug}):`, err);
  }

  return res.redirect(303, location);
}

// ─────────────────────────────────────────────────────────────
// /p/:slug routes
// ─────────────────────────────────────────────────────────────

// Bare /p or /p/ (no slug) — same dead-page treatment as a bad slug.
router.get(['/p', '/p/'], (req, res) => deadPage(res));
router.post(['/p', '/p/'], (req, res) => deadPage(res, { post: true }));

router.get('/p/:slug', async (req, res) => {
  try {
    if (!pageService.SLUG_RE.test(String(req.params.slug || '').toLowerCase())) {
      return deadPage(res);
    }
    const page = await pageService.getPageBySlug(req.db, req.params.slug);
    if (!page || page.status !== 'live') {
      return deadPage(res);
    }
    return servePage(res, page);
  } catch (err) {
    console.error('GET /p/:slug error:', err);
    return deadPage(res);
  }
});

router.post('/p/:slug', async (req, res) => {
  try {
    const page = await pageService.getPageBySlug(req.db, req.params.slug);
    if (!page || page.status !== 'live') {
      return deadPage(res, { post: true });
    }
    return handleSubmit(req, res, page);
  } catch (err) {
    console.error('POST /p/:slug error:', err);
    return deadPage(res, { post: true });
  }
});

// ─────────────────────────────────────────────────────────────
// Origin separation (2026-08-16, ref/ORIGIN_SEPARATION_ROLLOUT.md)
//
// WHY: everything staff-authorable-and-public (landing pages, external form
// templates carrying code/css/hooks since the 2026-08-16 reversal) executes
// authored JS in visitors' browsers. Served from app.4lsg.com those scripts
// share an origin with the staff shell's localStorage JWT. Serving the whole
// public surface from a separate LANDING ORIGIN kills that class structurally
// — localStorage is origin-scoped, so page/form JS on the landing host cannot
// read the app-origin JWT, ever. See ref/EXTERNAL_CODE_CSS_DECISION.md
// (residual #1 → resolved by this slice).
//
// Config (lib/firmConfig — app_settings rows, env fallback, 60s cache):
//   landing_hosts    CSV; first entry = canonical. Empty = feature OFF.
//   landing_redirect '1' → non-landing hosts 302 the migrated GET surface
//                    (/p/*, /f/*, ext-mode render) to the canonical host.
//
// ON A LANDING HOST only the public allowlist responds:
//   /p, /p/:slug (GET/POST)      — landing pages (prefix form)
//   /:slug (GET/HEAD/POST)       — landing pages at ROOT paths (the pretty
//                                  URL: 4lsg.com/mypage). Allowlist wins on
//                                  collision; slug shape = SLUG_RE.
//   host+path pinned pages       — the pre-existing vanity mechanism, still
//                                  honored (an explicit pin beats a slug).
//   /f/:form_key (GET)           — external form entry (routes/f.js)
//   /forms/render.html (GET)     — the external renderer (static)
//   /forms/hooks/<name>.js (GET) — renderer hook files (static)
//   /api/ext/* (GET/POST)        — the external form API
//   /css/yc-forms.css, /js/yc-forms.js, /favicon.ico (GET)
// EVERYTHING ELSE — /login, the shell, every staff/API route, every other
// static file — gets the deadPage treatment (firm-site redirect / 404). If a
// JWT could be minted or used on the landing host the boundary would be
// decorative; the allowlist contains no auth surface by construction.
//
// /f/*, ext render and /api/ext/* additionally carry X-Robots-Tag noindex:
// those URLs bear the case_id credential and must never enter an index.
// Pages do NOT — they are marketing surface and stay indexable.
// ─────────────────────────────────────────────────────────────

function normalizeHostValue(raw) {
  return String(raw || '')
    .trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

/** CSV from config, normalized. First entry = canonical redirect target. */
function landingHosts() {
  const { cfgList } = require('../lib/firmConfig');
  return cfgList('landing_hosts').map(normalizeHostValue).filter(Boolean);
}

function redirectsEnabled() {
  const { cfg } = require('../lib/firmConfig');
  return cfg('landing_redirect') === '1';
}

/**
 * LANDING MEMBERSHIP IS A SECURITY DECISION, so it must not rest on a single
 * client-suppliable header. effectiveHost() prefers x-original-host, and
 * under trust proxy req.hostname prefers X-Forwarded-Host — both arrive from
 * the client on this chain (see lib/rateLimiter's XFF note: only the LAST
 * XFF element is GFE-appended; named host headers are pass-through). Without
 * this union, authored page JS on the landing origin could same-origin-fetch
 * with `x-original-host: app.4lsg.com`, un-gate itself, reach /login on the
 * landing origin and mint a stealable JWT there — exactly the hole this
 * slice exists to close.
 *
 * Rule: if ANY host candidate (x-original-host, X-Forwarded-Host, raw Host)
 * names a landing host, landing gating applies. A spoofed header can
 * therefore only ever RESTRICT a request (harmless), never widen it: the raw
 * Host on a request that truly arrived via the landing domain mapping is the
 * landing host, and no header removes it from the candidate set.
 */
function isLandingRequest(req, lHosts) {
  if (!lHosts.length) return false;
  const candidates = [
    req.headers['x-original-host'],
    String(req.headers['x-forwarded-host'] || '').split(',')[0],
    req.headers.host,
  ];
  return candidates.some((c) => c && lHosts.includes(normalizeHostValue(c)));
}

/** Hook-file names the renderer itself accepts (render.html hook loader). */
const HOOK_FILE_RE = /^\/forms\/hooks\/[a-zA-Z0-9_-]{1,80}\.js$/;
const F_ROUTE_RE   = /^\/f\/[^/]+$/;

/** Paths that carry the case_id bearer credential — keep them out of indexes. */
function isCredentialedPath(p) {
  return F_ROUTE_RE.test(p) || p === '/forms/render.html' || p.startsWith('/api/ext/');
}

/**
 * The landing-host allowlist. Method-aware, path-only (query never widens
 * access). Returning true means "fall through to normal routing" — the
 * matching handlers are the SAME routes/static files the app host uses;
 * nothing is forked.
 */
function landingAllowed(req) {
  const p = req.path;
  const m = req.method;
  const isRead = m === 'GET' || m === 'HEAD';
  if (p === '/p' || p === '/p/' || p.startsWith('/p/')) return isRead || m === 'POST';
  if (F_ROUTE_RE.test(p))              return isRead;
  if (p === '/forms/render.html')      return isRead;
  if (HOOK_FILE_RE.test(p))            return isRead;
  if (p.startsWith('/api/ext/'))       return isRead || m === 'POST' || m === 'OPTIONS';
  // Redirect short-links (routes/api.redirects.js). Staff-authored TARGETS,
  // but the response is only ever a Location header (or the branded
  // dead-link page, repo code) — no authored markup/JS executes, so no
  // origin-separation concern. Requested by Fred 2026-08-16 so short public
  // links can ride the landing host too.
  if (/^\/r\/[^/]+$/.test(p))          return isRead;
  if (p === '/css/yc-forms.css')       return isRead;
  if (p === '/js/yc-forms.js')         return isRead;
  if (p === '/favicon.ico')            return isRead;
  return false;
}

/**
 * On every NON-landing host (app.4lsg.com and any future host): the migrated
 * public GET surface. POSTs deliberately do NOT redirect — a 302 turns POST
 * into GET and drops the body, so /p/:slug submits and /api/ext keep working
 * on the app host through the transition (an already-open form finishes where
 * it started). GET navigations are what move.
 */
function isMigratedPath(req) {
  const p = req.path;
  if (p === '/p' || p === '/p/' || p.startsWith('/p/')) return true;
  if (F_ROUTE_RE.test(p)) return true;
  // ext-mode render only — the internal renderer (iframed by the shell /
  // formInbox, no ext=1) must keep serving on the app host.
  if (p === '/forms/render.html' && req.query && req.query.ext === '1') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────
// Host-routing middleware (factory — closes over the db pool because it
// runs BEFORE the req.db-attaching middleware in server.js)
// ─────────────────────────────────────────────────────────────

function pageHostMiddleware(db) {
  return async function pageHost(req, res, next) {
    try {
      const host = effectiveHost(req);
      if (!host) return next();

      const lHosts = landingHosts();
      const isLanding = isLandingRequest(req, lHosts);

      if (!isLanding) {
        // ── Non-landing host ────────────────────────────────────────────
        // 1. Pre-existing vanity-page mechanism, unchanged: zero-DB-cost Set
        //    lookup on the warm path; unknown host (i.e. all normal
        //    app.4lsg.com traffic) falls straight through it.
        if (await pageService.isKnownHost(db, host)) {
          const path = pageService.normalizePath(req.path);
          const page = await pageService.getLivePageByHostPath(db, host, path);
          if (page) {
            if (req.method === 'GET' || req.method === 'HEAD') {
              return servePage(res, page);
            }
            if (req.method === 'POST') {
              if (!req.db) req.db = db; // runs before the req.db middleware
              return handleSubmit(req, res, page);
            }
            return res.status(405).set('Allow', 'GET, HEAD, POST').type('text').send('Method Not Allowed');
          }
        }
        // 2. Origin-separation redirects: send the migrated public surface to
        //    the canonical landing host, full query string intact (case_id
        //    credentials in live SMS links ride req.originalUrl). 302, not
        //    301: nothing may cache the mapping while it can still be
        //    reverted by flipping landing_redirect to '0'.
        if (
          lHosts.length &&
          redirectsEnabled() &&
          (req.method === 'GET' || req.method === 'HEAD') &&
          isMigratedPath(req)
        ) {
          res.set('Cache-Control', 'no-store');
          return res.redirect(302, 'https://' + lHosts[0] + req.originalUrl);
        }
        return next();
      }

      // ── Landing host ──────────────────────────────────────────────────
      // 0. Canonicalize. Secondary landing hosts (www today; a reclaimed
      //    `go` later) exist so the browser gets a real certificate on the
      //    name people actually type — NOT so links fragment across two
      //    origins. GET/HEAD move to the canonical host (landing_hosts[0]),
      //    query string intact. POST is served in place: a 302 would turn it
      //    into a GET and drop the body (same reasoning as the app-host
      //    redirect above), and canonicalized navigation means a POST can
      //    only arrive here from a page loaded before the switch.
      //
      //    effectiveHost() — not the spoof-proof union — is correct here:
      //    this is a cosmetic/link-hygiene decision, not an access decision.
      //    A forged header can at worst cause one extra redirect hop; the
      //    gate above already ran on the union.
      if (
        host !== lHosts[0] && lHosts.includes(host) &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        res.set('Cache-Control', 'no-store');
        return res.redirect(302, 'https://' + lHosts[0] + req.originalUrl);
      }

      // 1. Allowlist → normal routing (f.js, pageLanding router, api.ext,
      //    express.static). Credentialed paths get the noindex header here so
      //    it covers the static renderer too.
      if (landingAllowed(req)) {
        if (isCredentialedPath(req.path)) {
          res.set('X-Robots-Tag', 'noindex, nofollow');
        }
        return next();
      }

      // 2. Explicitly pinned host+path pages (the vanity mechanism) still
      //    win on a landing host — an explicit pin beats an implicit slug.
      //    isKnownHost is the zero-DB-cost gate: no pinned rows for this
      //    host → no query spent on bot noise.
      if (await pageService.isKnownHost(db, host)) {
        const pinned = await pageService.getLivePageByHostPath(
          db, host, pageService.normalizePath(req.path)
        );
        if (pinned) {
          if (req.method === 'GET' || req.method === 'HEAD') return servePage(res, pinned);
          if (req.method === 'POST') {
            if (!req.db) req.db = db;
            return handleSubmit(req, res, pinned);
          }
          return res.status(405).set('Allow', 'GET, HEAD, POST').type('text').send('Method Not Allowed');
        }
      }

      // 3. Root-path page slugs — the pretty URL (4lsg.com/mypage serves the
      //    live page with slug "mypage"; POST submits it, same contract as
      //    /p/:slug). Single segment only; SLUG_RE has no dot, so asset-ish
      //    names (favicon.ico) can never resolve as pages.
      const seg = req.path.replace(/^\/+|\/+$/g, '').toLowerCase();
      if (
        seg && !seg.includes('/') && pageService.SLUG_RE.test(seg) &&
        (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST')
      ) {
        const page = await pageService.getPageBySlug(db, seg);
        if (page && page.status === 'live') {
          if (req.method === 'POST') {
            if (!req.db) req.db = db;
            return handleSubmit(req, res, page);
          }
          return servePage(res, page);
        }
      }

      // 4. Dead end — including '/', which replicates the registrar-level
      //    firm-site redirect this domain carried before the mapping. Never
      //    next(): nothing below this middleware may answer on this host.
      if (req.method === 'GET' || req.method === 'HEAD') return deadPage(res);
      if (req.method === 'POST') return deadPage(res, { post: true });
      return res.status(405).set('Allow', 'GET, HEAD, POST').type('text').send('Method Not Allowed');
    } catch (err) {
      console.error('[pages] host middleware error:', err);
      // Fail-open ONLY off the landing boundary: on a landing request a
      // thrown error must not fall through to the full app surface.
      try {
        if (isLandingRequest(req, landingHosts())) return deadPage(res);
      } catch (_) { /* fall through */ }
      return next(); // never take the app down over a landing page
    }
  };
}

router.pageHostMiddleware = pageHostMiddleware;

module.exports = router;