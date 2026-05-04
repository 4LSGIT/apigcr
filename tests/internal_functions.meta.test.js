/**
 * Tests for the __meta registry and validator on lib/internal_functions.js.
 *
 * Two layers:
 *   1. Shape — every function's meta declaration is well-formed (param names,
 *      types in the allowed set, required fields documented, group references
 *      point at real params).
 *   2. Behavior — fixed input/output table that captures the validator's
 *      contract. New cases get added here when adding a new function or
 *      changing an existing one.
 */
/*
npm install --save-dev jest
npx jest tests/internal_functions.meta.test.js
npm uninstall --save-dev jest
*/
const internalFunctions = require('../lib/internal_functions');

const ALLOWED_TYPES = new Set([
  'string', 'placeholder_string', 'number', 'integer', 'boolean',
  'enum', 'iso_datetime', 'duration', 'object', 'array',
]);

const ALLOWED_WIDGETS = new Set(['phone_line', 'email_from']);

describe('internal_functions __meta registry — shape', () => {
  const allMeta = internalFunctions.__getAllMeta();

  test('every callable function (excluding __ helpers) has __meta', () => {
    const callable = Object.keys(internalFunctions).filter(
      k => typeof internalFunctions[k] === 'function' && !k.startsWith('__')
    );
    const missing = callable.filter(k => !internalFunctions[k].__meta);
    expect(missing).toEqual([]);
  });

  test.each(Object.entries(allMeta))(
    '%s has well-formed meta',
    (fnName, meta) => {
      expect(typeof meta.description).toBe('string');
      expect(meta.description.length).toBeGreaterThan(0);
      expect(Array.isArray(meta.params)).toBe(true);

      const paramNames = new Set();
      for (const p of meta.params) {
        // Required fields on every spec
        expect(typeof p.name).toBe('string');
        expect(p.name.length).toBeGreaterThan(0);
        expect(paramNames.has(p.name)).toBe(false); // no duplicates
        paramNames.add(p.name);

        expect(ALLOWED_TYPES.has(p.type)).toBe(true);
        expect(typeof p.required).toBe('boolean');

        // Optional fields, when present, must be the right shape
        if (p.widget !== undefined) expect(ALLOWED_WIDGETS.has(p.widget)).toBe(true);
        if (p.enum !== undefined) {
          expect(Array.isArray(p.enum)).toBe(true);
          expect(p.enum.length).toBeGreaterThan(0);
          expect(p.type).toBe('enum');
        }
        if (p.type === 'enum') {
          expect(Array.isArray(p.enum)).toBe(true);
        }
        if (p.min !== undefined) expect(typeof p.min).toBe('number');
        if (p.max !== undefined) expect(typeof p.max).toBe('number');
        if (p.placeholderAllowed !== undefined) expect(typeof p.placeholderAllowed).toBe('boolean');
        if (p.multiline !== undefined) expect(typeof p.multiline).toBe('boolean');
        if (p.nullishSkipsBlock !== undefined) expect(typeof p.nullishSkipsBlock).toBe('boolean');

        // description, when present, must be a string
        if (p.description !== undefined) expect(typeof p.description).toBe('string');
      }

      // Group references must point at real params
      for (const group of meta.exclusiveOneOf || []) {
        for (const name of group) expect(paramNames.has(name)).toBe(true);
      }
      for (const group of meta.requiredWith || []) {
        for (const name of group) expect(paramNames.has(name)).toBe(true);
      }

      // Mode groups, if present on any param, should partition cleanly
      const modesByName = new Map();
      for (const p of meta.params) {
        if (p.modeGroup) modesByName.set(p.name, p.modeGroup);
      }
      // Every mode group string is a non-empty string
      for (const m of modesByName.values()) {
        expect(typeof m).toBe('string');
        expect(m.length).toBeGreaterThan(0);
      }
    }
  );

  test('all 24 functions present', () => {
    expect(Object.keys(allMeta).sort()).toEqual([
      'cancel_sequences', 'create_appointment', 'create_log', 'create_task',
      'enroll_sequence', 'evaluate_condition', 'format_string', 'get_appointments',
      'lookup_appointment', 'lookup_contact', 'noop', 'query_db',
      'run_task_digest', 'schedule_resume', 'send_email', 'send_mms', 'send_sms',
      'set_next', 'set_test_var', 'set_var', 'update_appointment',
      'update_contact', 'wait_for', 'wait_until_time',
    ]);
  });

describe('validateParamsAgainstMeta — behavior fixtures', () => {
  const meta = internalFunctions.__getAllMeta();
  const v = internalFunctions.__validateParamsAgainstMeta;

  // Each row: [label, fnMetaKey, params, expectedErrorFragment | null]
  const cases = [
    // send_sms — basic required-field flow
    ['send_sms valid',                'send_sms', { from: '2485559999', to: '5551234', message: 'hi' }, null],
    ['send_sms missing message',      'send_sms', { from: '2485559999', to: '5551234' }, 'message is required'],
    ['send_sms placeholder to',       'send_sms', { from: '2485559999', to: '{{contactPhone}}', message: 'hi' }, null],

    // send_email — requiredWith group
    ['send_email no body',            'send_email', { from: 'x@y', to: 'a@b', subject: 'hi' }, 'must include at least one of: text, html'],
    ['send_email with text',          'send_email', { from: 'x@y', to: 'a@b', subject: 'hi', text: 'body' }, null],
    ['send_email with both',          'send_email', { from: 'x@y', to: 'a@b', subject: 'hi', text: 't', html: '<p>h</p>' }, null],

    // wait_for — exclusiveOneOf with nullishSkipsBlock on `at`
    ['wait_for relative valid',       'wait_for', { duration: '2h', nextStep: 5 }, null],
    ['wait_for absolute valid',       'wait_for', { at: '2026-05-01T14:30:00', nextStep: 5 }, null],
    ['wait_for both real',            'wait_for', { duration: '2h', at: '2026-05-01T14:30:00', nextStep: 5 }, 'must include only one'],
    ['wait_for neither',              'wait_for', { nextStep: 5 }, 'must include exactly one'],
    ['wait_for at:null skip pattern', 'wait_for', { at: null, nextStep: 5, skipToStep: 7 }, null],
    ['wait_for at:"" skip pattern',   'wait_for', { at: '', nextStep: 5, skipToStep: 7 }, null],
    ['wait_for at as placeholder',    'wait_for', { at: '{{maybe_null}}', nextStep: 5, skipToStep: 7 }, null],
    ['wait_for randomizeMinutes 9999','wait_for', { duration: '2h', nextStep: 5, randomizeMinutes: 9999 }, 'must be <= 1440'],
    ['wait_for randomizeMinutes -1',  'wait_for', { duration: '2h', nextStep: 5, randomizeMinutes: -1 }, 'must be >= 0'],

    // schedule_resume — required nullishSkipsBlock param
    ['schedule_resume with duration', 'schedule_resume', { resumeAt: '2h', nextStep: 4 }, null],
    ['schedule_resume null skip',     'schedule_resume', { resumeAt: null, nextStep: 4, skipToStep: 6 }, null],
    ['schedule_resume missing',       'schedule_resume', { nextStep: 4 }, 'resumeAt is required'],

    // evaluate_condition — single vs multi mode
    ['eval simple valid',             'evaluate_condition', { variable: 'x', operator: '==', value: 'y', then: 5 }, null],
    ['eval multi valid',              'evaluate_condition', { conditions: [{ variable: 'x', operator: '==', value: 'y' }], match: 'all', then: 5 }, null],
    ['eval neither',                  'evaluate_condition', { then: 5 }, 'must include exactly one'],
    ['eval both modes',               'evaluate_condition', { variable: 'x', operator: '==', conditions: [], then: 5 }, 'must include only one'],
    ['eval missing then',             'evaluate_condition', { variable: 'x', operator: '==' }, 'then is required'],
    ['eval bad operator',             'evaluate_condition', { variable: 'x', operator: 'INVALID', then: 5 }, 'must be one of'],

    // enroll_sequence — exclusiveOneOf
    ['enroll by_type',                'enroll_sequence', { contact_id: '1', template_type: 'no_show' }, null],
    ['enroll by_id',                  'enroll_sequence', { contact_id: '1', template_id: 42 }, null],
    ['enroll both',                   'enroll_sequence', { contact_id: '1', template_type: 'foo', template_id: 1 }, 'must include only one'],
    ['enroll neither',                'enroll_sequence', { contact_id: '1' }, 'must include exactly one'],

    // create_log — enum on type
    ['log valid type',                'create_log', { type: 'note' }, null],
    ['log bad type',                  'create_log', { type: 'invalid' }, 'must be one of'],
    ['log missing type',              'create_log', {}, 'type is required'],

    // query_db — array types, integer with bounds
    ['query_db valid',                'query_db', { select: ['cases.case_id'], from: 'cases' }, null],
    ['query_db missing select',       'query_db', { from: 'cases' }, 'select is required'],
    ['query_db select not array',     'query_db', { select: 'cases.case_id', from: 'cases' }, 'must be a JSON array'],
    ['query_db limit too high',       'query_db', { select: ['*'], from: 'cases', limit: 9999 }, 'must be <= 1000'],

    // create_appointment — enum
    ['appt valid',                    'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Zoom' }, null],
    ['appt bad platform',             'create_appointment', { contact_id: '1', appt_date: '2026-05-01T10:00:00', appt_type: '341 Meeting', appt_length: 15, appt_platform: 'Carrier Pigeon' }, 'must be one of'],

    // update_contact — object type
    ['update_contact valid',          'update_contact', { contact_id: '1', fields: { contact_type: 'Client' } }, null],
    ['update_contact fields=array',   'update_contact', { contact_id: '1', fields: ['nope'] }, 'must be a JSON object'],

    // run_task_digest — boolean type
    ['digest force=true',             'run_task_digest', { force: true }, null],
    ['digest force=string',           'run_task_digest', { force: 'true' }, 'must be a boolean'],

    // noop — empty params
    ['noop no params',                'noop', {}, null],

    // Generic params shape
    ['set_var array params rejected', 'set_var', [], 'must be a JSON object'],
  ];

  test.each(cases)('%s', (label, fnKey, params, expectedFragment) => {
    const result = v(meta[fnKey], params);
    if (expectedFragment === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result.error).toContain(expectedFragment);
    }
  });
});

describe('__getMeta — single fetch', () => {
  test('returns meta for known function', () => {
    const m = internalFunctions.__getMeta('send_sms');
    expect(m).toBeTruthy();
    expect(m.category).toBe('communication');
  });
  test('returns null for unknown function', () => {
    expect(internalFunctions.__getMeta('does_not_exist')).toBeNull();
  });
});