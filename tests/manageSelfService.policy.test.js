/**
 * tests/manageSelfService.policy.test.js
 *
 * The 2026-09 self-service policy gate on the client manage page
 * (routes/manage.js). Manage links (/m/<token>) had been going out to real
 * clients before the firm approved self-rescheduling; this gate makes each
 * action independently switchable via app_settings:
 *
 *   manage_allow_cancel      — cancel a Scheduled appt
 *   manage_allow_reschedule  — move a Scheduled appt
 *   manage_allow_rebook      — Canceled appt offers "pick a new time"
 *
 * WHAT THIS PROTECTS
 *
 * 1. FAIL-CLOSED DEFAULTS. A deploy without the seeding migration (or a
 *    deleted/garbled row) must land on cancel=ON, reschedule=OFF, rebook=OFF —
 *    the approved policy — not on "everything on" (the pre-gate behavior).
 *    If someone later flips DEFAULT_ALLOW_RESCHEDULE to true "because the
 *    setting exists anyway", this file is the fence.
 *
 * 2. THE CANCEL→REBOOK BACKDOOR. computeCanRebook is deliberately
 *    time-unbounded (lead reactivation), which means rebook-on with
 *    reschedule-off is NOT a restriction: cancel, then rebook, is a
 *    reschedule in two clicks. The gate must therefore close rebook
 *    independently of the Canceled row's age or shape.
 *
 * 3. WINDOW SEMANTICS UNCHANGED. The allow_* flags are pure policy ANDs on
 *    top of the pre-split window check (Scheduled + sane length + start >
 *    now+cutoff). Flags on must reproduce the old computeCanModify results
 *    exactly; flags must never RESURRECT an appt the window already rejects.
 *
 * The compute functions and loadManageSettings are reached via the module's
 * _test surface — the export itself is still the router server.js mounts.
 */

const {
  loadManageSettings,
  computeWindowOk,
  computeCanCancel,
  computeCanReschedule,
  computeCanRebook,
  DEFAULT_ALLOW_CANCEL,
  DEFAULT_ALLOW_RESCHEDULE,
  DEFAULT_ALLOW_REBOOK,
} = require('../routes/manage')._test;

const { DateTime } = require('luxon');
const { FIRM_TZ }  = require('../services/timezoneService');

// ── Helpers ──────────────────────────────────────────────────

/** Firm-local 'YYYY-MM-DD HH:mm' offset from now — the appt_start shape. */
function startIn(minutes) {
  return DateTime.now().setZone(FIRM_TZ).plus({ minutes }).toFormat('yyyy-MM-dd HH:mm');
}

/** A modifiable Scheduled appt: tomorrow-ish, sane length. */
function scheduledAppt(over = {}) {
  return { appt_status: 'Scheduled', appt_length: 30, appt_start: startIn(24 * 60), ...over };
}

function canceledAppt(over = {}) {
  return { appt_status: 'Canceled', appt_length: 30, appt_start: startIn(-24 * 60), ...over };
}

/** cfg shaped like loadManageSettings output; flags default to ALL ON so each
 *  test states the flag it is turning off. cutoff mirrors the live default. */
function cfg(over = {}) {
  return { cutoff_min: 240, allow_cancel: true, allow_reschedule: true, allow_rebook: true, ...over };
}

/** db stub for loadManageSettings — returns the given app_settings rows. */
function dbWithSettings(map) {
  return {
    query: jest.fn(async (sql, [keys]) => {
      const rows = keys.filter((k) => k in map).map((k) => ({ key: k, value: map[k] }));
      return [rows];
    }),
  };
}

// ── 1. Fail-closed defaults ──────────────────────────────────

describe('policy defaults (missing/blank/garbage settings rows)', () => {
  test('hard-coded defaults ARE the approved policy: cancel on, reschedule/rebook off', () => {
    expect(DEFAULT_ALLOW_CANCEL).toBe(true);
    expect(DEFAULT_ALLOW_RESCHEDULE).toBe(false);
    expect(DEFAULT_ALLOW_REBOOK).toBe(false);
  });

  test('no manage_allow_* rows at all → defaults apply', async () => {
    const c = await loadManageSettings(dbWithSettings({}));
    expect(c.allow_cancel).toBe(true);
    expect(c.allow_reschedule).toBe(false);
    expect(c.allow_rebook).toBe(false);
  });

  test.each([
    ['', 'blank'],
    ['   ', 'whitespace'],
    ['maybe', 'garbage'],
    ['2', 'out-of-range number'],
  ])('unparseable value %j (%s) falls back to the default, not to true', async (v) => {
    const c = await loadManageSettings(dbWithSettings({
      manage_allow_cancel: v, manage_allow_reschedule: v, manage_allow_rebook: v,
    }));
    expect(c.allow_cancel).toBe(true);        // default
    expect(c.allow_reschedule).toBe(false);   // default — NOT permissive
    expect(c.allow_rebook).toBe(false);       // default — NOT permissive
  });

  test.each(['1', 'true', 'yes', 'on', ' 1 ', 'TRUE'])('%j parses as allowed', async (v) => {
    const c = await loadManageSettings(dbWithSettings({ manage_allow_reschedule: v }));
    expect(c.allow_reschedule).toBe(true);
  });

  test.each(['0', 'false', 'no', 'off', ' 0 ', 'FALSE'])('%j parses as blocked (even for cancel, whose default is on)', async (v) => {
    const c = await loadManageSettings(dbWithSettings({ manage_allow_cancel: v }));
    expect(c.allow_cancel).toBe(false);
  });
});

// ── 2. Per-action gating ─────────────────────────────────────

describe('per-action gates on a window-OK Scheduled appt', () => {
  const appt = scheduledAppt();

  test('sanity: the window itself passes', () => {
    expect(computeWindowOk(appt, 240)).toBe(true);
  });

  test('reschedule OFF blocks reschedule but leaves cancel alone', () => {
    const c = cfg({ allow_reschedule: false });
    expect(computeCanReschedule(appt, c)).toBe(false);
    expect(computeCanCancel(appt, c)).toBe(true);
  });

  test('cancel OFF blocks cancel but leaves reschedule alone', () => {
    const c = cfg({ allow_cancel: false });
    expect(computeCanCancel(appt, c)).toBe(false);
    expect(computeCanReschedule(appt, c)).toBe(true);
  });

  test('both ON reproduces the pre-split behavior (window decides)', () => {
    const c = cfg();
    expect(computeCanCancel(appt, c)).toBe(true);
    expect(computeCanReschedule(appt, c)).toBe(true);
  });
});

describe('flags never resurrect what the window rejects', () => {
  const allOn = cfg();

  test.each([
    ['inside cutoff',          scheduledAppt({ appt_start: startIn(60) })],
    ['already Canceled',       canceledAppt()],
    ['status Attended',        scheduledAppt({ appt_status: 'Attended' })],
    ['NULL length (legacy)',   scheduledAppt({ appt_length: null })],
    ['zero length',            scheduledAppt({ appt_length: 0 })],
    ['garbage start',          scheduledAppt({ appt_start: 'not-a-date' })],
  ])('%s stays blocked for cancel AND reschedule with every flag on', (_label, appt) => {
    expect(computeCanCancel(appt, allOn)).toBe(false);
    expect(computeCanReschedule(appt, allOn)).toBe(false);
  });
});

// ── 3. The cancel→rebook backdoor ────────────────────────────

describe('rebook gate (the reschedule backdoor)', () => {
  test('rebook OFF closes the Canceled → "pick a new time" path outright', () => {
    // The exact two-click loophole: a fresh, perfectly rebookable Canceled
    // appt. With allow_rebook=false it must be a dead end regardless.
    expect(computeCanRebook(canceledAppt(), cfg({ allow_rebook: false }))).toBe(false);
  });

  test('rebook ON keeps the pre-split semantics: Canceled + sane length, unbounded in time', () => {
    const c = cfg();
    expect(computeCanRebook(canceledAppt(), c)).toBe(true);
    // Time-unbounded by design — an ancient cancellation still rebooks.
    expect(computeCanRebook(canceledAppt({ appt_start: '2024-01-01 09:00' }), c)).toBe(true);
    // But shape rules still hold: legacy NULL length can't re-verify slots.
    expect(computeCanRebook(canceledAppt({ appt_length: null }), c)).toBe(false);
    // And only Canceled rows rebook.
    expect(computeCanRebook(scheduledAppt(), c)).toBe(false);
  });
});
