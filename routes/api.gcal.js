// routes/api.gcal.js
//
/**
 * Google Calendar API (native)
 * routes/api.gcal.js
 *
 * GET    /api/gcal/calendars       list calendars on the account (discover IDs)
 * GET    /api/gcal/events            list events (query: timeMin,timeMax,q,maxResults,...)
 * GET    /api/gcal/events/:id        get a single event
 * POST   /api/gcal/events            create an event
 * PATCH  /api/gcal/events/:id        update (partial) an event
 * DELETE /api/gcal/events/:id        delete an event
 *
 * Thin wrapper over services/gcalService.js — all logic, auth injection, and
 * Calendar-API specifics live in the service. Auto-mounted by the routes
 * loader (no server.js edit).
 *
 * Auth: jwtOrApiKey (same as the other api.* routes).
 *
 * credentialId / calendarId are accepted as optional overrides (query for
 * GET/DELETE, body for POST/PATCH); omit to use the app_settings binding
 * (gcal_credential_id / gcal_calendar_id) or the service defaults.
 *
 * NOTE: This is the native replacement for the Pabbly-backed
 * routes/internal/gcal.js. That file is intentionally left in place for now;
 * the appt→calendar cutover (apptService + routes/internal/gcal.js) is a
 * separate, reviewed change.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const gcal        = require('../services/gcalService');

// ─────────────────────────────────────────────────────────────
// Error → HTTP status mapping. The service throws Error with a message
// prefixed "gcal: <METHOD> <url> → <status>: ..." for Google API failures;
// pull that status through when present, otherwise map on message shape.
// ─────────────────────────────────────────────────────────────
function mapErrorStatus(err) {
  const m = (err && err.message) || '';
  const apiStatus = m.match(/→\s(\d{3}):/);
  if (apiStatus) {
    const code = Number(apiStatus[1]);
    // Pass through Google's client-error codes; collapse 5xx to 502 (we are
    // the proxy, their 5xx is our upstream failure).
    if (code >= 400 && code < 500) return code;
    return 502;
  }
  if (m.includes('requires') || m.includes('out of allowed_urls')) return 400;
  if (m.includes('not connected')) return 502;
  return 500;
}

function sendError(res, err) {
  const status = mapErrorStatus(err);
  console.error(`[api.gcal] ${status}:`, err.message);
  res.status(status).json({ status: 'error', message: err.message });
}

/** Coerce a query/body credentialId to a number when numeric, else pass through. */
function coerceCredId(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : v;
}

// ─── LIST CALENDARS ───
// GET /api/gcal/calendars[?minAccessRole=writer&showHidden=true]
// Discover calendar IDs. Each item's .id is usable as calendar_id elsewhere.
router.get('/api/gcal/calendars', jwtOrApiKey, async (req, res) => {
  try {
    const { minAccessRole, showHidden, pageToken, credentialId } = req.query;
    const result = await gcal.listCalendars(req.db, {
      minAccessRole,
      ...(showHidden !== undefined && { showHidden: showHidden === 'true' || showHidden === true }),
      pageToken,
      credentialId: coerceCredId(credentialId),
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── LIST EVENTS ───
router.get('/api/gcal/events', jwtOrApiKey, async (req, res) => {
  try {
    const { timeMin, timeMax, q, maxResults, singleEvents, orderBy, pageToken,
            credentialId, calendarId } = req.query;
    const result = await gcal.listEvents(req.db, {
      timeMin, timeMax, q,
      ...(maxResults   !== undefined && { maxResults: Number(maxResults) }),
      ...(singleEvents !== undefined && { singleEvents: singleEvents === 'true' || singleEvents === true }),
      orderBy, pageToken,
      credentialId: coerceCredId(credentialId),
      calendarId,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── GET ONE ───
router.get('/api/gcal/events/:id', jwtOrApiKey, async (req, res) => {
  try {
    const event = await gcal.getEvent(req.db, {
      eventId:      req.params.id,
      credentialId: coerceCredId(req.query.credentialId),
      calendarId:   req.query.calendarId,
    });
    res.json({ status: 'success', event });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── CREATE ───
router.post('/api/gcal/events', jwtOrApiKey, async (req, res) => {
  try {
    const {
      summary, description, location, start, end, attendees, event,
      sendUpdates, credentialId, calendarId,
    } = req.body || {};
    const created = await gcal.createEvent(req.db, {
      summary, description, location, start, end, attendees, event, sendUpdates,
      credentialId: coerceCredId(credentialId),
      calendarId,
    });
    res.json({ status: 'success', event: created });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── UPDATE (PATCH) ───
router.patch('/api/gcal/events/:id', jwtOrApiKey, async (req, res) => {
  try {
    const {
      summary, description, location, start, end, attendees, event,
      sendUpdates, credentialId, calendarId,
    } = req.body || {};
    const updated = await gcal.updateEvent(req.db, {
      eventId: req.params.id,
      summary, description, location, start, end, attendees, event, sendUpdates,
      credentialId: coerceCredId(credentialId),
      calendarId,
    });
    res.json({ status: 'success', event: updated });
  } catch (err) {
    sendError(res, err);
  }
});

// ─── DELETE ───
router.delete('/api/gcal/events/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await gcal.deleteEvent(req.db, {
      eventId:      req.params.id,
      sendUpdates:  req.query.sendUpdates,
      credentialId: coerceCredId(req.query.credentialId),
      calendarId:   req.query.calendarId,
    });
    res.json({ status: 'success', ...result });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;