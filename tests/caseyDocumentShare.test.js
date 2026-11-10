'use strict';
/**
 * tests/caseyDocumentShare.test.js
 *
 * A11.2 — Casey shares ONE document (its permanent public Dropbox link) or
 * unlinks ONE document from ONE case or contact, through reviewed cards on the
 * Documents page's own routes:
 *   document.share.v1  → POST   /api/documents/:id/share   (Copy public link)
 *   document.unlink.v1 → DELETE /api/documents/:id/links {link_type, link_id} (Links → Unlink)
 * No status kind: no screen sends a status (the edit dialog saves title / type /
 * tags only) — a named deferral, pinned by the ledger test below.
 *
 * The contract pinned here:
 *   1. the casey_documents_enabled switch covers both kinds; the by-name and
 *      unknown-key refusals run before anything is read;
 *   2. the share: the document row cited; a deleted / missing / gone document
 *      refused; the server reads only WHETHER a link is stored, never the link;
 *      what a link is, NEW LINK vs already shared, revoking, shown-after-apply;
 *      expected;
 *   3. the unlink: case / contact only; exact ids; both rows cited (or the
 *      document_links row); a link the document does not have refused (folded
 *      like the general_ci DELETE); > 20 links refused; a deleted document
 *      disclosed, not refused; where it stops showing (the removed link's
 *      related set minus what the remaining links reach); LINKED TO NOTHING;
 *      the triage effect; COMES BACK when the sync re-adds the case link;
 *   4. the ledger receipts and the request detector;
 *   5. the browser half (lifted from public/assistant.html by name): the fixed
 *      requests, the click-time re-read, the result checks (the link kept off
 *      every serialized field), the outcomes, danger, the applied copy, text.
 *
 * The routes' own behaviour (the share caches the link and a second share is
 * Dropbox's get-or-create; the unlink removes exactly one row; the 404s) runs
 * on a real engine in tests/caseyDocumentShare.mysql.test.js.
 *
 *   npx jest tests/caseyDocumentShare.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const UPDATED = new Date('2026-10-30T12:00:00Z');
const STORED_LINK = 'https://www.dropbox.com/scl/fi/abc123/Petition.pdf?rlkey=XYZ&dl=0';

function baseDocs() {
  const doc = (id, over) => ({ id, source: 'dropbox', external_id: `id:${id}`, ext: 'pdf', size: 10, server_modified: null, title: null, doc_type: null,
    tags: null, status: 'active', pending_delete_at: null, updated_at: UPDATED, shared_link: null, ...over });
  return {
    88412: doc(88412, { name: 'Petition.pdf', path: '/Active Cases/Debtor, Dana/Petition.pdf', size: 1258291, server_modified: new Date('2026-01-02T10:00:00Z'), title: 'Petition', doc_type: 'petition' }),
    88413: doc(88413, { name: 'Old.pdf', path: '/x/Old.pdf', title: 'Old', status: 'deleted' }),
    88414: doc(88414, { name: 'Lost.pdf', path: '/x/Lost.pdf', status: 'missing' }),
    88415: doc(88415, { name: 'Shared.pdf', path: '/Active Cases/Debtor, Dana/Shared.pdf', shared_link: STORED_LINK }),
    88416: doc(88416, { name: 'Paystub.jpg', path: '/Unsorted/Paystub.jpg', ext: 'jpg' }),
  };
}
const baseLinks = () => ({
  88412: [{ id: 501, link_type: 'case', link_id: CASE_ID, relation: 'path', created_by: null },
    { id: 502, link_type: 'contact', link_id: '77', relation: 'upload', created_by: 6 }],
  88413: [{ id: 503, link_type: 'contact', link_id: '77', relation: null, created_by: 6 }],
  88415: [{ id: 504, link_type: 'case', link_id: CASE_ID, relation: 'path', created_by: null }],
  88416: [{ id: 505, link_type: 'contact', link_id: '77', relation: null, created_by: 6 }],
});

function makeDb(over = {}) {
  const docs = over.docs || baseDocs();
  const links = over.links || baseLinks();
  const relate = over.relate || [{ case_id: CASE_ID, contact_id: 77, type: 'Primary' }, { case_id: CASE_ID, contact_id: 78, type: 'Secondary' }];
  const folders = over.folders || { '/active cases/debtor, dana': CASE_ID };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT id, source, external_id, name, path, ext, size, server_modified, title, doc_type, tags, status, pending_delete_at, updated_at FROM documents WHERE id = ? LIMIT 1') {
      const d = docs[Number(params[0])];
      return [d ? [{ ...d }] : []];
    }
    if (flat === 'SELECT id, link_type, link_id, relation, created_by, created_at FROM document_links WHERE document_id = ? ORDER BY created_at DESC, id DESC') {
      return [(links[Number(params[0])] || []).map((l) => ({ ...l }))];
    }
    if (flat === "SELECT (shared_link IS NOT NULL AND shared_link <> '') AS shared FROM documents WHERE id = ? LIMIT 1") {
      const d = docs[Number(params[0])];
      return [d ? [{ shared: d.shared_link ? 1 : 0 }] : []];
    }
    if (flat === 'SELECT path_lower FROM documents WHERE id = ? LIMIT 1') {
      const d = docs[Number(params[0])];
      return [d ? [{ path_lower: d.path == null ? null : d.path.toLowerCase() }] : []];
    }
    if (flat === 'SELECT case_id, path_lower FROM case_folder_cache WHERE path_lower IN (?)') {
      return [params[0].filter((p) => folders[p]).map((p) => ({ case_id: folders[p], path_lower: p }))];
    }
    if (flat === 'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1') {
      expect(params[0]).toBe('documents_sync_enabled');
      return [[{ value: over.syncOff ? '0' : '1' }]];
    }
    if (flat === "SELECT case_id, COALESCE(NULLIF(case_number_full, ''), NULLIF(case_number, ''), case_id) AS label FROM cases WHERE case_id IN (?)") {
      return [params[0].filter((id) => id.toLowerCase() === CASE_ID.toLowerCase()).map(() => ({ case_id: CASE_ID, label: '25-12345-abc' }))];
    }
    if (flat === "SELECT contact_id, COALESCE(NULLIF(contact_name, ''), CONCAT('#', contact_id)) AS label FROM contacts WHERE contact_id IN (?)") {
      const names = { 77: 'Dana Debtor', 78: 'Sam Debtor' };
      return [params[0].filter((id) => names[id]).map((id) => ({ contact_id: id, label: names[id] }))];
    }
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

// q1 = a documents read (one id a STRING — the report pool's BIGINT), q2 = a
// case read, q3 = a contact read, q4 = a document_links read.
const EVIDENCE = [
  { id: 'q1', rows: [{ document_id: 88412 }, { document_id: '88413' }, { document_id: 88414 }, { document_id: 88415 }, { document_id: 88416 }, { document_id: 88499 }] },
  { id: 'q2', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
  { id: 'q3', rows: [{ contact_id: 77, contact_name: 'Dana Debtor' }] },
  { id: 'q4', rows: [{ document_id: '88412', link_type: 'contact', link_id: '77', relation: 'upload' }] },
];
const docRow = (id) => ({ 88412: 1, 88413: 2, 88414: 3, 88415: 4, 88416: 5, 88499: 6 }[id]);
const share = (over = {}) => ({ kind: 'document.share.v1', document_id: 88412, evidence: [{ query_id: 'q1', row_number: docRow(over.document_id || 88412) }], ...over });
const unlink = (over = {}) => ({ kind: 'document.unlink.v1', document_id: 88412, link_type: 'contact', link_id: 77,
  evidence: [{ query_id: 'q1', row_number: docRow(over.document_id || 88412) }, { query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: 1 }], ...over });

beforeEach(() => { delete process.env.CASEY_DOCUMENTS_ENABLED; });
afterEach(() => { delete process.env.CASEY_DOCUMENTS_ENABLED; });

const run = (value, dbOver, evidence = EVIDENCE) => normalizeActionDraft(makeDb(dbOver), value, evidence, { currentUserId: ME });
const refuse = (value, re, dbOver, evidence) => expect(run(value, dbOver, evidence)).rejects.toThrow(re);

describe('the switch and the refusals before anything is read', () => {
  test("'0' makes both kinds unavailable; unset is ON", async () => {
    process.env.CASEY_DOCUMENTS_ENABLED = '0';
    for (const v of [share(), unlink()]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_DOCUMENTS_ENABLED;
    for (const v of [share(), unlink()]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
  test.each([
    ['status on a share', () => share({ status: 'deleted' }), /^STATUS refused: deleting, restoring or marking a document missing is not available to Casey — and no screen does it either: the Documents page's edit dialog saves only the title, type and tags, .* \(document\.share\.v1\)$/],
    ['a link on a share', () => share({ shared_link: 'https://x' }), /^SHARED LINK refused: the stored link is never written directly — Dropbox makes a public link, through a document\.share\.v1 card .* \(document\.share\.v1\)$/],
    ['status on an unlink', () => unlink({ status: 'active' }), /^STATUS refused: .*\(document\.unlink\.v1\)$/],
    ['path on an unlink', () => unlink({ path: '/y' }), /^PATH refused: /],
    ['an unknown key on a share', () => share({ title: 'x' }), /^A document\.share\.v1 card carries unsupported fields: title — it takes document_id, evidence only$/],
    ['an unknown key on an unlink', () => unlink({ relation: 'upload' }), /^A document\.unlink\.v1 card carries unsupported fields: relation — it takes document_id, link_type, link_id, evidence only$/],
  ])('%s', async (_n, make, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, make(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the share card', () => {
  test('evidence cites the exact document_id; a deleted, missing or gone document is refused', async () => {
    await refuse(share({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The share evidence does not identify document #88412 — cite a row carrying its exact document_id/);
    await refuse(share({ document_id: 88413 }), /^Document #88413 \("Old"\) is deleted — Casey shares active documents only \(the Dropbox sync marks a document deleted/);
    await refuse(share({ document_id: 88414 }), /^Document #88414 \("Lost\.pdf"\) is missing — Casey shares active documents only/);
    await refuse(share({ document_id: 88499 }), /^Document #88499 no longer exists$/);
    await refuse(share({ document_id: 0 }), /^A document card needs the document's exact positive document_id/);
  });
  test('a first share: what a link is, NEW LINK, revoking, shown after apply, expected — and the server never reads the link', async () => {
    const db = makeDb();
    const card = await normalizeActionDraft(db, share(), EVIDENCE, { currentUserId: ME });
    expect(card).toMatchObject({
      kind: 'document.share.v1', shared: false,
      document: { document_id: 88412, name: 'Petition.pdf', title: 'Petition', doc_type: 'petition', status: 'active' },
      links: [{ document_link_id: 501, label: 'case 25-12345-abc', relation: 'path' }, { document_link_id: 502, label: 'Dana Debtor (contact #77)', relation: 'upload' }],
      links_total: 2,
      expected: { status: 'active', shared: false, name: 'Petition.pdf', title: 'Petition', doc_type: 'petition', links: ['501:case:7KQ2M9XA:path', '502:contact:77:upload'] },
    });
    expect(card.warnings).toEqual([
      'PUBLIC LINK: applying asks Dropbox for a PERMANENT link to this file. Anyone who holds the link can open and download the file — no login, it does not expire, and YisraCase records nothing about who opens it.',
      'NEW LINK: no public link is stored for this document yet. Dropbox hands back the link it already has for the file if one was made outside YisraCase (with whatever settings it was made with); otherwise it creates a NEW PUBLIC link.']);
    expect(card.effects).toEqual([
      'Revoking: only in Dropbox (the file\'s sharing settings) — YisraCase has no control for it. A revoked link stays stored on the document, and the Documents page\'s Copy public link button keeps copying it (that button never asks Dropbox again once a link is stored) until a share card replaces it.',
      'Shown after you apply: this card never shows or guesses the link. Dropbox\'s answer is shown on this card, in this browser only (it is not saved in the chat and never sent to Casey), with a button to copy it; the Documents page\'s Copy public link button copies it any time.',
      'Stored: the link is saved on the document; Casey\'s reads never return it.',
      'Sends nothing: Casey does not send the link anywhere — it reaches a client only when you send it.',
      'No trigger event: sharing emits none — no rule runs.',
      'Other open pages: the Documents page and Documents tabs showing it mark it "public" on their own.']);
    // Nothing on the card is the link column; no query selects it.
    expect(card.document).not.toHaveProperty('shared_link');
    expect(db.query.mock.calls.some(([sql]) => /SELECT[^;]*\bshared_link\b(?! IS NOT NULL)/.test(sql.replace(/\(shared_link IS NOT NULL AND shared_link <> ''\)/, '')))).toBe(false);
  });
  test('already shared: the effect says applying makes nothing new (unless Dropbox lost it); no NEW LINK; the link value never reaches the card', async () => {
    const card = await run(share({ document_id: 88415 }));
    expect([card.shared, card.expected.shared]).toEqual([true, true]);
    expect(card.warnings).toEqual([expect.stringMatching(/^PUBLIC LINK: /)]);
    expect(card.effects[0]).toBe('Already shared: a public link is already stored for this document (the Documents page marks it "public"). Applying makes nothing new — Dropbox hands back the link it already has — unless that link was deleted in Dropbox since, in which case Dropbox creates a NEW public link and it replaces the stored one.');
    expect(JSON.stringify(card)).not.toContain('dropbox.com');
  });
  test('a pending delete is disclosed (danger); many links are not a share warning', async () => {
    const docs = baseDocs(); docs[88412].pending_delete_at = new Date('2026-11-01T09:00:00Z');
    const links = { 88412: Array.from({ length: 6 }, (_, i) => ({ id: 600 + i, link_type: 'contact', link_id: String(90 + i), relation: null, created_by: 6 })) };
    const card = await run(share(), { docs, links });
    expect(card.warnings.slice(2)).toEqual(['PENDING DELETE: Dropbox reported this file deleted (2026-11-01T09:00:00.000Z). Unless it reappears within about 30 minutes of that, the registry marks it deleted and it leaves every Documents list.']);
  });
});

describe('the unlink card — shape and refusals', () => {
  test('case or contact only; exact ids', async () => {
    await refuse(unlink({ link_type: 'appt', link_id: 5 }), /^Unlinking a document from "appt" is not available — Casey unlinks a document from a case .* the Documents page's Links dialog unlinks any other link$/);
    await refuse(unlink({ link_type: undefined }), /^Unlinking a document from nothing is not available/);
    await refuse(unlink({ link_type: 'case', link_id: 'bad id!' }), /^A case unlink needs link_id = the case's exact case_id$/);
    await refuse(unlink({ link_id: 'Dana' }), /^A contact unlink needs link_id = the contact's exact positive contact_id$/);
  });
  test('both rows cited — the record by its id, or the document_links row', async () => {
    await refuse(unlink({ evidence: [{ query_id: 'q3', row_number: 1 }] }), /^The unlink evidence does not identify document #88412 — cite a row carrying its exact document_id/);
    await refuse(unlink({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /^The unlink evidence does not identify contact 77 — cite a row carrying its exact contact_id, or the document_links row \(link_type, link_id\)$/);
    await refuse(unlink({ link_type: 'case', link_id: CASE_ID, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q4', row_number: 1 }] }), /^The unlink evidence does not identify case 7KQ2M9XA/);
    await expect(run(unlink({ evidence: [{ query_id: 'q4', row_number: 1 }] }))).resolves.toMatchObject({ link: { document_link_id: 502 } });
  });
  test('a link the document does not have is refused (folded like the general_ci DELETE); a gone document; > 20 links', async () => {
    await refuse(unlink({ document_id: 88416, link_type: 'case', link_id: CASE_ID, evidence: [{ query_id: 'q1', row_number: 5 }, { query_id: 'q2', row_number: 1 }] }),
      /^Document #88416 \("Paystub\.jpg"\) is not linked to case 7KQ2M9XA — there is nothing to unlink \(the route would answer "Link not found"\)$/);
    await refuse(unlink({ document_id: 88499 }), /^Document #88499 no longer exists$/);
    // A stored lower-case case id is the same link.
    const links = { 88412: [{ id: 510, link_type: 'case', link_id: CASE_ID.toLowerCase(), relation: null, created_by: 6 }] };
    const card = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { links });
    expect(card.link).toMatchObject({ document_link_id: 510, link_type: 'case', link_id: CASE_ID.toLowerCase() });
    const many = { 88412: Array.from({ length: 21 }, (_, i) => ({ id: 700 + i, link_type: 'contact', link_id: String(i === 0 ? 77 : 100 + i), relation: null, created_by: 6 })) };
    await refuse(unlink(), /^Document #88412 is linked to 21 records — more than one card can review \(20\)\. The user unlinks it on the Documents page$/, { links: many });
  });
  test('a deleted document is disclosed, not refused (the Links dialog offers Unlink on any document)', async () => {
    const card = await run(unlink({ document_id: 88413 }));
    expect(card.effects[0]).toBe('Status: the document is deleted — the Documents lists already hide it by default; the unlink still deletes the link row.');
    expect(card.expected).toEqual({ status: 'deleted', links: ['503:contact:77:'] });
  });
});

describe('the unlink card — what it shows', () => {
  test('a contact link with a case link left: still shown on the contact through the case; no triage; no COMES BACK', async () => {
    const card = await run(unlink());
    expect(card).toMatchObject({
      kind: 'document.unlink.v1',
      target: { link_type: 'contact', contact_id: 77, label: 'Dana Debtor (contact #77)' },
      link: { document_link_id: 502, link_type: 'contact', link_id: '77', relation: 'upload', made_by_sync: false },
      link_note: 'Dana Debtor (contact #77) — relation "upload", made by user #6',
      links_total: 2, links_after: 1,
      warnings: [],
      expected: { status: 'active', links: ['501:case:7KQ2M9XA:path', '502:contact:77:upload'] },
    });
    expect(card.visibility).toEqual([
      'Dana Debtor (contact #77)\'s Documents tab — no longer listed there directly, but still shown under "Include related" (on by default) through another of the document\'s links.',
      'Still shown, through another of its links, on the Documents tab of: case 25-12345-abc (Primary on the case).',
      'Stays on: the Documents tab of each record it is still linked to (listed), and the Documents page.']);
    expect(card.effects).toEqual([
      'Untouched: the file in Dropbox, the document\'s title, type and tags, and its other links — only this one link row is deleted.',
      'No undo: linking it again makes a NEW link (the relation word "upload" and the link\'s date are not kept).',
      'No trigger event: unlinking emits none (there is no "document unlinked" event) — no rule runs, and nothing a rule did when it was linked is undone.',
      'Other open pages: that record\'s Documents tab refreshes on its own.']);
  });
  test('the sync\'s own case link: the contacts it leaves, the triage effect, and COMES BACK (sweep + changes)', async () => {
    const card = await run(unlink({ link_type: 'case', link_id: CASE_ID }));
    expect(card.link_note).toBe('case 25-12345-abc — relation "path", made by the Dropbox sync (the file sat in that case\'s folder), not by a person');
    expect(card.link.made_by_sync).toBe(true);
    expect(card.visibility).toEqual([
      'case 25-12345-abc\'s Documents tab — no longer listed there directly, but still shown under "Include related" (on by default) through another of the document\'s links.',
      'Under "Include related" (on by default) it also leaves the Documents tab of each contact on this case — Sam Debtor (contact #78) (Secondary on the case) — where it shows badged "via case 25-12345-abc" today.',
      'Still shown, through another of its links, on the Documents tab of: Dana Debtor (contact #77) (Primary on the case).',
      'Stays on: the Documents tab of each record it is still linked to (listed), and the Documents page.']);
    expect(card.warnings).toEqual(['COMES BACK: the file still sits in case 25-12345-abc\'s Dropbox folder, so the Dropbox sync re-adds this case link on a later pass of its background sweep (silently) and whenever the file changes in Dropbox (that re-add runs "document linked" rules). To keep the document off this case, move the file out of the case\'s folder in Dropbox.']);
    expect(card.effects[0]).toBe('Triage: it has no other case link, so it goes back on the Documents page\'s "Unlinked" list (documents with no case).');
    expect(card.effects[2]).toBe('No undo: linking it again makes a NEW link (the relation word "path" and the link\'s date are not kept; Casey never writes "path" — only the sync does).');
  });
  test('COMES BACK variants: the sync switched off; another case path link keeps the sweep away; the file outside the folder; a contact link never', async () => {
    const off = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { syncOff: true });
    expect(off.warnings[0]).toMatch(/whenever the file changes in Dropbox \(that re-add runs "document linked" rules\) — the sync is switched off right now, so nothing re-adds it until it is switched back on\. To keep/);
    const links = baseLinks(); links[88412].push({ id: 520, link_type: 'case', link_id: 'OTHER123', relation: 'path', created_by: null });
    const two = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { links });
    expect(two.warnings[0]).toBe('COMES BACK: the file still sits in case 25-12345-abc\'s Dropbox folder, so the Dropbox sync re-adds this case link whenever the file changes in Dropbox (that re-add runs "document linked" rules). To keep the document off this case, move the file out of the case\'s folder in Dropbox.');
    expect(two.effects.some((e) => e.startsWith('Triage:'))).toBe(false);
    // The innermost cached folder wins (the sync's _matchCase): a nested folder of another case.
    const nested = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { folders: { '/active cases/debtor, dana': CASE_ID, '/active cases': 'OTHER123' } });
    expect(nested.warnings[0]).toMatch(/^COMES BACK: /);
    const elsewhere = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { folders: { '/active cases': 'OTHER123' } });
    expect(elsewhere.warnings).toEqual([]);
    const none = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { folders: {} });
    expect(none.warnings).toEqual([]);
    // A deleted document is never re-added by the sync.
    const docs = baseDocs(); docs[88412].status = 'deleted';
    const dead = await run(unlink({ link_type: 'case', link_id: CASE_ID }), { docs });
    expect(dead.warnings).toEqual([]);
  });
  test('the only link: LINKED TO NOTHING, it leaves the contact and each of the contact\'s cases', async () => {
    const card = await run(unlink({ document_id: 88416 }));
    expect(card.warnings).toEqual(['LINKED TO NOTHING: this is the document\'s only link — afterwards it belongs to no case or contact and shows only on the Documents page.']);
    expect(card.visibility).toEqual([
      'Dana Debtor (contact #77)\'s Documents tab — it leaves it (listed there directly today).',
      'Under "Include related" (on by default) it also leaves the Documents tab of each case this contact is on — case 25-12345-abc (Primary on the case) — where it shows badged "via Dana Debtor (contact #77)" today.',
      'Stays on: the Documents page only (More → Documents).']);
    expect(card.links_after).toBe(0);
  });
  test('a contact on no case; a record that no longer exists', async () => {
    const lone = await run(unlink({ document_id: 88416 }), { relate: [] });
    expect(lone.visibility[1]).toBe('Under "Include related": this contact is on no case, so no other Documents tab loses it.');
    const gone = await run(unlink({ document_id: 88416 }), { contactMissing: true });
    expect(gone.target).toEqual({ link_type: 'contact', link_id: '77', label: 'contact 77 (not found)', missing: true });
    expect(gone.link_note).toBe('contact 77 (not found) — no relation word, made by user #6 — that record no longer exists');
  });
});

describe('the ledger, the request detector', () => {
  test('the share receipts the reviewed document_id; the unlink the reviewed document_link_id; no status kind', () => {
    expect(ledger.KINDS.get('document.share.v1')).toBe('document_id');
    expect(ledger.KINDS.get('document.unlink.v1')).toBe('document_link_id');
    expect(ledger.KINDS.has('document.status.v1')).toBe(false);
  });
  test.each([
    'Share the petition document with a public link',
    'get me a shareable link to that PDF',
    'unlink this document from the Smith case',
    'remove the scan from Dana\'s contact',
    'detach the paystub document from case 25-12345',
  ])('a share / unlink request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['Which documents have a public link?', 'Is the petition PDF shared?'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(false);
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
const FNS = ['documentName', 'documentSize', 'documentShown', 'documentId', 'documentLinkSignature', 'documentRead', 'documentOpenInfo',
  'docshareLabel', 'docunlinkLabel', 'documentHeadLines', 'documentLinksLine', 'docshareText', 'docunlinkText', 'docshareRequest', 'docunlinkBody',
  'docunlinkRequest', 'docsharePrecheck', 'docunlinkPrecheck', 'docshareResult', 'docunlinkResult', 'docshareKnownOutcome', 'docunlinkKnownOutcome',
  'docshareAppliedWarning', 'docshareCopy', 'docunlinkEntity', 'docunlinkOpen'];
function browser(api, deps = {}) {
  const src = [constSrc('DOCSHARE_ACTION_KINDS'), constSrc('DOCUNLINK_ACTION_KINDS'), constSrc('DOCSHARE_LINK_MAX'), ...FNS.map(fnSrc),
    `const families = [${familySrc('docshare')}, ${familySrc('docunlink')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  const P = deps.P || { Swal: { fire: jest.fn() } };
  return new Function('api', 'openEntity', 'P', 'navigator', src)(api, deps.openEntity || jest.fn(), P, deps.navigator); // eslint-disable-line no-new-func
}

describe('the browser: fixed requests, the re-read, result checks, outcomes, danger, applied copy, text', () => {
  let first; let again; let unC; let unK; let only;
  beforeAll(async () => {
    const mk = async (value, opts) => JSON.parse(JSON.stringify(await normalizeActionDraft(makeDb(opts), value, EVIDENCE, { currentUserId: ME })));
    first = await mk(share());
    again = await mk(share({ document_id: 88415 }));
    unC = await mk(unlink({ link_type: 'case', link_id: CASE_ID }));
    unK = await mk(unlink());
    only = await mk(unlink({ document_id: 88416 }));
  });

  // GET /api/documents/:id as the route answers it: SELECT * + listLinks rows.
  function reads({ docs = baseDocs(), links = baseLinks(), gone = false, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      const id = Number(p.split('/')[3]);
      const d = docs[id];
      if (gone || !d) throw Object.assign(new Error('Document not found'), { status: 404 });
      return { status: 'success', document: { ...d, updated_at: '2026-10-30T12:00:00.000Z' }, links: (links[id] || []).map((l) => ({ ...l, document_id: id, created_at: '2026-10-01T10:00:00.000Z' })) };
    });
    return { api, gets };
  }

  test('the requests: the share POST with no body; the unlink DELETE with the link row exactly as stored', () => {
    const b = browser(jest.fn());
    expect(b.docshareRequest({ ...first, shared_link: 'https://evil' })).toEqual({ path: '/api/documents/88412/share', method: 'POST', body: null });
    expect(b.docunlinkRequest(unK)).toEqual({ path: '/api/documents/88412/links', method: 'DELETE', body: { link_type: 'contact', link_id: '77' } });
    expect(b.docunlinkRequest(unC)).toEqual({ path: '/api/documents/88412/links', method: 'DELETE', body: { link_type: 'case', link_id: CASE_ID } });
    expect(() => b.docshareRequest({ ...first, document: { document_id: 'x' } })).toThrow('This card has no usable document id.');
    expect(() => b.docunlinkRequest({ ...unK, link: { ...unK.link, link_type: 'appt' } })).toThrow('This card has no usable record.');
    expect(() => b.docunlinkRequest({ ...unK, link: { ...unK.link, link_id: 77 } })).toThrow('This card has no usable record id.');
    expect(() => b.docunlinkRequest({ ...unC, link: { ...unC.link, link_id: 'bad id' } })).toThrow('This card has no usable record id.');
    expect(() => b.docunlinkRequest({ ...unK, link: { ...unK.link, document_link_id: 0 } })).toThrow('This card has no usable link id.');
  });

  test('the prechecks: ONE GET of the document; fresh cards pass', async () => {
    for (const card of [first, again, unC, unK, only]) {
      const { api, gets } = reads();
      const check = card.kind === 'document.share.v1' ? browser(api).docsharePrecheck : browser(api).docunlinkPrecheck;
      await expect(check(card)).resolves.toBe('');
      expect(gets).toEqual([`/api/documents/${card.document.document_id}`]);
    }
  });

  test.each([
    ['deleted since', (d) => { d[88412].status = 'deleted'; }, /^The document "Petition" is deleted now\. Nothing was shared\.$/],
    ['shared since', (d) => { d[88412].shared_link = STORED_LINK; }, /^The document "Petition" was shared since this card was prepared — a public link is stored now\. Nothing was shared\./],
    ['retitled', (d) => { d[88412].title = 'Petition (filed)'; }, /^The document "Petition" changed since this card was prepared \(its file name, title or type\)\. Nothing was shared\./],
    ['retyped', (d) => { d[88412].doc_type = 'motion'; }, /changed since this card was prepared \(its file name, title or type\)/],
    ['renamed by the sync', (d) => { d[88412].name = 'Petition (signed).pdf'; }, /changed since this card was prepared \(its file name, title or type\)/],
  ])('the share re-read refuses: %s', async (_n, edit, re) => {
    const docs = baseDocs(); edit(docs);
    await expect(browser(reads({ docs }).api).docsharePrecheck(first)).resolves.toMatch(re);
  });

  test('the share re-read: a link removed since, a link added or removed, a gone document, a failed read', async () => {
    const docs = baseDocs(); docs[88415].shared_link = '';
    await expect(browser(reads({ docs }).api).docsharePrecheck(again)).resolves.toBe('The stored public link of "Shared.pdf" was removed since this card was prepared. Nothing was shared. Ask Casey to prepare it again.');
    const links = baseLinks(); links[88412].pop();
    await expect(browser(reads({ links }).api).docsharePrecheck(first)).resolves.toBe('The links of "Petition" changed since this card was prepared (one was added or removed). Nothing was shared. Ask Casey to prepare it again.');
    await expect(browser(reads({ gone: true }).api).docsharePrecheck(first)).resolves.toBe('The document "Petition" no longer exists. Nothing was shared.');
    await expect(browser(reads({ fail: true }).api).docsharePrecheck(first)).rejects.toThrow('boom');
  });

  test('the unlink re-read: the link gone, another link, the status changed, the document gone', async () => {
    const gone = baseLinks(); gone[88412] = gone[88412].filter((l) => l.id !== 502);
    await expect(browser(reads({ links: gone }).api).docunlinkPrecheck(unK)).resolves.toBe('The document "Petition" is no longer linked to Dana Debtor (contact #77) — someone unlinked it since this card was prepared. Nothing was written.');
    const more = baseLinks(); more[88412].push({ id: 530, link_type: 'contact', link_id: '78', relation: null, created_by: 6 });
    await expect(browser(reads({ links: more }).api).docunlinkPrecheck(unK)).resolves.toBe('The links of "Petition" changed since this card was prepared (one was added or removed). Nothing was written. Ask Casey to prepare it again.');
    const relinked = baseLinks(); relinked[88412][1] = { ...relinked[88412][1], id: 531 };
    await expect(browser(reads({ links: relinked }).api).docunlinkPrecheck(unK)).resolves.toMatch(/is no longer linked to Dana Debtor/);
    const docs = baseDocs(); docs[88412].status = 'deleted';
    await expect(browser(reads({ docs }).api).docunlinkPrecheck(unK)).resolves.toBe('The document "Petition" is deleted now (it was active when this card was prepared). Nothing was written. Ask Casey to prepare it again.');
    await expect(browser(reads({ gone: true }).api).docunlinkPrecheck(unK)).resolves.toBe('The document "Petition" no longer exists. Nothing was written.');
    // A card that cannot be written is never read.
    const { api } = reads();
    await expect(browser(api).docunlinkPrecheck({ ...unK, link: { ...unK.link, link_type: 'appt' } })).rejects.toThrow('This card has no usable record.');
    expect(api).not.toHaveBeenCalled();
  });

  test('the share result: an https link, kept off every serialized field', () => {
    const b = browser(jest.fn());
    const card = JSON.parse(JSON.stringify(first));
    expect(b.docshareResult(card, { status: 'success', shared_link: STORED_LINK })).toEqual({ document_id: 88412 });
    expect(card.__docshareLink).toBe(STORED_LINK);
    expect(Object.keys(card)).not.toContain('__docshareLink');
    expect(JSON.stringify(card)).not.toContain('dropbox.com');
    for (const bad of [undefined, '', 'http://www.dropbox.com/x', 'https://x y', `https://${'x'.repeat(505)}`, 42]) {
      expect(() => b.docshareResult(JSON.parse(JSON.stringify(first)), { status: 'success', shared_link: bad })).toThrow('The documents route did not return a public link');
    }
    expect(b.docshareResult(JSON.parse(JSON.stringify(first)), { shared_link: `https://${'x'.repeat(504)}` })).toEqual({ document_id: 88412 });
  });

  test('the unlink result: the route\'s echo of the reviewed link; the receipt is the reviewed row', () => {
    const b = browser(jest.fn());
    expect(b.docunlinkResult(unK, { status: 'success', removed: true, link_type: 'contact', link_id: '77' })).toEqual({ document_link_id: 502 });
    expect(() => b.docunlinkResult(unK, { status: 'success', removed: true, link_type: 'contact', link_id: '78' })).toThrow('The documents route did not confirm the unlink');
    expect(() => b.docunlinkResult(unK, { status: 'success', link_type: 'contact', link_id: '77' })).toThrow('The documents route did not confirm the unlink');
    expect(() => b.docunlinkResult(unK, { status: 'success', removed: true, link_type: 'case', link_id: '77' })).toThrow('The documents route did not confirm the unlink');
  });

  test('outcomes: a gone document and Dropbox\'s sharing 409 are refusals; the unlink 404 is a refusal; anything else falls through', () => {
    const b = browser(jest.fn());
    expect(b.docshareKnownOutcome({ status: 404, message: 'Document not found' })).toEqual({ status: 'Refused — nothing shared', text: expect.stringMatching(/^Refused — nothing shared: that document no longer exists/) });
    const dbx = 'dropbox: POST /2/sharing/list_shared_links → 409: {"error_summary":"path/not_found/"}';
    expect(b.docshareKnownOutcome({ status: 409, message: dbx })).toEqual({ status: 'Refused — nothing shared', text: expect.stringContaining('Dropbox refused to share the file (dropbox: POST /2/sharing/list_shared_links → 409:') });
    expect(b.docshareKnownOutcome({ status: 409, message: 'dropbox: POST /2/sharing/create_shared_link_with_settings → 409: settings_error' })).toMatchObject({ status: 'Refused — nothing shared' });
    expect(b.docshareKnownOutcome({ status: 409, message: 'dropbox: POST /2/files/get_metadata → 409: x' })).toBe(null);
    expect(b.docshareKnownOutcome({ status: 409, message: dbx, body: { idempotency: {} } })).toBe(null);
    expect(b.docshareKnownOutcome({ status: 500, message: 'boom' })).toBe(null);
    expect(b.docunlinkKnownOutcome({ status: 404, message: 'Link not found' })).toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/^Refused — nothing written: that link was already gone/) });
    expect(b.docunlinkKnownOutcome({ status: 404, message: 'Document not found' })).toBe(null);
    expect(b.docunlinkKnownOutcome({ status: 404, message: 'Link not found', body: { idempotency: {} } })).toBe(null);
  });

  test('the families: receipts, ALWAYS danger, no auto-open after the share, the applied copy', () => {
    const P = { Swal: { fire: jest.fn() } };
    const openEntity = jest.fn();
    const { families } = browser(jest.fn(), { P, openEntity });
    const [s, u] = families;
    expect(families.map((f) => [f.id, [...f.kinds], f.idField, f.appliedKey])).toEqual([
      ['docshare', ['document.share.v1'], 'document_id', 'result_docshare_document_id'],
      ['docunlink', ['document.unlink.v1'], 'document_link_id', 'result_docunlink_id']]);
    expect([s.danger(first), s.danger({}), u.danger(unK), u.danger({})]).toEqual([true, true, true, true]);
    expect(typeof s.afterApply).toBe('function');
    s.afterApply(first, { document_id: 88412 });
    expect(P.Swal.fire).not.toHaveBeenCalled();
    // Applied in this browser: the link and a copy button.
    const live = JSON.parse(JSON.stringify(first)); live.result_docshare_document_id = 88412;
    Object.defineProperty(live, '__docshareLink', { value: STORED_LINK });
    expect(s.appliedCopy(live)).toEqual({ status: 'Applied — document #88412 shared', button: 'Copy public link',
      warning: `"Petition" now has a permanent public link — anyone who holds it can open the file: ${STORED_LINK} It is shown here in this browser only; the Documents page's Copy public link button copies it any time.` });
    Object.defineProperty(live, '__docsharePrior', { value: STORED_LINK });
    expect(s.appliedCopy(live).warning).toContain(`${STORED_LINK} This is the link that was already stored — nothing new was made.`);
    const replaced = JSON.parse(JSON.stringify(again));
    Object.defineProperty(replaced, '__docshareLink', { value: 'https://www.dropbox.com/scl/fi/new/Shared.pdf' });
    Object.defineProperty(replaced, '__docsharePrior', { value: STORED_LINK });
    expect(s.appliedCopy(replaced).warning).toContain('Dropbox returned a NEW link: the one stored before no longer worked, and this one replaces it.');
    // Reopened from the chat (or replayed): no link — the Documents page.
    expect(s.appliedCopy({ ...first, result_docshare_document_id: 88412 })).toEqual({ status: 'Applied — document #88412 shared', button: 'Where is the link?',
      warning: '"Petition" was shared using your signed-in account. The link is not kept in the chat — find the document under More → Documents and use its Copy public link button.' });
    expect(u.appliedCopy({ ...unC, result_docunlink_id: 501 })).toEqual({ status: 'Applied — link #501 removed', button: 'Open 25-12345-abc',
      warning: '"Petition" was unlinked from case 25-12345-abc using your signed-in account; every effect listed above applies from now. The Dropbox sync may re-add the link (see the warning above).' });
    expect(u.appliedCopy({ ...unK, result_docunlink_id: 502 }).warning).not.toContain('re-add');
    u.open(unK);
    expect(openEntity).toHaveBeenCalledWith('contact', '77', 'Dana Debtor');
  });

  test('the copy button: the link to the clipboard; the manual fallback; no link → the Documents page', async () => {
    const P = { Swal: { fire: jest.fn() } };
    const writeText = jest.fn(async () => {});
    const live = JSON.parse(JSON.stringify(first));
    Object.defineProperty(live, '__docshareLink', { value: STORED_LINK });
    await browser(jest.fn(), { P, navigator: { clipboard: { writeText } } }).docshareCopy(live);
    expect(writeText).toHaveBeenCalledWith(STORED_LINK);
    expect(P.Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'success', title: 'Link copied' });
    P.Swal.fire.mockClear();
    await browser(jest.fn(), { P, navigator: { clipboard: { writeText: async () => { throw new Error('blocked'); } } } }).docshareCopy(live);
    expect(P.Swal.fire.mock.calls[0][0]).toMatchObject({ title: 'Copy manually', input: 'textarea', inputValue: STORED_LINK });
    P.Swal.fire.mockClear();
    await browser(jest.fn(), { P }).docshareCopy(JSON.parse(JSON.stringify(first)));
    expect(P.Swal.fire.mock.calls[0][0]).toMatchObject({ icon: 'info', title: 'Public link', text: expect.stringContaining('More → Documents') });
  });

  test('labels and the card text', () => {
    const b = browser(jest.fn());
    expect([b.docshareLabel(), b.docunlinkLabel(unC), b.docunlinkLabel(unK)]).toEqual(['Share document (public link)', 'Unlink document from case', 'Unlink document from contact']);
    const s = b.docshareText(first);
    for (const line of ['Document share proposal — not applied', 'Action: Share document (public link)',
      'Document: #88412 "Petition.pdf" (PDF, 1.2 MB, dropbox, modified 2026-01-02)', 'Title: "Petition"; type "petition"',
      'Linked to (2): case 25-12345-abc (path); Dana Debtor (contact #77) (upload)', 'Public link now: none stored',
      'Warning: PUBLIC LINK: applying asks Dropbox for a PERMANENT link', 'Effect: Revoking: only in Dropbox']) expect(s).toContain(line);
    expect(b.docshareText(again)).toContain('Public link now: one is stored (the Documents page marks it "public")');
    const u = b.docunlinkText(unC);
    for (const line of ['Document unlink proposal — not applied', 'Action: Unlink document from case',
      'Unlink from: case 25-12345-abc — relation "path", made by the Dropbox sync', 'Links now (2): ', 'Links after: 1',
      'Where: Under "Include related" (on by default) it also leaves the Documents tab of each contact on this case',
      'Warning: COMES BACK: ', 'Effect: Triage: ', 'Writes: one link row deleted']) expect(u).toContain(line);
    expect(b.docunlinkText(only)).toContain('Warning: LINKED TO NOTHING: ');
  });
});
