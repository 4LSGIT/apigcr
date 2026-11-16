// lib/internal_functions/storage.js
//
/**
 * STORAGE — the automation functions over the firm's document storage,
 * provider-neutral (storage-seam D1f-1; ref/DOCUMENTS_V3_DESIGN.md §9 D1f,
 * §10 e). These are the dropbox_* functions converted: same bodies, the
 * provider reached through services/documentSourceService instead of
 * dropboxService, the Dropbox words gone from the params — a shared link is
 * a `human_link` (a URL a person opens), `share_link` is `with_link`. The
 * Dropbox credential override (`credential_id`) is gone: the provider is the
 * firm's (D2), and no live step ever sent it.
 *
 * OUTPUT SHAPES ARE THE OLD ONES ON PURPOSE. Workflow set_vars read them —
 * wf 48 reads this.output.shared_link, this.output.metadata.path_display,
 * this.output.entries — and renaming an output key would be a second
 * migration inside template strings. The provider's richer results are mapped
 * back to exactly what the dropbox_* functions returned.
 *
 * The provider calls these make are the dropbox_* functions' calls, byte for
 * byte: tests/storageReplay.test.js scenario 10 runs the LIVE step params of
 * workflows 1, 28 and 48 through both names and compares the recordings.
 * Until D1f-3 deletes them, lib/internal_functions/dropbox.js holds the eight
 * old names as aliases onto these bodies.
 */

'use strict';

/** The storage provider the firm's documents live in (D2 makes this a per-tenant setting). */
const SOURCE = 'dropbox';
const storage = () => require('../../services/documentSourceService').get(SOURCE);   // deferred require (convention)

const fns = {};

// Clamped at runtime as well as declared in __meta (job_executor's
// CUSTOM_CODE_MAX_TIMEOUT_MS handling): __meta catches a bad literal at save
// time; this catches a placeholder that resolved to something larger.
const IMPORT_URL_MAX_TIMEOUT_MS = 300000;

/** One of two mutually exclusive sources as the provider's `from`: a path, or { humanLink }. */
function _source(path, humanLink) {
  return path ? path : { humanLink };
}

// ── storage_ensure_folder ───────────────────────────────────────────────────

fns.storage_ensure_folder = async (params, db) => {
  const { path, subfolders, with_link } = params;
  if (!path) throw new Error('storage_ensure_folder requires path');
  console.log(`[STORAGE_ENSURE_FOLDER] "${path}" with_link=${with_link === true}`);
  const made = await storage().ensureFolder(db, { path }, {
    subfolders: Array.isArray(subfolders) ? subfolders : [],
    humanLink: with_link === true,
  });
  return { success: true, output: { path: made.path, existed: made.existed, subfolders_created: made.subfolders, shared_link: made.humanLink } };
};
fns.storage_ensure_folder.__meta = {
  category: 'storage',
  description: 'Create a folder in the firm\'s document storage (idempotent), optionally subfolders and a human link. Capture this.output.shared_link into cases.case_dropbox. Leading spaces in path segments are significant (firm sort convention) and preserved.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full folder path. Leading/embedded spaces preserved.',
      example: '/  Law Office/   Cases/  Potential Cases/  Potential - Bankruptcy/ {{contact_name}} - {{caseId}}' },
    { name: 'subfolders', type: 'array', required: false,
      description: 'Subfolder names to create under path (nested "a/b" allowed).' },
    { name: 'with_link', type: 'boolean', required: false, default: false,
      description: 'Create/reuse a link a person can open for the folder.' },
  ],
  example: { path: '/ {{contact_name}} - {{caseId}}', subfolders: ['Client Uploads'], with_link: true }
};

// ── storage_human_link ──────────────────────────────────────────────────────

fns.storage_human_link = async (params, db) => {
  const { path } = params;
  if (!path) throw new Error('storage_human_link requires path');
  console.log(`[STORAGE_HUMAN_LINK] "${path}"`);
  const url = await storage().ensureSharedLink(db, path);
  return { success: true, output: { shared_link: url } };
};
fns.storage_human_link.__meta = {
  category: 'storage',
  description: 'Get (or create) a link a person can open for a path in the firm\'s document storage. Output: { shared_link }.',
  params: [
    { name: 'path', type: 'string', required: true, placeholderAllowed: true },
  ],
  example: { path: '{{folder_path}}' }
};

// ── storage_list ────────────────────────────────────────────────────────────

fns.storage_list = async (params, db) => {
  const { path, human_link, subfolder, recursive, max_entries } = params;
  if (!path && path !== '' && !human_link) {
    throw new Error('storage_list requires path or human_link');
  }
  const bound = {
    recursive: recursive === true,
    ...(max_entries != null && { max: max_entries }),
  };
  let result;
  if (human_link && subfolder) {
    const ctx = await storage().context(db);
    const base = await storage().resolveHumanLink(db, human_link, { expectFolder: true }, ctx);
    const listPath = storage().joinPath(base, subfolder);
    console.log(`[STORAGE_LIST] "${listPath}"`);
    result = await storage().list(db, { path: listPath }, bound);
  } else {
    console.log(`[STORAGE_LIST] ${human_link ? `link=${human_link}` : `"${path}"`}`);
    result = await storage().list(db, human_link ? { humanLink: human_link } : { path }, bound);
  }
  return { success: true, output: result };
};
fns.storage_list.__meta = {
  category: 'storage',
  description: 'List a folder by path or by the case human link (cases.case_dropbox). Output: { entries, count, truncated } — branch on this.output.count for "did the client upload anything" checks.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder path ("/" lists root).' },
    { name: 'human_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder link (survives staff moves/renames).' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the linked folder, e.g. "Client Uploads".' },
    { name: 'recursive', type: 'boolean', required: false, default: false },
    { name: 'max_entries', type: 'integer', required: false, default: 2000, min: 1 },
  ],
  exclusiveOneOf: [['path', 'human_link']],
  example: { human_link: '{{case_dropbox}}', subfolder: 'Client Uploads' }
};

// ── storage_move ────────────────────────────────────────────────────────────

fns.storage_move = async (params, db) => {
  const { from_path, from_human_link, to_path, autorename } = params;
  if (!to_path) throw new Error('storage_move requires to_path');
  if (!from_path && !from_human_link) throw new Error('storage_move requires from_path or from_human_link');
  console.log(`[STORAGE_MOVE] → "${to_path}"`);
  const result = await storage().move(db, _source(from_path, from_human_link), to_path, { autorename: autorename === true });
  return { success: true, output: result };
};
fns.storage_move.__meta = {
  category: 'storage',
  description: 'Move a file/folder. Source by from_path or from_human_link (case-folder handle). to_path is the full destination path; spaces preserved.',
  params: [
    { name: 'from_path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'from_human_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder link (cases.case_dropbox).' },
    { name: 'to_path', type: 'string', required: true, placeholderAllowed: true,
      description: 'Full destination path. Leading spaces preserved.' },
    { name: 'autorename', type: 'boolean', required: false, default: false },
  ],
  exclusiveOneOf: [['from_path', 'from_human_link']],
  example: { from_human_link: '{{case_dropbox}}', to_path: '/  Law Office/   Cases/ Active/ {{contact_name}} - {{caseId}}' }
};

// ── storage_rename ──────────────────────────────────────────────────────────

fns.storage_rename = async (params, db) => {
  const { path, human_link, new_name } = params;
  if (!new_name) throw new Error('storage_rename requires new_name');
  if (!path && !human_link) throw new Error('storage_rename requires path or human_link');
  console.log(`[STORAGE_RENAME] → "${new_name}"`);
  const result = await storage().rename(db, _source(path, human_link), new_name);
  return { success: true, output: result };
};
fns.storage_rename.__meta = {
  category: 'storage',
  description: 'Rename a file/folder in place (same parent). new_name may carry leading spaces (preserved); "/" not allowed.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'human_link', type: 'string', required: false, placeholderAllowed: true },
    { name: 'new_name', type: 'string', required: true, placeholderAllowed: true,
      description: 'New name only (no "/"). Leading spaces preserved.' },
  ],
  exclusiveOneOf: [['path', 'human_link']],
  example: { human_link: '{{case_dropbox}}', new_name: ' {{contact_name}} - {{case_number}}' }
};

// ── storage_delete ──────────────────────────────────────────────────────────

fns.storage_delete = async (params, db) => {
  const { path, human_link } = params;
  if (!path && !human_link) throw new Error('storage_delete requires path or human_link');
  console.log(`[STORAGE_DELETE] ${path ? `"${path}"` : `link=${human_link}`}`);
  const result = await storage().remove(db, _source(path, human_link));
  return { success: true, output: result };
};
fns.storage_delete.__meta = {
  category: 'storage',
  description: 'Delete a file/folder by path or human link. Refuses root.',
  params: [
    { name: 'path', type: 'string', required: false, placeholderAllowed: true },
    { name: 'human_link', type: 'string', required: false, placeholderAllowed: true },
  ],
  exclusiveOneOf: [['path', 'human_link']],
  example: { path: '{{file_path}}' }
};

// ── storage_import_url ──────────────────────────────────────────────────────

fns.storage_import_url = async (params, db) => {
  const { url, path, human_link, filename, subfolder, wait, case_id, contact_id, timeout_ms } = params;
  if (!url) throw new Error('storage_import_url requires url');
  if (!path && !human_link) throw new Error('storage_import_url requires path or human_link');
  const rawTimeout = Number(timeout_ms);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(Math.floor(rawTimeout), IMPORT_URL_MAX_TIMEOUT_MS)
    : undefined;
  console.log(`[STORAGE_IMPORT_URL] ${url} → ${path ? `"${path}"` : `link+${filename}`}` +
              `${timeoutMs ? ` (wait ≤ ${timeoutMs}ms)` : ''}`);
  const dest = path ? { path } : { humanLink: human_link, name: filename, subfolder };
  const result = await storage().importUrl(db, dest, url, {
    ...(wait !== undefined && { wait: wait === true }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  if (result && result.status === 'complete' && result.metadata) {
    const ingest = require('../../services/documentIngestService');   // deferred require (convention)
    const links = [];
    if (case_id    != null && case_id    !== '') links.push({ type: 'case',    id: case_id });
    if (contact_id != null && contact_id !== '') links.push({ type: 'contact', id: contact_id });
    await ingest.registerWrittenSafe(db, {
      entry:       result.metadata,
      links,
      createdBy:   null,             // automations have no user
      eventSource: 'automation',
    });
  }
  return { success: true, output: result };
};
fns.storage_import_url.__meta = {
  category: 'storage',
  description: 'Pull a file from a URL into the firm\'s document storage (the transfer runs on the provider\'s side — no bytes through Cloud Run). Destination: full path (incl. filename) OR human_link + filename (+ subfolder). Waits ~25s by default; output.status is "complete" or "in_progress" (with async_job_id).',
  params: [
    { name: 'url', type: 'string', required: true, placeholderAllowed: true,
      description: 'Source URL to pull from.' },
    { name: 'path', type: 'string', required: false, placeholderAllowed: true,
      description: 'Full destination path including filename.' },
    { name: 'human_link', type: 'string', required: false, placeholderAllowed: true,
      description: 'Case folder link; requires filename.' },
    { name: 'filename', type: 'string', required: false, placeholderAllowed: true,
      description: 'Destination filename (with human_link). Leading spaces preserved.' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Subfolder under the linked folder, e.g. "Client Uploads".' },
    { name: 'wait', type: 'boolean', required: false, default: true,
      description: 'Poll until complete before returning (see timeout_ms).' },
    { name: 'timeout_ms', type: 'integer', required: false, default: 25000,
      min: 1000, max: IMPORT_URL_MAX_TIMEOUT_MS,
      description:
        'How long to poll before giving up and returning status "in_progress" ' +
        '(default 25000). Raise it for slow sources — a server-rendered PDF can ' +
        'outrun 25s. The wait is spent inside the workflow advance request, so ' +
        `the ceiling is ${IMPORT_URL_MAX_TIMEOUT_MS}ms. Ignored when wait is false.` },
    { name: 'case_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Attribute the saved file to this case in the documents registry. ' +
                   'Omit and the file is still registered — it just waits for the ' +
                   'path-based sweep to work out whose it is.' },
    { name: 'contact_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Attribute the saved file to this contact in the documents registry. ' +
                   'Contacts have no folder convention, so this is the ONLY way ' +
                   'a saved file is ever linked to one.' },
  ],
  exclusiveOneOf: [['path', 'human_link']],
  example: { url: '{{attachment_url}}', human_link: '{{case_dropbox}}', subfolder: 'Client Uploads', filename: ' {{contact_name}} - statement.pdf', case_id: '{{cases.case_id}}' }
};

// ── storage_ensure_case_folder ──────────────────────────────────────────────

fns.storage_ensure_case_folder = async (params, db) => {
  const caseService = require('../../services/caseService');   // deferred require (convention)
  const { case_id, force } = params;
  if (!case_id) throw new Error('storage_ensure_case_folder requires case_id');
  console.log(`[STORAGE_ENSURE_CASE_FOLDER] case ${case_id}${force === true ? ' (force)' : ''}`);
  const result = await caseService.ensureCaseDropboxFolder(db, case_id, { force: force === true });
  return { success: true, output: result };
};
fns.storage_ensure_case_folder.__meta = {
  category: 'storage',
  description: 'Ensure a case has a folder + a link saved in cases.case_dropbox. Stage-aware: docket number present → Active-tree convention + staff subfolders; otherwise Potential-tree (+ Client Uploads). Idempotent — returns the existing link if already set. Templates from app_settings dropbox_case_folder_templates.',
  params: [
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case to ensure a folder for.' },
    { name: 'force', type: 'boolean', required: false, default: false,
      description: 'Create even if case_dropbox is already set (overwrites the saved link).' },
  ],
  example: { case_id: '{{cases.case_id}}' }
};

module.exports = fns;
