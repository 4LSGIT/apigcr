-- ============================================================================
-- 2026-07-28_reports.sql
-- Reports engine — data layer (Slice 1).
--
-- WHY
--   Saved, parameterised, deterministic reports. A report definition is
--   authored once (by hand now, by the AI author in Slice 3), reviewed, and
--   then runs forever as plain SQL against the yc_readonly pool with no LLM
--   in the loop. Determinism is the whole point: the same report gives the
--   same shape every time, and a wrong answer gets fixed once rather than
--   re-rolled on every question.
--
--   * report_definitions — one row per saved report. `sql_text` is a single
--                          read-only statement with `?` placeholders; `params`
--                          declares what binds into them, in order. Validated
--                          against lib/reportSchema/manifest.js on every save
--                          AND again on every run (a manifest edit can retire
--                          a table out from under a stored report).
--   * report_runs        — append-only execution log. Mirrors the shape of
--                          readonly_query_log so the two feel the same, but
--                          keyed on report_id + the user who ran it.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- RUN THIS FIRST, THEN DEPLOY THE CODE.
-- SQL-first is the inert direction: routes/api.reports.js auto-mounts but only
-- touches these tables when called. Code-first would 500 on every call.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- CREATE TABLE IF NOT EXISTS + INSERT IGNORE on the seeds. Safe to re-run;
-- re-running never overwrites an edited seed (INSERT IGNORE, not REPLACE).
--
-- ── mysql2 HAZARD ───────────────────────────────────────────────────────────
-- `params`, `columns`, `viz` and `caveats` are JSON columns. mysql2 returns
-- them PARSED; binding an object back to a `?` placeholder MUST be
-- JSON.stringify()'d first or you get malformed SQL / silent data loss.
-- services/reportService.js does this at every write site.
--
-- ── SEED DATA NOTE ──────────────────────────────────────────────────────────
-- The four seeded reports are deliberately conservative: every one of them
-- was executed against live data on 2026-07-28 and returns sensible rows.
-- They double as fixtures proving the validator accepts real-world SQL.
-- Their `caveats` are not decoration — they are the honest limitations of
-- the underlying columns (see lib/reportSchema/manifest.js).
-- ============================================================================

CREATE TABLE IF NOT EXISTS report_definitions (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_key    VARCHAR(60)  NOT NULL,             -- stable slug, immutable after create
  title         VARCHAR(150) NOT NULL,
  description   TEXT         NULL,                 -- what this counts AND what it excludes
  category      VARCHAR(40)  NOT NULL DEFAULT 'General',
  sql_text      TEXT         NOT NULL,             -- ONE read-only statement, `?` placeholders
  params        JSON         NULL,                 -- [{name,type,label,default,required}] — ORDER = bind order
  columns_meta  JSON         NULL,                 -- [{key,label,format}] — display hints, optional
  viz           JSON         NULL,                 -- {type,x,y} | null
  caveats       JSON         NULL,                 -- ["free text limitation", ...]
  row_limit     INT UNSIGNED NOT NULL DEFAULT 1000,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by    INT          NULL,                 -- users.user
  updated_by    INT          NULL,
  source        VARCHAR(16)  NOT NULL DEFAULT 'manual', -- 'manual' | 'ai'
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_report_key (report_key),
  KEY idx_active_category (is_active, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS report_runs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  report_id    INT UNSIGNED NULL,                  -- NULL for ad-hoc / preview runs
  report_key   VARCHAR(60)  NULL,
  run_by       INT          NULL,                  -- users.user
  params_json  JSON         NULL,                  -- values actually bound
  sql_text     TEXT         NULL,
  row_count    INT          NULL,
  duration_ms  INT          NULL,
  status       VARCHAR(40)  NOT NULL,              -- success | rejected_* | error
  error_text   TEXT         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_report_created (report_id, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ── SEEDS ───────────────────────────────────────────────────────────────────
-- All four verified against live data 2026-07-28.

INSERT IGNORE INTO report_definitions
  (report_key, title, description, category, sql_text, params, columns_meta, viz, caveats, row_limit, source)
VALUES
(
  'cases_by_stage',
  'Cases by stage',
  'Live count of every case grouped by its CURRENT stage. This is a point-in-time snapshot, not a history — a case that moved Open → Filed → Closed appears only under Closed.',
  'Cases',
  'SELECT case_stage AS stage, COUNT(*) AS n\n  FROM cases\n GROUP BY case_stage\n ORDER BY n DESC',
  JSON_ARRAY(),
  JSON_ARRAY(JSON_OBJECT('key','stage','label','Stage','format','text'),
             JSON_OBJECT('key','n','label','Cases','format','number')),
  JSON_OBJECT('type','bar','x','stage','y','n'),
  JSON_ARRAY('cases.case_stage has no history table, so stage-transition and time-in-stage questions cannot be answered from it.'),
  1000, 'manual'
),
(
  'cases_opened_by_month',
  'Cases opened by month',
  'Cases counted by the month of case_open_date, within the supplied date window. Cases with no open date (about 21% of rows) are excluded entirely.',
  'Cases',
  'SELECT DATE_FORMAT(case_open_date, ''%Y-%m'') AS month, COUNT(*) AS n\n  FROM cases\n WHERE case_open_date IS NOT NULL\n   AND CAST(case_open_date AS CHAR) <> ''0000-00-00''\n   AND case_open_date >= ?\n   AND case_open_date <= ?\n GROUP BY month\n ORDER BY month',
  JSON_ARRAY(
    JSON_OBJECT('name','start','type','date','label','From','default','-365d','required',true),
    JSON_OBJECT('name','end','type','date','label','To','default','today','required',true)
  ),
  JSON_ARRAY(JSON_OBJECT('key','month','label','Month','format','text'),
             JSON_OBJECT('key','n','label','Opened','format','number')),
  JSON_OBJECT('type','line','x','month','y','n'),
  JSON_ARRAY('case_open_date is NULL on roughly 21% of cases; those rows are excluded.',
             'A handful of rows carry a 0000-00-00 zero-date and are filtered out via CAST AS CHAR.'),
  1000, 'manual'
),
(
  'appointment_outcomes',
  'Appointment outcomes',
  'Appointments grouped by status within the supplied date window, using appt_date. Counts appointments, not distinct clients — one client rescheduling three times contributes three rows.',
  'Appointments',
  'SELECT COALESCE(NULLIF(appt_status, ''''), ''(blank)'') AS status, COUNT(*) AS n\n  FROM appts\n WHERE appt_date >= ?\n   AND appt_date <= ?\n GROUP BY status\n ORDER BY n DESC',
  JSON_ARRAY(
    JSON_OBJECT('name','start','type','date','label','From','default','-90d','required',true),
    JSON_OBJECT('name','end','type','date','label','To','default','today','required',true)
  ),
  JSON_ARRAY(JSON_OBJECT('key','status','label','Status','format','text'),
             JSON_OBJECT('key','n','label','Appointments','format','number')),
  JSON_OBJECT('type','bar','x','status','y','n'),
  JSON_ARRAY('Counts appointments, not distinct clients.',
             'appt_date is local-time; appt_date_utc exists separately. This report uses appt_date.',
             'A few rows have an empty appt_status and show as (blank).'),
  1000, 'manual'
),
(
  'communication_volume_by_type',
  'Communication volume by type',
  'Log entries grouped by log_type within the supplied date window. This is the activity log, so it counts logged communications only — anything that never produced a log row is invisible here.',
  'Activity',
  'SELECT COALESCE(NULLIF(log_type, ''''), ''(blank)'') AS log_type, COUNT(*) AS n\n  FROM log\n WHERE log_date >= ?\n   AND log_date <= ?\n GROUP BY log_type\n ORDER BY n DESC',
  JSON_ARRAY(
    JSON_OBJECT('name','start','type','date','label','From','default','-30d','required',true),
    JSON_OBJECT('name','end','type','date','label','To','default','today','required',true)
  ),
  JSON_ARRAY(JSON_OBJECT('key','log_type','label','Type','format','text'),
             JSON_OBJECT('key','n','label','Entries','format','number')),
  JSON_OBJECT('type','bar','x','log_type','y','n'),
  JSON_ARRAY('Counts log rows, not distinct conversations or threads.',
             'SMS dominates by volume and will flatten the chart against smaller types.'),
  1000, 'manual'
);
