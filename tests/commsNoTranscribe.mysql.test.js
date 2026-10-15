/**
 * REAL-ENGINE suite for the do-not-transcribe list API (comms archive, design
 * §0 R9 / P6) on MySQL with the production schema and sql_mode:
 *   GET    /api/comms-archive/no-transcribe
 *   POST   /api/comms-archive/no-transcribe        {phone, note?, requested_by?}
 *   DELETE /api/comms-archive/no-transcribe/:id
 *   W   who — an API key and a staff non-admin are refused (403) on all three;
 *       SU and a listed archive admin (SS) pass;
 *   V   validation — phone normalised (non-digits stripped, a leading US 1
 *       dropped) or 400; duplicate → 409 (two racing adds: one lands); note
 *       trimmed, ≤ 255; requested_by an ACTIVE staff user (disabled, unknown,
 *       the automation user → 400), default the caller;
 *   D   delete → the row, then 404;
 *   A   every outcome audited (admin_audit_log, tool comms_archive) — the
 *       phone and the note's LENGTH, never the note.
 * And GET /api/comms-archive/admin (comms.html's admin-tools slot):
 *   M   the caller's own isArchiveAdmin — SU true, a listed admin true (false
 *       once disabled), plain staff false, an API key false (200, not 403);
 *       never audited, whatever the answer.
 * The sweep's side of the match (what POST stores is what _onNoTranscribe
 * hits) is G4b in tests/commsTranscribe.mysql.test.js, where the sweep runs.
 *
 * Real router (api.commsArchive), auth middleware, services; comms_no_transcribe
 * from S2's own migration runner (scripts/commsTranscribeS2Migrate.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_notx_test npx jest tests/commsNoTranscribe.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-notx-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_notx_internal';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'system_alerts', 'alert_state', 'app_settings', 'scheduled_jobs', 'job_results',
  'admin_audit_log', 'jwt_api_audit_log'];
const S2_TABLES = ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe'];
const U = { SS: 1, NOBODY: 2, DISABLED: 3, AUTO: 0, SU: 6 };
const PATH = '/api/comms-archive/no-transcribe';

maybe('comms do-not-transcribe list on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const schema  = require('./helpers/commsArchiveSchema');
  const archiveRouter = require('../routes/api.commsArchive');

  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = (user, roles = []) =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
  const T = { su: () => tok(U.SU, ['su']), ss: () => tok(U.SS, ['staff']), nobody: () => tok(U.NOBODY, ['staff']) };
  async function http(method, path, { t, apiKey, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const list = (t) => http('GET', PATH, { t: t() });
  const add = (body, t = T.su) => http('POST', PATH, { t: t(), body });
  const del = (id, t = T.su) => http('DELETE', `${PATH}/${id}`, { t: t() });
  const rows = () => q('SELECT id, phone, note, created_by FROM comms_no_transcribe ORDER BY id');
  const audits = async () => (await q("SELECT status, user_id, details, error_message FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id"))
    .map(a => ({ ...a, details: typeof a.details === 'string' ? JSON.parse(a.details) : a.details }));

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await schema.build(pool, TABLES);
    for (const t of S2_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
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
    app.use(archiveRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (pool) for (const t of S2_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    for (const t of ['comms_no_transcribe', 'users', 'admin_audit_log']) await pool.query(`TRUNCATE TABLE \`${t}\``);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, user_type, roles, ringcentral) VALUES
      (50, 'auto', 'Automation', 'A', 'U', 'AUT', 'authorized', 0, 'automation', 0),
      (1, 'ss', 'SS', 'S', 'S', 'SS', 'authorized', 1, 'staff', 0),
      (2, 'nobody', 'Nobody', 'N', 'B', 'NB', 'authorized', 1, 'staff', 0),
      (3, 'gone', 'Gone', 'G', 'O', 'GO', 'disabled', 1, 'staff', 0),
      (6, 'su', 'Fred', 'F', 'S', 'FS', 'authorized', 1, 'it,admin,su', 0)`);
    await q('UPDATE users SET user = 0 WHERE user = 50');   // an INSERT of 0 would take the next auto-increment id
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_admins'");
  });

  // ── W — who ─────────────────────────────────────────────────────────────
  test('W1 an API key is refused on all three (403), audited rejected_not_jwt; nothing written', async () => {
    await q("INSERT INTO comms_no_transcribe (phone, note, created_by) VALUES ('3135550100', 'x', 6)");
    const k = { apiKey: process.env.INTERNAL_API_KEY };
    expect((await http('GET', PATH, k)).status).toBe(403);
    expect((await http('POST', PATH, { ...k, body: { phone: '2485551234' } })).status).toBe(403);
    expect((await http('DELETE', `${PATH}/1`, k)).status).toBe(403);
    expect(await rows()).toEqual([{ id: 1, phone: '3135550100', note: 'x', created_by: 6 }]);
    expect((await audits()).map(a => [a.status, a.details.action])).toEqual([
      ['rejected_not_jwt', 'no_transcribe_list'], ['rejected_not_jwt', 'no_transcribe_add'], ['rejected_not_jwt', 'no_transcribe_remove']]);
  });

  test('W2 a staff user who is not an archive admin is refused on all three (403), audited rejected_not_admin', async () => {
    await q("INSERT INTO comms_no_transcribe (phone, note, created_by) VALUES ('3135550100', 'x', 6)");
    const r = await list(T.nobody);
    expect(r.status).toBe(403);
    expect(r.json.entries).toBeUndefined();
    expect((await add({ phone: '2485551234' }, T.nobody)).status).toBe(403);
    expect((await del(1, T.nobody)).status).toBe(403);
    expect(await rows()).toHaveLength(1);
    expect((await audits()).map(a => [a.status, a.user_id])).toEqual([
      ['rejected_not_admin', 2], ['rejected_not_admin', 2], ['rejected_not_admin', 2]]);
  });

  test('W3 SU and a listed archive admin (SS) both add, list and remove; requested_by defaults to the caller', async () => {
    const a = await add({ phone: '+1 (248) 555-1234', note: '  personal line  ' });
    expect(a.status).toBe(200);
    expect(a.json.entry).toMatchObject({ phone: '2485551234', note: 'personal line', created_by: U.SU, created_by_name: 'Fred' });
    expect(a.json.entry.id).toEqual(expect.any(Number));
    expect(a.json.entry.created_at).toBeTruthy();
    const b = await add({ phone: '313-555-0199', requested_by: U.NOBODY }, T.ss);
    expect(b.status).toBe(200);
    expect(b.json.entry).toMatchObject({ phone: '3135550199', note: null, created_by: U.NOBODY, created_by_name: 'Nobody' });
    const c = await add({ phone: '5865550101', requested_by: '' }, T.ss);           // blank = the caller
    expect(c.json.entry).toMatchObject({ created_by: U.SS, created_by_name: 'SS' });
    const l = await list(T.ss);
    expect(l.status).toBe(200);
    expect(l.json.entries.map(e => e.phone)).toEqual(['5865550101', '3135550199', '2485551234']);   // newest first
    expect(l.json.entries[2]).toEqual({ id: a.json.entry.id, phone: '2485551234', note: 'personal line', created_by: 6,
      created_by_name: 'Fred', created_at: expect.any(String) });
    expect((await del(b.json.entry.id, T.ss)).status).toBe(200);
    expect((await list(T.su)).json.entries.map(e => e.phone)).toEqual(['5865550101', '2485551234']);
  });

  test('W4 a listed admin whose login was disabled is refused', async () => {
    await q("UPDATE users SET user_auth = 'disabled' WHERE user = 1");
    expect((await list(T.ss)).status).toBe(403);
  });

  // ── V — validation ──────────────────────────────────────────────────────
  test('V1 bad phones → 400, nothing stored; 11 digits with a leading 1 is normalised', async () => {
    for (const phone of ['555-1234', '22485551234', '124855512345', '', null, 'abc', '248555123']) {
      const r = await add({ phone });
      expect([phone, r.status]).toEqual([phone, 400]);
      expect(r.json.message).toMatch(/10 digits/);
    }
    const r = await add({});
    expect(r.status).toBe(400);
    expect(await rows()).toEqual([]);
    const ok = await add({ phone: '12485551234' });
    expect(ok.status).toBe(200);
    expect(ok.json.entry.phone).toBe('2485551234');
    expect(await rows()).toEqual([{ id: ok.json.entry.id, phone: '2485551234', note: null, created_by: 6 }]);
  });

  test('V2 a duplicate (in any spelling) → 409 "already on the list"; two racing adds: exactly one lands', async () => {
    expect((await add({ phone: '2485551234' })).status).toBe(200);
    const dup = await add({ phone: '1 (248) 555-1234', note: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.json.message).toMatch(/already on the list/);
    expect(await rows()).toHaveLength(1);
    const race = await Promise.all([add({ phone: '3135550199' }), add({ phone: '313.555.0199' }, T.ss)]);
    expect(race.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await rows()).filter(r => r.phone === '3135550199')).toHaveLength(1);
  });

  test('V3 note: trimmed, blank = NULL, ≤ 255 characters, text only', async () => {
    expect((await add({ phone: '2485550001', note: 'x'.repeat(256) })).status).toBe(400);
    expect((await add({ phone: '2485550001', note: 42 })).status).toBe(400);
    const at = await add({ phone: '2485550001', note: ` ${'y'.repeat(255)} ` });
    expect(at.status).toBe(200);
    expect(at.json.entry.note).toBe('y'.repeat(255));
    expect((await add({ phone: '2485550002', note: '   ' })).json.entry.note).toBeNull();
  });

  test('V4 requested_by must be an active staff user: disabled, unknown, the automation user, junk → 400', async () => {
    for (const requested_by of [U.DISABLED, 99, U.AUTO, 'abc', -1, 1.5]) {
      const r = await add({ phone: '2485551234', requested_by });
      expect([requested_by, r.status]).toEqual([requested_by, 400]);
      expect(r.json.message).toMatch(/active staff/);
    }
    expect(await rows()).toEqual([]);
    const ok = await add({ phone: '2485551234', requested_by: String(U.SS) });
    expect(ok.json.entry).toMatchObject({ created_by: U.SS, created_by_name: 'SS' });
  });

  // ── D — delete ──────────────────────────────────────────────────────────
  test('D1 delete → 200 with the removed row; again → 404; a junk id → 400', async () => {
    const { json: { entry } } = await add({ phone: '2485551234', note: 'n' });
    const d = await del(entry.id);
    expect(d.status).toBe(200);
    expect(d.json.entry).toMatchObject({ id: entry.id, phone: '2485551234', note: 'n', created_by: 6 });
    expect(await rows()).toEqual([]);
    const again = await del(entry.id);
    expect(again.status).toBe(404);
    expect((await del('abc')).status).toBe(400);
    expect((await list(T.su)).json.entries).toEqual([]);
  });

  // ── M — am I an archive admin? (GET /api/comms-archive/admin) ──────────────
  test('M1 the flag is the caller\'s isArchiveAdmin: SU and a listed admin true, plain staff false, an API key false', async () => {
    const flag = async (opts) => { const r = await http('GET', '/api/comms-archive/admin', opts); return [r.status, r.json]; };
    const yes = [200, { status: 'success', archive_admin: true }];
    const no = [200, { status: 'success', archive_admin: false }];
    expect(await flag({ t: T.su() })).toEqual(yes);
    expect(await flag({ t: T.ss() })).toEqual(yes);                          // listed in comms_archive_admins
    expect(await flag({ t: T.nobody() })).toEqual(no);
    expect(await flag({ apiKey: process.env.INTERNAL_API_KEY })).toEqual(no);  // never an archive admin, and not a 403
    expect((await http('GET', '/api/comms-archive/admin')).status).toBe(401);   // no credential: jwtOrApiKey's 401
    await q("UPDATE users SET user_auth = 'disabled' WHERE user = 1");
    expect(await flag({ t: T.ss() })).toEqual(no);                            // the same per-request check as the writes
    await q("UPDATE app_settings SET `value` = '' WHERE `key` = 'comms_archive_admins'");
    expect(await flag({ t: T.su() })).toEqual(yes);                           // SU needs no listing
    expect(await audits()).toEqual([]);                                        // not audited: it reveals only the caller's own flag
  });

  // ── A — audit ───────────────────────────────────────────────────────────
  test('A1 every outcome audited: the phone, ids and the note LENGTH — never the note text', async () => {
    const NOTE = 'client said this is her mother\'s cell';
    const { json: { entry } } = await add({ phone: '(248) 555-1234', note: NOTE, requested_by: U.SS });
    await add({ phone: '2485551234', note: NOTE });              // 409
    await add({ phone: '12' });                                   // 400
    await list(T.su);
    await del(entry.id);
    await del(entry.id);                                          // 404
    const a = await audits();
    expect(a.map(x => [x.status, x.user_id, x.details])).toEqual([
      ['success', 6, { action: 'no_transcribe_add', phone: '2485551234', requested_by: '1', note_len: NOTE.length, id: entry.id }],
      ['conflict', 6, { action: 'no_transcribe_add', phone: '2485551234', requested_by: '6', note_len: NOTE.length }],
      ['rejected_bad_request', 6, { action: 'no_transcribe_add', phone: '12', requested_by: '6', note_len: 0 }],
      ['success', 6, { action: 'no_transcribe_list', count: 1 }],
      ['success', 6, { action: 'no_transcribe_remove', id: entry.id, phone: '2485551234' }],
      ['not_found', 6, { action: 'no_transcribe_remove', id: entry.id }],
    ]);
    const all = JSON.stringify(await q('SELECT * FROM admin_audit_log'));
    expect(all).not.toContain('mother');
  });
});
