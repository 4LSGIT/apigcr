/**
 * tests/tasksEmailLink.test.js — comms-polish-2 C2: a task can link to an
 * EMAIL (tasks.task_link_type 'email', task_link_id = mail_messages.id;
 * migration 2026-11-16_tasks_link_type_email.sql).
 *   - createTask refuses a link type outside TASK_LINK_TYPES before any SQL
 *     (sql_mode is relaxed: the column would have stored '' for it) and
 *     accepts 'email';
 *   - listTasks / getTask shape an email link from the joined subject — the
 *     message's subject as the title, "(no subject)" for an empty one,
 *     "Email #<id>" when the message is gone (the LEFT JOIN found nothing).
 * The join itself (mm.id = CAST(task_link_id AS UNSIGNED), an eq_ref on the
 * PRIMARY KEY) runs on MySQL in tests/tasksEmailLink.mysql.test.js (gated).
 * Run: npx jest tests/tasksEmailLink.test.js
 */
'use strict';

const taskService = require('../services/taskService');

const ROW = (over = {}) => ({
  task_id: 9, task_status: 'Pending', task_from: 6, task_to: 6, task_date: new Date('2026-11-16T00:00:00Z'), task_start: null, task_due: null,
  task_link: '4477', task_link_type: 'email', task_link_id: '4477', task_title: 'Follow up', task_desc: '', task_notification: 0, task_source: 'comms',
  task_session_key_id: null, task_dedupe_key: null, task_last_update: new Date('2026-11-16T00:00:00Z'), task_action_token: null,
  from_id: 6, from_name: 'Fred', to_id: 6, to_name: 'Fred', contact_id: null, contact_name: null, case_id: null, case_number: null, case_number_full: null,
  mail_subject: 'Plan objection', ...over,
});

/** A stub pool answering the list's two statements and getTask's one from `rows`. */
function stubDb(rows) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT COUNT\(\*\) AS total/.test(String(sql).trim())) return [[{ total: rows.length }]];
      if (/FROM tasks t/.test(sql)) return [rows];
      return [[]];
    },
  };
}

describe('createTask', () => {
  const db = { query: () => { throw new Error('db must not be reached'); } };
  test('an unknown link type is a 400 before any SQL; the five old types and email pass the gate', async () => {
    await expect(taskService.createTask(db, { to: 5, title: 't', link_type: 'nope', link_id: '1' }))
      .rejects.toMatchObject({ status: 400, message: 'createTask: link_type must be one of contact, case, appt, bill, event, email' });
    expect([...taskService.TASK_LINK_TYPES]).toEqual(['contact', 'case', 'appt', 'bill', 'event', 'email']);
  });
});

describe('the shape of an email link', () => {
  test('listTasks: the message subject is the title; the join is by CAST(task_link_id AS UNSIGNED) on mail_messages', async () => {
    const db = stubDb([ROW(), ROW({ task_id: 10, task_link_id: '4478', mail_subject: '' }), ROW({ task_id: 11, task_link_id: '4479', mail_subject: null })]);
    const out = await taskService.listTasks(db, { status: 'All' });
    expect(out.data.map((t) => t.link)).toEqual([
      { type: 'email', id: '4477', title: 'Plan objection' },
      { type: 'email', id: '4478', title: '(no subject)' },
      { type: 'email', id: '4479', title: 'Email #4479' },   // the message is gone (pruned): the id stays
    ]);
    const rowsSql = db.seen.find((s) => /SELECT t\.\*/.test(s.sql)).sql;
    expect(rowsSql).toContain("LEFT JOIN mail_messages mm ON (t.task_link_type = 'email' AND mm.id = CAST(t.task_link_id AS UNSIGNED))");
    expect(rowsSql).toContain('mm.subject AS mail_subject');
  });
  test('getTask: the same shape and the same join', async () => {
    const db = stubDb([ROW()]);
    const t = await taskService.getTask(db, 9);
    expect(t.link).toEqual({ type: 'email', id: '4477', title: 'Plan objection' });
    expect(db.seen[0].sql).toContain("LEFT JOIN mail_messages mm ON (t.task_link_type = 'email' AND mm.id = CAST(t.task_link_id AS UNSIGNED))");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The routes' gate: an email link is written only by a signed-in reader of
// that message (routes/api.tasks.js assertEmailLinkReadable → the mail
// service's loadVisible, spied here — the mail store is not under test).
// ─────────────────────────────────────────────────────────────────────────────
describe('POST / PATCH /api/tasks: the email-link gate', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'tasks-email-link-secret';
  process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'yci_tasks_email_link_internal';
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const mailRead = require('../services/mailbox/mailReadService');
  const app = express();
  app.use(express.json());
  let pool;
  app.use((r, _res, next) => { r.db = pool; next(); });
  app.use(require('../routes/api.tasks'));
  let server; let base;
  beforeAll(async () => { await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  afterEach(() => jest.restoreAllMocks());
  const token = jwt.sign({ sub: '6', username: 'fred', user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);
  async function send(method, path, body, { apiKey = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = process.env.INTERNAL_API_KEY; else headers.Authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  // a pool that answers the audit insert and anything else emptily; the gate runs before any task SQL
  const stubPool = () => ({ query: jest.fn(async () => [[], []]) });
  const inserts = () => pool.query.mock.calls.filter((c) => /INSERT INTO tasks|UPDATE tasks/i.test(String(c[0])));

  test('create: an API key cannot make an email link (403, before any mail lookup or task SQL)', async () => {
    pool = stubPool();
    const vis = jest.spyOn(mailRead, 'loadVisible').mockResolvedValue({ id: 4477 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await send('POST', '/api/tasks', { to: 5, title: 't', link_type: 'email', link_id: '4477' }, { apiKey: true });
    expect([out.status, out.json.message]).toEqual([403, 'an email link needs a signed-in reader of that mailbox']);
    expect(vis).not.toHaveBeenCalled();
    expect(inserts()).toEqual([]);
  });

  test('create: a person who cannot read the message gets the mail store\'s 404 (no oracle), nothing written; a reader passes the gate', async () => {
    pool = stubPool();
    const vis = jest.spyOn(mailRead, 'loadVisible').mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await send('POST', '/api/tasks', { to: 5, title: 't', link_type: 'email', link_id: '4477' });
    expect([out.status, out.json.message]).toEqual([404, 'Message not found']);
    expect(vis).toHaveBeenCalledWith(pool, '6', '4477');
    expect(inserts()).toEqual([]);
    // a reader: the gate passes and the create goes on (past the gate — the stub pool stops it later, never with a 403 / 404)
    jest.restoreAllMocks();
    pool = stubPool();
    const ok = jest.spyOn(mailRead, 'loadVisible').mockResolvedValue({ id: 4477, mailbox_id: 1, via_alias: null });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const out2 = await send('POST', '/api/tasks', { to: 5, title: 't', link_type: 'email', link_id: '4477' });
    expect(ok).toHaveBeenCalledWith(pool, '6', '4477');
    expect([403, 404]).not.toContain(out2.status);
    // other link types never consult the mail store
    jest.restoreAllMocks();
    pool = stubPool();
    const none = jest.spyOn(mailRead, 'loadVisible');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await send('POST', '/api/tasks', { to: 5, title: 't', link_type: 'case', link_id: 'ABCD2345' });
    expect(none).not.toHaveBeenCalled();
  });

  test('update: the same gate on PATCH (403 for a key, 404 for a non-reader); an unknown link type is updateTask\'s 400', async () => {
    pool = stubPool();
    const vis = jest.spyOn(mailRead, 'loadVisible').mockRejectedValue(Object.assign(new Error('Message not found'), { status: 404 }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await send('PATCH', '/api/tasks/9', { task_link_type: 'email', task_link_id: '4477' }, { apiKey: true })).status).toBe(403);
    expect(vis).not.toHaveBeenCalled();
    const out = await send('PATCH', '/api/tasks/9', { task_link_type: 'email', task_link_id: '4477' });
    expect([out.status, out.json.message]).toEqual([404, 'Message not found']);
    expect(inserts()).toEqual([]);
    // a new id ALONE on a task already linked to an email runs the gate too (the stored type decides); on a case-linked task it does not
    const stored = (type) => ({ query: jest.fn(async (sql) => /WHERE t\.task_id = \? LIMIT 1/.test(String(sql))
      ? [[{ task_id: 9, task_status: 'Pending', task_from: 6, task_to: 6, task_link: 'x', task_link_type: type, task_link_id: '4477', task_title: 't', task_desc: '', from_id: 6, to_id: 6, mail_subject: 's' }]]
      : [[], []]) });
    pool = stored('email');
    expect((await send('PATCH', '/api/tasks/9', { task_link_id: '4478' }, { apiKey: true })).status).toBe(403);
    const moved = await send('PATCH', '/api/tasks/9', { task_link_id: '4478' });
    expect([moved.status, moved.json.message]).toEqual([404, 'Message not found']);
    expect(vis).toHaveBeenCalledWith(pool, '6', '4478');
    expect(pool.query.mock.calls.filter((c) => /UPDATE tasks/i.test(String(c[0])))).toEqual([]);
    vis.mockClear();
    pool = stored('case');
    await send('PATCH', '/api/tasks/9', { task_link_id: 'ABCD2345' });
    expect(vis).not.toHaveBeenCalled();
    pool = stubPool();
    const bad = await send('PATCH', '/api/tasks/9', { task_link_type: 'nope', task_link_id: '1' });
    expect([bad.status, bad.json.message]).toEqual([400, 'updateTask: task_link_type must be one of contact, case, appt, bill, event, email']);
  });
});
