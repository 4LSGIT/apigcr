// Recording only: no business services, evidence, field values or credentials.
// A null status is P4's not-applied; in_flight without a receipt is ALWAYS
// unknown, even when fresh. Claims are never taken over or automatically freed.
// Each statement autocommits on the pool BEFORE the browser's canonical write.
// A business rollback cannot roll back this claim. A lost response (including
// a failed claim acknowledgement) therefore fails closed, requiring inspection.
'use strict';

const crypto = require('crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = new Map([
  ...['create', 'update', 'complete', 'cancel', 'reopen', 'transfer'].map(k => [`task.${k}.v1`, 'task_id']),
  ...['create', 'update', 'complete', 'cancel'].map(k => [`event.${k}.v1`, 'event_id']),
  ...['create', 'update', 'attended', 'no_show', 'cancel', 'reschedule', 'reschedule_later'].map(k => [`appt.${k}.v1`, 'appt_id']),
  ...['phone', 'email', 'address'].flatMap(f => ['create', 'update', 'end'].map(k => [`contact.${f}.${k}.v1`, 'contact_id'])),
  ['job.code_safe.create.v1', 'job_id'],
  ['workflow.draft.v1', 'workflow_id'],
  ['hook.create.v1', 'hook_id'],
]);
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function actor(userId) {
  const value = typeof userId === 'string' && /^\d{1,3}$/.test(userId) ? Number(userId) : userId;
  if (!Number.isInteger(value) || value < 0 || value > 127) fail(403, 'Invalid staff user');
  return value;
}
function id(draftId) {
  if (typeof draftId !== 'string' || !UUID.test(draftId)) fail(400, 'Invalid draft id');
  return draftId;
}
function pool(db) {
  if (!db || typeof db.getConnection !== 'function') throw new Error('Action ledger requires the database pool, not a transaction connection');
}
function parsed(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function receipt(row) {
  return { draft_id: row.draft_id, kind: row.kind,
    outcome: row.status === 'applied' ? 'applied' : row.status === 'in_flight' ? 'unknown' : 'not-applied',
    ...(row.status === 'applied' ? { result: parsed(row.result) } : {}) };
}
// Called only on the server's normalized output, before handing it to a browser.
async function issue(db, userId, draft) {
  pool(db); userId = actor(userId); id(draft.draft_id);
  if (!KINDS.has(draft.kind)) fail(400, 'Unavailable action kind');
  await db.query('INSERT INTO assistant_action_ledger (user_id, draft_id, kind) VALUES (?, ?, ?)',
    [userId, draft.draft_id, draft.kind]);
}
async function read(db, userId, ids) {
  userId = actor(userId);
  if (!Array.isArray(ids) || ids.length > 220) fail(400, 'Too many action ids');
  ids.forEach(id);
  if (!ids.length) return [];
  const [rows] = await db.query(`SELECT draft_id, kind, status, result FROM assistant_action_ledger
    WHERE user_id = ? AND draft_id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]);
  return rows.map(receipt);
}
async function claim(db, userId, draftId) {
  pool(db); userId = actor(userId); id(draftId);
  // A separate, unpredictable receipt capability prevents another tab that
  // merely reads an unknown claim from settling it. It is never saved in chat.
  const token = crypto.randomUUID();
  const [changed] = await db.query(`UPDATE assistant_action_ledger SET status = 'in_flight', claim_token = ?
    WHERE user_id = ? AND draft_id = ? AND status IS NULL
      AND created_at >= NOW() - INTERVAL 15 MINUTE`, [token, userId, draftId]);
  if (changed.affectedRows === 1) return { outcome: 'in_flight', claimed: true, claim_token: token };
  const [row] = await read(db, userId, [draftId]);
  if (!row) fail(404, 'Action draft not found; ask Casey to prepare it again');
  if (row.outcome === 'not-applied') fail(409, 'This proposal has expired; ask Casey to prepare it again');
  return { ...row, replayed: row.outcome === 'applied' };
}
async function record(db, userId, draftId, token, result) {
  pool(db); userId = actor(userId); id(draftId); id(token);
  const [[row]] = await db.query(`SELECT kind, claim_token, status, result FROM assistant_action_ledger
    WHERE user_id = ? AND draft_id = ?`, [userId, draftId]);
  if (!row || row.claim_token !== token) fail(404, 'Action claim not found');
  const field = KINDS.get(row.kind);
  if (!field || !result || Object.keys(result).length !== 1 || !Number.isSafeInteger(result[field]) || result[field] < 1) {
    fail(400, 'Invalid action receipt');
  }
  const json = JSON.stringify({ [field]: result[field] });
  if (row.status === 'applied') {
    if (parsed(row.result)[field] !== result[field]) fail(409, 'The applied receipt cannot be replaced');
    return { outcome: 'applied', replayed: true };
  }
  const [changed] = await db.query(`UPDATE assistant_action_ledger SET status = 'applied', result = ?
    WHERE user_id = ? AND draft_id = ? AND claim_token = ? AND status = 'in_flight'`, [json, userId, draftId, token]);
  if (changed.affectedRows !== 1) {
    // Another request with this same token may have settled concurrently.
    const [saved] = await read(db, userId, [draftId]);
    if (saved && saved.outcome === 'applied' && saved.result[field] === result[field]) return { outcome: 'applied', replayed: true };
    fail(409, 'The applied receipt cannot be replaced');
  }
  return { outcome: 'applied', replayed: false };
}
module.exports = { issue, claim, record, read, KINDS };
