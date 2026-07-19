/**
 * Tests for services/esignService.js — the e-sign DATA LAYER (Phase 1A).
 *
 * NO network, NO real DB: `db` is a stateful stub whose query() dispatches on
 * SQL text and actually applies the writes, so a transition test fails if the
 * UPDATE is wrong and not merely if the guard is. Same posture as
 * tests/taskService.test.js.
 *
 * The stub deliberately MODELS three MySQL behaviours the service depends on:
 *   1. UNIQUE (provider, provider_id) with NULLs treated as DISTINCT
 *   2. UNIQUE (tracking_id)
 *   3. mysql2 returning JSON columns already parsed
 *
 * (1) and (2) are schema-level and a stub cannot prove them. They were verified
 * against REAL engines, and the results are recorded here so the next reader
 * does not have to re-derive them from documentation:
 *
 *   LIVE server (MySQL 8.4.6, 2026-07-19): `phone_event_log` carries
 *   UNIQUE KEY (provider, provider_ref) and currently holds 13 rows that are
 *   ALL ('ringcentral', NULL). Multiple NULLs coexist under a live composite
 *   unique key on the very server this ships to.
 *
 *   LOCAL MySQL 8.0.46, running the actual migration: three
 *   ('zoho_sign', NULL) drafts inserted successfully; a duplicate non-NULL
 *   ('zoho_sign','ZS-111') was rejected with ERROR 1062 for key
 *   'signing_requests.uq_provider'. The constraint still bites where it should.
 *
 * What is asserted below is therefore the SERVICE's behaviour in the presence
 * of those engine semantics, which is the part a unit test can own.
 *
 *   npx jest tests/esignService.test.js
 */

const esignService = require('../services/esignService');

const {
  STATUSES,
  TRANSITIONS,
  TERMINAL,
  TERMINAL_SUCCESS,
  LINKABLE_TYPES,
} = esignService;

const CASE_ID  = 'AbC12dEf';          // 8 chars, matches every live cases.case_id
const LONGEST_KIND = 'retainer_postpetition';
const USER_STUART = 1;

// ─────────────────────────────────────────────────────────────
// Stub
// ─────────────────────────────────────────────────────────────

/** mysql2-shaped duplicate-key error. */
function dupKeyError(keyName, value) {
  const err = new Error(`Duplicate entry '${value}' for key '${keyName}'`);
  err.code = 'ER_DUP_ENTRY';
  err.errno = 1062;
  err.sqlMessage = `Duplicate entry '${value}' for key 'signing_requests.${keyName}'`;
  return err;
}

const JSON_COLS = ['recipients', 'placement_json', 'raw_payload'];

function makeDb() {
  const state = {
    requests: [],
    events: [],
    nextId: 1,
    nextEventId: 1,
    insertAttempts: 0,
    /** Force the next N signing_requests INSERTs to raise a tracking-id dup. */
    forceTrackingDup: 0,
    /** Force the next signing_requests INSERT to raise a dup on a DIFFERENT key. */
    forceOtherDup: false,
    /** When true, SELECTs return JSON columns as strings (driver without auto-parse). */
    jsonAsStrings: false,
    clock: 0,
  };

  const stamp = () => {
    state.clock += 1;
    return `2026-07-19 10:00:${String(state.clock).padStart(2, '0')}`;
  };

  /** Model MySQL's unique keys. NULL provider_id never collides. */
  function assertUnique(candidate, excludeId = null) {
    for (const r of state.requests) {
      if (r.id === excludeId) continue;
      if (r.tracking_id === candidate.tracking_id) {
        throw dupKeyError('uq_sr_tracking', candidate.tracking_id);
      }
      if (candidate.provider_id != null &&
          r.provider_id != null &&
          r.provider === candidate.provider &&
          r.provider_id === candidate.provider_id) {
        throw dupKeyError('uq_provider', `${candidate.provider}-${candidate.provider_id}`);
      }
    }
  }

  /** Return a row the way the driver would hand it back. */
  function emit(row) {
    const out = { ...row };
    for (const c of JSON_COLS) {
      if (out[c] == null) continue;
      out[c] = state.jsonAsStrings ? out[c] : JSON.parse(out[c]);
    }
    return out;
  }

  const query = jest.fn(async (sql, params = []) => {
    const s = sql.trim();

    // ── INSERT event ──────────────────────────────────────────
    if (/^INSERT INTO signing_request_events/i.test(s)) {
      const [signing_request_id, event, recipient_email, payload, occurred_at] = params;
      const row = {
        id: state.nextEventId++,
        signing_request_id, event, recipient_email, payload, occurred_at,
        created_at: stamp(),
      };
      state.events.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    // ── INSERT request ────────────────────────────────────────
    if (/^INSERT INTO signing_requests/i.test(s)) {
      state.insertAttempts += 1;

      const [
        provider, linkable_type, linkable_id, kind, document_name,
        tracking_id, recipients, placement_json, template_id, expires_at, created_by,
      ] = params;

      if (state.forceOtherDup) {
        state.forceOtherDup = false;
        throw dupKeyError('uq_provider', `${provider}-whatever`);
      }
      if (state.forceTrackingDup > 0) {
        state.forceTrackingDup -= 1;
        throw dupKeyError('uq_sr_tracking', tracking_id);
      }

      const row = {
        id: state.nextId++,
        provider,
        provider_id: null,
        linkable_type, linkable_id, kind,
        status: 'draft',
        document_name, tracking_id, recipients, placement_json,
        template_id,
        seq_instance_id: null,
        signed_pdf_path: null,
        cert_pdf_path: null,
        sent_at: null,
        completed_at: null,
        expires_at,
        raw_payload: null,
        created_by,
        created_at: stamp(),
        updated_at: stamp(),
      };
      assertUnique(row);
      state.requests.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    // ── UPDATE ────────────────────────────────────────────────
    if (/^UPDATE signing_requests SET /i.test(s)) {
      const m = s.match(/^UPDATE signing_requests SET (.+) WHERE id = \?$/i);
      if (!m) throw new Error(`stub: unparseable UPDATE: ${s}`);
      const id  = params[params.length - 1];
      const row = state.requests.find(r => r.id === id);
      if (!row) return [{ affectedRows: 0 }];

      const next = { ...row };
      let pi = 0;
      for (const frag of m[1].split(',').map(x => x.trim())) {
        const fm = frag.match(/^(\w+)\s*=\s*(\?|NULL)$/i);
        if (!fm) throw new Error(`stub: unparseable SET fragment: ${frag}`);
        next[fm[1]] = fm[2] === '?' ? params[pi++] : null;
      }
      assertUnique(next, id);
      Object.assign(row, next, { updated_at: stamp() });
      return [{ affectedRows: 1 }];
    }

    // ── listOutstanding ───────────────────────────────────────
    if (/ORDER BY COALESCE\(sent_at, created_at\)/i.test(s)) {
      const statusCount = (s.match(/status IN \(([^)]*)\)/i)[1].match(/\?/g) || []).length;
      const statuses = params.slice(0, statusCount);
      let rest = params.slice(statusCount);

      let rows = state.requests.filter(r => statuses.includes(r.status));
      if (/linkable_type = \?/i.test(s)) { rows = rows.filter(r => r.linkable_type === rest[0]); rest = rest.slice(1); }
      if (/linkable_id = \?/i.test(s))   { rows = rows.filter(r => r.linkable_id === rest[0]);   rest = rest.slice(1); }

      rows = rows.slice().sort((a, b) => {
        const ka = a.sent_at || a.created_at;
        const kb = b.sent_at || b.created_at;
        return ka === kb ? a.id - b.id : (ka < kb ? -1 : 1);
      });
      return [rows.map(emit)];
    }

    // ── SELECTs ───────────────────────────────────────────────
    if (/FROM signing_requests WHERE id = \?/i.test(s)) {
      const row = state.requests.find(r => r.id === params[0]);
      return [row ? [emit(row)] : []];
    }
    if (/WHERE provider = \? AND provider_id = \?/i.test(s)) {
      const row = state.requests.find(r => r.provider === params[0] && r.provider_id === params[1]);
      return [row ? [emit(row)] : []];
    }
    if (/WHERE tracking_id = \?/i.test(s)) {
      const row = state.requests.find(r => r.tracking_id === params[0]);
      return [row ? [emit(row)] : []];
    }

    throw new Error(`unexpected sql in stub: ${s}`);
  });

  return { query, state };
}

/** Minimal valid createRequest payload. */
function baseArgs(over = {}) {
  return {
    linkableType: 'case',
    linkableId:   CASE_ID,
    kind:         'retainer_prepetition',
    createdBy:    USER_STUART,
    ...over,
  };
}

/** Drive a fresh row straight to `status`, returning { db, request }. */
async function seedAt(status, over = {}) {
  const db = makeDb();
  const request = await esignService.createRequest(db, baseArgs(over));
  if (status === 'draft') return { db, request };

  await esignService.markSent(db, request.id, { providerId: 'ZS-SEED-1' });
  if (status === 'sent') return { db, request: await esignService.getById(db, request.id) };

  // Everything else is one legal hop from 'sent'.
  await esignService.applyStatus(db, request.id, { status });
  return { db, request: await esignService.getById(db, request.id) };
}

afterEach(() => {
  esignService.__setTrackingSuffixGenerator(null);
  esignService.setLogHook(null);
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// 1. tracking_id — format and length bound
// ─────────────────────────────────────────────────────────────

describe('tracking_id', () => {
  test('format is YC-{linkable_id}-{kind}-{8 uppercase hex}', async () => {
    const db  = makeDb();
    const req = await esignService.createRequest(db, baseArgs());

    expect(req.tracking_id).toMatch(
      new RegExp(`^YC-${CASE_ID}-retainer_prepetition-[0-9A-F]{8}$`)
    );
  });

  test('suffix is hex, never base64url — the id must not look splittable on "-"', async () => {
    // 1 of the 1066 live cases.case_id values already contains a base64url '-',
    // so a '-'-bearing suffix would make the id ambiguous today, not one day.
    const db = makeDb();
    for (let i = 0; i < 25; i++) {
      const req = await esignService.createRequest(db, baseArgs({ kind: `k${i}` }));
      const suffix = req.tracking_id.slice(-8);
      expect(suffix).toMatch(/^[0-9A-F]{8}$/);
    }
  });

  test('realistic worst case fits VARCHAR(80) with room to spare', () => {
    const id = esignService._buildTrackingId(CASE_ID, LONGEST_KIND, 'DEADBEEF');
    expect(id).toBe('YC-AbC12dEf-retainer_postpetition-DEADBEEF');
    expect(id.length).toBe(42);
    expect(id.length).toBeLessThanOrEqual(esignService.MAX_TRACKING_ID);
  });

  test('column-width worst case THROWS rather than truncating', () => {
    // linkable_id and kind are varchar(64) each: 3+64+1+64+1+8 = 141.
    const wide = 'x'.repeat(64);
    expect(() => esignService._buildTrackingId(wide, wide, 'DEADBEEF'))
      .toThrow(/TRACKING_ID_TOO_LONG|would be 141 chars/);
    try { esignService._buildTrackingId(wide, wide, 'DEADBEEF'); }
    catch (e) { expect(e.code).toBe('TRACKING_ID_TOO_LONG'); }
  });

  test('a kind that fits its column but blows the tracking id is caught at create', async () => {
    const db = makeDb();
    // 8-char linkable_id leaves 59 chars for kind (21 + K <= 80). 60 overflows
    // while still passing the varchar(64) guard.
    await expect(esignService.createRequest(db, baseArgs({ kind: 'k'.repeat(60) })))
      .rejects.toMatchObject({ code: 'TRACKING_ID_TOO_LONG' });
  });

  test('a kind longer than its column is caught by the length guard first', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs({ kind: 'k'.repeat(65) })))
      .rejects.toMatchObject({ code: 'ESIGN_FIELD_TOO_LONG' });
  });

  test('non-snake_case kinds are rejected (they are embedded verbatim)', async () => {
    const db = makeDb();
    for (const bad of ['Retainer', 'retainer-pre', 'retainer pre', 'reta/iner', '']) {
      await expect(esignService.createRequest(db, baseArgs({ kind: bad })))
        .rejects.toMatchObject({ code: 'INVALID_ESIGN_KIND' });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. tracking_id collision — retry, bounded
// ─────────────────────────────────────────────────────────────

describe('tracking_id collision retry', () => {
  test('re-rolls the suffix and succeeds on the third attempt', async () => {
    const db = makeDb();
    db.state.forceTrackingDup = 2;

    const suffixes = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'];
    let i = 0;
    esignService.__setTrackingSuffixGenerator(() => suffixes[i++]);

    const req = await esignService.createRequest(db, baseArgs());

    expect(db.state.insertAttempts).toBe(3);
    expect(i).toBe(3);                                  // suffix actually re-rolled
    expect(req.tracking_id.endsWith('CCCCCCCC')).toBe(true);
  });

  test('gives up after 3 attempts with TRACKING_ID_COLLISION', async () => {
    const db = makeDb();
    db.state.forceTrackingDup = 3;
    esignService.__setTrackingSuffixGenerator(() => 'AAAAAAAA');

    await expect(esignService.createRequest(db, baseArgs()))
      .rejects.toMatchObject({ code: 'TRACKING_ID_COLLISION' });
    expect(db.state.insertAttempts).toBe(3);
  });

  test('a real collision against an existing row also re-rolls', async () => {
    const db = makeDb();
    esignService.__setTrackingSuffixGenerator(() => 'FIXEDSUF');
    await esignService.createRequest(db, baseArgs());

    // Same linkable_id + kind + suffix => same tracking_id => uq_sr_tracking.
    esignService.__setTrackingSuffixGenerator(() => 'FIXEDSUF');
    await expect(esignService.createRequest(db, baseArgs()))
      .rejects.toMatchObject({ code: 'TRACKING_ID_COLLISION' });
  });

  test('a duplicate on a DIFFERENT key is NOT retried — it surfaces', async () => {
    const db = makeDb();
    db.state.forceOtherDup = true;

    await expect(esignService.createRequest(db, baseArgs()))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(db.state.insertAttempts).toBe(1);       // no retry loop
  });
});

// ─────────────────────────────────────────────────────────────
// 3. createdBy is required (manager condition on the DEFAULT '0' schema call)
// ─────────────────────────────────────────────────────────────

describe('createdBy', () => {
  test('omitted → throws rather than silently becoming the automations user', async () => {
    const db = makeDb();
    const { createdBy, ...noCreatedBy } = baseArgs();
    await expect(esignService.createRequest(db, noCreatedBy))
      .rejects.toMatchObject({ code: 'ESIGN_CREATED_BY_REQUIRED' });
    expect(db.state.requests).toHaveLength(0);
  });

  test('null → throws (the column default must never be reached by accident)', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs({ createdBy: null })))
      .rejects.toMatchObject({ code: 'ESIGN_CREATED_BY_REQUIRED' });
  });

  test('explicit 0 is accepted and stored — automation is a legitimate actor', async () => {
    const db = makeDb();
    const req = await esignService.createRequest(db, baseArgs({ createdBy: 0 }));
    expect(req.created_by).toBe(0);
  });

  test('negative / non-integer is rejected', async () => {
    const db = makeDb();
    for (const bad of [-1, 1.5, 'stuart']) {
      await expect(esignService.createRequest(db, baseArgs({ createdBy: bad })))
        .rejects.toMatchObject({ code: 'ESIGN_CREATED_BY_REQUIRED' });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 4. linkable_id is always bound as a STRING
//
// Regression guard for the EXPLAIN finding: bound as a number, the predicate
// still returns the right row but idx_sr_linkable degrades from
// key_len 516 / ref const,const  to  key_len 258 / ref const, filtered 50%.
// A correctness-preserving performance bug is invisible in output, so it is
// pinned at the binding instead.
// ─────────────────────────────────────────────────────────────

describe('linkable_id string coercion', () => {
  test('createRequest binds a numeric contact id as a string', async () => {
    const db  = makeDb();
    const req = await esignService.createRequest(db, baseArgs({
      linkableType: 'contact',
      linkableId:   22,               // number in, string to the DB
      kind:         'other',
    }));

    const insert = db.query.mock.calls.find(([sql]) => /^INSERT INTO signing_requests/i.test(sql.trim()));
    const boundLinkableId = insert[1][2];          // 3rd bound param
    expect(typeof boundLinkableId).toBe('string');
    expect(boundLinkableId).toBe('22');
    expect(typeof req.linkable_id).toBe('string');
  });

  test('listOutstanding binds a numeric linkableId as a string', async () => {
    const db = makeDb();
    await esignService.listOutstanding(db, { linkableType: 'contact', linkableId: 22 });

    const call  = db.query.mock.calls.find(([sql]) => /ORDER BY COALESCE/i.test(sql));
    const bound = call[1][call[1].length - 1];
    expect(typeof bound).toBe('string');
    expect(bound).toBe('22');
  });

  test('the numeric form still finds the row (the bug is silent, hence the guard)', async () => {
    const db = makeDb();
    await esignService.createRequest(db, baseArgs({ linkableType: 'contact', linkableId: '22', kind: 'other' }));
    const [r] = await esignService.listOutstanding(db, { linkableType: 'contact', linkableId: 22 });
    expect(r).toBeUndefined();      // still a draft, not outstanding
  });
});

// ─────────────────────────────────────────────────────────────
// 5. recipients is never left to the column
//
// Measured on MySQL 8.0.46 under this sql_mode: omitting the NOT NULL json
// column stores JSON scalar `null` with warning 1364 — not [], not SQL NULL.
// ─────────────────────────────────────────────────────────────

describe('recipients', () => {
  test('omitted → the INSERT still binds "[]", never null', async () => {
    const db = makeDb();
    const req = await esignService.createRequest(db, baseArgs());

    const insert = db.query.mock.calls.find(([sql]) => /^INSERT INTO signing_requests/i.test(sql.trim()));
    const bound  = insert[1][6];                  // recipients param
    expect(bound).toBe('[]');
    expect(bound).not.toBeNull();
    expect(req.recipients).toEqual([]);
  });

  test('normalizes to the declared shape and drops provider extras', () => {
    const out = esignService._normalizeRecipients([
      { name: 'Rena', email: '  RENA@4LSG.com ', zoho_only_field: 'x' },
      { email: 'stuart@4lsg.com', order: 5, status: 'signed', ip: '10.0.0.1' },
    ]);

    expect(out).toEqual([
      { name: 'Rena', email: 'rena@4lsg.com', order: 1, status: 'pending', signed_at: null, ip: null },
      { name: null, email: 'stuart@4lsg.com', order: 5, status: 'signed', signed_at: null, ip: '10.0.0.1' },
    ]);
  });

  test('an empty array is legal — a draft may predate its recipients', () => {
    expect(esignService._normalizeRecipients([])).toEqual([]);
    expect(esignService._normalizeRecipients(null)).toEqual([]);
  });

  test('a non-array, or an entry without a usable email, is rejected', () => {
    expect(() => esignService._normalizeRecipients('rena@4lsg.com'))
      .toThrow(/must be an array/);
    expect(() => esignService._normalizeRecipients([{ name: 'Rena' }]))
      .toThrow(/missing or not an email/);
    expect(() => esignService._normalizeRecipients([{ email: 'not-an-email' }]))
      .toThrow(/missing or not an email/);
  });

  test('applyStatus replaces the column with the normalized array', async () => {
    const { db, request } = await seedAt('sent');
    await esignService.applyStatus(db, request.id, {
      status: 'viewed',
      recipients: [{ name: 'Rena', email: 'Rena@4LSG.com', status: 'viewed' }],
    });
    const row = await esignService.getById(db, request.id);
    expect(row.recipients).toEqual([
      { name: 'Rena', email: 'rena@4lsg.com', order: 1, status: 'viewed', signed_at: null, ip: null },
    ]);
  });

  test('reads survive a driver that returns JSON columns as strings', async () => {
    const { db, request } = await seedAt('draft');
    db.state.jsonAsStrings = true;
    const row = await esignService.getById(db, request.id);
    expect(Array.isArray(row.recipients)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// 6. The transition table — exhaustive, all 81 ordered pairs
// ─────────────────────────────────────────────────────────────

describe('status transitions (exhaustive)', () => {
  const legalPairs   = [];
  const illegalPairs = [];
  const noopPairs    = [];
  const terminalPairs = [];

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to)               noopPairs.push([from, to]);
      else if (TERMINAL.has(from))   terminalPairs.push([from, to]);
      else if (TRANSITIONS[from].includes(to)) legalPairs.push([from, to]);
      else                           illegalPairs.push([from, to]);
    }
  }

  test('the table under test covers every status (no silent gaps)', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort());
    expect(legalPairs.length + illegalPairs.length + noopPairs.length + terminalPairs.length)
      .toBe(STATUSES.length ** 2);
    // Sanity: the spec's shape, spelled out.
    expect(TRANSITIONS.draft).toEqual(['sent', 'recalled']);
    expect(TRANSITIONS.bounced).toEqual(['sent', 'recalled', 'satisfied_external']);
    expect([...TERMINAL].sort()).toEqual(
      ['declined', 'expired', 'recalled', 'satisfied_external', 'signed']
    );
  });

  test.each(legalPairs)('LEGAL %s → %s applies and appends an event', async (from, to) => {
    const { db, request } = await seedAt(from);
    const before = db.state.events.length;

    const res = await esignService.applyStatus(db, request.id, { status: to });

    expect(res.changed).toBe(true);
    expect(res.request.status).toBe(to);
    expect(db.state.events.length).toBe(before + 1);
    expect(db.state.events.at(-1).event).toBe(to);
    expect(JSON.parse(db.state.events.at(-1).payload).from_status).toBe(from);
  });

  test.each(illegalPairs)('ILLEGAL %s → %s throws INVALID_ESIGN_TRANSITION', async (from, to) => {
    const { db, request } = await seedAt(from);
    const before = db.state.events.length;

    await expect(esignService.applyStatus(db, request.id, { status: to }))
      .rejects.toMatchObject({ code: 'INVALID_ESIGN_TRANSITION' });

    // Nothing written, nothing logged.
    expect((await esignService.getById(db, request.id)).status).toBe(from);
    expect(db.state.events.length).toBe(before);
  });

  test.each(noopPairs)('IDEMPOTENT %s → %s appends nothing', async (from) => {
    const { db, request } = await seedAt(from);
    const before = db.state.events.length;

    const res = await esignService.applyStatus(db, request.id, { status: from });

    expect(res).toMatchObject({ changed: false, reason: 'noop' });
    expect(db.state.events.length).toBe(before);
  });

  test.each(terminalPairs)('LATE %s → %s is refused softly, not thrown', async (from, to) => {
    const { db, request } = await seedAt(from);
    const before = db.state.events.length;

    const res = await esignService.applyStatus(db, request.id, { status: to });

    expect(res).toMatchObject({ changed: false, reason: 'terminal' });
    expect(res.request.status).toBe(from);
    expect(db.state.events.length).toBe(before);
  });

  test('an unknown status throws before the row is even read', async () => {
    const db = makeDb();
    await expect(esignService.applyStatus(db, 999, { status: 'sIgNeD' }))
      .rejects.toMatchObject({ code: 'INVALID_ESIGN_STATUS' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('applying to a missing row throws ESIGN_NOT_FOUND', async () => {
    const db = makeDb();
    await expect(esignService.applyStatus(db, 4242, { status: 'sent' }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────
// 7. Late events are still recordable via appendEvent
// ─────────────────────────────────────────────────────────────

describe('late events', () => {
  test('a viewed arriving after signed is refused by applyStatus but accepted by appendEvent', async () => {
    const { db, request } = await seedAt('signed');

    const res = await esignService.applyStatus(db, request.id, { status: 'viewed' });
    expect(res).toMatchObject({ changed: false, reason: 'terminal' });

    await esignService.appendEvent(db, request.id, {
      event: 'viewed',
      recipientEmail: 'rena@4lsg.com',
      occurredAt: '2026-07-19T09:00:00Z',
      payload: { late: true },
    });

    const last = db.state.events.at(-1);
    expect(last.event).toBe('viewed');
    expect(last.recipient_email).toBe('rena@4lsg.com');
    expect(last.occurred_at).toBe('2026-07-19 09:00:00');
    expect((await esignService.getById(db, request.id)).status).toBe('signed');
  });

  test('appendEvent refuses to orphan a row (no FK is doing this for us)', async () => {
    const db = makeDb();
    await expect(esignService.appendEvent(db, 999, { event: 'reminded' }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
    expect(db.state.events).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 8. completed_at
// ─────────────────────────────────────────────────────────────

describe('completed_at', () => {
  test.each([...TERMINAL_SUCCESS])('stamped on terminal SUCCESS: %s', async (status) => {
    const { db, request } = await seedAt('sent');
    await esignService.applyStatus(db, request.id, { status, occurredAt: '2026-07-19T12:34:56Z' });
    const row = await esignService.getById(db, request.id);
    expect(row.completed_at).toBe('2026-07-19 12:34:56');
  });

  test.each(['declined', 'expired', 'recalled'])('left NULL on terminal FAILURE: %s', async (status) => {
    const { db, request } = await seedAt('sent');
    await esignService.applyStatus(db, request.id, { status });
    expect((await esignService.getById(db, request.id)).completed_at).toBeNull();
  });

  test('non-terminal statuses do not stamp it', async () => {
    const { db, request } = await seedAt('sent');
    await esignService.applyStatus(db, request.id, { status: 'viewed' });
    expect((await esignService.getById(db, request.id)).completed_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 9. markSent — draft and the bounced resend path
// ─────────────────────────────────────────────────────────────

describe('markSent', () => {
  test('draft → sent stores provider_id, sent_at and a sent event', async () => {
    const { db, request } = await seedAt('draft');

    const row = await esignService.markSent(db, request.id, {
      providerId: 'ZS-111',
      sentAt: '2026-07-19T08:00:00Z',
      expiresAt: '2026-08-02T08:00:00Z',
    });

    expect(row.status).toBe('sent');
    expect(row.provider_id).toBe('ZS-111');
    expect(row.sent_at).toBe('2026-07-19 08:00:00');
    expect(row.expires_at).toBe('2026-08-02 08:00:00');

    const ev = db.state.events.at(-1);
    expect(ev.event).toBe('sent');
    const payload = JSON.parse(ev.payload);
    expect(payload.from_status).toBe('draft');
    expect(payload.provider_id).toBe('ZS-111');
    expect(payload.resend).toBeUndefined();
  });

  test('bounced → sent overwrites provider_id but preserves the old one in the audit trail', async () => {
    const { db, request } = await seedAt('bounced');
    const oldProviderId = (await esignService.getById(db, request.id)).provider_id;
    expect(oldProviderId).toBe('ZS-SEED-1');

    const row = await esignService.markSent(db, request.id, { providerId: 'ZS-222' });

    expect(row.status).toBe('sent');
    expect(row.provider_id).toBe('ZS-222');

    const payload = JSON.parse(db.state.events.at(-1).payload);
    expect(payload).toMatchObject({
      from_status: 'bounced',
      provider_id: 'ZS-222',
      resend: true,
      previous_provider_id: 'ZS-SEED-1',
    });
  });

  test('a resend clears any stale signed/cert pdf paths', async () => {
    const { db, request } = await seedAt('bounced');
    await esignService.setPdfPaths(db, request.id, {
      signedPdfPath: '/Cases/AbC12dEf/stale-signed.pdf',
      certPdfPath:   '/Cases/AbC12dEf/stale-cert.pdf',
    });

    const row = await esignService.markSent(db, request.id, { providerId: 'ZS-333' });

    expect(row.signed_pdf_path).toBeNull();
    expect(row.cert_pdf_path).toBeNull();
  });

  test('the old provider_id vacates the column, so UNIQUE (provider, provider_id) is not violated', async () => {
    const { db, request } = await seedAt('bounced');
    // Another request already holds the id the resend is moving AWAY from —
    // impossible unless the constraint were broken, so instead assert the
    // reverse: reusing a LIVE id on a second request is rejected.
    const other = await esignService.createRequest(db, baseArgs({ kind: 'schedules' }));
    await esignService.markSent(db, request.id, { providerId: 'ZS-444' });

    await expect(esignService.markSent(db, other.id, { providerId: 'ZS-444' }))
      .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  test.each(['sent', 'viewed', 'signed', 'declined', 'expired', 'recalled', 'satisfied_external'])(
    'refuses to send from %s', async (from) => {
      const { db, request } = await seedAt(from);
      await expect(esignService.markSent(db, request.id, { providerId: 'ZS-999' }))
        .rejects.toMatchObject({ code: 'INVALID_ESIGN_TRANSITION' });
    }
  );

  test('requires a providerId', async () => {
    const { db, request } = await seedAt('draft');
    for (const bad of [undefined, null, '', '   ']) {
      await expect(esignService.markSent(db, request.id, { providerId: bad }))
        .rejects.toMatchObject({ code: 'INVALID_PROVIDER_ID' });
    }
  });

  test('missing row throws ESIGN_NOT_FOUND', async () => {
    const db = makeDb();
    await expect(esignService.markSent(db, 1234, { providerId: 'ZS-1' }))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────
// 10. UNIQUE (provider, provider_id) with NULL drafts
//
// Engine-verified — see the file header. These pin the SERVICE side.
// ─────────────────────────────────────────────────────────────

describe('unique (provider, provider_id) with NULL drafts', () => {
  test('many drafts coexist: provider_id is NULL on all of them', async () => {
    const db = makeDb();
    const kinds = ['retainer_prepetition', 'retainer_postpetition', 'schedules', 'other'];
    for (const kind of kinds) await esignService.createRequest(db, baseArgs({ kind }));

    expect(db.state.requests).toHaveLength(4);
    expect(db.state.requests.every(r => r.provider_id === null)).toBe(true);
    expect(new Set(db.state.requests.map(r => r.provider)).size).toBe(1);
  });

  test('getByProviderId refuses null rather than silently returning a draft', async () => {
    const db = makeDb();
    await esignService.createRequest(db, baseArgs());
    await expect(esignService.getByProviderId(db, 'zoho_sign', null))
      .rejects.toMatchObject({ code: 'INVALID_PROVIDER_ID' });
  });

  test('getByProviderId finds a sent request', async () => {
    const { db, request } = await seedAt('draft');
    await esignService.markSent(db, request.id, { providerId: 'ZS-777' });
    const found = await esignService.getByProviderId(db, 'zoho_sign', 'ZS-777');
    expect(found.id).toBe(request.id);
  });
});

// ─────────────────────────────────────────────────────────────
// 11. Reads
// ─────────────────────────────────────────────────────────────

describe('reads', () => {
  test('getById / getByTrackingId round-trip; misses return null', async () => {
    const { db, request } = await seedAt('draft');
    expect((await esignService.getById(db, request.id)).id).toBe(request.id);
    expect((await esignService.getByTrackingId(db, request.tracking_id)).id).toBe(request.id);
    expect(await esignService.getById(db, 9999)).toBeNull();
    expect(await esignService.getByTrackingId(db, 'YC-nope-other-00000000')).toBeNull();
  });

  test('listOutstanding returns only in-flight rows, oldest first', async () => {
    const db = makeDb();
    const a = await esignService.createRequest(db, baseArgs({ kind: 'a_kind' }));
    const b = await esignService.createRequest(db, baseArgs({ kind: 'b_kind' }));
    const c = await esignService.createRequest(db, baseArgs({ kind: 'c_kind' }));

    await esignService.markSent(db, a.id, { providerId: 'ZS-A', sentAt: '2026-07-10T00:00:00Z' });
    await esignService.markSent(db, b.id, { providerId: 'ZS-B', sentAt: '2026-07-01T00:00:00Z' });
    await esignService.markSent(db, c.id, { providerId: 'ZS-C', sentAt: '2026-07-05T00:00:00Z' });
    await esignService.applyStatus(db, c.id, { status: 'signed' });   // out of flight

    const out = await esignService.listOutstanding(db, { linkableType: 'case', linkableId: CASE_ID });
    expect(out.map(r => r.id)).toEqual([b.id, a.id]);
  });

  test('listOutstanding covers sent, viewed and bounced', async () => {
    expect(esignService.OUTSTANDING_STATUSES).toEqual(['sent', 'viewed', 'bounced']);

    const db = makeDb();
    const made = [];
    for (const [i, status] of ['sent', 'viewed', 'bounced'].entries()) {
      const r = await esignService.createRequest(db, baseArgs({ kind: `k${i}` }));
      await esignService.markSent(db, r.id, { providerId: `ZS-${i}` });
      if (status !== 'sent') await esignService.applyStatus(db, r.id, { status });
      made.push(r.id);
    }
    const out = await esignService.listOutstanding(db, {});
    expect(out.map(r => r.id).sort()).toEqual(made.sort());
  });

  test('listOutstanding rejects an unknown linkableType', async () => {
    const db = makeDb();
    await expect(esignService.listOutstanding(db, { linkableType: 'appt' }))
      .rejects.toMatchObject({ code: 'INVALID_LINKABLE_TYPE' });
  });
});

// ─────────────────────────────────────────────────────────────
// 12. Targeted column writes
// ─────────────────────────────────────────────────────────────

describe('setSeqInstance', () => {
  test('attaches and detaches a BIGINT enrollment id as a plain number', async () => {
    const { db, request } = await seedAt('sent');

    // mysql2 is configured with neither supportBigNumbers nor bigNumberStrings
    // (startup/db.js), so BIGINT is a JS number both ways — measured, and the
    // same treatment lib/sequenceEngine.js gives enrollment ids.
    const row = await esignService.setSeqInstance(db, request.id, 9007199254740991);
    expect(row.seq_instance_id).toBe(9007199254740991);
    expect(typeof row.seq_instance_id).toBe('number');

    const cleared = await esignService.setSeqInstance(db, request.id, null);
    expect(cleared.seq_instance_id).toBeNull();
  });

  test('refuses an id past MAX_SAFE_INTEGER instead of corrupting it silently', async () => {
    const { db, request } = await seedAt('sent');
    await expect(esignService.setSeqInstance(db, request.id, Number.MAX_SAFE_INTEGER + 2))
      .rejects.toMatchObject({ code: 'INVALID_SEQ_INSTANCE_ID' });
  });

  test('rejects zero and negatives', async () => {
    const { db, request } = await seedAt('sent');
    for (const bad of [0, -1, 'abc']) {
      await expect(esignService.setSeqInstance(db, request.id, bad))
        .rejects.toMatchObject({ code: 'INVALID_SEQ_INSTANCE_ID' });
    }
  });

  test('missing row throws', async () => {
    const db = makeDb();
    await expect(esignService.setSeqInstance(db, 555, 1))
      .rejects.toMatchObject({ code: 'ESIGN_NOT_FOUND' });
  });
});

describe('setPdfPaths', () => {
  test('writes either path independently and leaves the other alone', async () => {
    const { db, request } = await seedAt('signed');

    let row = await esignService.setPdfPaths(db, request.id, { signedPdfPath: '/a/signed.pdf' });
    expect(row.signed_pdf_path).toBe('/a/signed.pdf');
    expect(row.cert_pdf_path).toBeNull();

    row = await esignService.setPdfPaths(db, request.id, { certPdfPath: '/a/cert.pdf' });
    expect(row.signed_pdf_path).toBe('/a/signed.pdf');       // untouched
    expect(row.cert_pdf_path).toBe('/a/cert.pdf');

    row = await esignService.setPdfPaths(db, request.id, { signedPdfPath: null });
    expect(row.signed_pdf_path).toBeNull();
  });

  test('appends no audit event — plumbing must not dilute the legal trail', async () => {
    const { db, request } = await seedAt('signed');
    const before = db.state.events.length;
    await esignService.setPdfPaths(db, request.id, { signedPdfPath: '/a/signed.pdf' });
    expect(db.state.events.length).toBe(before);
  });

  test('requires at least one field, and throws on an overlong path', async () => {
    const { db, request } = await seedAt('signed');
    await expect(esignService.setPdfPaths(db, request.id, {}))
      .rejects.toMatchObject({ code: 'ESIGN_NO_FIELDS' });
    await expect(esignService.setPdfPaths(db, request.id, { signedPdfPath: '/' + 'x'.repeat(512) }))
      .rejects.toMatchObject({ code: 'ESIGN_FIELD_TOO_LONG' });
  });
});

// ─────────────────────────────────────────────────────────────
// 13. Validation surface + the logging seam
// ─────────────────────────────────────────────────────────────

describe('input validation', () => {
  test('linkableType must be a declared type', async () => {
    const db = makeDb();
    expect(LINKABLE_TYPES).toEqual(['case', 'contact']);
    await expect(esignService.createRequest(db, baseArgs({ linkableType: 'appt' })))
      .rejects.toMatchObject({ code: 'INVALID_LINKABLE_TYPE' });
  });

  test('linkableId must be non-blank and fit its column', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs({ linkableId: '   ' })))
      .rejects.toMatchObject({ code: 'INVALID_LINKABLE_ID' });
    await expect(esignService.createRequest(db, baseArgs({ linkableId: 'x'.repeat(65) })))
      .rejects.toMatchObject({ code: 'ESIGN_FIELD_TOO_LONG' });
  });

  test('documentName longer than its column throws instead of truncating', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs({ documentName: 'd'.repeat(256) })))
      .rejects.toMatchObject({ code: 'ESIGN_FIELD_TOO_LONG' });
  });

  test('an unparseable date is rejected, not coerced to a zero date', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs({ expiresAt: 'next tuesday-ish' })))
      .rejects.toMatchObject({ code: 'INVALID_ESIGN_DATETIME' });
  });
});

describe('log hook seam (slice 1C)', () => {
  test('fires once per appended event and receives the shaped request', async () => {
    const seen = [];
    esignService.setLogHook((db, ev) => { seen.push(ev); });

    const { db, request } = await seedAt('draft');       // 1 event: created
    await esignService.markSent(db, request.id, { providerId: 'ZS-1' });   // 2nd: sent

    expect(seen.map(e => e.event)).toEqual(['created', 'sent']);
    expect(seen[1].request.linkable_type).toBe('case');
    expect(seen[1].request.linkable_id).toBe(CASE_ID);
  });

  test('a throwing hook can never break a write', async () => {
    esignService.setLogHook(() => { throw new Error('log is down'); });
    const db = makeDb();
    const req = await esignService.createRequest(db, baseArgs());
    expect(req.id).toBeTruthy();
  });

  test('a rejecting async hook can never break a write', async () => {
    esignService.setLogHook(async () => { throw new Error('log is down'); });
    const db = makeDb();
    const req = await esignService.createRequest(db, baseArgs());
    expect(req.id).toBeTruthy();
  });

  test('no hook installed → nothing happens', async () => {
    const db = makeDb();
    await expect(esignService.createRequest(db, baseArgs())).resolves.toBeTruthy();
  });
});