// services/emailDesignService.js
//
/**
 * YisraMail C3a — the designs library (`email_designs`, ref/YISRAMAIL_DESIGN.md
 * §6.3 "As built (C3a)"). Reusable Designer newsletters: the builder's
 * design_json, the compiled html and the text part.
 *
 * EVERY save (create and update) runs validateDesign (lib/emailDesignRules —
 * the C3 spike's server rules 1–10) on the raw request payload BEFORE any DB
 * write. A failure is a 400 { code:'design_rejected', rule, detail }: the
 * design is refused, never stripped or repaired. Rule 10's Gmail-clip case is
 * a warning carried on the success ({ warning }).
 *
 * Archive is a flag (no delete): an archived design leaves the default list
 * and cannot become a NEW campaign's design_id (campaignService.createCampaign
 * checks), but stays readable by id — campaigns keep it as provenance.
 */

'use strict';

const { validateDesign, DesignRejected } = require('../lib/emailDesignRules');
const { escapeLike } = require('../lib/escapeLike');

const BUILDER = 'grapesjs-mjml';
const NAME_MAX = 255;
const TEXT_MAX_BYTES = 1024 * 1024;
const LIST_LIMIT = 500;

class DesignError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'DesignError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** A route-facing { status, body } for a DesignError / DesignRejected; null for anything else. */
function designErrorBody(err) {
  if (err instanceof DesignRejected) {
    return { status: 400, body: { error: err.message, code: err.code, rule: err.rule, detail: err.detail } };
  }
  if (err instanceof DesignError) return { status: err.status, body: { error: err.message, code: err.code, ...err.extra } };
  return null;
}

/** A positive integer id from a path / body value, else null. */
function toId(v) {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= 4294967295 ? n : null;
}

/** name + text checks (not design rules) → { name, text }. */
function readFields(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > NAME_MAX) throw new DesignError(400, 'invalid_input', `name is required (1–${NAME_MAX} characters)`);
  if (typeof b.text !== 'string') throw new DesignError(400, 'invalid_input', 'text must be a string (the plain-text part)');
  if (Buffer.byteLength(b.text, 'utf8') > TEXT_MAX_BYTES) throw new DesignError(400, 'invalid_input', `text is over ${TEXT_MAX_BYTES} bytes`);
  return { name, text: b.text };
}

const listRow = (r) => ({ id: r.id, name: r.name, builder: r.builder, updated_at: r.updated_at, archived: !!Number(r.archived) });
const fullRow = (r) => ({
  id: r.id,
  name: r.name,
  builder: r.builder,
  design_json: typeof r.design_json === 'string' ? JSON.parse(r.design_json) : r.design_json,
  html: r.html,
  text: r.text,
  thumbnail_asset_id: r.thumbnail_asset_id == null ? null : r.thumbnail_asset_id,
  created_by: r.created_by == null ? null : r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
  archived: !!Number(r.archived),
});

/** → [{ id, name, builder, updated_at, archived }] — newest first, no bodies. */
async function listDesigns(db, { q = null, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (!includeArchived) where.push('archived = 0');
  const term = typeof q === 'string' ? q.trim() : '';
  if (term) { where.push('name LIKE ?'); params.push(`%${escapeLike(term)}%`); }
  const [rows] = await db.query(
    `SELECT id, name, builder, updated_at, archived FROM email_designs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC LIMIT ${LIST_LIMIT}`,
    params,
  );
  return rows.map(listRow);
}

/** → the full row; 404 not_found. */
async function getDesign(db, id) {
  const n = toId(id);
  if (!n) throw new DesignError(400, 'invalid_input', 'id must be a positive integer');
  const [[row]] = await db.query(
    `SELECT id, name, builder, design_json, html, text, thumbnail_asset_id, created_by, created_at, updated_at, archived
       FROM email_designs WHERE id = ?`, [n]);
  if (!row) throw new DesignError(404, 'not_found', `Design ${n} not found`);
  return fullRow(row);
}

/** POST — validate, then INSERT. → { id, warning } */
async function createDesign(db, body, { userId = null } = {}) {
  const { name, text } = readFields(body);
  const { design, warning } = validateDesign({ design_json: body.design_json, html: body.html });
  // users.user (tinyint) — JWT subs arrive as numbers or numeric strings (api.reports notes both).
  const uid = userId == null || userId === '' ? NaN : Number(userId);
  const [r] = await db.query(
    `INSERT INTO email_designs (name, builder, design_json, html, text, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, BUILDER, JSON.stringify(design), body.html, text, Number.isInteger(uid) && uid > 0 && uid <= 255 ? uid : null],
  );
  return { id: r.insertId, warning };
}

/** PUT — validate, then UPDATE in place. → { id, warning }; 404 not_found. */
async function updateDesign(db, id, body) {
  const n = toId(id);
  if (!n) throw new DesignError(400, 'invalid_input', 'id must be a positive integer');
  const { name, text } = readFields(body);
  const { design, warning } = validateDesign({ design_json: body.design_json, html: body.html });
  const [r] = await db.query(
    'UPDATE email_designs SET name = ?, design_json = ?, html = ?, text = ? WHERE id = ?',
    [name, JSON.stringify(design), body.html, text, n],
  );
  if (!r.affectedRows) throw new DesignError(404, 'not_found', `Design ${n} not found`);
  return { id: n, warning };
}

/** PATCH { archived: true|false } — exactly a boolean. 404 not_found. */
async function setArchived(db, id, archived) {
  const n = toId(id);
  if (!n) throw new DesignError(400, 'invalid_input', 'id must be a positive integer');
  if (archived !== true && archived !== false) throw new DesignError(400, 'invalid_input', 'archived must be true or false');
  const [r] = await db.query('UPDATE email_designs SET archived = ? WHERE id = ?', [archived ? 1 : 0, n]);
  if (!r.affectedRows) throw new DesignError(404, 'not_found', `Design ${n} not found`);
}

module.exports = {
  listDesigns,
  getDesign,
  createDesign,
  updateDesign,
  setArchived,
  validateDesign,
  designErrorBody,
  toId,
  DesignError,
  DesignRejected,
  BUILDER,
  LIST_LIMIT,
};
