// tests/storageConfigDump.test.js
//
/**
 * scripts/storageConfigDump.js — the resolved storage configuration, byte-exact.
 *
 * Pins the 4LSG DEFAULTS as the services export them (every double space),
 * the resolution rules the writers use (a row wins; trailing CR/LF stripped;
 * an empty row = the default; invalid template JSON = the defaults), and that
 * the same facts always render to the same bytes. A changed default literal
 * in a service fails `defaults` here — that is the point.
 */

'use strict';

const dump = require('../scripts/storageConfigDump');

const dbWith = (rows) => ({ query: jest.fn(async () => [rows, []]) });

const EXPECTED_DEFAULTS = {
  // D2: no credential default — a missing row is a refusal, and the dump says so
  credential: { code_default: null, source: 'MISSING — every storage operation refuses until the row exists', value: null },
  unsorted: {
    court_docs: { code_default: '/  Law Office/   Cases/ _Unfiled Court Docs',            key: 'dropbox_unsorted_court_docs_path', source: 'code_default', value: '/  Law Office/   Cases/ _Unfiled Court Docs' },
    esign:     { code_default: '/  Law Office/   Cases/  Unsorted E-Signed Documents',  key: 'dropbox_unsorted_esign_path',     source: 'code_default', value: '/  Law Office/   Cases/  Unsorted E-Signed Documents' },
    forms:     { code_default: '/  Law Office/   Cases/  Unsorted Form Submissions',    key: 'dropbox_unsorted_forms_path',     source: 'code_default', value: '/  Law Office/   Cases/  Unsorted Form Submissions' },
    generated: { code_default: '/  Law Office/   Cases/  Unsorted Generated Documents', key: 'dropbox_unsorted_generated_path', source: 'code_default', value: '/  Law Office/   Cases/  Unsorted Generated Documents' },
    uploads:   { code_default: '/  Law Office/   Cases/  Unsorted Client Uploads',      key: 'dropbox_unsorted_uploads_path',   source: 'code_default', value: '/  Law Office/   Cases/  Unsorted Client Uploads' },
  },
  dropbox_unreachable: null,
};
const POTENTIAL = {
  default: '/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}',
  subfolders: ['Client Uploads'],
};
const ACTIVE = {
  default: '/  Law Office/   Cases/  Active Cases/  Active - {{case_type}}/ {{case_id}} - {{lfm_name}} - {{number}} - {{case_subtype}}',
  subfolders: [
    'Docket - {{contact_name}} - {{case_subtype}} - {{case_number}}',
    'Drafts - {{contact_name}}',
    'Client Docs - {{contact_name}}',
    'Correspondence - {{contact_name}}',
  ],
};

test('defaults: no rows → every value is the code default the services export, spaces intact', async () => {
  const doc = await dump.collect(dbWith([]));
  expect(doc).toEqual({
    ...EXPECTED_DEFAULTS,
    case_folder_templates: { source: 'code_default', code_default: { potential: POTENTIAL, active: ACTIVE }, row: {}, effective: { potential: POTENTIAL, active: ACTIVE } },
  });
  expect(dump.KEYS).toEqual([
    'dropbox_credential_id', 'dropbox_unsorted_generated_path', 'dropbox_unsorted_uploads_path',
    'dropbox_unsorted_forms_path', 'dropbox_unsorted_esign_path', 'dropbox_unsorted_court_docs_path', 'dropbox_case_folder_templates', 'dropbox_unreachable',
  ]);
});

test('rows win, exactly as the writers read them: CR/LF stripped, an empty row is the default, the credential stays a string', async () => {
  const doc = await dump.collect(dbWith([
    { key: 'dropbox_credential_id', value: '21' },
    { key: 'dropbox_unsorted_uploads_path', value: '/  Firm/ Uploads\r\n' },
    { key: 'dropbox_unsorted_forms_path', value: '' },
    { key: 'dropbox_unreachable', value: '1' },
    { key: 'dropbox_case_folder_templates', value: JSON.stringify({ active: { 'Bankruptcy:Ch 7': '/  X/ {{case_id}}', subfolders: [' A'] }, closed: { default: '/  Closed/ {{case_id}}' } }) },
  ]));
  expect(doc.credential).toEqual({ value: '21', source: 'app_settings', code_default: null });
  expect(doc.unsorted.uploads.value).toBe('/  Firm/ Uploads');
  expect(doc.unsorted.uploads.source).toBe('app_settings');
  expect(doc.unsorted.forms).toEqual({ ...EXPECTED_DEFAULTS.unsorted.forms });
  expect(doc.dropbox_unreachable).toBe('1');
  expect(doc.case_folder_templates.source).toBe('app_settings');
  expect(doc.case_folder_templates.effective).toEqual({
    potential: POTENTIAL,
    active: { ...ACTIVE, 'Bankruptcy:Ch 7': '/  X/ {{case_id}}', subfolders: [' A'] },
    closed: { default: '/  Closed/ {{case_id}}' },
  });
});

test('invalid template JSON resolves to the code defaults, as caseService does', async () => {
  const doc = await dump.collect(dbWith([{ key: 'dropbox_case_folder_templates', value: '{not json' }]));
  expect(doc.case_folder_templates.source).toBe('app_settings:invalid_json→code_default');
  expect(doc.case_folder_templates.effective).toEqual({ potential: POTENTIAL, active: ACTIVE });
});

test('render is byte-stable: key order does not change the bytes, and the sha follows the bytes', () => {
  const a = dump.render({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'x' } });
  const b = dump.render({ a: { c: 'x', d: [{ y: 2, z: 1 }] }, b: 1 });
  expect(a).toBe(b);
  expect(a).toBe('{\n  "a": {\n    "c": "x",\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  expect(dump.sha256(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(dump.sha256(a)).not.toBe(dump.sha256(a + ' '));
});
