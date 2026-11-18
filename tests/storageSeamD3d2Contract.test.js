// tests/storageSeamD3d2Contract.test.js
//
/**
 * storage-seam D3d-2 — CONTRACT: `case_dropbox` is an API FIELD, the column
 * behind it is retired (D3d-3 drops it) and `case_folder_cache` is no longer
 * written or read. The entity_folders binding is the ONE record of a case's
 * folder (ref/DOCUMENTS_V3_DESIGN.md §3, §9 D3; the retire-a-column gate in
 * CLAUDE.md).
 *   - getCase: `case_dropbox` on the payload = the binding's link (a stale
 *     column value, while the column still exists, is overwritten).
 *   - updateCase: `case_dropbox` is split off BEFORE the information_schema
 *     column gate (which stops listing the column after the DROP), never in the
 *     UPDATE's column list, written with setHumanLink (a blank removes the
 *     binding); `changes.case_dropbox.from` is the binding's prior link; a write
 *     carrying only the link runs NO `UPDATE cases`; a failing binding write
 *     THROWS (the binding is the record — no column write stands behind it).
 *   - createCase: the same split; setHumanLink after the INSERT.
 *   - mergeCases: links from the bindings; an unbound survivor adopts the
 *     loser's link through setHumanLink (link only) inside the transaction; a
 *     bound survivor keeps its own; no cases column, no case_folder_cache SQL.
 *   - THE GATE AS A TEST: no file under services/ routes/ lib/ scripts/ issues
 *     SQL naming case_folder_cache or the retired column (the D3a / D3d-1
 *     migration scripts and their records excepted — they are the history).
 * Replaces tests/storageSeamD3bCaseLinkDualWrite.test.js (D3b-1's dual-write).
 * Scripted db (the caseJudgeFill pattern); domainEvents mocked.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const fs = require('fs');
const path = require('path');

jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn(() => Promise.resolve()),
}));

const domainEvents = require('../lib/domainEvents');
const caseService = require('../services/caseService');

// The post-D3d-3 column list: NO case_dropbox. Every write below must pass the
// gate without it — that is the rehearsal of the DROP.
const COLUMNS = ['case_id', 'case_type', 'case_number', 'case_number_full', 'case_judge', 'case_trustee', 'case_chapter', 'case_caption', 'case_notes', 'custom'];
const PRIOR = { case_id: 'C1', case_type: '', case_number: '', case_number_full: '', case_judge: '', case_trustee: '', case_chapter: '', case_caption: '', case_notes: '' };

function caseDb(priorRow, { bindingLink = null, bindingFails = false, columnValue } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes, reads,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT \* FROM cases WHERE case_id/.test(s)) {
        reads.push(s);
        return [priorRow ? [{ ...priorRow, ...(columnValue !== undefined ? { case_dropbox: columnValue } : {}) }] : []];
      }
      if (/FROM information_schema\.COLUMNS/.test(s)) return [COLUMNS.map(c => ({ COLUMN_NAME: c }))];
      if (/^SELECT external_id, path_lower, human_link FROM entity_folders/.test(s)) {
        reads.push(s);
        return [bindingLink ? [{ external_id: null, path_lower: null, human_link: bindingLink }] : []];
      }
      if (/^UPDATE cases SET/.test(s) || /^INSERT INTO cases/.test(s)) { writes.push({ s, params }); return [{ affectedRows: 1 }]; }
      if (/entity_folders/.test(s)) { if (bindingFails) throw new Error('binding table is on fire'); writes.push({ s, params }); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  };
}
const bindingWrites = db => db.writes.filter(w => /entity_folders/.test(w.s));
const caseWrites = db => db.writes.filter(w => /^(UPDATE|INSERT INTO) cases/.test(w.s));

beforeEach(() => { domainEvents.emit.mockClear(); });

describe('getCase — the payload field is the binding', () => {
  test('case_dropbox comes from entity_folders, overwriting whatever the row carried', async () => {
    const db = caseDb(PRIOR, { bindingLink: 'https://www.dropbox.com/scl/fo/bound001?dl=0', columnValue: 'https://stale' });
    const out = await caseService.getCase(db, 'C1');
    expect(out.case.case_dropbox).toBe('https://www.dropbox.com/scl/fo/bound001?dl=0');
    expect(db.reads.some(r => /FROM entity_folders/.test(r))).toBe(true);
  });
  test('unbound → null (not undefined: the pages test the field)', async () => {
    const out = await caseService.getCase(caseDb(PRIOR), 'C1');
    expect(out.case.case_dropbox).toBeNull();
    expect(await caseService.getCase(caseDb(null), 'C1')).toBeNull();
  });
});

describe('updateCase — case_dropbox is a virtual key', () => {
  test('with other fields: the UPDATE names the other columns only, then setHumanLink; changes/updated_fields/data carry the field', async () => {
    const db = caseDb(PRIOR, { bindingLink: 'https://old' });
    const r = await caseService.updateCase(db, 'C1', { case_dropbox: 'https://www.dropbox.com/scl/fo/byhand01?dl=0', case_notes: 'x' }, { userId: 6, source: 'manual' });
    expect(caseWrites(db).map(w => w.s)).toEqual(['UPDATE cases SET `case_notes` = ? WHERE case_id = ?']);
    expect(caseWrites(db)[0].params).toEqual(['x', 'C1']);
    expect(bindingWrites(db)).toHaveLength(1);
    expect(bindingWrites(db)[0].s).toMatch(/^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\)/);
    expect(bindingWrites(db)[0].params).toEqual(['case', 'C1', 'dropbox', 'https://www.dropbox.com/scl/fo/byhand01?dl=0']);
    expect(r.updated_fields).toEqual(['case_notes', 'case_dropbox']);
    expect(r.changes.case_dropbox).toEqual({ from: 'https://old', to: 'https://www.dropbox.com/scl/fo/byhand01?dl=0' });
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
    const env = domainEvents.emit.mock.calls[0][2];
    expect(env.data.case_dropbox).toBe('https://www.dropbox.com/scl/fo/byhand01?dl=0');
    expect(env.changes.case_dropbox.from).toBe('https://old');
    expect(env.extra.updated_fields).toEqual(['case_notes', 'case_dropbox']);
  });
  test('alone: NO UPDATE cases at all — the binding write is the write', async () => {
    const db = caseDb(PRIOR);
    const r = await caseService.updateCase(db, 'C1', { case_dropbox: 'https://x' }, { userId: 6 });
    expect(caseWrites(db)).toEqual([]);
    expect(bindingWrites(db)).toHaveLength(1);
    expect(r).toMatchObject({ case_id: 'C1', updated_fields: ['case_dropbox'], changes: { case_dropbox: { from: null, to: 'https://x' } } });
  });
  test('the same link again: no change, no event', async () => {
    const db = caseDb(PRIOR, { bindingLink: 'https://x' });
    const r = await caseService.updateCase(db, 'C1', { case_dropbox: 'https://x' }, { userId: 6 });
    expect(r.changes).toEqual({});
    expect(domainEvents.emit).not.toHaveBeenCalled();
    expect(bindingWrites(db)).toHaveLength(1);   // setHumanLink is idempotent on the same link — the row write is harmless
  });
  test('a blank link removes the binding; the key is matched case-insensitively (MySQL would have); the change reads from → null', async () => {
    const db = caseDb(PRIOR, { bindingLink: 'https://old' });
    const r = await caseService.updateCase(db, 'C1', { CASE_DROPBOX: '' }, { userId: 6 });
    expect(bindingWrites(db)).toHaveLength(1);
    expect(bindingWrites(db)[0].s).toMatch(/^DELETE FROM entity_folders WHERE entity_kind = \? AND entity_id = \? AND source = \?/);
    expect(bindingWrites(db)[0].params).toEqual(['case', 'C1', 'dropbox']);
    expect(r.changes.case_dropbox).toEqual({ from: 'https://old', to: null });
    expect(caseWrites(db)).toEqual([]);
  });
  test('a write that does not touch case_dropbox writes no binding SQL (it still reads the binding for the envelope)', async () => {
    const db = caseDb(PRIOR, { bindingLink: 'https://old' });
    await caseService.updateCase(db, 'C1', { case_notes: 'hello' }, { userId: 6 });
    expect(bindingWrites(db)).toEqual([]);
    expect(domainEvents.emit.mock.calls[0][2].data.case_dropbox).toBe('https://old');
  });
  test('a failing binding write THROWS — nothing else stands behind the link now', async () => {
    const db = caseDb(PRIOR, { bindingFails: true });
    await expect(caseService.updateCase(db, 'C1', { case_dropbox: 'https://x' }, { userId: 6 })).rejects.toThrow('binding table is on fire');
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
  test('an unknown key is still refused (the gate lost nothing but the virtual key)', async () => {
    await expect(caseService.updateCase(caseDb(PRIOR), 'C1', { case_dropbox: 'https://x', nope: 1 })).rejects.toThrow(/unknown column\(s\): nope/);
  });
});

describe('createCase — the same split', () => {
  test('a folder link at create time is not an INSERT column; it binds the new case after the INSERT; blank or absent binds nothing', async () => {
    const db = caseDb(null);
    const made = await caseService.createCase(db, { case_type: 'Bankruptcy', case_dropbox: 'https://www.dropbox.com/scl/fo/atcreate?dl=0' });
    expect(caseWrites(db)).toHaveLength(1);
    expect(caseWrites(db)[0].s).toMatch(/^INSERT INTO cases \(`case_id`, `case_type`\) VALUES \(\?, \?\)$/);
    expect(bindingWrites(db)).toHaveLength(1);
    expect(bindingWrites(db)[0].params).toEqual(['case', made.case_id, 'dropbox', 'https://www.dropbox.com/scl/fo/atcreate?dl=0']);
    const db2 = caseDb(null);
    await caseService.createCase(db2, { case_type: 'Bankruptcy', Case_Dropbox: '   ' });
    await caseService.createCase(db2, { case_type: 'Bankruptcy' });
    expect(bindingWrites(db2)).toEqual([]);
    expect(caseWrites(db2).every(w => !/case_dropbox/i.test(w.s))).toBe(true);
  });
});

describe('mergeCases — the folder link ledger on the binding', () => {
  const SURVIVOR = 'AAAAAAAA'; const LOSER = 'BBBBBBBB';
  const base = { case_stage: 'Open', case_status: 'New', case_type: 'Bankruptcy', case_subtype: '', case_number: '', case_number_full: '', case_notes: '', case_alerts: '', case_open_date: null, pipeline_phase: 'lead' };
  function mergeDb({ survivorLink = null, loserLink = null } = {}) {
    const seen = [];
    const query = async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      seen.push({ s, params });
      if (/^SELECT \* FROM cases WHERE case_id IN/.test(s)) return [[{ case_id: SURVIVOR, ...base }, { case_id: LOSER, ...base }]];
      if (/^SELECT external_id, path_lower, human_link FROM entity_folders/.test(s)) {
        const link = params[1] === SURVIVOR ? survivorLink : loserLink;
        return [link ? [{ external_id: null, path_lower: null, human_link: link }] : []];
      }
      if (/FROM information_schema\.COLUMNS/.test(s)) return [[]];
      if (/FROM cases WHERE case_id NOT IN/.test(s)) return [[]];
      if (/FROM checklists l JOIN checklists s/.test(s)) return [[]];
      if (/SELECT COUNT\(\*\) AS c/.test(s)) return [[{ c: 0 }]];
      if (/^(DELETE|UPDATE|INSERT)/.test(s)) return [{ affectedRows: 0 }];
      return [[]];
    };
    const conn = { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
    return { seen, query, getConnection: async () => conn };
  }
  const sqls = db => db.seen.map(x => x.s);

  test('an UNBOUND survivor adopts the loser\'s link — setHumanLink on the survivor, link only, after the loser\'s row is deleted; the plan lists case_dropbox as filled', async () => {
    const db = mergeDb({ loserLink: 'https://www.dropbox.com/scl/fo/loser001?dl=0' });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);
    expect(plan.fields.filled).toContain('case_dropbox');
    const del = db.seen.findIndex(x => /^DELETE FROM entity_folders WHERE entity_kind = 'case' AND entity_id <> \? AND entity_id = \?/.test(x.s));
    const set = db.seen.findIndex(x => /^INSERT INTO entity_folders \(entity_kind, entity_id, source, human_link\)/.test(x.s));
    expect(del).toBeGreaterThan(-1); expect(set).toBeGreaterThan(del);
    expect(db.seen[set].params).toEqual(['case', SURVIVOR, 'dropbox', 'https://www.dropbox.com/scl/fo/loser001?dl=0']);
    expect(sqls(db).some(s => /^UPDATE cases SET .*case_dropbox/.test(s))).toBe(false);
    expect(sqls(db).some(s => /case_folder_cache/.test(s))).toBe(false);
    // the recovery snapshot carries the loser's link under its API name
    const log = db.seen.find(x => /^INSERT INTO log/.test(x.s));
    expect(log).toBeTruthy();
    expect(JSON.stringify(log.params)).toContain('https://www.dropbox.com/scl/fo/loser001?dl=0');
  });
  test('a BOUND survivor keeps its own; a differing loser link goes into the notes; the same link is nothing', async () => {
    const db = mergeDb({ survivorLink: 'https://s', loserLink: 'https://l' });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER);
    expect(plan.fields.filled).not.toContain('case_dropbox');
    expect(sqls(db).some(s => /^INSERT INTO entity_folders/.test(s))).toBe(false);
    const upd = db.seen.find(x => /^UPDATE cases SET/.test(x.s));
    expect(upd.s).toContain('`case_notes` = CONCAT(IFNULL(`case_notes`, \'\'), ?)');
    expect(upd.params.join('\n')).toMatch(/\(dropbox folder\) ---\nhttps:\/\/l/);
    const same = mergeDb({ survivorLink: 'https://s', loserLink: 'https://s' });
    await caseService.mergeCases(same, SURVIVOR, LOSER);
    expect(sqls(same).some(s => /^INSERT INTO entity_folders/.test(s))).toBe(false);
    expect(sqls(same).some(s => /dropbox folder/.test(s))).toBe(false);
  });
  test('dry run: the binding is read, nothing written, the plan still names the fill', async () => {
    const db = mergeDb({ loserLink: 'https://l' });
    const plan = await caseService.mergeCases(db, SURVIVOR, LOSER, { dryRun: true });
    expect(plan.fields.filled).toContain('case_dropbox');
    expect(sqls(db).some(s => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });
});

describe('THE GATE — nothing in the app issues SQL on the retired pair', () => {
  const ROOT = path.join(__dirname, '..');
  const DIRS = ['services', 'routes', 'lib', 'scripts'];   // the pages issue no SQL; their `case_dropbox` is the API field
  const EXCEPT = new Set([
    'scripts/storageSeamD3aEntityFolders.js',      // created entity_folders FROM the pair (history)
    'scripts/storageSeamD3d1CaseFolderLink.js',    // renamed the token in the nine workflow rows (history)
    'scripts/storageSeamD3d3Drop.js',              // D3d-3: the DROP itself
  ]);
  const SQL_SHAPES = [
    /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+`?case_folder_cache`?\b/,
    /\bcase_dropbox\b[^\n]*\bFROM\s+`?cases`?\b/,
    /\bSET\s+`?case_dropbox`?\s*=/,
    /\bc\.case_dropbox\b/,
    /`case_dropbox`/,
  ];
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  test('no SQL names case_folder_cache or the cases.case_dropbox column (the D3a / D3d-1 / D3d-3 scripts are the history)', () => {
    const hits = [];
    for (const dir of DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        if (EXCEPT.has(rel) || rel.startsWith('scripts/mobile-survey/')) continue;
        const src = fs.readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;   // prose about the history is allowed; SQL is not
          for (const re of SQL_SHAPES) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
