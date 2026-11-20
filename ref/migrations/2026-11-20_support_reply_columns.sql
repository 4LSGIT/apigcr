-- Support Inbox replies: what was sent back to a Help & Support report's filer
-- (services/issueReportService.js respond()).
-- Applied by scripts/supportReplyColumns.js on one connection, with
-- lock_wait_timeout = 5. Recorded here; run the script, not this.

ALTER TABLE issue_reports
  ADD COLUMN resolution varchar(24) NULL DEFAULT NULL COMMENT 'outcome key of the last reply that went out to the reporter (services/issueReportService.js OUTCOMES — app-validated per kind); NULL = never replied (a silent resolve leaves it NULL)' AFTER resolved_by,
  ADD COLUMN reply_message text NULL DEFAULT NULL COMMENT 'the personal note in the last reply that went out, plain text (escaped into the email); NULL = generic text only' AFTER resolution,
  ADD COLUMN replied_at datetime NULL DEFAULT NULL COMMENT 'UTC — when the last reply to the reporter went out; written only after the send succeeds' AFTER reply_message,
  ADD COLUMN reply_error varchar(255) NULL DEFAULT NULL COMMENT 'why the last reply ATTEMPT failed; NULL once a reply goes out. A failure writes only this — an earlier reply record (resolution / replied_at) stands' AFTER replied_at,
  ADD COLUMN reply_claimed_at datetime NULL DEFAULT NULL COMMENT 'UTC — set while a reply send is in flight (respond() claim), NULL otherwise; blocks a second send; older than 15 min = abandoned and may be taken over' AFTER reply_error,
  ALGORITHM=INSTANT;
