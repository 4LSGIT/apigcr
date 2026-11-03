// routes/api.consent.js
//
/**
 * Staff consent surfaces (YisraMail P4, ref/YISRAMAIL_DESIGN.md §4.7 "As built").
 *
 * GET  /api/consent/history?channel=&destination=[&limit=]  one destination's ledger, newest first
 * GET  /api/consent/export?channel=&destination=            the same rows as a CSV (a proof request)
 * POST /api/consent/preview  { channel, contact_ids, class?, topic? }  what consent removes from a campaign selection
 * POST /api/consent/import   { channel, scope, rows, source } SU: a suppression list → opt_out events
 *
 * Gates. history / export / preview: jwtOrApiKey — the gate the contact
 * phone/email list routes (contact subrecords) and the campaign compose routes
 * use; a SCOPED API key reaches them only through its route scopes. import:
 * superuserOnlyFor('consent_import') — the `su` role + the step-up elevation
 * token + the per-tool rate limit; API keys are refused (403), and every
 * import writes an admin_audit_log row.
 *
 * Consent is read ONLY through optoutService (consentHistory, findOptedOut,
 * scopeState) and written ONLY through optoutService.recordConsent. Nothing
 * here touches a row flag (recordConsent syncs the cache itself).
 *
 * Sync bus: none of these is registered in public/js/yc-sync.js MATCHERS, on
 * purpose — three are reads, and the import writes DESTINATIONS (ledger +
 * state, plus recordConsent's cache sync) with no contact field diff to
 * announce. An open contact form repaints its consent badges from the list
 * routes on its next load / save (it fetches them, it never caches them).
 *
 * Auto-mounted by the routes loader (server.js readdirSync); no entry-point edits.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const { withTransaction } = require('../lib/withTransaction');
const optout = require('../services/optoutService');
const campaignService = require('../services/campaignService');

const IMPORT_TOOL = 'consent_import';
const MAX_IMPORT_ROWS = 5000;
const MAX_PREVIEW_IDS = 5000;
const NOTE_MAX = 1000;
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 500;      // the history route; the export reads up to optoutService's own cap
const EXPORT_MAX = 10000;

/**
 * What campaignService.executeSend asks findOptedOut (its consent step) is
 * campaignService.consentOptsFor(type, class, topic) — since C1 a campaign
 * has a class: SMS operational (scope 'all', D19) whatever the class;
 * marketing email scope 'marketing' + the topic; operational email asks
 * NOTHING (D18 — null). The preview asks through the SAME function;
 * tests/consentRoutes.test.js holds the two to agreement by spying on the
 * reader from both sides.
 */
const campaignConsent = (channel, klass, topic) => campaignService.consentOptsFor(channel, klass, topic);

class ConsentRouteError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ConsentRouteError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function readChannel(v) {
  return v === 'sms' || v === 'email' ? v : null;
}

/**
 * ONE destination → its stored key, or '' — normalizeDestination, plus: an
 * email value must hold exactly one address (normalizeDestination alone
 * accepts "a@x.com,b@y.com" as a single odd string, which would record a
 * destination no send ever matches).
 */
function oneDestination(channel, raw) {
  const dest = optout.normalizeDestination(channel, raw);
  if (!dest || channel !== 'email') return dest;
  const keys = optout.emailKeys(raw);
  return keys.length === 1 && keys[0] === dest ? dest : '';
}

/** channel + destination from a query string → { channel, destination } or a 400. */
function readDestination(q) {
  const channel = readChannel(q && q.channel);
  if (!channel) throw new ConsentRouteError(400, 'bad_channel', 'channel must be "sms" or "email"');
  const raw = q && typeof q.destination === 'string' ? q.destination : '';
  const destination = oneDestination(channel, raw);
  if (!destination) {
    throw new ConsentRouteError(400, 'bad_destination',
      channel === 'sms' ? 'destination must be a 10-digit US number' : 'destination must be one email address');
  }
  return { channel, destination };
}

function sendError(res, err, what) {
  if (err && err.name === 'ConsentRouteError') {
    return res.status(err.status).json({ status: 'error', code: err.code, message: err.message, ...err.extra });
  }
  console.error(`${what} error:`, err);
  return res.status(500).json({ status: 'error', message: 'Failed to read consent' });
}

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────

/**
 * One CSV field: always quoted, quotes doubled, and a value a spreadsheet
 * would run as a formula (leading = + - @, or a tab / CR that hides one) gets
 * a leading apostrophe — formula injection (CWE-1236) from a note, a keyword
 * or an inbound text body a stranger chose.
 */
function csvCell(v) {
  let s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = Object.freeze(['event_id', 'occurred_at_utc', 'channel', 'destination', 'scope', 'action', 'source',
  'actor', 'actor_user_id', 'contact_id', 'line_number', 'send_ref', 'evidence']);

function historyCsv(channel, destination, events) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const e of events) {
    lines.push([e.id, e.occurred_at, channel, destination, e.scope, e.action, e.source, e.actor, e.actor_user_id,
      e.contact_id, e.line_number, e.send_ref, e.evidence].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ─────────────────────────────────────────────────────────────
// Import (SU)
// ─────────────────────────────────────────────────────────────

/** The destination's ACTIVE contact row, locked — the lock order's first step (row, then state). */
const ACTIVE_ROW_SQL = Object.freeze({
  sms:   'SELECT id, contact_id FROM contact_phones WHERE phone_active_uniq = ? FOR UPDATE',
  email: 'SELECT id, contact_id FROM contact_emails WHERE email_active_uniq = ? FOR UPDATE',
});

/** withTransaction(retries:1) + one retry on a deadlock (pure DB: the victim's span rolled back whole). */
async function consentTx(db, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, fn, { retries: 1 });
    } catch (err) {
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt === 0) continue;
      throw err;
    }
  }
}

/**
 * Validate an import body — ALL of it, before anything is written. Throws a
 * ConsentRouteError: 400 for shape / channel / scope / any bad row (the
 * invalid rows listed, nothing recorded), 422 for an opt-in (an import may
 * only opt out — the API-key rule: an opt-in is a human consent decision).
 * → { channel, scope, items: [{ destination, note }], duplicates }
 */
async function validateImport(db, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const channel = readChannel(b.channel);
  if (!channel) throw new ConsentRouteError(400, 'bad_channel', 'channel must be "sms" or "email"');
  if (b.action !== undefined && b.action !== 'opt_out') {
    throw new ConsentRouteError(422, 'import_opt_out_only', 'An import records opt-outs only — an opt-in is a consent decision a staff member makes on the contact.');
  }
  if (b.source !== undefined && b.source !== 'import') {
    throw new ConsentRouteError(400, 'bad_source', 'source must be "import"');
  }
  const rows = b.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_IMPORT_ROWS) {
    throw new ConsentRouteError(400, 'bad_rows', `rows must be an array of 1 to ${MAX_IMPORT_ROWS} entries`);
  }
  try {
    await optout.assertScope(db, channel, b.scope);
  } catch (err) {
    if (err && /^recordConsent: /.test(String(err.message))) {
      throw new ConsentRouteError(400, 'bad_scope', String(err.message).replace(/^recordConsent: /, ''));
    }
    throw err;
  }

  const invalid = [];
  const items = [];
  const seen = new Set();
  let duplicates = 0;
  rows.forEach((r, index) => {
    const row = r && typeof r === 'object' && !Array.isArray(r) ? r : null;
    if (row && row.action !== undefined && row.action !== 'opt_out') {
      invalid.push({ index, reason: 'opt_in' });
      return;
    }
    const raw = row && typeof row.destination === 'string' ? row.destination : '';
    const destination = oneDestination(channel, raw);
    if (!destination) { invalid.push({ index, destination: raw.slice(0, 254), reason: 'destination' }); return; }
    let note = null;
    if (row.note != null && row.note !== '') {
      if (typeof row.note !== 'string') { invalid.push({ index, destination, reason: 'note' }); return; }
      const t = row.note.trim();
      if (t.length > NOTE_MAX) { invalid.push({ index, destination, reason: 'note_too_long' }); return; }
      note = t || null;
    }
    if (seen.has(destination)) { duplicates++; return; }
    seen.add(destination);
    items.push({ destination, note });
  });
  if (invalid.some((x) => x.reason === 'opt_in')) {
    throw new ConsentRouteError(422, 'import_opt_out_only', 'An import records opt-outs only — an opt-in is a consent decision a staff member makes on the contact.',
      { invalid: invalid.length, invalid_rows: invalid.slice(0, 100) });
  }
  if (invalid.length) {
    throw new ConsentRouteError(400, 'invalid_rows', `${invalid.length} row${invalid.length === 1 ? '' : 's'} failed validation — nothing was recorded.`,
      { recorded: 0, unchanged: 0, invalid: invalid.length, invalid_rows: invalid.slice(0, 100) });
  }
  return { channel, scope: b.scope, items, duplicates };
}

/**
 * Record a validated import: ONE opt_out per destination through
 * recordConsent, source 'import', evidence { via: 'import', batch_id, note? },
 * actor = the SU. ONE transaction PER DESTINATION (consentTx): a transaction
 * holds one contact row at a time, so it can never hold rows in an order a
 * staff save locks the other way (a batch holding up to 100 rows in file order
 * deadlocked a form save touching two rows of one contact — review r2, proven
 * on the engine; nothing on the save path retries a deadlock). Per
 * destination, in §4.4's lock order: its ACTIVE contact row locked first
 * (handed to recordConsent as rowId, so nothing is locked twice), then the
 * scope's state with a PLAIN read (optout.scopeState — the snapshot is taken
 * after the row lock; a FOR SHARE read of a missing state row would take a
 * gap lock that deadlocks against another writer's seed insert): already
 * 'opted_out' → unchanged, nothing recorded — a second run of the same file
 * records nothing. These lock steps live here, like phoneConsentService's
 * (P2): the §4.4 site list names both.
 * A failure part-way leaves the earlier destinations committed (err.partial
 * holds their counts); re-running the file is safe for the same reason.
 * → { recorded, unchanged, invalid: 0, duplicates, batch_id }
 */
async function importConsent(db, body, { actorUserId = null, batchId = null } = {}) {
  const { channel, scope, items, duplicates } = await validateImport(db, body);
  const batch_id = batchId || crypto.randomUUID();
  const totals = { recorded: 0, unchanged: 0 };
  for (const it of items) {
    let outcome;
    try {
      outcome = await consentTx(db, async (conn) => {
        const [[row]] = await conn.query(ACTIVE_ROW_SQL[channel], [it.destination]);
        const st = await optout.scopeState(conn, channel, it.destination, scope);
        if (st.state === 'opted_out') return 'unchanged';
        await optout.recordConsent(conn, {
          channel, destination: it.destination, scope, action: 'opt_out', source: 'import',
          contactId: row ? row.contact_id : null, rowId: row ? row.id : null, actorUserId,
          evidence: { via: 'import', batch_id, ...(it.note ? { note: it.note } : {}) },
        });
        return 'recorded';
      });
    } catch (err) {
      err.partial = { ...totals, batch_id };
      throw err;
    }
    totals[outcome] += 1;
  }
  return { recorded: totals.recorded, unchanged: totals.unchanged, invalid: 0, duplicates, batch_id };
}

// ─────────────────────────────────────────────────────────────
// Preview (campaign compose)
// ─────────────────────────────────────────────────────────────

/**
 * What consent removes from a campaign selection, asked the way
 * campaignService.executeSend asks at send time: each contact's
 * contacts.contact_phone (SMS) / contacts.contact_email (email) — the
 * contact's primary mirror, which is what executeSend sends to — through
 * findOptedOut with campaignConsent(channel, class, topic). `class` defaults
 * to 'operational' like createCampaign; an operational EMAIL selection asks
 * no reader at all (D18 — nothing is skipped). One reader call for the whole
 * selection (findOptedOut decides each destination on its own, so the batch
 * answer is the per-contact answer).
 * → { channel, class, topic, selected, will_send, skipped_optout, missing_destination, not_found }
 */
async function previewConsent(db, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const channel = readChannel(b.channel);
  if (!channel) throw new ConsentRouteError(400, 'bad_channel', 'channel must be "sms" or "email"');
  const klass = b.class == null || b.class === '' ? 'operational' : b.class;
  if (!campaignService.KLASSES.includes(klass)) throw new ConsentRouteError(400, 'bad_class', 'class must be "operational" or "marketing"');
  const topic = b.topic == null || b.topic === '' ? null : b.topic;
  if (topic !== null && (typeof topic !== 'string' || !campaignService.TOPIC_RE.test(topic) || klass !== 'marketing')) {
    throw new ConsentRouteError(400, 'bad_topic', 'topic must be a topic key, and applies to the marketing class only');
  }
  if (!Array.isArray(b.contact_ids) || b.contact_ids.length > MAX_PREVIEW_IDS) {
    throw new ConsentRouteError(400, 'bad_contact_ids', `contact_ids must be an array of at most ${MAX_PREVIEW_IDS} ids`);
  }
  const ids = [];
  const seen = new Set();
  for (const v of b.contact_ids) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) throw new ConsentRouteError(400, 'bad_contact_ids', 'contact_ids must be positive integers');
    if (!seen.has(n)) { seen.add(n); ids.push(n); }
  }
  const out = { channel, class: klass, topic, selected: ids.length, will_send: 0, skipped_optout: 0, missing_destination: 0, not_found: 0 };
  if (!ids.length) return out;
  const [contacts] = await db.query('SELECT contact_id, contact_phone, contact_email FROM contacts WHERE contact_id IN (?)', [ids]);
  const col = channel === 'sms' ? 'contact_phone' : 'contact_email';
  const keysOf = channel === 'sms' ? optout.phoneKeys : optout.emailKeys;
  const dests = (contacts || []).map((c) => c[col]).filter((d) => d != null && d !== '');
  const consent = campaignConsent(channel, klass, topic);
  const hits = dests.length && consent ? await optout.findOptedOut(db, channel, dests, consent) : [];
  const out_ = new Set(hits.map((h) => h.destination));
  out.not_found = ids.length - (contacts || []).length;
  for (const c of contacts || []) {
    if (keysOf(c[col]).some((k) => out_.has(k))) out.skipped_optout++;   // step 4: opted out → skipped
    else if (!c[col]) out.missing_destination++;                         // step 5: no phone / email → failed
    else out.will_send++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

router.get('/api/consent/history', jwtOrApiKey, async (req, res) => {
  try {
    const { channel, destination } = readDestination(req.query);
    const n = Number(req.query.limit);
    const limit = Number.isSafeInteger(n) && n > 0 ? Math.min(n, HISTORY_MAX) : HISTORY_DEFAULT;
    const events = await optout.consentHistory(req.db, channel, destination, { limit });
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'success', channel, destination, events });
  } catch (err) {
    sendError(res, err, 'GET /api/consent/history');
  }
});

router.get('/api/consent/export', jwtOrApiKey, async (req, res) => {
  try {
    const { channel, destination } = readDestination(req.query);
    const events = await optout.consentHistory(req.db, channel, destination, { limit: EXPORT_MAX });
    const safe = destination.replace(/[^a-z0-9._-]/gi, '_');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="consent-${channel}-${safe}.csv"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    res.send(historyCsv(channel, destination, events));
  } catch (err) {
    sendError(res, err, 'GET /api/consent/export');
  }
});

router.post('/api/consent/preview', jwtOrApiKey, async (req, res) => {
  try {
    res.json({ status: 'success', ...(await previewConsent(req.db, req.body)) });
  } catch (err) {
    sendError(res, err, 'POST /api/consent/preview');
  }
});

router.post('/api/consent/import', ...superuserOnlyFor(IMPORT_TOOL), async (req, res) => {
  const started = Date.now();
  const audit = (status, details, errorMessage) => auditAdminAction(req.db, {
    tool: IMPORT_TOOL,
    userId: req.auth.userId,
    username: req.auth.username,
    route: req.originalUrl,
    method: req.method,
    status,
    errorMessage: errorMessage || null,
    durationMs: Date.now() - started,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
    details,
  }).catch((e) => console.error('[consent import] audit log failed:', e.message));
  try {
    const n = Number(req.auth.userId);
    const result = await importConsent(req.db, req.body, { actorUserId: Number.isSafeInteger(n) && n > 0 ? n : null });
    await audit('success', { channel: req.body.channel, scope: req.body.scope, rows: req.body.rows.length, ...result });
    res.json({ status: 'success', ...result,
      ...(result.duplicates ? { message: `${result.duplicates} duplicate row${result.duplicates === 1 ? '' : 's'} in the file collapsed into the first occurrence (each destination is recorded at most once).` } : {}) });
  } catch (err) {
    if (err && err.name === 'ConsentRouteError') {
      await audit('rejected', { code: err.code, invalid: err.extra && err.extra.invalid }, err.message);
      return sendError(res, err, 'POST /api/consent/import');
    }
    console.error('POST /api/consent/import error:', err);
    const partial = err && err.partial ? err.partial : null;
    await audit('error', { partial }, err && err.message);
    res.status(500).json(partial
      ? { status: 'error', message: 'Import failed part-way — the counts below were committed; re-running the same file is safe (already opted out records nothing).', committed: partial }
      : { status: 'error', message: 'Import failed before anything was recorded.' });
  }
});

module.exports = router;
// Exposed for tests (tests/consentReads.mysql.test.js, tests/consentRoutes.test.js) —
// module.exports stays the router the loader mounts.
module.exports.importConsent = importConsent;
module.exports.previewConsent = previewConsent;
module.exports.csvCell = csvCell;
module.exports.campaignConsent = campaignConsent;
