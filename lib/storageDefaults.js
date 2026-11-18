// lib/storageDefaults.js
//
/**
 * STORAGE DEFAULTS — the values the document writers use when an app_settings
 * row is absent, in ONE place (storage-seam D2; ref/DOCUMENTS_V3_DESIGN.md §0
 * rule 3, §9 D2). lib/settingsRegistry.js references them as each key's
 * `default` (the provisioning seed and the editor's blank-value hint); the
 * writers read them here instead of carrying a literal; scripts/
 * storageConfigDump.js prints them beside the live rows.
 *
 * These are 4LSG's paths, which is exactly why they must not live inside a
 * writer: a tenant with no row would silently file into a folder named for
 * another firm. A leaf module — no requires — so a service can read it without
 * pulling the registry (and the partial-mock trap of its dependencies) into
 * every test that loads the service.
 *
 * Every double space is load-bearing (the firm's manual sort order in Dropbox).
 * tests/storageConfigDump.test.js pins each value byte for byte.
 *
 * There is deliberately NO default for dropbox_credential_id: credential 8 is
 * 4LSG's, and on any other tenant it would be a missing row or someone else's
 * credential. dropboxService._resolveCredential refuses without a row.
 */

'use strict';

const STORAGE_DEFAULTS = Object.freeze({
  dropbox_unsorted_uploads_path:    '/  Law Office/   Cases/  Unsorted Client Uploads',
  dropbox_unsorted_forms_path:      '/  Law Office/   Cases/  Unsorted Form Submissions',
  dropbox_unsorted_generated_path:  '/  Law Office/   Cases/  Unsorted Generated Documents',
  dropbox_unsorted_esign_path:      '/  Law Office/   Cases/  Unsorted E-Signed Documents',
  dropbox_unsorted_court_docs_path: '/  Law Office/   Cases/ _Unfiled Court Docs',
  // the code default behind storage_folders.case (caseService.DEFAULT_CASE_FOLDER_TEMPLATES);
  // not a registry key since D3c-3 (the key of that name was retired) — 4LSG's own layout
  dropbox_case_folder_templates: Object.freeze({
    potential: Object.freeze({
      default: "/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}",
      subfolders: Object.freeze(["Client Uploads"]),
    }),
    active: Object.freeze({
      default: "/  Law Office/   Cases/  Active Cases/  Active - {{case_type}}/ {{case_id}} - {{lfm_name}} - {{number}} - {{case_subtype}}",
      subfolders: Object.freeze([
        "Docket - {{contact_name}} - {{case_subtype}} - {{case_number}}",
        "Drafts - {{contact_name}}",
        "Client Docs - {{contact_name}}",
        "Correspondence - {{contact_name}}",
      ]),
    }),
  }),
  // D3c-1: the v3 folder tree (design §6) — the PLATFORM default is the nested
  // contact → case tree most firms keep; 4LSG's row is seeded case-only
  // ({ case: <its dropbox_case_folder_templates>, contact: null }) by
  // scripts/storageSeamD3cStorageFolders.js, so nothing changes for it. A case
  // template may name {{contact_folder}} (the primary contact's bound folder,
  // D3c-2) and {{case_type_full}} ("Bankruptcy: Ch 12" / the type / "unknown").
  storage_folders: Object.freeze({
    case: Object.freeze({
      potential: Object.freeze({ default: '{{contact_folder}}/{{number}} - {{case_type_full}}', subfolders: Object.freeze([]) }),
      active:    Object.freeze({ default: '{{contact_folder}}/{{number}} - {{case_type_full}}', subfolders: Object.freeze([]) }),
    }),
    contact: Object.freeze({ default: '/Clients/{{lfm_name}}', subfolders: Object.freeze([]) }),
  }),
});

module.exports = { STORAGE_DEFAULTS };
