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
 * ── TWO KINDS OF LINK, DO NOT CONFUSE THEM ────────────────────────────────
 *   /view   files/get_temporary_link — expires in ~4h, creates no ACL. This is
 *           the default for showing a document to staff. Never persisted:
 *           storing an expiring URL just means storing a dead one.
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
    res.status(out.created ? 201 : 200)
       .json({ status: 'success', created: out.created, links });
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
    res.json({ status: 'success', removed: true });
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
