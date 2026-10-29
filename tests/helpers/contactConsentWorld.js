// tests/helpers/contactConsentWorld.js
//
/**
 * A stateful in-memory world for the contact phone/email WRITERS and the
 * consent store they write through (YisraMail P1) — the CI-run twin of
 * tests/consentCore.mysql.test.js, which holds the same paths to real MySQL.
 *
 * Holds contacts, contact_phones, contact_emails, comm_consent_events,
 * comm_consent_state, comm_topics, and answers — by SQL text, dispatch style
 * (order-independent) — every statement createContactPhone / updateContactPhone
 * / their email twins, contactService's createContact / updateContact
 * (scalar propagation + the aggregate reconciler), lib/contactMirror and
 * optoutService issue. The consent statements are answered by IDENTITY
 * (optoutService.FIND_SQL / WRITE_SQL), with the store's real semantics: the
 * UNIQUE (source, provider_event_id) → ER_DUP_ENTRY, the guarded upsert, the
 * cache sync on ACTIVE rows only.
 *
 * Anything it does not model that names one of ITS tables is recorded in
 * `unhandled` (and answered empty) — a test asserts that list stays empty, so
 * a writer that starts issuing a new statement against these tables fails
 * here rather than passing on a silent default. Statements about other tables
 * (field defs, settings, domain events) get the empty default.
 */
'use strict';

const { FIND_SQL, WRITE_SQL } = require('../../services/optoutService');
const { answerOptout } = require('./optoutFake');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const lc = (v) => String(v).toLowerCase();
const T = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

function makeWorld({ contacts = [], phones = [], emails = [], states = [], topics = null } = {}) {
  const W = {
    contacts: contacts.map((c) => ({ contact_phone: '', contact_email: '', ...c })),
    phones: phones.map((r) => ({ is_primary: 0, sms_optout: 0, mms_capable: 1, verified: 0, label: 'Mobile', start_date: null, end_date: null, end_reason: null, notes: '', ...r })),
    emails: emails.map((r) => ({ is_primary: 0, email_optout: 0, verified: 0, label: 'Personal', start_date: null, end_date: null, end_reason: null, notes: '', ...r })),
    events: [],
    states: states.map((s) => ({ occurred_at: new Date('2026-01-01T00:00:00Z'), last_event_id: 0, ...s })),
    topics: topics || [{ topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 1 }],
    unhandled: [],
    seen: [],
    locks: [],   // consent lock / sync statements in order: row:active|id|generic, state:share|update|plain, cache:row|index
  };
  let nextRow = 1000;
  let nextEvent = 1;
  let nextContact = 5000;

  const fam = (table) => (table === 'contact_phones'
    ? { rows: W.phones, col: 'phone', flag: 'sms_optout', key: (v) => String(v) }
    : { rows: W.emails, col: 'email', flag: 'email_optout', key: lc });
  const byId = (rows, id) => rows.find((r) => r.id === Number(id));
  const contact = (id) => W.contacts.find((c) => c.contact_id === Number(id));

  function consent(s, p) {
    if (s === WRITE_SQL.event) {
      const [channel, destination, scope, action, source, pid, occurredAt, contactId, line, sendRef, evidence, actor] = p;
      if (pid != null && W.events.some((e) => e.source === source && e.provider_event_id === pid)) {
        const e = new Error(`Duplicate entry '${source}-${pid}' for key 'comm_consent_events.uk_source_event'`);
        e.code = 'ER_DUP_ENTRY'; e.sqlMessage = e.message; throw e;
      }
      const id = nextEvent++;
      W.events.push({ id, channel, destination, scope, action, source, provider_event_id: pid, occurred_at: occurredAt,
        contact_id: contactId, line_number: line, send_ref: sendRef, evidence: evidence == null ? null : JSON.parse(evidence), actor_user_id: actor });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (s === WRITE_SQL.seed) {
      const [channel, destination, scope, state, occurredAt, eventId] = p;
      if (!W.states.some((r) => r.channel === channel && lc(r.destination) === lc(destination) && r.scope === scope)) {
        W.states.push({ channel, destination, scope, state, occurred_at: occurredAt, last_event_id: eventId });
      }
      return [{ affectedRows: 1 }];
    }
    if (s === WRITE_SQL.guard) {
      const [state, occurredAt, eventId, channel, destination, scope] = p;
      const r = W.states.find((x) => x.channel === channel && lc(x.destination) === lc(destination) && x.scope === scope);
      if (r && (T(r.occurred_at) < T(occurredAt) || (T(r.occurred_at) === T(occurredAt) && r.last_event_id < eventId))) {
        Object.assign(r, { state, occurred_at: occurredAt, last_event_id: eventId });
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }
    // The plain read and its two LOCKING forms (FOR SHARE decides a row's
    // flag, FOR UPDATE re-reads after the upsert) read the same store here;
    // tests/consentCore.mysql.test.js holds the locking semantics to MySQL.
    if (s === WRITE_SQL.read || s === WRITE_SQL.share || s === WRITE_SQL.lock) {
      W.locks.push(s === WRITE_SQL.read ? 'state:plain' : s === WRITE_SQL.share ? 'state:share' : 'state:update');
      const [channel, destination, scope] = p;
      const r = W.states.find((x) => x.channel === channel && lc(x.destination) === lc(destination) && x.scope === scope);
      return [r ? [{ state: r.state, last_event_id: r.last_event_id }] : []];
    }
    if (s === WRITE_SQL.active.sms || s === WRITE_SQL.active.email) {
      W.locks.push('row:active');
      const f = fam(s === WRITE_SQL.active.sms ? 'contact_phones' : 'contact_emails');
      return [f.rows.filter((r) => r.end_date == null && f.key(r[f.col]) === f.key(p[0])).map((r) => ({ id: r.id }))];
    }
    if (s === WRITE_SQL.row.sms || s === WRITE_SQL.row.email) {
      W.locks.push('row:id');
      const f = fam(s === WRITE_SQL.row.sms ? 'contact_phones' : 'contact_emails');
      const r = byId(f.rows, p[0]);
      return [r ? [{ id: r.id, destination: r[f.col], flag: r[f.flag], end_date: r.end_date }] : []];
    }
    if (s === WRITE_SQL.cache.sms || s === WRITE_SQL.cache.email) {
      W.locks.push('cache:index');
      const f = fam(s === WRITE_SQL.cache.sms ? 'contact_phones' : 'contact_emails');
      const [val, dest] = p;
      let n = 0;
      for (const r of f.rows) if (r.end_date == null && f.key(r[f.col]) === f.key(dest) && Number(r[f.flag]) !== val) { r[f.flag] = val; n++; }
      return [{ affectedRows: n }];
    }
    if (s === WRITE_SQL.cacheRow.sms || s === WRITE_SQL.cacheRow.email) {
      W.locks.push('cache:row');
      const f = fam(s === WRITE_SQL.cacheRow.sms ? 'contact_phones' : 'contact_emails');
      const [val, id] = p;
      const r = byId(f.rows, id);
      if (!r || r.end_date != null || Number(r[f.flag]) === Number(val)) return [{ affectedRows: 0 }];
      r[f.flag] = Number(val);
      return [{ affectedRows: 1 }];
    }
    if (s === WRITE_SQL.rowFlag.sms || s === WRITE_SQL.rowFlag.email) {
      const f = fam(s === WRITE_SQL.rowFlag.sms ? 'contact_phones' : 'contact_emails');
      const [val, id] = p;
      const r = byId(f.rows, id);
      if (!r || Number(r[f.flag]) === Number(val)) return [{ affectedRows: 0 }];
      r[f.flag] = Number(val);
      return [{ affectedRows: 1 }];
    }
    return answerOptout(s, p, { phones: W.phones, emails: W.emails, contacts: W.contacts, states: W.states, topics: W.topics });
  }

  async function query(sql, p = []) {
    const s = norm(sql);
    W.seen.push(s);
    const c = consent(s, p);
    if (c) return c;
    let m;

    // ── contacts ──
    if (s === 'SELECT contact_id FROM contacts WHERE contact_id = ?') return [contact(p[0]) ? [{ contact_id: Number(p[0]) }] : []];
    if ((m = /^SELECT (contact_phone|contact_email) FROM contacts WHERE contact_id = \?$/.exec(s))) {
      const ct = contact(p[0]); return [ct ? [{ [m[1]]: ct[m[1]] }] : []];
    }
    if ((m = /^UPDATE contacts SET (contact_phone|contact_email) = \? WHERE contact_id = \?$/.exec(s))) {
      const ct = contact(p[1]); if (ct) ct[m[1]] = p[0]; return [{ affectedRows: ct ? 1 : 0 }];
    }
    if (/^INSERT INTO contacts /.test(s)) {
      const id = nextContact++;
      W.contacts.push({ contact_id: id, contact_name: `${p[2]} ${p[4]}`, contact_phone: p[6], contact_email: p[7] });
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (s === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?') {
      const ct = contact(p[0]); return [ct ? [{ contact_id: ct.contact_id, contact_name: ct.contact_name }] : []];
    }
    if ((m = /^SELECT (`[a-z_]+`(?:, `[a-z_]+`)*) FROM contacts WHERE contact_id = \?$/.exec(s))) {
      const ct = contact(p[0]); if (!ct) return [[]];
      const row = {}; for (const col of m[1].split(', ').map((x) => x.replace(/`/g, ''))) row[col] = ct[col] === undefined ? null : ct[col];
      return [[row]];
    }
    if ((m = /^UPDATE contacts SET (.*), contact_updated = NOW\(\) WHERE contact_id = \?$/.exec(s))) {
      const ct = contact(p[p.length - 1]); if (!ct) return [{ affectedRows: 0 }];
      m[1].split(', ').forEach((clause, i) => { const col = /^`([a-z_]+)` = \?$/.exec(clause); if (col) ct[col[1]] = p[i]; });
      return [{ affectedRows: 1 }];
    }
    if (s === 'SELECT * FROM contacts WHERE contact_id = ?') { const ct = contact(p[0]); return [ct ? [{ ...ct }] : []]; }

    // ── update_db / insert_db (lib/internal_functions/db.js) on the two row
    //    tables — backticked identifiers, a WHERE on `id` only. ──
    if (/FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \?$/.test(s) && /^contact_(phones|emails)$/.test(p[0])) {
      const f = fam(p[0]);
      const base = ['contact_id', f.col, 'label', 'is_primary', f.flag, 'verified', 'start_date', 'end_date', 'end_reason', 'notes'];
      return [[{ COLUMN_NAME: 'id', COLUMN_KEY: 'PRI', EXTRA: 'auto_increment', COLUMN_DEFAULT: null, GENERATION_EXPRESSION: '' },
        ...base.map((c) => ({ COLUMN_NAME: c, COLUMN_KEY: '', EXTRA: '', COLUMN_DEFAULT: null, GENERATION_EXPRESSION: '' })),
        { COLUMN_NAME: `${f.col}_active_uniq`, COLUMN_KEY: 'UNI', EXTRA: 'VIRTUAL GENERATED', COLUMN_DEFAULT: null, GENERATION_EXPRESSION: 'if((`end_date` is null),`x`,NULL)' }]];
    }
    if ((m = /^SELECT (COUNT\(\*\) AS n|id) FROM `(contact_phones|contact_emails)` WHERE `id` = \?( FOR UPDATE)?$/.exec(s))) {
      const r = byId(fam(m[2]).rows, p[0]);
      if (m[3]) W.locks.push('row:generic');
      return [m[1] === 'id' ? (r ? [{ id: r.id }] : []) : [{ n: r ? 1 : 0 }]];
    }
    if ((m = /^UPDATE `(contact_phones|contact_emails)` SET ((?:`[a-z_]+` = \?(?:, )?)+) WHERE `id` = \? LIMIT \d+$/.exec(s))) {
      const r = byId(fam(m[1]).rows, p[p.length - 1]);
      if (!r) return [{ affectedRows: 0, changedRows: 0 }];
      [...m[2].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]).forEach((c, i) => { r[c] = p[i]; });
      return [{ affectedRows: 1, changedRows: 1 }];
    }
    if ((m = /^INSERT INTO `(contact_phones|contact_emails)` \(((?:`[a-z_]+`(?:, )?)+)\) VALUES \([?, ]+\)$/.exec(s))) {
      const f = fam(m[1]);
      const row = { id: nextRow++ };
      [...m[2].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]).forEach((c, i) => { row[c] = p[i]; });
      f.rows.push({ is_primary: 0, [f.flag]: 0, verified: 0, label: 'Other', start_date: null, end_date: null, end_reason: null, notes: '',
        ...(m[1] === 'contact_phones' ? { mms_capable: 1 } : {}), ...row, contact_id: Number(row.contact_id) });
      return [{ insertId: row.id, affectedRows: 1 }];
    }

    // ── contact_phones / contact_emails ──
    const tm = /(contact_phones|contact_emails)/.exec(s);
    if (tm) {
      const table = tm[1]; const f = fam(table); const R = f.rows; const col = f.col;
      const A = table === 'contact_phones' ? 'cp' : 'ce';
      const nameOf = (r) => (contact(r.contact_id) || {}).contact_name || null;

      if (s === `SELECT id, ${col} FROM ${table} WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL LIMIT 1`) {
        const r = R.find((x) => x.contact_id === Number(p[0]) && x.is_primary === 1 && x.end_date == null); return [r ? [{ id: r.id, [col]: r[col] }] : []];
      }
      if (s === `SELECT ${col} FROM ${table} WHERE contact_id = ? AND is_primary = 1 AND end_date IS NULL LIMIT 1`) {
        const r = R.find((x) => x.contact_id === Number(p[0]) && x.is_primary === 1 && x.end_date == null); return [r ? [{ [col]: r[col] }] : []];
      }
      if (s === `SELECT id FROM ${table} WHERE contact_id = ? AND ${col} = ? AND end_date IS NULL LIMIT 1`) {
        const r = R.find((x) => x.contact_id === Number(p[0]) && f.key(x[col]) === f.key(p[1]) && x.end_date == null); return [r ? [{ id: r.id }] : []];
      }
      // The collision reads carry the donor's flag (donor_flag) — a transfer
      // carries it where the destination has no consent state yet.
      if (s === `SELECT ${A}.id, ${A}.contact_id, c.contact_name, ${A}.${f.flag} AS donor_flag FROM ${table} ${A} JOIN contacts c ON c.contact_id = ${A}.contact_id WHERE ${A}.${col} = ? AND ${A}.end_date IS NULL AND ${A}.contact_id <> ?`) {
        const r = R.find((x) => f.key(x[col]) === f.key(p[0]) && x.end_date == null && x.contact_id !== Number(p[1]));
        return [r ? [{ id: r.id, contact_id: r.contact_id, contact_name: nameOf(r), donor_flag: r[f.flag] }] : []];
      }
      if (s === `SELECT ${A}.id AS ${col}_id, ${A}.contact_id, c.contact_name, ${A}.${f.flag} AS donor_flag, DATE_FORMAT(${A}.start_date, '%Y-%m-%d') AS start_date FROM ${table} ${A} JOIN contacts c ON c.contact_id = ${A}.contact_id WHERE ${A}.${col} = ? AND ${A}.end_date IS NULL`) {
        const r = R.find((x) => f.key(x[col]) === f.key(p[0]) && x.end_date == null);
        return [r ? [{ [`${col}_id`]: r.id, contact_id: r.contact_id, contact_name: nameOf(r), donor_flag: r[f.flag], start_date: r.start_date }] : []];
      }
      if (s === `SELECT id, contact_id, ${f.flag} AS donor_flag FROM ${table} WHERE ${col} = ? AND end_date IS NULL`) {
        const r = R.find((x) => f.key(x[col]) === f.key(p[0]) && x.end_date == null); return [r ? [{ id: r.id, contact_id: r.contact_id, donor_flag: r[f.flag] }] : []];
      }
      if ((m = new RegExp(`^SELECT ${A}\\.id AS ${col}_id, ${A}\\.contact_id, ${A}\\.${col}, c\\.contact_name, ${A}\\.${f.flag} AS donor_flag FROM ${table} ${A} JOIN contacts c ON c\\.contact_id = ${A}\\.contact_id WHERE ${A}\\.${col} IN \\(([?, ]+)\\) AND ${A}\\.end_date IS NULL AND ${A}\\.contact_id <> \\?$`).exec(s))) {
        const vals = p.slice(0, -1).map(f.key); const cid = Number(p[p.length - 1]);
        return [R.filter((x) => vals.includes(f.key(x[col])) && x.end_date == null && x.contact_id !== cid)
          .map((x) => ({ [`${col}_id`]: x.id, contact_id: x.contact_id, [col]: x[col], contact_name: nameOf(x), donor_flag: x[f.flag] }))];
      }
      if (/^SELECT id, (phone|email), label, is_primary, .* FROM contact_(phones|emails) WHERE contact_id = \? AND end_date IS NULL$/.test(s)) {
        return [R.filter((x) => x.contact_id === Number(p[0]) && x.end_date == null).map((x) => ({ ...x }))];
      }
      if (s === `SELECT COUNT(*) AS cnt FROM ${table} WHERE contact_id = ?`) return [[{ cnt: R.filter((x) => x.contact_id === Number(p[0])).length }]];
      if (s.startsWith(`SELECT DATE_FORMAT(DATE_ADD(MAX(end_date), INTERVAL 1 DAY), '%Y-%m-%d') AS next_start FROM ${table}`)) {
        const ends = R.filter((x) => f.key(x[col]) === f.key(p[0]) && x.id !== (p[1] == null ? -1 : Number(p[1])) && x.end_date).map((x) => x.end_date).sort();
        if (!ends.length) return [[{ next_start: null }]];
        const d = new Date(`${ends[ends.length - 1]}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
        return [[{ next_start: d.toISOString().slice(0, 10) }]];
      }
      if (s === `SELECT * FROM ${table} WHERE id = ? FOR UPDATE`) { const r = byId(R, p[0]); return [r ? [{ ...r }] : []]; }
      if (new RegExp(`^SELECT ${A}\\.id, ${A}\\.contact_id, ${A}\\.${col}, .* FROM ${table} ${A} LEFT JOIN users uc .* WHERE ${A}\\.contact_id = \\?( AND ${A}\\.end_date IS NULL)? ORDER BY .*$`).test(s)) {
        const activeOnly = / AND (cp|ce)\.end_date IS NULL ORDER/.test(s);
        return [R.filter((x) => x.contact_id === Number(p[0]) && (!activeOnly || x.end_date == null)).sort((a, b) => a.id - b.id).map((x) => ({ ...x }))];
      }
      if (new RegExp(`^SELECT ${A}\\.id, ${A}\\.contact_id, ${A}\\.${col}, .* FROM ${table} ${A} LEFT JOIN users uc .* WHERE ${A}\\.id = \\?$`).test(s)) {
        const r = byId(R, p[0]); return [r ? [{ ...r }] : []];
      }
      if ((m = new RegExp(`^INSERT INTO ${table} \\(([a-z_, ]+)\\) VALUES \\(([?, 1]+)\\)$`).exec(s))) {
        const cols = m[1].split(', ');
        const vals = m[2].split(', ');
        const row = { id: nextRow++ };
        let pi = 0;
        cols.forEach((cname, i) => { row[cname] = vals[i] === '?' ? p[pi++] : Number(vals[i]); });
        if (R.some((x) => x.end_date == null && f.key(x[col]) === f.key(row[col]))) {
          const e = new Error('Duplicate entry for key uk_active'); e.code = 'ER_DUP_ENTRY'; throw e;
        }
        R.push({ is_primary: 0, [f.flag]: 0, mms_capable: 1, verified: 0, label: table === 'contact_phones' ? 'Other' : 'Other',
          start_date: null, end_date: null, end_reason: null, notes: '', ...row, contact_id: Number(row.contact_id) });
        return [{ insertId: row.id, affectedRows: 1 }];
      }
      if (s === `UPDATE ${table} SET end_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY), is_primary = 0, end_reason = 'transferred', updated_by = ? WHERE id = ?`) {
        const r = byId(R, p[1]); Object.assign(r, { end_date: yesterday(), is_primary: 0, end_reason: 'transferred' }); return [{ affectedRows: 1 }];
      }
      if ((m = new RegExp(`^UPDATE ${table} SET end_date = CURDATE\\(\\), is_primary = 0, end_reason = '(ended|replaced)', updated_by = \\? WHERE id = \\?$`).exec(s))) {
        const r = byId(R, p[1]); Object.assign(r, { end_date: today(), is_primary: 0, end_reason: m[1] }); return [{ affectedRows: 1 }];
      }
      if ((m = new RegExp(`^UPDATE ${table} SET is_primary = ([01]), updated_by = \\? WHERE id = \\?$`).exec(s))) {
        const r = byId(R, p[1]); r.is_primary = Number(m[1]); return [{ affectedRows: 1 }];
      }
      if (new RegExp(`^UPDATE ${table} SET is_primary = 0, updated_by = \\? WHERE contact_id = \\? AND is_primary = 1 AND end_date IS NULL( AND id <> \\?)?$`).test(s)) {
        for (const r of R) if (r.contact_id === Number(p[1]) && r.is_primary === 1 && r.end_date == null && (p[2] === undefined || r.id !== Number(p[2]))) r.is_primary = 0;
        return [{ affectedRows: 1 }];
      }
      if ((m = new RegExp(`^UPDATE ${table} SET ((?:\`[a-z_]+\` = \\?(?:, )?)+) WHERE id = \\?$`).exec(s))) {
        const r = byId(R, p[p.length - 1]);
        const cols = [...m[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]);
        cols.forEach((cname, i) => { r[cname] = p[i]; });
        if (r.end_date == null && R.some((x) => x !== r && x.end_date == null && f.key(x[col]) === f.key(r[col]))) {
          const e = new Error('Duplicate entry for key uk_active'); e.code = 'ER_DUP_ENTRY'; throw e;
        }
        return [{ affectedRows: 1 }];
      }
      W.unhandled.push(s);
      return /^SELECT/.test(s) ? [[]] : [{ affectedRows: 0, insertId: 0 }];
    }
    if (/comm_consent|comm_topics/.test(s)) { W.unhandled.push(s); return /^SELECT/.test(s) ? [[]] : [{ affectedRows: 0 }]; }

    // Everything else (field defs, settings, domain events, audit): empty.
    return /^\s*SELECT/i.test(s) ? [[]] : [{ affectedRows: 0, insertId: 0 }];
  }

  W.db = { query, withTransaction: async (fn) => fn({ query }) };
  W.phone = (id) => byId(W.phones, id);
  W.email = (id) => byId(W.emails, id);
  W.active = (table, value) => fam(table).rows.find((r) => r.end_date == null && fam(table).key(r[fam(table).col]) === fam(table).key(value));
  W.state = (channel, destination, scope) => W.states.find((r) => r.channel === channel && lc(r.destination) === lc(destination) && r.scope === scope) || null;
  return W;
}

module.exports = { makeWorld, FIND_SQL };
