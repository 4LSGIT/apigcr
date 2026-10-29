-- YisraMail P1 — consent core (2026-10-29). ref/YISRAMAIL_DESIGN.md §4.2.
--
-- Three NEW tables; no ALTER of a live table, so plain statements are fine
-- (each runs on its own pooled connection in the SU DB console — nothing here
-- needs a session setting). Re-runnable: CREATE ... IF NOT EXISTS and an
-- idempotent seed.
--
-- DEPLOY ORDER (absolute):
--   1. this file (SU DB console, or any root session)
--   2. node scripts/yisramailP1MigrateConsent.js --apply   (today's flags → the ledger)
--   3. backend deploy
--   4. node scripts/yisramailP1MigrateConsent.js --apply   (again: a flag written in the gap)
--
-- `destination` is utf8mb4_general_ci — the collation of contact_phones.phone
-- and contact_emails.email (verified live 2026-10-29), so the reader's joins
-- need no COLLATE clause. Addresses are stored lowercased anyway.
-- comm_unsub_tokens (design §4.2) is NOT here — it is slice P3.

CREATE TABLE IF NOT EXISTS comm_topics (
  topic_key     varchar(40)  NOT NULL COMMENT 'scope name a consent row / send uses for this topic; [a-z0-9_]{1,40} (optoutService interpolates it into SQL, the shape is load-bearing)',
  channel       enum('email','sms') NOT NULL COMMENT 'the one channel this topic belongs to; a marketing send on another channel treats the topic as unknown (blocked)',
  label         varchar(100) NOT NULL COMMENT 'shown on the preference page (P3)',
  description   varchar(255) NULL COMMENT 'shown on the preference page (P3)',
  consent_model enum('opt_out','opt_in') NOT NULL COMMENT 'opt_out: sendable unless opted out; opt_in: sendable ONLY with state(topic)=opted_in (marketing SMS, D1)',
  active        tinyint(1) NOT NULL DEFAULT 1 COMMENT '0 = retired: a marketing send naming it is blocked for every destination (fail closed)',
  created_at    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (topic_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='YisraMail marketing topics (config-as-data). Read only through services/optoutService.js';

CREATE TABLE IF NOT EXISTS comm_consent_events (
  id                bigint unsigned NOT NULL AUTO_INCREMENT,
  channel           enum('email','sms') NOT NULL,
  destination       varchar(254) NOT NULL COMMENT 'normalized: 10 digits (contactPhoneService.normalizePhone) | trimmed lowercased address (contactEmailService.normalizeEmail)',
  scope             varchar(40)  NOT NULL COMMENT 'sms: all | topic; email: marketing | topic. There is NO email all (D18: an email opt-out is marketing-only)',
  action            enum('opt_out','opt_in') NOT NULL,
  source            varchar(32)  NOT NULL COMMENT 'staff | unsub_page | one_click | pref_page | sms_keyword | sms_review | provider_optout | provider_bounce | provider_complaint | import | web_form | migration | row_replace (app-validated, optoutService.SOURCES)',
  provider_event_id varchar(128) NULL COMMENT 'dedup key with source (uk_source_event): a provider event id, or migration:phone|email:<row id>; NULL never collides',
  occurred_at       datetime(3)  NOT NULL COMMENT 'UTC; when it happened (provider time when known). Orders the state: (occurred_at, id) newest wins',
  contact_id        int unsigned NULL COMMENT 'best-effort attribution at the time — consent belongs to the destination, not the contact',
  line_number       char(10) NULL COMMENT 'SMS: the firm line it arrived on / was sent from',
  send_ref          varchar(64)  NULL COMMENT 'campaign_results id / provider message id',
  evidence          json NULL COMMENT 'proof: row_id, via (casey + draft_id), ip, user_agent, keyword text, raw inbound body, consent wording, form id …',
  actor_user_id     int NULL COMMENT 'users.user of a staff change; NULL for automation / provider / migration',
  created_at        datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_dest (channel, destination, occurred_at),
  UNIQUE KEY uk_source_event (source, provider_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Consent ledger (the proof). Append-only: never updated, never deleted. ONE writer: optoutService.recordConsent';

CREATE TABLE IF NOT EXISTS comm_consent_state (
  channel       enum('email','sms') NOT NULL,
  destination   varchar(254) NOT NULL COMMENT 'same normalization as comm_consent_events.destination',
  scope         varchar(40)  NOT NULL,
  state         enum('opted_out','opted_in') NOT NULL,
  occurred_at   datetime(3) NOT NULL COMMENT 'occurred_at of the event that set this row',
  last_event_id bigint unsigned NOT NULL COMMENT 'comm_consent_events.id that set this row; an event wins only if (occurred_at, id) is newer',
  updated_at    datetime(3) NOT NULL,
  PRIMARY KEY (channel, destination, scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Current consent per (channel, destination, scope) — THE truth sends read (D2 a). contact_phones.sms_optout / contact_emails.email_optout cache the sms all / email marketing rows for one release. Written ONLY by optoutService.recordConsent';

INSERT INTO comm_topics (topic_key, channel, label, description, consent_model)
VALUES ('newsletter', 'email', 'Newsletter', 'The firm''s monthly newsletter and occasional announcements', 'opt_out')
ON DUPLICATE KEY UPDATE topic_key = topic_key;
