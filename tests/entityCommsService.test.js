'use strict';

const svc = require('../services/entityCommsService');

describe('entityCommsService query contract', () => {
  test('defaults and caps the page size', () => {
    expect(svc.parseQuery({})).toMatchObject({ kind: 'all', direction: null, limit: 30, offset: 0, includeContacts: false });
    expect(svc.parseQuery({ kind: 'court', direction: 'incoming', limit: '999', offset: '4' }))
      .toMatchObject({ kind: 'court', direction: 'incoming', limit: 100, offset: 4 });
  });

  test('accepts compound channel filters and the explicit case-contact expansion flag', () => {
    expect(svc.parseQuery({ kind: 'phone' })).toMatchObject({ kind: 'phone' });
    expect(svc.parseQuery({ kind: 'direct', include_contacts: '1' }))
      .toMatchObject({ kind: 'direct', includeContacts: true });
    expect(() => svc.parseQuery({ include_contacts: 'sometimes' })).toThrow(/include_contacts/);
  });

  test('search reads normalized fields, never JSON keys, ids or timestamps', () => {
    const f = (q) => ({ kind: 'all', direction: null, qLower: q.toLowerCase() });
    const email = { key: 'email:mid:x', id: 77, kind: 'email', direction: 'incoming', at: '2026-10-19T10:00:00.000Z',
      participant: 'jane@client.test', preview: 'Please call me', log_id: null, legacy: false, contact: null,
      email: { id: 77, mailbox_id: 2, subject: 'Plan payment', from: 'Jane <jane@client.test>', to: 'staff@firm.test', cc: null } };
    const call = { key: 'phone:5', id: 5, kind: 'call', direction: 'outgoing', at: '2026-10-19T10:00:00.000Z',
      participant: '3135550001', preview: 'completed · 45s', call_status: 'completed', legacy: false,
      contact: { contact_id: 9, contact_name: 'Jane Client' }, phone: { line_number: '2485550100', status: 'completed', body: null } };
    const logged = { key: 'log:9', id: 9, kind: 'email', direction: 'incoming', legacy: true, preview: '',
      log: { type: 'email', from: 'court@uscourts.test', to: null, subject: null, message: null, data: { Message: 'Order confirming plan' } } };
    for (const q of ['subject', 'status', 'kind', 'preview', 'mailbox_id', 'legacy', 'key', '77', '2026-10-19']) {
      expect([email, call, logged].filter(x => svc.itemMatches(x, f(q))).map(x => x.key)).toEqual([]);
    }
    expect(svc.itemMatches(email, f('plan payment'))).toBe(true);
    expect(svc.itemMatches(email, f('JANE@client'))).toBe(true);
    expect(svc.itemMatches(call, f('Jane Client'))).toBe(true);
    expect(svc.itemMatches(call, f('(313) 555-0001'))).toBe(true);
    expect(svc.itemMatches(call, f('1-313-555-0001'))).toBe(true);
    expect(svc.itemMatches(call, f('248-555'))).toBe(true);
    expect(svc.itemMatches(call, f('outgoing'))).toBe(true);
    expect(svc.itemMatches(call, f('phone'))).toBe(true);
    expect(svc.itemMatches(logged, f('confirming plan'))).toBe(true);
  });

  test('compound filters keep their intended channel sets', () => {
    const base = { direction: null, qLower: '' };
    expect(['email', 'sms', 'call', 'court'].filter(kind => svc.itemMatches({ kind }, { ...base, kind: 'phone' })))
      .toEqual(['sms', 'call']);
    expect(['email', 'sms', 'call', 'court'].filter(kind => svc.itemMatches({ kind }, { ...base, kind: 'direct' })))
      .toEqual(['email', 'sms', 'call']);
  });

  test.each([
    [{ kind: 'note' }, /kind must/],
    [{ direction: 'all' }, /direction must/],
    [{ limit: '0' }, /limit must/],
    [{ offset: '-1' }, /offset must/],
    [{ q: 'x'.repeat(201) }, /q must/],
  ])('rejects malformed query %#', (query, message) => {
    expect(() => svc.parseQuery(query)).toThrow(message);
  });
});

describe('entityCommsService identity helpers', () => {
  test('extracts and normalizes exact email tokens', () => {
    expect(svc.emailsIn('Jane <JANE@Example.COM>, other@example.org'))
      .toEqual(['jane@example.com', 'other@example.org']);
  });

  test('uses the shared alias-slice rule and rejects an address-looking display-name spoof', () => {
    const alias = { address: 'jane@example.com', alias_label: null };
    expect(svc.aliasAdmits(alias, {
      from_addr: '"jane@example.com" <attacker@example.net>', to_addrs: '', cc_addrs: '', gmail_labels: '[]',
    })).toBe(false);
    expect(svc.aliasAdmits(alias, {
      from_addr: 'Jane <jane@example.com>', to_addrs: '', cc_addrs: '', gmail_labels: '[]',
    })).toBe(true);
  });

  test('contact matching honors angle-address semantics', () => {
    expect(svc.participantEmails({
      from_addr: '"victim@example.com" <sender@example.net>',
      to_addrs: 'Victim <victim@example.com>', cc_addrs: null,
    })).toEqual(['sender@example.net', 'victim@example.com']);
  });

  test('ownership windows are inclusive', () => {
    const at = new Date('2026-10-19T16:00:00Z');
    expect(svc.dateInWindow(at, { start_date: '2026-10-19', end_date: '2026-10-19' })).toBe(true);
    expect(svc.dateInWindow(at, { start_date: '2026-10-20', end_date: null })).toBe(false);
  });

  // mysql2 returns a DATE column as a Date at UTC midnight (pool timezone 'Z',
  // no dateStrings). String(thatDate) is "Mon Oct 19 2026 …", which once made
  // every dated start fail and every dated end pass. Feed the driver's shape.
  const driverDate = (ymd) => new Date(`${ymd}T00:00:00Z`);

  test('ownership windows work on driver-shaped Date bounds, inclusive at both ends', () => {
    const at = new Date('2026-10-19T16:00:00Z'); // 12:00 in Detroit, 10/19
    expect(svc.dateInWindow(at, { start_date: driverDate('2026-10-19'), end_date: driverDate('2026-10-19') })).toBe(true);
    expect(svc.dateInWindow(at, { start_date: driverDate('2026-10-01'), end_date: null })).toBe(true);
    expect(svc.dateInWindow(at, { start_date: driverDate('2026-10-20'), end_date: null })).toBe(false);
    expect(svc.dateInWindow(at, { start_date: null, end_date: driverDate('2026-10-18') })).toBe(false);
    expect(svc.dateInWindow(at, { start_date: null, end_date: driverDate('2026-10-19') })).toBe(true);
  });

  test('the window day is the firm-local calendar day, not the UTC day', () => {
    const lateEvening = new Date('2026-10-20T02:00:00Z'); // 22:00 on 10/19 in Detroit
    expect(svc.dateInWindow(lateEvening, { start_date: driverDate('2026-10-20'), end_date: null })).toBe(false);
    expect(svc.dateInWindow(lateEvening, { start_date: null, end_date: driverDate('2026-10-19') })).toBe(true);
  });

  test('NULL bounds are open ("since forever"); an unreadable bound fails closed', () => {
    const at = new Date('2026-10-19T16:00:00Z');
    expect(svc.dateInWindow(at, { start_date: null, end_date: null })).toBe(true);
    expect(svc.dateInWindow(at, { start_date: 'not a date', end_date: null })).toBe(false);
    expect(svc.dateInWindow(at, { start_date: new Date('x'), end_date: null })).toBe(false);
    expect(svc.dayOf(driverDate('2026-01-01'))).toBe('2026-01-01');
    expect(svc.dayOf('2026-01-01')).toBe('2026-01-01');
  });

  test('Logged-only bodies are found whatever case the writer used for the key', () => {
    expect(svc.logDataBody({ To: 'a', From: 'b', Message: 'ingested body', Subject: 's' })).toBe('ingested body');
    expect(svc.logDataBody({ message: 'sms body', note: 'Logged without sending' })).toBe('sms body');
    expect(svc.logDataBody({ body: 'composer body', note: 'Logged without sending' })).toBe('composer body');
    expect(svc.logDataBody({ note: 'only a note' })).toBe('only a note');
    expect(svc.logDataBody({ status: 'completed', duration_seconds: '45' })).toBeNull();
    expect(svc.logDataBody(null)).toBeNull();
  });

  test('email copies dedupe case-insensitively and prefer a logged copy', () => {
    const out = svc.dedupeMail([
      { id: 1, message_id: 'ABC@example', log_id: null },
      { id: 2, message_id: 'abc@example', log_id: 9 },
      { id: 3, message_id: null, log_id: null },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 2, dedupe_key: 'mid:abc@example', log_id: 9 });
    expect(out[0].copies.map(x => x.id)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ id: 3, dedupe_key: 'id:3' });
  });

  test('normalizes the legacy court-email type only', () => {
    expect(svc.normalizeLogKind('court email')).toBe('court');
    expect(svc.normalizeLogKind('sms')).toBe('sms');
  });

  test('rejects unknown entity types before any database access', async () => {
    await expect(svc.list({ query: jest.fn() }, { userId: 1 }, 'matter', '1'))
      .rejects.toMatchObject({ status: 400 });
  });
});
