-- Canonical, user-scoped request idempotency — Ask Casey actions P4-minimal.
--
-- One row per (acting user, server-chosen operation, caller-minted key): the
-- claim that makes a create exactly-once across repeat submissions (two tabs,
-- or a socket timeout after the server committed). Read by
-- lib/requestIdempotency.js; the create routes that honour the
-- `Idempotency-Key` header are listed in that module's header.
--
-- Apply BEFORE deploying the matching backend (SQL -> backend -> frontend).
-- Run it through `node scripts/caseyP4Idempotency.js --apply`, NOT the SU
-- console: the FK takes a shared metadata lock on `users`, so the session
-- needs a low lock_wait_timeout, and /admin/db/batch cannot give one statement
-- the session setting meant for it.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS only, no ALTER, no guarded
-- SET @sql / PREPARE group.

CREATE TABLE IF NOT EXISTS request_idempotency (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     TINYINT NOT NULL
              COMMENT 'users.user of the acting staff member; 0 (Automations) when the request carries no staff user, e.g. an x-api-key caller. Part of the unique key: one user can never replay another user''s result',
  scope       VARCHAR(64) NOT NULL
              COMMENT 'operation name, one fixed literal chosen server-side per route (tasks.create, appts.create, ...). Never read from the request, so a caller cannot aim a key at another operation',
  idem_key    VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
              COMMENT 'opaque key from the Idempotency-Key request header. utf8mb4_bin (not the table default general_ci) because it is a token, never a join key: two keys differing only in case must stay two keys. App-validated to 8-100 chars of [A-Za-z0-9._:-] before any write — sql_mode is relaxed, so a longer key would store TRUNCATED and alias two keys into one false replay',
  status      ENUM('in_flight','applied') NOT NULL DEFAULT 'in_flight'
              COMMENT 'in_flight = claimed, outcome not yet known; applied = the operation committed and `result` holds its canonical response. An operation that FAILED deletes its row, so the key is reusable. A row left in_flight (process died between claim and settle) is the UNKNOWN outcome: a repeat is refused 409 and the row is never taken over — a takeover is the double-apply this table exists to prevent',
  result      JSON NULL
              COMMENT 'the canonical route result, replayed value-for-value to a repeat of the same key (MySQL re-orders JSON object keys on write, so the replayed bytes are not identical - compare key-order-insensitively). Never auth/session material and never raw sensitive evidence',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
              COMMENT 'claim time, then settle time. The in_flight staleness window is measured from it SERVER-side (TIMESTAMPDIFF against NOW()), never in JS',
  PRIMARY KEY (id),
  UNIQUE KEY uq_request_idempotency_actor_scope_key (user_id, scope, idem_key),
  KEY idx_request_idempotency_created (created_at),
  CONSTRAINT fk_request_idempotency_user FOREIGN KEY (user_id) REFERENCES users (`user`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Request idempotency claims: makes a wired create exactly-once per caller-minted key. lib/requestIdempotency.js';

-- RETENTION: rows are small and the firm is four users, so nothing prunes them
-- today. idx_request_idempotency_created exists so a later sweep can delete by
-- age (an `applied` row only needs to outlive the window in which a client
-- could resubmit the same key).

-- ROLLBACK (the table is inert to any caller that sends no Idempotency-Key):
--   DROP TABLE request_idempotency;
