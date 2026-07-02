// lib/internal_functions/sequences.js

// NOTE: sequenceEngine is NOT required here — circular dependency with job_executor.
// Instead, require it lazily inside cancel_sequences and enroll_sequence.

const fns = {};

// ─────────────────────────────────────────────────────────────
// SEQUENCES (Phase 0.6)
// ─────────────────────────────────────────────────────────────
 
/**
 * cancel_sequences
 * Cancel all active sequence enrollments of a given type for a contact.
 * Wraps sequenceEngine.cancelSequences().
 *
 * params:
 *   contact_id     {number|string}  — required
 *   template_type  {string|null}    — e.g. 'no_show'. Omit or null to cancel ALL types.
 *   reason         {string}         — logged in cancel_reason (default: 'internal_function')
 *
 * example config:
 *   {
 *     "function_name": "cancel_sequences",
 *     "params": {
 *       "contact_id": "{{contactId}}",
 *       "template_type": "no_show",
 *       "reason": "new_appointment_booked"
 *     }
 *   }
 */

fns.cancel_sequences = async (params, db) => {
    const sequenceEngine = require('../sequenceEngine');  // ← lazy require
    const { contact_id, template_type = null, reason = 'internal_function' } = params;
    if (!contact_id) throw new Error('cancel_sequences requires contact_id');
 
    console.log(`[CANCEL_SEQUENCES] contact=${contact_id} type=${template_type || 'all'} reason=${reason}`);
 
    const result = await sequenceEngine.cancelSequences(db, contact_id, template_type, reason);
 
    return {
      success: true,
      output: result  // { cancelled: number }
    };
  };

fns.cancel_sequences.__meta = {
  category: 'sequences',
  description: 'Cancel all active sequence enrollments of a given type for a contact.',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'template_type', type: 'string', required: false,
      description: 'Sequence type, e.g. "no_show". Omit/null to cancel ALL types.',
      example: 'no_show' },
    { name: 'reason', type: 'string', required: false, default: 'internal_function',
      description: 'Logged in cancel_reason.', example: 'new_appointment_booked' },
  ],
  example: { contact_id: '{{contactId}}', template_type: 'no_show' }
};

 
/**
 * enroll_sequence
 * Enroll a contact in a sequence template. Two modes:
 *
 *   (a) By template type (cascade match): pass `template_type`. The
 *       engine loads the type's priority_fields from
 *       sequence_template_types and scores each active template against
 *       trigger_data; the most-specific qualifying template wins. Any
 *       cascade keys (e.g. appt_type, appt_with, case_type) must be
 *       present in trigger_data — there is no separate filters arg.
 *
 *   (b) By template ID (direct): pass `template_id` for a specific
 *       template. Bypasses cascade matching. The template must be active.
 *
 *   Exactly one of `template_type` or `template_id` must be provided.
 *
 * Wraps sequenceEngine.enrollContact() (by type) or
 *       sequenceEngine.enrollContactByTemplateId() (by id).
 *
 * params:
 *   contact_id     {number|string}  — required
 *   template_type  {string}         — required if template_id is omitted
 *   template_id    {number|string}  — required if template_type is omitted
 *   trigger_data   {object}         — optional context passed to the sequence
 *                                     (appt_id, appt_time, case_id, and any
 *                                     cascade keys declared in the type's
 *                                     priority_fields)
 *
 * example config (by type):
 *   {
 *     "function_name": "enroll_sequence",
 *     "params": {
 *       "contact_id": "{{contactId}}",
 *       "template_type": "no_show",
 *       "trigger_data": {
 *         "appt_id":   "{{apptId}}",
 *         "appt_type": "{{apptType}}",
 *         "appt_with": "{{apptWith}}",
 *         "enrolled_by": "workflow"
 *       }
 *     }
 *   }
 *
 * example config (by id):
 *   {
 *     "function_name": "enroll_sequence",
 *     "params": {
 *       "contact_id": "{{contactId}}",
 *       "template_id": 42,
 *       "trigger_data": { "source": "manual_test" }
 *     }
 *   }
 */

fns.enroll_sequence = async (params, db) => {
    const sequenceEngine = require('../sequenceEngine');  // ← lazy require
    const {
      contact_id,
      template_type,
      template_id,
      trigger_data = {},
    } = params;

    if (!contact_id) throw new Error('enroll_sequence requires contact_id');

    const hasType = template_type !== undefined && template_type !== null && template_type !== '';
    const hasId   = template_id   !== undefined && template_id   !== null && template_id   !== '';

    if (hasType && hasId) {
      throw new Error('enroll_sequence: provide exactly one of template_type or template_id, not both');
    }
    if (!hasType && !hasId) {
      throw new Error('enroll_sequence requires template_type or template_id');
    }

    let result;
    if (hasId) {
      const idInt = parseInt(template_id, 10);
      if (!Number.isInteger(idInt) || idInt <= 0) {
        throw new Error('enroll_sequence: template_id must be a positive integer');
      }
      console.log(`[ENROLL_SEQUENCE] contact=${contact_id} template_id=${idInt}`);
      result = await sequenceEngine.enrollContactByTemplateId(db, contact_id, idInt, trigger_data);
    } else {
      console.log(`[ENROLL_SEQUENCE] contact=${contact_id} type=${template_type}`);
      result = await sequenceEngine.enrollContact(db, contact_id, template_type, trigger_data);
    }

    return {
      success: true,
      output: result,  // { enrollmentId, templateName, totalSteps, firstJobScheduledAt }
    };
  };

fns.enroll_sequence.__meta = {
  category: 'sequences',
  description: 'Enroll a contact in a sequence template. By type (cascade match) or by id (direct).',
  params: [
    { name: 'contact_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{contactId}}' },
    { name: 'template_type', type: 'string', required: false,
      modeGroup: 'by_type',
      description: 'Sequence type for cascade match.', example: 'no_show' },
    { name: 'appt_type', type: 'string', required: false,
      modeGroup: 'by_type',
      description: 'Cascade filter (type-mode only).' },
    { name: 'appt_with', type: 'integer', required: false,
      modeGroup: 'by_type',
      description: 'Cascade filter (type-mode only).' },
    { name: 'template_id', type: 'integer', required: false,
      modeGroup: 'by_id',
      description: 'Specific template ID for direct enrollment.', example: 42 },
    { name: 'trigger_data', type: 'object', required: false,
      description: 'Optional context passed to the sequence (appt_id, case_id, etc.).',
      example: { appt_id: '{{apptId}}' } },
  ],
  exclusiveOneOf: [['template_type', 'template_id']],
  example: { contact_id: '{{contactId}}', template_type: 'no_show' }
};

module.exports = fns;
