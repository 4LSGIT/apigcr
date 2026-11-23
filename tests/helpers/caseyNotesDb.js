// tests/helpers/caseyNotesDb.js — an in-memory casey_notes behind a db stub's
// query(), answering exactly the statements services/casey/notes.js issues
// (the current-per-scope join, the version list, one version, the FOR UPDATE
// latest, the INSERT with the UNIQUE (scope, version) key). The real table is
// proven by tests/caseyNotes.mysql.test.js; this lets the service, loop and
// route suites run the real service over a stub.
'use strict';

function makeNotesDb(rows = []) {
  const calls = [];
  const latest = (scope) => rows.filter((r) => r.scope === scope).sort((a, b) => b.version - a.version)[0] || null;
  const current = () => [...new Set(rows.map((r) => r.scope))].map(latest);
  let nextId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  /** → an answer, or undefined when the statement is not a casey_notes one. */
  const answer = async (sql, params = []) => {
    if (!/casey_notes/.test(sql)) return undefined;
    calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/JOIN \(SELECT scope, MAX\(version\)/.test(sql) && /ORDER BY \(n\.scope = \?\)/.test(sql)) {
      return [current().sort((a, b) => (b.scope === params[0]) - (a.scope === params[0]) || a.scope.localeCompare(b.scope))];
    }
    if (/JOIN \(SELECT scope, MAX\(version\)/.test(sql)) return [current().map((r) => ({ scope: r.scope, version: r.version, body: r.body }))];
    if (/CHAR_LENGTH\(body\) AS chars/.test(sql)) return [rows.filter((r) => r.scope === params[0]).sort((a, b) => b.version - a.version).map((r) => ({ ...r, chars: r.body.length, body: undefined }))];
    if (/WHERE scope = \? AND version = \?/.test(sql)) return [rows.filter((r) => r.scope === params[0] && r.version === Number(params[1]))];
    if (/FOR UPDATE/.test(sql)) { const l = latest(params[0]); return [l ? [{ version: l.version, body: l.body }] : []]; }
    if (/^INSERT INTO casey_notes/.test(sql.trim())) {
      const [scope, version, body, edit_note, author_id, author_name] = params;
      if (rows.some((r) => r.scope === scope && r.version === version)) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const row = { id: nextId++, scope, version, body, edit_note, author_id, author_name, created_at: new Date('2026-11-23T12:00:00Z') };
      rows.push(row);
      return [{ insertId: row.id }];
    }
    throw new Error('caseyNotesDb: unexpected sql: ' + sql);
  };
  const query = async (sql, params) => {
    const a = await answer(sql, params);
    if (a === undefined) throw new Error('unexpected sql: ' + sql);
    return a;
  };
  return { rows, calls, answer, query, withTransaction: async (fn) => fn({ query }) };
}

module.exports = { makeNotesDb };
