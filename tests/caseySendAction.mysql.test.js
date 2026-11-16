// tests/caseySendAction.mysql.test.js
//
/**
 * Ask Casey A14 on REAL MySQL: every statement the direct-send normalizer
 * issues — the consent read (optoutService, YisraMail P1: the row's tinyint
 * cache flag OR comm_consent_state, plus the version), the subrecord reloads, resolverService's contacts⋈cases JOIN for placeholders,
 * the case predicate (EXISTS link to the recipient), the explicit-grant read,
 * the channel-access SQL it reaches through mailboxService / phoneCommsService /
 * mailboxSendService, and (A14X) the cc / bcc reloads and the hub's own
 * replyDefaults — loadParent on mail_messages, the From/To pick over the
 * caller's identities — and (A14Y) the hub's own loadAttachments over the
 * `documents` registry (status enum, a NULL size, bigint sizes against the
 * hub's caps). Nothing is mocked; nothing can send (the normalizer loads no
 * route, adapter or transport).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3361/yc_a14send_test npx jest tests/caseySendAction.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql, plus the P1
 * consent tables from their migration file (tests/helpers/consentSchema.js).
 * Never point it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { normalizeActionDraft } = require('../services/assistantService');
const { buildConsentTables } = require('./helpers/consentSchema');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'contact_phones', 'contact_emails', 'cases', 'case_relate',
  'channel_grants', 'phone_lines', 'mailboxes', 'email_credentials', 'mail_messages', 'documents'];
const MiB = 1024 * 1024;

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
  const EVID = [{ id: 'q1', purpose: 'Client', rows: [{ contact_id: 1309, phone_id: 12, email_id: 13, case_id: 'CASEA14' },
    { contact_id: 1309, email_id: 14 }, { contact_id: 1400, email_id: 15 }, { case_id: 'CASEB' }, { case_id: 'CASEX' }] },
  { id: 'q2', kind: 'mail.message', purpose: 'Mail', rows: [501, 502, 503, 504].map((id) => ({ row_type: 'message', mail_message_id: id })) },
  // A14Y: a documents read — rows 1..7 the registry rows seeded below, row 8 an id that does not exist.
  { id: 'q4', kind: 'sql.read', purpose: 'Documents', rows: [1, 2, 3, 4, 5, 6, 7, 999].map((document_id) => ({ document_id })) }];
  const CITE = [{ query_id: 'q1', row_number: 1 }];
  const ROW = (n, q = 'q1') => ({ query_id: q, row_number: n });
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
    await buildConsentTables(q);

    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, roles)
             VALUES (22, 'rena', 'Rena', 'R', 'G', 'RG', 'authorized', 1, 'staff'), (6, 'it', 'Fred', 'F', 'R', 'FR', 'authorized', 1, 'it,admin,su')`);
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_ssn)
             VALUES (1309, 'Pat One', 'Pat', 'One', '123-45-6789'), (1400, 'Other Person', 'Other', 'Person', '')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, label, is_primary, sms_optout) VALUES (12, 1309, '3135550001', 'Mobile', 1, 0)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, label, is_primary, email_optout) VALUES
             (13, 1309, 'pat@example.com', 'Personal', 1, 0), (14, 1309, 'pat.work@example.com', 'Work', 0, 0), (15, 1400, 'other@example.com', 'Personal', 1, 0)`);
    // CASEB exists and is nobody's case; CASEX does not exist.
    await q(`INSERT INTO cases (case_id, case_number, case_number_full) VALUES ('CASEA14', '26-40001', '2:26-bk-40001'), ('CASEB', '26-40002', '2:26-bk-40002')`);
    await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES ('CASEA14', 1309, 'Primary')`);
    await q(`INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id)
             VALUES (3, '2489655355', 'quo', 'Rena', 1, 1), (6, '2484179800', 'quo', 'office', 1, 1), (7, '2480000007', 'quo', 'retired', 0, 1)`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name)
             VALUES (16, 'rena@4lsg.com', 'h', 465, 'u', 'ENCv1:x', 'smtp', 'Rena')`);
    // Mailbox 9 is nobody's here (no grant for Rena): a message in it is unreadable to her.
    await q(`INSERT INTO mailboxes (id, address, domain, display_name, active, send_credential_id) VALUES
             (5, 'rena@4lsg.com', '4lsg.com', 'Rena', 1, 16), (8, 'nosend@4lsg.com', '4lsg.com', NULL, 1, NULL), (9, 'stuart@4lsg.com', '4lsg.com', NULL, 1, NULL)`);
    await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage) VALUES
             (22, 'phone_line', 3, 1, 1, 0), (22, 'phone_line', 7, 1, 1, 0), (22, 'phone_line', 6, 1, 0, 0),
             (22, 'mailbox', 5, 1, 1, 0), (22, 'mailbox', 8, 1, 1, 0)`);
    // Stored messages: 501 from Pat in Rena's box; 502 from Pat in the read-only box; 503 in the box Rena cannot read; 504 from a stranger.
    const MSG = (id, mailbox, from, to) => q(`INSERT INTO mail_messages (id, mailbox_id, folder, uid, message_id, thread_key, from_addr, to_addrs, subject, date, body_text, ingested_at)
             VALUES (${id}, ${mailbox}, 'INBOX', ${id}, 'm${id}@x.test', 'm${id}@x.test', ?, ?, 'Hello ${id}', '2026-10-26 10:00:00', 'text ${id}', '2026-10-26 10:01:00')`, [from, to]);
    await MSG(501, 5, 'Pat One <pat@example.com>', 'rena@4lsg.com');
    await MSG(502, 8, 'pat@example.com', 'nosend@4lsg.com');
    await MSG(503, 9, 'Pat One <pat@example.com>', 'stuart@4lsg.com');
    await MSG(504, 5, 'Trustee <trustee@court.test>', 'rena@4lsg.com');
    // documents: 1 a 1 MB pdf; 2 a 14 MB pdf; 3 deleted; 4 size unknown (NULL); 5 over the per-file cap; 6 a 2 MB docx; 7 reported missing.
    await q(`INSERT INTO documents (id, source, external_id, name, path, ext, size, status) VALUES
             (1, 'dropbox', 'id:doc1', 'Petition.pdf', '/c/Petition.pdf', 'pdf', ${MiB}, 'active'),
             (2, 'dropbox', 'id:doc2', 'Big.pdf', '/c/Big.pdf', 'pdf', ${14 * MiB}, 'active'),
             (3, 'dropbox', 'id:doc3', 'Gone.pdf', '/c/Gone.pdf', 'pdf', 1024, 'deleted'),
             (4, 'dropbox', 'id:doc4', 'Unknown.bin', '/c/Unknown.bin', 'bin', NULL, 'active'),
             (5, 'dropbox', 'id:doc5', 'Huge.zip', '/c/Huge.zip', 'zip', ${16 * MiB}, 'active'),
             (6, 'dropbox', 'id:doc6', 'Letter.docx', '/c/Letter.docx', 'docx', ${2 * MiB}, 'active'),
             (7, 'dropbox', 'id:doc7', 'Missing.pdf', '/c/Missing.pdf', 'pdf', 2048, 'missing')`);
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

  test('consent: the row\'s tinyint cache flag is read on the engine, per channel, into recipient.opted_out (ruling 17); email is marketing-only (D18)', async () => {
    await expect(norm(sms())).resolves.toMatchObject({ recipient: { opted_out: false, consent_version: '0' } });
    await q('UPDATE contact_phones SET sms_optout = 1 WHERE id = 12');
    await expect(norm(sms())).resolves.toMatchObject({ kind: 'sms.send.v1', recipient: { opted_out: true } });
    await expect(norm(email())).resolves.toMatchObject({ recipient: { opted_out: false } });
    await q('UPDATE contact_phones SET sms_optout = 0 WHERE id = 12');
    await q('UPDATE contact_emails SET email_optout = 1 WHERE id = 13');
    // D18: an email opt-out covers marketing only — a direct email is operational.
    await expect(norm(email())).resolves.toMatchObject({ kind: 'email.send.v1', recipient: { opted_out: false } });
    await expect(norm(sms())).resolves.toMatchObject({ kind: 'sms.send.v1', recipient: { opted_out: false } });
    await q('UPDATE contact_emails SET email_optout = 0 WHERE id = 13');
  });

  test('consent (YisraMail P1): the number\'s comm_consent_state row alone marks the draft and stamps consent_version; an email state moves only the version', async () => {
    await q(`INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at) VALUES
             ('sms', '3135550001', 'all', 'opted_out', '2026-10-01 10:00:00.000', 41, NOW(3)),
             ('email', 'pat@example.com', 'marketing', 'opted_out', '2026-10-01 10:00:00.000', 7, NOW(3))`);
    try {
      await expect(norm(sms())).resolves.toMatchObject({ recipient: { phone_id: 12, opted_out: true, consent_version: '41' } });
      await expect(norm(email())).resolves.toMatchObject({ recipient: { email_id: 13, opted_out: false, consent_version: '7' } });
      await q("UPDATE comm_consent_state SET state = 'opted_in', last_event_id = 42 WHERE channel = 'sms'");
      await expect(norm(sms())).resolves.toMatchObject({ recipient: { opted_out: false, consent_version: '42' } });
    } finally {
      await q('DELETE FROM comm_consent_state');
    }
  });

  test('an ended row and an unlinked case refuse an SMS; the email Case field takes an existing case the recipient is not on (flagged) and refuses a missing one', async () => {
    await q("UPDATE contact_phones SET end_date = '2026-10-01' WHERE id = 12");
    await expect(norm(sms())).rejects.toThrow(/has ended/);
    await q('UPDATE contact_phones SET end_date = NULL WHERE id = 12');
    await q("UPDATE case_relate SET case_relate_client_id = 999 WHERE case_relate_case_id = 'CASEA14'");
    await expect(norm(sms())).rejects.toThrow(/not linked to the recipient/);
    // The EXISTS predicate on the engine: the same case, unlinked, is still filed by an email — linked_to_recipient false.
    await expect(norm(email())).resolves.toMatchObject({ case: { case_id: 'CASEA14', label: '2:26-bk-40001', linked_to_recipient: false } });
    await q("UPDATE case_relate SET case_relate_client_id = 1309 WHERE case_relate_case_id = 'CASEA14'");
    await expect(norm(email())).resolves.toMatchObject({ case: { case_id: 'CASEA14', linked_to_recipient: true } });
    await expect(norm(email({ case_id: 'CASEB', subject: 'Hi', evidence: [ROW(1), ROW(4)] }))).resolves.toMatchObject({ case: { case_id: 'CASEB', label: '2:26-bk-40002', linked_to_recipient: false } });
    await expect(norm(sms({ case_id: 'CASEB', message: 'Hi', evidence: [ROW(1), ROW(4)] }))).rejects.toThrow(/not linked to the recipient/);
    await expect(norm(email({ case_id: 'CASEX', subject: 'Hi', evidence: [ROW(1), ROW(5)] }))).rejects.toThrow(/Send case is unavailable/);
  });

  test('A14X cc / bcc: every copied row is reloaded on the engine — active, on its contact, its consent version read; an ended copy refuses by role', async () => {
    const cc = (over = {}) => email({ subject: 'Hi', cc: [{ contact_id: 1309, email_id: 14 }], bcc: [{ contact_id: 1400, email_id: 15 }], evidence: [ROW(1), ROW(2), ROW(3)], ...over });
    const d = await norm(cc());
    expect(d.cc).toEqual([expect.objectContaining({ contact_id: 1309, contact_name: 'Pat One', email_id: 14, email: 'pat.work@example.com', label: 'Work', is_primary: false, opted_out: false, consent_version: '0' })]);
    expect(d.bcc).toEqual([expect.objectContaining({ contact_id: 1400, contact_name: 'Other Person', email_id: 15, email: 'other@example.com', label: 'Personal', is_primary: true, opted_out: false, consent_version: '0' })]);
    expect(d.recipients).toBe(3);
    await q(`INSERT INTO comm_consent_state (channel, destination, scope, state, occurred_at, last_event_id, updated_at) VALUES
             ('email', 'other@example.com', 'marketing', 'opted_out', '2026-10-01 10:00:00.000', 9, NOW(3))`);
    try {
      await expect(norm(cc())).resolves.toMatchObject({ bcc: [{ opted_out: false, consent_version: '9' }], cc: [{ consent_version: '0' }] });
    } finally { await q('DELETE FROM comm_consent_state'); }
    await q("UPDATE contact_emails SET end_date = '2026-10-01' WHERE id = 14");
    await expect(norm(cc())).rejects.toThrow(/Send cc recipient email_id 14 has ended/);
    await q('UPDATE contact_emails SET end_date = NULL WHERE id = 14');
    // (uk_one_active_primary: a contact has one active primary — the moved row must drop the flag.)
    await q('UPDATE contact_emails SET contact_id = 1309, is_primary = 0 WHERE id = 15');
    await expect(norm(cc())).rejects.toThrow(/Send bcc recipient email_id 15 is not on contact 1400/);
    await q('UPDATE contact_emails SET contact_id = 1400, is_primary = 1 WHERE id = 15');
  });

  test('A14X reply: the hub\'s replyDefaults runs on the engine — the box the mail was sent to, "Re: …", the sender as To; unreadable, re-homed and stranger mail refuse', async () => {
    const reply = (fk, over = {}) => email({ subject: undefined, case_id: undefined, mailbox_id: undefined, in_reply_to_message_fk: fk, evidence: [ROW(1), ROW([501, 502, 503, 504].indexOf(fk) + 1, 'q2')], ...over });
    const d = await norm(reply(501));
    expect(d).toMatchObject({ reply: { mail_message_id: 501, mailbox_id: 5, subject: 'Re: Hello 501', quote_original: true, quote_chars: 'text 501'.length },
      subject: 'Re: Hello 501', subject_defaulted: true, sender: { mailbox_id: 5, address: 'rena@4lsg.com', defaulted: true }, recipient: { email: 'pat@example.com' } });
    expect(d.reply.quote_header).toMatch(/^On .*2026.*, Pat One <pat@example.com> wrote:$/);
    // The hub's own fallback: mail in a box Rena reads but cannot send from is answered from her only sendable grant.
    await expect(norm(reply(502))).resolves.toMatchObject({ reply: { mail_message_id: 502, mailbox_id: 5 }, sender: { mailbox_id: 5 } });
    // No read grant on mailbox 9: loadParent's 404 (the alias-slice read ran too, and found nothing).
    await expect(norm(reply(503))).rejects.toThrow(/cannot reply to message #503: it does not exist, or it is in a mailbox the user holds no read grant on/);
    // A stranger's mail: the hub answers the sender, who is not the cited row.
    await expect(norm(reply(504))).rejects.toThrow(/goes to trustee@court.test, not to the cited email row \(pat@example.com\)/);
    // A named box: kept when the hub would use it; refused with the hub's reason when the user cannot send as it.
    await expect(norm(reply(501, { mailbox_id: 5 }))).resolves.toMatchObject({ sender: { mailbox_id: 5, defaulted: false } });
    await expect(norm(reply(501, { mailbox_id: 8 }))).rejects.toThrow(/Mailbox 8 cannot be used: Read-only/);
    // The SU reaches every box through the bypass; with no grant rows the hub's pick is the message's own box.
    await expect(norm(reply(501), 6)).resolves.toMatchObject({ reply: { mailbox_id: 5 } });
  });

  test('A14Y attachments: the hub\'s own loadAttachments runs on the engine — the enum status, a NULL size, bigint sizes against the caps; the card carries numbers, the hub\'s words refuse', async () => {
    const DOC = (n) => ROW(n, 'q4');
    const files = (attachments, rows) => email({ subject: 'Hi', case_id: undefined, attachments, evidence: [ROW(1), ...rows.map(DOC)] });
    const d = await norm(files([{ document_id: 1 }, { document_id: 6 }, { document_id: 1 }], [1, 6]));
    expect(d.attachments).toEqual([{ document_id: 1, name: 'Petition.pdf', size: MiB }, { document_id: 6, name: 'Letter.docx', size: 2 * MiB }]);
    expect(d).toMatchObject({ attachments_total_bytes: 3 * MiB, attachment_duplicates_dropped: 1 });
    expect(typeof d.attachments[0].size).toBe('number');   // bigint unsigned → a JS number on the card, never a string
    await expect(norm(files([{ document_id: 999 }], [8]))).rejects.toThrow(/^Email send attachments: document #999 is not a registered document$/);
    await expect(norm(files([{ document_id: 3 }], [3]))).rejects.toThrow(/^Email send attachments: "Gone.pdf" has been deleted from storage — remove it to send$/);
    await expect(norm(files([{ document_id: 7 }], [7]))).rejects.toThrow(/^Email send attachments: "Missing.pdf" has been reported missing — remove it to send$/);
    await expect(norm(files([{ document_id: 4 }], [4]))).rejects.toThrow(/^Email send attachments: the size of "Unknown.bin" is not known, so it cannot be attached \(re-register it in Documents\)$/);
    await expect(norm(files([{ document_id: 5 }], [5]))).rejects.toThrow(/^Email send attachments: "Huge.zip" is 16 MB — at most 15 MB per file$/);
    await expect(norm(files([{ document_id: 2 }, { document_id: 6 }], [2, 6]))).rejects.toThrow(/^Email send attachments: together they come to more than 15 MB$/);
    // Exactly at the per-file cap is allowed; one byte over is not (the engine's bigint compared to the hub's constant).
    await q(`UPDATE documents SET size = ${15 * MiB} WHERE id = 2`);
    await expect(norm(files([{ document_id: 2 }], [2]))).resolves.toMatchObject({ attachments: [{ document_id: 2, size: 15 * MiB }] });
    await q(`UPDATE documents SET size = ${15 * MiB + 1} WHERE id = 2`);
    await expect(norm(files([{ document_id: 2 }], [2]))).rejects.toThrow(/"Big.pdf" is 15\.0 MB — at most 15 MB per file/);
    await q(`UPDATE documents SET size = ${14 * MiB} WHERE id = 2`);
    // A file that becomes deleted between the read and the card: the next proposal refuses it.
    await q("UPDATE documents SET status = 'deleted' WHERE id = 6");
    await expect(norm(files([{ document_id: 6 }], [6]))).rejects.toThrow(/"Letter.docx" has been deleted from storage/);
    await q("UPDATE documents SET status = 'active' WHERE id = 6");
    // A schedule carries no SQL of its own: the files and the window on one card.
    const at = new Date(Date.now() + 3600_000).toISOString();
    const s = await norm(email({ subject: 'Hi', case_id: undefined, attachments: [{ document_id: 1 }], send_at: at, evidence: [ROW(1), DOC(1)] }));
    expect(s).toMatchObject({ attachments: [{ document_id: 1 }], schedule: { send_at: at, firm_zone: 'America/Detroit', min_ahead_ms: 120000, max_ahead_ms: 2592000000 } });
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
