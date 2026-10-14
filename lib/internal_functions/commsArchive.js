// lib/internal_functions/commsArchive.js
//
/**
 * Comms archive category — the recurring entry points for the comms archive
 * (ref/COMMS_ARCHIVE_DESIGN.md §6.1, §10):
 *   comms_archive_sweep        RingCentral call recordings (the 90-day cliff)
 *   comms_archive_media_sweep  Quo call recordings + RC / Quo MMS (S1b)
 *   comms_archive_verify       nightly delete detection (S1b)
 *
 * Auto-scanned by index.js: dropping this file in registers the function.
 *
 * CTA: ALL DENIED (services/ctaService.js CTA_FN_DENYLIST, design §6.5). Every
 * registry function with __meta is CTA-eligible by default; these spend
 * shared provider rate budgets, write the archive or stat the whole bucket,
 * so no public link may start one. Today's other sweepers (documents_sync et al.) are eligible —
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

fns.comms_archive_media_sweep = async (_params = {}, db) => {
  const sweep = require('../../services/commsArchiveMediaSweep'); // lazy require (convention)
  const output = await sweep.runMediaSweep(db, {});
  console.log(
    `[COMMS ARCHIVE MEDIA] enabled=${output.enabled} ${output.skipped ? `skipped=${output.skipped} ` : ''}` +
    `calls+${output.discovered_calls} mms+${output.discovered_mms} archived=${output.archived} ` +
    `adopted=${output.adopted} resolved=${output.resolved} none=${output.none} gone=${output.gone} ` +
    `drift=${output.drift} stuck=${output.stuck} failed=${output.failed} no_line=${output.no_line} ` +
    `rc=${output.rc_used} quo=${output.quo_used} stop=${output.stop}`
  );
  return { success: true, output };
};

fns.comms_archive_media_sweep.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Comms Archive Media Sweep" recurring job
  description:
    'Internal: one bounded tick of the comms archive for Quo call recordings and RingCentral / Quo ' +
    'MMS files — discovers them from phone_event_log and log attachments, fetches through the line\'s ' +
    'adapter, stores them in the private archive bucket. A provider response that does not match its ' +
    'documented shape is parked and alerted, never treated as "no file". Fail-closed on app_settings ' +
    'comms_archive_enabled != "1". Driven by its recurring job — do not add to workflows. Not CTA-eligible.',
  params: [],
  example: {},
};

fns.comms_archive_verify = async (params = {}, db) => {
  const verify = require('../../services/commsArchiveVerify'); // lazy require (convention)
  const output = await verify.runVerify(db, params.slice != null && params.slice !== '' ? { slice: params.slice } : {});
  console.log(
    `[COMMS ARCHIVE VERIFY] slice=${output.slice} selected=${output.selected} checked=${output.checked} ` +
    `missing=${output.missing} stop=${output.stop}`
  );
  return { success: true, output };
};

fns.comms_archive_verify.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the nightly "Comms Archive Verify" job
  description:
    'Internal: nightly delete detection — stats a rolling 1/7 of the archived objects, the whole slice ' +
    '(every object every 7 days, within 14 if a night is missed — inside the 30-day soft-delete window) ' +
    'and raises an error alert for any that is ' +
    'missing outside a purge. Read-only; runs even while comms_archive_enabled is off (a delete during a ' +
    'pause is exactly what it exists to catch). Not CTA-eligible.',
  params: [
    { name: 'slice', type: 'integer', required: false, min: 0, max: 6,
      description: 'Check this slice (id % 7) instead of today\'s — for a hand re-run.' },
  ],
  example: {},
};

module.exports = fns;
