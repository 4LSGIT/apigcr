'use strict';

const fs = require('fs');
const path = require('path');
const phoneService = require('../services/contactPhoneService');
const emailService = require('../services/contactEmailService');
const addressService = require('../services/contactAddressService');

const ROOT = path.join(__dirname, '..');

function staleDb(table, row) {
  const seen = [];
  const conn = { query: jest.fn(async (sql) => {
    seen.push(String(sql));
    if (String(sql).includes(`SELECT * FROM ${table}`)) return [[row]];
    throw new Error(`Unexpected SQL after stale check: ${sql}`);
  }) };
  return { seen, withTransaction: async (fn) => fn(conn), query: jest.fn() };
}

describe('contact subrecord optimistic concurrency', () => {
  test.each([
    ['phone', phoneService.updateContactPhone, 'contact_phones', { id: 21, contact_id: 5, phone: '2485550100', is_primary: 0, end_date: null, updated_at: new Date('2026-10-20T10:00:00.000Z') }],
    ['email', emailService.updateContactEmail, 'contact_emails', { id: 22, contact_id: 5, email: 'client@example.com', is_primary: 0, end_date: null, updated_at: new Date('2026-10-20T10:00:00.000Z') }],
    ['address', addressService.updateContactAddress, 'contact_addresses', { id: 23, contact_id: 5, address1: '1 Main', is_primary: 0, end_date: null, updated_at: new Date('2026-10-20T10:00:00.000Z') }],
  ])('%s PATCH rejects a stale reviewed version before writing', async (_family, update, table, row) => {
    const db = staleDb(table, row);
    await expect(update(db, row.id, { label: 'Work' }, { updatedBy: 7, expectedUpdatedAt: '2026-10-20T09:59:59.000Z' }))
      .rejects.toThrow(/Concurrent .* update detected/);
    expect(db.seen.some((sql) => /^\s*UPDATE/i.test(sql))).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  test.each(['Phones', 'Emails', 'Addresses'])('%s route strips the server-owned version precondition before service validation', (suffix) => {
    const source = fs.readFileSync(path.join(ROOT, `routes/api.contact${suffix}.js`), 'utf8');
    expect(source).toMatch(/const \{ expected_updated_at, expected_primary_id, \.\.\.fields \} = req\.body \|\| \{\}/);
    expect(source).toMatch(/fields, \{ updatedBy, expectedUpdatedAt: expected_updated_at, expectedPrimaryId: expected_primary_id \}/);
  });

  test('primary promotion rejects a changed current-primary set before demotion', async () => {
    const row = { id: 21, contact_id: 5, phone: '2485550100', is_primary: 0, end_date: null, updated_at: new Date('2026-10-20T10:00:00.000Z') };
    const seen = [];
    const conn = { query: jest.fn(async (sql) => {
      seen.push(String(sql));
      if (/SELECT \* FROM contact_phones/.test(sql)) return [[row]];
      if (/SELECT id FROM contact_phones/.test(sql)) return [[{ id: 99 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }) };
    const db = { withTransaction: async (fn) => fn(conn), query: jest.fn() };
    await expect(phoneService.updateContactPhone(db, 21, { is_primary: true }, {
      updatedBy: 7, expectedUpdatedAt: '2026-10-20T10:00:00.000Z', expectedPrimaryId: 88,
    })).rejects.toThrow(/Concurrent primary phone change/);
    expect(seen.some((sql) => /^\s*UPDATE/i.test(sql))).toBe(false);
  });
});
