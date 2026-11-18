// tests/docsIntakeLog.test.js
/**
 * services/docsIntakeLog — the ONE `docs` case-log row every docs door writes
 * (docReq, portal, the docs@ email automation, Comms). logService is mocked:
 * this suite pins what the helper ASKS for; the MySQL twin
 * (tests/emailAttachments.mysql.test.js) proves the rows land for real.
 */

'use strict';

jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 77 })) }));

const logService = require('../services/logService');
const docsLog = require('../services/docsIntakeLog');

const call = () => logService.createLogEntry.mock.calls[0][1];
const data = () => JSON.parse(call().data);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

describe('the row', () => {
  test('docreq: case link, by 0, incoming, plain names become {name}, the true count kept', async () => {
    const r = await docsLog.logDocsIntake({}, {
      action: 'client_upload', source: 'docreq', caseId: 'AbCdEf12',
      files: ['a.pdf', 'b.pdf'], fileCount: 52, comment: 'pay stubs', placement: 'case',
    });
    expect(r).toEqual({ log_id: 77 });
    expect(call()).toMatchObject({
      type: 'docs', link_type: 'case', link_id: 'AbCdEf12', by: 0, direction: 'incoming',
      subject: 'Client uploaded 52 documents',
    });
    expect(data()).toEqual({
      action: 'client_upload', source: 'docreq', contact_id: null, file_count: 52,
      files: [{ name: 'a.pdf' }, { name: 'b.pdf' }], comment: 'pay stubs', placement: 'case', folder_path: null,
    });
  });

  test('portal: subject says via portal; item fields kept; contact_id in data, the link stays the case', async () => {
    await docsLog.logDocsIntake({}, {
      action: 'client_upload', source: 'portal', caseId: 'AbCdEf12', contactId: 42,
      files: [{ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' }, { name: 'b.pdf', item_id: null, item_name: null }],
    });
    expect(call()).toMatchObject({ link_type: 'case', link_id: 'AbCdEf12', subject: 'Client uploaded 2 documents via portal' });
    expect(data().contact_id).toBe(42);
    expect(data().files).toEqual([{ name: 'a.pdf', item_id: 7, item_name: 'Pay stubs' }, { name: 'b.pdf' }]);
  });

  test('email: the sender and the first To address name the row; email block carries the address, not the display name', async () => {
    await docsLog.logDocsIntake({}, {
      action: 'email_filed', source: 'email', caseId: 'PVXC1RMM', contactId: 2050,
      files: [{ filed_name: 'NFCU.pdf', path: '/x/Client Uploads/Emailed 261118/NFCU.pdf', document_id: '159606' }],
      placement: 'case', folderPath: '/x/Client Uploads/Emailed 261118',
      failed: [{ filename: 'big.zip', error: 'too large' }],
      email: { mail_message_id: '901', from: 'Tristan Sims', from_email: 'mrsims1126@gmail.com', to: 'Docs <DOCS@4lsg.com>, stuart@4lsg.com', subject: 'NFCU statements' },
    });
    expect(call().subject).toBe('Tristan Sims emailed 1 document to docs@4lsg.com');
    expect(data()).toMatchObject({
      action: 'email_filed', source: 'email', contact_id: 2050, file_count: 1,
      files: [{ name: 'NFCU.pdf', path: '/x/Client Uploads/Emailed 261118/NFCU.pdf', document_id: 159606 }],
      failed: [{ name: 'big.zip', error: 'too large' }],
      email: { mail_message_id: 901, from: 'mrsims1126@gmail.com', to: 'docs@4lsg.com', subject: 'NFCU statements' },
    });
  });

  test('email without a display name or a To → the address alone, no "to"', async () => {
    await docsLog.logDocsIntake({}, {
      action: 'email_filed', source: 'email', caseId: 'C1', files: ['x.pdf'],
      email: { from: null, from_email: 'michele@x.com' },
    });
    expect(call().subject).toBe('michele@x.com emailed 1 document');
  });

  test('comms: the person filed, by their user id', async () => {
    await docsLog.logDocsIntake({}, {
      action: 'email_filed', source: 'comms', caseId: 'C1', files: ['a.pdf', 'b.pdf'], by: 6, actor: 'Fred',
      email: { mail_message_id: 1, from_email: 'a@b.c' },
    });
    expect(call()).toMatchObject({ by: 6, subject: 'Fred filed 2 emailed documents from Comms' });
  });

  test('refiled: moved to this case, by the actor when named', async () => {
    await docsLog.logDocsIntake({}, { action: 'email_refiled', source: 'email', caseId: 'C1', files: ['a.pdf'] });
    expect(call()).toMatchObject({ by: 0, subject: '1 emailed document moved to this case' });
    logService.createLogEntry.mockClear();
    await docsLog.logDocsIntake({}, { action: 'email_refiled', source: 'comms', caseId: 'C1', files: ['a.pdf', 'b.pdf'], by: 5, actor: 'Shana' });
    expect(call()).toMatchObject({ by: 5, subject: '2 emailed documents moved to this case by Shana' });
  });
});

describe('where the row hangs', () => {
  test('no case → the contact', async () => {
    await docsLog.logDocsIntake({}, { action: 'email_filed', source: 'email', contactId: 16, files: ['a.pdf'], placement: 'unsorted' });
    expect(call()).toMatchObject({ link_type: 'contact', link_id: '16' });
  });

  test('neither case nor contact → no row (the refile writes it later)', async () => {
    expect(await docsLog.logDocsIntake({}, { action: 'email_filed', source: 'email', files: ['a.pdf'] })).toBeNull();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });

  test('nothing arrived → no row', async () => {
    expect(await docsLog.logDocsIntake({}, { action: 'client_upload', source: 'docreq', caseId: 'C1', files: [] })).toBeNull();
    expect(await docsLog.logDocsIntake({}, { action: 'client_upload', source: 'docreq', caseId: 'C1', files: [null, '', {}] })).toBeNull();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });
});

describe('never throws', () => {
  test('a failed write is a console line and null', async () => {
    logService.createLogEntry.mockRejectedValueOnce(new Error('db down'));
    await expect(docsLog.logDocsIntake({}, { action: 'client_upload', source: 'docreq', caseId: 'C1', files: ['a'] })).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  test('an unknown action or source is refused (null), never written', async () => {
    expect(await docsLog.logDocsIntake({}, { action: 'upload', source: 'docreq', caseId: 'C1', files: ['a'] })).toBeNull();
    expect(await docsLog.logDocsIntake({}, { action: 'client_upload', source: 'fax', caseId: 'C1', files: ['a'] })).toBeNull();
    expect(await docsLog.logDocsIntake({}, undefined)).toBeNull();
    expect(logService.createLogEntry).not.toHaveBeenCalled();
  });
});

describe('caps', () => {
  test('files listed up to MAX_FILES, the count is the truth; long names and comments cut', async () => {
    const files = Array.from({ length: 60 }, (_, i) => `f${i}.pdf`);
    files[0] = 'n'.repeat(400);
    await docsLog.logDocsIntake({}, { action: 'client_upload', source: 'docreq', caseId: 'C1', files, comment: 'c'.repeat(3000) });
    const d = data();
    expect(d.file_count).toBe(60);
    expect(d.files).toHaveLength(docsLog.MAX_FILES);
    expect(d.files[0].name).toHaveLength(255);
    expect(d.comment).toHaveLength(2000);
  });

  test('a fileCount smaller than the files given is ignored (the list is the floor)', async () => {
    await docsLog.logDocsIntake({}, { action: 'client_upload', source: 'docreq', caseId: 'C1', files: ['a', 'b', 'c'], fileCount: 1 });
    expect(data().file_count).toBe(3);
  });
});

describe('helpers', () => {
  test('firstAddress', () => {
    expect(docsLog._firstAddress('Docs <DOCS@4lsg.com>, x@y.z')).toBe('docs@4lsg.com');
    expect(docsLog._firstAddress('"Smith, J" <j@s.com>')).toBe('j@s.com');
    expect(docsLog._firstAddress('')).toBeNull();
    expect(docsLog._firstAddress(null)).toBeNull();
  });

  test('subjectFor covers every source/action pair', () => {
    expect(docsLog.subjectFor({ action: 'client_upload', source: 'docreq', count: 1 })).toBe('Client uploaded 1 document');
    expect(docsLog.subjectFor({ action: 'client_upload', source: 'portal', count: 3 })).toBe('Client uploaded 3 documents via portal');
    expect(docsLog.subjectFor({ action: 'email_filed', source: 'email', count: 2, from: 'A', to: 'docs@4lsg.com' })).toBe('A emailed 2 documents to docs@4lsg.com');
    expect(docsLog.subjectFor({ action: 'email_filed', source: 'email', count: 2 })).toBe('Unknown sender emailed 2 documents');
    expect(docsLog.subjectFor({ action: 'email_filed', source: 'comms', count: 1 })).toBe('Staff filed 1 emailed document from Comms');
    expect(docsLog.subjectFor({ action: 'email_refiled', source: 'email', count: 4 })).toBe('4 emailed documents moved to this case');
  });
});
