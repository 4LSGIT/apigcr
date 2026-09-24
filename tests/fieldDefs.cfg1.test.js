// tests/fieldDefs.cfg1.test.js
//
/**
 * Custom-fields arc CFG-1 — the YisraCase Config move.
 *
 * Proof obligations:
 *
 *   1. USAGE ENDPOINT: GET /api/field-defs/usage?entity= returns
 *      { field_key: count } over every def INCL. inactive; empty registry
 *      → {}; unknown / missing entity → 400. jwtOrApiKey like every other
 *      field-defs route (the s1 gating test already sweeps the router).
 *   2. PREDICATE PARITY: the usage count and the S2 type-lock probe read
 *      ONE predicate definition (KEY_DATA_SQL) — asserted structurally on
 *      the service source (the literal exists exactly once; both aggregates
 *      interpolate the constant) and behaviorally (the SQL each path issues
 *      carries the identical WHERE predicate). The badge and the 409 can
 *      therefore never disagree.
 *   3. settings.html NO LONGER carries the Case Types or Custom Fields
 *      editors; fe-case_types is excluded from the generic firm-settings
 *      rows (CUSTOM → 'caseConfig' → `continue`); the pointer notes exist;
 *      Event Types is parked as the legacy fallback list, still functional.
 *   4. RENAME: the shell and the More button say "YisraCase Config".
 *
 * Same harness family as tests/fieldDefs.s1.test.js: dispatch-on-SQL-text
 * world, real module under test, only lib/auth.jwtOrApiKey mocked.
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6 }; next(); }));
jest.mock('../services/fieldDefReconciler', () => ({ scheduleReconcile: jest.fn(), reconcile: jest.fn() }));

const fs = require('fs');
const path = require('path');
const express = require('express');

const svc = require('../services/fieldDefService');

const ROOT = path.join(__dirname, '..');
const SVC_SRC = fs.readFileSync(path.join(ROOT, 'services/fieldDefService.js'), 'utf8');

// ─────────────────────────────────────────────────────────────
// World — registry rows + a per-table map of '$.<key>' → count
// ─────────────────────────────────────────────────────────────

function row(o) {
  return {
    options: null, validation: null, show_when: null, indexed: 0, sort_order: 0, active: 1,
    created_at: '2026-09-24 10:00:00', updated_at: '2026-09-24 10:00:00', ...o,
  };
}

function worldDb({ rows = [], data = {} } = {}) {
  const state = { rows: rows.map(r => ({ ...r })), log: [] };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    state.log.push({ s, params });
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC/.test(s)) {
      return [state.rows.filter(r => r.entity === params[0])
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
        .map(r => ({ ...r }))];
    }
    // STRICT predicate shape on purpose: an edited predicate lands here as an
    // unscripted query and the suite bites (the usage-wiring mutation check).
    let m;
    if ((m = s.match(/^SELECT COUNT\(\*\) AS n FROM `(cases|contacts)` WHERE JSON_CONTAINS_PATH\(custom, 'one', \?\)$/))) {
      return [[{ n: (data[m[1]] || {})[params[0]] || 0 }]];
    }
    throw new Error('worldDb: unscripted query — ' + s);
  };
  return { state, query };
}

const CASE_STATUS = row({ id: 7, entity: 'case', field_key: 'cf_status', label: 'Status', field_type: 'select',
  options: JSON.stringify([{ value: 'open', label: 'Open', active: true }]) });
const CASE_OLD = row({ id: 8, entity: 'case', field_key: 'cf_old', label: 'Old', field_type: 'text', active: 0, sort_order: 1 });
const CONTACT_C = row({ id: 9, entity: 'contact', field_key: 'cf_c', label: 'C', field_type: 'boolean' });

beforeEach(() => { svc.bump(); });

// ─────────────────────────────────────────────────────────────
// 1. usageCounts — the service fn
// ─────────────────────────────────────────────────────────────

describe('fieldDefService.usageCounts', () => {
  test('counts per def, inactive included; a def with no data counts 0', async () => {
    const db = worldDb({
      rows: [CASE_STATUS, CASE_OLD, CONTACT_C],
      data: { cases: { '$.cf_status': 3, '$.cf_old': 2 } },
    });
    await expect(svc.usageCounts(db, 'case')).resolves.toEqual({ cf_status: 3, cf_old: 2 });
    await expect(svc.usageCounts(db, 'contact')).resolves.toEqual({ cf_c: 0 });
    // one COUNT per def, each bound to that def's '$.<key>' path
    const counts = db.state.log.filter(q => /^SELECT COUNT/.test(q.s));
    expect(counts.map(q => q.params[0])).toEqual(['$.cf_status', '$.cf_old', '$.cf_c']);
  });

  test('empty registry → {} and no table scan at all', async () => {
    const db = worldDb();
    await expect(svc.usageCounts(db, 'case')).resolves.toEqual({});
    expect(db.state.log.filter(q => /^SELECT COUNT/.test(q.s))).toHaveLength(0);
  });

  test('unknown entity → 400 before any query', async () => {
    const db = worldDb();
    let err;
    try { await svc.usageCounts(db, 'matter'); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 400, message: 'entity must be one of case, contact' });
    expect(db.state.log).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Predicate parity — one definition, two aggregates
// ─────────────────────────────────────────────────────────────

describe('KEY_DATA_SQL is the single data-exists predicate', () => {
  test('the literal exists exactly once in the service (its definition)', () => {
    expect(SVC_SRC.match(/JSON_CONTAINS_PATH/g)).toHaveLength(1);
    expect(SVC_SRC).toMatch(/const KEY_DATA_SQL = `JSON_CONTAINS_PATH\(custom, 'one', \?\)`;/);
  });

  test('both aggregates interpolate the constant — exists (type-lock) and COUNT (usage)', () => {
    // Source-literal pins (single-quoted: no interpolation, \\` is the
    // escaped backtick inside the service's template strings).
    expect(SVC_SRC.includes('SELECT 1 AS hit FROM \\`${table}\\` WHERE ${KEY_DATA_SQL} LIMIT 1')).toBe(true);
    expect(SVC_SRC.includes('SELECT COUNT(*) AS n FROM \\`${table}\\` WHERE ${KEY_DATA_SQL}')).toBe(true);
  });

  test('behaviorally: usage issues the byte-identical WHERE predicate the S2 probe issues', async () => {
    const db = worldDb({ rows: [CASE_STATUS], data: {} });
    await svc.usageCounts(db, 'case');
    const count = db.state.log.find(q => /^SELECT COUNT/.test(q.s));
    // The S2 world (tests/customFields.s2.test.js) dispatches the probe on
    //   SELECT 1 AS hit FROM `cases` WHERE JSON_CONTAINS_PATH(custom, 'one', ?) LIMIT 1
    // — same predicate text, same '$.<key>' binding.
    expect(count.s).toBe("SELECT COUNT(*) AS n FROM `cases` WHERE JSON_CONTAINS_PATH(custom, 'one', ?)");
    expect(count.params).toEqual(['$.cf_status']);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. The route
// ─────────────────────────────────────────────────────────────

describe('GET /api/field-defs/usage', () => {
  const router = require('../routes/api.fieldDefs');

  let server, base, db;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = db; next(); });
    app.use(router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  const call = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };

  test('?entity=case → counts incl. inactive defs', async () => {
    db = worldDb({ rows: [CASE_STATUS, CASE_OLD], data: { cases: { '$.cf_status': 3 } } });
    expect(await call('/api/field-defs/usage?entity=case')).toEqual({
      status: 200, body: { status: 'success', usage: { cf_status: 3, cf_old: 0 } },
    });
  });

  test('empty registry → {}; unknown / missing entity → 400', async () => {
    db = worldDb();
    expect(await call('/api/field-defs/usage?entity=contact')).toEqual({
      status: 200, body: { status: 'success', usage: {} },
    });
    expect(await call('/api/field-defs/usage?entity=matter')).toEqual({
      status: 400, body: { status: 'error', message: 'entity must be one of case, contact' },
    });
    expect((await call('/api/field-defs/usage')).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. settings.html — the deletions and the park
// ─────────────────────────────────────────────────────────────

describe('settings.html after CFG-1', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');

  test('the Case Types editor is gone, with a pointer', () => {
    expect(html).not.toMatch(/id="caseTypesSection"/);
    expect(html).not.toMatch(/function ctInit/);
    expect(html).not.toMatch(/Save Case Types/);
    expect(html).toMatch(/Case Types moved to <b>YisraCase Config/);
  });

  test('the Custom Fields editor is gone, with a pointer', () => {
    expect(html).not.toMatch(/id="customFieldsSection"/);
    expect(html).not.toMatch(/function cfInit/);
    expect(html).not.toMatch(/\/api\/field-defs/);
    expect(html).toMatch(/Custom Fields moved to <b>YisraCase Config/);
  });

  test('fe-case_types can NOT fall back into the generic firm-settings rows', () => {
    // The CUSTOM map claims the key…
    expect(html).toMatch(/'fe-case_types':\s*'caseConfig'/);
    // …and the boot loop drops it before settingRow() can render it.
    expect(html).toMatch(/if \(custom === 'caseConfig'\)\s*continue;/);
  });

  test('Event Types is parked as the legacy fallback list — and still works', () => {
    expect(html).toMatch(/Event Types \(legacy fallback list\)/);
    expect(html).toMatch(/only<\/b> when the calendar-type registry is unreachable or empty/);
    expect(html).toMatch(/YisraCase Config → Calendar Types/);
    // Still live in degraded mode: the editor, its save and its init survive.
    expect(html).toMatch(/id="eventTypesSection"/);
    expect(html).toMatch(/function etInit/);
    expect(html).toMatch(/api\('\/api\/app-settings\/fe-event_types', 'PUT'/);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. The rename
// ─────────────────────────────────────────────────────────────

describe('"YisraCase Config" rename (labels only — ids and targets unchanged)', () => {
  test('shell title + topbar', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'public/caseConfigManager.html'), 'utf8');
    expect(shell).toMatch(/<title>YisraCase Config<\/title>/);
    expect(shell).toMatch(/Yisra<span>Case<\/span> Config/);
  });

  test('index.html More button label changed, target untouched', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(idx).toMatch(/data-target="caseConfigDiv"[^>]*>[\s\S]*?YisraCase Config<\/button>/);
    expect(idx).toMatch(/id="caseConfigDiv"/);
  });
});
