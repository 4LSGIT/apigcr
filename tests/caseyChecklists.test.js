'use strict';
/**
 * tests/caseyChecklists.test.js
 *
 * A10 — Casey makes ONE checklist or note, adds ONE item, or renames /
 * completes / reopens ONE item through reviewed cards:
 *   checklist.create.v1      → POST  /checklists {title, kind, body?, link_type, link, items?}
 *   checklist.item.add.v1    → POST  /checklists/:id/items {name}
 *   checklist.item.update.v1 → PATCH /checkitems/:id {name?, status?}
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builders, the click-time re-read, the outcome mapping — is in
 * tests/assistantUi.test.js):
 *   1. the casey_checklists_enabled switch ('0' = dark; unset = on);
 *   2. TAG and POSITION refused by name before anything is read (the draft or
 *      an initial item); unknown keys refused;
 *   3. THE DOCS LIST: a case list titled "Docs Needed" (folded the way the
 *      column's general_ci collation compares) is refused; an item on a case's
 *      docs list (the portal's predicate, `docs_list`) is disclosed as
 *      CLIENT-VISIBLE;
 *   4. link types: case / contact (cited by the exact id) or the ASKING user;
 *      another user's list and bill / appt / task / event refused by name;
 *   5. the route's shape rules refused before the click: title > 255, body
 *      over lib/noteLimits, a note with items, a checklist with a body, > 25
 *      initial items, a duplicate item name (stricter than the route);
 *   6. item cards: a note refuses; the derived list status after (complete on
 *      the last open item, reopen on an add to a complete list or an item
 *      reopened); the route's two emits dry-run against active rules;
 *   7. expected for each kind; the ledger receipts; the request detector.
 *
 * The SQL (the docs predicate on the real collation, the list and item reads)
 * and the route behaviour the refusals rest on run on a real engine in
 * tests/caseyChecklists.mysql.test.js.
 *
 *   npx jest tests/caseyChecklists.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;

// One list per id: { list row, items }.
function baseLists() {
  return {
    412: { row: { id: 412, title: 'Pre-filing to-dos', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 },
      items: [{ id: 5120, name: 'Pull credit report', status: 'incomplete', position: 1 }, { id: 5121, name: 'Order transcripts', status: 'complete', position: 2 }] },
    413: { row: { id: 413, title: 'Docs Needed', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: 'docs_needed', docs_list: 1 },
      items: [{ id: 5130, name: 'Pay stubs', status: 'incomplete', position: 1 }] },
    414: { row: { id: 414, title: 'Call log', kind: 'note', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 }, items: [] },
    415: { row: { id: 415, title: 'Done list', kind: 'checklist', status: 'complete', link_type: 'contact', link: '77', tag: null, docs_list: 0 },
      items: [{ id: 5150, name: 'Signed', status: 'complete', position: 1 }] },
    416: { row: { id: 416, title: 'Fred to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: String(ME), tag: null, docs_list: 0 },
      items: [{ id: 5160, name: 'Renew bar dues', status: 'incomplete', position: 1 }] },
    417: { row: { id: 417, title: 'Stuart to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: '1', tag: null, docs_list: 0 }, items: [] },
    418: { row: { id: 418, title: 'Appt prep', kind: 'checklist', status: 'incomplete', link_type: 'appt', link: '55', tag: null, docs_list: 0 }, items: [] },
  };
}

function makeDb(over = {}) {
  const lists = over.lists || baseLists();
  const onParent = over.onParent || [{ id: 412, title: 'Pre-filing to-dos', kind: 'checklist' }, { id: 413, title: 'Docs Needed', kind: 'checklist' }, { id: 414, title: 'Call log', kind: 'note' }];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') {
      return [over.caseMissing || String(params[0]).toLowerCase() !== CASE_ID.toLowerCase() ? [] : [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Chapter 7' }]];
    }
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1') {
      return [Number(params[0]) === 77 && !over.contactMissing ? [{ contact_id: 77, contact_name: 'Dana Client' }] : []];
    }
    if (flat === 'SELECT id, title, kind FROM checklists WHERE link_type = ? AND link = ? ORDER BY created_date ASC, id ASC') {
      return [onParent.map((r) => ({ ...r }))];
    }
    if (/^SELECT cl\.id, cl\.title, cl\.kind, cl\.status, cl\.link_type, cl\.link, cl\.tag, COALESCE\(cl\.link_type = 'case' AND \(cl\.tag = 'docs_needed' OR cl\.title = 'Docs Needed'\), 0\) AS docs_list FROM checklists cl WHERE cl\.id = \? LIMIT 1$/.test(flat)) {
      const l = lists[Number(params[0])];
      return [l ? [{ ...l.row }] : []];
    }
    if (flat === 'SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC') {
      const l = lists[Number(params[0])];
      return [l ? l.items.map((i) => ({ ...i })) : []];
    }
    if (flat === 'SELECT checklist_id FROM checkitems WHERE id = ? LIMIT 1') {
      for (const [id, l] of Object.entries(lists)) if (l.items.some((i) => i.id === Number(params[0]))) return [[{ checklist_id: Number(id) }]];
      return [[]];
    }
    // A10X: a colleague's list (user 1 Stuart is active staff, user 2 is retired) and the record kinds.
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') {
      return [{ 1: [{ user: 1, user_name: 'Stuart' }], 2: [{ user: 2, user_name: 'Retired' }] }[Number(params[0])] || []];
    }
    if (flat === "SELECT user, user_name FROM users WHERE user = ? AND user_auth LIKE 'authorized%' AND user_type <> 0 LIMIT 1") {
      return [Number(params[0]) === 1 ? [{ user: 1, user_name: 'Stuart' }] : []];
    }
    if (flat.startsWith('SELECT a.appt_id, a.appt_type, a.appt_status,')) {
      return [Number(params[0]) === 55 ? [{ appt_id: 55, appt_type: 'Strategy session', appt_status: 'Scheduled', at: '2026-11-20 10:00', contact_name: 'Dana Client' }] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

// q1 = a case read, q2 = a contact read, q3 = a checklists read (checklist_id),
// q4 = a checkitems read (checkitem_id).
const EVIDENCE = [
  { id: 'q1', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
  { id: 'q2', rows: [{ contact_id: 77, contact_name: 'Dana Client' }] },
  { id: 'q3', rows: [412, 413, 414, 415, 416, 417, 418].map((id) => ({ checklist_id: id })) },
  { id: 'q4', rows: [5120, 5121, 5130, 5150, 5160].map((id) => ({ checkitem_id: id, checklist_id: 0 })) },
];
const listRow = (id) => [{ query_id: 'q3', row_number: [412, 413, 414, 415, 416, 417, 418].indexOf(id) + 1 }];
const itemRow = (id) => [{ query_id: 'q4', row_number: [5120, 5121, 5130, 5150, 5160].indexOf(id) + 1 }];

const create = (over = {}) => ({ kind: 'checklist.create.v1', title: 'Pre-filing to-dos 2', link_type: 'case', link: CASE_ID,
  items: ['Pull credit report', 'Order transcripts'], evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const add = (id = 412, name = '2024 W-2', over = {}) => ({ kind: 'checklist.item.add.v1', checklist_id: id, name, evidence: listRow(id), ...over });
const update = (id = 5120, over = {}) => ({ kind: 'checklist.item.update.v1', checkitem_id: id, status: 'complete', evidence: itemRow(id), ...over });

let spies = [];
function rulesFor(map = {}) {
  spies.push(jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => (map[ev] || []).map((r) => ({ ...r }))));
}
beforeEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; rulesFor(); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CHECKLISTS_ENABLED; });

const run = (value, dbOver, evidence = EVIDENCE, userId = ME) => normalizeActionDraft(makeDb(dbOver), value, evidence, { currentUserId: userId });
const refuse = (value, re, dbOver, evidence, userId) => expect(run(value, dbOver, evidence, userId)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes all three kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CHECKLISTS_ENABLED = '0';
    for (const v of [create(), add(), update()]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_CHECKLISTS_ENABLED;
    for (const v of [create(), add(), update()]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('TAG and POSITION — system fields, refused by name before anything is read', () => {
  test.each([
    ['tag on a create', () => create({ tag: 'docs_needed' }), /^TAG refused: `tag` is a system field — only automation and superusers set it .* Casey never writes it \(checklist\.create\.v1\)$/],
    ['tag on an item add', () => add(412, 'x', { tag: 'x' }), /^TAG refused: .*\(checklist\.item\.add\.v1\)$/],
    ['tag on an item update', () => update(5120, { tag: null }), /^TAG refused/],
    ['position on an item add', () => add(412, 'x', { position: 0 }), /^POSITION refused: an item's position is assigned by the server — Casey never orders items \(checklist\.item\.add\.v1\)$/],
    ['position on an item update', () => update(5120, { position: 3 }), /^POSITION refused/],
    ['tag on an initial item', () => create({ items: [{ name: 'a', tag: 'x' }] }), /^TAG refused: .*\(item 1\)$/],
    ['position on an initial item', () => create({ items: ['a', { name: 'b', position: 1 }] }), /^POSITION refused: .*\(item 2\)$/],
  ])('%s', async (_n, value, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, value(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    // Nothing was read: the refusal came first.
    expect(db.query).not.toHaveBeenCalled();
  });

  test('unknown keys are refused, naming what each kind takes; an initial item is its name only', async () => {
    await refuse(create({ created_by: 1 }), /^A checklist\.create\.v1 card carries unsupported fields: created_by — it takes title, list_kind, body, link_type, link, items, evidence only$/);
    await refuse(add(412, 'x', { status: 'complete' }), /^A checklist\.item\.add\.v1 card carries unsupported fields: status — it takes checklist_id, name, evidence only$/);
    await refuse(update(5120, { checklist_id: 412 }), /unsupported fields: checklist_id/);
    await refuse(create({ items: [{ name: 'a', status: 'complete' }] }), /^Item 1 carries status — a new item is its name only/);
  });
});

describe('THE DOCS LIST', () => {
  test.each(['Docs Needed', 'docs needed', 'DOCS NEEDED', '  Docs Needed  ', 'Döcs Needed'])('a case list titled %j is refused by name', async (title) => {
    await refuse(create({ title }), /^DOCS LIST refused: a case checklist titled ".*" becomes the case's client-facing docs list .* never by Casey/);
  });
  test('a NOTE titled Docs Needed on a case is refused too; a contact list of that title is not (the predicate is case-only)', async () => {
    await refuse(create({ title: 'Docs Needed', list_kind: 'note', items: undefined }), /^DOCS LIST refused: a case note titled/);
    await expect(run(create({ title: 'Docs Needed', link_type: 'contact', link: 77, evidence: [{ query_id: 'q2', row_number: 1 }] })))
      .resolves.toMatchObject({ list: { title: 'Docs Needed', link_type: 'contact', link: '77' } });
    await expect(run(create({ title: 'Docs Needed (old)' }))).resolves.toMatchObject({ list: { title: 'Docs Needed (old)' } });
  });
  test('an item ADDED to the docs list is disclosed as CLIENT-VISIBLE (a warning, not a refusal)', async () => {
    const card = await run(add(413, 'Bank statements'));
    expect(card.list.docs_list).toBe(true);
    expect(card.warnings).toEqual([
      'CLIENT-VISIBLE: this is case 25-12345-abc\'s DOCS list — the client portal shows its items to the client, and the case\'s public documents link (no sign-in) lists every incomplete item by name. "Bank statements" appears there as soon as it is added.']);
  });
  test('an item UPDATED on the docs list is disclosed for each change', async () => {
    const done = await run(update(5130));
    expect(done.warnings[0]).toMatch(/^CLIENT-VISIBLE: .* Completing "Pay stubs" takes it off the public documents link and shows it to the client as received\.$/);
    const renamed = await run(update(5130, { status: undefined, name: 'Pay stubs (last 6 months)' }));
    expect(renamed.warnings[0]).toMatch(/The client sees the new name "Pay stubs \(last 6 months\)"\.$/);
  });
  test('a list that is NOT the docs list carries no client warning', async () => {
    expect((await run(add(412))).warnings).toEqual([]);
    expect((await run(update(5120))).warnings).toEqual([]);
  });
});

describe('link types and evidence', () => {
  test('a case list cites the exact case_id; a contact list the exact contact_id', async () => {
    await refuse(create({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The list evidence does not identify case 7KQ2M9XA — cite a row carrying its exact case_id/);
    await refuse(create({ link_type: 'contact', link: 77 }), /^The list evidence does not identify contact 77 — cite a row carrying its exact contact_id/);
    await refuse(create({ link_type: 'contact', link: 'abc' }), /^A contact list needs link = the contact's exact positive contact_id$/);
    await refuse(create({ link: 'bad id!' }), /^A case list needs link = the case's exact case_id$/);
  });
  test('a missing case / contact is refused after the evidence', async () => {
    await refuse(create(), /^Case 7KQ2M9XA no longer exists$/, { caseMissing: true });
    await refuse(create({ link_type: 'contact', link: 77, evidence: [{ query_id: 'q2', row_number: 1 }] }), /^Contact 77 no longer exists$/, { contactMissing: true });
  });
  test('a personal list: the asker\'s own needs no evidence; an ACTIVE colleague\'s is a card naming them (A10X); an inactive one is refused', async () => {
    const card = await run(create({ link_type: 'user', link: undefined, evidence: [] }));
    expect([card.list.link_type, card.list.link, card.parent.label, card.evidence, card.owner]).toEqual(['user', '6', 'your personal list', [], null]);
    expect((await run(create({ link_type: 'user', link: '6', evidence: undefined }))).list.link).toBe('6');
    const theirs = await run(create({ link_type: 'user', link: 1, evidence: [] }));
    expect([theirs.list.link, theirs.parent.label, theirs.owner]).toEqual(['1', 'Stuart (user #1)\'s personal list', { user_id: 1, name: 'Stuart', label: 'Stuart (user #1)' }]);
    expect(theirs.warnings).toContain('ANOTHER USER\'S LIST: this makes a personal list FOR Stuart (user #1) — it shows under their own lists on the Notes & Lists page, not yours, and Stuart is not told: neither the route nor Casey sends anything.');
    await refuse(create({ link_type: 'user', link: 2, evidence: [] }), /^A personal list for Retired \(user #2\) is not available — they are not an active staff member \(retired or inactive\)/);
    await refuse(create({ link_type: 'user', evidence: [] }), /^A personal list needs a signed-in staff user$/, undefined, undefined, null);
  });
  test('a bill list is refused by name (no bills table or read route); appt / task / event lists need the record\'s exact cited id (A10X)', async () => {
    await refuse(create({ link_type: 'bill', link: '5' }), /^A list on a bill is not available to Casey — bills have no verifiable record source/);
    await refuse(create({ link_type: 'appt', link: '5' }), /^The list evidence does not identify appointment 5 — cite a row carrying its exact appt_id/);
    await refuse(create({ link_type: 'task', link: '5' }), /^The list evidence does not identify task 5 — cite a row carrying its exact task_id/);
    await refuse(create({ link_type: 'event', link: '5' }), /^The list evidence does not identify event 5 — cite a row carrying its exact event_id/);
  });
  test('no link type at all is refused, naming every kind and "none"', async () => {
    await refuse(create({ link_type: undefined }), /^A new list needs link_type: "case" .* "contact" .* "appt" \/ "event" \/ "task" .* "user" .* or "none"/);
  });
});

describe('the route\'s shape rules, refused before the click', () => {
  test('title: required, at most 255 characters (the column clips silently)', async () => {
    await refuse(create({ title: '   ' }), /^The list title is empty$/);
    await refuse(create({ title: 'x'.repeat(256) }), /^The list title is 256 characters — the column keeps 255$/);
    await expect(run(create({ title: 'x'.repeat(255) }))).resolves.toBeTruthy();
  });
  test('a note with items, a checklist with a body, a bad kind', async () => {
    await refuse(create({ list_kind: 'note' }), /^A note holds freeform text, not items/);
    await refuse(create({ list_kind: 'note', items: [] }), /^A note holds freeform text, not items/);
    await refuse(create({ items: undefined, body: 'text' }), /^A checklist holds items, not a body/);
    await refuse(create({ list_kind: 'board' }), /^list_kind must be "checklist" or "note"/);
  });
  test('a note body over lib/noteLimits is refused; a title-only note is fine', async () => {
    await refuse(create({ list_kind: 'note', items: undefined, body: 'y'.repeat(10001) }), /^The note body is 10,001 characters — the limit is 10,000/);
    const note = await run(create({ list_kind: 'note', items: undefined, body: '' }));
    expect([note.list.list_kind, note.list.body, note.items]).toEqual(['note', '', []]);
  });
  test('initial items: at most 25, each 1-255 characters, no duplicate names', async () => {
    await refuse(create({ items: Array.from({ length: 26 }, (_, i) => `i${i}`) }), /^A new list carries at most 25 items on one card \(26 given\)/);
    await expect(run(create({ items: Array.from({ length: 25 }, (_, i) => `i${i}`) }))).resolves.toBeTruthy();
    await refuse(create({ items: ['a', ' '] }), /^Item 2's name is empty$/);
    await refuse(create({ items: ['a'.repeat(256)] }), /^Item 1's name is 256 characters/);
    await refuse(create({ items: ['Pay stubs', 'pay stubs '] }), /^Item "pay stubs" is listed twice/);
    await refuse(create({ items: 'a, b' }), /^items must be a list of item names$/);
  });
});

describe('the create card', () => {
  test('names the record, the list, the items; expected = the record\'s lists', async () => {
    const card = await run(create());
    expect(card).toMatchObject({
      kind: 'checklist.create.v1', status: 'draft',
      list: { title: 'Pre-filing to-dos 2', list_kind: 'checklist', body: null, link_type: 'case', link: CASE_ID },
      parent: { link_type: 'case', case_id: CASE_ID, case_number: '25-12345-abc', label: 'case 25-12345-abc' },
      items: ['Pull credit report', 'Order transcripts'], existing_total: 3, warnings: [],
      expected: { link_type: 'case', link: CASE_ID, list_ids: [412, 413, 414] },
    });
    expect(card.effects).toEqual([
      'Staff only: the list shows on the case\'s Notes & Lists tab; it is not shown to the client (only the case\'s docs list is).',
      'Status: derived from its items — it starts incomplete (2 incomplete items).',
      'Trigger event: none — creating a list emits no event, so no trigger rule runs.']);
  });
  test('a list with the same title already on the record is a WARNING, not a refusal', async () => {
    const card = await run(create({ title: 'pre-filing TO-DOS' }));
    expect(card.warnings).toEqual(['DUPLICATE TITLE: case 25-12345-abc already has a checklist titled "Pre-filing to-dos" (#412). This makes a SECOND one — duplicates are allowed; to add to the existing list instead, ask Casey to add items to it.']);
  });
  test('a record with more lists than one card reviews is refused', async () => {
    const onParent = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, title: `L${i}`, kind: 'checklist' }));
    await refuse(create(), /already has 201 notes and lists — more than one card can review \(200\)/, { onParent });
  });
});

describe('the item add card', () => {
  test('evidence cites the exact checklist_id', async () => {
    await refuse(add(412, 'x', { evidence: listRow(413) }), /^The item evidence does not identify checklist #412 — cite a row carrying its exact checklist_id/);
  });
  test('a note, a missing list, another user\'s list and an appt list refuse by name', async () => {
    await refuse(add(414), /^"Call log" \(#414\) is a NOTE, not a checklist — notes hold freeform text, never items/);
    await refuse(add(499, 'x', { evidence: [{ query_id: 'q3', row_number: 1 }] }), /^The item evidence does not identify checklist #499/);
    await refuse(add(499, 'x', { evidence: [{ query_id: 'q9', row_number: 1 }] }), /evidence is outside this investigation/);
    // A10X: an active colleague's list and an appointment's list are cards now.
    await expect(run(add(417))).resolves.toMatchObject({ owner: { user_id: 1, name: 'Stuart' }, parent: { label: 'Stuart (user #1)\'s personal list' } });
    await expect(run(add(418))).resolves.toMatchObject({ owner: null, parent: { link_type: 'appt', label: 'appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Client)' } });
    await expect(run(add(416, 'Book CLE'))).resolves.toMatchObject({ parent: { link_type: 'user', label: 'your personal list' } });
  });
  test('a duplicate name (trimmed, any capitalisation) is refused — stricter than the route', async () => {
    await refuse(add(412, '  pull CREDIT report '), /^"Pre-filing to-dos" already has an item named "Pull credit report" \(#5120, incomplete\) — nothing is proposed/);
    await refuse(add(412, 'x'.repeat(256)), /^The item name is 256 characters/);
  });
  test('the card: the list, the new item, the items now, the status; expected = the list and every item', async () => {
    const card = await run(add(412, ' 2024 W-2 '));
    expect(card).toMatchObject({
      kind: 'checklist.item.add.v1', item: { name: '2024 W-2' }, items_total: 2,
      list: { checklist_id: 412, title: 'Pre-filing to-dos', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: false },
      items_before: [{ name: 'Pull credit report', status: 'incomplete' }, { name: 'Order transcripts', status: 'complete' }],
      list_status: { from: 'incomplete', to: 'incomplete' },
      expected: { title: 'Pre-filing to-dos', kind: 'checklist', link_type: 'case', link: CASE_ID, tag: null, status: 'incomplete',
        items: ['5120:incomplete:Pull credit report', '5121:complete:Order transcripts'] },
    });
    expect(card.effects).toEqual(['Writes: one new item (incomplete) at the end of the list — nothing else on the list changes.',
      'Trigger event: none — adding an item emits no event, so no trigger rule runs.']);
  });
  test('a list with more items than one card reviews is refused', async () => {
    const lists = baseLists();
    lists[412].items = Array.from({ length: 201 }, (_, i) => ({ id: 6000 + i, name: `i${i}`, status: 'incomplete', position: i + 1 }));
    await refuse(add(412), /^"Pre-filing to-dos" has 201 items — more than one card can review \(200\)/, { lists });
  });
  test('adding to a COMPLETE list reopens it — a warning', async () => {
    const card = await run(add(415, 'Countersigned'));
    expect(card.list_status).toEqual({ from: 'complete', to: 'incomplete' });
    expect(card.warnings).toEqual(['REOPENS THE LIST: "Done list" is complete; a new incomplete item makes it incomplete again (no event fires for that).']);
  });
});

describe('the item update card', () => {
  test('evidence cites the exact checkitem_id; name / status rules', async () => {
    await refuse(update(5120, { evidence: itemRow(5121) }), /^The item evidence does not identify item #5120 — cite a row carrying its exact checkitem_id/);
    await refuse(update(5120, { status: undefined }), /^An item update needs "name" \(the new name\), "status" \("complete" or "incomplete"\), or both$/);
    await refuse(update(5120, { status: 'done' }), /^status must be "complete" or "incomplete" \(got "done"\)$/);
    await refuse(update(5120, { status: 'incomplete' }), /^Item "Pull credit report" is already incomplete — that changes nothing$/);
    await refuse(update(5120, { status: undefined, name: 'Pull credit report' }), /is already incomplete with that name — that changes nothing/);
    await refuse(update(5120, { status: undefined, name: 'order TRANSCRIPTS' }), /^"Pre-filing to-dos" already has an item named "Order transcripts" \(#5121\) — renaming "Pull credit report" to that would make two/);
  });
  test('the last open item completes the list: both route emits, every active rule dry-run', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({
      'checkitem.completed': [{ id: 31, name: 'Item done → log', cooling_down: 0, actions: [{ action_type: 'internal_function', config: { function_name: 'create_log' } }] }],
      'checklist.completed': [{ id: 32, name: 'List done → advance', cooling_down: 0, actions: [{ action_type: 'workflow', config: { workflow_id: 9 } }] },
        { id: 33, name: 'Docs only', cooling_down: 0, actions: [] }],
    });
    const seen = [];
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (rule, env) => { seen.push([rule.id, env]); return { matched: rule.id !== 33 }; }));
    const card = await run(update(5120));
    expect(card).toMatchObject({
      kind: 'checklist.item.update.v1',
      item: { checkitem_id: 5120, checklist_id: 412, from: { name: 'Pull credit report', status: 'incomplete' }, to: { name: 'Pull credit report', status: 'complete' } },
      changes: { name: null, status: 'complete' },
      list_status: { from: 'incomplete', to: 'complete' },
      automation: { events: ['checkitem.completed', 'checklist.completed'], rules_checked: 3, quiet: 1,
        lines: ['Trigger rule #31 "Item done → log" runs: calls create_log', 'Trigger rule #32 "List done → advance" runs: starts workflow #9'] },
      warnings: [],
      expected: { status: 'incomplete', items: ['5120:incomplete:Pull credit report', '5121:complete:Order transcripts'] },
    });
    expect(card.effects).toEqual(['List status: "Pre-filing to-dos" becomes COMPLETE — this is its last open item.',
      'Trigger events: checkitem.completed and checklist.completed fire — every active rule on them is listed below.']);
    // The route's own envelopes (PATCH /checkitems/:id), mirrored field for field.
    const item = seen.find(([id]) => id === 31)[1];
    expect([item.event, item.case_id, item.contact_id, item.actor, item.data]).toEqual(['checkitem.completed', CASE_ID, null, { user_id: ME },
      { item_id: 5120, name: 'Pull credit report', checklist_id: 412, tag: null, title: 'Pre-filing to-dos', link_type: 'case', checklist_status: 'complete' }]);
    const list = seen.find(([id]) => id === 32)[1];
    expect([list.event, list.data]).toEqual(['checklist.completed', { checklist_id: 412, title: 'Pre-filing to-dos', tag: null, link_type: 'case' }]);
  });
  test('completing an item that leaves another open emits checkitem.completed only; a contact list carries contact_id', async () => {
    const lists = baseLists();
    lists[415].row.status = 'incomplete';
    lists[415].items = [{ id: 5150, name: 'Signed', status: 'incomplete', position: 1 }, { id: 5151, name: 'Filed', status: 'incomplete', position: 2 }];
    const seen = [];
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'checkitem.completed': [{ id: 31, name: 'r', actions: [] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (_r, env) => { seen.push(env); return { matched: false }; }));
    const card = await run(update(5150), { lists });
    expect([card.automation.events, card.list_status, seen.map((e) => [e.event, e.contact_id, e.case_id])])
      .toEqual([['checkitem.completed'], { from: 'incomplete', to: 'incomplete' }, [['checkitem.completed', 77, null]]]);
    expect(card.effects).toContain('List status: stays incomplete.');
  });
  test('reopening an item of a complete list reopens it (a warning, no event); a rename emits nothing', async () => {
    const reopen = await run(update(5150, { status: 'incomplete' }));
    expect([reopen.list_status, reopen.automation.events, reopen.warnings]).toEqual([{ from: 'complete', to: 'incomplete' }, [],
      ['REOPENS THE LIST: "Done list" is complete; reopening this item makes it incomplete again (no event fires for that).']]);
    expect(reopen.effects).toContain('Trigger event: none — reopening an item emits no event.');
    const rename = await run(update(5120, { status: undefined, name: 'Pull all three credit reports' }));
    expect([rename.changes, rename.automation.events]).toEqual([{ name: 'Pull all three credit reports', status: null }, []]);
    expect(rename.effects).toContain('Trigger event: none — renaming an item emits no event.');
  });
  test('a NULL stored list status never transitions (computeAndSaveStatus\'s WHERE status <> ?), so no checklist.completed', async () => {
    const lists = baseLists();
    lists[412].row.status = null;
    const card = await run(update(5120), { lists });
    expect([card.list_status, card.automation.events]).toEqual([{ from: null, to: null }, ['checkitem.completed']]);
  });
  test('a rule that cannot be evaluated MAY run — a danger warning', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'checkitem.completed': [{ id: 31, name: 'Code rule', actions: [{ action_type: 'hook', config: { slug: 'x' } }] }] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async () => ({ match_error: 'GUEST_CODE_BUSY' })));
    const card = await run(update(5120));
    expect(card.automation.lines).toEqual(['Trigger rule #31 "Code rule" could not be evaluated for this item (GUEST_CODE_BUSY) — it MAY run: runs hook "x"']);
    expect(card.warnings).toEqual(['AUTOMATION: at least one trigger rule could not be evaluated for this change — read its line; it may run.']);
  });
  test('your own and an active colleague\'s list item are fine (A10X); a wrong citation and a missing item are refused', async () => {
    await expect(run(update(5160))).resolves.toMatchObject({ parent: { link_type: 'user' } });
    const lists = baseLists();
    lists[417].items = [{ id: 5170, name: 'x', status: 'incomplete', position: 1 }];
    await refuse(update(5170, { evidence: [{ query_id: 'q5', row_number: 1 }] }), /^The item evidence does not identify item #5170/, { lists },
      [...EVIDENCE, { id: 'q5', rows: [{ checkitem_id: 5171 }] }]);
    const theirs = await run(update(5170, { evidence: [{ query_id: 'q5', row_number: 1 }] }), { lists }, [...EVIDENCE, { id: 'q5', rows: [{ checkitem_id: 5170 }] }]);
    expect([theirs.owner.user_id, theirs.warnings[0]]).toEqual([1, 'ANOTHER USER\'S LIST: this is Stuart (user #1)\'s personal list — the route lets any staff member work on a colleague\'s list (delegation), and Stuart is not told: neither the route nor Casey sends anything.']);
    await refuse(update(5199, { evidence: [{ query_id: 'q5', row_number: 1 }] }), /^Checklist item #5199 no longer exists$/, undefined,
      [...EVIDENCE, { id: 'q5', rows: [{ checkitem_id: 5199 }] }]);
  });
});

describe('the ledger, the request detector', () => {
  test('create and item add receipt the integer checklist_id; the update receipts checkitem_id', () => {
    expect(ledger.KINDS.get('checklist.create.v1')).toBe('checklist_id');
    expect(ledger.KINDS.get('checklist.item.add.v1')).toBe('checklist_id');
    expect(ledger.KINDS.get('checklist.item.update.v1')).toBe('checkitem_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('checklist_id')).toBe(false);
    expect(ledger.STRING_RECEIPT_FIELDS.has('checkitem_id')).toBe(false);
  });
  test.each([
    'Make a checklist on this case for the pre-filing steps',
    'Add "2024 W-2" to the docs needed list',
    'Check off the credit report item',
    'tick it off',
    'Create a to-do list for me',
    'rename that checklist item to Pay stubs',
  ])('a checklist request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['What is on the docs needed list?', 'list the cases filed this week', 'How many checklists does case 25-12345 have?'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(false);
  });
});
