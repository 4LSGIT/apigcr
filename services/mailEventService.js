// services/mailEventService.js
//
/**
 * YisraMail T2 — provider email events → campaign_results + the consent
 * ledger + staff follow-up + alerts, and the transport health C2 reads
 * (ref/YISRAMAIL_DESIGN.md §5.4, §6.4, §6.5, D17, D18).
 *
 * PATH: SES (configuration set yisramail-marketing) → EventBridge rule
 * yisramail-ses-events → API destination → hook `ses-events` (api_key auth,
 * header x-api-key — the receiver strips it; dedup_path body.id) → target
 * internal_function mail_event_ingest (params_mapping event ← body) →
 * ingest(db, event) here. The provider's parsing lives in its driver
 * (services/adapters/email/drivers/ses.js events.parseDetailed).
 *
 * PER NORMALIZED EVENT, one transaction (withTransaction retries:1, pure DB,
 * plus one retry on a deadlock — the unsubService/phoneConsentService pattern:
 * recordConsent is a DIRECT caller and can meet a contact-form save of the
 * same address). LOCK ORDER: the campaign_results row, then recordConsent's
 * contact row — a send path that touches both must take them in this order or
 * tolerate a deadlock.
 *   1. correlate: the campaign_results row named by the result_id message tag
 *      AND of the campaign its campaign_id tag names (both required — a
 *      tag-less result_id falls through), else the row whose
 *      provider_message_id is the event's; locked FOR UPDATE. No row →
 *      `unknown` (a non-campaign send, e.g. the acceptance script).
 *   2. delivery columns: delivery_status moves only UP the precedence
 *      complained > bounced_hard > rejected > delivered > bounced_soft >
 *      unknown (a late weaker event never downgrades it; delivery_diag follows
 *      the status); the event's *_at column is set once per RANK (the first
 *      event of the winning status sets it: a hard bounce after a soft one
 *      stamps bounced_at with the hard bounce's time); bounce_subtype follows a
 *      bounce that raises the status;
 *      provider_message_id is filled when the row (found by its tag) had none
 *      and no other row carries that id.
 *   3. ledger (D18: email opt-outs are scope `marketing`): bounce_hard →
 *      recordConsent opt_out source provider_bounce; complaint → source
 *      provider_complaint; provider_event_id `<eventbridge id>:<recipient>`,
 *      so a replayed event is a no-op (uk_source_event → duplicate). Evidence
 *      { via:'ses', event_type, bounce_type, diagnostic ≤ 200, message_id },
 *      send_ref = the result_id when correlated. No rowId: recordConsent takes
 *      the destination's row lock itself. Soft bounces, delays, deliveries,
 *      rejects and rendering failures write no ledger event.
 * AFTER the commit (never inside the transaction, never failing the event):
 *   - D17: a newly RECORDED hard bounce whose address is an active row of a
 *     contact with an open Primary/Secondary case (phoneConsentService's
 *     client predicate) → ONE task to consent_task_user_id, dedupe key
 *     mail_bounce:<address> (an open one is touched, not duplicated);
 *     non-clients → stats only.
 *   - each complaint → a `warning` alert, one per address per UTC day.
 *   - per transport touched: hard bounces over the last 24 h > 5 % with ≥ 200
 *     deliveries → an `error` alert once per UTC day. The HOLD is C2's.
 *
 * An address the ledger cannot hold (normalizeDestination → '') still gets its
 * delivery columns; the ledger write is skipped and counted `invalid`. Any
 * thrown error — a database failure or a recordConsent anomaly — is rethrown
 * AFTER the other events ran, so the hook marks the target failed and retries
 * it once — safe, every write here is idempotent (rank-guarded, set-once,
 * ledger-deduped).
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');

const WINDOW_H = 24;
const MIN_DELIVERED = 200;
const HARD_BOUNCE_ALERT_RATE = 0.05;
const DIAG_EVIDENCE_MAX = 200;
/** SES bounce subtypes that are SES refusing a known-bad address: not counted in the bounce rate (AWS). */
const SUPPRESSION_SUBTYPES = Object.freeze(['OnAccountSuppressionList', 'EmailValidationSuppressed', 'OnTenantSuppressionList']);

/** Normalized event type → delivery_status. */
const STATUS_FOR = Object.freeze({
  delivered: 'delivered', bounce_hard: 'bounced_hard', bounce_soft: 'bounced_soft',
  complaint: 'complained', reject: 'rejected', rendering_failure: 'rejected',
});
/** Precedence (higher wins). */
const RANK = Object.freeze({ unknown: 0, bounced_soft: 1, delivered: 2, rejected: 3, bounced_hard: 4, complained: 5 });
/** Normalized event type → the set-once timestamp column. */
const AT_COLUMN = Object.freeze({ delivered: 'delivered_at', bounce_hard: 'bounced_at', bounce_soft: 'bounced_at', complaint: 'complained_at' });
/** Normalized event type → the ledger source (no entry = no ledger event). */
const LEDGER_SOURCE = Object.freeze({ bounce_hard: 'provider_bounce', complaint: 'provider_complaint' });

const SQL = Object.freeze({
  byResult: 'SELECT result_id, campaign_id, contact_id, delivery_status, provider_message_id FROM campaign_results WHERE result_id = ? FOR UPDATE',
  byMessage: 'SELECT result_id, campaign_id, contact_id, delivery_status, provider_message_id FROM campaign_results WHERE provider_message_id = ? ORDER BY result_id LIMIT 1 FOR UPDATE',
  messageIdTaken: 'SELECT result_id FROM campaign_results WHERE provider_message_id = ? AND result_id <> ? LIMIT 1',
  alertExists: 'SELECT id FROM system_alerts WHERE dedup_key = ? LIMIT 1',
  activeEmailContact: 'SELECT contact_id FROM contact_emails WHERE email_active_uniq = ? LIMIT 1',
  transportOfCampaign: `SELECT ec.id AS credential_id FROM campaigns c JOIN email_credentials ec ON ec.email = c.sender WHERE c.campaign_id = ? LIMIT 1`,
  openTaskByKey: 'SELECT task_id FROM tasks WHERE task_dedupe_key = ? AND task_status IN (?) ORDER BY task_id DESC LIMIT 1',
});

function utcDate(d = new Date()) { return d.toISOString().slice(0, 10); }

function alertLater(db, o) {
  try {
    const { alert } = require('../lib/alerting');   // lazy require (convention)
    return Promise.resolve(alert(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) { return Promise.resolve(); }
}

/** An alert with this dedup key already exists (today's) — so a new one would be a no-op: neither raised nor counted. */
async function alreadyAlerted(db, dedupKey) {
  try {
    const [[r]] = await db.query(SQL.alertExists, [dedupKey]);
    return !!r;
  } catch (_) { return false; }
}

async function eventTx(db, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(db, fn, { retries: 1 });
    } catch (err) {
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt === 0) continue;
      throw err;
    }
  }
}

/** The campaign_results row for an event, locked: result_id tag first, provider_message_id second. */
async function correlate(conn, ev) {
  const rid = ev.tags && /^\d{1,10}$/.test(ev.tags.result_id || '') ? Number(ev.tags.result_id) : null;
  if (rid) {
    const [[row]] = await conn.query(SQL.byResult, [rid]);
    const cid = ev.tags.campaign_id;
    if (row && cid != null && String(cid) === String(row.campaign_id)) return { row, by: 'result_id' };
  }
  if (ev.provider_message_id) {
    const [[row]] = await conn.query(SQL.byMessage, [ev.provider_message_id]);
    if (row) return { row, by: 'provider_message_id' };
  }
  return null;
}

/**
 * The delivery-column write for one event on one row → { sql, params, statusChanged }.
 * `fillMessageId`: store the event's provider message id on a row that has
 * none (the caller has checked no OTHER row carries it).
 */
function deliveryUpdate(row, ev, { fillMessageId = false } = {}) {
  const status = STATUS_FOR[ev.type];
  const sets = [];
  const params = [];
  if (fillMessageId && !row.provider_message_id && ev.provider_message_id) {
    sets.push('provider_message_id = ?');
    params.push(ev.provider_message_id);
  }
  const statusChanged = RANK[status] > (RANK[row.delivery_status] ?? 0);
  const atCol = AT_COLUMN[ev.type];
  // Set once per rank: the event that raises the status stamps its column;
  // a same-or-weaker event only fills it when empty.
  if (atCol) { sets.push(statusChanged ? `${atCol} = ?` : `${atCol} = COALESCE(${atCol}, ?)`); params.push(ev.at || new Date()); }
  if (statusChanged) { sets.push('delivery_status = ?', 'delivery_diag = ?'); params.push(status, ev.diagnostic ? String(ev.diagnostic).slice(0, 255) : null); }
  if (statusChanged && (ev.type === 'bounce_hard' || ev.type === 'bounce_soft')) {
    sets.push('bounce_subtype = ?');
    params.push(ev.raw && ev.raw.bounceSubType ? String(ev.raw.bounceSubType).slice(0, 40) : null);
  }
  if (!sets.length) return { sql: null, params: [], statusChanged };
  params.push(row.result_id);
  return { sql: `UPDATE campaign_results SET ${sets.join(', ')} WHERE result_id = ?`, params, statusChanged };
}

/** One event, one transaction. → { matched, by, campaign_id, ledger: 'recorded'|'duplicate'|null, contact_id } */
async function applyEvent(db, ev) {
  const optout = require('./optoutService');   // lazy require (convention)
  return eventTx(db, async (conn) => {
    const hit = await correlate(conn, ev);
    if (hit) {
      // Fill the row's message id (correlated by tag, row has none) only when
      // no other row already carries it — never make the second key ambiguous.
      let fillMessageId = false;
      if (hit.by === 'result_id' && !hit.row.provider_message_id && ev.provider_message_id) {
        const [[other]] = await conn.query(SQL.messageIdTaken, [ev.provider_message_id, hit.row.result_id]);
        fillMessageId = !other;
      }
      const u = deliveryUpdate(hit.row, ev, { fillMessageId });
      if (u.sql) await conn.query(u.sql, u.params);
    }
    let ledger = null;
    const source = LEDGER_SOURCE[ev.type];
    if (source && !optout.normalizeDestination('email', ev.recipient)) {
      ledger = 'invalid';                        // the delivery columns above still commit
    } else if (source) {
      const res = await optout.recordConsent(conn, {
        channel: 'email', destination: ev.recipient, scope: 'marketing', action: 'opt_out', source,
        providerEventId: ev.provider_event_id, occurredAt: ev.at || null,
        contactId: hit ? hit.row.contact_id : null,
        sendRef: hit ? String(hit.row.result_id) : null,
        evidence: {
          via: 'ses', event_type: ev.type,
          ...(ev.raw && ev.raw.bounceType ? { bounce_type: ev.raw.bounceType } : {}),
          ...(ev.diagnostic ? { diagnostic: String(ev.diagnostic).slice(0, DIAG_EVIDENCE_MAX) } : {}),
          ...(ev.provider_message_id ? { message_id: ev.provider_message_id } : {}),
        },
      });
      ledger = res.duplicate ? 'duplicate' : 'recorded';
    }
    return { matched: !!hit, by: hit ? hit.by : null, campaign_id: hit ? Number(hit.row.campaign_id) : null, ledger };
  });
}

/** D17: a client's hard bounce → one follow-up task. → task_id | null */
async function clientBounceTask(db, ev) {
  const phone = require('./phoneConsentService');   // lazy require (convention)
  const [[active]] = await db.query(SQL.activeEmailContact, [ev.recipient]);
  if (!active || active.contact_id == null) return null;
  const [[open]] = await db.query(phone.OPEN_CLIENT_CASE_SQL, [active.contact_id]);
  if (!open) return null;                                       // not a client: stats only
  const dkey = `mail_bounce:${ev.recipient}`;
  const [found] = await db.query(SQL.openTaskByKey, [dkey, phone.OPEN_TASK_STATUSES]);
  if (found && found[0]) {
    await db.query('UPDATE tasks SET task_last_update = NOW() WHERE task_id = ?', [found[0].task_id]);
    return found[0].task_id;
  }
  const to = await phone.taskAssignee(db, 'client email bounce');
  if (!to) return null;
  const [[c]] = await db.query('SELECT contact_name FROM contacts WHERE contact_id = ?', [active.contact_id]);
  const name = c && c.contact_name ? String(c.contact_name) : `contact #${active.contact_id}`;
  const desc = (`${name} — ${ev.recipient} hard-bounced a firm email (${ev.diagnostic || 'permanent bounce'}). ` +
    'The address is now opted out of marketing email; case and operational email to it will bounce too. ' +
    'Get a working email address from the client and update the contact.').slice(0, 1000);
  const { createTask } = require('./taskService');   // lazy require (convention)
  const t = await createTask(db, {
    from: 0, to, title: 'Client email is bouncing — get a new address', desc,
    source: 'consent', link_type: 'contact', link_id: active.contact_id,
    log_extra: { destination: ev.recipient, provider_event_id: ev.provider_event_id, case_id: open.case_id },
  });
  // Stamped after creation (createTask does not know the column) — P2's pattern.
  await db.query('UPDATE tasks SET task_dedupe_key = ? WHERE task_id = ?', [dkey, t.task_id]);
  return t.task_id;
}

/**
 * The last WINDOW_H hours of one transport (the sender's email_credentials
 * row) or one campaign, from campaign_results. bounced_hard leaves out the
 * SES suppression subtypes (SUPPRESSION_SUBTYPES — AWS does not count them
 * toward the bounce rate); they are reported as suppressed. Rates: bounce_rate
 * = bounced_hard / (delivered + bounced_hard); complaint_rate = complained /
 * delivered; delivery_rate = delivered / (delivered + bounced_hard); null when
 * the denominator is 0. `enough` = delivered ≥ 200 (§6.5: rates decide
 * nothing below it).
 */
async function transportHealth(db, { credentialId = null, campaignId = null } = {}) {
  if ((credentialId == null) === (campaignId == null)) throw new Error('transportHealth: pass exactly one of credentialId, campaignId');
  const scope = credentialId != null
    ? { join: 'JOIN campaigns c ON c.campaign_id = cr.campaign_id JOIN email_credentials ec ON ec.email = c.sender', where: 'ec.id = ?', id: Number(credentialId) }
    : { join: '', where: 'cr.campaign_id = ?', id: Number(campaignId) };
  const since = 'UTC_TIMESTAMP(3) - INTERVAL ? HOUR';
  const supp = "cr.bounce_subtype IN ('" + SUPPRESSION_SUBTYPES.join("','") + "')";   // constants, not input
  const [[r]] = await db.query(
    `SELECT COALESCE(SUM(cr.delivered_at >= ${since}), 0) AS delivered,
            COALESCE(SUM(cr.delivery_status = 'bounced_hard' AND cr.bounced_at >= ${since} AND NOT COALESCE(${supp}, 0)), 0) AS bounced_hard,
            COALESCE(SUM(cr.delivery_status = 'bounced_hard' AND cr.bounced_at >= ${since} AND COALESCE(${supp}, 0)), 0) AS suppressed,
            COALESCE(SUM(cr.complained_at >= ${since}), 0) AS complained
       FROM campaign_results cr ${scope.join}
      WHERE ${scope.where}
        AND (cr.delivered_at >= ${since} OR cr.bounced_at >= ${since} OR cr.complained_at >= ${since})`,
    [WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H, scope.id, WINDOW_H, WINDOW_H, WINDOW_H]);
  const delivered = Number(r.delivered);
  const bouncedHard = Number(r.bounced_hard);
  const complained = Number(r.complained);
  const attempted = delivered + bouncedHard;
  const rate = (n, d) => (d > 0 ? n / d : null);
  return {
    window_h: WINDOW_H, delivered, bounced_hard: bouncedHard, suppressed: Number(r.suppressed), complained,
    delivery_rate: rate(delivered, attempted), complaint_rate: rate(complained, delivered),
    bounce_rate: rate(bouncedHard, attempted), enough: delivered >= MIN_DELIVERED,
  };
}

/**
 * The hook body → everything above. → { parsed, ignored, unknown_shape,
 * parse_errors, updated, unknown, invalid, ledger: {recorded, duplicate},
 * tasks, alerts }
 */
async function ingest(db, body, { driver = 'ses' } = {}) {
  const drivers = { ses: require('./adapters/email/drivers/ses') };
  const d = drivers[driver];
  if (!d || !d.events) throw new Error(`mail_event_ingest: no events driver "${driver}"`);
  const p = d.events.parseDetailed(body);
  const out = {
    parsed: p.events.length, ignored: p.ignored, unknown_shape: p.unknown_shape, parse_errors: p.errors.length,
    updated: 0, unknown: 0, invalid: 0, ledger: { recorded: 0, duplicate: 0 }, tasks: 0, alerts: 0,
  };
  if (p.errors.length) console.warn(`[mail_event_ingest] ${p.errors.length} unparseable event(s): ${p.errors.join('; ').slice(0, 300)}`);
  const campaigns = new Set();
  const followUps = [];
  let dbError = null;
  for (const ev of p.events) {
    let r;
    try {
      r = await applyEvent(db, ev);
    } catch (err) {
      dbError = dbError || err;                 // a database failure or a recordConsent anomaly: the retry path
      console.error(`[mail_event_ingest] ${ev.provider_event_id} failed: ${err.message}`);
      continue;
    }
    if (r.matched) { out.updated += 1; campaigns.add(r.campaign_id); } else out.unknown += 1;
    if (r.ledger === 'invalid') {
      out.invalid += 1;
      console.warn(`[mail_event_ingest] ${ev.provider_event_id}: "${ev.recipient}" is not an address the ledger can hold — delivery recorded, no opt-out`);
    } else if (r.ledger) out.ledger[r.ledger] += 1;
    followUps.push({ ev, r });
  }
  if (out.unknown) console.log(`[mail_event_ingest] ${out.unknown} event(s) matched no campaign result (non-campaign sends)`);

  // After every commit — never fails the ingest.
  for (const { ev, r } of followUps) {
    if (ev.type === 'bounce_hard' && r.ledger === 'recorded') {
      try { if (await clientBounceTask(db, ev)) out.tasks += 1; } catch (err) { console.error(`[mail_event_ingest] bounce task for ${ev.recipient} failed: ${err.message}`); }
    }
    if (ev.type === 'complaint') {
      const dedupKey = `mail_complaint:${ev.recipient}:${utcDate()}`;
      if (await alreadyAlerted(db, dedupKey)) continue;
      await alertLater(db, {
        source: 'mail', kind: 'mail_complaint', group_key: 'mail_complaint', severity: 'warning',
        title: `Spam complaint from ${ev.recipient}`,
        message: `${ev.recipient} marked a firm marketing email as spam (${ev.diagnostic || 'complaint'}). The address is opted out of marketing email. ` +
          `Message ${ev.provider_message_id || '?'}${r.campaign_id ? `, campaign ${r.campaign_id}` : ''}.`,
        dedup_key: dedupKey,
      });
      out.alerts += 1;
    }
  }
  for (const campaignId of campaigns) {
    try {
      const [[t]] = await db.query(SQL.transportOfCampaign, [campaignId]);
      if (!t) continue;
      const h = await transportHealth(db, { credentialId: t.credential_id });
      const rateKey = `mail_bounce_rate:${t.credential_id}:${utcDate()}`;
      if (h.enough && h.bounce_rate != null && h.bounce_rate > HARD_BOUNCE_ALERT_RATE && !(await alreadyAlerted(db, rateKey))) {
        await alertLater(db, {
          source: 'mail', kind: 'mail_bounce_rate', group_key: `mail_bounce_rate:${t.credential_id}`, severity: 'error',
          title: `Hard-bounce rate ${(h.bounce_rate * 100).toFixed(1)}% on email transport ${t.credential_id}`,
          message: `Over the last ${h.window_h} h: ${h.bounced_hard} hard bounce(s), ${h.delivered} delivered (limit 5 % once ≥ ${MIN_DELIVERED} deliveries). ` +
            'Marketing sends on this transport should stop until the list is cleaned (ref/YISRAMAIL_DESIGN.md §6.5).',
          dedup_key: rateKey,
        });
        out.alerts += 1;
      }
    } catch (err) {
      console.error(`[mail_event_ingest] transport health for campaign ${campaignId} failed: ${err.message}`);
    }
  }
  if (dbError) throw new Error(`mail_event_ingest: ${dbError.message} (other events were applied; a retry is safe)`);
  return out;
}

/**
 * C4's daily digest data: the last WINDOW_H hours of marketing email, read
 * only — per campaign with activity (a sent / delivered / bounced /
 * complained timestamp, or an opt-out whose send_ref names one of its
 * results, inside the window) and per bulk transport (transportHealth + the
 * §6.5 held state). Zero activity → { campaigns: [], ... } — the digest
 * sends nothing.
 */
async function bounceDigestData(db) {
  const W = 'UTC_TIMESTAMP(3) - INTERVAL ? HOUR';
  const [campaigns] = await db.query(
    `SELECT cr.campaign_id, c.subject, c.status, c.sender,
            COALESCE(SUM(cr.status = 'sent' AND cr.sent_at >= ${W}), 0) AS sent,
            COALESCE(SUM(cr.delivered_at >= ${W}), 0)  AS delivered,
            COALESCE(SUM(cr.delivery_status = 'bounced_hard' AND cr.bounced_at >= ${W}), 0) AS bounced_hard,
            COALESCE(SUM(cr.complained_at >= ${W}), 0) AS complained
       FROM campaign_results cr
       JOIN campaigns c ON c.campaign_id = cr.campaign_id
      WHERE c.class = 'marketing' AND c.type = 'email'
        AND (cr.sent_at >= ${W} OR cr.delivered_at >= ${W} OR cr.bounced_at >= ${W} OR cr.complained_at >= ${W})
      GROUP BY cr.campaign_id, c.subject, c.status, c.sender
      ORDER BY cr.campaign_id DESC`,
    [WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H, WINDOW_H]);

  // Unsubscribes in the window, by send_ref (the token rides every /u/ path)
  // and SOURCE — unsubService's three surfaces only: mail_event_ingest writes
  // provider_bounce / provider_complaint opt-outs with the same send_ref,
  // which would double-count every bounce and complaint as an unsubscribe
  // (review B1, 2026-11-05). occurred_at, not created_at: provider time when
  // known. No send_ref index — one hash-join ledger scan per nightly run.
  const [unsubs] = await db.query(
    `SELECT cr.campaign_id, COUNT(DISTINCT e.destination) AS unsubscribed
       FROM comm_consent_events e
       JOIN campaign_results cr
         ON e.send_ref = CAST(cr.result_id AS CHAR) COLLATE utf8mb4_general_ci
      WHERE e.channel = 'email' AND e.action = 'opt_out' AND e.occurred_at >= ${W}
        AND e.source IN ('one_click', 'unsub_page', 'pref_page')
      GROUP BY cr.campaign_id`,
    [WINDOW_H]);
  const unsubByCampaign = new Map(unsubs.map((r) => [Number(r.campaign_id), Number(r.unsubscribed)]));

  const rows = campaigns.map((r) => ({
    campaign_id: Number(r.campaign_id),
    subject: r.subject,
    status: r.status,
    sender: r.sender,
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    bounced_hard: Number(r.bounced_hard),
    complained: Number(r.complained),
    unsubscribed: unsubByCampaign.get(Number(r.campaign_id)) || 0,
  }));
  // A window-only unsub can reach a campaign whose other timestamps are older.
  for (const [cid, n] of unsubByCampaign) {
    if (!rows.some((r) => r.campaign_id === cid)) {
      const [[c]] = await db.query('SELECT subject, status, sender FROM campaigns WHERE campaign_id = ?', [cid]);
      rows.push({ campaign_id: cid, subject: c ? c.subject : null, status: c ? c.status : null, sender: c ? c.sender : null,
        sent: 0, delivered: 0, bounced_hard: 0, complained: 0, unsubscribed: n });
    }
  }

  const [creds] = await db.query('SELECT id, email, held_at, held_reason FROM email_credentials WHERE bulk_ok = 1');
  const transports = [];
  for (const cred of creds) {
    const health = await transportHealth(db, { credentialId: cred.id });
    transports.push({ id: cred.id, email: cred.email, held: cred.held_at != null, held_reason: cred.held_at != null ? cred.held_reason : null, ...health });
  }
  return { window_h: WINDOW_H, campaigns: rows, transports };
}

module.exports = { ingest, transportHealth, bounceDigestData, correlate, deliveryUpdate, STATUS_FOR, RANK, AT_COLUMN, LEDGER_SOURCE, SUPPRESSION_SUBTYPES, WINDOW_H, MIN_DELIVERED, HARD_BOUNCE_ALERT_RATE, SQL };
