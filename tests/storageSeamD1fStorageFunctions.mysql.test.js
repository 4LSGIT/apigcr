// tests/storageSeamD1fStorageFunctions.mysql.test.js
//
/**
 * scripts/storageSeamD1fStorageFunctions.js on a REAL MySQL — the JSON column
 * semantics the scripted twin cannot show: CAST(? AS JSON) storing the rewrite,
 * MySQL re-ordering object keys on write (the read-back verify compares
 * canonically, never strings), JSON_UNQUOTE(JSON_EXTRACT()) guarding each
 * UPDATE, the five other columns' LIKE with an escaped underscore. Own
 * `*_test` database; workflow_steps and the five other tables cloned from
 * ref/database.sql; the live fixture's rows inserted; CHECK → --apply →
 * ALREADY APPLIED → a half-done resume.
 *
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_storage_replay_test npx jest tests/storageSeamD1fStorageFunctions.mysql.test.js
 */

'use strict';

const mysql = require('mysql2/promise');
const { schemaFor } = require('./helpers/commsArchiveSchema');
const mig = require('../scripts/storageSeamD1fStorageFunctions');
const FIXTURE = require('./fixtures/storageSeamD1f.before.json')   // the frozen BEFORE base (D1f-3);

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
const TABLES = ['workflow_steps', 'sequence_steps', 'trigger_rule_actions', 'scheduled_jobs', 'tools', 'workflow_versions'];
const quiet = { log: () => {} };

suite('D1f-2 definition migration on real MySQL', () => {
  let db;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    db = mysql.createPool({ uri: URL_, connectionLimit: 2, timezone: 'Z' });
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
    const { creates, alters } = schemaFor(TABLES);
    if (creates.length !== TABLES.length) throw new Error(`schemaFor found ${creates.length} of ${TABLES.length}`);
    for (const s of creates) await q(s);
    for (const s of alters) await q(s);
  });
  afterAll(async () => { if (db) { for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``); await db.end(); } });

  async function seed() {
    await q('TRUNCATE TABLE workflow_steps');
    for (const s of FIXTURE.steps) {
      const config = { function_name: s.function_name, params: s.params, ...(s.step_number === 9 ? { set_vars: { dbx_path: '{{this.output.metadata.path_display}}' } } : {}) };
      await q('INSERT INTO workflow_steps (id, workflow_id, step_number, type, label, config, version) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)',
        [s.step_id, s.workflow_id, s.step_number, 'internal_function', s.label, JSON.stringify(config), s.version]);
    }
    // a non-function mention the script must ignore, as live (wf 48 step 2 reads a dropbox_ setting key)
    await q('INSERT INTO workflow_steps (id, workflow_id, step_number, type, label, config, version) VALUES (579, 48, 2, ?, ?, CAST(? AS JSON), 1)',
      ['internal_function', 'Unsorted path', JSON.stringify({ function_name: 'get_setting', params: { key: 'dropbox_unsorted_forms_path', output_var: 'unsorted_path' } })]);
  }

  test('CHECK → --apply → verified read-back on the real JSON column → ALREADY APPLIED → resume', async () => {
    await seed();
    const conn = await db.getConnection();
    try {
      const check = await mig.run(conn, quiet);
      expect(check.line).toMatch(/^CHECK OK — GO\. 21 row\(s\) to rewrite/);
      expect((await q("SELECT COUNT(*) AS n FROM workflow_steps WHERE JSON_UNQUOTE(JSON_EXTRACT(config,'$.function_name')) LIKE 'storage\\_%'"))[0].n).toBe(0);

      const applied = await mig.run(conn, { apply: true, ...quiet });
      expect(applied).toEqual({ ok: true, applied: 21, line: expect.stringMatching(/^APPLIED — GO\. 21 row\(s\) rewritten and verified/) });
      const after = await q("SELECT id, config FROM workflow_steps ORDER BY id");
      const cfg = (id) => { const r = after.find((x) => x.id === id); return typeof r.config === 'string' ? JSON.parse(r.config) : r.config; };
      expect(cfg(206)).toEqual({ function_name: 'storage_move', params: { to_path: '{{active_path}}', from_human_link: '{{case_dropbox}}' } });
      expect(cfg(585)).toEqual({ function_name: 'storage_ensure_folder', params: { path: '{{unsorted_path}}', with_link: true } });
      expect(cfg(616).function_name).toBe('storage_import_url');
      expect(cfg(616).params).toMatchObject({ human_link: '{{dest_link}}', timeout_ms: 90000, wait: true, case_id: '{{jf_case_id}}' });
      expect(cfg(616).set_vars).toEqual({ dbx_path: '{{this.output.metadata.path_display}}' });
      expect(cfg(579)).toEqual({ function_name: 'get_setting', params: { key: 'dropbox_unsorted_forms_path', output_var: 'unsorted_path' } });
      expect((await q("SELECT COUNT(*) AS n FROM workflow_steps WHERE config LIKE '%dropbox\\\\_%'"))[0].n).toBe(1);   // the setting key only

      const again = await mig.run(conn, { apply: true, ...quiet });
      expect(again.line).toMatch(/^ALREADY APPLIED — GO\. 21 row\(s\)/);

      // a half-done run: put one row back, resume rewrites just it
      await q("UPDATE workflow_steps SET config = CAST(? AS JSON) WHERE id = 206", [JSON.stringify({ function_name: 'dropbox_move', params: { to_path: '{{active_path}}', from_shared_link: '{{case_dropbox}}' } })]);
      const resumed = await mig.run(conn, { apply: true, ...quiet });
      expect(resumed).toEqual({ ok: true, applied: 1, line: expect.stringMatching(/^APPLIED — GO\. 1 row\(s\)/) });
      expect(cfg(206)).toEqual(cfg(206));
      expect((await q("SELECT JSON_UNQUOTE(JSON_EXTRACT(config,'$.function_name')) AS fn FROM workflow_steps WHERE id = 206"))[0].fn).toBe('storage_move');
    } finally { conn.release(); }
  });

  test('a dropbox_ function name in another config column is NO-GO; the LIKE escapes its underscore', async () => {
    await seed();
    await q("INSERT INTO trigger_rule_actions (rule_id, action_type, config) VALUES (1, 'internal_function', CAST(? AS JSON))", [JSON.stringify({ function_name: 'dropbox_move', params: {} })]).catch(async () => {
      // the table's columns may differ by vintage; fall back to the minimal shape the script reads
      const cols = await q("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trigger_rule_actions'");
      throw new Error(`insert a trigger_rule_actions row by hand for this twin: columns ${cols.map((x) => x.c).join(', ')}`);
    });
    const conn = await db.getConnection();
    try {
      const r = await mig.run(conn, { apply: true, ...quiet });
      expect(r.ok).toBe(false); expect(r.line).toMatch(/outside workflow_steps \(trigger_rule_actions\.config: 1\)/);
      expect((await q("SELECT COUNT(*) AS n FROM workflow_steps WHERE config LIKE '%dropbox\\\\_%'"))[0].n).toBe(22);
    } finally { conn.release(); await q('DELETE FROM trigger_rule_actions'); }
  });
});
