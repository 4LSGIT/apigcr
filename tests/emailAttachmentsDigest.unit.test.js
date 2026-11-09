// tests/emailAttachmentsDigest.unit.test.js
//
/**
 * Email attachments S2d — the burst digest's PURE parts (ref/EMAIL_ATTACHMENTS_DESIGN.md §8):
 * emailAttachmentNotice.renderDigest (one notice for several emails from one
 * sender) and the service's single-email passthrough. The burst rule itself —
 * quiet time, cap, the claim — runs on real MySQL in
 * tests/emailAttachments.mysql.test.js ("burst digest"); the workflow loop in
 * tests/emailAttachments.workflow.test.js ("v3").
 *
 *   npx jest tests/emailAttachmentsDigest.unit.test.js
 */

'use strict';

const notice = require('../services/emailAttachmentNotice');
const digest = require('../services/emailAttachmentDigestService');

const APP = 'https://app.test';
let seq = 0;
/** A stored filing result, as emailAttachmentFilingService records it for the digest. */
function result(over = {}) {
  const id = ++seq;
  return {
    mail_message_id: 3300 + id, mailbox_id: 2,
    from: { email: 'dawn@x.com', name: 'Dawn Sims' },
    subject: `photo ${id}`, date: `2026-11-08T22:${String(10 + id).padStart(2, '0')}:00.000Z`,
    match: { case_id: 'DZ8G0HYT', method: 'sender_open_case', reason: "The sender's one open case.", candidates: [], contact: { contact_id: 7, name: 'Dawn Sims' } },
    placement: 'case', case_id: 'DZ8G0HYT', contact_id: 7,
    folder_path: '/Clients/Sims/Client Uploads/Emailed 261108', folder_link: 'https://dbx/sh/sims?rlkey=1',
    app_url: APP, case_link: `${APP}/?files=cDZ8G0HYT`, contact_link: `${APP}/?people=7`,
    files: [{ part: '2', filename: `IMG_${id}.jpg`, status: 'filed', filed_name: `IMG_${id}.jpg`, bytes: 120000,
      link: `https://dbx/sh/sims?rlkey=1&preview=IMG_${id}.jpg` }],
    skipped: [], docs_checklist: null, needs_decision: false, decision_options: [],
    excerpt: { body: '', trimmed: false, cut: 0 },
    notice_prefix: 'New email to Docs@4LSG.com — ', notice_title: 'docs@4lsg.com',
    ...over,
  };
}
const unsorted = (over = {}) => result({
  placement: 'unsorted', case_id: null, folder_path: '/Unsorted/Emailed 261108 - Sims, Dawn', folder_link: 'https://dbx/sh/bin?rlkey=2',
  case_link: null,
  match: { case_id: null, flag: 'multiple_open_cases', reason: 'Several open cases — none is retained.', contact: { contact_id: 7, name: 'Dawn Sims' },
    candidates: [{ case_id: 'AAAA1111', case_number: '26-1', case_type: 'Ch. 7', case_stage: 'Open' }, { case_id: 'BBBB2222', case_type: 'Ch. 13', case_stage: 'Filed' }] },
  needs_decision: true,
  decision_options: [{ label: 'AAAA1111 — 26-1 · Ch. 7 · Open', value: 'AAAA1111' }, { label: 'BBBB2222 — Ch. 13 · Filed', value: 'BBBB2222' }, { label: 'Leave it in Unsorted', value: 'unsorted' }],
  ...over,
});
const P = { subjectPrefix: 'New email to Docs@4LSG.com — ', title: 'docs@4lsg.com' };

describe('renderDigest — subject', () => {
  test.each([
    ['all to one case', () => [result(), result(), result()], 'Dawn Sims (3 files from 3 emails) — filed to case DZ8G0HYT'],
    ['two cases', () => [result(), result({ case_id: 'CF8ZT7VE', match: { reason: 'Case id in the subject.' } })], 'Dawn Sims (2 files from 2 emails) — filed to cases DZ8G0HYT, CF8ZT7VE'],
    ['any unsorted → needs a case', () => [result(), unsorted()], 'Dawn Sims (2 files from 2 emails) — UNSORTED, needs a case'],
    ['nothing filed', () => [result({ files: [{ part: '2', filename: 'a.pdf', status: 'failed', error: 'x' }] }), result({ files: [{ part: '2', filename: 'b.pdf', status: 'failed', error: 'y' }] })], 'Dawn Sims (2 files from 2 emails) — NOT FILED'],
    ['no files at all', () => [result({ files: [] }), result({ files: [] })], 'Dawn Sims (2 emails, no files)'],
    ['one file', () => [result({ files: [] }), result()], 'Dawn Sims (1 file from 2 emails) — filed to case DZ8G0HYT'],
  ])('%s', (_l, mk, tail) => {
    expect(notice.renderDigest({ results: mk(), ...P }).subject).toBe(`New email to Docs@4LSG.com — ${tail}`);
  });

  test('the sender\'s name comes from the newest email; [[ / ]] in it are broken apart', () => {
    const s = notice.renderDigest({ results: [result(), result({ from: { email: 'dawn@x.com', name: 'Dawn [[respond_url:x]] Sims' } })], ...P }).subject;
    expect(s).toBe('New email to Docs@4LSG.com — Dawn [ [respond_url:x] ] Sims (2 files from 2 emails) — filed to case DZ8G0HYT');
  });
});

describe('renderDigest — body', () => {
  test('one box per destination with its own links; every email listed oldest first, tagged only when they went different ways', () => {
    const rs = [result(), unsorted(), result()];
    const { html, text } = notice.renderDigest({ results: rs, ...P });
    expect(html).toContain('Filed to case DZ8G0HYT — 2 files from 2 emails');
    expect(html).toContain('Filed to Unsorted — needs a case — 1 file from 1 email');
    expect(html.indexOf('Filed to case DZ8G0HYT')).toBeLessThan(html.indexOf('Filed to Unsorted'));   // cases first
    expect(html).toContain('href="https://dbx/sh/sims?rlkey=1"');
    expect(html).toContain('href="https://dbx/sh/bin?rlkey=2"');
    expect(html).toContain(`>Open case DZ8G0HYT in YisraCase</a>`);
    expect(html).toContain('>Open Dawn Sims in YisraCase</a>');
    expect(html).toContain('Possible cases:');
    const at = rs.map(r => html.indexOf(`>${r.subject}</div>`));
    expect(at.every(i => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(html).toContain(' · case DZ8G0HYT</div>');
    expect(html).toContain(' · Unsorted</div>');
    expect(html).toContain('3 emails · 3 of 3 files filed');
    expect(text).toContain('Filed to Unsorted — needs a case — 1 file from 1 email. Several open cases — none is retained. Move the files to the right case folder.');
    expect(text).toContain('  possible case: AAAA1111 — 26-1 · Ch. 7 · Open');
    expect(text).toMatch(/\n2\. .* · Unsorted\n {3}Subject: photo \d+\n {2}- IMG_\d+\.jpg \(117 KB\)/);
    const one = notice.renderDigest({ results: [result(), result()], ...P }).html;
    expect(one).not.toContain(' · case DZ8G0HYT</div>');                          // one destination: no tags
  });

  test('[[options_html]] once, in the unsorted box, only withOptions', () => {
    const rs = [result(), unsorted(), unsorted()];
    const plain = notice.renderDigest({ results: rs, ...P }).html;
    const ask = notice.renderDigest({ results: rs, ...P, withOptions: true }).html;
    expect(plain).not.toContain('[[options_html]]');
    expect(ask.match(/\[\[options_html\]\]/g)).toHaveLength(1);
    expect(ask.indexOf('[[options_html]]')).toBeGreaterThan(ask.indexOf('Filed to Unsorted'));
    expect(ask).toContain('Every unsorted file in this notice moves there when you choose.');
    // candidates offered by several emails are listed once
    expect(ask.match(/>AAAA1111<\/a>/g)).toHaveLength(1);
  });

  test('everything from the email is escaped, square brackets included (request_decision expands [[…]] in email_html)', () => {
    const evil = '<img src=x onerror=alert(1)> [[respond_url:x]] & "q"';
    const rs = [result({ subject: evil, from: { email: 'e@x.com', name: evil }, excerpt: { body: evil, trimmed: false, cut: 0 },
      files: [{ part: '2', filename: `${evil}.pdf`, filed_name: `${evil}.pdf`, status: 'filed', bytes: 1, link: 'https://dbx/x?a=1&preview=<b>' }] }), unsorted()];
    const { html } = notice.renderDigest({ results: rs, ...P, withOptions: true });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('[[respond_url');
    expect(html.match(/\[\[/g)).toHaveLength(1);                                // only the options token
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &#91;&#91;respond_url:x&#93;&#93; &amp; &quot;q&quot;');
    expect(html).toContain('href="https://dbx/x?a=1&amp;preview=&lt;b&gt;"');
  });

  test('files that could not be filed get their own box; no files at all → "No attachments"', () => {
    const rs = [result(), result({ files: [{ part: '2', filename: 'a.pdf', status: 'failed', error: 'socket hang up' }, { part: '3', filename: 'b.pdf', status: 'in_progress' }] })];
    const { html, text } = notice.renderDigest({ results: rs, ...P });
    expect(html).toContain('2 files could not be filed');
    expect(html).toContain('NOT filed — socket hang up');
    expect(text).toContain('2 files could not be filed. They are listed below with the reason.');
    const none = notice.renderDigest({ results: [result({ files: [] }), result({ files: [], skipped: [] })], ...P });
    expect(none.html).toContain('No attachments');
    expect(none.html).toContain('2 emails (no attachments)');
    expect(none.html).not.toContain('could not be filed');
  });

  test('each email\'s words, cut short; the case\'s Docs Needed list as read at digest time wins over each email\'s copy', () => {
    const long = 'word '.repeat(300).trim();
    const stale = { link: `${APP}/?dl`, items: 2, open_count: 2, open: ['Paystubs', 'W2'] };
    const fresh = { link: `${APP}/?dl2`, items: 2, open_count: 1, open: ['W2'] };
    const rs = [result({ docs_checklist: stale, excerpt: { body: long, trimmed: true, cut: 0 } }), result({ docs_checklist: stale })];
    const { html, text } = notice.renderDigest({ results: rs, ...P, checklists: { DZ8G0HYT: fresh } });
    expect(html).toContain('Docs Needed list — 1 of 2 still needed:');
    expect(html).toContain('href="https://app.test/?dl2"');
    expect(html).not.toContain('Paystubs');
    expect(html).toContain('check them off the Docs Needed list.');
    const shown = (html.match(/(word ?)+/) || [''])[0];
    expect(shown.length).toBeLessThanOrEqual(notice.DIGEST_BODY_MAX);
    expect(html).toMatch(/— shortened \(\d+ more characters\) —/);
    expect(text).toContain('   > word word');
    // a case whose list was read and found absent → no list, even if an email carried one
    expect(notice.renderDigest({ results: rs, ...P, checklists: { DZ8G0HYT: null } }).html).not.toContain('Docs Needed');
  });
});

describe('the service\'s pure edges', () => {
  test('a burst of one is the filing step\'s own notice, untouched (no DB read)', async () => {
    const r = unsorted({ notice_subject: 'S', notice_html: '<h>', notice_text: 't', notice_html_decision: '<h>[[options_html]]' });
    const db = { query: async () => { throw new Error('no DB expected'); } };
    const out = await digest.digestOutput(db, [{ mail_message_id: r.mail_message_id, result: r }]);
    expect(out).toMatchObject({ count: 1, notice_subject: 'S', notice_html: '<h>', notice_text: 't', notice_html_decision: '<h>[[options_html]]',
      needs_decision: true, decision_options: r.decision_options, unsorted_ids: [r.mail_message_id],
      unsorted_folder_path: r.folder_path, unsorted_folder_link: r.folder_link, case_ids: [] });
  });

  test('several: options merged (first-seen order, each once), "leave them" last; Docs Needed read per case', async () => {
    const a = unsorted();
    const b = unsorted({ decision_options: [{ label: 'CCCC3333 — x', value: 'CCCC3333' }, { label: 'AAAA1111 — dup', value: 'AAAA1111' }, { label: 'Leave it in Unsorted', value: 'unsorted' }] });
    const c = result();
    const calls = [];
    const db = { query: async (sql, p) => { calls.push(p); return [[]]; } };   // no Docs Needed rows
    const out = await digest.digestOutput(db, [a, b, c].map(r => ({ mail_message_id: r.mail_message_id, result: r })));
    expect(out.decision_options.map(o => o.value)).toEqual(['AAAA1111', 'BBBB2222', 'CCCC3333', 'unsorted']);
    expect(out.decision_options[0].label).toBe('AAAA1111 — 26-1 · Ch. 7 · Open');
    expect(out.needs_decision).toBe(true);
    expect(out.case_ids).toEqual(['DZ8G0HYT']);
    expect(calls).toEqual([['DZ8G0HYT']]);
    expect(out.notice_html_decision.match(/\[\[options_html\]\]/g)).toHaveLength(1);
    expect(out.notice_subject.startsWith('New email to Docs@4LSG.com — Dawn Sims (3 files from 3 emails)')).toBe(true);
    // no unsorted email offered a case → no decision
    const plain = await digest.digestOutput(db, [result(), result()].map(r => ({ mail_message_id: r.mail_message_id, result: r })));
    expect(plain).toMatchObject({ needs_decision: false, decision_options: [], notice_html_decision: null });
  });

  test('senderKey: lowercased address; none → never grouped', () => {
    expect(digest.senderKey(' Dawn@X.com ', 5)).toBe('dawn@x.com');
    expect(digest.senderKey('', 5)).toBe('#5');
    expect(digest.senderKey(null, 6)).toBe('#6');
  });
});
