/**
 * Tests for services/hookTransforms.js — the transform kernel.
 *
 * This module is NOT hook-specific despite the name. It is the shared transform
 * kernel behind three live automation subsystems:
 *
 *   Hooks         → services/hookService.js        (public webhook endpoints)
 *   Email Ingest  → services/emailIngestRuleService.js  (the court-email pipeline)
 *   Phone Ingest  → services/phoneIngestRuleService.js  (SMS / call ingest)
 *
 * A defect here is simultaneously live in all three. Treat every assertion below
 * as a production contract, not a unit-test nicety.
 *
 * The bulk of this file pins down parseTransformDescriptor's ESCAPE RULE, which
 * used to be wrong in a way that produced plausible wrong answers rather than
 * errors: `\` was treated as a universal escape and discarded, so `regex:(\d+)`
 * compiled as `(d+)` and matched the letter "d". The fix: `\` escapes only `:`
 * and `\`; every other `\x` keeps both characters.
 */
/*
npm install --save-dev jest

npx jest tests/hookTransforms.test.js

npm uninstall --save-dev jest
*/
const {
  parseTransformDescriptor,
  applyTransform,
  applyChain,
  listTransforms,
  transforms,
} = require('../services/hookTransforms');

// The real production message that exposed the bug (Clio 2FA SMS).
const CLIO_MSG = '564795 is your Clio login code. Clio will never call or text you to ask for this code.';


// ─────────────────────────────────────────────────────────────
// parseTransformDescriptor — the escape rule
// ─────────────────────────────────────────────────────────────

describe('parseTransformDescriptor — escape rule', () => {
  // [ descriptor as typed, expected name, expected args ]
  const MATRIX = [
    ['regex:(\\d+)',      'regex',     ['(\\d+)']],
    ['regex:([0-9]+)',    'regex',     ['([0-9]+)']],
    ['regex:\\d{4,8}',    'regex',     ['\\d{4,8}']],
    ['date:yyyy-MM-dd',   'date',      ['yyyy-MM-dd']],
    ['between:REF=:;',    'between',   ['REF=', ';']],
    ['between:Name\\::;', 'between',   ['Name:', ';']],
    ['replace:\\\\:/',    'replace',   ['\\', '/']],
    ['regex:\\',          'regex',     ['\\']],       // trailing lone backslash
    ['lowercase',         'lowercase', []],
  ];

  test.each(MATRIX)('%j → { name, args }', (descriptor, name, args) => {
    expect(parseTransformDescriptor(descriptor)).toEqual({ name, args });
  });

  test('backslash escapes ONLY ":" and "\\" — every other \\x keeps both chars', () => {
    expect(parseTransformDescriptor('regex:\\w+').args).toEqual(['\\w+']);
    expect(parseTransformDescriptor('regex:\\s').args).toEqual(['\\s']);
    expect(parseTransformDescriptor('regex:\\bfoo\\b').args).toEqual(['\\bfoo\\b']);
    expect(parseTransformDescriptor('regex:a\\.b').args).toEqual(['a\\.b']);
    expect(parseTransformDescriptor('regex:\\d\\d:\\d\\d').args).toEqual(['\\d\\d', '\\d\\d']); // unescaped ":" still splits
  });

  test('empty / non-string input', () => {
    expect(parseTransformDescriptor('')).toEqual({ name: '', args: [] });
    expect(parseTransformDescriptor(null)).toEqual({ name: '', args: [] });
    expect(parseTransformDescriptor(undefined)).toEqual({ name: '', args: [] });
    expect(parseTransformDescriptor(42)).toEqual({ name: '', args: [] });
  });

  test('empty args are preserved as empty strings', () => {
    expect(parseTransformDescriptor('split:,:0')).toEqual({ name: 'split', args: [',', '0'] });
    expect(parseTransformDescriptor('default:')).toEqual({ name: 'default', args: [''] });
  });
});


// ─────────────────────────────────────────────────────────────
// The bug, stated as behaviour
// ─────────────────────────────────────────────────────────────

describe('applyChain — the defect this module was fixed for', () => {
  test('regex:(\\d+) extracts the number, NOT the letter "d"', () => {
    // Before the fix this returned "d" (from the word "code"). No throw, no warning.
    expect(applyChain(CLIO_MSG, ['regex:(\\d+)'])).toBe('564795');
  });

  test('regex:([0-9]+) still works — the existing live workaround must not regress', () => {
    expect(applyChain(CLIO_MSG, ['regex:([0-9]+)'])).toBe('564795');
  });

  test('regex quantifiers work: \\d{4,8}', () => {
    expect(applyChain(CLIO_MSG, ['regex:(\\d{4,8})'])).toBe('564795');
    expect(applyChain(CLIO_MSG, ['regex:\\d{6}'])).toBe('564795');   // no capture group → full match
  });

  test('other regex escapes work', () => {
    expect(applyChain('order #A-4471 shipped', ['regex:#(\\w+-\\d+)'])).toBe('A-4471');
    expect(applyChain('total: 12.50 usd', ['regex:(\\d+\\.\\d+)'])).toBe('12.50');
  });
});


// ─────────────────────────────────────────────────────────────
// LIVE REGRESSION GUARDS — descriptor shapes stored in production
// ─────────────────────────────────────────────────────────────

describe('live descriptor shapes (must be byte-for-byte unchanged)', () => {
  test('between:REF=:; — the only live escaped-colon-adjacent descriptor', () => {
    expect(parseTransformDescriptor('between:REF=:;')).toEqual({
      name: 'between',
      args: ['REF=', ';'],
    });
    expect(applyChain('foo REF=12345; bar', ['between:REF=:;'])).toBe('12345');
  });

  // Verbatim from the live court-email ingest pipeline (email_ingest_rules).
  const LIVE = [
    ['regex:([0-9]+-[0-9]+)',                       '25-12345 Ch 7 filed', '25-12345'],
    ['regex:Ch ([0-9]+)',                           '25-12345 Ch 13 filed', '13'],
    ['regex:filed on ([0-9]+/[0-9]+/[0-9]+)',       'filed on 3/14/2026 in', '3/14/2026'],
    ['regex:meeting to be held on[^0-9]*([0-9/]+)', 'meeting to be held on 4/2/2026 at', '4/2/2026'],
    ['regex:Trustee[^A-Za-z]+([A-Z][A-Za-z. ]+?[A-Za-z]) with',
      'Trustee: Jane Q. Smith with the', 'Jane Q. Smith'],
  ];

  test.each(LIVE)('%s', (descriptor, input, expected) => {
    expect(applyChain(input, [descriptor])).toBe(expected);
  });

  test('a chain, as stored: ["regex:([0-9]+-[0-9]+)", "trim"]', () => {
    expect(applyChain('Case 25-12345 filed', ['regex:([0-9]+-[0-9]+)', 'trim'])).toBe('25-12345');
  });
});


// ─────────────────────────────────────────────────────────────
// Registry sanity — transforms that take args through the parser
// ─────────────────────────────────────────────────────────────

describe('applyTransform', () => {
  test('no-arg transforms', () => {
    expect(applyTransform('uppercase', 'hello')).toBe('HELLO');
    expect(applyTransform('lowercase', 'HeLLo')).toBe('hello');
    expect(applyTransform('trim', '  hi  ')).toBe('hi');
    expect(applyTransform('digits_only', '(248) 621-3656')).toBe('2486213656');
  });

  test('arg-bearing transforms round-trip through the parser', () => {
    expect(applyTransform('split:,:1', 'a,b,c')).toBe('b');
    expect(applyTransform('replace:-:/', '2026-07-13')).toBe('2026/07/13');
    expect(applyTransform('before:@', 'fred@4lsg.com')).toBe('fred');
    expect(applyTransform('after:@', 'fred@4lsg.com')).toBe('4lsg.com');
    expect(applyTransform('default:n/a', '')).toBe('n/a');
    // No trailing Z — parsed as local, formatted as local, so this is TZ-independent.
    expect(applyTransform('date:yyyy-MM-dd', '2026-07-13T15:04:05')).toBe('2026-07-13');
  });

  test('split on a literal comma still works (the descriptor is colon-delimited)', () => {
    expect(applyTransform('split:,:0', 'x,y')).toBe('x');
  });

  test('unknown transform throws', () => {
    expect(() => applyTransform('nope', 'x')).toThrow(/Unknown transform: "nope"/);
    // The delimiter bug used to surface here: "regex:(\d{4,8})" split on the comma
    // by the UI produced a fragment "8})" that landed as a transform NAME.
    expect(() => applyTransform('8})', 'x')).toThrow(/Unknown transform/);
  });

  test('a bad regex pattern yields "" rather than throwing', () => {
    expect(applyTransform('regex:(unclosed', 'abc')).toBe('');
  });

  test('regex with no match yields ""', () => {
    expect(applyChain('no numbers here', ['regex:(\\d+)'])).toBe('');
  });
});

describe('applyChain', () => {
  test('applies in order', () => {
    expect(applyChain('  Hello World  ', ['trim', 'uppercase'])).toBe('HELLO WORLD');
  });

  test('empty / non-array chain is a passthrough', () => {
    expect(applyChain('x', [])).toBe('x');
    expect(applyChain('x', null)).toBe('x');
    expect(applyChain('x', undefined)).toBe('x');
  });

  test('preserves non-string types through non-applicable transforms', () => {
    expect(applyChain(42, ['trim'])).toBe(42);
    expect(applyChain(null, ['uppercase'])).toBe(null);
  });
});

describe('listTransforms', () => {
  test('returns a sorted list of every registry key', () => {
    const list = listTransforms();
    expect(list).toEqual([...Object.keys(transforms)].sort());
    expect(list).toContain('regex');
    expect(list).toContain('between');
  });
});
