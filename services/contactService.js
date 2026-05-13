// services/contactService.js
//
/**
 * Contact Service
 * services/contactService.js
 *
 * CRUD for the contacts table. The "get one" function returns the
 * contact plus all related entities (cases, appts, tasks, log, sequences,
 * phones, emails, addresses).
 *
 * Important:
 *   - contact_name, contact_lfm_name, contact_rname are trigger-computed
 *     from fname/mname/lname — never write to them directly
 *   - contact_ssn is NEVER returned by any function in this service
 *   - The after_contact_update trigger auto-logs changes — don't double-log
 *   - contact_phone is char(10) — normalize input (strip formatting)
 *   - contact_email is lowercased on write — equality is case-insensitive
 *
 * Slice-2 dual-write:
 *   - contact_phone   writes propagate to contact_phones
 *   - contact_email   writes propagate to contact_emails
 *   - contact_address/city/state/zip writes propagate to contact_addresses
 *   - contact_phone2 / contact_email2 are NOT propagated (vestigial; new
 *     code should use the child-table endpoints to add secondary numbers)
 *
 * Slice-3 Stage A: PATCH /api/contacts/:id now accepts nested
 *   `phones` / `emails` / `addresses` arrays alongside scalar fields and
 *   reconciles them transactionally. See _planPhones / _applyPhonePlan
 *   (and the parallel email/address helpers) below. When an aggregate
 *   array is provided for a kind, the legacy single-value propagator for
 *   that kind is SKIPPED — the reconciler is the source of truth.
 *
 * Dual-write asymmetry vs. the new POST /api/contact-{phones,emails,addresses}
 * routes:
 *   - LEGACY propagation (via this service) for phones/emails always behaves
 *     as force=true for global active-uniqueness collisions — the legacy
 *     form has no UI surface to confirm a transfer, so silently transferring
 *     is the only workable default. Addresses have no collision logic in
 *     either path (multiple contacts may share an address).
 *   - NEW direct phone/email API defaults to force=false and returns 409
 *     with a conflict payload; caller opts in via ?force=true. This
 *     asymmetry is intentional and load-bearing.
 *   - AGGREGATE PATCH route (Slice 3 Stage A) defaults to force=false and
 *     surfaces conflicts as a 409 with a structured `conflicts` array so
 *     the UI can offer a transfer-confirmation modal. Same opt-in via
 *     ?force=true; one flag covers all conflicts in the payload.
 *
 * Address propagation shape diverges from phone/email: the legacy form
 * sends partial updates (e.g. {contact_city: 'Detroit'} alone), and
 * addresses are EDITED IN PLACE on the primary-active row rather than
 * ended-and-re-inserted. The "moved vs typo" ambiguity makes this the
 * right default; phone/email get end+insert because their values
 * function as identifiers.
 *
 * Usage:
 *   const contactService = require('../services/contactService');
 *   const { contact, cases, appts, tasks, log } = await contactService.getContact(db, 123);
 */
const {
  recomputePrimaryPhone,
  recomputePrimaryEmail,
  recomputePrimaryAddress,
} = require('../lib/contactMirror');

const phoneSvc = require('./contactPhoneService');
const emailSvc = require('./contactEmailService');
const addrSvc  = require('./contactAddressService');

const DEFAULT_LOG_LIMIT = 200;
const SSN_COLUMN = 'contact_ssn';

/**
 * Strip SSN from a contact row or array of rows.
 */
function stripSsn(row) {
  if (!row) return row;
  if (Array.isArray(row)) return row.map(r => stripSsn(r));
  const { [SSN_COLUMN]: _ssn, ...clean } = row;
  return clean;
}

/**
 * Normalize a phone number to 10 digits.
 * Strips +1 prefix, parentheses, dashes, dots, spaces.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Normalize an email: trim + lowercase. Matches contactEmailService's
 * normalization so the legacy column and the child row stay in sync.
 */
function normalizeEmail(email) {
  if (!email && email !== 0) return '';
  return String(email).trim().toLowerCase();
}


// ─────────────────────────────────────────────────────────────
// Internal dual-write helpers (Slice 2)
// ─────────────────────────────────────────────────────────────

/**
 * Propagate a contacts.contact_phone change into the contact_phones
 * child table within an open transaction connection.
 *
 * Behavior:
 *   - newPhone === current primary-active phone for this contact → no-op
 *   - newPhone is non-empty:
 *       * end existing primary-active row (if any) as 'replaced'
 *         (same-contact reason — reserve 'transferred' for cross-contact)
 *       * if newPhone is active on ANOTHER contact, end that row as
 *         'transferred' and recompute that contact's mirror (force=true
 *         semantics — legacy never asks for confirmation)
 *       * INSERT a new primary-active row with the new value
 *       * recompute this contact's mirror (safety net; should be no-op)
 *   - newPhone is '' (empty string):
 *       * end the existing primary-active row as 'ended'
 *       * recompute mirror (writes '' to contacts.contact_phone, but
 *         the outer UPDATE already did that — no-op)
 *
 * Constraint note: this propagator relies on the Slice 2 Stage 1
 * revision migration (contact_multivalue_relax_unique.up.sql) having
 * dropped uc_contact_phone. With that migration applied, a contact may
 * have multiple history rows for the same phone value, so "phone
 * returns" (re-adopting a previously-ended number) works correctly.
 *
 * Slice 3 Stage A: this propagator is SKIPPED when the aggregate
 * `phones` array is present in the PATCH payload. The reconciler is
 * authoritative in that case.
 *
 * @param {object} conn      - transaction connection
 * @param {number} contactId
 * @param {string} newPhone  - already normalized (10 digits) or '' to clear
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagatePhone(conn, contactId, newPhone, updatedBy) {
  const cid = parseInt(contactId, 10);

  const [[primary]] = await conn.query(
    `SELECT id, phone FROM contact_phones
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  if (newPhone) {
    if (primary && primary.phone === newPhone) return;

    // End existing primary-active as 'replaced' (same-contact reason)
    if (primary) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'replaced', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
    }

    // force=true: end any other contact's active claim on this phone
    const [[collision]] = await conn.query(
      `SELECT id, contact_id FROM contact_phones
        WHERE phone = ? AND end_date IS NULL AND contact_id <> ?`,
      [newPhone, cid]
    );
    if (collision) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'transferred', updated_by = ?
          WHERE id = ?`,
        [updatedBy, collision.id]
      );
      await recomputePrimaryPhone(conn, collision.contact_id);
    }

    try {
      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [cid, newPhone, updatedBy, updatedBy]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot set contact_phone to ${newPhone}: a concurrent update ` +
          `claimed this number. Refresh and retry.`
        );
      }
      throw err;
    }

    await recomputePrimaryPhone(conn, cid);
  } else {
    if (primary) {
      await conn.query(
        `UPDATE contact_phones
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryPhone(conn, cid);
    }
  }
}

/**
 * Propagate a contacts.contact_email change into the contact_emails
 * child table within an open transaction connection. Direct mirror of
 * _propagatePhone — see that JSDoc for behavior. Differences:
 *   - normalization is trim + lowercase (caller is expected to have
 *     pre-normalized via normalizeEmail; this fn does NOT re-normalize)
 *   - constraint relaxation note applies to uc_contact_email
 *
 * Slice 3 Stage A: this propagator is SKIPPED when the aggregate
 * `emails` array is present in the PATCH payload.
 *
 * @param {object} conn
 * @param {number} contactId
 * @param {string} newEmail  - already normalized (trim+lowercased) or '' to clear
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagateEmail(conn, contactId, newEmail, updatedBy) {
  const cid = parseInt(contactId, 10);

  const [[primary]] = await conn.query(
    `SELECT id, email FROM contact_emails
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  if (newEmail) {
    if (primary && primary.email === newEmail) return;

    if (primary) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'replaced', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
    }

    const [[collision]] = await conn.query(
      `SELECT id, contact_id FROM contact_emails
        WHERE email = ? AND end_date IS NULL AND contact_id <> ?`,
      [newEmail, cid]
    );
    if (collision) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'transferred', updated_by = ?
          WHERE id = ?`,
        [updatedBy, collision.id]
      );
      await recomputePrimaryEmail(conn, collision.contact_id);
    }

    try {
      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [cid, newEmail, updatedBy, updatedBy]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot set contact_email to ${newEmail}: a concurrent update ` +
          `claimed this address. Refresh and retry.`
        );
      }
      throw err;
    }

    await recomputePrimaryEmail(conn, cid);
  } else {
    if (primary) {
      await conn.query(
        `UPDATE contact_emails
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryEmail(conn, cid);
    }
  }
}

/**
 * Propagate a contacts.contact_address / city / state / zip change into
 * the contact_addresses child table. SHAPE DIVERGES from phone/email:
 * addresses are edited IN PLACE on the existing primary-active row
 * rather than ended-and-re-inserted. Rationale: legacy forms send
 * partial updates (e.g. only contact_city), and "moved vs typo" is
 * genuinely ambiguous.
 *
 * Behavior:
 *   1. Find primary-active row for contactId.
 *   2. Determine the target full state (address1/city/state/zip):
 *        for each, prefer normalized.contact_<field> if present,
 *        else fall back to the existing primary row's value (or ''
 *        if no row).
 *   3. If target is all-empty AND a primary-active row exists:
 *        end that row with end_reason='ended'. Recompute mirror.
 *   4. If target is all-empty AND no primary row: nothing to do.
 *   5. If a primary-active row exists: UPDATE in place with target
 *        values (address1/city/state/zip + updated_by). country is
 *        not touched — the legacy form doesn't write it. Recompute.
 *   6. If no primary row exists: INSERT a new primary-active row
 *        with target values, country='US', start_date=CURDATE(),
 *        created_by=updatedBy. Recompute.
 *
 * No collision check (addresses are not active-unique across contacts).
 * No `transferred` reason (no donor-end ever happens).
 *
 * Slice 3 Stage A: this propagator is SKIPPED when the aggregate
 * `addresses` array is present in the PATCH payload.
 *
 * @param {object} conn
 * @param {number} contactId
 * @param {object} normalized  - the full normalized fields obj from updateContact;
 *                               reads contact_address/city/state/zip keys
 * @param {number} updatedBy
 * @returns {Promise<void>}
 */
async function _propagateAddress(conn, contactId, normalized, updatedBy) {
  const cid = parseInt(contactId, 10);

  // Step 1. Find primary-active row.
  const [[primary]] = await conn.query(
    `SELECT id, address1, city, state, zip
       FROM contact_addresses
      WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL
      LIMIT 1`,
    [cid]
  );

  // Step 2. Determine target state.
  const target = {
    address1: 'contact_address' in normalized
      ? (normalized.contact_address || '')
      : (primary ? (primary.address1 || '') : ''),
    city: 'contact_city' in normalized
      ? (normalized.contact_city || '')
      : (primary ? (primary.city || '') : ''),
    state: 'contact_state' in normalized
      ? (normalized.contact_state || '')
      : (primary ? (primary.state || '') : ''),
    zip: 'contact_zip' in normalized
      ? (normalized.contact_zip || '')
      : (primary ? (primary.zip || '') : ''),
  };

  const targetAllEmpty = !target.address1 && !target.city
                      && !target.state    && !target.zip;

  // Step 3 / 4. All-empty target.
  if (targetAllEmpty) {
    if (primary) {
      await conn.query(
        `UPDATE contact_addresses
            SET end_date = CURDATE(), is_primary = 0,
                end_reason = 'ended', updated_by = ?
          WHERE id = ?`,
        [updatedBy, primary.id]
      );
      await recomputePrimaryAddress(conn, cid);
    }
    return;
  }

  // Step 5. Primary exists → UPDATE in place.
  if (primary) {
    await conn.query(
      `UPDATE contact_addresses
          SET address1 = ?, city = ?, state = ?, zip = ?, updated_by = ?
        WHERE id = ?`,
      [target.address1, target.city, target.state, target.zip,
       updatedBy, primary.id]
    );
    await recomputePrimaryAddress(conn, cid);
    return;
  }

  // Step 6. No primary → INSERT new one.
  try {
    await conn.query(
      `INSERT INTO contact_addresses
         (contact_id, address1, address2, city, state, zip, country,
          label, is_primary, start_date, created_by, updated_by)
       VALUES (?, ?, '', ?, ?, ?, 'US', 'Other', 1, CURDATE(), ?, ?)`,
      [cid, target.address1, target.city, target.state, target.zip,
       updatedBy, updatedBy]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw new Error(
        'Concurrent promote on this contact — another primary-active ' +
        'address row was created. Refresh and retry.'
      );
    }
    throw err;
  }
  await recomputePrimaryAddress(conn, cid);
}


// ─────────────────────────────────────────────────────────────
// Slice 3 Stage A — Aggregate reconcilers
// ─────────────────────────────────────────────────────────────
//
// Architecture: each kind (phones/emails/addresses) has a plan function
// that validates + classifies incoming rows against current state, and
// an apply function that executes the plan inside an open transaction.
//
// updateContact calls all three plan functions first, aggregates any
// validation errors, then either throws with structured errors/conflicts
// or proceeds to apply all three plans. This lets the route surface
// errors from multiple kinds simultaneously (e.g., bad phone + bad email
// in the same payload).
//
// Plan return shape:
//   {
//     errors:    [{ index, field, message }, ...],   // [] when valid
//     conflicts: [{ kind, from_contact_id, ... }],   // populated when !force
//     plan:      {                                    // null when errors/conflicts
//       donorEnds:        [{ donorContactId, donorPhoneId, donorContactName, phone }, ...],
//       transferredFrom:  [...],                      // pre-built response items
//       existingPrimaryToDemote: <id|null>,           // displaced primary id
//       endIds:           [<id>, ...],                // rows omitted from incoming
//       endReplaces:      [{ index, oldId, current, validated }, ...],
//       inserts:          [{ index, validated }, ...],
//       updates:          [{ index, id, current, validated }, ...],
//       primaryCount:     <number>,
//     }
//   }


/**
 * Compare two date-ish values. Accepts JS Date, 'YYYY-MM-DD' string, or null.
 * Returns true if they represent the same calendar day (or both null).
 * Used by _hasFieldDifferences to detect no-op UPDATEs on date columns.
 */
function _dateEquals(a, b) {
  const an = a == null ? null : a;
  const bn = b == null ? null : b;
  if (an === bn) return true;
  if (an == null || bn == null) return false;
  const fmt = (v) => {
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
  };
  return fmt(an) === fmt(bn);
}

/**
 * Detect whether `validated` (sparse) differs from `current` (full DB row)
 * on any field present in `validated`. Excludes `phone`/`email` because
 * value changes on those columns trigger the end-and-replace path, not
 * the in-place UPDATE path (handled separately in plan classification).
 */
function _hasFieldDifferences(current, validated) {
  for (const k of Object.keys(validated)) {
    if (k === 'phone' || k === 'email') continue;
    if (k === 'start_date' || k === 'end_date') {
      if (!_dateEquals(current[k], validated[k])) return true;
      continue;
    }
    if (current[k] !== validated[k]) return true;
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// _planPhones — validate + classify incoming phone rows
// ─────────────────────────────────────────────────────────────

/**
 * Plan-phase of the phones aggregate reconciler. Validates each incoming
 * row, classifies it against the contact's current active rows, checks
 * for same-contact duplicates and cross-contact collisions.
 *
 * Side effects: NONE — does not mutate the DB. Reads current state via
 * conn but writes nothing. Safe to call multiple times.
 *
 * @param {object} conn      - transaction connection (so we read consistent state)
 * @param {number} contactId
 * @param {Array<object>} incoming
 * @param {boolean} force    - if true, cross-contact conflicts become donor-ends in plan
 * @returns {Promise<{errors, conflicts, plan}>}
 */
async function _planPhones(conn, contactId, incoming, force) {
  const errors = [];
  const cid = parseInt(contactId, 10);

  // ── Phase 1: validate each row (shape) ──
  const validRows = []; // { index, id, validated }
  let primaryCount = 0;

  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i] || {};
    const hasId = row.id != null && row.id !== '';
    let validated;
    try {
      validated = phoneSvc.validatePhoneRow(row, { mode: hasId ? 'update' : 'insert' });
    } catch (e) {
      errors.push({ index: i, field: e.field || null, message: e.message });
      continue;
    }
    if (validated.is_primary === 1) primaryCount++;
    validRows.push({ index: i, id: hasId ? row.id : null, validated });
  }

  if (primaryCount > 1) {
    errors.push({
      index: -1,
      field: 'is_primary',
      message: 'Exactly one row may be marked is_primary',
    });
  }

  // Bail early on shape errors — Phase 2+ would just produce noise.
  if (errors.length) {
    return { errors, conflicts: [], plan: null };
  }

  // ── Phase 2: load current active rows ──
  const [currentRows] = await conn.query(
    `SELECT id, phone, label, is_primary, sms_optout, mms_capable,
            verified, start_date, end_date, end_reason, notes
       FROM contact_phones
      WHERE contact_id = ? AND end_date IS NULL`,
    [cid]
  );
  const currentById = new Map();
  for (const r of currentRows) currentById.set(r.id, r);

  // ── Phase 3: classify each valid row ──
  const ops = {
    inserts:     [],
    updates:     [],
    endReplaces: [],
    noOps:       [],
  };
  const matchedIds = new Set();

  for (const vr of validRows) {
    if (vr.id != null) {
      // Coerce id type — incoming may be string from JSON
      const idNum = typeof vr.id === 'number' ? vr.id : parseInt(vr.id, 10);
      const current = currentById.get(idNum);
      if (!current) {
        errors.push({
          index: vr.index,
          field: 'id',
          message: `Phone row ${vr.id} not found on this contact`,
        });
        continue;
      }
      matchedIds.add(idNum);

      // Detect value change → end-and-replace.
      // 'phone' is in validated only if caller explicitly sent it
      // (sparse mode). If absent, no value change.
      const phoneChanged = 'phone' in vr.validated
                        && vr.validated.phone !== current.phone;

      if (phoneChanged) {
        ops.endReplaces.push({
          index: vr.index,
          oldId: idNum,
          current,
          validated: vr.validated,
        });
      } else if (_hasFieldDifferences(current, vr.validated)) {
        ops.updates.push({
          index: vr.index,
          id: idNum,
          current,
          validated: vr.validated,
        });
      } else {
        ops.noOps.push({ index: vr.index, id: idNum, current });
      }
    } else {
      // INSERT — no id supplied
      ops.inserts.push({ index: vr.index, validated: vr.validated });
    }
  }

  // Rows in currentRows whose id wasn't in incoming → ENDs.
  const endIds = [];
  for (const cr of currentRows) {
    if (!matchedIds.has(cr.id)) endIds.push(cr.id);
  }

  if (errors.length) {
    // Stale-id errors surfaced here; abort.
    return { errors, conflicts: [], plan: null };
  }

  // ── Phase 4: cross-contact collision check ──
  // Phone values that will be newly active on this contact:
  //   - inserts' phone
  //   - endReplaces' newRow.phone (will be INSERT'd as fresh row)
  const phonesNeedingClaim = [
    ...ops.inserts.map(o => o.validated.phone),
    ...ops.endReplaces.map(o => o.validated.phone),
  ];

  let conflictsResp = [];
  let donorEnds = [];
  let transferredFrom = [];

  if (phonesNeedingClaim.length) {
    const placeholders = phonesNeedingClaim.map(() => '?').join(',');
    const [conflictRows] = await conn.query(
      `SELECT cp.id AS phone_id, cp.contact_id, cp.phone, c.contact_name
         FROM contact_phones cp
         JOIN contacts c ON c.contact_id = cp.contact_id
        WHERE cp.phone IN (${placeholders})
          AND cp.end_date IS NULL
          AND cp.contact_id <> ?`,
      [...phonesNeedingClaim, cid]
    );

    if (conflictRows.length) {
      if (!force) {
        conflictsResp = conflictRows.map(c => ({
          kind: 'phone',
          from_contact_id:   c.contact_id,
          from_contact_name: c.contact_name,
          phone:             c.phone,
          closed_phone_id:   c.phone_id,
        }));
        return { errors: [], conflicts: conflictsResp, plan: null };
      }
      // force=true: convert to donor-ends for the apply phase
      donorEnds = conflictRows.map(c => ({
        donorContactId:   c.contact_id,
        donorPhoneId:     c.phone_id,
        donorContactName: c.contact_name,
        phone:            c.phone,
      }));
      transferredFrom = conflictRows.map(c => ({
        kind: 'phone',
        from_contact_id:   c.contact_id,
        from_contact_name: c.contact_name,
        phone:             c.phone,
        closed_phone_id:   c.phone_id,
      }));
    }
  }

  // ── Phase 4.5: same-contact final-state phone uniqueness check ──
  // After this op, which phone values will be active on this contact?
  //   - Kept-UPDATE rows: validated.phone if present, else current.phone
  //     (UPDATE never changes phone — that's the endReplace path —
  //      so always current.phone in practice)
  //   - NoOp rows: current.phone
  //   - End-and-replace NEW rows: validated.phone
  //   - INSERT rows: validated.phone
  // We don't worry about user-supplied end_date in the validated row
  // (uncommon; DB will catch any constraint violation as a fallback).
  const finalPhones = new Map(); // phone -> [index, ...]
  const recordPhone = (phone, index) => {
    if (!finalPhones.has(phone)) finalPhones.set(phone, []);
    finalPhones.get(phone).push(index);
  };
  for (const op of ops.updates) {
    const phone = ('phone' in op.validated) ? op.validated.phone : op.current.phone;
    recordPhone(phone, op.index);
  }
  for (const op of ops.noOps) {
    recordPhone(op.current.phone, op.index);
  }
  for (const op of ops.endReplaces) {
    recordPhone(op.validated.phone, op.index);
  }
  for (const op of ops.inserts) {
    recordPhone(op.validated.phone, op.index);
  }
  for (const [phone, indices] of finalPhones) {
    if (indices.length > 1) {
      errors.push({
        index: indices[1],
        field: 'phone',
        message: `Duplicate phone "${phone}" within this save (also at row index ${indices[0]})`,
      });
    }
  }
  if (errors.length) {
    return { errors, conflicts: [], plan: null };
  }

  // ── Determine existing primary that needs displacement ──
  //
  // If primaryCount === 1, find the existing primary (if any) and check
  // whether the new primary is a DIFFERENT row. If so, queue an explicit
  // demote in the apply phase. This avoids the "blanket demote" pitfall
  // where a noOp row that IS the new primary would lose its is_primary
  // bit and never get it back.
  let existingPrimaryToDemote = null;
  if (primaryCount === 1) {
    const existingPrimary = currentRows.find(r => r.is_primary === 1);
    if (existingPrimary) {
      // Locate the new primary among validRows
      const newPrimaryRow = validRows.find(vr => vr.validated.is_primary === 1);
      const newPrimaryId = newPrimaryRow && newPrimaryRow.id != null
        ? (typeof newPrimaryRow.id === 'number' ? newPrimaryRow.id : parseInt(newPrimaryRow.id, 10))
        : null;
      if (newPrimaryId !== existingPrimary.id) {
        // Different row is becoming primary. Need explicit demote of
        // existing primary (unless it's about to be ended/replaced —
        // those paths set is_primary=0 anyway, but a redundant demote
        // is harmless and keeps the logic simple).
        existingPrimaryToDemote = existingPrimary.id;
      }
    }
  }

  return {
    errors: [],
    conflicts: [],
    plan: {
      donorEnds,
      transferredFrom,
      existingPrimaryToDemote,
      endIds,
      endReplaces: ops.endReplaces,
      inserts:     ops.inserts,
      updates:     ops.updates,
      // Surface counts for "X_changed" response (noOps don't count;
      // donor-ends don't count toward THIS contact's changes).
      changedCount: ops.inserts.length + ops.updates.length
                  + ops.endReplaces.length + endIds.length,
    },
  };
}


/**
 * Apply a phones plan. Mutates DB inside the open transaction conn.
 *
 * Step order:
 *   A. Donor-ends (cross-contact transfers, force=true). Each followed
 *      by an immediate donor-contact mirror recompute.
 *   B. Demote existing primary if displaced by a different incoming row.
 *   C. ENDs (rows omitted from incoming) → end_reason='ended'.
 *   D. End-and-replace OLD parts → end_reason='replaced'.
 *   E. End-and-replace NEW parts → INSERT, inheriting from old + override.
 *   F. New inserts → INSERT.
 *   G. Updates of kept rows.
 *   H. Mirror recompute for THIS contact.
 *
 * Why E inserts come before G updates: in the primary-swap case where
 * the new primary is an INSERT/endReplace and the old primary is being
 * UPDATEd to is_primary=0, executing E first creates the new primary
 * row with is_primary=1; the existing primary was already demoted in
 * step B, so no uk_one_active_primary conflict.
 */
async function _applyPhonePlan(conn, contactId, plan, userId) {
  const cid = parseInt(contactId, 10);

  // ── Step A: donor-ends ──
  for (const de of plan.donorEnds) {
    await conn.query(
      `UPDATE contact_phones
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'transferred', updated_by = ?
        WHERE id = ?`,
      [userId, de.donorPhoneId]
    );
    await recomputePrimaryPhone(conn, de.donorContactId);
  }

  // ── Step B: demote displaced existing primary ──
  if (plan.existingPrimaryToDemote != null) {
    await conn.query(
      `UPDATE contact_phones
          SET is_primary = 0, updated_by = ?
        WHERE id = ?`,
      [userId, plan.existingPrimaryToDemote]
    );
  }

  // ── Step C: ENDs ──
  for (const id of plan.endIds) {
    await conn.query(
      `UPDATE contact_phones
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'ended', updated_by = ?
        WHERE id = ?`,
      [userId, id]
    );
  }

  // ── Step D: end-and-replace OLD parts ──
  for (const er of plan.endReplaces) {
    await conn.query(
      `UPDATE contact_phones
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'replaced', updated_by = ?
        WHERE id = ?`,
      [userId, er.oldId]
    );
  }

  // ── Step E: end-and-replace NEW parts (INSERT inheriting from old) ──
  // For the new row, inherit each field from the old row UNLESS the
  // incoming row specified it (in validated). is_primary preserved
  // from old when not specified — keeps the primary phone the primary
  // after a value correction, per principle of least surprise.
  for (const er of plan.endReplaces) {
    const old = er.current;
    const inc = er.validated;
    // is_primary inheritance has an extra guard: if THIS endReplace's old
    // row is the displaced primary (existingPrimaryToDemote === oldId)
    // AND the caller didn't explicitly set is_primary, force 0 — the
    // user has moved primary status to a different row this save, so the
    // replacement shouldn't reclaim it via stale-snapshot inheritance.
    let rowIsPrimary;
    if ('is_primary' in inc) {
      rowIsPrimary = inc.is_primary;
    } else if (plan.existingPrimaryToDemote === er.oldId) {
      rowIsPrimary = 0;
    } else {
      rowIsPrimary = old.is_primary;
    }
    const row = {
      phone:       'phone'       in inc ? inc.phone       : old.phone,
      label:       'label'       in inc ? inc.label       : old.label,
      is_primary:  rowIsPrimary,
      sms_optout:  'sms_optout'  in inc ? inc.sms_optout  : old.sms_optout,
      mms_capable: 'mms_capable' in inc ? inc.mms_capable : old.mms_capable,
      verified:    'verified'    in inc ? inc.verified    : old.verified,
      // Fresh row → start_date today (via COALESCE in SQL),
      // end_date null, end_reason null.
      start_date:  null,
      notes:       'notes'       in inc ? inc.notes       : old.notes,
    };
    try {
      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, label, is_primary,
            sms_optout, mms_capable, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [cid, row.phone, row.label, row.is_primary,
         row.sms_optout, row.mms_capable, row.verified,
         row.start_date, row.notes, userId, userId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot replace phone row ${er.oldId} → "${row.phone}": ` +
          `concurrent update claimed this number. Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // ── Step F: new inserts ──
  for (const ins of plan.inserts) {
    const v = ins.validated;
    // is_primary defaults to 0 when validator left it undefined
    // (aggregate API does NOT auto-promote — that's only the dedicated
    // create route's behavior).
    const isPrimary = v.is_primary === undefined ? 0 : v.is_primary;
    try {
      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, label, is_primary,
            sms_optout, mms_capable, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [cid, v.phone, v.label, isPrimary,
         v.sms_optout, v.mms_capable, v.verified,
         v.start_date, v.notes, userId, userId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot insert phone "${v.phone}": concurrent update ` +
          `claimed this number. Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // ── Step G: updates of kept rows ──
  for (const upd of plan.updates) {
    const updateKeys = Object.keys(upd.validated).filter(k => k !== 'phone');
    if (updateKeys.length === 0) continue; // safety; classifier shouldn't emit empty UPDATEs

    // Mirror the dedicated PATCH route's "primary-ending also clears is_primary" guard.
    const v = { ...upd.validated };
    const beingEnded = 'end_date' in v && v.end_date !== null
                    && upd.current.end_date === null;
    if (beingEnded && upd.current.is_primary === 1) {
      v.is_primary = 0;
    }

    const setKeys = Object.keys(v).filter(k => k !== 'phone');
    setKeys.push('updated_by');
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => k === 'updated_by' ? userId : v[k]);

    try {
      await conn.query(
        `UPDATE contact_phones SET ${setSQL} WHERE id = ?`,
        [...setVals, upd.id]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot update phone row ${upd.id}: ` +
          `uniqueness constraint (likely uk_one_active_primary). ` +
          `Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // ── Step H: mirror recompute for this contact ──
  await recomputePrimaryPhone(conn, cid);

  return {
    phones_changed:   plan.changedCount,
    transferred_from: plan.transferredFrom,
  };
}


// ─────────────────────────────────────────────────────────────
// _planEmails / _applyEmailPlan — parallel to phones
// ─────────────────────────────────────────────────────────────

async function _planEmails(conn, contactId, incoming, force) {
  const errors = [];
  const cid = parseInt(contactId, 10);

  const validRows = [];
  let primaryCount = 0;
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i] || {};
    const hasId = row.id != null && row.id !== '';
    let validated;
    try {
      validated = emailSvc.validateEmailRow(row, { mode: hasId ? 'update' : 'insert' });
    } catch (e) {
      errors.push({ index: i, field: e.field || null, message: e.message });
      continue;
    }
    if (validated.is_primary === 1) primaryCount++;
    validRows.push({ index: i, id: hasId ? row.id : null, validated });
  }
  if (primaryCount > 1) {
    errors.push({
      index: -1,
      field: 'is_primary',
      message: 'Exactly one row may be marked is_primary',
    });
  }
  if (errors.length) return { errors, conflicts: [], plan: null };

  const [currentRows] = await conn.query(
    `SELECT id, email, label, is_primary, email_optout, verified,
            start_date, end_date, end_reason, notes
       FROM contact_emails
      WHERE contact_id = ? AND end_date IS NULL`,
    [cid]
  );
  const currentById = new Map();
  for (const r of currentRows) currentById.set(r.id, r);

  const ops = { inserts: [], updates: [], endReplaces: [], noOps: [] };
  const matchedIds = new Set();

  for (const vr of validRows) {
    if (vr.id != null) {
      const idNum = typeof vr.id === 'number' ? vr.id : parseInt(vr.id, 10);
      const current = currentById.get(idNum);
      if (!current) {
        errors.push({
          index: vr.index,
          field: 'id',
          message: `Email row ${vr.id} not found on this contact`,
        });
        continue;
      }
      matchedIds.add(idNum);

      const emailChanged = 'email' in vr.validated
                        && vr.validated.email !== current.email;

      if (emailChanged) {
        ops.endReplaces.push({
          index: vr.index, oldId: idNum, current, validated: vr.validated,
        });
      } else if (_hasFieldDifferences(current, vr.validated)) {
        ops.updates.push({
          index: vr.index, id: idNum, current, validated: vr.validated,
        });
      } else {
        ops.noOps.push({ index: vr.index, id: idNum, current });
      }
    } else {
      ops.inserts.push({ index: vr.index, validated: vr.validated });
    }
  }

  const endIds = [];
  for (const cr of currentRows) {
    if (!matchedIds.has(cr.id)) endIds.push(cr.id);
  }

  if (errors.length) return { errors, conflicts: [], plan: null };

  // Cross-contact collision check
  const emailsNeedingClaim = [
    ...ops.inserts.map(o => o.validated.email),
    ...ops.endReplaces.map(o => o.validated.email),
  ];

  let donorEnds = [];
  let transferredFrom = [];

  if (emailsNeedingClaim.length) {
    const placeholders = emailsNeedingClaim.map(() => '?').join(',');
    const [conflictRows] = await conn.query(
      `SELECT ce.id AS email_id, ce.contact_id, ce.email, c.contact_name
         FROM contact_emails ce
         JOIN contacts c ON c.contact_id = ce.contact_id
        WHERE ce.email IN (${placeholders})
          AND ce.end_date IS NULL
          AND ce.contact_id <> ?`,
      [...emailsNeedingClaim, cid]
    );
    if (conflictRows.length) {
      if (!force) {
        const conflictsResp = conflictRows.map(c => ({
          kind: 'email',
          from_contact_id:   c.contact_id,
          from_contact_name: c.contact_name,
          email:             c.email,
          closed_email_id:   c.email_id,
        }));
        return { errors: [], conflicts: conflictsResp, plan: null };
      }
      donorEnds = conflictRows.map(c => ({
        donorContactId:   c.contact_id,
        donorEmailId:     c.email_id,
        donorContactName: c.contact_name,
        email:            c.email,
      }));
      transferredFrom = conflictRows.map(c => ({
        kind: 'email',
        from_contact_id:   c.contact_id,
        from_contact_name: c.contact_name,
        email:             c.email,
        closed_email_id:   c.email_id,
      }));
    }
  }

  // Same-contact duplicate check
  const finalEmails = new Map();
  const recordEmail = (email, index) => {
    if (!finalEmails.has(email)) finalEmails.set(email, []);
    finalEmails.get(email).push(index);
  };
  for (const op of ops.updates) {
    const email = ('email' in op.validated) ? op.validated.email : op.current.email;
    recordEmail(email, op.index);
  }
  for (const op of ops.noOps) {
    recordEmail(op.current.email, op.index);
  }
  for (const op of ops.endReplaces) {
    recordEmail(op.validated.email, op.index);
  }
  for (const op of ops.inserts) {
    recordEmail(op.validated.email, op.index);
  }
  for (const [email, indices] of finalEmails) {
    if (indices.length > 1) {
      errors.push({
        index: indices[1],
        field: 'email',
        message: `Duplicate email "${email}" within this save (also at row index ${indices[0]})`,
      });
    }
  }
  if (errors.length) return { errors, conflicts: [], plan: null };

  let existingPrimaryToDemote = null;
  if (primaryCount === 1) {
    const existingPrimary = currentRows.find(r => r.is_primary === 1);
    if (existingPrimary) {
      const newPrimaryRow = validRows.find(vr => vr.validated.is_primary === 1);
      const newPrimaryId = newPrimaryRow && newPrimaryRow.id != null
        ? (typeof newPrimaryRow.id === 'number' ? newPrimaryRow.id : parseInt(newPrimaryRow.id, 10))
        : null;
      if (newPrimaryId !== existingPrimary.id) {
        existingPrimaryToDemote = existingPrimary.id;
      }
    }
  }

  return {
    errors: [],
    conflicts: [],
    plan: {
      donorEnds,
      transferredFrom,
      existingPrimaryToDemote,
      endIds,
      endReplaces: ops.endReplaces,
      inserts:     ops.inserts,
      updates:     ops.updates,
      changedCount: ops.inserts.length + ops.updates.length
                  + ops.endReplaces.length + endIds.length,
    },
  };
}


async function _applyEmailPlan(conn, contactId, plan, userId) {
  const cid = parseInt(contactId, 10);

  // A: donor-ends
  for (const de of plan.donorEnds) {
    await conn.query(
      `UPDATE contact_emails
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'transferred', updated_by = ?
        WHERE id = ?`,
      [userId, de.donorEmailId]
    );
    await recomputePrimaryEmail(conn, de.donorContactId);
  }

  // B: demote displaced primary
  if (plan.existingPrimaryToDemote != null) {
    await conn.query(
      `UPDATE contact_emails
          SET is_primary = 0, updated_by = ?
        WHERE id = ?`,
      [userId, plan.existingPrimaryToDemote]
    );
  }

  // C: ENDs
  for (const id of plan.endIds) {
    await conn.query(
      `UPDATE contact_emails
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'ended', updated_by = ?
        WHERE id = ?`,
      [userId, id]
    );
  }

  // D: end-and-replace OLDs
  for (const er of plan.endReplaces) {
    await conn.query(
      `UPDATE contact_emails
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'replaced', updated_by = ?
        WHERE id = ?`,
      [userId, er.oldId]
    );
  }

  // E: end-and-replace NEWs (INSERT inheriting from old)
  for (const er of plan.endReplaces) {
    const old = er.current;
    const inc = er.validated;
    // is_primary inheritance has an extra guard: if THIS endReplace's old
    // row is the displaced primary (existingPrimaryToDemote === oldId)
    // AND the caller didn't explicitly set is_primary, force 0 — the
    // user has moved primary status to a different row this save, so the
    // replacement shouldn't reclaim it via stale-snapshot inheritance.
    let rowIsPrimary;
    if ('is_primary' in inc) {
      rowIsPrimary = inc.is_primary;
    } else if (plan.existingPrimaryToDemote === er.oldId) {
      rowIsPrimary = 0;
    } else {
      rowIsPrimary = old.is_primary;
    }
    const row = {
      email:        'email'        in inc ? inc.email        : old.email,
      label:        'label'        in inc ? inc.label        : old.label,
      is_primary:   rowIsPrimary,
      email_optout: 'email_optout' in inc ? inc.email_optout : old.email_optout,
      verified:     'verified'     in inc ? inc.verified     : old.verified,
      start_date:   null,
      notes:        'notes'        in inc ? inc.notes        : old.notes,
    };
    try {
      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, label, is_primary,
            email_optout, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [cid, row.email, row.label, row.is_primary,
         row.email_optout, row.verified,
         row.start_date, row.notes, userId, userId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot replace email row ${er.oldId} → "${row.email}": ` +
          `concurrent update claimed this address. Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // F: inserts
  for (const ins of plan.inserts) {
    const v = ins.validated;
    const isPrimary = v.is_primary === undefined ? 0 : v.is_primary;
    try {
      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, label, is_primary,
            email_optout, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [cid, v.email, v.label, isPrimary,
         v.email_optout, v.verified,
         v.start_date, v.notes, userId, userId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot insert email "${v.email}": concurrent update ` +
          `claimed this address. Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // G: updates
  for (const upd of plan.updates) {
    const updateKeys = Object.keys(upd.validated).filter(k => k !== 'email');
    if (updateKeys.length === 0) continue;

    const v = { ...upd.validated };
    const beingEnded = 'end_date' in v && v.end_date !== null
                    && upd.current.end_date === null;
    if (beingEnded && upd.current.is_primary === 1) {
      v.is_primary = 0;
    }

    const setKeys = Object.keys(v).filter(k => k !== 'email');
    setKeys.push('updated_by');
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => k === 'updated_by' ? userId : v[k]);

    try {
      await conn.query(
        `UPDATE contact_emails SET ${setSQL} WHERE id = ?`,
        [...setVals, upd.id]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot update email row ${upd.id}: ` +
          `uniqueness constraint (likely uk_one_active_primary). ` +
          `Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // H: mirror recompute for this contact
  await recomputePrimaryEmail(conn, cid);

  return {
    emails_changed:   plan.changedCount,
    transferred_from: plan.transferredFrom,
  };
}


// ─────────────────────────────────────────────────────────────
// _planAddresses / _applyAddressPlan — no cross-contact collision,
// no end-and-replace category (addresses are UPDATE-in-place mutable).
// ─────────────────────────────────────────────────────────────

async function _planAddresses(conn, contactId, incoming) {
  const errors = [];
  const cid = parseInt(contactId, 10);

  const validRows = [];
  let primaryCount = 0;
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i] || {};
    const hasId = row.id != null && row.id !== '';
    let validated;
    try {
      validated = addrSvc.validateAddressRow(row, { mode: hasId ? 'update' : 'insert' });
    } catch (e) {
      errors.push({ index: i, field: e.field || null, message: e.message });
      continue;
    }
    if (validated.is_primary === 1) primaryCount++;
    validRows.push({ index: i, id: hasId ? row.id : null, validated });
  }
  if (primaryCount > 1) {
    errors.push({
      index: -1,
      field: 'is_primary',
      message: 'Exactly one row may be marked is_primary',
    });
  }
  if (errors.length) return { errors, conflicts: [], plan: null };

  const [currentRows] = await conn.query(
    `SELECT id, address1, address2, city, state, zip, country,
            label, is_primary, verified,
            start_date, end_date, end_reason, notes
       FROM contact_addresses
      WHERE contact_id = ? AND end_date IS NULL`,
    [cid]
  );
  const currentById = new Map();
  for (const r of currentRows) currentById.set(r.id, r);

  // Addresses have no endReplace category — value changes are UPDATE-in-place.
  const ops = { inserts: [], updates: [], noOps: [] };
  const matchedIds = new Set();

  for (const vr of validRows) {
    if (vr.id != null) {
      const idNum = typeof vr.id === 'number' ? vr.id : parseInt(vr.id, 10);
      const current = currentById.get(idNum);
      if (!current) {
        errors.push({
          index: vr.index,
          field: 'id',
          message: `Address row ${vr.id} not found on this contact`,
        });
        continue;
      }
      matchedIds.add(idNum);

      if (_hasFieldDifferences(current, vr.validated)) {
        ops.updates.push({
          index: vr.index, id: idNum, current, validated: vr.validated,
        });
      } else {
        ops.noOps.push({ index: vr.index, id: idNum, current });
      }
    } else {
      ops.inserts.push({ index: vr.index, validated: vr.validated });
    }
  }

  const endIds = [];
  for (const cr of currentRows) {
    if (!matchedIds.has(cr.id)) endIds.push(cr.id);
  }

  if (errors.length) return { errors, conflicts: [], plan: null };

  let existingPrimaryToDemote = null;
  if (primaryCount === 1) {
    const existingPrimary = currentRows.find(r => r.is_primary === 1);
    if (existingPrimary) {
      const newPrimaryRow = validRows.find(vr => vr.validated.is_primary === 1);
      const newPrimaryId = newPrimaryRow && newPrimaryRow.id != null
        ? (typeof newPrimaryRow.id === 'number' ? newPrimaryRow.id : parseInt(newPrimaryRow.id, 10))
        : null;
      if (newPrimaryId !== existingPrimary.id) {
        existingPrimaryToDemote = existingPrimary.id;
      }
    }
  }

  return {
    errors: [],
    conflicts: [],
    plan: {
      existingPrimaryToDemote,
      endIds,
      inserts: ops.inserts,
      updates: ops.updates,
      changedCount: ops.inserts.length + ops.updates.length + endIds.length,
    },
  };
}


async function _applyAddressPlan(conn, contactId, plan, userId) {
  const cid = parseInt(contactId, 10);

  // B: demote displaced primary
  if (plan.existingPrimaryToDemote != null) {
    await conn.query(
      `UPDATE contact_addresses
          SET is_primary = 0, updated_by = ?
        WHERE id = ?`,
      [userId, plan.existingPrimaryToDemote]
    );
  }

  // C: ENDs
  for (const id of plan.endIds) {
    await conn.query(
      `UPDATE contact_addresses
          SET end_date = CURDATE(), is_primary = 0,
              end_reason = 'ended', updated_by = ?
        WHERE id = ?`,
      [userId, id]
    );
  }

  // F: inserts
  for (const ins of plan.inserts) {
    const v = ins.validated;
    const isPrimary = v.is_primary === undefined ? 0 : v.is_primary;
    try {
      await conn.query(
        `INSERT INTO contact_addresses
           (contact_id, address1, address2, city, state, zip, country,
            label, is_primary, verified,
            start_date, notes, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?)`,
        [cid, v.address1, v.address2, v.city, v.state, v.zip, v.country,
         v.label, isPrimary, v.verified,
         v.start_date, v.notes, userId, userId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          'Concurrent promote on this contact — another primary-active ' +
          'address row was created. Refresh and retry.'
        );
      }
      throw err;
    }
  }

  // G: updates (in-place address-value mutability is what makes addresses
  //    different from phones/emails — no endReplace category here).
  for (const upd of plan.updates) {
    const v = { ...upd.validated };
    const beingEnded = 'end_date' in v && v.end_date !== null
                    && upd.current.end_date === null;
    if (beingEnded && upd.current.is_primary === 1) {
      v.is_primary = 0;
    }

    const setKeys = Object.keys(v);
    setKeys.push('updated_by');
    const setSQL  = setKeys.map(k => `\`${k}\` = ?`).join(', ');
    const setVals = setKeys.map(k => k === 'updated_by' ? userId : v[k]);

    try {
      await conn.query(
        `UPDATE contact_addresses SET ${setSQL} WHERE id = ?`,
        [...setVals, upd.id]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new Error(
          `Cannot update address row ${upd.id}: ` +
          `uniqueness constraint (likely uk_one_active_primary). ` +
          `Refresh and retry.`
        );
      }
      throw err;
    }
  }

  // H: mirror recompute
  await recomputePrimaryAddress(conn, cid);

  return {
    addresses_changed: plan.changedCount,
  };
}


// ─────────────────────────────────────────────────────────────
// listContacts
// ─────────────────────────────────────────────────────────────

/**
 * List contacts with search, filters, and pagination.
 *
 * Search uses FULLTEXT on contact_name for text queries,
 * with LIKE fallback for phone/email patterns.
 */
async function listContacts(db, {
  query  = '',
  type   = null,
  tags   = null,
  sort_by  = 'c.contact_lname',
  sort_dir = 'ASC',
  limit  = 50,
  offset = 0
} = {}) {
  const where = [];
  const params = [];

  if (query) {
    if (/^\d+$/.test(query)) {
      const digits = query.replace(/\D/g, '');
      if (digits.length >= 7) {
        where.push(`(c.contact_phone LIKE ? OR c.contact_phone2 LIKE ?)`);
        params.push(`%${digits}%`, `%${digits}%`);
      } else {
        where.push(`c.contact_id = ?`);
        params.push(parseInt(query, 10));
      }
    } else if (query.includes('@')) {
      where.push(`(c.contact_email LIKE ? OR c.contact_email2 LIKE ?)`);
      const q = `%${query}%`;
      params.push(q, q);
    } else {
      where.push(`(
        MATCH(c.contact_name) AGAINST(? IN BOOLEAN MODE)
        OR c.contact_name LIKE ?
        OR CONCAT(c.contact_fname, ' ', c.contact_lname) LIKE ?
        OR c.contact_fname LIKE ?
        OR c.contact_lname LIKE ?
      )`);
      const q = `%${query}%`;
      params.push(`${query}*`, q,q, q, q);
    }
  }

  if (type) {
    where.push('c.contact_type = ?');
    params.push(type);
  }

  if (tags) {
    where.push('c.contact_tags LIKE ?');
    params.push(`%${tags}%`);
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const SORT_WHITELIST = {
    "contact_lname ASC": "c.contact_lname ASC",
    "contact_lname DESC": "c.contact_lname DESC",
    "contact_fname ASC": "c.contact_fname ASC",
    "contact_fname DESC": "c.contact_fname DESC",
  };
  const orderClause =
    SORT_WHITELIST[`${sort_by} ${sort_dir}`] ||
    SORT_WHITELIST[sort_by] ||
    "c.contact_lname ASC";

  const [contacts] = await db.query(
    `SELECT
     c.contact_id, c.contact_type, c.contact_name,
     c.contact_fname, c.contact_mname, c.contact_lname,
     c.contact_phone, c.contact_email,
     c.contact_address, c.contact_city, c.contact_state, c.contact_zip,
     c.contact_tags,
     IFNULL(DATE_FORMAT(c.contact_dob, '%M %e, %Y'), '') AS dob,
     JSON_ARRAYAGG(
       JSON_OBJECT(
         'case_number', COALESCE(ca.case_number_full, ca.case_number, ca.case_id),
         'case_id',     ca.case_id,
         'case_type',   ca.case_type
       )
     ) AS cases
   FROM contacts c
   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
   ${whereSQL}
   GROUP BY c.contact_id
   ORDER BY ${orderClause}
   LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)],
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(DISTINCT c.contact_id) AS total
   FROM contacts c
   LEFT JOIN case_relate cr ON c.contact_id = cr.case_relate_client_id
   LEFT JOIN cases ca ON cr.case_relate_case_id = ca.case_id
   ${whereSQL}`,
    params,
  );

  return { contacts, total };
}


// ─────────────────────────────────────────────────────────────
// getContact — respects `include` parameter
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single contact, optionally with related entities.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {string} [include] — comma-separated:
 *   'cases,appts,tasks,log,sequences,phones,emails,addresses'
 * @returns {object|null} null if contact not found
 */
async function getContact(db, contactId, include = '', { logLimit = DEFAULT_LOG_LIMIT } = {}) {
  const [[raw]] = await db.query(
    'SELECT * FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  if (!raw) return null;
  const contact = { ...raw };

  const result = { contact };

  const parts = include
    ? include.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  if (parts.includes('cases')) {
    const [cases] = await db.query(
      `SELECT
       ca.case_id, ca.case_number, ca.case_number_full,
       ca.case_type, ca.case_stage, ca.case_status,
       cr.case_relate_type AS relate_type,
       IFNULL(DATE_FORMAT(ca.case_open_date,  '%b. %e, %Y'), '') AS open,
       IFNULL(DATE_FORMAT(ca.case_file_date,  '%b. %e, %Y'), '') AS file,
       IFNULL(DATE_FORMAT(ca.case_close_date, '%b. %e, %Y'), '') AS close
      FROM case_relate cr
      JOIN cases ca ON cr.case_relate_case_id = ca.case_id
      WHERE cr.case_relate_client_id = ?
      ORDER BY ca.case_open_date DESC`,
      [contactId],
    );
    result.cases = cases;
  }

  if (parts.includes('appts')) {
    const [appts] = await db.query(
      `SELECT
         a.appt_id, a.appt_type, a.appt_status, a.appt_date, a.appt_end,
         a.appt_length, a.appt_platform, a.appt_case_id, a.appt_note,
         a.appt_with,
         DATE_FORMAT(a.appt_date, '%Y-%m-%dT%H:%i') AS appt_datetime_local,
         DATE_FORMAT(a.appt_date, '%b. %e, %Y') AS format_date,
         DATE_FORMAT(a.appt_date, '%h:%i %p')   AS time,
         u.user_name AS with_name
       FROM appts a
       LEFT JOIN users u ON a.appt_with = u.user
       WHERE a.appt_client_id = ?
       ORDER BY a.appt_date DESC`,
      [contactId],
    );
    result.appts = appts;
  }

  if (parts.includes('tasks')) {
    const [tasks] = await db.query(
      `SELECT
         t.task_id, t.task_status, t.task_title, t.task_desc,
         t.task_due, t.task_date,
         uf.user_name AS from_name,
         ut.user_name AS to_name
       FROM tasks t
       LEFT JOIN users uf ON t.task_from = uf.user
       LEFT JOIN users ut ON t.task_to   = ut.user
       WHERE (t.task_link_type = 'contact' AND t.task_link_id = ?)
          OR (t.task_link_type IS NULL AND t.task_link = ?)
       ORDER BY t.task_date DESC`,
      [String(contactId), String(contactId)]
    );
    result.tasks = tasks;
  }

  if (parts.includes('log')) {
    const [log] = await db.query(
      `SELECT
         l.log_id, l.log_type, l.log_date, l.log_data,
         l.log_from, l.log_to, l.log_subject, l.log_direction,
         u.user_name AS by_name
       FROM log l
       LEFT JOIN users u ON l.log_by = u.user
       WHERE (l.log_link_type = 'contact' AND l.log_link_id = ?)
          OR (l.log_link_type IS NULL AND l.log_link = ?)
       ORDER BY l.log_date DESC
       LIMIT ?`,
      [String(contactId), String(contactId), logLimit]
    );
    result.log = log;
  }

  if (parts.includes('sequences')) {
    const [sequences] = await db.query(
      `SELECT
         se.id, se.status, se.current_step, se.total_steps,
         se.cancel_reason, se.enrolled_at, se.completed_at,
         st.name AS template_name, st.type AS template_type
       FROM sequence_enrollments se
       JOIN sequence_templates st ON se.template_id = st.id
       WHERE se.contact_id = ?
       ORDER BY se.enrolled_at DESC`,
      [contactId]
    );
    result.sequences = sequences;
  }

  // Slice 3 Stage A: child-table includes via the per-service listers
  // (which already filter to active rows by default and include the
  // created_by_name / updated_by_name joins).
  if (parts.includes('phones')) {
    const r = await phoneSvc.listContactPhones(db, contactId);
    result.phones = r ? r.phones : [];
  }
  if (parts.includes('emails')) {
    const r = await emailSvc.listContactEmails(db, contactId);
    result.emails = r ? r.emails : [];
  }
  if (parts.includes('addresses')) {
    const r = await addrSvc.listContactAddresses(db, contactId);
    result.addresses = r ? r.addresses : [];
  }

  return result;
}


// ─────────────────────────────────────────────────────────────
// createContact — wrapped in transaction; dual-write to all three children
// ─────────────────────────────────────────────────────────────

/**
 * Create a new contact. Simple insert — no find-or-create logic.
 * (Use the intake routes for find-or-create.)
 *
 * DB triggers auto-compute contact_name, contact_lfm_name, contact_rname.
 *
 * SLICE 2 DUAL-WRITE: after the contacts INSERT, propagate the primary
 * phone/email/address into the corresponding child tables as primary-
 * active rows. force=true semantics for phone/email on cross-contact
 * collisions (silently transfer). Addresses have no collision check.
 *
 * The whole operation runs in a transaction so that if a child INSERT
 * fails non-recoverably, the contacts INSERT is rolled back too —
 * avoiding a drifted-state contact with no child rows.
 *
 * `phone2` / `email2` write to the legacy columns only; they are NOT
 * propagated to child tables (vestigial).
 *
 * @param {object} db
 * @param {object} opts
 * @param {object} [opts2]
 * @param {number} [opts2.userId=0]
 * @returns {{ contact_id: number, contact_name: string }}
 */
async function createContact(db, {
  fname,
  mname  = '',
  lname,
  phone  = '',
  email  = '',
  type   = 'Client',
  pname  = '',
  address = '',
  city   = '',
  state  = '',
  zip    = '',
  dob    = null,
  marital_status = null,
  phone2 = '',
  email2 = '',
  tags   = '',
  notes  = ''
}, { userId = 0 } = {}) {
  if (!fname) throw new Error('createContact requires fname');
  if (!lname) throw new Error('createContact requires lname');

  const normalizedPhone   = normalizePhone(phone);
  const normalizedPhone2  = normalizePhone(phone2);
  const normalizedEmail   = normalizeEmail(email);
  const normalizedEmail2  = normalizeEmail(email2);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Insert the contacts row
    const [result] = await conn.query(
      `INSERT INTO contacts
         (contact_fname, contact_mname, contact_lname, contact_pname,
          contact_phone, contact_email, contact_type,
          contact_address, contact_city, contact_state, contact_zip,
          contact_dob, contact_marital_status,
          contact_phone2, contact_email2,
          contact_tags, contact_notes, contact_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        fname, mname, lname, pname,
        normalizedPhone, normalizedEmail, type,
        address, city, state, zip,
        dob, marital_status,
        normalizedPhone2, normalizedEmail2,
        tags, notes
      ]
    );

    const newId = result.insertId;

    // 2. Propagate phone (force=true semantics on cross-contact collision)
    if (normalizedPhone) {
      const [[collision]] = await conn.query(
        `SELECT id, contact_id FROM contact_phones
          WHERE phone = ? AND end_date IS NULL`,
        [normalizedPhone]
      );
      if (collision) {
        await conn.query(
          `UPDATE contact_phones
              SET end_date = CURDATE(), is_primary = 0,
                  end_reason = 'transferred', updated_by = ?
            WHERE id = ?`,
          [userId, collision.id]
        );
        await recomputePrimaryPhone(conn, collision.contact_id);
      }

      await conn.query(
        `INSERT INTO contact_phones
           (contact_id, phone, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [newId, normalizedPhone, userId, userId]
      );
      await recomputePrimaryPhone(conn, newId);
    }

    // 3. Propagate email (parallel to phone)
    if (normalizedEmail) {
      const [[collision]] = await conn.query(
        `SELECT id, contact_id FROM contact_emails
          WHERE email = ? AND end_date IS NULL`,
        [normalizedEmail]
      );
      if (collision) {
        await conn.query(
          `UPDATE contact_emails
              SET end_date = CURDATE(), is_primary = 0,
                  end_reason = 'transferred', updated_by = ?
            WHERE id = ?`,
          [userId, collision.id]
        );
        await recomputePrimaryEmail(conn, collision.contact_id);
      }

      await conn.query(
        `INSERT INTO contact_emails
           (contact_id, email, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, 1, CURDATE(), ?, ?)`,
        [newId, normalizedEmail, userId, userId]
      );
      await recomputePrimaryEmail(conn, newId);
    }

    // 4. Propagate address (no collision check)
    if (address || city || state || zip) {
      await conn.query(
        `INSERT INTO contact_addresses
           (contact_id, address1, address2, city, state, zip, country,
            label, is_primary, start_date, created_by, updated_by)
         VALUES (?, ?, '', ?, ?, ?, 'US', 'Other', 1, CURDATE(), ?, ?)`,
        [newId, address || '', city || '', state || '', zip || '',
         userId, userId]
      );
      await recomputePrimaryAddress(conn, newId);
    }

    // 5. Re-fetch to get trigger-computed name fields
    const [[created]] = await conn.query(
      'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?',
      [newId]
    );

    await conn.commit();
    return { contact_id: newId, contact_name: created.contact_name };
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}


// ─────────────────────────────────────────────────────────────
// updateContact — Slice 3 Stage A — scalar + aggregate reconcile
// ─────────────────────────────────────────────────────────────

/**
 * Update one or more fields on a contact.
 *
 * Whitelist enforced — blocks PK, SSN, and trigger-computed fields.
 * DB trigger handles: recomputing name fields + logging changes on the
 * contacts row.
 *
 * SLICE 2 DUAL-WRITE: when contact_phone / contact_email /
 * contact_address|city|state|zip appear in `fields` (and no aggregate
 * array is also supplied for that kind), the legacy single-value
 * propagator updates the primary-active child row.
 *
 * SLICE 3 STAGE A: when `phones` / `emails` / `addresses` arrays are
 * supplied in `fields`, the aggregate reconciler is the source of truth
 * for that kind. Legacy propagation for the same kind is skipped.
 *
 *   - Validation errors across all three kinds are collected and thrown
 *     together (Error with .errors = { phones: [...], emails: [...],
 *     addresses: [...], contact: [...] }).
 *   - Cross-contact collisions are thrown as Error with .conflicts =
 *     [{ kind, from_contact_id, ... }, ...] when !force; force=true
 *     converts collisions into silent donor-ends in the same
 *     transaction.
 *
 * `contact_phone2` / `contact_email2` write to the legacy columns only;
 * they are NOT propagated to child tables (vestigial).
 *
 * The whole operation runs in a transaction so the contacts UPDATE,
 * legacy propagation (where applicable), and aggregate reconcilers land
 * atomically.
 *
 * @param {object} db
 * @param {number} contactId
 * @param {object} fields - column: value pairs (+ optional phones/emails/addresses arrays)
 * @param {object} [opts]
 * @param {number} [opts.userId=0]
 * @param {boolean} [opts.force=false]   - silent transfer on cross-contact phone/email collision
 * @returns {{ contact_id: number, updated_fields: string[], phones_changed?, emails_changed?, addresses_changed?, transferred_from? }}
 */
async function updateContact(db, contactId, fields, { userId = 0, force = false } = {}) {
  if (!fields || !Object.keys(fields).length) {
    throw new Error('updateContact requires at least one field');
  }

  // Detect aggregate arrays. Use hasOwnProperty so `phones: []` (empty
  // array, "end all current") is distinguishable from `phones` absent.
  const hasPhones    = Object.prototype.hasOwnProperty.call(fields, 'phones');
  const hasEmails    = Object.prototype.hasOwnProperty.call(fields, 'emails');
  const hasAddresses = Object.prototype.hasOwnProperty.call(fields, 'addresses');

  const phones    = hasPhones    ? fields.phones    : undefined;
  const emails    = hasEmails    ? fields.emails    : undefined;
  const addresses = hasAddresses ? fields.addresses : undefined;

  if (hasPhones    && !Array.isArray(phones))    throw new Error('phones must be an array');
  if (hasEmails    && !Array.isArray(emails))    throw new Error('emails must be an array');
  if (hasAddresses && !Array.isArray(addresses)) throw new Error('addresses must be an array');

  // Strip nested keys + (when aggregate supplied) the corresponding
  // mirror scalars — the reconciler is authoritative and the scalar
  // would be silently overridden by the mirror recompute anyway. Keep
  // contact_phone2 / contact_email2 (vestigial; not governed by aggregates).
  const scalarFields = { ...fields };
  delete scalarFields.phones;
  delete scalarFields.emails;
  delete scalarFields.addresses;
  if (hasPhones)    delete scalarFields.contact_phone;
  if (hasEmails)    delete scalarFields.contact_email;
  if (hasAddresses) {
    delete scalarFields.contact_address;
    delete scalarFields.contact_city;
    delete scalarFields.contact_state;
    delete scalarFields.contact_zip;
  }

  const ALLOWED = new Set([
    'contact_type', 'contact_fname', 'contact_mname', 'contact_lname',
    'contact_pname', 'contact_phone', 'contact_email',
    'contact_address', 'contact_city', 'contact_state', 'contact_zip',
    'contact_dob', 'contact_marital_status', 'contact_ssn',
    'contact_tags', 'contact_notes', 'contact_clio_id',
    'contact_phone2', 'contact_email2'
  ]);

  const keys = Object.keys(scalarFields);
  const blocked = keys.filter(k => !ALLOWED.has(k));
  if (blocked.length) {
    throw new Error(`updateContact: blocked columns: ${blocked.join(', ')}`);
  }

  // Normalize phone + email fields if present
  const normalized = { ...scalarFields };
  if (normalized.contact_phone)  normalized.contact_phone  = normalizePhone(normalized.contact_phone);
  if (normalized.contact_phone2) normalized.contact_phone2 = normalizePhone(normalized.contact_phone2);
  if (normalized.contact_email)  normalized.contact_email  = normalizeEmail(normalized.contact_email);
  if (normalized.contact_email2) normalized.contact_email2 = normalizeEmail(normalized.contact_email2);

  const finalKeys = Object.keys(normalized);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Scalar UPDATE on contacts (if any scalar fields remain)
    if (finalKeys.length > 0) {
      const setClauses = finalKeys.map(k => `\`${k}\` = ?`).join(', ');
      const values = [...finalKeys.map(k => normalized[k]), contactId];
      const [result] = await conn.query(
        `UPDATE contacts SET ${setClauses}, contact_updated = NOW() WHERE contact_id = ?`,
        values
      );
      if (result.affectedRows === 0) {
        throw new Error(`Contact ${contactId} not found`);
      }
    } else {
      // No scalar updates; verify the contact exists so the reconcilers
      // operate on a real row.
      const [[existsRow]] = await conn.query(
        `SELECT contact_id FROM contacts WHERE contact_id = ?`,
        [contactId]
      );
      if (!existsRow) {
        throw new Error(`Contact ${contactId} not found`);
      }
    }

    // 2. Legacy propagation — SKIP each kind when its aggregate counterpart is supplied
    if ('contact_phone' in normalized && !hasPhones) {
      await _propagatePhone(conn, contactId, normalized.contact_phone || '', userId);
    }
    if ('contact_email' in normalized && !hasEmails) {
      await _propagateEmail(conn, contactId, normalized.contact_email || '', userId);
    }
    const addrKeys = ['contact_address', 'contact_city', 'contact_state', 'contact_zip'];
    if (addrKeys.some(k => k in normalized) && !hasAddresses) {
      await _propagateAddress(conn, contactId, normalized, userId);
    }

    // 3. PLAN all aggregate kinds first — accumulate errors/conflicts
    //    across all three so the route can surface them together.
    const phonePlanRes = hasPhones    ? await _planPhones(conn, contactId, phones, force) : null;
    const emailPlanRes = hasEmails    ? await _planEmails(conn, contactId, emails, force) : null;
    const addrPlanRes  = hasAddresses ? await _planAddresses(conn, contactId, addresses)   : null;

    const errorMap = {};
    if (phonePlanRes && phonePlanRes.errors.length) errorMap.phones    = phonePlanRes.errors;
    if (emailPlanRes && emailPlanRes.errors.length) errorMap.emails    = emailPlanRes.errors;
    if (addrPlanRes  && addrPlanRes.errors.length)  errorMap.addresses = addrPlanRes.errors;
    if (Object.keys(errorMap).length) {
      const totalErrs = Object.values(errorMap).reduce((n, a) => n + a.length, 0);
      const e = new Error(`Validation failed on ${totalErrs} row(s)`);
      e.errors = errorMap;
      throw e;
    }

    // Conflicts (force=false case) — collected across kinds
    const allConflicts = [];
    if (phonePlanRes && phonePlanRes.conflicts.length) allConflicts.push(...phonePlanRes.conflicts);
    if (emailPlanRes && emailPlanRes.conflicts.length) allConflicts.push(...emailPlanRes.conflicts);
    if (allConflicts.length) {
      const e = new Error(
        `Cross-contact conflict on ${allConflicts.length} value(s) — retry with ?force=true to transfer`
      );
      e.conflicts = allConflicts;
      throw e;
    }

    // 4. APPLY each plan in the order phones → emails → addresses.
    let phoneResult = null, emailResult = null, addrResult = null;
    if (phonePlanRes) phoneResult = await _applyPhonePlan(conn, contactId, phonePlanRes.plan, userId);
    if (emailPlanRes) emailResult = await _applyEmailPlan(conn, contactId, emailPlanRes.plan, userId);
    if (addrPlanRes)  addrResult  = await _applyAddressPlan(conn, contactId, addrPlanRes.plan, userId);

    await conn.commit();

    // 5. Build response
    const transferredFrom = [
      ...((phoneResult && phoneResult.transferred_from) || []),
      ...((emailResult && emailResult.transferred_from) || []),
    ];

    const resp = {
      contact_id: parseInt(contactId, 10),
      updated_fields: finalKeys,
    };
    if (hasPhones)    resp.phones_changed    = phoneResult.phones_changed;
    if (hasEmails)    resp.emails_changed    = emailResult.emails_changed;
    if (hasAddresses) resp.addresses_changed = addrResult.addresses_changed;
    if (transferredFrom.length) resp.transferred_from = transferredFrom;
    return resp;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * List sequence enrollments for a contact with pagination, status filter,
 * and active/all scope.
 */
async function listContactSequences(db, contactId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const [[row]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!row) return null;

  const effectiveStatus = status || (scope === 'active' ? 'active' : null);

  const whereParts  = ['se.contact_id = ?'];
  const whereParams = [contactId];
  if (effectiveStatus) {
    whereParts.push('se.status = ?');
    whereParams.push(effectiveStatus);
  }
  const whereSQL = whereParts.join(' AND ');

  const [sequences] = await db.query(
    `SELECT
       se.id           AS enrollment_id,
       se.template_id,
       se.status,
       se.current_step,
       se.total_steps,
       se.cancel_reason,
       se.enrolled_at,
       se.completed_at,
       se.updated_at,
       st.name         AS template_name,
       st.type         AS template_type
     FROM sequence_enrollments se
     JOIN sequence_templates st ON st.id = se.template_id
     WHERE ${whereSQL}
     ORDER BY se.enrolled_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM sequence_enrollments se WHERE ${whereSQL}`,
    whereParams
  );

  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM sequence_enrollments
      WHERE contact_id = ? AND status = 'active'`,
    [contactId]
  );

  return { sequences, total, active_total };
}

/**
 * List workflow executions tied to a contact.
 */
async function listContactWorkflows(db, contactId, {
  limit  = 50,
  offset = 0,
  status = null,
  scope  = 'active',
} = {}) {
  const [[row]] = await db.query(
    `SELECT contact_id FROM contacts WHERE contact_id = ?`,
    [contactId]
  );
  if (!row) return null;

  const NON_TERMINAL = ['active', 'processing', 'delayed'];

  const whereParts  = ['we.contact_id = ?'];
  const whereParams = [contactId];
  if (status) {
    whereParts.push('we.status = ?');
    whereParams.push(status);
  } else if (scope === 'active') {
    whereParts.push(`we.status IN (${NON_TERMINAL.map(() => '?').join(',')})`);
    whereParams.push(...NON_TERMINAL);
  }
  const whereSQL = whereParts.join(' AND ');

  const [workflows] = await db.query(
    `SELECT
       we.id                     AS execution_id,
       we.workflow_id,
       we.status,
       we.current_step_number,
       we.steps_executed_count,
       we.cancel_reason,
       we.created_at,
       we.updated_at,
       we.completed_at,
       w.name                    AS workflow_name
     FROM workflow_executions we
     LEFT JOIN workflows w ON w.id = we.workflow_id
     WHERE ${whereSQL}
     ORDER BY we.created_at DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, parseInt(limit, 10), parseInt(offset, 10)]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM workflow_executions we WHERE ${whereSQL}`,
    whereParams
  );

  const placeholders = NON_TERMINAL.map(() => '?').join(',');
  const [[{ active_total }]] = await db.query(
    `SELECT COUNT(*) AS active_total
       FROM workflow_executions
      WHERE contact_id = ? AND status IN (${placeholders})`,
    [contactId, ...NON_TERMINAL]
  );

  return { workflows, total, active_total };
}

module.exports = {
  listContacts,
  getContact,
  createContact,
  updateContact,
  normalizePhone,
  normalizeEmail,
  listContactSequences,
  listContactWorkflows,
  stripSsn
};