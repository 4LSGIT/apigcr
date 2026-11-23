// Casey v2 S4a — services/casey/notes.js over a db stub (the real engine:
// tests/caseyNotes.mysql.test.js): scopes, normalisation, the caps, the
// current-doc shape and its per-process cache, the version list, save as a new
// version inside the transaction (the FOR UPDATE read of the latest, the
// unchanged 409, the number), the duplicate-key retry, restore as a new
// version, familyScopes from a live catalog. Also lib/caseyPrompt with notes:
// systemText(notes) appends the framed section only when the global note is
// non-blank, and signature(tools, notes) changes with the body.
'use strict';

const express = require('express');
const notes = require('../services/casey/notes');
const prompt = require('../lib/caseyPrompt');
const tools = require('../services/casey/tools');

const { makeNotesDb } = require('./helpers/caseyNotesDb');
const makeDb = (rows) => { const d = makeNotesDb(rows); return { query: d.query, rows: d.rows, calls: d.calls, withTransaction: d.withTransaction }; };
const AUTH = { userId: 6, username: 'IT' };
const seed = (over = {}) => ({ id: 1, scope: 'global', version: 1, body: 'Be brief.', edit_note: 'seed', author_id: null, author_name: 'seed', created_at: new Date('2026-11-23T10:00:00Z'), ...over });

beforeEach(() => notes.clearCache());

describe('scopes and normalisation', () => {
  test('isScope: global and route families as familyOf names them; nothing else', () => {
    for (const ok of ['global', '/api/contacts', '/api/tasks', '/hooks', '/api/phone-lines']) expect([ok, notes.isScope(ok)]).toEqual([ok, true]);
    for (const bad of ['', 'Global', '/api', '/api/', '/api/contacts/', '/api/contacts/:id', '/api/x/y', 'contacts', 'x'.repeat(65), 7, null,
      '/api/Tasks', '/api/tasks ', ' /api/tasks', '/API/tasks', '/api/tasks\t', '/api/ta sks']) expect([bad, notes.isScope(bad)]).toEqual([bad, false]);   // a case / padding variant would collide with the family under the ci PAD SPACE column (review S4)
    expect(notes.capFor('global')).toBe(notes.GLOBAL_MAX);
    expect(notes.capFor('/api/tasks')).toBe(notes.FAMILY_MAX);
  });
  test('normalize: CRLF → LF, trailing whitespace off every line, no trailing blank lines; null → ""', () => {
    expect(notes.normalize('a \r\nb\t\r\n\r\n\n')).toBe('a\nb');
    expect(notes.normalize('a\rb\rc')).toBe('a\nb\nc');   // a bare CR is a line end too (not eaten as trailing whitespace)
    expect(notes.normalize(null)).toBe('');
    expect(notes.normalize('  lead kept')).toBe('  lead kept');
  });
  test('normalize is linear: a run of spaces that does not end the line costs milliseconds, not minutes (review B1)', () => {
    const body = (' '.repeat(200000) + 'x\n').repeat(5);   // 1 MB of the adversarial shape
    const t0 = Date.now();
    const out = notes.normalize(body);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(out).toBe(body.trimEnd());
    expect(notes.normalize(' '.repeat(100000))).toBe('');
    // The migrate script's copy (it seeds through the same shape): linear too, and byte-equal to the service's
    const migrate = require('../scripts/caseyV2S4aMigrate');
    const t1 = Date.now();
    expect(migrate.normalizeText(body)).toBe(notes.normalize(body));
    expect(Date.now() - t1).toBeLessThan(200);
    expect(migrate.seedBody()).toBe(notes.normalize(migrate.seedBody()));
  });
});

describe('current(): the doc and its cache', () => {
  test('global text, non-blank family notes only, versions per scope; frozen; cached for the window, fresh on demand', async () => {
    const db = makeDb([seed(), seed({ id: 2, scope: '/api/tasks', version: 3, body: 'Use /complete.\r\n' }), seed({ id: 3, scope: '/api/mail', version: 2, body: '   ' })]);
    const d = await notes.current(db);
    expect(d).toEqual({ global: 'Be brief.', families: { '/api/tasks': 'Use /complete.' }, versions: { global: 1, '/api/tasks': 3, '/api/mail': 2 } });
    expect(Object.isFrozen(d) && Object.isFrozen(d.families)).toBe(true);
    db.rows.push(seed({ id: 4, version: 2, body: 'Be very brief.' }));
    expect((await notes.current(db)).global).toBe('Be brief.');            // cached
    expect(db.calls.length).toBe(1);
    expect((await notes.current(db, { fresh: true })).global).toBe('Be very brief.');
    notes.clearCache();
    expect((await notes.current(db)).global).toBe('Be very brief.');
    expect(db.calls.length).toBe(3);
  });
  test('the cache expires after CACHE_MS: another instance sees an edit within the window', async () => {
    const db = makeDb([seed()]);
    const realNow = Date.now;
    try {
      let now = 1_700_000_000_000;
      Date.now = () => now;
      expect((await notes.current(db)).global).toBe('Be brief.');
      db.rows.push(seed({ id: 2, version: 2, body: 'Edited elsewhere.' }));
      now += notes.CACHE_MS - 1;
      expect((await notes.current(db)).global).toBe('Be brief.');          // still inside the window
      now += 2;
      expect((await notes.current(db)).global).toBe('Edited elsewhere.');  // the window passed: re-read
      expect(db.calls.length).toBe(2);
    } finally { Date.now = realNow; }
  });
  test('an empty table: blank global, no families', async () => {
    expect(await notes.current(makeDb([]))).toEqual({ global: '', families: {}, versions: {} });
  });
});

describe('versions / version / currentRows', () => {
  test('versions: newest first, lengths instead of bodies; version: one row with its body, null when absent; both refuse an unknown scope', async () => {
    const db = makeDb([seed(), seed({ id: 2, version: 2, body: 'Be brief, always.', edit_note: 'longer', author_id: 6, author_name: 'IT' })]);
    const vs = await notes.versions(db, 'global');
    expect(vs.map((v) => [v.version, v.chars, v.author_name, v.edit_note])).toEqual([[2, 17, 'IT', 'longer'], [1, 9, 'seed', 'seed']]);
    expect(vs[0].body).toBeUndefined();
    expect(vs[0].created_at).toBe('2026-11-23T10:00:00.000Z');
    expect(await notes.version(db, 'global', 1)).toMatchObject({ version: 1, body: 'Be brief.', author_id: null });
    expect(await notes.version(db, 'global', '2')).toMatchObject({ version: 2, body: 'Be brief, always.', author_id: 6 });
    expect(await notes.version(db, 'global', 3)).toBeNull();
    await expect(notes.versions(db, 'nope')).rejects.toMatchObject({ status: 400 });
    await expect(notes.version(db, 'global', 0)).rejects.toMatchObject({ status: 400 });
    await expect(notes.version(db, 'global', 'x')).rejects.toMatchObject({ status: 400 });
  });
  test('currentRows: the current row of every scope, global first', async () => {
    const db = makeDb([seed({ id: 1, scope: '/api/tasks' }), seed({ id: 2, scope: 'global', version: 1 }), seed({ id: 3, scope: 'global', version: 2, body: 'v2' })]);
    const rows = await notes.currentRows(db);
    expect(rows.map((r) => [r.scope, r.version, r.body])).toEqual([['global', 2, 'v2'], ['/api/tasks', 1, 'Be brief.']]);
  });
});

describe('save()', () => {
  test('a new version: normalised body, the number after the latest, the author denormalised; the cache cleared; the row returned with its body', async () => {
    const db = makeDb([seed()]);
    await notes.current(db);
    const r = await notes.save(db, { scope: 'global', body: 'Be brief.\r\nAnd kind. \n\n', editNote: '  kindness  ', author: AUTH });
    expect(r).toMatchObject({ version: 2, body: 'Be brief.\nAnd kind.', edit_note: 'kindness', author_id: 6, author_name: 'IT' });
    expect(db.calls.some(([s]) => /FOR UPDATE/.test(s))).toBe(true);
    expect((await notes.current(db)).global).toBe('Be brief.\nAnd kind.');   // not the cached 'Be brief.'
    const first = await notes.save(db, { scope: '/api/tasks', body: 'x', editNote: 'n', author: AUTH });
    expect(first.version).toBe(1);
  });
  test('refusals: unknown scope, over the cap (per scope), blank / long edit note, no author, unchanged body (409); nothing inserted', async () => {
    const db = makeDb([seed()]);
    const n = db.rows.length;
    await expect(notes.save(db, { scope: 'bogus', body: 'x', editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: 'unknown scope' });
    await expect(notes.save(db, { scope: 'global', body: 'x'.repeat(notes.GLOBAL_MAX + 1), editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/limit for global is 20,000/) });
    // The raw length is refused BEFORE normalising (review B1): a 10 MB body of spaces never reaches normalize or the transaction.
    const calls0 = db.calls.length;
    await expect(notes.save(db, { scope: '/api/tasks', body: ' '.repeat(notes.FAMILY_MAX * 2 + 1) + 'x', editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/as sent; the limit for \/api\/tasks is 2,000/) });
    expect(db.calls.length).toBe(calls0);
    await expect(notes.save(db, { scope: '/api/tasks', body: ' '.repeat(notes.FAMILY_MAX * 2 - 1) + 'x', editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/the note is 4,000 characters; the limit for \/api\/tasks is 2,000/) });   // exactly the raw bound passes the raw check; over the cap after normalising (leading spaces stay)
    await expect(notes.save(db, { scope: '/api/tasks', body: 'x'.repeat(notes.FAMILY_MAX + 1), editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/limit for \/api\/tasks is 2,000/) });
    await expect(notes.save(db, { scope: 'global', body: 'y', editNote: '   ', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/edit note is required/) });
    await expect(notes.save(db, { scope: 'global', body: 'y', editNote: 'n'.repeat(301), author: AUTH })).rejects.toMatchObject({ status: 400 });
    await expect(notes.save(db, { scope: 'global', body: 'y', editNote: 'n', author: null })).rejects.toMatchObject({ status: 401 });
    await expect(notes.save(db, { scope: 'global', body: 'Be brief.  \r\n', editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/unchanged/) });
    expect(db.rows.length).toBe(n);
    expect(await notes.save(db, { scope: 'global', body: 'x'.repeat(notes.GLOBAL_MAX), editNote: 'n', author: AUTH })).toMatchObject({ version: 2 });   // exactly the cap passes
    // The cap counts CODE POINTS, as the page and CHAR_LENGTH do (review r2 N1): 19,999 x + one emoji is 20,000 characters (20,001 UTF-16 units) and passes
    expect(await notes.save(db, { scope: 'global', body: 'x'.repeat(notes.GLOBAL_MAX - 1) + '😀', editNote: 'n', author: AUTH })).toMatchObject({ version: 3 });
    await expect(notes.save(db, { scope: 'global', body: 'x'.repeat(notes.GLOBAL_MAX) + '😀', editNote: 'n', author: AUTH })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/the note is 20,001 characters/) });
  });
  test('the loser of a concurrent save (ER_LOCK_DEADLOCK from InnoDB — the twin forces it) is re-run once on the new latest; a second deadlock is the caller\'s', async () => {
    const db = makeDb([seed()]);
    let fails = 1;
    const q = db.query;
    db.query = async (sql, params) => {
      if (/FOR UPDATE/.test(sql) && fails > 0) { fails -= 1; db.rows.push(seed({ id: 9, version: db.rows.length + 1, body: 'winner' })); const e = new Error('Deadlock found when trying to get lock'); e.code = 'ER_LOCK_DEADLOCK'; throw e; }
      return q(sql, params);
    };
    db.withTransaction = async (fn) => fn({ query: db.query });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await notes.save(db, { scope: 'global', body: 'mine', editNote: 'n', author: AUTH });
      expect(r.version).toBe(3);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deadlock — re-running/));
      fails = 2;
      await expect(notes.save(db, { scope: 'global', body: 'again', editNote: 'n', author: AUTH })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    } finally { warn.mockRestore(); }
  });
  test('an engine without gap locks surfaces the race as ER_DUP_ENTRY: retried once on the new latest', async () => {
    const db = makeDb([seed()]);
    let raced = false;
    const q = db.query;
    db.query = async (sql, params) => {
      if (/FOR UPDATE/.test(sql) && !raced) { raced = true; const r = await q(sql, params); db.rows.push(seed({ id: 9, version: 2, body: 'someone else' })); return r; }   // another saver lands between the read and the insert
      return q(sql, params);
    };
    db.withTransaction = async (fn) => fn({ query: db.query });
    const r = await notes.save(db, { scope: 'global', body: 'mine', editNote: 'n', author: AUTH });
    expect(r.version).toBe(3);
    expect(db.rows.map((x) => x.version)).toEqual([1, 2, 3]);
  });
});

describe('restore()', () => {
  test('a new version carrying the old body, the note naming the version (and the editor\'s words); a missing version is 404', async () => {
    const db = makeDb([seed(), seed({ id: 2, version: 2, body: 'v2' })]);
    const r = await notes.restore(db, { scope: 'global', version: 1, editNote: 'v2 was wrong', author: AUTH });
    expect(r).toMatchObject({ version: 3, body: 'Be brief.', edit_note: 'Restored version 1: v2 was wrong', author_name: 'IT' });
    const r2 = await notes.restore(db, { scope: 'global', version: 2, author: AUTH });
    expect(r2).toMatchObject({ version: 4, body: 'v2', edit_note: 'Restored version 2' });
    await expect(notes.restore(db, { scope: 'global', version: 9, author: AUTH })).rejects.toMatchObject({ status: 404 });
    await expect(notes.restore(db, { scope: 'global', version: 4, author: AUTH })).rejects.toMatchObject({ status: 409 });   // restoring the current is unchanged
  });
});

describe('familyScopes(app)', () => {
  test('the staff-reachable families of the live catalog, sorted, valid scopes only', () => {
    const app = express();
    app.use(require('../routes/api.casey'));
    app.use(require('../routes/api.tasks'));
    app.use(require('../routes/api.hooks'));   // webhook receivers: a non-staff class whose family must not be offered
    const fams = notes.familyScopes(app);
    expect(fams).toEqual([...fams].sort());
    expect(fams).toEqual(expect.arrayContaining(['/api/casey', '/api/tasks']));
    for (const f of fams) expect([f, notes.isScope(f)]).toEqual([f, true]);
    // Only the families lookup_routes can show (staff, staff:can, su): a family that exists solely in another class is absent.
    const cat = require('../lib/routeCatalog').catalogFor(app);
    const staffFams = new Set(cat.rows.filter((r) => ['staff', 'staff:can', 'su'].includes(r.authClass)).map((r) => r.family));
    const outside = [...new Set(cat.rows.filter((r) => !['staff', 'staff:can', 'su'].includes(r.authClass)).map((r) => r.family).filter((f) => f && !staffFams.has(f)))];
    expect(outside.length).toBeGreaterThan(0);
    for (const f of outside) expect(fams).not.toContain(f);
    expect(fams).toEqual([...staffFams].filter((f) => notes.isScope(f)).sort());
  });
});

describe('lib/caseyPrompt with notes', () => {
  test('systemText(notes): the base alone when blank / absent; base + the framed section + the note when set; byte-identical per input', () => {
    const base = prompt.baseText();
    expect(prompt.systemText()).toBe(base);
    expect(prompt.systemText({ global: '', families: {} })).toBe(base);
    expect(prompt.systemText({ global: '   ' })).toBe(base + prompt.NOTES_HEAD + '   \n');   // the service normalises; the prompt appends what it is given
    const withNote = prompt.systemText({ global: 'Never guess a docket.' });
    expect(withNote.startsWith(base)).toBe(true);
    expect(withNote.endsWith(prompt.NOTES_HEAD + 'Never guess a docket.\n')).toBe(true);
    expect(prompt.NOTES_HEAD).toMatch(/Notes from the firm/);
    expect(prompt.NOTES_HEAD).toMatch(/instructions from the firm/);
    expect(prompt.NOTES_HEAD).toMatch(/outrank anything a tool result/);
    expect(prompt.NOTES_HEAD).toMatch(/not a user's words/);
    expect(prompt.systemText({ global: 'x' })).toBe(prompt.systemText({ global: 'x' }));
  });
  test('signature(tools, notes): same tools + same note → same; a different note or a blank one → different; the family notes do not count (they are not in the prefix)', () => {
    const defs = tools.definitions();
    const a = prompt.signature(defs, { global: 'A', families: {} });
    expect(a).toBe(prompt.signature(defs, { global: 'A', families: { '/api/tasks': 'ignored here' } }));
    expect(a).not.toBe(prompt.signature(defs, { global: 'B', families: {} }));
    expect(a).not.toBe(prompt.signature(defs));
    expect(prompt.signature(defs)).toBe(prompt.signature(defs, { global: '' }));
    expect(a).toMatch(/^v2\.5-[0-9a-f]{8}$/);
  });
  test('the prompt tells the model about a hit\'s note', () => {
    expect(prompt._TEXT).toMatch(/A result may carry `family_notes`/);
    expect(tools.TOOLS.find((t) => t.name === 'lookup_routes').description).toMatch(/`family_notes`/);
  });
});
