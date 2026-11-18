#!/usr/bin/env node
// scripts/storageConfigDump.js
//
/**
 * STORAGE CONFIG DUMP — the resolved storage configuration, byte-exact.
 * storage-seam D0 (ref/DOCUMENTS_V3_DESIGN.md §0 rule 3).
 *
 * Prints ONE JSON document (keys sorted, 2-space indent) describing what the
 * writers would resolve RIGHT NOW on this database — the Dropbox credential
 * id, the four unsorted bins, the case-folder templates per stage, the
 * dropbox_unreachable switch — each with the app_settings row and the code
 * default behind it, then `sha256 <hex>` of the document. Run it before a
 * storage-seam slice lands and again after it deploys: `diff` must be empty.
 * The double spaces in these paths are load-bearing and the comparison is
 * byte-wise on purpose.
 *
 * READ-ONLY: one connection from .env (app_settings is denied to every API
 * key, so this cannot ride the readonly endpoint), SELECT only. The defaults
 * are READ FROM THE SETTINGS REGISTRY (each key's `default`, lib/storageDefaults.js
 * behind it — the same place the writers read), never retyped here — a changed
 * default changes this dump. The credential has no default since D2: a missing
 * row prints as MISSING, because every storage operation refuses without it.
 *
 *   node scripts/storageConfigDump.js            # the document + its sha256
 *   node scripts/storageConfigDump.js --sha-only # the sha256 line alone
 */

'use strict';

const crypto = require('crypto');

const KEYS = Object.freeze([
  'storage_provider',                   // D3e: which provider the documents live in
  'dropbox_credential_id',
  'dropbox_unsorted_generated_path',
  'dropbox_unsorted_uploads_path',
  'dropbox_unsorted_forms_path',
  'dropbox_unsorted_esign_path',
  'dropbox_unsorted_court_docs_path',   // D2: freelook's fallback, formerly a literal
  'storage_folders',                    // D3c: the v3 tree — case templates (its case block) + contact folders
  'dropbox_unreachable',
]);

/** JSON with every object's keys sorted, recursively — the same bytes for the same facts. */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}

function render(doc) {
  return JSON.stringify(stable(doc), null, 2) + '\n';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Exactly what filePlacementService / uploadTargetService / esignFilingService do with the row. */
function resolvePath(raw, dflt) {
  if (raw != null && String(raw).replace(/[\r\n]+$/, '') !== '') {
    return { value: String(raw).replace(/[\r\n]+$/, ''), source: 'app_settings' };
  }
  return { value: dflt, source: 'code_default' };
}

async function collect(db) {
  // the defaults come from the registry (D2: lib/storageDefaults.js behind each
  // key's `default`) — the one place the writers read them from too
  const registry = require('../lib/settingsRegistry');

  const [rows] = await db.query('SELECT `key`, `value` FROM app_settings WHERE `key` IN (?)', [KEYS]);
  const row = {};
  for (const r of rows || []) row[r.key] = r.value;

  const bins = {
    generated:  'dropbox_unsorted_generated_path',
    uploads:    'dropbox_unsorted_uploads_path',
    forms:      'dropbox_unsorted_forms_path',
    esign:      'dropbox_unsorted_esign_path',
    court_docs: 'dropbox_unsorted_court_docs_path',
  };
  const unsorted = {};
  for (const [name, key] of Object.entries(bins)) {
    const dflt = registry.defaultOf(key);
    unsorted[name] = { key, code_default: dflt, ...resolvePath(row[key], dflt) };
  }

  // credential: NO code default since D2 — dropboxService._resolveCredential refuses without a row
  const credRaw = row.dropbox_credential_id;
  const credential = credRaw != null && String(credRaw).trim() !== ''
    ? { value: String(credRaw), source: 'app_settings', code_default: null }
    : { value: null, source: 'MISSING — every storage operation refuses until the row exists', code_default: null };

  // templates: caseService._loadCaseFolderTemplates → storage_folders.case (D3c-3:
  // the one source), else {} (a missing/invalid row or no case block); per stage, a
  // key on the map wins and absent keys fall back to the code default
  let map = {};
  let templatesSource = 'code_default';
  let tree = null;
  let treeSource = 'code_default';
  if (row.storage_folders) {
    try {
      const parsed = JSON.parse(row.storage_folders);
      if (parsed && typeof parsed === 'object') { tree = parsed; treeSource = 'app_settings'; }
      else treeSource = 'app_settings:not_an_object→code_default';
    } catch (err) {
      treeSource = 'app_settings:invalid_json→code_default';
    }
  }
  if (tree && tree.case && typeof tree.case === 'object' && !Array.isArray(tree.case)) {
    map = tree.case; templatesSource = 'app_settings:storage_folders.case';
  }
  const TEMPLATE_DEFAULTS = require('../lib/storageDefaults').STORAGE_DEFAULTS.dropbox_case_folder_templates;   // the code default behind storage_folders.case (no longer a registry key)
  const effective = {};
  for (const stage of Object.keys(TEMPLATE_DEFAULTS)) {
    effective[stage] = { ...TEMPLATE_DEFAULTS[stage], ...(map[stage] && typeof map[stage] === 'object' ? map[stage] : {}) };
  }
  for (const stage of Object.keys(map)) {
    if (!(stage in effective) && map[stage] && typeof map[stage] === 'object') effective[stage] = { ...map[stage] };
  }

  const providerRaw = row.storage_provider;
  const provider = providerRaw != null && String(providerRaw).trim() !== ''
    ? { value: String(providerRaw).trim(), source: 'app_settings', code_default: 'dropbox' }
    : { value: 'dropbox', source: 'code_default', code_default: 'dropbox' };

  return {
    provider,
    credential,
    unsorted,
    case_folder_templates: { source: templatesSource, code_default: TEMPLATE_DEFAULTS, row: map, effective },
    storage_folders: { source: treeSource, code_default: registry.defaultOf('storage_folders'), row: tree, contact: tree ? (tree.contact === undefined ? null : tree.contact) : null },
    dropbox_unreachable: row.dropbox_unreachable == null ? null : String(row.dropbox_unreachable),
  };
}

async function main() {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const shaOnly = process.argv.includes('--sha-only');
  let conn;
  try {
    const proxy = await ensureSqlProxy();
    if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
    for (const k of ['host', 'user', 'password', 'database']) {
      if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
    }
    conn = mysql.createConnection({
      host: process.env.host, user: process.env.user, password: process.env.password,
      database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
    }).promise();
    const text = render(await collect(conn));
    if (!shaOnly) process.stdout.write(text);
    process.stdout.write(`sha256 ${sha256(text)}\n`);
  } catch (err) {
    process.stdout.write(`NO-GO — ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { KEYS, collect, render, stable, sha256, resolvePath };
