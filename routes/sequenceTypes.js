// routes/sequenceTypes.js
//
// CRUD for sequence_template_types — the per-type cascade configuration
// table introduced in Slice E Phase 2. Each row defines:
//
//   type             string PK    e.g. 'no_show', 'lead_drip'
//   priority_fields  JSON array   ordered list of trigger_data keys used
//                                 for cascade scoring (most → least specific)
//   description      text         human note
//   active           bool         disable a whole type at once
//
// Endpoints (all under no path prefix — Express auto-mounting reads
// route paths from inside the router):
//
//   GET    /api/sequence-types          list all (active + inactive)
//   GET    /api/sequence-types/:type    fetch one
//   POST   /api/sequence-types          create
//   PUT    /api/sequence-types/:type    update (description, priority_fields, active)
//   DELETE /api/sequence-types/:type    delete (rejects 409 if any sequence_templates use this type)
//
// All write operations are SU-gated and audited under tool='sequence_types',
// matching the pattern in routes/api.emailCredentials.js and
// routes/api.oauth.js. Read endpoints use jwtOrApiKey (any authed user).
//
// Validation:
//   • type           /^[a-z][a-z0-9_]*$/  ≤50 chars
//   • priority_fields array of unique strings each matching the same regex,
//                    each ≤50 chars
//
// Shrinkage protection:
//   PUT that removes a key from priority_fields is rejected 409 if any
//   sequence_templates row of this type has that key in its filters JSON.

const express = require('express');
const router  = express.Router();

const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');

const TOOL = 'sequence_types';
const su = superuserOnlyFor(TOOL);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const NAME_MAX = 50;

function reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function audit(db, row) {
  return auditAdminAction(db, row).catch(err =>
    console.error('[sequence-types] audit log failed:', err.message)
  );
}

/** Coerce DB-returned priority_fields into a JS array. */
function parsePriorityFields(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}

/**
 * Validate a `type` name. Returns null on success, or a string error.
 * Used both for body input on POST and for the path param on every endpoint
 * (the path param is also a defense-in-depth — Express trusts whatever
 * shows up in :type).
 */
function validateTypeName(t) {
  if (typeof t !== 'string') return 'type must be a string';
  if (!t.length) return 'type cannot be empty';
  if (t.length > NAME_MAX) return `type cannot exceed ${NAME_MAX} chars`;
  if (!NAME_RE.test(t)) return `type must match ${NAME_RE} (lowercase letters, digits, underscore; must start with a letter)`;
  return null;
}

/**
 * Validate priority_fields. Returns null on success, or a string error.
 * Allows empty array (a type with no cascade — every template scores 0,
 * lowest id wins).
 */
function validatePriorityFields(pf) {
  if (!Array.isArray(pf)) return 'priority_fields must be a JSON array';
  const seen = new Set();
  for (const f of pf) {
    if (typeof f !== 'string') return 'priority_fields entries must be strings';
    if (!f.length) return 'priority_fields entries cannot be empty';
    if (f.length > NAME_MAX) return `priority_fields entry "${f}" exceeds ${NAME_MAX} chars`;
    if (!NAME_RE.test(f)) return `priority_fields entry "${f}" must match ${NAME_RE}`;
    if (seen.has(f)) return `priority_fields contains duplicate "${f}"`;
    seen.add(f);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/sequence-types
// ─────────────────────────────────────────────────────────────

router.get('/api/sequence-types', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT type, priority_fields, description, active, created_at, updated_at
         FROM sequence_template_types
         ORDER BY type ASC`
    );
    // Coerce priority_fields to array form for clients (mysql2 may return
    // JSON columns as strings depending on connection options).
    const out = rows.map(r => ({
      ...r,
      priority_fields: parsePriorityFields(r.priority_fields) || [],
      active: !!r.active,
    }));
    res.json({ success: true, types: out });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sequence types', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/sequence-types/:type
// ─────────────────────────────────────────────────────────────

router.get('/api/sequence-types/:type', jwtOrApiKey, async (req, res) => {
  const t = req.params.type;
  const tErr = validateTypeName(t);
  if (tErr) return res.status(400).json({ error: tErr });

  try {
    const [[row]] = await req.db.query(
      `SELECT type, priority_fields, description, active, created_at, updated_at
         FROM sequence_template_types WHERE type = ?`,
      [t]
    );
    if (!row) return res.status(404).json({ error: 'Sequence type not found' });
    res.json({
      success: true,
      type: { ...row, priority_fields: parsePriorityFields(row.priority_fields) || [], active: !!row.active },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sequence type', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/sequence-types
// ─────────────────────────────────────────────────────────────

router.post('/api/sequence-types', ...su, async (req, res) => {
  const meta = reqMeta(req);
  const auditBase = {
    tool: TOOL,
    userId:   req.auth.userId,
    username: req.auth.username,
    route:    req.originalUrl,
    method:   req.method,
    ...meta,
  };

  const { type, priority_fields, description = null, active = true } = req.body || {};

  const tErr = validateTypeName(type);
  if (tErr) {
    audit(req.db, { ...auditBase, status: 'rejected_validation', errorMessage: tErr, details: { reason: 'type_invalid' } });
    return res.status(400).json({ error: tErr });
  }
  const pfErr = validatePriorityFields(priority_fields);
  if (pfErr) {
    audit(req.db, { ...auditBase, status: 'rejected_validation', errorMessage: pfErr, details: { type, reason: 'priority_fields_invalid' } });
    return res.status(400).json({ error: pfErr });
  }
  if (description != null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string or null' });
  }

  try {
    const [exists] = await req.db.query(
      `SELECT type FROM sequence_template_types WHERE type = ? LIMIT 1`,
      [type]
    );
    if (exists.length) {
      audit(req.db, { ...auditBase, status: 'rejected_conflict', errorMessage: 'type already exists', details: { type } });
      return res.status(409).json({ error: `Sequence type "${type}" already exists` });
    }

    await req.db.query(
      `INSERT INTO sequence_template_types (type, priority_fields, description, active)
       VALUES (?, ?, ?, ?)`,
      [type, JSON.stringify(priority_fields), description, active ? 1 : 0]
    );

    audit(req.db, {
      ...auditBase,
      status: 'success',
      details: { type, priority_fields, description, active: !!active, action: 'create' },
    });
    res.status(201).json({ success: true, type });
  } catch (err) {
    audit(req.db, { ...auditBase, status: 'error', errorMessage: err.message, details: { type } });
    res.status(500).json({ error: 'Failed to create sequence type', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/sequence-types/:type
// ─────────────────────────────────────────────────────────────

router.put('/api/sequence-types/:type', ...su, async (req, res) => {
  const meta = reqMeta(req);
  const t = req.params.type;
  const auditBase = {
    tool: TOOL,
    userId:   req.auth.userId,
    username: req.auth.username,
    route:    req.originalUrl,
    method:   req.method,
    ...meta,
  };

  const tErr = validateTypeName(t);
  if (tErr) {
    audit(req.db, { ...auditBase, status: 'rejected_validation', errorMessage: tErr, details: { reason: 'type_invalid' } });
    return res.status(400).json({ error: tErr });
  }

  const { priority_fields, description, active } = req.body || {};

  if (priority_fields !== undefined) {
    const pfErr = validatePriorityFields(priority_fields);
    if (pfErr) {
      audit(req.db, { ...auditBase, status: 'rejected_validation', errorMessage: pfErr, details: { type: t, reason: 'priority_fields_invalid' } });
      return res.status(400).json({ error: pfErr });
    }
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string or null' });
  }

  try {
    const [[existing]] = await req.db.query(
      `SELECT type, priority_fields FROM sequence_template_types WHERE type = ?`,
      [t]
    );
    if (!existing) return res.status(404).json({ error: 'Sequence type not found' });

    // ── Shrinkage protection ──
    // If priority_fields removes any key from the existing list, reject if
    // any sequence_templates row of this type has that key in its filters.
    if (priority_fields !== undefined) {
      const oldFields = parsePriorityFields(existing.priority_fields) || [];
      const newFieldsSet = new Set(priority_fields);
      const removedKeys = oldFields.filter(k => !newFieldsSet.has(k));

      if (removedKeys.length) {
        // For each removed key, check if any template's filters JSON
        // references it. JSON_CONTAINS_PATH is exact and indexed-friendly.
        // We OR them in a single query.
        const conditions = removedKeys.map(() => `JSON_CONTAINS_PATH(filters, 'one', ?)`).join(' OR ');
        const params = [t, ...removedKeys.map(k => `$.${k}`)];
        const [offenders] = await req.db.query(
          `SELECT id, name FROM sequence_templates
            WHERE type = ? AND filters IS NOT NULL AND (${conditions})`,
          params
        );
        if (offenders.length) {
          const detail = offenders.map(o => `#${o.id} "${o.name}"`).join(', ');
          const msg =
            `Cannot remove priority_fields ${removedKeys.map(k => `"${k}"`).join(', ')} — ` +
            `${offenders.length} template(s) of type "${t}" use them: ${detail}. ` +
            `Clear those filters first or restore the keys.`;
          audit(req.db, { ...auditBase, status: 'rejected_conflict', errorMessage: msg, details: { type: t, removed_keys: removedKeys, offenders: offenders.map(o => ({ id: o.id, name: o.name })) } });
          return res.status(409).json({ error: msg, removed_keys: removedKeys, offenders });
        }
      }
    }

    const updates = [];
    const params  = [];
    if (priority_fields !== undefined) { updates.push('priority_fields = ?'); params.push(JSON.stringify(priority_fields)); }
    if (description     !== undefined) { updates.push('description = ?');     params.push(description); }
    if (active          !== undefined) { updates.push('active = ?');          params.push(active ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(t);
    await req.db.query(
      `UPDATE sequence_template_types SET ${updates.join(', ')}, updated_at = NOW() WHERE type = ?`,
      params
    );

    audit(req.db, {
      ...auditBase,
      status: 'success',
      details: { type: t, action: 'update', changed_fields: updates.map(u => u.split(' = ')[0]) },
    });
    res.json({ success: true, type: t });
  } catch (err) {
    audit(req.db, { ...auditBase, status: 'error', errorMessage: err.message, details: { type: t } });
    res.status(500).json({ error: 'Failed to update sequence type', message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/sequence-types/:type
// ─────────────────────────────────────────────────────────────

router.delete('/api/sequence-types/:type', ...su, async (req, res) => {
  const meta = reqMeta(req);
  const t = req.params.type;
  const auditBase = {
    tool: TOOL,
    userId:   req.auth.userId,
    username: req.auth.username,
    route:    req.originalUrl,
    method:   req.method,
    ...meta,
  };

  const tErr = validateTypeName(t);
  if (tErr) return res.status(400).json({ error: tErr });

  try {
    const [[existing]] = await req.db.query(
      `SELECT type FROM sequence_template_types WHERE type = ?`,
      [t]
    );
    if (!existing) return res.status(404).json({ error: 'Sequence type not found' });

    // Reject if any sequence_templates row uses this type — active or not.
    // Avoids orphaning templates that would then fail enrollment with a
    // confusing "Unknown sequence type" error.
    const [[{ n }]] = await req.db.query(
      `SELECT COUNT(*) AS n FROM sequence_templates WHERE type = ?`,
      [t]
    );
    if (n > 0) {
      const msg = `Cannot delete sequence type "${t}" — ${n} sequence_templates row(s) reference it. Reassign or delete those templates first.`;
      audit(req.db, { ...auditBase, status: 'rejected_conflict', errorMessage: msg, details: { type: t, template_count: n } });
      return res.status(409).json({ error: msg, template_count: n });
    }

    await req.db.query(`DELETE FROM sequence_template_types WHERE type = ?`, [t]);
    audit(req.db, { ...auditBase, status: 'success', details: { type: t, action: 'delete' } });
    res.json({ success: true, message: `Sequence type "${t}" deleted` });
  } catch (err) {
    audit(req.db, { ...auditBase, status: 'error', errorMessage: err.message, details: { type: t } });
    res.status(500).json({ error: 'Failed to delete sequence type', message: err.message });
  }
});

module.exports = router;