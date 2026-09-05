/**
 * D4 A1/A3 — schema-side contract: `prefix`/`suffix` adornments and validated
 * `min`/`max` bounds on number fields, plus the load-bearing lock that NONE of
 * these keys can bump schema_version (fieldSignature is name+type only, and
 * live DBKQ drafts exist — a spurious bump raises the "older version" draft
 * warning for a client mid-fill).
 *
 *   npx jest tests/formtemplates.d4schema.test.js
 */
'use strict';

const svc = require('../services/formTemplateService');

/** Minimal valid definition; caller mutates the one field under test. */
function base(field) {
  return {
    sections: [
      { title: 'S', rows: [{ fields: [field, { name: 'other', type: 'text' }] }] },
    ],
  };
}
const ok = (field) => expect(() => svc.validateDefinition(base(field))).not.toThrow();
const bad = (field, re) => expect(() => svc.validateDefinition(base(field))).toThrow(re);

describe('prefix / suffix (D4 A1)', () => {
  test('accepted on number and text', () => {
    ok({ name: 'rent', type: 'number', prefix: '$' });
    ok({ name: 'pct', type: 'number', suffix: '%' });
    ok({ name: 'zone', type: 'text', prefix: '#' });
    ok({ name: 'both', type: 'number', prefix: '$', suffix: '/mo' });
  });

  test('accepted inside repeaters (same two types)', () => {
    const def = {
      sections: [{ repeater: 'debts', title: 'Debts',
        fields: [{ name: 'amt', type: 'number', prefix: '$' }] }],
    };
    expect(() => svc.validateDefinition(def)).not.toThrow();
  });

  test('rejected on other types, with the type named', () => {
    bad({ name: 'x', type: 'date', prefix: '$' }, /prefix is only allowed on type "number" or "text"/);
    bad({ name: 'x', type: 'select', suffix: '%', options: ['a'] },
        /suffix is only allowed on type "number" or "text"/);
    bad({ name: 'x', type: 'checkbox', prefix: '$' }, /prefix is only allowed/);
  });

  test('rejected shapes: non-string, over-long', () => {
    bad({ name: 'x', type: 'number', prefix: 5 }, /prefix must be a string/);
    bad({ name: 'x', type: 'text', suffix: 'x'.repeat(13) }, /suffix must be at most 12 characters/);
  });

  test('empty string / null degrade to absent (no throw)', () => {
    ok({ name: 'x', type: 'number', prefix: '' });
    ok({ name: 'x', type: 'number', prefix: null });
  });
});

describe('min / max (D4 A3)', () => {
  test('numeric bounds accepted on number, including negatives and equal pair', () => {
    ok({ name: 'n', type: 'number', min: 0 });
    ok({ name: 'n', type: 'number', min: -100, max: 100 });
    ok({ name: 'n', type: 'number', min: 5, max: 5 });
  });

  test('rejected on non-number types (silent no-op refused)', () => {
    bad({ name: 'x', type: 'text', min: 0 }, /min is only allowed on type "number"/);
    bad({ name: 'x', type: 'date', max: 9 }, /max is only allowed on type "number"/);
  });

  test('rejected shapes: non-numeric, non-finite, inverted pair', () => {
    bad({ name: 'x', type: 'number', min: '0' }, /min must be a finite number/);
    bad({ name: 'x', type: 'number', max: Infinity }, /max must be a finite number/);
    bad({ name: 'x', type: 'number', min: 10, max: 1 }, /min must be <= /);
  });
});

describe('fieldSignature is blind to every D4 key (the schema_version lock)', () => {
  test('adding prefix/suffix/min/max changes nothing in the signature', () => {
    const plain = base({ name: 'rent', type: 'number' });
    const dressed = base({ name: 'rent', type: 'number', prefix: '$', suffix: '/mo', min: 0, max: 99999 });
    expect(svc.fieldSignature(dressed)).toBe(svc.fieldSignature(plain));
    expect(svc.fieldSignature(plain)).toContain('rent\u0000number');
  });

  test('…and in repeaters too', () => {
    const plain = { sections: [{ repeater: 'r', fields: [{ name: 'amt', type: 'number' }] }] };
    const dressed = { sections: [{ repeater: 'r', fields: [{ name: 'amt', type: 'number', prefix: '$', min: 0 }] }] };
    expect(svc.fieldSignature(dressed)).toBe(svc.fieldSignature(plain));
  });
});
