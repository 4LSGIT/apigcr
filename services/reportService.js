// services/reportService.js
//
// Saved reports: CRUD on report_definitions, plus guarded execution against
// the read-only pool.
//
// ── TWO POOLS, DELIBERATELY ─────────────────────────────────────────────────
// Report SQL runs on `startup/dbReadonly` (the yc_readonly MySQL user, SELECT
// grant only). Definition CRUD and run logging use the caller's normal pool
// (`db`), because the RO pool physically cannot INSERT. Never cross them: a
// report body must never touch `db`, and a write must never touch `roPool`.
//
// ── PARAMETER BINDING ───────────────────────────────────────────────────────
// A report's `params` array is an ORDERED declaration matching the `?`
// placeholders in sql_text left-to-right. Values are always bound through
// mysql2 placeholders — never interpolated — so a parameter cannot alter the
// statement's structure no matter what the user types into the UI.
//
// Relative date defaults ('-90d', 'today', 'month_start') are resolved here,
// server-side, so a saved report means the same thing every time it runs
// rather than depending on the browser's clock or timezone.
//
// ── VALIDATION RUNS TWICE ───────────────────────────────────────────────────
// On save AND on run. A manifest edit can retire a table out from under a
// report that was legal when it was saved; re-validating at run time means
// that report starts failing loudly instead of quietly reading something it
// shouldn't.
//
// ── mysql2 JSON HAZARD ──────────────────────────────────────────────────────
// params / columns_meta / viz / caveats are JSON columns. mysql2 returns them
// PARSED and requires them JSON.stringify()'d on the way back in. Every write
// site below does that explicitly.

const roPool = require("../startup/dbReadonly");
const {
  validateSql, validateParams, sanitizeViz, sanitizeColumnsMeta,
} = require("../lib/reportSchema/validator");

// Execution caps. Deliberately tighter than /api/readonly/sql: that endpoint
// serves a human debugging with a short-lived key; this one serves nine staff
// clicking buttons, and a runaway report is a shared outage.
const DEFAULT_ROW_LIMIT = 1000;
const HARD_MAX_ROWS = 10000;
const EXEC_TIMEOUT_MS = 20000;

// EXPLAIN gate: if MySQL's optimiser estimates more than this many rows
// examined, refuse before running. Catches accidental cross joins and
// unbounded scans of `log` (~50k rows) at zero cost.
const MAX_ESTIMATED_ROWS = 500000;

const REPORT_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;

// A "view" is a report whose purpose is a work LIST rather than a number:
// kind='view', viz.type='table', columns_meta may carry renderer actions.
// Same table, same validator, same pools — deliberately NOT a parallel system.
// `visibility` is stored now and ENFORCED in a later slice; today every
// definition is SU-authored and behaves as shared.
const KINDS = new Set(["report", "view"]);
const VISIBILITIES = new Set(["private", "shared"]);

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function err(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter resolution
// ─────────────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD for a Date. */
function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Resolve a relative date token to a concrete value.
 * Supported: 'today', 'yesterday', '-<n>d', '-<n>m', 'month_start',
 * 'last_month_start', 'last_month_end', 'year_start'.
 * Anything else is returned unchanged (assumed to be a literal date).
 */
function resolveDateToken(token) {
  if (typeof token !== "string") return token;
  const t = token.trim().toLowerCase();
  const now = new Date();

  if (t === "today") return ymd(now);
  if (t === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  if (t === "month_start") return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  if (t === "last_month_start") return ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (t === "last_month_end") return ymd(new Date(now.getFullYear(), now.getMonth(), 0));
  if (t === "year_start") return ymd(new Date(now.getFullYear(), 0, 1));

  let m = t.match(/^-(\d+)d$/);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() - Number(m[1]));
    return ymd(d);
  }
  m = t.match(/^-(\d+)m$/);
  if (m) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - Number(m[1]));
    return ymd(d);
  }
  return token;
}

/**
 * Build the ordered bind array from a report's param declarations and the
 * caller's supplied values.
 *
 * Date params get widened to full-day bounds so `WHERE d >= ? AND d <= ?`
 * behaves the way a user expects against DATETIME columns: a plain
 * '2026-07-28' upper bound would otherwise exclude everything after midnight
 * on the closing day. Params named end/to/until/before get 23:59:59; others
 * get 00:00:00. This is a convention, and it is documented in the UI.
 *
 * @returns {Array} values in placeholder order
 */
function buildBindValues(paramDecls, supplied = {}) {
  const decls = Array.isArray(paramDecls) ? paramDecls : [];
  const out = [];

  for (const p of decls) {
    let v = Object.prototype.hasOwnProperty.call(supplied, p.name)
      ? supplied[p.name]
      : undefined;

    if (v === undefined || v === null || v === "") {
      v = p.default !== undefined ? p.default : null;
    }

    if (v === null || v === undefined) {
      if (p.required) {
        throw err(400, `Missing required parameter "${p.name}"`);
      }
      out.push(null);
      continue;
    }

    if (p.type === "date" || p.type === "datetime") {
      let resolved = resolveDateToken(v);
      if (p.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(resolved))) {
        const isUpper = /^(end|to|until|before)$/i.test(p.name) ||
                        /(_end|_to|_until|_before)$/i.test(p.name);
        resolved = `${resolved} ${isUpper ? "23:59:59" : "00:00:00"}`;
      }
      out.push(resolved);
    } else if (p.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw err(400, `Parameter "${p.name}" must be a number`);
      out.push(n);
    } else {
      out.push(String(v));
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run logging
// ─────────────────────────────────────────────────────────────────────────────

/** Fire-and-forget insert into report_runs. Never blocks or throws. */
function logRun(db, fields) {
  const sql = `
    INSERT INTO report_runs
      (report_id, report_key, run_by, params_json, sql_text,
       row_count, duration_ms, status, error_text)
    VALUES (?,?,?,?,?,?,?,?,?)
  `;
  const params = [
    fields.report_id ?? null,
    fields.report_key ?? null,
    fields.run_by ?? null,
    fields.params_json ? JSON.stringify(fields.params_json) : null,
    fields.sql_text ? String(fields.sql_text).slice(0, 60000) : null,
    fields.row_count ?? null,
    fields.duration_ms ?? null,
    fields.status,
    fields.error_text ? String(fields.error_text).slice(0, 60000) : null,
  ];
  db.query(sql, params).catch((e) =>
    console.error("[reportService] report_runs insert failed:", e.message)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate rows examined from a classic EXPLAIN plan.
 *
 * MySQL emits one plan row per table access, tagged with a select-block `id`.
 * The cost model that matches how the server actually executes:
 *
 *   - Rows sharing an `id` are one nested-loop join → their row counts
 *     MULTIPLY. (A 991-row table hash-joined against 50k rows really is ~50M.)
 *   - Different `id`s are separate select blocks — a derived table or plain
 *     subquery is MATERIALISED ONCE and then read, so blocks SUM. Multiplying
 *     across them was the original bug: a cheap
 *     `SELECT ... FROM (SELECT ... FROM appts GROUP BY month) t` produced two
 *     ~2.8k-row plan rows and got "estimated" at 7.9M — a production false
 *     positive that cost the AI author a 15-second repair turn and would
 *     hard-block any report that genuinely needs a subquery.
 *   - The exception is DEPENDENT / UNCACHEABLE blocks, which genuinely
 *     re-execute per outer row → those multiply by the outer product.
 *
 * MySQL's `rows` figures are estimates either way; this is a safety net for
 * runaway cross joins, not an optimiser.
 *
 * @param {Array<object>} plan  rows from `EXPLAIN <sql>`
 * @returns {number}
 */
function estimateRowsExamined(plan) {
  const blocks = new Map(); // id → { product, dependent }
  for (const r of plan) {
    const id = String(r.id ?? "1");
    const n = Number(r.rows);
    const rows = Number.isFinite(n) && n > 0 ? n : 1;
    const sel = String(r.select_type || "");
    const b = blocks.get(id) || { product: 1, dependent: false };
    b.product *= rows;
    if (/DEPENDENT|UNCACHEABLE/i.test(sel)) b.dependent = true;
    blocks.set(id, b);
  }
  // The outer block drives how often dependent blocks re-run. id "1" is the
  // PRIMARY/SIMPLE block in classic EXPLAIN output.
  const outer = (blocks.get("1") || { product: 1 }).product;
  let total = 0;
  for (const [id, b] of blocks) {
    if (id !== "1" && b.dependent) total += b.product * outer;
    else total += b.product;
  }
  return total;
}

/**
 * Run a SQL statement against the read-only pool with every guard applied.
 * Used by both saved-report runs and (Slice 3) AI preview runs.
 *
 * @param {object} db          main pool — for run logging only
 * @param {object} opts
 * @param {string} opts.sql
 * @param {Array}  [opts.values]     bind values, in placeholder order
 * @param {number} [opts.rowLimit]
 * @param {number} [opts.expectedParams]
 * @param {object} [opts.logMeta]    {report_id, report_key, run_by, params_json}
 * @returns {Promise<{rows, fields, rowCount, truncated, durationMs, estimatedRows}>}
 */
async function execute(db, opts = {}) {
  const started = Date.now();
  const sql = String(opts.sql || "");
  const values = Array.isArray(opts.values) ? opts.values : [];
  const rowLimit = Math.max(1, Math.min(Number(opts.rowLimit) || DEFAULT_ROW_LIMIT, HARD_MAX_ROWS));
  const logMeta = opts.logMeta || {};

  // Re-validate at run time — a manifest edit may have retired a table since
  // this report was saved.
  const v = validateSql(sql, { expectedParams: opts.expectedParams });
  if (!v.ok) {
    logRun(db, {
      ...logMeta, sql_text: sql, duration_ms: Date.now() - started,
      status: "rejected_validation", error_text: `${v.error}${v.detail ? " — " + v.detail : ""}`,
    });
    throw err(400, v.error, v.detail);
  }

  let conn;
  try {
    conn = await roPool.getConnection();
    await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [EXEC_TIMEOUT_MS]);

    // EXPLAIN gate. Cheap, and catches the accidental cross join before it
    // becomes a shared outage. A failure to EXPLAIN is NOT fatal — some valid
    // statements don't plan usefully — so we only act on a confident estimate.
    let estimatedRows = null;
    try {
      const [plan] = await conn.query(`EXPLAIN ${sql}`, values);
      if (Array.isArray(plan) && plan.length) {
        estimatedRows = estimateRowsExamined(plan);
        if (estimatedRows > MAX_ESTIMATED_ROWS) {
          logRun(db, {
            ...logMeta, sql_text: sql, duration_ms: Date.now() - started,
            status: "rejected_too_large",
            error_text: `estimated ${estimatedRows} rows examined`,
          });
          throw err(
            400,
            "Report refused: the query plan estimates too much work",
            `Estimated ~${estimatedRows.toLocaleString()} rows examined (cap ${MAX_ESTIMATED_ROWS.toLocaleString()}). ` +
              "Add a date filter or narrow the joins."
          );
        }
      }
    } catch (planErr) {
      if (planErr.status === 400) throw planErr; // our own refusal — propagate
      // Otherwise: EXPLAIN itself failed. Fall through and let the real query
      // produce the real error message, which will be far more useful.
    }

    const [rows, fields] = await conn.query(sql, values);

    const isArray = Array.isArray(rows);
    const fullCount = isArray ? rows.length : null;
    const truncated = isArray && fullCount > rowLimit;
    const payload = isArray && truncated ? rows.slice(0, rowLimit) : rows;

    const fieldMeta = Array.isArray(fields)
      ? fields.map((f) => ({ name: f.name, type: f.columnType }))
      : null;

    logRun(db, {
      ...logMeta, sql_text: sql, row_count: fullCount,
      duration_ms: Date.now() - started, status: "success",
    });

    return {
      rows: payload,
      fields: fieldMeta,
      rowCount: fullCount,
      truncated,
      durationMs: Date.now() - started,
      estimatedRows,
    };
  } catch (e) {
    if (e.status === 400 && /refused|Report SQL|Column|Table|Parameter/.test(e.message)) {
      throw e; // already logged
    }
    logRun(db, {
      ...logMeta, sql_text: sql, duration_ms: Date.now() - started,
      status: "error", error_text: e.message,
    });
    throw err(400, e.message);
  } finally {
    if (conn) conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────────

/** mysql2 returns JSON columns parsed, but be defensive about string rows. */
function parseJsonCol(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function shapeRow(r) {
  return {
    id: r.id,
    report_key: r.report_key,
    title: r.title,
    description: r.description,
    category: r.category,
    kind: r.kind || "report",
    visibility: r.visibility || "shared",
    sql_text: r.sql_text,
    params: parseJsonCol(r.params, []),
    columns_meta: parseJsonCol(r.columns_meta, []),
    viz: parseJsonCol(r.viz, null),
    caveats: parseJsonCol(r.caveats, []),
    row_limit: r.row_limit,
    is_active: !!r.is_active,
    source: r.source,
    created_by: r.created_by,
    updated_by: r.updated_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function listReports(db, { includeInactive = false, kind = null } = {}) {
  if (kind != null && !KINDS.has(kind)) {
    throw err(400, `kind must be one of ${[...KINDS].join(", ")}`);
  }
  const where = [];
  const binds = [];
  if (!includeInactive) where.push("is_active = 1");
  if (kind != null) { where.push("kind = ?"); binds.push(kind); }
  const [rows] = await db.query(
    `SELECT id, report_key, title, description, category, kind, visibility,
            params, viz, caveats, is_active, source, created_by, updated_at
       FROM report_definitions
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY category, title`,
    binds
  );
  return rows.map((r) => ({
    id: r.id,
    report_key: r.report_key,
    title: r.title,
    description: r.description,
    category: r.category,
    kind: r.kind || "report",
    visibility: r.visibility || "shared",
    params: parseJsonCol(r.params, []),
    viz: parseJsonCol(r.viz, null),
    caveats: parseJsonCol(r.caveats, []),
    is_active: !!r.is_active,
    source: r.source,
    created_by: r.created_by,
    updated_at: r.updated_at,
  }));
}

async function getReport(db, id) {
  const [rows] = await db.query(`SELECT * FROM report_definitions WHERE id = ? LIMIT 1`, [id]);
  if (!rows.length) throw err(404, `Report ${id} not found`);
  return shapeRow(rows[0]);
}

async function createReport(db, body = {}, userId = null) {
  const {
    report_key, title, description = null, category = "General",
    sql_text, params = [], columns_meta = [], viz = null, caveats = [],
    row_limit = DEFAULT_ROW_LIMIT, source = "manual",
    kind = "report", visibility = "shared",
  } = body;

  if (!KINDS.has(kind)) throw err(400, `kind must be one of ${[...KINDS].join(", ")}`);
  if (!VISIBILITIES.has(visibility)) {
    throw err(400, `visibility must be one of ${[...VISIBILITIES].join(", ")}`);
  }

  if (!REPORT_KEY_RE.test(String(report_key || ""))) {
    throw err(400, "report_key must be lowercase letters, digits and underscores, 3–60 chars, starting with a letter");
  }
  if (!title || !String(title).trim()) throw err(400, "title is required");

  const pv = validateParams(params);
  if (!pv.ok) throw err(400, pv.error);

  const sv = validateSql(sql_text, { expectedParams: (params || []).length });
  if (!sv.ok) throw err(400, sv.error, sv.detail);

  // A bad chart or column hint is stripped, not fatal — the SQL is the
  // valuable part. Warnings ride back on the created row so the caller can
  // surface them.
  const vz = sanitizeViz(viz);
  const cm = sanitizeColumnsMeta(columns_meta);

  try {
    const [res] = await db.query(
      `INSERT INTO report_definitions
         (report_key, title, description, category, kind, visibility, sql_text,
          params, columns_meta, viz, caveats, row_limit, created_by, updated_by,
          source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        report_key, title, description, category, kind, visibility, sql_text,
        JSON.stringify(params || []),
        JSON.stringify(cm.columns_meta),
        vz.viz ? JSON.stringify(vz.viz) : null,
        JSON.stringify(caveats || []),
        Math.max(1, Math.min(Number(row_limit) || DEFAULT_ROW_LIMIT, HARD_MAX_ROWS)),
        userId, userId, source === "ai" ? "ai" : "manual",
      ]
    );
    const created = await getReport(db, res.insertId);
    if (vz.warning) created.vizWarning = vz.warning;
    if (cm.warnings.length) created.columnsMetaWarnings = cm.warnings;
    return created;
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      throw err(400, `report_key "${report_key}" already exists`);
    }
    throw e;
  }
}

async function updateReport(db, id, body = {}, userId = null) {
  const existing = await getReport(db, id);

  // report_key is immutable — it is the stable handle a saved link or a future
  // scheduled job refers to. Renaming would silently break those.
  if (body.report_key && body.report_key !== existing.report_key) {
    throw err(400, "report_key is immutable once created");
  }

  const next = {
    title: body.title ?? existing.title,
    description: body.description !== undefined ? body.description : existing.description,
    category: body.category ?? existing.category,
    kind: body.kind ?? existing.kind ?? "report",
    visibility: body.visibility ?? existing.visibility ?? "shared",
    sql_text: body.sql_text ?? existing.sql_text,
    params: body.params ?? existing.params,
    columns_meta: body.columns_meta ?? existing.columns_meta,
    viz: body.viz !== undefined ? body.viz : existing.viz,
    caveats: body.caveats ?? existing.caveats,
    row_limit: body.row_limit ?? existing.row_limit,
    is_active: body.is_active !== undefined ? (body.is_active ? 1 : 0) : (existing.is_active ? 1 : 0),
  };

  if (!KINDS.has(next.kind)) throw err(400, `kind must be one of ${[...KINDS].join(", ")}`);
  if (!VISIBILITIES.has(next.visibility)) {
    throw err(400, `visibility must be one of ${[...VISIBILITIES].join(", ")}`);
  }

  const pv = validateParams(next.params);
  if (!pv.ok) throw err(400, pv.error);

  const sv = validateSql(next.sql_text, { expectedParams: (next.params || []).length });
  if (!sv.ok) throw err(400, sv.error, sv.detail);

  const vz = sanitizeViz(next.viz);
  const cm = sanitizeColumnsMeta(next.columns_meta);

  await db.query(
    `UPDATE report_definitions
        SET title = ?, description = ?, category = ?, kind = ?, visibility = ?,
            sql_text = ?, params = ?, columns_meta = ?, viz = ?, caveats = ?,
            row_limit = ?, is_active = ?, updated_by = ?
      WHERE id = ?`,
    [
      next.title, next.description, next.category, next.kind, next.visibility,
      next.sql_text,
      JSON.stringify(next.params || []),
      JSON.stringify(cm.columns_meta),
      vz.viz ? JSON.stringify(vz.viz) : null,
      JSON.stringify(next.caveats || []),
      Math.max(1, Math.min(Number(next.row_limit) || DEFAULT_ROW_LIMIT, HARD_MAX_ROWS)),
      next.is_active, userId, id,
    ]
  );
  const updated = await getReport(db, id);
  if (vz.warning) updated.vizWarning = vz.warning;
  if (cm.warnings.length) updated.columnsMetaWarnings = cm.warnings;
  return updated;
}

async function deleteReport(db, id) {
  const [res] = await db.query(`DELETE FROM report_definitions WHERE id = ?`, [id]);
  if (!res.affectedRows) throw err(404, `Report ${id} not found`);
  return { deleted: true, id: Number(id) };
}

/**
 * Run a saved report.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} suppliedParams  { paramName: value }
 * @param {number|null} userId
 */
async function runReport(db, id, suppliedParams = {}, userId = null) {
  const report = await getReport(db, id);
  if (!report.is_active) throw err(400, `Report "${report.report_key}" is inactive`);

  const values = buildBindValues(report.params, suppliedParams);

  const result = await execute(db, {
    sql: report.sql_text,
    values,
    rowLimit: report.row_limit,
    expectedParams: (report.params || []).length,
    logMeta: {
      report_id: report.id,
      report_key: report.report_key,
      run_by: userId,
      params_json: suppliedParams,
    },
  });

  return {
    report: {
      id: report.id,
      report_key: report.report_key,
      title: report.title,
      description: report.description,
      kind: report.kind,
      columns_meta: report.columns_meta,
      viz: report.viz,
      caveats: report.caveats,
      params: report.params,
    },
    boundValues: values,
    ...result,
  };
}

/** Recent run history, newest first. */
async function listRuns(db, { reportId = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 500));
  const [rows] = reportId
    ? await db.query(
        `SELECT id, report_id, report_key, run_by, row_count, duration_ms,
                status, error_text, created_at
           FROM report_runs WHERE report_id = ?
          ORDER BY created_at DESC LIMIT ?`,
        [reportId, lim]
      )
    : await db.query(
        `SELECT id, report_id, report_key, run_by, row_count, duration_ms,
                status, error_text, created_at
           FROM report_runs ORDER BY created_at DESC LIMIT ?`,
        [lim]
      );
  return rows;
}

module.exports = {
  listReports,
  getReport,
  createReport,
  updateReport,
  deleteReport,
  runReport,
  listRuns,
  execute,
  buildBindValues,
  resolveDateToken,
  DEFAULT_ROW_LIMIT,
  HARD_MAX_ROWS,
};