// Casey v2 S5a — routes/mcp.js + services/mcp/tools.js: the MCP server for a
// SESSION KEY identity, over a real listening app with the REAL middleware and
// routes (lib/auth.readonly, api.readonly, api.scratch, api.alertIt, api.version)
// and a db stub (the key lookup by hash, the logs). JSON-RPC over HTTP as a
// client speaks it: initialize → tools/list → tools/call. Proves: the gate (no
// key 401, a bad key 401, an expired key 401, a machine key 401 — none as JSON-
// RPC); a scoped key lists only its scopes' tools and a call outside them is
// isError; a legacy NULL-scope key gets the trio's tools and never the explicit
// ones (casey.review); every loopback tool reaches its route with the SAME key
// header and returns the route's JSON (readonly_sql through the real guard with
// a stubbed read pool, scratch_put / scratch_delete, settings_read, alert_it);
// a route refusal is isError with the route's message; the in-process review
// tools under casey.review and their log rows; lookup_routes without `you`;
// the size cut; GET / DELETE 405; 60/min. Review r1 folds: the audit INSERT's
// column list equals the table's in ref/database.sql (ungated — the blocker's
// net; the real engine runs it in tests/mcpAudit.mysql.test.js) and a failed
// audit row fails the read closed; an array body is 400; `..` in ns / k never
// reaches a route; the UNTRUSTED line on record data; the review chat paged;
// whoami's build in-process; the client's UA forwarded; a child key never
// holds casey.review; the raw key never appears in any answer or log row.
'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mcp-test-secret';
const roQueries = [];
jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => ({
    query: async (sql, params) => { roQueries.push([String(sql), params]); if (/MAX_EXECUTION_TIME/.test(sql)) return [[]]; if (/FROM rw_scratch/.test(sql)) return [[{ ns: 'fred', k: 'x', v: '{"a":1}', meta: null, updated_at: new Date('2026-11-23T10:00:00Z') }], [{ name: 'ns' }]]; if (/BIG/.test(sql)) return [Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(100) })), [{ name: 'i' }, { name: 'pad' }]]; return [[{ one: 1 }], [{ name: 'one' }]]; },
    release: () => {},
  }),
}));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../lib/firmConfig', () => { const a = jest.requireActual('../lib/firmConfig'); return { ...a, cfg: jest.fn((k) => a.cfg(k)) }; });

const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const RAW = { scoped: 'ycro_' + 'A'.repeat(22), legacy: 'ycro_' + 'B'.repeat(22), review: 'ycro_' + 'C'.repeat(22), expired: 'ycro_' + 'D'.repeat(22), limit: 'ycro_' + 'E'.repeat(22), child: 'ycro_' + 'F'.repeat(22) };
const KEYS = {
  [hash(RAW.scoped)]: { id: 201, label: 'scoped', scopes: JSON.stringify(['sql.ro', 'scratch']), expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null, created_by: 6 },
  [hash(RAW.legacy)]: { id: 202, label: 'legacy', scopes: null, expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null, created_by: 6 },
  [hash(RAW.review)]: { id: 203, label: 'review', scopes: JSON.stringify(['sql.ro', 'casey.review']), expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null, created_by: 6 },
  [hash(RAW.expired)]: { id: 204, label: 'expired', scopes: JSON.stringify(['sql.ro']), expires_at: new Date(Date.now() - 3600e3), revoked_at: null, parent_key_id: null, created_by: 6 },
  [hash(RAW.limit)]: { id: 205, label: 'limit', scopes: JSON.stringify(['sql.ro']), expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: null, created_by: 6 },
  // a CHILD of the review key whose own column even names casey.review: CHILD_SCOPES ∩ the parent's — the trio at most
  [hash(RAW.child)]: { id: 206, label: 'child', scopes: JSON.stringify(['sql.ro', 'casey.review']), expires_at: new Date(Date.now() + 3600e3), revoked_at: null, parent_key_id: 203, created_by: 6, parent_scopes: JSON.stringify(['sql.ro', 'casey.review']), parent_expires_at: new Date(Date.now() + 7200e3) },
};
let auditFail = false;   // the audit INSERT refused (a schema drift, a dead pool): the review read must fail closed
const MESSAGES = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, seq: i + 1, role: i % 2 ? 'assistant' : 'user', content: JSON.stringify([{ type: 'text', text: `m${i + 1} Rena-private` }]), meta: null, created_at: new Date() }));
const writes = []; const logs = [];
const dbStub = {
  query: async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM readonly_api_keys k LEFT JOIN readonly_api_keys p ON p\.id = k\.parent_key_id WHERE k\.key_hash/.test(s)) { const row = KEYS[params[0]]; return [row ? [{ parent_id: row.parent_key_id ?? null, parent_revoked_at: null, parent_expires_at: null, parent_scopes: null, ...row }] : []]; }
    if (/^UPDATE readonly_api_keys SET last_used_at/.test(s)) return [{}];
    if (/INSERT INTO readonly_query_log/.test(s)) { if (auditFail) throw new Error("Unknown column 'nope' in 'field list'"); logs.push(params); return [{ insertId: logs.length }]; }
    if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
    if (/INSERT INTO rw_scratch/.test(s)) { writes.push(['put', params]); return [{ affectedRows: 1 }]; }
    if (/DELETE FROM rw_scratch/.test(s)) { writes.push(['delete', params]); return [{ affectedRows: 1 }]; }
    if (/FROM app_settings/.test(s)) return [[{ key: 'app_url', value: 'https://app.test' }]];
    if (/FROM app_build|min_build/i.test(s)) return [[]];
    if (/FROM casey_chats c LEFT JOIN users u/.test(s) && /WHERE c\.id = \?/.test(s)) return [Number(params[0]) === 23 ? [{ id: 23, user_id: 7, user_name: 'Rena', title: 'Mail', model: 'claude-opus-5-5', effort: 'high', prompt_version: 'v', thinking_floor_seq: 0, created_at: new Date(), updated_at: new Date() }] : []];
    if (/FROM casey_chats c LEFT JOIN users u/.test(s)) return [[{ id: 23, user_id: 7, user_name: 'Rena', title: 'Mail', model: 'claude-opus-5-5', effort: 'high', prompt_version: 'v', created_at: new Date(), updated_at: new Date(), message_count: 2, cost_cents: '1.0', flags: 1 }]];
    if (/FROM casey_messages WHERE chat_id/.test(s)) return [MESSAGES.map((m) => ({ ...m }))];
    if (/FROM casey_cards WHERE chat_id/.test(s)) return [[]];
    if (/FROM issue_reports WHERE kind = 'casey'/.test(s)) return [[]];
    if (/INSERT INTO system_alerts|FROM system_alerts|alert_email|UPDATE system_alerts/i.test(s)) return [[{ insertId: 1 }], []];
    return [[], []];
  },
  execute: async () => [[], []],
};

let server, port;
const hits = [];        // every path the app saw (a loopback call shows here)
const answers = [];     // every raw response body — swept for the raw key at the end
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => { req.db = dbStub; hits.push(req.path); next(); });
  for (const f of ['../routes/mcp', '../routes/api.readonly', '../routes/api.scratch', '../routes/api.version', '../routes/api.casey']) app.use(require(f));
  try { app.use(require('../routes/api.alertIt')); } catch (e) { console.warn('alertIt not mounted:', e.message); }
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = server.address().port;
  process.env.PORT = String(port);
});
afterAll(async () => { await new Promise((r) => server.close(r)); delete process.env.PORT; });
beforeEach(() => { writes.length = 0; logs.length = 0; roQueries.length = 0; hits.length = 0; auditFail = false; });

function post(body, { key = RAW.scoped, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    if (key) h['x-readonly-api-key'] = key;
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: h }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json, raw: d, ctype: res.headers['content-type'] }); }); });
    req.on('error', reject); req.end(data);
  }).then((r) => { answers.push(r.raw); return r; });
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const INIT = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jest', version: '0' } });
const call = (name, args, key, headers) => post(rpc('tools/call', { name, arguments: args || {} }, 7), { key, headers });
const { UNTRUSTED_HEAD } = require('../services/mcp/tools');
const textOf = (r) => r.json.result.content[0].text;
const isUntrusted = (r) => textOf(r).startsWith(UNTRUSTED_HEAD);
const dataOf = (r) => { const t = textOf(r); return JSON.parse(t.startsWith(UNTRUSTED_HEAD) ? t.slice(UNTRUSTED_HEAD.length) : t); };
// readonly_query_log params as logTool / the route's logQuery bind them
const LOG = { api_key_id: 0, ip: 1, user_agent: 2, sql_text: 3, params_json: 4, row_count: 5, duration_ms: 6, status: 7, sensitive_key: 8, error_text: 9 };

test('the handshake: initialize answers the server info and the tools capability, as JSON (stateless: no session id); tools/list is this key\'s tools', async () => {
  const init = await post(INIT);
  expect(init.status).toBe(200);
  expect(init.ctype).toMatch(/application\/json/);
  expect(init.json.result.serverInfo).toEqual({ name: 'yisracase', version: '0.5.0' });
  expect(init.json.result.capabilities.tools).toBeDefined();
  const list = await post(rpc('tools/list', {}, 2));
  expect(list.json.result.tools.map((t) => t.name)).toEqual(['whoami', 'readonly_sql', 'settings_read', 'scratch_get', 'scratch_put', 'scratch_delete', 'lookup_routes', 'read_source', 'search_docs']);   // sql.ro + scratch; no alert, no casey.review
  for (const t of list.json.result.tools) { expect(typeof t.description).toBe('string'); expect(t.inputSchema.type).toBe('object'); }
});

test('the gate: no key, a bad key, an expired key and a machine key are 401 JSON (not JSON-RPC); GET and DELETE are 405', async () => {
  for (const [label, key, headers] of [['none', null, {}], ['bad', 'ycro_' + 'Z'.repeat(22), {}], ['expired', RAW.expired, {}], ['machine', null, { 'x-api-key': 'yck_' + 'A'.repeat(22) }]]) {
    const r = await post(INIT, { key, headers });
    expect([label, r.status]).toEqual([label, 401]);
    expect(r.json.jsonrpc).toBeUndefined();
  }
  for (const method of ['GET', 'DELETE']) {
    const r = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'x-readonly-api-key': RAW.scoped } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow })); }); req.on('error', reject); req.end(); });
    expect([method, r.status, r.allow]).toEqual([method, 405, 'POST']);
  }
});

test('scopes decide: a legacy NULL key sees the trio\'s tools and alert, never casey.review; a call outside the key\'s scopes is isError naming the scope', async () => {
  const list = await post(rpc('tools/list', {}, 2), { key: RAW.legacy });
  expect(list.json.result.tools.map((t) => t.name)).toEqual(['whoami', 'readonly_sql', 'settings_read', 'scratch_get', 'scratch_put', 'scratch_delete', 'alert_it', 'lookup_routes', 'read_source', 'search_docs']);
  const r = await call('casey_review_list', {}, RAW.legacy);
  expect(r.json.result.isError).toBe(true);
  expect(textOf(r)).toMatch(/casey_review_list needs the 'casey.review' scope/);
  const a = await call('alert_it', { subject: 's', message: 'm' }, RAW.scoped);
  expect(a.json.result.isError).toBe(true);
  expect(textOf(a)).toMatch(/needs the 'alert' scope/);
  const unknown = await call('nope', {});
  expect(unknown.json.result.isError).toBe(true);
  expect(textOf(unknown)).toMatch(/unknown tool "nope"/);
});

test('whoami: the key, its scopes and tools, the build', async () => {
  const r = await call('whoami', {});
  const d = dataOf(r);
  expect(d).toMatchObject({ identity: 'session_key', key_id: 201, label: 'scoped', scopes: ['sql.ro', 'scratch'], legacy_full_surface: false });
  expect(d.tools).toContain('readonly_sql');
  expect(d.tools).not.toContain('alert_it');
  const appBuild = require('../lib/appBuild');
  expect(d.build).toEqual({ build: appBuild.build, revision: appBuild.revision, started_at: appBuild.startedAt });   // in-process
  expect(hits.filter((p) => p === '/api/version')).toEqual([]);   // no loopback to the public route with the key header (review r1)
  expect(isUntrusted(r)).toBe(false);
});

test('one JSON-RPC message per request: an array body (a batch) is 400 -32600 before the SDK runs anything', async () => {
  const r = await post([INIT, rpc('tools/list', {}, 2)]);
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: expect.stringMatching(/batches are not accepted/) }, id: null });
  expect(hits).toEqual(['/mcp']);
});

test('the audit INSERT names exactly the columns readonly_query_log has (ref/database.sql) — the mocked-SQL trap, closed', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mcp.js'), 'utf8');
  const m = src.match(/INSERT INTO readonly_query_log\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/);
  expect(m).not.toBeNull();
  const cols = m[1].split(',').map((c) => c.trim());
  expect(m[2].split(',').length).toBe(cols.length);   // one placeholder per column
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').match(/CREATE TABLE `readonly_query_log` \(([\s\S]*?)\n\)/);
  expect(ddl).not.toBeNull();
  const tableCols = [...ddl[1].matchAll(/^\s*`([a-z_]+)`/gm)].map((x) => x[1]);
  for (const c of cols) expect(tableCols).toContain(c);
  expect(cols).toEqual(['api_key_id', 'ip', 'user_agent', 'sql_text', 'params_json', 'row_count', 'duration_ms', 'status', 'sensitive_key', 'error_text']);   // the route's logQuery list; the twin binds the same
});

test('readonly_sql reaches POST /api/readonly/sql with the SAME key: the route\'s guard runs (a non-SELECT is its 400 → isError), a SELECT returns its rows and logs the query', async () => {
  const bad = await call('readonly_sql', { sql: 'DELETE FROM users' });
  expect(bad.json.result.isError).toBe(true);
  expect(textOf(bad)).toMatch(/^400: Read-only required/);
  const r = await call('readonly_sql', { sql: 'SELECT 1 AS one LIMIT 1' });
  expect(r.json.result.isError).toBeUndefined();
  expect(dataOf(r).rows).toEqual([{ one: 1 }]);
  expect(roQueries.some(([s]) => /SELECT 1 AS one/.test(s))).toBe(true);
  expect(logs.length).toBeGreaterThan(0);   // readonly_query_log through the route
  expect(isUntrusted(r)).toBe(true);        // rows are record data
  // the MCP client's User-Agent reaches the route's log row (the default when the client sends none)
  const ua = await call('readonly_sql', { sql: 'SELECT 1 AS one LIMIT 1' }, RAW.scoped, { 'user-agent': 'claude-code/2.0 (jest)' });
  expect(ua.json.result.isError).toBeUndefined();
  expect(logs[logs.length - 1][LOG.user_agent]).toBe('claude-code/2.0 (jest)');
  expect(logs[logs.length - 1][LOG.api_key_id]).toBe(201);
  // the secret tier is the route's refusal too
  const secret = await call('readonly_sql', { sql: 'SELECT * FROM app_settings LIMIT 1' });
  expect(secret.json.result.isError).toBe(true);
  expect(textOf(secret)).toMatch(/not readable through this endpoint/);
});

test('scratch_get / scratch_put / scratch_delete and settings_read through their routes; the route\'s validation answers (a non-string v)', async () => {
  const g = await call('scratch_get', { ns: 'fred', k: 'x' });
  expect(dataOf(g)).toMatchObject({ found: true, ns: 'fred', k: 'x', v: '{"a":1}' });
  expect(isUntrusted(g)).toBe(true);
  // ns / k are checked BEFORE a path is built: a `..` never reaches any route (review r1 S3)
  for (const [tool, args] of [['scratch_get', { ns: '..', k: 'x' }], ['scratch_put', { ns: 'fred', k: '../y', v: '1' }], ['scratch_delete', { ns: 'fred/../x', k: 'y' }], ['scratch_put', { ns: 'fred', k: 'a'.repeat(65), v: '1' }]]) {
    const bad = await call(tool, args);
    expect([tool, bad.json.result.isError, textOf(bad)]).toEqual([tool, true, 'BAD_INPUT: ns and k must match [A-Za-z0-9_-]{1,64}']);
  }
  expect(hits.filter((p) => p !== '/mcp')).toEqual(['/api/readonly/sql']);   // only the good get looped back
  expect(writes).toEqual([]);
  const p = await call('scratch_put', { ns: 'fred', k: 'y', v: '{"b":2}', meta: { by: 'mcp' } });
  expect(dataOf(p)).toMatchObject({ ok: true, ns: 'fred', k: 'y' });
  expect(writes[0][0]).toBe('put');
  expect(writes[0][1].slice(0, 3)).toEqual(['fred', 'y', '{"b":2}']);
  const badV = await call('scratch_put', { ns: 'fred', k: 'y', v: { b: 2 } });
  expect(badV.json.result.isError).toBe(true);
  expect(textOf(badV)).toMatch(/^400: v must be a string/);
  const d = await call('scratch_delete', { ns: 'fred', k: 'y' });
  expect(d.json.result.isError).toBeUndefined();
  expect(writes[1][0]).toBe('delete');
  const s = await call('settings_read', {});
  expect(s.json.result.isError).toBeUndefined();
});

test('casey.review: the list and one chat through the S4b readers, a log row each; 404 as isError; validation', async () => {
  const list = await call('casey_review_list', { flagged: true, limit: 5 }, RAW.review);
  expect(dataOf(list).chats).toEqual([expect.objectContaining({ id: 23, user_name: 'Rena', flags: 1 })]);
  expect(isUntrusted(list)).toBe(true);
  const lrow = logs.find((p) => p[LOG.sql_text] === 'mcp casey_review_list');
  expect(lrow).toBeDefined();
  expect([lrow[LOG.api_key_id], lrow[LOG.status], lrow[LOG.row_count], lrow[LOG.sensitive_key], lrow[LOG.error_text]]).toEqual([203, 'success', 1, 0, null]);
  expect(JSON.parse(lrow[LOG.params_json])).toEqual({ user: null, q: '', flagged: true, before: null, limit: 5 });
  expect(typeof lrow[LOG.duration_ms]).toBe('number');
  const one = await call('casey_review_chat', { chat_id: 23 }, RAW.review);
  const d = dataOf(one);
  expect(d.chat).toMatchObject({ id: 23, user_id: 7, user_name: 'Rena' });
  expect(d.messages).toHaveLength(5);
  expect(d).toMatchObject({ total_rows: 5, from_seq: 1, next_from_seq: null });
  expect(d).toHaveProperty('cards'); expect(d).toHaveProperty('flags');
  expect(isUntrusted(one)).toBe(true);
  expect(textOf(one)).not.toMatch(/\n\s+"/);   // compact JSON: a page must fit the cap
  const crow = logs.find((p) => p[LOG.sql_text] === 'mcp casey_review_chat');
  expect(JSON.parse(crow[LOG.params_json])).toEqual({ chat_id: 23, user_id: 7, from_seq: 1, to_seq: null, limit: 40 });
  expect(crow[LOG.row_count]).toBe(5);
  const gone = await call('casey_review_chat', { chat_id: 999 }, RAW.review);
  expect(gone.json.result.isError).toBe(true);
  expect(textOf(gone)).toMatch(/^404: no chat 999/);
  expect(logs.some((p) => p[LOG.sql_text] === 'mcp casey_review_chat' && p[LOG.status] === 'not_found' && /"chat_id":999/.test(p[LOG.params_json]))).toBe(true);   // a miss is logged too
  const bad = await call('casey_review_chat', { chat_id: 'x' }, RAW.review);
  expect(textOf(bad)).toMatch(/^BAD_INPUT/);
  const badBefore = await call('casey_review_list', { before: 'yesterday' }, RAW.review);
  expect(textOf(badBefore)).toMatch(/^BAD_INPUT: before/);
});

test('casey_review_chat is PAGED: limit, from_seq, to_seq; next_from_seq until the end', async () => {
  const p1 = dataOf(await call('casey_review_chat', { chat_id: 23, limit: 2 }, RAW.review));
  expect([p1.messages.map((m) => m.seq), p1.total_rows, p1.next_from_seq]).toEqual([[1, 2], 5, 3]);
  const p2 = dataOf(await call('casey_review_chat', { chat_id: 23, from_seq: p1.next_from_seq, limit: 2 }, RAW.review));
  expect([p2.messages.map((m) => m.seq), p2.next_from_seq]).toEqual([[3, 4], 5]);
  const p3 = dataOf(await call('casey_review_chat', { chat_id: 23, from_seq: p2.next_from_seq, limit: 2 }, RAW.review));
  expect([p3.messages.map((m) => m.seq), p3.next_from_seq]).toEqual([[5], null]);
  const span = dataOf(await call('casey_review_chat', { chat_id: 23, from_seq: 2, to_seq: 3 }, RAW.review));
  expect([span.messages.map((m) => m.seq), span.next_from_seq]).toEqual([[2, 3], null]);
  // cards and flags ride on the FIRST page only (review r2): a later page is the messages alone, and the card / flag readers are not even asked
  expect(p1).toHaveProperty('cards'); expect(p1).toHaveProperty('flags');
  for (const later of [p2, p3, span]) { expect(later).not.toHaveProperty('cards'); expect(later).not.toHaveProperty('flags'); }
  const q0 = roQueries.length;
  const seen = []; const orig = dbStub.query; dbStub.query = async (sql, params) => { seen.push(String(sql)); return orig(sql, params); };
  try { await call('casey_review_chat', { chat_id: 23, from_seq: 2 }, RAW.review); } finally { dbStub.query = orig; }
  expect(seen.some((s) => /FROM casey_cards|FROM issue_reports/.test(s))).toBe(false);
  expect(q0).toBe(roQueries.length);
  for (const args of [{ chat_id: 23, limit: 0 }, { chat_id: 23, limit: 201 }, { chat_id: 23, from_seq: '2' }, { chat_id: 23, to_seq: -1 }]) expect(textOf(await call('casey_review_chat', args, RAW.review))).toMatch(/^BAD_INPUT/);
  const rows = logs.filter((p) => p[LOG.sql_text] === 'mcp casey_review_chat');
  expect(rows.map((p) => JSON.parse(p[LOG.params_json]).from_seq)).toEqual([1, 3, 5, 2, 2]);   // a row per page (the last is the reader-count probe above)
});

test('the audit row FAILS CLOSED: a refused readonly_query_log INSERT is the tool\'s failure — no chat content, no list, in the answer', async () => {
  auditFail = true;
  for (const [tool, args] of [['casey_review_chat', { chat_id: 23 }], ['casey_review_list', {}]]) {
    const r = await call(tool, args, RAW.review);
    expect([tool, r.json.result.isError]).toEqual([tool, true]);
    expect(textOf(r)).toMatch(/^TOOL_FAILED: Unknown column/);
    expect(textOf(r)).not.toMatch(/Rena|m1 /);
  }
  expect(logs).toEqual([]);
});

test('a CHILD key never holds casey.review — its column naming it or not: tools/list omits the review tools and a call is refused', async () => {
  const list = await post(rpc('tools/list', {}, 2), { key: RAW.child });
  expect(list.status).toBe(200);
  expect(list.json.result.tools.map((t) => t.name)).toEqual(['whoami', 'readonly_sql', 'settings_read', 'scratch_get', 'lookup_routes', 'read_source', 'search_docs']);
  const r = await call('casey_review_list', {}, RAW.child);
  expect(r.json.result.isError).toBe(true);
  expect(textOf(r)).toMatch(/needs the 'casey.review' scope; this key holds \["sql.ro"\]/);
  expect(dataOf(await call('whoami', {}, RAW.child))).toMatchObject({ key_id: 206, parent_key_id: 203, scopes: ['sql.ro'] });
});

test('the read tools: lookup_routes without `you` (a key calls no route) and with the note; read_source and search_docs run', async () => {
  const r = await call('lookup_routes', { q: '/api/casey/notes', limit: 2 });
  const d = dataOf(r);
  expect(d.rows.length).toBeGreaterThan(0);
  for (const row of d.rows) expect(row).not.toHaveProperty('you');
  expect(d.note).toMatch(/session key calls no app route/);
  const src = await call('read_source', { path: 'lib/caseyPrompt.js' });
  expect(src.json.result.isError).toBeUndefined();
  expect(textOf(src)).toContain('VERSION');
  expect(isUntrusted(src)).toBe(true);    // the S1 envelope's flag reaches the client
  expect(isUntrusted(r)).toBe(false);     // the catalog is the app's own
  const docs = await call('search_docs', { query: 'Casey Notes' });
  expect(docs.json.result.isError).toBeUndefined();
});

test('a result over 60 KB is cut with a marker, never silently shortened — in BYTES, on a code-point boundary', async () => {
  const r = await call('readonly_sql', { sql: 'SELECT BIG LIMIT 2000', maxRows: 2000 });
  const text = textOf(r).slice(UNTRUSTED_HEAD.length);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(60 * 1024 + 200);
  expect(text).toMatch(/… \[cut at 61440 bytes — narrow the request\]$/);
  const { cutBytes, ok, loopbackTimeout, TIMEOUT_MS, TIMEOUT_MARGIN_MS } = require('../services/mcp/tools');
  const emoji = '😀'.repeat(20000);   // 4 bytes each: 80,000 bytes, 40,000 UTF-16 units
  const c = cutBytes(emoji, 60 * 1024);
  expect(c.cut).toBe(true);
  expect(Buffer.byteLength(c.text, 'utf8')).toBeLessThanOrEqual(60 * 1024);
  expect(c.text.length % 2).toBe(0);                        // never half a surrogate pair
  // the cap falling INSIDE a pair: 'a' + emoji — 61,437 bytes after 15,359 emoji, and a lone high surrogate encodes as 3 bytes, so a slice ending mid-pair also fits the cap; it must step back
  const odd = cutBytes('a' + emoji, 60 * 1024);
  expect(odd.cut).toBe(true);
  expect(Buffer.byteLength(odd.text, 'utf8')).toBeLessThanOrEqual(60 * 1024);
  expect(/[\ud800-\udbff]$/.test(odd.text)).toBe(false);   // not ending on a high surrogate
  expect(odd.text).toBe('a' + '😀'.repeat(15359));
  expect(cutBytes('abc', 3)).toEqual({ text: 'abc', cut: false });
  expect(ok('x'.repeat(10)).content[0].text).toBe('x'.repeat(10));
  // the loopback wait follows the query's own deadline plus the margin (review r1 S2)
  expect([loopbackTimeout({}), loopbackTimeout({ timeoutMs: 60000 }), loopbackTimeout({ timeoutMs: 90000 }), loopbackTimeout({ timeoutMs: 0 })]).toEqual([TIMEOUT_MS + TIMEOUT_MARGIN_MS, 65000, 65000, TIMEOUT_MS + TIMEOUT_MARGIN_MS]);
});

test('readonly_sql forwards timeoutMs clamped to the tool\'s 60 s (the route allows 120; review r2: a 100 s ask must not outrun the 65 s wait); a bad one is dropped', async () => {
  for (const timeoutMs of [100000, 20000, 'soon']) await call('readonly_sql', { sql: 'SELECT 1 AS one LIMIT 1', timeoutMs });
  // the route sets its session MAX_EXECUTION_TIME from the body's timeoutMs (a bound parameter): read it off the readonly pool's statements
  const met = roQueries.filter(([s]) => /MAX_EXECUTION_TIME/.test(s)).map(([, p]) => p[0]).slice(-3);
  expect(met.slice(0, 2)).toEqual([60000, 20000]);
  expect(met[2]).toBeLessThanOrEqual(60000);   // the route's default for a dropped value
});

test('the gate on GET / DELETE too (no key → 401, not 405); 60 requests a minute per key → the 61st is 429', async () => {
  for (const method of ['GET', 'DELETE']) {
    const r = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); });
    expect([method, r]).toEqual([method, 401]);
  }
  let last = null;
  for (let i = 0; i < 61; i++) last = await post(INIT, { key: RAW.limit });
  expect(last.status).toBe(429);
  expect((await post(INIT, { key: RAW.scoped })).status).toBe(200);   // another key is not limited by it
});

test('the raw key never appears in any answer or in any readonly_query_log row (the sweep over everything above)', () => {
  expect(answers.length).toBeGreaterThan(50);
  const everything = answers.join('\n') + JSON.stringify(logs) + JSON.stringify(writes);
  for (const [name, raw] of Object.entries(RAW)) expect([name, everything.includes(raw)]).toEqual([name, false]);
});
