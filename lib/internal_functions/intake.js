// lib/internal_functions/intake.js
//
// Intake functions (website-lead routing arc, 2026-09). New file →
// auto-registered by index.js's directory scan.
//
// intake_contact and intake_case expose services/intakeService.js — the same
// contact-upsert / case find-or-create logic behind POST /api/intake/contact
// and /api/intake/case — as workflow steps. Business outcomes that the HTTP
// route surfaces as 4xx (a 409 divergence, a missing name) are OUTPUT VALUES
// here, not thrown errors: workflows branch on {{this.output.action}} via
// evaluate_condition, and error_policy has no on-fail routing, so throwing
// would make divergence indistinguishable from a network fault. Only
// infrastructure failures throw.
//
// __meta.category is 'contacts' / 'cases' so these group with their peers in
// the pickers (README: category follows UI grouping, file placement follows
// cohesion — both functions cohere around the intake service, hence one file).

const fns = {};

/** Blank-tolerant positive-int parse for workflow-supplied ids.
 *  '' / null / undefined → null; anything else must parse cleanly. */
function intOrNull(v, name) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(v).trim()) {
    throw new Error(`${name} must be a positive integer (got "${v}")`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────
// intake_contact — create or update a contact by phone/email match.
// ─────────────────────────────────────────────────────────────
fns.intake_contact = async (params, db) => {
  const intakeService = require('../../services/intakeService'); // lazy (convention)

  const forceContactId = intOrNull(params.force_contact_id, 'intake_contact: force_contact_id');

  // Pass through exactly the body keys the service (and the HTTP route)
  // accept. Absent params stay absent — the service's partial-update fix
  // depends on undefined meaning "not supplied", so no || '' defaults here.
  const body = {};
  const PASSTHROUGH = [
    'name', 'fname', 'mname', 'lname', 'phone', 'email', 'duplicate',
    'contact_address', 'contact_city', 'contact_state', 'contact_zip',
    'contact_dob', 'contact_notes', 'contact_tags', 'contact_type',
    'contact_pname', 'contact_kind', 'contact_org_name',
  ];
  for (const k of PASSTHROUGH) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
      body[k] = params[k];
    }
  }

  const result = await intakeService.intakeContact(db, body, { forceContactId });

  switch (result.outcome) {
    case 'created':
    case 'updated':
      return {
        success: true,
        output: {
          action:       result.outcome,
          contact_id:   result.contact_id,
          contact_name: result.name,
          message:      `contact ${result.contact_id} ${result.outcome}`,
          conflicts:    [],
          conflict_ids: '',
        },
      };

    case 'diverged': {
      const ids = (result.conflicts || []).map(c => c.contact_id);
      return {
        success: true,
        output: {
          action:       'diverged',
          contact_id:   null,
          contact_name: null,
          message:      `Multiple contacts match (${ids.join(', ')}) — needs a human`,
          conflicts:    result.conflicts || [],
          conflict_ids: ids.join(','),
        },
      };
    }

    case 'invalid':
    case 'force_mismatch':
      return {
        success: true,
        output: {
          action:       'invalid',
          contact_id:   null,
          contact_name: null,
          message:      result.outcome === 'force_mismatch'
            ? `force_contact_id ${result.forceContactId} is not among matches`
            : result.message,
          conflicts:    result.conflicts || [],
          conflict_ids: (result.conflicts || []).map(c => c.contact_id).join(','),
        },
      };

    default:
      throw new Error(`intake_contact: unknown service outcome "${result.outcome}"`);
  }
};
fns.intake_contact.__meta = {
  category: 'contacts',
  description: 'Create or update a contact by phone/email value match — the same upsert POST /api/intake/contact performs (resolveContactsByValue over child tables + legacy columns, ended rows included). 0 matches → CREATE (needs a name); 1 match → partial UPDATE (only supplied fields written; empty values never clear); 2+ matches → NOTHING WRITTEN and output.action="diverged" with the candidate list — branch on it and hand the resolution to a human (this function never guesses). Bad input (missing name on create, invalid phone) → action="invalid", also without throwing. Output: action (created|updated|diverged|invalid), contact_id, contact_name, message, conflicts (array of {contact_id, contact_name, contact_phone, contact_email, matched_by_phone, matched_by_email}), conflict_ids (comma-joined, for templating). Branch on {{this.output.action}} via evaluate_condition; only infrastructure errors throw.',
  params: [
    { name: 'name', type: 'string', required: false, placeholderAllowed: true,
      description: 'Full name, parsed into first/middle/last. Ignored per-slot when fname/mname/lname are supplied.',
      example: '{{contact.name}}' },
    { name: 'fname', type: 'string', required: false, placeholderAllowed: true,
      description: 'First name (db-style slot; wins over `name` for its slot). CREATE requires fname AND lname (or `name`).' },
    { name: 'mname', type: 'string', required: false, placeholderAllowed: true },
    { name: 'lname', type: 'string', required: false, placeholderAllowed: true },
    { name: 'phone', type: 'string', required: false, placeholderAllowed: true,
      description: 'Match/write value; normalized to 10 digits (leading 1 stripped). Wrong digit count → action="invalid".',
      example: '{{contact.phone}}' },
    { name: 'email', type: 'string', required: false, placeholderAllowed: true,
      example: '{{contact.email}}' },
    { name: 'duplicate', type: 'string', required: false, placeholderAllowed: true,
      description: '"duplicate" skips matching and forces CREATE. Anything else (default) = upsert.' },
    { name: 'force_contact_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Disambiguates a 2+ match: must be one of the candidate ids or the result is action="invalid". Cannot combine with duplicate="duplicate".' },
    { name: 'contact_address', type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_city',    type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_state',   type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_zip',     type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_dob',     type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_notes',   type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_tags',    type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_type',    type: 'string', required: false, placeholderAllowed: true,
      description: 'contacts.contact_type role label on CREATE (default "Client").' },
    { name: 'contact_pname',   type: 'string', required: false, placeholderAllowed: true },
    { name: 'contact_kind', type: 'enum', required: false, enum: ['person', 'org'],
      description: '"org" skips value-matching entirely and always CREATEs (orgs share phones/emails with their officers). Requires contact_org_name.' },
    { name: 'contact_org_name', type: 'string', required: false, placeholderAllowed: true },
  ],
  example: {
    name:  '{{contact.name}}',
    phone: '{{contact.phone}}',
    email: '{{contact.email}}',
  },
};

// ─────────────────────────────────────────────────────────────
// intake_case — find, reuse, or create a case for a contact.
// ─────────────────────────────────────────────────────────────
fns.intake_case = async (params, db) => {
  const intakeService = require('../../services/intakeService'); // lazy (convention)

  const contactId = intOrNull(params.contact_id, 'intake_case: contact_id');
  if (contactId == null) throw new Error('intake_case requires contact_id');

  const reuse = String(params.reuse ?? 'intake').trim().toLowerCase();
  if (!['intake', 'same_type', 'never'].includes(reuse)) {
    throw new Error(`intake_case: reuse must be intake | same_type | never (got "${params.reuse}")`);
  }

  const caseType    = (params.case_type    == null) ? '' : String(params.case_type).trim();
  const caseSubtype = (params.case_subtype == null) ? '' : String(params.case_subtype).trim();

  // ── Reuse an open intake-pipeline case (cross-type, deliberately) ──
  // A second submission from a different site (MDBL typed Bankruptcy, LSG
  // blank) lands on the SAME lead case instead of spawning a sibling for
  // the merge tool. Only cases whose latest case_stage_log row sits on a
  // non-terminal role='intake' stage qualify — legacy 'Open' rows with no
  // pipeline history never match, and neither do retained matters.
  if (reuse === 'intake') {
    const hit = await intakeService.findIntakeCase(db, contactId);
    if (hit) {
      const otherOpen = await intakeService.countOpenCases(db, contactId, { excludeCaseId: hit.case_id });
      return {
        success: true,
        output: {
          action:           'reused',
          case_id:          hit.case_id,
          case_relate_id:   null,
          stage_key:        hit.stage_key,
          other_open_cases: otherOpen,
          message:          `reusing intake case ${hit.case_id} (stage ${hit.stage_key})`,
        },
      };
    }
  }

  // ── Find-or-create through the shared service ──
  // reuse='intake' MISS forces a fresh case (duplicate path): the same-type
  // find would otherwise glom a new lead onto one of the ~700 legacy
  // case_stage='Open' rows, which is exactly what the intake-scoped reuse
  // above exists to avoid. reuse='same_type' keeps the route's classic
  // behavior; reuse='never' always creates.
  const duplicate = (reuse === 'same_type') ? 'return' : 'duplicate';

  const result = await intakeService.intakeCase(
    db,
    { contact_id: contactId, case_type: caseType, case_subtype: caseSubtype, duplicate },
    { allowBlankType: true }
  );

  switch (result.outcome) {
    case 'found':
    case 'created': {
      const otherOpen = await intakeService.countOpenCases(db, contactId, { excludeCaseId: result.case_id });
      return {
        success: true,
        output: {
          action:           result.outcome,
          case_id:          result.case_id,
          case_relate_id:   result.outcome === 'created' ? result.case_relate_id : null,
          stage_key:        null,
          other_open_cases: otherOpen,
          message:          `case ${result.case_id} ${result.outcome}`,
        },
      };
    }

    case 'invalid':
      return {
        success: true,
        output: {
          action:           'invalid',
          case_id:          null,
          case_relate_id:   null,
          stage_key:        null,
          other_open_cases: null,
          message:          result.message,
        },
      };

    default:
      // 'collision' is unreachable — this function exposes no docket params —
      // but a future service outcome must fail loudly, not map to a guess.
      throw new Error(`intake_case: unexpected service outcome "${result.outcome}"`);
  }
};
fns.intake_case.__meta = {
  category: 'cases',
  description: 'Find, reuse, or create a case for a contact (the case half of the intake service behind POST /api/intake/case). reuse="intake" (default): reuse the contact\'s open intake-pipeline case — latest case_stage_log row on a NON-TERMINAL role=intake stage, cross-case-type by design so repeat website submissions land on one lead case — else create a NEW case (never gloms onto legacy case_stage=Open rows, which have no pipeline history). reuse="same_type": the classic route behavior — return the newest Open/Pending/Filed case of the same case_type, else create. reuse="never": always create. case_type MAY be blank here (unlike the HTTP route) for leads whose matter type is not yet known — staff or ai_match fill it later. Creation writes cases + case_relate (Primary) + a log row, emits case.created, and fires the Dropbox folder ensure — but does NOT stage the case: follow with advance_stage (e.g. stage "lead", only_from "none") to put it on the intake board. Output: action (reused|found|created|invalid), case_id, case_relate_id (created only), stage_key (reused only), other_open_cases (count of the contact\'s OTHER live cases — surface it to staff; most are legacy imports, so it informs rather than automates), message. Bad input → action="invalid" without throwing; branch on {{this.output.action}}. No docket params — dockets go through the HTTP route or case updates.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'case_type', type: 'string', required: false, placeholderAllowed: true,
      description: 'Matter type ("Bankruptcy", "Civil Litigation", "Other", …). Blank allowed — creates an untyped lead case. Keep to the existing vocabulary; free text here is how "potato hunting" happened.',
      example: 'Bankruptcy' },
    { name: 'case_subtype', type: 'string', required: false, placeholderAllowed: true,
      description: 'Category refinement (e.g. "Chapter 7"). ≤40 chars.' },
    { name: 'reuse', type: 'enum', required: false, enum: ['intake', 'same_type', 'never'],
      description: 'Reuse strategy — see the function description. Default "intake".' },
  ],
  example: { contact_id: '{{contactId}}', case_type: '{{lead_case_type}}', reuse: 'intake' },
};

module.exports = fns;
