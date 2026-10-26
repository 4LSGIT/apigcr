// tests/caseySendAction.mysql.test.js
//
/**
 * Ask Casey A14 on REAL MySQL: every statement the direct-send normalizer
 * issues — the contact consent read (contact_*_optout, tinyint), the
 * subrecord reloads, resolverService's contacts⋈cases JOIN for placeholders,
 * the case-link predicate, the explicit-grant read, and the channel-access
 * SQL it reaches through mailboxService / phoneCommsService /
 * mailboxSendService. Nothing is mocked; nothing can send (the normalizer
 * loads no route, adapter or transport).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3361/yc_a14send_test npx jest tests/caseySendAction.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql. Never point
 * it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'contact_phones', 'contact_emails', 'cases', 'case_relate',
  'channel_grants', 'phone_lines', 'mailboxes', 'email_credentials'];

// Line-based extraction (column COMMENTs may hold ';'); constraint clauses
// naming a table outside TABLES are dropped — this suite tests predicates.
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

d('A14 direct sends: the normalizer\'s SQL on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const EVID = [{ id: 'q1', purpose: 'Client', rows: [{ contact_id: 1309, phone_id: 12, email_id: 13, case_id: 'CASEA14' }] }];
  const CITE = [{ query_id: 'q1', row_number: 1 }];
  const RENA = 22;
  const norm = (v, user = RENA) => normalizeActionDraft(pool, { evidence: CITE, ...v }, EVID, { currentUserId: user });
  const sms = (over = {}) => ({ kind: 'sms.send.v1', contact_id: 1309, phone_id: 12, line_id: 3,
    message: 'Hi {{contacts.contact_fname}}, case {{cases.case_number_full}}', case_id: 'CASEA14', ...over });
  const email = (over = {}) => ({ kind: 'email.send.v1', contact_id: 1309, email_id: 13, mailbox_id: 5,
    subject: 'Case {{cases.case_number}}', body: 'Dear {{contacts.contact_fname|upper}}', case_id: 'CASEA14', ...over });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);

    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, roles)
             VALUES (22, 'rena', 'Rena', 'R', 'G', 'RG', 'authorized', 1, 'staff'), (6, 'it', 'Fred', 'F', 'R', 'FR', 'authorized', 1, 'it,admin,su')`);
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_ssn, contact_sms_optout, contact_email_optout)
             VALUES (1309, 'Pat One', 'Pat', 'One', '123-45-6789', 0, 0)`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, label, is_primary, sms_optout) VALUES (12, 1309, '3135550001', 'Mobile', 1, 0)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout) VALUES (13, 1309, 'pat@example.com', 'Personal', 1, 0)`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full) VALUES ('CASEA14', '26-40001', '2:26-bk-40001')`);
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES ('CASEA14', 1309, 'Primary')`);
    await q(`INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id)
             VALUES (3, '2489655355', 'quo', 'Rena', 1, 1), (6, '2484179800', 'quo', 'office', 1, 1), (7, '2480000007', 'quo', 'retired', 0, 1)`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name)
             VALUES (16, 'rena@4lsg.com', 'h', 465, 'u', 'ENCv1:x', 'smtp', 'Rena')`);
    await q(`INSERT INTO mailboxes (id, address, domain, display_name, active, send_credential_id) VALUES
             (5, 'rena@4lsg.com', '4lsg.com', 'Rena', 1, 16), (8, 'nosend@4lsg.com', '4lsg.com', NULL, 1, NULL)`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage) VALUES
             (22, 'phone_line', 3, 1, 1, 0), (22, 'phone_line', 7, 1, 1, 0), (22, 'phone_line', 6, 1, 0, 0),
             (22, 'mailbox', 5, 1, 1, 0), (22, 'mailbox', 8, 1, 1, 0)`);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('the resolver JOIN, the case link and the consent read run on the engine; the card carries resolved text', async () => {
    const dsms = await norm(sms());
    expect(dsms).toMatchObject({
      message: 'Hi Pat, case 2:26-bk-40001', case: { case_id: 'CASEA14', label: '2:26-bk-40001' },
      recipient: { phone: '3135550001', is_primary: true }, sender: { line_id: 3, number: '2489655355' },
    });
    expect(dsms.recipient.expected_updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    const demail = await norm(email());
    expect(demail).toMatchObject({ subject: 'Case 26-40001', body: 'Dear PAT', sender: { mailbox_id: 5, address: 'rena@4lsg.com' } });
    expect((await norm(sms({ message: 'SSN {{contacts.contact_ssn}}' }))).ssn_warning).toBe(true);
  });

  test('consent: tinyint opt-outs on the row and on the contact refuse on the engine', async () => {
    await q('UPDATE contact_phones SET sms_optout = 1 WHERE id = 12');
    await expect(norm(sms())).rejects.toThrow(/opted out of SMS/);
    await q('UPDATE contact_phones SET sms_optout = 0 WHERE id = 12');
    await q('UPDATE contacts SET contact_email_optout = 1 WHERE contact_id = 1309');
    await expect(norm(email())).rejects.toThrow(/opted out of email/);
    await expect(norm(sms())).resolves.toMatchObject({ kind: 'sms.send.v1' });
    await q('UPDATE contacts SET contact_email_optout = 0 WHERE contact_id = 1309');
  });

  test('an ended row and an unlinked case refuse', async () => {
    await q("UPDATE contact_phones SET end_date = '2026-10-01' WHERE id = 12");
    await expect(norm(sms())).rejects.toThrow(/has ended/);
    await q('UPDATE contact_phones SET end_date = NULL WHERE id = 12');
    await q("UPDATE case_relate SET case_relate_client_id = 999 WHERE case_relate_case_id = 'CASEA14'");
    await expect(norm(sms())).rejects.toThrow(/not linked to the recipient/);
    await q("UPDATE case_relate SET case_relate_client_id = 1309 WHERE case_relate_case_id = 'CASEA14'");
  });

  test('sender predicates: a read-only grant, an inactive line and a box with no send credential refuse; omitted = the only send grant', async () => {
    await expect(norm(sms({ line_id: 6 }))).rejects.toThrow(/cannot send from phone line 6/);
    await expect(norm(sms({ line_id: 7 }))).rejects.toThrow(/inactive/);
    // Line 7 is granted but inactive, so line 3 is the ONLY active explicit grant.
    expect((await norm(sms({ line_id: undefined }))).sender).toMatchObject({ line_id: 3, defaulted: true });
    await expect(norm(email({ mailbox_id: 8 }))).rejects.toThrow(/Mailbox 8 cannot be used: Read-only: this mailbox has no send credential/);
    // Mailbox 8 is granted but cannot send, so 5 is the only sendable explicit grant.
    expect((await norm(email({ mailbox_id: undefined }))).sender).toMatchObject({ mailbox_id: 5, defaulted: true });
    // An SU reaches every line through the bypass, but the DEFAULT reads only explicit grants (none here).
    await expect(norm(sms({ line_id: undefined }), 6)).rejects.toThrow(/line_id is required — this user can send from: #3 Rena/);
  });
});
