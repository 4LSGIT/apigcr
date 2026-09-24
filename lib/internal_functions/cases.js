// lib/internal_functions/cases.js

const fns = {};

/**
 * update_case
 * Update one or more whitelisted fields on a case row, and/or its custom
 * fields (cf_ keys).
 *
 * TWO GATES, ONE PER KIND OF KEY (custom-fields S2):
 *   - core columns: the ALLOWED list below. It is kept on purpose even though
 *     caseService.updateCase now rejects unknown keys itself — the service
 *     still accepts EVERY real column (twins, bk_*, case_caption, …), and this
 *     list is the narrower automation surface. Widening it is a decision, not
 *     a side effect.
 *   - cf_ keys: NOT enumerated here. They pass straight to the service, whose
 *     registry gate (fieldDefService.splitCustomFields) accepts only ACTIVE
 *     case defs with valid values — a hand-kept copy here would only rot.
 *
 * params:
 *   case_id  {number}  — required
 *   fields   {object}  — { column_name: value, cf_key: value, ... }
 *
 * example config:
 *   {
 *     "function_name": "update_case",
 *     "params": {
 *       "case_id": "{{cases.case_id}}",
 *       "fields": {
 *         "case_stage":  "closed",
 *         "case_status": "Stale Lead"
 *       }
 *     }
 *   }
 */

fns.update_case = async (params, db) => {
    const { case_id, fields } = params;
    if (!case_id) throw new Error('update_case requires case_id');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('update_case requires a non-empty fields object');
    }

    // Whitelist — only these CORE columns may be set via this function (cf_
    // keys are gated by the service; see the header). Expand as needed.
    // pipeline_phase + case_341_link added in S2: both writable through
    // PATCH /api/cases/:id all along; this list had drifted. pipeline_phase is
    // advanceStage's column — writing it by hand is the same footgun as
    // hand-writing case_stage (see services/pipelineService.js header).
    const ALLOWED = new Set([
      'case_number', 'case_number_full', 'case_type', 'case_subtype', 'pipeline_phase', 'case_stage', 'case_status', 'case_rec',
      'case_open_date', 'case_file_date', 'case_close_date', 'case_discharge_date',
      'case_garnish', 'case_issues_bk_vehicle', 'case_issues_bk_other', 'case_pre_petition', 'case_post_petition', 'case_1st_course', 'case_2nd_course',
      'matrix', 'matrix_date_original', 'matrix_date_proposed', 'schedules', 'schedules_due_original', 'schedules_due_proposed',
      'filing_fee', 'final_installment', 'show_cause', 'filing_fee_extended_deadline',
      'docs', 'docs_due', 'docs_missing',
      'case_intake_form', 'case_detailed_form', 'case_detailed_link', 'case_ISSN_form', 'case_form', 'case_341_form',
      'case_source', 'case_source_ref', 'case_dropbox', 'case_primary_reason',
      'case_judge', 'case_trustee', 'case_chapter', 'case_341_link',
      'case_341_current', 'case_341_initial', 'case_objection', 'case_180', 'case_preference',
      'clio_matter', '341_appt_id', '341_status', '341_docs', '341_amend', '341_notes',
      'case_clio_id', 'case_notes', 'case_alerts',
    ]);

    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k) && !/^cf_/i.test(k));
    if (blocked.length) {
      throw new Error(`update_case: blocked columns: ${blocked.join(', ')}`);
    }

    console.log(`[UPDATE_CASE] id=${case_id} fields=${JSON.stringify(fields)}`);

    // (Trigger T3) Delegate the write to caseService.updateCase — one writer,
    // so this path now gets blankDatesToNull (fixes the latent ''→'0000-00-00'
    // DATE bug the inline UPDATE had) and the case.updated emission.
    // The ALLOWED whitelist above still gates what automations may touch.
    //
    // R4/S5: user 0 is the established automation pseudo-user, and source
    // 'automation' lets a rule author exclude workflow-driven writes from a
    // case.updated rule (the classic "don't re-fire on my own side effect"
    // guard, alongside the depth/chain guards).
    const caseService = require('../../services/caseService'); // lazy (convention)
    const result = await caseService.updateCase(db, String(case_id), fields, {
      userId: 0,
      source: 'automation',
    });

    return {
      success: true,
      output: { case_id, updated_fields: result.updated_fields }
    };
  };

fns.update_case.__meta = {
  category: 'cases',
  description: 'Update one or more fields on a case row. Whitelisted columns only — non-whitelisted columns are rejected at runtime with the blocked names (see ALLOWED in update_case: docket, dates, stage/status/chapter, 341 fields, docs/forms, judge/trustee, clio, notes). Also accepts the case\'s ACTIVE custom fields by key (cf_…); each value is validated against its field type — unknown or retired keys are rejected; null or "" clears one. case_number / case_number_full are opaque strings — no shape validation.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{caseId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs, plus cf_ custom-field keys. Whitelist and custom-field registry enforced at runtime.',
      example: { case_stage: 'Filed', case_file_date: '2026-07-01' } },
  ],
  example: { case_id: '{{caseId}}', fields: { case_stage: 'Filed' } }
};

module.exports = fns;