// lib/internal_functions/pipeline.js
//
// Pipeline Engine functions (Slice B). New file → auto-registered by
// index.js's directory scan (no registration step). __meta.category is
// 'cases' so these group with the other case functions in the pickers
// (README: category follows UI grouping, file placement follows cohesion).

const fns = {};

/**
 * advance_stage
 * Advance a case to a pipeline stage via services/pipelineService.
 *
 * Thin wrapper: entered_by = null, source = 'system' — this is the automation
 * entry point (workflows / sequences / hooks / ingest dispatchers). Appends a
 * case_stage_log row and overwrites cases.case_stage / case_status / case_rec
 * from the stage. Repeating the case's current stage is a safe no-op
 * (output.noop = true). Skipping stages is legal by design.
 *
 * params:
 *   case_id {string|number} — required
 *   stage   {string|number} — required. stage_key (resolved within the case's
 *                             pipeline template) or numeric pipeline_stages id
 *                             (escape hatch — any template).
 *   note    {string}        — optional log note (truncated to 255)
 *
 * example config:
 *   {
 *     "function_name": "advance_stage",
 *     "params": {
 *       "case_id": "{{cases.case_id}}",
 *       "stage":   "filed",
 *       "note":    "Auto-advanced on petition filing"
 *     }
 *   }
 */
fns.advance_stage = async (params, db) => {
  const { case_id, stage, note } = params;
  if (!case_id) throw new Error('advance_stage requires case_id');
  if (stage === undefined || stage === null || String(stage).trim() === '') {
    throw new Error('advance_stage requires stage (stage_key or numeric stage_id)');
  }

  const pipelineService = require('../../services/pipelineService'); // lazy require (convention)

  const result = await pipelineService.advanceStage(db, String(case_id), stage, {
    userId: null,
    note: note == null ? null : note,
    source: 'system',
  });

  console.log(`[ADVANCE_STAGE] case=${case_id} stage=${stage} noop=${result.noop}`);

  return {
    success: true,
    output: {
      case_id: String(case_id),
      noop: result.noop,
      stage_key:    result.current ? result.current.stage_key : null,
      case_stage:   result.current ? result.current.case_stage : null,
      status_label: result.current ? result.current.status_label : null,
    },
  };
};
fns.advance_stage.__meta = {
  category: 'cases',
  description: 'Advance a case to a pipeline stage (Pipeline Engine). Appends a case_stage_log row and overwrites cases.case_stage / case_status / case_rec from the stage. Repeating the current stage is a safe no-op (output.noop=true); skipping stages is legal. Output carries noop, stage_key, case_stage, status_label — capture via set_vars if needed.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      example: '{{caseId}}' },
    { name: 'stage', type: 'string', required: true, placeholderAllowed: true,
      description: 'stage_key (e.g. "filed") resolved within the case\'s pipeline template, or a numeric pipeline_stages id (escape hatch — any template).',
      example: 'filed' },
    { name: 'note', type: 'string', required: false, placeholderAllowed: true,
      description: 'Optional log note (truncated to 255 chars).' },
  ],
  example: { case_id: '{{caseId}}', stage: 'filed', note: 'Auto-advanced on petition filing' },
};

module.exports = fns;