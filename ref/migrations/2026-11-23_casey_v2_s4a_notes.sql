-- Casey v2 S4a (2026-11-23): the pitfalls document — notes the firm edits in the app
-- that steer Casey without a deploy (ref/CASEY_V2_DESIGN.md §4.7; as built §9 S4a).
-- Applied by scripts/caseyV2S4aMigrate.js (CHECK / --apply), which reads this file, so
-- the file and the applied schema cannot differ; --apply also seeds version 1 of the
-- `global` scope from ref/migrations/2026-11-23_casey_v2_s4a_notes_seed.md when the
-- scope has no version yet. Runs BEFORE the S4a backend deploys (SQL → backend). One
-- statement, ending with ';' at end of line. No FK: a note outlives every chat.
CREATE TABLE IF NOT EXISTS casey_notes (
  id bigint unsigned NOT NULL AUTO_INCREMENT,
  scope varchar(64) NOT NULL COMMENT 'What the note steers: ''global'' (appended to Casey v2''s system prompt on every turn, services/casey/notes.js → lib/caseyPrompt.systemText) or a route family as lib/routeFamilies.familyOf names it (''/api/contacts''), returned with every lookup_routes hit in that family. App-validated.',
  version int unsigned NOT NULL COMMENT '1..n per scope, in save order; the CURRENT note of a scope is its highest version. Rows are never updated or deleted: a restore writes a new version carrying an older body, so every edit — and who made it — stays readable.',
  body mediumtext NOT NULL COMMENT 'The note''s text as saved (LF line ends, trailing whitespace stripped). Blank = the scope has no note in force. Caps (app-enforced, services/casey/notes.js): 20,000 characters for global, 2,000 for a family — the global body rides in the cached prompt prefix of EVERY turn.',
  edit_note varchar(300) NOT NULL COMMENT 'Why this version was saved, in the editor''s words (required); a restore carries "Restored version N: …".',
  author_id int DEFAULT NULL COMMENT 'users.user who saved it; NULL for the migration''s seed.',
  author_name varchar(64) NOT NULL COMMENT 'The author''s username at save time, denormalised so the history reads without a join (''seed'' for the migration''s own version 1).',
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'UTC (the pool runs UTC).',
  PRIMARY KEY (id),
  UNIQUE KEY uk_casey_notes_scope_version (scope, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='Casey v2 pitfalls document (ref/CASEY_V2_DESIGN.md §4.7): versioned notes the firm edits in Admin → Casey Notes. The global scope is appended to the system prompt (an edit changes prompt_version, so open chats drop their stored thinking once); a family scope rides with lookup_routes hits. Casey itself can never write here (every /api/casey route is never proposable).';
