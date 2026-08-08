// lib/reportSchema/validator.js
//
// Validates a report's SQL against the curated manifest BEFORE it is saved and
// AGAIN before every run. Running the check twice is deliberate: a manifest
// edit can retire a table out from under a report that was legal when saved.
//
// ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
// This is NOT the security boundary. The boundary is the `yc_readonly` MySQL
// user, which holds SELECT and nothing else — it physically cannot write,
// regardless of any bug in this file. mysql2's multipleStatements:false is the
// second hard layer. This validator is the THIRD layer, and its real job is
// different from those two: it stops a *legal read* from returning data it
// shouldn't (SSNs, credentials) or from touching a table that will produce a
// confidently wrong answer (backup tables, stalled imports).
//
// It works by tokenising the statement rather than parsing it. A real parser
// would be better and is not worth the dependency here; the failure mode of
// tokenising is over-rejection (a legitimate query refused), which is safe and
// visible, rather than under-rejection.
//
// ── STRING AND COMMENT HANDLING ─────────────────────────────────────────────
// Identifier scanning runs over a STRIPPED copy of the SQL with string
// literals, backtick-quoted identifiers and comments blanked out. Without that,
// a report whose WHERE clause legitimately contains the text 'password' would
// be rejected, and — more importantly — a denied identifier could be smuggled
// past the scan inside what looks like a literal. Backticked identifiers are
// unwrapped and re-scanned separately so `contact_ssn` is still caught.

const {
  isAllowedTable,
  isDeniedTable,
  isDeniedColumn,
  ALLOWED_TABLES,
  DENIED_COLUMNS,
} = require("./manifest");

const { isReadOnlyQuery, hasFileExfilClause } = require("../sqlGuard");

// Statements a report may never contain, even though they read. INFORMATION_SCHEMA
// and the mysql/performance_schema catalogs would leak the full topology and let
// a report enumerate around the allowlist.
const FORBIDDEN_PATTERNS = [
  { re: /\binformation_schema\b/i, msg: "information_schema is not available to reports" },
  { re: /\bperformance_schema\b/i, msg: "performance_schema is not available to reports" },
  { re: /\bmysql\s*\./i, msg: "the mysql system database is not available to reports" },
  { re: /\bsys\s*\./i, msg: "the sys schema is not available to reports" },
  { re: /\bload_file\s*\(/i, msg: "LOAD_FILE() is not allowed" },
  { re: /\bbenchmark\s*\(/i, msg: "BENCHMARK() is not allowed" },
  { re: /\bsleep\s*\(/i, msg: "SLEEP() is not allowed" },
  { re: /\bget_lock\s*\(/i, msg: "GET_LOCK() is not allowed" },
];

// Checked against the RAW sql, before comment stripping. A /*!50000 ... */
// version-conditional comment is executed by MySQL but looks like a comment to
// any stripper, so it must be caught before `stripLiterals` blanks it out.
const RAW_FORBIDDEN_PATTERNS = [
  { re: /\/\*!/, msg: "MySQL version-conditional comments (/*! ... */) are not allowed" },
];

/**
 * Blank out string literals, backtick identifiers and comments, so identifier
 * scanning can't be fooled by (or trip over) their contents.
 *
 * Returns { stripped, backticked } — `stripped` has those regions replaced by
 * spaces of equal length (preserving offsets), `backticked` is the list of
 * identifier names that were inside backticks.
 */
function stripLiterals(sql) {
  const src = String(sql);
  let out = "";
  const backticked = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    // -- line comment  /  # line comment
    if ((ch === "-" && src[i + 1] === "-") || ch === "#") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }

    // /* block comment */
    if (ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += " "; i++; }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }

    // 'single' or "double" quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += " "; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }       // escape pair
        if (src[i] === quote && src[i + 1] === quote) { out += "  "; i += 2; continue; } // '' escape
        if (src[i] === quote) { out += " "; i++; break; }
        out += " "; i++;
      }
      continue;
    }

    // `backtick identifier` — capture the name, blank the region
    if (ch === "`") {
      let name = "";
      out += " "; i++;
      while (i < src.length && src[i] !== "`") { name += src[i]; out += " "; i++; }
      if (i < src.length) { out += " "; i++; }
      if (name) backticked.push(name);
      continue;
    }

    out += ch;
    i++;
  }

  return { stripped: out, backticked };
}

/**
 * Table names referenced after FROM / JOIN / UPDATE / INTO.
 * Only FROM and JOIN can appear in a read-only statement, but we scan for the
 * others too so a mangled statement fails loudly rather than sneaking through.
 */
function extractTableRefs(stripped) {
  const refs = new Set();
  const re = /\b(?:from|join|into|update)\s+([a-zA-Z_][a-zA-Z0-9_$]*)/gi;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    refs.add(m[1].toLowerCase());
  }
  return refs;
}

/** Every bare identifier-ish token, for the denied-column sweep. */
function extractIdentifiers(stripped) {
  const ids = new Set();
  const re = /[a-zA-Z_][a-zA-Z0-9_$]*/g;
  let m;
  while ((m = re.exec(stripped)) !== null) ids.add(m[0].toLowerCase());
  return ids;
}

/** Count `?` placeholders outside of literals. */
function countPlaceholders(stripped) {
  let n = 0;
  for (const ch of stripped) if (ch === "?") n++;
  return n;
}

/**
 * Validate a report SQL statement.
 *
 * @param {string} sql
 * @param {object} [opts]
 * @param {number} [opts.expectedParams] — if provided, placeholder count must match
 * @returns {{ok:true, tables:string[], placeholders:number}
 *          |{ok:false, error:string, detail?:string}}
 */
function validateSql(sql, opts = {}) {
  const raw = String(sql || "").trim();

  if (!raw) return { ok: false, error: "SQL is empty" };

  // 1. Read-only first keyword. Reuse the shared guard so reports and the
  //    readonly endpoint can never diverge on what "read-only" means.
  if (!isReadOnlyQuery(raw)) {
    return {
      ok: false,
      error: "Report SQL must be read-only",
      detail: "First keyword must be SELECT / SHOW / DESCRIBE / DESC / EXPLAIN.",
    };
  }

  // Reports specifically must be SELECT — SHOW/DESCRIBE/EXPLAIN pass the
  // read-only guard but produce shapes the runner and UI can't meaningfully
  // render, and DESCRIBE leaks schema for tables outside the allowlist.
  const firstWord = raw.replace(/^\s*(?:\/\*[\s\S]*?\*\/|--[^\n]*\n|#[^\n]*\n)*\s*/, "")
    .split(/\s+/)[0]
    .toUpperCase();
  if (firstWord !== "SELECT") {
    return {
      ok: false,
      error: "Report SQL must be a SELECT",
      detail: `Got ${firstWord}. SHOW / DESCRIBE / EXPLAIN are not valid report bodies.`,
    };
  }

  if (hasFileExfilClause(raw)) {
    return { ok: false, error: "INTO OUTFILE / INTO DUMPFILE is not allowed" };
  }

  // Raw-text checks that must happen BEFORE comment stripping.
  for (const { re, msg } of RAW_FORBIDDEN_PATTERNS) {
    if (re.test(raw)) return { ok: false, error: msg };
  }

  const { stripped, backticked } = stripLiterals(raw);

  // 2. Statement stacking. mysql2 blocks this at the parser, but a clear
  //    message beats a driver error. A trailing semicolon is fine.
  if (stripped.replace(/;\s*$/, "").includes(";")) {
    return {
      ok: false,
      error: "Only a single statement is allowed",
      detail: "Remove the ';' — a report is exactly one SELECT.",
    };
  }

  // 3. Blanket forbidden constructs.
  for (const { re, msg } of FORBIDDEN_PATTERNS) {
    if (re.test(stripped)) return { ok: false, error: msg };
  }

  // 4. Denied columns — scan bare identifiers AND unwrapped backtick names.
  const identifiers = extractIdentifiers(stripped);
  for (const name of backticked) identifiers.add(name.toLowerCase());

  for (const id of identifiers) {
    if (isDeniedColumn(id)) {
      return {
        ok: false,
        error: `Column "${id}" may not appear in a report`,
        detail:
          "It is on the reporting denylist (client PII or credential material). " +
          `Denied: ${DENIED_COLUMNS.join(", ")}.`,
      };
    }
  }

  // 5. SELECT * — banned outright. It defeats the column denylist (a `*` over
  //    contacts returns contact_ssn) and makes report output unstable when a
  //    column is added.
  //
  //    This must distinguish a select-list star from the MULTIPLICATION
  //    operator. `ROUND(100.0 * SUM(x), 1)` is an ordinary percentage
  //    calculation and has to pass; an earlier naive "any bare *" check
  //    rejected it and would have blocked every percentage report. So match
  //    only the three positions a select-list star can actually occupy:
  //      a) directly after SELECT (optionally DISTINCT/ALL)
  //      b) directly after a comma in a select list
  //      c) qualified — alias.*
  //    Multiplication is always preceded by an operand (identifier, number or
  //    closing paren), never by SELECT, a comma, or a dot, so none of these
  //    three can collide with it. COUNT(*) is preceded by '(' and is fine.
  const STAR_PATTERNS = [
    { re: /\bSELECT\s+(?:DISTINCT\s+|ALL\s+)?\*/i, what: "SELECT *" },
    { re: /,\s*\*/, what: "a bare * in the select list" },
    { re: /\.\s*\*/, what: "a qualified table.*" },
  ];
  for (const { re, what } of STAR_PATTERNS) {
    if (re.test(stripped)) {
      return {
        ok: false,
        error: "SELECT * is not allowed in reports",
        detail:
          `Found ${what}. List columns explicitly — '*' would bypass the column ` +
          "denylist and makes output shift whenever a column is added. " +
          "COUNT(*) and multiplication (a * b) are both fine.",
      };
    }
  }

  // 6. Table allowlist.
  const tableRefs = extractTableRefs(stripped);
  if (tableRefs.size === 0) {
    return {
      ok: false,
      error: "No table reference found",
      detail: "A report must read from at least one allowlisted table.",
    };
  }

  const offenders = [];
  for (const t of tableRefs) {
    if (isDeniedTable(t)) {
      return {
        ok: false,
        error: `Table "${t}" is explicitly blocked from reporting`,
      };
    }
    if (!isAllowedTable(t)) offenders.push(t);
  }
  if (offenders.length) {
    return {
      ok: false,
      error: `Table(s) not available to reports: ${offenders.join(", ")}`,
      detail:
        "Reports may only read the curated set. Available: " +
        [...ALLOWED_TABLES].sort().join(", ") +
        ". If one of these is genuinely needed, add it to lib/reportSchema/manifest.js with notes.",
    };
  }

  // 7. Placeholder arity.
  const placeholders = countPlaceholders(stripped);
  if (opts.expectedParams != null && placeholders !== opts.expectedParams) {
    return {
      ok: false,
      error: "Parameter count mismatch",
      detail: `SQL has ${placeholders} '?' placeholder(s) but ${opts.expectedParams} parameter(s) are declared. They must match, in order.`,
    };
  }

  return { ok: true, tables: [...tableRefs], placeholders };
}

/**
 * Validate a params declaration array.
 * Shape: [{ name, type, label?, default?, required? }]
 */
const PARAM_TYPES = new Set(["date", "datetime", "number", "string"]);
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

function validateParams(params) {
  if (params == null) return { ok: true, params: [] };
  if (!Array.isArray(params)) {
    return { ok: false, error: "params must be an array" };
  }
  const seen = new Set();
  for (let i = 0; i < params.length; i++) {
    const p = params[i] || {};
    if (!PARAM_NAME_RE.test(String(p.name || ""))) {
      return { ok: false, error: `params[${i}].name must match [a-zA-Z][a-zA-Z0-9_]{0,39}` };
    }
    if (seen.has(p.name)) {
      return { ok: false, error: `params[${i}].name "${p.name}" is duplicated` };
    }
    seen.add(p.name);
    if (!PARAM_TYPES.has(String(p.type || ""))) {
      return {
        ok: false,
        error: `params[${i}].type must be one of ${[...PARAM_TYPES].join(", ")}`,
      };
    }
  }
  return { ok: true, params };
}

/**
 * Validate a viz spec.
 *
 * Deliberately LENIENT: an unusable chart hint must never cost you a correct
 * report. Anything unrecognised is stripped and reported as a warning, so the
 * definition still saves and the UI falls back to inferring a chart from the
 * result shape. The caller surfaces `warning` so a bad hint is visible rather
 * than silently swallowed.
 *
 * @returns {{viz: object|null, warning: string|null}}
 */
const VIZ_TYPES = new Set(["bar", "line", "area", "pie", "doughnut", "combo", "stat", "table"]);
const VIZ_FORMATS = new Set(["number", "percent", "currency", "days", "text", "date"]);

function sanitizeViz(viz) {
  if (viz == null) return { viz: null, warning: null };
  if (typeof viz !== "object" || Array.isArray(viz)) {
    return { viz: null, warning: "viz must be an object; it was ignored." };
  }

  const type = String(viz.type || "").toLowerCase();
  if (!VIZ_TYPES.has(type)) {
    return {
      viz: null,
      warning: `Unknown chart type "${viz.type}" — ignored. Valid: ${[...VIZ_TYPES].join(", ")}.`,
    };
  }

  const out = { type };
  if (viz.x != null) out.x = String(viz.x);
  if (viz.y != null) out.y = String(viz.y);

  if (Array.isArray(viz.series)) {
    const series = viz.series
      .filter((s) => s && s.key != null)
      .map((s) => {
        const o = { key: String(s.key) };
        if (s.label != null) o.label = String(s.label);
        if (["bar", "line", "area"].includes(String(s.type).toLowerCase())) {
          o.type = String(s.type).toLowerCase();
        }
        if (s.axis === "y1") o.axis = "y1";
        if (VIZ_FORMATS.has(s.format)) o.format = s.format;
        return o;
      });
    if (series.length) out.series = series;
  }

  if (viz.stacked) out.stacked = true;
  if (viz.horizontal) out.horizontal = true;
  if (viz.yLabel != null) out.yLabel = String(viz.yLabel);
  if (viz.y1Label != null) out.y1Label = String(viz.y1Label);
  if (viz.xLabel != null) out.xLabel = String(viz.xLabel);
  if (Number.isFinite(Number(viz.limit))) out.limit = Number(viz.limit);

  // A chart needs a metric. stat/table are the exceptions — stat derives its
  // cards from the numeric columns when none are named.
  if (!out.series && !out.y && type !== "stat" && type !== "table") {
    return {
      viz: null,
      warning: `A "${type}" chart needs either a 'y' column or a 'series' array — the hint was ignored.`,
    };
  }

  return { viz: out, warning: null };
}

/**
 * Sanitize a columns_meta array (YisraView).
 *
 * columns_meta has TWO consumers and the shape must stay additive for both:
 *   1. lib/internal_functions/reports.js (email renderer) — reads {key, label,
 *      format} via fmtFor()/dataTable(). Existing behaviour untouched.
 *   2. public/customView.html (view renderer) — additionally reads {align,
 *      width, hidden, action}.
 *
 * Same leniency contract as sanitizeViz: a bad hint must never cost a correct
 * definition. Unknown or malformed extras are STRIPPED and reported as
 * warnings; only an entry with no usable `key` is dropped entirely.
 *
 * ACTIONS are a fixed, renderer-owned registry. An action is only ever a
 * registry NAME plus COLUMN REFERENCES — never a URL, an href, a JS string, or
 * a template. The implementations live in the renderer. This is the same
 * boundary as the superuser gate on code-carrying form templates, and for the
 * same reason. The renderer re-checks membership and idKey presence at render
 * time regardless — this sanitiser runs at save time, when the result-set
 * columns may not be known (pass `knownKeys` when they are, e.g. from a draft
 * preview's field list).
 *
 * @param {Array|null} meta
 * @param {Array<string>|null} [knownKeys]  result-set column names, if known
 * @returns {{columns_meta: Array, warnings: string[]}}
 */
const ACTION_TYPES = new Set(["open_case", "open_contact", "open_bill", "copy"]);
const META_ALIGNS = new Set(["left", "right", "center"]);
const META_WIDTH_MIN = 40;
const META_WIDTH_MAX = 600;

function sanitizeColumnsMeta(meta, knownKeys = null) {
  if (meta == null) return { columns_meta: [], warnings: [] };
  if (!Array.isArray(meta)) {
    return { columns_meta: [], warnings: ["columns_meta must be an array; it was ignored."] };
  }

  const known =
    Array.isArray(knownKeys) && knownKeys.length
      ? new Set(knownKeys.map((k) => String(k)))
      : null;
  const warnings = [];
  const out = [];

  for (let i = 0; i < meta.length; i++) {
    const c = meta[i];
    if (!c || typeof c !== "object" || Array.isArray(c) || c.key == null || String(c.key).trim() === "") {
      warnings.push(`columns_meta[${i}] has no key — dropped.`);
      continue;
    }
    const o = { key: String(c.key) };
    if (known && !known.has(o.key)) {
      warnings.push(`columns_meta[${i}] key "${o.key}" is not a column the SQL returns.`);
      // Keep it: the SQL may legitimately change under an update. Render-time
      // matching simply won't find it.
    }

    if (c.label != null) o.label = String(c.label);

    if (c.format != null) {
      if (VIZ_FORMATS.has(c.format)) o.format = c.format;
      else warnings.push(`columns_meta[${i}] format "${c.format}" is not one of ${[...VIZ_FORMATS].join(", ")} — stripped.`);
    }

    if (c.align != null) {
      const a = String(c.align).toLowerCase();
      if (META_ALIGNS.has(a)) o.align = a;
      else warnings.push(`columns_meta[${i}] align "${c.align}" is not left|right|center — stripped.`);
    }

    if (c.width != null) {
      const w = Number(c.width);
      if (Number.isFinite(w)) {
        o.width = Math.round(Math.max(META_WIDTH_MIN, Math.min(META_WIDTH_MAX, w)));
      } else {
        warnings.push(`columns_meta[${i}] width "${c.width}" is not a number — stripped.`);
      }
    }

    if (c.hidden != null) {
      if (c.hidden === true || c.hidden === false) o.hidden = c.hidden;
      else o.hidden = !!c.hidden;
    }

    if (c.action != null) {
      const a = c.action;
      const drop = (why) => warnings.push(`columns_meta[${i}] action dropped: ${why}`);
      if (typeof a !== "object" || Array.isArray(a)) {
        drop("action must be an object of {type, idKey?, labelKey?}.");
      } else if (!ACTION_TYPES.has(String(a.type || ""))) {
        drop(`unknown type "${a.type}". Registry: ${[...ACTION_TYPES].join(", ")}.`);
      } else {
        const type = String(a.type);
        const idKey = a.idKey != null && String(a.idKey).trim() !== "" ? String(a.idKey) : null;
        const labelKey = a.labelKey != null && String(a.labelKey).trim() !== "" ? String(a.labelKey) : null;
        if (type !== "copy" && !idKey) {
          drop(`"${type}" requires an idKey naming the column that holds the id.`);
        } else if (known && idKey && !known.has(idKey)) {
          drop(`idKey "${idKey}" is not a column the SQL returns.`);
        } else if (known && labelKey && !known.has(labelKey)) {
          drop(`labelKey "${labelKey}" is not a column the SQL returns.`);
        } else {
          const act = { type };
          if (idKey) act.idKey = idKey;
          if (labelKey) act.labelKey = labelKey;
          o.action = act;
        }
      }
    }

    out.push(o);
  }

  return { columns_meta: out, warnings };
}

module.exports = {
  validateSql,
  validateParams,
  sanitizeViz,
  sanitizeColumnsMeta,
  ACTION_TYPES,
  stripLiterals,
};