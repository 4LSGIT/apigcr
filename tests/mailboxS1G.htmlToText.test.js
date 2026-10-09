// tests/mailboxS1G.htmlToText.test.js
//
/**
 * Mailbox system S1-G follow-up — htmlToText parity with Gmail's plain text
 * on court NEFs (services/mailbox/mailboxIngestService.js htmlToText /
 * emitText / buildRow). Court NEFs are single-part text/html: the Apps Script
 * feeder posts Gmail's getPlainBody(), the IMAP worker posts htmlToText(html),
 * and from the Gmail flip whichever arrives first runs Layer 3. Measured on 80
 * live NEFs: ref/MAILBOX_GMAIL_PARITY.md §0. Fixtures here are SYNTHETIC
 * (structure of a real NEF, invented names / numbers).
 * Run: npx jest tests/mailboxS1G.htmlToText.test.js
 *
 * Mutation-checked (break the code, watch the named test fail):
 *   - anchorsToText not called                    → "links render as `label <url>` …"
 *   - URL inserted directly (no placeholder)      → "a URL survives the text passes untouched"
 *   - label === href dedupe dropped               → "bare link: the URL once"
 *   - CRLF normalisation dropped                  → "CRLF / CR line ends become LF"
 *   - bare-&nbsp branch dropped                   → "bare &nbsp (no semicolon) decodes …"
 *   - bare-&nbsp lookahead dropped                → "bare &nbsp (no semicolon) decodes …"
 *   - C0-control guard dropped                    → "numeric refs cannot forge a link slot"
 *   - <hr> no longer a break                      → "<hr> is a line break, not a run-on"
 *   - <img alt> not rendered                      → "<img alt> renders as its alt text …"
 *   - buildRow snippet keeps links                → "snippet: no URLs …"
 *   - anchor label scan unbounded                 → "the label scan is bounded …"
 */

'use strict';

const svc = require('../services/mailbox/mailboxIngestService');

// A synthetic NEF in the shape the MIEB CM/ECF server sends: CRLF line ends,
// <A HREF=…> unquoted upper-case for the docket, href='…' single-quoted with
// &amp;-free query strings for doc1, <b>/<strong> labels, a long filer name.
const NEF = [
  '<p><strong>U.S. Bankruptcy Court</strong></p>',
  '<p><strong>Notice of Electronic Filing</strong></p>',
  '<div>',
  'The following transaction was received from Jane Filer entered on 10/8/2026 at 2:32 PM EDT and filed on 10/8/2026',
  '<BR>',
  '<table border=0 cellspacing=0>',
  '<tr><td><strong>Case Name:</strong></td><td>Alexandra Q. Example-Testperson</td></tr>',
  '<tr><td><strong>Case Number:</strong></td><td><A HREF=https://ecf.test.uscourts.gov/cgi-bin/DktRpt.pl?1030531>26-12345-abc</A></td></tr>',
  '<tr><td><strong>Document Number:</strong></td><td>',
  "<a href='https://ecf.test.uscourts.gov/doc1/096074763527?de_seq_num=110&magic_num=47982749&caseid=1030531&pdf_header='>30</a>",
  '</td></tr>',
  '</table>',
  '<p><strong>Docket Text:</strong>',
  '<BR>',
  '<HR>Certificate of Service Filed by Creditor Michigan Example Housing Development Authority. (Doe, Jo)',
  '</p>',
  '</div>',
].join('\r\n');

describe('htmlToText — links', () => {
  test('links render as `label <url>`: unquoted HREF, single- and double-quoted href', () => {
    const t = svc.htmlToText(NEF);
    expect(t).toContain('26-12345-abc <https://ecf.test.uscourts.gov/cgi-bin/DktRpt.pl?1030531>');
    expect(t).toContain('30 <https://ecf.test.uscourts.gov/doc1/096074763527?de_seq_num=110&magic_num=47982749&caseid=1030531&pdf_header=>');
    expect(svc.htmlToText('<a class="x" href="https://a.example/p?q=1&amp;r=2" target=_blank>Open <b>it</b></a>'))
      .toBe('Open it <https://a.example/p?q=1&r=2>');
  });

  test('a URL survives the text passes untouched (&nbsp= / &amp; in a query, entity-looking text)', () => {
    expect(svc.htmlToText('<a href="https://x.example/?a=1&nbsp=2&lt=3">go</a>'))
      .toBe('go <https://x.example/?a=1&nbsp=2&lt=3>');
  });

  test('bare link: the URL once; empty label: the <url> alone; image link: alt + <url>', () => {
    expect(svc.htmlToText('<p><a href="https://b.example/x">https://b.example/x</a></p>')).toBe('https://b.example/x');
    expect(svc.htmlToText('see <a href="https://c.example/"></a> here')).toBe('see <https://c.example/> here');
    expect(svc.htmlToText('<a href="https://d.example/"><img src="l.png" alt="Logo"></a>')).toBe('Logo <https://d.example/>');
  });

  test('non-http(s) hrefs, relative hrefs and name anchors keep only the label', () => {
    expect(svc.htmlToText('<a href="mailto:a@b.example">a@b.example</a> <a href="/rel">rel</a> <a name="top"></a>x'))
      .toBe('a@b.example rel x');
    expect(svc.htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  test('links:false keeps URLs out (the snippet derivation)', () => {
    expect(svc.htmlToText(NEF, { links: false })).not.toContain('<https');
    expect(svc.htmlToText(NEF, { links: false })).toContain('Case Number: 26-12345-abc');
  });

  test('the label scan is bounded: a 4001-char label keeps its text, loses only the URL; unclosed <a> stay linear', () => {
    const long = 'y'.repeat(4001);
    expect(svc.htmlToText(`<a href="https://b.example/">${long}</a>`)).toBe(long);
    expect(svc.htmlToText(`<a href="https://b.example/">${'y'.repeat(4000)}</a>`)).toBe(`${'y'.repeat(4000)} <https://b.example/>`);
    const t0 = Date.now();
    svc.htmlToText('<a href="https://x.example/">'.repeat(5000) + 'z'.repeat(100000));
    expect(Date.now() - t0).toBeLessThan(2000); // ~70 ms bounded; unbounded rescans to the end per tag
  });

  test('numeric refs cannot forge a link slot', () => {
    expect(svc.htmlToText('<a href="https://e.example/">e</a> &#1;0&#2; &#x1;0&#x2;')).toBe('e <https://e.example/> 0 0');
  });
});

describe('htmlToText — line ends, entities, blocks, images', () => {
  test('CRLF / CR line ends become LF', () => {
    const t = svc.htmlToText(NEF);
    expect(t).not.toMatch(/\r/);
    expect(svc.htmlToText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  test('bare &nbsp (no semicolon) decodes; &amp;nbsp stays literal; &nbspx is not an entity', () => {
    expect(svc.htmlToText('2 &nbsp &nbsp Claims Register')).toBe('2 Claims Register');
    expect(svc.htmlToText('a&nbsp;b &nbsp<b>c</b>')).toBe('a b c');
    expect(svc.htmlToText('&amp;nbsp and &nbspx')).toBe('&nbsp and &nbspx');
  });

  test('<hr> is a line break, not a run-on', () => {
    expect(svc.htmlToText('Docket Text:<HR>Order of the Court')).toBe('Docket Text:\nOrder of the Court');
    expect(svc.htmlToText('a<hr class="x"/>b')).toBe('a\nb');
  });

  test('<img alt> renders as its alt text (as Gmail does); no alt → nothing', () => {
    expect(svc.htmlToText('<p><img src="b.jpg" alt="US Court Banner" width=600></p><p>Be advised</p>')).toBe('US Court Banner\n\nBe advised');
    expect(svc.htmlToText("x<img src='t.gif'>y<img alt=''>z")).toBe('x y z');
  });

  test('unchanged: script/style/comments dropped, numeric + named entities, cells spaced', () => {
    expect(svc.htmlToText('<style>p{}</style><!-- c --><p>A&amp;B&#39;s &#x41;</p><br>z')).toBe("A&B's A\n\nz");
    expect(svc.htmlToText('<td>a</td><td>b</td>')).toBe('a b');
  });
});

describe('htmlToText — the court-rule captures it feeds', () => {
  test("rule 8's filer regex gets the whole name (no ~76-col wrap to cut it)", () => {
    const t = svc.htmlToText(NEF);
    const m = t.match(/Filed by[^A-Za-z]+([A-Za-z. ]+[A-Za-z])/);
    expect(m[1]).toBe('Creditor Michigan Example Housing Development Authority');
    expect(t).toContain('Case Name: Alexandra Q. Example-Testperson');
    expect(t).toMatch(/Docket Text:\n+Certificate of Service/); // <BR><HR>: a break, never a run-on
  });
});

describe('the derivations that use it', () => {
  test('emitText (what is emitted, and what emit-preview shows) carries the links', () => {
    const { text, derived } = svc.emitText('', NEF);
    expect(derived).toBe(true);
    expect(text).toContain('26-12345-abc <https://ecf.test.uscourts.gov/cgi-bin/DktRpt.pl?1030531>');
  });

  test('snippet: no URLs, CRLF-free, &nbsp decoded', () => {
    const row = svc.buildRow(1, 'INBOX', {
      uid: 7, envelope: { messageId: 'nef@test', from: [], to: [], cc: [] }, headerBlock: '', flags: [],
      text: null, html: '<p>Case Number: <A HREF=https://ecf.test.uscourts.gov/x>26-12345-abc</A>&nbsp &nbsp Docket</p>\r\n',
    });
    expect(row.snippet).toBe('Case Number: 26-12345-abc Docket');
  });
});
