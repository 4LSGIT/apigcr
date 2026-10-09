// tests/systemAlertStatusFn.test.js
//
/**
 * set_system_alert_status (lib/internal_functions/system.js) — the
 * automation-side ack/resolve for system_alerts groups, scoped by a
 * created_at cutoff. Companion to routes/admin.systemAlerts.js and the
 * write path behind the failure-digest CTA buttons (lib/alerting.js).
 *
 * WHAT IS LOCKED
 *   - The WHERE scope: group_key equality, created_at <= cutoff, and the
 *     open-row guards (ack touches only un-acked un-resolved rows; resolve
 *     touches only un-resolved rows). These guards ARE the feature — a CTA
 *     clicked days after the digest must clear exactly what that email
 *     reported, never rows that arrived after it.
 *   - Resolve implies ack and PRESERVES an existing ack's attribution
 *     (COALESCE), exactly like the admin route.
 *   - Bad params fail soft ({success:false}) with ZERO queries — a CTA plan
 *     step must fail its execution row, not throw into the runner.
 *   - CTA eligibility: the function is in the eligible set (the deliberate
 *     exposure decision — see tests/ctaService.test.js EXPECTED_ELIGIBLE)
 *     and its __meta validates the exact params the digest mints freeze.
 *
 * HARNESS: the REAL registry function against a mini evaluator in the
 * ctaWorld spirit — every UPDATE is EVALUATED from its own SET and WHERE
 * text against stored rows, so dropping a guard from the SQL changes
 * behavior here instead of passing against a scripted affectedRows. An
 * unknown clause THROWS (no silent default).
 *
 * Run: npx jest tests/systemAlertStatusFn.test.js
 */
'use strict';

const registry = require('../lib/internal_functions');
const cta = require('../services/ctaService');

const fn = registry.set_system_alert_status;

// ─────────────────────────────────────────────────────────────
// Mini system_alerts store + UPDATE evaluator
// ─────────────────────────────────────────────────────────────

function makeDb(rows) {
  const store = rows.map((r) => ({ acked_at: null, acked_by: null, resolved_at: null, ...r }));
  const calls = [];
  return {
    rows: store,
    calls,
    byId: (id) => store.find((r) => r.id === id),
    query: jest.fn(async (sql, params = []) => {
      calls.push({ sql, params });
      const m = /^UPDATE system_alerts\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*)$/i.exec(sql.trim());
      if (!m) throw new Error(`fake db: unknown statement: ${sql}`);
      const now = new Date();
      // Positional params consumed by cursor, in placeholder order: SET first,
      // then WHERE. (A cursor rather than popping the array — this is a
      // clause evaluator over ONE statement's params, not a scripted-results
      // queue; see tests/scriptGuardCoverage.test.js.)
      let pi = 0;
      const nextParam = () => params[pi++];
      // Depth-0 comma split: COALESCE(acked_at, NOW()) carries a comma of its own.
      const splitSet = (s) => {
        const out = []; let depth = 0; let cur = '';
        for (const c of s) {
          if (c === '(') depth++;
          if (c === ')') depth--;
          if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
          cur += c;
        }
        out.push(cur);
        return out;
      };
      const setters = splitSet(m[1]).map((s) => s.trim()).map((assign) => {
        if (/^acked_at = NOW\(\)$/i.test(assign)) return (r) => { r.acked_at = now; };
        if (/^acked_by = \?$/i.test(assign)) { const v = nextParam(); return (r) => { r.acked_by = v; }; }
        if (/^resolved_at = NOW\(\)$/i.test(assign)) return (r) => { r.resolved_at = now; };
        if (/^acked_at = COALESCE\(acked_at, NOW\(\)\)$/i.test(assign)) return (r) => { if (r.acked_at == null) r.acked_at = now; };
        if (/^acked_by = COALESCE\(acked_by, \?\)$/i.test(assign)) { const v = nextParam(); return (r) => { if (r.acked_by == null) r.acked_by = v; }; }
        throw new Error(`fake db: unknown SET clause: ${assign}`);
      });
      const preds = m[2].split(/\s+AND\s+/i).map((c) => c.trim()).map((cond) => {
        if (/^group_key = \?$/i.test(cond)) { const v = nextParam(); return (r) => r.group_key === v; }
        if (/^created_at <= \?$/i.test(cond)) { const v = nextParam(); return (r) => r.created_at.getTime() <= new Date(v).getTime(); }
        if (/^acked_at IS NULL$/i.test(cond)) return (r) => r.acked_at == null;
        if (/^resolved_at IS NULL$/i.test(cond)) return (r) => r.resolved_at == null;
        throw new Error(`fake db: unknown WHERE clause: ${cond}`);
      });
      let affectedRows = 0;
      for (const r of store) {
        if (preds.every((ok) => ok(r))) { setters.forEach((set) => set(r)); affectedRows++; }
      }
      return [{ affectedRows }];
    }),
  };
}

const T = (s) => new Date(s);
const CUTOFF = '2026-10-09T12:00:00.000Z';
const GROUP = 'route_500:/api/mail/mailboxes';

/** The digest scenario: open rows before/at/after the cutoff + neighbors. */
function seed() {
  return makeDb([
    { id: 1, group_key: GROUP, created_at: T('2026-10-09T11:23:31Z') },                      // open, in scope
    { id: 2, group_key: GROUP, created_at: T(CUTOFF) },                                      // open, boundary (inclusive)
    { id: 3, group_key: GROUP, created_at: T('2026-10-09T13:00:00Z') },                      // open, AFTER cutoff
    { id: 4, group_key: GROUP, created_at: T('2026-10-08T09:00:00Z'),
      acked_at: T('2026-10-08T10:00:00Z'), acked_by: 'fred' },                               // acked, not resolved
    { id: 5, group_key: GROUP, created_at: T('2026-10-07T09:00:00Z'),
      acked_at: T('2026-10-07T10:00:00Z'), acked_by: 'fred',
      resolved_at: T('2026-10-07T11:00:00Z') },                                              // resolved
    { id: 6, group_key: 'route_500:/api/mail/messages', created_at: T('2026-10-09T11:23:31Z') }, // other group
  ]);
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('ack', () => {
  test('acks only open rows of the group at/before the cutoff', async () => {
    const db = seed();
    const res = await fn({ action: 'ack', group_key: GROUP, before: CUTOFF, by: 'email-digest' }, db);

    expect(res.success).toBe(true);
    expect(res.output).toMatchObject({ action: 'ack', group_key: GROUP, matched: 2 });

    expect(db.byId(1).acked_at).not.toBeNull();
    expect(db.byId(1).acked_by).toBe('email-digest');
    expect(db.byId(2).acked_at).not.toBeNull();            // boundary is inclusive
    expect(db.byId(3).acked_at).toBeNull();                // after the cutoff — untouched
    expect(db.byId(4).acked_by).toBe('fred');              // first-acker attribution kept
    expect(db.byId(5).resolved_at).toEqual(T('2026-10-07T11:00:00Z'));
    expect(db.byId(6).acked_at).toBeNull();                // other group — untouched
    // ack never resolves
    expect(db.byId(1).resolved_at).toBeNull();
  });

  test("by defaults to 'cta' and is capped at 100 chars", async () => {
    const db = seed();
    await fn({ action: 'ack', group_key: GROUP, before: CUTOFF }, db);
    expect(db.byId(1).acked_by).toBe('cta');

    const db2 = seed();
    await fn({ action: 'ack', group_key: GROUP, before: CUTOFF, by: 'x'.repeat(150) }, db2);
    expect(db2.byId(1).acked_by).toBe('x'.repeat(100));
  });
});

describe('resolve', () => {
  test('resolves open AND acked rows at/before the cutoff; implies ack; preserves attribution', async () => {
    const db = seed();
    const res = await fn({ action: 'resolve', group_key: GROUP, before: CUTOFF, by: 'email-digest' }, db);

    expect(res.success).toBe(true);
    expect(res.output.matched).toBe(3); // ids 1, 2, 4

    expect(db.byId(1).resolved_at).not.toBeNull();
    expect(db.byId(1).acked_at).not.toBeNull();            // resolve implies ack
    expect(db.byId(1).acked_by).toBe('email-digest');
    expect(db.byId(4).resolved_at).not.toBeNull();
    expect(db.byId(4).acked_by).toBe('fred');              // COALESCE keeps the human acker
    expect(db.byId(4).acked_at).toEqual(T('2026-10-08T10:00:00Z'));
    expect(db.byId(3).resolved_at).toBeNull();             // after the cutoff — untouched
    expect(db.byId(5).acked_by).toBe('fred');              // already resolved — untouched
    expect(db.byId(6).resolved_at).toBeNull();             // other group — untouched
  });
});

describe('param validation — fail soft, zero queries', () => {
  const cases = [
    [{ group_key: GROUP, before: CUTOFF }, /action/],
    [{ action: 'reopen', group_key: GROUP, before: CUTOFF }, /action/],
    [{ action: 'ack', before: CUTOFF }, /group_key/],
    [{ action: 'ack', group_key: '', before: CUTOFF }, /group_key/],
    [{ action: 'ack', group_key: 'g'.repeat(201), before: CUTOFF }, /group_key/],
    [{ action: 'ack', group_key: GROUP }, /before/],
    [{ action: 'ack', group_key: GROUP, before: 'not a date' }, /before/],
  ];
  for (const [params, re] of cases) {
    test(`rejects ${JSON.stringify(params).slice(0, 70)}`, async () => {
      const db = seed();
      const res = await fn(params, db);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(re);
      expect(db.query).not.toHaveBeenCalled();
    });
  }
});

describe('CTA exposure (the deliberate decision)', () => {
  test('eligible, and the digest-frozen params pass save-time validation', () => {
    expect(cta.isCtaEligible('set_system_alert_status')).toBe(true);
    expect(cta.eligibleFunctionNames()).toContain('set_system_alert_status');

    const good = { action: 'resolve', group_key: GROUP, before: CUTOFF, by: 'email-digest' };
    expect(registry.__validateFunctionParams('set_system_alert_status', good)).toBeNull();

    const missing = registry.__validateFunctionParams('set_system_alert_status', { action: 'ack' });
    expect(missing).not.toBeNull();
    expect(missing.error).toMatch(/group_key|before/);
  });
});
