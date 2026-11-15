'use strict';
/**
 * tests/caseyChecklistUpsert.test.js
 *
 * A10X — Casey's docs-list upsert card (Fred, 2026-11-15: "release means
 * allow" — the A10 deferral "upsert-many and template expansion"):
 *   checklist.items.upsert.v1 → POST /checklists/upsert-items {case_id, items}
 * the sending form's own route: find-or-create the case's docs list
 * (FIND_DOCS_SQL; an untagged "Docs Needed" title match is re-tagged), delete
 * the existing item whose first 22 characters equal each new item's, insert
 * every new item unchecked at position i+1, recompute the status, emit
 * checklist.items_upserted.
 *
 * The contract pinned here (mocked db; the real route, its find, the real
 * trigger_rules read and the browser re-read run on a real engine in
 * tests/caseyChecklistUpsert.mysql.test.js):
 *   1. the switch; tag / position by name; unknown fields; case_id cited;
 *   2. items: 1-25 names (never objects), each 1-255 characters; a repeat, two
 *      new items sharing a 22-character prefix, a prefix matching two existing
 *      items, a near-duplicate by capitalisation — refused;
 *   3. the diff: which items are dropped (and by which new item), the list
 *      after in the board's order (position NULL first, ties by id, new ids
 *      last), the status after, find / create / re-tag;
 *   4. warnings: CLIENT-VISIBLE always, ASKS AGAIN (a checked item replaced
 *      unchecked), REOPENS THE LIST, CREATES / TAGS, NOT ONE STEP, and the
 *      AUTOMATION line naming every ACTIVE rule on checklist.items_upserted
 *      ("none" when none) with the dry run of each;
 *   5. expected, the ledger receipt, the request detector;
 *   6. the browser half (lifted by name): the fixed request, the re-read of
 *      every case checklist and the docs list, the result check, the
 *      part-applied ambiguity text, danger, the card text.
 *
 *   npx jest tests/caseyChecklistUpsert.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;

// Case checklists (kind 'checklist' only — the route's find never reads a note).
function baseLists() {
  return [
    { id: 412, title: 'Pre-filing to-dos', tag: null, status: 'incomplete', items: [{ id: 5120, name: 'Pull credit report', status: 'incomplete', position: 1 }] },
    { id: 413, title: 'Docs Needed', tag: 'docs_needed', status: 'incomplete', items: [
      { id: 5130, name: '2024 W-2 from every employer', status: 'complete', position: 1 },
      { id: 5131, name: 'Pay stubs — last 6 months', status: 'incomplete', position: 2 },
      { id: 5132, name: 'Photo ID', status: 'incomplete', position: null }] },
  ];
}

function makeDb(over = {}) {
  const lists = over.lists || baseLists();
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ? LIMIT 1') {
      return [String(params[0]) === CASE_ID && !over.caseMissing ? [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy' }] : []];
    }
    if (flat === "SELECT id, title, tag, status FROM checklists WHERE link_type = 'case' AND link = ? AND kind = 'checklist' ORDER BY id ASC") {
      return [lists.map((l) => ({ id: l.id, title: l.title, tag: l.tag, status: l.status }))];
    }
    if (flat === "SELECT id, tag FROM checklists WHERE link_type = 'case' AND link = ? AND kind = 'checklist' AND (tag = 'docs_needed' OR title = 'Docs Needed') ORDER BY (tag = 'docs_needed') DESC, id ASC LIMIT 1") {
      const hits = lists.filter((l) => l.tag === 'docs_needed' || l.title.toLowerCase().trim() === 'docs needed')
        .sort((a, b) => (b.tag === 'docs_needed') - (a.tag === 'docs_needed') || a.id - b.id);
      return [hits.length ? [{ id: hits[0].id, tag: hits[0].tag }] : []];
    }
    if (/^SELECT cl\.id, cl\.title, cl\.kind, cl\.status, cl\.link_type, cl\.link, cl\.tag, COALESCE\(.*\) AS docs_list FROM checklists cl WHERE cl\.id = \? LIMIT 1$/.test(flat)) {
      const l = lists.find((x) => x.id === Number(params[0]));
      return [l ? [{ id: l.id, title: l.title, kind: 'checklist', status: l.status, link_type: 'case', link: CASE_ID, tag: l.tag, docs_list: 1 }] : []];
    }
    if (flat === 'SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC') {
      const l = lists.find((x) => x.id === Number(params[0]));
      const rows = l ? l.items.map((i) => ({ ...i })) : [];
      return [rows.sort((a, b) => ((a.position == null ? -Infinity : a.position) - (b.position == null ? -Infinity : b.position)) || a.id - b.id)];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

const EVIDENCE = [{ id: 'q1', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] }, { id: 'q2', rows: [{ contact_id: 77 }] }];
const upsert = (items, over = {}) => ({ kind: 'checklist.items.upsert.v1', case_id: CASE_ID, items, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const run = (value, dbOver) => normalizeActionDraft(makeDb(dbOver), value, EVIDENCE, { currentUserId: ME });

let spies = [];
function rulesFor(rules = [], evaluate = async () => ({ matched: true })) {
  spies.push(jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => (ev === 'checklist.items_upserted' ? rules.map((r) => ({ ...r })) : [])));
  spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(evaluate));
}
beforeEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; rulesFor(); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CHECKLISTS_ENABLED; });

describe('the switch, the by-name refusals and the citation', () => {
  test('casey_checklists_enabled = 0 makes the kind unavailable', async () => {
    process.env.CASEY_CHECKLISTS_ENABLED = '0';
    await expect(run(upsert(['Bank statements']))).rejects.toThrow('Action kind is unavailable');
  });
  test('tag / position by name, unknown fields, an uncited or malformed case, a gone case', async () => {
    await expect(run(upsert(['x'], { tag: 'docs_needed' }))).rejects.toThrow('TAG refused');
    await expect(run(upsert(['x'], { position: 1 }))).rejects.toThrow('POSITION refused');
    await expect(run(upsert(['x'], { checklist_id: 413 }))).rejects.toThrow('carries unsupported fields: checklist_id');
    await expect(run(upsert(['x'], { evidence: [{ query_id: 'q2', row_number: 1 }] }))).rejects.toThrow(`The upsert evidence does not identify case ${CASE_ID}`);
    await expect(run(upsert(['x'], { case_id: 'bad id!' }))).rejects.toThrow('An upsert needs case_id = the case\'s exact case_id');
    await expect(run(upsert(['x']), { caseMissing: true })).rejects.toThrow(`Case ${CASE_ID} no longer exists`);
  });
});

describe('the items', () => {
  test.each([
    ['none', [], 'An upsert needs "items"'],
    ['26', Array.from({ length: 26 }, (_, i) => `Item ${i}`), 'An upsert carries at most 25 items on one card (26 given)'],
    ['an object', [{ name: 'x', status: 'complete' }], 'Item 1 is not a name — an upsert item is its name only'],
    ['an empty name', ['  '], 'Item 1\'s name is empty'],
    ['a long name', ['x'.repeat(256)], 'Item 1\'s name is 256 characters'],
    ['a repeat', ['Bank statements', ' Bank statements '], 'Item "Bank statements" is listed twice — the route would add it twice'],
    ['two sharing 22 characters', ['Bank statements — Chase checking', 'Bank statements — Chase savings'], 'Items "Bank statements — Chase checking" and "Bank statements — Chase savings" share their first 22 characters'],
  ])('%s is refused', async (_n, items, msg) => {
    await expect(run(upsert(items))).rejects.toThrow(msg);
  });
  test('a prefix matching TWO existing items, and a near-duplicate by capitalisation, are refused', async () => {
    const lists = baseLists();
    lists[1].items.push({ id: 5133, name: 'Pay stubs — last 6 months (spouse)', status: 'incomplete', position: 3 });
    await expect(run(upsert(['Pay stubs — last 6 months, both']), { lists }))
      .rejects.toThrow('"Pay stubs — last 6 months, both" shares its first 22 characters with 2 items on the docs list (#5131 "Pay stubs — last 6 months", #5133 "Pay stubs — last 6 months (spouse)")');
    await expect(run(upsert(['photo id'])))
      .rejects.toThrow('"photo id" would sit beside "Photo ID" (#5132) — the route matches the first 22 characters exactly (capitalisation counts)');
  });
});

describe('the diff — exactly what the route does', () => {
  test('one replaced (a checked item asked again), one new; the list after in the board\'s order; expected', async () => {
    const c = await run(upsert(['2024 W-2 from every employer (all)', 'Bank statements']));
    expect(c.target).toEqual({ checklist_id: 413, title: 'Docs Needed', tag: 'docs_needed', status: 'incomplete' });
    expect(c.items_in).toEqual(['2024 W-2 from every employer (all)', 'Bank statements']);
    expect(c.dropped).toEqual([{ checkitem_id: 5130, name: '2024 W-2 from every employer', status: 'complete', replaced_by: '2024 W-2 from every employer (all)' }]);
    // Before: Photo ID (position NULL sorts first), W-2 (1), Pay stubs (2).
    expect(c.items_before.map((i) => i.name)).toEqual(['Photo ID', '2024 W-2 from every employer', 'Pay stubs — last 6 months']);
    // After: Photo ID (NULL), W-2 (all) new at 1, Pay stubs (2, an old id before the new one) then Bank statements new at 2.
    expect(c.items_after.map((i) => [i.name, i.fresh])).toEqual([['Photo ID', false], ['2024 W-2 from every employer (all)', true],
      ['Pay stubs — last 6 months', false], ['Bank statements', true]]);
    expect([c.items_before_total, c.items_after_total, c.list_status]).toEqual([3, 4, { from: 'incomplete', to: 'incomplete' }]);
    expect(c.warnings).toEqual([
      'CLIENT-VISIBLE: this writes case 25-12345-abc\'s DOCS list — the client portal shows its items to the client, and the case\'s public documents link (no sign-in) lists every unchecked item by name: 2 items appear there as needed, and 1 existing item is replaced.',
      'ASKS AGAIN: "2024 W-2 from every employer" is checked off (received); the route deletes it and adds "2024 W-2 from every employer (all)" UNCHECKED, so the client is asked for it again.',
      'NOT ONE STEP: the route deletes and inserts the items one at a time, without a transaction — if it fails partway, some items are replaced and others not; the card then reads "may have been applied" and the list must be checked by hand.',
      'AUTOMATION: checklist.items_upserted fires after the write — active trigger rules listening: none.']);
    expect(c.effects).toEqual([
      'Writes: on "Docs Needed" (#413) — 1 existing item deleted, 2 new items added unchecked at positions 1-2; then the list\'s derived status is recomputed (incomplete).',
      'Pipeline: a step whose checklist detector reads the docs_needed tag re-resolves from the list\'s new counts — 4 items, 4 open, status incomplete.',
      'Other open pages: POST /checklists/upsert-items is announced on the sync bus — another open Notes & Lists board for this record refreshes on its own (one with unsaved note text or the caret in a field refreshes once that is done); the global Notes & Lists page\'s Browse view reloads its first page too (it waits while a row\'s editor is open or the page is hidden).']);
    expect(c.expected).toEqual({ case_id: CASE_ID, target_id: 413, target_status: 'incomplete',
      lists: ['412::Pre-filing to-dos', '413:docs_needed:Docs Needed'],
      items: ['5130:complete:2024 W-2 from every employer', '5131:incomplete:Pay stubs — last 6 months', '5132:incomplete:Photo ID'] });
  });
  test('no docs list: the route CREATES one — the card says so, the list after is just the new items', async () => {
    const c = await run(upsert(['Bank statements']), { lists: [baseLists()[0]] });
    expect([c.target, c.dropped, c.items_after.map((i) => i.name), c.list_status, c.expected.target_id, c.expected.items])
      .toEqual([null, [], ['Bank statements'], { from: null, to: 'incomplete' }, null, []]);
    expect(c.warnings[1]).toBe('CREATES THE DOCS LIST: case 25-12345-abc has no docs list — the route makes one titled "Docs Needed", tagged docs_needed, and the client portal and the public documents link start showing it.');
    expect(c.effects[0]).toBe('Writes: on a NEW "Docs Needed" list — 0 existing items deleted, 1 new item added unchecked at position 1; then the list\'s derived status is recomputed (incomplete).');
  });
  test('an untagged title match is the target and gets TAGGED; a complete docs list REOPENS; a tagged list wins over a title match', async () => {
    const titled = [{ id: 420, title: 'docs needed', tag: null, status: 'complete', items: [{ id: 5200, name: 'Lease', status: 'complete', position: 1 }] }];
    const c = await run(upsert(['Bank statements']), { lists: titled });
    expect(c.target).toEqual({ checklist_id: 420, title: 'docs needed', tag: null, status: 'complete' });
    expect(c.warnings).toEqual(expect.arrayContaining([
      'REOPENS THE LIST: the docs list is complete; new unchecked items make it incomplete again (no event fires for that).',
      'TAGS THE LIST: "docs needed" (#420) is the docs list by its title only — the route sets its tag to docs_needed (a system field), which it keeps from now on.']));
    const both = await run(upsert(['Bank statements']), { lists: [...titled, ...baseLists()] });
    expect(both.target.checklist_id).toBe(413);
  });
});

describe('automation — every ACTIVE rule on checklist.items_upserted, named and dry-run', () => {
  test('the rules are named in the warning; acting ones listed; the route\'s own envelope', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    const seen = [];
    rulesFor([{ id: 14, name: 'Doc request sent → docs stage', cooling_down: 0, actions: [{ action_type: 'internal_function', config: { function_name: 'advance_stage' } }] },
      { id: 15, name: 'Other', cooling_down: 0, actions: [] }], async (rule, env) => { seen.push([rule.id, env]); return { matched: rule.id === 14 }; });
    const c = await run(upsert(['Bank statements']));
    expect(c.warnings).toContain('AUTOMATION: checklist.items_upserted fires after the write — active trigger rules listening: "Doc request sent → docs stage" (#14), "Other" (#15).');
    expect(c.automation).toEqual({ events: ['checklist.items_upserted'], rules: [{ id: 14, name: 'Doc request sent → docs stage' }, { id: 15, name: 'Other' }],
      lines: ['Trigger rule #14 "Doc request sent → docs stage" runs: calls advance_stage'], rules_checked: 2, quiet: 1 });
    const env = seen[0][1];
    expect([env.event, env.case_id, env.actor, env.source, env.data]).toEqual(['checklist.items_upserted', CASE_ID, { user_id: ME }, 'system',
      { checklist_id: 413, tag: 'docs_needed', title: 'Docs Needed', link_type: 'case', items_upserted: 1, checklist_status: 'incomplete' }]);
  });
  test('a rule that cannot be evaluated MAY run — warned', async () => {
    spies.forEach((s) => s.mockRestore()); spies = [];
    rulesFor([{ id: 14, name: 'Code rule', cooling_down: 0, actions: [] }], async () => ({ matched: false, match_error: 'GUEST_CODE_BUSY' }));
    const c = await run(upsert(['Bank statements']));
    expect(c.warnings).toContain('AUTOMATION: at least one trigger rule could not be evaluated for this upsert — read its line; it may run.');
  });
});

describe('the ledger, the request detector', () => {
  test('the receipt is the list; the detector hears an upsert onto the docs list', () => {
    expect(ledger.KINDS.get('checklist.items.upsert.v1')).toBe('checklist_id');
    expect(taskDraftRequested('Add bank statements and the lease to the docs needed list', [])).toBe(true);
    expect(taskDraftRequested('Upsert these into the docs needed checklist', [])).toBe(true);
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
const FNS = ['checklistParentLabel', 'checklistEntity', 'checklistOpenPersonal', 'checklistOpen', 'checklistUpsertLabel', 'checklistUpsertText',
  'checklistUpsertRequest', 'checklistUpsertPrecheck', 'checklistUpsertResult'];
function browser(api) {
  const src = [constSrc('CHECKLIST_UPSERT_ACTION_KINDS'), ...FNS.map(fnSrc), `const families = [${familySrc('checklist_upsert')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  return new Function('api', 'openEntity', 'P', src)(api, jest.fn(), {}); // eslint-disable-line no-new-func
}

describe('the browser: fixed request, the case re-read, result check, outcomes, danger, text', () => {
  let card; let fresh;
  beforeAll(async () => {
    rulesFor();
    card = JSON.parse(JSON.stringify(await run(upsert(['2024 W-2 from every employer (all)', 'Bank statements']))));
    fresh = JSON.parse(JSON.stringify(await run(upsert(['Bank statements']), { lists: [baseLists()[0]] })));
    spies.forEach((s) => s.mockRestore()); spies = [];
  });

  // GET /api/cases/:id and GET /checklists?link_type=case&link=&kind=checklist&include=items as the routes answer.
  function reads({ lists = baseLists(), caseGone = false, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect(method).toBe('GET');
      gets.push([p, body]);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      if (p === `/api/cases/${CASE_ID}`) { if (caseGone) throw Object.assign(new Error('Case not found'), { status: 404 }); return { status: 'success' }; }
      if (p === '/checklists') {
        expect(body).toEqual({ link_type: 'case', link: CASE_ID, kind: 'checklist', include: 'items', limit: 1000 });
        const rows = lists.map((l) => ({ id: l.id, title: l.title, tag: l.tag, status: l.status, kind: 'checklist', link_type: 'case', link: CASE_ID,
          items: l.items.map((i) => ({ ...i, checklist_id: l.id })) }));
        return { checklists: rows, total: rows.length };
      }
      throw new Error(`unexpected GET ${p}`);
    });
    return { api, gets };
  }

  test('the request: POST upsert-items with the case and the reviewed names only; an unusable card throws', () => {
    const b = browser(jest.fn());
    expect(b.checklistUpsertRequest({ ...card, items: ['junk'], tag: 'x' })).toEqual({ path: '/checklists/upsert-items', method: 'POST',
      body: { case_id: CASE_ID, items: ['2024 W-2 from every employer (all)', 'Bank statements'] } });
    for (const bad of [[], [' padded '], ['x'.repeat(256)], [5], Array.from({ length: 26 }, (_, i) => `i${i}`)]) {
      expect(() => b.checklistUpsertRequest({ ...card, items_in: bad })).toThrow('This card\'s items are unusable.');
    }
    expect(() => b.checklistUpsertRequest({ ...card, parent: { case_id: 'bad id!' } })).toThrow('This card has no usable case.');
  });

  test('the precheck: the case, then every case checklist with its items; fresh cards pass', async () => {
    for (const [c, lists] of [[card, baseLists()], [fresh, [baseLists()[0]]]]) {
      const { api, gets } = reads({ lists });
      await expect(browser(api).checklistUpsertPrecheck(c)).resolves.toBe('');
      expect(gets.map(([p]) => p)).toEqual([`/api/cases/${CASE_ID}`, '/checklists']);
    }
  });

  test.each([
    ['a checklist added on the case', (l) => { l.push({ id: 430, title: 'New', tag: null, status: 'incomplete', items: [] }); }, /^The checklists on case 25-12345-abc changed since this card was prepared \(one was added, removed, renamed or re-tagged\)/],
    ['a list renamed to "Docs Needed"', (l) => { l[0].title = 'Docs Needed'; }, /^The checklists on case 25-12345-abc changed/],
    ['the docs list re-tagged', (l) => { l[1].tag = null; }, /^The checklists on case 25-12345-abc changed/],
    ['the docs list completed', (l) => { l[1].status = 'complete'; }, /^The docs list on case 25-12345-abc changed since this card was prepared/],
    ['an item checked', (l) => { l[1].items[1].status = 'complete'; }, /^The items on the docs list of case 25-12345-abc changed since this card was prepared/],
    ['an item added', (l) => { l[1].items.push({ id: 5139, name: 'Lease', status: 'incomplete', position: 4 }); }, /^The items on the docs list of case 25-12345-abc changed/],
  ])('refuses on any difference: %s', async (_n, edit, re) => {
    const lists = baseLists(); edit(lists);
    await expect(browser(reads({ lists }).api).checklistUpsertPrecheck(card)).resolves.toMatch(re);
  });

  test('a docs list appearing under a card that would create one refuses; a gone case; a failure throws; a forged case is never read', async () => {
    await expect(browser(reads().api).checklistUpsertPrecheck(fresh)).resolves.toMatch(/^The checklists on case 25-12345-abc changed/);
    await expect(browser(reads({ caseGone: true }).api).checklistUpsertPrecheck(card)).resolves.toBe('case 25-12345-abc no longer exists. Nothing was written.');
    await expect(browser(reads({ fail: true }).api).checklistUpsertPrecheck(card)).rejects.toThrow('boom');
    const { api } = reads();
    await expect(browser(api).checklistUpsertPrecheck({ ...card, parent: { ...card.parent, case_id: 'OTHER123' } })).rejects.toThrow('this card\'s case does not match its review');
    expect(api).not.toHaveBeenCalled();
  });

  test('the result check reads {status, checklist}: the reviewed (or a new) list on the case, every new item unchecked', () => {
    const b = browser(jest.fn());
    const items = [{ id: 1, name: '2024 W-2 from every employer (all)', status: 'incomplete' }, { id: 2, name: 'Bank statements', status: 'incomplete' }];
    const ok = { status: 'success', checklist: { id: 413, link_type: 'case', link: CASE_ID, items } };
    expect(b.checklistUpsertResult(card, ok)).toEqual({ checklist_id: 413 });
    expect(() => b.checklistUpsertResult(card, { ...ok, checklist: { ...ok.checklist, id: 414 } })).toThrow('The docs-list route wrote another list');
    expect(() => b.checklistUpsertResult(card, { ...ok, checklist: { ...ok.checklist, link: 'OTHER' } })).toThrow('The docs-list route wrote a list on another record');
    expect(() => b.checklistUpsertResult(card, { ...ok, checklist: { ...ok.checklist, items: items.slice(1) } })).toThrow('The docs-list route did not return every new item');
    expect(() => b.checklistUpsertResult(card, { ...ok, status: 'error' })).toThrow('The docs-list route returned no usable list id');
    // A card that creates the list accepts whatever id the route made.
    expect(b.checklistUpsertResult(fresh, { status: 'success', checklist: { id: 999, link_type: 'case', link: CASE_ID, items: [items[1]] } })).toEqual({ checklist_id: 999 });
  });

  test('the family: always danger, part-applied ambiguity, no knownOutcome (4xx refuses by the shared rule)', () => {
    const { families: [f] } = browser(jest.fn());
    expect([f.id, [...f.kinds], f.idField, f.appliedKey, f.danger(card), f.danger({}), f.knownOutcome]).toEqual(['checklist_upsert', ['checklist.items.upsert.v1'],
      'checklist_id', 'result_checklist_upsert_id', true, true, undefined]);
    expect(f.ambiguousText('socket hang up')).toBe('Outcome unknown — the docs list may be PART-updated: the route replaces items one at a time and did not confirm the result (socket hang up). Open the case\'s Notes & Lists and check the docs list before asking Casey again. Do not apply this card again.');
    expect(f.appliedCopy({ ...card, result_checklist_upsert_id: 413 }).status).toBe('Applied — docs list #413 updated');
  });

  test('the label and the card text: every item added and what it replaces, the list after, every warning and rule', () => {
    const b = browser(jest.fn());
    expect([b.checklistUpsertLabel(card), b.checklistUpsertLabel(fresh)]).toEqual(['Update the docs list', 'Create the docs list']);
    const t = b.checklistUpsertText(card);
    for (const line of ['Docs list proposal — not applied', 'Action: Update the docs list', 'Case: case 25-12345-abc', 'Docs list: "Docs Needed" (list #413, tag docs_needed, incomplete)',
      'Add: "2024 W-2 from every employer (all)" (unchecked) — replaces #5130 "2024 W-2 from every employer" (complete)', 'Add: "Bank statements" (unchecked)',
      'Items before: 3; after (4, in the board\'s order): "Photo ID" (incomplete); "2024 W-2 from every employer (all)" (new); "Pay stubs — last 6 months" (incomplete); "Bank statements" (new)',
      'List status: incomplete → incomplete', 'Warning: ASKS AGAIN:', 'Warning: AUTOMATION: checklist.items_upserted fires after the write — active trigger rules listening: none.',
      'Automation: no active trigger rule acts on checklist.items_upserted (0 checked).']) expect(t).toContain(line);
    const f = b.checklistUpsertText(fresh);
    expect(f).toContain('Docs list: none yet — the route makes "Docs Needed" (tag docs_needed)');
    expect(f).toContain('Delete: nothing — no existing item shares a new item\'s first 22 characters.');
    expect(f).toContain('List status: new → incomplete');
  });
});
