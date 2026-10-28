// tests/helpers/sharedValuesEngine.js
//
/**
 * The in-memory engine behind tests/sharedValues.test.js and
 * tests/sharedValuesPage.test.js: it EVALUATES each shared_* statement it is
 * given (WHERE conjuncts, SET lists, the PK and FK, cascade, history rows,
 * rollback snapshots) and THROWS on any statement it does not know. Moved out
 * of tests/sharedValues.test.js unchanged so the page test drives the REAL
 * router + service over it. The SQL's real-engine behaviour is
 * tests/sharedValues.mysql.test.js's job.
 */
'use strict';

const { withTransaction } = require('../../lib/withTransaction');

const NS_COLS = ['ns', 'description', 'write_mode', 'max_value_bytes', 'max_keys', 'created_by', 'created_at', 'updated_at'];
const V_COLS = ['ns', 'k', 'v', 'rev', 'updated_by', 'updated_act', 'created_at', 'updated_at'];
const H_COLS = ['id', 'ns', 'k', 'op', 'old_v', 'new_v', 'old_rev', 'new_rev', 'changed_by', 'changed_act', 'changed_at'];
const H_OPS = ['ns_create', 'ns_update', 'ns_delete', 'create', 'update', 'delete'];
const WRITE_MODES = ['staff', 'creator', 'own_key'];

function sqlError(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

/** "a = ? AND b > ? AND id < ?" → [{ col, op }] — anything else throws. */
function parseWhere(text) {
  return text.split(/\s+AND\s+/i).map((part) => {
    const m = part.trim().match(/^(?:\w+\.)?(\w+)\s*(=|>|<)\s*\?$/);
    if (!m) throw new Error('engine: unsupported predicate ' + JSON.stringify(part));
    return { col: m[1], op: m[2] };
  });
}

function matches(row, conds, params) {
  return conds.every((c, i) => {
    const want = params[i];
    const got = row[c.col];
    if (got === undefined) throw new Error('engine: unknown column ' + c.col);
    if (c.op === '=') return typeof got === 'number' ? got === Number(want) : got === want;
    if (c.op === '<') return Number(got) < Number(want);   // history ids only
    return String(got) > String(want);              // utf8mb4_bin: byte order
  });
}

function makeEngine() {
  let tables = { shared_namespaces: [], shared_values: [], shared_values_history: [] };
  let nextHistoryId = 1;
  let failHistory = false;                       // a test switch: the history INSERT throws
  const calls = [];
  let clock = 0;
  const stamp = () => `2026-10-28 00:00:${String(clock++).padStart(2, '0')}`;
  const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    let m;

    if (/jwt_api_audit_log/.test(s)) return [{ affectedRows: 1 }];

    // SELECT … FROM shared_namespaces n … key_count (the listing)
    if (/^SELECT .*\(SELECT COUNT\(\*\) FROM shared_values v WHERE v\.ns = n\.ns\) AS key_count FROM shared_namespaces n ORDER BY n\.ns$/.test(s)) {
      const rows = tables.shared_namespaces.slice().sort((a, b) => (a.ns < b.ns ? -1 : 1))
        .map((r) => ({ ...pick(r, NS_COLS), key_count: tables.shared_values.filter((v) => v.ns === r.ns).length }));
      return [rows];
    }
    if ((m = s.match(/^SELECT (.+) FROM shared_namespaces WHERE (.+?)( FOR UPDATE)?$/))) {
      const rows = tables.shared_namespaces.filter((r) => matches(r, parseWhere(m[2]), params));
      return [rows.map((r) => pick(r, NS_COLS))];
    }
    if ((m = s.match(/^SELECT COUNT\(\*\) AS n FROM shared_values WHERE (.+)$/))) {
      return [[{ n: tables.shared_values.filter((r) => matches(r, parseWhere(m[1]), params)).length }]];
    }
    // ── shared_values_history ──
    if ((m = s.match(/^INSERT INTO shared_values_history \(([^)]+)\) VALUES \(([^)]+)\)$/))) {
      const cols = m[1].split(',').map((x) => x.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, params[i] === undefined ? null : params[i]]));
      if (!H_OPS.includes(row.op)) row.op = '';                              // relaxed sql_mode enum
      if (row.changed_by == null) throw sqlError('ER_BAD_NULL_ERROR', "Column 'changed_by' cannot be null");
      if (failHistory) throw sqlError('ER_LOCK_WAIT_TIMEOUT', 'history insert failed (test)');
      tables.shared_values_history.push({ k: null, old_v: null, new_v: null, old_rev: null, new_rev: null, changed_act: null,
        ...row, id: nextHistoryId++, changed_at: stamp() });
      return [{ affectedRows: 1, insertId: nextHistoryId - 1 }];
    }
    if ((m = s.match(/^SELECT id, COALESCE\(LENGTH\(old_v\), 0\) \+ COALESCE\(LENGTH\(new_v\), 0\) AS bytes FROM shared_values_history WHERE (.+) ORDER BY id DESC LIMIT (\d+)$/))) {
      const len = (x) => (x == null ? 0 : Buffer.byteLength(String(x), 'utf8'));   // LENGTH() = bytes
      const rows = tables.shared_values_history.filter((r) => matches(r, parseWhere(m[1]), params))
        .sort((a, b) => b.id - a.id).slice(0, Number(m[2]))
        .map((r) => ({ id: r.id, bytes: len(r.old_v) + len(r.new_v) }));
      return [rows];
    }
    if ((m = s.match(/^SELECT (.+) FROM shared_values_history WHERE id IN \(\?\) ORDER BY id DESC$/))) {
      const ids = params[0];
      if (!Array.isArray(ids)) throw new Error('engine: IN (?) needs an array');
      const rows = tables.shared_values_history.filter((r) => ids.includes(r.id)).sort((a, b) => b.id - a.id);
      return [rows.map((r) => pick(r, H_COLS))];
    }
    if ((m = s.match(/^SELECT (.+) FROM shared_values WHERE (.+?)(?: ORDER BY k)?(?: LIMIT (\d+))?(?: FOR (?:SHARE|UPDATE))?$/))) {
      let rows = tables.shared_values.filter((r) => matches(r, parseWhere(m[2]), params));
      if (/ORDER BY k/.test(s)) rows.sort((a, b) => (a.k < b.k ? -1 : 1));
      if (m[3]) rows = rows.slice(0, Number(m[3]));
      return [rows.map((r) => pick(r, V_COLS))];
    }
    if ((m = s.match(/^INSERT INTO shared_namespaces \(([^)]+)\) VALUES \(([^)]+)\)$/))) {
      const cols = m[1].split(',').map((x) => x.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
      if (tables.shared_namespaces.some((r) => r.ns === row.ns)) throw sqlError('ER_DUP_ENTRY');
      if (!WRITE_MODES.includes(row.write_mode)) row.write_mode = '';     // relaxed sql_mode enum
      const now = stamp();
      tables.shared_namespaces.push({ description: null, write_mode: 'staff', max_value_bytes: 65536, max_keys: 1000,
        ...row, created_at: now, updated_at: now });
      return [{ affectedRows: 1 }];
    }
    if ((m = s.match(/^INSERT INTO shared_values \(([^)]+)\) VALUES \(([^)]+)\)$/))) {
      const cols = m[1].split(',').map((x) => x.trim());
      const vals = m[2].split(',').map((x) => x.trim());
      let p = 0;
      const row = Object.fromEntries(cols.map((c, i) => [c, vals[i] === '?' ? params[p++] : Number(vals[i])]));
      if (!tables.shared_namespaces.some((r) => r.ns === row.ns)) throw sqlError('ER_NO_REFERENCED_ROW_2');
      if (tables.shared_values.some((r) => r.ns === row.ns && r.k === row.k)) throw sqlError('ER_DUP_ENTRY');
      const now = stamp();
      tables.shared_values.push({ updated_act: null, ...row, created_at: now, updated_at: now });
      return [{ affectedRows: 1 }];
    }
    if ((m = s.match(/^UPDATE (shared_namespaces|shared_values) SET (.+) WHERE (.+)$/))) {
      const sets = m[2].split(/,\s*/).map((a) => {
        const x = a.match(/^(\w+) = (\?|rev \+ 1)$/);
        if (!x) throw new Error('engine: unsupported SET ' + a);
        return { col: x[1], expr: x[2] };
      });
      const nParams = sets.filter((x) => x.expr === '?').length;
      const setParams = params.slice(0, nParams);
      const rows = tables[m[1]].filter((r) => matches(r, parseWhere(m[3]), params.slice(nParams)));
      for (const r of rows) {
        let p = 0;
        for (const st of sets) {
          if (!(st.col in r)) throw new Error('engine: unknown column ' + st.col);
          r[st.col] = st.expr === '?' ? setParams[p++] : r[st.col] + 1;
        }
        if (m[1] === 'shared_namespaces' && !WRITE_MODES.includes(r.write_mode)) r.write_mode = '';
        r.updated_at = stamp();
      }
      return [{ affectedRows: rows.length }];
    }
    if ((m = s.match(/^DELETE FROM (shared_namespaces|shared_values) WHERE (.+)$/))) {
      const conds = parseWhere(m[2]);
      const gone = tables[m[1]].filter((r) => matches(r, conds, params));
      tables[m[1]] = tables[m[1]].filter((r) => !gone.includes(r));
      if (m[1] === 'shared_namespaces') {                                // ON DELETE CASCADE
        tables.shared_values = tables.shared_values.filter((v) => !gone.some((n) => n.ns === v.ns));
      }
      return [{ affectedRows: gone.length }];
    }
    throw new Error('engine: unsupported statement ' + s);
  }

  const db = {
    calls,
    query,
    get tables() { return tables; },
    seed(t) { tables = { shared_values_history: [], ...JSON.parse(JSON.stringify(t)) }; },
    set failHistory(on) { failHistory = !!on; },
    getConnection: async () => {
      let snapshot = null;
      return {
        query,
        beginTransaction: async () => { snapshot = JSON.stringify(tables); },
        commit: async () => { snapshot = null; },
        rollback: async () => { if (snapshot) tables = JSON.parse(snapshot); snapshot = null; },
        release: () => {}, destroy: () => {},
      };
    },
  };
  db.withTransaction = (fn, opts) => withTransaction(db, fn, opts);
  return db;
}


module.exports = { makeEngine };
