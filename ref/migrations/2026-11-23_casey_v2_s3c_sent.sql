-- Casey v2 S3c (2026-11-23): what a card step was actually sent as, once an earlier step's
-- result has been substituted into it (ref/CASEY_V2_DESIGN.md §4.5; as built §9 S3c).
-- Applied by scripts/caseyV2S3cMigrate.js (CHECK / --apply), which reads this file, so the
-- file and the applied schema cannot differ. Runs BEFORE the S3c backend deploys
-- (SQL → backend). Four statements, each ending with ';' at end of line: two ADDs, then two
-- MODIFYs that correct the S3b COMMENTs this slice falsified (the type and nullability of
-- `path` and `body` are unchanged — only the comment).
-- After this, casey_card_steps has two columns more than
-- ref/migrations/2026-11-23_casey_v2_s3b_cards.sql declares: scripts/caseyV2S3bMigrate.js
-- is superseded for CHECK by the S3c script.
ALTER TABLE casey_card_steps
  ADD COLUMN path_sent varchar(2000) DEFAULT NULL COMMENT 'The concrete path the browser was handed at claim, after every $N.field reference in `path` was replaced from an earlier step''s stored (redacted) result. NULL when the path carried no reference — then `path` is what was sent.' AFTER body;
ALTER TABLE casey_card_steps
  ADD COLUMN body_sent longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'The request body as JSON TEXT the browser was handed at claim, after every $N.field reference in `body` was replaced — the exact bytes sent. NULL when the body carried no reference — then `body` is what was sent. A reference that cannot be resolved (the earlier step not applied, the field missing, or its value [redacted]) fails the step before anything is sent (status failed, result {error:UNRESOLVED}).' AFTER path_sent;
ALTER TABLE casey_card_steps
  MODIFY COLUMN path varchar(2000) NOT NULL COMMENT 'The path as proposed, query string included: concrete, or a template with $N.field reference segments standing for route parameters (S3c). At proposal the route it reaches — by dispatch, or by structure for a template — was proposable (lib/caseySensitivity) and allowed for this user; a template''s resolved path must dispatch to that same route at claim (path_sent).';
ALTER TABLE casey_card_steps
  MODIFY COLUMN body longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'The request body as JSON TEXT as proposed — the EXACT bytes the browser sends (apiSend takes a string body as is) unless it carries $N.field references, which the claim resolves into body_sent (then THAT is what is sent). What the card shows is byte-for-byte what the route receives. NULL for a step without a body.';
