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
 *   - A12X (2026-11-16): FIELD ADD / UPDATE / REMOVE through the real PUT —
 *     the draft the route stored IS the card's frozen next_definition (the
 *     browser's request sent that object; the result check accepted the
 *     route's row), the published definition, version and version rows are
 *     untouched; a hand edit between proposal and click refuses at the
 *     precheck; a removal the service would 400 (a dangling condition) is
 *     refused by the card before any write AND by the real route when PUT
 *     by hand. META: the title lands; a form_key rename is refused by the
 *     card and by the route. CREATE through the real POST: the new row holds
 *     the frozen definition, never published, internal; the same card then
 *     refuses (the key exists), as does the route (400). The current-version
 *     drafts a bump would strand are the real form_submissions rows.
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
  const consts = ['FORM_TEMPLATE_VISIBILITIES', 'FORM_TEMPLATE_FIELD_KINDS', 'FORM_TEMPLATE_LINK_TYPES', 'FORM_TEMPLATE_FORM_KEY_RE'].map((n) => { const at = html.indexOf(`const ${n} =`); return html.slice(at, html.indexOf(';\n', at) + 1); });
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
  async function card(kind, formKey, extra = {}, versionId, question = '') {
    const evidence = await read(formKey);
    const head = evidence.rows[0];
    const refs = rowOf(evidence, (r) => r.row_type === 'template');
    if (versionId) refs.push(...rowOf(evidence, (r) => r.row_type === 'version' && r.version_id === versionId));
    return JSON.parse(JSON.stringify(await normalizeActionDraft(pool, { kind, template_id: head.template_id, ...extra, evidence: refs }, [evidence], { currentUserId: 6, question })));
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

  // ── A12X: the field-level draft edits and the create, on the real routes ──
  const ASKED = 'Add a judge field to the case sheet, then create a vehicle intake form with the vehicle year and the lender.';

  test('FIELD ADD: the route stores the card\'s frozen draft exactly; nothing publishes; the current-version draft it would strand is the real row; a hand edit in between refuses', async () => {
    const saved = await call(app, 'POST', '/api/forms/draft', { form_key: 'a124_sheet', link_type: 'case', link_id: CASE, schema_version: 2, data: { trustee: 'T' } });
    expect(saved.status).toBe(200);
    const draftRow = (await q("SELECT id FROM form_submissions WHERE form_key = 'a124_sheet' AND status = 'draft'"))[0];
    const c = await card('form.template.field.add.v1', 'a124_sheet', { section: 'Case', field: { name: 'judge', type: 'text', label: 'Judge', required: true } }, null, ASKED);
    expect(c.op).toMatchObject({ field: { key: 'judge', label: 'Judge', detail: 'text, required' }, placement: 'a new row (row 2) at the end of section "Case"' });
    expect(c.publish).toEqual({ published: true, bumped: true, schema_version_after: 3 });
    expect(c.stale_drafts).toMatchObject({ count: 1, records: [{ submission_id: draftRow.id, record: 'case 26-24001' }] });
    expect(c.warnings[0]).toMatch(/^DRAFTS ON THE CURRENT VERSION: 1 saved draft of this form was saved on version 2; the draft already changes the answer fields and this change keeps that, so once it is published \(as version 3\)/);
    const before = await tpl(1);
    expect(canon(c.next_definition)).not.toBe(canon(asObj(before.draft_definition)));

    // A hand edit between proposal and click: the precheck refuses, nothing is sent.
    await q('UPDATE form_templates SET draft_definition = JSON_SET(draft_definition, \'$.layout\', \'card\'), updated_at = ? WHERE id = 1', [new Date(c.expected.updated_at)]);
    expect(await browser.formTemplatePrecheck(c)).toBe('"Case Sheet" (a124_sheet) changed since this card was prepared (its draft, published version or visibility). Nothing was written. Ask Casey to read it again.');
    await q('UPDATE form_templates SET draft_definition = ?, updated_at = ? WHERE id = 1', [JSON.stringify(DRAFT), new Date(c.expected.updated_at)]);

    const { req, res } = await apply(c);
    expect([req.method, req.path, Object.keys(req.body)]).toEqual(['PUT', '/api/form-templates/1', ['draft_definition']]);
    expect(res.status).toBe(200);
    const after = await tpl(1);
    // What the route stored IS the frozen definition the card showed — and what the result check accepted.
    expect(canon(asObj(after.draft_definition))).toBe(canon(c.next_definition));
    expect(asObj(after.draft_definition).sections[0].rows.map((r) => r.fields.map((f) => f.name))).toEqual([['trustee', 'chapter', 'hearing'], ['judge']]);
    expect([canon(asObj(after.definition)), after.schema_version, after.visibility, String(after.published_at)]).toEqual([canon(asObj(before.definition)), 2, 'internal', String(before.published_at)]);
    expect(await versionIds(1)).toEqual([10, 11]);
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 1 });
    // The card's re-read after its own apply refuses (the draft moved).
    expect(await browser.formTemplatePrecheck(c)).toMatch(/^"Case Sheet" \(a124_sheet\) changed since this card was prepared/);
    // The state read now shows the added field against what is published.
    const state = (await formTemplateStateRead(pool, 'a124_sheet')).rows[0];
    expect(state).toMatchObject({ draft_state: 'differs from published', publishes_as: 3, fields_added: 2, fields_removed: 1 });
  });

  test('FIELD UPDATE and REMOVE: the stored draft is the frozen one; a removal the service would 400 is refused by the card and by the route', async () => {
    const u = await card('form.template.field.update.v1', 'a124_sheet', { field_name: 'chapter', changes: { required: true, options: ['7', '11', '13', '12'] } });
    expect(u.op).toMatchObject({ field: { key: 'chapter', detail: 'select, required' }, set: ['required', 'options'], dropped: [] });
    expect(u.diff.changed).toEqual([{ key: 'chapter', label: 'Chapter', what: 'now REQUIRED; options ["7","11","13"] → ["7","11","13","12"]' }]);
    const ru = await apply(u);
    expect([ru.res.status, canon(asObj((await tpl(1)).draft_definition))]).toEqual([200, canon(u.next_definition)]);
    expect(browser.formTemplateResult(u, ru.res.body)).toEqual({ template_id: 1 });

    const r = await card('form.template.field.remove.v1', 'a124_sheet', { field_name: 'hearing' });
    expect(r.warnings[0]).toBe('FIELD REMOVED: Hearing (hearing) — once this draft is published, the form stops asking it; answers already stored in submissions and drafts keep it.');
    const rr = await apply(r);
    expect(rr.res.status).toBe(200);
    const stored = asObj((await tpl(1)).draft_definition);
    expect([canon(stored), stored.sections[0].rows[0].fields.map((f) => f.name)]).toEqual([canon(r.next_definition), ['trustee', 'chapter']]);
    expect((await tpl(1)).schema_version).toBe(2);

    // A condition still names "chapter": the card refuses before any write; the same dangling target PUT by hand is the route's 400.
    const REF = JSON.parse(JSON.stringify(DRAFT));
    REF.sections[0].rows[0].fields[2].showWhen = { field: 'chapter', op: 'eq', value: '13' };
    await q('UPDATE form_templates SET draft_definition = ? WHERE id = 1', [JSON.stringify(REF)]);
    await expect(card('form.template.field.remove.v1', 'a124_sheet', { field_name: 'chapter' })).rejects.toThrow(/^STILL REFERENCED refused: sections\[0\]\.rows\[0\]\.fields\[2\]\.showWhen names "chapter"/);
    const dangling = JSON.parse(JSON.stringify(REF)); dangling.sections[0].rows[0].fields.splice(1, 1);
    const byHand = await call(app, 'PUT', '/api/form-templates/1', { draft_definition: dangling });
    expect([byHand.status, byHand.body.message]).toEqual([400, 'sections[0].rows[0].fields[1].showWhen.field "chapter" does not reference an existing top-level field']);
    expect(canon(asObj((await tpl(1)).draft_definition))).toBe(canon(REF));
  });

  test('META: the title lands and nothing else moves; a form_key rename is refused by the card and by the route', async () => {
    const c = await card('form.template.meta.v1', 'a124_sheet', { title: '341 Case Sheet' });
    expect(c.meta).toEqual({ title_from: 'Case Sheet', title_to: '341 Case Sheet' });
    const before = await tpl(1);
    const { req, res } = await apply(c);
    expect([req.method, req.body, res.status]).toEqual(['PUT', { title: '341 Case Sheet' }, 200]);
    const after = await tpl(1);
    expect([after.title, canon(asObj(after.draft_definition)), canon(asObj(after.definition)), after.schema_version, after.form_key]).toEqual(['341 Case Sheet', canon(asObj(before.draft_definition)), canon(asObj(before.definition)), 2, 'a124_sheet']);
    expect(browser.formTemplateResult(c, res.body)).toEqual({ template_id: 1 });
    await expect(card('form.template.meta.v1', 'a124_sheet', { title: 'X', form_key: 'renamed' })).rejects.toThrow(/^FORM KEY RENAME refused: "a124_sheet" is the name every stored reader of this form carries/);
    const renamed = await call(app, 'PUT', '/api/form-templates/1', { form_key: 'renamed' });
    expect([renamed.status, renamed.body.message, (await tpl(1)).form_key]).toEqual([400, 'form_key is immutable once the template has been published', 'a124_sheet']);
  });

  test('CREATE: the route stores the frozen definition under a free key (never published, internal); the same card then refuses, as does the route', async () => {
    const evidence = await read('');
    const value = { kind: 'form.template.create.v1', form_key: 'a124_vehicles', title: 'Vehicle Intake', link_type: 'case',
      fields: [{ name: 'vehicle_year', type: 'number', label: 'Vehicle year', min: 1950 }, { name: 'lender', type: 'select', label: 'Lender', options: ['Ally', 'Other'] }], evidence: [] };
    const c = JSON.parse(JSON.stringify(await normalizeActionDraft(pool, value, [evidence], { currentUserId: 6, question: ASKED })));
    expect(c.definition).toEqual({ sections: [{ title: 'Section 1', rows: [{ fields: [value.fields[0]] }, { fields: [value.fields[1]] }] }] });
    expect(await browser.formTemplatePrecheck(c)).toBe('');
    const req = browser.formTemplateRequest(c);
    expect([req.method, req.path, req.body.form_key, req.body.draft_definition]).toEqual(['POST', '/api/form-templates', 'a124_vehicles', c.definition]);
    const res = await call(app, req.method, req.path, req.body);
    expect(res.status).toBe(201);
    const made = res.body.template;
    const receipt = browser.formTemplateResult(c, res.body);
    expect(receipt).toEqual({ template_id: made.id });
    const row = await tpl(made.id);
    expect([row.form_key, row.title, row.link_type, row.schema_version, row.visibility, row.definition, row.published_at, canon(asObj(row.draft_definition))])
      .toEqual(['a124_vehicles', 'Vehicle Intake', 'case', 1, 'internal', null, null, canon(c.definition)]);
    expect(await versionIds(made.id)).toEqual([]);
    // The key is taken now: the same card's precheck refuses, a fresh card refuses, the route refuses.
    expect(await browser.formTemplatePrecheck(c)).toBe(`A form template with form key "a124_vehicles" already exists (template #${made.id}, "Vehicle Intake") — created since this card was prepared. Nothing was written.`);
    await expect(normalizeActionDraft(pool, value, [evidence], { currentUserId: 6, question: ASKED })).rejects.toThrow(`FORM KEY TAKEN: form template #${made.id} already has form_key "a124_vehicles" (the route refuses a duplicate, 400)`);
    const dup = await call(app, 'POST', '/api/form-templates', req.body);
    expect([dup.status, dup.body.message]).toEqual([400, 'form_key "a124_vehicles" already exists']);
    expect((await q("SELECT COUNT(*) AS n FROM form_templates WHERE form_key = 'a124_vehicles'"))[0].n).toBe(1);
    // The new template is in the state read, never published; a field add on it predicts a first publish.
    const listed = (await formTemplateStateRead(pool, '')).rows.find((r) => r.form_key === 'a124_vehicles');
    expect(listed).toMatchObject({ template_id: made.id, published: 0, schema_version: 1 });
    const add = await card('form.template.field.add.v1', 'a124_vehicles', { field: { name: 'judge', type: 'text', label: 'Judge' } }, null, ASKED);
    expect([add.publish, add.op.placement]).toEqual([{ published: false, bumped: false, schema_version_after: 1 }, 'a new row (row 3) at the end of section "Section 1"']);
  });
});
