'use strict';
/**
 * tests/caseyChecklistEdit.test.js
 *
 * A10.2 — Casey does what the Notes & Lists page itself does to an existing
 * list, through reviewed cards:
 *   checklist.update.v1      → PATCH  /checklists/:id {title?, status?, body?}
 *                              (the page's editTitle / toggleNoteDone / saveBody)
 *   checklist.delete.v1      → DELETE /checklists/:id   (deleteList — items cascade)
 *   checklist.item.delete.v1 → DELETE /checkitems/:id   (deleteItem)
 * There is no reorder kind: the page has no item reorder and the routes no
 * atomic reorder route (manager ruling (a), 2026-11-11).
 *
 * The contract pinned here (mocked db; the resolver and the checklist
 * detector are the REAL services/requirementService + requirementDetectors,
 * answered by the fake db):
 *   1. the casey_checklists_enabled switch covers the three kinds;
 *   2. tag / position (system fields), list_kind (immutable), link / link_type
 *      (a move) and items (item cards' job) refused BY NAME before any read;
 *      unknown fields refused;
 *   3. update: the title width is information_schema's, in characters; an
 *      empty, multi-line or control-character title; a status outside the
 *      column's ENUM or the page's two; a body / status on a checklist (the
 *      route's own rule); a note text with control characters or over
 *      lib/noteLimits; a change that changes nothing (NULL and '' are one
 *      empty note); a rename INTO "Docs Needed" on a case refused; a rename
 *      OUT of a title-only docs list warned; a duplicate title warned;
 *   4. delete: NO UNDO, the cascade counts, the docs list, a tagged list, a
 *      contact's list on its cases' boards, another user's personal list
 *      (refused naming the owner; a SUPERUSER may delete it, warned);
 *   5. item delete: NO UNDO, the derived list status after (complete → the
 *      checklist.completed dry run; the last item of a complete list reopens
 *      it), the docs list;
 *   6. THE PIPELINE PROJECTION: the real resolver re-run over the post-state
 *      names each step whose status moves (danger); a case with no checklist
 *      step, a contact list, an unchanged step each say so; the shape guard
 *      refuses a resolver that reads the checklists any other way;
 *   7. expected, the ledger receipts, the request detector;
 *   8. the browser half (lifted from public/assistant.html by name): the fixed
 *      requests, the click-time re-read, the result checks, the outcomes, the
 *      danger and the card text.
 *
 * The routes' real behaviour (the cascade, the 403 / 404 / 400s, the
 * recompute and its emit) and the projection against the real resolver after
 * the real write run on a real engine in tests/caseyChecklistEdit.mysql.test.js.
 *
 *   npx jest tests/caseyChecklistEdit.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const requirementService = require(path.join(REPO, 'services', 'requirementService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const SU = 9;

function baseLists() {
  return {
    412: { row: { id: 412, title: 'Pre-filing to-dos', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5120, name: 'Pull credit report', status: 'incomplete', position: 1 }, { id: 5121, name: 'Order transcripts', status: 'complete', position: 2 }] },
    413: { row: { id: 413, title: 'Docs Needed', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: 'docs_needed', docs_list: 1 }, body: null,
      items: [{ id: 5130, name: 'Pay stubs', status: 'incomplete', position: 1 }, { id: 5131, name: 'Photo ID', status: 'complete', position: 2 }] },
    414: { row: { id: 414, title: 'Call log', kind: 'note', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 }, body: 'Called 11/2 — left a message', items: [] },
    415: { row: { id: 415, title: 'Done list', kind: 'checklist', status: 'complete', link_type: 'contact', link: '77', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5150, name: 'Signed', status: 'complete', position: 1 }] },
    416: { row: { id: 416, title: 'Fred to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: String(ME), tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5160, name: 'Renew bar dues', status: 'incomplete', position: 1 }] },
    417: { row: { id: 417, title: 'Stuart to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: '1', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5170, name: 'Call trustee', status: 'incomplete', position: 1 }] },
    418: { row: { id: 418, title: 'Appt prep', kind: 'checklist', status: 'incomplete', link_type: 'appt', link: '55', tag: null, docs_list: 0 }, body: null, items: [] },
    419: { row: { id: 419, title: 'docs needed', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 1 }, body: null,
      items: [{ id: 5190, name: 'Bank statements', status: 'incomplete', position: 1 }] },
    420: { row: { id: 420, title: 'Intake forms', kind: 'checklist', status: 'complete', link_type: 'case', link: CASE_ID, tag: 'intake_forms', docs_list: 0 }, body: null,
      items: [{ id: 5200, name: 'Questionnaire', status: 'complete', position: 1 }] },
  };
}

// One intake template, one stage the case sits on, two checklist steps (by
// tag) and a manual one — the shape the real resolver needs.
const REQS = [
  { id: 901, stage_id: 21, requirement_key: 'docs_in', internal_label: 'Documents received', required: 1, detector: 'checklist', detector_config: '{"tag":"docs_needed"}', sort_order: 1, active: 1 },
  { id: 902, stage_id: 21, requirement_key: 'forms_in', internal_label: 'Intake forms received', required: 0, detector: 'checklist', detector_config: '{"tag":"intake_forms"}', sort_order: 2, active: 1 },
  { id: 903, stage_id: 21, requirement_key: 'fee', internal_label: 'Retainer fee paid', required: 1, detector: 'manual', detector_config: null, sort_order: 3, active: 1 },
];

function makeDb(over = {}) {
  const lists = over.lists || baseLists();
  const reqs = over.noPipeline ? [] : (over.reqs || REQS);
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS width, COLUMN_TYPE AS column_type FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'checklists' AND COLUMN_NAME IN \('title', 'status'\)$/.test(flat)) {
      if (over.noColumns) return [[]];
      return [[{ name: 'title', width: over.titleWidth || 255, column_type: 'varchar(255)' },
        { name: 'status', width: 10, column_type: over.statusType || "enum('incomplete','complete')" }]];
    }
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') {
      return [String(params[0]).toLowerCase() !== CASE_ID.toLowerCase() ? [] : [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy' }]];
    }
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1') {
      return [Number(params[0]) === 77 ? [{ contact_id: 77, contact_name: 'Dana Client' }] : []];
    }
    if (/^SELECT cl\.id, cl\.title, cl\.kind, cl\.status, cl\.link_type, cl\.link, cl\.tag, COALESCE\(.*\) AS docs_list FROM checklists cl WHERE cl\.id = \? LIMIT 1$/.test(flat)) {
      const l = lists[Number(params[0])];
      return [l ? [{ ...l.row }] : []];
    }
    if (flat === 'SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC') {
      const l = lists[Number(params[0])];
      return [l ? l.items.map((i) => ({ ...i })) : []];
    }
    if (flat === 'SELECT body FROM checklists WHERE id = ? LIMIT 1') {
      const l = lists[Number(params[0])];
      return [l ? [{ body: l.body }] : []];
    }
    if (flat === 'SELECT checklist_id FROM checkitems WHERE id = ? LIMIT 1') {
      for (const [id, l] of Object.entries(lists)) if (l.items.some((i) => i.id === Number(params[0]))) return [[{ checklist_id: Number(id) }]];
      return [[]];
    }
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') {
      return [Number(params[0]) === 1 ? [{ user: 1, user_name: 'Stuart' }] : []];
    }
    if (flat === 'SELECT user_auth, roles FROM users WHERE user = ? LIMIT 1') {
      const uid = Number(params[0]);
      return [[{ user_auth: 'authorized', roles: uid === SU ? 'staff,su' : 'staff' }]];
    }
    if (flat === 'SELECT id, title, kind FROM checklists WHERE link_type = ? AND link = ? ORDER BY created_date ASC, id ASC') {
      return [Object.values(lists).filter((l) => l.row.link_type === params[0] && String(l.row.link) === String(params[1])).map((l) => ({ id: l.row.id, title: l.row.title, kind: l.row.kind }))];
    }
    if (flat === 'SELECT COUNT(DISTINCT case_relate_case_id) AS n FROM case_relate WHERE case_relate_client_id = ?') {
      return [[{ n: Number(params[0]) === 77 ? 3 : 0 }]];
    }
    // ── the real resolver's reads ──
    if (flat.startsWith('SELECT case_id, case_type, case_subtype, pipeline_phase FROM cases WHERE case_id IN (?)')) {
      return [[{ case_id: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'intake' }]];
    }
    if (flat === 'SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC') {
      return [[{ id: 1, name: 'Intake', role: 'intake', case_type: '', case_subtype: '', is_default: 0, active: 1 }]];
    }
    if (flat.startsWith('SELECT id, template_id, stage_key, stage_number, lane FROM pipeline_stages')) {
      return [[{ id: 21, template_id: 1, stage_key: 'docs', stage_number: 1, lane: 'main' }]];
    }
    if (flat.startsWith('SELECT * FROM pipeline_stage_requirements')) return [reqs.map((r) => ({ ...r }))];
    if (flat.startsWith('SELECT l.case_id, l.template_id, l.stage_key FROM case_stage_log l')) {
      return [[{ case_id: CASE_ID, template_id: 1, stage_key: 'docs' }]];
    }
    if (flat.startsWith('SELECT case_id, requirement_key, status, note, set_by, updated_at FROM case_requirement_overrides')) return [[]];
    if (flat.startsWith('SELECT id, link, tag, status, updated_date FROM checklists')) {
      const [ids, tags] = params;
      return [Object.values(lists).filter((l) => l.row.link_type === 'case' && l.row.kind === 'checklist' && ids.map(String).includes(String(l.row.link)) && tags.includes(l.row.tag))
        .map((l) => ({ id: l.row.id, link: l.row.link, tag: l.row.tag, status: l.row.status, updated_date: new Date('2026-11-01T10:00:00Z') }))];
    }
    if (flat.startsWith('SELECT checklist_id, COUNT(*) AS total, SUM(status = \'complete\') AS done FROM checkitems')) {
      return [params[0].map(Number).map((id) => lists[id]).filter((l) => l && l.items.length)
        .map((l) => ({ checklist_id: l.row.id, total: l.items.length, done: String(l.items.filter((i) => i.status === 'complete').length) }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

const LIST_IDS = [412, 413, 414, 415, 416, 417, 418, 419, 420];
const ITEM_IDS = [5120, 5121, 5130, 5131, 5150, 5160, 5170, 5190, 5200];
const EVIDENCE = [
  { id: 'q3', rows: LIST_IDS.map((id) => ({ checklist_id: id })) },
  { id: 'q4', rows: ITEM_IDS.map((id) => ({ checkitem_id: id })) },
];
const listRow = (id) => [{ query_id: 'q3', row_number: LIST_IDS.indexOf(id) + 1 }];
const itemRow = (id) => [{ query_id: 'q4', row_number: ITEM_IDS.indexOf(id) + 1 }];

const upd = (id = 412, over = {}) => ({ kind: 'checklist.update.v1', checklist_id: id, evidence: listRow(id), ...over });
const del = (id = 412, over = {}) => ({ kind: 'checklist.delete.v1', checklist_id: id, evidence: listRow(id), ...over });
const idel = (id = 5121, over = {}) => ({ kind: 'checklist.item.delete.v1', checkitem_id: id, evidence: itemRow(id), ...over });

let spies = [];
function rulesFor(map = {}) {
  spies.push(jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => (map[ev] || []).map((r) => ({ ...r }))));
}
beforeEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; rulesFor(); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CHECKLISTS_ENABLED; });

const run = (value, dbOver, evidence = EVIDENCE, userId = ME) => normalizeActionDraft(makeDb(dbOver), value, evidence, { currentUserId: userId });
const refuse = (value, re, dbOver, evidence, userId) => expect(run(value, dbOver, evidence, userId)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes the three A10.2 kinds unavailable; unset is ON", async () => {
    const all = [upd(412, { title: 'New' }), del(), idel()];
    process.env.CASEY_CHECKLISTS_ENABLED = '0';
    for (const v of all) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_CHECKLISTS_ENABLED;
    for (const v of all) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('refused BY NAME before anything is read', () => {
  test.each([
    ['tag on an update (SU-only system field)', () => upd(412, { tag: 'docs_needed' }), /^TAG refused: `tag` is a system field — only automation and superusers set it .*\(checklist\.update\.v1\)$/],
    ['tag on a delete', () => del(412, { tag: null }), /^TAG refused/],
    ['position on an item delete', () => idel(5121, { position: 1 }), /^POSITION refused/],
    ['list_kind on an update (immutable)', () => upd(414, { list_kind: 'checklist' }), /^KIND refused: a list's kind never changes .*\(checklist\.update\.v1\)$/],
    ['link on an update (a move)', () => upd(412, { link: 'OTHER123' }), /^MOVE refused: the Notes & Lists page never moves a list to another record/],
    ['link_type + link on an update — one MOVE sentence', () => upd(412, { link: '77', link_type: 'contact' }), /^MOVE refused: [^;]*\(checklist\.update\.v1\)$/],
    ['items on an update', () => upd(412, { items: ['x'] }), /^ITEMS refused: a list update changes the list itself/],
  ])('%s', async (_n, value, re) => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, value(), EVIDENCE, { currentUserId: ME })).rejects.toThrow(re);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('unknown keys are refused, naming what each kind takes', async () => {
    await refuse(upd(412, { title: 'x', name: 'y' }), /^A checklist\.update\.v1 card carries unsupported fields: name — it takes checklist_id, title, status, body, evidence only$/);
    await refuse(del(412, { title: 'x' }), /^A checklist\.delete\.v1 card carries unsupported fields: title — it takes checklist_id, evidence only$/);
    await refuse(idel(5121, { checklist_id: 412 }), /^A checklist\.item\.delete\.v1 card carries unsupported fields: checklist_id — it takes checkitem_id, evidence only$/);
  });
});

describe('checklist.update.v1 — rename a list, a note\'s done state, a note\'s text', () => {
  test('a rename: the card, its effects and expected (the whole list, the text, every item)', async () => {
    const card = await run(upd(412, { title: '  Pre-filing to-dos (2026)  ' }));
    expect(card).toMatchObject({ kind: 'checklist.update.v1', changes: { title: 'Pre-filing to-dos (2026)' }, before: { title: 'Pre-filing to-dos' }, warnings: [], items_total: 2 });
    expect(card.expected).toEqual({ title: 'Pre-filing to-dos', kind: 'checklist', link_type: 'case', link: CASE_ID, tag: null, status: 'incomplete', body: null,
      items: ['5120:incomplete:Pull credit report', '5121:complete:Order transcripts'] });
    expect(card.effects).toEqual([
      'Writes: this list\'s title — nothing else (no item, no tag, no record).',
      'Trigger event: none — this route emits no event (a note\'s done state deliberately emits none), so no trigger rule runs.',
      'Pipeline: no step changes — a step\'s checklist detector reads only a case\'s tagged CHECKLISTS and their derived status, never a note, a title or a note\'s text.',
      'Other open pages: PATCH /checklists/:id is not on the sync bus — another open Notes & Lists board keeps showing the old list until it reloads (re-entering its tab reloads it).']);
    expect(card.evidence).toEqual([expect.objectContaining(listRow(412)[0])]);
  });

  test('the title width is information_schema\'s, counted in characters', async () => {
    await refuse(upd(412, { title: 'x'.repeat(256) }), /^The list title is 256 characters — the column keeps 255 and the route would cut it short silently$/);
    await refuse(upd(412, { title: 'x'.repeat(101) }), /^The list title is 101 characters — the column keeps 100/, { titleWidth: 100 });
    await expect(run(upd(412, { title: 'x'.repeat(100) }), { titleWidth: 100 })).resolves.toMatchObject({ changes: { title: 'x'.repeat(100) } });
    // 255 emoji are 510 UTF-16 units but 255 characters — the column keeps them.
    await expect(run(upd(412, { title: '\u{1F600}'.repeat(255) }))).resolves.toMatchObject({ kind: 'checklist.update.v1' });
    await refuse(upd(412, { title: 'x' }), /^The checklists columns could not be read — nothing is proposed$/, { noColumns: true });
  });

  test('an empty, multi-line or control-character title is refused', async () => {
    await refuse(upd(412, { title: '   ' }), /^The list title is empty — the Notes & Lists page never saves an empty title$/);
    await refuse(upd(412, { title: 'a\nb' }), /^The list title is one line of text/);
    await refuse(upd(412, { title: 'a\u0007b' }), /^The list title is one line of text/);
    await refuse(upd(412, { title: 7 }), /^The list title must be text$/);
    await refuse(upd(412, {}), /^A list update needs "title" .* — at least one$/);
  });

  test('a note\'s done state: the page\'s two values, from the column\'s ENUM; never on a checklist', async () => {
    const card = await run(upd(414, { status: 'complete' }));
    expect([card.changes, card.before, card.warnings]).toEqual([{ status: 'complete' }, { status: 'incomplete' }, []]);
    expect(card.effects[0]).toBe('Writes: this note\'s done state — nothing else (no item, no tag, no record).');
    await refuse(upd(414, { status: 'done' }), /^status must be "complete" or "incomplete" \(got "done"\)/);
    await refuse(upd(414, { status: 'complete' }), /^status "complete" is not one the list column holds \(incomplete\)$/, { statusType: "enum('incomplete')" });
    await refuse(upd(412, { status: 'complete' }), /^"Pre-filing to-dos" \(#412\) is a checklist — its status is derived from its items and cannot be set \(the route refuses it\)/);
  });

  test('a note\'s text: replaced whole; tabs and line breaks kept; control characters, over-limit text and a checklist refused', async () => {
    const card = await run(upd(414, { body: 'Called 11/2\n\tleft a message\nCalled 11/5 — spoke to Dana' }));
    expect([card.changes, card.before]).toEqual([{ body: 'Called 11/2\n\tleft a message\nCalled 11/5 — spoke to Dana' }, { body: 'Called 11/2 — left a message' }]);
    expect(card.effects).toContain('Text: the new text REPLACES the stored text whole — exactly what is shown below is saved.');
    expect(card.expected.body).toBe('Called 11/2 — left a message');
    await expect(run(upd(414, { body: '' }))).resolves.toMatchObject({ changes: { body: '' } });
    await refuse(upd(414, { body: 'a\u0000b' }), /^The note text carries a control character/);
    await refuse(upd(414, { body: 'x'.repeat(10001) }), /^The note /);
    await refuse(upd(414, { body: 5 }), /^The note text must be text$/);
    await refuse(upd(412, { body: 'x' }), /^"Pre-filing to-dos" \(#412\) is a checklist — a checklist holds items, not text; only a note has a body \(the route refuses it\)$/);
  });

  test('a change that changes nothing is refused; NULL and \'\' are one empty note', async () => {
    await refuse(upd(412, { title: 'Pre-filing to-dos' }), /^"Pre-filing to-dos" already has that title — that changes nothing$/);
    await refuse(upd(414, { status: 'incomplete', body: 'Called 11/2 — left a message' }), /already has status incomplete and that text — that changes nothing$/);
    const lists = baseLists(); lists[414].body = null;
    await refuse(upd(414, { body: '' }), /already has that text — that changes nothing$/, { lists });
    // One real change among no-ops keeps only the change.
    const card = await run(upd(414, { title: 'Call log', status: 'complete' }));
    expect(card.changes).toEqual({ status: 'complete' });
  });

  test('THE DOCS LIST: a rename INTO "Docs Needed" on a case is refused; OUT of a title-only docs list warned; a tagged one stays', async () => {
    for (const title of ['Docs Needed', 'döcs needed', 'DOCS NEEDED ']) {
      await refuse(upd(412, { title }), /^DOCS LIST refused: on a case, a checklist titled ".*" becomes the case's client-facing docs list/);
    }
    await refuse(upd(414, { title: 'Docs Needed' }), /^DOCS LIST refused: on a case, a note titled/);
    const out = await run(upd(419, { title: 'Bank docs' }));
    expect(out.warnings).toEqual([expect.stringMatching(/^CLIENT-VISIBLE: this is case 25-12345-abc's DOCS list .* It is the docs list ONLY by its title \(it has no docs_needed tag\): renamed "Bank docs", it stops being one — the client portal and the public documents link stop showing its items, with no error\.$/)]);
    const tagged = await run(upd(413, { title: 'Documents we need' }));
    expect(tagged.warnings).toEqual([]);
    expect(tagged.effects).toContain('Docs list: still case 25-12345-abc\'s docs list (by its docs_needed tag) — the client portal and public documents link keep showing its items.');
    // A contact list may take the title: the docs predicate is case-only.
    await expect(run(upd(415, { title: 'Docs Needed' }))).resolves.toMatchObject({ changes: { title: 'Docs Needed' }, warnings: [] });
  });

  test('a duplicate title on the record is warned, not refused', async () => {
    const card = await run(upd(412, { title: 'call LOG' }));
    expect(card.warnings).toEqual(['DUPLICATE TITLE: case 25-12345-abc already has a note titled "Call log" (#414). Duplicates are allowed; both would show under the same title.']);
    // Re-casing a list's own title is not a duplicate of itself.
    expect((await run(upd(412, { title: 'PRE-FILING TO-DOS' }))).warnings).toEqual([]);
  });

  test('the A10 record rules: another user\'s personal list (named), an appointment list, a gone list, uncited evidence', async () => {
    await refuse(upd(417, { title: 'x' }), /^"Stuart to-dos" \(#417\) is another user's personal list — it belongs to Stuart \(user #1\)\. Casey works on your own personal lists only/);
    // An update is never the superuser exception.
    await refuse(upd(417, { title: 'x' }), /another user's personal list/, undefined, undefined, SU);
    await refuse(upd(418, { title: 'x' }), /^"Appt prep" \(#418\) hangs off a appt — Casey works on lists of a case, a contact or your own personal list only/);
    await expect(run(upd(416, { title: 'Fred errands' }))).resolves.toMatchObject({ parent: { label: 'your personal list' } });
    const lists = baseLists(); delete lists[412];
    await refuse(upd(412, { title: 'x' }), /^Checklist #412 no longer exists$/, { lists });
    await refuse(upd(412, { title: 'x', evidence: listRow(413) }), /^The list evidence does not identify checklist #412 — cite a row carrying its exact checklist_id/);
    await refuse(upd(0, { title: 'x' }), /^A list update needs the list's exact positive checklist_id$/);
  });
});

describe('checklist.delete.v1 — a list or note, its items with it', () => {
  test('a case list: NO UNDO with the cascade counts, the pipeline line, expected', async () => {
    const card = await run(del(412));
    expect(card.counts).toEqual({ total: 2, done: 1, open: 1 });
    expect(card.warnings).toEqual(['NO UNDO: the list "Pre-filing to-dos" (#412) is DELETED with its 2 items (1 done, 1 open) — the list and every item are gone for good; the Notes & Lists page has no restore.']);
    expect(card.effects).toEqual([
      'Pipeline: every step of case 25-12345-abc keeps its status — its checklist steps were re-resolved over this change.',
      'Writes: one DELETE — the list and its 2 item rows (the items go with it by the database\'s cascade); nothing else.',
      'Trigger event: none — deleting a list emits no event, so no trigger rule runs.',
      'Other open pages: DELETE /checklists/:id is not on the sync bus — another open Notes & Lists board keeps showing the old list until it reloads (re-entering its tab reloads it).']);
    expect(card.items_before).toEqual([{ name: 'Pull credit report', status: 'incomplete' }, { name: 'Order transcripts', status: 'complete' }]);
    expect(card.pipeline).toEqual([]);
    expect(card.expected.items).toEqual(['5120:incomplete:Pull credit report', '5121:complete:Order transcripts']);
  });

  test('THE PIPELINE: deleting a complete tagged list moves its step done → active (danger); a tagged list is a SYSTEM LIST', async () => {
    const card = await run(del(420));
    expect(card.pipeline).toEqual([{ requirement_key: 'forms_in', stage_key: 'docs', internal_label: 'Intake forms received', required: 0,
      from: 'done', to: 'active', progress_from: '1 of 1 received', progress_to: null }]);
    expect(card.warnings).toContain('PIPELINE: on case 25-12345-abc, "Intake forms received" (stage docs, optional) goes done → active (was 1 of 1 received; no list left to count) — the step\'s checklist detector reads this list by tag; the Steps panel, the board and Casey\'s pipeline cards follow it at once.');
    expect(card.warnings).toContain('SYSTEM LIST: tagged "intake_forms" — automation finds this list by that tag, and finds nothing once it is deleted.');
    expect(card.effects.some((e) => e.startsWith('Pipeline:'))).toBe(false);
  });

  test('the docs list: CLIENT-VISIBLE; its step stays (it was not complete)', async () => {
    const card = await run(del(413));
    expect(card.warnings[1]).toMatch(/^CLIENT-VISIBLE: this is case 25-12345-abc's DOCS list .* Deleted, it disappears from the client portal and the public documents link until a new docs list is made\.$/);
    expect(card.warnings.some((w) => w.startsWith('SYSTEM'))).toBe(false);
    expect(card.pipeline).toEqual([]);
  });

  test('a note: NO UNDO names its text', async () => {
    const card = await run(del(414));
    expect(card.warnings[0]).toBe('NO UNDO: the note "Call log" (#414) is DELETED with its text (28 characters) — it is gone for good; the Notes & Lists page has no restore.');
    expect(card.expected.body).toBe('Called 11/2 — left a message');
  });

  test('a contact\'s list: on the boards of the cases they are on; no pipeline step reads it', async () => {
    const card = await run(del(415));
    expect(card.warnings).toContain('CONTACT\'S LIST: it belongs to Dana Client (contact #77) — deleting it removes it from their Notes & Lists tab and from their group on the board of every case they are on (3 cases).');
    expect(card.effects[0]).toBe('Pipeline: no step reads this list — a pipeline step\'s checklist detector reads only a CASE\'s tagged checklists (this one is a contact\'s).');
  });

  test('another user\'s personal list: refused naming the owner — a SUPERUSER may delete it, warned', async () => {
    await refuse(del(417), /^"Stuart to-dos" \(#417\) is another user's personal list — it belongs to Stuart \(user #1\)\. Only its owner or a superuser may delete it/);
    const card = await run(del(417), undefined, EVIDENCE, SU);
    expect(card.parent).toMatchObject({ link_type: 'user', link: '1', user_id: 1, label: 'Stuart (user #1)\'s personal list' });
    expect(card.warnings).toContain('ANOTHER USER\'S LIST: this is Stuart (user #1)\'s personal list — you may delete it only as a superuser (the route lets an owner or a superuser detach one), and the owner is not told.');
    expect(card.expected.link).toBe('1');
    const mine = await run(del(416));
    expect(mine.warnings.some((w) => w.startsWith('ANOTHER'))).toBe(false);
    expect(mine.effects[0]).toMatch(/^Pipeline: no step reads this list .*\(this one is a personal list\)\.$/);
  });

  test('a case with no checklist step on its pipeline says so', async () => {
    const card = await run(del(420), { noPipeline: true });
    expect(card.effects[0]).toBe('Pipeline: no step of case 25-12345-abc reads a checklist — no checklist requirement is on its pipeline, so no step changes.');
    expect(card.pipeline).toEqual([]);
  });
});

describe('checklist.item.delete.v1 — one item', () => {
  test('an item on an ordinary list: NO UNDO, the list stays, no event', async () => {
    const card = await run(idel(5121));
    expect(card.item).toEqual({ checkitem_id: 5121, checklist_id: 412, name: 'Order transcripts', status: 'complete' });
    expect(card.warnings).toEqual(['NO UNDO: the item "Order transcripts" (#5121, complete) is DELETED from "Pre-filing to-dos" — it is gone for good; the Notes & Lists page has no restore. To keep it as done instead, check it off (checklist.item.update.v1).']);
    expect(card.list_status).toEqual({ from: 'incomplete', to: 'incomplete' });
    expect(card.automation).toEqual({ events: [], lines: [], rules_checked: 0, quiet: 0 });
    expect(card.effects).toEqual([
      'List status: stays incomplete (the route recomputes it after the delete).',
      'Pipeline: every step of case 25-12345-abc keeps its status — its checklist steps were re-resolved over this change.',
      'Trigger event: none — deleting an item emits checklist.completed only when it completes the list, and this one does not.',
      'Writes: one DELETE of this item; the route then recomputes "Pre-filing to-dos"\'s derived status — nothing else.',
      'Other open pages: DELETE /checkitems/:id is not on the sync bus — another open Notes & Lists board keeps showing the old list until it reloads (re-entering its tab reloads it).']);
  });

  test('the last OPEN item of the docs list: the list completes, checklist.completed is dry-run, its step goes done (danger)', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor({ 'checklist.completed': [{ id: 2, name: 'Docs in', match_mode: 'conditions', match_config: { operator: 'and', conditions: [{ path: 'data.tag', op: 'equals', value: 'docs_needed' }] },
      actions: [{ action_type: 'workflow', config: { workflow_id: 42 }, active: 1 }] }] });
    const card = await run(idel(5130));
    expect(card.list_status).toEqual({ from: 'incomplete', to: 'complete' });
    expect(card.automation.events).toEqual(['checklist.completed']);
    expect(card.automation.rules_checked).toBe(1);
    expect(card.automation.lines).toEqual(['Trigger rule #2 "Docs in" runs: starts workflow #42']);
    expect(card.pipeline).toEqual([{ requirement_key: 'docs_in', stage_key: 'docs', internal_label: 'Documents received', required: 1,
      from: 'active', to: 'done', progress_from: '1 of 2 received', progress_to: '1 of 1 received' }]);
    expect(card.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^CLIENT-VISIBLE: .* Deleting "Pay stubs" removes it from what the client is asked for — the portal and the public documents link stop listing it\.$/),
      'PIPELINE: on case 25-12345-abc, "Documents received" (stage docs, required) goes active → done (1 of 1 received) — the step\'s checklist detector reads this list by tag; the Steps panel, the board and Casey\'s pipeline cards follow it at once.']));
    expect(card.effects).toContain('List status: "Docs Needed" becomes COMPLETE — "Pay stubs" is its last open item (the route recomputes the status after the delete).');
    expect(card.effects).toContain('Trigger event: checklist.completed fires after the delete — every active rule on it is listed below.');
  });

  test('a done item on the docs list leaves what the client sees as received', async () => {
    const card = await run(idel(5131));
    expect(card.warnings[1]).toMatch(/Deleting "Photo ID" removes it from what the client sees as received\.$/);
  });

  test('the ONLY item of a complete list: the list reopens (an empty checklist is never complete), its step goes done → active', async () => {
    const card = await run(idel(5200));
    expect(card.list_status).toEqual({ from: 'complete', to: 'incomplete' });
    expect(card.warnings).toContain('REOPENS THE LIST: "Intake forms" is complete; "Questionnaire" is its only item, and a checklist left with no items is never complete (no event fires for that).');
    expect(card.pipeline).toEqual([expect.objectContaining({ requirement_key: 'forms_in', from: 'done', to: 'active', progress_to: '0 of 0 received' })]);
    expect(card.automation.events).toEqual([]);
  });

  test('a gone item, another user\'s list (even for a superuser), uncited evidence are refused', async () => {
    const lists = baseLists(); lists[412].items = lists[412].items.filter((i) => i.id !== 5121);
    await refuse(idel(5121), /^Checklist item #5121 no longer exists$/, { lists });
    await refuse(idel(5170), /^"Stuart to-dos" \(#417\) is another user's personal list — it belongs to Stuart \(user #1\)\. Casey works on your own personal lists only/);
    await refuse(idel(5170), /another user's personal list/, undefined, undefined, SU);
    await refuse(idel(5121, { evidence: itemRow(5120) }), /^The item evidence does not identify item #5121 — cite a row carrying its exact checkitem_id/);
  });
});

describe('THE PROJECTION GUARD — the resolver must read the checklists the way the detector does', () => {
  test('a resolver that reads the checklists twice, or answers off-shape, refuses the card', async () => {
    const twice = jest.spyOn(requirementService, 'resolveRequirements').mockImplementation(async (db) => {
      await db.query("SELECT id, link, tag, status, updated_date FROM checklists WHERE link_type = 'case' AND kind = 'checklist' AND link IN (?) AND tag IN (?)", [[CASE_ID], ['intake_forms']]);
      await db.query("SELECT id, link, tag, status, updated_date FROM checklists WHERE link_type = 'case' AND kind = 'checklist' AND link IN (?) AND tag IN (?)", [[CASE_ID], ['intake_forms']]);
      return new Map([[CASE_ID, []]]);
    });
    try {
      await refuse(del(420), /^The pipeline steps of case 25-12345-abc could not be projected for this change/);
    } finally { twice.mockRestore(); }
    const offShape = jest.spyOn(requirementService, 'resolveRequirements').mockImplementation(async (db) => {
      const wrapped = db;
      await wrapped.query('SELECT checklist_id, COUNT(*) AS total, SUM(status = \'complete\') AS done FROM checkitems WHERE checklist_id IN (?) GROUP BY checklist_id', [[420]]);
      await wrapped.query('SELECT checklist_id, COUNT(*) AS total, SUM(status = \'complete\') AS done FROM checkitems WHERE checklist_id IN (?) GROUP BY checklist_id', [[420]]);
      return new Map([[CASE_ID, []]]);
    });
    try {
      await refuse(idel(5200), /could not be projected/);
    } finally { offShape.mockRestore(); }
  });
});

describe('the ledger and the request detector', () => {
  test('receipts: the list for update and delete, the item for the item delete — integers', () => {
    expect(ledger.KINDS.get('checklist.update.v1')).toBe('checklist_id');
    expect(ledger.KINDS.get('checklist.delete.v1')).toBe('checklist_id');
    expect(ledger.KINDS.get('checklist.item.delete.v1')).toBe('checkitem_id');
    expect(ledger.KINDS.has('checklist.items.reorder.v1')).toBe(false);
  });
  test.each([
    'Delete the pre-filing checklist',
    'remove "Pay stubs" from the docs needed list',
    'rename the to-do list to Errands',
    'retitle that checklist',
    'edit the personal list',
  ])('an edit / delete request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['Which checklists were deleted?', 'How many to-do lists does Fred have?'])('not: %s', (q) => {
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
const FNS = ['checklistParentLabel', 'checklistListLine', 'checklistKnownOutcome', 'checklistEntity', 'checklistOpenPersonal', 'checklistOpen',
  'checklistEditLabel', 'checklistEditShowText', 'checklistEditText', 'checklistEditListId', 'checklistUpdateRequest', 'checklistDeleteRequest',
  'checkitemDeleteRequest', 'checklistEditPrecheck', 'checklistUpdateResult', 'checklistDeleteResult', 'checkitemDeleteResult', 'checklistEditKnownOutcome'];
function browser(api) {
  const src = [constSrc('CHECKLIST_EDIT_ACTION_KINDS'), constSrc('CHECKLIST_DELETE_ACTION_KINDS'), constSrc('CHECKITEM_DELETE_ACTION_KINDS'), ...FNS.map(fnSrc),
    `const families = [${familySrc('checklist_update')}, ${familySrc('checklist_delete')}, ${familySrc('checkitem_delete')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  return new Function('api', 'openEntity', 'P', src)(api, jest.fn(), {}); // eslint-disable-line no-new-func
}

describe('the browser: fixed requests, the whole-list re-read, result checks, outcomes, danger, text', () => {
  let rename; let noteEdit; let delList; let delNote; let delItem; let delLast;
  beforeAll(async () => {
    const mk = async (value, opts) => JSON.parse(JSON.stringify(await normalizeActionDraft(makeDb(opts), value, EVIDENCE, { currentUserId: ME })));
    rulesFor();
    rename = await mk(upd(412, { title: 'Pre-filing (2026)' }));
    noteEdit = await mk(upd(414, { status: 'complete', body: 'New text' }));
    delList = await mk(del(412));
    delNote = await mk(del(414));
    delItem = await mk(idel(5121));
    delLast = await mk(idel(5200));
    spies.forEach((s) => s.mockRestore()); spies = [];
  });

  // GET /checklists/:id as the route answers it (SELECT * + items), from the fixtures.
  function reads({ lists = baseLists(), gone = false, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      const id = Number(p.split('/')[2]);
      const l = lists[id];
      if (gone || !l) throw Object.assign(new Error('Checklist not found'), { status: 404 });
      const { docs_list: _d, ...row } = l.row;
      return { ...row, body: l.body, created_by: 6, created_date: '2026-10-01T10:00:00.000Z', updated_date: '2026-11-01T10:00:00.000Z',
        items: l.items.map((i) => ({ ...i, checklist_id: id, tag: null })) };
    });
    return { api, gets };
  }

  test('the requests: PATCH of the changed fields only; the two DELETEs with no body', () => {
    const b = browser(jest.fn());
    expect(b.checklistUpdateRequest({ ...rename, title: 'junk', tag: 'docs_needed' })).toEqual({ path: '/checklists/412', method: 'PATCH', body: { title: 'Pre-filing (2026)' } });
    expect(b.checklistUpdateRequest(noteEdit)).toEqual({ path: '/checklists/414', method: 'PATCH', body: { status: 'complete', body: 'New text' } });
    expect(b.checklistDeleteRequest(delList)).toEqual({ path: '/checklists/412', method: 'DELETE', body: null });
    expect(b.checkitemDeleteRequest(delItem)).toEqual({ path: '/checkitems/5121', method: 'DELETE', body: null });
    expect(() => b.checklistUpdateRequest({ ...rename, changes: { title: 'x', tag: 'y' } })).toThrow('This card carries a field a list update never writes.');
    expect(() => b.checklistUpdateRequest({ ...rename, changes: { title: ' padded ' } })).toThrow('This card has no usable title.');
    expect(() => b.checklistUpdateRequest({ ...rename, changes: { title: 'x'.repeat(256) } })).toThrow('This card has no usable title.');
    expect(() => b.checklistUpdateRequest({ ...rename, changes: { status: 'complete' } })).toThrow('Only a note\'s done state can be set.');
    expect(() => b.checklistUpdateRequest({ ...rename, changes: { body: 'x' } })).toThrow('Only a note has text.');
    expect(() => b.checklistUpdateRequest({ ...noteEdit, changes: { status: 'done' } })).toThrow('This card has no usable note status.');
    expect(() => b.checklistUpdateRequest({ ...noteEdit, changes: { body: 'x'.repeat(10001) } })).toThrow('This card\'s note text is unusable.');
    expect(() => b.checklistUpdateRequest({ ...rename, changes: {} })).toThrow('This card changes nothing.');
    expect(() => b.checklistDeleteRequest({ ...delList, list: { checklist_id: 'x' } })).toThrow('This card has no usable list id.');
    expect(() => b.checkitemDeleteRequest({ ...delItem, item: { ...delItem.item, checkitem_id: 0 } })).toThrow('This card has no usable item id.');
    expect(() => b.checkitemDeleteRequest({ ...delItem, item: { ...delItem.item, checklist_id: 413 } })).toThrow('This card\'s item and list do not match.');
  });

  test('the precheck: ONE GET of the list; a fresh card passes for every kind', async () => {
    for (const card of [rename, noteEdit, delList, delNote, delItem, delLast]) {
      const { api, gets } = reads();
      await expect(browser(api).checklistEditPrecheck(card)).resolves.toBe('');
      expect(gets).toEqual([`/checklists/${card.list.checklist_id}`]);
    }
  });

  test.each([
    ['the title', (l) => { l[412].row.title = 'Renamed by hand'; }, /^The list "Pre-filing to-dos" changed since this card was prepared \(its title, kind, record, tag or status\)/],
    ['the tag', (l) => { l[412].row.tag = 'x'; }, /^The list "Pre-filing to-dos" changed/],
    ['the status', (l) => { l[412].row.status = 'complete'; }, /^The list "Pre-filing to-dos" changed/],
    ['the record (moved)', (l) => { l[412].row.link = 'OTHER123'; }, /^The list "Pre-filing to-dos" changed/],
    ['the record type', (l) => { l[412].row.link_type = 'contact'; }, /^The list "Pre-filing to-dos" changed/],
    ['an item checked', (l) => { l[412].items[0].status = 'complete'; }, /^The items on "Pre-filing to-dos" changed since this card was prepared/],
    ['an item renamed', (l) => { l[412].items[1].name = 'Order 2 transcripts'; }, /^The items on "Pre-filing to-dos" changed/],
    ['an item added', (l) => { l[412].items.push({ id: 5122, name: 'New', status: 'incomplete', position: 3 }); }, /^The items on "Pre-filing to-dos" changed/],
  ])('refuses on any difference (rename and delete cards): %s', async (_n, edit, re) => {
    for (const card of [rename, delList]) {
      const lists = baseLists(); edit(lists);
      await expect(browser(reads({ lists }).api).checklistEditPrecheck(card)).resolves.toMatch(re);
    }
  });

  test('a note whose text changed refuses; a list gone reads "no longer exists"; an item gone reads "already deleted"; another failure throws', async () => {
    const lists = baseLists(); lists[414].body = 'Called 11/2 — left a message. Called again.';
    await expect(browser(reads({ lists }).api).checklistEditPrecheck(delNote)).resolves.toBe('The text of the note "Call log" changed since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
    const nulled = baseLists(); nulled[414].body = null;
    await expect(browser(reads({ lists: nulled }).api).checklistEditPrecheck(noteEdit)).resolves.toMatch(/^The text of the note "Call log" changed/);
    await expect(browser(reads({ gone: true }).api).checklistEditPrecheck(delList)).resolves.toBe('The list "Pre-filing to-dos" no longer exists — someone already deleted it. Nothing was written.');
    await expect(browser(reads({ gone: true }).api).checklistEditPrecheck(rename)).resolves.toBe('The list "Pre-filing to-dos" no longer exists. Nothing was written.');
    const noItem = baseLists(); noItem[412].items = noItem[412].items.filter((i) => i.id !== 5121);
    await expect(browser(reads({ lists: noItem }).api).checklistEditPrecheck(delItem)).resolves.toBe('That item is no longer on "Pre-filing to-dos" — someone already deleted it. Nothing was written.');
    await expect(browser(reads({ fail: true }).api).checklistEditPrecheck(delItem)).rejects.toThrow('boom');
    // A card that cannot be written is never read.
    const { api } = reads();
    await expect(browser(api).checklistEditPrecheck({ ...rename, changes: {} })).rejects.toThrow('This card changes nothing.');
    expect(api).not.toHaveBeenCalled();
  });

  test('the result checks read what each route answers', () => {
    const b = browser(jest.fn());
    const list = { id: 412, title: 'Pre-filing (2026)', kind: 'checklist', status: 'incomplete', body: null, items: [] };
    expect(b.checklistUpdateResult(rename, list)).toEqual({ checklist_id: 412 });
    expect(() => b.checklistUpdateResult(rename, { ...list, id: 413 })).toThrow('The checklist route did not answer for the reviewed list');
    expect(() => b.checklistUpdateResult(rename, { ...list, title: 'Pre-filing (2026' })).toThrow('The checklist route did not save the title');
    expect(b.checklistUpdateResult(noteEdit, { id: 414, title: 'Call log', status: 'complete', body: 'New text' })).toEqual({ checklist_id: 414 });
    expect(() => b.checklistUpdateResult(noteEdit, { id: 414, status: 'incomplete', body: 'New text' })).toThrow('The checklist route did not save the status');
    expect(() => b.checklistUpdateResult(noteEdit, { id: 414, status: 'complete', body: 'New tex' })).toThrow('The checklist route did not save the text');
    expect(b.checklistDeleteResult(delList, { status: 'success', message: 'Checklist deleted' })).toEqual({ checklist_id: 412 });
    expect(() => b.checklistDeleteResult(delList, { status: 'error' })).toThrow('The checklist route did not confirm the delete');
    expect(b.checkitemDeleteResult(delItem, { status: 'success', message: 'Item deleted' })).toEqual({ checkitem_id: 5121 });
    expect(() => b.checkitemDeleteResult(delItem, {})).toThrow('The checklist route did not confirm the delete');
  });

  test('outcomes: the detach 403 and the 404s are refusals; anything else falls through', () => {
    const b = browser(jest.fn());
    expect(b.checklistEditKnownOutcome({ status: 403, message: 'That personal checklist belongs to another user — you can add to it, but only its owner can delete or move it.' }))
      .toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/^Refused — nothing written: that personal list belongs to another user/) });
    expect(b.checklistEditKnownOutcome({ status: 404, message: 'Checklist not found' })).toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/that list no longer exists/) });
    expect(b.checklistEditKnownOutcome({ status: 404, message: 'Item not found' })).toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/that item no longer exists/) });
    expect(b.checklistEditKnownOutcome({ status: 403, message: 'tag is a system field' })).toBe(null);
    expect(b.checklistEditKnownOutcome({ status: 400, message: 'Nothing to update' })).toBe(null);
    expect(b.checklistEditKnownOutcome({ status: 403, message: 'belongs to another user', body: { idempotency: {} } })).toBe(null);
  });

  test('DANGER on the families the engine calls: every delete; an update only with a warning', () => {
    const { families } = browser(jest.fn());
    const [u, d, i] = families;
    expect(families.map((f) => [f.id, [...f.kinds], f.idField, f.appliedKey])).toEqual([
      ['checklist_update', ['checklist.update.v1'], 'checklist_id', 'result_checklist_update_id'],
      ['checklist_delete', ['checklist.delete.v1'], 'checklist_id', 'result_checklist_delete_id'],
      ['checkitem_delete', ['checklist.item.delete.v1'], 'checkitem_id', 'result_checkitem_delete_id']]);
    expect([u.danger(rename), u.danger({ ...rename, warnings: ['DUPLICATE TITLE: x'] })]).toEqual([false, true]);
    expect([d.danger(delList), d.danger({}), i.danger(delItem), i.danger({})]).toEqual([true, true, true, true]);
    for (const f of families) {
      expect([f.precheck === undefined, f.knownOutcome === undefined]).toEqual([false, false]);
      expect(f.request === undefined).toBe(false);
    }
    expect(u.request(rename).method).toBe('PATCH');
    expect(d.request(delList).method).toBe('DELETE');
    expect(i.request(delItem).path).toBe('/checkitems/5121');
  });

  test('labels and the card text', () => {
    const b = browser(jest.fn());
    expect([b.checklistEditLabel(rename), b.checklistEditLabel(noteEdit), b.checklistEditLabel(delList), b.checklistEditLabel(delNote), b.checklistEditLabel(delItem)])
      .toEqual(['Rename list', 'Update note', 'Delete list', 'Delete note', 'Delete checklist item']);
    expect(b.checklistEditLabel({ ...noteEdit, changes: { status: 'complete' } })).toBe('Mark note done');
    expect(b.checklistEditLabel({ ...noteEdit, changes: { status: 'incomplete' } })).toBe('Mark note not done');
    expect(b.checklistEditLabel({ ...noteEdit, changes: { body: 'x' } })).toBe('Edit note text');
    const r = b.checklistEditText(rename);
    for (const line of ['Checklist proposal — not applied', 'Action: Rename list', 'List: "Pre-filing to-dos" (list #412, checklist, incomplete) on case 25-12345-abc',
      'Title: "Pre-filing to-dos" → "Pre-filing (2026)"', 'Stale check: if the list or any item on it changes before you apply, nothing is written.']) expect(r).toContain(line);
    const n = b.checklistEditText(noteEdit);
    for (const line of ['Note proposal — not applied', 'Done: not done → done', 'Text before: 28 characters — "Called 11/2 — left a message"', 'Text after: 8 characters — "New text"']) expect(n).toContain(line);
    const d = b.checklistEditText(delList);
    expect(d).toContain('Items deleted with it: 2 (1 done, 1 open) — "Pull credit report" (incomplete); "Order transcripts" (complete)');
    expect(d).toContain('Warning: NO UNDO: the list "Pre-filing to-dos" (#412) is DELETED');
    expect(b.checklistEditText(delNote)).toContain('Text: 28 characters — "Called 11/2 — left a message"');
    const i = b.checklistEditText(delLast);
    for (const line of ['Item deleted: #5200 "Questionnaire" (complete)', 'Items now: 1 → 0', 'List status: complete → incomplete', 'Warning: PIPELINE: on case 25-12345-abc']) expect(i).toContain(line);
  });
});
