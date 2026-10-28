// tests/caseyWorkflowSend.mysql.test.js
//
/**
 * Ruling 15 on REAL MySQL: the workflow send-step rules the A17.3/A17.4
 * normalizers apply — the literal-sender predicates (phone_lines.active = 1,
 * the utf8mb4_general_ci mailbox equality) and the placeholder rule's read of
 * EARLIER steps' stored config, which mysql2 returns as parsed JSON with its
 * keys re-ordered by MySQL on write.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3352/yc_sends1wf_test npx jest tests/caseyWorkflowSend.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates the
 * tables below in it, cloned line-by-line from ref/database.sql. Never point
 * it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['workflows', 'workflow_steps', 'phone_lines', 'email_credentials', 'app_settings'];

// Line-based extraction (column COMMENTs may hold ';'); constraint clauses
// naming a table outside TABLES are dropped — this suite tests predicates.
function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = [];
  const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

d('ruling 15 workflow send steps on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const EVID = [{ id: 'q1', label: 'Workflow 47 definition', rows: [{ workflow_id: 47, row_number: 1 }] }];
  const CITE = [{ query_id: 'q1', row_number: 1 }];
  const insert = (step, over = {}) => normalizeActionDraft(pool,
    { kind: 'workflow.step_insert.v1', workflow_id: 47, step, evidence: CITE, ...over }, EVID);
  const email = (from) => ({ type: 'internal_function', label: 'Mail',
    config: { function_name: 'send_email', params: { from, to: '{{client_email}}', subject: 'Filed', text: 'Hi' } } });
  const sms = (from) => ({ type: 'internal_function',
    config: { function_name: 'send_sms', params: { from, to: '{{phone}}', message: 'Hi' } } });

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await q('SET FOREIGN_KEY_CHECKS = 0');
    // Sibling twins on the same YC_TEST_MYSQL_URL (caseyWorkflowStart, optout)
    // create workflow_versions / workflow_executions / workflow_execution_steps
    // with FKs into workflows; left behind, they make the re-CREATE of
    // workflows fail ("Cannot add foreign key constraint") — drop them first.
    for (const t of ['workflow_execution_steps', 'workflow_executions', 'workflow_versions', ...[...TABLES].reverse()]) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters } = schemaFor(TABLES);
    for (const sql of creates) await q(sql);
    for (const sql of alters) await q(sql);

    await q("INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id) VALUES (6, '2484179800', 'quo', 'office', 1, 1), (7, '7344663328', 'ringcentral', 'RC-old', 0, 1)");
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name)
             VALUES (16, 'office@4lsg.com', 'h', 465, 'u', 'ENCv1:x', 'gmail', '4LSG Office')`);
    await q(`INSERT INTO app_settings (\`key\`, value, is_secret) VALUES ('email_automations', 'automations@4lsg.com', 0),
             ('sms_default_from', '2484179800', 0), ('vendor_token', 's3cr3t', 1)`);
    // Workflow 47's shape, live 2026-10-27: get_settings first, a send later.
    await q("INSERT INTO workflows (id, name, active, current_version, draft_version) VALUES (47, 'Notice of Filing -> client', 1, 1, NULL)");
    const steps = [
      { function_name: 'get_settings', params: { output_var: 'settings', keys: 'email_automations, sms_default_from' } },
      { function_name: 'get_setting', params: { output_var: 'automationsFrom', key: 'email_automations' } },
      { function_name: 'send_email', params: { text: 'Hi', subject: 'Filed', to: '{{client_email}}', from: '{{settings.email_automations}}',
        attachment_urls: ['https://storage.example.com/notice.pdf'] } },
    ];
    for (const [i, config] of steps.entries()) {
      await q("INSERT INTO workflow_steps (workflow_id, version, step_number, type, label, config) VALUES (47, 1, ?, 'internal_function', ?, ?)",
        [i + 1, `s${i + 1}`, JSON.stringify(config)]);
    }
  });
  afterAll(async () => { if (pool) await pool.end(); });

  test('the stored config comes back parsed and key-reordered — the shape the placeholder rule reads', async () => {
    const [row] = await q('SELECT config FROM workflow_steps WHERE workflow_id = 47 AND step_number = 1');
    expect(typeof row.config).toBe('object');
    expect(Object.keys(row.config.params)).toEqual(['keys', 'output_var']);   // re-ordered on write
  });

  test('literal senders on the real column types', async () => {
    expect((await insert(sms('2484179800'))).step.sender).toBe('office (2484179800)');
    await expect(insert(sms('7344663328'))).rejects.toThrow(/not an active firm phone line/);   // active = 0
    expect((await insert(email('Office@4LSG.com'))).step.sender).toBe('4LSG Office <office@4lsg.com>');   // general_ci
    await expect(insert(email('office@4lsg.co'))).rejects.toThrow(/not a configured firm mailbox/);
  });

  test('placeholder senders resolve through the real earlier steps, and only through them', async () => {
    const a = await insert(email('{{settings.email_automations}}'));
    expect(a.step.sender_note).toMatch(/"email_automations", read by step 1 \(get_settings\)/);
    expect((await insert(email('{{automationsFrom}}'))).step.sender_note).toMatch(/read by step 2 \(get_setting\)/);
    expect((await insert(sms('{{settings.sms_default_from}}'))).step.sender_note).toMatch(/"sms_default_from"/);
    await expect(insert(email('{{settings.email_default_from}}'))).rejects.toThrow(/would not resolve/);   // not read by step 1
    await expect(insert(email('{{settings.email_automations}}'), { step_number: 1 })).rejects.toThrow(/would not resolve/);
  });

  test('a NEW draft carries the canonical pair; get_settings keys are checked against the real app_settings', async () => {
    const make = (steps) => normalizeActionDraft(pool, { kind: 'workflow.draft.v1', name: `Pair ${Math.random()}`, steps, evidence: [] }, []);
    const gs = (keys) => ({ type: 'internal_function', config: { function_name: 'get_settings', params: { keys, output_var: 'settings' } } });
    const out = await make([gs('email_automations'), email('{{settings.email_automations}}')]);
    expect(out.steps[1].sender_note).toMatch(/read by step 1 \(get_settings\)/);
    await expect(make([email('{{settings.email_automations}}'), gs('email_automations')])).rejects.toThrow(/would not resolve/);
    await expect(make([gs('email_automations, vendor_token')])).rejects.toThrow(/vendor_token is a secret/);   // the row's is_secret
    // general_ci finds the row for another spelling; the exact compare refuses it, as get_settings does at run time.
    await expect(make([gs('Email_Automations')])).rejects.toThrow(/does not exist \(keys match exactly\)/);
    await expect(make([gs('nope_key')])).rejects.toThrow(/setting nope_key does not exist/);
  });

  test('edit: the real stored sender and attachment list are kept as stored; a change is held to the rule', async () => {
    const [row] = await q('SELECT config FROM workflow_steps WHERE workflow_id = 47 AND step_number = 3');
    const stored = row.config.params;
    const edit = (changes) => normalizeActionDraft(pool, { kind: 'workflow.step_edit.v1', workflow_id: 47, step_number: 3, changes, evidence: CITE }, EVID);
    const keep = await edit({ params: { ...stored, subject: 'Your case was filed' } });
    expect(keep.send).toMatchObject({ side_effect: 'external-send', recipient: '{{client_email}}' });
    expect(keep.send.sender).toMatch(/unchanged/);
    await expect(edit({ params: { ...stored, attachment_urls: ['https://other.example.com/x.pdf'] } })).rejects.toThrow(/does not author email attachments/);
    const moved = await edit({ params: { ...stored, from: '{{automationsFrom}}' } });
    expect(moved.send.sender_note).toMatch(/read by step 2/);
  });
});
