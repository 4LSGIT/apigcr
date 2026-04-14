/**
 * Dropbox Service
 * ------------------------------------------------------
 * Internal service for interacting with Dropbox.
 *
 * Uses a refresh token to automatically obtain and renew
 * short-lived access tokens (Dropbox deprecated long-lived
 * tokens in 2021).
 *
 * Required env vars:
 *   DROPBOX_APP_KEY
 *   DROPBOX_APP_SECRET
 *   DROPBOX_REFRESH_TOKEN
 *
 * Responsibilities:
 * - Create folders (idempotent)
 * - Create optional subfolders
 * - Create or reuse shared links
 * - Delete files or folders
 * - Rename and move files/folders
 * - Get temporary upload links (public client uploads)
 * - Resolve shared link metadata
 *
 * This file contains NO HTTP or Express logic.
 */

const fetch = require("node-fetch");

const DROPBOX_APP_KEY      = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET   = process.env.DROPBOX_APP_SECRET;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

if (!DROPBOX_APP_KEY || !DROPBOX_APP_SECRET || !DROPBOX_REFRESH_TOKEN) {
  throw new Error(
    "Missing Dropbox credentials. Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and DROPBOX_REFRESH_TOKEN in .env"
  );
}

/* ======================================================
   TOKEN MANAGEMENT
   Short-lived tokens expire after ~4 hours.
   We cache in memory and refresh 5 minutes before expiry.
====================================================== */

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Return cached token if still valid (with 5-min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id:     DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dropbox token refresh failed: ${errText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Refresh 5 minutes before actual expiry
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000;

  console.log("[DROPBOX] Access token refreshed, expires in", data.expires_in, "seconds");
  return cachedToken;
}

/* ======================================================
   HELPERS
====================================================== */

function normalizePath(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/**
 * Wrapper for authenticated Dropbox API calls.
 * Automatically injects a fresh Bearer token.
 */
async function dbxFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...options.headers
  };
  return fetch(url, { ...options, headers });
}

/* ======================================================
   DROPBOX OPERATIONS
====================================================== */

async function createFolder(path) {
  path = normalizePath(path);

  const res = await dbxFetch(
    "https://api.dropboxapi.com/2/files/create_folder_v2",
    {
      method: "POST",
      body: JSON.stringify({ path, autorename: false })
    }
  );

  if (res.status === 409) return; // folder exists
  if (!res.ok) throw new Error(await res.text());
}

async function createSubfolders(basePath, subfolders = []) {
  basePath = normalizePath(basePath);

  for (const sub of subfolders) {
    if (!sub || typeof sub !== "string") continue;
    await createFolder(`${basePath}/${sub}`);
  }
}

async function getOrCreateSharedLink(path) {
  path = normalizePath(path);

  const listRes = await dbxFetch(
    "https://api.dropboxapi.com/2/sharing/list_shared_links",
    {
      method: "POST",
      body: JSON.stringify({ path, direct_only: true })
    }
  );

  const listData = await listRes.json();
  if (listData.links?.length) return listData.links[0].url;

  const createRes = await dbxFetch(
    "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
    {
      method: "POST",
      body: JSON.stringify({
        path,
        settings: { requested_visibility: "public" }
      })
    }
  );

  if (!createRes.ok) throw new Error(await createRes.text());
  const data = await createRes.json();
  return data.url;
}

async function deletePath(path) {
  path = normalizePath(path);

  if (path === "/") throw new Error("Refusing to delete root path");

  const res = await dbxFetch(
    "https://api.dropboxapi.com/2/files/delete_v2",
    {
      method: "POST",
      body: JSON.stringify({ path })
    }
  );

  if (!res.ok) throw new Error(await res.text());
}

async function createFolderWithOptions(path, shareLink = false, subfolders = []) {
  await createFolder(path);

  if (Array.isArray(subfolders) && subfolders.length) {
    await createSubfolders(path, subfolders);
  }

  if (shareLink === true) {
    return getOrCreateSharedLink(path);
  }

  return null;
}

/* ======================================================
   RENAME & MOVE
====================================================== */

async function movePath(fromPath, toPath) {
  const res = await dbxFetch("https://api.dropboxapi.com/2/files/move_v2", {
    method: "POST",
    body: JSON.stringify({
      from_path: normalizePath(fromPath),
      to_path: normalizePath(toPath),
      autorename: false
    })
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function renamePath(oldPath, newName) {
  const normalizedOld = normalizePath(oldPath);
  const parent = normalizedOld.replace(/\/[^/]+$/, "");
  const newPath = normalizePath(`${parent}/${newName}`);
  return movePath(normalizedOld, newPath);
}

/* ======================================================
   PUBLIC UPLOAD SUPPORT
====================================================== */

/**
 * Get a temporary upload link for a file.
 *
 * Used by the public docReq page so clients can upload directly
 * to Dropbox without routing file bytes through our server.
 *
 * @param {string} folderPath  - Full Dropbox path to the target folder
 * @param {string} filename    - The filename to upload as
 * @param {number} [duration=7200] - Link validity in seconds (default 2 hours)
 * @returns {string} The temporary upload URL
 */
async function getTemporaryUploadLink(folderPath, filename, duration = 7200) {
  const fullPath = normalizePath(`${folderPath}/Client Uploads/${filename}`);

  const res = await dbxFetch(
    "https://api.dropboxapi.com/2/files/get_temporary_upload_link",
    {
      method: "POST",
      body: JSON.stringify({
        commit_info: {
          path: fullPath,
          mode: { ".tag": "add" },
          autorename: true
        },
        duration
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dropbox getTemporaryUploadLink failed: ${errText}`);
  }

  const data = await res.json();
  return data.link;
}

/**
 * Resolve a shared link to get folder metadata (path, id, etc.)
 *
 * @param {string} url - Dropbox shared link URL
 * @returns {object} Shared link metadata from Dropbox API
 */
async function getSharedLinkMetadata(url) {
  const res = await dbxFetch(
    "https://api.dropboxapi.com/2/sharing/get_shared_link_metadata",
    {
      method: "POST",
      body: JSON.stringify({ url })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Dropbox getSharedLinkMetadata failed: ${errText}`);
  }

  return res.json();
}

/* ======================================================
   EXPORTS
====================================================== */

module.exports = {
  createFolderWithOptions,
  deletePath,
  renamePath,
  movePath,
  normalizePath,
  getTemporaryUploadLink,
  getSharedLinkMetadata
};