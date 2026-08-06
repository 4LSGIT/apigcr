// routes/api.portalCardsAdmin.js
//
/**
 * routes/api.portalCardsAdmin.js — Staff admin REST routes for the portal
 * card engine (Client Portal Slice E2). Backs
 * public/caseconfig/portalCards.html.
 *
 * GET    /api/portal-cards-admin/meta        — author reference: the field
 *          whitelist (READ-ONLY display — it's a code constant in
 *          lib/portalCardEngine.js, never editable from here), rule
 *          operators, placements, known coded keys, pinned sql param paths.
 * GET    /api/portal-cards-admin/cards       — list all cards (engine order:
 *          sort ASC, id ASC — active AND inactive; the admin sees everything)
 * GET    /api/portal-cards-admin/cards/:id   — one card
 * POST   /api/portal-cards-admin/cards       — create (full validateCard)
 * PUT    /api/portal-cards-admin/cards/:id   — partial update: the patch is
 *          merged onto the existing row and the MERGED card re-validates —
 *          an update can never leave a row validateCard would reject.
 * DELETE /api/portal-cards-admin/cards/:id   — template cards: hard delete.
 *          CODED cards: 409 — their renderer is code (case.html
 *          CODED_RENDERERS); orphaning it is a deploy-level decision.
 *          Deactivate instead (PUT { active: 0 }).
 * POST   /api/portal-cards-admin/preview     — { card: <draft>, case_id }:
 *          validate the draft, then run it through the REAL engine pipeline
 *          (portalCardEngine.previewCard) pinned to that case and its
 *          Primary contact (resolved SERVER-side — the admin picks a case,
 *          never a contact; same MIN(contact_id)-among-Primary rule as
 *          caseService.searchCases). Returns the would-be portal payload
 *          card + per-condition-group pass/fail. Invalid drafts return 200
 *          with { validation: { valid:false, errors } } — the preview pane
 *          is a "what would happen" surface, and validation errors ARE the
 *          answer (saves still 400).
 *
 * SECURITY MODEL (see lib/portalCardEngine.js header — binding):
 *   - Save-time validation REJECTS, never strips/sanitizes. Errors NAME the
 *     offending refs/ops/paths (staff-facing — no oracle concern here).
 *     Render-time refusal in the engine remains the enforcement of record.
 *   - Validation lives IN the engine (validateCard) so save-time and
 *     render-time share one set of primitives and can't drift.
 *   - body_type is immutable (a card is born template or coded); a coded
 *     card's coded_key is immutable (the code binding); coded cards reject
 *     body fields and refuse DELETE.
 *
 * Auto-mounted from routes/ (server.js readdir loop). Auth + envelope match
 * routes/api.pipelineAdmin.js: jwtOrApiKey on every route (staff surface);
 * { status:'success', ... } / { status:'error', message } — validation
 * failures additionally carry `errors: string[]`. Thrown errors carry
 * `.status` (400 validation, 404 unknown row, 409 business rule), anything
 * else is a 500.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const engine = require('../lib/portalCardEngine');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  if (errors) err.errors = errors;
  return err;
}

/** Map a thrown error to an HTTP response (pipelineAdmin pattern). */
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.portalCardsAdmin] ${tag} error:`, err);
  const body = { status: 'error', message: err.message };
  if (err.errors) body.errors = err.errors;
  res.status(status).json(body);
}

const CARD_COLUMNS =
  `id, card_key, title, body_type, body_template, coded_key,
   link_url, link_label, conditions, placement, sort, active,
   created_at, updated_at`;

async function fetchCard(db, id) {
  const [[row]] = await db.query(
    `SELECT ${CARD_COLUMNS} FROM portal_cards WHERE id = ? LIMIT 1`, [id]
  );
  return row || null;
}

/** validateCard wrapper that throws a 400 carrying the error list. */
function validateOrThrow(input) {
  const v = engine.validateCard(input);
  if (!v.valid) {
    throw httpError(400, 'Card failed validation: ' + v.errors.join(' · '), v.errors);
  }
  return v.card;
}

// The patchable column set. body_type is deliberately ABSENT — immutable
// (checked explicitly below so the client gets a 409, not a silent ignore).
const PATCH_FIELDS = [
  'card_key', 'title', 'body_template', 'coded_key',
  'link_url', 'link_label', 'conditions', 'placement', 'sort', 'active',
];

// ─────────────────────────────────────────────────────────────────────────────
// Core operations (exported for tests — repo pattern: admin.apiKeys)
// ─────────────────────────────────────────────────────────────────────────────

async function listCards(db) {
  // Engine order (sort, id) — the admin list mirrors portal order. Active
  // AND inactive rows: the admin is where inactive cards get managed.
  const [rows] = await db.query(
    `SELECT ${CARD_COLUMNS} FROM portal_cards ORDER BY sort ASC, id ASC`
  );
  return rows;
}

async function getCard(db, id) {
  const row = await fetchCard(db, id);
  if (!row) throw httpError(404, `Unknown portal card id ${id}`);
  return row;
}

async function createCard(db, body) {
  const card = validateOrThrow(body || {});
  try {
    const [r] = await db.query(
      `INSERT INTO portal_cards
         (card_key, title, body_type, body_template, coded_key,
          link_url, link_label, conditions, placement, sort, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [card.card_key, card.title, card.body_type, card.body_template,
       card.coded_key, card.link_url, card.link_label,
       card.conditions ? JSON.stringify(card.conditions) : null,
       card.placement, card.sort, card.active]
    );
    return await getCard(db, r.insertId);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw httpError(409, `card_key '${card.card_key}' already exists`);
    }
    throw err;
  }
}

async function updateCard(db, id, patch) {
  const existing = await getCard(db, id);
  patch = patch && typeof patch === 'object' ? patch : {};

  // body_type is immutable — a card is born template or coded. (Converting
  // would tangle the coded_key / body rules; delete-and-recreate if ever
  // genuinely needed for a template card.)
  if (patch.body_type !== undefined && String(patch.body_type) !== existing.body_type) {
    throw httpError(409, `body_type is immutable (this card is '${existing.body_type}')`);
  }

  if (existing.body_type === 'coded') {
    // Coded cards: body fields rejected (the body is code)…
    if (patch.body_template !== undefined && patch.body_template !== null &&
        String(patch.body_template).trim() !== '') {
      throw httpError(400,
        `'${existing.card_key}' is a coded card — it has no body fields; ` +
        `the body is supplied by its coded renderer`);
    }
    // …and coded_key is the CODE BINDING — repointing it is a deploy-level
    // pairing (renderer ships with code), not an admin edit.
    if (patch.coded_key !== undefined &&
        String(patch.coded_key == null ? '' : patch.coded_key).trim() !== existing.coded_key) {
      throw httpError(409,
        `coded_key is immutable — it binds this card to its client renderer ` +
        `('${existing.coded_key}'); new renderers ship with code`);
    }
  }

  // Merge the patch onto the existing row, then validate the WHOLE merged
  // card — updates can never leave a row that validateCard would reject.
  const merged = {
    card_key:      existing.card_key,
    title:         existing.title,
    body_type:     existing.body_type,
    body_template: existing.body_template,
    coded_key:     existing.coded_key,
    link_url:      existing.link_url,
    link_label:    existing.link_label,
    conditions:    existing.conditions,
    placement:     existing.placement,
    sort:          existing.sort,
    active:        existing.active,
  };
  for (const f of PATCH_FIELDS) {
    if (patch[f] !== undefined) merged[f] = patch[f];
  }
  const card = validateOrThrow(merged);

  try {
    await db.query(
      `UPDATE portal_cards
          SET card_key = ?, title = ?, body_template = ?, coded_key = ?,
              link_url = ?, link_label = ?, conditions = ?,
              placement = ?, sort = ?, active = ?
        WHERE id = ?`,
      [card.card_key, card.title, card.body_template, card.coded_key,
       card.link_url, card.link_label,
       card.conditions ? JSON.stringify(card.conditions) : null,
       card.placement, card.sort, card.active, id]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      throw httpError(409, `card_key '${card.card_key}' already exists`);
    }
    throw err;
  }
  return await getCard(db, id);
}

async function deleteCard(db, id) {
  const existing = await getCard(db, id);
  if (existing.body_type === 'coded') {
    throw httpError(409,
      `'${existing.card_key}' is a coded card — its renderer is code, and ` +
      `deleting the row orphans that renderer (re-seeding it back is a ` +
      `deploy-level decision). Deactivate it instead.`);
  }
  await db.query(`DELETE FROM portal_cards WHERE id = ?`, [id]);
  return { deleted: true, card_key: existing.card_key };
}

/**
 * Preview: validate the draft; resolve the pinned session (case + its
 * Primary contact, server-side); run the REAL pipeline. See the route-table
 * comment for the 200-with-validation-errors contract.
 */
async function previewDraft(db, body) {
  body = body && typeof body === 'object' ? body : {};
  const caseId = String(body.case_id == null ? '' : body.case_id).trim();
  if (!caseId) throw httpError(400, 'case_id is required');

  const v = engine.validateCard(body.card || {});
  if (!v.valid) {
    return { validation: { valid: false, errors: v.errors } };
  }

  // Pin the preview session server-side: the admin chooses a CASE; the
  // contact is that case's Primary — MIN(contact_id) among 'Primary'
  // relations, the same deterministic rule as caseService.searchCases.
  const [[caseRow]] = await db.query(
    `SELECT c.case_id, c.case_number, c.case_number_full,
            p.primary_contact_id, pc.contact_name AS primary_contact_name
       FROM cases c
       LEFT JOIN (
         SELECT case_relate_case_id, MIN(case_relate_client_id) AS primary_contact_id
           FROM case_relate
          WHERE case_relate_type = 'Primary'
          GROUP BY case_relate_case_id
       ) p ON p.case_relate_case_id = c.case_id
       LEFT JOIN contacts pc ON pc.contact_id = p.primary_contact_id
      WHERE c.case_id = ?
      LIMIT 1`,
    [caseId]
  );
  if (!caseRow) throw httpError(404, `Unknown case '${caseId}'`);

  const contactId = caseRow.primary_contact_id == null ? null : caseRow.primary_contact_id;
  const preview = await engine.previewCard(db, v.card, {
    caseId: caseRow.case_id,   // canonical casing from cases
    contactId,
  });

  return {
    validation: { valid: true, errors: [] },
    preview_case: {
      case_id: caseRow.case_id,
      docket: caseRow.case_number_full || caseRow.case_number || null,
      primary_contact_id: contactId,
      primary_contact_name: caseRow.primary_contact_name || null,
    },
    note: contactId === null
      ? 'Case has no Primary contact — contact fields resolve as NULL in this preview.'
      : null,
    ...preview,   // passes, conditions, card, hidden_reason
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/portal-cards-admin/meta', jwtOrApiKey, async (req, res) => {
  try {
    res.json({
      status: 'success',
      // Read-only author reference — the whitelist is a code constant.
      whitelist: [...engine.PORTAL_FIELD_WHITELIST].sort(),
      operators: engine.RULE_OPS,
      placements: engine.VALID_PLACEMENTS,
      coded_keys: engine.KNOWN_CODED_KEYS,
      sql_param_paths: [...engine.ALLOWED_SQL_PARAM_PATHS],
    });
  } catch (err) {
    fail(res, 'meta', err);
  }
});

router.get('/api/portal-cards-admin/cards', jwtOrApiKey, async (req, res) => {
  try {
    const cards = await listCards(req.db);
    res.json({ status: 'success', cards });
  } catch (err) {
    fail(res, 'listCards', err);
  }
});

router.get('/api/portal-cards-admin/cards/:id', jwtOrApiKey, async (req, res) => {
  try {
    const card = await getCard(req.db, req.params.id);
    res.json({ status: 'success', card });
  } catch (err) {
    fail(res, 'getCard', err);
  }
});

router.post('/api/portal-cards-admin/cards', jwtOrApiKey, async (req, res) => {
  try {
    const card = await createCard(req.db, req.body || {});
    res.status(201).json({ status: 'success', card });
  } catch (err) {
    fail(res, 'createCard', err);
  }
});

router.put('/api/portal-cards-admin/cards/:id', jwtOrApiKey, async (req, res) => {
  try {
    const card = await updateCard(req.db, req.params.id, req.body || {});
    res.json({ status: 'success', card });
  } catch (err) {
    fail(res, 'updateCard', err);
  }
});

router.delete('/api/portal-cards-admin/cards/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await deleteCard(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'deleteCard', err);
  }
});

router.post('/api/portal-cards-admin/preview', jwtOrApiKey, async (req, res) => {
  try {
    const payload = await previewDraft(req.db, req.body || {});
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'preview', err);
  }
});

module.exports = router;
// exported for tests (repo pattern: admin.apiKeys / api.appSettings)
module.exports._listCards   = listCards;
module.exports._getCard     = getCard;
module.exports._createCard  = createCard;
module.exports._updateCard  = updateCard;
module.exports._deleteCard  = deleteCard;
module.exports._previewDraft = previewDraft;
