-- "Report an Issue" — staff-facing panic/idea button (shell header + sidebar).
-- Run in DB console. Single self-contained statement (console runs each
-- statement on its own pooled connection).
--
-- One row per press of the Report an Issue button. The row is the durable
-- record; the email to cfg('email_it') is the notification. Both are written
-- in the same request (see routes/api.issueReports.js) — the email is AWAITED,
-- not detached, because Cloud Run throttles CPU on an idle instance after the
-- response flushes and a detached send can silently never run.
--
-- Soft references only (no FKs — matches existing convention):
--   user_id -> users.user
--
-- user_name is DENORMALIZED on purpose: reports outlive staff turnover and the
-- attribution has to survive a users row being renamed or removed. users.user_name
-- is varchar(20); 64 here leaves room for the "#12 (unknown)" fallback string.
--
-- context: whatever the shell could glean — build, active tab, open files,
-- browser, viewport, and the client-side error ring buffer. Capped at 24KB by
-- the route before insert. NEVER trusted: everything is HTML-escaped on the way
-- into the email.
--
-- NO `DEFAULT CHARSET` clause on purpose — see ref/SCHEMA_CONVENTIONS.md.
-- Omitting it inherits utf8mb4_general_ci; naming the charset without the
-- collation would silently land on utf8mb4_0900_ai_ci and break future joins.

CREATE TABLE issue_reports (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NULL,
  user_name    VARCHAR(64) NULL,
  kind         ENUM('problem','idea','question') NOT NULL DEFAULT 'problem',
  note         TEXT NOT NULL,
  page_url     VARCHAR(1000) NULL,
  context      JSON NULL,
  emailed_at   DATETIME NULL,
  email_error  VARCHAR(255) NULL,
  resolved_at  DATETIME NULL,
  resolved_by  VARCHAR(64) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_issue_reports_created (created_at),
  KEY idx_issue_reports_open (resolved_at, created_at)
) ENGINE=InnoDB;
