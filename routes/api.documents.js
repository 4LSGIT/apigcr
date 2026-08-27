// routes/api.documents.js
//
/**
 * Documents API — registry surface
 * routes/api.documents.js
 *
 * GET    /api/documents               list (q, doc_type, ext, tag, status,
 *                                     source, link_type+link_id, related,
 *                                     sort, limit, offset)
 * GET    /api/documents/:id           one row
 * PATCH  /api/documents/:id           edit title / doc_type / tags / status
 * POST   /api/documents/:id/links     link to a case/contact  { link_type, link_id, relation? }
 * DELETE /api/documents/:id/links     unlink                  { link_type, link_id }
 * GET    /api/documents/:id/view      expiring view URL (NOT persisted)
 * GET    /api/documents/:id/raw       SAME-ORIGIN bytes, size-gated (S3)
 * POST   /api/documents/:id/share     get-or-create the PERMANENT shared link
 * POST   /api/documents/register      { source?, external_id } → stat → upsert
 *
 * S4 — staff upload. Same declaration-order rule as the two blocks below.
 * POST   /api/documents/upload-link   { case_id?|contact_id?, filename }
 *                                     → { link, path, placement, ticket, note? }
 * POST   /api/documents/upload-commit { ticket, external_id? } → register + link
 * The browser POSTs the bytes to Dropbox itself between the two — they never
 * transit this instance. See that block's header for the ticket's job.
 *
 * S3.2 — the sync panel's ops surface. NOTE THE DECLARATION ORDER: these are
 * registered BEFORE the ':id' routes or Express hands "sync-roots" to :id.
 * GET    /api/documents/sync-roots          roots + the kill-switch value
 * POST   /api/documents/sync-roots          { path, note? } → 201 (+ warning)
 * PATCH  /api/documents/sync-roots/:id      { enabled } — the only mutable field
 * POST   /api/documents/sync-roots/:id/sync manual tick for ONE root
 * GET    /api/documents/sync-diagnostics    latest out_of_root / zero-attribution
 * POST   /api/documents/sync-diagnostics    run the attribution report now
 * There is NO DELETE for a root — see the section header for why.
 *
 * S3.3 — the guided re-link. Same declaration-order rule.
 * GET    /api/documents/relink/queue        zero-attribution cases + candidates
 * GET    /api/documents/relink/:caseId/candidates
 * POST   /api/documents/relink              { case_id, folder_path } — THE CONFIRM
 * POST   /api/documents/relink/dismiss      { case_id | case_ids, undo? }
 * There is NO BULK RE-LINK — see that section's header for why.
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

// ─────────────────────────────────────────────────────────────
// Sync-panel limits (S3.2)
// ─────────────────────────────────────────────────────────────

/**
 * Page budget for a MANUAL per-root sync.
 *
 * Two pages, not the recurring job's 25. A hand-press answers "does this root
 * move, and what does it say" — and each page is up to 2,000 entries, every one
 * of them upserted inside this HTTP request. The backfill is the recurring
 * job's work; it has a poll tick to live in and this does not.
 */
const MANUAL_SYNC_MAX_PAGES = 2;

/**
 * Wall-clock bound for an on-demand attribution report, tighter than the
 * service's own 3-minute default.
 *
 * The default is sized for a background instrument that can afford to be slow.
 * This one is held open by a browser request, so it is capped at something a
 * person will actually wait through — and hitting it is a normal outcome the
 * report already reports (verdict 'incomplete_scan'), not an error.
 */
const DIAGNOSTIC_RUN_MAX_MS = 90 * 1000;

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

// ═════════════════════════════════════════════════════════════════════════════
// STAFF UPLOAD (S4) — two calls around a browser→Dropbox transfer
//
// ⚠️ DECLARED BEFORE THE ':id' ROUTES for the reason the sync-roots block
// states at length: '/api/documents/upload-link' and '/api/documents/:id' are
// both two segments after the prefix, and whichever is declared first wins.
//
// ── WHY TWO CALLS AND NOT ONE ───────────────────────────────────────────────
// Because the bytes must not transit this instance. Cloud Run holds a request's
// whole body in heap, /raw's RAW_INLINE_MAX_BYTES comment does the arithmetic
// for why that is an OOM waiting to happen, and this app already has a proven
// pattern that avoids it: mint a Dropbox temporary upload link, let the browser
// POST straight to Dropbox, then tell the server what landed. public/docReq.html
// and public/portal/docs.html have shipped exactly this for client uploads.
//
// So: /upload-link issues the destination, /upload-commit registers the result.
//
// ── THE GAP BETWEEN THEM IS CROSSED BY A SIGNED TICKET ──────────────────────
// Nothing else travels between the two moments, and the commit LINKS THE FILE
// TO A CASE — so an unauthenticated case id in the commit body would make this
// a "register any file against any case" verb. lib/uploadTicket.js MACs the
// issued destination and its context; the commit verifies the MAC and then
// re-checks the file's real, statted parent folder against the issued one.
// Both halves are needed: the ticket proves WE chose this destination, the
// parent check proves the committed file is actually in it.
//
// (POST /api/documents/register remains the deliberate, visible way to register
// an arbitrary file. This surface is not a second one wearing a disguise.)
// ═════════════════════════════════════════════════════════════════════════════

/** Upload destinations, and the human sentence each one is owed. */
const UPLOAD_PLACEMENT_NOTE = {
  unsorted_contact:
    'Contacts have no Dropbox folder convention, so this file goes to the ' +
    'unsorted uploads folder and is linked to the contact here. Move it ' +
    'wherever it belongs — the link follows the file.',
  unsorted_global:
    'No case or contact is selected, so this file goes to the unsorted ' +
    'uploads folder unattached. Link it to a case from the documents list.',
};

/**
 * Filename sanitizer for the STAFF surface.
 *
 * Same rules as the public docReq route (strip path separators and leading
 * dots, cap the length): a filename becomes a Dropbox path segment, so a
 * caller who can put '/' in it can steer the destination out of the folder the
 * ticket signed. Staff are trusted with the app; they are not the only thing
 * that reaches this route, and a path-traversal guard that only runs on the
 * public copy is a guard that will eventually be missing from the one that
 * matters.
 *
 * NO EXTENSION ALLOW-LIST, unlike the client surfaces. Those exist to stop a
 * client sending us something unexpected; staff filing a .msg, a .zip of
 * exhibits or a court's .txt docket are doing their job, and the estate is
 * full of all three.
 */
function safeUploadFilename(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200) || 'upload.dat';
}

/** Parent folder of a Dropbox path, lowercased. '' for a root-level file. */
function parentLower(p) {
  const s = String(p == null ? '' : p).toLowerCase();
  const i = s.lastIndexOf('/');
  return i <= 0 ? '' : s.slice(0, i);
}

/**
 * POST /api/documents/upload-link — { case_id? | contact_id?, filename }
 *
 * Resolves where this file should land, mints a Dropbox temporary upload link,
 * and returns it with a ticket the commit will demand back.
 *
 * ── THE LADDER, AND HOW IT DIFFERS FROM THE CLIENT ONE ──────────────────────
 *   case, folder linked  → the CASE FOLDER ROOT. Deliberately not the "Client
 *                          Uploads" subfolder uploadTargetService uses: that
 *                          subfolder means "a client sent this in and nobody
 *                          has filed it yet", and a staffer filing a document
 *                          from the case tab has already done the filing.
 *   case, no folder      → uploadTargetService.issueClientUploadLink, the full
 *                          shared ladder (auto-create the case folder + raise
 *                          the merge-review task, else the per-case unsorted
 *                          subfolder). Not reimplemented here — that ladder is
 *                          the firm's actual policy for "this case has no
 *                          folder" and forking it would let the two drift.
 *   contact              → the unsorted bin. THERE IS NO CONTACT FOLDER
 *                          CONVENTION in this firm's Dropbox; inventing one in
 *                          an upload endpoint would be a filing-policy decision
 *                          made by a side effect. The file gets an 'upload'
 *                          link to the contact and the UI says where it went.
 *   neither (global)     → the unsorted bin, unattached.
 */
router.post('/api/documents/upload-link', jwtOrApiKey, async (req, res) => {
  try {
    const dropbox     = require('../services/dropboxService');
    const uploadTarget = require('../services/uploadTargetService');
    const tickets     = require('../lib/uploadTicket');

    const b = req.body || {};
    const caseId    = b.case_id    == null || b.case_id    === '' ? null : String(b.case_id);
    const contactId = b.contact_id == null || b.contact_id === '' ? null : String(b.contact_id);

    if (caseId && contactId) {
      return res.status(400).json({
        status: 'error',
        message: 'provide case_id OR contact_id, not both — one upload has one owner',
      });
    }
    if (!b.filename) {
      return res.status(400).json({ status: 'error', message: 'filename is required' });
    }
    const filename = safeUploadFilename(b.filename);

    let link = null;
    let path = null;
    let placement = null;
    let note = null;

    if (caseId) {
      const [[caseRow]] = await req.db.query(
        'SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [caseId],
      );
      if (!caseRow) {
        return res.status(404).json({ status: 'error', message: 'Case not found' });
      }
      const sharedLink = (caseRow.case_dropbox && String(caseRow.case_dropbox).trim()) || '';

      if (sharedLink) {
        try {
          ({ link, path } = await dropbox.getTemporaryUploadLink(req.db, { sharedLink, filename }));
          placement = 'case';
        } catch (err) {
          console.warn(`[api.documents] upload-link: case folder unusable for ${caseId} (${err.message}) — falling back to the shared ladder`);
        }
      }
      if (!link) {
        // The shared ladder. It may auto-create the folder (and raise the
        // review task), or land in the per-case unsorted subfolder.
        const out = await uploadTarget.issueClientUploadLink(req.db, { caseId, filename });
        link = out.link;
        path = out.path;
        placement = out.placement === 'unsorted' ? 'unsorted_case' : out.placement;
        if (out.placement === 'unsorted') {
          note = 'This case has no working Dropbox folder, so the file goes to the ' +
                 'unsorted uploads folder. It is still linked to the case here.';
        }
      }
    } else {
      // Contact-scoped and global both land in the bare bin.
      const base = await uploadTarget.unsortedBasePath(req.db);
      ({ link, path } = await dropbox.getTemporaryUploadLink(req.db, { path: base, filename }));
      placement = contactId ? 'unsorted_contact' : 'unsorted_global';
      note = UPLOAD_PLACEMENT_NOTE[placement];
    }

    if (!path) {
      // Defensive: every rung above sets one, and a ticket without a path
      // cannot be checked at commit time. Better a 502 than a ticket that
      // waves everything through.
      throw new Error('dropbox did not report an upload destination');
    }

    const ticket = tickets.sign({
      path,
      ...(caseId    ? { link_type: 'case',    link_id: caseId }    : {}),
      ...(contactId ? { link_type: 'contact', link_id: contactId } : {}),
    });

    res.json({
      status: 'success', link, path, placement, ticket,
      ...(note ? { note } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/upload-commit — { ticket, external_id?, path? }
 *
 * The browser has finished POSTing bytes to Dropbox. Register what landed and
 * link it to the context the ticket carries.
 *
 * ── WHAT IS TRUSTED, AND WHAT IS CHECKED ────────────────────────────────────
 * `external_id` is the "id:…" handle out of DROPBOX's own response to the
 * upload POST — the authoritative answer to "what did you just create", and
 * the reason to prefer it over the issued path: every upload commits with
 * `autorename:true`, so a second "statement.pdf" lands as "statement (1).pdf"
 * and the issued path now names a DIFFERENT, PRE-EXISTING FILE. Registering
 * that one would attach the wrong document to the case, silently. The client
 * is the only party holding the id, so it is read from the request — and then
 * every claim it implies is re-derived from a stat.
 *
 * The check: the statted file's PARENT FOLDER must equal the parent of the
 * path the ticket signed. Not path equality (autorename), not a prefix test
 * (that would accept anything in a subtree). A valid ticket plus a file
 * somewhere else is a rejection, which is what stops a ticket for one case
 * being replayed against a file in another.
 */
router.post('/api/documents/upload-commit', jwtOrApiKey, async (req, res) => {
  try {
    const tickets = require('../lib/uploadTicket');
    const ingest  = require('../services/documentIngestService');

    const b = req.body || {};
    const claim = tickets.verify(b.ticket);   // throws 400 on anything wrong

    const source   = b.source || DEFAULT_SOURCE;
    const provider = sources.get(source);
    const locator  = (b.external_id && String(b.external_id)) || claim.path;

    let entry;
    try {
      entry = await provider.stat(req.db, locator);
    } catch (err) {
      // The overwhelmingly common cause is a browser committing an upload that
      // never actually completed. 404 rather than the provider's 409, so the
      // UI can say something true instead of "Dropbox error".
      const e = new Error(
        'that file is not in Dropbox — the upload did not complete, so there is nothing to register');
      e.status = 404;
      console.warn(`[api.documents] upload-commit stat failed for ${locator}: ${err.message}`);
      throw e;
    }

    if (entry && entry['.tag'] === 'folder') {
      return res.status(400).json({
        status: 'error', message: 'upload-commit targets files, not folders',
      });
    }

    // THE ANTI-LAUNDERING CHECK. See the route docblock.
    const landed = entry && (entry.path_lower || entry.path_display);
    if (!landed || parentLower(landed) !== parentLower(claim.path)) {
      return res.status(400).json({
        status: 'error',
        message: 'that file is not in the folder this upload was issued for',
      });
    }

    const links = claim.link_type
      ? [{ type: claim.link_type, id: claim.link_id }]
      : [];

    const out = await ingest.registerWritten(req.db, {
      entry, source, links,
      createdBy:   actingUserId(req),
      eventSource: 'upload',
    });

    // ECHO THE TARGET, same contract and same reason as the /:id/links pair:
    // the sync bus sniffs the RESPONSE and never the request, so without these
    // two keys a staff upload is a write with no address and every other open
    // view of that case keeps showing a list without the new file. A GLOBAL
    // upload has no target and echoes none — yc-sync's docLinkGetter fails
    // closed on that, which is correct: nothing's document set changed.
    const linked = out.links[0] || null;
    res.status(201).json({
      status:   'success',
      document: out.document,
      ...(linked ? {
        link_type: linked.link_type,
        link_id:   linked.link_id,
        relation:  linked.relation,
      } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SYNC ROOTS — the ops surface (S3.2)
//
// ⚠️ DECLARED BEFORE THE ':id' ROUTES, AND THIS IS LOAD-BEARING, NOT TIDINESS.
// Express matches in declaration order. `GET /api/documents/sync-roots` and
// `GET /api/documents/:id` are both two segments, so whichever is declared
// first wins — and if ':id' won, "sync-roots" would arrive as an id, fail
// docId()'s integer parse and 404 the whole panel with "Invalid id". Same for
// sync-diagnostics. The /register route's comment above warns about exactly
// this class of shadowing; these are the routes that make it real.
//
// NO DELETE VERB EXISTS HERE. See documentSyncService's roots section: a
// deleted root strands ~100k rows that no remaining root claims and no sync
// will revisit. Disable is the safe verb and it is the only one offered.
//
// This file still does no SQL. Every statement below lives in the service.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/documents/sync-roots
 *
 * The kill switch rides in the SAME envelope rather than behind a second call.
 * The panel has to render one banner ("sync is disabled") above the roots
 * table, and two requests to paint one view is two chances to render a table
 * of roots that look busy while the engine is off.
 */
router.get('/api/documents/sync-roots', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const [roots, enabled] = await Promise.all([
      sync.listRoots(req.db),
      sync.isSyncEnabled(req.db),
    ]);
    res.json({ status: 'success', roots, sync_enabled: enabled });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/sync-roots — { path, note? }
 *
 * 201 on create. A `warning` in the body means the folder does not exist in
 * Dropbox yet — the root WAS created and will start syncing when it appears
 * (three of the seeded roots live in exactly that state). That is a different
 * outcome from an error and the client must be able to tell them apart, which
 * is why it is a 201-with-warning and not a 4xx.
 */
router.post('/api/documents/sync-roots', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const { path, note } = req.body || {};
    const { root, warning } = await sync.addRoot(req.db, { path, note });
    res.status(201).json({
      status: 'success', root, ...(warning ? { warning } : {}),
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * PATCH /api/documents/sync-roots/:id — { enabled }
 *
 * `enabled` IS THE ONLY ACCEPTED FIELD, and anything else in the body is a 400
 * rather than a silent no-op. A caller sending { path } believes it repointed
 * the root; ignoring it quietly would leave them with a root they think is
 * watching one folder while it watches another. (Why path is immutable at all:
 * see setRootEnabled — the cursor belongs to the old folder and the rows
 * already registered keep the old prefix's attribution.)
 */
router.patch('/api/documents/sync-roots/:id', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid id' });
    }

    const body = req.body || {};
    const extra = Object.keys(body).filter(k => k !== 'enabled');
    if (extra.length) {
      return res.status(400).json({
        status: 'error',
        message: `only "enabled" can be changed on a sync root (rejected: ${extra.join(', ')}). ` +
                 'To change a path, disable this root and add the correct one.',
      });
    }
    if (body.enabled === undefined) {
      return res.status(400).json({ status: 'error', message: 'enabled is required' });
    }

    const root = await sync.setRootEnabled(req.db, id, !!body.enabled);
    if (!root) return res.status(404).json({ status: 'error', message: 'Sync root not found' });
    res.json({ status: 'success', root });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/sync-roots/:id/sync — one manual tick for ONE root.
 *
 * Reuses the path lib/internal_functions/documents.js's targeted run takes:
 * load the FULL row (cursor included — syncRoot needs it), then syncRoot with
 * a small page budget. Two rules inherited from there, both deliberate:
 *
 *   RUNS EVEN IF THE ROOT IS DISABLED. `enabled` keeps a root out of the
 *   automatic rotation; naming one by hand is the override, and making a
 *   disabled root unreachable would remove the only way to test a fix.
 *
 *   DOES NOT OVERRIDE THE KILL SWITCH. That switch means "this engine does not
 *   run", and a button that ignored it would be a second control surface —
 *   precisely what documents.js's rejection of firmConfig's env fallback was
 *   avoiding. Skipped, not 500: nothing went wrong.
 *
 * The claim in syncRoot is what makes this safe to press while the cron tick
 * is mid-walk — a loser gets { skipped: true, reason: 'claimed_elsewhere' }
 * back, which is a 200 with a shape the UI reports, not a failure.
 */
router.post('/api/documents/sync-roots/:id/sync', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid id' });
    }

    if (!await sync.isSyncEnabled(req.db)) {
      return res.json({
        status: 'success',
        result: { root_id: id, skipped: true, reason: 'documents_sync_enabled is not "1"' },
      });
    }

    const root = await sync.getRootRaw(req.db, id);
    if (!root) return res.status(404).json({ status: 'error', message: 'Sync root not found' });

    // Small budget. A hand-press is "show me this root moves", not "burn the
    // backfill down inside an HTTP request" — the recurring job owns that, and
    // 25 pages here would hold the connection open for minutes.
    const result = await sync.syncRoot(req.db, root, { maxPages: MANUAL_SYNC_MAX_PAGES });
    res.json({ status: 'success', result, root: await sync.getRoot(req.db, id) });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/documents/sync-diagnostics — what the recurring reports last said.
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ──────────────────────────────────────────
 * job_results IS the report surface for these functions (they persist nothing
 * else), and the only existing way to read one is GET /scheduled-jobs/:id,
 * which needs the numeric job id up front and has no lookup by function name.
 * documents_attribution_report has NO scheduled job at all, so that route can
 * never return its findings. Hence one endpoint that resolves both by name.
 *
 * It re-derives NOTHING. The zero-attribution question in SQL is a 986 × 153k
 * correlated LIKE that times out on the readonly endpoint; attributionReport
 * answers it in memory against a Set, and this only reads what a run wrote.
 */
router.get('/api/documents/sync-diagnostics', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const reports = await sync.latestJobReports(req.db);
    res.json({ status: 'success', reports });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/sync-diagnostics — run the attribution report NOW.
 *
 * ── WHY A RUN BUTTON, WHEN THE FUNCTION IS DELIBERATELY UNSCHEDULED ───────
 * documents_attribution_report is a hand-run decision instrument and should
 * stay one — but S3.2's whole job is to make the stale-intake-folder condition
 * VISIBLE, and a diagnostics block that can only ever say "no report has been
 * run" makes it visible to nobody. Something has to be able to produce the
 * first run.
 *
 * The 3-minute default bound describes a worst case, not this workload:
 * measured against production on 2026-08-27 the head query is 77ms over 986
 * cached folders and the paged scan is ~16 pages at ~110-300ms, so a full run
 * is a few seconds. It is read-only — no links, no cache rows, no events — and
 * gated on the same kill switch as everything else here. The bound is tightened
 * below anyway, because "measured at 3 seconds" is not a licence to let an HTTP
 * request hang for three minutes when the estate grows.
 *
 * Deliberately NOT wired to a schedule by this slice: a whole-table scan on a
 * timer needs a reason, and "the panel would look fresher" is not one.
 */
router.post('/api/documents/sync-diagnostics', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');

    if (!await sync.isSyncEnabled(req.db)) {
      return res.json({
        status: 'success',
        report: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
      });
    }

    const report = await sync.attributionReport(req.db, {
      maxRuntimeMs: DIAGNOSTIC_RUN_MAX_MS,
    });
    res.json({ status: 'success', report, ran_at: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GUIDED RE-LINK (S3.3)
//
// ⚠️ DECLARED BEFORE THE ':id' ROUTES for the same reason sync-roots is: Express
// matches in declaration order, and `POST /api/documents/relink` is two
// segments. There is no POST '/api/documents/:id' today; if one is ever added
// it must go below this block or it will swallow it.
//
// ── THE ONE RULE, RESTATED AT THE BOUNDARY ────────────────────────────────
// No link changes without a human confirming the specific pairing. Two things
// follow for this file specifically:
//
//   · THERE IS NO BULK RE-LINK VERB. Not "confirm all high-confidence", not
//     "apply every docket match". The docket lane is the strong one and it
//     still only covers 4 of 418 cases; a bulk verb would exist to save eight
//     clicks and would be the single most dangerous button in the app.
//   · THE UI'S GREY-OUT IS NOT THE GUARD. POST /relink re-runs the exclusion
//     server-side (documentSyncService.applyRelink step 1) and 409s. A stale
//     panel, a replayed request and a hand-rolled curl all hit the same check.
//
// Dismissal is the exception that proves it: setRelinkDismissed accepts an
// array because it changes no link at all — see its docblock.
//
// This file still does no SQL.
// ═════════════════════════════════════════════════════════════════════════════

/** cases.case_id is VARCHAR(20); production is uniformly 8 URL-safe chars. */
function relinkCaseId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^[A-Za-z0-9_-]{1,20}$/.test(s) ? s : null;
}

/**
 * GET /api/documents/relink/queue
 *   ?include_weak=1        surname-only suggestions (off by default — see below)
 *   ?include_dismissed=1   show rows already dismissed
 *
 * ── WHY THE QUEUE IS NOT READ OUT OF THE ATTRIBUTION REPORT ───────────────
 * It cannot be. That report's `sample` lists only cases carrying RESIDUE, and
 * residue for this population is exactly zero — all 418 intake folders are
 * empty in Dropbox. So the report knows the COUNT and names none of the cases.
 * relinkQueue runs the report's own cheap head query (77ms over 986 cached
 * folders, driven by idx_dl_target) and returns the ids with their candidates.
 *
 * ── WHY WEAK MATCHES ARE OPT-IN ───────────────────────────────────────────
 * Surname-only matching produces a suggestion for most of the queue and is
 * wrong nearly every time — measured, with the wrong-client examples recorded
 * in documentSyncService's re-link section header. It is reachable because the
 * pre-template legacy trees hold hand-made folders a conjunctive rule cannot
 * find; it is off by default because a plausible wrong answer next to a
 * confirm button is worse than no answer.
 *
 * READ-ONLY. Writes nothing, resolves nothing, calls no provider.
 */
router.get('/api/documents/relink/queue', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const out = await sync.relinkQueue(req.db, {
      includeWeak:      req.query.include_weak === '1',
      includeDismissed: req.query.include_dismissed === '1',
    });
    res.json({ status: 'success', ...out });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/documents/relink/:caseId/candidates
 *
 * One case. What the panel calls after an action to repaint a single row
 * without re-ranking the whole queue.
 */
router.get('/api/documents/relink/:caseId/candidates', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const caseId = relinkCaseId(req.params.caseId);
    if (!caseId) {
      return res.status(400).json({ status: 'error', message: 'Invalid case id' });
    }
    const out = await sync.relinkCandidates(req.db, caseId, {
      includeWeak: req.query.include_weak === '1',
    });
    if (!out) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json({ status: 'success', ...out });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/relink — { case_id, folder_path }
 *
 * THE CONFIRM. A person has looked at a specific folder next to a specific
 * case and said yes. Everything this does is in
 * documentSyncService.applyRelink; the ordering constraints are documented
 * there and they are not rearrangeable.
 *
 * Gated on the kill switch like every other mutating action on this surface,
 * and for the same reason: `documents_sync_enabled` means "this engine does
 * not run", and a second control surface that ignored it would be exactly the
 * split-brain lib/internal_functions/documents.js refused to create. Reported
 * as `skipped` rather than an error — nothing went wrong — and the panel
 * branches on it explicitly so a skip can never paint as a success.
 *
 * 409 means the folder already belongs to another case. That is the guard, and
 * it is re-run here rather than trusted from the UI.
 */
router.post('/api/documents/relink', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const { case_id, folder_path } = req.body || {};

    const caseId = relinkCaseId(case_id);
    if (!caseId) {
      return res.status(400).json({ status: 'error', message: 'case_id is required' });
    }
    if (!folder_path) {
      return res.status(400).json({ status: 'error', message: 'folder_path is required' });
    }

    if (!await sync.isSyncEnabled(req.db)) {
      return res.json({
        status: 'success',
        result: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
      });
    }

    const result = await sync.applyRelink(req.db, caseId, folder_path, {
      actorUserId: actingUserId(req),
    });
    res.json({ status: 'success', result });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/documents/relink/dismiss — { case_id } | { case_ids: [...] }
 *                                      + { undo: true } to un-dismiss
 *
 * ── WHY THIS ONE TAKES AN ARRAY WHEN /relink DELIBERATELY DOES NOT ────────
 * Dismissal stamps two columns on case_folder_cache. It changes no
 * document_link, no cases row, and touches no provider — it says "I looked at
 * this and there is nothing to do", which is a note about the QUEUE, not an
 * assertion about a document. The ONE RULE governs link changes; this is not
 * one, so the bulk form carries none of the risk the bulk re-link would.
 *
 * And the queue's real shape makes it necessary rather than merely convenient:
 * roughly 394 of the 418 have no candidate anywhere in the estate because the
 * client never sent a document. Making each of those an individual click would
 * guarantee the queue is never cleared, and a queue nobody clears is a queue
 * nobody reads.
 *
 * `undo` exists because a dismissal is a judgement and judgements are revised.
 */
router.post('/api/documents/relink/dismiss', jwtOrApiKey, async (req, res) => {
  try {
    const sync = require('../services/documentSyncService');
    const body = req.body || {};

    const raw = Array.isArray(body.case_ids)
      ? body.case_ids
      : (body.case_id != null ? [body.case_id] : []);

    const ids = raw.map(relinkCaseId).filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({
        status: 'error', message: 'case_id or case_ids is required',
      });
    }
    if (ids.length !== raw.length) {
      return res.status(400).json({
        status: 'error', message: 'one or more case ids are malformed',
      });
    }

    const out = await sync.setRelinkDismissed(req.db, ids, {
      dismissed: !body.undo,
      actorUserId: actingUserId(req),
    });
    res.json({ status: 'success', ...out });
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
      ext:       req.query.ext,             // 'pdf' or a CSV; junk tokens dropped
      tag:       req.query.tag,
      status:    req.query.status,          // omit → 'active'; 'all' disables
      source:    req.query.source,
      link_type: req.query.link_type,
      link_id:   req.query.link_id,
      // Truthy → expand the scope ONE HOP through case_relate. Ignored without
      // link_type + link_id; the service owns that rule and the '0'/'false'
      // normalisation, because a query string has no booleans and every caller
      // would otherwise invent its own.
      related:   req.query.related,
      // 'case' → the triage view: documents with NO case link at all. Ignored
      // when a scope is present (contradictory) and when the value is not a
      // known kind — both rules live in the service beside the predicate they
      // guard, so this stays a passthrough like every other facet here.
      unlinked:  req.query.unlinked,
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
// The only place a permanent public link is minted FOR A DOCUMENT. Get-or-create
// at the provider, then cache it on the row so a second call is a no-op too.
//
// The one other sanctioned minting site is the S3.3 re-link confirm, and the
// distinction is the object, not the permission: this mints a link to a FILE
// and stores it on documents.shared_link; that one mints a link to a FOLDER and
// stores it on cases.case_dropbox, mirroring exactly what intake minted when
// the case was created. Neither is a general-purpose link factory.
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
