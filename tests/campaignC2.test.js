// tests/campaignC2.test.js
//
/**
 * YisraMail C2 — the marketing send path's pure pieces (services/campaignService.js) and its two
 * routes (routes/campaign.js). The engine-level path is tests/campaignC2.mysql.test.js (gated).
 *
 * WHAT IS LOCKED
 *   - footer placement: the ONE slot marker, else before the LAST </body>, else before </html>,
 *     else appended — NEVER after </html>
 *   - the text part keeps every link's URL visible and leaks no <head>/<style>/<script> text
 *   - List-Id = <topic.sender-domain>; a malformed topic or sender refuses
 *   - the post-render check names each hole
 *   - account-pause detection: SES's paused / suspended shapes, never an ordinary 554 or a 4xx
 *     throttle; our own log_body fence is a DEFINITE error
 *   - POST /api/campaigns/test-send hands the body to testSendMarketing with req.auth and answers
 *     its CampaignErrors as-is; POST /api/campaigns/transports/:id/release is superuser + step-up
 *     (staff 403, SU without elevation 401) and reaches releaseTransport with the audit context
 * Run: npx jest tests/campaignC2.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'campaign-c2-test-secret';

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
  const role = req.headers['x-test-role'] || 'staff';
  req.auth = { type: 'jwt', roles: [role], userId: role === 'staff' ? 9 : 6, username: role };
  next();
});

const express = require('express');
const campaignService = require('../services/campaignService');
const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');

const { injectFooter, textPartFor, listIdFor, marketingHeaders, footerHoles, isAccountPausedError, isAmbiguousSendError, FOOTER_SLOT } = campaignService;
const F = '<div data-yc-compliance-footer="1">FOOTER</div>';

describe('injectFooter — placement', () => {
  test('before the LAST </body>, case-insensitive; never after </html>', () => {
    const out = injectFooter('<html><body><p>a</p><!-- </body> in a comment? no: --></BODY></html>', F);
    expect(out.indexOf(F)).toBeLessThan(out.indexOf('</BODY>'));
    expect(out.trim().endsWith('</html>')).toBe(true);
    const two = injectFooter('<body>x</body><body>y</body>', F);
    expect(two.indexOf(F)).toBeGreaterThan(two.indexOf('y'));
  });
  test('no </body>: before </html>; neither: appended', () => {
    const h = injectFooter('<html><p>a</p></html>', F);
    expect(h.indexOf(F)).toBeLessThan(h.indexOf('</html>'));
    expect(h.trim().endsWith('</html>')).toBe(true);
    expect(injectFooter('<p>plain</p>', F)).toBe(`<p>plain</p>\n${F}`);
    expect(injectFooter(null, F)).toBe(`\n${F}`);
  });
  test('the slot marker wins over </body> — the first one, replaced', () => {
    const out = injectFooter(`<html><body><table><tr><td>card${FOOTER_SLOT}</td></tr></table>${FOOTER_SLOT}</body></html>`, F);
    expect(out).toBe(`<html><body><table><tr><td>card${F}</td></tr></table>${FOOTER_SLOT}</body></html>`);
    expect(FOOTER_SLOT).toBe('<!-- yc:footer-slot -->');
  });
});

describe('injectFooter — round 2 (the slot only inside <body>; never after </html>)', () => {
  test('a slot marker in <head> / <title> is ignored — the footer goes before </body>', () => {
    const out = injectFooter(`<html><head><title>${FOOTER_SLOT}</title><!-- ${FOOTER_SLOT} --></head><body><p>a</p></body></html>`, F);
    expect(out.indexOf(F)).toBeGreaterThan(out.indexOf('<p>a</p>'));
    expect(out.indexOf(F)).toBeLessThan(out.indexOf('</body>'));
    expect(out.indexOf(FOOTER_SLOT)).toBeLessThan(out.indexOf('</head>'));          // the head copy is left alone
  });
  test('a slot after </body> is ignored; a body slot after a head slot wins', () => {
    const late = injectFooter(`<html><body><p>a</p></body>${FOOTER_SLOT}</html>`, F);
    expect(late.indexOf(F)).toBeLessThan(late.indexOf('</body>'));
    const both = injectFooter(`<html><head>${FOOTER_SLOT}</head><body><div>${FOOTER_SLOT}</div></body></html>`, F);
    expect(both).toBe(`<html><head>${FOOTER_SLOT}</head><body><div>${F}</div></body></html>`);
  });
  test('"</html></body>" ordering: the footer goes before </html>, never after it', () => {
    const out = injectFooter('<html><body><p>a</p></html></body>', F);
    expect(out.indexOf(F)).toBeLessThan(out.indexOf('</html>'));
  });
  test('no <body> tag: a slot after </head> is honoured; one inside <head> is not', () => {
    expect(injectFooter(`<head><title>t</title></head><p>${FOOTER_SLOT}</p>`, F)).toBe(`<head><title>t</title></head><p>${F}</p>`);
    const h = injectFooter(`<head>${FOOTER_SLOT}</head><p>x</p>`, F);
    expect(h).toBe(`<head>${FOOTER_SLOT}</head><p>x</p>\n${F}`);
  });
  test('a character that lengthens under toLowerCase (İ) before </body> does not shift the insertion point', () => {
    const out = injectFooter('<body>İİİİ<p>a</p></body>', F);
    expect(out).toBe(`<body>İİİİ<p>a</p>${F}\n</body>`);
  });
});

describe('footerHoles — round 2', () => {
  const url = 'https://x.test/u/AbC';
  const footer = { html: `<div data-yc-compliance-footer="1"><a href="${url}">${url}</a></div>`, text: `--\nUnsubscribe: ${url}` };
  test('the builder\'s marker must be present — a footer object without it is a hole', () => {
    const gutted = { html: `<div><a href="${url}">${url}</a></div>`, text: footer.text };
    expect(footerHoles({ html: `<p>a</p>${gutted.html}`, text: `a\n${gutted.text}`, footer: gutted, unsubscribeUrl: url })).toEqual(['html: footer marker']);
  });
  test('a footer after </html> is a hole', () => {
    expect(footerHoles({ html: `<html><body>a</body></html>${footer.html}`, text: footer.text, footer, unsubscribeUrl: url })).toEqual(['html: footer after </html>']);
  });
});

describe('assertHttpsAttachment — email attachments are https:// only (security)', () => {
  test('refuses a local path, file:, http:, data:, javascript: and junk; accepts https', () => {
    for (const u of ['/proc/self/environ', '../../etc/passwd', 'file:///etc/passwd', 'http://x.test/a.pdf', 'data:text/plain,hi', 'javascript:alert(1)', 'https://', 'https:// x', '', null, 42, `https://x.test/${'a'.repeat(2100)}`]) {
      expect(() => campaignService.assertHttpsAttachment(u)).toThrow(expect.objectContaining({ status: 400, code: 'bad_attachment_url' }));
    }
    expect(() => campaignService.assertHttpsAttachment('https://storage.googleapis.com/uploads.4lsg.com/a b.pdf')).toThrow();
    campaignService.assertHttpsAttachment('https://storage.googleapis.com/uploads.4lsg.com/flyer.pdf?x=1');
    campaignService.assertHttpsAttachment('HTTPS://storage.googleapis.com/a.pdf');
  });
});

describe('textPartFor — linear on hostile input (CLAUDE.md: linear regexes)', () => {
  // Each 256 KB. The round-1 regexes were quadratic (445 ms at 48 KB of '<a ') and CUBIC on
  // unclosed '<a href="' (~113 s at 32 KB) — a run that never ends cannot fail a test, so each
  // case runs in a CHILD process with a hard time limit: a hang is killed and fails by status.
  // Linear code does each in a few ms; the bound leaves room for a loaded machine.
  const { spawnSync } = require('child_process');
  const path = require('path');
  const SVC = path.join(__dirname, '..', 'services', 'campaignService');
  const N = 256 * 1024;
  function runInChild(fn, inputExpr) {
    const code = `const cs = require(${JSON.stringify(SVC)}); const s = ${inputExpr};`
      + `const t = process.hrtime.bigint(); ${fn}; process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));`;
    return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 6000, env: process.env });
  }
  const cases = {
    'unclosed <a': `'<a '.repeat(${N / 3})`,
    'unclosed <a href="': `'<a href="'.repeat(${Math.floor(N / 9)})`,
    'unclosed anchors with href': `'<a href="https://x.test/">'.repeat(${Math.floor(N / 25)})`,
    'many href= in one tag': `'<a ' + ' href="'.repeat(${Math.floor(N / 7)}) + '>x</a>'`,
    'unclosed <style': `'<style '.repeat(${Math.floor(N / 7)})`,
    'unclosed <!--': `'<!--'.repeat(${N / 4})`,
    'a long run of spaces': `' '.repeat(${N}) + 'x'`,
    'a long run of tabs before a newline': `'\\t'.repeat(${N}) + 'x\\n'`,
    'unclosed <': `'<'.repeat(${N})`,
    '<br followed by spaces': `'<br '.repeat(${N / 4})`,
  };
  for (const [name, expr] of Object.entries(cases)) {
    test(`${name}: under 400 ms`, () => {
      const r = runInChild('cs.textPartFor(s)', expr);
      expect(r.error ? r.error.code : null).toBeNull();          // ETIMEDOUT = the child was killed
      expect(r.status).toBe(0);
      expect(Number(r.stdout)).toBeLessThan(400);
    }, 15000);
  }
  test('injectFooter + footerHoles on 256 KB of noise: under 400 ms', () => {
    const r = runInChild("cs.footerHoles({ html: cs.injectFooter(s, '<div data-yc-compliance-footer=\"1\">F</div>'), text: 'x', footer: { html: 'F', text: 'y' }, unsubscribeUrl: 'https://x.test/u/a' })",
      `'<body '.repeat(${Math.floor(N / 6)})`);
    expect(r.error ? r.error.code : null).toBeNull();
    expect(r.status).toBe(0);
    expect(Number(r.stdout)).toBeLessThan(400);
  }, 15000);
});

describe('textPartFor — the explicit text part', () => {
  test('a link keeps its URL visible; a bare-URL link shows it once; non-http hrefs keep only the label', () => {
    const t = textPartFor('<p>Read <a href="https://firm.test/post?a=1&amp;b=2">our post</a>.</p><p><a href="https://firm.test/x">https://firm.test/x</a></p><p><a href="javascript:alert(1)">bad</a> <a href="mailto:office@firm.test">mail us</a></p>');
    expect(t).toContain('our post (https://firm.test/post?a=1&b=2)');
    expect(t).toContain('https://firm.test/x');
    expect(t).not.toContain('https://firm.test/x (https://firm.test/x)');
    expect(t).toContain('bad');
    expect(t).not.toContain('javascript:');
    expect(t).toContain('mail us (mailto:office@firm.test)');
  });
  test('<head>, <style>, <script>, comments never leak as text; numeric entities decode', () => {
    const t = textPartFor('<html><head><title>T</title><style>p{color:red}</style></head><body><script>var x=1</script><!-- hidden --><p>Caf&#233; &#x2014; ok&nbsp;now</p></body></html>');
    expect(t).toBe('Café — ok now');
  });
});

describe('List-Id and the headers', () => {
  test('<topic.sender-domain>, "_" → "-"', () => {
    expect(listIdFor('newsletter', 'news@news.4lsg.com')).toBe('<newsletter.news.4lsg.com>');
    expect(listIdFor('client_updates', 'News@News.Test')).toBe('<client-updates.news.test>');
  });
  test('a malformed topic or sender refuses', () => {
    for (const [t, s] of [['News Letter', 'a@b.test'], ['newsletter', 'nodomain'], ['newsletter', 'a@b'], ['newsletter', 'a@b..test'], ['', 'a@b.test']]) {
      expect(() => listIdFor(t, s)).toThrow(/listIdFor/);
    }
  });
  test('the three marketing headers, exactly', () => {
    expect(marketingHeaders('https://x.test/u/AbC', '<n.x.test>')).toEqual({
      'List-Unsubscribe': '<https://x.test/u/AbC>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': '<n.x.test>',
    });
  });
});

describe('footerHoles — the post-render check', () => {
  const url = 'https://x.test/u/AbC';
  const footer = { html: `<div data-yc-compliance-footer="1"><a href="${url}">${url}</a></div>`, text: `--\nUnsubscribe: ${url}` };
  test('holds when the html carries the block + href and the text the block + URL', () => {
    expect(footerHoles({ html: `<p>a</p>${footer.html}`, text: `a\n\n${footer.text}`, footer, unsubscribeUrl: url })).toBeNull();
  });
  test('names each hole', () => {
    expect(footerHoles({ html: '<p>a</p>', text: 'a', footer, unsubscribeUrl: url }))
      .toEqual(['html: footer marker', 'html: footer block', 'html: unsubscribe href', 'text: footer block', 'text: unsubscribe URL']);
    expect(footerHoles({ html: footer.html, text: footer.text, footer: null, unsubscribeUrl: url })).toEqual(['the footer block']);
  });
});

describe('isAccountPausedError — SES account-level refusals (VERIFY(live))', () => {
  const e = (responseCode, response, message = response) => Object.assign(new Error(message), { responseCode, response, code: 'EMESSAGE' });
  test('the paused / suspended family', () => {
    expect(isAccountPausedError(e(554, '554 Message rejected: Sending paused for this account. For more information, please check the AWS Support Center.'))).toBe(true);
    expect(isAccountPausedError(e(554, '554 Sending suspended for this account.'))).toBe(true);
    expect(isAccountPausedError(e(554, '554 Message rejected: Sending is paused for this configuration set.'))).toBe(true);
    expect(isAccountPausedError(Object.assign(new Error('Account is paused'), {}))).toBe(true);
    expect(isAccountPausedError(Object.assign(new Error('x'), { name: 'AccountSendingPausedException' }))).toBe(true);
  });
  test('NOT an ordinary refusal, a throttle, a success line or nothing', () => {
    expect(isAccountPausedError(e(554, '554 Message rejected: Email address is not verified.'))).toBe(false);
    expect(isAccountPausedError(e(454, '454 Throttling failure: Daily message quota exceeded'))).toBe(false);
    expect(isAccountPausedError(e(535, '535 Authentication Credentials Invalid'))).toBe(false);
    expect(isAccountPausedError(e(250, '250 Ok sending paused for this account'))).toBe(false);
    expect(isAccountPausedError(null)).toBe(false);
  });
  test('the log_body fence is a DEFINITE error (never "unknown")', () => {
    expect(isAmbiguousSendError(Object.assign(new Error('marketing_log_body_refused: log_body may only be false — timeout'), { code: 'marketing_log_body_refused' }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
describe('routes', () => {
  let server, base;
  const audits = [];
  const db = { query: jest.fn(async (sql, p) => { if (/admin_audit_log/.test(sql)) audits.push(p); return [{}]; }) };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(require('../routes/campaign'));

  beforeAll(async () => {
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  beforeEach(() => {
    _resetRateLimits();
    audits.length = 0;
    delete process.env.SU_STEPUP;
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  async function call(method, url, body, { role = 'staff', elev = null } = {}) {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-test-role': role, ...(elev ? { 'x-su-elevation': elev } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  }

  test('test-send: the body + req.auth reach testSendMarketing; its CampaignError answers as-is', async () => {
    const spy = jest.spyOn(campaignService, 'testSendMarketing').mockResolvedValueOnce({ sent: true, to: 'fred@firm.test', messageId: '<m>', providerMessageId: null });
    const r = await call('POST', '/api/campaigns/test-send', { sender: 'news@news.test', subject: 'S', body: '<p>b</p>', topic_key: 'newsletter', contactId: 2 }, { role: 'admin' });
    expect(r).toEqual({ status: 200, json: { sent: true, to: 'fred@firm.test', messageId: '<m>', providerMessageId: null } });
    expect(spy.mock.calls[0][1]).toEqual({ auth: { type: 'jwt', roles: ['admin'], userId: 6, username: 'admin' }, sender: 'news@news.test', subject: 'S', body: '<p>b</p>', topicKey: 'newsletter', contactId: 2, attachmentUrl: null });
    spy.mockRejectedValueOnce(new campaignService.CampaignError(422, 'transport_held', 'held: x', { held_reason: 'x' }));
    expect(await call('POST', '/api/campaigns/test-send', { sender: 'n' })).toEqual({ status: 422, json: { error: 'held: x', code: 'transport_held', held_reason: 'x' } });
  });

  test('release: staff 403 (audited rejected_not_su), SU without elevation 401, SU + elevation reaches releaseTransport with the audit context', async () => {
    const spy = jest.spyOn(campaignService, 'releaseTransport').mockResolvedValue({ released: true, credential_id: 17, held_at: null, held_reason: 'x' });
    expect((await call('POST', '/api/campaigns/transports/17/release', {}, { role: 'staff' })).status).toBe(403);
    expect(audits.some((p) => p[0] === 'mail_transport_release' && p.includes('rejected_not_su'))).toBe(true);
    expect((await call('POST', '/api/campaigns/transports/17/release', {}, { role: 'su' })).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    const r = await call('POST', '/api/campaigns/transports/17/release', {}, { role: 'su', elev: mintElevationToken(6) });
    expect(r).toEqual({ status: 200, json: { released: true, credential_id: 17, held_at: null, held_reason: 'x' } });
    expect(spy.mock.calls[0][1]).toBe('17');
    expect(spy.mock.calls[0][2]).toMatchObject({ auth: { roles: ['su'], userId: 6 }, request: { route: '/api/campaigns/transports/17/release', method: 'POST' } });
    expect(campaignService.RELEASE_TOOL).toBe('mail_transport_release');
    spy.mockRejectedValueOnce(new campaignService.CampaignError(409, 'not_held', 'not held'));
    expect(await call('POST', '/api/campaigns/transports/17/release', {}, { role: 'su', elev: mintElevationToken(6) })).toEqual({ status: 409, json: { error: 'not held', code: 'not_held' } });
  });
});
