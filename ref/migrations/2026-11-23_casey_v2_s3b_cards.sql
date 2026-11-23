-- Casey v2 S3b (2026-11-23): the cards api_write proposes, and the ledger of their steps
-- (ref/CASEY_V2_DESIGN.md §4.4–4.5, §8.6; as built §9 S3b). Applied by
-- scripts/caseyV2S3bMigrate.js (CHECK / --apply), which reads this file, so the file
-- and the applied schema cannot differ. Runs BEFORE the S3b backend deploys
-- (SQL → backend). Two statements, in this order (the FKs); each ends with ';' at
-- end of line. casey_chats and casey_messages (S2, S3a) are untouched.
CREATE TABLE IF NOT EXISTS casey_cards (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  chat_id bigint unsigned NOT NULL COMMENT 'The chat whose turn proposed the card (casey_chats.id; cascade).',
  user_id int NOT NULL COMMENT 'users.user who owns the chat — the only identity that may read, approve, decline or resume the card. The steps run AS this user through the shell''s apiSend.',
  tool_use_id varchar(64) NOT NULL COMMENT 'The api_write tool_use block id (casey_messages content) this card answers; the tool''s own result in that turn is only "card proposed". The outcome reaches the model as the FIRST text block of the next user message, built from casey_card_steps, never from the browser''s words.',
  tier tinyint NOT NULL COMMENT 'The highest lib/caseySensitivity tier among the steps: 1 ordinary write (collapsed details), 2 sensitive (the exact content shown open), 3 superuser (labelled; the elevation prompt comes from apiSend). A T3 card is only ever created for a superuser.',
  summary varchar(300) NOT NULL COMMENT 'The model''s one-line summary of the card — may be wrong; the step rows are the truth.',
  status enum('proposed','approved','declined','resumed') NOT NULL DEFAULT 'proposed' COMMENT 'proposed: waiting for the user. approved: the user clicked Approve (set by the first step claim). declined: the user declined (note in decline_note), or sent another message instead (implicit). resumed: the outcome was fed to the model (terminal; set by POST /api/casey/turn/resume or by the plain turn that resolved it).',
  decline_note varchar(500) DEFAULT NULL COMMENT 'The user''s optional reason on Decline; the fixed implicit text when they continued without acting.',
  resumed_at datetime DEFAULT NULL COMMENT 'UTC. When the outcome went to the model.',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC).',
  PRIMARY KEY (id),
  KEY idx_casey_cards_chat (chat_id, status),
  CONSTRAINT fk_casey_cards_chat FOREIGN KEY (chat_id) REFERENCES casey_chats (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Casey v2 cards (ref/CASEY_V2_DESIGN.md §4.4): one row per api_write proposal — a write (or an ordered list of writes) the model wants the user to approve. The steps are casey_card_steps rows. Deleting the chat deletes them.';
CREATE TABLE IF NOT EXISTS casey_card_steps (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  card_id bigint unsigned NOT NULL,
  step_no tinyint NOT NULL COMMENT 'Position on the card, from 1. Steps are claimed in order: step N is claimable only when every earlier step is applied.',
  method varchar(8) NOT NULL COMMENT 'POST, PUT, PATCH or DELETE (a card never carries a GET).',
  path varchar(2000) NOT NULL COMMENT 'The concrete path the browser calls, query string included — the route lib/routeCatalog.findRoute matched at proposal time was proposable (lib/caseySensitivity) and allowed for this user.',
  body longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'The request body as JSON TEXT — the EXACT bytes the browser sends (apiSend takes a string body as is), so what the card shows is byte-for-byte what the route receives. NULL for a step without a body.',
  tier tinyint NOT NULL COMMENT 'This step''s own lib/caseySensitivity tier (the card''s tier is the max).',
  purpose varchar(300) NOT NULL COMMENT 'The model''s one line on why this step (shown on the card).',
  status enum('pending','claimed','applied','failed','declined','skipped') NOT NULL DEFAULT 'pending' COMMENT 'pending: not yet run. claimed: the browser took the claim and is about to send (POST /api/casey/cards/:id/claim) — a step still claimed when the card is resumed is reported to the model as UNKNOWN (the request may have landed; it is never re-sent automatically). applied: the route answered 2xx. failed: the route answered an error (http_status). declined: the card was declined while this step was pending. skipped: the card was resumed while this step was still pending (an earlier step failed, or the user stopped).',
  claim_token char(36) DEFAULT NULL COMMENT 'A random receipt handed to the claimer; the settle must carry it, so a stale tab that merely reads the card cannot settle a step it did not run. Never stored in the chat.',
  http_status smallint DEFAULT NULL COMMENT 'The route''s HTTP status, from the settle.',
  result longtext DEFAULT NULL COMMENT 'The route''s JSON answer (or error body) as reported by the browser at settle, cut to 16 KB with a marker. Fed to the model in the outcome message as the step''s result.',
  idempotency_key varchar(100) NOT NULL COMMENT 'casey:<card_id>:<step_no> — sent as the Idempotency-Key header on the step''s request; wired routes (lib/requestIdempotency WIRED_ROUTES) replay the first result, others ignore it. The ledger claim is the double-submit guard either way (§8.6).',
  claimed_at datetime DEFAULT NULL COMMENT 'UTC.',
  settled_at datetime DEFAULT NULL COMMENT 'UTC.',
  PRIMARY KEY (id),
  UNIQUE KEY uk_casey_card_steps_no (card_id, step_no),
  CONSTRAINT fk_casey_card_steps_card FOREIGN KEY (card_id) REFERENCES casey_cards (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Casey v2 card steps (ref/CASEY_V2_DESIGN.md §4.5, §8.6): the generalised action ledger — one row per step of a card, claimed by the browser before the request and settled after it. A claimed step without a settle is unknown and is never re-sent. Deleting the card deletes them.';
