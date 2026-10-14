/**
 * REAL-ENGINE suite for comms archive S1a — services/commsArchiveSweep.js
 * (comms_archive_sweep) on MySQL with the production schema and sql_mode:
 *   M1  the migration applied from disk TWICE (Part A + Part B): one table,
 *       general_ci, the kill switch seeded '0', exactly one job row;
 *   M2  kill switch fail-closed (only the exact '1' runs);
 *   M3  discovery: RC recorded calls inside the 90-day window only, call
 *       clock = raw_extra.started_at (processed_at for tsi rows), oldest
 *       first under the LIMIT; idempotent; suppressed / Quo / sms / >90 d
 *       excluded;
 *   M4  fetch → store → archived (sha256, bytes, mime, object name);
 *   M5  tsi recovery: first recording fills the placeholder, the rest get
 *       rows; REDISCOVERY after recovery keeps the row count stable;
 *   M6  gone / failed / no_line / our-side / no_auth / 429 / non-audio /
 *       length mismatch — who is charged, and alerts grouped per day;
 *   M7  adopt-after-crash (stat-first and the 412 race) without RC calls;
 *   M8  the tick lock (name carries DATABASE()) and the Heavy pacing;
 *   M9  the cliff guard predicate.
 *
 * Stand-ins only at the boundaries: GCS (tests/helpers/fakeGcs.js) and the
 * RingCentral adapter (opts.rc). Everything SQL is the real code on the real
 * engine.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test. The suite builds its own
 * tables from ref/database.sql (DROP + CREATE), so the DB may start empty.
 * The server must run UTC (--default-time-zone=+00:00) like production.
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_test npx jest tests/commsArchive.sweep.mysql.test.js --runInBand
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'system_alerts', 'alert_state', 'app_settings', 'scheduled_jobs'];
const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-10-14_comms_media.sql');

/** CREATE + index/auto-increment ALTER blocks for `tables`, line-based (COMMENTs carry ';'). */
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [], alters = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].match(/^CREATE TABLE `([^`]+)` \($/);
    const a = lines[i].match(/^ALTER TABLE `([^`]+)`$/);
    if (c && tables.includes(c[1])) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
      creates.push(buf.join('\n'));
    } else if (a && tables.includes(a[1])) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/;$/.test(lines[i])) break; }
      const s = buf.join('\n');
      if (!/ADD CONSTRAINT/.test(s)) alters.push(s);
    }
  }
  return { creates, alters };
}

/** Migration statements: strip whole-line comments, split at a line-final ';'. */
function migrationStatements() {
  const body = fs.readFileSync(MIGRATION, 'utf8').split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  return body.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

maybe('comms_archive_sweep on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const archive = require('../services/commsArchiveService');
  const sweep   = require('../services/commsArchiveSweep');
  const ORIGINAL_LIMITS = { ...sweep.limits };

  let pool, gcs, rcFake, seededSwitch;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  // ── fixtures ────────────────────────────────────────────────────────────
  let nextId = 1000;
  async function ev({ provider = 'ringcentral', line = '2485592400', recId = null, tsi = false,
    ageDays = 10, suppressed = 0, type = 'call', other = '2489148845' } = {}) {
    const id = ++nextId;
    const started = daysAgo(ageDays);
    const ref = tsi ? `tsi:s-${id}` : `REF${id}`;
    const raw = {
      line, provider,
      started_at: tsi ? '' : iso(started),
      ended_at: tsi ? '' : iso(new Date(started.getTime() + 60_000)),
      recording_id: recId == null ? '' : String(recId),
      telephony_session_id: `s-${id}`,
    };
    await q(
      `INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
         other_party, suppressed, raw_extra, processed_at)
       VALUES (?, ?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?)`,
      [id, provider, ref, type, other, line, other, suppressed, JSON.stringify(raw),
        new Date(started.getTime() + 5 * 60_000)],
    );
    return id;
  }

  function audioRes(buf, extra = {}) {
    return {
      status: 200, contentType: 'audio/mpeg', contentLength: buf.length,
      body: Readable.from([buf]), rate: { group: 'Heavy', remaining: 9 }, errorText: null, ...extra,
    };
  }

  function makeRc() {
    const f = {
      auth: true, calls: [], content: {}, sessions: {},
      async checkArchiveAuth() { return f.auth; },
      async fetchRecordingContent(_db, { recordingId, timeoutMs }) {
        f.calls.push(['content', recordingId, Date.now()]);
        f.lastTimeoutMs = timeoutMs;
        const r = f.content[recordingId];
        if (typeof r === 'function') return r();
        if (r) return r;
        return audioRes(Buffer.from(`audio-${recordingId}`));
      },
      async findSessionRecordings(_db, { telephonySessionId }) {
        f.calls.push(['calllog', telephonySessionId, Date.now()]);
        return f.sessions[telephonySessionId] || { status: 200, recordings: [], records: 0, rate: {} };
      },
    };
    return f;
  }

  const run = (opts = {}) => sweep.runSweep(pool, { rc: rcFake, heavyPerTick: 10, ...opts });
  const media = () => q('SELECT * FROM comms_media ORDER BY id');
  const alerts = () => q('SELECT group_key, kind, severity, title, dedup_key FROM system_alerts ORDER BY id');

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}" — name must end in _test`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 6, timezone: 'Z', multipleStatements: false });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    const [[tz]] = await pool.query("SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS d");
    if (Number(tz.d) !== 0) throw new Error('server time zone must be UTC (prod parity)');

    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES, 'comms_media']) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    const { creates, alters } = schemaFor(TABLES);
    expect(creates.length).toBe(TABLES.length);
    for (const s of creates) await pool.query(s);
    for (const s of alters) await pool.query(s);
    // First apply (M1 re-applies and asserts both passes).
    for (const s of migrationStatements()) await pool.query(s);
    seededSwitch = (await q("SELECT `value` FROM app_settings WHERE `key` = 'comms_archive_enabled'"))[0].value;
  });

  afterAll(async () => {
    archive._test.setStorage(null);
    Object.assign(sweep.limits, ORIGINAL_LIMITS);
    if (pool) await pool.end();
  });

  // ── M1 — the migration, twice ───────────────────────────────────────────
  test('M1 migration applies twice: table, collation, kill switch off, one job row', async () => {
    // beforeEach has flipped the switch to '1'; the second apply must not clobber it.
    for (const s of migrationStatements()) await pool.query(s);
    expect(seededSwitch).toBe('0');
    const [[t]] = await pool.query(
      `SELECT TABLE_COLLATION AS c, TABLE_COMMENT AS cm FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comms_media'`);
    expect(t.c).toBe('utf8mb4_general_ci');
    expect(t.cm).toMatch(/Comms archive registry/);
    const cols = await q(`SELECT COLUMN_NAME AS n, COLLATION_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comms_media'`);
    expect(cols.map(c => c.n)).toEqual(expect.arrayContaining([
      'channel', 'kind', 'source_table', 'source_id', 'part', 'provider', 'channel_id', 'party',
      'object_name', 'mime', 'bytes', 'sha256', 'duration_s', 'audio_channels', 'captured_at',
      'state', 'restricted', 'attempts', 'next_attempt_at', 'last_error', 'archived_at',
      'purged_at', 'purged_by', 'purge_reason', 'created_at', 'updated_at']));
    for (const c of cols) if (c.c) expect(c.c).toBe('utf8mb4_general_ci');
    expect((await q("SELECT `value` FROM app_settings WHERE `key` = 'comms_archive_enabled'"))[0].value).toBe('1');
    const jobs = await q("SELECT type, status, recurrence_rule, max_attempts, data FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_sweep'");
    expect(jobs.length).toBe(1);
    expect(jobs[0]).toMatchObject({ type: 'recurring', status: 'pending', recurrence_rule: '*/2 * * * *', max_attempts: 1 });
    const data = typeof jobs[0].data === 'string' ? JSON.parse(jobs[0].data) : jobs[0].data;
    expect(data).toEqual({ type: 'internal_function', params: {}, function_name: 'comms_archive_sweep' });
  });

  beforeEach(async () => {
    Object.assign(sweep.limits, ORIGINAL_LIMITS, { sleep: async () => {}, heavySpacingMs: 0 });
    for (const t of ['comms_media', 'phone_event_log', 'system_alerts', 'alert_state', 'phone_lines']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, credential_id) VALUES
      (1, '2485592400', 'ringcentral', 1, 9), (7, '7344663328', 'ringcentral', 0, 9), (2, '2489654574', 'quo', 1, 10)`);
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_enabled'");
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    rcFake = makeRc();
  });

  // ── M2 — kill switch ────────────────────────────────────────────────────
  test('M2 kill switch: only the exact string "1" runs', async () => {
    await ev({ recId: 'r1' });
    for (const v of ['0', '', '1 ', 'true', 'yes']) {
      await q("UPDATE app_settings SET `value` = ? WHERE `key` = 'comms_archive_enabled'", [v]);
      const out = await run();
      expect(out.enabled).toBe(false);
      expect(out.skipped).toMatch(/comms_archive_enabled/);
    }
    await q("DELETE FROM app_settings WHERE `key` = 'comms_archive_enabled'");
    expect((await run()).enabled).toBe(false);
    expect(await media()).toEqual([]);
    expect(rcFake.calls).toEqual([]);
    await q(`INSERT INTO app_settings (\`key\`, \`value\`, is_secret, is_editable, category, label, description, \`type\`, sort_order)
             VALUES ('comms_archive_enabled', '1', 0, 1, 'Automations', 'x', 'x', 'bool', 40)`);
  });

  // ── M3 — discovery ──────────────────────────────────────────────────────
  test('M3 discovery: window, exclusions, call clock, oldest first, idempotent', async () => {
    const young   = await ev({ recId: 'young', ageDays: 3 });
    const edge    = await ev({ recId: 'edge', ageDays: 85 });
    const tsi     = await ev({ tsi: true, ageDays: 20 });
    const inactiveLine = await ev({ recId: 'old-line', line: '7344663328', ageDays: 40 });
    await ev({ recId: 'gone-already', ageDays: 95 });
    await ev({ recId: 'supp', suppressed: 1 });
    await ev({ provider: 'quo', line: '2489654574' });
    await ev({ type: 'sms', recId: 'sms' });
    await ev({ recId: '' });                                // RC, no recording, not tsi

    sweep.limits.discoverLimit = 1;
    expect(await sweep.discover(pool)).toBe(1);
    expect((await media()).map(m => m.source_id)).toEqual([edge]);   // oldest first
    sweep.limits.discoverLimit = 200;
    expect(await sweep.discover(pool)).toBe(3);
    expect(await sweep.discover(pool)).toBe(0);                       // idempotent

    const rows = await media();
    const by = Object.fromEntries(rows.map(r => [r.source_id, r]));
    expect(Object.keys(by).map(Number).sort()).toEqual([young, edge, tsi, inactiveLine].sort());
    expect(by[young]).toMatchObject({ channel: 'phone', kind: 'call_recording', source_table: 'phone_event_log',
      part: 'young', provider: 'ringcentral', channel_id: 1, party: '2489148845', state: 'pending', attempts: 0 });
    expect(by[inactiveLine].channel_id).toBe(7);
    expect(by[tsi].part).toBe('');

    // Call clock: started_at, to the second; tsi rows fall back to processed_at.
    const [e1] = await q('SELECT raw_extra, processed_at FROM phone_event_log WHERE id = ?', [young]);
    const raw = typeof e1.raw_extra === 'string' ? JSON.parse(e1.raw_extra) : e1.raw_extra;
    expect(Math.abs(new Date(by[young].captured_at) - new Date(raw.started_at))).toBeLessThan(1000);
    const [e2] = await q('SELECT processed_at FROM phone_event_log WHERE id = ?', [tsi]);
    expect(new Date(by[tsi].captured_at).getTime()).toBe(new Date(e2.processed_at).getTime());
  });

  // ── M4 — happy path ─────────────────────────────────────────────────────
  test('M4 fetch → store → archived, oldest first, one UPDATE of every field', async () => {
    const older = await ev({ recId: '3091', ageDays: 60 });
    const newer = await ev({ recId: '3092', ageDays: 5 });
    const out = await run();
    expect(out).toMatchObject({ enabled: true, discovered: 2, archived: 2, heavy_used: 2, stop: 'drained' });
    expect(rcFake.calls.map(c => c[1])).toEqual(['3091', '3092']);
    const rows = await media();
    for (const r of rows) {
      const body = Buffer.from(`audio-${r.part}`);
      const cap = new Date(r.captured_at);
      const name = `phone/rec/${cap.getUTCFullYear()}/${String(cap.getUTCMonth() + 1).padStart(2, '0')}/${r.source_id}-${r.part}.mp3`;
      expect(r).toMatchObject({ state: 'archived', object_name: name, mime: 'audio/mpeg',
        bytes: body.length, sha256: sha(body), attempts: 1, next_attempt_at: null, last_error: null });
      expect(r.archived_at).not.toBeNull();
      expect(gcs.objects.get(name).buf.equals(body)).toBe(true);
    }
    expect(rows.map(r => r.source_id).sort()).toEqual([older, newer].sort());
    // a second tick does nothing
    const again = await run();
    expect(again).toMatchObject({ discovered: 0, archived: 0, heavy_used: 0, stop: 'drained' });
  });

  // ── M5 — tsi recovery + the rediscovery bug ─────────────────────────────
  test('M5 tsi: first recording fills the placeholder, the rest split; rediscovery is stable', async () => {
    const id = await ev({ tsi: true, ageDays: 30 });
    rcFake.sessions[`s-${id}`] = { status: 200, records: 2, rate: {},
      recordings: [{ id: 'A1' }, { id: 'B2' }] };
    const out = await run();
    expect(out).toMatchObject({ resolved: 1, split: 1, archived: 2 });
    let rows = await media();
    expect(rows.map(r => [r.source_id, r.part, r.state])).toEqual([[id, 'A1', 'archived'], [id, 'B2', 'archived']]);

    // The bug the ruling named: discovery must test existence on
    // (source_table, source_id, kind) REGARDLESS of part.
    expect(await sweep.discover(pool)).toBe(0);
    await run();
    rows = await media();
    expect(rows.length).toBe(2);
    expect(rows.filter(r => r.part === '').length).toBe(0);
  });

  test('M5b tsi with nothing listed: young → back off uncharged; > 24 h → none', async () => {
    const young = await ev({ tsi: true, ageDays: 0.2 });
    const old   = await ev({ tsi: true, ageDays: 3 });
    const out = await run();
    expect(out).toMatchObject({ none: 1, retried: 1 });
    const by = Object.fromEntries((await media()).map(r => [r.source_id, r]));
    expect(by[old]).toMatchObject({ state: 'none', part: '' });
    expect(by[young]).toMatchObject({ state: 'pending', attempts: 0 });
    expect(by[young].next_attempt_at).not.toBeNull();
  });

  test('M5c a call-log 404 is NOT gone (it says nothing about a recording): transient', async () => {
    const id = await ev({ tsi: true, ageDays: 30 });
    rcFake.sessions[`s-${id}`] = { status: 404, recordings: [], records: 0, rate: {}, errorText: 'nf' };
    const out = await run();
    expect(out).toMatchObject({ gone: 0, retried: 1 });
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 1 });
  });

  test('F2 call-log records but none for this session: parked uncharged, never none, one alert/day', async () => {
    const id = await ev({ tsi: true, ageDays: 3 });
    rcFake.sessions[`s-${id}`] = { status: 200, recordings: [], records: 0, rawRecords: 3, rate: {} };
    let out = await run();
    expect(out).toMatchObject({ session_mismatch: 1, none: 0 });
    let [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 0, part: '' });
    expect(r.next_attempt_at).not.toBeNull();
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    out = await run();
    expect(out.session_mismatch).toBe(1);
    const a = (await alerts()).filter(x => x.group_key === 'comms_archive_session_mismatch');
    expect(a.map(x => x.severity)).toEqual(['error']);
    // terminal only past RC's window
    await q('UPDATE comms_media SET next_attempt_at = NULL, captured_at = UTC_TIMESTAMP() - INTERVAL 91 DAY');
    out = await run();
    expect(out.failed).toBe(1);
    expect((await media())[0].state).toBe('failed');
  });

  // ── M6 — failure charging + alerts ──────────────────────────────────────
  test('M6a 404 → gone; ONE gone alert per day however many rows and ticks', async () => {
    for (let i = 0; i < 3; i++) {
      const rid = `g${i}`;
      await ev({ recId: rid, ageDays: 89 });
      rcFake.content[rid] = { status: 404, body: null, rate: {}, errorText: '{"errorCode":"CMN-102"}' };
    }
    const out = await run();
    expect(out.gone).toBe(3);
    expect((await media()).every(r => r.state === 'gone')).toBe(true);
    await ev({ recId: 'g9', ageDays: 89 });
    rcFake.content.g9 = { status: 404, body: null, rate: {}, errorText: '' };
    await run();
    const gone = (await alerts()).filter(a => a.group_key === 'comms_archive_gone');
    expect(gone.length).toBe(1);
    expect(gone[0]).toMatchObject({ severity: 'error' });
    expect(gone[0].title).toMatch(/^Comms archive: 3 recording/);
  });

  test('S1 a content 404 on a call younger than 24 h is "not yet", never gone', async () => {
    await ev({ recId: 'y1', ageDays: 0.01 });          // ~15 min old
    rcFake.content.y1 = { status: 404, body: null, rate: {}, errorText: '{"errorCode":"CMN-102"}' };
    const out = await run();
    expect(out).toMatchObject({ gone: 0, retried: 1 });
    const [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 1 });
    expect(r.next_attempt_at).not.toBeNull();
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_gone')).toEqual([]);
  });

  test('M6b retries never abandon a live recording: plateau at 6 h (error), failed only past 90 d', async () => {
    sweep.limits.maxAttempts = 2;
    await ev({ recId: 't1', ageDays: 10 });
    rcFake.content.t1 = { status: 503, body: null, rate: {}, errorText: 'busy' };
    let out = await run();
    expect(out.retried).toBe(1);
    let [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 1 });
    expect(r.last_error).toMatch(/content 503/);
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    out = await run();
    expect(out).toMatchObject({ stuck: 1, failed: 0 });
    [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 2 });
    expect((new Date(r.next_attempt_at) - Date.now()) / 3_600_000).toBeGreaterThan(5.9);
    let st = (await alerts()).filter(a => a.group_key === 'comms_archive_stuck');
    expect(st.map(a => a.severity)).toEqual(['error']);       // repeated failure = error, first time
    // the plateau keeps retrying; still one alert row per day
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    out = await run();
    expect(out.stuck).toBe(1);
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 3 });
    st = (await alerts()).filter(a => a.group_key === 'comms_archive_stuck');
    expect(st.length).toBe(1);
    // only once the call is past 90 days (call clock) does a failure become terminal
    await q('UPDATE comms_media SET next_attempt_at = NULL, captured_at = UTC_TIMESTAMP() - INTERVAL 91 DAY');
    out = await run();
    expect(out.failed).toBe(1);
    expect((await media())[0]).toMatchObject({ state: 'failed', attempts: 4 });
    const f = (await alerts()).filter(a => a.group_key === 'comms_archive_failed');
    expect(f.map(a => a.severity)).toEqual(['error']);
  });

  test('M6c 200 that is not audio, and a short body: never stored, charged as provider transient', async () => {
    await ev({ recId: 'html', ageDays: 10 });
    await ev({ recId: 'short', ageDays: 9 });
    rcFake.content.html = { status: 200, contentType: 'text/html; charset=utf-8', contentLength: 5,
      body: Readable.from([Buffer.from('<html>')]), rate: {} };
    rcFake.content.short = () => audioRes(Buffer.from('abc'), { contentLength: 999 });
    const out = await run();
    expect(out).toMatchObject({ archived: 0, retried: 2 });
    expect(gcs.objects.size).toBe(0);
    for (const r of await media()) {
      expect(r).toMatchObject({ state: 'pending', attempts: 1, object_name: null, sha256: null });
    }
    const errs = (await media()).map(r => r.last_error).join(' | ');
    expect(errs).toMatch(/non-audio content-type text\/html/);
    expect(errs).toMatch(/length mismatch/);
  });

  test('S3 a 200 audio body of 0 bytes is a provider transient, never archived', async () => {
    await ev({ recId: 'empty', ageDays: 10 });
    rcFake.content.empty = () => audioRes(Buffer.alloc(0));
    const out = await run();
    expect(out).toMatchObject({ archived: 0, retried: 1 });
    expect(gcs.objects.size).toBe(0);
    const [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 1, sha256: null });
    expect(r.last_error).toMatch(/empty/);
  });

  test('M6d our side — create denied: NO row claimed, no RC call; warning then error; guard still runs', async () => {
    await ev({ recId: 'b1', ageDays: 10 });
    await ev({ recId: 'b2', ageDays: 11 });
    await ev({ recId: 'b3', ageDays: 80 });          // at risk: the guard must still see it
    gcs.denied.add('storage.objects.create');        // list still works — the review's case
    let out = await run();
    expect(out.stop).toBe('storage');
    expect(out.error).toMatch(/storage\.objects\.create/);
    expect(await media()).toEqual([]);            // pre-flight runs before discovery too
    expect(rcFake.calls).toEqual([]);
    expect(out.cliff).toMatchObject({ at_risk: 1 });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_cliff').length).toBe(1);
    out = await run();
    const s = (await alerts()).filter(a => a.group_key === 'comms_archive_storage');
    expect(s.map(a => a.severity)).toEqual(['warning', 'error']);

    // bucket unset is the same path
    gcs.denied.clear();
    delete process.env.COMMS_ARCHIVE_BUCKET;
    out = await run();
    expect(out.stop).toBe('storage');
    expect(out.error).toMatch(/not configured/);
    expect(await media()).toEqual([]);
  });

  test('M6e our side — GCS refuses the put mid-tick: attempt refunded, tick ends', async () => {
    await ev({ recId: 'p1', ageDays: 10 });
    await ev({ recId: 'p2', ageDays: 9 });
    gcs.fail.put = { code: 500 };
    const out = await run();
    expect(out.stop).toBe('storage');
    expect(rcFake.calls.length).toBe(1);           // ended after the first
    for (const r of await media()) expect(r).toMatchObject({ state: 'pending', attempts: 0, next_attempt_at: null });
  });

  test('M1 a GCS 403 / reset WHILE the RC body is flowing is ours: refunded, never charged to RC', async () => {
    await ev({ recId: 'f1', ageDays: 10 });
    await ev({ recId: 'f2', ageDays: 9 });
    rcFake.content.f1 = () => {
      let n = 0;
      const body = new Readable({ read() { setTimeout(() => this.push(n++ < 20 ? Buffer.from('mp3') : null), 2); } });
      return { status: 200, contentType: 'audio/mpeg', contentLength: 60, body, rate: {}, errorText: null };
    };
    for (const code of [403, 'ECONNRESET']) {
      gcs.fail.putMid = { code };
      const out = await run();
      expect(out.stop).toBe('storage');
      for (const r of await media()) expect(r).toMatchObject({ state: 'pending', attempts: 0, next_attempt_at: null });
    }
    expect(gcs.objects.size).toBe(0);
  });

  test('M2 a stalled upload ends the tick: row refunded, lock freed, guard ran', async () => {
    Object.assign(sweep.limits, { hardDeadlineMs: 400, minIoMs: 50, uploadMarginMs: 100 });
    await ev({ recId: 'st1', ageDays: 10 });
    await ev({ recId: 'risk', ageDays: 82 });
    gcs.fail.stall = true;
    const t0 = Date.now();
    const out = await run();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.stop).toBe('storage');
    expect(out.error).toMatch(/timed out/);
    for (const r of await media()) expect(r).toMatchObject({ state: 'pending', attempts: 0 });
    const [[free]] = await pool.query("SELECT IS_FREE_LOCK(CONCAT('comms_archive_sweep:', DATABASE())) AS f");
    expect(Number(free.f)).toBe(1);
    expect(out.cliff.at_risk).toBeGreaterThanOrEqual(1);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_cliff').length).toBe(1);
  });

  test('F1 RC stalling the body at the hard deadline is charged to RC, not to storage', async () => {
    Object.assign(sweep.limits, { hardDeadlineMs: 300, minIoMs: 50 });
    await ev({ recId: 'rcstall', ageDays: 10 });
    rcFake.content.rcstall = () => {
      // RC sends a little, then nothing — until fetch's AbortSignal fires at the
      // bound the sweep gave it (+ the few ms a real abort takes to surface).
      const body = new Readable({ read() {} });
      body.push(Buffer.from('ID3'));
      const ms = rcFake.lastTimeoutMs;
      setTimeout(() => body.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), ms + 20);
      return { status: 200, contentType: 'audio/mpeg', contentLength: null, body, rate: {}, errorText: null };
    };
    const out = await run();
    expect(out.stop).not.toBe('storage');
    expect(out.retried).toBe(1);
    const [r] = await media();
    expect(r).toMatchObject({ state: 'pending', attempts: 1 });
    expect(r.last_error).toMatch(/source stream failed/);
    expect(gcs.objects.size).toBe(0);
  });

  test('M2 a THROWN tick still runs the guard (and rejects)', async () => {
    await ev({ recId: 'risk', ageDays: 82 });
    rcFake.checkArchiveAuth = async () => { throw new Error('boom'); };
    await expect(run()).rejects.toThrow('boom');
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_cliff').length).toBe(1);
    const [[free]] = await pool.query("SELECT IS_FREE_LOCK(CONCAT('comms_archive_sweep:', DATABASE())) AS f");
    expect(Number(free.f)).toBe(1);
  });

  test('M6f no_auth: checked BEFORE any claim; nothing charged; RC 401 refunds too', async () => {
    await ev({ recId: 'n1', ageDays: 10 });
    rcFake.auth = false;
    let out = await run();
    expect(out.stop).toBe('no_auth');
    expect(rcFake.calls).toEqual([]);
    expect((await media())[0]).toMatchObject({ attempts: 0, next_attempt_at: null });
    rcFake.auth = true;
    rcFake.content.n1 = { status: 401, body: null, rate: {}, errorText: 'unauthorized' };
    out = await run();
    expect(out.stop).toBe('no_auth');
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 0 });
    const a = (await alerts()).filter(x => x.group_key === 'comms_archive_no_auth:9');
    expect(a.map(x => x.severity)).toEqual(['warning', 'error']);
  });

  test('M6g 429: refund, end tick, Retry-After reported', async () => {
    await ev({ recId: 'r1', ageDays: 10 });
    await ev({ recId: 'r2', ageDays: 9 });
    rcFake.content.r1 = { status: 429, body: null, rate: { retryAfterS: 60 }, errorText: '' };
    const out = await run();
    expect(out).toMatchObject({ stop: 'rate_limited', retry_after_s: 60 });
    expect(rcFake.calls.length).toBe(1);
    for (const r of await media()) expect(r).toMatchObject({ state: 'pending', attempts: 0 });
  });

  test('M6h no_line: stays pending uncharged, 6 h backoff, one alert per line; heals when the line is added', async () => {
    const a = await ev({ recId: 'o1', line: '8332665245', ageDays: 10 });
    await ev({ recId: 'o2', line: '8332665245', ageDays: 11 });
    const out = await run();
    expect(out.no_line).toBe(2);
    expect(rcFake.calls).toEqual([]);
    const rows = await media();
    for (const r of rows) {
      expect(r).toMatchObject({ state: 'pending', attempts: 0, last_error: 'no_line', channel_id: null });
      const h = (new Date(r.next_attempt_at) - Date.now()) / 3_600_000;
      expect(h).toBeGreaterThan(5.9);
    }
    const al = (await alerts()).filter(x => x.group_key === 'comms_archive_no_line:8332665245');
    expect(al.length).toBe(1);
    expect(al[0].severity).toBe('warning');

    // Fred's registration shape for orphan firm numbers (like lines 7–19):
    // INACTIVE — the sweep must not filter on phone_lines.active.
    await q(`INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id, mms_capable)
             VALUES (20, '8332665245', 'ringcentral', 'RC-8332665245', 0, 9, 1)`);
    await q('UPDATE comms_media SET next_attempt_at = NULL');
    const healed = await run();
    expect(healed.archived).toBe(2);
    const fixed = (await media()).find(r => r.source_id === a);
    expect(fixed).toMatchObject({ state: 'archived', channel_id: 20 });
  });

  test('F3 a no_line call past 90 days is terminal: failed + error, no further retries', async () => {
    await ev({ recId: 'o9', line: '8339999999', ageDays: 85 });
    await sweep.discover(pool);
    await q('UPDATE comms_media SET captured_at = UTC_TIMESTAMP() - INTERVAL 91 DAY');
    const out = await run();
    expect(out).toMatchObject({ failed: 1, no_line: 0 });
    const [r] = await media();
    expect(r).toMatchObject({ state: 'failed', attempts: 0 });
    expect(r.last_error).toMatch(/no_line/);
    expect((await alerts()).filter(x => x.group_key === 'comms_archive_failed').map(x => x.severity)).toEqual(['error']);
    expect((await alerts()).filter(x => x.group_key.startsWith('comms_archive_no_line'))).toEqual([]);
  });

  // ── M7 — adopt-after-crash ──────────────────────────────────────────────
  test('M7a stat-first: an object already under the prefix is adopted, no RC call', async () => {
    const id = await ev({ recId: 'c1', ageDays: 10 });
    await sweep.discover(pool);
    const [r] = await media();
    const prefix = archive.recordingPrefix({ capturedAt: r.captured_at, sourceId: id, part: 'c1' });
    const body = Buffer.from('uploaded before the crash');
    gcs.objects.set(`${prefix}wav`, { buf: body, contentType: 'audio/x-wav', generation: '1' });
    const out = await run();
    expect(out).toMatchObject({ adopted: 1, archived: 0, heavy_used: 0 });
    expect(rcFake.calls).toEqual([]);
    expect((await media())[0]).toMatchObject({ state: 'archived', object_name: `${prefix}wav`,
      sha256: sha(body), bytes: body.length, mime: 'audio/wav' });
  });

  test('M7b the 412 race: put loses to an object that appeared after the stat → adopt', async () => {
    const id = await ev({ recId: 'c2', ageDays: 10 });
    await sweep.discover(pool);
    const [r] = await media();
    const name = archive.recordingPrefix({ capturedAt: r.captured_at, sourceId: id, part: 'c2' }) + 'mp3';
    const theirs = Buffer.from('the other runner');
    rcFake.content.c2 = () => {
      gcs.objects.set(name, { buf: theirs, contentType: 'audio/mpeg', generation: '7' });
      return audioRes(Buffer.from('mine'));
    };
    const out = await run();
    expect(out.adopted).toBe(1);
    expect((await media())[0]).toMatchObject({ state: 'archived', sha256: sha(theirs) });
    expect(gcs.objects.get(name).buf.equals(theirs)).toBe(true);   // never overwritten
  });

  test('M7c two objects under one prefix: anomaly, left pending uncharged, one alert', async () => {
    const id = await ev({ recId: 'c3', ageDays: 10 });
    await sweep.discover(pool);
    const [r] = await media();
    const prefix = archive.recordingPrefix({ capturedAt: r.captured_at, sourceId: id, part: 'c3' });
    gcs.objects.set(`${prefix}mp3`, { buf: Buffer.from('a'), contentType: 'audio/mpeg', generation: '1' });
    gcs.objects.set(`${prefix}wav`, { buf: Buffer.from('b'), contentType: 'audio/wav', generation: '2' });
    await run();
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_anomaly').length).toBe(1);
  });

  test('F4 a 0-byte object met through the 412 race is refused: anomaly, pending uncharged', async () => {
    const id = await ev({ recId: 'c5', ageDays: 10 });
    await sweep.discover(pool);
    const [r] = await media();
    const name = archive.recordingPrefix({ capturedAt: r.captured_at, sourceId: id, part: 'c5' }) + 'mp3';
    rcFake.content.c5 = () => {
      gcs.objects.set(name, { buf: Buffer.alloc(0), contentType: 'audio/mpeg', generation: '9' });
      return audioRes(Buffer.from('mine'));
    };
    const out = await run();
    expect(out).toMatchObject({ adopted: 0, archived: 0 });
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 0, sha256: null });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_anomaly').length).toBe(1);
  });

  test('S3 adopt refuses a 0-byte object: anomaly, pending uncharged, no RC call', async () => {
    const id = await ev({ recId: 'c4', ageDays: 10 });
    await sweep.discover(pool);
    const [r] = await media();
    const prefix = archive.recordingPrefix({ capturedAt: r.captured_at, sourceId: id, part: 'c4' });
    gcs.objects.set(`${prefix}mp3`, { buf: Buffer.alloc(0), contentType: 'audio/mpeg', generation: '1' });
    const out = await run();
    expect(out).toMatchObject({ adopted: 0, archived: 0 });
    expect(rcFake.calls).toEqual([]);
    expect((await media())[0]).toMatchObject({ state: 'pending', attempts: 0, sha256: null });
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_anomaly').length).toBe(1);
  });

  // ── M8 — lock + pacing ──────────────────────────────────────────────────
  test('M8a tick lock: held elsewhere → skipped (guard still runs); its name carries DATABASE()', async () => {
    await ev({ recId: 'l1', ageDays: 10 });
    await ev({ recId: 'l-risk', ageDays: 85 });
    const conn = await pool.getConnection();
    try {
      const [[g]] = await conn.query("SELECT GET_LOCK(CONCAT('comms_archive_sweep:', DATABASE()), 0) AS got");
      expect(Number(g.got)).toBe(1);
      const out = await run();
      expect(out.skipped).toBe('locked');
      expect(await media()).toEqual([]);
      expect(out.cliff).toMatchObject({ at_risk: 1, no_row: 1 });
      expect((await alerts()).filter(a => a.group_key === 'comms_archive_cliff').length).toBe(1);
      // a same-named lock for ANOTHER database does not block this one
      await conn.query("SELECT RELEASE_LOCK(CONCAT('comms_archive_sweep:', DATABASE()))");
      await conn.query("SELECT GET_LOCK('comms_archive_sweep:other_tenant', 0)");
      expect((await run()).archived).toBe(2);
      await conn.query("SELECT RELEASE_LOCK('comms_archive_sweep:other_tenant')");
    } finally { conn.release(); }
    // released after the tick
    const [[free]] = await pool.query("SELECT IS_FREE_LOCK(CONCAT('comms_archive_sweep:', DATABASE())) AS f");
    expect(Number(free.f)).toBe(1);
  });

  test('M8b two concurrent ticks: one works, one is locked out; nothing double-processed', async () => {
    for (let i = 0; i < 4; i++) await ev({ recId: `cc${i}`, ageDays: 10 + i });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.skipped, b.skipped].filter(s => s === 'locked').length).toBe(1);
    expect(a.archived + b.archived).toBe(4);
    expect(rcFake.calls.length).toBe(4);
  });

  test('M8c pacing: at most heavy_per_tick Heavy calls, spaced; the rest stay pending uncharged', async () => {
    const slept = [];
    Object.assign(sweep.limits, { heavySpacingMs: 20_000, sleep: async (ms) => { slept.push(ms); } });
    for (let i = 0; i < 5; i++) await ev({ recId: `h${i}`, ageDays: 50 - i });
    const out = await sweep.runSweep(pool, { rc: rcFake, heavyPerTick: 3 });
    expect(out).toMatchObject({ archived: 3, heavy_used: 3, stop: 'heavy_budget' });
    expect(slept.length).toBe(2);
    for (const ms of slept) expect(ms).toBeGreaterThan(19_000);
    expect(rcFake.calls.map(c => c[1])).toEqual(['h0', 'h1', 'h2']);   // oldest first
    const pend = (await media()).filter(r => r.state === 'pending');
    expect(pend.length).toBe(2);
    for (const r of pend) expect(r).toMatchObject({ attempts: 0, next_attempt_at: null });
  });

  test('M8c2 heavy_per_tick above what 20 s spacing fits in 45 s is clamped to 3', async () => {
    Object.assign(sweep.limits, { heavySpacingMs: 20_000 });
    expect(sweep.maxHeavyPerTick()).toBe(3);
    for (let i = 0; i < 6; i++) await ev({ recId: `x${i}`, ageDays: 40 - i });
    const out = await sweep.runSweep(pool, { rc: rcFake, heavyPerTick: 10 });
    expect(out).toMatchObject({ heavy_used: 3, stop: 'heavy_budget' });
  });

  test('M8d RC reports the Heavy band nearly spent → stop after that item', async () => {
    await ev({ recId: 'q1', ageDays: 10 });
    await ev({ recId: 'q2', ageDays: 9 });
    rcFake.content.q1 = () => audioRes(Buffer.from('x'), { rate: { group: 'Heavy', remaining: 4 } });
    const out = await run();
    expect(out).toMatchObject({ archived: 1, stop: 'rate_low' });
  });

  // ── M9 — cliff guard ────────────────────────────────────────────────────
  test('M9 cliff guard: 75–90 d not all archived/none/purged; one error alert per day', async () => {
    const atRisk  = await ev({ recId: 'k1', ageDays: 80 });     // no row yet
    const done    = await ev({ recId: 'k2', ageDays: 80 });
    const lost    = await ev({ recId: 'k3', ageDays: 95 });     // past the window — ignored
    const fresh   = await ev({ recId: 'k4', ageDays: 30 });     // too young — ignored
    const split   = await ev({ tsi: true, ageDays: 78 });
    const goneC   = await ev({ recId: 'k5', ageDays: 88 });     // gone is NOT resolved
    const failC   = await ev({ recId: 'k6', ageDays: 77 });     // failed is NOT resolved
    await q(`INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, state)
             VALUES ('phone','call_recording','phone_event_log',?, 'k2','ringcentral','archived'),
                    ('phone','call_recording','phone_event_log',?, 'S1','ringcentral','archived'),
                    ('phone','call_recording','phone_event_log',?, 'S2','ringcentral','pending'),
                    ('phone','call_recording','phone_event_log',?, 'k5','ringcentral','gone'),
                    ('phone','call_recording','phone_event_log',?, 'k6','ringcentral','failed')`,
      [done, split, split, goneC, failC]);
    void atRisk; void lost; void fresh;
    let c = await sweep.cliffGuard(pool);
    expect(c).toMatchObject({ at_risk: 4, no_row: 1 });
    expect(c.oldest_days).toBeGreaterThanOrEqual(79);
    await sweep.cliffGuard(pool);
    const cl = (await alerts()).filter(a => a.group_key === 'comms_archive_cliff');
    expect(cl.length).toBe(1);
    expect(cl[0].severity).toBe('error');

    await q("UPDATE comms_media SET state = 'none' WHERE part = 'S2'");
    c = await sweep.cliffGuard(pool);
    expect(c.at_risk).toBe(3);
    await q("DELETE FROM comms_media WHERE part IN ('k5', 'k6')");
    await q("DELETE FROM phone_event_log WHERE id IN (?, ?)", [goneC, failC]);
    c = await sweep.cliffGuard(pool);
    expect(c.at_risk).toBe(1);

    // the guard also runs with the kill switch off
    await q("TRUNCATE TABLE system_alerts");
    await q("UPDATE app_settings SET `value` = '0' WHERE `key` = 'comms_archive_enabled'");
    const out = await run();
    expect(out.cliff.at_risk).toBe(1);
    expect((await alerts()).filter(a => a.group_key === 'comms_archive_cliff').length).toBe(1);
  });
});
