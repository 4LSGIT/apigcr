// lib/internal_functions/dropbox.js

const fns = {};

// ─────────────────────────────────────────────────────────────
// DROPBOX (native — services/dropboxService.js)
// ─────────────────────────────────────────────────────────────
//
// Thin wrappers over dropboxService (Connections-based; credential 8 /
// app_settings 'dropbox_credential_id'). dropboxService is lazy-required
// inside each function, matching this file's convention for
// service-backed functions — cheap circular-dep insurance.
//
// SPACES IN PATHS/NAMES ARE SIGNIFICANT (the firm's manual-sort
// convention uses leading spaces, e.g. "/  Law Office/   Cases/...").
// These wrappers pass path/filename params through untouched.
//
// Location addressing: where noted, steps accept `path` OR `shared_link`
// (the per-case folder handle stored in cases.case_dropbox — it keeps
// resolving after staff move/rename the folder).

/**
 * dropbox_create_folder
 * Create a Dropbox folder (idempotent), optionally subfolders and a
 * public shared link. Returns { path, existed, subfolders_created,
 * shared_link } — capture {{this.output.shared_link}} to store in
 * cases.case_dropbox (the native replacement for the Pabbly
 * create_dropbox_folder flow).
 *
 * params:
 *   path          {string}   — full folder path; leading spaces preserved
 *   subfolders    {array?}   — subfolder names (nested "a/b" allowed)
 *   share_link    {boolean?} — create/reuse a public shared link (default false)
 *   credential_id {number?}  — override the bound credential
 *
 * example config:
 *   {
 *     "function_name": "dropbox_create_folder",
 *     "params": {
 *       "path": "/  Law Office/   Cases/  Potential Cases/  Potential - Bankruptcy/ {{contact_name}} - {{caseId}}",
 *       "subfolders": ["Client Uploads"],
 *       "share_link": true
 *     },
 *     "set_vars": { "case_dropbox": "{{this.output.shared_link}}" }
 *   }
 */

fns.dropbox_create_folder = async (params, db) => {
    const dropbox = require('../../services/dropboxService');  // deferred require (convention)
    const { path, subfolders, share_link, credential_id } = params;
    if (!path) throw new Error('dropbox_create_folder requires path');

    console.log(`[DROPBOX_CREATE_FOLDER] "${path}" share_link=${share_link === true}`);
    const result = await dropbox.createFolderWithOptions(db, {
      path,
      subfolders: Array.isArray(subfolders) ? subfolders : [],
      shareLink: share_link === true,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  };

fns.dropbox_create_folder.__meta = {
  category: 'dropbox',
  description: 'Create a Dropbox folder (idempotent), optionally subfolders and a public shared link. Capture this.output.shared_link into cases.case_dropbox. Leading spaces in path segments are significant (firm sort convention) and preserved.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full folder path. Leading/embedded spaces preserved.',
      example: '/  Law Office/   Cases/  Potential Cases/  Potential - Bankruptcy/ {{contact_name}} - {{caseId}}' },
    { name: 'subfolders', type: 'array', required: false,
      description: 'Subfolder names to create under path (nested "a/b" allowed).' },
    { name: 'share_link', type: 'boolean', required: false, default: false,
      description: 'Create/reuse a public shared link for the folder.' },
    { name: 'credential_id', type: 'integer', required: false,
      description: 'Override the bound credential (app_settings dropbox_credential_id, default 8).' },
  ],
  example: { path: '/ {{contact_name}} - {{caseId}}', subfolders: ['Client Uploads'], share_link: true }
};

/**
 * dropbox_get_shared_link
 * Get (or create) a public shared link for a path.
 *
 * params:
 *   path          {string}   — required
 *   credential_id {number?}
 *
 * example config:
 *   {
 *     "function_name": "dropbox_get_shared_link",
 *     "params": { "path": "{{folder_path}}" },
 *     "set_vars": { "shared_link": "{{this.output.shared_link}}" }
 *   }
 */

fns.dropbox_get_shared_link = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { path, credential_id } = params;
    if (!path) throw new Error('dropbox_get_shared_link requires path');

    console.log(`[DROPBOX_GET_SHARED_LINK] "${path}"`);
    const url = await dropbox.getOrCreateSharedLink(db, {
      path,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: { shared_link: url } };
  };

fns.dropbox_get_shared_link.__meta = {
  category: 'dropbox',
  description: 'Get (or create) a public Dropbox shared link for a path. Output: { shared_link }.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  example: { path: '{{folder_path}}' }
};

/**
 * dropbox_list_folder
 * List a folder's entries (by path or by the case's shared link).
 * Output: { entries, count, truncated } — entries are Dropbox metadata
 * objects (.tag 'file'|'folder', name, path_display, ...). Useful for
 * "did the client upload anything" branches via {{this.output.count}}.
 *
 * params:
 *   path          {string?}  — folder path ('/' or '' = root); OR
 *   shared_link   {string?}  — case folder handle (cases.case_dropbox)
 *   subfolder     {string?}  — list this subfolder under the resolved
 *                              folder (e.g. "Client Uploads"); shared_link only
 *   recursive     {boolean?} — default false
 *   max_entries   {number?}  — default 2000
 *   credential_id {number?}
 *
 * example config:
 *   {
 *     "function_name": "dropbox_list_folder",
 *     "params": { "shared_link": "{{case_dropbox}}", "subfolder": "Client Uploads" },
 *     "set_vars": { "upload_count": "{{this.output.count}}" }
 *   }
 */

fns.dropbox_list_folder = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { path, shared_link, subfolder, recursive, max_entries, credential_id } = params;
    if (!path && path !== '' && !shared_link) {
      throw new Error('dropbox_list_folder requires path or shared_link');
    }

    const common = {
      recursive: recursive === true,
      ...(max_entries != null && { maxEntries: max_entries }),
      ...(credential_id != null && { credentialId: credential_id }),
    };

    let result;
    if (shared_link && subfolder) {
      // Resolve the link, then descend into the subfolder.
      const credentialId = await dropbox._resolveCredential(db, { credentialId: credential_id });
      const base = await dropbox.resolveLocation(db, credentialId, {
        sharedLink: shared_link, expectFolder: true,
      });
      const listPath = dropbox.joinPath(base, subfolder);
      console.log(`[DROPBOX_LIST_FOLDER] "${listPath}"`);
      result = await dropbox.listFolder(db, { path: listPath, ...common });
    } else {
      console.log(`[DROPBOX_LIST_FOLDER] ${shared_link ? `link=${shared_link}` : `"${path}"`}`);
      result = await dropbox.listFolder(db, { path, sharedLink: shared_link, ...common });
    }

    return { success: true, output: result };
  };

fns.dropbox_list_folder.__meta = {
  category: 'dropbox',
  description: 'List a Dropbox folder by path or by the case shared link (cases.case_dropbox). Output: { entries, count, truncated } — branch on this.output.count for "did the client upload anything" checks.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder path ("/" lists root).' },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link (survives staff moves/renames).' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the shared-link folder, e.g. "Client Uploads".' },
    { name: 'recursive', type: 'boolean', required: false, default: false },
    { name: 'max_entries', type: 'integer', required: false, default: 2000, min: 1 },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { shared_link: '{{case_dropbox}}', subfolder: 'Client Uploads' }
};

/**
 * dropbox_move
 * Move a file/folder. Source by from_path OR from_shared_link (the
 * case-folder handle — survives prior moves/renames).
 *
 * params:
 *   from_path        {string?} — OR
 *   from_shared_link {string?}
 *   to_path          {string}  — required; full destination path
 *   autorename       {boolean?} — default false
 *   credential_id    {number?}
 *
 * example config:
 *   {
 *     "function_name": "dropbox_move",
 *     "params": {
 *       "from_shared_link": "{{case_dropbox}}",
 *       "to_path": "/  Law Office/   Cases/ Active/ {{contact_name}} - {{caseId}}"
 *     }
 *   }
 */

fns.dropbox_move = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { from_path, from_shared_link, to_path, autorename, credential_id } = params;
    if (!to_path) throw new Error('dropbox_move requires to_path');
    if (!from_path && !from_shared_link) throw new Error('dropbox_move requires from_path or from_shared_link');

    console.log(`[DROPBOX_MOVE] → "${to_path}"`);
    const result = await dropbox.movePath(db, {
      fromPath: from_path,
      fromSharedLink: from_shared_link,
      toPath: to_path,
      autorename: autorename === true,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  };

fns.dropbox_move.__meta = {
  category: 'dropbox',
  description: 'Move a Dropbox file/folder. Source by from_path or from_shared_link (case-folder handle). to_path is the full destination path; spaces preserved.',
  params: [
    { name: 'from_path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'from_shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link (cases.case_dropbox).' },
    { name: 'to_path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full destination path. Leading spaces preserved.' },
    { name: 'autorename', type: 'boolean', required: false, default: false },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['from_path', 'from_shared_link']],
  example: { from_shared_link: '{{case_dropbox}}', to_path: '/  Law Office/   Cases/ Active/ {{contact_name}} - {{caseId}}' }
};

/**
 * dropbox_rename
 * Rename a file/folder in place (same parent). new_name may carry
 * leading spaces — preserved.
 *
 * params:
 *   path          {string?} — OR
 *   shared_link   {string?}
 *   new_name      {string}  — required; no "/" allowed
 *   credential_id {number?}
 *
 * example config:
 *   {
 *     "function_name": "dropbox_rename",
 *     "params": { "shared_link": "{{case_dropbox}}", "new_name": " {{contact_name}} - {{case_number}}" }
 *   }
 */

fns.dropbox_rename = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { path, shared_link, new_name, credential_id } = params;
    if (!new_name) throw new Error('dropbox_rename requires new_name');
    if (!path && !shared_link) throw new Error('dropbox_rename requires path or shared_link');

    console.log(`[DROPBOX_RENAME] → "${new_name}"`);
    const result = await dropbox.renamePath(db, {
      path,
      sharedLink: shared_link,
      newName: new_name,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  };

fns.dropbox_rename.__meta = {
  category: 'dropbox',
  description: 'Rename a Dropbox file/folder in place (same parent). new_name may carry leading spaces (preserved); "/" not allowed.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true },
    { name: 'new_name', type: 'string', required: true, placeholderAllowed: true,
      description: 'New name only (no "/"). Leading spaces preserved.' },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { shared_link: '{{case_dropbox}}', new_name: ' {{contact_name}} - {{case_number}}' }
};

/**
 * dropbox_delete
 * Delete a file/folder by path or shared link. Refuses root.
 *
 * params:
 *   path          {string?} — OR
 *   shared_link   {string?}
 *   credential_id {number?}
 *
 * example config:
 *   { "function_name": "dropbox_delete", "params": { "path": "{{file_path}}" } }
 */

fns.dropbox_delete = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { path, shared_link, credential_id } = params;
    if (!path && !shared_link) throw new Error('dropbox_delete requires path or shared_link');

    console.log(`[DROPBOX_DELETE] ${path ? `"${path}"` : `link=${shared_link}`}`);
    const result = await dropbox.deletePath(db, {
      path,
      sharedLink: shared_link,
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  };

fns.dropbox_delete.__meta = {
  category: 'dropbox',
  description: 'Delete a Dropbox file/folder by path or shared link. Refuses root.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { path: '{{file_path}}' }
};

/**
 * dropbox_save_url
 * Pull a file FROM A URL into Dropbox (transfer runs on Dropbox's side —
 * Cloud Run friendly, bytes never transit our instance). Destination is
 * either a full `path` (including filename) or the case folder via
 * `shared_link` + `filename` (+ optional `subfolder`).
 *
 * Waits for completion by default (~25s); if still running, returns
 * { status: 'in_progress', async_job_id } instead of failing.
 *
 * params:
 *   url           {string}   — required; source URL
 *   path          {string?}  — full destination path incl. filename; OR
 *   shared_link   {string?}  — + filename below
 *   filename      {string?}  — required with shared_link; leading spaces preserved
 *   subfolder     {string?}  — e.g. "Client Uploads"
 *   wait          {boolean?} — default true
 *   credential_id {number?}
 *
 * example config:
 *   {
 *     "function_name": "dropbox_save_url",
 *     "params": {
 *       "url": "{{attachment_url}}",
 *       "shared_link": "{{case_dropbox}}",
 *       "subfolder": "Client Uploads",
 *       "filename": " {{contact_name}} - {{caseId}} - statement.pdf"
 *     },
 *     "set_vars": { "saved_status": "{{this.output.status}}" }
 *   }
 */

fns.dropbox_save_url = async (params, db) => {
    const dropbox = require('../../services/dropboxService');
    const { url, path, shared_link, filename, subfolder, wait, credential_id } = params;
    if (!url) throw new Error('dropbox_save_url requires url');
    if (!path && !shared_link) throw new Error('dropbox_save_url requires path or shared_link');

    console.log(`[DROPBOX_SAVE_URL] ${url} → ${path ? `"${path}"` : `link+${filename}`}`);
    const result = await dropbox.saveUrl(db, {
      url,
      path,
      sharedLink: shared_link,
      filename,
      subfolder,
      ...(wait !== undefined && { wait: wait === true }),
      ...(credential_id != null && { credentialId: credential_id }),
    });

    return { success: true, output: result };
  };

fns.dropbox_save_url.__meta = {
  category: 'dropbox',
  description: 'Pull a file from a URL into Dropbox (transfer runs on Dropbox\'s side — no bytes through Cloud Run). Destination: full path (incl. filename) OR shared_link + filename (+ subfolder). Waits ~25s by default; output.status is "complete" or "in_progress" (with async_job_id).',
  params: [
    { name: 'url', type: 'string', required: true, placeholderAllowed: true,
      description: 'Source URL to pull from.' },
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Full destination path including filename.' },
    { name: 'shared_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder shared link; requires filename.' },
    { name: 'filename', type: 'string', required: false, placeholderAllowed: true,
      description: 'Destination filename (with shared_link). Leading spaces preserved.' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the shared-link folder, e.g. "Client Uploads".' },
    { name: 'wait', type: 'boolean', required: false, default: true,
      description: 'Poll until complete (~25s) before returning.' },
    { name: 'credential_id', type: 'integer', required: false },
  ],
  exclusiveOneOf: [['path', 'shared_link']],
  example: { url: '{{attachment_url}}', shared_link: '{{case_dropbox}}', subfolder: 'Client Uploads', filename: ' {{contact_name}} - statement.pdf' }
};

/**
 * dropbox_ensure_case_folder
 * Ensure a case has a Dropbox folder + shared link in cases.case_dropbox.
 * Thin wrapper over caseService.ensureCaseDropboxFolder — STAGE-AWARE:
 * a case with a docket number gets the Active-tree convention + the four
 * staff subfolders; otherwise the Potential-tree convention (+ Client
 * Uploads). Names come from the Primary contact. Idempotent: if
 * case_dropbox is already set it returns the existing link untouched
 * (force: true to recreate and overwrite the saved link).
 *
 * Templates: app_settings 'dropbox_case_folder_templates' (per-stage,
 * per-case_type) with hardcoded fallback — see caseService.
 *
 * Output: { existed, stage, path, shared_link, folder_existed,
 *           subfolders_created }
 *
 * params:
 *   case_id {string}   — required
 *   force   {boolean?} — default false; create even if a link exists
 *
 * example config (Voluntary Petition workflow — guarantees a filed case
 * has a folder before any move/upload steps):
 *   {
 *     "function_name": "dropbox_ensure_case_folder",
 *     "params": { "case_id": "{{cases.case_id}}" },
 *     "set_vars": { "case_dropbox": "{{this.output.shared_link}}" }
 *   }
 */

fns.dropbox_ensure_case_folder = async (params, db) => {
    const caseService = require('../../services/caseService');  // deferred require (convention)
    const { case_id, force } = params;
    if (!case_id) throw new Error('dropbox_ensure_case_folder requires case_id');

    console.log(`[DROPBOX_ENSURE_CASE_FOLDER] case ${case_id}${force === true ? ' (force)' : ''}`);
    const result = await caseService.ensureCaseDropboxFolder(db, case_id, {
      force: force === true,
    });

    return { success: true, output: result };
  };

fns.dropbox_ensure_case_folder.__meta = {
  category: 'dropbox',
  description: 'Ensure a case has a Dropbox folder + shared link saved in cases.case_dropbox. Stage-aware: docket number present → Active-tree convention + staff subfolders; otherwise Potential-tree (+ Client Uploads). Idempotent — returns the existing link if already set. Templates from app_settings dropbox_case_folder_templates.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case to ensure a folder for.' },
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Create even if case_dropbox is already set (overwrites the saved link).' },
  ],
  example: { case_id: '{{cases.case_id}}' }
};

module.exports = fns;
