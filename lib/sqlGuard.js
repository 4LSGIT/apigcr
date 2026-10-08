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

// Tables the PUBLIC readonly endpoint must never serve. app_settings
// carries is_secret rows (internal_api_key and friends); the RO MySQL
// grant is schema-wide and MySQL has no negative grants, so the table
// cannot be excluded at the DB layer — an RO key reading it would
// escalate to internal-API authority (found 2026-10-07, CTA S1 review).
// Matched as a bare word anywhere in the statement: to query a table
// MySQL requires its literal name, so a word match cannot be aliased
// around; string-literal false positives are acceptable on this surface.
// Consumed by routes/api.readonly.js ONLY — the SU dbConsole keeps its
// own local validator and full access by design.
// email_ingest_sources: api_key is a plaintext bearer for POST
// /api/email/ingest — reading it lets an RO key forge envelopes and fire
// Layer-3 rules (court, e-sign). Added 2026-10-08 with the gmail-firm
// key rotation.
const SECRET_TABLES = ["app_settings", "email_ingest_sources"];

// First secret table the statement names, or null — lets the endpoint say
// which table it refused instead of a fixed name.
function matchedSecretTable(sql) {
  const s = String(sql || "");
  return SECRET_TABLES.find(t => new RegExp(`\\b${t}\\b`, "i").test(s)) || null;
}

function touchesSecretTable(sql) {
  return matchedSecretTable(sql) !== null;
}

module.exports = { isReadOnlyQuery, hasFileExfilClause, touchesSecretTable, matchedSecretTable, SECRET_TABLES };