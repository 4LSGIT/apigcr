// tests/complianceFooter.test.js
//
/**
 * The marketing-email compliance footer (YisraMail P3) — lib/complianceFooter.js.
 *
 * WHAT IS LOCKED
 *   - Every value is HTML-escaped in the html part (firm settings are
 *     staff-edited); the unsubscribe URL is an <a href> AND visible text in
 *     the html, and visible in the text part (C2's post-render assert).
 *   - The ad label is the builder's decision: present for an opt_out topic,
 *     absent for an opt_in one.
 *   - FAIL CLOSED: a missing firm name, postal address or attorney name, or a
 *     non-http(s) URL, throws — a footer with holes never renders.
 *   - The §528 statement and the ad label fall back to their code defaults
 *     when the setting is blank; a set value wins.
 *   - firmValues() is what the resolver's `firm` pseudo-table serves.
 */
'use strict';

const firmConfig = require('../lib/firmConfig');
const { buildComplianceFooter, firmValues, DEFAULTS, formatPhone } = require('../lib/complianceFooter');

const UNSUB = 'https://4lsg.com/u/Ab3dEfGh1jKlMn0pQr5tUv';
const PREFS = `${UNSUB}#prefs`;
const NEWS = { topic_key: 'newsletter', label: 'Newsletter', consent_model: 'opt_out' };

async function primeFirm(rows) {
  firmConfig._test({ db: { query: async () => [Object.entries(rows).map(([key, value]) => ({ key, value }))] }, resetCache: true });
  await firmConfig.prime();
}

const FIRM = {
  firm_name: 'Smith & Jones <Law>',
  firm_address: '["100 Main St., #2","Springfield, MI 48000"]',
  'fe-firm_phone': '2485550100',
  firm_attorney_name: 'Ann "A." Smith',
};

afterAll(() => firmConfig._test({ db: null, resetCache: true }));

describe('buildComplianceFooter', () => {
  beforeEach(() => primeFirm(FIRM));

  test('html: every value escaped; the unsubscribe URL is an href AND visible text; order of lines', () => {
    const { html } = buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS });
    expect(html).toContain('Smith &amp; Jones &lt;Law&gt;');
    expect(html).not.toContain('<Law>');
    expect(html).toContain('Ann &quot;A.&quot; Smith');
    expect(html).toContain(`<a href="${UNSUB}"`);
    expect(html).toContain(`>${UNSUB}</a>`);
    expect(html).toContain(`<a href="${PREFS}"`);
    expect(html).toContain('Manage preferences');
    expect(html).toContain('100 Main St., #2, Springfield, MI 48000');
    expect(html).toContain('(248) 555-0100');
    expect(html).toContain('Responsible attorney: Ann &quot;A.&quot; Smith');
    expect(html).toContain(DEFAULTS.debt_relief_statement);
    const order = ['Advertisement', 'Unsubscribe:', '100 Main St.', 'Responsible attorney', 'debt relief agency'].map((x) => html.indexOf(x));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
    expect(html).not.toMatch(/<table/i);
  });

  test('an & in a URL is escaped inside the href (and still visible)', () => {
    const u = 'https://4lsg.com/u/Tok?a=1&b=2';
    const { html, text } = buildComplianceFooter({ unsubscribeUrl: u, preferencesUrl: PREFS, topic: NEWS });
    expect(html).toContain('href="https://4lsg.com/u/Tok?a=1&amp;b=2"');
    expect(text).toContain(`Unsubscribe: ${u}`);
  });

  test('text part: the URLs visible, the same lines, no markup', () => {
    const { text } = buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS });
    expect(text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(text).toContain(`Manage preferences: ${PREFS}`);
    expect(text).toContain('Smith & Jones <Law> · 100 Main St., #2, Springfield, MI 48000 · (248) 555-0100');
    expect(text).toContain('Responsible attorney: Ann "A." Smith');
    expect(text).toContain(DEFAULTS.debt_relief_statement);
    expect(text.split('\n')[1]).toBe('Advertisement');
  });

  test('ad label: present for an opt_out topic, ABSENT for an opt_in topic', () => {
    const out = buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS });
    expect(out.html).toContain('>Advertisement</p>');
    const inn = buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: { ...NEWS, consent_model: 'opt_in' } });
    expect(inn.html).not.toContain('Advertisement');
    expect(inn.text).not.toContain('Advertisement');
  });

  test('set values win over the defaults', async () => {
    await primeFirm({ ...FIRM, marketing_ad_label: 'Attorney Advertising', marketing_debt_relief_statement: 'We are a debt relief agency (custom).' });
    const { html, text } = buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS });
    expect(html).toContain('Attorney Advertising');
    expect(text).toContain('We are a debt relief agency (custom).');
    expect(text).not.toContain(DEFAULTS.debt_relief_statement);
  });

  test.each([
    ['firm_address', 'postal address'],
    ['firm_attorney_name', 'responsible attorney'],
    ['firm_name', 'sender'],
  ])('THROWS when %s is missing (%s)', async (key, why) => {
    const rows = { ...FIRM };
    delete rows[key];
    await primeFirm(rows);
    expect(() => buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS })).toThrow(new RegExp(why));
  });

  test('THROWS on an empty address array and on blank strings', async () => {
    await primeFirm({ ...FIRM, firm_address: '["", "  "]' });
    expect(() => buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS })).toThrow(/postal address/);
    await primeFirm({ ...FIRM, firm_attorney_name: '   ' });
    expect(() => buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS })).toThrow(/attorney/);
  });

  test('THROWS on a missing / non-http URL or topic, and an unknown consent model', () => {
    const b = (o) => () => buildComplianceFooter({ unsubscribeUrl: UNSUB, preferencesUrl: PREFS, topic: NEWS, ...o });
    expect(b({ unsubscribeUrl: '' })).toThrow(/unsubscribeUrl/);
    expect(b({ unsubscribeUrl: 'javascript:alert(1)' })).toThrow(/unsubscribeUrl/);
    expect(b({ unsubscribeUrl: 'https://x/u/a"onmouseover=x' })).toThrow(/unsubscribeUrl/);
    expect(b({ preferencesUrl: undefined })).toThrow(/preferencesUrl/);
    expect(b({ topic: null })).toThrow(/topic/);
    expect(b({ topic: { ...NEWS, consent_model: 'maybe' } })).toThrow(/consent_model/);
  });
});

describe('firmValues (the resolver\'s firm pseudo-table)', () => {
  test('reads the settings; unset → null except the two defaulted keys', async () => {
    await primeFirm({ firm_name: 'X Firm' });
    expect(firmValues()).toEqual({
      name: 'X Firm', postal_address: null, phone: null, attorney_name: null,
      debt_relief_statement: DEFAULTS.debt_relief_statement, ad_label: 'Advertisement',
    });
    await primeFirm(FIRM);
    expect(firmValues()).toMatchObject({
      name: 'Smith & Jones <Law>', postal_address: '100 Main St., #2, Springfield, MI 48000',
      phone: '2485550100', attorney_name: 'Ann "A." Smith',
    });
  });

  test('formatPhone: 10 / 11 digits format; anything else as stored', () => {
    expect(formatPhone('2485550100')).toBe('(248) 555-0100');
    expect(formatPhone('12485550100')).toBe('(248) 555-0100');
    expect(formatPhone('ext 12')).toBe('ext 12');
    expect(formatPhone('')).toBeNull();
  });
});
