// lib/complianceFooter.js
//
/**
 * The marketing-email compliance footer — ONE builder (YisraMail P3,
 * ref/YISRAMAIL_DESIGN.md §4.5; Appendix C for the rules behind each line).
 *
 * A BLOCK, not a resolver placeholder: campaign email bodies resolve with
 * escape:'html' (campaignService.bodyEscapeFor — every substituted value is
 * escaped), so a {{firm.compliance_footer}} placeholder would arrive as
 * visible markup. C2 calls buildComplianceFooter() and injects the html
 * before </body> (appended when there is none — never after </html>) and the
 * text part at the end of the text body. The scalar values stay resolver
 * placeholders ({{firm.postal_address}}, {{send.unsubscribe_url}} …) for a
 * template that wants to place them itself; firmValues() below is where the
 * resolver's `firm` pseudo-table gets them, so the two never disagree.
 *
 * Contents, in order:
 *   1. the ad label — CAN-SPAM 15 USC 7704(a)(5) — when the topic's consent is
 *      NOT affirmative (comm_topics.consent_model 'opt_out'); omitted for an
 *      'opt_in' topic. The builder decides, never the template;
 *   2. why they got it + the unsubscribe URL (an <a href> AND visible text)
 *      + "Manage preferences" (whose menu includes "stop all marketing email");
 *   3. firm name, postal address (CAN-SPAM (a)(5)(A)(iii)), phone;
 *   4. "Responsible attorney: …" (MRPC 7.2(d));
 *   5. the 11 U.S.C. §528 debt-relief-agency statement.
 * FAIL CLOSED: a missing firm name, postal address or attorney name, or a
 * non-http(s) unsubscribe URL, THROWS — C2's post-render assert relies on
 * it: a footer with holes never renders. Pure over firmConfig reads; no DB.
 */

'use strict';

const DEFAULTS = Object.freeze({
  // 11 U.S.C. §528(a)(4), (b)(2)(B) — the statutory wording ("or a
  // substantially similar statement"). The firm's attorney confirms it (P0).
  debt_relief_statement: 'We are a debt relief agency. We help people file for bankruptcy relief under the Bankruptcy Code.',
  ad_label: 'Advertisement',
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** 10 digits → (248) 555-0100; anything else as stored. */
function formatPhone(v) {
  const s = text(v);
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : s;
}

/** firm_address (json_array of lines) → the non-empty lines. A bare string is one line. */
function addressLines(raw) {
  if (Array.isArray(raw)) return raw.map(text).filter(Boolean);
  const s = text(raw);
  return s ? [s] : [];
}

/**
 * The firm's footer values, read now (firmConfig is cached in memory — no
 * query). Unset → null, except the two keys with a code default. The
 * resolver's `firm` pseudo-table serves exactly these.
 * → { name, postal_address, phone, attorney_name, debt_relief_statement, ad_label }
 */
function firmValues() {
  const { cfg, cfgJson } = require('./firmConfig');
  const lines = addressLines(cfgJson('firm_address', null));
  return {
    name: text(cfg('firm_name')),
    postal_address: lines.length ? lines.join(', ') : null,
    phone: text(cfg('fe-firm_phone')),
    attorney_name: text(cfg('firm_attorney_name')),
    debt_relief_statement: text(cfg('marketing_debt_relief_statement')) || DEFAULTS.debt_relief_statement,
    ad_label: text(cfg('marketing_ad_label')) || DEFAULTS.ad_label,
  };
}

function httpUrl(u, what) {
  const s = text(u);
  if (!s || !/^https?:\/\/[^\s"'<>]+$/i.test(s)) throw new Error(`complianceFooter: ${what} must be an http(s) URL`);
  return s;
}

/**
 * → { html, text } — the footer block. Throws on a hole (see the header).
 *   unsubscribeUrl   the token's /u/ URL (unsubService.urlFor)
 *   preferencesUrl   the same page's #prefs (unsubService.preferencesUrlFor)
 *   topic            { topic_key, label, consent_model } of the send
 */
function buildComplianceFooter({ unsubscribeUrl, preferencesUrl, topic } = {}) {
  const unsub = httpUrl(unsubscribeUrl, 'unsubscribeUrl');
  const prefs = httpUrl(preferencesUrl, 'preferencesUrl');
  if (!topic || typeof topic !== 'object') throw new Error('complianceFooter: topic is required');
  const model = topic.consent_model;
  if (model !== 'opt_out' && model !== 'opt_in') throw new Error(`complianceFooter: topic consent_model must be opt_out or opt_in, not "${model}"`);
  const label = text(topic.label) || text(topic.topic_key);
  if (!label) throw new Error('complianceFooter: topic label is required');

  const f = firmValues();
  if (!f.name) throw new Error('complianceFooter: firm_name is not set — a marketing footer never renders without the sender');
  if (!f.postal_address) throw new Error('complianceFooter: firm_address is not set — CAN-SPAM requires a postal address');
  if (!f.attorney_name) throw new Error('complianceFooter: firm_attorney_name is not set — MRPC 7.2(d) requires a responsible attorney');
  const phone = formatPhone(f.phone);

  const why = `You're receiving this ${label} email from ${f.name}.`;
  const firmLine = [f.name, f.postal_address, phone].filter(Boolean).join(' · ');
  const attorney = `Responsible attorney: ${f.attorney_name}`;
  const ad = model === 'opt_out' ? f.ad_label : null;

  const P = 'margin:0 0 6px;font-size:12px;line-height:1.5;color:#6b7280;font-family:Arial,Helvetica,sans-serif';
  const A = 'color:#4b5563;text-decoration:underline';
  const html = [
    '<div data-yc-compliance-footer="1" style="margin:24px 0 0;padding:16px 0 0;border-top:1px solid #e5e7eb">',
    ...(ad ? [`<p style="${P};font-weight:700;text-transform:uppercase;letter-spacing:1px">${esc(ad)}</p>`] : []),
    `<p style="${P}">${esc(why)} Unsubscribe: <a href="${esc(unsub)}" style="${A}">${esc(unsub)}</a>`
      + ` · <a href="${esc(prefs)}" style="${A}">Manage preferences</a></p>`,
    `<p style="${P}">${esc(firmLine)}</p>`,
    `<p style="${P}">${esc(attorney)}</p>`,
    `<p style="${P}">${esc(f.debt_relief_statement)}</p>`,
    '</div>',
  ].join('\n');
  const textPart = [
    '--',
    ...(ad ? [ad] : []),
    why,
    `Unsubscribe: ${unsub}`,
    `Manage preferences: ${prefs}`,
    firmLine,
    attorney,
    f.debt_relief_statement,
  ].join('\n');
  return { html, text: textPart };
}

module.exports = { buildComplianceFooter, firmValues, formatPhone, addressLines, DEFAULTS };
