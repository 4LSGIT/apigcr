-- 2026-10-11 — CTA clicker inputs: inline bindings + enum presentation — CTA arc, slice S3i
--
-- Spec: ref/CTA_DESIGN.md §12 (Declarations, Binding). Code:
-- services/ctaService.js parseBinding / applyBindings / validateInputDecls /
-- publicInputs, routes/ctaActions.js inputField.
--
-- COMMENT-ONLY: the declarations and the bindings live in the
-- cta_links.options JSON, so the column COMMENT is where the schema lists
-- them. This records (a) "[[input:name]]" may also sit INLINE in a content
-- param's text, and (b) the enum keys choice_labels? / display?. No data
-- change; the backend works with or without it, so order vs. the deploy
-- doesn't matter. Metadata-only on MySQL 8.4 (ALGORITHM=INSTANT spelled out
-- so the engine errors rather than silently rebuilding). Idempotent.
--
-- After applying: npm run db:ref (or let the pre-commit hook do it).

ALTER TABLE cta_links
  MODIFY options JSON NOT NULL
    COMMENT '[{value,label,plan:[{fn,params}],confirm_text?,result_template?,inputs?}] 1-10; value "respond" reserved; params frozen literals (no {{...}}, no _-prefixed keys) EXCEPT "[[input:name]]" binding a declared input into a param its function opens via __meta.ctaInputParams: as the whole top-level value, or inline in the text of a content (never recipient) param. inputs (CTA_DESIGN §12): [{name,label,hint?,type,required,maxlen,choices?,choice_labels?,display?,pattern?,default?}] <=10, type text|phone|email|number|enum|date|html, maxlen <=1000, hint <=200, default stored normalized; enum only: choice_labels parallel to choices (page text, the value stays the choice), display select|radio (select not stored)',
  ALGORITHM=INSTANT;
