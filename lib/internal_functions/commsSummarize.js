// lib/internal_functions/commsSummarize.js
//
/**
 * Comms archive summaries (S3) — the recurring entry point
 * (ref/COMMS_ARCHIVE_DESIGN.md §6.4, §6.5, §10):
 *   comms_summarize_sweep   transcribed calls + voicemails → Claude → a
 *                           verified summary on comms_transcripts
 *
 * Auto-scanned by index.js: dropping this file in registers the function.
 *
 * CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST, design §6.5) — it spends
 * the shared AI budget and sends call transcripts to the model; no public link
 * may start it.
 *
 * Mode, the cap, the grounding check, the tick lock and alerting live in
 * services/commsSummarizeSweep.js — read its header. Safe to invoke by hand
 * while the recurring job runs: the tick lock makes the loser return
 * {skipped:'locked'}.
 */

const fns = {};

fns.comms_summarize_sweep = async (_params = {}, db) => {
  const sweep = require('../../services/commsSummarizeSweep'); // lazy require (convention)
  const output = await sweep.runSummarizeSweep(db);
  console.log(
    `[COMMS SUMMARIZE] mode=${output.mode} ${output.skipped ? `skipped=${output.skipped} ` : ''}` +
    `discovered=${output.discovered} calls=${output.calls} summarized=${output.summarized} ` +
    `restricted=${output.skipped_restricted} short=${output.skipped_short} empty=${output.skipped_empty} ` +
    `refused=${output.refused} rejected=${output.rejected} retried=${output.retried} failed=${output.failed} ` +
    `fenced=${output.fenced} dropped=${output.grounding_dropped} ` +
    `mtd=${output.cap ? `${output.cap.mtd_cents}/${output.cap.cap_cents}` : '-'} stop=${output.stop}`
  );
  return { success: true, output };
};

fns.comms_summarize_sweep.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Comms Summarize Sweep" recurring job
  description:
    'Internal: one bounded tick of comms archive summaries — sends transcribed calls and voicemails to ' +
    'Claude (at most 3 per tick), checks every quoted item against the transcript, and writes the summary ' +
    'shown on the call. Restricted calls are never sent. Gated on app_settings comms_summarize_mode ' +
    '(off | sample | on; anything else = off) and the shared monthly AI cap. Driven by its recurring job — ' +
    'do not add to workflows. Not CTA-eligible.',
  params: [],
  example: {},
};

module.exports = fns;
