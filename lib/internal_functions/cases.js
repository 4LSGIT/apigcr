// lib/internal_functions/cases.js

const fns = {};

/**
 * update_case
 * Update one or more whitelisted fields on a case row.
 *
 * params:
 *   case_id  {number}  — required
 *   fields   {object}  — { column_name: value, ... }
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

    // Whitelist — only these columns may be set via this function.
    // Mirror of update_contact's whitelist pattern. Expand as needed.
    const ALLOWED = new Set([
      'case_number', 'case_number_full', 'case_type', 'case_stage', 'case_status', 'case_rec',
      'case_open_date', 'case_file_date', 'case_close_date',
      'case_garnish', 'case_issues_bk_vehicle', 'case_issues_bk_other', 'case_pre_petition', 'case_post_petition', 'case_1st_course', 'case_2nd_course',
      'matrix', 'matrix_date_original', 'matrix_date_proposed', 'schedules', 'schedules_due_original', 'schedules_due_proposed',
      'filing_fee', 'final_installment', 'show_cause', 'filing_fee_extended_deadline',
      'docs', 'docs_due', 'docs_missing',
      'case_intake_form', 'case_detailed_form', 'case_detailed_link', 'case_ISSN_form', 'case_form', 'case_341_form',
      'case_source', 'case_source_ref', 'case_dropbox', 'case_primary_reason',
      'case_judge', 'case_trustee', 'case_chapter',
      'case_341_current', 'case_341_initial', 'case_objection', 'case_180', 'case_preference', 'case_show_cause',
      'clio_matter', '341_appt_id', '341_status', '341_docs', '341_amend', '341_notes',
      'case_clio_id', 'case_notes', 'case_alerts',
    ]);

    const keys = Object.keys(fields);
    const blocked = keys.filter(k => !ALLOWED.has(k));
    if (blocked.length) {
      throw new Error(`update_case: blocked columns: ${blocked.join(', ')}`);
    }

    console.log(`[UPDATE_CASE] id=${case_id} fields=${JSON.stringify(fields)}`);

    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => fields[k]), case_id];

    const [result] = await db.query(
      `UPDATE cases SET ${setClauses} WHERE case_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      throw new Error(`Case ${case_id} not found`);
    }

    return {
      success: true,
      output: { case_id, updated_fields: keys }
    };
  };

fns.update_case.__meta = {
  category: 'cases',
  description: 'Update one or more fields on a case row. Whitelisted columns only — non-whitelisted columns are rejected at runtime with the blocked names (see ALLOWED in update_case: docket, dates, stage/status/chapter, 341 fields, docs/forms, judge/trustee, clio, notes). case_number / case_number_full are opaque strings — no shape validation.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{caseId}}' },
    { name: 'fields', type: 'object', required: true,
      description: 'Column → value pairs. Whitelist enforced at runtime.',
      example: { case_stage: 'Filed', case_file_date: '2026-07-01' } },
  ],
  example: { case_id: '{{caseId}}', fields: { case_stage: 'Filed' } }
};

module.exports = fns;
