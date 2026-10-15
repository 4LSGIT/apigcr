// routes/api.commsArchive.js
//
/**
 * Comms archive admin API — ref/COMMS_ARCHIVE_DESIGN.md §8 (restrict / purge),
 * §7 P9 (audit), §0 R9 (who). S1b: driven from the console (apiSend); the UI
 * comes with S4.
 *
 *   POST /api/comms-archive/media/:id/restrict    {reason}            → restricted = 1
 *   POST /api/comms-archive/media/:id/unrestrict  {reason}            → restricted = 0
 *   POST /api/comms-archive/media/:id/purge       {reason, confirm, password}
 *                                                                     → irreversible (§8);
 *                                                                       confirm must equal :id
 *
 * S4 — content + health (design §7, §10):
 *   GET  /api/comms-archive/media/:id/url         → {url, mime, inline, expires_in}
 *        a V4 signed URL (5 min) on storage.googleapis.com, minted only after
 *        commsArchiveAdmin.canReadMedia (restricted → archive admins; no line
 *        → SU / attorney bypass; else the line's can_read). Kinds:
 *        call_recording / voicemail (audited 'listen') and mms_file
 *        ('open_mms'); ?renew=1 marks a re-mint after the URL expired
 *        mid-playback. Per user ≤ MINT_PER_WINDOW per 10 min (429, audited).
 *   GET  /api/comms-archive/media/:id/transcript  → {source, label, segments, text}
 *        comms_transcripts (S2) when present; for a voicemail, else the phone
 *        provider's own transcript (stt_raw, read server-side). Audited
 *        'view_transcript'. Rendered by the pane with textContent only.
 *   POST /api/comms-archive/search {q, line_id, cursor, limit} → S6: the transcripts the caller may read,
 *        newest first, one snippet each (services/commsArchiveSearch.js);
 *        audited 'search' with counts + media ids, NEVER the query text;
 *        per user ≤ SEARCH_PER_WINDOW per 10 min (429).
 *   POST /api/comms-archive/media/:id/resummarize {model?, note?} → S3c: any
 *        staff user who may READ the call asks for its summary to be made again
 *        (or for the first time) — model default claude-sonnet-5-5, an optional
 *        note ≤ 500 characters (untrusted input to the model). canReadMedia
 *        (else the same 404); restricted / not_transcribed / empty / busy /
 *        summaries_off / settings / over_cap → 409 {code}; ≤ RESUMMARIZE_PER_HOUR
 *        per user (429). Audited 'resummarize': the model and the note's LENGTH,
 *        never its text. services/commsArchiveResummarize.js.
 *   GET  /api/comms-archive/health                → SU status read (F4) —
 *        superuserOnlyFor('comms_archive_health'): SU + step-up.
 *
 * S2c-2 — redo (design §8):
 *   POST /api/comms-archive/redo {mode, select, limit?, apply?} → send stored
 *        transcripts (or only their summaries) back to be made again
 *        (services/commsArchiveRedo.js). A DRY RUN unless apply: true — counts,
 *        groups, the cost estimate against the monthly cap's headroom, the
 *        media ids. superuserOnlyFor('comms_archive_redo') (SU + step-up) and a
 *        staff JWT only; applies ≤ REDO_APPLY_PER_HOUR per user (429). Every
 *        call audited ('redo_transcript' / 'redo_summary': the selector, counts,
 *        ids — never content).
 * The do-not-transcribe list (design §0 R9, P6; services/commsNoTranscribe.js):
 *   GET    /api/comms-archive/no-transcribe       → {entries:[{id, phone, note, created_by, created_by_name, created_at}]}
 *   POST   /api/comms-archive/no-transcribe       {phone, note?, requested_by?} → {entry}
 *          phone: non-digits stripped, 10 digits or 1 + 10 (else 400); already
 *          listed → 409; note ≤ 255 (trimmed, optional); requested_by = an
 *          active staff user (400 otherwise), default the caller.
 *   DELETE /api/comms-archive/no-transcribe/:id   → {entry} (the removed row); unknown id → 404
 *   Same WHO as restrict (staff JWT + isArchiveAdmin, else 403); every outcome
 *   audited — actions no_transcribe_{list|add|remove}: the phone, ids and the
 *   note's LENGTH, never its text. Not a sync-bus entity (no ycSync matcher):
 *   the one page that shows the list repaints from the response.
 *
 *   EVERY content denial is the same 404 as a missing item (no existence
 *   oracle — §7 "omitted, not locked"); the audit row carries the real reason.
 *
 * PASSWORD (purge, Fred's ruling S4): the caller's own password, re-checked
 * by commsArchiveAdmin.verifyOwnPassword (SU and listed admins alike). Wrong
 * → 403 code 'bad_password' — NOT 401, which the shell's apiSend reads as an
 * expired session and answers with a re-login. Failures are counted per user
 * (FAILED_PW_MAX per 15 min → 429), each attempt RESERVED before bcrypt runs
 * so a parallel burst gets at most FAILED_PW_MAX guesses (per instance); the
 * password never enters an audit row.
 *
 * WHO: a staff JWT whose user passes services/commsArchiveAdmin.isArchiveAdmin
 * (SU, or listed in app_settings comms_archive_admins). An API key is refused
 * even if it maps to a listed user — these are named-human acts.
 *
 * AUDIT (P9): every attempt that reaches this router, rejects included,
 * writes an admin_audit_log row — tool 'comms_archive', details { action,
 * media_id, reason? } (the table has no action column; route / method / user
 * via reqMeta; never any content). A request with no valid credential is
 * 401'd by jwtOrApiKey before it gets here (that middleware logs its own
 * attempt in jwt_api_audit_log). A PURGE writes an 'attempt' row BEFORE the
 * destructive step and its outcome after; if the attempt row cannot be
 * written the purge is refused (503) — nothing is purged unaudited.
 *
 * RATE: purges are limited per user (PURGE_PER_HOUR, the lib/rateLimiter
 * pattern, per instance) — over the limit is a 429, audited.
 *
 * comms_media is not a sync-bus entity (no ycSync matcher): nothing renders it
 * live until S4.
 *
 * Auto-mounted (server.js readdirSync); req.db injected.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction, superuserOnlyFor } = require('../lib/auth.superuser');
const { makeLimiter } = require('../lib/rateLimiter');
const admin = require('../services/commsArchiveAdmin');
const archive = require('../services/commsArchiveService');
const { VENDOR_SQL, READABLE_STATES } = require('../services/commsArchiveView');
const searchSvc = require('../services/commsArchiveSearch');
const redoSvc = require('../services/commsArchiveRedo');
const resummarizeSvc = require('../services/commsArchiveResummarize');
const noTxSvc = require('../services/commsNoTranscribe');

const TOOL = 'comms_archive';
const MAX_REASON = 500;
const HOUR_MS = 60 * 60 * 1000;
const PURGE_PER_HOUR = 20;
let purgeLimited = makeLimiter(HOUR_MS, PURGE_PER_HOUR);
const MINT_WINDOW_MS = 10 * 60 * 1000;
const MINT_PER_WINDOW = 120;
let mintLimited = makeLimiter(MINT_WINDOW_MS, MINT_PER_WINDOW);
const SEARCH_WINDOW_MS = 10 * 60 * 1000;
const SEARCH_PER_WINDOW = 60;
let searchLimited = makeLimiter(SEARCH_WINDOW_MS, SEARCH_PER_WINDOW);
const RESUMMARIZE_PER_HOUR = 10;
let resummarizeLimited = makeLimiter(HOUR_MS, RESUMMARIZE_PER_HOUR);
const REDO_APPLY_PER_HOUR = 30;
let redoLimited = makeLimiter(HOUR_MS, REDO_APPLY_PER_HOUR);
const FAILED_PW_WINDOW_MS = 15 * 60 * 1000;
const FAILED_PW_MAX = 5;
let failedPw = new Map();   // user id → [{at}] failures + checks in flight (per instance, like every lib/rateLimiter consumer)

/**
 * Check AND reserve one password attempt, synchronously — no await between
 * the count and the reservation, so a burst of parallel requests cannot all
 * pass the check before any failure is counted (review F1: 30 parallel wrong
 * passwords used to buy 13 bcrypt guesses). The reservation counts as a
 * failure until the check says otherwise; release() drops it (right password,
 * or no password hash — not a guess). → reservation | null (locked)
 */
function pwReserve(uid) {
  const cut = Date.now() - FAILED_PW_WINDOW_MS;
  const hits = (failedPw.get(uid) || []).filter(h => h.at > cut);
  failedPw.set(uid, hits);
  if (hits.length >= FAILED_PW_MAX) return null;
  const r = { at: Date.now() };
  hits.push(r);
  return { release() { const a = failedPw.get(uid) || []; const i = a.indexOf(r); if (i >= 0) a.splice(i, 1); } };
}

const R8_LABEL = 'AI-generated — check the recording before relying on it';
const PROVIDER_LABEL = "The phone provider's automatic transcript (machine-generated) — check the recording before relying on it";

function reqMeta(req, tool) {
  return {
    tool,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

async function audit(req, status, details, errorMessage = null) {
  try {
    const meta = reqMeta(req, TOOL);
    // A search's words never reach the audit row — not even inside the route.
    if (details && details.action === 'search') meta.route = String(meta.route || '').split('?')[0];
    await auditAdminAction(req.db, { ...meta, status, details, errorMessage });
  } catch (err) {
    console.error('[commsArchive] audit log failed:', err.message);
  }
}

function handler(action) {
  return async (req, res) => {
    const idRaw = String(req.params.id || '');
    const id = /^\d{1,19}$/.test(idRaw) ? Number(idRaw) : null;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const details = { action, media_id: id ?? idRaw.slice(0, 32) };

    if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
      await audit(req, 'rejected_not_jwt', details);
      return res.status(403).json({ status: 'error', message: 'Archive admin actions require a signed-in user' });
    }
    let ok = false;
    try { ok = await admin.isArchiveAdmin(req.db, req.auth); } catch (err) {
      console.error('[commsArchive] isArchiveAdmin error:', err.code || '', err.message);
      await audit(req, 'error', details, 'admin check failed');
      return res.status(500).json({ status: 'error', message: 'Archive request failed' });
    }
    if (!ok) {
      await audit(req, 'rejected_not_admin', details);
      return res.status(403).json({ status: 'error', message: 'Archive admins only' });
    }
    if (id == null) {
      await audit(req, 'rejected_bad_request', details, 'bad id');
      return res.status(400).json({ status: 'error', message: 'Bad archive item id' });
    }
    if (!reason || reason.length > MAX_REASON) {
      await audit(req, 'rejected_bad_request', details, 'reason required (1–500 chars)');
      return res.status(400).json({ status: 'error', message: `A reason is required (1–${MAX_REASON} characters)` });
    }
    details.reason = reason;
    if (action === 'purge' && String(req.body?.confirm ?? '') !== String(id)) {
      await audit(req, 'rejected_bad_request', details, 'confirm must equal the id');
      return res.status(400).json({ status: 'error', message: 'Purge is irreversible: send confirm equal to the item id' });
    }
    if (action === 'purge') {
      const uid = Number(req.auth.userId);
      const slot = pwReserve(uid);
      if (!slot) {
        await audit(req, 'rejected_rate_limited', details, 'password failures');
        return res.status(429).json({ status: 'error', message: 'Too many wrong passwords — wait 15 minutes' });
      }
      let pw;
      try { pw = await admin.verifyOwnPassword(req.db, req.auth, req.body?.password); } catch (err) {
        console.error('[commsArchive] password check error:', err.code || '', err.message);
        await audit(req, 'error', details, 'password check failed');
        return res.status(500).json({ status: 'error', message: 'Archive request failed' });
      }
      if (pw === 'no_password') {
        slot.release();
        await audit(req, 'rejected_no_password', details);
        return res.status(403).json({ status: 'error', code: 'no_password', message: 'Your account has no password to confirm with — set one first' });
      }
      if (pw !== 'ok') {
        await audit(req, 'rejected_bad_password', details);
        return res.status(403).json({ status: 'error', code: 'bad_password', message: 'Incorrect password' });
      }
      slot.release();
      if (purgeLimited(`u${req.auth.userId}`)) {
        await audit(req, 'rejected_rate_limited', details);
        return res.status(429).json({ status: 'error', message: `At most ${PURGE_PER_HOUR} purges per hour` });
      }
      // The attempt is on record BEFORE anything is destroyed, or nothing is.
      try {
        await auditAdminAction(req.db, { ...reqMeta(req, TOOL), status: 'attempt', details });
      } catch (err) {
        console.error('[commsArchive] purge attempt audit failed — refusing:', err.message);
        return res.status(503).json({ status: 'error', message: 'Audit unavailable — purge refused; retry' });
      }
    }

    try {
      const media = action === 'purge'
        ? await admin.purge(req.db, id, { userId: Number(req.auth.userId), reason })
        : await admin.setRestricted(req.db, id, action === 'restrict');
      await audit(req, 'success', { ...details, ...(media.parts ? { parts: media.parts } : {}) });
      return res.json({ status: 'success', media: { id: media.id, state: media.state, restricted: media.restricted } });
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      if (status >= 500) console.error(`[commsArchive] ${action} error:`, err.message, err.cause ? err.cause.message : '');
      await audit(req, status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'failed', details,
        (err.cause ? `${err.message} (${err.cause.message})` : err.message || '').slice(0, 1000));
      return res.status(status).json({ status: 'error', message: err.expose ? err.message : 'Archive request failed' });
    }
  };
}

router.post('/api/comms-archive/media/:id/restrict', jwtOrApiKey, handler('restrict'));
router.post('/api/comms-archive/media/:id/unrestrict', jwtOrApiKey, handler('unrestrict'));
router.post('/api/comms-archive/media/:id/purge', jwtOrApiKey, handler('purge'));

// ─────────────────────────────────────────────────────────────
// S4 — content (design §7) and health (§10, F4)
// ─────────────────────────────────────────────────────────────

/** Kinds whose bytes a viewer may open, → the audit action (P9). stt_raw is never served as bytes. */
const CONTENT_ACTION = Object.freeze({ call_recording: 'listen', voicemail: 'listen', mms_file: 'open_mms' });
const NOT_FOUND = Object.freeze({ status: 'error', message: 'Archive item not found' });
const MAX_SEGMENTS = 20000;

async function loadMedia(db, id) {
  const [[row]] = await db.query(
    `SELECT id, kind, source_table, source_id, provider, channel_id, restricted, state, object_name, mime
       FROM comms_media WHERE id = ?`, [id]);
  return row || null;
}

/**
 * The shared front half of a content read: staff JWT, id, rate, the item,
 * its kind, the grant (canReadMedia), archived. Sends the 4xx/5xx (audited)
 * and returns null, or returns the row. Every denial is the SAME 404 as a
 * missing item; the audit row carries the real reason.
 */
async function contentGate(req, res, { action, kinds }) {
  const idRaw = String(req.params.id || '');
  const id = /^\d{1,19}$/.test(idRaw) ? Number(idRaw) : null;
  const details = { action, media_id: id ?? idRaw.slice(0, 32) };
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    await audit(req, 'rejected_not_jwt', details);
    res.status(403).json({ status: 'error', message: 'Archive content requires a signed-in user' });
    return null;
  }
  if (id == null) {
    await audit(req, 'rejected_bad_request', details, 'bad id');
    res.status(400).json({ status: 'error', message: 'Bad archive item id' });
    return null;
  }
  if (mintLimited(`u${req.auth.userId}`)) {
    await audit(req, 'rejected_rate_limited', details);
    res.status(429).json({ status: 'error', message: 'Too many archive requests — wait a few minutes' });
    return null;
  }
  try {
    const row = await loadMedia(req.db, id);
    if (row && action === 'listen' && CONTENT_ACTION[row.kind]) details.action = CONTENT_ACTION[row.kind];
    if (!row || !kinds.includes(row.kind)) {
      await audit(req, 'not_found', details, row ? `kind ${row.kind}` : null);
      res.status(404).json(NOT_FOUND);
      return null;
    }
    const grant = await admin.canReadMedia(req.db, req.auth, row);
    if (!grant.ok) {
      await audit(req, `rejected_${grant.why}`, details);
      res.status(404).json(NOT_FOUND);
      return null;
    }
    if (row.state !== 'archived' || !row.object_name) {
      await audit(req, 'not_found', details, `state ${row.state}`);
      res.status(404).json(NOT_FOUND);
      return null;
    }
    return { row, details };
  } catch (err) {
    console.error(`[commsArchive] ${action} gate error:`, err.code || '', err.message);
    await audit(req, 'error', details, 'grant check failed');
    res.status(500).json({ status: 'error', message: 'Archive request failed' });
    return null;
  }
}

// ─── GET /api/comms-archive/media/:id/url ───
router.get('/api/comms-archive/media/:id/url', jwtOrApiKey, async (req, res) => {
  const g = await contentGate(req, res, { action: 'listen', kinds: Object.keys(CONTENT_ACTION) });
  if (!g) return;
  const { row, details } = g;
  if (String(req.query?.renew || '') === '1') details.renew = true;
  try {
    const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(row.object_name) || [])[1] || 'bin';
    const mime = row.mime || 'application/octet-stream';
    const url = await archive.signedUrl(row.object_name, { mime, filename: `${row.kind}-${row.id}.${ext}` });
    await audit(req, 'success', details);
    return res.json({
      status: 'success',
      url,
      mime,
      inline: archive.INLINE_TYPES.has(archive.baseMime(mime)),       // the same normalisation signedUrl uses
      expires_in: Math.round(archive.SIGNED_URL_TTL_MS / 1000),
    });
  } catch (err) {
    console.error('[commsArchive] sign error:', err.message);
    await audit(req, 'failed', details, String(err.message || '').slice(0, 1000));
    return res.status(502).json({ status: 'error', message: 'Could not open the archive item — retry' });
  }
});

/** comms_transcripts segments → [{s, a, b, t}] (strings / numbers only, bounded). */
function shapeSegments(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_SEGMENTS).filter(x => x && typeof x === 'object').map(x => ({
    s: x.s == null ? null : String(x.s).slice(0, 20),
    a: Number.isFinite(Number(x.a)) ? Number(x.a) : null,
    b: Number.isFinite(Number(x.b)) ? Number(x.b) : null,
    t: x.t == null ? '' : String(x.t),
  }));
}

// ─── GET /api/comms-archive/media/:id/transcript ───
router.get('/api/comms-archive/media/:id/transcript', jwtOrApiKey, async (req, res) => {
  const g = await contentGate(req, res, { action: 'view_transcript', kinds: ['call_recording', 'voicemail'] });
  if (!g) return;
  const { row, details } = g;
  try {
    // S2's transcript. Restriction is read from comms_media (the single
    // source of truth — comms_transcripts has no restricted column): the
    // JOIN re-asserts the row the grant just passed, so a transcript can
    // never be read past its media row's state.
    let t = null;
    try {
      const [[r]] = await req.db.query(
        `SELECT t.segments, t.full_text, t.stt_vendor
           FROM comms_transcripts t
           JOIN comms_media m ON m.id = t.media_id AND m.state = 'archived' AND m.restricted = ?
          WHERE t.media_id = ? AND t.state IN (?)
            AND (t.segments IS NOT NULL OR t.full_text IS NOT NULL)
          LIMIT 1`, [Number(row.restricted) === 1 ? 1 : 0, row.id, READABLE_STATES]);
      t = r || null;
    } catch (err) {
      if (!err || err.code !== 'ER_NO_SUCH_TABLE') throw err;   // S2 not migrated yet
    }
    if (t) {
      const out = { status: 'success', media_id: row.id, source: t.stt_vendor ? String(t.stt_vendor) : 'stt', label: R8_LABEL,
        segments: shapeSegments(t.segments), text: t.full_text == null ? '' : String(t.full_text) };
      await audit(req, 'success', { ...details, source: out.source });
      return res.json(out);
    }
    // A voicemail's secondary record: the phone provider's own transcript.
    if (row.kind === 'voicemail') {
      const [[c]] = await req.db.query(
        `SELECT id, object_name, restricted FROM comms_media
          WHERE source_table = 'comms_media' AND source_id = ? AND kind = 'stt_raw' AND state = 'archived'
            AND ${VENDOR_SQL}
          ORDER BY id LIMIT 1`, [row.id]);
      if (c && (Number(c.restricted) !== 1 || (await admin.isArchiveAdmin(req.db, req.auth)))) {
        let doc = null;
        try { doc = JSON.parse(await archive.readText(c.object_name, { maxBytes: 1_000_000 })); } catch (err) {
          if (err && err.ourSide) throw err;
          doc = null;                                               // unreadable JSON → treated as none
        }
        if (doc && typeof doc.transcript === 'string' && doc.transcript.trim()) {
          await audit(req, 'success', { ...details, source: 'provider' });
          return res.json({ status: 'success', media_id: row.id, source: 'provider',
            vendor: typeof doc.vendor === 'string' ? doc.vendor : null, label: PROVIDER_LABEL, segments: [], text: doc.transcript });
        }
      }
    }
    await audit(req, 'not_found', details, 'no transcript');
    return res.status(404).json({ status: 'error', message: 'No transcript for this item yet' });
  } catch (err) {
    console.error('[commsArchive] transcript error:', err.code || '', err.message);
    await audit(req, 'failed', details, String(err.message || '').slice(0, 1000));
    return res.status(502).json({ status: 'error', message: 'Could not load the transcript — retry' });
  }
});

/** Sweep jobs the health read reports (S2 / S3 keys listed ahead of their slices; absent rows are skipped). */
const HEALTH_JOBS = ['comms_archive_sweep', 'comms_archive_media_sweep', 'comms_archive_verify',
  'comms_transcribe_sweep', 'comms_summarize_sweep'];

/** A query on an S2/S3 table that may not exist yet → null instead of a 500. */
async function maybeTable(fn) {
  try { return await fn(); } catch (err) { if (err && err.code === 'ER_NO_SUCH_TABLE') return null; throw err; }
}

// ─── POST /api/comms-archive/media/:id/resummarize ─── S3c (design §6.4). Staff JWT + canReadMedia (contentGate).
router.post('/api/comms-archive/media/:id/resummarize', jwtOrApiKey, async (req, res) => {
  const g = await contentGate(req, res, { action: 'resummarize', kinds: ['call_recording', 'voicemail'] });
  if (!g) return;
  const { row, details } = g;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  details.model = typeof body.model === 'string' ? body.model.slice(0, 48) : resummarizeSvc.DEFAULT_MODEL;
  details.note_len = typeof body.note === 'string' ? body.note.trim().length : 0;   // the LENGTH — never the note
  if (resummarizeLimited(`u${req.auth.userId}`)) {
    await audit(req, 'rejected_rate_limited', details);
    return res.status(429).json({ status: 'error', message: `At most ${RESUMMARIZE_PER_HOUR} re-summarise requests per hour` });
  }
  try {
    const r = await resummarizeSvc.resummarize(req.db, row, { userId: Number(req.auth.userId), body });
    await audit(req, 'success', { ...details, model: r.model });
    return res.json({ status: 'success', ...r });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 500;
    if (status === 400 || status === 409) {
      const code = status === 400 ? 'bad_request' : err.code;
      await audit(req, `rejected_${code}`, details);
      return res.status(status).json({ status: 'error', code, message: err.message });
    }
    console.error('[commsArchive] resummarize error:', err.code || '', err.message);
    await audit(req, 'failed', details, String(err.message || '').slice(0, 300));
    return res.status(500).json({ status: 'error', message: 'Re-summarise failed' });
  }
});

// ─── POST /api/comms-archive/redo ─── S2c-2 (design §8). SU + step-up (superuserOnlyFor), staff JWT only.
router.post('/api/comms-archive/redo', ...superuserOnlyFor('comms_archive_redo'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const details = { action: body.mode === 'summary' ? 'redo_summary' : 'redo_transcript', apply: body.apply === true };
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {   // isSuperuser already demands it; named-human act
    await audit(req, 'rejected_not_jwt', details);
    return res.status(403).json({ status: 'error', message: 'Redo requires a signed-in user' });
  }
  if (details.apply && redoLimited(`u${req.auth.userId}`)) {
    await audit(req, 'rejected_rate_limited', details);
    return res.status(429).json({ status: 'error', message: `At most ${REDO_APPLY_PER_HOUR} redo applies per hour` });
  }
  try {
    const r = await redoSvc.redo(req.db, body, { userId: Number(req.auth.userId) });
    await audit(req, r.outcome === 'refused' ? 'refused' : 'success', {
      ...details, outcome: r.outcome, select: r.select, eligible: r.eligible, batch: r.batch, skipped: r.skipped,
      ...(r.outcome === 'applied' ? { applied: r.applied, changed_since_selection: r.changed_since_selection } : {}),
      ...(r.refusal ? { refusal: r.refusal.code } : {}),
      est_cents: r.estimate.batch.total_cents, media_ids: r.media_ids,
    });
    if (r.outcome === 'refused') return res.status(409).json({ status: 'error', code: r.refusal.code, message: r.refusal.message, ...r });
    return res.json({ status: 'success', ...r });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 500;
    if (status >= 500) console.error('[commsArchive] redo error:', err.message);
    await audit(req, status === 400 ? 'rejected_bad_request' : 'failed', details, String(err.message || '').slice(0, 300));
    return res.status(status).json({ status: 'error', message: err.expose ? err.message : 'Redo failed' });
  }
});

// ─── GET /api/comms-archive/health ─── SU status read (F4). Counts, never content.
router.get('/api/comms-archive/health', ...superuserOnlyFor('comms_archive_health'), async (req, res) => {
  try {
    const db = req.db;
    const [counts] = await db.query(
      `SELECT kind, provider, state, COUNT(*) AS n, SUM(restricted) AS restricted
         FROM comms_media GROUP BY kind, provider, state ORDER BY kind, provider, state`);
    const [pending] = await db.query(
      `SELECT kind, provider, COUNT(*) AS n, MIN(captured_at) AS oldest_captured, MIN(created_at) AS oldest_created
         FROM comms_media WHERE state = 'pending' GROUP BY kind, provider ORDER BY kind, provider`);
    const [errors] = await db.query(
      `SELECT kind, provider, LEFT(last_error, 80) AS error, COUNT(*) AS n
         FROM comms_media WHERE state = 'pending' AND last_error IS NOT NULL
        GROUP BY kind, provider, LEFT(last_error, 80) ORDER BY n DESC LIMIT 12`);
    const [jobRows] = await db.query(
      `SELECT id, idempotency_key, name, recurrence_rule, active, status, scheduled_time
         FROM scheduled_jobs WHERE idempotency_key IN (?) ORDER BY id`, [HEALTH_JOBS]);
    const jobs = [];
    for (const j of jobRows) {
      const [[last]] = await db.query(
        `SELECT status, executed_at, duration_ms, output_data, LEFT(error_message, 300) AS error_message
           FROM job_results WHERE job_id = ? ORDER BY id DESC LIMIT 1`, [j.id]);
      let output = last ? last.output_data : null;
      if (typeof output === 'string') { try { output = JSON.parse(output); } catch (_) { /* keep text */ } }
      const outText = output == null ? null : JSON.stringify(output);
      jobs.push({
        key: j.idempotency_key, name: j.name, recurrence: j.recurrence_rule, active: !!Number(j.active),
        status: j.status, next_run: j.scheduled_time,
        last: last ? { status: last.status, at: last.executed_at, duration_ms: last.duration_ms,
          output: outText && outText.length > 4000 ? `${outText.slice(0, 4000)}…` : output,
          error: last.error_message || null } : null,
      });
    }
    const [alerts] = await db.query(
      `SELECT id, severity, group_key, title, created_at, acked_at
         FROM system_alerts WHERE group_key LIKE 'comms\\_archive%' AND resolved_at IS NULL
        ORDER BY id DESC LIMIT 25`);
    const transcripts = await maybeTable(async () => {
      const [rows] = await db.query('SELECT state, COUNT(*) AS n FROM comms_transcripts GROUP BY state ORDER BY state');
      const [skips] = await db.query(
        `SELECT skip_reason, COUNT(*) AS n FROM comms_transcripts WHERE state = 'skipped' GROUP BY skip_reason ORDER BY skip_reason`);
      // A redo waits from when it was asked for (S2c-2), not from when its row was first made.
      let old;
      try {
        [[old]] = await db.query(
          `SELECT MIN(COALESCE(rd.requested_at, t.created_at)) AS oldest
             FROM comms_transcripts t LEFT JOIN comms_redo rd ON rd.transcript_id = t.id
            WHERE t.state IN ('pending', 'transcribing')`);
      } catch (err) {
        if (err.code !== 'ER_NO_SUCH_TABLE') throw err;          // before the comms_redo migration
        [[old]] = await db.query(
          `SELECT MIN(created_at) AS oldest FROM comms_transcripts WHERE state IN ('pending', 'transcribing')`);
      }
      return {
        by_state: rows.map(r => ({ state: r.state, n: Number(r.n) })),
        skipped_by_reason: skips.map(r => ({ reason: r.skip_reason, n: Number(r.n) })),
        oldest_pending: old ? old.oldest : null,
      };
    });
    // S2c-2: transcripts being redone (comms_redo markers) by their row's state — pending / transcribing are
    // in progress; failed / skipped are restored by the next tick. null before the comms_redo migration.
    const redo = await maybeTable(async () => {
      const [rows] = await db.query(
        `SELECT t.state, COUNT(*) AS n, MIN(rd.requested_at) AS oldest
           FROM comms_redo rd JOIN comms_transcripts t ON t.id = rd.transcript_id
          GROUP BY t.state ORDER BY t.state`);
      const olds = rows.map(r => r.oldest).filter(Boolean).map(d => new Date(d).getTime());
      return {
        count: rows.reduce((a, r) => a + Number(r.n), 0),
        oldest_requested_at: olds.length ? new Date(Math.min(...olds)).toISOString() : null,
        by_state: rows.map(r => ({ state: r.state, n: Number(r.n) })),
      };
    });
    // Month-to-date spend, the two halves of the shared monthly cap: stt = S2's
    // ledger (every job submitted this month, billed or estimated); llm = S3's
    // summary ai_calls + calls in flight (null with no ai_calls table).
    const cost = await maybeTable(async () => ({
      month_to_date_cents: await require('../services/commsTranscribeSweep').monthToDateParts(db),
    }));
    return res.json({
      status: 'success',
      at: new Date().toISOString(),
      media: counts.map(r => ({ kind: r.kind, provider: r.provider, state: r.state, n: Number(r.n), restricted: Number(r.restricted) || 0 })),
      pending: pending.map(r => ({ kind: r.kind, provider: r.provider, n: Number(r.n), oldest_captured: r.oldest_captured, oldest_created: r.oldest_created })),
      pending_errors: errors.map(r => ({ kind: r.kind, provider: r.provider, error: r.error, n: Number(r.n) })),
      jobs,
      alerts,
      transcripts,
      redo,
      cost,
    });
  } catch (err) {
    console.error('[commsArchive] health error:', err.code || '', err.message);
    return res.status(500).json({ status: 'error', message: 'Archive health read failed' });
  }
});

// ─── POST /api/comms-archive/search {q, line_id, cursor, limit} ─── S6 (design §9 S6)
// The transcripts the caller may read, newest first, one snippet each
// (services/commsArchiveSearch.js). A POST, not a GET, so the words never sit
// in a URL (Cloud Run request logs, Referer). Audited as action 'search' with
// the COUNTS and the media ids returned — never the query text, not even
// hashed: the words can be client data, and admin_audit_log is readable by
// RO-SQL keys (manager ruling Q1). Rejects likewise. jwtOrApiKey's own
// jwt_api_audit_log row redacts `q` at write (access B2), and that table is
// denied to the RO SQL endpoint.
router.post('/api/comms-archive/search', jwtOrApiKey, async (req, res) => {
  const details = { action: 'search' };
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    await audit(req, 'rejected_not_jwt', details);
    return res.status(403).json({ status: 'error', message: 'Archive content requires a signed-in user' });
  }
  if (searchLimited(`u${req.auth.userId}`)) {
    await audit(req, 'rejected_rate_limited', details);
    return res.status(429).json({ status: 'error', message: 'Too many searches — wait a few minutes' });
  }
  const query = req.body && typeof req.body === 'object' ? req.body : {};
  let lineId = null;
  if (query.line_id != null && query.line_id !== '' && query.line_id !== 'all') {
    if (!/^\d{1,9}$/.test(String(query.line_id)) || Number(query.line_id) <= 0) {
      await audit(req, 'rejected_bad_request', details, 'bad line_id');
      return res.status(400).json({ status: 'error', message: "line_id must be a phone line id or 'all'" });
    }
    lineId = Number(query.line_id);
  }
  try {
    const out = await searchSvc.search(req.db, req.auth, {
      q: typeof query.q === 'string' ? query.q : '', lineId, cursor: query.cursor, limit: query.limit,
    });
    await audit(req, 'success', { ...details, terms: out.terms.length, results: out.results.length, media_ids: out.results.map(r => r.media_id) });
    return res.json({ status: 'success', ...out });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 500;
    if (status >= 500) console.error('[commsArchive] search error:', err.code || '', err.message);
    const terms = err && err.tok ? err.tok.terms.length : undefined;
    await audit(req, status === 404 ? 'rejected_no_grant' : status === 400 ? 'rejected_bad_request' : 'failed',
      terms === undefined ? details : { ...details, terms }, status >= 500 ? 'search failed' : String(err.message || '').slice(0, 200));
    const body = { status: 'error', message: status < 500 ? err.message : 'Archive search failed' };
    if (err && err.tok) Object.assign(body, { terms: err.tok.terms, ignored: err.tok.ignored });
    return res.status(status).json(body);
  }
});

// ─── The do-not-transcribe list ─── design §0 R9, P6 (services/commsNoTranscribe.js)
// The restrict handler's WHO: a staff JWT whose user isArchiveAdmin; every outcome audited.

/** Staff JWT + archive admin, or the 403 / 500 is sent (audited) and false returned. */
async function noTxGate(req, res, details) {
  if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
    await audit(req, 'rejected_not_jwt', details);
    res.status(403).json({ status: 'error', message: 'The do-not-transcribe list requires a signed-in user' });
    return false;
  }
  let ok = false;
  try { ok = await admin.isArchiveAdmin(req.db, req.auth); } catch (err) {
    console.error('[commsArchive] isArchiveAdmin error:', err.code || '', err.message);
    await audit(req, 'error', details, 'admin check failed');
    res.status(500).json({ status: 'error', message: 'Archive request failed' });
    return false;
  }
  if (!ok) {
    await audit(req, 'rejected_not_admin', details);
    res.status(403).json({ status: 'error', message: 'Archive admins only' });
    return false;
  }
  return true;
}

/** A service error → its 4xx (audited as rejected / not_found / conflict) or a 500. */
async function noTxFail(req, res, details, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) console.error(`[commsArchive] ${details.action} error:`, err.code || '', err.message);
  await audit(req, status === 400 ? 'rejected_bad_request' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'failed',
    details, status >= 500 ? String(err.message || '').slice(0, 300) : err.message);
  return res.status(status).json({ status: 'error', message: err.expose ? err.message : 'Archive request failed' });
}

router.get('/api/comms-archive/no-transcribe', jwtOrApiKey, async (req, res) => {
  const details = { action: 'no_transcribe_list' };
  if (!(await noTxGate(req, res, details))) return;
  try {
    const entries = await noTxSvc.list(req.db);
    await audit(req, 'success', { ...details, count: entries.length });
    return res.json({ status: 'success', entries });
  } catch (err) { return noTxFail(req, res, details, err); }
});

router.post('/api/comms-archive/no-transcribe', jwtOrApiKey, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reqBy = body.requested_by == null || body.requested_by === '' ? req.auth?.userId : body.requested_by;
  const details = {
    action: 'no_transcribe_add',
    phone: noTxSvc.normalizePhone(body.phone) || String(body.phone ?? '').slice(0, 32),
    requested_by: reqBy == null ? null : String(reqBy).slice(0, 12),
    note_len: typeof body.note === 'string' ? body.note.trim().length : 0,   // the LENGTH — never the note
  };
  if (!(await noTxGate(req, res, details))) return;
  try {
    const entry = await noTxSvc.add(req.db, { phone: body.phone, note: body.note, requestedBy: reqBy });
    await audit(req, 'success', { ...details, id: entry.id });
    return res.json({ status: 'success', entry });
  } catch (err) { return noTxFail(req, res, details, err); }
});

router.delete('/api/comms-archive/no-transcribe/:id', jwtOrApiKey, async (req, res) => {
  const idRaw = String(req.params.id || '');
  const id = /^\d{1,10}$/.test(idRaw) ? Number(idRaw) : null;
  const details = { action: 'no_transcribe_remove', id: id ?? idRaw.slice(0, 32) };
  if (!(await noTxGate(req, res, details))) return;
  if (id == null) {
    await audit(req, 'rejected_bad_request', details, 'bad id');
    return res.status(400).json({ status: 'error', message: 'Bad list entry id' });
  }
  try {
    const entry = await noTxSvc.remove(req.db, id);
    await audit(req, 'success', { ...details, phone: entry.phone });
    return res.json({ status: 'success', entry });
  } catch (err) { return noTxFail(req, res, details, err); }
});

/** Test hook: a fresh purge limiter (optionally with another per-hour max). */
router._resetPurgeLimit = (max = PURGE_PER_HOUR) => { purgeLimited = makeLimiter(HOUR_MS, max); };
/** Test hooks (S4): fresh mint limiter / password-failure counter. */
router._resetMintLimit = (max = MINT_PER_WINDOW) => { mintLimited = makeLimiter(MINT_WINDOW_MS, max); };
router._resetSearchLimit = (max = SEARCH_PER_WINDOW) => { searchLimited = makeLimiter(SEARCH_WINDOW_MS, max); };
router._resetRedoLimit = (max = REDO_APPLY_PER_HOUR) => { redoLimited = makeLimiter(HOUR_MS, max); };
router._resetResummarizeLimit = (max = RESUMMARIZE_PER_HOUR) => { resummarizeLimited = makeLimiter(HOUR_MS, max); };
router._resetPasswordFailures = () => { failedPw = new Map(); };

module.exports = router;
