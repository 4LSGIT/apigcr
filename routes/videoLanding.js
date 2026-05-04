/**
 * Video Landing Route
 * routes/videoLanding.js
 *
 * GET /v/:slug — public-facing landing page. Reads views/v.html (cached
 * after first load), substitutes placeholders, sends as text/html.
 *
 * Slice 1: no view tracking, no viewId in HTML. Slice 2 will add those.
 *
 * Access control:
 *   - 404 if the slug doesn't match a published video.
 *   - 404 if access_level = 'contact_only' and ?c= is missing/invalid/unknown.
 *
 * The template lives in views/ (not public/) because both the static
 * middleware and the /:page catch-all in server.js would otherwise serve
 * the unsubstituted template at /v.html and /v.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');

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

function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
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

// ─────────────────────────────────────────────────────────────
// GET /v/:slug
// ─────────────────────────────────────────────────────────────

router.get('/v/:slug', async (req, res) => {
  try {
    const [rows] = await req.db.query(
      'SELECT * FROM videos WHERE slug = ? AND is_published = 1 LIMIT 1',
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).type('text/plain').send('Not found');
    const video = rows[0];

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

    const actions     = parseJsonField(video.actions);
    const landingUrl  = req.protocol + '://' + req.get('host') + '/v/' + video.slug;
    const description = video.description || '';

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
    };

    let html = getTemplate();

    // If no poster, strip og:image and twitter:image meta lines entirely.
    // Empty content="" produces broken previews on Slack/iMessage/etc.
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

module.exports = router;