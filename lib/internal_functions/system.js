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


// ─────────────────────────────────────────────────────────────
// APP SETTINGS  (set_setting / get_setting)
//
// The automation-side counterpart to routes/api.appSettings.js. That route is
// the HUMAN editor and gates on is_editable=1 — an operator flag meaning "a
// person may change this in settings.html". Automation consent is a different
// question, so these functions deliberately do NOT read is_editable. They gate
// on:
//   - is_secret = 1  → never readable or writable here. (Same belt-and-
//     suspenders as the route: a fat-fingered flag still can't leak a secret.)
//   - key must already exist → no accidental key creation from a typo in a
//     params_mapping. New keys are created via the DB console, same as the
//     route's rule.
//
// WHITESPACE INVARIANT (inherited from the route): values are stored VERBATIM.
// Never trim, collapse, or normalize — some settings carry load-bearing
// leading/trailing spaces.
// ─────────────────────────────────────────────────────────────

// app_settings.value is TEXT (64KB). Same headroom as api.appSettings.js.
const MAX_SETTING_LEN = 60000;

/**
 * Coerce an inbound param to the string app_settings.value expects.
 * Scalars stringify. Objects/arrays THROW rather than silently landing as
 * "[object Object]" — JSON.stringify structured values upstream.
 */
function _settingValueToString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const got = Array.isArray(v) ? 'array' : typeof v;
  throw new Error(
    `set_setting: value must be a string (number/boolean also accepted). Got ${got} — ` +
    `JSON.stringify structured values before passing them.`
  );
}

fns.set_setting = async (params, db) => {
    const key = params && params.key;
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('set_setting requires key');
    }
    if (!params || params.value === undefined || params.value === null) {
      throw new Error('set_setting requires value');
    }

    const value = _settingValueToString(params.value);
    if (value.length > MAX_SETTING_LEN) {
      throw new Error(`set_setting: value exceeds maximum length of ${MAX_SETTING_LEN} characters`);
    }

    const [[row]] = await db.query(
      'SELECT is_secret FROM app_settings WHERE `key` = ? LIMIT 1',
      [key]
    );
    if (!row) {
      throw new Error(`set_setting: setting "${key}" does not exist (create the row in the DB console first)`);
    }
    if (Number(row.is_secret) === 1) {
      throw new Error(`set_setting: "${key}" is a secret and cannot be written by automation`);
    }

    // Stored VERBATIM — see whitespace invariant above.
    await db.query('UPDATE app_settings SET `value` = ? WHERE `key` = ?', [value, key]);

    const [[updated]] = await db.query(
      'SELECT updated_at FROM app_settings WHERE `key` = ? LIMIT 1',
      [key]
    );

    // Value intentionally NOT echoed or logged — it may be a live 2FA code.
    console.log(`[SET_SETTING] ${key} updated (${value.length} chars)`);

    return {
      success: true,
      output: {
        key,
        length: value.length,
        updated_at: updated ? updated.updated_at : null,
      },
    };
  };

fns.set_setting.__meta = {
  category: 'system',
  description:
    'Write app_settings.value for an EXISTING, non-secret key. Value stored verbatim ' +
    '(no trimming). Refuses is_secret rows and unknown keys. Ignores is_editable — that ' +
    'flag governs the human settings.html editor, not automation.',
  params: [
    { name: 'key', type: 'string', required: true, placeholderAllowed: true,
      description: 'app_settings.key. Must already exist and must not be is_secret.',
      example: 'clio_login_code' },
    { name: 'value', type: 'string', required: true, placeholderAllowed: true, multiline: true,
      description: 'New value, stored VERBATIM. Numbers/booleans are stringified; ' +
                   'objects/arrays are rejected — JSON.stringify them first.',
      example: '{{clio_code}}' },
  ],
  example: { key: 'clio_login_code', value: '{{clio_code}}' },
};


fns.get_setting = async (params, db) => {
    const key = params && params.key;
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('get_setting requires key');
    }

    const [[row]] = await db.query(
      'SELECT `value`, is_secret, updated_at FROM app_settings WHERE `key` = ? LIMIT 1',
      [key]
    );
    if (!row) {
      throw new Error(`get_setting: setting "${key}" does not exist`);
    }
    if (Number(row.is_secret) === 1) {
      throw new Error(`get_setting: "${key}" is a secret and cannot be read by automation`);
    }

    const set_vars = {};
    if (params.output_var) set_vars[params.output_var] = row.value;

    return {
      success: true,
      output: row.value,
      updated_at: row.updated_at,
      set_vars,
    };
  };

fns.get_setting.__meta = {
  category: 'system',
  description:
    'Read app_settings.value for a non-secret key. Throws on unknown key or is_secret row. ' +
    'Optionally stores the value in a workflow variable via output_var.',
  params: [
    { name: 'key', type: 'string', required: true, placeholderAllowed: true,
      description: 'app_settings.key. Must exist and must not be is_secret.',
      example: 'court_ingest_live' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Store the value in this workflow variable.',
      example: 'courtIngestLive' },
  ],
  example: { key: 'court_ingest_live', output_var: 'courtIngestLive' },
};

module.exports = fns;