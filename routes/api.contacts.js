// routes/api.contacts.js
//
/**
 * Contacts API
 * routes/api.contacts.js
 *
 * GET    /api/contacts            list with search/filters
 * GET    /api/contacts/:id        single + sub-entities (?include=)
 * POST   /api/contacts            create
 * PATCH  /api/contacts/:id        update fields (+ nested phones/emails/addresses arrays)
 * GET    /api/contacts/:id/cases  cases for contact
 * GET    /api/contacts/:id/appts  appointments for contact
 * GET    /api/contacts/:id/tasks  tasks for contact
 * GET    /api/contacts/:id/log    log entries for contact
 * GET    /api/contacts/:id/sequences  sequence enrollments
 * GET    /api/contacts/:id/workflows  workflow executions
 */

const express        = require('express');
const router         = express.Router();
const jwtOrApiKey    = require('../lib/auth.jwtOrApiKey');
const contactService = require('../services/contactService');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve req.auth.userId to a numeric users.user value, or 0.
 *
 * Matches the route-local helper in routes/api.contactRelations.js (and
 * api.contactPhones.js). JWT auth sets req.auth.userId from payload.sub
 * (string); api-key auth doesn't set userId at all (returns 0 sentinel).
 *
 * Slice 2 Stage 1 revision: introduced to plumb userId into createContact
 * and updateContact so child-table propagation (contact_phones,
 * eventually contact_emails / contact_addresses) gets accurate
 * created_by / updated_by values instead of the 0 automation sentinel.
 */
function resolveCreatedBy(req) {
  const raw = req.auth && req.auth.userId;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return 0;
}

/**
 * Parse a query-string boolean. Matches the helper in
 * routes/api.contactPhones.js so the `?force=true` opt-in has identical
 * semantics on the aggregate PATCH and the dedicated POST routes.
 *
 * Accepts: 'true', '1', 'yes', 'on' (case-insensitive) → true.
 * Anything else → false.
 */
function parseBool(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}


// ─── LIST ───
router.get("/api/contacts", jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.listContacts(req.db, {
      query: req.query.q || req.query.query || "",
      type: req.query.type,
      tags: req.query.tags,
      sort_by: req.query.sort_by || "contact_lname",
      sort_dir: req.query.sort_dir || "ASC",
      limit: req.query.limit || 50,
      offset: req.query.offset || 0,
    });
    res.json(result);
  } catch (err) {
    console.error("GET /api/contacts error:", err);
    res
      .status(500)
      .json({ status: "error", message: "Failed to fetch contacts" });
  }
});

// ─── GET ONE ───
router.get('/api/contacts/:id', jwtOrApiKey, async (req, res) => {
  try {
    const logLimit = req.query.log_limit ? parseInt(req.query.log_limit, 10) : undefined;
    const result = await contactService.getContact(req.db, req.params.id, req.query.include, { logLimit });
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /api/contacts/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch contact' });
  }
});

// ─── CREATE ───
router.post('/api/contacts', jwtOrApiKey, async (req, res) => {
  const { fname, lname } = req.body;
  if (!fname || !lname) {
    return res.status(400).json({ status: 'error', message: 'fname and lname are required' });
  }

  try {
    const userId = resolveCreatedBy(req);
    const result = await contactService.createContact(req.db, req.body, { userId });
    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('POST /api/contacts error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── UPDATE ───
//
// Slice 3 Stage A: this handler now accepts nested phones/emails/addresses
// arrays alongside the scalar fields. When an aggregate array is present
// for a kind, the legacy single-value column for that kind (contact_phone,
// contact_email, contact_address/city/state/zip) is silently stripped from
// the scalar UPDATE — the reconciler is authoritative.
//
// Aggregate-aware response semantics:
//   - On success (any aggregate present): re-fetch the contact with the
//     three child-table includes and return the full row map so the UI
//     can replace its in-memory state without a follow-up GET. Wrapped
//     in `contact:` to keep the shape distinguishable from a plain scalar
//     PATCH response.
//   - Validation errors thrown by the service carry `.errors` (keyed
//     object): map to 400 with `{ status:'error', message, errors }`.
//   - Cross-contact conflicts (force=false): service throws Error with
//     `.conflicts` (flat array): map to 409 with the array intact so the
//     UI can render a "transfer N values from N source(s)?" modal.
//   - `?force=true` opt-in covers conflicts on all kinds in one shot —
//     matches the per-row dedicated-POST routes' semantics.
router.patch('/api/contacts/:id', jwtOrApiKey, async (req, res) => {
  try {
    const userId = resolveCreatedBy(req);
    const force  = parseBool(req.query.force);

    const updated = await contactService.updateContact(
      req.db,
      req.params.id,
      req.body,
      { userId, force }
    );

    // Detect whether an aggregate array was supplied. If so, return the
    // contact with the relevant includes so the UI can hydrate in one round-trip.
    const hasAggregate =
      Object.prototype.hasOwnProperty.call(req.body, 'phones') ||
      Object.prototype.hasOwnProperty.call(req.body, 'emails') ||
      Object.prototype.hasOwnProperty.call(req.body, 'addresses');

    if (hasAggregate) {
      const fresh = await contactService.getContact(
        req.db, req.params.id, 'phones,emails,addresses'
      );
      return res.json({
        status:  'success',
        data:    updated,
        contact: fresh,
      });
    }

    res.json({ status: 'success', data: updated });
  } catch (err) {
    // Structured-validation error path (from the aggregate reconcilers)
    if (err.errors) {
      return res.status(400).json({
        status:  'error',
        message: err.message,
        errors:  err.errors,
      });
    }
    // Conflict path (cross-contact phone/email collision without ?force)
    if (err.conflicts) {
      return res.status(409).json({
        status:    'error',
        message:   err.message,
        conflicts: err.conflicts,
      });
    }

    console.error('PATCH /api/contacts/:id error:', err);
    const m = err.message || '';
    const status =
      m.includes('blocked')                                    ? 400
      : m.includes('must be an array')                         ? 400
      : m.includes('not found')                                ? 404
      : (m.includes('concurrent') || m.includes('Concurrent')) ? 400
      : 500;
    res.status(status).json({ status: 'error', message: err.message });
  }
});

// ─── SUB-ENTITY SHORTCUTS ───
// These are convenience routes that call getContact with a specific include.
// Useful when the frontend only needs one sub-entity.

router.get('/api/contacts/:id/cases', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'cases');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ cases: result.cases });
  } catch (err) {
    console.error('GET /api/contacts/:id/cases error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch cases' });
  }
});

router.get('/api/contacts/:id/appts', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'appts');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ appts: result.appts });
  } catch (err) {
    console.error('GET /api/contacts/:id/appts error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch appointments' });
  }
});

router.get('/api/contacts/:id/tasks', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'tasks');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ tasks: result.tasks });
  } catch (err) {
    console.error('GET /api/contacts/:id/tasks error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch tasks' });
  }
});

router.get('/api/contacts/:id/log', jwtOrApiKey, async (req, res) => {
  try {
    const result = await contactService.getContact(req.db, req.params.id, 'log');
    if (!result) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    res.json({ log: result.log });
  } catch (err) {
    console.error('GET /api/contacts/:id/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch log' });
  }
});

/**
 * GET /api/contacts/:id/sequences
 *
 * Query params:
 *   ?limit   (default 50, max 200)
 *   ?offset  (default 0)
 *   ?status  optional — 'active' | 'completed' | 'cancelled'
 *   ?scope   'active' (default, filters to status='active') or 'all'
 *            If ?status is also supplied, it wins (explicit > defaulted).
 *
 * Response: { success: true, sequences: [...], total, active_total }
 *   - total         — total rows matching the current filter
 *   - active_total  — unfiltered count of status='active' for this contact
 *                     (lets the header read "N active of M total" on scope=all)
 *
 * Row shape: enrollment_id, template_id, template_name, template_type,
 *            status, current_step, total_steps, cancel_reason,
 *            enrolled_at, completed_at, updated_at.
 *   trigger_data is intentionally excluded from the list — drill down via
 *   GET /sequences/enrollments/:id for per-enrollment detail.
 */
router.get('/api/contacts/:id/sequences', jwtOrApiKey, async (req, res) => {
  try {
    const contactId = req.params.id;
 
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit)  || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
 
    const status = req.query.status || null;
    if (status && !['active', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be one of: active, completed, cancelled',
      });
    }
 
    const scope = req.query.scope === 'all' ? 'all' : 'active';
 
    const result = await contactService.listContactSequences(req.db, contactId, {
      limit, offset, status, scope,
    });
    if (!result) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }
 
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/sequences error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sequences',
      message: err.message,
    });
  }
});

/**
 * GET /api/contacts/:id/workflows
 *
 * Slice 4.3 Part B. Mirror of /sequences but for workflow_executions rows
 * tied to this contact via the new `workflow_executions.contact_id` column
 * (populated by the template-default or explicit-override mechanism from
 * Part B — see lib/workflow_engine.js resolveExecutionContactId).
 *
 * Workflows that were never contact-tied at execution-start time have
 * `contact_id` NULL and do not appear here (by design).
 *
 * Query params:
 *   ?limit   (default 50, max 200)
 *   ?offset  (default 0)
 *   ?status  optional — full workflow status enum, validated against:
 *            active | processing | delayed
 *            | completed | completed_with_errors | failed | cancelled
 *   ?scope   'active' (default, returns non-terminal: active|processing|delayed)
 *            or 'all'. Ignored if ?status is also supplied (explicit wins).
 *
 * Response: { success: true, workflows: [...], total, active_total }
 *   - total         — total rows matching the current filter
 *   - active_total  — unfiltered count of non-terminal executions for this
 *                     contact (lets the header read "N active of M total"
 *                     on scope=all)
 *
 * Row shape: execution_id, workflow_id, workflow_name, status,
 *            current_step_number, steps_executed_count, cancel_reason,
 *            created_at, updated_at, completed_at.
 *   init_data and variables are intentionally excluded from the list —
 *   drill down via GET /executions/:id?history=true for per-execution detail.
 */
router.get('/api/contacts/:id/workflows', jwtOrApiKey, async (req, res) => {
  try {
    const contactId = req.params.id;

    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit)  || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const VALID_STATUSES = [
      'active', 'processing', 'delayed',
      'completed', 'completed_with_errors', 'failed', 'cancelled',
    ];
    const status = req.query.status || null;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    const scope = req.query.scope === 'all' ? 'all' : 'active';

    const result = await contactService.listContactWorkflows(req.db, contactId, {
      limit, offset, status, scope,
    });
    if (!result) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('GET /api/contacts/:id/workflows error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch workflows',
      message: err.message,
    });
  }
});

module.exports = router;