/**
 * REAL-ENGINE suite for comms archive S6 — transcript search
 * (POST /api/comms-archive/search, services/commsArchiveSearch.js) on MySQL
 * with the production schema and sql_mode. S2's tables come from S2's own
 * migration runner; transcripts are written with S2's segment helpers, the
 * way its sweep writes them.
 *   G   the GRANT MATRIX — SU / attorney / granted / listed archive admin (SS)
 *       / ungranted × a recording, a restricted one, a Quo voicemail on
 *       another line, a line-less RC voicemail, a line the grantee can't read,
 *       a purged row, every non-readable state, a suppressed event, a row on
 *       the wrong line. Ungranted lines NEVER appear (design §12 done-when);
 *       a restricted row's text never surfaces, even as the only match.
 *   Q   query building — operators can't reach the parser; stopwords and
 *       short words dropped (the engine returns NOTHING for a required one —
 *       pinned here); prefix + AND; 400 with nothing usable.
 *   P   newest first, keyset paging; snippets; audit (never the words); rate
 *       limit; EXPLAIN (the exact statement uses the FULLTEXT index).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s6_test npx jest tests/commsArchive.s6.mysql.test.js --runInBand
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'comms-s6-test-secret';
process.env.INTERNAL_API_KEY = 'yci_comms_s6_internal';

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['phone_lines', 'phone_event_log', 'users', 'app_settings', 'scheduled_jobs', 'admin_audit_log',
  'jwt_api_audit_log', 'channel_grants', 'system_alerts', 'alert_state'];
const S2_TABLES = ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe'];
const P = '3135550001';
const L1 = '2485592400', L4 = '2486213656', L6 = '2484179800';
const U = { SS: 1, ATT: 2, GRANTED: 3, NOBODY: 4, SU: 6 };

maybe('comms archive S6 transcript search on real MySQL', () => {
  const mysql   = require('mysql2/promise');
  const express = require('express');
  const jwt     = require('jsonwebtoken');
  const schema  = require('./helpers/commsArchiveSchema');
  const vendor  = require('../services/commsTranscribeVendor');
  const searchSvc = require('../services/commsArchiveSearch');
  const archiveRouter = require('../routes/api.commsArchive');

  let pool, server, base;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const tok = (user, roles = []) =>
    jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
  const T = {
    su: () => tok(U.SU, ['su']), att: () => tok(U.ATT, ['staff', 'attorney']), granted: () => tok(U.GRANTED, ['staff']),
    nobody: () => tok(U.NOBODY, ['staff']), ss: () => tok(U.SS, ['staff']),
  };
  async function find(body, who = T.su, { apiKey } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (who && !apiKey) headers.Authorization = `Bearer ${who()}`;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(`${base}/api/comms-archive/search`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  async function postAt(path, body, who = T.su) {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who()}` }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  const ids = (r) => (r.json.results || []).map(x => x.media_id).sort((a, b) => a - b);
  const audits = () => q("SELECT status, user_id, route, details, error_message FROM admin_audit_log WHERE tool = 'comms_archive' ORDER BY id");

  // ── fixtures ────────────────────────────────────────────────────────────
  const T0 = Date.parse('2026-10-01T15:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const sqlT = (ms) => iso(ms).slice(0, 19).replace('T', ' ');
  let nextId = 100;
  async function ev({ line = L1, at = T0, dur = 60, provider = 'ringcentral' } = {}) {
    const id = ++nextId;
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number,
               other_party, suppressed, raw_extra, processed_at)
             VALUES (?, ?, ?, 'call', 'incoming', ?, ?, ?, 0, ?, ?)`,
      [id, provider, `R${id}`, P, line, P, JSON.stringify({ line, started_at: iso(at), ended_at: iso(at + dur * 1000) }), sqlT(at + dur * 1000)]);
    return id;
  }
  async function media({ kind = 'call_recording', source_table = 'phone_event_log', source_id, part = 'x', channel_id = 1, state = 'archived', restricted = 0, at = T0 }) {
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state, restricted, object_name, mime)
       VALUES ('phone', ?, ?, ?, ?, 'ringcentral', ?, ?, ?, ?, ?, ?, 'audio/mpeg')`,
      [kind, source_table, source_id, part, channel_id, P, sqlT(at), state, restricted, `phone/t/${source_id}-${part}.mp3`]);
    return r.insertId;
  }
  /** Write a transcript as S2's sweep does: its segment helpers over an AssemblyAI-shaped JSON, its completion UPDATE. */
  async function transcript(mediaId, eventId, utterances, { state = 'transcribed', summary = null } = {}) {
    const json = { status: 'completed', text: utterances.map(u => u[1]).join(' '), multichannel: false, language_code: 'en_us',
      utterances: utterances.map(([s, t], i) => ({ speaker: s, start: i * 5000, end: i * 5000 + 4000, text: t })) };
    const segs = vendor.segmentsFromVendorJson(json);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state) VALUES (?, ?, 'transcribing')`, [mediaId, eventId]);
    await q(`UPDATE comms_transcripts SET state = ?, stt_vendor = 'assemblyai', segments = ?, full_text = ?, summary_text = ?, transcribed_at = UTC_TIMESTAMP()
              WHERE media_id = ?`, [state, JSON.stringify(segs), vendor.fullTextOf(segs, json), summary, mediaId]);
  }
  async function rec(text, { line = L1, lineId = 1, channel_id, at, restricted = 0, state, provider } = {}) {
    const e = await ev({ line, at, provider });
    const m = await media({ source_id: e, channel_id: channel_id === undefined ? lineId : channel_id, restricted, at });
    await transcript(m, e, [['A', text]], { state });
    return { e, m };
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 8, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
    for (const t of S2_TABLES) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await schema.build(pool, TABLES);
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

  let S;
  beforeEach(async () => {
    archiveRouter._resetSearchLimit();
    for (const t of ['comms_media', 'comms_transcripts', 'phone_event_log', 'phone_lines', 'users', 'admin_audit_log', 'jwt_api_audit_log', 'channel_grants']) {
      await pool.query(`TRUNCATE TABLE \`${t}\``);
    }
    await q(`INSERT INTO phone_lines (id, phone_number, provider, active, provider_id, credential_id) VALUES
      (1, ?, 'ringcentral', 1, NULL, 9), (4, ?, 'ringcentral', 1, NULL, 9), (6, ?, 'quo', 1, 'PNb', 10)`, [L1, L4, L6]);
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, roles, ringcentral) VALUES
      (1, 'ss', 'SS', 'S', 'S', 'SS', 'authorized', 'staff', 0), (2, 'att', 'Att', 'A', 'T', 'AT', 'authorized', 'staff,attorney', 0),
      (3, 'grant', 'Granted', 'G', 'R', 'GR', 'authorized', 'staff', 0), (4, 'nobody', 'Nobody', 'N', 'B', 'NB', 'authorized', 'staff', 0),
      (6, 'su', 'Fred', 'F', 'S', 'FS', 'authorized', 'it,admin,su', 0)`);
    await q(`INSERT INTO channel_grants (id, user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES
      (1, 3, 'phone_line', 1, 1, 0, 0, 6), (2, 1, 'phone_line', 1, 1, 0, 0, 6)`);
    await q("UPDATE app_settings SET `value` = '1' WHERE `key` = 'comms_archive_admins'");

    S = {};
    S.rec1 = await rec('We went over the bankruptcy filing and the paystubs you sent', { at: T0 });
    S.recR = await rec('A private bankruptcy settlement we must keep quiet', { at: T0 + 60_000, restricted: 1 });
    S.rec4 = await rec('Line four bankruptcy questions', { line: L4, lineId: 4, at: T0 + 120_000 });
    const qc = await ev({ line: L6, at: T0 + 180_000, provider: 'quo' });
    S.quoVm = await media({ kind: 'voicemail', source_id: qc, part: 'VMq', channel_id: 6, at: T0 + 180_000 });
    await transcript(S.quoVm, qc, [['A', 'Please call back about the trustee meeting and my bankruptcy']]);
    S.quoCall = qc;
    S.rcVm = await media({ kind: 'voicemail', source_table: 'rc_message', source_id: 99001, part: '99001', channel_id: null, at: T0 + 240_000 });
    await transcript(S.rcVm, null, [['A', 'A bankruptcy question left on no particular line']]);
    // never readable:
    S.purged = (await rec('bankruptcy purged words', { at: T0 + 300_000, state: 'purged' })).m;
    for (const st of ['pending', 'transcribing', 'skipped', 'failed']) S[st] = (await rec(`bankruptcy ${st} words`, { at: T0 + 310_000, state: st })).m;
    const sup = await rec('bankruptcy suppressed spam', { at: T0 + 320_000 });
    await q('UPDATE phone_event_log SET suppressed = 1 WHERE id = ?', [sup.e]);
    S.suppressed = sup.m;
    S.mismatch = (await rec('bankruptcy on the wrong line', { at: T0 + 330_000, channel_id: 4 })).m;   // a line-1 event, stored line 4
    S.notArchived = (await rec('bankruptcy not archived', { at: T0 + 340_000 })).m;
    await q("UPDATE comms_media SET state = 'gone' WHERE id = ?", [S.notArchived]);
  });

  // ── G — grants ──────────────────────────────────────────────────────────
  test('G1 the grant matrix: each viewer finds exactly what they may read — never a purged / unreadable-state / suppressed / wrong-line / unarchived row', async () => {
    const want = {
      su:      [S.rec1.m, S.recR.m, S.rec4.m, S.quoVm, S.rcVm],
      att:     [S.rec1.m, S.rec4.m, S.quoVm, S.rcVm],
      granted: [S.rec1.m],
      ss:      [S.rec1.m, S.recR.m],
      nobody:  [],
    };
    for (const [who, list] of Object.entries(want)) {
      const r = await find({ q: 'bankruptcy' }, T[who]);
      expect([who, r.status, ids(r)]).toEqual([who, 200, [...list].sort((a, b) => a - b)]);
    }
  });

  test('G2 line_id scopes to ONE readable line (the line-less voicemail is then out); an unreadable line is a 404; "all" = no filter', async () => {
    expect(ids(await find({ q: 'bankruptcy', line_id: 6 }))).toEqual([S.quoVm]);
    expect(ids(await find({ q: 'bankruptcy', line_id: '1' }))).toEqual([S.rec1.m, S.recR.m].sort((a, b) => a - b));
    const no = await find({ q: 'bankruptcy', line_id: 6 }, T.granted);
    expect(no).toEqual({ status: 404, json: { status: 'error', message: 'Phone line not found' } });
    expect(ids(await find({ q: 'bankruptcy', line_id: 'all' }, T.granted))).toEqual([S.rec1.m]);
  });

  test('G3 a restricted row is invisible to a non-admin even as the ONLY match: an empty result, not a hint', async () => {
    for (const who of ['att', 'granted']) {
      const r = await find({ q: 'settlement' }, T[who]);
      expect([who, r.status, r.json.results, r.json.next_cursor]).toEqual([who, 200, [], null]);
      expect(JSON.stringify(r.json)).not.toMatch(/quiet|private|settlement we/);
    }
    const ss = await find({ q: 'settlement' }, T.ss);
    expect(ss.json.results.map(x => [x.media_id, x.restricted])).toEqual([[S.recR.m, true]]);
  });

  test('G4 nothing readable at all: no transcript SQL runs; an API key is refused', async () => {
    const seen = [];
    const orig = pool.query.bind(pool);
    pool.query = (sql, p) => { seen.push(String(sql)); return orig(sql, p); };
    try {
      expect((await find({ q: 'bankruptcy' }, T.nobody)).json.results).toEqual([]);
    } finally { pool.query = orig; }
    expect(seen.filter(s => /comms_transcripts/.test(s))).toEqual([]);
    expect((await find({ q: 'bankruptcy' }, null, { apiKey: process.env.INTERNAL_API_KEY })).status).toBe(403);
  });

  test('G5 result fields: event_id is the call for a recording / Quo voicemail and NULL for an RC voicemail (source_table says why)', async () => {
    const by = new Map((await find({ q: 'bankruptcy' })).json.results.map(x => [x.media_id, x]));
    expect(by.get(S.rec1.m)).toMatchObject({ event_id: S.rec1.e, source_table: 'phone_event_log', line_id: 1, party: P, kind: 'call_recording', restricted: false });
    expect(by.get(S.quoVm)).toMatchObject({ event_id: S.quoCall, line_id: 6, kind: 'voicemail' });
    expect(by.get(S.rcVm)).toMatchObject({ event_id: null, source_table: 'rc_message', line_id: null, kind: 'voicemail' });
    expect(by.get(S.rec1.m).captured_at).toBe(iso(T0));
  });

  test('G6 an event on a number that is not a phone line (channel_id NULL, the <=> rule): SU / attorney see it, a grantee never; not under line_id', async () => {
    const e = await ev({ line: '2480000009' });
    const m = await media({ source_id: e, channel_id: null, at: T0 + 700_000 });
    await transcript(m, e, [['A', 'orphaned zeppelin words']]);
    expect(ids(await find({ q: 'zeppelin' }))).toEqual([m]);
    expect(ids(await find({ q: 'zeppelin' }, T.att))).toEqual([m]);
    expect(ids(await find({ q: 'zeppelin' }, T.granted))).toEqual([]);
    expect(ids(await find({ q: 'zeppelin' }, T.ss))).toEqual([]);
    expect(ids(await find({ q: 'zeppelin', line_id: 1 }))).toEqual([]);
  });

  test('G7 only PHONE call recordings / voicemails are searched — a mail item whose channel_id collides with a line id never is', async () => {
    const [r] = await pool.query(
      `INSERT INTO comms_media (channel, kind, source_table, source_id, part, channel_id, party, captured_at, state, object_name, mime)
       VALUES ('mail', 'mail_raw', 'mail_messages', 77, 'eml', 1, NULL, ?, 'archived', 'mail/eml/77.eml', 'message/rfc822')`, [sqlT(T0 + 800_000)]);
    await q(`INSERT INTO comms_transcripts (media_id, phone_event_id, state, segments, full_text) VALUES (?, NULL, 'transcribed', '[]', 'mailbox quokka text')`, [r.insertId]);
    expect(ids(await find({ q: 'quokka' }))).toEqual([]);
    expect(ids(await find({ q: 'quokka' }, T.granted))).toEqual([]);
  });

  test('G8 the snippet read re-checks the row (review A1): restricted or re-queued between the match and the read → dropped, no text', async () => {
    for (const [label, change] of [['restricted', "UPDATE comms_media SET restricted = 1 WHERE id = ?"], ['re-queued', "UPDATE comms_transcripts SET state = 'transcribing' WHERE media_id = ?"]]) {
      const orig = pool.query.bind(pool);
      pool.query = async (sql, p) => {
        const res = await orig(sql, p);
        if (/MATCH\(t\.full_text/.test(String(sql))) await orig(change, [S.rec1.m]);
        return res;
      };
      let r;
      try { r = await find({ q: 'paystubs' }, T.granted); } finally { pool.query = orig; }
      expect([label, r.status, r.json.results]).toEqual([label, 200, []]);
      expect(JSON.stringify(r.json)).not.toMatch(/paystubs you sent/);
      await q("UPDATE comms_media SET restricted = 0 WHERE id = ?", [S.rec1.m]);
      await q("UPDATE comms_transcripts SET state = 'transcribed' WHERE media_id = ?", [S.rec1.m]);
    }
  });

  // ── Q — query building ──────────────────────────────────────────────────
  test('Q1 operators never reach the parser: a hostile query is read as plain words (AND of prefixes), no error', async () => {
    const r = await find({ q: `+bankrupt* -paystubs "filing" (x) ~y @z <a >b & | : ' OR 1=1 -- ;` });
    expect(r.status).toBe(200);
    expect(r.json.terms).toEqual(['bankrupt', 'paystubs', 'filing']);
    expect(ids(r)).toEqual([S.rec1.m]);                                   // "-paystubs" did NOT exclude: it is a required word
  });

  test('Q2 InnoDB returns NOTHING for a required stopword or short term — so the tokenizer drops them (and says so)', async () => {
    // the engine fact, pinned (MySQL 8.4, default stopwords, min token 3)
    const n = async (against) => (await q('SELECT COUNT(*) AS n FROM comms_transcripts WHERE MATCH(full_text, summary_text) AGAINST(? IN BOOLEAN MODE)', [against]))[0].n;
    expect(await n('+bankrupt*')).toBeGreaterThan(0);
    expect(await n('+the* +bankrupt*')).toBe(0);
    expect(await n('+about* +trustee*')).toBe(0);
    expect(await n('+to* +bankrupt*')).toBe(0);
    // the route
    const r = await find({ q: 'the bankruptcy to me about' });
    expect([r.json.terms, r.json.ignored]).toEqual([['bankruptcy'], ['the', 'to', 'me', 'about']]);
    expect(ids(r).length).toBe(5);
    const bad = await find({ q: 'to be or of' });
    expect(bad).toEqual({ status: 400, json: { status: 'error', message: 'A search needs a word of 3 or more letters', terms: [], ignored: ['to', 'be', 'or', 'of'] } });
    expect((await find({ q: '   ' })).status).toBe(400);
    expect((await find({ q: 'x'.repeat(201) })).status).toBe(400);
  });

  test('Q3 prefix and AND: "bank" finds bankruptcy; two words must both occur; a digit run matches', async () => {
    expect(ids(await find({ q: 'bank' })).length).toBe(5);
    expect(ids(await find({ q: 'bank paystub' }))).toEqual([S.rec1.m]);
    expect(ids(await find({ q: 'trustee bankrupt' }))).toEqual([S.quoVm]);
    const c = await rec('Your case 26-12345 was filed', { at: T0 + 400_000 });
    expect(ids(await find({ q: '26-12345' }))).toEqual([c.m]);
  });

  // ── P — paging, snippets, audit, limits, plan ───────────────────────────
  test('P1 newest first; keyset paging reaches every result once; a bad cursor is a 400', async () => {
    const all = (await find({ q: 'bankruptcy' })).json.results.map(x => x.media_id);
    expect(all).toEqual([S.rcVm, S.quoVm, S.rec4.m, S.recR.m, S.rec1.m]);
    const seen = [];
    let cursor = null;
    do {
      const r = (await find({ q: 'bankruptcy', limit: 2, cursor })).json;
      expect(r.results.length).toBeLessThanOrEqual(2);
      seen.push(...r.results.map(x => x.media_id));
      cursor = r.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all);
    expect((await find({ q: 'bankruptcy', cursor: 'nope' })).status).toBe(400);
  });

  test('P1b a crafted cursor past year 9999 is a 400, never a 500 (review F1)', async () => {
    expect((await find({ q: 'bankruptcy', cursor: '253402300800000.5' })).status).toBe(400);
    expect((await find({ q: 'bankruptcy', cursor: '999999999999999.1' })).status).toBe(400);
    expect((await find({ q: 'bankruptcy', cursor: '253402300799999.5' })).status).toBe(200);
  });

  test('P1c rows sharing one captured_at second page by id: limit 1 and limit 2 each see every row exactly once (review F2)', async () => {
    const same = [];
    for (let i = 0; i < 5; i++) same.push((await rec(`simultaneous walrus ${i}`, { at: T0 + 900_000 })).m);
    for (const limit of [1, 2]) {
      const seen = [];
      let cursor = null;
      let guard = 0;
      do {
        const r = (await find({ q: 'walrus', limit, cursor })).json;
        seen.push(...r.results.map(x => x.media_id));
        cursor = r.next_cursor;
      } while (cursor && ++guard < 20);
      expect([limit, seen]).toEqual([limit, [...same].sort((a, b) => b - a)]);
    }
  });

  test('P2 snippets: the segment holding the word (with its second), clipped around it; else the summary; never the whole transcript', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const e = await ev({ at: T0 + 500_000 });
    const m = await media({ source_id: e, at: T0 + 500_000 });
    await transcript(m, e, [['A', 'Hello, this is the firm.'], ['B', `${long} adjournment ${long}`], ['A', 'Thanks.']], { summary: 'Client asked about a continuance.' });
    const hit = (await find({ q: 'adjournment' })).json.results[0];
    expect(hit).toMatchObject({ media_id: m, snippet_at: 5, snippet_from: 'transcript' });
    expect(hit.snippet).toContain('adjournment');
    expect(hit.snippet.length).toBeLessThanOrEqual(searchSvc.SNIPPET_CHARS + 2);
    expect(hit.snippet.startsWith('…') && hit.snippet.endsWith('…')).toBe(true);
    const sum = (await find({ q: 'continuance' })).json.results[0];
    expect(sum).toMatchObject({ media_id: m, snippet: 'Client asked about a continuance.', snippet_at: null, snippet_from: 'summary' });
    const short = (await find({ q: 'paystubs' })).json.results[0];
    expect(short.snippet).toBe('We went over the bankruptcy filing and the paystubs you sent');
  });

  test('P3 audit: one row per search with counts + the media ids returned — the words appear in NO admin_audit_log row, nor its route', async () => {
    await find({ q: 'bankruptcy paystubs' }, T.granted);
    await find({ q: 'zz qq' }, T.granted);                                 // 400
    await find({ q: 'bankruptcy', line_id: 6 }, T.granted);                // 404
    const a = await audits();
    expect(a.map(x => [x.status, x.details])).toEqual([
      ['success', { action: 'search', terms: 2, results: 1, media_ids: [S.rec1.m] }],
      ['rejected_bad_request', { action: 'search', terms: 0 }],
      ['rejected_no_grant', { action: 'search' }],
    ]);
    for (const x of a) expect(x.route).toBe('/api/comms-archive/search');
    const all = JSON.stringify(await q('SELECT * FROM admin_audit_log'));
    expect(all).not.toMatch(/bankrupt|paystub|zz qq/i);
  });

  test('P3b the audit route is stored without any query string (review M16)', async () => {
    expect((await postAt('/api/comms-archive/search?q=bankruptcy&x=1', { q: 'bankruptcy' }, T.granted)).status).toBe(200);
    const [a] = await audits();
    expect(a.route).toBe('/api/comms-archive/search');
  });

  test('P4 per-user rate limit → 429, audited; bad line_id → 400', async () => {
    archiveRouter._resetSearchLimit(2);
    expect((await find({ q: 'bankruptcy' })).status).toBe(200);
    expect((await find({ q: 'bankruptcy' })).status).toBe(200);
    expect((await find({ q: 'bankruptcy' })).status).toBe(429);
    expect((await find({ q: 'bankruptcy' }, T.att)).status).toBe(200);    // per user
    expect((await audits()).map(x => x.status)).toContain('rejected_rate_limited');
    archiveRouter._resetSearchLimit();
    expect((await find({ q: 'bankruptcy', line_id: 'x1' })).status).toBe(400);
  });

  test('P5 the plan: the statement the route sends uses the FULLTEXT index (type fulltext, ft_comms_transcripts)', async () => {
    for (let i = 0; i < 150; i++) await rec(`filler call number ${i} about paperwork`, { at: T0 + 600_000 + i * 1000 });
    const caught = [];
    const orig = pool.query.bind(pool);
    pool.query = (sql, p) => { if (/MATCH\(t\.full_text/.test(String(sql))) caught.push([String(sql), p]); return orig(sql, p); };
    try { await find({ q: 'bankruptcy' }); } finally { pool.query = orig; }
    expect(caught).toHaveLength(1);
    const plan = await q(`EXPLAIN ${caught[0][0]}`, caught[0][1]);
    const t = plan.find(r => r.table === 't');
    expect([t.type, t.key]).toEqual(['fulltext', 'ft_comms_transcripts']);
  });
});
