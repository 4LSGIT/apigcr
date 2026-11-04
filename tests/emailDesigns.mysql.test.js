/**
 * YisraMail C3a — the designs library on REAL MySQL (services/emailDesignService.js +
 * campaignService.createCampaign's design_id; ref/YISRAMAIL_DESIGN.md §6.3 "As built (C3a)").
 *
 *   J  CRUD round trip: design_json comes back equal KEY-ORDER-INSENSITIVELY (MySQL re-orders
 *      JSON object keys on write — the stored text is NOT what was sent), html / text verbatim
 *      (unicode, merge tags), builder, created_by, archived false; a ~500 KB design + 100 KB html
 *      fit their columns; an identical re-save still answers (mysql2's FOUND_ROWS)
 *   V  a rejected save writes nothing (create and update); an accepted update replaces in place
 *   L  the list: no bodies, archived excluded by default and included on request, newest first,
 *      q matched literally (LIKE wildcards escaped)
 *   C  createCampaign: an existing design_id is stored; unknown → 400 unknown_design, archived →
 *      400 design_archived, on an SMS campaign → 400 design_not_email — each with NO campaign row;
 *      absent → NULL; getCampaign returns it; the body stays what the caller sent
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c3designs_test npx jest tests/emailDesigns.mysql.test.js --runInBand
 * Its OWN *_test DB family: it drops and rebuilds every table it touches (cloned from
 * ref/database.sql, then the C1, C2 and C3 migration scripts — idempotent, so the twin is
 * independent of whether the dump carries them yet).
 */
'use strict';

jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['campaigns', 'campaign_contacts', 'campaign_results', 'scheduled_jobs', 'email_credentials', 'app_settings', 'admin_audit_log', 'users', 'mailboxes'];

/** Key-order-insensitive canonical form (CLAUDE.md: MySQL JSON re-orders keys on write). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

d('C3a designs library on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const F = require('./helpers/emailDesignFixture');
  const { withTransaction } = require('../lib/withTransaction');
  const svc = require('../services/emailDesignService');
  const campaignService = require('../services/campaignService');
  const STAFF = { type: 'jwt', roles: ['staff'], userId: 9, username: 'sam' };

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const count = async (t) => Number((await q(`SELECT COUNT(*) n FROM ${t}`))[0].n);
  const body = (over = {}) => ({ name: 'November newsletter', design_json: F.design(), html: F.html(), text: 'Hi — café ✓ {{contacts.contact_fname}}', ...over });
  const mutated = (fn) => { const x = F.design(); fn(x); return x; };
  const firstText = (x) => x.pages[0].frames[0].component.components[0].components[1].components[1].components[0].components[0];
  const base = { type: 'email', sender: 'ops@firm.test', subject: 'S', body: '<html><body><p>B</p><!-- yc:footer-slot --></body></html>', contactIds: [2, 3], createdBy: 9, auth: STAFF };

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    await q('DROP TABLE IF EXISTS email_designs');
    await schema.build(pool, TABLES);
    const c = await pool.getConnection();
    try {
      for (const name of ['yisramailC1Migrate', 'yisramailC2Migrate', 'yisramailC3Migrate']) {
        expect((await require(`../scripts/${name}`).run(c, { apply: true, say: () => {} })).ok).toBe(true);
      }
    } finally { c.release(); }
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, provider, from_name, bulk_ok)
             VALUES (4, 'ops@firm.test', 'h', 587, 'u', 'ENCv1:x', 'smtp', 'Ops', 0)`);
  });
  beforeEach(async () => {
    for (const t of ['email_designs', 'campaigns', 'campaign_contacts', 'scheduled_jobs']) await q(`DELETE FROM ${t}`);
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    for (const t of [...TABLES, 'email_designs']) await q(`DROP TABLE IF EXISTS ${t}`);
    await pool.end();
  });

  describe('J: the round trip', () => {
    test('design_json equal key-order-insensitively (the stored text re-ordered), html / text verbatim, builder, created_by, archived', async () => {
      const sent = body();
      const { id, warning } = await svc.createDesign(pool, sent, { userId: 9 });
      expect(warning).toBeNull();
      const got = await svc.getDesign(pool, id);
      expect(canon(got.design_json)).toBe(canon(sent.design_json));
      const [[raw]] = await pool.query('SELECT CAST(design_json AS CHAR) j FROM email_designs WHERE id = ?', [id]);
      expect(raw.j).not.toBe(JSON.stringify(sent.design_json));                     // MySQL re-ordered it
      expect(canon(JSON.parse(raw.j))).toBe(canon(sent.design_json));
      expect(got).toMatchObject({ id, name: 'November newsletter', builder: 'grapesjs-mjml', html: F.html(), text: sent.text, created_by: 9, archived: false, thumbnail_asset_id: null });
      expect(got.created_at).toBeInstanceOf(Date);
    });
    test('a ~500 KB design_json and a 100 KB html fit (json / mediumtext), with the size warning', async () => {
      const big = mutated((x) => { firstText(x).components.push({ type: 'textnode', content: 'x'.repeat(480 * 1024) }); });
      const html = F.html().replace('</body>', `<div>${'é'.repeat(50 * 1024)}</div></body>`);
      const { id, warning } = await svc.createDesign(pool, body({ design_json: big, html }));
      expect(warning).toMatch(/Gmail clips/);
      const got = await svc.getDesign(pool, id);
      expect(canon(got.design_json)).toBe(canon(big));
      expect(got.html).toBe(html);
    });
    test('update replaces in place; an identical re-save still answers (no false 404)', async () => {
      const { id } = await svc.createDesign(pool, body());
      const next = body({ name: 'Renamed', text: 'new text', design_json: mutated((x) => { firstText(x).components.push({ type: 'textnode', content: ' more' }); }) });
      expect(await svc.updateDesign(pool, id, next)).toEqual({ id, warning: null });
      expect(await svc.updateDesign(pool, id, next)).toEqual({ id, warning: null });
      const got = await svc.getDesign(pool, id);
      expect(got).toMatchObject({ name: 'Renamed', text: 'new text', created_by: null });
      expect(canon(got.design_json)).toBe(canon(next.design_json));
      expect(await count('email_designs')).toBe(1);
      await svc.setArchived(pool, id, true);
      await expect(svc.setArchived(pool, id, true)).resolves.toBeUndefined();
      await expect(svc.updateDesign(pool, id + 100, next)).rejects.toMatchObject({ status: 404, code: 'not_found' });
      await expect(svc.setArchived(pool, id + 100, false)).rejects.toMatchObject({ status: 404 });
      await expect(svc.getDesign(pool, id + 100)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('V: reject writes nothing', () => {
    test('create: a rule failure inserts no row; update: the stored design is untouched', async () => {
      const bad = mutated((x) => { firstText(x).components.push({ tagName: 'span', script: 'parent.apiSend(1)' }); });
      await expect(svc.createDesign(pool, body({ design_json: bad }))).rejects.toMatchObject({ status: 400, code: 'design_rejected', rule: 3 });
      expect(await count('email_designs')).toBe(0);
      const { id } = await svc.createDesign(pool, body());
      await expect(svc.updateDesign(pool, id, body({ name: 'X', html: F.html().replace('<!-- yc:footer-slot -->', 'visible') }))).rejects.toMatchObject({ rule: 9 });
      expect((await svc.getDesign(pool, id)).name).toBe('November newsletter');
    });
  });

  describe('L: the list', () => {
    test('no bodies; archived excluded unless asked; newest first; q literal', async () => {
      const a = (await svc.createDesign(pool, body({ name: 'Alpha 50%_off' }))).id;
      const b = (await svc.createDesign(pool, body({ name: 'Beta 50 off' }))).id;
      const c = (await svc.createDesign(pool, body({ name: 'Gamma' }))).id;
      await q('UPDATE email_designs SET updated_at = ? WHERE id = ?', ['2026-11-01 00:00:00', a]);
      await q('UPDATE email_designs SET updated_at = ? WHERE id = ?', ['2026-11-02 00:00:00', b]);
      await q('UPDATE email_designs SET updated_at = ? WHERE id = ?', ['2026-11-03 00:00:00', c]);
      await svc.setArchived(pool, c, true);
      const def = await svc.listDesigns(pool);
      expect(def.map((r) => r.id)).toEqual([b, a]);
      expect(Object.keys(def[0]).sort()).toEqual(['archived', 'builder', 'id', 'name', 'updated_at']);
      expect(def[0].archived).toBe(false);
      expect((await svc.listDesigns(pool, { includeArchived: true })).map((r) => [r.id, r.archived])).toEqual([[c, true], [b, false], [a, false]]);
      expect((await svc.listDesigns(pool, { q: '50%_' })).map((r) => r.id)).toEqual([a]);       // not "Beta 50 off"
      expect((await svc.listDesigns(pool, { q: 'gam', includeArchived: true })).map((r) => r.id)).toEqual([c]);
    });
  });

  describe('C: createCampaign design_id', () => {
    test('an existing design is stored (number or numeric string); getCampaign returns it; the body is what the caller sent', async () => {
      const { id } = await svc.createDesign(pool, body());
      const r = await campaignService.createCampaign(pool, { ...base, designId: id });
      const [row] = await q('SELECT design_id, body FROM campaigns WHERE campaign_id = ?', [r.campaignId]);
      expect(row).toEqual({ design_id: id, body: base.body });
      expect((await campaignService.getCampaign(pool, r.campaignId)).design_id).toBe(id);
      const s = await campaignService.createCampaign(pool, { ...base, designId: String(id) });
      expect((await q('SELECT design_id FROM campaigns WHERE campaign_id = ?', [s.campaignId]))[0].design_id).toBe(id);
    });
    test('absent / null → NULL', async () => {
      const r = await campaignService.createCampaign(pool, base);
      const n = await campaignService.createCampaign(pool, { ...base, designId: null });
      expect(await q('SELECT design_id FROM campaigns WHERE campaign_id IN (?, ?)', [r.campaignId, n.campaignId])).toEqual([{ design_id: null }, { design_id: null }]);
    });
    test('unknown / archived / not a design id / on SMS → 400, and no campaign row', async () => {
      const { id } = await svc.createDesign(pool, body());
      await svc.setArchived(pool, id, true);
      await expect(campaignService.createCampaign(pool, { ...base, designId: id + 50 })).rejects.toMatchObject({ status: 400, code: 'unknown_design' });
      await expect(campaignService.createCampaign(pool, { ...base, designId: id })).rejects.toMatchObject({ status: 400, code: 'design_archived' });
      await expect(campaignService.createCampaign(pool, { ...base, designId: 'abc' })).rejects.toMatchObject({ status: 400, code: 'unknown_design' });
      await expect(campaignService.createCampaign(pool, { ...base, designId: -3 })).rejects.toMatchObject({ status: 400, code: 'unknown_design' });
      await expect(campaignService.createCampaign(pool, { ...base, type: 'sms', sender: '2485550000', subject: null, designId: id })).rejects.toMatchObject({ status: 400, code: 'design_not_email' });
      expect(await count('campaigns')).toBe(0);
      await svc.setArchived(pool, id, false);
      await expect(campaignService.createCampaign(pool, { ...base, designId: id })).resolves.toMatchObject({ contactCount: 2 });
    });
  });
});
