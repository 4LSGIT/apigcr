-- YisrAI recent chats — user-private convenience history.
--
-- Apply before deploying the matching backend. Re-runnable; no ALTERs or
-- session variables. SQL/query audit remains in report_runs: these tables hold
-- only the conversation shown to the user and structured record-link metadata.

CREATE TABLE IF NOT EXISTS assistant_chats (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     TINYINT NOT NULL COMMENT 'users.user; ownership boundary for every read/write',
  title       VARCHAR(120) NOT NULL COMMENT 'first question, whitespace-normalized and truncated',
  model_mode  ENUM('better_quality','faster_speed') NOT NULL DEFAULT 'better_quality'
              COMMENT 'product-level model choice; provider model ids remain server-owned',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_chats_user_recent (user_id, updated_at DESC, id DESC),
  CONSTRAINT fk_assistant_chats_user FOREIGN KEY (user_id) REFERENCES users (`user`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Ask YisrAI recent chats, private to the creating staff user';

CREATE TABLE IF NOT EXISTS assistant_chat_messages (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chat_id       BIGINT UNSIGNED NOT NULL,
  role          ENUM('user','assistant') NOT NULL,
  message_text  MEDIUMTEXT NOT NULL,
  payload       JSON NULL COMMENT 'assistant entities, citations, suggestions and compact query-count metadata; never SQL',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assistant_chat_messages_chat (chat_id, id),
  CONSTRAINT fk_assistant_chat_messages_chat FOREIGN KEY (chat_id) REFERENCES assistant_chats (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Ordered messages displayed in one user-private YisrAI chat';

-- The service retains the 30 most recently touched chats per user when a new
-- chat is created. Users can also delete any chat from the YisrAI history UI.
