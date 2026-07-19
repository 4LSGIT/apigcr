/**
 * Tests for the PURE section of public/esign/esignActions.js (Phase 2C).
 *
 * The file is a browser <script> whose browser half is guarded behind
 * `typeof window !== 'undefined'`, so requiring it under node jest loads
 * only the pure helpers (status→chip map, action-availability rules,
 * days-pending / date formatting, recipient summarizer, event-line
 * formatter). No DOM, no network, no jsdom — matching the repo's
 * node-only test environment.
 *
 * The action-availability rules MIRROR the service constants in
 * services/esignSendService.js (REMINDABLE, SATISFIABLE, RESENDABLE_SAME_ROW)
 * and esignService.TERMINAL — the cross-check block at the bottom requires
 * the real services and asserts the mirrors have not drifted.
 *
 *   npx jest tests/esignActionsUi.test.js
 */

const ui = require('../public/esign/esignActions');

// ─── status → chip ───────────────────────────────────────────

describe('esignStatusChip', () => {
  test('maps every known status', () => {
    for (const s of [
      'draft', 'sent', 'viewed', 'signed', 'declined',
      'expired', 'recalled', 'bounced', 'satisfied_external',
    ]) {
      const chip = ui.esignStatusChip(s);
      expect(chip.label).toBeTruthy();
      expect(chip.bg).toMatch(/^#/);
      expect(chip.fg).toMatch(/^#/);
    }
  });

  test('spec colors: sent/viewed amber-family, signed green, failures red, closed gray', () => {
    expect(ui.esignStatusChip('signed').bg).toBe('#059669');
    expect(ui.esignStatusChip('recalled').bg).toBe('#6b7280');
    expect(ui.esignStatusChip('satisfied_external').bg).toBe('#6b7280');
    for (const s of ['declined', 'bounced', 'expired']) {
      expect(['#dc2626', '#ef4444', '#b91c1c']).toContain(ui.esignStatusChip(s).bg);
    }
  });

  test('unknown status degrades to a gray chip with the raw label, never throws', () => {
    const chip = ui.esignStatusChip('weird_future_status');
    expect(chip.label).toBe('weird_future_status');
    expect(chip.bg).toBe('#6b7280');
    expect(ui.esignStatusChip(null).label).toBe('?');
  });
});

// ─── action availability rules ───────────────────────────────

describe('action availability', () => {
  test('terminal set', () => {
    for (const s of ['signed', 'declined', 'expired', 'recalled', 'satisfied_external']) {
      expect(ui.esignIsTerminal(s)).toBe(true);
    }
    for (const s of ['draft', 'sent', 'viewed', 'bounced']) {
      expect(ui.esignIsTerminal(s)).toBe(false);
    }
  });

  test('remind only while awaiting signature (sent/viewed)', () => {
    expect(ui.esignCanRemind('sent')).toBe(true);
    expect(ui.esignCanRemind('viewed')).toBe(true);
    for (const s of ['draft', 'bounced', 'signed', 'declined', 'expired', 'recalled', 'satisfied_external']) {
      expect(ui.esignCanRemind(s)).toBe(false);
    }
  });

  test('recall on any non-terminal status', () => {
    for (const s of ['draft', 'sent', 'viewed', 'bounced']) expect(ui.esignCanRecall(s)).toBe(true);
    for (const s of ['signed', 'declined', 'expired', 'recalled', 'satisfied_external']) {
      expect(ui.esignCanRecall(s)).toBe(false);
    }
    expect(ui.esignCanRecall(null)).toBe(false);
  });

  test('satisfy externally: sent/viewed/bounced only', () => {
    for (const s of ['sent', 'viewed', 'bounced']) expect(ui.esignCanSatisfy(s)).toBe(true);
    for (const s of ['draft', 'signed', 'declined', 'expired', 'recalled', 'satisfied_external']) {
      expect(ui.esignCanSatisfy(s)).toBe(false);
    }
  });

  test('resend mode: bounced→same-row, declined/recalled/expired→duplicate, else null', () => {
    expect(ui.esignResendMode('bounced')).toBe('bounced');
    for (const s of ['declined', 'recalled', 'expired']) {
      expect(ui.esignResendMode(s)).toBe('duplicate');
    }
    // signed and satisfied_external are terminal but NOT duplicable — there is
    // nothing left to re-do; and active statuses must be recalled first.
    for (const s of ['signed', 'satisfied_external', 'sent', 'viewed', 'draft', null]) {
      expect(ui.esignResendMode(s)).toBe(null);
    }
  });
});

// ─── days pending ────────────────────────────────────────────

describe('esignDaysPending', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');

  test('floors whole days', () => {
    expect(ui.esignDaysPending('2026-07-19T02:00:00Z', now)).toBe(0);
    expect(ui.esignDaysPending('2026-07-18T12:00:00Z', now)).toBe(1);
    expect(ui.esignDaysPending('2026-07-12T13:00:00Z', now)).toBe(6);
    expect(ui.esignDaysPending('2026-07-12T11:00:00Z', now)).toBe(7);
  });

  test('null on missing/garbage sent_at; clock-skew future clamps to 0', () => {
    expect(ui.esignDaysPending(null, now)).toBe(null);
    expect(ui.esignDaysPending('', now)).toBe(null);
    expect(ui.esignDaysPending('not a date', now)).toBe(null);
    expect(ui.esignDaysPending('2026-07-20T00:00:00Z', now)).toBe(0);
  });
});

// ─── date formatting ─────────────────────────────────────────

describe('date formatting', () => {
  test('fmtDate renders Mon D, YYYY and empty on bad input', () => {
    expect(ui.esignFmtDate('2026-07-19T15:00:00Z')).toMatch(/Jul 1[89], 2026/); // tz-dependent day
    expect(ui.esignFmtDate('')).toBe('');
    expect(ui.esignFmtDate(null)).toBe('');
    expect(ui.esignFmtDate('garbage')).toBe('');
  });

  test('fmtDateTime carries a time component', () => {
    expect(ui.esignFmtDateTime('2026-07-19T15:00:00Z')).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(ui.esignFmtDateTime(null)).toBe('');
  });
});

// ─── initials + recipient state ──────────────────────────────

describe('recipient helpers', () => {
  test('initials: first+last, single-name, email fallback', () => {
    expect(ui.esignInitials('Jane Q Smith', null)).toBe('JS');
    expect(ui.esignInitials('Cher', null)).toBe('CH');
    expect(ui.esignInitials('', 'debtor@example.com')).toBe('DE');
    expect(ui.esignInitials(null, null)).toBe('??');
  });

  test('state map: signed tick, viewed eye, declined/bounced cross, default clock', () => {
    expect(ui.esignRecipientState('signed')).toMatchObject({ icon: 'fa-check', cls: 'esr-green' });
    expect(ui.esignRecipientState('viewed')).toMatchObject({ icon: 'fa-eye', cls: 'esr-amber' });
    expect(ui.esignRecipientState('declined')).toMatchObject({ icon: 'fa-xmark', cls: 'esr-red' });
    expect(ui.esignRecipientState('bounced')).toMatchObject({ icon: 'fa-xmark', cls: 'esr-red' });
    expect(ui.esignRecipientState('pending')).toMatchObject({ icon: 'fa-clock', cls: 'esr-gray' });
    expect(ui.esignRecipientState(undefined)).toMatchObject({ icon: 'fa-clock' });
  });

  test('summary carries initials + hover title with name, email and state', () => {
    const out = ui.esignRecipientsSummary([
      { name: 'Jane Smith', email: 'jane@x.com', status: 'signed' },
      { name: null, email: 'joe@x.com', status: 'pending' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].initials).toBe('JS');
    expect(out[0].title).toContain('jane@x.com');
    expect(out[0].title).toContain('Signed');
    expect(out[1].initials).toBe('JO');
    expect(out[1].title).toContain('Awaiting signature');
  });

  test('non-array recipients degrade to empty, never throw', () => {
    expect(ui.esignRecipientsSummary(null)).toEqual([]);
    expect(ui.esignRecipientsSummary('nope')).toEqual([]);
  });
});

// ─── event timeline lines ────────────────────────────────────

describe('esignEventLine', () => {
  test('headline per event type', () => {
    expect(ui.esignEventLine({ event: 'created' })).toBe('Request created');
    expect(ui.esignEventLine({ event: 'signed', recipient_email: 'j@x.com' }))
      .toBe('Signed — j@x.com');
    expect(ui.esignEventLine({ event: 'recalled', payload: { reason: 'wrong doc' } }))
      .toContain('wrong doc');
    expect(ui.esignEventLine({ event: 'send_failed', payload: { error: 'Zoho 400' } }))
      .toContain('Zoho 400');
    expect(ui.esignEventLine({ event: 'superseded_by', payload: { new_request_id: 42 } }))
      .toContain('#42');
    expect(ui.esignEventLine({ event: 'duplicates', payload: { previous_request_id: 7 } }))
      .toContain('#7');
    expect(ui.esignEventLine({ event: 'reminded' })).toContain('all pending');
  });

  test('unknown event falls back to its raw name; null-safe', () => {
    expect(ui.esignEventLine({ event: 'future_event' })).toBe('future_event');
    expect(ui.esignEventLine(null)).toBe('');
  });
});

// ─── escaping ────────────────────────────────────────────────

describe('esignEsc', () => {
  test('escapes the text-node trio', () => {
    expect(ui.esignEsc('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;"x"&lt;/b&gt;');
    expect(ui.esignEsc(null)).toBe('');
  });
});

// ─── drift guard against the services ────────────────────────
// The UI mirrors the service's state sets. If the service constants move,
// this block fails with a message naming the mirror to update.

describe('mirrors of service state sets have not drifted', () => {
  const esignService = require('../services/esignService');

  test('TERMINAL matches esignService.TERMINAL', () => {
    const svc = [...esignService.TERMINAL].sort();
    const mine = ['signed', 'declined', 'expired', 'recalled', 'satisfied_external']
      .filter((s) => ui.esignIsTerminal(s)).sort();
    expect(mine).toEqual(svc);
    // and nothing outside the set sneaks in
    for (const s of esignService.STATUSES) {
      expect(ui.esignIsTerminal(s)).toBe(esignService.TERMINAL.has(s));
    }
  });

  test('remind/satisfy/resend availability matches sendService constants', () => {
    // These are module-private in esignSendService, so assert against the
    // documented values (REMINDABLE sent/viewed; SATISFIABLE sent/viewed/
    // bounced; RESENDABLE_SAME_ROW bounced). If the service changes those
    // sets, update BOTH this test and esignActions.js.
    const esignServiceStatuses = require('../services/esignService').STATUSES;
    for (const s of esignServiceStatuses) {
      expect(ui.esignCanRemind(s)).toBe(s === 'sent' || s === 'viewed');
      expect(ui.esignCanSatisfy(s)).toBe(s === 'sent' || s === 'viewed' || s === 'bounced');
      expect(ui.esignResendMode(s) === 'bounced').toBe(s === 'bounced');
      expect(ui.esignResendMode(s) === 'duplicate')
        .toBe(s === 'declined' || s === 'recalled' || s === 'expired');
    }
  });
});