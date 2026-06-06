// routes/api.events.js
//
/**
 * Events API
 * routes/api.events.js
 *
 * GET    /api/events                 list with filters (sort=asc|desc)
 * GET    /api/events/:id             single event (with resolved link label)
 * POST   /api/events                 create
 * PATCH  /api/events/:id             update fields (whitelisted)
 * PATCH  /api/events/:id/complete    mark Completed
 * PATCH  /api/events/:id/cancel      mark Canceled (optional body { delete_gcal })
 *
 * Events are first-class dated case/contact obligations (hearings, deadlines,
 * internal milestones) — distinct from appts (meetings) and tasks (to-dos).
 * See services/eventService.js.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const eventService = require('../services/eventService');

// ─── LIST ─────────────────────────────────────────────────────────────────────
router.get('/api/events', jwtOrApiKey, async (req, res) => {
  try {
    const result = await eventService.listEvents(req.db, {
      link_type: req.query.link_type || null,
      link_id:   req.query.link_id   || null,
      status:    req.query.status    || 'Scheduled',
      type:      req.query.type      || null,
      from:      req.query.from      || null,
      to:        req.query.to        || null,
      q:         req.query.q || req.query.query || '',
      sort:      req.query.sort || 'asc',
      limit:     req.query.limit  || 100,
      offset:    req.query.offset || 0,
    });
    res.json(result);  // { data, total }
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch events' });
  }
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
router.get('/api/events/:id(\\d+)', jwtOrApiKey, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  if (!eventId) return res.status(400).json({ status: 'error', message: 'Invalid event ID' });

  try {
    const event = await eventService.getEvent(req.db, eventId);
    if (!event) return res.status(404).json({ status: 'error', message: 'Event not found' });
    res.json({ data: event });
  } catch (err) {
    console.error('GET /api/events/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch event' });
  }
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
router.post('/api/events', jwtOrApiKey, async (req, res) => {
  try {
    const result = await eventService.createEvent(req.db, {
      ...req.body,
      acting_user_id: req.auth?.userId ?? req.body.acting_user_id,
    });
    res.json({
      status:  'success',
      title:   'Event Created!',
      message: `Event #${result.event_id} created`,
      data:    result.event,
    });
  } catch (err) {
    console.error('POST /api/events error:', err);
    res.status(400).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── CREATE (BATCH) ───────────────────────────────────────────────────────────
// One call, many events — e.g. the Ch 13 set (341, confirmation hearing, docs
// deadline) spawned from Pabbly or a workflow. Body:
//   {
//     event_link_type?, event_link_id?, acting_user_id?,   // defaults for all items
//     events: [ { event_title, event_date, ... }, ... ]    // per-item fields win
//   }
// Items run SEQUENTIALLY through eventService.createEvent so each one gets its
// log entry, GCal sync, and optional reminder, and a failure is attributable
// to its item without killing the rest. Returns per-item results.
router.post('/api/events/batch', jwtOrApiKey, async (req, res) => {
  const body  = req.body || {};
  const items = Array.isArray(body.events) ? body.events : null;

  if (!items || !items.length) {
    return res.status(400).json({ status: 'error', title: 'Error', message: 'events array required' });
  }
  if (items.length > 50) {
    return res.status(400).json({ status: 'error', title: 'Error', message: 'Max 50 events per batch' });
  }

  // Top-level defaults applied to every item unless the item sets its own.
  const defaults = {};
  if (body.event_link_type !== undefined) defaults.event_link_type = body.event_link_type;
  if (body.event_link_id   !== undefined) defaults.event_link_id   = body.event_link_id;

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    try {
      const result = await eventService.createEvent(req.db, {
        ...defaults,
        ...item,
        acting_user_id: req.auth?.userId ?? item.acting_user_id ?? body.acting_user_id,
      });
      results.push({ ok: true, index: i, event_id: result.event_id });
    } catch (err) {
      console.error(`POST /api/events/batch item ${i} error:`, err);
      results.push({ ok: false, index: i, error: err.message, event_title: item.event_title || null });
    }
  }

  const created = results.filter(r => r.ok).length;
  const failed  = results.length - created;
  res.status(failed && !created ? 400 : 200).json({
    status:  failed ? (created ? 'warning' : 'error') : 'success',
    title:   failed ? (created ? 'Partial' : 'Error') : 'Events Created!',
    message: `${created} created, ${failed} failed`,
    created,
    failed,
    results,
  });
});

// ─── UPDATE (whitelisted patch + optional reminder swap) ───────────────────────
router.patch('/api/events/:id(\\d+)', jwtOrApiKey, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  if (!eventId) return res.status(400).json({ status: 'error', message: 'Invalid event ID' });

  // `reminder` is not a column — pull it out so it doesn't trip the column
  // whitelist. Its PRESENCE (even as null) means "act on the reminder";
  // absence means "leave reminders alone".
  const body = req.body || {};
  const hasReminder = Object.prototype.hasOwnProperty.call(body, 'reminder');
  const { reminder, ...fields } = body;

  if (!Object.keys(fields).length && !hasReminder) {
    return res.status(400).json({ status: 'error', message: 'No fields to update' });
  }

  try {
    const result = await eventService.updateEvent(
      req.db, eventId, fields, req.auth?.userId || 0,
      hasReminder ? { reminder } : {}
    );
    res.json({ status: 'success', title: 'Updated', message: 'Event updated', data: result.event });
  } catch (err) {
    console.error('PATCH /api/events/:id error:', err);
    // FOLLOW-UP: eventService now throws validation errors on bad date/time
    // input (e.g. "Invalid event_date …", "event_date cannot be empty"). These
    // fall through to 500 below; they are client errors and should map to 400.
    const status = err.message.includes('blocked') ? 400
                 : err.message.includes('not found') ? 404
                 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── COMPLETE ─────────────────────────────────────────────────────────────────
router.patch('/api/events/:id(\\d+)/complete', jwtOrApiKey, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  if (!eventId) return res.status(400).json({ status: 'error', message: 'Invalid event ID' });

  try {
    const result = await eventService.completeEvent(req.db, eventId, req.auth?.userId || 0);
    res.json({ status: 'success', title: 'Done!', message: 'Event marked Completed.', data: result.event });
  } catch (err) {
    console.error('PATCH /api/events/:id/complete error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already') ? 400
                 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

// ─── CANCEL ───────────────────────────────────────────────────────────────────
router.patch('/api/events/:id(\\d+)/cancel', jwtOrApiKey, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  if (!eventId) return res.status(400).json({ status: 'error', message: 'Invalid event ID' });

  const delete_gcal = req.body && req.body.delete_gcal === false ? false : true;

  try {
    const result = await eventService.cancelEvent(req.db, eventId, req.auth?.userId || 0, { delete_gcal });
    res.json({ status: 'success', title: 'Canceled', message: 'Event canceled.', data: result.event });
  } catch (err) {
    console.error('PATCH /api/events/:id/cancel error:', err);
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('already') ? 400
                 : 500;
    res.status(status).json({ status: 'error', title: 'Error', message: err.message });
  }
});

module.exports = router;