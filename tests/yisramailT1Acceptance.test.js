// tests/yisramailT1Acceptance.test.js
//
/**
 * YisraMail T1 — scripts/yisramailT1Acceptance.js: the --check parser on
 * fixture .eml text (both outcomes, folded headers, two signatures), and the
 * --send stage's refusals and message against a scripted db (nodemailer's
 * transport mocked — nothing leaves the machine).
 * Run: npx jest tests/yisramailT1Acceptance.test.js
 */

'use strict';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return { ...actual, createTransport: jest.fn(() => ({ sendMail: mockSendMail })) };
});

const acc = require('../scripts/yisramailT1Acceptance');
const { encrypt } = require('../lib/credentialCrypto');

/** A Gmail "Show original" shaped message: Gmail's own headers first, then the sender's, folded the way Gmail folds them. */
function eml({ ourH = 'from:reply-to:subject:message-id:to:mime-version:content-type:list-unsubscribe:list-unsubscribe-post:list-id:date:feedback-id',
  sesH = 'Subject:Message-ID:To:From:Date:List-Unsubscribe:List-Unsubscribe-Post:Feedback-ID', ourD = 'news.4lsg.com', extra = '', crlf = true,
  lu = true, replyTo = 'office@4lsg.com' } = {}) {
  const fold = (h) => h.replace(/(.{40,60}?:)/g, '$1\n\t');
  const lines = [
    'Delivered-To: it@4lsg.com',
    'Received: by 2002:a05:6214:1c8a:b0:6e8:f9a1:2b3c with SMTP id b10csp123456qvb;',
    '        Sun, 1 Nov 2026 12:00:00 -0800 (PST)',
    'ARC-Authentication-Results: i=1; mx.google.com;',
    `       dkim=pass header.i=@${ourD} header.s=abc123 header.b=XyZ;`,
    'Authentication-Results: mx.google.com;',
    `       dkim=pass header.i=@${ourD} header.s=abc123 header.b=XyZ;`,
    '       dkim=pass header.i=@amazonses.com header.s=224i4 header.b=AbC;',
    '       spf=pass (google.com: domain of bounce@bounce.news.4lsg.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@bounce.news.4lsg.com;',
    '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=news.4lsg.com',
    `DKIM-Signature: v=1; a=rsa-sha256; q=dns/txt; c=relaxed/simple;\n\ts=abc123; d=${ourD}; t=1761998400;\n\th=${fold(ourH)};\n\tbh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;\n\tb=Zm9vYmFy`,
    `DKIM-Signature: v=1; a=rsa-sha256; q=dns/txt; c=relaxed/simple;\n\ts=224i4yxa5dv7c2xz3womw6peuasteono; d=amazonses.com; t=1761998400;\n\th=${fold(sesH)};\n\tbh=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=;\n\tb=YmF6`,
    'From: Legal Solutions Group <news@news.4lsg.com>',
    'To: it@4lsg.com',
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    'Subject: YisraMail T1 acceptance 2026-11-01T20:00:00.000Z',
    ...(lu ? ['List-Unsubscribe: <https://app.4lsg.com/u/T1ACCEPTANCE000000000>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    'List-ID: <news.news.4lsg.com>',
    extra,
    'Message-ID: <0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000@email.amazonses.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'YisraMail T1 acceptance send.',
    'List-Unsubscribe: <https://in-the-body.example/not-a-header>',
  ].filter((l) => l !== '');
  // the body separator: re-insert the blank line before the body
  const i = lines.indexOf('YisraMail T1 acceptance send.');
  lines.splice(i, 0, '');
  return lines.join(crlf ? '\r\n' : '\n');
}

describe('--check: the .eml parser', () => {
  test('both one-click headers in the d=news.4lsg.com h= list → GO (CRLF and LF alike)', () => {
    for (const crlf of [true, false]) {
      const r = acc.checkEml(eml({ crlf }));
      expect(r.ok).toBe(true);
      expect(r.line).toMatch(/^GO — List-Unsubscribe and List-Unsubscribe-Post are DKIM-signed by d=news\.4lsg\.com\. Next:/);
      expect(r.signatures.map((s) => s.d)).toEqual(['news.4lsg.com', 'amazonses.com']);
      expect(r.signatures[0].h).toEqual(['from', 'reply-to', 'subject', 'message-id', 'to', 'mime-version', 'content-type',
        'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'date', 'feedback-id']);
      expect(r.lines).toContain('x-ses-configuration-set: absent at the recipient (expected — SES strips the headers it acts on)');
      expect(r.lines).toContain('Reply-To: office@4lsg.com (✓ office@4lsg.com)');
      expect(r.lines).toContain("receiver's dkim verdict for news.4lsg.com: pass");
    }
  });

  test('list-unsubscribe-post missing from h= → NO-GO', () => {
    const r = acc.checkEml(eml({ ourH: 'from:subject:to:list-unsubscribe:date' }));
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — the one-click headers are not signed by d=news\.4lsg\.com\. A finding/);
  });

  test('two signatures where only d=amazonses.com signs them → NO-GO', () => {
    const r = acc.checkEml(eml({ ourH: 'from:subject:to:date', sesH: 'from:subject:list-unsubscribe:list-unsubscribe-post' }));
    expect(r.ok).toBe(false);
    expect(r.lines).toContain('✗ the d=news.4lsg.com signature does not list both list-unsubscribe and list-unsubscribe-post in h=');
  });

  test('no d=news.4lsg.com signature at all → NO-GO; a sub-domain look-alike does not count', () => {
    expect(acc.checkEml(eml({ ourD: 'other.example' })).ok).toBe(false);
    expect(acc.checkEml(eml({ ourD: 'evil-news.4lsg.com.example' })).ok).toBe(false);
  });

  test('signed in h= but the headers never arrived → NO-GO (oversigning is not presence)', () => {
    const r = acc.checkEml(eml({ lu: false }));
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/lacks the List-Unsubscribe headers/);
  });

  test('X-SES headers that survived, and a wrong Reply-To, are warnings on a GO', () => {
    const r = acc.checkEml(eml({ extra: 'X-SES-MESSAGE-TAGS: campaign_id=t1, result_id=t1', replyTo: 'someone@else.test' }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(2);
    expect(r.line).toMatch(/with 2 warning\(s\) above/);
  });

  test('parseHeaders unfolds continuation lines and stops at the body', () => {
    const h = acc.parseHeaders('A: one\r\n two\r\nB: x\r\n\r\nC: body');
    expect(h).toEqual([{ name: 'A', value: 'one two' }, { name: 'B', value: 'x' }]);
    expect(acc.parseDkim(' v=1; d = News.4LSG.com ;h=From : List-Unsubscribe\n\t:List-Unsubscribe-Post; b=x')).toMatchObject({ d: 'news.4lsg.com', h: ['from', 'list-unsubscribe', 'list-unsubscribe-post'] });
  });
});

describe('--send', () => {
  const ROW = { id: 17, email: 'news@news.4lsg.com', from_name: 'Legal Solutions Group', provider: 'smtp', credential_id: null,
    smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_port: 587, smtp_secure: 0, smtp_user: 'AKIAEXAMPLE', smtp_pass: encrypt('pw'),
    bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } };
  const dbWith = (row) => ({ query: jest.fn(async (sql) => {
    if (/FROM email_credentials/.test(sql)) return [row ? [row] : []];
    if (/FROM email_log/.test(sql)) return [[{ id: 4242 }]];
    return [{}];
  }) });
  const quiet = () => {};
  beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockImplementation(async () => ({ messageId: '<x@news.4lsg.com>', response: '250 Ok 0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000', accepted: ['it@4lsg.com'], rejected: [] }));
  });

  test('refuses a row that is not bulk_ok, and a missing row — nothing sent', async () => {
    expect((await acc.send(dbWith({ ...ROW, bulk_ok: 0 }), { rowId: 17, to: 'it@4lsg.com', say: quiet })).line).toMatch(/^NO-GO — row 17 \(news@news\.4lsg\.com\) is not bulk_ok/);
    expect((await acc.send(dbWith(null), { rowId: 17, to: 'it@4lsg.com', say: quiet })).line).toMatch(/^NO-GO — no email_credentials row 17/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends the acceptance message through the marketing path and reports the id, the line and the email_log row', async () => {
    const out = [];
    const r = await acc.send(dbWith(ROW), { rowId: 17, to: 'it@4lsg.com', say: (l) => out.push(l) });
    expect(r.ok).toBe(true);
    expect(r.line).toMatch(/^GO — sent through SES; message id parsed\. Next: .*--check/);
    const o = mockSendMail.mock.calls[0][0];
    expect(o.headers).toEqual({
      'List-Unsubscribe': '<https://app.4lsg.com/u/T1ACCEPTANCE000000000>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': '<news.news.4lsg.com>',
      'X-SES-CONFIGURATION-SET': 'yisramail-marketing',
      'X-SES-MESSAGE-TAGS': 'campaign_id=t1, result_id=t1',
    });
    expect(o.replyTo).toBe('office@4lsg.com');
    expect(o.subject).toMatch(/^YisraMail T1 acceptance \d{4}-\d\d-\d\dT/);
    expect(out).toContain('providerMessageId: 0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000');
    expect(out).toContain('email_log id:      4242');
  });

  test('a reply that does not parse to an SES id is a NO-GO (the format guess was wrong)', async () => {
    mockSendMail.mockImplementation(async () => ({ messageId: '<x@y>', response: '250 2.0.0 OK something else', accepted: ['it@4lsg.com'], rejected: [] }));
    const r = await acc.send(dbWith(ROW), { rowId: 17, to: 'it@4lsg.com', say: quiet });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — sent, but the SES message id did not parse/);
  });
});

describe('--send to the SES mailbox simulator (T2 step 0)', () => {
  const ROW = { id: 17, email: 'news@news.4lsg.com', from_name: 'Legal Solutions Group', provider: 'smtp', credential_id: null,
    smtp_host: 'email-smtp.us-east-2.amazonaws.com', smtp_port: 587, smtp_secure: 0, smtp_user: 'AKIAEXAMPLE', smtp_pass: encrypt('pw'),
    bulk_ok: 1, events_driver: 'ses', driver_config: { configuration_set: 'yisramail-marketing' } };
  const db = { query: jest.fn(async (sql) => (/FROM email_credentials/.test(sql) ? [[ROW]] : (/FROM email_log/.test(sql) ? [[{ id: 1 }]] : [{}]))) };
  beforeEach(() => {
    mockSendMail.mockReset();
    mockSendMail.mockImplementation(async () => ({ messageId: '<x@news.4lsg.com>', response: '250 Ok 0100018b5f6a1b2c-1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890-000000', accepted: ['bounce@simulator.amazonses.com'], rejected: [] }));
  });

  test('carries the given campaign / result tags and points at the hook, not at --check', async () => {
    const r = await acc.send(db, { rowId: 17, to: 'bounce@simulator.amazonses.com', campaignId: 't2', resultId: 't2-2', say: () => {} });
    expect(r.ok).toBe(true);
    expect(mockSendMail.mock.calls[0][0].headers['X-SES-MESSAGE-TAGS']).toBe('campaign_id=t2, result_id=t2-2');
    expect(mockSendMail.mock.calls[0][0].to).toBe('bounce@simulator.amazonses.com');
    expect(r.line).toMatch(/hook ses-events \(runbook stage 7\)/);
    expect(r.line).not.toMatch(/--check/);
  });

  test('defaults stay t1 / t1; a tag outside the charset is refused by emailService (nothing sent)', async () => {
    expect(acc.acceptanceMessage(ROW, 'it@4lsg.com').tags).toEqual({ campaign_id: 't1', result_id: 't1' });
    const r = await acc.send(db, { rowId: 17, to: 'success@simulator.amazonses.com', campaignId: 't2', resultId: 'bad id', say: () => {} });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/marketing_tags_invalid/);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
