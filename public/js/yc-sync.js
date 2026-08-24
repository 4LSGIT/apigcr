/* public/js/yc-sync.js — the YisraCase sync bus (Slice 1)
 *
 * Cross-frame + cross-browser-tab data consistency. One announcement channel:
 * a writer says "case AAAA's case_stage is now Filed", and every frame in
 * every tab that cares updates itself. No hub, no fanout, no hop counter —
 * BroadcastChannel is same-origin broadcast by construction and reaches every
 * frame at any depth AND every other browser tab of this app.
 *
 * Design: ref/YISRACASE_STORE_AND_BUS_DESIGN_V2.md
 *
 * ── THE ONE RULE (design §3.6) ──────────────────────────────────────────────
 *
 *   A HANDLER TRIGGERED BY A BUS MESSAGE MUST NEVER EMIT.
 *
 * This is load-bearing, and it is the only thing standing between this file
 * and an infinite loop. It holds today because every write path is a USER
 * gesture and every bus handler is a programmatic paint:
 *
 *   · bindValue sets `.value` in script → no `change` event fires → no PATCH
 *     → no response → no sniff → no emit.
 *   · YCForm.refresh() populates; it never saves.
 *   · checklistView's subscriber writes cl.body and repaints; it never calls
 *     saveBody().
 *
 * If you add a subscriber, it may read, merge, and paint. It may NOT call an
 * API writer, dispatch a synthetic `change`, or call YC.emit. Keep it that
 * way.
 *
 * ── What rides the bus ───────────────────────────────────────────────────────
 *
 * VALUES, not invalidations (§3.1): `{field: newValue}`. A subscriber never
 * has to re-fetch to find out what changed. Emits are idempotent — the same
 * message delivered twice is a no-op, which is why duplicate coverage (a
 * writer that both auto-sniffs and emits explicitly) is free.
 *
 * SCALARS only. Aggregate arrays (a contact's phones/emails/addresses) do NOT
 * ride the bus; they refresh through the existing `form-saved` path.
 *
 * ── RESERVED FIELD: `yc_refetch` (design §3.1 amendment, v2.2 + v2.3) ───────
 *
 * `yc_refetch` CARRIES NO VALUE. It means "refetch this entity". On an
 * otherwise values-only bus it exists for changes whose values the sniff
 * cannot honestly recover. There are now two such shapes:
 *
 *   1. THE CHANGE IS AN ABSENCE (v2.2). The cross-contact transfer, on two
 *      endpoints: `PATCH /api/contacts/:id?force=true` (the contact-form save)
 *      and `POST /api/contact-{phones,emails}?force=true` (the revive flow).
 *      Both move a phone/email row OFF a donor contact; nothing about the
 *      donor has a new `{column: value}` — a child row simply left. One
 *      message per unique donor.
 *
 *   2. THE RESPONSE DOES NOT CARRY THE VALUES (v2.3, appts + events). Every
 *      appt/event write endpoint is a marker for this reason — see the
 *      appt/event matcher comments below for the per-endpoint detail.
 *
 * A handler receiving it MUST NOT merge it into entity state — it is not a
 * column. Answer it with a refetch and return.
 *
 * ── Addresses ───────────────────────────────────────────────────────────────
 *
 *   'case:AAAAAAAA'  'contact:1001'  'appt:55'  'event:12'
 *   'setting:fe-case_types'   ← Slice 2: an app_settings row, not an entity
 *
 * Subscribe to a specific entity, or to `'case:*'` for every case (the Cases
 * tab's "something, somewhere, changed" subscription). The wildcard is a
 * PREFIX match on the type, so 'case:*' never matches 'contact:1'.
 *
 * `appt:*` / `event:*` carry TWO kinds of traffic and a reader must cope with
 * both: `{yc_refetch:1}` markers from the sniff (every write endpoint), and
 * real note values from checklistView's explicit emit (`{appt_note: '…'}` /
 * `{event_note: '…'}`, the only writer that knows what it wrote). EVERY
 * CURRENT READER IS A QUERY VIEW — a case's appt table, the shell's Appts tab,
 * the calendar — so the correct handling of ANY message on these addresses is
 * "refetch", never "parse the fields". Wildcard readers must not branch on
 * field names. A future entity-scoped reader (one open appointment) may read
 * the note value; nothing does today.
 *
 * `setting:<key>` carries ONE field, `value` — the raw stored string, exactly
 * as app_settings holds it (JSON-stringified for structured settings).
 * Consumers parse; the bus does not. See applyFeSetting in scripts.js, which
 * mirrors /api/firm-data's fe-* semantics for the frontend settings map.
 */
(function () {
  'use strict';

  // Idempotent on double-load: two <script> tags, or a page that loads this
  // and is then re-entered, must not blow away live subscriptions.
  if (window.YC) return;

  var CHANNEL = 'yc-sync';
  var LOG_MAX = 50;

  /* addr -> field -> [handlers]. '*' is a legitimate key in the field map;
     'case:*' is a legitimate key in the addr map. Both are resolved at
     dispatch time, never at subscribe time. */
  var subs = Object.create(null);

  var bc = null;
  var warnedNoBc = false;

  /**
   * Normalize a changes object to `{field: newValue}`.
   *
   * Two input shapes are accepted, deliberately:
   *   · the API diff shape `{field: {from, to}}` — what caseService and
   *     contactService put in `data.changes`
   *   · a plain `{field: value}` — what an explicit emit sends, and what the
   *     new advance/docket `changes` keys carry
   *
   * A `{from, to}` object is recognised by having a `to` key, not by having
   * exactly two keys: `{from, to}` is the shape those services build, and a
   * legitimate scalar column value is never an object.
   */
  function normalize(changes) {
    var out = {};
    if (!changes || typeof changes !== 'object') return out;
    for (var k in changes) {
      if (!Object.prototype.hasOwnProperty.call(changes, k)) continue;
      var v = changes[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          Object.prototype.hasOwnProperty.call(v, 'to')) {
        out[k] = v.to;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** 'case:AAAA' -> 'case'. Everything before the FIRST colon. */
  function typeOf(addr) {
    var s = String(addr || '');
    var i = s.indexOf(':');
    return i === -1 ? s : s.slice(0, i);
  }

  /* Which subscription keys a concrete address should be delivered to: the
     address itself, and its type wildcard. */
  function addrKeysFor(addr) {
    return [String(addr), typeOf(addr) + ':*'];
  }

  function dispatch(msg) {
    if (!msg || !msg.addr || !msg.fields) return;

    // Ring buffer — the traceability answer. `origin` says who wrote it.
    YC._log.push(msg);
    if (YC._log.length > LOG_MAX) YC._log.shift();

    var keys = addrKeysFor(msg.addr);
    for (var i = 0; i < keys.length; i++) {
      var byField = subs[keys[i]];
      if (!byField) continue;

      // A '*' subscriber gets the whole fields object once; a field
      // subscriber gets it only if its field is present.
      var buckets = [];
      if (byField['*']) buckets.push(byField['*']);
      for (var f in msg.fields) {
        if (!Object.prototype.hasOwnProperty.call(msg.fields, f)) continue;
        if (byField[f]) buckets.push(byField[f]);
      }

      for (var b = 0; b < buckets.length; b++) {
        // Copy: a handler that unsubscribes itself must not shift the array
        // out from under this loop.
        var list = buckets[b].slice();
        for (var h = 0; h < list.length; h++) {
          try {
            list[h](msg.fields, msg);
          } catch (err) {
            // One bad subscriber must never cost the others their message.
            console.warn('[yc-sync] handler failed for ' + msg.addr + ':', err);
          }
        }
      }
    }
  }

  function openChannel() {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = function (e) {
        // BC skips the sender's own context, so anything arriving here is
        // from another frame or another browser tab.
        try { dispatch(e && e.data); } catch (err) {
          console.warn('[yc-sync] dispatch failed:', err);
        }
      };
    } catch (err) {
      bc = null;
      if (!warnedNoBc) {
        warnedNoBc = true;
        console.warn('[yc-sync] BroadcastChannel unavailable — ' +
                     'this frame will only see its own emits.', err);
      }
    }
  }

  var YC = {
    _log: [],

    /**
     * Announce a change.
     *
     * @param {string} addr    'case:AAAA' | 'contact:1001' | 'appt:5' | 'event:9'
     * @param {object} changes {field:{from,to}} or {field: value}
     * @param {string} origin  trace string, e.g. 'checklistView:saveBody'
     */
    emit: function (addr, changes, origin) {
      if (!addr) return;
      var fields = normalize(changes);
      // Nothing changed → nothing to say. This is the guard that keeps a
      // no-op PATCH (same value written twice) off the bus entirely.
      if (!Object.keys(fields).length) return;

      var msg = {
        addr:   String(addr),
        fields: fields,
        origin: origin || null,
        ts:     Date.now(),
      };

      // Local first, then the wire. Local dispatch is what keeps the WRITING
      // frame's own state current (BC deliberately skips the sender).
      dispatch(msg);
      if (bc) {
        try { bc.postMessage(msg); }
        catch (err) { console.warn('[yc-sync] postMessage failed:', err); }
      }
    },

    /**
     * Subscribe.
     *
     * @param {string}   addr   'case:AAAA', or 'case:*' for every case
     * @param {string}   field  a column name, or '*' for any
     * @param {function} fn     (fields, msg) => void — MUST NOT EMIT (§3.6)
     * @returns {function} unsubscribe
     */
    on: function (addr, field, fn) {
      if (typeof fn !== 'function') return function () {};
      var a = String(addr);
      var f = String(field || '*');
      var byField = subs[a] || (subs[a] = Object.create(null));
      var list = byField[f] || (byField[f] = []);
      list.push(fn);

      var done = false;
      return function unsubscribe() {
        if (done) return;
        done = true;
        var i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      };
    },

    /**
     * Bind one field to one input element.
     *
     * THE DIRTY GUARD is the whole point: a bus message must never eat what
     * the user is in the middle of typing. Two fences —
     *   · the element is focused (they are in it right now)
     *   · data-yc-dirty="1" (they typed and have not saved; binding sites set
     *     this on input and clear it on a successful save)
     *
     * Sets `.value` programmatically, which fires no `change` event — that is
     * what makes this safe under §3.6.
     *
     * NOT for YCForm-managed fields: those refresh through YCForm.refresh(),
     * which carries its own dirty and typing fences.
     */
    bindValue: function (addr, field, el) {
      if (!el) return function () {};
      return YC.on(addr, field, function (fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, field)) return;
        if (el === document.activeElement) return;
        if (el.dataset && el.dataset.ycDirty === '1') return;
        var v = fields[field];
        el.value = v == null ? '' : v;
      });
    },

    /**
     * Shell-only hook, called from index.html's apiSend at the success-return
     * point. Turns "an API call just succeeded" into an emit, with no work at
     * the writer.
     *
     * This is why the forget-to-emit bug class does not exist: every frame's
     * API traffic funnels through the shell's single apiSend (iframes alias
     * it, deep frames call window.top.apiSend), so ONE hook covers every
     * current and future writer of these five endpoints.
     *
     * ── GETTER CONTRACT v2 (Slice 2b) ────────────────────────────────────
     *
     * A matcher's getter is called `(responseBody, urlCapture)` and may return
     * EITHER of two shapes:
     *
     *   · a FIELDS OBJECT — `{field: value}` or the API `{field:{from,to}}`
     *     diff. One emit, to `${type}:${urlCapture}`. This is the original
     *     contract and every pre-2b getter still uses it.
     *
     *   · an ARRAY of `{addr, fields}` — one emit per entry, each carrying the
     *     same `auto:` origin. The address comes from the ENTRY, which is what
     *     lets one response announce (a) more than one entity and (b) an
     *     entity the URL never named. Two things need that: the transfer
     *     donor (a second contact, absent from the URL) and the app-settings
     *     CREATE route (no `/:key` segment at all — the key is in the body).
     *
     * An empty array emits nothing; an entry whose fields normalize to empty
     * is skipped by `emit` itself. Idempotence and `_log` are per-emit and
     * unchanged — each entry is an independent message.
     *
     * @param {string} method    'PATCH' | 'POST' | 'PUT' | …
     * @param {string} endpoint  the path as passed to apiSend
     * @param {*}      body      the parsed response body
     */
    _sniff: function (method, endpoint, body) {
      var m = String(method || '').toUpperCase();
      // PUT admitted for Slice 2 (app-settings is a PUT route). The gate is
      // still a gate: GET/DELETE/HEAD never reach a matcher, and a matcher may
      // narrow further via its own optional method list (see MATCHERS).
      if (m !== 'PATCH' && m !== 'POST' && m !== 'PUT') return;

      // STRIP THE QUERY STRING before matching. The 409 cross-contact
      // transfer retries as `PATCH /api/contacts/:id?force=true`
      // (contact-form.html:696, :1399) — the save most likely to have just
      // moved data between two contacts is exactly the one a bare regex
      // would miss.
      var path = String(endpoint || '').split('?')[0];

      for (var i = 0; i < MATCHERS.length; i++) {
        var hit = MATCHERS[i][0].exec(path);
        if (!hit) continue;                       // first match wins, and ends the scan
        // Optional 4th element: the methods THIS endpoint actually accepts.
        // Absent = the global gate above is the whole rule (the original four,
        // which are PATCH/POST endpoints and have no other verb).
        var methods = MATCHERS[i][3];
        if (methods && methods.indexOf(m) === -1) return;
        var type = MATCHERS[i][1];
        // hit[1] is `undefined` for a capture-less matcher (POST /api/app-settings).
        // Such a matcher MUST return the array shape and supply its own addrs.
        var id = hit[1];
        var origin = 'auto:' + m + ' ' + endpoint;

        var out = null;
        try { out = MATCHERS[i][2](body, id); } catch (_) { out = null; }
        if (!out || typeof out !== 'object') return;

        if (Array.isArray(out)) {
          for (var e = 0; e < out.length; e++) {
            var ent = out[e];
            if (!ent || typeof ent !== 'object' || !ent.addr) continue;
            // emit() drops a message whose fields normalize to empty, so the
            // per-entry empty check is that same guard, not a second one.
            YC.emit(ent.addr, ent.fields, origin);
          }
          return;
        }

        if (!Object.keys(out).length) return;
        YC.emit(type + ':' + id, out, origin);
        return;
      }
    },
  };

  /* Endpoint -> (type, where the diff lives in the response[, methods]).
     Order matters only in that the bare `/api/cases/:id` pattern is anchored
     ($), so it cannot swallow /docket or /pipeline/advance. */
  var MATCHERS = [
    [/^\/api\/cases\/([A-Za-z0-9_-]+)$/,                    'case',    function (r) { return r && r.data && r.data.changes; }],
    /* Contacts. TWO entities can change in one response, so this is the array
       shape (getter contract v2).

       Entry 1 is the recipient, semantics unchanged from Slice 1: the scalar
       `data.changes` diff, skipped when empty exactly as before.

       The REST are transfer donors. `PATCH /api/contacts/:id?force=true` with a
       cross-contact phone/email collision MOVES the child row: it is ended on
       the donor and created on the recipient (contactService `_applyPhonePlan`
       / `_applyEmailPlan`, step 5 assembles `data.transferred_from`). The
       donor's change is therefore an ABSENCE — a row left — which has no
       `{column: value}` form, so it gets `yc_refetch` instead. See the
       reserved-field note in the header.

       Response shape (verified): `data.transferred_from` =
       `[{kind, from_contact_id, from_contact_name, phone|email, closed_*_id}]`.

       DEDUPED PER DONOR: transferring a phone AND an email from the same donor
       produces two array items and must produce ONE message — a refetch is a
       refetch, and two would cost that page a second round-trip for nothing.

       The recipient is excluded from the donor list defensively: a donor id
       equal to the id being written is a same-contact move, where nothing was
       left behind and the recipient emit already covers it. */
    [/^\/api\/contacts\/(\d+)$/,                            'contact', function (r, id) {
      var out = [];
      var d = (r && r.data) || null;

      var changes = d && d.changes;
      if (changes && typeof changes === 'object' && Object.keys(changes).length) {
        out.push({ addr: 'contact:' + id, fields: changes });
      }

      var tf = d && d.transferred_from;
      if (Array.isArray(tf)) {
        var seen = Object.create(null);
        for (var i = 0; i < tf.length; i++) {
          var from = tf[i] && tf[i].from_contact_id;
          if (from == null || from === '') continue;
          var key = String(from);
          if (key === String(id)) continue;      // same-contact move: nothing left
          if (seen[key]) continue;               // phone + email, one donor, one message
          seen[key] = true;
          out.push({ addr: 'contact:' + key, fields: { yc_refetch: 1 } });
        }
      }

      return out;
    }],
    [/^\/api\/cases\/([A-Za-z0-9_-]+)\/docket$/,            'case',    function (r) { return r && r.changes; }],
    [/^\/api\/cases\/([A-Za-z0-9_-]+)\/pipeline\/advance$/, 'case',    function (r) { return r && r.changes; }],

    /* app_settings UPDATE (Slice 2). PUT-ONLY on purpose —
       routes/api.appSettings.js has exactly one per-key writer and it is a PUT.
       The 4th element states that, rather than leaning on "no such route
       exists" to keep a PATCH from announcing a setting change.

       The emitted field is `value` — the RAW stored string, byte-for-byte what
       app_settings holds (JSON-stringified for structured settings). The bus
       does not parse; applyFeSetting (scripts.js) does, mirroring the fe-*
       semantics of /api/firm-data.

       Key charset: `.` is included defensively. No live key contains one
       (verified 2026-08-23) and the POST create route's KEY_RE forbids it, but
       app_settings is also writable from the DB console, which has no such
       rule. */
    [/^\/api\/app-settings\/([A-Za-z0-9_.\-]+)$/,           'setting', function (r) {
      return r && r.setting && typeof r.setting.value === 'string'
        ? { value: r.setting.value } : null;
    }, ['PUT']],

    /* app_settings CREATE (Slice 2b). The create route is `POST` on the BARE
       collection path — there is no `/:key` segment to capture, so the address
       cannot come from the URL. It comes from the response instead
       (`res.status(201).json({status:'success', setting: row})`), which is the
       whole reason the getter contract grew the array shape.

       This closes Slice-2 close-out Finding 2 with ZERO settings.html edits.
       Every open frame's `setting:*` / `setting:fe-…` subscriber already
       handles the message, and that includes the WRITING shell: `emit`
       dispatches locally before it hits the wire, so index.html's `setting:*`
       subscriber updates that realm's `firmData.settings` on the echo. The
       create handler in settings.html not calling `loadFirmData()` (unlike its
       PUT siblings) therefore stops mattering for any frame that is open.

       Fails closed on a non-string value, same as the PUT matcher: the route
       refuses non-strings with a 400, so that shape can only come from a
       future/altered response, and broadcasting an object would silently
       change every subscriber's contract. */
    [/^\/api\/app-settings$/,                               'setting', function (r) {
      var s = r && r.setting;
      if (!s || typeof s.key !== 'string' || !s.key) return null;
      if (typeof s.value !== 'string') return null;
      return [{ addr: 'setting:' + s.key, fields: { value: s.value } }];
    }, ['POST']],

    /* Contact phone / email REVIVE (Slice 2c) — the SECOND transfer endpoint.
       `contact-form.html`'s reviveRow (:1399) brings an ended row back with
       `POST /api/contact-{phones,emails}` and retries `?force=true` on a 409,
       which ends the value on whoever currently holds it. Same donor absence
       as the aggregate PATCH path, different endpoint, and — the trap —
       A DIFFERENT RESPONSE SHAPE:

         PATCH /api/contacts/:id  →  data.transferred_from = [{ from_contact_id, kind, … }]
         POST  /api/contact-phones →      transferred_from =  { contact_id, contact_name, phone_id }

       Top level, not under `data`. SINGULAR object, not an array. And the id
       key is `contact_id`, not `from_contact_id` — a getter copied from the
       contacts matcher would read `undefined` and silently announce nothing.
       Verified against contactPhoneService/contactEmailService createContact*.

       DONOR ONLY, deliberately. The RECIPIENT is the page that clicked Revive
       and it already refetches twice (reviveRow's own GET, then the `form-saved`
       refetch); a recipient emit would make that three, because contact.html's
       `yc_refetch` branch has no `lastFormSavedAt`-style coalescing fence. A
       recipient open in some OTHER frame falls under the recipient-aggregate
       gap documented in design v2.2 — unchanged by this matcher.

       No `/api/contact-addresses` matcher: addresses have no cross-contact
       uniqueness, so that route has no `force` opt, no 409 path and no
       `transferred_from` (contactAddressService.js:26). Nothing to announce. */
    [/^\/api\/contact-phones$/, 'contact', reviveDonorGetter('phone'), ['POST']],
    [/^\/api\/contact-emails$/, 'contact', reviveDonorGetter('email'), ['POST']],

    /* ── APPOINTMENTS & EVENTS (Slice 3) ──────────────────────────────────
       These matchers RETIRE the `appt-updated` / `event-updated` postMessage
       system. That system worked by having each writer post to the shell,
       which then walked its own iframes calling refreshAppts()/refreshEvents()
       — so it reached the shell's direct children and nothing else, and never
       another browser tab. Every writer already funnels through the shell's
       apiSend, so the sniff covers them all with no writer edits at all,
       including the four that never posted (apptform2's linkCase/createCase,
       both PATCH sites, and every future writer of these endpoints).

       ALL OF THEM EMIT A MARKER, `{yc_refetch:1}`, and the honesty of that is
       endpoint-specific:

         PATCH /api/appts/:id     `{status, message, updated_fields}` — a raw
                                  UPDATE. The NAMES of the written columns come
                                  back; the VALUES do not. Nothing to announce
                                  but the need.
         POST  /api/appts/:id/attended, /no-show, /api/appts/cancel,
               /api/appts/reschedule
                                  `{status, title, message}` — status actions
                                  whose whole effect (appt_status, log rows,
                                  sequence enrollment, a successor appt) is far
                                  wider than any field list.
         PATCH /api/events/:id, /complete, /cancel
                                  these DO return the fresh row under `data`.
                                  A marker is emitted anyway, for uniformity:
                                  every reader today is a query view that
                                  refetches regardless, so carrying values
                                  would buy nothing and would fork the
                                  appt/event reader contract into two shapes.
                                  Values-on-event is a clean future extension
                                  — return `r.data` instead of the marker here
                                  — the day a reader wants them.

       No DELETE matchers: neither resource has a DELETE route (verified
       2026-08-24). Cancel is the delete analogue and is covered above. The
       global method gate in _sniff still drops DELETE before any matcher runs.

       No `/api/events/batch` matcher: it has no client-side caller (workflows
       and the court pipeline call it server-side, where there is no apiSend to
       sniff). Server-side writers stay invisible to the bus until the Slice-4
       change feed — see the design doc's accepted costs. */
    [/^\/api\/appts\/(\d+)$/,                        'appt',  markerGetter,          ['PATCH']],
    [/^\/api\/appts\/(\d+)\/(?:attended|no-show)$/,  'appt',  markerGetter,          ['POST']],
    [/^\/api\/appts$/,                               'appt',  createGetter('appt_id'),  ['POST']],
    [/^\/api\/appts\/cancel$/,                       'appt',  bodyIdGetter('appt'),  ['POST']],
    [/^\/api\/appts\/reschedule$/,                   'appt',  rescheduleGetter,      ['POST']],

    [/^\/api\/events\/(\d+)$/,                       'event', markerGetter,          ['PATCH']],
    [/^\/api\/events\/(\d+)\/(?:complete|cancel)$/,  'event', markerGetter,          ['PATCH']],
    [/^\/api\/events$/,                              'event', createGetter('event_id'), ['POST']],
  ];

  /**
   * The id is in the URL — announce the need against it.
   *
   * Legacy OBJECT return (getter contract v1): `_sniff` addresses it as
   * `${type}:${urlCapture}`, which is exactly right when the URL names the
   * row. Non-capturing groups in those patterns keep hit[1] on the id.
   *
   * @param   {*}      _r  response body — deliberately unread
   * @param   {string} id  the URL capture
   * @returns {object|null}
   */
  function markerGetter(_r, id) {
    return id ? { yc_refetch: 1 } : null;
  }

  /**
   * Collection-path CREATE: the id exists only in the response body.
   *
   * Array return (getter contract v2), for the same reason the app-settings
   * create matcher uses it — there is no `/:id` segment to capture, so the
   * address has to come from the entry.
   *
   * FAILS CLOSED. A body without the id key announces nothing rather than
   * emitting `appt:undefined`, which would address a row that does not exist
   * and log a message no subscriber can act on. The revive getter is the
   * precedent.
   *
   * @param   {string} idKey 'appt_id' (POST /api/appts) | 'event_id' (POST /api/events)
   * @returns {function(object): (Array|null)}
   */
  function createGetter(idKey) {
    var type = idKey === 'appt_id' ? 'appt' : 'event';
    return function (r) {
      // Both create routes wrap the row under `data` — appts as the service
      // result `{appt_id, appt, appt_date_utc}`, events as the hydrated row
      // itself. `data[idKey]` reads correctly against both.
      var d = r && r.data;
      var id = d && d[idKey];
      if (id == null || id === '') return null;
      return [{ addr: type + ':' + id, fields: { yc_refetch: 1 } }];
    };
  }

  /**
   * Collection-path ACTION whose subject is named in the REQUEST body.
   *
   * `POST /api/appts/cancel` takes `{appt: <id>}` and the sniff never sees a
   * request body — so routes/api.appts.js echoes the service's canonical
   * `appt_id` back in the response purely for this. Same fail-closed rule as
   * createGetter: no id, no message.
   *
   * @param   {string} type 'appt'
   * @returns {function(object): (Array|null)}
   */
  function bodyIdGetter(type) {
    return function (r) {
      var id = r && r.appt_id;
      if (id == null || id === '') return null;
      return [{ addr: type + ':' + id, fields: { yc_refetch: 1 } }];
    };
  }

  /**
   * Reschedule — the one write that touches TWO appointments.
   *
   * "Now" ends the old appt as Rescheduled AND creates a successor; "later"
   * only marks the old one. The route echoes `appt_id` (old) always and
   * `new_appt_id` when there is a successor, so both are announced.
   *
   * Announcing both is belt and braces for TODAY — every reader is a wildcard
   * query view, so either message alone would already trigger the refetch —
   * and correctness for tomorrow, when an entity-scoped `appt:<id>` reader
   * exists. Deduped defensively; the two ids can never actually collide.
   */
  function rescheduleGetter(r) {
    var out = [];
    var seen = Object.create(null);
    var ids = [r && r.appt_id, r && r.new_appt_id];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (id == null || id === '') continue;
      if (seen[String(id)]) continue;
      seen[String(id)] = true;
      out.push({ addr: 'appt:' + id, fields: { yc_refetch: 1 } });
    }
    return out;
  }

  /**
   * Getter factory for the two revive endpoints — one shape, two row keys.
   *
   * @param   {string} rowKey 'phone' | 'email' — where the created row sits in
   *                          the 201 body, and the only place the RECIPIENT id
   *                          appears (there is no `:id` in the URL to capture).
   * @returns {function(object): (Array|null)}
   */
  function reviveDonorGetter(rowKey) {
    return function (r) {
      var tf = r && r.transferred_from;
      // Fail closed on the ARRAY shape: that is the aggregate PATCH path's
      // payload, and seeing it here means the route's contract moved.
      if (!tf || typeof tf !== 'object' || Array.isArray(tf)) return null;

      var donor = tf.contact_id;
      if (donor == null || donor === '') return null;

      // Self-exclusion, defensive: the route rejects a same-contact collision
      // as a 400 before it ever reaches the force path, so this should be
      // unreachable — but a donor === recipient refetch would be pure noise.
      var row = r[rowKey];
      var recipient = row && row.contact_id;
      if (recipient != null && String(recipient) === String(donor)) return null;

      return [{ addr: 'contact:' + donor, fields: { yc_refetch: 1 } }];
    };
  }

  openChannel();
  window.YC = YC;
})();
