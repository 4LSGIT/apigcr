// services/credentialService.js
//
/**
 * Credential Service — DB access for the `credentials` table
 * services/credentialService.js
 *
 * Extracted from services/hookService.js. Credentials began life as auth
 * config for hook targets (YisraHook v1), but the Connections refactor made
 * them an app-wide concept — OAuth2 flows, Dropbox, phone lines, sequences,
 * alerting and the internal_functions all resolve credentials now. The CRUD
 * helpers no longer belong to the hook engine.
 *
 * Read paths elsewhere (lib/credentialInjection.js, services/oauthService.js)
 * query the table directly with their own column projections; this module
 * covers the admin CRUD surface used by routes/api.credentials.js.
 */

// NOTE: listCredentials and getCredentialById have no call sites — the
// routes query the table directly with narrower, secret-scrubbed
// projections. Carried over unchanged from hookService rather than deleted
// as part of a move; drop them if nothing picks them up.
async function listCredentials(db) {
  const [rows] = await db.query(
    `SELECT id, name, type, allowed_urls, created_at, updated_at FROM credentials ORDER BY name ASC`
  );
  // Never return config (contains secrets)
  return rows;
}

async function getCredentialById(db, id) {
  const [[row]] = await db.query(`SELECT * FROM credentials WHERE id = ?`, [id]);
  return row || null;
}

async function createCredential(db, data) {
  const [result] = await db.query(`INSERT INTO credentials SET ?`, [data]);
  return result.insertId;
}

async function updateCredential(db, id, data) {
  // mysql2 expands `SET ?` on an empty object to nothing, producing
  // `UPDATE credentials SET  WHERE id = ?` — a syntax error. An empty
  // diff means there's nothing to write, so no-op instead.
  if (!data || Object.keys(data).length === 0) return;
  await db.query(`UPDATE credentials SET ? WHERE id = ?`, [data, id]);
}

async function deleteCredential(db, id) {
  await db.query(`DELETE FROM credentials WHERE id = ?`, [id]);
}

module.exports = {
  listCredentials,
  getCredentialById,
  createCredential,
  updateCredential,
  deleteCredential,
};
