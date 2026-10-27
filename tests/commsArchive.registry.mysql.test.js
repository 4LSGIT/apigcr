// tests/commsArchive.registry.mysql.test.js
//
/**
 * REAL-ENGINE suite: both comms archive sweeps reach the phone adapters
 * through phoneService's registry in production (no opts.rc / opts.quo), and
 * fail LOUD when the registry's adapter cannot archive (ref/COMMS_ARCHIVE_DESIGN.md
 * §3, §6.1; services/commsArchiveCommon.js archiveAdapter / adapterAlert):
 *   RS1  cliff sweep: dispatch through phoneService.getAdapter('ringcentral');
 *   RS2  cliff sweep: missing adapter / archiveFetch false / a promised
 *        function missing → tick stops 'adapter', ONE error alert per day, no
 *        row claimed, no RC call, and the cliff guard still runs;
 *   MS1  media sweep: dispatch through the registry for BOTH providers;
 *   MS2  media sweep: the same three failures, per provider — that provider
 *        stopped ('adapter') and alerted, EVERY lane of it unclaimed (RC: MMS,
 *        rc_message voicemail, its stt_raw child; Quo: recording, voicemail),
 *        the OTHER provider's work done;
 *   MS3  media sweep: a broken RC adapter skips the due voicemail listing
 *        ('incomplete') without a misleading listing-drift alert.
 * Only phoneService.getAdapter is stubbed (jest.spyOn), never the module
 * under test; GCS is tests/helpers/fakeGcs.js. Everything SQL is real.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test (the suite builds its own
 * tables), server on UTC:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_reg_test npx jest tests/commsArchive.registry.mysql.test.js --runInBand
 */

'use strict';

const { Readable } = require('stream');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'log', 'system_alerts', 'alert_state',
  'app_settings', 'scheduled_jobs', 'job_results'];

const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

maybe('comms archive sweeps dispatch through the phone adapter registry (real MySQL)', () => {
  const mysql   = require('mysql2/promise');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const phoneService = require('../services/phoneService');
  const sweep   = require('../services/commsArchiveSweep');
  const media   = require('../services/commsArchiveMediaSweep');
  const ORIG = { sweep: { ...sweep.limits }, media: { ...media.limits } };

  let pool, rcF, quoF, registry;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const rows = () => q('SELECT id, provider, kind, part, state, attempts FROM comms_media ORDER BY id');
  const alerts = () => q('SELECT kind, group_key, severity, title, message FROM system_alerts ORDER BY id');

  // ── fixtures ────────────────────────────────────────────────────────────
  let nextId = 7000, nextLog = 97000;
  async function rcCall({ recId = 'R1', ageDays = 10 } = {}) {
    const id = ++nextId;
    const t = daysAgo(ageDays);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, raw_extra, processed_at)
             VALUES (?, 'ringcentral', ?, 'call', 'incoming', '2489148845', '2485592400', '2489148845', 0, ?, ?)`,
      [id, `REF${id}`, JSON.stringify({ line: '2485592400', provider: 'ringcentral', started_at: t.toISOString(),
        ended_at: new Date(t.getTime() + 60_000).toISOString(), recording_id: recId, telephony_session_id: `s-${id}` }),
      new Date(t.getTime() + 5 * 60_000)]);
    return id;
  }
  async function quoCall({ ageDays = 5 } = {}) {
    const id = ++nextId;
    const t = daysAgo(ageDays);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, raw_extra, processed_at)
             VALUES (?, 'quo', ?, 'call', 'incoming', '2489148845', '2484179800', '2489148845', 0, ?, ?)`,
      [id, `AC${id}`, JSON.stringify({ line: '2484179800', provider: 'quo', started_at: t.toISOString(),
        ended_at: t.toISOString(), recording_id: '', provider_status: 'completed' }), new Date(t.getTime() + 60_000)]);
    return id;
  }
  async function rcMms({ attId = '855604942019', ageDays = 3 } = {}) {
    const id = ++nextId;
    const logId = ++nextLog;
    const t = daysAgo(ageDays);
    await q('INSERT INTO log (log_id, log_data) VALUES (?, ?)', [logId, JSON.stringify({ attachments: [{ id: attId, contentType: 'image/png' }] })]);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, log_id, raw_extra, processed_at)
             VALUES (?, 'ringcentral', ?, 'sms', 'incoming', '2489148845', '2485592400', '2489148845', 0, ?, ?, ?)`,
      [id, String(3091000000000 + id), logId, JSON.stringify({ ts: t.toISOString(), line: '2485592400', provider: 'ringcentral' }),
        new Date(t.getTime() + 2000)]);
    return id;
  }
  const body = (buf, type, extra = {}) => ({ status: 200, contentType: type, contentLength: buf.length, body: Readable.from([buf]), rate: {}, errorText: null, ...extra });

  /** One RC fake serving both sweeps' calls; it declares the capability like the real adapter. */
  function makeRc() {
    const f = {
      capabilities: { sms: true, mms: true, outboundSync: true, archiveFetch: true },
      calls: [],
      async checkArchiveAuth() { f.calls.push(['auth']); return true; },
      async fetchRecordingContent(_db, { recordingId }) {
        f.calls.push(['content', recordingId]);
        return body(Buffer.from(`audio-${recordingId}`), 'audio/mpeg', { rate: { group: 'Heavy', remaining: 9 } });
      },
      async findSessionRecordings() { f.calls.push(['calllog']); return { status: 200, recordings: [], records: 0, rate: {} }; },
      async listVoicemails() { f.calls.push(['vmlist']); return { status: 200, json: { records: [], paging: { page: 1, totalPages: 1 } }, rate: {} }; },
      async fetchMessageAttachment(_db, { attachmentId }) {
        f.calls.push(['att', attachmentId]);
        return body(Buffer.from(`img-${attachmentId}`), 'image/png');
      },
    };
    return f;
  }
  function makeQuo() {
    const f = {
      capabilities: { sms: true, mms: false, outboundSync: false, archiveFetch: true },
      calls: [],
      async checkArchiveAuth() { f.calls.push(['auth']); return true; },
      async getCallVoicemail(_db, { callId }) { f.calls.push(['vm', callId]); return { status: 404, json: null }; },
      async listCallRecordings(_db, { callId }) {
        f.calls.push(['rec', callId]);
        return { status: 200, json: { data: [{ id: 'RECa', url: 'https://files.quo.example/a?sig=1', type: 'audio/mpeg', status: 'completed', duration: 60, startTime: null }] } };
      },
      async getMessage() { f.calls.push(['msg']); return { status: 404, json: null, errorText: 'nf' }; },
      async fetchSigned(url) {
        f.calls.push(['get', url]);
        return body(Buffer.from('quo-a'), 'audio/mpeg', { host: 'files.quo.example' });
      },
    };
    return f;
  }
  /** The registry as the sweeps see it: provider → what getAdapter returns. */
  const stubRegistry = () => jest.spyOn(phoneService, 'getAdapter').mockImplementation((p) => (p in registry ? registry[p] : null));
  const runCliff = () => sweep.runSweep(pool, { heavyPerTick: 10 });     // NO opts.rc — the production path
  const runMedia = () => media.runMediaSweep(pool, {});                  // NO opts.rc / opts.quo
  const adapterAlerts = async (p) => (await alerts()).filter(a => a.group_key === `comms_archive_adapter:${p}`);

  // The three ways an adapter can fail the check, applied to a fresh fake.
  const BREAKS = {
    missing: () => null,
    no_capability: (f) => { f.capabilities = { ...f.capabilities, archiveFetch: false }; return f; },
    no_function: (f, fn) => { delete f[fn]; return f; },
  };
  const BREAK_MSG = {
    missing: /no (ringcentral|quo) adapter in phoneService's registry/,
    no_capability: /does not declare capabilities\.archiveFetch/,
    no_function: /declares archiveFetch but lacks /,
  };

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}" — name must end in _test`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    const [[tz]] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS d');
    if (Number(tz.d) !== 0) throw new Error('server time zone must be UTC (prod parity)');
    await schema.build(pool, TABLES);
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
  });

  afterAll(async () => {
    archive._test.setStorage(null);
    Object.assign(sweep.limits, ORIG.sweep);
    Object.assign(media.limits, ORIG.media);
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    Object.assign(sweep.limits, ORIG.sweep, { sleep: async () => {}, heavySpacingMs: 0 });
    Object.assign(media.limits, ORIG.media, { sleep: async () => {}, rcMediumSpacingMs: 0, quoSpacingMs: 0, captureVoicemails: false });
    for (const t of ['comms_media', 'phone_event_log', 'log', 'system_alerts', 'alert_state', 'phone_lines', 'job_results']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, provider_id, credential_id) VALUES
      (1, '2485592400', 'ringcentral', 1, NULL, 9), (6, '2484179800', 'quo', 1, 'PNb', 10)`);
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_enabled'");
    archive._test.setStorage(fakeStorage().storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    rcF = makeRc();
    quoF = makeQuo();
    registry = { ringcentral: rcF, quo: quoF };
  });

  afterEach(() => jest.restoreAllMocks());

  // ── RS — the cliff sweep (RC call recordings) ───────────────────────────
  test('RS1 production dispatch goes through phoneService.getAdapter("ringcentral")', async () => {
    const spy = stubRegistry();
    await rcCall({ recId: 'R1' });
    const out = await runCliff();
    expect(out).toMatchObject({ enabled: true, discovered: 1, archived: 1, stop: 'drained' });
    expect(spy).toHaveBeenCalledWith('ringcentral');
    expect(rcF.calls).toEqual([['auth'], ['content', 'R1']]);
    expect((await rows()).map(r => r.state)).toEqual(['archived']);
    expect(await adapterAlerts('ringcentral')).toEqual([]);
  });

  test.each(Object.keys(BREAKS))('RS2 a registry adapter that cannot archive (%s) stops the tick LOUD — no claim, no RC call, cliff guard still runs', async (how) => {
    registry.ringcentral = BREAKS[how](rcF, 'fetchRecordingContent');
    stubRegistry();
    await rcCall({ recId: 'R1' });
    await sweep.discover(pool);                                       // a pending row from an earlier tick
    const out = await runCliff();
    expect(out.stop).toBe('adapter');
    expect(out.error).toMatch(BREAK_MSG[how]);
    if (how === 'no_function') expect(out.error).toMatch(/lacks fetchRecordingContent$/);
    expect(out.cliff).toBeDefined();
    expect(out.cliff.error).toBeUndefined();
    expect(rcF.calls).toEqual([]);
    expect(await rows()).toEqual([expect.objectContaining({ state: 'pending', attempts: 0 })]);
    let a = await adapterAlerts('ringcentral');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'comms_archive_adapter', severity: 'error' });
    expect(a[0].message).toMatch(/\(comms_archive_sweep\)/);
    const again = await runCliff();                                   // the next tick: still loud, still ONE row today
    expect(again.stop).toBe('adapter');                               // …and it got the lock: the failed tick released it
    expect(again.skipped).toBeUndefined();
    a = await adapterAlerts('ringcentral');
    expect(a).toHaveLength(1);
  });

  // ── MS — the media sweep (Quo recordings, MMS, voicemails) ──────────────
  test('MS1 production dispatch goes through the registry for both providers', async () => {
    const spy = stubRegistry();
    await rcMms({ attId: '855604942019' });
    await quoCall();
    const out = await runMedia();
    expect(out.archived).toBe(2);
    expect(out.stopped).toEqual({});
    expect(spy.mock.calls.map(c => c[0]).sort()).toEqual(['quo', 'ringcentral']);
    expect(rcF.calls).toEqual(expect.arrayContaining([['att', '855604942019']]));
    expect(quoF.calls).toEqual(expect.arrayContaining([['get', 'https://files.quo.example/a?sig=1']]));
    expect((await rows()).map(r => [r.provider, r.state]).sort()).toEqual([['quo', 'archived'], ['ringcentral', 'archived']]);
  });

  // Every lane of the stopped provider stays unclaimed — including the lanes
  // whose source is not phone_event_log (RC voicemails from the message-store,
  // their stt_raw transcript children) and the Quo voicemail lane, which only
  // runs with captureVoicemails on.
  async function rcVoicemail() {
    const r = await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, captured_at, state)
                       VALUES ('phone', 'voicemail', 'rc_message', '2441801165019', '2441801165019', 'ringcentral', ?, 'pending')`, [daysAgo(20)]);
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, captured_at, state)
             VALUES ('phone', 'stt_raw', 'comms_media', ?, '2441801165020', 'ringcentral', ?, 'pending')`, [r.insertId, daysAgo(20)]);
  }
  async function quoVoicemail(callId) {
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, captured_at, state)
             VALUES ('phone', 'voicemail', 'phone_event_log', ?, '', 'quo', 6, ?, 'pending')`, [callId, daysAgo(5)]);
  }
  const LANES = {
    ringcentral: ['mms_file:phone_event_log', 'stt_raw:comms_media', 'voicemail:rc_message'],
    quo: ['call_recording:phone_event_log', 'voicemail:phone_event_log'],
  };
  const MS2 = [];
  for (const how of Object.keys(BREAKS)) {
    MS2.push(['quo', how, 'fetchSigned']);
    MS2.push(['ringcentral', how, 'fetchMessageAttachment']);
  }
  test.each(MS2)('MS2 %s adapter fails the check (%s): EVERY lane of it stopped + alerted, its rows unclaimed, the other provider archived', async (bad, how, fn) => {
    Object.assign(media.limits, { captureVoicemails: true, rcVmMinuteDue: () => false });
    const good = bad === 'quo' ? 'ringcentral' : 'quo';
    const badF = bad === 'quo' ? quoF : rcF;
    const goodF = bad === 'quo' ? rcF : quoF;
    registry[bad] = BREAKS[how](badF, fn);
    stubRegistry();
    await rcMms({ attId: '855604942019' });
    const qc = await quoCall();
    if (bad === 'ringcentral') await rcVoicemail();
    else await quoVoicemail(qc);
    const out = await runMedia();
    expect(out.stopped).toEqual({ [bad]: 'adapter' });
    expect(out.adapter_errors[bad]).toMatch(BREAK_MSG[how]);
    if (how === 'no_function') expect(out.adapter_errors[bad]).toMatch(new RegExp(`lacks ${fn}$`));
    expect(badF.calls).toEqual([]);
    const all = await q('SELECT provider, kind, source_table, state, attempts FROM comms_media ORDER BY id');
    const mine = all.filter(r => r.provider === bad);
    expect(mine.map(r => `${r.kind}:${r.source_table}`).sort()).toEqual(LANES[bad]);
    for (const r of mine) expect(r).toMatchObject({ state: 'pending', attempts: 0 });
    const goodLane = good === 'quo' ? 'call_recording' : 'mms_file';
    expect(all.find(r => r.provider === good && r.kind === goodLane)).toMatchObject({ state: 'archived' });
    expect(goodF.calls.length).toBeGreaterThan(0);
    const a = await adapterAlerts(bad);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'comms_archive_adapter', severity: 'error' });
    expect(a[0].message).toMatch(/\(comms_archive_media_sweep\)/);
    expect(await adapterAlerts(good)).toEqual([]);
  });

  test('MS3 a broken RC adapter skips the due voicemail listing as incomplete — no misleading listing-drift alert', async () => {
    Object.assign(media.limits, { captureVoicemails: true, rcVmMinuteDue: () => true });
    registry.ringcentral = BREAKS.no_capability(rcF);
    stubRegistry();
    const out = await runMedia();
    expect(out.rc_vm_due).toBe(true);
    expect(out.rc_vm_listing).toBe('incomplete');
    expect(out.drift).toBe(0);
    expect(rcF.calls).toEqual([]);
    const groups = (await alerts()).map(a => a.group_key);
    expect(groups).toContain('comms_archive_adapter:ringcentral');
    expect(groups).not.toContain('comms_archive_rc_vm_listing_drift');
  });
});
