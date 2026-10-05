// lib/token.js
//
/**
 * generateToken — mint a bearer token: 22 chars of base62 (0-9 A-Z a-z).
 *
 * The shared mint for every long-lived capability token the app embeds in a
 * URL and later looks up by equality: appts.appt_manage_token (/m/<t>),
 * contacts.contact_token (?c= / ?ct=), tasks.task_action_token (/t/<t>),
 * decision_requests.token (/d/<t>), users.reset_token (?token=).
 *
 * Why base62, not hex or base64url (2026-10-05, replacing per-site mints):
 *   - hex spends 32 chars on 128 bits; base62 gets ~131 bits in 22.
 *   - base64url's '-' and '_' have bitten this repo before: '_' italicizes
 *     in Markdown-ish renderers, '-' breaks double-click selection and
 *     split-on-'-' consumers (see esignService.js SUFFIX rationale and the
 *     legacy case_id containing '-'). Pure alphanumeric survives every
 *     linkifier, SMS client, and copy-paste intact.
 *   - 22 chars also matches the existing tasks/decisions token width, so
 *     char(22) columns need no widening.
 *
 * Collation: base62 is case-SENSITIVE, so the five token columns are
 * utf8mb4_bin (ref/migrations/2026-10-05_token_base62_bin.sql — same
 * precedent as documents.external_id). Under the old utf8mb4_general_ci a
 * mixed-case alphabet never bought the entropy it appeared to: the DB
 * collapsed case (see lib/caseId.js, which hit exactly this). Legacy hex and
 * base64url tokens keep matching under _bin — a link carries the minted
 * string verbatim, so exact-match lookups are unaffected.
 *
 * Uniformity: crypto.randomInt does rejection sampling internally, so each
 * char is exactly uniform over the 62 symbols — no `% 62` modulo bias.
 *
 * All-digit rejection mirrors lib/caseId.js: some consumers discriminate
 * token-vs-numeric-id by "does it contain a letter" (videoLanding's legacy
 * ?c= branch, the log_link isNaN branches). At (10/62)^22 ≈ 3e-18 this never
 * fires in practice; the do/while just makes the invariant a guarantee
 * instead of a probability.
 *
 * PUBLIC_TOKEN_RE accepts every format this app has ever minted into those
 * columns — legacy 32-hex, legacy 22-base64url, new 22-base62 — and is the
 * format gate for routes that look tokens up. (Legacy 64-hex reset tokens
 * exceed its 40-char cap; the reset lookup deliberately has no format gate —
 * see tests/token.test.js.) It is deliberately the same character class and
 * span as the /t/ and /d/ route patterns in routes/pageLanding.js,
 * routes/taskActions.js and routes/decisionActions.js, which keep their own
 * inline copies (Express route-pattern strings; self-contained convention),
 * as does public/manage.html (client-side). Keep them in sync.
 */

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // base62

const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{10,40}$/;

function generateToken(len = 22) {
  let token;
  do {
    token = Array.from({ length: len }, () => ALPHABET[crypto.randomInt(62)]).join('');
  } while (/^\d+$/.test(token));
  return token;
}

module.exports = { generateToken, PUBLIC_TOKEN_RE };
