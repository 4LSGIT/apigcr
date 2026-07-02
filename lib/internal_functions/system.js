// lib/internal_functions/system.js

const fns = {};

/**
 * run_error_sweep — scan automation failure tables and email a grouped
 * alert digest. Driven by the "Error Alert Sweep" recurring job; callable
 * on demand (apiTester) with dry_run for a no-write preview.
 */

fns.run_error_sweep = async (params = {}, db) => {
    const { runErrorSweep } = require('../alerting'); // deferred require (circular dep safety)
    return runErrorSweep(db, params || {});
  };

fns.run_error_sweep.__meta = {
  category: 'system',
  description: 'Scan automation failure tables and email a grouped alert digest.',
  params: [
    { name: 'dry_run', type: 'boolean', required: false, default: false,
      description: 'Scan and build the digest without sending, writing, or advancing watermarks.' },
  ],
  example: {}
};

/**
 * generate_firm_blocks — materialize Shabbos/Yom Tov closed intervals
 * from Hebcal into firm_blocks over a rolling horizon. Driven by the
 * "Firm blocks generator" daily recurring job; callable on demand.
 *
 * params:
 *   horizon_months {number?} — window length in months (default 12)
 *
 * example config:
 *   { "function_name": "generate_firm_blocks", "params": {} }
 */

fns.generate_firm_blocks = async (params = {}, db) => {
    const { generateFirmBlocks } = require('../../services/firmBlocksService'); // deferred require (circular dep safety)
    return generateFirmBlocks(db, { horizonMonths: params.horizon_months ?? 12 });
  };

fns.generate_firm_blocks.__meta = {
  category: 'system',
  description:
    'Materialize Shabbos/Yom Tov closed intervals from Hebcal into firm_blocks over a rolling ' +
    'horizon (default 12 months). Upserts on (source, generated_for); never deletes; manual rows ' +
    'untouched. Hebcal failure throws (job retry); a zero-block result for a ≥1-month window ' +
    'fires a firm_blocks_generation_empty alert.',
  params: [
    { name: 'horizon_months', type: 'number', required: false, default: 12,
      description: 'Window length in months from today.' },
  ],
  example: {}
};

module.exports = fns;
