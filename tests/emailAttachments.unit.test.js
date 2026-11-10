// tests/emailAttachments.unit.test.js
//
/**
 * Email attachments S1 (ref/EMAIL_ATTACHMENTS_DESIGN.md) — the PURE parts and
 * the byte fetch, no database:
 *   emailCaseMatchService   extractCaseIds / extractCaseNumbers / ownText (the grammar)
 *   mailAttachmentService   fileableParts (what gets filed), fetchPartBuffer
 *                           (the coded errors, the byte cap) over a stubbed
 *                           transport
 *   emailAttachmentFilingService  renderFolder (firm-local dates, segment
 *                           cleaning), safeFileName
 *   emailAttachmentNotice   escaping + the subject's outcome wording
 * The SQL (matching, the claim, filing, refile) runs on a real engine in
 * tests/emailAttachments.mysql.test.js.
 *
 *   npx jest tests/emailAttachments.unit.test.js
 */

'use strict';

const { Readable } = require('stream');

jest.mock('../services/mailbox/imapTransport', () => ({
  ...jest.requireActual('../services/mailbox/imapTransport'),
  fetchPart: jest.fn(),
}));

const transport = require('../services/mailbox/imapTransport');
const match = require('../services/emailCaseMatchService');
const att = require('../services/mailbox/mailAttachmentService');
const filing = require('../services/emailAttachmentFilingService');
const notice = require('../services/emailAttachmentNotice');

// ─────────────────────────────────────────────────────────────────────────────
describe('extractCaseIds — case ids of any vintage (Fred, 2026-11-08)', () => {
  test('a bare uppercase id in the subject', () => {
    expect(match.extractCaseIds({ subject: '- PVXC1RMM', text: '' })).toEqual({ subject: ['PVXC1RMM'], body: [] });
  });
  test('"case <id>" in any letter case, subject and body; bare tokens never count in the body', () => {
    const r = match.extractCaseIds({ subject: 'paystubs for case pvxc1rmm', text: 'Case: CF8ZT7VE\nalso 1T71WG3Z here' });
    expect(r).toEqual({ subject: ['PVXC1RMM'], body: ['CF8ZT7VE'] });
  });
  test('prefix variants: "case #", "case id", "case no.", "case-", nbsp', () => {
    for (const s of ['case #PVXC1RMM', 'case id PVXC1RMM', 'Case No. PVXC1RMM', 'CASE-PVXC1RMM', 'case PVXC1RMM']) {
      expect([s, match.extractCaseIds({ subject: s }).subject]).toEqual([s, ['PVXC1RMM']]);
    }
  });
  test('Fred\'s examples: a legacy id that happens to be all caps (I is not Crockford), bare or after "case"', () => {
    expect(match.extractCaseIds({ subject: 'docs for case MY0PZ04I' }).subject).toEqual(['MY0PZ04I']);
    expect(match.extractCaseIds({ subject: 'MY0PZ04I and other such gibberish' }).subject).toEqual(['MY0PZ04I']);
  });
  test('a mixed-case legacy id counts after "case" (any letter case, legacy - and _ too); bare, a mixed-case word never does', () => {
    expect(match.extractCaseIds({ subject: 'case tLfSP42H' }).subject).toEqual(['TLFSP42H']);
    expect(match.extractCaseIds({ subject: 're: case: a_b-Cd12' }).subject).toEqual(['A_B-CD12']);
    expect(match.extractCaseIds({ subject: 'tLfSP42H wgGoqqv0 pvxc1rmm Document' }).subject).toEqual([]);
  });
  test('ids hold a letter: a docket ("case 12-34567") or a digit run is never an id', () => {
    expect(match.extractCaseIds({ subject: 'case 12-34567 12345678 case 12345678' }).subject).toEqual([]);
  });
  test('"case" starts a word ("showcase" is no prefix); the gap may cross a line', () => {
    expect(match.extractCaseIds({ subject: 're: docs', text: 'showcase pvxc1rmm' }).body).toEqual([]);
    expect(match.extractCaseIds({ subject: 're: docs', text: 'Case ID:\n cf8zt7ve' }).body).toEqual(['CF8ZT7VE']);
  });
  test('word-bounded on letters and digits: a token inside a longer run is not an id', () => {
    expect(match.extractCaseIds({ subject: 'XPVXC1RMM PVXC1RMMX 9PVXC1RMM' }).subject).toEqual([]);
    // punctuation (incl. "_" from a pasted filename) is a boundary
    expect(match.extractCaseIds({ subject: 'PVXC1RMM_stubs.pdf' }).subject).toEqual(['PVXC1RMM']);
  });
  test('de-duplicated in order', () => {
    expect(match.extractCaseIds({ subject: 'case PVXC1RMM / PVXC1RMM / CF8ZT7VE' }).subject).toEqual(['PVXC1RMM', 'CF8ZT7VE']);
  });
  test('quoted history is not the sender\'s text — its ids are ignored', () => {
    const text = 'Here they are.\n\nOn Tue, Nov 3, 2026 at 9:00 AM Office <office@4lsg.com> wrote:\n> please send, case PVXC1RMM';
    expect(match.extractCaseIds({ subject: 're: docs', text }).body).toEqual([]);
    expect(match.ownText(text).trim()).toBe('Here they are.');
  });
  test('a forward with no note keeps its text (marker at offset 0 is not a cut)', () => {
    const text = '---------- Forwarded message ---------\nfrom the bank, case PVXC1RMM';
    expect(match.extractCaseIds({ subject: 'Fwd:', text }).body).toEqual(['PVXC1RMM']);
  });
});

describe('extractCaseNumbers — docket candidates, compared later by equality', () => {
  const subj = (s) => match.extractCaseNumbers({ subject: s }).subject;
  test('Fred\'s examples', () => {
    expect(subj('case 12-34567')).toEqual(['12-34567']);
    expect(subj('case number 12-34567-abc documents')).toEqual(['12-34567-abc']);
  });
  test('any subject token with 4+ digits, ends cleaned — no docket shape is assumed', () => {
    expect(subj('re: 26-52011-MAR, (1:26-cv-00546-JLR) #18-LV02229 354887.')).toEqual(['26-52011-MAR', '1:26-cv-00546-JLR', '18-LV02229', '354887']);
  });
  test('too short, too few digits, addresses and links are not candidates', () => {
    expect(subj('2026 a1b2c3 x@12345.com https://x.com/12345678 ' + '1'.repeat(41))).toEqual([]);
  });
  test('a form-style label: "Case number:" on one line, the number on the next; "casenumber" run together', () => {
    expect(match.extractCaseNumbers({ subject: '', text: 'Case number:\n26-52011\ncasenumber 26-52012, showcase 26-52013' }).body)
      .toEqual(['26-52011', '26-52012']);
  });
  test('the body counts only after "case" — and only the sender\'s own text', () => {
    const text = 'Hi, call 248-555-1234. This is for case number 26-52011.\nCase No. 26-52012-mar; case #26-52013, case: 26-52014, Case Num. 26-52015\n\n' +
      'On Mon, Nov 2, 2026 at 9:00 AM Office <office@4lsg.com> wrote:\n> case 26-99999';
    expect(match.extractCaseNumbers({ subject: '', text }).body).toEqual(['26-52011', '26-52012-mar', '26-52013', '26-52014', '26-52015']);
  });
  test('de-duplicated case-insensitively, capped at 10 per source', () => {
    expect(subj('26-52011-MAR 26-52011-mar')).toEqual(['26-52011-MAR']);
    expect(subj(Array.from({ length: 30 }, (_, i) => `26-${50000 + i}`).join(' '))).toHaveLength(10);
  });
});

describe('the prefix and quote patterns are linear (they read any email anyone sends)', () => {
  // The 2026-11-06 patterns were quadratic in a whitespace run: "case" +
  // 32,000 spaces took 1.9 s, 32,000 blank lines 0.9 s. 128,000 characters of
  // each worst case now run in a few ms; the bound leaves room for a slow CI.
  test.each([
    ['"case" + spaces', 'case' + ' '.repeat(128000) + '\n'],
    ['"case" + nbsp', 'case' + ' '.repeat(128000)],
    ['"case number" + spaces', 'case number' + ' '.repeat(128000)],
    ['"case:" + spaces', 'case:' + ' '.repeat(128000) + '!'],
    ['"case" + newlines', 'case' + '\n'.repeat(128000)],
    ['blank lines', '\n'.repeat(128000)],
    ['space lines', ' \n'.repeat(64000)],
    ['"--" lines', '--\n'.repeat(42000)],
    ['a 100,000-token subject', Array.from({ length: 100000 }, (_, i) => `ZZ${100000 + i}`).join(' ')],
  ])('%s', (_label, t) => {
    const t0 = Date.now();
    match.extractCaseIds({ subject: t, text: t });
    match.extractCaseNumbers({ subject: t, text: 'case ' + t });
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fileableParts', () => {
  const row = (attachments, body_html = '') => ({ id: 1, attachments, body_html });

  test('keeps documents; skips signature-size inline images, refused types, oversize', () => {
    const r = att.fileableParts(row([
      { part: '2', filename: 'stub.pdf', mime: 'application/pdf', size: 200000 },
      { part: '3', filename: 'logo.png', mime: 'image/png', size: 6000, cid: 'logo1' },
      { part: '4', filename: 'IMG_6004.jpeg', mime: 'image/jpeg', size: 6769272, cid: 'photo1' },
      { part: '5', filename: 'invoice.pdf.exe', mime: 'application/pdf', size: 1000 },
      { part: '6', filename: 'huge.pdf', mime: 'application/pdf', size: 80 * 1024 * 1024 },
      { part: '7', filename: 'Fwd.eml', mime: 'message/rfc822', size: 9000 },
    ], '<img src="cid:logo1"><img src="cid:photo1">'));
    expect(r.files.map(f => [f.part, f.filename, f.ext])).toEqual([
      ['2', 'stub.pdf', 'pdf'],
      ['4', 'IMG_6004.jpeg', 'jpeg'],   // an inline PHOTO of a document is filed
    ]);
    expect(r.skipped).toEqual([
      { part: '3', filename: 'logo.png', reason: 'inline_image' },
      { part: '5', filename: 'invoice.pdf.exe', reason: 'type_not_allowed', blocked: true },   // a program: never, by anyone
      { part: '6', filename: 'huge.pdf', reason: 'too_large' },
      // not on the client-upload list, but a PERSON may file it from Comms (S3)
      { part: '7', filename: 'Fwd.eml', reason: 'type_not_allowed', optional: true, ext: 'eml', est_bytes: 6660 },
    ]);
  });

  test('a small image that is NOT referenced inline is filed (a cid alone means nothing)', () => {
    const r = att.fileableParts(row([{ part: '2', filename: 'tiny.png', mime: 'image/png', size: 3000, cid: 'x' }], '<p>hi</p>'));
    expect(r.files.map(f => f.part)).toEqual(['2']);
  });

  test('no extension: the MIME type supplies one; unknown MIME is refused', () => {
    const r = att.fileableParts(row([
      { part: '2', filename: 'attachment', mime: 'application/pdf', size: 100 },
      { part: '3', filename: null, mime: 'image/jpeg', size: 100 },
      { part: '4', filename: 'blob', mime: 'application/octet-stream', size: 100 },
    ]));
    expect(r.files.map(f => f.filename)).toEqual(['attachment.pdf', 'attachment-3.jpg']);
    expect(r.skipped).toEqual([{ part: '4', filename: 'blob', reason: 'type_not_allowed' }]);
  });

  test('malformed part ids are ignored', () => {
    const r = att.fileableParts(row([{ part: '../2', filename: 'a.pdf', size: 1 }, { filename: 'b.pdf' }]));
    expect(r).toEqual({ files: [], skipped: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fetchPartBuffer', () => {
  const conn = { id: 2, ingest_state: JSON.stringify({ INBOX: { uidvalidity: 9 } }) };
  const db = { query: jest.fn(async () => [[conn]]) };
  const msg = { id: 5, mailbox_id: 2, folder: 'INBOX', uid: 40, message_id: 'm@x', attachments: [{ part: '2' }] };
  const got = (buf) => ({ stream: Readable.from([buf.subarray(0, 3), buf.subarray(3)]), mime: 'application/pdf', close: jest.fn() });
  beforeEach(() => { transport.fetchPart.mockReset(); });

  test('bytes, through fetchPart with the cursor\'s UIDVALIDITY and the stored Message-ID', async () => {
    const g = got(Buffer.from('hello world'));
    transport.fetchPart.mockResolvedValue(g);
    const r = await att.fetchPartBuffer(db, msg, '2');
    expect(r.buffer.toString()).toBe('hello world');
    expect(transport.fetchPart).toHaveBeenCalledWith(conn, 'INBOX', 40, '2', { uidValidity: 9, messageId: 'm@x' });
    expect(g.close).toHaveBeenCalled();
  });
  test('over maxBytes → TOO_LARGE, connection closed', async () => {
    const g = got(Buffer.alloc(50));
    transport.fetchPart.mockResolvedValue(g);
    await expect(att.fetchPartBuffer(db, msg, '2', { maxBytes: 10 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(g.close).toHaveBeenCalled();
  });
  test('identity mismatch → RESYNC_PENDING; server lost it → PART_GONE', async () => {
    transport.fetchPart.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'MESSAGE_MISMATCH' }));
    await expect(att.fetchPartBuffer(db, msg, '2')).rejects.toMatchObject({ code: 'RESYNC_PENDING' });
    transport.fetchPart.mockResolvedValueOnce(null);
    await expect(att.fetchPartBuffer(db, msg, '2')).rejects.toMatchObject({ code: 'PART_GONE' });
  });
  test('no cursor / no uid → RESYNC_PENDING without touching the server', async () => {
    await expect(att.fetchPartBuffer(db, { ...msg, uid: null }, '2')).rejects.toMatchObject({ code: 'RESYNC_PENDING' });
    await expect(att.fetchPartBuffer(db, { ...msg, folder: 'Other' }, '2')).rejects.toMatchObject({ code: 'RESYNC_PENDING' });
    expect(transport.fetchPart).not.toHaveBeenCalled();
  });
  test('a part the message does not have → BAD_REF', async () => {
    await expect(att.fetchPartBuffer(db, msg, '3')).rejects.toMatchObject({ code: 'BAD_REF' });
    expect(transport.fetchPart).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('renderFolder / safeFileName', () => {
  test('{yymmdd} is FIRM-local: 03:30Z on Nov 6 is still Nov 5 in Detroit', () => {
    expect(filing.renderFolder('Client Uploads/Emailed {yymmdd}', { date: new Date('2026-11-06T03:30:00Z'), sender: 'x' }))
      .toBe('Client Uploads/Emailed 261105');
    expect(filing.renderFolder('Emailed {yyyy-mm-dd}', { date: new Date('2026-11-06T15:00:00Z') })).toBe('Emailed 2026-11-06');
  });
  test('the sender cannot add a path segment or a trailing dot', () => {
    expect(filing.renderFolder('Emailed {yymmdd} - {sender}', { date: new Date('2026-11-06T15:00:00Z'), sender: '../../evil/x' }))
      .toBe('Emailed 261106 - ..-..-evil-x');
    expect(filing.renderFolder('Emailed {yymmdd} - {sender}', { date: new Date('2026-11-06T15:00:00Z'), sender: 'Legacy Signature Properties, Inc.' }))
      .toBe('Emailed 261106 - Legacy Signature Properties, Inc');
    expect(filing.renderFolder('a/../b', { date: new Date('2026-11-06T15:00:00Z') })).toBe('a/b');
  });
  test('safeFileName keeps the extension when it truncates', () => {
    const n = filing.safeFileName(`${'x'.repeat(300)}.pdf`, 'pdf');
    expect(n.length).toBe(150);
    expect(n.endsWith('.pdf')).toBe(true);
    expect(filing.safeFileName('a/b:c.pdf', 'pdf')).toBe('a-b-c.pdf');
    expect(filing.safeFileName('..hidden.pdf', 'pdf')).toBe('hidden.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('notice', () => {
  const base = {
    from: { email: 'evil@x.com', name: '<script>alert(1)</script>' },
    subject: 'Docs <b>now</b>',
    date: '2026-11-05T20:00:00.000Z',
    text: 'see <img src=x onerror=alert(1)>',
    app_url: 'https://app.4lsg.com',
    files: [{ part: '2', filename: '"><svg onload=1>.pdf', filed_name: '"><svg onload=1>.pdf', status: 'filed', bytes: 2048 }],
    skipped: [],
    match: { reason: 'The sender\'s only open case is PVXC1RMM.', candidates: [] },
  };
  test('every email-derived string is escaped in the HTML', () => {
    const n = notice.render({ result: { ...base, placement: 'case', case_id: 'PVXC1RMM', case_link: 'https://app.4lsg.com/?files=cPVXC1RMM&open=file:0' } });
    expect(n.html).not.toMatch(/<script>|<svg|<img src=x|<b>now/);
    expect(n.html).toContain('&lt;script&gt;');
    expect(n.html).toContain('href="https://app.4lsg.com/?files=cPVXC1RMM&amp;open=file:0"');
  });
  test('subject: the caller\'s prefix + the outcome', () => {
    const p = 'New email to Docs@4LSG.com — ';
    expect(notice.render({ subjectPrefix: p, result: { ...base, from: { email: 'a@b.c', name: 'Kiara' }, placement: 'case', case_id: 'PVXC1RMM' } }).subject)
      .toBe('New email to Docs@4LSG.com — Kiara (1 file) — filed to case PVXC1RMM');
    expect(notice.render({ result: { ...base, from: { email: 'a@b.c' }, placement: 'unsorted', case_id: null } }).subject)
      .toBe('Emailed files — a@b.c (1 file) — UNSORTED, needs a case');
    expect(notice.render({ result: { ...base, from: { email: 'a@b.c' }, files: [], placement: 'none' } }).subject)
      .toBe('Emailed files — a@b.c (no files)');
    expect(notice.render({ result: { ...base, from: { email: 'a@b.c' }, files: [{ part: '2', filename: 'x.pdf', status: 'failed', error: 'boom' }], placement: 'none' } }).subject)
      .toBe('Emailed files — a@b.c (1 file) — NOT FILED');
  });
  test('the request_decision variant carries ONE [[options_html]]; email text can never inject a [[…]] token', () => {
    const r = { ...base, from: { email: 'a@b.c', name: '[[respond_url:zz]]' }, subject: 'x [[options_html]] y',
      text: '[[question]]', placement: 'unsorted', case_id: null, match: { reason: '[[expires_at]]', candidates: [] } };
    const plain = notice.render({ result: r });
    const dec = notice.render({ result: r, withOptions: true });
    expect((plain.html.match(/\[\[/g) || []).length).toBe(0);
    expect(dec.html.match(/\[\[[a-z_:]+\]\]/g)).toEqual(['[[options_html]]']);
    expect(dec.html).toContain('&#91;&#91;respond_url:zz&#93;&#93;');
    expect(plain.subject).not.toMatch(/\[\[|\]\]/);
  });

  test('unsorted with candidates lists them (and the text twin says the same)', () => {
    const n = notice.render({ result: { ...base, from: { email: 'a@b.c' }, placement: 'unsorted', case_id: null,
      match: { reason: 'The sender has 2 open cases and the email does not say which.',
        candidates: [{ case_id: 'PVXC1RMM', case_type: 'Bankruptcy', case_stage: 'Filed' }, { case_id: 'CF8ZT7VE', case_stage: 'Open' }] } } });
    expect(n.html).toContain('Filed to Unsorted — needs a case');
    expect(n.html).toContain('?files=cCF8ZT7VE');
    expect(n.text).toContain('possible case: PVXC1RMM — Bankruptcy · Filed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exactFolder — a folder a person picked inside the case folder (S3b)', () => {
  const { exactFolder } = require('../services/emailAttachmentFilingService');
  test('kept EXACTLY: leading spaces (the firm\'s sort order), inner spaces; doubled / edge slashes dropped', () => {
    expect(exactFolder(' 012 - Supplemental Responses')).toBe(' 012 - Supplemental Responses');
    expect(exactFolder('/  Client Uploads//Emailed 261110/')).toBe('  Client Uploads/Emailed 261110');
    expect(exactFolder('a/b/c/d/e/f')).toBe('a/b/c/d/e/f');
  });
  test.each([
    ['..', /"\." and "\.\."/], ['a/../b', /"\." and "\.\."/], [' . ', /"\." and "\.\."/], ['a\\b', /cannot hold/], ['a:b', /cannot hold/],
    ['a*', /cannot hold/], ['ok\u0007', /cannot hold/], ['a.', /end in a dot or a space/], ['a ', /end in a dot or a space/],
    ['   ', /blank/], ['x/  /y', /blank/], ['', /empty/], ['///', /empty/], ['a/b/c/d/e/f/g', /at most 6 levels/], ['x'.repeat(121), /longer than 120/],
    ['y'.repeat(401), /too long/],
  ])('%j is refused (BAD_FOLDER)', (raw, re) => {
    expect(() => exactFolder(raw)).toThrow(re);
    try { exactFolder(raw); } catch (e) { expect(e.code).toBe('BAD_FOLDER'); }
  });
  test('not text → refused', () => { expect(() => exactFolder(7)).toThrow(/folder must be text/); });
});
