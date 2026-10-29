-- YisraMail P3 — email unsubscribe surface (2026-10-30). ref/YISRAMAIL_DESIGN.md §4.2, §4.5.
--
-- One NEW table; no ALTER of a live table. Re-runnable (CREATE ... IF NOT
-- EXISTS). Applied by scripts/yisramailP3Migrate.js --apply, which also
-- verifies the end state (columns, the token's utf8mb4_bin collation, keys).
--
-- DEPLOY ORDER (absolute):
--   1. node scripts/yisramailP3Migrate.js            (CHECK — read-only)
--   2. node scripts/yisramailP3Migrate.js --apply    (this file)
--   3. backend deploy (routes/unsubActions.js reads and writes this table)
--
-- Needs P1's comm_topics (the script refuses without it). Nothing mints a
-- token until C2 wires executeSend; P3 ships the surface only.
--
-- `token` is utf8mb4_bin: base62 is case-SENSITIVE (lib/token.js header),
-- the same precedent as the five 2026-10-05 token columns. `destination` is
-- utf8mb4_general_ci like comm_consent_events.destination (stored lowercased).

CREATE TABLE IF NOT EXISTS comm_unsub_tokens (
  token        char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'lib/token.js base62; the bearer in /u/<token> (landing origin). Never expires (CAN-SPAM: works >= 30 days after the send; kept forever)',
  channel      enum('email') NOT NULL DEFAULT 'email' COMMENT 'email only: SMS opt-out is a keyword (P2), never a link',
  destination  varchar(254) NOT NULL COMMENT 'normalized address (contactEmailService.normalizeEmail) — the consent subject every /u/ action records against',
  topic_key    varchar(40)  NOT NULL COMMENT 'comm_topics.topic_key of the send; the one-click POST opts out of THIS (D4). A topic deleted since mint falls back to scope marketing',
  campaign_id  int NULL COMMENT 'campaigns.id of the send that minted it (NULL: test/smoke mints)',
  contact_id   int unsigned NULL COMMENT 'best-effort attribution at mint; consent belongs to the destination, not the contact',
  send_ref     varchar(64)  NULL COMMENT 'campaign_results id / provider message id passed at mint; copied onto the consent event (comm_consent_events.send_ref)',
  created_at   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC mint time',
  used_at      datetime NULL COMMENT 'UTC first POST (one-click or page form); the link keeps working after',
  PRIMARY KEY (token),
  KEY ix_dest (destination),
  KEY ix_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Per-recipient email unsubscribe capability (one per marketing send). Minted only by services/unsubService.mintUnsubToken; every consent change it carries goes through optoutService.recordConsent';
