// tests/helpers/ctaWorld.js
//
/**
 * Stateful in-memory DB for services/ctaService.js (CTA arc S1).
 *
 * WHY A MINI EVALUATOR, NOT SCRIPTED RESULTS
 *   The CTA's safety lives in the WHERE clauses of its guarded UPDATEs
 *   (the once-claim, the repeatable increment, the timeout claim, the PATCH
 *   status guard). A fake that returned `affectedRows: 1` on cue would test
 *   nothing: drop `AND status='active'` from the claim and the suite would
 *   stay green. So every UPDATE / due-row SELECT is EVALUATED from the
 *   statement's own SET and WHERE text against the stored rows — the same
 *   idea as tests/workflowEngine.cancelAndLoopGuard.test.js's guardPasses(),
 *   generalized to the conjunction / OR-group / IS [NOT] NULL / column-vs-
 *   column / NOW() shapes the service uses. Edit the SQL and the fake's
 *   behavior follows.
 *
 *   NOW() is the real clock (tests set expires_at relative to Date.now()).
 *   Unknown statements THROW (no silent default), so a new query in the
 *   service fails loudly here until the fake learns it.
 *
 * RACE MACHINERY
 *   W.gate(re, n)  hold every query matching `re` until n have arrived, then
 *                  release them in arrival order. Each is evaluated
 *                  atomically on release — exactly the "both readers passed
 *                  the JS pre-check, both UPDATEs reach the server" race.
 *   W.on(re, fn)   observation hook run before a matching query (may return
 *                  a promise to stall it — the "crash mid-plan" stand-in).
 *   Both record whether they ever engaged (g.open / h.hits) — the test file
 *   asserts that in afterEach, so a regex that silently stops matching the
 *   service's SQL fails instead of quietly un-staging the race.
 *
 * withTransaction(fn) runs fn against the same store (conn.query tagged
 * inTxn) and counts commits; it has NO rollback — nothing in the paths under
 * test fails mid-transaction.
 */
'use strict';

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

/** Split at `word` (AND/OR) at paren depth 0, outside quotes. */
function splitDepth0(s, word) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  const needle = ` ${word} `;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") quote = !quote;
    if (!quote) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && s.substr(i, needle.length).toUpperCase() === needle) {
        out.push(cur);
        cur = '';
        i += needle.length - 1;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

function splitCommas(s) {
  const out = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const c of s) {
    if (c === "'") quote = !quote;
    if (!quote) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function wrappedInParens(e) {
  if (!e.startsWith('(')) return false;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(') depth++;
    else if (e[i] === ')') { depth--; if (depth === 0) return i === e.length - 1; }
  }
  return false;
}

/** `?` → $0, $1 … so evaluation order (short-circuit ORs) can't misbind params. */
function numberParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${i++}`);
}

function cmp(a, op, b) {
  if (a == null || b == null) return false;   // SQL: comparisons with NULL are not true
  let x = a;
  let y = b;
  if (x instanceof Date || y instanceof Date) { x = new Date(x).getTime(); y = new Date(y).getTime(); }
  else if (typeof x === 'number' || typeof y === 'number') { x = Number(x); y = Number(y); }
  else { x = String(x); y = String(y); }
  switch (op) {
    case '=': return x === y;
    case '!=': case '<>': return x !== y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '>': return x > y;
    case '>=': return x >= y;
    default: throw new Error(`ctaWorld: operator ${op}`);
  }
}

function makeEvaluator(row, params) {
  const colv = (name) => {
    const n = name.replace(/`/g, '');
    if (!(n in row)) throw new Error(`ctaWorld: unknown column ${n}`);
    return row[n];
  };
  const val = (tok) => {
    const t = tok.trim();
    let m;
    if ((m = /^\$(\d+)$/.exec(t))) return params[Number(m[1])];
    if (/^NOW\(\)$/i.test(t)) return new Date();
    if (/^NULL$/i.test(t)) return null;
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if ((m = /^`?(\w+)`?\s*\+\s*(\d+)$/.exec(t))) return Number(colv(m[1])) + Number(m[2]);
    if (/^`?\w+`?$/.test(t)) return colv(t);
    throw new Error(`ctaWorld: cannot evaluate "${t}"`);
  };
  const cond = (expr) => {
    const e = expr.trim();
    if (wrappedInParens(e)) return cond(e.slice(1, -1));
    const ands = splitDepth0(e, 'AND');
    if (ands.length > 1) return ands.every(cond);
    const ors = splitDepth0(e, 'OR');
    if (ors.length > 1) return ors.some(cond);
    let m = /^`?(\w+)`?\s+IS\s+(NOT\s+)?NULL$/i.exec(e);
    if (m) { const v = colv(m[1]); return m[2] ? v != null : v == null; }
    m = /^(.+?)\s*(<=|>=|<>|!=|=|<|>)\s*(.+)$/.exec(e);
    if (m) return cmp(val(m[1]), m[2], val(m[3]));
    throw new Error(`ctaWorld: cannot evaluate condition "${e}"`);
  };
  return { val, cond };
}

function makeCtaWorld() {
  const W = {
    tables: { cta_links: new Map(), cta_executions: new Map() },
    nextId: { cta_links: 1, cta_executions: 1 },
    users: new Map([
      [0, { user: 0, user_auth: 'authorized' }],
      [6, { user: 6, user_auth: 'authorized - SU' }],
      [22, { user: 22, user_auth: 'authorized' }],
    ]),
    settings: new Map([
      ['cta_default_timeout_once', '3d'],
      ['cta_default_timeout_repeatable', '30d'],
    ]),
    contacts: new Map(),
    logs: [],          // createLogEntry param arrays
    audits: [],        // admin_audit_log param arrays (lib/auth.superuser.auditAdminAction order)
    queries: [],       // { sql, params, inTxn }
    commits: 0,
    gates: [],
    hooks: [],
  };

  W.gate = (re, n) => { W.gates.push({ re, n, waiting: [], open: false }); };
  W.on = (re, fn) => { W.hooks.push({ re, fn, hits: 0 }); };
  W.link = (id) => W.tables.cta_links.get(Number(id));
  W.execs = (ctaId) => [...W.tables.cta_executions.values()].filter((e) => ctaId == null || e.cta_id === Number(ctaId));

  /** Insert a cta_links row directly (bypassing mint) — runtime-guard style fixtures. */
  W.seedLink = (over = {}) => {
    const id = W.nextId.cta_links++;
    const row = {
      id, token: `tok${String(id).padStart(19, 'x')}`, name: `seed ${id}`, prompt: 'Seeded prompt',
      context_html: null, options: '[]', mode: 'once', max_uses: null, uses_count: 0,
      expires_at: new Date(Date.now() + 3600e3), timeout_option: null, protection: 'none',
      password_hash: null, failed_attempts: 0, return_plan_result: 0, attributed_user_id: null,
      status: 'active', mint_source: 'su', source_execution_id: null, minted_by: 6,
      link_type: null, link_id: null, created_at: new Date(), updated_at: new Date(),
      ...over,
    };
    if (typeof row.options !== 'string') row.options = JSON.stringify(row.options);
    W.tables.cta_links.set(id, row);
    return row;
  };

  const out = (row) => {
    if (!row) return row;
    const c = { ...row };
    // mysql2 returns JSON columns parsed.
    if (typeof c.options === 'string') c.options = JSON.parse(c.options);
    if (typeof c.plan_result === 'string') c.plan_result = JSON.parse(c.plan_result);
    if (typeof c.inputs === 'string') c.inputs = JSON.parse(c.inputs);
    return c;
  };

  async function waitGates(s) {
    for (const g of W.gates) {
      if (!g.re.test(s) || g.open) continue;
      await new Promise((resolve) => {
        g.waiting.push(resolve);
        if (g.waiting.length >= g.n) {
          g.open = true;
          g.waiting.forEach((r) => r());
        }
      });
    }
  }

  function doUpdate(table, setPart, wherePart, params) {
    let affected = 0;
    for (const row of W.tables[table].values()) {
      const ev = makeEvaluator(row, params);
      if (!ev.cond(wherePart)) continue;
      const assigns = splitCommas(setPart).map((a) => {
        const m = /^`?(\w+)`?\s*=\s*(.+)$/.exec(a);
        if (!m) throw new Error(`ctaWorld: SET clause "${a}"`);
        return [m[1], ev.val(m[2])];   // all RHS read the PRE-update row
      });
      for (const [col, v] of assigns) {
        if (!(col in row)) throw new Error(`ctaWorld: unknown column ${col}`);
        row[col] = v;
      }
      affected++;
    }
    return [{ affectedRows: affected }];
  }

  function doInsert(table, colsPart, valsPart, params) {
    const cols = splitCommas(colsPart).map((c) => c.replace(/`/g, ''));
    const vals = splitCommas(valsPart);
    if (cols.length !== vals.length) throw new Error(`ctaWorld: INSERT ${table} arity`);
    const id = W.nextId[table]++;
    const base = table === 'cta_links'
      ? { uses_count: 0, failed_attempts: 0, created_at: new Date(), updated_at: new Date(), context_html: null }
      : { plan_result: null, inputs: null, executed_at: new Date() };
    const row = { id, ...base };
    const ev = makeEvaluator(row, params);
    cols.forEach((c, i) => { row[c] = ev.val(vals[i]); });
    W.tables[table].set(id, row);
    return [{ insertId: id, affectedRows: 1 }];
  }

  async function handle(sql, params = [], inTxn = false) {
    const s = norm(sql);
    W.queries.push({ sql: s, params, inTxn });
    await waitGates(s);
    for (const h of W.hooks) {
      if (h.re.test(s)) { h.hits++; await h.fn(s, params, W); }
    }
    const p = numberParams(s);
    let m;

    if ((m = /^UPDATE (cta_links|cta_executions) SET (.+?) WHERE (.+)$/i.exec(p))) {
      return doUpdate(m[1], m[2], m[3], params);
    }
    if ((m = /^INSERT INTO (cta_links|cta_executions) \(([^)]*)\) VALUES \((.*)\)$/i.exec(p))) {
      return doInsert(m[1], m[2], m[3], params);
    }
    if (/^SELECT \* FROM cta_links WHERE token = \? LIMIT 1$/i.test(s)) {
      const r = [...W.tables.cta_links.values()].find((x) => x.token === params[0]);
      return [r ? [out(r)] : []];
    }
    if (/^SELECT \* FROM cta_links WHERE id = \? LIMIT 1$/i.test(s)) {
      const r = W.tables.cta_links.get(Number(params[0]));
      return [r ? [out(r)] : []];
    }
    if (/^SELECT failed_attempts FROM cta_links WHERE id = \?$/i.test(s)) {
      const r = W.tables.cta_links.get(Number(params[0]));
      return [r ? [{ failed_attempts: r.failed_attempts }] : []];
    }
    if ((m = /^SELECT id FROM cta_links WHERE (.+) ORDER BY expires_at LIMIT (\$\d+)$/i.exec(p))) {
      const lim = params[Number(m[2].slice(1))];
      const rows = [...W.tables.cta_links.values()]
        .filter((r) => makeEvaluator(r, params).cond(m[1]))
        .sort((a, b) => a.expires_at - b.expires_at)
        .slice(0, lim)
        .map((r) => ({ id: r.id }));
      return [rows];
    }
    if (/^SELECT id, status, executed_at FROM cta_executions WHERE cta_id = \? ORDER BY id DESC LIMIT 1$/i.test(s)) {
      const rows = W.execs(params[0]).sort((a, b) => b.id - a.id).slice(0, 1)
        .map((e) => ({ id: e.id, status: e.status, executed_at: e.executed_at }));
      return [rows];
    }
    // S2 SU reads (ctaService.listCtas / listExecutions). Scripted, not
    // evaluated: no guard lives in them — but the projection IS read from the
    // statement, so a column the service stops selecting stops appearing.
    if ((m = /^SELECT (l\.\w+(?:, l\.\w+)*), \(SELECT COUNT\(\*\) FROM cta_executions e WHERE e\.cta_id = l\.id\) AS exec_count, \(SELECT COUNT\(\*\) FROM cta_executions e WHERE e\.cta_id = l\.id AND e\.status = 'failed'\) AS failed_count, \(SELECT MAX\(e\.executed_at\) FROM cta_executions e WHERE e\.cta_id = l\.id\) AS last_executed_at FROM cta_links l (WHERE l\.status = \? )?ORDER BY l\.id DESC LIMIT \? OFFSET \?$/i.exec(s))) {
      const cols = m[1].split(', ').map((c) => c.slice(2));
      const [status, lim, off] = m[2] ? params : [null, ...params];
      const rows = [...W.tables.cta_links.values()]
        .filter((r) => status == null || r.status === status)
        .sort((a, b) => b.id - a.id)
        .slice(off, off + lim)
        .map((r) => {
          const o = {};
          for (const c of cols) {
            if (!(c in r)) throw new Error(`ctaWorld: unknown column ${c}`);
            o[c] = r[c];
          }
          const ex = W.execs(r.id);
          o.exec_count = ex.length;
          o.failed_count = ex.filter((e) => e.status === 'failed').length;
          o.last_executed_at = ex.length ? ex.map((e) => e.executed_at).sort((a, b) => b - a)[0] : null;
          return out(o);
        });
      return [rows];
    }
    if (/^SELECT id, cta_id, option_value, status, plan_result, inputs, responded_via, responder_user_id, responder_ip, executed_at FROM cta_executions WHERE cta_id = \? ORDER BY id DESC LIMIT \?$/i.test(s)) {
      const rows = W.execs(params[0]).sort((a, b) => b.id - a.id).slice(0, params[1]).map((e) => out(e));
      return [rows];
    }
    // routes/api.cta.js (admin_audit_log via lib/auth.superuser) and the
    // jwtOrApiKey attempt log — recorded, never evaluated.
    if (/^INSERT INTO admin_audit_log\b/i.test(s)) {
      W.audits.push(params);
      return [{ insertId: W.audits.length, affectedRows: 1 }];
    }
    if (/^INSERT INTO jwt_api_audit_log\b/i.test(s)) {
      return [{ insertId: 1, affectedRows: 1 }];
    }
    if ((m = /^SELECT e\.id, e\.cta_id, e\.option_value, e\.executed_at FROM cta_executions e WHERE e\.status = 'running' AND e\.executed_at < NOW\(\) - INTERVAL (\d+) MINUTE$/i.exec(s))) {
      const cutoff = Date.now() - Number(m[1]) * 60e3;
      const rows = W.execs().filter((e) => e.status === 'running' && new Date(e.executed_at).getTime() < cutoff)
        .map((e) => ({ id: e.id, cta_id: e.cta_id, option_value: e.option_value, executed_at: e.executed_at }));
      return [rows];
    }
    if (/^SELECT user_auth FROM users WHERE `user` = \?$/i.test(s)) {
      const u = W.users.get(Number(params[0]));
      return [u ? [{ user_auth: u.user_auth }] : []];
    }
    if (/^SELECT `user` FROM users WHERE `user` = \?$/i.test(s)) {
      const u = W.users.get(Number(params[0]));
      return [u ? [{ user: u.user }] : []];
    }
    if (/^SELECT `value` FROM app_settings WHERE `key` = \? LIMIT 1$/i.test(s)) {
      return [W.settings.has(params[0]) ? [{ value: W.settings.get(params[0]) }] : []];
    }
    if (/FROM contacts WHERE contact_id = \?$/i.test(s)) {
      const c = W.contacts.get(Number(params[0]));
      return [c ? [{ ...c }] : []];
    }
    if (/^INSERT INTO log\b/i.test(s)) {
      W.logs.push(params);
      return [{ insertId: 90000 + W.logs.length, affectedRows: 1 }];
    }
    throw new Error(`ctaWorld: unscripted query: ${s}`);
  }

  const db = {
    query: (sql, params) => handle(sql, params, false),
    withTransaction: async (fn) => {
      const conn = { query: (sql, params) => handle(sql, params, true) };
      const r = await fn(conn);
      W.commits++;
      return r;
    },
    W,
  };
  return db;
}

/** Decode an admin_audit_log INSERT param array (auditAdminAction order). */
function decodeAudit(p) {
  return {
    tool: p[0], user_id: p[1], username: p[2], route: p[3], method: p[4], status: p[5],
    error_message: p[6], details: p[10] == null ? null : JSON.parse(p[10]),
  };
}

/** Decode a log INSERT param array (logService.createLogEntry order). */
function decodeLog(p) {
  return {
    type: p[0], log_link: p[1], link_type: p[2], link_id: p[3],
    about_type: p[4], about_id: p[5], by: p[6], data: JSON.parse(p[7]),
    subject: p[11], message: p[12],
  };
}

module.exports = { makeCtaWorld, decodeLog, decodeAudit, _test: { splitDepth0, makeEvaluator, numberParams } };
