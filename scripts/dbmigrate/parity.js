#!/usr/bin/env node
// scripts/dbmigrate/parity.js
//
// Proves a migrated copy of the YisraCase database matches its source before
// any traffic is pointed at it. Compares two live MySQL servers (source, e.g.
// SiteGround; destination, e.g. Cloud SQL through the Auth Proxy) and exits
// non-zero on any difference that matters.
//
//   SRC_PW=… DST_PW=… node scripts/dbmigrate/parity.js \
//     --src mysql://USER@HOST:3306/DB --dst mysql://USER@127.0.0.1:3307/DB \
//     [--strict] [--checksum] [--expect-definer 'user@host'] [--json]
//
// Passwords come from SRC_PW / DST_PW only. A URL that carries one is refused:
// it would sit in shell history and `ps`.
//
// TWO MODES
//   default (rehearsal)  The source is LIVE, so its data has moved on since the
//                        dump. Structure must match exactly; row-count,
//                        AUTO_INCREMENT and checksum differences are reported
//                        as DRIFT and do not fail the run.
//   --strict (cutover)   The source is write-frozen. Everything must match
//                        exactly, data included. Any DRIFT is a failure.
//
// WHAT IS COMPARED
//   settings   server variables the app's behavior depends on (sql_mode, …)
//              plus an informational list, incl. innodb_buffer_pool_size
//   database   schema default charset / collation (new tables inherit it)
//   structure  lib/schemaDump.schemaSections — the same rows the repo's schema
//              fingerprint hashes — compared section by section, so a mismatch
//              names the table/column instead of two different hashes
//   triggers   per-trigger saved sql_mode (not part of the fingerprint) and the
//              DEFINER accounts on the destination
//   objects    routines / events / views visible on each side
//   rows       exact COUNT(*) of every table
//   autoinc    AUTO_INCREMENT high-water mark of every table
//   content    an order-independent hash of every row of every table
//              (--checksum; reads every row on both sides). This is the only
//              check that sees an in-place UPDATE, which leaves counts intact.
//
// WHY NOT `CHECKSUM TABLE`
//   It hashes the stored bytes, and a JSON value's stored bytes are not stable
//   across a text dump: a document last touched by an in-place JSON_SET, or
//   one holding a DECIMAL/temporal scalar built by a SQL function, is re-encoded
//   on reload (same text, different binary). Measured on the live DB
//   2026-10-11: 55 values in 11 tables (users, hooks, scheduled_jobs,
//   workflow_steps, …) differ this way and ZERO differ as text — so CHECKSUM
//   TABLE would cry wolf on 11 tables at cutover. contentHashSql() hashes each
//   JSON column through the same text round trip the dump performs instead.
//
// Every check ASSERTS. Nothing here prints an anomaly and carries on — in
// rehearsal mode drift is counted, named, and summarized, and --strict turns
// that same count into the exit code.
//
// Exit codes: 0 = parity (or rehearsal with only data drift), 1 = a check
// failed, 2 = could not run (bad arguments, connection error).

"use strict";

const crypto = require("crypto");

// ── pure helpers (unit-tested in tests/dbmigrateParity.test.js) ──────────────

/**
 * Parse mysql://user@host[:port]/database. Throws on anything else, and on a
 * URL that embeds a password.
 */
function parseTarget(url, label = "target") {
  let u;
  try { u = new URL(String(url)); } catch (_) {
    throw new Error(`${label}: not a URL — expected mysql://USER@HOST[:PORT]/DATABASE`);
  }
  if (u.protocol !== "mysql:") throw new Error(`${label}: scheme must be mysql://`);
  if (u.password) {
    throw new Error(`${label}: do not put the password in the URL — use the ${label === "--src" ? "SRC_PW" : "DST_PW"} environment variable`);
  }
  const user = decodeURIComponent(u.username || "");
  const database = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
  if (!user) throw new Error(`${label}: missing user`);
  if (!u.hostname) throw new Error(`${label}: missing host`);
  if (!database || database.includes("/")) throw new Error(`${label}: missing database name`);
  return { host: u.hostname, port: u.port ? Number(u.port) : 3306, user, database };
}

/** Stable identity + content strings for one information_schema row. */
function rowKey(row, keyCols) {
  return keyCols.map((c) => String(row[c])).join(" / ");
}
function rowBody(row) {
  return JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v));
}

/**
 * Compare two row sets keyed by `keyCols`. Returns
 * { equal, onlySrc: [key], onlyDst: [key], changed: [{key, fields: [{col, src, dst}]}] }.
 * Order-insensitive: rows are matched by key, not position.
 */
function diffRows(srcRows, dstRows, keyCols) {
  const index = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(rowKey(r, keyCols), r);
    return m;
  };
  const s = index(srcRows);
  const d = index(dstRows);
  const onlySrc = [];
  const onlyDst = [];
  const changed = [];
  for (const [k, sr] of s) {
    if (!d.has(k)) { onlySrc.push(k); continue; }
    const dr = d.get(k);
    if (rowBody(sr) === rowBody(dr)) continue;
    const fields = [];
    for (const col of new Set([...Object.keys(sr), ...Object.keys(dr)])) {
      const a = sr[col];
      const b = dr[col];
      const as = Buffer.isBuffer(a) ? a.toString("utf8") : a;
      const bs = Buffer.isBuffer(b) ? b.toString("utf8") : b;
      if (JSON.stringify(as) !== JSON.stringify(bs)) fields.push({ col, src: as, dst: bs });
    }
    changed.push({ key: k, fields });
  }
  for (const k of d.keys()) if (!s.has(k)) onlyDst.push(k);
  return {
    equal: onlySrc.length === 0 && onlyDst.length === 0 && changed.length === 0,
    onlySrc, onlyDst, changed,
  };
}

/**
 * One line describing how a field differs, sized for a terminal.
 *
 * Two cases get special treatment because the 2026-10-12 rehearsal printed
 * thirteen whole trigger bodies, twice each, for a difference nobody could
 * see in them:
 *   - LINE ENDINGS ONLY. Triggers written in phpMyAdmin carry CRLF; the mysql
 *     command-line client turns CRLF into LF in every statement it sends
 *     unless it runs with --binary-mode. Same behavior, different bytes — and
 *     still a difference (the copy must be exact), so it is named, with the
 *     fix, instead of dumped.
 *   - LONG TEXT. Shows a window around the first differing character rather
 *     than both values whole.
 */
const LONG_FIELD = 160;
function fieldDiffText(src, dst) {
  if (typeof src === "string" && typeof dst === "string" && src !== dst) {
    const lf = (t) => t.replace(/\r\n?/g, "\n");
    if (lf(src) === lf(dst)) {
      const crs = (t) => (t.match(/\r/g) || []).length;
      return `differs ONLY in line endings (CR characters: source ${crs(src)}, dest ${crs(dst)}). ` +
        "Text applied through the mysql client loses its CRs unless the client runs with --binary-mode — re-apply it that way.";
    }
    if (src.length > LONG_FIELD || dst.length > LONG_FIELD) {
      const n = Math.min(src.length, dst.length);
      let i = 0;
      while (i < n && src[i] === dst[i]) i++;
      const from = Math.max(0, i - 40);
      const win = (t) => JSON.stringify(t.slice(from, i + 60));
      return `first difference at character ${i} (lengths ${src.length} / ${dst.length}): ` +
        `source …${win(src)}… | dest …${win(dst)}…`;
    }
  }
  return `source ${JSON.stringify(src)} | dest ${JSON.stringify(dst)}`;
}

/**
 * Compare two {name: value} maps (row counts, auto-increments, checksums).
 * Returns { equal, differing: [{name, src, dst}], onlySrc, onlyDst }.
 */
function diffMaps(src, dst) {
  const differing = [];
  const onlySrc = [];
  const onlyDst = [];
  for (const name of Object.keys(src)) {
    if (!(name in dst)) { onlySrc.push(name); continue; }
    if (String(src[name]) !== String(dst[name])) differing.push({ name, src: src[name], dst: dst[name] });
  }
  for (const name of Object.keys(dst)) if (!(name in src)) onlyDst.push(name);
  return {
    equal: differing.length === 0 && onlySrc.length === 0 && onlyDst.length === 0,
    differing, onlySrc, onlyDst,
  };
}

/**
 * Checks are recorded as { name, status, detail[] } with status one of:
 *   PASS   matched
 *   FAIL   a hard mismatch — always fails the run
 *   DRIFT  a data difference — tolerated in rehearsal, a failure under --strict
 *   INFO   reported for the operator, never affects the exit code
 */
function exitCodeFor(checks, { strict = false } = {}) {
  if (checks.some((c) => c.status === "FAIL")) return 1;
  if (strict && checks.some((c) => c.status === "DRIFT")) return 1;
  return 0;
}

/**
 * One SELECT returning (t, n) for every table: a UNION ALL of exact counts.
 * Built from table names read out of information_schema; backticks in a name
 * are doubled so a hostile or merely odd table name cannot break out.
 */
function countSql(tables) {
  if (!tables.length) return null;
  return tables
    .map((t) => {
      const id = "`" + String(t).replace(/`/g, "``") + "`";
      const lit = "'" + String(t).replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
      return `SELECT ${lit} AS t, COUNT(*) AS n FROM ${id}`;
    })
    .join(" UNION ALL ");
}

/**
 * One SELECT returning (n, s, x) for a table: row count plus two
 * order-independent aggregates (SUM and BIT_XOR) of a per-row CRC.
 *
 * `columns` is [{ name, dataType, extra }] in ordinal order. VIRTUAL/STORED
 * generated columns are skipped (derived from the rest). Each column is hashed on its own and the
 * per-column CRCs are joined, so no row is ever concatenated into one string —
 * a 16 MB mail body cannot trip max_allowed_packet and silently hash as NULL.
 * NULL hashes as the marker 'N', which no CRC32 (an integer) can equal.
 *
 * JSON columns go through CAST(… AS CHAR) → CAST(… AS JSON) → CAST(… AS CHAR):
 * exactly the text round trip a mysqldump/reload performs, so the two sides are
 * compared in the one form both are guaranteed to share.
 */
function contentHashSql(table, columns) {
  const q = (name) => "`" + String(name).replace(/`/g, "``") + "`";
  // EXTRA is 'VIRTUAL GENERATED' / 'STORED GENERATED' for generated columns —
  // but 'DEFAULT_GENERATED' for an ordinary column with an expression default
  // (every `created_at … DEFAULT CURRENT_TIMESTAMP`, and cases.custom). Match
  // the first two only: a bare /GENERATED/ silently drops real data columns
  // from the hash, which is how this was caught (a changed cases.custom passed).
  const base = columns.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(String(c.extra || "")));
  if (!base.length) return `SELECT COUNT(*) AS n, 0 AS s, 0 AS x FROM ${q(table)}`;
  const parts = base.map((c) => {
    const col = q(c.name);
    const val = String(c.dataType).toLowerCase() === "json"
      ? `CAST(CAST(CAST(${col} AS CHAR) AS JSON) AS CHAR)`
      : col;
    return `IFNULL(CRC32(${val}), 'N')`;
  });
  return `SELECT COUNT(*) AS n, COALESCE(SUM(h), 0) AS s, COALESCE(BIT_XOR(h), 0) AS x ` +
         `FROM (SELECT CRC32(CONCAT_WS('|', ${parts.join(", ")})) AS h FROM ${q(table)}) AS r`;
}

function sectionHash(rows) {
  const payload = JSON.stringify(rows, (_k, v) => (Buffer.isBuffer(v) ? v.toString("utf8") : v));
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// Which columns identify a row within each schemaSections() section.
const SECTION_KEYS = {
  tables:   ["TABLE_NAME"],
  columns:  ["TABLE_NAME", "COLUMN_NAME"],
  indexes:  ["TABLE_NAME", "INDEX_NAME", "SEQ_IN_INDEX"],
  fks:      ["TABLE_NAME", "CONSTRAINT_NAME", "ORDINAL_POSITION"],
  checks:   ["CONSTRAINT_NAME"],
  triggers: ["EVENT_OBJECT_TABLE", "TRIGGER_NAME"],
  views:    ["TABLE_NAME"],
};

// Server settings. HARD = the app's behavior depends on it; a difference fails
// the run. Everything else is printed side by side for the operator.
//
// innodb_strict_mode is deliberately informational: the source runs it OFF and
// MySQL's default is ON. It only affects DDL (oversized rows error instead of
// warn), which is the stricter and safer behavior for new migrations.
const HARD_SETTINGS = [
  ["sql_mode",                     "@@GLOBAL.sql_mode"],
  ["lower_case_table_names",       "@@GLOBAL.lower_case_table_names"],
  ["character_set_server",         "@@GLOBAL.character_set_server"],
  ["collation_server",             "@@GLOBAL.collation_server"],
  ["transaction_isolation",        "@@GLOBAL.transaction_isolation"],
  ["explicit_defaults_for_timestamp", "@@GLOBAL.explicit_defaults_for_timestamp"],
  ["innodb_ft_min_token_size",     "@@GLOBAL.innodb_ft_min_token_size"],
  // A fresh session's clock offset from UTC — the app assumes a UTC server.
  ["utc_offset",                   "CAST(TIMEDIFF(NOW(), UTC_TIMESTAMP()) AS CHAR)"],
  // Named time zones loaded? The after_contact_update trigger calls CONVERT_TZ
  // with a zone NAME; with empty tz tables that returns NULL and the trigger's
  // log row gets a NULL date.
  ["named_time_zones",             "CAST(CONVERT_TZ('2026-01-15 12:00:00','UTC','America/New_York') AS CHAR)"],
];
const INFO_SETTINGS = [
  ["version",                      "VERSION()"],
  ["innodb_buffer_pool_size_mb",   "ROUND(@@GLOBAL.innodb_buffer_pool_size / 1048576)"],
  ["max_connections",              "@@GLOBAL.max_connections"],
  ["wait_timeout",                 "@@GLOBAL.wait_timeout"],
  ["max_allowed_packet",           "@@GLOBAL.max_allowed_packet"],
  ["group_concat_max_len",         "@@GLOBAL.group_concat_max_len"],
  ["innodb_strict_mode",           "@@GLOBAL.innodb_strict_mode"],
  ["innodb_lock_wait_timeout",     "@@GLOBAL.innodb_lock_wait_timeout"],
  ["log_bin",                      "@@GLOBAL.log_bin"],
];

// ── the run ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { strict: false, checksum: false, json: false, expectDefiner: null, src: null, dst: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") out.strict = true;
    else if (a === "--checksum") out.checksum = true;
    else if (a === "--json") out.json = true;
    else if (a === "--src") out.src = argv[++i];
    else if (a === "--dst") out.dst = argv[++i];
    else if (a === "--expect-definer") out.expectDefiner = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.src || !out.dst) throw new Error("both --src and --dst are required");
  return out;
}

async function settingsOf(conn, list) {
  const sql = "SELECT " + list.map(([name, expr]) => `${expr} AS \`${name}\``).join(", ");
  const [[row]] = await conn.query(sql);
  const out = {};
  // CAST everything to text so a number on one side and a string on the other
  // (driver typing differs by column type) cannot read as a difference.
  for (const [name] of list) out[name] = row[name] == null ? null : String(row[name]);
  return out;
}

async function tableList(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`);
  return rows.map((r) => r.t);
}

async function rowCounts(conn, tables) {
  const sql = countSql(tables);
  const out = {};
  if (!sql) return out;
  const [rows] = await conn.query(sql);
  for (const r of rows) out[r.t] = String(r.n);
  return out;
}

async function autoIncs(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS t, AUTO_INCREMENT AS a FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND AUTO_INCREMENT IS NOT NULL
      ORDER BY TABLE_NAME`);
  const out = {};
  for (const r of rows) out[r.t] = String(r.a);
  return out;
}

// Columns of every base table, grouped by table, in ordinal order.
async function columnMap(conn) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, DATA_TYPE AS dataType, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const out = {};
  for (const r of rows) (out[r.t] = out[r.t] || []).push({ name: r.name, dataType: r.dataType, extra: r.extra });
  return out;
}

// Content hash of every table in `tables`, using the SOURCE's column list on
// both sides (the structure checks have already said whether they agree).
async function contentHashes(conn, tables, cols) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await conn.query(contentHashSql(t, cols[t] || []));
    out[t] = `${r.n}:${r.s}:${r.x}`;
  }
  return out;
}

async function run(opts, { mysql = require("mysql2"), log = console.log } = {}) {
  const { schemaSections } = require("../../lib/schemaDump");
  const src = parseTarget(opts.src, "--src");
  const dst = parseTarget(opts.dst, "--dst");

  const open = async (t, password, label) => {
    const conn = mysql.createConnection({
      ...t, password, timezone: "Z", connectTimeout: 20_000,
      // Counts and checksums of big tables come back as strings, never as
      // precision-losing JS numbers.
      supportBigNumbers: true, bigNumberStrings: true,
    }).promise();
    try {
      await conn.query("SELECT 1");
      // information_schema caches table statistics (AUTO_INCREMENT included)
      // for information_schema_stats_expiry seconds — 86400 on the source.
      // 0 makes this session read them fresh.
      await conn.query("SET SESSION information_schema_stats_expiry = 0");
      // TIMESTAMP columns render in the session zone; pin it so the content
      // hash reads the same instants as the same text on both sides.
      await conn.query("SET SESSION time_zone = '+00:00'");
    } catch (err) {
      err.message = `${label} (${t.user}@${t.host}:${t.port}/${t.database}): ${err.message}`;
      throw err;
    }
    return conn;
  };

  const s = await open(src, process.env.SRC_PW || "", "source");
  let d;
  try { d = await open(dst, process.env.DST_PW || "", "destination"); }
  catch (err) { await s.end().catch(() => {}); throw err; }

  const checks = [];
  const add = (name, status, detail = []) => checks.push({ name, status, detail });
  const cap = (arr, n = 12) => (arr.length > n ? [...arr.slice(0, n), `… ${arr.length - n} more`] : arr);

  try {
    // ── settings ──────────────────────────────────────────────────────────
    const [hs, hd] = [await settingsOf(s, HARD_SETTINGS), await settingsOf(d, HARD_SETTINGS)];
    for (const [name] of HARD_SETTINGS) {
      const ok = hs[name] === hd[name] && !(name === "named_time_zones" && hd[name] == null);
      add(`setting ${name}`, ok ? "PASS" : "FAIL", ok ? [] : [`source: ${hs[name]}`, `dest:   ${hd[name]}`]);
    }
    const [is, id] = [await settingsOf(s, INFO_SETTINGS), await settingsOf(d, INFO_SETTINGS)];
    add("settings (informational)", "INFO",
      INFO_SETTINGS.map(([name]) => `${name}: source ${is[name]} | dest ${id[name]}`));

    // ── database defaults ─────────────────────────────────────────────────
    const dbDefaults = async (c) => (await c.query(
      `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co
         FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()`))[0][0];
    const [ds, dd] = [await dbDefaults(s), await dbDefaults(d)];
    {
      const ok = ds.cs === dd.cs && ds.co === dd.co;
      add("database default charset/collation", ok ? "PASS" : "FAIL",
        ok ? [`${ds.cs} / ${ds.co}`] : [`source: ${ds.cs} / ${ds.co}`, `dest:   ${dd.cs} / ${dd.co}`,
          "new tables created without an explicit COLLATE would inherit the wrong one"]);
    }

    // ── structure ─────────────────────────────────────────────────────────
    const [ss, sd] = [await schemaSections(s), await schemaSections(d)];
    for (const section of Object.keys(SECTION_KEYS)) {
      const a = ss[section] || [];
      const b = sd[section] || [];
      if (sectionHash(a) === sectionHash(b)) {
        add(`structure: ${section}`, "PASS", [`${a.length} rows`]);
        continue;
      }
      const diff = diffRows(a, b, SECTION_KEYS[section]);
      const detail = [];
      for (const k of cap(diff.onlySrc)) detail.push(`missing on dest: ${k}`);
      for (const k of cap(diff.onlyDst)) detail.push(`extra on dest:   ${k}`);
      for (const c of cap(diff.changed)) {
        if (typeof c === "string") { detail.push(c); continue; }
        for (const f of c.fields) {
          detail.push(`${c.key} · ${f.col}: ${fieldDiffText(f.src, f.dst)}`);
        }
      }
      // Hashes differ but the keyed diff is empty → only row ORDER differs,
      // which is not a structural difference.
      add(`structure: ${section}`, diff.equal ? "PASS" : "FAIL",
        diff.equal ? [`${a.length} rows (order differs only)`] : detail);
    }

    // ── triggers: saved sql_mode + definers ───────────────────────────────
    const trigEnv = async (c) => (await c.query(
      `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, SQL_MODE, DEFINER
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
        ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`))[0];
    const [ts, td] = [await trigEnv(s), await trigEnv(d)];
    {
      const strip = (rows) => rows.map(({ TRIGGER_NAME, EVENT_OBJECT_TABLE, SQL_MODE }) =>
        ({ TRIGGER_NAME, EVENT_OBJECT_TABLE, SQL_MODE }));
      const diff = diffRows(strip(ts), strip(td), ["EVENT_OBJECT_TABLE", "TRIGGER_NAME"]);
      const detail = [];
      for (const k of diff.onlySrc) detail.push(`missing on dest: ${k}`);
      for (const k of diff.onlyDst) detail.push(`extra on dest:   ${k}`);
      for (const c of diff.changed) for (const f of c.fields) detail.push(`${c.key} · ${f.col}: source ${f.src} | dest ${f.dst}`);
      add("triggers: saved sql_mode", diff.equal ? "PASS" : "FAIL", diff.equal ? [`${ts.length} triggers`] : detail);

      const definers = [...new Set(td.map((r) => r.DEFINER))].sort();
      if (opts.expectDefiner) {
        const bad = td.filter((r) => r.DEFINER !== opts.expectDefiner);
        add("triggers: definer on dest", bad.length ? "FAIL" : "PASS",
          bad.length
            ? bad.map((r) => `${r.EVENT_OBJECT_TABLE} / ${r.TRIGGER_NAME}: ${r.DEFINER} (expected ${opts.expectDefiner})`)
            : [`all ${td.length} owned by ${opts.expectDefiner}`]);
      } else {
        add("triggers: definer on dest", "INFO", definers.length ? definers.map((x) => `dest definer: ${x}`) : ["no triggers"]);
      }
      // Seeing 0 triggers on the source while the dest has some means this
      // source account cannot see them — say so rather than report "extra".
      if (ts.length === 0 && td.length > 0) {
        add("triggers: source visibility", "FAIL",
          [`source account sees 0 triggers, dest has ${td.length} — connect to the source as an account with the TRIGGER privilege`]);
      }
    }

    // ── routines / events ─────────────────────────────────────────────────
    const objCounts = async (c) => (await c.query(
      `SELECT (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()) AS routines,
              (SELECT COUNT(*) FROM information_schema.EVENTS   WHERE EVENT_SCHEMA   = DATABASE()) AS events`))[0][0];
    const [os, od] = [await objCounts(s), await objCounts(d)];
    {
      const ok = String(os.routines) === String(od.routines) && String(os.events) === String(od.events);
      add("routines / events (as visible)", ok ? "PASS" : "FAIL",
        [`source: ${os.routines} routines, ${os.events} events`, `dest:   ${od.routines} routines, ${od.events} events`]);
    }

    // ── rows ──────────────────────────────────────────────────────────────
    const [tls, tld] = [await tableList(s), await tableList(d)];
    const common = tls.filter((t) => tld.includes(t));
    const [cs, cd] = [await rowCounts(s, common), await rowCounts(d, common)];
    {
      const diff = diffMaps(cs, cd);
      const total = (m) => Object.values(m).reduce((a, n) => a + BigInt(n), 0n).toString();
      add("row counts", diff.equal ? "PASS" : "DRIFT",
        diff.equal
          ? [`${common.length} tables, ${total(cs)} rows`]
          : [`${diff.differing.length} of ${common.length} tables differ (source ${total(cs)} rows, dest ${total(cd)})`,
             ...cap(diff.differing.map((x) => `${x.name}: source ${x.src} | dest ${x.dst} (${BigInt(x.dst) - BigInt(x.src) >= 0n ? "+" : ""}${BigInt(x.dst) - BigInt(x.src)})`), 40)]);
    }

    // ── auto-increment ────────────────────────────────────────────────────
    {
      const diff = diffMaps(await autoIncs(s), await autoIncs(d));
      add("auto_increment high-water marks", diff.equal ? "PASS" : "DRIFT",
        diff.equal ? [] : cap([
          ...diff.differing.map((x) => `${x.name}: source ${x.src} | dest ${x.dst}`),
          ...diff.onlySrc.map((n) => `${n}: on source only`),
          ...diff.onlyDst.map((n) => `${n}: on dest only`),
        ], 40));
    }

    // ── content ───────────────────────────────────────────────────────────
    if (opts.checksum) {
      const cols = await columnMap(s);
      const [hsrc, hdst] = await Promise.all([contentHashes(s, common, cols), contentHashes(d, common, cols)]);
      const diff = diffMaps(hsrc, hdst);
      add("table content hashes", diff.equal ? "PASS" : "DRIFT",
        diff.equal
          ? [`${common.length} tables`]
          : [`${diff.differing.length} of ${common.length} tables differ  (rows:sum:xor)`,
             ...cap(diff.differing.map((x) => `${x.name}: source ${x.src} | dest ${x.dst}`), 40)]);
    } else {
      add("table content hashes", "INFO", ["skipped (pass --checksum to read every row on both sides)"]);
    }
  } finally {
    await Promise.allSettled([s.end(), d.end()]);
  }

  const code = exitCodeFor(checks, opts);

  if (opts.json) {
    log(JSON.stringify({ mode: opts.strict ? "strict" : "rehearsal", exit: code, checks }, null, 2));
    return code;
  }

  const mark = { PASS: "PASS ", FAIL: "FAIL ", DRIFT: "DRIFT", INFO: "info " };
  log(`parity: ${src.user}@${src.host}:${src.port}/${src.database}  →  ${dst.user}@${dst.host}:${dst.port}/${dst.database}`);
  log(`mode:   ${opts.strict ? "STRICT (cutover — data must match exactly)" : "rehearsal (structure must match; data drift tolerated)"}`);
  log("");
  for (const c of checks) {
    log(`[${mark[c.status]}] ${c.name}`);
    if (c.status !== "PASS" || c.name.startsWith("row counts") || c.name.startsWith("database")) {
      for (const line of c.detail) log(`          ${line}`);
    }
  }
  const n = (st) => checks.filter((c) => c.status === st).length;
  log("");
  log(`${n("PASS")} passed, ${n("FAIL")} failed, ${n("DRIFT")} drifted.`);
  if (code === 0 && n("DRIFT") > 0) {
    log("REHEARSAL RESULT: structure matches. Data drift above is expected while the source is live;");
    log("re-run with --strict after the write freeze — drift is a failure there.");
  } else if (code === 0) {
    log("RESULT: PARITY.");
  } else {
    log("RESULT: NOT IN PARITY — do not cut over.");
  }
  return code;
}

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`parity: ${err.message}\nusage: SRC_PW=… DST_PW=… node scripts/dbmigrate/parity.js --src mysql://USER@HOST[:PORT]/DB --dst mysql://USER@HOST[:PORT]/DB [--strict] [--checksum] [--expect-definer 'user@host'] [--json]`); process.exit(2); }
  run(opts).then(
    (code) => process.exit(code),
    (err) => { console.error(`parity: could not run — ${err.message}`); process.exit(2); }
  );
}

module.exports = {
  parseTarget, diffRows, diffMaps, fieldDiffText, exitCodeFor, countSql, contentHashSql, sectionHash, parseArgs,
  SECTION_KEYS, HARD_SETTINGS, INFO_SETTINGS, run,
};
