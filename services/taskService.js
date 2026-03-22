/**
 * Task Service
 * services/taskService.js
 *
 * CRUD for the tasks table. All task operations from routes,
 * internal functions, and services should go through here.
 *
 * Link strategy:
 *   - Writes: always set task_link + task_link_type + task_link_id (all three)
 *   - Reads: prefer task_link_type/task_link_id, fall back to task_link
 *     for old rows. Once backfill is done, remove the fallback.
 *
 * Usage:
 *   const taskService = require('../services/taskService');
 *   const { data, total } = await taskService.listTasks(db, { status: 'Incomplete' });
 */

// ─────────────────────────────────────────────────────────────
// listTasks
// ─────────────────────────────────────────────────────────────

/**
 * List tasks with filters, joined to users and linked entities.
 *
 * The link JOIN uses task_link_type/task_link_id when available,
 * falling back to task_link for old rows.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string}  [opts.query]        - text search across title, desc, linked names
 * @param {string}  [opts.status='Incomplete'] - 'Incomplete' (special), 'All', or exact enum
 * @param {number}  [opts.assigned_to]  - filter by task_to user ID
 * @param {number}  [opts.assigned_by]  - filter by task_from user ID
 * @param {string}  [opts.link_type]    - filter by task_link_type
 * @param {string}  [opts.link_id]      - filter by task_link_id
 * @param {number}  [opts.limit=100]
 * @param {number}  [opts.offset=0]
 * @returns {{ data: object[], total: number }}
 */
async function listTasks(db, {
  query       = '',
  status      = 'Incomplete',
  assigned_to = null,
  assigned_by = null,
  link_type   = null,
  link_id     = null,
  limit       = 100,
  offset      = 0
} = {}) {
  const where = [];
  const params = [];

  // Status filter
  // 'Incomplete' is not an enum value — it means Pending + Due Today + Overdue
  if (status === 'Incomplete') {
    where.push(`t.task_status IN ('Pending', 'Due Today', 'Overdue')`);
  } else if (status && status !== 'All') {
    where.push('t.task_status = ?');
    params.push(status);
  }

  // Text search
  if (query) {
    where.push(`(
      t.task_title LIKE ?
      OR t.task_desc LIKE ?
      OR co.contact_name LIKE ?
      OR ca.case_number LIKE ?
      OR ca.case_number_full LIKE ?
    )`);
    const q = `%${query}%`;
    params.push(q, q, q, q, q);
  }

  if (assigned_to) {
    where.push('t.task_to = ?');
    params.push(assigned_to);
  }

  if (assigned_by) {
    where.push('t.task_from = ?');
    params.push(assigned_by);
  }

  // Filter by linked entity
  if (link_type && link_id) {
    where.push(`(
      (t.task_link_type = ? AND t.task_link_id = ?)
      OR (t.task_link_type IS NULL AND t.task_link = ?)
    )`);
    params.push(link_type, String(link_id), String(link_id));
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Main query with link resolution
  // Uses COALESCE to handle both new (task_link_type) and old (task_link) rows
  const [rows] = await db.query(
    `SELECT
       t.task_id,
       t.task_status,
       t.task_title,
       t.task_desc,
       t.task_due,
       t.task_start,
       t.task_date,
       t.task_notification,
       t.task_link,
       t.task_link_type,
       t.task_link_id,

       uf.user       AS from_id,
       uf.user_name  AS from_name,
       ut.user       AS to_id,
       ut.user_name  AS to_name,

       co.contact_id,
       co.contact_name,

       ca.case_id,
       ca.case_number,
       ca.case_number_full

     FROM tasks t
     LEFT JOIN users uf ON t.task_from = uf.user
     LEFT JOIN users ut ON t.task_to   = ut.user
     LEFT JOIN contacts co ON (
       (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
       OR (t.task_link_type IS NULL AND t.task_link = co.contact_id)
     )
     LEFT JOIN cases ca ON (
       (t.task_link_type = 'case' AND t.task_link_id = ca.case_id)
       OR (t.task_link_type IS NULL AND t.task_link != '' AND (
         t.task_link = ca.case_number
         OR t.task_link = ca.case_number_full
         OR t.task_link = ca.case_id
       ))
     )
     ${whereSQL}
     ORDER BY t.task_date DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  // Count query (same WHERE, no JOINs needed for count)
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM tasks t
     LEFT JOIN contacts co ON (
       (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
       OR (t.task_link_type IS NULL AND t.task_link = co.contact_id)
     )
     LEFT JOIN cases ca ON (
       (t.task_link_type = 'case' AND t.task_link_id = ca.case_id)
       OR (t.task_link_type IS NULL AND t.task_link != '' AND (
         t.task_link = ca.case_number
         OR t.task_link = ca.case_number_full
         OR t.task_link = ca.case_id
       ))
     )
     ${whereSQL}`,
    params
  );

  // Normalize into a clean shape for the frontend
  const data = rows.map(r => {
    let link = null;
    if (r.task_link_type === 'contact' || (!r.task_link_type && r.contact_id)) {
      link = { type: 'contact', id: r.contact_id, title: r.contact_name };
    } else if (r.task_link_type === 'case' || (!r.task_link_type && r.case_id)) {
      link = {
        type: 'case',
        id: r.case_id,
        title: r.case_number_full || r.case_number || r.case_id
      };
    } else if (r.task_link_type === 'appt') {
      link = { type: 'appt', id: r.task_link_id, title: `Appt #${r.task_link_id}` };
    } else if (r.task_link_type === 'bill') {
      link = { type: 'bill', id: r.task_link_id, title: `Bill #${r.task_link_id}` };
    }

    return {
      id:      r.task_id,
      status:  r.task_status,
      title:   r.task_title,
      desc:    r.task_desc,
      due:     r.task_due,
      start:   r.task_start,
      created: r.task_date,
      notify:  !!r.task_notification,
      from:    { id: r.from_id, name: r.from_name },
      to:      { id: r.to_id, name: r.to_name },
      link
    };
  });

  return { data, total };
}


// ─────────────────────────────────────────────────────────────
// getTask
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single task by ID with linked entity info.
 * @param {object} db
 * @param {number} taskId
 * @returns {object|null}
 */
async function getTask(db, taskId) {
  const [[r]] = await db.query(
    `SELECT
       t.*,
       uf.user       AS from_id,
       uf.user_name  AS from_name,
       ut.user       AS to_id,
       ut.user_name  AS to_name,
       co.contact_id,
       co.contact_name,
       ca.case_id,
       ca.case_number,
       ca.case_number_full
     FROM tasks t
     LEFT JOIN users uf ON t.task_from = uf.user
     LEFT JOIN users ut ON t.task_to   = ut.user
     LEFT JOIN contacts co ON (
       (t.task_link_type = 'contact' AND t.task_link_id = co.contact_id)
       OR (t.task_link_type IS NULL AND t.task_link = co.contact_id)
     )
     LEFT JOIN cases ca ON (
       (t.task_link_type = 'case' AND t.task_link_id = ca.case_id)
       OR (t.task_link_type IS NULL AND t.task_link != '' AND (
         t.task_link = ca.case_number
         OR t.task_link = ca.case_number_full
         OR t.task_link = ca.case_id
       ))
     )
     WHERE t.task_id = ?
     LIMIT 1`,
    [taskId]
  );

  if (!r) return null;

  let link = null;
  if (r.task_link_type === 'contact' || (!r.task_link_type && r.contact_id)) {
    link = { type: 'contact', id: r.contact_id, title: r.contact_name };
  } else if (r.task_link_type === 'case' || (!r.task_link_type && r.case_id)) {
    link = { type: 'case', id: r.case_id, title: r.case_number_full || r.case_number || r.case_id };
  } else if (r.task_link_type === 'appt') {
    link = { type: 'appt', id: r.task_link_id, title: `Appt #${r.task_link_id}` };
  } else if (r.task_link_type === 'bill') {
    link = { type: 'bill', id: r.task_link_id, title: `Bill #${r.task_link_id}` };
  }

  return {
    id:      r.task_id,
    status:  r.task_status,
    title:   r.task_title,
    desc:    r.task_desc,
    due:     r.task_due,
    start:   r.task_start,
    created: r.task_date,
    notify:  !!r.task_notification,
    from:    { id: r.from_id, name: r.from_name },
    to:      { id: r.to_id, name: r.to_name },
    link
  };
}


// ─────────────────────────────────────────────────────────────
// createTask
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new task. Writes all three link columns.
 *
 * @param {object} db
 * @param {object} opts
 * @param {number}  opts.from       - user ID creating the task
 * @param {number}  opts.to         - user ID assigned to
 * @param {string}  opts.title      - task title (required)
 * @param {string}  [opts.desc]     - description
 * @param {string}  [opts.start]    - start date (ISO)
 * @param {string}  [opts.due]      - due date (ISO)
 * @param {boolean} [opts.notify]   - notify assigner on completion
 * @param {string}  [opts.link_type='contact'] - 'contact','case','appt','bill'
 * @param {string}  [opts.link_id]  - the linked entity ID
 * @returns {{ task_id: number }}
 */
async function createTask(db, {
  from,
  to,
  title,
  desc      = '',
  start     = null,
  due       = null,
  notify    = false,
  link_type = null,
  link_id   = null
}) {
  if (!title) throw new Error('createTask requires title');
  if (!to)    throw new Error('createTask requires to');

  const taskFrom = from || to;

  const [result] = await db.query(
    `INSERT INTO tasks
       (task_from, task_to, task_title, task_desc, task_start, task_due,
        task_notification, task_status, task_date, task_last_update,
        task_link, task_link_type, task_link_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', NOW(), NOW(), ?, ?, ?)`,
    [
      taskFrom,
      to,
      title,
      desc,
      start || null,
      due   || null,
      notify ? 1 : 0,
      link_id != null ? String(link_id) : '',  // task_link — legacy, TODO: REMOVE
      link_type,                                // task_link_type
      link_id != null ? String(link_id) : null  // task_link_id
    ]
  );

  return { task_id: result.insertId };
}


// ─────────────────────────────────────────────────────────────
// updateTask
// ─────────────────────────────────────────────────────────────

/**
 * Update one or more fields on a task.
 *
 * @param {object} db
 * @param {number} taskId
 * @param {object} fields - key/value pairs to update
 * @returns {object} the updated task
 */
async function updateTask(db, taskId, fields) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateTask requires at least one field');
  }

  const ALLOWED = new Set([
    'task_status', 'task_to', 'task_from', 'task_title', 'task_desc',
    'task_start', 'task_due', 'task_notification',
    'task_link', 'task_link_type', 'task_link_id'
  ]);

  const keys = Object.keys(fields);
  const blocked = keys.filter(k => !ALLOWED.has(k));
  if (blocked.length) {
    throw new Error(`updateTask: blocked fields: ${blocked.join(', ')}`);
  }

  const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
  const values = [...keys.map(k => fields[k]), taskId];

  const [result] = await db.query(
    `UPDATE tasks SET ${setClauses}, task_last_update = NOW() WHERE task_id = ?`,
    values
  );

  if (result.affectedRows === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  return getTask(db, taskId);
}


// ─────────────────────────────────────────────────────────────
// completeTask / cancelTask — convenience wrappers
// ─────────────────────────────────────────────────────────────

async function completeTask(db, taskId) {
  return updateTask(db, taskId, { task_status: 'Completed' });
}

async function cancelTask(db, taskId) {
  return updateTask(db, taskId, { task_status: 'Canceled' });
}


module.exports = {
  listTasks,
  getTask,
  createTask,
  updateTask,
  completeTask,
  cancelTask
};