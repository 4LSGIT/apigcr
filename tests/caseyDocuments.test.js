'use strict';
/**
 * tests/caseyDocuments.test.js
 *
 * A11 — Casey changes ONE registered document's staff title / type / tags, or
 * links ONE document to ONE case or contact, through reviewed cards:
 *   document.update.v1 → PATCH /api/documents/:id {title?, doc_type?, tags?}
 *   document.link.v1   → POST  /api/documents/:id/links {link_type, link_id, relation?}
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builders, the click-time re-read, the outcome mapping — is in
 * tests/assistantUi.test.js):
 *   1. the casey_documents_enabled switch ('0' = dark; unset = on);
 *   2. STATUS and the provider-owned columns (name / path / external_id /
 *      shared_link) refused by name before anything is read; unknown keys;
 *   3. the update: at least one field; the width rule in CHARACTERS (and for
 *      tags on the normalizeTags form the service stores); a no-op by the
 *      service's own compare (trimmed, NULL = ''); a deleted / missing /
 *      gone document; the evidence citing document_id (a string id too —
 *      the report pool returns BIGINT as a string);
 *   4. the link: case / contact only; relation 'path' refused by name, any
 *      other plain word disclosed; both rows cited; an existing link refused
 *      (folded like the general_ci UNIQUE key); > 20 links refused, 5+
 *      disclosed; where it shows (resolveRelatedTargets); the triage effect;
 *   5. both events dry-run with the service's own envelopes; expected; the
 *      ledger receipts; the request detector.
 *
 * The SQL, the route behaviour the refusals rest on (silent clip, duplicate =
 * success, the UNIQUE key, the related predicate) and the browser's re-read
 * over the real GET run on a real engine in tests/caseyDocuments.mysql.test.js.
 *
 *   npx jest tests/caseyDocuments.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const UPDATED = new Date('2026-10-30T12:00:00Z');

function baseDocs() {
  return {
    88412: { id: 88412, source: 'dropbox', external_id: 'id:abc', name: 'Petition.pdf', path: '/Active Cases/Debtor, Dana/Petition.pdf', ext: 'pdf',
      size: 1258291, server_modified: new Date('2026-01-02T10:00:00Z'), title: null, doc_type: null, tags: null, status: 'active',
      pending_delete_at: null, updated_at: UPDATED },
    88413: { id: 88413, source: 'dropbox', external_id: 'id:def', name: 'Old.pdf', path: '/x/Old.pdf', ext: 'pdf', size: 10,
      server_modified: null, title: 'Old', doc_type: null, tags: null, status: 'deleted', pending_delete_at: null, updated_at: UPDATED },
    88414: { id: 88414, source: 'dropbox', external_id: 'id:ghi', name: 'Lost.pdf', path: '/x/Lost.pdf', ext: 'pdf', size: 10,
      server_modified: null, title: null, doc_type: null, tags: null, status: 'missing', pending_delete_at: null, updated_at: UPDATED },
  };
}
const baseLinks = () => ({ 88412: [{ id: 501, link_type: 'case', link_id: CASE_ID, relation: 'path', created_by: null }] });

function makeDb(over = {}) {
  const docs = over.docs || baseDocs();
  const links = over.links || baseLinks();
  const relate = over.relate || [{ case_id: CASE_ID, contact_id: 77, type: 'Primary' }, { case_id: CASE_ID, contact_id: 78, type: 'Secondary' }];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT id, source, external_id, name, path, ext, size, server_modified, title, doc_type, tags, status, pending_delete_at, updated_at FROM documents WHERE id = ? LIMIT 1') {
      const d = docs[Number(params[0])];
      return [d ? [{ ...d }] : []];
    }
    if (flat === 'SELECT id, link_type, link_id, relation, created_by, created_at FROM document_links WHERE document_id = ? ORDER BY created_at DESC, id DESC') {
      return [(links[Number(params[0])] || []).map((l) => ({ ...l }))];
    }
    if (flat === "SELECT case_id, COALESCE(NULLIF(case_number_full, ''), NULLIF(case_number, ''), case_id) AS label FROM cases WHERE case_id IN (?)") {
      return [params[0].filter((id) => id.toLowerCase() === CASE_ID.toLowerCase()).map(() => ({ case_id: CASE_ID, label: '25-12345-abc' }))];
    }
    if (flat === "SELECT contact_id, COALESCE(NULLIF(contact_name, ''), CONCAT('#', contact_id)) AS label FROM contacts WHERE contact_id IN (?)") {
      const names = { 77: 'Dana Debtor', 78: 'Sam Debtor' };
      return [params[0].filter((id) => names[id]).map((id) => ({ contact_id: id, label: names[id] }))];
    }
    if (flat === 'SELECT COUNT(*) AS n FROM documents WHERE doc_type = ? AND id <> ?') return [[{ n: over.typeCount || 0 }]];
    if (flat === 'SELECT COUNT(*) AS n FROM document_links WHERE relation = ?') return [[{ n: (over.relationCounts || { upload: 4 })[params[0]] || 0 }]];
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') {
      return [String(params[0]).toLowerCase() === CASE_ID.toLowerCase() && !over.caseMissing
        ? [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Chapter 7' }] : []];
    }
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1') {
      return [Number(params[0]) === 77 && !over.contactMissing ? [{ contact_id: 77, contact_name: 'Dana Debtor' }] : []];
    }
    if (flat === 'SELECT case_relate_client_id AS rel_id, case_relate_type AS rel_type FROM case_relate WHERE case_relate_case_id = ?') {
      return [relate.filter((r) => r.case_id === params[0]).map((r) => ({ rel_id: r.contact_id, rel_type: r.type }))];
    }
    if (flat === 'SELECT case_relate_case_id AS rel_id, case_relate_type AS rel_type FROM case_relate WHERE case_relate_client_id = ?') {
      return [relate.filter((r) => r.contact_id === params[0]).map((r) => ({ rel_id: r.case_id, rel_type: r.type }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

// q1 = a documents read (document_id; one a STRING, as the report pool's
// bigNumberStrings returns BIGINT), q2 = a case read, q3 = a contact read.
const EVIDENCE = [
  { id: 'q1', rows: [{ document_id: 88412 }, { document_id: '88413' }, { document_id: 88414 }, { document_id: '88412' }, { document_id: 88499 }] },
  { id: 'q2', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
  { id: 'q3', rows: [{ contact_id: 77, contact_name: 'Dana Debtor' }] },
];
const docRow = (id) => ({ 88412: 1, 88413: 2, 88414: 3, 88499: 5 }[id]);
const update = (over = {}) => ({ kind: 'document.update.v1', document_id: 88412, title: 'Chapter 7 petition (filed)',
  evidence: [{ query_id: 'q1', row_number: docRow(over.document_id || 88412) }], ...over });
const link = (over = {}) => ({ kind: 'document.link.v1', document_id: 88412, link_type: 'contact', link_id: 77,
  evidence: [{ query_id: 'q1', row_number: docRow(over.document_id || 88412) }, { query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: 1 }], ...over });

let spies = [];
function rulesFor(map = {}) {
  spies.push(jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => (map[ev] || []).map((r) => ({ ...r }))));
}
beforeEach(() => { delete process.env.CASEY_DOCUMENTS_ENABLED; rulesFor(); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_DOCUMENTS_ENABLED; });

const run = (value, dbOver, evidence = EVIDENCE, userId = ME) => normalizeActionDraft(makeDb(dbOver), value, evidence, { currentUserId: userId });
const refuse = (value, re, dbOver, evidence, userId) => expect(run(value, dbOver, evidence, userId)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes both kinds unavailable; unset is ON", async () => {
    process.env.CASEY_DOCUMENTS_ENABLED = '0';
    for (const v of [update(), link()]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_DOCUMENTS_ENABLED;
    for (const v of [update(), link()]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('STATUS and the provider-owned columns — refused by name before anything is read', () => {
  test.each([
    ['status on an update', () => update({ status: 'deleted' }), /^STATUS refused: deleting, restoring or marking a document missing is not available to Casey .* \(document\.update\.v1\)$/],
    ['status on a link', () => link({ status: 'active' }), /^STATUS refused: .*\(document\.link\.v1\)$/],
    ['shared_link', () => update({ shared_link: 'https://x' }), /^SHARED LINK refused: the stored link is never written directly — Dropbox makes a public link, through a document\.share\.v1 card \(the Documents page's Copy public link button\) \(document\.update\.v1\)$/],
    ['name', () => update({ name: 'New.pdf' }), /^NAME refused: a document's file name, path and Dropbox id belong to Dropbox/],
    ['path and external_id together', () => update({ path: '/y', external_id: 'id:z' }), /^PATH \/ EXTERNAL_ID refused: /],
  ])('%s', async (_n, make, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, make(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('an unknown key is refused, naming what the kind takes', async () => {
    await refuse(update({ size: 1 }), /^A document\.update\.v1 card carries unsupported fields: size — it takes document_id, title, doc_type, tags, evidence only$/);
    await refuse(link({ created_by: 1 }), /^A document\.link\.v1 card carries unsupported fields: created_by — it takes document_id, link_type, link_id, relation, evidence only$/);
  });
});

describe('the update card — shape, width, evidence, state', () => {
  test('at least one field; text only; a positive document_id', async () => {
    await refuse(update({ title: undefined }), /^A document update needs "title", "doc_type" or "tags" \(or several\) — send "" to clear one$/);
    await refuse(update({ title: 5 }), /^The title must be text$/);
    await refuse(update({ tags: ['a', 3] }), /^The tags must be text \(comma-separated\) or a list of words$/);
    await refuse(update({ document_id: 'x' }), /^A document card needs the document's exact positive document_id/);
  });
  test('width in CHARACTERS (code points, as the column and the service count) — the service would clip silently', async () => {
    await expect(run(update({ title: '\u{1F600}'.repeat(255) }))).resolves.toMatchObject({ changes: { title: { to: '\u{1F600}'.repeat(255) } } });
    await refuse(update({ title: 'x'.repeat(256) }), /^The title is 256 characters — the column keeps 255, and the Documents page would save it cut short\. Nothing is proposed$/);
    await refuse(update({ title: undefined, doc_type: 't'.repeat(65) }), /^The type is 65 characters — the column keeps 64/);
  });
  test('tags: the width rule applies to the STORED (normalizeTags) form', async () => {
    const wide = Array.from({ length: 103 }, (_, i) => `tag${String(i).padStart(2, '0')}`).join(',');
    await refuse(update({ title: undefined, tags: wide }), /^The tags are \d+ characters as stored — the column keeps 512/);
    // 705 characters as typed (trimmed) that store as one short tag.
    const card = await run(update({ title: undefined, tags: `Court${', court'.repeat(100)}` }));
    expect(card.changes.tags).toEqual({ from: null, to: 'court' });
  });
  test('the evidence cites the exact document_id — a string id from the report pool counts', async () => {
    await refuse(update({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The document evidence does not identify document #88412 — cite a row carrying its exact document_id \(read it first: documents\.id AS document_id\)$/);
    await expect(run(update({ evidence: [{ query_id: 'q1', row_number: 4 }] }))).resolves.toMatchObject({ document: { document_id: 88412 } });
  });
  test('a deleted, missing or gone document is refused', async () => {
    await refuse(update({ document_id: 88413 }), /^Document #88413 \("Old"\) is deleted — Casey edits active documents only/);
    await refuse(update({ document_id: 88414 }), /^Document #88414 \("Lost\.pdf"\) is missing — Casey edits active documents only/);
    await refuse(update({ document_id: 88499 }), /^Document #88499 no longer exists$/);
  });
  test('a no-op is refused by the service\'s own compare (trimmed; NULL and "" equal)', async () => {
    const docs = baseDocs(); docs[88412].title = 'Petition';
    await refuse(update({ title: '  Petition ' }), /^Document #88412 \("Petition"\) already has that title — that changes nothing$/, { docs });
    await refuse(update({ title: '' }), /already has that title — that changes nothing/);
    await refuse(update({ title: undefined, tags: ' , ' }), /already has that tag set — that changes nothing/);
  });
});

describe('the update card — what it shows', () => {
  test('changes, links, effects, expected — and the dry run of document.updated with the service\'s envelope', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.updated': [{ id: 41, name: 'Petition typed → task', cooling_down: 0, actions: [{ action_type: 'workflow', config: { workflow_id: 7 } }] },
      { id: 42, name: 'Other', cooling_down: 0, actions: [] }] });
    const seen = [];
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (rule, env) => { seen.push(env); return { matched: rule.id === 41 }; }));
    const card = await run(update({ doc_type: 'petition', tags: 'Court Filed, court' }), { typeCount: 3 });
    expect(card).toMatchObject({
      kind: 'document.update.v1',
      document: { document_id: 88412, name: 'Petition.pdf', path: '/Active Cases/Debtor, Dana/Petition.pdf', ext: 'pdf', size: 1258291,
        source: 'dropbox', server_modified: '2026-01-02T10:00:00.000Z', title: null, status: 'active', pending_delete_at: null },
      changes: { title: { from: null, to: 'Chapter 7 petition (filed)' }, doc_type: { from: null, to: 'petition' }, tags: { from: null, to: 'court-filed,court' } },
      links: [{ document_link_id: 501, link_type: 'case', link_id: CASE_ID, relation: 'path', label: 'case 25-12345-abc' }], links_total: 1,
      automation: { events: ['document.updated'], rules_checked: 2, quiet: 1, lines: ['Trigger rule #41 "Petition typed → task" runs: starts workflow #7'] },
      warnings: [],
      expected: { title: null, doc_type: null, tags: null, status: 'active', updated_at: '2026-10-30T12:00:00.000Z' },
    });
    expect(card.document).not.toHaveProperty('external_id');
    expect(card.effects).toEqual([
      'Tags are stored lowercase, spaces as hyphens, comma-separated and deduplicated: "Court Filed, court" is saved as "court-filed,court".',
      'Type "petition" is already on 3 other documents — the Documents page\'s type filter groups them.',
      'Shows on: the Documents page and the Documents tab of each record it is linked to (listed), and — under "Include related", on by default — on those records\' related cases and contacts.',
      'Search: the Documents page\'s search matches the new title (title, file name and tags are searched).',
      'Staff only: the client portal does not list registered documents.',
      'Trigger event: document.updated fires — every active rule on it is listed below.']);
    // documentService.update's envelope: source manual, the actor, _eventData of the row after, the diff.
    const env = seen[0];
    expect([env.event, env.source, env.actor, env.data, env.changes, env.extra]).toEqual(['document.updated', 'manual', { user_id: ME },
      { id: 88412, source: 'dropbox', external_id: 'id:abc', name: 'Petition.pdf', path: '/Active Cases/Debtor, Dana/Petition.pdf', doc_type: 'petition', tags: 'court-filed,court', status: 'active' },
      { title: { from: null, to: 'Chapter 7 petition (filed)' }, doc_type: { from: null, to: 'petition' }, tags: { from: null, to: 'court-filed,court' } },
      { updated_fields: ['title', 'doc_type', 'tags'], via: 'edit' }]);
  });
  test('a field already equal is not sent (an effect says so); a NEW type is disclosed; clearing tags carries NULL in the envelope', async () => {
    const docs = baseDocs(); Object.assign(docs[88412], { title: 'Petition', tags: 'court' });
    const seen = [];
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.updated': [{ id: 41, name: 'r', actions: [] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (_r, env) => { seen.push(env); return { matched: false }; }));
    const card = await run(update({ title: 'Petition', doc_type: 'petition', tags: '' }), { docs, links: {} });
    expect(card.changes).toEqual({ doc_type: { from: null, to: 'petition' }, tags: { from: 'court', to: '' } });
    expect(card.effects.slice(0, 3)).toEqual(['Title: already "Petition" — not sent.',
      'Type "petition" is NEW — no other document has it (the Documents page\'s type filter matches it exactly).',
      'Shows on: the Documents page only — the document is linked to no case or contact.']);
    expect(card.effects).not.toContain('Search: the Documents page\'s search matches the new title (title, file name and tags are searched).');
    expect([seen[0].data.tags, seen[0].changes]).toEqual([null, { doc_type: { from: null, to: 'petition' }, tags: { from: 'court', to: null } }]);
  });
  test('warnings: a pending delete, five or more links, a rule that cannot be evaluated', async () => {
    const docs = baseDocs(); docs[88412].pending_delete_at = new Date('2026-11-01T09:00:00Z');
    const links = { 88412: Array.from({ length: 5 }, (_, i) => ({ id: 600 + i, link_type: 'contact', link_id: String(90 + i), relation: 'upload', created_by: 6 })) };
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.updated': [{ id: 41, name: 'Code rule', actions: [{ action_type: 'hook', config: { slug: 'x' } }] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async () => ({ match_error: 'GUEST_CODE_BUSY' })));
    const card = await run(update(), { docs, links });
    expect(card.warnings).toEqual([
      'PENDING DELETE: Dropbox reported this file deleted (2026-11-01T09:00:00.000Z). Unless it reappears within about 30 minutes of that, the registry marks it deleted and it leaves every Documents list.',
      'MANY LINKS: this document is already linked to 5 records — it already shows on each of their Documents tabs.',
      'AUTOMATION: at least one trigger rule could not be evaluated for this edit — read its line; it may run.']);
    expect(card.automation.lines).toEqual(['Trigger rule #41 "Code rule" could not be evaluated for this edit (GUEST_CODE_BUSY) — it MAY run: runs hook "x"']);
    expect(card.links.map((l) => l.label)).toEqual(['contact 90 (not found)', 'contact 91 (not found)', 'contact 92 (not found)', 'contact 93 (not found)', 'contact 94 (not found)']);
    spies.forEach((s) => s.mockRestore()); spies = []; rulesFor();
    const four = await run(update(), { links: { 88412: links[88412].slice(0, 4) } });
    expect(four.warnings).toEqual([]);
  });
});

describe('the link card — shape and refusals', () => {
  test('case or contact only; exact ids', async () => {
    await refuse(link({ link_type: 'appt', link_id: 5 }), /^A document link to "appt" is not available — Casey links a document to a case \(link_type "case", link_id = the exact case_id\) or a contact/);
    await refuse(link({ link_type: undefined }), /^A document link to nothing is not available/);
    await refuse(link({ link_type: 'case', link_id: 'bad id!' }), /^A case link needs link_id = the case's exact case_id$/);
    await refuse(link({ link_id: 'Dana' }), /^A contact link needs link_id = the contact's exact positive contact_id$/);
  });
  test('relation: "path" refused by name (the sync\'s mark); one plain word otherwise; folded to lowercase', async () => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, link({ relation: 'path' }), EVIDENCE, { currentUserId: ME })).rejects.toThrow(/^RELATION "path" refused: "path" is the Dropbox sync's own mark/);
    expect(db.query).not.toHaveBeenCalled();
    await refuse(link({ relation: 'Path' }), /^RELATION "path" refused/);
    await refuse(link({ relation: 'two words' }), /^relation must be one short plain word \(letters, digits, - or _, up to 32 characters\) — got "two words"$/);
    await refuse(link({ relation: 'a'.repeat(33) }), /^relation must be one short plain word/);
    await refuse(link({ relation: 3 }), /^relation must be one short word$/);
    await expect(run(link({ relation: ' Upload ' }))).resolves.toMatchObject({ link: { relation: 'upload' } });
  });
  test('both rows cited: the document AND the target', async () => {
    await refuse(link({ evidence: [{ query_id: 'q3', row_number: 1 }] }), /^The link evidence does not identify document #88412 — cite a row carrying its exact document_id/);
    await refuse(link({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /^The link evidence does not identify contact 77 — cite a row carrying its exact contact_id \(read the contact first\)$/);
    await refuse(link({ link_type: 'case', link_id: CASE_ID.toLowerCase(), evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }),
      /^The link evidence does not identify case 7kq2m9xa — cite a row carrying its exact case_id/);
  });
  test('a gone target or a non-active document is refused', async () => {
    await refuse(link(), /^Contact 77 no longer exists$/, { contactMissing: true });
    await refuse(link({ link_type: 'case', link_id: CASE_ID }), /^Case 7KQ2M9XA no longer exists$/, { caseMissing: true });
    await refuse(link({ document_id: 88413 }), /^Document #88413 \("Old"\) is deleted — Casey links active documents only/);
  });
  test('a link that already exists is refused — folded the way the general_ci UNIQUE key compares', async () => {
    await refuse(link({ link_type: 'case', link_id: CASE_ID }), /^Document #88412 \("Petition\.pdf"\) is already linked to case 25-12345-abc \(link #501, relation "path"\) — nothing is proposed$/);
    const links = { 88412: [{ id: 502, link_type: 'case', link_id: CASE_ID.toLowerCase(), relation: null, created_by: 6 }] };
    await refuse(link({ link_type: 'case', link_id: CASE_ID }), /is already linked to case 25-12345-abc \(link #502\) — nothing is proposed$/, { links });
  });
  test('more than 20 links is refused; 20 is reviewable with a warning', async () => {
    const many = (n) => ({ 88412: Array.from({ length: n }, (_, i) => ({ id: 700 + i, link_type: 'contact', link_id: String(100 + i), relation: null, created_by: 6 })) });
    await refuse(link(), /^Document #88412 is already linked to 21 records — more than one card can review \(20\)\. The user links it on the Documents page$/, { links: many(21) });
    const card = await run(link(), { links: many(20) });
    expect(card.warnings).toEqual(['MANY LINKS: this document is already linked to 20 records — it already shows on each of their Documents tabs.']);
  });
});

describe('the link card — what it shows', () => {
  test('a contact link: the target, relation note, where it shows (each case of the contact), the dry run of document.linked', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.linked': [{ id: 51, name: 'Filed to client → note', cooling_down: 0, actions: [{ action_type: 'internal_function', config: { function_name: 'create_log' } }] }] });
    const seen = [];
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (_r, env) => { seen.push(env); return { matched: true }; }));
    const card = await run(link({ relation: 'upload' }));
    expect(card).toMatchObject({
      kind: 'document.link.v1',
      target: { link_type: 'contact', link_id: '77', contact_id: 77, contact_name: 'Dana Debtor', label: 'Dana Debtor (contact #77)' },
      link: { link_type: 'contact', link_id: '77', relation: 'upload' },
      relation_note: '"upload" — already on 4 links',
      links_before: [{ document_link_id: 501, link_type: 'case', link_id: CASE_ID, relation: 'path', label: 'case 25-12345-abc' }], links_total: 1,
      visibility: [
        'Dana Debtor (contact #77)\'s Documents tab — listed directly.',
        'Under "Include related" (on by default): the Documents tab of each case this contact is on — case 25-12345-abc (Primary on the case) — badged "via Dana Debtor (contact #77)".',
        'Staff only: the client portal does not list registered documents.'],
      automation: { events: ['document.linked'], rules_checked: 1, quiet: 0, lines: ['Trigger rule #51 "Filed to client → note" runs: calls create_log'] },
      warnings: [],
      expected: { status: 'active', links: ['501:case:7KQ2M9XA:path'] },
    });
    expect(card.effects).toEqual([
      'Kept: a link you make is a person\'s link — the Dropbox sync never removes it, even if the file is moved or renamed; only someone unlinking it does.',
      'Trigger event: document.linked fires — every active rule on it is listed below.']);
    // documentService.link's envelope: the target promoted to a first-class column.
    expect([seen[0].event, seen[0].contact_id, seen[0].case_id, seen[0].source, seen[0].actor, seen[0].extra, seen[0].data.id]).toEqual(
      ['document.linked', 77, null, 'manual', { user_id: ME }, { link_type: 'contact', link_id: '77', relation: 'upload' }, 88412]);
  });
  test('a case link: each contact on the case; the triage effect when it is the first case link; a new relation word', async () => {
    const seen = [];
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.linked': [{ id: 51, name: 'r', actions: [] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (_r, env) => { seen.push(env); return { matched: false }; }));
    const card = await run(link({ link_type: 'case', link_id: CASE_ID, relation: 'retainer' }), { links: {} });
    expect(card.relation_note).toBe('"retainer" — a NEW relation word (no link carries it yet)');
    expect(card.visibility[1]).toBe('Under "Include related" (on by default): the Documents tab of each contact on this case — Dana Debtor (contact #77) (Primary on the case); Sam Debtor (contact #78) (Secondary on the case) — badged "via case 25-12345-abc".');
    expect(card.effects[0]).toBe('Triage: the document has no case link yet, so it leaves the Documents page\'s "no case" list.');
    expect([seen[0].case_id, seen[0].contact_id, seen[0].extra]).toEqual([CASE_ID, null, { link_type: 'case', link_id: CASE_ID, relation: 'retainer' }]);
    expect(card.expected).toEqual({ status: 'active', links: [] });
  });
  test('no relation; a contact on no case; a case with no contacts', async () => {
    const lone = await run(link(), { relate: [] });
    expect([lone.relation_note, lone.link.relation, lone.visibility[1]]).toEqual(['none — the link carries no relation word', null,
      'Under "Include related": this contact is on no case, so no other Documents tab gains it.']);
    expect(lone.effects[0]).toMatch(/^Kept: /);
    const bare = await run(link({ link_type: 'case', link_id: CASE_ID }), { relate: [], links: {} });
    expect(bare.visibility[1]).toBe('Under "Include related": this case has no contacts, so no other Documents tab gains it.');
    // A document that already has a case link does not leave the "no case" list — no triage line.
    const second = await run(link({ link_type: 'case', link_id: CASE_ID }), { links: { 88412: [{ id: 503, link_type: 'case', link_id: 'OTHER123', relation: 'path', created_by: null }] } });
    expect(second.effects[0]).toMatch(/^Kept: /);
    expect(second.effects.some((e) => e.startsWith('Triage:'))).toBe(false);
  });
  test('a rule that cannot be evaluated for the link MAY run — a danger warning', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'document.linked': [{ id: 51, name: 'Code rule', actions: [{ action_type: 'hook', config: { slug: 'x' } }] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async () => ({ match_error: 'GUEST_CODE_BUSY' })));
    const card = await run(link());
    expect(card.automation.lines).toEqual(['Trigger rule #51 "Code rule" could not be evaluated for this link (GUEST_CODE_BUSY) — it MAY run: runs hook "x"']);
    expect(card.warnings).toEqual(['AUTOMATION: at least one trigger rule could not be evaluated for this link — read its line; it may run.']);
  });
});

describe('the ledger, the request detector', () => {
  test('the update receipts the integer document_id; the link the integer document_link_id', () => {
    expect(ledger.KINDS.get('document.update.v1')).toBe('document_id');
    expect(ledger.KINDS.get('document.link.v1')).toBe('document_link_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('document_id')).toBe(false);
    expect(ledger.STRING_RECEIPT_FIELDS.has('document_link_id')).toBe(false);
  });
  test.each([
    'Retitle the petition document to "Chapter 7 petition (filed)"',
    'tag that PDF as court, filed',
    'Link this document to Dana\'s contact',
    'set the type of the scanned paystub to income',
    'file this document under case 25-12345',
  ])('a document request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['Which documents are linked to case 25-12345?', 'How many PDFs did Dana upload?', 'Show me the case file'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(false);
  });
});
