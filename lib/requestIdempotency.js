// lib/requestIdempotency.js
//
/**
 * Canonical, user-scoped request idempotency (Ask Casey actions P4-minimal).
 *
 * NOT Casey-specific and not a new endpoint. Any caller of a wired route may
 * send an `Idempotency-Key` request header; a caller that sends none is
 * completely unaffected (no row, no extra query, no behaviour change). That is
 * the property this module protects first — native YisraCase callers and
 * workflow/hook x-api-key callers keep their exact current behaviour.
 *
 * WHY: a create reached through the user's own browser is single-flighted in
 * the page, but two tabs — or a socket timeout AFTER the server committed —
 * can still submit the same create twice. The key makes the second submission
 * replay the first one's response instead of writing a second record.
 *
 * ── THE THREE OUTCOMES (ASK_CASEY_ACTIONS_PLAN P4) ────────────────────────
 *   not-applied  the claim was taken and `fn` threw. The row is deleted, the
 *                route's own error surfaces, and the SAME key may be retried.
 *   applied      the row holds `status='applied'` + the canonical result. A
 *                repeat replays that result value-for-value with
 *                `replayed: true`, and `fn` is never called again.
 *   unknown      the row is still `in_flight` and older than the staleness
 *                window, i.e. the process died between the claim and the
 *                settle. A repeat is refused 409 with outcome `unknown`: the
 *                operation MAY have applied, so the caller must look at the
 *                record, not retry. The row is deliberately NEVER taken over
 *                — a takeover is exactly the double-apply this module exists
 *                to prevent. Recovery is to verify, then submit a NEW key.
 *   (a fresh `in_flight` row is 409 outcome `in_flight` — "still being
 *   applied", retry shortly.)
 *
 * ── CLAIM / TRANSACTION INTERACTION ──────────────────────────────────────
 * The claim must be COMMITTED before `fn` runs, or a second tab racing the
 * first sees nothing and both write. So the claim is a single autocommitted
 * INSERT on the POOL, outside and before whatever transaction `fn` opens for
 * itself — every wired route's create path opens its own `withTransaction`
 * span inside its service, and the claim is not part of it.
 *
 * Deliberately NOT wrapped in `withTransaction`:
 *   - each of the three statements here (claim / settle / release) is one
 *     atomic statement, so there is no multi-statement span to protect; and
 *   - `withTransaction`'s default `retries:1` would be actively wrong on the
 *     claim — a retry after a lost commit ack would hit its own row as
 *     ER_DUP_ENTRY and 409 the caller's FIRST attempt.
 * `db` is therefore required to be the pool; passing a transaction connection
 * throws, because the claim would then commit with (or roll back alongside)
 * the business write and could not fence a concurrent tab at all.
 *
 * The business transaction rolling back is the not-applied case above: `fn`
 * throws, the in_flight row is DELETEd and the key is reusable. A row is left
 * in_flight only when the settle itself cannot run (process death, DB
 * unreachable) — handled as `unknown`, never as a permanent silent block.
 *
 * KNOWN ACCEPTED EDGE: startup/db.js retries pool.query once on a transient
 * dead-socket error. If that retry lands on the claim INSERT after the server
 * had already applied it, the retry sees its own row and the caller gets a
 * fresh-in_flight 409 on an attempt that wrote nothing. Rare, and it fails
 * CLOSED (nothing written twice); recovery is the unknown path above.
 *
 * ── WIRED ROUTES (scope literal, chosen server-side) ─────────────────────
 *   POST /api/tasks              tasks.create
 *   POST /api/events             events.create
 *   POST /api/appts              appts.create
 *   POST /api/contact-phones     contact_phones.create
 *   POST /api/contact-emails     contact_emails.create
 *   POST /api/contact-addresses  contact_addresses.create
 *   POST /api/hooks              hooks.create
 *   POST /scheduled-jobs         scheduled_jobs.create
 *   POST /workflows/bulk         workflows.bulk_create
 *   POST /workflows/:id/steps    workflows.step_insert
 *   POST /sequences/templates/:id/steps  sequences.step_insert
 *   POST /api/reports            reports.create
 *   POST /api/email-ingest/rules email_ingest.rules_create
 *   POST /api/phone-ingest/rules phone_ingest.rules_create
 *   POST /api/phone-lines/:id/sms   phone_lines.sms_send   (SEND — see below)
 *   POST /api/mail/send             mail.send              (SEND — see below)
 *   POST /workflows/:id/start       workflows.start        (FAN-OUT — the SEND rule)
 *   POST /sequences/enroll          sequences.enroll       (FAN-OUT — the SEND rule)
 * No other route reads the header; POST /api/events/batch deliberately does
 * not (its per-item results are not one canonical response to replay).
 * Scopes are server-chosen literals — `git grep "idempotentRequest(req, '"`
 * lists them.
 *
 * ── SENDS (A14): A FAILED SEND KEEPS ITS CLAIM ───────────────────────────
 * A create that throws wrote nothing (its transaction rolled back), so the
 * claim is released and the key is reusable. A send is different: once the
 * provider call has been made, a throw (timeout, socket reset, a provider
 * 5xx) can follow a message that DID go out. The two send routes therefore
 * pass `releaseOnError: releaseOnRefusalOnly` — the claim is given back only
 * for a status-bearing 4xx, which those routes raise strictly BEFORE dispatch
 * (bad body, no access, inactive line / box, budget). Anything else leaves the
 * row in_flight: a repeat of the key is 409 `in_flight` and then `unknown`
 * ("check the record, do not retry"), never a second send. Recovery is to
 * check the conversation, then send with a NEW key.
 *
 * A workflow START (A17.7) is the same shape of risk — once its execution row
 * commits, the detached advance may already have run steps that send, write
 * or start other runs — so it takes the same rule: only a pre-INSERT 4xx
 * refusal (404, inactive, never published, bad contact_id) releases; a 5xx or
 * a lost commit acknowledgement keeps the claim, and the key can never start
 * a second run. Recovery is to check the workflow's executions.
 *
 * A sequence ENROLL (A18.4a) is the same shape again — once the enrollment row
 * commits, its scheduled steps send. The route releases on a status-bearing
 * 4xx (400 / 404, ALREADY_ENROLLED / NEVER_PUBLISHED / EMPTY_SEQUENCE 409s)
 * and on ENROLL_BUSY's 503 (the per-identity lock was never granted, so no row
 * was inserted); SCHEDULING_FAILED (a row was inserted, then cancelled) and any
 * other 5xx keep the claim. Recovery is to check the contact's enrollments.
 *
 * Schema: ref/migrations/2026-10-22_request_idempotency.sql
 * Migration runner: scripts/caseyP4Idempotency.js
 */

'use strict';

/** Request header the key rides in. Node lowercases inbound header names. */
const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Accepted key shape. Bounded and strict on purpose:
 *   - 8..100 chars: the column is varchar(100) and sql_mode is relaxed, so a
 *     longer key would be stored TRUNCATED and two different keys would alias
 *     into one row — a false replay. Validate at the door (CLAUDE.md).
 *   - no whitespace / control chars, so no PAD-SPACE surprise on compare.
 * A browser-minted UUID (36 chars) passes.
 */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

/** users.user is TINYINT — an out-of-range actor id would be CLAMPED silently. */
const MAX_USER_ID = 127;

/**
 * How long a claim may sit in_flight before a repeat is reported `unknown`
 * rather than `in_flight`. Generous versus any create wired here (the slowest
 * touches Google Calendar post-commit), so a genuinely in-progress request is
 * never mislabelled as indeterminate. Measured SERVER-side in SQL — no JS/DB
 * clock skew, and no mysql2 Date-vs-string comparison.
 */
const IN_FLIGHT_STALE_SECONDS = 180;

const SQL = {
  claim:
    'INSERT INTO request_idempotency (user_id, scope, idem_key, status) VALUES (?, ?, ?, \'in_flight\')',
  read:
    'SELECT id, status, result, TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS age_s ' +
    'FROM request_idempotency WHERE user_id = ? AND scope = ? AND idem_key = ? LIMIT 1',
  settle:
    'UPDATE request_idempotency SET status = \'applied\', result = ? WHERE id = ? AND status = \'in_flight\'',
  release:
    'DELETE FROM request_idempotency WHERE id = ? AND status = \'in_flight\'',
};

/** A client-shaped failure: `status` is what the route should answer with. */
function idempotencyError(status, message, outcome) {
  const err = new Error(message);
  err.status = status;
  err.idempotency = { status, outcome };
  return err;
}

/**
 * The key for this request, or null when the caller sent none.
 * Absent / blank (whitespace only) == none: a native caller is untouched.
 * Present but malformed throws a 400-shaped error — never silently ignored,
 * which would quietly drop the protection the caller asked for.
 */
function readIdempotencyKey(req) {
  const raw = req && req.headers ? req.headers[IDEMPOTENCY_HEADER] : null;
  // A repeated header arrives as an array; a duplicated key is ambiguous.
  if (Array.isArray(raw)) {
    throw idempotencyError(400, 'Idempotency-Key must be sent at most once', 'invalid_key');
  }
  if (raw == null) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (!KEY_RE.test(key)) {
    throw idempotencyError(
      400,
      'Idempotency-Key must be 8-100 characters of letters, digits, dot, underscore, colon or hyphen',
      'invalid_key'
    );
  }
  return key;
}

/**
 * The acting staff user for scoping. 0 ("Automations") when the request
 * carries no staff user — the same fallback the contact-subrecord routes use
 * for created_by. Out-of-range ids are refused rather than clamped.
 */
function idempotencyActorId(req) {
  const raw = req && req.auth ? req.auth.userId : null;
  let id = 0;
  if (typeof raw === 'number' && Number.isInteger(raw)) id = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw)) id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id < 0 || id > MAX_USER_ID) {
    throw idempotencyError(400, 'Idempotency-Key is not available for this caller', 'invalid_actor');
  }
  return id;
}

/** JSON columns come back parsed by mysql2; tolerate a string either way. */
function parseStoredResult(stored) {
  if (stored == null) return null;
  if (typeof stored !== 'string') return stored;
  try { return JSON.parse(stored); } catch (_) { return null; }
}

/**
 * Run `fn` at most once per (userId, scope, key).
 *
 *   const { value, replayed } = await withIdempotency(db, { userId, scope, key }, fn);
 *
 * No key  -> `{ value: await fn(), replayed: false, idempotent: false }`.
 * Claimed -> `fn` runs; its return value is stored as the canonical result.
 * Repeat  -> `{ value: <stored>, replayed: true, idempotent: true }`, fn unrun.
 * Racing  -> throws a 409-shaped error (`err.idempotency.outcome` is
 *            'in_flight' or 'unknown').
 *
 * `fn`'s return value must be JSON-serialisable: it is stored with
 * JSON.stringify into a JSON column. A replay carries every value unchanged,
 * but NOT the same bytes — MySQL re-orders JSON object keys on write (by
 * length, then lexicographically), so the replayed response lists the same
 * pairs in a different order. Compare stored results key-order-insensitively
 * (CLAUDE.md, wf50); never byte-wise.
 */
async function withIdempotency(db, { userId, scope, key } = {}, fn, { releaseOnError = null } = {}) {
  if (typeof fn !== 'function') throw new TypeError('withIdempotency: fn must be a function');
  if (key == null || key === '') {
    return { value: await fn(), replayed: false, idempotent: false };
  }
  if (!db || typeof db.getConnection !== 'function') {
    // Fail closed: a transaction connection cannot commit the claim ahead of
    // the business write, so it cannot fence a second submission at all.
    throw new Error('withIdempotency requires the database pool, not a transaction connection');
  }
  if (!scope) throw new TypeError('withIdempotency: scope is required');
  if (!Number.isInteger(userId)) throw new TypeError('withIdempotency: userId must be an integer');

  let claimId = null;
  try {
    const [res] = await db.query(SQL.claim, [userId, scope, key]);
    claimId = res.insertId;
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const [rows] = await db.query(SQL.read, [userId, scope, key]);
      const row = rows && rows[0];
      if (row && row.status === 'applied') {
        return { value: parseStoredResult(row.result), replayed: true, idempotent: true };
      }
      // Still in_flight. Fresh = a sibling submission is mid-apply; stale =
      // nobody is going to settle it and the outcome is indeterminate.
      const stale = !row || Number(row.age_s) >= IN_FLIGHT_STALE_SECONDS;
      throw stale
        ? idempotencyError(409,
            'An earlier submission of this request did not finish and its outcome is unknown. ' +
            'Check whether the record exists before submitting again.', 'unknown')
        : idempotencyError(409, 'The same request is still being applied.', 'in_flight');
    }
    throw err;
  }

  let value;
  try {
    value = await fn();
  } catch (err) {
    // A send that may have dispatched keeps its claim (header, SENDS): the
    // outcome is unknown, and a released key would let the same request send
    // a second time.
    if (typeof releaseOnError === 'function' && !releaseOnError(err)) {
      console.error('[requestIdempotency] claim kept after an ambiguous failure', claimId, scope, err && err.status ? err.status : '', err && err.message);
      throw err;
    }
    // Not applied: give the key back so the caller may retry it as-is.
    try {
      await db.query(SQL.release, [claimId]);
    } catch (releaseErr) {
      console.error('[requestIdempotency] failed to release claim', claimId, releaseErr.message);
    }
    throw err;
  }

  try {
    const json = JSON.stringify(value === undefined ? null : value);
    await db.query(SQL.settle, [json, claimId]);
  } catch (err) {
    // The write COMMITTED; bookkeeping did not. Never fail a successful
    // operation over its receipt — the row stays in_flight, so a repeat of
    // this key reports `unknown` (verify, don't retry) rather than writing
    // twice. `recorded:false` lets a caller log the gap.
    console.error('[requestIdempotency] failed to record applied result', claimId, err.message);
    return { value, replayed: false, idempotent: true, recorded: false };
  }

  return { value, replayed: false, idempotent: true, recorded: true };
}

/**
 * Express adapter: derives pool, actor and key from the request and runs `fn`
 * under the fixed, SERVER-CHOSEN `scope`. The key is read from the header
 * only — nothing in the request body can set it, and it can never change what
 * the route writes, only whether the route writes twice.
 */
function idempotentRequest(req, scope, fn, opts = {}) {
  const key = readIdempotencyKey(req);
  if (key == null) return withIdempotency(req.db, {}, fn);
  return withIdempotency(req.db, { userId: idempotencyActorId(req), scope, key }, fn, opts);
}

/**
 * The send routes' release rule (header, SENDS): only a status-bearing 4xx —
 * a refusal the route raised before dispatching anything — gives the key back.
 */
function releaseOnRefusalOnly(err) {
  const status = err && err.status;
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * Answer a shaped idempotency failure (malformed key 400, racing/unknown
 * claim 409). Returns true when it wrote the response, so a route's catch
 * block is one line:  `if (sendIdempotencyError(res, err)) return;`
 */
function sendIdempotencyError(res, err) {
  if (!err || !err.idempotency) return false;
  res.status(err.idempotency.status).json({
    status: 'error',
    message: err.message,
    idempotency: { outcome: err.idempotency.outcome },
  });
  return true;
}

module.exports = {
  withIdempotency,
  idempotentRequest,
  readIdempotencyKey,
  idempotencyActorId,
  sendIdempotencyError,
  releaseOnRefusalOnly,
  IDEMPOTENCY_HEADER,
  IN_FLIGHT_STALE_SECONDS,
  SQL,
};
