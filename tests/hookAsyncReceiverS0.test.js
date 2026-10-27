// tests/hookAsyncReceiverS0.test.js
//
/**
 * Async hook receiver S0 — scripts/hookAsyncReceiverS0.js and its record,
 * ref/migrations/2026-10-28_hook_executions_async_receiver.sql.
 *
 *   1. THE PLAN (always runs, no database). Every live state — fresh, half
 *      applied, done — maps to the right remaining steps, and every unsafe
 *      state (a column of another shape, a changed status definition, a
 *      foreign comment, a trigger, a schema object naming the columns) is a
 *      NO-GO before any write.
 *   2. THE RECORD names exactly what the script runs.
 *   3. THE ENGINE (gated). The script against a MySQL 8.4 clone of
 *      hook_executions cut line by line from ref/database.sql: CHECK writes
 *      nothing; --apply adds the three columns INSTANT, comments status,
 *      verifies and smoke-tests the claim primitive; a re-run is ALREADY
 *      APPLIED; a half-applied state resumes; a hand-added column of another
 *      shape is a NO-GO with nothing changed; a metadata lock held elsewhere
 *      times out in 5 s with nothing changed; and the claim UPDATE wins exactly
 *      once under two concurrent sessions — the at-least-once primitive.
 *
 * ── PART 3 IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ───────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_hooks0_test npx jest tests/hookAsyncReceiverS0.test.js --runInBand
 * The database name must end in _test; the suite DROPS and recreates
 * hook_executions in it. Never point it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const S = require('../scripts/hookAsyncReceiverS0');
const { TABLE, COLUMNS, STATUS_TYPE, STATUS_COMMENT, SQL, NAMES_RE, plan, run } = S;

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ═════════════════════════════════════════════════════════════
// 1. plan() — pure
// ═════════════════════════════════════════════════════════════

const STATUS = (over = {}) => ({ type: STATUS_TYPE, nullable: 'NO', dflt: 'received', comment: '', extra: '', gen: '', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', ...over });
const target = (name, over = {}) => {
  const spec = COLUMNS.find((c) => c.name === name);
  return { type: spec.type, nullable: spec.nullable, dflt: spec.dflt, comment: spec.comment, extra: '', gen: '', ...over };
};
function state(over = {}) {
  return {
    user: 'yc_app@%', db: 'x_test', version: '8.4.11', table: true, rows: 34623, tableCollation: 'utf8mb4_general_ci',
    cols: { claimed_at: null, completed_at: null, attempts: null },
    status: STATUS(),
    order: ['id', 'hook_id', 'slug', 'raw_input', 'filter_passed', 'transform_output', 'status', 'error', 'created_at'],
    refs: [], tableTriggers: [],
    ...over,
  };
}
const kinds = (p) => p.steps.map((st) => (st.kind === 'add' ? `add:${st.name}` : st.kind));

describe('plan(): live state → remaining steps', () => {
  test('fresh: the three adds in order, then the status comment — no problems', () => {
    const p = plan(state());
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['add:claimed_at', 'add:completed_at', 'add:attempts', 'statusComment']);
    expect(p.done).toBe(false);
  });

  test('half applied — two columns there, one missing, no comment yet: only what is left', () => {
    const p = plan(state({ cols: { claimed_at: target('claimed_at'), completed_at: target('completed_at'), attempts: null } }));
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['add:attempts', 'statusComment']);
  });

  test('done: all three the target and the comment set → done, no steps', () => {
    const p = plan(state({
      cols: { claimed_at: target('claimed_at'), completed_at: target('completed_at'), attempts: target('attempts') },
      status: STATUS({ comment: STATUS_COMMENT }),
    }));
    expect(p).toMatchObject({ problems: [], steps: [], done: true });
  });

  test('a column of another shape is a NO-GO (not this migration\'s column)', () => {
    const cases = [
      target('claimed_at', { type: 'datetime' }),
      target('claimed_at', { nullable: 'NO', dflt: 'CURRENT_TIMESTAMP(3)', extra: 'DEFAULT_GENERATED' }),
      target('claimed_at', { comment: 'someone else\'s' }),
      target('claimed_at', { extra: 'on update CURRENT_TIMESTAMP(3)' }),
    ];
    for (const c of cases) {
      const p = plan(state({ cols: { claimed_at: c, completed_at: null, attempts: null } }));
      expect(p.problems).toEqual([expect.stringMatching(/^hook_executions\.claimed_at already exists as .* — not this migration's column/)]);
      expect(p.steps).toEqual([]);
    }
    const p = plan(state({ cols: { claimed_at: null, completed_at: null, attempts: target('attempts', { type: 'int' }) } }));
    expect(p.problems[0]).toMatch(/^hook_executions\.attempts already exists as int NOT NULL DEFAULT 0/);
  });

  test('a changed status definition is a NO-GO — the comment MODIFY would change it', () => {
    for (const over of [{ type: "enum('received','filtered')" }, { nullable: 'YES' }, { dflt: 'filtered' }, { dflt: null }]) {
      const p = plan(state({ status: STATUS(over) }));
      expect(p.problems).toEqual([expect.stringMatching(/^hook_executions\.status is .*, expected enum\(.*\) NOT NULL DEFAULT 'received' — the comment MODIFY would change it$/)]);
    }
    expect(plan(state({ status: null })).problems[0]).toMatch(/^hook_executions\.status is missing/);
  });

  test('a status collation that differs from the table default is a NO-GO — the MODIFY would re-collate it', () => {
    const p = plan(state({ status: STATUS({ collation: 'utf8mb4_0900_ai_ci' }) }));
    expect(p.problems).toEqual(['hook_executions.status is utf8mb4 / utf8mb4_0900_ai_ci while the table default is utf8mb4_general_ci — the comment MODIFY would re-collate it']);
    expect(plan(state({ tableCollation: 'utf8mb4_0900_ai_ci' })).problems[0]).toMatch(/would re-collate it$/);
    expect(plan(state({ status: STATUS({ charset: 'latin1', collation: 'utf8mb4_general_ci' }) })).problems[0]).toMatch(/^hook_executions\.status is latin1/);
  });

  test('a status comment someone else set is a NO-GO, never overwritten', () => {
    const p = plan(state({ status: STATUS({ comment: 'mine' }) }));
    expect(p.problems).toEqual([expect.stringMatching(/^hook_executions\.status already carries a different comment \("mine"\)/)]);
  });

  test('a trigger on the table, or a schema object naming the table and a column, is a NO-GO', () => {
    expect(plan(state({ tableTriggers: [{ name: 't_x', table: TABLE }] })).problems)
      .toEqual([expect.stringMatching(/^trigger t_x on hook_executions — this migration expects none/)]);
    expect(plan(state({ refs: [{ kind: 'view', name: 'v_x' }] })).problems)
      .toEqual(['view v_x already names hook_executions and one of the new columns — find out what wrote it before going on']);
  });

  test('no hook_executions table is a NO-GO', () => {
    expect(plan(state({ table: false })).problems[0]).toMatch(/no `hook_executions` table/);
  });

  test('NAMES_RE matches the three names as identifiers only', () => {
    expect(NAMES_RE.test('SELECT `claimed_at` FROM x')).toBe(true);
    expect(NAMES_RE.test('WHERE completed_at IS NULL')).toBe(true);
    expect(NAMES_RE.test('attempts + 1')).toBe(true);
    expect(NAMES_RE.test('reattempts_total')).toBe(false);
    expect(NAMES_RE.test('unclaimed_at_x')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. The record names exactly what the script runs
// ═════════════════════════════════════════════════════════════

describe('ref/migrations record', () => {
  const rec = read('ref/migrations/2026-10-28_hook_executions_async_receiver.sql');
  test('every ADD and the status MODIFY appear verbatim with their comments, after the lock timeout', () => {
    expect(rec).toContain('SET SESSION lock_wait_timeout = 2;');
    for (const c of COLUMNS) {
      const stmt = SQL.add(c).replace('?', `'${c.comment}'`) + ';';
      expect(rec).toContain(stmt);
    }
    expect(rec).toContain(SQL.statusComment.replace('?', `'${STATUS_COMMENT}'`) + ';');
  });
  test('the rollback drops the three columns and restores the bare status definition', () => {
    for (const c of COLUMNS) expect(rec).toContain(`-- ALTER TABLE \`hook_executions\` DROP COLUMN \`${c.name}\`, ALGORITHM=INSTANT;`);
    expect(rec).toContain(`-- ALTER TABLE \`hook_executions\` MODIFY COLUMN \`status\` ${STATUS_TYPE} NOT NULL DEFAULT 'received', ALGORITHM=INSTANT;`);
  });
  test('no comment contains a single quote (it is spliced into DDL as a bound string in the script, a literal in the record)', () => {
    for (const c of COLUMNS) expect(c.comment).not.toMatch(/'/);
    expect(STATUS_COMMENT).not.toMatch(/'/);
  });
});

// ═════════════════════════════════════════════════════════════
// 3. The engine (gated)
// ═════════════════════════════════════════════════════════════

const URL_ = process.env.YC_TEST_MYSQL_URL;
const g = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

// Line-based extraction (column COMMENTs may hold ';') of the CREATE and its
// ALTER (keys, AUTO_INCREMENT) blocks.
function schemaFor(table) {
  const lines = read('ref/database.sql').split('\n');
  const creates = []; const alters = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`CREATE TABLE \`${table}\` (`)) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
      creates.push(buf.join('\n'));
    } else if (lines[i] === `ALTER TABLE \`${table}\``) {
      const buf = [];
      for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
      const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, '')).filter((l) => !/FOREIGN KEY/.test(l));
      if (clauses.length) alters.push(`${buf[0]}\n${clauses.join(',\n')};`);
    }
  }
  if (creates.length !== 1) throw new Error(`schema extraction found ${creates.length} CREATE blocks for ${table}`);
  return { creates, alters };
}

g('the script on real MySQL', () => {
  const mysql = require('mysql2/promise');
  let conn; let other; let dbName;
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const live = async () => (await q(
    'SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, COLUMN_COMMENT AS m, ORDINAL_POSITION AS o ' +
    "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hook_executions' " +
    "AND COLUMN_NAME IN ('status','created_at','claimed_at','completed_at','attempts') ORDER BY ORDINAL_POSITION"));
  const quiet = (o = {}) => { const out = []; return { out, log: (l) => out.push(l), ...o }; };

  async function fresh() {
    await q('DROP TABLE IF EXISTS `hook_executions`');
    const { creates, alters } = schemaFor('hook_executions');
    for (const s of creates) await q(s);
    for (const s of alters) await q(s);
    await q("INSERT INTO hook_executions (hook_id, slug, raw_input, status) VALUES (23, 'rc-call', JSON_OBJECT('x', 1), 'delivered'), (22, 'rc-message-out', JSON_OBJECT('x', 2), 'filtered')");
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    dbName = u.pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (u.port === '3306') throw new Error('refusing to run against the production proxy port');
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    other = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    for (const c of [conn, other]) await c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
    const [[v]] = await conn.query('SELECT VERSION() AS v');
    if (!/^8\.4\./.test(String(v.v))) throw new Error(`the scratch server is MySQL ${v.v}; production is 8.4 — point YC_TEST_MYSQL_URL at an 8.4`);
  });
  afterAll(async () => { for (const c of [conn, other]) if (c) await c.end(); });

  test('CHECK: GO, plans three adds + the comment, writes nothing', async () => {
    await fresh();
    const o = quiet();
    const r = await run(conn, o);
    expect([r.ok, r.line]).toEqual([true, 'CHECK OK — GO. Next: node scripts/hookAsyncReceiverS0.js --apply']);
    expect(o.out.join('\n')).toMatch(/1\. ALTER TABLE `hook_executions` ADD COLUMN `claimed_at`[\s\S]*4\. ALTER TABLE `hook_executions` MODIFY COLUMN `status`/);
    expect((await live()).map((r) => r.c)).toEqual(['status', 'created_at']);
  });

  test('--apply: GO — columns the target in order, status comment set with its definition unchanged, rows intact, smoke ran; a re-run is ALREADY APPLIED', async () => {
    await fresh();
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect([r.ok, r.line]).toEqual([true, expect.stringMatching(/^APPLIED — GO\./)]);
    expect(o.out.join('\n')).toMatch(/✓ smoke: a fresh row has claimed_at NULL/);
    const rows = await live();
    expect(rows.map((r) => r.c)).toEqual(['status', 'created_at', 'claimed_at', 'completed_at', 'attempts']);
    expect(rows[0]).toMatchObject({ t: STATUS_TYPE, n: 'NO', d: 'received', m: STATUS_COMMENT });
    expect(rows[2]).toMatchObject({ t: 'datetime(3)', n: 'YES', d: null, m: COLUMNS[0].comment });
    expect(rows[3]).toMatchObject({ t: 'datetime(3)', n: 'YES', d: null, m: COLUMNS[1].comment });
    expect(rows[4]).toMatchObject({ t: 'tinyint unsigned', n: 'NO', d: '0', m: COLUMNS[2].comment });
    expect(await q('SELECT id, slug, status, claimed_at, completed_at, attempts FROM hook_executions ORDER BY id')).toEqual([
      { id: 1, slug: 'rc-call', status: 'delivered', claimed_at: null, completed_at: null, attempts: 0 },
      { id: 2, slug: 'rc-message-out', status: 'filtered', claimed_at: null, completed_at: null, attempts: 0 },
    ]);
    // the smoke row did not persist
    expect((await q("SELECT COUNT(*) AS n FROM hook_executions WHERE slug = 'hookS0-smoke'"))[0].n).toBe(0);
    const o2 = quiet({ apply: true });
    const again = await run(conn, o2);
    expect([again.ok, again.line]).toEqual([true, expect.stringMatching(/^ALREADY APPLIED — GO\. .*verified and smoke-tested again/)]);
    expect(o2.out.join('\n')).toMatch(/✓ verified:[\s\S]*✓ smoke: a fresh row has claimed_at NULL/);
    // CHECK on the applied state stays read-only: no smoke row, no smoke line
    const o3 = quiet();
    const chk = await run(conn, o3);
    expect([chk.ok, chk.line]).toEqual([true, expect.stringMatching(/^ALREADY APPLIED — GO\. The three columns and the status comment are in place; nothing to do/)]);
    expect(o3.out.join('\n')).not.toMatch(/smoke/);
  });

  test('rerun under --apply after the DDL landed but the end state is wrong (a column dropped by hand): NO-GO, nothing changed', async () => {
    await fresh();
    expect((await run(conn, quiet({ apply: true }))).ok).toBe(true);
    await q('ALTER TABLE `hook_executions` MODIFY COLUMN `attempts` INT NOT NULL DEFAULT 0');
    const r = await run(conn, quiet({ apply: true }));
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — 1 problem\(s\) above\. Nothing was changed\./);
    expect((await live()).find((x) => x.c === 'attempts').t).toBe('int');
  });

  test('half applied (claimed_at added by a stopped run): --apply resumes with the rest only', async () => {
    await fresh();
    const c = COLUMNS[0];
    await q(SQL.add(c), [c.comment]);
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect(r.ok).toBe(true);
    expect(r.done).toEqual(['add completed_at', 'add attempts', 'statusComment']);
    expect((await live()).map((r) => r.c)).toEqual(['status', 'created_at', 'claimed_at', 'completed_at', 'attempts']);
  });

  test('a hand-added column of another shape: NO-GO, nothing changed', async () => {
    await fresh();
    await q('ALTER TABLE `hook_executions` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0');
    const r = await run(conn, quiet({ apply: true }));
    expect([r.ok, r.line]).toEqual([false, expect.stringMatching(/^NO-GO — 1 problem\(s\) above\. Nothing was changed\./)]);
    expect((await live()).map((r) => r.c)).toEqual(['status', 'created_at', 'attempts']);
    expect((await live())[0].m).toBe('');
  });

  test('a metadata lock held by another session: the ALTER gives up in ~2 s with nothing changed, and a re-run resumes', async () => {
    await fresh();
    await other.query('START TRANSACTION');
    await other.query('SELECT * FROM hook_executions WHERE id = 1 FOR UPDATE'); // holds a shared MDL on the table
    const t0 = Date.now();
    const r = await run(conn, quiet({ apply: true }));
    const took = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — stopped before any change\. Re-running/);
    expect(took).toBeGreaterThanOrEqual(1500);
    expect(took).toBeLessThan(20000);
    expect((await live()).map((r) => r.c)).toEqual(['status', 'created_at']);
    await other.query('ROLLBACK');
    const r2 = await run(conn, quiet({ apply: true }));
    expect(r2.ok).toBe(true);
  }, 40000);

  test('the claim primitive: two sessions race for one received row — exactly one wins', async () => {
    await fresh();
    expect((await run(conn, quiet({ apply: true }))).ok).toBe(true);
    await q("INSERT INTO hook_executions (id, hook_id, slug, raw_input, status) VALUES (50, 23, 'rc-call', JSON_OBJECT('x', 3), 'received')");
    const claim = "UPDATE hook_executions SET claimed_at = NOW(3), attempts = attempts + 1 WHERE id = 50 AND status = 'received' AND claimed_at IS NULL";
    const [[a], [b]] = await Promise.all([conn.query(claim), other.query(claim)]);
    expect([a.affectedRows, b.affectedRows].sort()).toEqual([0, 1]);
    const [row] = await q('SELECT attempts, claimed_at IS NOT NULL AS claimed FROM hook_executions WHERE id = 50');
    expect(row).toEqual({ attempts: 1, claimed: 1 });
  });
});
