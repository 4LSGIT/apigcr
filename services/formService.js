// services/formService.js
//
/**
 * formService.js — Service layer for the YisraCase Forms System
 *
 * Handles CRUD for form_submissions table:
 *   - Draft upsert (autosave)
 *   - Submission insert (explicit save)
 *   - Latest draft + submission lookup
 *   - Draft deletion (discard)
 *   - Submission history
 */

// ─────────────────────────────────────────────────────────────────────────────
// GET LATEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the most recent submitted row and the current draft (if any)
 * for a given form + entity combination.
 *
 * @param {object} db        - mysql2 pool (req.db)
 * @param {string} formKey   - e.g. 'contact_info', '341_notes'
 * @param {string} linkType  - 'contact', 'case', 'appt'
 * @param {string} linkId    - entity ID
 * @returns {{ submitted: object|null, draft: object|null }}
 */
async function getLatest(db, formKey, linkType, linkId) {
  // Draft — at most one row due to draft_key unique constraint
  const [[draft]] = await db.query(
    `SELECT fs.id, fs.schema_version, fs.data, fs.updated_at, fs.submitted_by,
            u.user_name AS user_name
     FROM form_submissions fs
     LEFT JOIN users u ON u.user = fs.submitted_by
     WHERE fs.form_key = ? AND fs.link_type = ? AND fs.link_id = ? AND fs.status = 'draft'
     LIMIT 1`,
    [formKey, linkType, linkId]
  );

  // Latest submitted — most recent by version (or updated_at as tiebreaker)
  const [[submitted]] = await db.query(
    `SELECT fs.id, fs.version, fs.schema_version, fs.data, fs.updated_at, fs.submitted_by,
            u.user_name AS user_name
     FROM form_submissions fs
     LEFT JOIN users u ON u.user = fs.submitted_by
     WHERE fs.form_key = ? AND fs.link_type = ? AND fs.link_id = ? AND fs.status = 'submitted'
     ORDER BY fs.version DESC, fs.updated_at DESC
     LIMIT 1`,
    [formKey, linkType, linkId]
  );

  return {
    submitted: submitted || null,
    draft: draft || null,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// UPSERT DRAFT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert or update the single draft row for a form + entity.
 * Uses INSERT ... ON DUPLICATE KEY UPDATE on the draft_key unique index.
 *
 * @param {object} db
 * @param {string} formKey
 * @param {string} linkType
 * @param {string} linkId
 * @param {number} schemaVersion
 * @param {object} data          - full form payload (will be stored as JSON)
 * @param {number|null} userId   - req.auth.userId
 * @returns {{ id: number, updated_at: string }}
 */
async function upsertDraft(db, formKey, linkType, linkId, schemaVersion, data, userId) {
  const dataJson = typeof data === 'string' ? data : JSON.stringify(data);

  const [result] = await db.query(
    `INSERT INTO form_submissions
       (form_key, link_type, link_id, status, version, schema_version, data, submitted_by)
     VALUES (?, ?, ?, 'draft', 0, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       data = VALUES(data),
       schema_version = VALUES(schema_version),
       submitted_by = VALUES(submitted_by),
       updated_at = NOW()`,
    [formKey, linkType, linkId, schemaVersion, dataJson, userId]
  );

  // insertId is the new row ID on insert, or 0 on update.
  // For update, we need to fetch the existing row's ID.
  let id = result.insertId;
  if (id === 0) {
    const [[row]] = await db.query(
      `SELECT id, updated_at FROM form_submissions
       WHERE form_key = ? AND link_type = ? AND link_id = ? AND status = 'draft'
       LIMIT 1`,
      [formKey, linkType, linkId]
    );
    id = row.id;
  }

  // Fetch updated_at for response
  const [[updated]] = await db.query(
    `SELECT updated_at FROM form_submissions WHERE id = ?`,
    [id]
  );

  return { id, updated_at: updated.updated_at };
}


// ─────────────────────────────────────────────────────────────────────────────
// SUBMIT FORM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an explicit form submission. Appends a new row with status='submitted'
 * and auto-incremented version.
 *
 * @param {object} db
 * @param {string} formKey
 * @param {string} linkType
 * @param {string} linkId
 * @param {number} schemaVersion
 * @param {object} data
 * @param {number|null} userId
 * @returns {{ id: number, version: number, updated_at: string }}
 */
async function submitForm(db, formKey, linkType, linkId, schemaVersion, data, userId) {
  const dataJson = typeof data === 'string' ? data : JSON.stringify(data);

  // Get next version number
  const [[maxRow]] = await db.query(
    `SELECT COALESCE(MAX(version), 0) AS max_version
     FROM form_submissions
     WHERE form_key = ? AND link_type = ? AND link_id = ? AND status = 'submitted'`,
    [formKey, linkType, linkId]
  );
  const nextVersion = maxRow.max_version + 1;

  const [result] = await db.query(
    `INSERT INTO form_submissions
       (form_key, link_type, link_id, status, version, schema_version, data, submitted_by)
     VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)`,
    [formKey, linkType, linkId, nextVersion, schemaVersion, dataJson, userId]
  );

  // Fetch updated_at
  const [[row]] = await db.query(
    `SELECT updated_at FROM form_submissions WHERE id = ?`,
    [result.insertId]
  );

  return {
    id: result.insertId,
    version: nextVersion,
    updated_at: row.updated_at,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// DELETE DRAFT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete the draft row for a form + entity (user clicked "Discard").
 *
 * @param {object} db
 * @param {string} formKey
 * @param {string} linkType
 * @param {string} linkId
 * @returns {{ deleted: boolean }}
 */
async function deleteDraft(db, formKey, linkType, linkId) {
  const [result] = await db.query(
    `DELETE FROM form_submissions
     WHERE form_key = ? AND link_type = ? AND link_id = ? AND status = 'draft'`,
    [formKey, linkType, linkId]
  );

  return { deleted: result.affectedRows > 0 };
}


// ─────────────────────────────────────────────────────────────────────────────
// GET HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch submission history for a form + entity, newest first.
 *
 * @param {object} db
 * @param {string} formKey
 * @param {string} linkType
 * @param {string} linkId
 * @param {number} limit    - max rows (default 10, max 50)
 * @returns {Array<object>}
 */
async function getHistory(db, formKey, linkType, linkId, limit = 10) {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  const [rows] = await db.query(
    `SELECT fs.id, fs.version, fs.schema_version, fs.data, fs.updated_at,
            fs.submitted_by, u.user_name AS user_name
     FROM form_submissions fs
     LEFT JOIN users u ON u.user = fs.submitted_by
     WHERE fs.form_key = ? AND fs.link_type = ? AND fs.link_id = ? AND fs.status = 'submitted'
     ORDER BY fs.version DESC
     LIMIT ?`,
    [formKey, linkType, linkId, safeLimit]
  );

  return rows;
}


// ─────────────────────────────────────────────────────────────────────────────
// BROWSE SUBMISSIONS (Slice 4 — admin, read-only)
// ─────────────────────────────────────────────────────────────────────────────
// Unlike the older functions in this file, the two below throw Errors carrying
// `.status` (400/404) for the route to map — the accepted improvement pattern
// from api.formTemplates (existing functions/routes are untouched).

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Admin browse over form_submissions — summary columns only (no `data`).
 * All filters optional; newest first; `before_id` is a keyset cursor
 * (pass the smallest id from the previous page to get the next one).
 *
 * X4 additions (all opt-in — absent params keep the pre-X4 query byte-identical):
 *   unlinked=1  → WHERE fs.link_type = '' (the unlinked convention; the plain
 *                 link_type filter can't express it because '' is falsy).
 *   linked=1    → the inverse, WHERE fs.link_type <> ''. Mutually exclusive
 *                 with unlinked (400) — together they select nothing, which
 *                 would read as "no results" instead of "bad query".
 *   with_data=1 → include fs.data in the SELECT. The Form Inbox needs a
 *                 preview (name/email/phone) per row; rows are small
 *                 (intake ≈1–2KB) and the limit cap bounds the payload.
 *
 * @param {object} db
 * @param {object} filters  { form_key?, link_type?, link_id?, status?, limit?, before_id?, unlinked?, linked?, with_data? }
 * @returns {{ submissions: Array<object>, limit: number }}
 */
const _isOn = (v) => (v === '1' || v === 1 || v === true);

async function browseSubmissions(db, filters) {
  const f = filters || {};
  const where = [];
  const params = [];

  const wantUnlinked = _isOn(f.unlinked);
  const wantLinked   = _isOn(f.linked);
  if (wantUnlinked && wantLinked) {
    throw httpError(400, 'unlinked and linked are mutually exclusive');
  }

  if (f.form_key)  { where.push('fs.form_key = ?');  params.push(f.form_key); }
  if (f.link_type) { where.push('fs.link_type = ?'); params.push(f.link_type); }
  if (f.link_id)   { where.push('fs.link_id = ?');   params.push(f.link_id); }
  if (wantUnlinked) where.push("fs.link_type = ''");
  if (wantLinked)   where.push("fs.link_type <> ''");

  if (f.status) {
    if (f.status !== 'draft' && f.status !== 'submitted') {
      throw httpError(400, "status must be 'draft' or 'submitted'");
    }
    where.push('fs.status = ?');
    params.push(f.status);
  }

  if (f.before_id !== undefined && f.before_id !== null && f.before_id !== '') {
    const n = Number(f.before_id);
    if (!Number.isInteger(n) || n <= 0) {
      throw httpError(400, 'before_id must be a positive integer');
    }
    where.push('fs.id < ?');
    params.push(n);
  }

  const limit = Math.min(Math.max(1, parseInt(f.limit, 10) || 50), 200);
  params.push(limit);

  const dataCol = _isOn(f.with_data) ? ', fs.data' : '';

  const [rows] = await db.query(
    `SELECT fs.id, fs.form_key, fs.link_type, fs.link_id, fs.status, fs.version,
            fs.schema_version, fs.submitted_by, u.user_name AS user_name,
            fs.linked_by, fs.linked_at,
            fs.created_at, fs.updated_at${dataCol}
     FROM form_submissions fs
     LEFT JOIN users u ON u.user = fs.submitted_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY fs.id DESC
     LIMIT ?`,
    params
  );

  return { submissions: rows, limit };
}


/**
 * One submission row including `data`. 404 when the id is unknown.
 */
async function getSubmission(db, id) {
  const [[row]] = await db.query(
    `SELECT fs.id, fs.form_key, fs.link_type, fs.link_id, fs.status, fs.version,
            fs.schema_version, fs.data, fs.submitted_by, u.user_name AS user_name,
            fs.linked_by, fs.linked_at,
            fs.created_at, fs.updated_at
     FROM form_submissions fs
     LEFT JOIN users u ON u.user = fs.submitted_by
     WHERE fs.id = ?
     LIMIT 1`,
    [id]
  );
  if (!row) throw httpError(404, `Submission ${id} not found`);
  return row;
}


// ─────────────────────────────────────────────────────────────────────────────
// LINK SUBMISSION (X4 — Form Inbox adopt)
// ─────────────────────────────────────────────────────────────────────────────

// Entity-existence probes per link type. caseId is opaque free text — equality
// check ONLY, never shape-parsed (standing caseId rule). All three PKs verified
// against the live schema 2026-08-13: cases.case_id, contacts.contact_id,
// appts.appt_id.
const LINK_TARGETS = {
  case:    { table: 'cases',    pk: 'case_id'    },
  contact: { table: 'contacts', pk: 'contact_id' },
  appt:    { table: 'appts',    pk: 'appt_id'    },
};

/**
 * Adopt an unlinked submission onto a case/contact/appt
 * (EXTERNAL_FORMS_DESIGN §8). One-way: unlinked ('','') → linked only.
 * Relinking / unlinking is deliberately absent — mistakes are a manual SQL
 * fix, not a route capability.
 *
 * Guards (in order):
 *   - submission exists (404) and status='submitted' (400 — drafts don't adopt)
 *   - currently unlinked: link_type='' (409 otherwise)
 *   - linkType ∈ case|contact|appt (400)
 *   - template link_type match (409): a case-form must land on a case. The
 *     template row is looked up by form_key; a submission with NO template row
 *     (legacy hand-built keys) skips this guard — staff knows best there.
 *   - target entity exists (404), by PK equality only
 *
 * Version renumber: anonymous submissions all share ONE version counter (the
 * ('','') series in submitForm's MAX+1), so a row carries a version that is
 * meaningless in its new home and can shadow the target's real latest in
 * getLatest's ORDER BY version DESC. The adopted row therefore takes
 * MAX(version)+1 within the TARGET series — the act of adoption makes it the
 * newest submission of that form for that entity.
 *
 * Side-effects (Fred-ratified 2026-08-13, option b):
 *   - a `log` entry on the target (type 'form') recording the adopt —
 *     best-effort: a log failure warns but never rolls back the linkage.
 *   - intake gate: form_key='intake' + linkType='case' → stamp
 *     cases.case_intake_form = 'yf:<submission_id>' ONLY when currently ''
 *     (additive, mirrors wf40 step 8 exactly; the WHERE carries the guard).
 *     EXPLICIT HARDCODE: the one per-form behavior in this route family, kept
 *     here because a freshly-adopted intake must close the sequence-engine
 *     nag gate (seq 20/22 condition on case_intake_form is_null) without
 *     re-firing wf40 (which would duplicate the notify email).
 *
 * The UPDATE's WHERE re-checks link_type='' so a concurrent double-adopt
 * loses cleanly (affectedRows 0 → 409) instead of overwriting.
 *
 * @param {object} db
 * @param {number|string} id     — submission id
 * @param {string} linkType      — 'case' | 'contact' | 'appt'
 * @param {string} linkId        — target entity id (opaque)
 * @param {number|null} userId   — req.auth.userId (the adopting staff member)
 * @returns {{ id, link_type, link_id, version, linked_by, intake_stamped, logged }}
 */
async function linkSubmission(db, id, linkType, linkId, userId) {
  const subId = Number(id);
  if (!Number.isInteger(subId) || subId <= 0) {
    throw httpError(400, 'submission id must be a positive integer');
  }

  const target = LINK_TARGETS[linkType];
  if (!target) {
    throw httpError(400, "link_type must be 'case', 'contact' or 'appt'");
  }
  const cleanLinkId = String(linkId == null ? '' : linkId).trim();
  if (!cleanLinkId) throw httpError(400, 'link_id is required');
  if (cleanLinkId.length > 20) throw httpError(400, 'link_id too long (max 20)');

  // ── Submission row ──
  const [[sub]] = await db.query(
    `SELECT id, form_key, link_type, link_id, status, version
     FROM form_submissions WHERE id = ? LIMIT 1`,
    [subId]
  );
  if (!sub) throw httpError(404, `Submission ${subId} not found`);
  if (sub.status !== 'submitted') {
    throw httpError(400, 'Only submitted submissions can be linked');
  }
  if (sub.link_type !== '') {
    throw httpError(409,
      `Submission ${subId} is already linked (${sub.link_type} ${sub.link_id})`);
  }

  // ── Template link_type enforcement + title for the log entry ──
  const [[tpl]] = await db.query(
    `SELECT title, link_type FROM form_templates WHERE form_key = ? LIMIT 1`,
    [sub.form_key]
  );
  if (tpl && tpl.link_type !== linkType) {
    throw httpError(409,
      `Form "${sub.form_key}" is a ${tpl.link_type}-linked form — it cannot be linked to a ${linkType}`);
  }

  // ── Target entity exists (PK equality only — opaque ids) ──
  const [[ent]] = await db.query(
    `SELECT ${target.pk} FROM ${target.table} WHERE ${target.pk} = ? LIMIT 1`,
    [cleanLinkId]
  );
  if (!ent) throw httpError(404, `${linkType} "${cleanLinkId}" not found`);

  // ── Version renumber into the target series ──
  const [[maxRow]] = await db.query(
    `SELECT COALESCE(MAX(version), 0) AS max_version
     FROM form_submissions
     WHERE form_key = ? AND link_type = ? AND link_id = ? AND status = 'submitted'`,
    [sub.form_key, linkType, cleanLinkId]
  );
  const nextVersion = maxRow.max_version + 1;

  // ── The linkage write (double-guarded against a concurrent adopt) ──
  const [upd] = await db.query(
    `UPDATE form_submissions
     SET link_type = ?, link_id = ?, version = ?, linked_by = ?, linked_at = NOW()
     WHERE id = ? AND link_type = ''`,
    [linkType, cleanLinkId, nextVersion, userId || null, subId]
  );
  if (!upd.affectedRows) {
    throw httpError(409, `Submission ${subId} was linked by someone else — refresh`);
  }

  // ── Side-effect 1: intake gate stamp (guard rides the WHERE — additive only) ──
  let intakeStamped = false;
  if (sub.form_key === 'intake' && linkType === 'case') {
    const [stamp] = await db.query(
      `UPDATE cases SET case_intake_form = ? WHERE case_id = ? AND case_intake_form = ''`,
      [`yf:${subId}`, cleanLinkId]
    );
    intakeStamped = stamp.affectedRows > 0;
  }

  // ── Side-effect 2: audit log on the target (best-effort) ──
  let logged = false;
  try {
    const logService = require('./logService');
    const title = (tpl && tpl.title) || sub.form_key;
    await logService.createLogEntry(db, {
      type: 'form',
      link_type: linkType,
      link_id: cleanLinkId,
      by: userId || 0,
      subject: `Form adopted: ${title}`,
      message: `${title} submission #${subId} (received unlinked) was linked to this ${linkType} from the Form Inbox.`,
      data: { form_key: sub.form_key, submission_id: subId, adopted: true },
    });
    logged = true;
  } catch (err) {
    console.warn('[formService] linkSubmission: audit log failed (linkage kept):', err.message);
  }

  return {
    id: subId,
    link_type: linkType,
    link_id: cleanLinkId,
    version: nextVersion,
    linked_by: userId || null,
    intake_stamped: intakeStamped,
    logged,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// GET SUBMISSION FOR RENDER (X4 — read-only submission view)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One submission + the definition to render it under, resolved server-side so
 * render.html's view mode is one round trip:
 *
 *   1. current published definition when its schema_version matches the
 *      submission's — the common case;
 *   2. else the NEWEST form_template_versions row carrying that
 *      schema_version (multiple version rows can share one schema_version —
 *      layout-only republishes don't bump — and the newest one is the last
 *      layout that field set had);
 *   3. else the current published definition with schema_matched:false —
 *      the view renders what it can and the renderer warns.
 *
 * 404 when the submission is unknown, the template row is gone, or no
 * definition exists anywhere (never-published template).
 *
 * data is returned PARSED (mysql2 may hand the json column back as either).
 *
 * @returns {{ submission, title, link_type, definition, definition_schema_version, schema_matched }}
 */
async function getSubmissionForRender(db, id) {
  const sub = await getSubmission(db, id);   // throws 404 on unknown id
  if (typeof sub.data === 'string') {
    try { sub.data = JSON.parse(sub.data); }
    catch (e) { throw httpError(500, `Submission ${sub.id} data is not valid JSON`); }
  }

  const [[tpl]] = await db.query(
    `SELECT id, title, link_type, schema_version, definition
     FROM form_templates WHERE form_key = ? LIMIT 1`,
    [sub.form_key]
  );
  if (!tpl) throw httpError(404, `No template exists for form_key "${sub.form_key}"`);

  const parseDef = (d) => (typeof d === 'string' ? JSON.parse(d) : d);

  let definition = null;
  let defSchemaVersion = null;
  let schemaMatched = false;

  if (tpl.definition && tpl.schema_version === sub.schema_version) {
    definition = parseDef(tpl.definition);
    defSchemaVersion = tpl.schema_version;
    schemaMatched = true;
  } else {
    const [[ver]] = await db.query(
      `SELECT definition, schema_version FROM form_template_versions
       WHERE template_id = ? AND schema_version = ?
       ORDER BY id DESC LIMIT 1`,
      [tpl.id, sub.schema_version]
    );
    if (ver) {
      definition = parseDef(ver.definition);
      defSchemaVersion = ver.schema_version;
      schemaMatched = true;
    } else if (tpl.definition) {
      definition = parseDef(tpl.definition);
      defSchemaVersion = tpl.schema_version;
      schemaMatched = false;
    }
  }

  if (!definition) {
    throw httpError(404, `No published definition available for form_key "${sub.form_key}"`);
  }

  return {
    submission: sub,
    title: tpl.title,
    link_type: tpl.link_type,
    definition,
    definition_schema_version: defSchemaVersion,
    schema_matched: schemaMatched,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getLatest,
  upsertDraft,
  submitForm,
  deleteDraft,
  getHistory,
  browseSubmissions,
  getSubmission,
  linkSubmission,
  getSubmissionForRender,
};