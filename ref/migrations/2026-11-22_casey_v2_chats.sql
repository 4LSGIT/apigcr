-- Casey v2 S2 (2026-11-22): the chats of the tool-use loop (ref/CASEY_V2_DESIGN.md §4.6).
-- Applied by scripts/caseyV2ChatsMigrate.js (CHECK / --apply), which reads this
-- file, so the file and the applied schema cannot differ. Runs BEFORE the S2
-- backend deploys (SQL → backend). Two statements, in this order (the FK);
-- each ends with ';' at end of line.
CREATE TABLE IF NOT EXISTS casey_chats (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  user_id int NOT NULL COMMENT 'users.user; the ownership boundary for every read and write. A transcript is private to the person who had it, superusers included, until the S4 review view reads with its own gate.',
  title varchar(120) NOT NULL COMMENT 'The first message, whitespace-normalised and cut.',
  model varchar(64) NOT NULL COMMENT 'The Claude model id FROZEN at creation (casey_v2_model then). The model''s thinking blocks are bound to it, so a chat never changes model; a settings change applies to new chats.',
  effort varchar(16) NOT NULL COMMENT 'output_config.effort frozen at creation (casey_v2_effort then).',
  prompt_version varchar(32) NOT NULL COMMENT 'lib/caseyPrompt.signature(tools) the chat was last continued under. When the current signature differs, the loop drops the stored thinking blocks before continuing (they cannot be replayed against a changed prefix), raises thinking_floor_seq past them and re-stamps this.',
  thinking_floor_seq int NOT NULL DEFAULT 0 COMMENT 'Rows with seq below this have their thinking / redacted_thinking blocks DROPPED on every load: they were produced under another prefix (a prompt or tool change, or a binding 400) and can never be replayed. Only ever raised. The rows themselves are never edited.',
  running_since datetime DEFAULT NULL COMMENT 'UTC. Set by the ONE conditional UPDATE that claims the chat for a turn (one turn in flight per chat; a second POST /api/casey/turn is 409), cleared when the turn ends. A claim older than 15 minutes is treated as free (a turn that died with its instance; the longest turn — the 5-minute tool budget plus the closing call and the one 64k retry at 120 s each — ends well inside it).',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC).',
  updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'UTC; the chat list orders by it.',
  PRIMARY KEY (id),
  KEY idx_casey_chats_user (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Casey v2 chats (ref/CASEY_V2_DESIGN.md §4.6): one row per conversation of the tool-use loop, private to its user; the messages are casey_messages rows.';
CREATE TABLE IF NOT EXISTS casey_messages (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  chat_id bigint unsigned NOT NULL,
  seq int NOT NULL COMMENT 'Position in the chat, from 1; the Messages API array is the rows in seq order.',
  role enum('user','assistant') NOT NULL,
  content longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'The message''s content BLOCK ARRAY as JSON TEXT, the exact bytes sent to or received from the Messages API (text, tool_use, tool_result, thinking with its signature, redacted_thinking), so a later turn replays it byte-for-byte. Deliberately NOT a json column: MySQL re-orders object keys and normalises numbers in a JSON column, which breaks the prompt-cache prefix at the first tool_use input (S2 review). Never edited in place: where the loop had to alter an assistant turn (cut by max_tokens, a refusal, an ignored budget note) it stores a text-only assistant message instead.',
  meta json DEFAULT NULL COMMENT 'Assistant rows: {ai_call_id, stop_reason, usage, cost_cents, ms, altered?}. User rows carrying tool results: {tool_calls:[{id, name, ok, code, bytes, ms, truncated}], budget_note?}. The user row that opens a turn: {context:{...}} the context block was built from.',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC.',
  PRIMARY KEY (id),
  UNIQUE KEY uk_casey_messages_seq (chat_id, seq),
  CONSTRAINT fk_casey_messages_chat FOREIGN KEY (chat_id) REFERENCES casey_chats (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Casey v2 messages (ref/CASEY_V2_DESIGN.md §4.6): the raw Messages API array of one chat, one row per message. Deleting the chat deletes them.';
