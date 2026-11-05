// tests/campaignC4.mysql.test.js
//
/**
 * YisraMail C4 — segments + reporting on REAL MySQL (ref/YISRAMAIL_DESIGN.md
 * §6.2, §6.5 "Reporting — C4"):
 *   G  campaign_segments CRUD through the service on the REAL table built by
 *      scripts/yisramailC4Migrate.js: the filter round-trips (compared
 *      key-order-insensitively — MySQL JSON re-orders object keys on write),
 *      archive leaves the list, q is LIKE-escaped, refusals never write
 *   S  getCampaign's C4 block: delivered counts by the SET-ONCE timestamp (a
 *      complained row still counts delivered), bounced by terminal
 *      delivery_status, unsubscribed from the LEDGER by send_ref (another
 *      campaign's opt-out and a NULL send_ref never count); operational and
 *      SMS campaigns carry NO delivery block; transport block present with
 *      held state, null when the sender row is gone
 *   B  bounceDigestData: the 24 h window (old activity excluded), an
 *      unsub-only campaign still appears, bulk transports only, held carried
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_c4_test npx jest tests/campaignC4.mysql.test.js --runInBand
 * Its OWN *_test DB family: it drops and rebuilds every table it touches
 * (cloned from ref/database.sql, consent tables from the P1 helper, then the
 * C1–C4 migration scripts — idempotent, so the twin is independent of whether
 * the dump carries them yet).
 */
'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const TABLES = ['campaigns', 'campaign_contacts', 'campaign_results', 'contacts', 'contact_emails',
  'app_settings', 'email_credentials', 'users', 'comm_unsub_tokens', 'email_log'];

d('C4 segments + reporting on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  const { buildConsentTables } = require('./helpers/consentSchema');
  const c1Migrate = require('../scripts/yisramailC1Migrate');
  const c2Migrate = require('../scripts/yisramailC2Migrate');
  const c3Migrate = require('../scripts/yisramailC3Migrate');
  const c4Migrate = require('../scripts/yisramailC4Migrate');
  const segService = require('../services/campaignSegmentService');
  const campaignService = require('../services/campaignService');
  const mailEvents = require('../services/mailEventService');

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  /** Key-order-insensitive deep equal (MySQL JSON re-orders object keys on write). */
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  const expectSameJson = (a, b) => expect(JSON.stringify(sortKeys(a))).toBe(JSON.stringify(sortKeys(b)));

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    await schema.build(pool, TABLES);
    await buildConsentTables(q);
    await q('DROP TABLE IF EXISTS campaign_segments');
    const c = await pool.getConnection();
    try {
      expect((await c1Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      expect((await c2Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      expect((await c3Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
      expect((await c4Migrate.run(c, { apply: true, say: () => {} })).ok).toBe(true);
    } finally { c.release(); }
    await q(`INSERT INTO users (username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, user, email, ringcentral, roles) VALUES
      ('fred', 1, 'Fred', 'Fred', 'F', 'FF', 'authorized', 6, 'fred@firm.test', 0, 'admin')`);
    await q(`INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, provider, from_name, bulk_ok, events_driver, driver_config) VALUES
      (4, 'ops@firm.test', 'mail.firm.test', 587, 'ops', 'x', 0, 'smtp', 'Ops', 0, NULL, NULL),
      (17, 'news@news.test', 'email-smtp.test', 587, 'AKIA', 'x', 0, 'smtp', 'Firm News', 1, 'ses', '{"configuration_set":"yisramail-marketing"}')`);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    for (const t of ['campaign_segments', 'campaigns', 'campaign_contacts', 'campaign_results', 'comm_consent_events']) await q(`DELETE FROM ${t}`);
    await q("UPDATE email_credentials SET held_at = NULL, held_reason = NULL WHERE id = 17");
  });

  // ─── G: segment CRUD ───────────────────────────────────────

  describe('segment CRUD', () => {
    const FILTER = { channel: 'email', tags: ['vip', 'intake'], case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
      case_stage: ['Open'], case_open_after: '2026-01-01', case_open_before: '2026-11-01' };

    test('create → list → update → archive round-trips the filter, key-order-insensitively', async () => {
      const { id } = await segService.createSegment(pool, { name: 'Everyone — newsletter', filter: FILTER }, { userId: 6 });
      expect(id).toBeGreaterThan(0);

      let list = await segService.listSegments(pool);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, name: 'Everyone — newsletter', created_by: 6, archived: false });
      expectSameJson(list[0].filter, FILTER);

      await segService.updateSegment(pool, id, { name: 'VIPs only', filter: { tags: ['vip'], channel: 'email' } });
      list = await segService.listSegments(pool);
      expect(list[0].name).toBe('VIPs only');
      expectSameJson(list[0].filter, { tags: ['vip'], channel: 'email' });

      await segService.setArchived(pool, id, true);
      expect(await segService.listSegments(pool)).toHaveLength(0);
      const archived = await segService.listSegments(pool, { includeArchived: true });
      expect(archived).toHaveLength(1);
      expect(archived[0].archived).toBe(true);
      await segService.setArchived(pool, id, false);
      expect(await segService.listSegments(pool)).toHaveLength(1);
    });

    test('{} stores as everyone; a JWT sub arriving as a numeric string still lands in created_by', async () => {
      const { id } = await segService.createSegment(pool, { name: 'All', filter: {} }, { userId: '6' });
      const [row] = await segService.listSegments(pool);
      expect(row.id).toBe(id);
      expect(row.created_by).toBe(6);
      expectSameJson(row.filter, {});
    });

    test('a refusal writes NOTHING: unknown key, bad shape, missing name; 404s on unknown ids', async () => {
      await expect(segService.createSegment(pool, { name: 'X', filter: { klass: 'marketing' } }, {})).rejects.toThrow(/unknown key/);
      await expect(segService.createSegment(pool, { name: 'X', filter: { channel: 'fax' } }, {})).rejects.toThrow(/channel/);
      await expect(segService.createSegment(pool, { name: '', filter: {} }, {})).rejects.toThrow(/name is required/);
      expect(await q('SELECT COUNT(*) AS n FROM campaign_segments')).toEqual([{ n: 0 }]);
      await expect(segService.updateSegment(pool, 999, { name: 'X', filter: {} })).rejects.toThrow(/not found/);
      await expect(segService.setArchived(pool, 999, true)).rejects.toThrow(/not found/);
      await expect(segService.setArchived(pool, 999, 'yes')).rejects.toThrow(/true or false/);
    });

    test('q searches by name with LIKE wildcards escaped — "100%" matches literally, not everything', async () => {
      await segService.createSegment(pool, { name: '100% VIP', filter: {} }, {});
      await segService.createSegment(pool, { name: 'Other list', filter: {} }, {});
      expect(await segService.listSegments(pool, { q: '100%' })).toHaveLength(1);
      expect(await segService.listSegments(pool, { q: '100_' })).toHaveLength(0);
    });
  });

  // ─── S: getCampaign's delivery + transport block ───────────

  async function seedMarketing(cid, { sender = 'news@news.test', type = 'email', klass = 'marketing' } = {}) {
    await q(`INSERT INTO campaigns (campaign_id, type, class, topic_key, sender, subject, body, status, contact_count, created_by)
             VALUES (?, ?, ?, ?, ?, 'Subj', '<p>b</p>', 'sent', 4, 6)`, [cid, type, klass, klass === 'marketing' ? 'newsletter' : null, sender]);
  }
  /** One result row; kind decides the delivery columns. */
  async function seedResult(cid, ctid, kind, { hoursAgo = 2 } = {}) {
    const at = `UTC_TIMESTAMP(3) - INTERVAL ${Number(hoursAgo)} HOUR`;
    // [status, delivery_status, delivered_at?, bounced_at?, complained_at?] —
    // recordResult stamps sent_at on EVERY row it writes, skips included.
    const shapes = {
      none:         ['sent', 'sent', null, null, null],
      delivered:    ['sent', 'delivered', at, null, null],
      complained:   ['sent', 'complained', at, null, at],   // delivered first, then the complaint — both set-once stamps stand
      bounced:      ['sent', 'bounced_hard', null, at, null],
      bounced_soft: ['sent', 'bounced_soft', null, at, null],
      skipped:      ['skipped', 'unknown', null, null, null],
    };
    const [status, ds, dAt, bAt, cAt] = shapes[kind];
    const [r] = await pool.query(
      `INSERT INTO campaign_results (campaign_id, contact_id, status, sent_at, delivery_status, delivered_at, bounced_at, complained_at, bounce_subtype)
       VALUES (?, ?, '${status}', ${at}, '${ds}', ${dAt || 'NULL'}, ${bAt || 'NULL'}, ${cAt || 'NULL'}, NULL)`, [cid, ctid]);
    return r.insertId;
  }
  const consentEvent = (dest, sendRef, { action = 'opt_out', source = 'one_click', hoursAgo = 1, eventId } = {}) => q(
    `INSERT INTO comm_consent_events (channel, destination, scope, action, source, occurred_at, send_ref, provider_event_id)
     VALUES ('email', ?, 'marketing', ?, ?, UTC_TIMESTAMP(3) - INTERVAL ? HOUR, ?, ?)`,
    [dest, action, source, hoursAgo, sendRef, eventId ?? `ev:${dest}:${Math.random()}`]);
  const optOut = (dest, sendRef, extra = {}) => consentEvent(dest, sendRef, extra);
  /** The ledger rows mail_event_ingest writes for a hard bounce / complaint — SAME send_ref shape. */
  const providerEvents = async (dest, resultId) => {
    await consentEvent(dest, String(resultId), { source: 'provider_bounce' });
    await consentEvent(dest, String(resultId), { source: 'provider_complaint' });
  };

  describe("getCampaign's C4 block", () => {
    test('delivered by set-once stamp (a complained row still counts), bounced terminal (soft excluded), unsubs by send_ref AND unsub source only', async () => {
      await seedMarketing(70);
      const r1 = await seedResult(70, 1, 'delivered');
      const r2 = await seedResult(70, 2, 'complained');
      const r3 = await seedResult(70, 3, 'bounced');
      await seedResult(70, 4, 'none');
      await seedResult(70, 5, 'bounced_soft');              // never a "bounced" (terminal hard only)
      await optOut('pat@example.com', String(r1));          // this campaign, one_click — counts
      await optOut('x@example.com', null);                  // no send_ref — never counts
      // What mail_event_ingest writes for the bounce and the complaint: the
      // SAME send_ref shape. Counting these as unsubscribes was review B1 —
      // every bounce/complaint would show twice.
      await providerEvents('ann@example.com', r3);
      await providerEvents('sam@example.com', r2);
      // pref_page writes opt_in events with send_ref too (re-subscribes) —
      // action filter, review S4/M4. A DISTINCT destination of its own, or
      // COUNT(DISTINCT destination) hides a dropped action filter.
      await consentEvent('resub@example.com', String(r2), { action: 'opt_in', source: 'pref_page' });
      await seedMarketing(71);
      const other = await seedResult(71, 9, 'delivered');
      await optOut('other@example.com', String(other), { source: 'pref_page' });  // another campaign's — not here

      const c = await campaignService.getCampaign(pool, 70);
      expect(c.delivery).toEqual({ delivered: 2, bounced: 1, complained: 1, unsubscribed: 1 });
      const c2 = await campaignService.getCampaign(pool, 71);
      expect(c2.delivery).toEqual({ delivered: 1, bounced: 0, complained: 0, unsubscribed: 1 });
    });

    test('transport block: live rates + held carried; null when the sender row is gone; absent off the marketing-email path', async () => {
      await seedMarketing(70);
      await seedResult(70, 1, 'delivered');
      let c = await campaignService.getCampaign(pool, 70);
      expect(c.transport).toMatchObject({ held: false, held_reason: null, delivered: 1, enough: false });

      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(3), held_reason = 'complaint rate 0.40% (2/500)' WHERE id = 17");
      c = await campaignService.getCampaign(pool, 70);
      expect(c.transport).toMatchObject({ held: true, held_reason: 'complaint rate 0.40% (2/500)' });

      await seedMarketing(72, { sender: 'gone@nowhere.test' });
      expect((await campaignService.getCampaign(pool, 72)).transport).toBeNull();

      await seedMarketing(73, { klass: 'operational' });
      const op = await campaignService.getCampaign(pool, 73);
      expect(op.delivery).toBeUndefined();
      expect(op.transport).toBeUndefined();

      await seedMarketing(74, { type: 'sms' });
      const sms = await campaignService.getCampaign(pool, 74);
      expect(sms.delivery).toBeUndefined();
      expect(sms.transport).toBeUndefined();
    });
  });

  // ─── B: bounceDigestData ───────────────────────────────────

  describe('bounceDigestData', () => {
    test('the 24 h window: fresh activity counted, 30 h-old excluded; sent = status sent only; soft bounce not hard; provider ledger rows are not unsubs; an unsub-only campaign appears; bulk transports only; held carried', async () => {
      await seedMarketing(70);
      await seedResult(70, 1, 'delivered');
      const rb = await seedResult(70, 2, 'bounced');
      await seedResult(70, 3, 'delivered', { hoursAgo: 30 });   // outside the window
      await seedResult(70, 6, 'bounced_soft');                  // bounced_at in window — NOT a hard bounce
      await seedResult(70, 7, 'skipped');                       // sent_at stamped, status skipped — NOT sent
      await providerEvents('bo@example.com', rb);               // ingest's ledger rows — NOT unsubs (B1)
      await seedMarketing(71);
      const oldRow = await seedResult(71, 9, 'delivered', { hoursAgo: 30 });
      await optOut('late@example.com', String(oldRow));          // unsub NOW on an old send
      await seedMarketing(73, { klass: 'operational' });         // operational — never in the digest
      await seedResult(73, 5, 'delivered');
      await q("UPDATE email_credentials SET held_at = UTC_TIMESTAMP(3), held_reason = 'r' WHERE id = 17");

      const data = await mailEvents.bounceDigestData(pool);
      expect(data.window_h).toBe(24);
      const c70 = data.campaigns.find((c) => c.campaign_id === 70);
      expect(c70).toMatchObject({ sent: 3, delivered: 1, bounced_hard: 1, complained: 0, unsubscribed: 0, subject: 'Subj' });
      const c71 = data.campaigns.find((c) => c.campaign_id === 71);
      expect(c71).toMatchObject({ sent: 0, delivered: 0, bounced_hard: 0, complained: 0, unsubscribed: 1 });
      expect(data.campaigns.some((c) => c.campaign_id === 73)).toBe(false);
      expect(data.transports).toHaveLength(1);                   // bulk_ok only — ops row 4 absent
      expect(data.transports[0]).toMatchObject({ id: 17, email: 'news@news.test', held: true, held_reason: 'r' });
    });

    test('a quiet window returns no campaigns at all', async () => {
      await seedMarketing(70);
      await seedResult(70, 1, 'delivered', { hoursAgo: 30 });
      const data = await mailEvents.bounceDigestData(pool);
      expect(data.campaigns).toEqual([]);
    });
  });
});
