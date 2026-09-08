/**
 * tests/contactOrgKind.test.js
 *
 * ORG-KIND CONTACTS — createContact / updateContact guards (slice 1).
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * contacts.contact_name / contact_lfm_name / contact_rname are computed by two
 * BEFORE triggers, and after m3 those triggers branch on contacts.contact_kind:
 *
 *   kind 'person' → names from contact_fname / contact_mname / contact_lname
 *   kind 'org'    → all three = contact_org_name, verbatim, no comma flip
 *
 * contact_kind is a plain varchar and this server's sql_mode has no
 * STRICT_TRANS_TABLES. So EVERY failure in this area is silent:
 *
 *   - kind 'Org' (wrong case) stores fine and falls into the person branch,
 *     computing names from blank parts.
 *   - kind 'org' with no contact_org_name stores fine and computes '' into
 *     three NOT NULL columns — and contact_lfm_name is what Dropbox foldering
 *     and document attribution read.
 *   - flipping an org back to a person with no fname/lname does the same.
 *
 * None of that raises. The service guards asserted here are the only thing
 * standing between a typo and a contact with no name anywhere in the system,
 * which is why they are pinned rather than left to review.
 *
 * ── STUB CONVENTION ────────────────────────────────────────────────────────
 *
 * Dispatch-on-SQL-text, the tests/contactTransferShapes.test.js idiom — NOT
 * the scripted-array idiom, whose failure mode (insert one query, every later
 * fixture shifts by one) is what tests/helpers/scriptGuard.js exists to catch.
 *
 *   npx jest tests/contactOrgKind.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const contactService = require('../services/contactService');

const NEW_ID = 4242;
const ORG_ID = 2056;

/**
 * `row` is what the shape pre-read and the mirror reads answer with — i.e.
 * the contact AS STORED, before the patch. Everything else answers with the
 * least interesting shape that lets the code reach its return statement.
 *
 * `inserts` captures INSERT INTO contacts so the column list and the bound
 * values can be asserted; `updates` does the same for the scalar UPDATE.
 */
function stubDb({ row = null } = {}) {
  const inserts = [];
  const updates = [];
  const seen    = [];

  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push(s);

    if (/^INSERT INTO contacts/i.test(s)) {
      inserts.push({ sql: s, params });
      return [{ insertId: NEW_ID }];
    }
    if (/^UPDATE contacts SET/i.test(s)) {
      updates.push({ sql: s, params });
      return [{ affectedRows: 1 }];
    }

    // Kind-switch shape pre-read + the post-commit re-fetches.
    if (/FROM contacts WHERE contact_id/i.test(s)) {
      return [row ? [row] : []];
    }

    if (/^INSERT INTO/i.test(s)) return [{ insertId: 900 }];
    if (/^UPDATE/i.test(s))      return [{ affectedRows: 1 }];
    return [[]];
  };

  return {
    inserts,
    updates,
    seen,
    query,
    withTransaction: async (fn) => fn({ query }),
  };
}

/** Column list → bound value, for an INSERT INTO contacts (...) VALUES (...). */
function insertMap(entry) {
  const cols = entry.sql
    .slice(entry.sql.indexOf('(') + 1, entry.sql.indexOf(')'))
    .split(',')
    .map(c => c.trim());
  const out = {};
  cols.forEach((c, i) => { out[c] = entry.params[i]; });
  return out;
}

/** Column → bound value, for `UPDATE contacts SET a = ?, b = ?, ...`. */
function updateMap(entry) {
  const cols = [...entry.sql.matchAll(/`([a-z_]+)` = \?/gi)].map(m => m[1]);
  const out = {};
  cols.forEach((c, i) => { out[c] = entry.params[i]; });
  return out;
}

// ─────────────────────────────────────────────────────────────
// createContact
// ─────────────────────────────────────────────────────────────

describe('createContact — kind gate', () => {
  test('org: writes contact_kind + contact_org_name and FORCES the name parts blank', async () => {
    const db = stubDb({ row: { contact_id: NEW_ID, contact_name: 'Legacy Signature Properties, Inc.' } });

    const out = await contactService.createContact(db, {
      kind: 'org',
      org_name: '  Legacy Signature Properties, Inc.  ',
      // Deliberate junk. An org row that keeps stale name parts shows nothing
      // on screen and everything in an export.
      fname: 'LEGACY', mname: 'SIGNATURE PROPERTIES', lname: 'INC.',
      pname: 'Legacy Properties',
    }, { userId: 1 });

    expect(out.contact_id).toBe(NEW_ID);

    const m = insertMap(db.inserts[0]);
    expect(m.contact_kind).toBe('org');
    expect(m.contact_org_name).toBe('Legacy Signature Properties, Inc.');  // trimmed
    expect(m.contact_fname).toBe('');
    expect(m.contact_mname).toBe('');
    expect(m.contact_lname).toBe('');
    // pname survives — it is DBA on an org, not a name part.
    expect(m.contact_pname).toBe('Legacy Properties');
  });

  test('org: org_name is required', async () => {
    const db = stubDb();
    await expect(
      contactService.createContact(db, { kind: 'org', org_name: '   ' }, { userId: 1 })
    ).rejects.toThrow(/org_name/i);
    expect(db.inserts).toHaveLength(0);
  });

  test('org: org_name over 120 chars is rejected, not silently truncated', async () => {
    // contact_org_name is varchar(120) and m3 widens the derived name columns
    // to match. Without STRICT_TRANS_TABLES the DB would take 121 chars and
    // quietly drop the tail into a column that feeds Dropbox folder names.
    const db = stubDb();
    await expect(
      contactService.createContact(db, { kind: 'org', org_name: 'x'.repeat(121) }, { userId: 1 })
    ).rejects.toThrow(/120/);
    expect(db.inserts).toHaveLength(0);
  });

  test('person: the existing fname+lname guard is unchanged', async () => {
    const db = stubDb();
    await expect(
      contactService.createContact(db, { lname: 'Riley' }, { userId: 1 })
    ).rejects.toThrow(/requires fname/);
    await expect(
      contactService.createContact(db, { fname: 'Alexandria' }, { userId: 1 })
    ).rejects.toThrow(/requires lname/);
  });

  test('person: default kind is person and org_name goes in blank', async () => {
    const db = stubDb({ row: { contact_id: NEW_ID, contact_name: 'Alexandria Riley' } });
    await contactService.createContact(db,
      { fname: 'Alexandria', lname: 'Riley' }, { userId: 1 });

    const m = insertMap(db.inserts[0]);
    expect(m.contact_kind).toBe('person');
    expect(m.contact_org_name).toBe('');
    expect(m.contact_fname).toBe('Alexandria');
    expect(m.contact_lname).toBe('Riley');
  });

  test('an unrecognised kind is rejected — the trigger matches "org" EXACTLY', async () => {
    const db = stubDb();
    // 'Org' would store fine and silently take the person branch.
    await expect(
      contactService.createContact(db,
        { kind: 'organization', org_name: 'Acme LLC' }, { userId: 1 })
    ).rejects.toThrow(/kind must be one of/);
    expect(db.inserts).toHaveLength(0);
  });

  test('kind is case- and whitespace-insensitive on the way in', async () => {
    const db = stubDb({ row: { contact_id: NEW_ID, contact_name: 'Acme LLC' } });
    await contactService.createContact(db, { kind: ' ORG ', org_name: 'Acme LLC' }, { userId: 1 });
    expect(insertMap(db.inserts[0]).contact_kind).toBe('org');
  });
});

// ─────────────────────────────────────────────────────────────
// updateContact
// ─────────────────────────────────────────────────────────────

describe('updateContact — kind on the whitelist', () => {
  test('both new columns are writable', async () => {
    const db = stubDb({
      row: {
        contact_kind: 'person', contact_org_name: '',
        contact_fname: 'LEGACY', contact_lname: 'INC.',
      },
    });

    const out = await contactService.updateContact(db, ORG_ID, {
      contact_kind: 'org',
      contact_org_name: 'Legacy Signature Properties, Inc.',
    }, { userId: 1 });

    expect(out.updated_fields).toEqual(expect.arrayContaining(
      ['contact_kind', 'contact_org_name']
    ));
  });

  test('person → org BLANKS the stale name parts in the same UPDATE', async () => {
    const db = stubDb({
      row: {
        contact_kind: 'person', contact_org_name: '',
        contact_fname: 'LEGACY', contact_lname: 'INC.',
      },
    });

    await contactService.updateContact(db, ORG_ID, {
      contact_kind: 'org',
      contact_org_name: 'Legacy Signature Properties, Inc.',
    }, { userId: 1 });

    const m = updateMap(db.updates[0]);
    expect(m.contact_kind).toBe('org');
    expect(m.contact_org_name).toBe('Legacy Signature Properties, Inc.');
    expect(m.contact_fname).toBe('');
    expect(m.contact_mname).toBe('');
    expect(m.contact_lname).toBe('');
    // NOT touched — Preferred Name for a person, DBA for an org.
    expect(m).not.toHaveProperty('contact_pname');
  });

  test('org → person BLANKS contact_org_name', async () => {
    const db = stubDb({
      row: {
        contact_kind: 'org', contact_org_name: 'Acme LLC',
        contact_fname: '', contact_lname: '',
      },
    });

    await contactService.updateContact(db, ORG_ID, {
      contact_kind: 'person',
      contact_fname: 'Alexandria',
      contact_lname: 'Riley',
    }, { userId: 1 });

    const m = updateMap(db.updates[0]);
    expect(m.contact_kind).toBe('person');
    expect(m.contact_org_name).toBe('');
  });

  test('→ org with no org_name anywhere is REJECTED, not written blank', async () => {
    const db = stubDb({
      row: {
        contact_kind: 'person', contact_org_name: '',
        contact_fname: 'Alexandria', contact_lname: 'Riley',
      },
    });

    await expect(
      contactService.updateContact(db, ORG_ID, { contact_kind: 'org' }, { userId: 1 })
    ).rejects.toThrow(/contact_org_name is required/);
    expect(db.updates).toHaveLength(0);
  });

  test('→ org is ALLOWED when org_name is already on the row', async () => {
    // The guard validates the RESULTING row, not the patch.
    const db = stubDb({
      row: {
        contact_kind: 'person', contact_org_name: 'Acme LLC',
        contact_fname: 'Alexandria', contact_lname: 'Riley',
      },
    });

    await contactService.updateContact(db, ORG_ID, { contact_kind: 'org' }, { userId: 1 });
    expect(updateMap(db.updates[0]).contact_kind).toBe('org');
  });

  test('→ person with no fname/lname anywhere is REJECTED', async () => {
    const db = stubDb({
      row: {
        contact_kind: 'org', contact_org_name: 'Acme LLC',
        contact_fname: '', contact_lname: '',
      },
    });

    await expect(
      contactService.updateContact(db, ORG_ID, { contact_kind: 'person' }, { userId: 1 })
    ).rejects.toThrow(/contact_fname and contact_lname are required/);
    expect(db.updates).toHaveLength(0);
  });

  test('blanking org_name on a row that IS an org is rejected', async () => {
    // No contact_kind in the patch at all — the guard still fires because
    // contact_org_name is, and the resulting row would have neither source.
    const db = stubDb({
      row: {
        contact_kind: 'org', contact_org_name: 'Acme LLC',
        contact_fname: '', contact_lname: '',
      },
    });

    await expect(
      contactService.updateContact(db, ORG_ID, { contact_org_name: '' }, { userId: 1 })
    ).rejects.toThrow(/contact_org_name is required/);
  });

  test('an unrecognised contact_kind is rejected', async () => {
    const db = stubDb({ row: { contact_kind: 'person', contact_org_name: 'Acme LLC' } });
    await expect(
      contactService.updateContact(db, ORG_ID, { contact_kind: 'ORG ' }, { userId: 1 })
    ).resolves.toBeDefined();          // 'ORG ' normalises to 'org' — accepted
    await expect(
      contactService.updateContact(db, ORG_ID, { contact_kind: 'company' }, { userId: 1 })
    ).rejects.toThrow(/contact_kind must be one of/);
  });

  test('contact_org_name over 120 chars is rejected', async () => {
    const db = stubDb({ row: { contact_kind: 'org', contact_org_name: 'Acme LLC' } });
    await expect(
      contactService.updateContact(db, ORG_ID,
        { contact_org_name: 'x'.repeat(121) }, { userId: 1 })
    ).rejects.toThrow(/120/);
  });

  test('a patch that touches neither column skips the shape pre-read entirely', async () => {
    // The guard costs a query. Ordinary field edits — the overwhelming
    // majority — must not pay for it.
    const db = stubDb({ row: { contact_kind: 'person', contact_org_name: '' } });
    await contactService.updateContact(db, ORG_ID, { contact_tags: 'vip' }, { userId: 1 });

    const shapeReads = db.seen.filter(s =>
      /SELECT contact_kind, contact_org_name, contact_fname, contact_lname/i.test(s));
    expect(shapeReads).toHaveLength(0);
  });
});
