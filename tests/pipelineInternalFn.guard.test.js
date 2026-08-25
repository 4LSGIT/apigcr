// tests/pipelineInternalFn.guard.test.js
//
// Guards the _csvGuard parsing contract inside lib/internal_functions/pipeline.js
// (advance_stage). Motivated by the Aug 2026 rule-12 postmortem: a params_mapping
// authored as "'lead','none'" resolved to the string  lead','none  because
// resolveParamsMapping strips only the OUTER quote pair, producing the guard
// ["lead'", "'none"] — unmatchable, so the rule skipped 100% of the time while
// reporting status 'matched' / action 'success' / reason 'guard', i.e. exactly
// like a healthy guarded miss. Silent-forever failures must be loud.
//
// pipelineService is mocked — this file asserts the argument marshalling, not
// the DB behaviour (that lives in tests/pipelineService.test.js).
//
// Run:
//   npx jest tests/pipelineInternalFn.guard.test.js

'use strict';

jest.mock('../services/pipelineService', () => ({
  advanceStage: jest.fn(async () => ({
    noop: false,
    current: { stage_key: 'intake_complete', case_stage: 'Open', status_label: 'Intake Received' },
  })),
}));

const pipelineService = require('../services/pipelineService');
const fns = require('../lib/internal_functions/pipeline');

const DB = {};              // never touched — advanceStage is mocked
const BASE = { case_id: 'ABC12345', stage: 'intake_complete' };

/** last onlyFrom / onlyFromRole handed to pipelineService.advanceStage */
function lastOpts() {
  const calls = pipelineService.advanceStage.mock.calls;
  return calls[calls.length - 1][3];
}

beforeEach(() => {
  pipelineService.advanceStage.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
});

describe('advance_stage guard parsing — happy paths', () => {
  test('single literal CSV → array, "none" token becomes the null sentinel', async () => {
    await fns.advance_stage({ ...BASE, only_from: 'lead,consult_booked,none' }, DB);
    expect(lastOpts().onlyFrom).toEqual(['lead', 'consult_booked', null]);
  });

  test('whitespace around tokens is trimmed; NONE is case-insensitive', async () => {
    await fns.advance_stage({ ...BASE, only_from: ' lead , NONE ' }, DB);
    expect(lastOpts().onlyFrom).toEqual(['lead', null]);
  });

  test('only_from_role parses the same way', async () => {
    await fns.advance_stage({ ...BASE, only_from_role: 'intake,none' }, DB);
    expect(lastOpts().onlyFromRole).toEqual(['intake', null]);
  });

  test('absent / blank guard degrades to undefined (unguarded), not an error', async () => {
    await fns.advance_stage({ ...BASE }, DB);
    expect(lastOpts().onlyFrom).toBeUndefined();
    expect(lastOpts().onlyFromRole).toBeUndefined();

    // A {{placeholder}} that resolved to '' must behave identically — this is
    // the documented degrade-to-unguarded contract, NOT an authoring error.
    await fns.advance_stage({ ...BASE, only_from: '', only_from_role: '   ' }, DB);
    expect(lastOpts().onlyFrom).toBeUndefined();
    expect(lastOpts().onlyFromRole).toBeUndefined();
  });
});

describe('advance_stage guard parsing — quote rejection (rule-12 postmortem)', () => {
  // What "'lead','none'" ACTUALLY becomes after resolveParamsMapping strips
  // the outer quote pair. This is the exact string that shipped in production.
  const RESOLVED_MULTI_LITERAL = "lead','none";

  test('the multi-literal authoring form throws instead of building a dead guard', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from: RESOLVED_MULTI_LITERAL }, DB)
    ).rejects.toThrow(/only_from contains a quote character/);
  });

  test('rejection happens BEFORE pipelineService is called — nothing is written', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from: RESOLVED_MULTI_LITERAL }, DB)
    ).rejects.toThrow();
    expect(pipelineService.advanceStage).not.toHaveBeenCalled();
  });

  test('error text names the correct form so the author can fix it from the message', async () => {
    let msg = '';
    try {
      await fns.advance_stage({ ...BASE, only_from: RESOLVED_MULTI_LITERAL }, DB);
    } catch (err) {
      msg = err.message;
    }
    expect(msg).toContain("'lead,none'");
    expect(msg).toContain(RESOLVED_MULTI_LITERAL);
  });

  test('double quotes are rejected too', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from: 'lead","none' }, DB)
    ).rejects.toThrow(/only_from contains a quote character/);
  });

  test('a stray quote anywhere in the value is rejected, not just between tokens', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from: "'lead,none" }, DB)
    ).rejects.toThrow(/only_from contains a quote character/);
  });

  test('only_from_role is guarded by the same check and names itself in the error', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from_role: "intake','none" }, DB)
    ).rejects.toThrow(/only_from_role contains a quote character/);
    expect(pipelineService.advanceStage).not.toHaveBeenCalled();
  });
});

describe('advance_stage guard parsing — pre-existing all-empty rejection still holds', () => {
  test('",,," throws the entry-count error (a literal authoring mistake)', async () => {
    await expect(
      fns.advance_stage({ ...BASE, only_from: ',,,' }, DB)
    ).rejects.toThrow(/only_from must contain at least one entry when provided/);
    expect(pipelineService.advanceStage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forward_only (R1) — _boolGuard
//
// The token set is copied verbatim from lib/internal_functions/events.js's
// _bool (the house boolean-param parser). The GARBAGE BRANCH deliberately
// differs: _bool falls back to the caller's default, which is safe there
// because its guard (`dedupe`) DEFAULTS TRUE — the fallback lands on the armed
// side. forward_only defaults FALSE, so an identical fallback would land on
// the DISARMED side and let a typo silently permit the backward advances the
// author wrote the guard to stop. Same shape as the rule-12 postmortem, same
// answer as _csvGuard's quote rejection: throw.
// ─────────────────────────────────────────────────────────────────────────────

describe('advance_stage forward_only parsing (R1)', () => {
  test('absent / blank / whitespace degrades to undefined — the guard is simply off', async () => {
    await fns.advance_stage({ ...BASE }, DB);
    expect(lastOpts().forwardOnly).toBeUndefined();

    // A {{placeholder}} that resolved to '' must behave identically. Same
    // degrade contract as the CSV guards — an unset workflow variable is not
    // an authoring error.
    await fns.advance_stage({ ...BASE, forward_only: '' }, DB);
    expect(lastOpts().forwardOnly).toBeUndefined();
    await fns.advance_stage({ ...BASE, forward_only: '   ' }, DB);
    expect(lastOpts().forwardOnly).toBeUndefined();
  });

  test('truthy tokens arm the guard, trimmed and case-insensitively', async () => {
    for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', true, 1]) {
      await fns.advance_stage({ ...BASE, forward_only: raw }, DB);
      expect(lastOpts().forwardOnly).toBe(true);
    }
  });

  test('falsy tokens turn it off explicitly — NOT an error', async () => {
    // Writing 'false' is a legitimate way to say "off". Only UNRECOGNIZED
    // values are rejected.
    for (const raw of ['false', 'FALSE', ' False ', '0', 'no', 'NO', false, 0]) {
      await fns.advance_stage({ ...BASE, forward_only: raw }, DB);
      expect(lastOpts().forwardOnly).toBeUndefined();
    }
  });

  test('an unrecognized value THROWS rather than silently disarming', async () => {
    await expect(
      fns.advance_stage({ ...BASE, forward_only: 'ture' }, DB)
    ).rejects.toThrow(/forward_only must be true\/1\/yes or false\/0\/no/);
    expect(pipelineService.advanceStage).not.toHaveBeenCalled();
  });

  test('the error names the value and explains why "off" is not the fallback', async () => {
    let msg = '';
    try { await fns.advance_stage({ ...BASE, forward_only: 'maybe' }, DB); }
    catch (err) { msg = err.message; }
    expect(msg).toContain('"maybe"');
    expect(msg).toMatch(/silently|disarmed|no error/i);
  });

  test('rejection happens BEFORE pipelineService is called — nothing is written', async () => {
    await expect(
      fns.advance_stage({ ...BASE, forward_only: 'on' }, DB)   // plausible, unsupported
    ).rejects.toThrow();
    expect(pipelineService.advanceStage).not.toHaveBeenCalled();
  });

  test('combines with the CSV guards — all three ride together', async () => {
    await fns.advance_stage(
      { ...BASE, only_from: 'retained,none', only_from_role: 'case', forward_only: 'true' }, DB);
    const o = lastOpts();
    expect(o.onlyFrom).toEqual(['retained', null]);
    expect(o.onlyFromRole).toEqual(['case']);
    expect(o.forwardOnly).toBe(true);
  });

  test('__meta declares forward_only as a string param (placeholders resolve to strings)', async () => {
    const p = fns.advance_stage.__meta.params.find(x => x.name === 'forward_only');
    expect(p).toBeTruthy();
    expect(p.type).toBe('string');
    expect(p.required).toBe(false);
    expect(p.placeholderAllowed).toBe(true);
    // The reason vocabulary grew — automations branch on it.
    expect(fns.advance_stage.__meta.description).toContain('backward');
  });
});