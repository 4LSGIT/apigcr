// services/gContactsService.js
//
/**
 * Google People (Contacts) Service
 * services/gContactsService.js
 *
 * One-way sync: YisraCase contacts -> a Google account's Contacts, via the
 * Connections oauth2 credential (default id 11, "Google Workspace -
 * Stuart@4lsg.com"). Modeled on services/gcalService.js: same async credential
 * injection, same _apiRequest shape, same throw-on-failure contract.
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ allowed_urls REQUIREMENT                                          │
 *   │ The People API lives at https://people.googleapis.com/v1/* —     │
 *   │ a DIFFERENT host from Calendar (www.googleapis.com). The          │
 *   │ credential's allowed_urls JSON MUST include                       │
 *   │ "https://people.googleapis.com/*" or checkUrlScope rejects the    │
 *   │ request, buildHeadersForCredential returns {}, and every call     │
 *   │ here fails with a 401-shaped "out of allowed_urls scope" error.   │
 *   │ The credential also needs the scope                               │
 *   │ https://www.googleapis.com/auth/contacts.                         │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Sync policy (decided against live data, 2026-06):
 *   - YisraCase is authoritative for NAMES (given/middle/family). We push.
 *   - phoneNumbers / emailAddresses are UNION-merged (existing Google values
 *     are preserved; our values are added if missing). We never delete a
 *     Google number/email we don't have — replacing wholesale was shown to
 *     destroy ~44 phones / ~47 emails that exist only on Google.
 *   - addresses are union-merged (Google kept; YisraCase added if new).
 *   - birthdays pushed only when YisraCase has a DOB (never clears Google's).
 *   - externalIds always carries our contact_id (type 'yisracase') — the
 *     durable, recoverable link. The contacts.contact_google_resource_name
 *     column is a cache; externalIds is truth.
 *   - SSN / notes / tags / marital status are NEVER written.
 *
 * updatePersonFields is computed DYNAMICALLY from the fields actually present
 * on the built Person, so we never name a field in the update mask that we
 * aren't setting (which would clear it on Google's side).
 *
 * All functions throw Error on failure. Callers wanting fire-and-forget
 * (the contactService on-write hook) wrap in .catch().
 */

const { buildHeadersForCredential } = require('../lib/credentialInjection');
const contactService = require('./contactService');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const API_BASE           = 'https://people.googleapis.com/v1';
const REQUEST_TIMEOUT_MS  = 15000;
const DEFAULT_CREDENTIAL_ID = 11;          // Google Workspace - Stuart@4lsg.com
const EXTERNAL_ID_TYPE    = 'yisracase';   // tag stamped into Person.externalIds

// Person fields the service reads back / may touch. Update masks are derived
// per-call from the built Person, NOT from this constant.
const READ_FIELDS = 'names,nicknames,phoneNumbers,emailAddresses,addresses,birthdays,externalIds';

// Contacts whose primary email is internal firm staff are not synced (Stuart
// does not need contact cards of his own firm). Extendable via app_settings
// 'gcontacts_exclude_email_domains' (comma-separated).
const DEFAULT_EXCLUDE_DOMAINS = ['4lsg.com'];

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

const _digits = (x) => String(x == null ? '' : x).replace(/\D/g, '');
const _last10 = (x) => { const d = _digits(x); return d.length >= 10 ? d.slice(-10) : null; };
const _email  = (x) => { const e = String(x == null ? '' : x).trim().toLowerCase(); return e || null; };
const _trim   = (x) => String(x == null ? '' : x).trim();

/**
 * Resolve credential id, the YisraCase group resourceName, and the exclusion
 * domain list. params win, then app_settings, then hard defaults.
 *
 * app_settings keys:
 *   gcontacts_credential_id        -> number   (default 11)
 *   gcontacts_group                -> string   ("contactGroups/...", optional)
 *   gcontacts_exclude_email_domains-> CSV       (default "4lsg.com")
 */
async function _resolveConfig(db, opts = {}) {
  let credentialId      = opts.credentialId;
  let groupResourceName = opts.groupResourceName;
  let excludeDomains    = opts.excludeDomains;

  if (credentialId == null || groupResourceName === undefined || excludeDomains == null) {
    let settings = {};
    try {
      const [rows] = await db.query(
        "SELECT `key`, `value` FROM app_settings WHERE `key` IN " +
        "('gcontacts_credential_id','gcontacts_group','gcontacts_exclude_email_domains')"
      );
      settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    } catch (err) {
      console.warn(`[GCONTACTS] app_settings lookup failed, using defaults: ${err.message}`);
    }
    if (credentialId == null)         credentialId      = settings.gcontacts_credential_id ?? DEFAULT_CREDENTIAL_ID;
    if (groupResourceName === undefined) groupResourceName = settings.gcontacts_group ?? null;
    if (excludeDomains == null)       excludeDomains    = settings.gcontacts_exclude_email_domains
                                                            ? String(settings.gcontacts_exclude_email_domains).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
                                                            : DEFAULT_EXCLUDE_DOMAINS;
  }
  return { credentialId, groupResourceName, excludeDomains };
}

/**
 * Core authenticated request to the People API. Mirrors gcalService._apiRequest.
 * Throws on non-2xx; returns parsed JSON (or null for 204).
 */
async function _apiRequest(db, credentialId, url, { method = 'GET', body } = {}) {
  let authHeaders;
  try {
    authHeaders = await buildHeadersForCredential(db, credentialId, url);
  } catch (err) {
    throw new Error(`gcontacts: failed to build auth headers for credential ${credentialId}: ${err.message}`);
  }
  if (!authHeaders || !authHeaders.Authorization) {
    throw new Error(
      `gcontacts: no Authorization header for credential ${credentialId} — ` +
      `credential not connected, or URL ${url} is out of allowed_urls scope ` +
      `(People API needs https://people.googleapis.com/* in allowed_urls)`
    );
  }

  const headers = { ...authHeaders, Accept: 'application/json' };
  const fetchOpts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const tHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  fetchOpts.signal = controller.signal;

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    throw new Error(`gcontacts: request to ${url} failed: ${err.message}`);
  } finally {
    clearTimeout(tHandle);
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { /* non-JSON */ } }

  if (!res.ok) {
    const gErr = parsed && parsed.error;
    const detail = gErr ? (gErr.message || JSON.stringify(gErr)) : (text ? text.slice(0, 500) : '(empty body)');
    const e = new Error(`gcontacts: ${method} ${url} → ${res.status}: ${detail}`);
    e.status = res.status;
    e.googleStatus = gErr && gErr.status;
    throw e;
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────
// Mapper  (contact + children -> People API Person)
// ─────────────────────────────────────────────────────────────

/**
 * Build a Person body from a contactService.getContact() assembled result,
 * union-merging phones/emails/addresses against an optional existing Google
 * Person so we never drop Google-only values.
 *
 * Returns { person, fields } where `fields` is the dynamic updatePersonFields
 * list (only the keys we actually set). For create, ignore `fields`.
 *
 * @param {object} assembled  { contact, phones, emails, addresses }
 * @param {object} [existingPerson]  current Google Person (for union/etag)
 */
function buildPerson(assembled, existingPerson = null) {
  const c = assembled.contact || {};
  const phones    = assembled.phones    || [];
  const emails    = assembled.emails    || [];
  const addresses = assembled.addresses || [];
  const person = {};

  // ---- names (YisraCase authoritative) ----
  const gn = _trim(c.contact_fname), mn = _trim(c.contact_mname), ln = _trim(c.contact_lname);
  const nm = {};
  if (gn) nm.givenName  = gn;
  if (mn) nm.middleName = mn;
  if (ln) nm.familyName = ln;
  if (!gn && !ln) {
    const fb = _trim(c.contact_rname) || _trim(c.contact_name);
    if (fb) nm.givenName = fb;
  }
  if (Object.keys(nm).length) person.names = [nm];

  // ---- phoneNumbers (union: existing Google + YisraCase) ----
  {
    const out = [];
    const seen = new Set();
    for (const gp of (existingPerson && existingPerson.phoneNumbers) || []) {
      const k = _last10(gp.canonicalForm || gp.value) || _digits(gp.value);
      const entry = {}; if (gp.value) entry.value = gp.value; if (gp.type) entry.type = gp.type;
      if (entry.value) { out.push(entry); if (k) seen.add(k); }
    }
    for (const p of phones) {
      const v = _trim(p.phone); const k = _last10(v) || _digits(v);
      if (v && (!k || !seen.has(k))) {
        out.push({ value: v, ...(p.label ? { type: p.label } : {}) });
        if (k) seen.add(k);
      }
    }
    // legacy scalar fallbacks (only if child table empty)
    if (!phones.length) {
      for (const v0 of [c.contact_phone, c.contact_phone2]) {
        const v = _trim(v0); const k = _last10(v) || _digits(v);
        if (v && (!k || !seen.has(k))) { out.push({ value: v }); if (k) seen.add(k); }
      }
    }
    if (out.length) person.phoneNumbers = out;
  }

  // ---- emailAddresses (union) ----
  {
    const out = [];
    const seen = new Set();
    for (const ge of (existingPerson && existingPerson.emailAddresses) || []) {
      const k = _email(ge.value);
      const entry = {}; if (ge.value) entry.value = ge.value; if (ge.type) entry.type = ge.type;
      if (entry.value) { out.push(entry); if (k) seen.add(k); }
    }
    for (const e of emails) {
      const v = _trim(e.email); const k = _email(v);
      if (v && (!k || !seen.has(k))) {
        out.push({ value: v, ...(e.label ? { type: e.label } : {}) });
        if (k) seen.add(k);
      }
    }
    if (!emails.length) {
      for (const v0 of [c.contact_email, c.contact_email2]) {
        const v = _trim(v0); const k = _email(v);
        if (v && (!k || !seen.has(k))) { out.push({ value: v }); if (k) seen.add(k); }
      }
    }
    if (out.length) person.emailAddresses = out;
  }

  // ---- addresses (union by streetAddress+postalCode) ----
  {
    const out = [];
    const seen = new Set();
    const keyOf = (a) => `${(a.streetAddress || '').trim().toLowerCase()}|${(a.postalCode || '').trim()}`;
    for (const ga of (existingPerson && existingPerson.addresses) || []) {
      const entry = {};
      for (const f of ['streetAddress', 'city', 'region', 'postalCode', 'country', 'type']) if (ga[f]) entry[f] = ga[f];
      if (Object.keys(entry).length) { out.push(entry); seen.add(keyOf(entry)); }
    }
    const ycAddrs = addresses.length ? addresses.map(a => ({
      streetAddress: [_trim(a.address1), _trim(a.address2)].filter(Boolean).join(' ') || undefined,
      city:       _trim(a.city)    || undefined,
      region:     _trim(a.state)   || undefined,
      postalCode: _trim(a.zip)     || undefined,
      country:    _trim(a.country) || undefined,
      type:       a.label || undefined,
    })) : [{
      streetAddress: _trim(c.contact_address) || undefined,
      city:       _trim(c.contact_city)  || undefined,
      region:     _trim(c.contact_state) || undefined,
      postalCode: _trim(c.contact_zip)   || undefined,
    }];
    for (const a of ycAddrs) {
      const entry = {};
      for (const f of ['streetAddress', 'city', 'region', 'postalCode', 'country', 'type']) if (a[f]) entry[f] = a[f];
      if (Object.keys(entry).length && !seen.has(keyOf(entry))) { out.push(entry); seen.add(keyOf(entry)); }
    }
    if (out.length) person.addresses = out;
  }

  // ---- birthdays (only when YisraCase has a DOB; never clears Google's) ----
  if (c.contact_dob) {
    const m = String(c.contact_dob).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) person.birthdays = [{ date: { year: +m[1], month: +m[2], day: +m[3] } }];
  }

  // ---- externalIds (always — the durable link) ----
  person.externalIds = [{ value: String(c.contact_id), type: EXTERNAL_ID_TYPE }];

  const fields = Object.keys(person).filter(k => k !== 'etag').join(',');
  return { person, fields };
}

// ─────────────────────────────────────────────────────────────
// Persistence (DB column cache)
// ─────────────────────────────────────────────────────────────

async function _persistLink(db, contactId, resourceName, etag) {
  await db.query(
    `UPDATE contacts
        SET contact_google_resource_name = ?,
            contact_google_etag          = ?,
            contact_google_synced_at      = NOW()
      WHERE contact_id = ?`,
    [resourceName || '', etag || '', contactId]
  );
}

async function _addToGroup(db, credentialId, groupResourceName, resourceNames) {
  if (!groupResourceName || !resourceNames.length) return;
  for (let i = 0; i < resourceNames.length; i += 500) {
    await _apiRequest(
      db, credentialId,
      `${API_BASE}/${groupResourceName}/members:modify`,
      { method: 'POST', body: { resourceNamesToAdd: resourceNames.slice(i, i + 500) } }
    );
  }
}

function _isExcluded(contact, excludeDomains) {
  const e = _email(contact.contact_email);
  if (e) {
    const dom = e.split('@')[1] || '';
    if (excludeDomains.includes(dom)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Upsert one YisraCase contact into Google.
 *   - has a stored resourceName -> GET existing (for etag + union) then PATCH;
 *     if the resource is gone (deleted in Google) fall back to create.
 *   - otherwise -> createContact.
 * Persists resourceName/etag/synced_at and (best-effort) group membership.
 *
 * @returns {Promise<{action:'created'|'updated'|'skipped', resourceName?:string, reason?:string}>}
 */
async function pushContact(db, contactId, opts = {}) {
  const { credentialId, groupResourceName, excludeDomains } = await _resolveConfig(db, opts);
  const assembled = await contactService.getContact(db, contactId, 'phones,emails,addresses');
  if (!assembled || !assembled.contact) return { action: 'skipped', reason: 'not_found' };

  const c = assembled.contact;
  if (!opts.force && _isExcluded(c, excludeDomains)) return { action: 'skipped', reason: 'excluded_domain' };

  const rn = _trim(c.contact_google_resource_name);

  if (rn) {
    // UPDATE path — GET fresh etag + existing values for union.
    let existing = null;
    try {
      existing = await _apiRequest(db, credentialId, `${API_BASE}/${rn}?personFields=${READ_FIELDS}`, { method: 'GET' });
    } catch (err) {
      if (err.status === 404 || err.status === 403 || err.status === 410) {
        // Gone / inaccessible — re-create.
        return _createAndPersist(db, credentialId, groupResourceName, contactId, assembled);
      }
      throw err;
    }
    const { person, fields } = buildPerson(assembled, existing);
    person.etag = existing.etag;
    const url = `${API_BASE}/${rn}:updateContact?updatePersonFields=${encodeURIComponent(fields)}&personFields=names`;
    let updated;
    try {
      updated = await _apiRequest(db, credentialId, url, { method: 'PATCH', body: person });
    } catch (err) {
      // Stale etag — refetch once and retry.
      if (err.status === 400 && /etag/i.test(err.message)) {
        const fresh = await _apiRequest(db, credentialId, `${API_BASE}/${rn}?personFields=${READ_FIELDS}`, { method: 'GET' });
        const rebuilt = buildPerson(assembled, fresh);
        rebuilt.person.etag = fresh.etag;
        updated = await _apiRequest(db, credentialId,
          `${API_BASE}/${rn}:updateContact?updatePersonFields=${encodeURIComponent(rebuilt.fields)}&personFields=names`,
          { method: 'PATCH', body: rebuilt.person });
      } else {
        throw err;
      }
    }
    const newRn = (updated && updated.resourceName) || rn;
    await _persistLink(db, contactId, newRn, updated && updated.etag);
    try { await _addToGroup(db, credentialId, groupResourceName, [newRn]); } catch (e) { console.warn(`[GCONTACTS] group add failed for ${newRn}: ${e.message}`); }
    return { action: 'updated', resourceName: newRn };
  }

  return _createAndPersist(db, credentialId, groupResourceName, contactId, assembled);
}

async function _createAndPersist(db, credentialId, groupResourceName, contactId, assembled) {
  const { person } = buildPerson(assembled, null);
  const created = await _apiRequest(
    db, credentialId,
    `${API_BASE}/people:createContact?personFields=names,externalIds`,
    { method: 'POST', body: person }
  );
  await _persistLink(db, contactId, created.resourceName, created.etag);
  try { await _addToGroup(db, credentialId, groupResourceName, [created.resourceName]); } catch (e) { console.warn(`[GCONTACTS] group add failed for ${created.resourceName}: ${e.message}`); }
  return { action: 'created', resourceName: created.resourceName };
}

/**
 * List all of the credential account's connections (paginated). Used by
 * import-links and for diagnostics.
 * @returns {Promise<{people:object[], syncToken:(string|null)}>}
 */
async function listConnections(db, opts = {}) {
  const { credentialId } = await _resolveConfig(db, opts);
  const personFields = opts.personFields || 'names,emailAddresses,phoneNumbers,externalIds';
  const people = [];
  let pageToken = null, syncToken = null;
  do {
    const params = new URLSearchParams({ personFields, pageSize: '1000' });
    if (opts.requestSyncToken) params.set('requestSyncToken', 'true');
    if (pageToken) params.set('pageToken', pageToken);
    const d = await _apiRequest(db, credentialId, `${API_BASE}/people/me/connections?${params.toString()}`, { method: 'GET' });
    if (d && d.connections) people.push(...d.connections);
    pageToken = d && d.nextPageToken;
    if (d && d.nextSyncToken) syncToken = d.nextSyncToken;
  } while (pageToken);
  return { people, syncToken };
}

/**
 * Ensure a "YisraCase" contactGroup exists; persist its resourceName into
 * app_settings('gcontacts_group'). Idempotent.
 * @returns {Promise<{groupResourceName:string, created:boolean}>}
 */
async function ensureGroup(db, opts = {}) {
  const { credentialId } = await _resolveConfig(db, opts);
  const name = opts.name || 'YisraCase';
  const list = await _apiRequest(db, credentialId, `${API_BASE}/contactGroups?pageSize=200`, { method: 'GET' });
  let grp = (list.contactGroups || []).find(g => g.name === name);
  let created = false;
  if (!grp) {
    grp = await _apiRequest(db, credentialId, `${API_BASE}/contactGroups`, { method: 'POST', body: { contactGroup: { name } } });
    created = true;
  }
  await db.query(
    "INSERT INTO app_settings (`key`,`value`) VALUES ('gcontacts_group', ?) " +
    "ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
    [grp.resourceName]
  );
  return { groupResourceName: grp.resourceName, created };
}

/**
 * One-time post-migration backfill: re-list Google connections, read the
 * 'yisracase' externalId off each, and populate
 * contacts.contact_google_resource_name / _etag for matching rows. Truth is
 * Google's externalId, so this self-heals even if scratch/columns were lost.
 * @returns {Promise<{linked:number, scanned:number}>}
 */
async function importLinks(db, opts = {}) {
  const { people } = await listConnections(db, { ...opts, personFields: 'externalIds' });
  let linked = 0;
  for (const p of people) {
    const ext = (p.externalIds || []).find(e => e.type === EXTERNAL_ID_TYPE);
    if (!ext) continue;
    const cid = parseInt(ext.value, 10);
    if (!Number.isFinite(cid)) continue;
    const [r] = await db.query(
      `UPDATE contacts
          SET contact_google_resource_name = ?, contact_google_etag = ?, contact_google_synced_at = NOW()
        WHERE contact_id = ? AND contact_google_resource_name = ''`,
      [p.resourceName, p.etag || '', cid]
    );
    if (r.affectedRows) linked += r.affectedRows;
  }
  return { linked, scanned: people.length };
}

/**
 * Drift sweep (nightly): push every contact whose row changed since its last
 * sync, or that has never been pushed. Bounded by `limit`.
 * @returns {Promise<{pushed:number, created:number, updated:number, skipped:number, errors:object[]}>}
 */
async function syncPending(db, opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 500, 2000);
  const [rows] = await db.query(
    `SELECT contact_id FROM contacts
      WHERE (contact_google_synced_at IS NULL OR contact_updated > contact_google_synced_at)
      ORDER BY contact_updated DESC
      LIMIT ?`,
    [limit]
  );
  const out = { pushed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
  for (const { contact_id } of rows) {
    try {
      const r = await pushContact(db, contact_id, opts);
      if (r.action === 'created') out.created++;
      else if (r.action === 'updated') out.updated++;
      else out.skipped++;
      if (r.action !== 'skipped') out.pushed++;
    } catch (err) {
      out.errors.push({ contact_id, error: err.message });
    }
  }
  return out;
}

module.exports = {
  pushContact,
  syncPending,
  importLinks,
  ensureGroup,
  listConnections,
  // exported for testing / reuse
  buildPerson,
  _apiRequest,
  _resolveConfig,
};
