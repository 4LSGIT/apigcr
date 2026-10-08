// tests/ctaInputs.test.js
//
/**
 * CTA clicker inputs (CTA arc S1i) — services/ctaService.js,
 * ref/CTA_DESIGN.md §12. The first slice where clicker-supplied data crosses
 * into internal-function params.
 *
 * WHAT IS LOCKED
 *   - The OPENED-PARAM SET (__meta.ctaInputParams): an exact snapshot plus a
 *     registry-wide shape check — every opened param is a reviewed exposure
 *     decision, like the eligible-function set in tests/ctaService.test.js.
 *   - Declarations: name/label/type/required/maxlen/choices/pattern/default
 *     rules, the pattern lint (nested quantifiers, backreferences, wide
 *     quantifier count), defaults normalized through the value pipeline.
 *   - The BINDING MATRIX: undeclared / unused / unopened / spliced / nested /
 *     no-meta function / input-less option / result_template [[input:x]].
 *   - BOTH validator passes: mint (defaults-or-samples AND the blank-optional
 *     variant) and click (re-validation of the substituted step).
 *   - ESCAPE-ON-SUBSTITUTE: non-html input → html:true param is escaped +
 *     nl2br at the transport; a declared html input passes raw (behind its
 *     acknowledgment); html:false params are never escaped.
 *   - The value pipeline: type → normalize → maxlen (on the NORMALIZED value)
 *     → pattern; E.164 via the canonical phoneService helper plus a strict
 *     shape check; one email address; plain decimals; real dates; blanks.
 *   - ORDER: inputs are judged AFTER the password and BEFORE the claim — a
 *     bad value burns no use, and no caller without the secret reaches a
 *     pattern.
 *   - POLICY: protection default 'password'; the two acknowledge-to-proceed
 *     risk codes (fail closed, recorded in the receipt); the HARD rule
 *     (repeatable + recipient needs max_uses, not acknowledgeable);
 *     timeout_option needs defaults; the sweep substitutes them.
 *   - binding_closed: a param closed after mint refuses before any claim.
 *   - Audit: cta_executions.inputs holds the normalized values; the outcome
 *     log row (staff-visible) never does.
 *   - Descriptor shape: declarations without pattern/bindings/plans.
 *
 * HARNESS: the REAL ctaService + REAL registry over tests/helpers/ctaWorld.js
 * (as tests/ctaService.test.js). Mocked: the alert sink and the two
 * transports (emailService.sendEmail, phoneService.sendSms) — the real
 * send_email / send_sms internal functions run, so assertions read exactly
 * what would have left the building. phoneService's mock spreads the actual
 * module, so ctaService's phone inputs use the REAL normalizeE164.
 * A few cases register a temp registry function (deleted in finally) where
 * the real registry has no param that can fail a given check.
 *
 * Run: npx jest tests/ctaInputs.test.js
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/emailService', () => ({
  ...jest.requireActual('../services/emailService'),
  sendEmail: jest.fn(async () => ({ messageId: 'm-1' })),
}));
jest.mock('../services/phoneService', () => ({
  ...jest.requireActual('../services/phoneService'),
  sendSms: jest.fn(async () => ({ id: 's-1' })),
}));

const bcrypt = require('bcrypt');
const cta = require('../services/ctaService');
const registry = require('../lib/internal_functions');
const emailService = require('../services/emailService');
const phoneService = require('../services/phoneService');
const { alert } = require('../lib/alerting');
const { makeCtaWorld, decodeLog } = require('./helpers/ctaWorld');

const SU = 6;
const HOUR = 3600e3;
const PW = 'correct-horse-battery';

let db;
let W;

afterEach(() => {
  for (const g of W.gates) expect({ gate: String(g.re), opened: g.open }).toEqual({ gate: String(g.re), opened: true });
  for (const h of W.hooks) expect({ hook: String(h.re), fired: h.hits > 0 }).toEqual({ hook: String(h.re), fired: true });
});

beforeEach(() => {
  db = makeCtaWorld();
  W = db.W;
  alert.mockClear();
  emailService.sendEmail.mockReset().mockImplementation(async () => ({ messageId: 'm-1' }));
  phoneService.sendSms.mockReset().mockImplementation(async () => ({ id: 's-1' }));
});

// ── fixtures ────────────────────────────────────────────────────────────────

const IN = {
  to: { name: 'to', label: 'Phone', type: 'phone', required: true, maxlen: 16 },
  msg: { name: 'msg', label: 'Message', type: 'text', required: true, maxlen: 320 },
  email: { name: 'email', label: 'Email', type: 'email', required: true, maxlen: 100 },
  note: { name: 'note', label: 'Note', type: 'text', required: true, maxlen: 500 },
  body: { name: 'body', label: 'Body', type: 'html', required: true, maxlen: 1000 },
};
const SMS = (to = '[[input:to]]', message = '[[input:msg]]') => ({ fn: 'send_sms', params: { from: '2485559999', to, message } });
const EMAIL = (over = {}) => ({ fn: 'send_email', params: { from: 'info@4lsg.com', to: 'client@example.com', subject: 'Hello', ...over } });
const LOG = (message = '[[input:note]]') => ({ fn: 'create_log', params: { type: 'note', message } });

function opt(over = {}) {
  return { value: 'go', label: 'Go', inputs: [IN.note], plan: [LOG()], ...over };
}
function mint(over = {}) {
  return {
    name: 'Inputs link',
    prompt: 'Tell us something',
    minted_by: SU,
    protection: 'none',
    options: [opt()],
    ...over,
  };
}

async function expect400(p, re, code) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(cta.CtaError);
  expect(err.status).toBe(400);
  if (re) expect(err.message).toMatch(re);
  if (code) expect(err.code).toBe(code);
  return err;
}

/** Mint, then respond with `inputs`. Returns { m, r }. */
async function mintAndRespond(mintOver, inputs, respondOver = {}) {
  const m = await cta.mintCta(db, mint(mintOver));
  const r = await cta.respond(db, { token: m.token, value: (respondOver.value || 'go'), inputs, ...respondOver });
  return { m, r };
}

/** Register a temp registry function for the duration of `body`. */
async function withTempFn(name, impl, meta, body) {
  registry[name] = Object.assign(impl, { __meta: meta });
  try { return await body(); } finally { delete registry[name]; }
}

const ctaAlerts = () => alert.mock.calls.map((c) => c[1]).filter((a) => a.source === 'cta');
const claims = () => W.queries.filter((q) => /^UPDATE cta_links SET (status='used'|uses_count = uses_count \+ 1)/.test(q.sql));

// ═════════════════════════════════════════════════════════════════════════════
// Opened params (Ruling 6c) — the exposure snapshot
// ═════════════════════════════════════════════════════════════════════════════

// Every opened param is a reviewed exposure decision: a new one lands here
// only by someone editing this object on purpose. §12's seed said send_sms
// {text}; send_sms's body param is `message` (S1i report, ruling item 1).
// Recipients pin the input type their transport takes (S1i review N6).
const EXPECTED_OPENED = {
  create_log: { message: { kind: 'content' } },
  create_task: { description: { kind: 'content' } },
  send_email: { html: { kind: 'content', html: true }, subject: { kind: 'content' }, to: { kind: 'recipient', type: 'email' } },
  send_sms: { message: { kind: 'content' }, to: { kind: 'recipient', type: 'phone' } },
};

describe('opened params — __meta.ctaInputParams', () => {
  test('the full opened set is exactly the reviewed snapshot', () => {
    expect(cta.openedInputParams()).toEqual(EXPECTED_OPENED);
  });

  test('registry-wide shape: every declared opening is a real string param of an eligible function', () => {
    const all = registry.__getAllMeta();
    for (const [fn, meta] of Object.entries(all)) {
      if (meta.ctaInputParams === undefined) continue;
      expect({ fn, eligible: cta.isCtaEligible(fn) }).toEqual({ fn, eligible: true });
      for (const [param, spec] of Object.entries(meta.ctaInputParams)) {
        const p = meta.params.find((x) => x.name === param);
        expect({ fn, param, exists: !!p, type: p && p.type }).toEqual({ fn, param, exists: true, type: 'string' });
        expect(['recipient', 'content']).toContain(spec.kind);
        if (spec.html !== undefined) expect(spec.html).toBe(true);
        if (spec.type !== undefined) {
          expect({ fn, param, kind: spec.kind }).toEqual({ fn, param, kind: 'recipient' });
          expect(['phone', 'email']).toContain(spec.type);
        }
        expect(Object.keys(spec).every((k) => ['kind', 'html', 'type'].includes(k))).toBe(true);
      }
    }
  });

  test('openedParamSpec ignores phantom params, bad kinds, prototype names and ineligible functions', () => withTempFn(
    'cta_test_open_probe',
    async () => ({ success: true }),
    {
      category: 'dev', description: 'probe',
      params: [{ name: 'real', type: 'string', required: false }, { name: 'odd', type: 'string', required: false }],
      ctaInputParams: {
        real: { kind: 'content' }, ghost: { kind: 'content' }, odd: { kind: 'admin' },
        typed_content: { kind: 'content', type: 'phone' }, typed_bad: { kind: 'recipient', type: 'text' },
      },
    },
    async () => {
      registry.cta_test_open_probe.__meta.params.push(
        { name: 'typed_content', type: 'string', required: false }, { name: 'typed_bad', type: 'string', required: false });
      expect(cta.openedParamSpec('cta_test_open_probe', 'real')).toEqual({ kind: 'content', html: false });
      expect(cta.openedParamSpec('cta_test_open_probe', 'typed_content')).toBeNull();   // type is for recipients only
      expect(cta.openedParamSpec('cta_test_open_probe', 'typed_bad')).toBeNull();       // phone|email only
      expect(cta.openedParamSpec('send_sms', 'to')).toEqual({ kind: 'recipient', html: false, type: 'phone' });
      expect(cta.openedParamSpec('cta_test_open_probe', 'ghost')).toBeNull();     // not a meta param
      expect(cta.openedParamSpec('cta_test_open_probe', 'odd')).toBeNull();       // unknown kind
      expect(cta.openedParamSpec('cta_test_open_probe', 'constructor')).toBeNull();
      expect(cta.openedParamSpec('cta_test_open_probe', '__proto__')).toBeNull();
      expect(cta.openedParamSpec('send_sms', 'from')).toBeNull();                 // real, not opened
      expect(cta.openedParamSpec('wait_until_time', 'time')).toBeNull();          // denied fn
    },
  ));
});

// ═════════════════════════════════════════════════════════════════════════════
// Declarations
// ═════════════════════════════════════════════════════════════════════════════

describe('input declarations (mint)', () => {
  const withInput = (decl, plan = [LOG('[[input:' + (decl && decl.name) + ']]')]) =>
    mint({ options: [{ value: 'go', label: 'Go', inputs: [decl], plan }] });

  test('stored normalized on the option; receipt lists names', async () => {
    const r = await cta.mintCta(db, mint({ options: [opt({ inputs: [{ ...IN.note, label: '  Note  ' }] })] }));
    expect(r.options).toEqual([{ value: 'go', label: 'Go', inputs: ['note'] }]);
    expect(JSON.parse(W.link(r.id).options)[0].inputs).toEqual([{ name: 'note', label: 'Note', type: 'text', required: true, maxlen: 500 }]);
  });

  test('name: the result_var rule, reserved names, unique per option', async () => {
    await expect400(cta.mintCta(db, withInput({ ...IN.note, name: '9lives' })), /name must match/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, name: 'a-b' })), /name must match/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, name: 'x'.repeat(65) })), /name must match/);
    for (const n of ['__proto__', 'constructor', 'prototype']) {
      await expect400(cta.mintCta(db, withInput({ ...IN.note, name: n })), /is reserved/);
    }
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note, { ...IN.note }] })] })), /duplicate input name "note"/);
    // the same name on two different options is fine
    await expect(cta.mintCta(db, mint({ options: [opt(), opt({ value: 'other' })] }))).resolves.toBeTruthy();
  });

  test('label, type, required, maxlen are mandatory and bounded; unknown keys rejected; ≤10 inputs', async () => {
    await expect400(cta.mintCta(db, withInput({ ...IN.note, label: ' ' })), /label must be 1–100/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, label: 'x'.repeat(101) })), /label must be 1–100/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, type: 'password' })), /type must be one of/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, required: 'yes' })), /required must be true or false/);
    const { required: _r, ...noReq } = IN.note;
    await expect400(cta.mintCta(db, withInput(noReq)), /required must be true or false/);
    const { maxlen: _m, ...noMax } = IN.note;
    await expect400(cta.mintCta(db, withInput(noMax)), /maxlen is required/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, maxlen: 1001 })), /maxlen is required: an integer 1–1000/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, maxlen: 0 })), /maxlen is required/);
    // normalized-width floors: below them every value would be rejected
    await expect400(cta.mintCta(db, withInput({ ...IN.to, maxlen: 11 }, [SMS('[[input:to]]', 'hi')])), /maxlen 11 is below 12 — every phone value/);
    await expect400(cta.mintCta(db, withInput({ name: 'd', label: 'D', type: 'date', required: true, maxlen: 9 })), /maxlen 9 is below 10/);
    await expect(cta.mintCta(db, withInput({ ...IN.to, maxlen: 12 }, [SMS('[[input:to]]', 'hi')]))).resolves.toBeTruthy();
    await expect400(cta.mintCta(db, withInput({ ...IN.note, placeholder: 'x' })), /unknown field "placeholder"/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...IN.note, name: `n${i}` }));
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: eleven })] })), /at most 10/);
  });

  test('hint: optional help text — trimmed, ≤200 chars, a string; blank is not stored', async () => {
    const r = await cta.mintCta(db, withInput({ ...IN.note, hint: '  Two or three sentences <b>please</b>  ' }));
    expect(JSON.parse(W.link(r.id).options)[0].inputs[0]).toEqual({
      name: 'note', label: 'Note', type: 'text', required: true, maxlen: 500, hint: 'Two or three sentences <b>please</b>',
    });
    for (const blank of ['', '   ', null]) {
      const b = await cta.mintCta(db, withInput({ ...IN.note, hint: blank }));
      expect(JSON.parse(W.link(b.id).options)[0].inputs[0]).not.toHaveProperty('hint');
    }
    await expect(cta.mintCta(db, withInput({ ...IN.note, hint: 'h'.repeat(200) }))).resolves.toBeTruthy();
    await expect400(cta.mintCta(db, withInput({ ...IN.note, hint: 'h'.repeat(201) })), /hint must be at most 200 chars/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, hint: 42 })), /hint must be a string/);
  });

  test('enum: choices required (1–20, option-value charset, unique, ≤ maxlen); choices only on enum', async () => {
    const e = { name: 'pick', label: 'Pick', type: 'enum', required: true, maxlen: 10 };
    await expect400(cta.mintCta(db, withInput(e)), /needs 1–20 choices/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: [] })), /needs 1–20 choices/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: Array.from({ length: 21 }, (_, i) => `c${i}`) })), /needs 1–20/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: ['a b'] })), /each choice must match/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: ['<b>'] })), /each choice must match/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: ['a', 'a'] })), /duplicate choice/);
    await expect400(cta.mintCta(db, withInput({ ...e, choices: ['abcdefghijk'] })), /longer than maxlen/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, choices: ['a'] })), /applies to type enum only/);
    await expect(cta.mintCta(db, withInput({ ...e, choices: ['yes', 'no'] }))).resolves.toBeTruthy();
  });

  test('pattern: ≤100 chars, compiles alone, and must compile on the LINEAR-TIME engine (S1i review R1)', async () => {
    const p = (pattern) => withInput({ ...IN.note, pattern });
    await expect400(cta.mintCta(db, p('x'.repeat(101))), /1–100 character string/);
    await expect400(cta.mintCta(db, p('(')), /not a valid regular expression/);
    await expect400(cta.mintCta(db, p('.*)|(')), /not a valid regular expression/);   // can't break out of the anchor wrapper
    // what the linear engine can't run is a mint 400 — and the message names the limit
    for (const bad of ['(?=a)a', 'x(?!y)', '(a)\\1', '(?<n>a)\\k<n>']) {
      await expect400(cta.mintCta(db, p(bad)), /must run in linear time: repeat counts above 16 aren't supported .* lookahead and backreferences aren't supported/);
    }
    for (const [bad, big] of [['\\d{17}', '{17}'], ['.{0,50}', '{0,50}'], ['[A-Za-z ]{1,40}', '{1,40}'], ['\\d{20,}', null]]) {
      const err = await expect400(cta.mintCta(db, p(bad)), /must run in linear time/);
      if (big) expect(err.message).toContain(`(${big} is too large)`);
    }
    // everything the old backtracking lint rejected — and the patterns that beat it — mints now
    for (const ok of ['(a+)+', '(\\d+\\s?)*', '.*.*.*.*x', '(a?a?)+b', '[^](a+)+b', '(a|a)+b', '(\\w|\\d)+x', '(.|\\s)*x',
      '(\\d{3}-)+\\d{4}', '[A-Z]{2}\\d{4,8}', '\\d{16}', '\\d{9}\\d{8}', '(?<=a)b', '(?:yes|no)', '[^@]+@[^@]+\\.[a-z]+']) {
      await expect(cta.mintCta(db, p(ok))).resolves.toBeTruthy();
    }
  });

  test('the linear engine is present in this runtime (a Node upgrade that drops the flag fails CI here)', () => {
    expect(cta.linearRegexAvailable()).toBe(true);
    expect(() => new RegExp('a', 'l')).not.toThrow();
  });

  test('default: runs the full value pipeline and is stored normalized; {{...}} rejected', async () => {
    const toDecl = (d) => ({ ...IN.to, default: d });
    const plan = [SMS('[[input:to]]', 'hi')];
    await expect400(cta.mintCta(db, withInput(toDecl('not a phone'), plan)), /inputs\[0\]\.default: Enter a valid phone number/);
    const r = await cta.mintCta(db, withInput(toDecl('(248) 555-0100'), plan));
    expect(JSON.parse(W.link(r.id).options)[0].inputs[0].default).toBe('+12485550100');
    await expect400(cta.mintCta(db, withInput({ ...IN.note, default: '{{contactName}}' })), /default: unresolved \{\{/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, maxlen: 3, default: 'abcd' })), /default: Use at most 3/);
    await expect400(cta.mintCta(db, withInput({ ...IN.note, pattern: '[a-z]+', default: 'ABC' })), /default: This is not in the expected format/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The binding matrix
// ═════════════════════════════════════════════════════════════════════════════

describe('binding matrix — [[input:name]] (Ruling 5)', () => {
  test('a whole top-level value of an opened param binds; stored frozen as the token', async () => {
    const r = await cta.mintCta(db, mint({ options: [opt({ inputs: [IN.to, IN.msg], plan: [SMS()] })] }));
    expect(JSON.parse(W.link(r.id).options)[0].plan[0].params).toEqual({ from: '2485559999', to: '[[input:to]]', message: '[[input:msg]]' });
  });

  test('undeclared input → 400 (also on an option that declares no inputs)', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [LOG('[[input:nope]]')] })] })),
      /\[\[input:nope\]\] — no input "nope" is declared/);
    await expect400(cta.mintCta(db, mint({ options: [{ value: 'go', label: 'Go', plan: [LOG('[[input:note]]')] }] })),
      /no input "note" is declared/);
  });

  test('declared but never bound → 400 (a result_template reference is not a binding)', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note, IN.msg] })] })),
      /inputs: "msg" is declared but never bound/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note, IN.msg], result_template: 'You said [[input:msg]]' })] })),
      /"msg" is declared but never bound/);
  });

  test('a param the function does not open → 400 naming what it does open', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note], plan: [{ fn: 'send_sms', params: { from: '[[input:note]]', to: '2485550100', message: 'x' } }] })] })),
      /send_sms\.from is not open to clicker inputs \(send_sms opens: to, message\)/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note], plan: [{ fn: 'lookup_contact', params: { contact_id: '[[input:note]]' } }] })] })),
      /lookup_contact\.contact_id is not open to clicker inputs \(lookup_contact opens: none\)/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.note], plan: [{ fn: 'create_log', params: { type: '[[input:note]]' } }] })] })),
      /create_log\.type is not open/);
  });

  test('a recipient param takes only a phone or email input (one recipient per use)', async () => {
    const asText = { ...IN.email, type: 'text' };
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [asText], plan: [EMAIL({ to: '[[input:email]]', html: 'x' })] })] })),
      /send_email\.to is a recipient — bind a phone or email input \(input "email" is text/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [{ ...IN.to, type: 'number' }], plan: [SMS('[[input:to]]', 'hi')] })] })),
      /send_sms\.to is a recipient/);
    await expect(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.email], plan: [EMAIL({ to: '[[input:email]]', html: 'x' })] })] }))).resolves.toBeTruthy();
  });

  test('splicing inside a string and nesting below the top level → 400', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [LOG('Note: [[input:note]]')] })] })),
      /params\.message: \[\[input:…\]\] must be a param's whole top-level value — no splicing/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [LOG('[[input:note]] ')] })] })), /no splicing/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [
      LOG('[[input:note]]'),
      { fn: 'start_workflow', params: { workflow_id: '27', init_data: { lead: { email: '[[input:note]]' } } } },
    ] })] })), /plan\[1\]\.params\.init_data\.lead\.email: \[\[input:…\]\] must be/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [LOG('[[input:note]]'), { fn: 'create_log', params: { type: 'note', data: ['[[input:note]]'] } }] })] })),
      /params\.data\[0\]: \[\[input:…\]\] must be/);
  });

  test('result_template [[input:x]] must name an input of THIS option', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ result_template: 'Got [[input:nope]]' })] })),
      /references \[\[input:nope\]\] — no such input/);
    await expect400(cta.mintCta(db, mint({ options: [opt(), { value: 'b', label: 'B', plan: [LOG('static')], result_template: '[[input:note]]' }] })),
      /options\[1\]\.result_template references \[\[input:note\]\]/);
    await expect(cta.mintCta(db, mint({ options: [opt({ result_template: 'Got [[input:note]] / [[1.output.log_id]]' })] }))).resolves.toBeTruthy();
  });

  test('one input may feed several params', async () => {
    const r = await cta.mintCta(db, mint({ options: [opt({ plan: [LOG(), { fn: 'create_task', params: { title: 'Follow up', assigned_to: 22, description: '[[input:note]]' } }] })] }));
    expect(r.options[0].inputs).toEqual(['note']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Validator pass 1 — mint (defaults or samples, and the blank-optional variant)
// ═════════════════════════════════════════════════════════════════════════════

describe('mint validator pass (__validateFunctionParams with substitutes)', () => {
  const INT_SINK = {
    category: 'dev', description: 'integer sink',
    params: [{ name: 'n', type: 'integer', required: true }],
    ctaInputParams: { n: { kind: 'content' } },
  };

  test('samples stand in for default-less inputs — a type the param rejects fails the mint (dry_run too)', () => withTempFn(
    'cta_test_int_sink', async (p) => ({ success: true, output: { n: p.n } }), { ...INT_SINK },
    async () => {
      const m = (decl) => mint({ options: [{ value: 'go', label: 'Go', inputs: [decl], plan: [{ fn: 'cta_test_int_sink', params: { n: '[[input:v]]' } }] }] });
      const text = { name: 'v', label: 'V', type: 'text', required: true, maxlen: 10 };
      await expect400(cta.mintCta(db, m(text)), /plan\[0\] \(cta_test_int_sink\) with default\/sample inputs: n: must be an integer/);
      await expect400(cta.mintCta(db, { ...m(text), dry_run: true }), /with default\/sample inputs/);
      // the default, when present, is what stands in
      await expect(cta.mintCta(db, m({ ...text, default: '5' }))).resolves.toBeTruthy();
      await expect(cta.mintCta(db, m({ ...text, type: 'number' }))).resolves.toBeTruthy();
    },
  ));

  test('an optional, default-less input bound to a REQUIRED param fails the mint', async () => {
    const optMsg = { ...IN.msg, required: false };
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.to, optMsg], plan: [SMS()] })] })),
      /with optional input "msg" left blank: message is required — make the input required or give it a default/);
    await expect400(cta.mintCta(db, mint({ dry_run: true, options: [opt({ inputs: [IN.to, optMsg], plan: [SMS()] })] })), /left blank/);
    await expect(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.to, { ...optMsg, default: 'Hi' }], plan: [SMS()] })] }))).resolves.toBeTruthy();
    // requiredWith groups too: send_email html optional with no text literal
    const optBody = { ...IN.msg, name: 'b', required: false };
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [optBody], plan: [EMAIL({ html: '[[input:b]]' })] })] })),
      /left blank: must include at least one of: text, html/);
    await expect(cta.mintCta(db, mint({ options: [opt({ inputs: [optBody], plan: [EMAIL({ html: '[[input:b]]', text: 'plain' })] })] }))).resolves.toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Click: the pipeline, escape-on-substitute, validator pass 2, order
// ═════════════════════════════════════════════════════════════════════════════

describe('click — escape-on-substitute (§12)', () => {
  test('a text input into send_email.html (html:true) is escaped + nl2br; subject (html:false) stays raw', async () => {
    const subj = { name: 'subj', label: 'Subject', type: 'text', required: true, maxlen: 100 };
    const { r } = await mintAndRespond(
      { options: [opt({ inputs: [IN.msg, subj], plan: [EMAIL({ subject: '[[input:subj]]', html: '[[input:msg]]' })] })] },
      { msg: '<script>alert(1)</script> & "q"\r\nline 2', subj: 'Re: <b>you</b> & me' },
    );
    expect(r).toMatchObject({ ok: true, status: 'success' });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail.html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;<br>line 2');
    expect(mail.html).not.toContain('<script>');
    expect(mail.subject).toBe('Re: <b>you</b> & me');
  });

  test('every non-html type is escaped into an html param (email with an apostrophe, enum, number)', async () => {
    const em = { ...IN.email, name: 'e' };
    const { r } = await mintAndRespond(
      { options: [opt({ inputs: [em], plan: [EMAIL({ html: '[[input:e]]' })] })] },
      { e: "O'Brien@Example.com" },
    );
    expect(r.ok).toBe(true);
    expect(emailService.sendEmail.mock.calls[0][1].html).toBe('o&#39;brien@example.com');
  });

  test('a declared html input passes RAW into the html param (behind raw_html_input)', async () => {
    const { r } = await mintAndRespond(
      { accept_risks: ['raw_html_input'], options: [opt({ inputs: [IN.body], plan: [EMAIL({ html: '[[input:body]]' })] })] },
      { body: '<p>Hi <a href="https://x.test">there</a></p>' },
    );
    expect(r.ok).toBe(true);
    expect(emailService.sendEmail.mock.calls[0][1].html).toBe('<p>Hi <a href="https://x.test">there</a></p>');
  });

  test('html:false params never escape: SMS text and the log message carry the value as typed', async () => {
    const { r } = await mintAndRespond(
      { options: [opt({ inputs: [IN.to, IN.msg], plan: [SMS()] })] },
      { to: '248-555-0100', msg: 'Fish & <chips>' },
    );
    expect(r.ok).toBe(true);
    expect(phoneService.sendSms).toHaveBeenCalledWith(db, '2485559999', '+12485550100', 'Fish & <chips>');
  });

  test('result_template [[input:x]] renders the normalized value — escaped in html, raw in text', async () => {
    const { r } = await mintAndRespond(
      { options: [opt({ inputs: [IN.to, IN.msg], plan: [SMS()], result_template: 'Sent to [[input:to]]: [[input:msg]]' })] },
      { to: '(248) 555-0100', msg: '<i>hey</i>' },
    );
    expect(r.result).toBe('Sent to +12485550100: <i>hey</i>');
    expect(r.result_html).toBe('Sent to +12485550100: &lt;i&gt;hey&lt;/i&gt;');
  });
});

describe('click — the value pipeline (type → normalize → maxlen → pattern)', () => {
  const v = (decl, raw) => cta.validateInputValue(decl, raw);

  test('phone: the canonical normalizeE164 + a strict E.164 shape', () => {
    const d = { ...IN.to };
    expect(v(d, '(248) 555-0100')).toEqual({ value: '+12485550100' });
    expect(v(d, '1 248.555.0100')).toEqual({ value: '+12485550100' });
    expect(v(d, '+1 248 555 0100')).toEqual({ value: '+12485550100' });
    expect(v(d, '+442079460958')).toEqual({ value: '+442079460958' });
    // normalizeE164 passes '+…' through untouched; the shape check is what stops these
    expect(phoneService.normalizeE164('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    for (const bad of ['+44 20 7946 0958', '+<script>', '+12345', '555-0100', '1-800-FLOWERS', '0012485550100']) {
      expect({ bad, r: v(d, bad) }).toEqual({ bad, r: { error: 'Enter a valid phone number.' } });
    }
  });

  test('email: trimmed + lowercased, exactly one address', () => {
    const d = { ...IN.email };
    expect(v(d, '  Pat.Doe+x@Example.COM ')).toEqual({ value: 'pat.doe+x@example.com' });
    for (const bad of ['a@b.com, c@d.com', 'a@b.com;c@d.com', 'Pat <a@b.com>', 'a b@c.com', 'a@b', '"q"@b.com']) {
      expect({ bad, r: v(d, bad) }).toEqual({ bad, r: { error: 'Enter a single valid email address.' } });
    }
  });

  test('number / enum / date / text', () => {
    const n = { name: 'n', label: 'N', type: 'number', required: true, maxlen: 20 };
    expect(v(n, '007')).toEqual({ value: '7' });
    expect(v(n, ' -1.50 ')).toEqual({ value: '-1.5' });
    expect(v(n, 42)).toEqual({ value: '42' });
    for (const bad of ['1e3', '0x10', 'Infinity', '1,000', '', '1e15', '1000000000000000']) {
      expect({ bad, r: v(n, bad) }).toEqual({ bad, r: { error: 'Enter a number.' } });
    }
    const e = { name: 'e', label: 'E', type: 'enum', required: true, maxlen: 10, choices: ['yes', 'no'] };
    expect(v(e, 'yes')).toEqual({ value: 'yes' });
    expect(v(e, 'YES')).toEqual({ error: 'Choose one of the listed options.' });
    const dt = { name: 'd', label: 'D', type: 'date', required: true, maxlen: 10 };
    expect(v(dt, '2026-02-28')).toEqual({ value: '2026-02-28' });
    for (const bad of ['2026-02-30', '2026-2-3', '02/03/2026', '2026-13-01']) {
      expect({ bad, r: v(dt, bad) }).toEqual({ bad, r: { error: 'Enter a date as YYYY-MM-DD.' } });
    }
    const t = { name: 't', label: 'T', type: 'text', required: true, maxlen: 20 };
    expect(v(t, '  a\r\nb  ')).toEqual({ value: 'a\nb' });
    expect(v(t, 'tab\tok')).toEqual({ value: 'tab\tok' });
    expect(v(t, 'nul\u0000')).toEqual({ error: 'This contains characters that are not allowed.' });
    expect(v(t, 'bell\u0007')).toEqual({ error: 'This contains characters that are not allowed.' });
    expect(v(t, ['a'])).toEqual({ error: 'Enter a text value.' });
    expect(v(t, { a: 1 })).toEqual({ error: 'Enter a text value.' });
    expect(v(t, 5)).toEqual({ error: 'Enter a text value.' });   // only a number input takes a JSON number
  });

  test('maxlen is checked on the NORMALIZED value; pattern runs after it, anchored', () => {
    expect(v({ ...IN.to, maxlen: 12 }, '(248) 555-0100')).toEqual({ value: '+12485550100' });   // 14 raw → 12 normalized
    expect(v({ ...IN.to, maxlen: 11 }, '(248) 555-0100')).toEqual({ error: 'Use at most 11 characters.' });
    expect(v({ ...IN.note, maxlen: 5 }, '  abcde  ')).toEqual({ value: 'abcde' });
    expect(v({ ...IN.note, maxlen: 5 }, 'abcdef')).toEqual({ error: 'Use at most 5 characters.' });
    const pat = { ...IN.note, pattern: '[A-Z]{2}\\d{3}' };
    expect(v(pat, 'AB123')).toEqual({ value: 'AB123' });
    expect(v(pat, 'xAB123')).toEqual({ error: 'This is not in the expected format.' });   // anchored: full match
    expect(v({ ...IN.to, pattern: '\\+1248\\d{7}' }, '(248) 555-0100')).toEqual({ value: '+12485550100' });   // pattern sees the normalized value
    expect(v({ ...IN.note, maxlen: 1000 }, 'x'.repeat(4001))).toEqual({ error: 'Use at most 1000 characters.' });
  });
});

describe('click — submission semantics and errors', () => {
  test('blank → default, else required error, else omitted (param absent)', async () => {
    const optNote = { ...IN.note, required: false, default: 'none given' };
    const { r } = await mintAndRespond({ options: [opt({ inputs: [optNote] })] }, { note: '   ' });
    expect(r.ok).toBe(true);
    const planLog = W.logs.map(decodeLog).find((l) => l.message === 'none given');
    expect(planLog).toBeTruthy();

    const { r: r2 } = await mintAndRespond({ options: [opt()] }, {});
    expect(r2).toEqual({ ok: false, code: 'invalid_inputs', errors: { note: 'This field is required.' } });

    // optional, no default, bound to an OPTIONAL param: the key is removed
    const m3 = await cta.mintCta(db, mint({ options: [opt({
      inputs: [{ ...IN.note, required: false }],
      plan: [{ fn: 'create_task', params: { title: 'T', assigned_to: 22, description: '[[input:note]]' } }],
    })] }));
    const opt3 = JSON.parse(W.link(m3.id).options)[0];
    const prep = cta.prepareRun(opt3, {});
    expect(prep.ok).toBe(true);
    expect(prep.plan[0].params).toEqual({ title: 'T', assigned_to: 22 });
    expect({ ...prep.values }).toEqual({});
  });

  test('unknown fields, non-object inputs, inputs on an input-less option → invalid_inputs, generic', async () => {
    const m = await cta.mintCta(db, mint());
    expect(await cta.respond(db, { token: m.token, value: 'go', inputs: { note: 'x', extra: 'y' } }))
      .toEqual({ ok: false, code: 'invalid_inputs', errors: { extra: 'Unknown field.' } });
    const proto = JSON.parse('{"note":"x","__proto__":"z"}');   // an own __proto__ key, as a JSON body delivers it
    const pr = await cta.respond(db, { token: m.token, value: 'go', inputs: proto });
    expect(pr.code).toBe('invalid_inputs');
    expect(Object.prototype.hasOwnProperty.call(pr.errors, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(pr.errors)).toBe(Object.prototype);   // the key never became a prototype
    expect(await cta.respond(db, { token: m.token, value: 'go', inputs: ['x'] }))
      .toEqual({ ok: false, code: 'invalid_inputs', errors: {}, form_error: 'inputs must be an object of input name to value' });
    const plain = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [LOG('static')] }] });
    expect(await cta.respond(db, { token: plain.token, value: 'go', inputs: { note: 'x' } }))
      .toEqual({ ok: false, code: 'invalid_inputs', errors: { note: 'Unknown field.' } });
    expect((await cta.respond(db, { token: plain.token, value: 'go', inputs: {} })).ok).toBe(true);
    expect(W.execs().filter((e) => e.status !== 'success')).toHaveLength(0);
  });

  test('INVALID INPUTS BURN NOTHING: no claim, no increment, no execution row, no plan', async () => {
    const once = await cta.mintCta(db, mint({ options: [opt({ inputs: [IN.to, IN.msg], plan: [SMS()] })] }));
    const bad = await cta.respond(db, { token: once.token, value: 'go', inputs: { to: 'nope', msg: 'x' } });
    expect(bad).toEqual({ ok: false, code: 'invalid_inputs', errors: { to: 'Enter a valid phone number.' } });
    expect(W.link(once.id)).toMatchObject({ status: 'active', uses_count: 0 });
    expect(claims()).toHaveLength(0);
    expect(W.execs(once.id)).toHaveLength(0);
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    // …and the link still works
    expect((await cta.respond(db, { token: once.token, value: 'go', inputs: { to: '2485550100', msg: 'x' } })).ok).toBe(true);

    const rep = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 1, options: [opt()] }));
    for (let i = 0; i < 3; i++) expect((await cta.respond(db, { token: rep.token, value: 'go', inputs: {} })).code).toBe('invalid_inputs');
    expect(W.link(rep.id).uses_count).toBe(0);
    expect((await cta.respond(db, { token: rep.token, value: 'go', inputs: { note: 'ok' } })).ok).toBe(true);
  });

  test('ORDER: the password is judged BEFORE inputs (no caller without the secret reaches the validators)', async () => {
    const m = await cta.mintCta(db, mint({ protection: 'password', password: PW, options: [opt({ inputs: [{ ...IN.note, pattern: '[a-z]+' }] })] }));
    // invalid inputs on every call: the password verdict comes first
    expect(await cta.respond(db, { token: m.token, value: 'go', inputs: { note: 'BAD' } })).toEqual({ ok: false, code: 'password_required' });
    expect(await cta.respond(db, { token: m.token, value: 'go', password: 'nope-nope-nope', inputs: { note: 'BAD' } })).toEqual({ ok: false, code: 'bad_password' });
    expect(await cta.respond(db, { token: m.token, value: 'go', password: PW, inputs: { note: 'BAD' } }))
      .toEqual({ ok: false, code: 'invalid_inputs', errors: { note: 'This is not in the expected format.' } });
    expect(W.link(m.id)).toMatchObject({ status: 'active', uses_count: 0, failed_attempts: 1 });
    expect((await cta.respond(db, { token: m.token, value: 'go', password: PW, inputs: { note: 'fine' } })).ok).toBe(true);
  });

  test('VALIDATOR PASS 2: the substituted step is re-validated before step 1 — a failure claims nothing', () => withTempFn(
    'cta_test_int_sink2',
    jest.fn(async (p) => ({ success: true, output: { n: p.n } })),
    {
      category: 'dev', description: 'integer sink',
      params: [{ name: 'n', type: 'integer', required: true }],
      ctaInputParams: { n: { kind: 'content' } },
    },
    async () => {
      // mint passes on the default ('5'); a text input lets the clicker send non-digits
      const m = await cta.mintCta(db, mint({ options: [{ value: 'go', label: 'Go',
        inputs: [{ name: 'v', label: 'V', type: 'text', required: true, maxlen: 10, default: '5' }],
        plan: [{ fn: 'cta_test_int_sink2', params: { n: '[[input:v]]' } }] }] }));
      const r = await cta.respond(db, { token: m.token, value: 'go', inputs: { v: 'abc' } });
      expect(r).toEqual({ ok: false, code: 'invalid_inputs', errors: { v: "This value can't be used for this action." } });
      expect(registry.cta_test_int_sink2).not.toHaveBeenCalled();
      expect(W.link(m.id)).toMatchObject({ status: 'active', uses_count: 0 });
      expect(W.execs(m.id)).toHaveLength(0);
      const ok = await cta.respond(db, { token: m.token, value: 'go', inputs: { v: '12' } });
      expect(ok.ok).toBe(true);
      expect(registry.cta_test_int_sink2).toHaveBeenCalledWith({ n: '12' }, db);
    },
  ));

  test('BINDING CLOSED after mint: refused before any claim, warning alert once, public "disabled"', () => withTempFn(
    'cta_test_closable',
    jest.fn(async () => ({ success: true, output: {} })),
    {
      category: 'dev', description: 'closable',
      params: [{ name: 's', type: 'string', required: true }],
      ctaInputParams: { s: { kind: 'content' } },
    },
    async () => {
      const m = await cta.mintCta(db, mint({ options: [{ value: 'go', label: 'Go',
        inputs: [{ ...IN.note, name: 'x' }], plan: [{ fn: 'cta_test_closable', params: { s: '[[input:x]]' } }] }] }));
      delete registry.cta_test_closable.__meta.ctaInputParams;      // a later slice closes the param
      expect(await cta.respond(db, { token: m.token, value: 'go', inputs: { x: 'hi' } })).toEqual({ ok: false, code: 'refused', reason: 'binding_closed' });
      expect(registry.cta_test_closable).not.toHaveBeenCalled();
      expect(claims()).toHaveLength(0);
      expect(ctaAlerts()).toEqual([expect.objectContaining({
        kind: 'link_refused', severity: 'warning', group_key: `cta:${m.id}`, dedup_key: `cta:${m.id}:refused:binding_closed`,
      })]);
      // the defense-in-depth path (prepareRun) agrees on its own
      expect(cta.prepareRun((await cta.getCtaById(db, m.id)).options[0], { x: 'hi' })).toMatchObject({ ok: false, code: 'binding_closed' });
    },
  ));
});

// ═════════════════════════════════════════════════════════════════════════════
// S1i review fixes: B1, N2, N6, N1, N3, N4
// ═════════════════════════════════════════════════════════════════════════════

describe('B1 — the hard rule also holds after mint (PATCH + click-time refusal)', () => {
  const smsOpt = () => opt({ inputs: [IN.to, IN.msg], plan: [SMS()] });

  test('PATCH {max_uses:null} is refused on a repeatable open-recipient link; raising or lowering the cap is fine', async () => {
    const m = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 5, accept_risks: ['open_recipient_repeatable'], options: [smsOpt()] }));
    await expect400(cta.patchCta(db, m.id, { max_uses: null }), /max_uses cannot be removed: this link takes a clicker-supplied recipient/);
    expect(W.link(m.id).max_uses).toBe(5);
    expect(W.queries.some((q) => /^UPDATE cta_links SET max_uses = NULL/.test(q.sql))).toBe(false);
    expect((await cta.patchCta(db, m.id, { max_uses: 50 })).after.max_uses).toBe(50);
    // content-only bindings: the cap may go
    const c = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 5 }));
    expect((await cta.patchCta(db, c.id, { max_uses: null })).after.max_uses).toBeNull();
  });

  test('a closed binding counts as a recipient for the PATCH guard (conservative)', () => withTempFn(
    'cta_test_closable2',
    async () => ({ success: true, output: {} }),
    { category: 'dev', description: 'c', params: [{ name: 's', type: 'string', required: true }], ctaInputParams: { s: { kind: 'content' } } },
    async () => {
      const m = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 3, options: [{ value: 'go', label: 'Go',
        inputs: [{ ...IN.note, name: 'x' }], plan: [{ fn: 'cta_test_closable2', params: { s: '[[input:x]]' } }] }] }));
      delete registry.cta_test_closable2.__meta.ctaInputParams;
      await expect400(cta.patchCta(db, m.id, { max_uses: null }), /max_uses cannot be removed/);
    },
  ));

  test('a link that lost its cap some other way (SQL edit) is REFUSED at click — nothing claimed, one deduped alert', async () => {
    const row = W.seedLink({ mode: 'repeatable', max_uses: null, options: [{ value: 'go', label: 'Go', inputs: [IN.to, IN.msg], plan: [SMS()] }] });
    expect(cta.linkRefusal(await cta.getCtaById(db, row.id))).toMatchObject({ reason: 'unbounded_recipient' });
    for (let i = 0; i < 2; i++) {
      expect(await cta.respond(db, { token: row.token, value: 'go', inputs: { to: '2485550100', msg: 'x' } }))
        .toEqual({ ok: false, code: 'refused', reason: 'unbounded_recipient' });
    }
    expect(claims()).toHaveLength(0);
    expect(phoneService.sendSms).not.toHaveBeenCalled();
    expect(ctaAlerts().map((a) => a.dedup_key)).toEqual([`cta:${row.id}:refused:unbounded_recipient`, `cta:${row.id}:refused:unbounded_recipient`]);
    // with the cap back, it runs
    W.link(row.id).max_uses = 3;
    expect((await cta.respond(db, { token: row.token, value: 'go', inputs: { to: '2485550100', msg: 'x' } })).ok).toBe(true);
  });

  test('an input-less marker never triggers a refusal (it is just text)', async () => {
    const row = W.seedLink({ mode: 'repeatable', max_uses: null, options: [{ value: 'go', label: 'Go', plan: [SMS('[[input:to]]', 'x')] }] });
    expect(cta.linkRefusal(await cta.getCtaById(db, row.id))).toBeNull();
  });
});

describe('N2 / N6 — recipient types, at mint and at click', () => {
  test('N6 at mint: a recipient takes the input type its transport understands', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.email], plan: [SMS('[[input:email]]', 'hi')] })] })),
      /send_sms\.to takes a phone input \(input "email" is email\)/);
    await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [IN.to], plan: [EMAIL({ to: '[[input:to]]', html: 'x' })] })] })),
      /send_email\.to takes a email input \(input "to" is phone\)/);
  });

  test('N2/N6 at click: a binding retyped since mint is refused before anything runs', async () => {
    // seeded rows stand in for "valid at mint, meta changed since"
    const textTo = W.seedLink({ options: [{ value: 'go', label: 'Go', inputs: [{ ...IN.note, name: 'to' }], plan: [EMAIL({ to: '[[input:to]]', html: 'x' })] }] });
    expect(await cta.respond(db, { token: textTo.token, value: 'go', inputs: { to: 'a@x.com, b@y.com' } }))
      .toEqual({ ok: false, code: 'refused', reason: 'recipient_type' });
    const phoneToEmail = W.seedLink({ options: [{ value: 'go', label: 'Go', inputs: [IN.to], plan: [EMAIL({ to: '[[input:to]]', html: 'x' })] }] });
    expect(await cta.respond(db, { token: phoneToEmail.token, value: 'go', inputs: { to: '2485550100' } }))
      .toEqual({ ok: false, code: 'refused', reason: 'recipient_type' });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(0);
    // and prepareRun (the sweep's path) refuses the same binding on its own
    expect(cta.prepareRun((await cta.getCtaById(db, textTo.id)).options[0], { to: 'a@x.com' })).toMatchObject({ ok: false, code: 'binding_closed' });
  });
});

describe('N2 — an UNTYPED recipient still takes only phone/email, at click', () => {
  test('a text input feeding a recipient with no pinned type is refused (one recipient per use)', () => withTempFn(
    'cta_test_untyped_recipient',
    jest.fn(async () => ({ success: true, output: {} })),
    { category: 'dev', description: 'r', params: [{ name: 'to', type: 'string', required: true }], ctaInputParams: { to: { kind: 'recipient' } } },
    async () => {
      const plan = [{ fn: 'cta_test_untyped_recipient', params: { to: '[[input:to]]' } }];
      // mint refuses it…
      await expect400(cta.mintCta(db, mint({ options: [opt({ inputs: [{ ...IN.note, name: 'to' }], plan })] })), /is a recipient — bind a phone or email input/);
      // …and a row that exists anyway is refused at click; phone/email run
      const bad = W.seedLink({ options: [{ value: 'go', label: 'Go', inputs: [{ ...IN.note, name: 'to' }], plan }] });
      expect(await cta.respond(db, { token: bad.token, value: 'go', inputs: { to: 'a@x.com, b@y.com' } }))
        .toEqual({ ok: false, code: 'refused', reason: 'recipient_type' });
      expect(registry.cta_test_untyped_recipient).not.toHaveBeenCalled();
      const good = W.seedLink({ options: [{ value: 'go', label: 'Go', inputs: [IN.email], plan: [{ fn: 'cta_test_untyped_recipient', params: { to: '[[input:email]]' } }] }] });
      expect((await cta.respond(db, { token: good.token, value: 'go', inputs: { email: 'a@x.com' } })).ok).toBe(true);
    },
  ));
});

describe('N1 — the splice scan only runs where inputs are declared (WF27 step 47 shape)', () => {
  test('a workflow mint freezing a raw form body that contains "[[input:" into init_data mints, and runs it as text', async () => {
    const body = 'Hi, I need help — my phone is [[input:to]] and also [[input: weird ]]';
    const r = await registry.create_cta({
      name: 'WF27 not-spam reentry', prompt: 'Not spam?', timeout: '30d', _execution_id: 777,
      options: [{ value: 'not_spam', label: 'Not spam - re-run intake', plan: [{ fn: 'start_workflow', params: {
        workflow_id: 27, init_data: { body, meta: '{"site":"x"}', headers: '{}', spam_override: 1 } } }] }],
    }, db);
    expect(r.success).toBe(true);
    const stored = (await cta.getCtaById(db, r.output.cta_id)).options[0];
    expect(stored.plan[0].params.init_data.body).toBe(body);
    const prep = cta.prepareRun(stored, undefined);
    expect(prep).toMatchObject({ ok: true, values: null });
    expect(prep.plan[0].params.init_data.body).toBe(body);   // untouched — never substituted
  });

  test('…while an option that DOES declare inputs still rejects a stray marker', async () => {
    await expect400(cta.mintCta(db, mint({ options: [opt({ plan: [LOG('[[input:note]]'),
      { fn: 'start_workflow', params: { workflow_id: '27', init_data: { body: 'x [[input:note]]' } } }] })] })), /no splicing/);
  });
});

describe('N3 / N4 — value pipeline tightening', () => {
  const v = (decl, raw) => cta.validateInputValue(decl, raw);
  test('N3: email refuses control and format characters (NUL, BEL, zero-width, bidi override)', () => {
    for (const bad of ['a@b.com\u0000', 'a@b.com\u0007', 'a\u200b@b.com', 'a\u200d@b.com', 'a\u202e@b.com', 'a@b\u2060.com']) {
      expect({ bad: JSON.stringify(bad), r: v(IN.email, bad) }).toEqual({ bad: JSON.stringify(bad), r: { error: 'Enter a single valid email address.' } });
    }
    expect(v(IN.email, 'Pat@Example.com')).toEqual({ value: 'pat@example.com' });
  });
  test('N4: numbers beyond 15 significant digits, or that would print in exponent form, are refused — never rounded', () => {
    const n = { name: 'n', label: 'N', type: 'number', required: true, maxlen: 30 };
    for (const bad of ['0.12345678901234567890', '1234567890123456', '0.0000001', '-0.00000012']) {
      expect({ bad, r: v(n, bad) }).toEqual({ bad, r: { error: 'Enter a number.' } });
    }
    expect(v(n, '123456789012345')).toEqual({ value: '123456789012345' });
    expect(v(n, '000123.4500')).toEqual({ value: '123.45' });
    expect(v(n, '0.000001')).toEqual({ value: '0.000001' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Policy (§12)
// ═════════════════════════════════════════════════════════════════════════════

describe('policy — protection default, risk acknowledgments, the hard rule', () => {
  const smsOpt = () => opt({ inputs: [IN.to, IN.msg], plan: [SMS()] });

  test("inputs default protection to 'password' (named in the receipt); explicit 'none' is the override", async () => {
    const { protection: _p, ...noProt } = mint();
    const r = await cta.mintCta(db, noProt);
    expect(r).toMatchObject({ protection: 'password', protection_source: 'default_inputs' });
    expect(r.password).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(r.notes.join(' ')).toMatch(/defaulted to 'password' because an option declares clicker inputs/);
    expect(await cta.mintCta(db, mint({ protection: 'none' }))).toMatchObject({ protection: 'none', protection_source: 'explicit' });
    const plain = await cta.mintCta(db, { ...noProt, options: [{ value: 'go', label: 'Go', plan: [LOG('static')] }] });
    expect(plain).toMatchObject({ protection: 'none', protection_source: 'default' });
  });

  test('HARD RULE: repeatable + recipient binding needs max_uses — even with every risk accepted', async () => {
    await expect400(cta.mintCta(db, mint({ mode: 'repeatable', accept_risks: ['open_recipient_repeatable'], options: [smsOpt()] })),
      /a repeatable link with a clicker-supplied recipient must set max_uses/);
    await expect400(cta.mintCta(db, mint({ mode: 'repeatable', dry_run: true, options: [smsOpt()] })), /must set max_uses/);
    // content-only bindings on a repeatable link don't trip it
    await expect(cta.mintCta(db, mint({ mode: 'repeatable' }))).resolves.toBeTruthy();
    // once + recipient: no rule, no acknowledgment
    await expect(cta.mintCta(db, mint({ options: [smsOpt()] }))).resolves.toMatchObject({ risks_accepted: [] });
    // any max_uses value is the SU's choice
    const ok = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 500, accept_risks: ['open_recipient_repeatable'], options: [smsOpt()] }));
    expect(W.link(ok.id).max_uses).toBe(500);
  });

  test('open_recipient_repeatable fails closed (dry_run too) with machine-readable risks; accepted → recorded', async () => {
    for (const dry of [false, true]) {
      const err = await expect400(cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 5, dry_run: dry, options: [smsOpt()] })),
        /needs explicit risk acceptance — add "open_recipient_repeatable"/, 'risk_acceptance_required');
      expect(err.risks).toEqual([{ code: 'open_recipient_repeatable', description: cta.CTA_RISKS.open_recipient_repeatable }]);
    }
    expect(W.tables.cta_links.size).toBe(0);
    const r = await cta.mintCta(db, mint({ mode: 'repeatable', max_uses: 5, accept_risks: ['open_recipient_repeatable'], options: [smsOpt()] }));
    expect(r.risks_accepted).toEqual(['open_recipient_repeatable']);
  });

  test('raw_html_input: any type:"html" input — even one bound into a plain-text param', async () => {
    const htmlInto = (plan) => mint({ options: [opt({ inputs: [IN.body], plan })] });
    const err = await expect400(cta.mintCta(db, htmlInto([LOG('[[input:body]]')])), /"raw_html_input"/, 'risk_acceptance_required');
    expect(err.risks.map((x) => x.code)).toEqual(['raw_html_input']);
    const r = await cta.mintCta(db, { ...htmlInto([EMAIL({ html: '[[input:body]]' })]), accept_risks: ['raw_html_input'] });
    expect(r.risks_accepted).toEqual(['raw_html_input']);
    // both at once, both listed
    const both = mint({ mode: 'repeatable', max_uses: 2, options: [opt({ inputs: [IN.email, IN.body], plan: [EMAIL({ to: '[[input:email]]', html: '[[input:body]]' })] })] });
    const e2 = await expect400(cta.mintCta(db, { ...both, accept_risks: ['raw_html_input'] }), /"open_recipient_repeatable"/);
    expect(e2.risks.map((x) => x.code)).toEqual(['open_recipient_repeatable']);
    expect((await cta.mintCta(db, { ...both, accept_risks: ['open_recipient_repeatable', 'raw_html_input'] })).risks_accepted)
      .toEqual(['open_recipient_repeatable', 'raw_html_input']);
  });

  test('accept_risks: array of known codes; an inapplicable acceptance is noted, never recorded', async () => {
    await expect400(cta.mintCta(db, mint({ accept_risks: 'raw_html_input' })), /accept_risks must be an array/);
    await expect400(cta.mintCta(db, mint({ accept_risks: [1] })), /accept_risks must be an array/);
    await expect400(cta.mintCta(db, mint({ accept_risks: ['everything'] })), /unknown risk code "everything"/);
    const r = await cta.mintCta(db, mint({ accept_risks: ['raw_html_input'] }));
    expect(r.risks_accepted).toEqual([]);
    expect(r.notes).toContain('accept_risks "raw_html_input" does not apply to this link — not recorded');
  });

  test('timeout_option: every input of THAT option needs a default (the sweep has no clicker)', async () => {
    const base = (inputs) => mint({ timeout_option: 'go', options: [opt({ inputs, plan: [LOG('[[input:note]]')] }), { value: 'other', label: 'O', inputs: [IN.msg], plan: [LOG('[[input:msg]]')] }] });
    await expect400(cta.mintCta(db, base([IN.note])), /timeout_option "go": input "note" needs a default/);
    await expect(cta.mintCta(db, base([{ ...IN.note, default: 'auto' }]))).resolves.toBeTruthy();   // option "other" lacks one — irrelevant
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Timeout path, audit, descriptor
// ═════════════════════════════════════════════════════════════════════════════

describe('cta_expiry_sweep — substitutes defaults', () => {
  test('the timeout plan runs with the defaults (escape applied), recorded on the execution', async () => {
    const m = await cta.mintCta(db, mint({ timeout_option: 'go', options: [opt({
      inputs: [{ ...IN.email, default: 'Default@Example.com' }, { ...IN.msg, default: 'No reply <yet>' }],
      plan: [EMAIL({ to: '[[input:email]]', html: '[[input:msg]]' })],
    })] }));
    W.link(m.id).expires_at = new Date(Date.now() - 1000);
    expect(await cta.sweepExpired(db)).toMatchObject({ claimed: 1, success: 1 });
    const mail = emailService.sendEmail.mock.calls[0][1];
    expect(mail).toMatchObject({ to: 'default@example.com', html: 'No reply &lt;yet&gt;' });
    expect(W.execs(m.id)[0]).toMatchObject({ responded_via: 'timeout', status: 'success' });
    expect(JSON.parse(W.execs(m.id)[0].inputs)).toEqual({ email: 'default@example.com', msg: 'No reply <yet>' });
  });

  test('a default that no longer passes (param closed since mint) → claimed, recorded failed, plan not run', () => withTempFn(
    'cta_test_sweep_sink',
    jest.fn(async () => ({ success: true, output: {} })),
    { category: 'dev', description: 's', params: [{ name: 's', type: 'string', required: true }], ctaInputParams: { s: { kind: 'content' } } },
    async () => {
      const m = await cta.mintCta(db, mint({ timeout_option: 'go', options: [{ value: 'go', label: 'Go',
        inputs: [{ ...IN.note, name: 'x', default: 'd' }], plan: [{ fn: 'cta_test_sweep_sink', params: { s: '[[input:x]]' } }] }] }));
      delete registry.cta_test_sweep_sink.__meta.ctaInputParams;
      W.link(m.id).expires_at = new Date(Date.now() - 1000);
      expect(await cta.sweepExpired(db)).toMatchObject({ claimed: 1, blocked: 1, success: 0 });
      expect(registry.cta_test_sweep_sink).not.toHaveBeenCalled();
      expect(W.link(m.id).status).toBe('used');
      const e = W.execs(m.id)[0];
      expect(e.status).toBe('failed');
      expect(JSON.parse(e.plan_result)[0].error).toMatch(/an input binding is no longer open .* timeout plan not run/);
      expect(ctaAlerts()).toEqual([expect.objectContaining({ kind: 'timeout_blocked', severity: 'warning' })]);
    },
  ));

  test('G1: a link the public sees as "unavailable" (a SIBLING option refused) does not fire its timeout plan', async () => {
    // Option "a" feeds a text input into send_sms.to (a state the mint refuses —
    // seeded to stand in for drift since mint); timeout option "b" is valid.
    const row = W.seedLink({ timeout_option: 'b', options: [
      { value: 'a', label: 'A', inputs: [{ ...IN.note, name: 'to' }], plan: [SMS('[[input:to]]', 'x')] },
      { value: 'b', label: 'B', plan: [LOG('timeout ran')] },
    ] });
    expect(cta.linkRefusal(await cta.getCtaById(db, row.id))).toMatchObject({ reason: 'recipient_type' });
    W.link(row.id).expires_at = new Date(Date.now() - 1000);
    expect(await cta.sweepExpired(db)).toMatchObject({ claimed: 1, blocked: 1, success: 0 });
    expect(W.logs.map(decodeLog).some((l) => l.message === 'timeout ran')).toBe(false);
    expect(W.link(row.id).status).toBe('used');   // claimed, so it can never fire later by surprise
    const e = W.execs(row.id)[0];
    expect(e).toMatchObject({ status: 'failed', responded_via: 'timeout' });
    expect(JSON.parse(e.plan_result)[0].error).toMatch(/^link refused \(recipient_type: option "a": send_sms\.to .* timeout plan not run$/);
    expect(ctaAlerts()).toEqual([expect.objectContaining({ kind: 'timeout_blocked', severity: 'warning' })]);
  });
});

describe('audit — cta_executions.inputs (§12)', () => {
  test('normalized values on the execution and the SU read; never in the staff-visible outcome log', async () => {
    const m = await cta.mintCta(db, mint({ link_type: 'contact', link_id: '1001', options: [opt({ inputs: [IN.to, IN.msg], plan: [SMS()] })] }));
    await cta.respond(db, { token: m.token, value: 'go', inputs: { to: '(248) 555-0100', msg: 'Secret-ish text' } });
    const ins = W.queries.find((q) => /^INSERT INTO cta_executions/.test(q.sql));
    expect(ins.sql).toMatch(/responder_ip, inputs\)/);
    expect(ins.inTxn).toBe(true);
    const out = await cta.listExecutions(db, m.id);
    expect(out.executions[0].inputs).toEqual({ to: '+12485550100', msg: 'Secret-ish text' });
    const outcome = W.logs.map(decodeLog).find((l) => l.subject === 'CTA');
    expect(JSON.stringify(outcome)).not.toMatch(/Secret-ish|2485550100/);
  });

  test('an input-less option inserts WITHOUT naming the column (pre-migration safe) and reads back null', async () => {
    const plain = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [LOG('static')] }] });
    await cta.respond(db, { token: plain.token, value: 'go' });
    const ins = W.queries.find((q) => /^INSERT INTO cta_executions/.test(q.sql));
    expect(ins.sql).not.toMatch(/inputs/);
    expect((await cta.listExecutions(db, plain.id)).executions[0].inputs).toBeNull();
  });
});

describe('publicDescriptor — declarations (§12 Surfaces)', () => {
  test('exactly name/label/hint/type/required/choices/maxlen/default per input — never pattern, plans or bindings', async () => {
    const m = await cta.mintCta(db, mint({ options: [
      opt({ inputs: [
        { ...IN.note, pattern: '[a-z ]+', default: 'hello', hint: 'Lowercase words' },
        { name: 'pick', label: 'Pick <one>', type: 'enum', required: false, maxlen: 3, choices: ['yes', 'no'] },
      ], plan: [LOG('[[input:note]]'), { fn: 'create_task', params: { title: 'T', assigned_to: 22, description: '[[input:pick]]' } }] }),
      { value: 'plain', label: 'Plain', plan: [LOG('static')] },
    ] }));
    const d = cta.publicDescriptor(await cta.getCtaById(db, m.id));
    expect(d.options).toEqual([
      { value: 'go', label: 'Go', inputs: [
        { name: 'note', label: 'Note', hint: 'Lowercase words', type: 'text', required: true, maxlen: 500, default: 'hello' },
        { name: 'pick', label: 'Pick <one>', type: 'enum', required: false, choices: ['yes', 'no'], maxlen: 3 },
      ] },
      { value: 'plain', label: 'Plain' },
    ]);
    expect(d.options[0].inputs[1]).not.toHaveProperty('hint');
    expect(JSON.stringify(d)).not.toMatch(/\[a-z|\[\[input|create_task|create_log/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Patterns on the linear-time engine (S1i review R1) — in FRESH processes
// ═════════════════════════════════════════════════════════════════════════════

describe('clicker patterns run in linear time — fresh child processes', () => {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const SVC = path.join(__dirname, '..', 'services', 'ctaService.js');
  const WORLD = path.join(__dirname, 'helpers', 'ctaWorld.js');

  /** Run `body` in a new node process (no --enable-experimental-regexp-engine on its command line). */
  function child(body, { preload = null, timeout = 30000 } = {}) {
    const args = [];
    if (preload) args.push('-r', preload);
    args.push('-e', `(async () => { ${body} })().catch((e) => { console.log(JSON.stringify({ crash: e.message })); })`);
    let out;
    try {
      out = execFileSync(process.execPath, args, { env: process.env, timeout, encoding: 'utf8' });
    } catch (e) {
      // A plain Error: execFileSync's own error is circular, which crashes
      // jest's --json reporter instead of reporting a failed test.
      throw new Error(`child process failed${e.signal ? ` (${e.signal} — killed after ${timeout} ms: the match did not finish)` : ''}: ${String(e.message).split('\n')[0]}`);
    }
    const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return JSON.parse(line);
  }

  // Every pattern here passed (or slipped) the S1i backtracking lint or is a
  // classic catastrophe: (a?a?)+b took 35 s on 22 characters on the old path.
  // Under the backtracking engine this test cannot finish — the child's
  // timeout is the failure.
  const CATASTROPHIC = [
    ['(a?a?)+b', 'a'], ['(a|a)+b', 'a'], ['(\\w|\\d)+x', 'a'], ['(.|\\s)*x', 'a'],
    ['[^](a+)+b', 'za'], ['(a+)+b', 'a'], ['.*.*.*.*x', 'a'], ['(\\d+\\s?)*x', '1'],
  ];

  test('ctaService turns the engine on at load, and every catastrophic pattern rejects a 1000-char value in ms', () => {
    const r = child(`
      const cta = require(${JSON.stringify(SVC)});
      const out = { available: cta.linearRegexAvailable(), runs: [] };
      for (const [pattern, ch] of ${JSON.stringify(CATASTROPHIC)}) {
        const decl = { name: 'v', label: 'V', type: 'text', required: true, maxlen: 1000, pattern };
        const t0 = process.hrtime.bigint();
        const res = cta.validateInputValue(decl, ch.repeat(999 / ch.length | 0).slice(0, 999) + '!');
        out.runs.push({ pattern, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: res.error || null });
      }
      console.log(JSON.stringify(out));
    `);
    expect(r.available).toBe(true);
    for (const run of r.runs) {
      expect({ pattern: run.pattern, error: run.error }).toEqual({ pattern: run.pattern, error: 'This is not in the expected format.' });
      expect({ pattern: run.pattern, fast: run.ms < 200 }).toEqual({ pattern: run.pattern, fast: true });
    }
  }, 40000);

  test('FAIL-CLOSED: without the engine, mint refuses patterns and a pattern-bearing input refuses at click — never backtracks', () => {
    // Stub the runtime flag switch so this child has NO linear engine.
    const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cta-nolinear-')), 'nolinear.js');
    fs.writeFileSync(preload, "require('v8').setFlagsFromString = () => {};\n");
    const r = child(`
      const cta = require(${JSON.stringify(SVC)});
      const { makeCtaWorld } = require(${JSON.stringify(WORLD)});
      const decl = { name: 'v', label: 'V', type: 'text', required: true, maxlen: 1000, pattern: '(a?a?)+b' };
      const out = {
        available: cta.linearRegexAvailable(),
        withPattern: cta.validateInputValue(decl, 'a'.repeat(999) + '!'),
        withoutPattern: cta.validateInputValue({ ...decl, pattern: undefined }, 'hello'),
      };
      try {
        await cta.mintCta(makeCtaWorld(), { name: 'n', prompt: 'p', minted_by: 6, protection: 'none', options: [{
          value: 'go', label: 'Go', inputs: [{ name: 'v', label: 'V', type: 'text', required: true, maxlen: 50, pattern: '[a-z]+' }],
          plan: [{ fn: 'create_log', params: { type: 'note', message: '[[input:v]]' } }] }] });
        out.mint = 'minted';
      } catch (e) { out.mint = e.message; }
      console.log(JSON.stringify(out));
    `, { preload, timeout: 20000 });
    expect(r.available).toBe(false);
    expect(r.withPattern).toEqual({ error: "This field can't be checked right now — please try again later." });
    expect(r.withoutPattern).toEqual({ value: 'hello' });
    expect(r.mint).toMatch(/patterns are unavailable on this server/);
  }, 30000);
});
