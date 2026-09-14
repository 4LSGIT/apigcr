-- ============================================================================
-- 2026-07-28_report_charts.sql
-- Reports engine — chart showcase seeds (Slice 4).
--
-- WHY
--   Slice 4 adds chart rendering. The `viz` column already existed and the four
--   Slice 1 seeds already carry simple {type,x,y} hints, which the new renderer
--   reads unchanged — so NOTHING NEEDS MIGRATING for existing reports.
--
--   These four new seeds exist to exercise and demonstrate the chart types that
--   the simple hints don't reach: a dual-axis combo, a pie, stat cards, and a
--   horizontal bar. They double as fixtures proving the richer viz schema
--   round-trips through sanitizeViz() and renders.
--
--   Every query below was executed against live data on 2026-07-28 and returns
--   sensible rows.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- Run AFTER 2026-07-28_reports.sql (it needs report_definitions to exist).
-- Deploy order is otherwise unchanged: SQL first, then code.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- INSERT IGNORE on a UNIQUE report_key. Safe to re-run; will never overwrite a
-- version you have since edited in the UI.
--
-- ── OPTIONAL ────────────────────────────────────────────────────────────────
-- Nothing depends on these. Skip the file entirely if you would rather start
-- with a clean list and let the AI author fill it.
-- ============================================================================

INSERT IGNORE INTO report_definitions
  (report_key, title, description, category, sql_text, params, columns_meta, viz, caveats, row_limit, source)
VALUES
-- ── 1. COMBO: volume as bars, rate as a line on a second axis ───────────────
(
  'appointment_no_show_trend',
  'No-show rate by month',
  'For each month in the window: how many appointments there were, how many were marked No Show, and that as a percentage. Counts appointments rather than distinct clients.',
  'Appointments',
  'SELECT DATE_FORMAT(appt_date, ''%Y-%m'') AS month,\n       COUNT(*) AS appointments,\n       SUM(appt_status = ''No Show'') AS no_shows,\n       ROUND(100.0 * SUM(appt_status = ''No Show'') / COUNT(*), 1) AS no_show_pct\n  FROM appts\n WHERE appt_date >= ?\n   AND appt_date <= ?\n GROUP BY month\n ORDER BY month',
  JSON_ARRAY(
    JSON_OBJECT('name','start','type','date','label','From','default','-365d','required',true),
    JSON_OBJECT('name','end','type','date','label','To','default','today','required',true)
  ),
  JSON_ARRAY(JSON_OBJECT('key','month','label','Month','format','text'),
             JSON_OBJECT('key','appointments','label','Appointments','format','number'),
             JSON_OBJECT('key','no_show_pct','label','No-show %','format','percent')),
  JSON_OBJECT(
    'type','combo','x','month',
    'series', JSON_ARRAY(
      JSON_OBJECT('key','appointments','label','Appointments','type','bar','axis','y'),
      JSON_OBJECT('key','no_show_pct','label','No-show %','type','line','axis','y1','format','percent')
    ),
    'yLabel','Appointments','y1Label','No-show %'
  ),
  JSON_ARRAY('Counts appointments, not distinct clients — one client rescheduling three times contributes three rows.',
             'Appointments still marked ''Scheduled'' in a past month were never reconciled; they sit in the denominator and push the percentage down.'),
  1000, 'manual'
),

-- ── 2. PIE: composition of one total across few categories ──────────────────
(
  'cases_by_chapter_share',
  'Chapter 7 vs Chapter 13',
  'Share of filed cases by bankruptcy chapter. Chapter is only recorded once a case is actually filed, so this covers filed cases only — not the full book.',
  'Cases',
  'SELECT CONCAT(''Chapter '', case_chapter) AS chapter, COUNT(*) AS n\n  FROM cases\n WHERE case_chapter <> ''''\n GROUP BY case_chapter\n ORDER BY n DESC',
  JSON_ARRAY(),
  JSON_ARRAY(JSON_OBJECT('key','chapter','label','Chapter','format','text'),
             JSON_OBJECT('key','n','label','Cases','format','number')),
  JSON_OBJECT('type','pie','x','chapter','y','n'),
  JSON_ARRAY('case_chapter is empty on roughly 83% of all cases, so this total is far smaller than the full case count.'),
  1000, 'manual'
),

-- ── 3. STAT: a single row of summary figures ────────────────────────────────
(
  'time_to_file',
  'Time from opening a case to filing',
  'Across cases where both an open date and a filing date are genuinely recorded: how many were measured, and the average, fastest and slowest number of days between the two.',
  'Cases',
  'SELECT COUNT(*) AS cases_measured,\n       ROUND(AVG(DATEDIFF(case_file_date, case_open_date))) AS avg_days,\n       MIN(DATEDIFF(case_file_date, case_open_date)) AS fastest_days,\n       MAX(DATEDIFF(case_file_date, case_open_date)) AS slowest_days\n  FROM cases\n WHERE case_open_date IS NOT NULL\n   AND case_file_date IS NOT NULL\n   AND CAST(case_open_date AS CHAR) <> ''0000-00-00''\n   AND CAST(case_file_date AS CHAR) <> ''0000-00-00''\n   AND DATEDIFF(case_file_date, case_open_date) >= 0',
  JSON_ARRAY(),
  JSON_ARRAY(JSON_OBJECT('key','avg_days','label','Average days','format','days'),
             JSON_OBJECT('key','fastest_days','label','Fastest','format','days'),
             JSON_OBJECT('key','slowest_days','label','Slowest','format','days')),
  JSON_OBJECT(
    'type','stat',
    'series', JSON_ARRAY(
      JSON_OBJECT('key','cases_measured','label','Cases measured','format','number'),
      JSON_OBJECT('key','avg_days','label','Average','format','days'),
      JSON_OBJECT('key','fastest_days','label','Fastest','format','days'),
      JSON_OBJECT('key','slowest_days','label','Slowest','format','days')
    )
  ),
  JSON_ARRAY('case_file_date is recorded on only about 16% of cases, so this measures a small filed subset rather than the whole book.',
             'One case has a filing date earlier than its open date; the query excludes negative gaps explicitly.'),
  1000, 'manual'
),

-- ── 4. HORIZONTAL BAR: names read better along the y axis ───────────────────
(
  'staff_activity',
  'Activity by staff member',
  'Log entries per staff member in the window. Excludes user 0 (Automations), so this is human-attributed activity only.',
  'Activity',
  'SELECT u.user_name AS staff, COUNT(*) AS entries\n  FROM log l\n  JOIN users u ON u.user = l.log_by\n WHERE l.log_date >= ?\n   AND l.log_date <= ?\n   AND l.log_by <> 0\n GROUP BY u.user_name\n ORDER BY entries DESC',
  JSON_ARRAY(
    JSON_OBJECT('name','start','type','date','label','From','default','-30d','required',true),
    JSON_OBJECT('name','end','type','date','label','To','default','today','required',true)
  ),
  JSON_ARRAY(JSON_OBJECT('key','staff','label','Staff','format','text'),
             JSON_OBJECT('key','entries','label','Log entries','format','number')),
  JSON_OBJECT('type','bar','x','staff','y','entries','horizontal',true,'yLabel','Log entries'),
  JSON_ARRAY('Counts log rows, which is not the same as work done — a long phone call and a one-line note each count as one entry.',
             'Excludes automated entries (user 0), which are the largest single source of log rows.'),
  1000, 'manual'
);
