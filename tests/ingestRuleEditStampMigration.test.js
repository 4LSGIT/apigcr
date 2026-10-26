// tests/ingestRuleEditStampMigration.test.js
//
/**
 * A20 slice 1 — scripts/ingestRuleEditStampAndChangeLog.js and its record,
 * ref/migrations/2026-10-27_ingest_rule_edit_stamp_change_log.sql.
 *
 *   1. THE PLAN (always runs, no database). Every live state — fresh, stopped
 *      after the ADD, backfill pending, done — maps to the right remaining
 *      steps; every unsafe state (a column of that name someone else added, a
 *      changed updated_at, a foreign comment, a change table of another shape,
 *      a trigger on the tables, anything in the schema naming the new names)
 *      is a NO-GO with no steps.
 *   2. THE RECORD names exactly what the script runs.
 *   3. THE ENGINE (gated). The script itself, against the gated database (the
 *      record's ROLLBACK lines first, so it starts pre-migration whatever the
 *      dump holds): CHECK writes nothing; --apply adds, backfills (every stamp
 *      = its row's updated_at, no updated_at moved), comments, creates,
 *      verifies and smoke-tests; a re-run is ALREADY APPLIED; a hand-added
 *      column of the same name → NO-GO with nothing changed; a row lock held
 *      on one table times out in 5 s after the other channel applied, and the
 *      re-run resumes; a run stopped after the ADD resumes and backfills a row
 *      the old code inserted meanwhile. It ends APPLIED (other suites need it).
 *
 * ── PART 3 IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ───────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_a20s1_mig_test npx jest tests/ingestRuleEditStampMigration.test.js --runInBand
 * A throwaway *_test database loaded from ref/database.sql; the suite DELETEs
 * the ingest rule rows. Never port 3306 (the production proxy) — it refuses.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = require('../scripts/ingestRuleEditStampAndChangeLog');
const { CHANNELS, COL, SENTINEL, COL_COMMENT, UPD_COMMENT, CHANGE_COLUMNS, SQL, plan, run } = M;

const REPO = path.join(__dirname, '..');
const RECORD = 'ref/migrations/2026-10-27_ingest_rule_edit_stamp_change_log.sql';
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ═════════════════════════════════════════════════════════════
// 1. plan() — pure
// ═════════════════════════════════════════════════════════════

const UPD = (over = {}) => ({ type: 'datetime', nullable: 'NO', dflt: 'CURRENT_TIMESTAMP', comment: '',
  extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', gen: '', ...over });
const STAMP_TARGET = (over = {}) => ({ type: 'datetime(3)', nullable: 'NO', dflt: 'CURRENT_TIMESTAMP(3)', comment: COL_COMMENT,
  extra: 'DEFAULT_GENERATED', gen: '', ...over });
const STAMP_MID = (over = {}) => ({ type: 'datetime(3)', nullable: 'NO', dflt: SENTINEL, comment: COL_COMMENT, extra: '', gen: '', ...over });
const CHANGES = (ch, over = {}) => ({
  engine: 'InnoDB', coll: 'utf8mb4_general_ci', comment: M.tableComment(ch),
  cols: CHANGE_COLUMNS.map(([c, type, nullable]) => ({ c, type, nullable,
    extra: c === 'id' ? 'auto_increment' : c === 'changed_at' ? 'DEFAULT_GENERATED' : '' })),
  idx: ['PRIMARY:1:id', 'idx_rule_changed:1:rule_id', 'idx_rule_changed:2:changed_at'],
  ...over,
});
function chState(ch, over = {}) {
  return { rulesTable: true, rows: 3, actions: 2, sentinelRows: null, stamp: null, updatedAt: UPD(), changes: null, ...over };
}
function state(perOver = {}, top = {}) {
  const per = {};
  for (const ch of CHANNELS) per[ch] = chState(ch, perOver[ch] || {});
  return { user: 'u', db: 'd', version: '8.4.11', per, refs: [], tableTriggers: [], ...top };
}
const kinds = (p) => p.steps.map((s) => `${s.kind}:${s.ch}`);

describe('plan()', () => {
  test('fresh: add → modify → backfill → updComment → create, per channel', () => {
    const p = plan(state());
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['add:email', 'modify:email', 'backfill:email', 'updComment:email', 'create:email',
      'add:phone', 'modify:phone', 'backfill:phone', 'updComment:phone', 'create:phone']);
  });
  test('stopped after the ADD: modify + backfill (sentinel rows left)', () => {
    const p = plan(state({ email: { stamp: STAMP_MID(), sentinelRows: 3 } }));
    expect(kinds(p).filter((k) => k.endsWith(':email'))).toEqual(['modify:email', 'backfill:email', 'updComment:email', 'create:email']);
  });
  test('target column, sentinel rows left → backfill only; none left → nothing', () => {
    expect(kinds(plan(state({ email: { stamp: STAMP_TARGET(), sentinelRows: 1, updatedAt: UPD({ comment: UPD_COMMENT }), changes: CHANGES('email') } })))
      .filter((k) => k.endsWith(':email'))).toEqual(['backfill:email']);
    const done = { stamp: STAMP_TARGET(), sentinelRows: 0, updatedAt: UPD({ comment: UPD_COMMENT }) };
    const p = plan(state({ email: { ...done, changes: CHANGES('email') }, phone: { ...done, changes: CHANGES('phone') } }));
    expect(p).toEqual({ problems: [], steps: [], done: true });
  });
  test.each([
    ['a nullable DATETIME someone added', { stamp: STAMP_TARGET({ type: 'datetime', nullable: 'YES', dflt: null, extra: '' }) }],
    ['the target type with a foreign comment', { stamp: STAMP_TARGET({ comment: 'mine' }) }],
    ['an ON UPDATE stamp (would move on every match)', { stamp: STAMP_TARGET({ extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)' }) }],
    ['a generated column', { stamp: STAMP_TARGET({ gen: 'updated_at', extra: 'VIRTUAL GENERATED' }) }],
    ['a changed updated_at', { updatedAt: UPD({ extra: 'DEFAULT_GENERATED' }) }],
    ['a foreign updated_at comment', { updatedAt: UPD({ comment: 'someone' }) }],
    ['a change table of another shape', { changes: CHANGES('email', { cols: CHANGES('email').cols.slice(0, 3) }) }],
    ['a change table on the wrong collation', { changes: CHANGES('email', { coll: 'utf8mb4_0900_ai_ci' }) }],
    ['a change table missing its index', { changes: CHANGES('email', { idx: ['PRIMARY:1:id'] }) }],
    ['a change table with a nullable rule_id', { changes: CHANGES('email', { cols: CHANGES('email').cols.map((c) => (c.c === 'rule_id' ? { ...c, nullable: 'YES' } : c)) }) }],
    ['no rules table', { rulesTable: false }],
  ])('NO-GO, no steps: %s', (_label, over) => {
    const p = plan(state({ email: over }));
    expect(p.problems.length).toBeGreaterThan(0);
    expect(p.steps).toEqual([]);
    expect(p.done).toBe(false);
  });
  test('NO-GO: a trigger on the tables, or a schema object naming the new names', () => {
    expect(plan(state({}, { tableTriggers: [{ name: 't1', table: 'email_ingest_rules' }] })).problems).toHaveLength(1);
    expect(plan(state({}, { refs: [{ kind: 'view', name: 'v' }] })).problems).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. the record
// ═════════════════════════════════════════════════════════════

describe('the record', () => {
  const rec = read(RECORD);
  const lit = (s) => `'${s.replace(/'/g, "''")}'`;
  test.each(CHANNELS)('%s: names every statement the script runs, verbatim', (ch) => {
    for (const s of [SQL.add(ch).replace('?', lit(COL_COMMENT)), SQL.modify(ch).replace('?', lit(COL_COMMENT)),
      SQL.backfill(ch), SQL.updComment(ch).replace('?', lit(UPD_COMMENT)), SQL.create(ch)]) {
      expect(rec).toContain(`${s};`);
    }
    expect(rec).toContain('SET SESSION lock_wait_timeout = 5;');
    expect(rec).toContain('SET SESSION innodb_lock_wait_timeout = 5;');
    expect(SQL.lockWait).toBe('SET SESSION lock_wait_timeout = 5');
    expect(SQL.rowWait).toBe('SET SESSION innodb_lock_wait_timeout = 5');
  });
  test('comments fit MySQL limits and carry the landmine sentence', () => {
    expect(COL_COMMENT.length).toBeLessThanOrEqual(1024);
    expect(UPD_COMMENT.length).toBeLessThanOrEqual(1024);
    for (const ch of CHANNELS) expect(M.tableComment(ch).length).toBeLessThanOrEqual(2048);
    expect(COL_COMMENT).toContain('Every match bumps updated_at; this column is the edit stamp');
  });
});

// ═════════════════════════════════════════════════════════════
// 3. the engine (gated)
// ═════════════════════════════════════════════════════════════

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('the script on MySQL', () => {
  const mysql = require('mysql2/promise');
  let opts;
  let conn;          // the script's one connection
  let other;         // a second session (lock holder / old code)
  const quiet = { log: () => {} };
  const q = async (sql, p) => (await conn.query(sql, p))[0];

  const ROLLBACK = read(RECORD).split('\n')
    .filter((l) => /^--   (DROP TABLE|ALTER TABLE)/.test(l)).map((l) => l.replace(/^--   /, '').replace(/;$/, ''));

  async function rollbackToPre() {
    for (const s of ROLLBACK) {
      try { await q(s); } catch (e) { if (!/check that column\/key exists|Can't DROP/i.test(e.message)) throw e; }
    }
  }
  const showCreate = async () => {
    const out = [];
    for (const ch of CHANNELS) out.push((await q(`SHOW CREATE TABLE ${ch}_ingest_rules`))[0]['Create Table']);
    const t = await q("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%ingest_rule_changes'");
    return JSON.stringify([out, t]);
  };
  const rowsOf = async (ch) => q(`SELECT * FROM ${ch}_ingest_rules ORDER BY id`);

  async function seed() {
    for (const ch of CHANNELS) {
      await q(`DELETE FROM ${ch}_ingest_rules`);
      for (let i = 1; i <= 4; i++) {
        await q(`INSERT INTO ${ch}_ingest_rules (id, name, match_mode, match_config, match_count, last_matched_at, created_at, updated_at)
                 VALUES (?, ?, 'conditions', '{"operator":"and","conditions":[]}', ?, ?, '2026-06-01 10:00:00', ?)`,
        [i, `${ch} ${i}`, i * 10, i <= 2 ? `2026-10-2${i} 09:00:00` : null, i <= 2 ? `2026-10-2${i} 09:00:00` : `2026-07-0${i} 12:00:00`]);
      }
      await q(`INSERT INTO ${ch}_ingest_rule_actions (rule_id, position, active, action_type, config) VALUES (1, 0, 1, 'workflow', '{"workflow_id":1}')`);
    }
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    if (Number(u.port) === 3306) throw new Error('port 3306 is the production proxy — refusing');
    opts = { host: u.hostname, port: Number(u.port), database, timezone: 'Z',
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    conn = await mysql.createConnection(opts);
    other = await mysql.createConnection(opts);
    for (const c of [conn, other]) await c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
  });
  afterAll(async () => {
    // leave it APPLIED: the other gated ingest suites expect the column. The
    // connections close whatever the assertion says — an open one would hold
    // jest past its last test.
    try {
      if (conn) expect((await run(conn, { apply: true, ...quiet })).ok).toBe(true);
    } finally {
      if (conn) await conn.end().catch(() => {});
      if (other) await other.end().catch(() => {});
    }
  });

  test('CHECK writes nothing; --apply backfills from updated_at without moving it; re-run is ALREADY APPLIED', async () => {
    await rollbackToPre();
    await seed();
    const schema0 = await showCreate();
    const rows0 = { email: await rowsOf('email'), phone: await rowsOf('phone') };

    const check = await run(conn, quiet);
    expect(check.line).toMatch(/^CHECK OK — GO/);
    expect(await showCreate()).toBe(schema0);

    const lines = [];
    const r = await run(conn, { apply: true, log: (l) => lines.push(l) });
    expect(r.line).toMatch(/^APPLIED — GO/);
    expect(lines.filter((l) => /✓ smoke/.test(l))).toHaveLength(2);
    for (const ch of CHANNELS) {
      const after = await rowsOf(ch);
      expect(after).toHaveLength(4);
      after.forEach((a, i) => {
        expect(+a.updated_at).toBe(+rows0[ch][i].updated_at);              // the backfill moved no updated_at
        expect(+a[COL]).toBe(+rows0[ch][i].updated_at);                    // and copied it
        expect(+a.match_count).toBe(+rows0[ch][i].match_count);            // the smoke bump was rolled back
      });
      const [c] = await q(`SELECT COLUMN_DEFAULT AS d, COLUMN_COMMENT AS c FROM information_schema.COLUMNS
                           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [`${ch}_ingest_rules`, COL]);
      expect(c).toEqual({ d: 'CURRENT_TIMESTAMP(3)', c: COL_COMMENT });
      expect((await q(`SELECT COUNT(*) AS n FROM ${ch}_ingest_rule_changes`))[0].n).toBe(0);   // the smoke row did not persist
      // a fresh insert gets a real stamp, not the sentinel
      await q(`INSERT INTO ${ch}_ingest_rules (name) VALUES ('after')`);
      const [n] = await q(`SELECT ${COL} AS s FROM ${ch}_ingest_rules WHERE name = 'after'`);
      expect(+n.s).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
      await q(`DELETE FROM ${ch}_ingest_rules WHERE name = 'after'`);
    }
    const again = await run(conn, quiet);
    expect(again.line).toMatch(/^ALREADY APPLIED — GO/);
  });

  test('a column of that name someone added by hand → NO-GO, nothing changed', async () => {
    await rollbackToPre();
    await q('ALTER TABLE email_ingest_rules ADD COLUMN definition_updated_at DATETIME NULL');
    const schema0 = await showCreate();
    for (const apply of [false, true]) {
      const r = await run(conn, { apply, ...quiet });
      expect(r.line).toMatch(/^NO-GO — 1 problem\(s\) above\. Nothing was changed/);
    }
    expect(await showCreate()).toBe(schema0);
    await q('ALTER TABLE email_ingest_rules DROP COLUMN definition_updated_at');
  });

  test('a row lock held on the phone table: email applies, phone times out in ~5 s with nothing changed there; the re-run resumes', async () => {
    await rollbackToPre();
    await seed();
    const phone0 = (await q('SHOW CREATE TABLE phone_ingest_rules'))[0]['Create Table'];
    await other.beginTransaction();
    await other.query('SELECT * FROM phone_ingest_rules WHERE id = 1 FOR UPDATE');
    const t0 = Date.now();
    let r;
    try {
      r = await run(conn, { apply: true, ...quiet });
    } finally {
      await other.rollback();
    }
    const took = Date.now() - t0;
    expect(r.line).toMatch(/^NO-GO — stopped after: add email; modify email; backfill email; updComment email; create email\./);
    expect(took).toBeGreaterThan(4500);
    expect(took).toBeLessThan(15000);
    expect((await q('SHOW CREATE TABLE phone_ingest_rules'))[0]['Create Table']).toBe(phone0);
    const again = await run(conn, { apply: true, ...quiet });
    expect(again.line).toMatch(/^APPLIED — GO/);
  }, 30000);

  test('stopped after the ADD; the old code inserts a rule meanwhile; the re-run backfills both', async () => {
    await rollbackToPre();
    await seed();
    await q(SQL.add('email'), [COL_COMMENT]);
    await other.query("INSERT INTO email_ingest_rules (name, updated_at) VALUES ('old code', '2026-10-27 01:02:03')");
    const check = await run(conn, quiet);
    expect(check.state.per.email.sentinelRows).toBe(5);
    const r = await run(conn, { apply: true, ...quiet });
    expect(r.line).toMatch(/^APPLIED — GO/);
    const [o] = await q(`SELECT updated_at, ${COL} AS s FROM email_ingest_rules WHERE name = 'old code'`);
    expect(o.s.toISOString()).toBe('2026-10-27T01:02:03.000Z');
    expect(+o.updated_at).toBe(+o.s);
    expect((await q(`SELECT COUNT(*) AS n FROM email_ingest_rules WHERE ${COL} = '${SENTINEL}'`))[0].n).toBe(0);
  });
});
