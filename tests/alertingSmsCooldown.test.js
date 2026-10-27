// tests/alertingSmsCooldown.test.js
//
/**
 * Digest SMS fallback cooldown — lib/alerting.js runErrorSweep Phase B.
 *
 * When the digest email fails the sweep texts "alert email delivery failed".
 * The sweep runs every 15 min, so a relay outage used to text on every run
 * (2026-10-27: four texts for one 40-minute SiteGround SMTP blackout). Now:
 *
 *   - the text goes out at most once per SMS_FALLBACK_COOLDOWN_MS (1 h),
 *     tracked in app_settings.alert_sms_fallback_last_at;
 *   - the stamp is written ONLY when a text actually went out — a skipped
 *     fallback (no number) never starts the window;
 *   - an unreadable stamp fails OPEN (text sends): a lost page is worse than
 *     a repeat;
 *   - the suppressed run is still unhealthy: rows stay undigested and the
 *     heartbeat is not written, so the stale-sweep banner still shows.
 *
 * HARNESS: alertingDigestCta.test.js's shape — a db matched on SQL text with
 * emailService / phoneService / firmConfig mocked at the module boundary.
 *
 * Run: npx jest tests/alertingSmsCooldown.test.js
 */
'use strict';

jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn(async () => { throw new Error('connect ETIMEDOUT'); }),
}));
jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(async () => ({ id: 'sms1' })) }));
jest.mock('../lib/firmConfig', () => ({
  publicUrl: jest.fn(() => 'https://4lsg.com'),
  cfg: jest.fn(() => 'auto@4lsg.com'),
}));

const alerting = require('../lib/alerting');
const phoneService = require('../services/phoneService');

const T1 = new Date('2026-10-27T00:01:23.000Z');
const HOUR = 60 * 60 * 1000;

function undigestedRow(id, group_key) {
  return {
    id, source: 'app', kind: 'mailbox_ingest_failing', group_key, severity: 'error',
    title: `Mailbox ingest failing: ${group_key}`, message: 'IMAP CONNECT_TIMEOUT',
    ref_table: null, ref_id: null, created_at: T1,
    first_seen: T1, last_alerted_at: null, occurrence_count: 3,
  };
}

/**
 * lastSmsAt   → the stored alert_sms_fallback_last_at (ISO string | null)
 * smsTo       → alert_critical_sms_to ('' = fallback skipped)
 * failLastRead→ the alert_sms_fallback_last_at SELECT throws
 */
function makeDb({ lastSmsAt = null, smsTo = '+12485550100', failLastRead = false } = {}) {
  const settingWrites = [];
  const digestedStamps = [];
  const db = {
    settingWrites, digestedStamps,
    query: jest.fn(async (sql, params = []) => {
      if (/FROM app_settings/i.test(sql)) {
        const key = params[0];
        if (key === 'error_sweep_state') {
          return [[{ value: JSON.stringify({
            wf_step_id: 0, job_result_id: 0, seq_log_id: 0, hook_exec_id: 0,
            email_ingest_id: 0, phone_ingest_id: 0, campaign_sent_at: '2026-01-01 00:00:00',
          }) }]];
        }
        if (key === 'alert_recipients') return [[{ value: 'it@4lsg.com' }]];
        if (key === 'alert_from_email') return [[{ value: 'alerts@4lsg.com' }]];
        if (key === 'alert_critical_sms_to') return [[{ value: smsTo }]];
        if (key === 'sms_staff_from') return [[{ value: '+12485550199' }]];
        if (key === 'alert_sms_fallback_last_at') {
          if (failLastRead) throw new Error('app_settings is on fire');
          return [lastSmsAt ? [{ value: lastSmsAt }] : []];
        }
        return [[]];
      }
      if (/INSERT INTO app_settings/i.test(sql)) {
        settingWrites.push({ key: params[0], value: params[1] });
        return [{ affectedRows: 1 }];
      }
      if (/FROM system_alerts a\s+LEFT JOIN alert_state/i.test(sql)) {
        return [[undigestedRow(2131, 'app:mailbox_ingest_failing:1'), undigestedRow(2132, 'app:mailbox_ingest_failing:3')]];
      }
      if (/SELECT `user`, user_auth, roles FROM users/i.test(sql)) return [[]];  // no SU → no buttons
      if (/UPDATE system_alerts SET digested_at/i.test(sql)) {
        digestedStamps.push(params);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE system_alerts SET resolved_at/i.test(sql)) return [{ affectedRows: 0 }];
      return [[]];
    }),
  };
  return db;
}

const stampsOf = (db) => db.settingWrites.filter((w) => w.key === 'alert_sms_fallback_last_at');
const heartbeatsOf = (db) => db.settingWrites.filter((w) => w.key === 'alert_last_sweep_at');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('digest email fails → SMS fallback cooldown', () => {
  test('never texted before → texts, stamps the time, rows stay undigested, no heartbeat', async () => {
    const db = makeDb();
    const t0 = Date.now();
    const out = await alerting.runErrorSweep(db, {});

    expect(out.email_sent).toBe(false);
    expect(out.sms_fallback_used).toBe(true);
    expect(out.sms_fallback_suppressed).toBe(false);
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    expect(phoneService.sendSms.mock.calls[0][3]).toBe('YisraCase: alert email delivery failed. 2 alerts pending.');

    const stamps = stampsOf(db);
    expect(stamps).toHaveLength(1);
    expect(Math.abs(Date.parse(stamps[0].value) - t0)).toBeLessThan(10_000);
    expect(db.digestedStamps).toHaveLength(0);
    expect(heartbeatsOf(db)).toHaveLength(0);
  });

  test('texted 10 min ago → no text, no new stamp, run still unhealthy', async () => {
    const db = makeDb({ lastSmsAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    const out = await alerting.runErrorSweep(db, {});

    expect(out.email_sent).toBe(false);
    expect(out.sms_fallback_used).toBe(false);
    expect(out.sms_fallback_suppressed).toBe(true);
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(stampsOf(db)).toHaveLength(0);
    expect(db.digestedStamps).toHaveLength(0);
    expect(heartbeatsOf(db)).toHaveLength(0);
  });

  test('texted 2 h ago → texts again and re-stamps', async () => {
    const db = makeDb({ lastSmsAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    const out = await alerting.runErrorSweep(db, {});

    expect(out.sms_fallback_used).toBe(true);
    expect(out.sms_fallback_suppressed).toBe(false);
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    expect(stampsOf(db)).toHaveLength(1);
  });

  test('a stamp from the future (clock skew) does not suppress', async () => {
    const db = makeDb({ lastSmsAt: new Date(Date.now() + HOUR).toISOString() });
    const out = await alerting.runErrorSweep(db, {});
    expect(out.sms_fallback_used).toBe(true);
    expect(out.sms_fallback_suppressed).toBe(false);
  });

  test('no SMS number configured → fallback skipped and NO stamp (a skip never starts the window)', async () => {
    const db = makeDb({ smsTo: '' });
    const out = await alerting.runErrorSweep(db, {});

    expect(out.sms_fallback_used).toBe(false);
    expect(out.sms_fallback_suppressed).toBe(false);
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(stampsOf(db)).toHaveLength(0);
  });

  test('stamp unreadable → fails open: the text sends', async () => {
    const db = makeDb({ failLastRead: true });
    const out = await alerting.runErrorSweep(db, {});
    expect(out.sms_fallback_used).toBe(true);
    expect(out.sms_fallback_suppressed).toBe(false);
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
  });
});
