// lib/internal_functions/db.js

// ─────────────────────────────────────────────────────────────
// query_db security config
// ─────────────────────────────────────────────────────────────

const QUERY_DB_ALLOWED_TABLES = new Set([
  'contacts', 'cases', 'appts', 'tasks', 'log',
  'users', 'phone_lines', 'scheduled_jobs',
  'workflows', 'workflow_executions', 'workflow_execution_steps',
  'sequence_templates', 'sequence_steps', 'sequence_enrollments', 'sequence_step_log',
  'case_relate',
  'judges', 'trustees',
  'checkitems', 'checklists',
  'job_results',
  // NOTE: cases.case_judge and cases.case_trustee are varchar columns on cases —
  // join directly: ON cases.case_judge = judges.judge_name
  //                ON cases.case_trustee = trustees.trustee_full_name
]);

const QUERY_DB_BLOCKED_COLUMNS = {
  users: ['password', 'password_hash'],
};

const QUERY_DB_WHERE_OPS  = new Set(['=','!=','<>','>','<','>=','<=','LIKE','NOT LIKE','IN','NOT IN','IS NULL','IS NOT NULL']);
const QUERY_DB_JOIN_TYPES = new Set(['inner','left','right','left outer','right outer']);
const QUERY_DB_ORDER_DIRS = new Set(['asc','desc']);

function _qdbValidateId(id, label) {
  if (!id || typeof id !== 'string') throw new Error(`query_db: ${label} must be a non-empty string`);
  if (!/^[\w.]+$/.test(id)) throw new Error(`query_db: invalid ${label} "${id}"`);
  return id;
}
function _qdbEscId(id) {
  return id.split('.').map(p => `\`${p}\``).join('.');
}
function _qdbValidateTable(name, label) {
  if (!QUERY_DB_ALLOWED_TABLES.has(name.trim())) throw new Error(`query_db: table "${name}" is not allowed (${label})`);
  return name.trim();
}

const fns = {};

// ─────────────────────────────────────────────────────────────
// GENERAL QUERY
// ─────────────────────────────────────────────────────────────

/**
 * query_db
 * Build and execute a safe parameterized SELECT from a JSON descriptor.
 * No raw SQL accepted — query is built from validated, whitelisted
 * identifiers with fully parameterized WHERE values.
 *
 * params:
 *   select       {string[]}  columns e.g. ["contacts.contact_name","appts.appt_date"]
 *                            use "*" for all columns from the FROM table
 *   from         {string}    primary table name
 *   join         {object[]}  optional JOIN clauses (see shape below)
 *   where        {object[]}  optional WHERE conditions (see shape below)
 *   where_mode   "and"|"or"  default "and"
 *   order_by     {object[]}  optional [{ column, dir: "asc"|"desc" }]
 *   limit        {number}    default 100, max 1000
 *   format       "raw"|"html_rows"|"count"|"first"   default "raw"
 *   output_var   {string}    store result in this workflow variable
 *   count_var    {string}    store row count in this variable
 *   base_url     {string}    base URL for links in html_rows
 *   html_columns {object[]}  column display config for html_rows
 *
 * JOIN shape:
 *   { type: "left", table: "judges", alias: "j",
 *     on: { left: "cj.judge_id", right: "j.judge_id" } }
 *
 * WHERE shape:
 *   { column: "appts.appt_status", op: "=",       value: "Scheduled" }
 *   { column: "appts.appt_date",   op: ">=",      value: "{{fromDate}}" }
 *   { column: "appts.appt_id",     op: "IN",      value: [1, 2, 3] }
 *   { column: "contacts.contact_dob", op: "IS NULL" }
 *
 * HTML_COLUMNS shape:
 *   [
 *     { column: "appts.appt_id",         label: "ID" },
 *     { column: "contacts.contact_name", label: "Client",
 *       link_base: "/?contact=", link_id: "contacts.contact_id" }
 *   ]
 *
 * Security:
 *   - Only tables in QUERY_DB_ALLOWED_TABLES may be queried
 *   - users.password and users.password_hash stripped from all results
 *   - All identifiers validated as word characters only
 *   - All values fully parameterized — no injection possible
 *
 * Example — fetch judge and trustee for a case:
 *   {
 *     "function_name": "query_db",
 *     "params": {
 *       "select": ["j.judge_name", "j.judge_court", "t.trustee_name"],
 *       "from": "cases",
 *       "join": [
 *         { "type": "left", "table": "case_judge",  "alias": "cj",
 *           "on": { "left": "cases.case_id", "right": "cj.case_id" } },
 *         { "type": "left", "table": "judges",      "alias": "j",
 *           "on": { "left": "cj.judge_id",  "right": "j.judge_id" } },
 *         { "type": "left", "table": "case_trustee","alias": "ct",
 *           "on": { "left": "cases.case_id", "right": "ct.case_id" } },
 *         { "type": "left", "table": "trustees",    "alias": "t",
 *           "on": { "left": "ct.trustee_id","right": "t.trustee_id" } }
 *       ],
 *       "where": [{ "column": "cases.case_id", "op": "=", "value": "{{caseId}}" }],
 *       "format": "first",
 *       "output_var": "caseDetails"
 *     }
 *   }
 */

fns.query_db = async (params, db) => {
    const {
      select, from, join = [], where = [],
      where_mode = 'and', order_by = [],
      limit = 100, format = 'raw',
      output_var, count_var,
      base_url = process.env.APP_URL || 'https://app.4lsg.com',
      html_columns,
    } = params;

    if (!from) throw new Error('query_db: "from" is required');
    if (!select || !Array.isArray(select) || !select.length)
      throw new Error('query_db: "select" must be a non-empty array');

    const fromTable = _qdbValidateTable(_qdbValidateId(from, 'from'), 'from');

    // Build alias → real table map (needed to validate SELECT/WHERE references)
    const aliasMap = new Map();
    aliasMap.set(fromTable, fromTable);

    // ── Validate JOINs first so aliases are registered ──
    const joinClauses = [];
    for (const j of join) {
      const joinType  = (j.type || 'left').toLowerCase();
      if (!QUERY_DB_JOIN_TYPES.has(joinType)) throw new Error(`query_db: invalid join type "${j.type}"`);
      const joinTable = _qdbValidateTable(_qdbValidateId(j.table, 'join.table'), 'join.table');
      const alias     = j.alias ? _qdbValidateId(j.alias, 'join.alias') : null;
      if (alias) aliasMap.set(alias, joinTable);
      aliasMap.set(joinTable, joinTable);
      if (!j.on?.left || !j.on?.right) throw new Error('query_db: each join requires on.left and on.right');
      _qdbValidateId(j.on.left, 'join.on.left');
      _qdbValidateId(j.on.right, 'join.on.right');
      const aliasSql = alias ? ` \`${alias}\`` : '';
      joinClauses.push(
        `${joinType.toUpperCase()} JOIN \`${joinTable}\`${aliasSql} ON ${_qdbEscId(j.on.left)} = ${_qdbEscId(j.on.right)}`
      );
    }

    // ── SELECT ──
    const selectParts = [];
    for (const col of select) {
      if (col === '*') { selectParts.push(`\`${fromTable}\`.*`); continue; }
      _qdbValidateId(col, 'select column');
      const tableRef = col.split('.')[0];
      if (!aliasMap.has(tableRef)) throw new Error(`query_db: select references unknown table/alias "${tableRef}"`);
      selectParts.push(_qdbEscId(col));
    }

    // ── WHERE ──
    const whereParams = [];
    const whereParts  = [];
    for (const clause of where) {
      if (!clause.column || !clause.op) throw new Error('query_db: each where clause needs column and op');
      _qdbValidateId(clause.column, 'where.column');
      const tableRef = clause.column.split('.')[0];
      if (!aliasMap.has(tableRef)) throw new Error(`query_db: where references unknown table/alias "${tableRef}"`);
      const op = clause.op.toUpperCase();
      if (!QUERY_DB_WHERE_OPS.has(op)) throw new Error(`query_db: invalid operator "${clause.op}"`);
      if (op === 'IS NULL' || op === 'IS NOT NULL') {
        whereParts.push(`${_qdbEscId(clause.column)} ${op}`);
      } else if (op === 'IN' || op === 'NOT IN') {
        if (!Array.isArray(clause.value) || !clause.value.length)
          throw new Error('query_db: IN/NOT IN requires a non-empty array value');
        whereParts.push(`${_qdbEscId(clause.column)} ${op} (${clause.value.map(() => '?').join(', ')})`);
        whereParams.push(...clause.value);
      } else {
        whereParts.push(`${_qdbEscId(clause.column)} ${op} ?`);
        whereParams.push(clause.value ?? null);
      }
    }

    // ── ORDER BY ──
    const orderParts = [];
    for (const o of order_by) {
      if (!o.column) throw new Error('query_db: order_by entry needs column');
      _qdbValidateId(o.column, 'order_by.column');
      const dir = (o.dir || 'asc').toLowerCase();
      if (!QUERY_DB_ORDER_DIRS.has(dir)) throw new Error(`query_db: invalid order direction "${o.dir}"`);
      orderParts.push(`${_qdbEscId(o.column)} ${dir.toUpperCase()}`);
    }

    const limitInt = Math.min(Math.max(1, parseInt(limit) || 100), 1000);

    // ── Assemble SQL ──
    const sql = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM \`${fromTable}\``,
      ...joinClauses,
      whereParts.length ? `WHERE ${whereParts.join(` ${where_mode.toUpperCase()} `)}` : '',
      orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '',
      `LIMIT ${limitInt}`,
    ].filter(Boolean).join(' ');

    console.log(`[QUERY_DB] SQL: ${sql}`);

    let rows;
    try {
      [rows] = await db.query(sql, whereParams);
    } catch (err) {
      throw new Error(`query_db execution failed: ${err.message}
SQL: ${sql}`);
    }

    // ── Strip blocked columns ──
    rows = rows.map(row => {
      const clean = { ...row };
      for (const [, realTable] of aliasMap.entries()) {
        (QUERY_DB_BLOCKED_COLUMNS[realTable] || []).forEach(col => delete clean[col]);
      }
      return clean;
    });

    const count = rows.length;

    // ── Format ──
    let output;
    if (format === 'count') {
      output = count;
    } else if (format === 'first') {
      output = rows[0] || null;
    } else if (format === 'html_rows') {
      if (count === 0) {
        output = `<tr><td colspan="${select.length}" style="text-align:center;padding:12px;color:#888;">No results</td></tr>`;
      } else if (html_columns && Array.isArray(html_columns)) {
        output = rows.map(row => {
          const cells = html_columns.map(hc => {
            const rawVal = row[hc.column] ?? row[hc.column.split('.').pop()] ?? '';
            let cell;
            if (hc.link_base && hc.link_id) {
              const linkId = row[hc.link_id] ?? row[hc.link_id.split('.').pop()] ?? '';
              cell = `<a href="${base_url}${hc.link_base}${linkId}" style="color:#1a73e8;">${rawVal}</a>`;
            } else {
              cell = String(rawVal);
            }
            return `<td style="padding:6px;border:1px solid #ddd;">${cell}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
      } else {
        output = rows.map(row =>
          `<tr>${Object.values(row).map(v =>
            `<td style="padding:6px;border:1px solid #ddd;">${v ?? ''}</td>`
          ).join('')}</tr>`
        ).join('');
      }
    } else {
      output = rows;
    }

    const set_vars = {};
    if (output_var) set_vars[output_var] = output;
    if (count_var)  set_vars[count_var]  = count;

    return { success: true, output, count, set_vars };
  };

fns.query_db.__meta = {
  category: 'general',
  description: 'Build and execute a safe parameterized SELECT from a JSON descriptor. Whitelisted tables only.',
  params: [
    { name: 'select', type: 'array', required: true,
      description: 'Columns. ["*"] for all from `from`. e.g. ["contacts.contact_name","appts.appt_date"].',
      example: ['contacts.contact_name', 'appts.appt_date'] },
    { name: 'from', type: 'string', required: true, strictString: true,
      description: 'Primary table (whitelisted). Runtime _qdbValidateId rejects a non-string, so strictString keeps that a save-time 400.', example: 'cases' },
    { name: 'join', type: 'array', required: false,
      description: 'JOIN clauses. Each: { type, table, alias?, on:{left,right} }.' },
    { name: 'where', type: 'array', required: false,
      description: 'WHERE clauses. Each: { column, op, value? }. {{placeholders}} OK in value.' },
    { name: 'where_mode', type: 'enum', required: false,
      enum: ['and','or'], default: 'and' },
    { name: 'order_by', type: 'array', required: false,
      description: 'ORDER BY entries. Each: { column, dir: "asc"|"desc" }.' },
    { name: 'limit', type: 'integer', required: false, default: 100, min: 1, max: 1000 },
    { name: 'format', type: 'enum', required: false,
      enum: ['raw','html_rows','count','first'], default: 'raw' },
    { name: 'output_var', type: 'string', required: false },
    { name: 'count_var', type: 'string', required: false },
    { name: 'base_url', type: 'string', required: false },
    { name: 'html_columns', type: 'array', required: false,
      description: 'Per-column display config for html_rows. Each: { column, label, link_base?, link_id? }.' },
  ],
  example: { select: ['cases.case_id'], from: 'cases', limit: 10 }
};

// ═════════════════════════════════════════════════════════════
// WRITE SIDE — update_db / insert_db
//
// The write twin of query_db. Same contract: NO raw SQL is ever accepted. The
// statement is assembled from validated, whitelisted identifiers with fully
// parameterized values.
//
// WHY THIS EXISTS (and why there is no run_sql)
//   A general run_sql internal function cannot be safely gated. Internal
//   functions execute as fn(params, db): there is no `req`, no auth context, no
//   user. Workflows advance in a detached promise, scheduled jobs run off a
//   poller, and hook deliveries fire from a PUBLIC UNAUTHENTICATED endpoint.
//   There is nobody to check at run time. Note that custom_code steps
//   deliberately get a vm sandbox of {input, console} with NO db — that is the
//   boundary this module respects rather than erases. Raw SQL lives in the
//   SU-gated, rate-limited, audit-logged DB console and nowhere else.
//
// TABLE ELIGIBILITY RULE — a table belongs in WRITE_POLICY iff ALL hold:
//   1. Nothing else owns its lifecycle (no engine, no service invariant, no
//      dedicated internal function carrying its own column whitelist).
//   2. It holds no auth or secret material.
//   3. It is not an audit / forensic record.
//   4. A wrong write is recoverable.
//
// DELIBERATELY EXCLUDED — do not "just add" these:
//   auth/secrets ...... users, tempusers, credentials, email_credentials*,
//                       readonly_api_keys.  users.user_auth is a one-UPDATE path
//                       to superuser; credentials.allowed_urls is a one-UPDATE
//                       path to SSRF/exfil.
//   control plane ..... workflows*, sequence*, seq_*, scheduled_jobs, job_results,
//                       hooks, hook_*, *_ingest_*, phone_log_suppressions,
//                       campaigns*.  Self-modifying automation.
//   audit/forensic .... admin_audit_log, jwt_api_audit_log, query_log,
//                       readonly_query_log, legacy_route_log, ai_calls,
//                       ai_change_log, court_ai_log, court_emails*,
//                       phone_event_log, email_log, rc_*_log, system_alerts,
//                       alert_state.  Mutable audit is not audit.
//   fn-owned .......... contacts (-> update_contact), cases (-> update_case),
//                       appts (-> update_appointment), events (-> update_event /
//                       complete_event), log (-> create_log).  Two write paths to
//                       one table means two column whitelists that will drift.
//                       NOTE cases.case_status is ALREADY in update_case's ALLOWED,
//                       so the Case Pipeline Engine has no gap here.
//   dead/backup ....... _dead_*, *_backup_*, phase_c_backup_*, mytable, test,
//                       `default`, temp_*, ringcentral_temp, settings (legacy —
//                       app_settings is the live one), checkitems1, checklists1.
//
// SETTABLE COLUMNS ARE DERIVED, NOT DECLARED.
//   A hand-maintained per-table SET whitelist rots (see update_case/update_contact,
//   which each carry one). Instead the real schema is read from information_schema
//   (cached per process) and a column is settable iff it is NOT a PRIMARY KEY
//   column, NOT auto_increment, and does NOT carry GENERATED in EXTRA. That last
//   test is load-bearing twice:
//     - VIRTUAL/STORED GENERATED columns (contact_phones.phone_active_uniq,
//       contact_emails.email_active_uniq, the three is_primary_uniq columns,
//       appts.appt_end) make MySQL throw if you SET them.
//     - DEFAULT_GENERATED sweeps up every created_at / updated_at for free.
//   Per-table `block` adds anything the schema cannot tell us is dangerous.
//
// SO A POLICY ENTRY ONLY DECLARES:
//   where  {string[]}  columns permitted in WHERE. NOT a free-for-all — this is
//                      what stops `WHERE notes LIKE '%'`. Identity columns only.
//   block  {string[]}  extra columns barred from SET, beyond the derived set.
//   insert {boolean}   may insert_db target this table at all.
//   guard  {function?} async row-level veto, run against the matched rows.
//
// Adding a table is therefore ONE LINE — and that line is a code-review
// checkpoint, which is the point.
// ═════════════════════════════════════════════════════════════

/**
 * Row-level guard for app_settings. is_secret rows are never touched by
 * automation, mirroring routes/api.appSettings.js's belt-and-suspenders gate:
 * a fat-fingered is_editable=1 on a secret still must not leak or clobber it.
 */
async function _guardAppSettings(conn, table, whereSql, whereParams) {
  const [rows] = await conn.query(
    `SELECT \`key\` FROM \`app_settings\` WHERE ${whereSql} AND is_secret = 1`,
    whereParams
  );
  if (rows.length) {
    throw new Error(
      `update_db: app_settings ${rows.map(r => `"${r.key}"`).join(', ')} ` +
      `is_secret — secrets cannot be written by automation`
    );
  }
}

const WRITE_POLICY = {
  app_settings: {
    where:  ['key'],
    // `key` is the PK, so it is derived-blocked already. is_secret / is_editable
    // are the privilege flags: flipping is_editable=1 on a secret would expose it
    // through GET /api/app-settings, so both are hard-blocked here too.
    block:  ['is_secret', 'is_editable'],
    insert: false,        // new keys are created in the DB console — same rule as the route
    guard:  _guardAppSettings,
  },
  rw_scratch: {
    where:  ['id', 'ns', 'k'],
    block:  [],
    insert: true,
  },
  tasks: {
    where:  ['task_id', 'task_link_id', 'task_link_type', 'task_to'],
    // task_action_token authenticates the emailed task-action links; task_due_job_id
    // is a live FK into scheduled_jobs owned by the task service.
    block:  ['task_action_token', 'task_due_job_id'],
    insert: false,        // create_task owns INSERT — it also mints the token and the due job
  },
  checkitems:        { where: ['id', 'checklist_id'],                                              block: [], insert: true },
  checklists:        { where: ['id', 'link', 'link_type'],                                         block: [], insert: true },
  case_relate:       { where: ['case_relate_id', 'case_relate_case_id', 'case_relate_client_id'],  block: [], insert: true },
  contact_phones:    { where: ['id', 'contact_id', 'phone'],                                       block: [], insert: true },
  contact_emails:    { where: ['id', 'contact_id', 'email'],                                       block: [], insert: true },
  contact_addresses: { where: ['id', 'contact_id'],                                                block: [], insert: true },
  judges:            { where: ['judge_id', 'judge_name'],                                          block: [], insert: true },
  trustees:          { where: ['trustee_id', 'trustee_full_name'],                                 block: [], insert: true },
};

// Narrower than QUERY_DB_WHERE_OPS on purpose: LIKE / NOT LIKE are the
// accidentally-match-everything operators and have no business in the WHERE of an
// UPDATE. If you genuinely need one, that is a DB-console job.
const WRITE_WHERE_OPS = new Set(['=', '!=', '<>', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL']);

const WRITE_MAX_ROWS_CEILING = 500;

function _wdbValidateTable(table, fnName) {
  if (typeof table !== 'string' || !table.trim()) {
    throw new Error(`${fnName}: "table" is required`);
  }
  const t = table.trim();
  if (!/^\w+$/.test(t)) throw new Error(`${fnName}: invalid table "${table}"`);
  const policy = WRITE_POLICY[t];
  if (!policy) {
    throw new Error(
      `${fnName}: table "${t}" is not writable. Writable tables: ` +
      `${Object.keys(WRITE_POLICY).sort().join(', ')}`
    );
  }
  return { table: t, policy };
}

// ── Schema cache ─────────────────────────────────────────────
// One information_schema round-trip per writable table per process. A schema
// change needs a redeploy to take effect — same lifetime contract as
// phoneIngestService's firm-number cache, and for the same reason: it changes
// approximately never, and staleness can only make us MORE restrictive (an
// unknown column is rejected, never silently written).
let _schemaCache = new Map();   // table -> { all:Set, settable:Set }

async function _getWritableSchema(conn, table) {
  if (_schemaCache.has(table)) return _schemaCache.get(table);

  const [rows] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_KEY, EXTRA, COLUMN_DEFAULT, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  if (!rows.length) {
    throw new Error(`update_db: table "${table}" has no columns in information_schema`);
  }

  const all      = new Set();
  const settable = new Set();
  for (const r of rows) {
    const col     = r.COLUMN_NAME;
    const extra   = String(r.EXTRA || '').toLowerCase();
    const genExpr = String(r.GENERATION_EXPRESSION || '').trim();
    const dflt    = String(r.COLUMN_DEFAULT || '').toLowerCase();
    all.add(col);

    if (r.COLUMN_KEY === 'PRI') continue;              // primary key
    if (extra.includes('auto_increment')) continue;    // surrogate id

    // Generated columns. GENERATION_EXPRESSION is the PORTABLE test and the one
    // that matters most: SETting a VIRTUAL/STORED column makes the engine throw
    // (contact_phones.phone_active_uniq, contact_emails.email_active_uniq, the
    // three is_primary_uniq columns, appts.appt_end, form_submissions.draft_key).
    // The EXTRA sniff is a secondary net.
    if (genExpr) continue;
    if (extra.includes('generated')) continue;

    // Timestamp columns the engine maintains. MySQL 8 tags these
    // "DEFAULT_GENERATED [on update CURRENT_TIMESTAMP]" — caught above. MariaDB
    // 10.x tags them only "on update current_timestamp()" and tags a plain
    // DEFAULT CURRENT_TIMESTAMP not at all, so match the default expression too.
    // Prod is MySQL 8; this keeps the derivation engine-independent regardless.
    if (extra.includes('on update')) continue;
    if (dflt.startsWith('current_timestamp') || dflt.startsWith('now(')) continue;

    settable.add(col);
  }

  const entry = { all, settable };
  _schemaCache.set(table, entry);
  return entry;
}

function resetWriteSchemaCache() { _schemaCache = new Map(); }

/**
 * Normalize the two accepted `set` shapes into a plain object.
 *
 *   rich:  set = { col: val, ... }
 *   flat:  set_column = 'value', set_value = <scalar>
 *
 * The flat shape exists because lib/actionDispatchers.resolveParamsMapping —
 * the mapper used by INGEST-RULE ACTIONS and HOOK TARGETS — does NOT recurse
 * into nested objects. A nested { set: { value: "{{code}}" } } passes through
 * VERBATIM and would write the literal string "{{code}}". Only the workflow
 * engine's resolvePlaceholders recurses (workflow_engine.js:37,43).
 *
 * From an ingest rule, therefore, use either the flat shape:
 *   params_mapping: { table: "'app_settings'",
 *                     set_column: "'value'",  set_value: "clio_code",
 *                     where_column: "'key'",  where_value: "'clio_login_code'" }
 * or a dot-path to an object your `code` transform already built:
 *   params_mapping: { table: "'checkitems'", set: "my_set_obj", where: "my_where_arr" }
 */
function _wdbNormalizeSet(params, fnName) {
  const hasFlat = params.set_column !== undefined;
  const hasRich = params.set !== undefined;

  if (hasFlat && hasRich) {
    throw new Error(`${fnName}: pass either "set" or "set_column"/"set_value", not both`);
  }
  if (hasFlat) {
    if (typeof params.set_column !== 'string' || !params.set_column.trim()) {
      throw new Error(`${fnName}: set_column must be a non-empty string`);
    }
    if (params.set_value === undefined) {
      throw new Error(`${fnName}: set_value is required with set_column (use null for SQL NULL)`);
    }
    return { [params.set_column.trim()]: params.set_value };
  }
  if (!hasRich || params.set === null || typeof params.set !== 'object' || Array.isArray(params.set)) {
    throw new Error(`${fnName}: "set" must be a non-empty object (or use set_column/set_value)`);
  }
  if (!Object.keys(params.set).length) {
    throw new Error(`${fnName}: "set" must be a non-empty object`);
  }
  return params.set;
}

/**
 * Normalize the two accepted `where` shapes into query_db's clause array.
 *   rich:  where = [{ column, op?, value }]
 *   flat:  where_column = 'key', where_value = 'clio_login_code'   (op is always '=')
 */
function _wdbNormalizeWhere(params, fnName) {
  const hasFlat = params.where_column !== undefined;
  const hasRich = params.where !== undefined;

  if (hasFlat && hasRich) {
    throw new Error(`${fnName}: pass either "where" or "where_column"/"where_value", not both`);
  }
  if (hasFlat) {
    if (typeof params.where_column !== 'string' || !params.where_column.trim()) {
      throw new Error(`${fnName}: where_column must be a non-empty string`);
    }
    if (params.where_value === undefined) {
      throw new Error(`${fnName}: where_value is required with where_column`);
    }
    return [{ column: params.where_column.trim(), op: '=', value: params.where_value }];
  }
  if (!hasRich || !Array.isArray(params.where) || !params.where.length) {
    throw new Error(
      `${fnName}: a non-empty "where" is REQUIRED (or use where_column/where_value). ` +
      `Unbounded UPDATEs are never permitted.`
    );
  }
  return params.where;
}

/**
 * Compile a validated WHERE clause array into { sql, params }.
 * Columns must appear in policy.where — the single most important guard here.
 * AND only: OR across identity columns in an UPDATE is a mistake far more often
 * than it is an intent, and the DB console exists for the exception.
 */
function _wdbBuildWhere(clauses, table, policy, fnName) {
  const allowed = new Set(policy.where);
  const parts   = [];
  const values  = [];

  for (const c of clauses) {
    if (!c || typeof c !== 'object') throw new Error(`${fnName}: each where clause must be an object`);
    if (!c.column) throw new Error(`${fnName}: each where clause needs a column`);

    const col = String(c.column).trim();
    if (!/^\w+$/.test(col)) throw new Error(`${fnName}: invalid where column "${c.column}"`);
    if (!allowed.has(col)) {
      throw new Error(
        `${fnName}: "${col}" may not be used in a WHERE on ${table}. Allowed: ${policy.where.join(', ')}`
      );
    }

    const op = String(c.op || '=').toUpperCase();
    if (!WRITE_WHERE_OPS.has(op)) {
      throw new Error(`${fnName}: operator "${c.op}" is not permitted on writes (LIKE is deliberately excluded)`);
    }

    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      parts.push(`\`${col}\` ${op}`);
    } else if (op === 'IN' || op === 'NOT IN') {
      if (!Array.isArray(c.value) || !c.value.length) {
        throw new Error(`${fnName}: IN/NOT IN requires a non-empty array value`);
      }
      parts.push(`\`${col}\` ${op} (${c.value.map(() => '?').join(', ')})`);
      values.push(...c.value);
    } else {
      if (c.value === undefined) throw new Error(`${fnName}: where clause on "${col}" has no value`);
      parts.push(`\`${col}\` ${op} ?`);
      values.push(c.value);
    }
  }

  return { sql: parts.join(' AND '), params: values };
}

/** Validate SET / VALUES columns against the derived settable set + policy.block. */
function _wdbValidateSet(setObj, table, policy, schema, fnName) {
  const blocked = new Set(policy.block || []);
  const cols    = Object.keys(setObj);

  for (const col of cols) {
    if (!/^\w+$/.test(col)) throw new Error(`${fnName}: invalid column name "${col}"`);
    if (!schema.all.has(col)) {
      throw new Error(`${fnName}: ${table} has no column "${col}"`);
    }
    if (blocked.has(col)) {
      throw new Error(`${fnName}: ${table}.${col} is blocked from writes by policy`);
    }
    if (!schema.settable.has(col)) {
      throw new Error(
        `${fnName}: ${table}.${col} is not settable (primary key, auto_increment, ` +
        `or a generated/timestamp column)`
      );
    }
    const v = setObj[col];
    if (v === undefined) {
      throw new Error(`${fnName}: ${table}.${col} — value is undefined (use null for SQL NULL)`);
    }
    if (v !== null && typeof v === 'object') {
      throw new Error(
        `${fnName}: ${table}.${col} — value must be a scalar or null. Got ` +
        `${Array.isArray(v) ? 'array' : 'object'}; JSON.stringify structured values first.`
      );
    }
  }
  return cols;
}


// ─────────────────────────────────────────────────────────────
// update_db
// ─────────────────────────────────────────────────────────────

/**
 * update_db
 * Parameterized UPDATE built from a JSON descriptor. No raw SQL.
 *
 * params — RICH form (placeholders resolve at any depth in WORKFLOW steps):
 *   table      {string}    must be in WRITE_POLICY
 *   set        {object}    { column: value, ... }
 *   where      {object[]}  [{ column, op?, value }] — REQUIRED, non-empty.
 *                          Columns restricted to policy.where. No LIKE.
 *   max_rows   {integer}   default 1. REFUSED if the where clause would touch
 *                          more rows than this. Raise it deliberately.
 *   output_var {string}    store affected_rows in this workflow variable
 *
 * params — FLAT form (for INGEST-RULE ACTIONS and HOOK TARGETS, whose
 *          params_mapping does NOT recurse into nested objects):
 *   table, set_column, set_value, where_column, where_value, max_rows?, output_var?
 *
 * SAFETY
 *   - table whitelist (WRITE_POLICY)
 *   - SET columns derived from information_schema: never a PK, auto_increment,
 *     or GENERATED column (which also excludes every created_at / updated_at)
 *   - WHERE is mandatory, non-empty, and restricted to policy.where
 *   - LIKE / NOT LIKE excluded from the write operator set
 *   - row cap: COUNT(*) first, refuse if > max_rows, then UPDATE ... LIMIT
 *     max_rows as a hard backstop. Count + guard + update run in ONE transaction.
 *   - optional per-table row guard (app_settings refuses is_secret rows)
 *   - every value fully parameterized
 *
 * Example — mark a checklist item done, from a workflow step (rich form):
 *   { "function_name": "update_db", "params": {
 *       "table": "checkitems",
 *       "set":   { "status": "complete" },
 *       "where": [{ "column": "id", "op": "=", "value": "{{itemId}}" }]
 *   }}
 *
 * Example — the Clio code, from a phone-ingest rule action (flat form):
 *   params_mapping: {
 *     "table": "'app_settings'",
 *     "set_column": "'value'",   "set_value": "clio_code",
 *     "where_column": "'key'",   "where_value": "'clio_login_code'"
 *   }
 *   (set_setting remains the nicer front door for that one — two params, not five.)
 */
fns.update_db = async (params, db) => {
    const p = params || {};
    const { table, policy } = _wdbValidateTable(p.table, 'update_db');

    const setObj   = _wdbNormalizeSet(p, 'update_db');
    const whereObj = _wdbNormalizeWhere(p, 'update_db');

    const maxRows = (p.max_rows === undefined || p.max_rows === null || p.max_rows === '')
      ? 1
      : Number(p.max_rows);
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > WRITE_MAX_ROWS_CEILING) {
      throw new Error(`update_db: max_rows must be an integer 1..${WRITE_MAX_ROWS_CEILING} (got ${p.max_rows})`);
    }

    const where = _wdbBuildWhere(whereObj, table, policy, 'update_db');

    // db.withTransaction is bound onto the promise pool in startup/db.js — the
    // same convention apptService / campaignService / contactAddressService use.
    // Count + guard + UPDATE must be atomic, or the row cap is advisory only.
    const affected = await db.withTransaction(async (conn) => {
      const schema  = await _getWritableSchema(conn, table);
      const setCols = _wdbValidateSet(setObj, table, policy, schema, 'update_db');

      // ── row cap, checked BEFORE anything is touched ──
      const [[cnt]] = await conn.query(
        `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where.sql}`,
        where.params
      );
      const n = Number(cnt.n);
      if (n === 0) {
        throw new Error(`update_db: no ${table} row matches the where clause`);
      }
      if (n > maxRows) {
        throw new Error(
          `update_db: refused — the where clause matches ${n} ${table} rows but max_rows is ${maxRows}. ` +
          `Tighten the where clause, or raise max_rows deliberately.`
        );
      }

      // ── per-table row guard (e.g. app_settings is_secret) ──
      if (typeof policy.guard === 'function') {
        await policy.guard(conn, table, where.sql, where.params);
      }

      // LIMIT is a hard backstop behind the COUNT — belt and suspenders.
      const setSql = setCols.map(c => `\`${c}\` = ?`).join(', ');
      const sql    = `UPDATE \`${table}\` SET ${setSql} WHERE ${where.sql} LIMIT ${maxRows}`;
      const vals   = [...setCols.map(c => setObj[c]), ...where.params];

      // Column names only — values may be secrets, 2FA codes, or PII.
      console.log(`[UPDATE_DB] ${table} SET ${setCols.join(', ')} (matched ${n}, limit ${maxRows})`);

      const [r] = await conn.query(sql, vals);
      // The pool connects with FOUND_ROWS semantics (mysql2 default), so
      // affectedRows is the MATCHED count, not the CHANGED count. Both are
      // surfaced: affected_rows answers "did the row exist", changed_rows
      // answers "did anything actually differ" — the more useful one to branch on.
      return { affected: r.affectedRows, changed: r.changedRows };
    });

    const set_vars = {};
    if (p.output_var) set_vars[p.output_var] = affected.affected;

    return {
      success: true,
      output: {
        table,
        affected_rows: affected.affected,   // matched
        changed_rows:  affected.changed,    // actually different
        columns:       Object.keys(setObj),
      },
      set_vars,
    };
  };

fns.update_db.__meta = {
  category: 'general',
  description:
    'Parameterized UPDATE from a JSON descriptor — no raw SQL. Whitelisted tables only ' +
    '(app_settings, rw_scratch, tasks, checkitems, checklists, case_relate, contact_phones, ' +
    'contact_emails, contact_addresses, judges, trustees). WHERE is mandatory, restricted to ' +
    'identity columns, and LIKE is excluded. max_rows defaults to 1 — the UPDATE is REFUSED if ' +
    'the where clause matches more rows than that. PK / auto_increment / generated / created_at / ' +
    'updated_at columns are never settable. From ingest-rule actions and hook targets use the flat ' +
    'set_column/set_value + where_column/where_value form — their params_mapping does not recurse ' +
    'into nested objects.',
  params: [
    { name: 'table', type: 'string', required: true, placeholderAllowed: true, strictString: true,
      description: 'Writable table (see description). _wdbValidateTable rejects a non-string identifier.', example: 'checkitems' },
    { name: 'set', type: 'object', required: false,
      description: 'Rich form: { column: value, ... }. Workflow/scheduled-job steps only — ' +
                   'placeholders resolve at any depth there. Mutually exclusive with set_column.' },
    { name: 'where', type: 'array', required: false,
      description: 'Rich form: [{ column, op?, value }]. Columns limited to the table policy. ' +
                   'Mutually exclusive with where_column.' },
    { name: 'set_column', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description: 'Flat form: the single column to set. Use from ingest actions / hook targets.',
      example: 'status' },
    { name: 'set_value', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'Flat form: the value for set_column. Scalar or null.' },
    { name: 'where_column', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description: 'Flat form: identity column to match (op is always "=").', example: 'id' },
    { name: 'where_value', type: 'string', required: false, placeholderAllowed: true,
      description: 'Flat form: the value for where_column.' },
    { name: 'max_rows', type: 'integer', required: false, default: 1, min: 1, max: 500,
      description: 'Refuse the UPDATE if the where clause matches more rows than this.' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Store affected_rows in this workflow variable.' },
  ],
  // output: { table, affected_rows (MATCHED — the pool uses FOUND_ROWS semantics),
  //           changed_rows (actually different), columns }
  example: {
    table: 'checkitems',
    set:   { status: 'complete' },
    where: [{ column: 'id', op: '=', value: '{{itemId}}' }],
  },
};


// ─────────────────────────────────────────────────────────────
// insert_db
// ─────────────────────────────────────────────────────────────

/**
 * insert_db
 * Parameterized single-row INSERT from a JSON descriptor. No raw SQL.
 *
 * Only tables whose policy sets insert:true. app_settings and tasks are
 * deliberately insert:false — new settings keys are created in the DB console
 * (same rule as routes/api.appSettings.js), and create_task owns task creation
 * because it also mints task_action_token and the due-date scheduled job.
 *
 * params:
 *   table      {string}  must be in WRITE_POLICY with insert:true
 *   values     {object}  { column: value, ... }
 *   output_var {string}  store the new insertId in this workflow variable
 *
 * No ON DUPLICATE KEY handling in v1 — a duplicate-key collision throws, which is
 * the honest outcome. Add an explicit on_duplicate mode if a real case appears.
 *
 * NOTE (same nested-object caveat as update_db): `values` is an object, so from an
 * ingest-rule action it must arrive either as a literal object in the action config
 * or via a dot-path to an object your `code` transform built. params_mapping does
 * not template into nested objects.
 */
fns.insert_db = async (params, db) => {
    const p = params || {};
    const { table, policy } = _wdbValidateTable(p.table, 'insert_db');

    if (!policy.insert) {
      throw new Error(
        `insert_db: ${table} is update-only by policy` +
        (table === 'app_settings' ? ' — create new settings keys in the DB console' : '') +
        (table === 'tasks'        ? ' — use create_task, which also mints the action token and the due job' : '')
      );
    }

    const values = p.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
      throw new Error('insert_db: "values" must be a non-empty object');
    }

    const insertId = await db.withTransaction(async (conn) => {
      const schema = await _getWritableSchema(conn, table);
      const cols   = _wdbValidateSet(values, table, policy, schema, 'insert_db');

      const sql = `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(', ')}) ` +
                  `VALUES (${cols.map(() => '?').join(', ')})`;

      // Column names only — values may be PII.
      console.log(`[INSERT_DB] ${table} (${cols.join(', ')})`);

      const [r] = await conn.query(sql, cols.map(c => values[c]));
      return r.insertId;
    });

    const set_vars = {};
    if (p.output_var) set_vars[p.output_var] = insertId;

    return {
      success: true,
      output: { table, insert_id: insertId, columns: Object.keys(values) },
      set_vars,
    };
  };

fns.insert_db.__meta = {
  category: 'general',
  description:
    'Parameterized single-row INSERT from a JSON descriptor — no raw SQL. Whitelisted tables with ' +
    'insert:true only (rw_scratch, checkitems, checklists, case_relate, contact_phones, ' +
    'contact_emails, contact_addresses, judges, trustees). app_settings is update-only (create keys ' +
    'in the DB console); tasks is update-only (use create_task). PK / auto_increment / generated / ' +
    'timestamp columns are never settable. Duplicate-key collisions throw.',
  params: [
    { name: 'table', type: 'string', required: true, placeholderAllowed: true, strictString: true,
      description: 'Writable table with insert:true (see description). _wdbValidateTable rejects a non-string identifier.', example: 'checkitems' },
    { name: 'values', type: 'object', required: true,
      description: '{ column: value, ... }. Scalars or null only — JSON.stringify structured values.' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Store the new row id in this workflow variable.' },
  ],
  example: {
    table:  'checkitems',
    values: { checklist_id: '{{listId}}', name: 'Send 341 reminder', status: 'incomplete' },
    output_var: 'newItemId',
  },
};


// Test / ops handles. index.js sweeps module exports into the registry, but both
// internalFunctionNames() and __getAllMeta() filter on `!k.startsWith('__')` and
// `typeof === 'function'`, so neither of these pollutes the UI function pickers.
fns.__resetWriteSchemaCache = resetWriteSchemaCache;
fns.__WRITE_POLICY = WRITE_POLICY;

module.exports = fns;