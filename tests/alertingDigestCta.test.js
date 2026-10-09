// tests/alertingDigestCta.test.js
//
/**
 * Digest CTA buttons — lib/alerting.js Phase B mints a per-group
 * Acknowledge/Resolve /c/ link (ref/CTA_DESIGN.md) and renders the buttons
 * into each group block of the failure-digest email.
 *
 * WHAT IS LOAD-BEARING HERE
 *
 *   1. The mint is REAL. ctaService.mintCta runs unmocked, so the digest's
 *      mint input passes the full §4 gauntlet (eligibility, frozen-literal
 *      params, __validateFunctionParams against set_system_alert_status's
 *      __meta, the repeatable/max_uses rules). A mocked mint would let the
 *      digest drift into an input the service rejects, and the first anyone
 *      would hear of it is a button-less production email.
 *
 *   2. The plan freezes `before` to the GROUP'S LATEST ROW at digest time —
 *      that is the whole safety story: a click days later clears what this
 *      email reported, never rows that arrived after it.
 *
 *   3. Decoration must never cost a digest. No active SU → no buttons,
 *      email still sends. Mint throws → that block renders without buttons,
 *      email still sends, rows still get digested. The alerter is the thing
 *      that tells you when things break; it cannot break because its
 *      buttons did.
 *
 * HARNESS: alertingStartLatency.test.js's shape — a db matched on SQL text
 * (unmatched SELECTs return [[]], making the Phase A scanners inert), with
 * emailService and firmConfig mocked at the module boundary. Everything
 * between runErrorSweep and the INSERT INTO cta_links is real code.
 *
 * Run: npx jest tests/alertingDigestCta.test.js
 */
'use strict';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(async () => ({})) }));
jest.mock('../lib/firmConfig', () => ({
  publicUrl: jest.fn(() => 'https://4lsg.com'),
  cfg: jest.fn(() => 'auto@4lsg.com'),
}));

const alerting = require('../lib/alerting');
const emailService = require('../services/emailService');

const TOKEN_RE = /^[0-9A-Za-z]{22}$/;
const T1 = new Date('2026-10-09T11:23:31.000Z');
const T2 = new Date('2026-10-09T11:40:00.000Z');

const GROUP_A = 'route_500:/api/mail/mailboxes';
const GROUP_B = 'route_500:/api/mail/messages';

function undigestedRow(id, group_key, created_at) {
  return {
    id, source: 'app', kind: 'route_500', group_key, severity: 'error',
    title: `500 on GET ${group_key.slice('route_500:'.length)}`,
    message: '{"status":"error","message":"Mail request failed"}',
    ref_table: null, ref_id: null, created_at,
    first_seen: created_at, last_alerted_at: null, occurrence_count: 1,
  };
}

/**
 * suRows        → the `SELECT user, user_auth FROM users` answer
 * failCtaInsert → INSERT INTO cta_links throws (the resilience case)
 */
function makeDb({ undigested = [], suRows = [], failCtaInsert = false } = {}) {
  const ctaInserts = [];
  const digestedStamps = [];
  let nextCtaId = 1;

  const db = {
    ctaInserts, digestedStamps,
    query: jest.fn(async (sql, params = []) => {
      // ── settings ────────────────────────────────────────────────────────
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
        return [[]];
      }
      if (/INSERT INTO app_settings/i.test(sql)) return [{ affectedRows: 1 }];

      // ── Phase B inputs ──────────────────────────────────────────────────
      if (/FROM system_alerts a\s+LEFT JOIN alert_state/i.test(sql)) return [undigested];
      if (/SELECT `user`, user_auth FROM users/i.test(sql)) return [suRows];

      // ── the CTA mint (real ctaService) ──────────────────────────────────
      if (/INSERT INTO cta_links/i.test(sql)) {
        if (failCtaInsert) throw new Error('cta_links is on fire');
        ctaInserts.push({ sql, params });
        return [{ affectedRows: 1, insertId: nextCtaId++ }];
      }

      // ── Phase B stamps ──────────────────────────────────────────────────
      if (/UPDATE system_alerts SET digested_at = NOW\(\) WHERE id IN/i.test(sql)) {
        digestedStamps.push({ sql, params });
        return [{ affectedRows: params[0].length }];
      }
      if (/INSERT INTO alert_state/i.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE system_alerts SET resolved_at/i.test(sql)) return [{ affectedRows: 0 }];

      // Everything else (the seven stream scanners, oauth, stuck, latency)
      // returns an empty set — this file is only about the digest buttons.
      return [[]];
    }),
  };
  return db;
}

/** The parsed cta_links insert: positional params per ctaService.mintCta. */
function parseMint(ins) {
  const p = ins.params;
  return {
    token: p[0], name: p[1], prompt: p[2], options: JSON.parse(p[4]),
    mode: p[5], max_uses: p[6], expires_at: p[7], protection: p[9],
    password_hash: p[10], mint_source: p[13], source_execution_id: p[14],
    minted_by: p[15],
  };
}

const SU = [{ user: 1, user_auth: 'authorized - SU' }];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('digest buttons', () => {
  test('mints one su-attributed repeatable CTA per group, before frozen to the latest row, buttons in the html', async () => {
    const t0 = Date.now();
    const db = makeDb({
      undigested: [undigestedRow(163, GROUP_A, T1), undigestedRow(164, GROUP_B, T2)],
      suRows: SU,
    });

    const out = await alerting.runErrorSweep(db, {});

    expect(out.email_sent).toBe(true);
    expect(db.ctaInserts).toHaveLength(2);

    const mints = db.ctaInserts.map(parseMint);
    const byGroup = { [GROUP_A]: T1, [GROUP_B]: T2 };
    for (const m of mints) {
      expect(m.token).toMatch(TOKEN_RE);
      expect(m.mode).toBe('repeatable');
      expect(m.max_uses).toBe(4);
      expect(m.protection).toBe('none');
      expect(m.password_hash).toBeNull();
      expect(m.mint_source).toBe('su');
      expect(m.minted_by).toBe(1);
      // the week limit, applied as an explicit timeout at mint
      const exp = new Date(m.expires_at).getTime();
      expect(Math.abs(exp - (t0 + 7 * 24 * 3600 * 1000))).toBeLessThan(60 * 1000);

      expect(m.options.map((o) => o.value)).toEqual(['ack', 'resolve']);
      const group = m.options[0].plan[0].params.group_key;
      expect(byGroup[group]).toBeDefined();
      for (const o of m.options) {
        expect(o.plan).toEqual([{
          fn: 'set_system_alert_status',
          params: {
            action: o.value, group_key: group,
            before: byGroup[group].toISOString(),   // frozen to the group's latest row
            by: 'email-digest',
          },
        }]);
      }
    }
    // two groups, two distinct links
    expect(new Set(mints.map((m) => m.options[0].plan[0].params.group_key)).size).toBe(2);
    expect(new Set(mints.map((m) => m.token)).size).toBe(2);

    const { html } = emailService.sendEmail.mock.calls[0][1];
    for (const m of mints) {
      expect(html).toContain(`https://4lsg.com/c/${m.token}/ack`);
      expect(html).toContain(`https://4lsg.com/c/${m.token}/resolve`);
    }
    expect(html).toContain('Acknowledge/Resolve act only on the failures in this email');

    // the digest itself is unchanged: both rows stamped
    expect(db.digestedStamps).toHaveLength(1);
    expect(db.digestedStamps[0].params[0].sort()).toEqual([163, 164]);
  });

  test('no active SU → no mints, no buttons, the digest still sends', async () => {
    const db = makeDb({ undigested: [undigestedRow(163, GROUP_A, T1)], suRows: [] });
    const out = await alerting.runErrorSweep(db, {});

    expect(out.email_sent).toBe(true);
    expect(db.ctaInserts).toHaveLength(0);
    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).not.toContain('/c/');
    expect(html).not.toContain('Acknowledge/Resolve act only');
    expect(db.digestedStamps).toHaveLength(1);
  });

  test('a mint that throws costs the buttons, never the digest', async () => {
    const db = makeDb({
      undigested: [undigestedRow(163, GROUP_A, T1)],
      suRows: SU,
      failCtaInsert: true,
    });
    const out = await alerting.runErrorSweep(db, {});

    expect(out.email_sent).toBe(true);
    const { html } = emailService.sendEmail.mock.calls[0][1];
    expect(html).toContain(GROUP_A);        // the block itself is intact
    expect(html).not.toContain('/c/');      // just without buttons
    expect(db.digestedStamps).toHaveLength(1);
  });
});
