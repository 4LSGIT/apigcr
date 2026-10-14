/**
 * REAL-ENGINE suite for comms archive S3 (AI summaries) on MySQL with the
 * production schema and sql_mode:
 *   F   the full path — the request aiService really sends (model, effort,
 *       max_tokens, the untrusted transcript, the trusted context), the
 *       verified summary written with the fence, cost + ai_call_ids, the
 *       queue row; the contact ON THE CALL DATE (unique, else unknown);
 *   G   gates — mode off / sample / on / garbage, restricted (and back),
 *       short (calls only; not voicemails, not sample), empty, the SHARED cap
 *       (STT ledger + ai_calls + calls in flight), config;
 *   E   outcomes — refusal (skipped, one call), max_tokens (no retry inside
 *       the call; failed after 3), unusable JSON then the stricter retry (two
 *       ai_calls rows, both purged), rejected output (schema), 401 / 400 / 429
 *       (stop, uncharged), 5xx (charged), write-ahead (a crash mid-call is
 *       still counted and the row comes back);
 *   P   purge — ai_calls text cleared for every attempt (cost kept); a purge
 *       landing DURING the call (aiService logs after it) and between the
 *       validation and the UPDATE;
 *   T   pacing, the lock.
 *
 * Real modules: the sweep, aiService, lib/credentialInjection (credential 12
 * in the DB), the prompt registry, commsArchiveAdmin.purge, both migrations.
 * The only stand-in: the Anthropic API behind global fetch.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s3_test npx jest tests/commsSummarize.mysql.test.js --runInBand
 */

'use strict';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'system_alerts', 'alert_state', 'app_settings', 'scheduled_jobs', 'credentials', 'ai_calls',
  'contacts', 'contact_phones', 'case_relate', 'cases', 'phone_event_log'];
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

const SEGS = [
  { s: 'A', a: 0, b: 4.2, t: 'Good morning, law office.' },
  { s: 'B', a: 4.5, b: 12, t: 'Hi, this is Maria. I am calling about my Chapter 13 case.' },
  { s: 'A', a: 12.4, b: 20, t: 'Can you send us your last two pay stubs by Friday?' },
  { s: 'B', a: 20.5, b: 30, t: 'Yes, I will email them today.' },
];
const GOOD = {
  call_type: 'client', summary: 'Maria called about her Chapter 13 case; the firm asked for two pay stubs by Friday.',
  parties: [{ speaker: 'A', role: 'firm', name: null }, { speaker: 'B', role: 'client', name: 'Maria' }],
  commitments: [{ by: 'other', what: 'email the pay stubs', quote: 'I will email them today' }],
  dates: [], amounts: [],
  documents_requested: [
    { what: 'two pay stubs', quote: 'send us your last two pay stubs by Friday' },
    { what: 'tax return', quote: 'and your 2025 tax return' },          // NOT said → dropped
  ],
  case_refs: [{ text: 'Chapter 13', quote: 'my Chapter 13 case' }],
  follow_up: { needed: true, why: 'Pay stubs due Friday.' }, flags: [],
};

maybe('comms archive S3 summaries on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const { fakeStorage } = require('./helpers/fakeGcs');
  const schema  = require('./helpers/commsArchiveSchema');
  const archive = require('../services/commsArchiveService');
  const sweep   = require('../services/commsSummarizeSweep');
  const tx      = require('../services/commsTranscribeSweep');
  const admin   = require('../services/commsArchiveAdmin');
  const ai      = require('../services/aiService');
  const { scriptGuard } = require('./helpers/scriptGuard');
  const ORIG = { ...sweep.limits };
  const realFetch = global.fetch;

  let pool, gcs, api;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const set = (k, v) => q('UPDATE app_settings SET `value` = ? WHERE `key` = ?', [v, k]);
  const tr = async (id) => (await q('SELECT * FROM comms_transcripts WHERE id = ?', [id]))[0];
  const qrow = async (tid) => (await q('SELECT * FROM comms_summaries WHERE transcript_id = ?', [tid]))[0];
  const calls = (tid) => q('SELECT * FROM ai_calls WHERE consumer_ref = ? ORDER BY id', [`comms_transcript:${tid}`]);
  const alerts = () => q('SELECT group_key, severity, title, message FROM system_alerts ORDER BY id');
  const due = () => q("UPDATE comms_summaries SET next_attempt_at = NULL WHERE state IN ('pending', 'calling')");
  const run = (db = pool) => sweep.runSummarizeSweep(db);

  // ── the Anthropic API stand-in ───────────────────────────────────────────
  const reply = (text, { stop = 'end_turn', inTok = 900, outTok = 400, status = 200 } = {}) =>
    ({ status, body: { id: 'msg', type: 'message', role: 'assistant', model: 'x', stop_reason: stop,
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], usage: { input_tokens: inTok, output_tokens: outTok } } });
  function makeApi() {
    const f = { bodies: [], headers: [], queue: [], before: null };
    // Queued replies are a script: one never consumed fails the test (an empty queue answers GOOD by design).
    scriptGuard('anthropicQueue', f.queue);
    f.fetch = async (url, init = {}) => {
      if (url !== ANTHROPIC) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(init.body);
      f.bodies.push(body); f.headers.push(init.headers);
      if (f.before) await f.before(body);
      const r = f.queue.length ? f.queue.shift() : reply(JSON.stringify(GOOD));
      if (r.throw) throw r.throw;
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    };
    return f;
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  let nextEv = 9000;
  const AT = new Date('2026-10-12T15:30:00Z');          // 11:30 in Detroit
  async function item({ kind = 'call_recording', restricted = 0, duration = 30, party = '2485550123', segs = SEGS, state = 'transcribed', at = AT, direction = 'incoming' } = {}) {
    const ev = ++nextEv;
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number, other_party, suppressed, raw_extra, processed_at)
             VALUES (?, 'ringcentral', ?, 'call', ?, ?, '2485592400', ?, 0, '{}', ?)`, [ev, `R${ev}`, direction, party, party, at]);
    const [m] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, object_name, mime, bytes,
                                duration_s, captured_at, state, restricted)
       VALUES ('phone', ?, 'phone_event_log', ?, ?, 'ringcentral', 1, ?, ?, 'audio/mpeg', 1000, ?, ?, 'archived', ?)`,
      [kind, ev, `p${ev}`, party, `phone/rec/2026/10/${ev}-p.mp3`, duration, at, restricted]);
    const [t] = await pool.query(
      `INSERT INTO comms_transcripts (media_id, phone_event_id, state, stt_vendor, segments, full_text, transcribed_at)
       VALUES (?, ?, ?, 'assemblyai', ?, ?, UTC_TIMESTAMP())`,
      [m.insertId, ev, state, JSON.stringify(segs), segs.map(s => s.t).join('\n')]);
    return { tid: t.insertId, mid: m.insertId };
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    for (const t of ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe', 'comms_summaries', 'comms_eval_items']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await schema.build(pool, TABLES);
    for (const s of schema.migrationStatements('2026-10-14_comms_media.sql')) await pool.query(s);
    const conn = await pool.getConnection();
    try {
      const r = await require('../scripts/commsTranscribeS2Migrate').run(conn, { apply: true, say: () => {} });
      if (!r.ok) throw new Error(`S2 migration: ${r.line}`);
    } finally { conn.release(); }
    for (const s of schema.migrationStatements('2026-10-15_comms_s3_summaries.sql')) await pool.query(s);
    await pool.query(`CREATE TABLE IF NOT EXISTS comms_eval_items (media_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, stratum VARCHAR(4) NOT NULL,
      seed VARCHAR(32) NOT NULL, audio_s INT UNSIGNED NULL, added_by TINYINT NOT NULL, added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`INSERT INTO credentials (id, name, type, config, allowed_urls)
      VALUES (12, 'Claude', 'api_key', '{"header": "x-api-key", "key": "sk-test-not-a-key"}', '["https://api.anthropic.com/*"]')`);
  });
  afterAll(async () => {
    global.fetch = realFetch;
    archive._test.setStorage(null);
    Object.assign(sweep.limits, ORIG);
    if (pool) await pool.end();
  });
  beforeEach(async () => {
    Object.assign(sweep.limits, ORIG);
    for (const t of ['comms_summaries', 'comms_transcripts', 'comms_stt_jobs', 'comms_media', 'comms_eval_items', 'ai_calls',
      'system_alerts', 'alert_state', 'phone_event_log', 'contacts', 'contact_phones', 'case_relate', 'cases']) await pool.query(`DELETE FROM ${t}`);
    for (const [k, v] of [['comms_summarize_mode', 'on'], ['comms_summary_model', 'claude-sonnet-5-5'], ['comms_summary_effort', 'low'],
      ['comms_min_summary_s', '30'], ['comms_ai_monthly_cap_cents', '7500']]) await set(k, v);
    process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
    gcs = fakeStorage();
    archive._test.setStorage(gcs.storage);
    api = makeApi();
    global.fetch = api.fetch;
  });

  // ═══ F ════════════════════════════════════════════════════════════════════
  test('F1 the full path: the request sent, the VERIFIED summary written, cost + ids recorded, the queue done', async () => {
    // Maria's number: hers on the call date; the case numbers of her open cases
    await q("INSERT INTO contacts (contact_id, contact_name) VALUES (501, 'Maria Lopez'), (502, 'Someone Else')");
    await q(`INSERT INTO contact_phones (id, contact_id, phone, start_date, end_date) VALUES
      (1, 502, '2485550123', '2020-01-01', '2026-06-30'), (2, 501, '2485550123', '2026-07-01', NULL)`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_stage, case_status) VALUES
      ('C1', '26-40001', '26-40001-mar', 'Filed', 'x'), ('C2', '19-1', '', 'Closed', 'x')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (1, 'C1', 501, 'Primary'), (2, 'C2', 501, 'Primary')`);
    const { tid } = await item();
    const r = await run();
    expect(r).toMatchObject({ mode: 'on', discovered: 1, calls: 1, summarized: 1, grounding_dropped: 1, stop: null });

    const body = api.bodies[0];
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 16000, output_config: { effort: 'low' } });
    expect(api.headers[0]['x-api-key']).toBe('sk-test-not-a-key');
    expect(body.system).toMatch(/the other party, as matched to our contacts on that date: Maria Lopez/);
    expect(body.system).toMatch(/open case number\(s\): 26-40001-mar\n/);
    expect(body.system).toMatch(/kind: call\n/);
    expect(body.system).toMatch(/direction: incoming/);
    expect(body.system).toMatch(/Oct 12, 2026, 11:30/);                                   // firm-local
    expect(body.system).not.toMatch(/pay stubs/);                                         // the transcript is NOT in the system text
    expect(body.messages[0].content).toBe(`<untrusted_user_input>\n[00:00] A: Good morning, law office.\n[00:04] B: Hi, this is Maria. I am calling about my Chapter 13 case.\n[00:12] A: Can you send us your last two pay stubs by Friday?\n[00:20] B: Yes, I will email them today.\n</untrusted_user_input>`);

    const t = await tr(tid);
    expect(t).toMatchObject({ state: 'summarized', summary_model: 'claude-sonnet-5-5', grounding_dropped: 1,
      summary_text: GOOD.summary });
    expect(t.summary.documents_requested).toEqual([{ what: 'two pay stubs', quote: 'send us your last two pay stubs by Friday', t: 12.4 }]);
    expect(t.summary.commitments[0].t).toBe(20.5);
    expect(t.summary.parties[1]).toEqual({ speaker: 'B', role: 'client', name: 'Maria' });
    const cs = await calls(tid);
    expect(cs.length).toBe(1);
    expect(t.ai_call_ids).toEqual([cs[0].id]);
    // ai_calls (readable on the read-only endpoint) holds NO content for this consumer — spend only
    expect(cs[0].request_excerpt).toMatch(/^\[omitted: \d+ chars\]$/);
    expect(cs[0].response).toMatch(/^\[omitted: \d+ chars\]$/);
    expect(JSON.stringify(cs)).not.toMatch(/Maria|pay stubs|26-40001/);
    expect(cs[0]).toMatchObject({ status: 'ok', model: 'claude-sonnet-5-5', input_tokens: 900, output_tokens: 400 });
    expect(Number(t.llm_cost_cents)).toBeCloseTo(ai.computeCostCents(900, 400, 'claude-sonnet-5-5'), 4);
    expect(await qrow(tid)).toMatchObject({ state: 'done', est_cents: null, attempts: 0, model: 'claude-sonnet-5-5', effort: 'low' });
    expect(await tx.monthToDateCents(pool)).toBeCloseTo(ai.computeCostCents(900, 400, 'claude-sonnet-5-5'), 4);
    // a second tick does nothing
    expect(await run()).toMatchObject({ discovered: 0, calls: 0 });
  });

  test('F2 the contact is only named when ONE contact held the number on the call date', async () => {
    await q("INSERT INTO contacts (contact_id, contact_name) VALUES (501, 'A One'), (502, 'B Two')");
    // uk_phone_active allows one OPEN row per number; overlapping windows still happen (a closed row ending after the new one starts)
    await q(`INSERT INTO contact_phones (id, contact_id, phone, start_date, end_date) VALUES
      (1, 501, '2485550123', NULL, '2026-12-31'), (2, 502, '2485550123', '2026-01-01', NULL)`);
    await item();
    await run();
    expect(api.bodies[0].system).toMatch(/our contacts on that date: unknown/);
    expect(api.bodies[0].system).toMatch(/open case number\(s\): none known/);
  });

  test('F3 a voicemail: kind voicemail, call_type forced, short gate not applied', async () => {
    const { tid } = await item({ kind: 'voicemail', duration: 8 });
    await run();
    expect(api.bodies[0].system).toMatch(/kind: voicemail/);
    expect((await tr(tid)).summary.call_type).toBe('voicemail');
  });

  // ═══ G ════════════════════════════════════════════════════════════════════
  test('G1 mode off / garbage: nothing sent', async () => {
    await item();
    await set('comms_summarize_mode', 'off');
    expect(await run()).toMatchObject({ mode: 'off', calls: 0, discovered: 0 });
    await set('comms_summarize_mode', 'yes');
    expect(await run()).toMatchObject({ mode: 'off', calls: 0 });
    expect(api.bodies.length).toBe(0);
    expect((await alerts()).find(a => a.group_key === 'comms_summarize_config')).toMatchObject({ severity: 'warning' });
  });

  test('G2 sample: only comms_eval_items; the short gate is bypassed', async () => {
    await set('comms_summarize_mode', 'sample');
    const a = await item({ duration: 5 });
    const b = await item();
    await q("INSERT INTO comms_eval_items (media_id, stratum, seed, added_by) VALUES (?, 'S1', 's', 1)", [a.mid]);
    expect(await run()).toMatchObject({ calls: 1, summarized: 1 });
    expect((await tr(a.tid)).state).toBe('summarized');
    expect(await qrow(b.tid)).toBeUndefined();
  });

  test('G2b switching on → sample: a pending row outside the sample is never sent', async () => {
    await set('comms_ai_monthly_cap_cents', '0');
    const { tid } = await item();
    await run();                                                        // queued under 'on', held by the cap
    expect(await qrow(tid)).toMatchObject({ state: 'pending' });
    await set('comms_ai_monthly_cap_cents', '7500');
    await set('comms_summarize_mode', 'sample');
    expect(await run()).toMatchObject({ calls: 0 });
    expect(api.bodies.length).toBe(0);
  });

  test('G3 restricted is never sent; unrestricted it is summarised', async () => {
    const { tid, mid } = await item({ restricted: 1 });
    expect(await run()).toMatchObject({ skipped_restricted: 1, calls: 0 });
    expect(await qrow(tid)).toMatchObject({ state: 'skipped', skip_reason: 'restricted', attempts: 0 });
    await admin.setRestricted(pool, mid, false);
    expect(await run()).toMatchObject({ unrestricted: 1, summarized: 1 });
    expect(api.bodies.length).toBe(1);
  });

  test('G4 short (a call under 30 s of measured audio) and empty transcripts are skipped', async () => {
    const s = await item({ duration: 12 });
    const e = await item({ segs: [] });
    await q("UPDATE comms_transcripts SET full_text = '' WHERE id = ?", [e.tid]);
    expect(await run()).toMatchObject({ skipped_short: 1, skipped_empty: 1, calls: 0 });
    expect(await qrow(s.tid)).toMatchObject({ state: 'skipped', skip_reason: 'short' });
  });

  test('G5 the SHARED cap: STT ledger + summary calls + calls in flight; no call past it (uncharged), alert', async () => {
    const { tid } = await item();
    await q(`INSERT INTO comms_stt_jobs (transcript_id, media_id, role, variant, job_ref, state, est_cents, cost_cents)
             VALUES (?, 1, 'main', 'diarize', 'tx-a', 'completed', 1, 2.5)`, [tid]);
    await q("INSERT INTO ai_calls (prompt_key, model, status, consumer_ref, cost_cents, created_at) VALUES ('comms_summary', 'claude-sonnet-5-5', 'ok', 'comms_transcript:99', 1.25, UTC_TIMESTAMP())");
    await q("INSERT INTO ai_calls (prompt_key, model, status, consumer_ref, cost_cents, created_at) VALUES ('court_extract', 'claude-sonnet-4-6', 'ok', 'court:1', 50, UTC_TIMESTAMP())");
    await q("INSERT INTO comms_summaries (transcript_id, state, est_cents) VALUES (9999, 'calling', 0.5)");
    expect(await tx.monthToDateCents(pool)).toBeCloseTo(2.5 + 1.25 + 0.5, 6);      // court_extract is not ours
    await set('comms_ai_monthly_cap_cents', '4');
    expect(await run()).toMatchObject({ stop: 'cap', calls: 0 });
    expect(await qrow(tid)).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await alerts()).find(a => a.group_key === 'comms_transcribe_cap').title).toMatch(/monthly AI cap/);
  });

  test('G6 a bad model / effort setting stops the tick before any call', async () => {
    await item();
    await set('comms_summary_model', 'claude-opus-5-5');
    expect(await run()).toMatchObject({ stop: 'config', calls: 0 });
    await set('comms_summary_model', 'claude-sonnet-5-5');
    await set('comms_summary_effort', 'max');
    expect(await run()).toMatchObject({ stop: 'config', calls: 0 });
    expect(api.bodies.length).toBe(0);
  });

  // ═══ E ════════════════════════════════════════════════════════════════════
  test('E1 a refusal: ONE call, skipped refused, warning — the transcript untouched', async () => {
    const { tid } = await item();
    api.queue.push(reply('', { stop: 'refusal' }));
    expect(await run()).toMatchObject({ calls: 1, refused: 1 });
    expect(api.bodies.length).toBe(1);
    expect(await qrow(tid)).toMatchObject({ state: 'skipped', skip_reason: 'refused' });
    expect((await tr(tid)).state).toBe('transcribed');
    expect((await alerts()).find(a => a.group_key === 'comms_summarize_refused')).toMatchObject({ severity: 'warning' });
  });

  test('E2 max_tokens is deterministic: ONE call, failed at once (fixed code), its cost counted', async () => {
    const { tid } = await item();
    api.queue.push(reply('{"call_type":"cli', { stop: 'max_tokens' }));
    expect(await run()).toMatchObject({ calls: 1, failed: 1 });
    await due();
    expect(await run()).toMatchObject({ calls: 0 });
    expect(api.bodies.length).toBe(1);
    expect(await qrow(tid)).toMatchObject({ state: 'failed', last_error: 'max_tokens' });
    expect(Number((await tr(tid)).llm_cost_cents)).toBeCloseTo(ai.computeCostCents(900, 400, 'claude-sonnet-5-5'), 4);
    expect((await alerts()).find(a => a.group_key === 'comms_summarize_failed')).toBeTruthy();
  });

  test('E2b a timeout is charged the WORST-CASE estimate on its ai_calls row, never 0', async () => {
    const { tid } = await item();
    sweep.limits.timeoutShortMs = 1000;
    api.before = (body) => new Promise(() => {});      // never answers: aiService aborts at 1 s
    const realFetch2 = api.fetch;
    global.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    try {
      expect(await run()).toMatchObject({ calls: 1, retried: 1 });
    } finally { global.fetch = realFetch2; api.before = null; }
    const [c] = await calls(tid);
    expect(c).toMatchObject({ status: 'timeout' });
    const inTok = Math.ceil(require('../services/commsSummaryGround').transcriptText(SEGS).length / 4) + sweep.limits.systemTokens;
    expect(Number(c.cost_cents)).toBeCloseTo(ai.computeCostCents(inTok, 16000, 'claude-sonnet-5-5'), 3);
    expect(Number((await tr(tid)).llm_cost_cents)).toBeCloseTo(Number(c.cost_cents), 4);
    expect((await qrow(tid)).last_error).toBe('call_failed:timeout');
  });

  test('E3 unusable JSON then the stricter retry succeeds: two ai_calls rows, both in ai_call_ids', async () => {
    const { tid } = await item();
    api.queue.push(reply('Here is the summary: {oops'), reply(JSON.stringify(GOOD)));
    expect(await run()).toMatchObject({ summarized: 1 });
    const cs = await calls(tid);
    expect(cs.length).toBe(2);
    expect((await tr(tid)).ai_call_ids).toEqual(cs.map(c => c.id));
  });

  test('E4 output that fails the schema is rejected (charged); 3 → failed', async () => {
    const { tid } = await item();
    for (let i = 0; i < 3; i++) { api.queue.push(reply(JSON.stringify({ ...GOOD, call_type: 'debtor' }))); await due(); await run(); }
    expect(await qrow(tid)).toMatchObject({ state: 'failed' });
    expect((await tr(tid)).state).toBe('transcribed');
  });

  test('E5 401 / 400 / 429 stop the tick uncharged (config alert for 401 / 400); a 5xx is charged', async () => {
    const a = await item();
    await item();
    api.queue.push({ status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
    expect(await run()).toMatchObject({ stop: 'no_auth', calls: 1 });
    expect(await qrow(a.tid)).toMatchObject({ state: 'pending', attempts: 0 });
    api.queue.push({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error' } } });
    expect(await run()).toMatchObject({ stop: 'request_refused', calls: 1 });
    api.queue.push({ status: 429, body: { type: 'error' } });
    expect(await run()).toMatchObject({ stop: 'rate_limited', calls: 1 });
    expect((await q('SELECT MAX(attempts) AS m FROM comms_summaries'))[0].m).toBe(0);
    expect((await alerts()).filter(x => x.group_key === 'comms_summarize_config').length).toBeGreaterThanOrEqual(1);
    api.queue.push({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
    expect(await run()).toMatchObject({ retried: 1 });
    expect((await q("SELECT MAX(attempts) AS m FROM comms_summaries"))[0].m).toBe(1);
  });

  test('E6 write-ahead at the WORST case; a call lost in flight is charged as a synthetic row that outlives the lease', async () => {
    const { tid } = await item();
    const spy = jest.spyOn(ai, 'call').mockImplementationOnce(async () => { throw new Error('process died'); });
    try { await expect(run()).rejects.toThrow(/process died/); } finally { spy.mockRestore(); }
    const row = await qrow(tid);
    expect(row.state).toBe('calling');
    const inTok = Math.ceil(require('../services/commsSummaryGround').transcriptText(SEGS).length / 4) + sweep.limits.systemTokens;
    const worst = ai.computeCostCents(inTok, 16000, 'claude-sonnet-5-5');
    expect(Number(row.est_cents)).toBeCloseTo(worst, 3);
    expect(await tx.monthToDateCents(pool)).toBeCloseTo(worst, 3);
    await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    expect(await run()).toMatchObject({ calls: 0 });                     // leased
    await due();
    expect(await run()).toMatchObject({ lost_in_flight: 1, summarized: 1 });
    const cs = await calls(tid);
    expect(cs.map(c => [c.status, c.error])).toEqual([['error', 'lost_in_flight'], ['ok', null]]);
    expect(Number(cs[0].cost_cents)).toBeCloseTo(worst, 3);
    expect(cs[0].response).toBeNull();
    expect(Number((await tr(tid)).llm_cost_cents)).toBeCloseTo(worst + ai.computeCostCents(900, 400, 'claude-sonnet-5-5'), 3);
    expect(await qrow(tid)).toMatchObject({ state: 'done', est_cents: null });
  });

  test('E6b a row past the attempt ceiling fails on claim — no further call', async () => {
    const { tid } = await item();
    await run();                                                          // creates the queue row (summarized)
    await q("UPDATE comms_transcripts SET state = 'transcribed', summary = NULL, summary_text = NULL WHERE id = ?", [tid]);
    await q("UPDATE comms_summaries SET state = 'calling', attempts = 3, est_cents = 1, next_attempt_at = NULL WHERE transcript_id = ?", [tid]);
    await q('DELETE FROM ai_calls WHERE consumer_ref = ?', [`comms_transcript:${tid}`]);   // the lost call was never logged
    const before = api.bodies.length;
    expect(await run()).toMatchObject({ calls: 0, failed: 1, lost_in_flight: 1 });
    expect(api.bodies.length).toBe(before);
    expect(await qrow(tid)).toMatchObject({ state: 'failed', last_error: 'attempts_exhausted' });
  });

  test('E6c a crash AFTER the call was logged: on reclaim its real ai_calls row is the spend — no synthetic double charge', async () => {
    const { tid } = await item();
    let broke = false;
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (!broke && /SET ai_call_ids/.test(sql)) { broke = true; throw new Error('process died after the call'); }
        return pool.query(sql, p);
      },
    };
    await expect(run(db)).rejects.toThrow(/after the call/);
    await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    expect((await qrow(tid)).state).toBe('calling');
    await q('UPDATE comms_summaries SET next_attempt_at = UTC_TIMESTAMP() WHERE transcript_id = ?', [tid]);   // the lease has run out
    const r = await run();
    expect(r).toMatchObject({ recovered_in_flight: 1, summarized: 1 });
    expect(r.lost_in_flight).toBeUndefined();
    const cs = await calls(tid);
    expect(cs.map(c => c.error)).toEqual([null, null]);                    // two real calls, no synthetic row
    expect(Number((await tr(tid)).llm_cost_cents)).toBeCloseTo(2 * ai.computeCostCents(900, 400, 'claude-sonnet-5-5'), 4);
  });

  test('E6d a failure BEFORE the write-ahead (the context lookup) reserves and charges nothing', async () => {
    const { tid } = await item();
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (/FROM contact_phones/.test(sql)) throw new Error('lookup failed');
        return pool.query(sql, p);
      },
    };
    await expect(run(db)).rejects.toThrow(/lookup failed/);
    await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    expect(await qrow(tid)).toMatchObject({ state: 'pending', est_cents: null });
    expect(await tx.monthToDateCents(pool)).toBe(0);
    expect(api.bodies.length).toBe(0);
    await due();
    expect(await run()).toMatchObject({ summarized: 1 });
    expect((await run()).lost_in_flight).toBeUndefined();
  });

  // Round 3: the reclaim's "seen" query. A lease is [next_attempt_at − leaseMin, next_attempt_at]; only a REAL row in it counts.
  const reclaimable = async (tid, { nextAgoMin = 1, callAgoMin, code } = {}) => {
    await run();                                                          // one real call, logged
    await q("UPDATE comms_transcripts SET state = 'transcribed', summary = NULL, summary_text = NULL WHERE id = ?", [tid]);
    await q(`UPDATE comms_summaries SET state = 'calling', attempts = 1, est_cents = 1,
               next_attempt_at = ${nextAgoMin === null ? 'NULL' : 'UTC_TIMESTAMP() - INTERVAL ? MINUTE'} WHERE transcript_id = ?`,
      nextAgoMin === null ? [tid] : [nextAgoMin, tid]);
    await q(`UPDATE ai_calls SET created_at = UTC_TIMESTAMP() - INTERVAL ? MINUTE${code ? ", status = 'error', error = ?" : ''} WHERE consumer_ref = ?`,
      code ? [callAgoMin, code, `comms_transcript:${tid}`] : [callAgoMin, `comms_transcript:${tid}`]);
  };

  test('E6e two lost calls in a row are two charges: the first one\'s synthetic row inside the second lease is not "seen"', async () => {
    const { tid } = await item();
    const expire = () => q('UPDATE comms_summaries SET next_attempt_at = UTC_TIMESTAMP() WHERE transcript_id = ?', [tid]);
    const spy = jest.spyOn(ai, 'call').mockImplementation(async () => { throw new Error('process died'); });
    try {
      await expect(run()).rejects.toThrow(/process died/);
      await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
      await expire();
      await expect(run()).rejects.toThrow(/process died/);               // charges lost #1 inside its own new lease, then dies again
      await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    } finally { spy.mockRestore(); }
    await expire();
    expect(await run()).toMatchObject({ lost_in_flight: 1, summarized: 1 });
    expect((await calls(tid)).map(c => [c.status, c.error])).toEqual([['error', 'lost_in_flight'], ['error', 'lost_in_flight'], ['ok', null]]);
  });

  test.each(['lost_in_flight', 'timeout_charged'])('E6f a synthetic %s row inside the lease is not a real call: still charged', async (code) => {
    const { tid } = await item();
    await reclaimable(tid, { nextAgoMin: 1, callAgoMin: 5, code });
    const r = await run();
    expect(r).toMatchObject({ lost_in_flight: 1, summarized: 1 });
    expect(r.recovered_in_flight).toBeUndefined();
  });

  test('E6g an OLDER real call, outside the lease, does not hide a lost one (aged together: lease ended 1 min ago, call 40 min ago)', async () => {
    const { tid } = await item();
    await reclaimable(tid, { nextAgoMin: 1, callAgoMin: 40 });
    const r = await run();
    expect(r).toMatchObject({ lost_in_flight: 1, summarized: 1 });
    expect(r.recovered_in_flight).toBeUndefined();
  });

  test('E6h a real call INSIDE the lease (10 min before its end, after its start) is the spend: recovered, no charge', async () => {
    const { tid } = await item();
    await reclaimable(tid, { nextAgoMin: 1, callAgoMin: 10 });
    const r = await run();
    expect(r).toMatchObject({ recovered_in_flight: 1, summarized: 1 });
    expect(r.lost_in_flight).toBeUndefined();
  });

  test('E6i a calling row with NO next_attempt_at (an operator "retry now") is charged, even beside a fresh real call', async () => {
    const { tid } = await item();
    await reclaimable(tid, { nextAgoMin: null, callAgoMin: 0 });
    const r = await run();
    expect(r).toMatchObject({ lost_in_flight: 1, summarized: 1 });
    expect(r.recovered_in_flight).toBeUndefined();
  });

  test('E7 the last look before the call: restricted or purged in between → nothing sent', async () => {
    const { tid, mid } = await item();
    let flip = 'restrict';
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (flip && /FROM contact_phones/.test(sql)) {
          if (flip === 'restrict') await admin.setRestricted(pool, mid, true);
          else await admin.purge(pool, mid, { userId: 1, reason: 'between' });
          flip = null;
        }
        return pool.query(sql, p);
      },
    };
    expect(await run(db)).toMatchObject({ calls: 0, skipped_restricted: 1 });
    expect(await qrow(tid)).toMatchObject({ state: 'skipped', skip_reason: 'restricted', est_cents: null });
    const b = await item();
    flip = 'purge';
    const db2 = { ...db };
    db2.query = async (sql, p) => {
      if (flip && /FROM contact_phones/.test(sql)) { flip = null; await admin.purge(pool, b.mid, { userId: 1, reason: 'between' }); }
      return pool.query(sql, p);
    };
    expect(await run(db2)).toMatchObject({ calls: 0 });
    expect(await qrow(b.tid)).toMatchObject({ state: 'skipped', skip_reason: 'purged' });
    expect(api.bodies.length).toBe(0);
  });

  // ═══ P ════════════════════════════════════════════════════════════════════
  test('P1 purge clears the text of EVERY attempt (incl. the stricter retry); cost stays', async () => {
    const { tid, mid } = await item();
    api.queue.push(reply('not json'), reply(JSON.stringify(GOOD)));
    await run();
    const before = await tr(tid);
    const r = await admin.purge(pool, mid, { userId: 1, reason: 'private' });
    expect(r.parts.transcripts).toMatchObject({ rows: 1, ai_calls: 2 });
    for (const c of await calls(tid)) {
      expect(c).toMatchObject({ request_excerpt: null, response: null });
      expect(Number(c.cost_cents)).toBeGreaterThan(0);
    }
    const after = await tr(tid);
    expect(after).toMatchObject({ state: 'purged', summary: null, summary_text: null, segments: null, full_text: null });
    expect(after.llm_cost_cents).toEqual(before.llm_cost_cents);
  });

  test('P2 a purge landing DURING the call (aiService logs after it): the late ai_calls row is cleared, nothing written', async () => {
    const { tid, mid } = await item();
    api.before = async () => { api.before = null; await admin.purge(pool, mid, { userId: 1, reason: 'mid-call' }); };
    expect(await run()).toMatchObject({ fenced: 1, summarized: 0, ai_calls_cleared: 1 });
    const [c] = await calls(tid);
    expect(c).toMatchObject({ request_excerpt: null, response: null });
    expect(await tr(tid)).toMatchObject({ state: 'purged', summary: null, summary_text: null });
    expect(await qrow(tid)).toMatchObject({ state: 'skipped', skip_reason: 'purged' });
  });

  test('P2b a purge mid-call, then the cost write fails (the process dies): the next tick clears the late ai_calls row', async () => {
    const { tid, mid } = await item();
    api.before = async () => { api.before = null; await admin.purge(pool, mid, { userId: 1, reason: 'mid-call' }); };
    let broke = false;
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (!broke && /SET ai_call_ids/.test(sql)) { broke = true; throw new Error('connection lost'); }
        return pool.query(sql, p);
      },
    };
    await expect(run(db)).rejects.toThrow(/connection lost/);
    const [late] = await calls(tid);
    expect(late.response).toMatch(/^\[omitted/);                       // logged after the purge cleared
    await pool.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`).catch(() => {});
    await due();
    await run();
    for (const c of await calls(tid)) expect(c).toMatchObject({ request_excerpt: null, response: null });
    expect(await qrow(tid)).toMatchObject({ state: 'skipped', skip_reason: 'purged' });
  });

  test('P3 a purge between the validation and the UPDATE: the fence holds, its ai_calls cleared', async () => {
    const { tid, mid } = await item();
    let fired = false;
    const db = {
      getConnection: () => pool.getConnection(),
      async query(sql, p) {
        if (!fired && /SET state = 'summarized'/.test(sql)) { fired = true; await admin.purge(pool, mid, { userId: 1, reason: 'race' }); }
        return pool.query(sql, p);
      },
    };
    expect(await run(db)).toMatchObject({ fenced: 1, summarized: 0 });
    expect(fired).toBe(true);
    expect(await tr(tid)).toMatchObject({ state: 'purged', summary: null, summary_text: null });
    const [c] = await calls(tid);
    expect(c.response).toBeNull();
  });

  // ═══ T ════════════════════════════════════════════════════════════════════
  test('T1 pacing: at most callsPerTick calls; none started after the deadline', async () => {
    for (let i = 0; i < 5; i++) await item();
    expect((await run()).calls).toBe(3);
    sweep.limits.startDeadlineMs = -1;
    expect((await run()).calls).toBe(0);
  });

  test('T2 the tick lock', async () => {
    const conn = await pool.getConnection();
    try {
      await conn.query(`SELECT GET_LOCK(${sweep.LOCK_EXPR}, 0)`);
      expect(await run()).toMatchObject({ skipped: 'locked' });
    } finally {
      await conn.query(`SELECT RELEASE_LOCK(${sweep.LOCK_EXPR})`);
      conn.release();
    }
  });
});
