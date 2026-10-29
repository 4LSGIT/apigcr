// routes/unsubActions.js
//
/**
 * Email unsubscribe — public, no auth, sessionless (YisraMail P3,
 * ref/YISRAMAIL_DESIGN.md §4.5). Substrate: services/unsubService.js (every
 * rule about WHAT a request records lives there; this file is the surface).
 *
 *   GET  /u/:token         the page: "Unsubscribe from <topic>", then
 *                          "Manage preferences" (#prefs) — one checkbox per
 *                          active email topic, "Stop all marketing email",
 *                          "Anything else?" + Save. GET NEVER MUTATES (link
 *                          scanners prefetch every GET in an email).
 *   POST /u/:token         RFC 8058 one-click (mail clients' own Unsubscribe):
 *                          ANY content type, body ignored (server.js parses
 *                          multipart only under /hooks — a multipart POST here
 *                          reaches the handler unparsed), opt_out of the
 *                          token's topic, 200 EMPTY, no auth, NEVER a
 *                          redirect. Unknown token → 200 empty (no oracle).
 *   POST /u/:token/prefs   the page's form (urlencoded): action =
 *                          unsubscribe | all | prefs (the submit button's
 *                          name/value), t_<topic_key> per ticked topic, note.
 *                          Re-renders the page with a confirmation line; a
 *                          bad action / topic → 422 page (escaped, generic).
 *
 * D18: the page offers MARKETING scopes only. No control here can stop case
 * or appointment mail — it says so on the page.
 *
 * Headers on EVERY /u/ response (429s and errors included): Cache-Control
 * no-store, X-Robots-Tag noindex/nofollow (a bearer token in the path),
 * Referrer-Policy no-referrer (the page links out to the firm site; the
 * token must not ride a Referer). routes/pageLanding.js serves /u/ on the
 * landing host (U_ROUTE_RE / U_PREFS_RE, all three enumerations).
 *
 * LIMITERS (per IP, per instance — lib/rateLimiter):
 *   reads 30/min   GET /u/:token (HEAD rides it)
 *   prefs 10/min   POST /u/:token/prefs
 *   one-click      NONE, deliberately: those POSTs come from a handful of
 *                  mail-provider IPs, and a 429 would silently drop someone's
 *                  unsubscribe. The call is idempotent on state and
 *                  token-bound instead. tests/unsubActions.routes.test.js
 *                  fails if a limiter is ever wired here.
 *
 * No oracle: an unknown or malformed token renders the SAME neutral page
 * (200) a valid one does, minus the controls — "this link isn't valid,
 * contact us" with the firm's address and phone. Everything from the DB
 * (topic labels / descriptions are staff-authored) is HTML-escaped.
 *
 * Self-contained (the taskActions / ctaActions convention): its own escaper
 * and page shell — the two public surfaces stay independent.
 */

'use strict';

const express = require('express');
const router = express.Router();
const unsub = require('../services/unsubService');
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');

const readLimited = makeLimiter(60 * 1000, 30);    // GET /u/:token
const prefsLimited = makeLimiter(60 * 1000, 10);   // POST /u/:token/prefs

const TOKEN_PATTERN = ':token([A-Za-z0-9_\\-]{10,40})';
const TOPIC_FIELD = 't_';

const INDIGO = '#312e81';
const GREEN = '#065f46';
const RED = '#991b1b';
const GREY = '#6b7280';

/** Deliberately duplicated (self-contained convention — see taskActions.js). */
function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every /u/ response, before anything else. */
function baseHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
}

/** The firm's contact block (never throws — the page renders what is set). */
function firmInfo() {
  try {
    const { firmValues, formatPhone } = require('../lib/complianceFooter');
    const f = firmValues();
    return { name: f.name, address: f.postal_address, phone: formatPhone(f.phone) };
  } catch (err) {
    console.error('[unsub] firm values unavailable:', err.message);
    return { name: null, address: null, phone: null };
  }
}

/** "j****@example.com" — enough to recognise, not a full address to whoever holds a forwarded link. */
function maskAddress(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at < 1) return s;
  return `${s[0]}${'*'.repeat(Math.max(1, Math.min(at - 1, 6)))}${s.slice(at)}`;
}

function firmBlock(f) {
  const lines = [f.name, f.address, f.phone].filter(Boolean).map(htmlEscape);
  if (!lines.length) return '';
  return `
      <p style="margin:18px 0 0;font-size:12px;color:${GREY};line-height:1.6">${lines.join('<br>')}</p>`;
}

/** Page shell — the action-page family (indigo header card), no app stylesheet. */
function pageWrap(title, bodyHtml, f) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${htmlEscape(title)}</title>
<style>
.u-topic{display:flex;align-items:flex-start;gap:10px;margin:0 0 8px;padding:10px 12px;border:1px solid #c7d2fe;
  border-radius:6px;background:#fff;font-size:15px;line-height:1.4;color:#111827;cursor:pointer}
.u-topic input{flex:none;width:18px;height:18px;margin:1px 0 0;accent-color:${INDIGO}}
.u-topic small{display:block;font-size:12px;color:${GREY}}
.u-btn{border:none;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:700;cursor:pointer;margin:0 10px 10px 0}
.u-note{display:block;width:100%;max-width:520px;box-sizing:border-box;min-height:88px;padding:10px 12px;font-size:15px;
  font-family:inherit;border:1px solid #c7d2fe;border-radius:6px;resize:vertical}
</style>
</head>
<body style="margin:0;padding:0;background:#f0f4ff;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:94%;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${INDIGO};padding:22px 32px 18px">
          <span style="color:#c7d2fe;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase">${htmlEscape(f.name || 'Email preferences')}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">
          ${bodyHtml}
          ${firmBlock(f)}
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Unknown / malformed token — the valid page's shape minus every control (no oracle). */
function neutralPage() {
  const f = firmInfo();
  return pageWrap('Email preferences', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Email preferences</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6">
        This link isn't valid. To stop our emails, reply to one of them or contact us — the details are below.
      </p>`, f);
}

function errorPage() {
  const f = firmInfo();
  return pageWrap('Email preferences', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Something went wrong</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6">
        Nothing was changed. Please try the link again in a moment, or contact us — the details are below.
      </p>`, f);
}

function invalidPage() {
  const f = firmInfo();
  return pageWrap('Email preferences', `
      <h2 style="margin:0 0 8px;font-size:22px;color:#111827">That request wasn't valid</h2>
      <p style="margin:0;font-size:14px;color:#374151;line-height:1.6">
        Nothing was changed. Go back to the link in your email and try again.
      </p>`, f);
}

function banner(msg, color) {
  if (!msg) return '';
  return `
      <div role="status" style="margin:0 0 18px;padding:12px 16px;background:#ecfdf5;border:1px solid #a7f3d0;
                  border-radius:4px;font-size:14px;color:${color};font-weight:600">${htmlEscape(msg)}</div>`;
}

/** The page for a known token. `notice` = the confirmation line after a POST. */
function preferencesPage(info, { notice = null } = {}) {
  const f = firmInfo();
  const base = `/u/${info.token}`;   // relative: follows the serving host
  const allOut = info.states.marketing === 'opted_out';

  const top = info.topic_receives && !allOut
    ? `
      <form method="POST" action="${base}/prefs" style="margin:0 0 6px">
        <input type="hidden" name="action" value="unsubscribe">
        <button type="submit" class="u-btn" style="background:${INDIGO};color:#fff">Unsubscribe from ${htmlEscape(info.topic_label)}</button>
      </form>`
    : `
      <p style="margin:0 0 6px;font-size:15px;color:${GREEN};font-weight:600">
        You're unsubscribed from ${htmlEscape(allOut ? 'all our marketing email' : info.topic_label)}.
      </p>`;

  const boxes = info.topics.map((t) => {
    const id = `u-t-${t.topic_key}`;
    const checked = info.receives[t.topic_key] ? ' checked' : '';
    const desc = t.description ? `<small>${htmlEscape(t.description)}</small>` : '';
    return `
          <label class="u-topic" for="${htmlEscape(id)}"><input type="checkbox" id="${htmlEscape(id)}" name="${htmlEscape(TOPIC_FIELD + t.topic_key)}" value="1"${checked}><span>${htmlEscape(t.label)}${desc}</span></label>`;
  }).join('');

  const stopAll = allOut
    ? ''
    : `
          <button type="submit" name="action" value="all" class="u-btn" style="background:#fff;color:${RED};border:1px solid #fecaca">Stop all marketing email</button>`;

  return pageWrap('Email preferences', `
      <h2 style="margin:0 0 6px;font-size:22px;color:#111827">Email preferences</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#374151">For ${htmlEscape(maskAddress(info.destination))}</p>
      ${banner(notice, GREEN)}${top}
      <h3 id="prefs" style="margin:26px 0 10px;font-size:17px;color:#111827">Manage preferences</h3>
      ${allOut ? `<p style="margin:0 0 12px;font-size:14px;color:#374151">You get none of our marketing email. Tick a topic and save to start receiving it again.</p>` : ''}
      <form method="POST" action="${base}/prefs" data-u-prefs="1">
        ${boxes || '<p style="margin:0 0 12px;font-size:14px;color:#374151">There are no email topics to choose from right now.</p>'}
        <label for="u-note" style="display:block;margin:16px 0 6px;font-size:13px;font-weight:600;color:#374151">Anything else?</label>
        <textarea id="u-note" name="note" class="u-note" maxlength="1000" placeholder="Optional — a person at our office reads this."></textarea>
        <div style="margin:16px 0 0">
          <button type="submit" name="action" value="prefs" class="u-btn" style="background:${INDIGO};color:#fff">Save</button>${stopAll}
        </div>
      </form>
      <p style="margin:14px 0 0;font-size:13px;color:${GREY};line-height:1.5">
        These choices cover marketing email only. Email about your case or your appointments is not affected.
      </p>`, f);
}

/** What a POST changed → the confirmation line. */
function noticeFor(out, info) {
  const c = out.changed || [];
  const parts = [];
  if (c.some((x) => x.scope === 'marketing' && x.action === 'opt_out')) parts.push("You're unsubscribed from all our marketing email.");
  else if (c.some((x) => x.action === 'opt_out' && x.scope === info.topic_key) && c.length === 1) parts.push(`You're unsubscribed from ${info.topic_label}.`);
  else if (c.length) parts.push('Your preferences are saved.');
  else parts.push('Nothing needed changing — your preferences are as shown.');
  if (out.note_received) parts.push('Thank you — your note was passed to our office.');
  return parts.join(' ');
}

/** The form's ticked topics → { key: 'in' } (unticked boxes are not submitted at all). */
function tickedTopics(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (k.startsWith(TOPIC_FIELD)) out[k.slice(TOPIC_FIELD.length)] = 'in';
  }
  return out;
}

function tooMany(res) {
  return res.status(429).type('text/plain').send('Too many requests');
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /u/:token — the page (zero mutation)
// ─────────────────────────────────────────────────────────────────────────────

router.get(`/u/${TOKEN_PATTERN}`, async (req, res) => {
  baseHeaders(res);
  if (readLimited(getClientIp(req))) return tooMany(res);
  try {
    const info = await unsub.lookupToken(req.db, req.params.token);
    if (!info) return res.status(200).send(neutralPage());
    return res.status(200).send(preferencesPage(info));
  } catch (err) {
    console.error('GET /u/:token error:', err.message);
    return res.status(500).send(errorPage());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /u/:token — RFC 8058 one-click. No limiter, no parser, no redirect.
// ─────────────────────────────────────────────────────────────────────────────

router.post(`/u/${TOKEN_PATTERN}`, async (req, res) => {
  baseHeaders(res);
  try {
    await unsub.oneClick(req.db, req.params.token, {
      ip: getClientIp(req), userAgent: req.headers['user-agent'] || null,
    });
    return res.status(200).end();
  } catch (err) {
    // Not recorded → not "done": a 5xx, never a 200 that drops the unsubscribe.
    console.error('POST /u/:token (one-click) error:', err.message);
    return res.status(500).end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /u/:token/prefs — the page's form
// ─────────────────────────────────────────────────────────────────────────────

router.post(`/u/${TOKEN_PATTERN}/prefs`, async (req, res) => {
  baseHeaders(res);
  if (prefsLimited(getClientIp(req))) return tooMany(res);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = typeof body.action === 'string' ? body.action : '';
  const note = typeof body.note === 'string' ? body.note : null;
  try {
    const out = await unsub.applyPage(req.db, req.params.token, {
      action,
      topics: action === 'prefs' ? tickedTopics(body) : null,
      note,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
    });
    if (!out.ok) return res.status(200).send(neutralPage());
    const info = await unsub.lookupToken(req.db, req.params.token);
    if (!info) return res.status(200).send(neutralPage());
    return res.status(200).send(preferencesPage(info, {
      notice: noticeFor({ ...out, note_received: !!(note && note.trim()) }, info),
    }));
  } catch (err) {
    if (err && err.status === 422) return res.status(422).send(invalidPage());
    console.error('POST /u/:token/prefs error:', err.message);
    return res.status(500).send(errorPage());
  }
});

module.exports = router;
