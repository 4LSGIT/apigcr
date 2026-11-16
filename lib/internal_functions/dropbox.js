// lib/internal_functions/dropbox.js
//
/**
 * DROPBOX — the eight dropbox_* automation functions, now ALIASES of the
 * storage_* functions in ./storage.js (storage-seam D1f-1; design §9 D1f).
 *
 * TEMPORARY, for exactly one deploy cycle: the names live inside live
 * workflow definitions (workflow_steps.config — wf 1, 28, 48), and the
 * SQL → backend deploy order leaves a window in which the rows say one name
 * and the running code must still answer to the other. D1f-2 (a definition
 * migration, Fred's --apply) renames the rows; D1f-3 deletes this file. A
 * permanent alias would hardcode a 4LSG-era name into the product (Fred,
 * 2026-11-17) — do not keep it.
 *
 * Each alias translates the old param names and calls the storage_* body:
 *   shared_link / from_shared_link → human_link / from_human_link
 *   share_link → with_link
 *   credential_id → dropped (the provider is the firm's; no live step sent it)
 * Output shapes are unchanged (the bodies return the old shapes on purpose).
 * The __meta keeps the OLD param names so an existing step still validates at
 * save, and carries `deprecated: '<new name>'` for the editor catalog.
 */

'use strict';

const storage = require('./storage');

const RENAMES = Object.freeze({
  shared_link: 'human_link',
  from_shared_link: 'from_human_link',
  share_link: 'with_link',
});

/** Old params → new params; credential_id is dropped. */
function translate(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'credential_id') continue;
    out[RENAMES[k] || k] = v;
  }
  return out;
}

const ALIASES = Object.freeze({
  dropbox_create_folder:      'storage_ensure_folder',
  dropbox_get_shared_link:    'storage_human_link',
  dropbox_list_folder:        'storage_list',
  dropbox_move:               'storage_move',
  dropbox_rename:             'storage_rename',
  dropbox_delete:             'storage_delete',
  dropbox_save_url:           'storage_import_url',
  dropbox_ensure_case_folder: 'storage_ensure_case_folder',
});

/** The old __meta: the new one with the old param names and the deprecation mark. */
function oldMeta(newName, oldName) {
  const meta = storage[newName].__meta;
  const back = Object.fromEntries(Object.entries(RENAMES).map(([o, n]) => [n, o]));
  const rename = (n) => back[n] || n;
  const params = meta.params.map((p) => ({ ...p, name: rename(p.name) }));
  const wantsCredential = !['storage_ensure_case_folder'].includes(newName);
  if (wantsCredential) {
    params.push({ name: 'credential_id', type: 'integer', required: false,
      description: 'Dropbox-only credential override — ignored since D1f; the provider is the firm\'s.' });
  }
  const exclusiveOneOf = meta.exclusiveOneOf ? meta.exclusiveOneOf.map((g) => g.map(rename)) : undefined;
  const example = Object.fromEntries(Object.entries(meta.example || {}).map(([k, v]) => [rename(k), v]));
  return {
    ...meta,
    category: 'dropbox',
    deprecated: newName,
    description: `DEPRECATED — use ${newName}. ${meta.description}`,
    params,
    ...(exclusiveOneOf ? { exclusiveOneOf } : {}),
    example,
  };
}

const fns = {};
for (const [oldName, newName] of Object.entries(ALIASES)) {
  fns[oldName] = async (params, db) => storage[newName](translate(params), db);
  fns[oldName].__meta = oldMeta(newName, oldName);
}

module.exports = fns;
// __-prefixed: the registry index skips these (they are not functions a step may call)
module.exports.__ALIASES = ALIASES;
module.exports.__translate = translate;
