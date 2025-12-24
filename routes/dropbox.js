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

const express = require("express");
const router = express.Router();

const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const API_KEY = process.env.API_KEY;

if (!DROPBOX_TOKEN) {
  throw new Error("Missing DROPBOX_ACCESS_TOKEN");
}

/* ======================================================
   AUTHENTICATION
====================================================== */

async function authenticate(req) {
  const { api_key, username, password } = req.body;

  // API key auth (from request body)
  if (api_key && api_key === API_KEY) {
    return { method: "api_key" };
  }

  // Username + password auth
  if (!username || !password) {
    return null;
  }

  const [rows] = await req.db.query(
    `
    SELECT user_auth
      FROM users
     WHERE username = ?
       AND password = ?
     LIMIT 1
    `,
    [username, password]
  );

  if (
    rows.length &&
    typeof rows[0].user_auth === "string" &&
    rows[0].user_auth.startsWith("authorized")
  ) {
    return { method: "user" };
  }

  return null;
}

/* ======================================================
   DROPBOX HELPERS
====================================================== */

async function createFolder(path) {
  const res = await fetch(
    "https://api.dropboxapi.com/2/files/create_folder_v2",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path,
        autorename: false
      })
    }
  );

  // Folder already exists
  if (res.status === 409) {
    return;
  }

  if (!res.ok) {
    throw new Error(await res.text());
  }
}

async function createSubfolders(basePath, subfolders) {
  for (const sub of subfolders) {
    if (typeof sub !== "string" || !sub.trim()) continue;

    const fullPath = `${basePath}/${sub}`
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");

    await createFolder(fullPath);
  }
}

async function getOrCreateSharedLink(path) {
  const listRes = await fetch(
    "https://api.dropboxapi.com/2/sharing/list_shared_links",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path,
        direct_only: true
      })
    }
  );

  const listData = await listRes.json();
  if (listData.links && listData.links.length) {
    return listData.links[0].url;
  }

  const createRes = await fetch(
    "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path,
        settings: {
          requested_visibility: "public"
        }
      })
    }
  );

  if (!createRes.ok) {
    throw new Error(await createRes.text());
  }

  const data = await createRes.json();
  return data.url;
}

/* ======================================================
   ROUTE
====================================================== */

router.post("/dropbox/create-folder", async (req, res) => {
  try {
    const auth = await authenticate(req);
    if (!auth) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let { path, share_link = false, subfolders = [] } = req.body;

    if (!path || typeof path !== "string") {
      return res.status(400).json({ error: "Missing or invalid path" });
    }

    if (!Array.isArray(subfolders)) {
      return res.status(400).json({ error: "subfolders must be an array" });
    }

    // Normalize base path
    if (!path.startsWith("/")) path = `/${path}`;
    path = path.replace(/\/{2,}/g, "/").replace(/\/$/, "");

    // Create base folder
    await createFolder(path);

    // Create subfolders
    if (subfolders.length) {
      await createSubfolders(path, subfolders);
    }

    // Optional shared link
    let shared_link = null;
    if (share_link === true) {
      shared_link = await getOrCreateSharedLink(path);
    }

    return res.json({
      ok: true,
      path,
      subfolders_created: subfolders,
      shared_link
    });

  } catch (err) {
    console.error("Dropbox route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
