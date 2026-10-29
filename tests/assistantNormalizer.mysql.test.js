// tests/assistantNormalizer.mysql.test.js
//
/**
 * Ask Casey action normalizer SQL predicates on REAL MySQL.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_casey_test npx jest tests/assistantNormalizer.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates users,
 * contacts and contact_phones in it (only the columns the normalizer reads,
 * with the live types), plus the YisraMail P1 consent tables from their
 * migration file (a create card reads the number's consent).
 *
 * WHY (independent review 2026-10-21, finding 1): appt.create.v1 shipped with
 * `user_auth = 1` against a varchar holding 'authorized'. MySQL coerces the
 * string to 0, so no live provider ever matched and every create proposal was
 * refused — while the unit suite stayed green because it mocked the users
 * query. A mock cannot hold an engine's type coercion; this file runs the
 * normalizer's own SQL against the engine.
 *
 * WHAT IS LOCKED
 *   - Provider predicate: an authorized, appointment-hosting, non-system user
 *     resolves; disabled / non-host / user_type 0 users do not.
 *   - Phone create predicates: an active value on another contact is refused
 *     (no transfer); a stated start inside an ended ownership window is
 *     refused; an omitted start resolves to the day after the last window.
 *   - Why end_reason is capped at 40: under the production sql_mode a longer
 *     value is stored truncated (stored ≠ reviewed), and the normalizer refuses it.
 */
'use strict';

const mysql = require('mysql2/promise');
const svc = require('../services/assistantService');
const calendarTypeService = require('../services/calendarTypeService');
const { buildConsentTables } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

d('Ask Casey normalizer SQL on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const evidence = [{ id: 'q1', kind: 'sql.read', purpose: 'Contact', rows: [{ contact_id: 1309 }] }];
  const ref = [{ query_id: 'q1', row_number: 1 }];
  let resolveType;
  let getType;

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 2, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await q('DROP TABLE IF EXISTS users');
    await q('DROP TABLE IF EXISTS contacts');
    await q('DROP TABLE IF EXISTS contact_phones');
    await q(`CREATE TABLE users (
      user int NOT NULL PRIMARY KEY, user_name varchar(100) DEFAULT NULL,
      user_auth varchar(20) NOT NULL, user_type tinyint NOT NULL DEFAULT 1, does_appts tinyint NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE contacts (
      contact_id int NOT NULL PRIMARY KEY, contact_name varchar(255) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`CREATE TABLE contact_phones (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY, contact_id int NOT NULL, phone char(10) NOT NULL,
      label varchar(20) NOT NULL DEFAULT 'Other', is_primary tinyint NOT NULL DEFAULT 0,
      sms_optout tinyint NOT NULL DEFAULT 0, mms_capable tinyint NOT NULL DEFAULT 1, verified tinyint NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by int DEFAULT NULL, updated_by int DEFAULT NULL,
      start_date date DEFAULT NULL, end_date date DEFAULT NULL, end_reason varchar(40) DEFAULT NULL,
      notes text, updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    await q(`INSERT INTO users (user, user_name, user_auth, user_type, does_appts) VALUES
      (0, 'Automations', 'authorized', 0, 1), (1, 'Host', 'authorized', 1, 1),
      (2, 'Not a host', 'authorized', 1, 0), (3, 'Disabled host', 'disabled', 1, 1)`);
    await q("INSERT INTO contacts (contact_id, contact_name) VALUES (1309, 'Client'), (1400, 'Other client')");
    await buildConsentTables(q);
    resolveType = jest.spyOn(calendarTypeService, 'resolveForCreate').mockResolvedValue({ type_key: 'consult', kind: 'meeting' });
    getType = jest.spyOn(calendarTypeService, 'getType').mockResolvedValue({ type_key: 'consult', label: 'Consultation', kind: 'meeting', active: 1, singleton: 0 });
  });
  afterAll(async () => {
    if (resolveType) resolveType.mockRestore();
    if (getType) getType.mockRestore();
    if (pool) await pool.end();
  });

  const create = (apptWith) => svc.normalizeActionDraft(pool, {
    kind: 'appt.create.v1', contact_id: 1309, appt_type: 'Consultation', appt_length: 30, appt_platform: 'Telephone',
    appt_date: '2099-01-05 10:00', appt_with: apptWith, evidence: ref,
  }, evidence);

  test('appointment provider: only an authorized, hosting, non-system user resolves', async () => {
    await expect(create(1)).resolves.toMatchObject({ provider: { user_id: 1, label: 'Host' } });
    for (const id of [0, 2, 3]) await expect(create(id)).rejects.toThrow(/provider is (?:unavailable|invalid)/);
    // The shipped predicate, on the same rows: the engine matches nothing.
    expect(await q("SELECT user FROM users WHERE does_appts = 1 AND user_auth = 1")).toEqual([]);
  });

  test('phone create: no transfer, no overlap with an ended window, omitted start = day after the last window', async () => {
    await q('DELETE FROM contact_phones');
    await q("INSERT INTO contact_phones (contact_id, phone, start_date, end_date, end_reason) VALUES (1400, '2485550100', '2025-01-01', NULL, NULL)");
    const phone = (extra) => svc.normalizeActionDraft(pool, { kind: 'contact.phone.create.v1', contact_id: 1309, phone: '2485550100', evidence: ref, ...extra }, evidence);
    await expect(phone({})).rejects.toThrow(/already active on a contact/);
    await q("UPDATE contact_phones SET end_date = '2026-03-31', end_reason = 'ended'");
    await expect(phone({ start_date: '2026-03-15' })).rejects.toThrow(/overlaps existing phone ownership/);
    await expect(phone({})).resolves.toMatchObject({ fields: { phone: '2485550100', start_date: '2026-04-01', sms_optout: 0 } });
    // YisraMail P1: a number that already opted out shows the row the create will produce — Yes, inherited
    await q(`INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at)
             VALUES ('sms', '2485550100', 'all', 'opted_out', '2026-10-01 10:00:00.000', 1, NOW(3))`);
    try {
      await expect(phone({})).resolves.toMatchObject({ fields: { sms_optout: 1 }, consent_inherited: true });
    } finally { await q('DELETE FROM comm_consent_state'); }
  });

  test('end_reason: the engine truncates past 40 characters silently, so the normalizer refuses it', async () => {
    await q('DELETE FROM contact_phones');
    const [ins] = await pool.query("INSERT INTO contact_phones (contact_id, phone, start_date) VALUES (1309, '2485550199', '2026-01-01')");
    const long = 'Client says this number now belongs to her brother';
    await q('UPDATE contact_phones SET end_reason = ? WHERE id = ?', [long, ins.insertId]);
    const [[stored]] = await pool.query('SELECT end_reason FROM contact_phones WHERE id = ?', [ins.insertId]);
    expect(stored.end_reason).toBe(long.slice(0, 40));
    await q('UPDATE contact_phones SET end_reason = NULL WHERE id = ?', [ins.insertId]);
    const end = (reason) => svc.normalizeActionDraft(pool, { kind: 'contact.phone.end.v1', contact_id: 1309, phone_id: ins.insertId,
      end_date: '2026-10-20', end_reason: reason, evidence: [{ query_id: 'q1', row_number: 1 }] },
    [{ id: 'q1', kind: 'sql.read', purpose: 'Phone', rows: [{ contact_id: 1309, phone_id: ins.insertId }] }]);
    await expect(end(long)).rejects.toThrow(/exceeds 40 characters/);
  });
});
