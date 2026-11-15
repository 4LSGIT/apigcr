'use strict';
/**
 * tests/caseyChecklistOrder.test.js
 *
 * A10X — Casey reorders EVERY item of ONE checklist through a reviewed card:
 *   checklist.items.reorder.v1 → PUT /checklists/:id/items/order {item_ids}
 * the atomic route built for it (routes/api.checklists.js — one transaction,
 * a set that is not exactly the list's items is a 409 before any write). The
 * Notes & Lists page has no reorder control of its own; the card is the UI.
 *
 * The contract pinned here (mocked db; the route, its locks and the browser
 * re-read over the real GET run on a real engine in
 * tests/caseyChecklistOrder.mysql.test.js):
 *   1. the casey_checklists_enabled switch covers the kind; tag / position
 *      refused by name, unknown fields refused;
 *   2. item_ids: an array of exact positive ids, each once, EVERY item on the
 *      list — a missing / extra id named; an order that changes nothing, a
 *      note, a list of one item refused; another user's personal list and a
 *      list on another record kind refused (the A10 family rules);
 *   3. the card: every item before → after, how many move, a docs list
 *      CLIENT-VISIBLE (the portal lists items in this order), no event, no
 *      pipeline step, on the bus; expected = the list, its items and ORDER;
 *   4. the ledger receipt and the request detector;
 *   5. the browser half (lifted from public/assistant.html by name): the fixed
 *      request, the whole-list + order re-read, the result check, the 409
 *      outcome, danger and the card text.
 *
 *   npx jest tests/caseyChecklistOrder.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;

function baseLists() {
  return {
    412: { row: { id: 412, title: 'Pre-filing to-dos', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5120, name: 'Pull credit report', status: 'incomplete', position: 1 }, { id: 5121, name: 'Order transcripts', status: 'complete', position: 2 },
        { id: 5122, name: 'Pay stubs', status: 'incomplete', position: 3 }] },
    413: { row: { id: 413, title: 'Docs Needed', kind: 'checklist', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: 'docs_needed', docs_list: 1 }, body: null,
      items: [{ id: 5130, name: 'Pay stubs', status: 'incomplete', position: 1 }, { id: 5131, name: 'Photo ID', status: 'complete', position: 2 }] },
    414: { row: { id: 414, title: 'Call log', kind: 'note', status: 'incomplete', link_type: 'case', link: CASE_ID, tag: null, docs_list: 0 }, body: 'Called', items: [] },
    415: { row: { id: 415, title: 'One thing', kind: 'checklist', status: 'incomplete', link_type: 'contact', link: '77', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5150, name: 'Signed', status: 'incomplete', position: 1 }] },
    417: { row: { id: 417, title: 'Stuart to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: '1', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5170, name: 'Call trustee', status: 'incomplete', position: 1 }, { id: 5171, name: 'File reply', status: 'incomplete', position: 2 }] },
    418: { row: { id: 418, title: 'Bill prep', kind: 'checklist', status: 'incomplete', link_type: 'bill', link: '55', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 5180, name: 'A', status: 'incomplete', position: 1 }, { id: 5181, name: 'B', status: 'incomplete', position: 2 }] },
  };
}

function makeDb(over = {}) {
  const lists = over.lists || baseLists();
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') {
      return [String(params[0]) === CASE_ID ? [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy' }] : []];
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
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') {
      return [Number(params[0]) === 1 ? [{ user: 1, user_name: 'Stuart' }] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

const EVIDENCE = [{ id: 'q1', rows: [412, 413, 414, 415, 417, 418].map((id) => ({ checklist_id: id })) }];
const listRow = (id) => [{ query_id: 'q1', row_number: [412, 413, 414, 415, 417, 418].indexOf(id) + 1 }];
const reorder = (id = 412, ids = [5122, 5120, 5121], over = {}) => ({ kind: 'checklist.items.reorder.v1', checklist_id: id, item_ids: ids, evidence: listRow(id), ...over });
const run = (value, dbOver, userId = ME) => normalizeActionDraft(makeDb(dbOver), value, EVIDENCE, { currentUserId: userId });

beforeEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; });
afterEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; });

describe('the switch and the by-name refusals', () => {
  test('casey_checklists_enabled = 0 makes the kind unavailable; unset is on', async () => {
    process.env.CASEY_CHECKLISTS_ENABLED = '0';
    await expect(run(reorder())).rejects.toThrow('Action kind is unavailable');
    delete process.env.CASEY_CHECKLISTS_ENABLED;
    await expect(run(reorder())).resolves.toMatchObject({ kind: 'checklist.items.reorder.v1' });
  });
  test('position and tag by name, before anything is read; unknown fields refused', async () => {
    const db = makeDb();
    await expect(normalizeActionDraft(db, reorder(412, [5122, 5120, 5121], { position: 1 }), EVIDENCE, { currentUserId: ME })).rejects.toThrow('POSITION refused');
    await expect(normalizeActionDraft(db, reorder(412, [5122, 5120, 5121], { tag: 'x' }), EVIDENCE, { currentUserId: ME })).rejects.toThrow('TAG refused');
    expect(db.query).not.toHaveBeenCalled();
    await expect(run(reorder(412, [5122, 5120, 5121], { order: 'desc' }))).rejects.toThrow('carries unsupported fields: order');
  });
});

describe('the item set and the list', () => {
  test.each([
    ['not an array', '5122,5120', 'A reorder needs "item_ids": EVERY item\'s exact checkitem_id'],
    ['empty', [], 'A reorder needs "item_ids"'],
    ['a non-id', [5122, 'x', 5121], 'item_ids must hold exact positive checkitem_ids only'],
    ['a zero', [5122, 0, 5121], 'item_ids must hold exact positive checkitem_ids only'],
    ['a repeat', [5122, 5122, 5120, 5121], 'item_ids names an item more than once'],
    ['one missing', [5122, 5120], 'A reorder names EVERY item on "Pre-filing to-dos" exactly once (3 items) — missing #5121 "Order transcripts". Nothing is proposed'],
    ['one foreign', [5122, 5120, 5121, 5130], 'not on this list: #5130'],
    ['the same order', [5120, 5121, 5122], 'The items on "Pre-filing to-dos" are already in that order — that changes nothing'],
  ])('%s is refused', async (_n, ids, msg) => {
    await expect(run(reorder(412, ids))).rejects.toThrow(msg);
  });
  test('digit strings are read as ids; the evidence must carry the checklist_id', async () => {
    await expect(run(reorder(412, ['5122', '5120', '5121']))).resolves.toMatchObject({ moved: 3 });
    await expect(run(reorder(412, [5122, 5120, 5121], { evidence: listRow(413) }))).rejects.toThrow('The list evidence does not identify checklist #412');
  });
  test('a note, a one-item list, another user\'s list, a bill list and a missing list are refused', async () => {
    await expect(run(reorder(414, [1, 2]))).rejects.toThrow('"Call log" (#414) is a NOTE');
    await expect(run(reorder(415, [5150, 5151]))).rejects.toThrow('"One thing" has one item — there is nothing to reorder');
    await expect(run(reorder(417, [5171, 5170]))).rejects.toThrow('is another user\'s personal list — it belongs to Stuart (user #1)');
    await expect(run(reorder(418, [5181, 5180]))).rejects.toThrow('hangs off a bill');
    const lists = baseLists(); delete lists[412];
    await expect(run(reorder(), { lists })).rejects.toThrow('Checklist #412 no longer exists');
  });
  test('more items than one card reviews is refused', async () => {
    const lists = baseLists();
    lists[412].items = Array.from({ length: 201 }, (_, i) => ({ id: 6000 + i, name: `Item ${i}`, status: 'incomplete', position: i + 1 }));
    await expect(run(reorder(412, lists[412].items.map((i) => i.id).reverse()), { lists })).rejects.toThrow('has 201 items — more than one card can review (200)');
  });
});

describe('the card', () => {
  test('every item before → after, how many move, expected = list + items + order, no event, no pipeline, on the bus', async () => {
    const c = await run(reorder(412, [5122, 5120, 5121]));
    expect(c.order_before).toEqual([
      { checkitem_id: 5120, name: 'Pull credit report', status: 'incomplete' },
      { checkitem_id: 5121, name: 'Order transcripts', status: 'complete' },
      { checkitem_id: 5122, name: 'Pay stubs', status: 'incomplete' }]);
    expect(c.order_after.map((i) => i.checkitem_id)).toEqual([5122, 5120, 5121]);
    expect([c.moved, c.items_total, c.warnings]).toEqual([3, 3, []]);
    expect(c.expected).toEqual({ title: 'Pre-filing to-dos', kind: 'checklist', link_type: 'case', link: CASE_ID, tag: null, status: 'incomplete', body: null,
      items: ['5120:incomplete:Pull credit report', '5121:complete:Order transcripts', '5122:incomplete:Pay stubs'], order: [5120, 5121, 5122] });
    expect(c.effects.join('\n')).toContain('ONE transaction rewrites every item\'s position on "Pre-filing to-dos" to 1-3 in the order below (3 of 3 items change place)');
    expect(c.effects).toContain('Trigger event: none — reordering emits no event, so no trigger rule runs.');
    expect(c.effects.join('\n')).toContain('Pipeline: no step changes');
    expect(c.effects.join('\n')).toContain('PUT /checklists/:id/items/order is announced on the sync bus');
    const swap = await run(reorder(412, [5121, 5120, 5122]));
    expect(swap.moved).toBe(2);
  });
  test('a docs list is CLIENT-VISIBLE — the portal lists its items in this order', async () => {
    const c = await run(reorder(413, [5131, 5130]));
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toMatch(/^CLIENT-VISIBLE: this is case 25-12345-abc's DOCS list .* list its items in this order, so the client sees the new order at once\.$/);
  });
  test('the ledger receipts the list; the request detector hears a reorder', () => {
    expect(ledger.KINDS.get('checklist.items.reorder.v1')).toBe('checklist_id');
    expect(taskDraftRequested('Reorder the pre-filing checklist so pay stubs is first', [])).toBe(true);
    expect(taskDraftRequested('Move the transcripts item to the top of the checklist', [])).toBe(true);
    expect(taskDraftRequested('Sort the to-do list items alphabetically', [])).toBe(true);
    expect(taskDraftRequested('What order are the checklist items in?', [])).toBe(false);
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
  'checklistEditListId', 'checklistReorderLabel', 'checklistReorderText', 'checklistReorderRequest', 'checklistReorderPrecheck',
  'checklistReorderResult', 'checklistReorderKnownOutcome'];
function browser(api) {
  const src = [constSrc('CHECKLIST_REORDER_ACTION_KINDS'), ...FNS.map(fnSrc),
    `const families = [${familySrc('checklist_reorder')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  return new Function('api', 'openEntity', 'P', src)(api, jest.fn(), {}); // eslint-disable-line no-new-func
}

describe('the browser: fixed request, the list + order re-read, result check, outcomes, danger, text', () => {
  let card; let docs;
  beforeAll(async () => {
    card = JSON.parse(JSON.stringify(await run(reorder(412, [5122, 5120, 5121]))));
    docs = JSON.parse(JSON.stringify(await run(reorder(413, [5131, 5130]))));
  });

  // GET /checklists/:id as the route answers it (SELECT * + items in position order).
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
      return { ...row, body: l.body, created_by: 6, items: l.items.map((i) => ({ ...i, checklist_id: id, tag: null })) };
    });
    return { api, gets };
  }

  test('the request: PUT of the reviewed order, nothing else; an unusable order throws', () => {
    const b = browser(jest.fn());
    expect(b.checklistReorderRequest({ ...card, item_ids: [1, 2, 3], tag: 'x' })).toEqual({ path: '/checklists/412/items/order', method: 'PUT', body: { item_ids: [5122, 5120, 5121] } });
    for (const bad of [[], [{ checkitem_id: 5122 }], [{ checkitem_id: 5122 }, { checkitem_id: 5122 }], [{ checkitem_id: 5122 }, { checkitem_id: 'x' }]]) {
      expect(() => b.checklistReorderRequest({ ...card, order_after: bad })).toThrow('This card has no usable item order.');
    }
    expect(() => b.checklistReorderRequest({ ...card, list: { checklist_id: 0 } })).toThrow('This card has no usable list id.');
  });

  test('the precheck: ONE GET of the list; a fresh card passes', async () => {
    const { api, gets } = reads();
    await expect(browser(api).checklistReorderPrecheck(card)).resolves.toBe('');
    expect(gets).toEqual(['/checklists/412']);
  });

  test.each([
    ['the title', (l) => { l[412].row.title = 'Renamed'; }, /^The list "Pre-filing to-dos" changed since this card was prepared \(its title, kind, record, tag or status\)/],
    ['the status', (l) => { l[412].row.status = 'complete'; }, /^The list "Pre-filing to-dos" changed/],
    ['the record', (l) => { l[412].row.link = 'OTHER'; }, /^The list "Pre-filing to-dos" changed/],
    ['an item added', (l) => { l[412].items.push({ id: 5123, name: 'New', status: 'incomplete', position: 4 }); }, /^The items on "Pre-filing to-dos" changed since this card was prepared/],
    ['an item removed', (l) => { l[412].items.pop(); }, /^The items on "Pre-filing to-dos" changed/],
    ['an item checked', (l) => { l[412].items[0].status = 'complete'; }, /^The items on "Pre-filing to-dos" changed/],
    ['the order (by hand)', (l) => { l[412].items.reverse(); }, /^The order of the items on "Pre-filing to-dos" changed since this card was prepared \(someone reordered them\)/],
  ])('refuses on any difference: %s', async (_n, edit, re) => {
    const lists = baseLists(); edit(lists);
    await expect(browser(reads({ lists }).api).checklistReorderPrecheck(card)).resolves.toMatch(re);
  });

  test('a list gone reads "no longer exists"; another failure throws; a card whose order is not its review is never read', async () => {
    await expect(browser(reads({ gone: true }).api).checklistReorderPrecheck(card)).resolves.toBe('The list "Pre-filing to-dos" no longer exists. Nothing was written.');
    await expect(browser(reads({ fail: true }).api).checklistReorderPrecheck(card)).rejects.toThrow('boom');
    const { api } = reads();
    const forged = { ...card, order_after: [{ checkitem_id: 5122 }, { checkitem_id: 5120 }, { checkitem_id: 5130 }] };
    await expect(browser(api).checklistReorderPrecheck(forged)).rejects.toThrow('this card\'s order does not match its review');
    await expect(browser(api).checklistReorderPrecheck({ ...card, order_after: [] })).rejects.toThrow('This card has no usable item order.');
    expect(api).not.toHaveBeenCalled();
  });

  test('the result check reads the PUT\'s list: the reviewed list in exactly the reviewed order', () => {
    const b = browser(jest.fn());
    const ok = { id: 412, link_type: 'case', link: CASE_ID, items: [{ id: 5122 }, { id: 5120 }, { id: 5121 }] };
    expect(b.checklistReorderResult(card, ok)).toEqual({ checklist_id: 412 });
    expect(() => b.checklistReorderResult(card, { ...ok, id: 413 })).toThrow('The checklist route did not answer for the reviewed list');
    expect(() => b.checklistReorderResult(card, { ...ok, items: [{ id: 5120 }, { id: 5122 }, { id: 5121 }] })).toThrow('The checklist route did not save the reviewed order');
    expect(() => b.checklistReorderResult(card, { ...ok, items: undefined })).toThrow('The checklist route did not save the reviewed order');
  });

  test('outcomes: the route\'s 409 set check and the 404 are refusals; anything else falls through', () => {
    const b = browser(jest.fn());
    expect(b.checklistReorderKnownOutcome({ status: 409, message: "item_ids must be exactly the list's 3 current items — missing 1. Nothing was reordered; re-read the list and send its items again." }))
      .toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/^Refused — nothing written: the list's items changed between the check and the write/) });
    expect(b.checklistReorderKnownOutcome({ status: 404, message: 'Checklist not found' })).toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/that list no longer exists/) });
    expect(b.checklistReorderKnownOutcome({ status: 409, message: 'other conflict' })).toBe(null);
    expect(b.checklistReorderKnownOutcome({ status: 409, message: 'item_ids must be exactly', body: { idempotency: {} } })).toBe(null);
    expect(b.checklistReorderKnownOutcome({ status: 500, message: 'Failed to reorder items' })).toBe(null);
  });

  test('the family the engine calls: danger only with a warning; its request, precheck and outcome are the functions above', () => {
    const { families: [f] } = browser(jest.fn());
    expect([f.id, [...f.kinds], f.idField, f.appliedKey]).toEqual(['checklist_reorder', ['checklist.items.reorder.v1'], 'checklist_id', 'result_checklist_reorder_id']);
    expect([f.danger(card), f.danger(docs)]).toEqual([false, true]);
    expect(f.request(card)).toEqual({ path: '/checklists/412/items/order', method: 'PUT', body: { item_ids: [5122, 5120, 5121] } });
    expect(f.appliedCopy({ ...card, result_checklist_reorder_id: 412 }).status).toBe('Applied — list #412 reordered');
  });

  test('the label and the card text: every item before and after, the moved marks, warnings and effects', () => {
    const b = browser(jest.fn());
    expect(b.checklistReorderLabel(card)).toBe('Reorder checklist items');
    const t = b.checklistReorderText(card);
    for (const line of ['Checklist proposal — not applied', 'Action: Reorder checklist items', 'List: "Pre-filing to-dos" (list #412, checklist, incomplete) on case 25-12345-abc',
      'Items: 3 (3 change place)', 'Order before:', '  1. "Pull credit report" (#5120, incomplete)', '  3. "Pay stubs" (#5122, incomplete)',
      'Order after:', '  1. "Pay stubs" (#5122) — moved', '  2. "Pull credit report" (#5120) — moved', '  3. "Order transcripts" (#5121) — moved',
      'Stale check: if the list, any item on it or their order changes before you apply, nothing is written.']) expect(t).toContain(line);
    const swap = b.checklistReorderText({ ...card, order_after: [card.order_before[1], card.order_before[0], card.order_before[2]] });
    expect(swap).toContain('  3. "Pay stubs" (#5122)\n');
    expect(b.checklistReorderText(docs)).toContain('Warning: CLIENT-VISIBLE:');
  });
});
