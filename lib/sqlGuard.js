// lib/sqlGuard.js
//
// Shared read-only SQL validator. Same semantics as the local copy in
// routes/admin.dbConsole.js (left in place to avoid scope creep). Both
// the admin dbConsole and the new /api/readonly/sql endpoint rely on
// this, but the readonly endpoint also has a DB-grant safety layer
// (the yc_readonly MySQL user has SELECT-only privileges), so this
// validator is defense-in-depth, not the sole barrier.
//
// A query is "read-only" if its first meaningful keyword is
// SELECT / SHOW / DESCRIBE / DESC / EXPLAIN. Block + line comments
// at the head of the statement are stripped first so a commented
// header doesn't confuse the check.
//
// Deliberately does NOT include WITH — MySQL 8 allows `WITH ... UPDATE`,
// which is a write. CTEs can still be expressed inside a SELECT.

function isReadOnlyQuery(sql) {
  let s = String(sql || "").trim();
  // strip leading block comments
  while (s.startsWith("/*")) {
    const end = s.indexOf("*/");
    if (end < 0) return false;
    s = s.slice(end + 2).trim();
  }
  // strip leading line comments
  while (s.startsWith("--") || s.startsWith("#")) {
    const end = s.indexOf("\n");
    if (end < 0) return false;
    s = s.slice(end + 1).trim();
  }
  const first = (s.split(/\s+/)[0] || "").toUpperCase();
  return ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first);
}

// Reject INTO OUTFILE / INTO DUMPFILE explicitly. The DB-level
// no-FILE-priv check would block these anyway, but a clear app-level
// error is friendlier than a cryptic permission error from MySQL.
function hasFileExfilClause(sql) {
  return /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(String(sql || ""));
}

// ── Tables the PUBLIC readonly endpoint withholds — two tiers ─────────────
// (access-control SEC-3, ref/ACCESS_CONTROL_DESIGN.md §5.7.) The RO MySQL
// grant is schema-wide and MySQL has no negative grants, so these tables
// cannot be excluded at the DB layer; this list is the only exclusion.
// Matched as a bare word anywhere in the statement: to query a table MySQL
// requires its literal name, so a word match cannot be aliased around;
// string-literal false positives are acceptable on this surface. Consumed by
// routes/api.readonly.js ONLY — the SU dbConsole keeps its own local
// validator and full access by design.
//
// SECRET_TABLES — ABSOLUTE: no key reads them, whatever its scopes. They hold
// live credentials, and a row-level split (is_secret) is not expressible in
// a statement-regex guard.
//   app_settings: is_secret rows (internal_api_key and friends) — an RO key
//     reading it would escalate to internal-API authority (found 2026-10-07,
//     CTA S1 review).
//   email_ingest_sources: api_key is a plaintext bearer for POST
//     /api/email/ingest — reading it lets an RO key forge envelopes and fire
//     Layer-3 rules (court, e-sign). Added 2026-10-08 with the gmail-firm key
//     rotation.
const SECRET_TABLES = ["app_settings", "email_ingest_sources"];

// SENSITIVE_TABLES — CONTENT: readable only by a session key holding the
// `sql.ro.sensitive` scope (lib/capabilities; explicit — a legacy NULL-scopes
// key does not hold it; mint-capped at a short TTL).
//   jwt_api_audit_log: the gateway log — held SU-console statements, SMS and
//     email bodies and search terms until SEC-2 stored value shapes and
//     scrubbed the history; still every route + who.
//   ai_calls: request_excerpt + full response for every AI consumer (client
//     content). The ai_spend VIEW carries its metadata columns to ordinary keys.
//   comms_transcripts / comms_no_transcribe (comms archive S2): privileged
//     call content and the numbers whose calls must never be transcribed —
//     the RO endpoint bypasses the line grant check and the content audit.
//     comms_stt_jobs (ids + cost) stays readable for monitoring.
//   admin_audit_log: SU-console query texts and admin-action details.
//   readonly_query_log: every session's SQL (and its params).
// A sensitive key can read readonly_query_log / admin_audit_log, i.e. its
// own audit trail — the limitation §5.7 states and Fred accepted.
const SENSITIVE_TABLES = [
  "jwt_api_audit_log", "ai_calls", "comms_transcripts", "comms_no_transcribe",
  "admin_audit_log", "readonly_query_log",
];

const firstNamed = (list, sql) => {
  const s = String(sql || "");
  return list.find(t => new RegExp(`\\b${t}\\b`, "i").test(s)) || null;
};

/**
 * deniedTable(sql, { sensitive }) — what the readonly endpoint must refuse.
 *   → { table, tier: 'secret' }      a SECRET table is named (always, first)
 *   → { table, tier: 'sensitive' }   a SENSITIVE table is named and the
 *                                    caller does not hold sql.ro.sensitive
 *   → null                           readable
 * `sensitive` is the caller's keyAllows(auth, 'sql.ro.sensitive').
 */
function deniedTable(sql, { sensitive = false } = {}) {
  const secret = firstNamed(SECRET_TABLES, sql);
  if (secret) return { table: secret, tier: "secret" };
  if (sensitive) return null;
  const t = firstNamed(SENSITIVE_TABLES, sql);
  return t ? { table: t, tier: "sensitive" } : null;
}

// The pre-SEC-3 names, kept with their meaning for an ORDINARY key: "the
// first table this statement may not read" — secret or sensitive.
function matchedSecretTable(sql) {
  const d = deniedTable(sql);
  return d ? d.table : null;
}

function touchesSecretTable(sql) {
  return matchedSecretTable(sql) !== null;
}

module.exports = {
  isReadOnlyQuery, hasFileExfilClause, deniedTable, touchesSecretTable, matchedSecretTable,
  SECRET_TABLES, SENSITIVE_TABLES,
};
