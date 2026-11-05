-- YisraMail C4 — saved segments (ref/YISRAMAIL_DESIGN.md §6.2, slice C4).
-- Applied by scripts/yisramailC4Migrate.js (CHECK / --apply), which reads this
-- file, so the file and the applied schema can never differ.
-- One statement; no existing table is touched.

CREATE TABLE IF NOT EXISTS campaign_segments (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255) NOT NULL COMMENT 'Display name ("Newsletter — everyone"). Not unique: archive keeps the old row, a re-save may reuse the name.',
  filter_json JSON NOT NULL COMMENT 'The saved contact filter: exactly the GET /api/campaigns/contacts keys (tags[], case_type, case_subtype, case_stage[], case_open_after, case_open_before, channel). {} = everyone. Validated on every save by campaignSegmentService (unknown key refused); RE-RUN when picked in compose — never a frozen contact list, and never class/topic (those belong to the campaign being composed).',
  created_by  TINYINT UNSIGNED NULL COMMENT 'users.user of the author; NULL when the user is gone.',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived    TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = hidden from the compose picker; rows are archived, never deleted (a campaign may have been built from one).',
  PRIMARY KEY (id),
  KEY ix_archived_updated (archived, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='YisraMail C4 (§6.2): saved audience filters for campaign compose. The filter is re-evaluated at pick time; campaign recipients still freeze at create and consent is re-checked per recipient at send.';
