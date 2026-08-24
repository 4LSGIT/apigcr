/**
 * tests/contactTransferShapes.test.js
 *
 * PRODUCER-SIDE CONTRACT TESTS for the two `transferred_from` payloads.
 *
 * ── WHY THIS FILE EXISTS (Slice 2c review finding) ─────────────────────────
 *
 * A cross-contact transfer moves a phone or email row OFF a donor contact. The
 * donor's change is an ABSENCE, so there is no `{column: value}` to broadcast;
 * the sync bus instead announces `{yc_refetch:1}` to `contact:<donor>`, and it
 * finds the donor id by reading `transferred_from` out of the response.
 *
 * There are TWO endpoints that transfer, and — the trap — TWO SHAPES:
 *
 *   PATCH /api/contacts/:id?force=true        (the aggregate contact-form save)
 *     data.transferred_from = [ { kind, from_contact_id, … } ]     ARRAY
 *                                               ^^^^^^^^^^^^^^^
 *
 *   POST  /api/contact-{phones,emails}?force=true      (the revive-a-row flow)
 *          transferred_from = { contact_id, … }        SINGULAR OBJECT
 *                               ^^^^^^^^^^
 *
 * Top-level vs nested, array vs object, and `contact_id` vs `from_contact_id`.
 * A getter written for one and pointed at the other reads `undefined` and
 * SILENTLY ANNOUNCES NOTHING — no error, no log, just a donor contact left
 * showing a phone number it no longer owns.
 *
 * Until now both shapes were pinned CLIENT-side only (tests/ycSync.test.js's
 * revive-matcher block asserts the bus reads them correctly). That catches a
 * bus regression and nothing else: if a SERVICE ever renames its key or
 * switches array↔object, every one of those tests still passes against its own
 * hand-written fixture while production goes quiet. These assertions live at
 * the producer so that drift breaks HERE, next to the code that moved.
 *
 * ── STUB CONVENTION ────────────────────────────────────────────────────────
 *
 * Dispatch-on-SQL-text, the tests/taskService*.test.js idiom — deliberately
 * NOT the scripted-array idiom, whose whole failure mode (insert one query and
 * every later fixture shifts by one) is what tests/helpers/scriptGuard.js
 * exists to catch. A dispatch stub is order-independent and cannot drift.
 *
 *   npx jest tests/contactTransferShapes.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const contactService      = require('../services/contactService');
const contactPhoneService = require('../services/contactPhoneService');
const contactEmailService = require('../services/contactEmailService');

const RECIPIENT = 5;
const DONOR     = 77;
const PHONE     = '2485551212';
const EMAIL     = 'moved@example.com';

/**
 * One dispatch stub for every query either path can run.
 *
 * `collision` is the row the uniqueness check finds on the DONOR — the whole
 * point of the exercise. Everything else answers with the least interesting
 * shape that lets the code reach its return statement.
 */
function stubDb({ collision = null } = {}) {
  const seen = [];

  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);

    // ── the cross-contact collision lookups (both paths) ──
    if (/FROM contact_phones cp JOIN contacts c/i.test(s) ||
        /FROM contact_emails ce JOIN contacts c/i.test(s)) {
      return [collision ? [collision] : []];
    }

    // ── contact existence / mirror reads ──
    if (/SELECT contact_id FROM contacts WHERE contact_id/i.test(s)) {
      return [[{ contact_id: RECIPIENT }]];
    }
    if (/SELECT contact_phone FROM contacts/i.test(s)) return [[{ contact_phone: '' }]];
    if (/SELECT contact_email FROM contacts/i.test(s)) return [[{ contact_email: '' }]];

    // ── mirror recompute child lookups ──
    if (/SELECT phone FROM contact_phones/i.test(s)) return [[]];
    if (/SELECT email FROM contact_emails/i.test(s)) return [[]];

    // ── current active rows for the aggregate planner (none) ──
    if (/SELECT id, phone, label/i.test(s)) return [[]];
    if (/SELECT id, email, label/i.test(s)) return [[]];

    if (/SELECT COUNT\(\*\) AS cnt/i.test(s)) return [[{ cnt: 0 }]];

    if (/^INSERT INTO/i.test(s)) return [{ insertId: 900 }];
    if (/^UPDATE/i.test(s))      return [{ affectedRows: 1 }];

    // Post-commit re-fetch with joins (getContactPhone / getContactEmail).
    if (/FROM contact_phones/i.test(s)) return [[{ id: 900, contact_id: RECIPIENT, phone: PHONE }]];
    if (/FROM contact_emails/i.test(s)) return [[{ id: 900, contact_id: RECIPIENT, email: EMAIL }]];

    return [[]];
  };

  return {
    seen,
    query,
    withTransaction: async (fn) => fn({ query }),
  };
}

// ─────────────────────────────────────────────────────────────
// The PATCH path — ARRAY of entries keyed from_contact_id
// ─────────────────────────────────────────────────────────────

describe('PATCH /api/contacts/:id?force=true — transferred_from is an ARRAY', () => {
  test('phones: entries carry from_contact_id and kind', async () => {
    const db = stubDb({
      collision: { phone_id: 91, contact_id: DONOR, phone: PHONE, contact_name: 'Donor Dave' },
    });

    const resp = await contactService.updateContact(
      db, RECIPIENT, { phones: [{ phone: PHONE, label: 'Mobile' }] },
      { userId: 1, force: true }
    );

    // THE SHAPE. Array, not object — yc-sync's contacts matcher iterates it.
    expect(Array.isArray(resp.transferred_from)).toBe(true);
    expect(resp.transferred_from).toHaveLength(1);

    // THE KEY. `from_contact_id`, NOT `contact_id`. The revive path uses the
    // other name; a getter copied between them reads undefined and announces
    // nothing. This assertion is the whole reason the file exists.
    expect(resp.transferred_from[0].from_contact_id).toBe(DONOR);
    expect(resp.transferred_from[0]).not.toHaveProperty('contact_id');
    expect(resp.transferred_from[0].kind).toBe('phone');
  });

  test('emails: same array shape, same key, kind switches', async () => {
    const db = stubDb({
      collision: { email_id: 91, contact_id: DONOR, email: EMAIL, contact_name: 'Donor Dave' },
    });

    const resp = await contactService.updateContact(
      db, RECIPIENT, { emails: [{ email: EMAIL, label: 'Personal' }] },
      { userId: 1, force: true }
    );

    expect(Array.isArray(resp.transferred_from)).toBe(true);
    expect(resp.transferred_from[0].from_contact_id).toBe(DONOR);
    expect(resp.transferred_from[0].kind).toBe('email');
  });

  test('NESTING: the route nests this under `data` — it is not top-level here', async () => {
    // routes/api.contacts.js answers `{status, data: <this object>}`. yc-sync's
    // contacts matcher therefore reads `r.data.transferred_from`, and its
    // revive sibling reads `r.transferred_from`. Pinning the service's own
    // return keeps that asymmetry deliberate rather than accidental.
    const db = stubDb({
      collision: { phone_id: 91, contact_id: DONOR, phone: PHONE, contact_name: 'Donor Dave' },
    });
    const resp = await contactService.updateContact(
      db, RECIPIENT, { phones: [{ phone: PHONE }] }, { userId: 1, force: true }
    );
    // The service returns the object the route puts under `data`.
    expect(resp).toHaveProperty('contact_id', RECIPIENT);
    expect(resp).toHaveProperty('transferred_from');
  });

  test('no collision → the key is ABSENT, not an empty array', async () => {
    // yc-sync guards with Array.isArray, so an empty array would be harmless —
    // but absence is what ships today and a change either way should be seen.
    const db = stubDb({ collision: null });
    const resp = await contactService.updateContact(
      db, RECIPIENT, { phones: [{ phone: PHONE }] }, { userId: 1, force: true }
    );
    expect(resp).not.toHaveProperty('transferred_from');
  });
});

// ─────────────────────────────────────────────────────────────
// The revive path — SINGULAR OBJECT keyed contact_id
// ─────────────────────────────────────────────────────────────

describe('POST /api/contact-{phones,emails}?force=true — transferred_from is an OBJECT', () => {
  test('phones: a singular object keyed contact_id', async () => {
    const db = stubDb({
      collision: { phone_id: 91, contact_id: DONOR, contact_name: 'Donor Dave' },
    });

    const result = await contactPhoneService.createContactPhone(
      db, RECIPIENT, { phone: PHONE, label: 'Mobile' }, { force: true, createdBy: 1 }
    );

    // THE SHAPE. Object, NOT an array — yc-sync's reviveDonorGetter fails
    // closed on an array precisely because that would mean this contract moved.
    expect(Array.isArray(result.transferred_from)).toBe(false);
    expect(typeof result.transferred_from).toBe('object');

    // THE KEY. `contact_id`, NOT `from_contact_id`.
    expect(result.transferred_from.contact_id).toBe(DONOR);
    expect(result.transferred_from).not.toHaveProperty('from_contact_id');
  });

  test('emails: identical shape and key', async () => {
    const db = stubDb({
      collision: { email_id: 91, contact_id: DONOR, contact_name: 'Donor Dave' },
    });

    const result = await contactEmailService.createContactEmail(
      db, RECIPIENT, { email: EMAIL, label: 'Personal' }, { force: true, createdBy: 1 }
    );

    expect(Array.isArray(result.transferred_from)).toBe(false);
    expect(result.transferred_from.contact_id).toBe(DONOR);
    expect(result.transferred_from).not.toHaveProperty('from_contact_id');
  });

  test('TOP LEVEL: the route does not nest this one under `data`', async () => {
    // routes/api.contactPhones.js spreads the service result into the 201 body,
    // so `transferred_from` sits at the top. The sibling PATCH path nests.
    // Same information, two positions — the asymmetry yc-sync has to know.
    const db = stubDb({
      collision: { phone_id: 91, contact_id: DONOR, contact_name: 'Donor Dave' },
    });
    const result = await contactPhoneService.createContactPhone(
      db, RECIPIENT, { phone: PHONE }, { force: true, createdBy: 1 }
    );
    expect(result).toHaveProperty('phone');            // the created row
    expect(result).toHaveProperty('transferred_from'); // beside it, not inside
    expect(result.data).toBeUndefined();
  });

  test('no collision → the key is ABSENT', async () => {
    const db = stubDb({ collision: null });
    const result = await contactPhoneService.createContactPhone(
      db, RECIPIENT, { phone: PHONE }, { force: true, createdBy: 1 }
    );
    expect(result).not.toHaveProperty('transferred_from');
  });
});
