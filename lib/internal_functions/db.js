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
    { name: 'from', type: 'string', required: true,
      description: 'Primary table (whitelisted).', example: 'cases' },
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

module.exports = fns;
