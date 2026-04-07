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
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getLatest,
  upsertDraft,
  submitForm,
  deleteDraft,
  getHistory,
};