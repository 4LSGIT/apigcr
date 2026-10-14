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

/**
 * @param {object} db
 * @param {object} auth  req.auth (lib/auth.jwtOrApiKey)
 * @returns {Promise<boolean>}
 */
async function isArchiveAdmin(db, auth) {
  if (!auth || auth.type !== 'jwt' || auth.userId == null) return false;
  const uid = Number(auth.userId);
  if (!Number.isInteger(uid) || uid < 0) return false;
  const mbx = require('./mailboxService'); // lazy require (convention)
  if (await mbx.isSuperuser(db, uid)) return true;
  const { getSetting } = require('./settingsService'); // lazy require (convention)
  const { ids, junk } = parseAdmins(await getSetting(db, ADMINS_KEY));
  if (junk.length) console.warn(`[comms archive] ${ADMINS_KEY}: ignored non-id entries ${JSON.stringify(junk.slice(0, 5))}`);
  if (!ids.has(uid)) return false;
  const [[u]] = await db.query('SELECT user_auth FROM users WHERE user = ? LIMIT 1', [uid]);
  return !!u && u.user_auth === 'authorized';
}

async function _row(db, id) {
  const [[row]] = await db.query(
    `SELECT id, kind, provider, source_id, part, captured_at, state, restricted, object_name
       FROM comms_media WHERE id = ?`, [id]);
  return row || null;
}

/** Restrict / unrestrict: flips the flag (any state). Reversible. */
async function setRestricted(db, id, on) {
  const row = await _row(db, id);
  if (!row) throw httpError(404, 'Archive item not found');
  await db.query('UPDATE comms_media SET restricted = ? WHERE id = ?', [on ? 1 : 0, id]);
  return { id: row.id, state: row.state, restricted: on ? 1 : 0 };
}

function _laneLock(row) {
  return common.hasCliff(row) ? SWEEP_LOCKS.cliff : SWEEP_LOCKS.media;
}

/** Object names this row may have in the bucket: its recorded one, or (not yet adopted) its prefix's. */
async function _objectsOf(row) {
  if (row.object_name) return [row.object_name];
  if (!row.part || !row.captured_at) return [];
  const args = { capturedAt: row.captured_at, sourceId: row.source_id, part: row.part };
  const prefix = row.kind === 'mms_file' ? archive.mmsPrefix(args) : archive.recordingPrefix(args);
  return (await archive.findByPrefix(prefix)).map(f => f.name);
}

/**
 * Ordered, idempotent purge steps. Each gets (db, row) and returns a short
 * report. S2/S3 append theirs here.
 */
const PURGE_PARTS = [
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
        parts[p.name] = await p.run(db, row);
      } catch (err) {
        const e = httpError(502, `Purge step ${p.name} failed — nothing marked purged; retry`);
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

module.exports = { isArchiveAdmin, parseAdmins, setRestricted, purge, PURGE_PARTS, ADMINS_KEY, SWEEP_LOCKS, httpError, limits };
