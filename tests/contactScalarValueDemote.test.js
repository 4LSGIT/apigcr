/**
 * tests/contactScalarValueDemote.test.js
 *
 * PINS the scalar contact_phone / contact_email propagators' "demote, don't
 * end" behavior (services/contactService.js _propagatePhone/_propagateEmail).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * A scalar write means "use this value now", NOT "the old value is dead". The
 * hot caller is unattended: services/intakeService.js (behind intake_contact
 * and POST /api/intake/contact) matches a website submission to an existing
 * contact by ONE of phone/email, then writes BOTH. Under the old behavior a
 * web form that supplied a new mobile ENDED the number of record — a number
 * that inbound calls and SMS still arrive on and still have to attribute.
 *
 * The replacement rule has a second half that is easy to lose: because
 * demoted rows stay ACTIVE, and uk_phone_active / uk_email_active are UNIQUE
 * on (value WHERE end_date IS NULL) TABLE-WIDE, going A → B → A through the
 * scalar path must PROMOTE the row already there. INSERTing instead throws
 * ER_DUP_ENTRY, which the propagator's catch block reports as a spurious
 * "concurrent update — refresh and retry". That path is asserted below.
 *
 * ── STUB CONVENTION ────────────────────────────────────────────────────────
 *
 * Dispatch-on-SQL-text, per tests/contactTransferShapes.test.js — the two
 * child-table SELECTs are told apart by the `AND phone = ?` / `AND email = ?`
 * clause the re-adopt lookup carries and the primary lookup does not.
 *
 *   npx jest tests/contactScalarValueDemote.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const contactService = require('../services/contactService');

const CID       = 42;
const OLD_PHONE = '2485551111';
const NEW_PHONE = '3135552222';
const OLD_EMAIL = 'old@example.com';
const NEW_EMAIL = 'new@example.com';

/**
 * @param {object}      opts
 * @param {object|null} opts.primary   - the primary-active child row, if any
 * @param {object|null} opts.readopt   - active non-primary row holding the
 *                                       INCOMING value (the A → B → A case)
 * @param {object|null} opts.collision - another contact's active claim
 */
function stubDb({ primary = null, readopt = null, collision = null } = {}) {
  const writes = [];   // { sql, params } for every INSERT/UPDATE
  const seen   = [];

  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);
    if (/^(INSERT|UPDATE)/i.test(s)) writes.push({ sql: s, params });

    // The contacts scalar UPDATE / existence probe.
    if (/^UPDATE contacts SET/i.test(s))                        return [{ affectedRows: 1 }];
    if (/SELECT contact_id FROM contacts WHERE contact_id/i.test(s)) return [[{ contact_id: CID }]];

    // Mirror reads — report the OLD value so recompute always writes.
    if (/SELECT contact_phone FROM contacts/i.test(s)) return [[{ contact_phone: OLD_PHONE }]];
    if (/SELECT contact_email FROM contacts/i.test(s)) return [[{ contact_email: OLD_EMAIL }]];

    // Re-adopt lookup — carries `AND phone = ?` / `AND email = ?`.
    if (/FROM contact_phones WHERE contact_id = \? AND phone = \?/i.test(s) ||
        /FROM contact_emails WHERE contact_id = \? AND email = \?/i.test(s)) {
      return [readopt ? [readopt] : []];
    }

    // Primary-active lookup (SELECT id, phone|email …).
    if (/SELECT id, phone FROM contact_phones/i.test(s) ||
        /SELECT id, email FROM contact_emails/i.test(s)) {
      return [primary ? [primary] : []];
    }

    // Cross-contact collision check.
    if (/FROM contact_phones WHERE phone = \?/i.test(s) ||
        /FROM contact_emails WHERE email = \?/i.test(s)) {
      return [collision ? [collision] : []];
    }

    // Mirror recompute child read.
    if (/SELECT phone FROM contact_phones/i.test(s)) return [[{ phone: NEW_PHONE }]];
    if (/SELECT email FROM contact_emails/i.test(s)) return [[{ email: NEW_EMAIL }]];

    // resolveStartDate's history probe.
    if (/end_date/i.test(s) && /^SELECT/i.test(s)) return [[]];

    if (/^INSERT INTO/i.test(s)) return [{ insertId: 900 }];
    if (/^UPDATE/i.test(s))      return [{ affectedRows: 1 }];
    return [[]];
  };

  return { seen, writes, query, withTransaction: async (fn) => fn({ query }) };
}

const childWrites = (db, table) =>
  db.writes.filter(w => new RegExp(`contact_${table}`, 'i').test(w.sql));

describe('scalar contact_phone → demote, do not end', () => {
  test('the outgoing primary is demoted with end_date untouched', async () => {
    const db = stubDb({ primary: { id: 7, phone: OLD_PHONE } });

    await contactService.updateContact(db, CID, { contact_phone: NEW_PHONE }, { userId: 3 });

    const demote = childWrites(db, 'phones')
      .find(w => /^UPDATE/i.test(w.sql) && /is_primary = 0/.test(w.sql));

    expect(demote).toBeDefined();
    // THE ASSERTION. Not `end_date = CURDATE()`, not `end_reason`.
    expect(demote.sql).not.toMatch(/end_date/);
    expect(demote.sql).not.toMatch(/end_reason/);
    expect(demote.params).toEqual([3, 7]);
  });

  test("no scalar write ever stamps end_reason 'replaced' again", async () => {
    const db = stubDb({ primary: { id: 7, phone: OLD_PHONE } });
    await contactService.updateContact(db, CID, { contact_phone: NEW_PHONE }, { userId: 3 });
    expect(db.writes.some(w => /'replaced'/.test(w.sql))).toBe(false);
  });

  test('the incoming value still lands as a new primary-active row', async () => {
    const db = stubDb({ primary: { id: 7, phone: OLD_PHONE } });
    await contactService.updateContact(db, CID, { contact_phone: NEW_PHONE }, { userId: 3 });

    const insert = childWrites(db, 'phones').find(w => /^INSERT INTO/i.test(w.sql));
    expect(insert).toBeDefined();
    expect(insert.params).toContain(NEW_PHONE);
  });

  test('re-adopting a demoted-but-active number PROMOTES it (never INSERTs)', async () => {
    // A → B → A. Row 7 is the current primary (B); row 4 still holds A,
    // active and demoted. A second active row for A would hit uk_phone_active.
    const db = stubDb({
      primary: { id: 7, phone: NEW_PHONE },
      readopt: { id: 4 },
    });

    await contactService.updateContact(db, CID, { contact_phone: OLD_PHONE }, { userId: 3 });

    const promote = childWrites(db, 'phones')
      .find(w => /^UPDATE/i.test(w.sql) && /is_primary = 1/.test(w.sql));
    expect(promote).toBeDefined();
    expect(promote.params).toEqual([3, 4]);

    expect(childWrites(db, 'phones').some(w => /^INSERT INTO/i.test(w.sql))).toBe(false);
  });

  test('clearing the scalar to empty still ENDS the row — removal stays explicit', async () => {
    const db = stubDb({ primary: { id: 7, phone: OLD_PHONE } });

    await contactService.updateContact(db, CID, { contact_phone: '' }, { userId: 3 });

    const ended = childWrites(db, 'phones')
      .find(w => /^UPDATE/i.test(w.sql) && /end_reason = 'ended'/.test(w.sql));
    expect(ended).toBeDefined();
    expect(ended.sql).toMatch(/end_date = CURDATE\(\)/);
  });

  test('a cross-contact collision still transfers (donor ends yesterday)', async () => {
    const db = stubDb({
      primary:   { id: 7, phone: OLD_PHONE },
      collision: { id: 91, contact_id: 77 },
    });

    await contactService.updateContact(db, CID, { contact_phone: NEW_PHONE }, { userId: 3 });

    const donorEnd = childWrites(db, 'phones')
      .find(w => /end_reason = 'transferred'/.test(w.sql));
    expect(donorEnd).toBeDefined();
    expect(donorEnd.sql).toMatch(/DATE_SUB\(CURDATE\(\), INTERVAL 1 DAY\)/);
  });
});

describe('scalar contact_email → same rule', () => {
  test('the outgoing primary is demoted, not ended', async () => {
    const db = stubDb({ primary: { id: 11, email: OLD_EMAIL } });

    await contactService.updateContact(db, CID, { contact_email: NEW_EMAIL }, { userId: 3 });

    const demote = childWrites(db, 'emails')
      .find(w => /^UPDATE/i.test(w.sql) && /is_primary = 0/.test(w.sql));

    expect(demote).toBeDefined();
    expect(demote.sql).not.toMatch(/end_date/);
    expect(demote.params).toEqual([3, 11]);
  });

  test('re-adopting an active address promotes it', async () => {
    const db = stubDb({
      primary: { id: 11, email: NEW_EMAIL },
      readopt: { id: 6 },
    });

    await contactService.updateContact(db, CID, { contact_email: OLD_EMAIL }, { userId: 3 });

    const promote = childWrites(db, 'emails')
      .find(w => /^UPDATE/i.test(w.sql) && /is_primary = 1/.test(w.sql));
    expect(promote).toBeDefined();
    expect(promote.params).toEqual([3, 6]);
    expect(childWrites(db, 'emails').some(w => /^INSERT INTO/i.test(w.sql))).toBe(false);
  });
});
