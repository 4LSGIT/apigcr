// lib/checklistStatus.js
//
// The ONE implementation of checklist parent-status computation.
//
// Extracted from routes/api.checklists.js when services/caseService.js needed
// it too (merge consolidation) — a service requiring a route module is a
// dependency edge we don't want, and a second hand-rolled copy of the rule is
// how the two quietly diverge.
//
// RULE (unchanged from the original):
//   zero items                -> incomplete   (an empty checklist is not done)
//   every item 'complete'     -> complete
//   any item 'incomplete'     -> incomplete
//
// NEVER write checklists.status directly — it is derived, and the next item
// change overwrites whatever you set.
//
// ── NOTES ARE EXEMPT (S1) ────────────────────────────────────
//
// checklists now carries `kind` ENUM('checklist','note'). A note is a card with
// a freeform `body` and NO checkitems rows, ever — which inverts everything
// above. Run the rule on a note and "zero items -> incomplete" pins its status
// to incomplete permanently, and any recompute STOMPS a status a human set by
// hand.
//
// So for kind='note' the polarity flips: status is MANUAL, never derived.
// PATCH /checklists/:id writes it directly (and rejects that same write against
// a checklist, pointing at the rule above). This function refuses to touch it.
//
// The guard lives HERE, not only in the route, because
// services/caseService.mergeCases calls this lib directly on `conn` and has no
// route-level validation in front of it. One extra PK lookup per item write is
// the price; against a checkitems write that already costs three or four
// queries it is noise.
//
// A MISSING checklist takes the same early return. It previously computed
// 'incomplete' from zero items and wrote nothing (affectedRows 0); it now
// reports { status: null, transitioned: false }. No call site reads status
// without also requiring transitioned — see the audit below.
//
// The early return also skips the updated_date touch at the end. That is
// correct: nothing legitimately calls this for a note (POST
// /checklists/:id/items 400s on a note parent), and a note's own writes bump
// updated_date through the column's ON UPDATE CURRENT_TIMESTAMP anyway.
//
// `db` is any mysql2 promise-mode query target: the pool, or a connection
// enlisted in a transaction (caseService.mergeCases passes its `conn`, so the
// recompute rolls back with everything else).
//
// ── RETURN SHAPE (R4/S8) ─────────────────────────────────────
//
// Returns { status, transitioned } — NOT a bare status string any more.
// All five call sites were audited and updated in the same slice
// (routes/api.checklists.js ×4, services/caseService.js ×1); only two of them
// read the return value at all.
//
//   status       the newly-saved status ('complete' | 'incomplete'), or NULL
//                when the row is a note or does not exist (see above)
//   transitioned TRUE only for the caller whose write actually CHANGED the
//                status. Exactly one of N concurrent callers sees true.
//                Never true for a note.
//
// S1 re-audit of every call site against the new `status: null`:
//   api.checklists.js  POST   /checklists/:id/items     return discarded
//   api.checklists.js  PATCH  /checkitems/:id           reads BOTH — gates on
//                      `transitioned && status === 'complete'`, which is safe
//                      on null; also passes status into checkitem.completed's
//                      data, where null is benign (and unreachable anyway: a
//                      note has no items to PATCH)
//   api.checklists.js  DELETE /checkitems/:id           same gate, same result
//   api.checklists.js  POST   /checklists/upsert-items  return discarded
//   caseService.js     mergeCases consolidation         return discarded
//
// WHY THIS EXISTS: the old contract was "compare against a status you read
// beforehand". Read-then-compare is not atomic — two requests completing the
// last two items of a list both read 'incomplete', both recompute 'complete',
// and both fire checklist.completed. Duplicate events mean duplicate trigger
// actions (a stage advance, a doc request, an e-sign send). The conditional
// UPDATE below moves the comparison inside the write, where InnoDB's row lock
// serializes it: the second caller's WHERE no longer matches and it reports
// affectedRows 0.
//
// `transitioned` is direction-agnostic (it is also true for
// complete -> incomplete). Callers that care about one direction check the
// status too — see the checklist.completed gates in api.checklists.js.

async function computeAndSaveStatus(db, checklistId) {
  // Kind gate — see "NOTES ARE EXEMPT" above. Deliberately the FIRST thing
  // this function does: a note must not have its status read, recomputed or
  // written, and must not have its updated_date touched as a side effect.
  const [[row]] = await db.query(
    'SELECT kind FROM checklists WHERE id = ?',
    [checklistId]
  );
  if (!row || row.kind === 'note') return { status: null, transitioned: false };

  const [items] = await db.query(
    'SELECT status FROM checkitems WHERE checklist_id = ?',
    [checklistId]
  );
  const status = items.length > 0 && items.every(i => i.status === 'complete')
    ? 'complete' : 'incomplete';

  // Guarded write: matches only when the stored status actually differs, so
  // affectedRows IS the transition signal. (No CLIENT_FOUND_ROWS in this
  // pool, and the WHERE excludes same-value rows anyway, so affectedRows and
  // changedRows agree here.)
  const [res] = await db.query(
    'UPDATE checklists SET status = ?, updated_date = NOW() WHERE id = ? AND status <> ?',
    [status, checklistId, status]
  );
  const transitioned = res.affectedRows > 0;

  // The guard above skips the row when the status is unchanged — which would
  // also skip the updated_date bump that every recompute used to perform.
  // That column is load-bearing: api.checklists.js sorts on it
  // (updated_desc / updated_asc), so a list touched by an item rename would
  // stop rising to the top. Touch it explicitly instead.
  if (!transitioned) {
    await db.query(
      'UPDATE checklists SET updated_date = NOW() WHERE id = ?',
      [checklistId]
    );
  }

  return { status, transitioned };
}

module.exports = { computeAndSaveStatus };
