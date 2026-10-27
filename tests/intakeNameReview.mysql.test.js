// tests/intakeNameReview.mysql.test.js
//
/**
 * Intake NAME REVIEW (services/intakeService.js, Fred's ruling 2026-10-28) on a
 * REAL engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_intake_test \
 *     npx jest tests/intakeNameReview.mysql.test.js --runInBand
 * The database name must end in _test (never point it at 3306 — on a dev
 * machine that IS production). The suite DROPs and recreates its tables FROM
 * ref/database.sql — live types, the real contacts / tasks triggers — and runs
 * the real intakeContact, contactService, taskService and settings reads, the
 * internal function and the HTTP route on that engine. Stubbed: only the
 * outbound edges (alert, email, SMS, Google Contacts push, the domain-event
 * bus, the custom-field reconciler) and the route's auth middleware.
 *
 * THE BUG: a single phone/email match took intake's UPDATE branch and wrote
 * the payload's name — and DOB / SSN / address — over the matched contact. A
 * spouse's website lead on a shared phone renamed the other spouse.
 *
 * WHAT IS LOCKED
 *   - A different first/last name → the matched contact is BYTE-IDENTICAL
 *     afterwards (row and child rows); a review task carries the submitted
 *     name / phone / email / address and never the DOB or SSN; it goes to
 *     intake_review_assignee, else default_task_assignee — an ACTIVE user
 *     only; none → an error alert and no task; a repeat opens no second task.
 *   - The same name (case, accents, punctuation, spacing aside) → blanks
 *     filled, a value on file (name spelling, DOB, SSN, address) never
 *     overwritten, the new email added beside the old.
 *   - force_contact_id (a person chose the contact) → no task, the name still
 *     not overwritten.
 *   - The workflow function and the route both answer a conflict as
 *     action "updated" + name_conflict:true, so a created|updated branch
 *     (workflow 27's "contact ok?") carries the lead on.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

const mockAlerts = [];
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async (_db, a) => { mockAlerts.push(a); }) }));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({})) }));
jest.mock('../services/gContactsService', () => ({ pushContact: jest.fn(async () => {}) }));
jest.mock('../lib/domainEvents', () => {
  const actual = jest.requireActual('../lib/domainEvents');
  return { ...actual, emit: jest.fn() };   // the bus is an outbound edge; its helpers stay real
});
jest.mock('../services/fieldDefReconciler', () => {
  const actual = jest.requireActual('../services/fieldDefReconciler');
  return { ...actual, scheduleReconcile: jest.fn(), reconcile: jest.fn() };
});
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => next());

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const REPO = path.join(__dirname, '..');
const TABLES = ['users', 'app_settings', 'contacts', 'contact_phones', 'contact_emails',
  'contact_addresses', 'field_defs', 'tasks', 'log',
  'cases'];   // read by taskService.getTask's link join
const TRIGGER_TABLES = ['contacts', 'tasks'];

// CREATE TABLE + its ALTER blocks, line-based (COMMENTs contain ';').
function tableBlocks(lines, table) {
  const out = [];
  let cur = null;
  const start = new RegExp(`^(?:CREATE TABLE|ALTER TABLE) \`${table}\`[ (]*$`);
  for (const line of lines) {
    if (cur == null) { if (start.test(line)) cur = [line]; continue; }
    cur.push(line);
    if (/;\s*$/.test(line)) { out.push(cur.join('\n').replace(/;\s*$/, '')); cur = null; }
  }
  return out;
}
// DELIMITER $$ … DELIMITER ; blocks whose CREATE TRIGGER is ON `table`.
function triggerBlocks(lines, table) {
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (line.trim() === 'DELIMITER $$') { cur = []; continue; }
    if (cur && line.trim() === 'DELIMITER ;') {
      const sql = cur.join('\n').replace(/\$\$\s*$/, '').trim();
      if (new RegExp(`^CREATE TRIGGER \`\\w+\` (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON \`${table}\``).test(sql)) out.push(sql);
      cur = null; continue;
    }
    if (cur) cur.push(line);
  }
  return out;
}

d('intake name review (real engine)', () => {
  let pool;
  let intakeService;
  let intakeFns;
  let server;
  let base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const u = new URL(URL_);
    const dbName = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (u.port === '3306' || u.port === '') throw new Error('refusing port 3306 — on a dev machine that is production');
    pool = mysql.createPool({ uri: URL_, timezone: 'Z', connectionLimit: 4 });
    // As startup/db.js decorates the production pool.
    const { withTransaction } = require('../lib/withTransaction');
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);

    const lines = fs.readFileSync(path.join(REPO, 'ref/database.sql'), 'utf8').split('\n');
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = tableBlocks(lines, t);
      if (!blocks.length) throw new Error(`no DDL for ${t}`);
      for (const b of blocks) await q(b);
    }
    for (const t of TRIGGER_TABLES) {
      const trg = triggerBlocks(lines, t);
      if (!trg.length) throw new Error(`no triggers for ${t}`);
      for (const b of trg) await q(b);
    }

    intakeService = require('../services/intakeService');
    intakeFns = require('../lib/internal_functions/intake');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.intake'));
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  let JOHN;
  beforeEach(async () => {
    mockAlerts.length = 0;
    for (const t of ['users', 'app_settings', 'contacts', 'contact_phones', 'contact_emails',
      'contact_addresses', 'tasks', 'log']) await q(`DELETE FROM \`${t}\``);
    await q(`INSERT INTO users (user, user_name, user_auth, email) VALUES
      (22, 'Rena', 'authorized', 'rena@example.com'),
      (7,  'Gone', 'disabled',   'gone@example.com'),
      (9,  'Ben',  'authorized', 'ben@example.com')`);
    await q(`INSERT INTO app_settings (\`key\`, \`value\`) VALUES ('default_task_assignee', '22')`);
    const contactService = require('../services/contactService');
    const c = await contactService.createContact(pool, {
      fname: 'John', lname: 'Doe', phone: '3135550100', email: 'john@example.com',
      address: '1 Main St', city: 'Detroit', state: 'MI', zip: '48201',
    });
    await contactService.updateContact(pool, c.contact_id, { contact_ssn: '111-22-3333' });
    JOHN = c.contact_id;
  });

  const snapshot = async (cid) => ({
    contact: (await q('SELECT * FROM contacts WHERE contact_id = ?', [cid]))[0],
    phones:  await q('SELECT contact_id, phone, is_primary, end_date FROM contact_phones WHERE contact_id = ? ORDER BY id', [cid]),
    emails:  await q('SELECT contact_id, email, is_primary, end_date FROM contact_emails WHERE contact_id = ? ORDER BY id', [cid]),
  });
  const tasks = () => q('SELECT * FROM tasks ORDER BY task_id');
  const SPOUSE = {
    name: 'Jane Doe', phone: '(313) 555-0100', email: 'jane@example.com',
    contact_address: '9 Elm St', contact_city: 'Troy', contact_dob: '1980-04-05', contact_ssn: '999-88-7777',
  };

  test('a different name changes nothing and opens one review task with the submitted values', async () => {
    const before = await snapshot(JOHN);
    const r = await intakeService.intakeContact(pool, SPOUSE);
    expect(r).toMatchObject({ outcome: 'name_conflict', contact_id: JOHN, existing_name: 'John Doe', submitted_name: 'Jane Doe' });
    expect(await snapshot(JOHN)).toEqual(before);
    expect(await q('SELECT COUNT(*) n FROM contacts')).toEqual([{ n: 1 }]);

    const [t, ...rest] = await tasks();
    expect(rest).toEqual([]);
    expect(r.review_task_id).toBe(t.task_id);
    expect(t).toMatchObject({ task_to: 22, task_from: 0, task_source: 'intake_name_review', task_status: 'Pending',
      task_link_type: 'contact', task_link_id: String(JOHN) });
    expect(t.task_dedupe_key).toMatch(new RegExp(`^intake-name:${JOHN}:[0-9a-f]{16}$`));
    expect(t.task_title).toBe('Check contact match: "Jane Doe" → John Doe');
    expect(t.task_desc).toContain('matched contact #' + JOHN + ' (John Doe) by phone');
    for (const s of ['name: Jane Doe', 'phone: 3135550100', 'email: jane@example.com', 'address: 9 Elm St, Troy',
      'date of birth and SSN also supplied']) expect(t.task_desc).toContain(s);
    for (const secret of ['999-88-7777', '999887777', '1980-04-05', '111-22-3333']) expect(t.task_desc).not.toContain(secret);

    // a repeat (webhook retry / second submission) opens no second task
    const again = await intakeService.intakeContact(pool, { ...SPOUSE, name: 'JANE  doe' });
    expect(again.review_task_id).toBe(t.task_id);
    expect(await tasks()).toHaveLength(1);
    expect(mockAlerts).toEqual([]);
  });

  test('assignee: intake_review_assignee first, inactive users skipped, none → alert and no task', async () => {
    await q(`INSERT INTO app_settings (\`key\`, \`value\`) VALUES ('intake_review_assignee', '9')`);
    let r = await intakeService.intakeContact(pool, SPOUSE);
    expect((await tasks())[0].task_to).toBe(9);

    await q('DELETE FROM tasks');
    await q(`UPDATE app_settings SET value = '7' WHERE \`key\` = 'intake_review_assignee'`);   // disabled → fallback
    r = await intakeService.intakeContact(pool, SPOUSE);
    expect((await tasks())[0].task_to).toBe(22);

    await q('DELETE FROM tasks');
    await q(`UPDATE app_settings SET value = '' WHERE \`key\` = 'default_task_assignee'`);
    const before = await snapshot(JOHN);
    r = await intakeService.intakeContact(pool, SPOUSE);
    expect(r).toMatchObject({ outcome: 'name_conflict', review_task_id: null });
    expect(await tasks()).toEqual([]);
    expect(await snapshot(JOHN)).toEqual(before);
    expect(mockAlerts.map(a => [a.kind, a.severity])).toEqual([['intake_review_no_assignee', 'error']]);
  });

  test('the same name fills blanks and adds the email — never overwrites what is on file', async () => {
    const r = await intakeService.intakeContact(pool, {
      name: 'john  DOÉ', phone: '3135550100', email: 'jd@new.example.com',
      contact_address: '9 Elm St', contact_dob: '1975-01-02', contact_ssn: '999-88-7777',
    });
    expect(r).toMatchObject({ outcome: 'updated', contact_id: JOHN });
    const after = await snapshot(JOHN);
    expect(after.contact).toMatchObject({ contact_fname: 'John', contact_lname: 'Doe',
      contact_address: '1 Main St', contact_ssn: '111-22-3333' });
    expect(after.contact.contact_dob).toBeInstanceOf(Date);                        // was blank → filled
    expect(after.contact.contact_dob.toISOString().slice(0, 10)).toBe('1975-01-02');
    expect(after.emails.filter(e => e.end_date == null).map(e => e.email).sort())
      .toEqual(['jd@new.example.com', 'john@example.com']);                        // added, old kept
    expect(await tasks()).toEqual([]);
  });

  test('force_contact_id: a person chose the contact — no task, name still not overwritten', async () => {
    const r = await intakeService.intakeContact(pool, { ...SPOUSE, phone: '3135550100' }, { forceContactId: JOHN });
    expect(r).toMatchObject({ outcome: 'updated', contact_id: JOHN });
    const after = await snapshot(JOHN);
    expect(after.contact).toMatchObject({ contact_fname: 'John', contact_lname: 'Doe', contact_ssn: '111-22-3333' });
    expect(await tasks()).toEqual([]);
  });

  test('the workflow function and the route answer a conflict as "updated" + name_conflict', async () => {
    const out = await intakeFns.intake_contact({ name: 'Jane Doe', phone: '3135550100' }, pool);
    expect(out.output).toMatchObject({ action: 'updated', contact_id: JOHN, name_conflict: true,
      submitted_name: 'Jane Doe', contact_name: 'John Doe' });
    expect(out.output.review_task_id).toBeGreaterThan(0);

    const res = await fetch(`${base}/api/intake/contact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane Doe', phone: '3135550100' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'success', action: 'updated', id: JOHN, name_conflict: true,
      existing_name: 'John Doe', submitted_name: 'Jane Doe', review_task_id: out.output.review_task_id });
    expect(body.message).toMatch(/different name — not changed/);

    const plain = await intakeFns.intake_contact({ name: 'John Doe', phone: '3135550100' }, pool);
    expect(plain.output).toMatchObject({ action: 'updated', name_conflict: false, review_task_id: '' });
  });
});
