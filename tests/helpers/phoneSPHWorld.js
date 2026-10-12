// tests/helpers/phoneSPHWorld.js
//
/**
 * Test world for the comms slice S-PH suites (tests/phoneSPH.*.test.js):
 * per-line phone reading (services/phoneCommsService.js), the phone_line
 * branches of services/mailboxService.js (getAccess / listReadable /
 * listSendable / grant CRUD on phone lines), routes/api.phoneComms.js and the
 * staff-JWT gate in routes/internal/{sms,mms}.js.
 *
 * A stateful fake MySQL in the tests/helpers/mailboxS1World.js style: each
 * statement the code issues is matched by its EXACT normalized text and
 * evaluated against stored rows. UNKNOWN STATEMENTS THROW — a new or edited
 * query fails a test instead of returning nothing. The SQL itself (the
 * generated column, the GROUP BY, the keyset, the contact probe, the plans)
 * runs on MySQL 8 in tests/phoneSPH.mysql.test.js (gated), which also holds
 * this world's answers to the engine's on one shared seed (SPH_SEED).
 *
 * Fidelity notes:
 *   - line attribution = lineOf(): direction 'incoming' → to_number, else
 *     from_number (NULL direction included) — the generated column
 *     phone_event_log.line_number; the twin proves the two agree.
 *   - ORDER BY processed_at DESC, id DESC; keyset (processed_at < t OR
 *     (processed_at = t AND id < i)); GROUP BY other_party with MAX(id) /
 *     COUNT(*); HAVING MAX(id) < ?; LIMIT — all evaluated, not scripted.
 *   - processed_at is a Date (mysql2 + timezone 'Z'); a keyset param is the
 *     'YYYY-MM-DD HH:MM:SS' UTC text the service binds.
 *   - JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.k')) → the string, or null
 *     when the key is absent.
 *   - contact_phones.phone_active_uniq = phone while end_date IS NULL, else
 *     NULL (the generated unique column).
 *   - channel_grants UNIQUE(user, channel_type, channel_id) → ER_DUP_ENTRY.
 */

'use strict';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const clone = (v) => structuredClone(v);

const LINE_COLS = 'pl.id, pl.phone_number, pl.display_name, pl.provider, pl.active, pl.mms_capable';
const LINE_SELECT = 'SELECT id, phone_number, display_name, provider, active, mms_capable FROM phone_lines';
const GRANT_SELECT = 'SELECT g.id, g.user, u.username, u.user_name, u.user_auth, g.channel_type, g.channel_id, g.can_read, g.can_send, g.can_manage, g.granted_by, gb.username AS granted_by_username, g.created_at FROM channel_grants g LEFT JOIN users u ON u.user = g.user LEFT JOIN users gb ON gb.user = g.granted_by';
// ?kind=sms (texts only) adds this before the GROUP BY of both conversation lists
const SMS_ONLY = " AND event_type = 'sms'";
const withKind = (group) => [group, group.replace(' GROUP BY other_party', `${SMS_ONLY} GROUP BY other_party`)];
const groupTail = (sql, group) => withKind(group).flatMap((g) => [`${g} ORDER BY last_id DESC LIMIT ?`, `${g} HAVING MAX(id) < ? ORDER BY last_id DESC LIMIT ?`]).includes(sql);
const CONVO_GROUP = "SELECT other_party, MAX(id) AS last_id, COUNT(*) AS n FROM phone_event_log FORCE INDEX (idx_phone_event_line) WHERE line_number = ? AND suppressed = 0 AND other_party IS NOT NULL GROUP BY other_party";
const CONVO_LATEST = "SELECT id, event_type, direction, body, processed_at, line_number, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status FROM phone_event_log WHERE id IN (?)";
const MSGS = "SELECT id, event_type, direction, body, processed_at, log_id, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status FROM phone_event_log WHERE line_number = ? AND other_party = ? AND suppressed = 0";
const CALLS = "SELECT id, direction, other_party, processed_at, log_id, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status FROM phone_event_log FORCE INDEX (idx_phone_event_line) WHERE line_number = ? AND event_type = 'call' AND suppressed = 0";
const JSONS = "JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ts')) AS ts, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status";
// All numbers (every readable line at once)
const ALL_GROUP = "SELECT other_party, MAX(id) AS last_id, COUNT(*) AS n, GROUP_CONCAT(DISTINCT line_number ORDER BY line_number SEPARATOR ',') AS line_numbers FROM phone_event_log e WHERE line_number IN (?) AND suppressed = 0 AND other_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM phone_lines pl WHERE pl.phone_number = e.other_party) GROUP BY other_party";
const ALL_MSGS = `SELECT id, event_type, direction, body, processed_at, log_id, line_number, ${JSONS} FROM phone_event_log WHERE other_party = ? AND line_number IN (?) AND suppressed = 0`;
const ALL_USED = 'SELECT DISTINCT line_number FROM phone_event_log WHERE other_party = ? AND line_number IN (?) AND suppressed = 0';
const ALL_CALLS = "SELECT id, direction, other_party, processed_at, log_id, line_number, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.started_at')) AS started_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.ended_at')) AS ended_at, JSON_UNQUOTE(JSON_EXTRACT(raw_extra, '$.provider_status')) AS provider_status FROM phone_event_log WHERE line_number IN (?) AND event_type = 'call' AND suppressed = 0";
const KEYSET = ' AND (processed_at < ? OR (processed_at = ? AND id < ?))';
const ORDER_TAIL = ' ORDER BY processed_at DESC, id DESC LIMIT ?';
const CONTACTS = 'SELECT cp.phone, c.contact_id, c.contact_name FROM contact_phones cp JOIN contacts c ON c.contact_id = cp.contact_id WHERE cp.phone_active_uniq IN (?)';
const FIRST_SEEN = 'SELECT MIN(processed_at) AS first_at FROM phone_event_log WHERE other_party = ? AND line_number IN (?) AND suppressed = 0';

/** The attribution rule — the JS twin of phone_event_log.line_number. */
function lineOf(e) {
  return e.direction === 'incoming' ? e.to_number : e.from_number;
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) → ms. */
function sqlTimeMs(s) {
  return Date.parse(`${String(s).replace(' ', 'T')}Z`);
}

function dupErr() {
  return Object.assign(new Error("Duplicate entry for key 'uq_channel_grants_user_channel'"), { code: 'ER_DUP_ENTRY', errno: 1062 });
}

/** Lines as live (2026-10-12) + one inactive line (7). */
const LINES = [
  { id: 1, phone_number: '2485592400', display_name: 'Stuart', provider: 'ringcentral', active: 1, mms_capable: 1, credential_id: 1, provider_id: null },
  { id: 2, phone_number: '2489654574', display_name: 'Shoshana', provider: 'quo', active: 1, mms_capable: 0, credential_id: 2, provider_id: 'PNx2' },
  { id: 3, phone_number: '2489655355', display_name: 'Rena', provider: 'quo', active: 1, mms_capable: 0, credential_id: 2, provider_id: 'PNx3' },
  { id: 4, phone_number: '2486213656', display_name: 'rc2', provider: 'ringcentral', active: 1, mms_capable: 1, credential_id: 1, provider_id: null },
  { id: 6, phone_number: '2484179800', display_name: 'office', provider: 'quo', active: 1, mms_capable: 0, credential_id: 2, provider_id: 'PNx6' },
  { id: 7, phone_number: '2480000007', display_name: 'retired', provider: 'quo', active: 0, mms_capable: 0, credential_id: 2, provider_id: 'PNx7' },
];

const USERS = [
  { user: 0, username: 'automations', user_name: 'Automations', user_auth: 'authorized', roles: 'automation', default_phone: null },
  { user: 1, username: 'Ssandweiss', user_name: 'Stuart', user_auth: 'authorized', roles: 'staff,attorney', default_phone: '2485592400' },
  { user: 5, username: 'sb', user_name: 'Shoshana', user_auth: 'authorized', roles: 'staff', default_phone: '2489654574' },
  { user: 6, username: 'IT', user_name: 'Fred', user_auth: 'authorized - SU', roles: 'it,admin,form_dev', default_phone: '2486213656' },
  { user: 7, username: 'demoted', user_name: 'Demoted', user_auth: 'authorized', roles: 'staff', default_phone: null },
  { user: 9, username: 'nobody', user_name: 'Nobody', user_auth: 'authorized', roles: 'staff', default_phone: null },
  { user: 22, username: 'RENA', user_name: 'Rena', user_auth: 'authorized', roles: 'staff', default_phone: '2489655355' },
];

function makeWorld() {
  const T = {
    users: clone(USERS),
    phone_lines: clone(LINES),
    channel_grants: [],
    phone_event_log: [],
    contacts: [],
    contact_phones: [],
    admin_audit_log: [],
    jwt_api_audit_log: [],
    mailboxes: [],
  };
  const seq = { channel_grants: 0, phone_event_log: 0, admin_audit_log: 0 };
  const statements = [];
  let clock = Date.parse('2026-10-01T12:00:00Z');

  const W = { T, statements, lineOf };

  /** A phone_event_log row; processed_at advances 1 minute per call unless given. */
  W.ev = (over = {}) => {
    clock += 60_000;
    const row = {
      id: ++seq.phone_event_log, provider: 'quo', provider_ref: `r${seq.phone_event_log}`, event_type: 'sms',
      direction: 'incoming', from_number: null, to_number: null, other_party: null, body: null,
      suppressed: 0, log_id: null, raw_extra: null, processed_at: new Date(clock), ...over,
    };
    if (!(row.processed_at instanceof Date)) row.processed_at = new Date(row.processed_at);
    T.phone_event_log.push(row);
    return row.id;
  };
  /** An SMS between a line and another party (direction decides the sides). */
  W.sms = (lineNum, party, direction = 'incoming', over = {}) => W.ev({
    event_type: 'sms', direction,
    from_number: direction === 'incoming' ? party : lineNum,
    to_number: direction === 'incoming' ? lineNum : party,
    other_party: party, body: over.body ?? `text ${seq.phone_event_log + 1}`,
    raw_extra: over.raw_extra !== undefined ? over.raw_extra : JSON.stringify({ ts: new Date(clock + 60_000 - 4000).toISOString(), line: lineNum }),
    ...over,
  });
  W.call = (lineNum, party, direction = 'incoming', over = {}) => W.ev({
    event_type: 'call', direction,
    from_number: direction === 'incoming' ? party : lineNum,
    to_number: direction === 'incoming' ? lineNum : party,
    other_party: party,
    raw_extra: over.raw_extra !== undefined ? over.raw_extra : JSON.stringify({
      line: lineNum, started_at: new Date(clock + 60_000 - 90_000).toISOString(),
      ended_at: new Date(clock + 60_000 - 5_000).toISOString(), provider_status: 'completed',
    }),
    ...over,
  });
  W.grant = (user, lineId, flags = {}) => {
    const row = { id: ++seq.channel_grants, user, channel_type: 'phone_line', channel_id: lineId,
      can_read: 0, can_send: 0, can_manage: 0, granted_by: 6, created_at: new Date('2026-10-12T00:00:00Z') };
    for (const [k, v] of Object.entries(flags)) row[k] = v ? 1 : 0;
    T.channel_grants.push(row);
    return row.id;
  };
  W.contact = (contactId, name, phone, { ended = false } = {}) => {
    if (!T.contacts.some(c => c.contact_id === contactId)) T.contacts.push({ contact_id: contactId, contact_name: name });
    T.contact_phones.push({ id: T.contact_phones.length + 1, contact_id: contactId, phone, end_date: ended ? '2026-01-01' : null });
  };

  const userRow = (id) => T.users.find(u => u.user === Number(id));
  const lineById = (id) => T.phone_lines.find(l => l.id === Number(id));
  const lineCols = (l) => ({ id: l.id, phone_number: l.phone_number, display_name: l.display_name, provider: l.provider, active: l.active, mms_capable: l.mms_capable });
  const grantFor = (user, type, id) => T.channel_grants.find(g => g.user === Number(user) && g.channel_type === type && g.channel_id === Number(id));
  const byLineId = (a, b) => a.id - b.id;
  const json = (row, key) => {
    if (row.raw_extra == null) return null;
    const o = typeof row.raw_extra === 'string' ? JSON.parse(row.raw_extra) : row.raw_extra;
    if (!o || !Object.prototype.hasOwnProperty.call(o, key)) return null;
    const v = o[key];
    return v === null ? 'null' : (typeof v === 'string' ? v : JSON.stringify(v));
  };
  const desc = (a, b) => (b.processed_at - a.processed_at) || (b.id - a.id);
  function keyset(rows, p, at) {
    // (processed_at < t OR (processed_at = t AND id < i))
    const t = sqlTimeMs(p[at]);
    const t2 = sqlTimeMs(p[at + 1]);
    const id = Number(p[at + 2]);
    return rows.filter(r => r.processed_at.getTime() < t || (r.processed_at.getTime() === t2 && r.id < id));
  }
  function shapeGrant(g) {
    const u = userRow(g.user);
    const gb = userRow(g.granted_by);
    return {
      id: g.id, user: g.user, username: u ? u.username : null, user_name: u ? u.user_name : null, user_auth: u ? u.user_auth : null,
      channel_type: g.channel_type, channel_id: g.channel_id, can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage,
      granted_by: g.granted_by, granted_by_username: gb ? gb.username : null, created_at: g.created_at,
    };
  }

  async function query(sqlIn, params = []) {
    const sql = norm(sqlIn);
    const p = params || [];
    statements.push({ sql, params: clone(p) });
    let m;

    // ── auth middleware + audit ──
    if (/^INSERT INTO jwt_api_audit_log/.test(sql)) {
      T.jwt_api_audit_log.push({ route: p[0], method: p[1], headers: JSON.parse(p[2]), query: JSON.parse(p[3]), body: JSON.parse(p[4]), auth_type: p[7], username: p[8] });
      return [{ insertId: T.jwt_api_audit_log.length, affectedRows: 1 }];
    }
    if (/^INSERT INTO admin_audit_log/.test(sql)) {
      T.admin_audit_log.push({ id: ++seq.admin_audit_log, tool: p[0], user_id: p[1], route: p[3], method: p[4], status: p[5], error_message: p[6], details: p[10] == null ? null : JSON.parse(p[10]) });
      return [{ insertId: seq.admin_audit_log, affectedRows: 1 }];
    }

    // ── mailboxService identity ──
    if (sql === 'SELECT user_auth FROM users WHERE user = ? LIMIT 1') {
      const u = userRow(p[0]);
      return [u ? [{ user_auth: u.user_auth }] : []];
    }
    if (sql === 'SELECT roles FROM users WHERE user = ? LIMIT 1') {
      const u = userRow(p[0]);
      return [u ? [{ roles: u.roles == null ? '' : u.roles }] : []];
    }
    if (sql === 'SELECT user FROM users WHERE user = ? LIMIT 1') {
      const u = userRow(p[0]);
      return [u ? [{ user: u.user }] : []];
    }
    if (sql === 'SELECT can_read, can_send, can_manage FROM channel_grants WHERE user = ? AND channel_type = ? AND channel_id = ? LIMIT 1') {
      const g = grantFor(p[0], p[1], p[2]);
      return [g ? [{ can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage }] : []];
    }

    // ── mailboxService phone_line projections ──
    if (sql === `SELECT ${LINE_COLS} FROM phone_lines pl ORDER BY pl.id ASC`) {
      return [[...T.phone_lines].sort(byLineId).map(lineCols)];
    }
    if (sql === `SELECT ${LINE_COLS}, g.can_send, g.can_manage FROM phone_lines pl LEFT JOIN channel_grants g ON g.channel_type = 'phone_line' AND g.channel_id = pl.id AND g.user = ? ORDER BY pl.id ASC`) {
      return [[...T.phone_lines].sort(byLineId).map((l) => {
        const g = grantFor(p[0], 'phone_line', l.id);
        return { ...lineCols(l), can_send: g ? g.can_send : null, can_manage: g ? g.can_manage : null };
      })];
    }
    if (sql === `SELECT ${LINE_COLS}, g.can_read, g.can_send, g.can_manage FROM channel_grants g JOIN phone_lines pl ON pl.id = g.channel_id WHERE g.user = ? AND g.channel_type = 'phone_line' AND g.can_read = 1 ORDER BY pl.id ASC`) {
      const rows = [];
      for (const g of T.channel_grants) {
        if (g.user !== Number(p[0]) || g.channel_type !== 'phone_line' || Number(g.can_read) !== 1) continue;
        const l = lineById(g.channel_id);
        if (l) rows.push({ ...lineCols(l), can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage });
      }
      return [rows.sort(byLineId)];
    }
    if (sql === `SELECT ${LINE_COLS} FROM channel_grants g JOIN phone_lines pl ON pl.id = g.channel_id WHERE g.user = ? AND g.channel_type = 'phone_line' AND g.can_send = 1 ORDER BY pl.id ASC`) {
      const rows = [];
      for (const g of T.channel_grants) {
        if (g.user !== Number(p[0]) || g.channel_type !== 'phone_line' || Number(g.can_send) !== 1) continue;
        const l = lineById(g.channel_id);
        if (l) rows.push(lineCols(l));
      }
      return [rows.sort(byLineId)];
    }
    if (sql === 'SELECT id FROM phone_lines WHERE id = ? LIMIT 1') {
      const l = lineById(p[0]);
      return [l ? [{ id: l.id }] : []];
    }
    if (sql === 'SELECT id FROM mailboxes WHERE id = ? LIMIT 1') {
      const b = T.mailboxes.find(x => x.id === Number(p[0]));
      return [b ? [{ id: b.id }] : []];
    }

    // ── grants CRUD ──
    if (sql === `${GRANT_SELECT} WHERE g.channel_type = ? AND g.channel_id = ? ORDER BY u.user_name ASC, g.user ASC`) {
      const rows = T.channel_grants.filter(g => g.channel_type === p[0] && g.channel_id === Number(p[1])).map(shapeGrant);
      rows.sort((a, b) => String(a.user_name || '').localeCompare(String(b.user_name || '')) || a.user - b.user);
      return [rows];
    }
    if (sql === `${GRANT_SELECT} WHERE g.id = ? LIMIT 1`) {
      const g = T.channel_grants.find(x => x.id === Number(p[0]));
      return [g ? [shapeGrant(g)] : []];
    }
    if (sql === 'INSERT INTO channel_grants (user, channel_type, channel_id, can_read, can_send, can_manage, granted_by) VALUES (?, ?, ?, ?, ?, ?, ?)') {
      if (grantFor(p[0], p[1], p[2])) throw dupErr();
      const row = { id: ++seq.channel_grants, user: Number(p[0]), channel_type: p[1], channel_id: Number(p[2]),
        can_read: p[3], can_send: p[4], can_manage: p[5], granted_by: Number(p[6]), created_at: new Date('2026-10-12T00:00:00Z') };
      T.channel_grants.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if ((m = /^UPDATE channel_grants SET ((?:can_(?:read|send|manage) = \?(?:, )?)+) WHERE id = \? AND channel_type = \? AND channel_id = \?$/.exec(sql))) {
      const cols = m[1].split(', ').map(s => s.replace(' = ?', ''));
      const [id, type, cid] = p.slice(cols.length);
      const g = T.channel_grants.find(x => x.id === Number(id) && x.channel_type === type && x.channel_id === Number(cid));
      if (g) cols.forEach((c, i) => { g[c] = p[i]; });
      return [{ affectedRows: g ? 1 : 0 }];
    }
    if (sql === 'DELETE FROM channel_grants WHERE id = ? AND channel_type = ? AND channel_id = ?') {
      const before = T.channel_grants.length;
      T.channel_grants = T.channel_grants.filter(x => !(x.id === Number(p[0]) && x.channel_type === p[1] && x.channel_id === Number(p[2])));
      return [{ affectedRows: before - T.channel_grants.length }];
    }

    // ── phoneCommsService ──
    if (sql === `${LINE_SELECT} WHERE id = ? LIMIT 1`) {
      const l = lineById(p[0]);
      return [l ? [lineCols(l)] : []];
    }
    if (sql === `${LINE_SELECT} WHERE phone_number = ? LIMIT 1`) {
      const l = T.phone_lines.find(x => x.phone_number === String(p[0]));
      return [l ? [lineCols(l)] : []];
    }
    if (groupTail(sql, CONVO_GROUP)) {
      const having = sql.includes('HAVING');
      const smsOnly = sql.includes(SMS_ONLY);
      const groups = new Map();
      for (const e of T.phone_event_log) {
        // texts AND calls (no event_type predicate since calls joined the list) — texts only under ?kind=sms
        if (lineOf(e) !== String(p[0]) || Number(e.suppressed) !== 0 || e.other_party == null) continue;
        if (smsOnly && e.event_type !== 'sms') continue;
        const g = groups.get(e.other_party) || { other_party: e.other_party, last_id: 0, n: 0 };
        g.last_id = Math.max(g.last_id, e.id);
        g.n += 1;
        groups.set(e.other_party, g);
      }
      let rows = [...groups.values()];
      if (having) rows = rows.filter(g => g.last_id < Number(p[1]));
      rows.sort((a, b) => b.last_id - a.last_id);
      return [rows.slice(0, Number(p[having ? 2 : 1]))];
    }
    if (sql === CONVO_LATEST) {
      const ids = new Set(p[0].map(Number));
      return [T.phone_event_log.filter(e => ids.has(e.id)).map(e => ({
        id: e.id, event_type: e.event_type, direction: e.direction, body: e.body, processed_at: new Date(e.processed_at), line_number: lineOf(e),
        ts: json(e, 'ts'), started_at: json(e, 'started_at'), ended_at: json(e, 'ended_at'), provider_status: json(e, 'provider_status'),
      }))];
    }
    if (sql === `${MSGS}${ORDER_TAIL}` || sql === `${MSGS}${KEYSET}${ORDER_TAIL}`) {
      // texts AND calls (no event_type predicate since calls joined the thread)
      let rows = T.phone_event_log.filter(e => lineOf(e) === String(p[0]) && e.other_party === String(p[1]) &&
        Number(e.suppressed) === 0);
      const ks = sql.includes(KEYSET);
      if (ks) rows = keyset(rows, p, 2);
      rows.sort(desc);
      return [rows.slice(0, Number(p[ks ? 5 : 2])).map(e => ({
        id: e.id, event_type: e.event_type, direction: e.direction, body: e.body, processed_at: new Date(e.processed_at), log_id: e.log_id,
        ts: json(e, 'ts'), started_at: json(e, 'started_at'), ended_at: json(e, 'ended_at'), provider_status: json(e, 'provider_status'),
      }))];
    }
    if (sql === `${CALLS}${ORDER_TAIL}` || sql === `${CALLS}${KEYSET}${ORDER_TAIL}`) {
      let rows = T.phone_event_log.filter(e => lineOf(e) === String(p[0]) && e.event_type === 'call' && Number(e.suppressed) === 0);
      const ks = sql.includes(KEYSET);
      if (ks) rows = keyset(rows, p, 1);
      rows.sort(desc);
      return [rows.slice(0, Number(p[ks ? 4 : 1])).map(e => ({
        id: e.id, direction: e.direction, other_party: e.other_party, processed_at: new Date(e.processed_at), log_id: e.log_id,
        started_at: json(e, 'started_at'), ended_at: json(e, 'ended_at'), provider_status: json(e, 'provider_status'),
      }))];
    }
    // ── All numbers ──
    if (groupTail(sql, ALL_GROUP)) {
      const having = sql.includes('HAVING');
      const smsOnly = sql.includes(SMS_ONLY);
      const lines = new Set(p[0].map(String));
      const firm = new Set(T.phone_lines.map(l => l.phone_number));
      const groups = new Map();
      for (const e of T.phone_event_log) {
        const ln = lineOf(e);
        if (ln == null || !lines.has(String(ln)) || Number(e.suppressed) !== 0 || e.other_party == null || firm.has(e.other_party)) continue;
        if (smsOnly && e.event_type !== 'sms') continue;
        const g = groups.get(e.other_party) || { other_party: e.other_party, last_id: 0, n: 0, nums: new Set() };
        g.last_id = Math.max(g.last_id, e.id);
        g.n += 1;
        g.nums.add(String(ln));
        groups.set(e.other_party, g);
      }
      let rows = [...groups.values()].map(({ nums, ...g }) => ({ ...g, line_numbers: [...nums].sort().join(',') }));
      if (having) rows = rows.filter(g => g.last_id < Number(p[1]));
      rows.sort((a, b) => b.last_id - a.last_id);
      return [rows.slice(0, Number(p[having ? 2 : 1]))];
    }
    if (sql === `${ALL_MSGS}${ORDER_TAIL}` || sql === `${ALL_MSGS}${KEYSET}${ORDER_TAIL}`) {
      const lines = new Set(p[1].map(String));
      let rows = T.phone_event_log.filter(e => e.other_party === String(p[0]) && lineOf(e) != null && lines.has(String(lineOf(e))) && Number(e.suppressed) === 0);
      const ks = sql.includes(KEYSET);
      if (ks) rows = keyset(rows, p, 2);
      rows.sort(desc);
      return [rows.slice(0, Number(p[ks ? 5 : 2])).map(e => ({
        id: e.id, event_type: e.event_type, direction: e.direction, body: e.body, processed_at: new Date(e.processed_at), log_id: e.log_id, line_number: lineOf(e),
        ts: json(e, 'ts'), started_at: json(e, 'started_at'), ended_at: json(e, 'ended_at'), provider_status: json(e, 'provider_status'),
      }))];
    }
    if (sql === ALL_USED) {
      const lines = new Set(p[1].map(String));
      const used = new Set();
      for (const e of T.phone_event_log) {
        if (e.other_party === String(p[0]) && lineOf(e) != null && lines.has(String(lineOf(e))) && Number(e.suppressed) === 0) used.add(String(lineOf(e)));
      }
      return [[...used].map(line_number => ({ line_number }))];
    }
    if (sql === `${ALL_CALLS}${ORDER_TAIL}` || sql === `${ALL_CALLS}${KEYSET}${ORDER_TAIL}`) {
      const lines = new Set(p[0].map(String));
      let rows = T.phone_event_log.filter(e => lineOf(e) != null && lines.has(String(lineOf(e))) && e.event_type === 'call' && Number(e.suppressed) === 0);
      const ks = sql.includes(KEYSET);
      if (ks) rows = keyset(rows, p, 1);
      rows.sort(desc);
      return [rows.slice(0, Number(p[ks ? 4 : 1])).map(e => ({
        id: e.id, direction: e.direction, other_party: e.other_party, processed_at: new Date(e.processed_at), log_id: e.log_id, line_number: lineOf(e),
        started_at: json(e, 'started_at'), ended_at: json(e, 'ended_at'), provider_status: json(e, 'provider_status'),
      }))];
    }
    if (sql === FIRST_SEEN) {
      const lines = new Set(p[1].map(String));
      const at = T.phone_event_log
        .filter(e => e.other_party === String(p[0]) && lines.has(String(lineOf(e))) && Number(e.suppressed) === 0)
        .map(e => e.processed_at.getTime());
      return [[{ first_at: at.length ? new Date(Math.min(...at)) : null }]];
    }
    if (sql === CONTACTS) {
      const want = new Set(p[0].map(String));
      const rows = [];
      for (const cp of T.contact_phones) {
        const active = cp.end_date == null ? cp.phone : null; // phone_active_uniq
        if (active == null || !want.has(active)) continue;
        const c = T.contacts.find(x => x.contact_id === cp.contact_id);
        if (c) rows.push({ phone: cp.phone, contact_id: c.contact_id, contact_name: c.contact_name });
      }
      return [rows];
    }

    throw new Error(`phoneSPHWorld: unscripted statement: ${sql}`);
  }

  W.db = { query };
  return W;
}

/**
 * One seed both the fake world and the MySQL twin load (the twin INSERTs the
 * same rows), so the engine's answers can be held to this world's.
 * Times are fixed; ids follow processed_at (as live). Lines: 1 Stuart,
 * 3 Rena, 6 office; parties P1..P4; an orphan; a line-to-line text; a
 * suppressed row; a shortcode; an ended contact number.
 */
function SPH_SEED(W) {
  const L1 = '2485592400';
  const L3 = '2489655355';
  const L6 = '2484179800';
  const P1 = '3135550001';
  const P2 = '3135550002';
  const P3 = '3135550003';
  const P4 = '3135550004';
  const ORPHAN = '7344663328';
  W.sms(L1, P1, 'incoming', { body: 'hello from P1' });                  // 1
  W.sms(L1, P1, 'outgoing', { body: 'reply to P1' });                    // 2
  W.call(L1, P2, 'incoming');                                            // 3 call
  W.sms(L1, P2, 'incoming', { body: 'P2 texts' });                       // 4
  W.sms(L1, P3, 'incoming', { body: 'spam', suppressed: 1 });            // 5 suppressed — P3 has no other text
  W.ev({ event_type: 'call', direction: 'incoming', from_number: P4, to_number: ORPHAN, other_party: P4, provider: 'ringcentral' }); // 6 orphan
  W.sms(L1, L3, 'outgoing', { body: 'internal to Rena' });               // 7 line 1 copy of a line-to-line text
  W.sms(L3, L1, 'incoming', { body: 'internal to Rena' });               // 8 line 3 copy
  W.sms(L1, '22395', 'incoming', { body: 'Your code is 1234' });         // 9 shortcode
  W.call(L6, P1, 'incoming', { raw_extra: JSON.stringify({ line: L6, started_at: '2026-10-01T12:08:00.000Z', ended_at: '2026-10-01T12:08:30+00:00', provider_status: 'no-answer' }) }); // 10 missed
  W.call(L6, P2, 'outgoing', { raw_extra: JSON.stringify({ line: L6, started_at: '2026-10-01T12:09:00.000Z', ended_at: '2026-10-01T12:11:05.000Z', provider_status: 'completed' }) }); // 11
  W.ev({ event_type: 'sms', direction: 'incoming', from_number: L1, to_number: P2, other_party: P2, body: 'misdirected' }); // 12 incoming, line on the FROM side only → no line
  W.sms(L1, P1, 'incoming', { body: 'P1 again', raw_extra: JSON.stringify({ line: L1 }) }); // 13 no ts → at = processed_at
  W.ev({ event_type: 'call', direction: null, from_number: L6, to_number: P4, other_party: P4, raw_extra: null }); // 14 NULL direction → from side (line 6)
  W.call(L1, null, 'incoming', { other_party: null, from_number: null });  // 15 call with no other party
  W.contact(501, 'Pat One', P1);
  W.contact(502, 'Old Owner', P2, { ended: true });
  return { L1, L3, L6, P1, P2, P3, P4, ORPHAN };
}

module.exports = { makeWorld, lineOf, SPH_SEED, LINES, USERS };
