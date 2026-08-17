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
    { name: 'key', type: 'string', required: true, placeholderAllowed: true, strictString: true,
      description: 'app_settings.key. Must already exist and must not be is_secret. Runtime rejects a non-string key.',
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
    { name: 'key', type: 'string', required: true, placeholderAllowed: true, strictString: true,
      description: 'app_settings.key. Must exist and must not be is_secret. Runtime rejects a non-string key.',
      example: 'court_ingest_live' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Store the value in this workflow variable.',
      example: 'courtIngestLive' },
  ],
  example: { key: 'court_ingest_live', output_var: 'courtIngestLive' },
};


/**
 * get_settings — plural companion to get_setting. Reads N non-secret keys in
 * one query and returns a {key: value} map.
 *
 * DELIBERATELY a separate function, not a mode on get_setting: get_setting's
 * output contract is the raw value STRING and live steps may consume
 * {{this}} directly. A param-dependent output shape (string vs map) on one
 * function is the kind of conditional contract we avoid. Both functions
 * share the same gates (key must exist, is_secret refused) and the same
 * VERBATIM value handling.
 *
 * keys — csv string ("a, b, c") or array. Save-time meta declares 'string'
 * (csv is the editor path); an ARRAY only arrives via placeholder resolution
 * ({{someList}} through resolvePlaceholders' single-placeholder fast path),
 * so the runtime dual-accepts it. Duplicates are deduped; blank entries
 * dropped.
 *
 * ALL-OR-NOTHING: if ANY requested key is unknown or is_secret, the whole
 * call throws, listing every offender. Same typo-protection philosophy as
 * the singular — a silently partial map causes subtler workflow bugs than a
 * loud failure. (If a soft mode is ever needed, add an explicit missing_ok
 * param; do not weaken the default.)
 *
 * Returns:
 *   output      {object} — { key: value } (values verbatim)
 *   updated_at  {object} — { key: updated_at }
 *   set_vars    — output_var (if given) stores the whole map; individual
 *                 values are then reachable via {{var.key_name}} dot-path
 *                 resolution.
 */
fns.get_settings = async (params, db) => {
    let keys = params && params.keys;
    if (typeof keys === 'string') {
      keys = keys.split(',');
    }
    if (!Array.isArray(keys)) {
      throw new Error('get_settings requires keys (comma-separated string or array of key names)');
    }
    keys = [...new Set(
      keys.map(k => (typeof k === 'string' ? k.trim() : ''))
          .filter(Boolean)
    )];
    if (!keys.length) {
      throw new Error('get_settings requires at least one non-blank key');
    }

    const [rows] = await db.query(
      'SELECT `key`, `value`, is_secret, updated_at FROM app_settings WHERE `key` IN (?)',
      [keys]
    );
    const byKey = new Map(rows.map(r => [r.key, r]));

    const missing = keys.filter(k => !byKey.has(k));
    const secret  = keys.filter(k => byKey.has(k) && Number(byKey.get(k).is_secret) === 1);
    if (missing.length || secret.length) {
      const parts = [];
      if (missing.length) parts.push(`do not exist: ${missing.join(', ')}`);
      if (secret.length)  parts.push(`are secret and cannot be read by automation: ${secret.join(', ')}`);
      throw new Error(`get_settings: settings ${parts.join('; ')}`);
    }

    const values = {};
    const updated_at = {};
    for (const k of keys) {
      values[k]     = byKey.get(k).value;   // VERBATIM — see whitespace invariant above
      updated_at[k] = byKey.get(k).updated_at;
    }

    const set_vars = {};
    if (params.output_var) set_vars[params.output_var] = values;

    return {
      success: true,
      output: values,
      updated_at,
      set_vars,
    };
  };

fns.get_settings.__meta = {
  category: 'system',
  description:
    'Read multiple non-secret app_settings in one call; returns a {key: value} map. ' +
    'ALL-OR-NOTHING: throws (listing every offender) if any requested key is unknown or ' +
    'is_secret. With output_var, individual values are reachable via {{var.key_name}}.',
  params: [
    { name: 'keys', type: 'string', required: true, placeholderAllowed: true, strictString: true,
      description: 'Comma-separated app_settings keys. Every key must exist and must not be ' +
                   'is_secret. A placeholder resolving to an array also works at runtime.',
      example: 'court_ingest_live, esign_test_mode' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Store the whole {key: value} map in this workflow variable.',
      example: 'settings' },
  ],
  example: { keys: 'court_ingest_live, esign_test_mode', output_var: 'settings' },
};

/**
 * sweep_trigger_executions — retention for trigger_executions.
 *
 * no_match / no_rules rows are the high-volume audit+sample noise: kept
 * keep_days (default 30). Everything else (matched / error / depth_capped)
 * is real automation history: kept keep_matched_days (default 90). Batched
 * DELETEs (5k/batch, 20 batches max per run) so a backlog drains over runs
 * without a long-held lock. Driven by the "Trigger Executions Sweep" daily
 * recurring job; callable on demand.
 *
 * R4: trigger_execution_rules needs NO separate pass here — its FK to
 * trigger_executions is ON DELETE CASCADE, so its rows go with their parent
 * inside the same statement and orphans are structurally impossible. That is
 * why the FK was added rather than left optional; the alternative was a
 * second "delete where execution_id not in (...)" sweep that could drift.
 * Note the cascade makes each batch delete more rows than `deleted` reports —
 * that counter is parent executions only.
 *
 * params:
 *   keep_days          {number?} — retention for no_match/no_rules (default 30)
 *   keep_matched_days  {number?} — retention for everything else (default 90)
 */
fns.sweep_trigger_executions = async (params = {}, db) => {
  const keepDays        = Number(params.keep_days)         > 0 ? Number(params.keep_days)         : 30;
  const keepMatchedDays = Number(params.keep_matched_days) > 0 ? Number(params.keep_matched_days) : 90;
  const BATCH = 5000;
  let deleted = 0;
  for (let i = 0; i < 20; i++) {
    const [res] = await db.query(
      `DELETE FROM trigger_executions
        WHERE (status IN ('no_rules','no_match')     AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY))
           OR (status NOT IN ('no_rules','no_match') AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY))
        LIMIT ${BATCH}`,
      [keepDays, keepMatchedDays]
    );
    deleted += res.affectedRows;
    if (res.affectedRows < BATCH) break;
  }
  console.log(`[TRIGGER SWEEP] deleted=${deleted} keep_days=${keepDays} keep_matched_days=${keepMatchedDays}`);

  // ── Stranded-dispatch detection (S16) ──────────────────────────────────
  // A row whose outcomes still carry dispatch_pending never reached the
  // Phase-4 finalize UPDATE: the engine recorded the event, began
  // dispatching, and stopped. The expected cause is Cloud Run CPU throttling
  // (the service runs Min:0 with throttling ON), where post-response work is
  // starved between requests. The 1/min scheduler heartbeat normally rescues
  // it within a minute or two, so anything still pending after an hour was
  // genuinely lost, not merely delayed — hence the floor.
  //
  // Detection only. Re-dispatching actions with no recorded outcome is the
  // bounded-retry design and is deliberately NOT done here.
  let stranded = 0;
  try {
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS c, MIN(id) AS first_id, MAX(id) AS last_id
         FROM trigger_executions
        WHERE JSON_EXTRACT(outcomes, '$.dispatch_pending') = TRUE
          AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
          AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    stranded = row ? Number(row.c) : 0;
    if (stranded > 0) {
      const { alert } = require('../alerting');
      await alert(db, {
        source: 'app', kind: 'trigger_dispatch_stranded', severity: 'warning',
        group_key: 'trigger_dispatch_stranded',
        title: `${stranded} trigger execution(s) stranded mid-dispatch`,
        message:
          `Executions ${row.first_id}–${row.last_id} recorded their event but never ` +
          `finalized, so some actions may not have run. Most likely cause: Cloud Run ` +
          `CPU throttling suspending post-response work (service runs Min:0, ` +
          `cpu-throttling on). Inspect: SELECT id, event_type, created_at, outcomes ` +
          `FROM trigger_executions WHERE JSON_EXTRACT(outcomes,'$.dispatch_pending')=TRUE;`,
        context: { stranded, first_id: row.first_id, last_id: row.last_id },
      }).catch(() => {});
    }
  } catch (err) {
    // Detection must never break retention.
    console.error('[TRIGGER SWEEP] stranded check failed:', err.message);
  }

  return { success: true, output: { deleted, stranded, keep_days: keepDays, keep_matched_days: keepMatchedDays } };
};

fns.sweep_trigger_executions.__meta = {
  category: 'system',
  description: 'Retention sweep for trigger_executions: no_match/no_rules rows kept keep_days (default 30), matched/error rows kept keep_matched_days (default 90). Batched deletes. Also alerts on executions stranded mid-dispatch for over an hour (suspended post-response work).',
  params: [
    { name: 'keep_days', type: 'integer', required: false, default: 30,
      description: 'Days to keep no_match / no_rules rows.' },
    { name: 'keep_matched_days', type: 'integer', required: false, default: 90,
      description: 'Days to keep matched / error / depth_capped rows.' },
  ],
  example: {}
};

module.exports = fns;