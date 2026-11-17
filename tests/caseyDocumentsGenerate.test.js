'use strict';
/**
 * tests/caseyDocumentsGenerate.test.js
 *
 * A11X — Casey generates ONE document from a contract template for ONE case or
 * contact, or registers ONE file already in Dropbox, through reviewed cards on
 * the Documents page's own routes (Fred, 2026-11-15 / 16: "release means allow"):
 *   document.generate.v1 → POST /api/documents/generate {template_id, linkable_type, linkable_id, values?, document_name?}
 *   document.register.v1 → POST /api/documents/register {external_id}
 * plus the typed reads the cards cite — document.templates (the generate
 * picker's own filter, with the prefill keys) and the entry rows the
 * document.folder read gained (a file's Dropbox id comes from nowhere else).
 *
 * The contract pinned here:
 *   1. the casey_documents_enabled switch covers both kinds; the by-name and
 *      unknown-key refusals run before anything is read (a register card TAKES
 *      external_id — the one system key of its own);
 *   2. the generate: the template row cited from a document.templates read and
 *      the record row; the template refusals in generateFromTemplate's order
 *      and words (gone / inactive / signature-only / a pdf template with no
 *      source PDF); a gone record (stricter than the route, which files into
 *      the bin); `values` only on declared keys and only in the user's words;
 *      missing REQUIRED keys refused in the service's words; the default name,
 *      the dated file name, the DESTINATION per rung (describePlacement — the
 *      case folder, auto-create + task, the unsorted bin + move task, a
 *      contact's bin with its prefix), the relation the ingest would write, the
 *      blanks, the resolved values (an SSN-shaped key masked), where it shows,
 *      both events dry-run, `expected`; and that NOTHING IS WRITTEN at proposal
 *      (no INSERT / UPDATE, no upload, no folder created, no task raised);
 *   3. the register: the id must be an `entry` row of a document.folder read
 *      (a typed id, a documents row's external_id, a nested-folder row, a
 *      folder entry — each refused by name); the re-stat (gone, a folder in the
 *      route's words); a row already registered as a no-op naming it; the
 *      attribution the sync would make (a cached case folder or none), the
 *      enabled root or UNDER NO SYNC ROOT, the kill switch; `expected`;
 *   4. the reads: the folder read's entry rows (ids, registered_document_id),
 *      document.templates (keys split; generate_ready; LIKE escaping; the none
 *      row), the step validator and fingerprints;
 *   5. the ledger receipts and the request detector;
 *   6. the browser half (lifted from public/assistant.html by name): the
 *      request EXACTLY the reviewed one, the prechecks, the result checks
 *      (an unregistered file is ambiguous; created:false is "already
 *      registered"), the known outcomes, danger, the applied copy, text.
 *
 * The routes' own behaviour (the real generate with Dropbox stubbed at the
 * provider object, the registry row and link written, the real register) runs
 * on a real engine in tests/caseyDocumentsGenerate.mysql.test.js.
 *
 *   npx jest tests/caseyDocumentsGenerate.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const dropbox = require(path.join(REPO, 'services', 'dropboxService'));
const sync = require(path.join(REPO, 'services', 'documentSyncService'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const taskService = require(path.join(REPO, 'services', 'taskService'));
const { nowLocal } = require(path.join(REPO, 'services', 'timezoneService'));
const { normalizeActionDraft, taskDraftRequested, validateStep, stepFingerprint, documentFolderRead, documentTemplatesRead } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const TODAY = nowLocal().toFormat('yyyy-MM-dd');
const UPDATED = new Date('2026-11-01T12:00:00Z');
const CASE_LINK = 'https://www.dropbox.com/scl/fo/abc/case?rlkey=1';
const CASE_FOLDER = '/Active Cases/Debtor, Dana';

function schema(over = []) {
  return JSON.stringify([
    { key: 'client_name', label: 'Client name', type: 'text', resolver: 'case.case_name', required: true },
    { key: 'docket', label: 'Docket', type: 'text', resolver: 'case.docket', required: false },
    { key: 'hearing_date', label: 'Hearing date', type: 'text', required: false },
    { key: 'client_ssn', label: 'SSN', type: 'text', resolver: 'case.case_number', required: false },
    ...over,
  ]);
}
const TEMPLATES = () => ({
  14: { id: 14, name: 'Hearing Notice', kind: 'notice', template_type: 'html', purpose: 'generate', file_subfolder: 'Notices', body: '<p>{{client_name}} {{docket}} {{hearing_date}} {{client_ssn}}</p>',
    prefill_schema: schema(), placement_json: '{"fields":[]}', reminders_off: 0, expiration_days: 14, active: 1, updated_at: UPDATED },
  15: { id: 15, name: 'Fee Agreement', kind: 'contract', template_type: 'html', purpose: 'esign', file_subfolder: 'Generated Documents', body: '<p>x</p>', prefill_schema: '[]', placement_json: '{"fields":[]}', reminders_off: 0, expiration_days: 14, active: 1, updated_at: UPDATED },
  16: { id: 16, name: 'Old Letter', kind: 'letter', template_type: 'html', purpose: 'both', file_subfolder: 'Letters', body: '<p>x</p>', prefill_schema: '[]', placement_json: '{"fields":[]}', reminders_off: 0, expiration_days: 14, active: 0, updated_at: UPDATED },
  17: { id: 17, name: 'Blank Form', kind: 'form', template_type: 'pdf', purpose: 'generate', file_subfolder: 'Forms', body: '', prefill_schema: '[]', placement_json: '{"fields":[]}', reminders_off: 0, expiration_days: 14, active: 1, updated_at: UPDATED },
  18: { id: 18, name: 'Strict Notice', kind: 'notice', template_type: 'html', purpose: 'both', file_subfolder: 'Notices', body: '<p>{{amount}}</p>',
    prefill_schema: JSON.stringify([{ key: 'amount', label: 'Amount', type: 'text', required: true }]), placement_json: '{"fields":[]}', reminders_off: 0, expiration_days: 14, active: 1, updated_at: UPDATED },
});

let spies = []; let calls;
function makeDb(over = {}) {
  const templates = over.templates || TEMPLATES();
  const pdfs = over.pdfs || { 17: null };
  const caseRow = over.caseMissing ? null : { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Chapter 7', case_dropbox: 'case_dropbox' in over ? over.case_dropbox : CASE_LINK, case_trustee: null };
  const contacts = { 77: { contact_id: 77, contact_name: 'Dana Debtor', contact_lfm_name: 'Debtor, Dana' }, 78: { contact_id: 78, contact_name: 'Sam Debtor', contact_lfm_name: 'Debtor, Sam' } };
  const relate = over.relate || [{ case_id: CASE_ID, contact_id: 77, type: 'Primary' }, { case_id: CASE_ID, contact_id: 78, type: 'Secondary' }];
  const docs = over.docs || {};
  const roots = over.roots || [{ id: 1, path: '/Active Cases', note: null, enabled: 1, backfill_done: 1, syncing_since: null, last_sync_at: null, last_error: null, stats: null, created_at: UPDATED, has_cursor: 1 }];
  const folders = over.folders || { '/active cases/debtor, dana': CASE_ID };
  calls = { queries: [], dropbox: [] };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.queries.push([flat, params]);
    if (flat === 'SELECT * FROM contract_templates WHERE id = ? LIMIT 1') { const t = templates[Number(params[0])]; return [t ? [{ ...t }] : []]; }
    if (flat === 'SELECT size, original_name FROM contract_template_pdfs WHERE template_id = ? LIMIT 1') { const p = pdfs[Number(params[0])]; return [p ? [{ ...p }] : []]; }
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') return [caseRow && String(params[0]).toLowerCase() === CASE_ID.toLowerCase() ? [{ ...caseRow }] : []];
    if (flat === 'SELECT * FROM cases WHERE case_id = ? LIMIT 1') return [caseRow && String(params[0]) === CASE_ID ? [{ ...caseRow }] : []];
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1') { const c = contacts[Number(params[0])]; return [c && !over.contactMissing ? [{ contact_id: c.contact_id, contact_name: c.contact_name }] : []]; }
    if (flat === 'SELECT * FROM contacts WHERE contact_id = ? LIMIT 1') { const c = contacts[Number(params[0])]; return [c ? [{ ...c }] : []]; }
    if (flat === 'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1') { const c = contacts[Number(params[0])]; return [c ? [{ contact_lfm_name: c.contact_lfm_name }] : []]; }
    if (flat.startsWith("SELECT co.* FROM case_relate cr JOIN contacts co ON co.contact_id = cr.case_relate_client_id WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'")) {
      const r = relate.find((x) => x.case_id === params[0] && x.type === 'Primary'); return [r ? [{ ...contacts[r.contact_id] }] : []];
    }
    if (flat.startsWith("SELECT co.* FROM case_relate cr JOIN contacts co ON co.contact_id = cr.case_relate_client_id WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Secondary'")) {
      const r = relate.find((x) => x.case_id === params[0] && x.type === 'Secondary'); return [r ? [{ ...contacts[r.contact_id] }] : []];
    }
    if (flat.startsWith('SELECT c.contact_lfm_name FROM case_relate cr JOIN contacts c ON c.contact_id = cr.case_relate_client_id WHERE cr.case_relate_case_id = ?')) {
      const r = relate.find((x) => x.case_id === params[0] && x.type === 'Primary') || relate.find((x) => x.case_id === params[0]); return [r ? [{ contact_lfm_name: contacts[r.contact_id].contact_lfm_name }] : []];
    }
    // D3b-1: the filing paths read the binding first (this world's binding = the case's link + its folder from `folders`, as the backfill would hold), the legacy column second
    if (flat === 'SELECT external_id, path_lower, human_link FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1') {
      const p = Object.entries(folders).find(([, id]) => id === params[1]);
      const link = caseRow && String(params[1]) === CASE_ID ? caseRow.case_dropbox : null;
      return [(p || link) ? [{ external_id: null, path_lower: p ? p[0] : null, human_link: link || null }] : []];
    }
    if (flat === 'SELECT path_lower, resolve_error FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1') { const p = Object.entries(folders).find(([, id]) => id === params[1]); return [p ? [{ path_lower: p[0], resolve_error: null }] : []]; }
    if (flat === 'SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1') return [caseRow && String(params[0]) === CASE_ID ? [{ case_id: CASE_ID, case_dropbox: caseRow.case_dropbox }] : []];
    if (flat === "SELECT `value` FROM app_settings WHERE `key` = 'dropbox_credential_id' LIMIT 1") return [[{ value: '8' }]];
    if (flat === 'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1') {
      if (params[0] === 'documents_sync_enabled') return [[{ value: over.syncOff ? '0' : '1' }]];
      if (params[0] === 'dropbox_unsorted_generated_path') return [over.binPath ? [{ value: over.binPath }] : []];
      return [[]];
    }
    if (flat === "SELECT entity_id AS case_id, path_lower FROM entity_folders WHERE entity_kind = 'case' AND source = 'dropbox' AND path_lower IN (?)") return [params[0].filter((p) => folders[p]).map((p) => ({ case_id: folders[p], path_lower: p }))];
    if (flat === 'SELECT case_relate_client_id AS rel_id, case_relate_type AS rel_type FROM case_relate WHERE case_relate_case_id = ?') return [relate.filter((r) => r.case_id === params[0]).map((r) => ({ rel_id: r.contact_id, rel_type: r.type }))];
    if (flat === 'SELECT case_relate_case_id AS rel_id, case_relate_type AS rel_type FROM case_relate WHERE case_relate_client_id = ?') return [relate.filter((r) => r.contact_id === params[0]).map((r) => ({ rel_id: r.case_id, rel_type: r.type }))];
    if (flat === "SELECT case_id, COALESCE(NULLIF(case_number_full, ''), NULLIF(case_number, ''), case_id) AS label FROM cases WHERE case_id IN (?)") return [params[0].filter((id) => id.toLowerCase() === CASE_ID.toLowerCase()).map(() => ({ case_id: CASE_ID, label: '25-12345-abc' }))];
    if (flat === "SELECT contact_id, COALESCE(NULLIF(contact_name, ''), CONCAT('#', contact_id)) AS label FROM contacts WHERE contact_id IN (?)") return [params[0].filter((id) => contacts[id]).map((id) => ({ contact_id: id, label: contacts[id].contact_name }))];
    if (flat === 'SELECT * FROM documents WHERE source = ? AND external_id = ?') { const d = Object.values(docs).find((x) => x.external_id === params[1]); return [d ? [{ ...d }] : []]; }
    if (flat === 'SELECT id, external_id, path_lower FROM documents WHERE source = ? AND external_id IN (?)') return [Object.values(docs).filter((d) => params[1].includes(d.external_id)).map((d) => ({ id: d.id, external_id: d.external_id, path_lower: d.path_lower }))];
    if (flat.startsWith('SELECT id, path, note, enabled, backfill_done, syncing_since, last_sync_at, last_error, stats, created_at, (sync_cursor IS NOT NULL) AS has_cursor FROM document_sync_roots ORDER BY id ASC')) return [roots.map((r) => ({ ...r }))];
    if (flat.startsWith('SELECT COUNT(*) AS n, MAX(server_modified) AS newest FROM documents')) return [[{ n: over.registered == null ? 2 : over.registered, newest: null }]];
    if (flat.startsWith('SELECT dl.link_id AS case_id, COUNT(DISTINCT d.id) AS n')) return [[]];
    if (flat.startsWith('SELECT t.id, t.name, t.kind, t.template_type, t.purpose, t.file_subfolder, t.updated_at, t.prefill_schema, (p.template_id IS NOT NULL) AS has_pdf FROM contract_templates t')) {
      let list = Object.values(templates).filter((t) => t.active && ['generate', 'both'].includes(t.purpose));
      if (params.length) { const needle = params[0].slice(1, -1).replace(/\\([%_\\])/g, '$1').toLowerCase(); list = list.filter((t) => t.name.toLowerCase().includes(needle)); }
      return [list.sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ id: t.id, name: t.name, kind: t.kind, template_type: t.template_type, purpose: t.purpose, file_subfolder: t.file_subfolder, updated_at: t.updated_at, prefill_schema: t.prefill_schema, has_pdf: pdfs[t.id] ? 1 : 0 }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  const meta = over.meta || {};
  spies = [
    jest.spyOn(dropbox, 'resolveLocation').mockImplementation(async (_db, cred, o) => { calls.dropbox.push(['resolveLocation', cred, o]); if (over.deadLink) throw new Error('link revoked'); return CASE_FOLDER; }),
    jest.spyOn(dropbox, 'getMetadata').mockImplementation(async (_db, o) => { calls.dropbox.push(['getMetadata', o]); const m = meta[o.path]; if (!m) throw Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' }); return m; }),
    jest.spyOn(dropbox, 'listFolder').mockImplementation(async (_db, o) => { calls.dropbox.push(['listFolder', o]); return over.listing || { entries: [], truncated: false }; }),
    jest.spyOn(dropbox, 'uploadFile').mockImplementation(async () => { throw new Error('uploadFile must never run at proposal'); }),
    jest.spyOn(dropbox, 'createFolder').mockImplementation(async () => { throw new Error('createFolder must never run at proposal'); }),
    jest.spyOn(dropbox, 'getTemporaryLink').mockImplementation(async () => { throw new Error('getTemporaryLink must never run at proposal'); }),
    jest.spyOn(caseService, 'ensureCaseDropboxFolder').mockImplementation(async () => { throw new Error('ensureCaseDropboxFolder must never run at proposal'); }),
    jest.spyOn(taskService, 'createTask').mockImplementation(async () => { throw new Error('createTask must never run at proposal'); }),
    jest.spyOn(sync, '_loadFolderOwners').mockImplementation(async () => ({ owners: new Map(), under: new Map(), size: 0 })),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => ((over.rules || {})[ev] || []).map((r) => ({ ...r }))),
  ];
  if (over.evaluate) spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(over.evaluate));
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_DOCUMENTS_ENABLED; });

// q1 = the templates read, q2 = a case read, q3 = a contact read, q4 = a folder read (its entry rows), q5 = a documents read.
const FOLDER = '/Active Cases/Debtor, Dana';
const FOLDER_READ = (rows) => ({ id: 'q4', kind: 'document.folder', purpose: 'the folder', rows: rows || [
  { row_type: 'folder', path: FOLDER, path_lower: FOLDER.toLowerCase(), exists: '1', is_folder: '1', under_enabled_root: '1', root: '/active cases', listed_files: '2', listed_folders: '1', listing_truncated: '0', registered_files: '1', proposable: '1' },
  { row_type: 'nested_case_folder', case_id: 'NEST1111', path: `${FOLDER.toLowerCase()}/nested`, parent_path: FOLDER },
  { row_type: 'entry', entry_id: 'id:NEWFILE01', name: 'Paystub.pdf', path: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, parent_path: FOLDER, is_folder: '0', size: '1024', registered_document_id: null },
  { row_type: 'entry', entry_id: 'id:OLDFILE01', name: 'Petition.pdf', path: `${FOLDER}/Petition.pdf`, path_lower: `${FOLDER.toLowerCase()}/petition.pdf`, parent_path: FOLDER, is_folder: '0', size: '2048', registered_document_id: '88412' },
  { row_type: 'entry', entry_id: 'id:SUBFOLD01', name: 'Scans', path: `${FOLDER}/Scans`, path_lower: `${FOLDER.toLowerCase()}/scans`, parent_path: FOLDER, is_folder: '1', size: null, registered_document_id: null },
] });
const EVIDENCE = [
  { id: 'q1', kind: 'document.templates', purpose: 'templates', rows: [{ row_type: 'template', template_id: '14', name: 'Hearing Notice' }, { row_type: 'template', template_id: '16', name: 'Old Letter' }, { row_type: 'template', template_id: '17', name: 'Blank Form' }, { row_type: 'template', template_id: '18', name: 'Strict Notice' }, { row_type: 'template', template_id: '99', name: 'Gone' }] },
  { id: 'q2', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
  { id: 'q3', rows: [{ contact_id: 77, contact_name: 'Dana Debtor' }] },
  FOLDER_READ(),
  { id: 'q5', rows: [{ document_id: 88412, external_id: 'id:OLDFILE01' }] },
];
const tplRow = (id) => ({ 14: 1, 16: 2, 17: 3, 18: 4, 99: 5 }[id]);
const generate = (over = {}) => ({ kind: 'document.generate.v1', template_id: 14, linkable_type: 'case', linkable_id: CASE_ID,
  evidence: [{ query_id: 'q1', row_number: tplRow(over.template_id || 14) }, { query_id: over.linkable_type === 'contact' ? 'q3' : 'q2', row_number: 1 }], ...over });
const register = (over = {}) => ({ kind: 'document.register.v1', external_id: 'id:NEWFILE01', evidence: [{ query_id: 'q4', row_number: 3 }], ...over });

const run = (value, dbOver, evidence = EVIDENCE, opts = {}) => normalizeActionDraft(makeDb(dbOver), value, evidence, { currentUserId: ME, ...opts });
const refuse = (value, re, dbOver, evidence, opts) => expect(run(value, dbOver, evidence, opts)).rejects.toThrow(re);
const writes = () => calls.queries.filter(([sql]) => /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));

describe('the switch and the refusals before anything is read', () => {
  test("'0' makes both kinds unavailable; unset is ON", async () => {
    process.env.CASEY_DOCUMENTS_ENABLED = '0';
    for (const v of [generate(), register()]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_DOCUMENTS_ENABLED;
    await expect(run(generate(), { meta: {} })).resolves.toMatchObject({ kind: 'document.generate.v1', status: 'draft' });
    await expect(run(register(), { meta: { 'id:NEWFILE01': { '.tag': 'file', id: 'id:NEWFILE01', name: 'Paystub.pdf', path_display: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, size: 1024, rev: 'r1' } } })).resolves.toMatchObject({ kind: 'document.register.v1', status: 'draft' });
  });
  test.each([
    ['status on a generate', () => generate({ status: 'active' }), /^STATUS refused: .*\(document\.generate\.v1\)$/],
    ['external_id on a generate', () => generate({ external_id: 'id:x' }), /^EXTERNAL_ID refused: a document's file name, path and Dropbox id belong to Dropbox/],
    ['name on a generate', () => generate({ name: 'x.pdf' }), /^NAME refused: /],
    ['status on a register', () => register({ status: 'active' }), /^STATUS refused: .*\(document\.register\.v1\)$/],
    ['path on a register', () => register({ path: '/x' }), /^PATH refused: /],
    ['an unknown key on a generate', () => generate({ overwrite: true }), /^A document\.generate\.v1 card carries unsupported fields: overwrite — it takes template_id, linkable_type, linkable_id, values, document_name, evidence only$/],
    ['an unknown key on a register', () => register({ title: 'T' }), /^A document\.register\.v1 card carries unsupported fields: title — it takes external_id, evidence only$/],
  ])('%s', async (_n, make, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, make(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the generate card — shape and evidence', () => {
  test('template_id, linkable_type / linkable_id, values and document_name shapes', async () => {
    await refuse(generate({ template_id: 0 }), /^A document generate card needs the template's exact positive template_id/);
    await refuse(generate({ linkable_type: 'appt' }), /^A generated document is filed for a case \(linkable_type "case", linkable_id = the exact case_id\) or a contact .* — not "appt"$/);
    await refuse(generate({ linkable_id: 'bad id!' }), /^A case generate needs linkable_id = the case's exact case_id$/);
    await refuse(generate({ linkable_type: 'contact', linkable_id: 0 }), /^A contact generate needs linkable_id = the contact's exact positive contact_id$/);
    await refuse(generate({ values: ['x'] }), /^values must be an object mapping a prefill key to the text to use$/);
    await refuse(generate({ values: { 'Bad Key': 'x' } }), /^values carries "Bad Key", which is not a prefill key$/);
    await refuse(generate({ values: { hearing_date: { a: 1 } } }), /^values\.hearing_date must be text or a number$/);
    await refuse(generate({ values: { hearing_date: 'a\nb' } }), /^values\.hearing_date must be one line of at most 500 characters/);
    await refuse(generate({ document_name: 'x'.repeat(101) }), /^document_name is 101 characters — the file name keeps 100 of it and the rest would be cut off silently\. Shorten it$/);
    await refuse(generate({ document_name: 'a\u0001b' }), /^document_name must be one line with no control characters$/);
  });
  test('the template row from a document.templates read and the record row are both cited', async () => {
    await refuse(generate({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The generate evidence does not identify template #14 — cite its row from a document\.templates read/);
    // A sql.read row carrying template_id is not the typed read.
    await refuse(generate({ evidence: [{ query_id: 'q5', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }), /^The generate evidence does not identify template #14/, undefined,
      [...EVIDENCE.filter((q) => q.id !== 'q5'), { id: 'q5', rows: [{ template_id: 14 }] }]);
    await refuse(generate({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /^The generate evidence does not identify case 7KQ2M9XA — cite a row carrying its exact case_id/);
    await refuse(generate({ linkable_type: 'contact', linkable_id: 77, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }), /^The generate evidence does not identify contact 77 — cite a row carrying its exact contact_id/);
    expect(writes()).toEqual([]);
  });
  test('the template refusals, in generateFromTemplate\'s order and words; a gone record', async () => {
    await refuse(generate({ template_id: 99 }), /^Template 99 not found\. — it was deleted since the templates were read$/);
    await refuse(generate({ template_id: 16 }), /^Template "Old Letter" is inactive and cannot be used\. Reactivate it, or pick another\.$/);
    await refuse(generate({ template_id: 15, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }), /^The generate evidence does not identify template #15/);
    const esign = [{ ...EVIDENCE[0], rows: [...EVIDENCE[0].rows, { row_type: 'template', template_id: 15 }] }, ...EVIDENCE.slice(1)];
    await refuse(generate({ template_id: 15, evidence: [{ query_id: 'q1', row_number: 6 }, { query_id: 'q2', row_number: 1 }] }), /^Template "Fee Agreement" is a signature-only template; set its purpose to generate or both\. \(A fee agreement generated and filed instead of sent for signature looks like success and leaves nothing signed/, undefined, esign);
    await refuse(generate({ template_id: 17 }), /^Template "Blank Form" has no source PDF attached yet\. Upload one first\.$/);
    await refuse(generate(), /^Case 7KQ2M9XA no longer exists — the route would file the document into the unsorted bin for a record it cannot find; nothing is proposed$/, { caseMissing: true });
    await refuse(generate({ linkable_type: 'contact', linkable_id: 77 }), /^Contact 77 no longer exists/, { contactMissing: true });
    expect(writes()).toEqual([]);
  });
  test('values: only declared keys, only in the user\'s words (or a cited row); a required key the template cannot resolve refuses in the service\'s words', async () => {
    await refuse(generate({ values: { amount: '500' } }), /^values carries keys template "Hearing Notice" does not declare: amount — its prefill keys are client_name, docket, hearing_date, client_ssn \(the route would drop an undeclared key silently\)$/);
    await refuse(generate({ values: { hearing_date: '2026-12-04' } }), /^values\.hearing_date = "2026-12-04" is not a value the user gave — a generate card fills a key only with text that appears in the user's own words or in a cited row; leave it out and the template resolves it from case 25-12345-abc, or ask for it$/, undefined, undefined, { question: 'generate the hearing notice for the Smith case' });
    const ok = await run(generate({ values: { hearing_date: '2026-12-04' } }), undefined, undefined, { question: 'generate the hearing notice for Dana, hearing 2026-12-04' });
    expect(ok.request.values).toEqual({ hearing_date: '2026-12-04' });
    // In a cited row counts too.
    const cited = await run(generate({ values: { hearing_date: '25-12345' } }), undefined, undefined, { question: 'generate it' });
    expect(cited.request.values).toEqual({ hearing_date: '25-12345' });
    // The strict template: its one required key has no resolver and no value was given.
    await refuse(generate({ template_id: 18 }), /^Required value\(s\) are still empty: amount\. Fill them in and send again\. — the template could not resolve it from case 25-12345-abc; give each in "values" \(in the user's words\) or ask for it$/);
    expect(writes()).toEqual([]);
  });
});

describe('the generate card — what it carries, per rung', () => {
  test('the case rung: destination, relation "path", the dated file name, the default name, resolved values (SSN masked), blanks, where it shows, both events, expected, request; nothing written', async () => {
    const seen = [];
    const d = await run(generate(), { rules: { 'document.created': [{ id: 41, name: 'New file', actions: [] }], 'document.linked': [{ id: 42, name: 'Filed', actions: [] }] },
      evaluate: async (rule, env) => { seen.push([rule.id, env]); return { matched: rule.id === 42 }; } });
    expect(d).toMatchObject({ kind: 'document.generate.v1', status: 'draft',
      template: { template_id: 14, name: 'Hearing Notice', kind: 'notice', template_type: 'html', purpose: 'generate', file_subfolder: 'Notices', has_pdf: false },
      target: { link_type: 'case', link_id: CASE_ID, case_number: '25-12345-abc', label: 'case 25-12345-abc' },
      request: { template_id: 14, linkable_type: 'case', linkable_id: CASE_ID, values: null, document_name: null },
      document_name: 'Hearing Notice – Debtor', file_name: `${TODAY} Hearing Notice – Debtor.pdf`,
      predicted_path: `${CASE_FOLDER}/Notices/${TODAY} Hearing Notice – Debtor.pdf`,
      destination: { rung: 'case', placement: 'case', folder_path: `${CASE_FOLDER}/Notices`, subfolder: 'Notices', filename_prefix: '', task: null, note: null },
      relation: 'path',
      expected: { template: { updated_at: UPDATED.toISOString(), active: true, purpose: 'generate', template_type: 'html', has_pdf: false }, record: { case_dropbox: CASE_LINK } } });
    expect(d.values).toEqual({ given: null, blanks: ['hearing_date'],
      resolved: [{ key: 'client_name', label: 'Client name', required: true, filled: true, given: false, value: 'Dana Debtor' },
        { key: 'docket', label: 'Docket', required: false, filled: true, given: false, value: '25-12345-abc' },
        { key: 'hearing_date', label: 'Hearing date', required: false, filled: false, given: false, value: '' },
        { key: 'client_ssn', label: 'SSN', required: false, filled: true, given: false, value: '(filled — not shown here)' }] });
    expect(d.warnings).toEqual([
      'WRITES A FILE: applying renders the template and WRITES a new PDF into Dropbox, registers it and links it — there is no undo button (the file is deleted in Dropbox; the sync then marks the row deleted after its grace window).',
      'BLANKS: hearing_date render as blank — the template could not resolve it from case 25-12345-abc and no value was given. A notice with a blank line is one a person can finish by hand; give the value in "values" to fill it.']);
    expect(d.effects).toEqual([
      `Destination: ${CASE_FOLDER}/Notices/${TODAY} Hearing Notice – Debtor.pdf — case 25-12345-abc's Dropbox folder, subfolder "Notices" (created if absent).`,
      'Name collision: if a file of that name is already in the folder, Dropbox keeps it and names the new one with a counter ("… (1).pdf") — nothing is overwritten.',
      `Rendered: the template's HTML rendered to a PDF by the firm's renderer (one rendering at a time); the file name is dated ${TODAY} (today in the firm's zone — the date at the click).`,
      'Resolved from case 25-12345-abc: client_name = "Dana Debtor"; docket = "25-12345-abc"; client_ssn = "(filled — not shown here)".',
      'Registers: one documents row (source dropbox, the file\'s Dropbox id, name, path, size) and ONE link to case 25-12345-abc with relation "path" (the file lands in the case\'s cached Dropbox folder — the Dropbox sync\'s own mark); the document starts active with no title, type or tags (a document.update card sets them).',
      'Trigger events: document.created fires when the file is registered, then document.linked for the link — every active rule on either is listed below (the dry run uses the predicted name and path).',
      'Other open pages: case 25-12345-abc\'s Documents tab refreshes on its own (the generate route is on the live-update bus).']);
    expect(d.visibility).toEqual(['case 25-12345-abc\'s Documents tab — listed directly, at once.',
      'Under "Include related" (on by default): the Documents tab of each contact on this case — Dana Debtor (contact #77) (Primary on the case); Sam Debtor (contact #78) (Secondary on the case) — badged "via case 25-12345-abc".',
      'Staff only: the client portal does not list registered documents; Casey emails or texts it only through a separate send card.']);
    expect(d.automation).toEqual({ events: ['document.created', 'document.linked'], rules_checked: 2, quiet: 1, lines: ['Trigger rule #42 "Filed" runs: no active actions'] });
    expect(seen.map(([id, env]) => [id, env.data.name, env.data.path, env.source, env.actor, env.extra, env.case_id])).toEqual([
      [41, `${TODAY} Hearing Notice – Debtor.pdf`, d.predicted_path, 'generated_doc', { user_id: 6 }, null, null],
      [42, `${TODAY} Hearing Notice – Debtor.pdf`, d.predicted_path, 'generated_doc', { user_id: 6 }, { link_type: 'case', link_id: CASE_ID, relation: 'path' }, CASE_ID]]);
    // READ-ONLY at proposal: the one provider call is the shared link's resolution; no write SQL.
    expect(calls.dropbox).toEqual([['resolveLocation', '8', { sharedLink: CASE_LINK, expectFolder: true }]]);
    expect(writes()).toEqual([]);
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q1', 1], ['q2', 1]]);
  });
  test('a given document_name is used as the name; relation "upload" when the folder is not the cached one', async () => {
    const d = await run(generate({ document_name: 'Notice of hearing – Debtor' }), { folders: { '/elsewhere': CASE_ID } });
    expect([d.document_name, d.file_name, d.relation, d.request.document_name]).toEqual(['Notice of hearing – Debtor', `${TODAY} Notice of hearing – Debtor.pdf`, 'upload', 'Notice of hearing – Debtor']);
    expect(d.effects.find((e) => e.startsWith('Registers:'))).toContain('relation "upload";');
  });
  test('rung 2 — no case_dropbox: AUTO-CREATE warning with the task, no folder created, no task raised, expected carries no link', async () => {
    const d = await run(generate(), { case_dropbox: null });
    expect(d.destination).toEqual({ rung: 'auto_create', placement: 'case', folder_path: null, subfolder: 'Notices', filename_prefix: '', task: 'Dropbox folder auto-created for case 7KQ2M9XA', note: expect.stringContaining('has no Dropbox folder linked, so one is created automatically') });
    expect(d.warnings[1]).toBe('AUTO-CREATE: case 25-12345-abc has no Dropbox folder linked. Applying CREATES one (the firm\'s stage-aware case folder template), links it to the case, raises a task "Dropbox folder auto-created for case 7KQ2M9XA" for the office-alerts assignee, then files the PDF under "Notices" inside it. If the case already has a folder that was never linked, you will have two — merge them and re-link the original on the case page (a document.folder read + a case folder card does that).');
    expect(d.effects[0]).toBe(`Destination: (the case folder created at the click)/Notices/${TODAY} Hearing Notice – Debtor.pdf.`);
    expect([d.predicted_path, d.relation, d.expected.record]).toEqual([null, 'upload', { case_dropbox: null }]);
    expect(calls.dropbox).toEqual([]);
    expect(writes()).toEqual([]);
  });
  test('rung 3 — a dead link: UNSORTED with the ladder\'s own reason, the per-case bin subfolder and the move task', async () => {
    const d = await run(generate(), { deadLink: true });
    expect(d.destination).toMatchObject({ rung: 'unsorted', placement: 'unsorted', folder_path: '/  Law Office/   Cases/  Unsorted Generated Documents/7KQ2M9XA - Debtor, Dana', task: 'Move generated document for case 7KQ2M9XA out of Unsorted' });
    expect(d.warnings[1]).toBe('UNSORTED: Could not open the case\'s Dropbox folder: link revoked The PDF goes to /  Law Office/   Cases/  Unsorted Generated Documents/7KQ2M9XA - Debtor, Dana instead, and a task "Move generated document for case 7KQ2M9XA out of Unsorted" is raised for the office-alerts assignee after the upload.');
    expect(d.effects[0]).toBe(`Destination: /  Law Office/   Cases/  Unsorted Generated Documents/7KQ2M9XA - Debtor, Dana/${TODAY} Hearing Notice – Debtor.pdf — the unsorted generated-documents folder's per-case subfolder.`);
    expect(d.relation).toBe('upload');
    expect(writes()).toEqual([]);
  });
  test('a contact: the bin root with the identity prefix, no task, no case folder; the bin path from the setting', async () => {
    const d = await run(generate({ linkable_type: 'contact', linkable_id: 77 }), { binPath: '/Bin' });
    expect(d.target).toMatchObject({ link_type: 'contact', contact_id: 77, contact_name: 'Dana Debtor', label: 'Dana Debtor (contact #77)' });
    expect(d.destination).toEqual({ rung: 'bin', placement: 'unsorted', folder_path: '/Bin', subfolder: null, filename_prefix: 'contact 77 - Debtor, Dana - ', task: null, note: 'This generated document is linked to a contact (id 77), so there is no case folder to file into. It went to the unsorted generated-documents folder (/Bin).' });
    expect([d.document_name, d.relation, d.predicted_path]).toEqual(['Hearing Notice – Debtor', 'upload', `/Bin/contact 77 - Debtor, Dana - ${TODAY} Hearing Notice – Debtor.pdf`]);
    expect(d.effects[0]).toBe(`Destination: /Bin/contact 77 - Debtor, Dana - ${TODAY} Hearing Notice – Debtor.pdf — the unsorted generated-documents folder (a contact has no case folder; the name carries the contact's identity prefix); no task is raised.`);
    expect(d.visibility[1]).toBe('Under "Include related" (on by default): the Documents tab of each case this contact is on — case 25-12345-abc (Primary on the case) — badged "via Dana Debtor (contact #77)".');
    expect(d.expected.record).toEqual({ contact_name: 'Dana Debtor' });
    expect(calls.dropbox).toEqual([]);
    expect(writes()).toEqual([]);
  });
  test('a rule that cannot be evaluated: the AUTOMATION danger line', async () => {
    const d = await run(generate(), { rules: { 'document.created': [{ id: 41, name: 'x', actions: [] }] }, evaluate: async () => ({ match_error: 'GUEST_CODE_BUSY' }) });
    expect(d.warnings.at(-1)).toBe('AUTOMATION: at least one trigger rule could not be evaluated for this document — read its line; it may run.');
  });
});

const NEW_META = { '.tag': 'file', id: 'id:NEWFILE01', name: 'Paystub.pdf', path_display: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, size: 1024, rev: 'r1', server_modified: '2026-10-02T10:00:00Z' };

describe('the register card', () => {
  test('the id must be an entry row of a document.folder read: a typed id, a documents row, a nested-folder row, a folder entry — each refused', async () => {
    await refuse(register({ external_id: '' }), /^A register card needs "external_id": the file's Dropbox id exactly as the entry row of a document\.folder read lists it/);
    await refuse(register({ external_id: 'id:TYPED001', evidence: [{ query_id: 'q4', row_number: 3 }] }), /^"id:TYPED001" is not an entry a document\.folder read listed in this investigation — Casey registers only a file whose Dropbox id it has read/);
    // Dropbox ids are case-sensitive: a re-cased id is not the read's entry.
    await refuse(register({ external_id: 'id:newfile01' }), /is not an entry a document\.folder read listed/);
    await refuse(register({ external_id: 'id:OLDFILE01', evidence: [{ query_id: 'q5', row_number: 1 }] }), /is not an entry a document\.folder read listed/);
    await refuse(register({ external_id: 'NEST1111', evidence: [{ query_id: 'q4', row_number: 2 }] }), /is not an entry a document\.folder read listed/);
    await refuse(register({ external_id: 'id:SUBFOLD01', evidence: [{ query_id: 'q4', row_number: 5 }] }), /^"Scans" is a folder — register targets files, not folders \(the route's own refusal\)$/);
    // A row of the folder read that is NOT an entry row, even carrying the id, is never the file's entry.
    const notEntry = EVIDENCE.map((q) => (q.id === 'q4' ? { ...q, rows: [q.rows[0], { row_type: 'nested_case_folder', case_id: 'NEST1111', entry_id: 'id:NEWFILE01', external_id: 'id:NEWFILE01', path: FOLDER }] } : q));
    await refuse(register({ evidence: [{ query_id: 'q4', row_number: 2 }] }), /is not an entry a document\.folder read listed/, undefined, notEntry);
    expect(calls.dropbox).toEqual([]);
    expect(writes()).toEqual([]);
  });
  test('after the read: the re-stat (gone; a folder in the route\'s words) and a row already registered (a no-op naming it)', async () => {
    await refuse(register(), /^"Paystub\.pdf" \(id:NEWFILE01\) is no longer in Dropbox — it was deleted since the folder was read \(a moved or renamed file keeps its id\)\. Read the folder again$/, { meta: {} });
    await refuse(register(), /^register targets files, not folders$/, { meta: { 'id:NEWFILE01': { '.tag': 'folder', id: 'id:NEWFILE01', name: 'Paystub.pdf' } } });
    await refuse(register(), /^"Paystub\.pdf" is already registered as document #88419 — nothing to register; the route would answer 200 created:false and only refresh that row\. To put it on a case, use a document\.link card$/,
      { meta: { 'id:NEWFILE01': NEW_META }, docs: { 88419: { id: 88419, external_id: 'id:NEWFILE01', status: 'active', path_lower: NEW_META.path_lower } } });
    await refuse(register(), /is already registered as document #88419 \(deleted — the sync marks it active again when it sees the file\) — nothing to register; .* Read it as documents\.id AS document_id$/,
      { meta: { 'id:NEWFILE01': NEW_META }, docs: { 88419: { id: 88419, external_id: 'id:NEWFILE01', status: 'deleted', path_lower: NEW_META.path_lower } } });
    expect(calls.dropbox).toEqual([['getMetadata', { path: 'id:NEWFILE01' }]]);
    expect(writes()).toEqual([]);
  });
  test('the card: inside a cached case folder under an enabled root — the sweep attribution, the root, the events, expected', async () => {
    const d = await run(register(), { meta: { 'id:NEWFILE01': NEW_META }, rules: { 'document.created': [{ id: 41, name: 'New file', actions: [] }] }, evaluate: async () => ({ matched: true }) });
    expect(d).toMatchObject({ kind: 'document.register.v1', status: 'draft',
      file: { external_id: 'id:NEWFILE01', name: 'Paystub.pdf', path: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, parent_path: FOLDER, size: 1024, server_modified: '2026-10-02T10:00:00.000Z', rev: 'r1' },
      folder_case: { case_id: CASE_ID, path_lower: FOLDER.toLowerCase() }, sync_root: { root_id: 1, path: '/Active Cases' }, sync_enabled: true,
      expected: { external_id: 'id:NEWFILE01', name: 'Paystub.pdf', size: 1024, rev: 'r1', parent_path: FOLDER } });
    expect(d.warnings).toEqual([]);
    expect(d.effects).toEqual([
      `Registers: one documents row — source dropbox, id id:NEWFILE01, "Paystub.pdf" (1024 bytes), path ${FOLDER}/Paystub.pdf — active, untitled (a document.update card sets the title, type and tags); the event source is "manual" with you as the actor.`,
      `Attribution: the file sits in case 7KQ2M9XA's cached Dropbox folder (${FOLDER.toLowerCase()}), so the Dropbox sync's attribution sweep links it to that case with its own "path" mark on a later pass — silently (no document.linked event) — while the sync is on. The register itself writes NO link; a document.link card links it to a case or contact at once.`,
      'Sync root: the file is under the enabled root "/Active Cases" — the sync registers such files on its own as it walks or on a change; registering by hand only brings this one forward.',
      'Untouched: the file in Dropbox — register reads it and writes nothing there.',
      'No undo: deleting the row is not available (the Dropbox sync owns a document\'s status); the registry keeps it.',
      'Trigger event: document.created fires — every active rule on it is listed below (no document.linked: register writes no link).',
      'Other open pages: the Documents page refreshes its list on its own; no case or contact tab changes (there is no link).']);
    expect(d.automation).toEqual({ events: ['document.created'], rules_checked: 1, quiet: 0, lines: ['Trigger rule #41 "New file" runs: no active actions'] });
    expect(writes()).toEqual([]);
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q4', 3]]);
  });
  test('no cached folder, no enabled root, the sync off: the Unlinked list, the UNDER NO SYNC ROOT danger, the off wording', async () => {
    const d = await run(register(), { meta: { 'id:NEWFILE01': { ...NEW_META, path_display: '/Loose/Paystub.pdf', path_lower: '/loose/paystub.pdf' } }, roots: [{ id: 1, path: '/Active Cases', enabled: 0 }], syncOff: true });
    expect([d.folder_case, d.sync_root, d.sync_enabled, d.file.parent_path]).toEqual([null, null, false, '/Loose']);
    expect(d.warnings).toEqual(['UNDER NO SYNC ROOT: the file is under no enabled sync root, so the Dropbox sync will never see it — the row never updates when the file moves, renames or is deleted (it stays "active" with a stale name and path), and a re-register is the only refresh. If this folder should be watched, add a sync root for it (a document.sync_root.add card).']);
    expect(d.effects[1]).toBe('Attribution: the file is under no case\'s cached Dropbox folder, so the sync never links it — it shows on the Documents page\'s Unlinked list until a document.link card (or the Links dialog) puts it on a case or contact.');
    const off = await run(register(), { meta: { 'id:NEWFILE01': NEW_META }, syncOff: true });
    expect(off.effects[1]).toContain('but the sync is switched OFF right now, so not until it is switched back on');
    expect(off.effects[2]).toBe('Sync root: the file is under the enabled root "/Active Cases" — the sync is OFF, so nothing registers it until the engine is switched on; registering by hand brings it in now.');
  });
});

describe('the reads', () => {
  test('document.folder lists one entry row per direct entry with its Dropbox id and whether the registry holds it', async () => {
    const db = makeDb({ meta: { [FOLDER]: { '.tag': 'folder', id: 'id:FOLDER', path_lower: FOLDER.toLowerCase(), path_display: FOLDER } },
      listing: { entries: [
        { '.tag': 'file', id: 'id:NEWFILE01', name: 'Paystub.pdf', path_display: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, size: 1024, server_modified: '2026-10-02T10:00:00Z' },
        { '.tag': 'file', id: 'id:OLDFILE01', name: 'Petition.pdf', path_display: `${FOLDER}/Petition.pdf`, path_lower: `${FOLDER.toLowerCase()}/petition.pdf`, size: 2048, server_modified: '2026-01-02T10:00:00Z' },
        { '.tag': 'folder', id: 'id:SUBFOLD01', name: 'Scans', path_display: `${FOLDER}/Scans`, path_lower: `${FOLDER.toLowerCase()}/scans` },
        { '.tag': 'deleted', name: 'gone.pdf' }], truncated: false },
      docs: { 88412: { id: 88412, external_id: 'id:OLDFILE01', path_lower: `${FOLDER.toLowerCase()}/petition.pdf` } } });
    const r = await documentFolderRead(db, FOLDER);
    expect(r.rows.map((x) => x.row_type)).toEqual(['folder', 'entry', 'entry', 'entry']);
    expect(r.rows[0]).toMatchObject({ listed_files: 2, listed_folders: 1 });
    expect(r.rows.slice(1)).toEqual([
      { row_type: 'entry', entry_id: 'id:NEWFILE01', name: 'Paystub.pdf', path: `${FOLDER}/Paystub.pdf`, path_lower: `${FOLDER.toLowerCase()}/paystub.pdf`, parent_path: FOLDER, is_folder: 0, size: 1024, server_modified: '2026-10-02T10:00:00.000Z', registered_document_id: null,
        note: 'A file the registry does not hold — a document.register.v1 card with this exact entry_id registers it (cite this row)' },
      { row_type: 'entry', entry_id: 'id:OLDFILE01', name: 'Petition.pdf', path: `${FOLDER}/Petition.pdf`, path_lower: `${FOLDER.toLowerCase()}/petition.pdf`, parent_path: FOLDER, is_folder: 0, size: 2048, server_modified: '2026-01-02T10:00:00.000Z', registered_document_id: 88412,
        note: 'Registered already as document #88412 (documents.id) — a register card has nothing to do; link it with a document.link card' },
      { row_type: 'entry', entry_id: 'id:SUBFOLD01', name: 'Scans', path: `${FOLDER}/Scans`, path_lower: `${FOLDER.toLowerCase()}/scans`, parent_path: FOLDER, is_folder: 1, size: null, server_modified: null, registered_document_id: null,
        note: `A subfolder of "${FOLDER}" (never registered itself; read it with its own document.folder read)` }]);
    const lookup = calls.queries.find(([sql]) => sql.startsWith('SELECT id, external_id, path_lower FROM documents'));
    expect(lookup[1]).toEqual(['dropbox', ['id:NEWFILE01', 'id:OLDFILE01', 'id:SUBFOLD01']]);
    // A missing folder: no entries, no lookup.
    const gone = await documentFolderRead(makeDb({ meta: {} }), FOLDER);
    expect(gone.rows.map((x) => x.row_type)).toEqual(['folder']);
  });
  test('document.templates: active generate / both templates with their keys split; a pdf template with no PDF is NOT READY; LIKE escaping; the none row', async () => {
    const r = await documentTemplatesRead(makeDb());
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => [x.template_id, x.name, x.template_type, x.purpose, x.has_pdf, x.generate_ready, x.required_keys, x.optional_keys, x.resolved_keys, x.given_keys, x.link_kinds])).toEqual([
      [17, 'Blank Form', 'pdf', 'generate', 0, 0, null, null, null, null, 'case, contact'],
      [14, 'Hearing Notice', 'html', 'generate', 0, 1, 'client_name', 'docket, hearing_date, client_ssn', 'client_name, docket, client_ssn', 'hearing_date', 'case, contact'],
      [18, 'Strict Notice', 'html', 'both', 0, 1, 'amount', null, null, 'amount', 'case, contact']]);
    expect(r.rows[0].note).toMatch(/^NOT READY: a pdf template with no source PDF attached — the route refuses it: a document\.generate\.v1 card/);
    expect(r.rows[1].note).toMatch(/^Generate-ready: a document\.generate\.v1 card with this template_id for ONE case \(linkable_type "case"\) or contact \(linkable_type "contact"\) renders it to a PDF, files it under "Notices" in the case's Dropbox folder .* Never the template's text\.$/);
    expect(r.rows[1].updated_at).toBe(UPDATED.toISOString());
    expect(Object.keys(r.rows[1])).not.toContain('body');
    const q = await documentTemplatesRead(makeDb(), 'Hear%ing');
    const sql = calls.queries.find(([s]) => s.includes('FROM contract_templates t'));
    expect(sql[1]).toEqual(['%hear\\%ing%']);
    expect(q.rows).toEqual([{ row_type: 'none', note: 'No active template whose purpose allows generating has "hear%ing" in its name' }]);
    const none = await documentTemplatesRead(makeDb({ templates: {} }));
    expect(none.rows[0].note).toMatch(/^No active template has purpose generate or both — nothing can be generated/);
  });
  test('the step validator and fingerprints', () => {
    expect(validateStep({ id: 'q1', kind: 'document.templates', purpose: 'p' }, 0)).toEqual({ id: 'q1', kind: 'document.templates', purpose: 'p' });
    expect(validateStep({ id: 'q1', kind: 'document.templates', purpose: 'p', q: ' retainer ' }, 0)).toEqual({ id: 'q1', kind: 'document.templates', purpose: 'p', q: 'retainer' });
    expect(() => validateStep({ id: 'q1', kind: 'document.templates', purpose: 'p', q: 'x'.repeat(121) }, 0)).toThrow('Step q1 document.templates q must be at most 120 characters on one line');
    expect(validateStep({ id: 'q2', kind: 'document.sync_roots', purpose: 'p', anything: 1 }, 1)).toEqual({ id: 'q2', kind: 'document.sync_roots', purpose: 'p' });
    expect(stepFingerprint({ kind: 'document.templates', q: ' Retainer ' })).toBe('document.templates:retainer');
    expect(stepFingerprint({ kind: 'document.sync_roots' })).toBe('document.sync_roots');
  });
});

describe('the ledger, the request detector', () => {
  test('the generate and the register receipt the document_id the route answers', () => {
    expect([ledger.KINDS.get('document.generate.v1'), ledger.KINDS.get('document.register.v1')]).toEqual(['document_id', 'document_id']);
    for (const kind of ['document.upload.v1', 'document.delete.v1', 'document.status.v1']) expect(ledger.KINDS.has(kind)).toBe(false);
  });
  test.each([
    'Generate the hearing notice for the Smith case',
    'Make a hardship letter from the template for Dana',
    'Can you generate the discharge notice from the notice template?',
    'Register that paystub file in the documents registry',
    'Please register the scan in Dana\'s folder as a document',
  ])('a request does: %s', (q) => { expect(taskDraftRequested(q)).toBe(true); });
  test.each(['Which templates can be generated?', 'Is the paystub registered?', 'What is a sync root?'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q)).toBe(false);
  });
});

// ── The browser half, lifted from public/assistant.html by name ────────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
function familySrc(id) {
  const at = html.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`family ${id} not found`);
  const open = html.lastIndexOf('\n  {', at) + 3;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`family ${id} unbalanced`);
}
const FNS = ['documentSize', 'documentOpenInfo',
  'docgenerateLabel', 'docgenerateTargetLabel', 'docgenerateText', 'docgenerateBody', 'docgenerateRequest', 'docgeneratePrecheck', 'docgenerateResult',
  'docgenerateKnownOutcome', 'docgenerateAmbiguousText', 'docgenerateAppliedWarning', 'docgenerateEntity',
  'docregisterLabel', 'docregisterText', 'docregisterBody', 'docregisterRequest', 'docregisterPrecheck', 'docregisterResult', 'docregisterKnownOutcome'];
function browser(api, deps = {}) {
  const src = [constSrc('DOCGENERATE_ACTION_KINDS'), constSrc('DOCREGISTER_ACTION_KINDS'), constSrc('DOCREGISTER_LIST_MAX'), constSrc('DOCGENERATE_NAME_MAX'), ...FNS.map(fnSrc),
    `const families = [${familySrc('docgenerate')}, ${familySrc('docregister')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  const P = deps.P || { Swal: { fire: jest.fn() } };
  return new Function('api', 'openEntity', 'P', src)(api, deps.openEntity || jest.fn(), P); // eslint-disable-line no-new-func
}

describe('the browser: the request, the prechecks, the result checks, the outcomes, danger, the applied copy, text', () => {
  let genDraft; let regDraft;
  beforeEach(async () => {
    genDraft = await run(generate({ document_name: 'Notice – Debtor' }));
    regDraft = await run(register(), { meta: { 'id:NEWFILE01': NEW_META } });
  });
  const tpl = (over = {}) => ({ template: { id: 14, name: 'Hearing Notice', active: true, purpose: 'generate', template_type: 'html', has_pdf: false, updated_at: UPDATED.toISOString(), ...over } });
  const caseGet = (over = {}) => ({ case: { case_id: CASE_ID, case_dropbox: CASE_LINK, ...over } });
  function fakeApi(map) {
    return jest.fn(async (p, body, method) => {
      const key = `${method} ${p}`;
      if (!(key in map)) throw new Error(`unexpected api call ${key}`);
      const v = typeof map[key] === 'function' ? map[key](body) : map[key];
      if (v instanceof Error) throw v;
      return v;
    });
  }
  const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

  test('the requests: the generate POST EXACTLY the reviewed request (values and document_name only when present); the register POST the id', () => {
    const b = browser(jest.fn());
    expect(b.docgenerateRequest(genDraft)).toEqual({ path: '/api/documents/generate', method: 'POST', body: { template_id: 14, linkable_type: 'case', linkable_id: CASE_ID, document_name: 'Notice – Debtor' } });
    const bare = { ...genDraft, request: { ...genDraft.request, document_name: null, values: { hearing_date: '2026-12-04' } } };
    expect(b.docgenerateRequest(bare).body).toEqual({ template_id: 14, linkable_type: 'case', linkable_id: CASE_ID, values: { hearing_date: '2026-12-04' } });
    for (const bad of [{ template_id: 0 }, { linkable_type: 'appt' }, { linkable_id: 'no spaces!' }, { values: ['x'] }, { values: { 'Bad': 'x' } }, { values: { hearing_date: ' padded' } }, { document_name: 'x'.repeat(101) }, { document_name: '' }]) {
      expect(() => b.docgenerateRequest({ ...genDraft, request: { ...genDraft.request, ...bad } })).toThrow(/This card/);
    }
    expect(b.docregisterRequest(regDraft)).toEqual({ path: '/api/documents/register', method: 'POST', body: { external_id: 'id:NEWFILE01' } });
    expect(() => b.docregisterRequest({ ...regDraft, file: { external_id: ' id:x' } })).toThrow('This card has no usable Dropbox id.');
  });
  test('the generate precheck: the template re-read (gone, inactive, edited), then the case (gone, its Dropbox link changed) or the contact (renamed); a fresh card passes', async () => {
    const fresh = fakeApi({ 'GET /api/esign/templates/14': tpl(), [`GET /api/cases/${CASE_ID}`]: caseGet() });
    expect(await browser(fresh).docgeneratePrecheck(genDraft)).toBe('');
    expect(fresh.mock.calls.map((c) => c[0])).toEqual(['/api/esign/templates/14', `/api/cases/${CASE_ID}`]);
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': notFound() })).docgeneratePrecheck(genDraft)).toBe('Template "Hearing Notice" no longer exists. Nothing was generated.');
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl({ active: false }) })).docgeneratePrecheck(genDraft)).toBe('Template "Hearing Notice" is inactive now. Nothing was generated.');
    for (const changed of [{ updated_at: '2026-11-02T00:00:00.000Z' }, { purpose: 'both' }, { template_type: 'pdf', has_pdf: true }]) {
      expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(changed) })).docgeneratePrecheck(genDraft)).toBe('Template "Hearing Notice" changed since this card was prepared (it was edited, re-purposed or its source PDF changed). Nothing was generated. Ask Casey to prepare it again.');
    }
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), [`GET /api/cases/${CASE_ID}`]: notFound() })).docgeneratePrecheck(genDraft)).toBe('case 25-12345-abc no longer exists. Nothing was generated.');
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), [`GET /api/cases/${CASE_ID}`]: caseGet({ case_dropbox: null }) })).docgeneratePrecheck(genDraft)).toBe('The Dropbox folder of case 25-12345-abc changed since this card was prepared (its link was removed), so the document would be filed somewhere else than the card says. Nothing was generated. Ask Casey to prepare it again.');
    const noLink = await run(generate(), { case_dropbox: null });
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), [`GET /api/cases/${CASE_ID}`]: caseGet({ case_dropbox: '' }) })).docgeneratePrecheck(noLink)).toBe('');
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), [`GET /api/cases/${CASE_ID}`]: caseGet() })).docgeneratePrecheck(noLink)).toMatch(/its link was set or re-linked/);
    const contactDraft = await run(generate({ linkable_type: 'contact', linkable_id: 77 }));
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), 'GET /api/contacts/77': { contact: { contact_id: 77, contact_name: 'Dana Debtor' } } })).docgeneratePrecheck(contactDraft)).toBe('');
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), 'GET /api/contacts/77': { contact: { contact_id: 77, contact_name: 'Dana Debtor-Smith' } } })).docgeneratePrecheck(contactDraft)).toBe('Dana Debtor (contact #77) was renamed since this card was prepared (the document\'s default name and file name follow the contact\'s name). Nothing was generated. Ask Casey to prepare it again.');
    expect(await browser(fakeApi({ 'GET /api/esign/templates/14': tpl(), 'GET /api/contacts/77': notFound() })).docgeneratePrecheck(contactDraft)).toBe('Dana Debtor (contact #77) no longer exists. Nothing was generated.');
    // A failed read is the read's failure, never a refusal.
    await expect(browser(fakeApi({ 'GET /api/esign/templates/14': Object.assign(new Error('boom'), { status: 500 }) })).docgeneratePrecheck(genDraft)).rejects.toThrow('boom');
    // A card that cannot be sent is never read.
    const api = fakeApi({});
    await expect(browser(api).docgeneratePrecheck({ ...genDraft, request: { ...genDraft.request, template_id: 0 } })).rejects.toThrow('This card has no usable template id.');
    expect(api).not.toHaveBeenCalled();
  });
  test('the generate result: the route\'s echo of the template and record with a document id; no id = ambiguous (the file is written); a mismatch refused', () => {
    const b = browser(jest.fn());
    const ok = { status: 'success', path: `${CASE_FOLDER}/Notices/${TODAY} Notice – Debtor.pdf`, file_name: 'x', placement: 'case', document_id: 909, template_id: 14, link_type: 'case', link_id: CASE_ID, warnings: ['w1'], missing_optional: ['hearing_date'] };
    expect(b.docgenerateResult(genDraft, ok)).toEqual({ document_id: 909 });
    expect(genDraft.__docgenerateOutcome).toEqual({ path: ok.path, placement: 'case', warnings: ['w1'], missing_optional: ['hearing_date'] });
    expect(JSON.stringify(genDraft)).not.toContain('__docgenerateOutcome');
    let caught;
    try { b.docgenerateResult(genDraft, { ...ok, document_id: null }); } catch (e) { caught = e; }
    expect([caught.docgenerateUnregistered, caught.message]).toEqual([true, `the PDF was written to ${ok.path} but could not be registered (the route answered no document id)`]);
    for (const bad of [{ template_id: 15 }, { link_id: 'OTHER' }, { link_type: 'contact' }, { status: 'error' }, { path: '' }]) {
      expect(() => b.docgenerateResult(genDraft, { ...ok, ...bad })).toThrow(/did not (confirm the generated document|report where the file was written)/);
    }
    genDraft.result_docgenerate_document_id = 909;
    expect(b.docgenerateAppliedWarning(genDraft)).toBe(`"Notice – Debtor" was generated for case 25-12345-abc, written to ${ok.path} and registered as document #909, using your signed-in account. Blank in the document: hearing_date. The route reported: w1`);
    expect(b.docgenerateAmbiguousText('no result recorded', genDraft)).toMatch(/^This may already have been applied: .* A PDF MAY have been written to Dropbox for case 25-12345-abc — open its Documents tab and the destination folder and check/);
  });
  test('outcomes: the route\'s coded ESIGN_* 4xx are refusals (missing keys named); a 500 and an uncoded 4xx fall through', () => {
    const b = browser(jest.fn());
    expect(b.docgenerateKnownOutcome({ status: 400, body: { code: 'ESIGN_MISSING_PREFILL', message: 'Required value(s) are still empty: amount. Fill them in and send again.', missing: ['amount'] } }))
      .toEqual({ status: 'Refused — nothing generated', text: 'Refused — nothing generated: the documents route refused before rendering anything (Required value(s) are still empty: amount. Fill them in and send again. (amount)). Ask Casey to prepare it again.' });
    expect(b.docgenerateKnownOutcome({ status: 409, body: { code: 'ESIGN_TEMPLATE_PURPOSE', message: 'Template "Fee Agreement" is a signature-only template; set its purpose to generate or both.' } }).status).toBe('Refused — nothing generated');
    expect(b.docgenerateKnownOutcome({ status: 404, body: { code: 'ESIGN_NOT_FOUND', message: 'Template 14 not found.' } }).text).toContain('Template 14 not found.');
    expect(b.docgenerateKnownOutcome({ status: 500, body: { code: 'DOC_GENERATE_ERROR', message: 'could not upload' } })).toBe(null);
    expect(b.docgenerateKnownOutcome({ status: 400, body: { message: 'x' } })).toBe(null);
    expect(b.docgenerateKnownOutcome({ status: 409, body: { idempotency: { outcome: 'unknown' }, code: 'ESIGN_X' } })).toBe(null);
  });
  test('the register precheck: the parent re-listed with the read\'s cap; gone / a folder / renamed / resized refused; not found in a TRUNCATED listing passes; the folder gone', async () => {
    const entry = { '.tag': 'file', id: 'id:NEWFILE01', name: 'Paystub.pdf', size: 1024, rev: 'r1' };
    const listing = (entries, truncated = false) => fakeApi({ 'POST /api/dropbox/list': (body) => { expect(body).toEqual({ path: FOLDER, recursive: false, max_entries: 500 }); return { status: 'success', entries, truncated, count: entries.length }; } });
    expect(await browser(listing([entry, { '.tag': 'file', id: 'id:OTHER', name: 'o.pdf' }])).docregisterPrecheck(regDraft)).toBe('');
    expect(await browser(listing([])).docregisterPrecheck(regDraft)).toBe(`"Paystub.pdf" is no longer in "${FOLDER}" — it was deleted or moved since this card was prepared. Nothing was written. Ask Casey to read the folder again.`);
    expect(await browser(listing([], true)).docregisterPrecheck(regDraft)).toBe('');
    expect(await browser(listing([{ ...entry, '.tag': 'folder' }])).docregisterPrecheck(regDraft)).toBe('"Paystub.pdf" is a folder now, not a file. Nothing was written.');
    for (const changed of [{ name: 'Paystub (1).pdf' }, { size: 2048 }, { rev: 'r2' }]) {
      expect(await browser(listing([{ ...entry, ...changed }])).docregisterPrecheck(regDraft)).toBe('"Paystub.pdf" changed in Dropbox since this card was prepared (its name, size or revision). Nothing was written. Ask Casey to read the folder again.');
    }
    expect(await browser(fakeApi({ 'POST /api/dropbox/list': Object.assign(new Error('dropbox: POST /2/files/list_folder → 409: path/not_found/..'), { status: 409 }) })).docregisterPrecheck(regDraft))
      .toBe(`The folder "${FOLDER}" is gone from Dropbox (or is no longer a folder), so "Paystub.pdf" cannot be where this card says. Nothing was written. Ask Casey to read the folder again.`);
    await expect(browser(fakeApi({ 'POST /api/dropbox/list': Object.assign(new Error('boom'), { status: 500 }) })).docregisterPrecheck(regDraft)).rejects.toThrow('boom');
    // A file at the account root lists the root.
    const rootDraft = { ...regDraft, expected: { ...regDraft.expected, parent_path: '' } };
    const rootApi = fakeApi({ 'POST /api/dropbox/list': (body) => { expect(body.path).toBe(''); return { entries: [entry], truncated: false }; } });
    expect(await browser(rootApi).docregisterPrecheck(rootDraft)).toBe('');
  });
  test('the register result: created:true with the row; created:false is "already registered" (a known outcome, never a success); a mismatch refused', () => {
    const b = browser(jest.fn());
    expect(b.docregisterResult(regDraft, { status: 'success', created: true, document: { id: 910, external_id: 'id:NEWFILE01' } })).toEqual({ document_id: 910 });
    let caught;
    try { b.docregisterResult(regDraft, { status: 'success', created: false, document: { id: 910, external_id: 'id:NEWFILE01' } }); } catch (e) { caught = e; }
    expect([caught.documentRegisterNoop, caught.documentRegisterId]).toEqual([true, 910]);
    expect(b.docregisterKnownOutcome(caught)).toEqual({ status: 'Refused — already registered', text: 'Refused — already registered: that file was registered (by someone, or by the Dropbox sync) between this card being prepared and applied, as document #910; the route refreshed that row from Dropbox and made nothing new. Read it as documents.id AS document_id, or link it with a document.link card.' });
    for (const bad of [{ document: { id: 910, external_id: 'id:OTHER' } }, { document: null }, { status: 'error', document: { id: 910, external_id: 'id:NEWFILE01' } }, { document: { id: 0, external_id: 'id:NEWFILE01' } }]) {
      expect(() => b.docregisterResult(regDraft, { status: 'success', created: true, ...bad })).toThrow(/did not (confirm the registered file|return the new document)/);
    }
    expect(b.docregisterKnownOutcome({ status: 409, body: { message: 'dropbox: POST /2/files/get_metadata → 409: path/not_found/..' } })).toEqual({ status: 'Refused — nothing written', text: 'Refused — nothing written: Dropbox no longer has that file (dropbox: POST /2/files/get_metadata → 409: path/not_found/..), so there was nothing to register. Ask Casey to read the folder again.' });
    expect(b.docregisterKnownOutcome({ status: 409, body: { message: 'that path is already a sync root (root 1)' } })).toBe(null);
    expect(b.docregisterKnownOutcome({ status: 409, body: { idempotency: {}, message: 'dropbox: POST /2/files/get_metadata → 409: x' } })).toBe(null);
  });
  test('the families: receipts, danger (always for a generate; a register only with a warning), entities, the applied copy', () => {
    const b = browser(jest.fn());
    const [gen, reg] = b.families;
    expect([gen.id, [...gen.kinds], gen.idField, gen.appliedKey, gen.danger(genDraft), !!gen.stringReceipt]).toEqual(['docgenerate', ['document.generate.v1'], 'document_id', 'result_docgenerate_document_id', true, false]);
    expect([reg.id, [...reg.kinds], reg.idField, reg.appliedKey, reg.danger(regDraft), reg.danger({ ...regDraft, warnings: ['UNDER NO SYNC ROOT: x'] })]).toEqual(['docregister', ['document.register.v1'], 'document_id', 'result_docregister_document_id', false, true]);
    expect(gen.entity(genDraft)).toEqual({ kind: 'case', id: CASE_ID, label: '25-12345-abc' });
    genDraft.result_docgenerate_document_id = 909;
    expect(gen.appliedCopy(genDraft)).toMatchObject({ status: 'Applied — document #909 generated', button: 'Open 25-12345-abc' });
    expect(gen.resultText({ document_id: 909 })).toBe('document #909');
    expect(gen.refusalText('x')).toBe('Refused — nothing generated (x). Ask Casey to prepare it again.');
    regDraft.result_docregister_document_id = 910;
    expect(reg.appliedCopy(regDraft)).toEqual({ status: 'Applied — document #910 registered', button: 'Where is it?',
      warning: '"Paystub.pdf" is registered as document #910, using your signed-in account — active, untitled, linked to nothing (the sync\'s sweep links it to case 7KQ2M9XA on a later pass). Find it under More → Documents; a document.update card titles it and a document.link card puts it on a record.' });
    expect(reg.entity(regDraft)).toEqual({ kind: 'document', id: '910', label: 'Paystub.pdf' });
    expect(typeof gen.ambiguousText).toBe('function');
  });
  test('labels and the card text', () => {
    const b = browser(jest.fn());
    expect(b.docgenerateLabel(genDraft)).toBe('Generate document for case');
    expect(b.docgenerateLabel({ target: { link_type: 'contact' } })).toBe('Generate document for contact');
    const text = b.docgenerateText(genDraft);
    expect(text.split('\n').slice(0, 8)).toEqual(['Document generate proposal — not applied', 'Action: Generate document for case',
      'Template: #14 "Hearing Notice" (HTML rendered to PDF; purpose generate)', 'For: case 25-12345-abc', 'Document name: "Notice – Debtor" (as given)',
      `File name: ${TODAY} Notice – Debtor.pdf`, `Filed to: ${CASE_FOLDER}/Notices (the case folder's "Notices" subfolder)`, 'Link: case 25-12345-abc (relation "path")']);
    expect(text).toContain('Values resolved from the record: client_name = "Dana Debtor"; docket = "25-12345-abc"; client_ssn = "(filled — not shown here)"');
    expect(text).toContain('Blank in the document: hearing_date');
    expect(text).toContain('Writes: a NEW PDF in Dropbox at the destination above');
    expect(text).toContain('Automation: no active trigger rule acts on document.created / document.linked (0 checked).');
    expect(b.docregisterLabel()).toBe('Register file in the Documents registry');
    const rt = b.docregisterText(regDraft);
    expect(rt.split('\n').slice(0, 6)).toEqual(['Document register proposal — not applied', 'Action: Register file in the Documents registry', 'File: "Paystub.pdf" (1.0 KB, modified 2026-10-02)',
      `Path: ${FOLDER}/Paystub.pdf`, 'Dropbox id: id:NEWFILE01', 'Case folder: inside case 7KQ2M9XA\'s cached folder']);
    expect(rt).toContain('Sync root: under "/Active Cases" (root #1); sync engine on');
    expect(rt).toContain('Writes: one documents row (active, untitled, no link) — the file in Dropbox is untouched.');
  });
});
