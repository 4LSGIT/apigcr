// services/campaignSegmentService.js
//
/**
 * YisraMail C4 — saved segments (`campaign_segments`, ref/YISRAMAIL_DESIGN.md
 * §6.2). A segment is a NAME over the compose contact filter: exactly the
 * GET /api/campaigns/contacts keys, nothing else. It is RE-RUN when picked in
 * compose — never a frozen contact list — and it never carries class/topic:
 * those belong to the campaign being composed, and the consent question is
 * re-asked per recipient at send time anyway (executeSend).
 *
 * EVERY save validates the filter against SEGMENT_FILTER_KEYS and refuses an
 * unknown key, a wrong shape or an over-bound value (400 segment_rejected) —
 * a segment that getFilteredContacts cannot run is never stored. {} is valid:
 * "everyone" (the topic's consent state is the list, §6.2).
 *
 * Archive is a flag (no delete), the designs-library pattern: an archived
 * segment leaves the compose picker but stays readable.
 */

'use strict';

const { escapeLike } = require('../lib/escapeLike');

const NAME_MAX = 255;
const LIST_LIMIT = 200;
const TAG_MAX = 100;        // one tag / stage label
const LIST_ENTRIES_MAX = 50; // tags / case_stage entries per segment
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class SegmentError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'SegmentError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** A route-facing { status, body } for a SegmentError; null for anything else. */
function segmentErrorBody(err) {
  if (err instanceof SegmentError) return { status: err.status, body: { error: err.message, code: err.code, ...err.extra } };
  return null;
}

/** A positive integer id from a path / body value, else null. */
function toId(v) {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= 4294967295 ? n : null;
}

function reject(detail) { throw new SegmentError(400, 'segment_rejected', `segment filter rejected: ${detail}`); }

function checkStringList(v, key) {
  if (!Array.isArray(v)) reject(`${key} must be an array of strings`);
  // Empty = "leave the key out": stored, it would feed getFilteredContacts an IN ().
  if (!v.length) reject(`${key} must not be empty — omit the key instead`);
  if (v.length > LIST_ENTRIES_MAX) reject(`${key} has over ${LIST_ENTRIES_MAX} entries`);
  for (const t of v) {
    if (typeof t !== 'string' || !t.trim()) reject(`${key} entries must be non-empty strings`);
    if (t.length > TAG_MAX) reject(`a ${key} entry is over ${TAG_MAX} characters`);
  }
  return v.map((t) => t.trim());
}

function checkString(v, key) {
  if (typeof v !== 'string' || !v.trim()) reject(`${key} must be a non-empty string`);
  if (v.length > TAG_MAX) reject(`${key} is over ${TAG_MAX} characters`);
  return v.trim();
}

function checkDate(v, key) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) reject(`${key} must be a YYYY-MM-DD date`);
  return v;
}

/** key → its check. The contract is GET /api/campaigns/contacts (routes/campaign.js). */
const SEGMENT_FILTER_KEYS = Object.freeze({
  tags:             (v) => checkStringList(v, 'tags'),
  case_type:        (v) => checkString(v, 'case_type'),
  case_subtype:     (v) => checkString(v, 'case_subtype'),
  case_stage:       (v) => checkStringList(v, 'case_stage'),
  case_open_after:  (v) => checkDate(v, 'case_open_after'),
  case_open_before: (v) => checkDate(v, 'case_open_before'),
  channel:          (v) => { if (v !== 'sms' && v !== 'email') reject("channel must be 'sms' or 'email'"); return v; },
});

/**
 * The validated, normalized filter ({} allowed = everyone) — or a 400
 * SegmentError naming the first problem. Only known keys, each checked.
 */
function validateFilter(filter) {
  if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) reject('filter must be a JSON object');
  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    const check = SEGMENT_FILTER_KEYS[k];
    if (!check) reject(`unknown key "${k}"`);
    out[k] = check(v);
  }
  return out;
}

function readName(body) {
  const name = typeof (body || {}).name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) throw new SegmentError(400, 'invalid_input', `name is required (1–${NAME_MAX} characters)`);
  return name;
}

const row = (r) => ({
  id: r.id,
  name: r.name,
  filter: typeof r.filter_json === 'string' ? JSON.parse(r.filter_json) : r.filter_json,
  created_by: r.created_by == null ? null : r.created_by,
  updated_at: r.updated_at,
  archived: !!Number(r.archived),
});

/** → [{ id, name, filter, created_by, updated_at, archived }] — newest first. */
async function listSegments(db, { q = null, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push('archived = 0');
  const term = typeof q === 'string' ? q.trim() : '';
  if (term) { where.push('name LIKE ?'); params.push(`%${escapeLike(term)}%`); }
  const [rows] = await db.query(
    `SELECT id, name, filter_json, created_by, updated_at, archived FROM campaign_segments
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC LIMIT ${LIST_LIMIT}`,
    params,
  );
  return rows.map(row);
}

/** POST — validate, then INSERT. → { id } */
async function createSegment(db, body, { userId = null } = {}) {
  const name = readName(body);
  const filter = validateFilter((body || {}).filter);
  // users.user (tinyint) — JWT subs arrive as numbers or numeric strings (api.reports notes both).
  const uid = userId == null || userId === '' ? NaN : Number(userId);
  const [r] = await db.query(
    'INSERT INTO campaign_segments (name, filter_json, created_by) VALUES (?, ?, ?)',
    [name, JSON.stringify(filter), Number.isInteger(uid) && uid > 0 && uid <= 255 ? uid : null],
  );
  return { id: r.insertId };
}

/** PUT — validate, then UPDATE in place. → { id }; 404 not_found. */
async function updateSegment(db, id, body) {
  const n = toId(id);
  if (!n) throw new SegmentError(400, 'invalid_input', 'id must be a positive integer');
  const name = readName(body);
  const filter = validateFilter((body || {}).filter);
  const [r] = await db.query(
    'UPDATE campaign_segments SET name = ?, filter_json = ? WHERE id = ?',
    [name, JSON.stringify(filter), n],
  );
  if (!r.affectedRows) throw new SegmentError(404, 'not_found', `Segment ${n} not found`);
  return { id: n };
}

/** PATCH { archived: true|false } — exactly a boolean. 404 not_found. */
async function setArchived(db, id, archived) {
  const n = toId(id);
  if (!n) throw new SegmentError(400, 'invalid_input', 'id must be a positive integer');
  if (archived !== true && archived !== false) throw new SegmentError(400, 'invalid_input', 'archived must be true or false');
  const [r] = await db.query('UPDATE campaign_segments SET archived = ? WHERE id = ?', [archived ? 1 : 0, n]);
  if (!r.affectedRows) throw new SegmentError(404, 'not_found', `Segment ${n} not found`);
}

module.exports = {
  listSegments,
  createSegment,
  updateSegment,
  setArchived,
  validateFilter,
  segmentErrorBody,
  toId,
  SegmentError,
  SEGMENT_FILTER_KEYS,
  NAME_MAX,
  LIST_LIMIT,
};
