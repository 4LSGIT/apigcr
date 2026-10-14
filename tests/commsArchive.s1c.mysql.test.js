/**
 * REAL-ENGINE suite for comms archive S1c — voicemail capture (R10) on MySQL
 * with the production schema and sql_mode:
 *   R   RingCentral: the hourly, stateless full listing (after the row work)
 *       → rows anchored by provider identity (rc_message / RC message id),
 *       the to-number line (R6 — even a line that is Quo today), NULL without
 *       one, Alive + Deleted kept, Purged skipped, drift on odd shapes; a
 *       failed page re-found next hour; content → phone/vm; the
 *       one-RC-credential rule; the vendor transcript path; NOTHING created
 *       under a purged voicemail (review M1); 401/403 → no_auth.
 *   Q   Quo: /v1/call-voicemails per call — completed / in-progress / drift;
 *       the 404 HOLD (7 days on the call clock, re-checked daily, outside the
 *       not-yet alert); the sanity alarm until the first archive; the vendor
 *       transcript as stt_raw, never blocking the audio.
 *   P   purge removes a voicemail's stt_raw child; restrict cascades to it.
 *
 * Stand-ins only at the boundaries (GCS, the provider adapters). GATED on
 * YC_TEST_MYSQL_URL (a throwaway *_test DB, UTC server):
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_test npx jest tests/commsArchive.s1c.mysql.test.js --runInBand
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const crypto = require('crypto');
const { Readable } = require('stream');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'log', 'users', 'system_alerts', 'alert_state',
  'app_settings', 'scheduled_jobs', 'admin_audit_log', 'job_results'];

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

maybe('comms archive S1c (voicemails) on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const media   = require('../services/commsArchiveMediaSweep');
  const admin   = require('../services/commsArchiveAdmin');
  const ORIG = { media: { ...media.limits }, admin: { ...admin.limits } };

  let pool, gcs, rcF, quoF;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const rows = () => q('SELECT * FROM comms_media ORDER BY id');
  const alerts = () => q('SELECT group_key, severity, title, message FROM system_alerts ORDER BY id');

  let nextId = 7000;
  async function call({ status = 'no-answer', ageDays = 2, line = '2484179800' } = {}) {
    const id = ++nextId;
    const t = daysAgo(ageDays);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, raw_extra, processed_at)
             VALUES (?, 'quo', ?, 'call', 'incoming', '2489148845', ?, '2489148845', 0, ?, ?)`,
      [id, `AC${id}`, line, JSON.stringify({ line, provider: 'quo', started_at: t.toISOString(), provider_status: status }),
        new Date(t.getTime() + 60_000)]);
    return id;
  }
  const audioRes = (buf, type = 'audio/mpeg') => ({ status: 200, contentType: type, contentLength: buf.length, body: Readable.from([buf]), rate: {} });

  // RC message-store records in the PROBED shape (2026-10-14)
  const vm = (id, { to = '+12486213656', from = '+12489148845', created = '2024-09-15T19:33:18.000Z', availability = 'Alive',
    contentType = 'audio/x-wav', transcription = 'NotAvailable', extraAtt = [] } = {}) => ({
    uri: `https://platform.ringcentral.com/restapi/v1.0/account/55880693/extension/55880693/message-store/${id}`,
    id: Number(id), extensionId: '55880693',
    to: to ? [{ phoneNumber: to, name: 'x' }] : [{ name: 'Stuart Sandweiss' }],
    from: { phoneNumber: from, name: 'caller' },
    type: 'VoiceMail', creationTime: created, readStatus: 'Read', priority: 'Normal',
    attachments: [{ id: Number(id), uri: 'https://media.ringcentral.com/x', type: 'AudioRecording', contentType, vmDuration: 25 }, ...extraAtt],
    direction: 'Inbound', availability, messageStatus: 'Received', vmTranscriptionStatus: transcription, private: false,
  });

  function makeRc() {
    const f = { auth: true, lists: [], content: [], pages: { 1: [] },
      async checkArchiveAuth() { return f.auth; },
      async listVoicemails(_db, { credentialId, dateFrom, page }) {
        f.lists.push({ credentialId, dateFrom: new Date(dateFrom), page });
        const recs = f.pages[page] || [];
        return f.listOverride ? f.listOverride() : { status: 200, json: { records: recs, paging: { page, totalPages: Object.keys(f.pages).length, perPage: 100 } }, rate: {} };
      },
      async fetchMessageAttachment(_db, { messageId, attachmentId, credentialId }) {
        f.content.push({ messageId, attachmentId, credentialId });
        const r = f.att && f.att[attachmentId];
        return typeof r === 'function' ? r() : (r || audioRes(Buffer.from(`vm-${attachmentId}`), 'audio/x-wav'));
      },
    };
    return f;
  }
  function makeQuo() {
    const f = { auth: true, vms: {}, gets: [],
      async checkArchiveAuth() { return f.auth; },
      async listCallRecordings() { return { status: 200, json: { data: [] } }; },
      async getMessage() { return { status: 404, json: null }; },
      async getCallVoicemail(_db, { callId }) { const r = f.vms[callId]; return typeof r === 'function' ? r() : (r || { status: 404, json: null, errorText: '{"code":"1200404"}' }); },
      async fetchSigned(url) {
        f.gets.push(url);
        const r = f.urls && f.urls[url];
        return typeof r === 'function' ? r() : { status: 200, host: new URL(url).host, contentType: 'audio/mpeg', contentLength: 5, body: Readable.from([Buffer.from('quovm')]) };
      },
    };
    return f;
  }
  const run = () => media.runMediaSweep(pool, { rc: rcF, quo: quoF });

  /** Fake job_results history for the media-sweep job (newest last in the list order given). */
  async function tickHistory(entries) {
    const [[job]] = await pool.query("SELECT id FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_media_sweep'");
    let n = 0;
    for (const e of entries) {
      await pool.query(
        `INSERT INTO job_results (job_id, attempt, status, output_data, executed_at, execution_number)
         VALUES (?, 1, 'success', ?, UTC_TIMESTAMP() - INTERVAL ? MINUTE, ?)`,
        [job.id, JSON.stringify({ success: true, output: e.listing ? { rc_vm_listing: e.listing } : {} }), e.minsAgo, ++n]);
    }
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await schema.build(pool, TABLES);
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
  });
  afterAll(async () => {
    archive._test.setStorage(null);
    Object.assign(media.limits, ORIG.media);
    Object.assign(admin.limits, ORIG.admin);
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    Object.assign(media.limits, ORIG.media, { sleep: async () => {}, rcMediumSpacingMs: 0, quoSpacingMs: 0, rcVmMinuteDue: () => true });
    Object.assign(admin.limits, ORIG.admin, { lockWaitS: 0 });
    for (const t of ['comms_media', 'phone_event_log', 'log', 'system_alerts', 'alert_state', 'phone_lines', 'job_results']) await q(`TRUNCATE TABLE \`${t}\``);
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, credential_id) VALUES
      (1, '2485592400', 'ringcentral', 1, 9), (4, '2486213656', 'ringcentral', 1, 9), (6, '2484179800', 'quo', 1, 10)`);
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_enabled'");
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    rcF = makeRc();
    quoF = makeQuo();
  });

  // ── R — RingCentral ─────────────────────────────────────────────────────
  test('R1 listing → rows anchored by RC message id; to-line (even a Quo line today), NULL without; Deleted kept, Purged skipped', async () => {
    rcF.pages[1] = [
      vm('2441801165019', { to: null }),                                      // 2024: no to-number
      vm('1605599673019', { to: '+12486213656', contentType: 'audio/mpeg', created: '2021-08-19T19:06:20.000Z' }),
      vm('1427551891019', { to: '+12484179800', contentType: 'audio/mpeg', created: '2020-10-16T03:48:41.000Z' }),
      vm('1500000000019', { availability: 'Deleted', created: '2021-01-01T00:00:00.000Z' }),
      vm('1500000000029', { availability: 'Purged', created: '2021-01-02T00:00:00.000Z' }),
    ];
    const out = await run();                     // the listing runs AFTER the row work: rows now…
    expect(out.discovered_rc_vm).toBe(4);
    expect(out.drift).toBe(0);
    await run();                                  // …archived on the next tick
    const by = Object.fromEntries((await rows()).filter(r => r.kind === 'voicemail').map(r => [String(r.source_id), r]));
    expect(Object.keys(by).sort()).toEqual(['1427551891019', '1500000000019', '1605599673019', '2441801165019']);
    expect(by['2441801165019']).toMatchObject({ source_table: 'rc_message', part: '2441801165019', provider: 'ringcentral', channel_id: null, party: '2489148845' });
    expect(by['1605599673019'].channel_id).toBe(4);
    expect(by['1427551891019'].channel_id).toBe(6);                         // R6: the line, whatever its provider today
    expect(new Date(by['2441801165019'].captured_at).toISOString()).toBe('2024-09-15T19:33:18.000Z');
    // first run lists from the epoch; content fetched with the one RC credential, message id = source_id
    expect(rcF.lists[0]).toMatchObject({ credentialId: 9, page: 1 });
    expect(rcF.lists[0].dateFrom.toISOString()).toBe('2016-01-01T00:00:00.000Z');
    expect(rcF.content.find(c => c.messageId === '2441801165019')).toMatchObject({ attachmentId: '2441801165019', credentialId: 9 });
    expect(by['2441801165019']).toMatchObject({ state: 'archived', mime: 'audio/wav', sha256: sha(Buffer.from('vm-2441801165019')) });
    expect(by['2441801165019'].object_name).toBe('phone/vm/2024/09/2441801165019-2441801165019.wav');
    // rediscovery is stable; the listing is stateless — always the full set from the epoch
    const n = (await rows()).length;
    await run();
    expect((await rows()).length).toBe(n);
    expect(rcF.lists.every(l => l.dateFrom.toISOString() === '2016-01-01T00:00:00.000Z')).toBe(true);
  });

  test('R2 odd listing shapes are drift (alerted), never "no voicemail"', async () => {
    rcF.pages[1] = [
      { ...vm('1111111111019'), attachments: undefined },
      vm('2222222222019', { availability: 'Archived' }),
      { ...vm('3333333333019'), attachments: [{ type: 'AudioRecording' }] },
    ];
    const out = await run();
    expect(out.discovered_rc_vm).toBe(0);
    expect(out.drift).toBe(3);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_drift').length).toBe(1);
    await q('TRUNCATE TABLE system_alerts');                                  // the alert is deduped per day
    rcF.listOverride = () => ({ status: 200, json: { data: [] }, rate: {} });
    await run();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_drift')[0].message).toMatch(/records\/paging missing/);
  });

  test('R2b an RC listing that THROWS (network) is drift — the rest of the tick still runs', async () => {
    rcF.listOverride = () => { throw new Error('socket hang up'); };
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VMz', status: 'completed', recordingUrl: 'https://f.quo.example/z', transcript: null } } };
    const out = await run();
    expect(out.archived).toBe(1);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_drift')[0].message).toMatch(/voicemail listing failed: socket hang up/);
  });

  test('R3 two RC credentials in phone_lines → an RC voicemail is parked + alerted, never guessed', async () => {
    rcF.pages[1] = [vm('2441801165019', { to: null })];
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, credential_id) VALUES (9, '5550001111', 'ringcentral', 1, 11)`);
    await run();
    await run();
    const [r] = (await rows()).filter(x => x.kind === 'voicemail');
    expect(r).toMatchObject({ state: 'pending', attempts: 0 });
    expect(r.last_error).toMatch(/2 RC credentials — ambiguous/);
  });

  test('R4 RC vendor transcript (Completed + AudioTranscription) → stt_raw JSON, restricted inherited; odd shape never blocks the audio', async () => {
    rcF.pages[1] = [
      vm('4444444444019', { transcription: 'Completed', extraAtt: [{ id: 4444444444020, type: 'AudioTranscription', contentType: 'text/plain' }] }),
      vm('5555555555019', { transcription: 'Completed' }),                   // Completed, no transcription attachment
    ];
    rcF.att = { '4444444444020': () => ({ status: 200, contentType: 'text/plain', contentLength: 11, body: Readable.from([Buffer.from('hello there')]), rate: {} }) };
    await run();                                                            // the listing: voicemails + the pending transcript row
    await q("UPDATE comms_media SET restricted = 1 WHERE kind = 'voicemail' AND source_id = 4444444444019");
    await q("UPDATE comms_media SET restricted = 1 WHERE kind = 'stt_raw'");  // (row created before the flip in this tick)
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    await run();
    const all = await rows();
    const v4 = all.find(r => r.kind === 'voicemail' && String(r.source_id) === '4444444444019');
    const v5 = all.find(r => r.kind === 'voicemail' && String(r.source_id) === '5555555555019');
    const st = all.find(r => r.kind === 'stt_raw');
    expect(v4.state).toBe('archived');
    expect(all.filter(r => r.kind === 'voicemail' && String(r.source_id) === '4444444444019').length).toBe(1);   // AudioRecording only
    expect(v5.state).toBe('archived');                                       // the odd transcript shape never parked it
    expect(st).toMatchObject({ source_table: 'comms_media', source_id: v4.id, part: '4444444444020', provider: 'ringcentral', state: 'archived', mime: 'application/json' });
    expect(st.object_name).toBe(`phone/stt/2024/09/${v4.id}.ringcentral.json`);
    const json = JSON.parse(gcs.objects.get(st.object_name).buf.toString());
    expect(json).toMatchObject({ vendor: 'ringcentral', message_id: '4444444444019', attachment_id: '4444444444020', transcript: 'hello there' });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_shape_drift')[0].message).toMatch(/no AudioTranscription attachment/);
  });

  test('R5 a transcription that completes LATER is picked up on a re-list (inherits restricted)', async () => {
    rcF.pages[1] = [vm('6666666666019')];
    await run();
    await q('UPDATE comms_media SET restricted = 1');
    rcF.pages[1] = [vm('6666666666019', { transcription: 'Completed', extraAtt: [{ id: 6666666666020, type: 'AudioTranscription' }] })];
    await run();
    const st = (await rows()).find(r => r.kind === 'stt_raw');
    expect(st).toMatchObject({ part: '6666666666020', restricted: 1 });
  });

  // ── Q — Quo ─────────────────────────────────────────────────────────────
  test('Q1 completed → voicemail archived under phone/vm + Quo transcript as stt_raw (restricted inherited)', async () => {
    const id = await call({ status: 'no-answer' });
    await media.discoverQuoVoicemails(pool);
    await q("UPDATE comms_media SET restricted = 1 WHERE kind = 'voicemail'");
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VMabc123', status: 'completed', recordingUrl: 'https://files.quo.example/vm?sig=s', duration: 12, transcript: 'Hi, call me back.' } } };
    await run();
    const all = await rows();
    const v = all.find(r => r.kind === 'voicemail');
    expect(v).toMatchObject({ state: 'archived', part: 'VMabc123', source_table: 'phone_event_log', source_id: id, channel_id: 6 });
    expect(v.object_name).toMatch(new RegExp(`^phone/vm/\\d{4}/\\d{2}/${id}-VMabc123\\.mp3$`));
    const st = all.find(r => r.kind === 'stt_raw');
    expect(st).toMatchObject({ source_table: 'comms_media', source_id: v.id, part: 'quo', provider: 'quo', state: 'archived', restricted: 1 });
    expect(JSON.parse(gcs.objects.get(st.object_name).buf.toString())).toMatchObject({ vendor: 'quo', voicemail_id: 'VMabc123', transcript: 'Hi, call me back.' });
  });

  test('Q2 404 HELD 7 days from the LATER of call / first check (uncharged, daily, outside the not-yet alert), then none', async () => {
    const young = await call({ ageDays: 2 });
    const oldCall = await call({ ageDays: 40 });                           // old at go-live: STILL held (review M2)
    const done = await call({ ageDays: 40 });
    await media.discoverQuoVoicemails(pool);
    await q('UPDATE comms_media SET created_at = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE source_id = ?', [done]);
    await run();
    const by = Object.fromEntries((await rows()).filter(r => r.kind === 'voicemail').map(r => [r.source_id, r]));
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    expect(by[young]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[young].last_error).toBe(`quo voicemail: 404 held since ${today}, until ${in7}`);
    expect((new Date(by[young].next_attempt_at) - Date.now()) / 3_600_000).toBeGreaterThan(23.9);
    expect(by[oldCall]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[done]).toMatchObject({ state: 'none', attempts: 0 });
    expect(by[done].last_error).toMatch(/^quo voicemail: 404 held 7 days \(since \d{4}-\d{2}-\d{2}\) - none$/);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_quo_not_yet')).toEqual([]);
    const san = (await alerts()).filter(a => a.group_key === 'comms_archive_quo_vm_sanity');
    expect(san.length).toBe(1);
    expect(san[0]).toMatchObject({ severity: 'warning' });
    expect(san[0].message).toMatch(/3 call\(s\) checked, 2 held on a 404, 1 none, 0 found/);
    // persisted 48 h+ with nothing found → ERROR (warnings never email)
    await q("UPDATE system_alerts SET created_at = UTC_TIMESTAMP() - INTERVAL 49 HOUR WHERE group_key = 'comms_archive_quo_vm_sanity'");
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    await run();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_quo_vm_sanity').map(a => a.severity)).toEqual(['warning', 'error']);
    // once one is archived, the alarm goes quiet for good
    await q('TRUNCATE TABLE system_alerts');
    const found = await call();
    quoF.vms[`AC${found}`] = { status: 200, json: { data: { id: 'VM1', status: 'completed', recordingUrl: 'https://f.quo.example/1', transcript: null } } };
    await run();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_quo_vm_sanity')).toEqual([]);
  });

  test('Q3 docs-only shapes: drift parks uncharged; in-progress is not-yet; completed without a url is a transient', async () => {
    const ids = [];
    const cases = [
      { status: 200, json: { data: [] } },                                              // array
      { status: 200, json: undefined },                                                 // unparseable
      { status: 200, json: { data: { id: 'XX1', status: 'completed', recordingUrl: 'https://x/y' } } }, // not ^VM
      { status: 200, json: { data: { id: 'VM2', status: 'queued' } } },                 // unknown status
      { status: 200, json: { data: { id: 'VM3', status: 'in-progress', recordingUrl: null } } },
      { status: 200, json: { data: { id: 'VM4', status: 'completed', recordingUrl: null } } },
    ];
    for (const c of cases) { const id = await call(); ids.push(id); quoF.vms[`AC${id}`] = c; }
    await run();
    const by = Object.fromEntries((await rows()).filter(r => r.kind === 'voicemail').map(r => [r.source_id, r]));
    for (const i of [0, 1, 2, 3]) {
      expect(by[ids[i]]).toMatchObject({ state: 'pending', attempts: 0 });
      expect(by[ids[i]].last_error).toMatch(/^shape drift: /);
    }
    expect(by[ids[4]]).toMatchObject({ state: 'pending', attempts: 0, last_error: 'voicemail in-progress' });
    expect(by[ids[5]]).toMatchObject({ state: 'pending', attempts: 1 });
  });

  test('Q4 an odd transcript never blocks the audio', async () => {
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VM9', status: 'completed', recordingUrl: 'https://f.quo.example/9', transcript: { text: 'x' } } } };
    await run();
    const all = await rows();
    expect(all.find(r => r.kind === 'voicemail').state).toBe('archived');
    expect(all.find(r => r.kind === 'stt_raw')).toBeUndefined();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_shape_drift')[0].message).toMatch(/transcript is object/);
  });

  // ── P — purge / restrict with the derived child ─────────────────────────
  test('P1 purge removes the stt_raw child (object + tombstone); restrict cascades to it', async () => {
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VMp', status: 'completed', recordingUrl: 'https://f.quo.example/p', transcript: 'secret words' } } };
    await run();
    const v = (await rows()).find(r => r.kind === 'voicemail');
    const st = (await rows()).find(r => r.kind === 'stt_raw');
    await admin.setRestricted(pool, v.id, true);
    expect((await q('SELECT restricted FROM comms_media WHERE id = ?', [st.id]))[0].restricted).toBe(1);
    const res = await admin.purge(pool, v.id, { userId: 1, reason: 'client asked' });
    expect(res.parts).toMatchObject({ derived_children: { rows: 1, deleted: 1 }, bucket_objects: { deleted: 1 } });
    expect(gcs.objects.has(st.object_name)).toBe(false);
    expect(gcs.objects.has(v.object_name)).toBe(false);
    const after = await q('SELECT id, state, purged_by, purge_reason FROM comms_media ORDER BY id');
    expect(after.every(r => r.state === 'purged' && r.purged_by === 1)).toBe(true);
    expect(after.find(r => r.id === st.id).purge_reason).toBe(`with #${v.id}: client asked`);
  });

  // ── review fixes ────────────────────────────────────────────────────────
  test('M1 a transcript that completes AFTER the voicemail was purged is never created (nor fetched)', async () => {
    rcF.pages[1] = [vm('7777777777019', { transcription: 'InProgress' })];
    await run(); await run();
    const v = (await rows()).find(r => r.kind === 'voicemail');
    expect(v.state).toBe('archived');
    await admin.purge(pool, v.id, { userId: 1, reason: 'client asked' });
    rcF.pages[1] = [vm('7777777777019', { transcription: 'Completed', extraAtt: [{ id: 7777777777020, type: 'AudioTranscription' }] })];
    rcF.att = { '7777777777020': () => ({ status: 200, contentType: 'text/plain', contentLength: 6, body: Readable.from([Buffer.from('secret')]), rate: {} }) };
    await run(); await run();
    expect((await rows()).filter(r => r.kind === 'stt_raw')).toEqual([]);
    expect([...gcs.objects.keys()].filter(k => k.startsWith('phone/stt/'))).toEqual([]);
    // a pending child whose parent gets purged under it is purged, never fetched
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, captured_at, state)
             VALUES ('phone', 'stt_raw', 'comms_media', ?, '7777777777020', 'ringcentral', '2024-09-15 19:33:18', 'pending')`, [v.id]);
    const before = rcF.content.length;
    await run();
    const kid = (await rows()).find(r => r.kind === 'stt_raw');
    expect(kid).toMatchObject({ state: 'purged', purge_reason: 'parent purged' });
    expect(rcF.content.length).toBe(before);
  });

  test('S1 stateless hourly listing: a failed page 2 is re-found by the next listing; not due → no listing', async () => {
    rcF.pages = { 1: [vm('2441801165019', { to: null })], 2: [vm('1427551891019', { to: '+12484179800', created: '2020-10-16T03:48:41.000Z' })] };
    let fail = true;
    const realList = rcF.listVoicemails;
    rcF.listVoicemails = async (db, args) => (args.page === 2 && fail ? { status: 500, json: null, rate: {}, errorText: 'x' } : realList(db, args));
    let out = await run();
    expect(out.drift).toBe(1);
    expect((await rows()).map(r => String(r.source_id))).toEqual(['2441801165019']);
    fail = false;
    out = await run();
    expect((await rows()).map(r => String(r.source_id)).sort()).toEqual(['1427551891019', '2441801165019']);
    // not the top of the hour AND a listing completed recently → not due
    media.limits.rcVmMinuteDue = () => false;
    await tickHistory([{ minsAgo: 10, listing: 'complete' }]);
    const n = rcF.lists.length;
    out = await run();
    expect(rcF.lists.length).toBe(n);
    expect(out.rc_vm_listed).toBeUndefined();
  });

  test('S2 more than 3 pages (> 300 voicemails ever) is LOUD drift, not silence', async () => {
    rcF.pages = { 1: [], 2: [], 3: [], 4: [vm('1000000000019')] };
    const out = await run();
    expect(out.drift).toBe(1);
    expect(rcF.lists.map(l => l.page)).toEqual([1, 2, 3]);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_drift')[0].message).toMatch(/4 pages since 2016-01-01; only 3 read/);
  });

  test('A8 listing 401 → no_auth (not drift); transcript fetch 403 → refunded no_auth', async () => {
    rcF.listOverride = () => ({ status: 401, json: null, rate: {}, errorText: 'unauth' });
    let out = await run();
    expect(out.drift).toBe(0);
    expect(out.rc_auth_error).toEqual({ endpoint: '/restapi/v1.0/account/~/extension/~/message-store?messageType=VoiceMail', status: 401, errorText: 'unauth' });
    expect((await alerts()).some(a => a.group_key === 'comms_archive_no_auth:9')).toBe(true);
    rcF.listOverride = null;
    rcF.pages[1] = [vm('8888888888019', { transcription: 'Completed', extraAtt: [{ id: 8888888888020, type: 'AudioTranscription' }] })];
    rcF.att = { '8888888888020': { status: 403, body: null, rate: {}, errorText: 'no transcript for you' } };
    await run();
    out = await run();
    expect(out.rc_auth_error).toMatchObject({ status: 403, errorText: 'no transcript for you' });
    expect(out.rc_auth_error.endpoint).toMatch(/\(voicemail transcript\)$/);
    const kid = (await rows()).find(r => r.kind === 'stt_raw');
    expect(kid).toMatchObject({ state: 'pending', attempts: 0 });
  });

  test('A5 purge partial failure: children purged, then the item\'s own delete fails → 502 that says so', async () => {
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VMpf', status: 'completed', recordingUrl: 'https://f.quo.example/pf', transcript: 'words' } } };
    await run();
    const v = (await rows()).find(r => r.kind === 'voicemail');
    gcs.fail.deleteNames = new Set([v.object_name]);
    let e;
    try { await admin.purge(pool, v.id, { userId: 1, reason: 'r' }); } catch (x) { e = x; }
    expect(e && e.status).toBe(502);
    // Robust to S2's 'transcripts' step (first in PURGE_PARTS where the S2 tables exist), which may also be named.
    expect(e.message).toMatch(/already purged: (transcripts \(\d+ row\(s\)\), )?derived_children \(1 row\(s\)\); the item itself is NOT marked purged/);
    const all = await rows();
    expect(all.find(r => r.kind === 'stt_raw').state).toBe('purged');
    expect(all.find(r => r.kind === 'voicemail').state).toBe('archived');
    gcs.fail.deleteNames = null;
    await admin.purge(pool, v.id, { userId: 1, reason: 'r' });
    expect((await rows()).every(r => r.state === 'purged')).toBe(true);
  });

  test('A6 the cascade touches ONLY comms_media children (an unrelated row with the same source_id is untouched)', async () => {
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'VMc', status: 'completed', recordingUrl: 'https://f.quo.example/c', transcript: 't' } } };
    await run();
    const v = (await rows()).find(r => r.kind === 'voicemail');
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, state)
             VALUES ('phone', 'mms_file', 'phone_event_log', ?, 'z1', 'quo', 'archived')`, [v.id]);
    await admin.setRestricted(pool, v.id, true);
    await admin.purge(pool, v.id, { userId: 1, reason: 'r' });
    const [unrelated] = await q("SELECT state, restricted FROM comms_media WHERE kind = 'mms_file'");
    expect(unrelated).toMatchObject({ state: 'archived', restricted: 0 });
  });

  test('L1 four missed :00 listings → the next tick lists by STALENESS; no completed listing in 6 h → alarm', async () => {
    media.limits.rcVmMinuteDue = () => false;                                  // every tick misses the top of the hour
    rcF.pages[1] = [vm('2441801165019', { to: null })];
    // a completed listing 4 h ago, then four hourly :00 ticks that never listed
    await tickHistory([{ minsAgo: 240, listing: 'complete' }, { minsAgo: 180 }, { minsAgo: 120 }, { minsAgo: 60 }, { minsAgo: 2 }]);
    let out = await run();
    expect(out).toMatchObject({ rc_vm_due: true, rc_vm_listed: true, rc_vm_listing: 'complete' });
    expect(out.discovered_rc_vm).toBe(1);
    // recorded as complete → a later off-hour tick is NOT due
    await tickHistory([{ minsAgo: 0, listing: 'complete' }]);
    out = await run();
    expect(out.rc_vm_due).toBe(false);
    // the staleness alarm: the last completed listing 7 h ago, and this hour's listing fails
    await q('TRUNCATE TABLE job_results');
    await tickHistory([{ minsAgo: 420, listing: 'complete' }, { minsAgo: 30, listing: 'incomplete' }]);
    rcF.listOverride = () => ({ status: 429, json: null, rate: {} });          // quiet per tick…
    out = await run();
    expect(out.rc_vm_listing).toBe('incomplete');
    await run();
    const st = (await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_stale');
    expect(st.map(a => a.severity)).toEqual(['warning', 'error']);              // …the staleness alarm is the backstop
    // never completed, but the job's history spans > 6 h → also stale
    await q('TRUNCATE TABLE job_results'); await q('TRUNCATE TABLE system_alerts');
    await tickHistory([{ minsAgo: 400 }, { minsAgo: 10 }]);
    await run();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_rc_vm_listing_stale').length).toBe(1);
  });

  test('L2 RC listing drift has its OWN group: with a Quo voicemail drift the same day, both alert', async () => {
    rcF.listOverride = () => ({ status: 200, json: { data: [] }, rate: {} });  // listing drift
    const id = await call();
    quoF.vms[`AC${id}`] = { status: 200, json: { data: { id: 'XX', status: 'completed' } } };   // per-row drift
    await run();
    const g = (await alerts()).map(a => a.group_key);
    expect(g).toEqual(expect.arrayContaining(['comms_archive_rc_vm_listing_drift', 'comms_archive_shape_drift']));
  });

  test('V12 GCS refusing a vendor transcript: storage alert, the voicemail stays archived, the tick goes on', async () => {
    const a = await call(); const b = await call();
    for (const [cid, vmid] of [[a, 'VMt1'], [b, 'VMt2']]) {
      quoF.vms[`AC${cid}`] = { status: 200, json: { data: { id: vmid, status: 'completed', recordingUrl: `https://f.quo.example/${vmid}`, transcript: 'words' } } };
    }
    gcs.fail.putPrefix = 'phone/stt/';
    const out = await run();
    const all = await rows();
    expect(all.filter(r => r.kind === 'voicemail').map(r => r.state)).toEqual(['archived', 'archived']);
    expect(all.filter(r => r.kind === 'stt_raw')).toEqual([]);
    expect(out.transcript_storage_errors).toBe(2);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_storage').length).toBeGreaterThanOrEqual(1);
  });

  test('Q403 a Quo voicemail 403 (Rena\'s line, live 2026-10-14) PARKS that row with a per-line alert; other lines go on', async () => {
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, credential_id, display_name) VALUES (3, '2489655355', 'quo', 1, 10, 'Rena')`);
    const rena = await call({ line: '2489655355', ageDays: 9 });
    const office = await call({ line: '2484179800', ageDays: 2 });
    quoF.vms[`AC${rena}`] = { status: 403, json: null, errorText: '{"message":"You are forbidden to access the requested Call Voicemails","code":"0900403","status":403,"title":"Forbidden"}' };
    quoF.vms[`AC${office}`] = { status: 200, json: { data: { id: 'VMok', status: 'completed', recordingUrl: 'https://f.quo.example/ok', transcript: null } } };
    const out = await run();
    expect(out.stopped.quo).toBeUndefined();
    const by = Object.fromEntries((await rows()).filter(r => r.kind === 'voicemail').map(r => [r.source_id, r]));
    expect(by[rena]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[rena].last_error).toBe('quo 403 0900403 on /v1/call-voicemails: You are forbidden to access the requested Call Voicemails');
    expect(by[office].state).toBe('archived');
    const al = (await alerts()).filter(a => a.group_key === 'comms_archive_quo_forbidden:2489655355');
    expect(al.length).toBe(1);
    expect(al[0].title).toMatch(/Quo forbids voicemails on line 2489655355 \(Rena\)/);
  });

  test('LOCK an unreadable listing history never fails the tick nor leaks the media lock', async () => {
    media.limits.rcVmMinuteDue = () => false;
    await q('RENAME TABLE job_results TO job_results_off');
    let out;
    try { out = await run(); } finally { await q('RENAME TABLE job_results_off TO job_results'); }
    expect(out.rc_vm_due).toBe(false);                                          // the top-of-hour rule alone decided
    const [[free]] = await pool.query("SELECT IS_FREE_LOCK(CONCAT('comms_archive_media:', DATABASE())) AS f");
    expect(Number(free.f)).toBe(1);
    const again = await run();                                                    // the next tick is not 'locked'
    expect(again.skipped).toBeUndefined();
  });

  test('STT another vendor\'s stt_raw child (S2 \'assemblyai\') never blocks RC\'s own transcript', async () => {
    rcF.pages[1] = [vm('9999999999019')];
    await run(); await run();
    const v = (await rows()).find(r => r.kind === 'voicemail');
    expect(v.state).toBe('archived');
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, captured_at, state)
             VALUES ('phone', 'stt_raw', 'comms_media', ?, 'assemblyai', 'assemblyai', '2024-09-15 19:33:18', 'archived'),
                    ('phone', 'stt_raw', 'comms_media', ?, 'assemblyai-mc', 'ringcentral', '2024-09-15 19:33:18', 'archived')`, [v.id, v.id]);
    rcF.pages[1] = [vm('9999999999019', { transcription: 'Completed', extraAtt: [{ id: 9999999999020, type: 'AudioTranscription' }] })];
    await run();
    const rc = (await rows()).filter(r => r.kind === 'stt_raw' && r.part === '9999999999020');
    expect(rc).toHaveLength(1);
    expect(rc[0]).toMatchObject({ provider: 'ringcentral', source_id: v.id, state: 'pending' });
    // …and still only ONE RC transcript child, however often it is re-listed
    await run();
    expect((await rows()).filter(r => r.kind === 'stt_raw' && /^\d+$/.test(r.part))).toHaveLength(1);
  });
});
