// tests/caseySequenceEnroll.mysql.test.js
//
/**
 * A18.4b on REAL MySQL: the Casey sequence-enroll card's own SQL — the
 * already-enrolled predicate and the reads behind the preview — over rows
 * mysql2 really returns, through the real engine preview
 * (lib/sequenceEngine.previewEnrollmentSteps) and the real resolver.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a184b_test npx jest tests/caseySequenceEnroll.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql (live types,
 * keys, FKs — a clause referencing a table outside the list is dropped).
 * Drops run with FOREIGN_KEY_CHECKS off, in the before-hook AND the
 * after-hook, and take with them any sibling-built table whose FK points at
 * one of ours (sequence_step_log, contact_phones / contact_emails …): a
 * shared *_test DB is left with none of this suite's tables, so no sibling's
 * FK-checked DROP of contacts or sequence_enrollments can trip on a child
 * this suite left behind, and no leftover child can block this suite's
 * CREATE of its parent. Order-independence was run pairwise against the
 * sequence, send, workflow-start, opt-out, permission and normalizer twins.
 *
 * WHAT IS LOCKED
 *   - The card previews the PUBLISHED version of a template that has a
 *     differing DRAFT (the engine's version option on real rows; dropping it
 *     previews the draft and the card refuses — the mutation this was
 *     checked against), with the contact's name resolved by the real
 *     resolver JOIN and stored JSON timing read back as objects.
 *   - The already-enrolled predicate is the engine's own: an appointment- or
 *     e-sign-scoped enrollment, a cancelled one, and another contact's do NOT
 *     refuse; an active contact-scoped one does, by id — and the engine's
 *     own duplicate guard names the very same row (ALREADY_ENROLLED).
 *   - A18.4c, the reviewed trigger_data: the closed key set computed from a
 *     real published version's step rows and template condition ∪ its
 *     test_input / captured_input JSON columns (mysql2 returns them parsed);
 *     a {{trigger_data.X}}-dated step 1 refused without the payload and placed
 *     with it; an evidence-bound case_id (linked through case_relate) feeding
 *     a real {{cases.*}} resolution; an appointment-scoped enroll against a
 *     real appts row (firm-local naive appt_date → its UTC instant, the
 *     provider through the users JOIN) placing a before_appt_fixed step 1, and
 *     the engine enrolling the card's exact payload into that scope; the
 *     contact-mismatch refusal; and the scoped duplicate identity — a
 *     contact-scoped row never blocks an appointment-scoped card or the
 *     engine, nor the reverse, and the same scope refuses in both.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));
// What normally enrolls the template is read from nine other subsystems'
// tables; that read is A18.3's and is not this card's SQL.
jest.mock('../services/automationReadService', () => ({
  ...jest.requireActual('../services/automationReadService'),
  references: jest.fn(async () => []),
}));

const seq = require('../lib/sequenceEngine');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments', 'scheduled_jobs',
  'users', 'appts', 'cases', 'case_relate'];
const SIBLING_CHILDREN = ['sequence_step_log'];

// Line-based extraction (column COMMENTs may hold ';'). Constraint clauses
// that reference a table outside TABLES are dropped.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

d('the Casey sequence-enroll card on real MySQL (A18.4b)', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const EVIDENCE = [
    { id: 'q1', label: 'Template', rows: [{ sequence_template_id: 21 }] },
    { id: 'q2', label: 'Contact', rows: [{ contact_id: 1983, contact_name: 'Dana Client' }] },
  ];
  const draft = (over = {}) => ({ kind: 'sequence.enroll.v1', sequence_template_id: 21, contact_id: 1983,
    evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });

  // One connection: FOREIGN_KEY_CHECKS is a session setting.
  // Any sibling-built table whose FK points at one of ours is dropped too
  // (siblings rebuild their own tables): MySQL 8.4 refuses to create a parent
  // that a leftover child references before the parent's key exists — even
  // with FK checks off (contact_emails → contacts, after caseySendAction).
  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set([...SIBLING_CHILDREN, ...children.map((r) => r.t)]), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      // Built with FK checks off too: a sibling's leftover child (e.g.
      // contact_phones → contacts) would otherwise refuse the new parent.
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone)
             VALUES (1983, 'Dana Client', 'Dana', 'Client', '3135551234'), (1984, 'Other Person', 'Other', 'Person', '3135550000')`);
    // Template 21: published v1 (sms + task), unpublished draft v2 (one sms).
    await q('INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version) VALUES (21, ?, NULL, 1, 1, 2)', ['Lead Drip']);
    await q('INSERT INTO sequence_template_versions (template_id, version, name, published_at) VALUES (21, 1, ?, NOW()), (21, 2, ?, NULL)', ['Lead Drip', 'Lead Drip']);
    const step = (version, n, type, config, timing) => q(
      `INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing) VALUES (21, ?, ?, ?, ?, ?)`,
      [version, n, type, JSON.stringify(config), JSON.stringify(timing)]);
    await step(1, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}' } }, { type: 'immediate' });
    await step(1, 2, 'task', { function_name: 'create_task', params: { title: 'Call back', assigned_to: 7 } }, { type: 'delay', value: 2, unit: 'days' });
    await step(2, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'DRAFT TEXT' } }, { type: 'immediate' });
    process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '1';
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterAll(async () => {
    delete process.env.CASEY_SEQUENCE_ENROLL_ENABLED;
    jest.restoreAllMocks();
    if (pool) {
      const conn = await pool.getConnection();
      try { await dropAll(conn); } finally { conn.release(); }
      await pool.end();
    }
  });

  test('the card previews the PUBLISHED version, resolved for the contact — never the draft', async () => {
    const out = await normalizeActionDraft(pool, draft(), EVIDENCE);
    expect(out).toMatchObject({
      template: { sequence_template_id: 21, name: 'Lead Drip', version: 1, step_count: 2, has_draft: 1 },
      contact: { contact_id: 1983, contact_name: 'Dana Client' },
      first_step: 1, stall_step: null, send_steps: 1, active_enrollments: 0, expected: { current_version: 1 },
    });
    expect(out.steps.map((s) => s.step_number)).toEqual([1, 2]);
    expect(out.steps[0]).toMatchObject({ placement: 'places', to: '3135551234', from: '2484179800', message: 'Hi Dana' });
    expect(out.steps[0]).not.toHaveProperty('unresolved');
    // JSON timing comes back from mysql2 as an object and renders in words.
    expect(out.steps[1].timing_text).toBe('2 days after the previous step (or after enrollment for step 1)');
    expect(JSON.stringify(out)).not.toContain('DRAFT TEXT');
  });

  test('the already-enrolled predicate is the engine\'s: only an ACTIVE CONTACT-SCOPED row of this contact refuses', async () => {
    await q(`INSERT INTO sequence_enrollments (id, template_id, template_version, contact_id, appt_id, signing_request_id, trigger_data, status, current_step, total_steps)
             VALUES (701, 21, 1, 1983, 900, NULL, '{}', 'active', 1, 2),
                    (702, 21, 1, 1983, NULL, 55, '{}', 'active', 1, 2),
                    (703, 21, 1, 1983, NULL, NULL, '{}', 'cancelled', 1, 2),
                    (704, 21, 1, 1984, NULL, NULL, '{}', 'active', 1, 2)`);
    await expect(normalizeActionDraft(pool, draft(), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1', active_enrollments: 3 });
    await q(`INSERT INTO sequence_enrollments (id, template_id, template_version, contact_id, appt_id, signing_request_id, trigger_data, status, current_step, total_steps)
             VALUES (705, 21, 1, 1983, NULL, NULL, '{}', 'active', 1, 2)`);
    await expect(normalizeActionDraft(pool, draft(), EVIDENCE))
      .rejects.toThrow(/already enrolled in "Lead Drip" — active enrollment #705; nothing is proposed/);
    // The engine's own guard names the very same row.
    await expect(seq.enrollContactByTemplateId(pool, 1983, 21, {})).rejects.toMatchObject({ code: 'ALREADY_ENROLLED', enrollment_id: 705 });
  });
});

// ── A18.4c on real MySQL ────────────────────────────────────────────────────
d('the Casey sequence-enroll card with a reviewed trigger_data, on real MySQL (A18.4c)', () => {
  const { DateTime } = require('luxon');
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  // Appointment 950 is Dana's, 30 days out at 14:00 firm time (relative, so
  // the fixture never rots into the past); 951 is Other Person's.
  const AT = DateTime.now().setZone('America/Detroit').plus({ days: 30 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const LOCAL = AT.toFormat('yyyy-MM-dd HH:mm:ss');
  const UTC = AT.toUTC().toJSDate().toISOString();
  const FUTURE = AT.plus({ days: 3 }).toUTC().toJSDate().toISOString();
  const EVIDENCE = [
    { id: 'q1', label: 'Templates', rows: [{ sequence_template_id: 31 }, { sequence_template_id: 32 }, { sequence_template_id: 33 }] },
    { id: 'q2', label: 'Contact', rows: [{ contact_id: 1983, contact_name: 'Dana Client' }] },
    { id: 'q3', label: 'Appointments', rows: [{ appt_id: 950 }, { appt_id: 951 }] },
    { id: 'q4', label: 'Case', rows: [{ case_id: 'CS31' }] },
  ];
  const ALL_REFS = [[1, 1], [1, 2], [1, 3], [2, 1], [3, 1], [3, 2], [4, 1]].map(([qn, r]) => ({ query_id: `q${qn}`, row_number: r }));
  const draft = (tpl, trigger_data, over = {}) => ({ kind: 'sequence.enroll.v1', sequence_template_id: tpl, contact_id: 1983,
    evidence: ALL_REFS, ...(trigger_data === undefined ? {} : { trigger_data }), ...over });

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set([...SIBLING_CHILDREN, ...children.map((r) => r.t)]), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone)
             VALUES (1983, 'Dana Client', 'Dana', 'Client', '3135551234'), (1984, 'Other Person', 'Other', 'Person', '3135550000')`);
    await q(`INSERT INTO users (user, user_name, default_phone) VALUES (3, 'Stuart', '2485550003')`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_caption, case_type, case_status, case_rec)
             VALUES ('CS31', '26-31313', '26-31313-tjt', 'In re Client', 'Bankruptcy', 'Open', '')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (1, 'CS31', 1983, 'Primary')`);
    await q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_status, appt_date, appt_with, appt_gcal, appt_ref_id, appt_note, appt_platform)
             VALUES (950, 1983, 'CS31', '341 Meeting', 'Scheduled', ?, 3, '', '', '', 'Zoom'),
                    (951, 1984, '', 'Consult', 'Scheduled', ?, 3, '', '', '', 'Zoom')`, [LOCAL, LOCAL]);
    const tplRow = (id, name, extra = {}) => q(
      'INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version, test_input, captured_input) VALUES (?, ?, NULL, 1, 1, NULL, ?, ?)',
      [id, name, extra.test_input ? JSON.stringify(extra.test_input) : null, extra.captured_input ? JSON.stringify(extra.captured_input) : null]);
    const version = (id, cond = null) => q(
      'INSERT INTO sequence_template_versions (template_id, version, name, template_condition, published_at) VALUES (?, 1, ?, ?, NOW())',
      [id, `T${id}`, cond ? JSON.stringify(cond) : null]);
    const step = (tpl, n, type, config, timing) => q(
      `INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing) VALUES (?, 1, ?, ?, ?, ?)`,
      [tpl, n, type, JSON.stringify(config), JSON.stringify(timing)]);
    // 31: step 1 dated from {{trigger_data.court_date}}; {{cases.*}} in its text; a template condition reading trigger_data.kind.
    await tplRow(31, 'Court Drip', { test_input: { court_date: '2027-01-01T15:00:00Z', source: 'x' }, captured_input: { court_date: 'y', relay: 'z' } });
    await version(31, { query: 'SELECT 1 AS ok FROM contacts WHERE contact_id > 0 AND :k IS NOT NULL', params: { k: 'trigger_data.kind' }, assert: { ok: 1 } });
    await step(31, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Court {{trigger_data.court_date}} for {{cases.case_number_full}}' } },
      { type: 'delay', at: '{{trigger_data.court_date}}' });
    // 32: appointment-anchored — step 1 the day before (before_appt_fixed), provider via {{users.*}}.
    await tplRow(32, 'Appt Reminder');
    await version(32);
    await step(32, 1, 'sms', { function_name: 'send_sms', params: { from: '{{users.default_phone}}', to: '{{contacts.contact_phone}}', message: 'Tomorrow with {{users.user_name}}' } },
      { type: 'before_appt_fixed', hoursBack: 24 });
    await step(32, 2, 'task', { function_name: 'create_task', params: { title: 'Prep', assigned_to: 3 } }, { type: 'delay', value: 1, unit: 'hours' });
    // 33: places with no trigger data at all (immediate) — the contact-scoped side of the identity test;
    // it reads trigger_data.appt_id only through its captured sample.
    await tplRow(33, 'Plain Drip', { captured_input: { appt_id: 1, appt_time: 'x' } });
    await version(33);
    await step(33, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}' } }, { type: 'immediate' });
    process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '1';
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterAll(async () => {
    delete process.env.CASEY_SEQUENCE_ENROLL_ENABLED;
    jest.restoreAllMocks();
    if (pool) {
      const conn = await pool.getConnection();
      try { await dropAll(conn); } finally { conn.release(); }
      await pool.end();
    }
  });

  test('the no-payload card is the shipped envelope', async () => {
    const SHIPPED = ['draft_id', 'kind', 'status', 'template', 'contact', 'verdict', 'first_step', 'skipped_leading', 'stall_step',
      'placeholder_at_steps', 'send_steps', 'steps', 'steps_truncated', 'effects', 'starters', 'active_enrollments', 'expected', 'evidence'];
    for (const td of [undefined, {}]) {
      const card = await normalizeActionDraft(pool, draft(33, td), EVIDENCE);
      expect(Object.keys(card)).toEqual(SHIPPED);
      expect(card.steps[0]).toMatchObject({ placement: 'places', message: 'Hi Dana' });
    }
    const out = await normalizeActionDraft(pool, draft(32, undefined), EVIDENCE).catch((e) => e);
    // Template 32 is appointment-anchored: with no trigger data the walk refuses, exactly as shipped.
    expect(out.message).toMatch(/step 1's timing cannot be computed for an enrollment with no trigger data \(before_appt_fixed requires trigger_data\.appt_time\)/);
    const same = await normalizeActionDraft(pool, draft(32, {}), EVIDENCE).catch((e) => e);
    expect(same.message).toBe(out.message);
  });

  test('the closed key set comes from the real step rows, the template condition and both JSON samples', async () => {
    await expect(normalizeActionDraft(pool, draft(31, { court_date: FUTURE, zzz: 1 }), EVIDENCE))
      .rejects.toThrow(/key "zzz" is not read by template 31's published version — allowed: case_id, court_date, kind, relay, source \(/);
  });

  test('a {{trigger_data}}-dated step 1 places WITH the payload; an evidence-bound case_id feeds a real {{cases.*}} resolution', async () => {
    await expect(normalizeActionDraft(pool, draft(31, undefined), EVIDENCE)).rejects.toThrow(/step 1's timing cannot be computed/);
    const out = await normalizeActionDraft(pool, draft(31, { court_date: FUTURE, case_id: 'CS31', kind: 'a' }), EVIDENCE);
    expect(out.first_step).toBe(1);
    expect(out.verdict).toBe('would_proceed');
    expect(out.steps[0]).toMatchObject({ placement: 'places', message: `Court ${FUTURE} for 26-31313-tjt` });
    expect(out.steps[0]).not.toHaveProperty('unresolved');
    expect(out.trigger.case).toEqual({ case_id: 'CS31', label: '26-31313-tjt', caption: 'In re Client', relate_type: 'Primary' });
    // Without the case the {{cases.*}} placeholder stays unresolved on the card.
    const bare = await normalizeActionDraft(pool, draft(31, { court_date: FUTURE }), EVIDENCE);
    expect(bare.steps[0].unresolved).toEqual(['{{cases.case_number_full}}']);
    // A case the contact is not linked to is refused.
    await q('DELETE FROM case_relate WHERE case_relate_id = 1');
    try {
      await expect(normalizeActionDraft(pool, draft(31, { court_date: FUTURE, case_id: 'CS31' }), EVIDENCE)).rejects.toThrow(/Case CS31 is not linked to Dana Client/);
    } finally {
      await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (1, 'CS31', 1983, 'Primary')`);
    }
  });

  test('an appointment-scoped enroll against a real appts row: its own instant places step 1, its provider resolves, and the engine enrolls the payload into that scope', async () => {
    const payload = { appt_id: 950, appt_time: UTC, appt_with: 3 };
    const out = await normalizeActionDraft(pool, draft(32, payload), EVIDENCE);
    expect(out.first_step).toBe(1);
    expect(out.steps[0]).toMatchObject({ placement: 'places', from: '2485550003', message: 'Tomorrow with Stuart' });
    expect(out.steps[0].when_text).toMatch(/2:00 PM firm time$/);
    expect(out.trigger).toMatchObject({ scope: 'appointment',
      appointment: { appt_id: 950, appt_type: '341 Meeting', status: 'Scheduled', past: 0, provider: { user_id: 3, name: 'Stuart' }, case_id: 'CS31' } });
    // A wrong instant (the naive firm-local text read as UTC — the pool-timezone trap) is refused with the right one.
    await expect(normalizeActionDraft(pool, draft(32, { ...payload, appt_time: `${LOCAL.replace(' ', 'T')}Z` }), EVIDENCE))
      .rejects.toThrow(new RegExp(`is not appointment #950's time — send "${UTC.replace(/[.]/g, '\\.')}"`));
    // The engine, handed the card's exact payload, enrolls into the appointment scope and schedules step 1.
    const r = await seq.enrollContactByTemplateId(pool, 1983, 32, out.payload.trigger_data);
    const [row] = await q('SELECT appt_id, signing_request_id, status, trigger_data FROM sequence_enrollments WHERE id = ?', [r.enrollmentId]);
    expect(row).toMatchObject({ appt_id: 950, signing_request_id: null, status: 'active' });
    expect(row.trigger_data).toEqual(payload);
    expect(new Date(r.firstJobScheduledAt).getTime()).toBe(Date.parse(UTC) - 24 * 3600e3);
    await q('DELETE FROM scheduled_jobs'); await q('DELETE FROM sequence_enrollments');
  });

  test('another contact\'s appointment is refused with both named', async () => {
    await expect(normalizeActionDraft(pool, draft(32, { appt_id: 951, appt_time: UTC }), EVIDENCE))
      .rejects.toThrow(/^Appointment #951 belongs to Other Person \(contact 1984\), not to Dana Client \(contact 1983\)/);
  });

  test('the duplicate identity is scoped — card and engine agree: contact-scoped and appointment-scoped rows never block each other; the same scope refuses', async () => {
    const payload = { appt_id: 950, appt_time: UTC };
    // A contact-scoped active row of template 32 …
    await q(`INSERT INTO sequence_enrollments (id, template_id, template_version, contact_id, appt_id, signing_request_id, trigger_data, status, current_step, total_steps)
             VALUES (801, 32, 1, 1983, NULL, NULL, '{}', 'active', 1, 2)`);
    // … does not block the appointment-scoped card, nor the engine.
    await expect(normalizeActionDraft(pool, draft(32, payload), EVIDENCE)).resolves.toMatchObject({ trigger: { scope: 'appointment' } });
    const r = await seq.enrollContactByTemplateId(pool, 1983, 32, payload);
    // Now the appointment-scoped row exists: the same scope refuses, by id, in both.
    await expect(normalizeActionDraft(pool, draft(32, payload), EVIDENCE))
      .rejects.toThrow(new RegExp(`already enrolled in "Appt Reminder" for appointment #950 — active enrollment #${r.enrollmentId}; nothing is proposed`));
    await expect(seq.enrollContactByTemplateId(pool, 1983, 32, payload)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED', enrollment_id: r.enrollmentId });
    await q('DELETE FROM scheduled_jobs'); await q('DELETE FROM sequence_enrollments');
    // The reverse, on template 33: an ACTIVE appointment-scoped row does not block the contact-scoped card or the
    // engine's contact-scoped enroll …
    await q(`INSERT INTO sequence_enrollments (id, template_id, template_version, contact_id, appt_id, signing_request_id, trigger_data, status, current_step, total_steps)
             VALUES (802, 33, 1, 1983, 950, NULL, '{"appt_id":950}', 'active', 1, 1)`);
    await expect(normalizeActionDraft(pool, draft(33, undefined), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
    const plain = await seq.enrollContactByTemplateId(pool, 1983, 33, {});
    // … and once the contact-scoped row exists, the contact-scoped card refuses it by id while the appointment one
    // of the same template is still refused only by its own row (802).
    await expect(normalizeActionDraft(pool, draft(33, undefined), EVIDENCE))
      .rejects.toThrow(new RegExp(`already enrolled in "Plain Drip" — active enrollment #${plain.enrollmentId}; nothing is proposed`));
    await expect(normalizeActionDraft(pool, draft(33, { appt_id: 950 }), EVIDENCE))
      .rejects.toThrow(/already enrolled in "Plain Drip" for appointment #950 — active enrollment #802;/);
    await q('DELETE FROM scheduled_jobs'); await q('DELETE FROM sequence_enrollments');
  });
});
