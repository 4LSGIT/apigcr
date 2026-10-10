// tests/helpers/mailboxS2World.js
//
/**
 * Test world for the mailbox S2 suites (tests/mailboxS2.*.test.js).
 *
 *   makeWorld()   stateful fake MySQL: the exact statements
 *                 services/mailbox/mailReadService.js, the mailboxService grant
 *                 resolution it calls, and the logService paths case-link uses
 *                 issue — evaluated against stored rows. Unknown statements
 *                 THROW, so a new or edited query shows up as a failing test,
 *                 never as a silent empty result. Same contract as
 *                 tests/helpers/mailboxS1World.js.
 *
 * FIDELITY THAT MATTERS (each verified against MySQL 8.0 with ref/database.sql
 * loaded — see tests/mailboxS2.mysql.test.js, the real-engine twin):
 *   - The mixed-inbox list is parsed, not matched: one branch per mailbox,
 *     each WHERE fragment recognized by its exact text and applied as a
 *     predicate in parameter order. An unrecognized fragment throws.
 *   - LIKE is MySQL's: '%' / '_' wildcards, '\' escapes the next character
 *     (sql_mode has no NO_BACKSLASH_ESCAPES), case-insensitive (general_ci).
 *   - ORDER BY date DESC puts NULL dates LAST (NULL sorts first ascending).
 *   - Comparisons on folder / thread_key / message_id are case-insensitive.
 *   - JSON columns come back parsed and DATETIMEs as Date (mysql2, timezone Z).
 *   - users.roles is a SET: a comma-separated string, '' when empty.
 *   - INSERT … SELECT read-state writes count only NEW rows (the anti-join).
 *   - Transactions snapshot at BEGIN and restore on ROLLBACK.
 *   - The list's scope predicates (mailReadService.scopeWhere) are parsed by ONE
 *     function shared by the list and the filtered bulk mark-read, so the two
 *     can only agree if the service builds them from the same fragments.
 *   - `NOW() - INTERVAL ? MINUTE` is evaluated against Date.now(); rows'
 *     ingested_at defaults to their `date` (old mail — outside any grace).
 */

'use strict';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const ci = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const clone = (v) => structuredClone(v);

const LIST_COLS = 'm.id, m.mailbox_id, m.folder, m.thread_key, m.from_addr, m.to_addrs, m.cc_addrs, ' +
  'm.subject, m.date, m.snippet, m.attachments, m.log_id, (rs.message_fk IS NULL) AS unread, ' +
  'c.case_id AS case_id, c.case_number AS case_number, c.case_number_full AS case_number_full';
const FULL_COLS = 'm.id, m.mailbox_id, m.folder, m.message_id, m.in_reply_to, m.thread_key, ' +
  'm.from_addr, m.to_addrs, m.cc_addrs, m.subject, m.date, m.snippet, m.body_text, m.body_html, ' +
  'm.attachments, m.flags, m.log_id, (rs.message_fk IS NULL) AS unread, ' +
  'c.case_id AS case_id, c.case_number AS case_number, c.case_number_full AS case_number_full';
const JOINS = 'LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id ' +
  'LEFT JOIN log l ON l.log_id = m.log_id ' +
  "LEFT JOIN cases c ON l.log_about_type = 'case' AND c.case_id = l.log_about_id";

/** MySQL LIKE (default '\' escape, case-insensitive) → RegExp. */
function likeToRegExp(pattern) {
  let re = '';
  const s = String(pattern);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { re += s[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') { re += '[\\s\\S]*'; continue; }
    if (ch === '_') { re += '[\\s\\S]'; continue; }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const like = (v, p) => v != null && likeToRegExp(p).test(String(v));

/** A MySQL (ICU) REGEXP as the engine runs it on a general_ci column: case-blind; POSIX classes → JS. */
const icu = (p) => new RegExp(String(p).replace(/\[:space:\]/g, '\\s'), 'i');

// mailReadService.scopeWhere's client_only / has_files fragments, verbatim
// (whitespace-normalized like every statement). The world evaluates the SAME
// semantics in JS; tests/mailboxS2.mysql.test.js proves them on the engine.
const ADDR_TOKEN = `'[^[:space:]<>,;:"()]+@[^[:space:]<>,;:"()]+'`;
const CLIENT_RECIPIENTS = 5;
const JT = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci';
const CLIENT_FRAG = norm(`0 < (SELECT COUNT(*) FROM JSON_TABLE(JSON_ARRAY(SUBSTRING_INDEX(SUBSTRING_INDEX(m.from_addr, '<', -1), '>', 1), ${
  Array.from({ length: CLIENT_RECIPIENTS }, (_, i) => `REGEXP_SUBSTR(CONCAT_WS(',', m.to_addrs, m.cc_addrs), ${ADDR_TOKEN}, 1, ${i + 1})`).join(', ')}),
  '$[*]' COLUMNS (addr VARCHAR(255) ${JT} PATH '$')) x
  JOIN contact_emails ce ON ce.email = x.addr AND ce.end_date IS NULL
  JOIN case_relate cr ON cr.case_relate_client_id = ce.contact_id AND cr.case_relate_type IN (?)
  WHERE ce.email NOT REGEXP ?
  AND NOT EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.address = ce.email))`);
const FILES_FRAG = norm(`0 < (SELECT COUNT(*) FROM JSON_TABLE(m.attachments, '$[*]' COLUMNS (
  part VARCHAR(64) ${JT} PATH '$.part', mime VARCHAR(255) ${JT} PATH '$.mime', cid VARCHAR(512) ${JT} PATH '$.cid')) a
  WHERE a.part IS NOT NULL
  AND NOT (COALESCE(a.mime, '') LIKE 'image/%' AND COALESCE(a.cid, '') <> ''
  AND (LOCATE(CONCAT('cid:', REGEXP_REPLACE(a.cid, '^<|>$', '')), COALESCE(m.body_html, '')) > 0
  OR LOCATE(CONCAT('cid:', REPLACE(REGEXP_REPLACE(a.cid, '^<|>$', ''), '@', '%40')), COALESCE(m.body_html, '')) > 0)))`);
const ADDR_TOKEN_RE = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as the service binds) | Date → epoch ms. */
function ms(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

function parseJsonCol(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

/** DESC on date with NULL last, then id DESC — MySQL's order for the list. */
function cmpDesc(a, b) {
  const da = ms(a.date);
  const dbb = ms(b.date);
  if (da == null && dbb != null) return 1;
  if (da != null && dbb == null) return -1;
  if (da != null && dbb != null && da !== dbb) return dbb - da;
  return Number(b.id) - Number(a.id);
}
function cmpAsc(a, b) { return -cmpDesc(a, b); }

function makeWorld() {
  const T = {
    users: [],
    mailboxes: [],
    channel_grants: [],
    mail_messages: [],
    mail_read_state: [],
    inbox_views: [],
    log: [],
    cases: [],
    email_ingest_executions: [],
    mail_image_senders: [],
    contacts: [],
    contact_emails: [],
    case_relate: [],
  };
  const seq = { channel_grants: 0, inbox_views: 0, log: 0, email_ingest_executions: 0, mail_image_senders: 0, contact_emails: 0, case_relate: 0 };
  const statements = [];
  let snapshot = null;

  // ── seeding helpers ──
  const W = {
    T,
    statements,
    user(user, { auth = 'authorized', roles = '' } = {}) {
      T.users.push({ user, username: `u${user}`, user_name: `User ${user}`, user_auth: auth, roles });
      return user;
    },
    mailbox(id, over = {}) {
      T.mailboxes.push({
        id, address: `box${id}@firm.test`, domain: 'firm.test', display_name: null, color: null, active: 1,
        ingest_folders: JSON.stringify({ INBOX: { emit_to_rules: true } }),
        ingest_state: JSON.stringify({ INBOX: { uidvalidity: 1, last_uid: 1000 } }),
        ...over,
      });
      return id;
    },
    grant(user, mailboxId, { read = 1, send = 0, manage = 0 } = {}) {
      T.channel_grants.push({
        id: ++seq.channel_grants, user, channel_type: 'mailbox', channel_id: mailboxId,
        can_read: read, can_send: send, can_manage: manage, granted_by: 6,
      });
    },
    message(id, over = {}) {
      const row = {
        id, mailbox_id: 1, folder: 'INBOX', uid: id, message_id: `m${id}@x.test`, provider_id: null,
        in_reply_to: null, thread_key: `m${id}@x.test`, from_addr: `Sender ${id} <s${id}@outside.test>`,
        to_addrs: 'box1@firm.test', cc_addrs: null, subject: `Subject ${id}`,
        date: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + id * 60_000), snippet: `snippet ${id}`,
        body_text: `text ${id}`, body_html: `<p>html ${id}</p>`, attachments: '[]', flags: '', log_id: null,
        ...over,
      };
      if (row.date != null && !(row.date instanceof Date)) row.date = new Date(ms(row.date));
      if (row.ingested_at === undefined) row.ingested_at = row.date ? new Date(row.date) : new Date(Date.UTC(2026, 9, 1));
      else if (row.ingested_at != null && !(row.ingested_at instanceof Date)) row.ingested_at = new Date(ms(row.ingested_at));
      T.mail_messages.push(row);
      return id;
    },
    caseRow(case_id, case_number, case_number_full = null, over = {}) {
      T.cases.push({ case_id, case_number, case_number_full, case_type: 'BK', case_stage: 'Open', case_status: 'New', case_open_date: null, ...over });
    },
    /** A contact with active (or, via over.end_date, ended) email rows. */
    contact(contact_id, name, emails = [], { kind = 'person', ended = [] } = {}) {
      T.contacts.push({ contact_id, contact_name: name, contact_kind: kind });
      for (const e of emails) T.contact_emails.push({ id: ++seq.contact_emails, contact_id, email: e, end_date: null });
      for (const e of ended) T.contact_emails.push({ id: ++seq.contact_emails, contact_id, email: e, end_date: new Date('2025-01-01') });
      return contact_id;
    },
    relate(case_id, contact_id, type = 'Primary') {
      T.case_relate.push({ case_relate_id: ++seq.case_relate, case_relate_case_id: case_id, case_relate_client_id: contact_id, case_relate_type: type });
    },
    trust(user, address) {
      T.mail_image_senders.push({ id: ++seq.mail_image_senders, user, address, created_at: new Date('2026-10-09T10:00:00Z') });
    },
    logRow(over = {}) {
      const id = over.log_id || ++seq.log;
      seq.log = Math.max(seq.log, id);
      T.log.push({ log_id: id, log_type: 'email', log_date: new Date(), log_link: '', log_link_type: 'email', log_link_id: 'x@y.test',
        log_about_type: null, log_about_id: null, log_by: 0, log_data: '{}', log_extra: null, log_from: null, log_to: null,
        log_subject: null, log_message: '', log_direction: 'incoming', ...over });
      return id;
    },
    /** An email_ingest_executions row (another source's pipeline run). */
    execution(over = {}) {
      const row = { id: ++seq.email_ingest_executions, source_id: 1, message_id: null, status: 'logged', log_id: null, ...over };
      T.email_ingest_executions.push(row);
      return row.id;
    },
    read(user, message_fk) {
      T.mail_read_state.push({ user, message_fk, read_at: new Date() });
    },
    readSet(user) {
      return T.mail_read_state.filter(r => r.user === user).map(r => r.message_fk).sort((a, b) => a - b);
    },
  };

  // ── row helpers ──
  const userRow = (u) => T.users.find(x => x.user === Number(u));
  const mailboxRow = (id) => T.mailboxes.find(b => b.id === Number(id));
  const logRow = (id) => (id == null ? null : T.log.find(l => l.log_id === Number(id)) || null);
  const isRead = (user, mid) => T.mail_read_state.some(r => r.user === Number(user) && r.message_fk === Number(mid));

  /** CLIENT_FRAG, row by row: SUBSTRING_INDEX sender + the first N address tokens of "To,Cc". */
  function isClientMail(m, types, firm) {
    const cands = [];
    if (m.from_addr != null) cands.push(String(m.from_addr).split('<').pop().split('>')[0]);
    const rcpt = [m.to_addrs, m.cc_addrs].filter(v => v != null).join(',');
    cands.push(...(rcpt.match(ADDR_TOKEN_RE) || []).slice(0, CLIENT_RECIPIENTS));
    return T.contact_emails.some(e => e.end_date == null
      && cands.some(c => ci(c, e.email))
      && T.case_relate.some(r => r.case_relate_client_id === e.contact_id && types.has(r.case_relate_type))
      && !firm.test(String(e.email))
      && !T.mailboxes.some(b => ci(b.address, e.email)));
  }

  /** FILES_FRAG, row by row: a part that is not (image + cid + a LOCATE hit for cid:<id> or its %40 form). */
  function hasFiles(m) {
    const list = parseJsonCol(m.attachments);
    if (!Array.isArray(list)) return false;
    const body = String(m.body_html == null ? '' : m.body_html).toLowerCase();
    return list.some(a => {
      if (!a || typeof a !== 'object' || a.part == null) return false;
      const mime = String(a.mime == null ? '' : a.mime).toLowerCase();
      const cid = a.cid == null ? '' : String(a.cid);
      if (!mime.startsWith('image/') || cid === '') return true;
      const bare = cid.replace(/^<|>$/g, '').toLowerCase();
      return !(body.includes(`cid:${bare}`) || body.includes(`cid:${bare.replace(/@/g, '%40')}`));
    });
  }

  function joined(m, user) {
    const l = logRow(m.log_id);
    const c = l && l.log_about_type === 'case' ? T.cases.find(x => ci(x.case_id, l.log_about_id)) || null : null;
    return { m, unread: isRead(user, m.id) ? 0 : 1, l, c };
  }

  function project(j, cols) {
    const { m, unread, c } = j;
    const out = {};
    for (const col of cols) {
      if (col === 'unread') out.unread = unread;
      else if (col === 'case_id') out.case_id = c ? c.case_id : null;
      else if (col === 'case_number') out.case_number = c ? c.case_number : null;
      else if (col === 'case_number_full') out.case_number_full = c ? c.case_number_full : null;
      else out[col] = col === 'attachments' ? parseJsonCol(m.attachments) : (m[col] instanceof Date ? new Date(m[col]) : m[col]);
    }
    return out;
  }
  const listCols = ['id', 'mailbox_id', 'folder', 'thread_key', 'from_addr', 'to_addrs', 'cc_addrs', 'subject', 'date', 'snippet', 'attachments', 'log_id', 'unread', 'case_id', 'case_number', 'case_number_full'];
  const fullCols = ['id', 'mailbox_id', 'folder', 'message_id', 'in_reply_to', 'thread_key', 'from_addr', 'to_addrs', 'cc_addrs', 'subject', 'date', 'snippet', 'body_text', 'body_html', 'attachments', 'flags', 'log_id', 'unread', 'case_id', 'case_number', 'case_number_full'];

  // ── the list: parse the UNION ALL ──
  const BRANCH_RE = new RegExp(
    '^\\(SELECT ' + esc(LIST_COLS) + ' FROM mail_messages m FORCE INDEX \\(idx_mail_messages_mailbox_date\\) ' + esc(JOINS) +
    ' WHERE m\\.mailbox_id = \\?(.*?) ORDER BY m\\.date DESC, m\\.id DESC LIMIT \\?\\)$'
  );
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** Split `s` on ' AND ' at paren depth 0. */
  function splitAnd(s) {
    const out = []; let depth = 0; let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth === 0 && s.startsWith(' AND ', i)) { out.push(cur); cur = ''; i += 4; continue; }
      cur += c;
    }
    if (cur) out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
  }

  /**
   * The scope predicates (mailReadService.scopeWhere) in `extra` (leading
   * ' AND ' optional), consuming params from p[pi…]. Unknown fragment → throw.
   * @returns {{preds: Function[], pi: number}}
   */
  function parsePreds(extraIn, p, piIn) {
    let pi = piIn;
    const preds = [];
    const extra = String(extraIn || '').replace(/^ AND /, '');
    for (const frag of extra ? splitAnd(extra) : []) {
      if (frag === 'm.folder = ?') { const f = p[pi++]; preds.push(j => ci(j.m.folder, f)); }
      else if (frag === '(m.date < ? OR (m.date = ? AND m.id < ?) OR m.date IS NULL)') {
        const d1 = ms(p[pi++]); const d2 = ms(p[pi++]); const id = Number(p[pi++]);
        preds.push(j => { const d = ms(j.m.date); return d == null || d < d1 || (d === d2 && j.m.id < id); });
      }
      else if (frag === 'm.date IS NULL') preds.push(j => j.m.date == null);
      else if (frag === 'm.id < ?') { const id = Number(p[pi++]); preds.push(j => j.m.id < id); }
      else if (frag === 'rs.message_fk IS NULL') preds.push(j => j.unread === 1);
      else if (frag === 'c.case_id IS NOT NULL') preds.push(j => !!j.c);
      else if (frag === 'c.case_id IS NULL') preds.push(j => !j.c);
      else if (frag === CLIENT_FRAG) {
        const types = new Set(p[pi++]); const firm = icu(p[pi++]);
        preds.push(j => isClientMail(j.m, types, firm));
      }
      else if (frag === FILES_FRAG) preds.push(j => hasFiles(j.m));
      else if (frag === '(m.from_addr LIKE ? OR m.from_addr LIKE ?)') {
        const a = p[pi++]; const bb = p[pi++]; preds.push(j => like(j.m.from_addr, a) || like(j.m.from_addr, bb));
      }
      else if (frag === '(m.from_addr LIKE ? OR m.subject LIKE ?)') {
        const a = p[pi++]; const bb = p[pi++]; preds.push(j => like(j.m.from_addr, a) || like(j.m.subject, bb));
      }
      else throw new Error(`mailboxS2World: unknown list predicate: ${frag}`);
    }
    return { preds, pi };
  }

  function runList(sql, p) {
    const m = /^(.*) ORDER BY `date` DESC, id DESC LIMIT \?$/.exec(sql);
    if (!m) throw new Error(`mailboxS2World: unparsed list statement: ${sql.slice(0, 200)}`);
    const branches = m[1].split(' UNION ALL ');
    let pi = 0;
    const all = [];
    for (const b of branches) {
      const bm = BRANCH_RE.exec(b);
      if (!bm) throw new Error(`mailboxS2World: unparsed list branch: ${b.slice(0, 300)}`);
      const user = p[pi++];
      const mailboxId = p[pi++];
      const parsed = parsePreds(bm[1], p, pi);
      const preds = parsed.preds;
      pi = parsed.pi;
      const lim = Number(p[pi++]);
      const rows = T.mail_messages
        .filter(x => x.mailbox_id === Number(mailboxId))
        .map(x => joined(x, user))
        .filter(j => preds.every(f => f(j)))
        .sort((a, bb) => cmpDesc(a.m, bb.m))
        .slice(0, lim)
        .map(j => project(j, listCols));
      all.push(...rows);
    }
    const outer = Number(p[pi++]);
    if (pi !== p.length) throw new Error(`mailboxS2World: list params mismatch (${pi} used of ${p.length})`);
    return [all.sort(cmpDesc).slice(0, outer)];
  }

  async function query(sqlIn, params = []) {
    const sql = norm(sqlIn);
    const p = params || [];
    statements.push({ sql, params: clone(p) });
    let m;

    // ── mailboxService ──
    if (sql === 'SELECT user_auth FROM users WHERE user = ? LIMIT 1') {
      const u = userRow(p[0]); return [u ? [{ user_auth: u.user_auth }] : []];
    }
    if (sql === 'SELECT roles FROM users WHERE user = ? LIMIT 1') {
      const u = userRow(p[0]); return [u ? [{ roles: u.roles == null ? '' : String(u.roles) }] : []];
    }
    if (sql === 'SELECT can_read, can_send, can_manage FROM channel_grants WHERE user = ? AND channel_type = ? AND channel_id = ? LIMIT 1') {
      const g = T.channel_grants.find(x => x.user === Number(p[0]) && x.channel_type === p[1] && x.channel_id === Number(p[2]));
      return [g ? [{ can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage }] : []];
    }
    const byAddr = (a, b) => String(a.address).localeCompare(String(b.address));
    if (sql === 'SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active FROM mailboxes m ORDER BY m.address ASC') {
      return [[...T.mailboxes].sort(byAddr).map(b => ({ id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active }))];
    }
    if (sql === "SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, g.can_send, g.can_manage FROM mailboxes m LEFT JOIN channel_grants g ON g.channel_type = 'mailbox' AND g.channel_id = m.id AND g.user = ? ORDER BY m.address ASC") {
      return [[...T.mailboxes].sort(byAddr).map(b => {
        const g = T.channel_grants.find(x => x.channel_type === 'mailbox' && x.channel_id === b.id && x.user === Number(p[0]));
        return { id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active, can_send: g ? g.can_send : null, can_manage: g ? g.can_manage : null };
      })];
    }
    // listMailboxesFor (GET /api/mailboxes), the READ-bypass branch: public projection.
    if (sql === "SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, (SELECT COUNT(*) FROM channel_grants cg WHERE cg.channel_type = 'mailbox' AND cg.channel_id = m.id) AS grant_count, g.can_send, g.can_manage FROM mailboxes m LEFT JOIN channel_grants g ON g.channel_type = 'mailbox' AND g.channel_id = m.id AND g.user = ? ORDER BY m.address ASC") {
      return [[...T.mailboxes].sort(byAddr).map(b => {
        const g = T.channel_grants.find(x => x.channel_type === 'mailbox' && x.channel_id === b.id && x.user === Number(p[0]));
        return {
          id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active,
          grant_count: T.channel_grants.filter(x => x.channel_type === 'mailbox' && x.channel_id === b.id).length,
          can_send: g ? g.can_send : null, can_manage: g ? g.can_manage : null,
        };
      })];
    }
    if (sql === "SELECT m.id, m.address, m.domain, m.display_name, m.color, m.active, g.can_read, g.can_send, g.can_manage FROM channel_grants g JOIN mailboxes m ON m.id = g.channel_id WHERE g.user = ? AND g.channel_type = 'mailbox' AND g.can_read = 1 ORDER BY m.address ASC") {
      const rows = [];
      for (const g of T.channel_grants) {
        if (g.user !== Number(p[0]) || g.channel_type !== 'mailbox' || Number(g.can_read) !== 1) continue;
        const b = mailboxRow(g.channel_id);
        if (b) rows.push({ id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active, can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage });
      }
      return [rows.sort(byAddr)];
    }

    // ── mailReadService: summary ──
    if (sql === 'SELECT m.mailbox_id, COUNT(*) AS total, SUM(rs.message_fk IS NULL) AS unread FROM mail_messages m LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id WHERE m.mailbox_id IN (?) AND m.folder = ? GROUP BY m.mailbox_id') {
      const ids = new Set(p[1].map(Number));
      const by = new Map();
      for (const x of T.mail_messages) {
        if (!ids.has(x.mailbox_id) || !ci(x.folder, p[2])) continue;
        const r = by.get(x.mailbox_id) || { mailbox_id: x.mailbox_id, total: 0, unread: 0 };
        r.total++; if (!isRead(p[0], x.id)) r.unread++;
        by.set(x.mailbox_id, r);
      }
      // MySQL returns COUNT as a number, SUM as a DECIMAL string.
      return [[...by.values()].map(r => ({ mailbox_id: r.mailbox_id, total: r.total, unread: String(r.unread) }))];
    }

    // ── list ──
    if (sql.startsWith('(SELECT ' + LIST_COLS)) return runList(sql, p);

    // ── thread / single ──
    if (sql === `SELECT ${FULL_COLS} FROM mail_messages m ${JOINS} WHERE m.thread_key = ? AND m.mailbox_id IN (?) ORDER BY m.date DESC, m.id DESC LIMIT ?`) {
      const ids = new Set(p[2].map(Number));
      return [T.mail_messages
        .filter(x => ci(x.thread_key, p[1]) && ids.has(x.mailbox_id))
        .sort(cmpDesc).slice(0, Number(p[3]))
        .map(x => project(joined(x, p[0]), fullCols))];
    }
    // listMessages: the page's bodies, for the inline-vs-attached count only
    if (sql === 'SELECT id, body_html FROM mail_messages WHERE id IN (?)') {
      const ids = new Set(p[0].map(Number));
      return [T.mail_messages.filter(x => ids.has(x.id)).map(x => ({ id: x.id, body_html: x.body_html }))];
    }
    if (sql === `SELECT ${FULL_COLS} FROM mail_messages m ${JOINS} WHERE m.id = ? LIMIT 1`) {
      const x = T.mail_messages.find(r => r.id === Number(p[1]));
      return [x ? [project(joined(x, p[0]), fullCols)] : []];
    }
    if (sql === 'SELECT id, mailbox_id FROM mail_messages WHERE id = ? LIMIT 1') {
      const x = T.mail_messages.find(r => r.id === Number(p[0]));
      return [x ? [{ id: x.id, mailbox_id: x.mailbox_id }] : []];
    }

    // ── read state ──
    if (sql === 'INSERT INTO mail_read_state (user, message_fk, read_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE read_at = read_at') {
      if (isRead(p[0], p[1])) return [{ affectedRows: 1 }]; // CLIENT_FOUND_ROWS: matched, unchanged
      T.mail_read_state.push({ user: Number(p[0]), message_fk: Number(p[1]), read_at: new Date() });
      return [{ affectedRows: 1 }];
    }
    if (sql === 'DELETE FROM mail_read_state WHERE user = ? AND message_fk = ?') {
      const before = T.mail_read_state.length;
      T.mail_read_state = T.mail_read_state.filter(r => !(r.user === Number(p[0]) && r.message_fk === Number(p[1])));
      return [{ affectedRows: before - T.mail_read_state.length }];
    }
    const bulk = (rows, user) => {
      let n = 0;
      for (const x of rows) {
        if (isRead(user, x.id)) continue;
        T.mail_read_state.push({ user: Number(user), message_fk: x.id, read_at: new Date() }); n++;
      }
      return [{ affectedRows: n }];
    };
    if (sql === 'INSERT INTO mail_read_state (user, message_fk, read_at) SELECT ?, m.id, UTC_TIMESTAMP() FROM mail_messages m LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id WHERE m.id IN (?) AND m.mailbox_id IN (?) AND rs.message_fk IS NULL ON DUPLICATE KEY UPDATE read_at = mail_read_state.read_at') {
      if (p[0] !== p[1]) throw new Error('mailboxS2World: bulk read user params differ');
      const ids = new Set(p[2].map(Number)); const mbs = new Set(p[3].map(Number));
      return bulk(T.mail_messages.filter(x => ids.has(x.id) && mbs.has(x.mailbox_id)), p[0]);
    }
    const ALL_HEAD = `INSERT INTO mail_read_state (user, message_fk, read_at) SELECT ?, m.id, UTC_TIMESTAMP() FROM mail_messages m ${JOINS} WHERE m.mailbox_id IN (?) AND rs.message_fk IS NULL`;
    const ALL_TAIL = ' ON DUPLICATE KEY UPDATE read_at = mail_read_state.read_at';
    if (sql.startsWith(ALL_HEAD) && sql.endsWith(ALL_TAIL)) {
      if (p[0] !== p[1]) throw new Error('mailboxS2World: bulk read user params differ');
      const mbs = new Set(p[2].map(Number));
      const { preds, pi } = parsePreds(sql.slice(ALL_HEAD.length, sql.length - ALL_TAIL.length), p, 3);
      if (pi !== p.length) throw new Error(`mailboxS2World: bulk-all params mismatch (${pi} used of ${p.length})`);
      const rows = T.mail_messages.filter(x => mbs.has(x.mailbox_id)).filter(x => { const j = joined(x, p[0]); return j.unread === 1 && preds.every(f => f(j)); });
      return bulk(rows, p[0]);
    }

    // viewCounts: one COUNT per view, the list's scope predicates
    const COUNT_HEAD = `SELECT COUNT(*) AS n FROM mail_messages m ${JOINS} WHERE m.mailbox_id IN (?)`;
    if (sql.startsWith(COUNT_HEAD)) {
      const mbs = new Set(p[1].map(Number));
      const { preds, pi } = parsePreds(sql.slice(COUNT_HEAD.length), p, 2);
      if (pi !== p.length) throw new Error(`mailboxS2World: view-count params mismatch (${pi} used of ${p.length})`);
      // COUNT(*) comes back as a number (mysql2)
      return [[{ n: T.mail_messages.filter(x => mbs.has(x.mailbox_id)).filter(x => { const j = joined(x, p[0]); return preds.every(f => f(j)); }).length }]];
    }

    // ── views ──
    const viewOut = (v) => ({ id: v.id, name: v.name, mailbox_ids: parseJsonCol(v.mailbox_ids), filters: parseJsonCol(v.filters), is_default: v.is_default, sort_order: v.sort_order });
    if (sql === 'SELECT id, name, mailbox_ids, filters, is_default, sort_order FROM inbox_views WHERE user = ? ORDER BY sort_order ASC, id ASC') {
      return [T.inbox_views.filter(v => v.user === Number(p[0])).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map(viewOut)];
    }
    if (sql === 'SELECT id, name, mailbox_ids, filters, is_default, sort_order FROM inbox_views WHERE id = ? AND user = ? LIMIT 1') {
      const v = T.inbox_views.find(x => x.id === Number(p[0]) && x.user === Number(p[1]));
      return [v ? [viewOut(v)] : []];
    }
    if (sql === 'SELECT id FROM inbox_views WHERE id = ? AND user = ? LIMIT 1 FOR UPDATE') {
      const v = T.inbox_views.find(x => x.id === Number(p[0]) && x.user === Number(p[1]));
      return [v ? [{ id: v.id }] : []];
    }
    if (sql === 'SELECT COUNT(*) AS n FROM inbox_views WHERE user = ?') {
      return [[{ n: T.inbox_views.filter(v => v.user === Number(p[0])).length }]];
    }
    if (sql === 'INSERT INTO inbox_views (user, name, mailbox_ids, filters, is_default, sort_order) VALUES (?, ?, ?, ?, ?, ?)') {
      const id = ++seq.inbox_views;
      T.inbox_views.push({ id, user: Number(p[0]), name: p[1], mailbox_ids: p[2], filters: p[3], is_default: Number(p[4]), sort_order: Number(p[5]) });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (sql === 'UPDATE inbox_views SET is_default = 0 WHERE user = ? AND id <> ?') {
      let n = 0;
      for (const v of T.inbox_views) if (v.user === Number(p[0]) && v.id !== Number(p[1])) { v.is_default = 0; n++; }
      return [{ affectedRows: n }];
    }
    if ((m = /^UPDATE inbox_views SET (.+) WHERE id = \? AND user = \?$/.exec(sql))) {
      const cols = m[1].split(', ').map(s => { const mm = /^(name|mailbox_ids|filters|is_default|sort_order) = \?$/.exec(s); if (!mm) throw new Error(`mailboxS2World: unknown view SET ${s}`); return mm[1]; });
      const id = Number(p[cols.length]); const user = Number(p[cols.length + 1]);
      const v = T.inbox_views.find(x => x.id === id && x.user === user);
      if (v) cols.forEach((c, i) => { v[c] = c === 'is_default' || c === 'sort_order' ? Number(p[i]) : p[i]; });
      return [{ affectedRows: v ? 1 : 0 }];
    }
    if (sql === 'DELETE FROM inbox_views WHERE id = ? AND user = ?') {
      const before = T.inbox_views.length;
      T.inbox_views = T.inbox_views.filter(v => !(v.id === Number(p[0]) && v.user === Number(p[1])));
      return [{ affectedRows: before - T.inbox_views.length }];
    }

    // ── case link ──
    if (sql === 'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1') {
      const c = T.cases.find(x => ci(x.case_id, p[0]));
      return [c ? [clone(c)] : []];
    }
    if (sql === 'SELECT id, mailbox_id, folder, uid, message_id, provider_id, from_addr, to_addrs, subject, date, ingested_at, (ingested_at > NOW() - INTERVAL ? MINUTE) AS fresh, body_text, body_html, log_id FROM mail_messages WHERE id = ? LIMIT 1 FOR UPDATE') {
      const x = T.mail_messages.find(r => r.id === Number(p[1]));
      const fresh = x && x.ingested_at ? (x.ingested_at.getTime() > Date.now() - Number(p[0]) * 60_000 ? 1 : 0) : null;
      return [x ? [{ id: x.id, mailbox_id: x.mailbox_id, folder: x.folder, uid: x.uid, message_id: x.message_id, provider_id: x.provider_id, from_addr: x.from_addr, to_addrs: x.to_addrs, subject: x.subject, date: x.date ? new Date(x.date) : null, ingested_at: x.ingested_at ? new Date(x.ingested_at) : null, fresh, body_text: x.body_text, body_html: x.body_html, log_id: x.log_id }] : []];
    }
    if (sql === 'SELECT DISTINCT provider_id FROM mail_messages WHERE message_id = ? AND provider_id IS NOT NULL') {
      const seen = new Set();
      for (const r of T.mail_messages) if (ci(r.message_id, p[0]) && r.provider_id != null) seen.add(r.provider_id);
      return [[...seen].map(provider_id => ({ provider_id }))];
    }
    if (sql === 'SELECT e.log_id FROM email_ingest_executions e JOIN log l ON l.log_id = e.log_id WHERE e.message_id IN (?) ORDER BY e.id ASC LIMIT 1') {
      const keys = p[0].map(k => String(k).toLowerCase());
      const e = T.email_ingest_executions
        .filter(x => x.log_id != null && x.message_id != null && keys.includes(String(x.message_id).toLowerCase()) && logRow(x.log_id))
        .sort((a, b) => a.id - b.id)[0];
      return [e ? [{ log_id: e.log_id }] : []];
    }
    if (sql === 'SELECT log_id FROM mail_messages WHERE message_id = ? AND id <> ? AND log_id IS NOT NULL ORDER BY id ASC LIMIT 1') {
      const x = T.mail_messages.filter(r => ci(r.message_id, p[0]) && r.id !== Number(p[1]) && r.log_id != null).sort((a, b) => a.id - b.id)[0];
      return [x ? [{ log_id: x.log_id }] : []];
    }
    if (sql === 'SELECT id, ingest_folders, ingest_state FROM mailboxes WHERE id = ? LIMIT 1') {
      const b = mailboxRow(p[0]);
      return [b ? [{ id: b.id, ingest_folders: parseJsonCol(b.ingest_folders), ingest_state: parseJsonCol(b.ingest_state) }] : []];
    }
    if (sql === 'UPDATE mail_messages SET log_id = ? WHERE id = ? AND log_id IS NULL') {
      const x = T.mail_messages.find(r => r.id === Number(p[1]) && r.log_id == null);
      if (x) x.log_id = Number(p[0]);
      return [{ affectedRows: x ? 1 : 0 }];
    }

    // ── logService.createLogEntry ──
    if ((m = /^INSERT INTO log \(log_type, log_date, log_link, log_link_type, log_link_id, log_about_type, log_about_id, log_by, log_data, log_extra, log_from, log_to, log_subject, log_message, log_direction\) VALUES \(\?, (CONVERT_TZ\(\?, '\+00:00', 'EST5EDT'\)|CONVERT_TZ\(NOW\(\), @@session\.time_zone, 'EST5EDT'\)), \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)$/.exec(sql))) {
      const withDate = m[1].startsWith('CONVERT_TZ(?');
      const q = [...p];
      const row = { log_type: q.shift() };
      row.log_date_utc = withDate ? q.shift() : null; // the UTC instant bound (EST5EDT conversion is the engine's)
      Object.assign(row, {
        log_link: q[0], log_link_type: q[1], log_link_id: q[2], log_about_type: q[3], log_about_id: q[4],
        log_by: q[5], log_data: q[6], log_extra: q[7], log_from: q[8], log_to: q[9], log_subject: q[10],
        log_message: q[11], log_direction: q[12],
      });
      if (q.length !== 13) throw new Error('mailboxS2World: log insert params mismatch');
      row.log_id = ++seq.log;
      T.log.push(row);
      return [{ insertId: row.log_id, affectedRows: 1 }];
    }
    // ── logService.getLogEntry (setLogAbout's existence check) ──
    if (sql.startsWith('SELECT l.*, u.user_name AS by_name,') && sql.endsWith('WHERE l.log_id = ?')) {
      const l = logRow(p[0]);
      return [l ? [{ ...clone(l), by_name: null, about_case_id: null, about_case_number: null, about_contact_id: null, about_contact_name: null }] : []];
    }
    if (sql === 'UPDATE log SET log_about_type = ?, log_about_id = ? WHERE log_id = ?') {
      const l = logRow(p[2]);
      if (l) { l.log_about_type = p[0]; l.log_about_id = p[1]; }
      return [{ affectedRows: l ? 1 : 0 }];
    }

    // ── trusted image senders (per user) ──
    if (sql === 'SELECT address FROM mail_image_senders WHERE user = ? AND address IN (?)') {
      const want = new Set(p[1].map(a => String(a).toLowerCase()));
      return [T.mail_image_senders.filter(r => r.user === Number(p[0]) && want.has(String(r.address).toLowerCase())).map(r => ({ address: r.address }))];
    }
    if (sql === 'SELECT address, created_at FROM mail_image_senders WHERE user = ? ORDER BY address ASC') {
      return [T.mail_image_senders.filter(r => r.user === Number(p[0])).sort((a, b) => String(a.address).localeCompare(String(b.address)))
        .map(r => ({ address: r.address, created_at: new Date(r.created_at) }))];
    }
    if (sql === 'INSERT INTO mail_image_senders (user, address) VALUES (?, ?) ON DUPLICATE KEY UPDATE address = address') {
      const dup = T.mail_image_senders.find(r => r.user === Number(p[0]) && ci(r.address, p[1]));
      if (dup) return [{ affectedRows: 1, insertId: dup.id }];   // CLIENT_FOUND_ROWS: unchanged row = 1
      const id = ++seq.mail_image_senders;
      T.mail_image_senders.push({ id, user: Number(p[0]), address: p[1], created_at: new Date() });
      return [{ affectedRows: 1, insertId: id }];
    }
    if (sql === 'DELETE FROM mail_image_senders WHERE user = ? AND address = ?') {
      const before = T.mail_image_senders.length;
      T.mail_image_senders = T.mail_image_senders.filter(r => !(r.user === Number(p[0]) && ci(r.address, p[1])));
      return [{ affectedRows: before - T.mail_image_senders.length }];
    }

    // ── related (contacts + client cases behind a conversation) ──
    if (sql === 'SELECT thread_key FROM mail_messages WHERE id = ? LIMIT 1') {
      const x = T.mail_messages.find(r => r.id === Number(p[0]));
      return [x ? [{ thread_key: x.thread_key }] : []];
    }
    if (sql === 'SELECT from_addr, to_addrs, cc_addrs FROM mail_messages WHERE thread_key = ? AND mailbox_id IN (?) ORDER BY date DESC, id DESC LIMIT ?') {
      const ids = new Set(p[1].map(Number));
      return [T.mail_messages.filter(x => ci(x.thread_key, p[0]) && ids.has(x.mailbox_id)).sort(cmpDesc).slice(0, Number(p[2]))
        .map(x => ({ from_addr: x.from_addr, to_addrs: x.to_addrs, cc_addrs: x.cc_addrs }))];
    }
    if (sql === 'SELECT from_addr, to_addrs, cc_addrs FROM mail_messages WHERE id = ? LIMIT 1') {
      const x = T.mail_messages.find(r => r.id === Number(p[0]));
      return [x ? [{ from_addr: x.from_addr, to_addrs: x.to_addrs, cc_addrs: x.cc_addrs }] : []];
    }
    if (sql === 'SELECT address FROM mailboxes') return [T.mailboxes.map(b => ({ address: b.address }))];
    // firstSeen: LIKE narrows, the REGEXP pins the address between delimiters
    if (sql === "SELECT MIN(date) AS first_date FROM mail_messages WHERE mailbox_id IN (?) AND (from_addr LIKE ? OR to_addrs LIKE ? OR cc_addrs LIKE ?) AND CONCAT_WS(',', from_addr, to_addrs, cc_addrs) REGEXP ?") {
      const ids = new Set(p[0].map(Number)); const re = icu(p[4]);
      const hits = T.mail_messages.filter(x => ids.has(x.mailbox_id)
        && (like(x.from_addr, p[1]) || like(x.to_addrs, p[2]) || like(x.cc_addrs, p[3]))
        && re.test([x.from_addr, x.to_addrs, x.cc_addrs].filter(v => v != null).join(','))
        && x.date != null);
      const min = hits.reduce((acc, x) => (acc == null || ms(x.date) < acc ? ms(x.date) : acc), null);
      return [[{ first_date: min == null ? null : new Date(min) }]];
    }
    if (sql === 'SELECT ce.email, c.contact_id, c.contact_name, c.contact_kind FROM contact_emails ce JOIN contacts c ON c.contact_id = ce.contact_id WHERE ce.email IN (?) AND ce.end_date IS NULL') {
      const want = new Set(p[0].map(a => String(a).toLowerCase()));
      const out = [];
      for (const e of T.contact_emails) {
        if (e.end_date != null || !want.has(String(e.email).toLowerCase())) continue;
        const c = T.contacts.find(x => x.contact_id === e.contact_id);
        if (c) out.push({ email: e.email, contact_id: c.contact_id, contact_name: c.contact_name, contact_kind: c.contact_kind });
      }
      return [out];
    }
    if (sql === 'SELECT cr.case_relate_client_id AS contact_id, cr.case_relate_type AS relation, ca.case_id, ca.case_number, ca.case_number_full, ca.case_type, ca.case_stage, ca.case_status, ca.case_open_date FROM case_relate cr JOIN cases ca ON ca.case_id = cr.case_relate_case_id WHERE cr.case_relate_client_id IN (?) AND cr.case_relate_type IN (?)') {
      const who = new Set(p[0].map(Number)); const types = new Set(p[1]);
      const out = [];
      for (const r of T.case_relate) {
        if (!who.has(r.case_relate_client_id) || !types.has(r.case_relate_type)) continue;
        const ca = T.cases.find(x => ci(x.case_id, r.case_relate_case_id));
        if (ca) out.push({ contact_id: r.case_relate_client_id, relation: r.case_relate_type, case_id: ca.case_id, case_number: ca.case_number, case_number_full: ca.case_number_full,
          case_type: ca.case_type, case_stage: ca.case_stage, case_status: ca.case_status, case_open_date: ca.case_open_date ? new Date(ca.case_open_date) : null });
      }
      return [out];
    }

    // ── lib/auth.jwtOrApiKey's fire-and-forget audit row ──
    if (sql === 'INSERT INTO jwt_api_audit_log (route, method, headers, query_params, body, ip_address, user_agent, auth_type, username, auth_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      T.jwt_api_audit_log = T.jwt_api_audit_log || [];
      T.jwt_api_audit_log.push({ route: p[0], method: p[1], auth_type: p[7], username: p[8], auth_status: p[9] });
      return [{ affectedRows: 1 }];
    }

    throw new Error(`mailboxS2World: unknown statement: ${sql.slice(0, 240)}`);
  }

  const conn = {
    query,
    async beginTransaction() { snapshot = clone(T); },
    async commit() { snapshot = null; },
    async rollback() { if (snapshot) { for (const k of Object.keys(T)) T[k] = snapshot[k]; snapshot = null; } },
    release() {},
    destroy() {},
  };
  W.db = { query, getConnection: async () => conn };
  return W;
}

module.exports = { makeWorld, likeToRegExp };
