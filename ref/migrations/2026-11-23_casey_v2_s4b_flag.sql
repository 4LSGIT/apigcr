-- Casey v2 S4b (2026-11-23): flag-for-review — a Casey answer can be filed as an issue
-- report of kind `casey` (ref/CASEY_V2_DESIGN.md §4.8; as built §9 S4b). Applied by
-- scripts/caseyV2S4bMigrate.js (CHECK / --apply), which reads this file, so the file and
-- the applied schema cannot differ. Runs BEFORE the S4b backend deploys (SQL → backend).
-- One statement, ending with ';' at end of line: the enum widens (an ALTER on a live
-- table — the script sets lock_wait_timeout 5 first); every stored value stays valid.
ALTER TABLE issue_reports
  MODIFY COLUMN kind enum('problem','idea','question','casey') NOT NULL DEFAULT 'problem' COMMENT 'What the reporter filed: problem / idea / question from the Help & Support button; `casey` (Casey v2 S4b) from the flag on a Casey answer or Casey''s own flag_for_review tool — its context.casey {chat_id, seq, model, prompt_version, by} names the chat, which a superuser reads in Admin → Casey Chats.';
