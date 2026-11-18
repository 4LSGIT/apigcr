// tests/storageSeamD3d1CaseFolderLink.test.js
//
/**
 * storage-seam D3d-1 — the retiring cases.case_dropbox gets its neutral successor.
 *   - query_db's VIRTUAL column `cases.case_folder_link` (and `<alias>.case_folder_link`
 *     on a cases alias): compiled to a correlated subquery over entity_folders for
 *     the configured provider, its param FIRST (before the where params), its output
 *     key the bare name; a real column next to it is untouched; the name on another
 *     table is not virtual; a where on it is refused by MySQL, not rewritten here.
 *   - scripts/storageSeamD3d1CaseFolderLink.js over a scripted connection: the
 *     frozen base (nine rows, thirteen occurrences — every one the same token),
 *     migrateConfig's rename and nothing else, CHECK / --apply (guarded UPDATE,
 *     re-read verify) / ALREADY APPLIED / the NO-GOs (drift, a missing row, a
 *     row outside the fixture naming the token, a guard skip).
 */

'use strict';

const fs = require('fs');
const mig = require('../scripts/storageSeamD3d1CaseFolderLink');
const dbFns = require('../lib/internal_functions/db');

const FX = JSON.parse(fs.readFileSync(mig.BEFORE, 'utf8'));
const quiet = { log: () => {} };

describe('query_db: the virtual column', () => {
  const capture = () => { const c = { sql: null, params: null }; c.db = { query: async (sql, params) => { c.sql = sql; c.params = params; return [[{ case_id: 'C1', case_folder_link: 'https://l/1' }]]; } }; return c; };
  test('cases.case_folder_link compiles to the binding subquery for the configured provider; its param rides FIRST; the output key is the bare name', async () => {
    const c = capture();
    const out = await dbFns.query_db({ select: ['cases.case_id', 'cases.case_folder_link'], from: 'cases', where: [{ column: 'cases.case_id', op: '=', value: 'C1' }], format: 'first' }, c.db);
    expect(c.sql).toBe("SELECT `cases`.`case_id`, (SELECT e.`human_link` FROM `entity_folders` e WHERE e.`entity_kind` = 'case' AND e.`source` = ? AND e.`entity_id` = `cases`.`case_id` LIMIT 1) AS `case_folder_link` FROM `cases` WHERE `cases`.`case_id` = ? LIMIT 100");
    expect(c.params).toEqual(['dropbox', 'C1']);
    expect(out.output).toEqual({ case_id: 'C1', case_folder_link: 'https://l/1' });
  });
  test('on a cases alias through a join (wf 32 step 14\'s shape) the subquery correlates on the alias; the name on another table stays a real column', async () => {
    const c = capture();
    await dbFns.query_db({ select: ['c.case_id', 'c.case_folder_link', 'cr.case_relate_id'], from: 'cases', join: [{ table: 'case_relate', alias: 'cr', type: 'inner', on: { left: 'c.case_id', right: 'cr.case_relate_case_id' } }].map((j) => j), where: [{ column: 'cr.case_relate_client_id', op: '=', value: 7 }] }, c.db).catch(() => {});
    // `c` is not an alias of `from` here (query_db aliases only joins) — so use the real table name
    const c2 = capture();
    await dbFns.query_db({ select: ['cases.case_id', 'cases.case_folder_link', 'cr.case_relate_id'], from: 'cases', join: [{ table: 'case_relate', alias: 'cr', type: 'inner', on: { left: 'cases.case_id', right: 'cr.case_relate_case_id' } }], where: [{ column: 'cr.case_relate_client_id', op: '=', value: 7 }], order_by: [{ column: 'cr.case_relate_id', dir: 'desc' }], limit: 50 }, c2.db);
    expect(c2.sql).toContain("AND e.`entity_id` = `cases`.`case_id` LIMIT 1) AS `case_folder_link`, `cr`.`case_relate_id` FROM `cases` INNER JOIN `case_relate` `cr` ON");
    expect(c2.params).toEqual(['dropbox', 7]);
    const c3 = capture();
    await dbFns.query_db({ select: ['case_relate.case_folder_link'], from: 'case_relate' }, c3.db);
    expect(c3.sql).toBe('SELECT `case_relate`.`case_folder_link` FROM `case_relate` LIMIT 100');   // not virtual on another table: a real-column reference, MySQL's error if none
    expect(c3.params).toEqual([]);
  });
});

describe('the migration script', () => {
  test('the frozen base: nine rows, thirteen occurrences, and migrateConfig changes the token and nothing else', () => {
    expect(FX.rows.map((r) => r.id)).toEqual([203, 205, 206, 222, 288, 289, 758, 760, 761]);
    let occurrences = 0;
    for (const r of FX.rows) {
      const before = JSON.stringify(r.config);
      const after = JSON.stringify(mig.migrateConfig(r.config));
      occurrences += (before.match(/case_dropbox/g) || []).length;
      expect(after).not.toMatch(/case_dropbox/);
      expect(after.replace(/case_folder_link/g, 'case_dropbox')).toBe(before);   // the rename is the whole diff
    }
    expect(occurrences).toBe(13);
    expect(mig.migrateConfig(FX.rows.find((r) => r.id === 206).config)).toEqual({ params: { to_path: '{{active_path}}', from_human_link: '{{case_folder_link}}' }, function_name: 'storage_move' });
    expect(mig.migrateConfig(FX.rows.find((r) => r.id === 203).config).params.select).toContain('cases.case_folder_link');
    expect(mig.migrateConfig(FX.rows.find((r) => r.id === 203).config).set_vars.case_folder_link).toBe('{{this.output.case_folder_link}}');
    expect(JSON.parse(fs.readFileSync(mig.RECORD, 'utf8')).rows).toEqual(FX.rows.map((r) => r.id));
  });

  function conn({ live = FX.rows.map((r) => ({ ...r, config: JSON.stringify(r.config) })), others = 0, guardSkip = [] } = {}) {
    const calls = [];
    let rows = live.map((r) => ({ ...r }));
    return {
      calls,
      get rows() { return rows; },
      async query(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        calls.push([s, params]);
        if (/^SET SESSION lock_wait_timeout = 5$/.test(s)) return [{}];
        if (/^SELECT id, workflow_id, version, step_number, type, config FROM workflow_steps WHERE id IN \(\?\)/.test(s)) return [rows.filter((r) => params[0].includes(Number(r.id))).map((r) => ({ ...r }))];
        if (/^SELECT COUNT\(\*\) AS n FROM workflow_steps WHERE config LIKE/.test(s)) return [[{ n: others }]];
        if (/^UPDATE workflow_steps SET config = CAST\(\? AS JSON\) WHERE id = \? AND config LIKE/.test(s)) {
          const r = rows.find((x) => Number(x.id) === Number(params[1]));
          if (!r || guardSkip.includes(Number(params[1])) || !/case_dropbox/.test(r.config)) return [{ affectedRows: 0 }];
          r.config = JSON.stringify(JSON.parse(params[0]));   // MySQL re-serialises; key order is not promised
          return [{ affectedRows: 1 }];
        }
        throw new Error('unexpected SQL: ' + s.slice(0, 90));
      },
    };
  }
  const verbs = (c) => c.calls.map(([s]) => s.split(' ')[0]);

  test('CHECK on the base: GO naming the nine rows; nothing written', async () => {
    const c = conn();
    const r = await mig.run(c, quiet);
    expect(r).toMatchObject({ ok: true, migrated: 0, line: expect.stringMatching(/^CHECK OK — GO\. 9 row\(s\) to rewrite \(wf 28 v1 s1, wf 28 v1 s3, wf 28 v1 s4, wf 1 v1 s7, wf 32 v1 s14, wf 32 v1 s15, wf 28 v2 s1, wf 28 v2 s3, wf 28 v2 s4\), 0 already done/) });
    expect(verbs(c)).toEqual(['SELECT', 'SELECT']);
  });
  test('--apply: lock_wait, nine guarded UPDATEs, the re-read verify → GO; a second run is ALREADY APPLIED', async () => {
    const c = conn();
    const r = await mig.run(c, { apply: true, ...quiet });
    expect(r).toMatchObject({ ok: true, migrated: 9, line: expect.stringMatching(/^APPLIED — GO\. 9 row\(s\) rewritten, all 9 verified in the migrated form/) });
    expect(verbs(c).filter((v) => v === 'UPDATE')).toHaveLength(9);
    expect(c.rows.every((x) => !/case_dropbox/.test(x.config) && /case_folder_link/.test(x.config))).toBe(true);
    const again = await mig.run(c, { apply: true, ...quiet });
    expect(again).toMatchObject({ ok: true, migrated: 0, line: expect.stringMatching(/^ALREADY APPLIED — GO\. All 9 rows name case_folder_link/) });
  });
  test('resumable: rows already in the migrated form count as done; the rest are rewritten', async () => {
    const live = FX.rows.map((r) => ({ ...r, config: JSON.stringify(r.id === 206 || r.id === 761 ? mig.migrateConfig(r.config) : r.config) }));
    const c = conn({ live });
    expect((await mig.run(c, quiet)).line).toMatch(/7 row\(s\) to rewrite .* 2 already done/);
    expect(await mig.run(c, { apply: true, ...quiet })).toMatchObject({ ok: true, migrated: 7 });
  });
  test('NO-GOs: drift in one row; a missing row; a row outside the fixture naming the token; a guard skip during --apply — none rewrites anything else', async () => {
    const drift = FX.rows.map((r) => ({ ...r, config: JSON.stringify(r.id === 288 ? { ...r.config, params: { ...r.config.params, limit: 60 } } : r.config) }));
    const c1 = conn({ live: drift });
    expect(await mig.run(c1, { apply: true, ...quiet })).toMatchObject({ ok: false, migrated: 0, line: expect.stringMatching(/^NO-GO — row 288 \(wf 32 v1 step 14\): live config is neither the frozen base nor its migrated form/) });
    expect(verbs(c1)).toEqual(['SELECT', 'SELECT']);
    const c2 = conn({ live: FX.rows.filter((r) => r.id !== 222).map((r) => ({ ...r, config: JSON.stringify(r.config) })) });
    expect((await mig.run(c2, { apply: true, ...quiet })).line).toMatch(/^NO-GO — row 222 missing/);
    const c3 = conn({ others: 1 });
    expect((await mig.run(c3, { apply: true, ...quiet })).line).toMatch(/^NO-GO — 1 row\(s\) outside the fixture name case_dropbox \(re-freeze the fixture\)/);
    const c4 = conn({ guardSkip: [205] });
    const r4 = await mig.run(c4, { apply: true, ...quiet });
    expect(r4).toMatchObject({ ok: false, migrated: 8, line: expect.stringMatching(/1 still pending.*1 skipped by the guard \(changed meanwhile: 205\)/) });
  });
});
