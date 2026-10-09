// tests/mailboxGmailParity.console.test.js
//
/**
 * The G4 / W4 text-parity gate script — ref/MAILBOX_GMAIL_PARITY.console.js —
 * run as shipped (the file is evaluated verbatim) against a scripted apiSend.
 * REAL: services/mailbox/mailboxIngestService.emitText (what emit-preview
 * returns) and emailIngestRuleService._runTransform (what test-transform
 * runs). Scripted: the two SU-console SELECTs and the rules list. Fixtures
 * are SYNTHETIC NEF-shaped messages; the GAS text of each emulates a Gmail
 * getPlainBody() rendering seen on live NEFs (ref/MAILBOX_GMAIL_PARITY.md §0).
 * Run: npx jest tests/mailboxGmailParity.console.test.js
 *
 * Mutation-checked (break the script, watch the named test fail):
 *   - deco() a no-op                            → "gmail-render: literal &nbsp / ------ lines …"
 *   - gas-tail-cut without the whole-text check  → "tail-cut needs a whole-text field"
 *   - CSS_ONLY matches anything                  → "css-leak needs a CSS-only remainder"
 *   - third (Gmail-undone) run removed           → "court NEFs with Gmail's renderings only: REVIEW …"
 *   - unwrap() a no-op                           → "court NEFs with Gmail's renderings only: REVIEW …"
 *   - unwrap() joins every line break            → "a short-line break is not a wrap: rejoining it is not allowed …"
 *   - court flag never set                       → "a court VALUE difference is STOP"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const svc = require('../services/mailbox/mailboxIngestService');
const ruleSvc = require('../services/emailIngestRuleService');

const SRC = fs.readFileSync(path.join(__dirname, '../ref/MAILBOX_GMAIL_PARITY.console.js'), 'utf8');

// ── the classifier, extracted verbatim from the script ──
const canonSrc = SRC.slice(SRC.indexOf('  const canon = '), SRC.indexOf('  // A JSON string literal'));
const clsSrc = SRC.slice(SRC.indexOf('  // ── classes'), SRC.indexOf('  // ── end classes ──'));
const { classify, REVIEW_PASS, unwrap } = new Function(`${canonSrc}${clsSrc}\nreturn { classify, REVIEW_PASS, unwrap };`)();

// ── fixtures ──
const ECF = 'https://ecf.test.uscourts.gov';
const NEF_HTML = [
  '<p><strong>Case Name:</strong> Jane Q. Example</p>',
  `<p><strong>Case Number:</strong> <A HREF=${ECF}/cgi-bin/DktRpt.pl?1>26-12345-abc</A></p>`,
  `<p><strong>Document Number:</strong> <a href='${ECF}/doc1/1?a=1&b=2'>30</a></p>`,
  '<p><strong>Docket Text:</strong><br>Certificate of Service Filed by Creditor Michigan Example Housing Authority. (Doe, Jo)</p>',
].join('\r\n');
// Gmail: *bold* labels, `label \n<url>` (wrapped before the long URL), and a
// hard wrap inside the filer: the 65-column line + "Authority." passes 75.
const NEF_GAS = [
  '*Case Name:* Jane Q. Example ', '',
  '*Case Number:* 26-12345-abc ', `<${ECF}/cgi-bin/DktRpt.pl?1> `, '',
  '*Document Number:* 30 ', `<${ECF}/doc1/1?a=1&b=2> `, '',
  '*Docket Text:* ',
  'Certificate of Service Filed by Creditor Michigan Example Housing ',
  'Authority. (Doe, Jo) ', '',
].join('\n');

const RULES = [
  { id: 8, transform_mode: 'mapper', transform_config: [
    { to: 'filer', from: 'text', transforms: ['regex:Filed by[^A-Za-z]+([A-Za-z. ]+[A-Za-z])', 'trim'] }] },
  { id: 12, transform_mode: 'passthrough', transform_config: null },
  { id: 15, transform_mode: 'code', transform_config: { code: "return { message: String(input.text || '').slice(0, 50000) };" } },
  { id: 16, transform_mode: 'code', transform_config: { code: [
    "const t = String(input.text || '').replace(/\\s+/g, ' ');",
    'const m = t.match(/Document Number:\\s*(\\d+)/i);',
    "return { summary: m ? 'Doc #' + m[1] : '(none)' };"].join('\n') } },
];

let nextMid = 100;
function message({ html, gasText, from = 'mieb_ecfadmin@test.uscourts.gov', rules = [8, 12, 15, 16], truncateAt = null }) {
  const mid = nextMid++;
  const env = { kind: 'email', source: 'gmail-firm', from: { email: from, name: '' }, to: [{ email: 'stuart@4lsg.com', name: '' }],
    subject: `subject ${mid}`, text: gasText, html, headers: { message_id: `hex${mid}` } };
  const gasRaw = truncateAt == null ? env : { _truncated: true, _original_size: 20000, preview: JSON.stringify(env).slice(0, truncateAt) };
  return {
    html,
    row: { mid, subject: env.subject, el_id: mid + 1000, from_email: from, to_email: 'stuart@4lsg.com', el_subject: env.subject,
      meta: { matched_rules: rules }, gas_raw: gasRaw },
  };
}

function makeApi(msgs, calls) {
  return async (url, method, body) => {
    calls.push(url);
    if (url === '/admin/db/query') {
      if (/FROM mail_messages m/.test(body.query)) return { rows: msgs.map(m => m.row) };
      if (/FROM mailboxes/.test(body.query)) return { rows: [{ id: 2 }] };
      throw new Error(`unscripted query ${body.query.slice(0, 60)}`);
    }
    if (url === '/api/email-ingest/rules' && method === 'GET') return { status: 'success', rules: RULES };
    const pm = /^\/api\/mailboxes\/2\/messages\/(\d+)\/emit-preview$/.exec(url);
    if (pm) {
      const m = msgs.find(x => x.row.mid === Number(pm[1]));
      return { status: 'success', preview: { text: svc.emitText(null, m.html).text, html: m.html } };
    }
    if (url === '/api/email-ingest/rules/test-transform' && method === 'POST') {
      const tr = ruleSvc._runTransform({ id: 'test-transform', transform_mode: body.transform_mode, transform_config: body.transform_config }, body.input);
      return { success: true, source: 'inline', input: body.input, transform: tr.ok ? { ok: true, output: tr.output } : { ok: false, error: tr.error } };
    }
    throw new Error(`unscripted ${method} ${url}`);
  };
}

const quiet = { log: () => {}, table: () => {}, warn: () => {}, error: () => {} };
async function runGate(msgs, calls = []) {
  const run = new Function('apiSend', 'console',
    `return (async () => { const __r = await ${SRC.replace(/^await /m, '')}\n; return __r; })();`);
  return run(makeApi(msgs, calls), quiet);
}
const kinds = (res, pred) => res.diffs.filter(pred).map(d => d.kind);

beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('classify (the documented classes)', () => {
  test('same / format: whitespace, *bold* and _underline_ only', () => {
    expect(classify('a b', 'a b', '')).toBe('same');
    expect(classify('*Case Name:* Jane\nQ. Example', 'Case Name: Jane Q. Example', '')).toBe('format');
    expect(classify('<b>* Jane *</b>', '<b>Jane</b>', '')).toBe('format');
    expect(classify('_unavailable_ ____', 'unavailable', '')).toBe('format');
  });

  test('gmail-render: literal &nbsp / ------ lines / [image: alt] on the GAS side', () => {
    expect(classify('2 \n&nbsp &nbsp Claims Register', '2 Claims Register', '')).toBe('gmail-render');
    expect(classify('Docket Text:\n------------------------------\nOrder', 'Docket Text: Order', '')).toBe('gmail-render');
    expect(classify('[image: Court Banner]\nBe advised', 'Court Banner Be advised', '')).toBe('gmail-render');
  });

  test('classify never guesses a wrap: a field the worker extended is VALUE (the third run decides)', () => {
    const gasText = 'Certificate of Service Filed by Creditor Michigan Example Housing \nAuthority.';
    expect(classify('Creditor Michigan Example Housing', 'Creditor Michigan Example Housing Authority', gasText)).toBe('VALUE');
  });

  test('unwrap rejoins only breaks where the line + the next word pass 75 columns', () => {
    const line65 = 'Certificate of Service Filed by Creditor Michigan Example Housing';
    expect(unwrap(`${line65} \nAuthority. (Doe, Jo) \n`)).toBe(`${line65} Authority. (Doe, Jo) \n`);
    expect(unwrap('Filed by Creditor Michigan\nExample Housing Authority')).toBe('Filed by Creditor Michigan\nExample Housing Authority');
    expect(unwrap('*Case Number:* 26-12345-abc \n<https://ecf.test.uscourts.gov/cgi-bin/DktRpt.pl?1030531>'))
      .toBe('*Case Number:* 26-12345-abc <https://ecf.test.uscourts.gov/cgi-bin/DktRpt.pl?1030531>');
    expect(unwrap('a\n\nb')).toBe('a\n\nb');
  });

  test('gas-tail-cut: a whole-text field where GAS lost the tail', () => {
    const gasText = 'Amount Claimed: $9.99 \n';
    expect(classify(gasText, 'Amount Claimed: $9.99\nAmount Secured:\nThe following document(s)', gasText)).toBe('gas-tail-cut');
    expect(classify(`From: x\n\n${gasText}`, 'From: x\n\nAmount Claimed: $9.99 Amount Secured:', gasText)).toBe('gas-tail-cut');
  });

  test('tail-cut needs a whole-text field (a short field that grew is VALUE)', () => {
    expect(classify('Doc', 'Doc #30 extra', 'Some other text with Doc in it')).toBe('VALUE');
  });

  test('gmail-css-leak: GAS = the worker + CSS rule(s)', () => {
    const gasText = 'Be advised.\nThis message was sent by the Courts\nbody .abe-column-block {min-height: 5px;}\n';
    expect(classify(gasText, 'Be advised.\n\nThis message was sent by the Courts', gasText)).toBe('gmail-css-leak');
  });

  test('css-leak needs a CSS-only remainder', () => {
    const gasText = 'Be advised.\nPlus a real sentence the worker lost.\n';
    expect(classify(gasText, 'Be advised.', gasText)).toBe('VALUE');
  });

  test('the worker LOSING content, or a non-string difference, is VALUE', () => {
    expect(classify('Case Number: 26-12345-abc Document Number: 30', 'Case Number: 26-12345-abc', 'x')).toBe('VALUE');
    expect(classify({ a: 1 }, { a: 2 }, '')).toBe('VALUE');
    expect(classify(true, null, '')).toBe('VALUE');
    expect(REVIEW_PASS).not.toContain('VALUE');
  });
});

describe('the gate script, end to end', () => {
  test("court NEFs with Gmail's renderings only: REVIEW, each difference in its class", async () => {
    const a = message({ html: NEF_HTML, gasText: NEF_GAS });
    const b = message({ html: '<p><b>Claim Number:</b> 2 &nbsp &nbsp Claims Register</p>', gasText: '*Claim Number:* 2 \n&nbsp &nbsp Claims Register\n', rules: [12] });
    const c = message({ html: '<p>Amount Claimed: $9.99</p><p>The following document(s) are associated</p>', gasText: 'Amount Claimed: $9.99 \n', rules: [12, 15] });
    const d = message({ html: '<p>Be advised.</p><p>Sent by the Courts</p>', gasText: 'Be advised.\n\nSent by the Courts\n\nbody .abe-column-block {min-height: 5px;}\n', rules: [12] });
    const res = await runGate([a, b, c, d]);
    expect(res.verdict).toMatch(/^REVIEW — no court VALUE difference/);
    const of = (msg, rule, field) => kinds(res, x => x.mid === msg.row.mid && x.rule === rule && x.field === field);
    expect(of(a, 12, '(passthrough text)')).toEqual(['format']);
    expect(of(a, 15, 'message')).toEqual(['format']);
    expect(of(a, 8, 'filer')).toEqual(['gmail-input-artifact']); // the wrap cut "…Housing" off "Authority"
    expect(of(a, 16, 'summary')).toEqual(['gmail-input-artifact']); // "*Document Number:* 30" hid the number from the rule
    expect(of(b, 12, '(passthrough text)')).toEqual(['gmail-render']);
    expect(of(c, 12, '(passthrough text)')).toEqual(['gas-tail-cut']);
    expect(of(c, 15, 'message')).toEqual(['gas-tail-cut']);
    expect(of(d, 12, '(passthrough text)')).toEqual(['gmail-css-leak']);
    expect(res.diffs.every(x => REVIEW_PASS.includes(x.kind))).toBe(true);
  });

  test('a court VALUE difference is STOP — the markup-free re-run does not excuse it', async () => {
    const e = message({ html: NEF_HTML, gasText: NEF_GAS.replace('*Document Number:* 30', '*Document Number:* 31'), rules: [12, 16] });
    const res = await runGate([e]);
    expect(res.verdict).toMatch(/^STOP — 2 court-mail VALUE/);
    expect(kinds(res, x => x.rule === 16)).toEqual(['VALUE']);
    expect(kinds(res, x => x.rule === 12)).toEqual(['VALUE']);
    expect(res.diffs.find(x => x.rule === 16)).toMatchObject({ gas: expect.stringContaining('(none)'), worker: expect.stringContaining('Doc #30') });
  });

  test('a short-line break is not a wrap: rejoining it is not allowed, the cut capture is a court VALUE', async () => {
    // Gmail broke the filer after a 41-column line: a source line break, not
    // its 75-column wrap — the worker's longer capture is NOT excused.
    const h = message({
      html: '<p>Docket Text:<br>Certificate of Service Filed by Creditor Michigan Example Housing Authority.</p>',
      gasText: 'Docket Text: \nCertificate of Service Filed by Creditor \nMichigan Example Housing Authority. \n', rules: [8] });
    const res = await runGate([h]);
    expect(kinds(res, x => x.rule === 8)).toEqual(['VALUE']);
    expect(res.verdict).toMatch(/^STOP/);
  });

  test('a non-court VALUE difference is REVIEW, not STOP', async () => {
    const f = message({ html: '<p>Your invoice total is $10</p>', gasText: 'Your invoice total is $12\n', from: 'billing@vendor.example', rules: [12] });
    const res = await runGate([f]);
    expect(res.verdict).toMatch(/^REVIEW/);
    expect(res.counts).toEqual({ VALUE: 1 });
  });

  test('identical text → PASS; the markup-free re-run only runs on a VALUE', async () => {
    const g = message({ html: '<p>Case Number: 26-12345-abc</p>', gasText: 'Case Number: 26-12345-abc', rules: [12, 15, 16] });
    const calls = [];
    const res = await runGate([g], calls);
    expect(res.verdict).toBe('PASS');
    expect(calls.filter(u => u === '/api/email-ingest/rules/test-transform')).toHaveLength(4); // 15 + 16, GAS + worker
  });

  test('a truncated Apps Script raw_input: text read from the preview, or the row skipped when the cut fell inside it', async () => {
    const full = message({ html: NEF_HTML, gasText: NEF_GAS, rules: [12] });
    const readable = message({ html: NEF_HTML, gasText: NEF_GAS, rules: [12],
      truncateAt: JSON.stringify(full.row.gas_raw).indexOf('"html"') + 20 });
    const cut = message({ html: NEF_HTML, gasText: NEF_GAS, rules: [12],
      truncateAt: JSON.stringify(full.row.gas_raw).indexOf('"text"') + 30 });
    const res = await runGate([readable, cut]);
    expect(res.report.map(r => r.mid)).toEqual([readable.row.mid]);
    expect(res.report[0].text).toBe('format');
  });
});
