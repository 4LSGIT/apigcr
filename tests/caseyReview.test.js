// Casey v2 S4b — the superuser's review routes (routes/api.casey.js) over a db
// stub, with the REAL chats / cards readers running their SQL against canned
// rows: the gate (the SU casey guard: a staff JWT 403, no token 401, SU without
// a live elevation refused, a View-as session 403, a machine key refused), the
// the list's filters and validation, one chat with its
// messages (thinking blocks included), its cards (presented, keyed by id) and
// its flags, 404 for an unknown or malformed id. The SQL itself is proven on
// the engine by tests/caseyReview.mysql.test.js.
'use strict';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-review-test-secret';

const { mintElevationToken } = require('../lib/auth.superuser');
const router = require('../routes/api.casey');

const CHATS = [
  { id: 23, user_id: 7, user_name: 'Rena', title: 'Mail to Mary', model: 'claude-opus-5-5', effort: 'high', prompt_version: 'v2.5-x', thinking_floor_seq: 0, created_at: new Date('2026-11-23T10:00:00Z'), updated_at: new Date('2026-11-23T11:00:00Z'), message_count: 2, cost_cents: '9.0000', flags: 1 },
  { id: 22, user_id: 6, user_name: 'IT', title: 'Overdue', model: 'claude-sonnet-5-5', effort: 'medium', prompt_version: 'v2.5-x', thinking_floor_seq: 0, created_at: new Date('2026-11-23T09:00:00Z'), updated_at: new Date('2026-11-23T09:30:00Z'), message_count: 0, cost_cents: '0.0000', flags: 0 },
];
const MESSAGES = { 23: [
  { id: 1, seq: 1, role: 'user', content: JSON.stringify([{ type: 'text', text: 'q' }]), meta: null, created_at: new Date() },
  { id: 2, seq: 2, role: 'assistant', content: JSON.stringify([{ type: 'thinking', thinking: 'hm', signature: 'S' }, { type: 'text', text: 'A.' }]), meta: JSON.stringify({ cost_cents: 0.5 }), created_at: new Date() },
] };
const sqlLog = [];
const dbStub = {
  query: async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ');
    sqlLog.push([s, params]);
    if (/FROM app_settings/i.test(s)) return [[]];
    if (/FROM casey_chats c LEFT JOIN users u/.test(s) && /WHERE c\.id = \?/.test(s)) return [CHATS.filter((c) => c.id === Number(params[0])).map((c) => ({ ...c }))];
    if (/FROM casey_chats c LEFT JOIN users u/.test(s)) {
      let rows = CHATS;
      let i = 0;
      if (/c\.user_id = \?/.test(s)) { const u = Number(params[i++]); rows = rows.filter((c) => c.user_id === u); }
      if (/c\.title LIKE \?/.test(s)) { const like = String(params[i++]); rows = rows.filter((c) => c.title.toLowerCase().includes(like.slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase())); }
      if (/c\.updated_at < \?/.test(s)) { const b = new Date(String(params[i++]).replace(' ', 'T') + 'Z'); rows = rows.filter((c) => c.updated_at < b); }   // the route hands MySQL a UTC DATETIME literal
      if (/> 0 ORDER BY/.test(s)) rows = rows.filter((c) => c.flags > 0);
      const m = /LIMIT (\d+)$/.exec(s);
      return [rows.slice(0, Number(m[1])).map((c) => ({ ...c }))];
    }
    if (/FROM casey_messages WHERE chat_id = \? ORDER BY seq/.test(s)) return [MESSAGES[Number(params[0])] || []];
    if (/FROM casey_cards WHERE chat_id = \? ORDER BY id/.test(s)) return [Number(params[0]) === 23 ? [{ id: 4, chat_id: 23, user_id: 7, tool_use_id: 'a', tier: 1, summary: 'Create the task', status: 'resumed', decline_note: null, resumed_at: null, created_at: new Date() }] : []];
    if (/FROM casey_card_steps WHERE card_id = \?/.test(s)) return [[{ id: 9, card_id: 4, step_no: 1, method: 'POST', path: '/api/tasks', body: '{"title":"x"}', path_sent: null, body_sent: null, tier: 1, purpose: 'p', status: 'applied', claim_token: 'secret', http_status: 201, result: '{"id":77}', idempotency_key: 'k', claimed_at: null, settled_at: null }]];
    if (/FROM issue_reports WHERE kind = 'casey'/.test(s)) return [Number(params[0]) === 23 ? [{ id: 41, user_name: 'Rena', note: 'wrong task', created_at: new Date(), resolved_at: null, seq: 2, flagged_by: 'user' }] : []];
    throw new Error('unexpected sql: ' + s);
  },
};

let server, port;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  app.use(router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => { sqlLog.length = 0; });

const su = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const staff = jwt.sign({ sub: 7, username: 'rena', user_auth: 'authorized', roles: ['admin', 'it'], aud: 'staff' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const viewAs = jwt.sign({ sub: 6, username: 'IT', user_auth: 'authorized', roles: ['su'], aud: 'staff', view_as: true, act: { sub: 6, username: 'IT' } }, process.env.JWT_SECRET, { expiresIn: '5m' });
function call(p, { token = su, elevate = true, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    if (elevate && token) headers['x-su-elevation'] = mintElevationToken(jwt.decode(token).sub);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let body = null; try { body = JSON.parse(d); } catch (_) { body = d; } resolve({ status: res.statusCode, body }); }); });
    req.on('error', reject); req.end();
  });
}

test('the gate: SU with a live elevation only — staff 403, no token 401, SU without elevation refused, a View-as session 403, a machine key refused', async () => {
  for (const p of ['/api/casey/review?limit=5', '/api/casey/review/23']) {
    expect((await call(p)).status).toBe(200);
    expect((await call(p, { token: staff })).status).toBe(403);
    expect((await call(p, { token: null })).status).toBe(401);
    expect([401, 403]).toContain((await call(p, { elevate: false })).status);
    expect((await call(p, { token: viewAs })).status).toBe(403);
    expect([401, 403]).toContain((await call(p, { token: null, headers: { 'x-api-key': 'yci_' + 'A'.repeat(22) } })).status);
  }
});

test('the list: every user\'s chats with the owner, counts, cost and flags; filters user / q / flagged / before / limit; validation', async () => {
  const all = await call('/api/casey/review');
  expect(all.body.chats.map((c) => [c.id, c.user_name, c.message_count, c.cost_cents, c.flags])).toEqual([[23, 'Rena', 2, 9, 1], [22, 'IT', 0, 0, 0]]);
  expect(sqlLog[sqlLog.length - 1][0]).toMatch(/LIMIT 50$/);
  expect((await call('/api/casey/review?user=7')).body.chats.map((c) => c.id)).toEqual([23]);
  expect((await call('/api/casey/review?flagged=1')).body.chats.map((c) => c.id)).toEqual([23]);
  expect((await call('/api/casey/review?q=mary')).body.chats.map((c) => c.id)).toEqual([23]);
  expect((await call('/api/casey/review?limit=1')).body.chats.map((c) => c.id)).toEqual([23]);
  expect((await call('/api/casey/review?limit=9999')).body.chats.length).toBe(2);
  expect(sqlLog[sqlLog.length - 1][0]).toMatch(/LIMIT 200$/);   // REVIEW_MAX
  expect((await call('/api/casey/review?before=2026-11-23T10:00:00Z')).body.chats.map((c) => c.id)).toEqual([22]);
  expect((await call('/api/casey/review?user=abc')).status).toBe(400);
  expect((await call('/api/casey/review?user=0')).status).toBe(400);
  expect((await call('/api/casey/review?before=yesterday')).status).toBe(400);
  await call('/api/casey/review?before=2026-11-23T10:00:00.000Z');
  expect(sqlLog[sqlLog.length - 1][1]).toContain('2026-11-23 10:00:00');   // an ISO instant becomes the DATETIME literal (no truncation warning)
  // the LIKE needle is escaped and bounded
  await call('/api/casey/review?q=' + encodeURIComponent('50%_x\\'));
  const like = sqlLog[sqlLog.length - 1][1].find((v) => typeof v === 'string' && v.startsWith('%'));
  expect(like).toBe('%50\\%\\_x\\\\%');
});

test('one chat: the owner, every stored block (thinking kept), the cards presented and keyed by id without claim tokens, the flags; 404 for an unknown or malformed id', async () => {
  const r = await call('/api/casey/review/23');
  expect(r.status).toBe(200);
  expect(r.body.chat).toMatchObject({ id: 23, user_id: 7, user_name: 'Rena', title: 'Mail to Mary', model: 'claude-opus-5-5' });
  expect(r.body.messages.map((m) => [m.seq, m.role, m.content.map((b) => b.type)])).toEqual([[1, 'user', ['text']], [2, 'assistant', ['thinking', 'text']]]);
  expect(r.body.messages[1].meta).toEqual({ cost_cents: 0.5 });
  expect(Object.keys(r.body.cards)).toEqual(['4']);
  expect(r.body.cards['4']).toMatchObject({ id: 4, summary: 'Create the task', status: 'resumed' });
  expect(r.body.cards['4'].steps[0]).toMatchObject({ step_no: 1, method: 'POST', path: '/api/tasks', status: 'applied', http_status: 201 });
  expect(r.body.cards['4'].steps[0].content).toBeDefined();
  expect(JSON.stringify(r.body)).not.toContain('secret');   // the claim token never leaves the store
  expect(r.body.flags).toEqual([expect.objectContaining({ id: 41, user_name: 'Rena', note: 'wrong task', seq: 2, by: 'user' })]);
  expect((await call('/api/casey/review/22')).body).toMatchObject({ messages: [], cards: {}, flags: [] });
  expect((await call('/api/casey/review/999')).status).toBe(404);
  expect((await call('/api/casey/review/abc')).status).toBe(404);
  expect((await call('/api/casey/review/-1')).status).toBe(404);
});
