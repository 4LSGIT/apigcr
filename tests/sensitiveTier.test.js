// tests/sensitiveTier.test.js
//
/**
 * The sensitive-read tier — access-control SEC-3 (ref/ACCESS_CONTROL_DESIGN.md
 * §5.7): lib/sqlGuard SECRET_TABLES / SENSITIVE_TABLES / deniedTable,
 * lib/capabilities 'sql.ro.sensitive' (explicit), routes/api.readonly.js,
 * routes/api.readonlyKeys.js (mint cap), public/readonlyKeys.html (pane).
 *
 * WHAT IS LOCKED
 *   - Guard matrix: a SECRET table is refused for every caller (and wins over
 *     a sensitive one in the same statement); a SENSITIVE table is refused
 *     without the scope and readable with it; ai_spend and ordinary tables
 *     are readable by everyone; the pre-SEC-3 matchedSecretTable /
 *     touchesSecretTable keep the ordinary-key answer.
 *   - The endpoint, driven through the REAL router (auth → surface gate →
 *     handler; only the RO pool is stubbed):
 *       ["sql.ro"] key   — sensitive table → 403 naming the scope, nothing
 *                          run, logged rejected_sensitive_table, sensitive_key=0
 *       legacy NULL key  — the same 403 (the scope is explicit)
 *       sensitive key    — sensitive table runs, logged sensitive_key=1
 *       every key        — secret table → 400, logged rejected_secret_table
 *       ai_spend         — runs for an ordinary key
 *       ["sql.ro.sensitive"] alone — 403 at the sql.ro surface gate
 *   - The mint: sensitive + 25h → 400 (nothing inserted), + 24h → accepted,
 *     unspecified → 4h, junk → 4h, without sql.ro → 400; ordinary mints keep
 *     the old silent clamp; the GET hands the page the cap.
 *   - The pane (jsdom, its own script): the sensitive box renders apart,
 *     unticked, with its warning; ticking asks to confirm (cancel → unticked,
 *     field untouched); accepting ticks sql.ro, caps the TTL field (max, an
 *     over-cap value pulled down, hint rewritten); an over-cap TTL typed
 *     afterwards is refused before any request; unticking restores the field.
 *
 * Run: npx jest tests/sensitiveTier.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec3-sensitive-tier-test-secret';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const roCalls = [];
jest.mock('../startup/dbReadonly', () => ({
  getConnection: async () => ({
    query: async (sql, params) => {
      roCalls.push(String(sql));
      if (/^SET SESSION/.test(sql)) return [{}];
      return [[{ n: 1 }], [{ name: 'n', columnType: 8 }]];
    },
    release() {},
  }),
}));

const guard = require('../lib/sqlGuard');
const { KEY_SCOPES } = require('../lib/capabilities');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise(r => setTimeout(r, 0));

// ─────────────────────────────────────────────────────────────
// guard matrix
// ─────────────────────────────────────────────────────────────

describe('lib/sqlGuard — two tiers', () => {
  const { deniedTable, SECRET_TABLES, SENSITIVE_TABLES, matchedSecretTable, touchesSecretTable } = guard;

  test('the registries hold exactly the ratified sets (§5.7) — adding one is an access decision', () => {
    expect(SECRET_TABLES).toEqual(['app_settings', 'email_ingest_sources']);
    expect(SENSITIVE_TABLES).toEqual([
      'jwt_api_audit_log', 'ai_calls', 'comms_transcripts', 'comms_no_transcribe', 'comms_summary_guides', 'admin_audit_log', 'readonly_query_log',
      'assistant_chats', 'assistant_chat_messages',
    ]);
  });

  test.each(['app_settings', 'email_ingest_sources'])('SECRET %s: refused with and without the scope', (t) => {
    for (const sql of [`SELECT * FROM ${t}`, `select x from \`${t.toUpperCase()}\` a`]) {
      expect(deniedTable(sql)).toEqual({ table: t, tier: 'secret' });
      expect(deniedTable(sql, { sensitive: true })).toEqual({ table: t, tier: 'secret' });
    }
  });

  test.each([
    'jwt_api_audit_log', 'ai_calls', 'comms_transcripts', 'comms_no_transcribe', 'comms_summary_guides', 'admin_audit_log', 'readonly_query_log',
    'assistant_chats', 'assistant_chat_messages',
  ])('SENSITIVE %s: refused without the scope, readable with it', (t) => {
    for (const sql of [`SELECT COUNT(*) FROM ${t}`, `SELECT a.id FROM \`${t}\` a JOIN users u ON 1`, `select 1 from ${t.toUpperCase()}`]) {
      expect(deniedTable(sql)).toEqual({ table: t, tier: 'sensitive' });
      expect(deniedTable(sql, { sensitive: false })).toEqual({ table: t, tier: 'sensitive' });
      expect(deniedTable(sql, { sensitive: true })).toBeNull();
    }
  });

  test('a statement naming a secret AND a sensitive table is refused as SECRET, even with the scope', () => {
    const sql = 'SELECT a.id FROM ai_calls a JOIN app_settings s ON 1';
    expect(deniedTable(sql)).toEqual({ table: 'app_settings', tier: 'secret' });
    expect(deniedTable(sql, { sensitive: true })).toEqual({ table: 'app_settings', tier: 'secret' });
  });

  test.each([
    'SELECT model, SUM(cost_cents) FROM ai_spend GROUP BY model',
    'SELECT * FROM ai_calls_archive',          // word match: a look-alike is not the table
    'SELECT * FROM comms_media',
    'SELECT state, SUM(est_cents) FROM comms_stt_jobs GROUP BY state',
    'SELECT * FROM rw_scratch',
    'SHOW TABLES',
  ])('readable by everyone: %s', (sql) => {
    expect(deniedTable(sql)).toBeNull();
    expect(deniedTable(sql, { sensitive: true })).toBeNull();
  });

  test('pre-SEC-3 exports keep the ordinary-key answer (secret OR sensitive)', () => {
    expect(matchedSecretTable('SELECT * FROM app_settings')).toBe('app_settings');
    expect(matchedSecretTable('SELECT * FROM comms_transcripts t')).toBe('comms_transcripts');
    expect(matchedSecretTable('SELECT * FROM admin_audit_log')).toBe('admin_audit_log');
    expect(matchedSecretTable('SELECT * FROM ai_spend')).toBeNull();
    expect(touchesSecretTable('SELECT body FROM jwt_api_audit_log')).toBe(true);
    expect(touchesSecretTable('SELECT * FROM rw_scratch')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// the endpoint — real router
// ─────────────────────────────────────────────────────────────

function listen(app, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: Object.assign({}, headers, payload ? { 'content-type': 'application/json' } : {}),
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('POST /api/readonly/sql — the tiers at the endpoint', () => {
  const router = require('../routes/api.readonly');

  async function ask(scopes, sql) {
    roCalls.length = 0;
    const logs = [];
    const db = {
      query: async (q, params = []) => {
        const s = String(q).replace(/\s+/g, ' ').trim();
        if (/FROM readonly_api_keys/.test(s)) {
          return [[{ id: 91, label: 'k', expires_at: new Date(Date.now() + 3600e3), revoked_at: null, scopes }]];
        }
        if (/^UPDATE readonly_api_keys/.test(s)) return [{}];
        if (/^INSERT INTO readonly_query_log/.test(s)) {
          const cols = s.match(/\(([^)]*)\) VALUES/)[1].split(',').map(c => c.trim());
          expect(cols).toHaveLength(params.length);
          logs.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
          return [{}];
        }
        if (/admin_audit_log/.test(s)) return [{ insertId: 1 }];
        throw new Error('unscripted: ' + s);
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    const r = await listen(app, 'POST', '/api/readonly/sql', { headers: { 'x-readonly-api-key': 'ycro_test' }, body: { sql } });
    await flush();
    return { ...r, logs, ran: roCalls.filter(q => !/^SET SESSION/.test(q)) };
  }

  const ORDINARY = ['sql.ro', 'scratch', 'alert'];
  const SENSITIVE = ['sql.ro', 'sql.ro.sensitive'];

  test.each(guard.SENSITIVE_TABLES)('%s: an ordinary key gets a 403 naming the scope; nothing runs', async (t) => {
    const r = await ask(ORDINARY, `SELECT COUNT(*) n FROM ${t}`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: `${t} needs the 'sql.ro.sensitive' scope — a short-lived sensitive session key (Admin → Session Keys)`,
      missingScope: 'sql.ro.sensitive', table: t,
    });
    expect(r.ran).toEqual([]);
    expect(r.logs).toEqual([expect.objectContaining({ api_key_id: 91, status: 'rejected_sensitive_table', sensitive_key: 0 })]);
  });

  test('a legacy NULL-scopes key is an ordinary key here (the scope is explicit)', async () => {
    const r = await ask(null, 'SELECT response FROM ai_calls LIMIT 1');
    expect(r.status).toBe(403);
    expect(r.body.missingScope).toBe('sql.ro.sensitive');
    expect(r.ran).toEqual([]);
    expect(r.logs[0]).toMatchObject({ status: 'rejected_sensitive_table', sensitive_key: 0 });
  });

  test.each(guard.SENSITIVE_TABLES)('%s: a sensitive key runs it, and the log row is flagged', async (t) => {
    const sql = `SELECT COUNT(*) n FROM ${t}`;
    const r = await ask(SENSITIVE, sql);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.ran).toEqual([sql]);
    expect(r.logs).toEqual([expect.objectContaining({ status: 'success', sensitive_key: 1, sql_text: sql })]);
  });

  test.each(guard.SECRET_TABLES)('%s: refused for EVERY key (400), the sensitive key\'s row flagged', async (t) => {
    for (const [scopes, flag] of [[ORDINARY, 0], [null, 0], [SENSITIVE, 1]]) {
      const r = await ask(scopes, `SELECT * FROM ${t}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(`${t} is not readable through this endpoint (use the SU db console)`);
      expect(r.ran).toEqual([]);
      expect(r.logs).toEqual([expect.objectContaining({ status: 'rejected_secret_table', sensitive_key: flag })]);
    }
  });

  test('ai_spend (the metadata view) runs for an ordinary key, unflagged', async () => {
    const sql = 'SELECT model, SUM(cost_cents) FROM ai_spend GROUP BY model';
    const r = await ask(ORDINARY, sql);
    expect(r.status).toBe(200);
    expect(r.ran).toEqual([sql]);
    expect(r.logs[0]).toMatchObject({ status: 'success', sensitive_key: 0 });
  });

  test('every row a sensitive key writes is flagged — rejections included', async () => {
    const r = await ask(SENSITIVE, 'DELETE FROM users');
    expect(r.status).toBe(400);
    expect(r.logs[0]).toMatchObject({ status: 'rejected_not_readonly', sensitive_key: 1 });
  });

  test('["sql.ro.sensitive"] alone does not open the endpoint — the sql.ro surface gate refuses it', async () => {
    const r = await ask(['sql.ro.sensitive'], 'SELECT 1');
    expect(r.status).toBe(403);
    expect(r.body.missingScope).toBe('sql.ro');
    expect(r.ran).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// the mint cap
// ─────────────────────────────────────────────────────────────

describe('POST /api/readonly-keys — the sensitive mint cap', () => {
  const router = require('../routes/api.readonlyKeys');
  const { mintElevationToken } = require('../lib/auth.superuser');

  async function mint(body, method = 'POST', url = '/api/readonly-keys') {
    const calls = [];
    const db = {
      query: async (q, params = []) => {
        const s = String(q).replace(/\s+/g, ' ').trim();
        calls.push({ sql: s, params });
        if (/admin_audit_log|jwt_api_audit_log/.test(s)) return [{ insertId: 1 }];
        if (/^INSERT INTO readonly_api_keys/.test(s)) return [{ insertId: 92 }];
        if (/FROM readonly_api_keys k/.test(s)) return [[]];
        throw new Error('unscripted: ' + s);
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    const token = jwt.sign({ sub: 6, username: 'IT', user_type: 1, user_auth: 'authorized', roles: ['su'], aud: 'staff' },
      process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await listen(app, method, url, {
      headers: { authorization: 'Bearer ' + token, 'x-su-elevation': mintElevationToken(6) }, body,
    });
    const ins = calls.find(c => /^INSERT INTO readonly_api_keys/.test(c.sql));
    return { ...r, ins };
  }
  const S = ['sql.ro', 'sql.ro.sensitive'];
  const hoursFromNow = (iso) => (new Date(iso).getTime() - Date.now()) / 3600e3;

  test('25h (1500 min) → 400 naming the cap; nothing inserted', async () => {
    const r = await mint({ label: 'diag', scopes: S, ttlMinutes: 1500 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'a sql.ro.sensitive key lives at most 1440 minutes (24h); asked for 1500', maxTtlMinutes: 1440 });
    expect(r.ins).toBeUndefined();
  });

  test('1441 min → 400; 1440 min (24h) → accepted at exactly 24h', async () => {
    expect((await mint({ label: 'diag', scopes: S, ttlMinutes: 1441 })).status).toBe(400);
    const r = await mint({ label: 'diag', scopes: S, ttlMinutes: 1440 });
    expect(r.status).toBe(200);
    expect(r.body.ttlMinutes).toBe(1440);
    expect(hoursFromNow(r.body.expiresAt)).toBeCloseTo(24, 1);
    expect(hoursFromNow(r.ins.params[4])).toBeCloseTo(24, 1);   // the stored expires_at, not just the reply
    expect(JSON.parse(r.ins.params[5])).toEqual(S);
  });

  test('unspecified → 4h default; a junk / non-positive TTL → 4h, never the 1-day default', async () => {
    for (const ttlMinutes of [undefined, null, '', 'abc', 0, -5]) {
      const r = await mint({ label: 'diag', scopes: S, ttlMinutes });
      expect([ttlMinutes, r.status, r.body.ttlMinutes]).toEqual([ttlMinutes, 200, 240]);
      expect(hoursFromNow(r.body.expiresAt)).toBeCloseTo(4, 1);
      expect(hoursFromNow(r.ins.params[4])).toBeCloseTo(4, 1);
    }
  });

  test('a short sensitive TTL is kept as asked', async () => {
    const r = await mint({ label: 'diag', scopes: ['sql.ro', 'scratch', 'sql.ro.sensitive'], ttlMinutes: 30 });
    expect([r.status, r.body.ttlMinutes]).toEqual([200, 30]);
  });

  test('sql.ro.sensitive without sql.ro → 400, nothing inserted (never an implicit add)', async () => {
    const r = await mint({ label: 'diag', scopes: ['sql.ro.sensitive', 'scratch'], ttlMinutes: 60 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/needs sql\.ro too/);
    expect(r.ins).toBeUndefined();
  });

  test('ordinary mints are unchanged: default 1 day, an over-long ask silently clamped to the max', async () => {
    const d = await mint({ label: 'plain' });
    expect([d.status, d.body.ttlMinutes]).toEqual([200, 1440]);
    expect(d.body.scopes).toEqual(['sql.ro', 'scratch', 'alert']);       // the default never carries it
    const long = await mint({ label: 'plain', scopes: ['sql.ro'], ttlMinutes: 99999 });
    expect([long.status, long.body.ttlMinutes]).toEqual([200, 3 * 1440]);
  });

  test('the GET hands the page the scope and its cap (no copy in the page)', async () => {
    const r = await mint(undefined, 'GET', '/api/readonly-keys');
    expect(r.status).toBe(200);
    expect(r.body.sensitive_scope).toEqual({ name: 'sql.ro.sensitive', max_ttl_minutes: 1440, default_ttl_minutes: 240 });
    expect(r.body.default_scopes).not.toContain('sql.ro.sensitive');
    expect(r.body.scope_vocabulary.map(v => v.name)).toContain('sql.ro.sensitive');
  });
});

// ─────────────────────────────────────────────────────────────
// the pane
// ─────────────────────────────────────────────────────────────

describe('readonlyKeys.html — the sensitive box', () => {
  const VOCAB = Object.entries(KEY_SCOPES).map(([name, v]) => ({ name, desc: v.desc }));
  const SENS = { name: 'sql.ro.sensitive', max_ttl_minutes: 1440, default_ttl_minutes: 240 };

  async function boot({ confirmAnswer = true } = {}) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'readonlyKeys.html'), 'utf8');
    const sent = [];
    const confirms = [];
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(w) {
        w.alert = (m) => sent.push({ alert: m });
        w.confirm = (m) => { confirms.push(m); return confirmAnswer; };
        w.apiSend = async (url, method, body) => {
          sent.push({ url, method, body });
          if (method === 'GET') {
            return { ok: true, keys: [], max_ttl_days: 3, scope_vocabulary: VOCAB, default_scopes: ['sql.ro', 'scratch', 'alert'], sensitive_scope: SENS };
          }
          return { ok: true, key: 'ycro_x', label: body.label, scopes: body.scopes, expiresAt: new Date().toISOString(), ttlMinutes: 240 };
        };
      },
    });
    await flush(); await flush();
    const d = dom.window.document;
    const box = () => d.querySelector('.sensitive-box');
    const tick = (on) => { box().checked = on; box().dispatchEvent(new dom.window.Event('change')); };
    return { w: dom.window, d, sent, confirms, box, tick };
  }
  const posts = (sent) => sent.filter(s => s.method === 'POST');

  test('renders apart from the other scopes, unticked, with its warning shown', async () => {
    const { d, box } = await boot();
    expect(d.querySelector('#scopePicker .scope-box[value="sql.ro.sensitive"]')).toBeNull();
    expect(d.querySelector('#sensitivePicker .sensitive-box')).toBe(box());
    expect(box().checked).toBe(false);
    expect(d.getElementById('sensitivePicker').style.display).toBe('');
    expect(d.getElementById('sensitiveWarn').style.display).toBe('');
    expect(d.getElementById('sensitiveWarn').textContent).toMatch(/at most\s+24\s*h, default\s+4\s*h/);
  });

  test('cancelling the confirm leaves it unticked and the TTL field untouched', async () => {
    const { d, box, tick, confirms } = await boot({ confirmAnswer: false });
    d.getElementById('newTtl').value = '2000';
    tick(true);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatch(/sql\.ro\.sensitive/);
    expect(box().checked).toBe(false);
    expect(d.getElementById('newTtl').value).toBe('2000');
    expect(d.getElementById('newTtl').hasAttribute('max')).toBe(false);
  });

  test('accepting: sql.ro ticked, the TTL field capped and its hint rewritten; untick restores', async () => {
    const { d, tick } = await boot();
    const ro = d.querySelector('.scope-box[value="sql.ro"]');
    ro.checked = false;
    const ttl = d.getElementById('newTtl');
    const hint = d.getElementById('ttlHint');
    const before = hint.innerHTML;
    ttl.value = '2000';
    tick(true);
    expect(ro.checked).toBe(true);
    expect(ttl.getAttribute('max')).toBe('1440');
    expect(ttl.value).toBe('1440');
    expect(hint.textContent).toBe('Sensitive key: default 240 min (4h). Max 1440 min (24h).');
    tick(false);
    expect(ttl.hasAttribute('max')).toBe(false);
    expect(hint.innerHTML).toBe(before);
  });

  test('Create sends the sensitive scope; an over-cap TTL typed afterwards is refused before any request', async () => {
    const { d, w, sent, tick } = await boot();
    d.getElementById('newLabel').value = 'diag';
    tick(true);
    d.getElementById('newTtl').value = '1500';
    await w.createKey();
    expect(posts(sent)).toEqual([]);
    expect(sent.some(s => s.alert && /at most 1440 minutes/.test(s.alert))).toBe(true);
    d.getElementById('newTtl').value = '';
    await w.createKey();
    expect(posts(sent)).toHaveLength(1);
    expect(posts(sent)[0].body.scopes).toEqual(['sql.ro', 'scratch', 'alert', 'sql.ro.sensitive']);
    expect(posts(sent)[0].body.ttlMinutes).toBeUndefined();     // the server's 4h default applies
  });
});

// ─────────────────────────────────────────────────────────────
// the migration's statements (always-on pins; the engine run is
// tests/sensitiveTier.mysql.test.js, skipped without the twin)
// ─────────────────────────────────────────────────────────────

describe('scripts/accessSec3SensitiveTier — the statements', () => {
  const script = require('../scripts/accessSec3SensitiveTier');

  test('the ALTER refuses a table copy (ALGORITHM=INSTANT) and avoids the reserved word SENSITIVE', () => {
    expect(script.ALTER_SQL).toMatch(/, ALGORITHM=INSTANT$/);
    expect(script.ALTER_SQL).toMatch(/ADD COLUMN `sensitive_key` tinyint\(1\) NOT NULL DEFAULT 0 /);
  });

  test('the view is SQL SECURITY INVOKER over the 13 metadata columns — no content column', () => {
    expect(script.VIEW_SQL).toMatch(/^CREATE SQL SECURITY INVOKER VIEW `ai_spend` AS SELECT /);
    expect(script.SPEND_COLUMNS).toEqual([
      'id', 'created_at', 'prompt_key', 'prompt_version', 'model', 'mode', 'output_type',
      'consumer_ref', 'status', 'input_tokens', 'output_tokens', 'cost_cents', 'latency_ms',
    ]);
    expect(script.VIEW_SQL).not.toMatch(/error|request_excerpt|response/);
  });

  test('the endpoint writes the same column the migration adds', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'api.readonly.js'), 'utf8');
    expect(src).toMatch(/row_count, duration_ms, status, sensitive_key, error_text\)/);
  });
});
