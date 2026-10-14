// tests/sqlGuard.secretTables.test.js
//
// touchesSecretTable / matchedSecretTable answer for an ORDINARY session key
// at the PUBLIC readonly endpoint (routes/api.readonly.js): app_settings
// (is_secret credentials: internal_api_key and friends) and
// email_ingest_sources (plaintext ingest bearer keys) — SECRET, no key ever —
// plus SEC-3's SENSITIVE_TABLES (content; a sql.ro.sensitive key reads them —
// tests/sensitiveTier.test.js has the two-tier matrix). The RO MySQL grant is
// schema-wide, so this app-level deny is the only exclusion layer. The SU
// dbConsole deliberately does NOT use it.

const { touchesSecretTable, matchedSecretTable, SECRET_TABLES, SENSITIVE_TABLES } = require("../lib/sqlGuard");

describe("sqlGuard.touchesSecretTable", () => {
  test("registry holds exactly the reviewed set", () => {
    // Adding a table here is an access decision — review the consumers.
    // SEC-3 split the old list in two (ACCESS_CONTROL_DESIGN §5.7).
    expect(SECRET_TABLES).toEqual(["app_settings", "email_ingest_sources"]);
    expect(SENSITIVE_TABLES).toEqual(["jwt_api_audit_log", "ai_calls", "comms_transcripts", "comms_no_transcribe", "admin_audit_log", "readonly_query_log"]);
  });

  test.each([
    ["SELECT value FROM app_settings WHERE `key`='internal_api_key'"],
    ["select * from APP_SETTINGS"],
    ["SELECT s.value FROM `app_settings` s"],
    ["SELECT 1 FROM/**/app_settings"],
    ["EXPLAIN SELECT * FROM app_settings"],
    ["SELECT * FROM rw_scratch UNION SELECT `key`, value, 1, NULL, NULL FROM app_settings"],
    ["SELECT name, api_key FROM email_ingest_sources"],
    ["SELECT e.status, s.api_key FROM email_ingest_executions e JOIN `email_ingest_sources` s ON s.id = e.source_id"],
    ["select * from EMAIL_INGEST_SOURCES"],
    // comms archive S2: transcript text and the never-transcribe list
    ["SELECT full_text FROM comms_transcripts WHERE media_id = 1"],
    ["SELECT m.id, t.segments FROM comms_media m JOIN `comms_transcripts` t ON t.media_id = m.id"],
    ["SELECT COUNT(*) FROM comms_transcripts"],
    ["select phone from COMMS_NO_TRANSCRIBE"],
    // access B2 landing → SEC-3 sensitive tier: the gateway audit log.
    ["SELECT body FROM jwt_api_audit_log WHERE id = 1"],
    ["SELECT a.route FROM `jwt_api_audit_log` a LIMIT 5"],
    ["SELECT COUNT(*) FROM JWT_API_AUDIT_LOG"],
  ])("denies: %s", (sql) => {
    expect(touchesSecretTable(sql)).toBe(true);
  });

  test.each([
    ["SELECT * FROM rw_scratch WHERE ns='fred'"],
    ["SELECT * FROM cta_links WHERE token='x'"],
    ["SHOW TABLES"],
    // bare-word match only — other *_settings tables stay readable
    ["SELECT * FROM user_settings"],
    ["SELECT 'app_settings_doc' AS label FROM dual"],
    // ingest executions/rules stay readable — only the key table is denied
    ["SELECT status, COUNT(*) FROM email_ingest_executions GROUP BY status"],
    ["SELECT * FROM email_ingest_rules"],
    // the archive registry and the STT job ledger (ids + cost) stay readable
    ["SELECT state, COUNT(*) FROM comms_media GROUP BY state"],
    ["SELECT state, SUM(est_cents) FROM comms_stt_jobs GROUP BY state"],
  ])("allows: %s", (sql) => {
    expect(touchesSecretTable(sql)).toBe(false);
  });

  // The endpoint names the refused table in its 400 — it must be the one
  // the statement actually touched.
  test.each([
    ["SELECT * FROM app_settings", "app_settings"],
    ["SELECT name, api_key FROM email_ingest_sources", "email_ingest_sources"],
    ["select * from `EMAIL_INGEST_SOURCES` s", "email_ingest_sources"],
    ["SELECT * FROM email_ingest_executions", null],
    ["SELECT * FROM comms_transcripts t", "comms_transcripts"],
    ["SELECT * FROM comms_no_transcribe", "comms_no_transcribe"],
  ])("matchedSecretTable(%s) = %s", (sql, want) => {
    expect(matchedSecretTable(sql)).toBe(want);
  });
});
