// services/esignAlertService.js
//
/**
 * E-Sign STAFF ALERTS — the one place this subsystem raises a human task.
 * services/esignAlertService.js
 *
 * Phase 1C. Four callers need to put a task in front of a person:
 *
 *   esignWebhookService   declined / bounced envelopes, and signed documents
 *                         that could not be filed automatically
 *   esignService          a completion trigger that could not run
 *   esign/index.js        the low-credit alert
 *   internal_functions    reconciliation failures worth a human look
 *
 * Without this module each of them would re-derive "who gets alerted" from
 * app_settings and re-learn taskService's length rules. It is deliberately
 * tiny and deliberately NOT in services/esign/ — that directory is the
 * vendor-dialect boundary and knows Zoho exists; this knows only about staff.
 *
 * ── ASSIGNEE RESOLUTION ─────────────────────────────────────────────────────
 * `office_alerts_to` is the same setting wf30 step 4 and wf31 read via
 * get_setting, so an admin changes one value and every e-sign alert, every
 * Adobe Sign workflow and the appointment SMS roster all move together.
 *
 * Its stored form is a COMMA-SEPARATED user-id list (apptService fans an SMS
 * out to all of them). taskService.createTask assigns to exactly one user, so
 * we take the FIRST usable id. That matches what wf30 does today — it passes
 * the raw setting straight into create_task's `assigned_to`, which works only
 * because the live value is currently the single id "22". This module parses
 * properly so a future "22,6" does not silently break task creation.
 *
 * ── EVERYTHING HERE IS BEST-EFFORT ──────────────────────────────────────────
 * An alert is a notification ABOUT work that already succeeded or already
 * failed. Throwing from here would convert "the document was filed but nobody
 * was told" into "the webhook 500'd and Zoho will retry forever". So every
 * function logs and returns rather than throwing, and callers may ignore the
 * return value.
 *
 * ── DEDUPE AND AUTO-RESOLVE (2026-08-16) ────────────────────────────────────
 * Some alerts describe a STANDING CONDITION rather than a one-off event. The
 * nightly dead-channel alert is the type case: it fired 2026-07-27 (task 1077)
 * and again 2026-08-15 (task 1114). 1077 was DELETED by the assignee rather
 * than acted on, and 1114 arrived 19 days later with no memory of it. A real
 * week-long outage would have produced seven identical open tasks, none of
 * which would close when the channel came back.
 *
 * `dedupeKey` fixes both halves:
 *
 *   raiseTask   with a key -> at most ONE open task per (source, key). A repeat
 *               occurrence touches the existing task instead of creating a
 *               second, so the row's age says "ongoing", not "stale".
 *   resolveTask with a key -> closes the open task when the condition clears.
 *
 * WHY NOT DEDUPE ON THE TITLE. Titles are not stable across occurrences of the
 * same condition ("E-sign reconciliation: 6 problem(s)" vs "...2 problem(s)")
 * and are not distinct between occurrences of DIFFERENT conditions that happen
 * to share a template ("Signed doc received: <name>" is a new event every
 * time). Title equality would both under- and over-merge.
 *
 * WHERE THE KEY LIVES. `tasks` has no spare column. task_source is filtered by
 * exact equality elsewhere (scripts/esign_e2e_check.js) and is documented
 * immutable; task_link carries live JOIN semantics in taskService.getTask
 * (`task_link_type IS NULL AND task_link != ''` is matched against
 * cases.case_number), so neither can be overloaded. A dedicated
 * `tasks.task_dedupe_key varchar(64)` column is added instead — see
 * ref/2026-08-16_task_dedupe_key.sql.
 *
 * WHY THE KEY IS STAMPED BY A SEPARATE UPDATE rather than passed through
 * createTask: if the migration has not landed, an INSERT naming a missing
 * column throws inside createTask and EVERY e-sign alert is lost. A follow-up
 * UPDATE that fails leaves the task created and merely unkeyed — i.e. exactly
 * the behavior that existed before this feature. An alerting bug must never
 * swallow an alert.
 */

const taskService = require('./taskService');
const { getSetting } = require('./settingsService');

/** app_settings key naming the staff recipient(s). Shared with wf30/wf31. */
const ALERT_RECIPIENT_KEY = 'office_alerts_to';

/** tasks.task_source — marks these as machine-pushed. varchar(50). */
const TASK_SOURCE = 'esign';

// taskService.createTask THROWS above these rather than truncating, because
// sql_mode is not strict. Clip here so an alert is never lost to a long
// document name.
const MAX_TITLE = 100;
const MAX_DESC  = 1000;

/**
 * tasks.task_link_id is varchar(20); signing_requests.linkable_id is
 * varchar(64). sql_mode has no STRICT_TRANS_TABLES, so an over-length id would
 * TRUNCATE SILENTLY and produce a link pointing at nothing — or, worse, at a
 * different row that happens to share the first 20 characters. Over-length ids
 * therefore drop the link entirely and say so in the description. Real case
 * ids are ~8 chars and contact ids are small integers, so this should never
 * fire; it exists because a silently wrong link is undetectable.
 */
const MAX_TASK_LINK_ID = 20;

/** tasks.task_dedupe_key column name. */
const DEDUPE_COLUMN = 'task_dedupe_key';

/**
 * varchar(64). Same silent-truncation hazard as MAX_TASK_LINK_ID, and worse in
 * consequence: two DIFFERENT conditions whose keys share the first 64
 * characters would MERGE, and the second would never raise a task at all. An
 * over-length key is therefore REFUSED (the alert is raised un-keyed) rather
 * than clipped. Worst case is a duplicate task; never a suppressed alert.
 */
const MAX_DEDUPE_KEY = 64;

/**
 * tasks.task_status values that mean "a human still has this in front of
 * them". Mirrors taskService.listTasks' `Incomplete` filter. task_status is an
 * ENUM — these strings are not free text and must not be invented.
 */
const OPEN_STATUSES = ['Pending', 'Due Today', 'Overdue'];

/**
 * The keys in use. Callers pass the STRING LITERAL rather than reading it off
 * this object, because several of them (services/esign/index.js,
 * lib/internal_functions/esign.js) are exercised against a jest mock of this
 * module and would read `undefined` from it. Keep the two in sync.
 */
const DEDUPE_KEYS = {
  /** Reconcile saw webhook-carried moves while the channel was silent. */
  WEBHOOK_DOWN: 'webhook-down',
  /** Local Zoho credit estimate fell below the alert threshold. */
  CREDITS_LOW: 'credits-low',
  /** The nightly reconcile job could not build a provider at all. */
  RECONCILE_PROVIDER: 'reconcile-provider',
  /** The nightly reconcile job finished with per-row failures. */
  RECONCILE_FAILURES: 'reconcile-failures',
};

/**
 * Keys that currently have an auto-resolve wired, and where it fires. Kept as
 * documentation rather than as logic — raiseTask does not care, and a key with
 * no resolve is a legitimate configuration (the task simply waits for a human,
 * which is still an enormous improvement on one task per night).
 *
 *   webhook-down        routes/api.esign.js, on a delivery clearing both gates
 *   credits-low         services/esign/index.js, when the balance latch re-arms
 *   reconcile-provider  lib/internal_functions/esign.js, once getProvider succeeds
 *
 * reconcile-failures is DEDUPED BUT NOT AUTO-RESOLVED, on purpose. A per-row
 * failure that does not recur tonight is not necessarily HANDLED — the envelope
 * may simply have expired out of the outstanding set — so a clean run must not
 * claim someone dealt with it. Contrast reconcile-provider, where a credential
 * that resolves is unambiguously a credential that works.
 */

/**
 * Trailing status marker appended to a deduped task's description.
 *
 *   [still occurring as of 2026-08-16T04:00:00.000Z - seen 3x]
 *
 * It is REPLACED on each suppression, never accumulated, so the description
 * cannot grow without bound and the operator instructions at the end of the
 * original body survive. The occurrence count is parsed back out of the
 * previous marker — it needs no column of its own.
 */
const ONGOING_RE  = /\n*\[still occurring as of [^\]]*?seen (\d+)x\]\s*$/;
const RESOLVED_RE = /\n*\[auto-resolved [^\]]*\]\s*$/;

/** Clip to `max`, marking the cut so a reader knows something was removed. */
function _clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 14)}…(truncated)`;
}

/** Strip any marker this module previously appended. */
function _stripMarker(desc) {
  return String(desc == null ? '' : desc)
    .replace(ONGOING_RE, '')
    .replace(RESOLVED_RE, '')
    .replace(/\s+$/, '');
}

/**
 * Description for a task whose condition is still occurring, or null if the
 * marker cannot be added without eating the body.
 *
 * A description created by raiseTask is clipped to EXACTLY MAX_DESC, so a
 * maximal one has no room for a marker. In that case this returns null and the
 * caller bumps task_last_update alone — a stale-looking timestamp is a smaller
 * loss than clipping the "Action: ..." line off the end of the instructions.
 *
 * @returns {string|null}
 */
function _withOngoingMarker(desc, nowIso) {
  const current = String(desc == null ? '' : desc);
  const prev    = current.match(ONGOING_RE);
  const count   = prev ? (parseInt(prev[1], 10) || 1) + 1 : 2;
  const base    = _stripMarker(current);
  const marker  = `\n\n[still occurring as of ${nowIso} - seen ${count}x]`;
  if (base.length + marker.length > MAX_DESC) return null;
  return base + marker;
}

/** As above, for the auto-resolve note. @returns {string|null} */
function _withResolvedMarker(desc, nowIso) {
  const base   = _stripMarker(desc);
  const marker = `\n\n[auto-resolved ${nowIso} - the condition cleared]`;
  if (base.length + marker.length > MAX_DESC) return null;
  return base + marker;
}

/**
 * Usable dedupe key, or null. Never throws.
 * An unusable key means "raise this alert un-keyed", never "drop this alert".
 */
function _normalizeKey(dedupeKey, title) {
  if (dedupeKey == null) return null;
  const key = String(dedupeKey).trim();
  if (key === '') return null;
  if (key.length > MAX_DEDUPE_KEY) {
    console.warn(
      `[ESIGN ALERT] dedupe key is ${key.length} characters and the column holds ` +
      `${MAX_DEDUPE_KEY} — raising "${title}" UN-KEYED rather than risk a truncated ` +
      `key merging two different conditions.`
    );
    return null;
  }
  return key;
}

/**
 * First usable user id in office_alerts_to, or null.
 * @returns {Promise<number|null>}
 */
async function resolveAlertAssignee(db) {
  let raw;
  try {
    raw = await getSetting(db, ALERT_RECIPIENT_KEY);
  } catch (err) {
    console.error(`[ESIGN ALERT] could not read ${ALERT_RECIPIENT_KEY}: ${err.message}`);
    return null;
  }
  const id = String(raw || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .find((n) => Number.isInteger(n) && n > 0);
  return id == null ? null : id;
}

/**
 * Newest OPEN task carrying this key, or null.
 *
 * NEVER THROWS, and the failure mode is deliberate: a lookup that errors —
 * including "Unknown column 'task_dedupe_key'" before the migration lands —
 * returns null, which sends raiseTask down the CREATE path. A duplicate task
 * is a nuisance; a suppressed alert is a fault.
 */
async function _findOpenByKey(db, key) {
  try {
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT task_id, task_desc
         FROM tasks
        WHERE task_source = ?
          AND \`${DEDUPE_COLUMN}\` = ?
          AND task_status IN (${placeholders})
        ORDER BY task_id DESC
        LIMIT 1`,
      [TASK_SOURCE, key, ...OPEN_STATUSES]
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    console.error(
      `[ESIGN ALERT] dedupe lookup for "${key}" failed (${err && err.message}) — ` +
      `raising the alert rather than suppressing it.`
    );
    return null;
  }
}

/**
 * Stamp the key onto a freshly created task. Best-effort: an unkeyed task is
 * a task that will duplicate next time, which is the pre-existing behavior.
 */
async function _stampKey(db, taskId, key) {
  try {
    await db.query(
      `UPDATE tasks SET \`${DEDUPE_COLUMN}\` = ? WHERE task_id = ?`,
      [key, taskId]
    );
    return true;
  } catch (err) {
    console.error(
      `[ESIGN ALERT] could not stamp dedupe key "${key}" on task #${taskId} ` +
      `(${err && err.message}) — the task stands but will not dedupe. ` +
      `Has ref/2026-08-16_task_dedupe_key.sql been applied?`
    );
    return false;
  }
}

/**
 * Make a suppressed duplicate VISIBLE. Bumps task_last_update so the row does
 * not read as stale, and re-stamps the trailing "still occurring" marker so a
 * human can see the condition is ongoing and how many times it has recurred.
 *
 * Best-effort. The dedupe decision stands whether or not this lands.
 */
async function _touchExisting(db, existing) {
  const nowIso = new Date().toISOString();
  const nextDesc = _withOngoingMarker(existing.task_desc, nowIso);

  try {
    if (nextDesc == null) {
      // No room for the marker without clipping the operator instructions.
      // The timestamp alone still says "seen again just now".
      await db.query('UPDATE tasks SET task_last_update = NOW() WHERE task_id = ?', [existing.task_id]);
      console.warn(
        `[ESIGN ALERT] task #${existing.task_id} description is at the ${MAX_DESC}-char ` +
        `limit — bumped task_last_update without appending the ongoing marker.`
      );
      return;
    }
    await db.query(
      'UPDATE tasks SET task_desc = ?, task_last_update = NOW() WHERE task_id = ?',
      [nextDesc, existing.task_id]
    );
  } catch (err) {
    console.error(`[ESIGN ALERT] could not touch task #${existing.task_id}: ${err && err.message}`);
  }
}

/**
 * Raise a staff task about a signing request.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.desc
 * @param {string} [o.linkableType]  'case' | 'contact' — usually request.linkable_type
 * @param {string} [o.linkableId]
 * @param {boolean} [o.notifyByEmail=true]  taskService's canned assignment email
 * @param {string} [o.dedupeKey]     stable identifier for the CONDITION, not the
 *                                   occurrence. With one set, a second alert
 *                                   raised while the first is still open touches
 *                                   that task instead of creating another. Omit
 *                                   for genuinely per-occurrence alerts (a named
 *                                   document arriving) — those must keep
 *                                   producing one task each.
 * @returns {Promise<{ok:boolean, taskId?:number, actionUrl?:string, deduped?:boolean, reason?:string}>}
 */
async function raiseTask(db, {
  title,
  desc,
  linkableType = null,
  linkableId = null,
  notifyByEmail = true,
  dedupeKey = null,
} = {}) {
  try {
    // Runs BEFORE assignee resolution on purpose: a repeat occurrence should
    // still touch the open task even if office_alerts_to has since been emptied.
    const key = _normalizeKey(dedupeKey, title);
    if (key) {
      const existing = await _findOpenByKey(db, key);
      if (existing) {
        await _touchExisting(db, existing);
        console.log(
          `[ESIGN ALERT] "${title}" suppressed as a duplicate of open task ` +
          `#${existing.task_id} (key "${key}") — task touched, not re-created.`
        );
        // actionUrl is null here rather than re-derived: taskService does not
        // export its URL builder, and no caller reads this field.
        return { ok: true, taskId: existing.task_id, actionUrl: null, deduped: true };
      }
    }

    const assignee = await resolveAlertAssignee(db);
    if (!assignee) {
      console.warn(`[ESIGN ALERT] ${ALERT_RECIPIENT_KEY} names no user — dropping alert: ${title}`);
      return { ok: false, reason: 'no_assignee' };
    }

    // Link only when it will survive the column. See MAX_TASK_LINK_ID.
    let linkType = null;
    let linkId   = null;
    let linkNote = '';
    if (linkableType && linkableId != null && String(linkableId) !== '') {
      const idStr = String(linkableId);
      if (idStr.length <= MAX_TASK_LINK_ID) {
        linkType = linkableType;
        linkId   = idStr;
      } else {
        linkNote = `\n\n(Not linked automatically: ${linkableType} id "${idStr}" is ` +
                   `${idStr.length} characters and the task link column holds ${MAX_TASK_LINK_ID}. ` +
                   `Attach this task to the right record by hand.)`;
      }
    }

    const { task_id, action_url } = await taskService.createTask(db, {
      from:      0,                       // automations user
      to:        assignee,
      title:     _clip(title, MAX_TITLE),
      desc:      _clip(`${desc}${linkNote}`, MAX_DESC),
      link_type: linkType,
      link_id:   linkId,
      source:    TASK_SOURCE,
      send_assignment_email: notifyByEmail,
    });

    if (key) await _stampKey(db, task_id, key);

    console.log(
      `[ESIGN ALERT] task #${task_id} → user ${assignee}: ${title}` +
      (key ? ` (key "${key}")` : '')
    );
    return { ok: true, taskId: task_id, actionUrl: action_url, deduped: false };
  } catch (err) {
    // Swallowed on purpose — see the header. The work this alert describes has
    // already happened either way.
    console.error(`[ESIGN ALERT] failed to raise "${title}": ${err && err.message}`);
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

/**
 * Close every open e-sign task carrying `dedupeKey` — the condition it
 * describes has cleared.
 *
 * Completed rather than Deleted: taskService's own convention is
 * "completed = acted, deleted = dismissed", and the condition genuinely
 * resolved. Going through taskService.completeTask (rather than a bare UPDATE)
 * keeps the task log entry and the due-reminder cancellation.
 *
 * Same best-effort contract as everything else here: logs and returns, never
 * throws. A resolve that fails leaves an open task a human can close — the
 * strictly safer direction to fail in.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.dedupeKey
 * @returns {Promise<{ok:boolean, resolved:number[], count:number, reason?:string}>}
 */
async function resolveTask(db, { dedupeKey } = {}) {
  const key = _normalizeKey(dedupeKey, '(resolve)');
  if (!key) return { ok: false, resolved: [], count: 0, reason: 'no_key' };

  let rows;
  try {
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    [rows] = await db.query(
      `SELECT task_id, task_desc
         FROM tasks
        WHERE task_source = ?
          AND \`${DEDUPE_COLUMN}\` = ?
          AND task_status IN (${placeholders})
        ORDER BY task_id ASC`,
      [TASK_SOURCE, key, ...OPEN_STATUSES]
    );
  } catch (err) {
    console.error(`[ESIGN ALERT] resolve lookup for "${key}" failed: ${err && err.message}`);
    return { ok: false, resolved: [], count: 0, reason: 'error', error: err && err.message };
  }

  const open = rows || [];
  if (!open.length) return { ok: true, resolved: [], count: 0 };

  const nowIso   = new Date().toISOString();
  const resolved = [];

  for (const row of open) {
    try {
      // Status first: if the note write fails afterwards the task is still
      // correctly closed, whereas the reverse order could leave a task
      // claiming to be resolved while still open.
      await taskService.completeTask(db, row.task_id, 0, {
        via:  'auto_resolve',
        note: `Closed automatically: the condition behind this alert (${key}) has cleared.`,
      });
      resolved.push(row.task_id);

      const nextDesc = _withResolvedMarker(row.task_desc, nowIso);
      if (nextDesc != null) {
        await db.query('UPDATE tasks SET task_desc = ? WHERE task_id = ?', [nextDesc, row.task_id]);
      }
    } catch (err) {
      // Most likely a race: something closed it between the SELECT and here.
      console.error(`[ESIGN ALERT] could not auto-resolve task #${row.task_id}: ${err && err.message}`);
    }
  }

  if (resolved.length) {
    console.log(`[ESIGN ALERT] auto-resolved task(s) ${resolved.join(', ')} — "${key}" cleared.`);
  }
  return { ok: true, resolved, count: resolved.length };
}

module.exports = {
  resolveAlertAssignee,
  raiseTask,
  resolveTask,
  ALERT_RECIPIENT_KEY,
  TASK_SOURCE,
  MAX_TITLE,
  MAX_DESC,
  MAX_TASK_LINK_ID,
  MAX_DEDUPE_KEY,
  DEDUPE_COLUMN,
  DEDUPE_KEYS,
  OPEN_STATUSES,
};
