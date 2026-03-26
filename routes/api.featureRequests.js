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

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const emailService = require('../services/emailService');

// ── constants ─────────────────────────────────────────────────────────────────

const ADMIN_AUTH  = ['authorized - SU', 'authorized - admin'];
const FROM_ADDR   = 'automations@4lsg.com';
const ADMIN_EMAIL = 'IT@4lsg.com';

const STAGE_LABELS = {
  considering:    'Considering',
  planning:       'Planning',
  working_on_it:  'Working on it',
  implemented:    'Implemented ✅',
  future_thought: 'Future thought',
  rejected:       'Rejected',
};

// ── helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Fire-and-forget email. Never throws — logs failures to console only.
 */
function sendEmail(db, opts) {
  emailService.sendEmail(db, { from: FROM_ADDR, ...opts })
    .catch(err => console.error('[feature-requests] email failed:', err.message));
}

/**
 * Fetch a feature request row joined with submitter name + email.
 */
async function getRequest(db, id) {
  const [[row]] = await db.query(
    `SELECT fr.*, u.user_name AS submitter_name, u.email AS submitter_email
     FROM feature_requests fr
     LEFT JOIN users u ON u.user = fr.submitted_by
     WHERE fr.id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

// ── LIST ─────────────────────────────────────────────────────────────────────

router.get('/api/feature-requests', jwtOrApiKey, async (req, res) => {
  try {
    const db    = req.db;
    const uid   = userId(req);
    const admin = isAdmin(req);

    const [rows] = await db.query(
      `SELECT
         fr.*,
         u.user_name          AS submitter_name,
         COUNT(DISTINCT v.id) AS vote_count,
         COUNT(DISTINCT c.id) AS comment_count,
         MAX(CASE WHEN v.user_id = ? THEN 1 ELSE 0 END) AS my_vote
       FROM feature_requests fr
       LEFT JOIN users u                    ON u.user = fr.submitted_by
       LEFT JOIN feature_request_votes v    ON v.request_id = fr.id
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

// ── SUBMIT ────────────────────────────────────────────────────────────────────

router.post('/api/feature-requests', jwtOrApiKey, async (req, res) => {
  try {
    const { title, description, type = 'feature' } = req.body;
    if (!title?.trim() || !description?.trim()) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    if (!['bug', 'feature'].includes(type)) {
      return res.status(400).json({ error: 'type must be bug or feature' });
    }

    const uid = userId(req);

    const [result] = await req.db.query(
      `INSERT INTO feature_requests (title, description, type, submitted_by)
       VALUES (?, ?, ?, ?)`,
      [title.trim(), description.trim(), type, uid]
    );

    res.status(201).json({ id: result.insertId, message: 'Request submitted' });

    // ── notify admin (non-blocking) ──
    ;(async () => {
      try {
        const [[submitter]] = await req.db.query(
          `SELECT user_name FROM users WHERE user = ? LIMIT 1`, [uid]
        );
        const name  = submitter?.user_name || `User #${uid}`;
        const label = type === 'bug' ? '🐛 Bug' : '✨ Feature Request';

        sendEmail(req.db, {
          to:      ADMIN_EMAIL,
          subject: `[YisraCase] New ${label}: ${title.trim()}`,
          text:    `${name} submitted a new ${type} request.\n\nTitle: ${title.trim()}\n\n${description.trim()}`,
          html:    `<p><strong>${name}</strong> submitted a new <strong>${label}</strong>.</p>
                    <p><strong>Title:</strong> ${title.trim()}</p>
                    <blockquote style="border-left:3px solid #ccc;padding-left:1rem;color:#555">
                      ${description.trim().replace(/\n/g, '<br>')}
                    </blockquote>`
        });
      } catch(e) {
        console.error('[feature-requests] submit notify error:', e.message);
      }
    })();

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

    // ── notify submitter if stage or status_note changed (non-blocking) ──
    if (stage !== undefined || status_note !== undefined) {
      ;(async () => {
        try {
          const fr = await getRequest(req.db, req.params.id);
          if (!fr?.submitter_email) return;

          const stageLabel  = STAGE_LABELS[stage ?? fr.stage] || (stage ?? fr.stage);
          const noteText    = (status_note !== undefined ? status_note : fr.status_note) || '';
          const progressVal = progress !== undefined ? progress : fr.progress;
          const typeLabel   = fr.type === 'bug' ? '🐛 Bug' : '✨ Feature Request';

          sendEmail(req.db, {
            to:      fr.submitter_email,
            subject: `Update on your ${fr.type} request: "${fr.title}"`,
            text: [
              `Hi ${fr.submitter_name || 'there'},`,
              ``,
              `Your ${fr.type} request "${fr.title}" has been updated.`,
              ``,
              `Stage: ${stageLabel}`,
              noteText    ? `Status: ${noteText}` : null,
              progressVal > 0 ? `Progress: ${progressVal}%` : null,
            ].filter(l => l !== null).join('\n'),
            html: `
              <p>Hi <strong>${fr.submitter_name || 'there'}</strong>,</p>
              <p>Your <strong>${typeLabel}</strong> "<strong>${fr.title}</strong>" has been updated.</p>
              <table style="border-collapse:collapse;margin-top:.75rem">
                <tr>
                  <td style="padding:.3rem .75rem .3rem 0;font-weight:600;color:#555">Stage</td>
                  <td style="padding:.3rem 0">${stageLabel}</td>
                </tr>
                ${noteText ? `<tr>
                  <td style="padding:.3rem .75rem .3rem 0;font-weight:600;color:#555">Note</td>
                  <td style="padding:.3rem 0">${noteText}</td>
                </tr>` : ''}
                ${progressVal > 0 ? `<tr>
                  <td style="padding:.3rem .75rem .3rem 0;font-weight:600;color:#555">Progress</td>
                  <td style="padding:.3rem 0">${progressVal}%</td>
                </tr>` : ''}
              </table>
              <p style="margin-top:1rem;color:#888;font-size:.85rem">
                You can view all requests in the YisraCase app under Settings → Feature Requests.
              </p>`
          });
        } catch(e) {
          console.error('[feature-requests] admin update notify error:', e.message);
        }
      })();
    }

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
         u.user_name     AS author_name,
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

    const admin = isAdmin(req);
    const uid   = userId(req);

    const [result] = await req.db.query(
      `INSERT INTO feature_request_comments
         (request_id, user_id, parent_comment_id, comment, is_admin)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, uid, parent_comment_id || null, comment.trim(), admin ? 1 : 0]
    );

    res.status(201).json({ id: result.insertId, message: 'Comment added' });

    // ── notifications (non-blocking) ──
    ;(async () => {
      try {
        const fr = await getRequest(req.db, req.params.id);
        if (!fr) return;

        if (admin) {
          // Admin replied → email the submitter
          if (fr.submitter_email) {
            sendEmail(req.db, {
              to:      fr.submitter_email,
              subject: `Staff replied to your request: "${fr.title}"`,
              text:    `Hi ${fr.submitter_name || 'there'},\n\nA staff member replied to your request "${fr.title}":\n\n"${comment.trim()}"`,
              html:    `<p>Hi <strong>${fr.submitter_name || 'there'}</strong>,</p>
                        <p>A staff member left a reply on your request <strong>"${fr.title}"</strong>:</p>
                        <blockquote style="border-left:3px solid #f6cc2f;background:#fff8e1;padding:.75rem 1rem;border-radius:4px">
                          ${comment.trim().replace(/\n/g, '<br>')}
                        </blockquote>
                        <p style="margin-top:1rem;color:#888;font-size:.85rem">
                          You can view all requests in the YisraCase app under Settings → Feature Requests.
                        </p>`
            });
          }
        } else {
          // User commented → notify admin
          const [[commenter]] = await req.db.query(
            `SELECT user_name FROM users WHERE user = ? LIMIT 1`, [uid]
          );
          const name = commenter?.user_name || `User #${uid}`;
          sendEmail(req.db, {
            to:      ADMIN_EMAIL,
            subject: `[YisraCase] New comment on "${fr.title}"`,
            text:    `${name} commented on "${fr.title}":\n\n"${comment.trim()}"`,
            html:    `<p><strong>${name}</strong> commented on <strong>"${fr.title}"</strong>:</p>
                      <blockquote style="border-left:3px solid #ccc;padding-left:1rem;color:#555">
                        ${comment.trim().replace(/\n/g, '<br>')}
                      </blockquote>`
          });
        }
      } catch(e) {
        console.error('[feature-requests] comment notify error:', e.message);
      }
    })();

  } catch (err) {
    console.error('POST /api/feature-requests/:id/comments error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

module.exports = router;