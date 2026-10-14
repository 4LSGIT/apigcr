/**
 * REAL-ENGINE suite for the comms archive S0 evaluation (lane D) on MySQL with
 * the production schema and sql_mode:
 *   M   the migration (twice): tables + the reviewers list
 *   G   the gate: SU / listed / unlisted / deauthorized / claims / API key; the
 *       reviewers list is NOT the purge list (and vice versa)
 *   I   sample-only access, re-checked on every request (restricted, purged, pending)
 *   A   audio: a signed URL for the item, audited, the URL never in the audit
 *   B   the blind rule: no transcript before the noise tag; the tag frozen once served
 *   V   the score validator: numbers / booleans / tags only — every other shape refused
 *   S   the sample insert: SU only, validated, all or nothing
 *   L   the list: ids and metadata, never a party number
 *   W   the review windows: deterministic, in range
 *   C   the production signing check: pass, wrong bytes, tamper accepted, signing failure
 *
 * Stand-ins only at the boundaries: GCS (tests/helpers/fakeGcs.js or an inline
 * signer), the HTTP client of the signing check, and S2's variant reader. Routes
 * run the REAL router, auth middleware and services over an ephemeral express app.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3331/yc_eval_test npx jest tests/commsEval.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-eval-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_eval_internal';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'users', 'app_settings', 'admin_audit_log', 'jwt_api_audit_log', 'scheduled_jobs'];
const PARTY = '2489148845';

maybe('comms archive S0 evaluation on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const admin   = require('../services/commsArchiveAdmin');
  const evals   = require('../services/commsEvalService');
  const router  = require('../routes/api.commsEval');
  const su      = require('../lib/auth.superuser');
  const ORIG = { ...evals.limits };

  let pool, gcs, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = (user, user_auth = 'authorized', roles = []) =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth, roles, aud: 'staff' }, process.env.JWT_SECRET);
  const SS = { t: null }, STAFF = { t: null }, SU = { t: null }, SUX = { t: null, elev: null };   // SUX: SU with the step-up
  async function call(method, path, body, { t, apiKey, elev } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers.Authorization = `Bearer ${t}`;
    if (elev) headers['X-SU-Elevation'] = elev;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const get = (p, who) => call('GET', p, undefined, who);
  const audits = () => q("SELECT status, user_id, route, method, details FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id");
  const det = (a) => (typeof a.details === 'string' ? JSON.parse(a.details) : a.details);

  let nextSrc = 100;
  async function media({ state = 'archived', restricted = 0, kind = 'call_recording', provider = 'ringcentral', channel = 1, name } = {}) {
    const src = ++nextSrc;
    const obj = name === undefined ? `phone/rec/2026/08/${src}-R${src}.mp3` : name;
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, state, restricted,
                                object_name, mime, captured_at)
       VALUES ('phone', ?, 'phone_event_log', ?, ?, ?, ?, ?, ?, ?, ?, 'audio/mpeg', '2026-08-18 15:00:00')`,
      [kind, src, `R${src}`, provider, channel, PARTY, state, restricted, obj]);
    if (obj) gcs.objects.set(obj, { buf: Buffer.from('audio'), contentType: 'audio/mpeg', generation: '1' });
    return r.insertId;
  }
  async function sampled(opts = {}, stratum = 'S2', audioS = 240) {
    const id = await media(opts);
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, audio_s, added_by) VALUES (?, ?, 'e7f499d4d9df2af8', ?, 6)", [id, stratum, audioS]);
    return id;
  }
  async function transcriptsTable() {
    await q(`CREATE TABLE IF NOT EXISTS comms_transcripts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, media_id BIGINT UNSIGNED NOT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'pending', segments JSON NULL, full_text MEDIUMTEXT NULL,
      UNIQUE KEY uq_m (media_id)) ENGINE=InnoDB`);
  }
  const SEGS = [{ s: 'A', a: 0, b: 4.2, t: 'Good morning, law office.' }, { s: 'B', a: 4.4, b: 9.0, t: 'Hi, calling about my case.' }];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    await schema.build(pool, TABLES);
    for (const t of ['comms_eval_items', 'comms_eval_reviews', 'comms_transcripts']) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    for (const f of ['2026-10-14_comms_media.sql', '2026-10-14_comms_s1b.sql', '2026-10-14_comms_eval.sql', '2026-10-14_comms_eval.sql']) {
      for (const s of schema.migrationStatements(f)) await pool.query(s);
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    SS.t = tok(1); STAFF.t = tok(3); SU.t = tok(6, 'authorized', ['su']);
    SUX.t = SU.t; SUX.elev = su.mintElevationToken(6);
  });

  afterAll(async () => {
    archive._test.setStorage(null);
    Object.assign(evals.limits, ORIG);
    if (server) await new Promise(r => server.close(r));
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    Object.assign(evals.limits, ORIG, { variantReader: async () => null });
    su._resetRateLimits();
    for (const t of ['comms_media', 'comms_eval_items', 'comms_eval_reviews', 'phone_lines', 'users', 'admin_audit_log']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    await pool.query('DROP TABLE IF EXISTS comms_transcripts');
    await q(`INSERT INTO phone_lines (id, phone_number, provider, display_name, active, provider_id, credential_id) VALUES
      (1, '2485592400', 'ringcentral', 'Main', 1, NULL, 9), (6, '2484179800', 'quo', 'Office', 1, 'PNb', 10)`);
    await q(`INSERT INTO users (user, user_name, roles, user_auth) VALUES
      (1, 'SS', 'staff,attorney', 'authorized'), (3, 'Staff', 'staff', 'authorized'), (6, 'SU', 'it,admin,su', 'authorized')`);
    // both lists back to '1' (G1 deletes one; the migration's own row shape)
    await q("DELETE FROM app_settings WHERE `key` IN ('comms_eval_reviewers', 'comms_archive_admins')");
    for (const f of ['2026-10-14_comms_s1b.sql', '2026-10-14_comms_eval.sql']) {
      for (const s of schema.migrationStatements(f)) if (/INSERT INTO app_settings/.test(s)) await pool.query(s);
    }
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
  });

  // ── M ──────────────────────────────────────────────────────────────────
  test('M1 migration applied twice: both tables, reviewers list seeded "1", not editable', async () => {
    const [s] = await q("SELECT `value`, is_editable FROM app_settings WHERE `key` = 'comms_eval_reviewers'");
    expect(s).toMatchObject({ value: '1', is_editable: 0 });
    const t = await q("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'comms_eval%' ORDER BY 1");
    expect(t.map(r => r.n)).toEqual(['comms_eval_items', 'comms_eval_reviews']);
  });

  // ── G ──────────────────────────────────────────────────────────────────
  test('G1 the gate: listed / SU pass; unlisted, empty, garbage, missing, claims, API key refused — all audited', async () => {
    const list = (who) => get('/api/comms-eval/items', who);
    expect((await list(SS)).status).toBe(200);
    expect((await list(STAFF)).status).toBe(403);
    expect((await list(SU)).status).toBe(200);
    await q("UPDATE app_settings SET `value` = '' WHERE `key` = 'comms_eval_reviewers'");
    expect((await list(SS)).status).toBe(403);
    expect((await list(SU)).status).toBe(200);
    await q("UPDATE app_settings SET `value` = 'x1, ss, -1' WHERE `key` = 'comms_eval_reviewers'");
    expect((await list(SS)).status).toBe(403);
    await q("DELETE FROM app_settings WHERE `key` = 'comms_eval_reviewers'");
    expect((await list(SS)).status).toBe(403);
    expect((await list({ t: tok(3, 'authorized', ['su']) })).status).toBe(403);     // the claim is not the DB
    expect((await list({ apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
    const a = await audits();
    expect(a.map(x => x.status)).toEqual(['rejected_not_reviewer', 'rejected_not_reviewer', 'rejected_not_reviewer',
      'rejected_not_reviewer', 'rejected_not_reviewer', 'rejected_not_jwt']);
  });

  test('G2 a listed reviewer must still be authorized in the DB', async () => {
    await q("UPDATE users SET user_auth = 'unauthorized' WHERE user = 1");
    expect((await get('/api/comms-eval/items', SS)).status).toBe(403);
  });

  test('G3 the reviewers list is not the purge list, and the purge list is not the reviewers list', async () => {
    await q("UPDATE app_settings SET `value` = '3' WHERE `key` = 'comms_eval_reviewers'");
    expect((await get('/api/comms-eval/items', STAFF)).status).toBe(200);
    expect(await admin.isArchiveAdmin(pool, { type: 'jwt', userId: 3 })).toBe(false);
    expect((await get('/api/comms-eval/items', SS)).status).toBe(403);               // on the purge list only
    expect(await admin.isArchiveAdmin(pool, { type: 'jwt', userId: 1 })).toBe(true);
  });

  test('G4 SU-only routes: a reviewer 403; SU WITHOUT the step-up 401; a forged SU claim still refused by the DB', async () => {
    expect((await call('POST', '/api/comms-eval/sample', { seed: 'e7f499d4d9df2af8', items: [] }, SS)).status).toBe(403);
    expect((await call('POST', '/api/comms-eval/signing-check', {}, SS)).status).toBe(403);
    expect((await call('POST', '/api/comms-eval/sample', { seed: 'e7f499d4d9df2af8', items: [] }, SU)).status).toBe(401);
    expect((await call('POST', '/api/comms-eval/signing-check', {}, SU)).status).toBe(401);
    const forged = { t: tok(3, 'authorized', ['su']), elev: su.mintElevationToken(3) };          // claim says SU, the DB does not
    expect((await call('POST', '/api/comms-eval/signing-check', {}, forged)).status).toBe(403);
    expect((await audits()).map(x => x.status)).toEqual(['rejected_not_su', 'rejected_not_su',
      'rejected_no_elevation', 'rejected_no_elevation', 'rejected_not_su']);
  });

  // ── I ──────────────────────────────────────────────────────────────────
  test('I1 only sampled items: an archived recording outside the sample is 404 on every content route', async () => {
    const id = await media();
    expect((await get(`/api/comms-eval/items/${id}/audio`, SS)).status).toBe(404);
    expect((await get(`/api/comms-eval/items/${id}/transcript`, SS)).status).toBe(404);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS)).status).toBe(404);
    expect(gcs.calls.sign).toHaveLength(0);
  });

  test('I2 re-checked per request: restricted after sampling 404, purged 410, pending 404, bad id 400', async () => {
    const r = await sampled(); const p = await sampled(); const n = await sampled();
    await q('UPDATE comms_media SET restricted = 1 WHERE id = ?', [r]);
    await q("UPDATE comms_media SET state = 'purged' WHERE id = ?", [p]);
    await q("UPDATE comms_media SET state = 'pending' WHERE id = ?", [n]);
    expect((await get(`/api/comms-eval/items/${r}/audio`, SS)).status).toBe(404);
    expect((await get(`/api/comms-eval/items/${p}/audio`, SS)).status).toBe(410);
    expect((await get(`/api/comms-eval/items/${n}/audio`, SS)).status).toBe(404);
    expect((await get('/api/comms-eval/items/12x/audio', SS)).status).toBe(400);
    expect(gcs.calls.sign).toHaveLength(0);
  });

  test('I3 only call recordings: an mms_file and an stt_raw row put straight into the sample are 404 on audio and transcript', async () => {
    for (const kind of ['mms_file', 'stt_raw']) {
      const id = await media({ kind });
      await q("INSERT INTO comms_eval_items (media_id, stratum, seed, audio_s, added_by) VALUES (?, 'S2', 'e7f499d4d9df2af8', 60, 6)", [id]);
      expect([kind, (await get(`/api/comms-eval/items/${id}/audio`, SS)).status]).toEqual([kind, 404]);
      expect([kind, (await get(`/api/comms-eval/items/${id}/transcript`, SS)).status]).toEqual([kind, 404]);
    }
    expect(gcs.calls.sign).toHaveLength(0);
  });

  // ── A ──────────────────────────────────────────────────────────────────
  test('A1 audio: a 5-minute signed URL for exactly that object, inline audio; audited "listen" without the URL', async () => {
    const id = await sampled();
    const r = await get(`/api/comms-eval/items/${id}/audio`, SS);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'success', expires_in_s: 300 });
    expect(r.json.url).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    const [obj] = await q('SELECT object_name FROM comms_media WHERE id = ?', [id]);
    expect(gcs.calls.sign).toHaveLength(1);
    expect(gcs.calls.sign[0]).toMatchObject({ name: obj.object_name, version: 'v4', action: 'read', responseType: 'audio/mpeg', responseDisposition: 'inline' });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: 'success', user_id: 1, method: 'GET' });
    expect(det(a[0])).toEqual({ action: 'listen', media_id: id });
    expect(JSON.stringify(a[0])).not.toMatch(/storage\.googleapis|sig/);
  });

  test('A2 a signing failure on /audio is OUR failure: 500, audited "failed" — never 403 / 404 about the item', async () => {
    const id = await sampled();
    gcs.fail.sign = 403;
    const r = await get(`/api/comms-eval/items/${id}/audio`, SS);
    expect(r.status).toBe(500);
    expect(r.json.message).toMatch(/Could not create the audio link/);
    const a = await audits();
    expect(a.map(x => [x.status, det(x).action])).toEqual([['failed', 'listen']]);
  });

  // ── B ──────────────────────────────────────────────────────────────────
  test('B1 blind rule: 409 before the noise tag; after it, not-ready while S2 has no table, then the segments', async () => {
    const id = await sampled();
    expect((await get(`/api/comms-eval/items/${id}/transcript`, SS)).status).toBe(409);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N2' } }, SS)).status).toBe(200);
    let r = await get(`/api/comms-eval/items/${id}/transcript`, SS);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ready: false });
    const [row0] = await q('SELECT transcript_seen_at FROM comms_eval_reviews WHERE media_id = ?', [id]);
    expect(row0.transcript_seen_at).toBeNull();                                   // nothing was served
    await transcriptsTable();
    await q("INSERT INTO comms_transcripts (media_id, state, segments) VALUES (?, 'transcribed', ?)", [id, JSON.stringify(SEGS)]);
    r = await get(`/api/comms-eval/items/${id}/transcript`, SS);
    expect(r.json).toMatchObject({ ready: true, default: { segments: SEGS } });
    expect(r.json.variant).toBeUndefined();
    const [row1] = await q('SELECT transcript_seen_at FROM comms_eval_reviews WHERE media_id = ?', [id]);
    expect(row1.transcript_seen_at).not.toBeNull();
    // another reviewer's tag does not open it for this one
    expect((await get(`/api/comms-eval/items/${id}/transcript`, SU)).status).toBe(409);
    expect((await audits()).map(a => [a.status, det(a).action])).toEqual([
      ['conflict', 'view_transcript'], ['success', 'eval_score'], ['success', 'view_transcript'],
      ['success', 'view_transcript'], ['conflict', 'view_transcript']]);
  });

  test('B2 the noise tag is frozen once the transcript was served; other fields still save', async () => {
    const id = await sampled();
    await transcriptsTable();
    await q("INSERT INTO comms_transcripts (media_id, state, segments) VALUES (?, 'transcribed', ?)", [id, JSON.stringify(SEGS)]);
    await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N3' } }, SS)).status).toBe(200); // not yet served
    expect((await get(`/api/comms-eval/items/${id}/transcript`, SS)).status).toBe(200);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS)).status).toBe(409);
    const ok = await call('PUT', `/api/comms-eval/items/${id}/review/transcript`,
      { scores: { noise: 'N3', accuracy: 4, key_items: 'some_wrong', speakers: 'mostly_right', usable: 'with_fixes', complete: true } }, SS);
    expect(ok.status).toBe(200);
    const [row] = await q('SELECT scores FROM comms_eval_reviews WHERE media_id = ? AND stage = ?', [id, 'transcript']);
    expect(det({ details: row.scores })).toEqual({ noise: 'N3', accuracy: 4, key_items: 'some_wrong', speakers: 'mostly_right', usable: 'with_fixes', complete: true });
  });

  test('B4 atomic freeze: a transcript served while a save holds the row waits for it — never a tag changed after serving', async () => {
    const id = await sampled();
    await transcriptsTable();
    await q("INSERT INTO comms_transcripts (media_id, state, segments) VALUES (?, 'transcribed', ?)", [id, JSON.stringify(SEGS)]);
    await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS);
    let served = null, seenDuringSave;
    evals.limits.onReviewLocked = async () => {
      evals.limits.onReviewLocked = null;
      // the race the review found: a transcript GET lands between the save's read and its write
      served = get(`/api/comms-eval/items/${id}/transcript`, SS).then(r => r.status);
      await new Promise(r => setTimeout(r, 400));
      const [row] = await q('SELECT transcript_seen_at FROM comms_eval_reviews WHERE media_id = ? AND stage = ?', [id, 'transcript']);
      seenDuringSave = row.transcript_seen_at;
    };
    const save = await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N3' } }, SS);
    expect(save.status).toBe(200);
    expect(seenDuringSave).toBeNull();                      // the serve could not stamp while the save held the row
    expect(await served).toBe(200);                         // …and was served after the save committed
    const [row] = await q('SELECT scores, transcript_seen_at FROM comms_eval_reviews WHERE media_id = ? AND stage = ?', [id, 'transcript']);
    expect(det({ details: row.scores }).noise).toBe('N3');  // the tag in force when the transcript was served
    expect(row.transcript_seen_at).not.toBeNull();
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS)).status).toBe(409);
  });

  test('B3 a Quo item returns the per-channel variant when S2 provides one', async () => {
    const id = await sampled({ provider: 'quo', channel: 6 }, 'S5');
    await transcriptsTable();
    await q("INSERT INTO comms_transcripts (media_id, state, segments) VALUES (?, 'transcribed', ?)", [id, JSON.stringify(SEGS)]);
    const V = [{ s: 'L', a: 0, b: 4.2, t: 'Good morning.' }];
    evals.limits.variantReader = async (_db, mid) => (mid === id ? V : null);
    await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N1' } }, SS);
    const r = await get(`/api/comms-eval/items/${id}/transcript`, SS);
    expect(r.json).toMatchObject({ ready: true, default: { segments: SEGS }, variant: { label: 'per-channel', segments: V } });
  });

  // ── V ──────────────────────────────────────────────────────────────────
  test('V1 the A3 validator refuses every shape that is not a fixed choice — and stores nothing', async () => {
    const id = await sampled();
    const bad = [
      { noise: 'loud' }, { noise: 'N1', note: 'client said x' }, {}, { accuracy: 4 },
      { noise: 'N1', accuracy: 0 }, { noise: 'N1', accuracy: 6 }, { noise: 'N1', accuracy: 4.5 }, { noise: 'N1', accuracy: '4' },
      { noise: 'N1', key_items: 'mostly' }, { noise: 'N1', speakers: 'Right' }, { noise: 'N1', usable: true },
      { noise: 'N1', worst: 'the judge name' }, { noise: 'N1', variant_better: 'left' },
      { noise: 'N1', complete: 'yes' },
      { noise: 'N1', complete: true },                                                    // "done" without the answers (Fred's case)
      { noise: 'N1', accuracy: 4, key_items: 'all_right', speakers: 'right', complete: true },   // usable missing
      { noise: 'N1', windows: [{ start_s: 0, words: 10, sub: 0, ins: 0, del: 0 }] },            // the pre-A3 count fields
      { noise: 'N1', items: { names: { heard: 1, correct: 1 } } }, { noise: 'N1', turns: { total: 1, correct: 1 } },
      { noise: 'N1', key_items: { v: 'all_right' } }, { noise: 'N1', __proto__: { x: 1 }, worst: 'none', extra: 1 },
    ];
    for (const scores of bad) {
      const r = await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores }, SS);
      expect([r.status, JSON.stringify(scores)]).toEqual([400, JSON.stringify(scores)]);
    }
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: 'N1' }, SS)).status).toBe(400);
    const alt = await call('PUT', `/api/comms-eval/items/${id}/review/transcript_alt`, { scores: { noise: 'N1' } }, SS);
    expect(alt.status).toBe(400);
    expect(alt.json.message).toMatch(/Retired/);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/summary`, { scores: {} }, SS)).status).toBe(400);
    expect((await call('PUT', `/api/comms-eval/items/${id}/review/other`, { scores: {} }, SS)).status).toBe(400);
    expect(await q('SELECT * FROM comms_eval_reviews')).toHaveLength(0);
    const rows = await q("SELECT status, error_message FROM admin_audit_log WHERE tool = 'comms_archive'");
    expect(rows.length).toBeGreaterThanOrEqual(bad.length);
    for (const r of rows) expect(r).toEqual({ status: 'rejected_bad_request', error_message: 'invalid request' });
    expect(JSON.stringify(rows)).not.toMatch(/note|client said|judge|accuracy|usable/);
  });

  test('V2 an A3 sheet is stored exactly as normalized; partial sheets save as not done', async () => {
    const id = await sampled({ provider: 'quo', channel: 6 }, 'S5');
    const scores = { noise: 'N2', accuracy: 5, key_items: 'none', speakers: 'right', usable: 'yes', worst: 'none',
      variant_better: 'per_channel', complete: true };
    const r = await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores }, SS);
    expect(r.status).toBe(200);
    expect(r.json.scores).toEqual(scores);
    const [row] = await q('SELECT reviewer_id, stage, scores FROM comms_eval_reviews');
    expect(row).toMatchObject({ reviewer_id: 1, stage: 'transcript' });
    expect(det({ details: row.scores })).toEqual(scores);
    const part = await call('PUT', `/api/comms-eval/items/${id}/review/transcript`, { scores: { noise: 'N2', accuracy: 3, complete: false } }, SS);
    expect(part.status).toBe(200);
    const mine = await get(`/api/comms-eval/items/${id}/review`, SS);
    expect(mine.json.reviews).toEqual({ transcript: { scores: { noise: 'N2', accuracy: 3, complete: false }, transcript_opened: false } });
    expect((await get(`/api/comms-eval/items/${id}/review`, SU)).json.reviews).toEqual({});   // only my own
  });

  // ── S ──────────────────────────────────────────────────────────────────
  test('S1 sample insert: SU only, validated per item, all or nothing, audited', async () => {
    const a = await media(); const b = await media();
    const pend = await media({ state: 'pending' }); const res = await media({ restricted: 1 }); const mms = await media({ kind: 'mms_file' });
    const body = (items) => ({ seed: 'e7f499d4d9df2af8', items });
    let r = await call('POST', '/api/comms-eval/sample', body([{ media_id: a, stratum: 'S1', audio_s: 25 }, { media_id: pend, stratum: 'S2' },
      { media_id: res, stratum: 'S2' }, { media_id: mms, stratum: 'S3' }, { media_id: 999999, stratum: 'S3' }]), SUX);
    expect(r.status).toBe(400);
    expect(r.json.refused.map(x => x.why).sort()).toEqual(['no such archive item', 'not a call recording', 'restricted', 'state pending']);
    expect(await q('SELECT * FROM comms_eval_items')).toHaveLength(0);
    r = await call('POST', '/api/comms-eval/sample', body([{ media_id: a, stratum: 'S1', audio_s: 25 }, { media_id: b, stratum: 'S4' }]), SUX);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ added: 2, seed: 'e7f499d4d9df2af8' });
    expect(await q('SELECT media_id, stratum, audio_s, added_by FROM comms_eval_items ORDER BY media_id')).toEqual([
      { media_id: a, stratum: 'S1', audio_s: 25, added_by: 6 }, { media_id: b, stratum: 'S4', audio_s: null, added_by: 6 }]);
    r = await call('POST', '/api/comms-eval/sample', body([{ media_id: a, stratum: 'S1' }]), SUX);
    expect(r.json.refused).toEqual([{ media_id: a, why: 'already in the sample' }]);
    for (const bad of [{ seed: 'XYZ', items: [{ media_id: a, stratum: 'S1' }] }, body([{ media_id: a, stratum: 'S9' }]),
      body([{ media_id: a, stratum: 'S1' }, { media_id: a, stratum: 'S2' }]), body([]), body([{ media_id: a, stratum: 'S1', note: 'x' }])]) {
      expect((await call('POST', '/api/comms-eval/sample', bad, SUX)).status).toBe(400);
    }
    const au = (await audits()).filter(x => det(x).action === 'eval_sample');
    expect(au.map(x => x.status)).toEqual(['rejected_bad_request', 'success', 'rejected_bad_request',
      'rejected_bad_request', 'rejected_bad_request', 'rejected_bad_request', 'rejected_bad_request', 'rejected_bad_request']);
  });

  // ── L ──────────────────────────────────────────────────────────────────
  test('L1 the list: ids, stratum, line name, day, length, availability, my progress — never the party number', async () => {
    const a = await sampled({}, 'S2', 240);
    const b = await sampled({ restricted: 1 }, 'S1', 25);
    await call('PUT', `/api/comms-eval/items/${a}/review/transcript`, { scores: { noise: 'N3', accuracy: 4, key_items: 'some_wrong', speakers: 'mostly_right', usable: 'with_fixes', complete: true } }, SS);
    // the pre-A3 row shape Fred left on call 948: "complete" with no scores — must list as NOT done
    const c = await sampled({}, 'S1', 25);
    await q("INSERT INTO comms_eval_reviews (reviewer_id, media_id, stage, scores) VALUES (1, ?, 'transcript', ?)", [c, JSON.stringify({ noise: 'N1', complete: true })]);
    const r = await get('/api/comms-eval/items', SS);
    expect(r.status).toBe(200);
    expect(r.json.me).toEqual({ su: false });
    const byId = Object.fromEntries(r.json.items.map(i => [i.id, i]));
    expect(byId[a]).toMatchObject({ stratum: 'S2', provider: 'ringcentral', line: 'Main', day: '2026-08-18', audio_s: 240,
      available: true, transcript_ready: false, mine: { transcript: { saved: true, complete: true, noise: 'N3' } } });
    expect(byId[c].mine).toEqual({ transcript: { saved: true, complete: false, noise: 'N1' } });   // re-scored under A3
    expect(byId[b]).toBeUndefined();                                   // restricted: hidden from a reviewer
    const suList = Object.fromEntries((await get('/api/comms-eval/items', SU)).json.items.map(i => [i.id, i]));
    expect(suList[b]).toMatchObject({ available: false, windows: [{ start_s: 0, whole: true }] });   // SU still sees it
    expect(JSON.stringify(r.json)).not.toContain(PARTY);
    expect(JSON.stringify(r.json)).not.toMatch(/object_name|phone\/rec/);
    expect((await get('/api/comms-eval/items', SU)).json.me).toEqual({ su: true });
  });

  // ── W ──────────────────────────────────────────────────────────────────
  test('W1 windows: whole call up to 90 s; else two 60 s windows, ≥ 60 s apart, inside the call, deterministic', () => {
    expect(evals.windowsFor({ seed: 's', mediaId: 1, audioS: 90 })).toEqual([{ start_s: 0, whole: true }]);
    for (let id = 1; id <= 300; id++) {
      const L = 91 + ((id * 97) % 14000);
      const w = evals.windowsFor({ seed: 'e7f499d4d9df2af8', mediaId: id, audioS: L });
      expect(w).toHaveLength(2);
      for (const x of w) { expect(x.start_s).toBeGreaterThanOrEqual(0); expect(x.start_s + 60).toBeLessThanOrEqual(L); }
      if (L - 60 >= 120) expect(w[1].start_s - w[0].start_s).toBeGreaterThanOrEqual(60);
      expect(evals.windowsFor({ seed: 'e7f499d4d9df2af8', mediaId: id, audioS: L })).toEqual(w);
    }
  });

  // ── C ──────────────────────────────────────────────────────────────────
  describe('C signing check', () => {
    const SIGNED = 'https://storage.googleapis.com/lsg-yc-comms-archive-test/_s0/probe.txt?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=0a1b2c3d4e&X-Goog-Expires=300';
    let fetched;
    const signer = (url = SIGNED, fail = null) => ({
      bucket: () => ({ file: (name) => ({ async getSignedUrl(o) {
        if (fail) throw Object.assign(new Error('iam.serviceAccounts.signBlob denied'), { code: 403 });
        fetched.signed = { name, ...o }; return [url];
      } }) }),
    });
    const fakeFetch = (respond) => async (url) => {
      fetched.urls.push(url);
      const r = respond(url);
      return { status: r.status, async arrayBuffer() { return Buffer.from(r.body || ''); }, body: null };
    };
    beforeEach(() => { fetched = { urls: [] }; });

    test('C1 pass: 200 with the probe bytes, tampered 403; SU only; audited; the URL never in the reply or the audit', async () => {
      archive._test.setStorage(signer());
      evals.limits.fetch = fakeFetch((u) => (u === SIGNED ? { status: 200, body: evals.PROBE_TEXT } : { status: 403, body: 'SignatureDoesNotMatch' }));
      const r = await call('POST', '/api/comms-eval/signing-check', {}, SUX);
      expect(r.status).toBe(200);
      expect(r.json.check).toEqual({ pass: true, sign: 'ok', signed: { status: 200, bytes_match: true }, tampered: { status: 403 } });
      expect(fetched.signed).toMatchObject({ name: '_s0/probe.txt', version: 'v4', action: 'read' });
      expect(fetched.urls).toHaveLength(2);
      expect(fetched.urls[1]).toBe(SIGNED.replace('0a1b2c3d4e', '0a1b2c3d40'));   // one digit changed
      expect(JSON.stringify(r.json)).not.toMatch(/googleapis|Signature/);
      const a = await audits();
      expect(a.map(x => [x.status, det(x).action])).toEqual([['success', 'signing_check']]);
      expect(JSON.stringify(a)).not.toMatch(/googleapis|Signature/);
    });

    test('C2 fail: wrong bytes; tampered URL accepted; signing refused; no signature in the URL → 502, never pass', async () => {
      archive._test.setStorage(signer());
      evals.limits.fetch = fakeFetch((u) => (u === SIGNED ? { status: 200, body: 'something else' } : { status: 403 }));
      let r = await call('POST', '/api/comms-eval/signing-check', {}, SUX);
      expect(r.status).toBe(502);
      evals.limits.fetch = fakeFetch(() => ({ status: 200, body: evals.PROBE_TEXT }));
      r = await call('POST', '/api/comms-eval/signing-check', {}, SUX);
      expect(r.status).toBe(502);
      archive._test.setStorage(signer(SIGNED, true));
      r = await call('POST', '/api/comms-eval/signing-check', {}, SUX);
      expect(r.status).toBe(502);
      archive._test.setStorage(signer('https://storage.googleapis.com/b/_s0/probe.txt?nosig=1'));
      evals.limits.fetch = fakeFetch(() => ({ status: 200, body: evals.PROBE_TEXT }));
      r = await call('POST', '/api/comms-eval/signing-check', {}, SUX);
      expect(r.status).toBe(502);
      expect((await audits()).map(x => x.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    });

    test('C3 the probe text is byte-for-byte the one s0_infra.sh wrote', () => {
      const fs = require('fs');
      const sh = fs.readFileSync(require('path').join(__dirname, '..', 'scripts', 'commsArchive', 's0_infra.sh'), 'utf8');
      const m = /^PROBE_TEXT='(.*)'$/m.exec(sh);
      expect(m && m[1]).toBe(evals.PROBE_TEXT);
    });
  });
});
