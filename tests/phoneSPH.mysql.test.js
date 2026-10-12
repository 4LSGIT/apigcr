/**
 * REAL-ENGINE TWIN of the S-PH phone reads (tests/phoneSPH.routes.test.js runs
 * the same code over tests/helpers/phoneSPHWorld.js in CI): the migration
 * (applied TWICE — idempotence), the generated line_number column against
 * the world's lineOf(), every phoneCommsService read and the phone_line
 * branches of mailboxService on MySQL 8 with the production schema and
 * sql_mode — the engine's answers held to the world's on one seed
 * (SPH_SEED) — and the plans of the shipped query shapes.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * A THROWAWAY database whose name ends in _test (the suite deletes rows in
 * phone_event_log, phone_lines, channel_grants, contact_phones, credentials and
 * the users / contacts it seeds):
 *   mysql -uroot -e "CREATE DATABASE yc_sph_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
 *   mysql -uroot yc_sph_test < ref/database.sql
 *   mysql -uroot yc_sph_test < ref/migrations/2026-10-12_mailbox_s3r_alias.sql   # until the dump carries alias_of
 *   YC_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/yc_sph_test npx jest --runInBand tests/phoneSPH.mysql.test.js
 * The suite itself applies ref/migrations/2026-10-12_phone_sph.sql (twice).
 * Worker run 2026-10-12: MySQL 8.0.46, all green.
 *
 * Mutation-checked HERE (the world only matches statement TEXT):
 *   - the generated column's sides swapped / '=' → '<>'      → the attribution matrix
 *   - the seed's u.user_auth filter dropped (SU / disabled seeded)
 *                                                           → the migration test
 *   - the seed's NOT EXISTS dropped (re-run duplicates → ER_DUP_ENTRY) → the migration test
 *   - the index dropped / reordered (processed_at, line_number) → the plan test
 *   - the conversation GROUP BY on (other_party, direction)  → engine = world
 */

'use strict';

const fs = require('fs');
const path = require('path');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const MIGRATION = path.join(__dirname, '..', 'ref', 'migrations', '2026-10-12_phone_sph.sql');

maybe('S-PH phone reads on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const mbx = require('../services/mailboxService');
  const phone = require('../services/phoneCommsService');
  const { makeWorld, SPH_SEED, LINES, USERS, lineOf } = require('./helpers/phoneSPHWorld');

  let pool;
  let conn; // ONE connection for SET/PREPARE groups (multipleStatements)
  let W;
  let S;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const SEEDED_USERS = USERS.filter(u => u.user > 0).map(u => u.user);
  const FILLER_LINE = '2486213656'; // line 4 — engine-only volume for the plans, never compared

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    const cfg = {
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z',
    };
    pool = mysql.createPool({ ...cfg, connectionLimit: 4 });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
    await conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`);

    jest.spyOn(console, 'log').mockImplementation(() => {});
    await q('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['phone_event_log', 'phone_lines', 'channel_grants', 'contact_phones']) await q(`DELETE FROM ${t}`);
    await q('DELETE FROM credentials WHERE id IN (1, 2)');
    await q('DELETE FROM contacts WHERE contact_id IN (501, 502) OR contact_id >= 900000');
    await q(`DELETE FROM users WHERE user IN (${SEEDED_USERS.join(',')})`);
    await q("INSERT INTO credentials (id, name, type) VALUES (1, 'RC', 'oauth2'), (2, 'Quo', 'api_key')");
    for (const l of LINES) {
      await q(`INSERT INTO phone_lines (id, phone_number, display_name, provider, active, mms_capable, credential_id, provider_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [l.id, l.phone_number, l.display_name, l.provider, l.active, l.mms_capable, l.credential_id, l.provider_id]);
    }
    for (const x of USERS.filter(v => v.user > 0)) {
      await q(`INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, user_custom_tab, roles, default_phone)
               VALUES (?, ?, 1, ?, 'f', 'l', 'xx', ?, 0, '{}', ?, ?)`, [x.user, x.username, x.user_name, x.user_auth, x.roles, x.default_phone]);
    }
    // a DISABLED user whose default line exists: the seed must skip them
    await q(`INSERT INTO users (user, username, user_type, user_name, user_fname, user_lname, user_initials, user_auth, ringcentral, user_custom_tab, roles, default_phone)
             VALUES (8, 'gone', 1, 'Gone', 'f', 'l', 'xx', 'disabled', 0, '{}', 'staff', '2484179800')`);
    await q('SET FOREIGN_KEY_CHECKS = 1');
  });
  afterAll(async () => {
    if (conn) await conn.end();
    if (pool) {
      await q('DELETE FROM users WHERE user = 8').catch(() => {});
      await pool.end();
    }
  });

  test('the migration applies TWICE: column + index once, the seed exactly Stuart→1, sb→2, Rena→3', async () => {
    // back to the pre-S-PH schema first, so run 1 is a real first apply
    const has = async (kind, name) => Number((await q(kind === 'col'
      ? "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_event_log' AND COLUMN_NAME = ?"
      : "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_event_log' AND INDEX_NAME = ?", [name]))[0].n);
    if (await has('idx', 'idx_phone_event_line')) await q('ALTER TABLE phone_event_log DROP INDEX idx_phone_event_line');
    if (await has('col', 'line_number')) await q('ALTER TABLE phone_event_log DROP COLUMN line_number');
    expect([await has('col', 'line_number'), await has('idx', 'idx_phone_event_line')]).toEqual([0, 0]);
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await conn.query(sql);
    await conn.query(sql); // idempotence
    const [col] = await q(`SELECT COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS
                            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_event_log' AND COLUMN_NAME = 'line_number'`);
    expect(col.EXTRA).toBe('VIRTUAL GENERATED');
    expect(col.COLUMN_TYPE).toBe('varchar(32)');
    expect(col.GENERATION_EXPRESSION).toMatch(/if\(\(`direction` = _utf8mb4\\?'incoming\\?'\),`to_number`,`from_number`\)/);
    const idx = await q(`SELECT SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_event_log' AND INDEX_NAME = 'idx_phone_event_line' ORDER BY SEQ_IN_INDEX`);
    expect(idx.map(r => r.COLUMN_NAME)).toEqual(['line_number', 'processed_at']);
    const grants = await q(`SELECT user, channel_type, channel_id, can_read, can_send, can_manage, granted_by FROM channel_grants ORDER BY user`);
    expect(grants).toEqual([
      { user: 1, channel_type: 'phone_line', channel_id: 1, can_read: 1, can_send: 1, can_manage: 0, granted_by: 6 },
      { user: 5, channel_type: 'phone_line', channel_id: 2, can_read: 1, can_send: 1, can_manage: 0, granted_by: 6 },
      { user: 22, channel_type: 'phone_line', channel_id: 3, can_read: 1, can_send: 1, can_manage: 0, granted_by: 6 },
    ]);
    const [t] = await q(`SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_grants'`);
    expect(t.TABLE_COMMENT).toMatch(/phone_line rows since S-PH/);
    await q('DELETE FROM channel_grants'); // the comparisons below seed their own
  });

  test('seed both worlds; the generated column IS lineOf() on every row (NULL direction included)', async () => {
    W = makeWorld();
    S = SPH_SEED(W);
    for (const e of W.T.phone_event_log) {
      await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number, other_party, body, suppressed, log_id, raw_extra, processed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.provider, e.provider_ref, e.event_type, e.direction, e.from_number, e.to_number, e.other_party, e.body, e.suppressed, e.log_id, e.raw_extra, e.processed_at]);
    }
    // contact_name is maintained by a trigger from first + last name
    const contact = (id, name) => q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_lfm_name, contact_rname, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone)
                                     VALUES (?, 'person', 'Client', ?, ?, ?, ?, '', ?, '', '')`, [id, name, name, name, name.split(' ')[0], name.split(' ').slice(1).join(' ')]);
    for (const c of W.T.contacts) await contact(c.contact_id, c.contact_name);
    for (const cp of W.T.contact_phones) {
      await q('INSERT INTO contact_phones (contact_id, phone, end_date, start_date) VALUES (?, ?, ?, NULL)', [cp.contact_id, cp.phone, cp.end_date]);
    }
    const rows = await q('SELECT id, line_number FROM phone_event_log ORDER BY id');
    expect(rows.map(r => [r.id, r.line_number])).toEqual(W.T.phone_event_log.map(e => [e.id, lineOf(e)]));
  });

  test('ENGINE = WORLD: listReadable / listSendable / getAccess for SU, attorney, grantee, nobody', async () => {
    const g = [
      [1, 1, { can_read: 1, can_send: 1 }], [22, 3, { can_read: 1, can_send: 1 }], [22, 6, { can_send: 1 }], [22, 2, { can_manage: 1 }],
    ];
    for (const [user, line, f] of g) {
      W.grant(user, line, f);
      await q(`INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (?, 'phone_line', ?, ?, ?, ?, 6)`,
        [user, line, f.can_read || 0, f.can_send || 0, f.can_manage || 0]);
    }
    for (const user of [6, 1, 22, 9, 7]) {
      expect([user, await mbx.listReadable(pool, user, 'phone_line')]).toEqual([user, await mbx.listReadable(W.db, user, 'phone_line')]);
      expect([user, await mbx.listSendable(pool, user, 'phone_line')]).toEqual([user, await mbx.listSendable(W.db, user, 'phone_line')]);
      for (const line of [1, 2, 3, 6]) {
        expect([user, line, await mbx.getAccess(pool, user, 'phone_line', line)]).toEqual([user, line, await mbx.getAccess(W.db, user, 'phone_line', line)]);
      }
    }
    for (const user of [6, 1, 22, 9, 7]) {
      for (const party of ['3135550001', '3135550002', '3135550004', '22395', '9999999999']) {
        expect([user, party, await phone.firstSeen(pool, user, party)]).toEqual([user, party, await phone.firstSeen(W.db, user, party)]);
      }
    }
    for (const from of ['2485592400', '(248) 965-5355', '2484179800', '2480009999', 'x']) {
      for (const user of [6, 1, 22, 9]) {
        expect([from, user, await phone.staffSendGate(pool, user, from)]).toEqual([from, user, await phone.staffSendGate(W.db, user, from)]);
      }
    }
  });

  test('ENGINE = WORLD: conversations, one conversation, calls — every page', async () => {
    const lines = { 1: S.L1, 3: S.L3, 6: S.L6 };
    const pages = async (fn, db, ...args) => {
      const out = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await fn(db, ...args, { limit: 2, cursor });
        out.push(r);
        if (!r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return out;
    };
    // ?kind=sms (the Texts view): the same walk, texts only
    const sms = (fn) => (db, ...a) => fn(db, ...a.slice(0, -1), { ...a[a.length - 1], kind: 'sms' });
    for (const [id, num] of Object.entries(lines)) {
      const line = { id: Number(id), phone_number: num };
      expect([id, 'convos', await pages(phone.listConversations, pool, line)]).toEqual([id, 'convos', await pages(phone.listConversations, W.db, line)]);
      expect([id, 'texts', await pages(sms(phone.listConversations), pool, line)]).toEqual([id, 'texts', await pages(sms(phone.listConversations), W.db, line)]);
      expect([id, 'calls', await pages(phone.listCalls, pool, line)]).toEqual([id, 'calls', await pages(phone.listCalls, W.db, line)]);
      for (const party of [S.P1, S.P2, S.P3, S.P4, '22395', S.L1, S.L3]) {
        expect([id, party, await pages(phone.listMessages, pool, line, party)]).toEqual([id, party, await pages(phone.listMessages, W.db, line, party)]);
      }
    }
    // All numbers: every readable line at once, per user (SU, attorney, grantee, nobody)
    for (const user of [6, 1, 22, 9]) {
      expect([user, 'all-convos', await pages(phone.listAllConversations, pool, user)]).toEqual([user, 'all-convos', await pages(phone.listAllConversations, W.db, user)]);
      expect([user, 'all-texts', await pages(sms(phone.listAllConversations), pool, user)]).toEqual([user, 'all-texts', await pages(sms(phone.listAllConversations), W.db, user)]);
      expect([user, 'all-calls', await pages(phone.listAllCalls, pool, user)]).toEqual([user, 'all-calls', await pages(phone.listAllCalls, W.db, user)]);
      for (const party of [S.P1, S.P2, S.P3, S.P4, '22395', S.L1, S.L3]) {
        expect([user, party, await pages(phone.listAllMessages, pool, user, party)]).toEqual([user, party, await pages(phone.listAllMessages, W.db, user, party)]);
      }
    }
    const all = await phone.listAllConversations(pool, 6, {});
    expect(all.conversations.map(c => [c.other_party, c.count, c.line_ids])).toEqual([[S.P4, 1, [6]], [S.P1, 4, [1, 6]], [S.P2, 3, [1, 6]], ['22395', 1, [1]]]);
    // spot-check the engine's own answers (the world could be wrong in step)
    const c1 = await phone.listConversations(pool, { id: 1, phone_number: S.L1 }, {});
    expect(c1.conversations.map(c => [c.other_party, c.count])).toEqual([[S.P1, 3], ['22395', 1], [S.L3, 1], [S.P2, 2]]);
    // a line with no texts at all: every conversation is calls, `last` a call
    const c6 = await phone.listConversations(pool, { id: 6, phone_number: S.L6 }, {});
    expect(c6.conversations.map(c => [c.other_party, c.count, c.last.kind])).toEqual([[S.P4, 1, 'call'], [S.P2, 1, 'call'], [S.P1, 1, 'call']]);
    expect(c6.conversations[2].last).toMatchObject({ id: 10, missed: true, duration_s: 30 });
    expect(c1.conversations[0].contact).toEqual({ contact_id: 501, name: 'Pat One' });
    expect(c1.conversations.find(c => c.other_party === S.P2).contact).toBeNull();
    // one conversation = its texts AND its calls (the call's fields from raw_extra)
    const t2 = await phone.listMessages(pool, { id: 1, phone_number: S.L1 }, S.P2, {});
    expect(t2.messages.map(m => [m.id, m.kind])).toEqual([[3, 'call'], [4, 'sms']]);
    expect(t2.messages[0]).toMatchObject({ duration_s: 85, status: 'completed', unanswered: false, missed: false });
    const t6 = await phone.listMessages(pool, { id: 6, phone_number: S.L6 }, S.P1, {});
    expect(t6.messages).toEqual([expect.objectContaining({ id: 10, kind: 'call', missed: true, duration_s: 30 })]);
  });

  test('plans: the per-line walks use idx_phone_event_line (backward, no filesort); the contact probe uses uk_phone_active', async () => {
    // engine-only volume on line 4 + orphans so the optimizer sees a realistic table
    const filler = [];
    for (let i = 0; i < 4000; i++) {
      const incoming = i % 2 === 0;
      const party = `31399${String(i % 300).padStart(5, '0')}`;
      // ~40% on line 4, the rest on ten other numbers (live: the biggest line holds ~48% of rows)
      const line = i % 5 < 2 ? FILLER_LINE : `73446633${String(i % 10).padStart(2, '0')}`;
      filler.push(['quo', `f${i}`, i % 3 ? 'sms' : 'call', incoming ? 'incoming' : 'outgoing', incoming ? party : line, incoming ? line : party, party,
        'filler', 0, new Date(Date.parse('2026-06-01T00:00:00Z') + i * 60_000)]);
    }
    await q('INSERT INTO phone_event_log (provider, provider_ref, event_type, direction, from_number, to_number, other_party, body, suppressed, processed_at) VALUES ?', [filler]);
    const cps = [];
    for (let i = 0; i < 1500; i++) cps.push([900000 + i, `248777${String(i).padStart(4, '0')}`]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_type, contact_name, contact_lfm_name, contact_rname, contact_fname, contact_mname, contact_lname, contact_pname, contact_phone) VALUES ?`,
      [cps.map(([id]) => [id, 'person', 'Client', `Filler ${id}`, `Filler ${id}`, `Filler ${id}`, 'f', '', 'l', '', ''])]);
    await q('INSERT INTO contact_phones (contact_id, phone) VALUES ?', [cps]);
    await q('ANALYZE TABLE phone_event_log, contact_phones');

    // EXPLAIN the EXACT statements the service issues (recorded, not retyped).
    const recorded = [];
    const rec = { query: (sql, p) => { recorded.push([sql, p]); return pool.query(sql, p); } };
    const plansOf = async (fn) => {
      recorded.length = 0;
      await fn();
      const out = [];
      for (const [sql, p] of recorded) {
        const rows = await q(`EXPLAIN ${sql}`, p);
        out.push({ sql: sql.replace(/\s+/g, ' ').trim(), plan: rows[0] });
      }
      return out;
    };
    const line4 = { id: 4, phone_number: FILLER_LINE };
    const mid = phone.cursorOf({ processed_at: new Date('2026-06-02T09:00:00Z'), id: 2500 });
    const late = phone.cursorOf({ processed_at: new Date('2026-07-01T00:00:00Z'), id: 999999 }); // past every row — the case the optimizer got wrong unforced
    for (const cursor of [undefined, mid, late]) {
      const [walk] = await plansOf(() => phone.listCalls(rec, line4, { cursor }));
      expect([cursor, walk.plan.key, walk.plan.Extra.includes('filesort')]).toEqual([cursor, 'idx_phone_event_line', false]);
      expect(walk.plan.Extra).toMatch(/Backward index scan/);
    }
    const convo = await plansOf(() => phone.listConversations(rec, line4, {}));
    expect(convo[0].sql).toMatch(/^SELECT other_party, MAX\(id\)/);
    expect(convo[0].plan.key).toBe('idx_phone_event_line');
    expect(convo[1].sql).toMatch(/WHERE id IN \(\?\)$/);
    expect(convo[1].plan.key).toBe('PRIMARY');
    const contactProbe = convo.find((x) => /contact_phones/.test(x.sql));
    expect(contactProbe.plan.key).toBe('uk_phone_active');
    const [one] = await plansOf(() => phone.listMessages(rec, line4, '3139900001', {}));
    expect(['idx_phone_event_other_party', 'idx_phone_event_line']).toContain(one.plan.key);
    expect(one.plan.type).not.toBe('ALL');
    // the contact probe on a page of filler numbers (the uk_phone_active range)
    const [cp] = await plansOf(() => phone.contactsFor(rec, ['2487770001', '2487770002', '2487770003']));
    expect(cp.plan.key).toBe('uk_phone_active');
    const [size] = await q(`SELECT stat_value * @@innodb_page_size AS bytes FROM mysql.innodb_index_stats
                             WHERE database_name = DATABASE() AND table_name = 'phone_event_log' AND index_name = 'idx_phone_event_line' AND stat_name = 'size'`);
    expect(Number(size.bytes)).toBeLessThan(2 * 1024 * 1024);
  });
});
