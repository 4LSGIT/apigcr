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
 */

const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const videoService = require('../services/videoService');

const router = express.Router();

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

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',').shift().trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

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
function renderActions(actions, contactId) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const cVal = contactId != null ? String(contactId) : '';
  const out = [];
  for (const a of actions) {
    switch (a?.type) {
      case 'url': {
        const rawUrl = String(a.config?.url || '').replace(/\{\{c\}\}/g, cVal);
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
function renderRelated(relatedVideos, contactId) {
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
    // canonical first, then alias — both gated to published.
    const video = await videoService.getVideoBySlug(req.db, req.params.slug, {
      mustBePublished: true,
    });
    if (!video) return res.status(404).type('text/plain').send('Not found');

    // Resolve ?c= → real contact_id, or null.
    let contactId = null;
    if (req.query.c != null && req.query.c !== '') {
      const id = parseInt(req.query.c, 10);
      if (Number.isFinite(id) && id > 0 && String(id) === String(req.query.c)) {
        const [c] = await req.db.query(
          'SELECT contact_id FROM contacts WHERE contact_id = ? LIMIT 1',
          [id],
        );
        if (c.length) contactId = c[0].contact_id;
      }
    }

    // Gate: contact_only requires a resolved contact.
    if (video.access_level === 'contact_only' && contactId == null) {
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
      relatedHtml = renderRelated(related, contactId);
    } catch (err) {
      console.error('[GET /v/:slug] getRelatedVideos failed:', err);
    }

    const actions     = video.actions; // already hydrated by service
    const description = video.description || '';

    // Use the canonical slug for og:url and the in-page tracker — even if the
    // request hit an alias.
    const landingUrl = req.protocol + '://' + req.get('host') + '/v/' + video.slug;

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
      '{{ACTIONS_HTML}}':     renderActions(actions, contactId),
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