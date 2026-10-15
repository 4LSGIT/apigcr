/**
 * wsurl S-links — server-built staff links open the file by EXACT id.
 *
 * The legacy one-shot `/?case=<id>` / `/?contact=<id>` makes the shell run a
 * limit=1 search, so an id that misses the exact tier opens the search's best
 * match (another client's file — review F9). lib/shellLinks emits the shell's
 * workspace form `/?files=c<case_id>&open=file:0` / `p<contact_id>`, which
 * restoreOpenFiles verifies by id AND type. An id of the wrong shape falls
 * back to the legacy form, unchanged.
 *
 * Every site below is rendered for real (the exported builder, or the
 * internal function against a stub db), and its exact href asserted — with
 * the '&' of the new form escaped exactly once.
 */

'use strict';

const shellLinks = require('../lib/shellLinks');

const APP = 'https://app.4lsg.com';
const CASE_HREF = `${APP}/?files=cABCD-_2345&amp;open=file:0`;
const CONTACT_HREF = `${APP}/?files=p1405&amp;open=file:0`;

describe('lib/shellLinks', () => {
  test('both kinds, by exact id; the base\'s trailing slash is normalised', () => {
    expect(shellLinks.caseLink(APP, 'ABCD2345')).toBe(`${APP}/?files=cABCD2345&open=file:0`);
    expect(shellLinks.caseLink(APP + '/', 'Ab-_9')).toBe(`${APP}/?files=cAb-_9&open=file:0`);   // legacy base64url ids
    expect(shellLinks.contactLink(APP, 1405)).toBe(`${APP}/?files=p1405&open=file:0`);
    expect(shellLinks.contactLink(APP, '1234567')).toBe(`${APP}/?files=p1234567&open=file:0`);   // the >6-digit gap
    expect(shellLinks.contactLink(null, 7)).toBe(`${APP}/?files=p7&open=file:0`);
  });

  test('an id of the wrong shape falls back to the LEGACY form, unchanged', () => {
    for (const bad of ['', null, undefined, 'AB CD', 'x"><b>', 'a,b', 'a~b', 'a&b=c']) {
      expect(shellLinks.caseLink(APP, bad)).toBe(`${APP}/?case=${bad == null ? '' : bad}`);
    }
    for (const bad of ['', null, '12a', '-3', '1.5', 'ABCD2345']) {
      expect(shellLinks.contactLink(APP, bad)).toBe(`${APP}/?contact=${bad == null ? '' : bad}`);
    }
  });

  test('attr() escapes for a double-quoted attribute, once', () => {
    expect(shellLinks.attr(`${APP}/?files=p1&open=file:0`)).toBe(`${APP}/?files=p1&amp;open=file:0`);
    expect(shellLinks.attr('a"<b>&')).toBe('a&quot;&lt;b&gt;&amp;');
  });
});

describe('services/eventService.js buildEventDigestEmail', () => {
  const { buildEventDigestEmail } = require('../services/eventService');
  const html = buildEventDigestEmail('Ann', [{ dateName: 'Today', events: [
    { event_link_type: 'contact', event_link_id: 1405, contact_name: 'Ann & Co', event_title: 't1', event_all_day: 1 },
    { event_link_type: 'case', event_link_id: 'ABCD-_2345', case_id: 'ABCD-_2345', case_number: '26-1', event_title: 't2', event_all_day: 1 },
    { event_link_type: 'case_number', event_link_id: '26-1', resolved_case_id: 'ABCD-_2345', event_title: 't3', event_all_day: 1 },
    { event_link_type: 'case', event_link_id: 'bad id', case_number: '26-2', event_title: 't4', event_all_day: 1 },
  ] }]);

  test('contact, case and resolved-docket links: the exact href, & escaped once', () => {
    expect(html).toContain(`<a href="${CONTACT_HREF}" `);
    expect(html.split(`<a href="${CASE_HREF}" `)).toHaveLength(3);   // case + resolved docket
    expect(html).not.toContain('&amp;amp;');
    expect(html).not.toMatch(/href="[^"]*\?(case|contact)=(1405|ABCD)/);
  });

  test('a bad id keeps the legacy form (escaped as before); the label is unchanged', () => {
    expect(html).toContain(`<a href="${APP}/?case=bad id" `);
    expect(html).toContain('>Ann &amp; Co</a>');
  });
});

describe('services/taskService.js buildDigestEmail', () => {
  const { buildDigestEmail } = require('../services/taskService');
  const html = buildDigestEmail({ user_name: 'Fred' },
    [{ title: 'a', contact_name: 'Ann', contact_id: 1405, task_due: '2026-10-01' }],
    [{ title: 'b', case_number: '26-1', case_id: 'ABCD-_2345', task_due: '2026-10-16' }],
    [], 'Friday');

  test('contact and case links: the exact href, & escaped once', () => {
    expect(html).toContain(`<a href="${CONTACT_HREF}" style="color:#4f46e5;text-decoration:none">Ann</a>`);
    expect(html).toContain(`<a href="${CASE_HREF}" style="color:#4f46e5;text-decoration:none">26-1</a>`);
    expect(html).not.toContain('&amp;amp;');
  });
});

function stubDb(rows) {
  return { query: async () => [rows] };
}

describe('lib/internal_functions get_events / get_appointments (html_rows)', () => {
  const fns = require('../lib/internal_functions');

  test('get_events: contact and case cells, the exact href', async () => {
    const out = await fns.get_events({ format: 'html_rows', base_url: APP, from: '2026-10-01', to: '2026-10-31' }, stubDb([
      { event_id: 1, event_link_type: 'contact', event_link_id: 1405, contact_id: 1405, contact_name: 'Ann', event_date_fmt: 'd' },
      { event_id: 2, event_link_type: 'case', event_link_id: 'ABCD-_2345', case_number: '26-1', event_date_fmt: 'd' },
    ]));
    const s = JSON.stringify(out);
    expect(s).toContain(`<a href=\\"${CONTACT_HREF}\\" style=\\"color:#1a73e8;\\">Ann</a>`);
    expect(s).toContain(`<a href=\\"${CASE_HREF}\\" style=\\"color:#1a73e8;\\">26-1</a>`);
  });

  test('get_appointments: client and case cells, the exact href', async () => {
    const out = await fns.get_appointments({ format: 'html_rows', base_url: APP, date: '2026-10-15' }, stubDb([
      { appt_id: 9, contact_id: 1405, contact_name: 'Ann', appt_case_id: 'ABCD-_2345', case_number: '26-1' },
    ]));
    const s = JSON.stringify(out);
    expect(s).toContain(`<a href=\\"${CONTACT_HREF}\\" style=\\"color:#1a73e8;\\">Ann</a>`);
    expect(s).toContain(`<a href=\\"${CASE_HREF}\\" style=\\"color:#1a73e8;\\">26-1</a>`);
  });
});
