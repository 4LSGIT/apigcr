/**
 * tests/hookMapper.test.js
 *
 * Tests for services/hookMapper.js — the declarative mapping engine.
 *
 * Shared kernel: this module is used by hooks (hookService), email ingest
 * (emailIngestRuleService — the court-email pipeline) and phone ingest
 * (phoneIngestRuleService), plus lib/actionDispatchers (every `http` action's
 * body_template). A defect here is live in all of them at once.
 *
 * The focus of this file is resolveTemplate's TOKEN GRAMMAR. The old token
 * pattern was [^}]+, which stops at the first "}", so any regex quantifier
 * inside an inline pipe — {{message|regex:(\d{6})}} — matched nothing at all.
 * There was no error: the literal, unresolved template string was returned and
 * stored. The token pattern is now [\s\S]+? (lazy, newline-tolerant), and
 * single-token detection is structural rather than a regex so that "{{a}}{{b}}"
 * is still correctly seen as TWO tokens.
 *
 * The type contract is load-bearing and must not drift: a template that is
 * EXACTLY one token returns the RAW resolved value (a number stays a number);
 * anything else returns a string.
 *
 * Run:
 *   npx jest tests/hookMapper.test.js
 */
const {
  resolvePath,
  setNestedValue,
  resolveTemplate,
  executeMapper,
  resolveBodyTemplate,
} = require('../services/hookMapper');

// The real production message that exposed the transform escape bug.
const CLIO_MSG = '564795 is your Clio login code. Clio will never call or text you to ask for this code.';


// ─────────────────────────────────────────────────────────────
// resolveTemplate — the token grammar
// ─────────────────────────────────────────────────────────────

describe('resolveTemplate — token matrix', () => {
  test('single token returns the RAW value — type preserved', () => {
    expect(resolveTemplate('{{n}}', { n: 42 })).toBe(42);
    expect(resolveTemplate('{{ok}}', { ok: true })).toBe(true);
    expect(resolveTemplate('{{o}}', { o: { a: 1 } })).toEqual({ a: 1 });
    expect(resolveTemplate('{{arr}}', { arr: [1, 2] })).toEqual([1, 2]);
  });

  test('regex quantifier inside an inline pipe — THE FIX', () => {
    // Before: [^}]+ stopped at the "}" of {6}, the token never matched, and the
    // literal string "{{message|regex:(\d{6})}}" was returned verbatim.
    expect(resolveTemplate('{{message|regex:(\\d{6})}}', { message: CLIO_MSG })).toBe('564795');
    expect(resolveTemplate('{{message|regex:(\\d{4,8})}}', { message: CLIO_MSG })).toBe('564795');
    expect(resolveTemplate('{{message|regex:\\d{6}}}', { message: CLIO_MSG })).toBe('564795');
  });

  test('{{a}}{{b}} is TWO tokens, not one token with content "a}}{{b"', () => {
    expect(resolveTemplate('{{a}}{{b}}', { a: 'A', b: 'B' })).toBe('AB');
  });

  test('{{a}} and {{b}}', () => {
    expect(resolveTemplate('{{a}} and {{b}}', { a: 'A', b: 'B' })).toBe('A and B');
  });

  test('mixed text + token → string', () => {
    expect(resolveTemplate('Clio code: {{message|regex:([0-9]+)}}', { message: CLIO_MSG }))
      .toBe('Clio code: 564795');
    expect(resolveTemplate('Clio code: {{message|regex:(\\d+)}}', { message: CLIO_MSG }))
      .toBe('Clio code: 564795');
  });

  test('no tokens → returned unchanged', () => {
    expect(resolveTemplate('no tokens here', { a: 1 })).toBe('no tokens here');
    expect(resolveTemplate('', { a: 1 })).toBe('');
  });

  test('missing path: single token → undefined (raw); multi → empty string', () => {
    expect(resolveTemplate('{{missing}}', {})).toBeUndefined();
    expect(resolveTemplate('x {{missing}} y', {})).toBe('x  y');
  });

  test('newline tolerance — [\\s\\S] keeps what [^}]+ allowed', () => {
    expect(resolveTemplate('{{a}}\n{{b}}', { a: 'A', b: 'B' })).toBe('A\nB');
    expect(resolveTemplate('{{a|regex:(x\ny)}}', { a: 'x\ny' })).toBe('x\ny');
  });

  test('empty token "{{}}" is not a token — passes through literally', () => {
    expect(resolveTemplate('{{}}', {})).toBe('{{}}');
  });

  test('dot-paths and chained inline transforms', () => {
    expect(resolveTemplate('{{body.payload.name|trim|uppercase}} via {{body.event}}', {
      body: { payload: { name: '  jane doe  ' }, event: 'invitee.created' },
    })).toBe('JANE DOE via invitee.created');
  });
});


// ─────────────────────────────────────────────────────────────
// LIVE REGRESSION GUARDS — templates stored in production today
// ─────────────────────────────────────────────────────────────

describe('live template shapes (must not change meaning)', () => {
  test('hooks#3 rule[4].template', () => {
    expect(resolveTemplate('{{body.payload.name|trim|uppercase}} via {{body.event}}', {
      body: { payload: { name: ' jane ' }, event: 'lead.new' },
    })).toBe('JANE via lead.new');
  });

  test('email_ingest_rules#6 rule[0].template — court pipeline', () => {
    const tpl = '[Ingest TEST] VP {{subject|regex:([0-9]+-[0-9]+)}} '
              + '({{text|regex:Case Name.[* ]*([A-Za-z].*[A-Za-z])}})';
    const envelope = {
      subject: 'Notice 25-12345 Ch 7',
      text: 'Case Name: **Jane Q Debtor**\nfiled on 3/14/2026',
    };
    expect(resolveTemplate(tpl, envelope)).toBe('[Ingest TEST] VP 25-12345 (Jane Q Debtor)');
  });

  test('email_ingest_rules#7 rule[1].template — pipe-separated k=v line, many tokens', () => {
    const tpl = 'case_number = {{subject|regex:([0-9]+-[0-9]+)}} | chapter = {{subject|regex:Ch ([0-9]+)}} '
              + '| m341_date = {{text|regex:meeting to be held on[^0-9]*([0-9/]+)}}';
    const envelope = {
      subject: 'Notice 25-12345 Ch 13',
      text: 'The meeting to be held on 4/2/2026 at 10:00 AM',
    };
    expect(resolveTemplate(tpl, envelope))
      .toBe('case_number = 25-12345 | chapter = 13 | m341_date = 4/2/2026');
  });
});


// ─────────────────────────────────────────────────────────────
// resolveBodyTemplate
// ─────────────────────────────────────────────────────────────

describe('resolveBodyTemplate', () => {
  // Asserted by the MTH-1 spec. NOTE: the prompt attributed this body to the
  // live row phone_ingest_rule_actions#4 — that row is in fact an
  // internal_function (set_setting) with a params_mapping and has no
  // body_template. The contract is still worth pinning: it is the JSON-body
  // path used by every `http` action and hook target.
  test('JSON body template — single token inside a JSON string value', () => {
    expect(resolveBodyTemplate('{"value":"{{clio_code}}"}', { clio_code: '642202' }))
      .toBe('{"value":"642202"}');
  });

  // The ONE body_template that is actually live today: hook_targets#10 (hook 6).
  test('LIVE hook_targets#10 body_template', () => {
    expect(resolveBodyTemplate('{"alert": "VIP lead: {{name}}"}', { name: 'Jane' }))
      .toBe('{"alert":"VIP lead: Jane"}');   // JSON.parse → resolve → JSON.stringify normalises spacing
  });

  test('regex quantifier survives the JSON path', () => {
    expect(resolveBodyTemplate('{"code":"{{message|regex:(\\\\d{6})}}"}', { message: CLIO_MSG }))
      .toBe('{"code":"564795"}');
  });

  test('nested objects and arrays are walked', () => {
    expect(resolveBodyTemplate('{"a":{"b":["{{x}}","lit"]}}', { x: 'X' }))
      .toBe('{"a":{"b":["X","lit"]}}');
  });

  test('non-JSON template resolves as plain text', () => {
    expect(resolveBodyTemplate('code is {{c}}', { c: 7 })).toBe('code is 7');
  });

  test('empty / non-string template → the whole transform output as JSON', () => {
    expect(resolveBodyTemplate('', { a: 1 })).toBe('{"a":1}');
    expect(resolveBodyTemplate(null, { a: 1 })).toBe('{"a":1}');
  });

  test('a JSON scalar template is still JSON — a bare "42" parses', () => {
    // JSON.parse('42') succeeds → resolveObjectTemplates passes numbers through.
    expect(resolveBodyTemplate('42', {})).toBe('42');
  });
});


// ─────────────────────────────────────────────────────────────
// executeMapper — end to end (replace-not-merge semantics preserved)
// ─────────────────────────────────────────────────────────────

describe('executeMapper', () => {
  test('from + transforms, template, and value modes', () => {
    const rules = [
      { from: 'body.email', to: 'contact_email', transforms: ['trim', 'lowercase'] },
      { template: '{{body.first}} {{body.last}}', to: 'contact_name' },
      { value: 'webhook', to: 'source' },
    ];
    const { output, errors } = executeMapper(rules, {
      body: { email: '  FRED@4LSG.COM ', first: 'Fred', last: 'S' },
    });
    expect(errors).toEqual([]);
    expect(output).toEqual({
      contact_email: 'fred@4lsg.com',
      contact_name: 'Fred S',
      source: 'webhook',
    });
  });

  test('the escape fix reaches rule-level transforms', () => {
    const { output, errors } = executeMapper(
      [{ from: 'message', to: 'clio_code', transforms: ['regex:(\\d+)'] }],
      { message: CLIO_MSG },
    );
    expect(errors).toEqual([]);
    expect(output).toEqual({ clio_code: '564795' });   // was "d" before the fix
  });

  test('the token fix reaches rule-level templates', () => {
    const { output } = executeMapper(
      [{ template: '{{message|regex:(\\d{4,8})}}', to: 'clio_code' }],
      { message: CLIO_MSG },
    );
    expect(output).toEqual({ clio_code: '564795' });
  });

  test('single-token template preserves type into the output', () => {
    const { output } = executeMapper([{ template: '{{n}}', to: 'count' }], { n: 7 });
    expect(output.count).toBe(7);
    expect(typeof output.count).toBe('number');
  });

  test('replace-not-merge: only mapped keys are emitted (OUT OF SCOPE — pinned, not changed)', () => {
    const { output } = executeMapper([{ from: 'from', to: 'from' }], { from: '+1248', text: 'hi' });
    expect(output).toEqual({ from: '+1248' });   // `text` is dropped, deliberately
  });

  test('dot-path and numeric-index destinations', () => {
    const { output } = executeMapper([
      { from: 'a', to: 'contact.name' },
      { from: 'b', to: 'phones.0' },
    ], { a: 'Jane', b: '2485551212' });
    expect(output).toEqual({ contact: { name: 'Jane' }, phones: ['2485551212'] });
  });

  test('errors are collected per-rule, not thrown', () => {
    const { output, errors } = executeMapper([
      { from: 'a', to: 'good' },
      { to: 'orphan' },                                   // no source
      { from: 'nope', to: 'bad', transforms: ['required'] },
      { from: 'a' },                                      // no `to`
    ], { a: 'A' });
    expect(output).toEqual({ good: 'A' });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/orphan/);
    expect(errors[1]).toMatch(/Required field/);
    expect(errors[2]).toMatch(/missing "to"/);
  });

  test('empty / non-array rules', () => {
    expect(executeMapper([], {})).toEqual({ output: {}, errors: [] });
    expect(executeMapper(null, {})).toEqual({ output: {}, errors: [] });
  });
});


// ─────────────────────────────────────────────────────────────
// resolvePath / setNestedValue — unchanged, pinned
// ─────────────────────────────────────────────────────────────

describe('resolvePath', () => {
  test('dot paths, array indices, missing segments', () => {
    const obj = { a: { b: [{ c: 1 }] } };
    expect(resolvePath(obj, 'a.b.0.c')).toBe(1);
    expect(resolvePath(obj, 'a.b.9.c')).toBeUndefined();
    expect(resolvePath(obj, 'nope')).toBeUndefined();
    expect(resolvePath(null, 'a')).toBeUndefined();
    expect(resolvePath(obj, '')).toBeUndefined();
  });
});

describe('setNestedValue', () => {
  test('creates intermediate objects and arrays', () => {
    const o = {};
    setNestedValue(o, 'a.b.c', 1);
    setNestedValue(o, 'list.0', 'x');
    setNestedValue(o, 'list.1', 'y');
    expect(o).toEqual({ a: { b: { c: 1 } }, list: ['x', 'y'] });
  });
});
