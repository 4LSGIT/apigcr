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
const TABLES = ['contacts', 'sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments', 'scheduled_jobs'];
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
