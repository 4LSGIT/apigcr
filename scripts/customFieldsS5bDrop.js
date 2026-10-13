#!/usr/bin/env node
// scripts/customFieldsS5bDrop.js
//
/**
 * Custom Fields S5-B — drop the three retired Clio columns.
 *
 *   contacts.contact_clio_id   (values live in the custom field cf_clio_id since S5-A)
 *   cases.clio_matter          (values live in cf_clio_matter since S5-A)
 *   cases.case_clio_id         (dead: 0 rows ever filled — dropped, nothing moved)
 *
 * ref/CUSTOM_FIELDS_DESIGN.md §7 S5-B; the applied SQL is recorded in
 * ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production —
 * the same setup `npm run db:ref` uses; the Cloud SQL proxy is started if
 * .env opts in):
 *
 *   node scripts/customFieldsS5bDrop.js           # CHECK — read-only, prints the plan
 *   node scripts/customFieldsS5bDrop.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and does only what is left.
 *
 * ── THE LANDMINE (found in the S5-A census, proved on 8.4.11) ─────────────
 * The `after_contact_update` trigger names `contact_clio_id` (OLD. and NEW.).
 * Drop the column with the trigger untouched and the DROP SUCCEEDS — then
 * EVERY contact UPDATE fails with `ERROR 1054 Unknown column 'contact_clio_id'
 * in 'OLD'`, including a no-op one. (A zero-row UPDATE does NOT fail, so it
 * proves nothing.) So the trigger is rebuilt FIRST, without that one IF
 * block, and the column drop only ever runs after the rebuilt body is
 * verified byte for byte.
 *
 * ── WHY A NODE SCRIPT ON ONE CONNECTION (not the SU console) ──────────────
 * /admin/db/batch runs each statement on whichever pooled connection is free,
 * so a SESSION setting cannot reach the statement it is meant for. This needs
 * four:
 *   - lock_wait_timeout = 5. Every ALTER and LOCK TABLES takes an exclusive
 *     metadata lock; one queued behind a long transaction blocks EVERY new
 *     query on the table for as long as it waits, and the global default is
 *     a year (the fieldDefReconciler rule — services/fieldDefReconciler.js).
 *   - sql_mode = the OLD trigger's own. A trigger is stamped with the session
 *     sql_mode it was created under; the rebuild keeps the old stamp.
 *   - LOCK TABLES contacts WRITE around DROP + CREATE TRIGGER, so no contact
 *     UPDATE can land in the gap between them and go unlogged. Measured on
 *     8.4.11: a concurrent UPDATE waits for the lock, then runs and logs
 *     through the NEW trigger.
 *   - the smoke tests run in a TRANSACTION and are ROLLED BACK: a real
 *     contact UPDATE that must fire the rebuilt trigger and write its log
 *     row, and a real case UPDATE — then nothing of either persists.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - the live trigger body is EXACTLY the expected old one (CRLF-normalized)
 *     or EXACTLY the rebuilt one — anything else and the body here is stale;
 *   - the connecting user IS the trigger's DEFINER, so the rebuild cannot
 *     re-own it;
 *   - both pilot field defs are active and both VIRTUAL cf_ columns exist;
 *   - no Clio value would be lost: no row has a legacy value and an empty
 *     cf_ field; case_clio_id is still empty everywhere;
 *   - nothing ELSE in the schema names the three columns: no other trigger,
 *     view, generated column, routine or event.
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 *   the three columns are gone; the trigger is the rebuilt body with the old
 *   DEFINER and sql_mode; the schema-wide reference sweep is clean; the cf_
 *   values are identical (count + checksum, before vs after); both smoke
 *   UPDATEs work. Then — and only then — deploy: `git go`.
 *
 * ── ROLLBACK (not expected; the values live in the cf_ fields) ────────────
 *   see the ROLLBACK section of the migration file.
 */

'use strict';

const TRIGGER = 'after_contact_update';

// The rebuilt body: the live one minus the `contact_clio_id` IF block —
// nothing else, every other byte (CRLF line ends aside) as it was.
const NEW_BODY = `BEGIN
    DECLARE log_data TEXT;
    SET log_data = JSON_OBJECT();
    SET log_data = JSON_OBJECT(
        'contact_id', NEW.contact_id
    );
    -- Compare each column and add changed fields to log_data
    IF OLD.contact_type != NEW.contact_type THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_type', OLD.contact_type,
            '$.new_contact_type', NEW.contact_type);
    END IF;

    IF OLD.contact_name != NEW.contact_name THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_name', OLD.contact_name,
            '$.new_contact_name', NEW.contact_name);
    END IF;


    IF OLD.contact_pname != NEW.contact_pname THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_pref_name', OLD.contact_pname,
            '$.new_contact_pref_name', NEW.contact_pname);
    END IF;

    IF OLD.contact_phone != NEW.contact_phone THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone', OLD.contact_phone,
            '$.new_contact_phone', NEW.contact_phone);
    END IF;

    IF OLD.contact_email != NEW.contact_email THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email', OLD.contact_email,
            '$.new_contact_email', NEW.contact_email);
    END IF;

    IF OLD.contact_address != NEW.contact_address THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_address', OLD.contact_address,
            '$.new_contact_address', NEW.contact_address);
    END IF;

    IF OLD.contact_city != NEW.contact_city THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_city', OLD.contact_city,
            '$.new_contact_city', NEW.contact_city);
    END IF;

    IF OLD.contact_state != NEW.contact_state THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_state', OLD.contact_state,
            '$.new_contact_state', NEW.contact_state);
    END IF;

    IF OLD.contact_zip != NEW.contact_zip THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_zip', OLD.contact_zip,
            '$.new_contact_zip', NEW.contact_zip);
    END IF;

    IF OLD.contact_dob != NEW.contact_dob THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_dob', OLD.contact_dob,
            '$.new_contact_dob', NEW.contact_dob);
    END IF;

    IF OLD.contact_ssn != NEW.contact_ssn THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_ssn', OLD.contact_ssn,
            '$.new_contact_ssn', NEW.contact_ssn);
    END IF;

    IF OLD.contact_marital_status != NEW.contact_marital_status THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_marital_status', OLD.contact_marital_status,
            '$.new_contact_marital_status', NEW.contact_marital_status);
    END IF;

    IF OLD.contact_tags != NEW.contact_tags THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_tags', OLD.contact_tags,
            '$.new_contact_tags', NEW.contact_tags);
    END IF;

    IF OLD.contact_notes != NEW.contact_notes THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_notes', OLD.contact_notes,
            '$.new_contact_notes', NEW.contact_notes);
    END IF;

    IF OLD.contact_phone2 != NEW.contact_phone2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_phone2', OLD.contact_phone2,
            '$.new_contact_phone2', NEW.contact_phone2);
    END IF;

    IF OLD.contact_email2 != NEW.contact_email2 THEN
        SET log_data = JSON_SET(log_data,
            '$.previous_contact_email2', OLD.contact_email2,
            '$.new_contact_email2', NEW.contact_email2);
    END IF;

    -- Insert log entry if any changes were made
    IF JSON_LENGTH(log_data) > 1 THEN
        INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
        VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), NEW.contact_id, 1, log_data);
    END IF;
END`;

const CLIO_BLOCK =
  '    IF OLD.contact_clio_id != NEW.contact_clio_id THEN\n' +
  '        SET log_data = JSON_SET(log_data,\n' +
  "            '$.previous_contact_clio_id', OLD.contact_clio_id,\n" +
  "            '$.new_contact_clio_id', NEW.contact_clio_id);\n" +
  '    END IF;\n' +
  '\n';
const ANCHOR = '    IF OLD.contact_phone2 != NEW.contact_phone2 THEN';
if (NEW_BODY.split(ANCHOR).length !== 2) throw new Error('S5-B: NEW_BODY anchor is not unique');
const OLD_BODY = NEW_BODY.replace(ANCHOR, CLIO_BLOCK + ANCHOR);

const LEGACY = [
  { table: 'contacts', column: 'contact_clio_id', cf: 'cf_clio_id',     pk: 'contact_id' },
  { table: 'cases',    column: 'clio_matter',     cf: 'cf_clio_matter', pk: 'case_id' },
  { table: 'cases',    column: 'case_clio_id',    cf: null,             pk: 'case_id' },
];
const PILOT = [
  { entity: 'contact', field_key: 'cf_clio_id',     table: 'contacts', pk: 'contact_id' },
  { entity: 'case',    field_key: 'cf_clio_matter', table: 'cases',    pk: 'case_id' },
];
const NAMES_RE = /(^|[^A-Za-z0-9_])(clio_matter|case_clio_id|contact_clio_id)([^A-Za-z0-9_]|$)/i;

const SQL = {
  lockWait:      'SET SESSION lock_wait_timeout = 5',
  lock:          'LOCK TABLES `contacts` WRITE',
  unlock:        'UNLOCK TABLES',
  dropTrigger:   'DROP TRIGGER `' + TRIGGER + '`',
  createTrigger: body => 'CREATE TRIGGER `' + TRIGGER + '` AFTER UPDATE ON `contacts` FOR EACH ROW ' + body,
  dropContacts:  'ALTER TABLE `contacts` DROP COLUMN `contact_clio_id`, ALGORITHM=COPY',
  dropCases:     cols => 'ALTER TABLE `cases` ' + cols.map(c => 'DROP COLUMN `' + c + '`').join(', '),
};

const QUERY_TIMEOUT_MS = 60_000;
const DDL_TIMEOUT_MS   = 180_000;

const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n');
const hasStrict = mode => /STRICT_(TRANS|ALL)_TABLES/i.test(String(mode || ''));

/** One timed query; returns rows. */
async function q(conn, sql, params = [], timeout = QUERY_TIMEOUT_MS) {
  const [rows] = await conn.query({ sql, timeout }, params);
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Reading the live state
// ─────────────────────────────────────────────────────────────

async function readState(conn) {
  const [who] = await q(conn,
    '/* s5b:who */ SELECT CURRENT_USER() AS cu, @@SESSION.sql_mode AS sm, DATABASE() AS db, VERSION() AS v');

  const triggers = await q(conn,
    '/* s5b:triggers */ SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, ' +
    'EVENT_MANIPULATION AS event, ACTION_STATEMENT AS body, DEFINER AS definer, SQL_MODE AS sql_mode ' +
    'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY TRIGGER_NAME');

  const cols = await q(conn,
    "/* s5b:columns */ SELECT TABLE_NAME AS t, COLUMN_NAME AS c, GENERATION_EXPRESSION AS g " +
    "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('cases','contacts') " +
    "AND COLUMN_NAME IN ('contact_clio_id','clio_matter','case_clio_id','cf_clio_id','cf_clio_matter')");
  const has = (t, c) => cols.some(r => r.t === t && r.c.toLowerCase() === c);

  const defs = await q(conn,
    "/* s5b:defs */ SELECT id, entity, field_key, field_type, active FROM field_defs " +
    "WHERE field_key IN ('cf_clio_id','cf_clio_matter')");

  // Everything else in the schema that could name a column. Matched here in
  // JS, not with REGEXP in SQL: information_schema text columns carry their
  // own collations and a REGEXP across them is a collation-mix error waiting.
  const views    = await q(conn, '/* s5b:views */ SELECT TABLE_NAME AS name, VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE()');
  const gens     = await q(conn, "/* s5b:generated */ SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME) AS name, GENERATION_EXPRESSION AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> ''");
  const routines = await q(conn, '/* s5b:routines */ SELECT ROUTINE_NAME AS name, ROUTINE_DEFINITION AS def FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()');
  const events   = await q(conn, '/* s5b:events */ SELECT EVENT_NAME AS name, EVENT_DEFINITION AS def FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()');

  const refs = [];
  for (const t of triggers) if (NAMES_RE.test(norm(t.body))) refs.push({ kind: 'trigger', name: t.name });
  for (const v of views)    if (NAMES_RE.test(norm(v.def)))  refs.push({ kind: 'view', name: v.name });
  for (const g of gens)     if (NAMES_RE.test(norm(g.def)))  refs.push({ kind: 'generated column', name: g.name });
  for (const r of routines) if (NAMES_RE.test(norm(r.def)))  refs.push({ kind: 'routine', name: r.name });
  for (const e of events)   if (NAMES_RE.test(norm(e.def)))  refs.push({ kind: 'event', name: e.name });

  const trig = triggers.find(t => t.name === TRIGGER) || null;
  let triggerState = 'absent';
  if (trig) {
    const b = norm(trig.body);
    triggerState = b === OLD_BODY ? 'old' : b === NEW_BODY ? 'new' : 'other';
  }

  const legacy = {};
  for (const L of LEGACY) {
    const present = has(L.table, L.column);
    const row = { present };
    if (present && L.cf) {
      const [r] = await q(conn,
        `/* s5b:loss:${L.column} */ SELECT ` +
        `COALESCE(SUM(\`${L.column}\` <> ''), 0) AS legacy, ` +
        `COALESCE(SUM(\`${L.column}\` <> '' AND \`${L.cf}\` IS NULL), 0) AS lost, ` +
        `COALESCE(SUM(\`${L.column}\` <> '' AND \`${L.cf}\` IS NOT NULL AND CAST(\`${L.cf}\` AS BINARY) <> CAST(\`${L.column}\` AS BINARY)), 0) AS edited, ` +
        `COALESCE(SUM(\`${L.cf}\` IS NOT NULL AND \`${L.column}\` = ''), 0) AS cf_only ` +
        `FROM \`${L.table}\``);
      Object.assign(row, { legacy: +r.legacy, lost: +r.lost, edited: +r.edited, cf_only: +r.cf_only });
    } else if (present) {
      const [r] = await q(conn,
        `/* s5b:filled:${L.column} */ SELECT COALESCE(SUM(\`${L.column}\` <> ''), 0) AS filled FROM \`${L.table}\``);
      row.filled = +r.filled;
    }
    legacy[L.column] = row;
  }

  const fingerprint = {};
  for (const P of PILOT) {
    if (!has(P.table, P.field_key)) { fingerprint[P.field_key] = null; continue; }
    const [r] = await q(conn,
      `/* s5b:fingerprint:${P.field_key} */ SELECT COUNT(\`${P.field_key}\`) AS n, ` +
      `COALESCE(BIT_XOR(CRC32(CONCAT(\`${P.pk}\`, ':', \`${P.field_key}\`))), 0) AS x FROM \`${P.table}\``);
    fingerprint[P.field_key] = { n: +r.n, x: String(r.x) };
  }

  return {
    user: who.cu, sessionMode: who.sm, db: who.db, version: who.v,
    triggerCount: triggers.length,
    trigger: trig ? { state: triggerState, definer: trig.definer, sqlMode: trig.sql_mode,
                      timing: trig.timing, event: trig.event, tbl: trig.tbl, body: norm(trig.body) }
                  : { state: 'absent' },
    virtual: { cf_clio_id: has('contacts', 'cf_clio_id'), cf_clio_matter: has('cases', 'cf_clio_matter') },
    defs, legacy, refs, fingerprint,
  };
}

// ─────────────────────────────────────────────────────────────
// Deciding — pure, so the tests can drive every branch
// ─────────────────────────────────────────────────────────────

/**
 * @returns {{ problems: string[], notes: string[], steps: string[], done: boolean }}
 *   steps ⊆ ['rebuild' | 'create', 'dropContacts', 'dropCases'], in that order.
 */
function plan(s) {
  const problems = [];
  const notes = [];
  const steps = [];
  const t = s.trigger;

  // The trigger.
  if (t.state === 'other') {
    problems.push(`${TRIGGER}'s live body is neither the expected old body nor the rebuilt one — ` +
      'someone changed it since 2026-10-13; re-derive NEW_BODY from the live trigger before going on');
  }
  if (t.state !== 'absent') {
    if (t.tbl !== 'contacts' || t.timing !== 'AFTER' || t.event !== 'UPDATE') {
      problems.push(`${TRIGGER} is ${t.timing} ${t.event} ON ${t.tbl}, expected AFTER UPDATE ON contacts`);
    }
    if (t.definer !== s.user) {
      problems.push(`you are connected as ${s.user} but ${TRIGGER} belongs to ${t.definer} — ` +
        `a rebuild would re-own it. Run as ${t.definer} (the .env user the app itself uses)`);
    }
  } else {
    notes.push(`${TRIGGER} is MISSING — contact edits are not being logged. It will be created ` +
      `(definer ${s.user}, sql_mode of this session)`);
    if (hasStrict(s.sessionMode)) problems.push(`this session's sql_mode is STRICT (${s.sessionMode}); the recreated trigger would inherit it`);
  }
  if (t.state === 'old') steps.push('rebuild');
  else if (t.state === 'absent') steps.push('create');

  // The registry the values now live in.
  for (const P of PILOT) {
    const d = (s.defs || []).find(x => x.field_key === P.field_key && x.entity === P.entity);
    if (!d) problems.push(`field def ${P.entity}/${P.field_key} is missing`);
    else if (Number(d.active) !== 1) problems.push(`field def ${P.entity}/${P.field_key} is not active`);
    if (!s.virtual[P.field_key]) problems.push(`the virtual column ${P.table}.${P.field_key} does not exist`);
  }

  // Nothing may be lost.
  for (const L of LEGACY) {
    const r = s.legacy[L.column];
    if (!r || !r.present) continue;
    if (L.cf) {
      if (r.lost > 0) {
        problems.push(`${r.lost} row(s) of ${L.table}.${L.column} hold a value that ${L.cf} does not — ` +
          'dropping now would lose them; re-run the S5-A backfill for those rows first');
      }
      if (r.edited > 0) notes.push(`${r.edited} row(s) had ${L.cf} edited since the freeze (the cf_ value is the live one — fine)`);
      if (r.cf_only > 0) notes.push(`${r.cf_only} row(s) got a ${L.cf} value after the migration (fine)`);
    } else if (r.filled > 0) {
      problems.push(`${L.table}.${L.column} is no longer empty (${r.filled} row(s)) — something started writing it; find out what`);
    }
  }

  // Nothing else may name the columns. While the trigger is still the OLD
  // body it is the one expected reference; after the rebuild, none is.
  const allowed = t.state === 'old' ? [`trigger:${TRIGGER}`] : [];
  for (const r of s.refs) {
    if (!allowed.includes(`${r.kind}:${r.name}`)) {
      problems.push(`${r.kind} ${r.name} names a column being dropped — it would break on the drop`);
    }
  }

  if (s.legacy.contact_clio_id && s.legacy.contact_clio_id.present) steps.push('dropContacts');
  if ((s.legacy.clio_matter && s.legacy.clio_matter.present) ||
      (s.legacy.case_clio_id && s.legacy.case_clio_id.present)) steps.push('dropCases');

  return { problems, notes, steps, done: steps.length === 0 && t.state === 'new' };
}

function casesColumns(s) {
  return ['clio_matter', 'case_clio_id'].filter(c => s.legacy[c] && s.legacy[c].present);
}

function describeStep(step, s) {
  switch (step) {
    case 'rebuild':      return `rebuild ${TRIGGER} without the contact_clio_id block (LOCK TABLES contacts WRITE; DROP + CREATE; UNLOCK) — definer ${s.trigger.definer}, sql_mode "${s.trigger.sqlMode}"`;
    case 'create':       return `create ${TRIGGER} (it is missing)`;
    case 'dropContacts': return SQL.dropContacts;
    case 'dropCases':    return SQL.dropCases(casesColumns(s));
    default:             return step;
  }
}

// ─────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────

/** LOCK, (DROP,) CREATE, UNLOCK — restoring the OLD body if CREATE fails. */
async function rebuildTrigger(conn, s, log) {
  const oldMode = s.trigger.state === 'absent' ? null : s.trigger.sqlMode;
  const [{ sm: sessionMode }] = await q(conn, '/* s5b:session-mode */ SELECT @@SESSION.sql_mode AS sm');
  if (oldMode !== null) await q(conn, 'SET SESSION sql_mode = ?', [oldMode]);
  try {
    await q(conn, SQL.lock, [], DDL_TIMEOUT_MS);
    try {
      if (s.trigger.state === 'old') await q(conn, SQL.dropTrigger, [], DDL_TIMEOUT_MS);
      try {
        await q(conn, SQL.createTrigger(NEW_BODY), [], DDL_TIMEOUT_MS);
      } catch (err) {
        if (s.trigger.state !== 'old') throw err;
        // Put the old one back while the lock still holds every writer off.
        try {
          await q(conn, SQL.createTrigger(OLD_BODY), [], DDL_TIMEOUT_MS);
        } catch (restoreErr) {
          const e = new Error(`CREATE of the rebuilt trigger failed (${err.message}) AND restoring the old one failed ` +
            `(${restoreErr.message}). ${TRIGGER} IS MISSING: contact edits are not being logged. ` +
            'Fix and re-run --apply now — it recreates the trigger.');
          e.triggerMissing = true;
          throw e;
        }
        const e = new Error(`CREATE of the rebuilt trigger failed: ${err.message}. The OLD trigger was restored — nothing changed.`);
        e.nothingChanged = true;
        throw e;
      }
    } finally {
      await q(conn, SQL.unlock).catch(() => {});
    }
  } finally {
    if (oldMode !== null) await q(conn, 'SET SESSION sql_mode = ?', [sessionMode]).catch(() => {});
  }
  log(`  ✓ ${TRIGGER} rebuilt`);
}

/**
 * The smoke tests: real UPDATEs inside a transaction that is rolled back.
 * The contact one must fire the rebuilt trigger and write its log row; the
 * case one must simply work. Neither persists anything.
 */
async function smoke(conn, log) {
  const [c] = await q(conn,
    '/* s5b:smoke-contact */ SELECT contact_id, contact_notes FROM contacts ' +
    'WHERE CHAR_LENGTH(contact_notes) < 2000 ORDER BY contact_id ASC LIMIT 1');
  const [k] = await q(conn,
    '/* s5b:smoke-case */ SELECT case_id, case_notes FROM cases ' +
    'WHERE CHAR_LENGTH(case_notes) < 2000 ORDER BY case_id ASC LIMIT 1');
  if (!c || !k) throw new Error('no contact / case to smoke-test on');
  const [{ m }] = await q(conn, '/* s5b:log-max */ SELECT COALESCE(MAX(log_id), 0) AS m FROM log');

  await conn.beginTransaction();
  let rows;
  try {
    await q(conn, '/* s5b:smoke */ UPDATE contacts SET contact_notes = CONCAT(contact_notes, ?) WHERE contact_id = ?',
      ['.', c.contact_id]);
    rows = await q(conn,
      "/* s5b:smoke-log */ SELECT log_id, log_data FROM log WHERE log_id > ? AND log_type = 'update' AND log_link = ?",
      [m, String(c.contact_id)]);
    await q(conn, '/* s5b:smoke */ UPDATE cases SET case_notes = CONCAT(case_notes, ?) WHERE case_id = ?',
      ['.', k.case_id]);
  } finally {
    await conn.rollback().catch(() => {});
  }
  const data = rows.length === 1
    ? (typeof rows[0].log_data === 'string' ? JSON.parse(rows[0].log_data) : rows[0].log_data)
    : null;
  if (!data || data.new_contact_notes !== `${c.contact_notes}.`) {
    throw new Error(`the rebuilt trigger did not log the smoke UPDATE on contact ${c.contact_id} ` +
      `(${rows.length} log row(s)) — contact edits may not be logged`);
  }
  // The rollback must have taken both writes back.
  const [after] = await q(conn, '/* s5b:smoke-after */ SELECT contact_notes FROM contacts WHERE contact_id = ?', [c.contact_id]);
  const [afterK] = await q(conn, '/* s5b:smoke-after */ SELECT case_notes FROM cases WHERE case_id = ?', [k.case_id]);
  const leftover = await q(conn,
    "/* s5b:smoke-after */ SELECT COUNT(*) AS n FROM log WHERE log_id > ? AND log_type = 'update' AND log_link = ? " +
    "AND log_data LIKE '%previous_contact_notes%'", [m, String(c.contact_id)]);
  if (after.contact_notes !== c.contact_notes || afterK.case_notes !== k.case_notes || Number(leftover[0].n) !== 0) {
    throw new Error(`the smoke rollback did not undo everything (contact ${c.contact_id}, case ${k.case_id}) — look now`);
  }
  log(`  ✓ smoke: contact ${c.contact_id} UPDATE fired the rebuilt trigger and logged; case ${k.case_id} UPDATE ok; both rolled back`);
}

// ─────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────

async function run(conn, { apply = false, log = console.log } = {}) {
  const say = log;
  say(`\n=== Custom Fields S5-B — drop the retired Clio columns — ${apply ? 'APPLY' : 'CHECK (read-only)'} ===\n`);

  const s = await readState(conn);
  say(`database ${s.db} on MySQL ${s.version}, connected as ${s.user}`);
  say(`${TRIGGER}: ${s.trigger.state}${s.trigger.state === 'absent' ? '' :
    ` (definer ${s.trigger.definer}, sql_mode "${s.trigger.sqlMode}")`}; ${s.triggerCount} triggers in the schema`);
  for (const L of LEGACY) {
    const r = s.legacy[L.column];
    say(`${L.table}.${L.column}: ${!r.present ? 'already dropped' :
      L.cf ? `present — ${r.legacy} filled, ${r.lost} would be lost, ${r.edited} edited in ${L.cf} since, ${r.cf_only} cf-only`
           : `present — ${r.filled} filled`}`);
  }
  for (const P of PILOT) {
    const f = s.fingerprint[P.field_key];
    say(`${P.table}.${P.field_key}: ${f ? `${f.n} values (checksum ${f.x})` : 'MISSING'}`);
  }

  const p = plan(s);
  for (const n of p.notes) say(`note: ${n}`);
  if (p.problems.length) {
    say('\nPROBLEMS:');
    for (const x of p.problems) say(`  - ${x}`);
    const line = `NO-GO — ${p.problems.length} problem(s) above. Nothing was changed.`;
    say(`\n${line}`);
    return { ok: false, line, state: s };
  }
  if (p.done) {
    const line = 'ALREADY APPLIED — the columns are gone and the trigger is rebuilt. GO: commit and deploy (git go).';
    say(`\n${line}`);
    return { ok: true, line, state: s, done: true };
  }

  say('\nPLAN, in this order:');
  p.steps.forEach((st, i) => say(`  ${i + 1}. ${describeStep(st, s)}`));
  say('  then: re-read everything, verify, and smoke-test a contact UPDATE and a case UPDATE (rolled back)');

  if (!apply) {
    const line = 'CHECK OK — GO. Next: node scripts/customFieldsS5bDrop.js --apply';
    say(`\n${line}`);
    return { ok: true, line, state: s, plan: p };
  }

  // ── apply ──
  say('');
  const done = [];
  try {
    await q(conn, SQL.lockWait);
    for (const st of p.steps) {
      if (st === 'rebuild' || st === 'create') {
        await rebuildTrigger(conn, s, say);
        // The column drop below is only safe once THIS body is live.
        const [t] = await q(conn,
          '/* s5b:verify-trigger */ SELECT ACTION_STATEMENT AS body, DEFINER AS definer, SQL_MODE AS sql_mode ' +
          'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [TRIGGER]);
        if (!t || norm(t.body) !== NEW_BODY) throw new Error(`${TRIGGER} is not the rebuilt body after the rebuild — stopping before any column drop`);
        if (s.trigger.state === 'old' && (t.definer !== s.trigger.definer || t.sql_mode !== s.trigger.sqlMode)) {
          throw new Error(`${TRIGGER} came back as ${t.definer} / "${t.sql_mode}", expected ${s.trigger.definer} / "${s.trigger.sqlMode}"`);
        }
        done.push('trigger rebuilt');
      } else if (st === 'dropContacts') {
        await q(conn, SQL.dropContacts, [], DDL_TIMEOUT_MS);
        say(`  ✓ ${SQL.dropContacts}`);
        done.push('contacts.contact_clio_id dropped');
      } else if (st === 'dropCases') {
        const sql = SQL.dropCases(casesColumns(s));
        await q(conn, sql, [], DDL_TIMEOUT_MS);
        say(`  ✓ ${sql}`);
        done.push(`cases.${casesColumns(s).join(', cases.')} dropped`);
      }
    }

    // ── verify the end state ──
    const after = await readState(conn);
    const bad = [];
    if (after.trigger.state !== 'new') bad.push(`${TRIGGER} is "${after.trigger.state}", expected the rebuilt body`);
    for (const L of LEGACY) if (after.legacy[L.column].present) bad.push(`${L.table}.${L.column} still exists`);
    for (const r of after.refs) bad.push(`${r.kind} ${r.name} still names a dropped column`);
    if (after.triggerCount !== s.triggerCount + (s.trigger.state === 'absent' ? 1 : 0)) {
      bad.push(`trigger count is ${after.triggerCount}, expected ${s.triggerCount + (s.trigger.state === 'absent' ? 1 : 0)}`);
    }
    for (const P of PILOT) {
      const b = s.fingerprint[P.field_key], a = after.fingerprint[P.field_key];
      if (!a || !b || a.n !== b.n || a.x !== b.x) bad.push(`${P.field_key} changed: before ${JSON.stringify(b)}, after ${JSON.stringify(a)}`);
    }
    if (bad.length) throw new Error('end state is wrong:\n    - ' + bad.join('\n    - '));
    say(`  ✓ verified: columns gone, ${TRIGGER} rebuilt (${after.trigger.definer}, "${after.trigger.sqlMode}"), ` +
      `no remaining references, cf_ values unchanged (${PILOT.map(P => `${P.field_key} ${after.fingerprint[P.field_key].n}`).join(', ')})`);

    await smoke(conn, say);
  } catch (err) {
    say(`\n  ✗ ${err.message}`);
    const line = err.triggerMissing
      ? `NO-GO — ${TRIGGER} IS MISSING. Re-run node scripts/customFieldsS5bDrop.js --apply NOW. Do NOT deploy.`
      : err.nothingChanged
        ? 'NO-GO — nothing was changed (old trigger restored). Paste this output. Do NOT deploy.'
        : `NO-GO — stopped ${done.length ? `after: ${done.join('; ')}` : 'before any change'}. ` +
          'Re-running --apply resumes from the live state. Do NOT deploy until it says GO.';
    say(`\n${line}`);
    return { ok: false, line, state: s, done };
  }

  const line = 'S5-B APPLIED — GO. Next: commit and deploy (git go); the pre-commit hook regenerates ref/database.sql.';
  say(`\n${line}`);
  return { ok: true, line, state: s, done };
}

module.exports = { NEW_BODY, OLD_BODY, CLIO_BLOCK, TRIGGER, SQL, LEGACY, plan, readState, run };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
