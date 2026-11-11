// tests/caseyFormTemplates.mysql.test.js
//
/**
 * A12.4 on REAL MySQL: the Casey form template cards
 * (services/assistantService.js normalizeFormTemplate*) and the
 * form.template.state read beside the REAL routes they drive —
 * routes/api.formTemplates.js over the real formTemplateService (publish,
 * visibility, version restore, delete) — under the production sql_mode, plus
 * the browser's click-time re-reads, request builder and answer check
 * (extracted from public/assistant.html) over the REAL answers of
 * GET /api/form-templates/:id and …/versions. The submit-draft refusal of a
 * draft left on the old version is the real routes/api.forms.js route.
 *
 * Stubbed at one boundary: the auth gate (a staff JWT, user 6, whose roles
 * each test sets — the routes' authzOf reads them through the real
 * lib/auth.formDev predicate). The card reads the same user's roles from the
 * real users row.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a124_test npx jest tests/caseyFormTemplates.mysql.test.js --runInBand
 * The database name must end in _test and the port must not be 3306 (the
 * production proxy). This suite DROPS and recreates its tables, cloned from
 * ref/database.sql (a clause referencing a table outside the list is
 * dropped), in its before-hook AND its after-hook, with any sibling-built
 * child of ours. Give it its own _test DB (it shares tables with the A12
 * twins).
 *
 * WHAT IS LOCKED
 *   - PUBLISH: the card's diff, version and bump are what the route did — the
 *     published definition is now exactly the draft the card diffed, the
 *     version the card named, a new version row; the drafts the card named as
 *     left on the old version are then refused by the real submit-draft route
 *     (409 naming both versions); the browser's answer check keeps the
 *     template id as the receipt; the re-read after the publish refuses.
 *   - VISIBILITY: a roleless user — the card refuses and the route 403s,
 *     nothing moves; a form_dev user — the card, the re-read, the POST lands
 *     "public"; a roleless user takes it down (no role needed), card + route.
 *   - RESTORE: the draft becomes the version's definition exactly; the
 *     published definition and version are untouched; a version of another
 *     template — the card refuses and the route 404s, nothing moves.
 *   - DELETE: a never-published, unused template is gone with the route;
 *     a published one and one with a draft — the card refuses and the route
 *     400s, nothing moves.
 *   - THE RE-READ after hand edits: a draft edit, a visibility edit and an
 *     appended version each refuse at the card's precheck.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const AUTH = { roles: [] };
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: AUTH.roles }; next(); });
const { normalizeActionDraft, formTemplateStateRead } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// The template tables, the submit route's first reads, the route's audit log,
// and every table A7's caseFieldsReaders scans (the card's stored-reader read).
const TABLES = ['users', 'cases', 'workflows', 'form_templates', 'form_template_versions', 'form_submissions', 'admin_audit_log',
  'report_definitions', 'portal_cards', 'pipeline_stages', 'pipeline_stage_requirements', 'sequence_templates', 'sequence_steps',
  'workflow_steps', 'email_ingest_rule_actions', 'phone_ingest_rule_actions'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = [];
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

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body == null ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// The browser's half, extracted verbatim from the page and run against an
// `api` that calls the real routes (throwing as the shell's apiSend does).
function fnSrc(html, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index - (html.slice(0, m.index).endsWith('async ') ? 6 : 0), i + 1);
  }
  throw new Error(`${name} unbalanced`);
}
function browserChecks(api) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const consts = ['FORM_TEMPLATE_VISIBILITIES'].map((n) => { const at = html.indexOf(`const ${n} =`); return html.slice(at, html.indexOf(';\n', at) + 1); });
  const names = ['formCanonical', 'formDataHash', 'formIso', 'formTemplateName', 'formTemplateRequest', 'formTemplatePrecheck', 'formTemplateResult', 'formTemplateKnownOutcome'];
  const src = `${consts.join('\n')}\n${names.map((n) => fnSrc(html, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('api', 'crypto', 'TextEncoder', src)(api, crypto.webcrypto, TextEncoder); // eslint-disable-line no-new-func
}

const CASE = 'A124CASE';
const field = (name, type, label, extra = {}) => ({ name, type, label, ...extra });
const PUB = { onSubmit: { workflows: [{ id: 41 }] }, sections: [{ title: 'Case', rows: [{ fields: [
  field('trustee', 'text', 'Trustee', { required: true }), field('chapter', 'select', 'Chapter', { options: ['7', '13'] }), field('notes', 'textarea', 'Notes'),
] }] }] };
const DRAFT = { onSubmit: { workflows: [{ id: 41 }, { id: 42 }] }, sections: [{ title: 'Case', rows: [{ fields: [
  field('trustee', 'text', 'Trustee name'), field('chapter', 'select', 'Chapter', { options: ['7', '11', '13'] }), field('hearing', 'date', 'Hearing'),
] }] }] };
const V1 = { sections: [{ title: 'Old', rows: [{ fields: [field('trustee', 'text', 'Trustee')] }] }] };
const NEW_DEF = { sections: [{ title: 'New', rows: [{ fields: [field('a', 'text', 'A')] }] }] };
// Key-order-insensitive comparison: MySQL re-orders JSON object keys on write.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

d('the Casey form template cards on real MySQL (A12.4)', () => {
  let pool; let app; let browser;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  async function seed() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, roles)
             VALUES (6, 'fred', 'Fred', 'Fred', 'F', 'FF', 'authorized', 0, 'staff')`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, custom) VALUES (?, '26-24001', 'Bankruptcy', '{}')`, [CASE]);
    await q(`INSERT INTO workflows (id, active, name, description, current_version) VALUES (41, 1, 'Notify ops', '', 1), (42, 1, 'New intake', '', 1)`);
    // 1: published v2 (history: v1 then v2), its draft edited since.
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, published_at, visibility, updated_at)
             VALUES (1, 'a124_sheet', 'Case Sheet', 'case', 2, ?, ?, '2026-11-01 09:00:00', 'internal', NOW() - INTERVAL 1 MINUTE)`, [JSON.stringify(PUB), JSON.stringify(DRAFT)]);
    await q(`INSERT INTO form_template_versions (id, template_id, schema_version, definition, published_by, published_at)
             VALUES (10, 1, 1, ?, 6, '2026-10-01 09:00:00'), (11, 1, 2, ?, 6, '2026-11-01 09:00:00')`, [JSON.stringify(V1), JSON.stringify(PUB)]);
    // 2: another published template, with a version of its own.
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition, published_at)
             VALUES (2, 'a124_other', 'Other', 'case', 1, ?, ?, '2026-11-01 09:00:00')`, [JSON.stringify(V1), JSON.stringify(V1)]);
    await q(`INSERT INTO form_template_versions (id, template_id, schema_version, definition, published_by) VALUES (20, 2, 1, ?, 6)`, [JSON.stringify(V1)]);
    // 3: never published, unused. 4: never published, with a draft saved against it.
    await q(`INSERT INTO form_templates (id, form_key, title, link_type, schema_version, definition, draft_definition)
             VALUES (3, 'a124_new', 'New one', 'case', 1, NULL, ?), (4, 'a124_used', 'Used one', 'case', 1, NULL, ?)`, [JSON.stringify(NEW_DEF), JSON.stringify(NEW_DEF)]);
    await q(`INSERT INTO form_submissions (form_key, link_type, link_id, status, schema_version, data, submitted_by) VALUES ('a124_used', 'case', ?, 'draft', 1, '{}', 6)`, [CASE]);
  }

  const read = async (formKey) => ({ id: 'q1', kind: 'form.template.state', purpose: 'the template', rows: (await formTemplateStateRead(pool, formKey)).rows });
  const rowOf = (evidence, test) => [{ query_id: 'q1', row_number: evidence.rows.findIndex(test) + 1 }];
  async function card(kind, formKey, extra = {}, versionId) {
    const evidence = await read(formKey);
    const head = evidence.rows[0];
    const refs = rowOf(evidence, (r) => r.row_type === 'template');
    if (versionId) refs.push(...rowOf(evidence, (r) => r.row_type === 'version' && r.version_id === versionId));
    return JSON.parse(JSON.stringify(await normalizeActionDraft(pool, { kind, template_id: head.template_id, ...extra, evidence: refs }, [evidence], { currentUserId: 6 })));
  }
  const tpl = async (id) => (await q('SELECT * FROM form_templates WHERE id = ?', [id]))[0];
  const versionIds = async (id) => (await q('SELECT id FROM form_template_versions WHERE template_id = ? ORDER BY id', [id])).map((r) => r.id);
  const setRoles = async (roles) => { AUTH.roles = roles; await q('UPDATE users SET roles = ? WHERE user = 6', [roles.join(',')]); };
  async function apply(c) {
    expect(await browser.formTemplatePrecheck(c)).toBe('');
    const req = browser.formTemplateRequest(c);
    const res = await call(app, req.method, req.path, req.body);
    return { req, res };
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.forms'));
    app.use(require('../routes/api.formTemplates'));
    browser = browserChecks(async (p, body, method) => {
      const res = await call(app, method, p, body);
      if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
      return res.body;
    });
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); await setRoles([]); });

  test('PUBLISH: the card\'s diff and version are what the route did; the draft it named on the old version is then refused by submit-draft', async () => {
    const saved = await call(app, 'POST', '/api/forms/draft', { form_key: 'a124_sheet', link_type: 'case', link_id: CASE, schema_version: 2, data: { trustee: 'T' } });
    expect(saved.status).toBe(200);
    const draftRow = (await q("SELECT id, updated_at FROM form_submissions WHERE form_key = 'a124_sheet' AND status = 'draft'"))[0];
    const c = await card('form.template.publish.v1', 'a124_sheet');
    expect(c.publish).toEqual({ first_publish: false, bumped: true, schema_version_after: 3 });
    expect([c.diff.added.map((x) => x.key), c.diff.removed.map((x) => x.key), c.diff.changed.map((x) => x.key), c.diff.other_keys]).toEqual([['hearing'], ['notes'], ['trustee', 'chapter'], ['onSubmit']]);
    expect(c.stale_drafts).toMatchObject({ count: 1, records: [{ submission_id: draftRow.id, record: 'case 26-24001' }] });
    const before = await tpl(1);

    const { res } = await apply(c);
    expect(res.status).toBe(200);
    expect([res.body.schema_version, res.body.bumped]).toEqual([c.publish.schema_version_after, c.publish.bumped]);
    const after = await tpl(1);
    // What changed IS what the card diffed: the published definition is now the draft it read.
    expect(canon(asObj(after.definition))).toBe(canon(asObj(before.draft_definition)));
    expect(canon(asObj(after.draft_definition))).toBe(canon(asObj(before.draft_definition)));
    expect(after.schema_version).toBe(3);
    const ids = await versionIds(1);
    expect([ids.length, ids.slice(0, 2)]).toEqual([3, [10, 11]]);
    expect((await q('SELECT schema_version, published_by FROM form_template_versions WHERE id = ?', [ids[2]]))[0]).toEqual({ schema_version: 3, published_by: 6 });
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 1 });

    // The draft the card named is refused by the real submit route (the version it was saved on is retired).
    const sub = await call(app, 'POST', '/api/forms/submissions/submit-draft', { submission_id: draftRow.id });
    expect([sub.status, sub.body.draft_schema_version, sub.body.schema_version]).toEqual([409, 2, 3]);
    expect(sub.body.message).toBe(`Draft ${draftRow.id} was saved on version 2 of this form; the published form is version 3 — re-save the draft on the current version first`);
    // The card's re-read after the publish refuses.
    expect(await browser.formTemplatePrecheck(c)).toMatch(/^"Case Sheet" \(a124_sheet\) (changed since|was published again since) this card was prepared/);
  });

  test('VISIBILITY: no form_dev — the card refuses and the route 403s; form_dev — it lands; anyone takes it back down', async () => {
    await expect(card('form.template.visibility.v1', 'a124_sheet', { visibility: 'public' })).rejects.toThrow(/^FORM DEVELOPER REQUIRED: setting visibility "public"/);
    const denied = await call(app, 'POST', '/api/form-templates/1/visibility', { visibility: 'public' });
    expect([denied.status, /requires form-developer authorization/.test(denied.body.message)]).toEqual([403, true]);
    expect(browser.formTemplateKnownOutcome(Object.assign(new Error(denied.body.message), { status: 403, body: denied.body })).status).toBe('Refused — nothing written');
    expect((await tpl(1)).visibility).toBe('internal');

    await setRoles(['form_dev']);
    const c = await card('form.template.visibility.v1', 'a124_sheet', { visibility: 'public' });
    expect(c.warnings[0]).toMatch(/^EXPOSED PUBLICLY: the external form routes serve the PUBLISHED version 2 of "Case Sheet"/);
    const { res } = await apply(c);
    expect([res.status, res.body.visibility]).toEqual([200, 'public']);
    expect((await tpl(1)).visibility).toBe('public');
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 1 });

    await setRoles([]);
    const down = await card('form.template.visibility.v1', 'a124_sheet', { visibility: 'internal' });
    expect(down.warnings[0]).toMatch(/^TAKEN DOWN: the public link \/f\/a124_sheet stops serving/);
    const back = await apply(down);
    expect([back.res.status, (await tpl(1)).visibility]).toEqual([200, 'internal']);
  });

  test('RESTORE: the draft becomes the version exactly, nothing is published; a version of another template is refused by the card and the route', async () => {
    const c = await card('form.template.restore.v1', 'a124_sheet', { version_id: 10 }, 10);
    expect(c.warnings[0]).toMatch(/^DRAFT REPLACED: the current draft of "Case Sheet" \(a124_sheet, template #1\) holds edits that were never published/);
    const before = await tpl(1);
    const { res } = await apply(c);
    expect([res.status, res.body.restored]).toEqual([200, { version_id: 10, schema_version: 1 }]);
    const after = await tpl(1);
    expect(canon(asObj(after.draft_definition))).toBe(canon(V1));
    expect([canon(asObj(after.definition)), after.schema_version, after.visibility]).toEqual([canon(asObj(before.definition)), 2, 'internal']);
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 1 });

    // Version 20 belongs to template 2: the card (citing a row that claims it) and the route both refuse.
    const evidence = await read('a124_sheet');
    evidence.rows.push({ row_type: 'version', template_id: 1, version_id: 20 });
    await expect(normalizeActionDraft(pool, { kind: 'form.template.restore.v1', template_id: 1, version_id: 20,
      evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q1', row_number: evidence.rows.length }] }, [evidence], { currentUserId: 6 }))
      .rejects.toThrow(/^Version #20 is not a version of form template #1 \(or no longer exists\) — the route refuses it \(404\)$/);
    const other = await call(app, 'POST', '/api/form-templates/1/versions/20/restore');
    expect([other.status, other.body.message]).toEqual([404, 'Version 20 not found for template 1']);
    expect(canon(asObj((await tpl(1)).draft_definition))).toBe(canon(V1));
  });

  test('DELETE: the route removes what the card named; a published template and a used one are refused by both', async () => {
    const c = await card('form.template.delete.v1', 'a124_new');
    const { res } = await apply(c);
    expect([res.status, res.body.deleted]).toEqual([200, true]);
    expect(await tpl(3)).toBe(undefined);
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 3 });

    await expect(card('form.template.delete.v1', 'a124_used')).rejects.toThrow(/^SUBMISSIONS EXIST refused: 0 submitted forms and 1 saved draft carry form_key "a124_used"/);
    const used = await call(app, 'DELETE', '/api/form-templates/4');
    expect([used.status, used.body.message]).toEqual([400, 'cannot delete: submissions exist for "a124_used"']);
    await expect(card('form.template.delete.v1', 'a124_sheet')).rejects.toThrow(/^PUBLISHED TEMPLATE refused/);
    const pub = await call(app, 'DELETE', '/api/form-templates/1');
    expect([pub.status, pub.body.message]).toEqual([400, 'cannot delete a template that has been published']);
    expect([!!(await tpl(4)), !!(await tpl(1))]).toEqual([true, true]);
  });

  test('THE RE-READ after hand edits: the draft, the visibility, an appended version — each refuses before the claim', async () => {
    const c = await card('form.template.publish.v1', 'a124_sheet');
    expect(await browser.formTemplatePrecheck(c)).toBe('');
    // Same wall-clock second as the card: updated_at may not move — the draft hash still does.
    await q('UPDATE form_templates SET draft_definition = JSON_SET(draft_definition, \'$.layout\', \'card\'), updated_at = ? WHERE id = 1', [new Date(c.expected.updated_at)]);
    expect(await browser.formTemplatePrecheck(c)).toBe('"Case Sheet" (a124_sheet) changed since this card was prepared (its draft, published version or visibility). Nothing was written. Ask Casey to read it again.');

    await seed();
    const c2 = await card('form.template.publish.v1', 'a124_sheet');
    await q('UPDATE form_templates SET visibility = \'public\', updated_at = ? WHERE id = 1', [new Date(c2.expected.updated_at)]);
    expect(await browser.formTemplatePrecheck(c2)).toMatch(/changed since this card was prepared/);

    await seed();
    const c3 = await card('form.template.publish.v1', 'a124_sheet');
    await q('INSERT INTO form_template_versions (template_id, schema_version, definition, published_by) VALUES (1, 2, ?, 6)', [JSON.stringify(PUB)]);
    expect(await browser.formTemplatePrecheck(c3)).toBe('"Case Sheet" (a124_sheet) was published again since this card was prepared (its version list changed). Nothing was written. Ask Casey to read it again.');
    expect((await tpl(1)).schema_version).toBe(2);
  });
});
