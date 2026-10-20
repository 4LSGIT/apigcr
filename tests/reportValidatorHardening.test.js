// tests/reportValidatorHardening.test.js
//
// Hardening of lib/reportSchema/validator.js (validator-hardening arc,
// 2026-10-21). The validator is the sole app-layer boundary on report + Ask
// Casey SQL, which runs on the schema-wide-SELECT yc_ro pool. An independent
// review proved the table allowlist and the SELECT-* ban could both be
// side-stepped with alternative join/statement spellings (comma joins,
// STRAIGHT_JOIN, parenthesised tables, UNION TABLE, backtick-quoted table
// names, and SELECT-modifier stars such as HIGH_PRIORITY / SQL_NO_CACHE /
// DISTINCTROW). This suite pins:
//
//   1. a REGRESSION corpus — representative legitimate report shapes that must
//      keep validating (0 false refusals). It mirrors the structural variety of
//      the firm's live saved reports (verified separately, at authoring time,
//      against all live report_definitions / report_definition_versions and
//      report_runs via the RO endpoint — 0 refusals); the shapes here are
//      hand-authored so the test carries no live-DB provenance.
//   2. a REFUSAL case per bypass shape from the review, including a
//      non-secret comma/paren join so the STRUCTURAL allowlist fix is proven
//      independently of the word-scan belt.
//   3. the deny WORD-SCAN belt: every credential/content/backup table name is
//      refused wherever it appears, in any join or subquery.
//   4. the sqlGuard tier move: assistant_chats / assistant_chat_messages are
//      SENSITIVE (readable only with sql.ro.sensitive).
//
// MUTATION MAP (each guard, break it → which block fails):
//   • STAR_PATTERNS modifier run       → "star ban: SELECT-modifier stars"
//   • STRAIGHT_JOIN forbidden pattern  → "refuses STRAIGHT_JOIN"
//   • DENY_WORD_SET belt               → "deny word-scan belt" + secret-join cases
//   • extractTableRefs walk            → "structural allowlist (parser)"
//   • backtick-preserving stripLiterals→ "backtick-quoted ... table"
//   • sqlGuard SENSITIVE_TABLES add    → "sqlGuard: assistant chat tables"

const { validateSql } = require('../lib/reportSchema/validator');
const { deniedTable, isReadOnlyQuery, SECRET_TABLES, SENSITIVE_TABLES } = require('../lib/sqlGuard');
const { DENIED_TABLES } = require('../lib/reportSchema/manifest');

const ok = (sql) => validateSql(sql).ok === true;
const refusal = (sql) => {
  const r = validateSql(sql);
  return r.ok ? null : `${r.error}`;
};

// ───────────────────────────────────────────────────────────────────────────
// 1. REGRESSION — legitimate shapes that MUST keep validating.
// ───────────────────────────────────────────────────────────────────────────
describe('regression: legitimate report shapes still validate', () => {
  const ACCEPT = {
    simple: 'SELECT case_id, case_type FROM cases LIMIT 10',
    distinct: 'SELECT DISTINCT case_type FROM cases',
    count_star: 'SELECT COUNT(*) AS n FROM cases',
    multiplication: 'SELECT ROUND(100.0 * SUM(1) / COUNT(*), 1) AS pct FROM appts',
    qualified_cols: 'SELECT c.case_id, ct.contact_name FROM cases c LEFT JOIN contacts ct ON 1=1 LIMIT 5',
    backtick_col: 'SELECT c.`341_status` AS s FROM cases c LIMIT 5',
    find_in_set: "SELECT case_id FROM cases WHERE FIND_IN_SET('Received', case_1st_course)",
    concat_ws_commas: "SELECT CONCAT_WS(',', case_id, case_type) AS blob FROM cases",
    date_format: "SELECT DATE_FORMAT(appt_date, '%Y-%m-%d %H:%i:%s') AS d FROM appts LIMIT 5",
    ssn_allowed: "SELECT contact_ssn, contact_dob FROM contacts WHERE contact_ssn <> ''",
    subquery_from: 'SELECT x.n FROM (SELECT COUNT(*) n FROM cases) x',
    two_subqueries:
      'SELECT a.c FROM (SELECT case_id c FROM cases) a JOIN (SELECT contact_id FROM contacts) b ON 1=1',
    collate_join_subq:
      "SELECT l.log_id FROM (SELECT log_id, log_link_id FROM log WHERE log_date >= '2026-01-01' ORDER BY log_date DESC LIMIT 10) l " +
      'LEFT JOIN contacts c ON l.log_link_id COLLATE utf8mb4_general_ci = CAST(c.contact_id AS CHAR) COLLATE utf8mb4_general_ci',
    comma_join_both_allowed: 'SELECT c.case_id FROM cases c, contacts ct LIMIT 5',
    worksheet_like:
      "SELECT c.case_id, c.`341_status` AS concluded, ct.contact_name AS debtor, ct.contact_dob AS dob " +
      'FROM cases c ' +
      "LEFT JOIN case_relate cr ON cr.case_relate_case_id = c.case_id AND cr.case_relate_type = 'Primary' " +
      'LEFT JOIN contacts ct ON ct.contact_id = cr.case_relate_client_id ' +
      "WHERE c.case_type = 'Bankruptcy' AND c.case_file_date >= COALESCE(?, c.case_file_date) " +
      'ORDER BY c.case_file_date ASC',
    like_literal_with_denied_word:
      // 'password' only appears inside a string literal — must NOT trip the
      // column/table scans (they run over blanked literals).
      "SELECT log_id FROM log WHERE log_date >= '2026-01-01' AND log_subject LIKE '%password reset%' LIMIT 5",
  };

  for (const [name, sql] of Object.entries(ACCEPT)) {
    test(`accepts: ${name}`, () => {
      const why = refusal(sql);
      expect(why).toBeNull();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. STRUCTURAL allowlist (parser) — proven WITHOUT the word-scan belt, by
//    joining to a non-secret, non-allowlisted junk table.
// ───────────────────────────────────────────────────────────────────────────
describe('structural allowlist (parser)', () => {
  test('comma join to a non-allowlisted table is refused', () => {
    const r = validateSql('SELECT c.case_id FROM cases c, temp_contacts t LIMIT 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not available to reports/i);
    expect(r.error).toMatch(/temp_contacts/);
  });
  test('parenthesised table (not a subquery) is refused', () => {
    const r = validateSql('SELECT x.id FROM (temp_contacts x) LIMIT 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/temp_contacts/);
  });
  test('newline comma join is refused', () => {
    const r = validateSql('SELECT c.case_id FROM cases c,\ntemp_contacts LIMIT 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/temp_contacts/);
  });
  test('comment-hidden join target is refused', () => {
    const r = validateSql('SELECT c.case_id FROM cases c JOIN/* x */temp_contacts a ON 1=1 LIMIT 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/temp_contacts/);
  });
  test('schema-qualified table reference is refused', () => {
    const r = validateSql('SELECT c.case_id FROM lsg.cases c LIMIT 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/schema-qualified/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. STRAIGHT_JOIN.
// ───────────────────────────────────────────────────────────────────────────
describe('refuses STRAIGHT_JOIN', () => {
  test('as a join', () => {
    expect(validateSql('SELECT c.case_id FROM cases c STRAIGHT_JOIN contacts ct ON 1=1').ok).toBe(false);
  });
  test('as a select modifier', () => {
    expect(validateSql('SELECT STRAIGHT_JOIN case_id FROM cases').ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. STAR ban — SELECT-modifier stars that previously slipped through.
// ───────────────────────────────────────────────────────────────────────────
describe('star ban: SELECT-modifier stars', () => {
  const STARS = {
    plain: 'SELECT * FROM users',
    distinct: 'SELECT DISTINCT * FROM users',
    distinctrow: 'SELECT DISTINCTROW * FROM users',
    high_priority: 'SELECT HIGH_PRIORITY * FROM users',
    sql_no_cache: 'SELECT SQL_NO_CACHE * FROM users',
    sql_calc_found_rows: 'SELECT SQL_CALC_FOUND_ROWS * FROM users',
    sql_buffer_result: 'SELECT SQL_BUFFER_RESULT * FROM users',
    qualified: 'SELECT u.* FROM users u',
    comma_star: 'SELECT user, * FROM users',
  };
  for (const [name, sql] of Object.entries(STARS)) {
    test(`refuses: ${name}`, () => {
      expect(validateSql(sql).ok).toBe(false);
    });
  }
  test('still allows COUNT(*) and multiplication', () => {
    expect(ok('SELECT COUNT(*) FROM cases')).toBe(true);
    expect(ok('SELECT ROUND(100.0 * SUM(1), 1) FROM cases')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. DENY WORD-SCAN belt — secret/sensitive/backup names refused anywhere,
//    in any spelling or join position. These are the security-critical shapes
//    from the review: a read of a credential or content-tier table.
// ───────────────────────────────────────────────────────────────────────────
describe('deny word-scan belt', () => {
  const SHAPES = {
    plain_app_settings: 'SELECT setting_value FROM app_settings LIMIT 5',
    comma_join_secret: 'SELECT c.case_id, s.setting_value FROM cases c, app_settings s LIMIT 5',
    straight_join_secret: 'SELECT c.case_id FROM cases c JOIN email_ingest_sources k ON 1=1 LIMIT 5',
    paren_join_secret: 'SELECT c.case_id FROM cases c JOIN (app_settings x) ON 1=1 LIMIT 5',
    union_table_secret: 'SELECT case_id, case_type FROM cases UNION TABLE app_settings',
    backtick_table_secret: 'SELECT s.setting_value FROM `app_settings` s LIMIT 1',
    backtick_alias_disguise: 'SELECT cases.setting_value FROM `app_settings` cases LIMIT 1',
    db_qualified_backtick: 'SELECT c.setting_value FROM `lsg`.`app_settings` c LIMIT 1',
    lateral_subquery_secret:
      'SELECT c.case_id FROM cases c JOIN LATERAL (SELECT setting_value FROM app_settings) z ON 1 LIMIT 1',
    subselect_secret:
      'SELECT (SELECT GROUP_CONCAT(setting_value) FROM app_settings) AS x FROM cases LIMIT 1',
    users_password: 'SELECT u.p FROM cases c, users_password u LIMIT 1',
    jwt_audit: 'SELECT route FROM jwt_api_audit_log LIMIT 5',
    ai_calls: 'SELECT response FROM ai_calls LIMIT 5',
    comms_transcripts: 'SELECT body FROM comms_transcripts LIMIT 5',
    assistant_chats: 'SELECT id FROM assistant_chats LIMIT 5',
    assistant_chat_messages: 'SELECT body FROM assistant_chat_messages LIMIT 5',
    assistant_messages_joined:
      'SELECT c.case_id, m.body FROM cases c JOIN assistant_chat_messages m ON 1=1 LIMIT 5',
  };
  for (const [name, sql] of Object.entries(SHAPES)) {
    test(`refuses: ${name}`, () => {
      const r = validateSql(sql);
      expect(r.ok).toBe(false);
      // The belt runs before the structural allowlist, so a secret/sensitive
      // name always surfaces the belt's own message. Asserting it isolates the
      // belt: drop DENY_WORD_SET and these flip to the allowlist message (for
      // the shapes the parser also catches) or stop refusing (for the ones it
      // cannot), either way failing here.
      expect(r.error).toMatch(/may not be read by a report/);
    });
  }

  test('every secret/sensitive/manifest-denied table name is refused anywhere', () => {
    const names = [...SECRET_TABLES, ...SENSITIVE_TABLES, ...DENIED_TABLES];
    for (const t of names) {
      // Backtick-quote in case the name starts with a digit or is reserved.
      const r = validateSql(`SELECT 1 FROM cases c JOIN \`${t}\` z ON 1=1 LIMIT 1`);
      expect(r.ok).toBe(false);
    }
  });

  test('the assistant chat tables are in the belt by name', () => {
    const names = new Set([...SECRET_TABLES, ...SENSITIVE_TABLES, ...DENIED_TABLES].map((s) => s.toLowerCase()));
    expect(names.has('app_settings')).toBe(true);
    expect(names.has('email_ingest_sources')).toBe(true);
    expect(names.has('assistant_chats')).toBe(true);
    expect(names.has('assistant_chat_messages')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5b. `--` comment semantics. MySQL opens a `--` comment ONLY when the second
//     dash is followed by whitespace/control or end of statement; `1--x` is
//     `1 - -x` and READS x. Treating every `--` as a comment hid a denied
//     column from every scan (stripLiterals isDashCommentEnd + the firstWord
//     regex + sqlGuard.isReadOnlyQuery all mirror the rule).
// ───────────────────────────────────────────────────────────────────────────
describe('double-dash comment semantics', () => {
  test('refuses: 1--password_hash (minus-minus, not a comment)', () => {
    const r = validateSql('SELECT user, 1--password_hash\nAS x FROM users LIMIT 5');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/password_hash/);
  });
  test('refuses: a denied column after `--` with no space, mid-expression', () => {
    expect(validateSql('SELECT user_name, user--reset_token\nFROM users LIMIT 5').ok).toBe(false);
  });
  test('refuses: a `--x` head (not a comment, so the statement is not a SELECT)', () => {
    expect(validateSql('--x\nSELECT user_name FROM users').ok).toBe(false);
  });
  test('accepts: genuine comments still hide their contents', () => {
    expect(ok('SELECT user_name FROM users -- password_hash\nLIMIT 5')).toBe(true);
    expect(ok('SELECT user_name FROM users --\tpassword_hash\nLIMIT 5')).toBe(true);
    expect(ok('SELECT user_name FROM users --')).toBe(true);
    expect(ok('-- header note\nSELECT user_name FROM users')).toBe(true);
  });
  test('sqlGuard.isReadOnlyQuery: `--x` head is not stripped as a comment', () => {
    expect(isReadOnlyQuery('--x\nSELECT 1')).toBe(false);
    expect(isReadOnlyQuery('-- note\nSELECT 1')).toBe(true);
    expect(isReadOnlyQuery('--\nSELECT 1')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. sqlGuard tier: assistant chat tables are SENSITIVE (need sql.ro.sensitive).
// ───────────────────────────────────────────────────────────────────────────
describe('sqlGuard: assistant chat tables', () => {
  for (const t of ['assistant_chats', 'assistant_chat_messages']) {
    test(`${t} is withheld from an ordinary key`, () => {
      const d = deniedTable(`SELECT * FROM ${t}`, { sensitive: false });
      expect(d).toEqual({ table: t, tier: 'sensitive' });
    });
    test(`${t} is readable with sql.ro.sensitive`, () => {
      expect(deniedTable(`SELECT * FROM ${t}`, { sensitive: true })).toBeNull();
    });
  }
});
