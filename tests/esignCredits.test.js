/**
 * Tests for recordCreditSpend in services/esign/index.js (Phase 1C).
 *
 * Zoho exposes no credit-balance endpoint, so the balance is a LOCAL estimate
 * counted down on every real send and topped up by hand. What matters is that
 * it degrades safely — an unknown balance is not counted down from, a failure
 * never fails the send that already spent the credits — and that the low-credit
 * alert fires ONCE per crossing rather than on every send below the line.
 *
 *   npx jest tests/esignCredits.test.js
 */

jest.mock('../services/esignAlertService', () => ({
  raiseTask: jest.fn(async () => ({ ok: true, taskId: 900 })),
  resolveAlertAssignee: jest.fn(async () => 22),
}));

const esignAlertService = require('../services/esignAlertService');
const {
  recordCreditSpend,
  CREDIT_BALANCE_KEY, CREDIT_THRESHOLD_KEY, CREDIT_ALERT_SENT_KEY,
  CREDITS_PER_ENVELOPE, DEFAULT_ALERT_THRESHOLD,
} = require('../services/esign');

/**
 * app_settings stand-in. Values are strings, as they are in the real table,
 * so a test cannot pass by accidentally relying on numeric storage.
 */
function makeDb(settings = {}) {
  const store = { ...settings };
  const db = {
    store,
    query: jest.fn(async (sql, params) => {
      if (/^UPDATE app_settings/i.test(sql)) {
        store[params[1]] = params[0];
        return [{ affectedRows: 1 }];
      }
      if (/FROM app_settings/i.test(sql)) {
        // settingsService.getSettings uses an IN (...) list.
        const keys = Array.isArray(params) ? params.flat() : [];
        const rows = keys
          .filter((k) => store[k] !== undefined)
          .map((k) => ({ key: k, value: store[k] }));
        return [rows];
      }
      return [[]];
    }),
  };
  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
describe('the arithmetic', () => {
  test('spends five credits per envelope', async () => {
    expect(CREDITS_PER_ENVELOPE).toBe(5);
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '200', [CREDIT_THRESHOLD_KEY]: '50' });

    const out = await recordCreditSpend(db);
    expect(out).toMatchObject({ ok: true, previous: 200, balance: 195, alerted: false });
    expect(db.store[CREDIT_BALANCE_KEY]).toBe('195');
  });

  test('honours an explicit credit count', async () => {
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '200', [CREDIT_THRESHOLD_KEY]: '50' });
    expect((await recordCreditSpend(db, { credits: 12 })).balance).toBe(188);
  });

  // A negative balance is not information — it just means the manual figure
  // was stale — and it reads as nonsense in an alert.
  test('floors at zero rather than going negative', async () => {
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '3', [CREDIT_THRESHOLD_KEY]: '50' });
    expect((await recordCreditSpend(db)).balance).toBe(0);
    expect(db.store[CREDIT_BALANCE_KEY]).toBe('0');
  });

  test('falls back to the default threshold when none is set', async () => {
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '1000' });
    expect((await recordCreditSpend(db)).threshold).toBe(DEFAULT_ALERT_THRESHOLD);
  });

  test('an unparseable threshold falls back rather than disabling the alert', async () => {
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '1000', [CREDIT_THRESHOLD_KEY]: 'fifty' });
    expect((await recordCreditSpend(db)).threshold).toBe(DEFAULT_ALERT_THRESHOLD);
  });
});

// ─────────────────────────────────────────────────────────────
describe('when the balance is unknown', () => {
  // Counting down from an invented number is worse than not counting: it
  // produces a confident figure that is wrong, and alerts off it.
  test('an unset balance is left alone and reported', async () => {
    const db = makeDb({ [CREDIT_THRESHOLD_KEY]: '50' });
    const out = await recordCreditSpend(db);

    expect(out).toMatchObject({ ok: false, reason: 'balance_unset' });
    expect(db.store[CREDIT_BALANCE_KEY]).toBeUndefined();
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('a blank balance is treated as unset, not as zero', async () => {
    const db = makeDb({ [CREDIT_BALANCE_KEY]: '   ' });
    expect((await recordCreditSpend(db)).reason).toBe('balance_unset');
  });
});

// ─────────────────────────────────────────────────────────────
describe('the once-per-crossing latch', () => {
  test('alerts on the send that crosses the threshold', async () => {
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '52', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '0',
    });

    const out = await recordCreditSpend(db);
    expect(out).toMatchObject({ balance: 47, alerted: true });
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
    expect(db.store[CREDIT_ALERT_SENT_KEY]).toBe('1');

    const task = esignAlertService.raiseTask.mock.calls[0][1];
    expect(task.title).toMatch(/credits low: 47/);
    // The alert must be honest about being an estimate, or staff will trust a
    // number that drifts every time someone sends from the Zoho dashboard.
    expect(task.desc).toMatch(/ESTIMATE, not a ledger/);
    expect(task.desc).toMatch(/esign_credit_balance/);
  });

  // The spam this prevents: without the latch, EVERY subsequent send alerts.
  test('stays silent on the sends after the crossing', async () => {
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '52', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '0',
    });

    await recordCreditSpend(db);                       // 47 — alerts
    esignAlertService.raiseTask.mockClear();

    for (let i = 0; i < 5; i++) await recordCreditSpend(db);
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
    expect(db.store[CREDIT_BALANCE_KEY]).toBe('22');
  });

  test('a top-up re-arms the alert', async () => {
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '52', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '0',
    });

    await recordCreditSpend(db);                       // 47, latched
    expect(db.store[CREDIT_ALERT_SENT_KEY]).toBe('1');

    db.store[CREDIT_BALANCE_KEY] = '500';              // Fred buys credits
    await recordCreditSpend(db);                       // 495 — clears the latch
    expect(db.store[CREDIT_ALERT_SENT_KEY]).toBe('0');

    esignAlertService.raiseTask.mockClear();
    db.store[CREDIT_BALANCE_KEY] = '52';
    await recordCreditSpend(db);                       // 47 — alerts again
    expect(esignAlertService.raiseTask).toHaveBeenCalledTimes(1);
  });

  test('a balance already latched below threshold does not re-alert', async () => {
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '20', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '1',
    });
    expect((await recordCreditSpend(db)).alerted).toBe(false);
    expect(esignAlertService.raiseTask).not.toHaveBeenCalled();
  });

  test('landing exactly ON the threshold is not below it', async () => {
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '55', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '0',
    });
    const out = await recordCreditSpend(db);
    expect(out.balance).toBe(50);
    expect(out.alerted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
describe('failure posture', () => {
  // Zoho has already accepted the envelope and taken the credits. Turning a
  // bookkeeping error into a throw would tell the caller the send failed.
  test('a DB failure never throws', async () => {
    const db = { query: jest.fn(async () => { throw new Error('pool exhausted'); }) };
    await expect(recordCreditSpend(db)).resolves.toMatchObject({ ok: false, reason: 'error' });
  });

  test('an alert failure does not fail the count', async () => {
    esignAlertService.raiseTask.mockRejectedValueOnce(new Error('taskService down'));
    const db = makeDb({
      [CREDIT_BALANCE_KEY]: '52', [CREDIT_THRESHOLD_KEY]: '50', [CREDIT_ALERT_SENT_KEY]: '0',
    });
    const out = await recordCreditSpend(db);
    expect(out.ok).toBe(false);          // reported…
    expect(db.store[CREDIT_BALANCE_KEY]).toBe('47');   // …but the spend is recorded
  });
});
