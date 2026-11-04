// tests/caseySequenceEnrollEsign.mysql.test.js
//
/**
 * A18.4d on REAL MySQL: e-sign-scoped Casey enrollments, end to end — the
 * esign.requests read over rows mysql2 really returns, the normalizer's
 * signing-request binding, POST /sequences/enroll (real route, real engine,
 * real pool) writing signing_requests.seq_instance_id, and
 * esignService.applyStatus cancelling the chat-born enrollment through that
 * pointer when the document is signed.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a184d_esign_test npx jest tests/caseySequenceEnrollEsign.mysql.test.js --runInBand
 * Its OWN *_test database (the CLAUDE.md twin-family rule): it builds and
 * drops the tables below, cloned line-by-line from ref/database.sql (live
 * types, keys, FKs), and creates/drops two triggers to inject write-back
 * failures. The server needs its time-zone tables loaded.
 *
 * WHAT IS LOCKED
 *   - esign.requests over real rows: a contact's contact-linked requests and
 *     its cases' requests, newest first, the reminder contact resolved by the
 *     real buildContext (a Secondary's case reads its Primary), a finished
 *     request returned marked, another client's case never listed — and
 *     nothing of recipients / provider_id / raw_payload (a signing URL is
 *     planted there) / the PDF paths rides out.
 *   - The normalizer binds a real request: a card that places; the reminder-
 *     contact mismatch (both named), a TERMINAL request and a claimed one
 *     refused.
 *   - The point of the slice: the route enrolls e-sign-scoped AND writes the
 *     pointer (SQL), applyStatus(…'signed') cancels THAT enrollment and its
 *     pending job; a finished earlier pointer is replaced; a claimed request
 *     is refused before any row.
 *   - The write-back failing after the row exists — a trigger that refuses the
 *     UPDATE, and a trigger that finishes the request between the check and the
 *     write — cancels the enrollment (500, cancelled:true, pointer untouched).
 *   - The duplicate identity across all three scopes, card and engine
 *     agreeing; the engine's behaviour with BOTH ids set (measured: it files
 *     the row under both) and the normalizer refusing that combination.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

jest.mock('../lib/taskQueue', () => ({
  ...jest.requireActual('../lib/taskQueue'),
  enqueueJobDispatch: jest.fn(async () => true),
}));
jest.mock('../services/automationReadService', () => ({
  ...jest.requireActual('../services/automationReadService'),
  references: jest.fn(async () => []),
}));
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'] }; next(); }));

const seq = require('../lib/sequenceEngine');
const esignService = require('../services/esignService');
const { normalizeActionDraft, esignRequestsRead } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'sequence_templates', 'sequence_template_versions', 'sequence_steps', 'sequence_enrollments', 'scheduled_jobs',
  'users', 'appts', 'cases', 'case_relate', 'signing_requests', 'signing_request_events', 'contract_templates'];
const SIBLING_CHILDREN = ['sequence_step_log'];
const SECRET_URL = 'https://sign.zoho.com/zsguest?action_type=SIGN&request_id=SECRET-LINK-998';

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

d('e-sign-scoped Casey enrollments on real MySQL (A18.4d)', () => {
  const { DateTime } = require('luxon');
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const AT = DateTime.now().setZone('America/Detroit').plus({ days: 30 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
  const LOCAL = AT.toFormat('yyyy-MM-dd HH:mm:ss');

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('DROP TRIGGER IF EXISTS a184d_refuse_pointer');
    await conn.query('DROP TRIGGER IF EXISTS a184d_finish_on_enroll');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set([...SIBLING_CHILDREN, ...children.map((r) => r.t)]), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  // The real route, the real engine, the real pool.
  function post(body) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = pool; next(); });
    a.use(require('../routes/sequences.js'));
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const server = a.listen(0, () => {
        const req = http.request({ port: server.address().port, path: '/sequences/enroll', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }

  const sr = (id, over = {}) => ({ id, provider: 'zoho_sign', provider_id: `zoho-${id}`, linkable_type: 'case', linkable_id: 'CASE1', kind: 'retainer_prepetition',
    status: 'viewed', document_name: `Retainer ${id}`, tracking_id: `YC-CASE1-retainer-${id}`, template_id: 3, seq_instance_id: null, sent: true, completed: false, ...over });
  async function insertRequest(r) {
    await q(`INSERT INTO signing_requests (id, provider, provider_id, linkable_type, linkable_id, kind, status, document_name, tracking_id, recipients, raw_payload,
               placement_json, template_id, seq_instance_id, signed_pdf_path, cert_pdf_path, sent_at, completed_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, '/Clients/Dana/signed.pdf', '/Clients/Dana/cert.pdf', ?, ?, 6)`,
    [r.id, r.provider, r.provider_id, r.linkable_type, r.linkable_id, r.kind, r.status, r.document_name, r.tracking_id,
      JSON.stringify([{ name: 'Dana', email: 'dana.signer@example.com', order: 1, status: 'pending', signed_at: null, ip: '10.9.8.7' }]),
      JSON.stringify({ requests: { actions: [{ action_url: SECRET_URL }] } }), r.template_id, r.seq_instance_id,
      r.sent ? '2026-11-02 15:00:00' : null, r.completed ? '2026-11-03 10:00:00' : null]);
  }

  const EVIDENCE = (esignRows) => [
    { id: 'q1', kind: 'automation.definition', label: 'Templates', rows: [{ sequence_template_id: 61 }, { sequence_template_id: 62 }] },
    { id: 'q2', kind: 'sql.read', label: 'Contact', rows: [{ contact_id: 1983, contact_name: 'Dana Client' }, { appt_id: 950 }] },
    { id: 'q3', kind: 'esign.requests', label: 'Requests', rows: esignRows },
  ];
  const srRow = (id, contact = 1983) => ({ row_type: 'signing_request', signing_request_id: String(id), contact_id: String(contact) });
  const draftFor = (tpl, trigger_data, rows) => ({ kind: 'sequence.enroll.v1', sequence_template_id: tpl, contact_id: 1983,
    evidence: [[1, 1], [1, 2], [2, 1], [2, 2], ...rows.map((_, i) => [3, i + 1])].map(([qn, r]) => ({ query_id: `q${qn}`, row_number: r })),
    ...(trigger_data === undefined ? {} : { trigger_data }) });

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
    await q(`INSERT INTO contacts (contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_ssn)
             VALUES (1983, 'Dana Client', 'Dana', 'Client', '3135551234', '123-45-6789'), (1984, 'Other Person', 'Other', 'Person', '3135550000', NULL)`);
    await q(`INSERT INTO users (user, user_name, default_phone) VALUES (3, 'Stuart', '2485550003')`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_caption, case_type, case_status, case_rec)
             VALUES ('CASE1', '26-11111', '26-11111-tjt', 'In re Client', 'Bankruptcy', 'Open', ''),
                    ('CASE9', '26-99999', '26-99999-tjt', 'In re Person', 'Bankruptcy', 'Open', ''),
                    ('CASE2', '26-22222', '26-22222-tjt', 'In re Other', 'Bankruptcy', 'Open', '')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type)
             VALUES (1, 'CASE1', 1983, 'Primary'), (2, 'CASE9', 1984, 'Primary'), (3, 'CASE9', 1983, 'Secondary'), (4, 'CASE2', 1984, 'Primary')`);
    await q(`INSERT INTO appts (appt_id, appt_client_id, appt_case_id, appt_type, appt_status, appt_date, appt_with, appt_gcal, appt_ref_id, appt_note, appt_platform)
             VALUES (950, 1983, 'CASE1', '341 Meeting', 'Scheduled', ?, 3, '', '', '', 'Zoom')`, [LOCAL]);
    await q(`INSERT INTO contract_templates (id, name, kind, body, prefill_schema, placement_json) VALUES (3, 'Retainer', 'retainer_prepetition', '<p>x</p>', '[]', '{}')`);
    const tplRow = (id, name, testInput = null) => q(
      'INSERT INTO sequence_templates (id, name, type, active, current_version, draft_version, test_input) VALUES (?, ?, NULL, 1, 1, NULL, ?)',
      [id, name, testInput ? JSON.stringify(testInput) : null]);
    const version = (id) => q('INSERT INTO sequence_template_versions (template_id, version, name, published_at) VALUES (?, 1, ?, NOW())', [id, `T${id}`]);
    const step = (tpl, n, type, config, timing) => q(
      'INSERT INTO sequence_steps (template_id, version, step_number, action_type, action_config, timing) VALUES (?, 1, ?, ?, ?, ?)',
      [tpl, n, type, JSON.stringify(config), JSON.stringify(timing)]);
    // 61: the firm's reminder shape — an sms naming the document, then esign_remind on the request.
    await tplRow(61, 'Signature Nudges');
    await version(61);
    await step(61, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Please sign {{trigger_data.document_name}}' } },
      { type: 'delay', value: 1, unit: 'hours' });
    await step(61, 2, 'internal_function', { function_name: 'esign_remind', params: { signing_request_id: '{{trigger_data.signing_request_id}}' } },
      { type: 'delay', value: 2, unit: 'days' });
    // 62: places with no data at all; its test_input names appt_id so all three scopes can be carded.
    await tplRow(62, 'Plain Drip', { appt_id: 1 });
    await version(62);
    await step(62, 1, 'sms', { function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}' } }, { type: 'immediate' });
    // Signing requests: 44/45/49/50/51/52 live on Dana's case (or Dana), 46 finished, 47 on CASE9 (Dana is Secondary), 48 another client's.
    for (const r of [
      sr(44), sr(45, { linkable_type: 'contact', linkable_id: '1983', status: 'sent', template_id: null }),
      sr(46, { status: 'signed', completed: true }), sr(47, { linkable_id: 'CASE9' }), sr(48, { linkable_id: 'CASE2' }),
      sr(49), sr(50), sr(51), sr(52, { status: 'partially_signed' }),
    ]) await insertRequest(r);
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

  test('esign.requests over real rows: the contact\'s requests, the reminder contact from buildContext, finished ones marked — and no secret column rides out', async () => {
    const out = await esignRequestsRead(pool, { contact_id: 1983 });
    const [head, ...rows] = out.rows;
    expect(head).toMatchObject({ row_type: 'summary', contact_id: 1983, requests: 8, truncated: 0 });
    expect(rows.map((r) => [r.signing_request_id, r.status, r.contact_id, r.awaiting_signature, r.terminal, r.enrollable])).toEqual([
      [52, 'partially_signed', 1983, 1, 0, 1], [51, 'viewed', 1983, 1, 0, 1], [50, 'viewed', 1983, 1, 0, 1], [49, 'viewed', 1983, 1, 0, 1],
      [47, 'viewed', 1984, 1, 0, 1], // CASE9: Dana is Secondary — the reminder contact is the Primary
      [46, 'signed', 1983, 0, 1, 0], [45, 'sent', 1983, 1, 0, 1], [44, 'viewed', 1983, 1, 0, 1],
    ]);
    expect(rows.find((r) => r.signing_request_id === 44)).toMatchObject({ template_name: 'Retainer', case_id: 'CASE1', contact_name: 'Dana Client',
      sent_at: '2026-11-02T15:00:00.000Z', tracking_id: 'YC-CASE1-retainer-44' });
    expect(rows.find((r) => r.signing_request_id === 46).completed_at).toBe('2026-11-03T10:00:00.000Z');
    expect(JSON.stringify(out)).not.toMatch(/SECRET-LINK|zsguest|dana\.signer@example\.com|10\.9\.8\.7|zoho-4|signed\.pdf|cert\.pdf|123-45-6789/);
    const byCase = await esignRequestsRead(pool, { case_id: 'CASE9' });
    expect(byCase.rows.slice(1).map((r) => r.signing_request_id)).toEqual([47]);
  });

  test('the normalizer binds a real request: a card that places; the mismatch (both named), a finished and a claimed request refused', async () => {
    const rows = [srRow(44), srRow(46), srRow(47, 1984)];
    const out = await normalizeActionDraft(pool, draftFor(61, { signing_request_id: 44, document_name: 'Retainer 44' }, rows), EVIDENCE(rows));
    expect(out.first_step).toBe(1);
    expect(out.steps[0]).toMatchObject({ placement: 'places', message: 'Please sign Retainer 44' });
    expect(out.steps[1]).not.toHaveProperty('unresolved');
    expect(out.trigger).toMatchObject({ scope: 'esign', esign: { signing_request_id: 44, status: 'viewed', case_id: 'CASE1', pointer_base: null, prior_enrollment: null } });
    expect(out.trigger.esign.sent_text).toMatch(/^Mon, Nov 2, 2026, 10:00 AM firm time$/);
    await expect(normalizeActionDraft(pool, draftFor(61, { signing_request_id: 47 }, rows), EVIDENCE(rows)))
      .rejects.toThrow(/^Signing request #47 \("Retainer 47"\)'s reminder contact is Other Person \(contact 1984\) — debtor 1 of case CASE9, the contact the send enrolls — not Dana Client \(contact 1983\)/);
    await expect(normalizeActionDraft(pool, draftFor(61, { signing_request_id: 46 }, rows), EVIDENCE(rows)))
      .rejects.toThrow(/^Signing request #46 \("Retainer 46"\) is signed — finished\./);
  });

  test('THE POINT: the route enrolls e-sign-scoped and records the pointer; applyStatus(signed) cancels that enrollment and its pending job', async () => {
    const rows = [srRow(44)];
    const card = await normalizeActionDraft(pool, draftFor(61, { signing_request_id: 44, document_name: 'Retainer 44' }, rows), EVIDENCE(rows));
    const r = await post({ contact_id: 1983, template_id: 61, trigger_data: card.payload.trigger_data });
    expect(r.status).toBe(201);
    const id = r.body.enrollmentId;
    const [[enr]] = await pool.query('SELECT signing_request_id, appt_id, status FROM sequence_enrollments WHERE id = ?', [id]);
    expect(enr).toEqual({ signing_request_id: 44, appt_id: null, status: 'active' });
    const [[req]] = await pool.query('SELECT seq_instance_id FROM signing_requests WHERE id = 44');
    expect(req.seq_instance_id).toBe(id);
    const [[job]] = await pool.query("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE sequence_enrollment_id = ? AND status = 'pending'", [id]);
    expect(job.n).toBe(1);
    // Now claimed: the card refuses it by name, and so does the route — before any row.
    await expect(normalizeActionDraft(pool, draftFor(62, { signing_request_id: 44 }, rows), EVIDENCE(rows)))
      .rejects.toThrow(new RegExp(`already has an active reminder enrollment, #${id} — one live reminder chain per request`));
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM sequence_enrollments');
    const claimed = await post({ contact_id: 1983, template_id: 62, trigger_data: { signing_request_id: 44 } });
    expect(claimed).toMatchObject({ status: 409, body: { code: 'SIGNING_REQUEST_CLAIMED', enrollment_id: id } });
    const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM sequence_enrollments');
    expect(after.n).toBe(before.n);
    // The document is signed: the choke point cancels the chat-born enrollment through the pointer.
    const applied = await esignService.applyStatus(pool, 44, { status: 'signed', source: 'webhook' });
    expect(applied.changed).toBe(true);
    const [[done]] = await pool.query('SELECT status, cancel_reason FROM sequence_enrollments WHERE id = ?', [id]);
    expect(done).toEqual({ status: 'cancelled', cancel_reason: 'esign_signed' });
    const [[pending]] = await pool.query("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE sequence_enrollment_id = ? AND status = 'pending'", [id]);
    expect(pending.n).toBe(0);
    const [ev] = await pool.query("SELECT event FROM signing_request_events WHERE signing_request_id = 44 ORDER BY id");
    expect(ev.map((e) => e.event)).toEqual(['signed', 'reminders_cancelled']);
  });

  test('a finished earlier pointer is replaced: the route asserts it as the base and overwrites it', async () => {
    await q(`INSERT INTO sequence_enrollments (id, template_id, template_version, contact_id, appt_id, signing_request_id, trigger_data, status, current_step, total_steps)
             VALUES (7001, 61, 1, 1983, NULL, 49, '{"signing_request_id":49}', 'cancelled', 1, 2)`);
    await q('UPDATE signing_requests SET seq_instance_id = 7001 WHERE id = 49');
    const rows = [srRow(49)];
    const card = await normalizeActionDraft(pool, draftFor(61, { signing_request_id: 49 }, rows), EVIDENCE(rows));
    expect(card.trigger.esign).toMatchObject({ pointer_base: 7001, prior_enrollment: { enrollment_id: 7001, status: 'cancelled' } });
    const r = await post({ contact_id: 1983, template_id: 61, trigger_data: { signing_request_id: 49 } });
    expect(r.status).toBe(201);
    const [[req]] = await pool.query('SELECT seq_instance_id FROM signing_requests WHERE id = 49');
    expect(req.seq_instance_id).toBe(r.body.enrollmentId);
  });

  test('the write-back failing after the row exists CANCELS the enrollment: a refused UPDATE, and a request that finished in between', async () => {
    // (a) the UPDATE itself is refused.
    await q(`CREATE TRIGGER a184d_refuse_pointer BEFORE UPDATE ON signing_requests FOR EACH ROW
             BEGIN IF NOT (NEW.seq_instance_id <=> OLD.seq_instance_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected pointer refusal'; END IF; END`);
    try {
      const r = await post({ contact_id: 1983, template_id: 61, trigger_data: { signing_request_id: 50 } });
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ code: 'SIGNING_REQUEST_WRITEBACK_FAILED', signing_request_id: 50, cancelled: true });
      expect(r.body.message).toMatch(/the pointer write failed \(injected pointer refusal\)/);
      const [[enr]] = await pool.query('SELECT status, cancel_reason FROM sequence_enrollments WHERE id = ?', [r.body.enrollment_id]);
      expect(enr.status).toBe('cancelled');
      expect(enr.cancel_reason).toMatch(/^esign pointer not written: the pointer write failed \(injected pointer refusal\)/);
      const [[pending]] = await pool.query("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE sequence_enrollment_id = ? AND status = 'pending'", [r.body.enrollment_id]);
      expect(pending.n).toBe(0);
      const [[req]] = await pool.query('SELECT seq_instance_id FROM signing_requests WHERE id = 50');
      expect(req.seq_instance_id).toBeNull();
    } finally {
      await q('DROP TRIGGER IF EXISTS a184d_refuse_pointer');
    }
    // (b) the request finishes between the check and the write (as a webhook would) — the conditional UPDATE matches nothing.
    await q(`CREATE TRIGGER a184d_finish_on_enroll AFTER INSERT ON sequence_enrollments FOR EACH ROW
             BEGIN IF NEW.signing_request_id = 51 THEN UPDATE signing_requests SET status = 'declined' WHERE id = 51; END IF; END`);
    try {
      const r = await post({ contact_id: 1983, template_id: 61, trigger_data: { signing_request_id: 51 } });
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ code: 'SIGNING_REQUEST_WRITEBACK_FAILED', signing_request_id: 51, cancelled: true });
      expect(r.body.message).toMatch(/the request finished or another enrollment claimed it before the pointer was written/);
      const [[enr]] = await pool.query('SELECT status FROM sequence_enrollments WHERE id = ?', [r.body.enrollment_id]);
      expect(enr.status).toBe('cancelled');
      const [[req]] = await pool.query('SELECT status, seq_instance_id FROM signing_requests WHERE id = 51');
      expect(req).toEqual({ status: 'declined', seq_instance_id: null });
    } finally {
      await q('DROP TRIGGER IF EXISTS a184d_finish_on_enroll');
    }
  });

  test('the duplicate identity across all three scopes — card and engine agree; both ids at once is the engine filing under both, and the card refuses it', async () => {
    const rows = [srRow(52)];
    const ev = EVIDENCE(rows);
    const appt = { appt_id: 950 };
    const esign = { signing_request_id: 52 };
    // One active row per scope, each made by the engine itself.
    const c = await seq.enrollContactByTemplateId(pool, 1983, 62, {});
    const a = await seq.enrollContactByTemplateId(pool, 1983, 62, appt);
    const e = await post({ contact_id: 1983, template_id: 62, trigger_data: esign });
    expect(e.status).toBe(201);
    // Each scope's card is refused by its OWN row only, and the engine names the same row.
    await expect(normalizeActionDraft(pool, draftFor(62, undefined, rows), ev)).rejects.toThrow(new RegExp(`already enrolled in "Plain Drip" — active enrollment #${c.enrollmentId};`));
    await expect(normalizeActionDraft(pool, draftFor(62, appt, rows), ev)).rejects.toThrow(new RegExp(`for appointment #950 — active enrollment #${a.enrollmentId};`));
    // 52 now points at e: the card refuses it as claimed, naming e …
    await expect(normalizeActionDraft(pool, draftFor(62, esign, rows), ev)).rejects.toThrow(new RegExp(`already has an active reminder enrollment, #${e.body.enrollmentId} —`));
    // … and with the pointer cleared (an e-sign-scoped chain made before A18.4d, by a caller that never wrote it), the
    // scoped duplicate predicate still finds e by its own scope column.
    await q('UPDATE signing_requests SET seq_instance_id = NULL WHERE id = 52');
    await expect(normalizeActionDraft(pool, draftFor(62, esign, rows), ev)).rejects.toThrow(new RegExp(`for signing request #52 — active enrollment #${e.body.enrollmentId};`));
    await expect(seq.enrollContactByTemplateId(pool, 1983, 62, esign)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED', enrollment_id: e.body.enrollmentId });
    await expect(seq.enrollContactByTemplateId(pool, 1983, 62, appt)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED', enrollment_id: a.enrollmentId });
    // Cancel the contact- and appointment-scoped rows: the e-sign row blocks neither card.
    await q('UPDATE sequence_enrollments SET status = \'cancelled\' WHERE id IN (?, ?)', [c.enrollmentId, a.enrollmentId]);
    await expect(normalizeActionDraft(pool, draftFor(62, undefined, rows), ev)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
    await expect(normalizeActionDraft(pool, draftFor(62, appt, rows), ev)).resolves.toMatchObject({ trigger: { scope: 'appointment' } });
    // Both ids at once — measured on the engine: one row filed under BOTH scope columns.
    const both = await seq.enrollContactByTemplateId(pool, 1983, 62, { appt_id: 950, signing_request_id: 45 });
    const [[row]] = await pool.query('SELECT appt_id, signing_request_id FROM sequence_enrollments WHERE id = ?', [both.enrollmentId]);
    expect(row).toEqual({ appt_id: 950, signing_request_id: 45 });
    await expect(normalizeActionDraft(pool, draftFor(62, { appt_id: 950, signing_request_id: 52 }, rows), ev))
      .rejects.toThrow(/carries both appt_id and signing_request_id — an enrollment is appointment-scoped OR e-sign-scoped, never both/);
  });
});
