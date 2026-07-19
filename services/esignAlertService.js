// services/esignAlertService.js
//
/**
 * E-Sign STAFF ALERTS — the one place this subsystem raises a human task.
 * services/esignAlertService.js
 *
 * Phase 1C. Three callers need to put a task in front of a person:
 *
 *   esignWebhookService   declined / bounced envelopes, and signed documents
 *                         that could not be filed automatically
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

/** Clip to `max`, marking the cut so a reader knows something was removed. */
function _clip(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return `${str.slice(0, max - 14)}…(truncated)`;
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
 * Raise a staff task about a signing request.
 *
 * @param {object} db
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.desc
 * @param {string} [o.linkableType]  'case' | 'contact' — usually request.linkable_type
 * @param {string} [o.linkableId]
 * @param {boolean} [o.notifyByEmail=true]  taskService's canned assignment email
 * @returns {Promise<{ok:boolean, taskId?:number, actionUrl?:string, reason?:string}>}
 */
async function raiseTask(db, { title, desc, linkableType = null, linkableId = null, notifyByEmail = true } = {}) {
  try {
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

    console.log(`[ESIGN ALERT] task #${task_id} → user ${assignee}: ${title}`);
    return { ok: true, taskId: task_id, actionUrl: action_url };
  } catch (err) {
    // Swallowed on purpose — see the header. The work this alert describes has
    // already happened either way.
    console.error(`[ESIGN ALERT] failed to raise "${title}": ${err && err.message}`);
    return { ok: false, reason: 'error', error: err && err.message };
  }
}

module.exports = {
  resolveAlertAssignee,
  raiseTask,
  ALERT_RECIPIENT_KEY,
  TASK_SOURCE,
  MAX_TITLE,
  MAX_DESC,
  MAX_TASK_LINK_ID,
};