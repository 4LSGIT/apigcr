// tests/unifiedEventsU5.cascade.test.js
//
/**
 * Unified Events U5 — the sequence cascade after the consumer cutover.
 *
 * The migration (ref/2026-09-01_unified_events_u5.sql) moves four templates'
 * filters from `appt_type` labels to `type_key` registry keys and puts
 * `type_key` AHEAD of `appt_type` in priority_fields. apptService flattens
 * `type_key` into both trigger_data payloads. This file pins the pair, because
 * they only work together:
 *
 *   · specific filter + trigger value      → the template scores and can win
 *   · specific filter + NO trigger value   → the template is DISQUALIFIED
 *
 * That asymmetry is why the slice deploys BACKEND FIRST. Run the SQL against a
 * backend that does not carry type_key in trigger_data and every ISS/341
 * reminder and every BK no-show silently falls through to the generic
 * fallback — no error, no log, just the wrong template forever.
 *
 * ── HOW THE CASCADE IS OBSERVED ────────────────────────────────────────────
 * `_enrollWithTemplate` is not exported, so the harness lets the winner walk
 * one step further into it and stops at the "no steps" guard. The
 * `SELECT * FROM sequence_steps WHERE template_id = ?` bind IS the cascade's
 * answer — the first observable fact after selection, with no enrollment
 * INSERT, no job scheduling, and no mocking of the function under test.
 *
 * Fixtures are the LIVE rows as the migration leaves them (verified
 * 2026-09-01), not invented ones: if the migration's target values are wrong,
 * these tests are wrong in the same direction, and the VERIFY block in the
 * .sql is what catches that.
 *
 * Run:  npx jest tests/unifiedEventsU5.cascade.test.js
 */

'use strict';

const seq = require('../lib/sequenceEngine');
const { scriptGuard } = require('./helpers/scriptGuard');

// ─────────────────────────────────────────────────────────────────────────────
// The live rows, POST-migration
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_FIELDS = {
  pre_appt: ['type_key', 'appt_type', 'appt_with'],
  no_show:  ['type_key', 'appt_type', 'appt_with', 'case_type'],
};

const tpl = (id, name, type, filters) => ({
  id, name, type, filters, active: 1, current_version: 1, capture_mode: 'off',
});

// pre_appt: 19 (341), 20 (ISS), 21 (generic fallback).
const PRE_APPT_TEMPLATES = [
  tpl(19, 'pre_appt — 341 Meeting',               'pre_appt', { type_key: 'meeting_341' }),
  tpl(20, 'pre_appt — Initial Strategy Session',  'pre_appt', { type_key: 'iss' }),
  tpl(21, 'pre_appt — Fallback (generic)',        'pre_appt', {}),
];

// no_show: 16 (generic fallback), 23, 24, 25. Template 17 is inactive live and
// is therefore absent — `enrollContact` loads active + current_version>0 only.
const NO_SHOW_TEMPLATES = [
  tpl(16, 'No Show — Fallback (generic)',  'no_show', {}),
  tpl(23, 'no_show — BK pre-file (generic)', 'no_show',
      { type_key: 'iss|ss|ss_follow_up|pre_filing', case_type: 'Bankruptcy' }),
  tpl(24, 'no_show — BK pre-file (SS)', 'no_show',
      { type_key: 'iss|ss|ss_follow_up|pre_filing', appt_with: 1, case_type: 'Bankruptcy' }),
  tpl(25, 'no_show — BK other (SS)', 'no_show',
      { appt_with: 1, case_type: 'Bankruptcy' }),
];

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub pool for enrollContact. Routes by SQL rather than by position, so the
 * three reads (type row, templates, steps) can arrive in any order the engine
 * chooses without the fixture silently shifting.
 *
 * @returns {{db: object, stepsFor: () => number|null}} `stepsFor()` is the
 *          template_id the cascade handed to the step loader — the winner.
 */
function makeDb(type, templates) {
  const calls = [];
  let winner = null;
  const db = {
    calls,
    query: async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (/FROM sequence_template_types/i.test(flat)) {
        return [[{ type, priority_fields: PRIORITY_FIELDS[type], active: 1 }]];
      }
      if (/FROM sequence_templates WHERE type/i.test(flat)) {
        return [templates.map((t) => ({ ...t }))];
      }
      if (/FROM sequence_steps/i.test(flat)) {
        winner = Number(params[0]);
        return [[]];   // → "has no steps", which is where the harness stops
      }
      throw new Error(`unexpected query: ${flat}`);
    },
  };
  return { db, stepsFor: () => winner };
}

/** Run the cascade and return the winning template id (or throw). */
async function pick(type, templates, triggerData) {
  const { db, stepsFor } = makeDb(type, templates);
  await expect(seq.enrollContact(db, 77, type, triggerData))
    .rejects.toThrow(/has no steps/);
  return stepsFor();
}

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { console.log.mockRestore(); });

// ─────────────────────────────────────────────────────────────────────────────
describe('pre_appt cascade on type_key (templates 19 / 20 / 21)', () => {
  const base = { appt_id: 1, appt_time: '2026-10-01T14:00:00.000Z', appt_with: 1, case_id: 'ABC' };

  test("type_key 'meeting_341' selects 19", async () => {
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: 'meeting_341', appt_type: '341 Meeting' })).toBe(19);
  });

  test("type_key 'iss' selects 20", async () => {
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: 'iss', appt_type: 'Initial Strategy Session' })).toBe(20);
  });

  test('an alias-resolved booking wins on the KEY even though its LABEL is a typo', async () => {
    // 'Intial Strategy Session' is an ingest_alias of `iss`, so the row carries
    // the good key and the historical label. Pre-U5 the label list had to name
    // the typo; now the key does the work and the label is free to be whatever
    // was booked.
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: 'iss', appt_type: 'Intial Strategy Session' })).toBe(20);
  });

  test('an unlisted type falls through to the generic fallback 21', async () => {
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: 'schedules_meeting', appt_type: 'Schedules Completion Meeting' })).toBe(21);
  });

  test('THE DEPLOY-ORDER TRAP: no type_key in trigger_data disqualifies 19 AND 20', async () => {
    // This is exactly what running the SQL before the backend would produce:
    // a 341 booking silently reminded by the generic template. It is not an
    // error at any layer — which is the whole reason the order is inverted.
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, appt_type: '341 Meeting' })).toBe(21);
  });

  test('a NULL type_key (unmapped label) is treated as absent, not as a value', async () => {
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: null, appt_type: 'Something Nobody Registered' })).toBe(21);
  });

  test('appt_type is now a WILDCARD on every template — it cannot disqualify', async () => {
    // priority_fields still lists it, but no template filters on it after 1.2,
    // so a label that matches nothing changes no outcome.
    expect(await pick('pre_appt', PRE_APPT_TEMPLATES,
      { ...base, type_key: 'iss', appt_type: 'utterly unrelated string' })).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('no_show cascade on type_key × appt_with × case_type (16 / 23 / 24 / 25)', () => {
  const base = { appt_id: 2, appt_time: '2026-10-01 14:00:00', case_id: 'ABC' };

  test('ss_follow_up + appt_with 1 + Bankruptcy selects 24 OVER 23', async () => {
    // 24 = {type_key, appt_with, case_type} → 8 + 2 + 1 = 11
    // 23 = {type_key,            case_type} → 8 +     1 =  9
    expect(await pick('no_show', NO_SHOW_TEMPLATES, {
      ...base, type_key: 'ss_follow_up', appt_type: 'Strategy Session Follow Up',
      appt_with: 1, case_type: 'Bankruptcy',
    })).toBe(24);
  });

  test('the same type with a DIFFERENT provider falls to 23', async () => {
    expect(await pick('no_show', NO_SHOW_TEMPLATES, {
      ...base, type_key: 'ss_follow_up', appt_with: 5, case_type: 'Bankruptcy',
    })).toBe(23);
  });

  test('each of the four listed keys reaches the pre-file templates', async () => {
    for (const key of ['iss', 'ss', 'ss_follow_up', 'pre_filing']) {
      expect(await pick('no_show', NO_SHOW_TEMPLATES, {
        ...base, type_key: key, appt_with: 1, case_type: 'Bankruptcy',
      })).toBe(24);
    }
  });

  /**
   * DIVERGENCE FROM THE U5 PROMPT, recorded here rather than asserted away.
   *
   * The prompt expected an unlisted type to select "neither" and to throw
   * "no qualified candidates". It does not, and it did not before U5 either:
   * template 25 carries NO type filter at all ({appt_with, case_type}), so a
   * BK no-show with provider 1 qualifies it whatever the type is, and template
   * 16 ({}) qualifies unconditionally. Confirmed against the live rows.
   *
   * The correct claim is the narrow one — an unlisted type is kept out of the
   * PRE-FILE templates — and that is what this asserts.
   */
  test("an unlisted type (schedules_meeting) selects 25, NOT 23/24 — and does not throw", async () => {
    expect(await pick('no_show', NO_SHOW_TEMPLATES, {
      ...base, type_key: 'schedules_meeting', appt_with: 1, case_type: 'Bankruptcy',
    })).toBe(25);
  });

  test('…and with 25 and 16 out of contention, the same input DOES throw', async () => {
    // The prompt's expectation, shown to hold only once the two type-less
    // templates are removed. Kept so the reason the live answer differs stays
    // visible instead of being folded into the assertion above.
    const onlyPreFile = NO_SHOW_TEMPLATES.filter((t) => t.id === 23 || t.id === 24);
    const { db } = makeDb('no_show', onlyPreFile);
    await expect(seq.enrollContact(db, 77, 'no_show', {
      ...base, type_key: 'schedules_meeting', appt_with: 1, case_type: 'Bankruptcy',
    })).rejects.toThrow(/all disqualified by trigger_data/);
  });

  test('a non-Bankruptcy case skips every specific template and lands on 16', async () => {
    expect(await pick('no_show', NO_SHOW_TEMPLATES, {
      ...base, type_key: 'iss', appt_with: 1, case_type: 'Civil',
    })).toBe(16);
  });

  test('THE DEPLOY-ORDER TRAP again: no type_key drops 23 and 24, leaving 25', async () => {
    expect(await pick('no_show', NO_SHOW_TEMPLATES, {
      ...base, appt_type: 'Initial Strategy Session', appt_with: 1, case_type: 'Bankruptcy',
    })).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validateTemplateFilters accepts type_key once priority_fields carries it', () => {
  function typeDb(priorityFields) {
    const script = [[{ priority_fields: priorityFields }]];
    const guard = scriptGuard('typeDb', script);
    return {
      query: async (sql) => {
        if (!script.length) guard.overrun(sql);
        return [script.shift()];
      },
    };
  }

  test('type_key is a legal filter key for pre_appt after 1.1', async () => {
    const db = typeDb(PRIORITY_FIELDS.pre_appt);
    await expect(seq.validateTemplateFilters(db, 'pre_appt', { type_key: 'iss' }))
      .resolves.toEqual({ valid: true });
  });

  test('type_key AND appt_type are both legal during the dual-carry release', async () => {
    const db = typeDb(PRIORITY_FIELDS.no_show);
    await expect(seq.validateTemplateFilters(db, 'no_show',
      { type_key: 'iss|ss', appt_type: 'Initial Strategy Session', case_type: 'Bankruptcy' }))
      .resolves.toEqual({ valid: true });
  });

  test('a key outside priority_fields is still rejected — the list is the contract', async () => {
    const db = typeDb(PRIORITY_FIELDS.pre_appt);
    const r = await seq.validateTemplateFilters(db, 'pre_appt', { kind: 'meeting' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/kind/);
  });

  test('BEFORE 1.1, type_key would have been rejected — the migration is load-bearing', async () => {
    // The pre-U5 list. This is why 1.1 runs before 1.2 in the .sql: saving a
    // type_key filter through the editor against the old list is a 400.
    const db = typeDb(['appt_type', 'appt_with']);
    const r = await seq.validateTemplateFilters(db, 'pre_appt', { type_key: 'iss' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/type_key/);
  });
});
