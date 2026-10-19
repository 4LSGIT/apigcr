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
