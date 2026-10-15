// services/commsNoTranscribe.js
//
/**
 * The do-not-transcribe list — comms_no_transcribe (ref/COMMS_ARCHIVE_DESIGN.md
 * §0 R9, P6). Routes: routes/api.commsArchive.js (`/api/comms-archive/no-transcribe`,
 * archive admins only); UI: public/connections.html Phone Lines → Do-not-transcribe.
 *
 * What the list does is decided elsewhere and only at SUBMIT time: the
 * transcription sweep (services/commsTranscribeSweep.js `_onNoTranscribe`)
 * skips a row whose comms_media.party ends in a listed number — last 10 digits
 * of the party with every non-digit removed — as skipped / no_transcribe, which
 * is never revisited. Audio is archived and playable as before; a skipped call
 * has no transcript, so it gets no summary. Existing transcripts are untouched
 * by an add, and the summarise sweep / Re-summarise do not read this list.
 *
 * `phone` is stored as the 10 digits that comparison expects: non-digits
 * stripped, an 11-digit number starting with the US '1' loses it; anything
 * else is refused. `created_by` = the staff member who ASKED for the number to
 * be listed (the form's "Requested by", default the admin adding it) — an
 * active staff user (taskService.findAssignableStaff: authorized, not the
 * automation user). Who actually added / removed it is the admin_audit_log row.
 */

'use strict';

const { httpError } = require('./commsArchiveAdmin');

const MAX_NOTE = 255;

/** '+1 (248) 555-1234' → '2485551234'; anything that is not 10 digits (or 1 + 10) → null. */
function normalizePhone(raw) {
  if (raw == null) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return null;
}

const SELECT = `SELECT n.id, n.phone, n.note, n.created_by, u.user_name AS created_by_name, n.created_at
                  FROM comms_no_transcribe n LEFT JOIN users u ON u.user = n.created_by`;

function shape(r) {
  return {
    id: Number(r.id), phone: r.phone, note: r.note == null ? null : r.note,
    created_by: r.created_by == null ? null : Number(r.created_by),
    created_by_name: r.created_by_name == null ? null : r.created_by_name,
    created_at: r.created_at,
  };
}

/** Every listed number, newest first. */
async function list(db) {
  const [rows] = await db.query(`${SELECT} ORDER BY n.created_at DESC, n.id DESC`);
  return rows.map(shape);
}

async function _one(db, id) {
  const [[r]] = await db.query(`${SELECT} WHERE n.id = ?`, [id]);
  return r ? shape(r) : null;
}

/**
 * Add a number. → the stored row. Throws httpError 400 (phone / note /
 * requested_by) or 409 (already on the list — the UNIQUE key decides, so two
 * racing adds cannot both land).
 * @param {object} db
 * @param {{phone:any, note?:any, requestedBy:any}} input
 */
async function add(db, { phone, note, requestedBy }) {
  const p = normalizePhone(phone);
  if (!p) throw httpError(400, 'Phone must be 10 digits (a leading 1 is dropped)');
  let n = null;
  if (note != null) {
    if (typeof note !== 'string') throw httpError(400, 'Note must be text');
    n = note.trim() || null;
    if (n && n.length > MAX_NOTE) throw httpError(400, `Note is at most ${MAX_NOTE} characters`);
  }
  const uid = /^\d{1,3}$/.test(String(requestedBy ?? '')) ? Number(requestedBy) : null;
  const staff = uid == null ? null : await require('./taskService').findAssignableStaff(db, uid); // lazy require (convention)
  if (!staff) throw httpError(400, 'Requested by must be an active staff member');
  let r;
  try {
    [r] = await db.query('INSERT INTO comms_no_transcribe (phone, note, created_by) VALUES (?, ?, ?)', [p, n, uid]);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') throw httpError(409, 'That number is already on the list');
    throw err;
  }
  return _one(db, r.insertId);
}

/** Remove one entry by id. → the removed row; 404 when there is none. */
async function remove(db, id) {
  const row = await _one(db, id);
  if (!row) throw httpError(404, 'Not on the list');
  const [r] = await db.query('DELETE FROM comms_no_transcribe WHERE id = ?', [id]);
  if (!r.affectedRows) throw httpError(404, 'Not on the list');
  return row;
}

module.exports = { normalizePhone, list, add, remove, MAX_NOTE };
