'use strict';
/**
 * tests/caseyRecordText.test.js
 *
 * A7 group A (Fred, 2026-10-28) — Casey edits a case's notes, a case's alerts
 * and a contact's notes through reviewed cards: case.notes.update.v1,
 * case.alerts.update.v1, contact.notes.update.v1, each writing ONE column
 * whole through the native PATCH /api/cases/:id or /api/contacts/:id.
 *
 * The contract pinned here (server side; the browser half — the fixed
 * one-field builder, the click-time value re-read, outcomes and the bounded
 * card diff — is in tests/assistantUi.test.js):
 *   1. the casey_record_edits_enabled switch ('0' = dark; unset = on);
 *   2. FULL after-value semantics: an append resolves at normalize time to the
 *      complete text (the stored text kept byte-for-byte), a value replaces,
 *      '' clears; the current value is baked into `expected`;
 *   3. the refusal table: unknown keys BY NAME, value XOR append, over-cap
 *      (notes = lib/noteLimits' cap, alerts 5000) counting the WHOLE result,
 *      a no-op, a missing record, evidence that does not carry the exact id;
 *   4. the card's target: the case number, type and its Primary/Secondary
 *      client names (never another column of those contact rows); the
 *      contact's name, kind and linked-case count;
 *   5. the request detector forces a draft for note/alert edits only;
 *   6. the ledger takes a STRING receipt for the two case kinds only
 *      (cases.case_id is a varchar PK) and still refuses a string on every
 *      integer family.
 *
 * The normalizer adds no SQL of its own: it reads through caseService.getCase
 * and contactService.getContact (the routes' own GET services), which run
 * here for real against a stub pool that answers their exact statements. So
 * there is no gated MySQL twin for this family.
 *
 *   npx jest tests/caseyRecordText.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const { NOTE_MAX_CHARS } = require(path.join(REPO, 'lib', 'noteLimits'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const SECRET_SSN = '123-45-6789';
function makeDb(over = {}) {
  const cases = { [CASE_ID]: { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Chapter 7',
    case_notes: 'first line\nsecond line', case_alerts: '', ...(over.case || {}) } };
  const contacts = { 77: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person', contact_notes: 'Prefers email',
    contact_ssn: SECRET_SSN, ...(over.contact || {}) } };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT * FROM cases WHERE case_id = ?') {
      // utf8mb4_general_ci: a differently-cased id finds the row.
      const row = Object.values(cases).find((c) => c.case_id.toLowerCase() === String(params[0]).toLowerCase());
      return [over.caseMissing || !row ? [] : [{ ...row }]];
    }
    if (/^SELECT co\.\*, .* FROM contacts co JOIN case_relate cr ON co\.contact_id = cr\.case_relate_client_id WHERE cr\.case_relate_case_id = \?$/.test(flat)) {
      return [[
        { contact_id: 77, contact_name: 'Dana Client', contact_ssn: SECRET_SSN, relate_type: 'Primary' },
        { contact_id: 78, contact_name: 'Sam Client', contact_ssn: SECRET_SSN, relate_type: 'Secondary' },
        { contact_id: 90, contact_name: 'Opposing Counsel', contact_ssn: '', relate_type: 'Other' },
      ]];
    }
    if (flat === 'SELECT * FROM contacts WHERE contact_id = ?') {
      const row = contacts[Number(params[0])];
      return [over.contactMissing || !row ? [] : [{ ...row }]];
    }
    if (/^SELECT ca\.case_id, .* FROM case_relate cr JOIN cases ca ON cr\.case_relate_case_id = ca\.case_id WHERE cr\.case_relate_client_id = \?/.test(flat)) {
      return [[{ case_id: CASE_ID }, { case_id: 'OTHER123' }]];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

// q1 = a cases read, q2 = a contacts read.
const EVIDENCE = [
  { id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
  { id: 'q2', purpose: 'contact', rows: [{ contact_id: '77', contact_name: 'Dana Client' }] },
];
const caseEv = [{ query_id: 'q1', row_number: 1 }];
const contactEv = [{ query_id: 'q2', row_number: 1 }];
const caseNotes = (over = {}) => ({ kind: 'case.notes.update.v1', case_id: CASE_ID, append: 'third line', evidence: caseEv, ...over });
const caseAlerts = (over = {}) => ({ kind: 'case.alerts.update.v1', case_id: CASE_ID, value: 'Client is hard of hearing', evidence: caseEv, ...over });
const contactNotes = (over = {}) => ({ kind: 'contact.notes.update.v1', contact_id: 77, append: 'Texts after 5pm', evidence: contactEv, ...over });

beforeEach(() => { delete process.env.CASEY_RECORD_EDITS_ENABLED; });
afterEach(() => { delete process.env.CASEY_RECORD_EDITS_ENABLED; });

const run = (value, dbOver) => normalizeActionDraft(makeDb(dbOver), value, EVIDENCE);
const refuse = (value, re, dbOver) => expect(run(value, dbOver)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes all three kinds unavailable; unset is ON", async () => {
    process.env.CASEY_RECORD_EDITS_ENABLED = '0';
    for (const v of [caseNotes(), caseAlerts(), contactNotes()]) {
      await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    }
    delete process.env.CASEY_RECORD_EDITS_ENABLED;
    for (const v of [caseNotes(), caseAlerts(), contactNotes()]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('full after-value semantics, resolved at normalize time', () => {
  test('append: a new line after the stored text, which is kept byte-for-byte; expected is the whole current value', async () => {
    const out = await run(caseNotes({ append: '  third line \n' }));
    expect(out).toMatchObject({
      kind: 'case.notes.update.v1', field: 'case_notes', mode: 'append',
      after: 'first line\nsecond line\nthird line',
      expected: { case_notes: 'first line\nsecond line' },
      before_length: 22, after_length: 33, max: NOTE_MAX_CHARS,
    });
    expect(out.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    // Stored trailing whitespace / a stored final newline are never trimmed.
    expect((await run(caseNotes(), { case: { case_notes: 'a  ' } })).after).toBe('a  \nthird line');
    expect((await run(caseNotes(), { case: { case_notes: 'a\n' } })).after).toBe('a\nthird line');
    expect((await run(caseNotes(), { case: { case_notes: '' } })).after).toBe('third line');
  });

  test('value replaces the whole text (trimmed); "" clears, with its own mode', async () => {
    const out = await run(caseAlerts({ value: '  Hard of hearing — call, do not text  ' }));
    expect(out).toMatchObject({ field: 'case_alerts', mode: 'replace', after: 'Hard of hearing — call, do not text', expected: { case_alerts: '' }, max: 5000 });
    const clear = await run(caseNotes({ append: undefined, value: '' }));
    expect(clear).toMatchObject({ mode: 'clear', after: '', after_length: 0, expected: { case_notes: 'first line\nsecond line' } });
    expect(Object.keys(clear)).not.toContain('append');
  });

  test('contact notes: the contact is the target — name, kind, linked-case count — never a case', async () => {
    const out = await run(contactNotes());
    expect(out).toMatchObject({
      kind: 'contact.notes.update.v1', field: 'contact_notes', mode: 'append', after: 'Prefers email\nTexts after 5pm',
      expected: { contact_notes: 'Prefers email' },
      target: { type: 'contact', contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person', case_count: 2 },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_SSN);
  });

  test('a case card names the case and ONLY its Primary/Secondary clients, by name — never another contact column', async () => {
    const out = await run(caseNotes());
    expect(out.target).toEqual({ type: 'case', case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Chapter 7', clients: ['Dana Client', 'Sam Client'] });
    expect(JSON.stringify(out)).not.toContain(SECRET_SSN);
  });
});

describe('the refusal table', () => {
  test('unknown keys refuse BY NAME, including another column of the same record', async () => {
    await refuse(caseNotes({ case_status: 'Closed' }), /case notes edit carries unsupported fields: case_status — it takes case_id, value or append, and evidence only \(it writes case_notes and nothing else\)/);
    await refuse(caseAlerts({ case_notes: 'x', field: 'case_alerts' }), /unsupported fields: case_notes, field/);
    await refuse(contactNotes({ contact_ssn: '1', contact_fname: 'x' }), /contact notes edit carries unsupported fields: contact_ssn, contact_fname/);
    await refuse(contactNotes({ case_id: CASE_ID }), /unsupported fields: case_id/);
  });

  test('exactly one of value / append; text only; an empty append', async () => {
    await refuse(caseNotes({ value: 'x' }), /takes exactly one of value \(the COMPLETE new text; "" clears it\) or append/);
    const neither = caseNotes(); delete neither.append;
    await refuse(neither, /takes exactly one of value/);
    await refuse(caseNotes({ append: '   ' }), /case notes append is empty/);
    await refuse(caseNotes({ append: ['x'] }), /case notes append must be text/);
    await refuse(contactNotes({ append: undefined, value: 5 }), /contact notes value must be text/);
    // A key the model sent as null is absent, so the other one governs.
    await expect(run(caseNotes({ append: null, value: 'only this' }))).resolves.toMatchObject({ mode: 'replace', after: 'only this' });
    await expect(run(caseNotes({ value: null, append: 'added' }))).resolves.toMatchObject({ mode: 'append', after: 'first line\nsecond line\nadded' });
  });

  test('over-cap counts the WHOLE result: notes at noteLimits\' cap, alerts at 5000', async () => {
    expect(NOTE_MAX_CHARS).toBe(10000);
    await expect(run(caseNotes({ append: undefined, value: 'x'.repeat(NOTE_MAX_CHARS) }))).resolves.toMatchObject({ after_length: NOTE_MAX_CHARS });
    await refuse(caseNotes({ append: undefined, value: 'x'.repeat(NOTE_MAX_CHARS + 1) }), /case notes would be 10,001 characters — the limit is 10,000\. Nothing is proposed/);
    // 9,995 stored + newline + 5 = 10,001: the append itself is small.
    await refuse(caseNotes({ append: 'abcde' }), /would be 10,001 characters — the limit is 10,000 \(it holds 9,995 now\)/, { case: { case_notes: 'y'.repeat(9995) } });
    await expect(run(caseAlerts({ value: 'a'.repeat(5000) }))).resolves.toMatchObject({ after_length: 5000 });
    await refuse(caseAlerts({ value: 'a'.repeat(5001) }), /case alerts would be 5,001 characters — the limit is 5,000/);
    await refuse(contactNotes({ append: undefined, value: 'c'.repeat(NOTE_MAX_CHARS + 1) }), /contact notes would be 10,001 characters/);
    // A clear is always within the cap, even of an over-long stored alert.
    await expect(run(caseAlerts({ value: '' }), { case: { case_alerts: 'z'.repeat(6000) } })).resolves.toMatchObject({ mode: 'clear', before_length: 6000 });
  });

  test('a no-op refuses; so does a clear of an empty field', async () => {
    await refuse(caseNotes({ append: undefined, value: ' first line\nsecond line ' }), /does not change the case notes/);
    await refuse(caseAlerts({ value: '' }), /does not change the case alerts/);
  });

  test('evidence must carry the exact id; the id must be well formed; the record must exist', async () => {
    await refuse(caseNotes({ evidence: contactEv }), new RegExp(`evidence does not identify case ${CASE_ID} — cite a row carrying its exact case_id`));
    // Case-sensitive in the evidence (the DB would find it; the citation must match).
    await refuse(caseNotes({ case_id: CASE_ID.toLowerCase() }), /evidence does not identify case 7kq2m9xa/);
    await refuse(caseNotes({ case_id: 'bad id!' }), /needs the case's exact case_id/);
    await refuse(caseNotes({ case_id: 'X'.repeat(21) }), /needs the case's exact case_id/);
    await refuse(caseNotes(), new RegExp(`Case ${CASE_ID} no longer exists`), { caseMissing: true });
    await refuse(contactNotes({ evidence: caseEv }), /evidence does not identify contact 77/);
    await refuse(contactNotes({ contact_id: '77x' }), /needs the contact's exact positive contact_id/);
    await refuse(contactNotes(), /Contact 77 no longer exists/, { contactMissing: true });
    await refuse(caseNotes({ evidence: [] }), /needs 1-8 evidence references/);
  });
});

describe('the request detector forces a draft for note / alert edits only', () => {
  test('edit requests on case/contact notes and alerts force; questions and bare notes do not', () => {
    for (const q of ['Add a note to the case that the client is sending pay stubs Friday',
      'Update the case alerts on 25-12345 to say hard of hearing', 'Clear the alert on this case',
      "Append to Dana's contact notes: prefers texts", 'Put a note on the client file saying no calls before 10']) {
      expect({ q, forced: taskDraftRequested(q) }).toEqual({ q, forced: true });
    }
    for (const q of ['What do the case notes say?', 'Show me the alerts on case 25-12345',
      'Does the client have any notes?', 'Summarize the notes for this contact']) {
      expect({ q, forced: taskDraftRequested(q) }).toEqual({ q, forced: false });
    }
  });
});

describe('the ledger: a string receipt for the two case kinds only', () => {
  function ledgerDb(kind, { status = 'in_flight', result = null } = {}) {
    const updates = [];
    return {
      updates,
      getConnection: () => {},
      query: jest.fn(async (sql, params) => {
        if (/^SELECT kind, claim_token, status, result FROM assistant_action_ledger/.test(sql.trim())) {
          return [[{ kind, claim_token: TOKEN, status, result }]];
        }
        if (/^UPDATE assistant_action_ledger SET status = 'applied'/.test(sql.trim())) { updates.push(params[0]); return [{ affectedRows: 1 }]; }
        throw new Error(`unexpected ledger query ${sql}`);
      }),
    };
  }
  const DRAFT = '6a6a6a6a-1b2c-4d3e-8f40-123456789abc';
  const TOKEN = '7b7b7b7b-1b2c-4d3e-8f40-123456789abc';

  test('registry: case kinds receipt case_id (the one string field), contact notes contact_id', () => {
    expect(['case.notes.update.v1', 'case.alerts.update.v1', 'contact.notes.update.v1'].map((k) => ledger.KINDS.get(k))).toEqual(['case_id', 'case_id', 'contact_id']);
    expect([...ledger.STRING_RECEIPT_FIELDS.keys()]).toEqual(['case_id']);
  });

  test('a case receipt records as the exact string; a number, a malformed or an extra key refuses', async () => {
    for (const kind of ['case.notes.update.v1', 'case.alerts.update.v1']) {
      const db = ledgerDb(kind);
      await expect(ledger.record(db, 6, DRAFT, TOKEN, { case_id: CASE_ID })).resolves.toEqual({ outcome: 'applied', replayed: false });
      expect(db.updates).toEqual([JSON.stringify({ case_id: CASE_ID })]);
      // A legacy mixed-case id with '-' is a real case id too.
      await expect(ledger.record(ledgerDb(kind), 6, DRAFT, TOKEN, { case_id: 'aB-x_9' })).resolves.toMatchObject({ outcome: 'applied' });
      for (const bad of [{ case_id: 12345678 }, { case_id: '' }, { case_id: 'bad id' }, { case_id: 'X'.repeat(21) }, { case_id: CASE_ID, x: 1 }]) {
        await expect(ledger.record(ledgerDb(kind), 6, DRAFT, TOKEN, bad)).rejects.toThrow(/^Invalid action receipt$/);
      }
    }
    // Replay of the same string is a replay; another string cannot replace it.
    await expect(ledger.record(ledgerDb('case.notes.update.v1', { status: 'applied', result: JSON.stringify({ case_id: CASE_ID }) }), 6, DRAFT, TOKEN, { case_id: CASE_ID }))
      .resolves.toEqual({ outcome: 'applied', replayed: true });
    await expect(ledger.record(ledgerDb('case.notes.update.v1', { status: 'applied', result: JSON.stringify({ case_id: CASE_ID }) }), 6, DRAFT, TOKEN, { case_id: 'OTHER123' }))
      .rejects.toThrow(/cannot be replaced/);
  });

  test('every INTEGER family still refuses a string receipt (contact notes included)', async () => {
    for (const [kind, field] of ledger.KINDS) {
      if (ledger.STRING_RECEIPT_FIELDS.has(field)) continue;
      await expect(ledger.record(ledgerDb(kind), 6, DRAFT, TOKEN, { [field]: '77' })).rejects.toThrow(/^Invalid action receipt$/);
      await expect(ledger.record(ledgerDb(kind), 6, DRAFT, TOKEN, { [field]: 'ABC123' })).rejects.toThrow(/^Invalid action receipt$/);
    }
    await expect(ledger.record(ledgerDb('contact.notes.update.v1'), 6, DRAFT, TOKEN, { contact_id: 77 })).resolves.toMatchObject({ outcome: 'applied' });
  });
});
