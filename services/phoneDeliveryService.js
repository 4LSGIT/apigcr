// services/phoneDeliveryService.js
//
/**
 * Phone outbound delivery sync — phone-delivery arc S1
 * (design: ref/PHONE_DELIVERY_DESIGN.md; read §1–§3 before touching this).
 *
 * One bounded run: for every (provider, credential_id) group of active,
 * outboundSync-capable phone lines, list the provider's OUTBOUND SMS in a
 * window through the line's adapter (adapter.listOutbound — the ONLY place
 * provider vocabulary exists), then:
 *
 *   unknown (provider, provider_ref)  → ingest through
 *     phoneIngestService.ingestPhoneEvent — recovers texts the webhook path
 *     dropped (hook 22 took newMessageIds[0] only; ~25% of RC outbound,
 *     design §1 B2). The ingest's own (provider, provider_ref) dedup makes
 *     this idempotent and safe to run alongside wf19 until the S2 cutover.
 *
 *   known row → stamp the delivery columns (delivery_state / _reason /
 *     _code / _checked_at) when the provider's verdict CHANGED — fixes the
 *     never-captured delivery status (design §1 B1).
 *
 * Window, not watermark (design §2): each run re-lists a fixed window
 * (default now − 48 h → now). No cursor to store, no gap when a run dies,
 * and late carrier verdicts (SMS-CAR-104) are re-checked for two days.
 * Writes are no-ops unless the verdict changed, so re-listing is churn-free.
 *
 * Terminal-state guard: a row already 'failed' or 'delivered' is never
 * downgraded to 'pending'/'sent' by a later run (stampDecision).
 *
 * Group by (provider, credential_id), NOT by line: RC's two lines share one
 * extension and credential, so one listing covers both — per-line fetches
 * would double-spend the rate group.
 *
 * Backfill (design §6): the same run with explicit { since, until,
 * backfill: true } — Layer 3 (automation rules) is skipped with reason
 * 'backfill' and recovered events carry extra.backfill = true. Live runs
 * never skip Layer 3: a text recovered minutes late fires exactly what it
 * would have fired on time.
 *
 * Concurrency / posture (archive-sweep conventions, commsArchiveCommon):
 * GET_LOCK('phone_outbound_sync:<db>', 0) — a concurrent run returns
 * { skipped: 'locked' }. Fail-closed on app_settings
 * phone_delivery_sync_enabled != '1'. Provider trouble alerts at 'warning'
 * (transient / first per convention; the alerting lib's dedup and cooldown
 * do the rest), and a run never throws out of one group into another.
 *
 * Driven by the "Phone Outbound Delivery Sync" recurring job and poked by
 * hook 22 after the S2 cutover; fns.phone_outbound_sync is the skin.
 */
'use strict';

const phoneService = require('./phoneService');
const { alert, acquireLock } = require('./commsArchiveCommon');

const ENABLED_KEY = 'phone_delivery_sync_enabled';
const FAILED_WF_KEY = 'phone_delivery_failed_workflow_id';
const LOCK_EXPR = "CONCAT('phone_outbound_sync:', DATABASE())";
const WINDOW_HOURS = 48;
const MAX_PAGES = 10;          // per group per run; a backfill passes its own
const PER_PAGE = 100;
const CHUNK = 200;             // provider_ref lookup chunk (IN-list size)

const STATES = new Set(['pending', 'sent', 'delivered', 'failed']);
const TERMINAL = new Set(['failed', 'delivered']);

/**
 * What to write for a known row, or null for no write.
 * `existing`: { delivery_state, delivery_reason, delivery_code } (DB row)
 * `delivery`: NormalizedOutbound.delivery from the adapter.
 * Pure — unit-tested directly; the SQL around it is pinned by the gated
 * mysql twin.
 */
function stampDecision(existing, delivery) {
  if (!delivery || !STATES.has(delivery.state)) return null;      // shape drift → no write
  const next = {
    state: delivery.state,
    reason: delivery.state === 'failed' ? (delivery.reason || 'unknown') : null,
    code: delivery.provider_code || null,
  };
  const cur = {
    state: existing.delivery_state || null,
    reason: existing.delivery_reason || null,
    code: existing.delivery_code || null,
  };
  // Terminal guard: never downgrade a settled verdict to an in-flight one.
  if (TERMINAL.has(cur.state) && !TERMINAL.has(next.state)) return null;
  if (cur.state === next.state && cur.reason === next.reason && cur.code === next.code) return null;
  return next;
}

/**
 * NormalizedOutbound → the phone_log-shaped event ingestPhoneEvent takes
 * (the exact shape wf19 step 4 produces, so recovered texts are
 * indistinguishable from webhook-ingested ones). Pure — unit-tested.
 */
function buildIngestEvent(r, { backfill = false } = {}) {
  return {
    type: 'sms',
    direction: 'outgoing',
    from: r.from,
    to: r.to,
    message: r.body,
    by: 0,
    link_type: 'phone',
    link_id: r.to,
    // The text's REAL send time (S3b/S4): createLogEntry stamps log_date from
    // it (UTC → firm-local), so a recovered text lands on the log when it was
    // sent — essential for the backfill, where ingest-time dating would spray
    // months-old texts onto today's case and contact feeds.
    date: r.ts || null,
    data: { direction: 'outgoing', attachments: r.attachments },
    extra: {
      ts: r.ts,
      line: r.from,
      provider: r.provider,
      conversation_id: r.conversation_id,
      provider_event_id: r.provider_ref,
      provider_message_id: r.provider_ref,
      ...(backfill ? { backfill: true } : {}),
    },
  };
}

function _iso(v, fallbackMs) {
  if (v == null || v === '') return new Date(fallbackMs).toISOString();
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) throw new Error(`not a date: ${JSON.stringify(v)}`);
  return d.toISOString();
}

/**
 * One sync run. opts: { since?, until?, backfill?, maxPages? }.
 * Returns counts; never throws past a group (per-group errors are collected
 * and alerted).
 */
async function runSync(db, opts = {}) {
  const { getSetting } = require('./settingsService');   // lazy require (convention)
  const now = Date.now();
  const out = {
    enabled: false, skipped: null,
    since: null, until: null, backfill: !!opts.backfill,
    groups: 0, pages: 0, listed: 0, ingested: 0, stamped: 0, unchanged: 0,
    ingest_errors: 0, fetch_errors: 0, errors: [],
  };

  out.enabled = (await getSetting(db, ENABLED_KEY)) === '1';
  if (!out.enabled) { out.skipped = `${ENABLED_KEY} is not "1"`; return out; }

  // S3c — failed-send dispatch: the workflow started when a text's verdict
  // TRANSITIONS to failed (blank / non-numeric = off). The workflow decides
  // the action (task, email…) in the builder — code never hardcodes one.
  // Fired by LIVE runs only: a backfill raising months-old failures would be
  // retroactive noise, the same reasoning as skipping Layer 3 (§6).
  const failedWfId = out.backfill ? null : (Number(await getSetting(db, FAILED_WF_KEY)) || null);
  out.dispatched = 0;
  out.dispatch_errors = 0;

  out.since = _iso(opts.since, now - WINDOW_HOURS * 3_600_000);
  out.until = _iso(opts.until, now);
  if (out.since >= out.until) throw new Error(`empty window: since ${out.since} >= until ${out.until}`);
  const maxPages = Number.isFinite(Number(opts.maxPages)) && Number(opts.maxPages) > 0
    ? Math.floor(Number(opts.maxPages)) : MAX_PAGES;

  const lock = await acquireLock(db, LOCK_EXPR);
  if (!lock) { out.skipped = 'locked'; return out; }
  try {
    const [groups] = await db.query(
      `SELECT provider, credential_id
         FROM phone_lines
        WHERE active = 1 AND credential_id IS NOT NULL
        GROUP BY provider, credential_id`
    );
    // S3c-b loop guard: a failed text whose RECIPIENT is one of the firm's own
    // lines never dispatches. The notification workflow itself texts a staff
    // line — if that notification ever failed (a spam filter on its wording is
    // the proven class), dispatching on it would send another, at status-ping
    // speed: a runaway loop. ALL lines, active or not — a text to a retired
    // line must not loop either. Visible as out.dispatch_skipped_firm.
    const [lineRows] = await db.query(`SELECT phone_number FROM phone_lines`);
    const firmLines = new Set(lineRows.map(l => String(l.phone_number)));
    out.dispatch_skipped_firm = 0;
    for (const g of groups) {
      const adapter = phoneService.getAdapter(g.provider);
      if (!adapter || !adapter.capabilities?.outboundSync || typeof adapter.listOutbound !== 'function') continue;
      out.groups += 1;
      try {
        await _syncGroup(db, adapter, g, out, { maxPages, failedWfId, firmLines });
      } catch (err) {
        // NO_AUTH and anything else unexpected for this group: record, alert,
        // move on to the next group.
        out.fetch_errors += 1;
        out.errors.push(`${g.provider}/${g.credential_id}: ${err.message}`);
        alert(db, {
          kind: 'phone_delivery_sync', group_key: 'phone_delivery_sync',
          severity: 'warning',
          title: `Phone delivery sync: ${g.provider} group failed`,
          message: err.message,
          context: { provider: g.provider, credential_id: g.credential_id },
          dedup_key: `phone_delivery_sync:${g.provider}:${g.credential_id}:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }
  } finally {
    await lock.release();
  }
  return out;
}

async function _syncGroup(db, adapter, g, out, { maxPages, failedWfId, firmLines }) {
  const phoneIngestService = require('./phoneIngestService');   // lazy require (convention)
  for (let page = 1; page <= maxPages; page++) {
    const res = await adapter.listOutbound(db, {
      credentialId: g.credential_id,
      sinceISO: out.since,
      untilISO: out.until,
      page,
      perPage: PER_PAGE,
    });
    if (res.status === 429) {
      // Rate group exhausted — park; the next run re-lists the same window.
      out.errors.push(`${g.provider}/${g.credential_id}: 429 on page ${page} (parked)`);
      out.fetch_errors += 1;
      return;
    }
    if (res.status !== 200) {
      throw new Error(`listOutbound ${res.status} on page ${page}: ${res.errorText || ''}`.trim());
    }
    out.pages += 1;
    out.listed += res.records.length;

    for (let i = 0; i < res.records.length; i += CHUNK) {
      const chunk = res.records.slice(i, i + CHUNK);
      const refs = chunk.map(r => r.provider_ref);
      const existing = new Map();
      if (refs.length) {
        const [rows] = await db.query(
          `SELECT id, provider_ref, delivery_state, delivery_reason, delivery_code
             FROM phone_event_log
            WHERE provider = ? AND provider_ref IN (?)`,
          [g.provider, refs]
        );
        for (const row of rows) existing.set(String(row.provider_ref), row);
      }
      for (const r of chunk) {
        const row = existing.get(r.provider_ref);
        if (!row) {
          try {
            await phoneIngestService.ingestPhoneEvent(
              db, buildIngestEvent(r, { backfill: out.backfill }),
              { skipAutomation: out.backfill ? 'backfill' : false }
            );
            out.ingested += 1;
          } catch (err) {
            out.ingest_errors += 1;
            out.errors.push(`ingest ${g.provider}/${r.provider_ref}: ${err.message}`);
            continue;   // one bad record never stops the window
          }
        }
        // Stamp by the unique key — covers the row just ingested too.
        const cur = row || { delivery_state: null, delivery_reason: null, delivery_code: null };
        const next = stampDecision(cur, r.delivery);
        if (!next) { if (row) out.unchanged += 1; continue; }
        await db.query(
          `UPDATE phone_event_log
              SET delivery_state = ?, delivery_reason = ?, delivery_code = ?, delivery_checked_at = NOW()
            WHERE provider = ? AND provider_ref = ?`,
          [next.state, next.reason, next.code, g.provider, r.provider_ref]
        );
        out.stamped += 1;

        // S3c — dispatch EXACTLY on the transition into failed: a later run
        // re-reading the same verdict is a no-op write (never reaches here),
        // and a failed→failed code refinement is not a second failure. The
        // dispatcher handles inactive / unpublished targets itself (refuse or
        // capture); a dispatch failure never stops the window.
        const wasFailed = (row && row.delivery_state) === 'failed';
        if (failedWfId && next.state === 'failed' && !wasFailed && firmLines && firmLines.has(r.to)) {
          out.dispatch_skipped_firm += 1;   // firm-to-firm failure: chips + email digest territory, never a dispatch (loop guard)
        } else if (failedWfId && next.state === 'failed' && !wasFailed) {
          try {
            const { dispatchWorkflow } = require('../lib/actionDispatchers');   // lazy require (convention)
            const d = await dispatchWorkflow({ id: null }, { workflow_id: failedWfId }, {
              kind: 'sms_delivery_failed',
              provider: g.provider,
              provider_ref: r.provider_ref,
              to: r.to,
              from: r.from,
              body: r.body,
              ts: r.ts,
              reason: next.reason,
              code: next.code,
            }, db);
            if (d && d.status === 'success') out.dispatched += 1;
            else { out.dispatch_errors += 1; out.errors.push(`failed-dispatch wf${failedWfId}/${r.provider_ref}: ${(d && d.error) || 'refused'}`); }
          } catch (err) {
            out.dispatch_errors += 1;
            out.errors.push(`failed-dispatch wf${failedWfId}/${r.provider_ref}: ${err.message}`);
          }
        }
      }
    }

    if (res.totalPages != null && page >= res.totalPages) return;
    if (res.records.length < PER_PAGE && res.totalPages == null) return;
  }
}

module.exports = {
  runSync,
  // Exported for testing / reuse
  stampDecision,
  buildIngestEvent,
  ENABLED_KEY,
  FAILED_WF_KEY,
  LOCK_EXPR,
  WINDOW_HOURS,
};
