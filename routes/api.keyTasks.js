// routes/api.keyTasks.js
//
/**
 * Session-key tasks — access-control D3 (ref/ACCESS_CONTROL_DESIGN.md §5.10).
 *
 * THE FIRST APP-TABLE WRITE A SESSION KEY CAN MAKE. Until D3 a session key
 * (ycro_) reached read-only SQL, scratch notes and IT alerts; with the
 * explicit scope `tasks.own` it may also hand work to staff as tasks — so an
 * AI manager puts a work item in front of Fred or a teammate directly instead
 * of through chat. It manages ONLY the tasks it created.
 *
 *   POST  /api/key-tasks                {to, title, desc?, start?, due?, link_type?, link_id?, send_assignment_email?, notify?}
 *   GET   /api/key-tasks                ?status= (default Incomplete) &limit= (≤200) &offset=
 *   GET   /api/key-tasks/:id
 *   PATCH /api/key-tasks/:id            {title?, desc?, start?, due?, link_type?, link_id?, to?, notify?}
 *   PATCH /api/key-tasks/:id/complete   {note?}
 *   PATCH /api/key-tasks/:id/reopen
 *   PATCH /api/key-tasks/:id/delete     {note?}
 *
 * Every mount: readonlyApiKeyAuth + requireKeyScope('tasks.own') (legacy NULL
 * keys lack it — explicit; a child never holds it — not in CHILD_SCOPES). The
 * jwtOrApiKey /api/tasks* routes are untouched.
 *
 * Rules:
 *   - Ownership = tasks.task_session_key_id = req.auth.keyId — a real column,
 *     never task_source. Anything else (a task made in the app, or by another
 *     key) is a 404, the same as a missing id: existence is never confirmed.
 *   - `to` (create and reassign): an ACTIVE STAFF user —
 *     taskService.findAssignableStaff, the app's own list_users predicate.
 *     The Automation user (0) and anyone else → 400.
 *   - task_from = the key's created_by (the SU who minted it); task_source =
 *     'session_key:<keyId>'; every task_log row these routes write carries
 *     { via: 'session_key', keyId }, so the history names the key as the actor.
 *     The log's `by` is task_from (the minter), as for any task the minter made.
 *   - Assignment email: taskService's default (on); send_assignment_email:false
 *     turns it off.
 *   - Completion email (`notify` → task_notification, DEFAULT TRUE — Fred,
 *     2026-10-15): when the task is completed, task_from — the key's minter —
 *     is emailed (taskService.completeTask). notify:false turns it off; PATCH
 *     may change it.
 *   - Create is rate-limited: CREATE_LIMIT per rolling hour per ROOT key
 *     (req.auth.rootKeyId), counted in the DB (Cloud Run runs several
 *     instances) under a named lock per root, so concurrent creates cannot
 *     overshoot. Edits are not limited.
 *   - The action token (task_action_token / action_url) is NEVER returned: it
 *     is the assignee's one-click bearer, and the key has no business holding it.
 *   - Bodies are closed: an unknown field is a 400, so a caller never believes
 *     a field it sent did something.
 *   - All task semantics go through services/taskService — no parallel SQL.
 *   - Not a sync-bus write: /api/tasks* has no yc-sync MATCHER either, and these
 *     callers are sessions, not browser frames (reported to the arc manager).
 *   - No admin_audit_log row: task_log is the record (via + keyId on every row).
 */

'use strict';

const express = require('express');
const router = express.Router();
const { readonlyApiKeyAuth, requireKeyScope } = require('../lib/auth.readonly');
const taskService = require('../services/taskService');

const CREATE_LIMIT = 20;   // per rolling hour per root key — Fred-approved, 2026-10-15
const LINK_TYPES = ['contact', 'case', 'appt', 'bill', 'event'];   // the tasks.task_link_type enum
const LIST_STATUSES = ['Incomplete', 'All', 'Pending', 'Due Today', 'Overdue', 'Completed', 'Deleted'];
const CREATE_FIELDS = ['to', 'title', 'desc', 'start', 'due', 'link_type', 'link_id', 'send_assignment_email', 'notify'];
const EDIT_FIELDS = ['to', 'title', 'desc', 'start', 'due', 'link_type', 'link_id', 'notify'];

const gate = [readonlyApiKeyAuth, requireKeyScope('tasks.own')];

class Bad extends Error {}
const bad = (m) => { throw new Bad(m); };
const fail = (res, status, message) => res.status(status).json({ status: 'error', message });

/** Same clamp as routes/api.tasks.js cleanNote (duplicated by that file's convention). */
function cleanNote(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return s ? s.slice(0, 500) : null;
}

/** The task as the key may see it: everything but the assignee's action token. */
function keyView(task) {
  if (!task) return task;
  const { action_token, ...rest } = task;   // eslint-disable-line no-unused-vars
  return rest;
}

const logExtra = (req) => ({ via: 'session_key', keyId: req.auth.keyId });
const actor = (req) => req.auth.createdBy ?? 0;

function closedBody(body, allowed) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) bad('body must be a JSON object');
  const unknown = Object.keys(body).filter(k => !allowed.includes(k));
  if (unknown.length) bad(`unknown field(s): ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`);
}

function bool(name, v) {
  if (typeof v !== 'boolean') bad(`${name} must be true or false`);
  return v;
}
function title(v) {
  if (typeof v !== 'string' || !v.trim()) bad('title is required (non-empty string)');
  if (v.length > 100) bad('title exceeds 100 chars');
  return v;
}
function desc(v) {
  if (v == null) return '';
  if (typeof v !== 'string') bad('desc must be a string');
  if (v.length > 1000) bad('desc exceeds 1000 chars');
  return v;
}
/** null / '' → null; else a real calendar date YYYY-MM-DD. */
function date(name, v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${name} must be YYYY-MM-DD`);
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== v) bad(`${name} is not a real date: ${v}`);
  return v;
}
/** Both or neither; link_type null (with link_id absent or null) = no link. */
function link(body) {
  const t = body.link_type, i = body.link_id;
  if (t == null) {
    if (i != null) bad('link_id needs link_type');
    return { link_type: null, link_id: null };
  }
  if (!LINK_TYPES.includes(t)) bad(`link_type must be one of ${LINK_TYPES.join(', ')}`);
  if (i == null || String(i).trim() === '') bad('link_type needs link_id');
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(String(i))) bad('link_id must be 1–20 letters, digits, _ or -');
  return { link_type: t, link_id: String(i) };
}
async function assignee(db, v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isInteger(n) || n <= 0) bad('to must be the user id of an active staff member (not Automation)');
  const u = await taskService.findAssignableStaff(db, n);
  if (!u) bad(`user ${n} is not an active staff member — a task can go only to active staff (not Automation)`);
  return n;
}
function taskId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function owned(req, res) {
  const id = taskId(req);
  const task = id && await taskService.getSessionKeyTask(req.db, id, req.auth.keyId);
  if (!task) { fail(res, 404, 'Task not found'); return null; }
  return task;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post('/api/key-tasks', ...gate, async (req, res) => {
  let input;
  try {
    const b = req.body;
    closedBody(b, CREATE_FIELDS);
    if (b.send_assignment_email !== undefined) bool('send_assignment_email', b.send_assignment_email);
    input = {
      notify: b.notify === undefined ? true : bool('notify', b.notify),
      title: title(b.title), desc: desc(b.desc),
      start: date('start', b.start), due: date('due', b.due),
      ...link(b),
      to: await assignee(req.db, b.to),
      send_assignment_email: b.send_assignment_email !== false,
    };
  } catch (err) {
    if (err instanceof Bad) return fail(res, 400, err.message);
    console.error('POST /api/key-tasks validation error:', err);
    return fail(res, 500, 'Failed to create task');
  }

  // Rate limit, exact: one named lock per root key serialises its creates, so
  // the DB count and the INSERT cannot interleave across instances.
  const root = req.auth.rootKeyId ?? req.auth.keyId;
  const lock = `yc_key_tasks_${root}`;
  let conn;
  try {
    conn = await req.db.getConnection();
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, 5) AS got', [lock]);
    if (Number(got) !== 1) return fail(res, 503, 'Busy creating another task for this key — retry');
    try {
      const n = await taskService.countRecentSessionKeyTasks(conn, root);
      if (n >= CREATE_LIMIT) {
        return fail(res, 429, `Rate limit: ${CREATE_LIMIT} tasks per rolling hour per key (a child key shares its parent's)`);
      }
      const created = await taskService.createTask(req.db, {
        from: actor(req),
        ...input,
        source: `session_key:${req.auth.keyId}`,
        session_key_id: req.auth.keyId,
        log_extra: logExtra(req),
      });
      const task = await taskService.getTask(req.db, created.task_id);
      res.json({ status: 'success', task_id: created.task_id, data: keyView(task) });
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
    }
  } catch (err) {
    console.error('POST /api/key-tasks error:', err);
    if (!res.headersSent) fail(res, 500, 'Failed to create task');
  } finally {
    if (conn) conn.release();
  }
});

// ─── LIST (own) ───────────────────────────────────────────────────────────────
router.get('/api/key-tasks', ...gate, async (req, res) => {
  const status = req.query.status || 'Incomplete';
  if (!LIST_STATUSES.includes(status)) return fail(res, 400, `status must be one of ${LIST_STATUSES.join(', ')}`);
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail(res, 400, 'limit must be 1–200');
  if (!Number.isInteger(offset) || offset < 0) return fail(res, 400, 'offset must be a whole number ≥ 0');
  try {
    const r = await taskService.listTasks(req.db, { status, session_key_id: req.auth.keyId, limit, offset });
    res.json({ data: r.data.map(keyView), total: r.total });
  } catch (err) {
    console.error('GET /api/key-tasks error:', err);
    fail(res, 500, 'Failed to fetch tasks');
  }
});

// ─── GET ONE (own) ────────────────────────────────────────────────────────────
router.get('/api/key-tasks/:id(\\d+)', ...gate, async (req, res) => {
  try {
    const task = await owned(req, res);
    if (task) res.json({ data: keyView(task) });
  } catch (err) {
    console.error('GET /api/key-tasks/:id error:', err);
    fail(res, 500, 'Failed to fetch task');
  }
});

// ─── EDIT (own) — fields, and `to` = transferTask ─────────────────────────────
router.patch('/api/key-tasks/:id(\\d+)', ...gate, async (req, res) => {
  try {
    const task = await owned(req, res);
    if (!task) return;
    const b = req.body;
    let fields = {}, to = null;
    try {
      closedBody(b, EDIT_FIELDS);
      if (!Object.keys(b).length) bad(`nothing to change — send any of ${EDIT_FIELDS.join(', ')}`);
      if ('title' in b) fields.task_title = title(b.title);
      if ('desc' in b) fields.task_desc = desc(b.desc);
      if ('notify' in b) fields.task_notification = bool('notify', b.notify) ? 1 : 0;
      if ('start' in b) fields.task_start = date('start', b.start);
      if ('due' in b) fields.task_due = date('due', b.due);
      if ('link_type' in b || 'link_id' in b) {
        const l = link(b);
        fields.task_link_type = l.link_type;
        fields.task_link_id = l.link_id;
        fields.task_link = l.link_id || '';   // the legacy column, as createTask writes it
      }
      if ('to' in b) {
        to = await assignee(req.db, b.to);
        if (['Completed', 'Deleted'].includes(task.status)) bad(`Cannot transfer a ${task.status} task`);
        if (to === Number(task.to.id)) to = null;   // already theirs
      }
    } catch (err) {
      if (err instanceof Bad) return fail(res, 400, err.message);
      throw err;
    }
    let out = task;
    if (Object.keys(fields).length) out = await taskService.updateTask(req.db, task.id, fields, actor(req), logExtra(req));
    if (to != null) out = await taskService.transferTask(req.db, task.id, to, actor(req), logExtra(req));
    res.json({ status: 'success', data: keyView(out) });
  } catch (err) {
    console.error('PATCH /api/key-tasks/:id error:', err);
    fail(res, 500, 'Failed to update task');
  }
});

// ─── STATUS VERBS (own) ───────────────────────────────────────────────────────
function verb(name, run) {
  return async (req, res) => {
    try {
      const task = await owned(req, res);
      if (!task) return;
      const allowed = name === 'reopen' ? [] : ['note'];
      try { closedBody(req.body || {}, allowed); } catch (err) { return fail(res, 400, err.message); }
      const out = await run(req, task);
      res.json({ status: 'success', data: keyView(out) });
    } catch (err) {
      const status = /already|Cannot/.test(err.message) ? 400 : 500;
      if (status === 500) console.error(`PATCH /api/key-tasks/:id/${name} error:`, err);
      fail(res, status, status === 400 ? err.message : `Failed to ${name} task`);
    }
  };
}
const withNote = (req) => { const note = cleanNote(req.body?.note); return { ...logExtra(req), ...(note && { note }) }; };

router.patch('/api/key-tasks/:id(\\d+)/complete', ...gate,
  verb('complete', (req, t) => taskService.completeTask(req.db, t.id, actor(req), withNote(req))));
router.patch('/api/key-tasks/:id(\\d+)/reopen', ...gate,
  verb('reopen', (req, t) => taskService.reopenTask(req.db, t.id, actor(req), logExtra(req))));
router.patch('/api/key-tasks/:id(\\d+)/delete', ...gate,
  verb('delete', (req, t) => taskService.deleteTask(req.db, t.id, actor(req), withNote(req))));

module.exports = router;
module.exports.CREATE_LIMIT = CREATE_LIMIT;
