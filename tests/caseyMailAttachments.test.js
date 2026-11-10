'use strict';
/**
 * tests/caseyMailAttachments.test.js
 *
 * A13b — Casey files ONE email's attachments into ONE case's Dropbox folder
 * (mail.attachments.file.v1 → POST /api/mail/messages/:id/attachments/file),
 * the Comms "File attachments" dialog's own route, after the typed read
 * mail.attachments.preview (the dialog's preview for that one email).
 *
 * The contract pinned here, with the services mocked (the Comms service, the
 * mail reads, the trigger list — never the module under test):
 *   1. the casey_mail_attachments_enabled switch and the signed-in user;
 *   2. refused BY NAME before anything is read: bulk, another mail
 *      operation, unknown fields (the batch is the browser's), bad parts /
 *      booleans, a folder the route's exactFolder refuses (in its words);
 *   3. the evidence: a mail.search / mail.message row of the message, a
 *      mail.attachments.preview row of THAT message, a row with the case_id;
 *   4. the preview re-run as the user: an unreadable email / unknown case;
 *   5. the parts: not on the email, never-filed (by name, with why), already
 *      filed here / elsewhere / being filed, a second confirmation the card
 *      omits (refused, never added), a confirm the card does not need;
 *   6. the disclosures: files, the default folder's real name, optional,
 *      confirmed and duplicate parts, left-out and never-filed parts, the
 *      move (Unsorted default on, another case default off and danger when
 *      asked), a typed folder's existence (exact / letter case / near miss /
 *      new / Dropbox down), no case folder, the matcher's verdict, the notice
 *      (sent / you / none / off), the case link (A13's prediction in filing
 *      mode: create, same case, another case = danger, the route's refusals),
 *      the trigger rules listening; `expected`;
 *   7. the typed read: validation, fingerprint, rows, not-found rows, the
 *      executor (and its audit row), the ledger receipt, the request detector;
 *   8. the browser, lifted from public/assistant.html by name: the fixed
 *      request, the click-time precheck, the dispatch (notice only when
 *      asked and something landed), the result checks, the 409 refusal.
 *
 * The real routes, the real Comms service and the real filing run in
 * tests/caseyMailAttachments.mysql.test.js (gated).
 *
 *   npx jest tests/caseyMailAttachments.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const comms = require(path.join(REPO, 'services', 'emailAttachmentCommsService'));
const mailRead = require(path.join(REPO, 'services', 'mailbox', 'mailReadService'));
const ingest = require(path.join(REPO, 'services', 'emailIngestService'));
const triggers = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested, validateStep, stepFingerprint, mailAttachmentsPreviewRead } = svc;

const CASE_ID = '7KQ2M9XA';
const OTHER = 'OTHER123';
const DATE = '2026-10-30T15:04:00.000Z';   // firm-local 2026-10-30 → "Emailed 261030"
const P = (part, filename, kind, extra = {}) => ({ part, filename, mime: 'application/pdf', bytes: 2960, kind, reason: null,
  confirm: null, filed: null, duplicate: null, checked: kind === 'file', ...extra });
const PARTS = () => [
  P('2', 'stub.pdf', 'file'),
  P('3', 'scans.zip', 'optional', { mime: 'application/zip', confirm: 'type' }),
  P('4', 'run.exe', 'skip', { reason: 'blocked' }),
  P('5', 'logo.png', 'skip', { reason: 'inline_image' }),
  P('6', 'w2.pdf', 'file'),
];
// An emailAttachmentCommsService.preview answer for ONE email.
const PV = (over = {}, msg = {}) => ({
  case: { case_id: CASE_ID, case_number: '25-12345', case_type: 'Bankruptcy', case_stage: 'Open' },
  suggested: false,
  candidates: [{ case_id: CASE_ID, case_number: '25-12345', case_type: 'Bankruptcy', case_stage: 'Open' }],
  messages: [{ id: 88123, mailbox_id: 3, from: 'Dana Debtor <dana@example.com>', subject: 'Pay stubs', date: DATE,
    match: { case_id: CASE_ID, method: 'sender_open_case', flag: null, reason: 'The sender has one open case.' },
    named_cases: [], parts: PARTS(), move: null, ...msg }],
  reviewer: { user_id: 5, name: 'Shana', is_you: false },
  policy: { confirm_mb: 15, confirm_types: null }, max_messages: 50, ...over,
});
// getMessage (the link prediction's mailLoad) and caseLink's own row read.
const MSG = (over = {}) => ({ id: 88123, mailbox_id: 3, mailbox_address: 'intake@firm.test', folder: 'INBOX', from_addr: 'Dana Debtor <dana@example.com>',
  subject: 'Pay stubs', date: DATE, unread: false, log_id: null, log_status: { state: 'store_only' }, attachments: [], ...over });
const ROW = (over = {}) => ({ id: 88123, mailbox_id: 3, folder: 'INBOX', uid: 40, message_id: 'abc@mail.example', provider_id: null,
  from_addr: 'Dana Debtor <dana@example.com>', to_addrs: 'intake@firm.test', cc_addrs: null, subject: 'Pay stubs', date: new Date(DATE),
  ingested_at: new Date('2026-10-30T15:05:00Z'), fresh: 0, body_text: 'Here are my pay stubs.', body_html: null, log_id: null, ...over });

let spies = [];
let calls;
function setup({ pv = PV(), pvError = null, folders = null, msg = MSG(), visible = true, row = ROW(), log = null, otherCase = null,
  mailbox = { id: 3, ingest_folders: { INBOX: { emit_to_rules: false } }, ingest_state: null }, people, caseDropbox = 'https://dbx/case',
  rules = {} } = {}) {
  calls = { preview: [], folders: [], getMessage: [], rules: [], sql: [] };
  spies = [
    jest.spyOn(comms, 'preview').mockImplementation(async (_db, uid, body) => {
      calls.preview.push([uid, body]);
      if (pvError) throw pvError;
      return JSON.parse(JSON.stringify(pv));
    }),
    jest.spyOn(comms, 'caseFolders').mockImplementation(async (_db, uid, body) => {
      calls.folders.push([uid, body]);
      return folders || { case_id: CASE_ID, folders: [], truncated: false, reason: null };
    }),
    jest.spyOn(mailRead, 'getMessage').mockImplementation(async (_db, uid, id) => {
      calls.getMessage.push([uid, id]);
      if (!visible) throw Object.assign(new Error('Message not found'), { status: 404 });
      return { messages: [{ ...msg }] };
    }),
    jest.spyOn(mailRead, 'priorLogId').mockImplementation(async () => null),
    jest.spyOn(ingest, 'firmDomains').mockImplementation(() => new Set(['firm.test'])),
    jest.spyOn(triggers, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules[ev] || []; }),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.sql.push(flat);
    if (flat === 'SELECT case_dropbox FROM cases WHERE case_id = ? LIMIT 1') return [[{ case_dropbox: caseDropbox }]];
    if (flat === 'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id IN (?)') {
      return [params[0].map((id) => ({ case_id: id, case_number: id === OTHER ? '24-99999' : null, case_number_full: null }))];
    }
    if (flat.startsWith('SELECT id, mailbox_id, folder, uid, message_id, provider_id, from_addr, to_addrs, cc_addrs, subject, date, ingested_at')) return [[row]];
    if (flat.startsWith('SELECT log_id FROM mail_messages WHERE message_id = ?')) return [[]];
    if (flat.startsWith('SELECT log_id, log_type, log_date, log_about_type')) return [[log].filter(Boolean)];
    if (flat === 'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1') return [[otherCase].filter(Boolean)];
    if (flat === 'SELECT id, ingest_folders, ingest_state FROM mailboxes WHERE id = ? LIMIT 1') return [[mailbox].filter(Boolean)];
    if (flat.startsWith('SELECT cr.case_relate_client_id AS contact_id, cr.case_relate_type AS relate_type, c.contact_name, c.contact_email FROM case_relate cr')) {
      return [people || [{ contact_id: 1309, relate_type: 'Primary', contact_name: 'Dana Debtor', contact_email: 'dana@example.com' }]];
    }
    if (flat === 'SELECT contact_id, email FROM contact_emails WHERE contact_id IN (?)') return [[]];
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_MAIL_ATTACHMENTS_ENABLED; });

const SEARCH = { id: 'q1', kind: 'mail.search', purpose: 'mail', rows: [{ row_type: 'search' }, { row_type: 'message', mail_message_id: '88123' }] };
const PREVIEW = { id: 'q2', kind: 'mail.attachments.preview', purpose: 'files', rows: [
  { row_type: 'attachments_preview', mail_message_id: 88123, case_id: CASE_ID }, { row_type: 'attachment', mail_message_id: 88123, part: '2' }] };
const CASES = { id: 'q3', kind: 'sql.read', purpose: 'case', rows: [{ case_id: CASE_ID }, { case_id: OTHER }] };
const EVIDENCE = [SEARCH, PREVIEW, CASES];
const EV = [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 2 }, { query_id: 'q3', row_number: 1 }];
const card = (over = {}) => ({ kind: 'mail.attachments.file.v1', mail_message_id: 88123, case_id: CASE_ID, parts: ['2'], evidence: EV, ...over });
const run = (value, opts, evidence = EVIDENCE, userId = 6) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: userId });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const has = (list, text) => expect({ text, found: list.some((l) => l.includes(text)) }).toEqual({ text, found: true });
const hasNot = (list, text) => expect({ text, found: list.some((l) => l.includes(text)) }).toEqual({ text, found: false });

describe('the switch and the user', () => {
  test("'0' turns the kind off; unset is on; a card needs a signed-in user", async () => {
    process.env.CASEY_MAIL_ATTACHMENTS_ENABLED = '0';
    await refuse(card(), 'Action kind is unavailable');
    expect(calls.preview).toEqual([]);
    delete process.env.CASEY_MAIL_ATTACHMENTS_ENABLED;
    await expect(run(card())).resolves.toMatchObject({ kind: 'mail.attachments.file.v1' });
    await expect(normalizeActionDraft(setup(), card(), EVIDENCE, { currentUserId: null })).rejects.toThrow('needs a signed-in user');
  });
});

describe('refused by name before anything is read', () => {
  test.each([
    [{ message_ids: [88123, 88124] }, 'BULK refused (message_ids)'],
    [{ all: true }, 'BULK refused (all)'],
    [{ mail_message_ids: [1] }, 'BULK refused (mail_message_ids)'],
    [{ mail_message_id: [88123, 99] }, 'BULK refused: mail_message_id is a list'],
    [{ unlink: true }, 'OTHER MAIL OPERATIONS refused (unlink)'],
    [{ send: true }, 'OTHER MAIL OPERATIONS refused (send)'],
    [{ batch: 'abcdefgh12' }, 'unsupported fields: batch'],
    [{ rename: 'x.pdf' }, 'unsupported fields: rename'],
    [{ parts: '2' }, '"parts" must be a list of part ids'],
    [{ parts: undefined }, 'needs "parts"'],
    [{ parts: ['2', 'x'] }, '"parts": "x" is not a part id'],
    [{ confirm: ['../2'] }, '"confirm": "../2" is not a part id'],
    [{ move: 'yes' }, '"move" must be true or false'],
    [{ link: 1 }, '"link" must be true or false'],
    [{ notify: 'no' }, '"notify" must be true or false'],
    [{ case_id: 'no spaces!' }, 'needs the exact case_id'],
    [{ folder: '../x' }, 'FOLDER REFUSED — folder: "." and ".." are not folder names'],
    [{ folder: 'Docs.' }, 'FOLDER REFUSED — folder: a name cannot end in a dot or a space'],
    [{ folder: 'a:b' }, 'FOLDER REFUSED — folder: a name cannot hold'],
    [{ folder: 7 }, '"folder" must be text'],
  ])('%j', async (over, re) => {
    await refuse(card(over), re);
    expect(calls.preview).toEqual([]);
  });
});

describe('the evidence', () => {
  test('the message row must come from a typed mail read', async () => {
    await refuse(card({ evidence: [{ query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: 1 }] }), 'does not identify message #88123');
  });
  test('a mail.attachments.preview row of THIS message is required', async () => {
    const otherPreview = { ...PREVIEW, rows: [{ row_type: 'attachments_preview', mail_message_id: 99, case_id: CASE_ID }, { row_type: 'attachment', mail_message_id: 99, part: '2' }] };
    await refuse(card({ evidence: [EV[0], EV[2]] }), 'carries no mail.attachments.preview read of message #88123');
    await refuse(card(), 'carries no mail.attachments.preview read of message #88123', undefined, [SEARCH, otherPreview, CASES]);
    // a not_found row of the read is no evidence either
    const nf = { ...PREVIEW, rows: [{ row_type: 'not_found', mail_message_id: 88123 }] };
    await refuse(card({ evidence: [EV[0], { query_id: 'q2', row_number: 1 }, EV[2]] }), 'carries no mail.attachments.preview read', undefined, [SEARCH, nf, CASES]);
    expect(calls.preview).toEqual([]);
  });
  test('the case must be cited by its exact case_id (a preview row naming it counts)', async () => {
    await refuse(card({ case_id: 'NOTCITED', evidence: EV }), 'does not identify case NOTCITED');
    await expect(run(card({ evidence: [EV[0], { query_id: 'q2', row_number: 1 }] }))).resolves.toMatchObject({ case: { case_id: CASE_ID } });
  });
});

describe('the preview, re-run as the user', () => {
  test('runs for this ONE email and the card\'s case, as the signed-in user', async () => {
    await run(card());
    expect(calls.preview).toEqual([[6, { message_ids: [88123], case_id: CASE_ID }]]);
  });
  test('an email the user cannot read, an unknown case', async () => {
    await refuse(card(), 'Message #88123 is not a message you can read', { pvError: Object.assign(new Error('Message not found'), { status: 404 }) });
    await refuse(card(), `Case ${CASE_ID} not found`, { pvError: Object.assign(new Error('Case not found'), { status: 404 }) });
  });
});

describe('the parts', () => {
  test('a part not on the email, a never-filed part BY NAME with why', async () => {
    await refuse(card({ parts: ['9'] }), 'Part 9 is not an attachment of message #88123 (its attachments: 2 stub.pdf, 3 scans.zip');
    await refuse(card({ parts: ['2', '4'] }), `NEVER FILED — "run.exe" (part 4) cannot be filed: its type is on the firm's never-filed list`);
    await refuse(card({ parts: ['5'] }), 'NEVER FILED — "logo.png" (part 5) cannot be filed: it is an image inside the email');
  });
  test('already filed here (no-op), filed elsewhere (move, never twice), being filed', async () => {
    const parts = PARTS();
    parts[0].filed = { status: 'filed', placement: 'case', case_id: CASE_ID, path: '/c/stub.pdf' };
    parts[4].filed = { status: 'filed', placement: 'unsorted', case_id: null, path: '/bin/w2.pdf' };
    await refuse(card({ parts: ['2'] }), `That changes nothing for "stub.pdf" (part 2) — it is already filed to case 25-12345 (/c/stub.pdf)`, { pv: PV({}, { parts }) });
    await refuse(card({ parts: ['6'] }), '"w2.pdf" (part 6) is already filed to the unsorted client-uploads folder — an attachment is never filed twice', { pv: PV({}, { parts }) });
    parts[4].filed = { status: 'filing', placement: null, case_id: null };
    await refuse(card({ parts: ['6'] }), 'is being filed right now', { pv: PV({}, { parts }) });
  });
  test('a second confirmation the card omits is REFUSED, naming the file and why — never added', async () => {
    await refuse(card({ parts: ['2', '3'] }), 'NEEDS A SECOND CONFIRMATION — "scans.zip" (part 3): not a usual document type');
    const parts = PARTS(); parts[4].confirm = 'size';
    await refuse(card({ parts: ['3', '6'], confirm: ['3'] }), 'NEEDS A SECOND CONFIRMATION — "w2.pdf" (part 6): a large file', { pv: PV({}, { parts }) });
  });
  test('a confirm the card does not need, or for a part it does not file', async () => {
    await refuse(card({ parts: ['2'], confirm: ['2'] }), '"confirm" lists "stub.pdf" (part 2), which needs no second confirmation');
    await refuse(card({ parts: ['2'], confirm: ['3'] }), '"confirm" lists part 3, which is not in "parts"');
  });
});

describe('the card', () => {
  test('files, the default folder by its real name, the confirmed part as danger, optional, left out, never filed, the notice, the link, the rules', async () => {
    const d = await run(card({ parts: ['2', '3'], confirm: ['3'] }), { rules: { 'document.created': [{ id: 41, name: 'Classify uploads' }] } });
    expect(d).toMatchObject({ kind: 'mail.attachments.file.v1', status: 'draft', parts: ['2', '3'], confirm: ['3'], move: null, folder: null, link: true,
      message: { mail_message_id: 88123, mailbox_id: 3, from: 'Dana Debtor <dana@example.com>', subject: 'Pay stubs' },
      case: { case_id: CASE_ID, label: 'case 25-12345', folder_linked: true },
      folder_card: { path: 'Client Uploads/Emailed 261030', default: true },
      notice: { requested: true, send: true, reviewer: { user_id: 5, name: 'Shana', is_you: false } } });
    expect(d.files.map((f) => [f.part, f.optional, f.confirm, f.duplicate])).toEqual([['2', false, null, false], ['3', true, 'type', false]]);
    has(d.effects, 'Files 2 attachments of message #88123 ("Pay stubs" from Dana Debtor <dana@example.com>) to case 25-12345: "stub.pdf" (part 2), about 3 KB; "scans.zip" (part 3)');
    has(d.effects, `Where: the case's Dropbox folder → "Client Uploads/Emailed 261030" — the default`);
    has(d.effects, '"scans.zip" (part 3) is not on the client-upload list — the Comms dialog leaves it unticked');
    has(d.effects, 'Left on the email (not on this card): "w2.pdf" (part 6).');
    has(d.effects, 'Never filed: "run.exe" (part 4) — a blocked type; "logo.png" (part 5) — an image inside the email.');
    has(d.effects, 'Case: case 25-12345 — also the case the case matcher places this email in (sender_open_case).');
    has(d.effects, 'Review notice: after filing, Shana (the reviewer) is emailed ONE notice');
    has(d.effects, 'Creates ONE log entry on case 25-12345: type "email"');
    has(d.effects, 'Who reads it: the message text becomes part of the case\'s log');
    has(d.effects, 'Comms tab: case 25-12345\'s Comms tab lists this email from then on.');
    has(d.effects, 'Trigger rules: each file emits document.created / document.linked; these active rules listen and MAY run');
    has(d.effects, '#41 "Classify uploads" (document.created)');
    has(d.effects, 'Documents are staff-only: the client portal lists none.');
    expect(d.warnings).toEqual(['"scans.zip" (part 3): not a usual document type — it needs a second confirmation, and this card carries it.']);
    expect(calls.rules).toEqual(['document.created', 'document.linked']);
    expect(d.expected).toEqual({
      message: { mailbox_id: 3, from: 'Dana Debtor <dana@example.com>', subject: 'Pay stubs' },
      parts: ['2|file||||', '3|optional||type||'],
      move: null, reviewer_id: 5, case_folder: true,
      link: { stamp_log_id: null, log_id: null, linked_case_id: null },
    });
    expect(calls.folders).toEqual([]);      // no typed folder → no Dropbox listing
  });

  test('a size confirmation names the size; a duplicate is danger', async () => {
    const parts = PARTS();
    parts[4].confirm = 'size'; parts[4].bytes = 20 * 1024 * 1024;
    parts[0].duplicate = { mail_message_id: 77, in_selection: false, path: '/cases/x/stub.pdf' };
    const d = await run(card({ parts: ['2', '6'], confirm: ['6'] }), { pv: PV({}, { parts }) });
    expect(d.warnings).toEqual([
      '"w2.pdf" (part 6): a large file (about 20.0 MB) — it needs a second confirmation, and this card carries it.',
      'DUPLICATE: "stub.pdf" (part 2) has the same name and size as a file already filed to case 25-12345 (/cases/x/stub.pdf) — filing it makes a second copy (the Comms dialog leaves it unticked).',
    ]);
    expect(d.expected.parts).toEqual(['2|file||||77:0', '6|file||size||']);
  });

  test('the matcher placing it elsewhere is danger; a subject-name suggestion is said', async () => {
    const d = await run(card(), { pv: PV({}, { match: { case_id: OTHER, method: 'sender_open_case', reason: 'The sender has one open case.' } }) });
    has(d.warnings, `NOT THE MATCHED CASE: the case matcher places this email in case ${OTHER} (The sender has one open case.), not case 25-12345.`);
    const named = PV({ candidates: [{ case_id: CASE_ID, why: 'subject_name', contact_name: 'Michele Boren' }] }, { match: { case_id: null, flag: 'unknown_sender' } });
    const e = await run(card(), { pv: named });
    has(e.effects, 'Case: case 25-12345 — a SUGGESTION from a name in the subject (Michele Boren); the matcher places this email in no case (unknown_sender).');
    expect(e.warnings).toEqual([]);
  });

  test('a case with no Dropbox folder is danger', async () => {
    const d = await run(card(), { caseDropbox: '' });
    has(d.warnings, 'NO CASE FOLDER: case 25-12345 has no Dropbox folder linked, so the filing first CREATES one');
    expect(d.expected.case_folder).toBe(false);
  });

  test('the notice: off, the reviewer filing, no reviewer', async () => {
    let d = await run(card({ notify: false }));
    expect(d.notice).toMatchObject({ requested: false, send: false });
    has(d.effects, 'Review notice: none — the card turns it off.');
    d = await run(card(), { pv: PV({ reviewer: { user_id: 6, name: 'Fred', is_you: true } }) });
    expect(d.notice).toMatchObject({ send: false, reviewer: { is_you: true } });
    has(d.effects, 'Review notice: none — you are the reviewer (Fred).');
    d = await run(card(), { pv: PV({ reviewer: null }) });
    expect([d.notice.send, d.expected.reviewer_id]).toEqual([false, null]);
    has(d.effects, 'no reviewer is set (the email_attachments_reviewer setting');
  });
});

describe('the move', () => {
  const unsorted = { count: 1, unsorted: 1, case_ids: [], checked: true };
  const fromCase = { count: 2, unsorted: 0, case_ids: [OTHER], checked: false };
  test('out of Unsorted: on by default (the dialog ticks it), never danger; a move-only card', async () => {
    const d = await run(card({ parts: [] }), { pv: PV({}, { move: unsorted }) });
    expect(d.move).toMatchObject({ asked: null, move: true, count: 1, unsorted: 1, case_ids: [] });
    has(d.effects, 'Moves what this email already has filed elsewhere — 1 file, 1 from the unsorted client-uploads folder — into "Client Uploads/Emailed 261030"');
    has(d.effects, '(The Comms dialog ticks this move by default: everything is in Unsorted.)');
    has(d.effects, 'each file emits document.updated / document.linked');
    hasNot(d.effects, 'Files ');
    expect(d.warnings).toEqual([]);
    expect(d.expected.move).toBe('1:1:');
  });
  test('out of another case: off unless asked; asked = danger naming the case', async () => {
    const d = await run(card(), { pv: PV({}, { move: fromCase }) });
    expect(d.move).toMatchObject({ move: false, cases: ['case 24-99999'] });
    has(d.effects, 'Not moved: this email\'s 2 files filed elsewhere (from case 24-99999) stay where they are — moving out of another case is offered, never assumed ("move": true).');
    expect(d.warnings).toEqual([]);
    const e = await run(card({ move: true }), { pv: PV({}, { move: fromCase }) });
    expect(e.move).toMatchObject({ asked: true, move: true });
    has(e.warnings, 'MOVES FILES OUT OF ANOTHER CASE: case 24-99999 holds files this email filed there');
    await refuse(card({ parts: [] }), 'Nothing to file — "parts" is empty and the move is off', { pv: PV({}, { move: fromCase }) });
  });
  test('move asked with nothing filed elsewhere; nothing at all', async () => {
    await refuse(card({ move: true }), 'Nothing to move — no attachment of message #88123 is filed anywhere but case 25-12345');
    await refuse(card({ parts: [] }), 'Nothing to file — "parts" is empty. Name the attachments to file');
    await refuse(card({ parts: [], move: false }), 'Nothing to file', { pv: PV({}, { move: unsorted }) });
  });
});

describe('a typed folder', () => {
  const listing = (folders, extra = {}) => ({ case_id: CASE_ID, folders, truncated: false, reason: null, ...extra });
  test('used exactly (leading spaces kept, slashes tidied by exactFolder); exists / exists in another letter case', async () => {
    const d = await run(card({ folder: '/ 012 - Supplemental Responses/' }), { folders: listing([' 012 - Supplemental Responses', 'Client Uploads']) });
    expect(d.folder).toBe(' 012 - Supplemental Responses');
    expect(d.folder_card).toEqual({ path: ' 012 - Supplemental Responses', default: false, exists: true, note: 'it exists' });
    expect(calls.folders).toEqual([[6, { case_id: CASE_ID }]]);
    has(d.effects, 'Where: the case\'s Dropbox folder → " 012 - Supplemental Responses" — taken exactly as written; it exists.');
    expect(d.warnings).toEqual([]);
    const e = await run(card({ folder: 'client uploads' }), { folders: listing(['Client Uploads']) });
    expect(e.folder_card).toMatchObject({ exists: true, note: 'it exists as "Client Uploads" — Dropbox ignores letter case, so the files land in that folder' });
  });
  test('a new folder is danger; a near miss (spaces) names the real one', async () => {
    const d = await run(card({ folder: 'Signed' }), { folders: listing(['Client Uploads']) });
    expect(d.folder_card).toMatchObject({ exists: false, note: 'it does not exist yet — it is created' });
    has(d.warnings, 'NEW FOLDER: "Signed" is not one of the case folder\'s subfolders, so filing CREATES it. Check the name');
    const e = await run(card({ folder: '012 - Supplemental Responses' }), { folders: listing([' 012 - Supplemental Responses']) });
    has(e.warnings, 'The case folder has " 012 - Supplemental Responses" — the same name but for spaces or letter case');
  });
  test('Dropbox down, no case folder, a cut listing: unknown, said, not danger', async () => {
    let d = await run(card({ folder: 'Signed' }), { folders: listing([], { reason: 'unavailable' }) });
    expect(d.folder_card).toMatchObject({ exists: null, note: 'Dropbox did not answer, so whether it exists is not known — a missing folder is created' });
    expect(d.warnings).toEqual([]);
    d = await run(card({ folder: 'Signed' }), { folders: listing(['A'], { truncated: true }) });
    expect(d.folder_card.exists).toBe(null);
    d = await run(card({ folder: 'a/b/c/d/e' }), { folders: listing(['A']) });
    expect(d.folder_card.exists).toBe(null);
    d = await run(card({ folder: 'Signed' }), { folders: listing([], { reason: 'no_case_folder' }), caseDropbox: null });
    expect(d.folder_card.note).toBe('the case has no Dropbox folder to look in');
  });
});

describe('the case link (A13\'s caseLink prediction, filing mode)', () => {
  test('link false: no prediction, said', async () => {
    const d = await run(card({ link: false }));
    expect([d.link, d.link_card, d.expected.link]).toEqual([false, null, null]);
    expect(calls.getMessage).toEqual([]);
    has(d.effects, 'Not linked: the email is not put on the case\'s log');
  });
  test('already on THIS case: changes nothing (no refusal); on ANOTHER case: danger — the route moves it', async () => {
    const lg = (about) => ({ log_id: 4001, log_type: 'email', log_date: new Date(DATE), log_about_type: 'case', log_about_id: about, log_link_type: 'email', log_link_id: 'dana@example.com', message_chars: 22 });
    const same = await run(card(), { row: ROW({ log_id: 4001 }), log: lg(CASE_ID), msg: MSG({ log_id: 4001, log_status: { state: 'case', log_id: 4001, case: { case_id: CASE_ID } } }) });
    has(same.effects, 'Already linked: log entry #4001 is already about case 25-12345, so the link changes nothing.');
    hasNot(same.effects, 'Comms tab:');
    expect(same.link_card).toMatchObject({ same_case: true, other_case: null });
    expect(same.expected.link).toEqual({ stamp_log_id: 4001, log_id: 4001, linked_case_id: CASE_ID });
    const other = await run(card(), { row: ROW({ log_id: 4001 }), log: lg(OTHER), otherCase: { case_id: OTHER, case_number: '24-99999', case_number_full: null },
      msg: MSG({ log_id: 4001, log_status: { state: 'case', log_id: 4001, case: { case_id: OTHER } } }) });
    has(other.warnings, 'MOVES THE EMAIL OFF ANOTHER CASE: message #88123 is linked to case 24-99999 (log entry #4001)');
    expect(other.link_card.other_case).toEqual({ case_id: OTHER, label: 'case 24-99999' });
  });
  test('the route\'s own link refusals refuse the card, offering link false', async () => {
    await refuse(card(), 'LINK REFUSED — This email arrived in the last few minutes', { row: ROW({ fresh: 1 }) });
    await refuse(card(), 'Set "link" to false to file the attachments without linking the email', { row: ROW({ fresh: 1 }) });
    await refuse(card(), 'LINK REFUSED — The log entry this message points at no longer exists', { row: ROW({ log_id: 4009 }) });
    await expect(run(card({ link: false }), { row: ROW({ fresh: 1 }) })).resolves.toMatchObject({ link: false });
  });
  test('a sender who is not on the case is danger (the identity check rides along)', async () => {
    const d = await run(card(), { people: [{ contact_id: 7002, relate_type: 'Primary', contact_name: 'Other Client', contact_email: 'other@example.com' }] });
    has(d.warnings, 'THE SENDER IS NOT A CONTACT ON THIS CASE: dana@example.com');
  });
});

describe('the A13 link card is unchanged by the shared prediction', () => {
  test('it still refuses a message already on this case or another', async () => {
    const lg = (about) => ({ log_id: 4001, log_type: 'email', log_date: new Date(DATE), log_about_type: 'case', log_about_id: about, message_chars: 1 });
    const link = { kind: 'mail.case_link.v1', mail_message_id: 88123, case_id: CASE_ID, evidence: [EV[0], EV[2]] };
    const db = setup({ row: ROW({ log_id: 4001 }), log: lg(CASE_ID) });
    db.query.mockImplementationOnce(async () => [[{ case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_type: 'Bankruptcy' }]]);
    await expect(normalizeActionDraft(db, link, EVIDENCE, { currentUserId: 6 })).rejects.toThrow('That changes nothing — message #88123 is already linked to case 25-12345');
  });
});

describe('the typed read mail.attachments.preview', () => {
  test('validation and fingerprint', () => {
    expect(validateStep({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: '88123', case_id: ` ${CASE_ID} ` }, 0))
      .toEqual({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: 88123, case_id: CASE_ID });
    expect(validateStep({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: 5 }, 0)).toEqual({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: 5 });
    expect(() => validateStep({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: 0 }, 0)).toThrow('needs a positive mail_message_id');
    expect(() => validateStep({ id: 'q1', kind: 'mail.attachments.preview', purpose: 'p', mail_message_id: 5, case_id: 'a b' }, 0)).toThrow("case_id must be the case's exact case_id");
    expect(stepFingerprint({ kind: 'mail.attachments.preview', mail_message_id: 5, case_id: CASE_ID })).toBe(`mail.attachments.preview:5:${CASE_ID}`);
    expect(stepFingerprint({ kind: 'mail.attachments.preview', mail_message_id: 5 })).not.toBe(stepFingerprint({ kind: 'mail.attachments.preview', mail_message_id: 5, case_id: CASE_ID }));
  });

  test('rows: the head (message, case, matcher, move, reviewer, policy), one per attachment, the candidates (suggestions only)', async () => {
    const parts = PARTS();
    parts[0].filed = { status: 'filed', placement: 'unsorted', case_id: null, path: '/bin/stub.pdf' };
    parts[4].duplicate = { mail_message_id: 88123, in_selection: true };
    const pv = PV({ suggested: true, candidates: [{ case_id: CASE_ID }, { case_id: OTHER, case_number: '24-99999', why: 'subject_name', contact_name: 'Dana Debtor' }] },
      { parts, named_cases: [OTHER], move: { count: 1, unsorted: 1, case_ids: [], checked: true } });
    const out = await mailAttachmentsPreviewRead(setup({ pv }), 6, { mail_message_id: 88123 });
    expect(calls.preview).toEqual([[6, { message_ids: [88123] }]]);
    expect(out.truncated).toBe(false);
    expect(out.rows[0]).toMatchObject({ row_type: 'attachments_preview', mail_message_id: 88123, mailbox_id: 3, case_id: CASE_ID, case_number: '25-12345',
      case_source: 'suggested', match_case_id: CASE_ID, match_method: 'sender_open_case', named_cases: OTHER, attachments: 5,
      filed_elsewhere: '1 attachment already filed elsewhere — 1 in the unsorted client-uploads folder', move_default: 1,
      reviewer: 'Shana', reviewer_user_id: 5, reviewer_is_you: 0, confirm_over_mb: 15, confirm_types: 'every type outside the client-upload list' });
    expect(out.rows[0].note).toContain('case_candidate rows are suggestions only, never the target');
    expect(out.rows.slice(1, 6).map((r) => [r.row_type, r.part, r.class, r.skip_reason, r.needs_confirm, r.filed, r.duplicate, r.ticked])).toEqual([
      ['attachment', '2', 'file', null, null, 'filed to the unsorted client-uploads folder', null, 1],
      ['attachment', '3', 'optional', null, 'type', null, null, 0],
      ['attachment', '4', 'skip', 'blocked', null, null, null, 0],
      ['attachment', '5', 'skip', 'inline_image', null, null, null, 0],
      ['attachment', '6', 'file', null, null, null, 'same name and size as another attachment of this email', 1],
    ]);
    expect(out.rows[1]).toMatchObject({ mail_message_id: 88123, filename: 'stub.pdf', size: 'about 3 KB', filed_path: '/bin/stub.pdf' });
    expect(out.rows.slice(6)).toEqual([{ row_type: 'case_candidate', mail_message_id: 88123, case_id: OTHER, case_number: '24-99999', case_type: null, case_stage: null,
      why: 'subject_name', contact_name: 'Dana Debtor', note: 'A suggestion only: the subject names Dana Debtor of this case' }]);
    // the case asked for is the head's case, said so
    const asked = await mailAttachmentsPreviewRead(setup(), 6, { mail_message_id: 88123, case_id: CASE_ID });
    expect(calls.preview).toEqual([[6, { message_ids: [88123], case_id: CASE_ID }]]);
    expect(asked.rows[0]).toMatchObject({ case_source: 'asked', filed_elsewhere: null, move_default: null });
  });

  test('not found: an unreadable message (no oracle), an unknown case (never a citable case_id), a pruned copy', async () => {
    const nf = await mailAttachmentsPreviewRead(setup({ pvError: Object.assign(new Error('Message not found'), { status: 404 }) }), 6, { mail_message_id: 88123 });
    expect(nf.rows).toEqual([{ row_type: 'not_found', mail_message_id: 88123, note: expect.stringContaining('answers exactly like one that does not exist') }]);
    const nc = await mailAttachmentsPreviewRead(setup({ pvError: Object.assign(new Error('Case not found'), { status: 404 }) }), 6, { mail_message_id: 88123, case_id: 'NOPE1234' });
    expect(nc.rows).toEqual([{ row_type: 'not_found', asked_case_id: 'NOPE1234', note: 'No case has case_id NOPE1234 — read the case first' }]);
    expect(nc.rows[0]).not.toHaveProperty('case_id');
    const gone = await mailAttachmentsPreviewRead(setup({ pv: PV({}, {}) && { ...PV(), messages: [] } }), 6, { mail_message_id: 88123 });
    expect(gone.rows[0]).toMatchObject({ row_type: 'not_found', mail_message_id: 88123 });
    await expect(mailAttachmentsPreviewRead(setup({ pvError: Object.assign(new Error('boom'), { status: 500 }) }), 6, { mail_message_id: 1 })).rejects.toThrow('boom');
  });

  test('more than 60 attachments: 60 rows, truncated', async () => {
    const many = Array.from({ length: 61 }, (_, i) => P(String(i + 2), `f${i}.pdf`, 'file'));
    const out = await mailAttachmentsPreviewRead(setup({ pv: PV({}, { parts: many }) }), 6, { mail_message_id: 88123 });
    expect([out.rows.filter((r) => r.row_type === 'attachment').length, out.truncated]).toEqual([60, true]);
  });
});

describe('the read runs through the executor, audited like the other mail reads', () => {
  const aiService = require(path.join(REPO, 'services', 'aiService'));
  const assistantTicket = require(path.join(REPO, 'lib', 'assistantTicket'));
  test('a mail.attachments.preview step reads the preview as the user; its rows are citable; the audit names the message, never text', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'casey-a13b-test-secret';
    setup();
    const audits = [];
    const db = { query: jest.fn(async (q, p) => {
      if (/FROM app_settings/.test(q)) return [[]];
      if (/FROM ai_calls/.test(q)) return [[{ c: 0 }]];
      if (/INSERT INTO admin_audit_log/.test(q)) { audits.push(p); return [{ insertId: 1 }]; }
      throw new Error(`Unexpected SQL: ${q}`);
    }) };
    const plan = svc.validatePlan({ action: 'query', summary: 'Attachments', steps: [
      { id: 'q1', kind: 'mail.attachments.preview', purpose: 'The email\'s files', mail_message_id: 88123, case_id: CASE_ID }] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'What did Dana attach?', history: [], plan: { action: 'query', ...plan } });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 3,
      json: { answer: 'Two files.', citations: [{ query_id: 'q1', row_number: 2, label: 'stub.pdf' }], suggestions: [] } });
    try {
      const out = await svc.execute(db, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7, username: 'rena' } });
      expect(calls.preview).toEqual([[7, { message_ids: [88123], case_id: CASE_ID }]]);
      expect(out.sources[0]).toMatchObject({ query_id: 'q1', row_number: 2, row: { row_type: 'attachment', part: '2', filename: 'stub.pdf' } });
      await new Promise((r) => setImmediate(r));
      expect(audits.length).toBe(1);
      const flat = JSON.stringify(audits[0]);
      expect(flat).toContain('mail_read');
      expect(flat).toContain('assistant_attachments_preview');
      expect(flat).toContain('88123');
      expect(flat).not.toContain('stub.pdf');
    } finally {
      answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });
});

describe('the ledger and the request detector', () => {
  test('the receipt is the integer mail_message_id', () => {
    expect(ledger.KINDS.get('mail.attachments.file.v1')).toBe('mail_message_id');
  });
  test.each([
    ["File the attachments from Dana's last email to her case", true],
    ['please save the PDFs she emailed into the Smith case', true],
    ['put the attached documents in the 25-12345 Dropbox folder', true],
    ['What attachments did the trustee send?', false],
    ['how many attachments are on that email?', false],
  ])('%s → %s', (q, want) => {
    expect(taskDraftRequested(q, [])).toBe(want);
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
const FNS = ['mailMessageIdOf', 'mailReadMessage', 'mailAttachmentsLabel', 'mailAttachmentsCaseLabel', 'mailAttachmentBytes', 'mailAttachmentVerdict',
  'mailAttachmentMoveKey', 'mailAttachmentsText', 'mailAttachmentsBatch', 'mailAttachmentsRequest', 'mailAttachmentsPrecheck', 'mailAttachmentsDispatch',
  'mailAttachmentsResult', 'mailAttachmentsKnownOutcome', 'mailAttachmentsOutcomeText', 'mailAttachmentsAppliedMessage'];
function browser(api) {
  const src = [constSrc('MAIL_ATTACHMENTS_ACTION_KINDS'), ...FNS.map(fnSrc), `const family = ${familySrc('mail_attachments')};`, `return { ${FNS.join(', ')}, family };`].join('\n');
  return new Function('api', 'openEntity', src)(api, jest.fn()); // eslint-disable-line no-new-func
}

describe('the browser: the fixed request, the precheck, the dispatch, the result, outcomes, danger', () => {
  let base; let linkCard; let movedCard; let folderCard;
  const JUNK = { ids: [1, 2], all: true, batch: 'model-chosen', rename: 'x.pdf', notify: true };
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const c = await run(value, opts);
      spies.forEach((s) => s.mockRestore()); spies = [];
      return JSON.parse(JSON.stringify(c));
    };
    base = await mk(card({ parts: ['2', '3'], confirm: ['3'], link: false }));
    linkCard = await mk(card());
    movedCard = await mk(card({ move: true, notify: false, link: false }), { pv: PV({}, { move: { count: 2, unsorted: 0, case_ids: [OTHER], checked: false } }) });
    folderCard = await mk(card({ folder: ' 012 - Supplemental Responses', link: false }), { folders: { case_id: CASE_ID, folders: [' 012 - Supplemental Responses'], truncated: false, reason: null } });
  });
  // The reads as the real routes answer them, built from the same fixtures.
  const reads = (over = {}) => async (p, body, method) => {
    if (p === `/api/cases/${CASE_ID}` && method === 'GET') {
      if (over.caseGone) throw Object.assign(new Error('Case not found'), { status: 404 });
      return { case: { case_id: CASE_ID, case_dropbox: over.caseDropbox === undefined ? 'https://dbx/case' : over.caseDropbox } };
    }
    if (p === '/api/mail/attachments/preview' && method === 'POST') {
      if (over.mailGone) throw Object.assign(new Error('Message not found'), { status: 404, body: { message: 'Message not found' } });
      return { status: 'success', ...(over.pv || PV()) };
    }
    if (p === '/api/mail/messages/88123' && method === 'GET') {
      return { status: 'success', messages: [{ id: 88123, unread: false, log_id: null, log_status: { state: 'store_only' }, ...(over.msg || {}) }] };
    }
    throw new Error(`unexpected ${method} ${p}`);
  };

  test('the request: exactly the card\'s fields, explicit booleans, the batch from the draft only with the notice on, the folder exact', () => {
    const b = browser(jest.fn());
    const draft = { ...base, ...JUNK, notice: base.notice };
    const req = b.mailAttachmentsRequest(draft);
    expect(req).toEqual({ path: '/api/mail/messages/88123/attachments/file', method: 'POST',
      body: { case_id: CASE_ID, parts: ['2', '3'], confirm: ['3'], move: false, link: false, batch: b.mailAttachmentsBatch(base) } });
    expect(req.body.batch).toMatch(/^cy[A-Za-z0-9]{6,28}$/);
    expect(req.body.batch).toBe(`cy${base.draft_id.replace(/-/g, '')}`.slice(0, 30));
    expect(b.mailAttachmentsRequest({ ...base, notice: { ...base.notice, send: false } }).body).not.toHaveProperty('batch');
    expect(b.mailAttachmentsRequest(linkCard).body).toMatchObject({ parts: ['2'], confirm: [], link: true, move: false });
    expect(b.mailAttachmentsRequest(movedCard).body).toEqual({ case_id: CASE_ID, parts: ['2'], confirm: [], move: true, link: false });
    expect(b.mailAttachmentsRequest(folderCard).body.folder).toBe(' 012 - Supplemental Responses');
    for (const broken of [{ parts: ['x'] }, { parts: ['2'], confirm: ['9'] }, { parts: [] }, { link: undefined }, { case: { case_id: 'a b' } }, { folder: 7 }]) {
      expect(() => b.mailAttachmentsRequest({ ...base, ...broken })).toThrow();
    }
  });

  test('the precheck passes on a fresh card and refuses on ANY difference before the claim', async () => {
    const ok = browser(reads());
    expect(await ok.mailAttachmentsPrecheck(base)).toBe('');
    expect(await ok.mailAttachmentsPrecheck(linkCard)).toBe('');
    const filedNow = PARTS(); filedNow[0].filed = { status: 'filed', placement: 'case', case_id: CASE_ID };
    const dupNow = PARTS(); dupNow[1].duplicate = { mail_message_id: 9, in_selection: false };
    const confNow = PARTS(); confNow[0].confirm = 'size';
    const blockedNow = PARTS(); blockedNow[1] = P('3', 'scans.zip', 'skip', { reason: 'blocked' });
    for (const [over, re, c = base] of [
      [{ caseGone: true }, 'case 25-12345 no longer exists'],
      [{ caseDropbox: '' }, 'Dropbox folder link was removed'],
      [{ mailGone: true }, 'is no longer one you can read'],
      [{ pv: PV({}, { subject: 'Other' }) }, 'is not the email this card was prepared for'],
      [{ pv: PV({}, { parts: filedNow }) }, '"stub.pdf" changed since this card was prepared'],
      [{ pv: PV({}, { parts: dupNow }) }, '"scans.zip" changed since this card was prepared'],
      [{ pv: PV({}, { parts: confNow }) }, '"stub.pdf" changed'],
      [{ pv: PV({}, { parts: blockedNow }) }, '"scans.zip" changed'],
      [{ pv: PV({}, { parts: PARTS().slice(1) }) }, 'Part 2 changed'],
      [{ pv: PV({}, { move: { count: 1, unsorted: 1, case_ids: [], checked: true } }) }, 'has filed elsewhere changed'],
      [{ pv: PV({ reviewer: { user_id: 9, name: 'X', is_you: false } }) }, 'review-notice recipient'],
      [{ msg: { log_id: 5, log_status: { state: 'case', log_id: 5, case: { case_id: OTHER } } } }, 'case link or log entry changed', linkCard],
      [{ msg: { log_status: { state: 'logged', log_id: 7 } } }, 'case link or log entry changed', linkCard],
    ]) {
      expect({ over: Object.keys(over), why: await browser(reads(over)).mailAttachmentsPrecheck(c) }).toEqual({ over: Object.keys(over), why: expect.stringContaining(re) });
    }
    // a card that does not link never reads the message; one that does, does
    const api = jest.fn(reads());
    await browser(api).mailAttachmentsPrecheck(base);
    expect(api.mock.calls.map((c) => c[0])).toEqual([`/api/cases/${CASE_ID}`, '/api/mail/attachments/preview']);
    expect(api.mock.calls[1][1]).toEqual({ message_ids: [88123], case_id: CASE_ID });
    api.mockClear();
    await browser(api).mailAttachmentsPrecheck(linkCard);
    expect(api.mock.calls.map((c) => c[0])).toEqual([`/api/cases/${CASE_ID}`, '/api/mail/attachments/preview', '/api/mail/messages/88123']);
  });

  const filedAnswer = (over = {}) => ({ status: 'success', id: 88123, case: { case_id: CASE_ID }, refiled: null, linked: false, log_id: null, link_error: null,
    files: [{ part: '2', status: 'filed', filename: 'stub.pdf' }, { part: '3', status: 'filed', filename: 'scans.zip' }], folder_path: '/cases/x/Client Uploads/Emailed 261030', ...over });

  test('the dispatch: the file route, then the notice for THIS batch only when the notice is on and something landed; a notice failure rides along', async () => {
    const calls2 = [];
    const api = async (p, body, method) => { calls2.push([p, body, method]); return p.endsWith('/file') ? filedAnswer() : { status: 'success', sent: true }; };
    const b = browser(api);
    const req = b.mailAttachmentsRequest(base);
    const out = await b.mailAttachmentsDispatch(req);
    expect(calls2).toEqual([['/api/mail/messages/88123/attachments/file', req.body, 'POST'], ['/api/mail/attachments/notice', { batch: req.body.batch }, 'POST']]);
    expect(out.notice).toEqual({ status: 'success', sent: true });
    calls2.length = 0;
    await b.mailAttachmentsDispatch(b.mailAttachmentsRequest({ ...base, notice: { send: false } }));
    expect(calls2.map((c) => c[0])).toEqual(['/api/mail/messages/88123/attachments/file']);
    // nothing landed → no notice
    const failedOnly = browser(async (p, body, method) => { calls2.push([p, body, method]); return filedAnswer({ files: [{ part: '2', status: 'failed', error: 'socket' }, { part: '3', status: 'in_progress' }] }); });
    calls2.length = 0;
    await failedOnly.mailAttachmentsDispatch(failedOnly.mailAttachmentsRequest(base));
    expect(calls2.map((c) => c[0])).toEqual(['/api/mail/messages/88123/attachments/file']);
    const noticeDown = browser(async (p) => { if (p.endsWith('/notice')) throw new Error('smtp down'); return filedAnswer(); });
    const o2 = await noticeDown.mailAttachmentsDispatch(noticeDown.mailAttachmentsRequest(base));
    expect(o2.notice_error).toBe('smtp down');
    // the route's refusal is the card's refusal: never swallowed
    const refused = browser(async () => { throw Object.assign(new Error('nope'), { status: 409 }); });
    await expect(refused.mailAttachmentsDispatch(refused.mailAttachmentsRequest(base))).rejects.toThrow('nope');
  });

  test('the result: every part reported, the reviewed case, the move, the link confirmed or its error; the outcome recorded', () => {
    const b = browser(jest.fn());
    const d = JSON.parse(JSON.stringify(base));
    expect(b.mailAttachmentsResult(d, filedAnswer())).toEqual({ mail_message_id: 88123 });
    expect(d.file_outcome).toMatchObject({ filed: 2, already: 0, failed: [], moved: 0, linked: false, link_error: null, folder_path: '/cases/x/Client Uploads/Emailed 261030' });
    for (const [bad, re] of [
      [{ id: 1 }, 'did not confirm the email'], [{ status: 'error' }, 'did not confirm the email'],
      [{ case: { case_id: OTHER } }, 'did not file to the reviewed case'], [{ files: null }, 'did not report the files'],
      [{ files: [{ part: '2', status: 'filed' }] }, 'did not report part 3'],
    ]) expect(() => b.mailAttachmentsResult(JSON.parse(JSON.stringify(base)), filedAnswer(bad))).toThrow(re);
    expect(() => b.mailAttachmentsResult(JSON.parse(JSON.stringify(movedCard)), filedAnswer({ files: [{ part: '2', status: 'filed' }] }))).toThrow('did not report the move');
    expect(() => b.mailAttachmentsResult(JSON.parse(JSON.stringify(linkCard)), filedAnswer({ files: [{ part: '2', status: 'filed' }] }))).toThrow('did not confirm the case link');
    // filed but not linked: applied, the link error said — never applied-clean
    const l = JSON.parse(JSON.stringify(linkCard));
    b.mailAttachmentsResult(l, filedAnswer({ files: [{ part: '2', status: 'filed', filename: 'stub.pdf' }], link_error: 'This email arrived in the last few minutes' }));
    expect(l.file_outcome).toMatchObject({ linked: false, link_error: 'This email arrived in the last few minutes' });
    const copy = b.family.appliedCopy({ ...l, status: 'applied', result_mail_attachments_id: 88123 });
    expect(copy.status).toBe('Applied with problems — attachments filed to case 25-12345');
    expect(copy.warning).toContain('the email was NOT linked to the case (This email arrived in the last few minutes) — link it from Comms');
    // a part that failed is reported, not hidden
    const f = JSON.parse(JSON.stringify(base));
    b.mailAttachmentsResult(f, filedAnswer({ files: [{ part: '2', status: 'filed', filename: 'stub.pdf' }, { part: '3', status: 'failed', filename: 'scans.zip', error: 'socket hang up' }] }));
    expect(b.mailAttachmentsAppliedMessage(f, { mail_message_id: 88123 }, false))
      .toBe('File email attachments applied to case 25-12345: 1 file filed, folder /cases/x/Client Uploads/Emailed 261030. NOT DONE: "scans.zip" failed (socket hang up). Retry from Comms → File attachments (what landed shows as Filed).');
    const clean = JSON.parse(JSON.stringify(linkCard));
    b.mailAttachmentsResult(clean, filedAnswer({ files: [{ part: '2', status: 'already_filed' }], linked: true, log_id: 5001, notice: { sent: true } }));
    expect(b.family.appliedCopy({ ...clean, status: 'applied' }).status).toBe('Applied — attachments filed to case 25-12345');
    expect(b.mailAttachmentsAppliedMessage(clean, { mail_message_id: 88123 }, false)).toBe('File email attachments applied to case 25-12345: 1 already there, folder /cases/x/Client Uploads/Emailed 261030. The email is linked to the case (log entry #5001). The reviewer was sent the review notice.');
  });

  test('outcomes: the 409 needs_confirmation is a refusal naming the files; a bare 409 and an idempotency body stay ambiguous', () => {
    const b = browser(jest.fn());
    expect(b.mailAttachmentsKnownOutcome({ status: 409, body: { needs_confirmation: [{ part: '2', filename: 'stub.pdf', why: 'size' }] } }))
      .toEqual({ status: 'Refused — nothing written', text: 'Refused — nothing filed: the firm\'s confirm settings changed since this card was prepared, and "stub.pdf" (a large file) now needs a second confirmation this card does not carry. Ask Casey to prepare it again.' });
    expect(b.mailAttachmentsKnownOutcome({ status: 409, body: {} })).toBe(null);
    expect(b.mailAttachmentsKnownOutcome({ status: 409, body: { idempotency: {}, needs_confirmation: [{ part: '2' }] } })).toBe(null);
    expect(b.mailAttachmentsKnownOutcome({ status: 422, body: { message: 'x' } })).toBe(null);
  });

  test('danger: any warning; the family\'s fixed members', () => {
    const b = browser(jest.fn());
    expect(b.family.danger(base)).toBe(true);                         // the confirmed scans.zip
    expect(b.family.danger(linkCard)).toBe(false);
    expect(b.family.danger(movedCard)).toBe(true);                    // out of another case
    expect([b.family.id, b.family.idField, b.family.appliedKey, !!b.family.stringReceipt, typeof b.family.dispatch]).toEqual(
      ['mail_attachments', 'mail_message_id', 'result_mail_attachments_id', false, 'function']);
    expect([...b.family.kinds]).toEqual(['mail.attachments.file.v1']);
    const text = b.mailAttachmentsText(base);
    for (const line of ['Email attachments filing proposal — not applied', 'Email: #88123 — from Dana Debtor <dana@example.com>, "Pay stubs", 2026-10-30 15:04 UTC',
      'File: "scans.zip" (part 3, about 3 KB) — not on the client-upload list — needs a second confirmation (unusual type), carried by this card',
      'Folder: Client Uploads/Emailed 261030 (the default)', 'Link the email to the case: no', 'Review notice: yes — emailed to Shana',
      'Warning: "scans.zip" (part 3): not a usual document type — it needs a second confirmation, and this card carries it.']) {
      expect({ line, shown: text.includes(line) }).toEqual({ line, shown: true });
    }
  });
});
