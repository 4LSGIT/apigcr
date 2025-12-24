/**
 * ------------------------------------------------------
 * POST /dropbox/create-folder
 * ------------------------------------------------------
 *
 * Creates a folder in Dropbox and (optionally) a public
 * shared link. Designed for INTERNAL use.
 *
 * AUTHENTICATION (one required):
 *   1) API key in request body:
 *        { "api_key": "YOUR_API_KEY" }
 *
 *   2) Username + password:
 *        { "username": "...", "password": "..." }
 *      User is authorized if:
 *        users.user_auth starts with "authorized"
 *
 * REQUEST BODY:
 *   path        (string, required)
 *     - Dropbox folder path (e.g. "/cases/case_123")
 *
 *   subfolders  (array of strings, optional)
 *     - Subfolders to create under path
 *     - Nested paths allowed (e.g. "images/raw")
 *
 *   share_link  (boolean, optional, default false)
 *     - If true, creates or reuses a public shared link
 *       for the base folder
 *
 * RESPONSE:
 *   {
 *     ok: true,
 *     path: "/cases/case_123",
 *     subfolders_created: [...],
 *     shared_link: "https://dropbox.com/..."
 *   }
 *
 * NOTES:
 * - Folder creation is idempotent (no error if exists)
 * - Shared links are reused if already present
 * - Uses Dropbox long-lived access token
 * - Passwords are assumed to be internal / trusted
 */


/**
 * ------------------------------------------------------
 * Dropbox routes:
 * - POST /dropbox/create-folder
 * - POST /dropbox/delete
 * - POST /dropbox/rename
 * - POST /dropbox/move
 *
 * Authentication:
 * - api_key in body
 * - OR username + password (users.user_auth starts with "authorized")
 */

const express = require("express");
const router = express.Router();
const dropbox = require("../services/dropboxService");

const API_KEY = process.env.API_KEY;

/* ======================================================
   AUTH
====================================================== */

async function authenticate(req) {
  const { api_key, username, password } = req.body;

  if (api_key && api_key === API_KEY) return { method: "api_key" };
  if (!username || !password) return null;

  const [rows] = await req.db.query(
    `SELECT user_auth FROM users WHERE username = ? AND password = ? LIMIT 1`,
    [username, password]
  );

  if (rows.length && typeof rows[0].user_auth === "string" && rows[0].user_auth.startsWith("authorized")) {
    return { method: "user" };
  }

  return null;
}

/* ======================================================
   CREATE FOLDER
====================================================== */
router.post("/dropbox/create-folder", async (req, res) => {
  try {
    const auth = await authenticate(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { path, share_link = false, subfolders = [] } = req.body;
    if (!path) return res.status(400).json({ error: "Missing path" });

    const shared_link = await dropbox.createFolderWithOptions(path, share_link, subfolders);
    res.json({ ok: true, path: dropbox.normalizePath(path), subfolders_created: subfolders, shared_link });
  } catch (err) {
    console.error("Dropbox create-folder error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   DELETE
====================================================== */
router.post("/dropbox/delete", async (req, res) => {
  try {
    const auth = await authenticate(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { path } = req.body;
    if (!path) return res.status(400).json({ error: "Missing path" });

    await dropbox.deletePath(path);
    res.json({ ok: true, deleted: dropbox.normalizePath(path) });
  } catch (err) {
    console.error("Dropbox delete error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   RENAME
====================================================== */
router.post("/dropbox/rename", async (req, res) => {
  try {
    const auth = await authenticate(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { path, newName } = req.body;
    if (!path || !newName) return res.status(400).json({ error: "Missing path or newName" });

    const result = await dropbox.renamePath(path, newName);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Dropbox rename error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   MOVE
====================================================== */
router.post("/dropbox/move", async (req, res) => {
  try {
    const auth = await authenticate(req);
    if (!auth) return res.status(401).json({ error: "Unauthorized" });

    const { fromPath, toPath } = req.body;
    if (!fromPath || !toPath) return res.status(400).json({ error: "Missing fromPath or toPath" });

    const result = await dropbox.movePath(fromPath, toPath);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("Dropbox move error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
