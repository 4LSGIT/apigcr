'use strict';

/**
 * Entity-scoped communications for contact/case pages.
 *
 * The source stores are authoritative: mail_messages for email and
 * phone_event_log for texts/calls. `log` is used as the case-association
 * bridge and only supplies a legacy/manual fallback when no source row points
 * at that log row. Interactive channel grants are always resolved through
 * mailboxService; a log row must never become a way around a mailbox/line
 * grant.
 */

const mbx = require('./mailboxService');
const mailRead = require('./mailbox/mailReadService');
const logService = require('./logService');
const archiveView = require('./commsArchiveView');
const { inferDirection, firmDomains } = require('./emailIngestService');
const { utcToLocal, localToUTC } = require('./timezoneService');

const KINDS = new Set(['all', 'direct', 'email', 'phone', 'sms', 'call', 'court']);
const DIRECTIONS = new Set(['incoming', 'outgoing']);
const COMM_LOG_TYPES = new Set(['email', 'sms', 'call', 'court email']);
const LIMIT_DEFAULT = 30;
const LIMIT_MAX = 100;
const Q_MAX = 200;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseQuery(query = {}) {
  const kind = String(query.kind || 'all').trim().toLowerCase();
  if (!KINDS.has(kind)) throw httpError(400, 'kind must be all, direct, email, phone, sms, call, or court');
  const direction = query.direction == null || query.direction === ''
    ? null : String(query.direction).trim().toLowerCase();
  if (direction != null && !DIRECTIONS.has(direction)) {
    throw httpError(400, 'direction must be incoming or outgoing');
  }
  const q = query.q == null ? '' : String(query.q).trim();
  if (q.length > Q_MAX) throw httpError(400, `q must be at most ${Q_MAX} characters`);
  const rawLimit = query.limit == null || query.limit === '' ? LIMIT_DEFAULT : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) throw httpError(400, 'limit must be a positive integer');
  const rawOffset = query.offset == null || query.offset === '' ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) throw httpError(400, 'offset must be a non-negative integer');
  const includeContacts = query.include_contacts === true || query.include_contacts === 1
    || query.include_contacts === '1' || query.include_contacts === 'true';
  if (query.include_contacts != null && query.include_contacts !== '' && !includeContacts
      && ![false, 0, '0', 'false'].includes(query.include_contacts)) {
    throw httpError(400, 'include_contacts must be true or false');
  }
  return { kind, direction, q, qLower: q.toLowerCase(), limit: Math.min(rawLimit, LIMIT_MAX), offset: rawOffset, includeContacts };
}

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(v) {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

function emailsIn(value) {
  const found = String(value == null ? '' : value)
    .match(/[^\s<>,;:"()[\]\\]+@[^\s<>,;:"()[\]\\]+\.[^\s<>,;:"()[\]\\]+/g) || [];
  return [...new Set(found.map(x => x.toLowerCase()))];
}

function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

/** Inclusive ownership dates, evaluated in the firm's local calendar. */
function dateInWindow(at, row) {
  const d = toDate(at);
  if (!d) return false;
  const day = utcToLocal(d).toISODate();
  const start = row.start_date == null ? null : String(row.start_date).slice(0, 10);
  const end = row.end_date == null ? null : String(row.end_date).slice(0, 10);
  return (!start || start <= day) && (!end || end >= day);
}

function aliasAdmits(alias, row) {
  return mailRead.sliceMatchJs(alias, row);
}

function participantEmails(row) {
  return [
    mailRead.senderOf(row.from_addr),
    ...mailRead.addressList(row.to_addrs).map(x => x.email),
    ...mailRead.addressList(row.cc_addrs).map(x => x.email),
  ].filter(Boolean);
}

function attachmentCount(v) {
  const a = parseJson(v, []);
  return Array.isArray(a) ? a.filter(x => x && !x.cid).length : 0;
}

function normalizeLogKind(type) {
  return type === 'court email' ? 'court' : type;
}

function itemMatches(item, f) {
  if (f.kind === 'phone' && item.kind !== 'sms' && item.kind !== 'call') return false;
  if (f.kind === 'direct' && !['email', 'sms', 'call'].includes(item.kind)) return false;
  if (!['all', 'phone', 'direct'].includes(f.kind) && item.kind !== f.kind) return false;
  if (f.direction && item.direction !== f.direction) return false;
  if (!f.qLower) return true;
  return JSON.stringify(item).toLowerCase().includes(f.qLower);
}

function dedupeMail(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.message_id ? `mid:${String(row.message_id).toLowerCase()}` : `id:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([dedupe_key, copies]) => {
    const primary = copies.find(x => x.log_id != null) || copies[0];
    return { ...primary, dedupe_key, copies };
  });
}

async function loadEntity(db, type, id) {
  if (type === 'contact') {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) throw httpError(400, 'contact id must be a positive integer');
    const [[row]] = await db.query('SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1', [n]);
    if (!row) throw httpError(404, 'Contact not found');
    return { type, id: Number(row.contact_id), name: row.contact_name || null };
  }
  const key = String(id == null ? '' : id).trim();
  if (!key || key.length > 20) throw httpError(400, 'case id is required');
  const [[row]] = await db.query(
    'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1', [key]);
  if (!row) throw httpError(404, 'Case not found');
  return { type, id: String(row.case_id), case_number: row.case_number_full || row.case_number || null,
    identifiers: [row.case_id, row.case_number, row.case_number_full].filter(v => v != null && String(v) !== '').map(String) };
}

async function contactIdentities(db, contactId) {
  const [emails] = await db.query(
    'SELECT email, start_date, end_date FROM contact_emails WHERE contact_id = ?', [contactId]);
  const [phones] = await db.query(
    'SELECT phone, start_date, end_date FROM contact_phones WHERE contact_id = ?', [contactId]);
  return {
    emails: emails.map(r => ({ ...r, email: String(r.email || '').toLowerCase() })),
    phones: phones.map(r => ({ ...r, phone: String(r.phone || '') })),
  };
}

async function relatedCaseContacts(db, caseId) {
  const [rows] = await db.query(
    `SELECT c.contact_id, c.contact_name, c.contact_phone, c.contact_email,
            cr.case_relate_type AS relate_type
       FROM case_relate cr
       JOIN contacts c ON c.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ?
      ORDER BY FIELD(cr.case_relate_type, 'Primary','Secondary','Other','Bystander'), c.contact_name`,
    [caseId]
  );
  return rows.map(r => ({
    contact_id: Number(r.contact_id), contact_name: r.contact_name || null,
    contact_phone: r.contact_phone || null, contact_email: r.contact_email || null,
    relate_type: r.relate_type || null,
  }));
}

async function identitiesForContacts(db, contacts) {
  const identities = { emails: [], phones: [] };
  for (const contact of contacts) {
    const one = await contactIdentities(db, contact.contact_id);
    const stamp = { contact_id: contact.contact_id, contact_name: contact.contact_name };
    identities.emails.push(...one.emails.map(x => ({ ...x, ...stamp })));
    identities.phones.push(...one.phones.map(x => ({ ...x, ...stamp })));
  }
  return identities;
}

async function caseLogs(db, entity) {
  const ids = entity.identifiers;
  const ph = ids.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT l.log_id, l.log_type, l.log_date, l.log_direction, l.log_link_type, l.log_link_id,
            l.log_about_type, l.log_about_id, l.log_from, l.log_to, l.log_subject, l.log_message,
            l.log_data, l.log_extra
       FROM log l
      WHERE (l.log_link_type = 'case' AND l.log_link_id IN (${ph}))
         OR (l.log_link_type IS NULL AND l.log_link IN (${ph}))
         OR (l.log_about_type = 'case' AND l.log_about_id IN (${ph}))`,
    [...ids, ...ids, ...ids]
  );
  return rows;
}

async function contactLogs(db, contactId) {
  const w = logService._buildContactLogWhere(contactId);
  const [rows] = await db.query(
    `SELECT l.log_id, l.log_type, l.log_date, l.log_direction, l.log_link_type, l.log_link_id,
            l.log_about_type, l.log_about_id, l.log_from, l.log_to, l.log_subject, l.log_message,
            l.log_data, l.log_extra
       FROM log l WHERE ${w.whereFragment}`,
    w.params
  );
  return rows;
}

async function mailAssociationKeys(db, entity, logs) {
  if (entity.type !== 'case') return { logIds: new Set(), messageKeys: new Set(), sendKeys: new Set() };
  const logIds = new Set(logs.map(r => Number(r.log_id)));
  const messageKeys = new Set();
  if (logIds.size) {
    const [linked] = await db.query(
      'SELECT message_id, provider_id FROM mail_messages WHERE log_id IN (?)', [[...logIds]]);
    for (const r of linked) {
      if (r.message_id) messageKeys.add(String(r.message_id).toLowerCase());
      if (r.provider_id) messageKeys.add(String(r.provider_id).toLowerCase());
    }
    const [execs] = await db.query(
      'SELECT message_id FROM email_ingest_executions WHERE log_id IN (?)', [[...logIds]]);
    for (const r of execs) if (r.message_id) messageKeys.add(String(r.message_id).replace(/^<|>$/g, '').toLowerCase());
  }
  const [sends] = await db.query(
    'SELECT message_id, provider_id FROM mail_sends WHERE case_id = ?', [entity.id]);
  const sendKeys = new Set();
  for (const r of sends) for (const v of [r.message_id, r.provider_id]) if (v) sendKeys.add(String(v).toLowerCase());
  return { logIds, messageKeys, sendKeys };
}

async function loadMail(db, userId, entity, identities, assoc) {
  const readable = await mbx.listReadable(db, userId, 'mailbox');
  const direct = new Map(readable.filter(r => r.alias_of == null).map(r => [Number(r.id), r]));
  const aliases = readable.filter(r => r.alias_of != null).sort((a, b) => Number(a.id) - Number(b.id));
  const aliasParents = new Set(aliases.map(r => Number(r.alias_of)));
  const storageIds = [...new Set([...direct.keys(), ...aliasParents])];
  if (!storageIds.length) return [];
  const [rows] = await db.query(
    `SELECT m.id, m.mailbox_id, m.folder, m.gmail_labels, m.message_id, m.provider_id, m.thread_key,
            m.from_addr, m.to_addrs, m.cc_addrs, m.subject, m.date, m.ingested_at, m.snippet,
            m.attachments, m.log_id, (rs.message_fk IS NULL) AS unread
       FROM mail_messages m
       LEFT JOIN mail_read_state rs ON rs.user = ? AND rs.message_fk = m.id
      WHERE m.mailbox_id IN (?)`,
    [Number(userId), storageIds]
  );
  const visible = [];
  for (const r of rows) {
    let box = direct.get(Number(r.mailbox_id)) || null;
    if (!box) box = aliases.find(a => Number(a.alias_of) === Number(r.mailbox_id) && aliasAdmits(a, r)) || null;
    if (!box) continue;
    r.visible_mailbox_id = Number(box.id);
    r.mailbox_address = box.address || null;
    const at = r.date || r.ingested_at;
    if (entity.type === 'contact') {
      const participants = new Set(participantEmails(r));
      const owner = identities.emails.find(e => participants.has(e.email) && dateInWindow(at, e));
      if (!owner) continue;
      r.entity_contact = owner.contact_id == null ? null
        : { contact_id: Number(owner.contact_id), contact_name: owner.contact_name || null };
    } else {
      const keys = [r.message_id, r.provider_id].filter(Boolean).map(v => String(v).toLowerCase());
      if (!(r.log_id != null && assoc.logIds.has(Number(r.log_id)))
          && !keys.some(k => assoc.messageKeys.has(k) || assoc.sendKeys.has(k))) continue;
    }
    visible.push(r);
  }
  return dedupeMail(visible).map((r) => {
    const from = mailRead.senderOf(r.from_addr);
    const tos = mailRead.addressList(r.to_addrs).map(x => x.email);
    const direction = inferDirection(from || '', firmDomains());
    const participant = direction === 'incoming' ? from : (tos[0] || null);
    const copies = r.copies || [r];
    return {
      key: `email:${r.dedupe_key}`,
      id: Number(r.id),
      kind: 'email',
      at: iso(r.date || r.ingested_at),
      direction,
      participant,
      preview: r.snippet == null ? '' : String(r.snippet),
      log_id: r.log_id == null ? null : Number(r.log_id),
      legacy: false,
      contact: r.entity_contact || null,
      attachment_count: Math.max(...copies.map(x => attachmentCount(x.attachments)), 0),
      email: {
        id: Number(r.id), mailbox_id: Number(r.visible_mailbox_id), mailbox_address: r.mailbox_address,
        thread_key: r.thread_key || null, message_id: r.message_id || null,
        subject: r.subject == null ? null : String(r.subject), from: r.from_addr || null,
        to: r.to_addrs || null, cc: r.cc_addrs || null,
        attachment_count: Math.max(...copies.map(x => attachmentCount(x.attachments)), 0),
        unread: copies.some(x => !!Number(x.unread)),
      },
    };
  });
}

function phoneFields(r) {
  const raw = parseJson(r.raw_extra, {}) || {};
  const start = toDate(raw.started_at);
  const end = toDate(raw.ended_at);
  const duration = start && end && end >= start ? Math.round((end - start) / 1000) : null;
  const status = raw.provider_status == null ? null : String(raw.provider_status);
  const missed = r.direction === 'incoming' && status != null && ['no-answer', 'missed'].includes(status.toLowerCase());
  return { raw, start, duration, status, missed };
}

async function loadPhone(db, userId, entity, identities, assoc) {
  const lines = await mbx.listReadable(db, userId, 'phone_line');
  const lineByNumber = new Map(lines.filter(x => x.phone_number).map(x => [String(x.phone_number), x]));
  if (!lineByNumber.size) return [];
  const [rows] = await db.query(
    `SELECT id, event_type, direction, body, processed_at, other_party, line_number, raw_extra, log_id
       FROM phone_event_log
      WHERE line_number IN (?) AND suppressed = 0`,
    [[...lineByNumber.keys()]]
  );
  const out = [];
  for (const r of rows) {
    if (entity.type === 'contact') {
      const owner = identities.phones.find(p => p.phone === String(r.other_party || '') && dateInWindow(r.processed_at, p));
      if (!owner) continue;
      r.entity_contact = owner.contact_id == null ? null
        : { contact_id: Number(owner.contact_id), contact_name: owner.contact_name || null };
    } else if (r.log_id == null || !assoc.logIds.has(Number(r.log_id))) continue;
    const line = lineByNumber.get(String(r.line_number));
    if (!line) continue;
    const f = phoneFields(r);
    const kind = r.event_type === 'call' ? 'call' : 'sms';
    out.push({
      key: `phone:${r.id}`,
      id: Number(r.id),
      kind,
      at: iso(kind === 'call' ? (f.start || r.processed_at) : (f.raw.ts || r.processed_at)),
      sort_at: iso(r.processed_at),
      direction: DIRECTIONS.has(r.direction) ? r.direction : null,
      participant: r.other_party == null ? null : String(r.other_party),
      preview: kind === 'sms' ? String(r.body || '') : [f.status, f.duration == null ? null : `${f.duration}s`].filter(Boolean).join(' · '),
      log_id: r.log_id == null ? null : Number(r.log_id),
      legacy: false,
      contact: r.entity_contact || null,
      line_id: Number(line.id),
      duration_s: f.duration,
      call_status: f.status,
      phone: {
        event_id: Number(r.id), line_id: Number(line.id), line_number: String(r.line_number),
        body: kind === 'sms' ? String(r.body || '') : null,
        duration_s: f.duration, status: f.status, missed: f.missed,
      },
    });
  }
  return out;
}

function legacyItem(r) {
  const kind = normalizeLogKind(r.log_type);
  const direction = DIRECTIONS.has(r.log_direction) ? r.log_direction : null;
  const from = r.log_from || null;
  const to = r.log_to || null;
  return {
    key: `log:${r.log_id}`,
    id: Number(r.log_id),
    kind,
    // log_date is a firm-local wall clock read by mysql2 as if UTC.
    at: iso(localToUTC(r.log_date)),
    direction,
    participant: direction === 'incoming' ? from : (to || r.log_link_id || null),
    preview: String(r.log_message || ''),
    log_id: Number(r.log_id),
    legacy: true,
    contact: r.entity_contact || null,
    case_id: r.log_about_type === 'case' ? String(r.log_about_id) : null,
    log: {
      type: r.log_type, from, to, subject: r.log_subject || null,
      message: r.log_message == null ? null : String(r.log_message),
      data: parseJson(r.log_data, {}),
    },
  };
}

async function list(db, auth, type, id, query = {}) {
  const userId = auth && auth.userId;
  if (userId == null) throw httpError(403, 'Communications require a signed-in user');
  if (type !== 'contact' && type !== 'case') throw httpError(400, 'entity type must be contact or case');
  const filters = parseQuery(query);
  const entity = await loadEntity(db, type, id);
  const includeContacts = entity.type === 'case' && filters.includeContacts;
  const contacts = includeContacts ? await relatedCaseContacts(db, entity.id) : [];
  const identities = entity.type === 'contact'
    ? await contactIdentities(db, entity.id)
    : includeContacts ? await identitiesForContacts(db, contacts) : { emails: [], phones: [] };
  const directLogs = entity.type === 'case' ? await caseLogs(db, entity) : await contactLogs(db, entity.id);
  const relatedLogs = [];
  if (includeContacts) {
    for (const contact of contacts) {
      const rows = await contactLogs(db, contact.contact_id);
      relatedLogs.push(...rows.map(r => ({ ...r, entity_contact: {
        contact_id: contact.contact_id, contact_name: contact.contact_name,
      } })));
    }
  }
  const logsById = new Map();
  for (const row of [...directLogs, ...relatedLogs]) {
    const key = Number(row.log_id);
    if (!logsById.has(key)) logsById.set(key, row);
  }
  const logs = [...logsById.values()];
  const assoc = await mailAssociationKeys(db, entity, directLogs);
  const [baseMail, basePhone, contactMail, contactPhone] = await Promise.all([
    loadMail(db, userId, entity, entity.type === 'contact' ? identities : { emails: [], phones: [] }, assoc),
    loadPhone(db, userId, entity, entity.type === 'contact' ? identities : { emails: [], phones: [] }, assoc),
    includeContacts ? loadMail(db, userId, { type: 'contact' }, identities, assoc) : [],
    includeContacts ? loadPhone(db, userId, { type: 'contact' }, identities, assoc) : [],
  ]);
  if (entity.type === 'case') {
    for (const item of [...baseMail, ...basePhone]) item.case_id = entity.id;
  }
  const mergeItems = (base, expanded) => {
    const byKey = new Map(base.map(item => [item.key, item]));
    for (const item of expanded) {
      const prior = byKey.get(item.key);
      if (prior) {
        if (!prior.contact && item.contact) prior.contact = item.contact;
      } else byKey.set(item.key, item);
    }
    return [...byKey.values()];
  };
  const mail = mergeItems(baseMail, contactMail);
  const phone = mergeItems(basePhone, contactPhone);
  // Court correspondence is ordinary mailbox data with a deliberately
  // stronger presentation category.  Keep mailbox permissions authoritative,
  // then classify the already-readable source row from its curated log link.
  const courtLogIds = new Set(logs
    .filter(r => r.log_type === 'court email')
    .map(r => Number(r.log_id)));
  const caseByLogId = new Map(logs
    .filter(r => r.log_about_type === 'case' && r.log_about_id != null)
    .map(r => [Number(r.log_id), String(r.log_about_id)]));
  for (const item of [...mail, ...phone]) {
    if (item.case_id == null && item.log_id != null && caseByLogId.has(Number(item.log_id))) {
      item.case_id = caseByLogId.get(Number(item.log_id));
    }
  }
  for (const item of mail) {
    if (item.log_id != null && courtLogIds.has(Number(item.log_id))) item.kind = 'court';
  }
  // Suppress a fallback whenever the log has a source row anywhere, including
  // in a channel the caller cannot read. Otherwise the broad legacy log would
  // become a side door around channel grants.
  const logIds = logs.map(r => Number(r.log_id));
  const sourceLogIds = new Set();
  if (logIds.length) {
    const [mailSources] = await db.query('SELECT DISTINCT log_id FROM mail_messages WHERE log_id IN (?)', [logIds]);
    const [phoneSources] = await db.query('SELECT DISTINCT log_id FROM phone_event_log WHERE log_id IN (?)', [logIds]);
    for (const r of [...mailSources, ...phoneSources]) if (r.log_id != null) sourceLogIds.add(Number(r.log_id));

    // Store-only mailbox copies are not always stamped: the parallel ingest
    // source can own the log row. Match that bridge by its provider/RFC id so
    // the same email is not returned once from mail_messages and again as a
    // legacy log fallback (also closes the unreadable-mailbox side door).
    const keyed = new Map();
    for (const r of logs) {
      const x = parseJson(r.log_extra, {}) || {};
      const raw = x.message_id == null ? '' : String(x.message_id);
      const key = raw.replace(/^<|>$/g, '').toLowerCase();
      if (key) {
        if (!keyed.has(key)) keyed.set(key, []);
        keyed.get(key).push(Number(r.log_id));
      }
    }
    if (keyed.size) {
      const keys = [...keyed.keys()];
      const [stored] = await db.query(
        'SELECT DISTINCT message_id, provider_id FROM mail_messages WHERE message_id IN (?) OR provider_id IN (?)',
        [keys, keys]
      );
      for (const r of stored) {
        for (const v of [r.message_id, r.provider_id]) {
          const k = v == null ? '' : String(v).replace(/^<|>$/g, '').toLowerCase();
          for (const logId of keyed.get(k) || []) sourceLogIds.add(logId);
        }
      }
    }
  }
  const legacy = logs
    .filter(r => COMM_LOG_TYPES.has(r.log_type) && !sourceLogIds.has(Number(r.log_id)))
    .map(legacyItem);
  const all = [...mail, ...phone, ...legacy]
    .filter(x => itemMatches(x, filters))
    .sort((a, b) => {
      const am = toDate(a.sort_at || a.at)?.getTime() || 0;
      const bm = toDate(b.sort_at || b.at)?.getTime() || 0;
      return bm - am || String(b.key).localeCompare(String(a.key));
    });
  const page = all.slice(filters.offset, filters.offset + filters.limit);
  // Archive decoration is deliberately after both grant scoping and the page
  // cut. It is conversation-oriented, so group by party; this prevents an RC
  // voicemail for one contact being matched to another party's call.
  const phoneGroups = new Map();
  for (const item of page) {
    if (item.kind !== 'sms' && item.kind !== 'call' || item.legacy) continue;
    const party = String(item.participant || '');
    if (!phoneGroups.has(party)) phoneGroups.set(party, []);
    phoneGroups.get(party).push(item);
  }
  for (const [other_party, messages] of phoneGroups) {
    await archiveView.decorate(db, auth, { other_party, messages });
  }
  const hasMore = filters.offset + page.length < all.length;
  return {
    entity: { type: entity.type, id: entity.id },
    include_contacts: includeContacts,
    contacts: includeContacts ? contacts : undefined,
    items: page,
    next_offset: hasMore ? filters.offset + page.length : null,
    has_more: hasMore,
  };
}

module.exports = {
  list,
  parseQuery,
  emailsIn,
  aliasAdmits,
  participantEmails,
  dateInWindow,
  dedupeMail,
  normalizeLogKind,
  itemMatches,
  httpError,
  LIMIT_MAX,
};
