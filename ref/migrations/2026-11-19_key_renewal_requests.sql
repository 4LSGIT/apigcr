-- key-renew-req S1 (2026-11-19): session-key renewal requests.
-- Applied by scripts/keyRenewalRequestsMigrate.js (CHECK / --apply), which
-- reads this file, so the file and the applied schema cannot differ.
-- One statement; each ends with ';' at end of line.
CREATE TABLE IF NOT EXISTS key_renewal_requests (
  id int NOT NULL AUTO_INCREMENT COMMENT 'Request id; the email link names it (?open=tabPanel~adminReadonlyKeys~renew-<id>).',
  key_id int NOT NULL COMMENT 'The session key (readonly_api_keys.id) asking to be renewed. Always a ROOT key: a child is renewed by its manager key, never through a request.',
  reason varchar(200) NOT NULL COMMENT 'Why the session needs the key back, in its own words. Plain text, 10-200 chars, validated in routes/api.keyRenewalRequests.js; shown escaped in the email and the pane.',
  requested_ttl_min int DEFAULT NULL COMMENT 'TTL the session asked for, in minutes (checked against the renew caps at request time); NULL = the key kind''s default.',
  notify_user int NOT NULL COMMENT 'users.user emailed: the key''s created_by at request time.',
  key_expires_at datetime NOT NULL COMMENT 'Snapshot of readonly_api_keys.expires_at when the request was made (UTC). A live key may ask ahead of its expiry.',
  status varchar(16) NOT NULL DEFAULT 'pending' COMMENT 'pending | approved | denied. App-validated. One pending row per key (uk_krr_pending).',
  requested_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC).',
  request_ip varchar(64) DEFAULT NULL,
  user_agent varchar(255) DEFAULT NULL,
  email_error varchar(500) DEFAULT NULL COMMENT 'Why the notification email failed; NULL = sent (the SMTP relay took it). A failed send leaves the request pending and listed in the pane.',
  decided_by int DEFAULT NULL COMMENT 'users.user of the SU who approved or denied.',
  decided_at datetime DEFAULT NULL COMMENT 'UTC.',
  granted_ttl_min int DEFAULT NULL COMMENT 'Approved: the TTL the SU granted, in minutes.',
  new_expires_at datetime DEFAULT NULL COMMENT 'Approved: the key''s new expires_at (UTC), as the renew wrote it.',
  pending_key int GENERATED ALWAYS AS (if((status = 'pending'), key_id, NULL)) STORED COMMENT 'key_id while pending, else NULL: the UNIQUE uk_krr_pending makes one pending request per key, across instances.',
  PRIMARY KEY (id),
  UNIQUE KEY uk_krr_pending (pending_key),
  KEY idx_krr_key (key_id, requested_at),
  KEY idx_krr_status (status, requested_at),
  CONSTRAINT fk_krr_key FOREIGN KEY (key_id) REFERENCES readonly_api_keys (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Session-key renewal requests (key-renew-req, 2026-11-19): an expired (or expiring) ycro_ key asks its creator to renew it; the SU approves in the Session Keys pane, which runs the ordinary renew. The key secret never changes.';
