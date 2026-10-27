// tests/hookDedupS3.test.js
//
/**
 * Async hook receiver S3 — scripts/hookDedupS3.js and its record,
 * ref/migrations/2026-10-27_hook_dedup_key.sql.
 *
 *   1. THE PLAN (always runs, no database). Every live state — fresh, half
 *      applied, done — maps to the right remaining steps, and every unsafe
 *      state (a column of another shape, a foreign index of the same name,
 *      rows already carrying a key before the unique key exists, a seeded
 *      hook renamed or already configured by hand, a trigger, a schema object
 *      naming the new names) is a NO-GO before any write.
 *   2. THE RECORD names exactly what the script runs.
 *   3. THE ENGINE (gated). The script against MySQL 8.4 clones of hooks and
 *      hook_executions (cut from ref/database.sql) holding the five seeded
 *      hooks and some executions: CHECK writes nothing; --apply adds the two
 *      columns (INSTANT), builds the unique key online, seeds the five paths,
 *      verifies and smoke-tests; a re-run is ALREADY APPLIED; a half-applied
 *      state resumes; a hand-set dedup_path is a NO-GO with nothing changed;
 *      the unique key refuses a duplicate and admits NULLs; a metadata lock
 *      held elsewhere times out in ~2 s with nothing changed.
 *
 * ── PART 3 IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ───────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_hooks3_test npx jest tests/hookDedupS3.test.js --runInBand
 * The database name must end in _test; the suite DROPS and recreates hooks
 * and hook_executions in it. Never point it at port 3306 (production).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const S = require('../scripts/hookDedupS3');
const { PATH_COL, KEY_COL, COLUMNS, SEEDS, SQL, UQ, NAMES_RE, plan, run } = S;

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ═════════════════════════════════════════════════════════════
// 1. plan() — pure
// ═════════════════════════════════════════════════════════════

const target = (spec, over = {}) => ({ type: spec.type, nullable: spec.nullable, dflt: spec.dflt, comment: spec.comment, extra: '', gen: '', charset: 'utf8mb4', collation: spec.collation || 'utf8mb4_general_ci', ...over });
const TARGET_KEY = [{ seq: 1, c: 'hook_id', unique: true }, { seq: 2, c: 'dedup_key', unique: true }];
const hooks = (pathValue) => Object.fromEntries(Object.entries(SEEDS).map(([id, s]) => [id, { slug: s.slug, path: pathValue === 'target' ? s.path : pathValue }]));
function state(over = {}) {
  return {
    user: 'yc_app@%', db: 'x_test', version: '8.4.11',
    tables: { hooks: true, exec: true },
    cols: { dedup_path: null, dedup_key: null },
    key: [], execRows: 34700, keyedRows: null,
    hooks: hooks(undefined), refs: [], tableTriggers: [],
    ...over,
  };
}
const kinds = (p) => p.steps.map((st) => (st.kind === 'add' ? `add:${st.name}` : st.kind === 'seed' ? `seed:${st.id}` : st.kind));

describe('plan(): live state → remaining steps', () => {
  test('fresh: two adds, the key, then the five seeds in id order — no problems', () => {
    const p = plan(state());
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['add:dedup_path', 'add:dedup_key', 'addKey', 'seed:16', 'seed:17', 'seed:21', 'seed:22', 'seed:23']);
    expect(p.done).toBe(false);
  });

  test('half applied — columns there, key and seeds missing: only what is left; a seeded hook is skipped', () => {
    const h = hooks(null); h[21].path = 'body.uuid';
    const p = plan(state({ cols: { dedup_path: target(PATH_COL), dedup_key: target(KEY_COL) }, keyedRows: 0, hooks: h }));
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['addKey', 'seed:16', 'seed:17', 'seed:22', 'seed:23']);
  });

  test('done: everything the target → done, no steps', () => {
    const p = plan(state({ cols: { dedup_path: target(PATH_COL), dedup_key: target(KEY_COL) }, key: TARGET_KEY, keyedRows: 0, hooks: hooks('target') }));
    expect(p).toMatchObject({ problems: [], steps: [], done: true });
  });

  test('a column of another shape is a NO-GO', () => {
    const p = plan(state({ cols: { dedup_path: target(PATH_COL, { type: 'varchar(255)' }), dedup_key: null } }));
    expect(p.problems).toEqual([expect.stringMatching(/^hooks\.dedup_path already exists as varchar\(255\) NULL DEFAULT NULL — not this migration's column/)]);
    const p2 = plan(state({ cols: { dedup_path: null, dedup_key: target(KEY_COL, { comment: 'mine' }) } }));
    expect(p2.problems).toEqual([expect.stringMatching(/^hook_executions\.dedup_key already exists as .* with another comment/)]);
    // a dedup_key in the table's case-folding collation is NOT the target
    const p3 = plan(state({ cols: { dedup_path: null, dedup_key: target(KEY_COL, { collation: 'utf8mb4_general_ci' }) } }));
    expect(p3.problems).toEqual([expect.stringMatching(/^hook_executions\.dedup_key already exists as .* — not this migration's column/)]);
    expect(KEY_COL.collation).toBe('utf8mb4_bin');
    expect(KEY_COL.ddl).toContain('COLLATE utf8mb4_bin');
  });

  test('a foreign index with the key\'s name, or a non-unique one, is a NO-GO', () => {
    const cols = { dedup_path: target(PATH_COL), dedup_key: target(KEY_COL) };
    expect(plan(state({ cols, keyedRows: 0, key: [{ seq: 1, c: 'dedup_key', unique: true }] })).problems)
      .toEqual([expect.stringMatching(/already has an index named uq_hook_dedup on \[dedup_key\] — not this migration's key/)]);
    expect(plan(state({ cols, keyedRows: 0, key: TARGET_KEY.map((k) => ({ ...k, unique: false })) })).problems[0]).toMatch(/\(not unique\)/);
  });

  test('rows already carrying a key before the unique key exists are a NO-GO (who wrote them?)', () => {
    const p = plan(state({ cols: { dedup_path: target(PATH_COL), dedup_key: target(KEY_COL) }, keyedRows: 3 }));
    expect(p.problems).toEqual(['3 row(s) of hook_executions already carry a dedup_key before the unique key exists — find out who wrote them']);
  });

  test('a seeded hook that is missing, renamed, or already configured by hand is a NO-GO', () => {
    const missing = hooks(undefined); delete missing[22];
    expect(plan(state({ hooks: missing })).problems).toEqual(['hook 22 (rc-message-out) does not exist — the seed list is stale']);
    const renamed = hooks(undefined); renamed[23].slug = 'rc-telephony';
    expect(plan(state({ hooks: renamed })).problems).toEqual(['hook 23 is "rc-telephony", expected "rc-call" — the seed list is stale']);
    const hand = hooks(null); hand[16].path = 'body.data.id';
    expect(plan(state({ cols: { dedup_path: target(PATH_COL), dedup_key: null }, hooks: hand })).problems)
      .toEqual(['hook 16 (quo-message) already has dedup_path "body.data.id" — someone set it by hand; not overwriting']);
  });

  test('a trigger on either table, or a schema object naming the new names, is a NO-GO; a missing table too', () => {
    expect(plan(state({ tableTriggers: [{ name: 't', table: 'hooks' }] })).problems[0]).toMatch(/^trigger t on hooks/);
    expect(plan(state({ refs: [{ kind: 'view', name: 'v' }] })).problems[0]).toMatch(/^view v already names dedup_path/);
    expect(plan(state({ tables: { hooks: true, exec: false } })).problems).toEqual(['there is no `hook_executions` table in this database — wrong database?']);
  });

  test('NAMES_RE matches the three names as identifiers only', () => {
    expect(NAMES_RE.test('`dedup_key` IS NULL')).toBe(true);
    expect(NAMES_RE.test('uq_hook_dedup')).toBe(true);
    expect(NAMES_RE.test('dedup_keys')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. The record names exactly what the script runs
// ═════════════════════════════════════════════════════════════

describe('ref/migrations record', () => {
  const rec = read('ref/migrations/2026-10-27_hook_dedup_key.sql');
  test('both ADDs with their comments, the unique key, and the five seeds appear verbatim', () => {
    expect(rec).toContain('SET SESSION lock_wait_timeout = 2;');
    for (const c of COLUMNS) expect(rec).toContain(SQL.add(c).replace('?', `'${c.comment}'`) + ';');
    expect(rec).toContain(SQL.addKey + ';');
    for (const [id, s] of Object.entries(SEEDS)) {
      const re = new RegExp(`UPDATE \`hooks\` SET dedup_path = '${s.path.replace('.', '\\.')}',\\s+updated_at = updated_at WHERE id = ${id} AND slug = '${s.slug}'\\s+AND dedup_path IS NULL;`);
      expect(rec).toMatch(re);
    }
  });
  test('the rollback clears the seeds and drops key then columns', () => {
    expect(rec).toContain('-- UPDATE `hooks` SET dedup_path = NULL, updated_at = updated_at WHERE id IN (16, 17, 21, 22, 23);');
    expect(rec).toContain('-- ALTER TABLE `hook_executions` DROP INDEX `uq_hook_dedup`, ALGORITHM=INPLACE, LOCK=NONE;');
    expect(rec).toContain('-- ALTER TABLE `hook_executions` DROP COLUMN `dedup_key`, ALGORITHM=INSTANT;');
    expect(rec).toContain('-- ALTER TABLE `hooks` DROP COLUMN `dedup_path`, ALGORITHM=INSTANT;');
  });
  test('no comment contains a single quote', () => {
    for (const c of COLUMNS) expect(c.comment).not.toMatch(/'/);
  });
  test('the seed names id AND slug AND dedup_path IS NULL (a renumbered hook is never seeded)', () => {
    expect(SQL.seed).toContain('WHERE id = ? AND slug = ? AND dedup_path IS NULL');
    expect(SQL.seed).toContain('updated_at = updated_at');
  });
});

// ═════════════════════════════════════════════════════════════
// 3. The engine (gated)
// ═════════════════════════════════════════════════════════════

const URL_ = process.env.YC_TEST_MYSQL_URL;
const g = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['hooks', 'hook_executions'];

function schemaFor(tables) {
  const lines = read('ref/database.sql').split('\n');
  const creates = []; const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, '')).filter((l) => !/FOREIGN KEY/.test(l));
        if (clauses.length) alters.push(`${buf[0]}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  return { creates, alters };
}

g('the script on real MySQL', () => {
  const mysql = require('mysql2/promise');
  let conn; let other; let dbName;
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const cols = async () => (await q(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('hooks','hook_executions') AND COLUMN_NAME IN ('dedup_path','dedup_key') ORDER BY TABLE_NAME, COLUMN_NAME"))
    .map((r) => `${r.t}.${r.c}`);
  const keyCols = async () => (await q("SELECT COLUMN_NAME AS c, NON_UNIQUE AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hook_executions' AND INDEX_NAME = 'uq_hook_dedup' ORDER BY SEQ_IN_INDEX"));
  const paths = async () => (await q('SELECT id, dedup_path FROM hooks WHERE id IN (16,17,21,22,23) ORDER BY id')).map((r) => `${r.id}:${r.dedup_path}`);
  const quiet = (o = {}) => { const out = []; return { out, log: (l) => out.push(l), ...o }; };

  async function fresh() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const s of creates) await q(s);
    for (const s of alters) await q(s);
    // The dump may already carry S3's columns/key once production has them;
    // the clone must start WITHOUT them.
    const have = await cols();
    if (have.includes('hook_executions.dedup_key')) {
      if ((await keyCols()).length) await q('ALTER TABLE hook_executions DROP INDEX uq_hook_dedup');
      await q('ALTER TABLE hook_executions DROP COLUMN dedup_key');
    }
    if (have.includes('hooks.dedup_path')) await q('ALTER TABLE hooks DROP COLUMN dedup_path');
    await q(`INSERT INTO hooks (id, slug, name, auth_type) VALUES
      (1, 'test-passthrough', 't', 'none'), (16, 'quo-message', 'Quo msg', 'none'), (17, 'quo-call', 'Quo call', 'none'),
      (21, 'rc-message-in', 'RC in', 'api_key'), (22, 'rc-message-out', 'RC out', 'api_key'), (23, 'rc-call', 'RC call', 'api_key')`);
    await q(`INSERT INTO hook_executions (hook_id, slug, raw_input, status) VALUES (23, 'rc-call', JSON_OBJECT('x', 1), 'delivered'), (22, 'rc-message-out', JSON_OBJECT('x', 2), 'filtered'), (16, 'quo-message', JSON_OBJECT('x', 3), 'delivered')`);
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
    if (!/^8\.4\./.test(String(v.v))) throw new Error(`the scratch server is MySQL ${v.v}; production is 8.4`);
  });
  afterAll(async () => { for (const c of [conn, other]) if (c) await c.end(); });

  test('CHECK: GO, plans two adds + key + five seeds, writes nothing', async () => {
    await fresh();
    const o = quiet();
    const r = await run(conn, o);
    expect([r.ok, r.line]).toEqual([true, 'CHECK OK — GO. Next: node scripts/hookDedupS3.js --apply']);
    expect(o.out.join('\n')).toMatch(/1\. ALTER TABLE `hooks` ADD COLUMN `dedup_path`[\s\S]*3\. ALTER TABLE `hook_executions` ADD UNIQUE KEY[\s\S]*8\. UPDATE `hooks` SET dedup_path = 'body.uuid'/);
    expect(await cols()).toEqual([]);
    expect(await keyCols()).toEqual([]);
  });

  test('--apply: GO — columns, unique key and seeds the target, rows intact, smoke ran; a re-run is ALREADY APPLIED and smokes again', async () => {
    await fresh();
    const before = await q('SELECT updated_at FROM hooks WHERE id = 23');
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect([r.ok, r.line]).toEqual([true, expect.stringMatching(/^APPLIED — GO\./)]);
    expect(o.out.join('\n')).toMatch(/✓ smoke: a duplicate \(hook_id, dedup_key\) is refused with ER_DUP_ENTRY/);
    expect(await cols()).toEqual(['hook_executions.dedup_key', 'hooks.dedup_path']);
    expect(await keyCols()).toEqual([{ c: 'hook_id', nu: 0 }, { c: 'dedup_key', nu: 0 }]);
    expect(await q("SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hook_executions' AND COLUMN_NAME = 'dedup_key'")).toEqual([{ c: 'utf8mb4_bin' }]);
    expect(await paths()).toEqual(['16:body.id', '17:body.id', '21:body.uuid', '22:body.uuid', '23:body.uuid']);
    expect(await q('SELECT dedup_path FROM hooks WHERE id = 1')).toEqual([{ dedup_path: null }]);
    expect((await q('SELECT COUNT(*) AS n FROM hook_executions'))[0].n).toBe(3);
    expect((await q("SELECT COUNT(*) AS n FROM hook_executions WHERE slug = 'hookS3-smoke'"))[0].n).toBe(0);
    // the seed did not move updated_at
    expect(await q('SELECT updated_at FROM hooks WHERE id = 23')).toEqual(before);
    const again = await run(conn, quiet({ apply: true }));
    expect([again.ok, again.line]).toEqual([true, expect.stringMatching(/^ALREADY APPLIED — GO\. .*verified and smoke-tested again/)]);
  });

  test('half applied (columns added, nothing else): --apply resumes with key + seeds', async () => {
    await fresh();
    for (const c of COLUMNS) await q(SQL.add(c), [c.comment]);
    const r = await run(conn, quiet({ apply: true }));
    expect(r.ok).toBe(true);
    expect(r.done).toEqual(['addKey', 'seed 16', 'seed 17', 'seed 21', 'seed 22', 'seed 23']);
  });

  test('a dedup_path set by hand on a seeded hook: NO-GO, nothing changed', async () => {
    await fresh();
    await q(SQL.add(PATH_COL), [PATH_COL.comment]);
    await q("UPDATE hooks SET dedup_path = 'body.data.id' WHERE id = 16");
    const r = await run(conn, quiet({ apply: true }));
    expect([r.ok, r.line]).toEqual([false, expect.stringMatching(/^NO-GO — 1 problem\(s\) above\. Nothing was changed\./)]);
    expect(await cols()).toEqual(['hooks.dedup_path']);
    expect(await keyCols()).toEqual([]);
  });

  test('the unique key: a duplicate (hook_id, dedup_key) is refused, a different hook or a NULL key is not', async () => {
    await fresh();
    expect((await run(conn, quiet({ apply: true }))).ok).toBe(true);
    const ins = (hookId, key) => conn.query("INSERT INTO hook_executions (hook_id, slug, raw_input, status, dedup_key) VALUES (?, 'x', JSON_OBJECT('a', 1), 'received', ?)", [hookId, key]);
    await ins(23, 'u-1');
    await expect(ins(23, 'u-1')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await ins(22, 'u-1');                 // another hook, same provider id: fine
    await ins(23, 'U-1');                 // case differs → a DIFFERENT id (utf8mb4_bin, not the table's general_ci)
    await expect(ins(23, 'u-1 ')).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });   // utf8mb4_bin is PAD SPACE: a trailing space is not a new id
    await ins(23, null); await ins(23, null);
    expect((await q('SELECT COUNT(*) AS n FROM hook_executions WHERE slug = \'x\''))[0].n).toBe(5);
  });

  test('a metadata lock held by another session: the first ALTER gives up in ~2 s with nothing changed; a re-run resumes', async () => {
    await fresh();
    await other.query('START TRANSACTION');
    await other.query('SELECT * FROM hooks WHERE id = 16 FOR UPDATE');
    const t0 = Date.now();
    const r = await run(conn, quiet({ apply: true }));
    const took = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — stopped before any change\. Re-running/);
    expect(took).toBeGreaterThanOrEqual(1500);
    expect(took).toBeLessThan(20000);
    expect(await cols()).toEqual([]);
    await other.query('ROLLBACK');
    expect((await run(conn, quiet({ apply: true }))).ok).toBe(true);
  }, 40000);
});
