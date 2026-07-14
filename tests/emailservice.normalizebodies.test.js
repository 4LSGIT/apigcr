/**
 * Tests for services/emailService.js → normalizeBodies. MTH-2 Fix D.
 *
 * THE DEFECT
 *   lib/workflow_engine.resolvePlaceholders has a deliberate single-placeholder
 *   fast path: when a param is EXACTLY one `{{token}}` and the token resolves to
 *   a non-primitive, the object/array passes through UNSTRINGIFIED (an MMS
 *   attachment array must survive; String() would flatten it to
 *   "[object Object],[object Object]"). That engine behavior is correct and is
 *   NOT touched.
 *
 *   The fallout lands in emailService: a workflow piping a json-typed `query_ai`
 *   output var straight into send_email's `text` (wf29 "ai query test",
 *   2026-07-02: step 1 = query_ai with output_type:'json' → step 2 = send_email)
 *   hands normalizeBodies an OBJECT. textToHtml then calls `text.replace(...)`
 *   → "TypeError: text.replace is not a function", and the workflow step dies.
 *
 * THE FIX
 *   Coerce both args once, at the top of normalizeBodies — the single chokepoint
 *   both sendEmail and sendEmailDirect flow through (and therefore every one of
 *   the ~20 sendEmail call sites). Never throw: a delivered email containing
 *   stringified JSON beats a dead workflow step at a law firm.
 *
 * THE REGRESSION BAR
 *   String inputs must round-trip BYTE-IDENTICALLY through htmlToText/textToHtml.
 *   That is what the first describe block pins.
 *
 * Pure function — no db, no SMTP, no adapters touched.
 */
/*
npm install --save-dev jest

# credentialCrypto (pulled in via emailService → adapters/email/smtp) throws at
# require time without this env var. Any random key works — the tests never
# decrypt anything.
export CREDENTIALS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
npx jest local/tests/emailService.normalizeBodies.test.js

npm uninstall --save-dev jest
*/
const { normalizeBodies } = require('/services/emailService');


// ─────────────────────────────────────────────────────────────
// The PRE-MTH-2 implementation, copied verbatim from git. The coercion is only
// allowed to change behavior for NON-STRING inputs; for every string/empty
// combination the new function must be byte-identical to this one. Keeping the
// old code here (rather than a handful of hand-written expectations) makes the
// bar mechanical — if someone later "improves" htmlToText/textToHtml, this
// fails loudly instead of silently changing what clients receive.
// ─────────────────────────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function textToHtml(text) {
  return '<p>' +
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>') +
    '</p>';
}
function normalizeBodiesPreMTH2(text, html) {
  if (!text && !html) throw new Error('Email requires at least one of: text, html');
  return {
    text: text || htmlToText(html),
    html: html || textToHtml(text),
  };
}

const STRING_CORPUS = [
  'hello', '', 'line1\nline2', 'a\n\nb', 'a & b < c > d', '"quoted"',
  '<p>Hi</p><p>There</p>', '<div>a&nbsp;&amp;&nbsp;b<br>c<ul><li>x</li></ul></div>',
  'Case 25-12345 filed\n\nRegards,\nRena', '   padded   ', 'emoji ok',
  '<br><br><br>lots', 'trailing\n', null, undefined,
];

describe('DIFFERENTIAL regression bar — every string/empty pair matches the pre-fix code exactly', () => {
  test.each(
    STRING_CORPUS.flatMap(t => STRING_CORPUS.map(h => [JSON.stringify(t), JSON.stringify(h), t, h]))
  )('text=%s html=%s', (_lt, _lh, text, html) => {
    let oldOut, oldErr = null;
    let newOut, newErr = null;
    try { oldOut = normalizeBodiesPreMTH2(text, html); } catch (e) { oldErr = e.message; }
    try { newOut = normalizeBodies(text, html);        } catch (e) { newErr = e.message; }
    expect(newErr).toBe(oldErr);       // same throw / same non-throw
    expect(newOut).toEqual(oldOut);    // same bytes out
  });
});


describe('regression bar — string inputs are byte-identical to pre-MTH-2', () => {
  test('string / string passthrough: neither side is derived or rewritten', () => {
    const text = 'Hello\n\nWorld & <friends>';
    const html = '<p>Hello</p><p>World &amp; &lt;friends&gt;</p>';
    const out = normalizeBodies(text, html);
    expect(out.text).toBe(text);     // same value…
    expect(out.text).toBe(text);
    expect(out.html).toBe(html);
  });

  test('text only → html derived by textToHtml (exact legacy output)', () => {
    const out = normalizeBodies('line one\nline two\n\npara two', undefined);
    expect(out.text).toBe('line one\nline two\n\npara two');
    expect(out.html).toBe('<p>line one<br>line two</p><p>para two</p>');
  });

  test('text only → textToHtml still escapes &, <, > in the legacy order', () => {
    const out = normalizeBodies('a & b < c > d', null);
    expect(out.html).toBe('<p>a &amp; b &lt; c &gt; d</p>');
  });

  test('html only → text derived by htmlToText (exact legacy output)', () => {
    const out = normalizeBodies('', '<p>Hello</p><p>World</p>');
    expect(out.html).toBe('<p>Hello</p><p>World</p>');
    expect(out.text).toBe('Hello\n\nWorld');
  });

  test('html only → htmlToText still unescapes entities and strips tags', () => {
    // NB "cx", not "c\nx": htmlToText newlines on the CLOSING </li> only, so the
    // <li> open tag is simply stripped and 'c' butts up against 'x'. Slightly
    // janky, entirely pre-existing, and pinned here precisely so the coercion
    // can't be blamed for it later.
    const out = normalizeBodies(undefined, '<div>a&nbsp;&amp;&nbsp;b<br>c<ul><li>x</li></ul></div>');
    expect(out.text).toBe('a & b\ncx');
  });

  test('both empty still throws the same message', () => {
    expect(() => normalizeBodies('', '')).toThrow('Email requires at least one of: text, html');
    expect(() => normalizeBodies(null, undefined)).toThrow('Email requires at least one of: text, html');
    expect(() => normalizeBodies()).toThrow('Email requires at least one of: text, html');
  });

  test('idempotent — re-normalizing already-normalized bodies is a no-op', () => {
    // sendEmail normalizes, then forwards to sendEmailDirect which normalizes
    // again. That second pass must not mutate anything.
    const once  = normalizeBodies('hi there', undefined);
    const twice = normalizeBodies(once.text, once.html);
    expect(twice).toEqual(once);
  });
});


describe('the wf29 defect — object bodies no longer throw', () => {
  const AI_OUTPUT = { number: 43, text: 'forty three', random_thought: 'pizza' };

  test('object text: pre-fix this threw "text.replace is not a function"', () => {
    expect(() => normalizeBodies(AI_OUTPUT, undefined)).not.toThrow();
  });

  test('object text → pretty JSON, and html is derived FROM that JSON', () => {
    const out = normalizeBodies(AI_OUTPUT, undefined);
    expect(out.text).toBe(JSON.stringify(AI_OUTPUT, null, 2));
    expect(JSON.parse(out.text)).toEqual(AI_OUTPUT);          // still machine-readable
    // textToHtml escapes & < > only — NOT double quotes — and turns \n into <br>.
    expect(out.html).toBe(
      '<p>{<br>  "number": 43,<br>  "text": "forty three",<br>  "random_thought": "pizza"<br>}</p>'
    );
  });

  test('array html → JSON string, and text derived from it', () => {
    const out = normalizeBodies(undefined, [{ a: 1 }, { b: 2 }]);
    expect(out.html).toBe(JSON.stringify([{ a: 1 }, { b: 2 }], null, 2));
    expect(typeof out.text).toBe('string');
    expect(out.text.length).toBeGreaterThan(0);
  });

  test('object on BOTH sides — neither is derived from the other', () => {
    const out = normalizeBodies({ t: 1 }, { h: 2 });
    expect(out.text).toBe(JSON.stringify({ t: 1 }, null, 2));
    expect(out.html).toBe(JSON.stringify({ h: 2 }, null, 2));
  });

  test('empty object / empty array coerce to "{}" / "[]" rather than throwing', () => {
    // Pre-fix BOTH of these were truthy → straight into .replace() → TypeError.
    expect(normalizeBodies({}, undefined).text).toBe('{}');
    expect(normalizeBodies([], undefined).text).toBe('[]');
  });

  test('circular object does not throw (JSON.stringify failure is swallowed)', () => {
    const circular = { a: 1 };
    circular.self = circular;
    const out = normalizeBodies(circular, undefined);
    expect(out.text).toBe('[object Object]');
    expect(typeof out.html).toBe('string');
  });
});


describe('other primitives', () => {
  test('number text → String()', () => {
    const out = normalizeBodies(43, undefined);
    expect(out.text).toBe('43');
    expect(out.html).toBe('<p>43</p>');
  });

  test('boolean html → String()', () => {
    const out = normalizeBodies(undefined, true);
    expect(out.html).toBe('true');
    expect(out.text).toBe('true');
  });

  test('BEHAVIOR CHANGE, deliberate: 0 / false are now sent instead of throwing', () => {
    // Pre-fix: `!0 && !undefined` → true → threw "Email requires at least one of".
    // Post-fix: coerced to the string "0", which is truthy → the email is sent.
    // Consistent with the "deliver something rather than kill the workflow step"
    // rule, and unreachable from a workflow anyway (the engine string-coerces
    // primitives before they ever get here — only objects/arrays survive).
    expect(() => normalizeBodies(0, undefined)).not.toThrow();
    expect(normalizeBodies(0, undefined).text).toBe('0');
    expect(normalizeBodies(false, undefined).text).toBe('false');
  });
});