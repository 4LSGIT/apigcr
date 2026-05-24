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

module.exports = { isReadOnlyQuery, hasFileExfilClause };