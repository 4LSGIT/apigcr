#!/usr/bin/env node
// scripts/settingsArcMigrate.js
//
/**
 * Settings / config-split arc — the schema and data half. TWO STAGES, around
 * the backend deploy. The applied SQL and its ROLLBACK are recorded in
 * ref/migrations/2026-10-18_settings_arc.sql (a test holds the two identical).
 *
 * STAGE 1 — BEFORE the backend deploy (SQL first, the house order):
 *   1. CREATE TABLE app_settings_versions — the settings history. The arc's
 *      routes/api.appSettings.js writes a row in the same transaction as
 *      every value change; deployed first, every settings save fails (500,
 *      rolled back — closed, nothing half-written) until the table exists.
 *      The old backend never names it.
 *   2. app_settings column COMMENTs — is_editable, category, label,
 *      description, type, sort_order now describe UNREGISTERED rows only
 *      (registered keys take theirs from lib/settingsRegistry.js); is_editable's
 *      'exposed in settings.html' is false after this arc. `key` gains the
 *      collation landmine: a lookup ignores case and trailing spaces while the
 *      registry is exact (review F1, 2026-10-18). ONE ALTER, column
 *      definitions restated exactly, ALGORITHM=INSTANT (metadata only — MySQL
 *      refuses INSTANT for anything that would rebuild, so a restated
 *      definition that differed cannot slip through). is_secret's comment
 *      stays: it is still true.
 *   3. app_settings table COMMENT — its own ALTER, ALGORITHM=INPLACE, LOCK=NONE:
 *      8.4 refuses INSTANT for a table comment (error 1845, measured for
 *      scripts/uiCustomConfigKeyComment.js). Metadata only.
 *   4. pabbly_internal_url is_secret = 1 — the registry already calls it a
 *      secret (a webhook URL with a key in its query string); the row flag now
 *      agrees, so a settings API that only checked the flag would not serve it
 *      either. Its VALUE is never read, printed or recorded here: every query
 *      that touches the row selects key / is_secret only.
 *   5. DELETE the two leftover test rows gate_probe ('hello') and
 *      fe-gate_probe ('hello2') — exactly those values, or NO-GO.
 *   And a NO-GO, before anything is written, when a retired flag (stage 2)
 *   no longer holds its final value: the arc's code behaves as that value, so
 *   deploying it would change behaviour. Stage 1 is the last stop before the
 *   deploy; stage 2's own check comes after it.
 *
 * STAGE 2 — AFTER the deploy (--stage2): the two rollout flags retire at their
 * final value (Fred, 2026-10-17); the arc's code no longer reads them.
 *   DELETE unified_singleton_enabled (exactly '1') and esign_webhook_hmac_mode
 *   (exactly 'enforce'). Anything else is a NO-GO naming what was found.
 *   Deleted BEFORE the new backend is live, the OLD code would read a missing
 *   row as "off" / its default — so stage 2 proves the deploy first: this
 *   checkout no longer reads either flag (READERS below), and the live build
 *   (GET /api/version `mtime`, the newest file time in the deployed image —
 *   when Cloud Build checked the source out) is newer than the newest commit
 *   touching this script or those readers. That proves a build checked out
 *   after the arc's commits, which is "deployed" unless one sat unpushed while
 *   another build ran.
 *
 * USAGE (repo root; .env reaches production — the setup `npm run db:ref` uses;
 * the Cloud SQL proxy starts if .env opts in):
 *   node scripts/settingsArcMigrate.js                    # stage 1 CHECK — read-only
 *   node scripts/settingsArcMigrate.js --apply            # stage 1
 *     … land + deploy the settings arc backend …
 *   node scripts/settingsArcMigrate.js --stage2           # stage 2 CHECK — read-only
 *   node scripts/settingsArcMigrate.js --stage2 --apply   # stage 2
 *
 * ONE connection (CLAUDE.md: a migration that needs a session). --apply sets
 * lock_wait_timeout = 5 before any ALTER (the global default is a year; a
 * metadata lock queued behind a long transaction would stall every query on
 * the table), re-reads and re-asserts the live state on that session, then
 * does only what is left — every run is RESUMABLE. The row changes run in one
 * transaction, each asserting it hit exactly one row. Verified after: the end
 * state, every other app_settings column unchanged, the row count, and the
 * route's version INSERT in a ROLLED-BACK transaction. Every run ends on ONE
 * GO / NO-GO line naming the next command.
 */
'use strict';

const VERSIONS = 'app_settings_versions';
const PABBLY = 'pabbly_internal_url';

/** The two test rows stage 1 deletes, with the exact values they hold. */
const TEST_ROWS = Object.freeze([['gate_probe', 'hello'], ['fe-gate_probe', 'hello2']]);
/** The two retired flags stage 2 deletes, with their final values. */
const FLAGS = Object.freeze([['unified_singleton_enabled', '1'], ['esign_webhook_hmac_mode', 'enforce']]);

const sqlStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

// ── app_settings: `key` and the six metadata columns, exactly as live
// (ref/database.sql, 2026-10-17; `key` 2026-10-18) — asserted before the ALTER
// restates them.
const GCI = { CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_general_ci' };
const NOCS = { CHARACTER_SET_NAME: null, COLLATION_NAME: null };
const COLUMNS = Object.freeze({
  key: { pos: 1, COLUMN_TYPE: 'varchar(100)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, ...GCI, EXTRA: '',
    ddl: 'varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL',
    old: '',
    new: "The setting's name; the primary key. utf8mb4_general_ci PAD SPACE: a lookup ignores case and trailing spaces (WHERE `key` = 'Firm_Name ' reads the firm_name row), and two keys that differ only so cannot coexist. lib/settingsRegistry.js matches keys exactly, so code that judges a key by name compares the row's own key with it byte for byte (routes/api.appSettings.js, set_setting / get_setting)." },
  is_editable: { pos: 4, COLUMN_TYPE: 'tinyint(1)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0', ...NOCS, EXTRA: '',
    ddl: "tinyint(1) NOT NULL DEFAULT '0'",
    old: 'exposed in settings.html',
    new: 'UNREGISTERED rows only (keys not in lib/settingsRegistry.js, the automation variables): 1 = listed and editable in YisraCase Config, Firm tab, Automation variables; 0 = served by no settings API. Ignored for a registered key: its edit posture comes from the registry.' },
  category: { pos: 5, COLUMN_TYPE: 'varchar(50)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ...GCI, EXTRA: '',
    ddl: 'varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL',
    old: '',
    new: 'UNREGISTERED rows only: the grouping shown with an automation variable. A registered key takes its section from lib/settingsRegistry.js; this column is ignored for it.' },
  label: { pos: 6, COLUMN_TYPE: 'varchar(100)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ...GCI, EXTRA: '',
    ddl: 'varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL',
    old: '',
    new: 'UNREGISTERED rows only: display label (blank = the key). Registered keys take theirs from lib/settingsRegistry.js.' },
  description: { pos: 7, COLUMN_TYPE: 'varchar(500)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ...GCI, EXTRA: '',
    ddl: 'varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL',
    old: '',
    new: 'UNREGISTERED rows only: the operator hint. Registered keys take theirs from lib/settingsRegistry.js.' },
  type: { pos: 8, COLUMN_TYPE: 'varchar(20)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ...GCI, EXTRA: '',
    ddl: 'varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL',
    old: '',
    new: 'UNREGISTERED rows only: the validator type (string, template, number, bool, email, csv, phone, url, json, json_array, date; anything else is stored verbatim). A registered key validates by its lib/settingsRegistry.js type.' },
  sort_order: { pos: 9, COLUMN_TYPE: 'int', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ...NOCS, EXTRA: '',
    ddl: 'int NULL DEFAULT NULL',
    old: '',
    new: 'UNREGISTERED rows only: the order among the automation variables. Registered keys take theirs from lib/settingsRegistry.js.' },
});
const DEF_FIELDS = ['COLUMN_TYPE', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'EXTRA'];

const OLD_TABLE_COMMENT = '';
const NEW_TABLE_COMMENT =
  'Key / value settings. lib/settingsRegistry.js owns every key the code reads (kind, editor home, type, label, edit ' +
  'posture); for those rows only key, value, is_secret and updated_at carry meaning. The metadata columns describe ' +
  'UNREGISTERED rows: the automation variables created in YisraCase Config, Firm tab. Value history: app_settings_versions.';

// ── app_settings_versions: the shape routes/api.appSettings.js writes.
const V_TABLE_COMMENT =
  'Change history of app_settings values: one row per value change made through routes/api.appSettings.js (PUT, POST ' +
  'create, restore), written in the same transaction as the change; none when a save left the value unchanged. Never ' +
  'holds a secret: those routes never write one. Writes made elsewhere (automation set_setting / update_db, runtime ' +
  'state, key rotation, the SU db console) are not recorded.';
const V_COLUMNS = Object.freeze([
  // [name, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME, comment, ddl]
  ['id', 'int unsigned', 'NO', null, 'auto_increment', null, '', 'int unsigned NOT NULL AUTO_INCREMENT'],
  ['setting_key', 'varchar(100)', 'NO', null, '', 'utf8mb4_general_ci',
    'app_settings.key the change was to (no foreign key: the history outlives a deleted row)',
    'varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL'],
  ['old_value', 'text', 'YES', null, '', 'utf8mb4_general_ci',
    'The value before this change; NULL = there was no row (a create, or the first write of a registered key) or it held NULL. Restore puts this back (NULL as an empty string).',
    'text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL'],
  ['new_value', 'text', 'YES', null, '', 'utf8mb4_general_ci',
    'The value this change stored.',
    'text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL'],
  ['changed_by', 'tinyint', 'YES', null, '', null,
    'users.user of the staff JWT that made the change; NULL = a machine key (x-api-key)',
    'tinyint NULL'],
  ['changed_via', 'varchar(16)', 'NO', null, '', 'utf8mb4_general_ci',
    'ui (staff PUT) | api_key (machine PUT) | create (POST) | restore. App-validated.',
    'varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL'],
  ['changed_at', 'timestamp', 'NO', 'CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', null,
    'When the change was made.',
    'timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP'],
]);
const V_INDEX = 'idx_app_settings_versions_key';

const SQL = {
  who:        '/* settingsArc:who */ SELECT CURRENT_USER() AS cu, DATABASE() AS db, VERSION() AS v',
  columns:    '/* settingsArc:columns */ SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, ' +
              'CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS ' +
              'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
  table:      '/* settingsArc:table */ SELECT TABLE_TYPE, ENGINE, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES ' +
              'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
  indexes:    '/* settingsArc:indexes */ SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS ' +
              'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
  rows:       '/* settingsArc:rows */ SELECT COUNT(*) AS n FROM `app_settings`',
  // key / is_secret ONLY — the value of this row is never read.
  pabbly:     '/* settingsArc:pabbly */ SELECT `key`, `is_secret` FROM `app_settings` WHERE `key` = ' + sqlStr(PABBLY),
  // A row flagged secret comes back with its value NULLed by MySQL.
  probe:      (keys) => '/* settingsArc:probe */ SELECT `key`, IF(`is_secret` = 0, `value`, NULL) AS `value`, `is_secret`, ' +
              '`is_editable`, `category`, `label`, `description`, `type`, `sort_order` FROM `app_settings` WHERE `key` IN (' +
              keys.map(sqlStr).join(', ') + ') ORDER BY `key`',
  lockWait:   'SET SESSION lock_wait_timeout = 5',
  createVersions:
    'CREATE TABLE `app_settings_versions` (\n' +
    V_COLUMNS.map(([n, , , , , , comment, ddl]) => `  \`${n}\` ${ddl}${comment ? ` COMMENT ${sqlStr(comment)}` : ''},\n`).join('') +
    '  PRIMARY KEY (`id`),\n' +
    `  KEY \`${V_INDEX}\` (\`setting_key\`, \`id\`)\n` +
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT=${sqlStr(V_TABLE_COMMENT)}`,
  alterColumns: (names) => 'ALTER TABLE `app_settings`\n' +
    names.map((n) => `  MODIFY COLUMN \`${n}\` ${COLUMNS[n].ddl} COMMENT ${sqlStr(COLUMNS[n].new)},\n`).join('') +
    '  ALGORITHM=INSTANT',
  alterTable: `ALTER TABLE \`app_settings\` COMMENT = ${sqlStr(NEW_TABLE_COMMENT)}, ALGORITHM=INPLACE, LOCK=NONE`,
  markPabbly: 'UPDATE `app_settings` SET `is_secret` = 1 WHERE `key` = ' + sqlStr(PABBLY) + ' AND `is_secret` = 0',
  // utf8mb4_bin: the value must match byte for byte (the column's general_ci would match 'HELLO').
  del:        (key, value) => `DELETE FROM \`app_settings\` WHERE \`key\` = ${sqlStr(key)} AND \`value\` COLLATE utf8mb4_bin = ${sqlStr(value)} AND \`is_secret\` = 0`,
  smokeIns:   '/* settingsArc:smoke */ INSERT INTO app_settings_versions (setting_key, old_value, new_value, changed_by, changed_via) ' +
              "VALUES ('__settings_arc_smoke__', NULL, 'x', NULL, 'ui')",
  smokeSel:   "/* settingsArc:smoke */ SELECT setting_key, old_value, new_value, changed_by, changed_via, changed_at FROM app_settings_versions WHERE setting_key = '__settings_arc_smoke__'",
};
const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS = 120_000;

async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

const ALL_KEYS = TEST_ROWS.map(([k]) => k);
const FLAG_KEYS = FLAGS.map(([k]) => k);

/** The live state, read on `conn`. */
async function readState(conn) {
  const [who] = await q(conn, SQL.who);
  const plain = (rows) => rows.map((r) => ({ ...r }));
  const [table] = await q(conn, SQL.table, ['app_settings']);
  const columns = plain(await q(conn, SQL.columns, ['app_settings']));
  const [vTable] = await q(conn, SQL.table, [VERSIONS]);
  const vColumns = vTable ? plain(await q(conn, SQL.columns, [VERSIONS])) : [];
  const vIndexes = vTable ? plain(await q(conn, SQL.indexes, [VERSIONS])) : [];
  const [rows] = await q(conn, SQL.rows);
  const pabbly = plain(await q(conn, SQL.pabbly));
  const probes = plain(await q(conn, SQL.probe([...ALL_KEYS, ...FLAG_KEYS])));
  return { user: who.cu, db: who.db, version: who.v, table: table ? { ...table } : null, columns,
    vTable: vTable ? { ...vTable } : null, vColumns, vIndexes, rows: Number(rows.n), pabbly, probes };
}

const show = (v) => (v == null ? String(v) : JSON.stringify(String(v).length > 80 ? String(v).slice(0, 80) + '…' : v));

/** The versions table's live shape → problems ([] = exactly ours). */
function versionsShapeProblems(s) {
  const out = [];
  const t = s.vTable;
  if (t.TABLE_TYPE !== 'BASE TABLE' || t.ENGINE !== 'InnoDB' || t.TABLE_COLLATION !== 'utf8mb4_general_ci') {
    out.push(`${VERSIONS} is ${t.TABLE_TYPE} / ${t.ENGINE} / ${t.TABLE_COLLATION}, expected BASE TABLE / InnoDB / utf8mb4_general_ci`);
  }
  if (t.TABLE_COMMENT !== V_TABLE_COMMENT) out.push(`${VERSIONS} table comment is not this migration's`);
  const got = s.vColumns.map((c) => [c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, c.EXTRA, c.COLLATION_NAME, c.COLUMN_COMMENT]);
  const want = V_COLUMNS.map((c) => c.slice(0, 7));
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${VERSIONS} columns are not this migration's: ${JSON.stringify(got)}`);
  const idx = {};
  for (const r of s.vIndexes) (idx[r.INDEX_NAME] = idx[r.INDEX_NAME] || []).push([r.COLUMN_NAME, Number(r.NON_UNIQUE)]);
  const wantIdx = { PRIMARY: [['id', 0]], [V_INDEX]: [['setting_key', 1], ['id', 1]] };
  // by index name, whatever order the server lists them in (key-order-insensitive)
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  if (canon(idx) !== canon(wantIdx)) out.push(`${VERSIONS} indexes are not this migration's: ${JSON.stringify(idx)}`);
  return out;
}

/** Stage 1: live state → { problems, todo } (pure). */
function plan(s) {
  const problems = [];
  const todo = { versions: false, comments: [], tableComment: false, pabbly: false, deletes: [] };

  if (!s.table || s.table.TABLE_TYPE !== 'BASE TABLE') problems.push('app_settings is not a base table here');
  const by = Object.fromEntries(s.columns.map((c) => [c.COLUMN_NAME, c]));
  for (const [name, e] of Object.entries(COLUMNS)) {
    const c = by[name];
    if (!c) { problems.push(`app_settings.${name} is missing`); continue; }
    const diff = DEF_FIELDS.filter((k) => (c[k] ?? null) !== e[k]).map((k) => `${k} ${JSON.stringify(c[k])}, expected ${JSON.stringify(e[k])}`);
    if (Number(c.ORDINAL_POSITION) !== e.pos) diff.push(`position ${c.ORDINAL_POSITION}, expected ${e.pos}`);
    if (diff.length) { problems.push(`app_settings.${name}: ${diff.join('; ')} — the MODIFY would change it; NOT touching it`); continue; }
    const cm = c.COLUMN_COMMENT || '';
    if (cm === e.new) continue;
    if (cm === e.old) todo.comments.push(name);
    else problems.push(`app_settings.${name} comment is ${show(cm)} — neither the old text nor this migration's`);
  }
  if (s.table) {
    const tc = s.table.TABLE_COMMENT || '';
    if (tc === OLD_TABLE_COMMENT) todo.tableComment = true;
    else if (tc !== NEW_TABLE_COMMENT) problems.push(`app_settings table comment is ${show(tc)} — neither the old text nor this migration's`);
  }

  if (!s.vTable) todo.versions = true;
  else problems.push(...versionsShapeProblems(s).map((x) => x + ' — not touching it'));

  if (s.pabbly.length !== 1) problems.push(`${PABBLY}: ${s.pabbly.length} rows, expected 1 — find out where it went`);
  else if (Number(s.pabbly[0].is_secret) === 0) todo.pabbly = true;
  else if (Number(s.pabbly[0].is_secret) !== 1) problems.push(`${PABBLY}.is_secret is ${show(s.pabbly[0].is_secret)}, expected 0 or 1`);

  for (const [key, want] of TEST_ROWS) {
    const r = s.probes.find((x) => x.key === key);
    if (!r) continue;                                        // already gone
    if (Number(r.is_secret) !== 0) problems.push(`test row ${key} is flagged secret — not reading it; leave it to a person`);
    else if (r.value !== want) problems.push(`test row ${key} holds ${show(r.value)}, expected ${JSON.stringify(want)} — someone uses it; not deleting`);
    else todo.deletes.push(key);
  }
  return { problems, todo };
}

/**
 * Stage 1's refusal on the retired flags (none when they are gone — a re-run
 * after stage 2): the arc's code behaves as their final values.
 */
function flagProblems(s) {
  return planFlags(s.probes).problems.map((x) => `${x} — the arc's code behaves as the final value, so deploying it now would change behaviour`);
}

function describe(todo) {
  const out = [];
  if (todo.versions) out.push(`CREATE TABLE ${VERSIONS}`);
  if (todo.comments.length) out.push(`app_settings column COMMENTs (INSTANT): ${todo.comments.join(', ')}`);
  if (todo.tableComment) out.push('app_settings table COMMENT (INPLACE, LOCK=NONE)');
  if (todo.pabbly) out.push(`${PABBLY}: is_secret = 1`);
  if (todo.deletes.length) out.push(`DELETE test rows: ${todo.deletes.join(', ')}`);
  return out;
}

/** A column's whole definition, for the before / after comparison. */
const defOf = (c) => JSON.stringify([c.COLUMN_NAME, Number(c.ORDINAL_POSITION), c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
  c.CHARACTER_SET_NAME, c.COLLATION_NAME, c.EXTRA]);

/** The route's version INSERT on the live table, rolled back → problems. */
async function smoke(conn) {
  const out = [];
  await conn.beginTransaction();
  try {
    await q(conn, SQL.smokeIns);
    const rows = await q(conn, SQL.smokeSel);
    const r = rows[0];
    if (rows.length !== 1 || r.old_value !== null || r.new_value !== 'x' || r.changed_by !== null || r.changed_via !== 'ui' || !r.changed_at) {
      out.push(`the route's version INSERT reads back as ${JSON.stringify(rows)}`);
    }
  } finally {
    await conn.rollback();
  }
  return out;
}

const NEXT_DEPLOY = 'Next: land + deploy the settings arc backend, then node scripts/settingsArcMigrate.js --stage2';

/** Stage 1. run(conn, { apply, log }) → { ok, state, line }. */
async function run(conn, { apply = false, log = console.log } = {}) {
  log(`\n=== settings arc — stage 1 (before the deploy) — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);
  let s = await readState(conn);
  log(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}; app_settings: ${s.rows} rows`);
  let p = plan(s);
  p.problems.push(...flagProblems(s));
  const end = (ok, state, line) => { log('\n' + line); return { ok, state, line }; };
  p.problems.forEach((x) => log('  ✗ ' + x));
  describe(p.todo).forEach((x) => log('  · to do: ' + x));
  if (p.problems.length) return end(false, 'blocked', `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`);
  if (!describe(p.todo).length) return end(true, 'applied', `ALREADY APPLIED — GO. Nothing to do. ${NEXT_DEPLOY}`);
  if (!apply) return end(true, 'check', 'CHECK OK — GO. Next: node scripts/settingsArcMigrate.js --apply');

  await q(conn, SQL.lockWait);
  const before = await readState(conn);          // re-read on the session that will ALTER
  p = plan(before);
  p.problems.push(...flagProblems(before));
  if (p.problems.length) {
    p.problems.forEach((x) => log('  ✗ ' + x));
    return end(false, 'changed', 'NO-GO — the state changed between CHECK and apply. Nothing was changed by this run; run CHECK again.');
  }

  const done = [];
  try {
    if (p.todo.versions) { await q(conn, SQL.createVersions, [], DDL_TIMEOUT_MS); done.push(`${VERSIONS} created`); log(`  ✓ ${VERSIONS} created`); }
    if (p.todo.comments.length) {
      await q(conn, SQL.alterColumns(p.todo.comments), [], DDL_TIMEOUT_MS);
      done.push('column comments');
      log(`  ✓ app_settings column COMMENTs: ${p.todo.comments.join(', ')} (INSTANT)`);
    }
    if (p.todo.tableComment) { await q(conn, SQL.alterTable, [], DDL_TIMEOUT_MS); done.push('table comment'); log('  ✓ app_settings table COMMENT (INPLACE, LOCK=NONE)'); }
    if (p.todo.pabbly || p.todo.deletes.length) {
      for (const key of p.todo.deletes) {
        const r = before.probes.find((x) => x.key === key);
        log(`  record — deleting ${key}: ${JSON.stringify(r)}`);
      }
      await conn.beginTransaction();
      try {
        const one = async (sql, what) => {
          const res = await q(conn, sql);
          if (!res || res.affectedRows !== 1) throw Object.assign(new Error(`${what} matched ${res && res.affectedRows} rows, expected 1 — rolled back`), { code: 'ROWS' });
        };
        if (p.todo.pabbly) await one(SQL.markPabbly, `${PABBLY} is_secret = 1`);
        for (const key of p.todo.deletes) await one(SQL.del(key, TEST_ROWS.find(([k]) => k === key)[1]), `DELETE ${key}`);
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
      if (p.todo.pabbly) { done.push(`${PABBLY} secret`); log(`  ✓ ${PABBLY}: is_secret = 1 (value not read)`); }
      if (p.todo.deletes.length) { done.push('test rows deleted'); log(`  ✓ deleted ${p.todo.deletes.join(', ')}`); }
    }
  } catch (err) {
    return end(false, 'stopped', `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'} ` +
      `(${err.code || ''} ${err.message}). Re-running --apply resumes from the live state. Do NOT deploy until it says GO.`);
  }

  const after = await readState(conn);
  const p2 = plan(after);
  const issues = [...p2.problems, ...describe(p2.todo).map((x) => `still to do: ${x}`)];
  const want = before.columns.map(defOf);
  const got = after.columns.map(defOf);
  if (JSON.stringify(want) !== JSON.stringify(got)) issues.push('app_settings columns do not read back exactly as before (definition or order)');
  for (const c of after.columns) {
    const b = before.columns.find((x) => x.COLUMN_NAME === c.COLUMN_NAME);
    if (b && !COLUMNS[c.COLUMN_NAME] && (b.COLUMN_COMMENT || '') !== (c.COLUMN_COMMENT || '')) issues.push(`app_settings.${c.COLUMN_NAME} comment changed (not in this migration)`);
  }
  if (after.rows !== before.rows - p.todo.deletes.length) issues.push(`app_settings went from ${before.rows} to ${after.rows} rows, expected ${before.rows - p.todo.deletes.length}`);
  if (!issues.length) issues.push(...await smoke(conn));
  if (issues.length) {
    issues.forEach((x) => log('  ✗ ' + x));
    return end(false, 'verify-failed', 'NO-GO — the end state does not verify. Paste this output; do NOT deploy. ' +
      'The rollback is in ref/migrations/2026-10-18_settings_arc.sql.');
  }
  log(`  ✓ verified: ${VERSIONS} as specified, the comments, ${PABBLY} secret, the test rows gone; every other column ` +
    `unchanged; ${after.rows} rows; the route's version INSERT works (rolled back)`);
  return end(true, 'applied-now', `STAGE 1 APPLIED — GO. ${NEXT_DEPLOY}`);
}

// ─────────────────────────────────────────────────────────────
// Stage 2 — after the deploy
// ─────────────────────────────────────────────────────────────

/** Stage 2: the flag rows → { problems, todo: [keys] } (pure). */
function planFlags(rows) {
  const problems = [];
  const todo = [];
  for (const [key, want] of FLAGS) {
    const r = rows.find((x) => x.key === key);
    if (!r) continue;                                        // already gone
    if (Number(r.is_secret) !== 0) problems.push(`${key} is flagged secret — not reading it; leave it to a person`);
    else if (r.value !== want) problems.push(`${key} holds ${show(r.value)}, not its final value ${JSON.stringify(want)} — Fred's ruling retired it at ${JSON.stringify(want)}; find out who changed it`);
    else todo.push(key);
  }
  return { problems, todo };
}

/** Stage 2. runStage2(conn, { apply, log, live }) → { ok, state, line }. live: async () => { ok, detail }. */
async function runStage2(conn, { apply = false, log = console.log, live } = {}) {
  if (typeof live !== 'function') throw new Error('runStage2(): a live-build check is required');
  log(`\n=== settings arc — stage 2 (after the deploy) — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);
  const end = (ok, state, line) => { log('\n' + line); return { ok, state, line }; };
  const s1 = plan(await readState(conn));
  if (s1.problems.length || describe(s1.todo).length) {
    [...s1.problems, ...describe(s1.todo).map((x) => `stage 1 still to do: ${x}`)].forEach((x) => log('  ✗ ' + x));
    return end(false, 'stage1', 'NO-GO — stage 1 is not complete. Next: node scripts/settingsArcMigrate.js');
  }
  const rows = (await q(conn, SQL.probe(FLAG_KEYS))).map((r) => ({ ...r }));
  const p = planFlags(rows);
  for (const [key] of FLAGS) {
    const r = rows.find((x) => x.key === key);
    log(`${key}: ${r ? (Number(r.is_secret) ? 'present (flagged secret)' : `present, ${show(r.value)}`) : 'gone'}`);
  }
  p.problems.forEach((x) => log('  ✗ ' + x));
  if (p.problems.length) return end(false, 'blocked', `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`);
  if (!p.todo.length) return end(true, 'applied', 'ALREADY APPLIED — GO. Nothing to do; the settings arc migration is complete.');

  const L = await live();
  log(`live backend: ${L.detail}`);
  if (!L.ok) return end(false, 'blocked', 'NO-GO — the backend that no longer reads the flags is not confirmed live (above). Nothing was changed.');
  if (!apply) return end(true, 'check', 'CHECK OK — GO. Next: node scripts/settingsArcMigrate.js --stage2 --apply');

  for (const key of p.todo) log(`  record — deleting ${key}: ${JSON.stringify(rows.find((x) => x.key === key))}`);
  await conn.beginTransaction();
  try {
    for (const key of p.todo) {
      const res = await q(conn, SQL.del(key, FLAGS.find(([k]) => k === key)[1]));
      if (!res || res.affectedRows !== 1) throw new Error(`DELETE ${key} matched ${res && res.affectedRows} rows, expected 1`);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    return end(false, 'stopped', `NO-GO — ${err.message}; rolled back, nothing was changed. Run --stage2 again.`);
  }
  const left = await q(conn, SQL.probe(FLAG_KEYS));
  if (left.length) return end(false, 'verify-failed', `NO-GO — still present after the DELETE: ${left.map((r) => r.key).join(', ')}. Paste this output.`);
  log(`  ✓ deleted ${p.todo.join(', ')}`);
  return end(true, 'applied-now', 'STAGE 2 APPLIED — GO. The settings arc migration is complete.');
}

/**
 * Files that read the retired flags before this arc. Stage 2 refuses while this
 * checkout still names either flag as a quoted string in any of them.
 */
const READERS = Object.freeze(['lib/firmConfig.js', 'services/apptService.js', 'services/eventService.js', 'services/esignWebhookService.js']);
const FLAG_LITERAL_RE = /(['"])(unified_singleton_enabled|esign_webhook_hmac_mode)\1/;

/**
 * The CLI's live-build check for stage 2. root: the repo root; fetchImpl /
 * gitTime / readFile injectable for tests. → { ok, detail }. Every external
 * call is time-limited.
 */
async function liveCheck({ root, url, fetchImpl = fetch, gitTime, readFile } = {}) {
  const fs = require('fs');
  const path = require('path');
  const read = readFile || ((rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const rel of READERS) {
    const m = FLAG_LITERAL_RE.exec(read(rel));
    if (m) return { ok: false, detail: `this checkout's ${rel} still names ${m[2]} — run from an up-to-date main` };
  }
  const committed = gitTime ? await gitTime() : (() => {
    const { execFileSync } = require('child_process');
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
    if (!git(['log', '-1', '--format=%ct', '--diff-filter=A', '--', 'scripts/settingsArcMigrate.js'])) return null;
    const out = git(['log', '-1', '--format=%ct', '--', 'scripts/settingsArcMigrate.js', ...READERS]);
    return out ? Number(out) * 1000 : null;
  })();
  if (!committed) return { ok: false, detail: 'this script is not committed here — run it from a checkout of main' };
  let v;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, detail: `${url} answered ${res.status}` };
    v = await res.json();
  } catch (e) {
    return { ok: false, detail: `could not read ${url} (${e && e.name === 'TimeoutError' ? 'timed out after 10 s' : e && e.message})` };
  }
  const mtime = Number(v && v.mtime);
  const at = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  if (!(mtime > committed)) {
    return { ok: false, detail: `live build ${v && v.build} is from ${Number.isFinite(mtime) ? at(mtime) : '?'}, ` +
      `older than the arc's newest commit here (${at(committed)}) — deploy main first` };
  }
  return { ok: true, detail: `build ${v.build} from ${at(mtime)}, after the arc's newest commit here (${at(committed)})` };
}

/** Stage 1 as literal SQL, in run order — what the migration record holds. */
function stage1Sql() {
  return [
    `${SQL.lockWait};`,
    `${SQL.createVersions};`,
    `${SQL.alterColumns(Object.keys(COLUMNS))};`,
    `${SQL.alterTable};`,
    'START TRANSACTION;',
    `${SQL.markPabbly};`,
    ...TEST_ROWS.map(([k, v]) => `${SQL.del(k, v)};`),
    'COMMIT;',
  ];
}
/** Stage 2 as literal SQL. */
function stage2Sql() {
  return ['START TRANSACTION;', ...FLAGS.map(([k, v]) => `${SQL.del(k, v)};`), 'COMMIT;'];
}

module.exports = {
  run, runStage2, plan, planFlags, readState, liveCheck, smoke, stage1Sql, stage2Sql, sqlStr,
  SQL, COLUMNS, V_COLUMNS, V_INDEX, V_TABLE_COMMENT, OLD_TABLE_COMMENT, NEW_TABLE_COMMENT,
  TEST_ROWS, FLAGS, READERS, FLAG_LITERAL_RE, PABBLY, VERSIONS,
};

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const argv = process.argv.slice(2);
  const bad = argv.filter((a) => a !== '--apply' && a !== '--stage2');
  if (bad.length || new Set(argv).size !== argv.length) {
    console.log(`Unknown or repeated flags: ${argv.join(' ')}\n\nNO-GO — pass nothing, --apply, --stage2 or --stage2 --apply. Nothing was changed.`);
    process.exit(1);
  }
  const apply = argv.includes('--apply');
  const stage2 = argv.includes('--stage2');
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const root = path.join(__dirname, '..');
  const url = (process.env.APP_URL || 'https://app.4lsg.com').replace(/\/+$/, '') + '/api/version';
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = stage2
        ? await runStage2(conn, { apply, live: () => liveCheck({ root, url }) })
        : await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing further was changed; re-run to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
