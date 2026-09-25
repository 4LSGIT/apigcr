/**
 * tests/updateContactFnDelegation.test.js
 *
 * CUSTOM-FIELDS S0 — `update_contact` delegates to contactService.updateContact.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `fns.update_contact` used to compose its own `UPDATE contacts SET ...`. Every
 * automation contact write therefore bypassed the service: no blank-date
 * coercion, no phone/email normalization, no mirror propagation to the child
 * phone/email/address rows, no contact.updated emission. The custom-fields arc
 * needs ONE writer per entity before field storage can move underneath callers,
 * so the function is now a thin adapter — and "thin adapter" is a claim that
 * rots the moment someone re-adds a shortcut here.
 *
 * What is pinned, and why each one would fail silently otherwise:
 *
 *   - Delegation is asserted through SERVICE-ONLY SIGNATURES in the emitted
 *     SQL, not by spying on the service. `contact_dob: ''` binding as NULL and
 *     `contact_phone` reaching contact_phones are things the old inline UPDATE
 *     could not do; if someone reinstates raw SQL here, both stop happening
 *     and no other test notices.
 *   - contact_ssn is an ORDINARY writable column, and is pinned as such. It
 *     was stripped here for about ten minutes on 2026-09-24; Fred reversed it
 *     (a bankruptcy firm puts the SSN on Form 121 and staff read it all day).
 *     Pinned so the next reader does not "harden" it back by reflex. What
 *     stays closed is elsewhere and narrower: domainEvents strips SSN from
 *     envelopes, which persist independently of the contact, and portal cards
 *     may never carry it — those go to clients, not staff.
 *   - The scalar-only gate: the service hands phones/emails/addresses arrays to
 *     the aggregate reconcilers, which END child rows. Nothing could reach that
 *     path from a workflow before this slice, and a missing gate here would
 *     open it silently.
 *   - wf37 step 28 writes the contact's Clio id through this function and
 *     step 8 reads it back (the only automation caller of update_contact as
 *     of 2026-09-24). Pinned by shape. Custom fields S5-A repointed both
 *     steps onto `cf_clio_id`: the `contact_clio_id` column is FROZEN at the
 *     chokepoint from 2026-09-25 and dropped in S5-B, so the pin now covers
 *     BOTH halves — the cf_ write lands, and the old column's write is
 *     refused with an error naming the cf_ key.
 *
 * ── STUB CONVENTION ────────────────────────────────────────────────────────
 *
 * Dispatch-on-SQL-text, the tests/contactOrgKind.test.js idiom. The function
 * under test and the service both run for real; only the DB is stubbed.
 *
 *   npx jest tests/updateContactFnDelegation.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const fns = require('../lib/internal_functions/contacts');

const CID = 3175;

/**
 * `row` is the contact AS STORED — what the kind-switch shape pre-read and the
 * post-commit re-fetches answer with. `phoneRows` lets one test answer the
 * cross-contact collision probe in _propagatePhone; everything else answers
 * with the least interesting shape that lets the code reach its return.
 */
function stubDb({ row = null, collision = null, defs = [] } = {}) {
  const updates = [];
  const seen    = [];

  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);

    // The custom-fields registry (S2+). Empty by default — only the S5 tests
    // below need a def, and an empty registry is what every other test here
    // assumes when it sends core columns.
    if (/FROM field_defs WHERE entity = \?/.test(s)) {
      return [defs.filter(d => d.entity === params[0])];
    }

    if (/^UPDATE contacts SET/i.test(s)) {
      updates.push({ sql: s, params });
      // Honest about a missing row: the service's own not-found throw keys on
      // affectedRows, so a stub that always says 1 would hide it.
      return [{ affectedRows: row ? 1 : 0 }];
    }

    // Cross-contact claim probe inside _propagatePhone.
    if (/FROM contact_phones cp JOIN contacts c/i.test(s)) {
      return [collision ? [collision] : []];
    }

    // Kind-switch shape pre-read, the scalar existence check, and the
    // post-commit event/Google re-fetches.
    if (/FROM contacts WHERE contact_id/i.test(s)) {
      return [row ? [row] : []];
    }

    if (/^INSERT INTO/i.test(s)) return [{ insertId: 900 }];
    if (/^UPDATE/i.test(s))      return [{ affectedRows: 1 }];
    return [[]];
  };

  return {
    updates,
    seen,
    query,
    withTransaction: async (fn) => fn({ query }),
  };
}

const PERSON = {
  contact_id: CID,
  contact_kind: 'person', contact_org_name: '',
  contact_fname: 'Alexandria', contact_lname: 'Riley',
};

/** Column → bound value, for `UPDATE contacts SET a = ?, b = ?, ...`. */
function updateMap(entry) {
  const cols = [...entry.sql.matchAll(/`([a-z_0-9]+)` = \?/gi)].map(m => m[1]);
  const out = {};
  cols.forEach((c, i) => { out[c] = entry.params[i]; });
  return out;
}

// ─────────────────────────────────────────────────────────────
// param contract — unchanged from the pre-delegation function
// ─────────────────────────────────────────────────────────────

describe('update_contact — param contract', () => {
  test('contact_id is required', async () => {
    await expect(fns.update_contact({ fields: { contact_type: 'Client' } }, stubDb()))
      .rejects.toThrow('update_contact requires contact_id');
  });

  test('fields must be a non-empty object', async () => {
    const db = stubDb({ row: PERSON });
    await expect(fns.update_contact({ contact_id: CID }, db))
      .rejects.toThrow('update_contact requires a non-empty fields object');
    await expect(fns.update_contact({ contact_id: CID, fields: {} }, db))
      .rejects.toThrow('update_contact requires a non-empty fields object');
    expect(db.updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// delegation — asserted through service-only signatures
// ─────────────────────────────────────────────────────────────

describe('update_contact — delegates to contactService.updateContact', () => {
  test("contact_dob: '' binds as NULL — blankDatesToNull ran", async () => {
    // The old inline UPDATE bound '' straight through, which lands as
    // '0000-00-00' under this server's non-strict sql_mode and is then
    // indistinguishable from a real 1899-11-30 birthday. Two rows already had
    // it. Only the service path coerces it.
    const db = stubDb({ row: PERSON });

    await fns.update_contact({ contact_id: CID, fields: { contact_dob: '' } }, db);

    expect(db.updates).toHaveLength(1);
    expect(updateMap(db.updates[0]).contact_dob).toBeNull();
  });

  test('contact_phone is normalized AND propagated to contact_phones', async () => {
    // Two service-only behaviours in one write: normalizePhone on the scalar,
    // and the legacy→child mirror propagation the inline UPDATE never did.
    const db = stubDb({ row: PERSON });

    await fns.update_contact(
      { contact_id: CID, fields: { contact_phone: '(313) 555-0142' } }, db);

    expect(updateMap(db.updates[0]).contact_phone).toBe('3135550142');
    expect(db.seen.some(s => /contact_phones/i.test(s))).toBe(true);
  });

  test('updated_fields comes from the service, including columns the guard added', async () => {
    // person → org blanks the outgoing kind's name parts in the same UPDATE, so
    // the service applied three columns the caller never named. Reporting the
    // caller's keys here would under-report the write.
    const db = stubDb({ row: PERSON });

    const out = await fns.update_contact({
      contact_id: CID,
      fields: { contact_kind: 'org', contact_org_name: 'Acme LLC' },
    }, db);

    expect(out.success).toBe(true);
    expect(out.output.contact_id).toBe(CID);
    expect(out.output.updated_fields).toEqual(expect.arrayContaining([
      'contact_kind', 'contact_org_name',
      'contact_fname', 'contact_mname', 'contact_lname',
    ]));
  });

  test('a missing contact still throws "not found"', async () => {
    await expect(
      fns.update_contact({ contact_id: 999999, fields: { contact_tags: 'vip' } },
        stubDb({ row: null }))
    ).rejects.toThrow(`Contact ${999999} not found`);
  });
});

// ─────────────────────────────────────────────────────────────
// contact_ssn — stripped, silently
// ─────────────────────────────────────────────────────────────

describe('update_contact — contact_ssn is an ordinary writable column', () => {
  test('SSN lands on the row alongside its siblings', async () => {
    // Reversed 2026-09-24: this function briefly stripped contact_ssn. A strip
    // re-added here fails this test, which is the point of pinning it.
    const db = stubDb({ row: PERSON });

    const out = await fns.update_contact({
      contact_id: CID,
      fields: { contact_ssn: '123-45-6789', contact_tags: 'intake-complete' },
    }, db);

    const m = updateMap(db.updates[0]);
    expect(m.contact_ssn).toBe('123-45-6789');
    expect(m.contact_tags).toBe('intake-complete');
    expect(out.output.updated_fields).toEqual(['contact_ssn', 'contact_tags']);
  });

  test('SSN on its own is a complete write, not an empty one', async () => {
    const db = stubDb({ row: PERSON });

    const out = await fns.update_contact(
      { contact_id: CID, fields: { contact_ssn: '123456789' } }, db);

    expect(db.updates).toHaveLength(1);
    expect(updateMap(db.updates[0]).contact_ssn).toBe('123456789');
    expect(out.output.updated_fields).toEqual(['contact_ssn']);
  });

  test('the caller’s params object is not mutated', async () => {
    // The old inline function assigned back into `fields`; neither this
    // adapter nor the service may.
    const params = { contact_id: CID, fields: { contact_kind: ' ORG ', contact_org_name: 'Acme LLC' } };
    await fns.update_contact(params, stubDb({ row: PERSON }));
    expect(params.fields.contact_kind).toBe(' ORG ');
  });
});

// ─────────────────────────────────────────────────────────────
// scalar-only surface
// ─────────────────────────────────────────────────────────────

describe('update_contact — aggregates are rejected', () => {
  test.each([
    ['phones',    { phones: [] }],
    ['emails',    { emails: [{ email: 'a@b.co' }] }],
    ['addresses', { addresses: [] }],
  ])('%s is refused before anything is written', async (_label, extra) => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_tags: 'vip', ...extra } }, db)
    ).rejects.toThrow(/not supported here .* scalar columns only/);
    expect(db.updates).toHaveLength(0);
  });

  test('an aggregate array is reported even when it is the only key', async () => {
    // The error names the real problem rather than falling through to the
    // service's generic whitelist message.
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { phones: [] } }, db)
    ).rejects.toThrow(/phones not supported here/);
  });
});

// ─────────────────────────────────────────────────────────────
// guards now owned by the service
// ─────────────────────────────────────────────────────────────

describe('update_contact — service-side guards still fire through the fn', () => {
  test('an unknown column is still blocked', async () => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_bogus: 'x' } }, db)
    ).rejects.toThrow(/blocked columns: contact_bogus/);
    expect(db.updates).toHaveLength(0);
  });

  test('contact_id itself is still blocked', async () => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_id: 1 } }, db)
    ).rejects.toThrow(/blocked columns: contact_id/);
  });

  test('a bad contact_kind is rejected — the triggers match "org" EXACTLY', async () => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_kind: 'organization' } }, db)
    ).rejects.toThrow(/contact_kind must be one of/);
    expect(db.updates).toHaveLength(0);
  });

  test('→ org with no org_name anywhere is rejected, not written blank', async () => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_kind: 'org' } }, db)
    ).rejects.toThrow(/contact_org_name is required/);
  });

  test('contact_notes over the cap is rejected, not silently truncated', async () => {
    const db = stubDb({ row: PERSON });
    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_notes: 'x'.repeat(10001) } }, db)
    ).rejects.toThrow(/10,000/);
  });

  test('a cross-contact phone claim throws — force is left false on purpose', async () => {
    // NEW failure mode for automations, and deliberate: the alternative
    // (force: true) would silently end another contact's phone row.
    const db = stubDb({
      row: PERSON,
      collision: { id: 77, contact_id: 4242, contact_name: 'Someone Else' },
    });

    await expect(
      fns.update_contact({ contact_id: CID, fields: { contact_phone: '3135550142' } }, db)
    ).rejects.toThrow(/Cross-contact conflict/);
  });
});

// ─────────────────────────────────────────────────────────────
// wf37 — the one live automation caller
// ─────────────────────────────────────────────────────────────

describe('update_contact — wf37 step 28 shape (S5: the Clio id is a custom field)', () => {
  // Custom fields S5-A (2026-09-25) moved the Clio id out of the
  // `contact_clio_id` column and into the registry as `cf_clio_id`; wf37 step
  // 28 was repointed with it and step 8 now reads the cf_ column back. The
  // column still exists and still reads through the soak, but it is FROZEN —
  // see ref/CUSTOM_FIELDS_DESIGN.md §7 S5 and tests/customFields.s5.test.js.
  const CLIO_DEF = {
    id: 2, entity: 'contact', field_key: 'cf_clio_id', label: 'Clio Contact ID',
    field_type: 'text', options: null, validation: null, show_when: null,
    indexed: 0, sort_order: 10, active: 1,
  };

  test('{cf_clio_id} lands in the custom bag and comes back in updated_fields', async () => {
    const db = stubDb({ row: PERSON, defs: [CLIO_DEF] });

    const out = await fns.update_contact(
      { contact_id: CID, fields: { cf_clio_id: 'clio-88213' } }, db);

    // One UPDATE, the value inside the single JSON_SET clause — never a
    // read-modify-write of the bag (design doc §3).
    const { sql, params } = db.updates[0];
    expect(sql).toContain('`custom` = JSON_SET(`custom`, ?, CAST(? AS JSON))');
    expect(params).toEqual(expect.arrayContaining(['$.cf_clio_id', '"clio-88213"']));
    expect(out.output.updated_fields).toEqual(['cf_clio_id']);
    // The kind guard costs a pre-read; an ordinary field edit must not pay it.
    expect(db.seen.filter(s =>
      /SELECT contact_kind, contact_org_name, contact_fname, contact_lname/i.test(s)
    )).toHaveLength(0);
  });

  test('{contact_clio_id} is now REFUSED, with an error naming the cf_ key', async () => {
    // The freeze, from the automation's side: the old shape must fail loudly
    // rather than write a column nothing reads any more.
    const db = stubDb({ row: PERSON, defs: [CLIO_DEF] });

    await expect(fns.update_contact(
      { contact_id: CID, fields: { contact_clio_id: 'clio-88213' } }, db)
    ).rejects.toThrow(/"contact_clio_id" is retired — write "cf_clio_id" instead/);

    expect(db.updates).toHaveLength(0);
  });
});
