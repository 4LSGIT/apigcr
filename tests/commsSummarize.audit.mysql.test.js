/**
 * REAL-ENGINE test for comms archive S3's view_summary audit (design §7 P9):
 * AI summaries ride the phone thread as bubble text, so the two conversation
 * routes write ONE admin_audit_log row per fetch that handed any out —
 * tool 'comms_archive', details {action:'view_summary', media_ids}, never
 * content. Real routers (api.phoneComms), auth middleware and services over an
 * ephemeral express app; the scaffold follows tests/commsArchive.s4.mysql.test.js.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s3_test npx jest tests/commsSummarize.audit.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-s3-audit-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_s3_internal';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'log', 'users', 'system_alerts', 'alert_state', 'app_settings',
  'scheduled_jobs', 'job_results', 'admin_audit_log', 'jwt_api_audit_log', 'channel_grants', 'contacts', 'contact_phones'];
const P = '3135550001';
const L1 = '2485592400';

describe('summaryMediaIds (pure)', () => {
  const view = require('../services/commsArchiveView');
  test('ids of every call / voicemail whose summary_text is handed out, once each', () => {
    expect(view.summaryMediaIds({ messages: [
      { archive: { media_id: 1, summary_text: 'x' } },
      { archive: { media_id: 2, summary_text: null } },
      { archive: { media_id: 1, summary_text: 'x' } },
      { voicemail: { media_id: 3, summary_text: 'y' } },
      { kind: 'sms' },
    ] })).toEqual([1, 3]);
    expect(view.summaryMediaIds({})).toEqual([]);
    expect(view.summaryMediaIds(null)).toEqual([]);
  });
});

maybe('S3 view_summary audit on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const phoneRouter = require('../routes/api.phoneComms');

  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = (user, roles) => jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
  const SU = () => tok(6, ['su']), GRANTED = () => tok(3, ['staff']);
  const get = async (path, t) => {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${t}` } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const viewRows = async () => (await q("SELECT user_id, status, route, details FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id"))
    .map(r => ({ ...r, details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details }))
    .filter(r => r.details && r.details.action === 'view_summary');
  const settle = () => new Promise(r => setTimeout(r, 150));          // the audit is fire-and-forget

  const T0 = Date.parse('2026-10-01T15:00:00Z');
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  let nextId = 100;
  async function call(at) {
    const id = ++nextId;
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number, other_party, suppressed, raw_extra, processed_at)
             VALUES (?, 'ringcentral', ?, 'call', 'incoming', ?, ?, ?, 0, ?, ?)`,
      [id, `R${id}`, P, L1, P, JSON.stringify({ line: L1, started_at: new Date(at).toISOString(), ended_at: new Date(at + 60_000).toISOString(), provider_status: 'Accepted', recording_id: '' }), sql(at + 90_000)]);
    return id;
  }
  async function rec(ev, { restricted = 0, summary = null } = {}) {
    const [m] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state, restricted, object_name, mime, bytes)
       VALUES ('phone', 'call_recording', 'phone_event_log', ?, 'r', 'ringcentral', 1, ?, ?, 'archived', ?, ?, 'audio/mpeg', 10)`,
      [ev, P, sql(T0), restricted, `phone/rec/2026/10/${ev}-r.mp3`]);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text, summary_text)
             VALUES (?, ?, ?, '[{"s":"A","a":0,"b":1,"t":"hello"}]', 'hello', ?)`, [m.insertId, ev, summary ? 'summarized' : 'transcribed', summary]);
    return m.insertId;
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await schema.build(pool, TABLES);
    for (const t of ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
    const conn = await pool.getConnection();
    try {
      const r = await require('../scripts/commsTranscribeS2Migrate').run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(`S2 migration: ${r.line}`);
    } finally { conn.release(); }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(phoneRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    archive._test.setStorage(null);
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  let S;
  beforeEach(async () => {
    for (const t of ['comms_media', 'comms_transcripts', 'phone_event_log', 'phone_lines', 'users', 'admin_audit_log', 'channel_grants']) {
      await pool.query(`DELETE FROM \`${t}\``);
    }
    await q("INSERT INTO phone_lines (id, phone_number, provider, active, provider_id, credential_id) VALUES (1, ?, 'ringcentral', 1, NULL, 9)", [L1]);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, roles, ringcentral) VALUES
      (3, 'grant', 'Granted', 'G', 'R', 'GR', 'authorized', 'staff', 0), (6, 'su', 'Fred', 'F', 'S', 'FS', 'authorized', 'it,admin,su', 0)`);
    await q("INSERT INTO channel_grants (id, user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (1, 3, 'phone_line', 1, 1, 0, 0, 6)");
    archive._test.setStorage(fakeStorage().storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    S = {};
    S.c1 = await call(T0); S.r1 = await rec(S.c1, { summary: 'Client asked about the 341 meeting.' });
    S.c2 = await call(T0 + 600_000); S.r2 = await rec(S.c2);                                   // transcript, no summary
    S.c3 = await call(T0 + 1_200_000); S.r3 = await rec(S.c3, { restricted: 1, summary: 'A private matter.' });
  });

  test('A1 a thread handing out a summary writes ONE view_summary row: ids only, never the text', async () => {
    const r = await get(`/api/phone-lines/1/conversations/${P}?limit=100`, GRANTED());
    expect(r.status).toBe(200);
    expect(r.json.messages.find(m => m.id === S.c1).archive.summary_text).toBe('Client asked about the 341 meeting.');
    await settle();
    const rows = await viewRows();
    expect(rows).toEqual([expect.objectContaining({ user_id: 3, status: 'success', route: `/api/phone-lines/1/conversations/${P}?limit=100`,
      details: { action: 'view_summary', media_ids: [S.r1] } })]);
    expect(JSON.stringify(rows)).not.toMatch(/341 meeting|private matter/);
  });

  test('A2 the restricted summary is in the SU\'s row only (it was only handed to the SU); the All-numbers route audits too', async () => {
    await get(`/api/phone-lines/all/conversations/${P}?limit=100`, SU());
    await settle();
    const [row] = await viewRows();
    expect(row.details.media_ids.sort()).toEqual([S.r1, S.r3].sort());
    expect(row.route).toMatch(/^\/api\/phone-lines\/all\/conversations\//);
  });

  test('A3 a thread with no summary handed out writes no view_summary row', async () => {
    await q("UPDATE comms_transcripts SET summary_text = NULL, state = 'transcribed'");
    await get(`/api/phone-lines/1/conversations/${P}?limit=100`, GRANTED());
    await settle();
    expect(await viewRows()).toEqual([]);
  });
});
