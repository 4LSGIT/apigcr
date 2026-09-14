-- ─────────────────────────────────────────────────────────────────────────
-- YisraCase — Documents feature, Slice S1
-- Apply BEFORE deploying the backend. Deploy order: SQL → backend → (no FE).
--
-- ⚠️ ONE DEVIATION FROM THE S1 SPEC, and it is not optional:
--    the spec named a column `cursor`, which is a RESERVED WORD in MySQL.
--    Verified against the live server (8.4.6): `EXPLAIN SELECT cursor FROM …`
--    -> ER_PARSE_ERROR, while all 30 other column names in this DDL return
--    ER_BAD_FIELD_ERROR (i.e. usable). CREATE TABLE document_sync_roots would
--    have failed outright. Renamed to `sync_cursor`.
--    S1 ships ZERO code touching this table (it is S2's), so renaming now is
--    free; after S2 it would not be. If the original name is required for
--    some reason, `cursor` TEXT NULL (backticked) also works — but then every
--    future query touching it must backtick it too, forever.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source VARCHAR(20) NOT NULL DEFAULT 'dropbox',
  external_id VARCHAR(191) NOT NULL,
  name VARCHAR(512) NOT NULL,
  path TEXT NULL,
  path_lower TEXT NULL,
  path_hash CHAR(40) NULL,
  ext VARCHAR(20) NULL,
  mime VARCHAR(128) NULL,
  size BIGINT UNSIGNED NULL,
  content_hash CHAR(64) NULL,
  rev VARCHAR(64) NULL,
  server_modified DATETIME NULL,
  shared_link VARCHAR(512) NULL,
  title VARCHAR(255) NULL,
  doc_type VARCHAR(64) NULL,
  tags VARCHAR(512) NULL,
  ai_meta JSON NULL,
  status ENUM('active','deleted','missing') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_source_ext (source, external_id),
  KEY idx_docs_path_hash (path_hash),
  KEY idx_docs_type (doc_type),
  KEY idx_docs_status (status),
  KEY idx_docs_updated (updated_at),
  FULLTEXT KEY ft_docs (name, title, tags)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE document_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  link_type VARCHAR(32) NOT NULL,
  link_id VARCHAR(64) NOT NULL,
  relation VARCHAR(32) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_target (document_id, link_type, link_id),
  KEY idx_dl_target (link_type, link_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE document_sync_roots (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  path VARCHAR(512) NOT NULL,
  note VARCHAR(255) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  sync_cursor TEXT NULL,          -- was `cursor` in the spec: RESERVED WORD
  last_sync_at DATETIME NULL,
  last_error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed roots. LEADING SPACES ARE SIGNIFICANT AND EXACT — apply via a tool that
-- does not trim. All four real roots were confirmed to exist on 2026-08-26;
-- the three "Unsorted" roots do NOT exist yet (files/get_metadata -> 409
-- path/not_found) and are lazily created, so S2's sync must treat
-- path/not_found on a root as EMPTY, not as an error.
INSERT INTO document_sync_roots (path, note) VALUES
('/  Law Office/   Cases/  Active Cases',              'template tree — active'),
('/  Law Office/   Cases/  Potential Cases',           'template tree — potential'),
('/  Law Office/   Cases/ Closed Cases',               'closed — watched to survive Active→Closed moves'),
('/  Law Office/   ActiveCases',                       'parallel 2026 tree (staff-made)'),
('/  Law Office/   Cases/  Unsorted Client Uploads',   'lazy-created by upload ladder'),
('/  Law Office/   Cases/  Unsorted E-Signed Documents','lazy-created by e-sign filing'),
('/  Law Office/   Cases/  Unsorted Form Submissions', 'lazy-created by form PDFs');

-- Verify the spaces survived (each path should show its exact leading spaces):
-- SELECT id, CONCAT('[', path, ']') FROM document_sync_roots;
