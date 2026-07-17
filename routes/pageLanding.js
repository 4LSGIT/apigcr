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
 * VANITY-HOST MIDDLEWARE (exported as `router.pageHostMiddleware`):
 *   Registered in server.js BEFORE express.static (see server.js edit) so a
 *   mapped domain's root request never falls into public/index.html. The
 *   middleware is a closure over the db pool because it runs before the
 *   req.db-attaching middleware.
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
// Vanity-host middleware (factory — closes over the db pool because it
// runs BEFORE the req.db-attaching middleware in server.js)
// ─────────────────────────────────────────────────────────────

function pageHostMiddleware(db) {
  return async function pageHost(req, res, next) {
    try {
      const host = effectiveHost(req);
      if (!host) return next();

      // Zero-DB-cost Set lookup on the warm path. Unknown host (i.e. all
      // normal app.4lsg.com traffic) falls straight through.
      if (!(await pageService.isKnownHost(db, host))) return next();

      const path = pageService.normalizePath(req.path);
      const page = await pageService.getLivePageByHostPath(db, host, path);

      // No page at this host+path → fall through so /p/:slug, /r/:slug,
      // assets, etc. still work on a mapped domain.
      if (!page) return next();

      if (req.method === 'GET' || req.method === 'HEAD') {
        return servePage(res, page);
      }
      if (req.method === 'POST') {
        if (!req.db) req.db = db; // runs before the req.db middleware
        return handleSubmit(req, res, page);
      }
      return res.status(405).set('Allow', 'GET, HEAD, POST').type('text').send('Method Not Allowed');
    } catch (err) {
      console.error('[pages] host middleware error:', err);
      return next(); // never take the app down over a landing page
    }
  };
}

router.pageHostMiddleware = pageHostMiddleware;

module.exports = router;