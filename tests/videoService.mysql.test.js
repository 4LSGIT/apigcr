// tests/videoService.mysql.test.js
//
/**
 * videoService on REAL MySQL — the case a view attaches to, Avg watch, and
 * the related-video access filter.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_video_test npx jest tests/videoService.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * videos, video_views, cases, case_relate, contacts and users in it (the
 * columns these queries read, production types).
 *
 * WHAT IS LOCKED (what a fake db cannot prove)
 *   - resolveCaseIdForContact ranks any active stage over Concluded over
 *     Closed, newest open date first within a rank, whatever order the rows
 *     went in, and ignores a case the contact is not Primary on. Open alone
 *     missed every Filed client.
 *   - recordView stores that case.
 *   - avg_completion_pct averages played views only: AVG(CASE ...) over the
 *     real NULLs, not the 0 an unplayed row would drag in.
 *   - publicOnly filters both the hand-picked and the tag auto-fill lookup.
 *   - track_token is stored, compared case-sensitively through a _bin column,
 *     and a NULL (a view from before tokens) always refuses.
 *   - recordProgress claims completed_at exactly once, at the threshold, however
 *     many beacons arrive, and the claim keeps the first timestamp.
 *   - Completed counts completed_at, so a scrub to 100% position cannot count.
 *   - listViews: its joins, what it hides by default, firm-local days, LIKE
 *     escaping and paging, and that with automated opens shown it adds up to
 *     the analytics panel (the panel's "See who watched" promises that).
 *   - recordView survives two opens at once: the foreign key's shared lock used
 *     to deadlock them and lose one.
 *   - The video.* events: once per view (per button for a click), only for a
 *     verified contact, never for an excluded view, and first_for_contact
 *     ignores other people, other videos and excluded views.
 *   - video_watch_status counts what a person did, not scanners or exclusions.
 *   - resolveViewCase: a case named on the link only counts for someone on it, a
 *     guess is certain only without a tie, and the stored id comes back.
 *   - first_for_case tells a second bankruptcy from the first.
 *   - setViewExcluded moves the stats and view_count once, however many times
 *     it runs, and leaves the counter alone for a view a reset already took off.
 */
'use strict';

const mysql = require('mysql2/promise');
const videoService = require('../services/videoService');
const domainEvents = require('../lib/domainEvents');
const videoFns = require('../lib/internal_functions/video');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('videoService on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const TABLES = ['video_views', 'video_slug_aliases', 'videos', 'case_relate', 'cases', 'contacts', 'users'];

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 4, timezone: 'Z' });
    pool.withTransaction = async (fn) => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    };
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE cases (
      case_id varchar(20) NOT NULL PRIMARY KEY,
      case_number varchar(50) DEFAULT NULL,
      case_stage enum('Open','Pending','Filed','Concluded','Closed') NOT NULL DEFAULT 'Open',
      case_open_date date DEFAULT NULL)`);
    await q(`CREATE TABLE case_relate (
      case_relate_id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      case_relate_case_id varchar(20) NOT NULL,
      case_relate_client_id int NOT NULL,
      case_relate_type varchar(20) NOT NULL)`);
    await q(`CREATE TABLE contacts (
      contact_id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contact_name varchar(255) DEFAULT NULL)`);
    await q(`CREATE TABLE users (
      user tinyint NOT NULL PRIMARY KEY,
      user_name varchar(20) NOT NULL)`);
    await q(`CREATE TABLE videos (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug varchar(64) NOT NULL UNIQUE, title varchar(255) NOT NULL,
      gcs_poster_url varchar(1024) DEFAULT NULL, gcs_gif_url varchar(1024) DEFAULT NULL,
      tags json DEFAULT NULL, related_video_ids json DEFAULT NULL,
      access_level enum('public','contact_only') NOT NULL DEFAULT 'public',
      is_published tinyint(1) NOT NULL DEFAULT '0',
      view_count int NOT NULL DEFAULT '0', analytics_reset_at timestamp NULL DEFAULT NULL)`);
    await q(`CREATE TABLE video_slug_aliases (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      video_id int NOT NULL, slug varchar(64) NOT NULL UNIQUE,
      archived_at timestamp NULL DEFAULT CURRENT_TIMESTAMP)`);
    await q(`CREATE TABLE video_views (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
      video_id int NOT NULL, contact_id int DEFAULT NULL, case_id varchar(20) DEFAULT NULL,
      ip_hash char(64) DEFAULT NULL, user_agent varchar(255) DEFAULT NULL,
      opened_at timestamp NULL DEFAULT CURRENT_TIMESTAMP, played_at timestamp NULL DEFAULT NULL,
      watch_seconds int NOT NULL DEFAULT '0', completion_pct tinyint NOT NULL DEFAULT '0',
      cta_clicks json DEFAULT NULL,
      track_token char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
      completed_at timestamp NULL DEFAULT NULL,
      excluded_at timestamp NULL DEFAULT NULL,
      excluded_by int DEFAULT NULL,
      contact_verified tinyint(1) NOT NULL DEFAULT '0',
      CONSTRAINT fk_video_views_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE)`);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    for (const t of TABLES) await q(`DELETE FROM \`${t}\``);
  });

  async function givePrimary(contactId, rows, type = 'Primary') {
    for (const [caseId, stage, opened] of rows) {
      await q('INSERT INTO cases (case_id, case_stage, case_open_date) VALUES (?, ?, ?)', [caseId, stage, opened]);
      await q(
        'INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)',
        [caseId, contactId, type],
      );
    }
  }

  describe('resolveCaseIdForContact', () => {
    test.each([
      ['Filed, the stage Open alone missed', [['A', 'Filed', '2026-01-01']], 'A'],
      ['Pending', [['A', 'Pending', '2026-01-01']], 'A'],
      ['Concluded alone', [['A', 'Concluded', '2026-01-01']], 'A'],
      ['Closed alone', [['A', 'Closed', '2026-01-01']], 'A'],
      ['a newer Closed never beats an older Filed',
        [['OLD', 'Filed', '2020-01-01'], ['NEW', 'Closed', '2026-01-01']], 'OLD'],
      ['a newer Concluded never beats an older Open',
        [['OLD', 'Open', '2020-01-01'], ['NEW', 'Concluded', '2026-01-01']], 'OLD'],
      ['a newer Concluded never beats an older Pending',
        [['OLD', 'Pending', '2020-01-01'], ['NEW', 'Concluded', '2026-01-01']], 'OLD'],
      ['Concluded beats a newer Closed',
        [['OLD', 'Concluded', '2020-01-01'], ['NEW', 'Closed', '2026-01-01']], 'OLD'],
      ['the active stages tie, so the newest wins',
        [['OLD', 'Open', '2020-01-01'], ['NEW', 'Filed', '2026-01-01']], 'NEW'],
      ['a dated case beats an undated one in the same rank',
        [['UNDATED', 'Filed', null], ['DATED', 'Filed', '2020-01-01']], 'DATED'],
    ])('%s', async (_name, rows, want) => {
      await givePrimary(1, rows);
      expect(await videoService.resolveCaseIdForContact(pool, 1)).toBe(want);
    });

    test('a case the contact is not Primary on never attaches', async () => {
      await givePrimary(1, [['A', 'Open', '2026-01-01']], 'Secondary');
      expect(await videoService.resolveCaseIdForContact(pool, 1)).toBeNull();
    });

    test('another contact\'s case never attaches', async () => {
      await givePrimary(2, [['A', 'Open', '2026-01-01']]);
      expect(await videoService.resolveCaseIdForContact(pool, 1)).toBeNull();
    });

    test('anonymous resolves to null without a query', async () => {
      expect(await videoService.resolveCaseIdForContact(pool, null)).toBeNull();
    });
  });

  test('recordView stores the resolved case and bumps the counter', async () => {
    await givePrimary(1, [['F', 'Filed', '2026-01-01']]);
    await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'a', 'A', 1)`);
    const { viewId } = await videoService.recordView(pool, { videoId: 1, contactId: 1, ipHash: 'x', userAgent: 'ua' });
    const [row] = await q('SELECT case_id FROM video_views WHERE id = ?', [viewId]);
    expect(row.case_id).toBe('F');
    const [v] = await q('SELECT view_count FROM videos WHERE id = 1');
    expect(v.view_count).toBe(1);
  });

  describe('track_token', () => {
    let viewId, trackToken;
    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'a', 'A', 1)`);
      ({ viewId, trackToken } = await videoService.recordView(pool, { videoId: 1, contactId: null, ipHash: 'x', userAgent: 'ua' }));
    });
    const check = (token, videoId = 1, id = viewId) => videoService.checkTrackToken(pool, { viewId: id, videoId, token });

    test('recordView stores what it returns', async () => {
      const [row] = await q('SELECT track_token FROM video_views WHERE id = ?', [viewId]);
      expect(row.track_token).toBe(trackToken);
      expect(trackToken).toMatch(/^[0-9A-Za-z]{22}$/);
    });

    test('the right token passes', async () => {
      expect(await check(trackToken)).toBe(true);
    });

    test('a token differing only by case refuses', async () => {
      const flipped = trackToken.replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      expect(flipped).not.toBe(trackToken);
      expect(await check(flipped)).toBe(false);
    });

    test.each([['missing', undefined], ['empty', ''], ['a number', 7], ['the wrong length', 'short']])('%s refuses', async (_n, t) => {
      expect(await check(t)).toBe(false);
    });

    test('another view\'s token refuses', async () => {
      const other = await videoService.recordView(pool, { videoId: 1, contactId: null, ipHash: 'x', userAgent: 'ua' });
      expect(await check(other.trackToken)).toBe(false);
    });

    test('the right token on the wrong video refuses', async () => {
      expect(await check(trackToken, 2)).toBe(false);
    });

    test('a view from before tokens holds NULL and refuses', async () => {
      await q('UPDATE video_views SET track_token = NULL WHERE id = ?', [viewId]);
      expect(await check(trackToken)).toBe(false);
    });
  });

  describe('recordProgress claims completed_at', () => {
    let viewId;
    const progress = (watchSeconds, completionPct) => videoService.recordProgress(pool, { viewId, videoId: 1, watchSeconds, completionPct });
    const row = async () => (await q('SELECT watch_seconds, completion_pct, completed_at FROM video_views WHERE id = ?', [viewId]))[0];

    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'a', 'A', 1)`);
      ({ viewId } = await videoService.recordView(pool, { videoId: 1, contactId: null, ipHash: 'x', userAgent: 'ua' }));
    });

    test('the line is 90%', () => {
      expect(videoService.COMPLETE_PCT).toBe(90);
    });

    test('below the line claims nothing', async () => {
      expect(await progress(50, videoService.COMPLETE_PCT - 1)).toEqual({ completedNow: false });
      expect((await row()).completed_at).toBeNull();
    });

    test('at the line claims', async () => {
      expect(await progress(50, videoService.COMPLETE_PCT)).toEqual({ completedNow: true });
      expect((await row()).completed_at).not.toBeNull();
    });

    test('only the first beacon past the line claims, and its time stands', async () => {
      await progress(90, 95);
      await q(`UPDATE video_views SET completed_at = '2026-01-01 00:00:00' WHERE id = ?`, [viewId]);
      expect(await progress(100, 100)).toEqual({ completedNow: false });
      expect((await row()).completed_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    test('racing beacons claim once', async () => {
      const out = await Promise.all([1, 2, 3, 4].map(() => progress(95, 95)));
      expect(out.filter((r) => r.completedNow)).toHaveLength(1);
    });

    test('a later smaller beacon regresses nothing and claims nothing', async () => {
      await progress(40, 40);
      expect(await progress(10, 10)).toEqual({ completedNow: false });
      const r = await row();
      expect([r.watch_seconds, r.completion_pct]).toEqual([40, 40]);
    });

    test('another video\'s id claims nothing', async () => {
      const out = await videoService.recordProgress(pool, { viewId, videoId: 2, watchSeconds: 100, completionPct: 100 });
      expect(out).toEqual({ completedNow: false });
      expect((await row()).completion_pct).toBe(0);
    });
  });

  test('Completed counts completed_at, not a 100% position', async () => {
    await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'a', 'A', 1)`);
    await q(`INSERT INTO video_views (video_id, played_at, completion_pct, completed_at) VALUES
      (1, NOW(), 100, NULL), (1, NOW(), 95, NOW()), (1, NOW(), 92, NOW())`);
    expect((await videoService.getVideoAnalytics(pool, 1)).completed_count).toBe(2);
  });

  describe('getVideoAnalytics avg_completion_pct', () => {
    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'a', 'A', 1)`);
    });

    test('averages played views only', async () => {
      await q(`INSERT INTO video_views (video_id, played_at, completion_pct) VALUES
        (1, NOW(), 100), (1, NOW(), 50), (1, NULL, 0), (1, NULL, 0), (1, NULL, 0)`);
      const a = await videoService.getVideoAnalytics(pool, 1);
      expect(a.total_views).toBe(5);
      expect(a.avg_completion_pct).toBe(75);
    });

    test('no plays reads 0, not NaN', async () => {
      await q(`INSERT INTO video_views (video_id, played_at, completion_pct) VALUES (1, NULL, 0)`);
      const a = await videoService.getVideoAnalytics(pool, 1);
      expect(a.avg_completion_pct).toBe(0);
    });
  });

  describe('recordView under two opens at once', () => {
    // Holds each transaction after its first write until the other has made
    // its own, or until the wait runs out. Two opens have to overlap for the
    // deadlock to exist, and run plainly they finish too fast to. The wait has
    // to end: with the order right, the second open is queued behind the first.
    function holdAfterFirstWrite() {
      const real = pool.withTransaction;
      let written = 0;
      pool.withTransaction = (fn) => real(async (conn) => {
        let held = false;
        return fn({
          query: async (sql, params) => {
            const out = await conn.query(sql, params);
            if (!held && /^\s*(UPDATE|INSERT)/i.test(sql)) {
              held = true;
              written += 1;
              const until = Date.now() + 250;
              while (written < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
            }
            return out;
          },
        });
      });
      return () => { pool.withTransaction = real; };
    }

    test('every open is recorded and counted', async () => {
      await q(`INSERT INTO videos (id, slug, title, view_count) VALUES (1, 'one', 'One', 0)`);
      const release = holdAfterFirstWrite();
      const open = () => videoService.recordView(pool, {
        videoId: 1, contactId: null, ipHash: null, userAgent: 'scanner',
      });
      const results = await Promise.allSettled([open(), open()]).finally(release);
      expect(results.map((r) => r.reason && r.reason.code)).toEqual([undefined, undefined]);
      const [{ n }] = await q('SELECT COUNT(*) AS n FROM video_views');
      const [{ view_count: count }] = await q('SELECT view_count FROM videos WHERE id = 1');
      expect(Number(n)).toBe(2);
      expect(count).toBe(2);
    });
  });

  describe('getRelatedVideos publicOnly', () => {
    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, is_published, tags, related_video_ids, access_level) VALUES
        (1, 'src',  'Src',  1, '["t"]', '[2,3]', 'public'),
        (2, 'hand-pub', 'P', 1, NULL, NULL, 'public'),
        (3, 'hand-gated', 'G', 1, NULL, NULL, 'contact_only'),
        (4, 'tag-pub', 'TP', 1, '["t"]', NULL, 'public'),
        (5, 'tag-gated', 'TG', 1, '["t"]', NULL, 'contact_only')`);
    });
    const slugs = (rows) => rows.map((r) => r.slug).sort();

    test('filters hand-picked and tag auto-fill alike', async () => {
      const rows = await videoService.getRelatedVideos(pool, 1, { limit: 10, publicOnly: true });
      expect(slugs(rows)).toEqual(['hand-pub', 'tag-pub']);
    });

    test('off by default — the editor still sees what it picked', async () => {
      const rows = await videoService.getRelatedVideos(pool, 1, { limit: 10 });
      expect(slugs(rows)).toEqual(['hand-gated', 'hand-pub', 'tag-gated', 'tag-pub']);
    });
  });

  describe('the Views tab', () => {
    const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36';
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15';

    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, view_count, analytics_reset_at) VALUES
        (1, 'one', 'One', 0, NULL),
        (2, 'two', 'Two', 0, '2026-06-01 00:00:00')`);
      await q(`INSERT INTO contacts (contact_id, contact_name) VALUES (10, 'Ann Lee'), (11, 'Bob_Smith'), (12, 'BobXSmith')`);
      await q(`INSERT INTO cases (case_id, case_number) VALUES ('C1', '26-40001')`);
      await q(`INSERT INTO users (user, user_name) VALUES (6, 'Fred')`);
    });

    const view = (row) => q('INSERT INTO video_views SET ?', [{ video_id: 1, opened_at: '2026-07-01 12:00:00', ...row }])
      .then((r) => r.insertId);
    const ids = (out) => out.views.map((v) => Number(v.id));

    test('a row carries the viewer, the case and what happened, and neither secret', async () => {
      await view({
        contact_id: 10, case_id: 'C1', user_agent: IPHONE, played_at: '2026-07-01 12:00:05',
        completed_at: '2026-07-01 12:01:00', watch_seconds: 55, completion_pct: 92,
        cta_clicks: JSON.stringify([{ label: 'Book', at: 'x' }, { label: 'Call', at: 'y' }, { nope: 1 }]),
        track_token: 'A1b2C3d4E5f6G7h8I9j0Kl', ip_hash: 'a'.repeat(64),
      });
      const { views: [row] } = await videoService.listViews(pool);
      expect(row).toMatchObject({
        video_title: 'One', contact_name: 'Ann Lee', case_number: '26-40001', device: 'iPhone',
        watch_seconds: 55, completion_pct: 92,
        automated: false, before_reset: false, excluded_at: null,
      });
      expect(row.cta_labels).toStrictEqual(['Book', 'Call']);
      expect(row.opened_at).toBeInstanceOf(Date);
      expect(row.completed_at).toBeInstanceOf(Date);
      expect(row).not.toHaveProperty('track_token');
      expect(row).not.toHaveProperty('ip_hash');
      expect(row).not.toHaveProperty('cta_clicks');
    });

    test('a view of nobody on nothing still lists', async () => {
      const id = await view({ user_agent: null });
      expect(ids(await videoService.listViews(pool))).toEqual([id]);
    });

    describe('automated opens', () => {
      test.each([
        ['curl', 'curl/8.5.0'],
        ['the Linux scanner', LINUX],
      ])('%s is hidden unless asked for, then flagged', async (_n, ua) => {
        const id = await view({ user_agent: ua });
        expect(ids(await videoService.listViews(pool))).toEqual([]);
        const shown = await videoService.listViews(pool, { includeAutomated: true });
        expect(ids(shown)).toEqual([id]);
        expect(shown.views[0].automated).toBe(true);
      });

      test('a played view from the same machine is a person', async () => {
        const id = await view({ user_agent: LINUX, played_at: '2026-07-01 12:00:05' });
        const out = await videoService.listViews(pool);
        expect(ids(out)).toEqual([id]);
        expect(out.views[0].automated).toBe(false);
      });

      test.each([
        ['a button click', { cta_clicks: JSON.stringify([{ label: 'Book' }]) }],
        ['a completion with no play recorded', { completed_at: '2026-07-01 12:01:00' }],
      ])('%s is a person, and a filter can find them', async (_n, row) => {
        const id = await view({ user_agent: LINUX, ...row });
        const out = await videoService.listViews(pool);
        expect(ids(out)).toEqual([id]);
        expect(out.views[0].automated).toBe(false);
      });

      test('an empty click list is no sign of a person', async () => {
        await view({ user_agent: LINUX, cta_clicks: '[]' });
        expect(ids(await videoService.listViews(pool))).toEqual([]);
      });

      test('an unplayed phone stays: nothing says it was a machine', async () => {
        const id = await view({ user_agent: IPHONE });
        expect(ids(await videoService.listViews(pool))).toEqual([id]);
      });

      test('a view with no user agent stays, NULL must not drop it', async () => {
        const id = await view({ user_agent: null });
        const out = await videoService.listViews(pool);
        expect(ids(out)).toEqual([id]);
        expect(out.views[0].automated).toBe(false);
      });
    });

    test('an excluded view is hidden unless asked for, and says who', async () => {
      const id = await view({ user_agent: IPHONE, excluded_at: '2026-07-02 00:00:00', excluded_by: 6 });
      expect(ids(await videoService.listViews(pool))).toEqual([]);
      const shown = await videoService.listViews(pool, { includeExcluded: true });
      expect(ids(shown)).toEqual([id]);
      expect(shown.views[0].excluded_by_name).toBe('Fred');
      expect(shown.views[0].excluded_at).toBeInstanceOf(Date);
    });

    test('a view before the reset is hidden unless asked for, then flagged', async () => {
      const old = await view({ video_id: 2, opened_at: '2026-05-31 23:59:59' });
      const atReset = await view({ video_id: 2, opened_at: '2026-06-01 00:00:00' });
      expect(ids(await videoService.listViews(pool))).toEqual([atReset]);
      const shown = await videoService.listViews(pool, { includeBeforeReset: true });
      expect(ids(shown)).toEqual([atReset, old]);
      expect(shown.views.map((v) => v.before_reset)).toEqual([false, true]);
    });

    test('with automated opens shown, the list adds up to the analytics panel', async () => {
      await view({ video_id: 2, opened_at: '2026-05-01 00:00:00', played_at: '2026-05-01 00:00:05' });
      await view({ video_id: 2, opened_at: '2026-07-01 00:00:00', user_agent: 'curl/8.5.0' });
      await view({ video_id: 2, opened_at: '2026-07-01 00:00:00', played_at: '2026-07-01 00:00:05', completed_at: '2026-07-01 00:01:00' });
      await view({ video_id: 2, opened_at: '2026-07-01 00:00:00', played_at: '2026-07-01 00:00:05', excluded_at: '2026-07-02 00:00:00' });
      await view({ video_id: 1 });
      const list = await videoService.listViews(pool, { videoId: 2, includeAutomated: true });
      const panel = await videoService.getVideoAnalytics(pool, 2);
      expect([list.total, list.played, list.completed]).toEqual([2, 1, 1]);
      expect(list.total).toBe(panel.total_views);
      expect(list.played).toBe(panel.played_count);
      expect(list.completed).toBe(panel.completed_count);
    });

    describe('filters', () => {
      let played, completed, clicked, bare, anon;
      beforeEach(async () => {
        played = await view({ contact_id: 10, played_at: '2026-07-01 12:00:05' });
        completed = await view({ contact_id: 11, played_at: '2026-07-01 12:00:05', completed_at: '2026-07-01 12:01:00' });
        clicked = await view({ contact_id: 12, cta_clicks: JSON.stringify([{ label: 'Book' }]) });
        bare = await view({ contact_id: 10, cta_clicks: '[]' });
        anon = await view({});
      });
      const got = async (f) => ids(await videoService.listViews(pool, f)).sort((a, b) => a - b);

      test('video', async () => {
        const other = await view({ video_id: 2, opened_at: '2026-07-01 12:00:00' });
        expect(await got({ videoId: '2' })).toEqual([other]);
      });
      test('played', async () => expect(await got({ status: 'played' })).toEqual([played, completed]));
      test('not played', async () => expect(await got({ status: 'not_played' })).toEqual([clicked, bare, anon]));
      test('completed', async () => expect(await got({ status: 'completed' })).toEqual([completed]));
      test('clicked: an empty array is no click', async () => expect(await got({ status: 'clicked' })).toEqual([clicked]));
      test('known contacts', async () => expect(await got({ who: 'known' })).toEqual([played, completed, clicked, bare]));
      test('anonymous', async () => expect(await got({ who: 'anonymous' })).toEqual([anon]));
      test('a name matches anywhere in it, in any case', async () => {
        expect(await got({ contact: 'ann l' })).toEqual([played, bare]);
      });
      test('an underscore is an underscore', async () => {
        expect(await got({ contact: 'b_s' })).toEqual([completed]);
      });
      test('a percent sign matches nothing rather than everything', async () => {
        expect(await got({ contact: '%' })).toEqual([]);
      });
      test.each([['status', { status: 'nope' }], ['status, inherited', { status: 'constructor' }], ['who', { who: 'nope' }],
        ['video', { videoId: 'abc' }], ['from', { from: '07/01/2026' }], ['a month alone', { from: '2026-07' }],
        ['an impossible day', { to: '2026-02-31' }], ['a year MySQL refuses', { to: '9999-12-31' }]])(
        '%s refuses a bad value', async (_n, f) => {
          await expect(videoService.listViews(pool, f)).rejects.toMatchObject({ statusCode: 400 });
        });
    });

    test('days are firm-local: 03:30 UTC on July 2 is still July 1 in Detroit', async () => {
      const late = await view({ opened_at: '2026-07-02 03:30:00' });
      const next = await view({ opened_at: '2026-07-02 04:00:00' });
      const got = async (f) => ids(await videoService.listViews(pool, f));
      expect(await got({ from: '2026-07-01', to: '2026-07-01' })).toEqual([late]);
      expect(await got({ to: '2026-06-30' })).toEqual([]);
      expect(await got({ from: '2026-07-02' })).toEqual([next]);
      expect(await got({ to: '2026-07-02' })).toEqual([next, late]);
    });

    test('a year still being typed is a date, not an error', async () => {
      const id = await view({});
      expect(ids(await videoService.listViews(pool, { from: '0202-01-01' }))).toEqual([id]);
      expect(ids(await videoService.listViews(pool, { to: '0202-01-01' }))).toEqual([]);
    });

    test.each([
      ['spring forward, a 23-hour day', '2026-03-08', '2026-03-08 04:59:59', '2026-03-08 05:00:00', '2026-03-09 03:59:59', '2026-03-09 04:00:00'],
      ['fall back, a 25-hour day', '2026-11-01', '2026-11-01 03:59:59', '2026-11-01 04:00:00', '2026-11-02 04:59:59', '2026-11-02 05:00:00'],
    ])('%s has the right edges', async (_n, day, before, first, last, after) => {
      await view({ opened_at: before });
      const a = await view({ opened_at: first });
      const b = await view({ opened_at: last });
      await view({ opened_at: after });
      const out = await videoService.listViews(pool, { from: day, to: day });
      expect(ids(out)).toEqual([b, a]);
    });

    test('newest first, id breaking a tie; the totals ignore the page', async () => {
      const a = await view({ opened_at: '2026-07-01 00:00:00', played_at: '2026-07-01 00:00:05' });
      const b = await view({ opened_at: '2026-07-03 00:00:00' });
      const c = await view({ opened_at: '2026-07-03 00:00:00' });
      const first = await videoService.listViews(pool, { limit: 2 });
      expect(ids(first)).toEqual([c, b]);
      expect([first.total, first.played]).toEqual([3, 1]);
      const second = await videoService.listViews(pool, { limit: 2, offset: 2 });
      expect(ids(second)).toEqual([a]);
      expect(second.total).toBe(3);
    });

    test('a page has a ceiling', async () => {
      expect((await videoService.listViews(pool, { limit: 100000 })).limit).toBe(200);
    });

    test('an absurd offset is an empty page, not a SQL error', async () => {
      await view({});
      const out = await videoService.listViews(pool, { offset: '99999999999999999999999' });
      expect(out.views).toEqual([]);
      expect(out.total).toBe(1);
    });

    describe('setViewExcluded', () => {
      const count = async (id = 1) => (await q('SELECT view_count FROM videos WHERE id = ?', [id]))[0].view_count;
      const row = async (id) => (await q('SELECT excluded_at, excluded_by FROM video_views WHERE id = ?', [id]))[0];

      test('takes the view out of every stat, and restore puts it back', async () => {
        await q('UPDATE videos SET view_count = 2 WHERE id = 1');
        await view({ played_at: '2026-07-01 12:00:05', completion_pct: 100 });
        const id = await view({
          played_at: '2026-07-01 12:00:05', completed_at: '2026-07-01 12:01:00', completion_pct: 50,
          contact_id: 10, cta_clicks: JSON.stringify([{ label: 'Book' }]),
        });
        const stats = async () => {
          const a = await videoService.getVideoAnalytics(pool, 1);
          return [a.total_views, a.identified_views, a.played_count, a.completed_count, a.avg_completion_pct, a.cta_clicks_by_label.length];
        };
        expect(await stats()).toEqual([2, 1, 2, 1, 75, 1]);

        const out = await videoService.setViewExcluded(pool, id, true, 6);
        expect(out).toEqual({ id, video_id: 1, excluded: true, changed: true });
        expect(await stats()).toEqual([1, 0, 1, 0, 100, 0]);
        expect(await count()).toBe(1);
        expect(await row(id)).toMatchObject({ excluded_by: 6 });
        expect((await row(id)).excluded_at).toBeInstanceOf(Date);

        expect((await videoService.setViewExcluded(pool, id, false)).changed).toBe(true);
        expect(await stats()).toEqual([2, 1, 2, 1, 75, 1]);
        expect(await count()).toBe(2);
        expect(await row(id)).toEqual({ excluded_at: null, excluded_by: null });
      });

      test('the JS fallback for button clicks skips an excluded view too', async () => {
        const id = await view({ cta_clicks: JSON.stringify([{ label: 'Book' }]) });
        await videoService.setViewExcluded(pool, id, true, 6);
        const real = pool.query.bind(pool);
        const spy = jest.spyOn(pool, 'query').mockImplementation((sql, p) => {
          if (/JSON_TABLE/.test(sql)) return Promise.reject(new Error('no JSON_TABLE'));
          return real(sql, p);
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        await view({ cta_clicks: JSON.stringify([{ label: 'Call' }]) });
        const a = await videoService.getVideoAnalytics(pool, 1);
        spy.mockRestore();
        warn.mockRestore();
        expect(a.cta_clicks_by_label).toEqual([{ label: 'Call', count: 1 }]);
      });

      test('running it twice moves nothing twice and keeps who did it', async () => {
        await q('UPDATE videos SET view_count = 5 WHERE id = 1');
        const id = await view({});
        await videoService.setViewExcluded(pool, id, true, 6);
        const first = await row(id);
        expect((await videoService.setViewExcluded(pool, id, true, 7)).changed).toBe(false);
        expect(await count()).toBe(4);
        expect(await row(id)).toEqual(first);

        await videoService.setViewExcluded(pool, id, false);
        expect((await videoService.setViewExcluded(pool, id, false)).changed).toBe(false);
        expect(await count()).toBe(5);
      });

      test('the counter never goes below zero', async () => {
        const id = await view({});
        await videoService.setViewExcluded(pool, id, true, 6);
        expect(await count()).toBe(0);
      });

      test('a view from before the reset leaves the counter alone, both ways', async () => {
        await q('UPDATE videos SET view_count = 3 WHERE id = 2');
        const id = await view({ video_id: 2, opened_at: '2026-05-01 00:00:00' });
        await videoService.setViewExcluded(pool, id, true, 6);
        expect(await count(2)).toBe(3);
        await videoService.setViewExcluded(pool, id, false);
        expect(await count(2)).toBe(3);
      });

      test('a view at the reset instant counts, as it does in the panel', async () => {
        await q('UPDATE videos SET view_count = 3 WHERE id = 2');
        const id = await view({ video_id: 2, opened_at: '2026-06-01 00:00:00' });
        await videoService.setViewExcluded(pool, id, true, 6);
        expect(await count(2)).toBe(2);
      });

      test('a missing view is a 404 and changes nothing', async () => {
        await expect(videoService.setViewExcluded(pool, 999, true, 6)).rejects.toMatchObject({ statusCode: 404 });
      });
    });
  });

  describe('the video.* events', () => {
    let emit;
    beforeEach(async () => {
      emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
      await q(`INSERT INTO videos (id, slug, title) VALUES (1, 'one', 'One'), (2, 'two', 'Two')`);
      await q(`INSERT INTO contacts (contact_id, contact_name) VALUES (10, 'Ann Lee'), (11, 'Bob')`);
    });
    afterEach(() => emit.mockRestore());

    const view = (row) => q('INSERT INTO video_views SET ?', [{
      video_id: 1, contact_id: 10, case_id: 'C1', contact_verified: 1, ...row,
    }]).then((r) => r.insertId);
    const played = (viewId, videoId = 1) => videoService.recordPlayed(pool, { viewId, videoId });
    const progress = (viewId, pct, videoId = 1) => videoService.recordProgress(pool, {
      viewId, videoId, watchSeconds: pct, completionPct: pct,
    });
    const button = (label, url = 'https://example.com/book?c={{ct}}') => ({ type: 'url', label, config: { url } });
    const click = (viewId, label, actions = [button(label)], videoId = 1) =>
      videoService.recordCtaClick(pool, { viewId, videoId, label, actions });
    const fired = () => emit.mock.calls.map((c) => c[1]);
    const last = () => emit.mock.calls[emit.mock.calls.length - 1][2];

    test('recordView stores what it was told, and defaults to unverified', async () => {
      const yes = await videoService.recordView(pool, { videoId: 1, contactId: 10, contactVerified: true });
      const no = await videoService.recordView(pool, { videoId: 1, contactId: 10 });
      const rows = await q('SELECT id, contact_verified FROM video_views ORDER BY id');
      expect(rows).toEqual([
        { id: yes.viewId, contact_verified: 1 },
        { id: no.viewId, contact_verified: 0 },
      ]);
    });

    test('video.played carries the view, once, however many beacons arrive', async () => {
      const id = await view({ watch_seconds: 0 });
      const results = await Promise.all([played(id), played(id), played(id)]);
      expect(results.filter((r) => r.playedNow).length).toBe(1);
      expect(fired()).toEqual(['video.played']);
      expect(emit.mock.calls[0][0]).toBe(pool);
      expect(last()).toEqual({
        contact_id: 10, case_id: 'C1', source: 'video_page', actor: { user_id: 0 },
        data: { view_id: id, video_id: 1, video_slug: 'one', video_title: 'One', watch_seconds: 0, completion_pct: 0 },
        extra: { first_for_contact: true, first_for_case: true },
      });
    });

    test('the first play keeps its time', async () => {
      const id = await view({ played_at: '2026-07-01 12:00:05' });
      expect((await played(id)).playedNow).toBe(false);
      const [row] = await q('SELECT played_at FROM video_views WHERE id = ?', [id]);
      expect(row.played_at.toISOString()).toBe('2026-07-01T12:00:05.000Z');
      expect(fired()).toEqual([]);
    });

    test('a play on another video\'s id does nothing', async () => {
      const id = await view({});
      expect((await played(id, 2)).playedNow).toBe(false);
      expect(fired()).toEqual([]);
    });

    test('video.completed fires at 90% really played, once', async () => {
      const id = await view({});
      await progress(id, 89);
      expect(fired()).toEqual([]);
      await progress(id, 90);
      await progress(id, 100);
      expect(fired()).toEqual(['video.completed']);
      expect(last().data).toMatchObject({ completion_pct: 90, watch_seconds: 90 });
    });

    test('video.cta_clicked fires once per button on a view; every click still counts', async () => {
      const id = await view({});
      expect((await click(id, 'Book')).firstClick).toBe(true);
      expect((await click(id, 'Book')).firstClick).toBe(false);
      expect((await click(id, 'Call')).firstClick).toBe(true);
      expect(fired()).toEqual(['video.cta_clicked', 'video.cta_clicked']);
      expect(emit.mock.calls.map((c) => c[2].extra.label)).toEqual(['Book', 'Call']);
      const a = await videoService.getVideoAnalytics(pool, 1);
      expect(a.cta_clicks_by_label).toEqual([{ label: 'Book', count: 2 }, { label: 'Call', count: 1 }]);
    });

    test.each([
      ['a label the video has no button for', 'Invented', [button('Book')]],
      ['a video with no buttons', 'Book', []],
      ['actions missing', 'Book', null],
      ['a label that only differs in case', 'book', [button('Book')]],
      ['an action the page refuses to draw: a javascript: link', 'Book', [button('Book', 'javascript:alert(1)')]],
      ['an action with no url', 'Book', [{ type: 'url', label: 'Book', config: {} }]],
      ['an action type the page does not know', 'Book', [{ type: 'future', label: 'Book', config: { url: 'https://example.com' } }]],
      ['an action with no type', 'Book', [{ label: 'Book', config: { url: 'https://example.com' } }]],
    ])('%s is stored and fires nothing', async (_n, label, actions) => {
      const id = await view({});
      await click(id, label, actions);
      expect(fired()).toEqual([]);
      const [{ n }] = await q('SELECT JSON_LENGTH(cta_clicks) AS n FROM video_views WHERE id = ?', [id]);
      expect(n).toBe(1);
    });

    test.each([
      ['an unlabelled button reads Open on the page', 'Open', [{ type: 'url', config: { url: 'https://example.com' } }]],
      ['the page trims what it sends', 'Book', [button('  Book  ')]],
      ['the route cuts a long label at 200', 'x'.repeat(200), [button('x'.repeat(250))]],
    ])('%s', async (_n, label, actions) => {
      const id = await view({});
      await click(id, label, actions);
      expect(fired()).toEqual(['video.cta_clicked']);
    });

    test('a later view never makes an earlier one read as not first', async () => {
      const earlier = await view({});
      await view({ played_at: '2026-07-01 12:00:00' });
      await played(earlier);
      expect(last().extra.first_for_contact).toBe(true);
    });

    test('two clicks at once fire once and both count', async () => {
      const id = await view({});
      const results = await Promise.all([click(id, 'Book'), click(id, 'Book')]);
      expect(results.filter((r) => r.firstClick).length).toBe(1);
      expect(fired()).toEqual(['video.cta_clicked']);
      const [{ n }] = await q('SELECT JSON_LENGTH(cta_clicks) AS n FROM video_views WHERE id = ?', [id]);
      expect(n).toBe(2);
    });

    test('a label with quotes and a backslash still claims once', async () => {
      const id = await view({});
      const label = `Book "now" \\ it's free`;
      await click(id, label);
      await click(id, label);
      expect(fired()).toEqual(['video.cta_clicked']);
      expect(last().extra.label).toBe(label);
    });

    describe('a view that may not announce anything', () => {
      test.each([
        ['a typed ?c= link', { contact_verified: 0 }],
        ['a view from before the column', { contact_verified: 0, case_id: null }],
        ['an anonymous view', { contact_id: null, case_id: null, contact_verified: 0 }],
        ['a verified flag with no contact', { contact_id: null, contact_verified: 1 }],
        ['an excluded view', { excluded_at: '2026-07-02 00:00:00' }],
      ])('%s still records, and fires nothing', async (_n, row) => {
        const id = await view(row);
        await played(id);
        await progress(id, 100);
        await click(id, 'Book');
        expect(fired()).toEqual([]);
        const [v] = await q('SELECT played_at, completed_at, cta_clicks FROM video_views WHERE id = ?', [id]);
        expect(v.played_at).toBeInstanceOf(Date);
        expect(v.completed_at).toBeInstanceOf(Date);
        expect(v.cta_clicks).not.toBeNull();
      });
    });

    describe('first_for_case', () => {
      const flags = async (act, row) => {
        const id = await view(row);
        await act(id);
        return [last().extra.first_for_contact, last().extra.first_for_case];
      };

      test('a second bankruptcy is not first for the contact, but is for the case', async () => {
        await view({ case_id: 'OLD', played_at: '2026-07-01 12:00:00' });
        expect(await flags((id) => played(id), { case_id: 'NEW' })).toEqual([false, true]);
      });
      test('the same case again is first for neither', async () => {
        await view({ case_id: 'C1', played_at: '2026-07-01 12:00:00' });
        expect(await flags((id) => played(id), { case_id: 'C1' })).toEqual([false, false]);
      });
      test('a joint debtor on the same case: first for them, not for the case', async () => {
        await view({ contact_id: 11, case_id: 'C1', played_at: '2026-07-01 12:00:00' });
        expect(await flags((id) => played(id), { case_id: 'C1' })).toEqual([true, false]);
      });
      test('a view with no case has no answer', async () => {
        expect(await flags((id) => played(id), { case_id: null })).toEqual([true, null]);
      });
      test('an excluded view on the case does not count', async () => {
        await view({ case_id: 'C1', played_at: '2026-07-01 12:00:00', excluded_at: '2026-07-02 00:00:00' });
        expect(await flags((id) => played(id), { case_id: 'C1' })).toEqual([true, true]);
      });
      test('another video on the case does not count', async () => {
        await view({ video_id: 2, case_id: 'C1', played_at: '2026-07-01 12:00:00' });
        expect(await flags((id) => played(id), { case_id: 'C1' })).toEqual([true, true]);
      });
      test('a completion is compared with completions', async () => {
        await view({ case_id: 'C1', played_at: '2026-07-01 12:00:00' });
        expect(await flags((id) => progress(id, 95), { case_id: 'C1' })).toEqual([true, true]);
      });
      test('a click is compared with that button', async () => {
        await view({ case_id: 'C1', cta_clicks: JSON.stringify([{ label: 'Book' }]) });
        expect(await flags((id) => click(id, 'Book'), { case_id: 'C1' })).toEqual([false, false]);
      });
      test('later views never count', async () => {
        const id = await view({ case_id: 'C1' });
        await view({ case_id: 'C1', played_at: '2026-07-01 12:00:00' });
        await played(id);
        expect(last().extra.first_for_case).toBe(true);
      });
    });

    describe('first_for_contact', () => {
      const firstOn = async (act) => {
        const id = await view({});
        await act(id);
        return last().extra.first_for_contact;
      };

      test('false once this contact has done it on an earlier view', async () => {
        expect(await firstOn((id) => played(id))).toBe(true);
        expect(await firstOn((id) => played(id))).toBe(false);
      });
      test('completion counts completions, not plays', async () => {
        await view({ played_at: '2026-07-01 12:00:00' });
        expect(await firstOn((id) => progress(id, 95))).toBe(true);
        expect(await firstOn((id) => progress(id, 95))).toBe(false);
      });
      test('a click counts that button, not another', async () => {
        await view({ cta_clicks: JSON.stringify([{ label: 'Call' }]) });
        expect(await firstOn((id) => click(id, 'Book'))).toBe(true);
        expect(await firstOn((id) => click(id, 'Book'))).toBe(false);
      });
      test('another person does not count', async () => {
        await view({ contact_id: 11, played_at: '2026-07-01 12:00:00' });
        expect(await firstOn((id) => played(id))).toBe(true);
      });
      test('another video does not count', async () => {
        await view({ video_id: 2, played_at: '2026-07-01 12:00:00' });
        expect(await firstOn((id) => played(id))).toBe(true);
      });
      test('an excluded view does not count', async () => {
        await view({ played_at: '2026-07-01 12:00:00', excluded_at: '2026-07-02 00:00:00' });
        expect(await firstOn((id) => played(id))).toBe(true);
      });
      test('a watch from before verification still counts: they really did watch', async () => {
        await view({ contact_verified: 0, played_at: '2026-07-01 12:00:00' });
        expect(await firstOn((id) => played(id))).toBe(false);
      });
    });
  });

  describe('resolveViewCase and primaryOfCase', () => {
    const give = async (contactId, rows) => {
      for (const [caseId, stage, type = 'Primary', opened = '2026-01-01'] of rows) {
        await q('INSERT IGNORE INTO cases (case_id, case_stage, case_open_date) VALUES (?, ?, ?)', [caseId, stage, opened]);
        await q('INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)',
          [caseId, contactId, type]);
      }
    };
    beforeEach(() => q(`INSERT INTO contacts (contact_id, contact_name) VALUES (10, 'Ann'), (11, 'Bob')`));
    const resolve = (contact, ca) => videoService.resolveViewCase(pool, contact, ca);

    test.each([['Primary'], ['Secondary']])('a case named by someone %s on it wins, whatever the ranking', async (type) => {
      await give(10, [['ACTIVE', 'Open'], ['OLDCASE', 'Closed', type]]);
      expect(await resolve(10, 'OLDCASE')).toEqual({ caseId: 'OLDCASE', certain: true, fromLink: true });
    });

    test('naming one of two active cases settles the tie', async () => {
      await give(10, [['A', 'Open'], ['B', 'Filed']]);
      expect(await resolve(10, 'A')).toEqual({ caseId: 'A', certain: true, fromLink: true });
    });

    test.each([['Other'], ['Bystander']])('%s is not on the case for this', async (type) => {
      await give(10, [['MINE', 'Open'], ['THEIRS', 'Open', type]]);
      expect(await resolve(10, 'THEIRS')).toEqual({ caseId: 'MINE', certain: true, fromLink: false });
    });

    test('a case_relate row with no case is nothing, named or alone', async () => {
      await q(`INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES ('GHOST', 10, 'Primary')`);
      expect(await resolve(10, 'GHOST')).toEqual({ caseId: null, certain: false, fromLink: false });
      expect(await videoService.primaryOfCase(pool, 'GHOST')).toBeNull();
    });

    test('someone else\'s case is ignored, never reached', async () => {
      await give(10, [['MINE', 'Open']]);
      await give(11, [['THEIRS', 'Open']]);
      expect(await resolve(10, 'THEIRS')).toEqual({ caseId: 'MINE', certain: true, fromLink: false });
    });

    test('a lowercased id comes back as stored: the column ignores case, JS does not', async () => {
      await give(10, [['AB12CD34', 'Open']]);
      expect((await resolve(10, 'ab12cd34')).caseId).toBe('AB12CD34');
    });

    test.each([
      ['one case', [['A', 'Open']], 'A', true],
      ['one active beside old ones', [['A', 'Filed'], ['B', 'Closed'], ['C', 'Concluded']], 'A', true],
      ['Pending counts as active', [['A', 'Pending']], 'A', true],
      ['two active tie', [['A', 'Open', 'Primary', '2026-02-01'], ['B', 'Filed', 'Primary', '2026-01-01']], 'A', false],
      ['a closed-out client has nothing to act on', [['A', 'Closed']], 'A', false],
      ['nor does a Concluded one', [['A', 'Concluded'], ['B', 'Closed']], 'A', false],
      ['two Closed tie', [['A', 'Closed', 'Primary', '2026-02-01'], ['B', 'Closed', 'Primary', '2026-01-01']], 'A', false],
      ['a live Secondary beside a Closed Primary: the guess is not the live case', [['OLD', 'Closed'], ['LIVE', 'Open', 'Secondary']], 'OLD', false],
      ['a live Secondary beside a live Primary is a tie', [['A', 'Open'], ['B', 'Filed', 'Secondary']], 'A', false],
      ['a closed Secondary beside a live Primary is no tie', [['A', 'Open'], ['B', 'Closed', 'Secondary']], 'A', true],
      ['Primary and Secondary on one case is one case', [['A', 'Open'], ['A', 'Open', 'Secondary']], 'A', true],
      ['Other and Bystander are not in the running', [['A', 'Open'], ['B', 'Open', 'Other'], ['C', 'Open', 'Bystander']], 'A', true],
    ])('a guess: %s', async (_n, rows, caseId, certain) => {
      await give(10, rows);
      expect(await resolve(10, null)).toEqual({ caseId, certain, fromLink: false });
    });

    test('Secondary alone is no guess: the ranking is Primary only', async () => {
      await give(10, [['A', 'Open', 'Secondary']]);
      expect(await resolve(10, null)).toEqual({ caseId: null, certain: false, fromLink: false });
    });

    test('nobody, or no cases, is nothing', async () => {
      expect(await resolve(null, 'A')).toEqual({ caseId: null, certain: false, fromLink: false });
      expect(await resolve(10, null)).toEqual({ caseId: null, certain: false, fromLink: false });
    });

    test('resolveCaseIdForContact still answers with the guess', async () => {
      await give(10, [['A', 'Open', 'Primary', '2026-02-01'], ['B', 'Filed', 'Primary', '2026-01-01']]);
      expect(await videoService.resolveCaseIdForContact(pool, 10)).toBe('A');
    });

    test('a case\'s Primary, by stored id', async () => {
      await give(11, [['AB12CD34', 'Open', 'Secondary']]);
      await give(10, [['AB12CD34', 'Open']]);
      expect(await videoService.primaryOfCase(pool, 'ab12cd34')).toEqual({ contactId: 10, caseId: 'AB12CD34' });
    });

    test('two Primaries: the lowest relation id, whatever the insert order', async () => {
      await q(`INSERT INTO cases (case_id, case_stage) VALUES ('A', 'Open')`);
      await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type)
               VALUES (50, 'A', 10, 'Primary'), (40, 'A', 11, 'Primary')`);
      expect((await videoService.primaryOfCase(pool, 'A')).contactId).toBe(11);
    });

    test.each([
      ['no such case', 'NOPE', null],
      ['a case with only a Secondary', 'SEC', null],
      ['a Primary whose contact is gone', 'GONE', null],
    ])('%s', async (_n, caseId) => {
      await give(10, [['SEC', 'Open', 'Secondary']]);
      await give(99, [['GONE', 'Open']]);
      expect(await videoService.primaryOfCase(pool, caseId)).toBeNull();
    });

    test('recordView stores the case it is given, including none', async () => {
      await q(`INSERT INTO videos (id, slug, title) VALUES (1, 'one', 'One')`);
      await give(10, [['GUESS', 'Open']]);
      const open = async (args) => {
        const { viewId } = await videoService.recordView(pool, { videoId: 1, contactId: 10, ...args });
        return (await q('SELECT case_id FROM video_views WHERE id = ?', [viewId]))[0].case_id;
      };
      expect(await open({ caseId: 'OTHER' })).toBe('OTHER');
      expect(await open({ caseId: null })).toBeNull();
      expect(await open({})).toBe('GUESS');
    });
  });

  describe('video_watch_status', () => {
    const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/139.0.0.0';
    beforeEach(async () => {
      await q(`INSERT INTO videos (id, slug, title, is_published) VALUES (1, 'one', 'One', 0), (2, 'two', 'Two', 1)`);
    });
    const view = (row) => q('INSERT INTO video_views SET ?', [{ video_id: 1, contact_id: 10, ...row }]);
    const status = async (video = 'one', contact = '10') =>
      (await videoFns.video_watch_status({ contact_id: contact, video }, pool)).output;

    test('never opened', async () => {
      expect(await status()).toEqual({
        video_id: 1, video_slug: 'one', opened: false, played: false, completed: false, clicked: false,
        best_completion_pct: 0, last_played_at: null, last_completed_at: null,
      });
    });

    test('adds up across views, by id or by slug, published or not', async () => {
      await view({ played_at: '2026-07-01 12:00:00', completion_pct: 40 });
      await view({
        played_at: '2026-07-03 12:00:00', completed_at: '2026-07-03 12:05:00', completion_pct: 95,
        cta_clicks: JSON.stringify([{ label: 'Book' }]),
      });
      for (const video of ['one', '1', 1]) {
        const s = await status(video);
        expect(s).toMatchObject({ opened: true, played: true, completed: true, clicked: true, best_completion_pct: 95 });
        expect(s.last_played_at.toISOString()).toBe('2026-07-03T12:00:00.000Z');
        expect(s.last_completed_at.toISOString()).toBe('2026-07-03T12:05:00.000Z');
      }
    });

    test('an old slug still finds the video', async () => {
      await q(`INSERT INTO video_slug_aliases (video_id, slug) VALUES (1, 'old-name')`);
      await view({ played_at: '2026-07-01 12:00:00' });
      expect(await status('old-name')).toMatchObject({ video_id: 1, video_slug: 'one', played: true });
    });

    test('an all-digit slug answers for that video, not for the id it spells', async () => {
      await q(`INSERT INTO videos (id, slug, title) VALUES (341, 'other', 'Other'), (3, '341', 'Digits')`);
      await q('INSERT INTO video_views SET ?', [{ video_id: 3, contact_id: 10, played_at: '2026-07-01 12:00:00' }]);
      expect(await status('341')).toMatchObject({ video_id: 3, video_slug: '341', played: true });
    });

    test('an id still works when no slug spells it', async () => {
      await q(`INSERT INTO videos (id, slug, title) VALUES (341, 'other', 'Other')`);
      expect(await status('341')).toMatchObject({ video_id: 341, video_slug: 'other' });
    });

    test('case_id: the first bankruptcy does not answer for the second', async () => {
      await view({ case_id: 'OLD', played_at: '2026-07-01 12:00:00' });
      const run = async (case_id) => (await videoFns.video_watch_status({ contact_id: '10', video: 'one', case_id }, pool)).output;
      expect(await run('OLD')).toMatchObject({ played: true });
      expect(await run('NEW')).toMatchObject({ opened: false, played: false });
      expect(await run(undefined)).toMatchObject({ played: true });
      expect(await run('')).toMatchObject({ played: true });
    });

    test('opened but not played is not watched', async () => {
      await view({ user_agent: 'iPhone' });
      expect(await status()).toMatchObject({ opened: true, played: false, completed: false });
    });

    test.each([
      ['an excluded view', { played_at: '2026-07-01 12:00:00', excluded_at: '2026-07-02 00:00:00' }],
      ['a scanner', { user_agent: LINUX }],
      ['another video', { video_id: 2, played_at: '2026-07-01 12:00:00' }],
      ['another contact', { contact_id: 11, played_at: '2026-07-01 12:00:00' }],
    ])('%s does not count', async (_n, row) => {
      await view(row);
      expect(await status()).toMatchObject({ opened: false, played: false, clicked: false });
    });

    test('an empty click list is no click', async () => {
      await view({ cta_clicks: '[]', user_agent: 'iPhone' });
      expect(await status()).toMatchObject({ opened: true, clicked: false });
    });

    test('a view before an analytics reset still counts', async () => {
      await q(`UPDATE videos SET analytics_reset_at = '2026-08-01 00:00:00' WHERE id = 1`);
      await view({ opened_at: '2026-07-01 12:00:00', played_at: '2026-07-01 12:00:00' });
      expect(await status()).toMatchObject({ played: true });
    });

    test('a video that does not exist fails the step', async () => {
      await expect(status('nope')).rejects.toThrow('no video "nope"');
      await expect(status('999')).rejects.toThrow('no video "999"');
      await expect(status('1x')).rejects.toThrow('no video "1x"');
    });

    test.each([[''], [null], [undefined]])('no video (%s) fails the step', async (video) => {
      await expect(videoFns.video_watch_status({ contact_id: '10', video }, pool)).rejects.toThrow('requires video');
    });

    test.each([['abc'], ['0'], [''], [undefined], ['{{contactId}}']])('contact_id %s fails the step', async (contact_id) => {
      await expect(videoFns.video_watch_status({ contact_id, video: 'one' }, pool)).rejects.toThrow('numeric contact_id');
    });
  });
});
