// tests/mailboxS0.test.js
//
/**
 * Mailbox system S0 — routes/api.mailboxes.js + services/mailboxService.js
 * (ref/MAILBOX_SYSTEM_DESIGN.md §3, D6). Run: npx jest tests/mailboxS0.test.js
 *
 * HARNESS. The REAL router, service, lib/auth.jwtOrApiKey, lib/auth.superuser
 * and lib/credentialCrypto run over an express app on an ephemeral port. Only
 * the database is faked — CI has no MySQL — and the fake is a small STATEFUL
 * evaluator, not scripted results (tests/helpers/ctaWorld.js idea): SELECT
 * projections, JOINs, correlated COUNT subqueries and WHERE conjunctions are
 * evaluated from the statement text against stored rows, so editing the
 * service's SQL changes what the fake returns. Unknown statement shapes THROW.
 *
 * What this pins (each was mutation-checked — break it, watch a test fail):
 *   - imap_secret is write-only: encrypted (ENCv1) at rest, never in any
 *     response, never in admin_audit_log, redacted from jwt_api_audit_log,
 *     and NEVER SELECTed (every executed SELECT is inspected).
 *   - the S0 channel gate: a phone_line grant write is a 400 on both the SU
 *     and the manager path, and writes no row.
 *   - SU bypass comes from the DB (users.user_auth), and SU-bypass WRITES need
 *     step-up elevation; reads do not.
 *   - a non-SU can_manage holder stays inside their box: other boxes 404,
 *     connection/plumbing fields 403, grant rows ownership-scoped to :id.
 *   - changing imap_host/imap_port requires imap_secret in the same write.
 *   - x-api-key callers are refused (grants resolve against a human).
 *
 * The same scenarios were also run against a real MySQL 8.0 engine with the
 * migration applied (worker verification, 2026-10-08).
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mailbox-s0-test-secret';
process.env.INTERNAL_API_KEY = 'yci_mailbox_s0_internal';
delete process.env.SU_STEPUP; // step-up ON (the default)

const express = require('express');
const jwt = require('jsonwebtoken');
const { mintElevationToken } = require('../lib/auth.superuser');
const { decrypt } = require('../lib/credentialCrypto');
const svc = require('../services/mailboxService');
const router = require('../routes/api.mailboxes');

// ─────────────────────────────────────────────────────────────────────────────
// Stateful fake DB
// ─────────────────────────────────────────────────────────────────────────────

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/** Positional `?` binder — one per statement evaluation (a cursor, not a script). */
function binder(list) {
  let i = 0;
  return { next: () => list[i++] };
}

/** Split `s` on `sep` at paren depth 0, outside single quotes. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  const re = new RegExp(`^${sep}`, 'i');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quote = !quote;
    if (!quote) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && re.test(s.slice(i))) {
        out.push(cur.trim());
        cur = '';
        i += s.slice(i).match(re)[0].length - 1;
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Strip one pair of wrapping parens if they enclose the whole string. */
function unwrap(s) {
  s = s.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    if (depth === 0 && i < s.length - 1) return s;
  }
  return s.slice(1, -1).trim();
}

function makeWorld() {
  const T = {
    users: [
      { user: 0, username: 'automations', user_name: 'Automations', user_auth: 'authorized' },
      { user: 1, username: 'Ssandweiss', user_name: 'Stuart', user_auth: 'authorized' },
      { user: 5, username: 'sb', user_name: 'Shoshana', user_auth: 'authorized' },
      { user: 6, username: 'IT', user_name: 'Fred', user_auth: 'authorized - SU' },
      // JWT will claim SU for user 7; the DB says otherwise.
      { user: 7, username: 'demoted', user_name: 'Demoted', user_auth: 'authorized' },
      { user: 22, username: 'RENA', user_name: 'Rena', user_auth: 'authorized' },
    ],
    email_credentials: [{ id: 3, email: 'billing@4lsg.com' }],
    // S1-G: the emission override validates against these (api_key omitted —
    // the service never selects it).
    email_ingest_sources: [
      { id: 3, name: 'mailbox-imap', active: 1 },
      { id: 1, name: 'gmail-firm', active: 1 },
      { id: 4, name: 'dead-relay', active: 0 },
    ],
    mailboxes: [],
    channel_grants: [],
    admin_audit_log: [],
    jwt_api_audit_log: [],
    api_keys: [],
  };
  const seq = { mailboxes: 0, channel_grants: 0 };
  const selects = []; // every executed SELECT (normalized)

  const dup = (msg) => Object.assign(new Error(`Duplicate entry ${msg}`), { code: 'ER_DUP_ENTRY' });

  function uniqueCheck(table, row, self) {
    const rows = T[table].filter(r => r !== self);
    if (table === 'mailboxes' &&
        rows.some(r => String(r.address).toLowerCase() === String(row.address).toLowerCase())) {
      throw dup(`'${row.address}' for key 'uq_mailboxes_address'`);
    }
    if (table === 'channel_grants' &&
        rows.some(r => r.user === row.user && r.channel_type === row.channel_type &&
                       r.channel_id === row.channel_id)) {
      throw dup(`for key 'uq_channel_grants_user_channel'`);
    }
  }

  // ── expression evaluation over a context { alias: row|null } ──
  function resolveRef(ref, ctx, defAlias) {
    const m = /^([a-z_]+)\.([a-z_]+)$/i.exec(ref);
    if (m) {
      if (!(m[1] in ctx)) throw new Error(`fake: unknown alias ${m[1]} in ${ref}`);
      return ctx[m[1]] ? ctx[m[1]][m[2]] : null;
    }
    if (/^[a-z_]+$/i.test(ref)) return ctx[defAlias] ? ctx[defAlias][ref] : null;
    throw new Error(`fake: unsupported ref ${ref}`);
  }

  function evalOperand(tok, ctx, defAlias, params) {
    tok = tok.trim();
    if (tok === '?') return params.next();
    if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
    if (/^-?\d+$/.test(tok)) return Number(tok);
    return resolveRef(tok, ctx, defAlias);
  }

  const loose = (a, b) => (a == null || b == null) ? false
    : (typeof a === 'string' && typeof b === 'string') ? a.toLowerCase() === b.toLowerCase()
    : String(a) === String(b);

  function evalCond(expr, ctx, defAlias, params) {
    expr = unwrap(expr);
    const ands = splitTop(expr, ' AND ');
    if (ands.length > 1) return ands.map(e => evalCond(e, ctx, defAlias, params)).every(Boolean);
    const ors = splitTop(expr, ' OR ');
    if (ors.length > 1) {
      // evaluate all (consume params deterministically), then OR
      return ors.map(e => evalCond(e, ctx, defAlias, params)).some(Boolean);
    }
    let m;
    if ((m = /^(\S+) IS NOT NULL$/i.exec(expr))) return evalOperand(m[1], ctx, defAlias, params) != null;
    if ((m = /^(\S+) IS NULL$/i.exec(expr))) return evalOperand(m[1], ctx, defAlias, params) == null;
    if ((m = /^(\S+) <> (\S+)$/.exec(expr))) {
      const a = evalOperand(m[1], ctx, defAlias, params);
      const b = evalOperand(m[2], ctx, defAlias, params);
      return a != null && b != null && !loose(a, b);
    }
    if ((m = /^(\S+) = (\S+)$/.exec(expr))) {
      return loose(evalOperand(m[1], ctx, defAlias, params), evalOperand(m[2], ctx, defAlias, params));
    }
    throw new Error(`fake: unsupported condition: ${expr}`);
  }

  // ── FROM parsing: base table + joins ──
  function parseFrom(from) {
    const parts = from.split(/ (LEFT JOIN|JOIN) /i);
    const [baseTable, baseAlias] = parts[0].trim().split(/\s+/);
    const joins = [];
    for (let i = 1; i < parts.length; i += 2) {
      const m = /^(\w+) (\w+) ON (.+)$/i.exec(parts[i + 1].trim());
      if (!m) throw new Error(`fake: unsupported join: ${parts[i + 1]}`);
      joins.push({ left: /LEFT/i.test(parts[i]), table: m[1], alias: m[2], on: m[3] });
    }
    return { baseTable, baseAlias: baseAlias || baseTable, joins };
  }

  function contexts(from, outer) {
    const { baseTable, baseAlias, joins } = parseFrom(from);
    if (!T[baseTable]) throw new Error(`fake: unknown table ${baseTable}`);
    let ctxs = T[baseTable].map(r => ({ ...outer, [baseAlias]: r }));
    for (const j of joins) {
      if (!T[j.table]) throw new Error(`fake: unknown table ${j.table}`);
      const next = [];
      for (const c of ctxs) {
        const hits = T[j.table].filter(r => evalCond(j.on, { ...c, [j.alias]: r }, baseAlias, binder([])));
        if (hits.length) hits.forEach(r => next.push({ ...c, [j.alias]: r }));
        else if (j.left) next.push({ ...c, [j.alias]: null });
      }
      ctxs = next;
    }
    return { ctxs, defAlias: baseAlias };
  }

  function evalSelectItem(item, ctx, defAlias) {
    let m;
    // correlated COUNT(*) subquery
    if ((m = /^\(SELECT COUNT\(\*\) FROM (.+?) WHERE (.+)\) AS (\w+)$/i.exec(item))) {
      const sub = contexts(m[1], ctx);
      return [m[3], sub.ctxs.filter(c => evalCond(m[2], c, sub.defAlias, binder([]))).length];
    }
    // boolean expression aliased
    if ((m = /^(\(.+\)) AS (\w+)$/i.exec(item))) {
      return [m[2], evalCond(m[1], ctx, defAlias, binder([])) ? 1 : 0];
    }
    if ((m = /^(\S+) AS (\w+)$/i.exec(item))) return [m[2], resolveRef(m[1], ctx, defAlias)];
    if ((m = /^(?:(\w+)\.)?(\w+)$/.exec(item))) return [m[2], resolveRef(item, ctx, defAlias)];
    throw new Error(`fake: unsupported select item: ${item}`);
  }

  /** Clause boundaries at paren depth 0 (a subquery's FROM/WHERE is not ours). */
  function topLevelClauses(sql) {
    const kws = [' FROM ', ' WHERE ', ' ORDER BY ', ' LIMIT '];
    const at = {};
    let depth = 0;
    let quote = false;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'") quote = !quote;
      if (quote) continue;
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0) {
        for (const k of kws) {
          if (at[k] === undefined && sql.substr(i, k.length).toUpperCase() === k) at[k] = i;
        }
      }
    }
    if (!/^SELECT /i.test(sql) || at[' FROM '] === undefined) {
      throw new Error(`fake: unsupported SELECT: ${sql}`);
    }
    const order = kws.filter(k => at[k] !== undefined).sort((a, b) => at[a] - at[b]);
    const piece = (k) => {
      if (at[k] === undefined) return undefined;
      const next = order[order.indexOf(k) + 1];
      return sql.slice(at[k] + k.length, next === undefined ? sql.length : at[next]).trim();
    };
    return {
      list: sql.slice('SELECT '.length, at[' FROM ']).trim(),
      from: piece(' FROM '),
      where: piece(' WHERE '),
      order: piece(' ORDER BY '),
      limit: piece(' LIMIT '),
    };
  }

  function runSelect(sql, params) {
    const { list, from, where, order, limit } = topLevelClauses(sql);
    const { ctxs, defAlias } = contexts(from, {});
    let hits = where ? ctxs.filter(c => evalCond(where, c, defAlias, binder(params))) : ctxs;
    if (order) {
      const keys = order.split(',').map(s => s.trim().replace(/ ASC$/i, ''));
      hits = [...hits].sort((a, b) => {
        for (const k of keys) {
          const x = resolveRef(k, a, defAlias); const y = resolveRef(k, b, defAlias);
          if (x == null && y == null) continue;
          if (x == null) return -1; if (y == null) return 1;
          if (x < y) return -1; if (x > y) return 1;
        }
        return 0;
      });
    }
    if (limit) hits = hits.slice(0, Number(limit));
    const items = splitTop(list, ',');
    return hits.map(c => Object.fromEntries(items.map(it => evalSelectItem(it, c, defAlias))));
  }

  const now = () => new Date('2026-10-08T12:00:00Z');

  async function query(rawSql, params = []) {
    const sql = norm(rawSql);
    let m;

    if (/^INSERT INTO jwt_api_audit_log/i.test(sql)) {
      T.jwt_api_audit_log.push({ body: params[4], route: params[0], method: params[1] });
      return [{ insertId: T.jwt_api_audit_log.length, affectedRows: 1 }];
    }
    if (/^INSERT INTO admin_audit_log/i.test(sql)) {
      T.admin_audit_log.push({ tool: params[0], status: params[5], details: params[10] });
      return [{ insertId: T.admin_audit_log.length, affectedRows: 1 }];
    }
    if ((m = /^INSERT INTO (mailboxes|channel_grants) \((.+?)\) VALUES \((.+)\)$/i.exec(sql))) {
      const table = m[1];
      const cols = m[2].split(',').map(s => s.trim());
      const row = table === 'mailboxes'
        ? { imap_port: 993, ingest_enabled: 1, active: 1, display_name: null, imap_secret: null,
            send_credential_id: null, ingest_folders: null, ingest_state: null }
        : {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      uniqueCheck(table, row, null);
      row.id = ++seq[table];
      row.created_at = now();
      if (table === 'mailboxes') row.updated_at = now();
      T[table].push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if ((m = /^UPDATE (mailboxes|channel_grants) SET (.+?) WHERE (.+)$/i.exec(sql))) {
      const table = m[1];
      const sets = m[2].split(',').map(s => s.trim().replace(/ = \?$/, ''));
      const vals = params.slice(0, sets.length);
      const rest = params.slice(sets.length);
      const hits = T[table].filter(r => evalCond(m[3], { [table]: r }, table, binder(rest)));
      for (const r of hits) {
        const next = { ...r };
        sets.forEach((c, i) => { next[c] = vals[i]; });
        uniqueCheck(table, next, r);
        Object.assign(r, next);
      }
      return [{ affectedRows: hits.length }];
    }
    if ((m = /^DELETE FROM (channel_grants) WHERE (.+)$/i.exec(sql))) {
      const before = T[m[1]].length;
      T[m[1]] = T[m[1]].filter(r => !evalCond(m[2], { [m[1]]: r }, m[1], binder(params)));
      return [{ affectedRows: before - T[m[1]].length }];
    }
    if (/^SELECT /i.test(sql)) {
      selects.push(sql);
      // JSON columns come back parsed from mysql2 — mirror that.
      const rows = runSelect(sql, params).map(r => {
        for (const k of ['ingest_folders', 'ingest_state']) {
          if (typeof r[k] === 'string') r[k] = JSON.parse(r[k]);
        }
        return r;
      });
      return [rows];
    }
    throw new Error(`fake: unscripted statement: ${sql}`);
  }

  return { T, selects, db: { query } };
}

// ─────────────────────────────────────────────────────────────────────────────
// App harness
// ─────────────────────────────────────────────────────────────────────────────

let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(router);

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { W = makeWorld(); require('../lib/auth.superuser')._resetRateLimits(); });

const tok = (user, user_auth = 'authorized') =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth, aud: 'staff' }, process.env.JWT_SECRET);
const SU = () => tok(6, 'authorized - SU');
const ELEV = () => mintElevationToken(6);

async function call(method, url, { t, body, elev, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (elev) headers['X-SU-Elevation'] = elev;
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-json */ }
  return { status: r.status, json, text };
}

const SECRET = 'Plain-Pa55-XYZZY';

async function seedMailbox(extra = {}) {
  const r = await call('POST', '/api/mailboxes', {
    t: SU(), elev: ELEV(),
    body: { address: 'billing@4lsg.com', imap_host: 'gcam1191.siteground.biz',
            imap_user: 'billing@4lsg.com', imap_secret: SECRET, ...extra },
  });
  expect(r.status).toBe(201);
  return r.json.id;
}

async function seedGrant(mailboxId, body) {
  const r = await call('POST', `/api/mailboxes/${mailboxId}/grants`, { t: SU(), elev: ELEV(), body });
  expect(r.status).toBe(201);
  return r.json.grant.id;
}

// The one place imap_secret may appear in a SELECT: the has_secret boolean.
const HAS_SECRET_EXPR = "(m.imap_secret IS NOT NULL AND m.imap_secret <> '') AS has_secret";
function assertSecretNeverSelected() {
  const offenders = W.selects.filter(s => s.split(HAS_SECRET_EXPR).join('').includes('imap_secret'));
  expect(offenders).toEqual([]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('imap_secret is write-only', () => {
  test('encrypted at rest; absent from every response; never SELECTed', async () => {
    const id = await seedMailbox({ address: '  Billing@4LSG.com ', send_credential_id: 3 });
    const row = W.T.mailboxes.find(r => r.id === id);
    expect(row.imap_secret.startsWith('ENCv1:')).toBe(true);
    expect(decrypt(row.imap_secret)).toBe(SECRET);
    expect(row.address).toBe('billing@4lsg.com');
    expect(row.domain).toBe('4lsg.com');
    expect(JSON.parse(row.ingest_folders)).toEqual({ INBOX: { emit_to_rules: true } });

    await seedGrant(id, { user: 5, can_read: true, can_manage: true });
    const responses = [
      await call('GET', '/api/mailboxes', { t: SU() }),
      await call('GET', '/api/mailboxes', { t: tok(5) }),
      await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { display_name: 'Billing' } }),
      await call('PATCH', `/api/mailboxes/${id}`, { t: tok(5), body: { display_name: 'Billing 2' } }),
      await call('GET', `/api/mailboxes/${id}/grants`, { t: SU() }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain('ENCv1');
      expect(r.text).not.toContain('imap_secret');
    }
    const suRow = responses[0].json.mailboxes[0];
    expect(suRow.has_secret).toBe(true);
    expect(suRow.send_credential_email).toBe('billing@4lsg.com');
    expect(suRow.grant_count).toBe(1);
    assertSecretNeverSelected();
  });

  test('PATCH semantics: absent = untouched, "" = clear, value = re-encrypt', async () => {
    const id = await seedMailbox();
    const row = () => W.T.mailboxes.find(r => r.id === id);
    let r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { display_name: 'x' } });
    expect(r.status).toBe(200);
    expect(decrypt(row().imap_secret)).toBe(SECRET);
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_secret: 'Second-1' } });
    expect(r.status).toBe(200);
    expect(decrypt(row().imap_secret)).toBe('Second-1');
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_secret: '' } });
    expect(r.status).toBe(200);
    expect(row().imap_secret).toBeNull();
    expect(r.json.mailbox.has_secret).toBe(false);
  });

  test('no secret in admin_audit_log; redacted in jwt_api_audit_log', async () => {
    const id = await seedMailbox();
    await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_secret: 'Second-1' } });
    const audit = JSON.stringify(W.T.admin_audit_log);
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain('Second-1');
    expect(audit).not.toContain('ENCv1');
    const upd = W.T.admin_audit_log.map(a => JSON.parse(a.details || 'null'))
      .find(d => d && d.action === 'mailbox_update');
    expect(upd.diff.imap_secret).toBe('set');

    const log = JSON.stringify(W.T.jwt_api_audit_log);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('Second-1');
    expect(W.T.jwt_api_audit_log.some(l => JSON.parse(l.body).imap_secret === '[REDACTED]')).toBe(true);
  });
});

describe('S0 channel gate', () => {
  test('phone_line grant write is a 400 on the SU and the manager path, and writes nothing', async () => {
    const id = await seedMailbox();
    await seedGrant(id, { user: 5, can_manage: true });
    const before = W.T.channel_grants.length;

    let r = await call('POST', `/api/mailboxes/${id}/grants`, {
      t: SU(), elev: ELEV(), body: { user: 22, can_read: true, channel_type: 'phone_line' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/phone slice/);

    r = await call('POST', `/api/mailboxes/${id}/grants`, {
      t: tok(5), body: { user: 22, can_read: true, channel_type: 'phone_line' },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/phone slice/);

    r = await call('POST', `/api/mailboxes/${id}/grants`, {
      t: SU(), elev: ELEV(), body: { user: 22, can_read: true, channel_type: 'fax' },
    });
    expect(r.status).toBe(400);

    expect(W.T.channel_grants.length).toBe(before);
    expect(W.T.channel_grants.every(g => g.channel_type === 'mailbox')).toBe(true);
  });

  test('service: reads accept phone_line (and find nothing); writes refuse it', async () => {
    W = makeWorld();
    await expect(svc.createGrant(W.db, {
      channelType: 'phone_line', channelId: 1, body: { user: 5, can_read: true }, grantedBy: 6,
    })).rejects.toMatchObject({ status: 400 });
    expect(await svc.listReadable(W.db, 5, 'phone_line')).toEqual([]);
    expect(await svc.getAccess(W.db, 5, 'phone_line', 1))
      .toEqual({ can_read: false, can_send: false, can_manage: false, su: false });
    await expect(svc.getAccess(W.db, 5, 'sms', 1)).rejects.toMatchObject({ status: 400 });
  });
});

describe('SU bypass and step-up', () => {
  test('SU writes need elevation; SU reads do not', async () => {
    let r = await call('POST', '/api/mailboxes', {
      t: SU(), body: { address: 'a@b.com', imap_host: 'h.example.com', imap_user: 'u' },
    });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('elevation_required');

    const id = await seedMailbox();
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), body: { display_name: 'x' } });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('elevation_required');
    r = await call('POST', `/api/mailboxes/${id}/grants`, { t: SU(), body: { user: 5, can_read: true } });
    expect(r.status).toBe(401);

    expect((await call('GET', '/api/mailboxes', { t: SU() })).status).toBe(200);
    expect((await call('GET', `/api/mailboxes/${id}/grants`, { t: SU() })).status).toBe(200);
    expect(W.T.admin_audit_log.some(a => a.status === 'rejected_no_elevation')).toBe(true);
  });

  test('the bypass is DB-sourced: a JWT claiming SU for a non-SU user gets no bypass', async () => {
    const id = await seedMailbox();
    const fake = tok(7, 'authorized - SU');
    const elev7 = mintElevationToken(7);
    expect((await call('PATCH', `/api/mailboxes/${id}`, { t: fake, elev: elev7, body: { display_name: 'x' } })).status).toBe(404);
    const list = await call('GET', '/api/mailboxes', { t: fake });
    expect(list.json.viewer.su).toBe(false);
    expect(list.json.mailboxes).toEqual([]);
    const post = await call('POST', '/api/mailboxes', {
      t: fake, elev: elev7, body: { address: 'z@b.com', imap_host: 'h.example.com', imap_user: 'u' },
    });
    expect(post.status).toBe(403);
    expect(W.T.mailboxes.length).toBe(1);
  });

  test('x-api-key callers are refused', async () => {
    const r = await call('GET', '/api/mailboxes', { apiKey: process.env.INTERNAL_API_KEY });
    expect(r.status).toBe(403);
  });
});

describe('manager scope — no escalation beyond the box', () => {
  let box1;
  let box2;
  beforeEach(async () => {
    box1 = await seedMailbox();
    const r = await call('POST', '/api/mailboxes', {
      t: SU(), elev: ELEV(),
      body: { address: 'shoshana@mdbl.com', imap_host: 'imap.gmail.com', imap_user: 'shoshana' },
    });
    box2 = r.json.id;
    await seedGrant(box1, { user: 5, can_read: true, can_manage: true });
  });

  test('lists only their box, in the public projection', async () => {
    const r = await call('GET', '/api/mailboxes', { t: tok(5) });
    expect(r.json.mailboxes.map(m => m.id)).toEqual([box1]);
    const row = r.json.mailboxes[0];
    for (const k of ['imap_host', 'imap_user', 'imap_port', 'has_secret', 'send_credential_id', 'ingest_folders']) {
      expect(row).not.toHaveProperty(k);
    }
    expect(row.access).toEqual({ can_read: true, can_send: false, can_manage: true, su: false });
    assertSecretNeverSelected();
  });

  test('can grant on their box without elevation; cannot touch another box', async () => {
    let r = await call('POST', `/api/mailboxes/${box1}/grants`, { t: tok(5), body: { user: 22, can_read: true } });
    expect(r.status).toBe(201);
    expect(r.json.grant.granted_by).toBe(5);
    r = await call('POST', `/api/mailboxes/${box2}/grants`, { t: tok(5), body: { user: 5, can_read: true } });
    expect(r.status).toBe(404);
    r = await call('GET', `/api/mailboxes/${box2}/grants`, { t: tok(5) });
    expect(r.status).toBe(404);
  });

  test.each([
    ['imap_host', 'evil.example.com'],
    ['imap_port', 143],
    ['imap_user', 'other'],
    ['imap_secret', 'x'],
    ['send_credential_id', 3],
    ['ingest_enabled', false],
    ['ingest_folders', { INBOX: { emit_to_rules: false } }],
    ['active', false],
    ['address', 'b@4lsg.com'],
  ])('PATCH %s is SU-only (403, nothing written)', async (field, value) => {
    const before = JSON.stringify(W.T.mailboxes);
    const r = await call('PATCH', `/api/mailboxes/${box1}`, { t: tok(5), body: { [field]: value } });
    expect(r.status).toBe(403);
    expect(r.json.message).toContain(field);
    expect(JSON.stringify(W.T.mailboxes)).toBe(before);
  });

  test('display_name is theirs to edit', async () => {
    const r = await call('PATCH', `/api/mailboxes/${box1}`, { t: tok(5), body: { display_name: 'Billing Dept' } });
    expect(r.status).toBe(200);
    expect(W.T.mailboxes.find(m => m.id === box1).display_name).toBe('Billing Dept');
  });

  test('grant rows are ownership-scoped to :id', async () => {
    const g = await seedGrant(box1, { user: 22, can_read: true });
    await seedGrant(box2, { user: 5, can_manage: true }); // passes the box2 access check
    let r = await call('PATCH', `/api/mailboxes/${box2}/grants/${g}`, { t: tok(5), body: { can_send: true } });
    expect(r.status).toBe(404);
    r = await call('DELETE', `/api/mailboxes/${box2}/grants/${g}`, { t: tok(5) });
    expect(r.status).toBe(404);
    expect(W.T.channel_grants.find(x => x.id === g)).toMatchObject({ can_send: 0 });
    const others = W.T.channel_grants.filter(x => x.id !== g).map(x => x.id);
    expect(others.length).toBe(2); // SB on box1 + SB on box2
    r = await call('DELETE', `/api/mailboxes/${box1}/grants/${g}`, { t: tok(5) });
    expect(r.status).toBe(200);
    expect(W.T.channel_grants.find(x => x.id === g)).toBeUndefined();
    // exactly that row: the DELETE is keyed on id, not just the channel
    expect(W.T.channel_grants.map(x => x.id).sort()).toEqual(others.sort());
  });

  test('a reader is not a manager', async () => {
    await seedGrant(box1, { user: 22, can_read: true });
    expect((await call('GET', `/api/mailboxes/${box1}/grants`, { t: tok(22) })).status).toBe(403);
    expect((await call('PATCH', `/api/mailboxes/${box1}`, { t: tok(22), body: { display_name: 'x' } })).status).toBe(403);
    expect((await call('GET', `/api/mailboxes/${box2}/grants`, { t: tok(22) })).status).toBe(404);
  });
});

describe('credential-redirect guard', () => {
  test('changing imap_host or imap_port requires imap_secret in the same write', async () => {
    const id = await seedMailbox();
    let r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_host: 'imap.migadu.com' } });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/requires imap_secret/);
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_port: 143 } });
    expect(r.status).toBe(400);
    expect(W.T.mailboxes[0].imap_host).toBe('gcam1191.siteground.biz');
    // same host (case-insensitive) is not a change
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body: { imap_host: 'GCAM1191.siteground.biz' } });
    expect(r.status).toBe(200);
    r = await call('PATCH', `/api/mailboxes/${id}`, {
      t: SU(), elev: ELEV(), body: { imap_host: 'imap.migadu.com', imap_secret: 'Migadu-1' },
    });
    expect(r.status).toBe(200);
    expect(decrypt(W.T.mailboxes[0].imap_secret)).toBe('Migadu-1');
  });
});

describe('validation', () => {
  test.each([
    [{ address: 'x@y.com', imap_host: 'h.example.com' }, /imap_user is required/],
    [{ address: 'not-an-email', imap_host: 'h.example.com', imap_user: 'u' }, /valid email/],
    [{ address: 'x@y.com', imap_host: 'https://h.example.com', imap_user: 'u' }, /hostname/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', imap_port: 70000 }, /imap_port/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', domain: 'z.com' }, /derived/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', send_credential_id: 99 }, /email_credentials/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', ingest_folders: {} }, /at least one folder/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', ingest_folders: { INBOX: { emit_to_rules: 'yes' } } }, /boolean/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', ingest_folders: { INBOX: { emit_to_rules: true, x: 1 } } }, /unknown property/],
    [{ address: 'x@y.com', imap_host: 'h.example.com', imap_user: 'u', bogus: 1 }, /unknown field/],
  ])('POST %j → 400', async (body, msg) => {
    const r = await call('POST', '/api/mailboxes', { t: SU(), elev: ELEV(), body });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(msg);
    expect(W.T.mailboxes).toEqual([]);
  });

  test('duplicate address (case-insensitive) → 409', async () => {
    await seedMailbox();
    const r = await call('POST', '/api/mailboxes', {
      t: SU(), elev: ELEV(), body: { address: 'BILLING@4lsg.com', imap_host: 'h.example.com', imap_user: 'u' },
    });
    expect(r.status).toBe(409);
  });

  test('grant bodies: user 0, unknown user, all-false, duplicate, immutable user, emptying PATCH', async () => {
    const id = await seedMailbox();
    const post = (body) => call('POST', `/api/mailboxes/${id}/grants`, { t: SU(), elev: ELEV(), body });
    expect((await post({ user: 0, can_read: true })).status).toBe(400);
    expect((await post({ user: 99, can_read: true })).status).toBe(400);
    expect((await post({ user: 22 })).status).toBe(400);
    const g = (await post({ user: 22, can_read: true })).json.grant.id;
    expect((await post({ user: 22, can_send: true })).status).toBe(409);
    const patch = (body) => call('PATCH', `/api/mailboxes/${id}/grants/${g}`, { t: SU(), elev: ELEV(), body });
    expect((await patch({ user: 5 })).status).toBe(400);
    expect((await patch({ can_read: false })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    const ok = await patch({ can_send: true, can_manage: true });
    expect(ok.status).toBe(200);
    expect(ok.json.grant).toMatchObject({ can_read: true, can_send: true, can_manage: true, granted_by: 6 });
  });
});

describe('resolution service', () => {
  test('getAccess / listReadable', async () => {
    const id = await seedMailbox();
    const r = await call('POST', '/api/mailboxes', {
      t: SU(), elev: ELEV(), body: { address: 'b@mdbl.com', imap_host: 'h.example.com', imap_user: 'u' },
    });
    const id2 = r.json.id;
    await seedGrant(id, { user: 5, can_read: true, can_manage: true });
    await seedGrant(id2, { user: 5, can_send: true });

    expect(await svc.getAccess(W.db, 5, 'mailbox', id))
      .toEqual({ can_read: true, can_send: false, can_manage: true, su: false });
    expect(await svc.getAccess(W.db, '6', 'mailbox', 424242))
      .toEqual({ can_read: true, can_send: true, can_manage: true, su: true });
    expect(await svc.getAccess(W.db, 22, 'mailbox', id))
      .toEqual({ can_read: false, can_send: false, can_manage: false, su: false });

    expect((await svc.listReadable(W.db, 5)).map(x => x.id)).toEqual([id]); // send-only box excluded
    expect((await svc.listReadable(W.db, 6)).length).toBe(2);
    // GET /api/mailboxes shows any-grant boxes, each with its flags
    const list = await call('GET', '/api/mailboxes', { t: tok(5) });
    expect(list.json.mailboxes.map(m => [m.id, m.access.can_read, m.access.can_send])).toEqual(
      expect.arrayContaining([[id, true, false], [id2, false, true]])
    );
    expect(list.json.mailboxes.find(m => m.id === id2)).not.toHaveProperty('grant_count');
    assertSecretNeverSelected();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// S1-G — the emission override and the backlog policy (PATCH validation)
//
// Mutation-checked:
//   - emit_* added to MANAGER_EDITABLE_FIELDS     → "SU-only: a manager gets 403"
//   - pair rule dropped                            → "set as a pair"
//   - provider-under-mailbox-imap check dropped    → "provider never under mailbox-imap"
//   - active-source check dropped                  → "must name an ACTIVE source row"
//   - one-provider-mailbox-per-source check dropped → "one provider-keyed mailbox per source"
// ─────────────────────────────────────────────────────────────────────────────

describe('S1-G emission override', () => {
  const patch = (id, body, opts = {}) => call('PATCH', `/api/mailboxes/${id}`, { t: SU(), elev: ELEV(), body, ...opts });
  const GMAIL = { emit_source_name: 'gmail-firm', emit_id_kind: 'provider' };

  test('PATCH-only: a create that names emit_* is refused (every box starts store-only on the default)', async () => {
    const r = await call('POST', '/api/mailboxes', {
      t: SU(), elev: ELEV(),
      body: { address: 'stuart@4lsg.com', imap_host: 'imap.gmail.com', imap_user: 'stuart@4lsg.com', ...GMAIL },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/PATCH once the mailbox exists/);
    expect(W.T.mailboxes).toEqual([]);
  });

  test('valid pair: stored under the source row\'s spelling, projected, audited as a diff', async () => {
    const id = await seedMailbox();
    const r = await patch(id, { emit_source_name: 'Gmail-Firm', emit_id_kind: 'provider' });
    expect(r.status).toBe(200);
    expect(r.json.mailbox).toMatchObject({ emit_source_name: 'gmail-firm', emit_id_kind: 'provider' });
    const row = W.T.mailboxes.find(x => x.id === id);
    expect(row).toMatchObject({ emit_source_name: 'gmail-firm', emit_id_kind: 'provider' });
    const upd = W.T.admin_audit_log.map(a => JSON.parse(a.details || 'null')).filter(d => d && d.action === 'mailbox_update').pop();
    expect(upd.diff).toEqual({
      emit_source_name: { from: null, to: 'gmail-firm' },
      emit_id_kind: { from: null, to: 'provider' },
    });
    // Both null resets to the default.
    const back = await patch(id, { emit_source_name: null, emit_id_kind: null });
    expect(back.status).toBe(200);
    expect(W.T.mailboxes.find(x => x.id === id)).toMatchObject({ emit_source_name: null, emit_id_kind: null });
  });

  test('set as a pair', async () => {
    const id = await seedMailbox();
    for (const [body, msg] of [
      [{ emit_source_name: 'gmail-firm' }, /set together/],
      [{ emit_id_kind: 'provider' }, /set together/],
      [{ emit_source_name: 'gmail-firm', emit_id_kind: null }, /both set or both null/],
      [{ emit_source_name: null, emit_id_kind: 'rfc' }, /both set or both null/],
    ]) {
      const r = await patch(id, body);
      expect(r.status).toBe(400);
      expect(r.json.message).toMatch(msg);
    }
    expect(W.T.mailboxes.find(x => x.id === id).emit_source_name ?? null).toBeNull();
  });

  test('provider never under mailbox-imap; unknown kind refused', async () => {
    const id = await seedMailbox();
    let r = await patch(id, { emit_source_name: 'mailbox-imap', emit_id_kind: 'provider' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/never emitted under the shared 'mailbox-imap'/);
    r = await patch(id, { emit_source_name: 'gmail-firm', emit_id_kind: 'hex' });
    expect(r.status).toBe(400);
    r = await patch(id, { emit_source_name: 'mailbox-imap', emit_id_kind: 'rfc' }); // explicit default: allowed
    expect(r.status).toBe(200);
  });

  test('must name an ACTIVE source row', async () => {
    const id = await seedMailbox();
    let r = await patch(id, { emit_source_name: 'no-such-source', emit_id_kind: 'rfc' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/not an email_ingest_sources row/);
    r = await patch(id, { emit_source_name: 'dead-relay', emit_id_kind: 'rfc' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/inactive/);
  });

  test('one provider-keyed mailbox per source', async () => {
    const a = await seedMailbox();
    const b = await seedMailbox({ address: 'other@4lsg.com', imap_user: 'other@4lsg.com' });
    expect((await patch(a, GMAIL)).status).toBe(200);
    const r = await patch(b, GMAIL);
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/billing@4lsg.com already emits provider ids as 'gmail-firm'/);
    // Re-saving the owner itself is fine.
    expect((await patch(a, GMAIL)).status).toBe(200);
  });

  test('SU-only: a manager gets 403; an SU without elevation gets 401', async () => {
    const id = await seedMailbox();
    await seedGrant(id, { user: 5, can_read: true, can_manage: true });
    let r = await call('PATCH', `/api/mailboxes/${id}`, { t: tok(5), body: GMAIL });
    expect(r.status).toBe(403);
    r = await call('PATCH', `/api/mailboxes/${id}`, { t: SU(), body: GMAIL });
    expect(r.status).toBe(401);
    expect(W.T.mailboxes.find(x => x.id === id).emit_source_name ?? null).toBeNull();
  });

  test('the source lookup never selects api_key', async () => {
    const id = await seedMailbox();
    await patch(id, GMAIL);
    const lookups = W.selects.filter(s => /email_ingest_sources/.test(s));
    expect(lookups.length).toBeGreaterThan(0);
    for (const s of lookups) expect(s).not.toMatch(/api_key/);
  });
});

describe('S1-G backlog policy (ingest_folders.<folder>.backfill)', () => {
  test('backfill:false is kept, backfill:true normalizes away, non-boolean is refused', async () => {
    const id = await seedMailbox({
      ingest_folders: { INBOX: { emit_to_rules: false, backfill: false }, '[Gmail]/Sent Mail': { emit_to_rules: false, backfill: true } },
    });
    expect(JSON.parse(W.T.mailboxes.find(x => x.id === id).ingest_folders)).toEqual({
      INBOX: { emit_to_rules: false, backfill: false },
      '[Gmail]/Sent Mail': { emit_to_rules: false },
    });
    const r = await call('PATCH', `/api/mailboxes/${id}`, {
      t: SU(), elev: ELEV(), body: { ingest_folders: { INBOX: { emit_to_rules: true, backfill: 'no' } } },
    });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/backfill must be a boolean/);
  });
});
