// tests/campaignC4.test.js
//
/**
 * YisraMail C4 — segments + reporting, the DB-free half (ref/YISRAMAIL_DESIGN.md
 * §6.2, §6.5 "Reporting — C4"):
 *   V  validateFilter: the exact key set, every shape rule, {} = everyone,
 *      unknown keys refused — a segment getFilteredContacts cannot run is
 *      never stored
 *   W  route wiring: the segments routes sit ABOVE /campaigns/:id (or
 *      'segments' is captured as an id) and use segmentErrorBody
 *   D  mail_bounce_digest: off on '0' (fresh read, not cfg); silent with no
 *      activity; sends with the recipient/sender resolution
 *      (campaign_bounce_digest_email → alert_recipients; alert_from_email →
 *      email_automations); activity with nowhere to go THROWS (the failed-job
 *      sweep must see it); dry_run computes and sends nothing
 *   C  CTA: mail_bounce_digest is deny-listed — never link-eligible
 * The SQL (segment CRUD, the delivery/unsub counts, bounceDigestData) is
 * real-engine: tests/campaignC4.mysql.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../lib/firmConfig', () => ({
  ...jest.requireActual('../lib/firmConfig'),
  cfg: jest.fn((k) => (k === 'email_automations' ? 'auto@firm.test' : null)),
}));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => ({ messageId: '<m@test>' })),
}));
jest.mock('../services/mailEventService', () => ({
  ...jest.requireActual('../services/mailEventService'),
  bounceDigestData: jest.fn(),
}));

const seg = require('../services/campaignSegmentService');
const emailService = require('../services/emailService');
const mailEvents = require('../services/mailEventService');
const digestFns = require('../lib/internal_functions/mailDigest');

// ─── V: validateFilter ───────────────────────────────────────

describe('validateFilter', () => {
  const ok = (f) => seg.validateFilter(f);
  const bad = (f, re) => expect(() => seg.validateFilter(f)).toThrow(re);

  test('{} is a valid segment — everyone (the topic is the list)', () => {
    expect(ok({})).toEqual({});
  });

  test('the full key set round-trips, trimmed', () => {
    expect(ok({
      tags: [' vip ', 'intake'], case_type: ' Bankruptcy ', case_subtype: 'Chapter 7',
      case_stage: ['Open'], case_open_after: '2026-01-01', case_open_before: '2026-11-01', channel: 'email',
    })).toEqual({
      tags: ['vip', 'intake'], case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
      case_stage: ['Open'], case_open_after: '2026-01-01', case_open_before: '2026-11-01', channel: 'email',
    });
  });

  test('an unknown key is refused by name', () => {
    bad({ klass: 'marketing' }, /unknown key "klass"/);
    bad({ topic: 'newsletter' }, /unknown key "topic"/);
    bad({ contact_ids: [1] }, /unknown key "contact_ids"/);
  });

  test('shapes: non-object, arrays where strings go, bad dates, bad channel, empty entries, over-bounds', () => {
    bad(null, /filter must be a JSON object/);
    bad([], /filter must be a JSON object/);
    bad('x', /filter must be a JSON object/);
    bad({ tags: 'vip' }, /tags must be an array/);
    bad({ tags: [] }, /must not be empty/);
    bad({ case_stage: [] }, /must not be empty/);
    bad({ tags: [''] }, /non-empty strings/);
    bad({ tags: ['a'.repeat(101)] }, /over 100 characters/);
    bad({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }, /over 50 entries/);
    bad({ case_type: '' }, /case_type must be a non-empty string/);
    bad({ case_stage: 'Open' }, /case_stage must be an array/);
    bad({ case_open_after: '01/01/2026' }, /YYYY-MM-DD/);
    bad({ case_open_before: '2026-1-1' }, /YYYY-MM-DD/);
    bad({ channel: 'fax' }, /channel must be 'sms' or 'email'/);
  });

  test('the key set is exactly the compose filter contract', () => {
    expect(Object.keys(seg.SEGMENT_FILTER_KEYS).sort()).toEqual(
      ['case_open_after', 'case_open_before', 'case_stage', 'case_subtype', 'case_type', 'channel', 'tags']);
  });
});

// ─── W: route wiring ─────────────────────────────────────────

describe('segments route wiring', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'campaign.js'), 'utf8');

  test("every segments route sits above /campaigns/:id — or 'segments' is captured as an id", () => {
    const idRoute = SRC.indexOf("router.get('/api/campaigns/:id'");
    expect(idRoute).toBeGreaterThan(0);
    for (const m of ["router.get('/api/campaigns/segments'", "router.post('/api/campaigns/segments'",
      "router.put('/api/campaigns/segments/:id'", "router.patch('/api/campaigns/segments/:id'"]) {
      const at = SRC.indexOf(m);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(idRoute);
    }
  });

  test('each write route answers SegmentError through segmentErrorBody', () => {
    const block = SRC.slice(SRC.indexOf("router.get('/api/campaigns/segments'"), SRC.indexOf("router.post('/api/campaigns/preview'"));
    expect(block.match(/segmentService\.segmentErrorBody\(err\)/g)).toHaveLength(3);
  });
});

// ─── D: mail_bounce_digest ───────────────────────────────────

/** A fake db serving app_settings reads: { key → value }. */
function settingsDb(map) {
  return {
    query: async (sql, params) => {
      if (/FROM app_settings/.test(sql)) {
        const v = map[params[0]];
        return [v === undefined ? [] : [{ value: v }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
const ACTIVITY = {
  window_h: 24,
  campaigns: [{ campaign_id: 7, subject: 'News', status: 'sent', sender: 'news@x', sent: 5, delivered: 4, bounced_hard: 1, complained: 0, unsubscribed: 2 }],
  transports: [{ id: 17, email: 'news@x', held: false, held_reason: null, delivered: 4, bounced_hard: 1, complained: 0, bounce_rate: 0.2, complaint_rate: 0, enough: false, window_h: 24, suppressed: 0, delivery_rate: 0.8 }],
};

describe('mail_bounce_digest', () => {
  const run = (settings, params = {}) => digestFns.mail_bounce_digest(params, settingsDb(settings));
  beforeEach(() => {
    emailService.sendEmail.mockClear();
    mailEvents.bounceDigestData.mockReset();
  });

  test("campaign_bounce_digest_enabled '0' skips before any read — no data query, no email", async () => {
    const r = await run({ campaign_bounce_digest_enabled: '0' });
    expect(r).toEqual({ success: true, output: { enabled: false, sent: false } });
    expect(mailEvents.bounceDigestData).not.toHaveBeenCalled();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('no activity in the window — nothing sent, the run succeeds (an absent row means ON)', async () => {
    mailEvents.bounceDigestData.mockResolvedValue({ window_h: 24, campaigns: [], transports: ACTIVITY.transports });
    const r = await run({});
    expect(r.output).toEqual({ enabled: true, sent: false, activity: false });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('activity sends: digest recipient wins over alert_recipients; alert_from_email over email_automations; counts in the body', async () => {
    mailEvents.bounceDigestData.mockResolvedValue(ACTIVITY);
    const r = await run({ campaign_bounce_digest_email: 'me@firm.test', alert_recipients: 'it@firm.test', alert_from_email: 'alerts@firm.test' });
    expect(r.output).toMatchObject({ enabled: true, sent: true, to: 'me@firm.test', campaigns: 1, transports: 1 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.to).toBe('me@firm.test');
    expect(mail.from).toBe('alerts@firm.test');
    expect(mail.subject).toContain('5 sent');
    expect(mail.subject).toContain('1 bounced');
    expect(mail.html).toContain('News');
    expect(mail.html).toContain('low volume');
    expect(mail.text).toContain('unsubscribes 2');
  });

  test('fallbacks: blank digest address → alert_recipients; blank alert_from_email → email_automations', async () => {
    mailEvents.bounceDigestData.mockResolvedValue(ACTIVITY);
    await run({ campaign_bounce_digest_email: '  ', alert_recipients: 'it@firm.test' });
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.to).toBe('it@firm.test');
    expect(mail.from).toBe('auto@firm.test');
  });

  test('activity with no recipient anywhere THROWS — the failed-job sweep must see it, not a silent pass', async () => {
    mailEvents.bounceDigestData.mockResolvedValue(ACTIVITY);
    await expect(run({})).rejects.toThrow(/no recipient/);
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });

  test('a held transport marks the subject and names the hold', async () => {
    mailEvents.bounceDigestData.mockResolvedValue({
      ...ACTIVITY,
      transports: [{ ...ACTIVITY.transports[0], held: true, held_reason: 'complaint rate 0.40%' }],
    });
    await run({ alert_recipients: 'it@firm.test' });
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.subject).toMatch(/^\[attention\] /);
    expect(mail.html).toContain('HELD — complaint rate 0.40%');
  });

  test('dry_run computes, logs and sends nothing', async () => {
    mailEvents.bounceDigestData.mockResolvedValue(ACTIVITY);
    const r = await run({ alert_recipients: 'it@firm.test' }, { dry_run: true });
    expect(r.output).toMatchObject({ sent: false, dry_run: true, to: 'it@firm.test' });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

// ─── C: CTA exposure ─────────────────────────────────────────

describe('CTA exposure', () => {
  test('mail_bounce_digest is deny-listed — never eligible for a public link plan', () => {
    const cta = require('../services/ctaService');
    expect(cta.eligibleFunctionNames()).not.toContain('mail_bounce_digest');
    expect(cta.isCtaEligible('mail_bounce_digest')).toBe(false);
  });
});
