// lib/internal_functions/contacts.js
const contactService = require('../../services/contactService');

const fns = {};

// ─────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────

/**
 * lookup_contact
 * Fetch a contact row and return it as output.
 * Use set_vars in the step config to map fields into workflow variables.
 *
 * params:
 *   contact_id  {number|string}  — can be a {{variable}}
 *
 * example config:
 *   {
 *     "function_name": "lookup_contact",
 *     "params": { "contact_id": "{{contactId}}" },
 *     "set_vars": {
 *       "contact_first_name": "{{this.contact_fname}}",
 *       "contact_phone":      "{{this.contact_phone}}",
 *       "contact_email":      "{{this.contact_email}}"
 *     }
 *   }
 */

fns.lookup_contact = async (params, db) => {
    const { contact_id } = params;
    if (!contact_id) throw new Error('lookup_contact requires contact_id');

    console.log(`[LOOKUP_CONTACT] id=${contact_id}`);

    const [[row]] = await db.query(
      `SELECT contact_id, contact_kind, contact_org_name, contact_fname, contact_lname, contact_name, contact_pname, contact_phone, contact_phone2, contact_email, contact_email2, contact_type, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_ssn, contact_tags, contact_notes, contact_clio_id, contact_created FROM contacts WHERE contact_id = ?`,
      [contact_id]
    );

    if (!row) throw new Error(`Contact ${contact_id} not found`);

    return {
      success: true,
      output: row   // entire row available as {{this.column_name}}
    };
  };

fns.lookup_contact.__meta = {
  category: 'contacts',
  description:
    'Fetch a contact row and return it as output. Use set_vars to map fields into variables. ' +
    'Includes contact_kind (person|org) and contact_org_name — branch on contact_kind before ' +
    'using contact_fname, which is blank on org contacts. Includes contact_ssn (2026-09-24 ' +
    'ruling: an ordinary column) — note the step log records whatever you map out of it.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
  ],
  example: { contact_id: '{{contactId}}' }
};

/**
 * find_contact
 * Find contacts by phone and/or email value. Pure read; returns ALL
 * matches without picking a winner — caller decides on ambiguity.
 *
 * Wraps contactService.resolveContactsByValue. See that function for
 * normalization, source precedence (child_active > child_ended >
 * legacy_primary > legacy_secondary), and fail-soft input behavior.
 *
 * At least one of phone / email is required.
 *
 * params:
 *   phone                    {string?}   — phone value (any format).
 *                                          Normalized to 10 digits.
 *   email                    {string?}   — email value.
 *                                          Trimmed + lowercased.
 *   include_ended            {boolean?}  — default true.
 *   include_legacy_secondary {boolean?}  — default true.
 *
 * Output namespace (under {{this.*}}):
 *   matches       array of MatchEntry
 *   count         matches.length
 *   first         matches[0] or null   (most common single-match case)
 *   is_ambiguous  matches.length > 1   (use to branch on divergence)
 *   summary       {phone_normalized, email_normalized, total_matches}
 *
 * example config:
 *   {
 *     "function_name": "find_contact",
 *     "params": { "phone": "{{trigger.from_phone}}" },
 *     "set_vars": {
 *       "resolvedContactId": "{{this.first.contact_id}}",
 *       "isAmbiguous":       "{{this.is_ambiguous}}"
 *     }
 *   }
 */

fns.find_contact = async (params, db) => {
    const {
      phone = null,
      email = null,
      include_ended,
      include_legacy_secondary,
    } = params || {};

    if ((phone == null || phone === '') && (email == null || email === '')) {
      throw new Error('find_contact requires phone or email');
    }

    const result = await contactService.resolveContactsByValue(
      db,
      { phone, email },
      { include_ended, include_legacy_secondary }
    );

    const matches = result.matches;
    const count   = matches.length;
    const first   = count > 0 ? matches[0] : null;

    console.log(
      `[FIND_CONTACT] phone=${result.summary.phone_normalized || 'null'} ` +
      `email=${result.summary.email_normalized || 'null'} → matches=${count}`
    );

    return {
      success: true,
      output: {
        matches,
        count,
        first,
        is_ambiguous: count > 1,
        summary: result.summary,
      },
    };
  };

fns.find_contact.__meta = {
  category: 'contacts',
  description: 'Find contacts by phone and/or email value. Returns ALL matches; caller decides on ambiguity.',
  params: [
    { name: 'phone', type: 'string', required: false, placeholderAllowed: true,
      description: 'Phone value (any format). Normalized to 10 digits before search.',
      example: '{{trigger.from_phone}}' },
    { name: 'email', type: 'string', required: false, placeholderAllowed: true,
      description: 'Email value (any case/spacing). Trimmed + lowercased before search.',
      example: '{{trigger.from_email}}' },
    { name: 'include_ended', type: 'boolean', required: false, default: true,
      description: 'Include ended child-table rows (orphan-log auto-re-adopt). Default true.' },
    { name: 'include_legacy_secondary', type: 'boolean', required: false, default: true,
      description: 'Also check contact_phone2 / contact_email2. Default true.' },
  ],
  requiredWith: [['phone', 'email']],
  example: { phone: '{{trigger.from_phone}}' }
};

// ─────────────────────────────────────────────────────────────
// update_contact
// ─────────────────────────────────────────────────────────────

/**
 * update_contact
 * Update one or more scalar fields on a contact row.
 *
 * CUSTOM-FIELDS S0: this is a thin adapter over contactService.updateContact.
 * It used to compose its own `UPDATE contacts SET ...`, which meant automation
 * writes skipped every service-side guard, emitted no event, and never touched
 * the child phone/email/address rows the rest of the system reads. One writer
 * per entity is the precondition for moving field storage underneath callers,
 * so the SQL lives in the service now. The one thing this function still
 * decides is the SHAPE of what the automation surface may hand it:
 *
 *   - phones / emails / addresses are REJECTED. The service accepts those
 *     arrays and hands them to the aggregate reconcilers, which can END child
 *     rows; nothing could reach that path from here before, and opening it to
 *     automations is a separate decision.
 *
 * Everything else — the 21-column whitelist, contact_kind validation, the
 * kind-switch/org-name coupling, note-length and blank-date handling, phone and
 * email normalization, legacy→child mirror propagation, the contact.updated
 * emission, and the Google push — belongs to the service. Do NOT re-add a
 * whitelist here: the service's ALLOWED set is byte-identical to the one this
 * function used to keep, so a copy would only rot. (update_case still keeps its
 * own whitelist for the opposite reason: caseService.updateCase blocks nothing
 * but the PK, so there the fn-side list IS the only gate.)
 *
 * contact_ssn is an ORDINARY COLUMN here — writable, logged, no special case.
 * It was stripped for about ten minutes on 2026-09-24 and Fred reversed it: a
 * bankruptcy firm puts the SSN on Form 121, staff read it all day, and the
 * automation surface has no reason to be the one place that cannot write it.
 * Do not re-add a strip here. What stays closed is narrower and for a
 * different reason: domainEvents strips SSN from envelopes (they persist
 * independently of the contact) and portal cards may never carry it (those go
 * to clients, not staff).
 *
 * The kind guard is now resulting-row-shaped, not patch-shaped: contact_kind
 * 'org' alone is accepted when contact_org_name is already stored, and → person
 * requires fname + lname the same way. It also blanks the outgoing kind's source
 * columns, so `updated_fields` can name columns the caller never passed.
 *
 * A contact_phone / contact_email write that collides with ANOTHER contact's
 * value now throws (force is left false on purpose — an automation must not
 * silently move a phone number off someone else's record).
 *
 * The DB trigger `contact_name_update` auto-recomputes derived name fields
 * when fname/mname/lname change. The DB trigger `after_contact_update`
 * auto-logs all changes to the log table — no need to log from here.
 *
 * params:
 *   contact_id  {number|string}  — target contact
 *   fields      {object}         — scalar column: value pairs
 *
 * example config:
 *   {
 *     "function_name": "update_contact",
 *     "params": {
 *       "contact_id": "{{contactId}}",
 *       "fields": { "contact_tags": "intake-complete", "contact_type": "Client" }
 *     }
 *   }
 */

fns.update_contact = async (params, db) => {
    const { contact_id, fields } = params;
    if (!contact_id) throw new Error('update_contact requires contact_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_contact requires a non-empty fields object');
    }

    // Scalar-only surface — see the header.
    const aggregates = ['phones', 'emails', 'addresses']
      .filter(k => Object.prototype.hasOwnProperty.call(fields, k));
    if (aggregates.length) {
      throw new Error(
        `update_contact: ${aggregates.join(', ')} not supported here — this function ` +
        'writes scalar columns only'
      );
    }

    console.log(`[UPDATE_CONTACT] id=${contact_id} fields=${JSON.stringify(fields)}`);

    // userId 0 is the established automation pseudo-user. There is no `source`
    // option on this service (caseService.updateCase has one, contactService
    // does not) — a future contact.updated rule that needs to exclude
    // automation writes has to match on actor.user_id === 0.
    const result = await contactService.updateContact(db, contact_id, fields, {
      userId: 0,
      force: false,
    });

    return {
      success: true,
      // updated_fields is what the service ACTUALLY applied (post-strip,
      // post-normalize, plus any column the kind guard blanked) — not the keys
      // that came in.
      output: { contact_id, updated_fields: result.updated_fields }
    };
  };

fns.update_contact.__meta = {
  category: 'contacts',
  description:
    'Update one or more scalar fields on a contact row. Delegates to contactService.updateContact — ' +
    'the service owns the column whitelist, the kind guards, mirror propagation to the child ' +
    'phone/email/address rows, and the contact.updated event. Whitelisted columns only. ' +
    'Scalar columns only: phones / emails / addresses arrays are rejected here.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Allowed: contact_kind, contact_org_name, contact_type, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone, contact_email, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_ssn, contact_tags, contact_notes, contact_clio_id, contact_phone2, contact_email2. contact_kind is "person" or "org"; the resulting row must have contact_org_name (org) or contact_fname + contact_lname (person) — supply what is missing in the same call.',
      example: { contact_tags: 'intake-complete', contact_type: 'Client' } },
  ],
  example: { contact_id: '{{contactId}}', fields: { contact_type: 'Client' } }
};

module.exports = fns;
