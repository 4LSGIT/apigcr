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
// `db` is any mysql2 promise-mode query target: the pool, or a connection
// enlisted in a transaction (caseService.mergeCases passes its `conn`, so the
// recompute rolls back with everything else).
//
// Returns the newly-saved status, so a caller can detect an
// incomplete -> complete transition by comparing against a status it read
// beforehand. That comparison is the documented seam for the planned
// checklist -> task completion hook; nothing uses it yet.

async function computeAndSaveStatus(db, checklistId) {
  const [items] = await db.query(
    'SELECT status FROM checkitems WHERE checklist_id = ?',
    [checklistId]
  );
  const status = items.length > 0 && items.every(i => i.status === 'complete')
    ? 'complete' : 'incomplete';
  await db.query(
    'UPDATE checklists SET status = ?, updated_date = NOW() WHERE id = ?',
    [status, checklistId]
  );
  return status;
}

module.exports = { computeAndSaveStatus };