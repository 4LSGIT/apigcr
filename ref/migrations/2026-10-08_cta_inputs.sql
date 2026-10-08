-- 2026-10-08 — CTA clicker inputs — CTA arc, slice S1i
--
-- Spec: ref/CTA_DESIGN.md §12 (ratified 2026-10-08). Code: services/ctaService.js
-- (validateInputDecls / prepareRun / claimAndOpen), routes/ctaActions.js.
--
-- A. cta_executions.inputs — the §12 Audit column: the normalized values a
--    plan ran with (defaults applied, omitted optional inputs absent). NULL
--    for an option that declares no inputs. Same SU-only exposure and
--    redaction posture as plan_result: read via GET /api/cta/:id/executions,
--    never copied into the outcome log row, never on a public surface.
-- B. cta_links.options COMMENT — the declarations live in the options JSON
--    (no column of their own), so the COMMENT is where the schema says so.
--
-- ONLINE DDL: both statements are metadata-only on MySQL 8.4 — ADD of a
-- trailing NULL column and a comment-only MODIFY are ALGORITHM=INSTANT
-- (spelled out so the engine errors rather than silently rebuilding). The
-- ADD costs one instant-DDL row version on cta_executions (0 -> 1).
--
-- Order: apply BEFORE the S1i backend deploy (SQL → backend → frontend).
-- The S1i click path only names the inputs column when the clicked option
-- declares inputs, so input-less links (every pre-§12 link, WF27's live
-- not-spam button among them) keep working even if this lagged — but
-- GET /api/cta/:id/executions selects the column unconditionally.
--
-- Re-run: A fails with "Duplicate column name 'inputs'" (harmless — it
-- already ran); B is idempotent. No session variables (console runner).
--
-- After applying: npm run db:ref (or let the pre-commit hook do it).
--
-- Standing rule (R3): cta_links / cta_executions NEVER enter
-- QUERY_DB_ALLOWED_TABLES or WRITE_POLICY. inputs can carry clicker-typed
-- phone numbers, addresses and message text.

-- ── A. cta_executions.inputs ────────────────────────────────────────────────
ALTER TABLE cta_executions
  ADD COLUMN inputs JSON NULL
    COMMENT 'clicker inputs (CTA_DESIGN §12) as the plan ran with them: {name: normalized value}, defaults applied, omitted optionals absent; NULL = option declares no inputs. SU-only like plan_result - readable via RO keys, redact accordingly',
  ALGORITHM=INSTANT;

-- ── B. cta_links.options COMMENT ────────────────────────────────────────────
ALTER TABLE cta_links
  MODIFY options JSON NOT NULL
    COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?,inputs?}] 1-10; value "respond" reserved; params frozen literals (no {{...}}, no _-prefixed keys) EXCEPT a whole top-level value "[[input:name]]" binding a declared input into a param its function opens via __meta.ctaInputParams. inputs (CTA_DESIGN §12): [{name,label,type,required,maxlen,choices?,pattern?,default?}] <=10, type text|phone|email|number|enum|date|html, maxlen <=1000, default stored normalized',
  ALGORITHM=INSTANT;
