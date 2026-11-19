// Own local *_test DB only (YC_TEST_MYSQL_URL; give this twin its own DB — it
// drops and rebuilds booking_views). Runs scripts/bookingRedirectColumn.js
// against a real MySQL 8.4: the information_schema shape read, the INSTANT
// ALTER at a named position, the session lock_wait_timeout, and the rerun.
//
// booking_views is built from ref/database.sql as it stands, so the twin
// follows the schema: before the migration has run live, the dump lacks the
// column (the script adds it); after, the dump carries it and the twin drops
// it first to replay the migration.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const script = require('../scripts/bookingRedirectColumn');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;

function bookingViewsDdl() {
  // Line-based: column COMMENTs carry ';', so a regex to ENGINE=…; truncates.
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('CREATE TABLE `booking_views`'));
  if (start < 0) throw new Error('booking_views missing from ref/database.sql');
  const end = lines.findIndex((l, i) => i > start && /^\) ENGINE=.*;$/.test(l));
  return lines.slice(start, end + 1).join('\n');
}

suite('scripts/bookingRedirectColumn.js — real engine', () => {
  let conn;
  const quiet = () => {};
  const shape = async () => {
    const [rows] = await conn.query(
      `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_COMMENT AS comment, ORDINAL_POSITION AS pos
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_views' AND COLUMN_NAME IN ('thankyou_html', 'redirect_url')
        ORDER BY ORDINAL_POSITION`);
    return rows;
  };

  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    conn = await mysql.createConnection({ uri: URL_, timezone: 'Z' });
  });
  afterAll(async () => { if (conn) await conn.end(); });

  beforeEach(async () => {
    await conn.query('DROP TABLE IF EXISTS booking_views');
    await conn.query(bookingViewsDdl());
    const [[has]] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'booking_views' AND COLUMN_NAME = 'redirect_url'`);
    if (Number(has.n)) await conn.query('ALTER TABLE booking_views DROP COLUMN redirect_url');
    await conn.query(
      `INSERT INTO booking_views (slug, title, provider_mode, provider_ids, appt_type, appt_length, thankyou_html)
       VALUES ('consult', 'C', 'fixed_one', '[1]', 'Consultation', 30, '<p>t</p>'),
              ('random', 'R', 'fixed_one', '[1]', 'Test', 15, NULL)`);
  });

  test('CHECK writes nothing and says GO', async () => {
    const log = [];
    await expect(script.run(conn, { apply: false, log: (l) => log.push(l) })).resolves.toEqual({ ok: true });
    expect((await shape()).map((r) => r.type)).toEqual(['text']);
    expect(log.join('\n')).toMatch(/redirect_url: to add[\s\S]*GO — CHECK passed, nothing written/);
  });

  test('--apply adds the column right after thankyou_html, exact shape, every row NULL, rows kept', async () => {
    const log = [];
    await script.run(conn, { apply: true, log: (l) => log.push(l) });
    const [ty, rd] = await shape();
    expect(rd).toMatchObject({ type: 'varchar(500)', nullable: 'YES', dflt: null, comment: script.COMMENT });
    expect(Number(rd.pos)).toBe(Number(ty.pos) + 1);
    const [rows] = await conn.query('SELECT slug, redirect_url FROM booking_views ORDER BY slug');
    expect(rows).toEqual([{ slug: 'consult', redirect_url: null }, { slug: 'random', redirect_url: null }]);
    expect(log.join('\n')).toMatch(/✓ added redirect_url[\s\S]*GO — column live/);
    // the ALTER ran under the short lock wait, not the year-long global default
    const [[s]] = await conn.query('SELECT @@SESSION.lock_wait_timeout AS t');
    expect(Number(s.t)).toBe(5);
  });

  test('a rerun after --apply does nothing and says GO', async () => {
    await script.run(conn, { apply: true, log: quiet });
    const log = [];
    await expect(script.run(conn, { apply: true, log: (l) => log.push(l) })).resolves.toEqual({ ok: true });
    expect(log.join('\n')).toMatch(/already there[\s\S]*GO — nothing left to do/);
  });

  test('a column of the wrong shape is a NO-GO, never silently accepted', async () => {
    await conn.query("ALTER TABLE booking_views ADD COLUMN redirect_url varchar(200) NULL");
    await expect(script.run(conn, { apply: true, log: quiet })).rejects.toThrow(/wrong shape/);
  });

  test('the column round-trips a 500-character https URL', async () => {
    await script.run(conn, { apply: true, log: quiet });
    const url = 'https://example.com/' + 'a'.repeat(480);
    expect(url.length).toBe(500);
    await conn.query("UPDATE booking_views SET redirect_url = ? WHERE slug = 'consult'", [url]);
    const [[r]] = await conn.query("SELECT redirect_url FROM booking_views WHERE slug = 'consult'");
    expect(r.redirect_url).toBe(url);
  });
});
