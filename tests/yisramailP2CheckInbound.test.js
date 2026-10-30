/**
 * tests/yisramailP2CheckInbound.test.js — the wf17/wf18 wiring check
 * (scripts/yisramailP2CheckInbound.js) over a stub query function. The one
 * assertion added by the post-P3/P2 review (M-3, 2026-10-30): `link_id` must
 * be wired. ingestPhoneEvent derives firmToFirm from `link_id || to || from`;
 * without link_id an inbound text's "other party" is the FIRM line, every
 * inbound reads firm-to-firm, and phoneConsentService never opens a
 * plain-language review task (`firm_line`). The keyword path is unaffected,
 * which is exactly why nothing else would notice.
 */
'use strict';

const { checkInbound, SQL } = require('../scripts/yisramailP2CheckInbound');

function step1(provider, params) {
  return {
    type: 'internal_function',
    config: JSON.stringify({
      function_name: 'phone_log',
      params: {
        type: 'sms', from: '{{from}}', to: '{{to}}', message: '{{message}}', direction: 'incoming',
        link_id: '{{their_number}}',
        extra: { provider, provider_message_id: '{{id}}', ts: '{{ts}}' },
        ...params,
      },
    }),
  };
}

function makeQ({ rc = {}, quo = {} } = {}) {
  const steps = { 17: step1('ringcentral', rc), 18: step1('quo', quo) };
  return async (sql, params) => {
    if (sql === SQL.workflow) return [{ id: params[0], name: `wf${params[0]}`, active: 1, current_version: 3 }];
    if (sql === SQL.step1) return [steps[params[0]]];
    if (sql === SQL.hooks) return [{ id: 1, slug: 's', hook_active: 1, target_id: 1, target_active: 1 }];
    if (sql === SQL.lastInbound) return [{ processed_at: new Date('2026-10-30T00:00:00Z') }];
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

test('fully wired workflows → GO', async () => {
  const r = await checkInbound(makeQ());
  expect(r.ok).toBe(true);
  expect(r.problems).toEqual([]);
  expect(r.lines.join('\n')).toMatch(/link_id/);
});

test('link_id missing on one workflow → NO-GO naming link_id and the review-task consequence', async () => {
  const r = await checkInbound(makeQ({ quo: { link_id: undefined } }));
  expect(r.ok).toBe(false);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]).toMatch(/link_id/);
  expect(r.problems[0]).toMatch(/review task/);
});

test('link_id blank → NO-GO (a placeholder-shaped empty string is not wired)', async () => {
  const r = await checkInbound(makeQ({ rc: { link_id: '   ' } }));
  expect(r.ok).toBe(false);
  expect(r.problems.some((p) => /link_id/.test(p))).toBe(true);
});
