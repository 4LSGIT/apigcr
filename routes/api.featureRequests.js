/**
 * Feature Requests API
 * routes/api.featureRequests.js
 *
 * GET    /api/feature-requests              list (with vote count, my vote, comment count)
 * POST   /api/feature-requests              submit new request
 * POST   /api/feature-requests/:id/vote     toggle vote on/off
 * PATCH  /api/feature-requests/:id          admin: update stage/status_note/progress/is_public
 * GET    /api/feature-requests/:id/comments list comments for a request
 * POST   /api/feature-requests/:id/comments add a comment or reply
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// ── helpers ──────────────────────────────────────────────────────────────────

const ADMIN_AUTH = ['authorized - SU', 'authorized - admin'];

function isAdmin(req) {
  return ADMIN_AUTH.includes(req.auth?.user_auth);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  next();
}

function userId(req) {
  return req.auth?.userId ?? null;
}

// ── LIST ─────────────────────────────────────────────────────────────────────

router.get('/api/feature-requests', jwtOrApiKey, async (req, res) => {
  try {
    const db  = req.db;
    const uid = userId(req);
    const admin = isAdmin(req);

    const [rows] = await db.query(
      `SELECT
         fr.*,
         u.user_name          AS submitter_name,
         COUNT(DISTINCT v.id) AS vote_count,
         COUNT(DISTINCT c.id) AS comment_count,
         MAX(CASE WHEN v.user_id = ? THEN 1 ELSE 0 END) AS my_vote
       FROM feature_requests fr
       LEFT JOIN users u                  ON u.user = fr.submitted_by
       LEFT JOIN feature_request_votes v  ON v.request_id = fr.id
       LEFT JOIN feature_request_comments c ON c.request_id = fr.id
       WHERE fr.is_public = 1 OR ? = 1
       GROUP BY fr.id
       ORDER BY vote_count DESC, fr.created_at DESC`,
      [uid, admin ? 1 : 0]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/feature-requests error:', err);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ── SUBMIT ───────────────────────────────────────────────────────────────────

router.post('/api/feature-requests', jwtOrApiKey, async (req, res) => {
  try {
    const { title, description, type = 'feature' } = req.body;
    if (!title?.trim() || !description?.trim()) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    if (!['bug', 'feature'].includes(type)) {
      return res.status(400).json({ error: 'type must be bug or feature' });
    }

    const [result] = await req.db.query(
      `INSERT INTO feature_requests (title, description, type, submitted_by)
       VALUES (?, ?, ?, ?)`,
      [title.trim(), description.trim(), type, userId(req)]
    );

    res.status(201).json({ id: result.insertId, message: 'Request submitted' });
  } catch (err) {
    console.error('POST /api/feature-requests error:', err);
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// ── TOGGLE VOTE ───────────────────────────────────────────────────────────────

router.post('/api/feature-requests/:id/vote', jwtOrApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const uid    = userId(req);

    // Check if vote exists
    const [[existing]] = await req.db.query(
      `SELECT id FROM feature_request_votes WHERE request_id = ? AND user_id = ?`,
      [id, uid]
    );

    if (existing) {
      await req.db.query(
        `DELETE FROM feature_request_votes WHERE request_id = ? AND user_id = ?`,
        [id, uid]
      );
      res.json({ voted: false });
    } else {
      await req.db.query(
        `INSERT INTO feature_request_votes (request_id, user_id) VALUES (?, ?)`,
        [id, uid]
      );
      res.json({ voted: true });
    }
  } catch (err) {
    console.error('POST /api/feature-requests/:id/vote error:', err);
    res.status(500).json({ error: 'Failed to toggle vote' });
  }
});

// ── ADMIN UPDATE ──────────────────────────────────────────────────────────────

const VALID_STAGES = [
  'considering', 'planning', 'working_on_it',
  'implemented', 'future_thought', 'rejected'
];

router.patch('/api/feature-requests/:id', jwtOrApiKey, requireAdmin, async (req, res) => {
  try {
    const { stage, status_note, progress, is_public } = req.body;
    const fields = [];
    const params = [];

    if (stage !== undefined) {
      if (!VALID_STAGES.includes(stage)) {
        return res.status(400).json({ error: 'Invalid stage value' });
      }
      fields.push('stage = ?'); params.push(stage);
    }
    if (status_note !== undefined) {
      fields.push('status_note = ?'); params.push(status_note?.slice(0, 64) ?? null);
    }
    if (progress !== undefined) {
      const p = parseInt(progress, 10);
      if (isNaN(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'progress must be 0–100' });
      }
      fields.push('progress = ?'); params.push(p);
    }
    if (is_public !== undefined) {
      fields.push('is_public = ?'); params.push(is_public ? 1 : 0);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await req.db.query(
      `UPDATE feature_requests SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('PATCH /api/feature-requests/:id error:', err);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// ── LIST COMMENTS ─────────────────────────────────────────────────────────────

router.get('/api/feature-requests/:id/comments', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT
         c.*,
         u.user_name AS author_name,
         u.user_initials AS author_initials
       FROM feature_request_comments c
       LEFT JOIN users u ON u.user = c.user_id
       WHERE c.request_id = ?
       ORDER BY c.created_at ASC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/feature-requests/:id/comments error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ── ADD COMMENT / REPLY ───────────────────────────────────────────────────────

router.post('/api/feature-requests/:id/comments', jwtOrApiKey, async (req, res) => {
  try {
    const { comment, parent_comment_id = null } = req.body;
    if (!comment?.trim()) {
      return res.status(400).json({ error: 'comment is required' });
    }

    const admin = isAdmin(req) ? 1 : 0;

    const [result] = await req.db.query(
      `INSERT INTO feature_request_comments
         (request_id, user_id, parent_comment_id, comment, is_admin)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, userId(req), parent_comment_id || null, comment.trim(), admin]
    );

    res.status(201).json({ id: result.insertId, message: 'Comment added' });
  } catch (err) {
    console.error('POST /api/feature-requests/:id/comments error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

module.exports = router;