// lib/internal_functions/mailDigest.js
//
// YisraMail C4 — the daily marketing-mail digest (ref/YISRAMAIL_DESIGN.md
// §6.5, slice C4).
//
// CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST) — it emails the firm's
// alert recipients; no public link may start it.

const fns = {};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

/**
 * mail_bounce_digest
 * One run of the daily digest: the last 24 h of marketing email — per
 * campaign sent / delivered / hard bounces / complaints / unsubscribes, per
 * bulk transport the current rates + held state — emailed ONLY when the
 * window saw any activity (otherwise nothing is sent and the run succeeds).
 * Fail-closed on app_settings campaign_bounce_digest_enabled = '0' (on
 * otherwise). Recipient: campaign_bounce_digest_email, blank →
 * alert_recipients (the IT alert list); from: alert_from_email →
 * email_automations (AUTO_EMAIL) — the alerting email path's resolution,
 * deliberately independent of the Connections/OAuth system.
 * Driven by the daily "Marketing Mail Digest" recurring job.
 */
/** One fresh app_settings read (the kill-switch convention: never the 60 s cfg cache). */
async function getSetting(db, key) {
  const [[row]] = await db.query('SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1', [key]);
  return row?.value ?? null;
}

fns.mail_bounce_digest = async (params = {}, db) => {
  const mailEvents = require('../../services/mailEventService');  // lazy require (convention)
  const dryRun = params.dry_run === true || params.dry_run === 'true';

  if (String((await getSetting(db, 'campaign_bounce_digest_enabled')) ?? '') === '0') {
    console.log('[MAIL DIGEST] campaign_bounce_digest_enabled=0 — skipped');
    return { success: true, output: { enabled: false, sent: false } };
  }

  const data = await mailEvents.bounceDigestData(db);
  const activity = data.campaigns.length > 0;
  const trouble = data.campaigns.some((c) => c.bounced_hard || c.complained || c.unsubscribed)
    || data.transports.some((t) => t.held);
  if (!activity) {
    console.log('[MAIL DIGEST] no marketing activity in the window — nothing sent');
    return { success: true, output: { enabled: true, sent: false, activity: false } };
  }

  const { cfg } = require('../firmConfig'); // lazy require (convention) — email_automations carries the AUTO_EMAIL env fallback
  const to = String((await getSetting(db, 'campaign_bounce_digest_email')) ?? '').trim()
    || String((await getSetting(db, 'alert_recipients')) ?? '').trim();
  const from = String((await getSetting(db, 'alert_from_email')) ?? '').trim() || String(cfg('email_automations') ?? '').trim();
  if (!to || !from) {
    // A digest with activity and nowhere to go is a real failure — the
    // failed-job sweep reports it rather than the window passing silently.
    throw new Error(`mail_bounce_digest: no ${!to ? 'recipient (campaign_bounce_digest_email / alert_recipients)' : 'sender (alert_from_email / email_automations)'}`);
  }

  const campRows = data.campaigns.map((c) => `<tr>
    <td>#${c.campaign_id}</td><td>${esc(c.subject || '—')}</td><td>${esc(c.status || '—')}</td>
    <td align="right">${c.sent}</td><td align="right">${c.delivered}</td>
    <td align="right">${c.bounced_hard}</td><td align="right">${c.complained}</td><td align="right">${c.unsubscribed}</td>
  </tr>`).join('');
  const transRows = data.transports.map((t) => `<tr>
    <td>${esc(t.email)}</td><td>${t.held ? `HELD — ${esc(t.held_reason || '')}` : 'ok'}</td>
    <td align="right">${t.delivered}</td><td align="right">${t.bounced_hard}</td><td align="right">${t.complained}</td>
    <td align="right">${pct(t.bounce_rate)}</td><td align="right">${pct(t.complaint_rate)}</td>
    <td>${t.enough ? '' : 'low volume — rates not decisive'}</td>
  </tr>`).join('');
  const TH = 'text-align:left;border-bottom:1px solid #ccc;padding:4px 8px';
  const html = `
  <p>Marketing email, last ${data.window_h} hours.</p>
  <table cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
    <tr><th style="${TH}">Campaign</th><th style="${TH}">Subject</th><th style="${TH}">Status</th><th style="${TH}">Sent</th><th style="${TH}">Delivered</th><th style="${TH}">Hard bounces</th><th style="${TH}">Complaints</th><th style="${TH}">Unsubscribes</th></tr>
    ${campRows}
  </table>
  <p style="margin-top:14px"><strong>Transports (24 h)</strong></p>
  <table cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
    <tr><th style="${TH}">Sender</th><th style="${TH}">Hold</th><th style="${TH}">Delivered</th><th style="${TH}">Hard bounces</th><th style="${TH}">Complaints</th><th style="${TH}">Bounce rate</th><th style="${TH}">Complaint rate</th><th style="${TH}"></th></tr>
    ${transRows}
  </table>
  <p style="color:#6b7280;font-size:12px">Sent by the Marketing Mail Digest job (campaign_bounce_digest_enabled). Hold release: POST /api/campaigns/transports/:id/release (SU).</p>`;
  const text = [
    `Marketing email, last ${data.window_h} hours.`,
    ...data.campaigns.map((c) => `#${c.campaign_id} ${c.subject || '—'} [${c.status}]: sent ${c.sent}, delivered ${c.delivered}, hard bounces ${c.bounced_hard}, complaints ${c.complained}, unsubscribes ${c.unsubscribed}`),
    'Transports:',
    ...data.transports.map((t) => `${t.email}: ${t.held ? `HELD (${t.held_reason || ''})` : 'ok'}, delivered ${t.delivered}, bounce ${pct(t.bounce_rate)}, complaint ${pct(t.complaint_rate)}${t.enough ? '' : ' (low volume)'}`),
  ].join('\n');
  const subject = `${trouble ? '[attention] ' : ''}Marketing mail digest — ${data.campaigns.reduce((n, c) => n + c.sent, 0)} sent, ${data.campaigns.reduce((n, c) => n + c.bounced_hard, 0)} bounced, ${data.campaigns.reduce((n, c) => n + c.complained, 0)} complaints`;

  if (dryRun) {
    console.log(`[MAIL DIGEST] dry run — would send to ${to}: ${subject}`);
    return { success: true, output: { enabled: true, sent: false, dry_run: true, to, subject, campaigns: data.campaigns.length } };
  }
  const emailService = require('../../services/emailService'); // lazy require (convention)
  await emailService.sendEmail(db, { from, to, subject, html, text });
  console.log(`[MAIL DIGEST] sent to ${to}: ${data.campaigns.length} campaign(s), ${data.transports.length} transport(s)`);
  return { success: true, output: { enabled: true, sent: true, to, campaigns: data.campaigns.length, transports: data.transports.length } };
};

fns.mail_bounce_digest.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "Marketing Mail Digest" recurring job
  description:
    'Internal: the daily marketing-mail digest — the last 24 h per campaign (sent / delivered / hard bounces / ' +
    'complaints / unsubscribes) and per bulk transport (current rates + held state), emailed to ' +
    'campaign_bounce_digest_email (blank = alert_recipients) only when the window saw activity. Off when ' +
    'app_settings campaign_bounce_digest_enabled = "0". Driven by its recurring job — do not add to workflows. ' +
    'Not CTA-eligible. ref/YISRAMAIL_DESIGN.md §6.5 (C4).',
  params: [
    { name: 'dry_run', type: 'boolean', required: false,
      description: 'true = compute the digest and log what WOULD be sent, sending nothing. Never set on the recurring job.' },
  ],
  example: {},
};

module.exports = fns;
