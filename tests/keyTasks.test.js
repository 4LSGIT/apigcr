// tests/keyTasks.test.js
//
/**
 * Session-key tasks — access-control D3, the no-DB half (the SQL paths are
 * tests/keyTasks.mysql.test.js).
 *
 * WHAT IS LOCKED
 *   - tasks.own: explicit (a legacy key lacks it), never a child's
 *     (childEffectiveScopes drops it even from a tampered child row).
 *   - taskService names task_session_key_id ONLY for a key's task: createTask's
 *     INSERT without session_key_id is the pre-D3 statement exactly; listTasks
 *     without session_key_id never names it. (The old-schema proof is the
 *     mysql suite; this pins the text so a refactor can't leak the column into
 *     every caller.)
 *   - findAssignableStaff's predicate is the app's own: active + human.
 *   - The route refuses bad input BEFORE any DB use (closed bodies, field
 *     rules), and the response view drops the action token.
 *   - sourceLabel names a key's task "Session key #N" — server (the digest
 *     email) and tasks.html (the chip); tasks.html's history says "via session
 *     key #N".
 *
 * Run: npx jest tests/keyTasks.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'key-tasks-d3-unit-secret';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({ ok: true })) }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const { JSDOM } = require('jsdom');

const { KEY_SCOPES, CHILD_SCOPES, keyAllows, childEffectiveScopes } = require('../lib/capabilities');
const { hashKey } = require('../lib/auth.readonly');
const taskService = require('../services/taskService');
const keyTasks = require('../routes/api.keyTasks');

const ROOT = path.join(__dirname, '..');
const flush = (ms = 0) => new Promise(r => setTimeout(r, ms));

describe('tasks.own', () => {
  test('explicit, not delegable, dropped from a tampered child', () => {
    expect(KEY_SCOPES['tasks.own']).toMatchObject({ explicit: true });
    expect(keyAllows({ scopes: null }, 'tasks.own')).toBe(false);
    expect(keyAllows({ scopes: ['tasks.own'] }, 'tasks.own')).toBe(true);
    expect(CHILD_SCOPES).not.toContain('tasks.own');
    expect(childEffectiveScopes(['sql.ro', 'tasks.own'], ['sql.ro', 'tasks.own', 'keys.mint'])).toEqual(['sql.ro']);
  });

  test('the create limit is 20', () => {
    expect(keyTasks.CREATE_LIMIT).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// taskService: the column is named only for a key's task
// ─────────────────────────────────────────────────────────────────────────────

function recordingDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/^INSERT INTO tasks/.test(s)) return [{ insertId: 501 }];
      if (/COUNT\(\*\) AS total/.test(s)) return [[{ total: 0 }]];
      if (/WHERE t\.task_id = \? LIMIT 1/.test(s)) return [[{ task_id: 501, task_title: 'x', task_status: 'Pending', task_link_type: null }]];
      if (/FROM tasks t/.test(s)) return [[]];
      return [[]];
    },
  };
}
const PRE_D3_INSERT = 'INSERT INTO tasks (task_from, task_to, task_title, task_desc, task_start, task_due, task_notification, task_source, task_status, task_date, task_last_update, task_link, task_link_type, task_link_id, task_action_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, ?, ?)';

describe('taskService — task_session_key_id only for a key\'s task', () => {
  test('createTask without session_key_id: the pre-D3 INSERT, byte for byte (whitespace-folded)', async () => {
    const db = recordingDb();
    await taskService.createTask(db, { from: 6, to: 9, title: 'x', send_assignment_email: false });
    const ins = db.calls.find(c => /^INSERT INTO tasks/.test(c.sql));
    expect(ins.sql).toBe(PRE_D3_INSERT);
    expect(ins.params).toHaveLength(13);
    expect(db.calls.some(c => /task_session_key_id/.test(c.sql))).toBe(false);
  });

  test('createTask with session_key_id: the column + its value; log_extra rides the created row', async () => {
    const db = recordingDb();
    const logs = [];
    jest.spyOn(require('../services/logService'), 'createLogEntry').mockImplementation(async (_db, e) => { logs.push(e); });
    await taskService.createTask(db, { from: 6, to: 9, title: 'x', session_key_id: 77, log_extra: { via: 'session_key', keyId: 77 }, send_assignment_email: false });
    const ins = db.calls.find(c => /^INSERT INTO tasks/.test(c.sql));
    expect(ins.sql).toMatch(/task_action_token, task_session_key_id\) VALUES \(.*, \?, \?\)$/);
    expect(ins.params).toHaveLength(14);
    expect(ins.params[13]).toBe(77);
    expect(logs).toHaveLength(1);
    expect(logs[0].data).toEqual({ action: 'created', task_id: 501, task_title: 'x', assigned_to: 9, via: 'session_key', keyId: 77 });
    await flush(10);
    jest.restoreAllMocks();
  });

  test('listTasks names the column only when asked', async () => {
    let db = recordingDb();
    await taskService.listTasks(db, {});
    expect(db.calls.some(c => /task_session_key_id/.test(c.sql))).toBe(false);
    db = recordingDb();
    await taskService.listTasks(db, { session_key_id: 77, status: 'All' });
    const count = db.calls.find(c => /COUNT\(\*\) AS total/.test(c.sql));
    expect(count.sql).toMatch(/WHERE t\.task_session_key_id = \?/);
    expect(count.params).toEqual([77]);
  });

  test('findAssignableStaff: active (the login gate) AND human (the picker\'s filter)', async () => {
    const db = recordingDb();
    expect(await taskService.findAssignableStaff(db, 9)).toBeNull();
    expect(db.calls[0].sql).toMatch(/WHERE user = \? AND user_auth LIKE 'authorized%' AND user_type <> 0/);
    expect(db.calls[0].params).toEqual([9]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The route: refusals before the DB, the token-less view
// ─────────────────────────────────────────────────────────────────────────────

const KEY = 'ycro_d3unitfixture';
function routeDb() {
  const calls = [];
  return {
    calls,
    getConnection: jest.fn(async () => { throw new Error('no connection expected'); }),
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/WHERE k\.key_hash = \?/.test(s)) {
        return [params[0] === hashKey(KEY) ? [{ id: 40, label: 'mgr', expires_at: new Date(Date.now() + 3600e3), revoked_at: null,
          scopes: ['tasks.own'], parent_key_id: null, parent_id: null, created_by: 6 }] : []];
      }
      if (/^UPDATE readonly_api_keys SET last_used_at/.test(s)) return [{}];
      if (/admin_audit_log/.test(s)) return [{}];
      if (/FROM users WHERE user = \? AND user_auth/.test(s)) return [[]];   // nobody is assignable
      throw new Error('unscripted: ' + s);
    },
  };
}
async function serve(db, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(keyTasks);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(r => server.close(r)); }
}
const post = (base, body) => fetch(`${base}/api/key-tasks`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-readonly-api-key': KEY }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }));

describe('POST /api/key-tasks — refused before any write', () => {
  test('closed body, field rules and a non-assignable `to` → 400; no connection, no INSERT', async () => {
    const db = routeDb();
    await serve(db, async (base) => {
      for (const [body, msg] of [
        [{ to: 9, title: 'x', task_status: 'Completed' }, /unknown field\(s\): task_status/],
        [{ to: 9 }, /title is required/],
        [{ to: 9, title: 'x', due: '2026-13-01' }, /not a real date/],
        [{ to: 9, title: 'x', link_type: 'bill' }, /needs link_id/],
        [{ to: 9, title: 'x' }, /not an active staff member/],
        [{ to: 0, title: 'x' }, /active staff member \(not Automation\)/],
        [[1, 2], /JSON object/],
      ]) {
        const r = await post(base, body);
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
        expect(r.body.message).toMatch(msg);
      }
    });
    expect(db.getConnection).not.toHaveBeenCalled();
    expect(db.calls.some(s => /INSERT INTO tasks/.test(s))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Labels: the digest email and tasks.html
// ─────────────────────────────────────────────────────────────────────────────

describe('a key\'s task is labelled "Session key #N"', () => {
  test('server: the digest email', () => {
    const html = taskService.buildDigestEmail({ user_name: 'Fred' },
      [], [], [{ task_id: 1, task_title: 'Call the trustee', task_status: 'Pending', task_source: 'session_key:12', task_due: null }], 'Monday');
    expect(html).toMatch(/Session key #12/);
  });

  test('tasks.html: the chip, and history "via session key #N"', async () => {
    const HTML = fs.readFileSync(path.join(ROOT, 'public/tasks.html'), 'utf8');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/tasks.html', runScripts: 'dangerously' });
    const { window } = dom;
    const task = { id: 7, status: 'Pending', title: 'Call the trustee', desc: '', due: null, start: null, created: '2026-10-15T12:00:00.000Z',
      notify: false, from: { id: 6, name: 'IT' }, to: { id: 9, name: 'Fred' }, link: null, source: 'session_key:12' };
    window.apiSend = async (url) => {
      if (/\/history$/.test(url)) {
        return { data: [{ id: 1, date: '2026-10-15T12:00:00.000Z', by: { id: 6, name: 'IT' }, action: 'created', note: null, data: { via: 'session_key', keyId: 12 } }] };
      }
      if (/^\/api\/tasks\/7$/.test(url)) return { data: task };
      return { data: [task], total: 1 };
    };
    window.firmData = { users: [{ user: 9, user_name: 'Fred', user_type: 1 }], firmTimezone: 'America/Detroit' };
    window.user = { user: 6, user_name: 'IT' };
    window.addFile = () => {};
    window.E = (id) => window.document.getElementById(id);
    window.getTabPref = (t, k, dflt) => dflt;
    window.setTabPref = () => {};
    window.YcPager = { getLimit: (k, dflt) => dflt, setLimit: () => {}, renderFooter: () => {}, renderPages: () => {} };
    window.Toast = { fire: () => {} };
    window.ycFiltersToggle = () => {};
    window.ycFiltersSync = () => {};
    const modal = window.document.createElement('div');
    window.Swal = { fire: async (o) => { modal.innerHTML = o.html || ''; window.document.body.appendChild(modal); return {}; }, close: () => {}, showLoading: () => {}, update: () => {} };
    window.document.body.innerHTML = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script>'));
    window.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>')));
    await flush(50);
    expect(window.document.body.textContent).toMatch(/Session key #12/);
    await window.viewTask(7);
    await flush(20);
    expect(window.document.getElementById('tkHist').textContent).toMatch(/via session key #12/);
    window.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3 follow-up B: assignee pickers offer active staff only
// ─────────────────────────────────────────────────────────────────────────────

describe('firmData.users carries `active` (the login gate) — every user still listed', () => {
  const http = require('http');
  const jwt = require('jsonwebtoken');
  const firmData = require('../routes/api.firmData');

  function firmDb() {
    const calls = [];
    return {
      calls,
      query: async (sql, params = []) => {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        calls.push(s);
        if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];
        if (/^SELECT \* FROM users WHERE user = \?/.test(s)) return [[{ user: params[0], user_name: 'U', roles: 'staff' }]];
        if (/FROM users ORDER BY user_name/.test(s)) {
          // what mysql2 hands back for the predicate: 1 / 0
          return [[{ user: 9, user_name: 'Fred', user_type: 1, active: 1 }, { user: 3, user_name: 'Ex Employee', user_type: 1, active: 0 }]];
        }
        return [[]];
      },
    };
  }
  function get(db) {
    const app = express();
    app.use((req, res, next) => { req.db = db; next(); });
    app.use(firmData);
    const token = jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', aud: 'staff', ver: 1, roles: [] },
      process.env.JWT_SECRET, { expiresIn: '5m' });
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        http.get({ port: server.address().port, path: '/api/firm-data', headers: { authorization: 'Bearer ' + token } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
  }

  test('the SELECT computes active with findAssignableStaff\'s predicate; the payload has real booleans; nobody is dropped', async () => {
    const db = firmDb();
    const r = await get(db);
    expect(r.status).toBe(200);
    const sel = db.calls.find(s => /FROM users ORDER BY user_name/.test(s));
    expect(sel).toMatch(/\(user_auth LIKE 'authorized%'\) AS active/);
    expect(sel).not.toMatch(/WHERE/);
    expect(r.body.users).toEqual([
      { user: 9, user_name: 'Fred', user_type: 1, active: true },
      { user: 3, user_name: 'Ex Employee', user_type: 1, active: false },
    ]);
  });
});

describe('tasks.html — assignee pickers drop inactive users; the list filters keep them', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'public/tasks.html'), 'utf8');
  async function bootTasks(users) {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/tasks.html', runScripts: 'dangerously' });
    const { window } = dom;
    const task = { id: 7, status: 'Pending', title: 'Call the trustee', desc: '', due: null, start: null, created: '2026-10-15T12:00:00.000Z',
      notify: false, from: { id: 6, name: 'IT' }, to: { id: 9, name: 'Fred' }, link: null, source: null };
    window.apiSend = async (url) => (/^\/api\/tasks\/7$/.test(url) ? { data: task } : { data: [task], total: 1 });
    window.firmData = { users, firmTimezone: 'America/Detroit' };
    window.user = { user: 6, user_name: 'IT' };
    window.addFile = () => {};
    window.E = (id) => window.document.getElementById(id);
    window.getTabPref = (t, k, dflt) => dflt;
    window.setTabPref = () => {};
    window.YcPager = { getLimit: (k, dflt) => dflt, setLimit: () => {}, renderFooter: () => {}, renderPages: () => {} };
    window.Toast = { fire: () => {} };
    window.ycFiltersToggle = () => {};
    window.ycFiltersSync = () => {};
    const shown = [];
    window.Swal = { fire: async (o) => { shown.push(o.html || ''); return {}; }, close: () => {}, showLoading: () => {}, update: () => {},
      showValidationMessage: () => {}, getPopup: () => null, isVisible: () => false };
    window.document.body.innerHTML = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script>'));
    window.eval(HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>')));
    await flush(50);
    return { window, shown };
  }
  const USERS = [
    { user: 9, user_name: 'Fred', user_type: 1, active: true },
    { user: 11, user_name: 'Dana', user_type: 1, active: true },
    { user: 3, user_name: 'Ex Employee', user_type: 1, active: false },
    { user: 12, user_name: 'Cached Payload', user_type: 1 },          // no `active` (old payload) → kept
    { user: 0, user_name: 'Automation', user_type: 0, active: true },
  ];
  const optionIds = (html) => [...html.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1]));

  test('create / edit picker and the transfer picker: active staff only', async () => {
    const { window, shown } = await bootTasks(USERS);
    window.newTaskDialog();
    await flush(10);
    expect(optionIds(shown.pop())).toEqual([9, 11, 12]);
    await window.transferDialog(7);
    expect(optionIds(shown.pop())).toEqual([11, 12]);                  // 9 is the current assignee
    window.close();
  });

  test('EDIT keeps the task\'s current assignee even when inactive — and it stays selected', async () => {
    const { window, shown } = await bootTasks(USERS);
    const task = { id: 8, status: 'Pending', title: 'old work', desc: '', due: null, start: null, notify: false,
      from: { id: 6, name: 'IT' }, to: { id: 3, name: 'Ex Employee' }, link: null };
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    window.Swal.fire = async (o) => { shown.push(o.html || ''); host.innerHTML = o.html || ''; if (o.didOpen) o.didOpen(); return {}; };
    window.newTaskDialog(task);
    await flush(10);
    expect(optionIds(shown[shown.length - 1])).toEqual([9, 11, 3, 12]);
    expect(window.document.getElementById('tkAssignTo').value).toBe('3');
    // a NEW task never offers the inactive user
    window.newTaskDialog();
    await flush(10);
    expect(optionIds(shown[shown.length - 1])).toEqual([9, 11, 12]);
    window.close();
  });

  test('the Assigned-by / Assigned-to list filters still list an inactive user (their open tasks must be findable)', async () => {
    const { window } = await bootTasks(USERS);
    for (const id of ['fBy', 'fTo']) {
      const vals = [...window.document.getElementById(id).options].map(o => Number(o.value)).filter(Boolean);
      expect([id, vals]).toEqual([id, [9, 11, 3, 12]]);
    }
    window.close();
  });
});
