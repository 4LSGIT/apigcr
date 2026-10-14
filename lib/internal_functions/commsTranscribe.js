// lib/internal_functions/commsTranscribe.js
//
/**
 * Comms archive transcription (S2) — the recurring entry point
 * (ref/COMMS_ARCHIVE_DESIGN.md §6.3, §6.5, §10):
 *   comms_transcribe_sweep   archived call recordings + voicemails → AssemblyAI
 *                            → comms_transcripts
 *
 * Auto-scanned by index.js: dropping this file in registers the function.
 *
 * CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST, design §6.5) — it
 * spends the STT budget and sends client audio to the vendor; no public link
 * may start it.
 *
 * Mode, caps, the signing proof, the tick lock and alerting all live in
 * services/commsTranscribeSweep.js — read its header. Safe to invoke by hand
 * while the recurring job runs: the tick lock makes the loser return
 * {skipped:'locked'}.
 */

const fns = {};

fns.comms_transcribe_sweep = async (_params = {}, db) => {
  const sweep = require('../../services/commsTranscribeSweep'); // lazy require (convention)
  const output = await sweep.runTranscribeSweep(db, {});
  console.log(
    `[COMMS TRANSCRIBE] mode=${output.mode} ${output.skipped ? `skipped=${output.skipped} ` : ''}` +
    `discovered=${output.discovered} submitted=${output.submitted} polled=${output.polled} completed=${output.completed} ` +
    `short=${output.skipped_short} no_transcribe=${output.skipped_no_transcribe} over_cap=${output.skipped_over_cap} ` +
    `retried=${output.retried} failed=${output.failed} drift=${output.drift} fenced=${output.fenced} ` +
    `vendor_deleted=${output.vendor_deleted} owed=${output.vendor_delete_owed} ` +
    `mtd=${output.cap ? `${output.cap.mtd_cents}/${output.cap.cap_cents}` : '-'} stop=${output.stop}`
  );
  return { success: true, output };
};

fns.comms_transcribe_sweep.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Comms Transcribe Sweep" recurring job
  description:
    'Internal: one bounded tick of comms archive transcription — submits archived call recordings and ' +
    'voicemails to AssemblyAI through a 1-hour signed URL (only after proving signing on a non-client ' +
    'probe), polls, stores the transcript and the vendor JSON, then deletes the vendor copy. Gated on ' +
    'app_settings comms_transcribe_mode (off | sample | on; anything else = off) and the monthly cap. ' +
    'Driven by its recurring job — do not add to workflows. Not CTA-eligible.',
  params: [],
  example: {},
};

module.exports = fns;
