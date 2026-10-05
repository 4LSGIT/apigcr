-- 2026-10-05 — bearer-token columns → utf8mb4_bin (case-sensitive)
--
-- lib/token.js now mints every URL bearer token as 22-char base62
-- (0-9 A-Z a-z), replacing the per-site 32-hex / 22-base64url mints. Base62
-- is case-sensitive; under utf8mb4_general_ci the DB collapses case, so a
-- mixed-case alphabet never buys the entropy it appears to (lib/caseId.js
-- documents the same lesson for case_id, resolved there by going uppercase-
-- only because case IDs are human-facing; these tokens are not, so the
-- column goes _bin instead). Same-charset collation swap only — no charset
-- conversion, matching the documents.external_id / case_folder_cache
-- precedent, so a stray non-ASCII comparison value can never throw a
-- conversion error on the ungated reset_token lookup.
--
-- Data audit before this ran (live, 2026-10-05): every non-NULL value in all
-- five columns matched [A-Za-z0-9_-]+ (appts 74×32-hex, contacts 1090×32-hex,
-- tasks 681×22-base64url, decision_requests 11×22-base64url, users 0) — the
-- swap rewrites no values, and legacy tokens keep matching under _bin because
-- a sent link carries the minted string verbatim.
--
-- Order: apply this BEFORE deploying the lib/token backend (SQL → backend →
-- frontend). Old mints work under the new collation and new mints under the
-- old, so the window is safe either way; the discipline is the convention.
-- After applying: npm run db:ref (tests/schemaCollationBin.test.js lints the
-- regenerated dump for these five columns).

ALTER TABLE appts
  MODIFY appt_manage_token char(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'client manage-link token (/m/<t>); 22-char base62 via lib/token, legacy 32-hex; _bin: case-sensitive bearer';

ALTER TABLE contacts
  MODIFY contact_token char(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'opaque per-contact bearer: booking prefill + video attribution; 22-char base62 via lib/token, legacy 32-hex; _bin: case-sensitive';

ALTER TABLE tasks
  MODIFY task_action_token char(22) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'one-click action bearer (/t/<t>); 22-char base62 via lib/token, legacy base64url; _bin: case-sensitive';

ALTER TABLE decision_requests
  MODIFY token varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
    COMMENT 'decision bearer (/d/<t>); 22-char base62 via lib/token, legacy base64url; _bin: case-sensitive';

ALTER TABLE users
  MODIFY reset_token varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
    COMMENT 'password-reset bearer; 22-char base62 via lib/token, legacy 64-hex; _bin: case-sensitive';
