// Casey v2 S2 — the chat store on a REAL MySQL 8.4 (own *_test DB; gated on
// YC_TEST_MYSQL_URL, skipped otherwise):
//
//   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3379/yc_casey_chats_test \
//     npx jest tests/caseyChats.mysql.test.js --runInBand
//
// Proves scripts/caseyV2ChatsMigrate.js (CHECK → --apply → re-run, and a
// NO-GO on a misshapen table), services/casey/chats.js against the real
// tables (user scoping, seq from the INSERT, JSON round-trip of thinking
// signatures and tool inputs compared PARSED, the one-winner claim and its
// staleness, cascade delete, the list), and ONE whole turn of the loop with
// the real store and a scripted model over the real tools, replayed by a
// second turn. Own DB: this twin drops and rebuilds the two tables.
'use strict';

const mysql = require('mysql2/promise');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-chats-twin-secret';

const migrate = require('../scripts/caseyV2ChatsMigrate');
const chats = require('../services/casey/chats');
const loop = require('../services/casey/loop');
const tools = require('../services/casey/tools');
const prompt = require('../lib/caseyPrompt');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

suite('casey chats — real engine', () => {
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const lines = [];
  const say = (l) => lines.push(l);

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    await q('DROP TABLE IF EXISTS casey_messages');
    await q('DROP TABLE IF EXISTS casey_chats');
  });
  afterAll(async () => { await conn.end(); await pool.end(); });
  beforeEach(() => { lines.length = 0; });

  test('migration: CHECK on an empty DB, --apply creates both and verifies, a re-run is ALREADY IN PLACE, a drift is NO-GO', async () => {
    const c = await migrate.run(conn, { apply: false, say });
    expect(c).toEqual({ ok: true, line: 'CHECK OK — GO. Next: node scripts/caseyV2ChatsMigrate.js --apply', applied: false });
    expect((await q('SHOW TABLES LIKE \'casey_%\'')).length).toBe(0);
    const a = await migrate.run(conn, { apply: true, say });
    expect(a).toMatchObject({ ok: true, applied: true });
    expect(a.line).toMatch(/^APPLIED — casey_chats and casey_messages verified\. GO/);
    expect(lines.filter((l) => /✓ created/.test(l))).toEqual(['  ✓ created casey_chats', '  ✓ created casey_messages']);
    const again = await migrate.run(conn, { apply: true, say });
    expect(again).toMatchObject({ ok: true, applied: false });
    expect(again.line).toMatch(/^ALREADY IN PLACE/);
    // A drift (a column added by hand) is a NO-GO in CHECK and in --apply; nothing is touched.
    await q('ALTER TABLE casey_chats ADD COLUMN stray int NULL');
    const drift = await migrate.run(conn, { apply: true, say });
    expect(drift.ok).toBe(false);
    expect(lines.some((l) => /casey_chats columns are \(.*stray/.test(l))).toBe(true);
    await q('ALTER TABLE casey_chats DROP COLUMN stray');
    expect((await migrate.run(conn, { apply: false, say })).ok).toBe(true);
    // The state read: FK with CASCADE, the unique seq key, JSON columns.
    const st = await migrate.state(conn);
    expect(st.problems).toEqual([]);
    expect(st.tables.casey_messages.exists).toBe(true);
  });

  test('createChat / getChat / listChats / deleteChat are scoped by user; title normalised and cut', async () => {
    const id = await chats.createChat(pool, { userId: 6, text: '  How   many\n\ncontacts? ' + 'x'.repeat(200), model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v2.0-deadbeef' });
    const mine = await chats.getChat(pool, id, 6);
    expect(mine).toMatchObject({ id: String(id), user_id: 6, model: 'claude-opus-5-5', effort: 'medium', prompt_version: 'v2.0-deadbeef', running_since: null });
    expect(mine.title).toBe(('How many contacts? ' + 'x'.repeat(200)).slice(0, 120));
    expect(mine.title.length).toBe(120);
    expect(await chats.getChat(pool, id, 7)).toBeNull();
    const other = await chats.createChat(pool, { userId: 7, text: 'theirs', model: 'claude-sonnet-5-5', effort: 'low', promptVersion: 'v2.0-deadbeef' });
    expect((await chats.listChats(pool, 6)).map((c) => Number(c.id))).toEqual([id]);
    expect((await chats.listChats(pool, 7)).map((c) => Number(c.id))).toEqual([other]);
    expect(await chats.deleteChat(pool, other, 6)).toBe(false);
    expect(await chats.deleteChat(pool, other, 7)).toBe(true);
    expect(await chats.getChat(pool, other, 7)).toBeNull();
  });

  test('appendMessage: seq 1..n from the INSERT; JSON round-trips (parsed); the unique key refuses a duplicate seq; loadMessages orders by seq', async () => {
    const id = await chats.createChat(pool, { userId: 6, text: 'json', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v2.0-deadbeef' });
    const user = [{ type: 'text', text: '[context]\nNow: x' }, { type: 'text', text: 'Ünïcode — “quotes” \\ slashes \u0000? no: \t tab' }];
    const asst = [
      { type: 'thinking', thinking: 'Let me look.', signature: 'EqQBCkYIBRgCKkD' + 'x'.repeat(300) },
      { type: 'redacted_thinking', data: 'OPAQUE==' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_01', name: 'sql_read', input: { sql: "SELECT COUNT(*) AS n FROM contacts WHERE contact_name LIKE '%O''Brien%' LIMIT 1", purpose: 'count' } },
    ];
    const res = [{ type: 'tool_result', tool_use_id: 'toolu_01', content: JSON.stringify({ ok: true, data: { rows: [{ n: 3, d: '2026-11-22T00:00:00.000Z' }] } }) }];
    const r1 = await chats.appendMessage(pool, id, 'user', user, { context: { user_id: 6, roles: ['su'] } });
    const r2 = await chats.appendMessage(pool, id, 'assistant', asst, { ai_call_id: 5, usage: { input_tokens: 1 }, cost_cents: 0.1234 });
    const r3 = await chats.appendMessage(pool, id, 'user', res, { tool_calls: [{ id: 'toolu_01', ok: true }] });
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    const rows = await chats.loadMessages(pool, id);
    expect(rows.map((r) => [Number(r.seq), r.role])).toEqual([[1, 'user'], [2, 'assistant'], [3, 'user']]);
    expect(rows[0].content).toEqual(user);
    expect(rows[1].content).toEqual(asst);
    expect(rows[2].content).toEqual(res);
    // BYTE-EXACT: content is JSON text in a utf8mb4_bin LONGTEXT, so the replay is the model's own bytes — a json
    // column would hand `{"path","grep","dir"}` back as `{"dir","grep","path"}` and 1.0 as 1 (S2 review).
    const ordered = [{ type: 'tool_use', id: 'toolu_02', name: 'read_source', input: { path: 'lib/x.js', grep: 'y', dir: 'lib', n: 1.0, big: 1e21, z: 'a', a: 'z' } }];
    const r4 = await chats.appendMessage(pool, id, 'assistant', ordered);
    const back = (await chats.loadMessages(pool, id)).find((m) => m.id === r4.id || Number(m.id) === r4.id);
    expect(JSON.stringify(back.content)).toBe(JSON.stringify(ordered));
    const [[raw]] = await pool.query('SELECT content FROM casey_messages WHERE id = ?', [r4.id]);
    expect(raw.content).toBe(JSON.stringify(ordered));
    expect(JSON.stringify(rows[1].content)).toBe(JSON.stringify(asst));
    await q('DELETE FROM casey_messages WHERE id = ?', [r4.id]);
    expect(rows[1].meta).toEqual({ ai_call_id: 5, usage: { input_tokens: 1 }, cost_cents: 0.1234 });
    expect(rows[0].meta.context.roles).toEqual(['su']);
    expect(typeof rows[1].content[0].signature).toBe('string');
    await expect(pool.query('INSERT INTO casey_messages (chat_id, seq, role, content) VALUES (?, 2, \'user\', \'[]\')', [id])).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(chats.appendMessage(pool, id, 'user', 'not an array')).rejects.toThrow(/block array/);
    expect(await chats.deleteMessages(pool, id, [r3.id])).toBe(1);
    expect((await chats.loadMessages(pool, id)).length).toBe(2);
    expect((await chats.appendMessage(pool, id, 'user', res)).seq).toBe(3);
    // seq is MAX+1, never a count: a hole in the middle is not refilled (a refill would re-order a replay).
    await q('DELETE FROM casey_messages WHERE chat_id = ? AND seq = 2', [id]);
    expect((await chats.appendMessage(pool, id, 'user', res)).seq).toBe(4);
    expect((await chats.loadMessages(pool, id)).map((r) => Number(r.seq))).toEqual([1, 3, 4]);
  });

  test('claimTurn: one winner of concurrent claims; a stale claim is free; releaseTurn clears and re-stamps; another user never claims', async () => {
    const id = await chats.createChat(pool, { userId: 6, text: 'claim', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v2.0-old' });
    const wins = await Promise.all([1, 2, 3, 4].map(() => chats.claimTurn(pool, id, 6)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await chats.claimTurn(pool, id, 7)).toBe(false);
    expect((await chats.getChat(pool, id, 6)).running_since).toBeInstanceOf(Date);
    expect(chats.CLAIM_STALE_MIN).toBe(15);   // longer than the longest turn (5 min budget + 120 s floors + the 64k retry), shorter than Cloud Run's 900 s
    await q('UPDATE casey_chats SET running_since = UTC_TIMESTAMP() - INTERVAL 16 MINUTE WHERE id = ?', [id]);
    expect(await chats.claimTurn(pool, id, 6)).toBe(true);
    await q('UPDATE casey_chats SET running_since = UTC_TIMESTAMP() - INTERVAL 14 MINUTE WHERE id = ?', [id]);
    expect(await chats.claimTurn(pool, id, 6)).toBe(false);
    await chats.releaseTurn(pool, id, { promptVersion: 'v2.0-new', thinkingFloorSeq: 4 });
    expect(await chats.getChat(pool, id, 6)).toMatchObject({ running_since: null, prompt_version: 'v2.0-new', thinking_floor_seq: 4 });
    expect(await chats.claimTurn(pool, id, 6)).toBe(true);
    await chats.releaseTurn(pool, id);
    expect((await chats.getChat(pool, id, 6))).toMatchObject({ prompt_version: 'v2.0-new', thinking_floor_seq: 4 });
    // The floor is only ever raised: GREATEST keeps 4 against 2, takes 7.
    await chats.releaseTurn(pool, id, { promptVersion: 'v2.0-new', thinkingFloorSeq: 2 });
    expect((await chats.getChat(pool, id, 6)).thinking_floor_seq).toBe(4);
    await chats.releaseTurn(pool, id, { promptVersion: 'v2.0-new', thinkingFloorSeq: 7 });
    expect((await chats.getChat(pool, id, 6)).thinking_floor_seq).toBe(7);
    // loadMessages strips thinking below the floor on assistant rows only; the rows themselves are untouched.
    const TH = { type: 'thinking', thinking: 't', signature: 's' };
    await chats.appendMessage(pool, id, 'user', [{ type: 'text', text: 'q1' }]);                      // seq 1
    await chats.appendMessage(pool, id, 'assistant', [TH, { type: 'text', text: 'a1' }]);             // seq 2
    await chats.appendMessage(pool, id, 'user', [{ type: 'text', text: 'q2' }]);                      // seq 3
    await chats.appendMessage(pool, id, 'assistant', [TH]);                                            // seq 4 (thinking only)
    await chats.appendMessage(pool, id, 'assistant', [TH, { type: 'text', text: 'a3' }]);             // seq 5
    const seen = await chats.loadMessages(pool, id, { thinkingFloorSeq: 5 });
    expect(seen.map((m) => m.content)).toEqual([[{ type: 'text', text: 'q1' }], [{ type: 'text', text: 'a1' }], [{ type: 'text', text: 'q2' }], [{ type: 'text', text: '[reasoning omitted]' }], [TH, { type: 'text', text: 'a3' }]]);
    expect((await chats.loadMessages(pool, id))[1].content).toEqual([TH, { type: 'text', text: 'a1' }]);   // no floor → as stored
    expect((await chats.loadMessages(pool, id, { thinkingFloorSeq: 0 }))[1].content[0]).toEqual(TH);
  });

  test('deleteChat cascades to the messages; listChats carries message_count, newest first', async () => {
    const a = await chats.createChat(pool, { userId: 9, text: 'a', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v' });
    const b = await chats.createChat(pool, { userId: 9, text: 'b', model: 'claude-opus-5-5', effort: 'medium', promptVersion: 'v' });
    await chats.appendMessage(pool, a, 'user', [{ type: 'text', text: '1' }]);
    await chats.appendMessage(pool, a, 'assistant', [{ type: 'text', text: '2' }]);
    await q('UPDATE casey_chats SET updated_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [b]);
    const list = await chats.listChats(pool, 9);
    expect(list.map((c) => [Number(c.id), Number(c.message_count)])).toEqual([[a, 2], [b, 0]]);
    expect(await chats.deleteChat(pool, a, 9)).toBe(true);
    expect((await q('SELECT COUNT(*) AS n FROM casey_messages WHERE chat_id = ?', [a]))[0].n).toBe('0');
  });

  test('one whole turn with the real store, a scripted model and the real tools; a second turn replays it byte for byte', async () => {
    const app = express();
    app.use(express.json());
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const spendDb = {
      query: async (sql, p) => {
        if (/FROM app_settings/i.test(sql)) return [[]];
        if (/SUM\(cost_cents\)/i.test(sql)) return [[{ c: 0 }]];
        return pool.query(sql, p);
      },
    };
    const SU = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] };
    const ctx = { db: spendDb, auth: SU, app, port: server.address().port, via: 'casey', ip: '127.0.0.1', headers: {} };
    const T = (text) => ({ type: 'text', text });
    const reply = (content, stop = 'end_turn') => ({ ok: true, content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, cost_cents: 0.01, callId: 1, latency_ms: 1, partial: [] });
    const requests = [];
    const converse = async (db, o) => { requests.push(JSON.parse(JSON.stringify(o.messages))); return script.shift(); };
    let script = [
      reply([{ type: 'thinking', thinking: 't', signature: 'S' }, { type: 'tool_use', id: 'tu1', name: 'whoami', input: {} }, { type: 'tool_use', id: 'tu2', name: 'read_source', input: { path: 'lib/caseyPrompt.js', lines: 2 } }], 'tool_use'),
      reply([T('Answer one.')]),
    ];
    const events = [];
    const r1 = await loop.runTurn(spendDb, { ctx, chatId: null, text: 'Who am I?', send: (e) => events.push(e), converse, heartbeatMs: 0 });
    expect(r1.ok).toBe(true);
    const chatId = r1.final.chat_id;
    const sig = prompt.signature(tools.definitions());
    expect(await chats.getChat(pool, chatId, 6)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', prompt_version: sig, running_since: null, title: 'Who am I?' });
    const rows = await chats.loadMessages(pool, chatId);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3).map((m) => ({ role: m.role, content: m.content }))).toEqual(requests[1]);
    expect(rows[3].content).toEqual([T('Answer one.')]);
    expect(JSON.parse(rows[2].content[0].content).data).toMatchObject({ user_id: 6, is_superuser: true });
    expect(rows[1].meta).toMatchObject({ stop_reason: 'tool_use', cost_cents: 0.01 });
    expect(rows[2].meta.tool_calls.map((t) => [t.name, t.ok])).toEqual([['whoami', true], ['read_source', true]]);
    script = [reply([T('Answer two.')])];
    const r2 = await loop.runTurn(spendDb, { ctx, chatId, text: 'And again?', send: () => {}, converse, heartbeatMs: 0 });
    expect(r2.ok).toBe(true);
    const sent = requests[2];
    expect(sent.slice(0, 4)).toEqual(rows.map((m) => ({ role: m.role, content: m.content })));
    expect(sent[4].content[1]).toEqual(T('And again?'));
    expect((await chats.loadMessages(pool, chatId)).length).toBe(6);
    await new Promise((r) => server.close(r));
  });
});
