// services/docsReviewerService.js
//
/**
 * THE DOCS REVIEWER — the one person told when client documents arrive, by
 * any door: the docReq page, the client portal, an email to docs@ (through
 * the docs@ workflow's `docs_reviewer` step), or a person filing from Comms.
 * Fred, 2026-11-19: one recipient setting for all four, `email_attachments_reviewer`
 * (lib/settingsRegistry.js), set to SB. The retired `portal_docs_notify_to`
 * (a bare address) was the upload pages' own recipient until then.
 *
 *   resolveReviewer(db)  → { user_id, name, email } | null
 *
 * The setting holds a users.user id. null when it is unset, not a number, or
 * names a user who is not `authorized%` or has no usable email — the callers
 * treat null as "notifications off" (a console warning, never an error; the
 * case-log row still writes). Lifted verbatim from emailAttachmentCommsService
 * (S3, 2026-11-10), which re-exports it.
 */

'use strict';

const REVIEWER_SETTING = 'email_attachments_reviewer';

async function resolveReviewer(db) {
  const { getSettings } = require('./settingsService');   // lazy (convention)
  const vals = await getSettings(db, [REVIEWER_SETTING]);
  const id = parseInt(String(vals[REVIEWER_SETTING] ?? '').trim(), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [[u]] = await db.query(
    "SELECT user, user_name, email FROM users WHERE user = ? AND user_auth LIKE 'authorized%' LIMIT 1", [id]);
  if (!u || !u.email || !String(u.email).includes('@')) return null;
  return { user_id: Number(u.user), name: u.user_name || `user ${u.user}`, email: String(u.email).trim() };
}

module.exports = { resolveReviewer, REVIEWER_SETTING };
