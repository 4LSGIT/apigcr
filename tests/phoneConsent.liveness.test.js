/**
 * tests/phoneConsent.liveness.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * phoneConsentService.inboundLivenessCheck — inbound texts are the only way a
 * STOP reaches YC, so a provider gone quiet must page: per provider with an
 * active line, the newest ingested inbound SMS older than
 * sms_inbound_liveness_hours (default 72) alerts — warning first, error when
 * the previous run already alerted (36 h window) — with a per-day dedup key;
 * a provider with no active line is never checked. And the nightly skin
 * fns.sms_consent_sync: both halves run, a throw in either fails the run.
 * The liveness SQL runs on the engine in tests/phoneConsent.mysql.test.js —
 * here the db answers by statement text.
 */
'use strict';

jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(), getSettings: jest.fn() }));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const settingsService = require('../services/settingsService');
const alerting = require('../lib/alerting');
const svc = require('../services/phoneConsentService');

function db({ providers = ['quo', 'ringcentral'], silentMin = {}, repeat = false } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, p) {
      seen.push([sql.replace(/\s+/g, ' ').trim(), p]);
      if (/SELECT DISTINCT provider FROM phone_lines WHERE active = 1/.test(sql)) return [providers.map((provider) => ({ provider }))];
      if (/FROM phone_event_log/.test(sql)) {
        const m = silentMin[p[0]];
        return [m === undefined ? [] : [{ processed_at: new Date(Date.now() - m * 60000), silent_min: m }]];
      }
      if (/FROM system_alerts/.test(sql)) return [repeat ? [{ hit: 1 }] : []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSetting.mockResolvedValue(null);
});

test('within the threshold: no alert; the query reads inbound SMS per provider, newest first', async () => {
  const d = db({ silentMin: { quo: 60 * 20, ringcentral: 5 } });
  const out = await svc.inboundLivenessCheck(d);
  expect(out).toEqual([
    { provider: 'quo', last_at: expect.any(Date), silent_hours: 20, alerted: null },
    { provider: 'ringcentral', last_at: expect.any(Date), silent_hours: 0, alerted: null },
  ]);
  expect(alerting.alert).not.toHaveBeenCalled();
  const q = d.seen.find(([s]) => /FROM phone_event_log/.test(s))[0];
  expect(q).toMatch(/WHERE provider = \? AND event_type = 'sms' AND direction = 'incoming' ORDER BY processed_at DESC LIMIT 1/);
});

test('past 72 h (the default): a warning, deduped per provider per day', async () => {
  const out = await svc.inboundLivenessCheck(db({ silentMin: { quo: 73 * 60, ringcentral: 10 } }));
  expect(out[0]).toMatchObject({ provider: 'quo', silent_hours: 73, alerted: 'warning' });
  expect(alerting.alert).toHaveBeenCalledTimes(1);
  const o = alerting.alert.mock.calls[0][1];
  expect(o).toMatchObject({ severity: 'warning', group_key: 'sms_inbound_liveness:quo', kind: 'sms_inbound_silent' });
  expect(o.dedup_key).toMatch(/^sms_inbound_liveness:quo:warning:\d{4}-\d{2}-\d{2}$/);
  expect(o.message).toMatch(/yisramailP2CheckInbound/);
});

test('still silent on the next run → error; a provider that never sent counts as silent', async () => {
  const out = await svc.inboundLivenessCheck(db({ silentMin: { ringcentral: 10 }, repeat: true }));
  expect(out[0]).toMatchObject({ provider: 'quo', last_at: null, silent_hours: null, alerted: 'error' });
  expect(alerting.alert.mock.calls[0][1].severity).toBe('error');
});

test('the threshold setting is honoured; blank / zero / junk fall back to 72', async () => {
  settingsService.getSetting.mockImplementation(async (_d, k) => (k === svc.LIVENESS_HOURS_KEY ? '24' : null));
  expect((await svc.inboundLivenessCheck(db({ silentMin: { quo: 25 * 60, ringcentral: 0 } })))[0].alerted).toBe('warning');
  for (const v of ['', '0', 'soon', '-5']) {
    alerting.alert.mockClear();
    settingsService.getSetting.mockImplementation(async () => v);
    await svc.inboundLivenessCheck(db({ silentMin: { quo: 71 * 60, ringcentral: 0 } }));
    expect(alerting.alert).not.toHaveBeenCalled();
  }
});

test('only providers with an active line are checked', async () => {
  const d = db({ providers: ['ringcentral'], silentMin: { ringcentral: 1 } });
  const out = await svc.inboundLivenessCheck(d);
  expect(out.map((r) => r.provider)).toEqual(['ringcentral']);
});

describe('fns.sms_consent_sync (the nightly skin)', () => {
  const fns = require('../lib/internal_functions/consent');

  test('runs the reconcile then the liveness check, passes dry_run through', async () => {
    const a = jest.spyOn(svc, 'syncRcConsents').mockResolvedValue({ enabled: false, dry_run: true, groups: 0, errors: [] });
    const b = jest.spyOn(svc, 'inboundLivenessCheck').mockResolvedValue([{ provider: 'quo', silent_hours: 1, alerted: null }]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await fns.sms_consent_sync({ dry_run: 'true' }, {});
    expect(a).toHaveBeenCalledWith({}, { dryRun: true });
    expect(b).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ success: true, output: { reconcile: { enabled: false, dry_run: true, groups: 0, errors: [] }, liveness: [{ provider: 'quo', silent_hours: 1, alerted: null }] } });
    a.mockRestore(); b.mockRestore(); log.mockRestore();
  });

  test('a throw in the reconcile still runs the liveness check, then fails the run', async () => {
    const a = jest.spyOn(svc, 'syncRcConsents').mockRejectedValue(new Error('RC down'));
    const b = jest.spyOn(svc, 'inboundLivenessCheck').mockResolvedValue([]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(fns.sms_consent_sync({}, {})).rejects.toThrow('sms_consent_sync failed — reconcile: RC down');
    expect(a).toHaveBeenCalledWith({}, { dryRun: false });
    expect(b).toHaveBeenCalledTimes(1);
    a.mockRestore(); b.mockRestore(); log.mockRestore();
  });
});
