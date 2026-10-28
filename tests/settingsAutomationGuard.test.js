// tests/settingsAutomationGuard.test.js
//
/**
 * Automation's consent to app_settings (settings arc, Fred 2026-10-17):
 * set_setting / get_setting / get_settings (lib/internal_functions/system.js)
 * and update_db's app_settings row guard (lib/internal_functions/db.js
 * _guardAppSettings), both deciding from lib/settingsRegistry.js.
 *
 * WHAT IS LOCKED
 *   - WRITES (set_setting, update_db) follow settingsRegistry.automationMayWrite:
 *       a registered key only when its entry says automation: true — today
 *         clio_login_code alone, the one live automation writer (phone-ingest
 *         rule 4, verified against every live definition 2026-10-17);
 *       an unregistered non-secret row (an automation variable) stays writable;
 *       a secret never — registry kind 'secret' even under a fat-fingered
 *         is_secret = 0, and an unregistered row's own is_secret = 1.
 *     set_setting refuses a registered key BEFORE reading the row (no query);
 *     update_db refuses BEFORE its UPDATE, and one refused row refuses the
 *     whole statement.
 *   - READS (get_setting, get_settings) refuse secrets from either source and
 *     keep every live workflow read working (the nine keys below, read by the
 *     live definitions 2026-10-17), values verbatim.
 *
 * HARNESS: the REAL functions over a mini app_settings store whose evaluator
 * runs each statement's own SELECT list and WHERE text (`key` = / != / IN /
 * NOT IN, integer-literal column equality) against stored rows — dropping or
 * changing a guard clause changes behaviour here instead of passing against
 * scripted results. `key` compares the way MySQL's utf8mb4_general_ci PAD
 * SPACE does (case-insensitive, trailing spaces ignored), so a key spelled
 * differently reaches the real row here as it does live. An unknown statement
 * or clause THROWS. update_db runs in a snapshot/restore transaction, like
 * the engine's.
 *
 * Run: npx jest tests/settingsAutomationGuard.test.js
 */
'use strict';

const systemFns = require('../lib/internal_functions/system');
const dbFns = require('../lib/internal_functions/db');
const settingsRegistry = require('../lib/settingsRegistry');

// ─────────────────────────────────────────────────────────────
// Mini app_settings store + evaluator
// ─────────────────────────────────────────────────────────────

const COLUMNS = ['key', 'value', 'category', 'label', 'description', 'type', 'is_secret', 'is_editable', 'sort_order', 'updated_at'];

function row(key, value, { is_secret = 0, is_editable = 1 } = {}) {
  return { key, value, category: null, label: null, description: null, type: 'string',
           is_secret, is_editable, sort_order: 0, updated_at: '2026-10-17 12:00:00' };
}

/** The live automation-read keys (2026-10-17) plus the shapes the guard sorts. */
function seedRows() {
  return [
    // live reads (workflows get_setting / get_settings)
    row('email_domains', '@firm.example, @firm2.example'),
    row('office_alerts_to', '3,7'),
    row('email_automations', 'auto@firm.example'),
    row('firm_attorney_name', 'A. Attorney'),
    row('billing_tasks_to', '7'),
    row('payment_failed_cooldown_days', '3'),       // registered 2026-10-28 (was an automation variable)
    row('court_ingest_live', '1'),
    row('esign_test_mode', '0'),
    row('dropbox_unsorted_forms_path', '  _Unsorted Forms '),   // load-bearing spaces
    // the one registered key automation writes
    row('clio_login_code', '000000', { is_editable: 0 }),
    // registered, not automation's
    row('firm_name', 'The Firm'),
    row('portal_sms_counter', '{"ym":"2026-10","count":3}', { is_editable: 0 }),
    row('esign_webhook_hmac_mode', 'enforce', { is_editable: 0 }),            // retired
    // a registered secret whose row flag was fat-fingered to 0
    row('quo_api_key', 'live-provider-key', { is_secret: 0, is_editable: 1 }),
    // an unregistered secret row
    row('vendor_side_token', 'tok', { is_secret: 1, is_editable: 0 }),
    // an unregistered automation variable
    row('intake_banner_text', 'Welcome'),
  ];
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').replace(/`/g, '').trim();

// app_settings.key is utf8mb4_general_ci PAD SPACE: 'COURT_INGEST_LIVE ' = 'court_ingest_live'.
const fold = (col, v) => (col === 'key' ? String(v).toLowerCase().replace(/ +$/, '') : String(v));

/** WHERE evaluator: AND-joined clauses over one row; unknown → throw. */
function whereFn(whereSql, params) {
  let pi = 0;
  const clauses = whereSql.split(/\s+AND\s+/i).map((c) => c.trim());
  const preds = clauses.map((c) => {
    let m;
    if ((m = /^(\w+) (=|!=|<>) \?$/.exec(c))) {
      const [, col, op] = m; const v = params[pi++];
      return (r) => (op === '=' ? fold(col, r[col]) === fold(col, v) : fold(col, r[col]) !== fold(col, v));
    }
    if ((m = /^(\w+) (NOT IN|IN) \(([?, ]+)\)$/i.exec(c))) {
      const [, col, op, marks] = m;
      const n = marks.split(',').length;
      const vs = params.slice(pi, pi + n).flat().map((v) => fold(col, v)); pi += n;
      return (r) => (/NOT/i.test(op) ? !vs.includes(fold(col, r[col])) : vs.includes(fold(col, r[col])));
    }
    if ((m = /^(\w+) = (\d+)$/.exec(c))) {
      const [, col, lit] = m;
      return (r) => Number(r[col]) === Number(lit);
    }
    throw new Error(`fake app_settings: unknown WHERE clause: ${c}`);
  });
  return { test: (r) => preds.every((p) => p(r)), consumed: () => pi };
}

function project(r, cols) {
  if (cols.trim() === '*') return { ...r };
  const out = {};
  for (const raw of cols.split(',').map((s) => s.trim())) {
    if (/^COUNT\(\*\) AS n$/i.test(raw)) continue;
    if (!COLUMNS.includes(raw)) throw new Error(`fake app_settings: unknown column ${raw}`);
    out[raw] = r[raw];
  }
  return out;
}

function makeDb(rows = seedRows()) {
  const store = rows.map((r) => ({ ...r }));
  const calls = [];

  const query = async (sql, params = []) => {
    const s = norm(sql);
    calls.push({ sql: s, params });

    // update_db's schema read (cached per process; reset per test).
    if (/FROM information_schema\.COLUMNS/i.test(s)) {
      return [COLUMNS.map((c) => ({
        COLUMN_NAME: c,
        COLUMN_KEY: c === 'key' ? 'PRI' : '',
        EXTRA: c === 'updated_at' ? 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' : '',
        COLUMN_DEFAULT: c === 'updated_at' ? 'CURRENT_TIMESTAMP' : null,
        GENERATION_EXPRESSION: '',
      }))];
    }

    let m;
    if ((m = /^SELECT COUNT\(\*\) AS n FROM app_settings WHERE (.+)$/i.exec(s))) {
      const w = whereFn(m[1], params);
      return [[{ n: store.filter(w.test).length }]];
    }
    if ((m = /^SELECT (.+?) FROM app_settings WHERE (.+?)( LIMIT 1)?$/i.exec(s))) {
      const w = whereFn(m[2], params);
      let hits = store.filter(w.test);
      if (m[3]) hits = hits.slice(0, 1);
      return [hits.map((r) => project(r, m[1]))];
    }
    if ((m = /^UPDATE app_settings SET (.+?) WHERE (.+?)( LIMIT (\d+))?$/i.exec(s))) {
      const sets = m[1].split(',').map((x) => x.trim()).map((a) => {
        const sm = /^(\w+) = \?$/.exec(a);
        if (!sm || !COLUMNS.includes(sm[1])) throw new Error(`fake app_settings: unknown SET ${a}`);
        return sm[1];
      });
      const setVals = params.slice(0, sets.length);
      const w = whereFn(m[2], params.slice(sets.length));
      let hits = store.filter(w.test);
      if (m[4]) hits = hits.slice(0, Number(m[4]));
      for (const r of hits) sets.forEach((c, i) => { r[c] = setVals[i]; });
      return [{ affectedRows: hits.length, changedRows: hits.length }];
    }
    throw new Error(`fake app_settings: unknown statement: ${s}`);
  };

  return {
    store, calls, query,
    get: (k) => store.find((r) => r.key === k),
    // The engine's transaction: snapshot, roll back on throw.
    withTransaction: async (fn) => {
      const snap = store.map((r) => ({ ...r }));
      try { return await fn({ query }); } catch (err) {
        store.splice(0, store.length, ...snap);
        throw err;
      }
    },
  };
}

const updates = (db) => db.calls.filter((c) => /^UPDATE app_settings/i.test(c.sql));

beforeEach(() => {
  dbFns.__resetWriteSchemaCache();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

// The fixture's premises, from the registry itself — if the registry moves,
// these fail first instead of the guards below passing for the wrong reason.
test('fixture premises match the registry', () => {
  expect(settingsRegistry.get('clio_login_code').automation).toBe(true);
  expect(Object.entries(settingsRegistry.SETTINGS).filter(([, e]) => e.automation === true).map(([k]) => k))
    .toEqual(['clio_login_code']);
  for (const k of ['firm_name', 'portal_sms_counter', 'esign_webhook_hmac_mode']) {
    expect(settingsRegistry.isRegistered(k)).toBe(true);
  }
  expect(settingsRegistry.get('quo_api_key').kind).toBe('secret');
  for (const k of ['vendor_side_token', 'intake_banner_text', 'no_such_key']) {
    expect(settingsRegistry.isRegistered(k)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────
// set_setting
// ─────────────────────────────────────────────────────────────

describe('set_setting', () => {
  test('clio_login_code (registered, automation: true — phone-ingest rule 4) is written, verbatim', async () => {
    const db = makeDb();
    const r = await systemFns.set_setting({ key: 'clio_login_code', value: ' 482913 ' }, db);
    expect(r).toMatchObject({ success: true, output: { key: 'clio_login_code', length: 8 } });
    expect(db.get('clio_login_code').value).toBe(' 482913 ');
  });

  test('an unregistered non-secret row (an automation variable) stays writable', async () => {
    const db = makeDb();
    await systemFns.set_setting({ key: 'intake_banner_text', value: 'Closed Friday' }, db);
    expect(db.get('intake_banner_text').value).toBe('Closed Friday');
  });

  test('every other registered key is refused BEFORE the row is read — no query at all', async () => {
    for (const key of ['firm_name', 'portal_sms_counter', 'esign_webhook_hmac_mode', 'court_ingest_live']) {
      const db = makeDb();
      const before = db.get(key).value;
      await expect(systemFns.set_setting({ key, value: 'x' }, db)).rejects.toThrow(
        `set_setting: "${key}" is a registered setting automation may not write (lib/settingsRegistry.js)`);
      expect(db.calls).toEqual([]);
      expect(db.get(key).value).toBe(before);
    }
  });

  test('a registered key with NO row is refused as registered, not as "does not exist"', async () => {
    const db = makeDb(seedRows().filter((r) => r.key !== 'firm_name'));
    await expect(systemFns.set_setting({ key: 'firm_name', value: 'x' }, db))
      .rejects.toThrow(/"firm_name" is a registered setting automation may not write/);
    expect(db.calls).toEqual([]);
  });

  test('a registered secret is refused even when its row says is_secret = 0 (no query)', async () => {
    const db = makeDb();
    await expect(systemFns.set_setting({ key: 'quo_api_key', value: 'x' }, db))
      .rejects.toThrow('set_setting: "quo_api_key" is a secret and cannot be written by automation');
    expect(db.calls).toEqual([]);
    expect(db.get('quo_api_key').value).toBe('live-provider-key');
  });

  test('an unregistered row flagged is_secret = 1 is refused after the row read; nothing written', async () => {
    const db = makeDb();
    await expect(systemFns.set_setting({ key: 'vendor_side_token', value: 'x' }, db))
      .rejects.toThrow('set_setting: "vendor_side_token" is a secret and cannot be written by automation');
    expect(updates(db)).toEqual([]);
    expect(db.get('vendor_side_token').value).toBe('tok');
  });

  test('an unknown (unregistered, absent) key still → "does not exist"', async () => {
    const db = makeDb();
    await expect(systemFns.set_setting({ key: 'no_such_key', value: 'x' }, db))
      .rejects.toThrow('set_setting: setting "no_such_key" does not exist (create the row in the DB console first)');
    expect(updates(db)).toEqual([]);
  });

  test('__meta no longer claims the is_editable / settings.html story; names the registry', () => {
    const d = systemFns.set_setting.__meta.description;
    expect(d).not.toMatch(/is_editable|settings\.html/);
    expect(d).toMatch(/lib\/settingsRegistry\.js/);
  });
});

// ─────────────────────────────────────────────────────────────
// get_setting / get_settings
// ─────────────────────────────────────────────────────────────

const LIVE_READS = ['email_domains', 'office_alerts_to', 'email_automations', 'firm_attorney_name',
  'billing_tasks_to', 'payment_failed_cooldown_days', 'court_ingest_live', 'esign_test_mode',
  'dropbox_unsorted_forms_path'];

describe('get_setting / get_settings', () => {
  test('every live workflow read keeps working, verbatim — one by one', async () => {
    const db = makeDb();
    for (const key of LIVE_READS) {
      const r = await systemFns.get_setting({ key, output_var: 'v' }, db);
      expect(r).toMatchObject({ success: true, output: db.get(key).value, set_vars: { v: db.get(key).value } });
    }
    expect((await systemFns.get_setting({ key: 'dropbox_unsorted_forms_path' }, db)).output).toBe('  _Unsorted Forms ');
  });

  test('…and in one get_settings call', async () => {
    const db = makeDb();
    const r = await systemFns.get_settings({ keys: LIVE_READS.join(', '), output_var: 's' }, db);
    expect(r.output).toEqual(Object.fromEntries(LIVE_READS.map((k) => [k, db.get(k).value])));
    expect(r.set_vars.s).toEqual(r.output);
  });

  test('a registered secret is refused even under is_secret = 0; an is_secret = 1 row too', async () => {
    const db = makeDb();
    await expect(systemFns.get_setting({ key: 'quo_api_key' }, db))
      .rejects.toThrow('get_setting: "quo_api_key" is a secret and cannot be read by automation');
    await expect(systemFns.get_setting({ key: 'vendor_side_token' }, db))
      .rejects.toThrow('get_setting: "vendor_side_token" is a secret and cannot be read by automation');
  });

  test('get_settings is all-or-nothing and names both secret kinds', async () => {
    const db = makeDb();
    await expect(systemFns.get_settings({ keys: 'court_ingest_live, quo_api_key, vendor_side_token, nope' }, db))
      .rejects.toThrow('get_settings: settings do not exist: nope; are secret and cannot be read by automation: quo_api_key, vendor_side_token');
  });

  test('reads are not limited to automation-writable keys (a registered firm key reads fine)', async () => {
    const db = makeDb();
    expect((await systemFns.get_setting({ key: 'firm_name' }, db)).output).toBe('The Firm');
  });
});

// ─────────────────────────────────────────────────────────────
// update_db on app_settings
// ─────────────────────────────────────────────────────────────

describe('update_db app_settings guard', () => {
  const flat = (key, value) => ({ table: 'app_settings', set_column: 'value', set_value: value,
                                  where_column: 'key', where_value: key });

  test('the phone-ingest flat form on clio_login_code writes', async () => {
    const db = makeDb();
    const r = await dbFns.update_db(flat('clio_login_code', '135790'), db);
    expect(r.output).toMatchObject({ table: 'app_settings', affected_rows: 1 });
    expect(db.get('clio_login_code').value).toBe('135790');
  });

  test('an unregistered automation variable writes', async () => {
    const db = makeDb();
    await dbFns.update_db(flat('intake_banner_text', 'Open'), db);
    expect(db.get('intake_banner_text').value).toBe('Open');
  });

  test('a registered setting automation may not write is refused before any UPDATE', async () => {
    for (const key of ['firm_name', 'portal_sms_counter', 'esign_webhook_hmac_mode']) {
      const db = makeDb();
      const before = db.get(key).value;
      await expect(dbFns.update_db(flat(key, 'x'), db)).rejects.toThrow(
        `update_db: app_settings "${key}" is a registered setting automation may not write (lib/settingsRegistry.js)`);
      expect(updates(db)).toEqual([]);
      expect(db.get(key).value).toBe(before);
    }
  });

  test('secrets from either source are refused before any UPDATE', async () => {
    for (const key of ['quo_api_key', 'vendor_side_token']) {
      const db = makeDb();
      await expect(dbFns.update_db(flat(key, 'x'), db))
        .rejects.toThrow(`update_db: app_settings "${key}" is a secret and cannot be written by automation`);
      expect(updates(db)).toEqual([]);
    }
  });

  test('one refused row refuses the whole multi-row UPDATE; the message names only the refused', async () => {
    const db = makeDb();
    await expect(dbFns.update_db({
      table: 'app_settings', set: { value: 'x' }, max_rows: 3,
      where: [{ column: 'key', op: 'IN', value: ['clio_login_code', 'firm_name', 'intake_banner_text'] }],
    }, db)).rejects.toThrow(/^update_db: app_settings "firm_name" is a registered setting automation may not write \(lib\/settingsRegistry\.js\)$/);
    expect(updates(db)).toEqual([]);
    expect(db.get('clio_login_code').value).toBe('000000');
    expect(db.get('intake_banner_text').value).toBe('Welcome');
  });

  test('several refused rows are each named', async () => {
    const db = makeDb();
    await expect(dbFns.update_db({
      table: 'app_settings', set: { value: 'x' }, max_rows: 2,
      where: [{ column: 'key', op: 'IN', value: ['firm_name', 'quo_api_key'] }],
    }, db)).rejects.toThrow('update_db: app_settings "firm_name" is a registered setting automation may not write (lib/settingsRegistry.js); "quo_api_key" is a secret and cannot be written by automation');
  });

  test('an all-allowed multi-row UPDATE goes through', async () => {
    const db = makeDb();
    await dbFns.update_db({
      table: 'app_settings', set: { value: 'y' }, max_rows: 2,
      where: [{ column: 'key', op: 'IN', value: ['clio_login_code', 'intake_banner_text'] }],
    }, db);
    expect([db.get('clio_login_code').value, db.get('intake_banner_text').value]).toEqual(['y', 'y']);
  });

  test('is_secret / is_editable stay blocked from SET (the policy\'s own guard, unchanged)', async () => {
    const db = makeDb();
    await expect(dbFns.update_db({ table: 'app_settings', set_column: 'is_editable', set_value: 1,
      where_column: 'key', where_value: 'intake_banner_text' }, db))
      .rejects.toThrow('update_db: app_settings.is_editable is blocked from writes by policy');
  });
});

// ─────────────────────────────────────────────────────────────
// The collation (review F1, 2026-10-18): MySQL answers `key` = 'COURT_INGEST_LIVE '
// with the court_ingest_live row, while the registry lookup is exact — so a
// spelling the registry does not know must not reach a row it does.
// ─────────────────────────────────────────────────────────────

describe('a key spelled differently reaches no other setting', () => {
  const ALIASES = [['COURT_INGEST_LIVE', 'court_ingest_live'], ['court_ingest_live ', 'court_ingest_live'],
    ['Firm_Name', 'firm_name'], ['Portal_Sms_Counter', 'portal_sms_counter'], ['Quo_Api_Key', 'quo_api_key'],
    ['CLIO_LOGIN_CODE', 'clio_login_code'], ['Intake_Banner_Text', 'intake_banner_text']];

  test('set_setting: refused as not existing, naming the stored key; nothing written', async () => {
    for (const [alias, stored] of ALIASES) {
      const db = makeDb();
      const before = db.get(stored).value;
      await expect(systemFns.set_setting({ key: alias, value: 'x' }, db)).rejects.toThrow(
        `set_setting: setting "${alias}" does not exist (keys match exactly — did you mean "${stored}"?)`);
      expect(updates(db)).toEqual([]);
      expect(db.get(stored).value).toBe(before);
    }
  });

  test('get_setting: refused as not existing; the value never returned', async () => {
    for (const [alias, stored] of ALIASES) {
      const db = makeDb();
      await expect(systemFns.get_setting({ key: alias }, db)).rejects.toThrow(
        `get_setting: setting "${alias}" does not exist (keys match exactly — did you mean "${stored}"?)`);
    }
  });

  test('get_settings: an alias is a missing key (all-or-nothing)', async () => {
    const db = makeDb();
    await expect(systemFns.get_settings({ keys: 'court_ingest_live, QUO_API_KEY, Firm_Name' }, db))
      .rejects.toThrow('get_settings: settings do not exist: QUO_API_KEY, Firm_Name');
  });

  test('update_db: the guard judges the row MySQL matched, not the spelling asked', async () => {
    const db = makeDb();
    await expect(dbFns.update_db({ table: 'app_settings', set_column: 'value', set_value: '0',
      where_column: 'key', where_value: 'COURT_INGEST_LIVE' }, db))
      .rejects.toThrow('update_db: app_settings "court_ingest_live" is a registered setting automation may not write (lib/settingsRegistry.js)');
    await expect(dbFns.update_db({ table: 'app_settings', set_column: 'value', set_value: 'x',
      where_column: 'key', where_value: 'quo_api_key ' }, db))
      .rejects.toThrow('update_db: app_settings "quo_api_key" is a secret and cannot be written by automation');
    expect(updates(db)).toEqual([]);
  });

  test('the exact spellings still work', async () => {
    const db = makeDb();
    await systemFns.set_setting({ key: 'clio_login_code', value: '1' }, db);
    await systemFns.set_setting({ key: 'intake_banner_text', value: 'Hi' }, db);
    expect((await systemFns.get_setting({ key: 'court_ingest_live' }, db)).output).toBe('1');
    expect([db.get('clio_login_code').value, db.get('intake_banner_text').value]).toEqual(['1', 'Hi']);
  });
});
