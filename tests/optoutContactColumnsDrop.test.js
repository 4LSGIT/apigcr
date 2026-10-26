// tests/optoutContactColumnsDrop.test.js
//
/**
 * Opt-out follow-up (ruling 2026-10-27) — scripts/optoutContactColumnsDrop.js
 * and its record, ref/migrations/2026-10-27_optout_contact_columns_drop.sql.
 *
 *   1. THE PLAN (always runs, no database). Every live state — fresh, half
 *      applied, done — maps to the right remaining steps, and every unsafe
 *      state (a nonzero value, a changed definition, anything in the schema
 *      naming a column, a comment someone else set) is a NO-GO before any
 *      write.
 *   2. THE RECORD names exactly what the script runs.
 *   3. THE ENGINE (gated). The script itself, against a MySQL 8.4 clone of
 *      contacts / contact_phones / contact_emails / log + the contacts
 *      triggers, cut line by line from ref/database.sql: CHECK writes nothing;
 *      --apply drops (ALGORITHM=COPY — contacts' FULLTEXT index refuses
 *      INPLACE), comments, verifies and smoke-tests; a re-run is ALREADY
 *      APPLIED; a nonzero value, a view naming a column, a foreign comment →
 *      NO-GO with nothing changed; a write landing after the CHECK read is
 *      caught by the re-assert, one slipped in just before LOCK TABLES by the
 *      census under the lock; a metadata lock held elsewhere times out in
 *      5 s with nothing changed; a half-applied state resumes; and a
 *      per-column grant on a dropped column is left ORPHANED, not refused
 *      (the report-grant finding, pinned).
 *
 * ── PART 3 IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ───────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_optdrop_test npx jest tests/optoutContactColumnsDrop.test.js --runInBand
 * The database name must end in _test; the suite DROPS and recreates the
 * tables above in it. It needs a root login (it creates a grant user) and the
 * tz tables loaded (`mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql mysql`:
 * the after_contact_update trigger writes CONVERT_TZ(…, 'America/New_York')
 * into a NOT NULL column). Never point it at port 3306 (the production proxy).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const D = require('../scripts/optoutContactColumnsDrop');
const { DROP_COLUMNS, COMMENTS, SQL, plan, run } = D;

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ═════════════════════════════════════════════════════════════
// 1. plan() — pure
// ═════════════════════════════════════════════════════════════

const FLAG = (over = {}) => ({ type: 'tinyint(1)', nullable: 'NO', dflt: '0', comment: '', extra: '', gen: '', ...over });
function state(over = {}) {
  const s = {
    user: 'yc_app@%', db: 'x_test', version: '8.4.11', contactsTable: true,
    drop: { contact_sms_optout: FLAG(), contact_email_optout: FLAG() },
    rows: 1106, nonzero: { contact_sms_optout: 0, contact_email_optout: 0 },
    flags: { 'contact_phones.sms_optout': FLAG(), 'contact_emails.email_optout': FLAG() },
    refs: [],
    ...over,
  };
  s.present = DROP_COLUMNS.filter((c) => s.drop[c]);
  return s;
}
const kinds = (p) => p.steps.map((st) => (st.kind === 'drop' ? `drop:${st.cols.join('+')}` : `comment:${st.table}`));

describe('plan(): live state → remaining steps', () => {
  test('fresh: ONE drop of both columns first, then the two comments — no problems', () => {
    const p = plan(state());
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['drop:contact_sms_optout+contact_email_optout', 'comment:contact_phones', 'comment:contact_emails']);
    expect(p.done).toBe(false);
    expect(p.notes.join(' ')).toMatch(/ORPHANED in mysql\.columns_priv/);
  });

  test('half applied — columns gone, comments not set: only the comments', () => {
    const p = plan(state({ drop: { contact_sms_optout: null, contact_email_optout: null }, nonzero: {}, rows: null }));
    expect(p.problems).toEqual([]);
    expect(kinds(p)).toEqual(['comment:contact_phones', 'comment:contact_emails']);
  });

  test('one column dropped by hand: the drop names only the other', () => {
    const p = plan(state({ drop: { contact_sms_optout: null, contact_email_optout: FLAG() }, nonzero: { contact_email_optout: 0 } }));
    expect(kinds(p)[0]).toBe('drop:contact_email_optout');
  });

  test('done: nothing present, both comments the target → done, no steps', () => {
    const flags = {};
    for (const C of COMMENTS) flags[`${C.table}.${C.column}`] = FLAG({ comment: C.comment });
    const p = plan(state({ drop: { contact_sms_optout: null, contact_email_optout: null }, nonzero: {}, rows: null, flags }));
    expect(p).toMatchObject({ problems: [], steps: [], done: true });
  });

  test('a nonzero value is a NO-GO (nothing may be lost)', () => {
    const p = plan(state({ nonzero: { contact_sms_optout: 0, contact_email_optout: 3 } }));
    expect(p.problems).toEqual([expect.stringMatching(/^3 row\(s\) of contacts\.contact_email_optout hold a nonzero value/)]);
  });

  test('a changed definition of a drop column or a flag is a NO-GO', () => {
    expect(plan(state({ drop: { contact_sms_optout: FLAG({ nullable: 'YES' }), contact_email_optout: FLAG() } })).problems)
      .toEqual([expect.stringMatching(/^contacts\.contact_sms_optout is tinyint\(1\) NULL DEFAULT '0', expected/)]);
    const flags = { 'contact_phones.sms_optout': FLAG({ dflt: '1' }), 'contact_emails.email_optout': FLAG() };
    expect(plan(state({ flags })).problems).toEqual([expect.stringMatching(/^contact_phones\.sms_optout is .* the MODIFY would change it$/)]);
    const gone = { 'contact_phones.sms_optout': null, 'contact_emails.email_optout': FLAG() };
    expect(plan(state({ flags: gone })).problems).toEqual([expect.stringMatching(/^contact_phones\.sms_optout does not exist/)]);
  });

  test('any schema object naming a column is a NO-GO', () => {
    const p = plan(state({ refs: [{ kind: 'view', name: 'v_x' }, { kind: 'trigger', name: 't_y' }] }));
    expect(p.problems).toEqual(['view v_x names a column being dropped — it would break on the drop',
      'trigger t_y names a column being dropped — it would break on the drop']);
  });

  test('a comment someone else set is a NO-GO, never overwritten', () => {
    const flags = { 'contact_phones.sms_optout': FLAG({ comment: 'mine' }), 'contact_emails.email_optout': FLAG() };
    expect(plan(state({ flags })).problems).toEqual([expect.stringMatching(/^contact_phones\.sms_optout already carries a different comment \("mine"\)/)]);
  });

  test('no contacts table is a NO-GO', () => {
    expect(plan(state({ contactsTable: false })).problems[0]).toMatch(/no `contacts` table/);
  });

  test('NAMES_RE matches the two names as identifiers only', () => {
    expect(D.NAMES_RE.test('IF OLD.contact_sms_optout <> 0')).toBe(true);
    expect(D.NAMES_RE.test('`contact_email_optout`')).toBe(true);
    expect(D.NAMES_RE.test('sms_optout email_optout contact_sms_optout_x')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. The record
// ═════════════════════════════════════════════════════════════

describe('the migration record', () => {
  const rec = read('ref/migrations/2026-10-27_optout_contact_columns_drop.sql');
  test('carries the exact statements the script runs, in its order', () => {
    const stmts = [
      `${SQL.lockWait};`,
      `${SQL.lock};`,
      `${SQL.drop(DROP_COLUMNS)};`,
      `${SQL.unlock};`,
      ...COMMENTS.map((C) => `${SQL.comment(C.table, C.column).replace('?', `'${C.comment}'`)};`),
    ];
    let at = -1;
    for (const s of stmts) {
      const i = rec.indexOf(s);
      expect([s, i > at]).toEqual([s, true]);
      at = i;
    }
  });
  test('the script header and the record both state the code-first order and the orphaned grant', () => {
    const src = read('scripts/optoutContactColumnsDrop.js');
    for (const t of [src, rec]) {
      expect(t).toMatch(/CODE FIRST/);
      expect(t).toMatch(/ORPHANED/);
    }
  });
});

// ═════════════════════════════════════════════════════════════
// 3. The engine (gated)
// ═════════════════════════════════════════════════════════════

const URL_ = process.env.YC_TEST_MYSQL_URL;
const g = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['contacts', 'contact_phones', 'contact_emails', 'log'];

// Line-based extraction (column COMMENTs may hold ';'), the tables' ALTER
// blocks (keys incl. contacts' FULLTEXT, AUTO_INCREMENT), and the contacts
// triggers (DELIMITER $$ … $$ blocks).
function schemaFor(tables) {
  const lines = read('ref/database.sql').split('\n');
  const creates = []; const alters = []; const triggers = [];
  for (let i = 0; i < lines.length; i++) {
    const trg = /^CREATE TRIGGER `[a-z_]+` (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON `([a-z_]+)`/.exec(lines[i]);
    if (trg && tables.includes(trg[3])) {
      const buf = [];
      for (; i < lines.length && lines[i] !== '$$'; i++) buf.push(lines[i]);
      triggers.push(buf.join('\n'));
      continue;
    }
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, '')).filter((l) => !/FOREIGN KEY/.test(l));
        if (clauses.length) alters.push(`${buf[0]}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  return { creates, alters, triggers };
}

g('the script on real MySQL', () => {
  const mysql = require('mysql2/promise');
  let conn; let other; let dbName;
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const cols = async () => (await q(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_COMMENT AS cmt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
    "AND TABLE_NAME IN ('contacts','contact_phones','contact_emails') " +
    "AND COLUMN_NAME IN ('contact_sms_optout','contact_email_optout','sms_optout','email_optout') ORDER BY TABLE_NAME, COLUMN_NAME"))
    .map((r) => `${r.t}.${r.c}${r.cmt ? ' [c]' : ''}`);
  const FRESH = ['contact_emails.email_optout', 'contact_phones.sms_optout', 'contacts.contact_email_optout', 'contacts.contact_sms_optout'];
  const DONE = ['contact_emails.email_optout [c]', 'contact_phones.sms_optout [c]'];
  const quiet = (o = {}) => { const out = []; return { out, log: (l) => out.push(l), ...o }; };

  async function fresh() {
    await q('SET FOREIGN_KEY_CHECKS = 0');
    await q('DROP VIEW IF EXISTS v_optdrop');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q('SET FOREIGN_KEY_CHECKS = 1');
    const { creates, alters, triggers } = schemaFor(TABLES);
    for (const s of creates) await q(s);
    for (const s of alters) await q(s);
    for (const s of triggers) await q(s);
    await q(`INSERT INTO contacts (contact_id, contact_fname, contact_lname, contact_notes) VALUES (1, 'Pat', 'One', 'n1'), (2, 'Sam', 'Two', '')`);
    await q(`INSERT INTO contact_phones (id, contact_id, phone, sms_optout) VALUES (11, 1, '3135550001', 1)`);
    await q(`INSERT INTO contact_emails (id, contact_id, email, email_optout) VALUES (21, 1, 'pat@example.com', 0)`);
  }

  beforeAll(async () => {
    const u = new URL(URL_);
    dbName = u.pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (u.port === '3306') throw new Error('refusing to run against the production proxy port');
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    other = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
    for (const c of [conn, other]) await c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);
    const [[tz]] = await conn.query("SELECT CONVERT_TZ('2026-01-01 00:00:00', 'UTC', 'America/New_York') AS v");
    if (!tz.v) throw new Error('load the tz tables first (see the header)');
  });
  afterAll(async () => { for (const c of [conn, other]) if (c) await c.end(); });

  test('CHECK: GO, plans one drop + two comments, writes nothing', async () => {
    await fresh();
    const o = quiet();
    const r = await run(conn, o);
    expect(r.ok).toBe(true);
    expect(r.line).toBe('CHECK OK — GO. Next: node scripts/optoutContactColumnsDrop.js --apply');
    expect(await cols()).toEqual(FRESH);
  });

  test('--apply: GO — columns gone, comments set, flags + rows + triggers intact; a re-run is ALREADY APPLIED', async () => {
    await fresh();
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect([r.ok, r.line]).toEqual([true, expect.stringMatching(/^APPLIED — GO\./)]);
    expect(o.out.join('\n')).toMatch(/✓ smoke: contact 1 UPDATE ran/);
    expect(await cols()).toEqual(DONE);
    const live = await q("SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, COLUMN_COMMENT AS m FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('sms_optout','email_optout') ORDER BY COLUMN_NAME");
    expect(live).toEqual([
      { c: 'email_optout', t: 'tinyint(1)', n: 'NO', d: '0', m: COMMENTS[1].comment },
      { c: 'sms_optout', t: 'tinyint(1)', n: 'NO', d: '0', m: COMMENTS[0].comment },
    ]);
    expect(await q('SELECT contact_id, contact_notes FROM contacts ORDER BY contact_id')).toEqual([{ contact_id: 1, contact_notes: 'n1' }, { contact_id: 2, contact_notes: '' }]);
    expect(await q('SELECT id, sms_optout FROM contact_phones')).toEqual([{ id: 11, sms_optout: 1 }]);
    // the contacts triggers still work after the drop (a real, committed UPDATE)
    await q("UPDATE contacts SET contact_notes = 'n1!' WHERE contact_id = 1");
    expect((await q("SELECT COUNT(*) AS n FROM log WHERE log_type = 'update' AND log_link = '1'"))[0].n).toBe(1);
    for (const apply of [true, false]) {
      const again = await run(conn, quiet({ apply }));
      expect([again.ok, again.done, again.line]).toEqual([true, true, expect.stringMatching(/^ALREADY APPLIED — GO\./)]);
    }
  });

  test('a seeded nonzero value → NO-GO, nothing changed', async () => {
    await fresh();
    await q('UPDATE contacts SET contact_sms_optout = 1 WHERE contact_id = 2');
    const r = await run(conn, quiet({ apply: true }));
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — 1 problem\(s\) above\. Nothing was changed\./);
    expect(await cols()).toEqual(FRESH);
  });

  test('a view naming a column → NO-GO, nothing changed', async () => {
    await fresh();
    await q('CREATE VIEW v_optdrop AS SELECT contact_id, contact_email_optout FROM contacts');
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect(r.ok).toBe(false);
    expect(o.out.join('\n')).toMatch(/view v_optdrop names a column being dropped/);
    expect(await cols()).toEqual(FRESH);
    await q('DROP VIEW v_optdrop');
  });

  test('a comment someone else set → NO-GO, not overwritten', async () => {
    await fresh();
    await q("ALTER TABLE contact_emails MODIFY COLUMN email_optout tinyint(1) NOT NULL DEFAULT '0' COMMENT 'someone else'");
    const r = await run(conn, quiet({ apply: true }));
    expect(r.ok).toBe(false);
    expect((await q("SELECT COLUMN_COMMENT AS m FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'email_optout'"))[0].m).toBe('someone else');
    expect((await cols()).filter((c) => c.startsWith('contacts.'))).toHaveLength(2);
  });

  test('a write slipped in just before LOCK TABLES is caught by the census UNDER the lock: nothing dropped', async () => {
    await fresh();
    const wrapped = {
      query: async (opts, params) => {
        const sql = typeof opts === 'string' ? opts : opts.sql;
        if (sql === SQL.lock) await other.query('UPDATE contacts SET contact_email_optout = 1 WHERE contact_id = 1');
        return conn.query(opts, params);
      },
      beginTransaction: () => conn.beginTransaction(),
      rollback: () => conn.rollback(),
    };
    const o = quiet({ apply: true });
    const r = await run(wrapped, o);
    expect(r.ok).toBe(false);
    expect(o.out.join('\n')).toMatch(/under the lock, contacts\.contact_email_optout has 1 nonzero row\(s\)/);
    expect(r.line).toMatch(/^NO-GO — nothing was changed\./);
    expect(await cols()).toEqual(FRESH);
    // the lock was released
    expect((await other.query('SELECT COUNT(*) AS n FROM contacts'))[0][0].n).toBe(2);
  });

  test('a write between the CHECK read and the apply is caught by the re-assert after lock_wait_timeout: nothing changed', async () => {
    await fresh();
    const wrapped = {
      query: async (opts, params) => {
        const sql = typeof opts === 'string' ? opts : opts.sql;
        if (sql === SQL.lockWait) await other.query('UPDATE contacts SET contact_sms_optout = 1 WHERE contact_id = 2');
        return conn.query(opts, params);
      },
      beginTransaction: () => conn.beginTransaction(),
      rollback: () => conn.rollback(),
    };
    const o = quiet({ apply: true });
    const r = await run(wrapped, o);
    expect(r.ok).toBe(false);
    expect(o.out.join('\n')).toMatch(/the live state changed between the check and the apply:\n\s+- 1 row\(s\) of contacts\.contact_sms_optout hold a nonzero value/);
    expect(r.line).toMatch(/^NO-GO — nothing was changed\./);
    expect(o.out.join('\n')).not.toMatch(/✓/);
    expect(await cols()).toEqual(FRESH);
  });

  test('a metadata lock held elsewhere: LOCK TABLES gives up after 5 s, nothing changed, the re-run resumes', async () => {
    await fresh();
    await other.beginTransaction();
    await other.query('SELECT contact_id FROM contacts LIMIT 1');      // holds a shared MDL until commit
    const t0 = Date.now();
    const r = await run(conn, quiet({ apply: true }));
    const took = Date.now() - t0;
    await other.rollback();
    expect(r.ok).toBe(false);
    expect(r.line).toMatch(/^NO-GO — stopped before any change\. Re-running .* --apply resumes/);
    expect(took).toBeGreaterThanOrEqual(4500);
    expect(took).toBeLessThan(20000);
    expect(await cols()).toEqual(FRESH);
    const again = await run(conn, quiet({ apply: true }));
    expect(again.ok).toBe(true);
    expect(await cols()).toEqual(DONE);
  }, 40000);

  test('resume: columns already dropped by a stopped run → only the comments', async () => {
    await fresh();
    await q(SQL.drop(DROP_COLUMNS));
    const o = quiet({ apply: true });
    const r = await run(conn, o);
    expect(r.ok).toBe(true);
    expect(r.done).toEqual(['commented contact_phones.sms_optout', 'commented contact_emails.email_optout']);
    expect(o.out.join('\n')).not.toMatch(/DROP COLUMN/);
    expect(await cols()).toEqual(DONE);
  });

  test('THE REPORT-GRANT FINDING: a per-column grant does not block the DROP — it is left ORPHANED, inert', async () => {
    await fresh();
    await q("DROP USER IF EXISTS 'yc_optdrop_rep'@'%'");
    await q("CREATE USER 'yc_optdrop_rep'@'%' IDENTIFIED BY 'pw-optdrop-test'"); // secret-scan: allow
    await q(`GRANT SELECT (\`contact_id\`, \`contact_name\`, \`contact_sms_optout\`, \`contact_email_optout\`) ON \`${dbName}\`.\`contacts\` TO 'yc_optdrop_rep'@'%'`);
    const r = await run(conn, quiet({ apply: true }));
    expect(r.ok).toBe(true);
    const orphan = await q("SELECT Column_name AS c FROM mysql.columns_priv WHERE Db = ? AND Table_name = 'contacts' AND User = 'yc_optdrop_rep' ORDER BY Column_name", [dbName]);
    expect(orphan.map((x) => x.c)).toEqual(['contact_email_optout', 'contact_id', 'contact_name', 'contact_sms_optout']);
    const u = new URL(URL_);
    const rep = await mysql.createConnection({ host: u.hostname, port: Number(u.port), user: 'yc_optdrop_rep', password: 'pw-optdrop-test', database: dbName }); // secret-scan: allow
    try {
      expect((await rep.query('SELECT contact_id, contact_name FROM contacts ORDER BY contact_id'))[0]).toHaveLength(2);
      await expect(rep.query('SELECT contact_sms_optout FROM contacts')).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
    } finally { await rep.end(); }
    // the targeted REVOKE clears the orphan although the column is gone
    await q(`REVOKE SELECT (\`contact_sms_optout\`, \`contact_email_optout\`) ON \`${dbName}\`.\`contacts\` FROM 'yc_optdrop_rep'@'%'`);
    expect((await q("SELECT Column_name AS c FROM mysql.columns_priv WHERE Db = ? AND User = 'yc_optdrop_rep' ORDER BY Column_name", [dbName])).map((x) => x.c))
      .toEqual(['contact_id', 'contact_name']);
    await q("DROP USER 'yc_optdrop_rep'@'%'");
  });
});
