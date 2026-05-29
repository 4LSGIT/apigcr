// routes/api.cases.js
//
/**
 * Cases API
 * routes/api.cases.js
 *
 * GET    /api/cases                       list with search/filters
 * GET    /api/cases/:id                   single + sub-entities (?include=)
 * PATCH  /api/cases/:id                   update fields
 * GET    /api/cases/:id/contacts          contacts for case
 * POST   /api/cases/:id/contacts          add contact to case
 * DELETE /api/cases/:id/contacts/:contactId  remove contact from case
 * GET    /api/cases/:id/tasks             tasks for case (preserved from existing)
 * GET    /api/cases/:id/log               log entries for case
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const caseService = require('../services/caseService');

// ─── LIST ───
router.get('/api/cases', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.listCases(req.db, {
      query: req.query.q || req.query.query || "",
      type: req.query.type || "%",
      stage: req.query.stage || "%",
      status: req.query.status || "%",
      sort_by: req.query.sort_by || "c.case_open_date",
      sort_dir: req.query.sort_dir || "DESC",
      limit: req.query.limit || 50,
      offset: req.query.offset || 0,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/cases error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch cases' });
  }
});

// ─── SEARCH (typeahead for CasePicker) ───
// MUST be registered before GET /api/cases/:id, or Express captures
// the literal "search" as :id. Returns the picker-shaped payload
// (raw case_number + case_number_full, single Primary contact) from
// caseService.searchCases — deliberately distinct from the LIST shape.
router.get('/api/cases/search', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.searchCases(req.db, {
      q: req.query.q || '',
      limit: req.query.limit || 20,
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/cases/search error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to search cases' });
  }
});

// ─── GET ONE ───
router.get('/api/cases/:id', jwtOrApiKey, async (req, res) => {
  try {
    const logLimit = req.query.log_limit ? parseInt(req.query.log_limit, 10) : undefined;
    const result = await caseService.getCase(req.db, req.params.id, req.query.include, { logLimit });
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /api/cases/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch case' });
  }
});

// ─── UPDATE ───
router.patch('/api/cases/:id', jwtOrApiKey, async (req, res) => {
  try {
    const updated = await caseService.updateCase(req.db, req.params.id, req.body);
    res.json({ status: 'success', data: updated });
  } catch (err) {
    console.error('PATCH /api/cases/:id error:', err);
    const status = err.message.includes('cannot update') ? 400 : err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── ADOPT DOCKET (Phase 4.1) ───
//
// PATCH /api/cases/:id/docket   body { case_number, case_number_full }
//
// Dedicated, collision-checked writer for the docket-adopt flow. Deliberately
// SEPARATE from the generic PATCH /api/cases/:id (which is an unchecked column
// setter used by many callers) — the collision logic must not leak into it.
//
// SHAPE-AGNOSTIC: case_number / case_number_full are opaque free-text. This
// endpoint never parses docket shape; it trims, treats empty as null,
// collision-checks by string equality on both columns, and writes. The
// ##-#####-@@@ split is bankruptcy-specific and lives client-side.
//
// Guards (both → 409, no write):
//   1. Cross-case collision: another case already holds either submitted value
//      in case_number OR case_number_full.
//   2. Target already has a DIFFERENT non-empty docket. Replacing an existing
//      docket is a case-detail-form operation, not an adopt. (If the target's
//      values are empty/null, or exactly equal to the submission, proceed.)
//
// This is a distinct segment-count path from /api/cases/:id, so registration
// order relative to it does not matter; placed here for locality.
router.patch('/api/cases/:id/docket', jwtOrApiKey, async (req, res) => {
  const caseId = req.params.id;

  const norm = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  const caseNumber     = norm(req.body.case_number);
  const caseNumberFull = norm(req.body.case_number_full);

  if (caseNumber == null && caseNumberFull == null) {
    return res.status(400).json({
      status: 'error',
      message: 'At least one of case_number / case_number_full is required',
    });
  }

  try {
    // Target must exist; also fetch its current docket for the same-vs-different guard.
    const [targetRows] = await req.db.query(
      `SELECT case_id, case_number, case_number_full, case_type
         FROM cases WHERE case_id = ? LIMIT 1`,
      [caseId]
    );
    if (!targetRows.length) {
      return res.status(404).json({ status: 'error', message: 'Case not found' });
    }
    const target = targetRows[0];

    // Guard 2: block only an actual OVERWRITE of a non-empty value.
    //
    // Per-column: if the case already has a non-empty value and the submission
    // would CHANGE it to a different non-empty value → block (that's a
    // detail-form replacement, out of scope for adopt). But FILLING an empty
    // column, or leaving a column at its current value, is the normal adopt
    // case — including the common "case has the short number, court rows came
    // in under the full docket" situation (e.g. VbJZayMJ: case_number
    // '24-31852', case_number_full ''), which must be allowed to complete.
    //
    // A null submission for a column is treated as "don't touch" for the guard;
    // see the write note below — we never null out an existing value on adopt.
    const existingNum  = (target.case_number      || '').trim();
    const existingFull = (target.case_number_full || '').trim();

    const numConflict =
      caseNumber != null && existingNum !== '' && existingNum !== caseNumber;
    const fullConflict =
      caseNumberFull != null && existingFull !== '' && existingFull !== caseNumberFull;

    if (numConflict || fullConflict) {
      const which = numConflict ? 'case number' : 'full docket';
      const had   = numConflict ? existingNum : existingFull;
      return res.status(409).json({
        status: 'error',
        message: `Case ${caseId} already has a ${which} (${had}). ` +
                 `Replacing it is a case-detail-form operation, not an adopt.`,
        conflict: {
          case_id: target.case_id,
          case_number: target.case_number,
          case_number_full: target.case_number_full,
          case_type: target.case_type,
        },
      });
    }

    // Guard 1: cross-case collision (string equality on both columns).
    const conflict = await caseService.checkCaseNumberCollision(req.db, caseId, {
      case_number: caseNumber,
      case_number_full: caseNumberFull,
    });
    if (conflict) {
      const label = conflict.case_number_full || conflict.case_number || conflict.case_id;
      return res.status(409).json({
        status: 'error',
        message: `That docket already belongs to case ${conflict.case_id} (${label}).`,
        conflict,
      });
    }

    // Clean — write only the columns the user actually submitted (non-null).
    // A null submission means "don't touch" (consistent with Guard 2 treating
    // null as don't-touch). This prevents an adopt that fills the full-form
    // from nulling out an existing short number, and vice versa. updateCase is
    // the generic writer; it returns { case_id, updated_fields } (not the row),
    // so we re-fetch via getCase to honor the data:<updated case> contract.
    const fields = {};
    if (caseNumber     != null) fields.case_number      = caseNumber;
    if (caseNumberFull != null) fields.case_number_full = caseNumberFull;

    await caseService.updateCase(req.db, caseId, fields);

    const updated = await caseService.getCase(req.db, caseId);
    res.json({ status: 'success', data: updated });
  } catch (err) {
    console.error('PATCH /api/cases/:id/docket error:', err);
    const status = err.message && err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ status: 'error', message: err.message || 'Failed to adopt docket' });
  }
});

// ─── CONTACTS (case_relate) ───

router.get('/api/cases/:id/contacts', jwtOrApiKey, async (req, res) => {
  try {
    const contacts = await caseService.getCaseContacts(req.db, req.params.id);
    res.json({ contacts });
  } catch (err) {
    console.error('GET /api/cases/:id/contacts error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch contacts' });
  }
});

router.post('/api/cases/:id/contacts', jwtOrApiKey, async (req, res) => {
  const { contact_id, relate_type } = req.body;
  if (!contact_id) return res.status(400).json({ status: 'error', message: 'contact_id is required' });

  try {
    const result = await caseService.addCaseContact(
      req.db, req.params.id, contact_id, relate_type || 'Primary'
    );
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/cases/:id/contacts error:', err);
    const status = err.message.includes('already linked') ? 409 : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/cases/:id/contacts/:contactId', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.removeCaseContact(req.db, req.params.id, req.params.contactId);
    if (!result.removed) return res.status(404).json({ status: 'error', message: 'Relationship not found' });
    res.json({ status: 'success', message: 'Contact removed from case' });
  } catch (err) {
    console.error('DELETE /api/cases/:id/contacts/:contactId error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to remove contact' });
  }
});

// ─── SUB-ENTITY SHORTCUTS ───

router.get('/api/cases/:id/tasks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.getCase(req.db, req.params.id, 'tasks');
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json({ tasks: result.tasks });
  } catch (err) {
    console.error('GET /api/cases/:id/tasks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch tasks' });
  }
});

router.get('/api/cases/:id/log', jwtOrApiKey, async (req, res) => {
  try {
    const result = await caseService.getCase(req.db, req.params.id, 'log');
    if (!result) return res.status(404).json({ status: 'error', message: 'Case not found' });
    res.json({ log: result.log });
  } catch (err) {
    console.error('GET /api/cases/:id/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log' });
  }
});

router.patch('/api/cases/:id/contacts/:contactId', jwtOrApiKey, async (req, res) => {
  const { relate_type } = req.body;
  if (!relate_type) return res.status(400).json({ status: 'error', message: 'relate_type required' });
  try {
    const [result] = await req.db.query(
      `UPDATE case_relate SET case_relate_type = ?
       WHERE case_relate_case_id = ? AND case_relate_client_id = ?`,
      [relate_type, req.params.id, req.params.contactId]
    );
    if (!result.affectedRows) return res.status(404).json({ status: 'error', message: 'Relationship not found' });
    res.json({ status: 'success', message: `Relation updated to ${relate_type}` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;