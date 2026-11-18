// tests/storageReplay.test.js
//
/**
 * STORAGE REPLAY GOLDEN — tier A (storage-seam D0; ref/DOCUMENTS_V3_DESIGN.md §0).
 *
 * Every writer that talks to Dropbox is driven over one 4LSG-shaped fixture
 * against the recording fake (tests/helpers/recordingDropbox.js), and the
 * provider calls it makes + the effects it asks of the registry / tasks /
 * e-sign store / sync row layer + the provider tree it leaves behind are
 * compared, deep-equal, with tests/fixtures/storageReplay.golden.json.
 *
 * A slice that reroutes a writer through documentSourceService must leave
 * this golden byte-identical. A slice that changes it names the diff in its
 * report as a BEHAVIOR CHANGE — that is the gate. `STORAGE_GOLDEN_WRITE=1`
 * rewrites the golden from the current run and is REFUSED when CI is set:
 * a harness that only prints is not a gate.
 *
 * Scenario 8 (the upload-link / upload-commit routes) lives in
 * tests/storageReplay.routes.test.js: it needs documentSyncService mocked
 * away for the router to load, and scenario 11 here needs the real one.
 *
 * The mocked `db` is the world's SQL router (tests/helpers/storageReplayWorld.js):
 * it throws on a SELECT it does not model. Non-storage services are mocked
 * as recorders (tasks, registry, e-sign paths, the sync engine's row layer),
 * the case matcher is a fixture, bytes come from a fixture, not IMAP. The
 * clock is frozen (Date only — timers stay real, so nothing can hang).
 *
 *   npx jest tests/storageReplay.test.js
 *   STORAGE_GOLDEN_WRITE=1 npx jest tests/storageReplay.test.js   # regenerate
 */

'use strict';

const fs = require('fs');
const path = require('path');

process.env.FIRM_TIMEZONE = process.env.FIRM_TIMEZONE || 'America/Detroit';

jest.mock('../services/dropboxService', () => require('./helpers/recordingDropbox').factory());
jest.mock('../services/settingsService', () => ({
  getSetting: jest.fn(async (db, key) => (mockWorld.current.settings[key] ?? null)),
  getSettings: jest.fn(async (db, keys) => Object.fromEntries(keys.map((k) => [k, mockWorld.current.settings[k] ?? null]))),
}));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async (db, t) => { mockWorld.current.effects.push({ kind: 'task.create', ...mockWorld.scrub(t) }); return { task_id: 700 + mockWorld.current.effects.length }; }),
}));
jest.mock('../services/esignAlertService', () => ({ resolveAlertAssignee: jest.fn(async () => 22) }));
jest.mock('../services/esignService', () => ({
  setPdfPaths: jest.fn(async (db, id, paths) => { mockWorld.current.effects.push({ kind: 'signing_requests.pdf_paths', id, ...mockWorld.scrub(paths) }); }),
}));
jest.mock('../services/documentIngestService', () => {
  const reg = (name) => jest.fn(async (db, o) => {
    const w = mockWorld.current;
    w.docN = (w.docN || 0) + 1;
    const entry = o.entry;
    w.effects.push({ kind: `registry.${name}`, ...mockWorld.scrub({ entry, links: o.links, createdBy: o.createdBy, eventSource: o.eventSource, credentialId: o.credentialId, path: o.path, source: o.source }) });
    const document = { id: 900 + w.docN, external_id: entry && entry.id, path_lower: entry && entry.path_lower, name: entry && entry.name };
    const links = (o.links || []).map((l) => ({ link_type: l.type, link_id: String(l.id), relation: 'upload', created: true }));
    return name === 'registerWritten' ? { document, links } : { ok: true, document, links };
  });
  return { registerWrittenSafe: reg('registerWrittenSafe'), registerWritten: reg('registerWritten'), registerLandedInFolder: jest.fn() };
});
jest.mock('../services/documentService', () => {
  const E = (kind, data) => mockWorld.current.effects.push({ kind, ...mockWorld.scrub(data) });
  const ids = new Map();
  const idOf = (extId) => { if (!ids.has(extId)) ids.set(extId, 100 + ids.size); return ids.get(extId); };
  return {
    RELATION_PATH: 'path',
    bulkUpsertEntries: jest.fn(async (db, source, entries) => {
      const w = mockWorld.current; w.seen = w.seen || new Map();
      for (const e of entries) w.seen.set(e.id, { path_lower: e.path_lower });   // the row exists after a backfill, as it does live
      E('documents.bulkUpsert', { source, entries }); return { rows: entries.length };
    }),
    bulkLink: jest.fn(async (db, links) => { E('document_links.bulkLink', { links }); return { rows: links.length }; }),
    mapExternalIds: jest.fn(async (db, source, extIds) => new Map(extIds.map((x) => [String(x), { id: idOf(String(x)), path_lower: null }]))),
    upsertFromEntry: jest.fn(async (db, source, entry, opts) => {
      const w = mockWorld.current; w.seen = w.seen || new Map();
      const prior = w.seen.get(entry.id);
      const changes = prior && prior.path_lower !== entry.path_lower ? { path_lower: { from: prior.path_lower, to: entry.path_lower } } : {};
      w.seen.set(entry.id, { path_lower: entry.path_lower });
      E('documents.upsert', { source, entry, emit: opts && opts.emit, eventSource: opts && opts.eventSource, created: !prior, changes });
      return { row: { id: idOf(String(entry.id)), path_lower: entry.path_lower }, created: !prior, changes };
    }),
    link: jest.fn(async (db, documentId, linkType, linkId, opts) => { E('document_links.link', { documentId, linkType, linkId, relation: opts && opts.relation, eventSource: opts && opts.eventSource }); return { linked: true, created: true }; }),
    reconcilePathLinks: jest.fn(async (db, documentId, keep) => { E('document_links.reconcile', { documentId, keep }); return 1; }),
    markDeletedByPath: jest.fn(async (db, source, pathLower) => { E('documents.markDeleted', { source, pathLower }); return 1; }),
    getById: jest.fn(async () => null),
    listLinks: jest.fn(async () => []),
  };
});
jest.mock('../services/emailCaseMatchService', () => ({
  ...jest.requireActual('../services/emailCaseMatchService'),   // ownText and the other pure helpers stay real
  matchCase: jest.fn(async () => mockWorld.match),
  isFirmSender: jest.fn(async () => false),
}));
jest.mock('../services/mailbox/mailAttachmentService', () => ({
  ...jest.requireActual('../services/mailbox/mailAttachmentService'),
  fetchPartBuffer: jest.fn(async (db, row, part) => ({ buffer: Buffer.from(`bytes of message ${row.id} part ${part}`), mime: null })),
}));
jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn((db, type, env) => { mockWorld.current.effects.push({ kind: 'event', type, ...mockWorld.scrub({ case_id: env && env.case_id, contact_id: env && env.contact_id, source: env && env.source }) }); }),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

// `mock`-prefixed: jest hoists factories, and only /^mock/ names may be read inside one.
const mockWorld = { current: null, match: null, scrub: require('./helpers/recordingDropbox').scrub };

const W = require('./helpers/storageReplayWorld');
const fake = require('../services/dropboxService').__fake;
const placement = require('../services/filePlacementService');
const caseService = require('../services/caseService');
const generate = require('../services/documentGenerateService');
const formPdf = require('../services/formPdfService');
const esignFiling = require('../services/esignFilingService');
const uploadTarget = require('../services/uploadTargetService');
const emailFiling = require('../services/emailAttachmentFilingService');
const emailComms = require('../services/emailAttachmentCommsService');
const storageFns = require('../lib/internal_functions/storage');
const sync = require('../services/documentSyncService');

const GOLDEN = path.join(__dirname, 'fixtures', 'storageReplay.golden.json');
const STEPS = require('./fixtures/storageReplay.workflowSteps.json');
const WRITE = process.env.STORAGE_GOLDEN_WRITE === '1';
if (WRITE && process.env.CI) throw new Error('STORAGE_GOLDEN_WRITE is refused under CI — the golden is rewritten locally, reviewed, and committed');
const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : { scenarios: {} };
const records = {};

const NOW = new Date('2026-11-17T15:00:00Z');   // 10:00 in Detroit
beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
});
afterAll(() => {
  jest.useRealTimers();
  if (WRITE) {
    const out = { ...golden, scenarios: { ...golden.scenarios, ...records } };
    fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n');
  }
});

const PDF = (tag) => Buffer.from(`%PDF-1.7\n% ${tag}\n`);

/** The 4LSG-shaped tree: active + potential trees, case A's folder (linked), the four bins. */
function seedBase(world, { caseAUnder = 'active' } = {}) {
  const aFolder = caseAUnder === 'active' ? W.CASE_A_FOLDER : W.CASE_A_POTENTIAL_FOLDER;
  const links = fake.seed({
    folders: [
      `${W.ACTIVE_ROOT}/  Active - Bankruptcy`, `${W.POTENTIAL_ROOT}/  Potential - Bankruptcy`,
      aFolder, `${aFolder}/Client Uploads`, `${aFolder}/Docket - John Smith - Ch 13 - 26-44274`,
      `${aFolder}/Drafts - John Smith`, `${aFolder}/Client Docs - John Smith`, `${aFolder}/Correspondence - John Smith`,
      ...Object.values(W.BINS),
    ],
    files: [{ path: `${aFolder}/Client Uploads/2026-06-01 Intake.pdf`, bytes: PDF('intake') }],
    links: [aFolder],
  });
  world.cases.hjSFMabb.case_dropbox = links[aFolder];
  // D3b-1: the bindings as the D3a backfill made them from cases ⨝ case_folder_cache —
  // this world's cache is EMPTY, so a backfilled binding carries the link and no path
  // (the sweep fills paths; ensureCaseDropboxFolder fills them at create time).
  world.entityFolders.hjSFMabb = { external_id: null, path_lower: null, path_display: null, human_link: links[aFolder], resolve_error: null };
  world.entityFolders.deadLnk1 = { external_id: null, path_lower: null, path_display: null, human_link: world.cases.deadLnk1.case_dropbox, resolve_error: null };
  return links[aFolder];
}

let db;
function scenario(name, fn, seedOpts) {
  test(name, async () => {
    fake.reset();
    const world = W.baseFixture();
    mockWorld.current = world;
    mockWorld.match = { case_id: null, contact: null, method: null, candidates: [] };
    db = W.makeDb(world);
    seedBase(world, seedOpts);
    await fn({ db, world });
    const record = { calls: fake.calls.slice(), effects: world.effects.slice(), provider_state: fake.snapshot() };
    records[name] = record;
    if (!WRITE) {
      expect(golden.scenarios[name]).toBeDefined();
      expect(record).toEqual(golden.scenarios[name]);
    }
  });
}

const generateShaped = (over) => ({
  linkType: 'case', linkId: 'hjSFMabb', content: PDF('gen'), fileName: '2026-11-17 Discharge Notice.pdf', subfolder: 'Notices',
  unsortedPathKey: generate.UNSORTED_PATH_KEY, unsortedDefault: generate.DEFAULT_UNSORTED_PATH, unsortedFilenamePrefix: '',
  eventSource: generate.EVENT_SOURCE, taskSource: generate.TASK_SOURCE, logTag: generate.LOG_TAG,
  artifactLabel: 'generated document', binLabel: 'unsorted generated-documents folder', createdBy: 6, ...over,
});

// ── 1. rung 1: a live case folder ────────────────────────────────────────────
scenario('1 placement: live case folder (form-shaped subfolder)', async ({ db }) => {
  await placement.placeAndRegister(db, generateShaped({ subfolder: formPdf.SUBFOLDER, fileName: '2026-11-17 Form 121.pdf',
    unsortedPathKey: formPdf.UNSORTED_PATH_KEY, unsortedDefault: formPdf.DEFAULT_UNSORTED_PATH, taskSource: formPdf.TASK_SOURCE, eventSource: 'form_pdf', logTag: '[FORM PDF]', createdBy: null }));
});

// ── 2. rung 2: no folder → templated create (both stages, the org trim) ──────
scenario('2 placement: no case folder → ensureCaseDropboxFolder (potential, active, org contact)', async ({ db, world }) => {
  await placement.placeAndRegister(db, generateShaped({ linkId: 'k9PotLd2' }));             // potential: {{date}} in the name
  await placement.placeAndRegister(db, generateShaped({ linkId: 'aCtv7Num' }));             // active: staff subfolders
  world.cases.orgCase1.case_number = '26-70001';                                            // active, org contact ends in '.'
  await placement.placeAndRegister(db, generateShaped({ linkId: 'orgCase1' }));
  await caseService.ensureCaseDropboxFolder(db, 'aCtv7Num');                                // idempotent: link already saved
  await caseService.ensureCaseDropboxFolder(db, 'aCtv7Num', { force: true });               // adopt-before-create probe hits
});

// ── 3. rung 3: dead link → the bin's per-case subfolder + move task after upload
scenario('3 placement: dead case link → unsorted per-case folder + move task', async ({ db }) => {
  await placement.placeAndRegister(db, generateShaped({ linkId: 'deadLnk1' }));
  await placement.placeAndRegister(db, generateShaped({ linkId: 'deadLnk1', moveTaskOnUnsortedCase: false }));
  await placement.placeAndRegister(db, generateShaped({ linkId: 'noSuchCs' }));            // case row gone
});

// ── 4. loose rung: contact / appt / unlinked ─────────────────────────────────
scenario('4 placement: contact, appt and unlinked files go loose into the bin', async ({ db }) => {
  const prefix = await placement.identityPrefixFor(db, { linkType: 'contact', linkId: 502 }, '[DOC GEN]');
  await placement.placeAndRegister(db, generateShaped({ linkType: 'contact', linkId: 502, unsortedFilenamePrefix: prefix }));
  await placement.placeAndRegister(db, generateShaped({ linkType: 'appt', linkId: 77, unsortedFilenamePrefix: await placement.identityPrefixFor(db, { linkType: 'appt', linkId: 77 }) }));
  await placement.placeAndRegister(db, generateShaped({ linkType: null, linkId: null }));
  await placement.placeAndRegister(db, generateShaped({ linkType: 'contact', linkId: 502, unsortedSubfolder: 'Emailed 261115 - Smith, John.', linkForRegistration: false }));
});

// ── 5. the generate and form callers' exact argument shapes ──────────────────
scenario('5 placement: documentGenerateService and formPdfService argument shapes', async ({ db }) => {
  await placement.placeAndRegister(db, {
    linkType: 'case', linkId: 'hjSFMabb', content: PDF('gen'), fileName: '2026-11-17 Discharge Notice.pdf', subfolder: 'Notices',
    unsortedPathKey: generate.UNSORTED_PATH_KEY, unsortedDefault: generate.DEFAULT_UNSORTED_PATH,
    unsortedFilenamePrefix: await placement.identityPrefixFor(db, { linkType: 'case', linkId: 'hjSFMabb' }, generate.LOG_TAG),
    eventSource: generate.EVENT_SOURCE, taskSource: generate.TASK_SOURCE, logTag: generate.LOG_TAG,
    artifactLabel: 'generated document', binLabel: 'unsorted generated-documents folder', createdBy: 6,
  });
  await placement.placeAndRegister(db, {
    linkType: 'case', linkId: 'hjSFMabb', content: PDF('form'), fileName: '2026-11-17 Detailed BK Questionnaire.pdf', subfolder: formPdf.SUBFOLDER,
    unsortedPathKey: formPdf.UNSORTED_PATH_KEY, unsortedDefault: formPdf.DEFAULT_UNSORTED_PATH,
    unsortedFilenamePrefix: await formPdf._identityPrefix(db, { link_type: 'case', link_id: 'hjSFMabb', data: {} }),
    eventSource: 'form_pdf', taskSource: formPdf.TASK_SOURCE, logTag: '[FORM PDF]',
    artifactLabel: 'form PDF', binLabel: 'unsorted form-submissions folder', createdBy: null,
  });
});

// ── 6. e-sign: the pair, both rungs, the external document ──────────────────
scenario('6 esign filing: signed pair to the case folder, the unsorted rung, an external document', async ({ db }) => {
  const provider = {
    downloadSignedPdf: async (pid) => PDF(`signed ${pid}`),
    downloadCompletionCertificate: async (pid) => PDF(`cert ${pid}`),
  };
  const req = (over) => ({ id: 31, provider: 'zoho_sign', provider_id: 'ZS-9001', linkable_type: 'case', linkable_id: 'hjSFMabb',
    document_name: 'Retainer Agreement', completed_at: '2026-11-16 09:15:00', signed_pdf_path: null, cert_pdf_path: null, ...over });
  await esignFiling.fileSignedDocuments(db, req(), { provider });
  await esignFiling.fileSignedDocuments(db, req({ id: 32, linkable_id: 'k9PotLd2' }), { provider });   // auto-create
  await esignFiling.fileSignedDocuments(db, req({ id: 33, linkable_id: 'deadLnk1' }), { provider });   // unsorted + identity prefix
  await esignFiling.fileSignedDocuments(db, req({ id: 34, linkable_type: 'contact', linkable_id: 502 }), { provider });
  await esignFiling.fileExternalDocument(db, req({ id: 35 }), { buffer: PDF('external'), completedAt: '2026-11-16 10:00:00' });
});

// ── 7. client upload links ───────────────────────────────────────────────────
scenario('7 uploadTarget: client upload link with, without, and with a dead case folder', async ({ db }) => {
  await uploadTarget.issueClientUploadLink(db, { caseId: 'hjSFMabb', filename: 'W2.pdf' });
  await uploadTarget.issueClientUploadLink(db, { caseId: 'k9PotLd2', filename: 'W2.pdf' });
  await uploadTarget.issueClientUploadLink(db, { caseId: 'deadLnk1', filename: 'W2.pdf' });
  await uploadTarget.inspectUploadDestination(db, 'hjSFMabb');
  await uploadTarget.inspectUploadDestination(db, 'deadLnk1');
  await uploadTarget.unsortedBasePath(db);
});

// ── 9. email attachments: three targets, then a refile ──────────────────────
scenario('9 email attachments: file to case / contact / unsorted, refile to the case, the Comms folder listing', async ({ db, world }) => {
  mockWorld.match = { case_id: null, contact: { contact_id: 501, name: 'John Smith', lfm_name: 'Smith, John' }, method: 'no_open_case', candidates: [] };
  await emailFiling.fileMessageAttachments(db, { ref: { mail_message_id: 9001 }, target: 'case', caseId: 'hjSFMabb', filedBy: 6 });
  world.filings.length = 0;
  await emailFiling.fileMessageAttachments(db, { ref: { mail_message_id: 9001 }, target: 'contact', contactId: 502 });
  const filed = world.filings.map((f) => ({ ...f }));
  world.filings.length = 0;
  await emailFiling.fileMessageAttachments(db, { ref: { mail_message_id: 9001 }, target: 'unsorted' });
  world.filings.length = 0;
  world.filings.push(...filed.map((f) => ({ ...f, dropbox_id: fake.node(f.dropbox_path) && fake.node(f.dropbox_path).id })));
  await emailFiling.refileMessageAttachments(db, { mailMessageId: 9001, caseId: 'hjSFMabb', filedBy: 6 });
  await emailComms.caseFolders(db, 6, { case_id: 'hjSFMabb' });
  await emailComms.caseFolders(db, 6, { case_id: 'k9PotLd2' });
});

// ── 10. the workflow engine's storage_* functions, with the LIVE step params ──
// The fixture is the migrated live shape (D1f-2). The golden for these records
// is D0's: the storage_* functions make the calls the dropbox_* ones made.
const STEP_VALUES = {
  case_dropbox: null, active_path: W.CASE_A_FOLDER, contact_name: 'John Smith', case_subtype: 'Ch 13', case_number: '26-44274', case_id: 'hjSFMabb',
  jf_case_id: 'k9PotLd2', unsorted_path: W.BINS.forms, jf_submission_id: '6400000001', jf_form_id: '250001', JotformKey: 'FIXTURE', jf_filename: 'Detailed BK Questionnaire - Doe, Jane.pdf',
  court_doc_url: 'https://court.example/doc1/0001.pdf', dest_link: null, dbx_path: null,
};
for (const wf of [...new Set(STEPS.steps.map((s) => `${s.workflow_id}:${s.version}`))]) {
  const [workflowId, version] = wf.split(':').map(Number);
  const steps = STEPS.steps.filter((s) => s.workflow_id === workflowId && s.version === version);
  scenario(`10 internal functions: workflow ${workflowId} v${version} steps ${steps.map((s) => s.step_number).join(',')}`, async ({ db, world }) => {
    const seedBodies = (vars) => fake.seed({ saveUrlBodies: {
      [W.substitute('https://www.jotform.com/server.php?action=getSubmissionPDF&sid={{jf_submission_id}}&formID={{jf_form_id}}&apikey={{JotformKey}}', vars)]: PDF('jotform'),
      [vars.court_doc_url]: PDF('court'),
    } });
    const run = async (byName, effects) => {
      const vars = { ...STEP_VALUES, case_dropbox: world.cases.hjSFMabb.case_dropbox };
      seedBodies(vars);
      for (const s of steps) {
        const out = await byName(s, W.substitute(s.params, vars), db);
        const o = out && out.output;
        if (o && o.shared_link) vars.dest_link = o.shared_link;                       // the engine's set_vars
        if (o && o.metadata && o.metadata.path_display) vars.dbx_path = o.metadata.path_display;
        effects.push({ kind: 'step.output', step_id: s.step_id, function_name: s.function_name, ...W.scrub({ output: o }) });
      }
    };
    await run((s, params, d) => storageFns[s.function_name](params, d), world.effects);
  }, { caseAUnder: workflowId === 28 ? 'potential' : 'active' });
}
scenario('10 internal functions: storage_rename, storage_delete, storage_list by path, storage_import_url, a plain storage_ensure_folder (no live workflow uses them)', async ({ db, world }) => {
  const link = world.cases.hjSFMabb.case_dropbox;
  await storageFns.storage_rename({ human_link: link, new_name: ' Smith, John - 26-44274' }, db);
  await storageFns.storage_list({ path: W.BINS.uploads, recursive: true, max_entries: 50 }, db);
  await storageFns.storage_list({ human_link: link, subfolder: 'Client Uploads' }, db);
  await storageFns.storage_delete({ path: `${W.CASE_A_FOLDER.replace(' hjSFMabb - Smith, John - 26-44274 - Ch 13', ' Smith, John - 26-44274')}/Drafts - John Smith` }, db);
  await storageFns.storage_import_url({ url: 'https://example.invalid/slow.pdf', human_link: link, filename: 'slow.pdf', wait: false }, db);
  await storageFns.storage_ensure_folder({ path: `${W.BINS.uploads}/ Plain` }, db);
});

// ── 11. the sync engine's tick: backfill, then incremental with a move + delete
scenario('11 sync engine: backfill page, incremental page with a moved file and a deletion, folder-cache refresh', async ({ db, world }) => {
  const aFolder = fake.node(W.CASE_A_FOLDER);
  Object.assign(world.entityFolders.hjSFMabb, { external_id: aFolder.id, path_lower: aFolder.path_lower, path_display: aFolder.path_display });   // D3b-2: the engine reads the binding (a resolved one, as the sweep leaves it)
  const file = (id, p, size) => ({ '.tag': 'file', id, name: p.slice(p.lastIndexOf('/') + 1), path_display: p, path_lower: p.toLowerCase(), size, rev: `r${id}`, content_hash: `h${id}`, server_modified: '2026-11-10T10:00:00Z' });
  fake.seed({ pages: [
    [{ '.tag': 'folder', id: aFolder.id, name: aFolder.name, path_display: aFolder.path_display, path_lower: aFolder.path_lower },
      file('id:s0001', `${W.CASE_A_FOLDER}/Client Uploads/2026-06-01 Intake.pdf`, 1200),
      file('id:s0002', `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`, 300)],
    [file('id:s0001', `${W.CASE_A_FOLDER}/Client Docs - John Smith/2026-06-01 Intake.pdf`, 1200),
      { '.tag': 'deleted', name: 'loose scan.pdf', path_display: `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`, path_lower: `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ loose scan.pdf`.toLowerCase() }],
  ] });
  const root = { id: 1, path: W.ACTIVE_ROOT, enabled: 1, backfill_done: 0, sync_cursor: null, last_error: null };
  const r1 = await sync.syncRoot(db, root, { maxPages: 1 });
  world.effects.push({ kind: 'sync.result', ...W.scrub({ ...r1, ms: undefined }) });
  const r2 = await sync.syncRoot(db, { ...root, backfill_done: 1, sync_cursor: 'cur:1' }, { maxPages: 5 });
  world.effects.push({ kind: 'sync.result', ...W.scrub({ ...r2, ms: undefined }) });
  const r3 = await sync.refreshCaseFolderCache(db, { caseIds: ['hjSFMabb', 'deadLnk1'] });
  world.effects.push({ kind: 'cache.refresh', ...W.scrub({ ...r3, elapsed_ms: undefined }) });
});

// ── 12. the seam itself: documentSourceService's provider ops over dropboxService
scenario('12 documentSourceService: the dropbox provider\'s stat / tempViewUrl / download / move / rename / remove / ensureSharedLink', async ({ db }) => {
  const sources = require('../services/documentSourceService');
  const p = sources.get('dropbox');
  const fileA = fake.node(`${W.CASE_A_FOLDER}/Client Uploads/2026-06-01 Intake.pdf`);
  await p.stat(db, fileA.id);
  await p.stat(db, fileA.id, { credentialId: 8 });
  await p.tempViewUrl(db, fileA.id);
  await p.download(db, fileA.id);
  await p.ensureSharedLink(db, fileA.id);
  await p.rename(db, fileA.id, ' 2026-06-01 Intake (reviewed).pdf');      // by id: the handle-chop trap the provider works around
  await p.move(db, fileA.id, `${W.CASE_A_FOLDER}/Client Docs - John Smith/2026-06-01 Intake.pdf`);
  await p.remove(db, fileA.id);
  await expect(p.stat(db, 'id:f9999')).rejects.toMatchObject({ status: 409 });
  await expect(p.rename(db, fileA.id, 'a/b')).rejects.toThrow('must not contain');
  expect(sources.list()).toEqual(['dropbox']);
});

// ── 13. D1a: the seam's write / folder / direct-upload / listing ops (no writer uses them yet)
scenario('13 documentSourceService D1a: upload, ensureFolder, directUpload, listChanges by every destination form', async ({ db, world }) => {
  const sources = require('../services/documentSourceService');
  const p = sources.get('dropbox');
  const caseA = fake.node(W.CASE_A_FOLDER);
  const link = world.cases.hjSFMabb.case_dropbox;
  const e = (kind, data) => world.effects.push({ kind, ...W.scrub(data) });
  e('d1a.upload', await p.upload(db, { path: `${W.BINS.uploads}/ loose.pdf` }, PDF('loose')));
  e('d1a.upload', await p.upload(db, { folder: caseA.id, name: ' W2 2025.pdf', subfolder: 'Client Uploads' }, PDF('w2'), { credentialId: 8 }));
  e('d1a.upload', await p.upload(db, { humanLink: link, name: 'Form 121.pdf', subfolder: 'Forms' }, PDF('f121')));
  e('d1a.upload', await p.upload(db, { humanLink: link, name: 'Form 121.pdf', subfolder: 'Forms' }, PDF('f121 again')));   // autorename
  e('d1a.ensureFolder', await p.ensureFolder(db, { path: `${W.POTENTIAL_ROOT}/  Potential - Bankruptcy/ Doe, Jane - k9PotLd2 - 2026-11-17` }, { subfolders: ['Client Uploads'], humanLink: true }));
  e('d1a.ensureFolder', await p.ensureFolder(db, { path: W.CASE_A_FOLDER }, { humanLink: true }));                  // adopted, existing link
  e('d1a.ensureFolder', await p.ensureFolder(db, { parent: caseA.id, name: ' Signed Documents' }, { credentialId: 8 }));
  e('d1a.directUpload', await p.directUpload(db, { humanLink: link, filename: 'Lease.pdf', subfolder: 'Client Uploads' }));
  e('d1a.directUpload', await p.directUpload(db, { folder: caseA.id, filename: 'Lease.pdf', subfolder: 'Client Uploads' }, { durationSec: 900 }));
  e('d1a.directUpload', await p.directUpload(db, { folder: caseA.id, filename: 'Lease.pdf' }));
  e('d1a.directUpload', await p.directUpload(db, { path: W.BINS.uploads, filename: 'Lease.pdf', subfolder: 'deadLnk1 - Lee, Ann' }));
  const first = await p.listChanges(db, { root: W.ACTIVE_ROOT, limit: 2000 });
  e('d1a.listChanges', { ...first, entries: first.entries.map((x) => x.path_display) });
  const next = await p.listChanges(db, { cursor: first.cursor });
  e('d1a.listChanges', { ...next, entries: next.entries.length });
  e('d1d2.list', await p.list(db, { path: W.CASE_A_FOLDER.toLowerCase() }, { max: 2000 }, { credentialId: 8 }));          // alignCaseFolder's call
  e('d1d2.list', await p.list(db, { path: W.CASE_A_FOLDER }, { recursive: true, max: 4000 }, { credentialId: 8 }));          // the Comms picker's call
  e('d1d2.list', await p.list(db, { humanLink: link }, {}));
  e('d1d2.list', await p.list(db, { folder: caseA.id }, { recursive: true }));
  const intake = fake.node(`${W.CASE_A_FOLDER}/Client Uploads/2026-06-01 Intake.pdf`).id;
  await expect(p.ensureFolder(db, { parent: intake, name: 'x' })).rejects.toThrow('is not a folder');
  e('d1d2.move', await p.move(db, intake, `${W.CASE_A_FOLDER}/Forms/Form 121.pdf`, { credentialId: 8, autorename: true }));   // a collision → "(1)"
  fake.seed({ saveUrlBodies: { 'https://court.example/doc1/0007.pdf': PDF('court7') } });
  e('d1f.importUrl', await p.importUrl(db, { humanLink: link, name: ' Order.pdf', subfolder: 'court docs' }, 'https://court.example/doc1/0007.pdf', { wait: true, timeoutMs: 90000 }));
  e('d1f.importUrl', await p.importUrl(db, { path: `${W.BINS.uploads}/ slow.pdf` }, 'https://example.invalid/slow.pdf', { wait: false }));
  e('d1g.download', { bytes: (await p.download(db, { humanLink: fake.linkFor(`${W.CASE_A_FOLDER}/Forms/Form 121.pdf`) }, { credentialId: 8 })).buffer.length });
  e('d1a.declarations', { capabilities: p.capabilities, nameRules: { ...p.nameRules, validateName: undefined } });
});

// ── 15. D1g readers: registering what a browser landed in a folder (docReq / portal) ──
scenario('15 documentIngestService.registerLandedInFolder: by folder path and by human link, the landing window', async ({ db, world }) => {
  const ingest = jest.requireActual('../services/documentIngestService');
  fake.simulateUpload(`${W.CASE_A_FOLDER}/Client Uploads/W2.pdf`, '%PDF w2');
  fake.simulateUpload(`${W.CASE_A_FOLDER}/Client Uploads/Lease.pdf`, '%PDF lease');
  const link = world.cases.hjSFMabb.case_dropbox;
  // the fake's clock sits at 12:00Z; the test's now is 15:00Z, so the default 2 h window sees nothing — once with a 24 h window, once with the default
  const a = await ingest.registerLandedInFolder(db, { sharedLink: link, subfolder: 'Client Uploads', links: [{ type: 'case', id: 'hjSFMabb' }], createdBy: 6, eventSource: 'upload', sinceMs: 24 * 3600 * 1000 });
  const b = await ingest.registerLandedInFolder(db, { folderPath: `${W.CASE_A_FOLDER}/Client Uploads`, links: [{ type: 'case', id: 'hjSFMabb' }], credentialId: 8 });
  const c = await ingest.registerLandedInFolder(db, { sharedLink: 'https://www.dropbox.com/scl/fo/gone0000?dl=0', links: [] });
  world.effects.push({ kind: 'landed', ...W.scrub({ a: { scanned: a.scanned, registered: a.registered }, b: { scanned: b.scanned, registered: b.registered }, c }) });
});

// ── 16. D3b-1: the binding is the filing paths' word ─────────────────────────
scenario('16 D3b-1 entity_folders is what the filing paths read: the binding\'s link beats a stale legacy column; a legacy-only link still files', async ({ db, world }) => {
  // case A: the legacy column points at a dead link, the binding at the live folder → the live folder is used (placement + upload link + e-sign target + the Comms listing)
  world.cases.hjSFMabb.case_dropbox = 'https://www.dropbox.com/scl/fo/stale000?dl=0';
  await placement.placeAndRegister(db, generateShaped({}));
  await uploadTarget.issueClientUploadLink(db, { caseId: 'hjSFMabb', filename: 'W2.pdf' });
  world.effects.push({ kind: 'esign.target', ...W.scrub(await esignFiling.resolveTarget(db, { linkable_type: 'case', linkable_id: 'hjSFMabb' })) });
  world.effects.push({ kind: 'comms.folders', ...W.scrub(await emailComms.caseFolders(db, 6, { case_id: 'hjSFMabb' })) });
  // case C: a legacy link and NO binding (a link written before D3a's backfill ran, or by hand through a path that never bound) → the column still files; no folder is created
  const cFolder = `${W.ACTIVE_ROOT}/  Active - Bankruptcy/ aCtv7Num - Brown, Bob - 26-50001 - Ch 7`;
  const cLinks = fake.seed({ folders: [cFolder, `${cFolder}/Notices`], links: [cFolder] });
  world.cases.aCtv7Num.case_dropbox = cLinks[cFolder];
  await placement.placeAndRegister(db, generateShaped({ linkId: 'aCtv7Num' }));
  // (the relation decision — _relationFor on the binding's path — sits behind the recorded registerWrittenSafe boundary here; the real-engine twin proves it)
  world.effects.push({ kind: 'bindings', ...W.scrub({ entityFolders: world.entityFolders }) });
});

// ── 17. D3c-1: storage_folders.case is the templates' new home ──────────────
const LIVE_TEMPLATES = require('./fixtures/storageSeamD3c.templates.before.json');   // 4LSG's live dropbox_case_folder_templates row, frozen for the seed script
async function foldersFromTemplates({ db, world }) {
  await caseService.ensureCaseDropboxFolder(db, 'k9PotLd2');                                // potential
  await caseService.ensureCaseDropboxFolder(db, 'aCtv7Num');                                // active: Bankruptcy:Chapter 7 is NOT a key of the live row ("Chapter 7" vs "Ch 7") → default template
  world.cases.orgCase1.case_number = '26-70001'; world.cases.orgCase1.case_subtype = 'Chapter 13'; world.cases.orgCase1.case_type = 'Bankruptcy';
  await caseService.ensureCaseDropboxFolder(db, 'orgCase1');                                // active: the per-type template "Bankruptcy:Chapter 13" of the live row
}
scenario('17a D3c-3 a leftover dropbox_case_folder_templates row is IGNORED: the code default makes the folders (the key is retired)', async (w) => {
  w.world.settings.dropbox_case_folder_templates = JSON.stringify(LIVE_TEMPLATES);   // a row nothing reads any more
  await foldersFromTemplates(w);
});
scenario('17b D3c-1 the same row as storage_folders.case with the legacy key gone (D3c-3\'s state) — byte-identical provider calls', async (w) => {
  w.world.settings.storage_folders = JSON.stringify({ case: LIVE_TEMPLATES, contact: null });
  await foldersFromTemplates(w);
});
scenario('17c D3c-1 {{case_type_full}} in a template: type + subtype, type alone, no type → "unknown"', async ({ db, world }) => {
  world.settings.storage_folders = JSON.stringify({ case: {
    potential: { default: `${W.POTENTIAL_ROOT}/ {{case_type_full}} - {{case_id}}`, subfolders: [] },
    active:    { default: `${W.ACTIVE_ROOT}/ {{case_type_full}} - {{case_id}}`, subfolders: [] },
  }, contact: null });
  await caseService.ensureCaseDropboxFolder(db, 'aCtv7Num');                                // Bankruptcy: Ch 7
  await caseService.ensureCaseDropboxFolder(db, 'k9PotLd2');                                // Bankruptcy (no subtype)
  world.cases.orgCase1.case_type = ''; world.cases.orgCase1.case_subtype = '';
  await caseService.ensureCaseDropboxFolder(db, 'orgCase1');                                // unknown
});

// ── 18. D3c-2: contact folders on the PLATFORM default tree (a tenant that is not 4LSG) ──
scenario('18 D3c-2 the platform-default tree: a contact-linked file makes and uses the contact folder; a case folder nests under it via {{contact_folder}}; the contact binding is reused; contact: null refuses a template that names it', async ({ db, world }) => {
  const { STORAGE_DEFAULTS } = require('../lib/storageDefaults');
  world.settings.storage_folders = JSON.stringify(STORAGE_DEFAULTS.storage_folders);   // the row provisioning writes for a new firm
  fake.seed({ folders: ['/Clients'] });
  // a contact-linked generated document → /Clients/Doe, Jane (created, bound) / Notices / file; no task; placement 'contact'
  const v1 = await placement.placeAndRegister(db, generateShaped({ linkType: 'contact', linkId: 502 }));
  world.effects.push({ kind: 'verdict', ...W.scrub({ placement: v1.placement, path: v1.path, warnings: v1.warnings }) });
  // the same contact again → the binding is reused (no second create / probe of the contact folder)
  const v2 = await placement.placeAndRegister(db, generateShaped({ linkType: 'contact', linkId: 502, fileName: '2026-11-17 Second.pdf' }));
  world.effects.push({ kind: 'verdict', ...W.scrub({ placement: v2.placement, path: v2.path, warnings: v2.warnings }) });
  // Casey's read-only preview: the bound contact → rung 'contact'; an unbound contact → 'contact_create' (nothing created)
  world.effects.push({ kind: 'describe', ...W.scrub(await placement.describePlacement(db, { linkType: 'contact', linkId: 502, subfolder: 'Notices', unsortedPathKey: generate.UNSORTED_PATH_KEY, unsortedDefault: generate.DEFAULT_UNSORTED_PATH })) });
  world.effects.push({ kind: 'describe', ...W.scrub(await placement.describePlacement(db, { linkType: 'contact', linkId: 503, subfolder: 'Notices', unsortedPathKey: generate.UNSORTED_PATH_KEY, unsortedDefault: generate.DEFAULT_UNSORTED_PATH })) });
  // a case of that contact: {{contact_folder}}/{{number}} - {{case_type_full}} → /Clients/Doe, Jane/k9PotLd2 - Bankruptcy (potential: number = case_id); the contact binding reused
  const made = await caseService.ensureCaseDropboxFolder(db, 'k9PotLd2');
  world.effects.push({ kind: 'case.folder', ...W.scrub({ path: made.path, existed: made.existed }) });
  // a case whose contact has no folder yet: the contact folder is created on the way (Brown, Bob → aCtv7Num, active: 26-50001-lsg - Bankruptcy: Ch 7)
  const made2 = await caseService.ensureCaseDropboxFolder(db, 'aCtv7Num');
  world.effects.push({ kind: 'case.folder', ...W.scrub({ path: made2.path, existed: made2.existed }) });
  world.effects.push({ kind: 'bindings', ...W.scrub({ entityFolders: world.entityFolders }) });
  // contact: null with a case template that names {{contact_folder}} → refused, named; a contact-linked file with contact folders off → the bin, no provider probe
  world.settings.storage_folders = JSON.stringify({ case: STORAGE_DEFAULTS.storage_folders.case, contact: null });
  let refused = null;
  try { await caseService.ensureCaseDropboxFolder(db, 'orgCase1'); } catch (err) { refused = err.message; }
  world.effects.push({ kind: 'refused', refused });
  const v3 = await placement.placeAndRegister(db, generateShaped({ linkType: 'contact', linkId: 504 }));
  world.effects.push({ kind: 'verdict', ...W.scrub({ placement: v3.placement, path: v3.path, warnings: v3.warnings }) });
});

// ── coverage: every provider function a writer can reach is recorded somewhere
test('coverage: every dropboxService export is hit by a scenario here or in the routes golden, or is a listed exclusion', () => {
  const actual = jest.requireActual('../services/dropboxService');
  const PURE = ['normalizePath', 'joinPath', 'httpHeaderSafeJson', 'isCursorResetError', 'isPathNotFoundError', 'isTransientError'];
  const INTERNAL = ['_rpc', 'createSubfolders', 'checkSaveUrlJob'];   // composed inside dropboxService; no writer calls them
  const ROUTES_GOLDEN = path.join(__dirname, 'fixtures', 'storageReplay.routes.golden.json');
  const routes = fs.existsSync(ROUTES_GOLDEN) ? JSON.parse(fs.readFileSync(ROUTES_GOLDEN, 'utf8')) : { scenarios: {} };
  const source = WRITE ? records : golden.scenarios;
  const hit = new Set();
  for (const s of [...Object.values(source), ...Object.values(routes.scenarios)]) for (const c of s.calls) hit.add(c.fn);
  const missing = Object.keys(actual).filter((n) => typeof actual[n] === 'function' && !PURE.includes(n) && !INTERNAL.includes(n) && !hit.has(n));
  expect(missing).toEqual([]);
});
