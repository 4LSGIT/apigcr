// services/commsArchiveAdmin.js
//
/**
 * Comms archive — who may restrict / purge, and the purge itself.
 * ref/COMMS_ARCHIVE_DESIGN.md §0 R9, §8. Routes: routes/api.commsArchive.js.
 *
 * ── isArchiveAdmin (R9 — Fred's ruling 2026-10-14) ─────────────────────────
 * SU always passes (users.roles `su` member, read from the DB through
 * mailboxService.isSuperuser — never from the JWT's claim). Otherwise the
 * caller's users.user id must be listed in app_settings
 * `comms_archive_admins` (CSV of ids; is_editable 0 → SU console only),
 * read UNCACHED on every request, AND the user must still be
 * user_auth = 'authorized' in the DB (checked per request — a deactivated
 * user's still-valid JWT is refused). Parsed strictly: digits only; anything
 * else is ignored and logged. Missing / empty / garbage = SU only
 * (fail-closed). Staff JWTs only — an API key is never an archive admin.
 * Interim: the roles arc replaces the list with a users.roles capability
 * (ref/plans.md); this function is the one place that changes.
 *
 * ── isEvalReviewer / isArchiveSu (S0 evaluation, lane D) ───────────────────
 * Every auth comparison of the comms archive arc lives in THIS file (the
 * access-control arc's agreement). isEvalReviewer is the same gate as
 * isArchiveAdmin over its OWN list, app_settings `comms_eval_reviewers` —
 * who may listen to / read / score the sampled calls of the S0 evaluation
 * (routes/api.commsEval.js). Deliberately not the purge list. isArchiveSu is
 * the bare SU check (staff JWT + DB roles) for the evaluation's SU-only
 * routes (sample, signing check).
 *
 * ── purge (§8) ─────────────────────────────────────────────────────────────
 * Irreversible. Under the row's SWEEP LOCK (so no tick can be mid-row —
 * leased, downloading, uploading — while purge runs): each PURGE_PARTS step
 * in order, then the tombstone. A step failure throws (→ 502) and leaves NO
 * tombstone, so the registry never claims a purge that did not happen; every
 * step is idempotent, so a retry completes it. The tombstone keeps
 * object_name (what was removed) and stamps purged_at / purged_by /
 * purge_reason; `purged` is a state no sweep ever reads, so a purged pending
 * row is never fetched afterwards. S2 appends transcript + stt_raw parts and
 * S3 the ai_calls part to PURGE_PARTS; nothing else changes.
 */

'use strict';

const archive = require('./commsArchiveService');
const common = require('./commsArchiveCommon');

const ADMINS_KEY = 'comms_archive_admins';
const REVIEWERS_KEY = 'comms_eval_reviewers';
/** Knobs (tests shrink them). lockWaitS: how long purge waits for a mid-tick sweep. */
const limits = { lockWaitS: 5 };
const SWEEP_LOCKS = Object.freeze({
  cliff: "CONCAT('comms_archive_sweep:', DATABASE())",
  media: "CONCAT('comms_archive_media:', DATABASE())",
});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

/** Strict CSV of users.user ids. → { ids:Set<number>, junk:string[] } */
function parseAdmins(raw) {
  const ids = new Set();
  const junk = [];
  for (const tok of String(raw == null ? '' : raw).split(',')) {
    const t = tok.trim();
    if (!t) continue;
    if (/^\d+$/.test(t)) ids.add(Number(t));
    else junk.push(t);
  }
  return { ids, junk };
}

/** The caller's users.user id when it is a staff JWT, else null. */
function _jwtUser(auth) {
  if (!auth || auth.type !== 'jwt' || auth.userId == null) return null;
  const uid = Number(auth.userId);
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}

/** SU (from the DB), or listed in app_settings `key` AND still authorized in the DB. */
async function _listGate(db, auth, key) {
  const uid = _jwtUser(auth);
  if (uid == null) return false;
  const mbx = require('./mailboxService'); // lazy require (convention)
  if (await mbx.isSuperuser(db, uid)) return true;
  const { getSetting } = require('./settingsService'); // lazy require (convention)
  const { ids, junk } = parseAdmins(await getSetting(db, key));
  if (junk.length) console.warn(`[comms archive] ${key}: ignored non-id entries ${JSON.stringify(junk.slice(0, 5))}`);
  if (!ids.has(uid)) return false;
  const [[u]] = await db.query('SELECT user_auth FROM users WHERE user = ? LIMIT 1', [uid]);
  return !!u && u.user_auth === 'authorized';
}

/**
 * @param {object} db
 * @param {object} auth  req.auth (lib/auth.jwtOrApiKey)
 * @returns {Promise<boolean>}
 */
async function isArchiveAdmin(db, auth) { return _listGate(db, auth, ADMINS_KEY); }

/** S0 evaluation reviewers (comms_eval_reviewers) — same gate, own list. */
async function isEvalReviewer(db, auth) { return _listGate(db, auth, REVIEWERS_KEY); }

/** SU only (staff JWT; roles read from the DB, never the token's claim). */
async function isArchiveSu(db, auth) {
  const uid = _jwtUser(auth);
  if (uid == null) return false;
  return require('./mailboxService').isSuperuser(db, uid); // lazy require (convention)
}

async function _row(db, id) {
  const [[row]] = await db.query(
    `SELECT id, kind, provider, source_id, part, captured_at, state, restricted, object_name
       FROM comms_media WHERE id = ?`, [id]);
  return row || null;
}

/**
 * Restrict / unrestrict: flips the flag (any state). Reversible. Cascades to
 * the item's derived children (stt_raw rows whose source is this row — a
 * voicemail's vendor transcript), so derived text is never broader than its
 * audio.
 */
async function setRestricted(db, id, on) {
  const row = await _row(db, id);
  if (!row) throw httpError(404, 'Archive item not found');
  await db.query(
    `UPDATE comms_media SET restricted = ?
      WHERE id = ? OR (source_table = 'comms_media' AND source_id = ?)`,
    [on ? 1 : 0, id, id]);
  return { id: row.id, state: row.state, restricted: on ? 1 : 0 };
}

function _laneLock(row) {
  return common.hasCliff(row) ? SWEEP_LOCKS.cliff : SWEEP_LOCKS.media;
}

/** Object names this row may have in the bucket: its recorded one, or (not yet adopted) its prefix's. */
async function _objectsOf(row) {
  if (row.object_name) return [row.object_name];
  if (!row.part || !row.captured_at) return [];
  return (await archive.findByPrefix(archive.prefixFor(row))).map(f => f.name);
}

/**
 * Ordered, idempotent purge steps. Each gets (db, row) and returns a short
 * report. S2/S3 append theirs here.
 */
const PURGE_PARTS = [
  {
    // Derived children first (stt_raw: a voicemail's vendor transcript —
    // R10): their objects are deleted and the child rows tombstoned with the
    // same who/why, so no derived text outlives its audio.
    name: 'derived_children',
    async run(db, row, ctx) {
      const [kids] = await db.query(
        `SELECT id, kind, provider, source_id, part, captured_at, state, object_name
           FROM comms_media
          WHERE source_table = 'comms_media' AND source_id = ? AND state <> 'purged'`, [row.id]);
      let deleted = 0;
      for (const k of kids) {
        const names = await _objectsOf(k);
        for (const n of names) await archive.deleteObject(n);
        deleted += names.length;
        await db.query(
          `UPDATE comms_media
              SET state = 'purged', purged_at = UTC_TIMESTAMP(), purged_by = ?, purge_reason = ?, next_attempt_at = NULL
            WHERE id = ? AND state <> 'purged'`,
          [ctx.userId, common.clamp(`with #${row.id}: ${ctx.reason}`, 500), k.id]);
      }
      return { rows: kids.length, deleted };
    },
  },
  {
    name: 'bucket_objects',
    async run(db, row) {
      const names = await _objectsOf(row);
      for (const n of names) await archive.deleteObject(n);
      return { deleted: names.length };
    },
  },
];

/**
 * Purge one comms_media row (§8). Throws httpError 404 / 409 / 502.
 * @returns {Promise<{id, state:'purged', parts:object}>}
 */
async function purge(db, id, { userId, reason }) {
  let row = await _row(db, id);
  if (!row) throw httpError(404, 'Archive item not found');
  if (row.state === 'purged') throw httpError(409, 'Already purged');

  const lock = await common.acquireLock(db, _laneLock(row), limits.lockWaitS);
  if (!lock) throw httpError(409, 'The archive sweep is working on this item — retry in a minute');
  try {
    row = await _row(db, id);               // state may have moved while we waited
    if (row.state === 'purged') throw httpError(409, 'Already purged');
    const parts = {};
    for (const p of PURGE_PARTS) {
      try {
        parts[p.name] = await p.run(db, row, { userId, reason });
      } catch (err) {
        // Say exactly what is already done: earlier steps (derived children)
        // are purged for good; the item itself is not marked purged yet.
        const done = Object.entries(parts)
          .filter(([, v]) => v && ((v.rows || 0) > 0 || (v.deleted || 0) > 0))
          .map(([k, v]) => `${k}${v.rows != null ? ` (${v.rows} row(s))` : ''}`).join(', ');
        const e = httpError(502, `Purge step ${p.name} failed — ` +
          (done ? `already purged: ${done}; ` : '') + 'the item itself is NOT marked purged; retry');
        e.cause = err;
        throw e;
      }
    }
    await db.query(
      `UPDATE comms_media
          SET state = 'purged', purged_at = UTC_TIMESTAMP(), purged_by = ?, purge_reason = ?,
              next_attempt_at = NULL
        WHERE id = ? AND state <> 'purged'`,
      [userId, common.clamp(reason, 500), id],
    );
    return { id: row.id, state: 'purged', restricted: row.restricted, parts };
  } finally {
    await lock.release();
  }
}

module.exports = { isArchiveAdmin, isEvalReviewer, isArchiveSu, REVIEWERS_KEY, parseAdmins, setRestricted, purge, PURGE_PARTS, ADMINS_KEY, SWEEP_LOCKS, httpError, limits };
