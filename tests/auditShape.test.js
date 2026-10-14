/**
 * tests/auditShape.test.js
 *
 * SEC-2 — jwt_api_audit_log stores value SHAPES, never values
 * (lib/auditShape.js, lib/auth.jwtOrApiKey.js logJwtApiAttempt,
 * scripts/sec2ScrubAuditShapes.js).
 *
 * Contracts pinned here:
 *   shapeValue / shapeTop are TOTAL: every input (undefined, null, NaN,
 *     bigint, huge strings, arrays of objects, Buffers, functions, symbols,
 *     throwing getters, null-prototype objects) yields a shape, never throws,
 *     and every leaf matches SHAPE_RE. One level: nested values are counted,
 *     never descended into. Credential-named keys are "[secret]" (no length).
 *     More than MAX_KEYS keys are capped with a "[+N keys]" counter.
 *   isShaped: true for any shapeTop output; false for raw rows, for the old
 *     "[REDACTED]" form, and for nested objects.
 *   logJwtApiAttempt: a CANARY planted anywhere in the body or query (top
 *     level, nested object, array of objects, credential key, key-capped tail)
 *     never appears in any INSERT param; keys survive.
 *   The scrub (scripted conn): CHECK writes nothing; APPLY walks id batches of
 *     BATCH, rewrites only unshaped rows through the SAME shapeTop, leaves a
 *     NULL side NULL, in ONE UPDATE per batch, verifies; a re-run is a
 *     no-op (no UPDATE issued); a failing batch writes none of itself and
 *     names the resume id; a table in another
 *     shape is a NO-GO with nothing written.
 *
 * Run:
 *   npx jest tests/auditShape.test.js
 */
'use strict';

const CANARY = 'FAKEcanary-7c1e9b-5551234'; // a stand-in value, not real data

beforeEach(() => { jest.resetModules(); });

// ─────────────────────────────────────────────────────────────
// the summarizer
// ─────────────────────────────────────────────────────────────

describe('shapeValue / shapeTop — total over weird input', () => {
  const { shapeValue, shapeTop, isShaped, SHAPE_RE, MAX_KEYS, TRUNCATED_KEY } = require('../lib/auditShape');

  test.each([
    ['string', 'Jane', '[str 4]'],
    ['empty string', '', '[str 0]'],
    ['big string (1 MB)', 'x'.repeat(1 << 20), `[str ${1 << 20}]`],
    ['integer', 42, '[num]'],
    ['float', 4.2, '[num]'],
    ['NaN', NaN, '[num]'],
    ['Infinity', Infinity, '[num]'],
    ['bigint', 10n, '[num]'],
    ['true', true, '[bool]'],
    ['false', false, '[bool]'],
    ['null', null, '[null]'],
    ['undefined', undefined, '[undefined]'],
    ['array', [1, 2, 3], '[arr 3]'],
    ['empty array', [], '[arr 0]'],
    ['array of objects', [{ a: CANARY }, { b: CANARY }], '[arr 2]'],
    ['object', { a: 1, b: { c: CANARY } }, '[obj 2]'],
    ['empty object', {}, '[obj 0]'],
    ['null-prototype object', Object.assign(Object.create(null), { a: 1 }), '[obj 1]'],
    ['Buffer', Buffer.from(CANARY), `[buf ${CANARY.length}]`],
    ['Uint8Array', new Uint8Array(5), '[buf 5]'],
    ['Date', new Date(0), '[obj 0]'],
    ['function', () => CANARY, '[other]'],
    ['symbol', Symbol(CANARY), '[other]'],
  ])('%s', (_name, v, want) => {
    expect(shapeValue(v)).toBe(want);
    expect(want).toMatch(SHAPE_RE);
  });

  test('a Proxy whose ownKeys throws is [other], not a crash', () => {
    const p = new Proxy({}, { ownKeys() { throw new Error(CANARY); } });
    expect(shapeValue(p)).toBe('[other]');
    expect(shapeTop(p)).toBe('[other]');
  });

  test('shapeTop: one level — keys kept, nested values counted not descended', () => {
    const out = shapeTop({
      to: '+15555550123', message: 'x'.repeat(240), ids: [1, 2, 3], active: true,
      nested: { a: CANARY, b: 2, c: 3, d: { deep: CANARY } }, rows: [{ name: CANARY }], none: null,
    });
    expect(out).toEqual({
      to: '[str 12]', message: '[str 240]', ids: '[arr 3]', active: '[bool]',
      nested: '[obj 4]', rows: '[arr 1]', none: '[null]',
    });
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(JSON.stringify(out)).not.toContain('deep');   // nested KEYS are not stored either
  });

  test('shapeTop: credential-named keys are [secret] — no type, no length', () => {
    const out = shapeTop({
      password: 'hunter2', smtp_pass: 'x', client_secret: 'y', api_key: 'z', apikey: 'z', token: 't',
      key: 'k', auth: 'a', refresh_token: 'r', PWD: 'p',
      current_password: 'c', new_password: 'n', imap_secret: 'i',          // the pre-SEC-2 body list
      form_key: 'abc', item_key: 'abcd', token_count: 3, author: 'Al',   // identifiers, not credentials
    });
    for (const k of ['password', 'smtp_pass', 'client_secret', 'api_key', 'apikey', 'token', 'key', 'auth', 'refresh_token', 'PWD',
      'current_password', 'new_password', 'imap_secret']) {
      expect([k, out[k]]).toEqual([k, '[secret]']);
    }
    expect(out).toMatchObject({ form_key: '[str 3]', item_key: '[str 4]', token_count: '[num]', author: '[str 2]' });
  });

  test('shapeTop: missing → {}; non-object top level → one tag', () => {
    expect(shapeTop(undefined)).toEqual({});
    expect(shapeTop(null)).toEqual({});
    expect(shapeTop(CANARY)).toBe(`[str ${CANARY.length}]`);
    expect(shapeTop([{ a: CANARY }])).toBe('[arr 1]');
    expect(shapeTop(Buffer.from('abc'))).toBe('[buf 3]');
    expect(shapeTop(7)).toBe('[num]');
  });

  test('shapeTop: a throwing getter shapes as [undefined], the rest survive', () => {
    const o = { a: 1 };
    Object.defineProperty(o, 'boom', { enumerable: true, get() { throw new Error(CANARY); } });
    expect(shapeTop(o)).toEqual({ a: '[num]', boom: '[undefined]' });
  });

  test(`shapeTop: more than MAX_KEYS (${MAX_KEYS}) keys are capped with a counter`, () => {
    const big = {};
    for (let i = 0; i < MAX_KEYS + 7; i++) big[`k${i}`] = CANARY;
    big[CANARY] = 1;   // a key past the cap — never stored
    const out = shapeTop(big);
    expect(Object.keys(out)).toHaveLength(MAX_KEYS + 1);
    expect(out[TRUNCATED_KEY]).toBe('[+8 keys]');
    expect(out.k0).toBe(`[str ${CANARY.length}]`);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(isShaped(out)).toBe(true);
    // exactly MAX_KEYS → no counter
    const exact = {};
    for (let i = 0; i < MAX_KEYS; i++) exact[`k${i}`] = 1;
    expect(shapeTop(exact)[TRUNCATED_KEY]).toBeUndefined();
  });

  test('isShaped: every shapeTop output is shaped; raw, old-redacted and nested rows are not', () => {
    for (const x of [undefined, null, {}, { a: CANARY, b: [1], c: { d: 1 }, password: 'p' }, CANARY, [1, 2]]) {
      expect(isShaped(shapeTop(x))).toBe(true);
    }
    expect(isShaped(null)).toBe(true);
    expect(isShaped({})).toBe(true);
    expect(isShaped({ to: '+15555550123' })).toBe(false);
    expect(isShaped({ password: '[REDACTED]' })).toBe(false);   // the pre-SEC-2 redaction form
    expect(isShaped({ n: 5 })).toBe(false);
    expect(isShaped({ a: { b: '[num]' } })).toBe(false);
    expect(isShaped({ a: '[str 3]', b: 'raw' })).toBe(false);
    expect(isShaped(['[num]'])).toBe(false);
    expect(isShaped('raw text body')).toBe(false);
    expect(isShaped('[str 4]')).toBe(true);
    expect(isShaped(5)).toBe(false);
    expect(isShaped({ a: '[str x]' })).toBe(false);
    expect(isShaped({ a: '[str 3] trailing' })).toBe(false);
    expect(isShaped({ note: 'call back re [num]' })).toBe(false);   // a raw value that merely ENDS in a tag
    expect(isShaped('see [arr 2]')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// the audit write — canary never stored
// ─────────────────────────────────────────────────────────────

function capturingReq(extra = {}) {
  const captured = { params: null };
  const req = {
    originalUrl: '/api/tasks', method: 'POST',
    headers: { 'user-agent': 'jest' }, query: {}, body: {},
    socket: { remoteAddress: '127.0.0.1' },
    db: {
      query: jest.fn((sql, params) => {
        if (sql.includes('jwt_api_audit_log')) captured.params = params;
        return Promise.resolve([{}]);
      }),
    },
    ...extra,
  };
  return { req, captured };
}

describe('logJwtApiAttempt — no body/query VALUE reaches the row', () => {
  test('canary everywhere in body and query: absent from every param; keys kept', async () => {
    const { logJwtApiAttempt } = require('../lib/auth.jwtOrApiKey');
    const big = {};
    for (let i = 0; i < 205; i++) big[`f${i}`] = CANARY;
    const { req, captured } = capturingReq({
      body: {
        to: CANARY, message: `hello ${CANARY}`, nested: { inner: CANARY }, rows: [{ name: CANARY }],
        password: CANARY, n: 5, flag: false, nil: null, ...big,
      },
      query: { status: CANARY, filter: [CANARY, CANARY], obj: { x: CANARY } },
    });
    await logJwtApiAttempt(req, 'jwt', 'alice', 'authorized');
    expect(captured.params).not.toBeNull();
    for (const p of captured.params) expect(String(p)).not.toContain(CANARY);
    const query = JSON.parse(captured.params[3]);
    const body = JSON.parse(captured.params[4]);
    expect(query).toEqual({ status: `[str ${CANARY.length}]`, filter: '[arr 2]', obj: '[obj 1]' });
    expect(body).toMatchObject({
      to: `[str ${CANARY.length}]`, message: `[str ${CANARY.length + 6}]`, nested: '[obj 1]',
      rows: '[arr 1]', password: '[secret]', n: '[num]', flag: '[bool]', nil: '[null]',
    });
  });

  test('a raw string body (text parser) is one tag, not the text', async () => {
    const { logJwtApiAttempt } = require('../lib/auth.jwtOrApiKey');
    const { req, captured } = capturingReq({ body: `raw ${CANARY}` });
    await logJwtApiAttempt(req, 'jwt', 'alice', 'authorized');
    expect(JSON.parse(captured.params[4])).toBe(`[str ${CANARY.length + 4}]`);
    for (const p of captured.params) expect(String(p)).not.toContain(CANARY);
  });

  test('no body / no query → {} (unchanged contract for GETs)', async () => {
    const { logJwtApiAttempt } = require('../lib/auth.jwtOrApiKey');
    const { req, captured } = capturingReq({ method: 'GET', body: undefined, query: undefined });
    await logJwtApiAttempt(req, 'jwt', 'alice', 'authorized');
    expect(JSON.parse(captured.params[3])).toEqual({});
    expect(JSON.parse(captured.params[4])).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// the scrub — scripted conn
// ─────────────────────────────────────────────────────────────

/**
 * An in-memory jwt_api_audit_log that behaves like mysql2 over a JSON
 * column: values written as JSON text, read back PARSED; SQL NULL stays null.
 */
function scriptedConn(rows, { types = { id: 'bigint', body: 'json', query_params: 'json' }, failUpdateOnId = null, lostUpdateOnId = null } = {}) {
  const table = new Map(rows.map(r => [r.id, {
    ...r,
    body: r.body === null ? null : JSON.stringify(r.body),
    query_params: r.query_params === null ? null : JSON.stringify(r.query_params),
  }]));
  const read = (r) => ({
    id: r.id,
    body: r.body === null ? null : JSON.parse(r.body),
    query_params: r.query_params === null ? null : JSON.parse(r.query_params),
  });
  const log = { selects: [], updates: [], statements: [], sets: [] };
  const conn = {
    log, table,
    query: async (sql, params = []) => {
      if (/information_schema\.columns/.test(sql)) {
        return [Object.entries(types).map(([name, type]) => ({ name, type }))];
      }
      if (/^SET SESSION/.test(sql)) { log.sets.push(sql); return [{}]; }
      if (/WHERE id > \? ORDER BY id LIMIT \?/.test(sql)) {
        const [from, limit] = params;
        log.selects.push([from, limit]);
        return [[...table.values()].filter(r => r.id > from).sort((a, b) => a.id - b.id).slice(0, limit).map(read)];
      }
      if (/^SELECT id, body, query_params FROM jwt_api_audit_log WHERE id IN \(/.test(sql)) {
        return [params.map(id => table.get(id)).filter(Boolean).map(read)];
      }
      const m = /^UPDATE jwt_api_audit_log SET body = CASE id ((?:WHEN \? THEN \? ?)+)END, query_params = CASE id ((?:WHEN \? THEN \? ?)+)END WHERE id IN \(([?,]+)\)$/.exec(sql);
      if (m) {
        // one statement per batch: the CASE arms must line up with the IN list
        const n = m[3].split(',').length;
        expect(m[1].match(/WHEN/g)).toHaveLength(n);
        expect(m[2].match(/WHEN/g)).toHaveLength(n);
        expect(params).toHaveLength(5 * n);
        const bodies = params.slice(0, 2 * n), queries = params.slice(2 * n, 4 * n), ids = params.slice(4 * n);
        log.statements.push(ids.length);
        if (ids.includes(failUpdateOnId)) throw new Error('Lock wait timeout exceeded');   // atomic: nothing applied
        ids.forEach((id, i) => {
          expect([bodies[2 * i], queries[2 * i]]).toEqual([id, id]);
          log.updates.push(id);
          if (id === lostUpdateOnId) return;   // a write that silently did not land (e.g. a racing writer)
          Object.assign(table.get(id), { body: bodies[2 * i + 1], query_params: queries[2 * i + 1] });
        });
        return [{ affectedRows: ids.length }];
      }
      throw new Error(`unscripted SQL: ${sql}`);
    },
  };
  return conn;
}

const rawRow = (id) => ({
  id, route: `/api/sms?to=${id}`, auth_type: 'jwt', ip_address: '10.0.0.1',
  body: { to: CANARY, message: `hi ${CANARY}`, ids: [1, 2], nested: { a: CANARY }, password: '[REDACTED]' },
  query_params: { q: '[REDACTED]', page: '2' },
});

describe('scripts/sec2ScrubAuditShapes — scripted conn', () => {
  const quiet = () => { const lines = []; return { lines, log: (s) => lines.push(String(s)) }; };

  test('CHECK counts and writes nothing', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const conn = scriptedConn([1, 2, 3].map(rawRow));
    const q = quiet();
    const r = await script.run(conn, { apply: false, log: q.log });
    expect(r).toEqual({ ok: true, scanned: 3, rewritten: 3 });
    expect(conn.log.updates).toEqual([]);
    expect(conn.log.statements).toEqual([]);
    expect(conn.log.sets).toEqual([]);
    expect(q.lines.filter(l => /^(GO|NO-GO)\b/.test(l))).toEqual([expect.stringMatching(/^GO — .*--apply/)]);
  });

  test('APPLY: id batches of BATCH, every row shaped through the same shapeTop, other columns untouched', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const { shapeTop, isShaped } = require('../lib/auditShape');
    const N = script.BATCH * 2 + 17;
    // sparse ids (gaps) prove the cursor follows the last id read, not a counter
    const ids = Array.from({ length: N }, (_, i) => i * 3 + 5);
    const conn = scriptedConn(ids.map(rawRow));
    const q = quiet();
    const r = await script.run(conn, { apply: true, log: q.log });
    expect(r).toEqual({ ok: true, scanned: N, rewritten: N });
    expect(conn.log.sets).toEqual(['SET SESSION lock_wait_timeout = 5']);
    expect(conn.log.selects).toEqual([
      [0, script.BATCH],
      [ids[script.BATCH - 1], script.BATCH],
      [ids[script.BATCH * 2 - 1], script.BATCH],
      [ids[N - 1], script.BATCH],
    ]);
    expect(conn.log.statements).toEqual([script.BATCH, script.BATCH, 17]);   // ONE UPDATE per batch
    const want = rawRow(0);
    for (const row of conn.table.values()) {
      expect(row.body).not.toContain(CANARY);
      expect(JSON.parse(row.body)).toEqual(shapeTop(want.body));          // same summarizer as a new row
      expect(JSON.parse(row.query_params)).toEqual(shapeTop(want.query_params));
      expect(isShaped(JSON.parse(row.body))).toBe(true);
      expect(row.route).toBe(`/api/sms?to=${row.id}`);
      expect(row.auth_type).toBe('jwt');
      expect(row.ip_address).toBe('10.0.0.1');
    }
    expect(JSON.parse(conn.table.get(5).body)).toEqual({
      to: `[str ${CANARY.length}]`, message: `[str ${CANARY.length + 3}]`, ids: '[arr 2]', nested: '[obj 1]', password: '[secret]',
    });
    expect(q.lines.filter(l => /^(GO|NO-GO)\b/.test(l))).toEqual([expect.stringMatching(/^GO — history scrubbed/)]);
  });

  test('re-run is a no-op: already-shaped rows skipped, no UPDATE', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const conn = scriptedConn([1, 2, 3, 4].map(rawRow));
    await script.run(conn, { apply: true, log: () => {} });
    conn.log.updates.length = 0; conn.log.statements.length = 0;
    const before = JSON.stringify([...conn.table.values()]);
    const q = quiet();
    const r = await script.run(conn, { apply: true, log: q.log });
    expect(r).toEqual({ ok: true, scanned: 4, rewritten: 0 });
    expect(conn.log.updates).toEqual([]);
    expect(conn.log.statements).toEqual([]);
    expect(JSON.stringify([...conn.table.values()])).toBe(before);
    expect(q.lines.filter(l => /^(GO|NO-GO)\b/.test(l))).toEqual([expect.stringMatching(/^GO — every row was already shaped/)]);
    // and CHECK agrees
    expect(await script.run(conn, { apply: false, log: () => {} })).toEqual({ ok: true, scanned: 4, rewritten: 0 });
  });

  test('mixed rows: only the unshaped are rewritten; a NULL side stays NULL; a shaped side is kept as is', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const conn = scriptedConn([
      { id: 1, body: { a: '[str 3]' }, query_params: {} },                 // already shaped → skipped
      { id: 2, body: null, query_params: { status: 'open' } },             // NULL body, raw query
      { id: 3, body: { to: CANARY }, query_params: null },                 // raw body, NULL query
      { id: 4, body: { k: '[num]' }, query_params: { q: CANARY } },        // shaped body kept verbatim
      { id: 5, body: `raw ${CANARY}`, query_params: {} },                  // a stored string body
    ]);
    const r = await script.run(conn, { apply: true, log: () => {} });
    expect(r).toEqual({ ok: true, scanned: 5, rewritten: 4 });
    expect(conn.log.updates).toEqual([2, 3, 4, 5]);
    expect(conn.log.statements).toEqual([4]);
    const t = conn.table;
    expect(t.get(1).body).toBe(JSON.stringify({ a: '[str 3]' }));
    expect(t.get(2).body).toBeNull();
    expect(JSON.parse(t.get(2).query_params)).toEqual({ status: '[str 4]' });
    expect(JSON.parse(t.get(3).body)).toEqual({ to: `[str ${CANARY.length}]` });
    expect(t.get(3).query_params).toBeNull();
    expect(JSON.parse(t.get(4).body)).toEqual({ k: '[num]' });
    expect(JSON.parse(t.get(4).query_params)).toEqual({ q: `[str ${CANARY.length}]` });
    expect(JSON.parse(t.get(5).body)).toBe(`[str ${CANARY.length + 4}]`);
    for (const row of t.values()) expect(String(row.body) + String(row.query_params)).not.toContain(CANARY);
  });

  test('a failing batch writes nothing of itself, names the resume id, and keeps earlier batches', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const N = script.BATCH + 10;
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const conn = scriptedConn(ids.map(rawRow), { failUpdateOnId: script.BATCH + 4 });
    const q = quiet();
    const r = await script.run(conn, { apply: true, log: q.log });
    expect(r).toEqual({ ok: false, scanned: N, rewritten: script.BATCH });
    expect(conn.log.statements).toEqual([script.BATCH, 10]);
    expect(conn.table.get(1).body).not.toContain(CANARY);                       // batch 1 written
    expect(conn.table.get(script.BATCH + 1).body).toContain(CANARY);           // batch 2 not written, whole
    const nogo = q.lines.filter(l => /^(GO|NO-GO)\b/.test(l));
    expect(nogo).toEqual([`NO-GO — nothing in that batch was written. Resume: node scripts/sec2ScrubAuditShapes.js --apply --from-id=${script.BATCH}`]);
    // resuming from the named id (failure cleared) finishes the job — and only
    // the rows after it are touched
    const resumed = scriptedConnFrom(conn);
    const r2 = await script.run(resumed, { apply: true, fromId: script.BATCH, log: () => {} });
    expect(r2).toEqual({ ok: true, scanned: 10, rewritten: 10 });
    expect(resumed.log.selects[0]).toEqual([script.BATCH, script.BATCH]);
    expect(resumed.log.updates).toEqual(ids.slice(script.BATCH));
    for (const row of resumed.table.values()) expect(row.body).not.toContain(CANARY);
  });

  test('verify: a batch whose rows do not read back shaped is a NO-GO naming the resume id', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const conn = scriptedConn([1, 2, 3].map(rawRow), { lostUpdateOnId: 2 });
    const q = quiet();
    const r = await script.run(conn, { apply: true, log: q.log });
    expect(r).toEqual({ ok: false, scanned: 3, rewritten: 0 });
    expect(q.lines.filter(l => /^(GO|NO-GO)\b/.test(l))).toEqual([
      'NO-GO — verify by hand. Resume: node scripts/sec2ScrubAuditShapes.js --apply --from-id=0',
    ]);
    expect(q.lines.join('\n')).toMatch(/verify failed after id 0: 1 row\(s\) not shaped, 3\/3 read back/);
  });

  test('a table in another shape is a NO-GO with nothing read or written', async () => {
    const script = require('../scripts/sec2ScrubAuditShapes');
    const conn = scriptedConn([rawRow(1)], { types: { id: 'bigint', body: 'text', query_params: 'json' } });
    const q = quiet();
    expect(await script.run(conn, { apply: true, log: q.log })).toEqual({ ok: false });
    expect(conn.log.selects).toEqual([]);
    expect(conn.log.updates).toEqual([]);
    expect(conn.log.sets).toEqual([]);
    expect(q.lines.filter(l => /^(GO|NO-GO)\b/.test(l))).toEqual([expect.stringMatching(/^NO-GO/)]);
  });
});

/** A fresh, non-failing scripted conn over a copy of another conn's current table. */
function scriptedConnFrom(conn) {
  return scriptedConn([...conn.table.values()].map(r => ({
    ...r,
    body: r.body === null ? null : JSON.parse(r.body),
    query_params: r.query_params === null ? null : JSON.parse(r.query_params),
  })));
}
