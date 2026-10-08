-- 2026-10-08 — CTA clicker inputs: `hint` on input declarations — CTA arc, slice S2i
--
-- Spec: ref/CTA_DESIGN.md §12 (Declarations). Code: services/ctaService.js
-- validateInputDecls / publicInputs, routes/ctaActions.js inputField.
--
-- COMMENT-ONLY: the declarations live in the cta_links.options JSON, so the
-- column COMMENT is where the schema lists their keys — this adds `hint?`
-- (optional SU help text, ≤200 chars, shown under the field). No data
-- change; the backend works with or without it, so order vs. the deploy
-- doesn't matter. Metadata-only on MySQL 8.4 (ALGORITHM=INSTANT spelled out
-- so the engine errors rather than silently rebuilding). Idempotent.
--
-- After applying: npm run db:ref (or let the pre-commit hook do it).

ALTER TABLE cta_links
  MODIFY options JSON NOT NULL
    COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?,inputs?}] 1-10; value "respond" reserved; params frozen literals (no {{...}}, no _-prefixed keys) EXCEPT a whole top-level value "[[input:name]]" binding a declared input into a param its function opens via __meta.ctaInputParams. inputs (CTA_DESIGN §12): [{name,label,hint?,type,required,maxlen,choices?,pattern?,default?}] <=10, type text|phone|email|number|enum|date|html, maxlen <=1000, hint <=200, default stored normalized',
  ALGORITHM=INSTANT;
