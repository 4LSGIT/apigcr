/**
 * REAL-ENGINE suite for comms archive S2 (transcription) on MySQL with the
 * production schema and sql_mode:
 *   F   the full path — discover, the signing proof, submit (1-hour signed
 *       URL the vendor really fetches), poll, store (stt_raw child + object,
 *       signature stripped), the transcript row, duration backfill, vendor
 *       delete; restricted inherited;
 *   G   the gates — mode off / sample / on, comms_no_transcribe, short (calls
 *       only; not voicemails, not sample), over_cap + release, the monthly
 *       cap (warning → error after 24 h), config;
 *   V   sample mode — comms_eval_items only, both Quo-stereo variants,
 *       variantSegments;
 *   E   vendor errors — no_auth (pre-flight + 401), 429, job error → retry →
 *       failed, 404 → resubmit, drift (never "done"), the signing proof
 *       refusing a tampered URL, owed deletes;
 *   P   purge as a FENCE at every point of a completion, and in flight;
 *   A   crash-adopt of a stored object (same bytes) vs anomaly (different).
 *
 * Real modules: the sweep, the vendor module, lib/credentialInjection (the
 * credential row is in the DB), commsArchiveAdmin.purge, the migration
 * script. Stand-ins only at the boundaries: GCS bytes + its signed-URL HTTP
 * side (tests/helpers/fakeGcs.js) and AssemblyAI behind global fetch.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s2_test npx jest tests/commsTranscribe.mysql.test.js --runInBand
 */

'use strict';

const fs = require('fs');
const path = require('path');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'system_alerts', 'alert_state', 'app_settings', 'scheduled_jobs', 'credentials'];
const FX = path.join(__dirname, 'fixtures', 'comms_s2_audio');
const META = JSON.parse(fs.readFileSync(path.join(FX, 'meta.json'), 'utf8'));
const headOf = (f) => fs.readFileSync(path.join(FX, `${f}.head`));
const daysAgo = (n) => new Date(Date.now() - n * 86400_000);

maybe('comms archive S2 transcription on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const sweep   = require('../services/commsTranscribeSweep');
  const svc     = require('../services/commsTranscribeService');
  const admin   = require('../services/commsArchiveAdmin');
  const migrate = require('../scripts/commsTranscribeS2Migrate');
  const ORIG = { ...sweep.limits };
  const realFetch = global.fetch;

  let pool, gcs, aai;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tr = async (mediaId) => (await q('SELECT * FROM comms_transcripts WHERE media_id = ?', [mediaId]))[0];
  const jobs = (mediaId) => q('SELECT * FROM comms_stt_jobs WHERE media_id = ? ORDER BY id', [mediaId]);
  const kids = (mediaId) => q("SELECT * FROM comms_media WHERE source_table = 'comms_media' AND source_id = ? ORDER BY part", [mediaId]);
  const alerts = () => q('SELECT group_key, severity, title, message FROM system_alerts ORDER BY id');
  const set = (k, v) => q('UPDATE app_settings SET `value` = ? WHERE `key` = ?', [v, k]);
  const due = () => q("UPDATE comms_transcripts SET next_attempt_at = NULL WHERE state IN ('pending', 'transcribing')");
  const run = (db = pool) => sweep.runTranscribeSweep(db, { http: (u) => gcs.signedHttp(u) });

  // ── a fake AssemblyAI behind global fetch ─────────────────────────────────
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  function makeAai() {
    const f = { jobs: new Map(), calls: [], n: 0, fail: {}, deleted: [] };
    f.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.host !== 'api.assemblyai.com') throw new Error(`unexpected host ${u.host}`);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      f.calls.push({ method, path: u.pathname, auth: init.headers && init.headers.Authorization, body });
      const forced = f.fail[method];
      if (forced) {
        const r = typeof forced === 'function' ? await forced(u, body) : forced;
        if (r && r.raw != null) return new Response(r.raw, { status: r.status });
        if (r) return json(r.status, r.body || { error: 'x' }, r.headers || {});
      }
      if (method === 'POST' && u.pathname === '/v2/transcript') {
        const id = await f.accept(body);
        if (f.acceptThenDrop) throw new TypeError('fetch failed: socket hang up');   // accepted, answer lost
        return json(200, { id, status: 'queued', audio_url: body.audio_url });
      }
      if (method === 'GET' && u.pathname === '/v2/transcript') {
        const day = u.searchParams.get('created_on');
        const list = [...f.jobs.values()].filter(j => j.createdOn === day).reverse()
          .map(j => ({ id: j.id, resource_url: `https://api.assemblyai.com/v2/transcript/${j.id}`, status: j.status, created: j.created, completed: null, audio_url: j.body.audio_url, error: null }));
        f.listed = (f.listed || 0) + 1;
        return json(200, { transcripts: list, page_details: { limit: 200, result_count: list.length, current_url: url, prev_url: null, next_url: null } });
      }
      const m = u.pathname.match(/^\/v2\/transcript\/([A-Za-z0-9-]+)$/);
      const j = m && f.jobs.get(m[1]);
      if (m && method === 'GET') {
        if (!j || j.deleted) return json(404, { error: 'Transcript not found' });
        return json(200, j.result || { id: j.id, status: j.status, audio_url: j.body.audio_url, error: j.error });
      }
      if (m && method === 'DELETE') {
        if (!j) return json(404, { error: 'not found' });
        j.deleted = true; f.deleted.push(j.id);
        return json(200, { id: j.id, status: j.status, text: 'Deleted by user.' });
      }
      return json(500, { error: 'unrouted' });
    };
    /** Create a job (the vendor fetching OUR signed URL as it does). */
    f.accept = async (body) => {
      const id = `tx-${++f.n}`;
      const now = new Date();
      f.jobs.set(id, { id, status: 'queued', body, created: now.toISOString(), createdOn: now.toISOString().slice(0, 10) });
      const got = await gcs.signedHttp(body.audio_url);
      Object.assign(f.jobs.get(id), { fetched: got.status, fetchedBytes: got.buf ? got.buf.length : 0 });
      return id;
    };
    /** Finish a job the way AssemblyAI does (diarized or multichannel by what was asked). */
    f.complete = (id, extra = {}) => {
      const j = f.jobs.get(id);
      const mc = !!j.body.multichannel;
      j.status = 'completed';
      j.result = {
        id, status: 'completed', audio_url: j.body.audio_url, language_code: 'en_us', audio_duration: 20,
        text: 'Hello, law office. Yes, about my case.',
        multichannel: mc || null, ...(mc ? { audio_channels: 2 } : {}),
        utterances: mc
          ? [{ speaker: 'A', channel: '1', start: 0, end: 1500, text: 'Hello, law office.' }, { speaker: 'A', channel: '2', start: 1600, end: 3000, text: 'Yes, about my case.' }]
          : [{ speaker: 'A', start: 0, end: 1500, text: 'Hello, law office.', words: [] }, { speaker: 'B', start: 1600, end: 3000, text: 'Yes, about my case.', words: [] }],
        ...extra,
      };
    };
    f.completeAll = (extra) => { for (const id of f.jobs.keys()) if (f.jobs.get(id).status !== 'completed') f.complete(id, extra); };
    f.error = (id, msg) => { const j = f.jobs.get(id); j.status = 'error'; j.error = msg; j.result = { id, status: 'error', error: msg, audio_url: j.body.audio_url }; };
    f.posts = () => f.calls.filter(c => c.method === 'POST');
    return f;
  }

  // ── fixtures ───────────────────────────────────────────────────────────────
  let nextSrc = 70000;
  async function media({ kind = 'call_recording', provider = 'ringcentral', fixture = 'rc_cbr_mono_32k.mp3', party = '2489148845',
    restricted = 0, sourceTable = 'phone_event_log', bytes, capturedAt = daysAgo(1), state = 'archived', mime } = {}) {
    const src = ++nextSrc;
    const ext = fixture.endsWith('.wav') ? 'wav' : 'mp3';
    const type = mime || (ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
    const name = `phone/${kind === 'voicemail' ? 'vm' : 'rec'}/${capturedAt.getUTCFullYear()}/${String(capturedAt.getUTCMonth() + 1).padStart(2, '0')}/${src}-p${src}.${ext}`;
    gcs.objects.set(name, { buf: headOf(fixture), contentType: type, generation: '1' });
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, object_name, mime, bytes,
                                sha256, captured_at, state, restricted, archived_at)
       VALUES ('phone', ?, ?, ?, ?, ?, 4, ?, ?, ?, ?, REPEAT('a', 64), ?, ?, ?, UTC_TIMESTAMP())`,
      [kind, sourceTable, src, `p${src}`, provider, party, name, type, bytes ?? META[fixture].bytes, capturedAt, state, restricted]);
    return r.insertId;
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    for (const t of ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe', 'comms_eval_items']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await schema.build(pool, TABLES);
    for (const s of schema.migrationStatements('2026-10-14_comms_media.sql')) await pool.query(s);
    const conn = await pool.getConnection();
    try {
      const r = await migrate.run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(`migration: ${r.line}`);
    } finally { conn.release(); }
    for (const s of schema.migrationStatements('2026-10-15_comms_s2c_max_speakers.sql')) await pool.query(s);   // S2c-1's setting row
    // S0's sample table, as committed on comms-eval (bbefcc0), ref/migrations/2026-10-14_comms_eval.sql §1.
    await pool.query(`CREATE TABLE IF NOT EXISTS comms_eval_items (
      media_id BIGINT UNSIGNED NOT NULL, stratum VARCHAR(4) NOT NULL, seed VARCHAR(32) NOT NULL,
      audio_s INT UNSIGNED NULL, added_by TINYINT NOT NULL, added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (media_id)) ENGINE=InnoDB`);
    await pool.query(`INSERT INTO credentials (id, name, type, config, allowed_urls)
      VALUES (14, 'Assembly AI', 'api_key', '{"header": "Authorization", "key": "aai_test_key"}', '["https://api.assemblyai.com/*"]')`);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    archive._test.setStorage(null);
    Object.assign(sweep.limits, ORIG);
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    Object.assign(sweep.limits, ORIG);
    for (const t of ['comms_transcripts', 'comms_stt_jobs', 'comms_media', 'comms_no_transcribe', 'comms_eval_items', 'system_alerts', 'alert_state']) {
      await pool.query(`DELETE FROM ${t}`);
    }
    for (const [k, v] of [['comms_transcribe_mode', 'on'], ['comms_stt_credential_id', '14'], ['comms_min_transcribe_s', '15'],
      ['comms_stt_max_min_per_call', '300'], ['comms_ai_monthly_cap_cents', '7500'], ['comms_stt_quo_stereo', 'diarize'],
      ['comms_stt_keyterms', '[]'], ['comms_stt_language_detection', '1'], ['comms_stt_max_speakers', '2']]) await set(k, v);
    await pool.query(`UPDATE credentials SET allowed_urls = '["https://api.assemblyai.com/*"]' WHERE id = 14`);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    gcs = fakeStorage();
    gcs.objects.set(sweep.PROBE_OBJECT, { buf: Buffer.from(sweep.PROBE_TEXT), contentType: 'text/plain', generation: '1' });
    archive._test.setStorage(gcs.storage);
    aai = makeAai();
    global.fetch = aai.fetch;
  });

  // ═══ F ════════════════════════════════════════════════════════════════════
  test('F1 full path: proof → submit (the vendor fetches a 1-hour signed URL) → poll → store → delete', async () => {
    const id = await media();
    const mms = await media({ kind: 'mms_file', mime: 'audio/mpeg' });     // MMS audio is never transcribed
    const t1 = await run();
    await admin.setRestricted(pool, id, true);                            // restricted while in flight: stored, hidden by the JOIN
    expect(t1).toMatchObject({ mode: 'on', discovered: 1, submitted: 1, stop: null });
    // signing proof: probe signed + GET'd, a tampered copy refused, BEFORE the audio URL was minted
    const probeSigns = gcs.calls.sign.filter(s => s.name === sweep.PROBE_OBJECT);
    expect(probeSigns.length).toBe(1);
    expect(gcs.calls.sign.findIndex(s => s.name === sweep.PROBE_OBJECT)).toBeLessThan(gcs.calls.sign.findIndex(s => s.name !== sweep.PROBE_OBJECT));
    const audioSign = gcs.calls.sign.find(s => s.name !== sweep.PROBE_OBJECT);
    expect(audioSign.expires - Date.now()).toBeGreaterThan(59 * 60e3);
    expect(audioSign.expires - Date.now()).toBeLessThanOrEqual(60 * 60e3 + 1000);
    const [post] = aai.posts();
    expect(post.auth).toBe('aai_test_key');
    expect(post.body).toEqual({ audio_url: audioSign.url, speech_models: ['universal-3-5-pro'], language_detection: true, speaker_labels: true,
      speaker_options: { max_speakers_expected: 2 } });
    expect(aai.jobs.get('tx-1')).toMatchObject({ fetched: 200, fetchedBytes: 8192 });
    let t = await tr(id);
    expect(t).toMatchObject({ state: 'transcribing', stt_job_ref: 'tx-1', stt_model: 'universal-3-5-pro+diarize+max2', attempts: 0, est_audio_s: 20, phone_event_id: expect.any(Number) });
    expect(Number(t.stt_cost_cents)).toBeCloseTo(20.088 / 3600 * 23, 4);     // the estimate, from the ledger
    expect(await jobs(id)).toEqual([expect.objectContaining({ role: 'main', variant: 'diarize', job_ref: 'tx-1', state: 'submitted', cost_cents: null, deleted_at: null })]);
    expect((await q('SELECT audio_channels FROM comms_media WHERE id = ?', [id]))[0].audio_channels).toBe(1);

    await due();
    expect(await run()).toMatchObject({ polled: 1, completed: 0 });          // still queued
    t = await tr(id);
    expect(t).toMatchObject({ state: 'transcribing', attempts: 0 });
    expect(t.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    aai.complete('tx-1');
    await due();
    expect(await run()).toMatchObject({ completed: 1, vendor_deleted: 1 });
    t = await tr(id);
    expect(t).toMatchObject({ state: 'transcribed', stt_vendor: 'assemblyai', language: 'en_us', speakers: 2, attempts: 0, last_error: null });
    expect(t.segments).toEqual([{ s: 'A', a: 0, b: 1.5, t: 'Hello, law office.' }, { s: 'B', a: 1.6, b: 3, t: 'Yes, about my case.' }]);
    expect(t.full_text).toBe('Hello, law office.\nYes, about my case.');
    expect(Number(t.stt_cost_cents)).toBeCloseTo(20 / 3600 * 23, 4);         // billed (vendor audio_duration)
    expect(t.transcribed_at).toBeTruthy();
    expect(await jobs(id)).toEqual([expect.objectContaining({ state: 'completed', deleted_at: expect.any(Date) })]);
    expect(aai.deleted).toEqual(['tx-1']);
    expect(await tr(mms)).toBeUndefined();
    const [m] = await q('SELECT duration_s FROM comms_media WHERE id = ?', [id]);
    expect(m.duration_s).toBe(20);
    // the stt_raw child: archived, restricted INHERITED, object = the vendor JSON minus our signature
    const [k] = await kids(id);
    expect(k).toMatchObject({ kind: 'stt_raw', part: 'assemblyai', state: 'archived', restricted: 1, mime: 'application/json', provider: 'ringcentral', channel_id: 4 });
    const stored = gcs.objects.get(k.object_name).buf.toString();
    expect(k.object_name).toMatch(new RegExp(`^phone/stt/\\d{4}/\\d{2}/${id}\\.assemblyai\\.json$`));
    expect(stored).not.toMatch(/X-Goog-Signature|X-Goog-Expires/);
    expect(JSON.parse(stored)).toMatchObject({ id: 'tx-1', status: 'completed', audio_url: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\/fake\/phone\/rec\//) });
    expect(require('crypto').createHash('sha256').update(gcs.objects.get(k.object_name).buf).digest('hex')).toBe(k.sha256);
    // unrestrict cascades to the child (S1's setRestricted)
    await admin.setRestricted(pool, id, false);
    expect((await kids(id))[0].restricted).toBe(0);
    // a later tick does nothing more
    await due();
    expect(await run()).toMatchObject({ discovered: 0, submitted: 0, polled: 0, vendor_deleted: 0 });
  });

  test('F2 an RC voicemail (no call row) and a WAV: phone_event_id NULL, the header measures it', async () => {
    const id = await media({ kind: 'voicemail', sourceTable: 'rc_message', fixture: 'vm.wav' });
    await run();
    expect(await tr(id)).toMatchObject({ state: 'transcribing', phone_event_id: null, est_audio_s: 12 });
  });

  // ═══ G ════════════════════════════════════════════════════════════════════
  test('G1 mode off (and garbage = off, warned): nothing discovered, nothing sent', async () => {
    await media();
    await set('comms_transcribe_mode', 'off');
    expect(await run()).toMatchObject({ mode: 'off', discovered: 0, submitted: 0 });
    await set('comms_transcribe_mode', 'yes please');
    expect(await run()).toMatchObject({ mode: 'off', discovered: 0 });
    expect(aai.calls.length).toBe(0);
    expect(await q('SELECT COUNT(*) AS n FROM comms_transcripts')).toEqual([{ n: 0 }]);
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_config')).toMatchObject({ severity: 'warning' });
  });

  test('G2 config problems stop the tick before any vendor call (error alert)', async () => {
    await media();
    await set('comms_stt_credential_id', 'fourteen');
    expect(await run()).toMatchObject({ stop: 'config', submitted: 0 });
    await set('comms_stt_credential_id', '14');
    await set('comms_stt_max_min_per_call', '0');
    expect(await run()).toMatchObject({ stop: 'config' });
    expect(aai.calls.length).toBe(0);
    expect((await alerts()).filter(a => a.group_key === 'comms_transcribe_config').map(a => a.severity)).toContain('error');
  });

  test('G3 short: a 1 s CALL is skipped (mode on); a 1 s VOICEMAIL is not; the estimate is recorded', async () => {
    const call = await media({ fixture: 'tiny_1s.mp3' });
    const vm = await media({ kind: 'voicemail', fixture: 'tiny_1s.mp3' });
    const r = await run();
    expect(r).toMatchObject({ skipped_short: 1, submitted: 1 });
    expect(await tr(call)).toMatchObject({ state: 'skipped', skip_reason: 'short', est_audio_s: 1, attempts: 0 });
    expect(await tr(vm)).toMatchObject({ state: 'transcribing' });
  });

  test('G4 comms_no_transcribe: matched on the last 10 digits of party; nothing leaves', async () => {
    const id = await media({ party: '+1 (248) 914-8845' });
    await q("INSERT INTO comms_no_transcribe (phone, note, created_by) VALUES ('2489148845', 'personal', 1)");
    expect(await run()).toMatchObject({ skipped_no_transcribe: 1, submitted: 0 });
    expect(await tr(id)).toMatchObject({ state: 'skipped', skip_reason: 'no_transcribe' });
    expect(aai.calls.length).toBe(0);
    expect(gcs.calls.sign.length).toBe(0);
  });

  test('G5 over_cap → skipped; releaseCap → submitted next tick (and only an over_cap skip can be released)', async () => {
    await set('comms_stt_max_min_per_call', '1');
    const id = await media({ bytes: 80352 * 4 });     // ~80 s of 32 kbps audio
    expect(await run()).toMatchObject({ skipped_over_cap: 1, submitted: 0 });
    const t = await tr(id);
    expect(t).toMatchObject({ state: 'skipped', skip_reason: 'over_cap', est_audio_s: 80 });
    await expect(sweep.releaseCap(pool, t.id, {})).rejects.toThrow(/userId/);
    expect(await sweep.releaseCap(pool, t.id, { userId: 3 })).toBe(1);
    expect(await sweep.releaseCap(pool, t.id, { userId: 3 })).toBe(0);
    expect(await run()).toMatchObject({ submitted: 1 });
    expect(await tr(id)).toMatchObject({ state: 'transcribing', cap_released_by: 3 });
  });

  test('G6 monthly cap: nothing submitted past it (uncharged), polls go on, warning → error after 24 h', async () => {
    const a = await media();
    await run();                                         // a submitted: its reservation counts
    aai.complete('tx-1');
    await set('comms_ai_monthly_cap_cents', '0');
    const b = await media();
    await due();
    const r = await run();
    expect(r).toMatchObject({ stop: 'cap', completed: 1, submitted: 0 });
    expect(await tr(a)).toMatchObject({ state: 'transcribed' });
    expect(await tr(b)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(aai.posts().length).toBe(1);
    let cap = (await alerts()).filter(x => x.group_key === 'comms_transcribe_cap');
    expect(cap.map(x => x.severity)).toEqual(['warning']);
    // MTD counts what was transcribed this month
    expect(await sweep.monthToDateCents(pool)).toBeCloseTo(20 / 3600 * 23, 4);      // the ledger: a's billed job
    // held for > 24 h → error
    await q("UPDATE system_alerts SET created_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR, dedup_key = 'old' WHERE group_key = 'comms_transcribe_cap'");
    await run();
    cap = (await alerts()).filter(x => x.group_key === 'comms_transcribe_cap');
    expect(cap.map(x => x.severity)).toContain('error');
    // a missing cap = 0 = nothing (and warned)
    await q("DELETE FROM app_settings WHERE `key` = 'comms_ai_monthly_cap_cents'");
    expect(await run()).toMatchObject({ stop: 'cap', submitted: 0 });
    await q(`INSERT INTO app_settings (\`key\`, \`value\`) VALUES ('comms_ai_monthly_cap_cents', '7500')`);
  });

  test('G7 the cap counts in-flight reservations: two big calls, room for one', async () => {
    await set('comms_ai_monthly_cap_cents', '5');      // 5¢ ≈ 13 min of audio at 23¢/h
    await media({ bytes: 80352 * 30 });                 // ~10 min each ≈ 3.8¢
    await media({ bytes: 80352 * 30 });
    expect(await run()).toMatchObject({ submitted: 1, stop: 'cap' });
  });

  // ═══ V ════════════════════════════════════════════════════════════════════
  test('V1 sample: only comms_eval_items; short gate bypassed; stereo runs BOTH variants; variantSegments', async () => {
    await set('comms_transcribe_mode', 'sample');
    const quo = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    const tiny = await media({ fixture: 'tiny_1s.mp3' });
    const other = await media();
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S6', 'seed', 1), (?, 'S1', 'seed', 1)", [quo, tiny]);
    const r = await run();
    expect(r).toMatchObject({ discovered: 2, submitted: 2, skipped_short: 0 });
    expect(await tr(other)).toBeUndefined();
    const posts = aai.posts();
    expect(posts.length).toBe(3);                       // quo ×2 + tiny ×1
    expect(posts.filter(p => p.body.multichannel).length).toBe(1);
    const tq = await tr(quo);
    expect(tq).toMatchObject({ state: 'transcribing', stt_model: 'universal-3-5-pro+diarize+max2', alt_job_ref: expect.stringMatching(/^tx-/) });
    expect(Number(tq.stt_cost_cents)).toBeCloseTo(37.068 / 3600 * (23 + 42), 3);   // both variants reserved (exact Xing-less CBR estimate)
    // the variant still processing holds the row
    aai.complete(tq.stt_job_ref);
    await due();
    expect(await run()).toMatchObject({ completed: 0 });   // the variant (and the mono call) still queued
    expect(await tr(quo)).toMatchObject({ state: 'transcribing' });
    aai.completeAll();
    await due();
    await run();
    const done = await tr(quo);
    expect(done).toMatchObject({ state: 'transcribed', speakers: 2 });
    expect(Number(done.stt_cost_cents)).toBeCloseTo(20 / 3600 * (23 + 42), 4);    // both variants billed
    expect(done.segments[0].s).toBe('A');
    const ks = await kids(quo);
    expect(ks.map(k => k.part)).toEqual(['assemblyai', 'assemblyai-mc']);
    expect(await svc.variantSegments(pool, quo)).toEqual([{ s: 'ch1', a: 0, b: 1.5, t: 'Hello, law office.' }, { s: 'ch2', a: 1.6, b: 3, t: 'Yes, about my case.' }]);
    expect(await svc.variantSegments(pool, tiny)).toBeNull();      // mono: no variant
    expect(aai.deleted.sort()).toEqual([...aai.jobs.keys()].sort());
    // mode on: the configured variant only
    await set('comms_transcribe_mode', 'on');
    const quo2 = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    const before = aai.posts().length;
    await run();
    expect(aai.posts().length - before).toBeGreaterThanOrEqual(1);
    expect((await tr(quo2)).alt_job_ref).toBeNull();
    expect(aai.posts().slice(before).filter(p => p.body.multichannel).length).toBe(0);
  });

  test('V1b S2c-1: the speaker cap rides diarize jobs only (mono + the sample variant), tags stt_model; multichannel never', async () => {
    await set('comms_transcribe_mode', 'sample');
    const quo = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    const mono = await media();
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S6', 'seed', 1), (?, 'S1', 'seed', 1)", [quo, mono]);
    await run();
    const posts = aai.posts();
    expect(posts.length).toBe(3);                       // quo diarize + quo multichannel (sample) + mono diarize
    const dia = posts.filter(p => p.body.speaker_labels), mc = posts.filter(p => p.body.multichannel);
    expect(dia.length).toBe(2);
    for (const p of dia) expect(p.body.speaker_options).toEqual({ max_speakers_expected: 2 });
    expect(mc.length).toBe(1);
    expect(mc[0].body.speaker_options).toBeUndefined();
    expect(mc[0].body.speaker_labels).toBeUndefined();
    expect((await tr(mono)).stt_model).toBe('universal-3-5-pro+diarize+max2');
    // the knob flipped: the multichannel MAIN job carries no cap and no tag
    await set('comms_transcribe_mode', 'on');
    await set('comms_stt_quo_stereo', 'multichannel');
    const quo2 = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    const before = aai.posts().length;
    await run();
    const p2 = aai.posts().slice(before);
    expect(p2.map(p => [!!p.body.multichannel, p.body.speaker_options])).toEqual([[true, undefined]]);
    expect((await tr(quo2)).stt_model).toBe('universal-3-5-pro+multichannel');
  });

  test('V1c S2c-1: comms_stt_max_speakers 0 = no cap; missing or garbage = no submit, error alert', async () => {
    await set('comms_stt_max_speakers', '0');
    const a = await media();
    await run();
    expect(aai.posts()[0].body).toMatchObject({ speaker_labels: true });
    expect(aai.posts()[0].body.speaker_options).toBeUndefined();
    expect((await tr(a)).stt_model).toBe('universal-3-5-pro+diarize');
    const b = await media();
    for (const bad of ['two', '11', '2.5', '-1', '']) {
      await set('comms_stt_max_speakers', bad);
      expect(await run()).toMatchObject({ stop: 'config', submitted: 0 });
    }
    await q("DELETE FROM app_settings WHERE `key` = 'comms_stt_max_speakers'");
    expect(await run()).toMatchObject({ stop: 'config', submitted: 0 });
    expect(aai.posts().length).toBe(1);
    expect(await tr(b)).toBeUndefined();               // the tick stopped before discovery
    const al = (await alerts()).filter(x => x.group_key === 'comms_transcribe_config');
    expect(al.map(x => x.severity)).toContain('error');
    expect(al.map(x => x.message).join('\n')).toMatch(/comms_stt_max_speakers/);
    for (const s of schema.migrationStatements('2026-10-15_comms_s2c_max_speakers.sql')) await pool.query(s);   // the seed again: '2'
    expect(await run()).toMatchObject({ submitted: 1 });
    expect(aai.posts()[1].body.speaker_options).toEqual({ max_speakers_expected: 2 });
    await set('comms_stt_max_speakers', '10');
    await media();
    await run();
    expect(aai.posts()[2].body.speaker_options).toEqual({ max_speakers_expected: 10 });
  });

  test('V2 the stereo knob flips the canonical variant; variantSegments follows it', async () => {
    await set('comms_transcribe_mode', 'sample');
    await set('comms_stt_quo_stereo', 'multichannel');
    const quo = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S6', 'seed', 1)", [quo]);
    await run();
    aai.completeAll();
    await due();
    await run();
    const t = await tr(quo);
    expect(t).toMatchObject({ state: 'transcribed', stt_model: 'universal-3-5-pro+multichannel' });
    expect(t.segments[0].s).toBe('ch1');
    expect((await svc.variantSegments(pool, quo))[0].s).toBe('A');
  });

  test('V4 switching on → sample: a pending row outside the sample is never submitted', async () => {
    await set('comms_ai_monthly_cap_cents', '0');
    const outside = await media();
    await run();                                         // discovered, held by the cap
    expect(await tr(outside)).toMatchObject({ state: 'pending' });
    await set('comms_ai_monthly_cap_cents', '7500');
    await set('comms_transcribe_mode', 'sample');
    await due();
    expect(await run()).toMatchObject({ submitted: 0 });
    expect(aai.posts().length).toBe(0);
  });

  test('V3 sample mode without the sample table: config error, nothing sent', async () => {
    await set('comms_transcribe_mode', 'sample');
    await media();
    await pool.query('RENAME TABLE comms_eval_items TO comms_eval_items_x');
    try {
      expect(await run()).toMatchObject({ stop: 'config', submitted: 0 });
    } finally {
      await pool.query('RENAME TABLE comms_eval_items_x TO comms_eval_items');
    }
    expect(aai.calls.length).toBe(0);
    expect((await alerts()).find(a => /no sample list/.test(a.title))).toBeTruthy();
  });

  // ═══ E ════════════════════════════════════════════════════════════════════
  test('E1 credential outside allowed_urls: pre-flight no_auth, nothing claimed or sent', async () => {
    const id = await media();
    await pool.query(`UPDATE credentials SET allowed_urls = '["https://api.eu.assemblyai.com/*"]' WHERE id = 14`);
    expect(await run()).toMatchObject({ stop: 'no_auth', submitted: 0 });
    expect(aai.calls.length).toBe(0);
    expect(await tr(id)).toBeUndefined();
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_no_auth:14')).toMatchObject({ severity: 'warning' });
  });

  test('E2 a 401 on submit refunds, stops, alerts with the vendor text; a 429 refunds and stops', async () => {
    const id = await media();
    await media();
    aai.fail.POST = { status: 401, body: { error: 'Authentication error, API token missing/invalid.' } };
    const r = await run();
    expect(r).toMatchObject({ stop: 'no_auth', submitted: 0, auth_error: { status: 401 } });
    expect(aai.posts().length).toBe(1);
    expect(await tr(id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_no_auth:14').message).toMatch(/API token missing/);
    aai.fail.POST = { status: 429, body: { error: 'Too Many Requests.' }, headers: { 'retry-after': '30' } };
    await due();
    expect(await run()).toMatchObject({ stop: 'rate_limited', retry_after_s: 30, submitted: 0 });
    expect((await q("SELECT MAX(attempts) AS a FROM comms_transcripts"))[0].a).toBe(0);
  });

  test('E3 a vendor 5xx is charged with backoff; the job-error path retries with a fresh URL, then fails (alerted)', async () => {
    const id = await media();
    aai.fail.POST = { status: 500 };                                      // a definite refusal (502/503/504 = maybe accepted: R2-N3)
    expect(await run()).toMatchObject({ retried: 1, submitted: 0 });
    expect(await tr(id)).toMatchObject({ state: 'pending', attempts: 1 });
    delete aai.fail.POST;
    for (let i = 1; i <= sweep.limits.maxAttempts; i++) {
      await due();
      await run();
      const t = await tr(id);
      if (t.state !== 'transcribing') break;
      aai.error(t.stt_job_ref, 'Download error, unable to download the audio (403)');
      await due();
      const r = await run();
      expect(r.download_errors).toBe(1);
    }
    const t = await tr(id);
    expect(t.state).toBe('failed');
    const js = await jobs(id);
    expect(js.map(j => j.state)).toEqual(['refused', 'error', 'error', 'error']);   // every POST is in the ledger…
    expect(Number(t.stt_cost_cents)).toBeCloseTo(3 * 20.088 / 3600 * 23, 3); // …and counted (the refused one at 0)
    expect(aai.deleted.sort()).toEqual(js.filter(j => j.job_ref).map(j => j.job_ref).sort());   // each errored job deleted at the vendor
    expect(t.last_error).toMatch(/vendor error \(download\)/);
    expect(gcs.calls.sign.filter(s => s.name !== sweep.PROBE_OBJECT).length).toBeGreaterThanOrEqual(2);   // a fresh URL per try
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_failed')).toBeTruthy();
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_storage')).toBeTruthy();       // downloads failing, none completing
  });

  test('E4 the vendor lost the job (404 on poll) → resubmitted', async () => {
    const id = await media();
    await run();
    aai.jobs.get('tx-1').deleted = true;
    await due();
    expect(await run()).toMatchObject({ retried: 1 });
    expect(await tr(id)).toMatchObject({ state: 'pending', stt_job_ref: null, attempts: 1 });
    await due();
    await run();
    expect(await tr(id)).toMatchObject({ state: 'transcribing', stt_job_ref: 'tx-2' });
  });

  test('E5 drift is parked uncharged and alerted — never stored as done', async () => {
    const id = await media();
    await run();
    aai.jobs.get('tx-1').result = { id: 'tx-1', status: 'transcoding' };
    await due();
    expect(await run()).toMatchObject({ drift: 1, completed: 0 });
    expect(await tr(id)).toMatchObject({ state: 'transcribing', attempts: 0 });
    aai.complete('tx-1', { utterances: [{ start: 0, end: 10, text: 'no speaker' }] });
    await due();
    expect(await run()).toMatchObject({ drift: 1, completed: 0 });
    expect(await tr(id)).toMatchObject({ state: 'transcribing', segments: null });
    expect(await kids(id)).toEqual([]);
    expect([...gcs.objects.keys()].filter(n => n.startsWith('phone/stt/'))).toEqual([]);
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_drift')).toMatchObject({ severity: 'error' });
  });

  test('E6 an unreadable audio header with no nominal rate is drift, not a guess', async () => {
    const id = await media({ provider: 'quo', fixture: 'vm.wav', mime: 'audio/wav' });
    gcs.objects.get((await q('SELECT object_name FROM comms_media WHERE id = ?', [id]))[0].object_name).buf = Buffer.from('<html>oops</html>');
    expect(await run()).toMatchObject({ drift: 1, submitted: 0 });
    expect(await tr(id)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  test('E7 the signing proof: a tampered URL served, or wrong probe bytes → NO audio leaves, nothing charged', async () => {
    const id = await media();
    const realHttp = gcs.signedHttp;
    gcs.signedHttp = async (u) => ({ status: 200, text: sweep.PROBE_TEXT });     // signatures not checked
    expect(await run()).toMatchObject({ stop: 'signing', submitted: 0 });
    expect(aai.calls.length).toBe(0);
    expect(gcs.calls.sign.every(s => s.name === sweep.PROBE_OBJECT)).toBe(true);
    expect(await tr(id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_storage').message).toMatch(/TAMPERED/);
    gcs.signedHttp = realHttp;
    gcs.objects.get(sweep.PROBE_OBJECT).buf = Buffer.from('something else');
    await due();
    expect(await run()).toMatchObject({ stop: 'signing', submitted: 0 });
    gcs.objects.get(sweep.PROBE_OBJECT).buf = Buffer.from(sweep.PROBE_TEXT);
    gcs.fail.sign = { code: 403 };
    await due();
    expect(await run()).toMatchObject({ stop: 'signing', submitted: 0 });
    expect(aai.calls.length).toBe(0);
  });

  test('E8 a failed vendor delete is owed and retried — in every mode, including off', async () => {
    const id = await media();
    await run();
    aai.complete('tx-1');
    aai.fail.DELETE = { status: 500 };
    await due();
    expect(await run()).toMatchObject({ completed: 1, vendor_delete_owed: 1 });   // tried once this tick, not twice
    expect((await jobs(id))[0]).toMatchObject({ deleted_at: null, delete_attempts: 1 });
    delete aai.fail.DELETE;
    await set('comms_transcribe_mode', 'off');
    expect(await run()).toMatchObject({ vendor_deleted: 0 });                      // backed off: not due yet
    await q('UPDATE comms_stt_jobs SET delete_after = NULL');
    expect(await run()).toMatchObject({ vendor_deleted: 1 });
    expect((await jobs(id))[0].deleted_at).toBeTruthy();
  });

  test('E9 storage failure on the header read: refund, storage alert, tick stops', async () => {
    const id = await media();
    gcs.fail.read = { code: 503 };
    expect(await run()).toMatchObject({ stop: 'storage', submitted: 0 });
    expect(await tr(id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_storage')).toBeTruthy();
  });

  test('E10 the duration estimate disagreeing with the vendor raises the drift warning', async () => {
    await media();
    await run();
    aai.complete('tx-1', { audio_duration: 60 });
    await due();
    await run();
    const a = (await alerts()).find(x => x.group_key === 'comms_transcribe_duration_drift');
    expect(a).toMatchObject({ severity: 'warning' });
    expect(a.message).toMatch(/estimated 20 s, measured 60 s/);
  });

  test('E11 the tick lock: a second runner returns skipped:locked', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query(`SELECT GET_LOCK(${sweep.LOCK_EXPR}, 0)`);
      expect(await run()).toMatchObject({ skipped: 'locked' });
    } finally {
      await conn.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`);
      conn.release();
    }
  });

  // ═══ P ════════════════════════════════════════════════════════════════════
  test('P1 purge while in flight: text never lands, the vendor job is deleted (inside the purge)', async () => {
    const id = await media();
    await run();
    const r = await admin.purge(pool, id, { userId: 1, reason: 'private' });
    expect(r.parts.transcripts).toEqual({ rows: 1, deleted: 0, vendor: 'deleted', ai_calls: 0 });
    expect(Object.keys(r.parts)[0]).toBe('transcripts');
    aai.jobs.get('tx-1').deleted = false;               // (even if the vendor still answered)
    aai.complete('tx-1');
    await due();
    expect(await run()).toMatchObject({ polled: 0, completed: 0 });
    expect(await tr(id)).toMatchObject({ state: 'purged', segments: null, full_text: null });
    expect(await kids(id)).toEqual([]);
  });

  test('P2 purge with the vendor delete failing: purge succeeds, the delete is owed and the sweep pays it', async () => {
    const id = await media();
    await run();
    aai.fail.DELETE = { status: 500 };
    const r = await admin.purge(pool, id, { userId: 1, reason: 'private' });
    expect(r.parts.transcripts.vendor).toBe('owed');
    delete aai.fail.DELETE;
    expect(await run()).toMatchObject({ vendor_deleted: 1 });
    expect(aai.deleted).toContain('tx-1');
  });

  test('P3 the purge FENCE landing during the store (after the object, before the child row): no child, object removed', async () => {
    const id = await media();
    await run();
    aai.complete('tx-1');
    const orig = archive.putStream;
    // Only the purge's first step (the fence) has run — the archive item is not tombstoned yet,
    // so the transcript row's state is the only thing that can stop the child insert.
    const spy = jest.spyOn(archive, 'putStream').mockImplementation(async (...a) => {
      const res = await orig.apply(archive, a);
      await sweep.purgeTranscript(pool, (await q('SELECT id, captured_at FROM comms_media WHERE id = ?', [id]))[0]);
      return res;
    });
    try {
      await due();
      expect(await run()).toMatchObject({ completed: 0, fenced: 1 });
    } finally { spy.mockRestore(); }
    expect(await tr(id)).toMatchObject({ state: 'purged', segments: null, full_text: null });
    expect(await kids(id)).toEqual([]);
    expect([...gcs.objects.keys()].filter(n => n.startsWith('phone/stt/'))).toEqual([]);
    // the rest of the purge then completes cleanly
    const r = await admin.purge(pool, id, { userId: 1, reason: 'mid-store' });
    expect(r.parts.derived_children).toMatchObject({ rows: 0 });
  });

  test('P4 purge landing between the child row and the transcript update: the child is purged, no text lands', async () => {
    const id = await media();
    await run();
    aai.complete('tx-1');
    let fired = false;
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (!fired && /SET state = 'transcribed'/.test(sql)) { fired = true; await admin.purge(pool, id, { userId: 1, reason: 'race' }); }
        return pool.query(sql, p);
      },
    };
    await due();
    expect(await run(db)).toMatchObject({ completed: 0, fenced: 1 });
    expect(fired).toBe(true);
    expect(await tr(id)).toMatchObject({ state: 'purged', segments: null, full_text: null });
    const [k] = await kids(id);
    expect(k).toMatchObject({ state: 'purged', part: 'assemblyai' });
    expect(gcs.objects.has(k.object_name)).toBe(false);
    expect((await q('SELECT state FROM comms_media WHERE id = ?', [id]))[0].state).toBe('purged');
  });

  test('P5 purge of a transcribed item clears the text, removes the stt_raw child; an MMS purge has no transcript step work', async () => {
    const id = await media();
    await run(); aai.complete('tx-1'); await due(); await run();
    expect((await tr(id)).state).toBe('transcribed');
    const r = await admin.purge(pool, id, { userId: 1, reason: 'done' });
    expect(r.parts.transcripts).toEqual({ rows: 1, deleted: 1, vendor: 'none', ai_calls: 0 });   // the stt object (by listing); vendor copy already gone
    expect(r.parts.derived_children).toMatchObject({ rows: 1, deleted: 1 });
    const after = await tr(id);
    expect(after).toMatchObject({ state: 'purged', segments: null, full_text: null, summary: null, summary_text: null });
    expect(Number(after.stt_cost_cents)).toBeCloseTo(20 / 3600 * 23, 4);          // cost is not content: purge keeps it
    expect(await sweep.monthToDateCents(pool)).toBeCloseTo(20 / 3600 * 23, 4);
    const mms = await media({ kind: 'mms_file', mime: 'image/png' });
    expect((await admin.purge(pool, mms, { userId: 1, reason: 'x' })).parts.transcripts).toEqual({ rows: 0, deleted: 0, vendor: 'none', ai_calls: 0 });
  });

  test('P6 a pending row whose archive item was purged is fenced on claim, never submitted', async () => {
    const id = await media();
    await sweep.runTranscribeSweep(pool, { http: async () => ({ status: 500, text: '' }) });   // discovered; the proof fails
    await q("UPDATE comms_media SET state = 'purged' WHERE id = ?", [id]);
    await due();
    expect(await run()).toMatchObject({ fenced: 1, submitted: 0 });
    expect(await tr(id)).toMatchObject({ state: 'purged' });
  });

  test('P7 a database without comms_transcripts (S2 migration not run): the purge step is a no-op, not a 502', async () => {
    const id = await media();
    await pool.query('RENAME TABLE comms_transcripts TO comms_transcripts_x');
    try {
      expect(await sweep.purgeTranscript(pool, { id, captured_at: new Date() })).toEqual({ rows: 0, deleted: 0, vendor: 'none', ai_calls: 0 });
    } finally {
      await pool.query('RENAME TABLE comms_transcripts_x TO comms_transcripts');
    }
  });

  // ═══ R (the review's fix round) ═══════════════════════════════════════════
  test('R-M1 a POST answered with an unreadable 2xx: ONE post, the vendor work stops, the money and the delete are kept', async () => {
    const a = await media();
    await media();
    aai.fail.POST = async (_u, body) => { const id = await aai.accept(body); return { status: 200, body: { id, status: 'weird' } }; };
    const r = await run();
    expect(r).toMatchObject({ stop: 'post_drift', submitted: 0, drift: 1 });
    expect(aai.posts().length).toBe(1);                                   // not fed the next row
    const [j] = await jobs(a);
    expect(j).toMatchObject({ state: 'drift', job_ref: 'tx-1', role: 'main' });
    expect(await sweep.monthToDateCents(pool)).toBeGreaterThan(0);        // the reservation is kept
    expect(await tr(a)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(aai.calls.filter(c => c.method === 'DELETE').length).toBe(0);  // the tick stopped ALL vendor calls
    // an unparseable 2xx too — and after maxAttempts such jobs the row is failed
    aai.fail.POST = { status: 200, raw: '<html>gateway</html>' };
    for (let i = 0; i < 2; i++) { await due(); await run(); }
    const t = await tr(a);
    expect(t.state).toBe('failed');
    expect((await jobs(a)).map(x => x.state)).toEqual(['drift', 'unknown', 'unknown']);
    expect(Number(t.stt_cost_cents)).toBeCloseTo(3 * 20.088 / 3600 * 23, 3);
    expect(aai.deleted).toEqual(['tx-1']);                                // the owed delete was paid at the next tick's start
  });

  test('R-M1b a returned id we cannot put in a URL: recorded, never sent in a URL, anomaly alert', async () => {
    const a = await media();
    aai.fail.POST = { status: 200, body: { id: '../v2/upload', status: 'queued' } };
    await run();
    expect((await jobs(a))[0]).toMatchObject({ state: 'drift', job_ref: '../v2/upload' });
    delete aai.fail.POST;
    expect(await run()).toMatchObject({ submitted: 0 });                    // the owed-delete pass meets it: no throw
    const [j] = await jobs(a);
    expect(j).toMatchObject({ deleted_at: null, last_error: 'undeletable id' });
    expect(j.delete_after.getTime()).toBeGreaterThan(Date.now() + 23 * 3600e3);
    expect(aai.calls.filter(c => c.method === 'DELETE').length).toBe(0);
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_anomaly').message).toMatch(/cannot (be deleted safely|put in a URL)/);
  });

  test('R-M2 a job the vendor keeps losing: failed after maxAttempts, every job counted', async () => {
    const a = await media();
    for (let i = 0; i < 3; i++) {
      await due(); await run();                                            // submit
      const t = await tr(a);
      aai.jobs.get(t.stt_job_ref).deleted = true;                          // the vendor loses it
      await due(); await run();                                            // poll → 404
    }
    const t = await tr(a);
    expect(t.state).toBe('failed');
    expect((await jobs(a)).map(j => j.state)).toEqual(['lost', 'lost', 'lost']);
    expect(aai.posts().length).toBe(3);
    expect(await sweep.monthToDateCents(pool)).toBeCloseTo(3 * 20.088 / 3600 * 23, 3);
  });

  test('R-S2 a POST that times out after the vendor accepted: found in the vendor list by URL hash, then deleted', async () => {
    const a = await media();
    await media();
    aai.acceptThenDrop = true;
    expect(await run()).toMatchObject({ stop: 'post_timeout', submitted: 0 });
    aai.acceptThenDrop = false;
    expect(aai.posts().length).toBe(1);
    let [j] = await jobs(a);
    expect(j).toMatchObject({ state: 'unknown', job_ref: null, url_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_orphan')).toMatchObject({ severity: 'warning' });
    // nothing stored anywhere carries the signed URL
    expect(JSON.stringify(await q('SELECT * FROM comms_stt_jobs'))).not.toMatch(/X-Goog-Signature/);
    await q('UPDATE comms_stt_jobs SET delete_after = NULL');
    await due();
    const r = await run();
    expect(r.orphans_found).toBe(1);
    [j] = await jobs(a);
    expect(j).toMatchObject({ state: 'orphan', job_ref: 'tx-1', deleted_at: expect.any(Date) });
    expect(aai.deleted).toContain('tx-1');
  });

  test('R-S2b a timed-out POST never found within 24 h: warning, searching stops (TTL backstop)', async () => {
    const a = await media();
    aai.fail.POST = async () => { throw new TypeError('fetch failed'); };   // the vendor never saw it
    await run();
    delete aai.fail.POST;
    // inside the 24 h: not found → searched again later, the hash kept
    await q('UPDATE comms_stt_jobs SET delete_after = NULL');
    expect((await run()).orphan_searched).toBe(1);
    let [k] = await jobs(a);
    expect(k).toMatchObject({ state: 'unknown', url_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(k.delete_after.getTime()).toBeGreaterThan(Date.now() + 20 * 60e3);
    await q('UPDATE comms_stt_jobs SET delete_after = NULL, submitted_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR');
    await q('DELETE FROM system_alerts');
    await due();
    await run();
    const [j] = await jobs(a);
    expect(j).toMatchObject({ state: 'unknown', url_sha256: null, job_ref: null });
    expect((await alerts()).find(x => /never found/.test(x.title))).toBeTruthy();
  });

  test('R-M4 a restricted call is never sent; unrestricted it becomes eligible; restricted mid-flight is stored hidden', async () => {
    const a = await media({ restricted: 1 });
    expect(await run()).toMatchObject({ skipped_restricted: 1, submitted: 0 });
    expect(await tr(a)).toMatchObject({ state: 'skipped', skip_reason: 'restricted', attempts: 0 });
    expect(aai.calls.length).toBe(0);
    expect(gcs.calls.sign.length).toBe(0);
    await admin.setRestricted(pool, a, false);
    expect(await run()).toMatchObject({ unrestricted: 1, submitted: 1 });
    await admin.setRestricted(pool, a, true);                              // restricted while in flight
    aai.complete('tx-1');
    await due();
    expect(await run()).toMatchObject({ completed: 1, vendor_deleted: 1 });
    expect((await kids(a))[0].restricted).toBe(1);
    // sample mode honours it too
    await set('comms_transcribe_mode', 'sample');
    const b = await media({ restricted: 1 });
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S1', 's', 1)", [b]);
    expect(await run()).toMatchObject({ skipped_restricted: 1, submitted: 0 });
  });

  test('R-M5 a vendor error quoting our signed URL never stores or alerts the signature', async () => {
    const a = await media();
    await run();
    const url = aai.jobs.get('tx-1').body.audio_url;
    for (let i = 0; i < 3; i++) {
      const t = await tr(a);
      if (t.state !== 'transcribing') { await due(); await run(); }
      aai.error((await tr(a)).stt_job_ref, `Download error: unable to download ${aai.jobs.get((await tr(a)).stt_job_ref).body.audio_url} (403)`);
      await due(); await run();
    }
    const everything = JSON.stringify([await tr(a), await jobs(a), await alerts()]);
    expect(url).toMatch(/X-Goog-Signature/);
    expect(everything).not.toMatch(/X-Goog-Signature|X-Goog-Expires/);
    expect((await tr(a)).last_error).toMatch(/\?…/);
  });

  test('R-S4 mode off: no new submissions, but a job in flight is polled, stored and deleted', async () => {
    const a = await media();
    await run();
    await set('comms_transcribe_mode', 'off');
    const b = await media();
    aai.complete('tx-1');
    await due();
    expect(await run()).toMatchObject({ mode: 'off', completed: 1, submitted: 0, discovered: 0, vendor_deleted: 1 });
    expect(await tr(a)).toMatchObject({ state: 'transcribed' });
    expect(await tr(b)).toBeUndefined();
    expect(aai.posts().length).toBe(1);
  });

  test('R-S5 a storage failure while storing: refunded, storage alert, tick ends (no throw), completes later', async () => {
    const a = await media();
    await run();
    aai.complete('tx-1');
    gcs.fail.put = { code: 503 };
    await due();
    const r = await run();
    expect(r).toMatchObject({ stop: 'storage', completed: 0 });
    expect(await tr(a)).toMatchObject({ state: 'transcribing', attempts: 0 });
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_storage')).toBeTruthy();
    expect((await jobs(a))[0]).toMatchObject({ state: 'completed', deleted_at: null });   // billed, still needed: not deleted
    delete gcs.fail.put;
    await due();
    expect(await run()).toMatchObject({ completed: 1 });
  });

  test('R-S6 a 4xx the vendor refuses (configuration): one POST, tick stopped, error alert, nothing charged', async () => {
    const a = await media();
    await media();
    aai.fail.POST = { status: 400, body: { error: 'speech_models: unknown model universal-3-5-pro' } };
    expect(await run()).toMatchObject({ stop: 'vendor_refused', submitted: 0 });
    expect(aai.posts().length).toBe(1);
    expect(await tr(a)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(await jobs(a)).toEqual([expect.objectContaining({ state: 'refused', post_status: 400, url_sha256: null })]);
    expect(await sweep.monthToDateCents(pool)).toBe(0);                      // a refused request costs nothing
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_config')).toMatchObject({ severity: 'error' });
  });

  test('R-S8 poll-time 5xx do not make a first job error fatal (separate counters)', async () => {
    const a = await media();
    await run();
    aai.fail.GET = { status: 502 };
    for (let i = 0; i < 4; i++) { await due(); await run(); }
    expect((await tr(a)).attempts).toBeGreaterThanOrEqual(3);
    delete aai.fail.GET;
    aai.error('tx-1', 'Transcoding failed.');
    await due();
    await run();
    expect(await tr(a)).toMatchObject({ state: 'pending' });              // one job error, not failed
  });

  test('R-ALT a sample-variant POST drift: the main job proceeds, and alt failures never count toward the row failing', async () => {
    await set('comms_transcribe_mode', 'sample');
    const quo = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S6', 's', 1)", [quo]);
    let n = 0;
    aai.fail.POST = async (_u, body) => { if (++n === 2) { const id = await aai.accept(body); return { status: 200, body: { id, status: '???' } }; } return null; };
    expect(await run()).toMatchObject({ submitted: 1, stop: 'post_drift', retried: 0, failed: 0 });   // the main row is not moved
    expect(await tr(quo)).toMatchObject({ state: 'transcribing', alt_job_ref: null, stt_job_ref: 'tx-1' });
    expect((await jobs(quo)).map(j => [j.role, j.state])).toEqual([['main', 'submitted'], ['alt', 'drift']]);
    delete aai.fail.POST;
    // two main job errors → still pending (the alt drift does not make it three)
    for (let i = 0; i < 2; i++) {
      aai.error((await tr(quo)).stt_job_ref, 'Transcoding failed.');
      await due(); await run();
      if (i === 0) { await due(); await run(); }                         // resubmit (both variants)
    }
    expect((await tr(quo)).state).toBe('pending');
  });

  // ═══ R2 (the re-review) ═══════════════════════════════════════════════════
  const vendorMod = require('../services/commsTranscribeVendor');
  const sampleQuo = async () => {
    await set('comms_transcribe_mode', 'sample');
    const quo = await media({ provider: 'quo', fixture: 'quo_cbr_js_64k.mp3' });
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S6', 's', 1)", [quo]);
    return quo;
  };

  test('R2-N1 the variant POST never reaches the vendor: no throw, the main job completes and is deleted, the variant resolves', async () => {
    const quo = await sampleQuo();
    aai.fail.POST = async (_u, body) => { if (body.multichannel) throw new TypeError('fetch failed'); return null; };
    expect(await run()).toMatchObject({ submitted: 1, stop: 'post_timeout' });
    delete aai.fail.POST;
    const [m, a] = await jobs(quo);
    expect(m).toMatchObject({ role: 'main', state: 'submitted', job_ref: 'tx-1' });
    expect(a).toMatchObject({ role: 'alt', state: 'unknown', post_status: 0, job_ref: null });
    expect(a.url_sha256).not.toBe(require('crypto').createHash('sha256').update(aai.jobs.get('tx-1').body.audio_url).digest('hex'));
    aai.complete('tx-1');
    for (let i = 0; i < 3; i++) {                                         // three ticks in a row: none throws
      await due(); await q('UPDATE comms_stt_jobs SET delete_after = NULL');
      await expect(run()).resolves.toBeTruthy();
    }
    expect(await tr(quo)).toMatchObject({ state: 'transcribed' });
    expect(aai.deleted).toContain('tx-1');
    expect((await jobs(quo))[1]).toMatchObject({ state: 'unknown', job_ref: null });   // still searched for (not found yet)
  });

  test('R2-N1b even with a SHARED URL hash the search never takes a known job (the old collision), and the tick goes on', async () => {
    const quo = await sampleQuo();
    aai.fail.POST = async (_u, body) => { if (body.multichannel) throw new TypeError('fetch failed'); return null; };
    await run();
    delete aai.fail.POST;
    const mainSha = require('crypto').createHash('sha256').update(aai.jobs.get('tx-1').body.audio_url).digest('hex');
    await q("UPDATE comms_stt_jobs SET url_sha256 = ?, delete_after = NULL WHERE role = 'alt'", [mainSha]);
    aai.complete('tx-1');
    await due();
    await expect(run()).resolves.toMatchObject({ completed: 1 });
    expect((await jobs(quo))[1]).toMatchObject({ state: 'unknown', job_ref: null });   // NOT given the main's id
    await q("UPDATE comms_stt_jobs SET delete_after = NULL, submitted_at = UTC_TIMESTAMP() - INTERVAL 31 MINUTE WHERE role = 'alt'");
    await run();
    const alt = (await jobs(quo))[1];
    expect(alt).toMatchObject({ state: 'unknown', job_ref: null, url_sha256: null });
    expect(alt.last_error).toMatch(/matched only ledger job .* no separate job/);
    expect(aai.deleted).toContain('tx-1');
  });

  test('R2-N1c one orphan search that throws never stops the tick: the owed deletes still run', async () => {
    const a = await media();
    aai.acceptThenDrop = true;
    await run();                                                          // ledger: unknown (tx-1 exists at the vendor)
    aai.acceptThenDrop = false;
    // an owed delete waiting too (an errored job of a's)
    const owed = await aai.accept({ audio_url: 'https://x/y', speaker_labels: true });
    await q(`INSERT INTO comms_stt_jobs (transcript_id, media_id, role, variant, job_ref, state, post_status, est_cents)
             VALUES (?, ?, 'main', 'diarize', ?, 'error', 200, 0)`, [(await tr(a)).id, a, owed]);
    const b = await media();
    const spy = jest.spyOn(vendorMod, 'listTranscripts').mockRejectedValueOnce(new Error('boom'));
    try {
      await due();
      const r = await run();
      expect(r.orphan_errors).toBe(1);
      expect(r.submitted).toBeGreaterThanOrEqual(1);                      // the tick went on to submit
    } finally { spy.mockRestore(); }
    expect(aai.deleted).toContain(owed);                                  // and paid the owed delete
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_drift').message).toMatch(/orphan search .* boom/);
    expect((await jobs(a))[0].delete_after.getTime()).toBeGreaterThan(Date.now());   // re-searched later
    expect(await tr(b)).toMatchObject({ state: 'transcribing' });
  });

  test('R2-N2 write-ahead: the process dies mid-POST after the vendor accepted — the spend and the search survive', async () => {
    const a = await media();
    const spy = jest.spyOn(vendorMod, 'submit').mockImplementationOnce(async (_db, o) => {
      await aai.accept({ audio_url: o.audioUrl, speaker_labels: true });
      throw new Error('process died');
    });
    try { await expect(run()).rejects.toThrow(/process died/); } finally { spy.mockRestore(); }
    const [j] = await jobs(a);
    expect(j).toMatchObject({ state: 'unknown', post_status: null, job_ref: null, url_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await sweep.monthToDateCents(pool)).toBeGreaterThan(0);
    await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    await run();
    expect((await jobs(a))[0]).toMatchObject({ state: 'orphan', job_ref: 'tx-1', deleted_at: expect.any(Date) });
  });

  test('R2-N3 a 504 after the vendor accepted: stays unknown (counted), tick stopped, found and deleted next tick', async () => {
    const a = await media();
    await media();
    aai.fail.POST = async (_u, body) => { await aai.accept(body); return { status: 504, body: { error: 'Gateway Timeout' } }; };
    expect(await run()).toMatchObject({ stop: 'post_timeout', submitted: 0 });
    delete aai.fail.POST;
    expect(aai.posts().length).toBe(1);
    expect((await jobs(a))[0]).toMatchObject({ state: 'unknown', post_status: 504 });
    expect(await sweep.monthToDateCents(pool)).toBeCloseTo(20.088 / 3600 * 23, 3);
    await q('UPDATE comms_stt_jobs SET delete_after = NULL');
    await run();
    expect((await jobs(a))[0]).toMatchObject({ state: 'orphan', job_ref: 'tx-1', deleted_at: expect.any(Date) });
  });

  test('R2-A1 the row is transcribing (main job recorded) BEFORE the variant POST goes out', async () => {
    const quo = await sampleQuo();
    let seen = null;
    aai.fail.POST = async (_u, body) => { if (body.multichannel) seen = await tr(quo); return null; };
    await run();
    expect(seen).toMatchObject({ state: 'transcribing', stt_job_ref: 'tx-1', alt_job_ref: null });
    expect(await tr(quo)).toMatchObject({ state: 'transcribing', stt_job_ref: 'tx-1', alt_job_ref: 'tx-2' });
  });

  test('R2-A2 the breaker: three uncertain POSTs in a row pause submissions for 6 h (error alert), then resume', async () => {
    for (let i = 0; i < 4; i++) await media();
    aai.fail.POST = { status: 200, raw: '<html>?</html>' };
    for (let i = 0; i < 3; i++) { await due(); await run(); }
    delete aai.fail.POST;
    const posts = aai.posts().length;
    await due();
    expect(await run()).toMatchObject({ stop: 'drift_breaker', submitted: 0 });
    expect(aai.posts().length).toBe(posts);
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_breaker')).toMatchObject({ severity: 'error' });
    await q('UPDATE comms_stt_jobs SET submitted_at = UTC_TIMESTAMP() - INTERVAL 7 HOUR');
    await due();
    expect((await run()).submitted).toBeGreaterThan(0);
    // a good POST among the last three keeps it closed: good, drift, drift → still submitting
    for (let i = 0; i < 2; i++) await media();
    aai.fail.POST = { status: 200, raw: '<html>?</html>' };
    for (let i = 0; i < 2; i++) { await due(); await run(); }
    delete aai.fail.POST;
    await media();
    await due();
    expect((await run()).stop).not.toBe('drift_breaker');
  });

  test('R2-DUP the vendor answers a job id the ledger already holds: no throw, no second job, anomaly, tick stopped', async () => {
    const a = await media();
    await run();                                                          // a → tx-1
    const b = await media();
    aai.fail.POST = { status: 200, body: { id: 'tx-1', status: 'queued' } };
    expect(await run()).toMatchObject({ stop: 'post_drift', submitted: 0 });
    delete aai.fail.POST;
    const jb = await jobs(b);
    expect(jb).toEqual([expect.objectContaining({ job_ref: null, state: 'drift', post_status: 200 })]);
    expect(jb[0].last_error).toMatch(/already ledger job/);
    expect((await q("SELECT COUNT(*) AS n FROM comms_stt_jobs WHERE job_ref = 'tx-1'"))[0].n).toBe(1);
    expect(await tr(b)).toMatchObject({ state: 'pending' });
    expect(await tr(a)).toMatchObject({ state: 'transcribing', stt_job_ref: 'tx-1' });
    expect((await alerts()).find(x => x.group_key === 'comms_transcribe_anomaly').message).toMatch(/already holds/);
  });

  test('R-S1 purge deletes every object under the stt prefix — including a crash-orphan with no row', async () => {
    const a = await media();
    const [m] = await q('SELECT captured_at FROM comms_media WHERE id = ?', [a]);
    const prefix = archive.sttPrefix({ capturedAt: m.captured_at, parentId: a });
    gcs.objects.set(`${prefix}assemblyai.json`, { buf: Buffer.from('{"orphan":1}'), contentType: 'application/json', generation: '5' });
    gcs.objects.set(`${prefix}assemblyai-mc.json`, { buf: Buffer.from('{"orphan":2}'), contentType: 'application/json', generation: '6' });
    const other = archive.sttPrefix({ capturedAt: m.captured_at, parentId: Number(`${a}0`) }) + 'assemblyai.json';
    gcs.objects.set(other, { buf: Buffer.from('{}'), contentType: 'application/json', generation: '7' });
    await run();
    const r = await admin.purge(pool, a, { userId: 1, reason: 'x' });
    expect(r.parts.transcripts.deleted).toBe(2);
    expect([...gcs.objects.keys()].filter(n => n.startsWith(prefix))).toEqual([]);
    expect(gcs.objects.has(other)).toBe(true);                             // a neighbour id is not a prefix match
  });

  // ═══ A ════════════════════════════════════════════════════════════════════
  test('A1 a leftover object with the SAME bytes is adopted; with DIFFERENT bytes it is an anomaly', async () => {
    const id = await media();
    await run();
    aai.complete('tx-1');
    const name = archive.sttPrefix({ capturedAt: (await q('SELECT captured_at FROM comms_media WHERE id = ?', [id]))[0].captured_at, parentId: id }) + 'assemblyai.json';
    // same bytes (a crash between the put and the child row)
    const v = require('../services/commsTranscribeVendor');
    const bodyOf = (j) => Buffer.from(JSON.stringify(v.stripSignedUrl(j)));
    gcs.objects.set(name, { buf: bodyOf(aai.jobs.get('tx-1').result), contentType: 'application/json', generation: '9' });
    await due();
    expect(await run()).toMatchObject({ completed: 1 });
    expect((await kids(id))[0]).toMatchObject({ state: 'archived', part: 'assemblyai' });

    const id2 = await media();
    await run();
    aai.complete('tx-2');
    const name2 = archive.sttPrefix({ capturedAt: (await q('SELECT captured_at FROM comms_media WHERE id = ?', [id2]))[0].captured_at, parentId: id2 }) + 'assemblyai.json';
    gcs.objects.set(name2, { buf: Buffer.from('{"other":true}'), contentType: 'application/json', generation: '9' });
    await due();
    expect(await run()).toMatchObject({ completed: 0 });
    expect(await tr(id2)).toMatchObject({ state: 'transcribing', attempts: 0 });
    expect((await tr(id2)).last_error).toMatch(/anomaly/);
    expect(gcs.objects.get(name2).buf.toString()).toBe('{"other":true}');     // never overwritten
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_anomaly')).toBeTruthy();
  });

  test('A2 backlog older than 48 h raises the backlog warning (mode on)', async () => {
    const id = await media();
    await sweep.runTranscribeSweep(pool, { http: async () => ({ status: 500, text: '' }) });
    await q("UPDATE comms_transcripts SET created_at = UTC_TIMESTAMP() - INTERVAL 49 HOUR WHERE media_id = ?", [id]);
    expect(await run()).toMatchObject({ backlog_old: 1 });
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_backlog')).toMatchObject({ severity: 'warning' });
  });
});
