// services/gcalService.js
//
/**
 * Google Calendar Service
 * services/gcalService.js
 *
 * Native CRUD over the Google Calendar API v3, replacing the Pabbly bridge
 * (services/pabblyService.js → 'gcal_create' / 'gcal_delete').
 *
 * Auth is via the Connections system: an oauth2 credential row whose scopes
 * include https://www.googleapis.com/auth/calendar. Outbound headers are built
 * with buildHeadersForCredential (the async builder — the sync buildAuthHeaders
 * returns {} for oauth2 and silently breaks; see AI_CONTEXT §21).
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ allowed_urls REQUIREMENT                                          │
 *   │                                                                   │
 *   │ The Calendar API lives at https://www.googleapis.com/calendar/   │
 *   │ v3/*. The credential's allowed_urls JSON MUST include a pattern   │
 *   │ that matches it (e.g. "https://www.googleapis.com/*"). If it does │
 *   │ not, checkUrlScope rejects the request, buildHeadersForCredential │
 *   │ returns {}, and every call here fails with a 401-shaped error     │
 *   │ ("...not connected, or URL out of allowed_urls scope"). This is   │
 *   │ the recurring "misleading allowed_urls" trap — fix the data, not  │
 *   │ the code.                                                         │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Credential / calendar selection (params-first, app_settings fallback,
 * then hard default):
 *   - credentialId : opts.credentialId
 *                 ?? app_settings 'gcal_credential_id'
 *                 ?? DEFAULT_CREDENTIAL_ID
 *   - calendarId   : opts.calendarId
 *                 ?? app_settings 'gcal_calendar_id'
 *                 ?? 'primary'
 * One settings read per resolve, overridable at every call site.
 *
 * Event time semantics:
 *   Callers pass either an opts.event already shaped for the Calendar API
 *   (start/end as {dateTime, timeZone} or {date}), OR the convenience fields
 *   (summary/description/location/attendees + start/end as ISO strings). When
 *   start/end are bare ISO strings or naive datetimes, they are sent with
 *   timeZone = FIRM_TZ so Google interprets them in firm-local time. Pass
 *   fully-formed {dateTime, timeZone} objects to override.
 *
 * All functions throw Error on failure (4xx/5xx from Google, missing auth,
 * bad input). Callers that want fire-and-forget semantics (e.g. apptService)
 * wrap in .catch(). The thin route/internal_function wrappers translate the
 * thrown Error into an HTTP status / { success:false } as appropriate.
 */

const { buildHeadersForCredential } = require('../lib/credentialInjection');
const { FIRM_TZ } = require('./timezoneService');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const REQUEST_TIMEOUT_MS = 15000;

// Hard fallbacks if neither opts nor app_settings provide a value. Credential
// 11 = "Google Workspace - Stuart@4lsg.com" (oauth2, calendar scope). These
// are last-resort defaults — prefer app_settings ('gcal_credential_id',
// 'gcal_calendar_id') so the binding can change without a deploy.
const DEFAULT_CREDENTIAL_ID = 11;
const DEFAULT_CALENDAR_ID   = 'primary';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the credential id and calendar id for a call. params win, then
 * app_settings, then the hard defaults above.
 *
 * @param {object} db
 * @param {object} opts — may carry credentialId / calendarId
 * @returns {Promise<{credentialId:(number|string), calendarId:string}>}
 */
async function _resolveTarget(db, opts = {}) {
  let credentialId = opts.credentialId;
  let calendarId   = opts.calendarId;

  if (credentialId == null || calendarId == null) {
    let settings = {};
    try {
      const [rows] = await db.query(
        "SELECT `key`, `value` FROM app_settings WHERE `key` IN ('gcal_credential_id','gcal_calendar_id')"
      );
      settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    } catch (err) {
      // Settings table read failure shouldn't be fatal — fall through to
      // hard defaults. Surface it for diagnosis.
      console.warn(`[GCAL] app_settings lookup failed, using defaults: ${err.message}`);
    }
    if (credentialId == null) credentialId = settings.gcal_credential_id ?? DEFAULT_CREDENTIAL_ID;
    if (calendarId   == null) calendarId   = settings.gcal_calendar_id   ?? DEFAULT_CALENDAR_ID;
  }

  return { credentialId, calendarId };
}

/**
 * Core authenticated request to the Calendar API. Builds oauth2 headers via
 * the async injector, enforces a timeout, parses JSON, and throws a
 * descriptive Error on non-2xx (or on a missing-auth header, which is the
 * allowed_urls / not-connected case).
 *
 * @param {object} db
 * @param {number|string} credentialId
 * @param {string} url       — fully-qualified Calendar API URL
 * @param {object} [options] — { method, body } (body is a JS object, JSON-encoded here)
 * @returns {Promise<object|null>} parsed JSON body, or null for 204
 */
async function _apiRequest(db, credentialId, url, { method = 'GET', body } = {}) {
  let authHeaders;
  try {
    authHeaders = await buildHeadersForCredential(db, credentialId, url);
  } catch (err) {
    throw new Error(`gcal: failed to build auth headers for credential ${credentialId}: ${err.message}`);
  }

  if (!authHeaders || !authHeaders.Authorization) {
    // Mirrors the rc_renew diagnostic: no Authorization means the credential
    // is not connected OR the URL is out of allowed_urls scope. For Calendar
    // this almost always means allowed_urls is missing the googleapis host.
    throw new Error(
      `gcal: no Authorization header for credential ${credentialId} — ` +
      `credential not connected, or URL ${url} is out of allowed_urls scope ` +
      `(Calendar needs https://www.googleapis.com/* in allowed_urls)`
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
    throw new Error(`gcal: request to ${url} failed: ${err.message}`);
  } finally {
    clearTimeout(tHandle);
  }

  // 204 No Content (DELETE success) — nothing to parse.
  if (res.status === 204) return null;

  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  }

  if (!res.ok) {
    const gErr = parsed && parsed.error;
    const detail = gErr
      ? (gErr.message || JSON.stringify(gErr))
      : (text ? text.slice(0, 500) : '(empty body)');
    throw new Error(`gcal: ${method} ${url} → ${res.status}: ${detail}`);
  }

  return parsed;
}

/**
 * Normalize a start/end value into a Calendar API time object.
 *   - object passed through as-is (caller-supplied {dateTime,timeZone}/{date})
 *   - "YYYY-MM-DD" (date only)            → { date }
 *   - any other string (ISO / naive)      → { dateTime, timeZone: FIRM_TZ }
 * If the string already carries a zone (Z or ±hh:mm), FIRM_TZ is still sent;
 * Google honors the explicit offset in dateTime and treats timeZone as the
 * display zone, which is the desired behavior for firm-local events.
 */
function _normalizeTime(value) {
  if (value == null) return undefined;
  if (typeof value === 'object') return value;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  return { dateTime: s, timeZone: FIRM_TZ };
}

/**
 * Build a Calendar API event resource from either a pre-shaped opts.event or
 * the convenience fields. Convenience fields, when present, are layered on top
 * of opts.event so a caller can pass a base event and still override summary
 * etc. Undefined fields are omitted.
 */
function _buildEventResource(opts) {
  const base = (opts.event && typeof opts.event === 'object') ? { ...opts.event } : {};

  if (opts.summary     !== undefined) base.summary     = opts.summary;
  if (opts.description !== undefined) base.description  = opts.description;
  if (opts.location    !== undefined) base.location     = opts.location;

  const start = _normalizeTime(opts.start);
  const end   = _normalizeTime(opts.end);
  if (start !== undefined) base.start = start;
  if (end   !== undefined) base.end   = end;

  if (opts.attendees !== undefined) {
    // Accept array of email strings or array of {email,...} objects.
    base.attendees = (opts.attendees || []).map(a =>
      typeof a === 'string' ? { email: a } : a
    );
  }

  return base;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Get a single event by ID.
 *
 * @param {object} db
 * @param {object} opts
 *   eventId       {string}  required — Calendar event ID (appts.appt_gcal)
 *   credentialId  {number?} override credential
 *   calendarId    {string?} override calendar
 * @returns {Promise<object>} the event resource
 */
async function getEvent(db, opts = {}) {
  const { eventId } = opts;
  if (!eventId) throw new Error('gcal getEvent requires eventId');

  const { credentialId, calendarId } = await _resolveTarget(db, opts);
  const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return _apiRequest(db, credentialId, url, { method: 'GET' });
}

/**
 * List the calendars on the credential account's calendar list. Use this to
 * discover calendar IDs (the .id field of each entry) for use as calendarId
 * elsewhere. This hits /users/me/calendarList — it is account-scoped, so no
 * calendarId is needed (or used).
 *
 * Each entry includes: id, summary, primary (bool, the main calendar),
 * accessRole ('owner'|'writer'|'reader'|'freeBusyReader'), backgroundColor,
 * etc. Only calendars with accessRole 'owner' or 'writer' can take event
 * writes from this credential.
 *
 * @param {object} db
 * @param {object} opts
 *   minAccessRole {string?} 'freeBusyReader'|'reader'|'writer'|'owner' —
 *                           restrict to calendars the account has at least
 *                           this role on. Pass 'writer' to list only
 *                           writable calendars.
 *   showHidden    {boolean?} include hidden calendars (default false)
 *   pageToken     {string?}
 *   credentialId  {number?} override credential
 * @returns {Promise<object>} { items, nextPageToken, ... }
 */
async function listCalendars(db, opts = {}) {
  // calendarList is account-scoped — resolve credential only, ignore calendarId.
  const { credentialId } = await _resolveTarget(db, opts);

  const params = new URLSearchParams();
  if (opts.minAccessRole) params.set('minAccessRole', opts.minAccessRole);
  if (opts.showHidden)    params.set('showHidden', String(opts.showHidden));
  if (opts.pageToken)     params.set('pageToken', opts.pageToken);
  const qs = params.toString();

  const url = `${API_BASE}/users/me/calendarList${qs ? `?${qs}` : ''}`;
  return _apiRequest(db, credentialId, url, { method: 'GET' });
}

/**
 * List events on a calendar. Thin pass-through of the common query params.
 *
 * @param {object} db
 * @param {object} opts
 *   timeMin / timeMax   {string?} RFC3339 lower/upper bounds
 *   q                   {string?} free-text search
 *   maxResults          {number?} default 250
 *   singleEvents        {boolean?} expand recurring (default true)
 *   orderBy             {string?} 'startTime' | 'updated' (startTime needs singleEvents)
 *   pageToken           {string?}
 *   credentialId / calendarId — overrides
 * @returns {Promise<object>} { items, nextPageToken, ... }
 */
async function listEvents(db, opts = {}) {
  const { credentialId, calendarId } = await _resolveTarget(db, opts);

  const params = new URLSearchParams();
  if (opts.timeMin)    params.set('timeMin', opts.timeMin);
  if (opts.timeMax)    params.set('timeMax', opts.timeMax);
  if (opts.q)          params.set('q', opts.q);
  params.set('maxResults',   String(opts.maxResults ?? 250));
  params.set('singleEvents', String(opts.singleEvents ?? true));
  if (opts.orderBy)    params.set('orderBy', opts.orderBy);
  if (opts.pageToken)  params.set('pageToken', opts.pageToken);

  const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  return _apiRequest(db, credentialId, url, { method: 'GET' });
}

/**
 * Create an event.
 *
 * @param {object} db
 * @param {object} opts
 *   Convenience fields: summary, description, location, start, end, attendees
 *   OR opts.event — a pre-shaped Calendar event resource (merged with the
 *   convenience fields, which win).
 *   sendUpdates   {string?} 'all' | 'externalOnly' | 'none' (default 'none')
 *   credentialId / calendarId — overrides
 * @returns {Promise<object>} the created event resource (includes .id and .htmlLink)
 */
async function createEvent(db, opts = {}) {
  const { credentialId, calendarId } = await _resolveTarget(db, opts);
  const resource = _buildEventResource(opts);

  if (!resource.start || !resource.end) {
    throw new Error('gcal createEvent requires start and end (or an opts.event with start/end)');
  }

  const params = new URLSearchParams();
  if (opts.sendUpdates) params.set('sendUpdates', opts.sendUpdates);
  const qs = params.toString();
  const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events${qs ? `?${qs}` : ''}`;

  return _apiRequest(db, credentialId, url, { method: 'POST', body: resource });
}

/**
 * Update (PATCH) an event. Only the supplied fields are changed — Calendar's
 * PATCH is a partial update, so callers don't need to round-trip the whole
 * event. Pass opts.event for fields without a convenience alias.
 *
 * @param {object} db
 * @param {object} opts
 *   eventId       {string}  required
 *   Convenience fields + opts.event as in createEvent (all optional here).
 *   sendUpdates   {string?} 'all' | 'externalOnly' | 'none'
 *   credentialId / calendarId — overrides
 * @returns {Promise<object>} the updated event resource
 */
async function updateEvent(db, opts = {}) {
  const { eventId } = opts;
  if (!eventId) throw new Error('gcal updateEvent requires eventId');

  const { credentialId, calendarId } = await _resolveTarget(db, opts);
  const resource = _buildEventResource(opts);

  if (Object.keys(resource).length === 0) {
    throw new Error('gcal updateEvent requires at least one field to change');
  }

  const params = new URLSearchParams();
  if (opts.sendUpdates) params.set('sendUpdates', opts.sendUpdates);
  const qs = params.toString();
  const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ''}`;

  return _apiRequest(db, credentialId, url, { method: 'PATCH', body: resource });
}

/**
 * Delete an event. Google returns 204 on success; a delete of an
 * already-gone event returns 410 Gone, which we surface as an error — callers
 * that treat "already deleted" as success can inspect the message.
 *
 * @param {object} db
 * @param {object} opts
 *   eventId       {string}  required
 *   sendUpdates   {string?} 'all' | 'externalOnly' | 'none'
 *   credentialId / calendarId — overrides
 * @returns {Promise<{deleted:true, eventId:string}>}
 */
async function deleteEvent(db, opts = {}) {
  const { eventId } = opts;
  if (!eventId) throw new Error('gcal deleteEvent requires eventId');

  const { credentialId, calendarId } = await _resolveTarget(db, opts);

  const params = new URLSearchParams();
  if (opts.sendUpdates) params.set('sendUpdates', opts.sendUpdates);
  const qs = params.toString();
  const url = `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${qs ? `?${qs}` : ''}`;

  await _apiRequest(db, credentialId, url, { method: 'DELETE' });
  return { deleted: true, eventId };
}

module.exports = {
  getEvent,
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  // exported for testing / reuse
  _resolveTarget,
  _normalizeTime,
  _buildEventResource,
};