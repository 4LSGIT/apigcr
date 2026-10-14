// lib/internal_functions/commsArchive.js
//
/**
 * Comms archive category — the recurring entry point for the comms archive
 * (ref/COMMS_ARCHIVE_DESIGN.md §6.1). S1a: RingCentral call recordings.
 *
 * Auto-scanned by index.js: dropping this file in registers the function.
 *
 * CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST, design §6.5). Every
 * registry function with __meta is CTA-eligible by default; this one spends
 * a shared RingCentral rate budget and writes the archive, so no public link
 * may start it. Today's other sweepers (documents_sync et al.) are eligible —
 * denying this one is the deliberate divergence.
 *
 * Kill switch, tick lock, pacing and alerting all live in
 * services/commsArchiveSweep.js — read its header. Safe to invoke by hand
 * while the recurring job runs: the tick lock makes the loser return
 * {skipped:'locked'}.
 */

const fns = {};

fns.comms_archive_sweep = async (params = {}, db) => {
  const sweep = require('../../services/commsArchiveSweep'); // lazy require (convention)
  const output = await sweep.runSweep(db, { heavyPerTick: params.heavy_per_tick });
  console.log(
    `[COMMS ARCHIVE] enabled=${output.enabled} ${output.skipped ? `skipped=${output.skipped} ` : ''}` +
    `discovered=${output.discovered} archived=${output.archived} adopted=${output.adopted} ` +
    `resolved=${output.resolved} none=${output.none} gone=${output.gone} stuck=${output.stuck} failed=${output.failed} ` +
    `no_line=${output.no_line} heavy=${output.heavy_used} stop=${output.stop} ` +
    `cliff=${output.cliff ? output.cliff.at_risk ?? 'err' : '-'}`
  );
  return { success: true, output };
};

fns.comms_archive_sweep.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Comms Archive Sweep" recurring job
  description:
    'Internal: one bounded tick of the comms archive — copies RingCentral call recordings into the ' +
    'private archive bucket, oldest first, before RingCentral deletes them at 90 days; then the ' +
    'cliff guard (error alert for any recording 75+ days old not archived). Fail-closed on ' +
    'app_settings comms_archive_enabled != "1" (the cliff guard still runs). Driven by the ' +
    '"Comms Archive Sweep" recurring job — do not add to workflows. Not CTA-eligible.',
  params: [
    { name: 'heavy_per_tick', type: 'integer', required: false, min: 0, max: 3, default: 3,
      description: 'RingCentral Heavy-group calls this tick may spend (live call ingest shares the 10/min band). Capped at 3: calls are spaced ≥ 20 s and no new one starts after 45 s, so a tick cannot deliver more. 0 = adopt/discover only.' },
  ],
  example: {},
};

module.exports = fns;
