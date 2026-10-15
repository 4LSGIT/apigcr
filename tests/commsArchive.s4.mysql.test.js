/**
 * REAL-ENGINE suite for comms archive S4 (the Comms hub surfaces) on MySQL
 * with the production schema and sql_mode:
 *   G   the GRANT MATRIX — SU / attorney / granted / ungranted / listed
 *       archive admin (SS) × every kind of item, on every surface: the
 *       thread decoration (per line and All numbers), GET …/media/:id/url,
 *       GET …/media/:id/transcript. Restricted items: archive admins only;
 *       line-less items: SU / attorney only; everything else follows the
 *       line's can_read (design §7, R6, R9). A denial is the SAME 404 as a
 *       missing item; the audit row carries the reason.
 *   V   voicemails — Quo on the call's own row; RingCentral by party + line
 *       + [start − 5 min, end + 30 min], one voicemail → one call.
 *   X   transcripts — S2's comms_transcripts absent (ER_NO_SUCH_TABLE →
 *       has_transcript false) and present (JOIN on comms_media's restricted);
 *       the phone provider's own transcript for a voicemail; an S2 eval
 *       child (assemblyai-mc) never counts.
 *   P   purge's password re-check (Fred's ruling): wrong / empty / no hash /
 *       lockout; the password never reaches an audit row.
 *   H   the SU health read.
 *
 * Stand-ins only at the boundary: GCS (tests/helpers/fakeGcs.js). Routes run
 * the REAL routers (api.phoneComms + api.commsArchive), auth middleware and
 * services over an ephemeral express app.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s4_test npx jest tests/commsArchive.s4.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-s4-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_s4_internal';
delete process.env.SU_STEPUP; // step-up ON (the default)

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'log', 'users', 'system_alerts', 'alert_state', 'app_settings',
  'scheduled_jobs', 'job_results', 'admin_audit_log', 'jwt_api_audit_log', 'channel_grants', 'contacts', 'contact_phones'];

// S2's tables are made by S2's own migration runner (scripts/commsTranscribeS2Migrate.js
// — the script that ran live), only in the tests that need them; the rest run with
// no comms_transcripts at all, as before S2's migration.
const S2_TABLES = ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe', 'comms_summary_guides'];

const PW = 'correct horse battery';
// The summary fields an item carries before anything is summarised (S3 + S3c).
const NO_SUMMARY = { summary_text: null, summary_model: null, summary_note: null, summary_note_by: null, summary_requested_at: null, summary_pending: false };
const P = '3135550001';
const L1 = '2485592400', L4 = '2486213656', L6 = '2484179800';
const U = { SS: 1, ATT: 2, GRANTED: 3, NOBODY: 4, SU: 6, NOHASH: 8 };

maybe('comms archive S4 on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const bcrypt  = require('bcrypt');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const admin   = require('../services/commsArchiveAdmin');
  const view    = require('../services/commsArchiveView');
  const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
  const archiveRouter = require('../routes/api.commsArchive');
  const phoneRouter = require('../routes/api.phoneComms');

  let pool, gcs, server, base, HASH;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = (user, roles = []) =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
  const T = {
    su: () => tok(U.SU, ['su']), att: () => tok(U.ATT, ['staff', 'attorney']), granted: () => tok(U.GRANTED, ['staff']),
    nobody: () => tok(U.NOBODY, ['staff']), ss: () => tok(U.SS, ['staff']), nohash: () => tok(U.NOHASH, ['staff']),
  };
  async function http(method, path, { t, apiKey, body, headers: extra } = {}) {
    const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (t) headers.Authorization = `Bearer ${t}`;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const get = (path, o) => http('GET', path, o);
  const post = (path, body, o) => http('POST', path, { ...o, body });
  // S2's real migration (Part A), as it ran live — not a hand copy of its DDL.
  async function s2Tables() {
    const conn = await pool.getConnection();
    try {
      const r = await require('../scripts/commsTranscribeS2Migrate').run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(`S2 migration: ${r.line}`);
    } finally { conn.release(); }
  }
  const audits = () => q("SELECT status, user_id, route, details, error_message FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id");

  // ── fixtures ────────────────────────────────────────────────────────────
  const T0 = Date.parse('2026-10-01T15:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const sql = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
  let nextId = 100;
  async function ev({ type = 'call', line = L1, dir = 'incoming', at = T0, dur = 60, provider = 'ringcentral', status = 'Accepted', body = null } = {}) {
    const id = ++nextId;
    const extra = type === 'call'
      ? { line, started_at: iso(at), ended_at: iso(at + dur * 1000), provider_status: status, recording_id: '' }
      : { line, ts: iso(at) };
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, body, raw_extra, processed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, provider, `R${id}`, type, dir, dir === 'incoming' ? P : line, dir === 'incoming' ? line : P, P, body,
        JSON.stringify(extra), sql(at + (type === 'call' ? dur * 1000 + 30_000 : 2000))]);
    return id;
  }
  async function media({ kind = 'call_recording', source_table = 'phone_event_log', source_id, part = 'x', provider = 'ringcentral',
    channel_id = 1, party = P, state = 'archived', restricted = 0, mime = 'audio/mpeg', captured = T0, name, extra = {} } = {}) {
    const objectName = state === 'archived' ? (name || `phone/t/${kind}/${source_id}-${part}.${mime === 'application/json' ? 'quo.json' : 'mp3'}`) : (name || null);
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state,
          restricted, object_name, mime, bytes, purged_at, purged_by, purge_reason)
       VALUES ('phone', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, source_table, source_id, part, provider, channel_id, party, sql(captured), state, restricted,
        objectName, state === 'archived' ? mime : null, state === 'archived' ? 2048 : null,
        extra.purged_at || null, extra.purged_by || null, extra.purge_reason || null]);
    if (objectName && state === 'archived') {
      gcs.objects.set(objectName, { buf: Buffer.from(extra.body || 'bytes'), contentType: mime, generation: '1' });
    }
    return r.insertId;
  }

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
    HASH = await bcrypt.hash(PW, 4);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(archiveRouter);
    app.use(phoneRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    archive._test.setStorage(null);
    if (pool) for (const t of S2_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  // The scene every test starts from (ids in S).
  let S;
  beforeEach(async () => {
    archiveRouter._resetPurgeLimit();
    archiveRouter._resetMintLimit();
    archiveRouter._resetPasswordFailures();
    archiveRouter._resetRedoLimit();
    archiveRouter._resetResummarizeLimit();
    _resetRateLimits();
    for (const t of S2_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const t of ['comms_media', 'phone_event_log', 'phone_lines', 'users', 'admin_audit_log', 'channel_grants',
      'scheduled_jobs', 'job_results', 'system_alerts']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql']) {    // re-seed the job rows
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, provider_id, credential_id) VALUES
      (1, ?, 'ringcentral', 1, NULL, 9), (4, ?, 'ringcentral', 1, NULL, 9), (6, ?, 'quo', 1, 'PNb', 10)`, [L1, L4, L6]);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, roles, password_hash, ringcentral) VALUES
      (1, 'ss', 'SS', 'S', 'S', 'SS', 'authorized', 'staff', ?, 0),
      (2, 'att', 'Att', 'A', 'T', 'AT', 'authorized', 'staff,attorney', ?, 0),
      (3, 'grant', 'Granted', 'G', 'R', 'GR', 'authorized', 'staff', ?, 0),
      (4, 'nobody', 'Nobody', 'N', 'B', 'NB', 'authorized', 'staff', ?, 0),
      (6, 'su', 'Fred', 'F', 'S', 'FS', 'authorized', 'it,admin,su', ?, 0),
      (8, 'nohash', 'NoHash', 'N', 'H', 'NH', 'authorized', 'staff', NULL, 0)`, [HASH, HASH, HASH, HASH, HASH]);
    await q(`INSERT INTO channel_grants (id, user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES
      (1, 3, 'phone_line', 1, 1, 0, 0, 6), (2, 1, 'phone_line', 1, 1, 0, 0, 6), (3, 8, 'phone_line', 1, 1, 0, 0, 6)`);
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_admins'");
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';

    S = {};
    S.call1 = await ev({ at: T0 });                                                             // RC call, line 1
    S.rec1 = await media({ source_id: S.call1, part: 'r1' });
    S.callR = await ev({ at: T0 + 600_000 });                                                    // restricted recording
    S.recR = await media({ source_id: S.callR, part: 'r2', restricted: 1 });
    S.callP = await ev({ at: T0 + 1_200_000 });                                                  // purged recording
    S.recP = await media({ source_id: S.callP, part: 'r3', state: 'purged', name: 'phone/t/gone.mp3',
      extra: { purged_at: '2026-10-05 09:00:00', purged_by: 6, purge_reason: 'personal call' } });
    S.sms = await ev({ type: 'sms', at: T0 + 1_800_000, body: '' });                             // MMS: jpeg + pdf + pending
    S.jpg = await media({ kind: 'mms_file', source_id: S.sms, part: 'a1', mime: 'image/jpeg', name: 'phone/mms/x/1.jpg' });
    S.pdf = await media({ kind: 'mms_file', source_id: S.sms, part: 'a2', mime: 'application/pdf', name: 'phone/mms/x/2.pdf' });
    S.mmsPend = await media({ kind: 'mms_file', source_id: S.sms, part: 'a3', state: 'pending' });
    S.callVm = await ev({ at: T0 + 3_600_000, dur: 20 });                                        // RC voicemail by window
    S.callVmL4 = await ev({ at: T0 + 3_600_000, dur: 20, line: L4 });                            // same time, other line
    S.rcVm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 99001, part: '99001', captured: T0 + 3_600_000 + 60_000 });
    S.callNull = await ev({ at: T0 + 7_200_000, dur: 30 });                                      // a line-less RC voicemail
    S.rcVmNull = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 99002, part: '99002', channel_id: null,
      captured: T0 + 7_200_000 + 60_000 });
    S.callMis = await ev({ at: T0 + 9_000_000 });                                                // a row on the WRONG line
    S.recMis = await media({ source_id: S.callMis, part: 'r9', channel_id: 4 });
    S.quoCall = await ev({ at: T0 + 10_800_000, line: L6, provider: 'quo', status: 'no-answer' }); // Quo voicemail + vendor transcript
    S.quoVm = await media({ kind: 'voicemail', source_id: S.quoCall, part: 'VMa', provider: 'quo', channel_id: 6 });
    S.quoTx = await media({ kind: 'stt_raw', source_table: 'comms_media', source_id: S.quoVm, part: 'quo', provider: 'quo', channel_id: 6,
      mime: 'application/json', name: `phone/stt/2026/10/${S.quoVm}.quo.json`,
      extra: { body: JSON.stringify({ vendor: 'quo', voicemail_id: 'VMa', transcript: 'Hi, call me back <b>please</b>' }) } });
  });

  const byId = (msgs) => new Map(msgs.map(m => [m.id, m]));
  const thread = async (who, line = 1) => (await get(`/api/phone-lines/${line}/conversations/${P}?limit=100`, { t: who() })).json;

  // ── G — the thread decoration, per viewer ───────────────────────────────
  test('G1 SU: every readable item decorated; restricted flagged; purged tombstone; line-less voicemail via bypass; wrong-line row hidden', async () => {
    const t = await thread(T.su);
    expect(t.archive_admin).toBe(true);
    const m = byId(t.messages);
    expect(m.get(S.call1).archive).toEqual({ media_id: S.rec1, has_audio: true, has_transcript: false, ...NO_SUMMARY, restricted: false, extra: [] });
    expect(m.get(S.callR).archive).toMatchObject({ media_id: S.recR, restricted: true });
    expect(m.get(S.callP).archive).toEqual({ media_id: S.recP, purged: { at: '2026-10-05T09:00:00.000Z', by: 'Fred', reason: 'personal call' } });
    expect(m.get(S.sms).attachments).toEqual([
      { media_id: S.jpg, mime: 'image/jpeg', view: 'image', bytes: 2048, restricted: false },
      { media_id: S.pdf, mime: 'application/pdf', view: 'pdf', bytes: 2048, restricted: false },
    ]);
    expect(m.get(S.sms).attachments_pending).toBe(1);
    expect(m.get(S.callVm).voicemail).toEqual({ media_id: S.rcVm, provider: 'ringcentral', has_audio: true, has_transcript: false, ...NO_SUMMARY, restricted: false });
    expect(m.get(S.callNull).voicemail).toMatchObject({ media_id: S.rcVmNull });
    expect(m.get(S.callMis).archive).toBeUndefined();                       // channel_id 4 on a line-1 call: never shown
    expect(m.has(S.callVmL4)).toBe(false);                                  // line 4's call is not in line 1's thread
  });

  test('G2 attorney: no restricted item, no tombstone; the line-less voicemail via the bypass; not an archive admin', async () => {
    const t = await thread(T.att);
    expect(t.archive_admin).toBe(false);
    const m = byId(t.messages);
    expect(m.get(S.call1).archive).toMatchObject({ media_id: S.rec1 });
    expect(m.get(S.callR).archive).toBeUndefined();
    expect(m.get(S.callP).archive).toBeUndefined();
    expect(m.get(S.callNull).voicemail).toMatchObject({ media_id: S.rcVmNull });
    expect(m.get(S.callVm).voicemail).toMatchObject({ media_id: S.rcVm });
  });

  test('G3 granted (line 1 can_read): the line\'s items only; no restricted, no tombstone, no line-less voicemail', async () => {
    const t = await thread(T.granted);
    expect(t.archive_admin).toBe(false);
    const m = byId(t.messages);
    expect(m.get(S.call1).archive).toMatchObject({ media_id: S.rec1 });
    expect(m.get(S.callR).archive).toBeUndefined();
    expect(m.get(S.callP).archive).toBeUndefined();
    expect(m.get(S.callNull).voicemail).toBeUndefined();
    expect(m.get(S.callVm).voicemail).toMatchObject({ media_id: S.rcVm });
    expect(m.get(S.sms).attachments.map(a => a.media_id)).toEqual([S.jpg, S.pdf]);
  });

  test('G4 listed archive admin (SS, a line-1 grant, no attorney role): restricted + tombstones, but no line-less voicemail', async () => {
    const t = await thread(T.ss);
    expect(t.archive_admin).toBe(true);
    const m = byId(t.messages);
    expect(m.get(S.callR).archive).toMatchObject({ media_id: S.recR, restricted: true });
    expect(m.get(S.callP).archive.purged).toBeTruthy();
    expect(m.get(S.callNull).voicemail).toBeUndefined();
  });

  test('G5 ungranted: the thread itself is a 404 (unchanged); an empty-archive page has no archive keys at all', async () => {
    expect((await get(`/api/phone-lines/1/conversations/${P}`, { t: T.nobody() })).status).toBe(404);
    await q('TRUNCATE TABLE comms_media');
    const t = await thread(T.granted);
    for (const msg of t.messages) {
      expect(Object.keys(msg).filter(k => ['archive', 'voicemail', 'attachments', 'attachments_pending'].includes(k))).toEqual([]);
    }
  });

  test('G6 All numbers: each item judged on ITS line — a line-1 grantee sees line 1 only; SU sees the Quo voicemail on line 6', async () => {
    const g = (await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.granted() })).json;
    expect(g.messages.every(x => x.line_id === 1)).toBe(true);
    expect(byId(g.messages).get(S.call1).archive).toMatchObject({ media_id: S.rec1 });
    const s = (await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.su() })).json;
    const m = byId(s.messages);
    expect(m.get(S.quoCall).voicemail).toEqual({ media_id: S.quoVm, provider: 'quo', has_audio: true, has_transcript: true, ...NO_SUMMARY, restricted: false });
    expect(m.get(S.callVmL4).voicemail).toBeUndefined();                    // the RC voicemail is line 1's (channel_id 1)
    expect(m.get(S.callVm).voicemail).toMatchObject({ media_id: S.rcVm });
    expect(m.get(S.callMis).archive).toBeUndefined();
  });

  // ── G — content routes ──────────────────────────────────────────────────
  const url = (id, who, qs = '') => get(`/api/comms-archive/media/${id}/url${qs}`, { t: who() });

  test('G7 /url matrix: who gets a signed URL for what (everything else the SAME 404 as a missing id)', async () => {
    const missing = await url(987654, T.su);
    expect(missing).toEqual({ status: 404, json: { status: 'error', message: 'Archive item not found' } });
    const expectFor = {
      rec1:     { su: 200, att: 200, granted: 200, ss: 200, nobody: 404 },
      recR:     { su: 200, att: 404, granted: 404, ss: 200, nobody: 404 },
      rcVmNull: { su: 200, att: 200, granted: 404, ss: 404, nobody: 404 },
      quoVm:    { su: 200, att: 200, granted: 404, ss: 404, nobody: 404 },
      jpg:      { su: 200, att: 200, granted: 200, ss: 200, nobody: 404 },
      recP:     { su: 404, att: 404, granted: 404, ss: 404, nobody: 404 },   // purged
      mmsPend:  { su: 404, att: 404, granted: 404, ss: 404, nobody: 404 },   // not archived
      quoTx:    { su: 404, att: 404, granted: 404, ss: 404, nobody: 404 },   // stt_raw: never bytes
    };
    for (const [item, want] of Object.entries(expectFor)) {
      for (const [who, code] of Object.entries(want)) {
        const r = await url(S[item], T[who]);
        expect([item, who, r.status]).toEqual([item, who, code]);
        if (code === 404) expect(r.json).toEqual(missing.json);
        else expect(r.json.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
      }
    }
  });

  test('G8 /url: the signing allowlist (inline audio / image / pdf, everything else an attachment), audit rows without the URL', async () => {
    const vcard = await media({ kind: 'mms_file', source_id: S.sms, part: 'a4', mime: 'text/vcard', name: 'phone/mms/x/4.vcf' });
    const r1 = await url(S.rec1, T.granted);
    expect(r1.json).toMatchObject({ mime: 'audio/mpeg', inline: true, expires_in: 300 });
    const r2 = await url(vcard, T.granted);
    expect(r2.json).toMatchObject({ mime: 'text/vcard', inline: false });
    const signs = gcs.calls.sign;
    expect(signs[0]).toMatchObject({ version: 'v4', action: 'read', responseType: 'audio/mpeg', responseDisposition: 'inline' });
    expect(signs[1]).toMatchObject({ responseType: 'application/octet-stream', responseDisposition: `attachment; filename="mms_file-${vcard}.vcf"` });
    await url(S.jpg, T.granted, '?renew=1');
    await url(S.recR, T.granted);
    const a = await audits();
    expect(a.map(x => [x.status, x.details.action, x.details.media_id, x.user_id])).toEqual([
      ['success', 'listen', S.rec1, U.GRANTED],
      ['success', 'open_mms', vcard, U.GRANTED],
      ['success', 'open_mms', S.jpg, U.GRANTED],
      ['rejected_restricted', 'listen', S.recR, U.GRANTED],
    ]);
    expect(a[2].details.renew).toBe(true);
    for (const x of a) expect(JSON.stringify(x)).not.toMatch(/sig|googleapis/);
  });

  test('G9 /url: API key 403, bad id 400, the mint limit 429 (audited)', async () => {
    expect((await get(`/api/comms-archive/media/${S.rec1}/url`, { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
    expect((await url('abc', T.su)).status).toBe(400);
    archiveRouter._resetMintLimit(2);
    expect((await url(S.rec1, T.su)).status).toBe(200);
    expect((await url(S.rec1, T.su)).status).toBe(200);
    expect((await url(S.rec1, T.su)).status).toBe(429);
    expect((await audits()).map(x => x.status)).toContain('rejected_rate_limited');
  });

  test('G10 /url: a signing failure is a 502 and audited failed', async () => {
    gcs.fail.sign = { code: 403, message: 'iam.serviceAccounts.signBlob denied' };
    const r = await url(S.rec1, T.su);
    expect(r.status).toBe(502);
    expect((await audits()).pop()).toMatchObject({ status: 'failed' });
  });

  test('G11 /url holds a phone_event_log row to its EVENT\'s line (review A2): a stored line that disagrees, a suppressed event → 404 for everyone', async () => {
    for (const who of [T.su, T.att, T.granted]) {
      const r = await url(S.recMis, who);                          // channel_id 4 on a line-1 call
      expect(r).toEqual({ status: 404, json: { status: 'error', message: 'Archive item not found' } });
    }
    await q('UPDATE phone_event_log SET suppressed = 1 WHERE id = ?', [S.call1]);
    expect((await url(S.rec1, T.su)).status).toBe(404);
    const reasons = (await audits()).map(a => a.status);
    expect(reasons).toEqual(['rejected_line_mismatch', 'rejected_line_mismatch', 'rejected_line_mismatch', 'rejected_no_event']);
  });

  test('G12 a stored mime with parameters is still judged by its base type (review A4): inline + view', async () => {
    await q("UPDATE comms_media SET mime = 'IMAGE/JPEG; charset=binary' WHERE id = ?", [S.jpg]);
    const r = await url(S.jpg, T.granted);
    expect(r.json).toMatchObject({ inline: true });
    expect(gcs.calls.sign.pop()).toMatchObject({ responseType: 'image/jpeg', responseDisposition: 'inline' });
    const att = byId((await thread(T.granted)).messages).get(S.sms).attachments.find(a => a.media_id === S.jpg);
    expect(att.view).toBe('image');
  });

  // ── V — voicemail matching ──────────────────────────────────────────────
  test('V1 RC window edges: start − 5 min in, start − 6 min out; end + 30 min in, + 31 min out', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t1 = T0 + 86_400_000;
    const c = await ev({ at: t1, dur: 100 });
    const vmEarly = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 1, part: '1', captured: t1 - 5 * 60_000 });
    const show = async () => byId((await thread(T.su)).messages).get(c).voicemail;
    expect((await show()).media_id).toBe(vmEarly);
    await q('UPDATE comms_media SET captured_at = ? WHERE id = ?', [sql(t1 - 6 * 60_000), vmEarly]);
    expect(await show()).toBeUndefined();
    await q('UPDATE comms_media SET captured_at = ? WHERE id = ?', [sql(t1 + 100_000 + 30 * 60_000), vmEarly]);
    expect((await show()).media_id).toBe(vmEarly);
    await q('UPDATE comms_media SET captured_at = ? WHERE id = ?', [sql(t1 + 100_000 + 31 * 60_000), vmEarly]);
    expect(await show()).toBeUndefined();
  });

  test('V2 one voicemail → ONE call (the latest that started before it); outgoing calls never; restricted only for admins', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t1 = T0 + 2 * 86_400_000;
    const a = await ev({ at: t1, dur: 10 });
    const b = await ev({ at: t1 + 120_000, dur: 10 });
    const out = await ev({ at: t1 + 180_000, dur: 10, dir: 'outgoing' });
    const vm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 7, part: '7', captured: t1 + 200_000 });
    let m = byId((await thread(T.su)).messages);
    expect([m.get(a).voicemail, m.get(b).voicemail && m.get(b).voicemail.media_id, m.get(out).voicemail]).toEqual([undefined, vm, undefined]);
    await q('UPDATE comms_media SET restricted = 1 WHERE id = ?', [vm]);
    m = byId((await thread(T.granted)).messages);
    expect(m.get(b).voicemail).toBeUndefined();
    m = byId((await thread(T.ss)).messages);
    expect(m.get(b).voicemail).toMatchObject({ media_id: vm, restricted: true });
  });

  test('V3 a Quo call\'s own PENDING voicemail placeholder does not hide an archived RC match; an archived one wins', async () => {
    const c = await ev({ at: T0 + 3 * 86_400_000, line: L1, dur: 10 });
    const ph = await media({ kind: 'voicemail', source_id: c, part: '', provider: 'quo', state: 'pending' });
    const rc = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 8, part: '8', captured: T0 + 3 * 86_400_000 + 60_000 });
    expect(byId((await thread(T.su)).messages).get(c).voicemail.media_id).toBe(rc);
    await q("UPDATE comms_media SET state = 'archived', part = 'VMz', object_name = 'phone/vm/z.mp3', mime = 'audio/mpeg' WHERE id = ?", [ph]);
    expect(byId((await thread(T.su)).messages).get(c).voicemail.media_id).toBe(ph);
  });

  test('V4 an RC voicemail left on ANOTHER line never attaches to this line\'s call, even alone in the window', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t1 = T0 + 4 * 86_400_000;
    const c = await ev({ at: t1, dur: 10 });                                    // line 1 only
    await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 9, part: '9', channel_id: 4, captured: t1 + 30_000 });
    expect(byId((await thread(T.su)).messages).get(c).voicemail).toBeUndefined();
  });

  test('V5 a restricted vendor transcript child does not count as a transcript for a non-admin', async () => {
    await q('UPDATE comms_media SET restricted = 1 WHERE id = ?', [S.quoTx]);
    const att = (await get(`/api/phone-lines/6/conversations/${P}`, { t: T.att() })).json;
    expect(byId(att.messages).get(S.quoCall).voicemail.has_transcript).toBe(false);
    const su = (await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json;
    expect(byId(su.messages).get(S.quoCall).voicemail.has_transcript).toBe(true);
  });

  test('V6 back-to-back calls each keep their own voicemail (review A1): A 10:00 + VM 10:01, B 10:04 + VM 10:05', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 5 * 86_400_000;
    const a = await ev({ at: t, dur: 30 });
    const b = await ev({ at: t + 4 * 60_000, dur: 30 });
    const vmA = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 11, part: '11', captured: t + 60_000 });
    const vmB = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 12, part: '12', captured: t + 5 * 60_000 });
    const m = byId((await thread(T.su)).messages);
    expect([m.get(a).voicemail.media_id, m.get(b).voicemail.media_id]).toEqual([vmA, vmB]);
  });

  test('V7 the 5-minute lead is only a fallback: a voicemail stamped just before its call still finds it', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 6 * 86_400_000;
    const c = await ev({ at: t, dur: 30 });
    const vm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 13, part: '13', captured: t - 2 * 60_000 });
    expect(byId((await thread(T.su)).messages).get(c).voicemail.media_id).toBe(vm);
  });

  test('V8 the assignment never depends on the viewer: a restricted or pending voicemail does not let another slide onto its call', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 7 * 86_400_000;
    const a = await ev({ at: t, dur: 30 });
    const b = await ev({ at: t + 3 * 60_000, dur: 30 });
    const secret = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 14, part: '14', captured: t + 3.5 * 60_000, restricted: 1 });
    await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 16, part: '16', captured: t + 2 * 60_000, state: 'pending' });
    const vmA = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 15, part: '15', captured: t + 4 * 60_000 });
    const su = byId((await thread(T.su)).messages);
    expect([su.get(a).voicemail.media_id, su.get(b).voicemail.media_id]).toEqual([vmA, secret]);
    const g = byId((await thread(T.granted)).messages);
    expect([g.get(a).voicemail.media_id, g.get(b).voicemail]).toEqual([vmA, undefined]);
  });

  test('V9 a Quo call\'s own archived voicemail keeps an RC voicemail off it (the RC one goes to the call before)', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 8 * 86_400_000;
    const a = await ev({ at: t, dur: 30 });
    const b = await ev({ at: t + 2 * 60_000, dur: 30 });
    const own = await media({ kind: 'voicemail', source_id: b, part: 'VMx', provider: 'quo' });
    const rc = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 17, part: '17', captured: t + 3 * 60_000 });
    const m = byId((await thread(T.su)).messages);
    expect([m.get(a).voicemail.media_id, m.get(b).voicemail.media_id]).toEqual([rc, own]);
  });

  test('V10 paging never shows one voicemail on two calls (review N-A1): page 1 = B with it, page 2 = A without', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 10 * 86_400_000;
    const a = await ev({ at: t, dur: 30 });
    const b = await ev({ at: t + 4 * 60_000, dur: 30 });
    const vm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 21, part: '21', captured: t + 5 * 60_000 });
    const p1 = (await get(`/api/phone-lines/1/conversations/${P}?limit=1`, { t: T.su() })).json;
    expect(p1.messages.map(m => [m.id, m.voicemail && m.voicemail.media_id])).toEqual([[b, vm]]);
    const p2 = (await get(`/api/phone-lines/1/conversations/${P}?limit=1&cursor=${encodeURIComponent(p1.next_cursor)}`, { t: T.su() })).json;
    expect(p2.messages.map(m => [m.id, m.voicemail])).toEqual([[a, undefined]]);
    const all2 = (await get(`/api/phone-lines/all/conversations/${P}?limit=1&cursor=${encodeURIComponent(p1.next_cursor)}`, { t: T.su() })).json;
    expect(all2.messages.map(m => [m.id, m.voicemail])).toEqual([[a, undefined]]);
  });

  test('V11 a line-less RC voicemail never lands on a Quo call (review N-A2); it takes the RingCentral call in its window', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 11 * 86_400_000;
    const quo = await ev({ at: t + 3 * 60_000, dur: 20, line: L6, provider: 'quo', status: 'no-answer' });
    const vm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 22, part: '22', channel_id: null, captured: t + 4 * 60_000 });
    expect(byId((await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json.messages).get(quo).voicemail).toBeUndefined();
    const rc = await ev({ at: t, dur: 20 });                                   // an RC call earlier in the window
    expect(byId((await thread(T.su)).messages).get(rc).voicemail.media_id).toBe(vm);
    expect(byId((await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json.messages).get(quo).voicemail).toBeUndefined();
  });

  test('V13 the window widens until no other voicemail competes: a page holding only C still gets C\'s early-stamped voicemail', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 13 * 86_400_000;
    const b = await ev({ at: t + 40 * 60_000, dur: 30 });
    const c = await ev({ at: t + 60 * 60_000, dur: 30 });
    const vb = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 24, part: '24', captured: t + 41 * 60_000 });
    const vc = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 25, part: '25', captured: t + 58 * 60_000 });  // 2 min before C
    const p1 = (await get(`/api/phone-lines/1/conversations/${P}?limit=1`, { t: T.su() })).json;
    expect(p1.messages.map(m => [m.id, m.voicemail && m.voicemail.media_id])).toEqual([[c, vc]]);
    const p2 = (await get(`/api/phone-lines/1/conversations/${P}?limit=1&cursor=${encodeURIComponent(p1.next_cursor)}`, { t: T.su() })).json;
    expect(p2.messages.map(m => [m.id, m.voicemail && m.voicemail.media_id])).toEqual([[b, vb]]);
  });

  test('V14 a suppressed call (spam, never shown) does not take a voicemail from the visible call before it', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 14 * 86_400_000;
    const a = await ev({ at: t, dur: 20 });
    const spam = await ev({ at: t + 2 * 60_000, dur: 20 });
    await q('UPDATE phone_event_log SET suppressed = 1 WHERE id = ?', [spam]);
    const vm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 26, part: '26', captured: t + 3 * 60_000 });
    expect(byId((await thread(T.su)).messages).get(a).voicemail.media_id).toBe(vm);
  });

  test('V12 a Quo call\'s OWN voicemail keeps an RC voicemail off it even when the viewer cannot see it (restricted)', async () => {
    await q('TRUNCATE TABLE comms_media');
    await q('TRUNCATE TABLE phone_event_log');
    const t = T0 + 12 * 86_400_000;
    const a = await ev({ at: t, dur: 20, line: L6, provider: 'quo', status: 'no-answer' });
    const b = await ev({ at: t + 3 * 60_000, dur: 20, line: L6, provider: 'quo', status: 'no-answer' });
    const own = await media({ kind: 'voicemail', source_id: b, part: 'VMr', provider: 'quo', channel_id: 6, restricted: 1 });
    const rc = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 23, part: '23', channel_id: 6, captured: t + 4 * 60_000 });
    const att = byId((await get(`/api/phone-lines/6/conversations/${P}`, { t: T.att() })).json.messages);
    expect([att.get(a).voicemail && att.get(a).voicemail.media_id, att.get(b).voicemail]).toEqual([rc, undefined]);
    const su = byId((await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json.messages);
    expect([su.get(a).voicemail.media_id, su.get(b).voicemail.media_id]).toEqual([rc, own]);
  });

  // ── X — transcripts ─────────────────────────────────────────────────────
  const tx = (id, who) => get(`/api/comms-archive/media/${id}/transcript`, { t: who() });

  test('X1 no comms_transcripts table yet: a recording has none (404 after the grant); a Quo voicemail serves the provider\'s, labelled', async () => {
    expect((await tx(S.rec1, T.granted))).toEqual({ status: 404, json: { status: 'error', message: 'No transcript for this item yet' } });
    expect((await tx(S.rec1, T.nobody)).json.message).toBe('Archive item not found');
    const r = await tx(S.quoVm, T.su);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ source: 'provider', vendor: 'quo', segments: [], text: 'Hi, call me back <b>please</b>' });
    expect(r.json.label).toMatch(/check the recording before relying on it/);
    const a = (await audits()).pop();
    expect(a).toMatchObject({ status: 'success', details: { action: 'view_transcript', media_id: S.quoVm, source: 'provider' } });
    expect(JSON.stringify(a)).not.toMatch(/call me back/);
  });

  test('X2 an S2 eval child (assemblyai-mc) is never a vendor transcript; a restricted vendor child needs an admin', async () => {
    await q('DELETE FROM comms_media WHERE id = ?', [S.quoTx]);
    await media({ kind: 'stt_raw', source_table: 'comms_media', source_id: S.quoVm, part: 'assemblyai-mc', provider: 'quo', channel_id: 6,
      mime: 'application/json', name: `phone/stt/2026/10/${S.quoVm}.assemblyai-mc.json`, extra: { body: '{"transcript":"eval"}' } });
    expect((await tx(S.quoVm, T.su)).status).toBe(404);
    const s = (await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json;
    expect(byId(s.messages).get(S.quoCall).voicemail.has_transcript).toBe(false);
    await media({ kind: 'stt_raw', source_table: 'comms_media', source_id: S.quoVm, part: 'quo', provider: 'quo', channel_id: 6, restricted: 1,
      mime: 'application/json', name: `phone/stt/2026/10/${S.quoVm}.quo.json`, extra: { body: '{"vendor":"quo","transcript":"secret"}' } });
    expect((await tx(S.quoVm, T.att)).status).toBe(404);
    expect((await tx(S.quoVm, T.su)).json.text).toBe('secret');
  });

  test('X3 S2 present: segments + the R8 label; has_transcript / summary_text on the bubble; restriction read from comms_media', async () => {
    await s2Tables();
    const segs = [{ s: 'A', a: 0, b: 2.5, t: 'Hello <script>x</script>' }, { s: 'B', a: 2.5, b: 4, t: 'Hi' }];
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, stt_vendor, segments, full_text, summary_text)
             VALUES (?, ?, 'summarized', 'assemblyai', ?, 'Hello Hi', 'Client asked about the 341.'),
                    (?, ?, 'transcribed', 'assemblyai', ?, 'restricted words', NULL)`,
      [S.rec1, S.call1, JSON.stringify(segs), S.recR, S.callR, JSON.stringify([{ s: 'A', a: 0, b: 1, t: 'restricted words' }])]);
    const r = await tx(S.rec1, T.granted);
    expect(r.json).toMatchObject({ source: 'assemblyai', label: 'AI-generated — check the recording before relying on it', text: 'Hello Hi' });
    expect(r.json.segments).toEqual(segs);
    const m = byId((await thread(T.granted)).messages);
    expect(m.get(S.call1).archive).toMatchObject({ has_transcript: true, summary_text: 'Client asked about the 341.' });
    expect(m.get(S.callR).archive).toBeUndefined();
    expect((await tx(S.recR, T.granted)).status).toBe(404);
    expect((await tx(S.recR, T.su)).json.text).toBe('restricted words');
    // a purged transcript row (S2 purge part) is gone everywhere — the state
    // alone decides, even before (or without) its text being cleared
    await q("UPDATE comms_transcripts SET state = 'purged' WHERE media_id = ?", [S.rec1]);
    expect((await tx(S.rec1, T.granted)).status).toBe(404);
    expect(byId((await thread(T.granted)).messages).get(S.call1).archive.has_transcript).toBe(false);
  });

  test('X4 the transcript JOIN re-asserts the media row: a row restricted after the grant read is not served', async () => {
    await s2Tables();
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text) VALUES (?, ?, 'transcribed', NULL, 'words')`, [S.rec1, S.call1]);
    const orig = admin.canReadMedia;
    admin.canReadMedia = async (...a) => { const r = await orig(...a); await q('UPDATE comms_media SET restricted = 1 WHERE id = ?', [S.rec1]); return r; };
    try {
      expect((await tx(S.rec1, T.granted)).status).toBe(404);
    } finally { admin.canReadMedia = orig; }
  });

  test('X5 a transcript written the way S2\'s sweep writes it (its own segment helpers, diarized + multichannel) reads back through the route; only transcribed / summarized are readable', async () => {
    await s2Tables();
    const vendor = require('../services/commsTranscribeVendor');
    const diar = { status: 'completed', text: 'Hello there. Hi.', multichannel: false, language_code: 'en_us',
      utterances: [{ speaker: 'A', start: 120, end: 2540, text: 'Hello there.' }, { speaker: 'B', start: 2600, end: 3100, text: 'Hi.' }] };
    const multi = { status: 'completed', text: 'One. Two.', multichannel: true,
      utterances: [{ channel: '1', start: 0, end: 900, text: 'One.' }, { channel: '2', start: 1000, end: 1999, text: 'Two.' }] };
    const silent = { status: 'completed', text: '', utterances: [] };
    const write = async (mediaId, eventId, json, state = 'transcribed') => {
      const segs = vendor.segmentsFromVendorJson(json);
      await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state) VALUES (?, ?, 'transcribing')`, [mediaId, eventId]);
      // the sweep's own completion UPDATE (services/commsTranscribeSweep.js), state left as the test needs
      await q(`UPDATE comms_transcripts SET state = ?, stt_vendor = 'assemblyai', language = ?, speakers = ?, segments = ?, full_text = ?,
                 transcribed_at = UTC_TIMESTAMP() WHERE media_id = ? AND state = 'transcribing'`,
        [state, json.language_code || null, new Set(segs.map(x => x.s)).size || null, JSON.stringify(segs), vendor.fullTextOf(segs, json), mediaId]);
      return segs;
    };
    const dSegs = await write(S.rec1, S.call1, diar);
    const r = (await tx(S.rec1, T.granted)).json;
    expect(r).toMatchObject({ source: 'assemblyai', label: 'AI-generated — check the recording before relying on it', text: 'Hello there.\nHi.' });
    expect(r.segments).toEqual(dSegs);
    expect(r.segments).toEqual([{ s: 'A', a: 0.12, b: 2.54, t: 'Hello there.' }, { s: 'B', a: 2.6, b: 3.1, t: 'Hi.' }]);
    // multichannel, on the Quo voicemail: canonical S2 text outranks the provider's own
    await write(S.quoVm, S.quoCall, multi, 'summarized');
    const v = (await tx(S.quoVm, T.su)).json;
    expect(v.source).toBe('assemblyai');
    expect(v.segments.map(x => x.s)).toEqual(['ch1', 'ch2']);
    // a recording with no speech: readable, empty
    const call2 = await ev({ at: T0 + 9 * 86_400_000 });
    const rec2 = await media({ source_id: call2, part: 'z' });
    await write(rec2, call2, silent);
    expect((await tx(rec2, T.su)).json).toMatchObject({ segments: [], text: '' });
    // every state but transcribed / summarized hides the text — even when text is left on the row
    for (const st of ['pending', 'transcribing', 'skipped', 'failed', 'purged']) {
      await q('UPDATE comms_transcripts SET state = ? WHERE media_id = ?', [st, S.rec1]);
      expect([st, (await tx(S.rec1, T.su)).status]).toEqual([st, 404]);
      expect([st, byId((await thread(T.su)).messages).get(S.call1).archive.has_transcript]).toEqual([st, false]);
    }
    await q("UPDATE comms_transcripts SET state = 'transcribed' WHERE media_id = ?", [S.rec1]);
    expect(byId((await thread(T.su)).messages).get(S.call1).archive.has_transcript).toBe(true);
    // purge through the route runs S2's 'transcripts' step first: text gone, state purged
    expect((await post(`/api/comms-archive/media/${S.rec1}/purge`, { reason: 'x', confirm: S.rec1, password: PW }, { t: T.su() })).status).toBe(200);
    expect((await q('SELECT state, segments, full_text FROM comms_transcripts WHERE media_id = ?', [S.rec1]))[0])
      .toEqual({ state: 'purged', segments: null, full_text: null });
    expect((await tx(S.rec1, T.su)).status).toBe(404);
  });

  test('X6 S2\'s sample-variant children (assemblyai / assemblyai-mc) never surface: not as bytes, not as a voicemail transcript', async () => {
    await q('DELETE FROM comms_media WHERE id = ?', [S.quoTx]);
    const kids = [];
    for (const part of ['assemblyai', 'assemblyai-mc']) {
      kids.push(await media({ kind: 'stt_raw', source_table: 'comms_media', source_id: S.quoVm, part, provider: 'quo', channel_id: 6,
        mime: 'application/json', name: `phone/stt/2026/10/${S.quoVm}.${part}.json`, extra: { body: '{"transcript":"variant"}' } }));
    }
    for (const k of kids) expect((await url(k, T.su)).status).toBe(404);
    expect((await tx(S.quoVm, T.su)).status).toBe(404);
    expect(byId((await get(`/api/phone-lines/6/conversations/${P}`, { t: T.su() })).json.messages).get(S.quoCall).voicemail.has_transcript).toBe(false);
  });

  // S2's own migration for the guide table (ref/migrations/2026-10-16_comms_s3c_summary_guides.sql).
  async function guidesTable() {
    for (const st of schema.migrationStatements('2026-10-16_comms_s3c_summary_guides.sql')) await pool.query(st);
  }

  test('X7 S3c: summary fields on BOTH the recording and the voicemail — the note is the one STAMPED into the summary shown; pending / when from the guide table; gated like the summary', async () => {
    await s2Tables();
    const tr = async (mediaId, eventId, state, text, model, summary) => {
      const [r] = await pool.query(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text, summary_text, summary_model, summary)
        VALUES (?, ?, ?, '[]', 'words', ?, ?, ?)`, [mediaId, eventId, state, text, model, summary === undefined ? null : JSON.stringify(summary)]);
      return r.insertId;
    };
    const stamp = (note, by) => ({ summary: 'x', guide: note == null ? null : { note, note_by: 6, note_by_name: by, requested_at: '2026-10-15T08:00:00Z', model: 'claude-sonnet-5-5' } });
    const tRec = await tr(S.rec1, S.call1, 'summarized', 'Client asked about the 341.', 'claude-sonnet-5-5', stamp('Speaker A is the trustee <b>x</b>', 'Fred S'));
    const tVm = await tr(S.quoVm, S.quoCall, 'summarized', 'Caller wants a callback.', 'claude-haiku-5-5', stamp(null));
    const tRes = await tr(S.recR, S.callR, 'summarized', 'secret summary', 'claude-haiku-5-5', stamp('restricted note', 'Fred S'));
    // before the guide table exists: the stamped note shows, nothing is pending — the voicemail's summary included (F1)
    let su = byId((await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.su() })).json.messages);
    expect(su.get(S.call1).archive).toMatchObject({ summary_text: 'Client asked about the 341.', summary_model: 'claude-sonnet-5-5',
      summary_note: 'Speaker A is the trustee <b>x</b>', summary_note_by: 'Fred S', summary_requested_at: null, summary_pending: false });
    expect(su.get(S.quoCall).voicemail).toMatchObject({ summary_text: 'Caller wants a callback.', summary_model: 'claude-haiku-5-5',
      summary_note: null, summary_note_by: null, summary_pending: false });
    // a NEWER request is pending with a different note: the old summary keeps its OWN note; the new note is not shown yet
    await guidesTable();
    await q(`INSERT INTO comms_summary_guides (transcript_id, model, note, note_by, requested_at, requested_by, outcome) VALUES
      (?, 'claude-haiku-5-5', 'a newer note, not used yet', 3, '2026-10-15 09:00:00', 3, NULL),
      (?, 'claude-haiku-5-5', NULL, NULL, '2026-10-15 07:00:00', 3, 'done'),
      (?, 'claude-sonnet-5-5', 'restricted note', 6, '2026-10-15 07:00:00', 6, NULL)`, [tRec, tVm, tRes]);
    su = byId((await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.su() })).json.messages);
    expect(su.get(S.call1).archive).toMatchObject({ summary_note: 'Speaker A is the trustee <b>x</b>', summary_note_by: 'Fred S',
      summary_requested_at: '2026-10-15T09:00:00.000Z', summary_pending: true });
    expect(JSON.stringify(su.get(S.call1))).not.toMatch(/a newer note/);
    expect(su.get(S.quoCall).voicemail).toMatchObject({ summary_note: null, summary_requested_at: '2026-10-15T07:00:00.000Z', summary_pending: false });
    // a pre-S3c summary (no `guide` key) and a JSON null summary → no note
    await q("UPDATE comms_transcripts SET summary = JSON_OBJECT('summary', 'old') WHERE id = ?", [tVm]);
    await q('UPDATE comms_transcripts SET summary = NULL WHERE id = ?', [tRec]);
    su = byId((await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.su() })).json.messages);
    expect([su.get(S.call1).archive.summary_note, su.get(S.quoCall).voicemail.summary_note]).toEqual([null, null]);
    // the restricted recording's summary / note never reach a non-admin (the object itself is absent)
    const g = byId((await get(`/api/phone-lines/1/conversations/${P}`, { t: T.granted() })).json.messages);
    expect(g.get(S.callR).archive).toBeUndefined();
    expect(JSON.stringify(g.get(S.callR))).not.toMatch(/restricted note|secret summary/);
    // a re-queued transcript (not readable) hands out no summary fields at all
    await q("UPDATE comms_transcripts SET state = 'transcribing' WHERE id = ?", [tRec]);
    su = byId((await get(`/api/phone-lines/1/conversations/${P}`, { t: T.su() })).json.messages);
    expect(su.get(S.call1).archive).toMatchObject({ summary_text: null, summary_model: null, summary_note: null, summary_note_by: null,
      summary_requested_at: null, summary_pending: false });
  });

  test('X8 the view_summary audit counts every summary handed out — the voicemail\'s too — and a pending first request shows no note', async () => {
    await s2Tables();
    await guidesTable();
    const [r] = await pool.query(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text) VALUES (?, ?, 'transcribed', '[]', 'words')`, [S.rec1, S.call1]);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text, summary_text, summary_model)
             VALUES (?, ?, 'summarized', '[]', 'words', 'Wants a callback', 'claude-haiku-5-5')`, [S.quoVm, S.quoCall]);
    await q(`INSERT INTO comms_summary_guides (transcript_id, model, note, note_by, requested_at, requested_by) VALUES (?, 'claude-sonnet-5-5', 'who is who', 3, UTC_TIMESTAMP(), 3)`, [r.insertId]);
    await q('TRUNCATE TABLE admin_audit_log');
    const m = byId((await get(`/api/phone-lines/all/conversations/${P}?limit=100`, { t: T.su() })).json.messages);
    expect(m.get(S.call1).archive).toMatchObject({ summary_text: null, summary_note: null, summary_note_by: null, summary_pending: true });
    expect(m.get(S.quoCall).voicemail.summary_text).toBe('Wants a callback');
    // the conversation route writes this audit row fire-and-forget (not awaited before the response): wait for it
    let a = [];
    for (let i = 0; i < 50 && !a.length; i++) {
      a = (await q("SELECT details FROM admin_audit_log WHERE tool = 'comms_archive'")).map(x => x.details);
      if (!a.length) await new Promise(res => setTimeout(res, 20));
    }
    expect(a).toEqual([{ action: 'view_summary', media_ids: [S.quoVm] }]);
  });

  // ── P — purge's password re-check ───────────────────────────────────────
  const purge = (id, who, extra = {}) => post(`/api/comms-archive/media/${id}/purge`, { reason: 'client asked', confirm: id, ...extra }, { t: who() });

  test('P1 wrong / empty password: 403 bad_password (never 401 — the shell would re-login), nothing purged, no attempt row', async () => {
    for (const password of ['wrong', '', undefined]) {
      const r = await purge(S.rec1, T.ss, { password });
      expect(r).toEqual({ status: 403, json: { status: 'error', code: 'bad_password', message: 'Incorrect password' } });
    }
    expect((await q('SELECT state FROM comms_media WHERE id = ?', [S.rec1]))[0].state).toBe('archived');
    const a = await audits();
    expect(a.map(x => x.status)).toEqual(['rejected_bad_password', 'rejected_bad_password', 'rejected_bad_password']);
    expect(gcs.objects.has(`phone/t/call_recording/${S.call1}-r1.mp3`)).toBe(true);
  });

  test('P2 the right password purges (SS and SU alike); the password is in no audit row', async () => {
    expect((await purge(S.rec1, T.ss, { password: PW })).status).toBe(200);
    expect((await purge(S.jpg, T.su, { password: PW })).status).toBe(200);
    expect((await q('SELECT state FROM comms_media WHERE id IN (?, ?)', [S.rec1, S.jpg])).map(r => r.state)).toEqual(['purged', 'purged']);
    const all = JSON.stringify(await q('SELECT * FROM admin_audit_log'));
    expect(all).not.toContain(PW);
    expect((await audits()).map(x => x.status)).toEqual(['attempt', 'success', 'attempt', 'success']);
  });

  test('P3 five wrong passwords lock purge for the user (429, even with the right one); others unaffected', async () => {
    for (let i = 0; i < 5; i++) expect((await purge(S.rec1, T.ss, { password: 'nope' })).status).toBe(403);
    expect((await purge(S.rec1, T.ss, { password: PW })).status).toBe(429);
    expect((await purge(S.rec1, T.su, { password: PW })).status).toBe(200);
  });

  test('P3b a PARALLEL burst of wrong passwords gets exactly five guesses (review F1); a right password after it is locked out too', async () => {
    const burst = await Promise.all(Array.from({ length: 30 }, () => purge(S.rec1, T.ss, { password: 'guess' })));
    const codes = burst.map(r => r.status).sort();
    expect(codes.filter(c => c === 403)).toHaveLength(5);
    expect(codes.filter(c => c === 429)).toHaveLength(25);
    expect((await audits()).filter(a => a.status === 'rejected_bad_password')).toHaveLength(5);
    expect((await purge(S.rec1, T.ss, { password: PW })).status).toBe(429);
    expect((await q('SELECT state FROM comms_media WHERE id = ?', [S.rec1]))[0].state).toBe('archived');
  });

  test('P3c a RIGHT password does not use up an attempt; nor does "no password set"', async () => {
    for (let i = 0; i < 4; i++) expect((await purge(S.rec1, T.ss, { password: 'nope' })).status).toBe(403);
    await q("UPDATE app_settings SET `value` = '1,8' WHERE `key` = 'comms_archive_admins'");
    expect((await purge(S.recR, T.ss, { password: PW })).status).toBe(200);   // 4 failures + 1 right: still open
    expect((await purge(S.jpg, T.ss, { password: 'nope' })).status).toBe(403); // the 5th failure
    expect((await purge(S.pdf, T.ss, { password: PW })).status).toBe(429);
    for (let i = 0; i < 6; i++) expect((await purge(S.pdf, T.nohash, { password: 'x' })).json.code).toBe('no_password');
  });

  test('P4 an account without a password hash cannot purge (403 no_password); a non-admin never reaches the password check', async () => {
    await q("UPDATE app_settings SET `value` = '1,8' WHERE `key` = 'comms_archive_admins'");
    const r = await purge(S.rec1, T.nohash, { password: PW });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('no_password');
    const n = await purge(S.rec1, T.granted, { password: PW });
    expect(n.status).toBe(403);
    expect(n.json.code).toBeUndefined();
    expect((await audits()).map(x => x.status)).toEqual(['rejected_no_password', 'rejected_not_admin']);
  });

  test('P5 restrict / unrestrict need no password (reversible)', async () => {
    expect((await post(`/api/comms-archive/media/${S.rec1}/restrict`, { reason: 'private' }, { t: T.ss() })).status).toBe(200);
    expect((await url(S.rec1, T.granted)).status).toBe(404);
    expect((await post(`/api/comms-archive/media/${S.rec1}/unrestrict`, { reason: 'ok' }, { t: T.ss() })).status).toBe(200);
    expect((await url(S.rec1, T.granted)).status).toBe(200);
  });

  // ── H — health ──────────────────────────────────────────────────────────
  test('H1 SU + elevation: counts by kind/provider/state, oldest pending, jobs with their last run, open archive alerts only', async () => {
    // The llm half reads ai_calls / comms_summaries — tables other suites leave
    // behind in a shared _test DB. This test owns them: absent first, then
    // built here with rows of its own (never another suite's state).
    for (const t of ['ai_calls', 'comms_summaries', 'comms_redo']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    const [[job]] = await pool.query("SELECT id FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_media_sweep'");
    await q(`INSERT INTO job_results (job_id, attempt, status, output_data, duration_ms, execution_number) VALUES (?, 1, 'success', ?, 900, 1)`,
      [job.id, JSON.stringify({ archived: 3, discovered_mms: 2 })]);
    await q(`INSERT INTO system_alerts (source, kind, group_key, severity, title) VALUES
      ('comms_archive', 'x', 'comms_archive_cliff', 'error', 'cliff'), ('other', 'x', 'commsXarchive', 'error', 'not ours'),
      ('comms_archive', 'x', 'comms_archive_gone', 'error', 'resolved one')`);
    await q("UPDATE system_alerts SET resolved_at = UTC_TIMESTAMP() WHERE title = 'resolved one'");
    const r = await get('/api/comms-archive/health', { t: T.su(), headers: { 'X-SU-Elevation': mintElevationToken(U.SU) } });
    expect(r.status).toBe(200);
    expect(r.json.media).toEqual(expect.arrayContaining([
      { kind: 'call_recording', provider: 'ringcentral', state: 'archived', n: 3, restricted: 1 },
      { kind: 'mms_file', provider: 'ringcentral', state: 'pending', n: 1, restricted: 0 },
    ]));
    expect(r.json.pending).toEqual([expect.objectContaining({ kind: 'mms_file', provider: 'ringcentral', n: 1 })]);
    const media = r.json.jobs.find(j => j.key === 'comms_archive_media_sweep');
    expect(media.last).toMatchObject({ status: 'success', duration_ms: 900, output: { archived: 3, discovered_mms: 2 } });
    expect(r.json.jobs.map(j => j.key).sort()).toEqual(['comms_archive_media_sweep', 'comms_archive_sweep', 'comms_archive_verify']);
    expect(r.json.alerts.map(a => a.title)).toEqual(['cliff']);
    expect([r.json.transcripts, r.json.cost, r.json.redo]).toEqual([null, null, null]);   // S2 / S2c-2 not migrated
    await s2Tables();
    const r2 = await get('/api/comms-archive/health', { t: T.su(), headers: { 'X-SU-Elevation': mintElevationToken(U.SU) } });
    expect(r2.json.transcripts).toEqual({ by_state: [], skipped_by_reason: [], oldest_pending: null });
    expect(r2.json.cost).toEqual({ month_to_date_cents: { stt: 0, llm: null } });
    await q(`INSERT INTO comms_stt_jobs (transcript_id, media_id, role, variant, job_ref, state, est_cents, cost_cents, submitted_at)
             VALUES (1, ?, 'main', 'diarize', 'j1', 'completed', 4.5, 3.25, UTC_TIMESTAMP()),
                    (2, ?, 'main', 'diarize', 'j2', 'submitted', 2.0, NULL, UTC_TIMESTAMP())`,
      [S.rec1, S.recR]);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, skip_reason) VALUES (?, ?, 'skipped', 'over_cap'), (?, ?, 'pending', NULL)`,
      [S.rec1, S.call1, S.recR, S.callR]);
    const r3 = await get('/api/comms-archive/health', { t: T.su(), headers: { 'X-SU-Elevation': mintElevationToken(U.SU) } });
    expect(r3.json.cost).toEqual({ month_to_date_cents: { stt: 5.25, llm: null } });   // the ledger: billed 3.25 + estimate 2.00; no ai_calls table
    const { creates, alters } = schema.schemaFor(['ai_calls']);
    for (const st of [...creates, ...alters]) await pool.query(st);
    await q(`INSERT INTO ai_calls (consumer_ref, status, cost_cents) VALUES ('comms_transcript:1', 'ok', 1.5), ('something_else:9', 'ok', 40)`);
    const r4 = await get('/api/comms-archive/health', { t: T.su(), headers: { 'X-SU-Elevation': mintElevationToken(U.SU) } });
    expect(r4.json.cost).toEqual({ month_to_date_cents: { stt: 5.25, llm: 1.5 } });    // only the summaries' ai_calls
    await pool.query('DROP TABLE IF EXISTS ai_calls');
    expect(r3.json.transcripts.skipped_by_reason).toEqual([{ reason: 'over_cap', n: 1 }]);
    expect(r3.json.transcripts.by_state).toEqual([{ state: 'pending', n: 1 }, { state: 'skipped', n: 1 }]);
  });

  test('H2 not SU → 403; SU without elevation → 401 elevation_required; the archive admin list grants nothing here', async () => {
    expect((await get('/api/comms-archive/health', { t: T.ss() })).status).toBe(403);
    const r = await get('/api/comms-archive/health', { t: T.su() });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('elevation_required');
  });

  // ── R — redo (S2c-2): the route's gates and audit. The behaviour is tested in commsTranscribe.mysql (RD*). ──
  const elev = () => ({ 'X-SU-Elevation': mintElevationToken(U.SU) });
  const det = (a) => (typeof a.details === 'string' ? JSON.parse(a.details) : a.details) || {};
  const redoAudits = async () => (await audits()).filter(a => /^redo_/.test(det(a).action || ''));
  async function redoScene() {
    await s2Tables();
    for (const t of ['comms_summaries', 'comms_redo']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const f of ['2026-10-15_comms_s3_summaries.sql', '2026-10-15_comms_s2c_max_speakers.sql', '2026-10-15_comms_s2c_redo.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
    await q("UPDATE app_settings SET `value` = 'on' WHERE `key` = 'comms_transcribe_mode'");
    await q('UPDATE comms_media SET audio_channels = 1, duration_s = 60 WHERE id = ?', [S.rec1]);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, stt_vendor, stt_model, speakers, segments, full_text)
             VALUES (?, ?, 'transcribed', 'assemblyai', 'universal-3-5-pro+diarize', 4, '[{"s":"A","a":0,"b":1,"t":"secret words"}]', 'secret words')`,
      [S.rec1, S.call1]);
  }

  test('R1 redo: SU + step-up only — a listed archive admin 403, an API key 403, SU without step-up 401; a dry run changes nothing and is audited with ids and counts, never content', async () => {
    await redoScene();
    const body = { mode: 'transcript', select: { mono_min_speakers: 3 } };
    expect((await post('/api/comms-archive/redo', body, { t: T.ss() })).status).toBe(403);
    expect((await post('/api/comms-archive/redo', body, { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
    const noStep = await post('/api/comms-archive/redo', body, { t: T.su() });
    expect(noStep.status).toBe(401);
    expect(noStep.json.code).toBe('elevation_required');
    const r = await post('/api/comms-archive/redo', body, { t: T.su(), headers: elev() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'success', outcome: 'dry_run', eligible: 1, batch: 1, media_ids: [S.rec1] });
    expect((await q('SELECT state FROM comms_transcripts WHERE media_id = ?', [S.rec1]))[0].state).toBe('transcribed');
    const rows = await redoAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', user_id: U.SU });
    expect(det(rows[0])).toMatchObject({ action: 'redo_transcript', apply: false, outcome: 'dry_run', eligible: 1, batch: 1,
      select: { mono_min_speakers: 3 }, media_ids: [S.rec1] });
    expect(JSON.stringify(rows)).not.toMatch(/secret words/);
  });

  test('R2 redo: a bad body 400, over the cap 409 (refused, nothing changed), an apply 200 with the marker\'s who; applies are rate-limited, dry runs are not; every call audited', async () => {
    await redoScene();
    archiveRouter._resetRedoLimit(2);
    const go = (body) => post('/api/comms-archive/redo', body, { t: T.su(), headers: elev() });
    const one = { mode: 'transcript', select: { media_ids: [S.rec1] } };
    const b400 = await go({ mode: 'transcript', select: { mono_min_speakers: 1 } });
    expect(b400.status).toBe(400);
    expect(b400.json.message).toMatch(/2–50/);
    await q("UPDATE app_settings SET `value` = '0' WHERE `key` = 'comms_ai_monthly_cap_cents'");
    const r409 = await go({ ...one, apply: true });
    expect(r409.status).toBe(409);
    expect(r409.json).toMatchObject({ status: 'error', code: 'over_cap', outcome: 'refused' });
    expect((await q('SELECT state FROM comms_transcripts WHERE media_id = ?', [S.rec1]))[0].state).toBe('transcribed');
    await q("UPDATE app_settings SET `value` = '7500' WHERE `key` = 'comms_ai_monthly_cap_cents'");
    await q('UPDATE comms_transcripts SET created_at = UTC_TIMESTAMP() - INTERVAL 5 DAY WHERE media_id = ?', [S.rec1]);
    const ok = await go({ ...one, apply: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'success', outcome: 'applied', applied: 1, media_ids: [S.rec1] });
    expect(await q('SELECT requested_by FROM comms_redo')).toEqual([{ requested_by: U.SU }]);
    expect((await go({ ...one, apply: true })).status).toBe(429);
    expect((await go(one)).status).toBe(200);                                   // a dry run is not counted
    const h = await get('/api/comms-archive/health', { t: T.su(), headers: elev() });   // the redo in the health read
    expect(h.json.redo).toEqual({ count: 1, oldest_requested_at: expect.any(String), by_state: [{ state: 'pending', n: 1 }] });
    expect(Date.now() - new Date(h.json.transcripts.oldest_pending).getTime()).toBeLessThan(3600_000);   // waiting since the REQUEST, not the 5-day-old row
    expect((await redoAudits()).map(a => [a.status, det(a).apply, det(a).refusal || null])).toEqual([
      ['rejected_bad_request', false, null], ['refused', true, 'over_cap'], ['success', true, null],
      ['rejected_rate_limited', true, null], ['success', false, null]]);
  });

  // ── RS — per-call re-summarise (S3c): the route's gates, contract and audit. The behaviour: commsSummarize.mysql (SC*). ──
  async function rsScene() {
    await redoScene();
    for (const t of ['comms_summary_guides']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    for (const f of ['2026-10-16_comms_s3c_summary_guides.sql', '2026-10-15_comms_s3b_firm_context.sql']) {
      for (const st of schema.migrationStatements(f)) await pool.query(st);
    }
    await q('DELETE FROM comms_summaries');
    await q("UPDATE app_settings SET `value` = 'on' WHERE `key` = 'comms_summarize_mode'");
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, stt_vendor, segments, full_text)
             VALUES (?, ?, 'transcribed', 'assemblyai', '[{"s":"A","a":0,"b":1,"t":"private words"}]', 'private words')`, [S.recR, S.callR]);
  }
  const rsAudits = async () => (await audits()).filter(a => det(a).action === 'resummarize');

  test('RS1 resummarize: a granted staff user gets the contract; not readable → the same 404; an API key → 403; restricted → 409 even for an archive admin; a bad model → 400; audited with the note LENGTH, never its text', async () => {
    await rsScene();
    const path = (id) => `/api/comms-archive/media/${id}/resummarize`;
    expect((await post(path(S.rec1), {}, { t: T.nobody() })).status).toBe(404);
    expect((await post(path(S.rec1), {}, { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
    const ok = await post(path(S.rec1), { note: 'About the Chase car loan; the caller is the wife.' }, { t: T.granted() });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ status: 'success', media_id: S.rec1, model: 'claude-sonnet-5-5', has_note: true,
      requested_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), summary_pending: true });
    expect(await q('SELECT model, note_by, requested_by, outcome FROM comms_summary_guides')).toEqual([
      { model: 'claude-sonnet-5-5', note_by: U.GRANTED, requested_by: U.GRANTED, outcome: null }]);
    const rr = await post(path(S.recR), {}, { t: T.ss() });
    expect([rr.status, rr.json.code]).toEqual([409, 'restricted']);
    const bad = await post(path(S.rec1), { model: 'gpt-9' }, { t: T.granted() });
    expect([bad.status, bad.json.code]).toEqual([400, 'bad_request']);
    const rows = await rsAudits();
    expect(rows.map(a => [a.status, det(a).media_id, det(a).note_len])).toEqual([
      ['rejected_no_grant', S.rec1, undefined], ['rejected_not_jwt', S.rec1, undefined],   // the gate's own rejections
      ['success', S.rec1, 49], ['rejected_restricted', S.recR, 0], ['rejected_bad_request', S.rec1, 0]]);
    expect(det(rows[2])).toMatchObject({ action: 'resummarize', model: 'claude-sonnet-5-5', note_len: 49 });
    expect(JSON.stringify(await rsAudits())).not.toMatch(/Chase|wife/);
  });

  test('RS2 resummarize is rate-limited per user (429, audited); another user is not affected', async () => {
    await rsScene();
    archiveRouter._resetResummarizeLimit(2);
    const go = (t) => post(`/api/comms-archive/media/${S.rec1}/resummarize`, {}, { t });
    expect((await go(T.granted())).status).toBe(200);
    expect((await go(T.granted())).status).toBe(200);                       // a pending request may be replaced
    expect((await go(T.granted())).status).toBe(429);
    expect((await go(T.su())).status).toBe(200);
    expect((await rsAudits()).map(a => a.status)).toEqual(['success', 'success', 'rejected_rate_limited', 'success']);
  });

  // ── unit — view helpers ─────────────────────────────────────────────────
  test('U1 viewOf: only the serving allowlist is viewable inline', () => {
    expect(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'audio/mp4', 'image/heic', 'video/3gpp', 'text/vcard', 'application/octet-stream', 'image/svg+xml']
      .map(view.viewOf)).toEqual(['image', 'image', 'image', 'image', 'pdf', 'audio', 'file', 'file', 'file', 'file', 'file']);
  });
});
