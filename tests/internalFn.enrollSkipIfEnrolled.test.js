// tests/internalFn.enrollSkipIfEnrolled.test.js
//
// Guards the enroll_sequence skip_if_enrolled contract in
// lib/internal_functions/sequences.js (2026-10-05; wf25 step 11 / alert 155:
// the BNC mails a duplicate copy of every 341 notice, so wf25 fires twice
// per notice and the second enroll hit the engine's dup guard as a step
// failure — completed_with_errors + a step_failed alert for a converged
// state).
//
// The load-bearing promises:
//   1. DEFAULT UNCHANGED — without skip_if_enrolled, the dup error still
//      throws (hookService's bounded-failure capture depends on it).
//   2. CONVERGED — with skip_if_enrolled:true, an ALREADY_ENROLLED error
//      returns success with { already_enrolled: true, enrollmentId }.
//   3. CODE-KEYED — only err.code === 'ALREADY_ENROLLED' converges; any
//      other enroll failure rethrows even with the flag on. (Keying on the
//      message text would convert real failures into silent successes.)
//   4. ENGINE MARKER — sequenceEngine's dup guard actually attaches the
//      code + enrollment_id (the marker the flag keys on).
//
// sequenceEngine is mocked for 1–3 (control flow under test, not the
// engine); 4 runs the real engine funnel against a db stub.
//
// Run:
//   npx jest tests/internalFn.enrollSkipIfEnrolled.test.js

'use strict';

const dupError = (id = 188) => {
  const e = new Error('Contact 1983 is already enrolled in sequence "Post-341 Ch7 — 21/28-day intention reminders (SS)"');
  e.code = 'ALREADY_ENROLLED';
  e.enrollment_id = id;
  return e;
};

jest.mock('../lib/sequenceEngine', () => ({
  enrollContact: jest.fn(),
  enrollContactByTemplateId: jest.fn(),
}));

const sequenceEngine = require('../lib/sequenceEngine');
const fns = require('../lib/internal_functions/sequences');

const PARAMS = {
  contact_id: 1983,
  template_type: 'post_341_ch7',
  trigger_data: { case_id: 'YSHZLitl', source: 'wf25_ch7_341_notice' },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('enroll_sequence skip_if_enrolled', () => {
  test('DEFAULT UNCHANGED: dup error still throws without the flag', async () => {
    sequenceEngine.enrollContact.mockRejectedValue(dupError());
    await expect(fns.enroll_sequence({ ...PARAMS }, {}))
      .rejects.toThrow(/already enrolled/);
  });

  test('CONVERGED: flag on + ALREADY_ENROLLED → success with enrollment id', async () => {
    sequenceEngine.enrollContact.mockRejectedValue(dupError(188));
    const res = await fns.enroll_sequence({ ...PARAMS, skip_if_enrolled: true }, {});
    expect(res).toEqual({
      success: true,
      output: { already_enrolled: true, enrollmentId: 188 },
    });
  });

  test('CONVERGED: by-id mode converges the same way', async () => {
    sequenceEngine.enrollContactByTemplateId.mockRejectedValue(dupError(42));
    const res = await fns.enroll_sequence(
      { contact_id: 1983, template_id: 30, skip_if_enrolled: true }, {});
    expect(res.output.already_enrolled).toBe(true);
    expect(sequenceEngine.enrollContact).not.toHaveBeenCalled();
  });

  test('CODE-KEYED: a non-dup failure rethrows even with the flag on', async () => {
    const boom = new Error('Sequence template "Post-341 Ch7" has no steps');
    sequenceEngine.enrollContact.mockRejectedValue(boom);
    await expect(fns.enroll_sequence({ ...PARAMS, skip_if_enrolled: true }, {}))
      .rejects.toThrow(/has no steps/);
  });

  test('CODE-KEYED: a message that merely SAYS already-enrolled (no code) rethrows', async () => {
    const texty = new Error('Contact 1983 is already enrolled in sequence "X"');
    sequenceEngine.enrollContact.mockRejectedValue(texty);
    await expect(fns.enroll_sequence({ ...PARAMS, skip_if_enrolled: true }, {}))
      .rejects.toThrow(/already enrolled/);
  });

  test('SUCCESS PATH UNTOUCHED: a clean enroll returns the engine result', async () => {
    sequenceEngine.enrollContact.mockResolvedValue({
      enrollmentId: 189, templateName: 'pre_appt — 341 Meeting',
      totalSteps: 7, firstJobScheduledAt: '2126-10-05T16:31:48.000Z',
    });
    const res = await fns.enroll_sequence({ ...PARAMS, skip_if_enrolled: true }, {});
    expect(res.success).toBe(true);
    expect(res.output.enrollmentId).toBe(189);
    expect(res.output.already_enrolled).toBeUndefined();
  });
});

describe('sequenceEngine dup guard marker (real engine)', () => {
  test('ENGINE MARKER: the dup throw carries code + enrollment_id', async () => {
    const realEngine = jest.requireActual('../lib/sequenceEngine');
    const db = {
      query: jest.fn(async (sql) => {
        if (/FROM sequence_templates/i.test(sql)) {
          return [[{
            id: 30, name: 'Post-341 Ch7 — 21/28-day intention reminders (SS)',
            type: 'post_341_ch7', filters: null, condition: null,
            active: 1, current_version: 3,
          }]];
        }
        if (/FROM sequence_steps/i.test(sql)) {
          return [[{ step_number: 1, action_type: 'internal_function',
            action_config: '{}', timing: '{"type":"delay","unit":"minutes","value":1}',
            condition: null, fire_guard: null, error_policy: null }]];
        }
        if (/FROM sequence_enrollments/i.test(sql)) {
          return [[{ id: 188 }]]; // the existing active enrollment
        }
        return [[]];
      }),
    };
    expect.assertions(3);
    try {
      await realEngine.enrollContactByTemplateId(db, 1983, 30, { case_id: 'YSHZLitl' });
    } catch (err) {
      expect(err.code).toBe('ALREADY_ENROLLED');
      expect(err.enrollment_id).toBe(188);
      expect(err.message).toMatch(/already enrolled/);
    }
  });
});
