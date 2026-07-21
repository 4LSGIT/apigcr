// services/esign/placements.js
//
/**
 * NEUTRAL PLACEMENT SCHEMA — the validator, and only the validator.
 * services/esign/placements.js
 *
 * Phase 2A. Extracted from zohoSignProvider.neutralToZohoFields, which until
 * now was both the validator and the Zoho coordinate transform. The transform
 * stays where it belongs (vendor dialect); the schema rules move here because
 * TWO layers need them and neither should own the other:
 *
 *   services/esignSendService.js   validates BEFORE createRequest, so a bad
 *                                  placement never mints an orphan draft row
 *   services/esign/zohoSignProvider.js
 *                                  validates before the network call, so a bad
 *                                  placement never costs an API call or credit
 *
 * The alternative — the neutral send service requiring a file called
 * `zohoSignProvider` to find out whether ITS input is well formed — would put
 * the vendor's name in the one layer whose whole job is not knowing it.
 *
 * ── THE SCHEMA ──────────────────────────────────────────────────────────────
 *
 *   { coord_space: 'pdf_user_space',          // optional; only value accepted
 *     fields: [ { page:   number,   // 1-BASED
 *                 x:      number,   // points, from the page's LEFT edge
 *                 y:      number,   // points, from the page's BOTTOM edge
 *                 w:      number,   // points
 *                 h:      number,   // points
 *                 type:   'signature' | 'initial' | 'date' | 'text' |
 *                         'input_text' | 'checkbox' | 'dropdown' | 'radio',
 *                 signer: number,   // SIGNER fields: matches Recipient.order (1-based)
 *                 label:  string,   // SIGNER fields except radio, optional: what the
 *                                   //   SIGNER SEES on the signing page (Zoho renders
 *                                   //   field_name in the box; without this it shows
 *                                   //   'Signature_4' etc.)
 *                 key:    string,   // TEXT fields: prefill key this box is filled from
 *                 font_size: number // TEXT fields, optional: points; fill picks a default
 *
 *                 // ── per-type extras (Phase 2F, all signer-class) ─────────
 *                 max_length: number, // input_text, optional: 1..2048 char cap
 *                 default:    string, // input_text: signer-editable prefill text
 *                                     // dropdown: pre-selected option (must be
 *                                     //   one of `options`)
 *                 checked:    bool,   // checkbox / radio, optional: pre-ticked
 *                 options:  string[], // dropdown, REQUIRED: the choices, in order
 *                 group:      string, // radio, REQUIRED: which group this box
 *                                     //   belongs to (also its on-page name)
 *                 value:      string, // radio, REQUIRED: what picking THIS box
 *                                     //   means; unique within the group
 *               }, ... ] }
 *
 * ── TWO FIELD CLASSES (Phase 2E) ────────────────────────────────────────────
 * SIGNER fields (signature / initial / date / input_text / checkbox /
 * dropdown / radio) are placed for the SIGNER to act on — they are transmitted
 * to the provider, which renders them on its signing page. TEXT fields are
 * placed for US to act on — services/esign/pdfFill.js draws the resolved
 * prefill value into the box with pdf-lib BEFORE the document ever leaves the
 * building, and the provider NEVER sees them (zohoSignProvider.
 * neutralToZohoFields skips them). A text field carries `key` instead of
 * `signer`; the key names the prefill_schema entry (template flow) or the
 * ad-hoc value (one-time upload flow) whose value fills it.
 *
 * NAMING TRAP — 'text' vs 'input_text': `text` is OUR fill-before-send class
 * (ink on the page, signer never edits it); `input_text` is Zoho's Textfield —
 * a box the SIGNER types into on the signing page. They are different features
 * that happen to both involve text. The names are deliberately dissimilar.
 *
 * ── RADIO: ONE BOX PER OPTION (Phase 2F) ────────────────────────────────────
 * Zoho's wire shape is one Radiogroup field carrying a sub_fields array — the
 * GROUP has no geometry of its own; only the option circles do (verified by
 * live round-trip 2026-07-21). The neutral schema deliberately does NOT mirror
 * that nesting: each radio OPTION is its own placed box carrying {group,
 * value}, because the editor's whole interaction model is one-box-per-click
 * and a nested group object would need bespoke authoring UI for no schema
 * gain. The provider aggregates boxes sharing a `group` into one Zoho
 * Radiogroup at transform time.
 *
 * Group rules (enforced here so both layers agree):
 *   • `group` is a GLOBAL name within the document — a group belongs to
 *     exactly one signer. Two signers each wanting a "Approve?" group must
 *     name them differently.
 *   • `value` is unique within its group (it becomes Zoho's sub_field_name,
 *     which is unique per group by construction there too).
 *   • at most ONE box per group is `checked` (it becomes the group default).
 *   • `required` is a property of the GROUP: every box must agree (all
 *     `required:false` or none). A mixed group is a confused author — throw.
 *   • radio boxes carry NO `label`: the group name IS the on-page name.
 *
 * ── WHAT ZOHO CANNOT DO (probed live 2026-07-21, do not re-litigate) ────────
 * Textfield data validation (numeric / regex / etc) DOES NOT EXIST in Zoho
 * Sign's API. Zoho allowlists submit keys (code 9043 "Extra key found …"), and
 * every candidate — validation_type, validation, regex, data_type, top-level
 * and inside text_property — was rejected. `max_field_length` is the only
 * constraint the API accepts, hence `max_length` is the only one offered here.
 *
 * An EMPTY fields array is schema-valid. It is not necessarily SENDABLE —
 * Zoho rejects a submit whose actions carry no fields — but that is a provider
 * fact, and this file does not know about providers.
 *
 * Errors carry code 'ESIGN_INVALID_INPUT', matching the provider contract, so
 * callers already switching on that code need no change. Messages are NOT
 * vendor-prefixed here: this layer has no vendor.
 */

/** Every neutral field type, both classes. */
const NEUTRAL_FIELD_TYPES = Object.freeze([
  'signature', 'initial', 'date', 'text',
  'input_text', 'checkbox', 'dropdown', 'radio',
]);

/** The subset the provider transmits; everything else is filled locally. */
const SIGNER_FIELD_TYPES = Object.freeze([
  'signature', 'initial', 'date',
  'input_text', 'checkbox', 'dropdown', 'radio',
]);

/**
 * Text-field keys are identifiers, not prose: they must survive JSON keys,
 * querystrings and the template editor's schema table. Same spirit as the
 * scratch API's ns/k rule. 1–64 chars.
 */
const TEXT_KEY_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Bounds for signer-visible display strings.
 *
 * LABEL_MAX (60) is the shipped Phase 2E rule for `label` — unchanged.
 * OPTION_TEXT_MAX (100) bounds dropdown options and radio group/value names:
 * these render inside the field on Zoho's signing page, and a bankruptcy
 * option can legitimately run longer than a label ("Chapter 13 — 60-month
 * plan"), so the bound is looser but still a bound — varchar overflow in this
 * stack truncates SILENTLY (state doc), and silent truncation of a legal
 * option's meaning is exactly the failure mode to refuse loudly.
 */
const LABEL_MAX       = 60;
const OPTION_TEXT_MAX = 100;

/** input_text length cap ceiling. 2048 is Zoho's own default max_field_length
    (observed on the live round-trip probe, 2026-07-21). */
const INPUT_TEXT_MAX_LENGTH = 2048;

/** Dropdowns with more options than this are a data-entry UI, not a signature
    field; the editor cannot sensibly author them either. */
const DROPDOWN_MAX_OPTIONS = 50;

/**
 * Neutral `page` numbers are 1-BASED (the schema's example is "page":3).
 * Lives here rather than in the provider because it is a property of the
 * NEUTRAL schema; the provider's 0-based page_no is the thing that converts.
 */
const NEUTRAL_PAGE_BASE = 1;

function inputError(message) {
  const err = new Error(message);
  err.code = 'ESIGN_INVALID_INPUT';
  return err;
}

/** Non-empty trimmed string of at most `max` chars, or throw. Returns the
    TRIMMED value so all downstream comparisons (option uniqueness, default ∈
    options, group identity) happen on one canonical form. */
function displayText(v, max, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw inputError(`${where} must be a non-empty string`);
  }
  const t = v.trim();
  if (t.length > max) {
    throw inputError(`${where} must be at most ${max} characters (got ${t.length})`);
  }
  return t;
}

/**
 * Validate a neutral placements object. Throws on the first problem; returns
 * a normalized summary on success.
 *
 * PURE. No ids, no network, no db — callable from anywhere, at any point,
 * including before a row exists.
 *
 * @param {object} placements
 * @returns {{count:number, signers:number[]}} field count and the distinct
 *          1-based signer orders referenced, ascending.
 * @throws  ESIGN_INVALID_INPUT
 */
function validatePlacements(placements) {
  if (!placements || typeof placements !== 'object') {
    throw inputError('placements must be an object');
  }
  const { coord_space: coordSpace, fields } = placements;

  // Guard rather than silently mis-transform. The neutral schema declares one
  // coord space; if a caller ever introduces another, the provider's y-flip is
  // wrong and we want a throw, not a document with signatures in the margin.
  if (coordSpace != null && coordSpace !== 'pdf_user_space') {
    throw inputError(`unsupported coord_space "${coordSpace}" (expected pdf_user_space)`);
  }
  if (!Array.isArray(fields)) {
    throw inputError('placements.fields must be an array');
  }

  const signers = new Set();

  // Radio cross-box bookkeeping: group → accumulated facts, checked AFTER the
  // per-field loop because the boxes of one group may be scattered anywhere in
  // the array.
  const radioGroups = new Map(); // group → { signer, required, values:Set, checkedCount, firstIndex }

  fields.forEach((f, i) => {
    if (!f || typeof f !== 'object') {
      throw inputError(`placements.fields[${i}] must be an object`);
    }
    if (!NEUTRAL_FIELD_TYPES.includes(f.type)) {
      throw inputError(
        `placements.fields[${i}].type "${f.type}" unsupported ` +
        `(expected one of: ${NEUTRAL_FIELD_TYPES.join(', ')})`
      );
    }

    const page = Number.isInteger(f.page) ? f.page : NEUTRAL_PAGE_BASE;
    if (page - NEUTRAL_PAGE_BASE < 0) {
      throw inputError(`placements.fields[${i}].page ${page} is below the 1-based minimum`);
    }

    for (const k of ['x', 'y', 'w', 'h']) {
      if (!Number.isFinite(Number(f[k]))) {
        throw inputError(`placements.fields[${i}].${k} must be a finite number`);
      }
    }

    if (f.type === 'text') {
      // Filled locally: needs a key, has no signer. A text field carrying a
      // signer is a confused author (or a bug in the editor), and a fill run
      // that silently ignored it would hide that — so it throws.
      if (typeof f.key !== 'string' || !TEXT_KEY_RE.test(f.key)) {
        throw inputError(
          `placements.fields[${i}].key ${JSON.stringify(f.key)} invalid — text fields ` +
          `require a key matching ${TEXT_KEY_RE} naming the value that fills them`
        );
      }
      if (f.signer != null) {
        throw inputError(
          `placements.fields[${i}] is a text field and cannot carry a signer ` +
          `(text fields are filled before sending; signers never see them)`
        );
      }
      if (f.font_size != null && !(Number.isFinite(Number(f.font_size)) && Number(f.font_size) > 0)) {
        throw inputError(`placements.fields[${i}].font_size must be a positive number when present`);
      }
      return; // does not join the signer set
    }

    // ── signer-class fields from here on ─────────────────────────────────────

    if (f.label != null) {
      if (f.type === 'radio') {
        // The group name IS what the signer sees; a per-box label has nowhere
        // to render and a silently dropped one would hide the author's intent.
        throw inputError(
          `placements.fields[${i}] is a radio option and cannot carry a label — ` +
          `the group name is what the signer sees`
        );
      }
      // Shown verbatim to the SIGNER on the provider's signing page — bound
      // it like display text, not like an identifier.
      if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > LABEL_MAX) {
        throw inputError(
          `placements.fields[${i}].label must be a non-empty string of at most ${LABEL_MAX} characters when present`
        );
      }
    }

    if (f.type === 'input_text') {
      if (f.max_length != null) {
        const m = Number(f.max_length);
        if (!Number.isInteger(m) || m < 1 || m > INPUT_TEXT_MAX_LENGTH) {
          throw inputError(
            `placements.fields[${i}].max_length must be a whole number between 1 and ` +
            `${INPUT_TEXT_MAX_LENGTH} when present`
          );
        }
      }
      if (f.default != null) {
        if (typeof f.default !== 'string') {
          throw inputError(`placements.fields[${i}].default must be a string when present`);
        }
        const cap = f.max_length != null ? Number(f.max_length) : INPUT_TEXT_MAX_LENGTH;
        if (f.default.length > cap) {
          throw inputError(
            `placements.fields[${i}].default is ${f.default.length} characters but the ` +
            `field caps input at ${cap} — a prefill the signer could not have typed`
          );
        }
      }
    }

    if ((f.type === 'checkbox' || f.type === 'radio') && f.checked != null && typeof f.checked !== 'boolean') {
      throw inputError(`placements.fields[${i}].checked must be a boolean when present`);
    }

    if (f.type === 'dropdown') {
      if (!Array.isArray(f.options) || f.options.length === 0) {
        throw inputError(`placements.fields[${i}].options must be a non-empty array — a dropdown with nothing to pick is not a field`);
      }
      if (f.options.length > DROPDOWN_MAX_OPTIONS) {
        throw inputError(`placements.fields[${i}].options has ${f.options.length} entries (max ${DROPDOWN_MAX_OPTIONS})`);
      }
      const seen = new Set();
      const cleaned = f.options.map((opt, j) => {
        const t = displayText(opt, OPTION_TEXT_MAX, `placements.fields[${i}].options[${j}]`);
        if (seen.has(t)) {
          throw inputError(`placements.fields[${i}].options[${j}] "${t}" is a duplicate — options must be distinct`);
        }
        seen.add(t);
        return t;
      });
      if (f.default != null) {
        if (typeof f.default !== 'string' || !cleaned.includes(f.default.trim())) {
          throw inputError(
            `placements.fields[${i}].default ${JSON.stringify(f.default)} is not one of the options`
          );
        }
      }
    }

    const signer = Number.isInteger(f.signer) ? f.signer : 1;

    if (f.type === 'radio') {
      const group = displayText(f.group, OPTION_TEXT_MAX, `placements.fields[${i}].group`);
      const value = displayText(f.value, OPTION_TEXT_MAX, `placements.fields[${i}].value`);
      const required = f.required === false ? false : true;
      let g = radioGroups.get(group);
      if (!g) {
        g = { signer, required, values: new Set(), checkedCount: 0, firstIndex: i };
        radioGroups.set(group, g);
      } else {
        if (g.signer !== signer) {
          throw inputError(
            `radio group "${group}" spans signers ${g.signer} and ${signer} — a group ` +
            `belongs to exactly one signer (use differently named groups per signer)`
          );
        }
        if (g.required !== required) {
          throw inputError(
            `radio group "${group}" mixes required and optional boxes — required is a ` +
            `property of the group; make every box agree`
          );
        }
      }
      if (g.values.has(value)) {
        throw inputError(
          `radio group "${group}" has two boxes with value "${value}" — values must be ` +
          `unique within a group`
        );
      }
      g.values.add(value);
      if (f.checked === true) {
        g.checkedCount += 1;
        if (g.checkedCount > 1) {
          throw inputError(
            `radio group "${group}" has more than one checked box — at most one option ` +
            `can be the default`
          );
        }
      }
    }

    signers.add(signer);
  });

  return { count: fields.length, signers: [...signers].sort((a, b) => a - b) };
}

module.exports = {
  validatePlacements,
  NEUTRAL_FIELD_TYPES,
  SIGNER_FIELD_TYPES,
  TEXT_KEY_RE,
  NEUTRAL_PAGE_BASE,
  LABEL_MAX,
  OPTION_TEXT_MAX,
  INPUT_TEXT_MAX_LENGTH,
  DROPDOWN_MAX_OPTIONS,
};
