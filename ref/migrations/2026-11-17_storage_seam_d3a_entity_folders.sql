-- ref/migrations/2026-11-17_storage_seam_d3a_entity_folders.sql
--
-- storage-seam D3a (ref/DOCUMENTS_V3_DESIGN.md §3, §9 D3): the entity ↔ folder
-- BINDING ROW — one row per (entity kind, entity id, storage source) carrying the
-- provider's move-stable handle, the path it resolved to, and the human link a
-- person opens. It generalizes TWO things that hold a case's folder today:
-- cases.case_dropbox (a Dropbox shared-link URL — a human link, not a handle) and
-- case_folder_cache (case_id → folder_external_id / path, filled from that link
-- by documentSyncService.refreshCaseFolderCache). Contacts get rows in D3c, when
-- the storage_folders setting can give them a folder.
--
-- D3a is the EXPAND step: the table exists, the backfill copies the 1,105 bound
-- cases (verified 2026-11-17: cases.case_dropbox non-empty = case_folder_cache
-- rows = 1,105, all resolved), and the writers of the old pair DUAL-WRITE it from
-- the deploy that follows. Nothing reads it until D3b. D3d drops the old pair by
-- the retire-a-column gate.
--
-- APPLIED BY scripts/storageSeamD3aEntityFolders.js --apply (one connection,
-- lock_wait_timeout = 5, CREATE IF NOT EXISTS, backfill as INSERT … SELECT with
-- ON DUPLICATE KEY UPDATE — idempotent, resumable — then a verify that every
-- source row has an equal binding row and ends on ONE GO / NO-GO line). This file
-- is the dated record. Run BEFORE the D3a backend deploys (SQL → backend).
--
-- external_id is utf8mb4_bin ON PURPOSE (SCHEMA_CONVENTIONS: an opaque
-- case-sensitive token — a Dropbox id — never a join key to the core tables);
-- after the dump regenerates, ['entity_folders', 'external_id'] joins
-- tests/schemaCollationBin.test.js BIN_COLUMNS (done in the D3a commit, which
-- lands after this has run).

CREATE TABLE IF NOT EXISTS entity_folders (
  entity_kind         ENUM('case','contact') NOT NULL COMMENT 'which table entity_id names: cases.case_id or contacts.contact_id (as a string)',
  entity_id           VARCHAR(20)  NOT NULL COMMENT 'cases.case_id (Crockford or legacy) or contacts.contact_id, per entity_kind',
  source              VARCHAR(20)  NOT NULL DEFAULT 'dropbox' COMMENT 'documents.source vocabulary — the storage provider the folder lives in (documentSourceService)',
  external_id         VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'utf8mb4_bin ON PURPOSE — the provider''s move-stable folder handle (Dropbox id:…, case-sensitive); pairs with documents.external_id. NULL until the link resolved once',
  path_lower          TEXT         COMMENT 'the folder''s path as the provider lowercases it — the attribution key the sync engine walks (path-prefix strategy)',
  path_display        TEXT         COMMENT 'the folder''s path as displayed (every leading space kept)',
  human_link          VARCHAR(512) DEFAULT NULL COMMENT 'the URL a person opens for the folder (Dropbox shared link). The value cases.case_dropbox held; D3b makes that column a read-through alias of this',
  resolve_error       VARCHAR(255) DEFAULT NULL COMMENT 'last error resolving human_link to a handle/path (prior path columns survive, as case_folder_cache did); NULL when resolved',
  resolved_at         DATETIME     DEFAULT NULL COMMENT 'UTC. last successful or failed resolution',
  relink_dismissed_at DATETIME     DEFAULT NULL COMMENT 'UTC. staff dismissed the relink suggestion for this entity (documentSyncService relink)',
  relink_dismissed_by TINYINT      DEFAULT NULL COMMENT 'users.user who dismissed',
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC',
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'UTC',
  PRIMARY KEY (entity_kind, entity_id, source),
  KEY idx_entity_folders_ext (source, external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='One row per (entity, storage source): the folder the entity''s documents file into — handle, path, human link. Generalizes cases.case_dropbox + case_folder_cache (storage-seam D3a, 2026-11-17)';

-- Backfill (idempotent; the script runs it, verifies it, and reports):
-- INSERT INTO entity_folders
--   (entity_kind, entity_id, source, external_id, path_lower, path_display, human_link,
--    resolve_error, resolved_at, relink_dismissed_at, relink_dismissed_by)
-- SELECT 'case', c.case_id, 'dropbox', f.folder_external_id, f.path_lower, f.path_display,
--        NULLIF(TRIM(c.case_dropbox), ''), f.resolve_error, f.resolved_at,
--        f.relink_dismissed_at, f.relink_dismissed_by
--   FROM cases c LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
--  WHERE (c.case_dropbox IS NOT NULL AND c.case_dropbox <> '') OR f.case_id IS NOT NULL
-- ON DUPLICATE KEY UPDATE external_id = VALUES(external_id), path_lower = VALUES(path_lower),
--   path_display = VALUES(path_display), human_link = VALUES(human_link),
--   resolve_error = VALUES(resolve_error), resolved_at = VALUES(resolved_at),
--   relink_dismissed_at = VALUES(relink_dismissed_at), relink_dismissed_by = VALUES(relink_dismissed_by);
