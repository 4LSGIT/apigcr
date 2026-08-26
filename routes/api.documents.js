// routes/api.documents.js
//
/**
 * Documents API — registry surface
 * routes/api.documents.js
 *
 * GET    /api/documents               list (q, doc_type, tag, status, source,
 *                                     link_type+link_id, sort, limit, offset)
 * GET    /api/documents/:id           one row
 * PATCH  /api/documents/:id           edit title / doc_type / tags / status
 * POST   /api/documents/:id/links     link to a case/contact  { link_type, link_id, relation? }
 * DELETE /api/documents/:id/links     unlink                  { link_type, link_id }
 * GET    /api/documents/:id/view      expiring view URL (NOT persisted)
 * GET    /api/documents/:id/raw       SAME-ORIGIN bytes, size-gated (S3)
 * POST   /api/documents/:id/share     get-or-create the PERMANENT shared link
 * POST   /api/documents/register      { source?, external_id } → stat → upsert
 *
 * Thin wrapper. Rows live in services/documentService.js; bytes live behind
 * services/documentSourceService.js. This file does no SQL and knows no
 * Dropbox specifics beyond one folder guard on /register (see there).
 * Auto-mounted by the routes loader (no server.js edit).
 *
 * Auth: jwtOrApiKey (same as the other api.* routes). req.auth.userId exists
 * only on the JWT path — API-key callers legitimately have no user, so
 * created_by / actor fall to null rather than being invented.
 *
 * ── THREE WAYS TO GET AT THE BYTES, DO NOT CONFUSE THEM ───────────────────
 *   /view   files/get_temporary_link — expires in ~4h, creates no ACL. A URL
 *           the BROWSER fetches from Dropbox directly. Never persisted:
 *           storing an expiring URL just means storing a dead one. This is the
 *           DOWNLOAD path and the degrade target for everything below.
 *   /raw    THIS ORIGIN serves the bytes, behind jwtOrApiKey (S3). The only
 *           way to render a document INSIDE the app: a /view URL cannot back
 *           an <img>/<iframe> because Dropbox serves it
 *           `Content-Disposition: attachment`, with no CORS and a
 *           `Content-Security-Policy: sandbox` (S1 finding, re-verified S3).
 *           Size-gated — see the route.
 *   /share  sharing/create_shared_link_with_settings — a PERMANENT, PUBLIC,
 *           unauthenticated URL, persisted to documents.shared_link. It is the
 *           right handle for emailing a client a document and the wrong one
 *           for everything else. This route is the ONLY place one is minted.
 *
 * STYLE NOTE: unlike routes/api.dropbox.js (all POST-with-JSON, because firm
 * paths carry significant leading spaces that must never touch a query
 * string), this surface is REST-y — it addresses documents by numeric id and
 * never puts a path in a URL. Paths only ever appear in RESPONSE bodies.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const documents   = require('../services/documentService');
const sources     = require('../services/documentSourceService');

const DEFAULT_SOURCE = 'dropbox';

// ─────────────────────────────────────────────────────────────
// /raw — inline byte proxy limits (S3)
// ─────────────────────────────────────────────────────────────

/**
 * Hard ceiling on what /raw will buffer, in bytes.
 *
 * THIS GATE IS THE WHOLE REASON /raw IS SAFE TO SHIP. `provider.download`
 * returns a fully-buffered Buffer (dropboxService._content does
 * `Buffer.from(await res.arrayBuffer())` — there is no streaming path, and
 * adding one is explicitly out of scope for this slice). So the request's peak
 * heap is the file's own size, twice over in the worst case (the arrayBuffer
 * plus the Buffer copy).
 *
 * The estate's shape, measured off the registry: p99 = 6.8 MB, MAX = 343 MB.
 * A single unguarded /raw on that 343 MB row is ~700 MB of transient heap in
 * one Cloud Run instance, which is an OOM kill — taking every other in-flight
 * request on that instance with it. 25 MB clears the p99 by 3.7× and caps the
 * damage at something the instance can absorb.
 *
 * NOT an app_settings key: this is a memory-safety limit tied to the container
 * size, not a business preference, and a setting is a thing someone can raise
 * at 2am to "fix" a view that is degrading correctly.
 */
const RAW_INLINE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * ext → Content-Type, INLINE-SAFE TYPES ONLY. Anything absent is served as
 * octet-stream + attachment, which is the safe default and not a bug.
 *
 * WHAT IS DELIBERATELY ABSENT, and why, because the temptation to "just add
 * one more" is the whole risk here:
 *
 *   svg   — an SVG is a script host. Served inline from THIS origin it runs in
 *           THIS origin, with the staff session's cookies and localStorage
 *           (which is where the JWT lives). A firm whose documents arrive from
 *           courts, opposing counsel and clients cannot treat that as a
 *           theoretical.
 *   html  — same, more obviously.
 *   xml   — same via XSLT / entity tricks.
 *   txt / csv / json — not scriptable, but `X-Content-Type-Options: nosniff`
 *           plus attachment costs the user one click and removes a whole class
 *           of question. Add them later on purpose if someone asks.
 *
 * `tif` is absent because no browser renders it. `bmp` is absent because
 * nothing in the estate is one.
 */
const RAW_INLINE_MIME = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
};

/**
 * Build a Content-Disposition header value.
 *
 * Case files carry client names, so a filename is routinely non-ASCII (and
 * routinely contains a comma, a quote or a semicolon — all of which are
 * delimiters in this header). Two parameters, per RFC 6266 §4.1 / RFC 5987:
 *
 *   filename=  an ASCII-only fallback for parsers that predate the extension.
 *              Every byte outside printable ASCII, plus `"` and `\`, becomes
 *              `_` — a lossy name is fine here BECAUSE filename* carries the
 *              real one for anything built this decade.
 *   filename*  UTF-8 percent-encoded, which is the one that actually gets used.
 *
 * A header value must not contain CR/LF; encodeURIComponent cannot emit them
 * and the ASCII scrub replaces them, so both parameters are injection-safe by
 * construction rather than by a check.
 *
 * @param {string} disposition 'inline' | 'attachment'
 * @param {string} filename
 * @returns {string}
 */
function contentDisposition(disposition, filename) {
  const name  = String(filename == null ? '' : filename) || 'document';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; ` +
         `filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ─────────────────────────────────────────────────────────────
// Error → HTTP status. Same scheme as routes/api.dropbox.js: provider errors
// carry .status and a "→ <status>:" message shape, so client errors pass
// through and upstream 5xx becomes 502 (we are the proxy).
// ─────────────────────────────────────────────────────────────
function mapErrorStatus(err) {
  const m = (err && err.message) || '';
  if (typeof err?.status === 'number' && err.status >= 400) {
    return err.status < 500 ? err.status : 502;
  }
  const apiStatus = m.match(/→\s(\d{3}):/);
  if (apiStatus) {
    const code = Number(apiStatus[1]);
    return code >= 400 && code < 500 ? code : 502;
  }
  if (m.startsWith('unknown document source')) return 400;
  if (m.includes('is required') || m.includes('must be one of') ||
      m.includes('must not contain') || m.includes('provide path') ||
      m.includes('not both') || m.includes('out of allowed_urls')) return 400;
  if (m.includes('not connected')) return 502;
  return 500;
}

function sendError(res, err) {
  const status = mapErrorStatus(err);
  console.error(`[api.documents] ${status}:`, err.message);
  res.status(status).json({ status: 'error', message: err.message });
}

/** :id → positive integer, or null. */
function docId(req) {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Acting user — JWT only; API-key callers have none, and we do not invent one. */
function actingUserId(req) {
  const raw = req.auth && req.auth.userId;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Load the row or 404. Returns null after responding. */
async function loadOr404(req, res) {
  const id = docId(req);
  if (id == null) {
    res.status(400).json({ status: 'error', message: 'Invalid id' });
    return null;
  }
  const row = await documents.getById(req.db, id);
  if (!row) {
    res.status(404).json({ status: 'error', message: 'Document not found' });
    return null;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────
// POST /api/documents/register
// ─────────────────────────────────────────────────────────────
//
// Declared BEFORE the ':id' routes as a matter of habit, not necessity:
// Express matches in declaration order, and there is no POST
// '/api/documents/:id' for 'register' to be captured by today. Keeping it
// first means adding one later cannot silently shadow this. (Same
// future-proofing routes/api.assets.js applies to /api/assets/collections.)
//
// Body: { source?, external_id }
// Manual registration, and the end-to-end smoke test for the whole stack:
// provider.stat → documentService.upsertFromEntry → row.
router.post('/api/documents/register', jwtOrApiKey, async (req, res) => {
  try {
    const { source = DEFAULT_SOURCE, external_id } = req.body || {};
    if (!external_id) {
      return res.status(400).json({ status: 'error', message: 'external_id is required' });
    }

    const provider = sources.get(source);
    const entry    = await provider.stat(req.db, external_id);

    // Folder guard. Dropbox-shaped ('.tag'), and the one place a provider
    // specific leaks into this file — a folder would register as a row with
    // no size/rev/content_hash and pollute every list. Move this into the
    // provider when a second provider arrives and the shape stops being
    // universal. (S2's sync filters folders from the delta feed itself and
    // never comes through here.)
    if (entry && entry['.tag'] === 'folder') {
      return res.status(400).json({
        status: 'error',
        message: 'register targets files, not folders',
      });
    }

    const { row, created } = await documents.upsertFromEntry(req.db, source, entry, {
      eventSource: 'manual',
      actorUserId: actingUserId(req),
    });

    res.status(created ? 201 : 200).json({ status: 'success', created, document: row });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/documents — list
// ─────────────────────────────────────────────────────────────
router.get('/api/documents', jwtOrApiKey, async (req, res) => {
  try {
    const out = await documents.list(req.db, {
      q:         req.query.q,
      doc_type:  req.query.doc_type,
      tag:       req.query.tag,
      status:    req.query.status,          // omit → 'active'; 'all' disables
      source:    req.query.source,
      link_type: req.query.link_type,
      link_id:   req.query.link_id,
      sort:      req.query.sort,
      limit:     req.query.limit,
      offset:    req.query.offset,
    });
    res.json({ status: 'success', ...out }); // { documents, total, limit, offset }
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/documents/:id
// ─────────────────────────────────────────────────────────────
router.get('/api/documents/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadOr404(req, res);
    if (!row) return;
    const links = await documents.listLinks(req.db, row.id);
    res.json({ status: 'success', document: row, links });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/documents/:id — title / doc_type / tags / status
// ─────────────────────────────────────────────────────────────
router.patch('/api/documents/:id', jwtOrApiKey, async (req, res) => {
  try {
    const id = docId(req);
    if (id == null) return res.status(400).json({ status: 'error', message: 'Invalid id' });

    const b = req.body || {};
    const row = await documents.update(req.db, id, {
      title:    b.title,
      doc_type: b.doc_type,
      tags:     b.tags,
      status:   b.status,
    }, {
      eventSource: 'manual',
      actorUserId: actingUserId(req),
    });

    if (!row) return res.status(404).json({ status: 'error', message: 'Document not found' });
    res.json({ status: 'success', document: row });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/documents/:id/links — link to a case/contact
// ─────────────────────────────────────────────────────────────
// Body: { link_type, link_id, relation? }
router.post('/api/documents/:id/links', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadOr404(req, res);
    if (!row) return;

    const { link_type, link_id, relation } = req.body || {};
    if (!link_type || link_id == null || link_id === '') {
      return res.status(400).json({
        status: 'error', message: 'link_type and link_id are required',
      });
    }

    const out = await documents.link(req.db, row.id, link_type, link_id, {
      relation:    relation ?? null,
      createdBy:   actingUserId(req),
      eventSource: 'manual',
    });

    const links = await documents.listLinks(req.db, row.id);
    // link_type / link_id are ECHOED for the sync bus (see the DELETE twin —
    // that one has no other way to name its target, and a getter that reads
    // the same two keys on both verbs is the point of echoing here too).
    // `links` alone cannot serve: it lists every target, with nothing marking
    // which one this call touched.
    res.status(out.created ? 201 : 200)
       .json({
         status:  'success',
         created: out.created,
         links,
         link_type: String(link_type),
         link_id:   String(link_id),
       });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/documents/:id/links — unlink
// ─────────────────────────────────────────────────────────────
// Body: { link_type, link_id }. Body-on-DELETE is unusual but keeps the pair
// symmetric with POST and avoids putting a case id in a URL segment.
router.delete('/api/documents/:id/links', jwtOrApiKey, async (req, res) => {
  try {
    const id = docId(req);
    if (id == null) return res.status(400).json({ status: 'error', message: 'Invalid id' });

    const { link_type, link_id } = req.body || {};
    if (!link_type || link_id == null || link_id === '') {
      return res.status(400).json({
        status: 'error', message: 'link_type and link_id are required',
      });
    }

    const removed = await documents.unlink(req.db, id, link_type, link_id);
    if (!removed) return res.status(404).json({ status: 'error', message: 'Link not found' });

    // ECHO THE TARGET (S3). The sync bus's sniff sees the response body and
    // NEVER the request body, so without these two keys a detach is an
    // announcement with no address: the case/contact widget that just lost a
    // document would keep showing it until someone reloaded the tab. This is
    // the same reason routes/api.appts.js echoes `appt_id` on
    // POST /api/appts/cancel — see yc-sync's bodyIdGetter comment.
    res.json({
      status:    'success',
      removed:   true,
      link_type: String(link_type),
      link_id:   String(link_id),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/documents/:id/view — expiring URL
// ─────────────────────────────────────────────────────────────
// ~4h Dropbox expiry, no ACL created. Deliberately NOT persisted.
router.get('/api/documents/:id/view', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadOr404(req, res);
    if (!row) return;

    const provider = sources.get(row.source);
    const { url, metadata } = await provider.tempViewUrl(req.db, row.external_id);
    res.json({ status: 'success', url, metadata: metadata || null });
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/documents/:id/raw — same-origin bytes (S3)
// ─────────────────────────────────────────────────────────────
//
// The ONLY way staff view a document without minting a public URL. /view
// hands back a Dropbox URL the browser cannot render in-page (attachment
// disposition, no CORS, CSP sandbox), and /share would mint a permanent
// unauthenticated link just to look at a file — so the bytes come through
// here, behind the same auth as every other route on this surface.
//
// The client is expected to fetch this with apiSend's `responseType:'blob'`
// and hand the result to URL.createObjectURL. It CANNOT be an <iframe src>
// or <img src> pointing here: the browser sends no Authorization header on a
// subresource load, and there is no auth cookie in this app, so it would 401.
// (public/formInbox.html's downloadPdf is the established precedent.)
router.get('/api/documents/:id/raw', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadOr404(req, res);
    if (!row) return;

    // 410, not 404: the row is right here and the caller's id was correct.
    // The distinction matters to the UI — 404 means "your link is wrong",
    // 410 means "this file was removed from Dropbox and the registry knows".
    if (row.status === 'deleted') {
      return res.status(410).json({
        status: 'error',
        message: 'This document has been deleted from storage.',
      });
    }

    // SIZE GATE, BEFORE ANY PROVIDER CALL. The registry already knows the
    // size, so the expensive thing never starts. See RAW_INLINE_MAX_BYTES.
    //
    // A NULL size is treated as OVER the cap, deliberately: "we do not know
    // how big this is" is not a reason to find out by buffering it. Every
    // Dropbox-sourced row has a size; a null one means a provider that did
    // not report one, and the honest response to an unknown is the degrade
    // path, not a gamble on the container's heap.
    const size = row.size == null ? null : Number(row.size);
    if (size == null || !Number.isFinite(size) || size > RAW_INLINE_MAX_BYTES) {
      return res.status(413).json({
        status:  'error',
        message: size == null || !Number.isFinite(size)
          ? 'Size unknown — download this document instead of viewing it inline.'
          : 'Too large to view inline — download this document instead.',
        size:    size == null || !Number.isFinite(size) ? null : size,
        cap:     RAW_INLINE_MAX_BYTES,
      });
    }

    const provider = sources.get(row.source);
    const { buffer } = await provider.download(req.db, row.external_id);

    const ext    = String(row.ext || '').toLowerCase();
    const inline = Object.prototype.hasOwnProperty.call(RAW_INLINE_MIME, ext);
    const mime   = inline ? RAW_INLINE_MIME[ext] : 'application/octet-stream';

    // The mime comes from OUR map keyed on the extension, never from
    // `row.mime` (which is whatever the provider claimed) and never from the
    // response — a caller-influenced Content-Type on a same-origin route is
    // the bug this whole allow-list exists to prevent. nosniff then stops the
    // browser second-guessing us in the other direction.
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition',
      contentDisposition(inline ? 'inline' : 'attachment', row.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // PRIVATE. This is a case document behind a login; a shared cache holding
    // it would serve one client's file to the next request. 5 minutes is long
    // enough for a page-flip or a reload and short enough that a status change
    // is not stale for long.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Length', String(buffer.length));

    res.status(200).end(buffer);
  } catch (err) {
    sendError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/documents/:id/share — permanent shared link
// ─────────────────────────────────────────────────────────────
// The ONLY place a permanent public link is minted. Get-or-create at the
// provider, then cache it on the row so a second call is a no-op there too.
router.post('/api/documents/:id/share', jwtOrApiKey, async (req, res) => {
  try {
    const row = await loadOr404(req, res);
    if (!row) return;

    const provider = sources.get(row.source);
    const url = await provider.ensureSharedLink(req.db, row.external_id);

    // The service owns the clamp (shared_link is VARCHAR(512) and this DB has
    // no STRICT_TRANS_TABLES) and the write; this route stays SQL-free.
    const stored = await documents.setSharedLink(req.db, row.id, url);

    res.json({ status: 'success', shared_link: stored });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
