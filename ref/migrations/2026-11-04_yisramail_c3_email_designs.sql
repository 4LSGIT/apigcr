-- YisraMail C3a — the designs library (2026-11-04). ref/YISRAMAIL_DESIGN.md §6.3 "As built (C3a)".
--
-- One NEW table (email_designs) and one NULLable column added at the end of a LIVE table
-- (campaigns: 118 rows at write time; every existing row reads NULL — no design). Nothing else
-- touched, no app_settings row.
-- Applied by scripts/yisramailC3Migrate.js --apply on ONE connection with lock_wait_timeout = 10
-- (never paste this into the SU console: the session setting would not reach the ALTER). The
-- script runs the CREATE only when the table is absent and the ALTER only when the column is
-- missing, so a re-run resumes; with everything missing it runs exactly the two statements below
-- (tests/yisramailC3Migrate.mysql.test.js pins that).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailC3Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailC3Migrate.js --apply    (this file, then verify)
--   3. backend deploy (createCampaign INSERTs campaigns.design_id for EVERY campaign, and
--      /api/email-designs reads and writes email_designs — the backend before this file would
--      fail every campaign create)
--
-- No FOREIGN KEY constraints, FKs by convention like the neighbours (campaigns.created_by,
-- image_library.uploaded_by): image_library SOFT-deletes (deleted_at), so a constraint on
-- thumbnail_asset_id would protect nothing a reader does not check anyway; campaigns.design_id
-- is provenance on a live table, and an archived design is never deleted (no delete route).

CREATE TABLE IF NOT EXISTS email_designs (
  id                 int unsigned NOT NULL AUTO_INCREMENT COMMENT 'the design id; campaigns.design_id points here',
  name               varchar(255) NOT NULL COMMENT 'staff-chosen library name (trimmed, 1-255 chars, emailDesignService); not unique — the id is the identity',
  builder            varchar(32) NOT NULL DEFAULT 'grapesjs-mjml' COMMENT 'the editor that wrote design_json (D9: GrapesJS + grapesjs-mjml); the only value written today. A design_json is meaningful only to its builder',
  design_json        json NOT NULL COMMENT 'the builder''s project data (GrapesJS getProjectData: assets, styles, pages, symbols, dataSources). REJECTED on save unless it passes lib/emailDesignRules rules 1-9 (the C3 spike findings'' server rules) — validated, never stripped or repaired. MySQL re-orders JSON object keys on write: compare key-order-insensitively',
  html               mediumtext NOT NULL COMMENT 'the compiled email HTML (MJML output) the editor sent alongside design_json; validated INDEPENDENTLY of design_json (rules 7-10 — never assumed to equal compile(design_json)); holds exactly one <!-- yc:footer-slot --> marker inside <body>, where C2 injects the compliance footer (campaignService.injectFooter)',
  text               mediumtext NOT NULL COMMENT 'the plain-text part the editor derived; stored as sent (no rule applies). A campaign''s send derives its own text part (campaignService.textPartFor) — this copy is the library''s',
  thumbnail_asset_id int unsigned NULL COMMENT 'image_library.id of a preview image (FK by convention, no constraint — image_library soft-deletes, so a reader checks deleted_at). Nothing writes it in C3a: the API contract carries no thumbnail. NULL = none',
  created_by         tinyint unsigned NULL COMMENT 'users.user of the creator (req.auth.userId; NULL for an API key without a user). Same type as campaigns.created_by',
  created_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC create time',
  updated_at         datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'UTC last change (a save or an archive toggle); the library list sorts by it, newest first',
  archived           tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = hidden from the default library list (GET /api/email-designs without include_archived) and refused as a new campaign''s design_id (400 design_archived); still readable by id and still the provenance of campaigns that used it. Toggled by PATCH /api/email-designs/:id {archived}. Never deleted (no delete route)',
  PRIMARY KEY (id),
  KEY ix_archived_updated (archived, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='YisraMail designs library (C3, ref/YISRAMAIL_DESIGN.md §6.3): reusable newsletter designs from the Designer editor. Written only by services/emailDesignService.js, which validates design_json AND html on every save (reject, never strip)';

ALTER TABLE campaigns
  ADD COLUMN design_id int unsigned NULL COMMENT 'email_designs.id the body was composed from (C3, FK by convention, no constraint): provenance for "duplicate last month''s" — never re-read at send. createCampaign accepts it only for an EMAIL campaign naming an existing, non-archived design (400 unknown_design / design_archived / design_not_email); the body stays exactly what the caller sent (the send renders campaigns.body, not the design). NULL = composed without the Designer';
