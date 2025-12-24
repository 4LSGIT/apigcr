/**
 * Dropbox Service
 * ------------------------------------------------------
 * Internal service for interacting with Dropbox using
 * a long-lived access token.
 *
 * Responsibilities:
 * - Create folders (idempotent)
 * - Create optional subfolders
 * - Create or reuse shared links
 * - Delete files or folders
 * - Rename and move files/folders
 *
 * This file contains NO HTTP or Express logic.
 */

const fetch = require("node-fetch");

const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

if (!DROPBOX_TOKEN) {
  throw new Error("Missing DROPBOX_ACCESS_TOKEN");
}

/* ======================================================
   HELPERS
====================================================== */

function normalizePath(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/* ======================================================
   DROPBOX OPERATIONS
====================================================== */

async function createFolder(path) {
  path = normalizePath(path);

  const res = await fetch(
    "https://api.dropboxapi.com/2/files/create_folder_v2",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
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

  const listRes = await fetch(
    "https://api.dropboxapi.com/2/sharing/list_shared_links",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path, direct_only: true })
    }
  );

  const listData = await listRes.json();
  if (listData.links?.length) return listData.links[0].url;

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

  const res = await fetch(
    "https://api.dropboxapi.com/2/files/delete_v2",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DROPBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
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
  const res = await fetch("https://api.dropboxapi.com/2/files/move_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DROPBOX_TOKEN}`,
      "Content-Type": "application/json"
    },
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
   EXPORTS
====================================================== */

module.exports = {
  createFolderWithOptions,
  deletePath,
  renamePath,
  movePath,
  normalizePath
};
