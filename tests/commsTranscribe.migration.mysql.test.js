/**
 * REAL-ENGINE test for the S2 session-script migration
 * (scripts/commsTranscribeS2Migrate.js) and its record
 * (ref/migrations/2026-10-14_comms_s2_transcripts.sql):
 *   R  the record file's Part A is exactly what the script runs, in order;
 *   C  CHECK is read-only; --apply creates, seeds (never clobbering an edited
 *      value), re-comments comms_media with INSTANT (TABLE_ID unchanged, every
 *      other column untouched); a re-run is ALREADY APPLIED;
 *   D  the definition guard: a drifted column definition or a comment that is
 *      neither the S1 nor the S2 text is a NO-GO with nothing changed;
 *   L  lock_wait_timeout: an ALTER queued behind an open transaction gives up
 *      in seconds (NO-GO, resumable) instead of stalling the table;
 *   B  Part B (the job row) is idempotent.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_comms_s2_test npx jest tests/commsTranscribe.migration.mysql.test.js --runInBand
 */

'use strict';

const fs = require('fs');
const path = require('path');

const URL_  = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const RECORD = path.join(__dirname, '..', 'ref', 'migrations', '2026-10-14_comms_s2_transcripts.sql');

const m = require('../scripts/commsTranscribeS2Migrate');

describe('R: the record file is what the script runs', () => {
  test('Part A of the .sql = partASql(), in order', () => {
    const txt = fs.readFileSync(RECORD, 'utf8');
    const a = txt.slice(txt.indexOf('PART A — before the backend'), txt.indexOf('PART B — AFTER the backend is live'));
    let at = 0;
    for (const stmt of m.partASql()) {
      const i = a.indexOf(stmt, at);
      expect({ stmt: stmt.slice(0, 60), found: i >= 0 }).toEqual({ stmt: stmt.slice(0, 60), found: true });
      at = i + stmt.length;
    }
  });
  test('the cap seed is 7500 (Fred, 2026-10-14) and mode seeds off', () => {
    expect(m.CAP_SEED_CENTS).toBe(7500);
    expect(m.SETTINGS.find(s => s[0] === 'comms_ai_monthly_cap_cents')[1]).toBe('7500');
    expect(m.SETTINGS.find(s => s[0] === 'comms_transcribe_mode')[1]).toBe('off');
    // the seeded description says what off really does (in-flight jobs finish — the sweep's S4 rule)
    const modeText = m.SETTINGS.find(s => s[0] === 'comms_transcribe_mode')[6];
    expect(modeText).toMatch(/off: no NEW submissions — jobs already sent are still polled, stored and deleted/);
    expect(modeText).not.toMatch(/nothing is submitted or polled/);
    expect(m.SQL.alterComments).toMatch(/ALGORITHM=INSTANT$/);
  });
});

maybe('the S2 migration on real MySQL', () => {
  const mysql  = require('mysql2/promise');
  const schema = require('./helpers/commsArchiveSchema');
  let pool, conn;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const quiet = { say: () => {} };
  const cols = () => q(`SELECT COLUMN_NAME n, ORDINAL_POSITION p, COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLLATION_NAME c, EXTRA e, COLUMN_COMMENT cm
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comms_media' ORDER BY ORDINAL_POSITION`);
  const tableId = async () => (await q("SELECT TABLE_ID AS id FROM information_schema.INNODB_TABLES WHERE NAME = CONCAT(DATABASE(), '/comms_media')"))[0].id;
  const exists = async (t) => (await q('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]))[0].n === 1;

  async function fresh() {
    for (const t of ['comms_transcripts', 'comms_stt_jobs', 'comms_no_transcribe']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await schema.build(pool, ['app_settings', 'scheduled_jobs']);
    for (const s of schema.migrationStatements('2026-10-14_comms_media.sql')) await pool.query(s);
  }

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.on('connection', (c) => { c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`); });
  });
  afterAll(async () => { if (conn) conn.release(); await pool.end(); });
  beforeEach(async () => { if (conn) conn.release(); await fresh(); conn = await pool.getConnection(); });

  test('C1 CHECK changes nothing; APPLY does it all; a re-run is ALREADY APPLIED', async () => {
    const before = await cols();
    const id0 = await tableId();
    const c = await m.run(conn, quiet);
    expect(c).toMatchObject({ ok: true, line: expect.stringMatching(/^CHECK OK — GO/) });
    expect(await exists('comms_transcripts')).toBe(false);
    expect(await cols()).toEqual(before);

    // an edited value is never clobbered
    await q("INSERT INTO app_settings (`key`, `value`) VALUES ('comms_transcribe_mode', 'sample')");
    const a = await m.run(conn, { ...quiet, apply: true });
    expect(a).toMatchObject({ ok: true, line: expect.stringMatching(/^S2 PART A APPLIED — GO/) });
    expect(await exists('comms_transcripts')).toBe(true);
    expect(await exists('comms_stt_jobs')).toBe(true);
    expect(await exists('comms_no_transcribe')).toBe(true);
    const settings = Object.fromEntries((await q("SELECT `key`, `value` FROM app_settings")).map(r => [r.key, r.value]));
    expect(settings).toMatchObject({
      comms_transcribe_mode: 'sample', comms_stt_credential_id: '14', comms_min_transcribe_s: '15',
      comms_stt_max_min_per_call: '300', comms_ai_monthly_cap_cents: '7500', comms_stt_quo_stereo: 'diarize',
      comms_stt_keyterms: '[]', comms_stt_language_detection: '1',
    });

    // comments only: every other attribute of every column identical, no rebuild
    const after = await cols();
    expect(await tableId()).toBe(id0);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      const { cm: cb, ...b } = before[i];
      const { cm: ca, ...x } = after[i];
      expect(x).toEqual(b);
      if (m.NEW_COMMENTS[b.n] !== undefined) expect(ca).toBe(m.NEW_COMMENTS[b.n]);
      else expect(ca).toBe(cb);
    }
    expect(after.find(c2 => c2.n === 'kind').cm).toMatch(/voicemail/);

    expect(await m.run(conn, { ...quiet, apply: true })).toMatchObject({ ok: true, line: expect.stringMatching(/^ALREADY APPLIED/) });
    expect(await m.run(conn, quiet)).toMatchObject({ ok: true, line: expect.stringMatching(/^ALREADY APPLIED/) });
  });

  test('C2 resumes from a half-applied state (tables exist, comments not yet)', async () => {
    await q(m.SQL.createTranscripts);
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r.ok).toBe(true);
    expect(r.done).not.toContain('comms_transcripts');
    expect(r.done).toContain('comms_media comments');
  });

  test('D1 a drifted column definition is a NO-GO and NOTHING changes', async () => {
    await q("ALTER TABLE comms_media MODIFY duration_s BIGINT UNSIGNED NULL COMMENT 'media duration; NULL until known (S1a does not fetch it)'");
    const before = await cols();
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r).toMatchObject({ ok: false, line: expect.stringMatching(/^NO-GO/) });
    expect(r.plan.problems.join('\n')).toMatch(/duration_s definition differs/);
    expect(await exists('comms_transcripts')).toBe(false);
    expect(await cols()).toEqual(before);
  });

  test('D1b a collation drift alone (same type, same comment) is a NO-GO', async () => {
    await q("ALTER TABLE comms_media MODIFY kind VARCHAR(20) COLLATE utf8mb4_bin NOT NULL COMMENT 'call_recording | mms_file | stt_raw | mail_raw | mail_attachment — app-validated'");
    const r = await m.run(conn, { ...quiet, apply: true });
    expect(r.ok).toBe(false);
    expect(r.plan.problems.join('\n')).toMatch(/kind definition differs .*collation utf8mb4_bin/);
    expect(await exists('comms_transcripts')).toBe(false);
  });

  test('D1c a default drift alone is a NO-GO', async () => {
    await q(`ALTER TABLE comms_media MODIFY part VARCHAR(64) NOT NULL DEFAULT 'x' COMMENT '${m.OLD_COMMENTS.part.replace(/'/g, "''")}'`);
    const r = await m.run(conn, quiet);
    expect(r.ok).toBe(false);
    expect(r.plan.problems.join('\n')).toMatch(/part definition differs .*default/);
  });

  test('D2 a comment that is neither the S1 nor the S2 text is a NO-GO', async () => {
    await q("ALTER TABLE comms_media MODIFY part VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'someone else wrote this'");
    const r = await m.run(conn, quiet);
    expect(r.ok).toBe(false);
    expect(r.plan.problems.join('\n')).toMatch(/part comment is neither/);
  });

  test('D3 a foreign comms_transcripts / comms_stt_jobs table is a NO-GO', async () => {
    await q('CREATE TABLE comms_transcripts (id INT PRIMARY KEY)');
    let r = await m.run(conn, { ...quiet, apply: true });
    expect(r.ok).toBe(false);
    expect(r.plan.problems.join('\n')).toMatch(/comms_transcripts exists with different columns/);
    await q('DROP TABLE comms_transcripts');
    await q('CREATE TABLE comms_stt_jobs (id INT PRIMARY KEY)');
    r = await m.run(conn, { ...quiet, apply: true });
    expect(r.ok).toBe(false);
    expect(r.plan.problems.join('\n')).toMatch(/comms_stt_jobs exists with different columns/);
  });

  test('D4 the end-state check: any OTHER comms_media change seen after the ALTER is a NO-GO', async () => {
    // Something else alters the table between the ALTER and the verify (the say hook runs there).
    const lines = [];
    const r = await m.run(conn, {
      apply: true,
      say: (line) => {
        lines.push(line);
        if (/comms_media comments \(INSTANT\)/.test(line)) {
          return pool.query("ALTER TABLE comms_media MODIFY mime VARCHAR(128) NULL COMMENT 'changed behind our back'");
        }
        return undefined;
      },
    });
    expect(r).toMatchObject({ ok: false, line: expect.stringMatching(/^NO-GO — the end state is wrong/) });
    expect(lines.join('\n')).toMatch(/mime comment changed \(not in this migration\)/);
  });

  test('L1 an open transaction on comms_media: the ALTER gives up in ~5 s (NO-GO, resumable), then completes', async () => {
    const holder = await pool.getConnection();
    try {
      await holder.query('START TRANSACTION');
      await holder.query('SELECT COUNT(*) FROM comms_media');          // holds a shared metadata lock
      const t0 = Date.now();
      const r = await m.run(conn, { ...quiet, apply: true });
      const took = Date.now() - t0;
      expect(r).toMatchObject({ ok: false, line: expect.stringMatching(/^NO-GO — stopped after: .*Re-running --apply resumes/) });
      expect(r.done).toEqual(expect.arrayContaining(['comms_transcripts', 'comms_no_transcribe']));
      expect(took).toBeLessThan(15_000);
      expect(took).toBeGreaterThanOrEqual(4_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await m.run(conn, { ...quiet, apply: true })).toMatchObject({ ok: true, line: expect.stringMatching(/APPLIED — GO/) });
  }, 30_000);

  test('B1 Part B: the job row, idempotent', async () => {
    await m.run(conn, { ...quiet, apply: true });
    const txt = fs.readFileSync(RECORD, 'utf8');
    const banner = txt.indexOf('PART B — AFTER the backend is live');
    const partB = txt.slice(txt.indexOf('\n', banner) + 1);
    const stmts = partB.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
    expect(stmts.length).toBe(1);
    await q(stmts[0]);
    await q(stmts[0]);
    const rows = await q("SELECT name, recurrence_rule, max_attempts, data FROM scheduled_jobs WHERE idempotency_key = 'comms_transcribe_sweep'");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ recurrence_rule: '*/2 * * * *', max_attempts: 1 });
    const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    expect(data).toEqual({ type: 'internal_function', params: {}, function_name: 'comms_transcribe_sweep' });
  });
});
