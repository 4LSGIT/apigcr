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
// HARDENED 2026-10-21 (validator-containment arc). Until the per-table/
// per-column grant user lands (ref/plans.md "Report/assistant least-privilege
// DB user"), the pool behind this file still holds schema-wide SELECT, so this
// file IS the live boundary against reading a credential/content table. Two
// layers, belt AND suspenders: (1) a FROM-clause-aware table walk that catches
// every table position the old keyword regex missed — comma joins,
// parenthesised tables, STRAIGHT_JOIN (refused outright), UNION TABLE,
// backtick-quoted/aliased names; (2) a whole-statement deny word-scan
// (DENY_WORD_SET) over lib/sqlGuard's SECRET + SENSITIVE tiers (incl. the
// assistant chat tables) and the manifest's DENIED_TABLES — the lists are
// sourced from there, never duplicated. The star ban also covers every SELECT
// modifier (HIGH_PRIORITY / SQL_NO_CACHE / DISTINCTROW / …), not just
// DISTINCT|ALL. Shapes are pinned in tests/reportValidatorHardening.test.js.
//
// ── STRING AND COMMENT HANDLING ─────────────────────────────────────────────
// Identifier scanning runs over a STRIPPED copy of the SQL with string
// literals, backtick-quoted identifiers and comments blanked out. Without that,
// a report whose WHERE clause legitimately contains the text 'password' would
// be rejected, and — more importantly — a denied identifier could be smuggled
// past the scan inside what looks like a literal. Backticked identifiers are
// unwrapped and re-scanned separately so `password_hash` is still caught.

const {
  isAllowedTable,
  isDeniedTable,
  isDeniedColumn,
  ALLOWED_TABLES,
  DENIED_COLUMNS,
  DENIED_TABLES,
} = require("./manifest");

const {
  isReadOnlyQuery,
  hasFileExfilClause,
  SECRET_TABLES,
  SENSITIVE_TABLES,
} = require("../sqlGuard");

// ── DENY WORD-SCAN (belt, paired with the structural allowlist below) ────────
// The allowlist is a positive check on the table refs the parser pulls out of
// the statement. This is the suspenders: a flat set of table names that may
// never appear ANYWHERE in a report body, scanned as bare words over the whole
// statement exactly as lib/sqlGuard does for the readonly endpoint. It catches
// any spelling the structural parser might miss (comma join, parenthesised
// table, an exotic table-valued construct), and it is the hard stop on the
// credential- and content-tier tables regardless of how the reference is
// dressed up. Single source of truth: the tier lists live in lib/sqlGuard and
// the report-side extras in lib/reportSchema/manifest — this set is their union,
// built here, never re-listed.
//   • sqlGuard SECRET_TABLES     — app_settings, email_ingest_sources (creds)
//   • sqlGuard SENSITIVE_TABLES  — audit/content tiers incl. the assistant chat
//                                  tables (added 2026-10-21)
//   • manifest DENIED_TABLES     — report-specific backups / junk / token tables
const DENY_WORD_SET = new Set(
  [...SECRET_TABLES, ...SENSITIVE_TABLES, ...DENIED_TABLES].map((t) =>
    String(t).toLowerCase()
  )
);

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
  // STRAIGHT_JOIN reads like an optimiser hint but also introduces a table the
  // keyword-anchored scan never saw; no legitimate report uses it, so refuse it
  // outright and keep the table extractor's job tractable.
  { re: /\bstraight_join\b/i, msg: "STRAIGHT_JOIN is not allowed in reports — use an explicit JOIN" },
];

// Checked against the RAW sql, before comment stripping. A /*!50000 ... */
// version-conditional comment is executed by MySQL but looks like a comment to
// any stripper, so it must be caught before `stripLiterals` blanks it out.
const RAW_FORBIDDEN_PATTERNS = [
  { re: /\/\*!/, msg: "MySQL version-conditional comments (/*! ... */) are not allowed" },
];

/**
 * True when position j (just after a `--`) makes that `--` a MySQL comment:
 * end of input, or a whitespace/control character (code <= 0x20).
 */
function isDashCommentEnd(src, j) {
  return j >= src.length || src.charCodeAt(j) <= 0x20;
}

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
    // MySQL opens a `--` comment ONLY when the second dash is followed by
    // whitespace, a control character, or the end of the statement. `1--x` is
    // `1 - -x` — an expression that READS x. Treating every `--` as a comment
    // let `SELECT 1--password_hash` hide a denied column from every scan while
    // MySQL evaluated it (found by the fix/casey worker, 2026-10-21). Narrower
    // than MySQL is the safe direction: a missed comment is over-rejection.
    if ((ch === "-" && src[i + 1] === "-" && isDashCommentEnd(src, i + 2)) || ch === "#") {
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

    // `backtick identifier` — capture the name AND keep its identifier
    // characters in the stripped output (offset-preserving). Earlier this
    // branch blanked the whole region, which let a backtick-quoted denied
    // table be aliased past the table scan (`\`app_settings\` cases` read as
    // table "cases") and hid the name from the deny word-scan. Keeping the
    // word chars inline means the table extractor, the column sweep and the
    // deny scan all see the real identifier; non-identifier characters inside
    // the quotes are still blanked so a stray ';' or operator can't leak out.
    if (ch === "`") {
      let name = "";
      out += " "; i++;
      while (i < src.length && src[i] !== "`") {
        name += src[i];
        out += /[A-Za-z0-9_$]/.test(src[i]) ? src[i] : " ";
        i++;
      }
      if (i < src.length) { out += " "; i++; }
      if (name) backticked.push(name);
      continue;
    }

    out += ch;
    i++;
  }

  return { stripped: out, backticked };
}

// Keywords that END a table list (a FROM/JOIN clause) when seen at its depth.
const CLAUSE_END = new Set([
  "where", "group", "having", "order", "limit", "union", "except",
  "intersect", "window", "for", "procedure", "lock", "offset",
]);
// Keywords that may sit in a table-expected slot without being a table name,
// so we skip over them and keep looking for the real reference.
const TABLE_SLOT_SKIP = new Set(["lateral"]);

/**
 * Table names in every table-reference position of a read-only statement:
 * after FROM, after any ...JOIN, after a comma inside a FROM clause (old-style
 * comma join), and after a bare TABLE (UNION TABLE t). Returns
 * { refs:Set<string>, error:{error,detail}|null }.
 *
 * This is a FROM-clause-aware token walk, not a keyword-anchored regex, because
 * the regex form missed comma joins, parenthesised table groups and
 * STRAIGHT_JOIN entirely — the shapes that defeated the allowlist. A
 * parenthesised SUBQUERY (`FROM (SELECT …) x`) is transparent: its own inner
 * FROM is reached by the same walk, so nothing special is captured for it.
 * Over-capture is safe here (an extra name just gets allowlist-checked); the
 * failure mode of this tokeniser is a legitimate query refused, never a denied
 * one admitted. Schema-qualified table refs (`db.tbl`) are refused outright —
 * no report uses them and they are a classic way to point past the allowlist.
 */
function extractTableRefs(stripped) {
  const refs = new Set();
  // Words and the punctuation that matters to clause structure.
  const tokens = stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*|[(),.]/g) || [];

  let depth = 0;
  // fromActive[d] === true while we are inside a FROM/JOIN table list at depth d
  const fromActive = [];
  let expectTable = false;

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (tk === "(") {
      if (expectTable) {
        // Look at the first word inside the paren.
        const nextWord = nextSignificantWord(tokens, k + 1);
        if (nextWord === "select") {
          // Derived-table subquery — not a table name. Its inner FROM is
          // handled as the walk descends into the higher depth.
          expectTable = false;
        }
        // else: a parenthesised table group, e.g. (t) or (a JOIN b). Keep
        // expectTable so the identifier right after '(' is captured, and mark
        // the inner depth as a live table list.
      }
      depth++;
      if (expectTable) fromActive[depth] = true;
      continue;
    }
    if (tk === ")") {
      fromActive[depth] = false;
      if (depth > 0) depth--;
      continue;
    }
    if (tk === ",") {
      if (fromActive[depth]) expectTable = true;
      continue;
    }
    if (tk === ".") continue;

    // A word.
    const w = tk.toLowerCase();

    if (expectTable) {
      if (TABLE_SLOT_SKIP.has(w)) continue;               // LATERAL etc.
      // Schema-qualified? next significant token is a dot.
      if (tokens[k + 1] === ".") {
        return {
          refs,
          error: {
            error: "Schema-qualified table references are not allowed in reports",
            detail:
              `"${tk}.…" names a database explicitly. Reports read the curated ` +
              "set from the default schema only — drop the schema prefix.",
          },
        };
      }
      refs.add(w);
      expectTable = false;
      continue;
    }

    // Not currently expecting a table — look for a table-introducing keyword.
    if (w === "from" || w === "join" || w === "table") {
      fromActive[depth] = true;
      expectTable = true;
    } else if (CLAUSE_END.has(w)) {
      fromActive[depth] = false;
    }
  }

  return { refs, error: null };
}

/** The lowercased first word token at or after index i, or null. */
function nextSignificantWord(tokens, i) {
  for (let k = i; k < tokens.length; k++) {
    if (/^[A-Za-z_$]/.test(tokens[k])) return tokens[k].toLowerCase();
  }
  return null;
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
  // `--` heads a comment only when followed by whitespace/control (see
  // isDashCommentEnd); mirror that here so the two can never disagree.
  const firstWord = raw.replace(/^\s*(?:\/\*[\s\S]*?\*\/|--(?=[\x00-\x20])[^\n]*\n|#[^\n]*\n)*\s*/, "")
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

  // 3b. Deny word-scan (belt). A credential/content/backup table name may not
  //     appear ANYWHERE in the statement, however it is spelled or joined —
  //     the hard stop that does not depend on the structural parser below
  //     pulling the reference out correctly. Scanned over `stripped`, where
  //     string literals and comments are blanked but backtick identifiers are
  //     preserved, so a genuine reference is caught while a literal that merely
  //     contains the word is not.
  const bareWords = extractIdentifiers(stripped);
  for (const w of bareWords) {
    if (DENY_WORD_SET.has(w)) {
      return {
        ok: false,
        error: `Table "${w}" may not be read by a report`,
        detail:
          "It holds credential material, protected content, or is a backup/" +
          "telemetry table excluded from reporting. The block is on the name " +
          "appearing anywhere in the statement, in any join or subquery.",
      };
    }
  }

  // 4. Denied columns — scan bare identifiers AND unwrapped backtick names.
  const identifiers = bareWords;
  for (const name of backticked) identifiers.add(name.toLowerCase());

  for (const id of identifiers) {
    if (isDeniedColumn(id)) {
      return {
        ok: false,
        error: `Column "${id}" may not appear in a report`,
        detail:
          "It is on the reporting denylist (credential material, or the raw custom-fields JSON bag). " +
          `Denied: ${DENIED_COLUMNS.join(", ")}.`,
      };
    }
  }

  // 5. SELECT * — banned outright. It defeats the column denylist (a `*` over
  //    users returns password_hash) and makes report output unstable when a
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
  // Any number of SELECT modifiers may sit between SELECT and the select list
  // (ALL / DISTINCT / DISTINCTROW and the HIGH_PRIORITY / SQL_NO_CACHE /
  // SQL_CALC_FOUND_ROWS / SQL_BUFFER_RESULT / result-size family). The earlier
  // pattern only skipped DISTINCT|ALL, so `SELECT HIGH_PRIORITY *`,
  // `SELECT SQL_NO_CACHE *`, `SELECT DISTINCTROW *` etc. slipped a `*` past this
  // ban. Match the whole modifier run. (STRAIGHT_JOIN is already refused above.)
  const SELECT_MODIFIER =
    "ALL|DISTINCT|DISTINCTROW|HIGH_PRIORITY|STRAIGHT_JOIN|" +
    "SQL_SMALL_RESULT|SQL_BIG_RESULT|SQL_BUFFER_RESULT|" +
    "SQL_NO_CACHE|SQL_CACHE|SQL_CALC_FOUND_ROWS";
  const STAR_PATTERNS = [
    { re: new RegExp(`\\bSELECT\\s+(?:(?:${SELECT_MODIFIER})\\s+)*\\*`, "i"), what: "SELECT *" },
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
  const { refs: tableRefs, error: refErr } = extractTableRefs(stripped);
  if (refErr) return { ok: false, ...refErr };
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
 * `open_form` (2026-09-01) is the one action that carries anything beyond
 * column references: a `formKey` (slug-validated, resolved by render.html
 * against form_templates) and an optional `linkType` (enum, default 'case').
 * Both are still registry-name-shaped values, never URLs or code — the same
 * class of reference as the action type itself. The renderer builds the only
 * URL that ever exists (/forms/render.html?form_key=…&<linkType>_id=…), so a
 * definition still cannot inject navigation. Authoring executable form
 * content stays gated behind form_dev at the template layer; pointing a view
 * at a form grants nothing a staff user couldn't reach by URL already.
 *
 * @param {Array|null} meta
 * @param {Array<string>|null} [knownKeys]  result-set column names, if known
 * @returns {{columns_meta: Array, warnings: string[]}}
 */
const ACTION_TYPES = new Set(["open_case", "open_contact", "open_bill", "copy", "open_form"]);
const ACTION_FORM_LINK_TYPES = new Set(["case", "contact", "appt"]);
const ACTION_FORM_KEY_RE = /^[a-zA-Z0-9_-]{1,50}$/;
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
        // open_form extras — validated up front so the shared checks below
        // stay linear. formKey is REQUIRED and slug-shaped (it names a
        // form_templates.form_key; render.html 404s an unknown one, so the
        // failure mode of a typo is loud, not silent). linkType is optional
        // and defaults to 'case' — it only selects which query-param name
        // carries the id (case_id / contact_id / appt_id).
        const formKey = a.formKey != null && String(a.formKey).trim() !== "" ? String(a.formKey).trim() : null;
        const linkType = a.linkType != null && String(a.linkType).trim() !== "" ? String(a.linkType).trim() : "case";
        if (type === "open_form" && (!formKey || !ACTION_FORM_KEY_RE.test(formKey))) {
          drop(`"open_form" requires a formKey (letters/digits/_/-, max 50) naming a form template.`);
        } else if (type === "open_form" && !ACTION_FORM_LINK_TYPES.has(linkType)) {
          drop(`"open_form" linkType "${linkType}" is not one of ${[...ACTION_FORM_LINK_TYPES].join(", ")}.`);
        } else if (type !== "copy" && !idKey) {
          drop(`"${type}" requires an idKey naming the column that holds the id.`);
        } else if (known && idKey && !known.has(idKey)) {
          drop(`idKey "${idKey}" is not a column the SQL returns.`);
        } else if (known && labelKey && !known.has(labelKey)) {
          drop(`labelKey "${labelKey}" is not a column the SQL returns.`);
        } else {
          const act = { type };
          if (idKey) act.idKey = idKey;
          if (labelKey) act.labelKey = labelKey;
          if (type === "open_form") { act.formKey = formKey; act.linkType = linkType; }
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