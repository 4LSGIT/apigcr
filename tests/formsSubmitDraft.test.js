// tests/formsSubmitDraft.test.js
//
/**
 * POST /api/forms/submissions/submit-draft — the form page's Submit chain run
 * server-side (services/formSubmitService.js). The REAL route and the REAL
 * service, over mocked writers (formService, caseService, contactService,
 * logService, start_workflow) and a mocked auth gate; extFormService (the
 * validator and value registry) stays real. The real-engine twin is
 * tests/formsSubmitDraft.mysql.test.js.
 *
 * Locked here:
 *   - the page's ORDER: draft → template → record read → docket guard → patch
 *     → submit → draft delete → workflow starts → log;
 *   - every refusal and where it stops (nothing after it runs): bad body, an
 *     API key, missing / non-draft, the precondition, link type, schema
 *     version, validation (field named by key and label), a patch target the
 *     server cannot stand in for, the writer's own refusal;
 *   - the patch is the page's diff against the record's CURRENT row: changed ∧
 *     save-column ∧ not readonly, under the column, a blank date as null, a
 *     mask's formatting not a change; an unchanged form skips the patch and
 *     still submits; snapshot mode diffs against the latest submission;
 *   - each post-submit outcome reported, none failing the request;
 *   - yc-sync announces the form marker plus the record's diff.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

let mockAuth = { type: 'jwt', userId: 6 };
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = mockAuth; next(); });
jest.mock('../services/formService', () => ({
  getSubmission: jest.fn(), getLatest: jest.fn(), submitForm: jest.fn(), deleteDraft: jest.fn(),
}));
jest.mock('../services/formTemplateService', () => ({
  ...jest.requireActual('../services/formTemplateService'), getPublishedByKey: jest.fn(),
}));
jest.mock('../services/caseService', () => ({ getCase: jest.fn(), updateCase: jest.fn(), docketWriteRefusal: jest.fn() }));
jest.mock('../services/contactService', () => ({ getContact: jest.fn(), updateContact: jest.fn() }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn() }));
jest.mock('../services/optoutService', () => ({ consentActor: jest.fn((a) => ({ kind: 'user', userId: a.userId })) }));
jest.mock('../lib/internal_functions', () => ({ start_workflow: jest.fn() }));

const formService = require('../services/formService');
const formTemplateService = require('../services/formTemplateService');
const caseService = require('../services/caseService');
const contactService = require('../services/contactService');
const logService = require('../services/logService');
const internalFunctions = require('../lib/internal_functions');
const { pageValue } = require('../services/formSubmitService');

const DB = { tag: 'pool' };
const URL_PATH = '/api/forms/submissions/submit-draft';

function call(body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = DB; next(); });
  app.use(require('../routes/api.forms'));
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: URL_PATH, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const DEF = () => ({
  dataMode: 'live',
  endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}?include=clients', path: 'case' } },
  onSubmit: {
    patch: { method: 'PATCH', url: '/api/cases/{linkId}' },
    workflows: [{ id: 41, initData: { notify_to: 'ops', form_key: 'spoofed' } }, { id: 42 }],
    pdf: true,
  },
  sections: [{ title: 'S', rows: [{ fields: [
    { name: 'trustee', type: 'text', label: 'Trustee', apiColumn: 'case_trustee', required: true },
    { name: 'filed', type: 'date', label: 'Filed', apiColumn: 'case_file_date' },
    { name: 'closed', type: 'date', label: 'Closed', apiColumn: 'case_close_date' },
    { name: 'chapter', type: 'select', label: 'Chapter', apiColumn: 'case_chapter', options: ['7', '13'] },
    { name: 'phone', type: 'text', label: 'Phone', mask: 'phone', apiColumn: 'case_phone' },
    { name: 'judge', type: 'text', label: 'Judge', apiColumn: 'case_judge', readonly: true },
    { name: 'stage', type: 'text', label: 'Stage', apiColumn: { load: 'case_stage', save: 'case_stage_note' } },
    { name: 'notes', type: 'textarea', label: 'Notes' },
  ] }] }],
});
const RECORD = () => ({ case: {
  case_id: 'CASE1', case_trustee: 'Old Trustee', case_file_date: new Date('2026-01-05T00:00:00Z'),
  case_close_date: new Date('2026-02-01T00:00:00Z'), case_chapter: '7', case_phone: '(313) 555-1234',
  case_judge: 'Judge A', case_stage: 'Open', case_stage_note: 'ignored',
}, clients: [] });
const DATA = () => ({
  trustee: 'New Trustee', filed: '2026-01-05', closed: '', chapter: '13', phone: '3135551234',
  judge: 'Judge B', stage: 'Filed', notes: 'line one',
});
const UPDATED = new Date('2026-11-10T15:04:05Z');
const DRAFT = (over = {}) => ({ id: 88, form_key: 'case_info', link_type: 'case', link_id: 'CASE1', status: 'draft',
  version: 0, schema_version: 3, data: DATA(), updated_at: UPDATED, ...over });
const TPL = (over = {}) => ({ title: 'Case Info', link_type: 'case', schema_version: 3, definition: DEF(), ...over });

let order;
function wire({ draft = DRAFT(), tpl = TPL(), record = RECORD() } = {}) {
  order = [];
  const step = (name, impl) => jest.fn(async (...a) => { order.push(name); return impl(...a); });
  formService.getSubmission.mockImplementation(step('getSubmission', async () => draft));
  formTemplateService.getPublishedByKey.mockImplementation(step('getPublishedByKey', async () => tpl));
  caseService.getCase.mockImplementation(step('getCase', async () => record));
  caseService.docketWriteRefusal.mockImplementation(step('docketWriteRefusal', async () => null));
  caseService.updateCase.mockImplementation(step('updateCase', async (_db, id, fields) => ({
    case_id: id, updated_fields: Object.keys(fields),
    changes: Object.fromEntries(Object.keys(fields).map((k) => [k, { from: 'x', to: fields[k] }])) })));
  formService.getLatest.mockImplementation(step('getLatest', async () => ({ submitted: null, draft: null })));
  formService.submitForm.mockImplementation(step('submitForm', async () => ({ id: 501, version: 4, updated_at: UPDATED })));
  formService.deleteDraft.mockImplementation(step('deleteDraft', async () => ({ deleted: true })));
  internalFunctions.start_workflow.mockImplementation(step('start_workflow', async (p) => ({ success: true, output: { workflow_execution_id: 900 + p.workflow_id } })));
  logService.createLogEntry.mockImplementation(step('createLogEntry', async () => ({ log_id: 7001 })));
  contactService.getContact.mockImplementation(step('getContact', async () => ({ contact: { contact_id: 77, contact_fname: 'Dana', contact_email: 'a@b.co' } })));
  contactService.updateContact.mockImplementation(step('updateContact', async (_db, _id, fields) => ({ contact_id: 77, updated_fields: Object.keys(fields), changes: {} })));
}

beforeEach(() => { mockAuth = { type: 'jwt', userId: 6 }; jest.clearAllMocks(); wire(); });

const WRITES = ['docketWriteRefusal', 'updateCase', 'updateContact', 'submitForm', 'deleteDraft', 'start_workflow', 'createLogEntry'];
const wrote = () => order.filter((s) => WRITES.includes(s));

// ── The chain ───────────────────────────────────────────────────────────────

describe('the chain, in the page\'s order', () => {
  test('a changed case form: patch from the record\'s current row, submit, delete, start, log', async () => {
    const res = await call({ submission_id: 88, expected_updated_at: UPDATED.toISOString() });
    expect(res.status).toBe(200);
    expect(order).toEqual(['getSubmission', 'getPublishedByKey', 'getCase', 'docketWriteRefusal', 'updateCase',
      'submitForm', 'deleteDraft', 'start_workflow', 'start_workflow', 'createLogEntry']);

    // The load GET's own service call, include passed through.
    expect(caseService.getCase.mock.calls[0].slice(0, 3)).toEqual([DB, 'CASE1', 'clients']);
    // Changed ∧ save column ∧ not readonly: the trustee, the chapter, the cleared
    // close date as NULL, the {load,save} field under its SAVE column. Not: the
    // unchanged filed date (a Date vs its ISO day), the phone whose only
    // difference is the mask's formatting, the readonly judge, the column-less notes.
    const patch = { case_trustee: 'New Trustee', case_close_date: null, case_chapter: '13', case_stage_note: 'Filed' };
    expect(caseService.docketWriteRefusal.mock.calls[0]).toEqual([DB, 'CASE1', patch]);
    expect(caseService.updateCase.mock.calls[0]).toEqual([DB, 'CASE1', patch, { userId: 6, source: 'manual' }]);

    // The draft's data AS STORED, under the published schema version, by the caller.
    expect(formService.submitForm.mock.calls[0]).toEqual([DB, 'case_info', 'case', 'CASE1', 3, DATA(), 6]);
    expect(formService.deleteDraft.mock.calls[0]).toEqual([DB, 'case_info', 'case', 'CASE1']);

    // initData: values, then the entry's initData, then the system fields (which win).
    const [p1, db1] = internalFunctions.start_workflow.mock.calls[0];
    expect(db1).toBe(DB);
    expect(p1).toEqual({ workflow_id: 41, init_data: { ...DATA(), notify_to: 'ops', form_key: 'case_info',
      form_title: 'Case Info', link_type: 'case', link_id: 'CASE1', submission_id: 501, make_pdf: true, _values: DATA() } });
    expect(Object.keys(p1)).toEqual(['workflow_id', 'init_data']);   // no contact override (the page sends none)
    expect(internalFunctions.start_workflow.mock.calls[1][0].workflow_id).toBe(42);

    // The page's log entry, by the caller; changes = getDiff over EVERY field.
    const [dbL, entry] = logService.createLogEntry.mock.calls[0];
    expect(dbL).toBe(DB);
    expect({ ...entry, data: undefined }).toEqual({ type: 'form', link_type: 'case', link_id: 'CASE1', by: 6, data: undefined });
    const logged = JSON.parse(entry.data);
    expect(Object.keys(logged)).toEqual(['form_key', 'action', 'version', 'changes']);
    expect([logged.form_key, logged.action, logged.version]).toEqual(['case_info', 'form_submit', 4]);
    expect(JSON.parse(logged.changes)).toEqual({
      trustee: ['Old Trustee', 'New Trustee'], closed: ['2026-02-01', ''], chapter: ['7', '13'],
      judge: ['Judge A', 'Judge B'], stage: ['Open', 'Filed'], notes: ['', 'line one'],
    });

    expect(res.body).toEqual({
      status: 'success', submission: { id: 501, version: 4, updated_at: UPDATED.toISOString() },
      form_key: 'case_info', link_type: 'case', link_id: 'CASE1',
      patch_target: { type: 'case', id: 'CASE1' },
      patched: ['case_trustee', 'case_close_date', 'case_chapter', 'case_stage_note'],
      changes: {
        case_trustee: { from: 'x', to: 'New Trustee' }, case_close_date: { from: 'x', to: null },
        case_chapter: { from: 'x', to: '13' }, case_stage_note: { from: 'x', to: 'Filed' },
      },
      draft_deleted: true,
      workflows: [{ id: 41, started: true, execution_id: 941 }, { id: 42, started: true, execution_id: 942 }],
      log_id: 7001,
    });
  });

  test('NO CHANGES STILL SUBMITS: a draft equal to the record skips the patch only', async () => {
    const same = { trustee: 'Old Trustee', filed: '2026-01-05', closed: '2026-02-01', chapter: '7',
      phone: '3135551234', judge: 'Judge A', stage: 'Open', notes: '' };
    wire({ draft: DRAFT({ data: same }) });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(200);
    expect(order).toEqual(['getSubmission', 'getPublishedByKey', 'getCase', 'submitForm', 'deleteDraft',
      'start_workflow', 'start_workflow', 'createLogEntry']);
    expect([res.body.patched, res.body.changes, res.body.patch_target]).toEqual([[], {}, null]);
    expect(JSON.parse(JSON.parse(logService.createLogEntry.mock.calls[0][1].data).changes)).toEqual({});
  });

  test('a form with no onSubmit.patch reads the record for the log diff and writes nothing to it', async () => {
    const def = DEF(); delete def.onSubmit.patch;
    wire({ tpl: TPL({ definition: def }) });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(200);
    expect(wrote()).toEqual(['submitForm', 'deleteDraft', 'start_workflow', 'start_workflow', 'createLogEntry']);
    expect(res.body.patched).toEqual([]);
  });

  test('SNAPSHOT mode diffs against the latest SUBMISSION, not the record', async () => {
    const def = DEF(); def.dataMode = 'snapshot';
    wire({ tpl: TPL({ definition: def }) });
    formService.getLatest.mockImplementation(async () => {
      order.push('getLatest');
      return { submitted: { data: JSON.stringify({ ...DATA(), chapter: '7' }) }, draft: null };
    });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(200);
    expect(formService.getLatest.mock.calls[0]).toEqual([DB, 'case_info', 'case', 'CASE1']);
    expect(caseService.updateCase.mock.calls[0][2]).toEqual({ case_chapter: '13' });
  });

  test('a contact form patches through updateContact with the caller as actor, never force', async () => {
    const def = DEF();
    def.endpoints.load = { url: '/api/contacts/{linkId}', path: 'contact' };
    def.onSubmit = { patch: { url: '/api/contacts/{linkId}' } };
    def.sections[0].rows[0].fields = [
      { name: 'first', type: 'text', label: 'First', apiColumn: 'contact_fname' },
      { name: 'email', type: 'text', label: 'Email', apiColumn: 'contact_email' },
    ];
    wire({ draft: DRAFT({ link_type: 'contact', link_id: '77', data: { first: 'Dana', email: 'new@b.co' } }),
      tpl: TPL({ link_type: 'contact', definition: def }) });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(200);
    expect(contactService.getContact.mock.calls[0].slice(0, 3)).toEqual([DB, '77', '']);
    expect(contactService.updateContact.mock.calls[0]).toEqual([DB, '77', { contact_email: 'new@b.co' },
      { userId: 6, force: false, consentActor: { kind: 'user', userId: 6 } }]);
    expect(caseService.updateCase).not.toHaveBeenCalled();
  });
});

// ── Refusals — each stops the chain where it stands ─────────────────────────

describe('refusals', () => {
  test('an API key is refused 403 before anything is read', async () => {
    mockAuth = { type: 'api_key', key_label: 'zapier' };
    const res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([403, 'Submitting a draft requires a signed-in user']);
    expect(order).toEqual([]);
  });

  test('a bad body: unknown key, missing / non-integer id, an unparseable precondition', async () => {
    for (const [body, msg] of [
      [{ submission_id: 88, data: {} }, 'unexpected body key "data"'],
      [{}, 'submission_id must be a positive integer'],
      [{ submission_id: '8.5' }, 'submission_id must be a positive integer'],
      [{ submission_id: 88, expected_updated_at: 'yesterday' }, 'expected_updated_at is not a date'],
    ]) {
      const res = await call(body);
      expect([res.status, res.body.message]).toEqual([400, msg]);
    }
    expect(order).toEqual([]);
  });

  test('missing → 404; a submitted row is not a draft → 404', async () => {
    formService.getSubmission.mockImplementation(async () => { order.push('getSubmission'); throw Object.assign(new Error('Submission 88 not found'), { status: 404 }); });
    let res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([404, 'Draft 88 not found']);
    wire({ draft: DRAFT({ status: 'submitted', version: 2 }) });
    res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([404, 'Submission 88 is not a draft (it is submitted)']);
    expect(order).toEqual(['getSubmission']);
  });

  test('THE PRECONDITION: a draft saved since it was read → 409 naming its updated_at; the same instant passes', async () => {
    let res = await call({ submission_id: 88, expected_updated_at: '2026-11-10T15:04:04.000Z' });
    expect([res.status, res.body.updated_at]).toEqual([409, UPDATED.toISOString()]);
    expect(res.body.message).toMatch(/was saved again since it was read/);
    expect(order).toEqual(['getSubmission']);
    wire();
    res = await call({ submission_id: 88, expected_updated_at: '2026-11-10T15:04:05Z' });
    expect(res.status).toBe(200);
  });

  test('no published template → 404; another link type → 409; another schema version → 409 naming both', async () => {
    wire({ tpl: null });
    let res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([404, 'No published template for form_key "case_info"']);
    wire({ tpl: TPL({ link_type: 'contact' }) });
    res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([409, 'Form "case_info" is a contact-linked form — draft 88 is linked to a case']);
    wire({ draft: DRAFT({ schema_version: 2 }) });
    res = await call({ submission_id: 88 });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Draft 88 was saved on version 2 of this form; the published form is version 3 — re-save the draft on the current version first');
    expect([res.body.draft_schema_version, res.body.schema_version]).toEqual([2, 3]);
    expect(wrote()).toEqual([]);
  });

  test('VALIDATION: the external route\'s validator; the 400 names the field by key and label; nothing written', async () => {
    wire({ draft: DRAFT({ data: { ...DATA(), trustee: '' } }) });
    let res = await call({ submission_id: 88 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('values.trustee is required');
    expect(res.body.fields).toEqual([{ key: 'trustee', label: 'Trustee', message: 'values.trustee is required' }]);
    wire({ draft: DRAFT({ data: { ...DATA(), chapter: '11' } }) });
    res = await call({ submission_id: 88 });
    expect([res.status, res.body.fields[0].label]).toEqual([400, 'Chapter']);
    wire({ draft: DRAFT({ data: { ...DATA(), stray: 'x' } }) });
    res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([400, 'values.stray is not a field of this form']);
    expect(wrote()).toEqual([]);
  });

  test('draft data that is not an object → 422', async () => {
    wire({ draft: DRAFT({ data: '[1,2]' }) });
    const res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([422, 'Draft 88 does not hold a JSON object']);
  });

  test('a patch or load target the server cannot stand in for → 422 before any write', async () => {
    for (const mut of [
      (d) => { d.onSubmit.patch = { method: 'PATCH', url: '/api/appts/{linkId}' }; },
      (d) => { d.onSubmit.patch = { method: 'PUT', url: '/api/cases/{linkId}' }; },
      (d) => { d.onSubmit.patch = { url: '/api/contacts/{linkId}?force=true' }; },
      (d) => { d.endpoints.load = { url: '/api/cases/{linkId}/summary' }; },
    ]) {
      const def = DEF(); mut(def);
      wire({ tpl: TPL({ definition: def }) });
      const res = await call({ submission_id: 88 });
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/is not one the server can (apply|read)/);
      expect(wrote()).toEqual([]);
    }
  });

  test('THE WRITER REFUSES: the docket guard\'s 409 / updateCase\'s 400 stop the chain — nothing submitted', async () => {
    caseService.docketWriteRefusal.mockImplementation(async () => { order.push('docketWriteRefusal');
      return { status: 409, message: 'Case number held by B', conflict: { case_id: 'B' } }; });
    let res = await call({ submission_id: 88 });
    expect([res.status, res.body.message, res.body.conflict]).toEqual([409, 'Case number held by B', { case_id: 'B' }]);
    expect(wrote()).toEqual(['docketWriteRefusal']);
    wire();
    caseService.updateCase.mockImplementation(async () => { order.push('updateCase');
      throw Object.assign(new Error('case_notes is too long'), { status: 400 }); });
    res = await call({ submission_id: 88 });
    expect([res.status, res.body.message]).toEqual([400, 'case_notes is too long']);
    expect(wrote()).toEqual(['docketWriteRefusal', 'updateCase']);
  });
});

// ── Partial outcomes ────────────────────────────────────────────────────────

describe('post-submit outcomes are reported, never fatal', () => {
  test('a failed draft delete, one failed workflow and a failed log still answer 200, each named', async () => {
    formService.deleteDraft.mockImplementation(async () => { order.push('deleteDraft'); throw new Error('lock wait'); });
    internalFunctions.start_workflow.mockImplementationOnce(async () => { order.push('start_workflow'); throw new Error('start_workflow: workflow #41 is inactive'); });
    logService.createLogEntry.mockImplementation(async () => { order.push('createLogEntry'); throw new Error('log down'); });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(200);
    expect(order.slice(-4)).toEqual(['deleteDraft', 'start_workflow', 'start_workflow', 'createLogEntry']);
    expect([res.body.draft_deleted, res.body.draft_delete_error]).toEqual([false, 'lock wait']);
    expect(res.body.workflows).toEqual([
      { id: 41, started: false, error: 'start_workflow: workflow #41 is inactive' },
      { id: 42, started: true, execution_id: 942 },
    ]);
    expect([res.body.log_id, res.body.log_error]).toEqual([null, 'log down']);
  });

  test('a submit failure AFTER the patch is a 500 naming the columns already written', async () => {
    formService.submitForm.mockImplementation(async () => { order.push('submitForm'); throw new Error('deadlock'); });
    const res = await call({ submission_id: 88 });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('The record was updated (case_trustee, case_close_date, case_chapter, case_stage_note) but the submission was not recorded: deadlock');
    expect(res.body.patched).toEqual(['case_trustee', 'case_close_date', 'case_chapter', 'case_stage_note']);
    expect(wrote()).toEqual(['docketWriteRefusal', 'updateCase', 'submitForm']);
  });
});

// ── pageValue — populate() then collect() ───────────────────────────────────

describe('pageValue', () => {
  test('control by control', () => {
    expect(pageValue({ type: 'date' }, '2026-01-05T00:00:00.000Z')).toBe('2026-01-05');
    expect(pageValue({ type: 'date' }, '1/5/2026')).toBe('');
    expect(pageValue({ type: 'datetime' }, '2026-01-05T14:30:00.000Z')).toBe('2026-01-05T14:30');
    expect(pageValue({ type: 'number' }, 5)).toBe('5');
    expect(pageValue({ type: 'number' }, '5 apples')).toBe('');
    expect(pageValue({ type: 'select', options: ['7', { value: '13', label: 'Thirteen' }] }, 13)).toBe('13');
    expect(pageValue({ type: 'select', options: ['7'] }, '11')).toBe('');
    expect(pageValue({ type: 'select', options: ['7'], optionsFrom: { source: 'x' } }, '11')).toBe('11');
    expect(pageValue({ type: 'radio', options: ['a'] }, 'b')).toBe('');
    expect(pageValue({ type: 'checkgroup', options: ['a', 'b', 'c'] }, 'c, a,zz')).toBe('a,c');
    expect(pageValue({ type: 'checkgroup', options: ['a', 'b'], allowOther: true }, 'zz,b,yy')).toBe('b,zz, yy');
    expect(pageValue({ type: 'tags' }, ' x , ,y')).toBe('x,y');
    expect(pageValue({ type: 'textarea' }, 'a\r\nb')).toBe('a\nb');
    expect(pageValue({ type: 'text' }, 'a\r\nb')).toBe('ab');
    expect(pageValue({ type: 'text', mask: 'phone' }, '(313) 555-1234')).toBe('3135551234');
    expect(pageValue({ type: 'text', mask: 'currency' }, '1234.5')).toBe('1234.50');
    expect(pageValue({ type: 'text' }, null)).toBe('');
    expect([true, 1, '1', 'true', false, 0, '0', 'false', '', null].map((v) => pageValue({ type: 'checkbox' }, v)))
      .toEqual([true, true, true, true, false, false, false, false, false, false]);
  });
});

// ── yc-sync ─────────────────────────────────────────────────────────────────

describe('yc-sync: the submit-draft answer', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'yc-sync.js'), 'utf8');
  const doms = []; const teardowns = [];
  function mkWindow() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    doms.push(dom);
    teardowns.push(bcPolyfill.install(dom.window));
    dom.window.console.warn = () => {};
    dom.window.eval(SRC);
    return dom.window;
  }
  afterEach(() => {
    teardowns.splice(0).forEach((fn) => fn());
    bcPolyfill.reset();
    doms.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
  });
  function spy(w) {
    const seen = [];
    ['form:*', 'case:*', 'contact:*'].forEach((a) => w.YC.on(a, '*', (f, m) => seen.push({ addr: m.addr, fields: f })));
    return seen;
  }

  test('announces the form marker AND the record\'s diff when the form patched it', () => {
    const w = mkWindow(); const seen = spy(w);
    w.YC._sniff('POST', URL_PATH, { status: 'success', form_key: 'k', link_type: 'case', link_id: 'AAAA',
      patch_target: { type: 'case', id: 'AAAA' }, patched: ['case_trustee'], changes: { case_trustee: { from: 'a', to: 'b' } } });
    w.YC._sniff('POST', URL_PATH, { status: 'success', form_key: 'k', link_type: 'contact', link_id: '77',
      patch_target: { type: 'contact', id: '77' }, patched: ['contact_email'], changes: { contact_email: { from: 'a', to: 'c' } } });
    expect(seen).toEqual([
      { addr: 'form:case:AAAA', fields: { yc_refetch: 1 } },
      { addr: 'case:AAAA', fields: { case_trustee: 'b' } },
      { addr: 'form:contact:77', fields: { yc_refetch: 1 } },
      { addr: 'contact:77', fields: { contact_email: 'c' } },
    ]);
  });

  test('no patch → the form marker only; an error body, another verb → silent', () => {
    const w = mkWindow(); const seen = spy(w);
    w.YC._sniff('POST', URL_PATH, { status: 'success', link_type: 'case', link_id: 'AAAA', patch_target: null, patched: [], changes: {} });
    w.YC._sniff('POST', URL_PATH, { status: 'error', message: 'Draft 88 not found' });
    w.YC._sniff('PATCH', URL_PATH, { status: 'success', link_type: 'case', link_id: 'BBBB' });
    expect(seen).toEqual([{ addr: 'form:case:AAAA', fields: { yc_refetch: 1 } }]);
  });
});
