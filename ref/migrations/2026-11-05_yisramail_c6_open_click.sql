-- YisraMail C6 — open/click tracking (ref/YISRAMAIL_DESIGN.md §6.5 "As built (C6)").
-- Applied by scripts/yisramailC6Migrate.js (CHECK / --apply; one connection,
-- time_zone +00:00, lock_wait_timeout 10 — the ALTERs take a brief MDL on a
-- live table). DEPLOY ORDER: this → backend → frontend → the SES config-set
-- flip (custom redirect domain + Open/Click event types); events arriving
-- before the flip don't exist, events arriving before the backend deploy are
-- counted `ignored` by the old parser — both harmless.
-- One ALTER per column so a failed run resumes per statement.

ALTER TABLE campaign_results ADD COLUMN opened_at datetime(3) DEFAULT NULL COMMENT 'UTC time of the first SES Open OR Click event for this send (mail_event_ingest — a click proves an open). Set once, engagement axis: never touches delivery_status. Apple MPP prefetch inflates opens; clicks are the honest signal (C6). NULL = no event (every send before C6, and every send while the config set did not publish Open/Click)';

ALTER TABLE campaign_results ADD COLUMN clicked_at datetime(3) DEFAULT NULL COMMENT 'UTC time of the first SES Click event for this send (mail_event_ingest). Set once. Per-link detail in campaign_clicks. Footer unsubscribe/preference links carry ses:no-track, so an unsubscribe never counts as engagement (C6)';

CREATE TABLE IF NOT EXISTS campaign_clicks (
  click_id int unsigned NOT NULL AUTO_INCREMENT,
  campaign_id int NOT NULL COMMENT 'the campaign the clicked send belongs to (correlated like every SES event: result_id+campaign_id tags, provider_message_id second)',
  result_id int NOT NULL COMMENT 'the campaign_results row of the recipient who clicked. Uncorrelated clicks (no row — e.g. a C7 triggered send) are not stored',
  link varchar(512) COLLATE utf8mb4_bin NOT NULL COMMENT 'the clicked URL as SES reports it (detail.click.link), truncated to 512 — grouping and display only. utf8mb4_bin: URL paths/queries are case-sensitive, GROUP BY must not merge case variants',
  clicked_at datetime(3) NOT NULL COMMENT 'UTC event time (detail.click.timestamp)',
  provider_event_id varchar(128) NOT NULL COMMENT 'EventBridge event id + recipient (ses.js eventIdFor) — the idempotency key: a replayed or hook-retried event inserts nothing (uk_provider_event). The INSERT is INSERT IGNORE inside the event transaction',
  PRIMARY KEY (click_id),
  UNIQUE KEY uk_provider_event (provider_event_id),
  KEY ix_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='one row per SES Click event on a correlated marketing send (C6). getCampaign aggregates per link. Low volume: every click a recipient makes, firm-sized lists';
