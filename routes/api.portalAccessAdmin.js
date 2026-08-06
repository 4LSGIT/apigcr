// routes/api.portalAccessAdmin.js
//
/**
 * routes/api.portalAccessAdmin.js — Staff admin routes for client-portal
 * ACCESS (Portal Manager → Access tab, public/portaladmin/portalAccess.html).
 *
 * The portal has no accounts table — access is two columns on contacts:
 *   contacts.portal_enabled         1 = may log in / hold a session
 *                                   (DEFAULT 1 — every contact can log in
 *                                   unless staff turn them off, which is
 *                                   exactly why this tab exists)
 *   contacts.portal_session_version JWTs carry ver; requireAuth rejects on
 *                                   mismatch, so +1 = revoke every device
 * Both are re-checked on EVERY portal request by requireAuth's contact
 * branch — writes here take effect on the contact's next request, no token
 * expiry wait.
 *
 * GET  /api/portal-access-admin/contacts?q=&limit=
 *        q present: search by name/pname/email/phone (LIKE) or exact
 *        contact_id. q absent: the most recent portal LOGINS first — "who
 *        actually uses the portal" is the default view.
 *        Rows carry last_login/login_count from portal_login_pins
 *        (MAX/COUNT of consumed_at — consumed = successful PIN login; the
 *        pins table is small, contacts join is by PK).
 * PUT  /api/portal-access-admin/contacts/:id      { portal_enabled: 0|1 }
 * POST /api/portal-access-admin/contacts/:id/force-logout
 *        portal_session_version + 1 → all-device revoke. Does NOT touch
 *        portal_enabled — "kick them out now" and "lock them out" are
 *        separate levers.
 *
 * Auth + envelope match api.portalCardsAdmin.js: jwtOrApiKey (staff
 * surface); { status:'success', ... } / { status:'error', message }.
 * Auto-mounted from routes/ (server.js readdir loop).
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.portalAccessAdmin] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}

// One row shape for list + single-fetch. login stats via a grouped subquery
// on portal_login_pins (small table; consumed_at = successful login).
const CONTACT_SELECT = `
  SELECT c.contact_id, c.contact_name, c.contact_pname,
         c.contact_email, c.contact_phone,
         c.portal_enabled, c.portal_session_version,
         ll.last_login, COALESCE(ll.login_count, 0) AS login_count
    FROM contacts c
    LEFT JOIN (
      SELECT contact_id,
             MAX(consumed_at) AS last_login,
             COUNT(consumed_at) AS login_count
        FROM portal_login_pins
       WHERE consumed_at IS NOT NULL
       GROUP BY contact_id
    ) ll ON ll.contact_id = c.contact_id`;

async function searchContacts(db, { q, limit } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const term = String(q == null ? '' : q).trim();

  if (!term) {
    // Default view: contacts who have actually logged in, most recent first.
    const [rows] = await db.query(
      `${CONTACT_SELECT}
        WHERE ll.last_login IS NOT NULL
        ORDER BY ll.last_login DESC
        LIMIT ?`,
      [lim]
    );
    return rows;
  }

  const like = `%${term}%`;
  const idExact = /^\d+$/.test(term) ? Number(term) : -1;
  const [rows] = await db.query(
    `${CONTACT_SELECT}
      WHERE c.contact_id = ?
         OR c.contact_name  LIKE ?
         OR c.contact_pname LIKE ?
         OR c.contact_email LIKE ?
         OR c.contact_phone LIKE ?
      ORDER BY (ll.last_login IS NULL) ASC, ll.last_login DESC, c.contact_id DESC
      LIMIT ?`,
    [idExact, like, like, like, like, lim]
  );
  return rows;
}

async function getContact(db, id) {
  const [[row]] = await db.query(
    `${CONTACT_SELECT} WHERE c.contact_id = ? LIMIT 1`, [id]
  );
  if (!row) throw httpError(404, `Unknown contact id ${id}`);
  return row;
}

async function setPortalEnabled(db, id, value) {
  let enabled;
  if (value === 1 || value === '1' || value === true) enabled = 1;
  else if (value === 0 || value === '0' || value === false) enabled = 0;
  else throw httpError(400, 'portal_enabled must be 0 or 1');

  await getContact(db, id);                       // 404 before write
  await db.query(
    `UPDATE contacts SET portal_enabled = ? WHERE contact_id = ?`,
    [enabled, id]
  );
  // Disabling locks the account on their NEXT request (requireAuth
  // re-checks per request); their current tokens simply stop working.
  return await getContact(db, id);
}

async function forceLogout(db, id) {
  await getContact(db, id);                       // 404 before write
  await db.query(
    `UPDATE contacts
        SET portal_session_version = portal_session_version + 1
      WHERE contact_id = ?`,
    [id]
  );
  const row = await getContact(db, id);
  return { contact_id: row.contact_id, portal_session_version: row.portal_session_version };
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get('/api/portal-access-admin/contacts', jwtOrApiKey, async (req, res) => {
  try {
    const contacts = await searchContacts(req.db, {
      q: req.query.q, limit: req.query.limit,
    });
    res.json({ status: 'success', contacts });
  } catch (err) {
    fail(res, 'searchContacts', err);
  }
});

router.put('/api/portal-access-admin/contacts/:id', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.portal_enabled === undefined) {
      throw httpError(400, 'portal_enabled is the only editable field here');
    }
    const contact = await setPortalEnabled(req.db, req.params.id, body.portal_enabled);
    res.json({ status: 'success', contact });
  } catch (err) {
    fail(res, 'setPortalEnabled', err);
  }
});

router.post('/api/portal-access-admin/contacts/:id/force-logout', jwtOrApiKey, async (req, res) => {
  try {
    const result = await forceLogout(req.db, req.params.id);
    res.json({ status: 'success', ...result });
  } catch (err) {
    fail(res, 'forceLogout', err);
  }
});

module.exports = router;
// exported for tests (repo pattern: api.portalCardsAdmin)
module.exports._searchContacts   = searchContacts;
module.exports._getContact       = getContact;
module.exports._setPortalEnabled = setPortalEnabled;
module.exports._forceLogout      = forceLogout;
