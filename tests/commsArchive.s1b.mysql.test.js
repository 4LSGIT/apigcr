/**
 * REAL-ENGINE suite for comms archive S1b on MySQL with the production schema
 * and sql_mode:
 *   D   discovery — Quo answered calls only; MMS one row per attachment (RC
 *       id / Quo ordinal), a message's attachments always together, malformed
 *       log rows harmless; idempotent;
 *   Q   Quo recordings — list → placeholder fill + split, statuses, the
 *       docs-only shape guard (drift parks + alerts, never `none`), signed
 *       downloads with host-only errors;
 *   M   MMS — RC message-store content, Quo fresh media URLs, the storable /
 *       error-shaped / unknown-type rule;
 *   T   the no-cliff terminal rule (one helper, keyed by kind/provider);
 *   V   nightly delete detection;
 *   A   R9 (isArchiveAdmin) + the restrict / unrestrict / purge routes, the
 *       audit trail, purge end to end, and purge vs. an in-flight sweep.
 *
 * Stand-ins only at the boundaries: GCS (tests/helpers/fakeGcs.js) and the
 * provider adapters (opts.rc / opts.quo). Routes run the REAL router, auth
 * middleware and services over an ephemeral express app.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A throwaway *_test database; the suite builds its own tables from
 * ref/database.sql and applies both comms migrations from disk. UTC server.
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_test npx jest tests/commsArchive.s1b.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-s1b-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_s1b_internal';
process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const crypto = require('crypto');
const { Readable } = require('stream');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'log', 'users', 'system_alerts', 'alert_state',
  'app_settings', 'scheduled_jobs', 'admin_audit_log', 'jwt_api_audit_log'];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

maybe('comms archive S1b on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const media   = require('../services/commsArchiveMediaSweep');
  const verify  = require('../services/commsArchiveVerify');
  const admin   = require('../services/commsArchiveAdmin');
  const ORIG = { media: { ...media.limits }, admin: { ...admin.limits }, verify: { ...verify.limits } };
  const router = require('../routes/api.commsArchive');

  let pool, gcs, rcF, quoF, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const rows = () => q('SELECT * FROM comms_media ORDER BY id');
  const alerts = () => q('SELECT group_key, severity, title, message FROM system_alerts ORDER BY id');

  // ── fixtures ────────────────────────────────────────────────────────────
  let nextId = 5000, nextLog = 90000;
  async function call({ provider = 'quo', line = '2484179800', status = 'completed', ageDays = 5, suppressed = 0 } = {}) {
    const id = ++nextId;
    const t = daysAgo(ageDays);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, raw_extra, processed_at)
             VALUES (?, ?, ?, 'call', 'incoming', '2489148845', ?, '2489148845', ?, ?, ?)`,
      [id, provider, `AC${id}`, line, suppressed,
        JSON.stringify({ line, provider, started_at: t.toISOString(), ended_at: t.toISOString().replace('Z', '+00:00'),
          recording_id: '', provider_status: status }), new Date(t.getTime() + 60_000)]);
    return id;
  }
  async function sms({ provider = 'ringcentral', line = '2485592400', logData, ageDays = 3, suppressed = 0, ref } = {}) {
    const id = ++nextId;
    const logId = ++nextLog;
    const t = daysAgo(ageDays);
    await q('INSERT INTO log (log_id, log_data) VALUES (?, ?)', [logId, typeof logData === 'string' ? logData : JSON.stringify(logData)]);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, log_id, raw_extra, processed_at)
             VALUES (?, ?, ?, 'sms', 'incoming', '2489148845', ?, '2489148845', ?, ?, ?, ?)`,
      [id, provider, ref || (provider === 'quo' ? `AC${id}` : String(3091000000000 + id)), line, suppressed, logId,
        JSON.stringify({ ts: t.toISOString(), line, provider }), new Date(t.getTime() + 2000)]);
    return id;
  }
  const audio = (buf, extra = {}) => ({ status: 200, contentType: 'audio/mpeg', contentLength: buf.length, body: Readable.from([buf]), host: 'files.quo.example', ...extra });
  const file  = (buf, type, extra = {}) => ({ status: 200, contentType: type, contentLength: buf.length, body: Readable.from([buf]), rate: {}, ...extra });

  function makeRc() {
    const f = { auth: true, calls: [], att: {},
      async checkArchiveAuth() { return f.auth; },
      async fetchMessageAttachment(_db, { messageId, attachmentId }) {
        f.calls.push([messageId, attachmentId]);
        const r = f.att[attachmentId];
        return typeof r === 'function' ? r() : (r || file(Buffer.from(`img-${attachmentId}`), 'image/png'));
      },
    };
    return f;
  }
  function makeQuo() {
    const f = { auth: true, calls: [], recs: {}, msgs: {}, urls: {},
      async checkArchiveAuth() { return f.auth; },
      async listCallRecordings(_db, { callId }) {
        f.calls.push(['rec', callId]);
        const r = f.recs[callId];
        return typeof r === 'function' ? r() : (r || { status: 200, json: { data: [] } });
      },
      async getMessage(_db, { messageId }) {
        f.calls.push(['msg', messageId]);
        const r = f.msgs[messageId];
        return typeof r === 'function' ? r() : (r || { status: 404, json: null, errorText: 'nf' });
      },
      async fetchSigned(url) {
        f.calls.push(['get', url]);
        if (!/^https:/.test(url)) throw Object.assign(new Error('not an https URL'), { code: 'BAD_URL' });
        const r = f.urls[url];
        return typeof r === 'function' ? r() : (r || { status: 404, host: new URL(url).host, body: null });
      },
    };
    return f;
  }
  const runMedia = () => media.runMediaSweep(pool, { rc: rcF, quo: quoF });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await schema.build(pool, TABLES);
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql', '2026-10-14_comms_s1b.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    archive._test.setStorage(null);
    Object.assign(media.limits, ORIG.media);
    Object.assign(admin.limits, ORIG.admin);
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    Object.assign(media.limits, ORIG.media, { sleep: async () => {}, rcMediumSpacingMs: 0, quoSpacingMs: 0 });
    Object.assign(admin.limits, ORIG.admin, { lockWaitS: 0 });
    Object.assign(verify.limits, ORIG.verify);
    router._resetPurgeLimit();
    for (const t of ['comms_media', 'phone_event_log', 'log', 'system_alerts', 'alert_state', 'phone_lines', 'users', 'admin_audit_log']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, provider_id, credential_id) VALUES
      (1, '2485592400', 'ringcentral', 1, NULL, 9), (4, '2486213656', 'ringcentral', 1, NULL, 9),
      (2, '2489654574', 'quo', 1, 'PNa', 10), (6, '2484179800', 'quo', 1, 'PNb', 10)`);
    await q(`INSERT INTO users (user, user_name, roles, user_auth) VALUES
      (1, 'SS', 'staff,attorney', 'authorized'), (3, 'Staff', 'staff', 'authorized'), (6, 'SU', 'it,admin,su', 'authorized'),
      (7, 'Legacy', 'it,admin', 'authorized - SU')`);   // 7: the pre-A2 SU shape WITHOUT the su role — not SU since A2b
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_enabled'");
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_admins'");
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    rcF = makeRc();
    quoF = makeQuo();
  });

  // ── M0 — migration ──────────────────────────────────────────────────────
  test('M0 migration applied twice: admins list seeded "1" not editable, two job rows', async () => {
    const [s] = await q("SELECT `value`, is_editable FROM app_settings WHERE `key` = 'comms_archive_admins'");
    expect(s).toMatchObject({ value: '1', is_editable: 0 });
    const jobs = await q("SELECT idempotency_key, recurrence_rule, max_attempts FROM scheduled_jobs WHERE idempotency_key LIKE 'comms_archive_%' ORDER BY idempotency_key");
    expect(jobs.map(j => [j.idempotency_key, j.recurrence_rule, j.max_attempts])).toEqual([
      ['comms_archive_media_sweep', '*/2 * * * *', 1],
      ['comms_archive_sweep', '*/2 * * * *', 1],
      ['comms_archive_verify', '15 7 * * *', 1],
    ]);
  });

  // ── D — discovery ───────────────────────────────────────────────────────
  test('D1 Quo calls: completed only (no-answer has ring-time duration too); suppressed / RC excluded; idempotent', async () => {
    const yes = await call({ status: 'completed' });
    await call({ status: 'no-answer' });
    await call({ status: 'completed', suppressed: 1 });
    await call({ provider: 'ringcentral', line: '2485592400' });
    expect(await media.discoverQuoCalls(pool)).toBe(1);
    expect(await media.discoverQuoCalls(pool)).toBe(0);
    const [r] = await rows();
    expect(r).toMatchObject({ source_id: yes, kind: 'call_recording', provider: 'quo', part: '', channel_id: 6, state: 'pending' });
  });

  test('D2 MMS: one row per attachment, message-limited, malformed rows harmless, idempotent', async () => {
    const rcMsg = await sms({ logData: { attachments: [{ id: '855604942019', type: 'MmsAttachment', contentType: 'image/jpeg' }, { id: 855604942020, contentType: 'image/png' }] } });
    const quoMsg = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/a.jpg?sig=x' }, { url: 'https://share.quo.com/b.pdf?sig=y' }, { url: 'https://share.quo.com/c.png?sig=z' }] } });
    await sms({ logData: '{"attachments": [ {"id": broken' });           // invalid JSON (log_data is TEXT)
    await sms({ logData: { attachments: { id: 'not-an-array' } } });
    await sms({ logData: { attachments: [] } });
    await sms({ logData: { text: 'no attachments' } });
    await sms({ logData: { attachments: [{ id: '9' }] }, suppressed: 1 });
    await sms({ logData: { attachments: ['scalar'] } });                 // RC element without an id

    media.limits.discoverLimit = 1;                                      // limit is per MESSAGE
    expect(await media.discoverMms(pool)).toBe(2);                       // rcMsg's two, together
    media.limits.discoverLimit = 200;
    expect(await media.discoverMms(pool)).toBe(4);                       // quo 3 + the scalar one
    expect(await media.discoverMms(pool)).toBe(0);
    const by = (await rows()).map(r => [r.source_id, r.part, r.provider]);
    expect(by).toEqual(expect.arrayContaining([
      [rcMsg, '855604942019', 'ringcentral'], [rcMsg, '855604942020', 'ringcentral'],
      [quoMsg, 'q1', 'quo'], [quoMsg, 'q2', 'quo'], [quoMsg, 'q3', 'quo'],
    ]));
    const scalar = (await rows()).find(r => r.part === 'r1');
    expect(scalar).toBeTruthy();                                         // fetch will call it drift
    const [m] = await q('SELECT captured_at FROM comms_media WHERE source_id = ? LIMIT 1', [rcMsg]);
    const [e] = await q('SELECT JSON_VALUE(raw_extra, "$.ts") ts FROM phone_event_log WHERE id = ?', [rcMsg]);
    expect(Math.abs(new Date(m.captured_at) - new Date(e.ts))).toBeLessThan(1000);
  });

  // ── Q — Quo recordings ──────────────────────────────────────────────────
  test('Q1 list → fill + split; completed downloads, processing parks, then completes', async () => {
    const id = await call();
    quoF.recs[`AC${id}`] = { status: 200, json: { data: [
      { id: 'RECa', url: 'https://files.quo.example/a?sig=1', type: 'audio/mpeg', status: 'completed', duration: 60, startTime: null },
      { id: 'RECb', url: null, type: null, status: 'processing', duration: null, startTime: null },
    ] } };
    quoF.urls['https://files.quo.example/a?sig=1'] = () => audio(Buffer.from('quo-a'), { contentType: 'application/octet-stream' });
    let out = await runMedia();
    expect(out).toMatchObject({ resolved: 1, split: 1, archived: 1, not_yet: 1 });
    let rs = await rows();
    expect(rs.map(r => [r.part, r.state])).toEqual([['RECa', 'archived'], ['RECb', 'pending']]);
    expect(rs[0]).toMatchObject({ mime: 'audio/mpeg', sha256: sha(Buffer.from('quo-a')) });
    expect(rs[0].object_name).toMatch(new RegExp(`^phone/rec/\\d{4}/\\d{2}/${id}-RECa\\.mp3$`));
    expect(rs[1]).toMatchObject({ attempts: 0 });                      // processing is uncharged
    // RECb completes
    quoF.recs[`AC${id}`].json.data[1] = { id: 'RECb', url: 'https://files.quo.example/b?sig=2', type: 'audio/mpeg', status: 'completed', duration: 3, startTime: null };
    quoF.urls['https://files.quo.example/b?sig=2'] = () => audio(Buffer.from('quo-b'));
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    out = await runMedia();
    expect(out.archived).toBe(1);
    expect((await rows()).every(r => r.state === 'archived')).toBe(true);
    expect(await media.discoverQuoCalls(pool)).toBe(0);                 // rediscovery stable
  });

  test('Q2 docs-only shapes: drift parks UNCHARGED + one alert/day, never none', async () => {
    const cases = [
      { status: 200, json: {} },                                         // data missing
      { status: 200, json: { data: { id: 'x' } } },                      // data not an array
      { status: 200, json: undefined },                                  // unparseable 200
      { status: 200, json: { data: [{ url: 'https://x/y' }] } },         // item without id
    ];
    const ids = [];
    for (const c of cases) { const id = await call({ ageDays: 10 }); ids.push(id); quoF.recs[`AC${id}`] = c; }
    const out = await runMedia();
    expect(out).toMatchObject({ drift: 4, none: 0 });
    for (const r of await rows()) {
      expect(r).toMatchObject({ state: 'pending', attempts: 0 });
      expect(r.last_error).toMatch(/^shape drift: /);
    }
    const d = (await alerts()).filter(a => a.group_key === 'comms_archive_shape_drift');
    expect(d.length).toBe(1);
    expect(d[0].severity).toBe('error');
  });

  test('Q3 unknown status / unlisted id = drift; deleted = gone; absent = none; data: [] = none only when old', async () => {
    const a = await call(); const b = await call(); const c = await call(); const d = await call();
    const young = await call({ ageDays: 0.1 }); const old = await call({ ageDays: 3 });
    for (const [id, part] of [[a, 'R1'], [b, 'R2'], [c, 'R3'], [d, 'R4']]) {
      await media.discoverQuoCalls(pool);
      await q("UPDATE comms_media SET part = ? WHERE source_id = ?", [part, id]);
    }
    await media.discoverQuoCalls(pool);
    quoF.recs[`AC${a}`] = { status: 200, json: { data: [{ id: 'R1', status: 'transcoding', url: null }] } };
    quoF.recs[`AC${b}`] = { status: 200, json: { data: [{ id: 'OTHER', status: 'completed', url: 'https://x/y' }] } };
    quoF.recs[`AC${c}`] = { status: 200, json: { data: [{ id: 'R3', status: 'deleted', url: null }] } };
    quoF.recs[`AC${d}`] = { status: 200, json: { data: [{ id: 'R4', status: 'absent', url: null }] } };
    quoF.recs[`AC${young}`] = { status: 200, json: { data: [] } };
    quoF.recs[`AC${old}`] = { status: 200, json: { data: [] } };
    const out = await runMedia();
    const st = Object.fromEntries((await rows()).map(r => [r.source_id, r]));
    expect(st[a]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(st[a].last_error).toMatch(/unknown status "transcoding"/);
    expect(st[b].last_error).toMatch(/no longer listed/);
    expect(st[c].state).toBe('gone');
    expect(st[d].state).toBe('none');
    expect(st[young]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(st[old].state).toBe('none');
    expect(out).toMatchObject({ drift: 2, gone: 1 });
  });

  test('Q4 signed-URL errors carry the HOST only, never the signature; non-https = drift', async () => {
    const id = await call(); const id2 = await call();
    quoF.recs[`AC${id}`] = { status: 200, json: { data: [{ id: 'S1', status: 'completed', url: 'https://cdn.quo.example/r?sig=TOPSECRET', type: 'audio/mpeg' }] } };
    quoF.recs[`AC${id2}`] = { status: 200, json: { data: [{ id: 'S2', status: 'completed', url: 'http://cdn.quo.example/r?sig=TOPSECRET2', type: 'audio/mpeg' }] } };
    quoF.urls['https://cdn.quo.example/r?sig=TOPSECRET'] = { status: 403, host: 'cdn.quo.example', body: null };
    await runMedia();                       // resolve + download happen in the same tick
    const by = Object.fromEntries((await rows()).map(r => [r.part, r]));
    expect(by.S1).toMatchObject({ state: 'pending', attempts: 1 });
    expect(by.S1.last_error).toMatch(/download cdn\.quo\.example: 403/);
    expect(by.S2.last_error).toMatch(/shape drift: recording url not an https URL/);
    const everything = JSON.stringify(await rows()) + JSON.stringify(await alerts());
    expect(everything).not.toMatch(/TOPSECRET/);
  });

  // ── M — MMS ─────────────────────────────────────────────────────────────
  test('M1 RC MMS: stored under phone/mms; error-shaped refused; unknown type → .bin + note; 404 gone only when old', async () => {
    const ok = await sms({ logData: { attachments: [{ id: '11' }] } });
    await sms({ logData: { attachments: [{ id: '12' }] } });
    await sms({ logData: { attachments: [{ id: '13' }] } });
    await sms({ logData: { attachments: [{ id: '14' }] }, ageDays: 0.1 });
    await sms({ logData: { attachments: [{ id: '15' }] }, ageDays: 3 });
    rcF.att['12'] = () => file(Buffer.from('{"err":1}'), 'application/json');
    rcF.att['13'] = () => file(Buffer.from('BEGIN:WEIRD'), 'application/x-weird');
    rcF.att['14'] = { status: 404, body: null, rate: {} };
    rcF.att['15'] = { status: 404, body: null, rate: {} };
    await sms({ line: '2486213656', logData: { attachments: [{ id: '16' }] } });   // rc2: same path
    const out = await runMedia();
    const by = Object.fromEntries((await rows()).map(r => [r.part, r]));
    expect(by['11']).toMatchObject({ state: 'archived', mime: 'image/png', sha256: sha(Buffer.from('img-11')) });
    expect(by['11'].object_name).toMatch(new RegExp(`^phone/mms/\\d{4}/\\d{2}/${ok}-11\\.png$`));
    expect(by['12']).toMatchObject({ state: 'pending', attempts: 1 });
    expect(by['12'].last_error).toMatch(/error-shaped/);
    expect(by['13']).toMatchObject({ state: 'archived', mime: 'application/octet-stream' });
    expect(by['13'].object_name).toMatch(/-13\.bin$/);
    expect(by['13'].last_error).toMatch(/provider type: application\/x-weird/);
    expect(by['14']).toMatchObject({ state: 'pending', attempts: 1 });
    expect(by['15'].state).toBe('gone');
    expect(by['16']).toMatchObject({ state: 'archived', channel_id: 4 });
    expect(rcF.calls).toEqual(expect.arrayContaining([[expect.any(String), '16']]));
    expect(out.rc_used).toBe(6);
  });

  test('M2 Quo MMS: fresh media URL by ordinal (stored link never reused); missing media / ordinal = drift', async () => {
    const m1 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/OLD.jpg?sig=stale' }] } });
    const m2 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/x?sig=1' }, { url: 'https://share.quo.com/y?sig=2' }] } });
    const m3 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/z?sig=3' }] } });
    quoF.msgs[`AC${m1}`] = { status: 200, json: { data: { id: `AC${m1}`, media: [{ url: 'https://share.quo.com/FRESH.jpg?sig=new', type: 'image/jpeg' }] } } };
    quoF.urls['https://share.quo.com/FRESH.jpg?sig=new'] = () => ({ status: 200, host: 'share.quo.com', contentType: 'application/octet-stream', contentLength: 4, body: Readable.from([Buffer.from('jpeg')]) });
    quoF.msgs[`AC${m2}`] = { status: 200, json: { data: { id: `AC${m2}`, media: [{ url: 'https://share.quo.com/only-one', type: 'image/png' }] } } };
    quoF.urls['https://share.quo.com/only-one'] = () => ({ status: 200, host: 'share.quo.com', contentType: 'image/png', contentLength: 3, body: Readable.from([Buffer.from('png')]) });
    quoF.msgs[`AC${m3}`] = { status: 200, json: { data: { id: `AC${m3}` } } };   // media missing
    await runMedia();
    const by = Object.fromEntries((await rows()).map(r => [`${r.source_id}:${r.part}`, r]));
    expect(by[`${m1}:q1`]).toMatchObject({ state: 'archived', mime: 'image/jpeg' });
    expect(by[`${m2}:q1`]).toMatchObject({ state: 'archived', mime: 'image/png' });
    expect(by[`${m2}:q2`]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[`${m2}:q2`].last_error).toMatch(/media\[1\] missing \(1 listed\)/);
    expect(by[`${m3}:q1`].last_error).toMatch(/media is missing/);
    expect(quoF.calls.filter(c => c[0] === 'get').map(c => c[1])).not.toContain('https://share.quo.com/OLD.jpg?sig=stale');
  });

  test('M3 a provider budget stops THAT provider, not the tick', async () => {
    media.limits.rcMediumPerTick = 1;
    for (let i = 0; i < 3; i++) await sms({ logData: { attachments: [{ id: String(200 + i) }] } });
    const qm = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/a' }] } });
    quoF.msgs[`AC${qm}`] = { status: 200, json: { data: { media: [{ url: 'https://share.quo.com/f', type: 'image/gif' }] } } };
    quoF.urls['https://share.quo.com/f'] = () => ({ status: 200, host: 'share.quo.com', contentType: 'image/gif', contentLength: 3, body: Readable.from([Buffer.from('gif')]) });
    const out = await runMedia();
    expect(out).toMatchObject({ rc_used: 1, archived: 2 });
    expect(out.stopped.ringcentral).toBe('budget');
    expect((await rows()).filter(r => r.state === 'pending').every(r => r.attempts === 0)).toBe(true);
  });

  // ── T — the no-cliff terminal rule ──────────────────────────────────────
  test('T1 no-cliff kinds: stuck → failed after the plateau; no_line → failed 30 d after created', async () => {
    Object.assign(media.limits, { maxAttempts: 1, noCliffDays: 0.004 });   // plateau = 1 step of 6 h
    await sms({ logData: { attachments: [{ id: '31' }] } });
    rcF.att['31'] = { status: 503, body: null, rate: {} };
    let out = await runMedia();
    expect(out.stuck).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: 'pending', attempts: 1 });
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    out = await runMedia();
    expect(out.failed).toBe(1);
    expect((await rows())[0].state).toBe('failed');
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_failed').map(a => a.severity)).toEqual(['error']);

    // no_line (the group-MMS line shape): pending uncharged, then failed by created_at age
    for (const t of ['comms_media', 'phone_event_log', 'log', 'system_alerts']) await q(`TRUNCATE TABLE \`${t}\``);
    Object.assign(media.limits, ORIG.media, { sleep: async () => {}, rcMediumSpacingMs: 0, quoSpacingMs: 0 });
    await sms({ provider: 'quo', line: '1248559240012489654574', logData: { attachments: [{ url: 'https://share.quo.com/g' }] } });
    out = await runMedia();
    expect(out.no_line).toBe(1);
    expect((await rows())[0]).toMatchObject({ state: 'pending', attempts: 0, last_error: 'no_line' });
    await q('UPDATE comms_media SET next_attempt_at = NULL, created_at = UTC_TIMESTAMP() - INTERVAL 31 DAY');
    out = await runMedia();
    expect(out.failed).toBe(1);
    expect((await rows())[0].last_error).toMatch(/no_line for 30 days/);
  });

  // ── V — delete detection ────────────────────────────────────────────────
  test('V1 rolling 1/14: missing (not purged) → error alert + stamp; present ok; _s0 skipped', async () => {
    const ins = async (id, name, state = 'archived') => q(
      `INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name)
       VALUES (?, 'phone', 'mms_file', 'phone_event_log', ?, 'p', 'ringcentral', ?, ?)`, [id, id, state, name]);
    await ins(14, 'phone/mms/2026/10/14-p.jpg');          // slice 0, present
    await ins(28, 'phone/mms/2026/10/28-p.jpg');          // slice 0, MISSING
    await ins(42, '_s0/probe.txt');                       // slice 0, probe — skipped
    await ins(56, 'phone/mms/2026/10/56-p.jpg', 'purged');// slice 0, purged — not selected
    await ins(15, 'phone/mms/2026/10/15-p.jpg');          // slice 1 — not tonight
    gcs.objects.set('phone/mms/2026/10/14-p.jpg', { buf: Buffer.from('x'), contentType: 'image/jpeg', generation: '1' });
    const out = await verify.runVerify(pool, { slice: 0 });
    expect(out).toMatchObject({ selected: 2, checked: 2, missing: 1, stop: 'done' });
    const [m] = await q('SELECT state, last_error FROM comms_media WHERE id = 28');
    expect(m).toMatchObject({ state: 'archived' });
    expect(m.last_error).toMatch(/^verify: missing /);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_missing').map(a => a.severity)).toEqual(['error']);
    // a GCS failure never reports missing
    await q('TRUNCATE TABLE system_alerts');
    await q("UPDATE comms_media SET last_error = NULL");
    gcs.fail.exists = { code: 403 };
    const o2 = await verify.runVerify(pool, { slice: 0 });
    expect(o2).toMatchObject({ stop: 'storage', missing: 0 });
    expect((await alerts()).map(a => a.group_key)).toEqual(['comms_archive_storage']);
    expect(verify.sliceFor(new Date(14 * 86400_000))).toBe(0);
  });

  test('V3 the WHOLE slice is paged (401 rows, the highest missing, is found); `_` in _s0/ is escaped', async () => {
    Object.assign(verify.limits, { pageSize: 50 });
    const vals = [];
    for (let i = 1; i <= 401; i++) vals.push(`(${i * 7}, 'phone', 'mms_file', 'phone_event_log', ${i * 7}, 'p', 'ringcentral', 'archived', 'phone/mms/2026/10/${i * 7}-p.jpg')`);
    await q(`INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name) VALUES ${vals.join(',')}`);
    for (let i = 1; i < 401; i++) gcs.objects.set(`phone/mms/2026/10/${i * 7}-p.jpg`, { buf: Buffer.from('x'), contentType: 'image/jpeg', generation: '1' });
    // an object whose name an UNESCAPED '_s0/%' would match ('x' for '_') is still checked
    await q(`INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name)
             VALUES (7000, 'phone', 'mms_file', 'phone_event_log', 7000, 'p', 'ringcentral', 'archived', 'xs0/phone.jpg')`);
    const out = await verify.runVerify(pool, { slice: 0 });
    expect(out).toMatchObject({ selected: 402, checked: 402, missing: 2, stop: 'done' });
    const missing = await q("SELECT id FROM comms_media WHERE last_error LIKE 'verify: missing%' ORDER BY id");
    expect(missing.map(m => m.id)).toEqual([2807, 7000]);
    Object.assign(verify.limits, ORIG.verify);
  });

  test('V4 a slice that cannot finish alerts (warning, then error)', async () => {
    await q(`INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name)
             VALUES (7, 'phone', 'mms_file', 'phone_event_log', 7, 'p', 'ringcentral', 'archived', 'phone/mms/2026/10/7-p.jpg')`);
    Object.assign(verify.limits, { deadlineMs: 0 });
    expect((await verify.runVerify(pool, { slice: 0 })).stop).toBe('deadline');
    await verify.runVerify(pool, { slice: 0 });
    const inc = (await alerts()).filter(a => a.group_key === 'comms_archive_verify_incomplete');
    expect(inc.map(a => a.severity)).toEqual(['warning', 'error']);
    Object.assign(verify.limits, ORIG.verify);
  });

  test('V5 a purge landing between the stat and the stamp is never reported missing (guarded stamp)', async () => {
    await q(`INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name)
             VALUES (21, 'phone', 'mms_file', 'phone_event_log', 21, 'p', 'ringcentral', 'archived', 'phone/mms/2026/10/21-p.jpg')`);
    gcs.hooks.exists = async () => { await q("UPDATE comms_media SET state = 'purged' WHERE id = 21"); };
    const out = await verify.runVerify(pool, { slice: 0 });
    gcs.hooks.exists = null;
    expect(out).toMatchObject({ checked: 1, missing: 0 });
    expect((await q('SELECT last_error FROM comms_media WHERE id = 21'))[0].last_error).toBeNull();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_missing')).toEqual([]);
  });

  test('V2 delete detection runs with the kill switch OFF (a delete during a pause still pages)', async () => {
    await q(`INSERT INTO comms_media (id, channel, kind, source_table, source_id, part, provider, state, object_name)
             VALUES (70, 'phone', 'mms_file', 'phone_event_log', 70, 'p', 'ringcentral', 'archived', 'phone/mms/2026/10/70-p.jpg')`);
    await q("UPDATE app_settings SET `value` = '0' WHERE `key` = 'comms_archive_enabled'");
    const out = await verify.runVerify(pool, { slice: 0 });
    expect(out).toMatchObject({ enabled: false, checked: 1, missing: 1, stop: 'done' });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_missing').length).toBe(1);
  });

  // ── A — R9 + routes ─────────────────────────────────────────────────────
  const tok = (user, user_auth = 'authorized', roles = []) =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth, roles, aud: 'staff' }, process.env.JWT_SECRET);
  async function post(path, body, { t, apiKey } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  async function archived(name = 'phone/rec/2026/10/1-X.mp3', extra = {}) {
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, state, object_name, captured_at)
       VALUES ('phone', 'call_recording', 'phone_event_log', ?, 'X', ?, ?, ?, '2026-10-01 10:00:00')`,
      [extra.source_id || 1, extra.provider || 'quo', extra.state || 'archived', name]);
    if (name) gcs.objects.set(name, { buf: Buffer.from('audio'), contentType: 'audio/mpeg', generation: '1' });
    return r.insertId;
  }
  const audits = () => q("SELECT status, user_id, route, method, details FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id");

  test('A1 isArchiveAdmin: SU passes with an empty list; listed passes; unlisted 403; garbage = SU only; API key 403', async () => {
    const id = await archived();
    const r = (who) => post(`/api/comms-archive/media/${id}/restrict`, { reason: 'privacy' }, who);
    expect((await r({ t: tok(1) })).status).toBe(200);                    // listed (SS)
    expect((await r({ t: tok(3) })).status).toBe(403);                    // not listed
    await q("UPDATE app_settings SET `value` = '' WHERE `key` = 'comms_archive_admins'");
    expect((await r({ t: tok(6, 'authorized', ['su']) })).status).toBe(200); // SU, empty list
    expect((await r({ t: tok(1) })).status).toBe(403);
    await q("UPDATE app_settings SET `value` = '1x, ss,-1' WHERE `key` = 'comms_archive_admins'");
    expect((await r({ t: tok(1) })).status).toBe(403);                    // garbage = SU only
    expect((await r({ t: tok(6, 'authorized', ['su']) })).status).toBe(200);
    await q("DELETE FROM app_settings WHERE `key` = 'comms_archive_admins'");
    expect((await r({ t: tok(1) })).status).toBe(403);                    // missing = SU only
    // the JWT claiming SU is not enough — the DB decides
    expect((await r({ t: tok(3, 'authorized - SU') })).status).toBe(403);
    expect((await r({ t: tok(3, 'authorized', ['su']) })).status).toBe(403);
    // post-cutover (A2b): the legacy string is a claim, not a credential — a
    // user whose token AND row still read 'authorized - SU' but whose roles
    // lack su is refused
    expect((await r({ t: tok(7, 'authorized - SU') })).status).toBe(403);
    await q(`INSERT INTO app_settings (\`key\`, \`value\`, is_secret, is_editable, category, label, description, \`type\`, sort_order)
             VALUES ('comms_archive_admins', '1', 0, 0, 'Automations', 'x', 'x', 'string', 41)`);
    expect((await r({ apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);   // API key, never
    const a = await audits();
    expect(a.map(x => x.status)).toEqual(['success', 'rejected_not_admin', 'success', 'rejected_not_admin',
      'rejected_not_admin', 'success', 'rejected_not_admin', 'rejected_not_admin',
      'rejected_not_admin', 'rejected_not_admin',   // A2b: su-role claim on user 3; legacy row/token user 7
      'rejected_not_jwt']);
    const d0 = typeof a[0].details === 'string' ? JSON.parse(a[0].details) : a[0].details;
    expect(d0).toEqual({ action: 'restrict', media_id: id, reason: 'privacy' });
    expect(a[0]).toMatchObject({ user_id: 1, method: 'POST', route: `/api/comms-archive/media/${id}/restrict` });
  });

  test('A2 restrict / unrestrict flip the flag; reason required; purge needs confirm = id', async () => {
    const id = await archived();
    const ss = { t: tok(1) };
    expect((await post(`/api/comms-archive/media/${id}/restrict`, {}, ss)).status).toBe(400);
    expect((await post(`/api/comms-archive/media/${id}/restrict`, { reason: 'x'.repeat(501) }, ss)).status).toBe(400);
    let r = await post(`/api/comms-archive/media/${id}/restrict`, { reason: 'private call' }, ss);
    expect(r.json.media).toMatchObject({ id, restricted: 1 });
    r = await post(`/api/comms-archive/media/${id}/unrestrict`, { reason: 'cleared' }, ss);
    expect(r.json.media).toMatchObject({ restricted: 0 });
    expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'client asked' }, ss)).status).toBe(400);
    expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'client asked', confirm: id + 1 }, ss)).status).toBe(400);
    expect((await post('/api/comms-archive/media/99999/restrict', { reason: 'x' }, ss)).status).toBe(404);
    expect((await rows())[0].state).toBe('archived');
  });

  test('A3 purge end to end: object deleted, tombstone keeps object_name, audit row; a second purge 409', async () => {
    const name = 'phone/rec/2026/10/7-X.mp3';
    const id = await archived(name, { source_id: 7 });
    const r = await post(`/api/comms-archive/media/${id}/purge`, { reason: 'client request', confirm: id }, { t: tok(1) });
    expect(r.status).toBe(200);
    expect(r.json.media).toMatchObject({ id, state: 'purged' });
    expect(gcs.objects.has(name)).toBe(false);
    const [row] = await rows();
    expect(row).toMatchObject({ state: 'purged', object_name: name, purged_by: 1, purge_reason: 'client request' });
    expect(row.purged_at).not.toBeNull();
    const [a] = (await audits()).filter(x => x.status === 'success');
    const d = typeof a.details === 'string' ? JSON.parse(a.details) : a.details;
    expect(d).toMatchObject({ action: 'purge', media_id: id, reason: 'client request', parts: { bucket_objects: { deleted: 1 } } });
    expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'again', confirm: id }, { t: tok(1) })).status).toBe(409);
  });

  test('A4 purge of a PENDING row deletes an unadopted object under its prefix and stops future archiving', async () => {
    const mid = await sms({ logData: { attachments: [{ id: '777' }] } });
    await media.discoverMms(pool);
    const [row] = await rows();
    const leftover = archive.mmsPrefix({ capturedAt: row.captured_at, sourceId: mid, part: '777' }) + 'png';
    gcs.objects.set(leftover, { buf: Buffer.from('crash-left'), contentType: 'image/png', generation: '1' });
    expect((await post(`/api/comms-archive/media/${row.id}/purge`, { reason: 'wrong client', confirm: row.id }, { t: tok(1) })).status).toBe(200);
    expect(gcs.objects.has(leftover)).toBe(false);
    const out = await runMedia();
    expect(out.archived + out.adopted).toBe(0);
    expect(rcF.calls).toEqual([]);
    expect((await rows())[0].state).toBe('purged');
    expect(await media.discoverMms(pool)).toBe(0);
  });

  test('A5 a bucket delete failure → 502 and NO tombstone; the retry completes', async () => {
    const id = await archived('phone/rec/2026/10/9-X.mp3', { source_id: 9 });
    gcs.fail.delete = { code: 503 };
    const r = await post(`/api/comms-archive/media/${id}/purge`, { reason: 'x', confirm: id }, { t: tok(1) });
    expect(r.status).toBe(502);
    expect((await rows())[0].state).toBe('archived');
    expect((await audits()).map(a => a.status)).toEqual(['attempt', 'failed']);
    gcs.fail.delete = null;
    expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'x', confirm: id }, { t: tok(1) })).status).toBe(200);
  });

  test('A6 purge vs an in-flight sweep: refused (409) while the lane lock is held; the tick cannot upload after purge', async () => {
    // a Quo recording mid-download: the media tick holds its lock
    const cid = await call();
    let release;
    const gate = new Promise(r => { release = r; });
    quoF.recs[`AC${cid}`] = { status: 200, json: { data: [{ id: 'RX', status: 'completed', url: 'https://files.quo.example/rx', type: 'audio/mpeg' }] } };
    await media.discoverQuoCalls(pool);
    await q("UPDATE comms_media SET part = 'RX'");
    quoF.urls['https://files.quo.example/rx'] = async () => { await gate; return audio(Buffer.from('late')); };
    const tick = runMedia();
    await new Promise(r => setTimeout(r, 150));                         // tick is now inside the row
    const [row] = await rows();
    const p = await post(`/api/comms-archive/media/${row.id}/purge`, { reason: 'x', confirm: row.id }, { t: tok(1) });
    expect(p.status).toBe(409);
    expect((await audits()).map(a => a.status)).toEqual(['attempt', 'conflict']);
    release();
    await tick;
    expect((await rows())[0].state).toBe('archived');
    // after the tick: purge succeeds and the object is gone
    expect((await post(`/api/comms-archive/media/${row.id}/purge`, { reason: 'x', confirm: row.id }, { t: tok(1) })).status).toBe(200);
    expect([...gcs.objects.keys()]).toEqual([]);
  });

  test('S6a purge: an attempt row BEFORE the destructive step; audit unavailable → 503 and nothing purged', async () => {
    const id = await archived('phone/rec/2026/10/31-X.mp3', { source_id: 31 });
    expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'r', confirm: id }, { t: tok(1) })).status).toBe(200);
    expect((await audits()).map(a => a.status)).toEqual(['attempt', 'success']);
    const id2 = await archived('phone/rec/2026/10/32-X.mp3', { source_id: 32 });
    await q('RENAME TABLE admin_audit_log TO admin_audit_log_off');
    try {
      const r = await post(`/api/comms-archive/media/${id2}/purge`, { reason: 'r', confirm: id2 }, { t: tok(1) });
      expect(r.status).toBe(503);
    } finally { await q('RENAME TABLE admin_audit_log_off TO admin_audit_log'); }
    expect(gcs.objects.has('phone/rec/2026/10/32-X.mp3')).toBe(true);
    expect((await q('SELECT state FROM comms_media WHERE id = ?', [id2]))[0].state).toBe('archived');
  });

  test('S6b purge rate limit per user → 429, audited', async () => {
    router._resetPurgeLimit(1);
    const a = await archived('phone/rec/2026/10/41-X.mp3', { source_id: 41 });
    const b = await archived('phone/rec/2026/10/42-X.mp3', { source_id: 42 });
    expect((await post(`/api/comms-archive/media/${a}/purge`, { reason: 'r', confirm: a }, { t: tok(1) })).status).toBe(200);
    expect((await post(`/api/comms-archive/media/${b}/purge`, { reason: 'r', confirm: b }, { t: tok(1) })).status).toBe(429);
    expect((await audits()).map(x => x.status)).toEqual(['attempt', 'success', 'rejected_rate_limited']);
    expect(gcs.objects.has('phone/rec/2026/10/42-X.mp3')).toBe(true);
  });

  test('S6c a listed user must still be user_auth "authorized" in the DB', async () => {
    const id = await archived();
    await q("UPDATE users SET user_auth = 'unauthorized' WHERE user = 1");
    expect((await post(`/api/comms-archive/media/${id}/restrict`, { reason: 'x' }, { t: tok(1) })).status).toBe(403);
    await q("UPDATE users SET user_auth = 'authorized' WHERE user = 1");
    expect((await post(`/api/comms-archive/media/${id}/restrict`, { reason: 'x' }, { t: tok(1) })).status).toBe(200);
  });

  test('M5 isArchiveAdmin enforces its own JWT gates (not only the route)', async () => {
    expect(await admin.isArchiveAdmin(pool, { type: 'jwt', userId: '1' })).toBe(true);
    expect(await admin.isArchiveAdmin(pool, { type: 'api_key', userId: '1' })).toBe(false);
    expect(await admin.isArchiveAdmin(pool, { type: 'jwt' })).toBe(false);
    expect(await admin.isArchiveAdmin(pool, { type: 'jwt', userId: 'x' })).toBe(false);
    expect(await admin.isArchiveAdmin(pool, null)).toBe(false);
  });

  test('M24 two concurrent purges of one item: exactly one succeeds (purge re-reads under the lock)', async () => {
    admin.limits.lockWaitS = 3;
    const id = await archived('phone/rec/2026/10/51-X.mp3', { source_id: 51 });
    const body = { reason: 'r', confirm: id };
    const [a, b] = await Promise.all([
      post(`/api/comms-archive/media/${id}/purge`, body, { t: tok(1) }),
      post(`/api/comms-archive/media/${id}/purge`, body, { t: tok(6, 'authorized', ['su']) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await audits()).filter(x => x.status === 'success').length).toBe(1);
  });

  test('M2 a Quo split inherits `restricted` from the placeholder', async () => {
    const id = await call();
    await media.discoverQuoCalls(pool);
    await q('UPDATE comms_media SET restricted = 1');
    quoF.recs[`AC${id}`] = { status: 200, json: { data: [
      { id: 'Z1', status: 'processing', url: null }, { id: 'Z2', status: 'processing', url: null }] } };
    await runMedia();
    expect((await rows()).map(r => [r.part, r.restricted])).toEqual([['Z1', 1], ['Z2', 1]]);
  });

  test('S1 Quo "not yet" never parks forever: alert at 24 h+, failed 30 d after created; S2 stopped w/o url', async () => {
    const old = await call({ ageDays: 2 });
    const youngStop = await call({ ageDays: 0.1 });
    const oldStop = await call({ ageDays: 2 });
    for (const [cid, part] of [[old, 'N1'], [youngStop, 'N2'], [oldStop, 'N3']]) {
      await media.discoverQuoCalls(pool);
      await q('UPDATE comms_media SET part = ? WHERE source_id = ?', [part, cid]);
    }
    quoF.recs[`AC${old}`] = { status: 200, json: { data: [{ id: 'N1', status: 'processing', url: null }] } };
    quoF.recs[`AC${youngStop}`] = { status: 200, json: { data: [{ id: 'N2', status: 'stopped', url: null }] } };
    quoF.recs[`AC${oldStop}`] = { status: 200, json: { data: [{ id: 'N3', status: 'stopped', url: null }] } };
    await runMedia();
    const by = Object.fromEntries((await rows()).map(r => [r.part, r]));
    expect(by.N1).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by.N2).toMatchObject({ state: 'pending', attempts: 0 });            // stopped w/o url, young: not yet
    expect(by.N3.state).toBe('none');                                         // stopped w/o url, 24 h+: none
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_quo_not_yet').map(a => a.severity)).toEqual(['warning']);
    await q("UPDATE comms_media SET next_attempt_at = NULL, created_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE part = 'N1'");
    await runMedia();
    expect((await q("SELECT state FROM comms_media WHERE part = 'N1'"))[0].state).toBe('failed');
  });

  test('S3 a Quo call status outside {completed, no-answer} is not discovered and IS alerted, naming it', async () => {
    await call({ status: 'busy' });
    await call({ status: 'completed' });
    const out = await runMedia();
    expect(out.unknown_call_statuses).toEqual([{ status: 'busy', count: 1 }]);
    expect((await rows()).length).toBe(1);
    const d = (await alerts()).filter(a => a.group_key === 'comms_archive_quo_status_drift');
    expect(d.length).toBe(1);
    expect(d[0].message).toMatch(/"busy" ×1/);
    // its own group: the shape-drift group stays free for per-row drift
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_shape_drift')).toEqual([]);
  });

  test('S4 Quo MMS is matched by media id (order-proof); id mismatch or one-sided ids = drift', async () => {
    const att = (id) => ({ url: `https://share.quo.com/v1/resource/message-media/${id}.jpg?sig=s` });
    const fresh = (id, body) => {
      const u = `https://share.quo.com/v1/resource/message-media/${id}.jpg?sig=new`;
      quoF.urls[u] = () => ({ status: 200, host: 'share.quo.com', contentType: 'image/jpeg', contentLength: body.length, body: Readable.from([Buffer.from(body)]) });
      return { url: u, type: 'image/jpeg' };
    };
    const m1 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [att('AAA'), att('BBB')] } });
    quoF.msgs[`AC${m1}`] = { status: 200, json: { data: { media: [fresh('BBB', 'bee'), fresh('AAA', 'ayy')] } } };   // reversed
    const m2 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [att('CCC')] } });
    quoF.msgs[`AC${m2}`] = { status: 200, json: { data: { media: [fresh('DDD', 'dee')] } } };                        // mismatch
    const m3 = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [att('EEE'), att('FFF')] } });
    quoF.msgs[`AC${m3}`] = { status: 200, json: { data: { media: [{ url: 'https://cdn.example/opaque1?sig=1', type: 'image/png' }, { url: 'https://cdn.example/opaque2?sig=2', type: 'image/png' }] } } }; // one-sided, 2 items
    await runMedia();
    const by = Object.fromEntries((await rows()).map(r => [`${r.source_id}:${r.part}`, r]));
    expect(by[`${m1}:q1`]).toMatchObject({ state: 'archived', sha256: sha(Buffer.from('ayy')) });
    expect(by[`${m1}:q2`]).toMatchObject({ state: 'archived', sha256: sha(Buffer.from('bee')) });
    expect(by[`${m2}:q1`]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[`${m2}:q1`].last_error).toMatch(/media id CCC not among/);
    expect(by[`${m3}:q1`].last_error).toMatch(/media id on only one side/);
  });

  test('F1 old Quo URL schemes: one-sided ids accepted by ordinal ONLY for 1 stored + 1 listed', async () => {
    const fresh = (id, body) => {
      const u = `https://share.quo.com/v1/resource/message-media/${id}.pdf?sig=new`;
      quoF.urls[u] = () => ({ status: 200, host: 'share.quo.com', contentType: 'application/pdf', contentLength: body.length, body: Readable.from([Buffer.from(body)]) });
      return { url: u, type: 'application/pdf' };
    };
    // the two pre-June shapes seen live (phone_event_log 1060/1783 and 1121/1829/1830/2293)
    const a = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/v1/file/i/abc123.pdf?sig=old' }] } });
    const b = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://storage.googleapis.com/opstatics/0f9e8d7c6b5a' }] } });
    quoF.msgs[`AC${a}`] = { status: 200, json: { data: { media: [fresh('NEW1', 'pdf-a')] } } };
    quoF.msgs[`AC${b}`] = { status: 200, json: { data: { media: [fresh('NEW2', 'pdf-b')] } } };
    // one-sided with MORE than one item on either side → still drift
    const c = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/v1/file/i/x.pdf' }] } });
    quoF.msgs[`AC${c}`] = { status: 200, json: { data: { media: [fresh('N3', 'p3'), fresh('N4', 'p4')] } } };
    const d = await sms({ provider: 'quo', line: '2489654574', logData: { attachments: [{ url: 'https://share.quo.com/v1/file/i/y.pdf' }, { url: 'https://share.quo.com/v1/file/i/z.pdf' }] } });
    quoF.msgs[`AC${d}`] = { status: 200, json: { data: { media: [fresh('N5', 'p5')] } } };
    await runMedia();
    const by = Object.fromEntries((await rows()).map(r => [`${r.source_id}:${r.part}`, r]));
    expect(by[`${a}:q1`]).toMatchObject({ state: 'archived', sha256: sha(Buffer.from('pdf-a')) });
    expect(by[`${b}:q1`]).toMatchObject({ state: 'archived', sha256: sha(Buffer.from('pdf-b')) });
    expect(by[`${c}:q1`].last_error).toMatch(/only one side .*1 stored, 2 listed/);
    expect(by[`${d}:q1`].last_error).toMatch(/only one side .*2 stored, 1 listed/);
  });

  test('A7 the RC recording lane uses the cliff sweep\'s lock (not the media one)', async () => {
    const id = await archived('phone/rec/2026/10/11-X.mp3', { source_id: 11, provider: 'ringcentral' });
    const conn = await pool.getConnection();
    try {
      await conn.query("SELECT GET_LOCK(CONCAT('comms_archive_sweep:', DATABASE()), 0)");
      expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'x', confirm: id }, { t: tok(1) })).status).toBe(409);
      await conn.query("SELECT RELEASE_LOCK(CONCAT('comms_archive_sweep:', DATABASE()))");
      await conn.query("SELECT GET_LOCK(CONCAT('comms_archive_media:', DATABASE()), 0)");
      expect((await post(`/api/comms-archive/media/${id}/purge`, { reason: 'x', confirm: id }, { t: tok(1) })).status).toBe(200);
      await conn.query("SELECT RELEASE_LOCK(CONCAT('comms_archive_media:', DATABASE()))");
    } finally { conn.release(); }
  });
});
