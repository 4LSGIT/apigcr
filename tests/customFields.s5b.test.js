// tests/customFields.s5b.test.js
//
/**
 * Custom-fields arc S5-B — dropping the three retired Clio columns
 * (ref/CUSTOM_FIELDS_DESIGN.md §7 S5-B): scripts/customFieldsS5bDrop.js and
 * its record, ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql.
 *
 * The proof obligations:
 *
 *   1. THE BODIES. The rebuilt `after_contact_update` is the live one minus
 *      exactly the `contact_clio_id` IF block. Pinned against ref/database.sql
 *      — which holds the OLD body until the post-migration commit regenerates
 *      it and the NEW body after, so the pin holds on both sides of the
 *      apply — and against the migration record.
 *
 *   2. THE PLAN. Every live state the script can meet — fresh, half-applied,
 *      trigger missing, done — maps to the right remaining steps, and every
 *      unsafe state (a body nobody expected, the wrong DEFINER, a value that
 *      would be lost, anything else in the schema naming a column) is a NO-GO
 *      BEFORE any write.
 *
 *   3. THE ORDER. The trigger is rebuilt — and its new body read back — before
 *      any column drop; under LOCK TABLES; in the old trigger's own sql_mode,
 *      restored after; a failed CREATE puts the old body back while the lock
 *      still holds; a lock-wait timeout changes nothing; and the smoke UPDATEs
 *      always roll back.
 *
 * Harness: a scripted single connection that MODELS MySQL's behaviour where
 * it matters here — including the landmine itself: with the old trigger in
 * place and contact_clio_id dropped, a contact UPDATE fails 1054. The same
 * script was run for real against a MySQL 8.4.11 clone of the full
 * ref/database.sql schema (triggers owned by the app user, stamped with a
 * non-session sql_mode) — design doc §8 carries that run: the happy path, all
 * three resume states (rebuilt / missing / the landmine itself), the NO-GOs,
 * and a real long transaction tripping lock_wait_timeout after 5 s.
 *
 *   npx jest tests/customFields.s5b.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const S5B = require('../scripts/customFieldsS5bDrop');
const { NEW_BODY, OLD_BODY, CLIO_BLOCK, SQL, plan, run } = S5B;

const REPO = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');
const NAMES = /(^|[^A-Za-z0-9_])(clio_matter|case_clio_id|contact_clio_id)([^A-Za-z0-9_]|$)/;

const SESSION_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const OLD_STAMP    = 'NO_AUTO_VALUE_ON_ZERO';

// ═════════════════════════════════════════════════════════════
// 1. The bodies
// ═════════════════════════════════════════════════════════════

describe('S5-B — the trigger bodies', () => {
  test('NEW is OLD minus exactly the contact_clio_id block — nothing else moved', () => {
    expect(OLD_BODY.split(CLIO_BLOCK)).toHaveLength(2);
    expect(OLD_BODY.replace(CLIO_BLOCK, '')).toBe(NEW_BODY);
    expect(NEW_BODY).not.toMatch(NAMES);
    expect(OLD_BODY.match(/contact_clio_id/g)).toHaveLength(6);   // the compare, two OLD./NEW. pairs, two JSON keys
    expect(NEW_BODY.startsWith('BEGIN\n')).toBe(true);
    expect(NEW_BODY.endsWith('\nEND')).toBe(true);
    expect(NEW_BODY).not.toContain('\r');
  });

  test('ref/database.sql holds one of the two — OLD before the apply, NEW after the regen', () => {
    const ref = read('ref/database.sql');
    const head = 'CREATE TRIGGER `after_contact_update` AFTER UPDATE ON `contacts` FOR EACH ROW ';
    const i = ref.indexOf(head);
    expect(i).toBeGreaterThan(-1);
    const body = ref.slice(i + head.length, ref.indexOf('\n$$', i)).replace(/\r\n/g, '\n');
    expect([OLD_BODY, NEW_BODY]).toContain(body);
  });

  test('the migration record carries the exact CREATE the script runs, in the script\'s order', () => {
    const sql = read('ref/migrations/2026-10-13_custom_fields_s5b_drop_clio_columns.sql');
    expect(sql).toContain(SQL.createTrigger(NEW_BODY));
    const at = s => { const k = sql.indexOf(s); expect(k).toBeGreaterThan(-1); return k; };
    const order = [
      at(SQL.lockWait), at(SQL.lock), at(SQL.dropTrigger + ';'), at('CREATE TRIGGER `after_contact_update`'),
      at(SQL.unlock + ';'), at(SQL.dropContacts + ';'),
      at(SQL.dropCases(['clio_matter', 'case_clio_id']) + ';'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The rollback is written down, commented out.
    expect(sql).toMatch(/^--\s+ALTER TABLE `contacts` ADD COLUMN `contact_clio_id`/m);
    expect(sql).toMatch(/ADD COLUMN `case_clio_id`/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE \S+ ADD COLUMN/m);
  });
});

// ═════════════════════════════════════════════════════════════
// The scripted connection
// ═════════════════════════════════════════════════════════════

const OTHER_TRIGGERS = [
  'contact_name_insert', 'contact_name_update', 'trg_cases_ct_compat_ins', 'trg_cases_ct_compat_upd',
  'insert_checklist_status', 'update_checklist_status', 'insert_seq_type_steps', 'update_seq_type_steps',
  'before_insert_tasks', 'before_update_tasks', 'trg_prevent_duplicate_insert',
  'trg_prevent_duplicate_update', 'parse_contact_name_trigger', 'parse_contact_name_update_trigger',
].map(name => ({ name, tbl: 'x', timing: 'BEFORE', event: 'UPDATE',
                 body: 'SET NEW.contact_name = TRIM(NEW.contact_fname)', definer: 'yc_app@%', sql_mode: OLD_STAMP }));

/**
 * A model of the one connection the script holds. `o` shapes the live state;
 * `o.fail` makes named statements throw. Everything the script WRITES lands in
 * `db.writes`, in order; every read is answered from the model.
 */
function fakeDb(o = {}) {
  const crlf = s => s.replace(/\n/g, '\r\n');   // the live trigger is CRLF
  const m = {
    user: o.user || 'yc_app@%',
    sessionMode: SESSION_MODE,
    trigger: o.trigger === null ? null : {
      name: 'after_contact_update', tbl: 'contacts', timing: 'AFTER', event: 'UPDATE',
      definer: 'yc_app@%', sql_mode: OLD_STAMP, body: crlf(OLD_BODY), ...(o.trigger || {}),
    },
    extraTriggers: o.extraTriggers || [],
    cols: new Set(o.cols || ['contacts.contact_clio_id', 'cases.clio_matter', 'cases.case_clio_id',
                             'contacts.cf_clio_id', 'cases.cf_clio_matter']),
    defs: o.defs || [
      { id: 1, entity: 'case',    field_key: 'cf_clio_matter', field_type: 'text', active: 1 },
      { id: 2, entity: 'contact', field_key: 'cf_clio_id',     field_type: 'text', active: 1 },
    ],
    views: o.views || [], gens: o.gens || [], routines: o.routines || [], events: o.events || [],
    loss: { contact_clio_id: { legacy: 245, lost: 0, edited: 0, cf_only: 0 },
            clio_matter:     { legacy: 240, lost: 0, edited: 0, cf_only: 0 }, ...(o.loss || {}) },
    filled: { case_clio_id: 0, ...(o.filled || {}) },
    fp: { cf_clio_id: { n: 245, x: '111' }, cf_clio_matter: { n: 240, x: '222' } },
    inTx: false, pendingLog: [], rollbackLeaks: !!o.rollbackLeaks,
  };
  const fail = o.fail || {};
  const writes = [];
  const err = (msg, code) => Object.assign(new Error(msg), { code });

  const query = async (opts, params = []) => {
    const sql = typeof opts === 'string' ? opts : opts.sql;
    const tag = (sql.match(/^\/\* s5b:([\w:-]+) \*\//) || [])[1];
    const trigRow = t => ({ ...t, body: t.body, sql_mode: t.sql_mode });
    switch (tag) {
      case 'who':          return [[{ cu: m.user, sm: m.sessionMode, db: 'yc', v: '8.4.11-google' }]];
      case 'session-mode': return [[{ sm: m.sessionMode }]];
      case 'triggers':     return [[...(m.trigger ? [trigRow(m.trigger)] : []), ...OTHER_TRIGGERS, ...m.extraTriggers]];
      case 'columns':      return [[...m.cols].map(k => { const [t, c] = k.split('.'); return { t, c, g: c.startsWith('cf_') ? 'json_value(...)' : '' }; })];
      case 'defs':         return [m.defs];
      case 'views':        return [m.views];
      case 'generated':    return [[...m.gens, { name: 'contacts.cf_clio_id', def: "json_value(`custom`,_utf8mb4'$.cf_clio_id' returning char(255))" }]];
      case 'routines':     return [m.routines];
      case 'events':       return [m.events];
      case 'verify-trigger': return [m.trigger ? [{ body: m.trigger.body, definer: m.trigger.definer, sql_mode: m.trigger.sql_mode }] : []];
      case 'smoke-contact': return [[{ contact_id: 1, contact_notes: 'n' }]];
      case 'smoke-case':    return [[{ case_id: 'AAAA0001', case_notes: 'c' }]];
      case 'log-max':       return [[{ m: 100 }]];
      case 'smoke-log':     return [m.pendingLog];
      case 'smoke-after':
        if (/FROM contacts/.test(sql)) return [[{ contact_notes: m.rollbackLeaks ? 'n.' : 'n' }]];
        if (/FROM cases/.test(sql))    return [[{ case_notes: 'c' }]];
        return [[{ n: m.rollbackLeaks ? 1 : 0 }]];
      default: break;
    }
    if (tag && tag.startsWith('loss:'))        return [[m.loss[tag.slice(5)]]];
    if (tag && tag.startsWith('filled:'))      return [[{ filled: m.filled[tag.slice(7)] }]];
    if (tag && tag.startsWith('fingerprint:')) {
      const k = tag.slice(12);
      return [[m.fp[k]]];
    }

    // ── writes ──
    if (tag === 'smoke') {
      writes.push(sql.includes('UPDATE contacts') ? 'SMOKE contacts' : 'SMOKE cases');
      if (sql.includes('UPDATE contacts')) {
        if (fail.smoke) throw err(fail.smoke, 'ER_X');
        // The landmine, modelled: a trigger naming a column that is gone.
        if (m.trigger && /contact_clio_id/.test(m.trigger.body) && !m.cols.has('contacts.contact_clio_id')) {
          throw err("Unknown column 'contact_clio_id' in 'OLD'", 'ER_BAD_FIELD_ERROR');
        }
        if (m.trigger && !o.triggerSilent) {
          m.pendingLog.push({ log_id: 101, log_data: JSON.stringify({ contact_id: 1, previous_contact_notes: 'n', new_contact_notes: `n${params[0]}` }) });
        }
      }
      return [{ affectedRows: 1 }];
    }
    writes.push(sql.startsWith('CREATE TRIGGER') ? (sql.endsWith(NEW_BODY) ? 'CREATE NEW' : sql.endsWith(OLD_BODY) ? 'CREATE OLD' : 'CREATE ?')
      : sql.startsWith('SET SESSION sql_mode') ? `SET sql_mode=${params[0]}` : sql);
    if (sql === SQL.lockWait) return [{}];
    if (sql.startsWith('SET SESSION sql_mode')) { m.sessionMode = params[0]; return [{}]; }
    if (sql === SQL.lock) { if (fail.lock) throw err('Lock wait timeout exceeded; try restarting transaction', 'ER_LOCK_WAIT_TIMEOUT'); return [{}]; }
    if (sql === SQL.unlock) return [{}];
    if (sql === SQL.dropTrigger) { if (!m.trigger) throw err('Trigger does not exist', 'ER_TRG_DOES_NOT_EXIST'); m.trigger = null; return [{}]; }
    if (sql.startsWith('CREATE TRIGGER')) {
      const isNew = sql.endsWith(NEW_BODY);
      if (isNew && fail.create) throw err(fail.create, 'ER_X');
      if (!isNew && fail.restore) throw err(fail.restore, 'ER_X');
      m.trigger = { name: 'after_contact_update', tbl: 'contacts', timing: 'AFTER', event: 'UPDATE',
                    definer: m.user, sql_mode: m.sessionMode, body: isNew && !o.createNoop ? NEW_BODY : OLD_BODY };
      return [{}];
    }
    if (sql === SQL.dropContacts) {
      if (fail.dropContacts) throw err(fail.dropContacts, 'ER_X');
      m.cols.delete('contacts.contact_clio_id'); return [{}];
    }
    if (sql.startsWith('ALTER TABLE `cases`')) {
      if (fail.dropCases) throw err(fail.dropCases, 'ER_LOCK_WAIT_TIMEOUT');
      m.cols.delete('cases.clio_matter'); m.cols.delete('cases.case_clio_id');
      if (o.fpDrift) m.fp.cf_clio_matter = { n: 239, x: '999' };
      return [{}];
    }
    throw new Error('fakeDb: unscripted statement — ' + sql);
  };

  const conn = {
    query,
    beginTransaction: async () => { writes.push('BEGIN'); m.inTx = true; },
    rollback: async () => { writes.push('ROLLBACK'); m.inTx = false; if (!m.rollbackLeaks) m.pendingLog = []; },
    commit: async () => { throw new Error('the script must never COMMIT'); },
  };
  return { conn, writes, model: m };
}

const quiet = () => {};
const DDL = w => w.filter(s => !['BEGIN', 'ROLLBACK', 'SMOKE contacts', 'SMOKE cases'].includes(s));

// ═════════════════════════════════════════════════════════════
// 2. The plan
// ═════════════════════════════════════════════════════════════

describe('S5-B — plan(): live state → remaining steps', () => {
  const stateOf = async o => S5B.readState(fakeDb(o).conn);

  test('fresh: rebuild, then contacts, then cases — no problems', async () => {
    const p = plan(await stateOf());
    expect(p.problems).toEqual([]);
    expect(p.steps).toEqual(['rebuild', 'dropContacts', 'dropCases']);
    expect(p.done).toBe(false);
  });

  test('the CRLF live body still reads as OLD (the stored body is CRLF; the script compares normalized)', async () => {
    const s = await stateOf();
    expect(s.trigger.state).toBe('old');
  });

  test('half-applied: trigger already rebuilt → only the drops left', async () => {
    const p = plan(await stateOf({ trigger: { body: NEW_BODY } }));
    expect(p.problems).toEqual([]);
    expect(p.steps).toEqual(['dropContacts', 'dropCases']);
  });

  test('the landmine state (column gone, old trigger still there) → rebuild + the cases drop', async () => {
    const p = plan(await stateOf({ cols: ['cases.clio_matter', 'cases.case_clio_id', 'contacts.cf_clio_id', 'cases.cf_clio_matter'] }));
    expect(p.problems).toEqual([]);
    expect(p.steps).toEqual(['rebuild', 'dropCases']);
  });

  test('trigger missing → created, with a loud note', async () => {
    const p = plan(await stateOf({ trigger: null }));
    expect(p.steps[0]).toBe('create');
    expect(p.notes.join(' ')).toMatch(/MISSING/);
  });

  test('done: rebuilt and nothing left to drop', async () => {
    const p = plan(await stateOf({ trigger: { body: NEW_BODY }, cols: ['contacts.cf_clio_id', 'cases.cf_clio_matter'] }));
    expect(p).toMatchObject({ problems: [], steps: [], done: true });
  });

  test('edited / cf-only values are notes, not problems — the cf_ value is the live one', async () => {
    const p = plan(await stateOf({ loss: { contact_clio_id: { legacy: 245, lost: 0, edited: 2, cf_only: 3 } } }));
    expect(p.problems).toEqual([]);
    expect(p.notes.join(' ')).toMatch(/2 row\(s\) had cf_clio_id edited/);
  });

  const NOGO = [
    ['a body nobody expected', { trigger: { body: 'BEGIN\nEND' } }, /neither the expected old body nor the rebuilt one/],
    ['the wrong DEFINER (a rebuild would re-own the trigger)', { user: 'root@%' }, /belongs to yc_app@%/],
    ['the trigger on the wrong event', { trigger: { timing: 'BEFORE' } }, /expected AFTER UPDATE ON contacts/],
    ['a value that would be lost', { loss: { clio_matter: { legacy: 240, lost: 1, edited: 0, cf_only: 0 } } }, /would lose them/],
    ['case_clio_id no longer empty', { filled: { case_clio_id: 2 } }, /no longer empty/],
    ['a pilot def missing', { defs: [{ id: 1, entity: 'case', field_key: 'cf_clio_matter', active: 1 }] }, /contact\/cf_clio_id is missing/],
    ['a pilot def inactive', { defs: [
      { id: 1, entity: 'case', field_key: 'cf_clio_matter', active: 1 },
      { id: 2, entity: 'contact', field_key: 'cf_clio_id', active: 0 }] }, /is not active/],
    ['a virtual column missing', { cols: ['contacts.contact_clio_id', 'cases.clio_matter', 'cases.case_clio_id', 'cases.cf_clio_matter'] }, /contacts\.cf_clio_id does not exist/],
    ['another trigger naming a column', { extraTriggers: [{ name: 'evil', tbl: 'cases', timing: 'AFTER', event: 'UPDATE', body: 'SET @x = NEW.clio_matter', definer: 'yc_app@%', sql_mode: '' }] }, /trigger evil names a column/],
    ['a view naming a column', { views: [{ name: 'v_clio', def: 'select `cases`.`clio_matter` AS `clio_matter` from `cases`' }] }, /view v_clio names a column/],
    ['a generated column naming one', { gens: [{ name: 'cases.x', def: 'upper(`case_clio_id`)' }] }, /generated column cases\.x/],
  ];
  test.each(NOGO)('NO-GO before any write: %s', async (_label, o, re) => {
    const { conn, writes } = fakeDb(o);
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — \d+ problem\(s\) above\. Nothing was changed\.$/);
    expect(plan(r.state).problems.join('\n')).toMatch(re);
    expect(writes).toEqual([]);
  });

  test('the cf_ keys themselves never count as references (their names contain the old ones)', async () => {
    const s = await stateOf({ trigger: { body: NEW_BODY } });
    expect(s.refs).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════
// 3. The run
// ═════════════════════════════════════════════════════════════

describe('S5-B — run()', () => {
  test('CHECK writes nothing and says GO for --apply', async () => {
    const { conn, writes } = fakeDb();
    const r = await run(conn, { log: quiet });
    expect(r).toMatchObject({ ok: true, line: 'CHECK OK — GO. Next: node scripts/customFieldsS5bDrop.js --apply' });
    expect(writes).toEqual([]);
  });

  test('APPLY, fresh: the exact statement order, the stamp kept, the smoke rolled back', async () => {
    const { conn, writes, model } = fakeDb();
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.line).toMatch(/^S5-B APPLIED — GO\./);
    expect(writes).toEqual([
      SQL.lockWait,
      `SET sql_mode=${OLD_STAMP}`,          // the old trigger's own stamp
      SQL.lock,
      SQL.dropTrigger,
      'CREATE NEW',
      SQL.unlock,
      `SET sql_mode=${SESSION_MODE}`,       // restored
      SQL.dropContacts,
      SQL.dropCases(['clio_matter', 'case_clio_id']),
      'BEGIN', 'SMOKE contacts', 'SMOKE cases', 'ROLLBACK',
    ]);
    expect(model.trigger).toMatchObject({ body: NEW_BODY, definer: 'yc_app@%', sql_mode: OLD_STAMP });
    expect([...model.cols].sort()).toEqual(['cases.cf_clio_matter', 'contacts.cf_clio_id']);
  });

  test('MUTATION CHECK — the contacts drop can never precede the rebuilt trigger', async () => {
    const { conn, writes } = fakeDb();
    await run(conn, { apply: true, log: quiet });
    expect(writes.indexOf(SQL.dropContacts)).toBeGreaterThan(writes.indexOf('CREATE NEW'));
    expect(writes.indexOf(SQL.dropContacts)).toBeGreaterThan(writes.indexOf(SQL.unlock));
  });

  test('a rebuild that did not take stops BEFORE any column drop (the body is read back, not assumed)', async () => {
    const { conn, writes, model } = fakeDb({ createNoop: true });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(writes).not.toContain(SQL.dropContacts);
    expect(model.cols.has('contacts.contact_clio_id')).toBe(true);
  });

  test('the landmine, modelled: the old trigger with the column gone fails every contact UPDATE', async () => {
    // What the order above prevents — and what a re-run repairs: from this
    // state the plan is rebuild + cases drop, and the smoke then passes.
    const f = fakeDb({ cols: ['cases.clio_matter', 'cases.case_clio_id', 'contacts.cf_clio_id', 'cases.cf_clio_matter'] });
    await expect(f.conn.query({ sql: '/* s5b:smoke */ UPDATE contacts SET contact_notes = CONCAT(contact_notes, ?) WHERE contact_id = ?' }, ['.', 1]))
      .rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
    const r = await run(f.conn, { apply: true, log: quiet });
    expect(r.ok).toBe(true);
    expect(f.model.trigger.body).toBe(NEW_BODY);
  });

  test('resume after a rebuild: only the drops run, no lock, no sql_mode dance', async () => {
    const { conn, writes } = fakeDb({ trigger: { body: NEW_BODY } });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(true);
    expect(DDL(writes)).toEqual([SQL.lockWait, SQL.dropContacts, SQL.dropCases(['clio_matter', 'case_clio_id'])]);
  });

  test('trigger missing: created (no DROP), in the session\'s own mode, then the drops', async () => {
    const { conn, writes, model } = fakeDb({ trigger: null });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(true);
    expect(DDL(writes)).toEqual([SQL.lockWait, SQL.lock, 'CREATE NEW', SQL.unlock, SQL.dropContacts,
                                 SQL.dropCases(['clio_matter', 'case_clio_id'])]);
    expect(model.trigger.sql_mode).toBe(SESSION_MODE);
  });

  test('CREATE fails → the OLD body goes back under the same lock; nothing dropped', async () => {
    const { conn, writes, model } = fakeDb({ fail: { create: 'boom' } });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.line).toBe('NO-GO — nothing was changed (old trigger restored). Paste this output. Do NOT deploy.');
    expect(DDL(writes)).toEqual([SQL.lockWait, `SET sql_mode=${OLD_STAMP}`, SQL.lock, SQL.dropTrigger,
                                 'CREATE NEW' /* attempted, failed */, 'CREATE OLD', SQL.unlock,
                                 `SET sql_mode=${SESSION_MODE}`]);
    expect(model.trigger).toMatchObject({ body: OLD_BODY, sql_mode: OLD_STAMP });
    expect(model.cols.has('contacts.contact_clio_id')).toBe(true);
  });

  test('CREATE and the restore both fail → the loudest line there is', async () => {
    const { conn, writes } = fakeDb({ fail: { create: 'boom', restore: 'bang' } });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.line).toMatch(/^NO-GO — after_contact_update IS MISSING\. Re-run .* --apply NOW\. Do NOT deploy\.$/);
    expect(writes).toContain(SQL.unlock);              // the lock is still released
    expect(writes).not.toContain(SQL.dropContacts);
  });

  test('a lock-wait timeout on LOCK TABLES changes nothing', async () => {
    const { conn, writes, model } = fakeDb({ fail: { lock: true } });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.line).toMatch(/^NO-GO — stopped before any change\./);
    expect(writes).not.toContain(SQL.dropTrigger);
    expect(model.trigger.body).toBe(OLD_BODY.replace(/\n/g, '\r\n'));
  });

  test('a failure half way names what was done, and a re-run resumes from there', async () => {
    const f = fakeDb({ fail: { dropCases: 'Lock wait timeout exceeded' } });
    const r = await run(f.conn, { apply: true, log: quiet });
    expect(r.line).toBe('NO-GO — stopped after: trigger rebuilt; contacts.contact_clio_id dropped. ' +
      'Re-running --apply resumes from the live state. Do NOT deploy until it says GO.');
    expect(f.writes).not.toContain('BEGIN');            // no smoke on a half-done run
    const p = plan(await S5B.readState(f.conn));
    expect(p.steps).toEqual(['dropCases']);
  });

  test('cf_ values that changed across the run are a NO-GO', async () => {
    const { conn } = fakeDb({ fpDrift: true });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — stopped after: .*cases\.clio_matter, cases\.case_clio_id dropped\./);
  });

  test('a trigger that does not log the smoke UPDATE is a NO-GO — and the transaction still rolls back', async () => {
    const { conn, writes } = fakeDb({ triggerSilent: true });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(writes.slice(-1)).toEqual(['ROLLBACK']);
  });

  test('a smoke UPDATE that throws still rolls back', async () => {
    const { conn, writes } = fakeDb({ fail: { smoke: 'boom' } });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(writes).toContain('ROLLBACK');
    expect(writes).not.toContain('SMOKE cases');
  });

  test('a rollback that did not take is a NO-GO', async () => {
    const { conn } = fakeDb({ rollbackLeaks: true });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r.ok).toBe(false);
  });

  test('already applied: says so, writes nothing', async () => {
    const { conn, writes } = fakeDb({ trigger: { body: NEW_BODY }, cols: ['contacts.cf_clio_id', 'cases.cf_clio_matter'] });
    const r = await run(conn, { apply: true, log: quiet });
    expect(r).toMatchObject({ ok: true, done: true });
    expect(r.line).toMatch(/^ALREADY APPLIED/);
    expect(writes).toEqual([]);
  });

  test('the script never COMMITs (the smoke is rollback-only by construction)', () => {
    expect(read('scripts/customFieldsS5bDrop.js')).not.toMatch(/\.commit\(/);
  });
});
