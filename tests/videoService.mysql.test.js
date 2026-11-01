// tests/videoService.mysql.test.js
//
/**
 * videoService on REAL MySQL — the case a view attaches to, Avg watch, and
 * the related-video access filter.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3341/yc_video_test npx jest tests/videoService.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates
 * videos, video_views, cases and case_relate in it (the columns these queries
 * read, production types).
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
 */
'use strict';

const mysql = require('mysql2/promise');
const videoService = require('../services/videoService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;

d('videoService on real MySQL', () => {
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

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
    for (const t of ['video_views', 'videos', 'case_relate', 'cases']) await q(`DROP TABLE IF EXISTS \`${t}\``);
    await q(`CREATE TABLE cases (
      case_id varchar(20) NOT NULL PRIMARY KEY,
      case_stage enum('Open','Pending','Filed','Concluded','Closed') NOT NULL DEFAULT 'Open',
      case_open_date date DEFAULT NULL)`);
    await q(`CREATE TABLE case_relate (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      case_relate_case_id varchar(20) NOT NULL,
      case_relate_client_id int NOT NULL,
      case_relate_type varchar(20) NOT NULL)`);
    await q(`CREATE TABLE videos (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug varchar(64) NOT NULL UNIQUE, title varchar(255) NOT NULL,
      gcs_poster_url varchar(1024) DEFAULT NULL, gcs_gif_url varchar(1024) DEFAULT NULL,
      tags json DEFAULT NULL, related_video_ids json DEFAULT NULL,
      access_level enum('public','contact_only') NOT NULL DEFAULT 'public',
      is_published tinyint(1) NOT NULL DEFAULT '0',
      view_count int NOT NULL DEFAULT '0', analytics_reset_at timestamp NULL DEFAULT NULL)`);
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
      excluded_by int DEFAULT NULL)`);
  });

  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    for (const t of ['video_views', 'videos', 'case_relate', 'cases']) await q(`DELETE FROM \`${t}\``);
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
});
