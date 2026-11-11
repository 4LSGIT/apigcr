-- form_submissions.updated_at → DATETIME(3): the draft POST's expected_updated_at
-- precondition (services/formService.js upsertDraft) compares it to the millisecond;
-- at whole seconds two saves in one second were indistinguishable.
-- Applied by scripts/formDraftUpdatedAtMs.js on one connection, with
-- lock_wait_timeout = 5, asserting the pre-state and the end state.
-- Recorded here; run the script, not this. Run BEFORE the backend deploy.

ALTER TABLE form_submissions
  MODIFY COLUMN updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    COMMENT 'DATETIME(3) since 2026-11-11: POST /api/forms/draft expected_updated_at compares it to the millisecond (at whole seconds two saves in one second were indistinguishable)';
