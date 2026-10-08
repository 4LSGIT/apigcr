// lib/ctaLinks.js
//
/**
 * CTA link composition — public URLs, the [[...]] email tokens, and the
 * default CTA email (CTA arc S2; spec ref/CTA_DESIGN.md §5.3, §10 S2).
 *
 * services/ctaService.js deliberately builds no URLs (the public origin is a
 * surface concern); this module is that surface helper. Consumers:
 *   routes/api.cta.js                 mint / dry_run response + email_template,
 *                                     and POST /api/cta/:id/send (composeSend)
 *   lib/internal_functions/cta.js     create_cta output (S3)
 *
 * ── [[...]] tokens (square brackets, NOT {{...}}) ──────────────────────────
 * Same convention as request_decision (lib/internal_functions/decisions.js):
 * the URLs don't exist until the token is minted, and in a workflow the
 * engine's {{...}} pass has already run by then.
 *
 *   [[cta_url]]              landing page — /c/<token>
 *   [[respond_url:VALUE]]    pre-selected confirm page for one option —
 *                            /c/<token>/VALUE. A VALUE that is not one of the
 *                            link's options THROWS (a config bug that must
 *                            fail the mint loudly, not mail a dead link).
 *   [[options_html]]         styled button block, one per option, each to its
 *                            confirm page (html templates only; '' in text)
 *   [[expires_at]]           expiry in firm time ("Oct 10, 2026 at 9:00 AM EDT")
 *
 * Any other [[...]] is left exactly as written (decisions' convention).
 *
 * SCANNER SAFETY: every emailed link is a GET that never mutates (SafeLinks /
 * Gmail prefetch every GET); the action lives behind the form POST on the
 * /c/ pages (routes/ctaActions.js).
 *
 * dry_run: pass PLACEHOLDER_TOKEN ('<token>') as the token — every URL and the
 * rendered email carry it literally, so the SU sees the exact shape before a
 * row exists.
 */

'use strict';

const PLACEHOLDER_TOKEN = '<token>';

// Read per call so live edits of landing_hosts / app_url apply without a
// redeploy. Recipient-facing /c/ links live on the PUBLIC landing host
// (routes/pageLanding.js — C_ROUTE_RE et al.), same as /d/ and /t/.
const PUBLIC_URL = () => require('./firmConfig').publicUrl();

const INDIGO = '#312e81';

const RESPOND_URL_RE = /\[\[respond_url:([^\]]*)\]\]/g;

/** Deliberately duplicated (self-contained convention — see taskService). */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A Date or ISO string → "MMM d, yyyy 'at' h:mm a ZZZZ" in firm time. */
function fmtFirmTime(dt) {
  const { DateTime } = require('luxon');
  const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';
  const d = dt instanceof Date
    ? DateTime.fromJSDate(dt, { zone: 'utc' })
    : DateTime.fromISO(String(dt), { zone: 'utc' });
  return d.isValid ? d.setZone(FIRM_TZ).toFormat("MMM d, yyyy 'at' h:mm a ZZZZ") : '';
}

/** Landing URL for a token. */
function ctaUrl(token) {
  return `${PUBLIC_URL()}/c/${token}`;
}

/** { cta_url, urls: { <value>: confirm-page url } } — insertion order follows options. */
function ctaUrls(token, options) {
  const base = ctaUrl(token);
  const urls = {};
  for (const o of options || []) urls[o.value] = `${base}/${o.value}`;
  return { cta_url: base, urls };
}

/** Styled per-option button block (decisions' visual family). Each button GETs its confirm page. */
function optionButtonsHtml(options, token) {
  const base = ctaUrl(token);
  return (options || []).map((o) =>
    `<a href="${htmlEscape(`${base}/${o.value}`)}"
        style="display:inline-block;background:${INDIGO};color:#ffffff;text-decoration:none;
               border-radius:6px;padding:12px 24px;font-size:15px;font-weight:700;
               margin:0 10px 10px 0">${htmlEscape(o.label)}</a>`
  ).join('');
}

/**
 * Resolve the four CTA tokens in an author template.
 *   html: true  → URLs are attribute-escaped and [[options_html]] renders.
 *   html: false → raw URLs (SMS / plain text); [[options_html]] renders ''.
 * Throws Error on an unknown [[respond_url:X]] — callers map it to a 400.
 */
function resolveCtaTokens(tpl, { token, options, expiresAt, html = false }) {
  const opts = options || [];
  const values = new Set(opts.map((o) => o.value));
  const base = ctaUrl(token);
  const url = (u) => (html ? htmlEscape(u) : u);
  let out = String(tpl);
  // Validate EVERY respond_url first, so a bad token fails even if a later
  // replace would have consumed the text around it.
  RESPOND_URL_RE.lastIndex = 0;
  let m;
  while ((m = RESPOND_URL_RE.exec(out)) !== null) {
    if (!values.has(m[1])) {
      throw new Error(`template references unknown option value "${m[1]}" in [[respond_url:${m[1]}]]` +
        ` (options: ${[...values].join(', ') || 'none'})`);
    }
  }
  out = out.replace(RESPOND_URL_RE, (_, v) => url(`${base}/${v}`));
  out = out.replace(/\[\[cta_url\]\]/g, url(base));
  out = out.replace(/\[\[expires_at\]\]/g, html ? htmlEscape(fmtFirmTime(expiresAt)) : fmtFirmTime(expiresAt));
  out = out.replace(/\[\[options_html\]\]/g, html ? optionButtonsHtml(opts, token) : '');
  return out;
}

/**
 * The default CTA email — decisions' visual family (indigo header card).
 * `prompt` is escaped text (the same contract as the /c/ pages); context_html
 * is NOT included — like the default decision email, it lives on the page.
 */
function defaultCtaEmailHtml({ prompt, options, token, expiresAt, protection = 'none', timeoutOption = null }) {
  const base = ctaUrl(token);
  const promptHtml = htmlEscape(prompt).replace(/\r?\n/g, '<br>');
  const pwNote = protection === 'password'
    ? `<p style="margin:10px 0 0;font-size:13px;color:#6b7280">
            You'll need the password you were given to confirm.
          </p>`
    : '';
  const timeoutNote = timeoutOption
    ? ' If there is no response by then, a default action runs automatically.'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:94%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${INDIGO};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">YisraCase — Action Requested</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          <p style="margin:0 0 18px;font-size:17px;font-weight:600;color:#111827;line-height:1.5">${promptHtml}</p>
          <div style="margin:0 0 8px">${optionButtonsHtml(options, token)}</div>
          <p style="margin:14px 0 0;font-size:13px;color:#6b7280">
            Clicking a button opens a confirmation page — nothing happens until you confirm there.
            You can also <a href="${htmlEscape(base)}" style="color:#4f46e5">review all options</a> first.
          </p>${pwNote}
          <p style="margin:10px 0 0;font-size:13px;color:#9ca3af">
            This link expires ${htmlEscape(fmtFirmTime(expiresAt))}.${timeoutNote}
          </p>
        </td>
      </tr>
      <tr>
        <td style="background:#f8f7ff;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">Sent from YisraCase.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Everything a mint surface hands back about where the link lives:
 *   { cta_url, urls, options_html, email_html }
 * email_html is the resolved `emailTemplate` when given (html mode), else the
 * default email. Throws on an unknown [[respond_url:X]] in the template.
 */
function linkBundle({ token, options, expiresAt, prompt, protection, timeoutOption, emailTemplate = null }) {
  const { cta_url, urls } = ctaUrls(token, options);
  const email_html = emailTemplate != null
    ? resolveCtaTokens(emailTemplate, { token, options, expiresAt, html: true })
    : defaultCtaEmailHtml({ prompt, options, token, expiresAt, protection, timeoutOption });
  return { cta_url, urls, options_html: optionButtonsHtml(options, token), email_html };
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Default email subject — request_decision's shape, "Action requested: …" in place of "Decision needed: …". */
function defaultSubject(prompt) {
  return `Action requested: ${oneLine(prompt).slice(0, 80)}`;
}

/**
 * SMS body ceiling: RingCentral's documented limit (ringcentralService throws
 * "Text too long" past it; Quo allows 1600). Checked on a custom text after
 * the tokens resolve — the default text is ≤240 + the link, always under.
 */
const SMS_MAX_CHARS = 1000;

/** Default SMS — request_decision's shape: the prompt on one line, then the landing link. */
function defaultSmsText(prompt, token) {
  return `${oneLine(prompt).slice(0, 240)}\nRespond: ${ctaUrl(token)}`;
}

/**
 * Plain-text rendering of a link: prompt, one "Label: URL" line per option,
 * the landing page, the expiry. The text/plain part of the DEFAULT email and
 * the body recorded in the send's log row.
 */
function plainSummary({ prompt, options, token, expiresAt }) {
  const base = ctaUrl(token);
  const lines = [String(prompt == null ? '' : prompt).trim(), ''];
  for (const o of options || []) lines.push(`${o.label}: ${base}/${o.value}`);
  lines.push('', `All options: ${base}`);
  const exp = fmtFirmTime(expiresAt);
  if (exp) lines.push(`This link expires ${exp}.`);
  return lines.join('\n');
}

/**
 * Compose what POST /api/cta/:id/send puts on the wire (send slice,
 * 2026-10-08; editable SMS text 2026-10-08 r2). Pure — no I/O. Throws on an
 * unknown [[respond_url:X]] in the subject, template or SMS text
 * (resolveCtaTokens), exactly like a mint.
 *
 *   sms   → { text, template }
 *           default   prompt (one line, ≤240) + "Respond: <landing>" —
 *                     request_decision's default SMS shape
 *           smsText   the caller's text (tokens resolved like a subject;
 *                     never stored). It must still carry the link — the
 *                     landing URL or an option URL, typed or as a token —
 *                     and fit SMS_MAX_CHARS once resolved; either miss throws.
 *   email → { subject, html, text, summary, template }
 *           subject   caller's (tokens resolved, collapsed to one line) or
 *                     defaultSubject(prompt)
 *           html      the caller's emailTemplate (tokens resolved; never
 *                     stored) or the default CTA email
 *           text      plainSummary for the DEFAULT email; null for a custom
 *                     template (emailService derives it from the html, so the
 *                     two parts agree)
 *           summary   plainSummary always — the log row's body
 *           template  'default' | 'custom'
 *
 * Never carries a CTA password: only its bcrypt hash exists server-side.
 */
function composeSend({ channel, token, prompt, options, expiresAt, protection = 'none', timeoutOption = null,
  subject = null, emailTemplate = null, smsText = null }) {
  if (channel === 'sms') {
    if (smsText == null || String(smsText).trim() === '') {
      return { text: defaultSmsText(prompt, token), template: 'default' };
    }
    const text = resolveCtaTokens(String(smsText).replace(/\r\n?/g, '\n'), { token, options, expiresAt, html: false }).trim();
    if (!text.includes(ctaUrl(token))) {
      throw new Error('the SMS must carry the link — keep [[cta_url]] or a [[respond_url:VALUE]] in it');
    }
    if (text.length > SMS_MAX_CHARS) {
      throw new Error(`the SMS is ${text.length} characters with the link filled in — the limit is ${SMS_MAX_CHARS}`);
    }
    return { text, template: 'custom' };
  }
  const subj = subject != null && String(subject).trim() !== ''
    ? oneLine(resolveCtaTokens(String(subject), { token, options, expiresAt, html: false }))
    : defaultSubject(prompt);
  const custom = emailTemplate != null && String(emailTemplate).trim() !== '';
  const html = custom
    ? resolveCtaTokens(emailTemplate, { token, options, expiresAt, html: true })
    : defaultCtaEmailHtml({ prompt, options, token, expiresAt, protection, timeoutOption });
  const summary = plainSummary({ prompt, options, token, expiresAt });
  return { subject: subj, html, text: custom ? null : summary, summary, template: custom ? 'custom' : 'default' };
}

module.exports = {
  PLACEHOLDER_TOKEN,
  ctaUrl,
  ctaUrls,
  optionButtonsHtml,
  resolveCtaTokens,
  defaultCtaEmailHtml,
  linkBundle,
  fmtFirmTime,
  composeSend,
  defaultSubject,
  defaultSmsText,
  plainSummary,
  SMS_MAX_CHARS,
};
