// tests/sqlGuard.secretTables.test.js
//
// touchesSecretTable guards the PUBLIC readonly endpoint
// (routes/api.readonly.js) against reading app_settings — the table
// carries is_secret credentials (internal_api_key and friends) and the
// RO MySQL grant is schema-wide, so this app-level deny is the only
// exclusion layer. The SU dbConsole deliberately does NOT use it.

const { touchesSecretTable, SECRET_TABLES } = require("../lib/sqlGuard");

describe("sqlGuard.touchesSecretTable", () => {
  test("registry holds exactly the reviewed set", () => {
    // Adding a table here is an access decision — review the consumers.
    expect(SECRET_TABLES).toEqual(["app_settings"]);
  });

  test.each([
    ["SELECT value FROM app_settings WHERE `key`='internal_api_key'"],
    ["select * from APP_SETTINGS"],
    ["SELECT s.value FROM `app_settings` s"],
    ["SELECT 1 FROM/**/app_settings"],
    ["EXPLAIN SELECT * FROM app_settings"],
    ["SELECT * FROM rw_scratch UNION SELECT `key`, value, 1, NULL, NULL FROM app_settings"],
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
  ])("allows: %s", (sql) => {
    expect(touchesSecretTable(sql)).toBe(false);
  });
});
