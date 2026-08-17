// routes/videoLanding.js
//
/**
 * Video Landing Route
 * routes/videoLanding.js
 *
 * Public-facing endpoints (no auth):
 *   GET  /v/:slug                      — landing page (HTML)
 *   POST /api/v/:slug/track            — { viewId, event, watchSeconds?, completionPct? }
 *   POST /api/v/:slug/cta-click        — { viewId, label }
 *
 * Slug resolution order on GET:
 *   1. canonical (`videos.slug`)
 *   2. alias    (`video_slug_aliases.slug` → joins to videos)
 * Both lookups require `is_published = 1`. Alias hits serve in place — no
 * redirect to canonical. The canonical slug IS still passed to the inline
 * tracking script so the POST endpoints don't require a second alias lookup.
 *
 * View row is recorded ONLY after access checks pass (so 404s don't pollute
 * the log). Tracking-endpoint failures don't block rendering.
 *
 * The HTML template lives in views/ (not public/) so the static middleware
 * and the /:page catch-all in server.js don't accidentally serve the
 * unsubstituted template at /v.html or /v.
 *
 * Origin (2026-08-17 slice): this surface serves on the LANDING host
 * (routes/pageLanding.js allowlist — V_ROUTE_RE / API_V_POST_RE) and the app
 * host 302s GET /v/* there when landing_redirect='1'. This one is a SECURITY
 * migration, not the booking-style coherence move: title/description/actions
 * are staff-authored and rendered into HTML, which is the content class
 * origin separation exists for. og:url pins to landing_hosts[0] (see below).
 * Deliberately NOT in isCredentialedPath — ?c= is a raw contact_id
 * (attribution, not a bearer credential) and these pages are marketing
 * surface built to be shared; revisit if ?c= ever becomes a token.
 */

const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const videoService = require('../services/videoService');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Rate limits (2026-08-17). This route had NONE — and GET /v/:slug is an
// unauthenticated WRITE (slug lookup + optional contact lookup + an INSERT
// into video_views + a related-videos query per hit), so it needs a ceiling
// more than a read-only shell does. POSTs additionally feed recordCtaClick's
// unbounded JSON_ARRAY_APPEND on video_views.cta_clicks — the limiter is
// what bounds that column's growth per IP.
//
// Sizing, against 30 days of real traffic (video_views, 2026-08-17): 16
// views total, 13 unique IPs, max 2 views per IP per HOUR. The GET limit
// below matches the booking/manage read limit (30/min/IP) — >800× the
// observed per-IP peak, so carrier-grade-NAT false positives are a
// non-issue at this firm's scale. The POST limit must clear a legitimate
// playback session: v.html beacons progress every ~10 s → 6/min per playing
// video, plus play/complete/CTA events; 30/min covers several concurrent
// tabs behind one IP with headroom.
//
// getClientIp comes from lib/rateLimiter (LAST XFF element — the
// GFE-appended peer). The removed private copy here took the FIRST element,
// which is client-supplied on this chain (see lib/rateLimiter's doc block):
// fine for logging honest traffic, a bypass as a limiter key, and it also
// made hashIp-based view dedup/analytics spoofable. Behavior note: ip_hash
// values for the same client CHANGE at this deploy (different input string)
// — per-IP analytics continuity resets, accepted.
// ─────────────────────────────────────────────────────────────
const readLimited = makeLimiter(60 * 1000, 30); // GET  /v/:slug
const postLimited = makeLimiter(60 * 1000, 30); // POST track + cta-click (shared)

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'v.html');
let TEMPLATE_CACHE = null;

function getTemplate() {
  if (TEMPLATE_CACHE != null) return TEMPLATE_CACHE;
  TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return TEMPLATE_CACHE;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// getClientIp: imported from lib/rateLimiter (last-XFF). The private
// first-XFF copy that lived here until 2026-08-17 is gone — see the limiter
// block above for why first-element resolution was wrong for both keying
// and hashIp.

/**
 * Render the action button row.
 *
 * v2: 'signed_action' | 'chatbot' | 'comments' will be added here — do not
 * enumerate types in the landing route or the admin UI in a way that
 * requires editing both sides to add a new type. Future types should be
 * additive switch cases here and additive form options in the admin UI.
 *
 * Unknown types are skipped silently.
 */
function renderActions(actions, contactToken) {
  if (!Array.isArray(actions) || !actions.length) return '';
  // {{c}} / {{ct}} substitute the contact's TOKEN (contacts.contact_token) as
  // of 2026-08-17, not the raw contact_id it used to emit.
  //
  // This fixes a latent bug as much as it tightens security: the canonical
  // use case for an action URL is a booking link, and routes/booking.js
  // resolves its own ?c= against contact_token with a 32-hex TOKEN_RE — so
  // the old raw-integer substitution produced booking links that could never
  // resolve. Zero videos have actions configured (verified live 2026-08-17),
  // so there is nothing to migrate and no back-compat to keep.
  //
  // Empty when the visitor arrived without a token: an action URL then simply
  // carries an empty ?c=, which downstream treats as anonymous — the same
  // thing it did for an unknown contact before.
  const cVal = contactToken != null ? String(contactToken) : '';
  const out = [];
  for (const a of actions) {
    switch (a?.type) {
      case 'url': {
        const rawUrl = String(a.config?.url || '').replace(/\{\{ct\}\}/g, cVal)
                                                  .replace(/\{\{c\}\}/g, cVal);
        // Scheme allowlist — the authoritative gate (2026-08-17 XSS fix).
        // htmlEscape below prevents attribute breakout but not a javascript:
        // scheme; validateActions rejects these on write, so anything caught
        // here predates the gate or was written DB-direct. Skip the button
        // silently — same contract as unknown types — an inert button would
        // just look broken.
        if (!videoService.isSafeActionUrl(rawUrl)) {
          console.warn('[videoLanding] skipped action with disallowed URL scheme:',
            JSON.stringify(String(a.config?.url || '').slice(0, 120)));
          break;
        }
        const styleRaw = a.config?.style;
        const style = (styleRaw === 'primary' || styleRaw === 'secondary' || styleRaw === 'ghost')
          ? styleRaw
          : 'primary';
        const label = a.label || 'Open';
        out.push(
          `<a class="vid-btn vid-btn-${style}" `
          + `href="${htmlEscape(rawUrl)}" `
          + `target="_blank" rel="noopener">${htmlEscape(label)}</a>`,
        );
        break;
      }
      // future types: skip silently
    }
  }
  return out.join('');
}

/**
 * Render the related-videos section. Returns an empty string when there are
 * no related videos — the template's {{RELATED_HTML}} substitution then
 * becomes empty, and the page just doesn't show the section.
 *
 * Each card preserves ?c= so the contact context follows across navigations.
 */
function renderRelated(relatedVideos, contactId, contactToken) {
  if (!Array.isArray(relatedVideos) || !relatedVideos.length) return '';
  const cParam = contactId != null
    ? '?c=' + encodeURIComponent(String(contactId))
    : '';

  const cards = relatedVideos.map(v => {
    const href  = '/v/' + encodeURIComponent(v.slug) + cParam;
    const title = htmlEscape(v.title || '');
    const poster = v.gcs_poster_url
      ? `<img src="${htmlEscape(v.gcs_poster_url)}" alt="" loading="lazy">`
      : '<div class="related-no-poster"></div>';
    return `<a class="related-card" href="${href}">`
         +    `<div class="related-thumb">${poster}</div>`
         +    `<div class="related-title">${title}</div>`
         + `</a>`;
  }).join('');

  return `<section class="related-videos">`
       +   `<h2 class="related-heading">More videos</h2>`
       +   `<div class="related-grid">${cards}</div>`
       + `</section>`;
}

// ─────────────────────────────────────────────────────────────
// GET /v/:slug
// ─────────────────────────────────────────────────────────────

router.get('/v/:slug', async (req, res) => {
  try {
    if (readLimited(getClientIp(req))) {
      return res.status(429).type('text/plain').send('Too many requests');
    }
    // canonical first, then alias — both gated to published.
    const video = await videoService.getVideoBySlug(req.db, req.params.slug, {
      mustBePublished: true,
    });
    if (!video) return res.status(404).type('text/plain').send('Not found');

    // ── Resolve the contact (2026-08-17: ?ct= token replaces ?c= integer) ──
    //
    // ?ct=<contacts.contact_token> is a 32-hex bearer — the same per-contact
    // token booking uses (column renamed from booking_token in the companion
    // commit). It is unguessable, so it is the ONLY thing that may satisfy the
    // contact_only gate.
    //
    // ?c=<contact_id> is the deprecated legacy form. It is a raw sequential
    // integer that anyone can mint, so it was never a credential — it let
    // anyone attribute views to arbitrary contacts by walking 1,2,3… and
    // (latently) defeat contact_only entirely. It is now ACCEPTED FOR
    // ATTRIBUTION ONLY and never satisfies the gate.
    //
    // Why accept it at all: ~17 links carrying ?c= were sent to ~12 contacts
    // between 2026-05 and 2026-08 and are still in inboxes. Rejecting the
    // param would 404 a client on a video the firm sent them. Ignoring it
    // silently would work too, but keeping the attribution costs one lookup
    // and loses nothing — the integer never granted access before this change
    // either, since all 17 videos are access_level='public'.
    //
    // Precedence: ?ct= wins outright. A request carrying both uses the token
    // and ignores ?c= — no "fall back to the integer if the token misses",
    // which would hand an attacker a downgrade path.
    let contactId    = null;
    let contactToken = null;          // non-null ⇒ credentialed, gate may pass
    const rawCt = req.query.ct;
    if (typeof rawCt === 'string' && /^[a-f0-9]{32}$/i.test(rawCt)) {
      const [c] = await req.db.query(
        'SELECT contact_id, contact_token FROM contacts WHERE contact_token = ? LIMIT 1',
        [rawCt],
      );
      if (c.length) {
        contactId    = c[0].contact_id;
        contactToken = c[0].contact_token;
      }
    } else if (req.query.c != null && req.query.c !== '') {
      // Legacy, attribution-only. Logged so the tail can be watched and the
      // branch eventually deleted.
      const id = parseInt(req.query.c, 10);
      if (Number.isFinite(id) && id > 0 && String(id) === String(req.query.c)) {
        const [c] = await req.db.query(
          'SELECT contact_id FROM contacts WHERE contact_id = ? LIMIT 1',
          [id],
        );
        if (c.length) {
          contactId = c[0].contact_id;
          console.warn('[videoLanding] deprecated ?c= integer used', {
            slug: req.params.slug, contactId,
          });
        }
      }
    }

    // Gate: contact_only requires a TOKEN-resolved contact. An attribution-only
    // ?c= hit is deliberately not enough — that was the whole defect.
    if (video.access_level === 'contact_only' && contactToken == null) {
      return res.status(404).type('text/plain').send('Not found');
    }

    // ── Record the view (post-access-check). Tracking failures must not
    //    break rendering — log and continue with an empty viewId so the
    //    inline script no-ops.
    let viewId = '';
    try {
      const ipHash    = videoService.hashIp(getClientIp(req));
      const userAgent = (req.headers['user-agent'] || '').slice(0, 255);
      const r = await videoService.recordView(req.db, {
        videoId:   video.id,
        contactId,
        ipHash,
        userAgent,
      });
      if (r && r.viewId != null) viewId = String(r.viewId);
    } catch (err) {
      console.error('[GET /v/:slug] recordView failed:', err);
    }

    // ── Resolve related videos (hand-picked + tag auto-fill). Failures
    //    again degrade gracefully.
    let relatedHtml = '';
    try {
      const related = await videoService.getRelatedVideos(req.db, video.id, {
        autoFill: true,
        limit:    3,
      });
      relatedHtml = renderRelated(related, contactId, contactToken);
    } catch (err) {
      console.error('[GET /v/:slug] getRelatedVideos failed:', err);
    }

    const actions     = video.actions; // already hydrated by service
    const description = video.description || '';

    // Use the canonical slug for og:url and the in-page tracker — even if the
    // request hit an alias. Host: pin to the canonical LANDING host when one
    // is configured (2026-08-17 slice) rather than echoing req.get('host') —
    // og:url is the URL social scrapers canonicalize to, and it must be the
    // public host even when this render happens on the app host (the
    // landing_redirect='0' revert state; www never renders here — the host
    // router 302s secondary landing hosts to the apex before routing).
    // {{LANDING_URL}} feeds ONLY the og:url meta; the tracker URLs in
    // views/v.html are relative and follow whichever host served the page.
    const landingUrl = require('../lib/firmConfig').publicUrl() + '/v/' + video.slug;

    // Single-line, escaped — for meta-tag content="" attributes.
    const descMeta = htmlEscape(description.replace(/\s*\n+\s*/g, ' '));
    // Body version — escaped first, then \n → <br>.
    const descBody = htmlEscape(description).replace(/\n/g, '<br>');

    const replacements = {
      '{{TITLE}}':            htmlEscape(video.title),
      '{{DESCRIPTION}}':      descMeta,
      '{{DESCRIPTION_BODY}}': descBody,
      '{{POSTER_URL}}':       htmlEscape(video.gcs_poster_url || ''),
      '{{VIDEO_URL}}':        htmlEscape(video.gcs_video_url),
      '{{LANDING_URL}}':      htmlEscape(landingUrl),
      '{{ACTIONS_HTML}}':     renderActions(actions, contactToken),
      '{{OG_TYPE}}':          'video.other',
      '{{TWITTER_CARD}}':     'summary_large_image',
      '{{VIEW_ID}}':          htmlEscape(viewId),
      '{{CANONICAL_SLUG}}':   htmlEscape(video.slug),
      '{{RELATED_HTML}}':     relatedHtml,
    };

    let html = getTemplate();

    // If no poster, strip og:image and twitter:image meta lines entirely.
    if (!video.gcs_poster_url) {
      html = html.replace(/[ \t]*<meta property="og:image"[^>]*>\n?/g, '');
      html = html.replace(/[ \t]*<meta name="twitter:image"[^>]*>\n?/g, '');
    }

    for (const [k, v] of Object.entries(replacements)) {
      html = html.split(k).join(v);
    }

    res
      .set('Content-Type', 'text/html; charset=utf-8')
      // Don't let proxies/CDNs cache this — actions URLs vary by ?c=.
      .set('Cache-Control', 'private, no-cache, no-store, must-revalidate')
      .send(html);

  } catch (err) {
    console.error('[GET /v/:slug]', err);
    res.status(500).type('text/plain').send('Internal error');
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v/:slug/track  — { viewId, event, watchSeconds?, completionPct? }
// ─────────────────────────────────────────────────────────────

const TRACK_EVENTS = new Set(['play', 'progress', 'complete']);

router.post('/api/v/:slug/track', async (req, res) => {
  try {
    if (postLimited(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const body = req.body || {};
    const { viewId, event, watchSeconds, completionPct } = body;

    // Validate event.
    if (!TRACK_EVENTS.has(event)) {
      return res.status(400).json({
        error: 'event must be one of: play, progress, complete',
      });
    }

    // Validate viewId — accept JSON number or numeric string.
    const vidNum = Number(viewId);
    if (!Number.isInteger(vidNum) || vidNum <= 0) {
      return res.status(400).json({ error: 'viewId must be a positive integer' });
    }

    // Validate progress payload.
    if (event === 'progress') {
      if (typeof watchSeconds !== 'number' || typeof completionPct !== 'number') {
        return res.status(400).json({
          error: 'progress requires numeric watchSeconds and completionPct',
        });
      }
    }

    // Resolve slug → video (handles aliases too — even though our own client
    // sends the canonical slug, accept either).
    const video = await videoService.getVideoBySlug(req.db, req.params.slug, {
      mustBePublished: true,
    });
    if (!video) return res.status(404).json({ error: 'Not found' });

    // Verify viewId belongs to this video. Prevents cross-video poisoning.
    const [check] = await req.db.query(
      'SELECT id FROM video_views WHERE id = ? AND video_id = ? LIMIT 1',
      [vidNum, video.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Not found' });

    if (event === 'play') {
      await videoService.recordPlayed(req.db, {
        viewId:  vidNum,
        videoId: video.id,
      });
    } else if (event === 'progress') {
      await videoService.recordProgress(req.db, {
        viewId:        vidNum,
        videoId:       video.id,
        watchSeconds,
        completionPct,
      });
    } else if (event === 'complete') {
      // 'complete' forces 100% but uses whatever watchSeconds the client
      // reported (still GREATEST-guarded by recordProgress).
      const ws = typeof watchSeconds === 'number' ? watchSeconds : 0;
      await videoService.recordProgress(req.db, {
        viewId:         vidNum,
        videoId:        video.id,
        watchSeconds:   ws,
        completionPct:  100,
      });
    }

    return res.status(204).end();
  } catch (err) {
    console.error('[POST /api/v/:slug/track]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/v/:slug/cta-click  — { viewId, label }
// ─────────────────────────────────────────────────────────────

router.post('/api/v/:slug/cta-click', async (req, res) => {
  try {
    if (postLimited(getClientIp(req))) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const body = req.body || {};
    const { viewId, label } = body;

    const vidNum = Number(viewId);
    if (!Number.isInteger(vidNum) || vidNum <= 0) {
      return res.status(400).json({ error: 'viewId must be a positive integer' });
    }
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }

    const video = await videoService.getVideoBySlug(req.db, req.params.slug, {
      mustBePublished: true,
    });
    if (!video) return res.status(404).json({ error: 'Not found' });

    const [check] = await req.db.query(
      'SELECT id FROM video_views WHERE id = ? AND video_id = ? LIMIT 1',
      [vidNum, video.id]
    );
    if (!check.length) return res.status(404).json({ error: 'Not found' });

    await videoService.recordCtaClick(req.db, {
      viewId:  vidNum,
      videoId: video.id,
      label:   label.slice(0, 200),
    });

    return res.status(204).end();
  } catch (err) {
    console.error('[POST /api/v/:slug/cta-click]', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;