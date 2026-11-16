/**
 * tests/casesJudgeTrusteeColumns.test.js
 *
 * The Cases tab's optional Judge / Trustee columns (2026-11-16) — the
 * server half: caseService.listCases' sort whitelist. The columns' picker /
 * render half is pinned in tests/caseColumns.s3a.test.js (the shipped
 * model and picker functions in jsdom).
 *
 *   npx jest tests/casesJudgeTrusteeColumns.test.js
 *
 *   - sort_by c.case_judge / c.case_trustee order by the column with blanks
 *     LAST both ways (the caption precedent), ties broken by case_id;
 *   - both columns ride every row already (the CSV export reads them);
 *   - an unknown sort key still falls back to case_open_date.
 */

const caseService = require('../services/caseService');

function db() {
  const seen = [];
  return {
    seen,
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(s);
      if (/^SELECT COUNT\(\*\) AS total/.test(s)) return [[{ total: 0 }]];
      return [[]];
    },
  };
}
const listSql = (d) => d.seen.find((s) => /^SELECT c\.case_id,/.test(s));

test.each([
  ['c.case_judge', 'ASC'], ['c.case_judge', 'DESC'],
  ['c.case_trustee', 'ASC'], ['c.case_trustee', 'DESC'],
])('sort_by %s %s orders by the column, blanks last both ways, ties by case_id', async (key, dir) => {
  const d = db();
  await caseService.listCases(d, { sort_by: key, sort_dir: dir });
  expect(listSql(d)).toContain(`ORDER BY (NULLIF(${key}, '') IS NULL), ${key} ${dir}, c.case_id ${dir}`);
});

test('every row carries case_judge and case_trustee (the columns need no new select)', async () => {
  const d = db();
  await caseService.listCases(d, {});
  expect(listSql(d)).toContain('c.case_judge, c.case_trustee, c.case_chapter');
});

test('an unknown sort key still falls back to the open date', async () => {
  const d = db();
  await caseService.listCases(d, { sort_by: 'c.case_judge; DROP TABLE cases', sort_dir: 'ASC' });
  expect(listSql(d)).toContain('ORDER BY c.case_open_date ASC, c.case_id ASC');
});
