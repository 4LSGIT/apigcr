/**
 * Tests for logService._buildCaseLogWhere — the empty-sentinel fix.
 *
 * The bug: the helper used to substitute '' for NULL case_number /
 * case_number_full to keep a fixed three-placeholder IN-list. But
 * createLogEntry writes log_link = '' for any row created without a link
 * (log_link is varchar(30) NOT NULL), and those rows carry
 * log_link_type IS NULL — so they matched the `log_link IN (?, ?, ?)`
 * case-scope clause on every case with a blank case number. In production
 * that was 46 phantom rows appearing on 856 of 1027 case views.
 *
 * The contract these tests pin down:
 *   - blanks (null AND empty-string) are FILTERED from the IN-list, never
 *     substituted, and placeholders are generated to match;
 *   - no '' ever reaches params for a found case;
 *   - case_id is always present, so the list is never empty (no `IN ()`);
 *   - a blank caseId in the not-found fallback matches NOTHING, not
 *     everything;
 *   - the related-contact merge gating is undisturbed by the refactor.
 *
 * db.query is mocked — no live DB.
 */
/*
npm install --save-dev jest

# logService requires nothing (verified: zero require() calls in the module),
# so unlike internal_functions.meta.test.js there is no credentialCrypto in
# the graph and no CREDENTIALS_ENCRYPTION_KEY export is needed here.
npx jest tests/logService.buildCaseLogWhere.test.js

npm uninstall --save-dev jest
*/
const logService = require('../services/logService');

const { _buildCaseLogWhere } = logService;

/**
 * Mock mysql2 pool. _buildCaseLogWhere makes at most two queries:
 *   1. SELECT ... FROM cases WHERE case_id = ?   → [[caseRow]] destructure
 *   2. SELECT ... FROM case_relate ...           → [relRows]  destructure
 * Both are destructured as [rows], so each mock resolution returns [rows].
 *
 * @param {object|null} caseRow    row the cases lookup resolves to (null = not found)
 * @param {number[]}    relateIds  contact ids the case_relate lookup resolves to
 */
function mockDb(caseRow, relateIds = []) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM cases/i.test(sql)) {
        return [caseRow ? [caseRow] : []];
      }
      if (/FROM case_relate/i.test(sql)) {
        return [relateIds.map(id => ({ case_relate_client_id: id }))];
      }
      throw new Error(`unexpected query in mock: ${sql}`);
    })
  };
}

/** Pull the two case-scope clauses out of the fragment, in order. */
function caseScopeClauses(fragment) {
  return fragment
    .split(/\bOR\b/)
    .map(s => s.trim())
    .filter(s => /log_link_type = 'case'|log_link_type IS NULL/.test(s));
}

/** Count '?' placeholders in a string. */
const countPlaceholders = s => (s.match(/\?/g) || []).length;

describe('_buildCaseLogWhere — blank case identifiers are filtered, not substituted', () => {

  test('NULL case_number + NULL case_number_full → one placeholder per clause, no empty string in params', async () => {
    const db = mockDb({
      case_id: '0B4lYSQV',
      case_number: null,
      case_number_full: null
    });

    const { whereFragment, params } = await _buildCaseLogWhere(db, '0B4lYSQV', { relateFilter: 'none' });

    const clauses = caseScopeClauses(whereFragment);
    expect(clauses).toHaveLength(2);
    expect(countPlaceholders(clauses[0])).toBe(1);   // log_link_id IN (?)
    expect(countPlaceholders(clauses[1])).toBe(1);   // log_link    IN (?)

    // Two clauses × one identifier = two params, both the case_id.
    expect(params).toEqual(['0B4lYSQV', '0B4lYSQV']);

    // The regression that mattered: no blank may reach the IN-list.
    expect(params).not.toContain('');
    expect(params.every(p => p !== '' && p != null)).toBe(true);
  });

  test("empty-string case_number is treated exactly like NULL", async () => {
    const db = mockDb({
      case_id: 'aB3dEf7h',
      case_number: '',              // 3 such rows exist in prod
      case_number_full: null
    });

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'aB3dEf7h', { relateFilter: 'none' });

    const clauses = caseScopeClauses(whereFragment);
    expect(countPlaceholders(clauses[0])).toBe(1);
    expect(countPlaceholders(clauses[1])).toBe(1);
    expect(params).toEqual(['aB3dEf7h', 'aB3dEf7h']);
    expect(params).not.toContain('');
  });

  test('empty-string case_number_full is also filtered', async () => {
    const db = mockDb({
      case_id: 'zZ9yX8w7',
      case_number: '24-48600',
      case_number_full: ''
    });

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'zZ9yX8w7', { relateFilter: 'none' });

    const clauses = caseScopeClauses(whereFragment);
    expect(countPlaceholders(clauses[0])).toBe(2);
    expect(countPlaceholders(clauses[1])).toBe(2);
    expect(params).toEqual(['zZ9yX8w7', '24-48600', 'zZ9yX8w7', '24-48600']);
    expect(params).not.toContain('');
  });

  test('fully populated row → three placeholders per clause, ordered case_id, case_number, case_number_full', async () => {
    const db = mockDb({
      case_id: 'cM8YEx2y',
      case_number: '24-48600',
      case_number_full: '24-48600-tjt'
    });

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'cM8YEx2y', { relateFilter: 'none' });

    const clauses = caseScopeClauses(whereFragment);
    expect(clauses).toHaveLength(2);
    expect(countPlaceholders(clauses[0])).toBe(3);
    expect(countPlaceholders(clauses[1])).toBe(3);

    expect(params).toEqual([
      'cM8YEx2y', '24-48600', '24-48600-tjt',   // log_link_id clause
      'cM8YEx2y', '24-48600', '24-48600-tjt'    // log_link clause
    ]);
  });

  test('non-string identifiers are stringified (params stay varchar-comparable)', async () => {
    const db = mockDb({
      case_id: 'nUm3r1c0',
      case_number: 2448600,          // numeric column value, hypothetically
      case_number_full: null
    });

    const { params } = await _buildCaseLogWhere(db, 'nUm3r1c0', { relateFilter: 'none' });

    expect(params).toEqual(['nUm3r1c0', '2448600', 'nUm3r1c0', '2448600']);
    expect(params.every(p => typeof p === 'string')).toBe(true);
  });

  test('no IN () is ever emitted — case_id alone keeps the list non-empty', async () => {
    const db = mockDb({ case_id: 'oNlY1dOk', case_number: null, case_number_full: null });
    const { whereFragment } = await _buildCaseLogWhere(db, 'oNlY1dOk', { relateFilter: 'none' });
    expect(whereFragment).not.toMatch(/IN\s*\(\s*\)/);
  });
});

describe('_buildCaseLogWhere — not-found fallback', () => {

  test('case not found + valid caseId → two-clause fallback, params [caseId, caseId]', async () => {
    const db = mockDb(null);

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'nOsUcH01');

    expect(whereFragment).toContain(`l.log_link_type = 'case' AND l.log_link_id = ?`);
    expect(whereFragment).toContain(`l.log_link_type IS NULL  AND l.log_link    = ?`);
    expect(params).toEqual(['nOsUcH01', 'nOsUcH01']);
  });

  test("case not found + '' caseId → (1 = 0), empty params", async () => {
    const db = mockDb(null);

    const { whereFragment, params } = await _buildCaseLogWhere(db, '');

    expect(whereFragment).toBe('(1 = 0)');
    expect(params).toEqual([]);
    // Must NOT fall through to `log_link = ''`, which matches every
    // unlinked log row.
    expect(whereFragment).not.toContain('log_link');
  });

  test('case not found + null caseId → (1 = 0), empty params', async () => {
    const db = mockDb(null);

    const { whereFragment, params } = await _buildCaseLogWhere(db, null);

    expect(whereFragment).toBe('(1 = 0)');
    expect(params).toEqual([]);
  });

  test('blank-caseId fallback never queries case_relate', async () => {
    const db = mockDb(null);
    await _buildCaseLogWhere(db, '');
    expect(db.calls.some(c => /case_relate/i.test(c.sql))).toBe(false);
  });
});

describe('_buildCaseLogWhere — related-contact merge gating (regression guard)', () => {

  test("relateFilter 'none' with a populated row → no contact/phone/email clauses", async () => {
    const db = mockDb(
      { case_id: 'cM8YEx2y', case_number: '24-48600', case_number_full: '24-48600-tjt' },
      [101, 202]   // would be merged in if the filter were honored wrongly
    );

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'cM8YEx2y', { relateFilter: 'none' });

    expect(whereFragment).not.toContain(`log_link_type = 'contact'`);
    expect(whereFragment).not.toContain(`log_link_type = 'phone'`);
    expect(whereFragment).not.toContain(`log_link_type = 'email'`);
    expect(whereFragment).not.toContain('contact_phones');
    expect(whereFragment).not.toContain('contact_emails');

    // Case-scope only: 2 clauses × 3 identifiers.
    expect(params).toHaveLength(6);

    // And it must not even ask case_relate.
    expect(db.calls.some(c => /case_relate/i.test(c.sql))).toBe(false);
  });

  test("relateFilter 'default' merges related contacts and filters case_relate_type", async () => {
    const db = mockDb(
      { case_id: 'cM8YEx2y', case_number: null, case_number_full: null },
      [101]
    );

    const { whereFragment, params } = await _buildCaseLogWhere(db, 'cM8YEx2y');

    expect(whereFragment).toContain(`log_link_type = 'contact'`);
    expect(whereFragment).toContain('contact_phones');
    expect(whereFragment).toContain('contact_emails');

    const relateCall = db.calls.find(c => /case_relate/i.test(c.sql));
    expect(relateCall.sql).toContain(`case_relate_type IN ('Primary','Secondary','Other')`);

    // 2 case-scope params (case_id twice, blanks filtered)
    // + 4 per related contact.
    expect(params).toEqual([
      'cM8YEx2y', 'cM8YEx2y',
      '101', '101', 101, 101
    ]);
    expect(params).not.toContain('');
  });

  test("relateFilter 'all' drops the case_relate_type filter", async () => {
    const db = mockDb(
      { case_id: 'cM8YEx2y', case_number: null, case_number_full: null },
      [101]
    );

    await _buildCaseLogWhere(db, 'cM8YEx2y', { relateFilter: 'all' });

    const relateCall = db.calls.find(c => /case_relate/i.test(c.sql));
    expect(relateCall.sql).not.toContain('case_relate_type');
  });
});

describe('_buildCaseLogWhere — caller contract unchanged', () => {

  test('always returns { whereFragment: string, params: array }', async () => {
    const rows = [
      { case_id: 'aaaaaaaa', case_number: null,   case_number_full: null },
      { case_id: 'bbbbbbbb', case_number: '1-2',  case_number_full: '1-2-x' },
      null
    ];
    for (const row of rows) {
      const db = mockDb(row, [7]);
      const out = await _buildCaseLogWhere(db, 'aaaaaaaa');
      expect(typeof out.whereFragment).toBe('string');
      expect(Array.isArray(out.params)).toBe(true);
      // Placeholder count must equal param count, or mysql2 throws at bind.
      expect(countPlaceholders(out.whereFragment)).toBe(out.params.length);
    }
  });
});