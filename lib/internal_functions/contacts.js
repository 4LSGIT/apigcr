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
      `SELECT contact_id, contact_fname, contact_lname, contact_name, contact_pname, contact_phone, contact_phone2, contact_email, contact_email2, contact_type, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_tags, contact_notes, contact_clio_id, contact_created FROM contacts WHERE contact_id = ?`,
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
  description: 'Fetch a contact row and return it as output. Use set_vars to map fields into variables.',
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
 * Update one or more fields on a contact row.
 *
 * Allowed columns are whitelisted. Blocked:
 *   contact_id       — PK, immutable
 *   contact_ssn      — sensitive, never writable via automation
 *   contact_name     — trigger-computed from fname/mname/lname
 *   contact_lfm_name — trigger-computed
 *   contact_rname    — trigger-computed
 *   contact_created  — set once at insert
 *   contact_updated  — auto-managed below
 *
 * The DB trigger `contact_name_update` auto-recomputes derived name
 * fields when fname/mname/lname change.
 * The DB trigger `after_contact_update` auto-logs all changes to the
 * log table — no need to log from here.
 *
 * params:
 *   contact_id  {number|string}  — target contact
 *   fields      {object}         — column: value pairs
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
 
    // Whitelist — only these columns may be set via this function
    const ALLOWED = new Set([
      'contact_type', 'contact_fname', 'contact_mname', 'contact_lname',
      'contact_pname', 'contact_phone', 'contact_email',
      'contact_address', 'contact_city', 'contact_state', 'contact_zip',
      'contact_dob', 'contact_marital_status', 'contact_ssn',
      'contact_tags', 'contact_notes', 'contact_clio_id',
      'contact_phone2', 'contact_email2'
    ]);
 
    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_contact: blocked columns: ${blocked.join(', ')}`);
    }
 
    console.log(`[UPDATE_CONTACT] id=${contact_id} fields=${JSON.stringify(fields)}`);
 
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => fields[k]), contact_id];
 
    const [result] = await db.query(
      `UPDATE contacts SET ${setClauses}, contact_updated = NOW() WHERE contact_id = ?`,
      values
    );
 
    if (result.affectedRows === 0) {
      throw new Error(`Contact ${contact_id} not found`);
    }
 
    return {
      success: true,
      output: { contact_id, updated_fields: keys }
    };
  };

fns.update_contact.__meta = {
  category: 'contacts',
  description: 'Update one or more fields on a contact row. Whitelisted columns only.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Allowed: contact_type, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone, contact_email, contact_address, contact_city, contact_state, contact_zip, contact_dob, contact_marital_status, contact_ssn, contact_tags, contact_notes, contact_clio_id, contact_phone2, contact_email2.',
      example: { contact_tags: 'intake-complete', contact_type: 'Client' } },
  ],
  example: { contact_id: '{{contactId}}', fields: { contact_type: 'Client' } }
};

module.exports = fns;
